---
name: spec-docs
description: .pi-spec 的格式权威源——spec/<域>/<name>.md（唯一的现行规范，一规则一文件）、INDEX.md 与 GLOSSARY.md、需求目录（requirements.md 变更说明、tasks/ 一任务一文件、acceptance.md 验收报告、两个决策台账）。
---

# spec-docs：规范与需求包格式

## 目录与事实源

```
<repo>/.pi-spec/
├── .cache/                              临时证据（不提交）
├── spec/
│   ├── INDEX.md                         规则索引，按域分组
│   ├── GLOSSARY.md                      术语唯一权威源
│   └── <域>/<name>.md                   一规则一文件，系统此刻的对外行为
└── requirements/<YYYY-MM-DD>.<slug>/
    ├── requirements.md                  本次变更的背景、目标、触及的规范清单与边界
    ├── tasks/
    │   ├── INDEX.md                     阶段分组、依赖、被否定的备选方案
    │   └── NN-<name>.md                 一任务一文件，自包含
    ├── acceptance.md                    黑盒验收报告
    ├── ai-decisions.jsonl               本需求唯一的 AI 决策事实源
    └── user-decisions.jsonl             本需求唯一的用户决策事实源
```

`spec/` 是系统“做什么”的唯一事实源：需求澄清的结果直接写成规则文件的新增、修改或删除，任务、验收与修订归因都以规则文件为准。规则文件只描述当前行为，不写日期、变更来源、历史对照或过渡标记；作废的规则直接删文件，变更追溯只靠 git。`requirements.md` 只说明本次变更为什么做、改了哪些规则文件、边界在哪，不复述规则内容。

`ai-decisions.jsonl` 与 `user-decisions.jsonl` 分开保存本需求已形成的材料性决定；一项决定恰好占一行，两个台账不得与其他需求混写。决策台账是追加式事实源，既有行不得改写、删除或重新编号。

新需求先建分支（分支名 = slug），复制 `requirements.template.md`，建立 `tasks/INDEX.md` 与 `acceptance.md` 占位，建立两个空台账，形成需求包。

`<slug>`、`<域>` 与规则 `<name>` 均为小写英文短横线连接。

## spec/<域>/<name>.md

一规则一文件，只讲一件事，不超过 100 行，强制放在域子目录下，即便该域当前只有一条规则。frontmatter 与正文章节固定：

```
---
name: <kebab-case，与文件名一致>
description: <一句话，不超过 80 字>
---
# <规则标题>

## 目的
<一句话：这条规则为谁解决什么问题>

## 逻辑
<3～10 行：触发、过程、结果，只描述对外可观察行为>

## 约束
- C-1：<EARS 句式，一条一行>
- C-2：...

## 例子
<一个具体场景：输入、过程、预期结果>

## 验收
### AC-1 <标题>  ← C-1
- 触发: 命令 <命令行> | 请求 <方法 路径 + 载荷> | 操作 <界面步骤>
- Given: <前置状态，含数据准备>
- When: <外部输入，与触发一致>
- Then: <可观察输出：返回值 / 响应 / 界面 / 副作用>
```

约束用 EARS 五种句式之一：

| 句式 | 模板 |
|---|---|
| 恒定 | 系统应 <行为> |
| 事件驱动 | 当 <事件> 时，系统应 <行为> |
| 状态驱动 | 在 <状态> 期间，系统应 <行为> |
| 异常行为 | 如果 <非期望条件>，系统应 <行为> |
| 可选特性 | 若启用 <特性>，系统应 <行为> |

每条约束必须可证伪，能写成“什么输入 → 什么结果”；“健壮、友好、高性能”之类没有判定标准的表述禁写。每个功能点至少有一条异常行为约束覆盖失败路径。每条约束至少被一条验收覆盖，每条验收至少回指一条约束。`C-n` 与 `AC-n` 只在本文件内编号，删除条目后编号不复用；跨文件引用写 `<域>/<name>/AC-n`。Then 必须是黑盒可观察结果，数值指标写具体数字和单位。

规则文件禁写源码文件路径、目录名、模块名、函数名、类名、变量名、第三方库名、技术栈名、数据库表名和代码块；命令行、HTTP 路径和界面元素属于黑盒契约，允许写。禁止引用其他规则文件，需要的内容内联复述；术语直接使用 GLOSSARY.md 登记的写法。

## spec/INDEX.md 与 spec/GLOSSARY.md

INDEX.md 每条一行，按域分组，同域按字母序：

```
# 规范索引

## <域>

- [<name>](<域>/<name>.md) — <description>
```

GLOSSARY.md 是全项目术语的唯一权威源，只登记实际使用过的术语与写法：

```
# 术语表

| 锚点 | 定义 | 别名 |
|---|---|---|
| order | 用户提交购买意图后生成的待履约交易单据 | 订单 |
```

