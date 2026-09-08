---
name: mechanical-validation
description: 固定只读机械检查入口：lint --spec/--tasks 与任务检查脚本核对格式、归属、依赖、验收覆盖与原文，失败非零退出且可定位
---
# 固定任务机械检查

## 目标
完成后，需求代理、规划角色与用户通过同一条命令核对任务集合的机械条件，得到零退出码或可定位的失败原因，检查不改输入、不执行验证命令。

## 业务规则（来源：spec）
- mechanical-validation：检查入口固定，指定一个需求即核对其变更清单与任务集合；每任务至多两个生产文件、至多三条验收引用、正文计数上限、固定格式、索引与非空业务规则和验证方式；拒绝重复归属的生产文件、向后或不存在的依赖、依赖环、不满足文件互斥和无依赖条件的并行标记、缺失或错误验收引用、与所引约束和验收原文不一致的内容；覆盖基准为本次新增或修改规则的全部验收，变更范围外的未覆盖验收不是缺项，未知规则或引用仍报错；输入不可读或类别无法确认时非零退出并定位；检查前后输入不变，不执行验证命令，不自动修复。
- task-file-line-limit：整份文件物理行计数，示例与成品代码块含围栏不计，200 行合格、201 行超限。
- planning-artifacts：规划角色使用固定检查入口，不临时编写检查器。
- document-boundary：任务文件不含运行字段，检查以定义字段为准。

## 涉及文件
- 修改 `skills/spec-docs/scripts/lint.sh` — 增加 `--tasks` 子命令并转发；`--spec` 保持规则文件检查
- 新建 `skills/spec-docs/scripts/task-check.ts` — 任务集合机械检查
- 新建 `tests/mechanical-validation.test.ts` — 真实夹具与退出码验证

## 成品定义
命令行契约：
```
lint.sh --spec <规则文件>...          检查规则文件格式（≤100 行、name、五节、C/AC 双向覆盖、四行验收、无实现细节）
lint.sh <requirements.md>            检查需求文档四节、规范变更表、被引用规则与索引
lint.sh --tasks <requirements.md>    转发 bun task-check.ts <requirements.md>
bun task-check.ts <requirements.md>  任务集合机械检查
```
退出码与输出：
| 结果 | 退出码 | 标准输出首行 |
|---|---|---|
| 全部通过 | 0 | `PASS: 仅证明任务机械条件，不证明行为正确` |
| 任一条件不满足 | 1 | `FAIL: <任务id或文件>: <字段或缺项>: <原因>`（可多行，每条一行） |
| 参数错误 / 输入不可读 / 类别无法确认 | 2 | `FAIL: <原因>` |
路径推导：`requirementDir = dirname(requirements.md)`，`specRoot = requirementDir/../../spec`，`tasksDir = requirementDir/tasks`。
生产文件类别声明：涉及文件行形如 `- 新建|修改（生产|测试|非生产）：<绝对路径> — <说明>`；缺类别即退出码 2。

## 函数清单
### skills/spec-docs/scripts/lint.sh
| 函数 | 职责 |
|---|---|
| `lint_spec_file` | 单个规则文件的格式、章节、编号、双向覆盖与实现细节扫描 |
| `lint_requirements` | 需求文档四节、变更表行数与格式、被引用规则存在且入索引 |
| `run_tasks_check` | `--tasks` 分支：校验参数唯一后转发任务检查脚本并透传退出码 |
| `main` | 子命令分派，未知用法输出用法并退出码 2 |

### skills/spec-docs/scripts/task-check.ts
| 函数 | 职责 |
|---|---|
| `parseArgs` | 恰接受一个需求文档路径，否则退出码 2 |
| `loadRequirement` | 读需求文档，解析第 3 节规范变更表得到新增/修改/删除规则清单 |
| `loadRuleAcceptance` | 读每条被引用规则，提取 AC 编号、AC 原文及其回指的 C 原文 |
| `readTaskFiles` | 读取 tasks 目录全部任务文件与索引，解析 frontmatter |
| `checkFrontmatter` | 字段集合与顺序、id 格式、files 绝对路径、refs 格式、parallel 布尔、verify 非空 |
| `checkSections` | 必需节次存在且非空，允许成品定义与新增第三方依赖为可选 |
| `countTaskLines` | 扣除示例与成品代码块（含围栏）后计数，未闭合围栏报错 |
| `classifyFile` | 按涉及文件行的类别声明分类，缺声明记为不可分类 |
| `checkFileOwnership` | 生产文件 ≤2、同一生产文件不得两任务持有、parallel 任务间文件两两不相交 |
| `checkDependencyGraph` | 依赖存在、不自引、只引更小编号、无环、parallel 任务依赖为空 |
| `checkIndex` | 索引 ≤30 行、每任务恰被链接一次、行格式、无指向不存在任务的链接 |
| `checkRefs` | refs ≤3、规则与 AC 存在、业务规则节含"来源：<域>/<name>。"且逐字包含 AC 原文与其回指 C 原文 |
| `checkCoverage` | 变更清单内新增/修改规则的全部 AC 被任务 refs 覆盖，删除规则文件已不存在 |
| `checkReadOnly` | 检查前后记录输入文件指纹一致 |
| `report` | 汇总为退出码与逐条可定位输出 |
| `main` | 串联以上步骤 |

## 协作关系
- `lint.sh --tasks` → `task-check.ts`；两者只读输入。
- 46 planner、45 需求代理在规划交付前调用 `lint.sh --tasks`；43 的格式是唯一口径。
- 不调用任务 verify 命令，不调用模型。

## 验证方式
- 测试入口：`bash skills/spec-docs/scripts/lint.sh --tasks <requirements.md>` 与 `bun skills/spec-docs/scripts/task-check.ts <requirements.md>`
- 测试输入：在临时目录构造 `.pi-company/spec/<域>/*.md`（含变更清单内规则与一条范围外规则）与 `requirements/<日期>.<slug>/{requirements.md,tasks/}`；有效案例：两个任务、全部 AC 覆盖、一个任务恰 200 行需计数内容并含不计的成品代码块；违规案例各只改一个条件：201 行、缺字段、缺索引链接、生产文件重复归属、向后依赖、依赖环、parallel 带依赖、refs 原文不一致、未知 AC 引用、缺类别声明、变更内规则漏一条 AC、不可读输入
- 预期结果：有效案例连续两次退出码 0 且首行为 `PASS: 仅证明任务机械条件，不证明行为正确`，输入文件指纹不变，verify 命令未被执行（verify 指向会写标记文件的脚本，标记文件不存在）；各违规案例退出码 1 且输出含对应任务 id 与字段名；缺类别与不可读案例退出码 2；范围外规则未覆盖的 AC 不报错
- [ ] 有效案例两次通过且只读
- [ ] 十一类违规各自定位
- [ ] 变更范围外验收不误报
- [ ] `--spec` 对含实现细节的规则文件报错
