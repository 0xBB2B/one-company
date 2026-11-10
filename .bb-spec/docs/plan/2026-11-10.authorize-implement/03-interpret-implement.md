---
name: interpret-implement
description: 解读核心只判断这句原话有没有明确授权实施，保存成补授权决定并能核对
---
# 只判断"有没有授权实施"的解读

## 目标
解读核心在"实施授权上下文"下只判断用户这句原话是否明确要实施，明确时保存一条补授权决定并给出补授权凭据；不重审需求正文。

## 业务规则（来源：PRD 02-authorize-implement、OVERVIEW 决策记录）
- 只认用户在主窗口亲口说的这句原话；"批准"不代表实施，每种动作都要原话明确说出（现有解读规则不改）。
- 原话明确要实施（如"授权实施""开始实施"）→ 只输出一条动作条目：kind=action、basis=explicit、resolution=direct、candidateId 与 requestId 为空、actions 只含 implement；原话同时说了提交、推送等，也只登记实施。
- 原话没有明确说要实施（如"继续""好的"）→ 不登记，报"这句话没有明确说要实施"；这句原话作废，建议是"这句用户原话已作废，不能直接重试；请用户在主窗口说清楚是否要实施，再用 authorizeImplement 登记"。
- "没有动作条目"不能在格式核对里拒绝：那里的失败会让解读模型带反馈重答一次，等于逼它输出授权。要在核对通过之后判断。
- 补授权决定绑定这一次原话：actor=user、confirmed、basisReceiptId 为本次凭据、requirementVersion 为当前版本，引用里补上已批准候选的 commit 与 hash；同时计算原话指纹（inputProof）。
- 交出凭据前同步核对：原话、模型、需求依据都没变，决定没被取代；需求 active、recovery ready、版本与 epoch 等于依据、saved 等于 approved 等于依据里的已批准版本、原话指纹没变、宿主回调放行。不满足返回空。
- 没有实施授权上下文时，现有解读行为完全不变（包括动作条目必须带候选的校验）。

## 涉及文件
- 修改 `src/modules/requirement/user-interaction-format.ts`
- 修改 `src/modules/interaction/user-interaction.ts`
- 修改 `src/modules/interaction/user-interaction-model.ts`

## 函数清单
### src/modules/requirement/user-interaction-format.ts
| 函数名 | 职责 |
|---|---|
| `ImplementAuthorizationSubject`（schema）、`InteractionContext.implementAuthorization` | 新增：已批准版本号与批准清单引用；发给模型时去掉哈希 |
| `checkContext` | 修改：有实施授权上下文时要求无正文、无候选、无裁决，且清单引用与依据一致；否则报 `implement_context_mismatch` |
| `implementActionOf` | 新增：实施授权上下文下动作条目的校验（见业务规则），多于一条报 `implement_action_invalid` |
| `checkInterpretation` | 修改：有实施授权上下文时动作条目改走 `implementActionOf`，不再要求候选 |
| `USER_INTERACTION_ADVICE`、`VOIDED_INPUT_NEXT_BY_CODE` | 修改：加 `implement_not_explicit`（why"这句话没有明确说要实施"，作废建议见业务规则）、`implement_action_invalid`（why"授权实施条目的解读内容不合规"）、`implement_context_mismatch`（why"授权实施的上下文和需求当前已批准的版本对不上"） |

### src/modules/interaction/user-interaction.ts
| 函数名 | 职责 |
|---|---|
| `UserInteractionCore.interpret` | 修改：实施授权上下文下也算原话指纹；只保留动作条目，其余结论放进未记录；一条动作都没有时报 `implement_not_explicit`（经现有出错处理作废原话）；给补授权决定补候选引用 |
| `UserInteractionCore.authorizeImplement` | 新增：对已保存的补授权能力做同步核对（见业务规则），通过时返回凭据、版本、epoch、原话指纹、决定编号，否则返回空 |
| `#requireVerified` | 修改：原话指纹核对扩展到实施授权上下文 |
| `InteractionAuthorization.action`（类型） | 修改：加 `authorize-implement` |

### src/modules/interaction/user-interaction-model.ts
| 函数名 | 职责 |
|---|---|
| `INSTRUCTIONS` | 修改：加一段——context.implementAuthorization 存在时，第 revision 版已批准、还没授权实施，只判断 text 是否明确要求开始实施；明确时只输出那一种动作条目；没明确说实施的话不输出动作，改列一条未决条目 |

## 协作关系
宿主（04 号 plan）设置实施授权上下文后调 `interpret`、`save`、`authorizeImplement`；`authorizeImplement` 的结果交给清单登记（01 号 plan）与需求服务（02 号 plan），后两者的最后核对回调再调它一次。

## 验证方式
- 测试入口：`tests/user-interaction.test.ts`（受控解释器、`world()` 等现有写法）、`tests/interaction-derivation.test.ts`、提示词断言写法同 `tests/main-requirement-interaction.test.ts` 里检查 INSTRUCTIONS 的用例。
- 测试输入：已批准、清单无实施的需求；实施授权上下文；解释器分别输出 implement 动作、implement+push、只有未决条目。
- 预期结果与验证项：
- [ ] 输出 implement → 保存后决定满足 actor=user、confirmed、basisReceiptId 为本次凭据、requirementVersion 为当前版本、引用含候选；`authorizeImplement` 返回凭据。
- [ ] 输出 implement+push → 只有一条决定、动作只含 implement。
- [ ] 只输出未决条目 → 报 `implement_not_explicit`，advice.next 为作废建议；同一票据再解读被拒。
- [ ] 原话换了或需求版本变了 → `authorizeImplement` 返回空。
- [ ] 实施授权上下文下带 candidateId 或 requestId 的动作条目被拒；没有该上下文时，无候选的动作条目仍报 `action_candidate_required`。
- [ ] INSTRUCTIONS 含实施授权那一段。
