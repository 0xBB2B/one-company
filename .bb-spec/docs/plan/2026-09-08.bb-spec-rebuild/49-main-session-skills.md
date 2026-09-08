---
name: main-session-skills
description: 主会话流程 Skill 与规则：澄清到确认后派出需求代理、续接与补充转发、修订与对账本机定位、提交前直接审查与分支守卫、派工边界规则
---
# 主会话流程 Skill 与规则

## 目标
完成后，主窗口 agent 只承担澄清、规范与需求文档、用户确认、派出需求代理、中继作答与提交推送；不再自行规划、派角色或推进执行阶段。

## 业务规则（来源：spec）
- requirement-agent / role-catalog：主会话在需求文档经用户确认后派出需求代理；主会话只派需求代理与提交前审查的白盒审查者，不直接派其他角色。
- user-relay：需求代理的提问由主会话展示并作答；用户补充由主会话判断归属，属于进行中需求时转发对应需求代理并取得回执，否则按新需求处理。
- workspace-coordination：窗口启动目录子树内的仓库构成工作区；需求涉及多个仓库时主会话把跨仓库契约以成品写入各仓库规范并各建需求文档，为每个仓库派一个需求代理；契约变更由主会话裁定并转发。
- state-transitions / version-bound-recovery：需求阶段只经运行信息工具推进；续接、修订、对账从本机流程数据定位进度，多个候选需求由用户选择；缺失或损坏数据阻塞，不从文档推断。
- direct-pre-review：提交前由主会话记录审查快照并一次直接派出白盒审查者；对象与快照一致且通过才允许远端写入；不一致或未提交即 FAIL，保留本地提交。
- validation-consistency：提交只纳入本任务获准范围内的路径；其他宿主有活动任务时拒绝切换分支或重置共享现场。
- decision-append / product-decision-escalation / failure-attribution：材料性决定先经决策记录工具取得回执再行动；用户未回答不留痕。

## 涉及文件
- 修改 `skills/spec-flow/SKILL.md` — 重写为主会话流程
- 修改 `skills/spec-revise/SKILL.md` — 本机定位与受控回退
- 修改 `skills/spec-sync/SKILL.md` — 对账从本机数据取阶段，验收者由需求代理派出
- 修改 `skills/git-push/SKILL.md` — 直接审查、快照、范围提交、分支守卫
- 修改 `rules/04-decision-record.md` — 工具化决策记录与回执先于行动
- 修改 `rules/05-review-failure-handling.md` — 归因职责归需求代理，主会话只作答
- 新建 `rules/06-dispatch-boundary.md` — 主会话派工边界
- 新建 `tests/main-session-skills.test.ts` — 必需句 / 禁止句断言

## 函数清单
`skills/spec-flow/SKILL.md` 必需段落：
| 段落 | 必须表达的规则 |
|---|---|
| 角色定位 | 主会话负责澄清、写规范与需求文档、取得用户确认、派出需求代理、中继作答；不规划任务、不派 planner/worker/reviewer/acceptance、不推进执行阶段 |
| 工作区识别 | 按窗口启动目录子树发现仓库；需求涉及多个仓库时契约先写入各仓库规范（成品代码块）并各建需求文档 |
| 澄清与规范 | 递进式澄清；规则文件五节、≤100 行、不含实现细节；需求文档四节 |
| 确认与派出 | 用户确认后依次 `pi_company_workflow init`、`advance confirmed`、`pi_company_dispatch`；多仓库逐仓库派出 |
| 中继 | 收到需求代理提问时向用户展示选项并以 `pi_company_reply` 作答；契约变更请求由主会话裁定后更新各仓库规范并 `pi_company_forward` |
| 补充需求 | 判断是否属于本工作区进行中需求：是则 `pi_company_forward` 并向用户回执，否则走新需求 |
| 续接 | `/pi-company:resume` 从本机流程数据定位；多个候选让用户选择；数据缺失或损坏阻塞并说明，不从文档推断阶段；中断运行经 `pi_company_agents resumeInterrupted` |

`skills/spec-revise/SKILL.md`：复现 → 从本机数据定位需求与阶段 → 归因（实现缺陷 / 规范缺陷 / 需求变更）经 `decision_record` 记录 → 实现缺陷转发需求代理，规范缺陷或需求变更改规范后 `pi_company_workflow rollback` 到 confirmed 再派出；已 accepted 需求只读。
`skills/spec-sync/SKILL.md`：按域对账，规范→代码的验收由需求代理派 acceptance，代码→规范由主会话只读盘点；裁决只两种：改规范或转 spec-revise。
`skills/git-push/SKILL.md`：预检 → 采集审查快照（分支头 + 内容指纹）→ 主会话一次直接派 reviewer → 对象字段、语义、快照三重核对 → 只 `git add` 本需求获准范围路径 → 推送已审快照 → 创建合并请求前复核；其他宿主有活动任务时不切换分支、不重置；FAIL 走归因经 `decision_record` 再转需求代理修复后重采快照重审，最多三轮。
`rules/06-dispatch-boundary.md`：主会话只派需求代理与提交前白盒审查者；日常对话不派任何角色；需求代理只派角色目录内角色；角色不再向下派。

## 协作关系
- 依赖 28 的窗口工具、41 的分支守卫、48 的 reviewer 定义；45 需求代理承接派出后的全部编排。
- `rules/*.md` 由 `extensions/rules.ts` 注入系统提示。

## 验证方式
- 测试入口：读取上述 Skill 与规则文件原文
- 测试输入：文件全文
- 预期结果：
  - spec-flow 必需句：`不规划任务`、`派出需求代理`、`pi_company_dispatch`、`pi_company_reply`、`pi_company_forward`、`从本机流程数据定位`、`不从文档推断阶段`、`契约先写入各仓库规范`；禁止句：`SubagentWorkflow`、`test-engineer`、`impl-engineer`、`status: executing`、`Agent(`、`派 planner`
  - git-push 必需句：`一次直接派`、`审查快照`、`本需求获准范围路径`、`不切换分支`、`最多三轮`；禁止句：`git add .`、`--force`
  - spec-revise 必需句：`pi_company_workflow rollback`、`已 accepted 需求只读`；spec-sync 必需句：`由需求代理派 acceptance`
  - rules/06 必需句：`只派需求代理与提交前白盒审查者`、`角色不再向下派`；rules/04 必需句：`回执先于行动`
- [ ] 各文件必需句全部命中
- [ ] 禁止句全部缺席
