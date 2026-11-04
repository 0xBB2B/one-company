---
name: definition-body-overrides-skill
description: 职责规矩加上"定义正文写明某条 skill 不适用时按定义正文"，样例定义正文写明 auth-session 第 15 条不适用
date: 2026-11-04
---

# 定义正文写明不适用的 skill 条目

几个词先说清：
- 定义正文：角色定义文件里头部设置下面的那段文字，只有用这份定义派出的代理读得到。
- 职责规矩：程序按职责（worker、reviewer 等）固定加进提示词的流程规矩，排在定义正文之后，和正文冲突时以职责规矩为准，用户改不到。
- 专项审查：按技术栈 skill 审代码的审查代理，如 vue-reviewer；通用审查是名为 reviewer 的那个审查代理。
- 写明不适用：定义正文点出某份 skill 的某一条（skill 名加条目编号或标题），说它在本团队不适用，并写出本团队的做法。

## 用户故事
### P0：作为团队负责人，我想要在定义正文里写明某条内置 skill 不适用，以便专项代理按团队的决定写代码和审查

**用例（主路径）**
- 场景：用户层装了 Vue 样例的 vue-worker、vue-reviewer，正文写明 auth-session 第 15 条在本团队不适用，refresh token 存 localStorage。
- 操作：派一个 Vue 任务，worker 把 refresh token 写进 localStorage，vue-reviewer 审查。
- 预期：vue-reviewer 不因 token 存 localStorage 列阻塞；同一次改动里把 token 拼进 URL 的问题（auth-session 第 12 条）、用 v-html 渲染用户评论的问题照样列为阻塞。

**用例（边界：专项审查被关掉）**
- 场景：同上，但 vue-reviewer 在 `/one:setting` 里关着，通用审查拿到 worker 定义加载的 auth-session。
- 操作：同上。
- 预期：通用审查同样不因 token 存 localStorage 列阻塞。

## 约束
- C-1：worker 的职责规矩写明：定义正文写明某条 skill 不适用时，按定义正文写，不按那一条。
- C-2：专项审查的职责规矩写明：自己的定义正文写明某条 skill 不适用时，违反那一条但符合定义正文的，不算问题。
- C-3：通用审查的职责规矩写明：核对已加载给自己的 skill 时，被审 worker 定义的正文写明某条不适用的，违反那一条但符合定义正文的，不算问题。
- C-4：只有写明不适用的那一条被推翻；同一份 skill 的其他条目照常执行。
- C-5：Go 样例的 go-worker、go-reviewer 正文各有一行，写明 auth-session 第 15 条「登录 token 存在 localStorage 或 sessionStorage 里」在本团队不适用，本团队 Web 端的 token 存在 localStorage。
- C-6：Vue 样例的 vue-worker、vue-reviewer 正文各有一行，写明 auth-session 第 15 条「登录 token 存在 localStorage 或 sessionStorage 里」在本团队不适用，本团队 access token 放在运行时内存里，refresh token 存在 localStorage。
- C-7：新增真实模型验收 P18：按 `/one:examples` 把 Vue 样例复制到用户层后，让 vue-reviewer 审一次改动，改动里同时有三处：refresh token 存进 localStorage；刷新 token 的请求把 refresh token 拼进 URL 查询参数（auth-session 第 12 条「token 或会话 ID 放在 URL 里」）；用 v-html 渲染用户评论。通过条件：URL 那一处和 v-html 那一处都列为阻塞；没有任何一条阻塞意见是因为 token 存在 localStorage。P18 和其他单点验收一样，由 `pnpm run test:acceptance:parallel` 运行，按"2 次都过算通过，一过一不过跑第 3 次"判定。

## 验收
- [ ] C-1：worker 的职责规矩里有这条规则，单元测试检查规则原文。
- [ ] C-2：专项审查的职责规矩里有这条规则，单元测试检查规则原文。
- [ ] C-3：通用审查的职责规矩里有这条规则，单元测试检查规则原文。
- [ ] C-4：P18 里 token 拼进 URL 那一处（auth-session 第 12 条）列为阻塞，证明同一份 skill 的其他条目照常执行。
- [ ] C-5：单元测试检查 go-worker、go-reviewer 正文都写了 `auth-session`、第 15 条和 localStorage。
- [ ] C-6：单元测试检查 vue-worker、vue-reviewer 正文都写了 `auth-session`、第 15 条和 localStorage。
- [ ] C-7：`pnpm run test:acceptance:parallel --only P18` 按判定规则通过；临时删掉 vue-worker、vue-reviewer 两份正文里那一行后跑 2 次，至少 1 次 vue-reviewer 因 token 存 localStorage 列阻塞，证明这条验收确实测得出规则有没有生效。两份都要删：每个审查的任务说明里都附有被审 worker 定义的正文，只删 vue-reviewer 那一行，审查仍会从 vue-worker 正文里读到这条不适用。

## 验证路径
1. `pnpm test` → 检查职责规矩和样例定义正文的单元测试通过。
2. `ONE_COMPANY_ACCEPTANCE_MODEL=<提供方>/<模型> ONE_COMPANY_ACCEPTANCE_OUTPUT=<绝对路径> pnpm run test:acceptance:parallel --only P18` → 通过；输出里 vue-reviewer 的裁决有 URL 和 v-html 两处阻塞，没有 localStorage 的阻塞。
3. 临时删掉 vue-worker、vue-reviewer 两份正文里 auth-session 那一行，跑 2 次 P18 → 至少 1 次 vue-reviewer 因 localStorage 列阻塞；改回正文。
