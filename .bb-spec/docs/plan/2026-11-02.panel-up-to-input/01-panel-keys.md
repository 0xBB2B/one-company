---
name: panel-keys
description: 状态面板第一行按 ↑ 回输入框，面板里按 Esc 无反应，底部提示换成新文字
---
# 面板按键：↑ 回输入框，Esc 无反应

## 目标
焦点在状态面板时，用 ↑ 从第一行回到输入框；按 Esc 不会传给 pi，不会中断主代理。

## 业务规则（来源：PRD 子文档 up-to-input）
- 状态面板是输入框下方显示运行中任务的区域。焦点是按键当前由谁接收。第一行是能选中的行里最上面的一行。
- 焦点在面板、光标在第一行时按 ↑：焦点回输入框；按键被消费，输入框内容不变，不翻输入历史。
- 焦点在面板、光标不在第一行时按 ↑：光标上移一行，焦点留在面板。
- 焦点在面板、有能选中的行时按 Esc：焦点和光标不变，按键被消费，不交给 pi。
- 焦点在面板、没有能选中的行时：按 Esc 焦点回输入框，按键被消费；按其他键焦点回输入框，按键不消费、交给输入框。
- 焦点在输入框时按 Esc：不消费，交给 pi，和原来一样。
- 程序窗口开着（输入框没有焦点）时，面板不处理任何键。窗口关闭后焦点仍在面板，Esc 按上面的规则处理。
- 底部提示改为"↑↓ 选择 · Enter 查看 · p 暂停/恢复 · 第一行按 ↑ 返回输入框"。
- 用 ↑ 回到输入框后，输入框为空时按 ↓ 能再次进入面板。
- 决策理由：把 Esc 交给 pi 会让面板里一按就中断主代理，所以 Esc 必须被吃掉；↑ 只在第一行回输入框，否则光标下移后选不回上面的行。

## 涉及文件
- `src/core/host/dock.ts` — 修改
- `src/modules/panel/pm-panel.ts` — 修改
- `tests/bottom-dock.test.ts` — 修改（原有两条"Esc 返回输入栏"的测试按新行为改写，假面板补 `atFirstRow`）
- `tests/pm-panel.test.ts` — 修改（5 处提示文字断言）

## 函数清单
### src/core/host/dock.ts
| 函数名 | 职责 |
|---|---|
| `DockPanel.atFirstRow`（接口新增） | 让 dock 知道光标是否在第一行 |
| `BottomDock.handleKey` | 面板分支：无行时回输入框，Esc 被消费、其他键放行；Esc 有行时消费且不动焦点；↑ 且在第一行时回输入框并消费；其余交给面板 |
### src/modules/panel/pm-panel.ts
| 函数名 | 职责 |
|---|---|
| `HINT`（常量） | 换成新提示文字 |
| `PmPanel.atFirstRow` | 光标在第一行时返回真 |

## 协作关系
`BottomDock.handleKey` 调 `DockPanel.hasRows`、`atFirstRow`、`handleInput`。`pm-panel-extension.ts` 把 `PmPanel` 作为 `panel` 传给 `BottomDock`，这部分不用改。

## 验证方式
- 测试入口：`new BottomDock({ panel, getEditorText, isCompletionOpen, isEditorFocused })` 的 `handleKey(data)`、`focus()`；`panel` 是实现了 `hasRows()`、`atFirstRow()`、`handleInput(data)` 的对象，也可用真实 `PmPanel`。`PmPanel` 的 `render(width)`、`handleInput`、`focus()`。
- 测试输入：按键序列 ↑ `\x1b[A`、↓ `\x1b[B`、Esc `\x1b`、Kitty Esc `\x1b[27u`、Kitty ↑ `\x1b[1;1:1A`、Ctrl+C `\x03`，以及按键抬起事件。
- 预期结果：`handleKey` 返回 `{ consume: true }` 或 `undefined`，`focus()` 返回 `"panel"` 或 `"editor"`，按下面逐项判断。
- [ ] AC-1：只有一行、焦点在面板，按 ↑（两种编码）→ 消费，焦点 `editor`；按键抬起事件不触发。
- [ ] AC-2：真实 `PmPanel` 三行可选，光标第 3 行，↑ 两次光标到第 1 行、焦点一直在 `panel`；第 3 次 ↑ 焦点 `editor`。
- [ ] AC-3：有行、焦点在面板，Esc 3 次（两种编码）→ 每次都消费，焦点 `panel`，`panel.handleInput` 没收到 Esc。
- [ ] AC-4：焦点在面板后面板变空，Esc → 消费、焦点 `editor`；另一次同样场景 Ctrl+C → 不消费、焦点 `editor`。
- [ ] AC-5：焦点在 `editor` 按 Esc → 不消费，`panel.handleInput` 没被调用。
- [ ] AC-6：`isEditorFocused` 为假时，↑、Esc 都返回 `undefined` 且焦点不变；变回真后 Esc 消费、焦点 `panel`。
- [ ] AC-7：`focus()` 后 `render(200).at(-1)` 等于新提示文字；`blur()` 后没有这一行。
- [ ] AC-8：↓ 进入、↑ 回输入框、再 ↓ → 焦点 `panel`。
