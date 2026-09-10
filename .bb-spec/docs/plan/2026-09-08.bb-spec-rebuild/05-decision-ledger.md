---
name: decision-ledger
description: 本机决策记录：AI 与用户决定按需求追加、字段校验、替代关系、并发编号与回执，以及 decision_record 工具
---
# 本机决策记录与工具

## 目标
主会话与需求代理在行动前都能把材料性决定追加到本机用户数据区，得到可查询回执；记录不依赖需求目录存在，历史不可改写。

## 业务规则（来源：spec）
- decision-append：主会话通过决策记录工具记录材料性决定，AI 决定与用户决定分开保存并共同归属一个需求；工具校验角色字段、必需内容和替代关系，持久保存并重新读取确认后才返回成功回执，失败不得返回成功或放行关联动作；AI 决定必须含范围、依据、后续动作，用户决定必须含后续影响且不得混入 AI 专用内容；改选只追加新决定并指向本需求已存在的决定，不改写、删除或重新编号，已完成需求亦如此；并发追加各得唯一递增编号；损坏或替代关系非法拒绝追加。
- local-ownership：首次合法记录允许需求文档与 worktree 尚不存在；仓库或需求身份缺失、冲突或无法核对时拒绝写入。
- product-decision-escalation：用户忽略、取消或未回答的问题不写入任何记录。

## 涉及文件
- 新建：runtime/decisions.ts
- 新建：extensions/decision-record.ts（替换 main 上同名文件的整体内容）
- 新建：tests/decision-ledger.test.ts
- 新建：tests/decision-record-tool.test.ts

## 成品定义

`decision_record` 工具参数（typebox，`additionalProperties: false`）：

```ts
Type.Object({
  requirement: Type.String({ description: "需求身份，形如 2026-09-08.order-export" }),
  cwd: Type.Optional(Type.String({ description: "用于解析仓库身份的目录，默认当前工作目录" })),
  actor: Type.Union([Type.Literal("ai"), Type.Literal("user")]),
  source: Type.String({ minLength: 1, description: "产生决定的流程步骤" }),
  trigger: Type.String({ minLength: 1 }),
  decision: Type.String({ minLength: 1 }),
  alternatives: Type.Array(Type.String({ minLength: 1 })),
  effects: Type.Array(Type.Union([
    Type.Literal("behavior"), Type.Literal("scope"), Type.Literal("authorization"), Type.Literal("architecture"),
    Type.Literal("risk"), Type.Literal("recovery"), Type.Literal("flow-branch")
  ]), { minItems: 1 }),
  scope: Type.Optional(Type.Union([Type.String({ minLength: 1 }), Type.Null()])),
  basis: Type.Optional(Type.Union([Type.Array(Type.String({ minLength: 1 })), Type.Null()])),
  action: Type.Optional(Type.Union([Type.String({ minLength: 1 }), Type.Null()])),
  impact: Type.Optional(Type.Union([Type.String({ minLength: 1 }), Type.Null()])),
  supersedes: Type.Optional(Type.Union([Type.Array(Type.String({ pattern: "^(AI|USER)-\\d+$" })), Type.Null()]))
}, { additionalProperties: false })
```

记录行（canonical JSON，一行一条）字段顺序：`id`、`recordedAt`、`actor`、`source`、`requirement`、`trigger`、`decision`，随后 AI 行为 `scope`、`basis`、`alternatives`、`action`，用户行为 `alternatives`、`impact`；两类都可有 `supersedes`。编号 `AI-001` / `USER-001` 起递增，允许空洞。回执字段：`schema: "decision-receipt/v1"`、`receiptId`、`decisionId`、`actor`、`repoId`、`requirement`、`recordId`、`sequence`、`decisionHash`（该行 sha256）、`recordedAt`。

## 函数清单

### runtime/decisions.ts
| 函数名 | 职责 |
|---|---|
| `validateDecisionInput` | 按 actor 校验必需与禁止字段（AI 需 scope/basis/action 且无 impact；用户需 impact 且无 AI 专用字段），空数组与 null 视为缺失 |
| `appendDecision` | 解析仓库与需求身份，在 SQLite 短事务内读取两类决策流、校验 supersedes 指向本需求已存在的更早决定且无环、分配下一个编号、追加 UUIDv7 事件记录，返回回执 |
| `readDecisions` | 读取指定需求的 AI 或用户记录并逐行校验 |
| `inspectDecision` | 按编号查询单条记录 |
| `nextDecisionId` | 由既有编号计算下一个编号（最大后缀 + 1） |
| `buildRecord` | 按固定字段顺序组装记录对象 |

### extensions/decision-record.ts
| 函数名 | 职责 |
|---|---|
| `decisionRecordExtension` | 默认导出：注册 `decision_record` 工具，参数校验后调用 `appendDecision`，把回执转成简短文本与 details |
| `describeReceipt` | 生成"已记录 <id>：<位置> 第 <n> 行"文案 |

## 协作关系
- `appendDecision` 依赖 identity（仓库/需求身份与目录）、database（短事务与顺序事件）。
- 需求代理会话（守护进程内）复用同一 `decisionRecordExtension` 注册工具，因此工具实现不得依赖窗口 UI。
- 后续 workflow-state 的阶段推进与形状确认要求先有对应决定回执，由调用方传入 `decisionId` 核对。

## 验证方式
- 测试入口：`runtime/decisions.ts` 导出函数；`extensions/decision-record.ts` 默认导出（用假 pi 对象收集注册的工具后直接调用其 execute）
- 测试输入：临时仓库夹具、隔离 HOME；需求身份 `2026-09-08.fixture`（需求目录不存在）
- 预期结果：
  - 需求目录不存在时首次 AI 决定成功，回执 decisionId 为 AI-001，recordId 位于本机数据区而非仓库内，行内容 sha256 等于 decisionHash
  - 用户决定含 basis 抛"用户决定不得携带 basis"；AI 决定缺 action 抛"AI 决定必须同时提供 scope、basis、action"；effects 为空数组被参数校验拒绝
  - supersedes 指向不存在的 AI-009 或指向更晚编号被拒绝；合法替代追加后旧行逐字不变
  - 20 个并发 appendDecision 得到 20 个不同编号且文件 20 行
  - 记录文件被插入一行非 canonical 内容后追加被拒绝且文件未变
  - 同一仓库两个 worktree 下追加的记录落在同一文件；不同仓库同名需求落在不同文件
  - 工具 execute 的成功文本以"已记录 AI-001"开头；参数含未知字段被拒绝
- [x] 无需求目录首次记录
- [x] 两类字段校验
- [x] 替代关系与历史不变
- [x] 并发编号与损坏拒绝
- [x] 工具注册与回执
