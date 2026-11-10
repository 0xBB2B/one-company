---
name: 04-line-process-records
description: 短决定、待答提问、连续性事实、批准清单挂上锚点，批准前只认当前对话线上的；批准时把这条线定为需求的正式状态
---
# 过程记录按对话线算数

## 目标
批准前，一条对话线上做的短决定、提的问题、登记的批准清单只在这条线上算数；批准时只引用当前线上的决定，批准后需求按现有方式运行。

## 业务规则（来源：PRD 01-line-bound-draft 约束 3、4、12、13；OVERVIEW 决策记录）
- 短决定、待答提问、连续性事实（`interaction_resolution_facts_v1`）、批准清单（`approval_manifests_v1`）留在数据库，记录内容和版本号都不改；每条用 01-line-anchor-foundation 的 `line_anchor_members` 挂到产生它的锚点上，同一事务写。
- 批准前，读这些记录的所有地方只认当前线上算数的（锚点在线尖祖先链上，或没挂锚点的旧记录）。
- 在线 A 上做的短决定，换到不经过那一步的线 B 后批准，批准清单里不引用它；线 A 上没回答的提问，在线 B 上看不到。
- 批准依据链（同一事务读清单、决定、事实再写需求记录；事实必须是第 1 版、被取代的决定正好加 1；inputProof）原样保留，只是收集的集合换成"当前线上算数的"。这是威胁模型第二条"旧流程与旧记录不产生授权"的保证，筛选只能让集合变小，不能让别的线上的记录混进来。
- 草稿阶段，这些记录里 `requirementVersion` / `basis.version` 用的是线尖版本号（01 定义），替换 requirements 行的版本号；需求已批准后仍用 requirements 行的版本号。
- 批准（confirmUpdate）时：requirements 行的 saved 和 approved 都设成当前线上那一版的提交，同一事务写一个 approval 锚点（父 = 线尖）。批准后算数的记录 = 批准锚点及其祖先 + 批准之后产生的全部记录。
- 已批准需求的修订草稿（批准后又在改）不按对话线筛选。

## 涉及文件
- 修改 `src/modules/requirement/short-decisions.ts`
- 修改 `src/modules/requirement/interaction-continuity.ts`
- 修改 `src/modules/requirement/approval-manifest-store.ts`
- 修改 `src/modules/requirement/host-authorization.ts`
- 修改 `src/modules/requirement/requirement-state.ts`
- 修改 `src/modules/requirement/requirement-service.ts`
- 修改 `src/modules/interaction/user-interaction.ts`
- 修改 `src/modules/interaction/main-requirement-interaction.ts`
- 修改 `tests/short-decisions.test.ts`、`tests/interaction-continuity.test.ts`、`tests/approval-manifest-store.test.ts`、`tests/user-interaction.test.ts`、`tests/main-requirement-interaction.test.ts`、`tests/requirement-approval-manifest.test.ts`

## 函数清单
### src/modules/requirement/short-decisions.ts
| 函数名 | 职责 |
|---|---|
| `ShortDecisionStore.append` | 改：草稿阶段按线尖版本号核对 batch.version；同事务为每条新决定 `attachRecordIn`；被取代的旧决定必须在当前线上算数 |
| `ShortDecisionStore.read` | 改：可带对话线，返回的决定只含算数的 |

### src/modules/requirement/interaction-continuity.ts
| 函数名 | 职责 |
|---|---|
| `recordInteractionResolutionIn` | 改：同事务把事实挂到本次锚点 |
| `loadInteractionContinuity` | 改：扫描事实、决定、提问时先按对话线过滤；`current.version !== basis.version` 的比较改成线尖版本号 |
| `continuityInputProofIn` | 改：只对当前线上算数的记录算 proof |

### src/modules/requirement/approval-manifest-store.ts
| 函数名 | 职责 |
|---|---|
| `ApprovalManifestStore.register` | 改：草稿阶段 admission.version 用线尖版本号；同事务挂锚点 |
| `registeredApprovalManifestIn` | 改：可带对话线；登记态核对用线上视图 |

