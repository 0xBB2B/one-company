---
name: state-service-authorize
description: 需求记录改为引用补授权清单：状态层写入与需求服务的补授权入口
---
# 需求记录引用补授权清单

## 目标
需求服务新增"补授权实施"入口，把需求记录里的批准清单摘要换成补授权后的新清单；只保存最新一份。

## 业务规则（来源：PRD 02-authorize-implement、OVERVIEW）
- 适用条件：需求已生效（lifecycle 为 active、recovery 为 ready）、当前保存的就是已批准版本（saved 等于 approved）、旧清单里没有实施。
- 草稿有未批准修改 → 拒绝，原因写明草稿有未批准的修改，建议把新版本连同"实施"一起批准。
- 需求不在生效状态 → 拒绝，原因写明需求不在生效状态。
- 已授权实施 → 拒绝（上层会先判断并返回"已授权"，这里是兜底）。
- 写入后需求记录版本加 1（防同一凭据重放，也让以后批准新版本时这份清单对不上）；epoch、revision、pendingRevision、approved、approvalReceiptId、PM 租约都不变；追加一条"已补授权实施"事件；PM 只消费"已批准新版本"事件，收不到更新、不触发复核。
- 批准新版本时不沿用补授权：新版本批准走原路径，清单由新原话决定（现有行为）。
- 守"旧流程与旧记录不产生授权"：写事务前最后再调一次宿主的清单核对回调（与批准时 `recordApprovedVersion` 的做法相同），带凭据核对补授权清单，且 `supplement.baseManifestHash` 必须等于需求当前清单的 hash。
- 需求事件新增一种类型；按用户 2026-11-10 决定不升数据库版本号、不写迁移。

## 涉及文件
- 修改 `src/modules/requirement/requirement-state.ts`
- 修改 `src/modules/requirement/requirement-service.ts`
- 修改 `src/modules/requirement/requirement-contracts.ts`
- 修改 `src/modules/requirement/requirement-manage-contracts.ts`

## 函数清单
### src/modules/requirement/requirement-state.ts
| 函数名 | 职责 |
|---|---|
| `RequirementStateStore.recordImplementAuthorization` | 新增：最后一次清单核对回调 → 写事务内核对状态、版本、saved 等于 approved、无进行中保存或写占用、同一引用幂等返回、带凭据核对新清单、base 指纹等于当前、旧清单无实施 → 写入新摘要并记"已补授权实施"事件 |
| `RequirementAction`（类型） | 修改：加 `implement-authorization` |

### src/modules/requirement/requirement-contracts.ts
| 函数名 | 职责 |
|---|---|
| `RequirementEvent`（schema） | 修改：kind 加 `implement.authorized` |
| `commands.authorizeImplement`（schema） | 新增：补授权命令的输入格式 |
| `REQUIREMENT_STATE_ADVICE` | 修改：加 `draft_unapproved_changes`、`implement_already_authorized`、`manifest_supplement_mismatch`（why/next 见下） |

### src/modules/requirement/requirement-service.ts
| 函数名 | 职责 |
|---|---|
| `RequirementService.authorizeImplement` | 新增：与 `confirmUpdate` 同构但不读正文：校验输入 → 授权回调 → 读取 → 必须 active → 调 `recordImplementAuthorization`；返回 requirementId、version、epoch、revision 与批准范围 |
| `STATE_SCOPE`、`RequirementServiceAction` | 修改：加补授权动作及其状态权限 |

### src/modules/requirement/requirement-manage-contracts.ts
| 函数名 | 职责 |
|---|---|
| `AuthorizeImplementInput`（类型） | 新增 |

错误文案：
- `draft_unapproved_changes`：why"草稿有未批准的修改，补授权只能作用在已批准的版本上"；next"请用户把新版本连同'实施'一起批准（例如说'批准并开始实施'）"。
- `implement_already_authorized`：why"这一版已经授权实施"；next"重新读取需求状态"。
- `manifest_supplement_mismatch`：why"补授权清单和需求当前的批准清单对不上"；next"重新读取需求后按最新版本再试"。

## 协作关系
宿主（04 号 plan）经 `#service` 打开需求服务、调 `authorizeImplement`；服务调 `recordImplementAuthorization`，其中用 01 号 plan 的带凭据清单核对与 `checkImplementSupplement`；清单核对回调最终落到解读核心的补授权核对（03 号 plan）。

## 验证方式
- 测试入口：`tests/requirement-state.test.ts`、`tests/requirement-service.test.ts` 里对 `RequirementStateStore`、`RequirementService` 的调用（复用文件里造已批准需求、造清单的写法）。
- 测试输入：已批准且清单无实施的需求；按 01 号 plan 生成并登记的补授权清单与凭据。
- 预期结果与验证项：
- [ ] 成功后：需求版本加 1；epoch、revision、pendingRevision、approved、approvalReceiptId、pm_ownership 不变；摘要的 confirmed、pending、excluded、blocked 不变、reference 换成新清单；事件流多一条 `implement.authorized`，没有 `prd.approved`；PM 读"下一个已批准事件"返回已追上。
- [ ] 用旧版本号或旧凭据重放 → 被拒。
- [ ] saved 不等于 approved → `draft_unapproved_changes`。
- [ ] 需求是 draft、closing、closed → 生命周期不符被拒。
- [ ] 授权回调返回 false → 被拒（`authorization_required`）。
- [ ] 旧清单已有实施 → `implement_already_authorized`。
