# ARCHITECTURE.md

> 项目大纲：有哪些模块、各在哪、怎么协作。只写不常变的内容，代码细节以代码为准。由 /doc-update 维护。

## 项目做什么

OneCompany 是 pi（一个终端里的编码代理）的扩展包。用户在 pi 的对话窗口里和主代理（用户正在对话的那个 pi 会话）把需求说清楚、批准，后台的 PM 代理把需求拆成任务，派 worker 写代码、reviewer 审查、QA 验收，最后在需求自己的 Git 分支里提交。给想让代理按"先确认需求、再按计划实施"流程干活的开发者用。

## 整体设计

程序分两个进程跑：

- **主窗口扩展**：pi 启动时加载 `src/app/extension/index.ts`，在主窗口里注册工具、命令、状态面板和程序窗口。
- **守护进程**：在后台持续运行代理的 Node 进程，每个仓库一个，同一仓库的多个 worktree 共用。打开主窗口时自动启动，空闲 10 分钟后自己退出；它跑的代码和安装目录里的不一样时，由新打开的窗口在它空闲时换成新的。PM、worker、reviewer、qa、explore（只读查资料的检索代理）、原型设计师这些代理会话都跑在守护进程里，主窗口关掉也不影响它们。

两边通过数据根目录下 `sock/` 里的 Unix 套接字通信，消息格式在 `src/core/host/protocol.ts`。为什么这样分：代理一跑就是几十分钟，不能跟着某个窗口的生死走；多个窗口还要看到同一份需求状态。

源码按"下层不能引用上层"排成三层，顺序以 `tests/module-dependencies.test.ts` 里的 `MODULE_DIRS` 清单为准：

1. `src/core/`：底层能力（规则、外部命令、存储、主窗口与守护进程的通信），不知道任何业务。
2. `src/modules/`：一个功能一个目录，只能引用排在自己前面的模块。
3. `src/app/`：组装层，把模块接到 pi 入口和守护进程上，本身不放业务逻辑。

仓库根上的 `agents/`、`rules/`、`role-rules/`、`shared/`、`skills/`、`resources/` 不是代码，是程序运行时读取的素材：角色定义、给代理的规矩、语法解析资源。`examples/` 是 Go、Vue 设计规范样例，`/one:examples` 把它们复制到用户层或项目层。

## 模块地图

从下层到上层排列。

