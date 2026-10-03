# M9 状态

阶段目标：用实际安装产物和全新数据根，验证默认通用团队、专业定义扩展与选择、渐进需求、prod 限制、最小规则、持久索引与可选交付的真实闭环；实测性能与模型上下文成本；清理临时资料并交付证据与已知限制。

状态口径：「待核对」表示已有可复用的测试，但还没在本阶段基线上按 M9 要求（实际安装产物、真实模型或实测）重新取证；「未开始」表示还没有任何本阶段证据。M0–M8 的单元、集成测试只作可复用的测试素材，不直接算 M9 证据。

## AC 状态表

| AC | 状态 | 证据 | 剩余缺口 |
|---|---|---|---|
| AC1 一次安装离线解析首批语言，索引跨重启复用，丢失可重建 | 通过 | 本阶段基线上重跑：tests/installation/syntax-parser.test.ts（隔离 HOME 与 agent 目录、PI_OFFLINE、含 Go 样例代码）、tests/installation/project-index-sync.test.ts（daemon 重启后复用、同 mtime 离线改动；8020b19 新增：删除 index.db 后重启，下一次查询从允许文件自动重建并读到当前内容、不再弹确认、归档仍排除）；安装测试全部通过 | 无 |
| AC2 至少 10 个预登记问题，出处与权限可核对 | 通过 | 2026-10-03 基线 7185c86：主会话 5x/gpt-6.1-sol、thinking high，pnpm run test:acceptance -t "M9-AC2" 通过（1/1，49 分钟）；快跑关闭并归档、跳跃追加动画一次批准登记并由 PM 复核之后，13 题全部作答，逐题核对出处与权限全部合格：①②③⑧读当前代码与测试，④⑥经需求工具读批准版正文与差异，⑤先 list 再经需求工具读出进行中需求，⑦⑪读归档在允许范围内，⑨依据归档验收记录作答，⑩答未知，⑫需求工具拒读已关闭需求，⑬依据 AGENTS.md 指出规范冲突；未绕读本机需求存储（证据 .bb-spec/.cache/m9/acceptance-sol61/progressive-2026-10-03T14-15-17-768Z，逐题核对见其中 questions-verified.md） | 只跑了一轮最终基线；真实模型有波动，单轮通过不代表每轮必过 |
| AC3 完整渐进需求场景：拆分、局部调整，错误代码不反改目标 | 部分 | 同一轮长跑：快跑完成关闭并合并；跳跃批准后实施，追加动画批准后 PM 收到版本通知、用 diff 按需读完差异、逐任务复核并局部调整计划（证据 .bb-spec/.cache/m9/acceptance-sol-r11/progressive-2026-09-29T17-05-06-474Z/runs、report-animation.json） | 「代码错误不能反向改目标」未在真实模型中单独注入取证 |
| AC4 六职责、10 工具、拒读、目录排除、关闭竞争、旧 PM 不复用、无正文提醒矩阵；披露 §5.7 与 §10.4 限制 | 通过 | 矩阵逐行对照 .bb-spec/.cache/m9/matrix-13.1.md（38 行：完整 22、部分 15、无 1；无的「大小」行为 M8A 漏删的 spec 遗留，经用户同意已由 16a1621 删除）；本项所列权限、活动访问、关闭、正常正文入口、explore 结束与撤权、旧 PM 不复用各行均为完整覆盖，本基线单元 2341、安装产物集成 80 条通过；两项已知限制写入 README「已知限制」（2520a02）；会话与提醒行只断言关闭结果为无正文建议，未断言主会话不被清空（属已知限制，不作门槛） | 无 |
| AC5 关闭后本机 prod 保留，只有完成正文可归档；他人无需原作者数据可人工查归档 | 待核对 | 可复用：tests/team-clone.test.ts、tests/git-delivery.test.ts、tests/workflow-close.test.ts | 在安装产物全流程中复验一次；M8A-AC8 起归档带验收记录，复验时核对他人能在归档里看到 QA 结果 |
| AC6 无 prompts 模板与业务 Git 集成仍可存正文版本并交付；适配器不回显关闭正文 | 待核对 | 可复用：tests/zero-custom-loop.test.ts、tests/git-delivery-extension.test.ts、tests/git-delivery.test.ts | 在安装产物全流程中复验一次；M8A-AC8 起 Git 交付按归档整体 hash 核对 |
| AC7 类型、回归、集成、安装、性能、安全测试实际执行；两种更新调度实测；列出未覆盖项 | 未开始 | 无 | 阶段末全量执行；性能按 §13.2 在当前基线重测（可复用 tests/helpers/m3-benchmark.ts、tests/helpers/m4-query-benchmark.ts） |
| AC8 临时安装、克隆、需求 Git、数据库、WASM 验证文件、日志、进程清理 | 未开始 | 无 | 阶段末执行 |
| AC9 安装产物跑通受限接手、主代理核对、PM 规划与派工、增量复核、新 PM 重核对；伪身份在真实入口被拒 | 通过 | 真实模型：r11 长跑三段均走通受限接手、主代理核对、PM 规划与派 worker/reviewer/QA，追加动画段走通增量复核（.bb-spec/.cache/m9/acceptance-sol-r11/progressive-2026-09-29T17-05-06-474Z）；tests/integration/agent-gates.test.ts（安装产物上通过）：未认证连接派 PM 被拒、已有有效 PM 时再派被拒、停止后重派的新 PM 核对前派 worker 以 intake_gate 被拒 | 无 |
| AC10 安装产物中 main 无需求与 PM 有需求的 explore，三种来源；main 未初始化纯网页成功单独实测 | 部分 | 2026-09-29 新基线 e59d62d 上 sol 运行 tests/acceptance/explore-loop.test.ts 通过：main 在无需求、未初始化时派 explore 纯网页检索成功（7 轮）、本地文件检索成功（3 轮），初始化索引后检索成功（5 轮），全程未建需求，explore 会话父为 main、requirementId 为空（证据 .bb-spec/.cache/m9/acceptance-sol/explore-2026-09-29T06-59-50-272Z）；PM 父 explore 见各长跑与 AC12 运行 | PM 父 explore 的撤权、接管失效在安装产物真实模型中未单独取证；网络失败降级未单列 |
| AC11 接手与 explore 的上下文、工具结果、回读、重试、耗时实测 | 未开始 | 无 | 依赖 AC2 问题集与模型选定 |
| AC12 全新数据根、零自定义，真实模型走完需求到关闭 | 通过 | 2026-10-03 基线 b73e356（含 M8F 到 M8J）：主会话 5x/gpt-6.1-sol、thinking high，pnpm run test:acceptance -t "M9-AC12" 通过（1/1），16 分钟以完成关闭；全部运行用包内默认定义、模型都是 gpt-6.1-sol，解释器与草稿核验器走 gpt-6-luna；首条消息里的规范经三选弹窗选"写入"后写进 AGENTS.md，交付源码里导出的常量全是大写加下划线，reviewer 结论写明按该规范核对过；归档五大板块与两段记录位置正确（证据 .bb-spec/.cache/m9/acceptance-sol61/zero-custom-2026-10-02T17-44-18-713Z） | 只跑了一轮；真实模型有波动，单轮通过不代表每轮必过 |
| AC13 复制默认 worker 为专业定义，PM 自动选中完成 UI 设计与实现，独立 review/QA | 通过 | 2026-10-03 第 14 轮：主会话 5x/gpt-6.1-sol，pnpm run test:acceptance -t "M9-AC13" 通过（1/1），28 分钟以完成关闭；PM 查角色目录后把 2 个任务标为界面任务并指定 ui-worker，4 次 worker 运行都是用户层的 ui-worker 且加载 ui-basics；两个界面任务都先做原型，验收宿主在"确认原型"窗口选通过后才派实现，打开浏览器用假的 open 脚本代替并记下两份原型路径；两次任务级审查通过，QA 用 read 读了原型；需求以完成关闭（证据 .bb-spec/.cache/m9/acceptance-sol61/ui-worker-2026-10-02T17-15-22-144Z） | 前 13 轮没通过，逐轮原因与对应修改见「当前阻塞」下的记录；真实模型有波动，单轮通过不代表每轮必过 |
| AC14 安装产物中两类目录发现、环境变量覆盖、项目信任、同名冲突、不越根 | 部分 | tests/integration/agent-gates.test.ts M9-AC14 用例（1bec8fb，安装产物上通过）：daemon 从 dirname(dataRoot)/agents 与受信任项目的 .pi/agents 发现定义，项目未受信任时不加载，缺 role、同层重名、仓库外祖先目录不进能力目录，重名定义派工被拒；同名跨层按项目 > 用户 > 内置显式覆盖（计划已由 16a1621 统一表述，覆盖本身见 tests/role-catalog.test.ts） | PI_CODING_AGENT_DIR 覆盖下的发现待 AC13 真实模型运行取证（验收宿主经该变量设定 agentDir） |
| AC15 两种默认路径；显式指定不可用明确失败交用户裁决 | 部分 | 零专业定义全用默认：第 57 轮（AC12）全部运行 source=default；有专业定义但任务无匹配走默认 worker、指定不可用明确拒绝不静默改默认：tests/integration/agent-gates.test.ts M9-AC15/AC16 用例（安装产物上通过） | 「交用户裁决」目前靠 PM 按 agent_manage 说明去问用户，程序不自动生成待裁决事项（M7 既有设计）；授权内自动选择不逐次确认待 AC13 真实模型运行 |
| AC16 注入缺模型、缺 skill、冲突、越权、断网、运行中改配置，均明确阻塞 | 部分 | tests/integration/agent-gates.test.ts（安装产物上通过）：指定定义不存在、缺 skill、缺模型、思考等级不支持、越权声明工具均明确拒绝且不建运行；专业 worker 暂停期间改定义，续接被拒并以 config_changed 停止；断网：tests/integration/network-and-sleep.test.ts 在安装产物上通过（0515db3 起可用 pnpm run test:integration:installed） | 「模型已配置但不可访问（无凭据）」未注入 |
| AC17 真实模型请求、能力目录、skill 加载探针与运行元数据逐项对应 | 未开始 | 无 | 需真实模型 |
| AC18 默认与专业路径的目录、加载、输入输出、回读、重派、耗时实测 | 未开始 | 无 | 依赖 AC11 同一测量方法 |

