---
name: examples-readme-and-test
description: examples/ 下放 Go、Vue 两套设计规范样例，README 写明三类文件各复制到哪，单元测试检查样例定义和 skill 都能用
date: 2026-10-23
---

# 样例、README 与测试

几个词先说清：
- 设计规范样例：`examples/<栈>/` 下的一套文件，分三类。一是 `AGENTS.md`，写团队关键设计决定，供用户并进自己项目的 `AGENTS.md`；二是 `skills/`，放详细规范，每份是一个目录加一份 `SKILL.md`；三是 `agents/`，放和内置专项定义同名的角色定义，skills 名单里在内置 skill 后面加上样例自带的 skill。
- 同名定义替换：角色定义同名时按项目层（仓库内 `.pi/agents/`）→ 用户层（`~/.pi/agent/agents/`）→ 包内的顺序取，所以把样例里的 `go-worker.md` 放进用户层后，派工用的 go-worker 就是这一份。
- 主会话不可见：skill 设置段写了 `disable-model-invocation: true`，pi 主窗口的模型看不到它，只有点名它的子代理会拿到全文。

## 用户故事
### P0：作为想让专项代理按团队规范干活的用户，我想要一套能照抄的设计规范样例，以便不用从零写 AGENTS.md、skill 和同名定义
**用例（主路径）**
- 场景：一个 Go 后端团队装好了 one-company，想让 go-worker 和 go-reviewer 按"handler → service → repository 分层、UUIDv7 主键"这类团队规范写和审。
- 操作：按 README 那一节，把 `~/.pi/agent/git/github.com/0xBB2B/one-company/examples/golang/skills/` 下的 10 个目录复制到 `~/.pi/agent/skills/`，把 `agents/` 下的两份定义复制到 `~/.pi/agent/agents/`，把 `AGENTS.md` 的内容并进自己仓库根目录的 `AGENTS.md`。
- 预期：`/one:setting` 的角色定义列表里，go-worker 和 go-reviewer 的来源显示为用户层；详情里的 skills 有 19 份；PM 派 go-worker 时不报"找不到 skill"。

**用例（异常：内置 skill 改了名）**
- 场景：以后有开发者把内置的 `go-pitfalls` 改名为 `go-traps`，没改样例。
- 操作：执行 `pnpm test`。
- 预期：检查样例的测试失败，写明是 `examples/golang/agents/go-worker.md` 和 `go-reviewer.md` 引用的 `go-pitfalls` 找不到。

### P0：作为用户，我想要在 README 里看清复制同名定义的后果，以便知道复制后内置定义和开关会怎样
**用例（主路径）**
- 场景：用户读 README 的样例那一节。
- 操作：读到 agents 那一步。
- 预期：README 写明复制后同名的内置定义被替换，删掉复制的文件就恢复用内置的；开关按定义名记，复制前关掉的复制后照样关着，删掉复制的文件后开关状态留给内置那一份。

