---
name: summary-window
description: /one:examples 写入窗口用摘要和样例路径代替逐行内容，确认窗口提示跟着改
---
# 写入窗口显示摘要

## 目标
`/one:examples` 问是否写入 AGENTS.md 时，窗口只显示一句摘要和样例文件路径，高度与样例和目标 AGENTS.md 的长度无关，「写入」「不写入」始终在窗口里。

## 业务规则（来源：PRD 子文档 summary-window）
确认窗口：`/one:examples` 选完样例和层之后弹的窗口，选项「复制」「不复制」。写入窗口：选「复制」且文件复制成功后弹的窗口，选项「写入」「不写入」。

- C-1：确认窗口 AGENTS.md 一块只改两句。目标文件不存在：「还没有 AGENTS.md，新建一份，下一步问你是否写入」。文件存在、没有那一段、合并后不超限：「追加「<标题>」一段，下一步问你是否写入」。已有一致、已有不一致、超限三种提示不变。
- C-2：写入窗口从上到下：
  1. 标题不变：用户层「把这些改动写入用户规范 <目标路径>？」，项目层「把这些改动写入项目规范 AGENTS.md？」。
  2. 目标是软链接时黄色一行「AGENTS.md 是软链接，实际写到 <真实路径>」，不变。
  3. 摘要一行，普通颜色。文件存在：「在现有 AGENTS.md 末尾追加「<标题>」一段，共 <行数> 行，原有内容不动。」不存在：「还没有 AGENTS.md，新建一份，写入「<标题>」一段，共 <行数> 行。」
  4. 灰色一行「这段内容在 <样例文件路径>」，路径是本次实际读取的样例 AGENTS.md，以家目录开头时写成 `~` 开头。
  5. 空行，然后灰色一行「写入后，此后派出的 PM、worker、reviewer 都按新内容工作。」，不变。
- 行数：样例全文按换行分开后的行数，文件末尾的换行不多算一行；golang 68 行，vue 29 行。标题取现有 `inspection.section.heading`。
- C-3：写入窗口不显示样例正文，也不显示目标 AGENTS.md 原有内容；样例标题只出现在摘要里。
- C-4：不论目标 AGENTS.md 多长，用户层写入窗口 80 列下渲染总行数不超过 20 行，含「写入」「不写入」。
- C-5：选项、默认项、Esc 行为不变，写入的文件内容和结果提示不变；项目规范窗口（`src/modules/verification/project-conventions.ts` 的 `updateConventions`）显示内容不变，仍逐行列改动。

## 涉及文件
- 修改 `src/modules/settings/examples-extension.ts`
- 修改 `tests/examples-command.test.ts`

## 函数清单
### src/modules/settings/examples-extension.ts
| 函数名 | 职责 |
|---|---|
| `confirmLines` | 新建、追加两种情况的提示换成 C-1 的文案 |
| `conventionsWindow` | 按 C-2 生成写入窗口的标题、行和选项；入参去掉合并后全文，改为标题、样例全文（用来算行数）和样例文件路径，文件是否存在仍看 `before` |
| `openExamplesPage` | 调 `conventionsWindow` 时传入标题、样例全文和样例文件路径；样例路径和读取 `exampleText` 时用同一个路径 |

## 协作关系
`openExamplesPage` → `conventionsWindow` → `chooseWindow`。路径显示用现有 `tilde`。去掉 `lineDiff` 的 import（`project-conventions.ts` 继续用它，函数本身不动）。写入逻辑（`merged.content`、`writeFileAtomic`、写入前重读比对）不动。

## 验证方式
- 测试入口：`openExamplesPage`，沿用 `tests/examples-command.test.ts` 的 `run` 脚本化按键和窗口截屏；80 列场景要让测试的渲染宽度可指定。
- 测试输入：`setup()` 造的临时 agent 目录和仓库，目标 AGENTS.md 分不存在、已有几行、500 行、软链接、CRLF。
- 预期结果：
- [ ] C-1：不存在、可追加两种情况，确认窗口是新文案；旧文案「给你看差异」「给你看全文」不再出现。
- [ ] C-1：已有一致、已有不一致、超限三种提示不变（现有测试继续通过）。
- [ ] C-2：用户层文件存在时写入窗口含「在现有 AGENTS.md 末尾追加「## 后端设计约定」一段，共 68 行，原有内容不动。」；vue 新建时含「还没有 AGENTS.md，新建一份，写入「## 前端设计约定」一段，共 29 行。」。
- [ ] C-2：写入窗口含「这段内容在 」和样例 AGENTS.md 路径；路径以家目录开头时显示 `~` 开头。
- [ ] C-2：软链接提示在摘要上方；普通文件时没有这一行。
- [ ] C-2：摘要是普通颜色，路径行是灰色（用带颜色标记的 theme 断言）。
- [ ] C-3：目标 AGENTS.md 含特殊标记行时窗口里找不到它；样例除标题外任何一行都不出现；没有 `+ ` 开头的行。
- [ ] C-4：目标 AGENTS.md 有 500 行，用户层写入窗口 80 列渲染不超过 20 行，含「写入」「不写入」。
- [ ] C-5：选「写入」后文件等于「原内容去掉末尾换行 + 空行 + 样例全文」；选「不写入」、按 Esc 文件不变；CRLF 文件写入后没有单独的 `\n`。
- [ ] C-5：项目规范窗口仍逐行显示 `+ ` 开头的新增行（现有测试继续通过，没有就补一条）。
