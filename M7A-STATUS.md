# M7A 状态

阶段目标：PM 按修改文件与功能拆分任务，无依赖且所在目录不重叠的 worker 任务并行执行；每个 worker 任务完成后由独立 reviewer 做任务级审查；最终检查只做全量正式测试与 QA 黑盒验收。

## AC 状态表

| AC | 状态 | 证据 | 剩余缺口 |
|---|---|---|---|
| AC1 所在目录重叠的无依赖任务不能同时运行，待审查/待返修继续占用目录 | 通过 | tests/task-dispatch.test.ts「M7A-AC1/AC2/AC3/AC6」：a 待审查时与其目录重叠的 b 派工被拒（write_scope_busy），不重叠的 c 可同时运行；实现 runtime/task-dispatch.ts assertDirectoriesFree | 无 |
| AC2 reviewer 审 A 期间 B 继续写，结论绑定 A 的尝试，不需检查阶段令牌 | 通过 | 同上：c 运行中派 reviewer 审 a，审查记录绑定 a 的尝试，reviewer 无 change_apply、运行不带可写范围；tests/pending-update.test.ts「M6-AC19/M7A-AC2」：reviewer 只能跑 debug 且写工作区被沙箱拒绝，裁决绑定被审任务尝试、不能绑定检查轮 | 无 |
| AC3 A 审查通过前依赖 A 的任务不能派出 | 通过 | tests/task-dispatch.test.ts「M7A-AC1/AC2/AC3/AC6」：a 待审查时 d 派工被拒（dependency_pending），审查通过后 d 可派出 | 无 |
| AC4 打回时 reviewer 任务仍完成；返修单独计数，再次打回待用户裁决 | 通过 | tests/task-dispatch.test.ts「M7A-AC4」：打回后 reviewer 运行为 completed、任务待返修；不带 rework 或带 retry 被拒；返修尝试带原因、标记 rework、上下文含打回问题；再次打回进入待用户裁决，再派与新增同目标任务均被拒；用户"再给一次机会"按原因回到返修或再审（runtime/adjudication.ts） | 无 |
| AC5 任务未全部审查通过不能开检查轮；检查轮只收 QA 结论 | 通过 | tests/zero-custom-loop.test.ts「M7-AC19」：impl 待审查时 PM 进入检查被拒（tasks_not_reviewed），审查通过后才进入检查、只派 QA；tests/pending-update.test.ts：reviewer 在检查轮提交裁决被拒 | 无 |
| AC6 关闭要求最新检查轮全量测试与 QA 通过且全部 worker 任务审查通过 | 通过 | tests/task-dispatch.test.ts「M7A-AC1/AC2/AC3/AC6」：有任务未审查时交付核对报 task_review_missing；tests/workflow-close.test.ts（QA 阻塞/未验证分别拒绝、只有 QA 的检查轮可关闭）；tests/zero-custom-loop.test.ts 完整闭环关闭；typecheck、pnpm test、test:integration（79）、test:installation（11）全部通过 | 无 |

## 当前阻塞

无。

## 下一窗口续接提示

```
项目：/Users/bb/.bb-spec/worktrees/pi-spec-bb-spec-rebuild（分支 bb-spec-rebuild，不推送）。
先完整读 AGENTS.md 与 SQLITE-KNOWLEDGE-REBUILD-PLAN.md，再核对 git status 与最近提交。M0–M7、M7A 已收口不重做。
M7A 已完成：worker 任务按所在目录互斥并行；每个 worker 任务完成后进入待审查，PM 用 agent_manage dispatch 带 review 派 reviewer（可用任务的 reviewAgent 指定专业审查定义）；打回后带 rework 返修一次，再次打回交用户裁决；检查轮须全部 worker 任务审查通过才能开启，只收 QA 结论；关闭要求 QA 通过且全部 worker 任务有绑定最后完成尝试的通过审查。计划中不再有 reviewer 任务。
下一步：按计划开始 M8，先读计划 M8 章节并建立 M8-STATUS.md。
验证入口：pnpm run typecheck；pnpm test；pnpm run test:integration；pnpm run test:installation。
```
