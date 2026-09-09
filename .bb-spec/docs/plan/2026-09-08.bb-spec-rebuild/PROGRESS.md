# 执行进度
| 序号 | Plan | 状态 | 完成时间 |
|---|---|---|---|
| 01 | package-skeleton | done | 2026-09-08 |
| 02 | local-identity | done | 2026-09-08 |
| 03 | versioned-store | done | 2026-09-09 |
| 04 | sleep-aware-clock | done | 2026-09-08 |
| 05 | decision-ledger | done | 2026-09-09 |
| 06 | workflow-state | done | 2026-09-09 |
| 07 | workflow-tool | done | 2026-09-09 |
| 08 | migration | done | 2026-09-09 |
| 09 | role-catalog | done | 2026-09-08 |
| 10 | role-settings | done | 2026-09-09 |
| 11 | mcp-discovery | done | 2026-09-09 |
| 12 | settings-controller | done | 2026-09-09 |
| 14 | daemon-protocol | done | 2026-09-09 |
| 15 | daemon-lifecycle | done | 2026-09-09 |
| 16 | structured-verdict | done | 2026-09-08 |
| 17 | error-details | done | 2026-09-09 |
| 18 | run-store | done | 2026-09-09 |
| 19 | session-records | done | 2026-09-09 |
| 20 | shell-registry | done | 2026-09-09 |
| 21 | shell-bash-tool | done | 2026-09-09 |
| 22 | network-pause | done | 2026-09-09 |
| 23 | role-session | done | 2026-09-09 |
| 24 | requirement-agent-session | pending | — |
| 25 | run-manager | pending | — |
| 26 | relay-queue | done | 2026-09-09 |
| 27 | daemon-client | done | 2026-09-09 |
| 28 | dispatch-tools | done | 2026-09-09 |
| 29 | relay-inbox | done | 2026-09-09 |
| 30 | window-lifecycle | done | 2026-09-09 |
| 31 | commands | done | 2026-09-09 |
| 32 | agents-activity | done | 2026-09-09 |
| 33 | agents-panel | done | 2026-09-09 |
| 34 | transcript-view | done | 2026-09-09 |
| 35 | shell-page | done | 2026-09-09 |
| 38 | window-registry | done | 2026-09-09 |
| 39 | range-claims | done | 2026-09-09 |
| 40 | write-guard | done | 2026-09-09 |
| 42 | workspace-coordination | pending | — |
| 43 | spec-docs-format | done | 2026-09-09 |
| 45 | role-prompts | pending | — |
| 46 | planner-role | done | 2026-09-09 |
| 49 | main-session-skills | pending | — |
| 51 | integration-verification | pending | — |
## 当前
已完成 01–12、14–22、27、28、30、32、38、39、43、46 共 35 个单元（第五波、第六波均已收口；第六波收口时已入库测试全量 1407 pass）。当前 plan 集为 43 份（无 13/36/37/41/44/47/48/50）。

