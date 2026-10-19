---
name: 10-final-cleanup
description: 新建续完与一次做完报同样的状态；删掉备份恢复里走不到的按编号续做代码
---
# 收尾清理

## 目标
新建、改草稿续完时，给模型的状态和一次做完相同；备份恢复只保留"每次从头来"的路径。

## 业务规则（来源：PRD 01-program-generated-ids C-4、C-6、C-7，用户 2026-10-19 决定）
- 续完时结果和一次做完相同：新建报 created，改草稿报 saved，不把"这次是续完的"透给模型（C-4）。
- 备份、恢复中断后从头再来（C-6）；编号每次由程序新生成后，"同编号目录已存在就续做"的入口与只为它存在的分支走不到，按反历史包袱删掉（C-7），同步删掉只测这些旧行为的测试。

## 涉及文件
- 修改 `src/modules/requirement/requirement-service.ts`（回执状态）
- 修改 `src/modules/requirement/requirement-backup.ts`、`requirement-recovery.ts`
- 修改测试：`tests/requirement-service.test.ts`、`tests/main-requirement-interaction.test.ts`、`tests/requirement-backup.test.ts`

## 函数清单
| 函数名 | 职责 |
|---|---|
| `RequirementService` 回执组装（修改） | 登记的 Git 结果为 recovered 时，按动作报 created 或 saved |
| `createRequirementBackup`（修改） | 删除"操作目录已存在就续做"的分支与只为它存在的阶段判断 |
| `restoreRequirementBackup`（修改） | 同上 |

## 验证方式
- [ ] Git 提交后、登记前中断的 create，用原内容续完 → status 为 created。
- [ ] 备份、恢复照常成功；中断后再调从头开始。
- [ ] `requirement-backup.test.ts` 删掉同编号重试续做的用例，其余通过。
