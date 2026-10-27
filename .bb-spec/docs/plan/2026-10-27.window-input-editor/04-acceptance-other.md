---
name: acceptance-other
description: 验收窗口的返工改为其他（自己输入），事项说明、解释器说明和主代理规矩写明提问不登记返工
---
# 验收窗口的「其他」

## 目标
验收窗口第 3 项显示"其他（自己输入）"；主代理和解释器都被告知：写的是提问时先回答、不登记返工，明确要求修改才登记返工。

## 业务规则（来源：PRD window-input-editor / acceptance-other）
- 验收窗口选项依次"验收通过""暂不验收""其他（自己输入）"；Esc 含义和窗口其他内容保持现状。
- 待验收事项说明（决策包）里关于这一行写："用户写在"其他（自己输入）"一行的话，是提问就先回答，完成报告仍待验收，答完用 one_company_user_interact purpose=panel-item 再请用户验收；明确要求修改时，按原话以 one_company_user_interact purpose=adjudicate 登记返工，报告作废，意见交回 PM。"；不再出现"返工（自己输入要改什么）"。
- 主代理规矩"验收与关闭"一条写明：用户在验收窗口"其他"一行写的是提问时先回答，不登记返工，完成报告仍待验收，答完再请用户验收；用户明确要求修改时，才按原话登记返工。
- 用户的话拿去登记时，只有明确要求修改才记下返工；只是提问不记下任何决定（解释器的事项说明写明这一点）。

## 涉及文件
- 修改 `src/modules/panel/panel-item-ask.ts`
- 修改 `src/modules/panel/decision-packet.ts`
- 修改 `src/modules/panel/adjudication.ts`
- 修改 `rules/01-main-session.md`
- 修改 `tests/` 下断言这些文字的用例（`grep -rn "返工（自己输入要改什么）\|ACCEPTANCE_OTHER\|rework 返工" tests`）

## 函数清单
### src/modules/panel/panel-item-ask.ts
| 位置 | 职责 |
|---|---|
| `ACCEPTANCE_OTHER` | 删除；`panelItemTarget` 对 acceptance 不再给 `otherLabel`，窗口用默认"其他（自己输入）" |
### src/modules/panel/decision-packet.ts
| 位置 | 职责 |
|---|---|
| acceptance 分支的说明文字 | 可选项写"1 验收通过（随后以完成关闭需求）；2 暂不验收"，并写上面那段关于"其他"一行的话 |
### src/modules/panel/adjudication.ts
| 位置 | 职责 |
|---|---|
| 给解释器的 acceptance 事项说明（约 63 行） | rework 一项写明"仅当用户明确要求修改；只是提问时不输出决定" |
### rules/01-main-session.md
| 位置 | 职责 |
|---|---|
| 第 8 条 | 加上提问先回答、不登记返工、答完再请用户验收；明确要求修改才登记返工 |

## 协作关系
主代理调 `one_company_user_interact purpose=panel-item` → `askPanelItem` → `panelItemTarget`（选项与输入行名字）→ `askWindow`；回答后主代理调 `purpose=adjudicate` → 解释器读 `adjudication.ts` 的事项说明判断是否记下返工。

## 验证方式
- 测试入口：`panelItemTarget(ref, requirementId, itemId, itemVersion)`；决策包文字（沿用 `tests/` 里生成待验收决策包的现有用例）；解释器上下文里的 acceptance 事项说明（沿用 adjudication 现有用例）；读 `rules/01-main-session.md`。
- 预期结果：
- [ ] acceptance 事项的 `panelItemTarget` 结果没有 `otherLabel`，弹出的窗口第 3 项是"其他（自己输入）"
- [ ] 决策包含上面那段话，不含"返工（自己输入要改什么）"
- [ ] 解释器事项说明的 rework 一项含"只是提问时不输出决定"
- [ ] `rules/01-main-session.md` 第 8 条含"提问时先回答，不登记返工"和"明确要求修改时，才按原话登记返工"
- [ ] 真实模型验收里"提问不作废报告"由 exec 收尾的验收测试覆盖（本 plan 不写真实模型测试）
