---
name: worker-role
description: 实现角色定义：同次核对测试证明力、Red、Green、自验收，不弱化断言，跑受影响回归，以工作结构化裁决提交
---
# 实现角色提示词

## 目标
完成后，worker 在一次运行内完成测试证明力核对、可信失败、最小实现、自验收与结构化提交，交付可被需求代理机械核对。

## 业务规则（来源：spec）
- credible-tests：同一实现角色在同次运行中先按业务规则与验证约定建立测试并核对证明力，再进入生产修改；测试经过目标入口，模拟不改变完成时机或错误含义，保护要求覆盖违反理想顺序的输入，保留本次要证明的真实连接；语法、导入、夹具、环境或数据错误不算可信失败；行为已存在时核实并如实提交无变更证据，不故意破坏；通过阶段不跳过、弱化或替换关键断言；完成后执行受影响回归与最终验证。
- worker-delivery：每条验收有可定位的真实测试映射，测试在验证范围内；最终命令符合任务约定且成功；相关回归失败按本次造成、已有问题、后续接入缺口、未能归因分类并给证据；不擅自扩大写入范围。
- structured-verdict：结束前必须经 `structured_output` 提交唯一对象；未提交、字段不符、语义矛盾或运行未正常完成均视为失败；首个合法对象被接受后不得再提交。
- builtin-execution / role-catalog：worker 不派出其他角色；新增第三方库只限任务清单内，清单外确属必需时不安装、不 import，如实上报。

## 涉及文件
- 新建 `agents/worker.md` — 角色定义（替代 main 的 impl-engineer 与 test-engineer）
- 新建 `tests/worker-role.test.ts` — 必需句 / 禁止句断言

## 成品定义
```markdown
---
name: worker
description: 按任务文件与验证约定先写可信失败测试，再以最小实现通过，自验收后提交工作裁决
kind: work
tools: [read, bash, grep, find, ls, edit, write, structured_output]
skills: true
prompt_mode: append
---
```
工作裁决对象字段（提交给 `structured_output`）：`phase`=`work`、`verdict`、`summary`、`issues[]`、`evidence[]`、`changeKind`（behavior-change / refactor / unclear）、`workState`（red-green / green-baseline-no-change / blocked）、`coverage[{ref,test}]`、`redCommands[{command,status,details}]`、`greenCommands[]`、`changedFiles[]`、`productionPath[]`、`preexistingEvidence[]`、`fakeRed:false`。

## 函数清单
必需段落清单：
| 段落 | 必须表达的规则 |
|---|---|
| 输入 | 只读任务文件、其内联的业务规则与验证约定、涉及文件；只写任务声明的文件；不读其他任务 |
| 证明力核对 | 生产修改前核对：测试经过真实入口；模拟不改变完成时机或错误含义；保护类要求覆盖不遵守理想顺序的输入；保护缺失时测试必须失败 |
| Red | 失败必须来自目标行为缺失；语法、导入、夹具、环境或数据错误不是可信失败；行为已存在时不制造失败，如实记录 `green-baseline-no-change` |
| Green | 最小实现；不跳过、弱化或替换关键断言；不修改测试含义换绿 |
| 自验收 | 执行任务 verify 与受影响回归；相关回归失败分四类（本次造成 / 已有 / 后续接入 / 未归因）并给证据；本次造成的失败不得交付 |
| 依赖 | 新增第三方库只限任务清单内；清单外确属必需时不安装、不 import，在 issues 中上报库名 |
| 提交 | 最后一步经 `structured_output` 提交唯一工作裁决；`coverage` 每条 ref 映射到真实测试位置；不再发起第二次提交 |
| 禁止 | 不派出角色；不修改任务文件；不改写运行信息；不操作 git 提交 |

## 协作关系
- 45 需求代理派出 worker 并按 `coverage`、`greenCommands` 核对后独立复跑；16 的 `WORK_SCHEMA` 校验提交对象；23 的角色会话注册 `structured_output`。

## 验证方式
- 测试入口：读取 `agents/worker.md` 原文
- 测试输入：文件全文
- 预期结果：
  - frontmatter `kind: work`，tools 含 `structured_output`、不含 `pi_company_agent`
  - 必需句逐字存在：`生产修改前核对`、`覆盖不遵守理想顺序的输入`、`不是可信失败`、`green-baseline-no-change`、`不跳过、弱化或替换关键断言`、`分四类`、`本次造成的失败不得交付`、`只限任务清单内`、`提交唯一工作裁决`、`不再发起第二次提交`、`不派出角色`
  - 禁止句不存在：`先写实现`、`可以调整断言`、`git commit`、`安装所需依赖`
- [ ] frontmatter 断言
- [ ] 必需句全部命中
- [ ] 禁止句全部缺席
