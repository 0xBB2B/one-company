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
| AC1 只写模型名时的查找规则，派子代理与内部调用两处都覆盖 | 通过 | tests/model-ref.test.ts 三条（查找函数：优先主会话提供方、本机唯一、多个时列出候选、找不到、"提供方/模型名"与模型名里带斜杠照常解析；派子代理与内部调用各一条，经真实的定义读取与解析） | 无 |
| AC2 包内 7 份定义写明模型；零自定义时运行记录与内部调用用对应模型；本机没有时明确失败 | 通过 | tests/role-catalog.test.ts「M8F-AC2」两条（7 份定义的 model 与 thinking）；tests/zero-custom-loop.test.ts（零自定义闭环里每个运行记录的模型都是 gpt-6.1-sol）；tests/internal-model.test.ts「M8F-AC2」两条（内部调用用 gpt-6-luna 加 medium；本机没有该模型时报错、不改用主会话模型）；tests/model-ref.test.ts（子代理定义写的模型找不到时拒绝） | 无 |
| AC3 用户层同名定义覆盖；不写 model 仍跟主会话 | 通过 | tests/internal-model.test.ts「M8D-AC8、M8F-AC3」；tests/model-ref.test.ts（不写 model 的 worker 定义用派出方的模型） | 无 |
| AC4 README 写明默认模型与前提；typecheck 与单元、集成、安装测试全绿 | 通过 | README「角色定义」一节；typecheck 通过；单元 2446 条里 2444 通过，集成 56 条里 55 通过，安装 11 通过（1 个需 Docker 跳过） | 没通过的 3 条都是计时类：两条 SQLite 等锁计时、一条 tests/integration/network-and-sleep.test.ts，后者单独重跑通过。本机 python3 睡 10 毫秒 20 次实测 738 到 1195 毫秒（应为 200） |
| AC5 真实模型验收并入 M9-AC12、AC13 | 不在本阶段运行 | 无 | M9 重跑 |

## 当前阻塞

无。

测试里的假提供方（tests/helpers/controlled-provider.ts）除了用例指定的模型名，还挂了 gpt-6.1-sol 与 gpt-6-luna 两个模型名，零自定义的派工与内部调用才能落到脚本化回复上。pi 自带的模型清单里有多个提供方都有 gpt-6-luna，主会话不在其中任何一个提供方、本机又没有唯一来源时，解释器会报"多个提供方都有"并列出候选。

## 下一窗口续接提示

```
项目：/Users/bb/.bb-spec/worktrees/pi-spec-bb-spec-rebuild（分支 bb-spec-rebuild，只做本地提交，不推送）。
M8F 的 AC1 到 AC4 已通过，AC5 并入 M9。先完整读 AGENTS.md 与 SQLITE-KNOWLEDGE-REBUILD-PLAN.md（M8F、M9 章节与 §13），再读 M9-STATUS.md，核对 git status 与最近提交，然后回 M9：重跑 AC12、AC13（验收脚手架的改动在 tests/acceptance/ 下，尚未提交，等真实运行验证后再提交）。
验证入口：pnpm run typecheck；pnpm test；pnpm run test:integration；pnpm run test:installation。
```