第七波进行中（并发上限 4 个写入方）：
- 28 dispatch-tools：已完成（五轮）。
- 29 relay-inbox：已完成（八轮）。
- 30 window-lifecycle：已完成（五轮）。
- 33 agents-panel：已完成（五轮）。
- 24 requirement-agent-session：Red 完成（11 用例；注入 dispatch/relay 假对象，形状/决策走真实 workflow-tool 与 decisions，新增 tests/helpers/role-fixture.ts）；Green 完成（80 pass；role-session 导出 bestEffortRealpath 并加 extraExtensionFactories/extraToolNames；形状确认经辅助计划运行记录承载证据、throwingWorkflowTool 适配 isError、before_agent_start 整体替换系统提示；recordFollowUpIssue/injectSupplement 未独立落地）；首轮复审：合规 7/15，4 条阻断（哨兵 binding + gates 缺 plan 致 confirmed 死锁、自行完成无交付提交路径、辅助 kind:requirement 运行与伪 daemonStartedAt 卡死唯一性、提问不响应 abort）+ 8 条鲁棒/安全（TOCTOU、建会话失败不回滚、运行记录缺 waiting_answer、STAGE_ORDER 复制且漏 rejected、精确匹配「确认」、waitFor.repo 路径穿越、确认文案隐藏写入范围、等值匹配）+ 替换式提示等；多为 plan 级合同缺口，plan 24 已重写函数清单/成品/验证（规划与自行完成证据由需求代理自身角色名的已完成子运行承载、submit 动作、RunStore 注入、目录锁、ask 带 signal 与运行态、选项式确认、包含式范围、追加式提示），plan 07 改为业务失败抛出；第二轮 Red 完成（17 用例 11 fail；注入 runStore/workspaceRepoIds、relay.ask(input,{signal}) 带 repoId/requirement、handle.injectSupplement、submit 子运行、包含式范围）；第二轮 Green 完成（86 pass；注入 runStore/workspaceRepoIds、目录锁内查找创建、规划/提交证据为需求代理自身角色名的已完成子运行、submit、包含式范围、ask 接 signal 与运行态计数、injectSupplement、追加式提示、STAGE_ORDER 导出、workflow-tool 业务失败抛出）；协调者回退 Impl 为满足顺序断言而剔除宿主 cwd 回显的分叉并把断言限定到追加部分；07 测试 60/62，剩 2 条断言文案错配由测试代理放宽；第二轮复审：首轮 3 违规/5 部分/12 鲁棒安全全部闭环，07 抛出改造合规；新增 8 条残留（中：规划子运行 runId 未回传致生产路径无法 advance、submit 未限定自行完成任务；低：ask 计数自增在 try 外、目录描述未单行化、waitFor.requirement 未提议期校验且 requirementDataDir 在 try 外抛出、state() 遮蔽内层终态、withDirLock 超时逃出 ok:false 契约、测试 as any）；plan 24 已补细则；第三轮 Red 进行中。

