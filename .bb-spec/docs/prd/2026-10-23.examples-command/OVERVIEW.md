---
name: examples-command
description: 新增 /one:examples 命令，选一套设计规范样例和一层，复制 skills、角色定义并追加 AGENTS.md 那一段，能认出已经复制过
date: 2026-10-23
features: [spec-examples]
---

# /one:examples 一键复制设计规范样例

## 背景与问题
- 包里的 `examples/golang/`、`examples/vue/` 各有一套设计规范样例，分三类文件：并进 `AGENTS.md` 的关键设计决定、详细规范 skill、和内置专项定义同名的角色定义。
- 现在用户要照 README 手工做三件事：把十来个 skill 目录逐个复制到 `~/.pi/agent/skills/` 或 `.pi/skills/`，把两份定义复制到 `~/.pi/agent/agents/` 或 `.pi/agents/`，再把一段 `AGENTS.md` 内容手工并进去。目录多，容易漏一个；样例装在 `~/.pi/agent/git/github.com/0xBB2B/one-company/examples/` 这种很深的路径里，不好找。
- 复制过一次以后，用户也说不清哪些已经复制、哪些被自己改过；再手工复制一遍，可能把自己改过的文件覆盖掉。

## 目标
- 用户输入 `/one:examples`，选样例、选层、确认，就能把三类文件一次放到位。
- 每个样例在每一层的状态一眼能看到：没复制、复制了一部分、全部复制且一致、有文件被改过。
- 用户改过的文件一律不覆盖，并在确认窗口和结果提示里列出来。
- `AGENTS.md` 只在用户看过差异、选「写入」后才改，合并后超过 16 KB 就不写。

## 非目标
- 删除或撤销已复制的样例：删掉对应文件即可。
- 覆盖用户改过的文件，或把样例的新版本合并进用户改过的文件。
- 只复制样例的一部分（例如只要 skills、不要定义）。
- Go、Vue 之外技术栈的样例。
- 改样例内容、内置角色定义或内置 skill。

## 子需求清单
| 序号 | 子需求 | 解决的子问题 | 优先级 |
|---|---|---|---|
| 01 | [选样例、选层、复制文件](01-choose-and-copy.md) | 命令的界面流程，skills 和定义怎么判状态、怎么复制、结果怎么报 | P0 |
| 02 | [追加 AGENTS.md 那一段](02-agents-md-section.md) | 认出已有的那一段，追加前给看差异、超限不写 | P0 |
| 03 | [发布包与文档](03-package-and-docs.md) | 装好的包里有 `examples/`，README 和 ARCHITECTURE.md 跟上命令 | P0 |

## 依赖与交付顺序
01 → 02（02 在 01 的确认窗口之后执行）；03 可与 01、02 并行。

## 整体验证路径
1. 在一个受信任的 Go 项目里打开 pi，输入 `/one:examples` → 窗口列出 golang（Go 后端）和 vue（Vue 前端），各自写着用户层、项目层的状态。
2. 选 golang → 选用户层 → 确认窗口列出 10 个 skill、2 份定义会新复制，AGENTS.md 会追加「## 后端设计约定」→ 选「复制」→ 差异窗口显示新增的那一段 → 选「写入」→ 结果提示「新复制 12 个文件，AGENTS.md 已写入」。
3. 再输入 `/one:examples` → golang 一行显示「用户层：已复制」；选 golang 后，用户层一行变暗，写着「已全部复制，和样例一致」。
4. 改动 `~/.pi/agent/skills/api-design/SKILL.md` 里任意一个字，再运行 → golang 一行显示「用户层：有改动」；选用户层后确认窗口把 api-design 列为「被改过，跳过」；复制后文件内容仍是改过的样子。
5. 派一个用 go-worker 的任务 → 派出的 go-worker 用的是用户层那份定义，带上样例自带的 skill。

