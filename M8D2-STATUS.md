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
| AC5 确认版存储、conventions-status、不一致提示删干净，typecheck 与单元、集成、安装测试全绿 | 未通过 | 本提交：确认版存储、conventions-status、派 PM 的不一致提示及其测试已删除，rules/01 第 9 条、README「规范」一节、计划工具权限表已更新；typecheck 通过，集成 56、安装 11 通过（1 个需 Docker 跳过），单元全量 2434 条里 2431 通过、3 条失败，其中 1 条（主会话 tool_call 拦截点数量断言）已改并单独重跑通过 | 单元还剩 2 条失败，都与本阶段改动无关，在本阶段开工前的基线 639b4f7 上单独运行同样失败：tests/database-initialization.test.ts「真实读锁阻挡 WAL 切换」（耗时 11.4 秒，上限 7.5 秒）、tests/helpers/project-index-installed-fixture.test.ts「databaseRows：真实SQLite锁超过5000ms」（write EPIPE）。等用户决定怎么处理 |
| AC6 真实模型验收并入 M9-AC12 | 不在本阶段运行 | 无 | M9 重跑；本阶段只把验收宿主对新弹窗的自动选择改成"写入" |

## 当前阻塞

单元测试有 2 条与 SQLite 锁等待时间有关的失败，在基线 639b4f7 上同样失败，不是本阶段引入的，也不在本阶段范围内。AC5 要求全量测试全绿，所以 M8D2 还不能算完成，等用户决定：单独修这两条，还是确认它们是本机环境问题。

## 下一窗口续接提示

```
项目：/Users/bb/.bb-spec/worktrees/pi-spec-bb-spec-rebuild（分支 bb-spec-rebuild，只做本地提交，不推送）。
当前阶段 M8D2。先完整读 AGENTS.md 与 SQLITE-KNOWLEDGE-REBUILD-PLAN.md 的 M8D2 一节，再读本文件，核对 git status 与最近提交。AC1 到 AC4 已通过；AC5 只差单元测试里 2 条与本阶段无关的 SQLite 锁等待失败，先问用户怎么处理，不要自行扩修。M8D2 之后是 M8E，最后恢复 M9（重跑 AC12 时含 M8D2-AC6 的规范分流场景）。
验证入口：pnpm run typecheck；pnpm test；pnpm run test:integration；pnpm run test:installation。类型检查不包含 tests/ 下的文件，改测试文件后要实际运行确认。
```
