# M8I 状态

阶段目标：界面任务在没有浏览器的情况下不再因"视觉没验证"反复返工；用户裁决"再给一次机会"后，PM 修改任务说明不会让这次机会丢掉。

范围与非目标：按计划 M8I 一节。不给任何角色配浏览器工具；不做截图比对或像素级核对；调整范围与终止这两种裁决的规则不变。

验证方法：AC1、AC2 有对应测试；`pnpm run typecheck`、`pnpm test`、`pnpm run test:integration` 通过。

性能指标：不适用。

停止条件：出现 AGENTS.md「停止规则」任一情况。

起因（用户 2026-10-02 决定）：M9-AC13 真实模型验收第 10、11 轮，QA 或 reviewer 把"浏览器里的实际渲染"列为未验证，触发上报或返工，worker 还去尝试启动 Chrome；第 11 轮用户再给一次机会后，PM 先修改任务说明再派出，程序报"任务已用完重试机会"，再上报又被拒，流程卡死（证据 .bb-spec/.cache/m9/acceptance-sol61/ 下 ui-worker-2026-10-02T14-18-43-296Z 与 ui-worker-2026-10-02T14-43-35-419Z）。原先的规则是"再给一次机会只用于裁决时的任务版本"，本阶段按用户决定改为随任务修改带到新版本，对应的旧测试已替换。

## AC 状态表

| AC | 状态 | 证据 | 剩余缺口 |
|---|---|---|---|
| AC1 三份角色说明写明没有浏览器时的核对方式 | 通过 | tests/prototype.test.ts「M8E-AC4」里的 M8I-AC1 断言 | 无 |
| AC2 用户再给一次机会后 PM 修改任务再派出，按用户上限派出成功，用过即失效 | 通过 | tests/adjudication.test.ts「M8I-AC2」（先失败后通过） | 无 |
| AC3 真实模型验收并入 M9-AC13 | 通过 | M9-AC13 第 14 轮：两个界面任务的实现各一次完成、审查各一次通过、QA 完成，没有因浏览器视觉未验证返工或上报（证据 .bb-spec/.cache/m9/acceptance-sol61/ui-worker-2026-10-02T17-15-22-144Z） | 第 13 轮 worker 把浏览器渲染列成未验证项，已由 b73e356 改 worker 说明 |

## 当前阻塞

无。

## 下一窗口续接提示

```
项目：/Users/bb/.bb-spec/worktrees/pi-spec-bb-spec-rebuild（分支 bb-spec-rebuild，只做本地提交，不推送）。
M8I 的 AC1、AC2 已通过，AC3 并入 M9。先完整读 AGENTS.md 与 SQLITE-KNOWLEDGE-REBUILD-PLAN.md（M8F 到 M8I、M9 章节与 §13），再读 M9-STATUS.md，核对 git status 与最近提交，然后回 M9：重跑 AC12、AC13。
验证入口：pnpm run typecheck；pnpm test；pnpm run test:integration；pnpm run test:installation。
```
