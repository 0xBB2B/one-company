# M7 状态

阶段目标：PM 通过接手复核后统一负责规划及持续增量调度，main/PM 共用只读 explore；六类固定职责的完整默认团队、同格式可复制专业定义与 PM 自动选择；子代理对话轮限与一次重试；11 核心工具真实注册；永久移除独立 planner、旧派工/恢复入口与 prompts 资源。

## AC 状态表

| AC | 状态 | 证据 | 剩余缺口 |
|---|---|---|---|
| AC1 首次受限读完整基线并经主代理核对，后续 diff 增量；接管/丢基线仅 active 时重核对 | 通过 | C4：tests/pm-event-delivery.test.ts（核对通过前不建立理解基线、不投递；通过后按序投递准确差异，assess-update 须绑定本次收到的理解基线才放行；PM 停止后不再投递，新 PM 须重新核对才建立自己的理解基线，旧租约回执被拒）；实现 runtime/pm-event-delivery.ts、daemon/run-manager.ts 500ms 投递轮询、runtime/plan-manage.ts assess-update 校验、runtime/pm-intake-runtime.ts advancedGate 覆盖语义修正为按序收到差异后 toRevision>=revision | 无 |
| AC2 连续追加产生解耦规则与任务 | 通过 | D2：tests/plan-assess.test.ts（连续批准快跑、跳跃、跳跃动画各自成为独立任务，原任务版本不变）；规则候选拆分沿用 spec_change 大小与单责门槛（M1/M4 既有测试） | 无（真实模型拆分质量按已定验证方式在 M9 以真实模型测量） |
| AC3 间接影响识别，复核绑定 from/to prodHash 与 plan/task 版本 | 通过 | D2：tests/plan-assess.test.ts（新增独立功能时原任务复核保留；另章节新增全局输入屏蔽时原任务依据闭包变化，判为无关被拒；复核绑定批准版本与任务版本，旧版本复核被拒） | 无 |
| AC4 未决项只阻塞依赖任务，交付范围内未决项须解决或排除 | 通过 | D1/D2：任务登记 blockedByQuestionIds，unknown 复核只阻塞对应任务（tests/plan-assess.test.ts）；派工时依赖未决问题的任务被拒而独立任务照常派出（tests/task-dispatch.test.ts「M7-AC4/AC13」）；交付范围内未决项的关闭拒绝沿用 M6 预检 | 无 |
| AC5 同需求单一有效 holder，旧运行迟到回执拒绝；不同需求不共用分支/worktree | 通过 | C2：tests/pm-dispatch.test.ts（活着的 PM 再派出被拒；停止或租约过期后再派出 fence 更高，旧会话停止、旧工具失效；两个派出请求并发竞争只有一个取得租约）；不同需求工作区占用沿用 M1 managed_workspace_claims 与 tests/workspace-manage.test.ts | 无 |
| AC6 plan/task 在 data.db，仅存 ID/hash/引用；重启可恢复 | 通过 | D1：tests/plan-manage.test.ts（计划与任务结构在 data.db，任务说明只在 0600 私有文件，数据库字节不含说明正文）；PM 停止后新派出的 PM 从数据库读回同一份计划与任务说明（tests/task-dispatch.test.ts「M7-AC6」） | 无 |
| AC7 11 核心工具真实注册、六职责与矩阵一致；无 prompts、planner 及其入口 | 部分 | A 片：tests/agent-session.test.ts（职责工具集＝宿主表＋矩阵核心工具）、tests/core-permissions.test.ts（已实现工具 schema 与核心表双向一致）、tests/role-catalog.test.ts、tests/legacy-workflow-retired.test.ts；plan_manage（D）、agent_manage（C2/E2）、主会话 workflow_manage（§10.7 第 5 步）已注册；主会话现注册 project_manage、knowledge_query、requirement_manage、user_interact、agent_manage、workflow_manage | 守护进程侧 knowledge_query 与 explore 的 result_submit research（F 片）；agents/skills/rules 其余重构（G 片） |
| AC8 skill 未加载或模型不遵守提示时核心权限/关闭拒读/通知仍生效 | 未开始 | | A、C 片 |
| AC9 断网/关窗/取消/续接不重复副作用；关闭需求会话不续接 | 通过 | C2：tests/pm-dispatch.test.ts（按需求停止后运行终态 stopped、租约释放）；runs.resume 只续接本进程持有的暂停会话，历史运行 not_resumable（tests/run-manager.test.ts、tests/legacy-workflow-retired.test.ts）；网络暂停沿用 tests/integration/network-and-sleep.test.ts；关闭需求停止全部运行（tests/adjudication.test.ts 取消需求用例）；窗口全部关闭后 PM 继续、事项保留（tests/adjudication.test.ts「M7-AC34」） | 无 |
| AC10 仅主代理可 workspace-prepare/recycle；越界拒绝；外部切分支后旧绑定不能写 | 通过 | 提交 85f4c4f：tests/workspace-manage.test.ts（真实确认、req/<UUID> 分支与固定目录、基线为主仓库 HEAD、外部切分支后旧绑定失效）；tests/project-manage-tool.test.ts；project_manage 仅主会话注册；需求 active 但托管工作区未 ready 时不派 PM（tests/pm-dispatch.test.ts「M7-AC10」） | 无 |
| AC11 创建/回收中断幂等恢复；有未交付内容默认保留 | 通过 | 提交 85f4c4f：tests/workspace-manage.test.ts（绑定前中断续办不重复确认/建分支；身份不明目录与指向别处的同名分支阻塞不覆盖；活动需求拒绝回收；未跟踪/未合并内容保留并报告；拒绝确认不删除；回收幂等；只删本需求 worktree 与本地分支） | 无 |
| AC12 四类任务状态按 unaffected/affected/unknown 正确处理 | 通过 | D2：tests/plan-assess.test.ts（已完成+无关保持完成；运行中+未知转受阻且待处理更新不解除、门槛阻塞；已完成/失败+受影响转待更新；冻结前须更新；复核只改任务状态，不改验证记录） | 无 |
| AC13 真实链路中接手复核前拒绝正式 plan 与 worker 派工 | 通过 | C3/D1：核对前 propose 被 intake_gate 拒绝、通过后可提出（tests/plan-manage.test.ts）；无实施授权不派 PM（tests/pm-dispatch.test.ts）；主代理经真实提供方核对 PM 私有会话中的提交（tests/pm-intake-runtime.test.ts）；批准新版本未复核时派工被门槛拒绝（tests/task-dispatch.test.ts「M7-AC4/AC13」） | 无 |
| AC14 伪通过/伪身份/任一绑定变化不能用旧回执放行 | 通过 | C3：tests/pm-intake-runtime.test.ts（未受理提交不计、核对不通过拒绝、改交理解后旧核对失效、非本租约会话不被读取）；新物理 PM 须重新核对才建立自己的理解基线、旧租约回执被拒（tests/pm-event-delivery.test.ts）；普通追加走影响复核（tests/plan-assess.test.ts）；绑定逐项变化判定沿用 tests/pm-intake-contracts.test.ts | 无 |
| AC15 main 与 PM 经 agent_manage 实际派 explore，模型输入探针证明最小上下文 | 通过 | F1/F4a：tests/explore-dispatch.test.ts（main 与 PM 经 agent_manage 派出 explore；模型输入只含问题、线索与检索范围，不含 prod 正文与父会话；main 父身份来自已认证连接、不写运行记录、不创建需求现场；PM 父绑定租约 fence/epoch）；联网来源工具仅 web_search/web_fetch 与 result_submit（tests/explore-web.test.ts）；本地来源另有 knowledge_query（tests/explore-dispatch.test.ts「M7-AC16：PM 与 explore 都可调用 knowledge_query」） | 无 |
| AC16 三类来源实际运行 | 通过 | F4a：本地在派出方工作区内自由 read/grep，引用文件 hash 由宿主按实际内容核对、不符拒收（tests/explore-dispatch.test.ts）；联网不核对查询词、可抓任意网址含内网，Exa 限流改用 DuckDuckGo 并记录实际来源（tests/explore-web.test.ts）；F4f：守护进程持有主仓库索引，每次查询前按 mtime/大小/ctime 对账，PM/worker/reviewer/explore 与主窗口均可 knowledge_query，窗口关闭后仍可查、结果标注索引代次（tests/project-index-host.test.ts、tests/integration/project-index-sync.test.ts、tests/explore-dispatch.test.ts）；索引与 grep/find/ls 排除 .git 与被 Git 忽略的路径（tests/project-index-policy.test.ts、tests/search-exclusion.test.ts） | 无 |
| AC17 research 非 PASS，父代理核验 | 通过 | F1：research 回执 isPass=false，送回派出者的报告标明"research 不是 PASS"、须核对来源与当前性（tests/explore-dispatch.test.ts）；F3：联网 research 按允许域名核验后送回 PM，同样标明不是 PASS（tests/explore-web.test.ts） | 无 |
| AC18 搜索会话回收；关闭/撤权/接管停止；无关 main 检索不误停 | 通过 | F1：检索结束回收会话；PM 停止、失败或被接管时其 explore 停止且会话失效；main 派出的 explore 绑定发起连接，断开即停止、结果作废（tests/explore-dispatch.test.ts）；F4：需求关闭停止其 PM 与绑定检索，无关 main 检索照常完成（tests/explore-dispatch.test.ts「M7-AC18：需求关闭…」） | 无 |
| AC19 内置六职责默认团队零专业定义闭环 | 未开始 | | G、H 片 |
| AC20 复制默认配置即得专业定义；无效定义拒绝 | 未开始 | | G 片 |
| AC21 两类目录发现、项目信任、显式覆盖、一键复制 | 未开始 | | G 片 |
| AC22 有界能力目录、两种默认路径、显式指定失败不静默默认 | 未开始 | | G 片 |
| AC23 模型/思考等级缺省跟随主会话，指定不可用则阻塞；skill 按需加载 | 未开始 | | G 片 |
| AC24 实际模型与加载探针和运行元数据一致 | 未开始 | | G 片 |
| AC25 配置变化不静默改在途运行，重派重核验 | 未开始 | | G 片 |
| AC26 专业结果由父代理核验，独立 review/QA，专业实例受互斥与撤权约束 | 未开始 | | E 片 |
| AC27 受限子代理缺目标或有效 maxTurns 拒绝派工 | 通过 | E：tests/plan-manage.test.ts（任务缺目标或非正整数轮次上限拒绝登记）；tests/agent-session.test.ts（非正整数上限拒绝创建会话）；tests/task-dispatch.test.ts（派工轮次上限取任务登记值，写入子代理上下文） | 无 |
| AC28 最多 N 轮，不发 N+1 | 通过 | E1：tests/agent-session.test.ts（上限 2 时模型请求恰为 2 次，第 3 次未发出，标 turn_limit_reached；第 N 轮已提交结果按完成处理）；tests/task-dispatch.test.ts（真实派工链路 turnsUsed=2/3） | 无 |
| AC29 到限自动上报直属父代理 | 通过 | E2：tests/task-dispatch.test.ts（到限上报直属 PM）；F1：explore 到限自动上报派出它的 PM，main 派出的到限报告只交给派出连接（tests/explore-dispatch.test.ts） | 无 |
| AC30 最多一次父代理批准的重试，之后待用户裁决 | 通过 | E2：tests/task-dispatch.test.ts（未带原因再派被拒；带原因重试一次；再未完成进入 awaiting_user，第三次派工与绕行被拒）；§10.7：tests/adjudication.test.ts（只有用户三种决定能解除待裁决；再给一次按用户上限且不占 PM 重试、任务被修改即失效；调整须新批准版本；终止整个需求暂停；统一停止的尝试记为 superseded 不计入） | 无 |
| AC31 正式计划/派工缺目标/通过条件/范围/性能条件拒绝 | 通过 | D1：tests/plan-manage.test.ts（缺目标、通过条件、范围、性能条件或有效轮次上限拒绝登记；冻结前须覆盖全部获准实施章节；版本递增与过期版本拒绝）；E：派工只接受已冻结计划中的任务、轮次上限取任务登记值（tests/task-dispatch.test.ts） | 无 |
| AC32 非阻塞建议不生成任务，扩范围须用户决定 | 通过 | D1：tests/plan-manage.test.ts（任务只能引用获准实施的章节，越出授权即拒；审查结果没有生成任务的入口）；一次重试按目标计，改名/新增/修改揽目标均被拒（tests/plan-manage.test.ts「M7-AC30」、tests/task-dispatch.test.ts） | 无 |
| AC33 面板只显示运行中/暂停的 PM，字段按 PM+子代理累计，状态由程序生成，⏸ 时停止计时，p 暂停/恢复连带子代理 | 通过 | 提交 05977fd、f75d416：tests/run-usage.test.ts、tests/pm-overview.test.ts（用量与工具次数按运行累计并广播；PM 与子代理汇总与缓存命中率；状态行按真实状态生成；等待决定与暂停不计时；暂停/恢复连带子代理）；第 6 步：tests/pm-panel.test.ts（树形格式、⏸ 与计时、窄屏截断、↑↓/Enter/p 键、扩展接线：拉取概览、Enter 取决策包插入对话并自动回复、变化信号重拉） | 无 |
| AC34 多窗口：一窗口消费后其他窗口该行消失，旧版本提交被拒；窗口全关后 PM 继续、事项保留 | 通过 | f75d416：概览变化广播不含正文的 pm.overview.changed，窗口经 pm.overview 拉取；9fefedc：面板更新投影时已处理事项消失（tests/pm-panel.test.ts）；两个主窗口实例同时打开同一事项，先登记的生效、另一窗口按旧卡片登记被拒，窗口全部关闭后 PM 与剩余事项仍在（tests/adjudication.test.ts「M7-AC34」） | 无 |
| AC35 决策只依据决策包持久记录并绑定版本；PM/子代理不能登记用户决定或以取消/拒绝关闭；待裁决任务只能由用户三种决定解除 | 通过 | 第 4 步：tests/adjudication.test.ts（只认宿主截获的当前原话；解释须恰为一条引用当前事项的裁决条目；裁决引用前缀只能出现在裁决条目；PM/子代理无登记入口）；终止：整个需求暂停，PM 与子代理暂停，新批准版本前恢复与派工被拒、不能完成关闭，批准后 PM 自动恢复，确认新计划前不能派出或恢复子代理，计划有变更时原暂停子代理统一停止且该次尝试记为 superseded 不计入重试；第 5 步：取消/拒绝须先按原话登记需求事项决定（requirement:<id>，仅 cancel/reject），主代理以该决定 ID 关闭，无对应决定或原因不符被拒，PM 只能以 completed 关闭（tests/adjudication.test.ts） | 无 |

