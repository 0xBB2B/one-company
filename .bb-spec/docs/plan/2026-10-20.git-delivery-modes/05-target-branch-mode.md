---
name: 05-target-branch-mode
description: 目标分支按档位决定：仅本地对准主仓库当前检出的分支且不联网，远程保持 origin 默认分支；守护进程把档位传给 PM 同步和最终检查
---
# 目标分支按档位决定

## 目标
PM 同步目标分支、最终检查轮、交付三处用同一个规则取目标分支：仅本地档位一律是主仓库当前检出的分支、不联网；远程档位保持现状。

## 业务规则（来源：PRD 05-local-delivery C-1；术语 target-branch）
- 目标分支：需求分支最终要合进去的分支。远程档位是 origin 的默认分支，没有 origin 时是主仓库当前检出的分支（现状，`src/core/exec/target-branch.ts:22-46`）。仅本地档位是主仓库当前检出的分支，即使有 origin 也一样，过程中不执行 `git fetch`、`ls-remote`。
- 仅本地档位下主仓库没检出分支（detached HEAD）时，给出可读的报错：原因"主仓库当前没有检出分支"，建议"请用户在主仓库检出要合进去的分支后再继续"（用 `AdvisedError`，现在会把 git 原始错误抛给 PM）。
- 档位取自设置的生效值（plan 02 的 `readAgentSettings().gitDelivery.mode`）。守护进程已经自己读设置（`src/app/daemon/lifecycle.ts:508` 的 `loadAgentSettings`，信任状态用 `ProjectTrustStore`）；每次用到时重新读，改了设置不用重开。
- 分层限制：verification 模块排在 settings 前面，不能引用 settings，所以档位以"取档位的函数"形式从上层传进去；`DeliveryMode` 类型来自 plan 01 的 `src/core/exec/git-host.ts`。

## 涉及文件
- src/core/exec/target-branch.ts（修改）
- src/modules/pm/pm-sync.ts（修改）
- src/modules/verification/check-round.ts（修改）
- src/modules/delivery/workflow-manage.ts（修改）
- src/app/daemon/pm-tools.ts（修改）
- src/app/daemon/run-manager.ts（修改：:332、:354、:1283 三处构造）
- tests/pm-sync.test.ts、tests/workflow-close.test.ts（修改）、tests/target-branch.test.ts（新建或并入 pm-sync 测试）

## 函数清单
### src/core/exec/target-branch.ts
| 函数名 | 职责 |
|---|---|
| `checkedOutBranch` | 新增：在主仓库读 `symbolic-ref HEAD` 得到当前分支 `{name, ref, remote:null, sha}`；detached 时抛上面的 AdvisedError |
| `fetchTargetBranch` | 改：多一个档位参数；`local` 直接用 `checkedOutBranch`，`remote` 保持现有逻辑 |
| `localTargetBranch` | 改：多一个档位参数；`local` 用 `checkedOutBranch`，`remote` 保持现有逻辑 |
### src/modules/pm/pm-sync.ts
| 函数名 | 职责 |
|---|---|
| `PmSyncOptions` | 改：加 `deliveryMode: () => Promise<DeliveryMode>` |
| `syncTargetBranch` | 改：先取档位再调 `fetchTargetBranch` |
### src/modules/verification/check-round.ts
| 函数名 | 职责 |
|---|---|
| `CheckRoundServiceOptions` | 改：加 `deliveryMode` |
| `CheckRoundService.openRound` | 改：:267 调 `localTargetBranch` 时带档位 |
### src/modules/delivery/workflow-manage.ts、src/app/daemon/pm-tools.ts
| 函数名 | 职责 |
|---|---|
| `WorkflowManageToolOptions` / `openWorkflowManageTool` | 改：接收 `deliveryMode` 并传给 `CheckRoundService.open` |
| `PmToolsInput` / `createPmTools` | 改：接收 `deliveryMode` 并传给 `createWorkflowManageTool` |
### src/app/daemon/run-manager.ts
| 函数名 | 职责 |
|---|---|
| `deliveryMode`（私有方法） | 新增：`loadAgentSettings()` 后取 `gitDelivery.mode` |
| `dispatchPmExclusive` / `workflowManage` | 改：构造 `createPmSyncTool`、`createPmTools`、`createWorkflowManageTool` 时传入 `() => this.deliveryMode()` |

## 协作关系
- 交付（plan 06、07）在主窗口里也按同一规则取目标分支：远程用现有 `fetchRemoteTarget`，仅本地用 `checkedOutBranch`。

## 验证方式
- 测试入口：`fetchTargetBranch`、`localTargetBranch`、`syncTargetBranch`、`CheckRoundService.openRound`（经 `tests/workflow-close.test.ts` 现有 sync_required 用例）。
- 测试输入：主仓库 + 需求 worktree，origin 指向本地 bare 仓库且 origin 默认分支比本地 main 多一个提交（或反过来）；档位分别为 `local`、`remote`；主仓库 detached HEAD。
- 预期结果：
- [ ] `local`：同步后需求分支包含本地 main 最新提交、不包含只在 origin 上的提交；过程中 `refs/remotes/origin/*` 没有变化（未 fetch）。
- [ ] `remote`：行为与改前一致（现有 pm-sync 测试全部通过）。
- [ ] `local` 下需求分支不包含本地 main 最新提交时，开检查轮报 `sync_required`；同步后能开。
- [ ] `local` 下主仓库 detached：同步报错原因"主仓库当前没有检出分支"，建议如规则。
- [ ] 守护进程：`loadAgentSettings` 返回 `local` 时 PM 同步工具按本地分支同步（`tests/helpers/run-manager-fixture.ts` 注入）。
