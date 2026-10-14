---
name: interpreter-no-timeout
description: 去掉解释器首次回答与重答各 120 秒的时限，卡住时由用户取消
---
# 解释器不限时

## 目标
解释器每次回答不再被时限掐断；用户取消（Esc、修改输入）时仍立即中止。

## 业务规则（来源：PRD interpreter-no-timeout，用户 2026-10-14 决定）
- 首次回答和重答都不设时间上限。
- 取消信号照旧：外部取消时这次解读立即中止，不登记决定。
- 不再有"解读模型的超时设置不合规"这类报错，相关的选项和校验一并删掉。
- 暂停 PM 时等模型停下的 15 秒（daemon/agent-session.ts）不在本计划内，保留。
- README 里讲时限的两句（"一次解读最长接近 4 分钟""首次回答和重答各限时 120 秒"）由收尾的 /doc-update 处理。

## 涉及文件
- 修改 `runtime/user-interaction-model.ts`
- 修改 `runtime/user-interaction-format.ts`（删 `invalid_model_timeout` 这条原因）
- 修改测试：`tests/` 下用到 timeoutMs 或 invalid_model_timeout 的用例

## 函数清单
### runtime/user-interaction-model.ts
| 函数名 | 职责 |
|---|---|
| `createPiInteractionInterpreter` | 修改：删掉 `timeoutMs` 选项、校验与每次回答的计时器，保留外部取消 |

### runtime/user-interaction-format.ts
| 函数名 | 职责 |
|---|---|
| 原因表 | 修改：删掉 `invalid_model_timeout` |

## 协作关系
- `MainRequirementInteraction` 创建解释器时本来就不传 timeoutMs，不用改。

## 验证方式
- 测试入口：`createPiInteractionInterpreter` 的 `interpret`（现有测试用假 registry 的做法）。
- 测试输入：首次回答 150 秒后才返回（用假时钟或可控 promise，不要真等）；首次格式不对、重答 150 秒后返回；永不返回然后外部取消。
- 预期结果：
  - [ ] 慢的首次回答照常返回结果
  - [ ] 慢的重答照常返回结果
  - [ ] 永不返回时，外部取消后立即以"已取消"结束
  - [ ] 选项里没有 timeoutMs，源码里不再出现 invalid_model_timeout
