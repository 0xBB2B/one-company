# M2 实施记录

## 1. 当前状态与范围

M2（索引初始化与 prod 正文隔离）的实现、独立审查和技术验收已经完成；本报告记录当前能力、真实验证和限制，不是新的产品 spec、plan 或 task。文档编写前源码 HEAD 为 `b0bd0814370267eb07d1b03a0fd308fca8e39c09`，M2 从 `219945d` 接续，工作区为 `/Users/bb/.bb-spec/worktrees/pi-spec-bb-spec-rebuild`、分支为 `bb-spec-rebuild`。

当前实际公开的新索引工具只有 `pi_company_project_manage`，action 仅为 `init`、`status`、`refresh`；`init` 可传 `preview: true`。计划中的 11 个核心工具尚未全部上线，M3 watcher/dirty/可靠事件通知和 M4 `knowledge_query` 均未实现。本轮没有把 M2 说成完整框架重建。

M2 没有迁移或覆盖真实本机数据库，没有读取本机活动 prod，没有创建活动需求授权，没有进入 M3。旧 PID 52973/53030、原计划修改、`.pi/` 和未跟踪的 M0 报告均保留；本报告不把它们纳入 M2 成果。

## 2. 实现内容

### 2.1 扫描策略与正文隔离

`runtime/project-index-policy.ts` 提供有界目录枚举和文件读取：

- 预先排除 `.git`、依赖、构建、缓存、日志、本机数据库及 WAL/SHM、敏感凭据、链接/多链接文件、嵌套仓库和 `docs/prod` 正文。
- `docs/prod` 只枚举直接文件名。合法 `<UUIDv7>.<描述>.md` 归档只形成路径元数据；归档生命周期为 `unknown`，`epoch` 和 `hash` 为 `null`，不会产生 active 状态或读取授权。非法文件名、同 UUID 多路径等风险明确报告，不读取正文裁决。
- 工作区和 dataRoot 必须是分离的真实路径；目录、文件、祖先链和数据库链在关键边界重复核对，拒绝越界、链接替换、不稳定文件和身份变化。
- 默认预算为单文件 2 MiB、文本集合 20 MiB、20,000 个目录条目、64 层深度。超限、不可读、二进制、非法 UTF-8、取消和不稳定状态均按固定原因返回，不把不完整扫描报成完整。
- 文件字节保留 Unicode 与 CRLF，并计算 SHA-256。构建发布前执行第二轮完整读取与 hash 核对，因此公开 `readBytes` 上界可达到文本集合预算的两倍。

扫描不运行仓库脚本，不写业务工作区，不批量初始化需求 Git，也不把归档路径当成可信完成记录。

### 2.2 代码结构与来源范围

`runtime/code-extractor.ts` 基于随包安装的 Tree-sitter WASM，首批支持 TS、TSX、JS、JSX 和 Go：

- 提取函数、箭头函数、类、方法、接口、类型、导入和导出，并记录 UTF-16、零起始、半开区间的真实来源范围；索引发布时行号转换为 1 起始。
- 只把可证明的同文件词法直接调用标为 `certain`。成员调用、动态调用、外部绑定、重名歧义、遮蔽、赋值污染及无法解析目标保持 `unknown`，不靠同名伪造关系。
- 覆盖函数参数、匿名函数调用者隔离、循环写目标，以及 Go 的 range、接收、控制流、类型 switch、具名返回参数和声明生效位置。
- 注释和字符串不被当成调用；语法错误、节点/深度/诊断预算问题返回 `partial` 与固定诊断，不回退旧结构。
- 其他语言只形成文件级记录并明确标为 unsupported，不承诺完整动态调用图。

### 2.3 持久代次、FTS 与当前 spec

`runtime/index-store.ts` 在每仓库 `index.db` 中保存按 worktree/分支隔离的当前代次：

