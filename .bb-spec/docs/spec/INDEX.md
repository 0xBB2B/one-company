# Spec 索引

> 每条一行。读者先扫此页判断相关性，再打开具体文件。

## agents

- [builtin-execution](agents/builtin-execution.md) — 本包独立提供四个固定角色的派工与运行查询，按依赖和文件冲突并行而不设置并发数量上限
- [flow-only-invocation](agents/flow-only-invocation.md) — 四个流程专用子代理只在既定流程步骤中被调用，日常对话不得调用，模型由用户设置指定
- [live-panel](agents/live-panel.md) — 仅在本窗口 Agents 面板展示真实子运行活动和操作，隐藏聊天区重复内部消息
- [mcp-access](agents/mcp-access.md) — 角色只获得其配置中勾选且当前可用的 MCP 服务，所有入口同受该集合约束，缺失能力按任务需要阻塞且不放宽角色边界
- [mcp-selection](agents/mcp-selection.md) — 角色设置页的 MCP 字段以多选候选页勾选宿主当前已配置的服务，不可用项标记保留，确认后整体保存到当前范围
- [pause-control](agents/pause-control.md) — 本会话子运行立即请求暂停并保留进度，连接故障局部暂停且只由用户手动继续
- [role-settings](agents/role-settings.md) — 四个角色分别解析模型、思考等级与 MCP 服务集合，项目配置覆盖全局默认，保存不改变已启动任务
- [run-diagnostics](agents/run-diagnostics.md) — 仅保存子运行失败的完整错误及定位信息，不记录完整会话或工具过程日志
- [run-lifecycle](agents/run-lifecycle.md) — 子任务跨普通回合继续运行，取消、会话切换或宿主退出时清理并保留现场，续接前核对原运行
- [session-execution](agents/session-execution.md) — 子代理与主会话同进程执行但各自隔离上下文和权限，独立停止不退出宿主
- [settings-page](agents/settings-page.md) — /pi-spec:setting 以单页聚焦式界面配置四角色模型、思考等级与 MCP 服务，支持全局或项目范围
- [user-stop](agents/user-stop.md) — 用户停止结束子运行并清理资源，保留成果和通知，不提供旧运行恢复重启

## collaboration

- [range-handoff](collaboration/range-handoff.md) — 跨窗口重叠工作独占并在安全节点交接，只等待冲突部分，命令越界写入以执行前后指纹核对判违规，不因失联自动抢占
- [validation-consistency](collaboration/validation-consistency.md) — 多窗口并行时保护验证对象，提交只纳入获准范围路径，他人活动时不切换共享现场，文件变化后不得沿用旧通过结论
- [window-ownership](collaboration/window-ownership.md) — 新窗口负责自己的需求，后台共享必要协作信息，不要求旧窗口继续在线或扩张控制权限

## commands

- [namespaced-entrypoints](commands/namespaced-entrypoints.md) — 五个流程与设置入口使用 /pi-spec: 命名空间，独立 /ps 管理 Shell，不提供其他流程别名

## review-gates

