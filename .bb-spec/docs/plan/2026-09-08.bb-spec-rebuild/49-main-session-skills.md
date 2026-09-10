---
name: main-session-skills
description: 主会话流程 Skill、规则与 README：澄清到确认后派出需求代理、续接与补充转发、修订与对账本机定位、提交前直接审查失败即回退执行阶段并重派需求代理、分支守卫、派工边界规则；README 全文重写
---
# 主会话流程 Skill、规则与使用说明

## 目标
完成后，主窗口 agent 只承担澄清、规范与需求文档、用户确认、派出需求代理、中继作答与提交推送；提交前审查失败时把需求退回执行阶段并重新派出需求代理接手返修。README 能让新用户独立完成安装、发起需求、观察与控制需求代理、配置角色、管理 Shell、理解本机数据与迁移，且内容与实际行为一致。

## 业务规则（来源：spec）
- requirement-agent / role-catalog：主会话在需求文档经用户确认后派出需求代理；主会话只派需求代理与提交前审查的白盒审查者，不直接派其他角色。
- user-relay：需求代理的提问由主会话展示并作答；用户补充由主会话判断归属，属于进行中需求时转发对应需求代理并取得回执，否则按新需求处理。
- workspace-coordination：窗口启动目录子树内的仓库构成工作区；需求涉及多个仓库时主会话把跨仓库契约以成品写入各仓库规范并各建需求文档，为每个仓库派一个需求代理；契约变更由主会话裁定并转发。
- state-transitions / version-bound-recovery：需求阶段只经运行信息工具推进或回退；续接、修订、对账从本机流程数据定位进度，多个候选需求由用户选择；缺失或损坏数据阻塞，不从文档推断。
- whitebox-review：提交前由主会话记录审查快照并一次直接派出白盒审查者；对象与快照一致且通过才允许远端写入；不一致或未提交即 FAIL，保留本地提交。
- review-failure-handling：提交前审查 FAIL 后需求回退到执行阶段，主会话重新派出需求代理（新运行身份）接手归因与返修；返修完成后重走验收与提交前审查。
- validation-consistency：提交只纳入本任务获准范围内的路径；其他宿主有活动任务时不切换分支或重置共享现场。
- decision-append：材料性决定先经决策记录工具取得回执再行动；用户未回答不留痕。
- namespaced-entrypoints：五个入口 `/pi-company:new|resume|revise|sync|setting` 与独立 `/ps`，不提供其他别名。
- daemon-host / cross-window-panel / transcript-view / status-entry / process-list / settings-page / data-ownership / safe-migration：README 描述的守护进程、面板、查看页、状态栏 Shell 汇总、`/ps`、设置页、本机数据与迁移行为以对应单元的实际行为为准。

## 涉及文件
- 修改 `skills/spec-flow/SKILL.md` — 重写为主会话流程
- 修改 `skills/spec-revise/SKILL.md` — 本机定位与受控回退
- 修改 `skills/spec-sync/SKILL.md` — 对账从本机数据取阶段，验收者由需求代理派出
- 修改 `skills/git-push/SKILL.md` — 直接审查、快照、范围提交、分支守卫、失败回退与重派
- 修改 `rules/04-decision-record.md` — 工具化决策记录与回执先于行动
- 修改 `rules/05-review-failure-handling.md` — 归因职责归需求代理，主会话只作答与回退重派
- 修改 `rules/01-task-routing.md` — 规范目录改为 `.pi-company/spec/`
- 修改 `extensions/dispatch.ts` — 派出需求代理的阶段门禁与守护进程同口径（draft/rejected/accepted 拒绝，其余放行），使提交前审查失败回退到 executing 后可重派（28 的定点修正，在本单元完成）
- 新建 `rules/06-dispatch-boundary.md` — 主会话派工边界
- 修改 `README.md` — 全文重写
- 新建 `tests/main-session-skills.test.ts` — 必需句 / 禁止句断言
- 新建 `tests/user-documentation.test.ts` — 章节与必需句断言

