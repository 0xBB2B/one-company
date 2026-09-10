---
name: window-lifecycle
description: 窗口会话生命周期：登记与心跳、切换前清理本窗口 Shell 并按确认放行、退出时注销与关闭连接
---
# 窗口生命周期

## 目标
窗口在会话开始时接入守护进程并登记自身，切换或退出时只清理自己的 Shell，绝不影响守护进程内的运行。

## 业务规则（来源：spec）
- run-lifecycle：主会话回合结束、窗口关闭、新建或切换会话都不影响守护进程内的需求代理与角色。
- run-lifecycle / host-lifecycle：窗口新建或切换会话时先停止并确认清理该窗口主会话自己的 Shell，确认后才完成切换；无法确认时阻止切换并说明原因。
- host-lifecycle：窗口正常退出、普通关闭终端及可处理的退出信号（SIGHUP、SIGTERM、SIGINT）清理该窗口主会话的 Shell；守护进程内运行的 Shell 不受影响。
- window-ownership：窗口在本机流程数据登记，工作区内窗口均可见可控本工作区需求代理。
- daemon-host：心跳与失联判定扣除睡眠间隔。

## 涉及文件
- 新建 `extensions/lifecycle.ts`
- 新建 `tests/window-lifecycle.test.ts`

## 函数清单
### extensions/lifecycle.ts
| 函数名 | 职责 |
|---|---|
| `lifecycleExtension` | 默认导出（只收 `pi`，可选第二参注入依赖供测试）：注册 `session_start`、`session_before_switch`、`session_before_fork`（与切换同门槛）、`session_shutdown` 处理器；工厂内不构造任何会起定时器/连接的对象，全部延后到 `startWindow` |
| `startWindow` | 先生成窗口标识 UUID，用它建立 `WorkspaceClients` 连接（hello.windowId）并从其 `workspace()` 取工作区（只发现一次），连接成功后用同一标识在工作区内每个仓库的窗口目录登记记录（连接失败不留记录；登记失败回滚已登记仓库并关闭连接）、启动睡眠感知心跳（心跳错误记入上下文原因）、激活本窗口 Shell 归属；启动失败保存具体原因并 `ctx.ui.notify` 一次，`windowContext()` 抛出该原因 |
| `beforeSwitch` | 停止本窗口主会话全部 Shell 并等待清理确认（总预算 15 秒）；确认则放行；未确认、超时、窗口未启动或任何异常一律取消（fail-closed），并在事件处理器里先 `ctx.ui.notify(reason, "error")` 再返回 `{ cancel: true }` |
| `shutdownWindow` | `shutdownWindow(budgetMs?)`，幂等（第二次调用直接返回）：经 `stopHost` 停止本窗口全部 Shell（含此前判为不确定的；`session_shutdown` 路径不传预算、等待注册表自身判定，退出信号路径传 3 秒）、逐仓库注销窗口记录（单仓失败不中断其它仓库）、停止本会话心跳定时器、关闭全部连接（`finally` 保证执行）；返回 `{ unregisterFailures: Array<{ repoId, reason }> }`，`session_shutdown` 处理器对非空失败经 `ctx.ui.notify` 播报一次（信号路径不播报） |
| `installExitSignalHandlers` | 宿主已在 SIGTERM/SIGHUP 上触发 `session_shutdown`（pi 交互模式先于扩展注册），本模块只对宿主未监听的信号挂处理器；SIGINT 不挂（TUI 的 Ctrl+C 走按键，且宿主用 SIGINT 忽略器保护 Ctrl+Z 挂起）；处理器以 3 秒为限调用 `shutdownWindow`，超时放弃等待清理确认，随后经 `ctx.shutdown()` 走宿主优雅退出而非 `process.exit` |
| `windowReady` | `windowReady(): Promise<WindowContext>`：当前会话 `startWindow` 完成后兑现、启动失败以具体原因拒绝、`shutdownWindow` 后重置；供 relay 等在 `session_start` 里需要客户端的扩展等待，不依赖扩展文件加载顺序 |
| `windowContext` | 模块级单例访问器 `windowContext(): { windowId, sessionId, workspace, clients, heartbeatError? }`：`startWindow` 后可用，之前调用抛出"窗口未启动"，启动失败后抛出具体原因；`shutdownWindow` 后清空。其他扩展模块只经它取客户端与窗口标识，不各自建立连接（扩展工厂内不得起 socket） |

