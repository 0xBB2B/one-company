---
name: 03-archive-commit
description: 归档文件写好后由程序立即在需求分支提交；交付只核对归档已在分支里，自己不再提交归档
---
# 归档随需求关闭提交进分支

## 目标
需求以完成关闭后，需求分支上就有一个只含本需求归档和原型文件的归档提交；归档状态只有在提交完成并核对一致后才是"已归档"；交付工具只核对、不提交。

## 业务规则（来源：PRD 01-archive-commit）
- 归档：需求 worktree 里的 `docs/prd/<编号>.<需求描述>.md` 和批准过的原型 `docs/prd/<编号>.<原型名称>.html`。归档状态三种：已归档（archived）、待重试（pending）、受阻（blocked）。
- C-1：文件写好后在需求分支上提交，只提交本需求的归档和原型文件，worktree 里其他改动保持未提交。说明第一行 `docs(prd): 归档需求 <编号>`，空一行，最后一行 `Requirement: <编号>`。
- C-2：只有提交完成、而且需求分支最新提交（HEAD）里这些文件的内容和登记的指纹（sha256）一致后，状态才变成"已归档"。提交失败（例如没配 Git 用户名和邮箱）→ 状态"待重试"，`lastError` 带 Git 的报错（截到 1024 字）；重试时文件已存在且内容一致就不重写，只补提交。
- C-3：HEAD 里已经有内容一致的归档时，重试直接"已归档"，分支上的提交不变。
- C-4：交付工具（两档）只核对归档已在 HEAD 里且内容一致，自己不提交任何文件；不一致拒绝，原因"归档文件与关闭时登记的内容不一致"。worktree 必须完全干净（归档也已提交），否则按现有 `worktree_dirty` 拒绝。推送或合并前的确认窗口写"归档已在分支中"。
- C-5：只多了归档提交时不算最终检查后的代码改动（现有 `head_changed` 判定比较的补丁指纹已排除归档文件，`src/modules/delivery/git-delivery.ts:124-130`，保持不变）。
- 提交用和 PM 提交一致的 git 选项：`--literal-pathspecs -c core.hooksPath=/dev/null -c commit.gpgsign=false -c maintenance.auto=false -c gc.auto=0`（`src/modules/pm/pm-commit.ts:41-42`），只暂存并提交这些路径（`commit --only -- <路径>`），不碰暂存区里的其他内容。

## 涉及文件
- src/modules/delivery/archive-commit.ts（新建）
- src/modules/delivery/workflow-close.ts（修改 `archive()`）
- src/modules/delivery/git-delivery.ts（修改：删掉 add/核对暂存/提交归档的步骤，改为核对 HEAD）
- tests/archive-commit.test.ts（新建）、tests/workflow-close.test.ts、tests/git-delivery.test.ts（修改：`world()` 里归档改为已提交）

## 函数清单
### src/modules/delivery/archive-commit.ts
| 函数名 | 职责 |
|---|---|
| `archiveInHead` | 对一组 `{ path, hash }` 逐个读 HEAD 里的 blob（`ls-tree HEAD -- :(literal)<路径>` + `cat-file blob`），全部存在且 sha256 一致返回 true |
| `commitArchive` | `archiveInHead` 已为 true 时直接返回；否则 `add -f` 这些路径并 `commit --only` 提交，说明按 C-1；提交后再用 `archiveInHead` 核对，不一致抛错 |
### src/modules/delivery/workflow-close.ts
| 函数名 | 职责 |
|---|---|
| `RequirementCloseService.archive` | 改：文件写好（或已存在且一致）后调 `commitArchive`；成功才 `save({status:"archived"})`；`commitArchive` 抛错走现有 catch → `pending` + `lastError` |
### src/modules/delivery/git-delivery.ts
| 函数名 | 职责 |
|---|---|
| `deliverRequirement` | 改：去掉 :148-176 的 add、暂存核对、`pending` 判断、归档提交和提交内容核对；改为 worktree 必须完全干净，再用 `archiveInHead` 核对，不一致 `reject("archive_mismatch")`；确认窗口固定写"归档已在分支中"；拒绝码 `unexpected_staged`、`unexpected_commit_content` 用不到了就删掉 |

## 协作关系
- `archive()` 在守护进程里由 `workflow.manage` 的 close 触发（`src/modules/delivery/workflow-manage.ts:138-149`），重试走同一个 archive 动作。
- git 调用用 `src/core/exec/target-branch.ts` 的 `gitIn`（选项见上）并加 `--literal-pathspecs`。

## 验证方式
- 测试入口：`commitArchive`、`archiveInHead`；`RequirementCloseService` 的 close/archive（经现有 `tests/workflow-close.test.ts` 的 `world()`）；`deliverRequirement`。
- 测试输入：`createRepoFixture` + `addWorktree` 造需求 worktree；归档文件和原型文件；worktree 里另放一个未提交的改动文件；用 `GIT_CONFIG_GLOBAL=/dev/null` 且不设作者环境变量模拟没配用户名。
- 预期结果：
- [ ] 完成关闭后 worktree `git status --porcelain` 只剩那个另放的改动文件；HEAD 只新增归档和原型文件，`git log -1 --format=%B` 第一行 `docs(prd): 归档需求 <编号>`、最后一行 `Requirement: <编号>`。
- [ ] 没配用户名时关闭：状态 `pending`，`lastError` 含 Git 的报错；配好后再调 archive → `archived`，归档文件 mtime 不变，分支多一个归档提交。
- [ ] 对已归档的需求再调 archive → 仍 `archived`，`git rev-list --count HEAD` 不变。
- [ ] 交付：归档已提交时确认窗口有"归档已在分支中"，交付前后没有新增 `docs(prd): 归档需求` 提交；手动改了已提交的归档文件内容再提交后交付 → 被拒，原因"归档文件与关闭时登记的内容不一致"。
- [ ] 最终检查后只多了归档提交时交付不报 `head_changed`。