## 函数清单
`skills/spec-flow/SKILL.md` 必需段落：
| 段落 | 必须表达的规则 |
|---|---|
| 角色定位 | 主会话负责澄清、写规范与需求文档、取得用户确认、派出需求代理、中继作答；不规划任务、不派 planner/worker/acceptance、不推进执行阶段 |
| 工作区识别 | 按窗口启动目录子树发现仓库；需求涉及多个仓库时契约先写入各仓库规范（成品代码块）并各建需求文档 |
| 澄清与规范 | 递进式澄清；规则文件五节、≤100 行、不含实现细节；需求文档四节 |
| 确认与派出 | 用户确认后先经 `decision_record`（actor user）记录确认并取得回执，再依次 `pi_company_workflow init`、以当前 version 与该 decisionId `advance confirmed`、`pi_company_dispatch`；多仓库逐仓库派出 |
| 中继 | 收到需求代理提问时向用户展示选项并以 `pi_company_reply` 作答；契约变更请求由主会话裁定后更新各仓库规范并 `pi_company_forward` |
| 补充需求 | 判断是否属于本工作区进行中需求：是则 `pi_company_forward` 并向用户回执，否则走新需求 |
| 续接 | `/pi-company:resume` 从本机流程数据定位；多个候选让用户选择；数据缺失或损坏阻塞并说明，不从文档推断阶段；中断运行经 `pi_company_agents resumeInterrupted` |

`skills/spec-revise/SKILL.md`：复现 → 从本机数据定位需求与阶段 → 归因（实现缺陷 / 规范缺陷 / 需求变更）由用户选择后经 `decision_record`（actor user）记录取得回执 → 实现缺陷转发需求代理；规范缺陷或需求变更改规范后按当前阶段回退：planned 回退到 confirmed 再派出，reviewing/accepting 回退到 executing 后重新派出需求代理并要求重新提议形状，confirmed/executing 无需回退直接转发要求重新提议；回退前须确认该需求下无未停止运行；retreat 调用与 advance 同样写明 stage、version、reason、decisionId 四个参数；已 accepted 需求只读。
`skills/spec-sync/SKILL.md`：按域对账，规范→代码的验收由需求代理派 acceptance——域内有进行中需求时请该需求代理派出，需求已 accepted 或无需求时以一条对账需求（经确认后派出需求代理）承载验收；代码→规范由主会话只读盘点；裁决只两种：改规范或转 spec-revise。
`skills/git-push/SKILL.md`：预检 → 采集审查快照（分支头 + 内容指纹）→ 主会话一次直接派 reviewer → 对象字段、语义、快照三重核对 → 只 `git add` 本需求获准范围路径 → 推送已审快照 → 创建合并请求前复核；其他宿主有活动任务时不切换分支、不重置；FAIL 时向用户展示归因选项，用户选择后经 `decision_record`（actor user）记录取得回执，确认旧需求代理运行已结束后 `pi_company_workflow retreat` 到 executing，再 `pi_company_dispatch` 重新派出需求代理（新运行身份）接手归因与返修；返修完成后由需求代理重走验收，主会话再重采快照重审。
`rules/06-dispatch-boundary.md`：主会话只派需求代理与提交前白盒审查者；日常对话不派任何角色；需求代理只派角色目录内角色；角色不再向下派。

`README.md` 必需章节（二级标题顺序固定）：
| 章节 | 必须表达的内容 |
|---|---|
| 这是什么 | 三层模型一句话：主会话澄清确认 → 需求代理规划执行 → 角色子代理；守护进程内运行、跨窗口可见可控 |
| 安装 | `pi install git:github.com/0xBB2B/pi-company`；本地开发用绝对路径并自行 `bun install`；宿主 Node ≥ 22.19；不再需要安装其他子代理系统或符号链接 |
| 卸载 | `pi remove <source>`；守护进程会在空闲后退出，或按说明手动停止；本机数据目录保留，说明其位置 |
| 快速开始 | 五命令与 `/ps` 表；一次完整流程：`/pi-company:new` → 确认 → 面板出现需求代理 → 作答提议 → 完成通知 |
| 守护进程 | 自动拉起、每仓库一个、空闲退出时限、崩溃与重启后"中断"与续接、合盖睡眠不算超时、断网自动续接 |
| 面板与查看页 | 布局位置、空输入 ↓ 直接进入面板、←→ 在按钮间移动、Enter 执行当前按钮（按钮名以面板代码为准：暂停/继续/停止/续接/查看）；已结束条目灰显 20 秒后移出，控制动作失败或未确认的提示同样保留 20 秒；「查看」按钮上按 Enter 打开实时记录（只读） |
| 角色与设置 | 角色目录三层来源与包内默认五角色（项目级定义须项目受宿主信任才生效）；`/pi-company:setting` 主页按角色显示来源（只读）与模型、思考、MCP 三个可设字段，全局/项目范围切换；MCP 需自行安装适配器扩展，未安装时候选为空 |
| Shell 管理 | 本窗口主会话与本工作区各守护进程的 Shell 统一登记（工作区外不计入）、`background: true` 仅 agent 可用且仍受超时、状态栏汇总文本、`/ps` 列表与 K 停止、不确定任务的用户裁定 |
| 本机数据 | 目录布局以代码为准（数据根下 `repos/<仓库身份>/` 含仓库信息、需求、运行、会话记录、中继；socket 在数据根一级 `sock/`）、不随 Git 同步、旧 `.pi-spec` 数据的迁移预检与停写迁移步骤（迁移把运行字段与决策迁入本机数据；需求文档原地保留，仅从中移除已迁出的运行字段与决策记录，定义正文与验收报告不改写） |
| 多窗口与工作区 | 按启动目录划分、同仓库 worktree 共享、多仓库时契约先行由主会话裁定、范围占用与显式释放 |
| 常见问题 | 守护进程不可达怎么办；问题为什么出现在另一个窗口；为什么面板看不到别的项目；如何添加自定义角色；提交前审查失败后会发生什么 |
| 开发 | `bun install`、`bun test tests`、`pi install /abs/path` |

