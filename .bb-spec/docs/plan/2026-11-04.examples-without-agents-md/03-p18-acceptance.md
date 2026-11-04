---
name: p18-acceptance
description: 新增真实模型验收 P18：装上 Vue 样例定义后，vue-reviewer 按定义正文放过 localStorage，同一份 skill 的其他条目照常打回
---
# P18：专项审查按定义正文放过写明不适用的条目

## 目标
`pnpm run test:acceptance:parallel --only P18` 能跑出一次真实模型审查，证明 vue-reviewer 按定义正文放过 auth-session 第 15 条（token 存 localStorage），同时照常打回 auth-session 第 12 条（token 放在 URL 里）和 v-html。

## 业务规则（来源：PRD definition-body-overrides-skill）
- 按 `/one:examples` 把 Vue 样例复制到用户层后，让 vue-reviewer 审一次改动。改动里同时有三处：
  1. refresh token 存进 localStorage（auth-session 第 15 条，样例定义正文写明不适用）。
  2. 刷新 token 的请求把 refresh token 拼进 URL 查询参数（auth-session 第 12 条「token 或会话 ID 放在 URL 里」）。
  3. 用 v-html 渲染用户评论（和 P16 埋的问题相同）。
- 通过条件：第 2、3 处都列为阻塞；没有任何一条阻塞意见是因为 token 存在 localStorage。
- 第 2 处证明同一份 skill 的其他条目照常执行；第 3 处证明这次审查确实在审代码。
- P18 和其他单点验收一样由 `pnpm run test:acceptance:parallel` 运行，按"2 次都过算通过，一过一不过跑第 3 次"判定；测试名冒号前写编号 `P18`，`--only P18` 才认得出。
- 用户 2026-11-04 决定新增这条验收，因为风险在于模型照不照做，只有真调模型才能证明。

## 涉及文件
- 新建 `tests/acceptance/points/p18-vue-reviewer-definition-body.test.ts`
- 修改 `tests/acceptance/helpers/point-review.ts`
- 修改 `tests/helpers/run-manager-fixture.ts`

## 函数清单
### tests/helpers/run-manager-fixture.ts
| 函数名 | 职责 |
|---|---|
| `createPmRunWorld` | 新增可选的额外 skill 目录：传入时和包内 `skills/` 一起交给 RunManager 的 `skillDirs`，不传时行为不变；已有的 `userDir` 选项照旧决定用户层定义目录 |

### tests/acceptance/helpers/point-review.ts
| 函数名 | 职责 |
|---|---|
| `runSpecialistReview` | 新增可选的用户层定义目录和额外 skill 目录，原样转给 `createPmRunWorld`；不传时行为不变（P15、P16 不受影响） |

### tests/acceptance/points/p18-vue-reviewer-definition-body.test.ts
| 函数名 | 职责 |
|---|---|
| 顶层 `test("P18：…")` | 在测试临时根下建用户层目录，用 `inspectExample` + `copyExampleFiles`（`src/modules/settings/spec-examples.ts`）把 `examples/vue` 复制进去；以这个用户层跑 `runSpecialistReview("vue-worker", "vue-reviewer", 坑, …)`；写 `judgement.json` 证据；断言 |
| 坑与对照组常量 | 三个文件：存 refresh token 到 localStorage 的模块（不得被阻塞意见指到）、把 refresh token 拼进 URL 的刷新请求（用 `pit` 定义，关键词如 URL、查询参数、query、日志、Referer）、v-html 渲染评论的组件（沿用 P16 的写法和关键词） |

## 协作关系
- P18 → `inspectExample`/`copyExampleFiles` 复制样例 → `runSpecialistReview` → `createPmRunWorld`（用户层定义目录 + 额外 skill 目录 = 复制后的 `skills/`）→ RunManager 派 vue-worker（脚本回复写入坑文件）→ 派审查，vue-reviewer 用真实模型。
- 判定沿用 `specialistVerdict`、`pitCoverage`；"localStorage 那处没有被指到"用阻塞意见的 targetRef 文件判断：没有任何阻塞意见的 targetRef 指向 localStorage 模块那个文件。
- 跳过条件和 P16 一样：没有验收配置或不是 macOS 时跳过；超时用 `POINT_TIMEOUT_MS`。

## 验证方式
- 测试入口：`ONE_COMPANY_ACCEPTANCE_MODEL=<提供方>/<模型> ONE_COMPANY_ACCEPTANCE_OUTPUT=<绝对路径> pnpm run test:acceptance:parallel --only P18`；不带模型配置时 `pnpm test` 不包含它。
- 测试输入：上面三个文件和 P16 同样的支撑文件；用户层是复制后的 Vue 样例。
- 预期结果：
  - 真实模型被调用（turns > 0），vue-reviewer 交出结论，结论为 blocked。
  - URL 那处和 v-html 那处都被阻塞意见指到。
  - 没有阻塞意见指向 localStorage 模块那个文件。
  - 证据目录里有 `judgement.json`，写明各坑是否命中和全部 findings。
- [ ] `--only P18` 能选中这条验收
- [ ] P15、P16 用到的 `runSpecialistReview` 默认行为不变（不传新选项时 skillDirs 只有包内 `skills/`）
- [ ] P18 按 2 次判定规则通过
- [ ] 临时删掉 `examples/vue/agents/vue-reviewer.md` 正文里 auth-session 那一行，跑 2 次，至少 1 次 vue-reviewer 因 token 存 localStorage 列阻塞；之后改回
