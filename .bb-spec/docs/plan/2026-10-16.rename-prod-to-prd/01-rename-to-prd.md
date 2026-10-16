---
name: 01-rename-to-prd
description: 代码、测试、提示词、根目录文档、素材里指需求正文的 prod 按两条规则全部换成 prd / PRD，文件名一起改
---
# prod 全部改名为 prd

## 目标
仓库里指需求正文的 `prod` 全部换掉：代码形态写成 `prd`（保留大小写），正文形态写成 `PRD`；产品行为和改名前完全一样。

## 业务规则（来源：PRD 01-rename-to-prd）
- 需求正文是用户和主代理一起写、经用户批准的需求说明。英文里 `prod` 通常指生产环境，所以改名；用户 2026-10-16 决定全部改，不写迁移、不保留旧名字。
- 本机每个需求的正文文件名是 `prd.md`；关闭需求时归档写进用户项目的 `docs/prd/<需求编号>.<标题>.md`，原型是同目录的 `<需求编号>.<原型名称>.html`。
- Git 交付提交归档时，提交说明是 `docs(prd): 归档需求 <需求编号>`。
- 改名前对 `docs/prod/` 的特殊处理全部改给 `docs/prd/`：PM 不能提交、验证命令执行时不能写、项目索引不读正文只登记路径、交付核对时分支里不能夹带别的归档文件。
- 工具参数值、事件名、格式标记、错误码、路径分类全部换：例如 `prd-unit`、`prd-scenario`、`prd.saved`、`prd.approved`、`approved-prd-change/v1`、`pm-prd-event-cursor/v1`、`prd_revision_required`、`invalid_prd_format`、`prd_archive`、项目索引的命名空间 `prd_metadata`。
- 正文写大写 `PRD`，代码名、路径、参数值写小写 `prd`（类型名 `Prd` 开头，常量 `PRD_` 开头）。
- 除了名字，起草、批准、派工、检查轮、关闭、归档、交付的行为都不变。

## 改名规则（Test 与 Impl 两边用同一套）
只处理包含字母序列 p-r-o-d（不分大小写）且**不是** `produc` 开头的地方（product、produce、reproduce 等一律不动）。每一处按下面两条之一改：

**规则 A：代码形态 → 删掉字母 o，其余字母大小写不变。** 适用于 prod 紧挨着 `[A-Za-z0-9_./-]` 中的字符，或者整段被引号或反引号包住（`"prod"`、`'prod'`、`` `prod` ``）。例：
- `prod` → `prd`、`Prod` → `Prd`、`PROD` → `PRD`、`PrOd` → `Prd`
- `prodHash` → `prdHash`、`ProdStorageConfig` → `PrdStorageConfig`、`PROD_FILE` → `PRD_FILE`、`approvedProdHash` → `approvedPrdHash`、`tprod` → `tprd`、`nProd` → `nPrd`
- `prod.md` → `prd.md`、`docs/prod` → `docs/prd`、`prod-unit` → `prd-unit`、`prod.approved` → `prd.approved`、`prod_archive` → `prd_archive`、`./prod-storage.ts` → `./prd-storage.ts`
- `join(root, "docs", "prod")` → `join(root, "docs", "prd")`、`["docs", "prod"]` → `["docs", "prd"]`
- 提交说明模板 `docs(prod): 归档需求` → `docs(prd): 归档需求`

**规则 B：正文形态 → 写成大写 `PRD`。** 适用于 prod 作为一个独立的词出现在注释、字符串里的说明文字、Markdown 反引号外的正文里，前后都不紧挨 `[A-Za-z0-9_./-]`，也没有被引号整体包住。例：
- `"…（不含 prod）。"` → `"…（不含 PRD）。"`
- `"…不搜索prod。…"` → `"…不搜索PRD。…"`
- `` `…prod hash ${…}` `` → `` `…PRD hash ${…}` ``、`` `依据：prod r${…}` `` → `` `依据：PRD r${…}` ``
- `"prod 文档 frontmatter 格式无效"` → `"PRD 文档 frontmatter 格式无效"`
- `/** 会话条目可能含 prod 正文… */` → `/** 会话条目可能含 PRD 正文… */`
- `role-rules/pm.md`："读取当前已批准的完整 prod" → "读取当前已批准的完整 PRD"

文件改名（`git mv`，引用这些文件的 import 按规则 A 一起改）：
- `src/modules/requirement/prod-storage.ts` → `src/modules/requirement/prd-storage.ts`
- `src/modules/requirement/prod-view.ts` → `src/modules/requirement/prd-view.ts`
- `tests/prod-exclusion.test.ts`、`tests/prod-storage-link-race.test.ts`、`tests/prod-storage.test.ts`、`tests/prod-view.test.ts` → 同名把 `prod` 换成 `prd`

