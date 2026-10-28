---
name: client-upgrade-flow
description: 窗口连守护进程时先查过旧：空着就让它让位并换新，忙就等、每 30 秒再查，旧窗口报重开；产出提示与给模型的错误
---
# 窗口端：换新、等待与旧窗口

## 目标
窗口的守护进程客户端在每次连接（首连和重连）时按过旧与忙的情况走对路径，把要提示用户的事件交给宿主，并在需求功能用不了时给模型写明原因和建议的错误。

## 业务规则（来源：PRD replace-when-idle、wait-then-replace、stale-window）
连上 socket 后、发 `hello` 之前，先发 `upgrade.check`（计划 02 定义），按结果分支：
1. 请求失败（老守护进程不认识它、或守护进程报错）→ 按现在的流程直接 `hello`，表现和现在一样。
2. 不过旧 → `hello`。协议版本号不同时，说明是这个窗口自己旧：停止重连，进入「旧窗口」状态（⑤）。
3. 过旧且不忙 → 发 `upgrade.yield`。接受后，等这条连接被对方断开（最多 10 秒），再走现有的连接流程（socket 不在就拉起新守护进程）并 `hello`，成功后发「已换新」提示（①）。被拒（期间变忙了）→ 按第 4 条处理。
4. 过旧且在忙：
   - 协议版本号相同 → `hello` 照常连上，需求功能可用；发「在等，先照常用」提示（②）；开始等待。
   - 协议版本号不同 → 不 `hello`，关掉这条连接；需求功能不可用；发「在等，暂时用不了」提示（③）；开始等待。
- 等待：每 30 秒（不算电脑睡眠的时间）查一次。已连着就在当前连接上发 `upgrade.check`；没连着就重新连接并从头走上面的分支。查到过旧且不忙就让位并换新，成功后发「等到后换上」提示（④）。等待中旧守护进程自己没了，下一次查时 socket 不在，直接拉起新的，同样发 ④。
- 一次等待只发一次等待提示（② 或 ③），换上时发一次 ④；不重复提示。
- 只连现有守护进程的客户端（`connectOnly`）不查过旧、不让位，行为和现在一样。
- ③ 和 ⑤ 是独立状态，不走现有的退避重连（`scheduleReconnect`，200 毫秒到 5 秒）：③ 只靠 30 秒定时器重查，⑤ 不再发起任何连接。其他连接失败照旧走退避重连。
- 提示文字（`<名>` 是项目目录名，`<原因>` 只列实际存在的项、顺序固定、项之间用中文逗号）：
  - ①（普通消息）`<名> 的后台进程跑的是旧代码，已停掉并换成当前安装的版本。`
  - ②（提醒）`<名> 的后台进程跑的是旧代码，还在忙：<在忙原因>。现在先照常用它，空下来后 30 秒内会自动换成新代码。`
  - ③（提醒）`<名> 的后台进程是旧版本，和这个窗口不兼容，需求和代理功能暂时用不了，普通对话不受影响。正在等：<等待原因>。空下来后 30 秒内会自动换成新版本。`
  - ④（普通消息）`<名> 的后台进程已换成新版本，需求和代理功能可以用了。`
  - ⑤（错误）`这个窗口是旧版本，和<名> 已更新的后台进程不兼容，需求和代理功能用不了。请关掉这个窗口，运行 pi -c 重新打开，接着原来的对话。`
  - 在忙原因：`需求「A」「B」在运行`、`另有 N 个窗口连着`、`本窗口有原型设计或检索在跑`
  - 等待原因：`需求「A」「B」运行结束`、`另外 N 个窗口关闭`、`本窗口的原型设计或检索跑完`
- 需求功能不可用时 `call()` 给模型的错误（经 `failureText` 渲染为"原因 / 建议"）：
  - ③ 状态：原因 `<名> 的后台进程是旧版本，和这个窗口不兼容；正在等<等待原因用顿号连接>后自动换成新版本。`，建议 `告诉用户需求和代理功能要等后台换成新版本后才能用；换好后窗口里会有提示，再重试这一步。`
  - ⑤ 状态：原因 `这个窗口是旧版本，和<名> 已更新的后台进程不兼容。`，建议 `请用户关掉这个窗口，运行 pi -c 重新打开，接着原来的对话。`
- 提示和错误里都用项目目录名，不出现 64 位仓库编号。

## 涉及文件
- `src/core/host/upgrade-notice.ts` 新建
- `src/core/host/daemon-client.ts` 修改
- `tests/upgrade-notice.test.ts` 新建
- `tests/daemon-client.test.ts` 修改，或新建 `tests/daemon-upgrade-client.test.ts`

