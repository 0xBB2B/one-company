---
name: split-escalation
description: PM 可为待更新且占住目标的已执行任务上报请求拆分；用户选拆分后放开目标、选不拆后同版本不能再报
---
# 请求拆分的上报与占住目标判断

## 目标
PM 能对「待更新、占住目标、没有运行中尝试」的任务上报（请求拆分）；用户选「拆分」后任务不再占住目标且不需要新批准版本；用户选「不拆」后任务照旧占住目标、同一批准版本内不能再上报。

## 业务规则（来源：PRD split-request）
- 名词：待更新 = 任务 status `needs_update`（用户批准新版本后 PM 复核判为受影响）；占住目标 = 已执行过（计入次数的尝试 > 0）、没完成的任务，PM 不能取消它，同角色其他任务不能拿走它的目标章节，修改时目标不能减少；上报 = PM 调 escalate，任务进 `awaiting_user`。
- C-1：待更新、占住目标、没有 outcome 为 running 的尝试 → 上报被接受，任务进 `awaiting_user`，PM 的说明记在最近一次尝试上（与现有上报一致），并在任务上记下「这是在批准版本 r<当前批准版本号> 下的请求拆分」。
- C-2：待更新但不占住目标（复核前已做完并通过审查，或用户已对它选过拆分）→ 上报被拒，原因写明「不占住目标，直接改计划即可」。
- C-3：待更新且有 running 尝试 → 上报被拒，原因写明等运行结束后再上报。
- C-4：用户对它选过「不拆」后、当前批准版本号没变时，再上报 → 被拒，原因写明用户已选不拆；批准下一个新版本后再上报 → 被接受。
- C-8：用户对请求拆分选「拆分」（内部 choice `adjust`）→ 任务回到待更新且不占住目标，不需要新的批准版本：PM 可取消它、把目标交给新增或其他任务、修改它并减少目标；修改它时按用户授权处理（开始新计数周期、不用掉重算额度）。现有规则「用户选调整后须等新的批准版本才能修改」对请求拆分的任务不适用。
- C-9：用户选「不拆」（内部新 choice `keep`）→ 任务回到待更新，照旧占住目标：取消、另加同目标任务、修改时减少目标都被拒（goal_held）；修改它本身被接受，按现有计数周期与重算额度规则计次数（不算用户授权的修改）。
- `keep` 决定不能当作派出授权：派出、机会是否用完的判断里它和没有决定一样。
- 数据格式变了：任务记录新增字段、用户决定新增 choice → data 库版本号 6 → 7，旧版本号加进「过期版本」列表，不写迁移（AGENTS.md：不做向后兼容）。
- 威胁模型：PM 是不可信模型；放开目标只能来自用户亲手做的决定，上报本身不放开任何东西。

## 涉及文件
- src/modules/pm/plan-manage.ts（修改）
- src/modules/pm/task-dispatch.ts（修改）
- src/core/storage/database-paths.ts（修改）
- src/core/storage/database.ts（修改）

## 函数清单
### src/modules/pm/plan-manage.ts
| 函数名 | 职责 |
|---|---|
| `TaskRecord`（schema） | 新增可选字段 `splitRequest`：记录请求拆分时的批准版本号（正整数）；PM 修改任务生成新版本时不带过去（materialize 不复制它） |
| `UserDecision`（schema） | choice 增加 `keep` |
| `goalHeld`（新增并导出） | 判断一个任务按当前批准版本号是否占住目标；把 `update` 里 `tried` 过滤用的条件（已执行、未完成、待更新时的 finishedBeforeReview / readjusted / resized 例外、已取消时的终止例外）挪成这个函数，`update` 改为调用它 |
| `readjusted`（`update` 内，随 `goalHeld` 挪出） | 用户选 adjust 后放开目标：原条件（批准版本号大于决定时的版本号）之外，再认「决定时任务带 `splitRequest` 且决定的批准版本号等于 splitRequest 的版本号」 |
| `update` | `userAuthorized` 同样认上面这种请求拆分后选 adjust 的任务；`waiting`（等待调整后的新批准版本）不拦这种任务 |

### src/modules/pm/task-dispatch.ts
| 函数名 | 职责 |
|---|---|
| `escalateTask` | 新增放行 `needs_update`：读需求当前批准版本号，按 `goalHeld` 判断；不占住目标拒 C-2、有 running 尝试拒 C-3、用户已选 keep 且决定版本号等于当前版本号拒 C-4（都用 `task_not_ready` 加中文原因）；通过时写 escalation 到最近一次尝试、写 `splitRequest`、状态 `awaiting_user` |
| `beginTaskAttempt` 内的 grantedDecision 判断 | 确认 `keep` 不被当作派出授权（现有写法只认 retry/adjust，核对即可，不需要时不改） |

### src/core/storage/database-paths.ts、database.ts
| 位置 | 职责 |
|---|---|
| `DATABASE_SCHEMA_VERSIONS.data` | 6 → 7 |
| `OUTDATED_VERSIONS.data` | 加入 6 |

## 协作关系
`escalateTask` → `goalHeld`（plan-manage.ts 导出）；`update` → `goalHeld`、`readjusted`、`materialize`（传 userAuthorized）。用户决定由 src/modules/panel/adjudication.ts 写入（另一份 plan 负责），本 plan 只需 schema 接受 `keep` 与 `splitRequest`。

## 验证方式
- 测试入口：`createPmRunWorld`（tests/helpers/run-manager-fixture.ts）建出的 PM 世界里的 `w.plan.execute`（propose / confirm / update / assess-update）、`w.fixture.approveRevision`、`escalateTask`（src/modules/pm/task-dispatch.ts 导出）与现有 `w.escalate` 写法、`w.manager.dispatchTask`；用户决定可直接写数据库 `userDecision` 模拟（现有测试已有此写法），choice 分别为 `adjust`、`keep`。
- 测试输入：login 执行 1 次没做完（turn_limit_reached）→ 批准改了 goal.login 的新版本 → assess-update 判 login 受影响（needs_update）。
- 预期结果：
  - [ ] C-1：上报被接受，login 为 awaiting_user，最近一次尝试带 escalation，任务带 splitRequest（版本号 = 当前批准版本号）。
  - [ ] C-2：复核前已完成且审查全过的任务判受影响后上报被拒，原因含「不占住目标」；已有 adjust 决定（请求拆分后）的任务再上报同样被拒。
  - [ ] C-3：needs_update 且有 running 尝试时上报被拒，原因含「运行」。
  - [ ] C-4：写入 keep 决定（版本号 = 当前）后再上报被拒，原因含「不拆」；再批准一个新版本、复核判受影响后上报被接受。
  - [ ] C-8：请求拆分后写入 adjust 决定（同一批准版本）→ update 取消 login 并另加同目标 login-a、login-b 被接受；另一次 update 修改 login 减少目标被接受，login 新增一个周期起点、replanAllowance 不变。
  - [ ] C-9：写入 keep 决定 → 取消 login 被拒 goal_held、另加同目标任务被拒 goal_held、修改减少目标被拒 goal_held；修改 login 本身被接受。
  - [ ] 没有请求拆分的普通 adjust 决定，仍须等新批准版本才能修改（原有测试保持通过）。
  - [ ] data 库版本 7；打开版本 6 的库按过期版本处理（参照 tests/database-storage.test.ts 现有写法）。