- [auto-repair](review-gates/auto-repair.md) — 不需要产品决策且不超出既有授权的审查问题，由主 agent 自动派发 worker 修复并再次调用原审查角色
- [blackbox-acceptance-focus](review-gates/blackbox-acceptance-focus.md) — 黑盒验收的关注点是功能是否完善、是否可用，逐条验收通过不等于验收通过
- [credible-tests](review-gates/credible-tests.md) — 同一实现角色先核对测试证明力再实现，不以理想模拟、手工状态或环境失败冒充行为验证
- [direct-acceptance](review-gates/direct-acceptance.md) — 黑盒验收由主 agent 单次直接调用验收者，验收者唯一写报告，主 agent 只核对结构化对象与报告一致性
- [direct-pre-review](review-gates/direct-pre-review.md) — 提交前审查由主 agent 单次直接调用白盒审查者，只依据结构化裁决与审查快照决定是否远端写入
- [failure-attribution](review-gates/failure-attribution.md) — 白盒审查者或黑盒验收者返回 FAIL 后，主 agent 在角色只读的前提下归因为产品决策或可自动解决的问题并记录
- [independent-issue-task](review-gates/independent-issue-task.md) — 审查发现的与当前任务根因无关且可独立验证的问题，新增后续任务而不并入当前返修
- [product-decision-escalation](review-gates/product-decision-escalation.md) — 只有会改变外部行为、数据、安全、权限或验收标准的审查问题才询问用户，未回答的问题不留痕
- [repair-round-limit](review-gates/repair-round-limit.md) — 同一审查门禁的自动返修最多三轮，第三轮仍未通过即记录技术阻塞并停止
- [root-cause-repair](review-gates/root-cause-repair.md) — 获准返修先核对错误假设及同类场景，同根因再次失败先重查设计且不重置轮次或扩大授权
- [structured-verdict](review-gates/structured-verdict.md) — 实现、审查与验收角色必须提交结构化结果，运行未正常完成、未提交、校验失败或语义矛盾都失败关闭
- [whitebox-review-focus](review-gates/whitebox-review-focus.md) — 白盒审查在所有任务完成后对整个分支做一次，重点是安全性与鲁棒性，其次核对验收到测试与实现的可追踪关系
- [worker-delivery](review-gates/worker-delivery.md) — 实现交付核对完整验收映射、真实测试位置及最终验证结果，未解释的相关失败不得放行

## shell

- [host-lifecycle](shell/host-lifecycle.md) — Shell 跟随所属主会话或子运行清理，会话切换与可处理退出不遗留无人管理命令
- [managed-execution](shell/managed-execution.md) — 所有约定入口统一登记 Shell，仅 agent 可显式后台执行且后台仍受超时约束
- [process-control](shell/process-control.md) — 从 Shell 列表确认停止选定任务及后代，不停止宿主，不误伤其他命令或虚报成功
- [process-list](shell/process-list.md) — /ps 在输入栏位置打开一行一个 Shell 的管理列表，详情只读简洁，不提供输出与操作按钮
- [status-entry](shell/status-entry.md) — 在原状态栏与 Agents 之间汇总本会话全部活动 Shell，空输入按下先选中汇总行

## task-planning

- [mechanical-validation](task-planning/mechanical-validation.md) — 固定只读检查入口统一核对任务格式、验收覆盖、原文、归属和依赖，失败给出可定位原因
- [planning-artifacts](task-planning/planning-artifacts.md) — 同次规划先确定可执行任务骨架再生成正文，增量只改影响范围且不现场编写机械检查器
- [planning-preflight](task-planning/planning-preflight.md) — 规划启动前核对需求、任务状态、范围占用和验证前提，条件不满足时不空跑规划角色
- [task-file-line-limit](task-planning/task-file-line-limit.md) — 每份任务文件扣除示例及成品代码块后最多 200 行，不限制任务的代码改动量
- [verification-contract](task-planning/verification-contract.md) — 每个任务明确真实入口、必须成立的行为、关键场景和模拟边界，高风险测试方案在实施前核对

## workflow-data

- [controlled-updates](workflow-data/controlled-updates.md) — 运行信息通过受校验工具局部读写，拒绝未知字段和过期更新并返回简短回执
- [decision-append](workflow-data/decision-append.md) — 决策由专用工具在本机按需求追加，回执先于行动且既有内容不可改写
- [document-boundary](workflow-data/document-boundary.md) — 需求和任务定义及验收报告留在仓库，运行字段与决策只保存在本机
- [local-ownership](workflow-data/local-ownership.md) — 流程数据保存在本机用户数据区，按仓库与需求隔离且不依赖工作目录存在
- [safe-migration](workflow-data/safe-migration.md) — 全量迁移在相关写入全部停止后校验执行，保留历史内容并在冲突或失败时保护源数据
- [state-transitions](workflow-data/state-transitions.md) — 需求和任务状态由工具按固定集合及流程门禁推进，子运行结束不等于任务完成
- [version-bound-recovery](workflow-data/version-bound-recovery.md) — 续接从本机状态定位需求并核对版本和原运行，缺失数据或旧通过证据不能放行
