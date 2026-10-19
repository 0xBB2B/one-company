---
name: 01-panel-text-no-pronoun
description: 状态面板的事项标签、PM 上报原因、第二行状态文字改为不含"你"，主代理规则与 README 同步
---
# 状态面板文字去掉"你"

## 目标
状态面板上给用户看的事项标签和第二行状态文字都不含"你"；主代理把事项标签原样写进面板事项提问时不被人称检查退回。

## 业务规则（来源：PRD 01-panel-text-no-pronoun）
- 背景：主代理发起 `one_company_user_interact` 提问时，question、rootCheck、选项 label、reason、recommendedReason 含"我""你""您"就会以 question_format 退回、不弹窗。事项标签会出现在面板 ⚑ 行、决策包第一行"[待处理事项] <标签>"和面板事项提问窗口标题，主代理常把它照抄进 question。
- C1：7 种事项标签逐字如下（任务名、版本号按实际值替换）：
  - 任务终止，待调整或取消需求：`待决定：任务 <任务名> 已终止，请调整需求或取消需求`
  - 任务待裁决：`待裁决：任务 <任务名> <原因>`（原因"两次未完成""两次审查未完成""两次未通过审查"和拆分上限原文不变）
  - 核对 PM 接手理解：`待核对：PM 接手理解 r<版本>`
  - 任务的未决问题：`待回答：任务 <任务名> 的未决问题`
  - PM 完成报告：`待验收：PM 完成报告`
  - PM 计划两次被拒：`待裁决：PM 计划两次提交被拒`
  - PM 停下：`待处理：PM 停下了，没有在跑的子任务`
- C2：PM 上报或任务带待定说明时，任务待裁决的原因为"PM 上报需要决定"。
- C3：面板第二行：任务终止后暂停为"等待调整需求"；计划提交被拒 ≥2 次为"规划中（计划提交被拒 N 次，等待决定）"；等待且有完成报告事项为"等待验收完成报告"；等待且有其他事项（PM 停下除外）为"等待决定"。
- C4：决策包第一行"[待处理事项] "后、面板事项提问窗口标题，用 C1、C2 的新标签。
- C5：purpose=panel-item 提问，question 含任一新标签原文、其余文字不含"我/你/您" → 窗口正常弹出，没有 question_format 错误。
- C6：主代理规则文件提到这些事项时写"待裁决""待验收"，不出现"待你裁决""待你验收"。
- 非目标：程序写给 PM 的说明（"由你拆分或精简""等待你处置"）、决策包给主代理的"也没有待你处理的事项"、原型报错"没有待你确认的版本"都不改；面板排版、符号、颜色、按键不改。

## 涉及文件
- 修改 `src/modules/panel/pm-overview.ts`
- 修改 `rules/01-main-session.md`（第 5 条"待处理事项"、第 8 条"验收与关闭"）
- 修改 `README.md`（状态面板示例第 74 行、待处理事项说明第 114–117 行）
- 测试（Test Agent 负责）：`tests/pm-overview.test.ts`、`tests/pm-panel.test.ts`、`tests/adjudication.test.ts`、`tests/approval-hold.test.ts`、`tests/pm-dispatch.test.ts`、`tests/prototype-flow-removed.test.ts`、`tests/prototype-windows.test.ts`、`tests/zero-custom-loop.test.ts`、`tests/user-documentation.test.ts`、`tests/acceptance/helpers/user-driver.ts`

## 函数清单
### src/modules/panel/pm-overview.ts
| 函数名 | 职责 |
|---|---|
| `pendingItemsIn` | 生成待处理事项；7 种 label 与 PM 上报原因改为 C1、C2 的文字 |
| `doingOf` | 生成面板第二行；4 处状态文字改为 C3 的文字 |

### rules/01-main-session.md、README.md
文字同步：事项名写"待裁决""待验收"等新标签；README 面板示例与说明里的标签换成新写法。

## 协作关系
`pendingItemsIn` 的 label 被 `pm-panel.ts` 渲染为 ⚑ 行，被 `decision-packet.ts` 拼进"[待处理事项] "首行，被 `panel-item-ask.ts` 作为提问窗口标题；这三处不需要改，只随 label 变化。无外部依赖。

## 验证方式
- 测试入口：`pendingItemsIn` / PM 概览（现有 `tests/pm-overview.test.ts` 的构造方式）、状态面板渲染（`tests/pm-panel.test.ts`）、决策包与面板事项提问（`tests/adjudication.test.ts` 现有的面板事项提问用例构造方式）、规则文件文本（`tests/user-documentation.test.ts`）。
- 测试输入：分别构造任务终止、两次未完成、PM 上报、接手理解待核对、未决问题、完成报告、计划两次被拒、PM 停下；以及暂停、计划被拒 2 次、等待验收、等待其他事项四种状态。
- 预期结果：
  - [ ] C1：7 种 label 与上表逐字相同，且不含"你"。
  - [ ] C2：PM 上报任务的 label 为"待裁决：任务 <任务名> PM 上报需要决定"。
  - [ ] C3：4 种第二行文字逐字相同，且不含"你"。
  - [ ] C4：决策包首行为"[待处理事项] 待裁决：任务 <任务名> <原因>"；面板事项提问窗口标题为同一标签。
  - [ ] C5：question 为"待裁决：任务 login 两次未完成，怎么处理？"的面板事项提问照常弹窗，无 question_format 错误。
  - [ ] C6：`rules/01-main-session.md` 含"待裁决""待验收"，不含"待你裁决""待你验收"。
  - [ ] 现有测试里断言旧文字（"待你…""等待你…""等你决定""需要你决定"）的地方改为新文字；`tests/acceptance/helpers/user-driver.ts` 按新标签匹配事项。
