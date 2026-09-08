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
| `lifecycleExtension` | 默认导出：注册 `session_start`、`session_before_switch`、`session_shutdown` 处理器，并调用 `installExitSignalHandlers` |
| `startWindow` | 发现工作区、生成窗口标识、登记窗口记录、创建 `WorkspaceClients`、启动睡眠感知心跳、激活本窗口 Shell 归属 |
| `beforeSwitch` | 停止本窗口主会话全部 Shell 并等待清理确认；确认则放行，未确认返回取消并通知原因 |
| `shutdownWindow` | 幂等：停止本窗口 Shell、注销窗口记录、停止心跳、关闭全部连接；`session_shutdown` 与退出信号共用此函数 |
| `installExitSignalHandlers` | 实施前先核实宿主是否已在 SIGHUP/SIGTERM/SIGINT 上触发 `session_shutdown`：已触发的信号不重复挂；未触发的信号注册处理器调用 `shutdownWindow`，以 3 秒为限，超时放弃等待清理确认并退出，不阻塞进程终止 |
| `windowContext` | 向其他扩展模块提供当前窗口标识、工作区与客户端集合 |

## 协作关系
- 依赖 `runtime/identity.ts`（`discoverWorkspace`）、`runtime/windows.ts`（`WindowRegistry`）、`runtime/daemon-client.ts`（`WorkspaceClients`）、`runtime/shell-registry.ts`（`stopHost`、`closeOwner`）、`runtime/clock.ts`。
- `extensions/dispatch.ts`、`relay.ts`、`agents-ui.ts`、`shell-ui.ts` 通过 `windowContext` 取客户端与窗口标识，不各自建立连接。
- 守护进程内运行不由本模块触碰。
- 信号处理只在宿主未覆盖的信号上挂载，核实结论写入本单元实现的测试夹具说明。

## 验证方式
- 测试入口：`lifecycleExtension`（假 pi 收集事件处理器并可触发）、`beforeSwitch`。
- 测试输入：临时仓库与工作区夹具；本窗口启动的真实 `sleep` 后台 Shell（含后代）；一个无法确认停止的伪造 Shell；守护进程假客户端。
- 预期结果：
  - `session_start` 后窗口记录存在且心跳持续更新；注入睡眠间隔后不被判失联。
  - `session_before_switch` 时本窗口 Shell 及后代确实停止后返回放行；守护进程连接与运行状态未变化。
  - 存在无法确认停止的 Shell 时返回取消并附原因，Shell 记录保留。
  - `session_shutdown` 两次调用只清理一次，窗口记录被删除，连接关闭。
  - 对宿主未覆盖的退出信号：向假 process 发出该信号后 `shutdownWindow` 被调用且 Shell 停止；注入一个永不确认的 Shell 时处理器在 3 秒内返回并放弃等待；宿主已覆盖的信号上不存在本模块的监听器。
- [ ] 登记与睡眠感知心跳
- [ ] 切换前清理确认放行
- [ ] 无法确认时取消切换
- [ ] 幂等关闭
- [ ] 退出信号清理与 3 秒时限
