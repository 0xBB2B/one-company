---
name: run-store
description: 守护进程内运行记录的持久化：状态集合（无停止不确定）、原子写入、按仓库归档、启动恢复标记中断、终态不可回退
---
# 运行记录存储

## 目标
完成后每次派工都有唯一运行身份与持久化记录，状态变化原子落盘，守护进程重启后未终态记录变为中断且可查询。

## 业务规则（来源：spec）
- builtin-execution：派工成功返回唯一运行身份；状态区分运行中、暂停中、已暂停、等待答复、正常结束、失败、用户停止与中断；启动成功不等于任务通过。
- run-lifecycle：守护进程崩溃、被强杀或机器重启后运行标记为中断并保留现场；异常退出记录失败原因，不把自然语言当作完成证据。
- user-stop：守护进程确认停止请求已发出后运行即记为用户停止，这是终态，不提供恢复；各 Shell 清理是否确认是 Shell 任务自身的状态，只记录在 Shell 登记表而不进入运行记录；重新派出产生新的运行身份。
- data-ownership：运行数据保存在本机用户数据区，按仓库归属，不随 Git 同步。
- host-lifecycle：守护进程内任务的识别信息随所属运行持久保存，供重新拉起的守护进程定位遗留任务。

## 涉及文件
- 新建：`runtime/run-store.ts`
- 新建：`tests/run-store.test.ts`

## 成品定义

仓库 SQLite 的 `runs` 命名空间（UUIDv7 主键等于 runId，业务载荷与版本原子更新）：

```json
{
  "id": "<UUIDv7>",
  "kind": "requirement" | "role",
  "role": "pi-company.worker",
  "requirement": "<reqId>",
  "parentRunId": "<需求代理运行 id，角色运行才有>",
  "task": "<任务标题或需求标题>",
  "cwd": "/abs/worktree",
  "shellToken": "<UUIDv4，该运行全部 Shell 任务共用的识别令牌，创建时生成后不再改变>",
  "writePaths": ["…"], "readPaths": ["…"],
  "model": { "provider": "…", "id": "…" }, "thinking": "high", "mcp": ["context7"],
  "state": "queued|running|pausing|paused|paused_network|waiting_answer|completed|failed|stopped|interrupted",
  "stateReason": "<状态说明，如网络原因、中断原因>",
  "startedAt": "<UTC>", "updatedAt": "<UTC>", "endedAt": "<UTC，一旦写入不再改变>",
  "turns": 3,
  "result": { "phase": "work", "verdict": "PASS", "…结构化对象…" },
  "errorDetails": { "path": "…", "status": "none|saved|incomplete|unreadable|unavailable" },
  "daemonStartedAt": "<写入该记录的守护进程启动时刻>"
}
```

状态转换：`queued→running`；`running→pausing→paused`；`running→paused_network`；`running↔waiting_answer`；`paused|paused_network→running`；任何非终态 `→failed|stopped`；守护进程启动时 非终态 `→interrupted`（标记时保留已有的状态说明，仅为空时写入重启说明）；`interrupted→running`（续接）。终态 `completed|failed|stopped` 不可再变。

## 函数清单
### runtime/run-store.ts
| 函数 | 职责 |
|---|---|
| `RunStore.create` | 生成 UUIDv7 记录和随机 shellToken 并原子写入，拒绝非法角色与缺失需求身份 |
| `RunStore.get` | 读取并校验一条记录，损坏返回不可读错误 |
| `RunStore.list` | 按 kind、requirement、状态过滤并分页，统计运行中数量 |
| `RunStore.update` | 按转换表更新状态与字段，终态不可回退，`endedAt` 只写一次，`shellToken` 不可改写，在短事务中读取最新版本并更新 |
| `RunStore.recordCommand` / `RunStore.recordTurn` | 在事务内追加命令与累加回合，多个实例交错上报不丢失活动 |
| `RunStore.markInterruptedOnStartup` | 把 `daemonStartedAt` 不等于本次启动且非终态的记录在数据库事务内复判后改为 `interrupted` 并写入本次 `daemonStartedAt`（幂等）；单条失败收集到返回值而不中断整轮 |
| `RunStore.markOwnRunsInterrupted` | 把 `daemonStartedAt` 等于本实例且非终态、非 interrupted 的记录改为 interrupted（守护进程退出路径调用，不触碰其他实例的运行） |
| `isTerminalState` | 判断状态是否终态 |
| `assertTransition` | 校验状态转换合法，否则抛出说明 |

## 协作关系
- 运行记录持久化派工期参数中续接所需的字段：`reportPath`（验收者报告路径）随运行创建写入，续接时回填角色会话。
- 状态机允许 `paused`/`pausing` 直接到 `completed`/`failed`（运行落定不是用户继续，不经中间 running 写入）。
- 角色运行的 parentRunId 默认必填；调用方以 `standalone: true` 显式声明无父运行（如窗口连接派出的提交前审查者）时允许缺省，存储层不按角色名特判。

## 验证方式
- 测试入口：`RunStore` 各方法，输入为临时数据根
- 测试输入：并发创建 50 条并读回核对 shellToken；尝试 update 改写 shellToken；对同一记录并发 20 次 update；非法转换（completed→running、stopped→paused）；两次写 endedAt；预置三条 running 与一条 completed 后以新的 daemonStartedAt 调用启动标记；将运行记录改为坏结构
- 预期结果：50 个 id 与 shellToken 互不相同、可从 SQLite 读回且数据库权限 0600；改写 shellToken 被拒且记录不变；并发更新后记录一致无丢失；非法转换抛出且记录不变；状态集合不含停止不确定，任何非终态可直接转为 stopped 终态；第二次 endedAt 被忽略；三条 running 变 interrupted、completed 不变；损坏记录读取返回不可读而非抛出未捕获异常
- [x] 唯一身份、shellToken 与权限
- [x] 转换表正反例
- [x] 并发串行化
- [x] 启动标记中断
- [x] 损坏记录不冒充

运行保存 `pendingDispatch`（原始说明与跨仓等待条件）。中断时尚未创建会话的排队运行，续接使用该描述恢复同一 runId，不要求不存在的会话记录；有会话的运行按会话历史续接。