| 模块 | 职责 | 目录 | 关键文件 / 类型 |
|---|---|---|---|
| policy | 内容和权限规则、时钟、文字清洗 | `src/core/policy` | `core-permissions.ts`、`clock.ts` |
| exec | 外部命令的报错格式、读 git、目标分支、origin 主机与本机 gh / glab 登录记录、git 快照、分支保护、安装前检查 git | `src/core/exec` | `tool-failure.ts`、`git-read.ts`、`target-branch.ts`、`git-host.ts`、`git-prerequisite.mjs` |
| storage | 本机 SQLite 数据库、数据根目录、仓库身份、操作日志、旧版本库的迁移执行（备份、在一次事务里跑上层注入的转换步骤） | `src/core/storage` | `database.ts`、`data-root.ts`、`identity.ts`、`database-migration.ts` |
| host | 主窗口生命周期、守护进程客户端和通信格式、守护进程过旧时换新、拉起守护进程前的旧库迁移框、程序窗口、底部面板、后台 shell 登记表、断网暂停 | `src/core/host` | `extension-lifecycle.ts`、`daemon-client.ts`（`connectDaemon`）、`protocol.ts`、`code-fingerprint.ts`、`upgrade-notice.ts`、`database-migration-prompt.ts`（`createBeforeSpawn`） |
| agents | 角色定义的查找与复制、模型引用、职责规矩、MCP、检索排除、子代理会话、会话和运行记录、步骤簿（守护进程内存里按运行记下子代理的每次工具调用） | `src/modules/agents` | `agent-session.ts`（`createAgentRoleSession`）、`roles.ts`、`run-store.ts`、`run-steps.ts`（`RunStepBook`） |
| requirement | 需求草稿与正文存储、批准清单（记下这一版正文的每一段、每个允许的动作分别由哪些决定确认）、需求状态、事件、备份恢复、短决定（对话里做出的决定，用户说的或模型提议的，归纳成一句结论加适用范围记下来）、主窗口授权、原型记录及其旧版本格式的转换步骤 | `src/modules/requirement` | `RequirementService`、`RequirementStateStore`、`prd-storage.ts`、`approval-manifest.ts`、`prototype-record-migration.ts` |
| prototype | 派原型设计师、"确认原型"窗口 | `src/modules/prototype` | `prototype-extension.ts`、`prototype-windows.ts` |
| verification | 检查轮（所有 worker 任务审查通过后，PM 开的最后一轮全量测试和 QA 验收）、worker 改动的应用、写入保护、命令边界、项目规范（AGENTS.md）写入 | `src/modules/verification` | `CheckRoundService`、`change-apply.ts`、`write-guard.ts` |
| explore | 只读检索的约定、派发、会话、联网，以及主窗口的 `one_company_agent_manage` 工具 | `src/modules/explore` | `agent-manage-extension.ts`、`explore-dispatch.ts`、`web-access.ts` |
| settings | `/one:setting` 设置页、模型设定、PM 和内部代理用哪个模型、角色定义的开关、Git 交付档位和合并方式；`/one:examples` 把设计规范样例复制到用户层或项目层 | `src/modules/settings` | `settings-page-ui.ts`、`agent-settings.ts`、`internal-model.ts`、`examples-extension.ts`（`openExamplesPage`）、`spec-examples.ts` |
| pm | 计划、派工、PM 提交与同步目标分支、PM 接手复核、需求读取工具、验证命令、子代理交结果 | `src/modules/pm` | `plan-manage.ts`、`task-dispatch.ts`、`PmIntakeService`、`pm-commit.ts`、`result-submit.ts` |
| delivery | 关闭需求与归档提交、需求流程管理、Git 交付（远程：推送、建 PR/MR、合并；仅本地：合进主仓库当前分支）、需求工作区（worktree）管理 | `src/modules/delivery` | `RequirementCloseService`、`archive-commit.ts`、`workflow-manage.ts`、`git-delivery.ts`（`deliverRequirement`）、`local-delivery.ts`（`deliverLocally`）、`WorkspaceManageService` |
| panel | 状态面板、步骤窗口（在面板选中子代理按 Enter 弹出，列出它做过的每一步）、PM 概览、⚑ 事项（面板上等用户处理的事）的决策包（打开事项时插进对话、供主代理查原因的材料）、裁决（用户对上报事项做的决定，比如任务两次没完成时怎么办） | `src/modules/panel` | `pm-panel.ts`、`step-window.ts`、`pm-overview.ts`、`adjudication.ts` |
| interaction | 主代理提问窗口、解读用户原话、主窗口的需求交互、@需求补全、`one_company_requirement_manage` 工具 | `src/modules/interaction` | `MainRequirementInteraction`、`user-interaction-model.ts`、`requirement-manage-tool.ts` |
| project-index | 项目索引、语法解析、知识查询、`one_company_project_manage` 和 `one_company_knowledge_query` 工具 | `src/modules/project-index` | `project-index-service.ts`、`knowledge-query.ts`、`syntax-parser.ts`、`project-manage-tool.ts` |
| shell | `/one:ps` 页面、后台 shell 工具、shell 摘要 | `src/modules/shell` | `shell-page.ts`、`shell-bash.ts` |
| app/extension | pi 入口、命令注册、主会话规则注入 | `src/app/extension` | `index.ts`、`commands.ts`、`rules.ts` |
| app/daemon | 守护进程启动、加载器、生命周期、运行管理、PM 工具组装、通信服务端、请求参数校验表、项目索引在守护进程里的宿主 | `src/app/daemon` | `main.ts`、`lifecycle.ts`（`startDaemon`）、`RunManager`、`pm-tools.ts`、`method-params.ts`、`ProjectIndexHost` |