### src/modules/requirement/host-authorization.ts
| 函数名 | 职责 |
|---|---|
| `interactionRecords` | 改：带对话线；提问、清单、priorDecisions 只收当前线上算数的 |

### src/modules/requirement/requirement-state.ts
| 函数名 | 职责 |
|---|---|
| `recordApprovedVersion` | 改：saved、approved 设成当前线那一版；同事务写 approval 锚点；同事务内的清单预检带对话线 |

### src/modules/requirement/requirement-service.ts
| 函数名 | 职责 |
|---|---|
| `loadConfirmationContext` | 改：basis、candidate 取线上视图 |
| `confirmUpdate` / `approve` | 改：带对话线；从 prd-storage 读回的是线尖那一版 |
| `verifyWorkingCopy` | 改：批准和 `loadConfirmationContext` 里的工作副本核对，改成核对线尖那一版的提交内容（工作副本始终是 main，即最近一次保存，可能来自别的线），保存流程里的核对保持"工作副本等于本次保存" |

### src/modules/interaction/user-interaction.ts
| 函数名 | 职责 |
|---|---|
| `UserInteractionCore.ask` | 改：生成 question 锚点并挂上；返回锚点编号给主窗口写进对话 |
| `UserInteractionCore.save` | 改：短决定、事实挂到 decision 锚点 |
| `#checkQuestions`、`#assertSavedRevisions`、`authorizeDocument` | 改：比较对象换成当前线上算数的记录 |

### src/modules/interaction/main-requirement-interaction.ts
| 函数名 | 职责 |
|---|---|
| `confirm`、`ask`、`askTech`、`adjudicate`、`#load`、`#ensureCore`、`#decisionProofs` | 改：带上 `currentLine`；成功后 `recordLineAnchor`；结果核对（`#snapshot`、`#prove` 的 onLine 参数）改按线视图，去掉计划 03 里这条链路用 requirements 行版本号的写法 |

## 协作关系
- 主窗口 → `currentLine` → `UserInteractionCore`（interpret / save / ask）→ `ShortDecisionStore`、`recordInteractionResolutionIn`、`ApprovalManifestStore` → 各自同事务调 `attachRecordIn`。
- 批准：`MainRequirementInteraction.confirm` → `RequirementService.confirmUpdate(…, line)` → `RequirementStateStore.recordApprovedVersion`（同事务预检清单、写 approval 锚点）。
- 守护进程里 PM、面板读这些命名空间的地方（pm-intake、task-dispatch、plan-manage、verdicts、panel）只在批准后读，不改；批准后的集合由 `countedAnchorsIn` 的批准规则保证不含废弃线上的记录。
- 依赖 01、02、03。

## 验证方式
- 测试入口：`ShortDecisionStore`、`loadInteractionContinuity`、`ApprovalManifestStore`、`UserInteractionCore`、`MainRequirementInteraction.confirm`（沿用现有测试的模型桩）。
- 测试输入：线 A 保存到版本 10，期间做 3 条短决定、提 1 个不回答的问题；线 B = 线 A 截到版本 5。
- 预期结果与验证项：
  - [ ] 线 B 上 `interactionRecords` 不含那 3 条决定和那个提问；线 A 上都有。
  - [ ] 线 B 上批准，批准清单里不引用那 3 条决定；批准后 requirements 行的 approved 是线 B 那一版的提交。
  - [ ] 线 A 上取代一条只在线 B 上存在的决定，被拒。
  - [ ] 没挂锚点的旧决定在线 A、线 B 上都算数。
  - [ ] 篡改一条算数的决定后批准，照旧报 `manifest_decisions_changed` 或 `continuity_source_changed`（依据链校验仍生效）。
  - [ ] 批准后在线 A 上读取，结果和批准时一致，线 A 上那 3 条决定不算数；批准后新做的决定在任意线上都算数。
  - [ ] 现有 `tests/approval-manifest-store.test.ts`、`tests/interaction-continuity.test.ts` 里的防篡改用例全部仍通过。
