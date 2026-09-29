# M9 状态

阶段目标：用实际安装产物和全新数据根，验证默认通用团队、专业定义扩展与选择、渐进需求、prod 限制、最小规则、持久索引与可选交付的真实闭环；实测性能与模型上下文成本；清理临时资料并交付证据与已知限制。

状态口径：「待核对」表示已有可复用的测试，但还没在本阶段基线上按 M9 要求（实际安装产物、真实模型或实测）重新取证；「未开始」表示还没有任何本阶段证据。M0–M8 的单元、集成测试只作可复用的测试素材，不直接算 M9 证据。

## AC 状态表

| AC | 状态 | 证据 | 剩余缺口 |
|---|---|---|---|
| AC1 一次安装离线解析首批语言，索引跨重启复用，丢失可重建 | 通过 | 本阶段基线上重跑：tests/installation/syntax-parser.test.ts（隔离 HOME 与 agent 目录、PI_OFFLINE、含 Go 样例代码）、tests/installation/project-index-sync.test.ts（daemon 重启后复用、同 mtime 离线改动；8020b19 新增：删除 index.db 后重启，下一次查询从允许文件自动重建并读到当前内容、不再弹确认、归档仍排除）；安装测试全部通过 | 无 |
| AC2 至少 10 个预登记问题，出处与权限可核对 | 未开始 | 无 | 问题集已由用户定为 11 题（见续接提示）；多段长跑用例 tests/acceptance/progressive-loop.test.ts（c8e75ac）运行中 |
| AC3 完整渐进需求场景：拆分、局部调整，错误代码不反改目标 | 未开始 | 可复用：tests/plan-assess.test.ts（脚本化模型） | 需真实模型在安装产物中跑一轮移动→快跑→跳跃→动画 |
| AC4 六职责、10 工具、拒读、目录排除、关闭竞争、旧 PM 不复用、无正文提醒矩阵；披露 §5.7 与 §10.4 限制 | 通过 | 矩阵逐行对照 .bb-spec/.cache/m9/matrix-13.1.md（38 行：完整 22、部分 15、无 1；无的「大小」行为 M8A 漏删的 spec 遗留，经用户同意已由 16a1621 删除）；本项所列权限、活动访问、关闭、正常正文入口、explore 结束与撤权、旧 PM 不复用各行均为完整覆盖，本基线单元 2341、安装产物集成 80 条通过；两项已知限制写入 README「已知限制」（2520a02）；会话与提醒行只断言关闭结果为无正文建议，未断言主会话不被清空（属已知限制，不作门槛） | 无 |
| AC5 关闭后本机 prod 保留，只有完成正文可归档；他人无需原作者数据可人工查归档 | 待核对 | 可复用：tests/team-clone.test.ts、tests/git-delivery.test.ts、tests/workflow-close.test.ts | 在安装产物全流程中复验一次；M8A-AC8 起归档带验收记录，复验时核对他人能在归档里看到 QA 结果 |
| AC6 无 prompts 模板与业务 Git 集成仍可存正文版本并交付；适配器不回显关闭正文 | 待核对 | 可复用：tests/zero-custom-loop.test.ts、tests/git-delivery-extension.test.ts、tests/git-delivery.test.ts | 在安装产物全流程中复验一次；M8A-AC8 起 Git 交付按归档整体 hash 核对 |
| AC7 类型、回归、集成、安装、性能、安全测试实际执行；两种更新调度实测；列出未覆盖项 | 未开始 | 无 | 阶段末全量执行；性能按 §13.2 在当前基线重测（可复用 tests/helpers/m3-benchmark.ts、tests/helpers/m4-query-benchmark.ts） |
| AC8 临时安装、克隆、需求 Git、数据库、WASM 验证文件、日志、进程清理 | 未开始 | 无 | 阶段末执行 |
| AC9 安装产物跑通受限接手、主代理核对、PM 规划与派工、增量复核、新 PM 重核对；伪身份在真实入口被拒 | 部分 | 安装产物真实模型：第 57 轮（AC12）与长跑第 1—3 轮的快跑、跳跃段均走通受限接手、主代理核对、PM 规划与派 worker/reviewer/QA；tests/integration/agent-gates.test.ts（36dd9d4，安装产物上通过）：未认证连接派 PM 被拒、已有有效 PM 时再派被拒 | 增量复核（长跑追加动画段）第 4 轮运行中；新物理 PM 重核对已在安装产物上实测（agent-gates M9-AC9 用例：停止后重派，核对前派 worker 以 intake_gate 被拒）|
| AC10 安装产物中 main 无需求与 PM 有需求的 explore，三种来源；main 未初始化纯网页成功单独实测 | 未开始 | 可复用：tests/explore-dispatch.test.ts、tests/explore-web.test.ts | 需真实模型与真实联网；本机出网慢，联网失败时该项标未完成，不以降级路径冒充 |
| AC11 接手与 explore 的上下文、工具结果、回读、重试、耗时实测 | 未开始 | 无 | 依赖 AC2 问题集与模型选定 |
| AC12 全新数据根、零自定义，真实模型走完需求到关闭 | 通过 | 第 57 轮（M8C 收口后基线 f46ae8c）：pnpm run test:acceptance -t "M9-AC12" 通过（1/1），9.7 分钟以完成关闭，全为默认定义，归档五大板块、实现记录在实现板块末尾、验收记录在验收板块末尾，项目规范经确认写入 AGENTS.md；PM 在关闭时停止（stopCause=requirement_closing）（证据 .bb-spec/.cache/m9/acceptance/zero-custom-2026-09-28T13-35-04-858Z）；该轮一个 explore 因 searchedScope 写 src/ 被误拒两次、未交结果，已由 6747b50 修复；真实模型有波动，单轮通过不代表每轮必过 | 无（2026-09-29 改用 sol 后重跑也通过：.bb-spec/.cache/m9/acceptance-sol/zero-custom-2026-09-28T16-09-14-871Z） |
| AC13 复制默认 worker 为专业定义，PM 自动选中完成 UI 设计与实现，独立 review/QA | 通过 | sol 第 3 次运行 pnpm run test:acceptance -t "M9-AC13" 通过：用户层复制默认 worker 为 ui-worker（只改名称、描述、skills: [ui-basics]），受信任项目自带 skill，PM 自动选中 ui-worker 完成 HUD 面板，运行记录 source=user 且加载 ui-basics，reviewer 与 QA 独立完成，需求以完成关闭（证据 .bb-spec/.cache/m9/acceptance-sol/ui-worker-2026-09-29T02-23-28-163Z）；前两次失败原因为草稿核验拒绝不带原因（已由 d5fe7de、a271185 修复） | 无 |
| AC14 安装产物中两类目录发现、环境变量覆盖、项目信任、同名冲突、不越根 | 部分 | tests/integration/agent-gates.test.ts M9-AC14 用例（1bec8fb，安装产物上通过）：daemon 从 dirname(dataRoot)/agents 与受信任项目的 .pi/agents 发现定义，项目未受信任时不加载，缺 role、同层重名、仓库外祖先目录不进能力目录，重名定义派工被拒；同名跨层按项目 > 用户 > 内置显式覆盖（计划已由 16a1621 统一表述，覆盖本身见 tests/role-catalog.test.ts） | PI_CODING_AGENT_DIR 覆盖下的发现待 AC13 真实模型运行取证（验收宿主经该变量设定 agentDir） |
| AC15 两种默认路径；显式指定不可用明确失败交用户裁决 | 部分 | 零专业定义全用默认：第 57 轮（AC12）全部运行 source=default；有专业定义但任务无匹配走默认 worker、指定不可用明确拒绝不静默改默认：tests/integration/agent-gates.test.ts M9-AC15/AC16 用例（安装产物上通过） | 「交用户裁决」目前靠 PM 按 agent_manage 说明去问用户，程序不自动生成待裁决事项（M7 既有设计）；授权内自动选择不逐次确认待 AC13 真实模型运行 |
| AC16 注入缺模型、缺 skill、冲突、越权、断网、运行中改配置，均明确阻塞 | 部分 | tests/integration/agent-gates.test.ts（安装产物上通过）：指定定义不存在、缺 skill、缺模型、思考等级不支持、越权声明工具均明确拒绝且不建运行；专业 worker 暂停期间改定义，续接被拒并以 config_changed 停止；断网：tests/integration/network-and-sleep.test.ts 在安装产物上通过（0515db3 起可用 pnpm run test:integration:installed） | 「模型已配置但不可访问（无凭据）」未注入 |
| AC17 真实模型请求、能力目录、skill 加载探针与运行元数据逐项对应 | 未开始 | 无 | 需真实模型 |
| AC18 默认与专业路径的目录、加载、输入输出、回读、重派、耗时实测 | 未开始 | 无 | 依赖 AC11 同一测量方法 |

