---
name: counting-cycle
description: 任务记录加计数周期和重算额度；修改任务时按规则开新周期；派工、结局、打回次数按当前周期算；update 结果告诉 PM 次数怎么算
---
# 计数周期与重算额度（pm 模块）

## 目标
改了计划的任务按规则开始新的计数周期，执行次数和打回次数只算当前周期；PM 自己改计划换来的新周期在用户两次决定之间只有 1 次；用户选拆分或精简、或调整并批准新版本后的修改开新周期且不用额度。

## 业务规则（来源：PRD replan-chances、resize-chances）
- 计数周期：任务创建时开始第 1 个周期；之后每开一个新周期，之前的执行和打回都不再计入。每个周期计入次数的执行最多 2 次：第 1 次首次执行，不带重试原因；第 2 次是重试，必须带原因；第 2 次仍没做完任务转待用户裁决（awaiting_user）。作废的尝试（outcome=superseded）和返修（rework）不计入执行次数。
- 每个周期里只算本周期内执行的改动被打回的轮次：第 1 次被打回转待返修（awaiting_rework），第 2 次被打回转待用户裁决。
- PM 用 plan_manage update 修改任务时：
  - 当前周期已有计入次数的执行，并且重算额度为 1 → 开新周期，额度变 0。
  - 当前周期还没有计入次数的执行 → 不开新周期、不用额度（连改几次都一样）。
  - 额度为 0 → 修改照常接受，但不开新周期，次数接着累计。
  - 用户的「调整目标或范围」决定还没用、且已有新批准版本（现有 `readjusted` 条件）时修改该任务，或用户选了「让 PM 拆分或精简」（现有 `resized` 中拆分上限那一支）时修改该任务 → 开新周期，不用额度。
  - 用户给的「再给一次机会」还没用、PM 只改说明文字（现有 `textOnlyChange`）→ 不开新周期、不用额度，用户的机会照旧带到新版本。
- 新任务（包括用户选拆分后 PM 另加的任务）从第 1 个周期开始，额度为 1。
- 用户每对任务做一次决定，额度恢复为 1（由 panel 模块的裁决登记写入，见 02 号 plan；本 plan 只提供字段）。
- 两次用户决定之间，同一任务计入次数的执行最多 4 次（由以上规则推出）。
- 占住目标（`tried`）仍按任务全部历史判断：有过计入次数执行、没完成的任务照旧占住目标，不因开新周期而放开。PRD 复核判为受影响（needs_update）的任务，只有以下任一成立才放开（不占住目标）：用户的调整决定还没用过且已有新批准版本（`readjusted`）；拆分上限有效且用户的调整决定还没用过。其余受影响任务一律占住目标，不比较章节变化。
- 「用户授权的修改」只在用户真的做了决定时成立：调整决定还没用过且已有新批准版本（`readjusted`），或拆分上限还有效且用户的调整决定还没用过（`task.sizeHold !== undefined && sizeHoldPending(task) && userDecision.choice === "adjust" && usedByRunId === null`）。任务身上残留的拆分上限标记本身不算。
- update 的结果对每个被修改、且已有计入次数执行的任务写一句给 PM：开了新周期写「<key> 开始新的计数周期：重新计 2 次执行机会和 1 次返修机会」；额度为 0 写「<key> 的重算额度已用完，次数接着累计：本周期已执行 N 次、打回 M 轮」。修改没执行过的任务、或不开新周期但当前周期没执行过的，不写。
- 数据格式变化：任务记录新增两个必填字段，按项目规矩把 data 库的结构版本号加 1（旧库打开时报不支持的版本），不写迁移代码。

## 涉及文件
- 修改 `src/core/storage/database-paths.ts`（`DATABASE_SCHEMA_VERSIONS.data` 5 → 6）
- 修改 `src/modules/pm/plan-manage.ts`
- 修改 `src/modules/pm/task-dispatch.ts`
- 修改 `role-rules/pm.md`（第 14 行附近，补一句计数周期规矩）

## 成品定义
`TaskRecord` 新增字段（写在 `attemptBase` 之后）：

```ts
  /** 每个新计数周期开始时已有的尝试数，按时间顺序；最后一个是当前周期的起点，空数组表示还在第 1 个周期。 */
  cycleStarts: Type.Array(Type.Integer({ minimum: 1 }), { maxItems: 64 }),
  /** PM 自己改计划还能开几次新周期：用户两次决定之间只有 1 次，用户做决定时恢复为 1。 */
  replanAllowance: Type.Union([Type.Literal(0), Type.Literal(1)]),
```

`role-rules/pm.md` 第 14 行末尾追加一句：

```
计划改了的任务会重新计次数：修改已执行过的任务时，plan_manage update 的结果写明这个任务是开始了新的计数周期（重新有 2 次执行机会、1 次返修机会，第 1 次派出不带 retry），还是重算额度已用完、次数接着累计；按结果决定派出时带不带 retry。
```

