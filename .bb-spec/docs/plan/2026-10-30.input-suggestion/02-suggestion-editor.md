---
name: suggestion-editor
description: 继承 pi 的 CustomEditor，空输入栏时画灰色提示，空输入栏按右方向键填入完整提示
---
# 带灰色提示的主会话输入栏

## 目标
一个可替换 pi 主会话输入栏的组件：外面交给它一句输入建议，它在输入栏为空时显示成灰色，按右方向键时填进去。

## 业务规则（来源：PRD show-and-fill）
- 显示条件：有输入建议且输入栏没有任何字 → 输入栏内容行显示灰色提示；第一个字按 pi 光标的样子显示（反色），后面的字是灰色。
- 没有输入建议时，画面和 pi 原来的输入栏完全一样。
- 输入栏有任何字 → 不显示提示，也不改动输入栏里的字。从有字变回没字 → 提示重新出现，直到外面把建议清掉。
- 右方向键：输入栏为空且有建议 → 输入栏真实文字变成完整建议，光标在末尾，不发送；输入栏为空且没有建议 → 交给 pi 原来的处理；输入栏有字 → 交给 pi 原来的处理（移动光标）。
- 太长时截断：提示宽度超出输入栏一行能放的宽度 → 显示时截断并以"…"结尾，整行不超出终端宽度；填入的仍是完整建议。
- 其他按键一律交给 pi 原来的 `CustomEditor` 处理，行为不变。
- 设置或清掉建议后要请求重画，让画面马上更新。
- 界面依据：用户 2026-10-30 确认过的预览——等待时输入栏和平常一样是空的；提示出现时光标停在第一个字上，后面灰色。

## 涉及文件
- `src/modules/input-suggestion/suggestion-editor.ts` 新建

## 函数清单
### src/modules/input-suggestion/suggestion-editor.ts
| 函数名 | 职责 |
|---|---|
| `SuggestionEditor`（类，继承 pi-coding-agent 导出的 `CustomEditor`） | 主会话输入栏组件，保存当前输入建议 |
| `SuggestionEditor.setSuggestion` | 设置或清掉当前输入建议，并请求重画 |
| `SuggestionEditor.render` | 输入栏为空且有建议时，把父类画出的内容行换成"光标样式的第一个字 + 灰色的其余部分"，按宽度截断；其余情况直接用父类结果 |
| `SuggestionEditor.handleInput` | 输入栏为空且有建议时，右方向键把完整建议设成输入栏文字；其余按键交给父类 |

## 协作关系
- 父类：`CustomEditor`（`@earendil-works/pi-coding-agent`），它继承 pi-tui 的 `Editor`，提供 `getText`、`setText`、`render`、`handleInput`。
- 判断右方向键用 pi-tui 的 `matchesKey(data, "right")`，算显示宽度、截断用 pi-tui 的 `visibleWidth`、`truncateToWidth`（状态面板 `src/modules/panel/pm-panel.ts` 已在用）。
- 灰色用 pi 主题的 dim 颜色，由创建方（plan input-suggestion-extension）把上色函数传进来。
- 本模块不引用 `src/modules/` 下的其他模块。

## 验证方式
- 测试入口：从 `src/modules/input-suggestion/suggestion-editor.ts` 导入 `SuggestionEditor`，用测试里的假 TUI（提供 `terminal.rows`、`requestRender`）、pi-tui 的编辑器主题和 pi-coding-agent 的 `KeybindingsManager` 创建；调用 `setSuggestion`、`handleInput`、`render`、`getText`。
- 测试输入：建议文字"可以，按这个预览写 PRD"、60 个汉字的长建议；按键字符串：右方向键 `"\u001b[C"`、普通字符、退格 `"\u007f"`；渲染宽度 80 和 20。
- 预期结果：
- [ ] 没设建议时，`render(80)` 的结果和同参数创建的普通 `CustomEditor` 一样。
- [ ] 设了建议、输入栏为空时，`render(80)` 的内容行含建议文字，第一个字带反色样式，其余部分带传入的 dim 上色。
- [ ] 输入一个字后 `render` 不含建议文字，`getText()` 只有这个字；退格删空后 `render` 又含建议文字。
- [ ] 输入栏为空、有建议时按右方向键 → `getText()` 等于完整建议；之后 `render` 里光标在末尾；没有触发提交回调 `onSubmit`。
- [ ] 输入栏为空、没有建议时按右方向键 → `getText()` 仍为空。
- [ ] 输入栏为"ab"、光标在开头时按右方向键 → `getText()` 仍为"ab"，光标右移一格。
- [ ] 60 个汉字的建议在宽度 20 下渲染 → 内容行可见宽度不超过 20，以"…"结尾；按右方向键后 `getText()` 是完整的 60 个字。
- [ ] `setSuggestion(undefined)` 后空输入栏的 `render` 不含旧建议；`setSuggestion` 每次调用都请求了一次重画。
