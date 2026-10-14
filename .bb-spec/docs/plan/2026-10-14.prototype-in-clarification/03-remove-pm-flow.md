---
name: remove-pm-flow
description: 删掉 PM 原型流程：任务界面标记、原型运行、面板原型事项、原型通知、旧 RPC 与旧规矩；README 与 CONTRIBUTING 改写并写升级须知
---
# 删掉 PM 的原型流程

## 目标
原型只剩主窗口这一条路。代码、规矩、文档和测试里都不再有 PM 那套原型流程。

## 业务规则（来源：PRD remove-pm-prototype-flow）
- 任务不再有界面标记：计划里带这个字段时，按格式错误拒绝，原因写明"界面标记已不存在，原型在主窗口澄清阶段做"。
- PM 派工时带出原型参数会被拒绝，原因写明"原型由主窗口在澄清阶段出，PM 不能派原型设计师"。
- worker 交原型会被拒绝。worker-prototype 这份规矩删掉。
- PM 面板不再出现"待你确认原型"。PM 也不再收到"用户通过了原型""用户要求返工""原型运行已结束"这几种通知。
- PM 规矩和主代理提示词里，不再提给任务打界面标记、派 worker 出原型、在面板里确认原型。
- README：
  - 删掉"界面任务先确认原型"一节和"待你确认原型按 Enter"一句；
  - 改写成新流程：主窗口派原型设计师 → 浏览器打开、窗口确认 → 随需求一起批准；
  - 存储表中原型目录那一行改成 `repos/<仓库身份>/prototypes/<需求编号>/<名称>.v<版本>.html`；
  - 加一段升级须知：升级前已在进行、计划里带旧原型记录的需求，先做完或取消再升级，升级后不对这类需求做处理。
- CONTRIBUTING：改掉"原型没通过不能派实现"和 P10 那一行的描述。
- 这次不迁移旧数据，读到旧记录时照常报格式错误（用户 2026-10-14 决定）。

## 涉及文件
- runtime/prototype.ts、role-rules/worker-prototype.md、tests/prototype.test.ts（删除）
- runtime/plan-manage.ts：删 `ui`、`prototypes`、`prototypeRun`、`PrototypeVersion`、`PrototypeRun`、`strayUi` 校验、取消门槛、HoldRef 的 prototype 分支
- runtime/task-dispatch.ts：删 `prototype_required`、`not_ui_task`、`beginPrototypeRun`、`finishPrototypeRun` 和派工门槛里的原型判断
- runtime/pm-overview.ts：删 prototype 事项和两句原型文案
- runtime/adjudication.ts：删原型决定通知
- runtime/decision-packet.ts、runtime/panel-item-ask.ts：删 prototype 分支
- runtime/host-authorization.ts：删 `prototype_window`
- runtime/protocol.ts：删 `pm.prototype`、`pm.prototypeDecide`
- runtime/role-tools.ts：保留 `QA_PROTOTYPE_HOST_TOOLS`（07 里 qa 读原型还要用）
- runtime/package-rules.ts：从 `RoleRulesName` 去掉 `worker-prototype`
- runtime/core-permissions.ts：worker 的 result_submit 去掉 prototype
- runtime/result-submit.ts：删掉绑定计划任务的 prototype 分支和 `prototypeBinding`（04 改成绑定原型看板后再加回）
- daemon/run-manager.ts：删 `prototypeContext`（PM 版）、`approvedPrototypeLine`、`finishPrototype`（PM 版）、dispatch 的 prototype 分支、两个旧 RPC
- daemon/pm-tools.ts、daemon/subagent-tools.ts：删 prototype 参数和工具说明；PM 派工参数里出现 prototype 时，按上面的原因拒绝
- extensions/pm-panel.ts：删 `confirmPrototype`、`PROTOTYPE_DECISION`、`ACCEPT`；`openWithSystem`、`openFile` 依赖和 `pathLines`、`formatBytes` 留给 05 搬走
- role-rules/pm.md、rules/01-main-session.md（第 5 步删掉"待你确认原型"例外）
- README.md、CONTRIBUTING.md
- tests：pm-panel、daemon-protocol、plan-manage、role-rules、role-catalog、pm-tools-failure 里涉及旧流程的用例删掉或改掉

## 函数清单
### daemon/pm-tools.ts
| 函数名 | 职责 |
|---|---|
| dispatch 参数校验（修改） | 原始参数里有 prototype 时，返回上面那句原因，不再报笼统的格式错误 |
### runtime/plan-manage.ts
| 函数名 | 职责 |
|---|---|
| 计划校验（修改） | 任务带 ui 字段时，返回上面那句原因 |

## 协作关系
- 排在 01、02 之后、04 之前：01 加的新职责和 02 的看板都还没接进流程，先删旧流程，后面各份就不用顾及旧代码，每次提交都能通过测试。04 到 07 完成前，系统暂时没有原型能力，只在本分支里存在。
- `extensions/pm-panel.ts` 里的 `openWithSystem`、`pathLines`、`formatBytes` 先留在原文件，05 再搬走。
- 删完后用 `grep -rn "prototypeRun\|worker-prototype\|pm.prototype\|待你确认原型\|approvedPrototype"` 确认没有残留。

## 验证方式
- 测试入口：plan_manage propose、PM 的 agent_manage dispatch、worker 的 result_submit、PM 概览、读 README。
- 预期结果：
  - [ ] 带 ui 字段的计划被拒，原因含"界面标记已不存在"；不带的计划被接受。
  - [ ] PM 派工带 prototype 时被拒，原因含"PM 不能派原型设计师"。
  - [ ] worker 调 result_submit 的 prototype 动作被拒。
  - [ ] PM 概览的事项类型里没有 prototype；PM 规矩和主代理提示词里没有旧流程的说法。
  - [ ] README 有新流程和升级须知，没有"待你确认原型"。
  - [ ] 上面那条 grep 没有命中；`pnpm run typecheck` 和 `pnpm test` 通过。
