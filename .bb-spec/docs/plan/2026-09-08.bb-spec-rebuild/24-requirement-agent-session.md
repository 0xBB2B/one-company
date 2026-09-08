---
name: requirement-agent-session
description: 需求代理会话：专属工具（派角色、提问、提议形状、运行信息、决策）、同需求唯一、补充并入、独立问题只记录、派工写入范围校验、自行完成任务仍经交付核对
---
# 需求代理会话

## 目标
完成后主会话确认需求后可派出需求代理，它在守护进程内持有需求上下文，经中继提议形状、按形状派角色或自行完成任务，独立问题只记录不扩形状，并只通过工具推进状态。

## 业务规则（来源：spec）
- requirement-agent：派出要求需求已确认并绑定仓库身份、需求身份与工作目录；同需求已有活动需求代理时拒绝再派并返回现有身份；由它完成规划并提议任务集与形状，确认后才执行；可自行完成简单任务，但须提交与实现角色相同的交付证据并经工具核对；补充需求改变任务集或形状时重新提议，否则并入；结束、阻塞或需决策经中继通知。
- workflow-shape：形状含任务集、每任务角色序列与门禁声明，默认含白盒审查与黑盒验收；跳过门禁须用户决定记录成功；超出形状的派工被拒绝；角色不得向下派。
- review-failure-handling：归因为独立问题的条目只写入需求的后续问题清单，不新增任务、不改形状。
- workspace-coordination：需求代理与角色不得读写其他仓库。
- user-relay：提问带需求身份进入队列，答复经主会话送回；需求代理之间不得直接互发消息。
- role-catalog：需求代理只派角色目录内的角色。

## 涉及文件
- 新建：`daemon/requirement-agent.ts`
- 新建：`tests/requirement-agent-session.test.ts`

## 成品定义

需求代理专属工具参数：

```ts
import { Type } from "typebox";
export const AGENT_PARAMETERS = Type.Object({
  action: Type.Union([Type.Literal("run"), Type.Literal("status"), Type.Literal("wait"), Type.Literal("list"), Type.Literal("cancel")]),
  role: Type.Optional(Type.String()),
  task: Type.Optional(Type.String({ pattern: "^T-\\d+$" })),
  instructions: Type.Optional(Type.String()),
  writePaths: Type.Optional(Type.Array(Type.String())),
  readPaths: Type.Optional(Type.Array(Type.String())),
  dependencies: Type.Optional(Type.Array(Type.String())),
  outputSchema: Type.Optional(Type.Unknown()),
  runId: Type.Optional(Type.String()),
}, { additionalProperties: false });
export const ASK_PARAMETERS = Type.Object({
  question: Type.String({ minLength: 1 }),
  options: Type.Optional(Type.Array(Type.Object({ label: Type.String(), description: Type.String() }, { additionalProperties: false }))),
  recommended: Type.Optional(Type.String()),
}, { additionalProperties: false });
export const PROPOSE_SHAPE_PARAMETERS = Type.Object({
  tasks: Type.Array(Type.Object({
    id: Type.String(), title: Type.String(),
    roles: Type.Array(Type.String()),          // 空数组 = 需求代理自行完成
    dependsOn: Type.Array(Type.String()),
    writePaths: Type.Array(Type.String()),
    waitFor: Type.Optional(Type.Object({ repo: Type.String(), requirement: Type.String(), stage: Type.String() }, { additionalProperties: false })),  // 等待另一成员仓库需求到达某阶段
  }, { additionalProperties: false }), { minItems: 1 }),
  gates: Type.Object({ whiteboxReview: Type.Boolean(), blackboxAcceptance: Type.Boolean() }, { additionalProperties: false }),
  rationale: Type.String(),
}, { additionalProperties: false });
```

系统提示骨架（顺序固定）：角色定义正文 → 需求身份与工作目录 → 规范索引与需求文档位置 → 可用角色目录（名称与职责） → 工具使用规则（先提议形状并等确认；状态只经运行信息工具；提问只经 `pi_company_ask`；独立问题只经运行信息工具写入后续问题清单，不新增任务；不得直接联系其他需求代理）→ 交付核对要求 → 当前已确认形状（续接或补充时）。

## 函数清单
### daemon/requirement-agent.ts
| 函数 | 职责 |
|---|---|
| `createRequirementAgentSession` | 校验需求已确认与唯一性，创建需求代理角色会话并注册专属工具 |
| `buildRequirementAgentPrompt` | 按骨架拼装系统提示 |
| `registerAgentTool` | `pi_company_agent`：校验角色在目录内、任务与角色在已确认形状内、写入范围合法后，派角色、查状态、等待、取消 |
| `checkWritePaths` | 派工校验：每个 writePath 的 realpath 必须位于本需求 cwd 内，且落在已确认形状中该任务声明的 writePaths 范围内；任一越界拒绝并列出越界路径 |
| `registerAskTool` | `pi_company_ask`：经中继队列提问，运行态置 `waiting_answer`，阻塞到答复或停止 |
| `registerProposeShapeTool` | `pi_company_propose_shape`：把形状写入本运行记录、经提问取得确认，跳过门禁时追加用户决定，确认后以本运行 runId 调用运行信息工具 `shape-confirm` |
| `recordFollowUpIssue` | 把归因为独立问题的条目经运行信息工具 `update.followUpIssues` 追加到需求的后续问题清单；不创建任务、不触发重新提议 |
| `injectSupplement` | 把主会话转发的补充以引导消息注入会话 |
| `assertShapeAllows` | 判断派工的任务、角色是否在已确认形状内，否则要求重新提议 |
| `awaitCrossRepoStage` | 任务声明 waitFor 时读取对方仓库本机流程数据核对阶段，未达则等待并显示原因 |

## 协作关系
`daemon/run-manager.ts` 调用 `createRequirementAgentSession`（复用 `daemon/role-session.ts` 的会话创建）；`pi_company_agent` 转调 `RunManager.dispatchRole`；`pi_company_ask` 转调 `daemon/relay-queue.ts`；形状与状态经 `runtime/workflow-tool.ts` 的 `executeWorkflowAction`（证据与形状只以 runId 传递）；决策经 `runtime/decisions.ts`；路径边界经 `runtime/identity.ts` 的仓库根。

## 验证方式
- 测试入口：`createRequirementAgentSession` 与三个专属工具，受控 provider 脚本化
- 测试输入：未确认需求；同需求第二次派出；脚本先提议不含黑盒验收的形状并在决策记录不可写时确认；确认后派形状外角色；派角色目录外角色；派形状内任务但 writePaths 含形状外路径、含指向仓库外的符号链接路径、含 `../` 越出 cwd 的路径；提问后从测试客户端作答；转发一条不影响形状的补充与一条需新增任务的补充；审查 FAIL 后把一条独立问题记录为后续问题；自行完成任务后请求完成但缺交付证据
- 预期结果：未确认拒绝；第二次返回现有 runId；决策不可写时形状未生效且执行未开始；形状外与目录外派工被拒绝并提示重新提议；三种越界 writePaths 均被拒绝并列出越界路径，形状内路径的派工成功；提问期间运行态为 waiting_answer，作答后继续；第一条补充并入，第二条触发新提议；独立问题出现在需求状态的后续问题清单、任务表与形状不变；缺证据的完成请求被工具拒绝
- [ ] 派出前提与唯一性
- [ ] 形状提议、确认与门禁决定
- [ ] 形状与目录约束派工
- [ ] 写入范围与 cwd 边界
- [ ] 提问阻塞与作答
- [ ] 补充并入或重议
- [ ] 独立问题只记录
- [ ] 自行完成仍受核对
