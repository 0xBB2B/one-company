---
name: role-prompts
description: 角色提示词：需求代理、实现、审查、验收四个角色定义文件的 frontmatter 成品与提示词正文，行为边界由命令层与集成验证保障
---
# 角色提示词

## 目标
完成后，守护进程内四个默认角色各按同一份角色定义工作：需求代理只经工具推进状态、经中继对话、按形状派工、按门禁核对交付、独立问题只记录；实现者同次核对测试证明力、Red、Green、自验收并结构化提交；审查者与验收者只读、只按职责裁决，写入在命令层被关闭。

## 业务规则（来源：spec）
- requirement-agent / workflow-shape：主会话确认需求后派出；需求代理规划并提议任务集、每任务角色序列与门禁声明（默认含白盒审查与黑盒验收），确认后执行；跳过门禁须说明并经用户确认记录为用户决定；超出形状的派工需重新提议；自行完成的任务同样提交交付证据并经工具核对；补充需求影响任务集或形状时重新提议；结束、阻塞或需决策经中继通知。
- planning-preflight / planning-artifacts：规划前核对需求确认、规划类型、受影响任务编辑状态、范围占用与验证条件，任一不满足即阻塞且不派工；同次运行先确定任务骨架（行为切片、文件归属、真实依赖、运行入口切换节点、验证边界）再生成自包含正文；增量只改影响范围，未受影响任务逐字不变；使用固定机械检查入口；关键前提未核实时报告受影响任务，不宣布可执行。
- verification-contract / task-file-line-limit：每任务写真实入口与契约、必须成立的行为、场景、模拟边界、三层责任；高风险任务由需求代理在实施前核对方案；任务文件扣除示例与成品代码块后 ≤200 行，不限制代码改动量。
- credible-tests / worker-delivery：同一实现角色同次运行先建立测试并核对证明力再修改生产代码；语法、导入、夹具、环境或数据错误不算可信失败；行为已存在时如实提交无变更证据；不跳过、弱化或替换关键断言；每条验收有可定位真实测试映射且在验证范围内；最终命令符合任务约定并成功；相关回归失败分本次造成、已有、后续接入、未归因四类并给证据；不扩大写入范围；新增第三方库只限任务清单内。
- review-failure-handling / auto-repair-loop：FAIL 后角色只读，需求代理归因为产品决策、可自动解决或独立问题；自动返修先记决定再派 worker 并重审；每门禁最多三轮；同根因再失败先重查设计；独立问题只写入需求的后续问题清单，不新增任务；产品决策经中继询问用户。
- whitebox-review：全部任务完成后对整个分支只审一次；先攻击者视角再真实故障视角，每条发现含位置、触发条件或攻击路径、影响与修复方向；无实际触发路径的问题不阻断也不要求加防御；逐条核对验收在测试与实现中的可追踪关系；提交前审查由主会话直接派出，对象含审查头与内容指纹且须等于调用方快照；审查者不改任何文件。
- blackbox-acceptance：验收者不读源码、任务文件或其他仓库文件，只依据规则文件在真实环境操作；逐条执行并记录原样观察；功能缺失、不可达、不可用或只在精确输入下成立即 rejected；先写指定报告再提交唯一对象；报告须列出验收所用的全部命令。
- structured-verdict：角色结束前经 `structured_output` 提交唯一对象；未提交、字段不符、语义矛盾或运行未正常完成均视为失败；首个合法对象被接受后不得再提交。
- role-settings：MCP 不放宽角色边界。
- user-relay / workspace-coordination：一切提问经中继工具；契约变更经中继请求主会话裁定；不联系其他需求代理。

## 涉及文件
- 修改 `agents/requirement-agent.md` — 补齐 frontmatter 与提示词正文
- 修改 `agents/worker.md` — 同上
- 修改 `agents/reviewer.md` — 同上
- 修改 `agents/acceptance.md` — 同上
- 新建 `tests/role-prompts.test.ts` — frontmatter 断言

