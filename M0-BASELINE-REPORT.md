# M0 基线与能力分析

**当前阶段已进入M1，实施状态见 `M1-IMPLEMENTATION-REPORT.md`。本文件保留M0及BUG修复的历史输入、结果与限制，§14的通过记录不等于M1已完成。**

§1–10 保留首次 M0 调研时的基线、失败和待裁决记录；§11 保留此前解析资源补齐时的实现和验收证据。这些历史结果仍按原输入、运行时和计划版本保存，不代表 §12 的Node/pnpm要求已经实现或通过。

## 1. 首轮结论与执行边界

本报告是框架改造的 M0 检查结果，不是业务需求 prod，也不是另一套 spec/plan/task。唯一完整需求和验收依据仍是 `SQLITE-KNOWLEDGE-REBUILD-PLAN.md`。

文中 hash 是内容指纹，schema 是数据格式约束，epoch 是权限代次，outbox 是先登记再投递的事件队列，ABI 是解析器与语法资源之间的接口版本；探针/夹具指独立最小验证程序与测试材料，不代表产品功能。

**M0 调研和独立最小验证已经执行；不能宣布所有验收项及产品能力已经通过。** 当前存在数据库并发启动失败、异步事务连接未失效、用户决策来源可伪填、会话正文入库和自有指纹扫描未排除 prod 等缺口。没有开始 M1，没有修补生产代码或削弱测试。

- 工作区：`/Users/bb/.bb-spec/worktrees/pi-spec-bb-spec-rebuild`。
- 分支：`bb-spec-rebuild`。
- 检查基线 HEAD：`e55dc24b502d20e58b95b7b2ffa5add9e2899bdd`。
- 计划 SHA-256：`a86673d7ea5b2d5fc4806dd4c85e48207b28e941fa051b467ae208afbe77e21a`。
- 计划共 1,579 行，依次读取 1–180、181–360、361–530、531–700、701–870、871–1040、1041–1200、1201–1370、1371–1579，共九段连续覆盖全文，并额外复核 M0/M1 原文。
- 开始时 `git status --short` 和 `git diff --stat` 均为空。仓库及祖先没有额外的 AGENTS/CLAUDE/override 指令文件；全局 `/Users/bb/.pi/agent/AGENTS.md` 已核对。
- 根目录没有 `.codegraph/`，未初始化或依赖 CodeGraph。
- 未读取已删除资料、删除 diff 正文、历史提交中的旧资料、备份或真实本机数据库。
- 仅新增本报告；未改计划、源码、测试、依赖或锁文件。未暂存、业务 commit、push、创建 PR 或发布。独立 Git 探针的提交只存在于临时夹具。

## 2. 对目标架构的理解

目标是分开四类权威：活动 prod 表达本需求目标，`docs/spec` 表达当前可复用规则，代码表达实际实现，数据库与真实输出表达运行和验证事实。它们不能互相冒充证明。

活动 prod 在业务工作区及所有开发 worktree 之外，每个 UUIDv7 需求一个独立本机 Git，只跟踪 `prod.md`。本机提交是保存正文，不是批准或完成。需求服务在 Git 保存核对成功后，以短同步事务登记批准提交、hash、状态和事件；完整提交对的 diff 驱动唯一 PM 逐任务复核，不全量重置无关成果。最终归档只有 completed 的固定最终正文，文件名为 `<UUIDv7>.<需求描述>.md`；UUID 是身份，不是完成证明，也不是跨机器严格执行顺序。

`data.db` 保存需求、PM、plan/task、决策、授权、事件和证据元数据；`index.db` 保存可重建当前索引；`global.db` 保存全局设置。prod 全文、diff、详细摘要、完整会话和原始输出不入库。决策只允许短结论和必要范围，不增加原话存档或任意语义防还原系统。

主代理通过受控 action 创建、绑定和回收分支/worktree；PM 与子代理只能在 ready 且身份匹配的现场工作。不同需求不共用分支或工作目录。PM 接管提高 fencing token，即让旧持有者的令牌失效，防止旧进程继续写入。

正式检查等待本轮所有 worker 与写入型子进程真正结束。检查阶段禁止产品管理的输入写入，记录输入清单、环境和指纹；外部修改通过监听和指纹发现后使结果失效，不强制复制完整源码或依赖。新批准更新由 PM 决定 interrupt/defer；原检查目标不变，停止未完成不释放锁，pending 更新或 unknown 影响阻止关闭。旧验证输入不改写，适用性另存复核。

关闭按预检、复核后进入 closing、撤权与安全结束、closed 登记、固定通知与受限归档执行。取消/拒绝不算完成，不自动回滚文件。普通重启、索引重建、旧备份恢复分开处理；归档仅能触发风险核对，没有可信历史就不续接旧执行权限。

首版严格按 A 边界：专用入口关闭拒读，自有查询和新加载上下文排除 prod；普通 read/Shell/Git 历史/MCP 全覆盖读取拦截暂缓。主会话只建议清空，不自动清空或强制暂停，也不宣称模型已忘记。已有沙箱、真实路径、写入范围和管理接口保护必须保留。

## 3. 当前实现：复用与改造

| 当前路径 | 可复用基础 | 必须改变或补齐 |
|---|---|---|
| `runtime/database.ts` | Node/Bun SQLite 驱动、UUIDv7 安全随机源、WAL/FULL、版本条件更新、同步事务正常提交/回滚 | `.sqlite` 到 `.db` 受控切换；独立索引库；专用模型及字段白名单；异步违规立即使连接失效；并发初始化及一致性备份 |
| `runtime/identity.ts` | Git commonDir、真实路径、仓库/worktree 发现、本机权限 | 需求身份仍是日期加 slug；补 UUIDv7 请求幂等、workspaceId/分支绑定、dataRoot 必须位于所有业务现场之外的真实路径检查 |
| `runtime/daemon-auth.ts`、`daemon/server.ts` | 控制令牌保存在受保护目录；hello 使用等长比较核验令牌 | 每次业务 action 绑定可信角色、需求状态、epoch、租约与范围，不能只靠窗口身份 |
| `daemon/lifecycle.ts`、`daemon/main.ts` | 一个仓库一个 daemon、socket 竞争、空闲退出、休眠处理、重启恢复 | 并发启动基线有失败；现有恢复不是关闭生命周期及旧备份分级恢复 |
| `runtime/git-snapshot.ts` | 字节指纹、未跟踪内容、链接不解引用、变化检测 | 普通内容指纹默认读所有已跟踪/未忽略文件；没有默认目录级 `docs/prod` 排除。不能原样用于新索引或恢复扫描 |
| `runtime/ranges.ts`、`range-protection.ts`、`write-guard.ts` | 范围占用、真实路径越界拒绝、外部变化失效、后台 Shell 未结束时保留保护 | 绑定需求/worktree/阶段令牌；统一约束 change/spec/生成命令；不能用旧共享工作区范围锁代替独立 PM 现场 |
| `runtime/command-boundary.ts`、`shell-bash.ts`、`shell-registry.ts` | macOS 沙箱、受控输出目录、子进程登记和停止确认、数据库目录禁止访问 | 正式检查只读输入及独立输出；prod 内部存储的限定 Git 写权限；无后端平台继续拒绝 |
| `runtime/delivery.ts`、`result.ts` | 结构化结果、真实复跑、输入匹配、测试映射核对 | 当前依赖任务 Markdown、`.pi-company/spec`、`requirements.md`，并要求相关改动已提交；需换成新目标/规则/任务元数据与 debug/formal 证据，移除业务 commit 前置 |
| `runtime/workflow-state.ts`、`workflow-tool.ts` | 版本、依赖、阶段证据、有限返修与过期检查 | 当前 accepted 等阶段不是 draft/active/closing/closed；新增更新逐任务复核、pending、checkRound、关闭与恢复协议，避免两套冲突状态机 |
| `runtime/decisions.ts`、`decision-record-tool.ts` | 追加记录、主体区分、修订关系、回执 hash | 主入口允许自填 user；没有结论/范围大小限制，字段包含 trigger/详细解释。旧记录不能自动升级可信授权 |
| `runtime/session-records.ts` | 会话分支及中断结构校验的经验 | 覆写 `SessionManager._persist` 后把完整 entry 写进 DB events。需正文文件存储、元数据引用、关闭先拒绝恢复；不能照搬当前适配器 |
| `daemon/requirement-agent.ts`、`role-session.ts`、`run-manager.ts` | 管理代理、多角色派工、暂停/停止确认、级联停止、事件传递 | 新 PM 唯一性及绑定、精确 prod diff、关闭后不续接；现有完成通知和终态登记没有新的关闭门槛；收尾不能只删除 Map 条目 |
| `extensions/relay.ts`、`daemon/relay-queue.ts` | 持久通知、重连积压投递、去重、`pi.sendMessage` | 队列只存元数据，通知只能由可信关闭事实产生；不能把任意中继文字当成用户批准或已完成 |
| `agents/`、`skills/`、`rules/`、扩展注册 | 角色定义、资源加载、运行时上下文组装 | 旧文件式流程和工具权限要重构；QA 输入从旧规则切换为活动 prod；默认业务 Git 技能与提交工具外置 |

当前没有独立 prompts 目录，`package.json` 已为 `"prompts": []`；不需要为了“取消模板层”删除必要上下文组装代码。`skills/git-commit`、`skills/git-push` 仍随 `./skills` 默认加载，`extensions/write-protection.ts` 和角色创建路径注册业务 Git 提交工具。

实际安装产物由 SDK 加载后注册 **9 个工具名，含替代的 bash**：`decision_record`、`pi_company_workflow`、`pi_company_dispatch`、`pi_company_review`、`pi_company_reply`、`pi_company_forward`、`pi_company_agents`、`bash`、`pi_company_git_commit`。这不是目标的 11 个核心业务工具；PM 会话还有单独的旧管理工具。

## 4. 目标 11 工具与角色 action 边界

以下是计划对应的实现目标，不是当前工具已具有这些权限。主=主代理，规=planner，工=worker，审=reviewer，验=QA；所有许可仍要逐次核验状态、绑定、授权、版本与令牌。

