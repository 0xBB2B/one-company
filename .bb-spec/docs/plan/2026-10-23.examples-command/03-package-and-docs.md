---
name: package-and-docs
description: package.json 的 files 加 examples，README 和 ARCHITECTURE.md 改成用 /one:examples 复制样例
---
# 发布包与文档

## 目标
打包后的包里有 `examples/`；README 写明 `/one:examples` 怎么用、复制到哪；去掉"本包只读不写""程序不读"这两处过期说法。

## 业务规则（来源：PRD package-and-docs）
- `package.json` 的 `files` 包含 `examples`，打包清单里有两套样例的全部文件（`examples/golang/AGENTS.md`、`examples/vue/AGENTS.md` 等）。
- README 命令表加一行 `/one:examples`：「把 Go、Vue 设计规范样例复制到用户层或项目层」。
- README「设计规范样例」一节整节换成下面的成品，写明：两套样例与三类文件；运行命令依次选样例、选层、确认，每个样例写着两层的状态；两层各放到哪；改过的文件不覆盖；AGENTS.md 先看差异、超 16 KB 不写；同名替换与开关按定义名记；复制后按团队做法改。
- README 里 `~/.pi/agent/AGENTS.md` 那一行（「原理」下「规矩从哪来」那张表）的说明改为「你的个人规范；`/one:examples` 经你确认后会在末尾追加样例那一段」。
- ARCHITECTURE.md 第 24 行「`examples/` 是给用户照着改的 Go、Vue 设计规范样例，程序不读。」改为「`examples/` 是 Go、Vue 设计规范样例，`/one:examples` 把它们复制到用户层或项目层。」
- 文档测试检查 README 里有 `/one:examples`；原有检查（`examples/golang/`、`examples/vue/`、`~/.pi/agent/git/github.com/0xBB2B/one-company/examples/`、`~/.pi/agent/skills/`、`.pi/skills/`、`~/.pi/agent/agents/`、`.pi/agents/`、导航链接、二级标题顺序）照常通过。

## 涉及文件
- `package.json`（修改：`files` 按字母序在 `assets` 前后合适位置加 `"examples"`）
- `README.md`（修改：命令表、「设计规范样例」一节、`~/.pi/agent/AGENTS.md` 那一行）
- `ARCHITECTURE.md`（修改：第 24 行那句）
- `tests/user-documentation.test.ts`（修改：REQUIRED 加 `/one:examples`）
- `tests/installation/requirement-manage.test.ts`（修改：打包清单断言加两套样例的 `AGENTS.md` 和 `examples/golang/agents/go-worker.md`、`examples/vue/skills/vue-constraints/SKILL.md`）

## 成品定义
README 命令表（替换原表）：

```markdown
| 命令 | 用途 |
|---|---|
| `/one:setting` | 查看和复制角色定义，改 PM 和两个内部代理的模型，选 Git 交付档位和合并方式 |
| `/one:examples` | 把 Go、Vue 设计规范样例复制到用户层或项目层 |
| `/one:ps` | 查看和停止终端命令任务 |
```

README「设计规范样例」一节（从 `## 设计规范样例` 到 `---` 之前，整段替换）：

```markdown
## 设计规范样例

包里带了两套设计规范样例，演示怎么让专项 worker 和专项审查按你团队自己的规范写代码和审查。

| 样例 | 目录 |
|---|---|
| Go 后端 | `examples/golang/` |
| Vue 前端 | `examples/vue/` |

每套样例有三类文件：

- `AGENTS.md`：团队的关键设计决定，比如分层怎么分、错误码长什么样、token 存在哪。PM、worker、reviewer 都会读用户级和仓库根目录的 `AGENTS.md`。
- `skills/`：详细规范，每个目录是一份 skill。每份 `SKILL.md` 的头部写了 `disable-model-invocation: true`，pi 主窗口的模型看不到它们，只有在定义里点名它们的子代理会拿到全文。
- `agents/`：和内置专项定义同名的角色定义（Go 样例是 go-worker、go-reviewer，Vue 样例是 vue-worker、vue-reviewer）。skills 名单先列内置定义原有的 skill，后面加上样例自带的 skill。

用 `pi install git:github.com/0xBB2B/one-company` 装好后，样例在 `~/.pi/agent/git/github.com/0xBB2B/one-company/examples/`，也可以在仓库网页上看。

运行 `/one:examples`，依次选样例、选复制到哪一层、确认。每个样例后面写着它在两层的状态：未复制、部分复制、已复制（全部和样例一致）、有改动（有文件被你改过）。三类文件一起放到你选的那一层：

| 层 | skills | 角色定义 | AGENTS.md | 生效范围 |
|---|---|---|---|---|
| 用户层 | `~/.pi/agent/skills/` | `~/.pi/agent/agents/` | `~/.pi/agent/AGENTS.md` | 你的所有项目 |
| 项目层 | 仓库内 `.pi/skills/` | 仓库内 `.pi/agents/` | 仓库根目录 `AGENTS.md` | 只有这个项目；项目在 pi 里设为受信任后才能选 |

- 只复制还没有的文件。你改过的文件不覆盖，确认窗口和结果里会列出来。
- `AGENTS.md` 按样例那一段的标题（如「## 后端设计约定」）认：没有就追加到末尾，先给你看差异，选「写入」才写；已经有了就不动。合并后超过 16 KB 就不写，skills 和定义照常复制，精简 `AGENTS.md` 后再运行一次会只补写这一段。其中和内置 skill 写法冲突的条目，代理按 `AGENTS.md` 执行，例如 Vue 样例把 refresh token 存在 localStorage。
- 复制后同名的内置定义被替换，派工用的是复制过去的这一份；删掉复制的文件，就恢复用内置的。`/one:setting` 里的开关按定义名记：复制前关掉的，复制后照样关着；删掉复制的文件后，开关状态留给内置那一份。

样例是一个团队的规范，复制后按你团队的做法改。

```

## 函数清单
无过程式代码。

## 协作关系
`tests/user-documentation.test.ts` 读 README 检查必备文字与二级标题顺序；`tests/installation/requirement-manage.test.ts` 用 `pnpm pack --json` 的文件清单检查打包内容。

## 验证方式
- 测试入口：`pnpm test`（文档测试）、`pnpm run test:installation`（打包清单）。
- 测试输入：仓库里的 README.md、ARCHITECTURE.md、package.json。
- 预期结果：
  - [ ] 打包清单含 `examples/golang/AGENTS.md`、`examples/vue/AGENTS.md`、`examples/golang/agents/go-worker.md`、`examples/vue/skills/vue-constraints/SKILL.md`。
  - [ ] README 命令表有 `/one:examples` 那一行；从 README 删掉 `/one:examples` 后文档测试失败。
  - [ ] `grep -n 只读不写 README.md`、`grep -n 程序不读 ARCHITECTURE.md` 都没有输出。
  - [ ] 原有文档测试全部通过（二级标题顺序、导航、路径）。
