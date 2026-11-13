---
name: 02-lean-tool-results
description: 主代理和子代理的工具结果只把模型用得上的字段发给模型，其余留在 details；分页上限按发给模型的内容算
date: 2026-11-10
---

# 工具结果只发模型用得上的字段

pi 的工具结果分两部分：`content` 发给模型，进上下文；`details` 存进会话记录，界面和程序能用，不发给模型。下文"发给模型"都指 `content`，"留存"都指 `details`。

## 用户故事

### P0：作为主代理，我想要工具结果只带我下一步用得上的字段，以便上下文不被哈希和内部编号占掉

**用例（主路径）**
- 场景：主代理修改需求草稿。
- 操作：调 one_company_requirement_manage updateDraft。
- 预期：发给模型的结果只有需求编号、版本、操作编号、修订号、状态；没有 commit、prdHash、archivePath、lifecycle、epoch、approvalScope、action。这些字段都在留存部分里。

**用例（主路径）**
- 场景：主代理初始化项目索引，有 11 个文件被跳过、几十条文件诊断。
- 操作：调 one_company_project_manage init。
- 预期：发给模型的结果写状态、文件数、跳过几个、诊断几条、截断说明；不逐个列出跳过的文件和诊断。逐项清单在留存部分里。

### P0：作为子代理，我想要工具结果同样只带用得上的字段，以便长任务里上下文留给代码和测试输出

**用例（主路径）**
- 场景：worker 跑一次验证命令。
- 操作：调 one_company_verification_run run。
- 预期：发给模型的结果有验证编号、检查轮编号、类型、状态、退出码、信号、原因、失效说明、标准输出和标准错误的末尾及是否截断；没有 baseline、outputRoot、开始和结束时间。

**用例（主路径）**
- 场景：explore 查一个符号，什么也没查到。
- 操作：调 one_company_knowledge_query search。
- 预期：发给模型的结果没有 format、schemaVersion、asOf、baselineHash、workspace，也没有为 0 或为空的 limitations 计数；有 trust、generation、indexStatus、coverage.complete、facts、nextCursor。

### P0：作为模型，我想要分页时每页按我实际收到的内容算大小，以便每页能放更多正文

**用例（主路径）**
- 场景：一份 60 KB 的需求正文，主代理分页读。
- 操作：read，再按 nextCursor 用 next 读下一页。
- 预期：每页发给模型的内容不超过原有上限；同一份正文，每页能放下的正文不少于改前。

## 约束

1. 主代理和子代理的 one_company 工具成功时，留存部分是完整结果，包含发给模型的所有字段和下表移除的字段。
2. 发给模型的内容仍是 JSON，保留字段的名字和取值与改前相同；只有 project_manage init、refresh 新加 skippedCount、diagnosticCount 两个数量字段。
3. 下表"移除"列的字段不在发给模型的内容里，在留存部分里；"保留"列的字段在发给模型的内容里。表里没列的动作，发给模型的内容不变。

**主代理的工具**