- 持久化 files、symbols、code_edges、features_current、rules_current、rule_edges_current、source_fragments 和最少 prod_metadata。
- 发布在同步 SQLite 事务中替换该工作区的当前代次；取消、中断、发布失败和进程强杀不会留下可返回的半份 current。新 fence 阻止旧构建覆盖新状态。
- FTS（SQLite 全文搜索）与 source_fragments 同事务更新；修改或删除文件会清除旧词，invalid spec 会清除旧规则正文。搜索参数、条数、片段和总输出有固定预算，非法查询不泄露底层 SQLite 错误。
- 当前 spec 使用既有严格 JSON/schema、稳定 ID、contractHash 与 contractSetHash。项目没有 spec 时仍可建立代码索引并标为 `absent`；已有 spec 的 schema 缺失、必要文件被跳过或集合无效时标为 `invalid`，不会退回上次有效规则。
- 文件 hash 和解析器版本均未变化时可复用结构；对应语言解析器版本变化只重建受影响文件。解析资源瞬时失败不会把失败缓存永久复用。

`IndexStore.search` 是内部持久索引能力；本轮没有把它公开成 M4 `knowledge_query`。

### 2.4 初始化服务、恢复和宿主工具

`runtime/project-index-service.ts` 组合扫描、读取、Tree-sitter 提取、spec 校验、FTS 和代次发布：

- `preview` 只枚举范围，不创建数据库；`status` 只读现有状态，并明确返回 `cacheVerified: false`，不能当成内容已对账；`init`/`refresh` 执行构建。
- 取消在安全边界生效；真实 SIGKILL 可留下 `building`，新进程以新 fence 恢复。旧 current 在 building/invalid/cancelled/interrupted 状态下不会被当成当前正文返回。
- 发布前重新核对仓库/worktree身份、授权、目录链、完整文件列表和逐文件 hash。扫描与发布期间变化返回 unstable 或对应部分状态。
- dataRoot、`repos/<repoId>`、`index.db` 及 WAL/SHM 均执行真实目录、所有者、权限和链接检查；只在仓库外本机索引目录写数据库。

`runtime/project-manage-tool.ts` 和 `extensions/project-manage.ts` 把服务接入真实 pi lifecycle：

- 工具名为 `pi_company_project_manage`，公开 schema 只接受 `action`、当前 lifecycle 中的 `repoId`，以及仅 `init` 可用的可选 `preview`。
- 首次 preview/init/refresh 必须由当前 session 的真实 UI 确认具体扫描和写入范围；许可只在同一 session、窗口、仓库及路径身份中复用，shutdown 会撤销许可、取消并等待真实操作结束。无 UI 或用户拒绝时不会获得扫描许可。
- `status` 不要求扫描确认，但只返回绑定仓库的最少状态元数据。逐文件授权不允许 `docs/prod` 路径。
- 输出最多 32 KiB、100 项、单路径 512 字符；截断、被省略的阻塞项和 invalid/diagnostic 信息有显式元数据，不回显源码、prod 正文、仓库绝对路径或底层错误详情。

## 3. 实际提交与文件

M2 功能提交如下；本次文档提交号不在本报告中预写：

| 提交 | 功能 | 主要文件 |
|---|---|---|
| `0e89159` | 有界扫描、排除和路径核对 | `runtime/project-index-policy.ts`、`tests/project-index-policy.test.ts` |
| `8e26f54` | 首批语言结构与保守调用依据 | `runtime/code-extractor.ts`、`tests/code-extractor.test.ts` |
| `0691af1` | 持久索引代次和事务型 FTS | `runtime/database.ts`、`runtime/index-store.ts`、`tests/index-store.test.ts` |
| `75461de` | 循环写目标和匿名 Go 调用保守处理 | 提取器及测试 |
| `1874ee7` | Go 控制流绑定作用域 | 提取器、提取测试、服务测试 |
| `27da9bc` | 初始化/恢复服务与解析资源健康检查 | `runtime/project-index-service.ts`、`runtime/syntax-parser.ts` 及测试辅助/测试 |
| `1f25bc3` | 宿主授权工具和实际扩展安装 | `runtime/project-manage-tool.ts`、`extensions/project-manage.ts`、`extensions/index.ts` 及测试 |
| `b0bd081` | Go 声明在初始化表达式中的可见位置 | 提取器及相关测试 |

没有修改依赖或锁文件，没有新增 watcher、`knowledge_query`、业务 Git 写入或 prod 通用读取网关。收尾提交 `6423c60` 仅删除 `runtime/project-index-policy.ts` 中从未被调用的 `relativePosix` 和只被它引用的 `toPosixPath`；主代理已核对实际九行删除，没有改 import、执行路径或其他行为。

主代理已审查、整合 `README.md`、本报告及上述清理，并完成清理后的定向验证。

