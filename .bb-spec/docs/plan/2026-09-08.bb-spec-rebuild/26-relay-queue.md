---
name: relay-queue
description: 守护进程内的提问与通知队列接口：持久化、按工作区筛选投递目标、首答生效撤回、离线排队、补充转发与契约变更请求路由；协议接入由运行管理器完成
---
# 对话中继队列

## 目标
完成后需求代理的提问与通知能可靠到达本工作区窗口的主会话，首个答复送回需求代理，无窗口时排队并在新窗口连接后推送。

## 业务规则（来源：spec）
- user-relay：问题带仓库与需求身份入队，投递到本工作区所有已连接窗口，首答生效其余撤回，工作区外窗口不收到；无窗口时保留，新窗口连接后立即推送、不丢不重；补充由主会话判断归属后转发并回执；完成、阻塞、自动恢复、契约变更请求等通知走同一通道；需求代理之间不得直接互发。
- workspace-coordination：契约变更请求经中继提交主会话裁定，裁定后作为补充转发相关需求代理。
- requirement-agent：结束、阻塞或需决策经中继通知。

## 涉及文件
- 新建：`daemon/relay-queue.ts`
- 新建：`tests/relay-queue.test.ts`

## 成品定义

`relay/questions.jsonl` 每行：

```json
{ "id": "<uuid>", "requirement": "<reqId>", "repoId": "…", "runId": "…", "question": "…", "options": [ { "label": "…", "description": "…" } ], "recommended": "…", "createdAt": "<UTC>", "status": "pending|answered|withdrawn", "answer": "…", "answeredBy": "<windowId>", "answeredAt": "<UTC>" }
```

`relay/notices.jsonl` 每行：

```json
{ "id": "<uuid>", "requirement": "<reqId>", "repoId": "…", "runId": "…", "kind": "completed|blocked|auto_resumed|stopped|interrupted|contract_change", "message": "…", "createdAt": "<UTC>", "deliveredTo": ["<windowId>"] }
```

## 函数清单
### daemon/relay-queue.ts
| 函数 | 职责 |
|---|---|
| `RelayQueue.ask` | 经 store 持久化问题，经注入的投递函数广播（投递函数由 run-manager 按仓库筛选当前活跃客户端并返回实际送达的窗口标识；单窗口失败不影响其它窗口，也不使入队失败），返回可等待答复的句柄；句柄在作答时兑现答案、在撤回时以"已撤回"结果兑现，永不永挂 |
| `RelayQueue.answer` | 接受首个答复、标记已答、唤醒等待方，向其余窗口发撤回；重复答复返回已答（并发作答亦然：内存状态在落盘前抢占以保证门禁原子，落盘失败回滚到旧记录并使句柄 reject；已知取舍：并发作答且落盘失败时，败方已被告知已答而问题回到待答、句柄已 reject，问题不丢失且未广播撤回；`markDelivered` 的回滚只撤销本次窗口自己的回执，不还原整条快照，以免抹掉并发另一方已抢占的回执） |
| `RelayQueue.notify` | 持久化通知并广播到本工作区在线窗口，`deliveredTo` 只记实际送达的窗口；广播时不携带 deliveredTo/status 等内部字段；产生时已有窗口送达即视为已中继，只有当时无任何在线窗口的通知才进入后来窗口的积压 |
| `RelayQueue.pendingFor` | 纯查询：按窗口的仓库集合列出未答问题与（产生时无在线窗口且未投递到本窗口的）通知，按 createdAt 顺序；不登记连接（连接由守护进程 hello/断开维护） |
| `RelayQueue.markDelivered` | 记录通知已投递到某窗口，避免重复推送 |
| `RelayQueue.forward` | 把补充消息交给注入的需求代理定位函数注入，返回回执；注入抛错时回执 `{ delivered:false, reason }` 而非抛出 |
| `RelayQueue.withdraw` | 撤回问题（作答或运行停止时） |
| `RelayQueue.subscribe` | 供调用方订阅入队与状态变化；监听器异常逐个隔离 |

## 协作关系
本单元只暴露 `RelayQueue` 类，不触碰 `daemon/server.ts`：投递函数 `deliver(event, payload, { repoId, excludeWindowId? }) → Promise<string[]>`（按仓库筛选当前活跃客户端、发送事件帧并返回实际送达的窗口标识）与需求代理定位函数由 `daemon/run-manager.ts` 在构造时注入，队列自身不持有任何连接状态；`relay.answer` / `relay.forward` 方法与 `hello` 后的 `pendingFor` 推送也由 run-manager 的协议处理器接入。`daemon/requirement-agent.ts` 的 `pi_company_ask` 调用 `ask` 并等待；run-manager 在完成、阻塞、自动续接、停止、中断时调用 `notify`。持久化经 `runtime/store.ts` 的 `appendLine`（目录锁、fsync、0600）；读取经 store 新增的容错入口 `readLinesLenient(path) → { records, skipped }`（损坏行与行中空行跳过并计数，文件末尾结尾换行不计，非 ENOENT 的读失败抛出），队列把跳过计数经 `subscribe` 的 `corrupt_skipped` 事件上报，不静默。

## 验证方式
- 测试入口：`RelayQueue` 方法，注入记录投递调用的窗口桩（两个本工作区窗口、一个声明不同工作区的窗口）与需求代理定位桩；临时数据目录
- 测试输入：三个窗口在线时提问，从其中一个作答，另一个再次作答；所有窗口离线时提问并产生完成通知，再登记新窗口调用 `pendingFor` 与 `markDelivered`；转发一条补充到有活动需求代理的需求与一条到不存在需求；用同一数据目录重建 `RelayQueue` 后查询未答问题
- 预期结果：只有两个本工作区窗口收到问题投递（投递桩收到 `{ repoId }` 目标而非窗口列表，返回送达的窗口标识）；作答后其余窗口收到撤回，第二次作答返回已答；投递桩对某窗口抛错时其余窗口仍送达、入队成功、deliveredTo 只含送达者；新窗口的 `pendingFor` 恰返回一条问题与一条通知（均产生于无在线窗口时）且顺序与产生顺序一致，`markDelivered` 后再次查询不再包含该通知；产生时已有窗口在线并送达的通知不进入后来窗口的积压；作答后的问题不再出现在 pendingFor；转发到活动需求返回已投递，到不存在需求返回原因，注入抛错返回 delivered:false；withdraw 后等待方句柄以已撤回兑现且各窗口收到撤回；重建后未答问题仍为 pending 且可继续作答、deliveredTo 保留；损坏行被跳过并经事件上报计数；监听器抛错不影响其它监听器与调用方
- [ ] 投递范围
- [ ] 首答生效与撤回
- [ ] 离线排队与推送不重不漏
- [ ] 转发回执
- [ ] 持久化跨重启
