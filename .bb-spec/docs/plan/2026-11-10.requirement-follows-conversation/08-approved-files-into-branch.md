---
name: 08-approved-files-into-branch
description: 需求已批准且工作区建好时，把批准的正文、原型、DESIGN.md、AGENTS.md 提交进需求分支，被改过时三方合并；子代理从需求分支读规范
---
# 批准的文件进需求分支

## 目标
需求分支里始终有最新批准的那一版需求文件；主仓库根目录在合并之前不被改动；派出的子代理照需求分支里的 AGENTS.md、DESIGN.md 干活。

## 业务规则（来源：PRD 03-approved-files-into-branch 约束 1～8、10）
- 需求分支：`req/<需求编号>`，在需求自己的 worktree 里检出。首次批准时还没有工作区（`workspace-manage.ts` 的 `prepare` 要求需求已批准），所以首次提交发生在建工作区那一步；之后每批准一个新版本，在批准那一步提交。
- 提交的文件，全部取自批准那一刻的文件状态（02 的 `readVersion` 按批准提交读）：
  - 正文 `docs/prd/<需求编号>.<需求标题>.md`，内容是批准的 prd.md 字节；
  - 原型 `docs/prd/<需求编号>.<原型名称>.html`；
  - `DESIGN.md`、`AGENTS.md` 放在分支根目录。
- 新批准的版本改了标题或去掉了某份原型时，旧文件名的文件从分支里删掉。这次没改的 DESIGN.md、AGENTS.md 不动。
- 分支里的 DESIGN.md 或 AGENTS.md 和底稿（文件状态里的 `DESIGN.base.md` / `AGENTS.base.md`；底稿不存在表示当时主仓库没有这个文件）不同时，三方合并：底稿 = base，分支现有内容 = ours，批准的内容 = theirs，只合进 theirs 相对 base 的改动。用 `git merge-file -p --diff3`（项目已依赖 git，不是新技术）。
- 合不上（有冲突）时，所有文件都不提交，这一步整体不生效：
  - 建工作区时：合并检查在建 worktree 之前做（ours 取 `git show <baseCommit>:<文件>`），冲突则不建 worktree、不建分支、需求不绑定工作区；
  - 批准新版本时：在写批准记录之前就检查，冲突则批准不生效、需求保持原状态。
  - 给主代理的结果写明哪个文件、哪一章冲突（章 = 冲突行所在的二级标题），下一步建议"让设计师按最新的 DESIGN.md 重做一版"或"按最新的 AGENTS.md 重改规范"，再批准或再建工作区。
- worktree 里这几个文件有未提交改动时，按冲突处理，不覆盖。
- 提交方式沿用 `archive-commit.ts`：`git commit --only` 只提交这些路径，说明末尾单独一行 `Requirement: <需求编号>`，提交者身份用 worktree 自己的 git 配置。
- 批准前，主仓库根目录和需求分支里的 DESIGN.md、AGENTS.md 都不因为这个需求改变。
- 派 PM、worker、reviewer、qa、PM 派出的 explore 时，项目级 AGENTS.md 和 DESIGN.md 从这个需求的 worktree 读；用户级 AGENTS.md 来源不变；主窗口派出的 explore 和原型设计师（批准前）照旧从主仓库根目录或这条线的文件状态读。
- 完成关闭时的归档写到同一个正文路径，内容换成最终正文加实现记录；原型文件已在分支里且内容相同时直接通过。
- 往需求分支加提交后，审查说明里的 `git diff <baseCommit>` 和完成报告的 `git log baseCommit..HEAD` 会包含这个提交，这是预期的。

## 涉及文件
- 新建 `src/modules/delivery/approved-files.ts`
- 修改 `src/modules/delivery/workspace-manage.ts`（`prepare`）
- 修改 `src/modules/interaction/main-requirement-interaction.ts`（`confirm`：已有工作区时批准前先做合并检查、批准后提交）
- 修改 `src/app/daemon/run-manager.ts`（`withConventions` 的 repositoryRoot 改成需求 worktree）
- 修改 `src/modules/verification/project-conventions.ts`（`agentConventionsContext`、`designSpecContext` 的来源说明文字改成"需求分支里的"）
- 修改 `src/modules/delivery/workflow-close.ts`（归档时允许分支里已有同内容的原型、正文路径不变）
- 新建 `tests/approved-files.test.ts`；修改 `tests/workspace-manage.test.ts`、`tests/workflow-close.test.ts`、`tests/run-manager.test.ts`

