---
name: 01-requirement-resume
description: 需求保存相关报错带上原操作编号，新增"按编号查可续做的保存"，去掉需求编号撞号报错
---
# 需求模块：续做报错给出原编号

## 目标
需求保存（create、updateDraft、confirmUpdate）中断或还有一次没完成时，给模型看的报错里写明那次保存的操作编号。程序能按编号判断它是不是一次可以续做的保存。

## 业务规则（来源：PRD 01-program-generated-ids）
- 新操作编号由程序在工具层生成，服务层接口照旧要 operationId；本 plan 只改需求模块内部，不改工具参数。
- 凡是报错要模型"用原来的操作编号继续"的地方，都必须给出这个编号（C-4）。分两类：
  - 指向**另一次**没完成的保存：在抛错处把那次的编号取出来带上。
  - 指向**本次**保存：模型没见过程序生成的编号，所以也要带上本次编号。
- 续做时编号不对就拒绝，并写明是哪种情况（C-6）：
  - 编号不存在；
  - 那次保存已完成；
  - 编号属于别的需求或别的动作；
  - 内容与原操作不同。
- 需求编号撞号时，程序自己换一个编号重来，模型看不到；"需求编号已被占用"这条报错删掉（C-7）。
- 需求模块所有给模型的报错里都不出现"新生成"（C-8）。
- 除此之外，保存、批准、关闭的行为不变（C-9）。

## 涉及文件
- 修改 `src/modules/requirement/requirement-operations.ts`
- 修改 `src/modules/requirement/requirement-coordination.ts`
- 修改 `src/modules/requirement/requirement-service.ts`
- 修改 `src/modules/requirement/requirement-state.ts`
- 修改 `src/modules/requirement/requirement-contracts.ts`
- 修改 `src/modules/requirement/requirement-manage-contracts.ts`
- 修改 `src/modules/requirement/prd-storage.ts`
- 修改 `tests/requirement-service.test.ts`、`tests/requirement-state.test.ts`（以及断言这些报错文字的其他需求模块测试）

## 成品定义：报错文字
`requirement-manage-contracts.ts` 的原因与建议表按下面改（`<编号>` 由抛错处经 `withDetail` 拼到原因后面，格式为 `原操作编号 <uuid>`）。

```ts
requirement_write_pending: { why: "这个需求还有一次没完成的保存", next: "在 operationId 填原因里给出的原操作编号，带上那次的原内容再调一次；完成后再做新的" },
write_recovery_required: { why: "上一次保存中途中断，需要先续完", next: "在 operationId 填原因里给出的原操作编号，带上原内容再调一次" },
unfinished_requirement_operation: { why: "这个需求还有没完成的保存或批准", next: "先在 operationId 填原因里给出的原操作编号，带原内容续完它" },
operation_not_ready: { why: "保存操作还没进行到这一步", next: "在 operationId 填原因里给出的原操作编号再调一次，让它继续完成" },
operation_conflict: { why: "续做的内容与原操作不同", next: "带上原来的内容续做；不是续做就不填 operationId，重新发起" },
resume_not_found: { why: "找不到这个操作编号对应的保存", next: "不是续做就不填 operationId，重新发起" },
resume_finished: { why: "这个操作编号对应的保存已经完成", next: "不填 operationId 发起新的保存；要看结果就用 read 或 metadata 重新读取" },
resume_target_mismatch: { why: "这个操作编号属于别的需求或别的动作", next: "核对报错或结果给出的编号；不是续做就不填 operationId" },
```

`state_changed_after_git`、`git_result_missing`、`write_claim_lost` 三条的建议里"用原来的操作编号"改成"在 operationId 填原因里给出的原操作编号"，原因部分保持不变。

`requirement-contracts.ts`：
- 删除 `identity_collision`。
- `request_conflict` 改为 `{ why: "续做的内容与原操作不同", next: "带上原来的内容续做；不是续做就不填 operationId，重新发起" }`。
- `operation_conflict` 改为 `{ why: "同一操作编号已用于不同的需求或内容", next: "带上原来的内容续做；不是续做就不填 operationId，重新发起" }`。
- `close_intent_conflict` 的建议改为 `"在 operationId 填原因里给出的原操作编号，用原决定编号、原原因再次 close 续办；或按已有请求的原因处理"`。

