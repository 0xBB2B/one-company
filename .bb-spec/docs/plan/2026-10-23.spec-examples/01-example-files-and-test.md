---
name: example-files-and-test
description: examples/golang、examples/vue 放进两套设计规范样例，新增单元测试检查样例定义有效、skill 都找得到、不和内置重名、主会话不可见
---
# 样例文件与样例检查测试

## 目标
仓库里有 `examples/golang/`、`examples/vue/` 两套设计规范样例，`pnpm test` 会检查它们一直能用。

## 业务规则（来源：PRD examples-readme-and-test）
- 设计规范样例是 `examples/<栈>/` 下的一套文件：`AGENTS.md`（团队关键设计决定）、`skills/<名字>/SKILL.md`（详细规范）、`agents/<栈>-worker.md` 和 `agents/<栈>-reviewer.md`（和内置专项定义同名的角色定义）。
- C-1：`examples/golang/` 有 `AGENTS.md`；`skills/` 下恰好 10 个目录：api-design、auth-constraints、authz-constraints、config-constraints、database-constraints、golang-constraints、golang-testing、observability-constraints、service-constraints、version-policy，每个目录只有一份 `SKILL.md`；`agents/` 下恰好 `go-worker.md`、`go-reviewer.md`。
- C-2：`examples/vue/` 有 `AGENTS.md`；`skills/` 下恰好 3 个目录：frontend-constraints、version-policy、vue-constraints，每个目录只有一份 `SKILL.md`；`agents/` 下恰好 `vue-worker.md`、`vue-reviewer.md`。
- C-3：每个文件和来源目录 `/Users/bb/Projects/skills/golang/`、`/Users/bb/Projects/skills/vue/` 下同一相对路径的文件逐字节相同；唯一例外是 golang-testing 里"测试夹具"改成"测试素材"（见成品定义）。改完后 `examples/` 下没有"夹具"二字。来源目录在仓库外，测试不读它；C-3 在实现时用 `diff -r` 核对一次。
- C-4：4 份样例定义能被 one-company 读成有效的角色定义；`*-worker` 职责是 worker，`*-reviewer` 职责是 reviewer。
- C-5：每份样例定义 skills 名单里的每个名字，都能在包内 `skills/<名字>/SKILL.md` 或同一样例的 `skills/<名字>/SKILL.md` 找到；找不到时失败信息写出定义文件名和 skill 名。
- C-6：同栈的 worker、reviewer 样例定义 skills 名单完全相同，顺序也相同。
- C-7：每份样例定义 skills 名单的开头几项，和包内 `agents/` 下同名内置定义的 skills 名单完全相同，顺序也相同。
- C-8：样例自带的 13 份 skill 不和包内 `skills/` 下任何目录重名；重名时失败信息写出重名的名字。原因：skill 按项目层 → 用户层 → 包内的顺序找，重名的样例 skill 复制到用户层会替换内置 skill。
- C-9：样例自带的每份 skill 都能被 pi 读成 skill，没有任何警告；设置段 name 等于目录名；设置段写了 `disable-model-invocation: true`。
- C-10：C-4 到 C-9 由 `pnpm test` 自动检查。

## 涉及文件
- `examples/golang/AGENTS.md` 新建（从来源复制）
- `examples/golang/skills/<10 个目录>/SKILL.md` 新建（从来源复制，golang-testing 改一行）
- `examples/golang/agents/go-worker.md`、`go-reviewer.md` 新建（从来源复制）
- `examples/vue/AGENTS.md`、`examples/vue/skills/<3 个目录>/SKILL.md`、`examples/vue/agents/vue-worker.md`、`vue-reviewer.md` 新建（从来源复制）
- `tests/spec-examples.test.ts` 新建

## 成品定义
复制方式：`cp -R /Users/bb/Projects/skills/golang examples/golang`、`cp -R /Users/bb/Projects/skills/vue examples/vue`（先确认来源里没有 `.DS_Store` 之类的多余文件，有就不复制）。

`examples/golang/skills/golang-testing/SKILL.md` 里唯一要改的一行，改后全文如下：

```markdown
- 跨文件共享的测试素材（fixture / mock / builder）放在被测包内的 **正式 `.go`** 文件里（如 `testing.go`，用 `//go:build test` 或单独子包），不要藏在游离的 `_test.go`
```

## 函数清单
### tests/spec-examples.test.ts
| 函数名 | 职责 |
|---|---|
| `exampleDir` | 给出 `examples/<栈>/` 的绝对路径（相对包根，写法同 `tests/role-catalog.test.ts` 里定位包内目录的方式） |
| `exampleSkillNames` | 列出某个样例 `skills/` 下的目录名 |
| `builtinSkillNames` | 列出包内 `skills/` 下的目录名 |

## 协作关系
- 读定义用 `src/modules/agents/roles.ts` 的 `loadRoleCatalog`：`defaultDir` 传 `defaultRoleDir()`，`userDir` 传样例的 `agents/` 目录，`projectDir` 传不存在的路径，`parseFrontmatter` 用 `@earendil-works/pi-coding-agent` 导出的。这样同名的样例定义按用户层替换内置定义，和用户实际复制后的效果一样。
- 内置定义的 skills 名单用同一个函数只传 `defaultDir` 读出。
- 读 skill 用 `@earendil-works/pi-coding-agent` 导出的 `loadSkillsFromDir({ dir, source })`，看返回的 `skills`（`name`、`disableModelInvocation`）和 `diagnostics`。
- 不新增依赖；pi 已在 `package.json` 的 devDependencies 里。

## 验证方式
- 测试入口：`pnpm exec vitest run tests/spec-examples.test.ts`，以及 `pnpm test`。
- 测试输入：仓库里的 `examples/golang/`、`examples/vue/`，包内的 `agents/`、`skills/`。
- 预期结果：
  - 两个样例的文件清单恰好等于 C-1、C-2。
  - `examples/` 下所有文件都不含"夹具"。
  - 用 one-company 的定义读取逻辑，把样例 `agents/` 当用户层读：go-worker、go-reviewer（vue 同理）来源是 user、可用，职责分别是 worker、reviewer。
  - 每份样例定义的每个 skill 都能在包内 `skills/` 或同一样例 `skills/` 找到。
  - 同栈 worker、reviewer 的名单相同；名单开头等于同名内置定义的名单。
  - 样例 skill 名和包内 skill 名没有交集。
  - pi 读样例 `skills/` 目录：diagnostics 为空，每份 skill 的 name 等于目录名，`disableModelInvocation` 为 true，读出的 skill 数分别是 10 和 3。
- 错误场景（在临时目录里复制一份样例改坏后用同样的检查函数跑，或实现时手动改坏再改回）：名单里写错一个 skill 名 → 失败信息含定义文件名和该 skill 名；样例 skill 改名成 `go-coding` → 失败信息含 `go-coding`。
- [ ] `pnpm exec vitest run tests/spec-examples.test.ts` 通过
- [ ] `diff -r /Users/bb/Projects/skills/golang examples/golang` 只有 golang-testing 那一行不同；`diff -r /Users/bb/Projects/skills/vue examples/vue` 没有输出
- [ ] `pnpm test` 全部通过
