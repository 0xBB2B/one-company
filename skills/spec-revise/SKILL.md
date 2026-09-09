---
name: spec-revise
description: 已有功能改动、修 bug 或结果与预期不符时的归因与路由流程——复现问题、从本机流程数据定位所在需求与阶段、按证据归因为实现缺陷、规范缺陷或需求变更并经 decision_record 记录、按归因结果回退到对应阶段重新派出需求代理接手。用户报告 bug、要求改已有功能或说结果不对时加载；只由主会话加载。
---

# spec-revise：改动与修复的归因和路由

系统现行行为以各仓库 `.pi-company/spec/` 下的规则文件为准。本 skill 只做归因与路由，具体修复、执行与验收交回需求代理完成。

## 第一步：复现与定位

1. 按用户描述执行触发动作（命令 / 请求 / 操作），原样记录实际输出。
2. 打开相关规则文件，找到对应约束与验收；找不到即"规范无此行为"。
3. 从本机流程数据定位与本问题相关的需求及其当前阶段；找不到进行中的需求，或相关需求已 accepted，视为没有可用的进行中现场。

## 第二步：归因

只能选一：

| 归因 | 判据 |
|---|---|
| 实现缺陷 | 实际行为 ≠ 规范，且用户认同规范是对的 |
| 规范缺陷 | 实际行为 = 规范，或规范无此行为，且用户说规范写错或漏了 |
| 需求变更 | 实际行为 = 规范，用户想要不同的行为 |

用 `ask_user_question` 请用户确认归因，附复现证据与引用的规则原文；用户选择后以 actor user 调用 `decision_record` 记录该归因（归因是用户决定，不由主会话代为认定）；记录成功后才进入第三步。

## 第三步：路由

已 accepted 需求只读，不得为修复回改其中任何文件；相关修订只能随新需求或原地回退在分支上进行。

无进行中需求（历史代码，或相关需求已 accepted）：走新需求流程，从澄清与规范开始，把复现步骤写成规则文件的一条新验收。

有进行中需求，归因为实现缺陷：主会话把归因结果通过 `pi_company_forward` 转发给对应需求代理，由需求代理接手定位任务并安排返修，不涉及阶段回退。

有进行中需求，归因为规范缺陷或需求变更：主会话先修订对应规则文件的约束与验收并更新需求文档，再按需求当前所在阶段分流处理；回退前必须先确认该需求下无未停止运行，仍有未停止运行时先请求停止后再回退：

调用 `pi_company_workflow retreat` 时必须写明四个参数：`stage`（回退目标阶段）、`version`（需求当前版本号）、`reason`（回退理由）、`decisionId`（上一步记录的归因决定编号）。

| 需求当前阶段 | 处理 |
|---|---|
| planned | planned 回退到 confirmed：调用 `pi_company_workflow retreat`（stage、version、reason、decisionId）后再调用 `pi_company_dispatch` 重新派出需求代理 |
| reviewing、accepting | reviewing/accepting 回退到 executing：调用 `pi_company_workflow retreat`（stage、version、reason、decisionId）后重新派出需求代理，并要求其重新提议工作流形状 |
| confirmed、executing | confirmed/executing 无需回退：需求已处于 confirmed 或 executing，直接调用 `pi_company_forward` 转发给现有需求代理，要求其重新提议工作流形状 |