**不改**：`.bb-spec/docs/` 下的一切（已合并 PRD、本次 PRD、本 plan）、Git 历史、`node_modules/`、`pnpm-lock.yaml`。数据库版本号不在本 plan 里动。

## 涉及文件
- 修改：`src/` 下 58 个含 prod 的源文件（最多的是 `src/modules/requirement/` 下的 prod-storage、requirement-service、prod-view、requirement-identity、requirement-state、requirement-contracts、requirement-events，以及 `src/modules/project-index/index-store.ts`、`src/modules/pm/requirement-read-tool.ts`、`src/modules/pm/pm-intake-contracts.ts`、`src/modules/delivery/workflow-close.ts`、`src/modules/delivery/git-delivery.ts`、`src/core/policy/core-permissions.ts`、`src/app/daemon/` 下若干文件）；用 `grep -rlIi prod src | xargs grep -lIi prod` 列全，逐个排除只含 produc 的
- 修改：`tests/` 下 81 个含 prod 的测试文件（含 `tests/acceptance/`）
- 修改：`rules/01-main-session.md`、`rules/05-archived-requirements.md`、`role-rules/pm.md`、`role-rules/worker.md`、`role-rules/explore.md`、`role-rules/reviewer.md`、`role-rules/qa.md`、`agents/qa.md`、`resources/tree-sitter/README.md`、`README.md`、`ARCHITECTURE.md`
- 改名：上面列的 2 个源文件、4 个测试文件

## 函数清单
本 plan 只改名，不新增、不删除函数，不改任何函数的逻辑。函数、类型、常量按规则 A 改名，例如：

### src/modules/requirement/prd-storage.ts（由 prod-storage.ts 改名）
| 函数名 | 职责 |
|---|---|
| `readPrdIfExists`（原 `readProdIfExists`） | 读本机正文 `prd.md`，职责不变 |

### src/modules/requirement/requirement-identity.ts
| 函数名 | 职责 |
|---|---|
| `createPrdDocument`（原 `createProdDocument`） | 生成带身份 frontmatter 的正文内容，职责不变；归档目录常量改为 `["docs", "prd"]` |

### src/modules/requirement/prd-view.ts（由 prod-view.ts 改名）
| 函数名 | 职责 |
|---|---|
| `inspectPrdStructure`、`selectPrdSection`、`pagePrdText`、`partitionPrdDocument`（原名把 Prod 换成 Prd） | 正文结构检查、选段、分页、按批准清单分段，职责不变 |

### src/modules/project-index/index-store.ts
| 函数名 | 职责 |
|---|---|
| `validatePrdMetadata`（原 `validateProdMetadata`） | 校验索引里的正文路径元数据，路径规则改为 `requirements/<编号>/prd.md` 与 `docs/prd/<编号>.<标题>.md` |

## 协作关系
调用关系不变，只是名字变了。持久化到本机数据库的事件名、格式标记、命名空间换成新名字后，改名前留下的旧库读不出来；这个问题由 02 号 plan 升数据库版本号处理，本 plan 不处理旧数据。

## 验证方式
- 测试入口：`pnpm run typecheck`、`pnpm test`、`pnpm run test:integration`、`pnpm run test:installation`，以及下面两条检查命令。
- 测试输入：Test 侧把 `tests/` 下全部测试按上面两条规则改写、改文件名（改完后因为 `src/` 还没改，import `prd-storage.ts` 等会失败，这就是 Red）；Impl 侧按同样规则改 `src/`、提示词和文档。
- 预期结果：
  - 新建需求后，本机需求目录里有 `prd.md`；关闭需求后用户项目里是 `docs/prd/<需求编号>.<标题>.md`；Git 交付的归档提交说明以 `docs(prd): 归档需求` 开头。
  - PM 提交 `docs/prd/x.md` 被拒，原因里写"这是需求归档目录，由程序在关闭需求时写入，不能提交"。
  - 工具参数说明、数据库里新写入的事件名、格式标记、错误码都是 `prd`。
- [ ] 四项纯代码测试全部通过
- [ ] `grep -rIi 'prod' src rules role-rules agents skills shared resources tests README.md ARCHITECTURE.md CONTRIBUTING.md AGENTS.md | grep -vi 'produc'` 没有输出
- [ ] `git ls-files | grep -i prod | grep -vi produc | grep -v '^.bb-spec/'` 没有输出
- [ ] 下面这条命令没有输出（Markdown 正文里反引号外没有小写单词 prd）：`perl -ne 's/`[^`]*`//g; print "$ARGV:$.: $_" if /(?<![A-Za-z0-9_.\/-])prd(?![A-Za-z0-9_.\/-])/; close ARGV if eof' rules/*.md role-rules/*.md agents/*.md shared/*.md skills/*/*.md resources/tree-sitter/README.md README.md ARCHITECTURE.md`
- [ ] `role-rules/pm.md` 里写的是"读取当前已批准的完整 PRD"
