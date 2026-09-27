# M8A 状态

阶段目标：永久移除 docs/spec 规则体系，项目当前行为以代码、测试与已完成需求的归档为准；产品托管项目中 worker 新增或修改的函数、方法、类、类型/接口与导出常量写说明注释（参照 Go 官方库写法），代理用 grep 等命令搜索注释与代码；注释不入库。

## AC 状态表

| AC | 状态 | 证据 | 剩余缺口 |
|---|---|---|---|
| AC1 产品中无 spec 工具、模块、表、指纹字段与流程；核心工具 10 个；角色与主会话规则不提 spec；已有 docs/spec 文件按普通文件对待 | 通过 | a86df70（工具与流程层）、8a63e09（索引层）；tests/core-permissions.test.ts（10 个工具、schema 与权限表双向一致、docs/spec 可写）、tests/role-catalog.test.ts（定义不提 spec）、tests/verification-run.test.ts（调试命令可写 docs/spec）、tests/project-index-policy.test.ts 与 tests/project-index-service.test.ts（docs/spec 按 config 建索引）；产品代码中已无 spec 相关引用 | 无 |
| AC2 检查轮、正式验证、审查、QA、完成报告、关闭与交付在无规则集指纹时按原门槛工作；四套测试全绿 | 通过 | typecheck 通过；全部测试 158 个文件、2397 通过 1 跳过（.bb-spec/.cache/m8a/step2-final.txt）；旧 data.db 被拒用例在 tests/database-storage.test.ts | 无 |
| AC3 worker/reviewer 定义含说明注释规则；新基线上真实模型零自定义闭环通过，新定义带说明，审查覆盖此项 | 进行中 | 定义与测试：4ad1fc5、463c818、18abe67（tests/role-catalog.test.ts）；第 39—41 轮 worker 均按 Go 写法写了说明注释，第 40、41 轮审查结论写明注释核对结果（证据 .bb-spec/.cache/m9/acceptance/zero-custom-2026-09-27T14-52-57-273Z、…T15-02-12-337Z）；第 41 轮因 PM 把测试拆成单独任务卡住，已按 AC5 修 | 待先红后绿落地后重跑闭环通过 |
| AC4 计划正文与 M9 验收项去除 spec 内容 | 通过 | 1ea1a60 | 无 |
| AC5 worker/PM/reviewer 定义含先红后绿规则；reviewer 只读被审尝试引用的验证记录 | 通过 | 本次提交；tests/role-catalog.test.ts（三处规则）、tests/verification-run.test.ts（reviewer 读引用记录、读不到未引用和别的尝试、不能停止、QA 不能读） | 无 |

## 当前阻塞

无。另有一项范围外待用户回复：PM 接手核对结果里 M4 遗留的 executionEnabled 与 scheduling 字段是否清理（记录在 M9-STATUS.md）。

## 下一窗口续接提示

```
项目：/Users/bb/.bb-spec/worktrees/pi-spec-bb-spec-rebuild（分支 bb-spec-rebuild，不推送）。
先完整读 AGENTS.md 与 SQLITE-KNOWLEDGE-REBUILD-PLAN.md（§4 与 §12 的 M8A、M9），再读 M8A-STATUS.md 与 M9-STATUS.md，核对 git status 与最近提交。M0–M8 已收口；M9 暂停，当前执行 M8A。
M8A 用户已定：worker 按 TDD 先红后绿，测试与实现同一任务，reviewer 只读被审尝试引用的验证记录核对红绿（§8.9 第 8 条）；spec 整个拆掉（工具、模块、规则表、规则集指纹、候选与发布、初始化校验、知识查询规则事实、开检查轮的机械冲突检查、独立校验脚本与 resources/spec）；已有 docs/spec 文件按普通文件；注释规则只管产品托管项目，覆盖函数、方法、类、类型/接口、导出常量，Go 官方库写法；注释不入库，靠 grep；审查把关，程序不设注释门槛。
验证入口：pnpm run typecheck；pnpm test；pnpm run test:integration；pnpm run test:installation；真实模型闭环 pnpm run test:acceptance（见 M9-STATUS.md 的运行方式）。
```
