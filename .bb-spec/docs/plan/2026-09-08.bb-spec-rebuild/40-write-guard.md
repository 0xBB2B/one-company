---
name: write-guard
description: 写入与共享分支守卫：写入前对照他人占用；命令前后按 git 变更路径与占用范围交集核指纹、比对 HEAD 与分支，越界或切换即判本运行失败并使受影响验证失效；范围路径提交与审查快照
---
# 写入与共享分支守卫

## 目标
未获准的写入在编辑与写文件路径上被拦下，无法静态确认范围的命令在执行后被核对，分支现场被改动即被发现，越界写入不能被当作正常交付；提交不混入他人改动，审查结论只对应被审内容。

## 业务规则（来源：spec）
- range-handoff：重叠写入只由一个任务获准；未获准的写入不得发生。
- range-handoff：执行无法静态确认写入范围的命令时，启动前记录其他任务所占范围的内容指纹，结束后核对；发现越界修改即把本任务判为失败并使受影响范围的验证结论失效，不依赖口头提醒。
- validation-consistency：验证期间或放行前发现验证对象变化，拒绝沿用旧通过结论并要求重新核对。
- validation-consistency：多个宿主在共享工作目录提交时只把本任务获准范围内的路径纳入提交；其他宿主存在活动任务时不得切换分支或重置共享现场，发生即判违规并显示原因。
- validation-consistency：完整分支审查保持既定范围与裁决要求，无法取得一致验证现场时等待或阻塞，不假报通过。
- whitebox-review：记录审查快照（分支头与内容指纹）；对象与快照一致才允许远端写入；远端写入前重新采集的快照也必须一致。
- workspace-coordination：需求代理与角色不得读写其他仓库。

## 涉及文件
- 新建 `runtime/write-guard.ts`
- 新建 `runtime/branch-guard.ts`
- 修改 `runtime/shell-bash.ts`（命令执行前后调用 `beforeCommand` / `afterCommand`）
- 新建 `tests/write-guard.test.ts`
- 新建 `tests/shared-branch-guard.test.ts`

## 函数清单
### runtime/write-guard.ts
| 函数名 | 职责 |
|---|---|
| `checkWrite` | 对 edit/write 目标路径：核对在本仓库内、在本任务获准范围内、未被他人占用，返回允许或拒绝原因 |
| `changedPaths` | 读取 `git status --porcelain` 得到工作区变更路径（含未跟踪） |
| `snapshotForeignRanges` | 命令执行前：取变更路径与其他持有者占用范围的交集，计算这些文件的指纹（无交集时快照为空） |
| `verifyAfterCommand` | 命令结束后：重新取变更路径与他人范围的交集，交集中新出现的路径或指纹变化的路径即为越界清单 |
| `snapshotWorkspace` / `verifyWorkspace` | 只读角色用：命令前后对整个工作区变更路径集合与其指纹比对，返回任何写入清单（可排除给定路径） |
| `reportViolation` | 把越界结果写入运行记录（状态 failed、原因含文件清单）并通知调用方 |
| `invalidateValidations` | 把受影响范围关联的验证结论标记为失效（写入需求状态的证据字段） |
| `isCommandScopeStatic` | 判断工具调用是否只写入可静态确认的路径（edit/write），否则走前后核对 |
| `beforeCommand` / `afterCommand` | 组合入口：前置采集他人范围指纹与分支状态，后置核对并在越界或切换时 `reportViolation` |
### runtime/branch-guard.ts
| 函数名 | 职责 |
|---|---|
| `snapshotBranchState` | 命令前记录 HEAD 提交与当前分支名（含 detached） |
| `verifyBranchState` | 命令后重新读取并比对；存在其他活动宿主时 HEAD 或分支变化即返回违规与宿主清单，无其他活动宿主时只返回变化事实；不做命令文本匹配 |
| `activeForeignHosts` | 汇总其他窗口与守护进程内运行中的任务作为违规原因 |
| `scopedCommitPaths` | 由本任务获准范围与工作区改动交集得出可提交路径清单，排除他人范围内的改动 |
| `reviewSnapshot` | 采集分支头、工作区差异与未跟踪文件内容的哈希组成快照 |
| `verifySnapshot` | 远端写入前重新采集并比对，返回一致或差异 |

## 协作关系
- 依赖 `runtime/ranges.ts`（占用与指纹）、`runtime/run-store.ts`（标记失败）、`runtime/workflow-state.ts`（失效标记）、`runtime/identity.ts`（仓库边界）、`runtime/windows.ts` 与 `runtime/daemon-client.ts`（活动宿主）、SDK `exec` 执行 git 命令。
- `runtime/shell-bash.ts` 在主会话与角色的每条 bash 前后调用 `beforeCommand` / `afterCommand`；角色侧 edit/write 的 `checkWrite` 与只读角色的 `snapshotWorkspace` / `verifyWorkspace` 由 `daemon/role-session.ts` 接入；主会话侧 edit/write 钩子由 `extensions/shell-ui.ts` 接入。
- `skills/git-push` 流程调用 `scopedCommitPaths`、`reviewSnapshot`、`verifySnapshot`（经主会话 bash 可调用的入口脚本）。

## 验证方式
- 测试入口：`checkWrite`、`beforeCommand` + `afterCommand`、`snapshotWorkspace` / `verifyWorkspace`、`verifyBranchState`、`scopedCommitPaths`、`reviewSnapshot` / `verifySnapshot`（临时 git 仓库，用真实子进程命令写文件与操作 git）
- 测试输入：他人占用文件 A 与目录 D/；本任务范围 B；命令 `echo x >> A`、只写 B、在 D/ 下新建未跟踪文件、修改他人范围外的大量文件；跨仓库路径；验证结论关联 A；命令 `git switch other`、`git checkout main`、`git reset --hard HEAD~1`、一段用别名切换分支的脚本、`git status`；另一窗口活动记录存在与不存在；工作区同时改动本范围文件与他人范围文件；采集快照后修改一个未跟踪文件
- 预期结果：
  - 对 A 的 edit/write 被拒绝并说明持有者；对 B 允许；跨仓库路径被拒绝。
  - 越界命令后 `afterCommand` 返回 A；D/ 下新建文件被返回；运行记录标 failed 且原因含路径；A 关联的验证结论标失效；只写 B 的命令核对通过，运行状态不变；他人范围外的大量改动不触发核对成本以外的任何判定。
  - 存在活动宿主时四种切换/重置方式（含别名脚本）在命令后均被判违规并列出宿主，`git status` 不触发；无活动宿主时只报告变化不判违规。
  - `verifyWorkspace` 对只读角色的写入返回清单，排除路径的写入不返回。
  - 可提交路径只含本范围文件；修改未跟踪文件后 `verifySnapshot` 报告不一致。
- [ ] 路径写入拒绝与放行
- [ ] 交集指纹核对与越界判失败、验证失效
- [ ] 分支/HEAD 前后比对
- [ ] 只读角色工作区核对
- [ ] 范围路径提交与快照一致性
