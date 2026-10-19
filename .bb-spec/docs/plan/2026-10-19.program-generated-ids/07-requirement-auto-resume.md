---
name: 07-requirement-auto-resume
description: 需求保存去掉模型填的 operationId，程序按内容认出没做完的保存并用原编号续完；删掉按编号续做的代码与报错细节
---
# 需求保存：程序按内容认出续做

## 目标
`one_company_requirement_manage` 的 create、updateDraft 参数里没有 operationId。中断后，模型用原内容再调一次，程序就用原编号把那次保存做完。

## 业务规则（来源：PRD 01-program-generated-ids C-1、C-2、C-4、C-4b、C-5、C-7，决策记录"续做由程序按内容认出，模型不填操作编号"）
- create、updateDraft 不接受 operationId，带了就是参数不合格（C-1）。
  - 起因：真实模型验收里，参数里只要有编号字段，模型就会自己编一个或把结果里的编号抄回去，导致 6 条验收失败。
- 结果照旧返回本次保存的操作编号，批准时作为 savedOperationId 使用。两次调用编号不同（C-2）。
- updateDraft 续做：这个需求有一次没做完的保存（操作记录 finalVersion 为空）时，用原来的标题和正文再调一次，程序用那次的编号续完，结果里的操作编号就是原编号（C-4）。
- create 续做：本仓库有一次没做完的 create、而且标题和正文相同，再调一次就用那次的请求编号和操作编号续完，不另建需求（C-4）。
- 内容不同时拒绝（C-5）：报错写明"这个需求还有一次没完成的保存"，建议先用原来的内容再调一次把它续完、再做新的保存。状态不变。
- 批准时另一次保存没做完，批准被拒，报错建议先用原内容续完那次保存再重新批准（C-4b）。
- 找没做完的保存之前，必须先按本窗口做仓库鉴权：不能按模型填的仓库编号先去打开或新建那个仓库的数据库。
- 模型不再接触操作编号，报错里"原操作编号 <uuid>"这类细节、按编号续做的核对（resumable）及其报错码都删掉（C-7 与反历史包袱）。

## 涉及文件
- 修改 `src/modules/interaction/requirement-manage-tool.ts`、`src/modules/interaction/main-requirement-interaction.ts`、`src/modules/interaction/user-interaction.ts`
- 修改 `src/modules/requirement/requirement-operations.ts`、`requirement-coordination.ts`、`requirement-service.ts`、`requirement-manage-contracts.ts`、`requirement-contracts.ts`、`user-interaction-format.ts`
- 修改测试：`tests/requirement-manage-tool.test.ts`、`tests/main-requirement-interaction.test.ts`、`tests/requirement-service.test.ts`、`tests/requirement-state.test.ts` 及断言这些报错文字的测试

## 成品定义：报错文字（requirement-manage-contracts.ts）
```ts
requirement_write_pending: { why: "这个需求还有一次没完成的保存", next: "先用原来的标题和正文再调一次把它续完，再做新的保存" },
write_recovery_required: { why: "上一次保存中途中断，需要先续完", next: "用原来的标题和正文再调一次把它续完" },
unfinished_requirement_operation: { why: "这个需求还有一次没完成的保存", next: "先用原来的标题和正文再调一次 create 或 updateDraft 把它续完，再重新做这一步" },
operation_not_ready: { why: "保存操作还没进行到这一步", next: "用原来的标题和正文再调一次，让它继续完成" },
operation_conflict: { why: "这个需求还有一次没完成的保存，内容和这次不同", next: "先用原来的标题和正文再调一次把它续完，再做新的保存" },
```
`state_changed_after_git`、`git_result_missing`、`write_claim_lost` 的建议改为"用原来的标题和正文再调一次把它续完"。删除 `resume_not_found`、`resume_finished`、`resume_target_mismatch`。

`requirement-contracts.ts`：
- `request_conflict` 改为 `{ why: "本仓库还有一次没完成的新建，内容和这次不同", next: "先用原来的标题和正文再调一次 create 把它续完" }`；
- `operation_conflict` 的建议改为"用原来的内容再调一次把它续完"；
- `close_intent_conflict` 的建议改为"用原来的原因和决定编号再次 close 续办；或按已有请求的原因处理"。