| 工具 | 角色与 action 分工 |
|---|---|
| `project_manage` | 主：init/status/refresh/recovery-check/backup/restore/workspace-prepare/workspace-recycle；只有主能创建、绑定、回收现场 |
| `knowledge_query` | 主、PM、规、工、审：只读当前允许资料；不查 prod 正文，工限本任务 |
| `requirement_manage` | 主：create/updateDraft/confirmUpdate/read/diff/metadata；PM、规、审、验：仅获授权活动 read/diff/metadata；draft 不给子角色；工仅经派工接收获准片段 |
| `plan_manage` | PM：propose/read/update/confirm/assess-update；规：草案 propose/read/update，不能自行批准；审：read |
| `agent_manage` | 主：启动/控制 PM；PM：在绑定现场 dispatch/status/pause/resume/stop 子角色；无越级或跨需求派工 |
| `user_interact` | 主、PM：ask/reply/forward 和受控短决策；user 主体不能来自模型传参，AI 选择不冒充用户决定 |
| `change_apply` | 工：绑定任务范围的代码/测试/配置变更；禁止 prod、归档、spec、DB |
| `spec_change` | 规：propose/validate；PM：propose/validate，满足批准/证据/阶段条件才 publish |
| `verification_run` | PM、工、审、验：各自允许的检查/结果查询；工做 debug，最终 formal 要先确认 worker 与写入全部收尾；停止权限按本轮运行绑定 |
| `result_submit` | 规、工、审、验：提交其职责内事实；不是模型自填 PASS 即通过 |
| `workflow_manage` | 主：获授权的管理、状态、关闭和交付动作；PM：绑定需求的 init/status/advance/finish/repair/close/delivery-check；普通更新的 check-decision 只给有效 PM |

不得补第 12 个工具、任意 SQL、自由用户批准入口或通用 Git action。旧工具别名不能绕过新门槛。M1 可只接通已安全完成的动作，其余明确拒绝；不能提前暴露所有写入，再等 M5 补权限。

## 5. 宿主实证与安全缺口

### 5.1 实际宿主

全局安装与项目依赖的 pi SDK 均为 **0.85.1**。已完整阅读实际安装的 README、`docs/extensions.md`、`docs/sdk.md`、`docs/packages.md`、`docs/session-format.md`、`docs/sessions.md`、`docs/compaction.md`，并读取工具、扩展、会话、输入事件和权限 gate 官方示例及相关实际实现。

关键实际路径：

- `dist/core/agent-session.js:584`：`dispose()` 请求中止并释放监听，但不是等待工具退出的完成证明。
- 同文件 `:1195`：`clearQueue()`；`:1222`：`abort()` 等待 idle。配合产品自己的 Shell/子运行收尾，可以实现“停止请求”和“停止完成”分离。
- 同文件 `:843`、`:1187`：input 来源含 interactive/extension；直接 SDK 调用默认 interactive，因此还必须约束可信调用入口，不能仅看消息 role 或任意 source 字段。
- `daemon/role-session.ts:866–985`：暂停/停止核对 activeTools、prompting、Shell 结果。`stop()` 有超时且可能返回 `stopped:false`，新关闭协议必须保留拒读并等待，不可当成功。
- `daemon/run-manager.ts:863–910`：级联停止返回 confirmed；`:1226–1277`：当前完成结算及通知来自 run 终态，不是新需求 closed 事务。
- `extensions/relay.ts:151–157`：`pi.sendMessage` 能向主会话注入通知；不代表历史已清空。

独立 Node SDK 探针在禁止联网的系统沙箱中实际证明：tool_call 阻止工具执行；一个忽略中止信号、延迟 180ms 的工具运行时，abort 在 25ms 后仍未完成，待工具结束后才完成；新建 SessionManager 不继承旧输入哨兵；固定提醒进入新会话模型请求；input 区分 interactive/extension。模型由本地受控 provider 替代，没有真实云模型调用。这些证明宿主机制可用，不是产品关闭集成已通过。

### 5.2 已实测的不符合项

1. **异步事务迟到写入：确定存在。** `runtime/database.ts:97–111` 只检测 thenable、ROLLBACK，未封禁连接。Node 和 Bun 分别覆盖 async 回调、普通 Promise 返回、thenable：事务前写入回滚，但等待实际延续和定时回调后，另一连接读到 after/timer/reused 三条记录和 after 事件，旧连接还能开新事务。六种组合均不满足 M1-AC10。正常同步提交和异常回滚对照均通过。未测试清理失败、迟到拒绝处理、连接池自动重试等 M1-AC11 全矩阵。
2. **自填用户身份：确定存在。** 临时仓库调用未绑定的 `createDecisionRecordTool`，没有真实用户交互也接受 `actor:user`；绑定 PM 的同一请求会拒绝。位置为 `runtime/decision-record-tool.ts:62`，限制仅覆盖 boundRequirement；主入口 `extensions/decision-record.ts` 不带此绑定。中继回复也须重核对来源，不可作为当然可信的替代入口。
3. **自有内容扫描未排除归档：确定存在。** 临时 `docs/prod/<UUID>.夹具.md` 仅改变正文，`collectContentFingerprint` 就变化。位置为 `runtime/git-snapshot.ts:156–171`。这是自有扫描的缺口，不是计划暂缓的通用工具旁路；M1/M2 需要在读正文前按目录排除。
4. **会话正文入 SQLite：源码确定。** `runtime/session-records.ts:26–38` 把整个 SessionEntry 追加到 events。M0 未读取真实存量会话，也未迁移它们。
5. **并发 daemon 基线失败：见 §7。** `daemon/lifecycle.ts` 在获取 listener 所有权前调用 `controlToken`，涉及共享库打开/初始化；与观测到的 database is locked 相符，但完整根因与修复尚未验证，不能只增加重试或吞掉异常。

## 6. M0 协议细化与安装选择

这些是供确认的 M0 实现基线；未写入生产 schema 或擅自修改总计划。用户确认后由 M1 正式落地并测试。

### 6.1 格式与算法

- prod：UTF-8 Markdown；开头只放必要 UUIDv7/title 元数据；正文段落与场景用稳定 ID。保存实际字节 hash，不做 Git clean/换行转换。归档描述仅为安全单文件名部分，关闭前登记固定路径；不短前缀匹配 UUID。
- spec：沿用 §4.3 schemaVersion=1、feature、rules 的 JSON 结构；字段白名单、重复 JSON 键拒绝、ID 唯一、引用无悬空/循环；不根据 `$schema` 自动联网。
- 码点统计对 JSON 解码后的字符串使用 `Array.from(text).length`，不是 UTF-16 length。计入规则 title/condition/trigger/expected/reason、全部验收 given/when/then，以及对该规则生效的 feature 标题/别名等自然语言上下文；任何自然语言例外字段都计入。只有经严格格式校验的纯 ID/hash/引用不计。共享字段不能成为藏长正文的地方。
- 单条最多 1,500 码点、6 场景；超限拒绝并要求拆分，不截断。独立职责判断还需要语义审查；机械计数不能证明职责单一。
- hash 规范化：对象键按固定非 locale 排序，数组保留顺序，区分 null/缺字段，不 trim 或隐式 Unicode NFC 转换，不忽略语义字段。contractHash 覆盖规则及必要 feature/schema/依赖上下文；规则集合按完整 ID 排序并纳入必要 schema/config 变化。依赖指纹按无环图计算，不只记录依赖 ID。路径/定位刷新不复活旧正文。
- 决策建议限额：结论 400 码点、范围 400 码点、最多 16 个纯引用、单引用 ID 最长 128 个 ASCII 字符、一次最多 20 条、完整请求最多 64KiB UTF-8。限制同时生效，不能按每条上限推导整个批次必然允许。存储字段只用计划白名单；拒绝未知字段、正文/patch/附件/任意 JSON/BLOB，不接受文件载荷。拒绝时保留真实限制，不截断授权。
- §5.3 手机号登录三个短决定例子的结论/范围分别为 23/13、18/25、14/18 码点，能保留“只分析”“委托代理”“实施不含提交发布”等边界。Node/Bun 各执行 31 个计数、hash 与限额检查，包含 1499/1500/1501、6/7、399/400/401、16/17 引用、128/129 引用长度、20/21 批量、65535/65536/65537 请求字节，以及 emoji 转义。生产完整 schema、重复键解析及用户授权校验不在这 31 项证明范围内。

生命周期、分级恢复、PM 独立工作区、debug/formal、检查互斥、interrupt/defer、局部影响复核均按总计划 §5.5–5.9、§6.5、§8.6–8.7、§11.6 落地，不新增不可变输入副本门槛、主会话清空门槛或跨记录防还原系统。

### 6.2 Tree-sitter 实测版本与资源

| 官方 npm 包 | 固定候选版本 | 实测语法 ABI | 许可 |
|---|---|---|---|
| `web-tree-sitter` | 0.27.0 | 文档支持 13–15；本轮实测 14/15 | MIT |
| `tree-sitter-typescript` | 0.23.2 | TS、TSX：14 | MIT |
| `tree-sitter-javascript` | 0.25.0 | JS、JSX：15 | MIT |
| `tree-sitter-go` | 0.25.0 | Go：15 | MIT |

通过 Context7 核对官方 API，再读取实际 npm 包 README、package.json 和打包文件清单。使用已有发行 WASM，未安装或运行 tree-sitter CLI、CodeGraph、node-gyp 或语法编译器。

WASM SHA-256：

```text
runtime c03bccdc3b448a32848f5ae327e209c982bbb0840d43eec8bc2d5759544a1ed3
TS      778025db5a8be0e70f8ccc3671e486dfeddd048c25d9e8a70c26de2e1bf6f97d
TSX     79e5da75ea62855a0cd67177685f0164eac87d5f630b3cbe1e0a099751ad30f8
JS/JSX  5fb488d0cabb4775a594bab85682de5ad6ce83c0d6ac997a9f82dd084d571240
Go      9504573f352b20be7f2f1911754d710622aedc15afff16d5ed8fb5645681aee7
```

