---
name: approval-result-and-rules
description: 批准结果写明有没有授权实施，派 PM 被拒的建议指向补授权，主代理请批准时提醒
---
# 批准结果写明授权实施与主代理提醒

## 目标
用户批准时知道可以顺便授权实施；主代理从批准结果就能知道有没有授权实施，没授权时先告诉用户，不先去派 PM。

## 业务规则（来源：PRD 01-approval-reminder）
- 主代理请用户批准需求时，在展示草稿要点之后提醒一句：批准后要直接开始实施，可以在同一句话里说"批准并开始实施"。
- 登记批准成功后，返回给主代理的结果写明有没有授权实施：批准清单里有 implement（且不是 unknown）时写"已授权实施"，否则写"没有授权实施"。没有授权时再给 next："需求已生效但没有授权实施：不建工作区、不派 PM；告诉用户要开始实施就说'授权实施'，再用 authorizeImplement 登记"。
- 字段要在调用 `#prove` 之前放进结果，否则会被判结果过期。
- 批准结果写明没有授权实施时，主代理不建工作区、不派 PM，直接告诉用户需求已生效但还没授权实施，要开始实施就说"授权实施"。
- 派出 PM 因批准清单里没有实施被拒时，给主代理的建议改为"请用户在主窗口说要实施，再用 one_company_requirement_manage authorizeImplement 补授权，成功后再派出 PM"。
- 批准原话明确授权了实施时，批准清单里有实施、派出 PM 成功（现有行为，保持）。
- 只改提示词与建议文字，`agents.dispatchPm` 的请求和返回字段不变，不升协议版本号。

## 涉及文件
- 修改 `src/modules/interaction/main-requirement-interaction.ts`
- 修改 `src/app/daemon/run-manager.ts`
- 修改 `rules/01-main-session.md`

## 函数清单
### src/modules/interaction/main-requirement-interaction.ts
| 函数名 | 职责 |
|---|---|
| `MainRequirementInteraction.confirm` | 修改：成功返回里加 `implementAuthorization`（用 01 号 plan 的 `manifestAuthorizesImplement` 判断），没授权时加 next |

### src/app/daemon/run-manager.ts
| 函数名 | 职责 |
|---|---|
| `PROTOCOL_NEXT.implement_not_authorized`（常量） | 修改：建议文字指向 authorizeImplement |

### rules/01-main-session.md
| 函数名 | 职责 |
|---|---|
| 第 3 条「批准」 | 修改：展示草稿要点后提醒"批准并开始实施"；批准结果是"没有授权实施"时不建工作区、不派 PM，告诉用户还没授权实施、要开始实施就说"授权实施" |

## 协作关系
`confirm` 用 01 号 plan 的 `manifestAuthorizesImplement`；规矩与派 PM 被拒的建议指向 04 号 plan 的 authorizeImplement。

## 验证方式
- 测试入口：`tests/main-requirement-interaction.test.ts`（受控解释器）、`tests/run-manager.test.ts`、检查规矩文本的现有测试（如 `tests/rules-extension.test.ts` 或 `tests/role-rules.test.ts`）、04 号 plan 新增的真实模型单点验收。
- 测试输入：批准原话"批准并开始实施"（解释器输出 implement 动作）与"批准这一版"（无动作）；清单无 implement 时调用派出 PM。
- 预期结果与验证项：
- [ ] "批准并开始实施" → 结果 `prdActivated:true`、`implementAuthorization:"已授权实施"`，派出 PM 成功。
- [ ] "批准这一版" → 结果 `implementAuthorization:"没有授权实施"`，带 next。
- [ ] 清单没有 implement 时派出 PM → 被拒，code `implement_not_authorized`，advice.next 提到 authorizeImplement。
- [ ] 主代理规矩第 3 条含"批准并开始实施"的提醒要求与"没有授权实施"时的处理。
- [ ] 真实模型单点验收里，主代理请批准的回复含"实施"；用户只说"批准这一版"后，主代理没有调用建工作区和派出 PM，并告诉用户还没授权实施。