`prd-storage.ts` 里 `operation_conflict` 的建议改为 `"带上原来的内容续做；不是续做就不填 operationId，重新发起"`。

## 函数清单
### src/modules/requirement/requirement-operations.ts
| 函数名 | 职责 |
|---|---|
| `RequirementOperations.resumable`（新建） | 按编号读操作记录，校验能否续做：不存在报 `resume_not_found`；`finalVersion` 已有值报 `resume_finished`；需求编号或 action 与调用方给的不一致报 `resume_target_mismatch`；通过时返回记录（create 续做要用其中的 `requestId`） |
| `RequirementOperations.prepare`（修改） | 两处 `requirement_write_pending` 把找到的那次未完成操作的编号（或写占用记录里的编号）作为 detail 带上 |
| `RequirementOperations.claim`（修改） | 同上，`otherPending` 改成取出编号再带上 |

### src/modules/requirement/requirement-coordination.ts
| 函数名 | 职责 |
|---|---|
| `claimRequirementWriteIn`（修改） | `requirement_write_pending`、`write_recovery_required` 带上占用记录里的原操作编号 |
| `assertNoUnfinishedRequirementOperationsIn`（修改） | `unfinished_requirement_operation` 把未完成操作的编号列出来带上，不再只留布尔值 |

### src/modules/requirement/requirement-service.ts
| 函数名 | 职责 |
|---|---|
| `RequirementService.write`（修改） | 统一兜住本次操作抛出的 `state_changed_after_git`、`git_result_missing`、`write_claim_lost`、`operation_not_ready`，用 `withDetail` 附上本次操作编号后再抛，不在各个抛错处分散改 |

### src/modules/requirement/requirement-state.ts
| 函数名 | 职责 |
|---|---|
| `RequirementStateStore.reserve`（修改） | 新生成的需求编号撞上已有需求时，换一个重新生成，直到不撞；删除 `identity_collision` 抛错 |

## 协作关系
- `resumable` 供 02 号 plan 的工具层调用，用来判断模型填的编号能不能续做。
- 报错经 `RequirementServiceError` 进入 `withDetail`（`src/core/exec/tool-failure.ts`），最后由工具层 `toolFailure` 拼成"原因/建议"文字给模型。
- `requirement-contracts.ts` 的 `close_intent_conflict` 文字由关闭需求流程使用，本 plan 只改文字。

## 验证方式
- 测试入口：`RequirementService` 的 create/updateDraft/confirmUpdate，`RequirementOperations.resumable`，`RequirementStateStore.reserve`。
- 测试输入：用 `tests/requirement-service.test.ts` 现有的样例项目和 authorize 登记方式，人为留下一次 `finalVersion` 为空的保存。
- 预期结果：
  - [ ] 留下一次未完成的 updateDraft 后，用另一个编号再保存：报 `requirement_write_pending`，错误的 advice.why 里含原操作编号。
  - [ ] 用原编号、原内容再调：保存完成，需求解锁。
  - [ ] `resumable`：不存在的编号报 `resume_not_found`；已完成操作的编号报 `resume_finished`；别的需求或别的 action 的编号报 `resume_target_mismatch`；未完成的同需求同 action 编号返回记录，create 记录里有 `requestId`。
  - [ ] 本次操作中途报 `git_result_missing` 等时，advice.why 里含本次操作编号。
  - [ ] 让 `uuidv7` 第一次返回一个已存在的需求编号：create 仍成功，得到另一个编号。
  - [ ] `grep -rn '新生成' src/modules/requirement | grep -v '重新生成'` 没有输出；`grep -rn identity_collision src` 没有输出。
  - [ ] `tests/error-advice-coverage.test.ts` 通过（新增的码都在表里）。