| 工具 · 动作 | 保留 | 移除 |
|---|---|---|
| requirement_manage · create、updateDraft | requirementId、version、operationId、revision、status | action、commit、prdHash、archivePath、lifecycle、epoch、anchor、approvalScope |
| requirement_manage · read、diff、next | requirementId、title（read 才有）、version、text、diff 的 fromRevision / toRevision、restoreFailure（read 才有，出现时）、coverage.nextCursor、coverage.blocking（非空时） | source、commit、prdHash、epoch、coverage 的 startByte / endByte / totalBytes / complete、diff 的 from / to 提交号和哈希、historicalEndpoints、approvalScope |
| requirement_manage · metadata | requirementId、version、revision、savedOperationId、lifecycle、recovery、restoreFailure（出现时）、approvalScope.summary 的 pending 和 blocked | saved、approved、archivePath、epoch、approvalScope 的 reference / confirmed / excluded / status |
| requirement_manage · confirmUpdate；user_interact · reply | requirementId、version、prdActivated、blockedBy、blockedReason、implementAuthorization、next | status、action、operationId、savedOperationId、epoch、targetRecorded、decisionIds、scopeStatus、approvalScope、commit、prdHash、archivePath、lifecycle、revision |
| user_interact · ask、ask-tech | requirementId、version、status、answer | requestId、caption、question、scope、unitIds、actions、authorized、epoch |
| user_interact · panel-item 的 ask、ask-tech | decision.itemId、decision.itemVersion、status、answer、next | requirementId、顶层的 itemId、caption、question、version、epoch |
| user_interact · adjudicate 的 reply | decisionId、status、choice、next、notRecordedNext、notRecorded | requirementId、maxTurns、taskStatus、itemId、version、epoch |
| user_interact · pm-intake 的 ask、forward | requestId、understanding、understandingStatus、uncoveredScenarioIds、decisions | binding、submissionRef、submissionHash、sourceDirectory、sourceDirectoryHash、createdAt、operationId、userAuthorizationCreated |
| agent_manage · dispatch | runId | maxTurns、fence |
| agent_manage · status | run.state、run.stateReason、run.turns、run.log | run 的其余字段（usage、pausedMs、pausedAt、startedAt、updatedAt、endedAt、parentRunId、requirement、kind、id）、delivery |
| prototype · designers | items 的 name、description | items 的 source |
| prototype · status | entries 的 name、lastVersion、removed；draft / approved / inFlight 的 version、status、note、options、picked；lastOpinion；lastEnded.reason | requirementId、updatedAt、各版本的 hash、bytes、runId、agent、file 外层 |
| workflow_manage · close | status、next、message、missing、pending、archive 的 status / reason / next | operationId、reason、archive 的 path |
| workflow_manage · delivery-check | deliverable、blockers | receiptId、各种哈希、codeHead、epoch、verificationIds、verdictIds |
| git_deliver | status、url、reason、next、target、merge 的 state / reason / next | head、provider、reused、rebasedAfterAcceptance、method、merge 的 method |
| project_manage · workspace-prepare、recycle | status、version、branch、path | baseCommit、operationId |
| project_manage · init、refresh | status、partial、files（数量）、skippedCount（skipped 清单的条数）、diagnosticCount（diagnostics 清单的条数）、truncation | skipped 清单、diagnostics 清单、budget、archives、generation、parsedFiles、symbols 等其余字段 |

**子代理的工具**

| 工具 · 动作 | 保留 | 移除 |
|---|---|---|
| requirement_manage · read、diff（pm、reviewer、qa） | text、title、coverage.nextCursor、coverage.blocking、coverage.selectedTextComplete、coverage.entirePrdCovered、structure.sections 的 id、source.revision、source.approvalScope.summary.confirmed | coverage 的字节位置和 representation / businessCompleteness / verification / performance、sections 的字节位置和 hash 及分页计数、source 的其余字段、approvalScope.summary 的 pending / excluded / blocked / reference、diff 的提交号和哈希 |
| verification_run · run、stop、status | verificationId、checkRoundId、kind、status、exitCode、signal、reason、invalidation、output 的 stdout / stderr 文字和 truncated | baseline、performance、outputRoot、startedAt、finishedAt |
| change_apply · prepare | status、files 的 path 和 baseHash | baseHead、files 的 targetHash |
| change_apply · apply、import、status | operationId、status、files 的 path、status、reason | baseHead、files 的 baseHash 和 targetHash |
| plan_manage · 全部动作 | plan.planVersion；tasks 的 taskId、version、key、status、detail（TaskSpec 各项）、attempts 和 reviews 的 runId / outcome / turnsUsed / agent；chances、sizeHold、holdNote | closure、detail.path、detail.hash、knownUnits、confirmedTasks、format、requirementId、updatedAt、attemptBase、cycleStarts、replanAllowance、lastAssessedRevision、userDecision 的内部字段 |
| workflow_manage · advance、finish、check-decision | checkRoundId、status、invalidation、decision、verifications、active | baseline、requirementId |
| workflow_manage · delivery-check | deliverable、blockers、suggestions | receiptId、各种哈希、codeHead、epoch、verificationIds、verdictIds |
| workflow_manage · report | status、missing、next | reportId |
| agent_manage（pm）· dispatch | runId、runIds、failed | maxTurns |
| agent_manage（pm）· status | run.state、run.stateReason、run.stopCause、run.turns、run.log | run 的其余字段 |
| agent_manage（pm）· catalog | items 的 name、description、source、role，nextCursor | total |
| git_commit | commit | branch、paths |
| git_sync | status、changed、conflicted、previousHead、target | head |