独立安装夹具只打包官方运行时 JS/WASM、四份语法 WASM、许可证和版本信息，资源按模块自身路径定位。从 tarball 解包到安装目录，经真实 `pi install <绝对路径>` 登记，cwd 为 `/`，系统沙箱 `deny network*` 下 Node/Bun 都解析 TS/TSX/JS/JSX/Go；校验函数/JSX 节点、名称、注释不误认、中文/emoji/CRLF 和源码切片范围。缺运行时或语法资源均明确 ENOENT，fetch 探针调用数为 0。单次全部五夹具约 Node 13ms、Bun 14ms，只是最小样本，不是项目性能指标。

**安装风险：** 三个语法 npm 包含 `install: node-gyp-build`，TypeScript 包还带另一版 JavaScript 依赖。建议产品随包放入所需已构建 WASM/许可证/清单，只将固定版本 web-tree-sitter 用作运行时依赖，不把全部原生语法包直接作为安装时构建链。此选择待确认；本轮没有改变项目依赖。

当前项目 tarball 能在独立 pi 配置中登记并由实际 SDK 离线加载扩展入口，9 个现有工具注册无错误；**该真实产品 tarball 尚无解析资源或解析入口**。独立资源夹具的成功不能说成产品的一次安装解析已经交付。

### 6.3 本机 Git 最小验证

使用生产 `gitExecutable()` 对应的 Xcode Git：`/Applications/Xcode.app/Contents/Developer/usr/bin/git`，版本 2.50.1；不是仅使用 PATH 中的 Homebrew Git 2.55.0。

独立 Node 26.8.2 程序在临时需求目录执行固定流程：

```text
init --template=<空目录> --initial-branch=main
hash-object -w --no-filters --stdin
update-index --add --cacheinfo 100644 <blob> prod.md
write-tree
commit-tree <tree> [-p <完整父提交>]
update-ref HEAD <完整提交> <预期父提交或空引用>
cat-file blob <完整提交>:prod.md
diff --no-ext-diff --no-textconv <准确from> <准确to> -- prod.md
```

使用固定内部身份 `pi-company-prod-store <prod-store@localhost>` 和计划的 commit message/Operation-Id/Prod-Hash。同字节保存复用提交；两次不同正文只生成两次提交。逐步核对提交树仅 prod.md、落盘和提交字节相等、SHA-256、准确 diff 和父提交条件。

清空继承的 Git 配置环境，屏蔽系统/全局配置，关闭 hooks/fsmonitor/签名/换行转换/协议，系统沙箱禁止联网及执行 Git 以外程序。用可执行 hook、filter、textconv、external diff、签名和 fsmonitor 探针验证无副作用；先单独证明探针能落标记，再验证正常存储没有标记。额外 Git helper 执行被沙箱拒绝，无 remote，临时全局配置和需求库配置字节保持一致，没有真实用户全局 Git 身份也能运行。Git 路径不存在返回 ENOENT，不跳过提交。

探针首次因空模板不生成 `.git/info/` 而报 ENOENT，补齐独立夹具目录后通过；未修改产品或放宽断言。该程序不是持久操作日志、崩溃恢复、授权或 requirement_manage 的实现，不能用于宣称 M1-AC12/14 已通过。

## 7. 验证命令、结果与限制

### 7.1 独立环境

只复制当前 `git ls-files` 列出的现存文件和本机 node_modules 到 `/tmp/m0.OXdY2D/src`，没有复制 `.git` 或历史。这样现有测试的 `temporaryRoot()` 在副本的 `.pi-company/.cache` 创建缓存，不污染目标工作区。HOME、测试临时目录、pi 配置、SQLite、Git、安装、日志和 npm 下载缓存均在该独立根下；部分工具另外生成了默认编译缓存，按 §10 的来源核对后清理。依赖下载仅限官方 npm 资源，无安装脚本执行；离线探针使用系统禁止联网。未运行浏览器或真实业务服务。

环境：macOS 26.6.2（25G83），arm64，Apple M5 Pro，内存 68,719,476,736 字节（64GiB），Node v26.8.2，Bun 1.3.14，pi SDK 0.85.1。工作区所在磁盘容量约 1.8TiB、可用约 956GiB；未进一步识别硬盘型号或清理系统页缓存。原工作区 185 个跟踪文件、2,947,674 字节，其中 153 个 TS/JS 类源码文件。

### 7.2 实际命令

命令在独立副本运行，PATH 保留本机工具位置，其他继承环境由 `env -i` 清除：

```bash
bun run typecheck
bun test tests
bun run test:integration
npm pack --ignore-scripts --pack-destination <临时packs> --json
npm pack --ignore-scripts --json web-tree-sitter@0.27.0
npm pack --ignore-scripts --json tree-sitter-typescript@0.23.2
npm pack --ignore-scripts --json tree-sitter-javascript@0.25.0
npm pack --ignore-scripts --json tree-sitter-go@0.25.0
node <pi实际安装目录>/dist/cli.js install <临时解包目录>
node database-probe.mjs       # 另以 bun 执行
node boundary-probe.mjs
node git-probe.mjs
node format-probe.mjs         # 另以 bun 执行
sandbox-exec -p '(version 1)(allow default)(deny network*)' node <安装夹具>/parser-probe.mjs valid
# 同时执行 Bun；分别测试 missing-runtime / missing-grammar
sandbox-exec -p '(version 1)(allow default)(deny network*)' node src/m0-host-probe.mjs
sandbox-exec -p '(version 1)(allow default)(deny network*)' node src/m0-install-probe.mjs
```

| 验证 | 结果 |
|---|---|
| 类型检查 | exit 0 |
| 首次全量 | 240 秒工具超时中断；此前已有 daemon 锁/连接/竞争退出失败；不是完整测试结果，遗留进程已单独停止 |
| 第一轮完整全量 | exit 1，2320 pass / 6 fail，2326 项、69 文件，473.72 秒 |
| 独立集成 | exit 0，43 pass / 0 fail，267 断言、10 文件，80.51 秒；与全量中的集成用例重叠，不能相加成独立覆盖数 |
| 最终中性环境全量 | exit 1，2323 pass / 3 fail，16932 断言、2326 项、69 文件，454.21 秒；三项失败均在 daemon 并发启动/连接路径 |
| Node/Bun 事务负向探针 | 正常同步对照通过；六种异步组合均复现违规后迟到写入与连接重用，不满足目标安全约束 |
| 自有扫描/决策来源探针 | 复现归档正文影响普通指纹及主入口自填 user 被接受；PM 自填 user 拒绝 |
| 本机 Git 存储可行性 | 通过，仅独立探针 |
| 官方解析资源安装夹具 | Node/Bun 离线五语言夹具及缺资源拒绝通过；产品解析入口未实现 |
| 真实产品 tarball 扩展加载 | 通过，仅证明现有扩展加载与注册 |
| SDK 权限/中止/新会话/提醒 | 通过，仅宿主可行性，不是完整产品关闭流程 |
| 格式算法与限额 | Node/Bun 各 31 个最小检查通过；生产校验器未实现 |

第一轮完整全量的 6 项失败：

1. `tests/daemon-client.test.ts:205`：并发 connectDaemon，子进程 database is locked。
2. `tests/daemon-client.test.ts:367`：工作区两个连接，其中一个 unreachable。
3. `tests/daemon-lifecycle.test.ts:163`：并发三启动的退出码收到 1、预期 0。
4. `tests/settings-page.test.ts:216`：非法设置应拒绝却成功。
5. `tests/settings-page.test.ts:437`：MCP 空数组未写到断言检查的库。
6. `tests/role-session.test.ts:2625`：全局 hooksPath 修改应判失败却完成。

第 4/5 项的测试自己切换 HOME，但第一次隔离还设了 PI_CODING_AGENT_DIR，造成读写库不匹配；第 6 项被上层 GIT_CONFIG_GLOBAL=/dev/null 干扰。最终复核只保留独立 HOME/TMPDIR、PATH、PI_OFFLINE/PI_TELEMETRY，移除这些覆盖，**没有修改测试代码或断言**。第一轮失败仍保留在本报告，不当作产品修复成果。

最终中性环境下上述第 4/5/6 项全部通过。仍失败的是 `daemon-client.test.ts:205` 的 database is locked、`:367` 的 unreachable，以及 `daemon-lifecycle.test.ts:134` 的并发双启动退出码 1（预期 0）。并发三启动本轮通过，但前轮失败仍说明该类竞争不稳定，不能据此标成已修复。没有继续以反复重跑挑选全绿结果。

SDK 探针首次收尾调用了实际不存在的 ModelRuntime.dispose，已经根据实际声明换为 unregisterProvider，重新完整执行通过；AgentSession 的 abort/dispose 顺序没有改变。

### 7.3 未验证项

- Node 最低支持版本 22.19、其他 Node 主版本、Linux/Windows 命令安全后端、不同 CPU 平台。
- 产品实际解析/索引入口，完整规则 schema、重复键、引用图和语义冲突判定。
- 新需求真实授权、prod 保存与 DB 之间故障日志、关闭竞争、prod 更新中的 PM interrupt/defer、正式检查阶段互斥、分级恢复、归档、双克隆交付和全部 11 工具集成。
- 真实用户自然语言归纳质量、实际云模型、物理断电及介质损坏。
- 新索引的千文件性能、持久化热复用、FTS 查询、监听 p95、资源长期收敛。不能用最小解析样本替代这些指标。

后续性能夹具建议冻结为 1000 个不同内容文件（600 个 TS/TSX/JS/JSX、300 个 Go、100 个 spec；合计不超过 20MiB），另备 0/1000/10000 个仅身份路径的关闭元数据，禁止读取正文。冷初始化测 5 个独立新库，重启复用 10 次，更新/查询/事件各记录 100 个样本；p95 使用排序后 ceil(0.95×N) 的样本，预热与全量对账单列。冷指新进程/新库，不谎称清空 OS 缓存；模型耗时单列。样本生成器和实际基准尚未实现，不宣称满足 60 秒、2 秒或 500ms 门槛。