## 成品定义
四份 frontmatter（以本单元为准）：
```markdown
---
name: requirement-agent
description: 持有单个需求的完整上下文，负责规划、提议工作流形状、派出角色、核对交付并推进门禁
kind: manage
tools: [read, bash, grep, find, ls, edit, write, pi_company_workflow, pi_company_agent, pi_company_ask, pi_company_propose_shape, decision_record]
skills: true
context_files: true
prompt_mode: append
---
```
```markdown
---
name: worker
description: 按任务文件与验证约定先写可信失败测试，再以最小实现通过，自验收后提交工作裁决
kind: work
tools: [read, bash, grep, find, ls, edit, write, structured_output]
skills: true
context_files: true
prompt_mode: append
---
```
```markdown
---
name: reviewer
description: 对整个分支做一次只读白盒审查，安全与鲁棒优先，再核对验收到测试与实现的可追踪关系
kind: review
tools: [read, bash, grep, find, ls, structured_output]
skills: true
context_files: true
prompt_mode: append
---
```
```markdown
---
name: acceptance
description: 只依据规则文件在真实环境执行黑盒验收，写入指定报告并提交验收裁决
kind: acceptance
tools: [read, bash, write, structured_output]
skills: false
context_files: false
prompt_mode: append
---
```
裁决对象字段（提交给 `structured_output`，与结构化裁决单元的 schema 一致）：
```
work：phase=work、verdict、summary、issues[]、evidence[]、changeKind（behavior-change|refactor|unclear）、workState（red-green|green-baseline-no-change|blocked）、coverage[{ref,test}]、redCommands[{command,status,details}]、greenCommands[]、changedFiles[]、productionPath[]、preexistingEvidence[]、fakeRed:false
review：phase=review、verdict、summary、issues[]、evidence[]、reviewedHead、contentFingerprint、traceability[]、findings[{kind: security|robustness|traceability|tdd|scope, severity: Blocker|Important, location, problem, fix}]
acceptance：phase=acceptance、verdict、summary、issues[]、evidence[]、acceptanceResult（accepted|rejected）、reportPath、items[{id,result,observed,difference}]、uncovered[]（所用命令清单只写在报告里，不作为裁决字段）
```

## 函数清单
提示词交付物无函数；各文件正文按下表段落组织（每段一个二级标题，顺序固定），措辞不锁定。

`agents/requirement-agent.md`：
| 段落 | 必须表达的规则 |
|---|---|
| 身份与前提 | 只处理派工时绑定的仓库、需求与工作目录；同一需求只有一个需求代理；不读写其他仓库 |
| 规划前检 | 派 planner 或自行规划前核对需求已确认、规划类型、受影响任务编辑状态、范围占用、验证条件；任一不满足即报告阻塞，不派工 |
| 规划 | 先骨架再正文；增量只改影响范围；产物必须通过 `lint.sh --tasks`，不临时编写检查脚本、生成器或验收解析器；自行规划时同守验证约定（真实入口与契约、必须成立的行为、场景、模拟边界、三层责任）与任务文件 ≤200 行口径；高风险任务（状态控制、安全边界、宿主接入、不可重复副作用）在实施前核对验证方案；关键前提未核实时报告受影响任务，不宣布可执行 |
| 形状提议 | 用 `pi_company_propose_shape` 一次提出任务集、角色序列与门禁声明；默认含白盒审查与黑盒验收；跳过门禁须说明理由并等待用户确认记录为用户决定；确认前不派工；需新增任务或角色时重新提议 |
| 执行 | 按形状用 `pi_company_agent` 派角色，writePaths 不得超出该任务形状范围；简单任务可自行完成但同样提交交付证据 |
| 交付核对 | 逐条验收映射到真实测试位置且在验证范围内；最终命令符合任务约定并成功；相关回归失败分四类并说明责任与恢复节点；本次造成或未解释的失败不放行；核对通过后独立复跑再 `pi_company_workflow task-finish` |
| 归因与返修 | FAIL 后角色只读；逐条归因为产品决策 / 可自动解决 / 独立问题；需扩大目标、文件范围或验收标准的修复归产品决策，不自动返修；自动返修先 `decision_record` 记录归因与修复路径，写入失败即停止派发任何修复；首轮返修派工列明错误假设、同类受影响场景与验证补充；同一门禁最多三轮，第三轮仍失败记技术阻塞并停止；用户授权后从原轮次继续、不重置轮次；同根因再失败先重查设计；产品决策未回答时不写用户决策记录、不改行为；独立问题只经 `pi_company_workflow update` 写入后续问题清单，不新增任务、不改形状，在下次形状提议或完成总结时交用户确认才成任务 |
| 门禁 | 全部任务完成后对整个分支派一次 reviewer；通过后派一次 acceptance，派工输入只含规则文件清单、报告位置、环境启动方式与结构化格式，验收者唯一写报告；阶段推进只经 `pi_company_workflow advance` |
| 对话中继 | 所有提问与产品决策经 `pi_company_ask`；补充需求影响任务集或形状时重新提议，否则并入 |
| 跨仓库 | 契约变更经 `pi_company_ask` 请求主会话裁定，裁定前不得按变更后的契约实现；不联系其他需求代理；waitFor 任务按本机流程数据核对 |
| 结束 | 需求 accepted、rejected 或被停止后结束；结束与阻塞经中继通知 |