已完成单元的自修记录：shell-page（四轮：/ps 未接线与焦点空实现、游离 dock、列表缺耗时、详情下标绑定、停止/裁定失败静默、无重绘无刷新、限高不 resize 且预算漏算、未按工作区/结束态过滤、注册在 session_start 内跨会话累积、teardown 泄漏、无 UI 不登记、控制序列注入（净化抽 runtime/text-sanitize.ts 与 relay 同源）、不确定计入总数为 plan 与 spec 冲突改从 spec；生产未传 theme、错误缺仓库归属、sharedDock 无注销、user_bash 抛错实为 fail-open→返回 BashResult 形状；确认页 Esc 触发关页回归、状态栏宽度交由宿主 footer；主会话写入守卫接线待 write-guard 主会话令牌）、commands（三轮：settings.ts 默认导出与 commands.ts 重复注册同名命令致命令不可用、丢非交互守卫、openSettingsPage 自吞异常使失败用例为假证、stripFrontmatter 在 try 外、跨扩展文件模块单例不共享（实测 jiti 跨入口不共享）→ extensions/index.ts 单一入口 + package.json 指向它 + settings.ts 去默认导出并改为抛出；回调类型声明与真实入参不符改为交集类型；bash 空跑断言与 index 顺序依赖补真断言；收尾清失效交集与测试残留）、transcript-view（四轮：折行按 chunk.length 吞字与 ESC 泄漏改 sliceByColumn 精确切片、关闭/订阅竞态改 closed 令牌 + finally、\r/\t 清洗、记录不可读不伪装运行中、runId 过滤、PgDn、选中位置按 runId 恢复；已结束被不可达覆盖改为终态不订阅不轮询、工厂接住 tui、readTranscript 抛出不泄漏、单页闸门改单槽、teardown 关页；高度口径 rows−1 等于全屏改为 min(自然行数, max(5, ⌊rows/2⌋))、尺寸单一真相、requestClose 幂等）、relay-queue（五轮：自写 JSONL 绕过 store/withdraw 等待方永挂/broadcast 连坐误记 deliveredTo/读失败静默/通知全量回放/emit 无隔离/forward 不回执/影子连接表；晚订阅者 corrupt_skipped 回放、loadError 粘性改可重试、构造期顺序读免自争锁、pendingFor 投影、落盘失败不分叉、deliver_failed 上报、readLinesLenient {records,skipped}；「先落盘后改内存」拆散首答互斥→内存抢占回到落盘前 + 失败回滚，补真并发用例；markDelivered 差量回滚；options 逐项拷贝）、role-session（六轮：核对期永不解除/网络恢复抛错/闸门只写不读/pause 不 abort 且丢排队消息等 7 条；shellRegistry/guards/networkGate 改必填注入、pause 无论 abort 是否确认都 stopHost、sensitive 路径按 git-common-dir/git-dir 定点、全量 git config 指纹只豁免良性键；S1 linked worktree 锚点、S2 黑名单反转、S3 回合结束改 idle + finalize、S6 abort 补 catch 与 gate 时序；S3 副作用删了 stopped 终态使用户停止被 abort 顶替→plan 纠正为 stop 一律 stopped、三终态均 stopHost、cancelled 不冒充业务失败、config 改不带作用域 --list 合并视图、hooksPath 按 toplevel；协调者两次修正与合同矛盾的旧用例）、write-guard（五轮：目录范围尾斜杠/符号链接越仓库/失效指向违规者/git mv 绕过/分支守卫未组合/guard 未接 createManagedBashTool 且后台直通/只读核对不比指纹/失效标记 fail-open、快照算法抽出 runtime/git-snapshot.ts 共享；失效删证据反使 checkResume 放行改 invalidateEvidence 覆写标记、仓库内符号链接 realpath 判定、快进提交不算切换、跨范围重命名剔除、后台未捕获拒绝；snapshotBranchState 自取 HEAD 不走全量 diff、merge-base 三态归因、catch 保留原始错误作 cause（SDK 重包装前截住）；afterCommand 把 undetermined 入 violations 并留痕、recordStateReason 吞留痕失败、注释如实）、relay-inbox（八轮：默认导出单参与 pi 加载器契约、session_start 不 await windowReady 而 .then 续接并带 generation 令牌、载荷对齐 14/26、问题与通知按 id 且按 sessionId 键控去重（reload 保留、/new 重投）、撤回幂等、畸形条目逐条隔离并经 onSkipped 聚合走 ctx.ui.notify、全字段净化（ESC/OSC/C0/C1/bidi/零宽/码点截断）与 nonce 分隔、原始 id 作身份键、测试去 mock.module 改依赖注入）、agents-panel（五轮：session_start await windowReady 与 lifecycle 串行 emit 死锁改 .then 续接并带 generation 令牌、Kitty 协议 Esc/释放事件用 matchesKey+isKeyRelease 且只在处理时消费、widget 改 placement belowEditor 并经工厂接住 tui/theme（hasOverlay/isShowingAutocomplete/mode/requestRender）、失败不隐藏条目与按钮全显示（两处测试驱动分叉）、乐观态令牌校验与 30 秒到期由 tick() 扫描、行内字段/中文标签/灰显/不可达全渲染、外来片段剥 C0/C1/ESC 且 STATE_LABEL 用 hasOwn、宽度按显示列、鼠标与渲染共用可见窗口、agents-activity 行字段 repoId）、window-lifecycle（五轮：工厂内起定时器、beforeSwitch 异常 fail-open、取消原因经 ctx.ui.notify、先连接再登记并回滚、注销逐仓隔离与汇总播报、心跳错误可见、gap watcher 不泄漏、3 秒预算只在信号路径、不挂 SIGINT 改 ctx.shutdown、windowId 统一为 lifecycle 生成传入 register、工作区由 WorkspaceClients 发现一次经 workspace() 暴露、单一注入时钟、删 settled/hasActiveShells 过滤、windowReady 三态、测试补回放行路径等 5 条覆盖）、dispatch-tools（五轮：relay.* 带 windowId、review 快照工具计算（-uall、lstat、长度前缀）、already_active 经错误帧 data 映射、reply 广播三态、agents allSettled 按仓库名分段、callWithAbort、cwd 绝对路径、renderShell self、git 归因五级并透传 signal、仓库名取 windowContext().workspace、broadcastTargets 按 repoId 去重、不可达原因脱敏；protocol 错误帧 data、daemon-client DaemonCallError）、agents-activity（四轮：载荷对齐 14 协议目录并补 requirementTitle/pendingShellCleanup/toolCallId、缺"清理未确认 Shell 数"、repoId 改仓库显示名、三态按钮与未知状态兜底裁定、恢复可达清旧活动仅在跃迁、同名工具并发按 toolCallId、墓碑定长 512 防复活、孤儿子角色行独立成行并快照父标题、NaN 耗时归零、孤儿活动不无界）、daemon-client（四轮：spawn 失败三路归因、监听器隔离、close 先拒在途调用、首连失败不留孤儿循环、ENOTSOCK 自愈、repoId 统一走 repositoryIdentity 并校验 hello 响应；stderr 由窗口管道改为守护进程独占的 daemon.log 落盘（EPIPE 崩溃与无界累积）、删除 close 的 SIGKILL（误杀共享实例）、工作区首连失败改为真实客户端后台重连（占位不自愈）、helloOn 失败连接摘监听器；日志按 spawn 前偏移归因、超 1 MiB 截断、fd try/finally；测试改用真子进程窗口、真 shim 与可控 fake）、planner-role（三轮：plan 成品 frontmatter 对齐 09 入库定义、planning-artifacts.md 由"模板同 spec-docs"三重复制改为需求代理核对清单、补目录授权/未知技术前提/不重置运行状态/不另建报告不增轮次/外部系统契约/生成器解析器禁令/三类伪证据/完成状态限制、"必须真实贯通"撞词拆为入口可运行与模拟边界两项、测试按段落体定位与白名单整体相等）、migration（六轮：运行字段与阶段真正迁入并逐字段双向核对、五类冲突分叉按需求隔离、按需求指纹、溯源判归属、源已清理识别、进度损坏可定位、清理前反向比对）、spec-docs-format（三轮：权威示例带注释可通过、AC 整块含回指比对、files 与涉及文件节交叉校验、索引四类定位、不可读输入退出码 2、围栏 ~~~、lint.sh 口径）、session-records（三轮：缺失/损坏改为明确结果、部分损坏不被宿主静默丢弃、悬空调用补入幂等、ended 跳过工具结果判定）、settings-controller（三轮：宿主编辑器契约、按范围解析 MCP 初始勾选、搜索后确认语义、主题着色注入、候选页窗口化与异步确认、测试工具截图时机）、range-claims（四轮：路径规范化与逃逸、release 持有者必填、waiting 精确清理、目录符号链接、两阶段 claim 先授权后算指纹及失败补偿、目录清单散列与差异去重、探针总预算）、shell-bash-tool（三轮：临时文件包装致命令注入与末行注释破坏→改注册表 wait 管道并委托 SDK；外部 stop 挂死；Node 下管道未抽干死锁；后台登记失败改抛出）、workflow-tool（四轮：shape-confirm 绑定核对、requirement 前置校验与回执脱敏、update 缺 task 虚报、版本冲突判别位下沉到 workflow-state、指纹路径/记录边界框定、符号链接逃逸）、daemon-lifecycle（三轮：退出只标记自身运行、link() 原子夺锁、启动窗口 shutdown 守卫、hello 门槛、路径上限校验、指数退避；harness 改为 Node 拉起后暴露长路径假绿）、shell-registry（六轮：方法名对齐 plan、令牌只取环境段、kill(-1) 边界、locale 与 maxBuffer、订阅方异常隔离、ps 采样超时与熔断、后代 EPERM 三态、pidStartedAt 探针替代测试分叉、存活分支扫描节流）、workflow-state（三轮：用户决定门禁按台账来源判定、空任务集与形状确认编号、commit 形态与绑定 cwd 归属、回退改为需求名下任一未停止运行即阻塞）、window-registry（三轮：fail-open 证据、注销竞态、路径穿越、心跳回调；修复引入三条回归再修）、local-identity（两轮）、sleep-aware-clock（两轮）、role-catalog（两轮）、structured-verdict（两轮）、versioned-store（五轮：锁回收最终为两次观察 + inode 核对，可重入持有集带 active 标记）、role-settings（三轮）、error-details（规范变更后重做 + 五轮）、network-pause（四轮）、daemon-protocol（三轮）、decision-ledger（三轮）、run-store（三轮，含新版 shellToken）、mcp-discovery（五轮）。

