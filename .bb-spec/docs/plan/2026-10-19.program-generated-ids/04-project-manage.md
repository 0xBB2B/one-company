---
name: 04-project-manage
description: 项目管理工具的工作区、备份、恢复编号由程序生成；准备工作区和备份恢复中断时给出原编号
---
# 项目管理工具：编号由程序生成

## 目标
`one_company_project_manage` 的工作区准备与回收、备份、恢复、恢复检查都不用填 operationId。工作区准备和备份恢复中断时，报错里给出原编号，模型照抄续做。

## 业务规则（来源：PRD 01-program-generated-ids）
- 所有动作不填 operationId 能成功；程序生成合规 UUIDv7；结果里带本次编号（C-1、C-2）。
- 续做场景（C-4）：
  - 工作区准备中断（记录停在准备中），之后不填编号再准备：拒绝，原因里写原操作编号。
  - 备份、恢复失败或中断：报错里写本次操作编号，建议可照抄它续做。
- 带原编号再调，原操作完成，结果与一次做完相同（C-5）。
- 填了编号但对不上时拒绝，并写明原因（C-6）：
  - 编号不存在；
  - 那次操作已完成；
  - 编号属于别的需求或别的动作。
- 恢复检查（recovery-check）不按编号保存进度，没有续做场景：不接受 operationId。工作区回收也不按编号续做：不接受 operationId。
- 说明文字与报错里不出现"新生成""UUIDv7"（C-3、C-8）。其他行为不变（C-9）。

## 涉及文件
- 修改 `src/modules/project-index/project-manage-tool.ts`
- 修改 `src/modules/project-index/project-maintenance.ts`
- 修改 `src/modules/delivery/workspace-manage.ts`
- 修改 `src/modules/requirement/requirement-backup.ts`
- 修改 `src/modules/requirement/requirement-recovery.ts`
- 修改测试：`tests/project-manage-tool.test.ts`、`tests/workspace-manage.test.ts`、`tests/project-maintenance.test.ts`、`tests/requirement-backup.test.ts`（只改续做相关用例与新增用例）

## 成品定义
参数（`project-manage-tool.ts`）：

| 动作 | operationId |
|---|---|
| workspace-prepare、backup、restore | `Type.Optional(UUID_V7 字符串)` |
| workspace-recycle、recovery-check | 删除该字段 |

restore 的 `backupOperationId`、`backupManifestHash` 不变（它们来自 backup 结果）。

工具说明里"operationId 每次新生成 UUIDv7，requirementId 取自需求工具结果，不要自编"改为：

```text
requirementId 取自需求工具结果，不要自编；operationId 由程序生成，平时不填，只有报错给出原操作编号、要续做那次没完成的工作区准备、备份或恢复时，才照抄那个编号填进来。
```

`workspace-manage.ts` 的原因与建议表：

```ts
operation_conflict: { why: "这个需求的工作区还有一次没完成的准备", next: "在 operationId 填原因里给出的原操作编号再调一次 workspace-prepare，让它续完" },
resume_not_found: { why: "找不到这个操作编号对应的工作区准备", next: "不是续做就不填 operationId，重新发起" },
resume_finished: { why: "这个操作编号对应的工作区准备已经完成", next: "不填 operationId；用 status 查看工作区" },
```

备份、恢复失败时，`maintenance_failed` 的原因后面拼上 `本次操作编号 <uuid>`，建议改为：

```text
按原因处理后，在 operationId 填原因里给出的本次操作编号再调一次可以续做；想从头来就不填
```

续做校验失败的文字（备份、恢复共用）：

```ts
resume_not_found: "找不到这个操作编号对应的备份或恢复，不是续做就不填 operationId",
resume_finished: "这个操作编号对应的备份或恢复已经完成，不填 operationId 发起新的",
```

## 函数清单
### src/modules/project-index/project-manage-tool.ts
| 函数名 | 职责 |
|---|---|
| 工具 execute（修改） | 各动作没填编号时用 `uuidv7()` 生成；workspace-prepare/recycle、recovery-check 的结果加上 operationId；备份、恢复失败时把本次编号拼进原因 |

### src/modules/delivery/workspace-manage.ts
| 函数名 | 职责 |
|---|---|
| `WorkspaceManageService.prepare`（修改） | 记录停在准备中且编号不同：`operation_conflict` 以 detail 带上原编号。续做时（调用方标明续做）：没有记录 → `resume_not_found`；记录已 ready → `resume_finished`；编号不同 → `operation_conflict` |

### src/modules/requirement/requirement-backup.ts、requirement-recovery.ts
| 函数名 | 职责 |
|---|---|
| `createRequirementBackup`（修改） | 续做时编号对应的备份目录不存在 → `resume_not_found`；日志已完成 → `resume_finished` |
| `restoreRequirementBackup`（修改） | 同上，按恢复日志判断 |

### src/modules/project-index/project-maintenance.ts
| 函数名 | 职责 |
|---|---|
| backup、restore 入口（修改） | 把"是否续做"传给上面两个函数 |

## 协作关系
- 工作区、备份、恢复都在主窗口扩展进程里直接执行，不经守护进程。
- `uuidv7` 来自 `src/core/storage/database.ts`。
- 本 plan 独占 `requirement-backup.ts`；其中 `unfinished_requirement_operation` 的报错文字由 01 号 plan 的表提供，本 plan 不改该表。

## 验证方式
- 测试入口：`one_company_project_manage` 工具 execute，`WorkspaceManageService.prepare`，`createRequirementBackup`，`restoreRequirementBackup`。
- 测试输入：沿用现有样例项目；手工写一条状态为准备中的工作区记录（与现有续做测试相同方式）；让备份在中途失败（与现有备份重试测试相同方式）。
- 预期结果：
  - [ ] 五个动作不填 operationId 都成功，结果带程序生成的编号；recycle、recovery-check 带 operationId 被拒（字段不允许）。
  - [ ] 准备中的记录存在时不填编号再准备：拒绝，原因含原编号；照抄编号再调：工作区 ready。
  - [ ] 备份中途失败：报错原因含本次编号；照抄编号再调：备份完成，回执与一次做完相同。
  - [ ] 续做填不存在的编号、已完成的编号：分别被拒，文字对应上表。
  - [ ] 工具说明与 `workspace-manage.ts` 里没有"新生成""UUIDv7"。
