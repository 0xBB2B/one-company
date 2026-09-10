---
name: write-guard
description: 写入范围与共享 Git 保护：文件隔离、命令前后核对、明确路径提交和审查快照
---
# 写入与共享分支守卫

## 目标
文件写入只落在获准范围；共享 Git 元数据受保护，提交不夹带他人内容，切换与重置在现场改变之前被阻止。审查结论只对应被审内容。

## 业务规则（来源：spec）
- range-handoff：重叠写入只由一个任务获准；命令先受文件隔离约束，再核对他人范围指纹，越界使运行失败并使受影响验证失效。
- validation-consistency：共享提交只纳入明确选择且获准的文件，保留其他需求的暂存与未暂存内容；其他宿主活动时在修改前拒绝分支切换和重置，包含脚本与别名。
- validation-consistency：无法取得一致验证现场时等待或阻塞，不缩小完整分支审查范围，不沿用失效证据。
- whitebox-review：远端写入前重新采集快照，与审查快照一致才允许放行。
- workspace-coordination：需求代理与角色不得读写其他仓库。

## 生产入口与职责

| 入口 | 职责 |
|---|---|
| `runtime/range-protection.ts:createRangeProtection` | 组合 SQLite 范围占用、文件写入检查、命令隔离、指纹与分支核对、受管提交及资源释放 |
| `checkWrite` | 解析真实路径，核对获准范围和占用；拒绝直接修改 `.git`、当前 worktree Git 目录和公共 Git 目录，包含符号链接落点 |
| `commandGuard.before/launch/after` | 执行前取得范围与快照，Shell 在 macOS 沙箱内运行，共享 Git 元数据只读；失败反馈说明版本操作入口及其他活动宿主；命令结束后核对现场 |
| `runtime/git-commit-tool.ts:createGitCommitTool` | 注册 `pi_company_git_commit`，仅接受文件 `paths` 与提交 `message`，传递中止信号 |
| `createRangeProtection.commit` | 核对文件授权、占用和重命名两端；受管 `git add` 与 `git commit --only` 使用字面路径参数，保留未选文件的索引和工作区内容 |
| `runtime/branch-guard.ts:scopedCommitPaths` | 从实际 Git 状态筛选明确选择的文件；重命名一端未选时阻止提交 |
| `runtime/write-guard.ts:snapshotForeignRanges/verifyAfterCommand` | 记录他人范围指纹并核对变化；生产路径使用隔离执行取得的 Git 状态 |
| `snapshotBranchState/verifyBranchState` | 核对分支与 HEAD，区分快进和现场切换，作为执行后的异常检测 |
| `collectGitSnapshot/currentVersion` | 生产派工和工作流核对完整内容版本，包括 HEAD、分支、索引、工作区差异与未跟踪文件内容 |

## 接线

- `extensions/write-protection.ts`：主会话 edit/write 调用 `checkWrite`；提交工具取得当前窗口及仓库的范围保护。
- `extensions/shell-ui.ts`：主会话 bash 与用户 !、!! 都通过同一 commandGuard。
- `daemon/run-manager.ts`：按运行身份创建范围保护，向角色和需求代理传递 commandGuard、commit 与文件检查。
- `daemon/role-session.ts`：有 bash 权限的可写会话提供受管提交；只读角色、暂停、核对期和结构化结果提交后的会话不能借提交工具越权。
- `skills/git-commit`：会话内通过受管提交选择文件；用户终端的命令示例不作为受管 Shell 的权限入口。

## 执行边界

- 普通 Shell 的 Git 元数据始终只读，不通过命令字符串匹配判断权限。分支切换、重置和历史重写不由该入口提供，即使没有其他活动宿主也不扩大权限。
- 提交使用系统 Git 的固定 argv，在文件沙箱内执行；禁止启动外部程序，不把提交信息或文件名解释成 Shell。Git 的状态查询也受隔离，避免 filter、fsmonitor 等配置在检查阶段执行越界操作。
- 存在可执行的提交 hook 或外部 clean/process filter 时，在暂存前拒绝提交；签名等外部程序无法执行时报告失败，不关闭校验。提交失败时本任务文件可能已暂存，调用方应重新读取状态。
- Git 自身的索引与引用锁处理并发；锁冲突报告失败，由调用方重新核对后重试，不删除他人的锁。文件占用保护持续到受管操作结束。
- Git 命令通过 ShellRegistry 登记宿主，执行时限 30 秒，传递中止信号；其他平台缺少隔离后端时拒绝执行。
- SQLite 保存范围、运行及 Shell 记录；释放角色范围时同时核对当前宿主任务与仓库持久化 Shell 登记，窗口本地列表为空不能证明后台命令已结束。Git 索引、引用和对象属于 Git 管理的仓库数据。

## 验证

- `tests/managed-git.test.ts`：真实仓库和 linked worktree，经实际 Shell 与提交工具执行；验证他人部分暂存保留、主会话/角色明确路径提交、别名/脚本切换和重置被拒、共享元数据直接写入、符号链接与硬链接绕行被拒、hook/filter 阻塞、重命名两端、删除、字面路径、信息注入、子目录路径解析、取消不暂存与并发提交重试。
- `tests/integration/default-workflow.test.ts`：默认角色经真实 SDK 和 RunManager 调用受管提交，再独立复跑、审查与验收；模型回复受控。
- `tests/integration/sdk-loading.test.ts`：真实 SDK 从扩展入口加载提交工具。
- `tests/write-guard.test.ts`：实际范围保护入口的文件检查、主会话与角色竞争、受管命令阻止越界、外部修改使证据失效、跨宿主后台 Shell 保护及安全释放。
- `tests/shared-branch-guard.test.ts`：生产仍使用的分支快照、活动宿主及提交路径筛选；分支事后异常检测与受管命令预防性验证分别核对。
- `tests/shell-bash-tool.test.ts`、`tests/role-session.test.ts`、`tests/run-manager.test.ts`：命令失败、中止、后台、会话阶段检查与运行生命周期。

## 状态

- [x] 路径写入拒绝与放行
- [x] 他人范围指纹核对与验证失效
- [x] 分支/HEAD 前后比对
- [x] 只读角色工作区核对
- [x] 实际提交只包含明确获准路径，Shell 切换与重置在修改前拒绝
- [x] 仅测试调用的组合和快照接口已清理，范围回归使用生产入口
- [ ] 审查和验收的读取范围尚须接入占用保护；全部规范逐项验收见 ACCEPTANCE.md
