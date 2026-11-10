---
name: 04-subagent-tool-results
description: 后台子代理的验证、写入、计划、流程、派工、提交、同步、联网搜索工具，发给模型的结果只留用得上的字段，完整结果放进 details
---
# 子代理工具结果精简

[依赖: lean-result-helper]

## 目标

PM、worker、reviewer、qa、explore 调 verification_run、change_apply、plan_manage、workflow_manage、agent_manage（PM 的那个）、git_commit、git_sync、web_search 成功时，发给模型的内容（pi 工具结果的 `content`）只有下文「保留」的字段，完整结果放进不发给模型的 `details`。

## 业务规则（来源：PRD 02-lean-tool-results）

先说两个词：`content` 是 pi 工具结果里发给模型、进上下文的部分；`details` 存进会话记录，界面和程序能用，不发给模型。「视图」指从完整结果里挑出发给模型的字段组成的对象。

1. 有视图的工具成功时，`details` 是完整结果（发给模型的字段和被去掉的字段都在）；`content` 仍是一段 JSON，字段名、取值、嵌套位置都和改前一样，只是少了字段。
2. 各工具发给模型的内容只留这些字段（两列都没写到的字段同样不发，例外见文末「与 PRD 不一致」）：
   - verification_run 的 run、stop、status：verificationId、checkRoundId、kind、status、exitCode、signal、reason、invalidation、output（stdout、stderr 各自的 text 和 truncated；运行中 output 是 null，照发）。去掉 baseline、performance、outputRoot、startedAt、finishedAt。
   - change_apply 的 prepare：status、files 每项的 path 和 baseHash。去掉 baseHead、files 的 targetHash。
   - change_apply 的 apply、import、status：operationId、status、files 每项的 path、status、reason（reason 只在有时出现）。去掉 baseHead、files 的 baseHash 和 targetHash。
   - plan_manage 全部动作：plan 的 planVersion 和 confirmedVersion；tasks 每项的 taskId、version、key、status、任务说明各项（role、goalUnitIds、constraintUnitIds、dependsOn、writePaths、blockedByQuestionIds、maxTurns、agent、agentReason、reviewers；read 时还有 detail 里的 objective、passCriteria、scope、performance）、attempts 每项的 runId、outcome、turnsUsed，reviews 每项的 runId、outcome、turnsUsed、agent，sizeHold、holdNote，userDecision 的 choice 和 maxTurns；结果顶层的 chances。去掉 closure、detail 的 path 和 hash、knownUnits、confirmedTasks、format、requirementId、updatedAt、attemptBase、cycleStarts、replanAllowance、lastAssessedRevision、userDecision 的其余字段。没有计划时 `{ plan: null }` 原样发。
   - workflow_manage（PM）的 advance、finish、check-decision：checkRoundId、status、invalidation、decision、verifications、active。去掉 baseline、requirementId。
   - workflow_manage（PM）的 delivery-check：deliverable、blockers、suggestions。去掉 receiptId、各种哈希、codeHead、epoch、verificationIds、verdictIds 等。
   - workflow_manage（PM）的 report：status，被拒时还有 missing、next。去掉 reportId。
   - agent_manage（PM）的 dispatch（派任务、派审查、派 explore 三种）：runId、runIds、failed。去掉 maxTurns。
   - agent_manage（PM）的 status：ok、run 里的 state、stateReason、stopCause、turns、log；查不到时的 `{ ok: false, reason }` 原样发。去掉 run 的其余字段（usage、pausedMs、pausedAt、startedAt、updatedAt、endedAt、parentRunId、requirement、kind、id）。
   - agent_manage（PM）的 catalog：items 每项的 name、description、source、role，nextCursor。去掉 total。
   - git_commit：commit。去掉 branch、paths。
   - git_sync：status、target，以及该状态下有的 previousHead、changed、conflicted。去掉 head。
   - web_search：provider、hits 每项的 url、title、snippet，failures。去掉 retrievedAt。
3. 表里没列的动作（workflow_manage 的 status、escalate；agent_manage 的 pause、resume、stop），`content` 与改前逐字相同，`details` 是完整结果。
4. 工具失败时发给模型的报错文字（"X 失败。原因：…建议：…"）不变：失败在取视图之前就抛出，走原来的 toolFailure。
5. result_submit 成功时发给模型的内容不变（不给视图）；web_fetch 不在表里，整份返回不变。
6. 不改窗口与守护进程的通信，不升协议版本号；不写兼容旧格式的分支。

