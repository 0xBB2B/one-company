---
name: run-store
description: 守护进程内运行记录的持久化：状态集合、原子写入、按仓库归档、启动恢复标记中断、终态不可回退
---
# 运行记录存储

## 目标
完成后每次派工都有唯一运行身份与持久化记录，状态变化原子落盘，守护进程重启后未终态记录变为中断且可查询。

## 业务规则（来源：spec）
- builtin-execution：派工成功返回唯一运行身份；状态区分运行中、暂停中、已暂停、等待答复、正常结束、失败、用户停止、中断与停止不确定；启动成功不等于任务通过。
- run-lifecycle：守护进程崩溃、被强杀或机器重启后运行标记为中断并保留现场；异常退出记录失败原因，不把自然语言当作完成证据。
- user-stop：停止是终态，不提供恢复；重新派出产生新的运行身份。
- local-ownership：运行数据保存在本机用户数据区，按仓库归属，不随 Git 同步。

## 涉及文件
- 新建：`runtime/run-store.ts`
- 新建：`tests/run-store.test.ts`

## 成品定义

`runs/<runId>/state.json`（目录 0700、文件 0600，写入为临时文件 + fsync + rename）：

```json
{
  "id": "<UUIDv4>",
  "kind": "requirement" | "role",
  "role": "pi-company.worker",
  "requirement": "<reqId>",
  "parentRunId": "<需求代理运行 id，角色运行才有>",
  "task": "<任务标题或需求标题>",
  "cwd": "/abs/worktree",
  "writePaths": ["…"], "readPaths": ["…"],
  "model": { "provider": "…", "id": "…" }, "thinking": "high", "mcp": ["context7"],
  "state": "queued|running|pausing|paused|paused_network|waiting_answer|completed|failed|stopped|interrupted|uncertain",
  "stateReason": "<状态说明，网络原因、停止不确定原因等>",
  "startedAt": "<UTC>", "updatedAt": "<UTC>", "endedAt": "<UTC，一旦写入不再改变>",
  "turns": 3,
  "result": { "phase": "work", "verdict": "PASS", "…结构化对象…" },
  "errorDetails": { "path": "…", "status": "none|saved|incomplete|unreadable|unavailable" },
  "cleanupConfirmed": true,
  "daemonStartedAt": "<写入该记录的守护进程启动时刻>"
}
```

状态转换：`queued→running`；`running→pausing→paused`；`running→paused_network`；`running↔waiting_answer`；`paused|paused_network→running`；任何非终态 `→failed|stopped|uncertain`；守护进程启动时 非终态 `→interrupted`；`interrupted→running`（续接）。终态 `completed|failed|stopped` 不可再变。

## 函数清单
### runtime/run-store.ts
| 函数 | 职责 |
|---|---|
| `RunStore.create` | 生成 UUIDv4 记录并原子写入，拒绝非法角色与缺失需求身份 |
| `RunStore.get` | 读取并校验一条记录，损坏返回不可读错误 |
| `RunStore.list` | 按 kind、requirement、状态过滤并分页，统计运行中与不确定数量 |
| `RunStore.update` | 按转换表更新状态与字段，终态不可回退，`endedAt` 只写一次，按记录串行化写入 |
| `RunStore.markInterruptedOnStartup` | 把 `daemonStartedAt` 不等于本次启动且非终态的记录改为 `interrupted` |
| `isTerminalState` | 判断状态是否终态 |
| `assertTransition` | 校验状态转换合法，否则抛出说明 |

## 协作关系
`daemon/run-manager.ts` 是唯一写入方；`daemon/server.ts` 的 `runs.list`/`runs.get` 只读；`daemon/lifecycle.ts` 启动时调用 `markInterruptedOnStartup`；目录路径来自 `runtime/identity.ts` 的 `runDataDir`；原子写入用 `runtime/store.ts`。

## 验证方式
- 测试入口：`RunStore` 各方法，输入为临时数据根
- 测试输入：并发创建 50 条；对同一记录并发 20 次 update；非法转换（completed→running、stopped→paused）；两次写 endedAt；预置三条 running 与一条 completed 后以新的 daemonStartedAt 调用启动标记；篡改文件为非 JSON
- 预期结果：50 个 id 互不相同且文件权限 0600；并发更新后记录一致无丢失；非法转换抛出且文件不变；第二次 endedAt 被忽略；三条 running 变 interrupted、completed 不变；损坏文件读取返回不可读而非抛出未捕获异常
- [ ] 唯一身份与权限
- [ ] 转换表正反例
- [ ] 并发串行化
- [ ] 启动标记中断
- [ ] 损坏记录不冒充
