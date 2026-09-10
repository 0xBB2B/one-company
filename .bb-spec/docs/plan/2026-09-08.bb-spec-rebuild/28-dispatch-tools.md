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
`REVIEW_PARAMETERS = { requirement: string, cwd: string, baseline: string }`（additionalProperties: false，无 mcp 字段）；审查快照由工具侧计算：`head` 为 `git rev-parse HEAD`，`fingerprint` 为 sha256 依次喂入长度前缀框定的三段：`git status --porcelain=v1 -z -uall` 输出、`git diff HEAD --binary` 输出、以及每个未跟踪文件（`??` 条目，`-uall` 展开到文件）的路径与内容（各自长度前缀；先 lstat，常规文件按内容、符号链接按其目标字符串、其它类型与不可读文件各用不同标记，单文件超过 64 MiB 只哈希大小标记）。三次 git 调用带 `timeout: 10_000`、`maxBuffer` 64 MiB、`LC_ALL: "C"`，并纳入工具 signal 中止；失败按来源归一为中文：signal 中止 → 中止回执；超时 → "git 命令超时"；输出超限 → "变更过大，超出快照上限"；空仓库（stderr 含 unknown revision）→ "仓库尚无提交，无法计算审查快照"；其它 → "git 命令执行失败"。
工具名固定：`pi_company_dispatch`、`pi_company_review`、`pi_company_reply`、`pi_company_forward`、`pi_company_agents`。五个工具 `renderShell: "self"` 且渲染零行。

## 函数清单
### extensions/dispatch.ts
| 函数名 | 职责 |
|---|---|
| `dispatchExtension` | 默认导出（只收 `pi`，与 pi 加载器单参契约一致）：注册五个工具与空渲染；工具执行时经 `extensions/lifecycle.ts` 的 `windowContext()` 取客户端集合与窗口标识，不自建连接 |
| `registerDispatchTools` 的第二参数 | `() => { clients, windowId, workspace }` 访问器（生产来自 `windowContext()`，测试注入假件）；仓库显示名取 `basename(workspace.repos[i].path)`，不做目录反推；`relay.answer` / `relay.forward` 请求带 `windowId` |
| `registerDispatchTools` | 用 `WorkspaceClients` 注册五个工具，可注入客户端便于测试 |
| `executeDispatch` | cwd 必须为绝对路径；核对需求已 confirmed（经窗口侧工作流状态查询），按 cwd 定位仓库连接，调用 `dispatch.requirement`（cwd 归属与派工权由守护进程校验），返回运行身份；守护进程以 `already_active` 拒绝时按错误 `data.runId` 返回现有身份（非失败） |
| `executeReview` | 定位需求所在仓库连接，调用 `dispatch.review` 派出提交前白盒审查者并传入审查快照，返回运行身份；守护进程校验窗口连接只能派该角色 |
| `executeReply` | 向工作区全部仓库连接广播 `relay.answer`（带 windowId），任一 accepted 即成功；有仓库不可达时回执必须带出各不可达原因，只有全部可达且明确未接受才说"已由其他窗口作答"；全部 not_found 说明问题不存在 |
| `executeForward` | 定位需求所在仓库连接，调用 `relay.forward`，返回回执 |
| `executeAgents` | 按 action 调用 `runs.*` 方法；`list` 与 `*All` 用 allSettled 汇总各仓库真实回执，每段回执以仓库显示名（目录名）标注，不可达仓库逐个列出原因；全部不可达时回执为不可达（isError）而非"无运行中的代理"；`*All` 回执只格式化已知字段（如 pausedCount/resumedCount/stoppedCount），不泛化倒出对象；续接被拒时列出原因 |
| `renderSilently` | `renderCall` / `renderResult` 共用的空组件渲染 |
| `briefResult` | 把守护进程结果压缩为运行身份 + 状态 + 一句话原因的文本；不可达原因截断到 200 字符并剥离绝对路径 |
| `callWithAbort` | 所有守护进程调用与工具 `signal` 竞速并设 30 秒上限；中止或超时的回执写明"已停止等待，守护进程可能仍在执行，请用 agents list 核对"，不宣称操作未发生 |

## 协作关系
- 派出需求代理的阶段检查与守护进程同口径：draft/rejected/accepted 拒绝，confirmed 及其后的进行中阶段（含回退到 executing 后）放行；唯一性由守护进程判定。
- 依赖 `runtime/daemon-client.ts` 的 `WorkspaceClients`（由 `extensions/lifecycle.ts` 的 `windowContext()` 提供实例与 `windowId`，30 单元落地后接线）、`runtime/protocol.ts` 方法参数类型、`runtime/workflow-state.ts` 的 `readRequirementState`（核对 confirmed）、`runtime/identity.ts` 的 `repositoryIdentity`。
- 守护进程侧对应 `daemon/server.ts` 的 `dispatch.requirement`、`relay.answer`、`relay.forward`、`runs.*`。
- 不在工具内实现任何编排，不调用 `runtime/roles.ts` 的派工关系判定；结果文本只含运行身份与简短状态。

## 验证方式
- 测试入口：`registerDispatchTools`（传入假 pi 与假 `WorkspaceClients`），取出五个工具后调用 `execute`；渲染断言调用 `renderCall` / `renderResult`。
- 测试输入：需求状态为 draft 与 confirmed 的夹具；守护进程假客户端返回已有运行、成功、首答被抢、不可达等结果。
- 预期结果：
  - 五个工具名精确为约定名称，参数 schema 拒绝多余字段；假客户端在 call 内用 `runtime/protocol.ts` 的 `validateParams` 校验每个请求（relay.* 含 windowId、dispatch.review 含 baseline 与 snapshot）。
  - draft 需求派出被拒绝并说明未确认；confirmed 需求返回运行身份；同需求再派（假客户端第二次以 already_active 错误附 data.runId 拒绝）返回同一运行身份且不表现为失败；cwd 非绝对路径被拒；守护进程假客户端返回 cwd 不属于本仓库时工具原样透出该原因。
  - 工具不含任何按角色 kind 的派工判定：假客户端记录的请求只有 `dispatch.requirement`，无角色参数。
  - `reply` 广播到工作区全部仓库，问题属于另一仓库（窗口 cwd 在仓库 A、问题来自仓库 B）时仍被接受；全部返回未接受时返回"已由其他窗口作答"而非成功。
  - `forward` 对不属于工作区的需求返回明确错误。
  - `agents list` 合并两个仓库的运行；一仓库不可达时另一仓库结果仍列出并标注不可达原因；`pause` 结果反映守护进程真实状态（`pausing` 未确认时不报已暂停）；`pauseAll` 回执含各仓库真实计数；`resumeInterrupted` 被拒时列出原因；守护进程不回应时 signal 中止在 1 秒内以中止原因失败。
  - 守护进程不可达时五个工具返回不可达原因，不在窗口内执行。
  - `renderCall` / `renderResult` 渲染零行输出。
- [x] 工具名与 schema
- [x] 派出前提与唯一性（不按 kind 判定）
- [x] 首答生效与转发回执
- [x] 控制结果按真实状态
- [x] 渲染零行