## 改哪一层

现在把结果变成 `content` 的地方有两类：
- 统一包装 `toPiTool`（src/modules/agents/role-tools.ts:33-46，:44 整份 `JSON.stringify`）：verification_run、change_apply、plan_manage、workflow_manage、PM 读需求工具、result_submit、子代理 knowledge_query 都经它。lean-result-helper（01 计划）已经让 `toPiTool` 改用 `leanToolResult`，并给运行体接口 `CoreToolRuntime` 加了可选的 `view(完整结果)`。
- 各自手写：PM 的 agent_manage（src/app/daemon/pm-tools.ts:171）、git_commit（src/modules/pm/pm-commit.ts:81）、git_sync（src/modules/pm/pm-sync.ts:66）、web_search（src/app/daemon/run-manager.ts:1182 的 reply）。

做法：每个工具在自己的模块里导出一个纯函数取视图；组装处（subagent-tools.ts、pm-tools.ts）把传给 `toPiTool` 的运行体写成 `{ ...原运行体, view: 取视图函数 }`，原运行体照旧登记用于 dispose。手写的四处直接在原来那一行改用 `leanToolResult(完整结果, 视图)`。`toPiTool` 用 01 计划改好的样子，本计划不碰它。

01 计划的 `view` 同时收完整结果和这次的调用参数，所以各视图函数按调用参数里的 `action` 选字段：change_apply 的 prepare 与 apply、import、status 分开处理；workflow_manage 的 advance、finish、check-decision 为检查轮视图，delivery-check、report 各用自己的视图，其余动作原样返回。不按结果的形状猜动作。

## 涉及文件

- 修改 src/modules/pm/verification-run.ts
- 修改 src/modules/verification/change-apply.ts
- 修改 src/modules/pm/plan-manage.ts
- 修改 src/modules/delivery/workflow-manage.ts
- 修改 src/modules/pm/subagent-tools.ts
- 修改 src/app/daemon/pm-tools.ts
- 修改 src/modules/pm/pm-commit.ts
- 修改 src/modules/pm/pm-sync.ts
- 修改 src/app/daemon/run-manager.ts（只改 webTools 里 web_search 的返回）
- 新建 tests/subagent-tool-results.test.ts
- 修改 tests/pm-commit.test.ts
- 修改 tests/pm-sync.test.ts
- 修改 tests/pm-tools-failure.test.ts
- 修改 tests/explore-web.test.ts

## 函数清单

### src/modules/pm/verification-run.ts
| 函数名 | 职责 |
|---|---|
| `verificationRunView`（新增，导出） | 从 VerificationView 里挑出规则 2 列出的验证字段 |

### src/modules/verification/change-apply.ts
| 函数名 | 职责 |
|---|---|
| `changeApplyView`（新增，导出） | 按调用参数的 action 区分 prepare 和其余三个动作，挑出各自的保留字段 |

### src/modules/pm/plan-manage.ts
| 函数名 | 职责 |
|---|---|
| `planManageView`（新增，导出） | 挑出 plan、tasks、chances 的保留字段；detail 去掉 path、hash 后为空就整个不带 |

### src/modules/delivery/workflow-manage.ts
| 函数名 | 职责 |
|---|---|
| `pmWorkflowView`（新增，导出） | 按调用参数的 action 处理 PM 的检查轮三个动作、delivery-check、report；其余原样返回 |

### src/modules/pm/subagent-tools.ts
| 函数名 | 职责 |
|---|---|
| `createSubagentTools`（修改） | verification_run、change_apply、plan_manage 传给 toPiTool 的运行体带上对应的 view |

### src/app/daemon/pm-tools.ts
| 函数名 | 职责 |
|---|---|
| `createPmTools`（修改） | workflow_manage、verification_run、plan_manage 传给 toPiTool 的运行体带上对应的 view |
| `pmAgentManageView`（新增，文件内） | 按 action 处理 dispatch、status、catalog 的结果；其余动作原样返回 |
| `agentManageTool`（修改） | 返回改用 `leanToolResult`，视图取自 pmAgentManageView |

