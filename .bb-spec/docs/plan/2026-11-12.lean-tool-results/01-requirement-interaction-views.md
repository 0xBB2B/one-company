---
name: 01-requirement-interaction-views
description: 主代理需求工具和 user_interact（接手复核以外）成功时只把模型用得上的字段发给模型，完整结果留在 details
---
# 需求工具和提问工具的结果精简

## 目标
`one_company_requirement_manage` 与 `one_company_user_interact`（purpose 不是 pm-intake 的各动作）成功时，`content` 只放下表"发给模型"的字段，`details` 放完整结果；单次结果和读需求每页的大小上限只按 `content` 算。

## 业务规则（来源：PRD 02-lean-tool-results，OVERVIEW 决策记录 2026-11-12）
pi 工具结果的 `content` 发给模型，`details` 只存进会话记录。下表字段名是结果对象里的原名，取值与改前相同；"发给模型"列以外的字段只在 `details`。字段在结果里不存在时就不出现（如 diff 没有 title、关闭中的需求 metadata 只有 4 个字段）。

| 工具 · 动作 | 发给模型 | 只留存 |
|---|---|---|
| requirement_manage create、updateDraft | requirementId、version、operationId、revision、status | action、commit、prdHash、archivePath、lifecycle、epoch、anchor、approvalScope |
| requirement_manage read、diff、next | requirementId、title、version、text、fromRevision、toRevision、restoreFailure、coverage.nextCursor；coverage.blocking 只在非空时 | source、commit、prdHash、epoch、coverage 的 startByte / endByte / totalBytes / complete、fromCommit、toCommit、fromHash、toHash、historicalEndpoints、approvalScope |
| requirement_manage metadata | requirementId、version、revision、savedOperationId、lifecycle、recovery、restoreFailure、approvalScope.summary.pending、approvalScope.summary.blocked | saved、approved、archivePath、epoch、approvalScope 的 status 和 summary 的 reference / confirmed / excluded |
| requirement_manage confirmUpdate；user_interact reply（purpose 缺省或 user-confirmation） | requirementId、version、prdActivated、blockedBy、blockedReason、implementAuthorization、next | status、action、operationId、savedOperationId、epoch、targetRecorded、decisionIds、scopeStatus、approvalScope、commit、prdHash、archivePath、lifecycle、revision |
| user_interact ask、ask-tech（purpose 缺省或 user-confirmation） | requirementId、version、status、answer | requestId、caption、question、scope、unitIds、actions、authorized、epoch |
| user_interact panel-item 的 ask、ask-tech | decision.itemId、decision.itemVersion（decision 为 null 时写 null）、status、answer、next | requirementId、顶层 itemId、caption、question、version、epoch |
| user_interact adjudicate 的 reply | decisionId、status、choice、next、notRecordedNext、notRecorded | requirementId、maxTurns、taskStatus、itemId、version、epoch |
| requirement_manage list、authorizeImplement | 与改前相同（整份结果） | — |

- 不发给模型的字段去掉后，`content` 仍是 JSON，字段顺序随结果对象。
- 失败时报错文字不变；result_submit 等其他工具不受影响。
- 大小上限数值不变，只算 `content`（用户 2026-11-12 决定）：单次结果 `content` 文字超过 49_152 字节报 `response_limit`；读需求每页按发给模型的视图 JSON 不超过 24_576 字节分页，正文放不下时照旧对半缩，剩不到 4 字节报 `response_limit`。同一份正文每页放下的正文不少于改前。
- 结果送达前核对照常生效：`details` 与执行时核对过的是同一个完整结果对象，送达前它被改动（如改了 version、epoch、approvalScope）仍拒绝送达，报错与改前相同。
- 「提问」卡片读 `details` 里的 caption、question、status、answer，必须照常显示。

