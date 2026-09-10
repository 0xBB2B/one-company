# Spec 索引

> 每条一行。读者先扫此页判断相关性，再打开具体文件。

## agents

- [builtin-execution](agents/builtin-execution.md) — 本包在守护进程内独立派工需求代理与角色，返回可查询的运行身份，按依赖和写入范围并行而不设并发数量上限
- [cross-window-panel](agents/cross-window-panel.md) — 任意窗口底部 Agents 面板显示本工作区全部需求代理及其子角色树与真实活动，可控制任一运行，结束灰显与临时提示保留 20 秒
- [daemon-host](agents/daemon-host.md) — 每个仓库一个守护进程，由工作区内窗口按需拉起、空闲退出，承载需求代理与角色会话，不可达与崩溃如实显示，计时排除睡眠间隔
- [namespaced-entrypoints](agents/namespaced-entrypoints.md) — 本包所有会话命令统一使用 /pi-company: 前缀
- [pause-control](agents/pause-control.md) — 任意窗口可暂停与继续守护进程内的运行并保留进度，连接故障局部暂停且联网后自动核对续接，手动暂停只由用户继续
- [requirement-agent](agents/requirement-agent.md) — 主会话确认需求文档后派出需求代理，由它持有需求上下文完成规划、提议、执行与阶段检查推进，简单任务可自行完成
- [role-catalog](agents/role-catalog.md) — 角色来自包内默认、用户全局与项目三层角色定义文件，项目层仅在项目受信任时生效，派工权绑定运行身份：主会话只派需求代理与提交前审查者，需求代理只派目录内角色，角色不向下派工
- [role-settings](agents/role-settings.md) — 角色目录中每个角色分别解析模型、思考等级与 MCP 服务集合，项目配置覆盖全局默认，保存不改变已启动任务；角色只获得配置中勾选且当前可用的 MCP 服务，所有入口同受该集合约束
- [run-diagnostics](agents/run-diagnostics.md) — 为失败运行原样保存完整错误详情、定位信息与提交诊断，独立于会话记录可查，不截断
- [run-lifecycle](agents/run-lifecycle.md) — 需求代理与角色在守护进程内跨窗口回合与关窗继续，中断运行续接前核对接管的 Shell 任务、会话记录与工作区，全部结束后才重载接续
- [session-records](agents/session-records.md) — 守护进程内每个会话以可重载的SQLite 会话记录原样完整记录在本机，按运行身份定位、不自动上传、不进入版本管理，压缩由宿主产生，续接时按压缩后视图重载
- [settings-page](agents/settings-page.md) — 角色设置页以单页聚焦式界面按角色目录配置各角色模型、思考等级与 MCP 服务，支持全局或项目范围，MCP 字段以多选候选页勾选宿主当前已配置的服务
- [transcript-view](agents/transcript-view.md) — 从面板打开任一需求代理或角色会话的记录查看页，实时显示思考、输出与工具活动，只读、可滚动、离线可回读
- [user-relay](agents/user-relay.md) — 需求代理与用户的一切对话经主会话中继，提问投递到本工作区已连接窗口且首答生效，无窗口时排队并在下次打开窗口时推送
- [user-stop](agents/user-stop.md) — 任意窗口停止需求代理或角色并连带停止其子运行与 Shell，停止请求确认发出即为终态，Shell 清理进度另行显示并约束范围释放，保留成果并经中继通知
- [workflow-shape](agents/workflow-shape.md) — 工作流形状由任务集、每任务角色序列与阶段检查声明组成，需求代理提议一次经用户确认后执行，升级再问，跳过阶段检查需用户决定

## collaboration

- [range-handoff](collaboration/range-handoff.md) — 跨窗口重叠工作独占并在安全节点交接，只等待冲突部分，命令越界写入以执行前后指纹核对判违规，失联持有者按可机械判定的停止事实释放
- [validation-consistency](collaboration/validation-consistency.md) — 多窗口并行时保护验证对象，提交只纳入获准范围路径，他人活动时不切换共享现场，文件变化后不得沿用旧通过结论
- [window-ownership](collaboration/window-ownership.md) — 需求归属于其需求代理与派出窗口，新窗口可派出自己的需求，工作区内进度共享可控，消息不替代授权或通过证据
- [workspace-coordination](collaboration/workspace-coordination.md) — 窗口启动路径下的全部仓库构成工作区，主会话一次澄清、契约写入各仓库规范、每仓库派一个需求代理，代理只经契约与主会话协作

