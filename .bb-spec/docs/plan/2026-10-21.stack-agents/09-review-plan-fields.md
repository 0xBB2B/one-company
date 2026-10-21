---
name: review-plan-fields
description: 计划任务的单个审查定义换成专项审查列表（带理由、同栈自动挂上），提交时按定义目录校验；审查记录加代理名和轮次；本机数据库升版本
---
# 计划里的专项审查字段与校验

## 目标
PM 能在一个 worker 任务上写多个专项审查并写理由；同栈专项审查自动挂上；写错的计划在提交时被拒并说明原因；任务的审查记录能记下是哪个代理、第几轮。

## 业务规则（来源：PRD multi-review C-1、C-2；definitions-and-switches C-11）
- worker 任务可写 0 个或多个专项审查，每个写定义名和一句理由。提交时以下情况被拒，原因写清：理由为空；同一任务重复写同一个定义；写了 reviewer（通用审查不用写）；定义不存在、职责不是 reviewer、或已关闭；非 worker 任务写了专项审查。
- 任务的执行定义（agent）已关闭时，计划提交被拒，原因「<名字> 已关闭」。
- 执行定义名是 `<前缀>-worker` 且目录里有 `<前缀>-reviewer` 时，程序自动把它加进这个任务的专项审查，理由「同栈自动挂上」；PM 自己也写了就不重复；不论它当时开没开都挂上（关着的派审查时再跳过），不受"已关闭就拒绝"限制。
- PM 读计划时能看出哪些是自动挂上的。
- 读回的计划原样交回不出错：提交时带 `auto: true` 的项一律忽略，由程序按目录重新算自动挂上的项（PM 伪造不了 auto）；自动挂上只认职责为 reviewer 的定义。（来源：合规审查，主 Agent 决定，写进完成简报）
- `agent_invalid` 和 `dependency_invalid` 一样计入"计划被拒"次数（`src/modules/pm/pm-attention.ts` 的 `PLAN_CONTENT_CODES`），连续两次被拒交用户。
- 任务原来的单个审查定义字段由这个列表取代。
- 数据格式变了：本机 data.db 版本号从 4 升到 5，旧库打开时报错并写明处理办法（项目规矩：1.0 前不写迁移代码；照 c29d404 的做法改三处）。

## 涉及文件
- 修改 `src/modules/pm/plan-manage.ts`
- 修改 `src/app/daemon/pm-tools.ts`
- 修改 `src/app/daemon/run-manager.ts`（:334 传目录查询；:447 派审查暂时只用通用 reviewer，整轮派出由"派出整轮审查"计划完成）
- 修改 `src/core/storage/database-paths.ts`（:6 data 4→5）、`src/core/storage/database.ts`（:124 OUTDATED_VERSIONS.data 加 4）
- 修改 `tests/plan-manage.test.ts`、`tests/agent-selection.test.ts`（:111-128 原 reviewAgent 用例改为新字段）、`tests/database-storage.test.ts`（:92-120）

## 函数清单
### src/modules/pm/plan-manage.ts
| 函数名 | 职责 |
|---|---|
| `TaskSpec`（改） | 去掉 `reviewAgent`；新增可选 `reviewers`：数组，每项 `agent`（定义名，同 agentName 格式）和 `reason`（text），最多 16 项 |
| `TaskRecord`（改） | 去掉 `reviewAgent`；新增 `reviewers`：每项 agent、reason，自动挂上的带 `auto: true` |
| `TaskReview`（改） | 新增 `agent`（审查代理定义名）、`round`（第几轮，从 1 开始）；outcome 增加 `skipped`，并带 `skipReason`（`disabled` 或 `missing`） |
| `PlanManageToolOptions`（改） | 新增 `agentDirectory`：异步返回目录里每个可用定义的名字、职责和是否关闭 |
| `validateAgents` | 用目录校验每个任务的执行定义是否已关闭，以及 `reviewers` 的全部规则；不合格用新错误码 `agent_invalid` 拒绝，detail 逐条写原因 |
| `withAutoReviewers` | 按"同栈自动挂上"规则给 worker 任务补上 `<前缀>-reviewer`（auto） |
| `validateSpecs`（改） | `strayReview` 改为检查 `reviewers` |
| `materialize`（改） | 写记录时带上 `reviewers`（含自动挂上的） |
| `textOnlyChange`（改，:143） | 比较两边 reviewers 的定义名列表（理由属于说明文字，可改） |
| `propose` / `update`（改） | 校验前先取一次目录，调用 `validateAgents`；写入前调用 `withAutoReviewers` |
| `PLAN_ADVICE`（改） | 新增 `agent_invalid` 的 why / next（why：计划里的角色定义用法不对；next：按逐条原因改任务的 agent 或 reviewers 后重新提交） |

### src/app/daemon/pm-tools.ts
| 函数名 | 职责 |
|---|---|
| `PmToolsInput`（改） | 新增 `agentDirectory`，原样传给 `createPlanManageTool` |

### src/app/daemon/run-manager.ts
| 函数名 | 职责 |
|---|---|
| 创建 PM 工具处（改，:334） | 传入 `agentDirectory`：由 `loadRoleCatalog`（可用条目）和 `loadDisabledAgents` 组装 |
| `dispatchTask`（改，:447） | 审查时解析的定义名固定为 `reviewer`，审查记录写入 `agent: "reviewer"`、`round`（本计划只保证编译和现有单审查流程照常） |

## 协作关系
依赖"可用定义清单与派工拦截"计划的 `loadDisabledAgents`。`round`、`skipped` 的使用由"整轮审查的状态流转"和"派出整轮审查"两份计划完成。

## 验证方式
- 测试入口：`tests/plan-manage.test.ts` 的 `spec(key, patch)`、`world()`（plan_manage 工具的 `execute({ action: "propose" | "update" | "confirm" })`，`agentDirectory` 由测试注入）
- 预期结果（每条都看拒绝错误码 `agent_invalid` 和 detail 里的原因）：
  - reviewers 里理由为空 → 拒绝；同一任务写两次 vue-reviewer → 拒绝；写 reviewer → 拒绝；写 go-worker（职责 worker）→ 拒绝；写已关闭的 vue-reviewer → 拒绝；写目录里不存在的 x-reviewer → 拒绝；qa 任务写 reviewers → 拒绝
  - 任务 agent 是已关闭的 py-worker → 拒绝，原因含「py-worker 已关闭」
  - agent 为 go-worker、没写 reviewers → 读回计划，该任务 reviewers 为 `[{ agent: "go-reviewer", reason: "同栈自动挂上", auto: true }]`；go-reviewer 关着时同样提交成功、同样挂上
  - agent 为 acme-worker、目录里没有 acme-reviewer → reviewers 为空
  - PM 自己写了 go-reviewer → 只出现一次
  - 只改 reviewers 理由的 update 视为只改说明文字
- 数据库：`tests/database-storage.test.ts` 加 data 版本 4 的旧库用例（打开报错并写处理办法），期望版本改为 5
- [ ] agent-selection 原 reviewAgent 用例改写后通过；全量 `pnpm test`、`pnpm run typecheck` 通过
