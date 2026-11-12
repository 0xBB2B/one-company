---
name: 03-pm-intake-card
description: 主窗口接手复核改成简短卡片：标题行加一行摘要，展开看调用参数和完整结果
---
# 接手复核卡片

## 目标
主窗口里 `one_company_user_interact` purpose=pm-intake 的 ask、forward、reply 显示成"接手复核"简短卡片，不再用 pi 默认的 `request={...}` 加 JSON。

## 业务规则（来源：PRD 03-summary-cards，用户 2026-11-12 确认预览）
- 标题行：粗体"接手复核" + 两个空格 + muted 色对象名。对象名是需求标题，还没拿到标题时写"需求 <编号前 8 位>"（和其他需求卡片同一套取名）。
- 执行中只有标题行。
- ask、forward 成功：一行摘要。understandingStatus 为 accepted 写"PM 理解已覆盖全部场景"，为 uncovered 写"还有 N 个场景没覆盖"（N = uncoveredScenarioIds 条数）；decisions 有且不为 0 条时后面加 muted 的"· PM 决定 M 条"。
- reply 成功：一行"已登记"，后面 muted 的"· <结论>"，结论按 record.result：passed→"复核通过"，pm_correction_required→"要 PM 改正"，prd_revision_required→"要改需求"，clarification_required→"要请用户澄清"；record.shortIssues 不为 0 条时再加"· 问题 K 条"。"复核通过"不用绿色。
- 摘要多项之间是 muted 色的"· "，写法和「登记决定」卡片的"已登记  · <决定>"一致；文字只用 text、muted、error，不用 dim。
- 失败：标题行下一行错误红"失败：<原因>"，原因取报错文字"原因："后那一段；展开看完整报错。
- 展开键：摘要下依次显示 muted"调用参数"、排好版的参数 JSON、muted"完整结果"、排好版的完整结果 JSON（即 details）。
- 收起最多 3 行；一行超出终端宽度时按卡片共用规则截断。
- 摘要从 `details`（完整结果）读，不从发给模型的 content 读。「提问」卡片和其他卡片不变。

## 涉及文件
- `src/modules/interaction/user-interact-tool.ts` 修改

## 函数清单
### src/modules/interaction/user-interact-tool.ts
| 函数名 | 职责 |
|---|---|
| `INTERACT_CARDS.cards["pm-intake:ask"]`、`["pm-intake:forward"]` | 新增：标题"接手复核"、对象名 `requirementLabel`，摘要按 understandingStatus 和 decisions 条数写一行 |
| `INTERACT_CARDS.cards["pm-intake:reply"]` | 新增：摘要"已登记 · <结论> · 问题 K 条" |
| `PM_INTAKE_RESULT_LABELS` | 新增常量：四种核对结论到中文说法的对照 |

卡片的标题行、失败行、展开、截断都由 `src/core/host/tool-card.ts` 的 `toolCard`、`summaryLine`、`requirementLabel` 处理，沿用现有「登记决定」卡片的写法。

## 协作关系
pi 调工具的 `renderCall`、`renderResult` → `card.renderCall/renderResult` → 按 `INTERACT_CARDS.actionOf` 得到的 `pm-intake:<action>` 选卡片规格；`isAskCard` 仍把 pm-intake 排除在「提问」卡片外。依赖 02-pm-intake-result 让 `details` 是完整结果。

## 验证方式
- 测试入口：`createUserInteractTool` 返回工具的 `renderCall`、`renderResult`（沿用 `tests/main-tool-cards.test.ts`、`tests/user-interact-tool.test.ts` 的渲染测试写法，用测试主题把颜色名写成可断言的标记）。
- 测试输入：pm-intake ask 的 details（accepted、decisions 3 条；uncovered、uncoveredScenarioIds 2 条、decisions 0 条）；forward 同样；reply 的四种 result、shortIssues 0 条和 2 条；执行中（无结果）；失败结果（报错文字含"原因：…\n建议：…"）；展开状态。
- 预期结果：
- [ ] 标题行是粗体"接手复核" + muted 对象名，不含 `request=` 和 JSON。
- [ ] 摘要分别是"PM 理解已覆盖全部场景  · PM 决定 3 条"、"还有 2 个场景没覆盖"、"已登记  · 复核通过"、"已登记  · 要 PM 改正  · 问题 2 条"等，与业务规则一致。
- [ ] 执行中只渲染标题行；失败时第二行是错误红"失败：<原因>"、不含"建议"。
- [ ] 展开后出现"调用参数""完整结果"两段，完整结果含只在 details 里的字段（如 binding）。
- [ ] 收起不超过 3 行，没有 dim 色。
- [ ] 原来固定"pm-intake 用 pi 默认样式"的测试（`tests/user-interact-tool.test.ts` 的 M8D-AC9 用例）改成断言接手复核卡片。
