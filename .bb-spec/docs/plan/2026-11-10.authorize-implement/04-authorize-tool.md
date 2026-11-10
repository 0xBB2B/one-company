---
name: authorize-tool
description: 需求工具新增 authorizeImplement 动作，串起确认窗口、解读、清单登记与需求服务
---
# authorizeImplement 工具动作与宿主流程

## 目标
主代理调用 `one_company_requirement_manage` 的 `authorizeImplement`，用户这句原话明确要实施时，需求的批准清单补上实施，之后派 PM 成功。

## 业务规则（来源：PRD 02-authorize-implement）
- 工具参数只有 `repoId`、`requirementId`（从工具结果抄来的引用），不放新操作编号；多传字段被拒。
- 判定顺序与结果：
  1. 原话来自提问窗口里点选的回答 → 拒绝，why"用户是在提问窗口里选的，这只算回答，不能用来补授权实施"，next"请用户在主窗口直接说要不要开始实施"。
  2. 需求不在生效状态（草稿、已关闭、已取消，或 recovery 不是 ready）→ 拒绝，why"需求不在生效状态（还是草稿、已关闭或已取消），不能补授权实施"，next"草稿请用户批准时在同一句话里说'批准并开始实施'；已关闭或已取消的需求不能再授权"。
  3. 草稿有未批准修改（saved 与 approved 的 commit 或 hash 不同）→ 拒绝，why"草稿有未批准的修改，补授权只能作用在已批准的版本上"，next"请用户把新版本连同'实施'一起批准（例如说'批准并开始实施'），不要用补授权"；不调用解释器。
  4. 当前清单已有实施 → 不弹窗、不解读、不登记，返回 status `already_authorized`、`implementAuthorization:"已授权实施"`、说明"这一版已经授权实施"。
  5. 实施目标为空 → 拒绝，why"已批准版本的实施目标板块下没有已确认的段落，授权实施也没有可做的内容"，next"请用户确认实施目标后批准新版本，并在同一句话里说实施"。
- 原话没有 @ 到这个需求 → 弹"授权实施"确认窗口（复用现有确认窗口，黄色边框，选项"确认""取消"，提示行"↑↓ 选择 · 回车确认 · Esc 取消"）。内容依次：标题"授权实施"；"需求：<需求标题>（已批准第 N 版）"（N 为需求的 revision）；灰字"编号：<需求编号> · 仓库：<仓库目录名>"；灰字"简介：<需求简介>"（没有简介不显示）；空一行；"确认后登记"实施"授权，PM 按已批准的第 N 版规划和派工。"。选"取消"或 Esc → 拒绝，why"用户取消了确认，没有登记实施授权"，next"不要重试；告诉用户这句话没有登记成实施授权"。关窗后再确认当前原话没被新话顶替。
- @ 到了这个需求 → 不弹窗。
- 解读中途用户说了新话 → 报 input_changed（沿用现有 `#unlessSuperseded`）。
- 成功：返回 status `authorized`、`implementAuthorization:"已授权实施"`、决定编号，以及 next"照规矩继续：工作区没建就先用 workspace-prepare 建，建好了用 agent_manage role=pm 派 PM"。
- 主代理规矩（`rules/01-main-session.md` 第 4 条一带）：用户要补授权实施时用 authorizeImplement，不用重新批准，也不用提问窗口；成功后工作区没建先建，建好了直接派 PM。

## 涉及文件
- 修改 `src/modules/interaction/requirement-manage-tool.ts`
- 修改 `src/modules/interaction/main-requirement-interaction.ts`
- 修改 `src/modules/requirement/host-authorization.ts`（HOST_ADVICE 加上面 5 个码：`implement_window_answer`、`implement_requirement_not_active`、`implement_draft_unapproved`、`implement_authorization_declined`、`implement_scope_empty`）
- 修改 `rules/01-main-session.md`
- 新建 真实模型单点验收（`tests/acceptance/points/` 下，编号按现有最大编号顺延，如 P22）

## 函数清单
### src/modules/interaction/requirement-manage-tool.ts
| 函数名 | 职责 |
|---|---|
| `actions.authorizeImplement`（schema）、执行分支、工具说明 | 新增：参数 `{action, repoId, requirementId}`，经 `interaction.execute` 调 `interaction.authorizeImplement` |

### src/modules/interaction/main-requirement-interaction.ts
| 函数名 | 职责 |
|---|---|
| `MainRequirementInteraction.authorizeImplement` | 新增：按业务规则的顺序判定 → 视需要弹窗 → 设置实施授权上下文 → 解读、保存、取凭据 → 生成并登记补授权清单 → 需求服务补授权 → 组装结果；结束时清掉上下文 |
| `#implementWindowLines` | 新增：生成确认窗口内容 |
| `#ensureCore` 的 `loadContext` | 修改：实施授权上下文存在时返回只含依据、空候选、空问题和 implementAuthorization 的上下文（仿照裁决分支） |
| `#implementAuthorization` 字段、`#dropInput` | 新增字段并随输入一起清除 |
| `RequirementServiceHandle`（类型） | 修改：加 `authorizeImplement` |

### tests/acceptance/points/（新建）
| 函数名 | 职责 |
|---|---|
| 单点验收用例 | 真实模型：用户只说"批准这一版"→ 主代理告诉用户还没授权实施、没有建工作区和派 PM → 用户说"授权实施"→ 主代理调 authorizeImplement 成功并调 workspace-prepare、派出 PM |

## 协作关系
工具 → `execute`（互斥、核对版本与 epoch、送达登记）→ `authorizeImplement` → 解读核心（03 号 plan）→ 清单登记（01 号 plan）→ 需求服务与状态（02 号 plan）→ `#prove`。之后派 PM 读到新清单，`implementAuthorized` 为真。

## 验证方式
- 测试入口：`tests/main-requirement-interaction.test.ts`（真实服务路径 + 受控解释器 + 窗口脚本的现有写法）、`tests/requirement-manage-tool.test.ts`、`tests/run-manager.test.ts` 或 `tests/pm-dispatch.test.ts`、`tests/error-advice-coverage.test.ts`、新的真实模型单点验收。
- 测试输入：需求已批准（原话"批准这一版"）、清单无实施；用户原话"授权实施"，分别 @ 与不 @ 需求。
- 预期结果与验证项：
- [ ] @ 到需求说"授权实施" → 不弹窗；结果 `implementAuthorization:"已授权实施"`；新旧清单段落确认情况相同；需求版本加 1、epoch 不变。
- [ ] 不 @ 需求 → 弹窗，标题、各行文字、选项、提示行与业务规则一致；没有简介时不显示简介行；选确认 → 成功；选取消或 Esc → 拒绝、清单不变。
- [ ] 再说一次 → `already_authorized`，不弹窗、不调用解释器。
- [ ] 草稿有未批准修改、需求是 draft 或 closed、原话来自提问窗口、解释器只给未决条目 → 分别按业务规则拒绝；未决条目那条的原话作废。
- [ ] 补授权后用"批准这一版"批准新版本 → 新清单没有 implement。
- [ ] 补授权后派出 PM 成功。
- [ ] 工具 schema 只接受 action、repoId、requirementId；多传 operationId 被拒。
- [ ] 主代理规矩含 authorizeImplement 的用法与成功后的下一步。
- [ ] 真实模型单点验收按上面的路径通过。
