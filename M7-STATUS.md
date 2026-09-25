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
| AC6 plan/task 在 data.db，仅存 ID/hash/引用；重启可恢复 | 通过 | D1：tests/plan-manage.test.ts（计划与任务结构在 data.db，任务说明只在 0600 私有文件，数据库字节不含说明正文）；PM 停止后新派出的 PM 从数据库读回同一份计划与任务说明（tests/task-dispatch.test.ts「M7-AC6」） ；旧备份恢复先过归档对账（tests/project-maintenance.test.ts） | 无 |
| AC7 11 核心工具真实注册、六职责与矩阵一致；无 prompts、planner 及其入口 | 通过 | A 片：tests/agent-session.test.ts（职责工具集＝宿主表＋矩阵核心工具）、tests/core-permissions.test.ts、tests/role-catalog.test.ts；G1：旧工作流工具、旧 RPC、旧命令、旧 rules/skills 移除，主会话只注册 project_manage、knowledge_query、requirement_manage、user_interact、agent_manage、workflow_manage，无 pi_company_workflow/git_commit/decision_record，旧 RPC 返回 unknown_method（tests/legacy-workflow-retired.test.ts）；守护进程侧 knowledge_query 与 explore research（F 片）；PM 另有宿主受控提交工具（非核心业务工具，tests/pm-commit.test.ts） | 无 |
| AC8 skill 未加载或模型不遵守提示时核心权限/关闭拒读/通知仍生效 | 通过 | G4：定义正文不含任何职责说明、模型调用不属于其职责的工具与越界写入时，工具集合由程序给定（调用不存在的工具报 not found）、change_apply 拒写 docs/spec（tests/agent-selection.test.ts「M7-AC8」）；关闭生效即撤权拒读、收尾后排队无正文通知与说明无关（tests/workflow-close.test.ts「M6-AC6/AC4/AC15」、tests/explore-session.test.ts「M6-AC5/AC7」）；不作为通用 read/Shell/Git/MCP 旁路已被拦截的证明 | 无 |
| AC9 断网/关窗/取消/续接不重复副作用；关闭需求会话不续接 | 通过 | C2：tests/pm-dispatch.test.ts（按需求停止后运行终态 stopped、租约释放）；runs.resume 只续接本进程持有的暂停会话，历史运行 not_resumable（tests/run-manager.test.ts、tests/legacy-workflow-retired.test.ts）；网络暂停沿用 tests/integration/network-and-sleep.test.ts；关闭需求停止全部运行（tests/adjudication.test.ts 取消需求用例）；窗口全部关闭后 PM 继续、事项保留（tests/adjudication.test.ts「M7-AC34」） | 无 |
| AC10 仅主代理可 workspace-prepare/recycle；越界拒绝；外部切分支后旧绑定不能写 | 通过 | 提交 85f4c4f：tests/workspace-manage.test.ts（真实确认、req/<UUID> 分支与固定目录、基线为主仓库 HEAD、外部切分支后旧绑定失效）；tests/project-manage-tool.test.ts；project_manage 仅主会话注册；需求 active 但托管工作区未 ready 时不派 PM（tests/pm-dispatch.test.ts「M7-AC10」） | 无 |
| AC11 创建/回收中断幂等恢复；有未交付内容默认保留 | 通过 | 提交 85f4c4f：tests/workspace-manage.test.ts（绑定前中断续办不重复确认/建分支；身份不明目录与指向别处的同名分支阻塞不覆盖；活动需求拒绝回收；未跟踪/未合并内容保留并报告；拒绝确认不删除；回收幂等；只删本需求 worktree 与本地分支） | 无 |
| AC12 四类任务状态按 unaffected/affected/unknown 正确处理 | 通过 | D2：tests/plan-assess.test.ts（已完成+无关保持完成；运行中+未知转受阻且待处理更新不解除、门槛阻塞；已完成/失败+受影响转待更新；冻结前须更新；复核只改任务状态，不改验证记录） | 无 |
| AC13 真实链路中接手复核前拒绝正式 plan 与 worker 派工 | 通过 | C3/D1：核对前 propose 被 intake_gate 拒绝、通过后可提出（tests/plan-manage.test.ts）；无实施授权不派 PM（tests/pm-dispatch.test.ts）；主代理经真实提供方核对 PM 私有会话中的提交（tests/pm-intake-runtime.test.ts）；批准新版本未复核时派工被门槛拒绝（tests/task-dispatch.test.ts「M7-AC4/AC13」） | 无 |
| AC14 伪通过/伪身份/任一绑定变化不能用旧回执放行 | 通过 | C3：tests/pm-intake-runtime.test.ts（未受理提交不计、核对不通过拒绝、改交理解后旧核对失效、非本租约会话不被读取）；新物理 PM 须重新核对才建立自己的理解基线、旧租约回执被拒（tests/pm-event-delivery.test.ts）；普通追加走影响复核（tests/plan-assess.test.ts）；绑定逐项变化判定沿用 tests/pm-intake-contracts.test.ts | 无 |
| AC15 main 与 PM 经 agent_manage 实际派 explore，模型输入探针证明最小上下文 | 通过 | F1/F4a：tests/explore-dispatch.test.ts（main 与 PM 经 agent_manage 派出 explore；模型输入只含问题、线索与检索范围，不含 prod 正文与父会话；main 父身份来自已认证连接、不写运行记录、不创建需求现场；PM 父绑定租约 fence/epoch）；联网来源工具仅 web_search/web_fetch 与 result_submit（tests/explore-web.test.ts）；本地来源另有 knowledge_query（tests/explore-dispatch.test.ts「M7-AC16：PM 与 explore 都可调用 knowledge_query」） | 无 |
| AC16 三类来源实际运行 | 通过 | F4a：本地在派出方工作区内自由 read/grep，引用文件 hash 由宿主按实际内容核对、不符拒收（tests/explore-dispatch.test.ts）；联网不核对查询词、可抓任意网址含内网，Exa 限流改用 DuckDuckGo 并记录实际来源（tests/explore-web.test.ts）；F4f：守护进程持有主仓库索引，每次查询前按 mtime/大小/ctime 对账，PM/worker/reviewer/explore 与主窗口均可 knowledge_query，窗口关闭后仍可查、结果标注索引代次（tests/project-index-host.test.ts、tests/integration/project-index-sync.test.ts、tests/explore-dispatch.test.ts）；索引与 grep/find/ls 排除 .git 与被 Git 忽略的路径（tests/project-index-policy.test.ts、tests/search-exclusion.test.ts） ；main 在无需求、索引未初始化时纯网页检索成功、index 基线 not_applicable、结果只交派出连接、不建需求或运行记录（tests/explore-web.test.ts「M7-AC16：main 在无需求」） | 无 |
| AC17 research 非 PASS，父代理核验 | 通过 | F1：research 回执 isPass=false，送回派出者的报告标明"research 不是 PASS"、须核对来源与当前性（tests/explore-dispatch.test.ts）；F3：联网 research 按允许域名核验后送回 PM，同样标明不是 PASS（tests/explore-web.test.ts） | 无 |
| AC18 搜索会话回收；关闭/撤权/接管停止；无关 main 检索不误停 | 通过 | F1：检索结束回收会话；PM 停止、失败或被接管时其 explore 停止且会话失效；main 派出的 explore 绑定发起连接，断开即停止、结果作废（tests/explore-dispatch.test.ts）；F4：需求关闭停止其 PM 与绑定检索，无关 main 检索照常完成（tests/explore-dispatch.test.ts「M7-AC18：需求关闭…」） | 无 |
| AC19 内置六职责默认团队零专业定义闭环 | 通过 | H：只用内置默认定义（用户层、项目层为空，无 skill），真实 RunManager 与脚本化模型走完接手复核、计划（worker/reviewer/qa 三任务）、worker 经 change_apply 实现、PM 进入检查并派出独立 reviewer 与 qa（各自正式验证与 verdict）、退出检查、主代理 delivery-check 与 completed 关闭并归档；运行记录定义来源均为内置，全程无 explore 规划；批准时未授权关闭则 completed 关闭被拒（tests/zero-custom-loop.test.ts） | 无 |
| AC20 复制默认配置即得专业定义；无效定义拒绝 | 通过 | G2：设置页 C 复制默认定义为新名称即得专业定义，复制后 name 改为新名称、与默认共用同一 schema 与加载链路；名称三层不重复、pm 只能同名复制；单一 role、字段、main/planner 职责与第二个 pm 拒绝（tests/agent-catalog-ui.test.ts、tests/role-catalog.test.ts） | 无 |
| AC21 两类目录发现、项目信任、显式覆盖、一键复制 | 通过 | G2：agentDir/agents（数据根随 PI_CODING_AGENT_DIR）与项目 .pi/agents 自动发现，项目层仅在宿主信任时加载（守护进程读宿主 trust 记录）；同名按项目 > 用户 > 内置覆盖并标出被覆盖来源；缺 role 的其他宿主定义不导入、无效定义不顶掉下层并在问题分类列出；设置页只读查看与一键复制（tests/role-catalog.test.ts「覆盖与导入规则」、tests/agent-catalog-ui.test.ts） | 无 |
| AC22 有界能力目录、两种默认路径、显式指定失败不静默默认 | 通过 | G3：PM 经 agent_manage catalog 取每页至多 20 条目录（名称、职责、描述、来源），不含定义或 skill 正文；任务可用 agent 指定专业定义、agentReason 记依据，未指定用同名默认定义；指定不存在或不可用即 agent_unavailable 拒绝，按用户决定不设替代策略、交用户裁决（tests/agent-selection.test.ts） | 无 |
| AC23 模型与思考等级核验、skills 按需加载、不静默换模型 | 通过 | G3：派工按当前角色目录解析，指定模型不存在拒绝（model_unavailable）、思考等级不受支持拒绝（thinking_unsupported）、声明的 skill 找不到拒绝（skill_unavailable），skills 按项目、用户、安装资源顺序查找并附在任务上下文；首版不设模型提供方外发授权（用户决定）（tests/agent-selection.test.ts） | 无 |
| AC24 运行元数据含选择依据、配置来源/hash 与实际加载指纹 | 通过 | G3：运行记录 agent 字段保存定义名称、来源层、文件路径与 hash，以及实际加载的每个 skill 的路径与 hash；任务记录保存 agent 与 agentReason（tests/agent-selection.test.ts） | 无 |
| AC25 配置变化不静默改在途运行 | 通过 | G3：在途会话沿用派工时解析的定义；暂停后续接前核对定义与 skills 文件 hash，已变即停止该运行并报 config_changed；每次新派工重新读取角色目录（tests/agent-selection.test.ts） | 无 |
| AC26 专业结果由父代理核验，独立 review/QA，专业实例受互斥与撤权约束 | 通过 | G4：专业 worker 运行中正式检查开启被拒（workers_active，按角色运行而非定义名称判定）；worker 职责的专业定义不能执行 reviewer 任务（agent_unavailable）；需求停止时专业实例一并停止（tests/agent-selection.test.ts「M7-AC26」）；子代理报告与 explore research 由派出方收到并标明需核验（tests/task-dispatch.test.ts、tests/explore-dispatch.test.ts） | 无 |
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

