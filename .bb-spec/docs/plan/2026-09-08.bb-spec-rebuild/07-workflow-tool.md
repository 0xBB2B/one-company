---
name: workflow-tool
description: pi_company_workflow 工具：查询、初始化、局部更新、阶段推进与回退、任务进度、形状确认、续接核对与迁移入口，窗口与守护进程共用；证据只以运行身份传入
---
# 运行信息工具

## 目标
主会话与需求代理都通过同一个受校验工具读写需求与任务的运行信息，请求只带必要字段、已读版本与运行身份，回执简短。

## 业务规则（来源：spec）
- controlled-updates：流程通过专用工具查询、初始化和修改运行信息，不通过文件编辑或命令改写；请求指定需求、可选任务与更新内容，不要求整份文档；普通字段更新与阶段推进分开校验；任一字段不合法整个请求不生效；过期版本被拒绝并提示重新读取；成功回执只含归属、变更字段、新版本与必要提示。
- data-ownership：用运行信息入口修改需求或任务定义、或以报告结论代替完成门禁的请求被拒绝。
- version-bound-recovery：规划、调度、修订、对账与续接从本机数据取阶段；多个待续需求需用户选择。
- safe-migration：迁移预检、正式迁移与状态查询作为工具动作提供。

## 涉及文件
- 新建：runtime/workflow-tool.ts
- 新建：extensions/workflow.ts
- 新建：tests/workflow-tool.test.ts

## 成品定义

`pi_company_workflow` 参数（typebox，`additionalProperties: false`）：

```ts
Type.Object({
  action: Type.Union([
    Type.Literal("query"), Type.Literal("list"), Type.Literal("init"), Type.Literal("update"),
    Type.Literal("advance"), Type.Literal("retreat"), Type.Literal("task-start"), Type.Literal("task-finish"),
    Type.Literal("task-fail"), Type.Literal("rollback"), Type.Literal("reject"), Type.Literal("shape-confirm"),
    Type.Literal("resume-check"), Type.Literal("migrate-preflight"), Type.Literal("migrate-apply"), Type.Literal("migrate-status")
  ]),
  requirement: Type.Optional(Type.String()),
  cwd: Type.Optional(Type.String()),
  task: Type.Optional(Type.String({ pattern: "^T-\\d+$" })),
  fields: Type.Optional(Type.Array(Type.String())),
  version: Type.Optional(Type.Integer({ minimum: 1 })),
  update: Type.Optional(Type.Object({
    note: Type.Optional(Type.String()), description: Type.Optional(Type.String()),
    agent: Type.Optional(Type.String()), commit: Type.Optional(Type.String()),
    blockedReason: Type.Optional(Type.String()), workspaceDir: Type.Optional(Type.String()),
    followUpIssues: Type.Optional(Type.Array(Type.String()))
  }, { additionalProperties: false })),
  stage: Type.Optional(Type.String()),
  decisionId: Type.Optional(Type.String({ pattern: "^(AI|USER)-\\d+$" })),
  runId: Type.Optional(Type.String()),
  reason: Type.Optional(Type.String()),
  confirm: Type.Optional(Type.Boolean())
}, { additionalProperties: false })
```

`advance`、`task-finish`、`shape-confirm` 的证据与形状一律由 `runId` 指向的运行记录读取（守护进程写入的结构化结果或提议形状），工具不接受调用方拼装的对象。`retreat` 需 `stage`（目标阶段）、`reason` 与 `decisionId`。

回执文本格式：`<需求> <动作> 成功：<变更字段或阶段>，version <n>`；失败：`<需求> <动作> 失败：<原因>`（版本冲突时附"请重新查询后重试"）。

## 函数清单