## 协作关系
- 依赖 `runtime/identity.ts`（`dataRoot`、`repoDataDir`）、`runtime/windows.ts`（`WindowRegistry`）、`runtime/daemon-client.ts`（`WorkspaceClients`，工作区在其内发现一次并经 `workspace()` 暴露）、`runtime/shell-registry.ts`（`stopHost`、`closeOwner`）、`runtime/clock.ts`。
- `extensions/dispatch.ts`、`relay.ts`、`agents-ui.ts`、`shell-ui.ts` 通过 `windowContext` 取客户端与窗口标识，不各自建立连接。
- 守护进程内运行不由本模块触碰。
- 信号处理只在宿主未覆盖的信号上挂载（pi 交互模式已覆盖 SIGTERM/SIGHUP，生产上退出清理由宿主 session_shutdown 驱动、无 3 秒上限，最坏等注册表 5 秒判定）。共享 ShellRegistry 与时钟由本模块作为模块级单例持有（跨 `/new` 不重复创建，`shutdownWindow` 不停止共享时钟的看门狗），注入的 `createClock` 同时供窗口心跳与 Shell 注册表，不为测试另起真实时钟；窗口侧 bash 与 Shell 页的接线由 35 单元引入其访问器。

## 验证方式
- 测试入口：`lifecycleExtension`（假 pi 收集事件处理器并可触发）、`beforeSwitch`。
- 测试输入：临时仓库与工作区夹具；本窗口启动的真实 `sleep` 后台 Shell（含后代）；一个无法确认停止的伪造 Shell；守护进程假客户端。
- 预期结果：
  - `session_start` 后窗口记录存在且心跳持续更新；注入睡眠间隔后不被判失联。
  - 经 `session_before_switch` / `session_before_fork` 事件触发：本窗口真实后台 Shell 及其后代确实停止后返回 `{ cancel: false }`；守护进程连接与运行状态未变化（closeAll 未调用、无 runs.* 调用）；心跳序号随时钟推进持续递增；其它宿主（role）的 Shell 在窗口关闭后仍存活。
  - 存在无法确认停止的 Shell、窗口未启动或停止过程抛错时事件处理器返回 `{ cancel: true }` 且 `ctx.ui.notify` 收到原因，Shell 记录保留。
  - 扩展工厂调用后无新增定时器（用注入时钟/假 ShellRegistry 工厂计数），未注入依赖的生产默认路径在真实临时仓库上完成一次 session_start → shutdown。
  - 连接失败时不留窗口记录且 `windowContext()` 抛出具体原因；注销抛错时连接仍被关闭；心跳持续失败时 `windowContext().heartbeatError` 有原因。
  - 多仓库工作区下每个仓库的窗口目录都有本窗口记录且窗口标识相同、与 hello.windowId 相同，关闭后全部删除；某仓库注销抛错时其它仓库记录仍被删除且连接仍关闭，`session_shutdown` 处理器经 `ctx.ui.notify` 播报该仓库的失败原因。
  - `session_shutdown` 路径不受 3 秒预算限制：一个需要超过 3 秒才能由注册表判定停止的 Shell，在 session_shutdown 后仍等到判定（记录为 stopped/uncertain 而非停在 stopping）。
  - `session_shutdown` 两次调用只清理一次，窗口记录被删除，连接关闭，心跳回调不再被调用（断言定时器释放，而非仅 list 为空）。
  - 对宿主未覆盖的退出信号（SIGTERM/SIGHUP 之一在假 process 上无监听器）：发出该信号后 `shutdownWindow` 被调用且 Shell 停止，随后调用 `ctx.shutdown()`；注入一个永不确认的 Shell 时处理器在 3 秒内放弃等待；宿主已覆盖的信号与 SIGINT 上不存在本模块的监听器。
- [x] 登记与睡眠感知心跳
- [x] 切换前清理确认放行
- [x] 无法确认时取消切换
- [x] 幂等关闭
- [x] 退出信号清理与 3 秒时限
