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
  action: Type.Union([Type.Literal("run"), Type.Literal("status"), Type.Literal("wait"), Type.Literal("list"), Type.Literal("cancel"), Type.Literal("submit")]),
  role: Type.Optional(Type.String()),
  task: Type.Optional(Type.String({ pattern: "^T-\\d+$" })),
  instructions: Type.Optional(Type.String()),
  writePaths: Type.Optional(Type.Array(Type.String())),
  readPaths: Type.Optional(Type.Array(Type.String())),
  dependencies: Type.Optional(Type.Array(Type.String())),
  outputSchema: Type.Optional(Type.Unknown()),
  runId: Type.Optional(Type.String()),
  result: Type.Optional(Type.Unknown()),          // submit：需求代理自行完成任务的结构化交付（与实现角色相同的形状）
  reportPath: Type.Optional(Type.String()),        // run 派验收者时必填：仓库内的验收报告路径
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
  rationale: Type.String({ minLength: 1 }),
}, { additionalProperties: false });
```

系统提示骨架（顺序固定）：角色定义正文 → 需求身份与工作目录 → 规范索引与需求文档位置 → 可用角色目录（名称与职责） → 工具使用规则（先提议形状并等确认；状态只经运行信息工具；提问只经 `pi_company_ask`；独立问题只经运行信息工具写入后续问题清单，不新增任务；不得直接联系其他需求代理）→ 交付核对要求 → 当前已确认形状（续接或补充时）。

## 函数清单
### daemon/requirement-agent.ts
| 函数 | 职责 |
|---|---|
| `createRequirementAgentSession` | 会话工具集：四个专属工具 + 真实 `pi_company_workflow` + `decision_record`（其定义抽到 `runtime/decision-record-tool.ts` 供窗口扩展与守护进程会话共用）；handle 的 `stop()` 透传角色会话的停止结果（先停 Shell、abort 有界等待），不自造「已停止」值；需求代理没有结构化提交，需求到达 accepted/rejected 时经 `finalize()` 正常终结；用户停止时经 `stop()` 收尾；校验需求已确认（阶段为已确认之后、且非已拒绝/已验收）与唯一性（同需求 `kind:"requirement"` 且非终态的运行存在即返回其 runId；`interrupted` 属可续接而非活动，不计入），通过 SQLite 活动需求唯一索引避免并发双建（数据库异常按 `{ok:false, reason}` 返回）；使用注入的守护进程 `RunStore`（真实 `daemonStartedAt`），创建需求代理角色会话并注册专属工具；建会话失败把运行标 failed 并附原因 |
| `buildRequirementAgentPrompt` | 按骨架拼装需求代理提示并**追加**在宿主默认系统提示与角色会话提示之后（不替换宿主提示与角色会话的读写范围/结构化提交/MCP 段；角色定义正文已由角色会话提示承载，此处不重复）：需求身份与工作目录 → 规范索引与需求文档位置 → 可用角色目录（名称与职责，描述折叠为单行） → 工具使用规则（先提议形状并等确认；形状默认含白盒审查与黑盒验收；状态只经运行信息工具；提问只经 `pi_company_ask`；补充改变任务集或形状须重新提议、否则并入；独立问题只经运行信息工具写入后续问题清单，不新增任务；不得直接联系其他需求代理）→ 交付核对要求（自行完成的任务须经 `pi_company_agent` submit 提交交付再 task-finish）→ 当前已确认形状（续接或补充时） |
| `registerAgentTool` | `pi_company_agent`：run 校验角色在目录内、任务与角色在已确认形状内、写入范围合法后经注入的 dispatch 派角色；status/wait/list/cancel 转调 dispatch；submit 只接受已确认形状中角色序列为空（自行完成）的任务，否则拒绝并要求重新提议；把该任务的结构化交付落为一条已完成的子运行（`kind:"role"`、role 为需求代理自身角色名、parentRunId 为本运行、task 为该任务、result 含 phase/verdict/binding，binding 取运行信息工具的当前版本）并返回其 runId 供 task-finish 核对 |
| `checkWritePaths` | 每个 writePath 的 realpath 必须位于本需求 cwd 内，且位于已确认形状中该任务声明的某个 writePath 之内（包含关系，目录授权其下文件）；任一越界拒绝并列出越界路径 |
| `registerAskTool` | `pi_company_ask`：经 relay.ask（载荷带仓库身份与需求身份）提问；返修门禁与轮次必须成对提供，系统固定“继续返修 / 停止”选项；只有明确选择继续才记录该门禁、该轮次的用户授权，撤回不写决定，写入失败不返回成功；提问期间运行记录置 `waiting_answer`，答复或撤回后回 `running`（多问并行按计数，运行记录更新失败时计数回退，不留永久待答态）；会话内层已为终态时 `state()` 返回内层终态而非待答；响应工具调用的 AbortSignal：暂停/停止时撤回提问、结束等待并清理待答态 |
| `registerProposeShapeTool` | `pi_company_propose_shape`：校验形状可执行（每个任务 id 匹配 `^T-\d+$`、roles ⊆ 角色目录、writePaths 均在 cwd 内、waitFor.repo 为本工作区成员仓库身份）；把提议落为一条已完成的规划子运行（`kind:"role"`、role 为需求代理自身角色名、task 为 plan、result 含 phase plan / verdict PASS / proposedShape / 真实 binding）；经 relay.ask 以选项形式取得确认（选项：确认 / 重新提议；确认文案列出每个任务的角色、写入范围与跨仓等待）；跳过门禁时追加用户决定；确认后以该规划子运行的 runId 调用运行信息工具 `shape-confirm`，回执附规划运行编号；规划产物经检查后推进 planned，形状确认后再推进 executing；未确认或任一步失败把规划子运行标 failed 并返回原因；`waitFor.requirement` 的格式在提议期一并校验 |
| `injectSupplement` | 把主会话转发的补充以引导消息注入会话，引导语要求判断是否改变任务集或形状：改变则重新提议，否则并入 |
| `assertShapeAllows` | 判断派工的任务、角色是否在已确认形状内，否则要求重新提议 |
| `awaitCrossRepoStage` | 任务声明 waitFor 时校验 repo 为本工作区成员仓库身份，读取对方仓库本机流程数据核对阶段（阶段顺序复用 workflow-state 导出的序列）；未达则拒绝并给出原因；对方为已拒绝给出终止性原因；数据缺失、损坏或需求名不合法都按错误原因返回，不抛出、不当作"尚未到达" |

## 协作关系
`extensions/decision-record.ts` 只保留窗口侧注册，工具定义由 `runtime/decision-record-tool.ts` 提供并同时注册进需求代理会话；宿主默认系统提示原样保留、不做任何剔除或改写；`daemon/run-manager.ts` 调用 `createRequirementAgentSession`（复用 `daemon/role-session.ts` 的会话创建，传入守护进程的 `RunStore` 与工作区成员仓库身份集合）；`pi_company_agent` 经注入的 dispatch 接口转调 `RunManager.dispatchRole`；`pi_company_ask` 经注入的 relay 接口（`ask(input, { signal })`，载荷含 repoId 与 requirement）转调 `daemon/relay-queue.ts`；形状与状态经 `runtime/workflow-tool.ts` 的 `executeWorkflowAction`（证据与形状只以 runId 传递；规划证据与自行完成的交付证据都由需求代理自身角色名的已完成子运行承载）；`pi_company_workflow` 的业务失败以抛出表达（SDK 只把抛出识别为 isError，07 已同步），不在本单元另做包装；决策经 `runtime/decisions.ts`；路径边界经 `runtime/identity.ts` 的仓库根。结束/阻塞的中继通知由 25 run-manager 在运行终态时发出，本单元只发需决策的提问。独立问题写入后续问题清单由运行信息工具 `update` 直接承担（其只能改已登记任务，结构上不新增任务、不改形状），不另设函数。

## 验证方式
- 测试入口：`createRequirementAgentSession` 与三个专属工具，受控 provider 脚本化；dispatch/relay 注入假对象；形状、决策、运行记录走真实 workflow-tool / decisions / RunStore
- 测试输入：未确认需求；已拒绝/已验收需求；同需求第二次派出；并发两次派出；建会话失败；脚本先提议不含黑盒验收的形状并在决策记录不可写时确认；提议含目录外角色 / 非法任务 id / 越出 cwd 的 writePaths 的形状；确认后派形状外角色；派角色目录外角色；派形状内任务但 writePaths 含形状外路径、含指向仓库外的符号链接路径、含 `../` 越出 cwd 的路径；形状声明目录、派工写其下文件；提问后从测试客户端作答；提问期间停止；转发一条不影响形状的补充与一条需新增任务的补充；审查 FAIL 后把一条独立问题记录为后续问题；自行完成任务后请求完成但缺交付证据；自行完成任务经 submit 提交后完成；waitFor 指向他仓库未达 / 已拒绝 / 数据损坏 / 非成员仓库
- 预期结果：未确认、已拒绝、已验收均拒绝；第二次返回现有 runId 且并发两次只创建一个运行；建会话失败运行为 failed 而非停在 running；决策不可写时形状未生效且执行未开始；不可执行的形状在提议阶段被拒绝；形状确认后 `advance` 到 executing 成功（规划子运行 kind role、role 为需求代理角色名、binding 与当前版本一致）；确认文案含每个任务的写入范围与跨仓等待，答复经选项判定（非选项文本不算确认）；形状外与目录外派工被拒绝并提示重新提议；三种越界 writePaths 均被拒绝并列出越界路径，形状内路径与目录授权下的文件派工成功；提问期间运行记录 state 为 waiting_answer，作答后回 running，停止时提问被撤回且终态为 stopped；relay.ask 载荷含 repoId 与 requirement；第一条补充并入，第二条触发新提议（引导语含重新提议要求）；独立问题出现在需求状态的后续问题清单、任务表与形状不变；缺证据的完成请求被工具拒绝，submit 后 task-finish 成功；waitFor 未达拒绝并给出原因、已拒绝给出终止性原因、数据损坏给出错误原因、非成员仓库拒绝；系统提示为宿主默认提示之后追加，追加部分骨架顺序固定
- [x] 派出前提、唯一性与并发
- [x] 形状提议校验、确认与门禁决定、阶段推进
- [x] 形状与目录约束派工
- [x] 写入范围与 cwd 边界（包含式）
- [x] 提问阻塞、作答、停止撤回与运行态
- [x] 补充并入或重议
- [x] 独立问题只记录
- [x] 自行完成的提交与核对
- [x] 跨仓等待的判定
