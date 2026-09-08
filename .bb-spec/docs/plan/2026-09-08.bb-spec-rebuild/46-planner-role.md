---
name: planner-role
description: 规划角色定义与两份参考文本：规划前检、任务骨架先行、增量范围、验证约定、200 行口径与固定机械检查
---
# 规划角色与规划参考文本

## 目标
完成后，需求代理派出的 planner 按固定口径产出可执行的任务集：先骨架再正文、只改影响范围、内联原文、写验证约定、经固定检查通过。

## 业务规则（来源：spec）
- planning-preflight：派工前由需求代理核对需求确认、规划类型、受影响任务编辑状态、范围占用与验证条件；增量规划提供变化摘要、相关位置与已知限制，摘要不替代规划角色核实。
- planning-artifacts：同次运行先确定任务骨架（行为切片、文件归属、真实依赖、运行入口切换节点、验证边界），再生成自包含正文；增量从变化范围及直接依赖开始核实，未受影响任务逐字不变；使用固定机械检查入口，不临时编写检查器；关键前提未核实或提前删除现用入口时报告受影响任务与待验证条件，不宣布可执行。
- verification-contract：每任务写真实入口与契约、必须成立的行为、适用与不适用场景、模拟边界、三层验证责任；涉及状态控制、安全边界、宿主接入或不可重复副作用的任务，由需求代理在实施前核对方案。
- task-file-line-limit：任务文件扣除示例与成品代码块后最多 200 行，不限制代码改动量。
- role-catalog：planner 不得派出其他角色。

## 涉及文件
- 修改 `agents/planner.md` — 重写为角色目录格式
- 新建 `skills/spec-flow/references/planning-preflight.md` — 前检清单参考文本（需求代理加载）
- 新建 `skills/spec-flow/references/planning-artifacts.md` — 骨架与产物参考文本（planner 加载）
- 新建 `tests/planner-role.test.ts` — 三份文件必需句 / 禁止句断言

## 成品定义
```markdown
---
name: planner
description: 读取规范与需求文档，产出任务骨架与自包含任务文件，只写任务目录
kind: plan
tools: [read, bash, grep, find, ls, write, edit]
skills: true
prompt_mode: append
---
```

## 函数清单
`agents/planner.md` 必需段落：
| 段落 | 必须表达的规则 |
|---|---|
| 输入与边界 | 只读规范、需求文档与仓库代码；只写需求的任务目录与索引；不派出任何角色；不修改运行信息 |
| 骨架先行 | 同次运行先列出骨架：行为切片、文件归属（生产文件 ≤2 且互斥）、真实依赖、运行入口切换节点、验证边界；骨架成立后才写正文 |
| 增量规划 | 从变化摘要与直接依赖核实真实影响，未受影响任务逐字不变，不重写整套任务 |
| 任务正文 | 按 spec-docs 格式；业务规则节逐字内联所引 AC 与其回指的 C；验证方式含验证约定五要点；每份扣除示例与成品代码块后 ≤200 行 |
| 机械检查 | 交付前运行固定入口 `lint.sh --tasks`，失败即修正，不自行编写检查脚本 |
| 不可执行即报告 | 计划会提前删除现用入口或关键接口、环境、文件约束未核实时，报告受影响任务与待验证条件，不报告可执行 |

`references/planning-preflight.md` 必需内容：前检五项（需求已确认、规划类型、受影响任务编辑状态、范围占用、验证条件）；任一不满足即阻塞且规划派工次数为零；增量输入三件（变化摘要、相关位置、已知限制）。
`references/planning-artifacts.md` 必需内容：骨架五要素定义；高风险任务（状态控制、安全边界、宿主接入、不可重复副作用）须在实施前由需求代理核对验证方案；验证约定块模板同 spec-docs。

## 协作关系
- 45 需求代理在派 planner 前按 `planning-preflight.md` 前检，派工后按 `planning-artifacts.md` 核对产物并调用 44 的检查入口。
- 09 角色目录装载 `agents/planner.md`。

## 验证方式
- 测试入口：读取三份文件原文
- 测试输入：文件全文
- 预期结果：
  - `agents/planner.md` frontmatter `kind: plan`，tools 不含 `pi_company_agent`
  - 必需句逐字存在：`先列出骨架`、`未受影响任务逐字不变`、`逐字内联所引 AC 与其回指的 C`、`扣除示例与成品代码块后 ≤200 行`、`lint.sh --tasks`、`不自行编写检查脚本`、`不报告可执行`、`不派出任何角色`
  - `planning-preflight.md` 含 `规划派工次数为零`；`planning-artifacts.md` 含 `在实施前由需求代理核对验证方案` 与 `必须真实贯通`
  - 禁止句不存在：`预估改动不超过 200 行`、`status:`、`可以调用 worker`
- [ ] frontmatter 断言
- [ ] 三份文件必需句全部命中
- [ ] 禁止句全部缺席
