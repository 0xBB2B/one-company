---
name: review-round-state
description: 任务的审查改成按轮流转：一次登记整轮，全轮结束才判定，打回按轮计、没交结论按代理计，返修后只重审该审的
---
# 整轮审查的状态流转

## 目标
一个 worker 任务的一轮审查可以同时有多个审查代理在跑；等这一轮全部结束才决定任务去向；下一轮该派谁由程序算出。

## 业务规则（来源：PRD multi-review C-3、C-4、C-7、C-8、C-9）
- 一轮审查：worker 交出一次改动（一次完成的尝试）后，PM 派一次审查时登记的那一批审查。第 1 轮之后，每次返修完再派审查算下一轮；同一次改动因为有代理没交结论而重派，仍算同一轮。
- 本轮成员：
  - 新一轮的第 1 轮：通用 reviewer + 任务 reviewers 里的全部专项审查。
  - 返修后的新一轮（新尝试带 rework）：通用 reviewer + 上一轮打回（blocked / unverified）、没交出结论（failed / turn_limit_reached / stopped）或被作废（superseded）的专项审查；上一轮通过或被跳过的这一轮不派。
  - 不是返修的重新执行（新尝试不带 rework，例如计划改了以后重做）后的新一轮：像第 1 轮一样派通用 reviewer + 任务 reviewers 全部。
  - 同一轮重派：只派这一轮里最近一次没交出结论或被 superseded 的代理。
- 派的时候已关闭的专项审查记为 skipped（skipReason `disabled`），文件被删的记为 skipped（`missing`）；skipped 不算打回、不算没交结论。专项审查全都没派时，本轮只有通用审查。
- 判定时机：一轮里每个代理的最近一条记录都已结束（不是 running）才判定，否则任务保持 reviewing。
- 判定结果：
  - 有任何打回 → 本任务累计"有打回的轮数"达到 2 时转 awaiting_user，否则 awaiting_rework。
  - 没有打回、但有代理没交出结论 → 同一轮里同一个代理没交出结论达到 2 次时转 awaiting_user，否则回到 awaiting_review。新一轮重新计数。用户裁决"再给一次机会"只多放一次：放行的那次审查再没交出结论，就再转 awaiting_user（不重新计数）。
  - 本轮成员全部被跳过（没有一条要派的）时，登记后立即按上面的规则判定，不能停在 reviewing。
  - 派审查的门槛与判定用同一套计数，awaiting_review 必须是能派出去的状态（不能出现门槛拒绝、而任务又停在 awaiting_review 的情况）。
  - 只有 superseded 的情况沿用现在的处理（回到 awaiting_review）。
  - 其余（都通过或被跳过）→ completed。
- 任务已不在 reviewing（被影响复核改成别的状态）时，只记结局、不改状态（沿用 task-dispatch.ts:253 的做法）。
- 用户裁决"再给一次机会"后重新计数的现有规则保留。
- 需求关闭前的检查：worker 任务算审查通过 = 最近一轮里每个代理的最近一条记录都是 clear 或 skipped，且通用 reviewer 有 clear，并且通用 reviewer 那条 clear 在结论表（VERDICTS）里有同 runId、epoch 一致的结论记录（保留原有的 epoch 核对：旧流程与旧记录不产生授权）。
- 被打回、没交结论这两组结局的集合只定义一处（plan-manage.ts 导出，task-dispatch.ts 引用）。

## 涉及文件
- 修改 `src/modules/pm/plan-manage.ts`（计数函数）
- 修改 `src/modules/pm/task-dispatch.ts`
- 修改 `src/modules/delivery/workflow-close.ts`（`taskReviewsIn`，:215-227）
- 修改 `tests/task-dispatch.test.ts`、`tests/workflow-close.test.ts`

