---
name: daemon-client
description: 窗口侧守护进程客户端：按工作区内仓库建立多连接、缺失时拉起、重连退避、不可达状态与事件订阅
---
# 守护进程客户端

## 目标
窗口扩展能对工作区内每个仓库取得一个可用的守护进程连接，缺失时自动拉起，断开时如实暴露不可达并自动重连。

## 业务规则（来源：spec）
- daemon-host：一个仓库一个守护进程；窗口需要派工、查询或控制而对应守护进程未运行时自动启动唯一实例并连接，已运行时只连接；同仓库各 worktree 与启动目录覆盖该仓库的窗口连接同一个守护进程，启动目录不覆盖该仓库的窗口不得连接。
- daemon-host：无法连接或守护进程崩溃时，窗口显示不可达及具体原因，不把旧状态显示为运行中，不在窗口内替代执行派工。
- daemon-host：睡眠唤醒后继续；心跳与失联判定扣除睡眠间隔。
- workspace-coordination：窗口启动目录及子目录内发现的全部 Git 仓库构成工作区，可见、可控与投递范围限定为这些仓库。
- 扩展工厂内不得起 socket、进程或定时器；连接在会话开始时建立，会话结束时关闭。

## 涉及文件
- 新建 `runtime/daemon-client.ts`
- 新建 `tests/daemon-client.test.ts`
- 修改 `tests/helpers/daemon-harness.ts`（补充 `connectTestClient`、`killDaemon`）

## 函数清单
### runtime/daemon-client.ts
| 函数名 | 职责 |
|---|---|
| `resolveSdkDir` | 用 SDK 导出的 `getPackageDir` 取 pi 安装目录，供拉起守护进程时经 `PI_COMPANY_SDK_DIR` 传入 |
| `spawnDaemon` | 以 `process.execPath`（可覆盖）分离启动 `daemon/main.ts`，传入 SDK 目录、仓库目录、数据根与调用方附加环境（如空闲时限），仓库身份经 identity 归一；以连接探测等待 socket 可连接并完成 ping，spawn 失败或守护进程启动失败（含 stderr 原因）与超时都作为具体原因抛出而不是未捕获异常（不存在锁文件） |
| `connectDaemon` | 对单个仓库：尝试连接 socket，不存在、拒绝或路径上是非 socket 文件时调用 `spawnDaemon` 后重试，成功后发送 `hello` 帧并核对响应的仓库身份，返回 `DaemonClient`；首连失败（含 hello 被拒）先关闭自身再抛出，不留下重连循环 |
| `DaemonClient.call` | 发送请求帧并按 id 等待响应；断开时以不可达错误拒绝而非挂起 |
| `DaemonClient.subscribe` | 订阅 `activity` / `transcript` / `relay.*` / `shells.changed` / `runs.changed` 事件并分发给监听者（监听器异常隔离） |
| `DaemonClient.state` | 暴露 `connected` / `starting` / `unreachable` 及最近一次失败原因 |
| `DaemonClient.close` | 以不可达拒绝全部在途调用、取消订阅、关闭 socket、停止重连（重连窗口内关闭亦生效）、停止自建时钟 |
| `scheduleReconnect` | 断开后用睡眠感知时钟做带随机抖动的指数退避重连（上限 5 秒），重连成功重新 `hello` 并恢复订阅 |
| `WorkspaceClients` | 按工作区仓库集合（按仓库身份去重，同仓库主目录与 worktree 只建一个连接）维护多个 `DaemonClient`，单个仓库连接失败时该仓库降级为不可达并附原因而不整体失败；发现阶段被跳过的仓库连同原因暴露；提供 `forRepo`、`all`、`skipped`、`closeAll`、`workspace()`（创建时发现一次的工作区结果，供窗口生命周期登记与其它扩展取仓库路径，避免重复发现） |

## 协作关系
- `connectDaemon` 依赖 `runtime/identity.ts` 的 `daemonSocketPath`、`repoDataDir`，依赖 `runtime/protocol.ts` 的编解码与 `hello` 参数类型。
- `WorkspaceClients` 由 `extensions/lifecycle.ts` 在 `session_start` 创建、`session_shutdown` 关闭；`extensions/dispatch.ts`、`extensions/relay.ts`、`extensions/agents-ui.ts`、`extensions/shell-ui.ts` 通过它调用方法与订阅事件。
- `hello` 参数：`windowId`、`pid`、`cwd`、`workspaceRoot`、`repos`（仓库身份列表）、`protocolVersion`。
- 重连计时用 `runtime/clock.ts` 的 `createClock`，不用裸 `setTimeout`。

## 验证方式
- 测试入口：`connectDaemon`、`WorkspaceClients`、`DaemonClient.call/subscribe/state`（包级可调用）；测试用 `tests/helpers/daemon-harness.ts` 在临时数据根下真实启动或伪造守护进程。
- 测试输入：临时仓库夹具（含一个 worktree）、工作区夹具（父目录含两个仓库）、未运行守护进程、运行中的守护进程、被 SIGKILL 的守护进程、注入的睡眠间隔。
- 预期结果：
  - 未运行时 `connectDaemon` 拉起且只拉起一个进程（并发两次调用也只出现一个 pid），返回 `connected`；再次调用不再拉起。
  - 工作区夹具下 `WorkspaceClients.all` 恰为两个连接；单仓库或其 worktree 内只有一个，且两者 socket 路径相同；工作区外仓库无连接。
  - 守护进程被强杀后 `state` 变为 `unreachable` 且附原因，进行中的 `call` 被拒绝而非挂起；守护进程重新可用后自动重连并恢复订阅。
  - 注入 5 分钟睡眠间隔时重连退避不被视为已超时，不产生失联误判。
  - `hello` 帧包含 `windowId`、`pid`、`cwd`、`workspaceRoot`、`repos`。
- [ ] 单实例拉起与并发拉起只出现一个进程
- [ ] 工作区多连接与单仓库单连接
- [ ] 强杀后不可达、调用不挂起、恢复后自动重连
- [ ] 睡眠间隔不计入退避与失联
