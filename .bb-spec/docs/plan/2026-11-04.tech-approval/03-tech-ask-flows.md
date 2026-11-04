---
name: 03-tech-ask-flows
description: one_company_user_interact 新增 ask-tech：主代理提问和面板事项两条路弹技术清单窗口；面板路同意后登记为调整并等新版本
---
# 技术清单的提问与裁决流程

## 目标
主代理能用 `one_company_user_interact` 的 `action=ask-tech` 弹技术清单窗口（需求澄清和面板事项两种用法），回答成为用户这一轮的原话；从 PM 上报事项打开时，用户同意后任务按“调整目标或范围”处理，PM 要等新批准版本才能改这个任务。

## 业务规则（来源：PRD 01-tech-list-window、03-pm-and-review）
- 参数：`purpose=user-confirmation`（可省）+ `action=ask-tech`：repoId、requirementId、savedOperationId、version、technologies（清单）、scope、unitIds、actions，和 ask 同样的公共字段；`purpose=panel-item` + `action=ask-tech`：repoId、requirementId、itemId、itemVersion、technologies。
- 先跑 `techListIssues`，有问题就报 `question_format` 失败（原因原样给模型），不弹窗口；再做 TypeBox 形状检查。
- 需求澄清用法：和现有 ask 一样先核对 unitIds 属于当前草稿、同一时间待解决问题已满 20 个时报 `question_limit`、没界面时报 `question_display_unavailable`；用 `techRecordText` 作为问题记录文字登记一条问题记录；窗口标题行“提问 · <需求名>（第 N 版）”。
- 回答：全部同意 → 原话 `techAgreeText`；写修改意见 → 原话为输入原文；Esc → 返回 status=pending，问题记录保留。回答只算回答，拿去批准或裁决时沿用现有 `window_answer_not_decision` 规则。返回内容沿用 ask 的字段（requestId、caption、question、status、answer、authorized:false），answer 写 `{ text, choice: 1 }` 或 `{ text, other: true }`。
- 面板事项用法：只接受待裁决的任务事项（`panelItemTarget` 给的是 retry 那组固定选项的任务）；拆分请求、超出上限、验收、需求等其他事项报失败，原因写明这类事项用 ask。窗口是同一个技术清单窗口，标题行同上，标题下多出“PM 拆计划时发现需要 · 卡住的任务：<任务编号> <任务标题>”。
- 面板用法选“全部同意”时，原话 = “调整目标或范围”换行接 `techAgreeText`；记下这次窗口回答来自技术清单。返回的 next 告诉主代理：先以 purpose=adjudicate 登记（itemId、itemVersion 照给），再用 updateDraft 把这些技术写进「实现」板块并请用户批准新版本。选“写修改意见”时原话为原文，next 写明按意见改清单再弹一次或修改需求，任务继续等用户决定。
- 这次裁决登记成 adjust 时，任务的用户决定带上“来自技术清单”标记：PM 收到的通知是“用户决定：任务 <编号> 调整目标或范围。等用户批准新的 PRD 版本后，复核并按新范围修改该任务，修改后可再派出一次。”；这个任务只有在新批准版本之后才能被 PM 修改，即使它是派出前上报的任务。
- 用户决定记录多一个可选字段，旧记录没有这个字段照样合法，不需要升数据库版本、不需要迁移（和已有的可选字段 `split` 同样处理）。不涉及窗口与守护进程通信，`PROTOCOL_VERSION` 不变。

## 涉及文件
- `src/modules/interaction/user-interact-tool.ts` 修改
- `src/modules/interaction/main-requirement-interaction.ts` 修改
- `src/modules/panel/adjudication.ts` 修改
- `src/modules/pm/plan-manage.ts` 修改
- `tests/user-interact-tool.test.ts`、`tests/main-requirement-interaction.test.ts`、`tests/adjudication.test.ts`（没有就放进现有裁决测试文件）修改

