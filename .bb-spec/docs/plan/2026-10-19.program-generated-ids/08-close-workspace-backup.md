---
name: 08-close-workspace-backup
description: 关闭需求、工作区准备去掉 operationId，程序按需求自动续办；备份恢复去掉 operationId，中断后从头再来
---
# 关闭、工作区、备份：去掉模型填的编号

## 目标
`one_company_workflow_manage` 的 close 和 `one_company_project_manage` 的 workspace-prepare、backup、restore 参数里没有 operationId。关闭和工作区准备由程序自动续上，备份恢复每次从头来。

## 业务规则（来源：PRD 01-program-generated-ids C-1、C-2、C-3、C-4、C-5、C-6，决策记录"续做由程序按内容认出，模型不填操作编号"）
- 上述动作参数里没有 operationId，带了就是参数不合格。
  - 恢复的 `backupOperationId`、`backupManifestHash` 是引用编号，保留（C-1）。
- backup 结果照旧返回操作编号与 manifestHash，供恢复引用（C-2）。工具说明不出现"新生成""UUIDv7"，也不要求模型填写操作编号（C-3）。
- 关闭（C-4、C-5）：
  - 已有一次在办的关闭时，用原来的原因和决定编号再调 close → 程序用原编号续办，先 closing 后 closed。
  - 原因或决定编号不同 → 被拒，说明已有另一个关闭请求在办理，建议用原来的原因和决定编号续办或按已有请求处理。
  - 关闭已办完再调 → 被拒，说明这次关闭已经办完。
  - "关闭中"的建议写成"等这些事项结束后，用原决定编号 receiptId、原原因 reason 再次 close 续办"。
- 工作区准备（C-4）：记录停在准备中时，再调 workspace-prepare → 程序用原编号续完。已 ready → 直接返回已有工作区（原有行为）。
- 备份、恢复（C-6）：不续做，中断后再调就从头开始一次新的。失败时的建议写"按原因处理后再调一次，会从头开始一次新的备份或恢复"。
- 按编号续做的核对、报错码与文字（close_not_found、close_finished 以外的编号类拒绝、resume_not_found、resume_finished、RESUME_* 常量、resume 入参）删除。

## 涉及文件
- 修改 `src/modules/delivery/workflow-manage-extension.ts`、`workflow-manage.ts`、`workflow-close.ts`、`workspace-manage.ts`
- 修改 `src/modules/project-index/project-manage-tool.ts`、`project-maintenance.ts`
- 修改 `src/modules/requirement/requirement-backup.ts`、`requirement-recovery.ts`
- 修改测试：`tests/workflow-close.test.ts`、`tests/project-manage-tool.test.ts`、`tests/workspace-manage.test.ts`（续做相关用例）

## 成品定义
workflow-close.ts 的拒绝原因表（替换编号类三条）：
```ts
close_finished: "这次关闭已经办完，用 status 查看结果",
close_intent_conflict 对应的结果另加 next："用原来的原因和决定编号再次 close 续办；或按已有请求的原因处理"
```
workflow-manage-extension.ts 说明末尾那句改为：
```text
关闭没办完时，用原来的原因和决定编号再次 close，程序会接着办完。
```
workspace-manage.ts：
```ts
operation_conflict: { why: "这个需求的工作区已经回收", next: "不要再准备这个需求的工作区；需要时请用户处理" },
```
删除 `resume_not_found`、`resume_finished`。

project-manage-tool.ts：
- 工具说明里 operationId 那一句删除；
- `maintenance_failed` 的建议改为"按原因处理后再调一次，会从头开始一次新的备份或恢复"；
- 维护失败的原因不再附编号。

## 函数清单
### src/modules/delivery/
| 函数名 | 职责 |
|---|---|
| `workflow-manage-extension.ts` 参数与说明（修改） | close 删除 operationId |
| `workflow-manage.ts` close 分支与 `explained`（修改） | 删除 operationId 参数和 resume；"关闭中"与冲突拒绝的建议按上文 |
| `RequirementCloseService.close`（修改） | 入参 operationId 改为可选：已有在办关闭且 reason、receiptId 相同 → 用它的编号续办；不同 → close_intent_conflict（结果不带编号）；已 closed → close_finished；没有关闭 → 用 `uuidv7()` 新发起。删除 resume 字段与 close_not_found、close_operation_mismatch、close_content_mismatch |
| `WorkspaceManageService.prepare`（修改） | 入参 operationId 改为可选：记录停在准备中 → 用记录里的编号续完；已回收 → operation_conflict；没有记录 → 新生成。删除 resume 字段与 resume_* |

### src/modules/project-index/、src/modules/requirement/
| 函数名 | 职责 |
|---|---|
| `project-manage-tool.ts` 参数、execute（修改） | prepare、backup、restore 删除 operationId；backup、restore 每次 `uuidv7()`；删除 resume 判断与 resume_* 的 blocked 分支、restore_operation_conflict 续做分支 |
| `project-maintenance.ts` backup、restore（修改） | 删除 resume 传递；restore 照常建隔离目录 |
| `createRequirementBackup`、`restoreRequirementBackup`（修改） | 删除 resume 入参、resume_* 检查与 RESUME_* 常量 |

## 协作关系
- 主窗口 close 经守护进程方法 `workflow.manage` 转发；PM 侧共用守护进程参数定义，权限表禁止 PM close。
- 服务层其他调用方（tests/workspace-manage.test.ts 直接调 `closer.close`、`prepare` 并传编号）可以继续传编号。

## 验证方式
- 测试入口：两个工具的 execute（`tests/workflow-close.test.ts`、`tests/project-manage-tool.test.ts` 现有封装）。
- 预期结果：
  - [ ] close、workspace-prepare、backup、restore 带 operationId → invalid_shape；不带 → 成功。
  - [ ] close 返回 closing 后，用原 reason、receiptId 再调 → 续办到 closed，结果编号与第一次相同。
  - [ ] 已有在办关闭，换 reason 或 receiptId 再调 → 被拒，说明已有另一个关闭请求在办理，状态不变。
  - [ ] 已 closed 后再调 → 被拒，说明已经办完。
  - [ ] 工作区记录停在准备中，再调 workspace-prepare → 续完到 ready，记录编号不变。
  - [ ] 备份中途失败后再调 backup → 从头开始一次新的备份并成功，编号与第一次不同。
  - [ ] backup 结果的编号能用于 restore。
  - [ ] 工具说明里没有"新生成""UUIDv7"和要模型填 operationId 的话；`grep -rn 'resume_not_found\|RESUME_NOT_FOUND\|close_operation_mismatch' src` 没有输出。
