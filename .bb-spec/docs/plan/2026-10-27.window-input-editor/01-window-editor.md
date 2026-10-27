---
name: window-editor
description: 程序窗口的输入行换成 pi 编辑器：折行、换行、移动光标、粘贴折叠、全屏下鼠标定位，长输入不超宽
---
# 程序窗口输入栏换成 pi 编辑器

## 目标
所有程序窗口（`QuestionWindowView`）的输入行都用 pi 自带的 `Editor` 编辑文字，任何长度的输入都不让窗口的行超出终端宽度。

## 业务规则（来源：PRD window-input-editor / input-editor）
- 适用于所有输入行：可输入选项（`writable: true`）和"其他"行（`allowOther`）。"其他"行在没有指定 `otherLabel` 时显示"其他（自己输入）"；`chooseOrWriteWindow` 的 `otherLabel` 改为可不传，不传时用这个默认名字。
- 输入栏显示在输入行下面：第一行以"      › "（6 个空格、›、1 个空格）开头，其余各行以 8 个空格开头；长文字在终端宽度内自动折行，用户插入的换行另起一行。终端宽 36、44、60、80 列时，窗口画出的每一行都不超过终端宽度。
- 光标在输入行上时，输入栏在光标位置显示反色光标块；不在时有字照样显示、没有光标块，没有字不显示输入栏。每个输入行的文字和光标位置各自保留。
- 按键（光标在输入行上）：可见字符插入光标处；Backspace 删前一个字，Delete 删后一个字；←→ 按字移动（可跨行）；Home/End 到当前行头尾；Shift+Enter 和 Ctrl+J 插入换行；回车提交。
- ↑↓ 在输入栏的显示行之间移动；已在第一行按 ↑ 移到上一个选项，已在最后一行按 ↓ 移到下一个选项（没有就不动）；移回输入行时回到上次离开时的光标位置。
- 回车时去掉首尾空白后为空、或超过 `otherMaxLength`，回车不起作用；否则提交去掉首尾空白后的完整原文，中间换行保留。可输入选项提交 `{ choices: [该项名称], other: 文字 }`，"其他"行提交 `{ choices: [], other: 文字 }`。
- 字数按完整原文（粘贴折叠部分按原文算，换行算 1 个字，去掉首尾空白后）计算；超过上限时输入栏最后一行下面显示灰字"超出 N 字，最多 M 字"。
- 一次粘贴超过 10 行或 1000 字时显示为"[paste #序号 +行数 lines]"或"[paste #序号 字数 chars]"，提交时换回原文；小粘贴原样插入（这是 pi 编辑器的现成行为）。
- 光标在输入行上时底部提示是"直接输入 · 回车确认 · Shift+Enter 换行 · ↑↓ 选择 · <原有 Esc 那一段>"；不在时保持现状。
- 按 Esc 时窗口按原有含义处理（有 `escapeChoice` 就以它作答，否则 undefined），不论输入栏里有没有字。
- 全屏模式下鼠标点击某个输入栏的文字区域：光标移到那个输入行，并定位到点击处；点击行尾后面的空白到行尾。

## 涉及文件
- 修改 `src/core/host/question-window.ts`
- 修改 `tests/question-window.test.ts`

## 函数清单
### src/core/host/question-window.ts
| 函数名 | 职责 |
|---|---|
| `QuestionWindowView` 构造选项 | 新增必填的 `tui`（pi `TUI`，编辑器用它请求重画、读终端行数）；每个输入行建一个 `Editor`（`paddingX: 0`），编辑器的 `onSubmit` 不用，回车由窗口处理 |
| `QuestionWindowView.handleInput` | Esc 先按窗口含义处理；光标在输入行上时：回车按上面规则提交；↑ 在编辑器第一显示行、↓ 在最后显示行时换选项；其余按键交给该行编辑器 |
| `QuestionWindowView.render` | 输入栏用编辑器的渲染结果去掉上下两条边框，加"      › "和 8 空格前缀，宽度传入"窗口宽度 - 8"；光标不在该行时编辑器不显示光标；超字提示在最后一行下面；提示行用新的输入行文字 |
| `QuestionWindowView.handleMouse`（新增） | 把点击位置换算成某个输入栏里的行列，选中那个输入行并转交编辑器的 `handleMouse`；不在输入栏里的点击不处理 |
| `answer` / 文字读取 | 用编辑器的完整原文（含粘贴原文）去掉首尾空白 |
| `showWindow` | 把 `tui` 传给窗口；返回的组件加上 `handleMouse` 转发 |
| `chooseOrWriteWindow` | `otherLabel` 改为可选 |
| 旧的 `drafts` / `other` 文字状态、`textAt` / `setTextAt`、手写的字符插入与退格 | 被编辑器取代后删除 |