已记录：package-skeleton 首轮 Review 指出验证口径缺陷与 8 条 impl-defect，plan 验证方式改为 stripTypeScriptTypes，其余自修一次后复审全部解决；enum/namespace 全文正则可能对注释误报，留待出现时收窄。
## 阻塞
（无）

## 待解决（不阻塞）
- 类型检查：仓库无 tsconfig 与 typecheck 脚本，bun 只抹类型；31 复审用临时 strict tsconfig 发现既有 3 处类型错误（extensions/agents-ui.ts:72 setWidget 签名、extensions/lifecycle.ts:335 notify level 类型、extensions/workflow.ts:6 content type 字面量）。引入 typescript 开发依赖与 `tsc --noEmit` 纳入测试脚本需用户授权（超出 plan 依赖清单）。
- 34 transcript-view 复审留存建议：预算外层再夹 Math.min(rows, …) 使「渲染行数 ≤ 终端行数」在 rows≤4 的极小终端也成立；resize() 仅测试在用，宜改为可注入 rows: () => number 后删除。
- 33 agents-panel：`AgentsPanel.availableRows` 全仓无人注入（实际无限），面板限高未在生产接线；底部区块（面板 + 查看页 + Shell 页）的行数预算宜由 dock 一处分配，待 37/收尾统一处理。
- 扩展装载方式（已裁定随 31 落地）：pi 对 `pi.extensions` 目录逐文件各起一次 jiti 导入，模块实例互不共享，此前 30/28/29/33/34 依赖的 lifecycle 模块级 windowContext 在生产中不成立（测试因同进程直接 import 而全绿）；改为 `extensions/index.ts` 单一入口组合子扩展。51 集成验证须用本机安装的 pi（Node bundle）真机验证一次装载与 /ps、面板、中继。
- 31 commands 挂账：skills/spec-flow|spec-revise|spec-sync 现存内容仍写 `/spec-*` 为强制入口与续接指引，随 49 改名后 AC「继续操作指引使用各自名称」才闭合。
- 23 role-session 复审留存次要项：config 快照含 system 作用域（建议 GIT_CONFIG_NOSYSTEM=1）与 includeIf onbranch 切分支改变 --list 输出，两者为 fail-closed 假阳性面；stop() 内 stopHost 无 catch；completed/stopped 不发事件（仅 failed 发）供 run-manager 投影时注意；结算与后台 Shell 清理异步（约 300ms），范围释放应以登记表为准而非 result() 兑现——25 run-manager 接入时处理。
- 全量 `bun test tests` 墙钟膨胀：23 复审者单次超 10 分钟被环境 exit 144 终止（前几轮约 250s），本会话亦清理了三个挂起 1 小时+ 的全量运行；波次收口时在安静树上单独排查（疑为守护进程/集成用例残留进程或 socket 等待），在此之前「全量绿灯」验收手段失效。
- 40 write-guard：`isCommandScopeStatic` 在 plan 40 函数清单内但当前零调用零用例，消费方在下游 plan；若收尾时仍无消费者则从清单与代码一并删除。`activeForeignHosts` 的 windows/runs 列表 limit 500 在极端运行数下截断（方向是漏判宿主）。
- **需用户裁定** 主会话写入守卫接线（35 shell-ui）：`runtime/write-guard.ts` 的 beforeCommand/afterCommand 令牌绑定 runId/RunStore/WorkflowContext（违规即标运行失败并使证据失效），主会话没有运行记录，无法直接复用；35 首轮 Green 未接（未伪造）。建议：在 write-guard 增一个主会话令牌变体（holder 为本窗口、无 runStore，违规经 ctx.ui.notify 告知并拒绝/记录，仍做占用对照与前后指纹核对），作为 40 的定向修订随 35 或单独 /revise 落地；在此之前主会话 bash/user_bash 只登记 Shell、不做写入守卫。
- 26 relay-queue：`markDelivered` 目前无协议方法与窗口侧回执（runtime/protocol.ts 无 relay.markDelivered，extensions/relay.ts 拉完积压不回执），积压通知永不结算会对每个新窗口全量回放——25 run-manager 与 29 接入时须补 `relay.markDelivered { noticeIds }` 方法与窗口侧回执；relay/questions.jsonl 与 notices.jsonl 追加型无界增长，保留/压实策略未在规范定义；25 run-manager 接入时 `relay.answer`/`relay.forward` 的 windowId 须来自守护进程连接的 ClientInfo 而非请求参数（协议 params 相应删字段，28 dispatch 同步），否则 answeredBy 可伪造。
- 28 dispatch-tools：`broadcastTargets 按 repoId 去重（主目录与 worktree）` 用例在全量运行下曾失败、单跑两次全绿（当时 40 单元正在改 extensions/dispatch.ts 抽出 git-snapshot）；第七波收口时在无在飞单元的工作树复跑全量确认，若仍复现则排查该用例对共享状态（临时目录/cwd）的依赖。
- 28 dispatch-tools：不可达原因脱敏用正则识别绝对路径，含中文用户名或空格的路径段只被抹掉一半（如 /Users/张三/…）；建议改为对 dataRoot、homedir、tmpdir 三个已知前缀做字面量替换，零误伤。
- 23 role-session：plan 规定"暂停态禁止释放会话"，守护进程关停时无法释放暂停中的会话会永久泄漏，测试被迫在 afterEach 吞 dispose 异常——是否改为 dispose 先 stop 再释放，待裁定。
- 25 run-manager 落地前提：`daemon/server.ts` 的错误响应目前只传 code/message，须把处理器抛出的 `data`（already_active 的 runId、shape_violation 的 tasks）透传进错误帧，否则 28 的现有身份映射断在最后一环；27 daemon-client 的 pending 调用在工具中止/超时后不会被丢弃（socket 关闭才清），长会话累积，取消能力待补。
- 29 relay-inbox：裁定通知消息 `display: false`（只进主会话上下文，聊天区不逐条铺开），问题 `display: true`；重连后积压由 26 relay-queue 在 hello 后推送（plan 26 已有），不在 daemon-client 加钩子。
- 14 daemon-protocol：`runtime/protocol.ts` 只有事件名单、事件 data 无 schema，与 plan 14 事件目录的一致性靠约定维系，建议在 25/26 接入事件发送侧时补 typebox schema。
- 27 daemon-client：`resolveSdkDir` 仅委托 SDK `getPackageDir`，bun 下该函数指向 bun 二进制，无法有意义测试，测试用 harness 定位 SDK；工作区降级路径对确定性永久失败（hello repoId 不一致、socket 路径超限、SDK 目录缺失）也按 ≤5s 上限无限重连并反复拉起进程，是否对连续同原因失败抬高退避或直接停止，待用户裁定；daemon-host 规则「心跳与失联判定扣除睡眠间隔」在客户端 connected 态没有基于时钟的判定载体（只靠 socket close 感知），心跳由 38 window-registry 与守护进程侧承担，客户端只做重连退避扣除睡眠。
- 46 planner-role：两份 references（planning-preflight.md、planning-artifacts.md）目前无加载路径，须在 45 requirement-agent-prompt 中落实需求代理派工前/核对产物时加载；`skills/spec-flow/SKILL.md` 仍是旧角色模型与 `.pi-spec/` 路径，由 49 main-session-skills 重写。
- role-settings：未知角色名条目按 plan 明文整层抛错（审查认为爆炸半径偏大，留设置页处理）；保存后未 fsync 目录。
- network-pause：强制门户下任意 HTTP 响应被视为可达；网络续接无次数上限（归 run-manager）。
- versioned-store：可重入锁在同一持锁上下文内的并发写者之间不互斥（契约：持锁上下文内不得并发写）。
- workflow-tool：工具参数 cwd 由模型给出且未收敛，可指向其他仓库的数据区并在其下执行 git（与 decision-ledger 的 cwd 问题同类，待一并裁定）；query 未指定 fields 时 details 返回整份状态文档。
- decision-ledger：工具执行期间的中止信号只在开工前检查，飞行中中止需把 signal 透传进 withDirLock 等待循环；台账文件被外部删除后编号会从头复用（需编号水位文档，规范未定）；工具参数 cwd 由模型给出，可写入本机其他仓库的数据区（plan 明定，是否限制为本会话仓库待裁定）。
- mcp-discovery：守护进程用 Node 运行时无法直接 import .ts 入口，loadMcpForRole 的 importer 须由 daemon-lifecycle 注入 SDK 的 jiti；只读角色写参数判定为键名白名单，单数 path 按既有用例拒绝。
- workflow-state：回退判定依赖守护进程启动时把陈旧 queued/running 记录标记为中断，纯 CLI 场景无解封入口；UNSTOPPED_STATES 与 run-store 的终态集合手工维护补集，缺穷尽性检查（可挪到 run-store 定义）；skippedGates 待 07 消费。
- shell-registry：事件循环长阻塞时 probeProcessGroup 可能得到 EPERM 而把实际成功的命令判为 uncertain（复审 3/3 复现，既有探测逻辑），建议 EPERM 转入身份/后代核对而非直接不确定；stop() 与超时撞车时可能各起一轮轮询、终态标签由竞速决定（对 stopping 早退即可）。
- shell-registry：macOS 的 ps 只对非系统二进制显示环境变量，/bin/sh、/bin/sleep 等系统二进制的逃逸后代无法经令牌发现，也无法被 adoptOrphans 接管（规范未界定该平台限制，测试夹具用 bun 进程）；启动时刻基线为 null 的路径因真实 ps 不可注入而无用例；任务表长驻不删项，保留策略未在规范定义；closeOwner 与 stopHost 行为相同。
- daemon-lifecycle：残留 socket 分支 probe→rm 窗口在高并发（≥6）拉起时仍可能短暂（≤5 秒）双实例，最终收敛且互不干扰；退避窗口内 shutdown 的拒绝文案指向"有活动运行"而非读失败；harness 的 socket 后缀长度仍本地复刻。
- range-claims：补偿移除占位也拿不到锁时占位残留（claimId 随错误抛出，需人工 releaseByUser）；探针超时用原生计时不扣睡眠（结果为保留占用，fail-closed）；`./` 无法作为整仓范围；符号链接指向仓库外的范围在边界校验上合法。
- spec-docs-format：规则文件验收节最后一条 AC 之后若有裸说明段会被算进 AC 原文（`lint.sh --spec` 未限制验收节内只能有 AC 块与列表行）；原文比对为逐行包含，不约束顺序与插入。
- migration：MigrationApplyHooks 是为测试注入中断而存在的生产 API 面；legacy-root-unreadable 用 requirement 字段装 worktree 路径（字段语义误用，不影响归属）；需求文档带 status 却无决策文件的半清理组合无提示性问题。
- run-store：list 与启动标记全量遍历运行目录无上限，保留策略与索引未在规范定义；记录文件中不在当前状态集合内的状态串（如旧版写下的 uncertain）不会被拒读，会被启动标记改为可续接的 interrupted——按预发布期不存在旧数据处理，未加校验，是否需要 fail-close 待裁定。
- daemon-protocol：decodeFrames 的 rest 无长度上限（交 daemon-lifecycle）；仓库无 tsconfig 与 typecheck 脚本，类型层不变量对测试不可见（shell-bash-tool 复审用独立 tsconfig 跑 tsc 发现 3 处潜伏类型错误），补 typescript 依赖需用户批准——建议尽早裁定。
- local-identity：工作区扫描不跟随符号链接目录，规范未界定，未处理。
- role-catalog：prompt_mode 取值域未在 plan 定义，暂宽松直通，待角色提示词单元定义后收紧；loadRoleCatalog 按 readdir 顺序合并，角色顺序在文件系统间不确定（设置页"按目录顺序"依赖它，建议按名称排序或规范定义顺序）。
- sleep-aware-clock：单一墙钟来源下事件循环长阻塞或 NTP 步进会被判为睡眠（设计取舍，未处理）；周期定时器唤醒即触发一次的语义未在规范界定。
- role-catalog Review 指出：reviewer 与 acceptance 默认工具含 bash，"审查只读 / 验收不读源码"边界当前只由提示词承载；归因 plan/spec 层，留待 shell 与角色提示词单元处理。
