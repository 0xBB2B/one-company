---
name: specialist-rule
description: 专项审查职责规矩补上"任务说明里被审 worker 定义的正文"，单元测试检查原文
---
# 专项审查职责规矩认 worker 定义正文
## 目标
专项审查的职责规矩写明：自己的定义正文或被审 worker 定义的正文写明某条 skill 不适用时，违反那一条但符合定义正文的不算问题。
## 业务规则（来源：PRD specialist-honors-worker-body）
- C-1：专项审查的职责规矩写明：「你的定义正文或任务说明里被审 worker 定义的正文写明某份 skill 的某一条在本团队不适用时，违反那一条但符合定义正文的不算问题；同一份 skill 的其他条目照常核对。」
- 验收：单元测试检查专项审查职责规矩原文含「你的定义正文或任务说明里被审 worker 定义的正文写明某份 skill 的某一条在本团队不适用时，违反那一条但符合定义正文的不算问题」和「同一份 skill 的其他条目照常核对」。
- worker、通用审查的职责规矩不改。
- 原因：每个审查的任务说明里都附有被审 worker 定义的正文，通用审查的规矩已写明按它放过，专项审查的没写，只能靠模型推断。
## 涉及文件
- 修改 `role-rules/reviewer-specialist.md`（第 8 行那一条）
- 修改 `tests/role-rules.test.ts`（「skill 某一条不适用的职责规矩」那组里 reviewer-specialist 的短语）
## 函数清单
### role-rules/reviewer-specialist.md
| 条目 | 职责 |
|---|---|
| 第 8 行规则 | 改成 C-1 的原文 |
## 协作关系
`loadRoleRules("reviewer-specialist")` 读这份文件，`reviewRulesFor` 把它加进专项审查的提示词。
## 验证方式
- 测试入口：`loadRoleRules("reviewer-specialist")`（tests/role-rules.test.ts 现有用法）
- 测试输入：无
- 预期结果：返回文本含 C-1 验收里的两句原文
- [ ] `pnpm vitest run tests/role-rules.test.ts` 通过
