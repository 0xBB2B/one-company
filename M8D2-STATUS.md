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
| AC2 子代理上下文含启动时用户级与项目 AGENTS.md 的磁盘内容，文件不存在照常启动 | 通过 | 本提交；tests/pm-dispatch.test.ts「M8D2-AC2」（PM 上下文含用户级与项目 AGENTS.md 磁盘内容并标明来源，用户级在前；两份都没有时照常启动）、tests/task-dispatch.test.ts「M8D2-AC2」（worker 读到启动时的内容，文件改动后派出的 reviewer 读到新内容） | 两份 AGENTS.md 发给全部子代理，含 QA 与 explore；用户级路径取数据目录的上一级，即 ~/.pi/agent |
| AC3 三选弹窗：写入才写，不写入或无界面不写，修改意见交回主窗口，确认期间磁盘被改则拒绝，与预览一致 | 通过 | 3e4217a 与本提交；tests/project-manage-tool.test.ts「M8D2-AC3」两条（经真实渲染的窗口：选写入才写、不写入与 Esc 与无界面不写、修改意见原话交回且不写、确认期间磁盘被改时拒绝并写明原因、对比对象是磁盘现有内容、标题选项提示行与预览一致）、tests/question-window.test.ts「M8D2-AC3」两条（其他一行直接输入、空内容回车不提交、离开后文字保留、Esc 取消、多选题空格是输入、名称可指定）；预览 .bb-spec/.cache/ui-preview/m8d2-conventions-window.html 于 2026-10-01 经用户确认 | 与预览无差异。提问窗口的其他一行改为直接输入，与 M8D 确认的提问窗口预览不同，是用户 2026-10-01 的要求 |
| AC4 主窗口 edit、write 写仓库根 AGENTS.md 被拒并提示改用 conventions-update，子代理写入保护不变 | 通过 | 本提交；tests/conventions-guard.test.ts「M8D2-AC4」三条（edit、write 写仓库根 AGENTS.md 被拒并提示 conventions-update，含相对路径、绝对路径、@ 前缀、小写文件名、经符号链接；读取与写其他文件放行；子代理受控写入仍把 AGENTS.md 归为不可写）、tests/legacy-workflow-retired.test.ts（主会话 tool_call 拦截点为三处） | 无 |
| AC5 确认版存储、conventions-status、不一致提示删干净，typecheck 与单元、集成、安装测试全绿 | 通过（剩余 2 条单元失败经用户 2026-10-01 决定按本机环境问题处理，不改代码） | 36858a8：确认版存储、conventions-status、派 PM 的不一致提示及其测试已删除，rules/01 第 9 条、README「规范」一节、计划工具权限表已更新；typecheck 通过，集成 56、安装 11 通过（1 个需 Docker 跳过），单元全量 2434 条里 2431 通过、3 条失败，其中 1 条（主会话 tool_call 拦截点数量断言）已改并单独重跑通过 | 单元还剩 2 条失败，都与本阶段改动无关，在本阶段开工前的基线 639b4f7 上单独运行同样失败：tests/database-initialization.test.ts「真实读锁阻挡 WAL 切换」（耗时 11.4 秒，上限 7.5 秒）、tests/helpers/project-index-installed-fixture.test.ts「databaseRows：真实SQLite锁超过5000ms」（write EPIPE）。原因是本机睡眠定时变慢：睡 10 毫秒 20 次应为 200 毫秒，实测 513 到 777 毫秒，Node 与 Python 一致；SQLite 等锁按名义睡眠时间累计，名义 5 秒实际 9 到 11 秒。系统为什么放慢定时没有查清。机器定时恢复正常后重跑这两条确认 |
| AC6 真实模型验收并入 M9-AC12 | 通过 | M9-AC12（2026-10-03，主会话 5x/gpt-6.1-sol）：首条消息里的规范经三选弹窗选"写入"后写进 AGENTS.md；交付源码里导出的常量全是大写加下划线；reviewer 结论写明按该规范核对过（证据 .bb-spec/.cache/m9/acceptance-sol61/zero-custom-2026-10-02T17-44-18-713Z/report.json 的 dialogs 与 conventions、runs 下 reviewer 的会话） | 无 |

## 当前阻塞

无。M8D2 已收口。

## 下一窗口续接提示

```
项目：/Users/bb/.bb-spec/worktrees/pi-spec-bb-spec-rebuild（分支 bb-spec-rebuild，只做本地提交，不推送）。
M8D2 已完成。先完整读 AGENTS.md 与 SQLITE-KNOWLEDGE-REBUILD-PLAN.md 的 M8E 一节，核对 git status 与最近提交，再开始 M8E；之后恢复 M9（重跑 AC12、AC13，AC12 含 M8D2-AC6 的规范分流场景：首条消息里的规范经三选弹窗写入 AGENTS.md）。
界面改动必须先做 HTML 预览（放 .bb-spec/.cache/ui-preview/，终端界面用 HTML 模拟 80 列终端），用户说"可以"后才写实现代码。
本机睡眠定时偏慢时，tests/database-initialization.test.ts 与 tests/helpers/project-index-installed-fixture.test.ts 各有 1 条等锁计时测试会失败，与代码无关；先用 python3 测一下睡 10 毫秒 20 次的实际用时再判断。
验证入口：pnpm run typecheck；pnpm test；pnpm run test:integration；pnpm run test:installation。类型检查不包含 tests/ 下的文件，改测试文件后要实际运行确认。
```