## 当前阻塞

无。最终基线 7185c86 上 typecheck 通过，单元 2458 条里 2457 通过（没过的 1 条是 SQLite 等锁计时，本机睡 10 毫秒 20 次实测 1238 毫秒），集成 56 条全过，安装 11 条通过（1 条需 Docker 跳过）。

2026-10-03 跑 AC2 共 5 轮才通过，途中的改动（均经用户决定，范围与验收写入计划 M8K）：第 1、2 轮停在追加动画后批准登记不上：批准分段与各处按段数设的条数上限（20 段、16 个）是 M4 到 M7 实现时定的数字、计划没写具体值，追加后草稿有 22 段；经用户决定全部去掉，大小仍由正文、请求、清单各 64KB、交互上下文 48KB 与解释器输出上限管住（324fe92、6ff3194）；标题编号不合规时写明原因（324fe92）。问题集按用户决定加⑫⑬两题、⑨预期改为依据归档回答（380c2cc）。第 3 轮④⑥因模型自填全 0 游标没读到正文，改为全零占位游标按第一页（6e7300c）；⑤主代理不知道有哪些需求，需求工具加只给主代理的 list（2424b40）。第 4 轮 list 绕过送达登记、结果一律报已过期，已修（7185c86）。

2026-10-02 至 03 为跑通 AC13 共跑 14 轮，途中的改动（设计改动均经用户决定）：
- 设计改动：M8F 包内定义写明模型（解释器与草稿核验器 gpt-6-luna 加 medium，其余 gpt-6.1-sol）；M8G 修改草稿时核验器对照上一版；M8H PM 做计划前先查角色目录；M8I 没有浏览器时界面任务按输出与原型文件对照、没用掉的再给一次机会在只改说明文字时随任务修改保留（改其他内容直接拒绝，用户 2026-10-03 收紧）；M8J 解释器时限 120 秒。
- 真实安装下才暴露的缺陷：PM 提交接手理解的预检少一条场景出处规则（2693a03）；取原型信息与登记原型决定的两个方法没进协议方法清单（c63e181）；核对通过后 PM 又交一份时面板不提示重新核对（26b3d28）；需求在草稿阶段提过问后验收与裁决登记不上（84b9676）。
- 本机模型配置：~/.pi/agent/models.json 里 gpt-6.1-sol 的 "off" 由 "none" 改为 null（该模型不接受关思考）。
- 验收脚手架（tests/acceptance/）：原型确认窗口自动选通过；用假的 open 脚本代替打开浏览器；接手事项在 PM 又动过之后重开；"待你裁决"事项用固定台词回答；事项消失后再出现的同名事项重新打开；开了思考的内部调用也录进 side-calls.json。

