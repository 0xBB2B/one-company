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
| 23 | role-session | pending | — |
| 24 | requirement-agent-session | pending | — |
| 25 | run-manager | pending | — |
| 26 | relay-queue | pending | — |
| 27 | daemon-client | pending | — |
| 28 | dispatch-tools | pending | — |
| 29 | relay-inbox | pending | — |
| 30 | window-lifecycle | pending | — |
| 31 | commands | pending | — |
| 32 | agents-activity | pending | — |
| 33 | agents-panel | pending | — |
| 34 | transcript-view | pending | — |
| 35 | shell-page | pending | — |
| 38 | window-registry | done | 2026-09-09 |
| 39 | range-claims | done | 2026-09-09 |
| 40 | write-guard | pending | — |
| 42 | workspace-coordination | pending | — |
| 43 | spec-docs-format | done | 2026-09-09 |
| 45 | role-prompts | pending | — |
| 46 | planner-role | pending | — |
| 49 | main-session-skills | pending | — |
| 51 | integration-verification | pending | — |
## 当前
第五波完成（2026-09-09）：07 workflow-tool、12 settings-controller、21 shell-bash-tool、39 range-claims 全部通过复审并提交（连带 06 workflow-state 判别位、20 shell-registry wait 管道）。已完成 01–07、09–12、14–18、20–22、38、39 共 23 个单元。第六波进行中：19 session-records（三轮）、43 spec-docs-format（三轮）、08 migration（六轮）已完成；27 daemon-client（修复中；SDK getPackageDir 在 bun 下指向 bun 自身，测试改用 harness 定位 SDK）。

已完成单元的自修记录：migration（六轮：运行字段与阶段真正迁入并逐字段双向核对、五类冲突分叉按需求隔离、按需求指纹、溯源判归属、源已清理识别、进度损坏可定位、清理前反向比对）、spec-docs-format（三轮：权威示例带注释可通过、AC 整块含回指比对、files 与涉及文件节交叉校验、索引四类定位、不可读输入退出码 2、围栏 ~~~、lint.sh 口径）、session-records（三轮：缺失/损坏改为明确结果、部分损坏不被宿主静默丢弃、悬空调用补入幂等、ended 跳过工具结果判定）、settings-controller（三轮：宿主编辑器契约、按范围解析 MCP 初始勾选、搜索后确认语义、主题着色注入、候选页窗口化与异步确认、测试工具截图时机）、range-claims（四轮：路径规范化与逃逸、release 持有者必填、waiting 精确清理、目录符号链接、两阶段 claim 先授权后算指纹及失败补偿、目录清单散列与差异去重、探针总预算）、shell-bash-tool（三轮：临时文件包装致命令注入与末行注释破坏→改注册表 wait 管道并委托 SDK；外部 stop 挂死；Node 下管道未抽干死锁；后台登记失败改抛出）、workflow-tool（四轮：shape-confirm 绑定核对、requirement 前置校验与回执脱敏、update 缺 task 虚报、版本冲突判别位下沉到 workflow-state、指纹路径/记录边界框定、符号链接逃逸）、daemon-lifecycle（三轮：退出只标记自身运行、link() 原子夺锁、启动窗口 shutdown 守卫、hello 门槛、路径上限校验、指数退避；harness 改为 Node 拉起后暴露长路径假绿）、shell-registry（六轮：方法名对齐 plan、令牌只取环境段、kill(-1) 边界、locale 与 maxBuffer、订阅方异常隔离、ps 采样超时与熔断、后代 EPERM 三态、pidStartedAt 探针替代测试分叉、存活分支扫描节流）、workflow-state（三轮：用户决定门禁按台账来源判定、空任务集与形状确认编号、commit 形态与绑定 cwd 归属、回退改为需求名下任一未停止运行即阻塞）、window-registry（三轮：fail-open 证据、注销竞态、路径穿越、心跳回调；修复引入三条回归再修）、local-identity（两轮）、sleep-aware-clock（两轮）、role-catalog（两轮）、structured-verdict（两轮）、versioned-store（五轮：锁回收最终为两次观察 + inode 核对，可重入持有集带 active 标记）、role-settings（三轮）、error-details（规范变更后重做 + 五轮）、network-pause（四轮）、daemon-protocol（三轮）、decision-ledger（三轮）、run-store（三轮，含新版 shellToken）、mcp-discovery（五轮）。

已记录：package-skeleton 首轮 Review 指出验证口径缺陷与 8 条 impl-defect，plan 验证方式改为 stripTypeScriptTypes，其余自修一次后复审全部解决；enum/namespace 全文正则可能对注释误报，留待出现时收窄。
## 阻塞
（无）

## 待解决（不阻塞）
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
