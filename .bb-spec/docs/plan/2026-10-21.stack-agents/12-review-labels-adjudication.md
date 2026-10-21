---
name: review-labels-adjudication
description: 审查卡住时的待处理事项写出是哪些审查代理；裁决卡片和告知 PM 的文字按代理和轮次列出审查记录
---
# 审查卡住时的事项文字与裁决

## 目标
任务因审查卡住交给用户时，用户在面板和裁决卡片里能看出是哪个审查代理打回或没交结论。

## 业务规则（来源：PRD multi-review C-9）
- 累计两轮有打回：待处理事项写「待裁决：任务 <任务号> 两次未通过审查（<打回过的审查代理名，按第一次打回的先后排，不重复，用"、"连接>）」。
- 同一个审查代理累计两次没交出结论：写「待裁决：任务 <任务号> 两次审查未完成（<名字>）」。
- 其余待处理事项文字不变（PM 上报、执行两次未完成、计划被拒等）。
- 事项的 itemId、version 不变；决策包、面板提问、裁决都按 itemId 匹配，文字原样带出。
- 裁决卡片里每条审查记录写出代理名和轮次；用户选"再给一次机会"后，回到哪个状态沿用现有规则（审查卡住回待审查、返修卡住回待返修）。

## 涉及文件
- 修改 `src/modules/panel/pm-overview.ts`（`pendingItemsIn`，:98-103）
- 修改 `src/modules/panel/adjudication.ts`（:71 卡片里的审查列表、:140 retryStatus、:193 告知 PM 的文字）
- 修改 `tests/pm-overview.test.ts`、`tests/adjudication.test.ts`

## 函数清单
### src/modules/panel/pm-overview.ts
| 函数名 | 职责 |
|---|---|
| `pendingItemsIn`（改） | 卡在审查时的原因文字带上代理名单 |
| `stallCauseOf` | 按 `stalledStage` 和任务审查记录生成原因：执行「两次未完成」；返修「两次未通过审查（名单）」；审查「两次审查未完成（名字）」 |

### src/modules/panel/adjudication.ts
| 函数名 | 职责 |
|---|---|
| 裁决卡片的审查列表（改，:71） | 每条写「第 <轮> 轮 <代理名>：<结局>」 |
| `retryStatus`（改，:140） | 按改过的 `stalledStage` 判断回到哪个状态，规则不变 |
| 告知 PM 的文字（改，:193） | 提到审查时带代理名 |

## 协作关系
依赖"整轮审查的状态流转"计划改过的 `stalledStage`、`reviewRejections`、`reviewFailures`、`latestRound` 和审查记录上的 `agent`、`round`。面板渲染不在本计划。

## 验证方式
- 测试入口：`tests/pm-overview.test.ts` 的 `world()`（`overview()`、`taskId(key)`）、`planWith(roles)` + `setStatus`，直接写任务的审查记录构造场景；`tests/adjudication.test.ts` 的 `world()`
- 预期结果：
  - T3 第 1 轮 go-reviewer blocked、第 2 轮 reviewer blocked、状态 awaiting_user → 事项 label 为「待裁决：任务 T3 两次未通过审查（go-reviewer、reviewer）」
  - 同一轮 go-reviewer 和 vue-reviewer 都打回、第 2 轮 go-reviewer 再打回 → 名单「go-reviewer、vue-reviewer」，不重复
  - vue-reviewer 两次没交结论、awaiting_user → 「待裁决：任务 T3 两次审查未完成（vue-reviewer）」
  - 执行两次未完成、PM 上报的文字不变（adjudication.test.ts:148 现有断言照旧）
  - 裁决卡片含「第 1 轮 go-reviewer：打回」这样的行；选"再给一次机会"后，审查卡住的任务回到 awaiting_review
- [ ] 现有 pm-overview、adjudication 用例不回归
