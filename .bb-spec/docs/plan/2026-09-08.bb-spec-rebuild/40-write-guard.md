---
name: write-guard
description: 写入守卫：主会话与角色写入前对照他人占用；命令执行前后对他人范围取指纹核对，越界判本运行失败并使受影响验证失效
---
# 写入守卫

## 目标
未获准的写入在编辑与写文件路径上被拦下，无法静态确认范围的命令在执行后被核对，越界写入不能被当作正常交付。

## 业务规则（来源：spec）
- range-handoff：重叠写入只由一个任务获准；未获准的写入不得发生。
- range-handoff：执行无法静态确认写入范围的命令时，启动前记录其他任务所占范围的内容指纹，结束后核对；发现越界修改即把本任务判为失败并使受影响范围的验证结论失效，不依赖口头提醒。
- validation-consistency：验证期间或放行前发现验证对象变化，拒绝沿用旧通过结论并要求重新核对。
- workspace-coordination：需求代理与角色不得读写其他仓库。

## 涉及文件
- 新建 `runtime/write-guard.ts`
- 修改 `daemon/role-session.ts`（在工具调用钩子接入 `checkWrite` 与命令前后核对）
- 修改 `extensions/shell-ui.ts`（主会话 edit/write/bash 钩子接入）
- 新建 `tests/write-guard.test.ts`

## 函数清单
### runtime/write-guard.ts
| 函数名 | 职责 |
|---|---|
| `checkWrite` | 对 edit/write 目标路径：核对在本仓库内、在本任务获准范围内、未被他人占用，返回允许或拒绝原因 |
| `snapshotForeignRanges` | 命令执行前对其他持有者的范围计算指纹快照 |
| `verifyAfterCommand` | 命令结束后重算指纹，返回被本命令改动的他人范围文件清单 |
| `reportViolation` | 把越界结果写入运行记录（状态 failed、原因含文件清单）并通知调用方 |
| `invalidateValidations` | 把受影响范围关联的验证结论标记为失效（写入需求状态的证据字段） |
| `isCommandScopeStatic` | 判断命令是否只写入可静态确认的路径（如 edit/write 工具），否则走前后核对 |

## 协作关系
- 依赖 `runtime/ranges.ts`（占用与指纹）、`runtime/run-store.ts`（标记失败）、`runtime/workflow-state.ts`（`bindEvidence` / 失效标记）、`runtime/identity.ts`（仓库边界）。
- 角色侧由 `daemon/role-session.ts` 的工具调用钩子在 edit/write/bash 前调用；主会话侧由 `extensions/shell-ui.ts` 在 `tool_call` 事件调用；bash 走 `snapshotForeignRanges` → 执行 → `verifyAfterCommand`。

## 验证方式
- 测试入口：`checkWrite`、`snapshotForeignRanges` + `verifyAfterCommand`（临时仓库，用真实子进程命令写文件）。
- 测试输入：他人占用文件 A；本任务范围 B；命令 `echo x >> A`；命令只写 B；跨仓库路径；验证结论关联 A。
- 预期结果：
  - 对 A 的 edit/write 被拒绝并说明持有者；对 B 允许；跨仓库路径被拒绝。
  - 越界命令后 `verifyAfterCommand` 返回 A；运行记录标 failed 且原因含 A；A 关联的验证结论标失效。
  - 只写 B 的命令核对通过，运行状态不变。
- [ ] 路径写入拒绝与放行
- [ ] 命令前后指纹核对
- [ ] 越界判失败与验证失效