## 当前阻塞

无。

独立审查（A、B 片，基线 c241c86..70f6dfc，两条威胁模型内）：2 条阻塞（读取工具路径以 @、~、file: 或特殊空白改写后绕过范围；MCP 请求夹带 search 绕过只读名单或触发 install/auth/connect），已修复并补回归用例，定向复审"全部解决"。

独立审查（C 片，基线 460f1db..6cf660a）：0 阻塞、2 非阻塞（PM 旧基线下受理的理解会被套上新绑定；租约过期未续时 PM 的 verification_run 仍可用），已修复：受理时由宿主把批准基线写入工具结果，读取只认与当前绑定一致的提交；PM 工具每次调用核验租约仍属本运行，接管前先停止旧运行；定向复审"全部解决"。C 片遗留：门槛尚未读取影响复核链（首次批准更新后会阻塞，D 片 assess-update 补齐）；PM 实际工具缺 knowledge_query、plan_manage（D 片）与 agent_manage（E 片）；派出时未核验思考等级是否被模型支持（G 片 AC23）。

独立审查（D、E 片，基线 77a9d93..2afbc0b）：3 条（2 阻塞：已有尝试任务的目标可经修改或新增任务揽走以绕过一次重试；新版本收回实施授权后旧冻结任务仍可派出。1 非阻塞：计划提交覆盖并发登记的尝试），经四轮定向复审逐项收紧后"全部解决"：一次重试按目标计（已有尝试的任务不能取消、修改须保留原目标、其目标不能被其他任务覆盖）；复核与派工都核对实施授权范围；计划提交按快照比对，影响复核改为套用到最新任务行；尝试结局只在任务仍为运行中时改状态；同一任务同时只允许一个运行中的尝试。

