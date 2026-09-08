---
name: spec-docs-format
description: 重写 spec-docs 技能与固定机械检查：.pi-company 目录树、任务文件只含定义字段（无并行字段）、验证约定块、成品定义块、200 行口径、决策本机保存；lint --spec/--tasks 与任务检查脚本核对格式、归属、依赖、验收覆盖与原文
---
# 需求与任务文档格式与机械检查

## 目标
完成后，产品的规则文件、需求文档、任务文件与验收报告有唯一的格式权威源；任务文件不再携带运行字段与并行声明（并行由依赖与写入范围推导）；需求代理、规划角色与用户通过同一条命令核对任务集合的机械条件，得到零退出码或可定位的失败原因，检查不改输入、不执行验证命令。

## 业务规则（来源：spec）
- data-ownership：需求名称、标题、创建日期、目标、非目标、规范变更与边界属于需求定义；任务编号、标题、依赖、文件范围、验收引用、验证方式与正文属于任务定义；两者保存在仓库。需求阶段、任务进度、子运行关联、提交、备注、返修轮次、阻塞原因属于运行信息，只保存在本机，不出现在仓库文档；检查以定义字段为准。
- decision-append：材料性决定由决策记录工具在本机追加，仓库需求目录不再存放决策文件。
- task-file-line-limit：每份任务文件按整份物理行计数（含元数据、标题、空行），示例代码块与成品代码块连同首尾围栏不计；计数不超过 200 行即满足，201 行超限；不把 200 行解释为代码改动量上限。
- verification-contract：每个任务的验证方式包含紧凑的验证约定——公开入口与真实契约、必须成立的行为、适用与不适用场景、允许模拟与必须真实贯通的边界、开发中目标测试 / 交付前受影响回归 / 全部完成后集成验证三层责任；不生成长篇测试设计文档。
- planning-artifacts：规范原文须准确内联到任务；跨仓库契约等声明式产物以成品代码块内联；规划角色使用固定检查入口，不临时编写检查器。
- mechanical-validation：检查入口固定，指定一个需求即核对其变更清单与任务集合；每任务至多两个生产文件、至多三条验收引用、正文计数上限、固定格式、索引与非空业务规则和验证方式；拒绝重复归属的生产文件、向后或不存在的依赖、依赖环、缺失或错误验收引用、与所引约束和验收原文不一致的内容；覆盖基准为本次新增或修改规则的全部验收，变更范围外的未覆盖验收不是缺项，未知规则或引用仍报错；输入不可读或类别无法确认时非零退出并定位；检查前后输入不变，不执行验证命令，不自动修复；格式说明必须与检查口径一致。

## 涉及文件
- 修改 `skills/spec-docs/SKILL.md` — 格式权威源全文重写
- 修改 `skills/spec-docs/requirements.template.md` — 去掉 status 运行字段，补工作区契约段落
- 新建 `skills/spec-docs/task.template.md` — 任务文件模板（含验证约定块与可选成品定义块）
- 修改 `skills/spec-docs/scripts/lint.sh` — 增加 `--tasks` 子命令并转发；`--spec` 保持规则文件检查
- 新建 `skills/spec-docs/scripts/task-check.ts` — 任务集合机械检查
- 新建 `tests/spec-docs-format.test.ts` — 必需句 / 禁止句与模板字段断言
- 新建 `tests/mechanical-validation.test.ts` — 真实夹具与退出码验证

## 成品定义
目录树（写入 SKILL.md）：
```
<repo>/.pi-company/
├── spec/
│   ├── INDEX.md                     - [<name>](<域>/<name>.md) — <description>
│   ├── GLOSSARY.md                  | 锚点 | 定义 | 别名 |
│   └── <域>/<name>.md               一规则一文件，≤100 行，五节：目的/逻辑/约束/例子/验收
└── requirements/<YYYY-MM-DD>.<slug>/
    ├── requirements.md              定义：name/title/created + 四节
    ├── tasks/INDEX.md               ≤30 行
    ├── tasks/NN-<name>.md           任务定义，≤200 行（扣除示例与成品代码块）
    └── acceptance.md                验收者唯一写入：result/date + 结果表/未覆盖/结论
```
任务文件 frontmatter（顺序固定，只含定义字段；无 parallel——可并行 = 无依赖关系且生产文件互不相交，由调度推导）：
```yaml
id: T-n
title: <标题>
depends_on: [T-a, T-b]        # 只能引用编号更小的任务
files: [<绝对路径>, ...]        # 生产文件 ≤ 2；同一生产文件只归一个任务
refs: [<域>/<name>/AC-n, ...]  # ≤ 3 条
verify: <一条命令，退出码 0 即通过>
```
任务正文固定节次：目标 / 业务规则（来源：<域>/<name>。逐字内联所引 AC 与其回指的 C）/ 涉及文件（`- 新建|修改（生产|测试|非生产）：<路径> — <说明>`）/ 成品定义（可选）/ 新增第三方依赖（可选）/ 函数清单 / 协作关系 / 验证方式。
验证方式块模板：
```markdown
## 验证方式
- 真实入口：<公开命令 / 工具 / 页面操作及其契约>
- 必须成立：<行为 1>；<行为 2>
- 场景：正常 / 拒绝 / 重复 / 交错 / 超时 / 退出（不适用项写明理由）
- 模拟边界：允许模拟 <外部边界>；必须真实贯通 <连接或保护>
- 三层责任：目标测试 <命令>；受影响回归 <命令或范围>；集成验证 <由谁在何处完成>
```
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
路径推导：`requirementDir = dirname(requirements.md)`，`specRoot = requirementDir/../../spec`，`tasksDir = requirementDir/tasks`。生产文件类别声明缺失即退出码 2。