## requirements.md

模板固定为且只能为第 1～4 节：

1. 背景：谁在什么场景遇到什么问题；现状只写与现行规范的差异
2. 目标与非目标：目标带可量化指标与单位
3. 规范变更：表格，每行一个规则文件，`| <域>/<name> | 新增 或 修改 或 删除 | 一句话说明 |`；单个需求最多 8 行，超出时拆成多个需求
4. 边界与已知坑：数据量与并发、失败与重试、上下游约束、已知坑

frontmatter 的 `status` 取值为：`draft`（澄清中）、`confirmed`（用户已确认）、`planned`（任务文件已产出）、`executing`（执行中）、`accepting`（验收中）、`accepted` 或 `rejected`。draft 中断恢复时依据当前规则文件与本文档重新识别缺失信息并重新澄清，不从未回答、忽略或取消的问题恢复请求记录。

## tasks/

任务目录由 planner 产出，一任务一文件，每个文件自包含：仅凭该文件与仓库现有代码即可完成测试、实现与审查，不写“见 requirements”式引用。

`tasks/INDEX.md` 不超过 30 行：按阶段分组列出任务，每行 `- [T-n <标题>](NN-<name>.md) — <一句话>`，依赖标 `[依赖: T-m]`；末尾列出被否定的备选方案及理由。

`tasks/NN-<name>.md`（`NN` 为两位执行序号，`<name>` 为 kebab-case）。

每份任务文件扣除示例代码块与成品代码块后最多 200 行，不限制任务的代码改动量。
按整份文件统计物理行，计入 frontmatter 元数据及其分隔行、标题、正文和空行，每份文件独立计算。
示例代码块与成品代码块的全部内容及首尾围栏不计数，除此之外的内容均正常计数。
计数恰为 200 行时满足行数要求，超过 200 行时报告任务文件超过 200 行。
不限制预估或实际代码改动量，不得仅因代码改动超过 200 行而要求拆分任务或拒绝任务。

计数示例：
- 在 200 行需计数内容之外新增一行元数据、一个标题或一个空行，均变为 201 行并报告任务文件超限。
- 在 200 行需计数内容之外，添加连同围栏共 102 行的示例代码块、成品代码块或同时添加两者，仍为 200 行；在代码块外再新增一行说明文字则为 201 行并报告任务文件超限。
- 其余任务要求均满足且任务文件需计数内容为 200 行时，预估修改 500 行代码、实际修改 600 行代码，在规划和完成核对时均满足任务文件行数要求。

frontmatter 字段顺序固定：

```
---
id: T-n
title: <标题>
depends_on: [T-a, T-b]
files: [<完整路径>, ...]
refs: [<域>/<name>/AC-n, ...]
parallel: true | false
verify: <一条命令，退出码 0 即通过>
status: todo | doing | done | failed
step: test | impl | review
agent: <当前或最近一次派工的 workflow run id>
commit: <完成时的 commit hash>
note: <失败原因或续接备注>
---
```

正文章节固定：

1. 目标：一句话，完成后系统具备什么能力
2. 业务规则：内联复述本任务 refs 指向的约束与验收原文
3. 涉及文件：每行标新建或修改
4. 成品定义（仅声明式产物时存在）：DDL、API 契约、配置的完整成品，exec 原样落盘不得改写
5. 新增第三方依赖（仅本任务引入新库时存在）：库名、用途、版本策略
6. 函数清单：按文件列函数名与职责一句话，不写参数、返回值与实现
7. 协作关系：函数调用关系与外部依赖
8. 验证方式：测试入口、测试输入、预期结果、错误场景，只写公开入口不写内部实现路径；必须逐条覆盖目标与涉及文件所隐含的每个可观察变化。交付物是提示词或规范文本时，写成“必须出现的句子”与“必须不再出现的句子”两张清单，测试逐条断言，不做通用语义检测

三个角色各读其块：test-engineer 读业务规则与验证方式；impl-engineer 读涉及文件、成品定义、新增第三方依赖、函数清单、协作关系；review-engineer 读整份。

一个任务是一个竖切片：`files` 中生产文件不超过 2 个，`refs` 不超过 3 条，任务文件行数按本文件上述完整计数口径核对；触碰同一生产文件的行为合并进同一个任务，不得拆成 `depends_on` 链。`files` 两两不相交的任务才可并行；`depends_on` 只能引用编号更小的任务；本次新增或修改的每个规则文件的每条验收至少被一个任务 refs 覆盖。`status`、`step`、`agent`、`commit`、`note` 五个运行字段只由主 agent 写；结构化门禁对象只在 workflow 内存中传递，不写入任务文件。

## acceptance.md

验收报告 frontmatter 为 `result: accepted | rejected` 与 `date: <YYYY-MM-DD>`，正文固定为结果表、未覆盖和结论。任一条目 FAIL 或未覆盖即 rejected。