## 决策记录
- 选哪一层，三类文件就一起放到哪一层：用户层是 `~/.pi/agent/skills/`、`~/.pi/agent/agents/`、`~/.pi/agent/AGENTS.md`；项目层是仓库内 `.pi/skills/`、`.pi/agents/` 和仓库根目录 `AGENTS.md`。否决"AGENTS.md 固定写项目层"：skills 和定义放用户层时，规范却只在一个项目里生效，两边对不上。用户 2026-10-23 决定。
- 合并后超过 16 KB 时，AGENTS.md 不写，skills 和定义照常复制：16 KB 是现有项目规范的上限（`project-conventions.ts:10` `MAX_CONVENTIONS_BYTES`），因为规范全文会进每个子代理的上下文；用户级那份同样进（`project-conventions.ts:28-35`），所以两层用同一个上限。否决"超限就整个不复制"：skills 和定义不占规范的大小。用户 2026-10-23 决定。
- 用户改过的文件跳过并列出来，不覆盖、不问：用户改样例就是要换成自己团队的规范，覆盖会丢掉这些改动。用户 2026-10-23 决定。
- 用户级 `AGENTS.md` 和项目层一样，经差异窗口确认后写，用同一个 16 KB 上限。这推翻了 README 里"`~/.pi/agent/AGENTS.md` 本包只读不写"的说法：那句来自 README 改版（commit 7004253），没有对应的需求决定。用户 2026-10-23 决定。
- 差异窗口只有「写入」「不写入」：现有窗口的「其他（输入修改意见）」是让主代理按意见改了再提交的，命令里没有模型来改。
- `package.json` 的 `files` 加上 `examples`：命令运行时要读包里的 `examples/`。用 `pi install git:…` 安装时整个仓库都会被 clone 下来，但用打包的方式装（安装测试里就是先 `pnpm pack` 再装，`tests/installation/requirement-manage.test.ts:46-53`），包里只有 `files` 列出的目录；包名 `@0xbb2b/one-company` 没有标 private（`package.json:2`），可以发到 npm。这推翻了 2026-10-23.spec-examples 的非目标"不改 `files`"。用户 2026-10-23 决定。
- 2026-10-23.spec-examples 的非目标"用命令一键复制样例，另起需求做"，就是本需求。功能名沿用 `spec-examples`，按那份 PRD 的决定。
- 以下几条是写 PRD 时按确认过的预览和现有代码定的，用户在确认 PRD 时一并认可或推翻：
  - 样例列表里的中文名用一张固定的表（golang → Go 后端、vue → Vue 前端），新增样例时同时加一行，测试检查每个样例目录都有中文名。否决"从样例文件里读名字"：样例 `AGENTS.md` 的标题是「后端设计约定」，不是给列表用的名字；在 `examples/` 下再加说明文件，违背 spec-examples"`examples/` 下只放样例本身"的决定。
  - 一层算「已复制」，要求 skills、定义全部和样例一致，而且 `AGENTS.md` 那一段已经在、也一致。只有这样，上次因为超限没写进去的那一段，下次运行才还能选这一层补写。
  - 「项目层已有同名定义，用户层这份不生效」的提醒只在项目受信任时出现：项目未受信任时 pi 不加载项目层定义（`settings-extension.ts:80-82` 把 `projectTrusted` 传给 `loadRoleCatalog`），生效的就是用户层那份。
  - 项目层的三个目标都在主仓库目录下，在 worktree 里打开 pi 时也是：和设置页复制定义、存设置用的是同一个目录（`settings-extension.ts:23` `primaryWorktreeRoot`）。
  - 确认期间 `AGENTS.md` 被别处改了就不写，沿用现有项目规范写入的做法（`project-conventions.ts:94` `changed_concurrently`）。
- 实现后补两处写法：只有一个定义要新复制时，开关那句写「<名字> 现在是开启」，不写「现在都是」；结果提示里「被改过、没有覆盖」那一行以「。」结尾，和确认过的预览一致。用户 2026-10-23 决定。