## 8. 首轮 M0 验收逐项核对

| ID | 判定 | 实际依据 |
|---|---|---|
| M0-AC1 | **部分完成，产品级未通过** | 独立打包资源在真实 pi 登记的安装目录、cwd=/、Node/Bun 禁网解析五语言成功；当前产品包没有解析资源或入口，不将独立夹具冒充产品 |
| M0-AC2 | **部分完成，产品级未执行** | 独立安装夹具缺资源 ENOENT、不联网、版本/MIT/资源 hash 可追溯；产品的缺资源诊断仍需实现 |
| M0-AC3 | **通过** | 原工作区干净、全程保全；仅新增报告；基线失败、环境干扰和探针自身错误分开记录 |
| M0-AC4 | **通过（分析报告及宿主可行性范围）** | 实际 SDK/产品路径与独立宿主探针、级联停止集成测试支持分析；明确报告当前 prod 排除/生命周期/授权缺口，不虚称完整产品已拦截 |
| M0-AC5 | **通过（格式独立性范围）** | 临时 spec JSON 和人工 Markdown 可由普通 Node 文件 API/JSON.parse 读取；没有给业务入口注入产品依赖；未扩大为任意业务工具链已验证 |
| M0-AC6 | **通过（明确限定为独立可行性）** | 使用生产 Node/Xcode Git、限定参数、内部身份、固定提交及副作用探针，缺 Git 明确失败；不等于 M1 正文工具调用链 |

因此本轮停止于 M0，不把“已完成检查”表述为“M0 全绿”，更不能宣布整个改造完成。

## 9. 首轮阻塞、待裁决与 M1 范围

### 9.1 需要先确定的事项

1. **安装验收归属。** M0-AC1/2 要求实际安装；只有 AC6 明确允许独立程序。当前独立资源安装夹具通过，但产品未接入。建议批准在 M0 范围补齐最小资源分发及安装测试，再验收 AC1/2；或明确允许将产品级验证随后续阶段完成。未经裁决不擅自把独立夹具当成全部通过，也不自行跨入 M2 索引实现。
2. **确认候选版本、资源分发与决策限额。** 采用 §6 的实测组合；WASM/许可证随包、避免语法包安装脚本；短结论/范围 400 码点等限制。未确认前这些只是本报告中的实现基线建议。
3. **既有数据安全边界。** 本轮没有读取真实数据库，无法确认存量版本、活动进程、WAL/SHM 或备份状态。未来真实切换须另行授权，先停写、一致性备份和核对，再受控切换；不能直接改路径后新建空库。
4. **兼容性条件。** 当前 peerDependencies 为 `*`、engines 为 Node >=22.19，实际只测 SDK 0.85.1/Node26.8.2。需在正式安装回归覆盖支持版本，不能默认旧 SDK 的私有持久化接口长期可用。没有命令隔离后端的平台继续阻塞受保护命令，不降级裸跑。

没有发现必须推翻 A 边界、强制清空主会话或恢复不可变输入副本的宿主限制。宿主可以等待中止及创建新会话，但不响应中止的工具可能无限期不能确认结束；这种现场必须保持阻塞，不能以 dispose 或超时放行。

### 9.2 获得下一阶段授权后，M1 的具体修改边界

- `runtime/database.ts` 及数据库测试：优先修复异步违规连接失效、迟到写入、同步原子性、并发初始化与错误清理；新增三个 `.db` 的版本化模型和一致性备份/恢复接口。只用临时旧库验证文件名切换，不操作真实库。
- `runtime/identity.ts`、新共享协议/schema 模块：UUIDv7、请求幂等、prod 元数据/安全归档名、spec 白名单/计数/稳定 hash/引用检查；按批准范围分离生命周期与运行状态。
- 最小 prod 存储模块：仅 create/save/readVersion/diffVersions/verifyVersion；固定 Git、仓库/提交树/字节核对、operationId、未知 HEAD/缺 gitdir 的拒绝与中断恢复。上层需求服务控制批准、状态、事件和读授权。
- `runtime/session-records.ts`、决策与证据存储入口：正文文件加元数据引用；短决定白名单和来源约束；旧数据保全但不自动信任旧用户授权。必须先封住旧入口，不能让旧 decision_record 绕过新接口。
- 需求/managed_workspaces/PM ownership/outbox/recovery 基础：唯一性、版本/epoch/fencing、工作区绑定模型、关闭状态不能重开、旧备份仅恢复数据不恢复权限、归档只读路径风险线索。
- 最小 requirement_manage(create) 安装调用链及必要拒绝门槛，用正式产品测试满足 M1-AC12；不能拿本报告 Git 程序替代。未完成 action 默认拒绝，不提前给代理新写权限。
- 包内 schema/资源路径/许可证和安装检查按用户对 §9.1 的裁决接入。M1 可依赖资源存在性，但不展开 M2 的全量索引、M3 的 watcher、M4 完整查询/交互、M6 整套最终检查关闭调度、M7 角色全面改写或 M8 业务 Git 集成。

M1 前置条件：用户明确授权阶段、裁定 M0 安装未完成项及限额；重新读取 M1 与相关设计/验收，复核 HEAD、计划 hash、工作区及运行占用；保留并发 daemon 失败作为基线修复目标。按 M1-AC1–16 分项提交实际结果，尤其 Node/Bun 的 AC10/11、真实产品安装调用链 AC12、跨文件/Git/DB 故障 AC14，缺项就报告未通过。

## 10. 首轮证据与收尾

本报告保留无业务正文的实际结果、命令、环境、位置和资源指纹。清理前记录的输出 SHA-256 如下；这些指纹用于辨识本轮证据，不代表清理后仍有原日志可供回读：

```text
typecheck       8366207267355d3e3d5bf3bf6e8c94c5f93f6078c34f08973fa2b38cdda6cc92
首轮完整全量     75fabe461f9bef9bd1cb3d76df581e892f6bdd88ec1e3be4791a7a2f0e2be8fe
最终全量         8645da356bd1a42c194c155a316eee11ed981afc1d2ed702b4002a7517399286
独立集成         2e0f3888314d776902e2806d74e9f0acfef4489b6b30ca56fc6024cb1f896f3f
Git 探针         cec59403f58b559053743dc8e827926b4b743472fee7b03966e5682c3d7d6606
事务负向探针     f370f2ce3a101d8b9fbdd242b7caf9e24e5ad8e80257c4192f24c13df9f26866
安装解析夹具     23e352da0ca03c6e604e400d26c9e04a850c2372525ea4f51db1737568d928fb
SDK 宿主探针     228e108a2653883672568d4cbae1741effb76c8b9695ff1ab919969ef3eb464f
```

临时探针不是后续正式回归测试资产；M1 必须将相关场景变为正式测试，不能仅引用本文 PASS。

已清理 `/tmp/m0.OXdY2D`：包括源码/依赖副本、测试 .cache、HOME/agent/data、SQLite/WAL/SHM、会话与日志、Git/归档夹具、npm 下载缓存、tarball、解析资源安装、所有最小程序和输出。

收尾发现 npm/Jiti 还使用了 `/tmp/node-compile-cache`、`/tmp/jiti`。只枚举缓存文件名和创建时间，没有读取缓存正文；在新的独立缓存目录重放相同当前模块的加载，匹配 530 个 Node 缓存和 57 个 Jiti 缓存文件名，并核对创建时间属于本轮，随后清理这些文件及空目录。独立重放目录一并删除。后续最小验证应显式绑定 TMPDIR/NODE_COMPILE_CACHE，避免默认缓存落到共享临时位置。

清理前已结束所有本轮测试进程；`ps` 中没有本轮路径，`lsof` 没有 cwd 留在本轮临时根的进程。清理后上述三个目录均不存在。未停止用户原有进程。

最终自检：只新增本报告，原计划、所有原有跟踪文件及暂存区保持不变；没有生产代码改动，也没有引入孤立 import/变量/函数。报告只陈述实际能力、证据、缺口和待确认事项，不把探针当作产品交付。未 commit/push/PR/发布，未读取或覆盖真实本机数据库。本轮停止于 M0，等待用户裁定未完成项与后续阶段。

## 11. 经批准的 M0 补齐

### 11.1 授权与实际文件

用户批准补齐资源分发、最小内部入口、真实产品安装测试和协议口径。未进入 M1，§5.2 中的数据库、授权、扫描和会话存储缺口未修复。

| 文件 | 当前职责 |
|---|---|
| `package.json`、`bun.lock` | 固定 `web-tree-sitter@0.27.0`，纳入 `resources/tree-sitter`，增加 `test:installation`；锁文件只新增这一依赖，不更新其他包 |
| `resources/tree-sitter/` | 四份官方语法 WASM、四份原始 MIT 许可证、版本/发行包/完整性/字节指纹清单及使用说明 |
| `runtime/syntax-parser.ts` | 内部 `withSyntaxTree(language, source, inspect)`，只接受 ts/tsx/js/jsx/go 和源码字符串，不扫描、不写 DB、不登记工具 |
| `tests/syntax-parser.test.ts`、`tests/fixtures/syntax-cases.json` | 真正解析、Unicode/CRLF 坐标、注释/字符串隔离、语法错误、并发和正常/异常资源释放 |
| `tests/installation/syntax-parser.test.ts`、`tests/helpers/syntax-installation-probe.mjs` | 产品 tarball 安装、pi 路径登记、Node/Bun 禁网解析及失败矩阵 |
| `README.md`、本报告 | 当前解析能力、测试入口、已确认口径及实际验证记录 |

运行时 WASM 来自固定运行依赖，四份语法随产品分发；原始字节和许可证已逐项与官方包核对。没有安装原生语法包、Tree-sitter CLI 或 CodeGraph。

每次调用都按模块/依赖位置读取并核对本机资源 hash、版本和 ABI；缓存不掩盖资源缺失或损坏。每次 Parser/Tree 独立创建，在回调正常返回、同步抛错或异步拒绝后释放；parse 抛错也释放 Parser。官方没有 Language 卸载接口，本模块实例最多缓存四份语法，不缓存源码或树。回调不得保留 Tree/Node/Cursor；自行创建的 copy/query/cursor 仍需调用方释放。初始化/语法加载失败保持失败状态，核对安装后用新进程重试，不自动下载或重初始化损坏实例。