## 函数清单
### src/modules/delivery/approved-files.ts
| 函数名 | 职责 |
|---|---|
| `planApprovedFiles` | 读批准提交的文件状态和分支现有文件，算出要写、要删的路径和合并结果；有冲突时返回冲突文件和章名 |
| `mergeWithBase` | 对单个文件跑 `git merge-file -p --diff3`，返回合并后内容或冲突的二级标题 |
| `commitApprovedFiles` | 把 `planApprovedFiles` 的结果写进 worktree 并 `git commit --only`，带 `Requirement:` 尾行 |
| `approvedFilesConflictAdvice` | 把冲突结果转成给模型看的原因和下一步（不带错误码） |

### src/modules/delivery/workspace-manage.ts
| 函数名 | 职责 |
|---|---|
| `prepare` | 改：建 worktree 之前按 baseCommit 做 `planApprovedFiles`，冲突就报错返回；没冲突则照旧建 worktree、`bindWorkspace`，再 `commitApprovedFiles`。工作区已是 ready 时，检查分支里是否已有当前批准版本的文件，没有就补提交（覆盖提交中途失败后的重试） |

### src/modules/interaction/main-requirement-interaction.ts
| 函数名 | 职责 |
|---|---|
| `confirm` | 改：需求已有工作区时，先 `planApprovedFiles`，冲突则不调 `confirmUpdate`；批准成功后 `commitApprovedFiles` |

### src/app/daemon/run-manager.ts
| 函数名 | 职责 |
|---|---|
| `withConventions` | 改：多一个需求编号入参；有工作区时用 worktree 路径读项目级 AGENTS.md、DESIGN.md |

## 协作关系
- `prepare` → `planApprovedFiles`（读 02 的 `readVersion` 和 baseCommit 里的文件）→ `mergeWithBase` → 建 worktree → `RequirementStateStore.bindWorkspace`（它要求 worktree 的 HEAD 等于 baseCommit，所以先绑定再提交）→ `commitApprovedFiles`。
- 依赖 02、04、05、06。

## 验证方式
- 测试入口：`approved-files.ts` 导出函数（真实临时 git 仓库，`temporaryRoot()`）；`WorkspaceManageService.prepare`；`MainRequirementInteraction.confirm`；`RunManager` 派 worker 时的任务说明。
- 测试输入：批准提交里有正文、一份原型、改了「组件」章的 DESIGN.md（底稿是旧 DESIGN.md）、改过的 AGENTS.md；主仓库在底稿之后改了 DESIGN.md「颜色」章。
- 预期结果与验证项：
  - [ ] 先批准后建工作区：分支上正好多一个提交，含规定路径的 4 类文件，说明末尾有 `Requirement:` 行；主仓库根目录两个文件字节不变。
  - [ ] DESIGN.md 合并后「颜色」「组件」两处改动都在。
  - [ ] 两边改同一处：prepare 报冲突、结果写明 DESIGN.md 和章名、worktree 目录和 `req/<编号>` 分支都不存在、需求没绑定工作区。
- [ ] 绑定后提交失败（桩掉 git commit），再调一次 prepare 补上提交。
  - [ ] 已有工作区时批准新版本冲突：批准不生效，requirements 行的 revision、approved 都不变，分支没有新提交。
  - [ ] 新版本改了标题：旧标题的正文文件被删，新标题的在。
  - [ ] 只改了正文的批准，提交里不含 DESIGN.md、AGENTS.md 的改动。
  - [ ] worktree 里 DESIGN.md 有未提交改动时按冲突处理。
  - [ ] 主仓库和 worktree 的 DESIGN.md 不同时，派出的 worker 任务说明里是 worktree 那份。
  - [ ] 完成关闭后正文路径的内容是最终正文加实现记录。