## 当前阻塞

用户 2026-09-29 要求暂停，等待下一步指示。

进行中的改动（用户已同意方向，尚未实施）：所有报错都要返回具体原因，便于父代理判断。已完成三处（d5fe7de、a271185 草稿核验器拒绝带原因；08a8643 explore 提交被拒写明哪一项、网页检索补种类）；其余只有错误码或吞错的报错正在盘点，盘点结果存 .bb-spec/.cache/m9/error-inventory.md，确认清单与改法后再实施。已知一处：批准解释器 interpretation_denied、input_expired 不带原因，sol 长跑跳跃段因此卡住（主会话挂了待答问题，用户回「批准这一版」被拒）。

真实模型验收自 2026-09-29 起改用 5x/gpt-6-sol（用户决定）。sol 结果（证据 .bb-spec/.cache/m9/acceptance-sol/）：AC12、M8C-AC7 通过；AC13 第 3 次通过（ui-worker-2026-09-29T02-23-28-163Z）；AC10 第 2 次网页与本地检索成功、借助索引那次未交结果（explore-2026-09-29T02-12-03-991Z，原因已由 08a8643 修复，尚未重跑）；多段长跑第 3 次快跑段通过、跳跃段卡在批准解释器（progressive-2026-09-29T02-33-59-694Z）。sol token 用量约为 luna 的 2–4 倍。