独立审查（C4，基线 41f2137..工作区）：0 阻塞。核对了理解基线只在本租约核对通过当前批准版本后建立、差异正文只来自服务端计算结果且模型工具面无法影响或跳过、旧租约/旧会话因 fence 递增在写入前被 fail-closed 拒绝、assess-update 的消费校验与门槛覆盖语义（toRevision>=revision）在两条威胁模型内均成立。记录一条非阻塞观察：advancedGate 的覆盖判定未比对 contextGeneration，理论上物理上下文轮换后可能被旧记录覆盖；因 rotateContext/restoreCurrentContext 当前无生产代码路径调用，不可触发，留待接入时复核。

独立审查（§10.7 第 4 步用户裁决，基线 f75d416..工作区）：2 阻塞（用户终止后 PM 可另建任务接走目标再得两次尝试；adjust 豁免不看是否已用，可放大尝试次数）、3 非阻塞（解释器摘要含模型文字可诱导轮数；裁决入口会把同批其他条目存为已确认决定；retry 授权不绑任务版本）。已修复阻塞与非阻塞 4、5 并补回归用例，定向复审"全部解决"；非阻塞 3 按用户选择方案 a 修复：给解释器的事项摘要只含程序记录的轮数与结局。另修停止 PM 时未等待进行中的投递/概览刷新导致迟到写入。

