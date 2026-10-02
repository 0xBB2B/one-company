# M8J 状态

阶段目标：解释器第一次回答没通过程序核对时，重答能在时限内答完。默认时限由 60 秒改为 120 秒。

范围与非目标：按计划 M8J 一节。草稿核验器的 60 秒时限不变；不改重答次数；不改解释器的模型与思考等级；不改时限的 120 秒硬上限。

验证方法：AC1 有对应测试；`pnpm run typecheck`、`pnpm test`、`pnpm run test:integration` 通过。

性能指标：最坏情况下批准要等接近 2 分钟；正常情况不变。

停止条件：出现 AGENTS.md「停止规则」任一情况。

起因（用户 2026-10-03 决定）：M9-AC13 真实模型验收第 12 轮，三次批准都没登记上，后两次报"解读被取消"。最近有记录的 6 轮里解释器共调用 13 次，4 次被 60 秒时限掐断（证据 .bb-spec/.cache/m9/acceptance-sol61/ui-worker-2026-10-02T16-05-31-092Z/side-calls.json）。

## AC 状态表

| AC | 状态 | 证据 | 剩余缺口 |
|---|---|---|---|
| AC1 解释器不指定时限时，过了 60 秒仍在等，到 120 秒才取消 | 通过 | tests/user-interaction.test.ts「M8J-AC1」（先失败后通过） | 无 |
| AC2 真实模型验收并入 M9-AC12、AC13 | 通过 | 2026-10-03 第 13、14 轮 AC13 与 AC12 的批准都是一次登记成功，解释器调用没有被时限掐断（证据 .bb-spec/.cache/m9/acceptance-sol61/zero-custom-2026-10-02T17-44-18-713Z/side-calls.json、.bb-spec/.cache/m9/acceptance-sol61/ui-worker-2026-10-02T17-15-22-144Z/side-calls.json） | 无 |

## 当前阻塞

无。

## 下一窗口续接提示

```
项目：/Users/bb/.bb-spec/worktrees/pi-spec-bb-spec-rebuild（分支 bb-spec-rebuild，只做本地提交，不推送）。
M8J 的 AC1 已通过，AC2 并入 M9。先完整读 AGENTS.md 与 SQLITE-KNOWLEDGE-REBUILD-PLAN.md（M8F 到 M8J、M9 章节与 §13），再读 M9-STATUS.md，核对 git status 与最近提交，然后回 M9：重跑 AC12、AC13。
验证入口：pnpm run typecheck；pnpm test；pnpm run test:integration；pnpm run test:installation。
```