## canonical v1 决策台账

两个 ledger 都是 LF 结尾的追加式 JSONL。文件为空，或每行一个紧凑 JSON 对象并以单个 `\n` 结尾；空行、尾部缺换行、未知字段、legacy `event` / `status` / `pending` / `resolved` / `resolves` 形状和反向 `supersededBy` 均拒绝。每个需求只允许自己的两个台账，`requirement` 必须精确等于目录 slug。

AI 行的完整字段为：

```typescript
type AiDecisionV1 = {
  id: `AI-${number}`
  recordedAt: string
  actor: "ai"
  source: string
  requirement: string
  scope: string
  trigger: string
  decision: string
  basis: string[]
  alternatives: string[]
  action: string
  supersedes?: DecisionId[]
}
```

用户行的完整字段为：

```typescript
type UserDecisionV1 = {
  id: `USER-${number}`
  recordedAt: string
  actor: "user"
  source: string
  requirement: string
  trigger: string
  decision: string
  alternatives: string[]
  impact: string
  supersedes?: DecisionId[]
}
```

未知字段拒绝；字符串必须非空；数组不得含重复值；AI 的 basis 与 alternatives 至少一项，用户 alternatives 可为空；recordedAt 必须是 UTC RFC3339；各自 ledger 的 ID 数字后缀严格递增但允许一次性迁移形成的编号空洞。`supersedes` 只能由新追加的行指向两个 ledger 中已经存在的更早决定，目标行不增加反向字段；不得前向引用、重复引用或形成环。替换或纠错只追加新决定。

材料性判定同时要求：存在合理替代方案；已选方案并非现行规则或已批准计划唯一确定；并且会改变行为、范围、授权、架构、风险、恢复路径或流程分支。观察、测试结果、命令输出、Reviewer verdict、机械执行、工具调用、固定状态转换、临时想法以及未回答、忽略或取消的问题不记录。决定必须在关联动作之前成功写入，记录失败则关联动作失败关闭。

### writer API 与命令

唯一 writer 提供以下 API：

```typescript
type DecisionRecordInput = {
  requirementDir: string
  actor: "ai" | "user"
  source: string
  scope?: string
  trigger: string
  decision: string
  basis?: string[]
  alternatives: string[]
  action?: string
  impact?: string
  supersedes?: DecisionId[]
  materiality: {
    alternativesExist: true
    notUniquelyDetermined: true
    effects: Array<"behavior" | "scope" | "authorization" | "architecture" | "risk" | "recovery" | "flow-branch">
  }
}

type DecisionReceiptV1 = {
  schema: "decision-receipt/v1"
  receiptId: string
  decisionId: DecisionId
  actor: "ai" | "user"
  requirementDir: string
  ledgerPath: string
  lineNumber: number
  decisionHash: string
  recordedAt: string
}
```

AI 输入必须有 scope、basis、action 且不得有 impact；user 输入必须有 impact 且不得有 scope、basis、action。writer 生成 id、actor、recordedAt 和 ledger 路由。成功只表示一行已 fsync 且双 ledger 写后重读校验；receipt 的 decisionHash 是最终单行 canonical JSON 加换行的 SHA-256。writer 不读取迁移 mapping。

append 只能由受材料性检查保护的 `decision_record` 调用，不能通过通用 append CLI 绕过检查。追加在需求级原子锁中完成，单次 O_APPEND 写入后 fsync、写后重读并精确核对旧字节前缀；任何失败不返回 receipt，不截断、重写或删除既有行。ID 分配使用该 ledger 已有最大数字后缀加一。

## accepted 边界

accepted 后 requirements 契约、tasks/ 下全部任务文件和 acceptance 验收交付物冻结，只允许向已有的两个 ledger 台账追加与该需求相关的新决定。追加不得改写目标 ledger 的旧字节前缀，不得改变另一 ledger 或其他交付物；缺少或不匹配冻结快照时失败关闭，不能从可疑当前内容自动重建。任何新决定都仍须经过完整 canonical v1 校验、需求隔离、ID 与 supersedes 约束。

## 自检与 lint

确认前逐条检查每条约束是否必要、无歧义、单一且可证伪，验收是否能由第三方仅凭规则文件执行，然后运行：

```
bash <本 skill 所在目录>/scripts/lint.sh <requirements.md 路径>
```

lint 必须确认 requirements 恰好为第 1～4 节、规范变更表非空且不超过 8 行；对每个新增或修改的规则文件确认文件存在且已入 INDEX、frontmatter name 与文件名一致、章节固定、不超过 100 行、无实现细节、约束与验收互相完整覆盖、验收具有固定四行结构；对每个删除的规则文件确认文件已不存在且已从 INDEX 移除；并验证同目录两个 canonical v1 ledger。输出 FAIL 时不得进入 `confirmed`。