## 函数清单
### src/core/host/upgrade-notice.ts
| 函数名 | 职责 |
|---|---|
| `UpgradeNotice` | 类型：`kind`（`replaced` / `waiting_usable` / `waiting_blocked` / `replaced_after_wait` / `window_stale`）、`repoName`、在忙三项（需求名字列表、其他窗口数、本窗口会话数） |
| `upgradeNoticeText` | 按上面的文字规则把一条提示转成要显示的文字和级别（`info` / `warning` / `error`） |
| `upgradeAdvice` | 给 `waiting_blocked`、`window_stale` 两种状态生成给模型的原因和建议 |

### src/core/host/daemon-client.ts
| 函数名 | 职责 |
|---|---|
| `ConnectDaemonOptions.onUpgradeNotice` / `WorkspaceClientsOptions.onUpgradeNotice` | 新增可选回调，收到 `UpgradeNotice`；`resolveContext` 带进上下文 |
| `checkUpgradeOn` | 在刚连上、未握手的 socket 上发 `upgrade.check`，失败返回空（走老流程） |
| `startConnectionOperation`（修改） | 按业务规则 1–4 分支，`hello` 前插入检查、让位、等对方断开再连的步骤 |
| `yieldAndReconnect` | 发 `upgrade.yield`，接受后等连接断开（最多 10 秒），再连新守护进程并 `hello` |
| `enterUpgradeWait` | 记下等待状态和原因、只在首次进入时发 ② 或 ③、排下一次 30 秒检查 |
| `pollUpgrade` | 30 秒到点后执行一次检查：已连着在当前连接上查，否则重新走连接流程；换新成功发 ④ 并清掉等待状态 |
| `call`（修改） | ③ 状态和 ⑤ 状态下抛带 `upgradeAdvice` 的 `AdvisedError`（错误码分别为 `daemon_upgrade_pending`、`window_stale`），其余状态不变 |
| `close`（修改） | 清掉 30 秒检查定时器 |

## 协作关系
- 依赖计划 01 的 `repoDisplayName`（由 `commonDir` 得名字）和计划 02 的两个请求。
- 定时用 `ctx.clock.setTimeoutExcludingSleep`，和现有重连一致。
- 换新后走现有 `connected` 生命周期事件，宿主现有的订阅重建逻辑不变。
- `onUpgradeNotice` 由计划 04 的宿主提供，用来弹提示。

## 验证方式
- 测试入口：`upgradeNoticeText`、`upgradeAdvice`；`connectDaemon` / `WorkspaceClients.create`（传入 `onUpgradeNotice` 收集提示、传入假时钟推进 30 秒），对端用 `node:net` 起的假守护进程（按测试需要回答 `upgrade.check` / `upgrade.yield` / `hello`）或真实守护进程。
- 测试输入与预期结果：
  - `upgradeNoticeText` 五种 `kind` 的文字与上面逐字一致；② 在 `requirements: ["A","B"]`、`otherWindows: 2`、`ownSessions: 0` 时原因为 `需求「A」「B」在运行，另有 2 个窗口连着`；只有窗口连着时不出现需求项；`upgradeAdvice` 的 ③ 原因为 `…正在等需求「订单导出」运行结束、另外 1 个窗口关闭后自动换成新版本。`
  - 假守护进程回答过旧且不忙、接受让位并断开连接 → 客户端再连（拿到新的假守护进程）并握手成功；收到 1 条 `replaced`
  - 回答过旧、`otherWindows: 1`、协议版本号相同 → 握手成功、`call` 成功；收到 1 条 `waiting_usable`；推进 30 秒后假守护进程改答不忙并接受让位 → 收到 1 条 `replaced_after_wait`，期间不再有第二条等待提示
  - 回答过旧、在忙、协议版本号不同 → 不发 `hello`；`call` 抛错，`failureText` 渲染出的原因和建议与上面一致、不含 64 位十六进制串；推进 30 秒后变成不忙 → 换新、`call` 成功
  - 回答不过旧、`hello` 报协议版本号不一致 → `call` 抛 ⑤ 的错误；推进 2 分钟没有新的连接尝试；收到 1 条 `window_stale`
  - 守护进程不认识 `upgrade.check` → 直接 `hello`，行为与现在相同
  - `connectOnly` 客户端不发 `upgrade.check`
- [ ] 上述用例全部通过；`tests/daemon-client.test.ts`、`tests/daemon-connection-lifecycle.test.ts` 现有用例不回归
