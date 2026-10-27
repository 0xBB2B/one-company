---
name: window-writable-choice
description: 程序窗口支持"选中即输入"的选项，并能把 Esc 换成一个指定的答案，和中断区分开
---
# 程序窗口：可输入的选项 + Esc 指定答案

## 目标
程序选择窗口里，除最后的"其他"一行外，普通选项也能做成输入行；窗口可以声明"按 Esc 等于选了某个答案"，这样调用方能把用户按 Esc 和工具被中断（返回空）区分开。

## 业务规则（来源：PRD confirm-window）
- 确认原型窗口要有两行能输入："通过并补充说明（自己输入）"和"返工（自己输入要改什么）"。光标停在哪一行，按键就进哪一行下面的输入栏，显示为"› <已输入的文字>"，光标所在时末尾有反色光标块。
- 输入为空（只有空白也算空）时回车不起作用；超过上限字数时输入栏下面提示"超出 N 字，最多 M 字"，回车不起作用。两行的输入各自保留，光标移走再移回来字还在。
- 光标在任一输入行时，底部提示是"直接输入 · 回车确认 · ↑↓ 选择 · <Esc 那一段>"；不在输入行时是"↑↓ 选择 · 回车确认 · <Esc 那一段>"。
- 按 Esc 要能登记"放弃这一版"；工具被中断、没有界面时窗口返回空，不能被当成放弃。
- 现有调用方（项目规范更新窗口、主代理提问窗口、批准窗口等）不用新能力时，画面和返回值不变。

## 涉及文件
- 修改 `src/core/host/question-window.ts`
- 修改 `tests/question-window.test.ts`

## 函数清单
### src/core/host/question-window.ts
| 函数名 | 职责 |
|---|---|
| `WindowChoice`（接口） | 新增可选字段 `writable?: boolean`：这一项是输入行 |
| `WindowQuestion`（接口） | 新增可选字段 `escapeChoice?: string`：按 Esc 时窗口按"选了这个名称"作答 |
| `QuestionWindowView` 构造与状态 | 每个输入行（可输入选项和"其他"行）各有一份输入文字 |
| `QuestionWindowView.isOther` 一类判断 | 改为判断"光标所在行是不是输入行"，可输入选项与"其他"行走同一套输入处理 |
| `QuestionWindowView.handleInput` | Esc：有 `escapeChoice` 时以 `{ choices: [escapeChoice] }` 作答，没有时保持现状（返回空） |
| `QuestionWindowView.handleOther` | 处理当前输入行的输入、退格、回车；回车时空白或超过 `otherMaxLength` 不起作用 |
| `QuestionWindowView.answer` | 可输入选项提交时返回 `{ choices: [<该项名称>], other: <去掉首尾空白的文字> }`；"其他"行提交保持现状 `{ choices: [], other }` |
| `QuestionWindowView.render` | 可输入选项下方画输入栏和超字提示（和"其他"行同样的样式）；光标在任一输入行时用"直接输入"那组提示 |
| `chooseOrWriteWindow` | 透传 `escapeChoice`；选项里的 `writable` 原样带进窗口 |

## 协作关系
`chooseOrWriteWindow` → `showWindow` → `QuestionWindowView`。中断仍由 `openProgramWindow` 的 abort 处理返回空，与 Esc 的指定答案互不影响。只给单选问题用，多选问题不必支持可输入选项。

## 验证方式
- 测试入口：`new QuestionWindowView({ tone: "warning", theme, onDone, questions: [...] })` 的 `handleInput` / `render`；`chooseOrWriteWindow(host, window, signal)`。
- 测试输入：问题为 `{ question: "确认原型", choices: [{ label: "通过（写进需求草稿）" }, { label: "通过并补充说明（自己输入）", writable: true }], allowOther: true, otherLabel: "返工（自己输入要改什么）", otherMaxLength: 4000, escapeChoice: "放弃这一版", escapeHint: "Esc 放弃这一版" }`。
- 预期结果：
- [ ] 渲染三行选项，顺序如上；光标在第 1 行时提示为"↑↓ 选择 · 回车确认 · Esc 放弃这一版"
- [ ] ↓ 到第 2 行，提示变为"直接输入 · 回车确认 · ↑↓ 选择 · Esc 放弃这一版"，第 2 行下方出现"› "输入栏
- [ ] 第 2 行直接回车、输入两个空格后回车：onDone 都没被调用
- [ ] 第 2 行输入 4001 个字：渲染出"超出 1 字，最多 4000 字"，回车不起作用；退格到 4000 字后回车，onDone 收到 `[{ choices: ["通过并补充说明（自己输入）"], other: <4000 字> }]`
- [ ] 第 2 行输入"  用 B  "后回车：onDone 收到 `[{ choices: ["通过并补充说明（自己输入）"], other: "用 B" }]`
- [ ] 第 2 行输入"乙"，↓ 到第 3 行输入"甲"，↑ 回第 2 行：第 2 行输入栏显示"› 乙"，第 3 行输入栏仍显示"› 甲"
- [ ] 第 3 行输入"甲"回车：onDone 收到 `[{ choices: [], other: "甲" }]`（与现状一致）
- [ ] 按 Esc：onDone 收到 `[{ choices: ["放弃这一版"] }]`；没有 `escapeChoice` 的窗口按 Esc 仍收到 `undefined`
- [ ] `chooseOrWriteWindow` 在 signal 中断时返回 `undefined`，不是 Esc 的指定答案
- [ ] 现有 `tests/question-window.test.ts` 全部通过
