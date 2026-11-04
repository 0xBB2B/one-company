---
name: specialist-honors-worker-body
description: 专项审查职责规矩补上被审 worker 定义正文；新增 P19 证明只靠 worker 正文也能放过
date: 2026-11-04
---

# 专项审查按 worker 定义正文放过不适用的 skill 条目

几个词先说清：
- 定义正文：角色定义文件里头部设置下面的那段文字。
- 职责规矩：程序按职责固定加进提示词的流程规矩，排在定义正文之后，用户改不到。
- 专项审查：按技术栈 skill 审代码的审查代理，如 vue-reviewer。
- 写明不适用：定义正文点出某份 skill 的某一条（skill 名加条目编号或标题），说它在本团队不适用，并写出本团队的做法。

## 用户故事
### P0：作为团队负责人，我想要只在 worker 定义正文里写明某条 skill 不适用，专项审查也按它审，以便团队决定只写一处

**用例（主路径）**
- 场景：用户层有 Vue 样例的 vue-worker，正文写明 auth-session 第 15 条在本团队不适用、refresh token 存 localStorage；vue-reviewer 的正文里没有这一行。
- 操作：派一个 Vue 任务，worker 把 refresh token 写进 localStorage，同一次改动里还把 refresh token 拼进刷新请求的 URL 查询参数、用 v-html 渲染用户评论；vue-reviewer 审查。
- 预期：vue-reviewer 不因 token 存 localStorage 列阻塞；URL 那一处（auth-session 第 12 条）和 v-html 那一处照样列为阻塞。

## 约束
- C-1：专项审查的职责规矩写明：你的定义正文或任务说明里被审 worker 定义的正文写明某份 skill 的某一条在本团队不适用时，违反那一条但符合定义正文的不算问题；同一份 skill 的其他条目照常核对。
- C-2：新增真实模型验收 P19：按 `/one:examples` 把 Vue 样例复制到用户层，再删掉 vue-reviewer 正文里 auth-session 第 15 条那一行（vue-worker 正文保留），让 vue-reviewer 审一次改动，改动和 P18 相同：refresh token 存进 localStorage；刷新 token 的请求把 refresh token 拼进 URL 查询参数；用 v-html 渲染用户评论。通过条件和 P18 相同：URL 那一处和 v-html 那一处都列为阻塞；没有任何一条阻塞意见是因为 token 存在 localStorage。P19 和其他单点验收一样由 `pnpm run test:acceptance:parallel` 运行，按"2 次都过算通过，一过一不过跑第 3 次"判定。
- C-3：P18 不变。

## 验收
- [ ] C-1：单元测试检查专项审查职责规矩原文含「你的定义正文或任务说明里被审 worker 定义的正文写明某份 skill 的某一条在本团队不适用时，违反那一条但符合定义正文的不算问题」和「同一份 skill 的其他条目照常核对」。
- [ ] C-2：`pnpm run test:acceptance:parallel --only P19` 按判定规则通过；跑 P19 时用户层 vue-reviewer 正文里没有 `auth-session`，vue-worker 正文里有。临时再删掉 vue-worker 正文里那一行跑 2 次，至少 1 次 vue-reviewer 因 token 存 localStorage 列阻塞，证明这条验收测得出规则有没有生效。
- [ ] C-3：P18 的测试文件在本次改动里内容不变，`--only P18` 按判定规则通过。

## 验证路径
1. `pnpm test` → 专项审查职责规矩的单元测试通过。
2. `ONE_COMPANY_ACCEPTANCE_MODEL=<提供方>/<模型> ONE_COMPANY_ACCEPTANCE_OUTPUT=<绝对路径> pnpm run test:acceptance:parallel --only P19` → 通过；vue-reviewer 的裁决有 URL 和 v-html 两处阻塞，没有 localStorage 的阻塞。
3. 临时删掉 vue-worker 正文里 auth-session 那一行，跑 2 次 P19 → 至少 1 次 vue-reviewer 因 localStorage 列阻塞；改回。