业务工具注册、普通读取工具、写入沙箱、daemon、PM、分支/worktree、数据库路径和恢复流程均未改动。目标工作区原有 node_modules 保持不变；本轮依赖安装与验证全部在独立副本中执行，目标目录首次使用新入口前需正常安装锁定依赖。

### 11.2 已收定的协议与限额

§6.1、§6.2 和 §7.3 的候选值经本次批准固定为后续实现基线，不替代总计划，也不表示完整 spec/决策/性能系统已在 M0 实现：

- 采用 §6.2 精确版本和官方资源指纹；运行时依赖正常安装，语法 WASM/许可证随产品分发，不执行语法包原生安装脚本。
- prod/spec 格式、UUIDv7、正文/元数据边界遵循 §6.1。解码后的自然语言按 `Array.from(text).length` 计数；计入规则适用的 feature 标题/别名及全部验收文字，纯经校验 ID/hash/引用不计；1500 码点、6 场景及语义拆分约束不变。
- hash 对象键采用 JavaScript 无 locale 的 `.sort()` 顺序，数组保持顺序，标量按 JSON 序列化；null 与缺字段不同，不 trim、不隐式 NFC 转换。纳入必要 feature/schema/依赖上下文；集合按完整 ID 排序，文件指纹按实际字节。正式 schema 和引用图在 M1 实现。
- 短决定结论/范围各最多 400 码点；纯引用合计最多 16 个、单引用 ID 最长 128 个 ASCII 字符；一次最多 20 条，完整请求最多 65536 个 UTF-8 字节。限制同时成立，超限拒绝、不截断。主体和授权仍由可信入口核对，不新增原话文件或任意语义防还原系统。
- 生命周期、分级恢复、PM 独立现场、debug/formal、检查互斥、interrupt/defer 和局部影响复核按总计划，不新增不可变副本或强制清空门槛。
- 性能采样固定为 §7.3 的千文件配比、20MiB 上限、关闭元数据规模及样本数量；p95 按排序后 ceil(0.95×N) 取样，保留所有失败，OS 页缓存及模型耗时单列。生成器和实测仍属后续阶段，不虚报已达标。

### 11.3 真实安装验证

不是另造一个解析测试包：直接 `npm pack --offline --ignore-scripts` 当前产品及本机精确依赖，随后用 `npm install --offline --omit=dev --legacy-peer-deps --ignore-scripts` 安装这些 tarball。被测产品位于全新 consumer/node_modules/@0xbb2b/pi-company，解析资源和运行时从该安装现场定位。

通过实际 SDK package.json 的 bin.pi 运行 `pi install <已安装产品路径>`，核对独立设置中的登记。然后使用宿主同类的 Jiti TypeScript 加载器调用安装产物内部入口，分别用 Node/Bun 执行。Jiti 只属于测试基础设施，不是产品新依赖。

全部打包、安装和运行子进程均在 macOS `deny network*` 沙箱中执行。HOME/TMPDIR/pi/npm/Node 缓存独立，Jiti 文件缓存关闭；安装测试只用本机已锁定依赖，不访问 registry。除禁用安装脚本，还断言产品/解析运行时没有 preinstall/install/postinstall，并确认没有原生语法包、node-gyp-build 或 CodeGraph，避免用 ignore-scripts 掩盖隐含编译依赖。

每个安装矩阵实际检查：

- Node/Bun 在 `/` 和包含空格、中文的 cwd 解析 TS/TSX/JS/JSX/Go，故障测试后再验证有效解析，共 6 次有效运行。
- 运行时 WASM 缺失/损坏，四份语法各自缺失/损坏，manifest 缺失/非法 JSON，ABI 声明不符，运行时 package 版本不符，共 14 种 × 2 运行时的失败运行。
- 已加载语法后破坏资源，Node/Bun 各验证下一次调用仍拒绝，共 2 次热缓存失败运行。
- 包内文件、原始许可证、版本/发行包元数据与全部 WASM 指纹；普通业务夹具只用 Node 标准 API 读 JSON/Markdown，没有产品导入或数据库。

拒绝来自产品入口且包含明确错误类别，fetch 计数为零。资源恢复仅由测试 finally 执行，不是产品自动修复。

测试装置开发中有两次失败：require.resolve 无法解析 SDK 的 import-only 导出，改按真实 exports 使用 import.meta.resolve 和 bin.pi；pi 将本机路径保存为相对配置目录的路径，测试按官方语义解析回准确目标后核对。这两次不属于业务功能修复，也没有削弱安全断言。

### 11.4 补齐验证结果

独立副本：`/tmp/m0fix.I5bkge/src`，不含业务 Git 历史。当前 Node v26.8.2、Bun 1.3.14、SDK 0.85.1，平台和硬件同 §7.1。

- `bun install --frozen-lockfile --ignore-scripts`：exit 0，锁文件匹配，未更新其他依赖。
- `bun run typecheck`：exit 0。
- `bun test tests/syntax-parser.test.ts tests/installation tests/package-skeleton.test.ts tests/erasable-syntax.test.ts tests/user-documentation.test.ts`：99 pass / 0 fail，309 expect，8.58 秒。
- `bun test tests`：exit 1，2331 pass / 5 fail，17091 expect，2336 项、71 文件，462.28 秒；新增的 10 项测试全部通过。
- `bun run test:integration`：exit 1，42 pass / 1 fail，261 expect，43 项，80.17 秒。与全量中的用例重叠，不相加为独立覆盖数。
- 最终测试版本的相关回归：在另一个独立副本 `/tmp/m0fix.I5bkge/check` 执行上述五文件测试，99 pass / 0 fail，317 expect，8.92 秒。
- 最终版本 `bun run test:installation`：exit 0，1 pass / 0 fail，119 expect，5.91 秒；一次完整矩阵覆盖 6 次有效运行、28 次预期拒绝、2 次热缓存损坏拒绝。
- 补充 Node 原生 TypeScript 加载验证：禁网下并发加载 ts/tsx/js/jsx/go 并检查真实语法树，exit 0。它补充 Node 原生入口兼容性，不替代安装产物测试。

完整回归输入先固定到独立副本。随后新增的安装生命周期脚本缺席断言和打包指纹输出仅在目标测试文件中编辑，没有中途修改该副本；最终五文件测试及 test:installation 已单独复核这一测试版本。18 个产品/资源/测试文件与最终验证副本逐字节相同，报告本身不作为解析输入。

完整回归的五项失败均位于未修改的原有测试：

1. `tests/daemon-client.test.ts:242`：并发 connectDaemon 后预期一个进程，实际两个。
2. `tests/daemon-client.test.ts:367`：预期 connected，实际 unreachable。
3. `tests/daemon-client.test.ts` 的 workspace() 发现测试：探测 socket 时 ENOENT（清理路径位于 :495）。
4. `tests/daemon-lifecycle.test.ts:134`：并发双启动竞争退出码为 1，预期 0。
5. `tests/daemon-lifecycle.test.ts:163`：并发三启动竞争退出码为 1，预期 0。

独立集成的失败为 `tests/integration/daemon-dispatch-relay.test.ts:266`：两窗口并发启动发生 database is locked。首轮独立集成曾通过，本轮该用例失败；它与已观察的锁竞争同类，但完整根因和每次竞争的对应关系仍未证明，不能仅因源码未改就宣称没有任何回归。本轮不修这些范围外问题，也不重复运行以挑选全绿结果。

实际产品 tarball SHA-256：`1e6ffbad1ecafdc3f44afd9a5bd9f4fcd59d92df9bf18b06d7f9a5d000811f68`。产品 `runtime/syntax-parser.ts`：`0407285a1b5630df14ff632dd71c286fc7ea856d183dabd0ac4cf7281023c12c`；资源清单：`65d3a5058214ab70a2b1637e18ca1c839c9f09e1264e0a332ac2c74bdb3bf2d0`。语法 WASM 指纹与 §6.2 相同。

清理前记录的输出指纹：

```text
完整回归       a4d90a53f6717b26d64dba0164a000723b9561b83823ed77a17ce573f8084ae6
独立集成       3ad7906f64b48d31d954b0e4241eae4de6d05f75e6266b66e772f5114fc93f41
最终相关回归   a6c849c81a541ec038b15779c0bbc4394a5d0de39c914cb54bef155cafc0e5ed
最终安装测试   c2fc0edf0991e3fe367973540eb7d6dfa54558a5d68eafa4b370b095e4cd9eb3
Node 原生入口  d740584c06df59e41560c73d555ad7833d2c88045ea535c0ac003805109067f1
```

未验证：Node 22.19 最低版本及其他 Node 版本、Linux/Windows 的 OS 级离线安装矩阵（测试显式跳过）、长期内存收敛、千文件性能、项目索引和所有 M1 以后的产品协议。解析器/树释放有直接断言，不以此宣称 WASM 的整个进程内存已经归零。

### 11.5 最终 M0 验收

| 验收 ID | 结论与实际依据 |
|---|---|
| M0-AC1 | 通过：真实产品 tarball 的安装入口、Node/Bun、任意 cwd、五类离线夹具；没有语法编译或 CodeGraph 依赖 |
| M0-AC2 | 通过：实际安装产物的缺失/损坏/版本/ABI/热缓存拒绝矩阵；原始 MIT 许可、精确版本、发行包和指纹随包可核对 |
| M0-AC3 | 通过：原工作区修改保全；本轮只补获批 M0 文件，基线失败、测试装置失败和新测试结果分别记录；未修改旧测试断言 |
| M0-AC4 | 保持首轮通过的分析/宿主可行性结论：没有改宿主权限、PM 停止和提醒链；相关集成停止用例通过，但现有生命周期缺口及新出现的并发集成失败继续披露，不扩大为全产品安全已通过 |
| M0-AC5 | 通过：真实安装测试另设仅用普通 Node 文件 API 的业务夹具读取 JSON/Markdown，不依赖产品数据库或运行入口 |
| M0-AC6 | 沿用首轮独立 Git 可行性证据：本轮未修改 Git 模块，也未重跑临时 Git 探针；不宣称 M1 正文工具调用链已实现 |

