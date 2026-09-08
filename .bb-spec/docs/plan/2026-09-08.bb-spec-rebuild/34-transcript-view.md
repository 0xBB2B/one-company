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
| `TranscriptView` | TUI 组件：维护条目列表、视口、跟随标志与状态标签，按宽度折行渲染 |
| `TranscriptView.appendDelta` | 处理思考增量、文本增量、工具调用开始/结束事件并合并为条目 |
| `TranscriptView.loadFromRecord` | 从本机会话记录读取历史条目填充 |
| `TranscriptView.handleInput` | ↑↓、翻页滚动与跟随切换，Esc 关闭；其他按键无效 |
| `TranscriptView.setStatus` | 标记运行中 / 已结束 / 不可达 |
| `openTranscriptView` | 用 `ctx.ui.custom` 替换输入栏打开页面：先加载记录，再订阅 `subscribe.transcript`，关闭时取消订阅并把面板选中位置交还 |

## 协作关系
- 依赖 `runtime/daemon-client.ts`（`subscribe.transcript` / `unsubscribe`）、`runtime/session-records.ts`（`readTranscript`）、`runtime/dock.ts`（返回焦点）。
- 由 `runtime/agents-panel.ts` 的查看按钮触发；与面板共享选中位置。

## 验证方式
- 测试入口：`TranscriptView`（用 `tests/helpers/virtual-terminal.ts` 渲染，注入假订阅与临时会话记录文件）、`openTranscriptView`（假 `ctx.ui.custom` 捕获组件）。
- 测试输入：含思考、文本、两次工具调用的增量序列；含测试凭据与独立标记文本的工具结果；已结束运行的记录文件；订阅中断事件；按键序列（↑×3、PgUp、End、Esc）。
- 预期结果：
  - 条目按时间顺序显示，思考与输出可区分；打开时视口在底部并跟随；↑ 后新增内容不移动视口，End 后恢复跟随。
  - 凭据与标记文本在渲染输出中原样出现；输入字符不产生任何变化。
  - 已结束运行显示记录并标"已结束"；订阅中断后标"不可达"且保留已显示内容。
  - Esc 后 `custom` 的 done 被调用且面板收到原选中位置；每行宽度 ≤ 终端宽度。
- [ ] 顺序、跟随与滚动
- [ ] 只读与原样展示
- [ ] 结束与不可达标注
- [ ] 打开与返回焦点