独立审查（§10.7 终止暂停整个需求，基线 82c0b49..工作区）：首轮 0 阻塞 3 非阻塞（先暂停后终止不自动恢复、暂停失败不重试、新计划前可恢复旧子代理——后者经用户拍板纳入门槛并追加"计划变更时统一停止、该次尝试不计入重试"）；次轮 1 阻塞 3 非阻塞（新计划确认后轮询前可抢先恢复旧子代理等），逐项修复，三轮定向复审"全部解决"。

独立审查（§10.7 第 5 步取消/拒绝需求，基线 ff6b4a2..工作区）：两条威胁模型内无阻塞；功能缺陷一条（进入关闭提升 epoch 后续办同一关闭被拒、需求卡在关闭中）已修，定向复审"全部解决"。

已查明：PM 停止或失败时释放租约会向需求记录写入 pm.released 事件并提升记录版本，恰逢用户保存 prod 时该次保存因乐观并发校验报 state_changed_before_storage，重试即可，不损坏数据。

独立审查（§10.7 第 6 步面板与决策包，基线 53f862b..工作区）：1 阻塞（按旧决策包登记不被拒）5 非阻塞（模型文字换行伪造程序行、卡片前的原话仍可用、问题文字未标注、README 残留"续接"、孤立文件），已修复 4 条非阻塞与阻塞，定向复审"全部解决"；transcript-view.ts 在本次改动前已无引用，不属本次范围。

