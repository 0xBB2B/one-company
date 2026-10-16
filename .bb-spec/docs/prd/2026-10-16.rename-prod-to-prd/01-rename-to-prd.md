---
name: 01-rename-to-prd
description: 代码、测试、提示词、根目录文档、文件路径、事件名、错误码里指需求正文的 prod 全部换成 prd
date: 2026-10-16
---

# prod 全部改名为 prd

## 用户故事
### P0：作为在 pi 里用 one-company 的开发者，我想要需求正文在所有地方都叫 PRD，以便模型和我读到它时不会理解成生产环境

**用例（主路径）**
- 场景：开发者在一个样例项目里提了"增加手机号验证码登录"的需求，和主代理把正文写好并批准。
- 操作：PM 接手、派 worker 实施、检查轮通过、提交完成报告；开发者验收后关闭需求，并打开 Git 交付开关交付。
- 预期：
  - 本机数据目录 `repos/<仓库身份>/requirements/<需求编号>/` 下的正文文件是 `prd.md`。
  - 样例项目里出现 `docs/prd/<需求编号>.<标题>.md`，原型 HTML 在同一目录。
  - 交付时提交归档的提交说明是 `docs(prd): 归档需求 <需求编号>`。
  - PM 读到的职责规矩写的是"读取当前已批准的完整 PRD"。

**用例（边界 / 异常）**
- 场景：PM 想提交 `docs/prd/` 下的文件。
- 操作：PM 调用 `one_company_git_commit`，paths 里带 `docs/prd/x.md`。
- 预期：提交被拒，原因写明"这是需求归档目录，由程序在关闭需求时写入，不能提交"。

## 约束
- C-1：本机每个需求的正文文件名是 `prd.md`；新建需求后，需求目录里有 `prd.md`、没有 `prod.md`。
- C-2：关闭需求时，归档写进用户项目的 `docs/prd/` 目录，文件名是 `<需求编号>.<标题>.md`，原型是 `<需求编号>.<原型名称>.html`，和改名前的规则相同，只换目录名。
- C-3：Git 交付提交归档时，提交说明是 `docs(prd): 归档需求 <需求编号>`。
- C-4：改名前对 `docs/prod/` 的特殊处理全部改给 `docs/prd/`，包括：PM 不能提交、验证命令执行时不能写、项目索引不读正文只登记路径、交付核对时分支里不能夹带别的归档文件。
- C-5：给模型看的工具参数值、存进数据库的事件名、格式标记、错误码里的 `prod` 全部换成 `prd`，例如 `prd-unit`、`prd-scenario`、`prd.saved`、`prd.approved`、`approved-prd-change/v1`、`pm-prd-event-cursor/v1`、`prd_revision_required`、`invalid_prd_format`、路径分类 `prd_archive`。
- C-6：在仓库根执行 `grep -rIi 'prod' src rules role-rules agents skills shared tests README.md ARCHITECTURE.md CONTRIBUTING.md AGENTS.md | grep -vi 'produc'` 没有输出；`git ls-files | grep -v '^\.bb-spec/' | grep -i prod | grep -vi produc` 没有输出。
- C-7：`rules/`、`role-rules/`、`agents/`、`skills/`、`shared/` 下的 `.md` 文件和 `README.md`、`ARCHITECTURE.md` 的正文里，反引号外面指需求正文时写大写 `PRD`，反引号外面不出现单独成词的小写 `prd`；代码名、文件路径、工具参数值用小写 `prd`（类型名用 `Prd` 开头，常量用 `PRD_` 开头）。文件路径里的 `prd`（如 docs/prd）属于代码形态，不算单独成词，写在反引号里外都可以。
- C-8：除了名字，需求的起草、批准、派工、检查轮、关闭、归档、交付行为和改名前一样：改名前已有的纯代码测试，按新名字改写后全部通过。

## 验收
- [ ] C-1：新建需求后，需求目录里有 `prd.md`、没有 `prod.md`。
- [ ] C-2：关闭需求后，用户项目里出现 `docs/prd/<需求编号>.<标题>.md` 和对应原型 HTML，没有 `docs/prod/`。
- [ ] C-3：Git 交付的归档提交说明是 `docs(prd): 归档需求 <需求编号>`。
- [ ] C-4：PM 提交 `docs/prd/x.md` 被拒并说明原因；验证命令写 `docs/prd/` 被挡；项目索引不返回 `docs/prd/` 下文件的正文；交付核对遇到分支里夹带别的 `docs/prd/` 文件时拒绝交付。
- [ ] C-5：工具参数说明、数据库里新写入的事件名、格式标记、错误码里都是 `prd`，没有 `prod`。
- [ ] C-6：两条 grep 命令都没有输出。
- [ ] C-7：上述 `.md` 文件反引号外面没有单独成词的小写 `prd`（前后紧挨 `/`、`.`、`-`、`_`、字母或数字的不算）；`role-rules/pm.md` 写的是"读取当前已批准的完整 PRD"。
- [ ] C-8：类型检查、单元、集成、安装四项纯代码测试全部通过；全部真实模型验收（P1–P13、M9-AC12、M9-AC2/AC3/AC11）通过。

## 验证路径
1. 执行 C-6 的两条 grep 命令 → 都没有输出。
2. 跑 `pnpm run typecheck`、`pnpm test`、`pnpm run test:integration`、`pnpm run test:installation` → 全部通过。
3. 删掉本机数据目录，在样例项目里走完一个需求并打开 Git 交付 → 本机需求目录里是 `prd.md`，样例项目里是 `docs/prd/` 归档，交付提交说明以 `docs(prd):` 开头。
4. 跑全部真实模型验收 → 全部通过。