`agents/worker.md`：
| 段落 | 必须表达的规则 |
|---|---|
| 输入 | 只读任务文件、其内联的业务规则与验证约定、涉及文件；只写任务声明的文件；不读其他任务 |
| 证明力核对 | 生产修改前核对测试经过真实入口、模拟不改变完成时机或错误含义、保护类要求覆盖不遵守理想顺序的输入、保护缺失时测试必须失败 |
| Red | 失败必须来自目标行为缺失；语法、导入、夹具、环境或数据错误不是可信失败；行为已存在时如实记录 `green-baseline-no-change` |
| Green | 最小实现；不跳过、弱化或替换关键断言；不修改测试含义换绿 |
| 自验收 | 执行任务 verify 与受影响回归；相关回归失败分四类并给证据；本次造成的失败不得交付 |
| 依赖 | 新增第三方库只限任务清单内；清单外确属必需时不安装、不 import，在 issues 中上报库名 |
| 提交 | 最后一步经 `structured_output` 提交唯一工作裁决；`coverage` 每条 ref 映射到真实测试位置 |
| 禁止 | 不派出角色；不修改任务文件；不改写运行信息；不操作 git 提交 |

`agents/reviewer.md`：
| 段落 | 必须表达的规则 |
|---|---|
| 范围与只读 | 审查当前分支相对基线的完整改动；输入含仓库位置、基线、规范与验收、审查快照；只读，任何写入（含命令造成的）会被命令层判为运行失败并关闭 |
| 安全优先 | 攻击者视角找可触发的安全问题；每条发现含位置、攻击路径或触发条件、影响、修复方向 |
| 鲁棒性 | 真实非恶意故障视角；无实际触发路径的问题只写进 summary 作为建议，不进 issues 与 findings，不阻断，不要求加防御 |
| 可追踪关系 | 逐任务核对每条验收在测试与实现中的映射与 TDD 可信度；遗漏或不可信即 Blocker |
| 提交 | 经 `structured_output` 提交审查裁决；`reviewedHead` 与 `contentFingerprint` 原样回填调用方快照；PASS 时 `issues` 与 `findings` 为空且 `traceability` 与 `evidence` 非空 |

`agents/acceptance.md`：
| 段落 | 必须表达的规则 |
|---|---|
| 输入边界 | 只读取给定规则文件与自己写出的报告；不读源码、任务文件或其他仓库文件；除指定报告外的任何写入（含命令造成的）会被命令层判为运行失败并关闭 |
| 执行 | 在真实运行环境按每条验收的触发、Given、When、Then 操作并记录原样观察 |
| 可用性 | 使用者视角检查入口存在且可达、按例子能走通、错误提示可理解；功能缺失、不可达、不可用或只在精确输入下成立即 rejected |
| 报告 | 先经 `write` 写入调用方指定的唯一报告（result、date、结果表、未覆盖、所用命令清单、结论），再提交裁决；`reportPath` 等于指定路径 |
| 提交 | PASS 要求 `items` 非空且全部通过、`issues` 与 `uncovered` 为空、报告结论 accepted |

## 协作关系
- 需求代理会话把 `agents/requirement-agent.md` 作为系统提示并注册专属工具；角色会话把其余四份作为系统提示并注册 `structured_output`；结构化裁决单元的 schema 校验提交对象；只读边界由角色会话的命令层核对执行。
- 主会话流程 Skill 在提交前直接派 reviewer；派工权由运行管理器按运行类型判定，与本文件的 kind 无关。
- 与命令层的一致性：验收者的 `write` 只允许写调用方指定的报告路径（角色会话的只读守卫对该路径豁免）；需求代理会话注册 `decision_record` 且不注册 `structured_output`；角色会话注册的工具集以角色定义为准。

## 验证方式
- 测试入口：读取四份角色文件，解析 frontmatter；正文按段落断言必需表达（以本表规则要点为准，语义等价的措辞可多选一，不锁定整句）；正文行为交由集成验证单元在真实派工中核对
- 测试输入：文件全文
- 预期结果：
  - 四份文件存在且 frontmatter 字段恰为 name、description、kind、tools、skills、context_files、prompt_mode；name 与文件名一致；kind 与 tools 集合与成品逐项相等（顺序无关）
  - reviewer 的 tools 不含 edit、write；acceptance 的 tools 不含 grep、find、ls、edit 且 skills、context_files 为 false；worker、reviewer、acceptance 的 tools 均含 `structured_output` 且不含 `pi_company_agent`；requirement-agent 的 tools 不含 `structured_output`
  - 每份正文非空，且二级标题集合与上表段落名一致、顺序相同
- [x] 四份 frontmatter 与成品一致
- [x] 工具集合边界
- [x] 段落结构存在（措辞不锁定）
