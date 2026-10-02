# M8F 状态

阶段目标：安装包自带的 7 份定义都写明用哪个模型，不再跟主会话的模型走。解释器和草稿核验器用 gpt-6-luna 加 medium 思考，pm、worker、reviewer、qa、explore 用 gpt-6.1-sol。定义里的 model 可以只写模型名。

范围与非目标：按计划 M8F 一节。不改各角色的提示词、工具与权限；不改 60 秒的内部调用时限；不自动安装或下载模型配置。

验证方法：每条 AC 有对应测试；`pnpm run typecheck`、`pnpm test`、`pnpm run test:integration`、`pnpm run test:installation` 全绿。类型检查不包含 `tests/`，改过的测试文件实际运行确认。

性能指标：不适用。

停止条件：出现 AGENTS.md「停止规则」任一情况。

用户 2026-10-02 的决定（已写入计划 M8F 一节）：7 份包内定义全部写明模型，不带提供方前缀；解释器与草稿核验器都用 gpt-6-luna 加 medium；只写模型名、本机多个提供方有同名模型时，优先主会话所在的提供方，否则报错并列出候选。起因：主会话用 gpt-6.1-sol 时，解释器沿用它并按模型默认强度思考，一次回答约 57 秒，重答被 60 秒时限掐断，批准登记不上（证据 .bb-spec/.cache/m9/acceptance-sol61/ui-worker-2026-10-02T08-21-29-838Z/side-calls.json）。

## AC 状态表

| AC | 状态 | 证据 | 剩余缺口 |
|---|---|---|---|
| AC1 只写模型名时的查找规则，派子代理与内部调用两处都覆盖 | 未开始 | 无 | 全部 |
| AC2 包内 7 份定义写明模型；零自定义时运行记录与内部调用用对应模型；本机没有时明确失败 | 未开始 | 无 | 全部 |
| AC3 用户层同名定义覆盖；不写 model 仍跟主会话 | 未开始 | 无 | 全部 |
| AC4 README 写明默认模型与前提；typecheck 与单元、集成、安装测试全绿 | 未开始 | 无 | 全部 |
| AC5 真实模型验收并入 M9-AC12、AC13 | 不在本阶段运行 | 无 | M9 重跑 |

## 当前阻塞

无。

## 下一窗口续接提示

```
项目：/Users/bb/.bb-spec/worktrees/pi-spec-bb-spec-rebuild（分支 bb-spec-rebuild，只做本地提交，不推送）。
先完整读 AGENTS.md 与 SQLITE-KNOWLEDGE-REBUILD-PLAN.md 的 M8F 一节，再读 M8F-STATUS.md，核对 git status 与最近提交，从 AC 状态表里第一条未通过的继续。
M8F 完成后回 M9：重跑 AC12、AC13（验收脚手架的改动在 tests/acceptance/ 下，尚未提交，等真实运行验证后再提交）。
验证入口：pnpm run typecheck；pnpm test；pnpm run test:integration；pnpm run test:installation。
```
