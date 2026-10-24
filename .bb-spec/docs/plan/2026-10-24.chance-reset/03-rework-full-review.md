---
name: rework-full-review
description: 返修后新一轮派通用审查和全部开着的专项审查；去掉面板「上一轮已通过」；PM 规矩同步
---
# 返修后全部重审

## 目标
worker 返修完再派审查时，新一轮和第 1 轮一样派通用审查和审查名单里全部开着、还存在的专项审查；面板没有「上一轮已通过」这种审查行；PM 的规矩和说明写明返修后全部重审。

## 业务规则（来源：PRD rework-full-review）
- 返修完再派审查（新一轮）时：派通用审查 reviewer，加上审查名单（任务里写的、同栈自动挂上的、PM 临时加的专项审查）里的全部专项审查；被关掉或已不存在的专项审查照现有逻辑记为跳过、不启动。
- 同一轮里再派审查时，只重派没交出结论（还能重派）或被作废的代理，和现在一样。
- 给通用审查分 skill 时，按这一轮实际派出的专项审查算覆盖：关掉或不存在的专项审查不算覆盖，它负责的 skill 加载给通用审查（现有 `reviewedWorker` 已按名单去掉关掉、不存在的定义来算，全部重派后这一轮派出的就是这些，不需要另改，只需测试锁住）。
- 状态面板：返修后这一轮每个专项审查显示本轮状态（在跑、通过、打回、没交出结论、被作废、已关闭本轮未审）；去掉 `passed_earlier`（「✓ <定义名> 上一轮已通过」）这种状态，以及产生它的代码。
- PM 的职责规矩写明返修后全部审查重新审一遍；去掉「返修后再派审查只会重审通用 reviewer 和上一轮打回、没交结论或被作废的专项审查」的说法。

## 涉及文件
- 修改 `src/modules/pm/task-dispatch.ts`（`reviewRoundMembers` 及其上方注释）
- 修改 `src/modules/panel/pm-overview.ts`（`PanelReviewerState` 去掉 `passed_earlier`；审查行生成里约 252–256 行的「上一轮已通过」补行）
- 修改 `src/modules/panel/pm-panel.ts`（约 102、105 行 `passed_earlier` 的文字和样式分支）
- 修改 `role-rules/pm.md`（第 16 行）

## 成品定义
`role-rules/pm.md` 第 16 行里

```
返修后再派审查只会重审通用 reviewer 和上一轮打回、没交结论或被作废的专项审查（计划改了以后任务重新执行，则全部重审）；
```

改为：

```
返修后再派审查，通用 reviewer 和全部专项审查都重新审一遍；
```

## 函数清单
### src/modules/pm/task-dispatch.ts
| 函数名 | 职责 |
|---|---|
| `reviewRoundMembers` | 新一轮一律是通用 reviewer 加 `reviewRoster(task)`；同一轮重派逻辑不变；更新函数上方注释 |

### src/modules/panel/pm-overview.ts
| 函数名 | 职责 |
|---|---|
| `PanelReviewerState` | 去掉 `passed_earlier` |
| 审查行生成（`reviewRowsOf` 一类，约 230–257 行） | 删掉补「上一轮已通过」行的代码 |

### src/modules/panel/pm-panel.ts
| 函数名 | 职责 |
|---|---|
| 审查行文字与样式（约 95–106 行） | 删掉 `passed_earlier` 的文字和样式分支 |

## 协作关系
`RunManager.dispatchTask` 用 `reviewRoundMembers` 算本轮名单后派出；`reviewedWorker`（`src/app/daemon/run-manager.ts`）按名单去掉关掉、不存在的专项审查算 skill 覆盖，不改。

## 验证方式
- 测试入口：`tests/agent-selection.test.ts`、`tests/task-dispatch.test.ts`（多审查与返修相关用例）、`tests/pm-overview.test.ts`、`tests/pm-panel.test.ts`；用已有的派审查、登记审查结论、返修的场景搭建。
- 预期结果：
  - [ ] 第 1 轮 reviewer 打回、go-reviewer 和 vue-reviewer 通过 → 返修后派审查启动 reviewer、go-reviewer、vue-reviewer，轮次为 2。
  - [ ] 第 1 轮 go-reviewer 打回、vue-reviewer 通过 → 同样三个都启动。
  - [ ] 第 2 轮 go-reviewer 没交出结论，再派 → 只启动 go-reviewer，轮次仍是 2。
  - [ ] 返修期间关掉 vue-reviewer → 第 2 轮不启动它、记为跳过；通用审查的任务说明写明 Go 的 skill 由 go-reviewer 核对，vue-reviewer 负责且 go-reviewer 没覆盖的 skill 已加载给它核对。
  - [ ] 返修后一轮里面板每个专项审查一行，写本轮状态；面板文字里不出现「上一轮已通过」。
  - [ ] `role-rules/pm.md` 含「返修后再派审查，通用 reviewer 和全部专项审查都重新审一遍」，不含「只会重审」。
- 已有测试里断言「返修后只重审打回的专项审查」「上一轮已通过」的用例按新规则改期望或删除。
