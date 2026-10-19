---
name: 02-interaction-tools
description: 需求管理与提问两个工具由程序生成编号；只有续做保存时接受模型填的编号；删除按编号缓存结果的宿主逻辑
---
# 需求管理与提问工具：编号由程序生成

## 目标
`one_company_requirement_manage` 和 `one_company_user_interact` 不填编号就能调用。程序在每次调用时生成编号；模型只在续做中断的保存时，照抄报错或结果给出的编号。

## 业务规则（来源：PRD 01-program-generated-ids）
- 所有动作不填 `requestId`、`operationId` 都能成功；新编号由程序生成，是合规 UUIDv7（C-1）。
- 每次写入类调用的结果里带本次操作编号；两次不填编号的调用得到两个不同编号（C-2）。
- 工具说明里没有要模型生成编号的话，不出现"新生成""UUIDv7"。写明：operationId 只在续做时填，只填报错或结果给出的编号（C-3）。
- 续做：带原编号、原内容再调，原保存完成，结果与一次做完相同（C-5）。编号不对就拒绝，说明是哪种情况（C-6）。
- 编号由程序生成后不可能发生的报错删掉，包括"这个操作编号之前已失败过，不能再用"（C-7）。
- 搜索 `新生成`（排除"重新生成"）在 src 里没有输出（C-8）。
- 其余起草、提问、批准、接手复核、裁决行为不变（C-9）。
- 决策理由：工具说明本来就要求每次新编号，主代理规矩也禁止原样重试，所以"带同一编号重放上次结果"的保护实际用不到，整套删除。

## 涉及文件
- 修改 `src/modules/interaction/requirement-manage-tool.ts`
- 修改 `src/modules/interaction/user-interact-tool.ts`
- 修改 `src/modules/interaction/main-requirement-interaction.ts`
- 修改 `src/modules/interaction/main-intake-interaction.ts`
- 修改 `src/modules/interaction/user-interaction.ts`
- 修改 `src/modules/requirement/host-authorization.ts`
- 修改 `src/modules/requirement/user-interaction-format.ts`
- 修改 `src/modules/requirement/short-decision-format.ts`
- 修改 `src/modules/pm/pm-intake-service.ts`、`src/modules/pm/pm-intake-store.ts`
- 修改测试：`tests/requirement-manage-tool.test.ts`、`tests/user-interact-tool.test.ts`、`tests/main-requirement-interaction.test.ts`、`tests/host-result-currentness.test.ts`、`tests/installation/requirement-manage.test.ts`、`tests/integration/requirement-interaction.test.ts`、`tests/integration/mention-completion.test.ts`、`tests/helpers/main-adjudication.ts`、`tests/helpers/main-intake-test-support.ts`、`tests/main-intake-interaction*.test.ts`、`tests/integration/pm-intake-interaction.test.ts`、`tests/adjudication.test.ts`、`tests/error-advice-coverage.test.ts`

## 成品定义：工具参数与说明
参数（`id` 为现有 UUIDv7 正则；`Type.Optional` 表示可不填）：

| 工具 / 动作 | 编号字段 |
|---|---|
| requirement_manage create | 删除 `requestId`；`operationId: Type.Optional(id)` |
| requirement_manage updateDraft、confirmUpdate | `operationId: Type.Optional(id)` |
| user_interact user-confirmation reply | `operationId: Type.Optional(id)` |
| user_interact user-confirmation ask、panel-item ask、adjudicate reply、pm-intake ask、pm-intake reply | 删除 `operationId` |

说明文字里关于编号的那一句，两个工具都改成下面这句（requirement_manage 版本开头保留"requirementId、version、savedOperationId 取自此前工具结果，不要自编"）：

```text
operationId 由程序生成，平时不填；只有报错或结果给出原操作编号、要续做那次没完成的保存时，才照抄那个编号填进来，并带上原来的内容。
```

