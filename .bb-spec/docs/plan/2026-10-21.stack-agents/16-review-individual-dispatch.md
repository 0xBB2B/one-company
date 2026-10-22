---
name: review-individual-dispatch
description: 审查各自重试：没交结论立刻告诉 PM、由 PM 单独重派；PM 可整轮派、单独派、临时加审查；整轮结束才合成结果
---
# 审查单独派、各自重试与临时加审查

## 目标
一轮里某个审查没交结论时不用等同轮其他审查，PM 立刻知道原因并单独重派；PM 可以按需单独派名单里任一个、或临时加名单外的专项审查；完成条件仍由程序把关。

## 业务规则（来源：PRD multi-review C-3、C-7、C-9，用户 2026-10-22 决定）
- 名词：审查名单＝任务里写的和自动挂上的专项审查，加上 PM 临时加的。一轮＝同一次完成的尝试收到的全部审查记录（整轮派、单独派、临时加都算同一轮）；返修完再派算下一轮。
- PM 派审查三种方式，每次自己给轮数上限：
  - 整轮派（不指定代理）：新一轮时按现有规则派通用 reviewer + 本轮该审的专项（第 1 轮全部；返修后打回、没交结论、被作废的；重新执行后全部）；本轮已开着时，重派本轮所有"没交结论、还能重派"的代理。
  - 单独派（指定名单里的一个或通用 reviewer）：只派这一个。它正在跑时被拒。
  - 临时加（指定名单外的定义，必须带理由）：定义不存在、职责不是 reviewer、是通用定义以外的已关闭定义、或理由为空时被拒，错误码 `agent_invalid` 并写明原因。通过后只派它，并把它和理由记进这个任务的审查名单，之后每一轮都和名单里的一样（返修后按打回规则、重新执行后全部重审都包括它）。PM 读计划时能看到它、理由和"PM 临时加"标记。
- 任务处在审查中（本轮还有代理在跑或在等重派）时也能单独派、临时加；不是 worker 任务、没有完成的尝试、检查轮期间仍然拒绝。
- 一个审查代理没交出结论（failed、turn_limit_reached、stopped）时，程序立刻给 PM 发一条只关于它的消息：代理名、原因（轮数用满 / 运行失败（附失败原因）/ 被停止）、本轮第几次、下一步建议。本轮第 1 次：建议"用 dispatch 单独派 <名字> 重试，可调整轮数上限"；本轮第 2 次：写"不再重派，等本轮其他审查结束后交用户裁决"。别的审查已经打回时照样建议重试。
- 同一轮里同一个代理没交出结论满 2 次后，单独派或整轮派都不再派它（被拒 `retry_exhausted`，原因写明）。
- 一轮结束：本轮名单里（含通用 reviewer）每个代理的最近记录都是 clear、blocked、unverified、skipped，或本轮已 2 次没交出结论（且没有用户新给的机会）。还有 running 或"没交结论但还能重派"的，任务保持 reviewing。
- 结束时判定：有打回 → 有打回的轮数达 2 时 awaiting_user，否则 awaiting_rework；没有打回但有代理本轮 2 次没交结论 → awaiting_user；其余 → completed。只有被作废的处理不变（回 awaiting_review）。
- 一轮结束后给 PM 发一条整轮汇总（现有 reviewRoundReport，内容不变）；没交出结论的单条消息不等整轮。
- 用户裁决"再给一次机会"（retry，轮数上限 N）：裁决时本轮已 2 次没交结论的那几个代理，各再派一次，派时轮数上限用 N（不管 PM 填多少）；这一次被作废后重派仍用 N；这一次又没交结论 → 本轮结束后再交用户裁决。
- 需求关闭检查（workflow-close `taskReviewsIn`）：名单（含临时加）里每个代理在最近一轮的最近记录是 clear 或 skipped，通用 reviewer 有 clear 且有同 runId、epoch 一致的结论记录。
- 模型输出不可信：代理名、理由只来自 PM 的工具参数并按 agentName 格式和目录校验；是否用尽、是否可派由程序按记录计算。

## 涉及文件
- 修改 `src/modules/pm/plan-manage.ts`（TaskReview 加可选 `addedReason`；名单计算；读计划时带出临时加的）
- 修改 `src/modules/pm/task-dispatch.ts`（`reviewRoundMembers`、`beginTaskReview`、`reviewSettledStatus`、`finishTaskReview`、`schedulingGateIn` 对审查中单派放行）
- 修改 `src/modules/panel/adjudication.ts`（retry 裁决记下本轮用尽的代理名单）
- 修改 `src/modules/delivery/workflow-close.ts`（`taskReviewsIn` 用名单）
- 修改 `src/app/daemon/run-manager.ts`、`src/app/daemon/pm-tools.ts`
- 修改 `role-rules/pm.md`
- 修改 `tests/task-dispatch.test.ts`、`tests/agent-selection.test.ts`、`tests/role-rules.test.ts`、`tests/adjudication.test.ts`

