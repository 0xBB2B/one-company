# M8G 状态

阶段目标：主代理修改需求草稿时，草稿核验器同时拿到上一版已保存的草稿，只核这次改动的部分，不再把原有内容当成用户没说过的要求拒掉。

范围与非目标：按计划 M8G 一节。不改批准时解释器的流程；不把用户在提问窗口里的回答另行存档；不改 60 秒时限与输入大小上限。

验证方法：AC1 有对应测试；`pnpm run typecheck`、`pnpm test`、`pnpm run test:integration` 通过。

性能指标：不适用。

停止条件：出现 AGENTS.md「停止规则」任一情况。

起因（用户 2026-10-02 决定按"把上一版草稿也交给核验器"处理）：M9-AC13 真实模型验收里，用户在提问窗口选了答案后，主代理把答案写回草稿被核验器拒绝，理由是草稿里原有的内容"当前输入没有支持"。核验器当时只拿到当前这一句输入和整份新草稿，分不清新旧。6 轮验收里有 2 轮撞上，核验器用 gpt-6.1-sol 和 gpt-6-luna 各一次（证据 .bb-spec/.cache/m9/acceptance-sol61/ 下 ui-worker-2026-10-02T08-21-29-838Z 与 ui-worker-2026-10-02T11-12-15-378Z 的 main-session.json）。

## AC 状态表

| AC | 状态 | 证据 | 剩余缺口 |
|---|---|---|---|
| AC1 修改草稿时核验器输入带上一版草稿，提示词写明只核改动的部分；新建草稿时没有上一版；原有测试全部通过 | 通过 | tests/main-requirement-interaction.test.ts「M8G-AC1」；该文件 41 条全部通过 | 无 |
| AC2 真实模型验收并入 M9-AC12、AC13 | 通过 | M9-AC13 第 14 轮：用户在提问窗口选了答案后，主代理把答案写回草稿一次保存成功，随后批准登记成功（证据 .bb-spec/.cache/m9/acceptance-sol61/ui-worker-2026-10-02T17-15-22-144Z/main-session.json、side-calls.json）；AC12 这一轮主代理没有提问 | 无 |

## 当前阻塞

无。

## 下一窗口续接提示

```
项目：/Users/bb/.bb-spec/worktrees/pi-spec-bb-spec-rebuild（分支 bb-spec-rebuild，只做本地提交，不推送）。
M8G 的 AC1 已通过，AC2 并入 M9。先完整读 AGENTS.md 与 SQLITE-KNOWLEDGE-REBUILD-PLAN.md（M8F、M8G、M9 章节与 §13），再读 M9-STATUS.md，核对 git status 与最近提交，然后回 M9：重跑 AC12、AC13。
验证入口：pnpm run typecheck；pnpm test；pnpm run test:integration；pnpm run test:installation。
```
