---
name: package-and-docs
description: 打包后的包里带上 examples/，README 写明 /one:examples 怎么用，过期的"只读不写""程序不读"改成现在的样子
date: 2026-10-23
---

# 发布包与文档

几个词先说清：
- 打包安装：先用 `pnpm pack` 把包打成压缩包再安装。压缩包里只有 `package.json` 的 `files` 列出的目录，没列的目录装好后就没有。
- 设计规范样例一节：README 里讲 `examples/` 的那一个二级标题，在「设置」和「原理」之间。

## 用户故事
### P0：作为用打包方式安装的用户，我想要装好的包里有样例，以便 `/one:examples` 能列出它们
**用例（主路径）**
- 场景：用户用打包好的 one-company 安装。
- 操作：在装好的包目录里看 `examples/`。
- 预期：有 `examples/golang/`、`examples/vue/`，文件和仓库里的一样。

### P0：作为读 README 的用户，我想要知道用 `/one:examples` 复制样例，以及复制会改哪些文件
**用例（主路径）**
- 场景：用户想用 Go 样例，打开 README。
- 操作：读命令表和「设计规范样例」一节。
- 预期：命令表里有 `/one:examples`；那一节写明运行命令后怎么选、三类文件在两层各放到哪、改过的文件不覆盖、`AGENTS.md` 先看差异再写。

## 约束
- C-1：`package.json` 的 `files` 包含 `examples`；打包后的压缩包里有 `examples/golang/AGENTS.md`、`examples/vue/AGENTS.md` 和两套样例的全部文件。
- C-2：README 的命令表加一行 `/one:examples`，说明「把 Go、Vue 设计规范样例复制到用户层或项目层」。
- C-3：README「设计规范样例」一节写明：
  - 两套样例的位置（`examples/golang/`、`examples/vue/`）和三类文件各是干什么的。
  - 运行 `/one:examples`，依次选样例、选层、确认；每个样例后面写着它在用户层、项目层的状态。
  - 选用户层时三类文件分别放到 `~/.pi/agent/skills/`、`~/.pi/agent/agents/`、`~/.pi/agent/AGENTS.md`，对你的所有项目生效；选项目层时放到仓库内 `.pi/skills/`、`.pi/agents/` 和仓库根目录 `AGENTS.md`，只对这个项目生效，项目在 pi 里设为受信任后才能选。
  - 你改过的文件不覆盖，确认窗口和结果里会列出来。
  - `AGENTS.md` 先给你看差异，选「写入」才写；合并后超过 16 KB 就不写，skills 和定义照常复制。
  - 复制后同名的内置定义被替换，删掉复制的文件就恢复用内置的；开关按定义名记（沿用现有那句）。
  - 样例是一个团队的规范，复制后按自己团队的做法改。
- C-4：README 里「`~/.pi/agent/AGENTS.md`」那一行的说明改成「你的个人规范；`/one:examples` 经你确认后会在末尾追加样例那一段」。
- C-5：ARCHITECTURE.md 里「`examples/` … 程序不读」那句改成：`examples/` 是 Go、Vue 设计规范样例，`/one:examples` 把它们复制到用户层或项目层。
- C-6：README 的文档测试检查 `/one:examples` 出现在 README 里；上一份需求已检查的路径（`examples/golang/`、`~/.pi/agent/skills/`、`.pi/skills/`、`~/.pi/agent/agents/`、`.pi/agents/` 等）照常检查。

## 验收
- [ ] C-1：安装测试打包后，压缩包的文件清单里有两套样例的全部文件。
- [ ] C-2：README 命令表有 `/one:examples` 那一行。
- [ ] C-3：README「设计规范样例」一节逐条写到约束里的七件事。
- [ ] C-4：README 里没有「只读不写」；`~/.pi/agent/AGENTS.md` 那一行是新的说明。
- [ ] C-5：ARCHITECTURE.md 里没有「程序不读」，写着 `/one:examples` 复制样例。
- [ ] C-6：`pnpm test` 通过；从 README 删掉 `/one:examples` 后文档测试失败。

## 验证路径
1. 执行 `pnpm pack` 再看压缩包清单 → 有 `examples/golang/`、`examples/vue/` 下的全部文件。
2. 打开 README → 命令表有 `/one:examples`；「设计规范样例」一节写明命令怎么用、文件放到哪；`~/.pi/agent/AGENTS.md` 那一行写着会追加样例那一段。
3. `grep -n 程序不读 ARCHITECTURE.md`、`grep -n 只读不写 README.md` → 都没有输出。
