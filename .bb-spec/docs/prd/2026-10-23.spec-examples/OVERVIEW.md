---
name: spec-examples
description: 仓库新增 Go 后端、Vue 前端两份设计规范样例，README 写明怎么复制到自己的项目，单元测试守住样例和内置 skill 对得上
date: 2026-10-23
features: [spec-examples]
---

# Go、Vue 设计规范样例

## 背景与问题
- 包里内置的专项定义（如 go-worker、vue-reviewer）只带通用的编码规范和排查清单 skill，不知道某个团队自己的设计决定，例如"分层只用 handler → service → repository""错误码格式是 A-BBB-CCCC""refresh token 存在 localStorage"。
- 团队想让专项代理按自己的规范干活，要自己写三样东西：一段写进项目 `AGENTS.md` 的关键设计决定、几份详细规范 skill、一份和内置定义同名、在 skills 名单里加上这些 skill 的定义。现在包里没有任何现成的样子可以照着改，只能从零写。
- 用户已经从 bb-spec 的后端、前端规范整理出两套现成内容，放在仓库外的目录里：Go 后端一套（AGENTS.md 要点、10 份 skill、go-worker 和 go-reviewer 两份同名定义），Vue 前端一套（AGENTS.md 要点、3 份 skill、vue-worker 和 vue-reviewer 两份同名定义）。

## 目标
- 仓库的 `examples/golang/`、`examples/vue/` 各放一套设计规范样例，内容就是上面两套，用户照抄就能用，照着改就能换成自己团队的规范。
- README 写明样例在哪、三类文件各复制到哪、同名定义会替换内置定义。
- 单元测试守住样例：内置 skill 改名、样例定义写错时，`pnpm test` 报错，而不是等用户照抄后派工时才发现"找不到 skill"。

## 非目标
- 用命令一键复制样例（`/one:examples`），另起需求做。
- Go、Vue 之外技术栈的样例。
- 改内置的专项定义、内置 skill，或任何产品代码和提示词。
- 改 `package.json` 的 `files`：用 `pi install git:…` 安装时，pi 把整个仓库 clone 下来，`examples/` 本来就在装好的包里。

## 子需求清单
| 序号 | 子需求 | 解决的子问题 | 优先级 |
|---|---|---|---|
| 01 | [样例、README 与测试](01-examples-readme-and-test.md) | 放进两套样例，README 写明用法，测试守住样例能用 | P0 |

## 依赖与交付顺序
单一子需求，无依赖。

## 整体验证路径
1. 在仓库根目录执行 `ls examples/golang examples/vue` → 两个目录下各有 `AGENTS.md`、`skills/`、`agents/`。
2. 执行 `pnpm test` → 全部通过，其中包括检查样例的测试。
3. 把 `examples/golang/agents/go-worker.md` 里的 `go-pitfalls` 改成 `go-pitfall` 再跑 `pnpm test` → 检查样例的测试失败，并写出 `go-worker` 和 `go-pitfall`；改回后通过。
4. 打开 README → 有一节写明样例在哪、三类文件各复制到哪、复制同名定义会替换内置定义。

## 决策记录
- 样例放进本仓库，不单独开仓库：样例的定义引用内置 skill 的名字，放在同一个仓库里，内置 skill 改名时测试能立刻发现。用户 2026-10-21 决定。
- 等 stack-agents 合并后再放：样例定义引用的 go-coding、vue-pitfalls 等内置 skill 是 stack-agents 加进来的，先发布样例，用户照抄后派工会报"找不到 skill"。用户 2026-10-21 决定；stack-agents 已于 2026-10-23 以 PR #52 合并。
- 用法步骤只写在 README 一处，`examples/` 下只放样例本身：步骤只有一份，改的时候不会漏。否决"每个样例目录再放一份 README"：同样的步骤要写三遍。用户 2026-10-23 决定。
- 加单元测试守住样例：否决"只靠这次人工核对"，因为以后内置 skill 改名时没人会发现样例坏了。用户 2026-10-23 决定。
- 样例 golang-testing 里的"测试夹具"改成"测试素材"：按仓库 `AGENTS.md` 写文档的规矩，泛指测试材料叫"测试素材"。用户 2026-10-23 决定。
- README 里写的安装位置 `~/.pi/agent/git/github.com/0xBB2B/one-company/` 有出处：pi 1.3.0 的 `dist/core/package-manager.js` 里，用户级 git 包装在 `~/.pi/agent/git/<主机>/<路径>` 下（`getGitInstallRoot`、`resolveManagedPath`），`dist/utils/git.js` 把 `github.com/0xBB2B/one-company` 的路径解析成 `0xBB2B/one-company`。
- 测试里的 C-7（样例定义名单开头和内置定义的名单完全相同）、C-8（样例 skill 不和内置 skill 重名）是写 PRD 时补的，用户在确认 PRD 时一并认可。
- 功能名用新名 `spec-examples`，`/one:examples` 命令以后也沿用，查样例相关的需求时一次就能搜全。否决沿用 `stack-agents`：复制命令和专项代理关系不大，挂在那个名字下不好找。用户 2026-10-23 决定。
