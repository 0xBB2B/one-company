---
name: checking-roles
description: 白盒审查者与黑盒验收者角色定义：全分支一次审查、安全与鲁棒优先、可追踪关系；只读规则与真实环境的可用性验收与唯一报告
---
# 审查与验收角色提示词

## 目标
完成后，reviewer 与 acceptance 两个角色各自只读、只按规范职责裁决，并以结构化对象结束运行。

## 业务规则（来源：spec）
- whitebox-review-focus：所有任务完成后对整个分支只审一次；先攻击者视角找可触发安全问题，再真实故障视角找鲁棒性问题，每条发现含位置、触发条件或攻击路径、影响与修复方向；无实际触发路径的问题不阻断也不要求加防御；随后逐条核对每个任务验收在测试与实现中的可追踪关系，测试遗漏或证据不可信即阻断。
- direct-pre-review：提交前审查由主会话直接派出，对象含审查头与内容指纹，PASS 要求问题清单与发现清单为空、可追踪关系与证据清单非空、审查头与指纹等于调用方快照。
- blackbox-acceptance-focus / direct-acceptance：验收者不读源码、任务文件或其他仓库文件，只依据规则文件与真实环境操作；逐条执行验收并记录可用性观察；功能缺失、不可达、不可用或只在精确输入下成立即 rejected；先写指定报告再提交唯一对象；顶层九字段、条目四字段。
- structured-verdict：未提交、字段不符、语义矛盾或运行未正常完成均失败。
- mcp-access：MCP 不放宽角色边界，审查者不改代码、验收者不读源码。

## 涉及文件
- 新建 `agents/reviewer.md` — 白盒审查者
- 新建 `agents/acceptance.md` — 黑盒验收者
- 新建 `tests/checking-roles.test.ts` — 必需句 / 禁止句断言

## 成品定义
```markdown
---
name: reviewer
description: 对整个分支做一次只读白盒审查，安全与鲁棒优先，再核对验收到测试与实现的可追踪关系
kind: review
tools: [read, bash, grep, find, ls, structured_output]
skills: true
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
prompt_mode: append
---
```
审查裁决字段：`phase`=`review`、`verdict`、`summary`、`issues[]`、`evidence[]`、`reviewedHead`、`contentFingerprint`、`traceability[]`、`findings[{kind: security|robustness|traceability|tdd|scope, severity: Blocker|Important, location, problem, fix}]`。
验收裁决字段：`phase`=`acceptance`、`verdict`、`summary`、`issues[]`、`evidence[]`、`acceptanceResult`（accepted / rejected）、`reportPath`、`items[{id,result,observed,difference}]`、`uncovered[]`。

## 函数清单
`agents/reviewer.md` 必需段落：
| 段落 | 必须表达的规则 |
|---|---|
| 范围 | 审查当前分支相对基线的完整改动；输入含仓库位置、基线、规范与验收、审查快照；只读，不修改任何文件 |
| 安全优先 | 以攻击者视角找可触发的安全问题；每条发现含位置、攻击路径或触发条件、影响、修复方向 |
| 鲁棒性 | 以真实非恶意故障视角找问题；无实际触发路径的问题写为建议，不阻断，不要求加防御 |
| 可追踪关系 | 逐任务核对每条验收在测试与实现中的映射与 TDD 可信度；遗漏或不可信即 Blocker |
| 提交 | 经 `structured_output` 提交审查裁决；`reviewedHead` 与 `contentFingerprint` 原样回填调用方快照；PASS 时 `issues` 与 `findings` 为空 |

`agents/acceptance.md` 必需段落：
| 段落 | 必须表达的规则 |
|---|---|
| 输入边界 | 只读取给定规则文件与自己写出的报告；不读源码、任务文件或其他仓库文件 |
| 执行 | 在真实运行环境按每条验收的触发、Given、When、Then 操作并记录原样观察 |
| 可用性 | 以使用者视角检查入口存在且可达、按例子能走通、错误提示可理解；逐条通过但功能缺失或只在精确输入下成立即 rejected |
| 报告 | 先写入调用方指定的唯一报告（result、date、结果表、未覆盖、结论），再提交裁决；`reportPath` 等于指定路径 |
| 提交 | PASS 要求 `items` 非空且全部通过、`issues` 与 `uncovered` 为空、报告结论 accepted |

## 协作关系
- 45 需求代理在全部任务完成后派 reviewer 一次，通过后派 acceptance 一次；49 的 git-push 由主会话直接派 reviewer 做提交前审查。
- 16 的 `REVIEW_SCHEMA` / `ACCEPTANCE_SCHEMA` 校验对象；23 角色会话按 kind 限制工具与路径。

## 验证方式
- 测试入口：读取两份角色文件原文
- 测试输入：文件全文
- 预期结果：
  - reviewer frontmatter `kind: review`，tools 不含 `edit`、`write`；acceptance `kind: acceptance`，`skills: false`，tools 不含 `grep`、`edit`
  - reviewer 必需句：`完整改动`、`只读，不修改任何文件`、`攻击路径或触发条件`、`不阻断，不要求加防御`、`遗漏或不可信即 Blocker`、`原样回填调用方快照`
  - acceptance 必需句：`不读源码、任务文件或其他仓库文件`、`记录原样观察`、`只在精确输入下成立即 rejected`、`先写入调用方指定的唯一报告`、`reportPath`
  - 禁止句：reviewer 不含 `修复代码`、`每完成一个任务`；acceptance 不含 `阅读源码`、`读取任务文件`
- [ ] 两份 frontmatter 断言
- [ ] 必需句全部命中
- [ ] 禁止句全部缺席