## 函数清单
SKILL.md 必需段落：
| 段落 | 必须表达的规则 |
|---|---|
| 目录树 | 上述 `.pi-company/` 结构，且明确"决策记录与运行信息只保存在本机，不进入仓库" |
| 规则文件 | ≤100 行、name 与文件名一致、五节固定、C-n 与 AC-n 双向覆盖、每条 AC 含触发/Given/When/Then、不含代码路径与实现细节 |
| 需求文档 | frontmatter 仅 name/title/created；四节固定；第 3 节规范变更表 1–8 行；多仓库工作区时跨仓库契约以成品代码块内联到各仓库规范 |
| 任务文件 | 上述 frontmatter 字段表与节次；"任务文件不包含 status、step、agent、commit、note、parallel 等运行或调度字段"；验证约定块必填 |
| 200 行口径 | "每份任务文件扣除示例代码块与成品代码块（含首尾围栏）后最多 200 行，整份文件包括元数据、标题与空行一起计数，不限制任务的代码改动量" |
| 验收报告 | 验收者唯一写入；结果表列为 条目/结果/观察；任一 FAIL 或未覆盖即 rejected |
| 机械检查 | "任务集合的格式、归属、依赖与验收原文由固定检查入口核对，规划者不得自行编写检查脚本" |

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
| `checkFrontmatter` | 字段集合与顺序恰为 id、title、depends_on、files、refs、verify；id 格式、files 绝对路径、refs 格式、verify 非空；出现 parallel 或任何运行字段报错 |
| `checkSections` | 必需节次存在且非空，允许成品定义与新增第三方依赖为可选 |
| `countTaskLines` | 扣除示例与成品代码块（含围栏）后计数，未闭合围栏报错 |
| `classifyFile` | 按涉及文件行的类别声明分类，缺声明记为不可分类 |
| `checkFileOwnership` | 生产文件 ≤2、同一生产文件不得两任务持有 |
| `checkDependencyGraph` | 依赖存在、不自引、只引更小编号、无环 |
| `checkIndex` | 索引 ≤30 行、每任务恰被链接一次、行格式、无指向不存在任务的链接 |
| `checkRefs` | refs ≤3、规则与 AC 存在、业务规则节含"来源：<域>/<name>。"且逐字包含 AC 原文与其回指 C 原文 |
| `checkCoverage` | 变更清单内新增/修改规则的全部 AC 被任务 refs 覆盖，删除规则文件已不存在 |
| `checkReadOnly` | 检查前后记录输入文件指纹一致 |
| `report` | 汇总为退出码与逐条可定位输出 |
| `main` | 串联以上步骤 |

## 协作关系
- `lint.sh --tasks` → `task-check.ts`；两者只读输入，以本文件定义的字段与节次为唯一口径；不调用任务 verify 命令，不调用模型。
- 规划角色与需求代理在规划交付前调用 `lint.sh --tasks`；需求代理据本格式核对交付；运行信息工具承载本文件声明"不进仓库"的字段；守护进程调度按 depends_on 与 files 推导可并行任务。

## 验证方式
- 测试入口：读取 `skills/spec-docs/SKILL.md`、`requirements.template.md`、`task.template.md` 原文；`bash skills/spec-docs/scripts/lint.sh --tasks <requirements.md>` 与 `bun skills/spec-docs/scripts/task-check.ts <requirements.md>`
- 测试输入：文件全文字符串；在临时目录构造 `.pi-company/spec/<域>/*.md`（含变更清单内规则与一条范围外规则）与 `requirements/<日期>.<slug>/{requirements.md,tasks/}`；有效案例：两个任务、全部 AC 覆盖、一个任务恰 200 行需计数内容并含不计的成品代码块；违规案例各只改一个条件：201 行、缺字段、含 parallel 字段、缺索引链接、生产文件重复归属、向后依赖、依赖环、refs 原文不一致、未知 AC 引用、缺类别声明、变更内规则漏一条 AC、不可读输入
- 预期结果：
  - 必需句逐字存在：`.pi-company/`、`任务文件不包含 status、step、agent、commit、note、parallel 等运行或调度字段`、`扣除示例代码块与成品代码块（含首尾围栏）后最多 200 行`、`不限制任务的代码改动量`、`决策记录与运行信息只保存在本机，不进入仓库`、`验证约定`、`必须真实贯通`、`三层责任`、`规划者不得自行编写检查脚本`
  - 禁止句不存在：`.pi-spec/`、`ai-decisions.jsonl`、`user-decisions.jsonl`、`status: todo`、`agent: wf_`、`parallel:`、`预估改动不超过 200 行`
  - `task.template.md` frontmatter 键顺序恰为 id、title、depends_on、files、refs、verify；正文含"## 验证方式"且含五个要点行；`requirements.template.md` 无 `status:` 行，含 `## 1.` 至 `## 4.` 四节
  - 有效案例连续两次退出码 0 且首行为 `PASS: 仅证明任务机械条件，不证明行为正确`，输入文件指纹不变，verify 命令未被执行（verify 指向会写标记文件的脚本，标记文件不存在）；各违规案例退出码 1 且输出含对应任务 id 与字段名；缺类别与不可读案例退出码 2；范围外规则未覆盖的 AC 不报错
- [ ] 必需句全部命中、禁止句全部缺席
- [ ] 两份模板结构断言通过
- [ ] 有效案例两次通过且只读
- [ ] 十一类违规各自定位
- [ ] 变更范围外验收不误报
- [ ] `--spec` 对含实现细节的规则文件报错
