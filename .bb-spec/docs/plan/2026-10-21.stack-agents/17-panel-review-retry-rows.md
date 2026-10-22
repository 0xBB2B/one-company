---
name: panel-review-retry-rows
description: 面板审查代理行新增「没交结论、等 PM 重派」「第 N 次」「两次没交结论」写法，替换原来的「没交出结论」
---
# 面板上审查重试的几种写法

## 目标
用户在面板上能看出哪个审查停了、为什么、在等谁，以及正在第几次重试。

## 业务规则（来源：PRD status-panel-parallel C-3、AC-9，用户 2026-10-22 看过预览 ⑪b～⑪e 后确认）
- 没交出结论、还能重派（本轮没交结论次数 < 上限）：「– <定义名> 没交出结论（<原因>），等 PM 重派 · ↻<已用>/<上限> · <用时>」，整行灰（dim）；原因：turn_limit_reached「轮数用满」、failed「运行失败」、stopped「被停止」。
- 同一轮里第 N 次（N ≥ 2）在跑：「⠹ <定义名>（第 N 次）· ↻<已用>/<上限> · <用时>」，正文默认色；第 1 次不写次数。N＝这个代理本轮记录条数。
- 本轮没交结论已满上限、不再重派：「– <定义名> 两次没交出结论，本轮结束后交你裁决 · ↻<已用>/<上限> · <用时>」，整行黄（warning）。
- PM 临时加的审查和名单里的一样显示。
- 被作废（superseded）、等 PM 重派：state awaiting_retry、reason superseded，面板写「– <名> 被作废，等 PM 重派 · ↻… · …」整行 dim（用户 2026-10-22 看过预览 ⑪f 后决定）；成品类型里 reason 的取值相应加上 "superseded"。
- 通过（clear）、打回（blocked）的行也带那次运行的 turns、maxTurns、用时（PRD C-3，13 号遗漏）。
- 已结束运行的用时算到 endedAt；先暂停后被停止时，暂停那段不计入。
- plan-manage.ts 的 REVIEW_OUTCOME_LABEL 里「轮次用满」改为「轮数用满」（用户 2026-10-22 决定）。
- 原来的 `ended`（「– <名> 没交出结论」）由上面两种取代，不再有这个状态。
- 其余写法、颜色、截断规则不变（已确认的预览 ⑦～⑭）。实现后与预览 ⑪b～⑪e 逐项对照。

## 涉及文件
- 修改 `src/modules/panel/pm-overview.ts`（成品类型与 `reviewerRowsOf`）
- 修改 `src/modules/panel/pm-panel.ts`（`reviewerLine`）
- 修改 `tests/pm-overview.test.ts`、`tests/pm-panel.test.ts`

## 成品定义
`src/modules/panel/pm-overview.ts` 中替换原有两个类型（原样落盘）：

```ts
export type PanelReviewerState = "running" | "clear" | "blocked" | "awaiting_retry" | "exhausted" | "skipped_disabled" | "skipped_missing" | "passed_earlier";
export interface PanelReviewerRow extends Partial<PanelRunStats> {
  agent: string;
  state: PanelReviewerState;
  /** 本轮第几次派这个代理；只在大于 1 时给出。 */
  attempt?: number;
  /** awaiting_retry 时没交出结论的原因。 */
  reason?: "turn_limit_reached" | "failed" | "stopped";
}
```

## 函数清单
### src/modules/panel/pm-overview.ts
| 函数名 | 职责 |
|---|---|
| `reviewerRowsOf`（改） | 按 16 号的 `reviewDispatchable` 区分 awaiting_retry / exhausted；running 行带 attempt（> 1 时）；awaiting_retry、exhausted 行带对应运行记录的 turns、maxTurns、用时 |
| `taskRowsOf`（改） | review 行出现条件：任务 reviewing（本轮未结束）或本轮有代理在跑 |

### src/modules/panel/pm-panel.ts
| 函数名 | 职责 |
|---|---|
| `reviewerLine`（改） | 按上面规则画 awaiting_retry（dim）、exhausted（warning）、running 带「（第 N 次）」；去掉 ended |

## 协作关系
依赖 16 号的 `reviewDispatchable`、`reviewRoster` 与审查记录；面板截断沿用 `segments`。

## 验证方式
- 测试入口：`tests/pm-overview.test.ts` 的 `rowsWorld` / `seedRun`；`tests/pm-panel.test.ts` 的 `overview(patch)`、`render(width)` 与记录颜色的假主题
- 预期结果：
  - go-reviewer 本轮 1 条 turn_limit_reached、reviewer 在跑 → reviewers 里 go-reviewer 为 `{ state: "awaiting_retry", reason: "turn_limit_reached", turns: 12, maxTurns: 12 }`；面板行「– go-reviewer 没交出结论（轮数用满），等 PM 重派 · ↻12/12 · …」整行 dim
  - 单派后 go-reviewer 第 2 条 running → `{ state: "running", attempt: 2 }`；面板「⠹ go-reviewer（第 2 次）· ↻2/20 · …」正文不着色
  - 第 2 条也没交结论 → `exhausted`；面板「– go-reviewer 两次没交出结论，本轮结束后交你裁决 · …」整行 warning
  - failed、stopped 原因分别写「运行失败」「被停止」
  - 临时加的 node-reviewer 在跑 → 和其他代理一样一行
  - 窄屏 1～12 列不超宽（沿用现有用例）
- [ ] 与预览 ⑪b～⑪e 逐项对照一致