无。三条测试命令全量通过（单元 2312、集成 79、安装 11）。

## 下一窗口续接提示

```
项目：/Users/bb/.bb-spec/worktrees/pi-spec-bb-spec-rebuild（分支 bb-spec-rebuild，不推送）。
先完整读 AGENTS.md 与 SQLITE-KNOWLEDGE-REBUILD-PLAN.md，再读当前阶段状态表，核对 git status 与最近提交。M0–M7 已收口不重做。
M7 已完成：PM 接手复核与增量调度、plan/task、六职责默认团队与轮次上限、explore（本地、联网、索引、MCP 优先）、守护进程持有索引并查询前对账、旧工作流移除、主窗口不设文件与命令限制、PM 受控提交、角色目录三层覆盖与只读设置页、能力目录与专业定义选择、模型/思考等级/skills 核验与配置指纹、completed 关闭须关闭授权。
首版取舍（用户已确认并写入计划）：两条威胁模型之外的限制放开；change_apply 与 verification_run 仍不得写 .git、docs/spec、docs/prod、角色定义与 skills 来源、项目信任文件、安装包与本机数据目录；主窗口完全不限制并接受其模型绕开工具改库的残余风险；不设模型外发授权与替代策略。
下一步：按计划开始 M8，先读计划 M8 章节并建立 M8-STATUS.md。
验证入口：pnpm run typecheck；pnpm test；pnpm run test:integration；pnpm run test:installation。
```
