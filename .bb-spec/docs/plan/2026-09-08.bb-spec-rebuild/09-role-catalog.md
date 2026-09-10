---
name: role-catalog
description: 角色目录：包内默认、用户全局与项目三层角色定义合并与校验（项目层随宿主信任生效），五份默认定义骨架
---
# 角色目录

## 目标
系统能从三层定义文件得到可派出的角色集合（含需求代理），损坏定义标不可用，项目层定义只在项目受宿主信任时生效；派工权按调用方运行身份判定，由运行编排单元承担，本单元不做角色 kind 层面的派工判定。

## 业务规则（来源：spec）
- role-catalog：角色目录由包内默认（planner、worker、reviewer、acceptance 与需求代理）、用户全局目录、项目目录三层合并，同名按项目 > 全局 > 包内默认覆盖；项目层角色定义只在项目受宿主信任时生效，未受信任时忽略项目层、只装载包内默认与用户全局两层，并让设置页能标明项目层定义因未受信任而未生效；每个定义含名称、职责说明、可用工具、是否继承技能与项目上下文；派工权绑定运行身份而不是角色定义（主会话只派需求代理与提交前审查者，需求代理运行只派目录内角色，角色运行发起的派工被拒绝），该判定由运行编排按发起者身份执行，角色目录不按 kind 判定派工；损坏或缺必需字段的角色标不可用并显示原因，不用其他定义替代，不影响其他角色；新增用户角色无需改代码即可配置。
- workflow-shape：形状里的角色只能来自角色目录；角色不再向下派工。
- blackbox-acceptance-focus / whitebox-review-focus：验收者不读源码与任务文件、只写指定报告；审查者只读。默认定义的工具集合体现这些边界。

## 涉及文件
- 新建：runtime/roles.ts
- 新建：agents/planner.md、agents/worker.md、agents/reviewer.md、agents/acceptance.md、agents/requirement-agent.md — 本 plan 只落 frontmatter 与一句话职责占位，正文提示词由阶段 7 的角色 plan 补齐
- 新建：tests/role-catalog.test.ts

## 成品定义

五份默认定义的 frontmatter 骨架（正文由后续 plan 填充）：

```markdown
---
name: planner
description: 规划角色：先核对任务骨架再生成自包含任务文件
kind: plan
tools: [read, grep, find, ls, write, edit, bash]
skills: true
context_files: true
prompt_mode: append
---
```
```markdown
---
name: worker
description: 实现角色：同次核对测试证明力、Red → Green → 自验收并提交结构化交付
kind: work
tools: [read, grep, find, ls, edit, write, bash]
skills: true
context_files: true
prompt_mode: append
---
```
```markdown
---
name: reviewer
description: 白盒审查角色：只读审查整个分支，安全与鲁棒优先
kind: review
tools: [read, grep, find, ls, bash]
skills: true
context_files: true
prompt_mode: append
---
```
```markdown
---
name: acceptance
description: 黑盒验收角色：只依据规则文件在真实环境操作并唯一写入验收报告
kind: acceptance
tools: [bash, write]
skills: false
context_files: false
prompt_mode: append
---
```
```markdown
---
name: requirement-agent
description: 需求代理：持有需求上下文，规划、提议工作流形状、按形状派出角色并推进门禁
kind: manage
tools: [read, grep, find, ls, edit, write, bash]
skills: true
context_files: true
prompt_mode: append
---
```

`kind` 取值 `plan`、`work`、`review`、`acceptance`、`manage`，用户自定义角色可用其中任一 kind；必需字段为 `name`、`description`、`kind`、`tools`。

## 函数清单

### runtime/roles.ts
| 函数名 | 职责 |
|---|---|
| `loadRoleCatalog` | 读取三层目录合并为目录：同名覆盖、记录来源层；每个条目可用或带原因不可用；选项含 `projectTrusted`，为 false 时跳过项目层并在 `problems` 中记一条来源为 project、原因为项目未受宿主信任的条目 |
| `readRoleDefinition` | 解析单个定义文件的 frontmatter 与正文，校验必需字段、kind 集合与 tools 为字符串数组 |
| `defaultRoleDir` | 包内 agents 目录路径 |
| `userRoleDir` | 用户全局角色目录路径 |
| `projectRoleDir` | 项目角色目录路径 |
| `roleToolAllowlist` | 返回角色定义声明的工具名集合 |

## 协作关系
- 路径经 identity 取仓库根；frontmatter 解析用 SDK 导出的 `parseFrontmatter`（窗口内）或守护进程加载的同名函数，本模块通过参数接收解析函数以免直接依赖 SDK。
- 设置页、需求代理会话、角色会话、run-manager 都通过 `loadRoleCatalog` 取角色，`projectTrusted` 由调用方经宿主的项目信任判定传入（与角色配置的项目层保存范围同源）；派工权判定在 run-manager 按调用方运行身份执行。

## 验证方式
- 测试入口：`runtime/roles.ts` 导出函数
- 测试输入：临时的包内目录、全局目录、项目目录，各放若干定义文件
- 预期结果：
  - 三层各有同名 worker 时目录中的 worker 取项目定义且来源为 project；三处独有角色均出现；需求代理出现且被项目同名定义覆盖
  - 缺 kind 或 tools 非数组的项目 reviewer 定义使 reviewer 标为不可用并带原因；全局合法 reviewer 不被用作回退；其他角色正常
  - 项目目录有独有角色与同名 worker 覆盖定义、全局有合法 worker 时：未受信任装载得到的目录中项目独有角色不出现、worker 取全局定义且来源为 user，问题清单含一条来源为 project、说明项目未受宿主信任的条目；受信任装载后项目独有角色出现、worker 取项目定义
  - 角色目录不导出任何按 kind 判定派工的函数
  - 五份包内默认定义文件存在且 frontmatter 与成品一致
- [x] 三层合并与覆盖
- [x] 损坏定义不静默替代
- [x] 未受信任项目忽略项目层
- [x] 默认定义骨架
