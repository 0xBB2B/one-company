---
name: definition-body-rule
description: worker、专项审查、通用审查的职责规矩加上"定义正文写明某条 skill 不适用时按定义正文"，4 份样例定义正文写明 auth-session 第 15 条不适用
---
# 定义正文写明不适用的 skill 条目

## 目标
定义正文点名某份 skill 的某一条在本团队不适用时，worker 按定义正文写，专项审查、通用审查不因那一条打回；Go、Vue 样例的 4 份定义正文写明 auth-session 第 15 条不适用。

## 业务规则（来源：PRD definition-body-overrides-skill）
- 职责规矩是程序按职责固定加进提示词的流程规矩（`role-rules/*.md`），排在定义正文之后，冲突时以职责规矩为准；现在只写了"skills 的写法和项目规范（AGENTS.md）冲突时按项目规范"。
- worker：定义正文写明某条 skill 不适用时，按定义正文写，不按那一条。
- 专项审查：自己的定义正文写明某条 skill 不适用时，违反那一条但符合定义正文的，不算问题。
- 通用审查：核对已加载给自己的 skill 时，被审 worker 定义的正文写明某条不适用的，违反那一条但符合定义正文的，不算问题。原因：专项审查被关掉时，通用审查会拿到 worker 定义加载的 auth-session。
- 只有写明不适用的那一条被推翻，同一份 skill 的其他条目照常执行。
- go-worker、go-reviewer 正文写明 auth-session 第 15 条不适用，本团队 Web 端 token 存 localStorage；vue-worker、vue-reviewer 正文写明同一条不适用，access token 放运行时内存、refresh token 存 localStorage。
- 用户 2026-11-04 决定把冲突条目从样例 AGENTS.md 挪到定义正文。

## 涉及文件
- 修改 `role-rules/worker.md`
- 修改 `role-rules/reviewer-specialist.md`
- 修改 `role-rules/reviewer.md`
- 修改 `examples/golang/agents/go-worker.md`
- 修改 `examples/golang/agents/go-reviewer.md`
- 修改 `examples/vue/agents/vue-worker.md`
- 修改 `examples/vue/agents/vue-reviewer.md`
- 修改 `tests/role-rules.test.ts`
- 修改 `tests/spec-examples-files.test.ts`（或该文件里已有的样例定义检查所在的测试文件）

## 成品定义
提示词原文按下面落盘，不改写。

`role-rules/worker.md` 中现有这一行：

```
- 本任务加载了 skills 时，按其中的编码规范写、避开其中排查清单列出的问题；skills 的写法和项目规范冲突时按项目规范，"违反 skill 但符合项目规范"不算问题。
```

改成：

```
- 本任务加载了 skills 时，按其中的编码规范写、避开其中排查清单列出的问题；skills 的写法和项目规范冲突时按项目规范，"违反 skill 但符合项目规范"不算问题。定义正文写明某份 skill 的某一条在本团队不适用时，按定义正文写，不按那一条；同一份 skill 的其他条目照常遵守。
```

`role-rules/reviewer-specialist.md` 中现有这一行之后：

```
- skills 的写法和项目规范（任务说明里的 AGENTS.md）冲突时，按项目规范；"违反 skill 但符合项目规范"不算问题。
```

紧接着新增一行：

```
- 你的定义正文写明某份 skill 的某一条在本团队不适用时，违反那一条但符合定义正文的不算问题；同一份 skill 的其他条目照常核对。
```

`role-rules/reviewer.md` 中现有这一行：

```
- 核对 worker 定义加载的 skill：任务说明写明由专项审查核对的 skill，不在你的核对范围，也不因为看不到它们的正文列未验证；任务说明写明已加载给你的 skill，逐条核对，违反的列为阻塞。
```

改成：

```
- 核对 worker 定义加载的 skill：任务说明写明由专项审查核对的 skill，不在你的核对范围，也不因为看不到它们的正文列未验证；任务说明写明已加载给你的 skill，逐条核对，违反的列为阻塞。被审任务所用 worker 定义的正文写明其中某一条在本团队不适用时，违反那一条但符合定义正文的不算问题，其他条目照常核对。
```

`examples/golang/agents/go-worker.md`、`examples/golang/agents/go-reviewer.md` 正文末尾各新增一行：

```
- auth-session 第 15 条「登录 token 存在 localStorage 或 sessionStorage 里」在本团队不适用：本团队 Web 端的 token 存在 localStorage。
```

`examples/vue/agents/vue-worker.md`、`examples/vue/agents/vue-reviewer.md` 正文末尾各新增一行：

```
- auth-session 第 15 条「登录 token 存在 localStorage 或 sessionStorage 里」在本团队不适用：本团队 access token 放在运行时内存里，refresh token 存在 localStorage。
```

## 函数清单
无新增或修改的函数，只改提示词和样例定义文件。

## 协作关系
`loadRoleRules(role)`（`src/modules/agents/package-rules.ts`）读 `role-rules/<职责>.md`；`buildAgentPrompt`（`src/modules/agents/agent-session.ts`）把定义正文和职责规矩拼进提示词。样例定义由 `readRoleDefinition`（`src/modules/agents/roles.ts`）解析。

## 验证方式
- 测试入口：`loadRoleRules("worker" | "reviewer" | "reviewer-specialist")` 的返回文本；`readRoleDefinition` 读 `examples/<栈>/agents/<名字>.md` 得到的定义正文（或直接读文件文本）。
- 测试输入：仓库内的 `role-rules/` 与 `examples/` 文件。
- 预期结果：
  - worker 规矩含「定义正文写明某份 skill 的某一条在本团队不适用时，按定义正文写，不按那一条」和「同一份 skill 的其他条目照常遵守」。
  - reviewer-specialist 规矩含「你的定义正文写明某份 skill 的某一条在本团队不适用时，违反那一条但符合定义正文的不算问题」和「同一份 skill 的其他条目照常核对」。
  - reviewer 规矩含「被审任务所用 worker 定义的正文写明其中某一条在本团队不适用时，违反那一条但符合定义正文的不算问题」。
  - go-worker、go-reviewer、vue-worker、vue-reviewer 四份样例定义的正文都含 `auth-session 第 15 条` 和 `localStorage`；Vue 两份还含 `refresh token 存在 localStorage`。
  - 样例定义按用户层读取仍然可用，`skills` 名单不变（现有样例检查继续通过）。
- [ ] 三份职责规矩的单元测试通过
- [ ] 四份样例定义正文的单元测试通过
- [ ] `pnpm test` 全部通过
