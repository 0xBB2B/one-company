---
name: shell-registry
description: 统一 Shell 任务注册表：宿主归属、进程组信号探测与 ps 逃逸后代发现、超时、停止确认与不确定保留、用户裁定登记、守护进程拉起时按运行令牌接管遗留任务
---
# Shell 注册表

## 目标
完成后每条受管理命令都有唯一任务身份与明确宿主，进程树以信号探测为准、ps 只补发现逃逸后代，停止只在确认后报告成功，无法确认时保留并可由用户裁定，超时按扣除睡眠后的秒数计。

## 业务规则（来源：spec）
- managed-execution：每次命令登记唯一任务与宿主，后代归同一任务；登记或启动失败返回具体失败；超时与取消不得以遗留后代作为已结束证据；指定超时按秒从启动计时，到期停止任务及后代，确认清理后才报告超时结束。
- host-lifecycle：宿主为窗口主会话或守护进程内需求代理、角色；子运行结束、暂停或停止时清理其 Shell；主命令退出不等于后代退出，无法确认时按原归属继续管理并显示不确定原因。
- process-list：确认停止只作用于该任务及后代，不停止宿主或其他任务；先显示正在停止，确认清理后才报告停止；身份变化或清理失败保持原目标身份并报告，不误报。
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
  "exitCode": null, "reason": "<不确定或失败原因>", "descendants": [456, 789], "descendantsScanned": true, "identityVerified": true,
  "stoppedBy": "signal|user" }
```

令牌与确认手段：

```
环境变量：PI_COMPANY_SHELL_TOKEN=<runToken>:<taskId>
  runToken：守护进程内任务取所属运行记录持久保存的 shellToken；窗口主会话任务由该会话生成一次。持久化只存 runToken，taskId 段不落盘。
