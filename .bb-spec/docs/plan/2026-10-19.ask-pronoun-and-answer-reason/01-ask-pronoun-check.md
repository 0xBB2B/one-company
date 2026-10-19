---
name: 01-ask-pronoun-check
description: 提问格式检查拒绝含我/你/您的五段文字，主代理规则写明改用角色词
---
# 提问文字不用人称代词

## 目标
主代理用 `one_company_user_interact` 发起需求澄清提问或面板事项提问时，问题、根源自检、选项标题、理由、推荐理由里只要含"我""你""您"，程序就退回提问、不弹窗，并逐条写明改法。

## 业务规则（来源：PRD 01-no-pronouns-in-asks）
- C1：需求澄清提问（`purpose` 不填或为 `user-confirmation`）的 ask，question、rootCheck、任一选项的 label、reason、recommendedReason 中只要出现"我""你""您"中任一字（"我们""你们"同样算），ask 失败、不弹窗。
- C2：面板事项提问（`purpose=panel-item`）的 ask 同样检查、同样失败。
- C3：失败原因逐条写出每一处：哪个字段（中文名 + 英文字段名）、第几个选项（选项字段时）、含哪个字；并写明改用"用户""AI"或这个人在需求里的角色（如负责人）。多处时一次全部列出。
- C4：五处都不含这三个字时，人称检查不影响提问。
- C5：用户在"其他"里输入的文字不检查。
- C6：主代理规则写明：问题、根源自检、选项标题、理由、推荐理由不用"我""你""您"；指回答问题的人写"用户"或这个人在需求里的角色，指主代理自己写"AI"。
- 决策理由：从提问一侧消除人称，不放宽草稿核验器；只写规则模型会漏，所以加程序检查。用户 2026-10-19 决定。

## 涉及文件
- 修改 `src/modules/interaction/ask-question.ts`
- 修改 `rules/01-main-session.md`（第 9 行"提问"条目）
- 修改 现有测试中提问文字含"我/你/您"的测试素材（如 `tests/main-requirement-interaction.test.ts` 第 668 行附近"你维护项目清单"、`tests/user-interact-tool.test.ts`、`tests/adjudication.test.ts`），改成角色词，使其不被新检查退回

## 函数清单
### src/modules/interaction/ask-question.ts
| 函数名 | 职责 |
|---|---|
| `askQuestionIssues` | 现有格式检查；增加人称检查，把每一处含"我/你/您"的字段写成一条中文问题加进返回的数组 |
| `pronounIssues`（新增，文件内私有） | 检查 question、rootCheck 与每个选项的 label、reason、recommendedReason，返回逐条中文问题 |

### rules/01-main-session.md
在"提问"条目里登记字段说明之后加一句：问题、根源自检、选项标题、理由、推荐理由都不用"我""你""您"，指回答问题的人写"用户"或这个人在需求里的角色（如负责人），指主代理自己写"AI"。

## 协作关系
`src/modules/interaction/user-interact-tool.ts:102-106` 已对 `user-confirmation:ask` 和 `panel-item:ask` 调用 `askQuestionIssues`，有问题时抛 `HostAuthorizationError("question_format", issues.join("；"))`，ask 失败且不弹窗。本 plan 不改这段调用。

## 验证方式
- 测试入口：`createUserInteractTool(...)` 返回的工具 `execute`（`tests/user-interact-tool.test.ts` 的现有用法），以及 `askQuestionIssues` 导出函数。
- 测试输入：一份合规提问（2 个选项、恰一个推荐、有推荐理由、rootCheck 非空），分别在 question、rootCheck、第 N 个选项的 label / reason / recommendedReason 放入"我"/"你"/"您"/"我们"。
- 预期结果：
  - [ ] 五个字段各含一个人称字时，`askQuestionIssues` 各返回一条问题，文字含字段名、选项序号（选项字段时）和那个字。
  - [ ] 问题含"我们"、rootCheck 含"你"、第 1 个选项 label 含"我" → 返回三条，且原因文字含"用户""AI""角色"。
  - [ ] 经工具 `execute` 发起 `user-confirmation:ask`（reason 含"你"）→ 抛错，原因含"你"，没有弹窗（窗口桩未被调用）。
  - [ ] 经工具 `execute` 发起 `panel-item:ask`（question 含"您"）→ 抛错，没有弹窗。
  - [ ] 五处都不含人称字 → `askQuestionIssues` 返回空数组，窗口照常弹出。
  - [ ] 用户选"其他"输入"我来验收" → ask 返回 answered，`answer.text` 为"我来验收"。
  - [ ] `rules/01-main-session.md` 含"不用“我”“你”“您”"（或等价写法）以及"用户""AI"的用法说明。
  - [ ] `pnpm test` 全部通过（包括改过素材的旧测试）。
