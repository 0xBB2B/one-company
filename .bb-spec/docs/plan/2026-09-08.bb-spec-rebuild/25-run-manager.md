---
name: run-manager
description: 守护进程运行编排：派工校验与并行判定、状态机、暂停/继续/停止级联、全部暂停、中断续接、网络自动续接，控制不依赖模型
---
# 运行管理器

## 目标
完成后守护进程能派出需求代理与角色、按依赖与写入范围并行、对任一运行执行确认式的暂停/继续/停止、续接中断运行，并把状态与活动推送给窗口。

## 业务规则（来源：spec）
- builtin-execution：满足形状顺序、依赖完成且写入范围不冲突的任务可并行，不设数量上限；不满足条件不并行启动。
- pause-control：暂停立即请求取消并阻止后续，确认后才显示已暂停；暂停需求代理连带其角色；全部暂停覆盖本工作区并阻止新派工，全部继续解除；网络恢复后自动续接网络暂停；控制不依赖模型响应。
- user-stop：停止等待会话与受管理工具停止并清理后才确认；停止需求代理连带角色与 Shell；停止单个角色把结果送达其需求代理；停止是终态，重新派出为新身份；清理无法确认时显示不确定且不派重叠运行。
- run-lifecycle：续接前核对该运行接管的 Shell 任务、会话记录与工作区；存在活动或不确定任务时拒绝并列出任务与原因、状态保持中断；全部结束后重载续接，不回滚改动。
- host-lifecycle：守护进程重新拉起时按运行的 shellToken 接管前一实例遗留的任务，只接管不清理，定位失败记入原因。
- structured-verdict：运行正常完成后才把合法对象交给门禁。

## 涉及文件
- 新建：`daemon/run-manager.ts`
- 修改：`daemon/server.ts` — 接入 dispatch/runs/subscribe 方法处理器
- 新建：`tests/run-manager.test.ts`

## 函数清单
### daemon/run-manager.ts
| 函数 | 职责 |
|---|---|
| `RunManager.dispatchRequirement` | 校验需求已确认与唯一，创建运行记录与需求代理会话，返回运行身份 |
| `RunManager.dispatchRole` | 校验角色目录、形状、依赖与写入范围冲突，创建角色运行并启动 |
| `canRunInParallel` | 判断新任务与在跑任务是否写入范围重叠或依赖未完成 |
| `RunManager.status` / `list` | 读取运行记录并附错误摘要与统计 |
| `RunManager.pause` | 对需求代理级联到其角色与 Shell，等待确认或超时返回 pausing |
| `RunManager.resume` | 校验状态为 paused/paused_network，触发续跑并解除闸门 |
| `RunManager.stop` | 级联停止、等待清理确认（6 秒上限），确认后写终态并通知中继，超时置 uncertain |
| `RunManager.pauseAll` / `resumeAll` / `stopAll` | 对本守护进程全部运行批量执行并逐条汇报 |
| `RunManager.adoptInterruptedShells` | 启动时对每个 interrupted 运行按 shellToken 调用注册表接管遗留任务，定位失败写入 stateReason |
| `RunManager.resumeInterrupted` | 核对该运行在注册表中无活动或不确定任务、会话文件与工作区后重载会话续接；否则返回被拒原因与任务清单且状态不变 |
| `RunManager.resumeNetworkPaused` | 网络恢复回调：对 paused_network 运行先注入只读核对提示再继续，并发通知 |
| `RunManager.onSessionEvent` | 把会话事件投影为运行状态变化、活动与记录事件并广播 |
| `RunManager.finalizeRun` | 会话结束后用结果收集器判定 completed/failed，保存错误详情，释放会话 |
| `RunManager.close` | 守护进程退出时停止全部运行的 Shell 并标记中断 |

## 协作关系
`daemon/server.ts` 把协议方法映射到 `RunManager` 方法；`RunManager` 依赖 `runtime/run-store.ts`、`daemon/role-session.ts`、`daemon/requirement-agent.ts`、`runtime/shell-registry.ts`、`runtime/network-pause.ts`、`runtime/result.ts`、`runtime/error-details.ts`、`daemon/relay-queue.ts`（通知）；`daemon/lifecycle.ts` 启动时先 `markInterruptedOnStartup` 再 `adoptInterruptedShells`。

## 验证方式
- 测试入口：经 `tests/helpers/daemon-harness.ts` 真实启动守护进程后通过协议方法驱动；受控 provider
- 测试输入：五个写入范围互斥的角色任务同时派出；一个与在跑任务范围重叠的任务；暂停一个正在调用两个角色的需求代理；停止一个有后台 Shell 与后代的角色；停止一个清理无法确认的运行（脚本让后代忽略信号并超过 6 秒）；全部暂停后派工；在角色后台命令仍运行时强杀守护进程，重启后续接，被拒后停止该 Shell 再续接；另在无遗留进程时强杀重启并续接
- 预期结果：五个任务并行运行，重叠任务被拒绝并说明冲突；暂停后三者均 paused 且无新写入；停止后角色 stopped、Shell 树消失、需求代理收到该角色结果；清理不确定的运行为 uncertain 并拒绝重叠派工；全部暂停期间派工被拒，全部继续后恢复；有遗留进程时该 Shell 以原运行为宿主出现在列表、续接被拒并列出它且状态仍为 interrupted，停止后续接通过；无遗留时直接续接通过；续接后会话上下文与文件一致且未重跑已完成任务
- [ ] 并行判定
- [ ] 暂停级联确认
- [ ] 停止级联与清理确认
- [ ] 不确定失败关闭
- [ ] 全部暂停/继续
- [ ] 中断续接与遗留接管
