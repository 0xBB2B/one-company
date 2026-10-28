---
name: daemon-upgrade-methods
description: 守护进程记下启动时的代码指纹，新增握手前就能调用的「查过旧」和「让位」两个请求
---
# 守护进程端：查过旧与让位

## 目标
窗口在握手前（协议版本号不同也行）就能问守护进程"你的代码过旧了吗、忙不忙"，并在它过旧且空着时让它自己退出。

## 业务规则（来源：PRD replace-when-idle、wait-then-replace、stale-window）
- 代码过旧：守护进程启动时算下的代码指纹，和此刻重新算出的它自己安装目录的指纹不同。只看守护进程自己，所以和磁盘一致的守护进程不管谁来问都不会让位（旧窗口停不掉新守护进程）。
- 在忙：下面任意一项成立。
  - 有需求运行处在排队、运行中、暂停中、已暂停四种状态之一（与空闲自动退出用的 `ACTIVE_REQUIREMENT_STATES` 相同）；报出每个需求的名字。
  - 有调用方窗口以外的已握手窗口连着（按 `windowId` 区分，调用方自己的连接不算）；报出个数。
  - 调用方自己这条已握手连接派出的原型设计或检索还在跑；报出个数。握手前调用时这一项恒为 0。
- 让位：守护进程收到让位请求后，自己当场重新判断一次；过旧且不忙才接受，接受后走和现有 `shutdown` 相同的关闭流程；不过旧、在忙、还没准备好或读运行记录失败都拒绝，并返回当前状态。已经在关闭中再收到让位请求，直接回答接受。
- 这两个请求专门在两边版本不同时使用：参数和返回字段一经发布就保持不变，以后升协议版本号也不能改它们；调用时必须带控制连接凭证（和 `hello` 相同的 `authToken` 校验），不要求先握手。
- 协议版本号从 6 升到 7（用户 2026-10-28 决定）：现在在跑的 v6 守护进程不认识这两个请求，不升的话新窗口会照常握手、悄悄用着旧代码；升了以后新窗口遇到它时报现有的"后台进程是旧版本"，用户手动重启一次。

## 涉及文件
- `src/core/host/protocol.ts` 修改
- `src/app/daemon/method-params.ts` 修改
- `src/app/daemon/server.ts` 修改
- `src/app/daemon/lifecycle.ts` 修改
- `src/app/daemon/run-manager.ts` 修改
- `tests/helpers/daemon-harness.ts` 修改（`SpawnDaemonOptions`、`StartDaemonOptions` 加可选的 `productRoot`，指定这次从哪个产品目录的 `src/app/daemon/bootstrap.mjs` 启动；不传时和现在一样）
- `tests/daemon-protocol.test.ts`、`tests/daemon-lifecycle.test.ts` 修改，或新建 `tests/daemon-upgrade.test.ts`

## 成品定义
`src/core/host/protocol.ts` 第一行改为：

```ts
export const PROTOCOL_VERSION = 7;
```

`METHODS` 在 `"shutdown",` 之后加两项：

```ts
  "upgrade.check",
  "upgrade.yield",
```

`src/app/daemon/method-params.ts` 的 `PARAM_SCHEMAS` 加两项：

```ts
  "upgrade.check": Type.Object({ authToken: Type.String({ minLength: 1 }), windowId: Type.String() }, { additionalProperties: false }),
  "upgrade.yield": Type.Object({ authToken: Type.String({ minLength: 1 }), windowId: Type.String() }, { additionalProperties: false }),
```

两个请求的返回结果（`upgrade.yield` 多一个 `accepted`）：

```ts
{
  stale: boolean;          // 代码过旧
  protocolVersion: number; // 守护进程的 PROTOCOL_VERSION
  requirements: string[];  // 在跑的需求名字，按需求编号排序、去重
  otherWindows: number;    // 调用方以外的已握手窗口数
  ownSessions: number;     // 调用方这条连接派出、还在跑的原型设计和检索个数
  accepted?: boolean;      // 仅 upgrade.yield：是否接受让位
}
```

