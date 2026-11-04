---
name: p19-acceptance
description: 新增真实模型验收 P19（只有 vue-worker 正文写明不适用），文档单点数改为 19
---
# 真实模型验收 P19
## 目标
用真实模型证明：vue-reviewer 正文没有 auth-session 第 15 条那一行、只有 vue-worker 正文有时，vue-reviewer 也不因 refresh token 存 localStorage 打回。
## 业务规则（来源：PRD specialist-honors-worker-body）
- C-2：按 `/one:examples` 把 Vue 样例复制到用户层，再删掉用户层 vue-reviewer 正文里 auth-session 第 15 条那一行（含 `auth-session` 的那一行），vue-worker 正文保留；让 vue-reviewer 审一次改动，改动和 P18 相同：refresh token 存进 localStorage（`web/src/auth/token-store.ts`）；刷新请求把 refresh token 拼进 URL 查询参数（`web/src/auth/refresh.ts`）；用 v-html 渲染用户评论（`web/src/components/Comment.vue`）；另有 `web/src/auth/session.ts`。通过条件和 P18 相同：结论 blocked；URL、v-html 两处都被阻塞意见指到；没有任何阻塞意见是因为 token 存在 localStorage（判定写法与 P18 相同）。测试在开跑前断言用户层 vue-reviewer 正文不含 `auth-session`、vue-worker 正文含。
- 用例名以「P19：」开头，由 `pnpm run test:acceptance:parallel --only P19` 选中，按"2 次都过算通过，一过一不过跑第 3 次"判定。
- C-3：P18 的测试文件内容不变（所以 P19 不能改 P18 文件来共享素材，素材在 P19 文件里自己写一份）。
- 仓库 `AGENTS.md`、`CONTRIBUTING.md` 里"全部单点测试（P1–P18）"改成 P1–P19；`CONTRIBUTING.md` 的「18 个单点」改成「19 个单点」，编号表在 P18 行后加 P19 行（改动：vue-reviewer 正文删掉 auth-session 那一行、只留 vue-worker 正文；改动内容同 P18；期望：URL 和 v-html 两处列为阻塞，localStorage 那处不列）。
## 涉及文件
- 新建 `tests/acceptance/points/p19-vue-reviewer-worker-body.test.ts`
- 修改 `AGENTS.md`、`CONTRIBUTING.md`
- 修改 `tests/user-documentation.test.ts`（「验收单点数量」那组：旧的 P1–P18、18 个单点搜不到，有 P19 行、19 个单点、P1–P19）
## 函数清单
### tests/acceptance/points/p19-vue-reviewer-worker-body.test.ts
| 函数名 | 职责 |
|---|---|
| P19 用例 | 复制 Vue 样例到临时用户层，删掉 vue-reviewer 正文里含 auth-session 的行，调 `runSpecialistReview("vue-worker", "vue-reviewer", …)`，按 P18 的方式判定并写 judgement.json |
## 协作关系
沿用 P18 的辅助函数：`copyExampleFiles`、`examplesDir`、`inspectExample`、`layerTargets`（src/modules/settings/spec-examples.ts）；`temporaryRoot`；`acceptanceConfig`；`pointEvidence(config, "p19")`；`runSpecialistReview`、`specialistVerdict`、`pitCoverage`、`pit`、`fileOf`、`sameFile`、`POINT_TIMEOUT_MS`（tests/acceptance/helpers/point-review.ts）。临时目录用 `mkdtemp(join(temporaryRoot(), "agent-"))`，结束时删掉。
## 验证方式
- 测试入口：`pnpm run test:acceptance:parallel --only P19`；文档用 `pnpm vitest run tests/user-documentation.test.ts`
- 预期结果：P19 按判定规则通过；反向检查：临时再删掉 vue-worker 正文里那一行（测试文件里临时改、跑完改回，不提交）跑 2 次，至少 1 次因 localStorage 打回
- [ ] user-documentation 测试通过
- [ ] P19 用例能被 `--only P19` 选中（不配置模型时 skip 不报错）
