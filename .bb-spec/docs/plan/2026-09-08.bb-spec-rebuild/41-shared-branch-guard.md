---
name: shared-branch-guard
description: 共享分支守卫：提交只纳入获准范围路径，他人活动时拒绝分支切换与重置，审查快照采集与远端写入前核对
---
# 共享分支守卫

## 目标
共享工作目录里多个宿主并行时，提交不混入他人改动，分支现场不被破坏，审查结论只对应被审内容。

## 业务规则（来源：spec）
- validation-consistency：多个宿主在共享工作目录提交时只把本任务获准范围内的路径纳入提交；其他宿主存在活动任务时拒绝切换分支或重置共享现场并显示原因。
- validation-consistency：完整分支审查保持既定范围与裁决要求，无法取得一致验证现场时等待或阻塞，不假报通过。
- direct-pre-review：记录审查快照（分支头与内容指纹）；对象与快照一致才允许远端写入；远端写入前重新采集的快照也必须一致。

## 涉及文件
- 新建 `runtime/branch-guard.ts`
- 修改 `runtime/shell-bash.ts`（在命令执行前调用 `checkBranchSwitch`）
- 新建 `tests/shared-branch-guard.test.ts`

## 函数清单
### runtime/branch-guard.ts
| 函数名 | 职责 |
|---|---|
| `scopedCommitPaths` | 由本任务获准范围与工作区改动交集得出可提交路径清单，排除他人范围内的改动 |
| `checkBranchSwitch` | 识别切换或重置现场的命令（切换分支、检出分支、暂存工作区、硬重置），存在其他活动宿主时返回拒绝与原因 |
| `activeForeignHosts` | 汇总其他窗口与守护进程内运行中的任务作为拒绝原因 |
| `reviewSnapshot` | 采集分支头、工作区差异与未跟踪文件内容的哈希组成快照 |
| `verifySnapshot` | 远端写入前重新采集并比对，返回一致或差异 |

## 协作关系
- 依赖 `runtime/ranges.ts`（获准范围）、`runtime/windows.ts` 与 `runtime/daemon-client.ts`（活动宿主）、SDK `exec` 执行 git 命令。
- `runtime/shell-bash.ts` 在主会话与角色 bash 执行前调用 `checkBranchSwitch`；`skills/git-push` 流程调用 `scopedCommitPaths`、`reviewSnapshot`、`verifySnapshot`（经主会话 bash 可调用的入口脚本）。

## 验证方式
- 测试入口：`scopedCommitPaths`、`checkBranchSwitch`、`reviewSnapshot` / `verifySnapshot`（临时 git 仓库）。
- 测试输入：工作区同时改动本范围文件与他人范围文件；命令 `git switch other`、`git checkout main`、`git stash`、`git reset --hard`、`git status`；另一窗口活动记录存在与不存在；采集快照后修改一个未跟踪文件。
- 预期结果：
  - 可提交路径只含本范围文件。
  - 存在活动宿主时四条切换/重置命令被拒绝并列出宿主，`git status` 放行；无活动宿主时放行。
  - 修改未跟踪文件后 `verifySnapshot` 报告不一致。
- [ ] 范围路径提交
- [ ] 切换与重置拒绝
- [ ] 快照一致性