## 函数清单
### src/modules/interaction/user-interact-tool.ts
| 函数名 | 职责 |
|---|---|
| `schemas` / `variants` | 增加 `user-confirmation:ask-tech`、`panel-item:ask-tech` 两个变体 |
| `run` | 两个 ask-tech 变体先跑 `techListIssues`，再分别交给 `MainRequirementInteraction.askTech`、`askPanelItemTech` |
| `createUserInteractTool` 的 description | 补一句 ask-tech 的用法：什么时候用（要用新技术时一次列全；面板里 PM 上报要用新技术的待裁决任务）、每项 6 栏怎么填 |

### src/modules/interaction/main-requirement-interaction.ts
| 函数名 | 职责 |
|---|---|
| `askTech` | 需求澄清用法：核对、登记问题记录、弹窗、把回答记为原话、返回结果 |
| `askPanelItemTech` | 面板事项用法：校验事项、读任务编号和标题、弹窗、记原话并标记来自技术清单、返回带 decision 和 next 的结果 |
| `#adoptQuestionAnswer` | 面板决定信息里可带“来自技术清单”标记 |
| `adjudicate` | 当前原话来自技术清单窗口且登记结果是 adjust 时，把标记传给 `applyAdjudication` |

### src/modules/panel/adjudication.ts
| 函数名 | 职责 |
|---|---|
| `applyAdjudication` | 接受“来自技术清单”标记，选 adjust 时写进任务的用户决定 |
| `takeUnnotifiedDecisions` | 带标记的 adjust 决定，发“等用户批准新的 PRD 版本后……”那条通知 |

### src/modules/pm/plan-manage.ts
| 函数名 | 职责 |
|---|---|
| `UserDecision`（TypeBox） | 增加可选的“来自技术清单”字段 |
| `resized` | 带这个标记的决定不算“派出前上报可直接改”，只走 `readjusted` 的新版本放行 |

## 协作关系
- 工具 `run` → `MainRequirementInteraction.execute`（已有的会话与结果证明包装）→ `askTech` / `askPanelItemTech` → `techWindowQuestion`（02）→ `askWindow`。
- `askTech` 复用 ask 已有的 `#load`、`#authorization.interactionRecords`、`core.ask`、`#snapshot`、`#prove`；`askPanelItemTech` 复用 `panelItemTarget`、`#requirementTitle`、`readPlanIn`（取任务编号与标题）。
- `adjudicate` → `applyAdjudication` → 任务记录；守护进程把 `takeUnnotifiedDecisions` 的通知转给 PM（已有）。

## 验证方式
- 测试入口：`createUserInteractTool(...).execute`（`tests/user-interact-tool.test.ts` 已有写法）；`MainRequirementInteraction` 的测试世界（`tests/main-requirement-interaction.test.ts` 的 world()，窗口用脚本按键作答）；`applyAdjudication`、`takeUnnotifiedDecisions`、`goalHeld`。
- 预期结果：
  - [ ] ask-tech 清单缺一栏时工具失败、原因含“第 N 项”，窗口没有打开。
  - [ ] 需求澄清：选全部同意 → status=answered，之后本轮原话以“全部同意引入以下新技术：”开头；写修改意见 → 原话等于输入；Esc → status=pending 且问题记录仍在；已有 20 个待解决问题时报“待回答的问题已达上限”；用这次窗口回答去 confirm 批准被 `window_answer_not_decision` 拒绝。
  - [ ] 面板：对派出前上报的任务打开 → 窗口标题下有“PM 拆计划时发现需要 · 卡住的任务：<编号> <标题>”；选全部同意 → 原话以“调整目标或范围”开头，返回的 decision 是该任务；随后 adjudicate 登记为 adjust，任务用户决定带标记；`takeUnnotifiedDecisions` 给出“等用户批准新的 PRD 版本后，复核并按新范围修改该任务，修改后可再派出一次。”；同一版本下 PM 修改该任务被拒，批准新版本后可以修改。
  - [ ] 面板：对验收、拆分请求事项用 ask-tech 被拒，原因写明用 ask；选写修改意见后任务状态仍是等待用户裁决。
  - [ ] 不带标记的 adjust 决定，原有通知文字和放行行为不变（已有测试照常通过）。