待办（不属 M7 验收）：草稿需求由主代理取消暂不支持（用户决定）；runtime/transcript-view.ts 在本阶段之前已无产品引用，随 G 片旧工作流清理一并删除。

已知抖动：tests/project-baseline.test.ts「真实fs.watch：自动watch对账只暂存」、tests/project-index-sync.test.ts「归档watch只发无正文metadata」与集成 project-index-sync「新索引对象装配之后的启动失败」在全量负载下偶发超时，单独重跑通过。

独立审查（F3 联网来源）：1 阻塞（查询词插入不可见格式字符可绕过全部文本核对），已改为拒绝控制、可忽略与不可见字符，定向复审"全部解决"；随后用户决定外发核对只保护密钥与用户目录路径等，去掉需求正文与仓库代码片段比对，不做扫描。

独立审查（F4 放开与索引重写）：verification_run 写入限制 1 阻塞（改名上级目录绕过禁写与套接字限制），已禁改各级上级目录，复审"全部解决"；守护进程持有索引 0 阻塞，确认框根与实际索引主工作区不一致已改为显示主工作区，复审"全部解决"。

## 下一窗口续接提示

```
项目：/Users/bb/.bb-spec/worktrees/pi-spec-bb-spec-rebuild（分支 bb-spec-rebuild，不推送）。
先完整读 AGENTS.md 与 SQLITE-KNOWLEDGE-REBUILD-PLAN.md，再读 M7-STATUS.md，核对 git status 与最近提交。M0–M6 已收口不重做。
M7 已完成：A 定义格式/五个内置定义/按职责工具集/daemon/agent-session.ts；B workspace-prepare/recycle 与 recovery-check/backup/restore；C 会话改存私有文件、dispatchPm/续租/接管/停止、PM 接手提交与主代理核对（runtime/pm-intake-runtime.ts）；D plan_manage（runtime/plan-manage.ts，任务说明存 plans/ 私有文件，影响复核与全局约束闭包）；E 轮次上限（turn_start 计数）、PM agent_manage 按冻结任务派 worker/reviewer/qa（runtime/task-dispatch.ts、daemon/subagent-tools.ts），结果复用 M6 verdict，一次重试按目标计；C4 已批准更新按序投递 PM 并确认消费（runtime/pm-event-delivery.ts，daemon 500ms 轮询），assess-update 绑定本次收到的理解基线，advancedGate 覆盖语义按序收敛。A–E、C4 各有独立审查且定向复审"全部解决"或"无阻塞"。
待做顺序（只剩 AC7、AC8、AC19–AC26）：F 已完成 F1 explore 双父入口与本地文件来源；F3、F4 已完成（用户决定首版放开两条威胁模型之外的限制：explore 本地自由读取、联网不核对且允许内网、change_apply 不分路径类、verification_run 只保留两条写入限制、搜索排除 .git 与忽略路径；索引改由守护进程持有、查询前对账，删除窗口许可、持续监听与基线钩子）；F 片已全部完成（含 explore 定义声明 MCP 服务时由守护进程从 agentDir 装载适配器、只放行配置声明的只读工具并优先使用）；G 同名覆盖标注、一键复制命令与新设置页、删除设置页旧按角色 model/thinking/mcp 与四个旧命令、能力目录与 PM 自动选择、模型与思考等级核验及加载指纹、配置变化不静默改在途运行、change_apply 拒写 .pi/agents/、删除 workflow-state.ts/workflow-tool.ts/pi_company_workflow/delivery.ts/result.ts/run-store phase/transcript-view.ts 与旧 skills/rules、重写主会话说明、AC8 提示失效时核心约束仍生效、AC26 专业结果核验与互斥撤权；H 零自定义闭环与三条测试命令全量、收口 M7-STATUS。
已由用户确认的决定已写入计划 §2.2、§8.3、§9.1、§9.2、§9.6、§10.5、§10.6、§10.7、§13.2 与 M7-AC20/21、AC33–35；C-3 与 M5 两条观察本阶段不处理。
验证入口：pnpm run typecheck；pnpm test；pnpm run test:integration；pnpm run test:installation。三条测试命令都绿才算全量绿。
```