## 函数清单
### src/modules/pm/plan-manage.ts
| 函数名 | 职责 |
|---|---|
| `reviewRejections`（改，:96） | 统计有打回的轮数（一轮里有多个打回只算一轮） |
| `reviewFailures`（改，:100） | 改为按审查代理统计没交出结论的次数 |
| `stalledStage`（改，:105） | 按最近一轮判断停在执行、审查未完成还是返修 |
| `latestRound` | 取任务最近一轮的轮次和这一轮每个代理的最近一条记录 |

### src/modules/pm/task-dispatch.ts
| 函数名 | 职责 |
|---|---|
| `reviewRoundMembers` | 按上面的成员规则算出这次派审查的轮次和代理名单（通用 reviewer 排第一） |
| `beginTaskReview`（改，:176） | 改为一次登记整轮：入参是本轮每个代理的结果（要派的带 runId，跳过的带 skipReason）；在一个事务里写入多条记录（running 或 skipped），任务转 reviewing；"只能审 worker、检查轮期间不能派、未交结论用尽"的门槛保留 |
| `finishTaskReview`（改，:242） | 记下一个代理的结局；本轮还有 running 时不改状态；全部结束时按上面的规则判定 |
| `beginTaskAttempt`（改，:140-147） | 返修门槛改用按轮计的 `reviewRejections` |
| `schedulingGateIn`（:97-98） | 保持"有运行中的尝试或审查时拒绝开始新的"；整轮在一个事务里登记，所以不需要放开 |

### src/modules/delivery/workflow-close.ts
| 函数名 | 职责 |
|---|---|
| `taskReviewsIn`（改） | 按"最近一轮全部 clear 或 skipped，且通用 reviewer 有 clear"判断 worker 任务是否审查通过 |

## 协作关系
"派出整轮审查"计划在 `dispatchTask` 里调用 `reviewRoundMembers` 得到名单、逐个解析后调用 `beginTaskReview` 登记，会话结束时经 `finishSubagent` 调 `finishTaskReview`。面板和裁决文案计划读 `latestRound`。

## 验证方式
- 测试入口：`tests/task-dispatch.test.ts` 的 `world()`（`task(key)`、`dispatch`、`review(key, maxTurns)`、`rework(key, reason, maxTurns)`）、`submit(summary, findings)`、`read(n)`；同时直接调用 `reviewRoundMembers`、`beginTaskReview`、`finishTaskReview` 检查任务记录
- 注意：多个审查同时运行时，`ControlledProvider.queue` 是所有会话共用的先进先出队列，必须用 `awaitReply(request)` 按 `request.systemPrompt` 里的定义正文区分是哪个审查在请求
- 预期结果：
  - 任务 reviewers 为 go-reviewer、vue-reviewer：第 1 轮成员为 reviewer、go-reviewer、vue-reviewer，记录 round 都是 1
  - 三个里两个 clear、一个还在跑 → 任务仍 reviewing；第三个 clear → completed
  - 两个 clear、go-reviewer blocked → awaiting_rework
  - 两个 clear、vue-reviewer 没交结论 → awaiting_review；`reviewRoundMembers` 返回只有 vue-reviewer，round 仍是 1
  - 返修后：上一轮 go-reviewer blocked、vue-reviewer clear → 成员是 reviewer、go-reviewer，round 2；上一轮 go-reviewer blocked、vue-reviewer 没交结论、react-reviewer clear → 成员是 reviewer、go-reviewer、vue-reviewer
  - 第 1 轮 go-reviewer 打回、第 2 轮 reviewer 打回 → awaiting_user；vue-reviewer 两次没交结论 → awaiting_user
  - 登记时某个代理带 skipReason `disabled` → 记录 outcome 为 skipped，不影响判定为 completed
  - 关闭需求检查：最近一轮全部 clear / skipped 时通过；有一个 blocked 时报「有任务还没经过审查」（沿用 task-dispatch.test.ts:224 的文案断言）
- [ ] 现有单审查用例（:189、:246、:283）按新语义改写后通过
