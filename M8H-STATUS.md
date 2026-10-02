# M8H 状态

阶段目标：PM 每次提出或修改计划前，固定先查一次可用角色定义，不再由它自己判断要不要查。

范围与非目标：按计划 M8H 一节。只改 PM 的角色说明；程序不强制检查 PM 查没查；不把目录预先放进 PM 的开场信息。

验证方法：AC1 有对应测试；`pnpm run typecheck`、`pnpm test`、`pnpm run test:integration` 通过。

性能指标：不适用。

停止条件：出现 AGENTS.md「停止规则」任一情况。

起因（用户 2026-10-02 决定）：M9-AC13 真实模型验收第 9 轮，主会话与 PM 都是 gpt-6.1-sol，PM 全程只用了派工动作，没查过角色目录，用户层的 ui-worker 一次也没被选中（证据 .bb-spec/.cache/m9/acceptance-sol61/ui-worker-2026-10-02T13-01-10-952Z/report.json、tasks.json）。

## AC 状态表

| AC | 状态 | 证据 | 剩余缺口 |
|---|---|---|---|
| AC1 PM 角色说明写明提出或修改计划前先查一次角色目录 | 通过 | tests/role-catalog.test.ts「M8H-AC1」 | 无 |
| AC2 真实模型验收并入 M9-AC13 | 通过 | M9-AC13 第 10、11、13、14 轮 PM 都查了角色目录并选中 ui-worker；第 14 轮通过（证据 .bb-spec/.cache/m9/acceptance-sol61/ui-worker-2026-10-02T17-15-22-144Z/report.json、tasks.json） | 无 |

## 当前阻塞

无。

## 下一窗口续接提示

```
项目：/Users/bb/.bb-spec/worktrees/pi-spec-bb-spec-rebuild（分支 bb-spec-rebuild，只做本地提交，不推送）。
M8H 的 AC1 已通过，AC2 并入 M9。先完整读 AGENTS.md 与 SQLITE-KNOWLEDGE-REBUILD-PLAN.md（M8F、M8G、M8H、M9 章节与 §13），再读 M9-STATUS.md，核对 git status 与最近提交，然后回 M9：重跑 AC12、AC13。
验证入口：pnpm run typecheck；pnpm test；pnpm run test:integration；pnpm run test:installation。
```