## 4. M2 验收矩阵

| 验收项 | 结果与实际测试入口 |
|---|---|
| M2-AC1 | 通过。`tests/project-index-policy.test.ts` 覆盖混合分类、归档正文零打开、跳过原因、预算、Unicode/CRLF、链接/嵌套仓库、祖先替换和 dataRoot 分离；`tests/project-index-service.test.ts` 覆盖归档元数据及非法/重复路径报告。 |
| M2-AC2 | 通过。`tests/code-extractor.test.ts` 覆盖五种首批语言、真实范围、注释/字符串、遮蔽、赋值、循环与 Go 作用域；确定关系只来自可证明的同文件词法调用，未知关系保留来源依据。 |
| M2-AC3 | 通过。提取器语法错误测试、`tests/project-index-service.test.ts` 的代码语法错和 spec/schema/预算缺口测试确认分别发布 `partial`/`invalid`，并替换或清除旧 FTS/规则正文。 |
| M2-AC4 | 通过。policy/service/store 测试覆盖取消、事务回滚、新 fence、真实子进程 SIGKILL、重复 init/refresh 与恢复；新进程恢复不重复节点，未修改共享文件。同步 WASM 解析只能在调用边界响应取消，见限制。 |
| M2-AC5 | 通过。无 `docs/spec`、无本机需求记录和无数据库的夹具可建立代码索引；`docs/prod` 只按路径预排除，不读取正文或建立 active 授权。 |
| M2-AC6 | 通过。服务测试覆盖新进程复用未变索引、同 size/mtime 但 hash 改变时重解析、按语言解析器版本局部重建；未知语言明确文件级 unsupported。 |
| M2-AC7 | 通过。policy/store/service/host 测试使用正文访问探针和 sentinel，核对 source_fragments、FTS、诊断及公开工具输出不含活动或 closed prod 正文和详细派生摘要。该结论只覆盖自有索引和工具路径，不外推到任意外部缓存。 |

M2-AC1—AC7 没有阻断项。安全审查只用于安全职责；正确性复审另行完成，未用安全审查对 AC2 的附带意见替代正确性验证。

## 5. 验证证据

### 5.1 最终固定输入

最终源码清单为 `/tmp/m2-verification-uX9rDF/logs/final-candidate-baseline.json`，共 262 项，清单 SHA-256 为：

```text
15252a02866ba84eca9db2534d38460ee0cf2e306b46ac4b09f3fcb166c7a98f
```

主代理在正式验证后按该清单复核当时 262 项源码 hash，结果为零变化。本文档代理在写 README/报告前也独立复算为 262 项、零变化；README 和阶段报告不属于这份源码清单。

两 Node 完整验证结束后，按收尾检查只从 `runtime/project-index-policy.ts` 删除两个未调用函数。当前重新对照原清单为 262 项均存在、仅该文件 1 项变化：原 hash `c074811fa2b16f2d228361a080fb52454510179ffe9b3fb23080ccdb3f180a3a`，清理后 hash `08482c9ab705e218a907f7bc66782aa20b081bfea0597d73f0428f2eaf6630f0`。原 manifest 保持不变，不把清理后的字节换绑到旧完整 PASS。

### 5.2 两个 Node 版本的串行验证

环境为 macOS arm64、pnpm 11.7.0、pi SDK 0.85.1、Node 22.19.0 和 Node 26.8.2，使用同一份 262 项源码。Node 22 环境没有 Bun 命令路径；框架入口使用 Node 与 `node:sqlite`。

| 命令 | Node 22.19.0 | Node 26.8.2 |
|---|---:|---:|
| `pnpm run typecheck` | exit 0 | exit 0 |
| `pnpm test` | 98 文件，2676/2676，exit 0 | 98 文件，2676/2676，exit 0 |
| `pnpm run test:integration` | 10 文件，43/43，exit 0 | 10 文件，43/43，exit 0 |
| `pnpm run test:installation` | 3 文件，3/3，exit 0 | 3 文件，3/3，exit 0 |

对应日志为 `node{22,26}-{typecheck,full,integration,installation}-serial.log` 及同名 `.exit`。完整 `pnpm test` 已经包含 integration 和 installation 测试文件，上表不能相加解释为更多独立覆盖。