**知识查询（主代理和子代理相同）**

| 部位 | 保留 | 移除 |
|---|---|---|
| 顶层 | trust、generation、indexStatus、nextCursor | format、schemaVersion、asOf、baselineHash、workspace |
| limitations | unknownCodeRelations、formalVerification、performanceImprovement；其余计数和清单只在不为 0、不为空时保留 | scope；为 0 或为空的 diagnosticCounts、diagnostics、diagnosticDetailsOmitted、unindexedFiles |
| coverage | complete；remaining、omitted、sourceExcerptsTruncated 只在不为 0 时保留 | matched、returned；为 0 的 remaining、omitted、sourceExcerptsTruncated |
| facts 每一项 | id、kind、complete、source 的 path / startLine / endLine、data 里的正文和名字、路径、行号、符号编号、关系的确定程度 | source 的 fileHash、parserVersion、rangeKind；符号的列号和偏移；文件的 hash、parserVersion；关系的列号和 evidence |

4. 工具失败时，发给模型的报错文字不变（"X 失败。原因：…建议：…"）。
5. 子代理交结果工具 result_submit 成功时，发给模型的内容不变。
6. 分页和大小上限（需求正文每页、需求工具和接手复核的单次结果、知识查询每页和单次结果）的数值不变，计算时只算发给模型的内容。同一份需求正文、同一个知识查询，改后每页发给模型的正文（需求正文的 text、知识查询的 facts 条数）不少于改前。
7. 程序对工具结果的核对（主代理需求工具和接手复核在结果送达前的核对）照常生效：留存部分或程序内存里的完整结果被改动时，仍然拒绝送达。

## 验收

- [ ] 1、3：对上面三张表里每个工具的每个动作，各跑一次成功调用：发给模型的内容包含"保留"列的全部字段（条件保留的按条件判断），不包含"移除"列的任何字段；留存部分包含两列的全部字段。
- [ ] 2：同上，保留字段的名字和取值与改前对同一调用的结果相同。
- [ ] 1：表里没列的动作（如 requirement_manage list、prototype dispatch、project_manage backup），发给模型的内容与改前相同。
- [ ] 4：任一工具失败时，发给模型的报错文字与改前逐字相同。
- [ ] 5：result_submit 成功时发给模型的内容与改前相同。
- [ ] 6：用一份 60 KB 的需求正文分页读，每页发给模型的内容不超过原上限，且每页正文字节数不少于改前；知识查询每页 facts 条数不少于改前，单次结果不超过原上限。
- [ ] 7：在主代理需求工具和接手复核的结果送达前改动完整结果，送达被拒绝，与改前行为相同。
- [ ] 真实模型验收：全部单点测试（P1–P24）、零自定义完整流程（M9-AC12）、渐进需求完整流程（M9-AC2/AC3/AC11）通过。

## 验证路径

1. 逐个工具、逐个动作调用一次 → 比对发给模型的内容和留存部分，按表核对保留和移除。
2. 同一组调用在改前、改后各跑一次 → 保留字段的取值一致。
3. 用 60 KB 需求正文和一个返回很多 facts 的知识查询分页 → 每页不超上限、正文不少于改前。
4. 跑全部真实模型验收 → 主代理和 PM 用精简后的结果照常走完需求流程。
