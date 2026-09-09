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
| `relayExtension` | 默认导出 `(pi, deps?)`（pi 加载器单参调用，`deps.windowReady` 供测试注入，缺省取 lifecycle 真实实现；测试不得 mock 模块）：注册自定义消息渲染器；`session_start` 处理器不 await 窗口启动（宿主对各扩展的 session_start 串行 await，await 会与 lifecycle 互相等待而死锁），而是 `windowReady().then(ctx => registerRelayInbox(pi, ctx.clients, ctx.sessionId))` 异步续接，拒绝分支 notify 一次不抛；`session_shutdown` 处理器不阻塞等待注册完成（`pendingCancel?.then(c => c(), () => {})`），reason 非 reload 时回收该会话集合，reload 时保留 currentSessionId；跳过的畸形载荷（积压逐条校验失败、整批非数组、注入抛出、实时事件校验失败）经 `registerRelayInbox` 的 `onSkipped(count)` 回调上报，`relayExtension` 用 `ctx.ui.notify` 聚合提示（不进模型上下文、不触发回合）：积压注册结束时报一次，实时路径按每会话最多每分钟一次节流；无畸形时不提示 |
| `registerRelayInbox` | `(pi, clients, sessionId)`：先拉取积压再建立订阅（加载期到达的实时事件缓冲到积压之后冲刷）；每条注入各自 try/catch（畸形条目只跳过自己，不连坐其后条目与缓冲事件），缓冲冲刷同样受保护，取消函数无条件返回；测试入口 |
| `pullPending` | 调用每个仓库连接的 `relay.pending`，按产生顺序逐条注入，记录已注入的问题标识防重复 |
| `injectQuestion` | 用自定义消息把问题（需求、问题文本、选项、推荐、问题标识）注入主会话并触发回合 |
| `injectNotice` | 用自定义消息注入通知（完成、阻塞、自动恢复、契约变更请求），触发回合 |
| `handleWithdraw` | 收到撤回事件时追加一条"该问题已在其他窗口作答"的自定义消息，并标记本地已撤回 |
| `renderRelayMessage` | 自定义消息渲染：一行标题 + 正文，待答问题带问题标识 |
| `seenIds` | 按 `sessionId` 键控的已注入集合（问题与通知均按 `id` 去重）：同一会话（含 reload）不重复注入，新会话（/new、fork、resume 到别的会话）重新投递仍未作答的积压；身份键用载荷原始 `id`（不经净化），注入调用即记入；`session_shutdown` 的 reason 非 reload 时删除该会话的集合；撤回单独记 `withdrawnIds`（同样按会话键控、原始 id），重复撤回不再追加说明，未注入过的问题被撤回不追加孤儿说明 |
| `sanitizeRelayText` | 展示单一出口：拼进 content/渲染的每一个外来字段（question、options 的 label/description、recommended、id、kind、message、questionId）都经它处理——剥离 C0/C1 控制字符与 ESC/CSI/OSC 序列（保留换行）、剥离 bidi 与零宽字符（U+200B–200F、U+202A–202E、U+2066–2069、U+FEFF），按码点截断到上限；只用于展示，不用于身份匹配；details 中回传给主会话的 id 为原始值 |
| `untrustedBlock` | 分隔行带每条消息随机 nonce（`--- 外部文本开始 <nonce> ---` / `--- 外部文本结束 <nonce> ---`），nonce 是唯一防伪造控制，不另做同形行转义 |

## 协作关系
- 依赖 `runtime/daemon-client.ts` 的 `WorkspaceClients.subscribe`（`relay.question`、`relay.notice`、`relay.withdraw`）与 `call("relay.pending")`。
- 注入用 `pi.sendMessage` 自定义类型 `pi-company-relay`，`deliverAs: "steer"`，`triggerTurn: true`；问题 `display: true`，通知 `display: false`（通知只进主会话上下文，由主会话决定如何告知用户，聊天区不逐条铺开内部通知）；外来文本以固定分隔块包裹并标注为不可信数据后再拼入 content。渲染用 `registerMessageRenderer`。
- 载荷形状：`relay.pending` 返回 `{ questions: RelayQuestion[], notices: RelayNotice[] }`，问题字段 `id/requirement/repoId/runId/question/options/recommended/createdAt`，通知字段 `id/requirement/repoId/runId/kind/message/createdAt`（与 26 relay-queue 成品一致）；缺 `id`、必需文本字段、`options` 非数组、options 元素缺 label/description 字符串、`recommended`/`kind` 非字符串或 `createdAt` 非字符串的条目跳过，不影响其它条目。
- 主会话作答用 `extensions/dispatch.ts` 的 `pi_company_reply`；本模块不实现作答。
- 守护进程重启或仓库首连失败后重连时，由 26 relay-queue 在窗口 `hello` 后推送该窗口未收到的积压（事件形状同实时事件），本模块靠 `seenIds` 幂等；不在 daemon-client 加重连钩子。

## 验证方式
- 测试入口：`registerRelayInbox`（假 pi：收集 `sendMessage` 调用与注册的渲染器；假 `WorkspaceClients` 可发事件与返回积压）；`relayExtension` 只断言单参契约（`length === 1`、以假 pi 调用不抛、注册了 session_start/session_shutdown 处理器）。
- 测试输入：积压两条问题一条通知；实时一条问题；同一问题重复推送；撤回事件；重连后再次 `pullPending`。
- 预期结果：
  - `session_start` 后按产生顺序注入三条消息，各恰一次，均带 `triggerTurn`。
  - 实时问题立即注入；重复推送不重复注入；同一 sessionId 重复注册后已注入的问题与通知都不再注入，换 sessionId 后仍未作答的积压重新注入；加载期先到的实时事件排在积压之后；重复撤回只追加一条说明，未注入过的问题被撤回不追加说明；取消函数调用后事件不再注入；options/recommended/id/kind/message 任一字段含 ESC/OSC/bidi/零宽字符时注入与渲染输出均不含；超长文本按码点截断不留孤立代理；载荷中与分隔行同形的行不能闭合分隔块（content 中只有 nonce 分隔行成对出现）；options 非数组的条目被跳过且其后条目与实时事件照常注入、取消函数仍返回。
  - 撤回后追加一条说明消息，不删除已注入内容。
  - 渲染器对问题输出标题行、正文与问题标识（正向断言含标识行），通知消息 `display: false`。
- [ ] 积压顺序与幂等
- [ ] 实时注入与触发回合
- [ ] 撤回说明
- [ ] 渲染内容
