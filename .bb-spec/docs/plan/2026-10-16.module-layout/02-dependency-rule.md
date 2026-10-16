---
name: dependency-rule
description: 架构测试守住"源文件必须在模块目录里、只能上层引用下层"，并把剩下两处逆向引用整段挪走
---
# 单向依赖规则与架构测试
## 目标
`src/` 下每个源文件都在一个模块目录里，模块之间只能上层引用下层；违反时单元测试失败并写明位置。当前代码通过，不需要例外。

## 业务规则（来源：PRD dependency-rule）
- 模块目录从下层到上层的顺序：`src/core/policy`、`src/core/exec`、`src/core/storage`、`src/core/host`、`src/modules/agents`、`src/modules/requirement`、`src/modules/prototype`、`src/modules/verification`、`src/modules/explore`、`src/modules/settings`、`src/modules/pm`、`src/modules/delivery`、`src/modules/panel`、`src/modules/interaction`、`src/modules/project-index`、`src/modules/shell`、app（`src/app/extension` 和 `src/app/daemon` 同属这一层）。
- 一个文件可以引用同一模块里的文件和排在它下面的模块；引用排在它上面的模块时失败。只引用类型的 import（`import type`、`export type … from`）同样检查。要检查的引用写法：`import … from "…"`、`export … from "…"`、动态 `import("…")`、`new URL("….ts", import.meta.url)`；只看以 `./` 或 `../` 开头的相对路径。
- 引用方向错误时，报错逐条写"<引用方文件>:<行> 引用了上层模块 <模块名>（<被引用的文件>）"，一次列出全部违规。文件路径相对仓库根；模块名用 `core/host`、`pm`、`app` 这种写法。
- `src/` 下有 `.ts`、`.mts`、`.mjs` 文件不在上面任何模块目录里时失败，报错写"<文件> 不在任何模块目录里"。
- 当前代码上通过，测试里没有例外清单。
- 现在还剩两处下层引用上层，要整段挪走，函数体和格式定义的内容不改：
  - `src/core/host/daemon-client.ts` 引用了 `src/app/daemon/lifecycle.ts` 的"探测已有守护进程实例"和"通信文件路径长度上限"两个函数。
  - `src/core/host/protocol.ts` 里按请求种类校验参数的那张表，引用了需求、原型、知识查询三个模块的格式定义。

## 涉及文件
- 新建：`tests/module-dependencies.test.ts`、`src/core/host/daemon-probe.ts`、`src/app/daemon/method-params.ts`
- 修改：`src/app/daemon/lifecycle.ts`、`src/core/host/daemon-client.ts`、`src/core/host/protocol.ts`、`src/app/daemon/server.ts`；引用了被挪函数的测试（只改 import 路径）

## 函数清单
### src/core/host/daemon-probe.ts（新建）
| 函数名 | 职责 |
|---|---|
| `socketPathByteLimit` | 从 `src/app/daemon/lifecycle.ts` 整段挪来，连同它用到的 `SOCKET_PATH_BYTE_LIMIT` |
| `probeExistingInstance` | 从 `src/app/daemon/lifecycle.ts` 整段挪来，连同只有它用到的常量（如 `PROBE_TIMEOUT_MS`）和 `ProbeResult` 类型 |

### src/app/daemon/method-params.ts（新建）
| 函数名 | 职责 |
|---|---|
| `validateParams` | 从 `src/core/host/protocol.ts` 整段挪来，连同 `PARAM_SCHEMAS` 表和它对 `requirement-contracts`、`prototype-dispatch`、`knowledge-query-tool` 的 import |

### src/core/host/protocol.ts（修改）
| 函数名 | 职责 |
|---|---|
| `protocolError`、`assertKnownMethod` 等 | `validateParams` 用到的函数留在这里；原来不导出的加 `export`，函数体不改。删掉挪走后不再用的 import |

### 其他修改
- `src/app/daemon/lifecycle.ts`：删掉挪走的两个函数，改为从 `src/core/host/daemon-probe.ts` 引用；它自己仍用的常量留下。
- `src/core/host/daemon-client.ts`：两个函数改为从 `./daemon-probe.ts` 引用。
- `src/app/daemon/server.ts`：`validateParams` 改为从 `./method-params.ts` 引用。
- 引用这些函数旧位置的测试（例如 `tests/temporary-root.test.ts`、`tests/installation/requirement-manage.test.ts`、`tests/helpers/daemon-harness.ts` 引用 `socketPathByteLimit`，`tests/daemon-protocol.test.ts` 引用 `validateParams`）：只改 import 路径。

## 协作关系
- `daemon-client.ts`（主窗口一侧）和 `lifecycle.ts`（守护进程一侧）都调用 `daemon-probe.ts` 判断通信文件上有没有活着的守护进程。
- 守护进程的 `server.ts` 收到请求后调用 `method-params.ts` 的 `validateParams`；`method-params.ts` 用 `protocol.ts` 的方法清单和报错函数。

## 验证方式
- 测试入口：`pnpm exec vitest run tests/module-dependencies.test.ts`；之后四项纯代码测试。
- 测试输入：仓库的 `src/` 目录；另在单层临时目录 `/tmp/pi-t-XXXXXX` 里搭小样例目录树（同样的 `src/core/…`、`src/modules/…`、`src/app/…` 结构），放进带违规 import 的文件。检查逻辑写在测试文件或 `tests/helpers/` 里，测试同时对真实 `src/` 和样例目录树运行它。
- 预期结果：
  - [ ] 真实 `src/`：没有违规，没有不在模块目录里的文件。
  - [ ] 样例：`src/modules/requirement/a.ts` 写 `import { x } from "../pm/b.ts"` → 报错"src/modules/requirement/a.ts:1 引用了上层模块 pm（src/modules/pm/b.ts）"；改成 `import type { X } from "../pm/b.ts"` 同样报错。
  - [ ] 样例：同时有两处违规时，报错里两处都有。
  - [ ] 样例：`src/modules/pm/c.ts` 引用 `../requirement/…`、同目录文件、`../../core/exec/…` → 不报错；`src/app/daemon/d.ts` 引用任何模块 → 不报错。
  - [ ] 样例：`src/modules/loose.ts`（直接在 modules 下）→ 报错"src/modules/loose.ts 不在任何模块目录里"。
  - [ ] `src/core/` 下所有文件都不引用 `src/modules/` 或 `src/app/`。
  - [ ] 四项纯代码测试全部通过。
