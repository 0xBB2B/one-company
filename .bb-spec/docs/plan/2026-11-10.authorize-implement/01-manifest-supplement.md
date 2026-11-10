---
name: manifest-supplement
description: 在已登记的批准清单上只加一个实施动作，生成、核对并登记补授权清单
---
# 补授权清单的生成与登记

## 目标
能在不重审需求正文的前提下，生成"旧批准清单原样 + 一个实施动作"的新清单，登记进本机数据库，并能被现有的清单核对认出来。

## 业务规则（来源：PRD 02-authorize-implement、OVERVIEW 决策记录）
- 补授权不重审需求正文：新清单里每个段落的确认情况（已确认、待定、排除）、问题处理情况、保留的原依据和原有动作，都与旧清单完全相同，只多一个"实施"动作。
- 补授权只登记实施：只加 `implement` 这一个动作，`unknown` 为 false。
- 旧清单已有实施时不再加（返回"已授权实施"由上层处理，这里报错拒绝）。
- 实施动作的目标段落：已批准版本里"实施目标"板块（需求文档规范里 goal 为 true 的板块）下全部已确认段落，和 PM 规划时 `implementScope` 的口径相同；约束段落是这些目标的依赖闭包减去目标本身。实施目标为空时拒绝。
- 守威胁模型"旧流程与旧记录不产生授权"：新加动作引用的决定必须是这一次补授权原话保存的：同一需求、同一仓库，actor 为 user，状态为 confirmed，`basisReceiptId`、`requirementVersion`、`epoch` 都等于这次补授权的凭据（admission），`prd` 等于已批准版本，引用里含候选的 commit 和 hash，没有 supersedes。旧清单里的决定照旧按旧清单原来的凭据核对。
- 存储格式：批准清单存储行加一个可选字段 `supplement`（记 `baseManifestHash`、补授权的那个决定编号、补授权凭据 admission），`decisionRecords` 上限由 40 改为 41（补授权那条不计入原上限）。旧行没有这个字段，原样合法；数据库版本号不升、不写迁移（用户 2026-11-10 决定）。
- 带凭据（receipt）核对清单时：有 `supplement` 就用补授权凭据核对版本和原话指纹（inputProof），没有就用原凭据；不带凭据的核对不变。

## 涉及文件
- 修改 `src/modules/requirement/approval-manifest.ts`
- 修改 `src/modules/requirement/approval-manifest-store.ts`
- 修改 `src/modules/pm/plan-manage.ts`（只改 `implementScope` 改为复用目标段落计算，避免两处口径分叉；不动待复核版本部分）
- 修改 `src/modules/requirement/requirement-manage-contracts.ts` 或现有错误表（新增错误码及原因）

## 函数清单
### src/modules/requirement/approval-manifest.ts
| 函数名 | 职责 |
|---|---|
| `manifestAuthorizesImplement` | 新增：清单里有没有 `implement` 且 `unknown` 为 false 的动作 |
| `implementGoalUnitIds` | 新增：按需求文档规范的 goal 板块，取清单里已确认的实施目标段落编号 |
| `supplementImplementAction` | 新增：旧清单 + 一个实施动作 → 新清单（算约束闭包、重算 manifestHash、过 `checkApprovalManifest`）；旧清单已有实施、目标为空时报错 |
| `checkImplementSupplement` | 新增：核对新清单去掉那个实施动作后与旧清单指纹相同、加的动作恰好是 implement 且只引用补授权决定、该决定不出现在别处 |

### src/modules/requirement/approval-manifest-store.ts
| 函数名 | 职责 |
|---|---|
| `Stored`（schema） | 修改：加可选 `supplement`，`decisionRecords` 上限 41 |
| `decisionSnapshots` | 修改：有 supplement 时旧决定按原凭据核对，补授权决定单独按补授权凭据核对 |
| `supplementDecisionSnapshot` | 新增：补授权那一个决定的核对规则（见业务规则） |
| `registeredApprovalManifestIn` | 修改：带凭据核对时有 supplement 就用补授权凭据 |
| `ApprovalManifestStore.registerImplementSupplement` | 新增：读旧清单（必须是需求当前批准清单）→ `checkImplementSupplement` → 取补授权凭据 → 写事务内核对版本、epoch、saved 等于 approved 等于候选、原话指纹 → 写新行（同 hash 同内容直接返回，内容不同报冲突） |

### src/modules/pm/plan-manage.ts
| 函数名 | 职责 |
|---|---|
| `implementScope` | 修改：目标段落改调 `implementGoalUnitIds`，行为不变 |

## 协作关系
宿主（04 号 plan）调 `implementGoalUnitIds`、`supplementImplementAction`，再调 `registerImplementSupplement`；状态层（02 号 plan）调带凭据的 `registeredApprovalManifestIn`，内部用 `checkImplementSupplement`。派 PM、PM 接手与规划仍只读清单里的 implement，不改。

## 验证方式
- 测试入口：`tests/approval-manifest.test.ts`、`tests/approval-manifest-store.test.ts`、`tests/plan-manage.test.ts` 里对这些导出函数与 `ApprovalManifestStore` 的调用（用文件里已有的造清单、造短决定写法）。
- 测试输入：一份已登记、没有实施动作的批准清单（含已确认、待定段落）；一条按补授权凭据保存的用户决定。
- 预期结果与验证项：
- [ ] 正常补授权：新清单与旧清单相比只多一个 implement 动作，units、questions、retainedSources 深度相等；`summarizeApprovalManifest` 的 confirmed、pending、excluded、blocked 与旧清单相同。
- [ ] 旧清单已有 implement → 拒绝；实施目标下没有已确认段落 → 拒绝。
- [ ] 篡改某段 disposition、多塞一个 push 动作 → `checkImplementSupplement` 拒绝。
- [ ] 补授权决定的 basisReceiptId 不是本次凭据、requirementVersion 是旧版本、prd 不等于已批准版本、actor 为 ai → 分别被拒。
- [ ] 登记前原话指纹变了 → 拒绝；没有 supplement 的已有清单照常通过核对。
- [ ] 同一份需求，`implementScope` 对补授权清单与"批准时就授权实施"的清单算出相同范围。