### src/modules/pm/pm-commit.ts、src/modules/pm/pm-sync.ts、src/app/daemon/run-manager.ts
| 函数名 | 职责 |
|---|---|
| `createPmCommitTool`（修改） | 成功返回改用 `leanToolResult`，视图只含 commit，完整结果含 commit、branch、paths |
| `createPmSyncTool`（修改） | 成功返回改用 `leanToolResult`，视图是同步结果去掉 head |
| `RunManager.webTools`（修改） | web_search 成功返回改用 `leanToolResult`，视图去掉 retrievedAt；web_fetch 的 reply 不动 |

## 协作关系

- 子代理调工具 → `toPiTool` 的 execute → 运行体 execute 返回完整结果（失败照旧抛 toolFailure，不取视图）→ 运行体的 view → `leanToolResult`（src/core/exec/tool-result.ts）→ `{ content: [视图 JSON], details: 完整结果 }`。
- 取视图函数都是纯函数，不读库、不读文件、不改完整结果；完整结果多是冻结对象，视图新建对象。各工厂返回的运行体都是闭包，不依赖 this，展开成新对象后照常工作。
- worker、reviewer、qa（createSubagentTools）和 PM（createPmTools）用同一个取视图函数，同一工具在不同角色下视图相同。
- 主代理的 workflow_manage 走 run-manager.ts:1561 的 workflowManage 直接调 execute，不经 toPiTool，本计划不碰。
- 分工：06-explore-pm 也改 pm-tools.ts 的 agent_manage（加 sources 动作，不动 :171 那一行）；`pmAgentManageView` 对不认识的动作原样返回，sources 的视图由那份计划决定。knowledge_query 的视图由 02-knowledge-query 处理。读需求工具的视图和分页由 07-subagent-requirement-read 处理，它也改 subagent-tools.ts、pm-tools.ts，排在本计划之后。
- 外部依赖：无新增依赖。

## 验证方式

- 测试入口：`pnpm test`（vitest）、`pnpm run typecheck`、`pnpm run test:integration`、`pnpm run test:installation`；真实模型验收 `ONE_COMPANY_ACCEPTANCE_OUTPUT=<绝对路径> pnpm run test:acceptance:parallel`。
- 公开入口：`toPiTool`（src/modules/agents/role-tools.ts）配合各工具工厂 `createVerificationRunTool`、`createChangeApplyTool`、`createPlanManageTool`、`createWorkflowManageTool` 和各自导出的取视图函数（运行体写成 `{ ...工厂运行体, view }`）；`createSubagentTools`、`createPmTools`；`agentManageTool`（src/app/daemon/pm-tools.ts，agents 用假实现返回完整结果）；`createPmCommitTool`、`createPmSyncTool`；`createPmRunWorld`（tests/helpers/run-manager-fixture.ts，驱动 explore 调 web_search 后读 `w.provider.requests` 里的 toolResult）。tests/verification-run.test.ts、change-apply.test.ts、plan-manage.test.ts、workflow-close.test.ts 的搭建方式可复用来拿真实完整结果。
- 测试输入：每个工具每个动作各一次成功调用；一次失败调用（如 PM 会话失效时 agent_manage dispatch）；一次 result_submit 成功调用。
- 预期结果：content 是视图 JSON，details 是完整结果；视图里每个字段的值等于 details 同位置的值（details 就是改前整份发给模型的内容）。

