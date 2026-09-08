---
name: dispatch-tools
description: 主会话五个工具：派出需求代理、答复提问、转发补充、查询与控制运行；渲染抑制原始输出
---
# 主会话派工与控制工具

## 目标
主会话只用五个工具即可派出需求代理、答复它的提问、转发补充需求以及查询和控制工作区内的运行。

## 业务规则（来源：spec）
- requirement-agent：派出需求代理要求需求已经用户确认，并绑定仓库身份、需求身份与工作目录；同一需求已有活动需求代理时拒绝再派，返回现有运行身份。
- user-relay：用户答复经主会话送回需求代理；主会话判断补充是否属于本工作区进行中需求并转发，转发结果回执给主会话。
- cross-window-panel：任意窗口对本工作区任一运行执行暂停、继续、停止或续接时，请求送达对应守护进程并按真实结果更新，不以点击成功冒充执行完成；聊天区不重复展示原始运行结果与生命周期通知。
- role-catalog / requirement-agent：主会话只派出需求代理与提交前白盒审查者，不直接派出其他角色；派工权由守护进程按调用方身份判定（窗口发起 = 主会话），不按角色定义 kind 判定，窗口工具不做 kind 判定。
- builtin-execution：派工成功返回唯一运行身份，收到派工成功不等于任务完成。

## 涉及文件
- 新建 `extensions/dispatch.ts`
- 新建 `tests/dispatch-tools.test.ts`

## 成品定义
```ts
// extensions/dispatch.ts —— 五个工具的参数 schema（typebox），exec 原样落盘
export const DISPATCH_PARAMETERS = Type.Object({
  requirement: Type.String({ description: "需求目录名 <YYYY-MM-DD>.<slug>" }),
  cwd: Type.String({ description: "需求所属仓库的工作目录绝对路径" }),
}, { additionalProperties: false });

export const REPLY_PARAMETERS = Type.Object({
  questionId: Type.String(),
  answer: Type.String({ minLength: 1 }),
}, { additionalProperties: false });

export const FORWARD_PARAMETERS = Type.Object({
  requirement: Type.String(),
  cwd: Type.String(),
  message: Type.String({ minLength: 1 }),
}, { additionalProperties: false });

export const AGENTS_PARAMETERS = Type.Object({
  action: Type.Union([
    Type.Literal("list"), Type.Literal("status"), Type.Literal("pause"), Type.Literal("resume"),
    Type.Literal("stop"), Type.Literal("pauseAll"), Type.Literal("resumeAll"), Type.Literal("stopAll"),
    Type.Literal("resumeInterrupted"),
  ]),
  runId: Type.Optional(Type.String()),
  cwd: Type.Optional(Type.String()),
}, { additionalProperties: false });
```
工具名固定：`pi_company_dispatch`、`pi_company_review`、`pi_company_reply`、`pi_company_forward`、`pi_company_agents`。

## 函数清单
### extensions/dispatch.ts
| 函数名 | 职责 |
|---|---|
| `dispatchExtension` | 默认导出：注册五个工具，并注册它们的空渲染以抑制原始输出 |
| `registerDispatchTools` | 用 `WorkspaceClients` 注册五个工具，可注入客户端便于测试 |
| `executeDispatch` | 核对需求已 confirmed（经窗口侧工作流状态查询），按 cwd 定位仓库连接，调用 `dispatch.requirement`（cwd 归属与派工权由守护进程校验），返回运行身份或已有身份 |
| `executeReview` | 定位需求所在仓库连接，调用 `dispatch.review` 派出提交前白盒审查者并传入审查快照，返回运行身份；守护进程校验窗口连接只能派该角色 |
| `executeReply` | 调用 `relay.answer`，返回是否被接受（首答生效）或已由他窗口作答 |
| `executeForward` | 定位需求所在仓库连接，调用 `relay.forward`，返回回执 |
| `executeAgents` | 按 action 调用 `runs.*` 方法，`list` 汇总工作区内全部仓库结果 |
| `renderSilently` | `renderCall` / `renderResult` 共用的空组件渲染 |
| `briefResult` | 把守护进程结果压缩为运行身份 + 状态 + 一句话原因的文本 |

## 协作关系
- 依赖 `runtime/daemon-client.ts` 的 `WorkspaceClients`（由 `extensions/lifecycle.ts` 提供实例）、`runtime/protocol.ts` 方法参数类型、`runtime/workflow-state.ts` 的 `readRequirementState`（核对 confirmed）、`runtime/identity.ts` 的 `repositoryIdentity`。
- 守护进程侧对应 `daemon/server.ts` 的 `dispatch.requirement`、`relay.answer`、`relay.forward`、`runs.*`。
- 不在工具内实现任何编排，不调用 `runtime/roles.ts` 的派工关系判定；结果文本只含运行身份与简短状态。

## 验证方式
- 测试入口：`registerDispatchTools`（传入假 pi 与假 `WorkspaceClients`），取出五个工具后调用 `execute`；渲染断言调用 `renderCall` / `renderResult`。
- 测试输入：需求状态为 draft 与 confirmed 的夹具；守护进程假客户端返回已有运行、成功、首答被抢、不可达等结果。
- 预期结果：
  - 五个工具名精确为约定名称，参数 schema 拒绝多余字段。
  - draft 需求派出被拒绝并说明未确认；confirmed 需求返回运行身份；同需求再派返回同一运行身份且不新建；守护进程假客户端返回 cwd 不属于本仓库时工具原样透出该原因。
  - 工具不含任何按角色 kind 的派工判定：假客户端记录的请求只有 `dispatch.requirement`，无角色参数。
  - `reply` 在他窗口已作答时返回"已由其他窗口作答"而非成功。
  - `forward` 对不属于工作区的需求返回明确错误。
  - `agents list` 合并两个仓库的运行；`pause` 结果反映守护进程真实状态（`pausing` 未确认时不报已暂停）。
  - 守护进程不可达时五个工具返回不可达原因，不在窗口内执行。
  - `renderCall` / `renderResult` 渲染零行输出。
- [ ] 工具名与 schema
- [ ] 派出前提与唯一性（不按 kind 判定）
- [ ] 首答生效与转发回执
- [ ] 控制结果按真实状态
- [ ] 渲染零行
