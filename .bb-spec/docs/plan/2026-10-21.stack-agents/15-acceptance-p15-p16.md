---
name: acceptance-p15-p16
description: 新增 P15（Go）、P16（Vue）两条真实模型单点验收：样例项目埋 5 个坑，专项审查须全部列为阻塞并指到文件和行号
---
# 专项审查的真实模型验收

## 目标
用真实模型证明 go-reviewer、vue-reviewer 能把样例项目里埋的已知问题找出来。

## 业务规则（来源：PRD skills-and-acceptance C-7）
- 两条验收放在 `tests/acceptance/points/`，用例名分别以「P15：」「P16：」开头（`run-parallel.ts` 按用例名冒号前的编号认），跑法和判定与现有单点验收相同：同一提交先同时跑 2 次，都过算通过，一过一不过跑第 3 次。
- P15（Go）：一个执行定义是 go-worker 的任务（程序自动挂上 go-reviewer），worker 的改动里埋 5 个坑：用 `http.Get` 发请求没有超时；往没有 make 的 map 里写数据；多个 goroutine 不加锁写同一个 map；用字符串拼接把用户输入拼进 SQL；用 `DEL` 直接释放 Redis 分布式锁、不比对 token。PM 派审查后，判定看 go-reviewer 那一份结论。
- P16（Vue）：一个执行定义是 vue-worker 的任务（自动挂上 vue-reviewer），埋 5 个坑：用 `v-html` 渲染用户评论；`:href` 直接绑定用户填的链接；`onMounted` 里 `window.addEventListener`、`onUnmounted` 没移除；路由守卫里按用户角色放行管理页，后端接口不校验权限；解构 `reactive()` 的返回值后在模板里使用。判定看 vue-reviewer 那一份结论。
- 通过条件：专项审查结论是打回；5 个坑每个都有一条阻塞意见，意见的文件就是埋坑的文件、行号落在埋坑那几行里。

## 涉及文件
- 新建 `tests/acceptance/points/p15-go-reviewer-pitfalls.test.ts`
- 新建 `tests/acceptance/points/p16-vue-reviewer-pitfalls.test.ts`
- 新建 `tests/acceptance/helpers/point-review.ts`
- 修改 `tests/helpers/run-manager-fixture.ts`（`createPmRunWorld` 新增 `skillDirs` 选项，默认包含包内 `skills/`；`loadRoleCatalog` 默认包含包内 `agents/`）

## 函数清单
### tests/acceptance/helpers/point-review.ts
| 函数名 | 职责 |
|---|---|
| `SeededPit`（类型） | 一个坑：文件路径、内容里埋坑的起止行、说明 |
| `runSpecialistReview` | 搭场景并跑一轮审查：建世界（`createPmRunWorld`，带包内 skills 和定义）、提交基线、提交计划（任务 agent 为指定专项 worker、writePaths 覆盖样例目录）、确认、派 worker；worker 请求由脚本用 `change_apply` 写入埋坑文件后交结论；PM 请求一律回「收到」；派审查（`dispatchTask` 带 `review: { maxTurns }`）；专项审查的请求交给真实模型（`createRealModel`），通用 reviewer 的请求由脚本直接交 clear 结论；按 `request.systemPrompt` 开头的定义正文区分两者；等两个审查运行都结束 |
| `specialistVerdict` | 从 VERDICTS 表里找出 `RunRecord.agent.name` 为指定专项审查的那次运行的结论 |
| `pitCoverage` | 解析每条阻塞意见 targetRef 里的「文件:行号」，判断每个坑是否被命中，返回命中表 |

### tests/acceptance/points/p15-go-reviewer-pitfalls.test.ts
| 函数名 | 职责 |
|---|---|
| `GO_PITS` | 5 个坑的样例文件（各一个文件，放在 `svc/` 下：client.go、cache.go、counter.go、store.go、lock.go，外加最小 go.mod `go 1.22`）和埋坑行号 |
| 用例「P15：go-reviewer 把 Go 样例里埋的 5 个坑都列为阻塞并指到文件和行号」 | 调 `runSpecialistReview("go-worker", "go-reviewer", GO_PITS)`，写 judgement.json，断言结论为 blocked 且 5 个坑全部命中 |

### tests/acceptance/points/p16-vue-reviewer-pitfalls.test.ts
| 函数名 | 职责 |
|---|---|
| `VUE_PITS` | 5 个坑的样例文件（`web/src/components/Comment.vue`、`Profile.vue`、`ResizeWatcher.vue`、`Counter.vue`，`web/src/router/index.ts`，另附 `web/server/admin-api.ts` 写一个不查权限的管理接口供路由守卫那条参照）和埋坑行号（路由守卫的坑以 router 文件的守卫行为准） |
| 用例「P16：vue-reviewer 把 Vue 样例里埋的 5 个坑都列为阻塞并指到文件和行号」 | 同 P15 |

## 协作关系
沿用 P9、P10 的写法：`acceptanceConfig()` 门槛、`test.skipIf(!config || process.platform !== "darwin")`、`pointEvidence(config, "p15")`、`createRealModel(...).close(evidence)`、`tests/acceptance/helpers/point-pm.ts` 的 `taskKey`、`call`、`messageText`。依赖产品侧全部完成：内置专项定义、19 份 skill、同栈自动挂审查、整轮派出审查、专项审查规矩。

## 验证方式
- 测试入口：`ONE_COMPANY_ACCEPTANCE_MODEL=<提供方>/<模型> ONE_COMPANY_ACCEPTANCE_OUTPUT=<绝对路径> pnpm run test:acceptance:parallel --only P15 P16`
- 测试输入：用例内联的样例文件；真实模型配置由用户提供
- 预期结果：两条都按 2+1 规则判定通过；judgement.json 里列出 5 个坑各自命中的意见
- 没有配置真实模型时：两条用例被跳过，`pnpm test` 不受影响；此时在 exec 结果里标为"未验证"，请用户提供模型配置后再跑
- [ ] 不配置模型时 `pnpm test` 和 `pnpm run typecheck` 通过；`vitest list tests/acceptance` 能列出 P15、P16
- [ ] 配置模型后 P15、P16 通过