报错文字：
- `host-authorization.ts`：删除 `stale_operation_result` 和 `operation_conflict` 两条。
- `user-interaction-format.ts` 的 `resave_not_finalized` 建议改为 `"在 operationId 填原因里给出的原操作编号再调一次，让它续完"`。
- `short-decision-format.ts` 的 `operation_conflict` 建议改为 `"同一批决定的内容不一致，把这段原因告诉用户"`。
- `pm-intake-store.ts` 的 `operation_conflict` 建议改为 `"重新读取当前复核请求后再操作"`。
- `pm-intake-service.ts` 的 `invalid_operation` 建议改为 `"程序生成的操作编号不合规，把这段原因告诉用户"`。

## 函数清单
### src/modules/interaction/requirement-manage-tool.ts
| 函数名 | 职责 |
|---|---|
| `createRequirementManageTool` 的 execute（修改） | create/updateDraft/confirmUpdate：没填 operationId 就用 `uuidv7()` 生成；create 同时生成 requestId。填了就调 01 号 plan 的 `RequirementOperations.resumable`（按需求编号与 action 校验），通过后 create 用记录里的 requestId。最后把补全的编号交给 `interaction.execute` |

### src/modules/interaction/user-interact-tool.ts
| 函数名 | 职责 |
|---|---|
| 工具 execute（修改） | user-confirmation reply 与上面同样处理 operationId（action 按 confirmUpdate 校验）；ask 由程序生成编号后交给 `ask()`；panel-item、adjudicate 不再传编号 |

### src/modules/interaction/main-requirement-interaction.ts
| 函数名 | 职责 |
|---|---|
| `execute`（修改） | 删除 `#completed`、`#failedOperations` 两个字段，删除按编号命中缓存、写入缓存、出错时作废缓存的逻辑 |
| `#invalidateOperation`（删除） | 只服务于上述缓存 |
| `assertDelivery`（修改） | 删掉遍历 `#completed` 作废缓存的循环；catch 里仍然清游标并 `throw error` |
| `revoke` 等清空集合的地方（修改） | 去掉对已删除字段的清空 |

### src/modules/interaction/main-intake-interaction.ts
| 函数名 | 职责 |
|---|---|
| `execute`（修改） | ask、reply 由程序 `uuidv7()` 生成编号，直接传给 `service.openRequest`、`service.recordReview`；不写回 params，`observeToolCall` 与 tool_result 对原始输入算的指纹保持一致 |
| 结果组装处（修改） | ask、reply 的结果里带上本次操作编号 |

### src/modules/interaction/user-interaction.ts
| 函数名 | 职责 |
|---|---|
| 抛 `resave_not_finalized` 处（修改） | 用 detail 带上原操作编号 |

## 协作关系
- 依赖 01 号 plan 新增的 `RequirementOperations.resumable` 和带编号的续做报错。
- `uuidv7` 来自 `src/core/storage/database.ts`。
- 服务层（`RequirementService`、`PmIntakeService`）接口不变，仍收 operationId。

## 验证方式
- 测试入口：两个工具的 execute（`w.call` 等现有测试封装），`MainIntakeInteraction.execute`。
- 测试输入：沿用现有样例项目。scripted 解读器（按 `candidate.candidateId` 写回复的那几处）改为从调用时收到的上下文里取 candidateId，不再用测试预先选定的编号。
- 预期结果：
  - [ ] create 不填 requestId、operationId 成功，结果带需求编号和操作编号；带 requestId 被拒（字段不允许）。
  - [ ] 同一需求连续两次不填编号 updateDraft：编号不同，版本号依次加一。
  - [ ] 制造一次未完成的 updateDraft，再发起新保存：报错里含原编号；照抄编号、原内容再调：保存完成。
  - [ ] 续做时填不存在的编号、已完成操作的编号、别的需求的编号、内容不同的原编号：分别被拒，文字写明原因，需求状态没变。
  - [ ] user_interact 的 ask、panel-item、adjudicate、pm-intake 不填编号都成功；pm-intake 的 ask/reply 结果带操作编号；带 operationId 调这几种被拒（字段不允许）。
  - [ ] pm-intake 指纹核对相关测试（`unobserved_tool_call`、`delivery_changed`）照常通过。
  - [ ] 两个工具的说明里没有"新生成""UUIDv7"；`grep -rn 'stale_operation_result' src` 没有输出。
  - [ ] `tests/requirement-manage-tool.test.ts` 里逐字断言的允许字段表按新字段更新后通过；原"同一 operationId 重调返回缓存"的测试删除。
