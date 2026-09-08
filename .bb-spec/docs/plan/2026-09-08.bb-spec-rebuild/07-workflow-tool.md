---
name: workflow-tool
description: pi_company_workflow 工具：查询、初始化、局部更新、阶段推进、任务进度、形状确认、续接核对与迁移入口，窗口与守护进程共用
---
# 运行信息工具

## 目标
主会话与需求代理都通过同一个受校验工具读写需求与任务的运行信息，请求只带必要字段与已读版本，回执简短。

## 业务规则（来源：spec）
- controlled-updates：流程通过专用工具查询、初始化和修改运行信息，不通过文件编辑或命令改写；请求指定需求、可选任务与更新内容，不要求整份文档；普通字段更新与阶段推进分开校验；任一字段不合法整个请求不生效；过期版本被拒绝并提示重新读取；成功回执只含归属、变更字段、新版本与必要提示。
- document-boundary：用运行信息入口修改需求或任务定义、或以报告结论代替完成门禁的请求被拒绝。
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
    Type.Literal("advance"), Type.Literal("task-start"), Type.Literal("task-finish"), Type.Literal("task-fail"),
    Type.Literal("rollback"), Type.Literal("reject"), Type.Literal("shape-confirm"), Type.Literal("resume-check"),
    Type.Literal("migrate-preflight"), Type.Literal("migrate-apply"), Type.Literal("migrate-status")
  ]),
  requirement: Type.Optional(Type.String()),
  cwd: Type.Optional(Type.String()),
  task: Type.Optional(Type.String({ pattern: "^T-\\d+$" })),
  fields: Type.Optional(Type.Array(Type.String())),
  version: Type.Optional(Type.Integer({ minimum: 1 })),
  update: Type.Optional(Type.Object({
    note: Type.Optional(Type.String()), description: Type.Optional(Type.String()),
    agent: Type.Optional(Type.String()), commit: Type.Optional(Type.String()),
    blockedReason: Type.Optional(Type.String()), workspaceDir: Type.Optional(Type.String())
  }, { additionalProperties: false })),
  stage: Type.Optional(Type.String()),
  evidence: Type.Optional(Type.Unknown()),
  shape: Type.Optional(Type.Unknown()),
  decisionId: Type.Optional(Type.String({ pattern: "^(AI|USER)-\\d+$" })),
  runId: Type.Optional(Type.String()),
  reason: Type.Optional(Type.String()),
  confirm: Type.Optional(Type.Boolean())
}, { additionalProperties: false })
```

回执文本格式：`<需求> <动作> 成功：<变更字段或阶段>，version <n>`；失败：`<需求> <动作> 失败：<原因>`（版本冲突时附"请重新查询后重试"）。

## 函数清单

### runtime/workflow-tool.ts
| 函数名 | 职责 |
|---|---|
| `createWorkflowTool` | 生成 pi 工具定义（名称、说明、参数、执行），供窗口扩展与守护进程会话共用 |
| `executeWorkflowAction` | 按 action 分派到状态机或迁移函数，统一把错误映射为失败回执，绝不抛未处理异常 |
| `requireRequirement` | 解析并校验 requirement 与 cwd 得到身份，缺失时返回阻塞回执 |
| `formatReceipt` | 生成简短成功/失败文案与结构化 details |
| `listRequirements` | 列出本仓库本机数据中的需求及阶段，供续接选择 |

### extensions/workflow.ts
| 函数名 | 职责 |
|---|---|
| `workflowExtension` | 默认导出：在窗口注册 `pi_company_workflow`，渲染只显示回执文本 |

## 协作关系
- 状态动作调用 `runtime/workflow-state.ts`；迁移动作调用 `runtime/migration.ts`；身份经 identity。
- 需求代理会话通过 `createWorkflowTool` 注册同一工具；守护进程的 run-manager 在派工与交付核对时直接调用 `executeWorkflowAction`。

## 验证方式
- 测试入口：`createWorkflowTool` 返回对象的 execute；`executeWorkflowAction`
- 测试输入：隔离数据区；需求 `2026-09-08.fixture`
- 预期结果：
  - `init` 后 `query` 返回阶段 draft 与 version 1；带 `fields:["stage"]` 的查询只返回阶段
  - `update` 只提交 note 与正确 version 时成功，回执含需求、变更字段 note 与新版本，不含整份状态；提交未知字段或把 stage 混入 update 被整体拒绝，note 未写入
  - 两个调用方用同一 version 先后 `update`，第二次失败回执含"请重新查询后重试"，第一次内容保留
  - `advance` 到 accepted 而无黑盒证据时失败回执列出缺失前提；`reject` 无 decisionId 失败
  - `task-finish` 缺证据失败；齐全成功后任务 done
  - `shape-confirm` 形状不含黑盒验收且无 decisionId 失败，附 decisionId 成功
  - `resume-check` 对无状态需求返回阻塞而非完成；`list` 返回两个进行中需求
  - 写入过程被模拟为失败时回执为失败或结果不明，不返回成功
- [ ] 定向查询与局部更新
- [ ] 版本冲突提示
- [ ] 各动作的门禁失败回执
- [ ] 保存异常不虚报
