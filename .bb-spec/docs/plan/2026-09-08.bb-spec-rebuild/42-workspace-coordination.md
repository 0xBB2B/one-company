---
name: workspace-coordination
description: 多仓库工作区协调：跨仓库等待条件按本机状态核对，契约变更请求经主会话裁定转发，需求代理读写限本仓库
---
# 多仓库工作区协调

## 目标
一次需求涉及多个仓库时，各仓库的需求代理各干各的，跨仓库顺序与契约变更都经可核对的通道，而不是代理之间私聊。

## 业务规则（来源：spec）
- workspace-coordination：需求涉及多个成员仓库时，主会话把跨仓库契约写入每个相关仓库的规范并建立各自需求文档，确认后为每个仓库派出各自的需求代理；需求代理不得读写其他仓库。
- workspace-coordination：需求代理需要变更跨仓库契约时经中继提交主会话裁定，不得直接联系其他需求代理；裁定后主会话更新各仓库契约并转发补充，未裁定前不得按变更后契约实现。
- workspace-coordination：工作流形状声明等待另一成员仓库需求到达某阶段时，从本机流程数据核对该阶段后才继续；核对失败或数据缺失时等待并显示原因。
- user-relay：需求代理之间不得直接互发消息。

## 涉及文件
- 修改 `daemon/run-manager.ts`（任务 `waitFor` 的排队等待与周期放行）
- 修改 `daemon/requirement-agent.ts`（`pi_company_ask` 增加契约变更请求类型；`waitFor` 判定的数据校验）
- 修改 `daemon/relay-queue.ts`（提问记录携带类型 `contract_change`）
- 修改 `runtime/protocol.ts`（`relay.question` 载荷含 `kind`）
- 新建 `tests/workspace-coordination.test.ts`

## 函数清单
### daemon/run-manager.ts
| 函数名 | 职责 |
|---|---|
| `RunManager.dispatchRole`（扩展） | 任务声明 `waitFor` 且核对未到达时不拒绝：创建 `queued` 运行记录并把等待原因写入 `stateReason`，登记为等待中的派工（运行列表可见"等待另一仓库…"）；核对失败或数据缺失同样进入等待并记原因 |
| `RunManager.scheduleWaitingTasks` | 由守护进程随 RunManager 启动、按注入时钟周期重新核对全部等待中的派工，到达即按原派工参数启动（queued → running）；一轮未结束不重入；`stop`/`stopAll`/`close` 清除等待项并停止心跳 |
### daemon/requirement-agent.ts
| 函数名 | 职责 |
|---|---|
| `ASK_PARAMETERS`（扩展） | 新增可选 `contractChange: { field, reason, affectedRepos[] }`；给出时提问类型为契约变更 |
| `registerAskTool`（扩展） | 契约变更请求与普通提问走同一条路径：置 `waiting_answer`、响应 AbortSignal、经 relay.ask 提交，载荷带 `kind: "contract_change"` 与字段/理由/影响仓库；裁定文本作为答复返回；未裁定前工具不返回 |
| `awaitCrossRepoStage`（加固） | 对方需求状态数据缺失、非对象或无 `stage` 字段时返回带原因的等待结果，不抛出 |
### daemon/relay-queue.ts
| 函数名 | 职责 |
|---|---|
| `RelayQueue.ask`（扩展） | 提问记录与广播载荷携带 `kind`（`question` / `contract_change`），主会话据此展示为契约变更裁定；需求代理之间无任何直达通道（结构性保证：无对应工具，转发只按需求身份路由） |
## 协作关系
- RunManager 与需求代理调用 `awaitCrossRepoStage` 核对同一阶段（读取 `runtime/workflow-state.ts` 的需求状态、`runtime/identity.ts` 的数据目录）。
- 契约变更裁定后由主会话用 `pi_company_forward` 转发补充；本模块不实现裁定。
- 命令在 macOS 隔离边界内执行，授权仓库可读，其他仓库及本机流程数据库不可读写；未提供隔离后端的平台拒绝执行。

## 验证方式
- 测试入口：经真实入口——需求代理会话的 `pi_company_agent` run（waitFor 排队与放行，经 RunManager 单元级或守护进程协议）、`pi_company_ask`（contractChange）、角色会话工具门禁（跨仓库读写）、`RelayQueue.ask`/`forward`（两个临时仓库的本机数据目录；守护进程测试夹具）。
- 测试输入：后端需求状态分别为 executing 与 accepted；缺失数据库记录；角色尝试读写另一仓库路径；需求代理发起契约变更；需求代理尝试直接向另一需求代理发送消息。
- 预期结果：
  - 后端 executing 时前端联调任务的派工进入 queued 且 stateReason 含等待原因、不启动；后端到达 accepted 后随下一次心跳自动启动（running）；状态缺失或数据损坏时保持等待并显示原因；stop 后等待项清除不再放行。
  - 另一仓库路径的读写与命令被拒绝。
  - 需求代理经 `pi_company_ask` 带 contractChange 提问后，中继队列的提问记录与广播载荷 kind 为 contract_change 且含字段/理由/影响仓库与需求身份，运行记录为 waiting_answer；停止时提问被撤回；需求代理无任何直达另一需求代理的通道，转发只按需求身份路由。
- [x] 跨仓库等待核对
- [x] 本仓库边界
- [x] 契约变更经中继且不互发