M0 获批补齐范围完成，不表示项目全部回归通过，更不表示 M1 已开始。下一阶段仍须用户授权；事务连接失效、可信决策、会话正文迁出 DB、自有 prod 排除、并发初始化和受控恢复等原有问题保留给对应阶段，不能以本次安装通过解除其阻塞。

### 11.6 补齐收尾

已先确认本轮 runner、测试 daemon 和子进程结束：`ps` 没有本轮路径，`lsof` 没有 cwd 留在本轮临时根的进程。随后删除 `/tmp/m0fix.I5bkge`，复核目录不存在。清理包括 src/check 验证副本、安装 consumer、HOME/pi 配置、SQLite/WAL/SHM、会话与 Git 夹具、npm/Bun/Node 缓存、tarball、上游下载、日志和临时脚本。`/tmp/jiti`、`/tmp/node-compile-cache` 未出现本轮共享缓存；没有停止用户原有进程或清理用户数据。

最终 diff 自检：已有跟踪文件只修改 README.md、package.json、bun.lock；新文件仅为 §11.1 所列内部解析入口、资源、正式测试及本报告。原计划 hash 与 HEAD 不变，暂存区为空；没有提交、推送、PR 或发布。新代码没有孤立 import/变量/函数，文件格式和 Markdown 代码围栏已核对。资源都是普通文件，不依赖临时目录。生产说明只描述当前职责与限制，首次调研和测试装置失败留在报告的历史证据部分。

本轮停在 M0。后续开始 M1 前仍需用户授权，并重新核对工作区、实际进度和计划原文。

## 12. Node/pnpm底层需求变更

### 12.1 已确认要求与当前状态

用户明确要求：框架底层统一Node，与pi运行时对齐，包管理统一使用pnpm，取消Bun依赖。唯一计划已更新 §1.2、§3.3–3.4、M0/M1及 §13 的安装/验证要求，并新增M0-AC7；本轮只更新需求与影响记录，没有执行源码、测试框架或锁文件迁移。

计划变更前SHA-256：`a86673d7ea5b2d5fc4806dd4c85e48207b28e941fa051b467ae208afbe77e21a`；更新后：`fb1e28167334eee232da7e7e3715e162b147b44cc1f085c6700a978a9900d956`。HEAD仍为 `e55dc24b502d20e58b95b7b2ffa5add9e2899bdd`。原有未提交的解析资源、源码、测试、README和包配置改动保留，没有覆盖或暂存。

Node负责运行代码，pnpm负责依赖安装、锁定和脚本入口。环境一致性还须核对实际Node版本/架构/可执行文件、SQLite驱动、SDK和TypeScript加载方式，不能仅凭命令前缀是pnpm就认定与pi一致。

### 12.2 已核对的迁移影响

- `package.json` 的测试命令仍为Bun，开发依赖仍含 `@types/bun`；`tsconfig.json` 仍引用Bun类型，根目录仍有 `bun.lock` 和 `bunfig.toml`。
- 71个测试文件导入 `bun:test`；部分用例和辅助程序使用 `Bun.spawn`、`Bun.sleep`、`Bun.which`。须按现有断言、mock、超时、子进程及清理语义迁移，不能简单改导入后忽略行为差异。
- `runtime/database.ts:30–32` 根据Bun环境选择数据库驱动；`tests/helpers/database-fixture.ts` 和部分daemon测试直接使用 `bun:sqlite`。目标为产品及测试共用Node的 `node:sqlite`，保留真实库与多进程竞争测试。
- `skills/spec-docs/scripts/lint.sh` 以Bun启动task-check，相关skill、机械校验测试和示例也受影响。切换期间仍生效的框架入口必须能在Node下运行，但不借此推进旧工作流重构或生成新的业务文档。
- 解析器的四份WASM、许可证及已锁定上游版本可以保留；当前安装测试要求Bun，并使用npm构造测试安装环境，需要改为pnpm管理的Node验证。pnpm严格依赖布局还可能暴露测试中对间接依赖的隐式引用，须如实补齐声明或使用宿主正式入口，不随意关闭依赖隔离。
- 当前实际pi安装文档允许宿主内部调用npm；框架自身的pnpm要求不能被解释为授权修改用户全局pi或强行替换宿主安装协议。仍须用真实pi安装入口核对产品，宿主内部也强制pnpm的要求若另行提出，再核对兼容能力。

本机只检查到Node v26.8.2、pnpm 11.7.0可执行；没有安装/更新包或选择新的测试运行器。它们是当前环境事实，不是已经完成版本锁定或最低版本验证。

### 12.3 对阶段与证据的影响

- **M0重新进入待补充验收状态**：新增M0-AC7未执行；M0-AC1和相关缺资源/安装/进程测试须在pnpm管理的Node现场重跑。之前Bun或npm测试安装的PASS不能直接换标签。
- **已有证据不改写**：保留 §7、§11 的真实结果与失败。已有Node解析及本机Git可行性证据可供复核适用性，受新入口/版本/布局影响的部分再验证；不把所有无关结论机械清零。
- **M1仍待授权**：其数据库基础基于统一Node驱动；事务迟到写入、daemon并发启动和真实数据保全问题仍存在，不因移除Bun而自动判定修复。
- **后续阶段继承新基线**：M2–M9使用Node/pnpm安装和验证口径；正文边界、UUIDv7、11工具、主代理工作区管理、PM唯一性、检查互斥及首版A边界均不改变。

后续实施顺序为：在独立环境确定Node测试运行器及版本 → 迁移驱动选择/测试工具和生效脚本 → 生成pnpm锁文件并核对依赖差异 → 验证pnpm严格依赖布局和真实pi安装 → 运行完整基线并分类失败 → 按新M0验收汇报后停止。不触碰真实数据库，不把运行时切换顺带扩大为M1实现。

### 12.4 本轮验证与收尾

本轮仅执行分支/状态/计划指纹、Node/pnpm版本、Bun引用与相关源码检查，以及文档diff和格式检查；没有运行代码测试，不能据此报告Node迁移通过。临时引用清单 `/tmp/pi-spec-node-references.txt` 已清理。本轮改动仅为唯一计划和本报告，其他已存在改动保留，暂存区为空；没有提交、推送、PR、发布或真实数据库操作。

## 13. 经批准的 Node/pnpm 迁移

### 13.1 实现与版本

本轮按 §3.4 和M0-AC7实施运行时及包管理迁移，不实施M1生命周期、数据库文件名切换、事务安全重写或新的业务工具。计划内容及SHA-256保持 §12.1 的值，先前工作区改动全部保留。

- `package.json` 固定 `packageManager: pnpm@11.7.0`；测试采用运行于Node的 `vitest@4.1.6`。`vitest.config.ts` 使用Node环境、独立fork进程、文件间串行、5000ms默认单项超时及既有环境预加载；原用例的显式超时保持。
- 选择Vitest是为了保留现有expect、参数化测试和异步生命周期语义，不是引入另一个JavaScript运行时。生产代码同时由Node原生类型剥离测试和实际pi/Jiti安装路径验证，不能只凭Vitest的转换器证明宿主兼容。
- 新增 `pnpm-lock.yaml`，移除框架 `bun.lock`、`bunfig.toml`、`@types/bun` 和tsconfig中的Bun类型。显式声明 `@types/node@26.4.1`、测试加载器 `jiti@2.7.0`，两者沿用原已解析版本。
- pnpm 11.7.0不能直接导入bun.lock。在独立环境将当前锁定图转换为临时package-lock格式，再用pnpm import生成正式锁；临时转换文件不进入产品。核对原锁的名称/版本集合：只有 `@types/bun@1.4.2` 和 `bun-types@1.4.2` 被移除，其他原有版本全部保留；新增版本来自Vitest测试依赖图，没有顺手升级原依赖。
- `runtime/database.ts` 统一选择Node内置 `node:sqlite`；测试直接数据库访问改为同一驱动及prepare接口。原文件名、表结构、事务实现和真实数据均未迁移。异步事务迟到写入和初始化锁竞争缺口仍需后续修复。
- 71个原测试文件将bun:test导入改为vitest，保留全部2,336个原用例；新增 `tests/node-runtime.test.ts` 的3个一致性用例，合计2,339项。只做登记的收集检查显示72个文件、2,339项；该检查全部跳过执行，仅用于核对没有遗漏，不算PASS证据。
- Bun.spawn/sleep/which分别换成Node子进程、Promise定时等待及可信Node可执行路径；跨进程SQLite测试仍是三个实际并发进程，决策仍是两个实际并发进程，不预先串行初始化、不删除竞争断言。中断测试等待真实进程close再核对数据库。
- `tests/helpers/daemon-harness.ts` 和相关探针沿 `process.execPath` 启动Node，避免PATH里同名命令偷换运行时。辅助lint脚本以Node执行task-check；README、技能使用说明和测试命令夹具同步为当前入口。

### 13.2 必要兼容调整与未掩盖的失败

1. `tests/workflow-tool.test.ts` 的重复rename导入被Node转换器拒绝；仅删除重复项，不删除测试。
2. `spyOn` 换为 `vi.spyOn`；字符串前缀断言改成显式startsWith；空设置返回null的“不含角色键”断言改成null或按字面Object.hasOwn检查，避免Vitest对null抛错及把含点键误当嵌套路径。原要求仍是键不存在。
3. README禁止独立npm install的断言使用命令边界匹配，不能把pnpm中的npm子串误判为另一包管理器。
4. 安装测试使用Node允许的包导出路径和pnpm依赖链接，typebox/package.json的未导出子路径不再作为解析入口。Jiti成为显式测试依赖，未启用扁平化依赖布局掩盖缺少声明。
5. pnpm pack需显式传 `--config.ignore-scripts=true` 才能保证不执行上游prepack；初次验证因上游复制LICENSE的脚本报错，已记录并使用正确的包管理配置。正式安装矩阵仍断言产品和解析运行时无安装生命周期脚本。
6. Node直接连接过长Unix socket返回EINVAL，未触发原daemon的启动阶段长度检查。`runtime/daemon-client.ts` 在连接前复用既有socketPathByteLimit，拒绝超限路径并保留原明确错误断言；没有把所有EINVAL放行为启动，也没有扩大操作权限。这是保持Node入口行为的最小兼容调整，不是并发初始化修复。
7. 类型剥离检查在Node父子进程的stdin同步传输中停滞。改为让同一Node直接读取被检查文件，并对检查子进程设置5000ms上限；空stderr时仍返回真实错误，不把超时当成功。检查仍使用实际stripTypeScriptTypes，所有非法语法夹具保留。