## 关键流程

### 主窗口连上守护进程

pi 加载 `src/app/extension/index.ts` → host：会话开始时 `lifecycleExtension` 用 `WorkspaceClients` 连接工作区里每个仓库的守护进程，连不上时先由 `createBeforeSpawn` 读这个仓库 `data.db`、`index.db` 的版本，有可迁移的旧版本就弹迁移框，用户选迁移后经 storage 的 `migrateRepositoryDatabases` 备份并转换（转换步骤由 app/extension 从 requirement 注入），再用 `src/app/daemon/bootstrap.mjs` 拉起新进程 → app/daemon：`main.ts` 校验 SDK 版本后调 `startDaemon` → `startDaemon` 依次建 `DaemonServer`、`ProjectIndexHost`、`RunManager`，登记各请求方法，启动空闲退出计时 `IdleExit` → 主窗口先发 `upgrade.check` 问守护进程代码是否过旧（与启动时记下的 `codeFingerprint` 比较）：过旧且空闲就发 `upgrade.yield` 让它退出、再拉起新的；过旧但在忙就每 30 秒再查 → 主窗口发 `hello` 握手后开始调用。

### 一个需求从提出到交付

1. 草稿：主代理调 `one_company_requirement_manage`（interaction：`createRequirementManageTool`）→ requirement：`RequirementService` 把正文存进需求自己的本机 Git 仓库（`prd-storage.ts`）。涉及界面时，主代理先调 `one_company_prototype`，守护进程派原型设计师，用户在"确认原型"窗口里拍板（prototype）。
2. 批准：用户说"批准" → interaction：用户这句话没 @ 到需求、或需求带原型草稿时，`MainRequirementInteraction` 先弹"批准需求"窗口，让用户亲手确认批准的是哪个需求 → 解释器（把用户原话解读成正式决定的内部模型调用，`createPiInteractionInterpreter`）解读原话 → `UserInteractionCore` 用 requirement 的 `createApprovalManifest` 生成批准清单 → `MainRequirementInteraction` 用 `ApprovalManifestStore` 把清单登记下来。
3. 派 PM：主代理调 `one_company_agent_manage` → 守护进程方法 `agents.dispatchPm` → app/daemon：`RunManager` 用 agents 的 `createAgentRoleSession` 起 PM 会话，工具由 `createPmTools` 组装。
4. 接手复核：PM 先交它对需求的理解 → pm：`PmIntakeService` 存档，主代理核对通过后 PM 才能写计划。
5. 规划与派工：PM 用 `plan-manage.ts` 写计划和任务 → `RunManager.dispatchTask` 按任务派 worker、reviewer、qa，派审查时整轮派（按 pm 的 `reviewRoundMembers` 算出本轮名单，同时派出通用审查和专项审查），本轮开始后也能单独重派或临时加审查，整轮结束才判定 → 子代理用 `result-submit.ts` 交结果，worker 的改动经 verification 的 `change-apply.ts` 核对写入范围后应用 → PM 用 `pm-commit.ts` 在需求分支里提交。
6. 检查与关闭：verification：`CheckRoundService` 管最终检查轮，进入前 pm：`syncTargetBranch` 把需求分支同步到目标分支 → 用户验收后 delivery：`RequirementCloseService` 关闭需求，写归档并用 `commitArchive` 提交进需求分支。
7. 交付：主代理调交付工具，按设置里的 Git 交付档位分流：delivery：远程档位 `deliverRequirement` 推送、建或复用 PR/MR 并按用户选的方式合并；仅本地档位 `deliverLocally` 在本机合进主仓库当前分支。之后 `WorkspaceManageService` 回收工作区时，按"再合一次不带来任何改动"判断已合并。

### 查询项目索引

代理调 `one_company_knowledge_query` → 守护进程方法 `knowledge.query` → app/daemon：`ProjectIndexHost` 先检查哪些文件变了、增量重建 → project-index：`knowledge-query.ts` 查 `index.db` 返回结果。