此前的记录：2026-09-29 至 30 为跑通多段长跑修了九处（均经用户决定）：续租后接回租约；差异改为 PM 按需用 diff 查且读完才能复核；解释器重答发完整输入；草稿核验器能看到主代理提问；授权按整条目标补齐；待更新任务目标被收回可升级给用户；QA 只验实施授权内验收；草稿重存作废段落已变的旧提问；主代理可读 docs/prod 归档。另改样例规范触发条件补「不按 Shift」。

## 下一窗口续接提示

```
项目：/Users/bb/.bb-spec/worktrees/pi-spec-bb-spec-rebuild（分支 bb-spec-rebuild，不推送）。
先完整读 AGENTS.md 与 SQLITE-KNOWLEDGE-REBUILD-PLAN.md（M8F 到 M8K、M9 章节与 §13），再读 M9-STATUS.md，核对 git status 与最近提交。M0–M8 已收口不重做。
用户已定的 M9 前提：
- 真实模型验收的主会话用 5x / gpt-6.1-sol（2026-09-29 由 luna 改为 gpt-6-sol，2026-10-02 用户改为 gpt-6.1-sol），thinking high；子代理与内部调用的模型由包内定义写明（M8F）；隔离 agent 目录临时复制 models.json 与 auth.json（0600），每轮结束即删，不动 ~/.pi/agent。
- 真实模型与联网验收走 pnpm run test:acceptance（pnpm test 默认不跑）；pi 开发依赖为 0.87.1。
- 验证分工：AC3、10、11、17、18 用真实模型（AC2、12、13 已通过）；AC9、14、15、16 在安装产物中用受控模型验程序门槛。
- AC2 问题集 13 题（快跑跑到关闭并归档、跳跃动画进行中之后提问：①水平速度怎么算在哪；②Go 的 Greet 做什么谁调用；③空中能否再跳依据哪段代码与测试；④进行中的跳跃动画要求哪些姿态；⑤不指定需求列出所有进行中需求内容；⑥最新批准版比上一版改了什么；⑦已完成快跑当时的验收标准；⑧快跑与跳跃的实现有没有相互影响（依据代码与测试）；⑨快跑测试正式通过了吗；⑩这次改动让移动计算快了多少；⑪参考 docs/prod 旧需求写新需求；⑫用需求工具读已完成快跑需求的正文；⑬WALK_SPEED 改名 walkSpeed 是否合项目规范，提问前样例仓库提交 AGENTS.md）。⑤主代理先用需求工具 list 列出进行中需求，再经需求工具读出内容，不得绕开需求工具直接读本机需求存储（M8K）；⑦⑪主代理可直接读 docs/prod 归档（2026-09-30 用户决定）；⑨依据归档验收记录回答并写明出处（2026-10-03 用户决定）；⑩无记录须答"未知"；⑫预期需求工具拒读；⑬预期依据 AGENTS.md 指出冲突。
- AC13 UI 样例：HUD 状态面板（速度、是否在空中、是否快跑），TS 函数输出 HTML 字符串加 CSS，node 单元测试验证；默认 worker 复制为 ui-worker，挂样例项目自带 skill ui-basics。
当前：M8A 到 M8K 已收口，M9 恢复，AC12、AC13 已在 2026-10-03 重跑通过；M8C 起需求文档规范由 requirement-doc skill 定义（包内默认五大板块），运行记录 stopCause 写明停止原因，卡点可从 report.json 的 runs[].stopCause 查。AC2 已于 2026-10-03 在 7185c86 通过；接下来按状态表推进其余 AC（AC3、10、11、17、18 用真实模型，AC5、6、7、8、14、15、16 在安装产物中取证）。真实模型运行命令：ONE_COMPANY_ACCEPTANCE_MODEL=5x/gpt-6.1-sol ONE_COMPANY_ACCEPTANCE_OUTPUT=<绝对路径> pnpm run test:acceptance，用后台运行加看门狗：证据目录 events.jsonl 10 分钟无更新就在该目录放 STOP 文件。每轮卡点从证据目录的 main-session.json、side-calls.json、runs/*.jsonl 查。
验证入口：pnpm run typecheck；pnpm test；pnpm run test:integration；pnpm run test:installation。
```