## 涉及文件
- `src/modules/interaction/interaction-result-view.ts` 新建
- `src/modules/interaction/main-requirement-interaction.ts` 修改
- `src/modules/interaction/requirement-manage-tool.ts` 修改
- `src/modules/interaction/user-interact-tool.ts` 修改

## 函数清单
### src/modules/interaction/interaction-result-view.ts
| 函数名 | 职责 |
|---|---|
| `draftResultView` | create、updateDraft 结果的发给模型视图 |
| `readResultView` | read、diff、next 页面结果的视图；按结果里有没有 fromRevision 区分 read 与 diff，coverage 只留 nextCursor 和非空的 blocking |
| `metadataResultView` | metadata 结果的视图，approvalScope 只留 summary 的 pending、blocked |
| `confirmResultView` | confirmUpdate 与 user-confirmation reply 共用的视图 |
| `askResultView` | user-confirmation ask、ask-tech 的视图 |
| `panelItemResultView` | panel-item ask、ask-tech 的视图 |
| `adjudicateResultView` | adjudicate reply 的视图 |
| `requirementManageView` | 按 requirement_manage 的 action 选视图；list、authorizeImplement 原样 |

### src/modules/interaction/main-requirement-interaction.ts
| 函数名 | 职责 |
|---|---|
| `MainRequirementInteraction.execute` | 新增视图函数参数：用 `leanToolResult(result, view(result))` 组装返回，`details` 保持为存进 `#deliveries` 的同一对象；`response_limit` 只量 `content` 文字 |
| `MainRequirementInteraction.read` | 分页的 24_576 字节改量 `readResultView(wrap())` 的 JSON，去掉 content 加 details 合计的那道判断 |

### src/modules/interaction/requirement-manage-tool.ts
| 函数名 | 职责 |
|---|---|
| `run`（`createRequirementManageTool` 内） | 调 `interaction.execute` 时传 `requirementManageView` 按当前 action 选出的视图 |

### src/modules/interaction/user-interact-tool.ts
| 函数名 | 职责 |
|---|---|
| `run`（`createUserInteractTool` 内） | panel-item 两个分支传 `panelItemResultView`，adjudicate 传 `adjudicateResultView`，user-confirmation 的 ask、ask-tech 传 `askResultView`、reply 传 `confirmResultView` |

## 协作关系
工具 `run` → `MainRequirementInteraction.execute(…, view)` → 服务结果经 `#prove` 核对 → `leanToolResult` 组装；tool_result 拦截里的 `assertDelivery` 仍核对 `#deliveries` 里的完整结果，不改。`leanToolResult` 在 `src/core/exec/tool-result.ts`。

## 验证方式
- 测试入口：`createRequirementManageTool`、`createUserInteractTool` 返回工具的 `execute`，以及 `requirement-manage-extension` 注册的 tool_result 处理（沿用 `tests/` 里现有需求工具、提问工具测试的搭建方式）。
- 测试输入：各动作一次成功调用（含 diff 指定历史 toRevision、metadata 遇关闭中需求、confirm 的已生效未授权和被挡住两种、panel-item 的 decision 为 null、adjudicate 的任务分支和 unclear 分支）。
- 预期结果：`JSON.parse(content[0].text)` 含"发给模型"列全部存在的字段、不含"只留存"列任何字段；`details` 含两列全部存在的字段，取值与改前相同；list、authorizeImplement 的 content 与改前逐字相同。
- [ ] 60 KB 需求正文分页读：每页 content 不超过 24_576 字节，每页正文字节数不少于改前（改前每页正文可用现有算法在测试里算出对照）。
- [ ] 送达前把 `details` 的 version 或 epoch 改掉，tool_result 被换成"结果送达前核对失败"报错；不改时照常送达。
- [ ] 任一动作失败时报错文字与改前逐字相同。
- [ ] 「提问」卡片对 ask 结果的渲染与改前相同。
- [ ] 现有测试里断言 content 是整份结果的用例，按上表改成断言视图和 details。