- [ ] verification_run 的 run、stop、status：content 含 verificationId、checkRoundId、kind、status、exitCode、signal、reason、invalidation、output.stdout/stderr 的 text 和 truncated；不含 baseline、performance、outputRoot、startedAt、finishedAt；details 都含。
- [ ] change_apply 的 prepare：content 的 files 每项只有 path、baseHash，顶层没有 baseHead；apply、import、status：content 有 operationId、status，files 每项只有 path、status（有 reason 时带 reason），没有 baseHead、baseHash、targetHash；details 都含。
- [ ] plan_manage 的 propose、update、confirm、read、assess-update：content 的 plan 只有 planVersion、confirmedVersion；tasks 每项没有 closure、format、requirementId、updatedAt、attemptBase、cycleStarts、replanAllowance、lastAssessedRevision、detail.path、detail.hash；有 taskId、version、key、status、writePaths、dependsOn、attempts 的 runId/outcome/turnsUsed、reviews 的 runId/outcome/turnsUsed/agent；read 时 detail 有 objective、passCriteria、scope、performance；update 改了已执行过的任务时顶层有 chances；没有计划时 content 是 `{"plan":null}`。
- [ ] workflow_manage（PM）的 advance、finish、check-decision：content 没有 baseline、requirementId，其余检查轮字段都在；delivery-check：content 只有 deliverable、blockers、suggestions；report 成功：content 有 status，没有 reportId；report 被拒、status、escalate：content 与 `JSON.stringify(完整结果)` 逐字相同。
- [ ] agent_manage（PM）：dispatch 三种结果的 content 没有 maxTurns，runId 或 runIds、failed 照有；status 的 content 只有 ok 和 run 的 state、stateReason、stopCause、turns、log，`{ ok: false, reason }` 原样；catalog 的 content 有 items（name、description、source、role）和 nextCursor，没有 total；pause、stop 的 content 与完整结果 JSON 逐字相同；details 都是完整结果。
- [ ] git_commit：content 只有 commit，details 有 commit、branch、paths；git_sync 的 up_to_date、rebased、reapplied、conflicts：content 没有 head，其余字段照有，details 有 head。
- [ ] web_search：explore 会话里 provider 收到的 web_search toolResult 文本不含 retrievedAt，含 provider、hits 的 url/title/snippet、failures；web_fetch 的 toolResult 文本仍含 retrievedAt。
- [ ] 失败时报错文字与改前逐字相同（tests/pm-tools-failure.test.ts、tests/tool-failure.test.ts、tests/pm-sync.test.ts 现有失败断言不改仍通过）。
- [ ] result_submit 成功时 content 与改前逐字相同。
- [ ] 现有断言 content 的位置核对通过：tests/pm-sync.test.ts:133、190、192（status、target 仍在 content），tests/pm-commit.test.ts:45-46（commit 仍在），tests/pm-intake-runtime.test.ts:47（接手理解提交不在本计划范围，不变），tests/integration/agent-gates.test.ts:113-123（catalog 的名字仍在 content）。
- [ ] 纯代码测试四项全部通过；真实模型验收全部单点测试（P1–P22）、零自定义完整流程（M9-AC12）、渐进需求完整流程（M9-AC2/AC3/AC11）按 2 次、必要时第 3 次的规则通过。

## 与 PRD 不一致

1. agent_manage（PM）status：PRD 只列 run 的字段；代码返回 `{ ok: true, run }` 或 `{ ok: false, reason }`（src/app/daemon/run-manager.ts:1368-1372）。本计划保留 ok，查不到时整份原样发。
2. plan_manage「detail（TaskSpec 各项）」：代码里 TaskSpec 的多数项（role、goalUnitIds、dependsOn、writePaths、maxTurns、agent 等）在任务顶层（src/modules/pm/plan-manage.ts:176-201）；detail 在 propose、update、confirm 里只有 path、hash，在 read 里是 hash 加 objective、passCriteria、scope、performance（:700）。本计划把顶层这些项原位保留，detail 只去掉 path、hash。
3. plan_manage「userDecision 的内部字段」：PRD 没写哪些算内部。本计划保留 choice、maxTurns，其余（decisionId、revision、taskVersion、usedByRunId、notified、agents、round、baseline、escalation、confirmedPlan、split、techApproval，:159-174）不发。
4. plan_manage 的 plan：PRD 只列 planVersion；代码还有 confirmedVersion、taskIds、prdRevision、confirmedRevision（:217-221）两列都没写。本计划多保留 confirmedVersion（计划是否已冻结，属于状态），其余不发。
5. plan_manage 的 attempts：PRD 写「attempts 和 reviews 的 runId / outcome / turnsUsed / agent」，attempts 没有 agent 字段（:78-83），只有 reviews 有（:86-90）；attempts 的 maxTurns、reason、rework、escalation，reviews 的 attemptRunId、maxTurns、round、skipReason 两列都没写，本计划不发。
6. workflow_manage 的 report：PRD 保留 next；代码成功时返回 `{ status: "submitted", reportId }`，只有被拒时才有 missing 和由 explained 补上的 next（src/modules/delivery/workflow-close.ts:430、src/modules/delivery/workflow-manage.ts:63-65）。成功时视图只有 status。
7. git_sync：up_to_date 和 rebased 本来就没有 changed、conflicted，up_to_date 也没有 previousHead（src/modules/pm/pm-sync.ts:19-22）；视图只去掉 head，不补字段。
8. 约束 5「result_submit 成功时的返回不变」：01 计划让 `toPiTool` 一律改用 `leanToolResult`，result_submit 的 details 会从 `{}` 变成完整结果，content 不变。本计划按 content 不变验证。
