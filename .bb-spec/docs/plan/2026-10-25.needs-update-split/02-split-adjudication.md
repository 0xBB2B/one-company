---
name: split-adjudication
description: 请求拆分的任务在面板、决策包、问答窗口显示三个选项，用户的拆分/不拆/终止决定按规则生效
---
# 请求拆分的裁决与界面文字

## 目标
因请求拆分而等用户裁决的任务：面板原因、决策包、问答窗口按确认过的预览显示；用户决定按「拆分 / 不拆 / 终止」生效并通知 PM。

## 业务规则（来源：PRD split-request，界面文字经用户 2026-10-25 看 HTML 预览确认）
- 识别：任务状态 `awaiting_user` 且带 `splitRequest`（另一份 plan 在任务记录上新增的字段）即「请求拆分」的待裁决事项。
- C-5：面板待裁决行 `待裁决：任务 <key> 需求改了，PM 请求拆分`；其他上报的任务照旧 `待裁决：任务 <key> PM 上报需要决定`。
- C-6：决策包「可选」一行逐字：
  `可选：1 让 PM 按新版本拆分（PM 可取消本任务、把目标分给新任务，不需要再改 PRD；拆出的任务和改写后的本任务各重新计 2 次执行机会）；2 不拆，让 PM 原地改写（本任务照旧占住目标、目标不能减少；本版本内 PM 不能再为它请求拆分）；3 终止这个任务（整个需求暂停，须调整需求或取消需求）。`
  决策包照常列出 PM 的上报说明（标注为模型说法）。
- C-7：问答窗口固定选项依次为 `让 PM 按新版本拆分`、`不拆，让 PM 原地改写`、`终止这个任务`；主代理给的文字或顺序不同时提问被拒（沿用 fixedChoiceIssue）。
- 用户回答到内部 choice：拆分 = `adjust`，不拆 = `keep`，终止 = `terminate`。请求拆分的任务只接受这三个；其他任务只接受 `retry`、`adjust`、`terminate`（`keep` 被拒）。解释器（模型）提示词写明：任务事项是请求拆分时 choice 只能是 adjust=让 PM 按新版本拆分、keep=不拆让 PM 原地改写、terminate=终止这个任务；给解释器的事项摘要里写出这三个选项。
- C-8 / C-9：`adjust` 与 `keep` 都把任务置回 `needs_update`；`terminate` 与现有终止一致（C-10：任务取消、需求暂停）。
- 用户对请求拆分的事项做决定时（任一选项），登记的决定都带 `split: true`，表示答复的是拆分请求（内核据此在选 adjust 时不等新的批准版本就放开目标；keep、terminate 带着也不放开任何东西）；只在待裁决事项是请求拆分时写，普通待裁决事项的决定不带 split。登记决定的同时清掉任务上的 `splitRequest`（此后它不再是请求拆分的待裁决事项）。
- C-11：任一决定后 replanAllowance 恢复为 1（现有行为，保持）。
- 通知 PM 的文字：adjust → `用户决定：任务 <key> 由你按当前批准版本拆分或改写。用 plan_manage update 取消该任务另加任务、或修改该任务（目标可以减少），不需要等新的批准版本。`；keep → `用户决定：任务 <key> 不拆，由你原地改写。用 plan_manage update 修改该任务本身，目标不能减少；本批准版本内不能再为它请求拆分。`
- 其他待裁决任务的面板、决策包、窗口文字一律不变。

## 涉及文件
- src/modules/panel/pm-overview.ts（修改）
- src/modules/panel/decision-packet.ts（修改）
- src/modules/panel/panel-item-ask.ts（修改）
- src/modules/panel/adjudication.ts（修改）
- src/modules/requirement/user-interaction-format.ts（修改）
- src/modules/interaction/user-interaction-model.ts（修改，提示词）

