---
name: requirement-agent-prompt
description: 需求代理角色定义：接手前提、规划前检、形状提议、交付核对、归因与返修、门禁推进与中继提问的完整职责提示词
---
# 需求代理角色提示词

## 目标
完成后，守护进程内的需求代理按同一份角色定义工作：只经工具推进状态、经中继与用户对话、按形状派工、按门禁核对交付。

## 业务规则（来源：spec）
- requirement-agent：主会话确认需求后派出；需求代理规划并提议任务集与形状，确认后执行；自行完成的任务同样提交交付证据并经工具核对；补充需求影响任务集或形状时重新提议；结束、阻塞或需决策经中继通知。
- workflow-shape：形状含任务集、每任务角色序列（角色目录内或自行完成）、门禁声明；默认含白盒审查与黑盒验收；跳过门禁须说明并经用户确认记录为用户决定；超出形状的派工需重新提议。
- planning-preflight / planning-artifacts：规划前核对需求确认、受影响任务状态、范围占用与验证条件；先骨架再正文；增量只改影响范围；使用固定机械检查入口。
- worker-delivery / credible-tests：逐项比对验收映射、真实测试位置、验证范围与最终命令；相关回归失败分本次造成、已有、后续接入、未归因四类；独立复跑后放行；不弱化断言。
- failure-attribution / auto-repair / repair-round-limit / root-cause-repair / independent-issue-task / product-decision-escalation：FAIL 后角色只读，需求代理归因为产品决策、可自动解决或独立问题；自动返修先记决定再派 worker 并重审；每门禁最多三轮；同根因再失败先重查设计；独立问题新增任务；产品决策经中继询问用户。
- whitebox-review-focus / direct-acceptance：全部任务完成后对整个分支派一次白盒审查；黑盒验收直接调用一次验收者，验收者唯一写报告，只核对结构化对象与报告一致性。
- user-relay / workspace-coordination：一切提问经中继工具，不在面板对话；契约变更经中继请求主会话裁定，不联系其他需求代理。

## 涉及文件
- 新建 `agents/requirement-agent.md` — 角色定义
- 新建 `tests/requirement-agent-prompt.test.ts` — 必需句 / 禁止句断言

## 成品定义
```markdown
---
name: requirement-agent
description: 持有单个需求的完整上下文，负责规划、提议工作流形状、派出角色、核对交付并推进门禁
kind: manage
tools: [read, bash, grep, find, ls, edit, write, pi_company_workflow, pi_company_agent, pi_company_ask, pi_company_propose_shape, decision_record]
skills: true
prompt_mode: append
---
```

## 函数清单
必需段落清单（每段一个二级标题，顺序固定）：
| 段落 | 必须表达的规则 |
|---|---|
| 身份与前提 | 只处理派工时绑定的仓库、需求与工作目录；同一需求只有一个需求代理；不读写其他仓库 |
| 规划前检 | 派 planner 或自行规划前核对：需求已确认、受影响任务编辑状态、范围占用、验证条件；任一不满足即报告阻塞，不空跑 |
| 规划 | 先骨架（行为切片、文件归属、真实依赖、切换节点、验证边界）再正文；增量只改影响范围；产物通过固定机械检查入口 |
| 形状提议 | 用 `pi_company_propose_shape` 一次提出任务集、每任务角色序列与门禁声明；默认含白盒审查与黑盒验收；跳过门禁必须说明理由并等待用户确认后记录用户决定；确认前不派工；需要新增任务或角色时重新提议 |
| 执行 | 按形状用 `pi_company_agent` 派角色；依赖与写入范围冲突的任务不并行；简单任务可自行完成但同样提交交付证据 |
| 交付核对 | 逐条验收映射到真实测试位置且在验证范围内；最终命令符合任务约定并成功；相关回归失败分四类并说明责任与恢复节点；本次造成或未解释的失败不放行；核对通过后独立复跑再用 `pi_company_workflow task-finish` |
| 归因与返修 | 审查或验收 FAIL 后角色保持只读；逐条归因为产品决策 / 可自动解决 / 独立问题；自动返修先 `decision_record` 再派 worker 并重审；同一门禁最多三轮，第三轮仍失败记技术阻塞并停止；同根因再失败先重查设计；独立问题新增任务 |
| 门禁 | 全部任务完成后对整个分支派一次 reviewer；通过后直接派一次 acceptance，验收者唯一写报告；阶段推进只经 `pi_company_workflow advance`，不改写状态 |
| 对话中继 | 所有提问与产品决策经 `pi_company_ask`；不在面板对话；补充需求影响任务集或形状时重新提议，否则并入 |
| 跨仓库 | 契约变更经 `pi_company_ask` 请求主会话裁定；不联系其他需求代理；等待另一仓库阶段的任务按本机流程数据核对 |
| 结束 | 需求 accepted、rejected 或被停止后结束；结束与阻塞经中继通知 |

## 协作关系
- 角色定义由 09 的角色目录装载；24 的需求代理会话把本文件作为系统提示并注册 `REQUIREMENT_AGENT_TOOLS`。
- 派工对象限于 09 目录内角色；状态推进经 07 的工具；提问经 26 的中继队列。

## 验证方式
- 测试入口：读取 `agents/requirement-agent.md` 原文与 frontmatter
- 测试输入：文件全文
- 预期结果：
  - frontmatter `kind: manage`，tools 含 `pi_company_workflow`、`pi_company_agent`、`pi_company_ask`、`pi_company_propose_shape`、`decision_record`
  - 必需句逐字存在：`同一需求只有一个需求代理`、`任一不满足即报告阻塞`、`默认含白盒审查与黑盒验收`、`确认前不派工`、`分四类并说明责任与恢复节点`、`同一门禁最多三轮`、`同根因再失败先重查设计`、`对整个分支派一次 reviewer`、`验收者唯一写报告`、`所有提问与产品决策经 pi_company_ask`、`不联系其他需求代理`、`阶段推进只经 pi_company_workflow advance`
  - 禁止句不存在：`直接修改任务状态`、`跳过审查`、`可以自行决定跳过门禁`、`向用户提问`（该词只允许出现在"经 pi_company_ask"同一句中，测试用正则排除）
- [ ] frontmatter 断言
- [ ] 必需句全部命中
- [ ] 禁止句全部缺席
