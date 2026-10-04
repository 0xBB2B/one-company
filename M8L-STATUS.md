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
| AC1 计划被拒：第 1 次自动唤醒一次，第 2 次上报，成功或转话后清零 | 未开始 | 无 | 全部 |
| AC2 PM 停下且无人能唤醒时生成提醒，被唤醒后消失 | 未开始 | 无 | 全部 |
| AC3 针对事项的问答窗口；决定类选项由程序写死且选中即登记，其余只作指示 | 未开始 | 无 | 全部 |
| AC4 状态行被拒次数、PM 角色说明、主会话规则 | 未开始 | 无 | 全部 |
| AC5 真实模型验收并入 M9-AC2、3、12、13 按 3 轮规则重跑 | 未开始 | 无 | 待 AC1 到 AC4 完成 |

## 当前阻塞

无。

## 下一窗口续接提示

```
项目：/Users/bb/.bb-spec/worktrees/pi-spec-bb-spec-rebuild（分支 bb-spec-rebuild，只做本地提交，不推送）。
先完整读 AGENTS.md 与 SQLITE-KNOWLEDGE-REBUILD-PLAN.md（M8F 到 M8L、M9 章节与 §13），再读本文件与 M9-STATUS.md，核对 git status 与最近提交，从 AC 状态表第一条未通过的 AC 继续。界面以 .bb-spec/.cache/ui-preview/pm-stall-reminder.html 为准。
验证入口：pnpm run typecheck；pnpm test；pnpm run test:integration；pnpm run test:installation。
```
