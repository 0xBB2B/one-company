---
name: 02-pm-intake-result
description: 接手复核的结果 details 改放完整结果，ask、forward 发给模型的内容去掉绑定和哈希，上限只算发给模型的内容
---
# 接手复核结果精简

## 目标
`one_company_user_interact` purpose=pm-intake 的 ask、forward、reply 成功时，`details` 是完整结果；ask、forward 的 `content` 只放模型用得上的字段，reply 的 `content` 不变；大小上限只按 `content` 算。

## 业务规则（来源：PRD 02-lean-tool-results，OVERVIEW 决策记录 2026-11-12）
- 完整结果 = 现在 `content` 里的那个对象：服务返回的视图，ask、forward 再加 `decisions`，ask、reply 再加 `operationId`。它整份放进 `details`（现在 `details` 只有格式标记 `{format:"pm-intake-transport/v1", action}`，去掉这个标记）。
- ask、forward 的 `content` 只含：requestId、understanding、understandingStatus、uncoveredScenarioIds、decisions（有时）。binding、submissionRef、submissionHash、sourceDirectory、sourceDirectoryHash、createdAt、operationId、userAuthorizationCreated 只在 `details`。
- reply 不在精简表里，`content` 与改前逐字相同（整份完整结果）。
- 上限数值不变、只算 `content`（用户 2026-11-12 决定）：`content` 文字超过 49_152 字节报 `response_budget_exceeded`；去掉"content 加 details 合计不超过 50KiB"那道判断。原因：留存部分放完整结果后同一段接手理解会算两遍，理解超过约 24KB 就被拒，而服务本身允许视图到 48KB。
- 结果送达前核对照常生效：送达时 `{content, details}` 与执行时记下的逐字节比对、视图与数据库依据的核对都保留；`content` 或 `details` 被改动仍拒绝送达，报错与改前相同。
- 失败时报错文字不变。

## 涉及文件
- `src/modules/interaction/main-intake-interaction.ts` 修改

## 函数清单
### src/modules/interaction/main-intake-interaction.ts
| 函数名 | 职责 |
|---|---|
| `createPmIntakeToolResponse` | 组装完整结果放进 `details`；ask、forward 用 `pmIntakeRequestView` 生成 `content`，reply 的 `content` 是完整结果；只对 `content` 量 49_152 字节上限；照旧返回整份 response 的序列化文字供送达核对 |
| `pmIntakeRequestView` | 新增：从完整结果里取 ask、forward 发给模型的字段 |

删除不再使用的 `RESPONSE_BYTES` 常量。

## 协作关系
`MainIntakeInteraction.#executeOwned` 调 `createPmIntakeToolResponse`，把返回的 `responseBytes` 存进 delivery；`#assertDeliveryCurrent` 拿送达时的 `{content, details}` 序列化后与它比对，不改。

## 验证方式
- 测试入口：`MainIntakeInteraction` 的 execute 与 `assertDelivery`，以及 `createPmIntakeToolResponse`（沿用 `tests/main-intake-interaction.test.ts`、`tests/main-intake-interaction-limits.test.ts`、`tests/integration/pm-intake-interaction.test.ts` 的搭建方式）。
- 测试输入：ask、forward、reply 各一次成功调用；一份约 30KB 的接手理解；一份让 `content` 超过 49_152 字节的接手理解。
- 预期结果：ask、forward 的 content 恰好是上面 5 个字段（decisions 有时），details 含 binding、submissionHash、operationId（ask）等全部字段；reply 的 content 与改前相同，details 等于 content 解析出的对象。
- [ ] 约 30KB 的接手理解 ask 成功送达（改前会因合计超 50KiB 被拒）。
- [ ] content 超过 49_152 字节时报 `response_budget_exceeded`，报错文字与改前相同。
- [ ] 送达前改动 details 或 content，送达被拒绝；不改时照常送达。
- [ ] 现有测试里断言 details 是 `{format:"pm-intake-transport/v1", action}` 的用例（`tests/main-intake-interaction.test.ts`、`tests/integration/pm-intake-interaction.test.ts`、`tests/user-interact-tool.test.ts`、`tests/main-intake-interaction-limits.test.ts`）改成断言完整结果。
