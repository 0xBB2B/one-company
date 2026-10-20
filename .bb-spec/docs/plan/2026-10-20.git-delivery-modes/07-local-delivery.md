---
name: 07-local-delivery
description: 仅本地档位下交付工具核对主仓库后弹窗选合并方式，在本机把需求分支合进主仓库当前分支
---
# 仅本地交付

## 目标
仅本地档位下，主代理调用交付工具，程序核对后弹出"合进 <分支>，怎么合并？"，按用户选择用压缩合并、普通合并或 rebase 合并把需求分支合进主仓库当前检出的分支，不推送。

## 业务规则（来源：PRD 05-local-delivery；已确认预览画面 15–16）
- 目标分支：主仓库当前检出的分支（plan 05 `checkedOutBranch`），不联网。
- C-2 核对：先做与远程相同的公共核对（plan 06 `prepareDelivery`：完成凭据、归档已在分支里、worktree 干净、最终检查后没有代码改动、外来归档、子模块）；再核对主仓库：没检出分支 → 拒绝，原因"主仓库当前没有检出分支"，建议"请用户在主仓库检出要合进去的分支后再交付"；有未提交改动（含已暂存，不含未跟踪文件，即 `status --porcelain --untracked-files=no` 非空）→ 拒绝，原因"主仓库有未提交的改动"，建议"请用户提交或暂存（stash）主仓库的改动后再交付"。拒绝时主仓库分支和需求分支都不变。
- C-3 验收后主仓库当前分支前进：能干净 rebase 就 rebase 需求分支再继续，窗口写"目标分支在验收后前进，已自动 rebase，这部分未重新验证"；冲突就 `rebase --abort` 停下、不弹窗，结果 `conflict`，原因"目标分支在验收后前进，自动 rebase 有冲突"，建议"请用户手动解决冲突，重新检查和验收后再交付"。没前进写"目标分支未变化"。
- C-4 窗口：灰字标题行"交付到本地分支"，问题"合进 <分支名>，怎么合并？"，正文需求标题、灰字编号、灰字"分支：<需求分支> → <主仓库当前分支>（仅本地，不推送）"、灰字 C-3 那一行。选项只列设置里勾了的，顺序和说明：压缩合并（推荐）"<分支名> 上多一个提交；标题是“需求标题 [编号]”，正文末行 Requirement: <编号>"；普通合并"保留每个提交，另加一个合并提交"；rebase 合并"保留每个提交，<分支名> 直接前进到需求分支末端"。勾了压缩合并时光标在它上面，否则在第一项。提示行"Esc 取消（取消就不合并，需求分支保留）"。Esc → 结果"用户选择先不合并，需求分支保留"，什么都不合并。
- C-5 合并结果（在主仓库执行，git 选项同 `gitIn`，不跑 hook）：
  - 压缩合并：`merge --squash <需求分支>` 后提交，标题"<需求标题> [<编号>]"，正文为 plan 06 `deliveryBody`（交付提交写需求分支末端）。
  - 普通合并：`merge --no-ff -m <标题> -m <正文> <需求分支>`，总是新建合并提交。
  - rebase 合并：`merge --ff-only <需求分支>`（需求分支已在当前分支之上）。
- C-6 结果写明方式和合并后主仓库当前分支指向的提交；合并失败（如会覆盖未跟踪文件）→ 用 `merge --abort` 或 `reset --merge` 恢复，当前分支不变，原因写 Git 报错，建议"处理后再交付"。需求分支和 worktree 都保留。
- 档位分流：扩展工具按设置档位调远程 `deliverRequirement` 或本地 `deliverLocally`。

## 涉及文件
- src/modules/delivery/local-delivery.ts（新建）
- src/modules/delivery/git-delivery.ts（修改：`DeliveryResult` 加本地交付的结果形状）
- src/modules/delivery/git-delivery-extension.ts（修改：按档位分流）
- tests/local-delivery.test.ts（新建）、tests/git-delivery-extension.test.ts（修改）

## 函数清单
### src/modules/delivery/local-delivery.ts
| 函数名 | 职责 |
|---|---|
| `deliverLocally` | 本地流程：取目标分支 → 主仓库核对 → `prepareDelivery`（含 C-3 rebase）→ 弹窗 → 合并 → 结果 |
| `mainRepositoryCheck` | 按 C-2 核对主仓库是否检出分支、是否有未提交改动 |
| `localMergeChoices` | 按勾选的方式生成 C-4 的选项和默认光标 |
| `mergeLocally` | 在主仓库按所选方式执行 C-5，失败时恢复并返回 C-6 的失败结果 |
### src/modules/delivery/git-delivery.ts
| 函数名 | 职责 |
|---|---|
| `DeliveryResult` | 改：加 `{ status: "merged-locally"; method; target; head; rebasedAfterAcceptance }` 与 `{ status: "not-merged"; reason }`（Esc）以及本地合并失败形状 |
### src/modules/delivery/git-delivery-extension.ts
| 函数名 | 职责 |
|---|---|
| `registerGitDelivery` 的 `execute` | 改：`mode === "local"` 调 `deliverLocally`，否则调 `deliverRequirement` |

## 协作关系
- 依赖 plan 05 `checkedOutBranch`、plan 06 `prepareDelivery`/`deliveryTitle`/`deliveryBody`、plan 03 归档核对。主仓库路径由扩展传入（与 plan 06 读设置用的是同一个主仓库）。

## 验证方式
- 测试入口：`deliverLocally`；扩展工具 `execute`（设置档位为 local）。
- 测试输入：`createRepoFixture` 主仓库（无 origin）+ `addWorktree` 需求分支，有代码提交和已提交的归档；用假 `DeliveryUi` 记录窗口内容并选择指定项或返回 undefined（Esc）；分别造主仓库 detached、有已修改文件、有已暂存文件、验收后 main 多一个不冲突/冲突的提交、主仓库有与需求新增文件同名的未跟踪文件。
- 预期结果：
- [ ] 选压缩合并：main 多一个提交，`git diff <原 main> main` 等于需求分支相对分叉点的全部改动（含归档）；说明第一行"<标题> [<编号>]"、最后一行 `Requirement: <编号>`。
- [ ] 选普通合并：main 新提交有两个父提交，说明同上；选 rebase 合并：main 指向需求分支末端，没有新提交。
- [ ] 窗口逐项如 C-4：三种都勾时光标在压缩合并；只勾普通合并时只有一项；Esc 后 main 不变，结果"用户选择先不合并，需求分支保留"。
- [ ] detached、已修改、已暂存三种情况被拒，文字如 C-2，main 与需求分支指向的提交不变。
- [ ] main 前进且不冲突：窗口出现"已自动 rebase"那一行；冲突：结果 `conflict`，文字如 C-3，没弹窗。
- [ ] 同名未跟踪文件：合并失败，main 不变，结果含 Git 报错和建议"处理后再交付"。
- [ ] 扩展在 local 档位下不调用 gh/glab（假脚本日志为空）。
