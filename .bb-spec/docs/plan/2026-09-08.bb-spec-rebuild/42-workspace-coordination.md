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
- 修改 `daemon/run-manager.ts`（任务 `waitFor` 核对）
- 修改 `daemon/requirement-agent.ts`（`pi_company_ask` 增加契约变更请求类型；禁止跨仓库派工）
- 修改 `daemon/role-session.ts`（路径校验限本仓库）
- 修改 `daemon/relay-queue.ts`（`contract_change` 通知类型）
- 新建 `tests/workspace-coordination.test.ts`

## 函数清单
### daemon/run-manager.ts
| 函数名 | 职责 |
|---|---|
| `checkWaitFor` | 读取另一仓库本机需求状态，核对是否到达指定阶段；缺失或未到达返回等待原因 |
| `scheduleWaitingTasks` | 周期性重新核对等待中的任务并在满足时放行 |
### daemon/requirement-agent.ts
| 函数名 | 职责 |
|---|---|
| `requestContractChange` | 以中继通知类型 `contract_change` 提交变更请求（含字段、理由、影响仓库），并把本任务置为等待答复 |
| `rejectCrossRepoDispatch` | 派工目标路径不在本仓库时拒绝 |
### daemon/role-session.ts
| 函数名 | 职责 |
|---|---|
| `assertInsideRepo` | 读、写、命令工作目录全部限定在本仓库根内 |
### daemon/relay-queue.ts
| 函数名 | 职责 |
|---|---|
| `notifyContractChange` | 生成契约变更通知并投递主会话；需求代理直接互发的请求被拒绝 |

## 协作关系
- `checkWaitFor` 依赖 `runtime/workflow-state.ts` 的 `readRequirementState` 与 `runtime/identity.ts`（另一仓库的数据目录）。
- 契约变更裁定后由主会话用 `pi_company_forward` 转发补充；本模块不实现裁定。
- 与 `runtime/write-guard.ts` 配合：跨仓库路径在写入守卫层也被拒绝。

## 验证方式
- 测试入口：`checkWaitFor`、`requestContractChange`、`assertInsideRepo`、`notifyContractChange`（两个临时仓库的本机数据目录；守护进程测试夹具）。
- 测试输入：后端需求状态分别为 executing 与 accepted；缺失状态文件；角色尝试读写另一仓库路径；需求代理发起契约变更；需求代理尝试直接向另一需求代理发送消息。
- 预期结果：
  - 后端 executing 时前端联调任务显示等待与原因且不执行；accepted 后核对通过放行；状态缺失时保持等待并显示缺失。
  - 另一仓库路径的读写与命令被拒绝。
  - 契约变更请求以 `contract_change` 通知到达主会话队列，本任务进入等待答复；直接互发被拒绝且未送达。
- [ ] 跨仓库等待核对
- [ ] 本仓库边界
- [ ] 契约变更经中继且不互发