`frozen-install.log` 记录 Node 26 主执行环境中的 offline frozen install 成功。Node 22 使用同一已冻结依赖布局继续执行验证，没有重新安装依赖，因此不能声称两个 Node 版本分别完成了一次 install。

### 5.3 完整验证后的孤立残留清理

`pnpm exec tsc --noEmit --noUnusedLocals --noUnusedParameters` 的主代理诊断只在本轮新代码中发现 `relativePosix` 及其唯一辅助函数 `toPosixPath` 未使用；另有既存 `shell-bash.ts` 的 `event` 和 `shell-page.ts` 的 `width`，不属于本任务，未修改。

只删除上述两个未调用函数后，实际补充验证为：

```text
pnpm exec vitest run tests/project-index-policy.test.ts
1 文件，10/10，exit 0

pnpm run typecheck
exit 0
```

这项定向验证证明策略测试和普通类型检查在清理后通过；它不替代、改写或扩大清理前两个 Node 版本的 2676 项完整回归。

### 5.4 文档交付验证

README、报告和孤立残留清理完成后执行：

```text
pnpm exec vitest run tests/user-documentation.test.ts tests/package-skeleton.test.ts tests/extension-entry.test.ts
3 文件，84/84，exit 0
```

该命令核对 README 必需内容、包骨架和真实扩展入口；它不是 M2 功能完整回归的新增独立覆盖。主代理随后合并执行 policy 与上述三文件测试，4 文件、94/94 通过，普通 typecheck 通过；证据为 `logs/post-cleanup-tests.log` 和 `logs/post-cleanup-typecheck.log`。严格 unused 诊断只剩原有 `shell-bash.ts`、`shell-page.ts` 两项，不改动范围外代码。

### 5.5 保留的历史失败

历史失败没有被改写：`node22-full-go-final.log` 在提交 `1874ee7` 对应输入上为 98 文件中 1 文件失败，2674 通过、1 失败。失败位置是 `tests/requirement-backup.test.ts:377`，超过原 5000 ms 测试超时。

停止并发后，完全相同的单项原断言在 `node22-backup-isolated-diagnostic.log` 中 3.89 秒通过；没有修改该旧测试、断言或超时。最新 Node 22 和 Node 26 串行完整回归均通过。现有证据只说明失败与当时并发执行同时出现，不足以证明并行负载就是唯一根因。

## 6. 子代理、接手与独立审查

实现、测试和审查子代理均实际使用 `5x/gpt-5.6-sol`；运行模型证据为 `/tmp/m2-verification-uX9rDF/logs/agent-model-evidence.json`。全部实现结果由主代理逐项读取源码、复现边界、核对差异并执行实际测试后整合，没有只采用子代理自报结论。

按 `/tmp/m2-verification-uX9rDF/logs/main-coordination.md` 记录：

- `M2-EXTRACT-01` 两次真实子代理尝试后，独立正确性审查仍复现循环写目标被误标为确定关系。主代理只接手该任务的循环绑定语义及关联回归，保留其他已完成提取能力。
- `M2-SERVICE-01` 两次真实子代理尝试后，独立正确性审查仍复现 Tree-sitter `Language.load` 瞬时失败留下 rejected Promise 缓存、同进程 refresh 无法恢复。主代理只接手语法加载缓存恢复及真实回归。
- 其他任务继续由子代理优先完成。协调记录中的部分历史状态字段没有在每一步回填；任务结果以当前代码、提交和最终日志为准。

独立安全审查 `f867bfad-ecdc-4af` 在其安全职责内通过，最终文本保存于 `logs/review-safety.md`。早期正确性审查 `8d85c78a-c4fc-447` 和 `fed0b4d2-1245-468` 发现循环/Promise/Go 变量可见范围问题；修复后由独立正确性复审 `5e5e4d9e-dfac-4fd` 正式通过，最终文本保存于 `logs/review-correctness-pass.md`。历史问题审查文本也已保留，均不包含思维链。主代理自检没有冒充独立审查。

## 7. 已知限制与未覆盖范围

