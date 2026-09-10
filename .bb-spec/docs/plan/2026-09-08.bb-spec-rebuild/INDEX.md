# pi-company 完全重构 实施计划
## 阶段 1：骨架与共享基础
- [package-skeleton](01-package-skeleton.md) — 清除旧执行链，包声明与测试助手
- [local-identity](02-local-identity.md) — 仓库/需求身份、工作区发现、本机数据布局 [依赖: package-skeleton]
- [versioned-store](03-versioned-store.md) — SQLite 事务、UUIDv7、状态版本 CAS [依赖: local-identity]
- [sleep-aware-clock](04-sleep-aware-clock.md) — 扣除睡眠间隔的统一计时器 [依赖: package-skeleton]
- [decision-ledger](05-decision-ledger.md) — 本机决策追加与决策记录工具 [依赖: versioned-store]
- [workflow-state](06-workflow-state.md) — 阶段/进度集合、随形状的阶段检查、受控回退、以运行身份取证据 [依赖: versioned-store, decision-ledger]
- [workflow-tool](07-workflow-tool.md) — 运行信息工具（含 retreat，证据只以 runId 传入） [依赖: workflow-state]
- [window-registry](38-window-registry.md) — 窗口登记、睡眠感知心跳、持有者消失的机械判定 [依赖: local-identity, versioned-store, sleep-aware-clock]
## 阶段 2：角色、配置与 MCP
- [role-catalog](09-role-catalog.md) — 三层角色定义合并与派工关系 [依赖: package-skeleton]
- [role-settings](10-role-settings.md) — 模型/思考/MCP 解析与保存 [依赖: role-catalog]
- [mcp-discovery](11-mcp-discovery.md) — 适配器探测、服务枚举、按角色装载 [依赖: role-settings]
- [settings-controller](12-settings-controller.md) — 设置页控制器与 /pi-company:setting 终端界面 [依赖: role-settings, mcp-discovery]
## 阶段 3：守护进程内核
- [daemon-protocol](14-daemon-protocol.md) — 帧格式与方法/事件目录 [依赖: local-identity]
- [daemon-lifecycle](15-daemon-lifecycle.md) — 入口、socket 探测单实例与自动收敛、空闲退出、中断标记 [依赖: versioned-store, sleep-aware-clock, daemon-protocol]
- [structured-verdict](16-structured-verdict.md) — 结构化裁决校验与收集 [依赖: package-skeleton]
- [error-details](17-error-details.md) — 错误详情 [依赖: structured-verdict]
- [run-store](18-run-store.md) — 运行记录持久化 [依赖: versioned-store, error-details]
- [session-records](19-session-records.md) — SQLite 会话记录落盘、悬空调用补中断结果、重载 [依赖: run-store]
- [shell-registry](20-shell-registry.md) — Shell 登记、信号探测与逃逸后代、用户裁定、按运行令牌接管 [依赖: sleep-aware-clock]
- [shell-bash-tool](21-shell-bash-tool.md) — bash 包装与手动入口接管 [依赖: shell-registry]
- [network-pause](22-network-pause.md) — 故障分类、闸门、连通探测 [依赖: sleep-aware-clock]
- [range-claims](39-range-claims.md) — 范围独占、等待、机械证据释放与用户显式释放、交接 [依赖: window-registry, run-store]
- [write-guard](40-write-guard.md) — 写入对照占用、交集指纹与 HEAD/分支前后比对、范围提交与审查快照 [依赖: shell-bash-tool, range-claims]
- [role-session](23-role-session.md) — 角色子会话、流空闲超时、只读角色写入关闭 [依赖: role-catalog, mcp-discovery, structured-verdict, session-records, shell-bash-tool, network-pause, write-guard]
- [relay-queue](26-relay-queue.md) — 提问/通知队列接口 [依赖: versioned-store, daemon-protocol]
- [requirement-agent-session](24-requirement-agent-session.md) — 需求代理会话与专属工具、写入范围校验、独立问题只记录 [依赖: workflow-tool, role-session, relay-queue]
- [run-manager](25-run-manager.md) — 派工权与范围校验、编排、控制级联、协议处理器接入 [依赖: daemon-lifecycle, run-store, network-pause, requirement-agent-session, relay-queue, range-claims]
## 阶段 4：窗口接入
- [daemon-client](27-daemon-client.md) — 连接、拉起、重连、订阅 [依赖: daemon-protocol, daemon-lifecycle]
- [dispatch-tools](28-dispatch-tools.md) — 主会话四个工具 [依赖: daemon-client]
- [relay-inbox](29-relay-inbox.md) — 中继收件箱注入主会话 [依赖: daemon-client]
- [window-lifecycle](30-window-lifecycle.md) — 窗口登记、切换门槛、退出信号与清理 [依赖: shell-bash-tool, daemon-client, window-registry]
- [commands](31-commands.md) — 六个统一前缀命令 [依赖: settings-controller, dispatch-tools]
## 阶段 5：界面
- [agents-activity](32-agents-activity.md) — 面板树模型与 20 秒保留 [依赖: daemon-client]
- [agents-panel](33-agents-panel.md) — 面板组件、挂载与底部焦点编排 [依赖: agents-activity]
- [transcript-view](34-transcript-view.md) — 记录查看页 [依赖: daemon-client, session-records, agents-panel]
- [shell-page](35-shell-page.md) — Shell 状态与列表：状态栏汇总文本、/pi-company:ps 列表、详情、停止确认、用户裁定 [依赖: shell-registry, daemon-client, write-guard, agents-panel]
## 阶段 6：多仓库协作
- [workspace-coordination](42-workspace-coordination.md) — 跨仓库等待与契约变更路由 [依赖: requirement-agent-session, relay-queue, range-claims]
## 阶段 7：角色提示词、流程 Skill 与脚本
- [spec-docs-format](43-spec-docs-format.md) — 文档格式、模板与固定机械检查 [依赖: workflow-tool]
- [role-prompts](45-role-prompts.md) — 角色提示词：五个角色定义文件 [依赖: role-catalog, structured-verdict, requirement-agent-session]
- [planner-role](46-planner-role.md) — 规划角色与参考文本 [依赖: role-catalog, spec-docs-format]
- [main-session-skills](49-main-session-skills.md) — 主会话流程 Skill、规则与 README [依赖: dispatch-tools, write-guard, role-prompts, commands]
## 阶段 8：集成验证
- [integration-verification](51-integration-verification.md) — 端到端集成验证矩阵 [依赖: 全部]

- [sqlite-storage](52-sqlite-storage.md) — 业务与审计数据统一 SQLite 与 UUIDv7、普通日志使用 .log、验收

- [ACCEPTANCE](ACCEPTANCE.md) — 全部规范验收的证据关联、已复现失败与验证边界
