# ask-pronoun-and-answer-reason 实施计划
## 阶段 1：提问与回答
- [01-ask-pronoun-check](01-ask-pronoun-check.md) — 提问格式检查拒绝含我/你/您的五段文字，主代理规则写明改用角色词
- [02-answer-text-with-reason](02-answer-text-with-reason.md) — 点选回答的 answer.text 改成"标题+换行+理由" [依赖: 01-ask-pronoun-check]（两份都改 rules/01-main-session.md 同一行，须串行）