### runtime/workflow-tool.ts
| 函数名 | 职责 |
|---|---|
| `createWorkflowTool` | 生成 pi 工具定义（名称、说明、参数、执行），供窗口扩展与守护进程会话共用；选项 `{ dataRoot, cwd?, migration? }`，`migration` 为迁移单元注入的 `{ preflight, apply, status }` 处理器，未注入时三个迁移动作返回失败回执"迁移功能未接入" |
| `executeWorkflowAction` | 按 action 分派到状态机或迁移函数，统一把错误映射为失败回执，绝不抛未处理异常 |
| `retryOnStaleVersion` | 供程序化调用方（run-manager 等）使用：以"重读状态 → 重算更新 → 重写"的回调形式执行更新，遇版本冲突自动重读重算重写，达到上限后返回失败 |
| `requireRequirement` | 解析并校验 requirement 与 cwd 得到身份，缺失时返回阻塞回执 |
| `formatReceipt` | 生成简短成功/失败文案与结构化 details；版本冲突以状态机结果的 `staleVersion` 判别并单点追加"请重新查询后重试"；失败文案中的绝对路径一律脱敏 |
| `listRequirements` | 列出本仓库本机数据中的需求及阶段，供续接选择 |
| `currentVersion` | 计算当前版本：`definitionFingerprint` 为 `<cwd 仓库根>/.pi-company/requirements/<reqId>/` 下全部文件按相对路径排序后的（路径、NUL 分隔、内容）sha256（目录缺失记 `none`；符号链接经 realpath 解析后须仍位于仓库根内，否则跳过；只对目录链接做防环去重，深度上限 32），`codeHead` 为 `git rev-parse HEAD`（LC_ALL=C，10 秒超时）；advance/task-finish/resume-check 用它作为状态机的当前版本 |

### extensions/workflow.ts
| 函数名 | 职责 |
|---|---|
| `workflowExtension` | 默认导出：在窗口注册 `pi_company_workflow`，渲染只显示回执文本 |

## 协作关系
- 业务失败的表达：`pi_company_workflow` 的 `execute` 在业务失败时抛出（错误消息即原回执文本），因为 SDK 只把抛出识别为工具 isError；成功回执形状不变。主会话与守护进程内会话共用同一实现，不做二次包装。
- 状态动作调用 `runtime/workflow-state.ts`；迁移动作经 `createWorkflowTool` 注入的处理器分派（由 migration 单元提供 `runtime/migration.ts` 并在窗口扩展里注入）；身份经 identity；运行记录经 `runtime/run-store.ts`。
- 需求代理会话通过 `createWorkflowTool` 注册同一工具；守护进程的 run-manager 在派工与交付核对时直接调用 `executeWorkflowAction`，并对可能并发的更新走 `retryOnStaleVersion`，不带旧 version 盲目重试。
- 模型调用方收到版本冲突回执后自行重新 `query` 再提交。

## 验证方式
- 测试入口：`createWorkflowTool` 返回对象的 execute；`executeWorkflowAction`；`retryOnStaleVersion`
- 测试输入：隔离数据区；需求 `2026-09-08.fixture`；运行记录夹具（含 work/review/acceptance 结构化结果与提议形状，部分绑定到别的需求或旧版本）
- 预期结果：
  - `init` 后 `query` 返回阶段 draft 与 version 1；带 `fields:["stage"]` 的查询只返回阶段
  - `update` 只提交 note 与正确 version 时成功，回执含需求、变更字段 note 与新版本，不含整份状态；提交未知字段或把 stage 混入 update 被整体拒绝，note 未写入；`followUpIssues` 追加成功且不改任务表
  - 两个调用方用同一 version 先后 `update`，第二次失败回执含"请重新查询后重试"，第一次内容保留；`retryOnStaleVersion` 在同样交错下重读后写入成功且两次更新都保留
  - `advance` 到 accepted 时 runId 指向的运行无 acceptance 结果、或结果绑定到别的需求/旧版本时，失败回执列出缺失或不匹配项；参数中出现 evidence/shape 等未定义字段被 schema 拒绝
  - `retreat` reviewing→executing 附 reason 与 decisionId 成功；缺 decisionId 或目标阶段不在允许路径失败
  - `reject` 无 decisionId 失败；`task-finish` runId 指向的运行缺交付证据失败，齐全成功后任务 done
  - `shape-confirm` 以 runId 读取提议形状：形状不含黑盒验收且无 decisionId 失败，附 decisionId 成功
  - `resume-check` 对无状态需求返回阻塞而非完成；`list` 返回两个进行中需求；未注入迁移处理器时 `migrate-preflight` 返回失败回执而不抛出
  - 写入过程被模拟为失败时回执为失败或结果不明，不返回成功
- [x] 定向查询与局部更新
- [x] 版本冲突提示与程序化重读重写
- [x] 以运行身份取证据的各动作门禁回执
- [x] 回退动作
- [x] 保存异常不虚报