## 约束
- C-1：`examples/golang/` 下有 `AGENTS.md`；`skills/` 下有 10 个目录：api-design、auth-constraints、authz-constraints、config-constraints、database-constraints、golang-constraints、golang-testing、observability-constraints、service-constraints、version-policy，每个目录一份 `SKILL.md`；`agents/` 下有 `go-worker.md`、`go-reviewer.md`。
- C-2：`examples/vue/` 下有 `AGENTS.md`；`skills/` 下有 3 个目录：frontend-constraints、version-policy、vue-constraints，每个目录一份 `SKILL.md`；`agents/` 下有 `vue-worker.md`、`vue-reviewer.md`。
- C-3：C-1、C-2 的每个文件，内容和用户整理好的来源（`/Users/bb/Projects/skills/golang/`、`/Users/bb/Projects/skills/vue/` 下同一相对路径的文件）逐字节相同，只有一处例外：`examples/golang/skills/golang-testing/SKILL.md` 里的"测试夹具"改成"测试素材"，同一行其余文字不变。改完后 `examples/` 下没有"夹具"二字。
- C-4：4 份样例定义都能被 one-company 读成有效的角色定义；`go-worker`、`vue-worker` 的职责是 worker，`go-reviewer`、`vue-reviewer` 的职责是 reviewer。
- C-5：每份样例定义的 skills 名单里，每个名字都能在包内 `skills/<名字>/SKILL.md` 或同一样例的 `skills/<名字>/SKILL.md` 找到。找不到时测试失败，失败信息写出定义文件名和找不到的 skill 名。
- C-6：同一个栈的 worker 和 reviewer 样例定义，skills 名单完全相同（顺序也相同）。
- C-7：每份样例定义的 skills 名单，开头几项和包内同名内置定义的 skills 名单完全相同（顺序也相同），后面才是样例自带的 skill。
- C-8：样例自带的 13 份 skill，名字都不和包内 `skills/` 下的任何一个目录重名。重名时测试失败，失败信息写出重名的名字。原因：skill 按项目层 → 用户层 → 包内的顺序找，重名的样例 skill 复制到用户层后会替换掉同名的内置 skill。
- C-9：样例自带的每份 skill 都能被 pi 读成 skill，没有任何警告；设置段的 name 和所在目录名相同；设置段写了 `disable-model-invocation: true`。
- C-10：C-4 到 C-9 由 `pnpm test` 自动检查。
- C-11：README 在「设置」和「原理」两个二级标题之间新增二级标题「设计规范样例」，原有二级标题的顺序不变。这一节写明这几件事：
  - 有 Go 后端（`examples/golang/`）和 Vue 前端（`examples/vue/`）两套样例，各自包含哪三类文件、各是干什么的。
  - 样例在哪：用 `pi install git:github.com/0xBB2B/one-company` 装好后在 `~/.pi/agent/git/github.com/0xBB2B/one-company/examples/`，也可以在仓库网页上看。
  - skills 下的每个目录复制到 `~/.pi/agent/skills/`（对你的所有项目生效）或仓库内 `.pi/skills/`（只对这个项目生效，项目在 pi 里设为受信任后才加载）。
  - agents 下的定义复制到 `~/.pi/agent/agents/` 或仓库内 `.pi/agents/`，规则同上；复制后同名的内置定义被替换，删掉复制的文件就恢复用内置的；`/one:setting` 里的开关按定义名记：复制前关掉的，复制后照样关着；删掉复制的文件后，开关状态留给内置那一份。
  - `AGENTS.md` 的内容并进自己仓库根目录的 `AGENTS.md`；其中和内置 skill 写法冲突的条目，代理按 `AGENTS.md` 执行。
  - 样例是一个团队的规范，照抄前先按自己团队的做法改。
- C-12：README 开头的目录导航加上「设计规范样例」这一节的链接。

## 验收
- [ ] C-1：`ls -R examples/golang` 列出的文件和 C-1 一致。
- [ ] C-2：`ls -R examples/vue` 列出的文件和 C-2 一致。
- [ ] C-3：逐个文件和来源比对，除 golang-testing 那一行外全部相同；`grep -rn 夹具 examples/` 没有输出。
- [ ] C-4：测试用 one-company 读定义的同一套逻辑读 4 份样例定义，都有效，职责符合 C-4。
- [ ] C-5：测试通过；把任一样例定义里的一个内置 skill 名改错，测试失败并写出定义文件名和那个 skill 名。
- [ ] C-6：测试通过；改动一份 reviewer 样例定义的 skills 名单顺序，测试失败。
- [ ] C-7：测试通过；删掉一份样例定义名单里的一个内置 skill，测试失败。
- [ ] C-8：测试通过；把一份样例 skill 的目录名和设置段 name 都改成 `go-coding`，测试失败并写出 `go-coding`。
- [ ] C-9：测试通过；删掉一份样例 skill 设置段里的 `disable-model-invocation: true`，测试失败。
- [ ] C-10：`pnpm test` 全部通过，输出里包含检查样例的测试。
- [ ] C-11：README 的二级标题里「设计规范样例」排在「设置」之后、「原理」之前，README 现有测试全部通过；这一节逐项写到 C-11 列出的内容，其中的目录路径和代码里实际查找的目录一致（skill：仓库内 `.pi/skills`，受信任才加载、`~/.pi/agent/skills`、包内 `skills`；定义：仓库内 `.pi/agents`、`~/.pi/agent/agents`、包内 `agents`）。
- [ ] C-12：README 开头的目录导航有这一节的链接，点击能跳到这一节。

## 验证路径
1. `ls -R examples` → 文件清单和 C-1、C-2 一致。
2. `grep -rn 夹具 examples/` → 没有输出。
3. `pnpm test` → 全部通过。
4. 把 `examples/vue/agents/vue-reviewer.md` 名单里的 `vue-pitfalls` 改成 `vue-pitfall`，再跑检查样例的测试 → 失败，写出 `vue-reviewer` 和 `vue-pitfall`；改回后通过。
5. 打开 README，从开头目录导航点「设计规范样例」→ 跳到这一节，逐项对照 C-11。