## 函数清单
### src/app/daemon/server.ts
| 函数名 | 职责 |
|---|---|
| `DaemonServerOptions.upgrade` | 新增可选回调组：`inspect` 和 `yield`，入参是调用方（`windowId`，以及已握手时这条连接的 `connectionId`），由 lifecycle 提供 |
| `handleRequest`（修改） | `upgrade.check`、`upgrade.yield` 在握手前后都可调用：先校验 `authToken`、再校验参数，然后交给 `options.upgrade`；不改变连接的握手身份；没配置回调时按未知方法报错 |

### src/app/daemon/run-manager.ts
| 函数名 | 职责 |
|---|---|
| `activeRequirementTitles` | 列出处在四种在跑状态的需求运行，按需求编号去重，用已有的 `requirementTitle` 取名字；单个名字取不到时用需求编号代替 |
| `mainSessionCount` | 数出给定 `connectionId` 派出、还没交结果的原型设计（`mainPrototypes` 里未 `submitted`）和检索（`mainExplores` 里还没有 `report`）个数 |

### src/app/daemon/lifecycle.ts
| 函数名 | 职责 |
|---|---|
| `startDaemon`（修改） | 在抢 socket 监听权之前用 `codeFingerprint(installedPackageRoot())` 记下启动指纹；把 `upgrade.inspect` / `upgrade.yield` 回调交给 `DaemonServer` |
| `inspectUpgrade` | 重新算一次指纹与启动指纹比较，加上在忙的三项，组成返回结果；算指纹或读运行记录失败时抛错，错误写明哪一步失败 |
| `yieldUpgrade` | 已在关闭中直接接受；还没 `ready` 时拒绝；否则调 `inspectUpgrade`，过旧且三项全为空才接受，接受后调用现有 `onShutdownRequested` 同一套关闭；任何一步失败都拒绝 |

## 协作关系
- `lifecycle` → `codeFingerprint`、`installedPackageRoot`（计划 01）。
- `inspectUpgrade` → `runManager.activeRequirementTitles()`、`runManager.mainSessionCount()`、`server.clients()`。
- `yieldUpgrade` 接受后复用 `shutdown()`：先关服务端连接、再释放 socket 文件、最后退出进程；窗口端据此等待连接断开再连新的（计划 03）。
- 现有空闲退出、`shutdown` 请求、`hello` 行为不变。

## 验证方式
- 测试入口：用 `tests/helpers/daemon-harness.ts` 启动真实守护进程，用 `connectRawClient` / `authenticateTestClient` 发请求。要让守护进程"过旧"：在 `temporaryRoot()` 下复制一份产品（`package.json` 加 `files` 列出的目录，`node_modules` 用符号链接指回仓库），用 `startDaemonForTest(fixture, { productRoot: <副本目录> })` 从副本启动，再改副本里 `src/` 下一个文件。不要靠设 `ONE_COMPANY_TEST_PRODUCT_ROOT` 环境变量：harness 在模块加载时就读定了它。
- 测试输入与预期结果：
  - 握手前发 `upgrade.check`（带正确 `authToken`、任意 `windowId`），代码没改 → `stale: false`、`protocolVersion: 7`、`requirements: []`、`otherWindows: 0`、`ownSessions: 0`
  - 改了副本 `src/` 下文件后再查 → `stale: true`；只改副本里 `tests/` 下文件 → `stale: false`
  - `authToken` 错误或缺失 → 报错，错误码 `unauthorized`；多带一个参数 → 参数错误
  - 另一个客户端以不同 `windowId` 握手后再查 → `otherWindows: 1`；用同一个 `windowId` 握手的连接自己查 → `otherWindows: 0`
  - 有一条处在 `paused` 的需求运行记录时查 → `requirements` 含该需求名字
  - 过旧且不忙时发 `upgrade.yield` → `accepted: true`，守护进程进程随后退出、socket 文件被删除
  - 不过旧时发 `upgrade.yield` → `accepted: false`，进程仍在
  - 过旧但另有窗口连着时发 `upgrade.yield` → `accepted: false`、`otherWindows: 1`，进程仍在
  - 让位后发 `hello`、`ping` 等现有请求的行为与改动前相同（现有测试全部通过）
- [ ] 上述用例全部通过
- [ ] `pnpm run typecheck` 通过
