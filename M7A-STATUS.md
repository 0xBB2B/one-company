# M7A 状态

阶段目标：PM 按修改文件与功能拆分任务，无依赖且所在目录不重叠的 worker 任务并行执行；每个 worker 任务完成后由独立 reviewer 做任务级审查；最终检查只做全量正式测试与 QA 黑盒验收。

## AC 状态表

| AC | 状态 | 证据 | 剩余缺口 |
|---|---|---|---|
| AC1 所在目录重叠的无依赖任务不能同时运行，待审查/待返修继续占用目录 | 未开始 | — | 全部 |
| AC2 reviewer 审 A 期间 B 继续写，结论绑定 A 的尝试，不需检查阶段令牌 | 未开始 | — | 全部 |
| AC3 A 审查通过前依赖 A 的任务不能派出 | 未开始 | — | 全部 |
| AC4 打回时 reviewer 任务仍完成；返修单独计数，再次打回待用户裁决 | 未开始 | — | 全部 |
| AC5 任务未全部审查通过不能开检查轮；检查轮只收 QA 结论 | 未开始 | — | 全部 |
| AC6 关闭要求最新检查轮全量测试与 QA 通过且全部 worker 任务审查通过 | 未开始 | — | 全部 |

## 当前阻塞

无。

## 下一窗口续接提示

```
项目：/Users/bb/.bb-spec/worktrees/pi-spec-bb-spec-rebuild（分支 bb-spec-rebuild，不推送）。
先完整读 AGENTS.md 与 SQLITE-KNOWLEDGE-REBUILD-PLAN.md（重点 §8.9 与 M7A 章节），再读本状态表，核对 git status 与最近提交。M0–M7 已收口不重做。
下一步：从 AC 表首个未通过项继续实现 M7A。
验证入口：pnpm run typecheck；pnpm test；pnpm run test:integration；pnpm run test:installation。
```