两次未完成的全量尝试保留为失败过程：一次额外的“禁执行Bun”外层macOS沙箱导致产品内层sandbox_apply失败，一次停滞在类型剥离子进程stdin。这两次均停止并清理本轮进程，不作为完整回归结果。正式验证保持产品自己的沙箱；只撤去冲突的测试外层包装，没有改动产品安全策略。上述兼容修正均按具体失败调整，不以弱化断言换通过。

### 13.3 安装与运行环境

验证使用独立目录 `/tmp/nm.6U4UPf`，Node26和Node22各有工作副本、HOME与测试数据；同机并行执行两套功能回归，不将耗时作为性能基准。

- 实际宿主对应运行时：Node v26.8.2；最低声明版本：Node v22.19.0；pnpm 11.7.0；pi SDK 0.85.1；平台为macOS arm64。
- Node22只下载到临时目录，不修改用户安装。官方 `node-v22.19.0-darwin-arm64.tar.gz` 与同源SHASUMS256核对，SHA-256为 `c59006db713c770d6ec63ae16cb3edc11f49ee093b5c415d667bb4f436c6526d`。
- 两套PATH都只提供绑定Node、pnpm、Git和系统命令，command -v bun失败，Node测试中断言没有Bun全局；宿主个人Bun安装没有删除。这是无Bun命令依赖的独立运行现场，不冒称整台机器或完整虚拟机中不存在Bun二进制。
- Node22在另一个全新目录执行 `pnpm install --offline --frozen-lockfile --ignore-scripts`，复用已校验本机store，176个实际安装包、零下载；Node26的冻结锁文件安装与类型检查亦实际执行。pnpm布局为isolated，不使用shamefully-hoist等放宽策略。
- 安装测试改用pnpm pack与本机精确tarball，通过consumer的锁文件生成及冻结安装，沿实际依赖链接定位WASM。peer由测试宿主提供，消费者显式关闭自动安装peer，不用它替代产品依赖声明。实际pi安装入口继续验证，不擅自更改宿主npm协议或全局配置。
- 安装测试子进程保持OS级禁网，Node单运行时每轮检查3次有效解析、14种预期资源拒绝、1次热缓存损坏拒绝，以及许可证、指纹、普通JSON/Markdown独立读取。分别在Node22和Node26运行，不将旧Bun结果换标签。

### 13.4 验证结果

| 实际命令/范围 | Node26.8.2 | Node22.19.0 |
|---|---|---|
| `pnpm run typecheck` | exit 0 | exit 0 |
| `pnpm test`（完整回归，含JSON报告） | exit 1；2332通过、7失败、0跳过；2339项 | exit 1；2330通过、9失败、0跳过；2339项 |
| `pnpm run test:integration` | exit 1；42通过、1失败；83.80秒 | exit 0；43通过、0失败；87.26秒 |
| `pnpm run test:installation` | exit 0；1项完整矩阵通过 | exit 0；1项完整矩阵通过 |
| 最终六文件定向回归 | 124通过、0失败；6.88秒 | 124通过、0失败；7.13秒 |
| 并发决策单项诊断 | 1失败，其余50项未选；明确database is locked | 1失败，其余50项未选；明确database is locked |

六文件定向回归命令为 `pnpm test tests/role-settings.test.ts tests/erasable-syntax.test.ts tests/node-runtime.test.ts tests/syntax-parser.test.ts tests/installation tests/user-documentation.test.ts`。完整回归固定输入后，空设置匹配器适配、类型剥离空stderr诊断及并发决策stderr诊断三个测试文件有后续修正，已分别按上述最终定向/诊断运行核对；未再次重跑全量，不能从原失败总数中减掉修正项后冒充新的全量结果。所有最终源码、测试、配置和资源与定向验证副本逐字节相同。

完整回归失败清单：

- Node26：daemon-client的工作区连接unreachable及workspace探测ENOENT；并发决策；并发范围申请；role-session的git status事件等待5000ms超时；空设置匹配器；双窗口并发启动集成。
- Node22：daemon-client双启动出现两个进程及workspace探测ENOENT；daemon-lifecycle双启动退出码1；三Node并发SQLite；并发决策；并发范围申请；空设置匹配器；run-manager停止重叠范围场景的需求初始化前置失败；双窗口并发启动集成。

处理分类：

1. **已修正并单独验证的迁移适配**：空设置返回null时的匹配器错误，两个Node版本均通过全部51项角色设置测试；类型剥离及安装适配亦有两版本定向通过证据。原全量报告仍保留当时失败。
2. **实际数据库锁竞争**：并发SQLite、并发范围申请的输出指向 `runtime/database.ts:67` 的WAL初始化；补充并发决策诊断在两版本也都明确复现同位置的database is locked。独立Node26集成失败亦为并发启动数据库锁。保留并发与退出码断言，没有串行化夹具、吞错或重试到绿。
3. **尚未完全归因**：daemon数量/连接不稳定与已发现竞争有关联，但不能把全部表现直接视为同一已证明根因；Node26的git status事件超时和Node22的“需求状态不存在”前置失败仍需调查。未放宽超时、跳过停止安全场景或将其标成通过。

本轮因此不能声称全回归通过。历史 §7、§11 的Bun/Node输入与结果保持原样；原有异步事务连接未失效等缺口也没有因运行时切换自动消失。

实际安装包压缩字节在两个Node版本下的SHA-256不同：Node26为 `83f0bddb1687f3c1602449da67b9ed4e015cd89b25644255ff103b19e8de79b4`，Node22为 `e20bb80327571b34e4e3aa5238daa7bd44c6f3bc35ace186ee93470824b04935`。额外按解包文件逐项核对：96份文件内容全部相同；不把gzip字节差异误报为产品正文变化，也不要求包管理器跨Node生成相同压缩流。

证据指纹（临时原始输出在收尾时删除，仅保留这些标识及实际结果）：

```text
pnpm-lock.yaml       d06a44b79f6e136ffaf56eeb429d07bdcc12cad8614d178eab4c4f4c6015a830
runtime/database.ts  bd759c5d2d070ec906713206a623581497e95a5de9efa065ff67679660bcd52a
runtime/daemon-client.ts 71ab2a7a1236b85c926f17189e89120c1770eaf22e12fa16a0f09ba345933c98
Node26全量JSON       c3f430e6fcb6c48e332636958ed850142cac0dd7d513c4adef652a08cc473c8c
Node22全量JSON       b7f25a52979357ca85b753d285e68c1497c9dbbeb172c0380634acc313b2f38f
Node26最终定向       6a4ba2dc013ea647bf9763c0a5d1d0ac2dfa4aee45d60ab102d61de85aa60727
Node22最终定向       331770484479f02950e668a3306f1ebe841a0779bd2791d89b87377d620dc1b0
Node22冻结离线安装   4e3314a1f1792823bbcf3cb2fce5cd399681a7646d066ecb3a4ea97b49d19234
96文件内容指纹清单   43f7a6161c9dab4de62469a8027c7ba86663fe10d83e99d93968be8e6670067e
```

### 13.5 验收状态

| ID | 本轮结论 |
|---|---|
| M0-AC1 | 通过：pnpm管理/打包/隔离安装的真实产物，在Node26及最低Node22、不同cwd下离线解析首批夹具 |
| M0-AC2 | 通过：两版本下资源缺失/损坏/ABI/版本/缓存拒绝，WASM与许可证仍可追溯 |
| M0-AC3 | 通过：已有改动保全，原2336项保留并新增3项；迁移适配失败、基线竞争和未归因失败分别记录，没有改写历史结果 |
| M0-AC4 | 分析及宿主路径已更新；产品安全策略保留，但部分场景被初始化/时序失败阻塞，不能扩展为全产品安全已通过 |
| M0-AC5 | 通过：安装测试的普通JSON/Markdown业务夹具仍不依赖产品运行与数据库 |
| M0-AC6 | 保留此前Node独立Git可行性证据；本轮未重跑完整存储探针，不充作M1产品链证明 |
| M0-AC7 | 部分完成：Node/pnpm、同驱动、冻结安装、严格依赖布局、最低版本和子进程入口均有证据；完整回归有失败且未全部归因。无Bun命令路径与无Bun全局已验证，未取得“整台机器完全未安装Bun”的独立机器/虚拟机证据 |

迁移实现已落地，M0整体仍不宣告全部通过。没有进入M1；下一步应在这份Node基线上处理或明确处置剩余失败，阶段推进另行授权。Linux/Windows、其他Node版本、物理断电、完整生命周期及千文件性能仍未验证。

### 13.6 收尾

已结束本轮测试控制进程，并按本轮路径精确停止遗留daemon；ps及lsof确认没有本轮进程或cwd占用后，删除 `/tmp/nm.6U4UPf` 并确认不存在。清理范围包括两版本Node验证副本、无Bun命令目录、Node22下载及解包、pnpm store/cache、测试数据库/WAL/SHM、会话、Git/worktree夹具、安装消费者、打包产物、日志/JSON报告和转换/诊断脚本。没有结束用户原有进程或删除用户原始工作区。

版本探测曾生成7个默认Node22编译缓存文件。只读取文件名和创建时间，使用相同pnpm版本命令在独立缓存目录复现文件名后，清理本轮匹配项及空目录；未读取缓存正文。其他本轮缓存均随独立根清理。