`prd-storage.ts` 的 `operation_conflict` 建议改为"用原来的内容再调一次把它续完"。
`user-interaction-format.ts` 的 `resave_not_finalized` 建议改为"用原来的内容再调一次，让它续完"。

## 函数清单
### src/modules/interaction/requirement-manage-tool.ts
| 函数名 | 职责 |
|---|---|
| 参数 schema（修改） | create、updateDraft 删除 operationId |
| execute（修改） | create、updateDraft 不再生成或传入编号，交给 `draft` 决定；说明里删掉 operationId 那一句 |

### src/modules/interaction/main-requirement-interaction.ts
| 函数名 | 职责 |
|---|---|
| `draft`（修改） | 先做本窗口仓库鉴权，再定本次编号：updateDraft 用 `pendingSave(requirementId)` 找到的没做完的保存编号，没有就 `uuidv7()`；create 用 `pendingCreate(intentHash)` 找到的那次的 requestId 与操作编号，没有就新生成两个 |
| `#resumable`（删除） | 按编号续做的核对不再需要 |

### src/modules/requirement/requirement-operations.ts
| 函数名 | 职责 |
|---|---|
| `pendingSave`（新建） | 返回某需求 finalVersion 为空的那次保存（create 或 updateDraft），没有返回 null |
| `pendingCreate`（新建） | 返回本仓库 action 为 create、finalVersion 为空、intentHash 等于给定值的那次保存，没有返回 null |
| `resumable`（删除） | — |
| `prepare`、`claim`（修改） | `requirement_write_pending` 去掉"原操作编号"细节 |

### src/modules/requirement/requirement-coordination.ts、requirement-service.ts
| 函数名 | 职责 |
|---|---|
| `claimRequirementWriteIn`、`assertNoUnfinishedRequirementOperationsIn`（修改） | 报错去掉编号细节 |
| `RequirementService.write`（修改） | 删掉 `RESUMABLE_FAILURES` 附编号的包装 |

### src/modules/interaction/user-interaction.ts
| 函数名 | 职责 |
|---|---|
| 抛 `resave_not_finalized` 处（修改） | 去掉编号细节 |

## 协作关系
- create 的意图哈希用 `requirementIntentHash`（requirement-service.ts 已导出），与操作记录里的 intentHash 同一算法。
- 服务层同编号同内容续做、同编号不同内容报 `operation_conflict` 的逻辑保持不变，本 plan 只改"编号从哪来"。

## 验证方式
- 测试入口：`one_company_requirement_manage` 的 create、updateDraft（`tests/main-requirement-interaction.test.ts` 的 `w.call`），`RequirementOperations.pendingSave` / `pendingCreate`。
- 测试输入：用 `RequirementOperations.prototype.recordSavedVersion` 抛一次错，造出没做完的 updateDraft 或 create。
- 预期结果：
  - [ ] create、updateDraft 带 operationId（或 create 带 requestId）→ invalid_shape。
  - [ ] 两次 updateDraft 编号不同、版本依次加一；create 结果的操作编号能作为 confirmUpdate 的 savedOperationId。
  - [ ] 没做完的 updateDraft 后，用原内容再调 → 保存完成，结果操作编号等于原编号，需求解锁。
  - [ ] 没做完的 updateDraft 后，用不同内容再调 → 被拒，原因"这个需求还有一次没完成的保存，内容和这次不同"，需求状态不变。
  - [ ] 没做完的 create 后，用原内容再调 → 续完原需求，没有多出第二个需求；用不同内容再调 → 新建另一个需求成功。
  - [ ] 填了不属于本窗口的仓库编号再 updateDraft → 被拒，本机没有建出这个仓库的库。
  - [ ] 批准时另一次 updateDraft 没做完 → 被拒，建议先用原内容续完。
  - [ ] `grep -rn 'resumable\|resume_not_found\|原操作编号' src` 没有输出。
