---
name: panel-cycle
description: 用户裁决恢复重算额度；面板次数按当前周期写；决策包加新周期说明行和拆分选项的重新计次数说明
---
# 面板、决策包与裁决按计数周期（panel 模块）

## 目标
状态面板待处理事项的次数按当前计数周期写；决策包在每个新周期第 1 次尝试前加说明行，拆分上限的第 2 个选项写明重新计次数；用户每做一次裁决，任务的重算额度恢复为 1。

## 业务规则（来源：PRD replan-chances、resize-chances）
- 计数周期由任务记录的 `cycleStarts`（每个新周期开始时已有的尝试数，最后一项是当前周期起点）表示；重算额度是 `replanAllowance`（0 或 1）。pm 模块已提供 `cycleAttempts`、`cycleCountedAttempts`，`reviewRejections` 已按当前周期计。
- 用户每对任务做一次决定（再给一次机会、调整目标或范围、照做、让 PM 拆分或精简、终止），任务的 `replanAllowance` 写为 1。
- 待处理事项原因里的次数按当前周期：「N 次未完成」的 N 是当前周期计入次数的执行数；「改计划后要重做，执行机会已用完」在当前周期执行已满 2 次时显示；「N 次未通过审查」已由按周期的 `reviewRejections` 给出。
- 决策包照旧按顺序列出全部尝试；`cycleStarts` 里的每个起点 k，在第 k+1 次尝试那一行之前插一行「PM 改了计划，以下尝试重新计次数」。`cycleStarts` 为空时不插。
- 拆分上限的决策包第 2 个选项文字改为：「2 让 PM 拆分或精简（PM 直接修改任务，不需要改 PRD；拆出的任务和精简后的本任务各重新计 2 次执行机会）」，任务执行过没执行过都一样；问答窗口固定选项 `FIXED_CHOICES.resize` 不变。
- 文字已由用户 2026-10-24 看过 HTML 预览确认，原样使用。

## 涉及文件
- 修改 `src/modules/panel/adjudication.ts`
- 修改 `src/modules/panel/pm-overview.ts`
- 修改 `src/modules/panel/decision-packet.ts`

## 成品定义
决策包拆分上限选项的完整一行：

```
可选：1 照做（须由用户给出轮数上限，最多 1000）；2 让 PM 拆分或精简（PM 直接修改任务，不需要改 PRD；拆出的任务和精简后的本任务各重新计 2 次执行机会）；3 终止这个任务（整个需求暂停，须调整需求或取消需求）。
```

新周期说明行：

```
PM 改了计划，以下尝试重新计次数
```

## 函数清单
### src/modules/panel/adjudication.ts
| 函数名 | 职责 |
|---|---|
| 任务裁决登记（约 146–155 行，组装 `next` 的地方） | 写入用户决定时同时把 `replanAllowance` 设为 1 |

### src/modules/panel/pm-overview.ts
| 函数名 | 职责 |
|---|---|
| 待裁决原因（约 135–140 行，`stalledStage` 为 execute 的分支） | 「N 次未完成」和「改计划后要重做，执行机会已用完」改用 `cycleCountedAttempts` |

### src/modules/panel/decision-packet.ts
| 函数名 | 职责 |
|---|---|
| 待裁决事项决策包（约 46–58 行） | 列尝试时在每个新周期起点前插说明行；拆分上限选项改为成品定义里的文字 |

## 协作关系
依赖 01 号 plan 在 `src/modules/pm/plan-manage.ts` 导出的 `cycleAttempts`、`cycleCountedAttempts` 和任务记录的 `cycleStarts`、`replanAllowance`。决策包和面板只读任务记录，不写库；裁决登记在原有事务里写任务记录。

## 验证方式
- 测试入口：`tests/adjudication.test.ts`、`tests/pm-overview.test.ts` 的场景搭建（`world()`、`modifiedLogin(...)`、`pendingLabelsOf(w)`、`w.manager.decisionPacket(requirementId, itemId)`、`userAdjudicates(...)`、`w.task(key)`）。
- 预期结果：
  - [ ] 任务 pay 第 1 次没做完，PM 修改（开新周期），新周期 2 次没做完 → 待处理事项「待裁决：任务 pay 2 次未完成」；决策包依次是尝试 1、说明行「PM 改了计划，以下尝试重新计次数」、尝试 2、尝试 3。
  - [ ] 额度用掉后再修改、之后的尝试前不插说明行。
  - [ ] 任务 login 旧周期打回 1 次、新周期打回 2 次 → 待处理事项「待裁决：任务 login 2 次未通过审查」。
  - [ ] 已执行过 1 次的任务被改到 150 轮 → 决策包含成品定义里那一行选项文字；从没派出过的任务被改到 150 轮 → 同一行文字；窗口固定选项仍是「照做，轮数上限 N」「让 PM 拆分或精简」「终止这个任务」。
  - [ ] 用户对 `replanAllowance` 为 0 的任务登记「再给一次机会」→ 任务记录 `replanAllowance` 为 1；登记调整、拆分、终止同样为 1。
