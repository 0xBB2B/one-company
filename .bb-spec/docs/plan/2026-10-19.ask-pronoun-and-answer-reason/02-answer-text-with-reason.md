---
name: 02-answer-text-with-reason
description: 点选回答的 answer.text 改成"标题+换行+理由"，与交给核验器的用户原话相同
---
# 点选回答带上选项理由

## 目标
用户在提问窗口点选某一项后，返回给主代理的 `answer.text` 和程序交给草稿核验器、解释器的用户原话一字不差。

## 业务规则（来源：PRD 02-answer-with-reason）
- C1：需求澄清提问里点选某一项时，`answer.text` = 该项 label + "\n" + 该项 reason（不带"选第 N 项："和"（推荐）"）；`answer.choice` 仍为所选序号（从 1 开始）。
- C2：面板事项提问里点选同样取值，`answer.choice` 与 `decision` 照常返回。
- C3：选"其他"时 `answer.text` 是用户输入原文、`answer.other=true`；暂不回答时 `answer=null`。均不变。
- C4：终端里提问结果的显示不变：点选时"你的回答  N. 标题（推荐）"，"其他"时输入内容加"（自己输入）"。终端显示用的是 `choice` 序号找回选项标题，不读 `answer.text`。
- C5：主代理规则写明 `status=answered` 时 `answer.text` 就是用户这一轮的原话，按它改草稿。
- 决策理由：主代理和核验器看同一份原话，主代理不用自己拼；推翻 commit 78b8605 中"返回给主代理的 answer.text 不变"。两种提问都改，保持同一规则。用户 2026-10-19 决定。

## 涉及文件
- 修改 `src/modules/interaction/main-requirement-interaction.ts`（`ask` 第 696-699 行、`askPanelItem` 第 749-751 行）
- 修改 `rules/01-main-session.md`（第 9 行"提问"条目里"用户点选的那一项连同它的理由（reason）就是用户这一轮的原话，选"其他"时 answer 就是原话"一句）
- 修改 `src/modules/interaction/ask-question.ts` 第 18 行 `askRecordText` 的注释：其中"用户点选的那一项连同它的说明另作为用户原话交给模型"仍成立，只在与新行为不符时调整
- 修改 断言旧格式"选第 N 项：…"的测试：`tests/main-requirement-interaction.test.ts`（约第 657、668、705 行）、`tests/adjudication.test.ts`（约第 596、622 行）

## 函数清单
### src/modules/interaction/main-requirement-interaction.ts
| 函数名 | 职责 |
|---|---|
| `ask`（`MainRequirementInteraction` 方法） | 点选时把 `answer.text` 设为 label + "\n" + reason，并把同一个字符串交给 `#adoptQuestionAnswer`，两处不再各自拼写 |
| `askPanelItem`（同类方法） | 同上 |

### rules/01-main-session.md
把"用户点选的那一项连同它的理由（reason）就是用户这一轮的原话，选"其他"时 answer 就是原话"改成"返回的 answer.text 就是用户这一轮的原话（点选时是那一项的标题和理由，选"其他"时是用户输入的文字）"。

## 协作关系
`ask` / `askPanelItem` 先由 `askWindow` 得到用户点选或输入，再调 `#adoptQuestionAnswer(text, …)` 记下用户原话，最后由 `#prove` 返回 `{ status, answer, … }` 给主代理。`src/modules/interaction/user-interact-tool.ts:75-78` 的 `renderAskResult` 按 `answer.choice` 取选项标题显示，`answer.text` 只在"其他"时显示，不需要改。

## 验证方式
- 测试入口：`MainRequirementInteraction` 的 ask 与 panel-item ask（`tests/main-requirement-interaction.test.ts` 第 641 行起的 `ask` 帮手、`tests/adjudication.test.ts` 的面板事项提问用法），以及 `renderAskResult` 的渲染测试（`tests/user-interact-tool.test.ts` 第 146 行附近）。
- 测试输入：选项 `{ label: "5 分钟", reason: "短信验证码常见有效期", recommended: true, recommendedReason: "…" }` 等；窗口桩返回点选第 1 项 / 第 2 项 / 其他"7 分钟" / 暂不回答。
- 预期结果：
  - [ ] 需求澄清提问点选第 1 项 → `{ status: "answered", answer: { text: "5 分钟\n短信验证码常见有效期", choice: 1 } }`。
  - [ ] 点选后紧接着 updateDraft，核验器收到的 payload `text` 与上面的 `answer.text` 完全相同。
  - [ ] 面板事项提问点选第 1 项 → `answer.text` 为"标题\n理由"，`answer.choice=1`，`decision` 含 itemId 与 itemVersion。
  - [ ] 选"其他"输入"7 分钟" → `answer: { text: "7 分钟", other: true }`；暂不回答 → `answer: null`。
  - [ ] 渲染点选推荐项的结果 → 仍显示"你的回答  1. 标题（推荐）"，不显示理由。
  - [ ] `rules/01-main-session.md` 含"answer.text 就是用户这一轮的原话"。
  - [ ] `pnpm test` 全部通过。
