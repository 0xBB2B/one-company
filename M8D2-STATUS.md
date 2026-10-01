# M8D2 状态

阶段目标：插件自带的规范分三层（`shared/` 主窗口和子代理共用、`rules/` 只给主窗口、`agents/` 只给子代理）；子代理启动时直接读取用户级和项目 AGENTS.md 的磁盘内容；用户提出的长期规范经三选弹窗确认后写入项目 AGENTS.md；删除确认版存储。

范围与非目标：按计划 M8D2 一节。不拦 `bash` 写 AGENTS.md，不读上级目录的 AGENTS.md，不改主窗口读取 AGENTS.md 的方式，不写用户级 AGENTS.md。

验证方法：每条 AC 有对应测试；`pnpm run typecheck`、`pnpm test`、`pnpm run test:integration`、`pnpm run test:installation` 全绿。类型检查不包含 `tests/`，改过的测试文件实际运行确认。

性能指标：不适用。

停止条件：出现 AGENTS.md「停止规则」任一情况；弹窗预览未经用户确认前不写弹窗实现代码。

## AC 状态表

| AC | 状态 | 证据 | 剩余缺口 |
|---|---|---|---|
| AC1 主窗口含共享规范与主窗口规范，子代理含共享规范与角色说明、不含主窗口规范，角色文件无重复搜索范围说明 | 通过 | 本提交；tests/rules-extension.test.ts「M8D2-AC1」（主窗口按顺序含六条主窗口规范与三条共享规范）、tests/agent-session.test.ts「M8D2-AC1」（子代理含共享规范，位于角色说明之后、本次任务之前，不含主窗口规范）、tests/role-catalog.test.ts「M8D2-AC1」（角色说明不再含搜索范围）、tests/package-skeleton.test.ts（发布文件含 shared） | 全量测试在 AC5 收口时一并跑 |
| AC2 子代理上下文含启动时用户级与项目 AGENTS.md 的磁盘内容，文件不存在照常启动 | 未开始 | 无 | 无 |
| AC3 三选弹窗：写入才写，不写入或无界面不写，修改意见交回主窗口，确认期间磁盘被改则拒绝，与预览一致 | 未开始 | 无 | 预览 .bb-spec/.cache/ui-preview/m8d2-conventions-window.html 待用户确认 |
| AC4 主窗口 edit、write 写仓库根 AGENTS.md 被拒并提示改用 conventions-update，子代理写入保护不变 | 未开始 | 无 | 无 |
| AC5 确认版存储、conventions-status、不一致提示删干净，typecheck 与单元、集成、安装测试全绿 | 未开始 | 无 | 无 |
| AC6 真实模型验收并入 M9-AC12 | 不在本阶段运行 | 无 | M9 重跑；本阶段只把验收宿主对新弹窗的自动选择改成"写入" |

## 当前阻塞

弹窗 HTML 预览待用户确认，确认前不写 AC3 的实现代码。AC1、AC2、AC4、AC5 不受影响。

## 下一窗口续接提示

```
项目：/Users/bb/.bb-spec/worktrees/pi-spec-bb-spec-rebuild（分支 bb-spec-rebuild，只做本地提交，不推送）。
当前阶段 M8D2。先完整读 AGENTS.md 与 SQLITE-KNOWLEDGE-REBUILD-PLAN.md 的 M8D2 一节，再读本文件，核对 git status 与最近提交，从状态表里第一条未通过的 AC 接着做。M8D2 之后是 M8E，最后恢复 M9。
弹窗预览在 .bb-spec/.cache/ui-preview/m8d2-conventions-window.html，用户说"可以"后才写 AC3 的实现代码，实现后逐项对照。
弹窗用 runtime/question-window.ts 的通用问答窗口，不用 ctx.ui.confirm 或 ctx.ui.select。
验证入口：pnpm run typecheck；pnpm test；pnpm run test:integration；pnpm run test:installation。类型检查不包含 tests/ 下的文件，改测试文件后要实际运行确认。
```
