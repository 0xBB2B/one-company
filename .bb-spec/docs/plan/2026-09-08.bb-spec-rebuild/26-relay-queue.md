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
| `RelayQueue.ask` | 持久化问题并经注入的投递函数向本工作区已连接窗口广播，返回可等待答复的句柄 |
| `RelayQueue.answer` | 接受首个答复、标记已答、唤醒等待方，向其余窗口发撤回；重复答复返回已答 |
| `RelayQueue.notify` | 持久化通知并广播到本工作区窗口，记录已投递窗口 |
| `RelayQueue.pendingFor` | 按窗口的工作区与仓库集合列出未答问题与未投递通知 |
| `RelayQueue.markDelivered` | 记录通知已投递到某窗口，避免重复推送 |
| `RelayQueue.forward` | 把补充消息交给注入的需求代理定位函数注入，返回回执 |
| `RelayQueue.withdraw` | 撤回问题（作答或运行停止时） |
| `RelayQueue.subscribe` | 供调用方订阅入队与状态变化 |

## 协作关系
本单元只暴露 `RelayQueue` 类，不触碰 `daemon/server.ts`：投递函数（按工作区与仓库集合筛选客户端并发送事件帧）与需求代理定位函数由 `daemon/run-manager.ts` 在构造时注入，`relay.answer` / `relay.forward` 方法与 `hello` 后的 `pendingFor` 推送也由 run-manager 的协议处理器接入。`daemon/requirement-agent.ts` 的 `pi_company_ask` 调用 `ask` 并等待；run-manager 在完成、阻塞、自动续接、停止、中断时调用 `notify`。持久化经 `runtime/store.ts`。

## 验证方式
- 测试入口：`RelayQueue` 方法，注入记录投递调用的窗口桩（两个本工作区窗口、一个声明不同工作区的窗口）与需求代理定位桩；临时数据目录
- 测试输入：三个窗口在线时提问，从其中一个作答，另一个再次作答；所有窗口离线时提问并产生完成通知，再登记新窗口调用 `pendingFor` 与 `markDelivered`；转发一条补充到有活动需求代理的需求与一条到不存在需求；用同一数据目录重建 `RelayQueue` 后查询未答问题
- 预期结果：只有两个本工作区窗口收到问题投递，作答后另一窗口收到撤回，第二次作答返回已答；新窗口的 `pendingFor` 恰返回一条问题与一条通知且顺序与产生顺序一致，`markDelivered` 后再次查询不再包含该通知；转发到活动需求返回已投递，到不存在需求返回原因；重建后未答问题仍为 pending 且可继续作答
- [ ] 投递范围
- [ ] 首答生效与撤回
- [ ] 离线排队与推送不重不漏
- [ ] 转发回执
- [ ] 持久化跨重启
