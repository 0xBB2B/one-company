---
name: 02-requirement-file-repo
description: 需求自己的 Git 仓库从"一条直线、只放 prd.md"改成"可分叉、放草稿全部文件"
---
# 需求文件仓库可分叉

## 目标
每个需求自己的 Git 仓库能存多条对话线上的提交，每个提交装着那一刻的全部草稿文件，任意一条线上的任意一次提交都能读出来。

## 业务规则（来源：PRD 01-line-bound-draft 约束 13、03-approved-files-into-branch）
- 跟线内容里的文件（需求标题和正文、原型文件、DESIGN.md、写进草稿的 AGENTS.md）存在数据根目录 `repos/<仓库>/` 下 one-company 自己的 Git 里，每条线上的每次保存都能读出来。
- 回到版本 5 再保存，新提交接在版本 5 的提交后面；原来版本 6 到 10 的提交原样保留、照样能读。
- 提交到 DESIGN.md、AGENTS.md 时，同时存下"底稿"：这条线第一次改它时主仓库根目录里这个文件的内容（主仓库没有这个文件时不存）。03-approved-files-into-branch 做三方合并时要用底稿。
- `main` 指向这个需求最近一次保存（按时间），对应"新对话里用最近保存的那一份"；唯一的例外是 09-upgrade-migration 的迁移提交，它接在 main 上并让 main 前移。
- 现有的安全加固全部保留：路径与软链接检查、固定提交身份 `pi PRD storage <pi-prd-storage@localhost>`、提交说明的 `Operation-Id`、`Prd-Hash` 尾行、带旧值的 `update-ref`、临时 index、工作副本原子写。
- 现有只有 `main`、一条直线、只含 prd.md 的仓库能打开、能以 main 为父接着保存。挪动 main 前，旧 main 必须是新提交的祖先，或能从某个 `refs/lines/*` 到达，否则拒绝（`parent_mismatch`），保证任何保存过的版本都不会变成不可达；09-upgrade-migration 给旧仓库的 main 补上 `refs/lines` 引用，之后就能分叉。
- 重放一次已完成的保存不移动 main；`commitDraftFiles` 同一 operationId、anchor 重试时比对文件树，内容不同报 `operation_conflict`。
- 底稿文件（`DESIGN.base.md`、`AGENTS.base.md`）只能和对应正文文件一起存在。
- 以非 main 为父保存、内容和父提交相同时返回 unchanged，不产生提交、不移动 main。
- 每次读写用一次 `git log --all --raw` 回放校验全部提交的文件树，读写耗时和引用数量无关。

## 涉及文件
- 修改 `src/modules/requirement/prd-storage.ts`
- 修改 `src/modules/requirement/requirement-service.ts`（调用处多传 anchor）
- 修改 `tests/prd-storage.test.ts`

## 成品定义

需求仓库提交里的文件树（只允许这些路径，其他路径一律报 `history_mismatch`）：
```
prd.md                          需求标题和正文（必有）
DESIGN.md                       这条线上已通过的界面设计规范（可选）
DESIGN.base.md                  DESIGN.md 的底稿（只在 DESIGN.md 存在、主仓库当时有这个文件时存在）
AGENTS.md                       写进草稿的项目规范（可选）
AGENTS.base.md                  AGENTS.md 的底稿（规则同上）
prototypes/<原型名>.v<N>.html    这条线上已通过、未移除的原型（可选，可多个）
```

引用规则：
```
refs/heads/main            这个需求最近一次保存的提交
refs/lines/<锚点编号>      每个产生文件提交的锚点一个，指向该锚点的提交，保证所有提交都可达
```

提交说明格式（第一行的 kind 新增 prototype、conventions、migration 三种）：
```
prd(<requirementId>): create|updateDraft|prototype|conventions|migration

Operation-Id: <UUIDv7>
Prd-Hash: sha256:<prd.md 的哈希>
```

## 函数清单
### src/modules/requirement/prd-storage.ts
| 函数名 | 职责 |
|---|---|
| `validatedLineage` | 改：校验所有引用可达的提交都最多一个父、父链完整，允许分叉 |
| `assertOnlyMainRef` | 改名为 `assertManagedRefs`：只允许 `refs/heads/main` 和 `refs/lines/*`，且都指向受管提交 |
| `repositoryPrdBlob` | 改名为 `repositoryFileTree`：按上面的文件树规则校验并返回各文件的 blob |
| `writeTreeCommit` | 改：父提交由调用方给出（线尖的 fileCommit）；写整棵文件树；同时写 `refs/lines/<锚点>`；`main` 只在保存类提交时 CAS 前移 |
| `saveInternal` | 改：`expectedParent` 是线尖的 fileCommit；中断重试按 Operation-Id 认出 |
| `readVersion` | 不变：按提交读出 prd.md |
| `readDraftFiles` | 新：按提交读出全部草稿文件 {prd, design, designBase, agents, agentsBase, prototypes} |
| `create`、`save` | 改：入参多一个 `anchor`（新锚点编号），据此写 `refs/lines/<anchor>` |
| `commitDraftFiles` | 新：把原型、DESIGN.md、AGENTS.md 的变化作为一次非保存提交写进这条线（04、05、06 调用） |
| `assertRequestedVersion` | 改：被读的提交必须可从某个受管引用到达 |

### src/modules/requirement/requirement-service.ts
| 函数名 | 职责 |
|---|---|
| 调用 prd-storage `create` / `save` 的两处 | 改：暂时把本次 operationId 作为 `anchor` 传入（03 换成真正的锚点） |

## 协作关系
- 03-line-draft-save-read 的保存流程调用 `saveInternal`，传入线尖 fileCommit 作父提交和新锚点编号。
- 05-line-prototype-board、06-conventions-draft 调用 `commitDraftFiles`。
- 08-approved-files-into-branch 用 `readDraftFiles` 读出批准那一刻的全部文件和底稿。
- 调用 git 的方式沿用 `runGit` 和 `gitEnvironment`，不引入新依赖。

## 验证方式
- 测试入口：`prd-storage.ts` 的导出函数（create、save、readVersion、verifyVersion、diffVersions、commitDraftFiles），数据目录用 `temporaryRoot()`。
- 测试输入：建需求，保存 v2、v3；以 v2 的提交为父再保存一次；在 v3 上 `commitDraftFiles` 加一个原型和 DESIGN.md（带底稿）。
- 预期结果与验证项：
  - [ ] 以 v2 为父保存成功，v3 的提交仍能 `readVersion` 读出原文。
  - [ ] `main` 指向最近一次保存的提交；`commitDraftFiles` 不移动 `main`。
  - [ ] 每个文件提交都有对应的 `refs/lines/<锚点>`。
  - [ ] 提交树里出现规定之外的路径时，读取报 `history_mismatch`。
  - [ ] 手工加一个两个父的提交，读取报 `history_mismatch`。
  - [ ] 只有 main 的直线旧仓库照常能读、能接着保存。
  - [ ] 同一 Operation-Id 中断后重试，认出已有提交，不重复提交。
  - [ ] 原有 `tests/prd-storage.test.ts`、`tests/prd-storage-link-race.test.ts` 的安全用例全部仍通过（按新规则调整断言的除外）。
