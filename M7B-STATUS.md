# M7B 状态

阶段目标：PM 完成任务后不自行关闭，而是提交完成报告等待用户验收；用户读完确认通过后才由主窗口以 completed 关闭，返工则意见交回原 PM 继续。

## AC 状态表

| AC | 状态 | 证据 | 剩余缺口 |
|---|---|---|---|
| AC1 检查通过且交付核对无阻塞后 PM 能提交报告，事实由程序生成 | 通过 | tests/workflow-close.test.ts「M6-AC3/AC21」：无检查轮时报告被拒（formal_check_missing），有子代理运行时被拒（role_agents_running），主代理不能提交报告；「M7B-AC1/AC5」：新报告使旧报告作废；tests/zero-custom-loop.test.ts：决策包列出交付凭据、任务级审查、QA 结论、建议数、分支提交，PM 说明标为模型输出、仅供参考。实现 runtime/workflow-close.ts report | 无 |
| AC2 报告进 PM 面板待办，关窗仍保留，决策包展示全文 | 通过 | tests/zero-custom-loop.test.ts：守护进程概览出现"待你验收：PM 完成报告"，PM 行显示"等待你验收完成报告"，决策包含全部程序事实与 PM 说明；事项来自守护进程数据库，与窗口无关（沿用 M7-AC34 关窗保留机制）。实现 runtime/pm-overview.ts、runtime/decision-packet.ts | 无 |
| AC3 无用户通过决定时 completed 关闭一律被拒 | 通过 | tests/workflow-close.test.ts「M6-AC3/AC21」：PM 调 close 被拒（workflow_denied），主代理无通过决定时缺 completion_report_not_accepted；「M6-AC11」：通过后依据变化报 completion_report_stale；tests/zero-custom-loop.test.ts：随机回执、返工决定作回执均被拒；「M7B-AC3/AC6」用例：没有通过决定时主代理关闭被拒、需求保持 active | 无 |
| AC4 用户通过后主窗口关闭成功、PM 停止、完成归档 | 通过 | tests/zero-custom-loop.test.ts：用户原话经解释器登记 accept，主代理以该 decisionId 关闭，结果 closed + archived，PM 运行 stopped | 无 |
| AC5 返工作废报告、意见交回 PM、须重新审查与检查 | 通过 | tests/zero-custom-loop.test.ts：返工后报告为 rework，PM 收到含用户意见的消息，立即重交被拒（rework_not_addressed）；追加 fix 与 recheck 任务，fix 经任务级审查、新检查轮后新报告受理并验收通过。tests/workflow-close.test.ts「M7B-AC1/AC5」：依据未变拒绝、新检查轮后可重交。判定口径：返工后关闭依据（检查轮、正式验证、裁决、受管写入）必须变化才受理新报告 | 无 |
| AC6 批准清单不再接受 close，旧预授权不产生关闭权限 | 通过 | tests/zero-custom-loop.test.ts「M7B-AC3/AC6」：InteractionAction 不接受 close；按批准清单授权关闭的 closeAuthorized 已删除；原有关闭、撤权、互斥测试全部通过；typecheck、pnpm test（2317）、test:integration（79）、test:installation（11）在最终代码上全部通过。已知：含 close 动作的旧批准清单不能再通过校验、相关需求无法读取（不做兼容） | 无 |

独立核对（主代理按两条威胁模型逐项核对 55be767..3c25f30；当前宿主的子代理工具不能在配置中设置轮限，故未派审查子代理）：
- 模型输出不可信：PM 的 workflow_manage 已无 close 权限；completed 关闭只认主代理经宿主截获用户原话登记的 accept 决定，且须对应状态为 accepted、decisionId 相同的报告；报告绑定的交付依据在预检与进入 closing 的事务内各核对一次。PM 的说明与提交说明只出现在决策包，加引号并标为模型输出，不进入解释用户原话的上下文。登记报告决定只经 applyAdjudication，事项版本不符即拒。
- 旧流程与旧记录不产生授权：按批准清单授权关闭的 closeAuthorized 已删除，InteractionAction 不再接受 close；返工或已作废报告的决定不能作为关闭回执；PM 自关闭时不等待自身停止的分支已删除。
- 结论：未发现越出两条威胁模型的问题。

## 当前阻塞

无。

## 下一窗口续接提示

```
项目：/Users/bb/.bb-spec/worktrees/pi-spec-bb-spec-rebuild（分支 bb-spec-rebuild，不推送）。
先完整读 AGENTS.md 与 SQLITE-KNOWLEDGE-REBUILD-PLAN.md（§8.10 与 M7B 章节），再核对 git status 与最近提交。M0–M7、M7A、M7B 已收口不重做。
M7B 已完成：PM 完成后提交完成报告（workflow_manage report），不能关闭需求；报告作为"待你验收"事项出现在面板；用户经主代理登记通过或返工；completed 关闭只认通过决定且依据未变；返工意见交回原 PM。
下一步：按计划开始 M8，先读计划 M8 章节并建立 M8-STATUS.md。
验证入口：pnpm run typecheck；pnpm test；pnpm run test:integration；pnpm run test:installation。
```