## 函数清单
### src/modules/pm/plan-manage.ts
| 函数名 | 职责 |
|---|---|
| `cycleAttempts`（新增，导出） | 返回任务当前计数周期里的尝试（`cycleStarts` 最后一项之后的尝试，没有就是全部） |
| `cycleCountedAttempts`（新增，导出） | 当前周期里计入次数的执行数（复用 `countedAttempts` 的计数口径） |
| `reviewRejections`（修改） | 只数审的是当前周期尝试（review.attemptRunId 属于当前周期尝试的 runId）的打回轮数 |
| `sizeHoldPending`（修改） | 「执行机会没用完」改用当前周期计数 |
| `materialize`（修改） | 新任务写 `cycleStarts: []`、`replanAllowance: 1`；修改已有任务时按上面的规则决定是否开新周期（追加 `prior.attempts.length` 到 `cycleStarts`）和额度变化；`exhausted` 改用当前周期计数；返回每个被修改任务的次数说明供 update 使用 |
| `update`（修改） | 把 `readjusted`、`resized`、用户再一次机会没用且只改说明文字这三种情况传给 `materialize`；结果在原有 `{ plan, tasks }` 之外带上 `chances: string[]`（上面的两种句子） |

### src/modules/pm/task-dispatch.ts
| 函数名 | 职责 |
|---|---|
| `beginTaskAttempt`（修改） | `counted` 改用当前周期计数；当前周期 0 次时带 retry 拒（retry_not_needed），1 次时不带拒（retry_required），2 次且没有可用用户决定时拒（retry_exhausted）；返修判断用按周期的 `reviewRejections` |
| `finishTaskAttempt`（修改） | 没做完时按当前周期计数判断转 awaiting_user 还是 awaiting_parent |
| `reviewSettledStatus`（不改代码） | 用按周期的 `reviewRejections` 后自然按周期判断 |

## 协作关系
`update` → `materialize`（算新周期与额度）→ `commit` 写库；`beginTaskAttempt` / `finishTaskAttempt` / `reviewSettledStatus` 调 `cycleCountedAttempts`、`reviewRejections`。`tried`、`unsentTask` 保持按全部历史计算，不改。panel 模块（02 号 plan）会改用 `cycleCountedAttempts`、`cycleAttempts`。

## 验证方式
- 测试入口：`tests/adjudication.test.ts`、`tests/task-dispatch.test.ts`、`tests/plan-manage.test.ts` 已有的场景搭建（`world()`、`pendingWorld()`、`w.plan.execute({ action: "update", ... })`、`w.manager.dispatchTask(...)`、`userAdjudicates(...)`、`w.task(key)`）。
- 预期结果：
  - [ ] 任务第 1 次做完被打回 → PM update 改通过条件 → 结果 `chances` 含「login 开始新的计数周期：重新计 2 次执行机会和 1 次返修机会」→ 不带 retry 派出被接受，带 retry 被拒 `retry_not_needed` → 做完再被打回 → 状态 awaiting_rework → 带 rework 派出被接受。
  - [ ] 新周期还没派出时 PM 再 update 两次 → `chances` 为空、额度仍是 0（第一次修改已用掉）、派出不带 retry 被接受。
  - [ ] 用掉额度的周期里执行 1 次没做完 → PM 再 update → 被接受，`chances` 含「pay 的重算额度已用完，次数接着累计：本周期已执行 1 次、打回 0 轮」→ 不带 retry 派出被拒 `retry_required` → 带 retry 派出后没做完 → awaiting_user。
  - [ ] 同一周期里第 2 次打回 → awaiting_user；第 2 次执行没做完 → awaiting_user。
  - [ ] 用户对超限任务选「让 PM 拆分或精简」后，PM 修改本任务改回 80 轮 → 开新周期、额度不变；PM 取消原任务另加两个同目标新任务 → 被接受，新任务不带 retry 派出被接受。
  - [ ] 用户选调整、批准新 PRD 版本、复核后 PM 修改该任务 → 开新周期且额度不变。
  - [ ] 用户给了再一次机会还没用，PM 只改通过条件文字 → 不开新周期，派出按用户给的轮数上限、不需要 retry。
  - [ ] 有尝试、没有用户拆分或调整决定的任务，PM 取消另加同目标任务 → `goal_held`（占住目标不因新周期放开）。
  - [ ] 不经用户决定，同一任务计入次数的执行最多 4 次：第 5 次派出被拒，任务停在 awaiting_user。
  - [ ] data 库结构版本号为 6；`tests/` 里断言版本号或任务记录字段的测试同步更新。
- 已有测试里断言「改计划后次数跨版本累计」的用例，在 PM 还有额度的场景下按新规则改期望；额度用掉的场景保持原期望。
