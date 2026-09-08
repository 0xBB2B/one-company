---
name: shell-registry
description: 统一 Shell 任务注册表：宿主归属、后代进程追踪、超时、停止确认与不确定保留、守护进程拉起时按运行令牌接管遗留任务，供窗口与守护进程各自实例化
---
# Shell 注册表

## 目标
完成后每条受管理命令都有唯一任务身份与明确宿主，后代进程被追踪，停止只在确认后报告成功，超时按扣除睡眠后的秒数计。

## 业务规则（来源：spec）
- managed-execution：每次命令登记唯一任务与宿主，后代归同一任务；登记或启动失败返回具体失败；超时与取消不得以遗留后代作为已结束证据；指定超时按秒从启动计时，到期停止任务及后代，确认清理后才报告超时结束。
- host-lifecycle：宿主为窗口主会话或守护进程内需求代理、角色；子运行结束、暂停或停止时清理其 Shell；主命令退出不等于后代退出，无法确认时按原归属继续管理并显示不确定原因。
- process-control：确认停止只作用于该任务及后代，不停止宿主或其他任务；先显示正在停止，确认清理后才报告停止；身份变化或清理失败保持原目标身份并报告，不误报。
- daemon-host：超时计时扣除睡眠间隔。
- host-lifecycle：守护进程重新拉起时按运行持久保存的识别信息定位前一实例遗留的任务，按原归属接管并允许停止，不自动清理；定位不到记为已全部结束；定位失败返回具体原因不当作已结束。

## 涉及文件
- 新建：`runtime/shell-registry.ts`
- 新建：`tests/shell-registry.test.ts`

## 成品定义

任务记录（内存，经 `subscribe` 推送）：

```json
{ "taskId": "<uuid>", "host": { "kind": "main|requirement|role", "id": "<sessionId 或 runId>", "role": "pi-company.worker", "runId": "…" },
  "command": "…", "cwd": "…", "mode": "wait|background", "pid": 123, "pgid": 123, "startedAt": "<UTC>", "timeoutSeconds": 60,
  "status": "starting|running|stopping|uncertain|exited|failed|stopped|timed_out", "activity": "active|uncertain|ended",
  "exitCode": null, "reason": "<不确定或失败原因>", "descendants": [456, 789] }
```

后代识别：每条命令 spawn 时注入环境变量 `PI_COMPANY_SHELL_TOKEN=<token>`，守护进程内任务的 token 为所属运行记录的 shellToken，窗口主会话任务的 token 由该会话生成；两次 `ps` 采样（带环境列与不带）取交集后，命中条件为 pid 等于根进程、或 pgid 等于根 pid 且启动时刻不早于根、或环境含该 token；排除僵尸与自身。

## 函数清单
### runtime/shell-registry.ts
| 函数 | 职责 |
|---|---|
| `shellOwnerKey` | 由进程窗口标识、工作目录与会话生成 owner 键 |
| `ShellRegistry.activateOwner` | 登记 owner，为其任务分配存续范围 |
| `ShellRegistry.spawn` | 登记任务后以 detached 进程组启动命令，注入 token，失败返回具体原因且不留下记录 |
| `ShellRegistry.list` | 列出 owner 或全部活动任务 |
| `ShellRegistry.get` | 读取一条任务当前状态 |
| `ShellRegistry.inspect` | 两次 ps 采样识别后代与活动状态，根进程启动时刻变化即判不确定 |
| `ShellRegistry.stop` | 核对身份后 SIGTERM，静止未确认再 SIGKILL，连续静止一段时间才判 stopped，否则 uncertain |
| `ShellRegistry.stopHost` | 停止某宿主全部任务并汇总确认结果 |
| `ShellRegistry.closeOwner` | owner 退出时停止其全部任务，未确认的保留并标不确定 |
| `ShellRegistry.adoptOrphans` | 按给定 owner 与 token 用 ps 采样定位环境含该 token 的存活进程，登记为该 owner 的 running 任务（command 取自 ps，startedAt 取进程启动时刻）并返回任务清单；无进程返回空清单；ps 失败返回具体原因而非空清单 |
| `ShellRegistry.subscribe` | 推送任务状态变化 |
| `scheduleTimeout` | 用睡眠感知时钟从启动时刻按秒计时，到期触发 stop 并标 timed_out |

## 协作关系
窗口 `extensions/shell-ui.ts` 与守护进程 `daemon/run-manager.ts` 各持有一个实例；`runtime/shell-bash.ts` 通过 `spawn` 执行命令；`runtime/clock.ts` 提供睡眠感知计时；守护进程把任务变化经 `shells.changed` 事件推给窗口；`daemon/run-manager.ts` 启动时对每个中断运行调用 `adoptOrphans`。

## 验证方式
- 测试入口：`ShellRegistry` 各方法，用真实子进程（`sleep`、启动孙进程后父进程立即退出的脚本）
- 测试输入：启动含两代后代的命令；用已知 token 作为环境变量启动持续运行的进程后新建注册表调用 `adoptOrphans`，另对已退出进程的 token 调用，再模拟 ps 失败；父进程先退出；`timeoutSeconds: 1` 并注入 30 秒时钟跳变；对已结束任务再停止；停止时 pid 被复用（用假 startedAt 模拟身份变化）；不可执行命令
- 预期结果：后代被识别且停止后全部消失才报 stopped；接管的任务以给定 owner 为宿主出现且可 stop 并确认清理，已退出 token 返回空清单，ps 失败返回原因；父退出后任务仍 active 直到后代退出；睡眠跳变不触发超时，真实 1 秒后触发并确认清理；已结束任务返回已结束而非再次 kill；身份变化返回 uncertain 且不发信号；启动失败无记录且有原因
- [ ] 后代追踪与整树停止
- [ ] 父退出不隐藏后代
- [ ] 超时扣除睡眠
- [ ] 身份核对防误停
- [ ] 启动失败不失管
- [ ] 拉起接管遗留任务