- 只在 macOS arm64、Node 22.19.0 和 Node 26.8.2 实测；Linux、Windows、其他 CPU、真实物理断电及全规模性能留到后续总验收，不能据此宣称跨平台完成。
- 取消只能在异步扫描、读取、文件边界及 Tree-sitter 调用边界生效；同步 WASM 解析执行中不能被 JavaScript 立即抢占。
- Node 没有原子 `openat` 路径链能力。实现通过 `O_NOFOLLOW`、祖先和前后身份/hash复核降低竞争风险，但未观察到的极短 A→B→A 替换仍是已知限制。
- 当前只提取静态可证明关系，不保证反射、依赖注入、动态导入、成员分派或完整跨文件动态调用图。
- `status` 不扫描也不验证缓存当前性；M3 尚未提供 watcher、dirty、溢出/休眠恢复或低频自动对账。外部修改后需要显式 `refresh`。
- M4 `knowledge_query` 尚未公开；FTS 目前是内部存储能力。11 个核心工具也尚未全部注册。
- 普通 read、Shell、Git 历史、MCP 等通用工具读取 prod 的旁路没有全面拦截；本轮只保证自有扫描、索引和工具输出的正文排除，也不追踪任意外部缓存。
- 不自动清空主会话，不保证已进入消息或摘要的旧内容被遗忘。
- M2 未迁移运行库或真实数据，未覆盖本机真实数据库。旧状态和原用户现场均保留。
- M9 的约 1000 文件/20 MiB 全规模性能、长期资源收敛和总体两克隆闭环尚未执行；M2 只完成计划内功能与故障回归。

## 8. 阶段总览与下一阶段

计划共 M0—M9 十个阶段：

| 阶段 | 职责 | 状态 |
|---|---|---|
| M0 | Node/pnpm 基线、安装资源与首版安全边界 | 已完成 |
| M1 | 规则/prod协议、生命周期、数据库、需求正文存储与恢复基础 | 已完成 |
| M2 | 持久代码/spec索引初始化与 prod 正文隔离 | 本窗口验收完成 |
| M3 | watcher/dirty/对账、可靠 prod 事件和关闭撤权通知 | 未开始 |
| M4 | 完整 requirement_manage、渐进确认和当前 knowledge_query | 未开始 |
| M5 | change_apply/spec_change 与 11 工具真实权限 | 未开始 |
| M6 | formal 验证、关闭协议、QA 与完成提醒 | 未开始 |
| M7 | 单 PM、增量 plan/task 和代理资源重构 | 未开始 |
| M8 | 两克隆历史边界与业务 Git 外置 | 未开始 |
| M9 | 真实闭环、性能、安装、安全和总交付 | 未开始 |

M3 的下一目标是实现文件 watcher、dirty/去抖、启动/重连/溢出/休眠/手动对账，以及按准确批准版本持久投递 prod 事件；生命周期撤权必须优先，可靠事件和状态通知不能复活旧权限。进入 M3 前继续遵守 `AGENTS.md` 的单阶段窗口、子代理模型、两次失败限定接手和主代理最终整合规则。

## 9. 收尾状态

M2 功能、测试、独立安全审查、独立正确性复审和两 Node 串行技术验收均已完成，没有 M2 验收阻断。本次收尾修改 `README.md`、新增本报告，并按追加授权从 `runtime/project-index-policy.ts` 删除两个未调用函数；由主代理按用户授权进行限定单元本地提交，未切换分支、推送或发布，也未改动计划、AGENTS 或依赖。完整两 Node 验证与清理后定向验证的字节边界已在 §5 分开记录。

主代理已完成 M2 临时环境清理：Node 22 官方工具链、tar 下载和相关链接已删除，下载包 SHA-256 校验行保留于 `logs/node22-toolchain-sha256.txt`。主代理按会话创建时间和测试目录固定结构筛选，并逐目录用 `lsof` 核对无占用后，清理了 68 个本轮残留 `pi-t-*` 测试根；这些目录只含 jiti/Node 编译缓存、测试 provider 请求日志及 connectivity/shell-registry 夹具。清单为 `logs/temporary-cleanup-result.json`，其中 `retained` 为空。

私有验证日志和必要审查证据继续保留，不进入业务 Git。文档验证结束后，主代理再次检查本轮测试根，未发现新增残留或占用，记录见 `logs/post-doc-cleanup.json`。本轮实现、测试和审查进程均已结束；原 PID 52973/53030 仍保留。最终源码相对完整验证清单仅有 §5.1 记录的非功能性清理差异，原计划及其他用户改动保持不变。
