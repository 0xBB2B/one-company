---
name: overview-task-rows
description: PM 概览新增任务行数据（执行、审查轮、待处理、检索），运行记录保存轮数上限，暂停文字写定义名，协议版本升到 4
---
# 概览里的任务行数据

## 目标
守护进程给窗口的 PM 概览里，直接带上面板要画的每个任务行、每个审查代理行，以及每条待处理事项属于哪个任务。

## 业务规则（来源：PRD status-panel-parallel C-1～C-5、C-8）
- 需求有子代理在跑，或有和某个任务有关的待处理事项时，列出任务行；按计划里任务的先后排列；PM 派出的检索也占一行，排在所有任务之后。
- PM 暂停中或已暂停时 `taskRows` 为空（面板照现在显示「暂停中：等待 …」那一行；用户 2026-10-21 决定）。一个任务同时有待处理事项和在跑的执行时各出一行，pending 行在前。
- 概览广播去重：算指纹时去掉任务行、审查代理行、检索行里的 `elapsedMs`，只有用时在变时不广播（窗口本地推算用时）。
- 面板上提到子代理的地方一律写定义名，包括 doing 里的「派 <X> 执行 / 审查 <任务号>」，没有定义名时才用职责名兜底。
- 任务行的种类：执行中（定义名、第几次尝试、已用轮数、轮数上限、用时）；审查中（第几轮、本轮每个审查代理）；等用户处理（这条事项的 itemId 和去掉"任务 <任务号> "后的文字，question 类写「待回答：未决问题」）。
- 审查代理行的状态：在跑（已用轮数、上限、用时）；本轮通过；本轮打回（blocked 或 unverified）；本轮被跳过（已关闭 / 已不存在）；本轮没派、上一轮已通过。PRD 没写"同轮其他代理还在跑时，某个代理已结束但没交出结论"怎么显示，本计划补一个状态 `ended`（面板写「没交出结论」），在计划简报里告知用户。
- 待处理事项原有的 label、itemId、version 一律不变（决策包、面板提问、裁决都原样使用 label）。
- 「暂停中：等待 <…> 结束」里写定义名（`RunRecord.agent.name`），不写职责名。
- 窗口直接使用新字段，旧守护进程不返回会出错，所以协议版本 3 → 4（按 2026-10-20 git-delivery-modes 的先例：握手不一致时提示关窗重开）。

## 涉及文件
- 修改 `src/modules/agents/run-store.ts`（RunRecord、CreateRunInput、schema 加可选 `maxTurns`）
- 修改 `src/app/daemon/run-manager.ts`（`dispatchTask` 建运行时写 maxTurns；`dispatchExplore`（:606-693）建运行时写 maxTurns）
- 修改 `src/modules/panel/pm-overview.ts`
- 修改 `src/core/host/protocol.ts`（:1 `PROTOCOL_VERSION` 3 → 4）
- 修改 `tests/pm-overview.test.ts`

## 成品定义
`src/modules/panel/pm-overview.ts` 新增和修改的类型（原样落盘）：

```ts
export interface PendingItem {
  itemId: string;
  kind: PendingItemKind;
  label: string;
  /** 事项所依据记录的版本；登记决定时须与当前一致。 */
  version: string;
  /** 和某个任务有关时为任务号，面板把它画在这个任务的行上。 */
  taskKey?: string;
  /** 画在任务行上时用的短文字，去掉了"任务 <任务号> "。 */
  taskText?: string;
}

export interface PanelRunStats { turns: number; maxTurns: number | null; elapsedMs: number }

export type PanelReviewerState = "running" | "clear" | "blocked" | "ended" | "skipped_disabled" | "skipped_missing" | "passed_earlier";
export interface PanelReviewerRow extends Partial<PanelRunStats> { agent: string; state: PanelReviewerState }

export type PanelTaskRow =
  | ({ kind: "execute"; taskKey: string; agent: string; attempt: number } & PanelRunStats)
  | { kind: "review"; taskKey: string; round: number; reviewers: PanelReviewerRow[] }
  | { kind: "pending"; taskKey: string; itemId: string; text: string }
  | ({ kind: "explore" } & PanelRunStats);
```

`PmOverview` 新增字段 `taskRows: PanelTaskRow[]`，其余字段不变。

## 函数清单
### src/modules/panel/pm-overview.ts
| 函数名 | 职责 |
|---|---|
| `pendingItemsIn`（改） | 与任务有关的事项（adjust-requirement、adjudicate、question）填 `taskKey`、`taskText` |
| `taskRowsOf` | 按计划任务顺序生成任务行：有待处理事项的任务出 pending 行；有运行中尝试的出 execute 行；处在审查中（或本轮还有代理在跑）的出 review 行；最后追加 PM 派出、还在跑的检索 |
| `reviewerRowsOf` | 生成一个任务本轮的审查代理行：本轮每个代理按最近一条记录给出状态，在跑的用对应运行记录的 turns、maxTurns、用时；再追加上一轮通过、本轮没派的专项审查（passed_earlier） |
| `runStatsOf` | 由运行记录算 turns、maxTurns、用时（now − startedAt − 暂停时长） |
| `doingOf`（改） | 暂停中名单用 `child.agent?.name` |
| `pmOverview`（改） | 返回值加 `taskRows` |
| `ROLE_LABEL`（改） | 只在运行记录没有定义名时兜底使用 |

### src/modules/agents/run-store.ts
| 函数名 | 职责 |
|---|---|
| `RunRecord` / `CreateRunInput` / schema（改） | 加可选 `maxTurns` |

## 协作关系
依赖"整轮审查的状态流转"计划的 `latestRound` 和审查记录上的 `agent`、`round`、`skipped`；"审查卡住时的事项文字"计划的 label。面板渲染由"面板树状显示"计划完成。概览经守护进程方法 `pm.overview` 发给窗口（`run-manager.ts` 的 `overviewOf`、`overviews`），方法本身不改。

## 验证方式
- 测试入口：`tests/pm-overview.test.ts` 的 `world()`（`overview()`、`run(id)`、`taskId(key)`）、`planWith(roles)` + `setStatus`；用 `createPmRunWorld` 的 `runStore` 写运行记录
- 预期结果：
  - 只有 T3 由 go-worker 第 1 次执行（maxTurns 20、turns 8）→ `taskRows` 只有一条 execute：agent go-worker、attempt 1、turns 8、maxTurns 20
  - T1、T2、T4 同时执行 → 三条 execute，按计划顺序
  - T1 第 1 轮 reviewer、go-reviewer 在跑、vue-reviewer clear → 一条 review（round 1），reviewers 依次为 running、running、clear
  - T1 第 2 轮只派了 reviewer、go-reviewer，vue-reviewer 上一轮 clear → reviewers 末尾有 vue-reviewer（passed_earlier）；go-reviewer 被跳过时状态 skipped_disabled
  - T1 awaiting_user、T2 执行中 → T1 为 pending 行，text「待裁决：两次未通过审查（go-reviewer）」，itemId 与 `pendingItems` 里那条相同；`pendingItems` 里这条的 label 仍是「待裁决：任务 T1 两次未通过审查（go-reviewer）」
  - question 事项的 taskText 为「待回答：未决问题」
  - PM 派检索（maxTurns 12）同时 T2 执行 → 最后一行 explore，maxTurns 12
  - 规划中没有子代理 → `taskRows` 为空，`doing` 照旧
  - 暂停中有 go-worker、reviewer 在跑 → doing 为「暂停中：等待 go-worker、reviewer 结束」
- [ ] `PROTOCOL_VERSION` 为 4，daemon-harness、security-regressions 测试（引用常量）通过