## review-gates

- [auto-repair-loop](review-gates/auto-repair-loop.md) — 可自动解决的审查问题由需求代理派实现角色修复并再调原审查角色，先核对错误假设与同类场景，每个阶段检查最多三轮，第三轮仍未通过记录技术阻塞，用户授权才开新一轮且不重置轮次
- [blackbox-acceptance](review-gates/blackbox-acceptance.md) — 黑盒验收由需求代理单次直接调用验收者，验收者只依据规则与真实环境关注功能是否可用，唯一写报告并列出全部命令，命令造成写入即失败，需求代理只核对对象与报告一致
- [credible-tests](review-gates/credible-tests.md) — 同一实现角色先核对测试证明力再实现，不以理想模拟、手工状态或环境失败冒充行为验证
- [review-failure-handling](review-gates/review-failure-handling.md) — 审查未通过后需求代理先归因并记录再行动：可自动解决的派修，产品决策经中继问用户且未回答不留痕，独立问题只记入后续清单经用户确认才成任务
- [structured-verdict](review-gates/structured-verdict.md) — 实现、审查与验收角色必须提交结构化结果，运行未正常完成、未提交、校验失败或语义矛盾都失败关闭
- [whitebox-review](review-gates/whitebox-review.md) — 白盒审查在全部任务完成后对整个分支派工，重点安全与鲁棒性再核对验收可追踪关系，命令写入即失败；提交前审查由主会话单次直接调用，未通过则需求回退执行并重派需求代理返修
- [worker-delivery](review-gates/worker-delivery.md) — 实现交付核对完整验收映射、真实测试位置及最终验证结果，未解释的相关失败不得放行

## shell

- [host-lifecycle](shell/host-lifecycle.md) — Shell 跟随所属主会话或子运行清理，会话切换与可处理退出不遗留无人管理命令，清理以已知进程树全部消失为准并明确保证边界，守护进程重新拉起时接管前一实例遗留的任务
- [managed-execution](shell/managed-execution.md) — 所有约定入口统一登记 Shell，仅 agent 可显式后台执行且后台仍受超时约束
- [process-list](shell/process-list.md) — /pi-company:ps 在输入栏位置打开一行一个 Shell 的管理列表与只读详情，按 K 确认后只停止选定任务及其后代，清理确认前显示正在停止，无法确认的任务保留并标明原因
- [status-entry](shell/status-entry.md) — 在原状态栏内以纯文本汇总本窗口主会话与本工作区守护进程内全部活动 Shell 的总数与宿主分布，不可聚焦、不拦截按键，/pi-company:ps 为唯一进入列表的入口

## task-planning

- [mechanical-validation](task-planning/mechanical-validation.md) — 固定只读检查入口统一核对任务格式、验收覆盖、原文、归属和依赖，失败给出可定位原因
- [planning-artifacts](task-planning/planning-artifacts.md) — 同次规划先确定可执行任务骨架再生成正文，增量只改影响范围且不现场编写机械检查器
- [planning-preflight](task-planning/planning-preflight.md) — 规划启动前核对需求、任务状态、范围占用和验证前提，条件不满足时不空跑规划角色
- [task-file-line-limit](task-planning/task-file-line-limit.md) — 每份任务文件扣除示例及成品代码块后最多 200 行，不限制任务的代码改动量
- [verification-contract](task-planning/verification-contract.md) — 每个任务明确真实入口、必须成立的行为、关键场景和模拟边界，高风险测试方案在实施前核对

## workflow-data

- [controlled-updates](workflow-data/controlled-updates.md) — 运行信息通过受校验工具局部读写，拒绝未知字段和过期更新并返回简短回执
- [data-ownership](workflow-data/data-ownership.md) — 需求和任务定义及验收报告留在仓库，运行字段与决策只保存在本机用户数据区，按仓库与需求隔离且不依赖工作目录存在
- [decision-append](workflow-data/decision-append.md) — 决策由专用工具在本机按需求追加，回执先于行动且既有内容不可改写
- [state-transitions](workflow-data/state-transitions.md) — 需求和任务状态由工具按固定集合及随形状的阶段检查推进，证据只按运行身份读取，阶段回退带理由与决定编号
- [version-bound-recovery](workflow-data/version-bound-recovery.md) — 续接从本机状态定位需求并核对版本和原运行，缺失数据或旧通过证据不能放行