## 数据表

字段以 `src/core/storage/database.ts`（建表）和 `src/core/storage/database-recovery.ts`（恢复副本）为准。数据库都在数据根目录（默认 `~/.pi/agent/one-company/`）下，不在业务仓库里。

| 表 | 用途 | 关键关系 |
|---|---|---|
| `records` | 当前状态，按"命名空间 + 键"存一份最新的 JSON，带版本号 | 三个库都有；`data.db` 里存需求、运行、计划、对话、决定等，`global.db` 里存守护进程凭证和主窗口 shell 登记，`index.db` 里存索引条目 |
| `events` | 按流编号追加的事件 | 三个库都有；`data.db` 里是需求状态变化和对话里的短决定，`index.db` 里是索引事件 |
| `index_schema_metadata` | 索引库的结构版本 | 只在 `index.db` |
| `source_fragments_fts` | 源码片段的全文检索表，靠触发器跟 `records` 里的源码片段同步 | 只在 `index.db` |
| `recovery_reconciliation` | 从备份恢复出的副本里，每个需求的核对结果，恢复出的需求一律不可直接执行 | 只在恢复副本的 `data.db` |

## 守护进程方法

主窗口和守护进程之间不是 HTTP，是套接字上的请求方法。参数以 `src/app/daemon/method-params.ts` 为准。

| 方法前缀 | 所属模块 | 用途 |
|---|---|---|
| `hello`、`ping`、`shutdown` | app/daemon | 握手、探活、请求退出 |
| `upgrade.*` | app/daemon | 握手前也能调用：查守护进程代码是否过旧、在忙什么，过旧且空闲时让它退出 |
| `agents.*`、`runs.*` | app/daemon（`RunManager`） | 派 PM 和检索，查看、暂停、恢复、停止运行，查子代理的步骤 |
| `pm.*` | app/daemon → panel、pm | 面板概览、⚑ 事项的决策包、转话给 PM |
| `explore.*` | app/daemon → explore | 主窗口派出的检索列表和结果 |
| `prototypes.*` | app/daemon → prototype、requirement | 派原型设计师、列出和确认原型 |
| `workflow.*` | app/daemon → delivery | 需求流程管理：推进阶段、检查轮、上报、关闭需求 |
| `shells.*` | app/daemon → host、shell | 列出和停止守护进程里的 shell 任务 |
| `index.*`、`knowledge.*` | app/daemon（`ProjectIndexHost`）→ project-index | 索引的初始化、状态、刷新与知识查询 |

## 公共机制

- **给模型看的报错**：外部命令和工具的失败统一用 `src/core/exec/tool-failure.ts` 转成"哪一步失败、为什么、下一步怎么做"。
- **代理会话**：所有角色的会话都由 `createAgentRoleSession`（`src/modules/agents/agent-session.ts`）创建，统一挂上职责规矩、写入范围检查、MCP 和模型请求重试。
- **规矩注入**：包内这几个目录的文件都由 `src/modules/agents/package-rules.ts` 读取。主代理的提示词由 `src/app/extension/rules.ts` 加上 `rules/` 和 `shared/`；子代理的提示词由 `buildAgentPrompt` 拼成"角色定义正文 + `role-rules/` 里对应职责的规矩 + `shared/`"（专项审查用 `role-rules/reviewer-specialist.md`），定义里点名的 `skills/` 全文拼进任务说明；派通用 reviewer 时，被审 worker 加载、但本任务专项审查都没覆盖的 skill 也拼进去。
- **数据根目录**：由 `src/core/storage/data-root.ts` 决定，设了 `PI_CODING_AGENT_DIR` 时放在它下面的 `one-company/`；仓库身份和套接字路径在 `src/core/storage/identity.ts`。
- **断网暂停**：`src/core/host/network-pause.ts` 给模型请求的失败分类，断网时暂停运行，联网后由用户在面板上按 p 恢复；模型请求超时不算断网，交给 SDK 重试。