最终改动核对：框架运行源码只改变数据库驱动选择和daemon连接前的必要长度校验/当前注释；其余为测试运行器、Node API迁移、包管理和当前说明。旧断言场景保留，不含无关重构；新import/变量均有用途。原WASM字节与许可证不变，计划hash保持fb1e28167334eee232da7e7e3715e162b147b44cc1f085c6700a978a9900d956，HEAD和暂存区未变。

目标工作区原有node_modules未覆盖，使用当前工作区前应先执行 `pnpm install --frozen-lockfile` 安装新锁定依赖；本轮验证已在独立pnpm安装中完成。没有提交、推送、创建PR、发布或迁移真实数据库。当前停在M0，剩余失败与后续阶段等待用户确认。

## 14. 经授权修复失败BUG

### 14.1 范围与复现

用户要求优先修复 §13 中失败的BUG。只处理失败涉及的SQLite首次初始化竞争、daemon启动/残留socket竞争，并复核Git事件等待及停止范围测试；不推进M1的其他业务模型、生命周期或真实数据迁移。

工作区仍为bb-spec-rebuild，HEAD不变；开始时所有未提交的Node/pnpm及解析资源改动保留。独立验证根为 `/tmp/bf.j22wOG`，before副本用于旧实现对照，run/run22用于当前Node26与最低Node22验证，不含业务Git历史。新增回归测试复制到before只为验证旧实现会失败，不修改用户工作区基线。

修复前定向命令选取三个Node并发SQLite、并发决策、范围申请、daemon双/三启动、workspace发现、git status事件预算、停止后重叠范围门槛等10项：5通过、5失败，其余276项未选。实际失败再次指向 `runtime/database.ts` 的WAL配置锁竞争及daemon启动/连接；未选用例不计为通过。

### 14.2 根因与修复

- **数据库初始化竞争**：SQLite的journal_mode锁升级可能直接返回SQLITE_BUSY；单纯设置busy_timeout不能覆盖这条路径。`runtime/database.ts` 在已是WAL时复用该模式，仅对幂等的日志模式配置按SQLite数字错误码进行有界等待，使用原5000ms总预算并核对实际启用结果。业务事务、事件和写入不自动重试。取得初始化事务的写锁后重新读取user_version，拒绝未知版本，不能用等待前的版本覆盖别人的初始化。
- **同进程重复拉起**：两个连接请求在监听尚未建立时各自派出daemon。`runtime/daemon-client.ts` 按同仓库、数据根、SDK、可执行文件和显式环境参数共享尚未完成的启动尝试；成功/失败都移除该临时登记，后续显式重试仍可运行。不同参数不合并，跨进程继续依靠原socket独占机制。
- **残留socket误删**：旧实现根据一次stale探测直接删除当前路径，探测期间该路径可能已被别的进程替换。`daemon/lifecycle.ts` 保存被探测文件的inode，并复用已有归属检查只释放同一文件；确定性的替换注入测试证明新的文件不会被失败竞争者删除。仍不宣称文件系统的stat与unlink之间具有全局原子性或能控制任意外部程序。

没有修改SQLite文件名或业务表模型、未覆盖真实数据库、未放宽任何授权/沙箱/停止保护；已知异步违规事务连接失效要求仍属于后续待实施边界，不将初始化修复冒充M1-AC10/11已经完成。

### 14.3 新增与保留的回归

- `tests/database-initialization.test.ts`：真实子进程持有读锁，释放后完成WAL切换且保留原内容；持续持锁时约5000ms明确失败、没有业务表或半份写入；10轮、每轮4个进程通过同步起跑点同时首次开库，逐轮核对40条有序事件和4个真实PID。
- `tests/daemon-client.test.ts`：在原同进程双连接用例中增加仅一次启动日志断言；新增三请求共享同一次启动失败、随后显式重试产生新尝试的用例。
- `tests/socket-replacement.test.ts`：在旧socket探测后、清理前注入替换；持有旧inode防止夹具复用，断言新文件保留。

修改前对照：新增数据库文件中并发首次开库用例失败；新增的共享启动失败与socket替换两个用例都失败。修改后这5个新增用例全部通过。原10项定向回归修复后全部通过，含先前未完全归因的Git事件等待与停止重叠范围场景。没有增加它们的等待时限或改成跳过，单次通过仍须由完整回归和重复关键场景核对。

### 14.4 完整验证

在没有Bun命令的独立PATH、pnpm 11.7.0、同版本pi SDK 0.85.1下执行；Node22使用临时下载并核对官方指纹的22.19.0，Node26使用实际宿主26.8.2。两个工作副本、HOME和数据根独立。原2339项加5项新增回归，共2344项，未删除原有用例。

| 实际命令 | Node26.8.2 | Node22.19.0 |
|---|---|---|
| `pnpm run typecheck` | exit 0 | exit 0 |
| `pnpm test --reporter=default --reporter=json` | **2344通过、0失败、0跳过**；467.00秒 | **2344通过、0失败、0跳过**；480.19秒 |
| `pnpm run test:integration` | **43通过、0失败**；78.57秒 | **43通过、0失败**；83.15秒 |
| `pnpm run test:installation` | **1项完整安装矩阵通过**；3.86秒 | **1项完整安装矩阵通过**；3.85秒 |

安装矩阵继续使用真实pnpm产物、隔离依赖布局、实际pi登记、任意cwd和OS禁网，不改成模拟解析或只测源码目录。集成与安装已包含于全量，不能相加成更多独立覆盖。

另在独立stress副本中事先固定执行3轮关键场景（不因失败追加次数）：每轮10项通过、0失败，其他276项未选；分别15.82、15.73、16.00秒。包含首次开库10轮×4进程、并发决策、范围申请、同进程启动合并、跨进程三启动、残留socket、Git事件预算和停止重叠范围限制。完整回归及这三轮都未改变相关时序阈值。

原先的Git事件超时和需求初始化前置失败在两个完整回归和重复定向场景中均通过。本轮没有据此声称已单独证明其每次历史失败都来自同一个根因，也没有重写旧失败报告；确定修复的是上述三个有明确代码路径及回归证据的竞争缺陷。

被验证源码SHA-256：

```text
runtime/database.ts      58cc8e2e662435a8b2d20fb5af3e631fe7cac5c55b7327bf6ef6ec6f0eef0872
runtime/daemon-client.ts daf76b18d80f949c8a63e84e688e9da5a25e5c31695e28ce891b8688ac3cd4ef
daemon/lifecycle.ts      9e6259793b49ba43b563590253ea05745a2319c50d1a4eafc874263da5c87ebd
```

本轮输出指纹（原始日志随临时根清理）：

```text
Node26全量JSON ec15028c0697c96a70b10880be101f8fb4df2ff125dcccbeb31d748e657cebb1
Node22全量JSON c6ae4385e32a175af35be6417d048614ccd6b90aa06aa4c18e72e52ed22ee631
Node26集成     b8dd74d2bd1b3fa3f35e6e28e4fe9963cbcc88ac652fb4d5bcac72cca3d5a53c
Node22集成     f1533e4b1138115d9bc7b1d24a0b028994cffdf9a072d72c8409ba828893907e
Node26安装     4d1cba0464e4ee261f0ee16da61cc514f32def9a363aeee3888bda99bbbd95b9
Node22安装     1d81a332ee817b68a376856f3854ab7d13892582b4ce00b7ace06d6c1284d9e2
关键场景第1轮 2a12535f224d99cee646aa3e18662b944c4961b3373d2d9fe20a61e060524c06
关键场景第2轮 e6b18c6e58a1e6b7419068f8b96f616dbae15b7daab0a4314e1d949aa06a5eae
关键场景第3轮 2bc526069ef1c7328cd592b2ad7361d45036f9c72ebe75dace88992d3afd7312
```

### 14.5 本轮验收范围与剩余边界

- 本轮失败清单在Node26/Node22的当前完整回归中已全部通过；对应M0-AC3的基线/改动保全，以及M0-AC7中之前受阻的Node全量、集成验证，已有当前证据。
- M0-AC1/AC2的真实安装和资源拒绝矩阵重新通过；AC5的普通文件独立读取亦随安装用例验证。
- AC4维持实际宿主路径和原安全保护边界，停止相关用例通过，不扩展成新生命周期/全部工具隔离已经完成；AC6独立本机Git存储探针本轮未重跑，保留此前证据。
- 本轮不是M1实现。异步违规事务连接失效、可信批准、正文存储迁移、关闭协议等计划中的后续要求仍未完成；Linux/Windows、物理断电、千文件性能和整机完全未安装Bun的虚拟机证明仍不在本轮通过结论中。

### 14.6 收尾

已确认控制脚本及测试进程结束，并按本轮路径精确停止遗留测试daemon；ps没有本轮路径，lsof没有cwd留在临时根的进程。随后删除 `/tmp/bf.j22wOG` 并复核不存在，清理包括before/run/run22/stress副本、Node22下载、HOME/pi配置、SQLite/WAL/SHM、会话、Git/worktree夹具、pnpm/Node缓存、安装消费者、打包产物、原始日志/JSON报告和控制脚本。没有生成共享 `/tmp/jiti` 或 `/tmp/node-compile-cache` 残留，也没有停止用户原有进程。

本轮修复仅涉及 `runtime/database.ts`、`runtime/daemon-client.ts`、`daemon/lifecycle.ts`、原daemon-client测试的强化、两份新增回归测试和本报告；之前的Node/pnpm/资源及计划修改全部保留。所有最终源码和测试与Node26、Node22及重复验证副本逐字节相同。没有孤立import/变量/函数，当前注释只说明行为和边界，Markdown及diff格式检查通过。

计划指纹仍为fb1e28167334eee232da7e7e3715e162b147b44cc1f085c6700a978a9900d956，HEAD仍为e55dc24b502d20e58b95b7b2ffa5add9e2899bdd，暂存区为空。没有提交、推送、创建PR、发布或触碰真实数据库；目标工作区原node_modules未覆盖，使用前仍需正常安装pnpm锁定依赖。本轮失败清单已在当前验证中全部通过，停止等待用户确认后续阶段。
