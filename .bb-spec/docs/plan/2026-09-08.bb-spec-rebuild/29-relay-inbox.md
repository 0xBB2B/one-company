---
name: relay-inbox
description: 窗口中继收件箱：拉取与实时接收需求代理的提问和通知，注入主会话上下文，处理撤回
---
# 中继收件箱

## 目标
需求代理的提问与通知能到达打开的窗口主会话，并在窗口打开时补推离线期间积压的内容；他窗口作答后本窗口撤回。

## 业务规则（来源：spec）
- user-relay：需求代理的问题投递到本工作区所有已连接窗口，由主会话向用户展示；首个答复送达后其余窗口撤回；工作区外窗口不收到。
- user-relay：没有窗口连接时问题与通知排队；下一个本工作区窗口连接后立即推送给其主会话，不丢失、不重复。
- user-relay：完成、阻塞、自动恢复、契约变更请求等通知走同一通道；通知不需要答复；面板只显示待答标记，不提供对话入口。
- cross-window-panel：聊天区不重复展示原始运行结果与内部通知，主会话仍取得完整结果与中继通知。

## 涉及文件
- 新建 `extensions/relay.ts`
- 新建 `tests/relay-inbox.test.ts`

## 函数清单
### extensions/relay.ts
| 函数名 | 职责 |
|---|---|
| `relayExtension` | 默认导出：注册自定义消息渲染器，在 `session_start` 拉取积压并订阅实时事件 |
| `pullPending` | 调用每个仓库连接的 `relay.pending`，按产生顺序逐条注入，记录已注入的问题标识防重复 |
| `injectQuestion` | 用自定义消息把问题（需求、问题文本、选项、推荐、问题标识）注入主会话并触发回合 |
| `injectNotice` | 用自定义消息注入通知（完成、阻塞、自动恢复、契约变更请求），触发回合 |
| `handleWithdraw` | 收到撤回事件时追加一条"该问题已在其他窗口作答"的自定义消息，并标记本地已撤回 |
| `renderRelayMessage` | 自定义消息渲染：一行标题 + 正文，待答问题带问题标识 |
| `seenQuestionIds` | 会话级已注入集合，避免重连或重复推送导致二次注入 |

## 协作关系
- 依赖 `runtime/daemon-client.ts` 的 `WorkspaceClients.subscribe`（`relay.question`、`relay.notice`、`relay.withdraw`）与 `call("relay.pending")`。
- 注入用 `pi.sendMessage` 自定义类型 `pi-company-relay`，`deliverAs: "steer"`，`triggerTurn: true`；渲染用 `registerMessageRenderer`。
- 主会话作答用 `extensions/dispatch.ts` 的 `pi_company_reply`；本模块不实现作答。
- 重连后由 `daemon-client` 重新触发 `pullPending`（幂等）。

## 验证方式
- 测试入口：`relayExtension`（假 pi：收集 `sendMessage` 调用与注册的渲染器；假 `WorkspaceClients` 可发事件与返回积压）。
- 测试输入：积压两条问题一条通知；实时一条问题；同一问题重复推送；撤回事件；重连后再次 `pullPending`。
- 预期结果：
  - `session_start` 后按产生顺序注入三条消息，各恰一次，均带 `triggerTurn`。
  - 实时问题立即注入；重复推送不重复注入；重连后已注入的不再注入。
  - 撤回后追加一条说明消息，不删除已注入内容。
  - 渲染器对问题输出标题、正文与问题标识，对通知不输出作答提示。
- [ ] 积压顺序与幂等
- [ ] 实时注入与触发回合
- [ ] 撤回说明
- [ ] 渲染内容