## 函数清单
### src/modules/pm/plan-manage.ts
| 函数名 | 职责 |
|---|---|
| `TaskReview`（改） | 加可选 `addedReason`：PM 临时加时写在这个代理本任务的第一条记录上 |
| `reviewRoster` | 新增：任务的审查名单＝`reviewers` 里的代理 ∪ 有 `addedReason` 记录的代理（不含通用 reviewer） |
| 读计划的输出（改） | 任务的审查名单里带出临时加的代理、理由和 `added: true` |
| `reviewFailures`（不改） | 本轮某代理没交结论次数 |

### src/modules/pm/task-dispatch.ts
| 函数名 | 职责 |
|---|---|
| `reviewRoundMembers`（改） | 新一轮名单规则不变但用 `reviewRoster`；本轮已开着时返回"没交结论、还能重派"的代理 |
| `reviewDispatchable` | 新增：某代理本轮能否再派（没在跑；没交结论次数 < 上限，上限 2，用户 retry 裁决覆盖的代理为 3） |
| `beginTaskReview`（改） | 允许任务在 awaiting_review 或 reviewing；members 由调用方给（整轮或单个）；逐个检查 `reviewDispatchable`；用户裁决覆盖的代理用裁决的 maxTurns；临时加的写 `addedReason` |
| `reviewSettledStatus`（改） | 按上面"一轮结束""结束时判定"规则；未结束返回 reviewing |
| `finishTaskReview`（改） | 返回值能让调用方知道这条结局是不是"没交出结论"以及本轮第几次 |
| `schedulingGateIn`（改） | 审查中单独派、临时加时不因"有运行中的审查"拒绝；同一代理正在跑时拒绝 |

### src/modules/panel/adjudication.ts
| 函数名 | 职责 |
|---|---|
| retry 裁决登记（改） | 审查卡住时记下裁决时本轮已用尽的代理名单（`userDecision.agents`）与轮次（`userDecision.round`），供 `reviewDispatchable` 用 |

### src/modules/delivery/workflow-close.ts
| `taskReviewsIn`（改） | 用 `reviewRoster` 判断最近一轮全部 clear / skipped |

### src/app/daemon/pm-tools.ts
| agent_manage dispatch 参数（改） | `review` 加可选 `agent`、`reason`；描述写明三种派法 |

### src/app/daemon/run-manager.ts
| 函数名 | 职责 |
|---|---|
| `dispatchTask`（改） | review 不带 agent 走整轮；带 agent：在名单或为 reviewer 走单派；否则校验后走临时加 |
| `finishSubagent`（改） | 审查没交出结论时立刻给 PM 发单条消息（`reviewUnfinishedNotice`）；整轮结束仍发 `reviewRoundReport` |
| `reviewUnfinishedNotice` | 新增：组装单条消息文字 |

### role-rules/pm.md
- 写明：审查没交结论时看原因单独重派（必要时调大轮数上限、补条件）；需要额外角度时可临时加专项审查并写理由；完成由程序判定。

## 协作关系
沿用 10、11 号已有的 `latestRound`、`REVIEW_REJECTED`、`REVIEW_UNFINISHED`、`REVIEW_OUTCOME_LABEL`、`reportReviewRound` 去重、`oneLine`。面板显示由 17 号完成。

## 验证方式
- 测试入口：`tests/task-dispatch.test.ts` 的 `reviewWorld`、`beginTaskReview` / `finishTaskReview` 直接调用；`tests/agent-selection.test.ts` 的 `reviewWorld`（`awaitReply` 按 systemPrompt 区分）+ `w.manager.dispatchTask({ ..., review: { maxTurns, agent?, reason? } })`
- 预期结果：
  - 整轮派 → 三个同时启动（原有用例照旧）；单独派 vue-reviewer（20）→ 只启动它、上限 20；它在跑时再单派 → 被拒
  - 临时加 node-reviewer 带理由 → 启动；读计划能看到它、理由、added；之后它也通过才完成；不带理由 / 已关闭 / 职责不是 reviewer / 不存在 → `agent_invalid`
  - go-reviewer turn_limit_reached、另两个还在跑 → PM 立刻收到一条只关于 go-reviewer 的消息（含「轮数用满」和单独重派建议），任务仍 reviewing；单派 go-reviewer 后它通过、另两个通过 → completed，整轮汇总只发一条
  - go-reviewer 第 2 次又没交结论 → PM 收到"不再重派"；再派它 → `retry_exhausted`；另两个通过后 → awaiting_user（事项「两次审查未完成（go-reviewer）」）
  - 另一个已 blocked 时，没交结论的仍可单派；它重试后 blocked → 返修意见含两条来源
  - 用户 retry（N=7）后单派 go-reviewer 带 30 → 上限 7；这次被作废后重派带 30 → 上限 7；又没交结论 → 本轮结束后 awaiting_user；两个代理同时用尽、都被放行时两个都用 7
  - 关闭检查：临时加的 node-reviewer 最近一轮 blocked → 报「有任务还没经过审查」
- [ ] 全量 `pnpm test`、`pnpm run typecheck` 通过