存活探测：先对任务进程组发 0 号信号（kill(-pgid, 0)）判定已知进程树是否仍有成员；这是 stopped 的唯一判据来源。
逃逸后代：ps 只用于发现环境含本任务完整令牌但已离开进程组的进程；找到即并入 descendants 并一并处理。
ps 不可用：以信号探测为准，任务 descendantsScanned=false（"后代未扫描"），不因此判 uncertain。
探测出错（信号调用异常、根进程启动时刻变化）：任务 uncertain 并记原因，可由用户裁定登记为已停止。
启动时刻基线取不到或采样失败导致身份未核对：identityVerified=false，仍以信号探测为准发信号。
采样熔断只对采样超时生效（约 5 秒冷却）；解析类失败只让本轮按不可用处理。
ps 找不到的进程不带任何"可能有未追踪后代"标记。
```

注入点（测试与宿主共用）：

```
new ShellRegistry({ clock, probes?: { kill?: (pid: number, signal: NodeJS.Signals | 0) => void, ps?: () => Promise<PsEntry[]>, pidStartedAt?: (pid: number) => Promise<number | null> } })
pidStartedAt：单 pid 启动时刻查询，spawn 建基线与存活分支的身份核对共用同一探针；缺省用 `ps -o lstart= -p <pid>`
PsEntry = { pid: number, pgid: number, ppid: number, startedAt: "<UTC>", command: string, token: string | null }  // token 为该进程环境中的 PI_COMPANY_SHELL_TOKEN
ps 采样器抛出 → 视为 ps 不可用：inspect/stop 走"后代未扫描"，adoptOrphans 返回 { ok: false, reason }
kill 桩抛出 → 探测出错：任务 uncertain 并记原因
缺省 probes 用 process.kill 与 `ps -axo pid,pgid,ppid,lstart,command`（LC_ALL=C，显式 maxBuffer；有数据行但解析出 0 条视为不可用）加 macOS `ps -E`（令牌只取环境段，命令行文本里的令牌不算）/ Linux /proc 读取环境；pid 或 pgid ≤ 1 的行丢弃
```

## 函数清单
### runtime/shell-registry.ts
| 函数 | 职责 |
|---|---|
| `shellOwnerKey` | 由进程窗口标识、工作目录与会话生成 owner 键 |
| `ShellRegistry.spawn` | 登记任务（starting）后以 detached 进程组启动命令，注入调用方给出的 runToken 与 taskId 组成的令牌，启动后置 running；失败返回具体原因且不留下记录；启动时刻取不到时不伪造基线，身份核对在无基线时跳过 |
| `ShellRegistry.list` | 列出全部或按宿主过滤的任务 |
| `ShellRegistry.get` | 读取一条任务当前状态 |
| `probeProcessGroup` | 对 pgid 发 0 号信号：返回 alive / gone / error（含 errno） |
| `parsePsTable` | 解析 LC_ALL=C 的 ps 表文本为条目；有非空数据行但 0 条可解析即抛错 |
| `findEscapedDescendants` | 用一次 ps 采样（环境列）找令牌等于本任务令牌且 pgid 不同的存活进程；ps 不可用返回"未扫描"；采样带约 3 秒超时，超时按不可用降级；采样全局串行但一次挂起不阻塞后续 |
| `ShellRegistry.inspect` | 先 `probeProcessGroup`；存活分支用单 pid 查询核对根进程启动时刻，逃逸后代全表扫描按任务节流为每秒最多一次（扣除睡眠）；消失分支与停止路径立即做 `findEscapedDescendants`；据此更新 activity、descendants、descendantsScanned；探测出错或根进程启动时刻变化即 uncertain 并记原因；同一任务一轮未结束不启动下一轮 |
| `ShellRegistry.stop` | 核对身份后对进程组 SIGTERM，静止未确认再 SIGKILL；信号探测连续两次 gone（只有 ESRCH 算 gone）且逃逸后代（若已扫描）全部消失才判 stopped，否则保持 stopping 直至上限（扣除睡眠）后 status 与 activity 均 uncertain；终态时清除超时定时器 |
| `ShellRegistry.markStoppedByUser` | 对 uncertain 任务按用户裁定登记为 stopped（stoppedBy=user，记录决定编号）；写决策记录由调用方负责；非 uncertain 任务拒绝 |
| `ShellRegistry.stopHost` | 停止某宿主全部任务并汇总确认结果 |
| `ShellRegistry.closeOwner` | owner 退出时停止其全部任务，未确认的保留并标不确定 |
| `ShellRegistry.adoptOrphans` | 按给定 owner 与 runToken 用 ps 采样定位环境令牌以 `<runToken>:` 开头的存活进程，按令牌的 taskId 段分组还原为该 owner 的 running 任务（每组一条，command 取自 ps、startedAt 取进程启动时刻、pid/pgid 取组内最早进程）并返回任务清单；无进程返回空清单；ps 失败返回具体原因而非空清单 |
| `ShellRegistry.subscribe` | 按任务推送状态变化；监听器异常被隔离，不影响任务流转 |
| `scheduleTimeout` | 用睡眠感知时钟从启动时刻按秒计时，到期触发 stop 并标 timed_out |

## 协作关系
窗口 `extensions/shell-ui.ts` 与守护进程 `daemon/run-manager.ts` 各持有一个实例；`runtime/shell-bash.ts` 通过 `spawn` 执行命令；`runtime/clock.ts` 提供睡眠感知计时；守护进程把任务变化经 `shells.changed` 事件推给窗口；`daemon/run-manager.ts` 启动时对每个中断运行以其 shellToken 调用 `adoptOrphans`；Shell 管理页对 uncertain 任务提供"视为已停止"入口，先写决策记录再调用 `markStoppedByUser`。

## 验证方式
- 测试入口：`ShellRegistry` 各方法，用真实子进程（`sleep`、启动孙进程后父进程立即退出的脚本、用 `setsid` 脱离进程组的脚本）；ps 可用性与信号调用经可注入的桩控制
- 测试输入：启动含两代后代的命令；启动会 `setsid` 出逃逸后代的命令；同一 runToken 下两个 taskId 各启动持续进程后新建注册表调用 `adoptOrphans`，另对已退出令牌调用，再模拟 ps 失败；ps 不可用时启动与停止普通命令；信号调用被桩为抛错；父进程先退出；`timeoutSeconds: 1` 并注入 30 秒时钟跳变；对已结束任务再停止；停止时 pid 被复用（用假 startedAt 模拟身份变化）；对 uncertain 与 running 任务分别调用 `markStoppedByUser`；不可执行命令
- 预期结果：进程组内后代经信号探测确认消失后才报 stopped；逃逸后代被 ps 发现并随停止一起消失；接管的任务按 taskId 段恰还原两条、宿主为给定 owner 且可 stop 并确认清理，已退出令牌返回空清单，ps 失败返回原因；ps 不可用时任务正常 running→stopped 且 descendantsScanned=false、不带任何未追踪后代标记；信号调用抛错时任务 uncertain 且带原因，`markStoppedByUser` 后为 stopped（stoppedBy=user），对 running 任务调用被拒绝；父退出后任务仍 active 直到后代退出；睡眠跳变不触发超时，真实 1 秒后触发并确认清理；已结束任务返回已结束而非再次 kill；身份变化返回 uncertain 且不发信号；启动失败无记录且有原因
- [ ] 进程组信号探测与整树停止
- [ ] 逃逸后代发现
- [ ] ps 不可用降级与探测出错不确定
- [ ] 用户裁定登记
- [ ] 父退出不隐藏后代
- [ ] 超时扣除睡眠
- [ ] 身份核对防误停
- [ ] 启动失败不失管
- [ ] 按运行令牌分组接管遗留任务