## 函数清单
### src/modules/panel/pm-overview.ts
| 函数名 | 职责 |
|---|---|
| `pendingItemsIn` | awaiting_user 且带 splitRequest 的任务，cause 为「需求改了，PM 请求拆分」，判断放在现有 sizeHold、上报两种之前 |
### src/modules/panel/decision-packet.ts
| 函数名 | 职责 |
|---|---|
| `decisionPacket` | 请求拆分的任务输出 C-6 的「可选」一行，窗口行用 `FIXED_CHOICES.split` |
### src/modules/panel/panel-item-ask.ts
| 函数名 | 职责 |
|---|---|
| `FIXED_CHOICES` | 新增 `split: ["让 PM 按新版本拆分", "不拆，让 PM 原地改写", "终止这个任务"]` |
| `panelItemTarget` | 请求拆分的任务用 `FIXED_CHOICES.split` |
### src/modules/panel/adjudication.ts
| 函数名 | 职责 |
|---|---|
| `adjudicationSubject` | 请求拆分的任务摘要加一行可选项（adjust / keep / terminate 的含义） |
| `applyAdjudication` | 按任务是否请求拆分（awaiting_user 且带 splitRequest）限定可接受的 choice；请求拆分时写入的 userDecision 带 `split: true`，并去掉任务上的 `splitRequest`；adjust、keep → needs_update；其余照旧 |
| 通知 PM 的函数 `takeUnnotifiedDecisions`（现有 `decision.choice === "adjust"` 分支所在处） | 按 `decision.split` 与 choice 给出请求拆分后的 adjust、keep 两种通知文字，放在现有 adjust 分支之前；keep 不得落到终止的文字 |
### src/modules/requirement/user-interaction-format.ts
| 位置 | 职责 |
|---|---|
| `ADJUDICATION_CHOICES`、`CHOICES_BY_SUBJECT.task` | 加入 `keep`（具体任务能否用 keep 由 applyAdjudication 判断） |
### src/modules/interaction/user-interaction-model.ts
| 位置 | 职责 |
|---|---|
| 解释器提示词里 adjudication 一段 | 补一句请求拆分任务的三个 choice 含义 |

## 协作关系
面板事项 `pendingItemsIn` → 决策包 `decisionPacket` / 窗口 `panelItemTarget` → 用户回答经解释器 `adjudicationOf` → `applyAdjudication` 写 `userDecision` → 通知函数把文字发给 PM。依赖另一份 plan 的 `TaskRecord.splitRequest` 与 `UserDecision.choice = keep`。

## 验证方式
- 测试入口：tests/pm-overview.test.ts、tests/pm-panel.test.ts、tests/panel-item-ask.test.ts、tests/adjudication.test.ts 的现有 helper（pendingWorld、mainAdjudication、escalate 等）；`decisionPacket`、`panelItemTarget`、`fixedChoiceIssue`、`applyAdjudication`、`adjudicationOf` 为导出入口。请求拆分的任务可按现有测试写法：login 执行 1 次没做完 → 批准新版本 → 复核判受影响 → PM 上报。
- 预期结果：
  - [ ] C-5：面板待裁决行为「待裁决：任务 login 需求改了，PM 请求拆分」；派出前上报的任务仍为「PM 上报需要决定」。
  - [ ] C-6：决策包含上面逐字的「可选」一行和 PM 的上报说明。
  - [ ] C-7：三个选项名按顺序被接受；换文字或顺序被拒。
  - [ ] 解释器结果 choice=keep 对请求拆分的任务被接受、对普通待裁决任务被拒；choice=retry 对请求拆分的任务被拒。
  - [ ] 选拆分 → 任务 needs_update，PM 收到「由你按当前批准版本拆分或改写」通知；选不拆 → needs_update，PM 收到「不拆，由你原地改写」通知；选终止 → 任务取消、需求待调整。
  - [ ] C-11：PM 先用掉重算额度，用户做任一决定后额度为 1。
  - [ ] 现有待裁决（执行未完成、拆分上限、派出前上报、审查卡住）的面板与决策包文字测试保持通过。
