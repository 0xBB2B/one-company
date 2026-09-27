# M8A 状态

阶段目标：永久移除 docs/spec 规则体系，项目当前行为以代码、测试与已完成需求的归档为准；产品托管项目中 worker 新增或修改的函数、方法、类、类型/接口与导出常量写说明注释（参照 Go 官方库写法），代理用 grep 等命令搜索注释与代码；注释不入库。

## AC 状态表

| AC | 状态 | 证据 | 剩余缺口 |
|---|---|---|---|
| AC1 产品中无 spec 工具、模块、表、指纹字段与流程；核心工具 10 个；角色与主会话规则不提 spec；已有 docs/spec 文件按普通文件对待 | 未开始 | 无 | 全部 |
| AC2 检查轮、正式验证、审查、QA、完成报告、关闭与交付在无规则集指纹时按原门槛工作；四套测试全绿 | 未开始 | 无 | 全部 |
| AC3 worker/reviewer 定义含说明注释规则；新基线上真实模型零自定义闭环通过，新定义带说明，审查覆盖此项 | 未开始 | 无 | 全部 |
| AC4 计划正文与 M9 验收项去除 spec 内容 | 已完成待提交 | 计划改写（本次提交） | 无 |

## 当前阻塞

无。另有一项范围外待用户回复：PM 接手核对结果里 M4 遗留的 executionEnabled 与 scheduling 字段是否清理（记录在 M9-STATUS.md）。

## 下一窗口续接提示

```
项目：/Users/bb/.bb-spec/worktrees/pi-spec-bb-spec-rebuild（分支 bb-spec-rebuild，不推送）。
先完整读 AGENTS.md 与 SQLITE-KNOWLEDGE-REBUILD-PLAN.md（§4 与 §12 的 M8A、M9），再读 M8A-STATUS.md 与 M9-STATUS.md，核对 git status 与最近提交。M0–M8 已收口；M9 暂停，当前执行 M8A。
M8A 用户已定：spec 整个拆掉（工具、模块、规则表、规则集指纹、候选与发布、初始化校验、知识查询规则事实、开检查轮的机械冲突检查、独立校验脚本与 resources/spec）；已有 docs/spec 文件按普通文件；注释规则只管产品托管项目，覆盖函数、方法、类、类型/接口、导出常量，Go 官方库写法；注释不入库，靠 grep；审查把关，程序不设注释门槛。
验证入口：pnpm run typecheck；pnpm test；pnpm run test:integration；pnpm run test:installation；真实模型闭环 pnpm run test:acceptance（见 M9-STATUS.md 的运行方式）。
```