## 协作关系
- 依赖窗口派工工具、写入与分支守卫、角色提示词单元的 reviewer 定义、命令单元的入口名；需求代理承接派出后的全部编排。
- `rules/*.md` 由 `extensions/rules.ts` 注入系统提示。
- README 内容以命令、面板、查看页、设置页、Shell 管理页、迁移、工作区协作各单元的实际行为为准；文案中的命令名、状态名与 20 秒、空闲退出时限等常量须与代码一致。

## 验证方式
- 测试入口：读取上述 Skill、规则文件与 `README.md` 原文
- 测试输入：文件全文
- 预期结果：
  - spec-flow 必需句：`不规划任务`、`派出需求代理`、`pi_company_dispatch`、`pi_company_reply`、`pi_company_forward`、`从本机流程数据定位`、`不从文档推断阶段`、`契约先写入各仓库规范`；禁止句：`SubagentWorkflow`、`test-engineer`、`impl-engineer`、`status: executing`、`Agent(`、`派 planner`
  - git-push 必需句：`一次直接派`、`审查快照`、`本需求获准范围路径`、`不切换分支`、`retreat`、`重新派出需求代理`；禁止句：`git add .`、`--force`、`最多三轮`
  - spec-revise 必需句：`pi_company_workflow retreat`、`已 accepted 需求只读`；spec-sync 必需句：`由需求代理派 acceptance`
  - rules/06 必需句：`只派需求代理与提交前白盒审查者`、`角色不再向下派`；rules/04 必需句：`回执先于行动`；rules/05 必需句：`回退到执行阶段`
  - 窗口侧派工阻断阶段集与守护进程 BLOCKED_STAGES 动态比对一致；README 面板按钮名与 agents-panel 按钮标签一致；迁移描述与 migration.ts 的移除字段语义一致。
  - 文档中的工具调用形态与代码动态核对：spec-revise/git-push 的 retreat 目标阶段属于 workflow-state 允许的回退路径；派出需求代理的阶段门禁（extensions/dispatch.ts）放行 confirmed 之后的进行中阶段；retreat/advance 所用 decisionId 为用户决定；README 里的设置字段与 settings-ui 字段表一致、socket 路径与 identity 一致、`/pi-company:` 出现项全部在已注册命令集合内。
  - README 二级标题按上表顺序全部存在；必需句：`/pi-company:new`、`/pi-company:setting`、`/ps`、`每个仓库一个守护进程`、`自动拉起`、`空闲后自动退出`、`标记为中断`、`合盖睡眠`、`20 秒`、`background: true`、`.pi-company/`、`不随 Git 同步`、`按启动目录`、`pi install git:github.com/0xBB2B/pi-company`；禁止句：`pi-subagents`、`符号链接`、`/spec-new`、`/pi-spec:`、`汇总行`、`.pi-spec/`（迁移章节允许出现在"旧数据"语境，测试用正则排除 `旧` 前缀的行）
- [x] 各 Skill 与规则文件必需句全部命中、禁止句全部缺席
- [x] README 章节顺序断言
- [x] README 必需句全部命中、禁止句全部缺席
