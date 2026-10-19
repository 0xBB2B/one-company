---
name: 06-approval-atomic
description: 批准（confirmUpdate）先做只读检查再在一个事务里写完批准状态，不建操作记录、不接受 operationId；data.db 升到 4
---
# 批准一次写完

## 目标
批准要么完整生效，要么什么都不写，不会留下把需求锁死的半截批准。

## 业务规则（来源：PRD 01-program-generated-ids C-4b 与决策记录"批准一次写完，不再续做"）
- 批准（confirmUpdate）的状态一次写完：要么完整生效，要么什么都不写，不会留下需要续做的半截批准（C-4b）。
- confirmUpdate 不接受 operationId：参数里带了就不合格。编号仍由程序生成，只用来把批准和它的批准对象绑定。
- 另一次保存（create、updateDraft）还没做完，或写占用还在时，批准被拒，报错给出那次保存的操作编号（C-4、C-4b）。
- 批准仍只由用户本轮的确认授权：决定编号和批准清单由宿主在本轮解读后填入，事务前做宿主授权，事务内核对批准清单登记与未被用过（威胁模型"旧流程与旧记录不产生授权"）。
- create、updateDraft 的保存与续做行为不变（C-9）。
- 操作记录格式变了：本机 data.db 版本号从 3 升到 4，版本 3 的旧库打开时报"来自旧版本"的错误，提示备份后删除本机数据目录（用户 2026-10-19 决定；1.0 前不写迁移）。
- 被否决：
  - "续做时用本轮确认换掉旧凭据"：只是缓解症状。
  - "同一事务里建操作记录并直接标完成"：这条记录没有读者。

## 涉及文件
- 修改 `src/modules/requirement/requirement-service.ts`
- 修改 `src/modules/requirement/requirement-state.ts`
- 修改 `src/modules/requirement/requirement-operations.ts`
- 修改 `src/modules/requirement/requirement-prototypes.ts`
- 修改 `src/modules/requirement/requirement-manage-contracts.ts`
- 修改 `src/modules/requirement/prd-storage.ts`
- 修改 `src/modules/interaction/main-requirement-interaction.ts`
- 修改 `src/modules/interaction/requirement-manage-tool.ts`
- 修改 `src/core/storage/database-paths.ts`、`src/core/storage/database.ts`
- 修改测试：`tests/requirement-service.test.ts`、`tests/requirement-events.test.ts`、`tests/requirement-manage-tool.test.ts`、`tests/main-requirement-interaction.test.ts`、`tests/database-storage.test.ts`、`tests/prd-storage.test.ts`

## 成品定义
`src/core/storage/database-paths.ts`：
```ts
export const DATABASE_SCHEMA_VERSIONS: Readonly<Record<DatabaseKind, number>> = Object.freeze({ data: 4, global: 1, index: 2 });
```
`src/core/storage/database.ts`：
```ts
const OUTDATED_VERSIONS: Partial<Record<DatabaseKind, readonly number[]>> = { data: [1, 2, 3], index: [1] };
```
`requirement-manage-contracts.ts`：删除 `approval_not_ready` 一条；如有措辞写"还有没完成的保存或批准"，改为"还有没完成的保存"。

## 函数清单
### src/modules/requirement/requirement-service.ts
| 函数名 | 职责 |
|---|---|
| `update`（修改） | confirmUpdate 不再走 `write()`，改调新的私有 `approve`；删除 `alreadyApproved` 分支 |
| `approve`（新建，私有） | 事务前：`verifyWorkingCopy`、已有的读字节比对、宿主授权与清单核对；然后调 `state.recordApprovedVersion` 一次写完；再组装回执（commit/hash 取已保存版本，status "unchanged"，带 archivePath 与批准范围） |
| `writeOwned`（修改） | 删除 confirmUpdate 分支 |
| `validateReceiptState`（修改） | 去掉 confirmUpdate 条件 |
| `verifyWorkingCopy`（修改） | 参数改为 `{repositoryRoot, targetHash}`，供 `approve` 在事务前核对 prd.md 工作副本 |
| `STATE_SCOPE`（修改） | confirmUpdate 去掉 "saved-version" |

### src/modules/requirement/requirement-state.ts
| 函数名 | 职责 |
|---|---|
| `recordApprovedVersion`（修改） | 事务内先调 `assertNoUnfinishedRequirementOperationsIn`（报错带原编号）和 `assertNoRequirementWriteClaimIn`，再写批准状态 |

### src/modules/requirement/requirement-operations.ts
| 函数名 | 职责 |
|---|---|
| 操作记录 schema 与 `RequirementOperationAction`（修改） | 去掉 confirmUpdate，以及只为批准存在的 receiptId、manifest、docSpec、prototypes、approvalVersion 字段 |
| `checkOperation`、`mutableFields`（修改） | 删掉批准相关的不变量与字段 |
| `prepare`（修改） | 删掉对 `assertApprovableIn` 的调用 |
| `prepareApproval`（删除） | 只服务半截批准 |
| `finalize`、`savedOperationFor`（修改） | 删掉 confirmUpdate 条件与过滤 |

### src/modules/requirement/requirement-prototypes.ts
| 函数名 | 职责 |
|---|---|
| `assertNotApproving`、`assertApprovableIn`（删除） | 只为半截批准存在；并发由事务内原型核对兜底 |

### src/modules/requirement/prd-storage.ts
| 函数名 | 职责 |
|---|---|
| confirmUpdate 存储动作（删除） | 批准不再调存储写入，这个动作已走不到 |

### src/modules/interaction/
| 函数名 | 职责 |
|---|---|
| `requirement-manage-tool.ts` confirmUpdate 参数（修改） | 删除 operationId；execute 仍为 confirmUpdate 用 `uuidv7()` 生成编号交给 confirm |
| `MainRequirementInteraction.confirm`（修改） | 删除 resume 参数与续做核对 |
| `user-interact-tool.ts` 确认回复（修改） | 删除 operationId 字段与续做分支 |

## 协作关系
- `approve` 的授权顺序沿用现有：宿主 `authorizeManifest`（只认本轮能力）→ `registeredApprovalManifestIn` → 状态层事务内再核对登记、未被用过与原型 digest。
- 写锁与未完成核对复用 `requirement-coordination.ts` 现有函数。

## 验证方式
- 测试入口：`RequirementService.confirmUpdate`、`one_company_requirement_manage` 的 confirmUpdate、`one_company_user_interact` 的确认回复、数据库打开。
- 测试输入：现有样例项目与 `manifestConfirmInput` 等测试帮助函数；在 `recordApprovedVersion` 事务内注入一次写入失败（例如让事件写入抛错）。
- 预期结果：
  - [ ] 批准写入中途失败 → 调用被拒；需求记录、事件、批准使用记录、操作记录表、写占用都和调用前一样；随后不填编号重新批准成功。
  - [ ] 批准成功后，操作记录表里没有 action 为 confirmUpdate 的行。
  - [ ] 另造一次没完成的 updateDraft 再批准 → 被拒，报错原因含那次保存的编号。
  - [ ] confirmUpdate、user_interact 确认回复填 operationId → 参数不合格被拒。
  - [ ] 批准与原型看板改动并发时，事务内原型核对拒绝过期的批准。
  - [ ] 打开 user_version=3 的 data.db → 报"来自旧版本"，提示备份后删除本机数据目录；新建库的 user_version 为 4。
  - [ ] 依赖分步批准的旧测试（mock finalize、批准期间锁原型看板、中断后重放补完）删除；其余批准、保存、关闭、备份测试照常通过。
