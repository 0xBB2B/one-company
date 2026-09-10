---
name: transcript-view
description: 会话记录查看页：替换输入栏，实时显示思考、输出与工具活动，跟随/滚动，离线回读，只读原样展示，Esc 回面板
---
# 会话记录查看页

## 目标
用户从面板打开任一需求代理或角色的会话，实时看到它在想什么、输出什么，会话结束或守护进程不可达时仍能回读。

## 业务规则（来源：spec）
- transcript-view：在面板条目上选择查看并按 Enter 后，在输入栏位置打开查看页，保持底部其他区块顺序，不用浮层或全屏页；Esc 返回面板并恢复原选中位置。
- transcript-view：按时间顺序实时显示思考、输出、工具调用与结果摘要，默认跟随最新；滚动后停止跟随，回到底部恢复。
- transcript-view：会话已结束或守护进程不可达时显示本机保存的记录并标明状态，不显示为运行中。
- transcript-view：页面只读，不提供输入或控制入口，内容原样展示不作改写。

## 涉及文件
- 新建 `runtime/transcript-view.ts`
- 修改 `extensions/agents-ui.ts`（接入打开入口）
- 新建 `tests/transcript-view.test.ts`

## 函数清单
### runtime/transcript-view.ts
| 函数名 | 职责 |
|---|---|
| `TranscriptView` | TUI 组件：维护条目列表、视口、跟随标志与状态标签；折行按显示列自行切分（拼接结果等于原文，不混入 ANSI 复位序列，宽度 1 不退化）；`\r\n` 归一为 `\n`、裸 `\r` 剥除、`\t` 展开为空格，其余 C0/C1/ESC 剥离；视口宽高取自宿主 tui 实际尺寸并随之更新，滚动计算与渲染共用同一宽度；折行结果按（宽度，条目版本）缓存；数据到达与状态变化后经宿主 `requestRender` 重绘 |
| `TranscriptView.appendDelta` | 处理思考增量、文本增量、工具调用开始/结束事件并合并为条目 |
| `TranscriptView.loadFromRecord` | 从本机会话记录读取历史条目填充 |
| `TranscriptView.handleInput` | ↑↓、PgUp/PgDn 翻页、End 恢复跟随，Esc 关闭；其他按键无效不消费；Kitty 释放事件丢弃 |
| `TranscriptView.setStatus` | 标记运行中 / 已结束 / 不可达 |
| `openTranscriptView` | 用 `ctx.ui.custom` 替换输入栏打开页面：先加载记录（读取失败时标"记录不可读"并 notify，不显示为运行中），本地记录已标 ended 时直接标已结束、不订阅也不轮询（已结束是终态，不被不可达覆盖）；未结束才订阅 `subscribe.transcript`（实时事件按 runId 过滤，与本地记录按 seq 去重合并，合并后请求重绘），订阅结果 ended 为 true 时标已结束并停止轮询；仅未结束会话在订阅被拒或每秒轮询 `client.state()` 变为 unreachable 时标不可达并保留内容；`openRunIds` 登记与读记录同在 try 内，读记录抛出按不可读处理并释放登记；工厂接住宿主 `tui`：构造时传入，尺寸只有一处真相——宽度取 render 传入的插槽宽度，高度上限取 `tui.terminal.rows` 折算的预算：渲染总行数（含末尾状态行）= min(自然行数, max(5, ⌊终端行数/2⌋))，内容不足不补齐，不占满整屏、不挤掉状态栏与 Agents；`resize()` 只保留测试夹具需要的最小形态或删除；`requestClose` 幂等；滚动与渲染共用同一宽度来源、增量到达经 `tui.requestRender()` 立即重绘；关闭带 `closed` 令牌：订阅兑现晚于关闭时立即释放而不建立监听，`subscriptionId` 有值才发 `unsubscribe` 且失败不抛；`markPageClosed`、取消订阅、交还选中位置全部在 finally；同一时刻只允许一个查看页（以「有页打开」作闸门而非按 runId，鼠标路径同受约束，dock 的开关标志不失衡）；宿主 teardown（session_shutdown / 重新 session_start）时主动关闭在途查看页并释放登记；选中位置以 runId 表达，经面板的 `selectedRunId()`/`selectRun(runId)` 保存与恢复（行已消失时夹到最近合法行） |

## 协作关系
- 依赖 `runtime/daemon-client.ts`（`subscribe.transcript` / `unsubscribe` / `state()`）、`runtime/session-records.ts`（`readTranscript`）、`runtime/dock.ts`（返回焦点）、`runtime/agents-panel.ts` 新增的 `selectedRunId()` / `selectRun(runId)`（33/34 交界的小改动，在本单元完成）；`extensions/agents-ui.ts` 的 onView 调用 `openTranscriptView` 并对其拒绝 `ctx.ui.notify`，teardown 时关闭在途查看页；`appendDelta` 只用于未落盘的在途条目，服务端不得对已落盘 seq 重放 delta（plan 25 侧钉死）。
- 由 `runtime/agents-panel.ts` 的查看按钮触发；与面板共享选中位置。

## 验证方式
- 测试入口：`TranscriptView`（用 `tests/helpers/virtual-terminal.ts` 渲染，注入假订阅与临时会话记录文件）、`openTranscriptView`（假 `ctx.ui.custom` 捕获组件）。
- 测试输入：含思考、文本、两次工具调用的增量序列；含测试凭据与独立标记文本的工具结果；已结束运行的记录文件；订阅中断事件；按键序列（↑×3、PgUp、End、Esc）。
- 预期结果：
  - 条目按时间顺序显示，思考与输出可区分；打开时视口在底部并跟随；↑ 后新增内容不移动视口，End 后恢复跟随，PgDn 向下翻页；折行后各行拼接等于原文且输出不含 ESC；含 `\r`/`\t` 的输入渲染宽度不超过终端宽度；实时事件经订阅回调进入页面，其它 runId 的事件被忽略，与本地记录 seq 重叠的条目不重复。
  - 凭据与标记文本在渲染输出中原样出现；输入字符不产生任何变化。
  - 已结束运行显示记录并标"已结束"（本地记录 ended 时不发起订阅与轮询；订阅被拒或连接断开都不改写已结束）；未结束运行打开后 client.state() 变为 unreachable 时轮询一次 tick 后标"不可达"且保留已显示内容；生产打开路径把宿主 tui 传入视图（rows=10 时渲染不超过 5 行、rows=40 时不超过 20 行且短内容按自然行数、增量到达调用 requestRender；Esc 后再触发关闭不二次 done）；readTranscript 抛出时标不可读且再次打开同一 runId 仍可打开；两页并发打开被拒且 dock 页标志在唯一页关闭后才复位；teardown 关闭在途查看页；readTranscript 返回 missing/corrupt 时标"记录不可读"且 notify，不显示运行中。
  - Esc 后 `custom` 的 done 被调用且面板经 selectRun 收到原选中的 runId（该行已移出时选中夹到最近行）；Esc 早于订阅兑现时不建立实时监听、不发非法 unsubscribe、restoreSelection 仍执行；custom 拒绝时 markPageClosed 仍执行；同一 runId 二次打开被忽略；每行宽度 ≤ 终端宽度。
- [x] 顺序、跟随与滚动
- [x] 只读与原样展示
- [x] 结束与不可达标注
- [x] 打开与返回焦点
