---
name: input-suggestion-extension
description: 把输入建议接到 pi 主窗口：替换输入栏、每轮正常结束后生成、新一轮开始时清掉并丢弃旧结果
---
# 输入建议接入主窗口

## 目标
pi 交互窗口里，主代理每轮正常结束后自动生成输入建议并显示在主会话输入栏；用户发消息或新一轮开始时清掉。

## 业务规则（来源：PRD generate-suggestion、show-and-fill）
- 只在交互模式：`ctx.mode === "tui"` 且 `ctx.hasUI` 时才替换主会话输入栏、才生成；打印、RPC、json 模式什么都不做。
- 会话开始（`session_start`）时用 `ctx.ui.setEditorComponent` 换上 `SuggestionEditor`，灰色用 `ctx.ui.theme` 的 dim 颜色。
- 生成时机：`agent_settled` 事件且 `aborted` 为假，而且会话分支里最后一条主代理回复的 stopReason 是 stop → 调一次 `requestSuggestion`。被 Esc 打断（aborted 为真）或最后一条回复出错 → 不调用。
- 清掉：用户发出消息（`input` 事件）或主代理开始新一轮（`agent_start` 事件）→ 输入栏的建议清掉，正在进行的生成调用中止，它之后返回的结果丢掉。
- 结果只认最新一次：生成返回时，如果这期间已经清掉过，结果丢掉；否则交给输入栏的 `setSuggestion`。输入栏里有字时是否显示由输入栏自己判断（有字不显示、删空再显示）。
- 新会话（再一次 `session_start`）或 `session_shutdown`：中止进行中的调用，丢掉旧会话的结果。
- 不进对话记录：不调用 `pi.sendMessage`、`pi.appendEntry`，不改主代理上下文。
- 填入后用户按 Enter 发出的话按用户原话处理，本扩展不拦截 `input` 事件、不改写内容（用户 2026-10-30 决定）。
- 已知代价：别的扩展也调用 `setEditorComponent` 时只有一个生效，本扩展不检测（用户 2026-10-30 同意）。

## 涉及文件
- `src/modules/input-suggestion/input-suggestion-extension.ts` 新建
- `src/app/extension/index.ts` 修改：导入并在 `registerExtensions` 里调用 `inputSuggestionExtension(pi)`

## 函数清单
### src/modules/input-suggestion/input-suggestion-extension.ts
| 函数名 | 职责 |
|---|---|
| `inputSuggestionExtension`（默认导出） | 注册 `session_start`、`input`、`agent_start`、`agent_settled`、`session_shutdown` 监听，管理当前输入栏实例、进行中的调用和"第几次清掉"的计数 |

## 协作关系
- `session_start` → `ctx.ui.setEditorComponent` 的工厂里创建 `SuggestionEditor`（plan suggestion-editor），记下这个实例。
- `agent_settled` → 用 `ctx.sessionManager.getBranch()` 交给 `recentRounds`，再连同 `ctx.model`、`ctx.modelRegistry` 和一个可中止的 signal 交给 `requestSuggestion`（plan suggestion-model）→ 结果仍有效时调 `SuggestionEditor.setSuggestion`。
- `input`、`agent_start` → `setSuggestion(undefined)` + 中止进行中的调用；`input` 监听返回 `{ action: "continue" }`。
- 写法参照 `src/modules/panel/pm-panel-extension.ts`：`session_start` 里先检查 `ctx.mode`、`ctx.hasUI`，用递增的代号丢弃过期会话的异步结果。

## 验证方式
- 测试入口：`src/modules/input-suggestion/input-suggestion-extension.ts` 的默认导出，传入测试里的假 `ExtensionAPI`（记录 `on` 注册的监听，能手动触发事件；记录 `sendMessage`、`appendEntry` 调用）和假 `ExtensionContext`（`mode`、`hasUI`、`ui.setEditorComponent`、`ui.theme`、`sessionManager.getBranch`、`model`、`modelRegistry`）。假模型登记表能控制何时返回、返回什么。另跑 `tests/module-dependencies.test.ts` 和 `tests/extension-entry.test.ts`。
- 测试输入：一段含 2 轮的会话分支；模型返回"可以，按这个预览写 PRD"。
- 预期结果：
- [ ] `mode: "tui"`、`hasUI: true` 时 `session_start` 调用了 `setEditorComponent`，工厂产出 `SuggestionEditor`；`mode` 为 `print`、`rpc`、`json` 时没调用，之后触发 `agent_settled` 也不调用模型。
- [ ] 触发 `agent_settled`（aborted 为假、最后一条回复 stopReason 为 stop）→ 模型被调用一次；返回后输入栏实例空输入时的 `render` 含这句建议。
- [ ] `agent_settled` 的 aborted 为真，或最后一条回复 stopReason 为 error → 模型没被调用。
- [ ] 模型返回前触发 `input` → 传给模型的 signal 已中止；之后模型仍返回结果 → 输入栏没有建议。
- [ ] 建议显示中触发 `input` 或 `agent_start` → 输入栏不再含建议文字。
- [ ] 模型返回前用户已在输入栏打字 → 返回后 `getText()` 仍是用户打的字；删空后 `render` 含建议。
- [ ] 整个过程 `sendMessage`、`appendEntry` 没被调用；`input` 监听返回 `{ action: "continue" }`。
- [ ] `tests/module-dependencies.test.ts`、`tests/extension-entry.test.ts` 通过。
