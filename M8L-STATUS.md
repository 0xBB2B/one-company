# M8L 状态

阶段目标：PM 提交计划被拒或因其他原因停下时，流程不再无声卡住；用户从面板打开任何事项（原型确认除外）后，主代理分析完用通用问答窗口给出建议，用户在窗口里选或自己写。

范围与非目标：按计划 M8L 一节。不改原型确认窗口；不改批准需求只认原话的规则；不给 PM 新增上报动作；不改面板按键。

验证方法：AC1 到 AC4 有对应测试；`pnpm run typecheck`、`pnpm test`、`pnpm run test:integration`、`pnpm run test:installation` 通过；AC5 由 M9-AC2、AC3、AC12、AC13 在新基线上按 3 轮规则重跑取证。界面按已确认的预览 `.bb-spec/.cache/ui-preview/pm-stall-reminder.html` 实现，完成后逐项对照。

性能指标：不新增指标。

停止条件：出现 AGENTS.md「停止规则」任一情况。

起因（用户 2026-10-05 决定）：M9-AC3 一轮里 PM 把约束段写成任务目标被拒后停下，既没重交也没上报，没有任何东西会再唤醒它，验收卡住 10 分钟后被看门狗停止（证据 .bb-spec/.cache/m9/acceptance-sol61/code-error-2026-10-04T04-33-46-132Z）。

## AC 状态表

| AC | 状态 | 证据 | 剩余缺口 |
|---|---|---|---|
| AC1 计划被拒：第 1 次自动唤醒一次，第 2 次上报，成功或转话后清零 | 通过 | tests/plan-manage.test.ts「M8L-AC1」（逐次登记、接手门槛不计、成功清零）、tests/pm-dispatch.test.ts 两条「M8L-AC1」（第 1 次被拒后停下自动唤醒一次并附原因、唤醒后仍停下转为停下提醒、转话清零；被拒 2 次不唤醒不出停下提醒并留下 PM 最后的话）、tests/pm-overview.test.ts「M8L-AC1/AC4」（事项与卡片），都先失败后通过。“任务状态不允许”（task_not_ready）要等而不是改，不计数 | 无 |
| AC2 PM 停下且无人能唤醒时生成提醒，被唤醒后消失 | 通过 | tests/pm-dispatch.test.ts「M8L-AC2」（登记最后的话与运行记录、被唤醒后清掉并按新一轮重记）、tests/pm-overview.test.ts「M8L-AC2」（事项与卡片），都先失败后通过；已有别的事项时不显示停下提醒（tests/adjudication.test.ts 原有用例） | 无 |
| AC3 针对事项的问答窗口；决定类选项由程序写死且选中即登记，其余只作指示 | 通过 | tests/adjudication.test.ts 三条「M8L-AC3」（待你裁决选项须与固定文字一致、选中“再给一次机会，轮数上限 3”后可登记；计划两次被拒的回答不能登记任务裁决；需求级取消用 requirement:<编号> 固定选项、版本变化时拒绝）、tests/panel-item-ask.test.ts（固定文字与轮数 1 到 1000）；登记仍走原解释器与短决定路径，只放行与窗口所针对决定一致的回答。“待你验收”窗口因问答窗口至少 2 个选项，固定为“验收通过”“暂不验收”，返工写在“返工（自己输入要改什么）”一行，与预览只列“验收通过”一项不同 | 无 |
| AC4 状态行被拒次数、PM 角色说明、主会话规则 | 通过 | 状态行见 tests/pm-overview.test.ts「M8L-AC1/AC4」；PM 角色说明与主会话规则见 tests/role-catalog.test.ts「M8L-AC4」；README 的 PM 面板一节同步 | 无 |
| AC5 真实模型验收并入 M9-AC2、3、12、13 按 3 轮规则重跑 | 未通过 | 基线 7b5032a 上 AC3、AC12、AC13 各 3 轮通过，AC2 第 3 轮失败并修复（195db01）；之后 05eb061、ce96b11 又修了两处，M8M、M8N、M8O 也在改产品代码 | 在 M8O 完成后的基线上四项各连续 3 轮通过 |

## 当前阻塞

等 M8M、M8N、M8O 全部提交后再跑 AC5。

## 下一窗口续接提示

```
项目：/Users/bb/.bb-spec/worktrees/pi-spec-bb-spec-rebuild（分支 bb-spec-rebuild，只做本地提交，不推送）。
先完整读 AGENTS.md 与 SQLITE-KNOWLEDGE-REBUILD-PLAN.md（M8F 到 M8L、M9 章节与 §13），再读本文件与 M9-STATUS.md，核对 git status 与最近提交，从 AC 状态表第一条未通过的 AC 继续。界面以 .bb-spec/.cache/ui-preview/pm-stall-reminder.html 为准。
验证入口：pnpm run typecheck；pnpm test；pnpm run test:integration；pnpm run test:installation。
```