## 下一窗口续接提示

```
项目：/Users/bb/.bb-spec/worktrees/pi-spec-bb-spec-rebuild（分支 bb-spec-rebuild，不推送）。
先完整读 AGENTS.md 与 SQLITE-KNOWLEDGE-REBUILD-PLAN.md（M9 章节与 §13），再读 M9-STATUS.md，核对 git status 与最近提交。M0–M8 已收口不重做。
用户已定的 M9 前提：
- 真实模型全部用 5x / gpt-6-sol（2026-09-29 由 luna 改），thinking high；隔离 agent 目录临时复制 models.json 与 auth.json（0600），每轮结束即删，不动 ~/.pi/agent。
- 真实模型与联网验收走 pnpm run test:acceptance（pnpm test 默认不跑）；pi 开发依赖为 0.87.1。
- 验证分工：AC2、3、10、11、12、13、17、18 用真实模型；AC9、14、15、16 在安装产物中用受控模型验程序门槛。
- AC2 问题集 11 题（快跑跑到关闭并归档、跳跃动画进行中之后提问：①水平速度怎么算在哪；②Go 的 Greet 做什么谁调用；③空中能否再跳依据哪段代码与测试；④进行中的跳跃动画要求哪些姿态；⑤不指定需求列出所有进行中需求内容；⑥最新批准版比上一版改了什么；⑦已完成快跑当时的验收标准；⑧快跑与跳跃的实现有没有相互影响（依据代码与测试）；⑨快跑测试正式通过了吗；⑩这次改动让移动计算快了多少；⑪参考 docs/prod 旧需求写新需求）。⑤⑦⑪须拒给正文，模型用普通 read 读归档即判未通过并记为旁路案例；⑨⑩无记录须答"未知"。
- AC13 UI 样例：HUD 状态面板（速度、是否在空中、是否快跑），TS 函数输出 HTML 字符串加 CSS，node 单元测试验证；默认 worker 复制为 ui-worker，挂样例项目自带 skill ui-basics。
当前：M8A、M8B、M8C 已收口，M9 恢复；M8C 起需求文档规范由 requirement-doc skill 定义（包内默认五大板块），运行记录 stopCause 写明停止原因，卡点可从 report.json 的 runs[].stopCause 查。AC12 在第 55 轮通过，归档记录改为插入所属板块后须重跑；之后按计划推进其余 AC（建议先 AC2 问题集，它依赖快跑已关闭并归档的状态）。真实模型运行命令：ONE_COMPANY_ACCEPTANCE_MODEL=5x/gpt-6-sol ONE_COMPANY_ACCEPTANCE_OUTPUT=<绝对路径> pnpm run test:acceptance，用后台运行加看门狗：证据目录 events.jsonl 10 分钟无更新就在该目录放 STOP 文件。每轮卡点从证据目录的 main-session.json、side-calls.json、runs/*.jsonl 查。
验证入口：pnpm run typecheck；pnpm test；pnpm run test:integration；pnpm run test:installation。
```