## 协作关系
`openProgramWindow` → `showWindow`（拿到 `tui`）→ `QuestionWindowView` → 每个输入行一个 `Editor`（`@earendil-works/pi-tui`，已是依赖）。编辑器的判断"是否在第一/最后显示行"、换行键、粘贴折叠、`getExpandedText`、`handleMouse` 都用它自带的公开方法；需要的判断没有公开方法时，用 `getCursor()` 和 `render` 结果换算，不改依赖包。

## 验证方式
- 测试入口：`new QuestionWindowView({ tone, questions, theme, onDone, tui })`（`tui` 用 `{ requestRender() {}, terminal: { rows: 40, columns: 80 } }` 一类的桩）的 `handleInput` / `render(width)` / `handleMouse(event)`；`chooseOrWriteWindow(host, window, signal)`；`askWindow`。按键：Shift+Enter `"\x1b[13;2u"`、Ctrl+J `"\n"`、回车 `"\r"`、← `"\x1b[D"`、→ `"\x1b[C"`、↑ `"\x1b[A"`、↓ `"\x1b[B"`、Home `"\x1b[H"`、End `"\x1b[F"`、Backspace `"\x7f"`、Delete `"\x1b[3~"`、Esc `"\x1b"`；粘贴 `"\x1b[200~" + 文字 + "\x1b[201~"`。鼠标事件 `{ type: "click", button: "left", x, y, screenX, screenY, width, height, shift: false, alt: false, ctrl: false }`，x、y 是相对窗口左上角的列、行。
- 测试输入：确认原型窗口的问题定义 `{ question: "确认原型", choices: [{ label: "通过（写进需求草稿）" }, { label: "通过并补充说明（自己输入）", writable: true }], allowOther: true, otherMaxLength: 4000, escapeChoice: "放弃这一版", escapeHint: "Esc 放弃这一版" }`。
- 预期结果：
- [ ] 不传 `otherLabel` 时第 3 行显示"其他（自己输入）"；`chooseOrWriteWindow` 不传 `otherLabel` 也能用
- [ ] 宽 36、44、60、80 时输入 100 个汉字、再 Shift+Enter 输入 50 个字母：每行 `visibleWidth` ≤ 宽度；输入栏第一行以"      › "开头，其余以 8 空格开头，字母另起一行
- [ ] 输入"abc"，← ，"X"，Home，"Y"，End，Backspace，Delete，Shift+Enter，"d"，Ctrl+J，"e"，回车 → 提交 `other` 为 `"YabX\nd\ne"`
- [ ] 输入栏三行、光标在第二行：↑ 到第一行，再 ↑ 光标到上一个选项；↓ 回来光标在离开时位置；最后一行再 ↓ 到下一个选项
- [ ] 两个输入行各自保留文字和光标；不在该行时显示文字但无光标块
- [ ] 空白回车、超上限回车都不提交；`"  第一行\n第二行  "` 提交为 `"第一行\n第二行"`
- [ ] 粘贴 42 行显示"[paste #1 +42 lines]"，粘贴 1200 字单行显示"[paste #2 1200 chars]"，提交得到完整原文；粘贴 3990 字再输 11 字显示"超出 1 字，最多 4000 字"且回车无效
- [ ] 光标在输入行时提示为"直接输入 · 回车确认 · Shift+Enter 换行 · ↑↓ 选择 · Esc 放弃这一版"；不在时和现状一致
- [ ] 输入栏有字时按 Esc：有 `escapeChoice` 返回 `[{ choices: ["放弃这一版"] }]`，没有返回 undefined
- [ ] `handleMouse` 点击"其他"输入栏第一行第 5 个字：光标移到"其他"、编辑器光标在第 5 个字前；点击选项文字不改变状态
- [ ] 现有 `tests/question-window.test.ts` 用例（按新提示文字更新后）全部通过
