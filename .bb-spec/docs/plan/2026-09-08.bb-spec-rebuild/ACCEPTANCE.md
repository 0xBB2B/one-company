# 逐项验收证据审计

审计日期：2026-09-10。工作分支：bb-spec-rebuild。结论：尚未通过整个项目的最终验收。
 本表覆盖 41 份规范、193 条验收。
本表枚举现行全部规范验收编号，关联生产入口与现有回归文件。“行为回归关联”只表示存在相关自动化证据，不表示已经逐一执行该条全部 Given / When / Then；“指令契约”只能证明角色或技能收到要求，不能证明真实模型自主判断正确。未通过、接入待核验和环境边界必须单独处理，不能用计划勾选或测试总数替代。

## 共享 Git 历史反例与当前修复

共享 Git 的实际入口为 createManagedBashOperations → createRangeProtection.commandGuard。隔离仓库中启动两个真实运行记录，各自占用 README.md 和 foreign.txt；另一任务先修改并暂存 foreign.txt。本任务只获准 README.md，执行修改、git add README.md 和 git commit 后，提交同时包含 README.md 与 foreign.txt，退出码为 0。随后另一运行仍活动时执行 git switch -c audit-other，退出码仍为 0，当前分支已变为 audit-other；运行仅在命令后的核对中被标记 failed。

根因：Shell 可写共享 Git 元数据；限定提交路径的辅助函数没有接入该执行路径；命令后的分支核对只能发现变化，无法兑现“拒绝且现场未破坏”。需在实际 Git 写入入口实施约束，不能通过改写规范降低为事后发现，也不能新增几个只测辅助函数的用例即勾选完成。

当前修复：普通 Shell 与直接文件编辑禁止写共享 Git 元数据；主会话和可写角色使用 pi_company_git_commit 明确选择文件。tests/managed-git.test.ts 经真实 Shell/提交工具验证部分暂存保留、linked worktree、切换/重置/别名/脚本阻止、hook/filter 阻塞、重命名、删除、注入与并发提交。默认工作流经真实 SDK/RunManager 完成受管提交，SDK 装载测试覆盖主会话工具注册。此项定向行为通过，不代表完整项目验收通过。

## 旧内容与临时产物

- 已删除 .manual-debug 下四个一次性调试脚本和根目录 typescript 终端日志。
- write-guard 中旧组合守卫存在仅测试调用的路径；其测试迁移和无用实现清理未完成，不能宣称所有旧代码已删尽。
- 本次审计、复现和测试的临时文件统一在 .bb-spec/.cache/，最终结果落入本文后清理。用户原有两个后台调试进程未操作。

## 逐项清单

### agents/builtin-execution

规范：.bb-spec/docs/spec/agents/builtin-execution.md。生产入口：daemon/run-manager.ts。

关联证据：tests/run-manager.test.ts、tests/integration/daemon-dispatch-relay.test.ts、tests/package-skeleton.test.ts。

| 验收 | 证据分类 | 核对结论 |
|---|---|---|
| AC-1 不依赖其他子代理系统 | 行为回归关联 | 相关回归已定位；逐场景覆盖与真实入口连接须核实后才能判该条通过。 |
| AC-2 运行身份与状态集合 | 行为回归关联 | 相关回归已定位；逐场景覆盖与真实入口连接须核实后才能判该条通过。 |
| AC-3 并行只受任务关系约束 | 行为回归关联 | 相关回归已定位；逐场景覆盖与真实入口连接须核实后才能判该条通过。 |
| AC-4 故障不被绕过 | 行为回归关联 | 相关回归已定位；逐场景覆盖与真实入口连接须核实后才能判该条通过。 |

### agents/cross-window-panel

规范：.bb-spec/docs/spec/agents/cross-window-panel.md。生产入口：runtime/agents-panel.ts。

关联证据：tests/agents-panel.test.ts、tests/agents-activity.test.ts、tests/agents-ui.test.ts、tests/integration/agents-panel.test.ts。

| 验收 | 证据分类 | 核对结论 |
|---|---|---|
| AC-1 布局与条目树 | 行为回归关联 | 相关回归已定位；逐场景覆盖与真实入口连接须核实后才能判该条通过。 |
| AC-2 真实活动与不可达 | 行为回归关联 | 相关回归已定位；逐场景覆盖与真实入口连接须核实后才能判该条通过。 |
| AC-3 键盘进入与状态对应按钮 | 行为回归关联 | 相关回归已定位；逐场景覆盖与真实入口连接须核实后才能判该条通过。 |
| AC-4 任意窗口控制以真实结果为准 | 行为回归关联 | 相关回归已定位；逐场景覆盖与真实入口连接须核实后才能判该条通过。 |
| AC-5 聊天区去重 | 行为回归关联 | 相关回归已定位；逐场景覆盖与真实入口连接须核实后才能判该条通过。 |
| AC-6 限高滚动 | 行为回归关联 | 相关回归已定位；逐场景覆盖与真实入口连接须核实后才能判该条通过。 |
| AC-7 结束灰显与临时提示 20 秒 | 行为回归关联 | 相关回归已定位；逐场景覆盖与真实入口连接须核实后才能判该条通过。 |

### agents/daemon-host

规范：.bb-spec/docs/spec/agents/daemon-host.md。生产入口：daemon/lifecycle.ts。

关联证据：tests/daemon-lifecycle.test.ts、tests/daemon-client.test.ts、tests/integration/daemon-dispatch-relay.test.ts、tests/integration/network-and-sleep.test.ts。

| 验收 | 证据分类 | 核对结论 |
|---|---|---|
| AC-1 每仓库单实例与共享范围 | 行为回归关联 | 相关回归已定位；逐场景覆盖与真实入口连接须核实后才能判该条通过。 |
| AC-2 凭据不依赖窗口 | 行为回归关联 | 相关回归已定位；逐场景覆盖与真实入口连接须核实后才能判该条通过。 |
| AC-3 空闲退出与保持 | 行为回归关联 | 相关回归已定位；逐场景覆盖与真实入口连接须核实后才能判该条通过。 |
| AC-4 不可达与崩溃如实显示 | 行为回归关联 | 相关回归已定位；逐场景覆盖与真实入口连接须核实后才能判该条通过。 |
| AC-5 睡眠不计入超时 | 环境边界 | 通过注入时钟验证扣除睡眠；未在本次审计中真实合盖五分钟。 |
| AC-6 启动诊断持久化且不串台 | 定向回归通过 | 两次并发启动失败各写独立 UUIDv7 .log，权限 0600、原文不混写；旧启动原因不串台，窗口退出后仍写日志并可重连。 |

### agents/namespaced-entrypoints

规范：.bb-spec/docs/spec/agents/namespaced-entrypoints.md。生产入口：extensions/commands.ts。

关联证据：tests/commands.test.ts、tests/main-session-skills.test.ts。

| 验收 | 证据分类 | 核对结论 |
|---|---|---|
| AC-1 六个入口与统一前缀 | 定向回归通过 | commands.test.ts 验证六个入口、统一前缀、路由参数与失败反馈；SDK 装载验证实际注册。 |
| AC-2 流程路由与参数保持含义 | 指令契约 | 仍需核对模型在反例中的实际行为，不能把文本包含检查当作该条验收通过。 |
| AC-3 不提供前缀外别名 | 定向回归通过 | commands.test.ts 验证六个入口、统一前缀、路由参数与失败反馈；SDK 装载验证实际注册。 |
| AC-4 入口加载失败如实报告 | 定向回归通过 | commands.test.ts 验证六个入口、统一前缀、路由参数与失败反馈；SDK 装载验证实际注册。 |

### agents/pause-control

规范：.bb-spec/docs/spec/agents/pause-control.md。生产入口：daemon/run-manager.ts。

关联证据：tests/run-manager.test.ts、tests/role-session.test.ts、tests/network-pause.test.ts、tests/integration/control-and-resume.test.ts、tests/integration/network-and-sleep.test.ts。

| 验收 | 证据分类 | 核对结论 |
|---|---|---|
| AC-1 暂停须确认并连带角色 | 行为回归关联 | 相关回归已定位；逐场景覆盖与真实入口连接须核实后才能判该条通过。 |
| AC-2 继续保留进度并核对 | 行为回归关联 | 相关回归已定位；逐场景覆盖与真实入口连接须核实后才能判该条通过。 |
| AC-3 全部暂停与全部继续范围 | 行为回归关联 | 相关回归已定位；逐场景覆盖与真实入口连接须核实后才能判该条通过。 |
| AC-4 故障分类 | 行为回归关联 | 相关回归已定位；逐场景覆盖与真实入口连接须核实后才能判该条通过。 |
| AC-5 联网自动续接与手动暂停例外 | 行为回归关联 | 相关回归已定位；逐场景覆盖与真实入口连接须核实后才能判该条通过。 |
| AC-6 任意窗口离线可控 | 行为回归关联 | 相关回归已定位；逐场景覆盖与真实入口连接须核实后才能判该条通过。 |

### agents/requirement-agent

规范：.bb-spec/docs/spec/agents/requirement-agent.md。生产入口：daemon/requirement-agent.ts。

关联证据：tests/requirement-agent-session.test.ts、tests/integration/default-workflow.test.ts、tests/integration/daemon-dispatch-relay.test.ts。

| 验收 | 证据分类 | 核对结论 |
|---|---|---|
| AC-1 派出前提与唯一性 | 行为回归关联 | 相关回归已定位；逐场景覆盖与真实入口连接须核实后才能判该条通过。 |
| AC-2 规划与提议由需求代理完成 | 行为回归关联 | 相关回归已定位；逐场景覆盖与真实入口连接须核实后才能判该条通过。 |
| AC-3 自行完成仍受交付核对 | 行为回归关联 | 相关回归已定位；逐场景覆盖与真实入口连接须核实后才能判该条通过。 |
| AC-4 补充需求并入或重新提议 | 指令契约 | 仍需核对模型在反例中的实际行为，不能把文本包含检查当作该条验收通过。 |
| AC-5 结束与决策经中继 | 行为回归关联 | 相关回归已定位；逐场景覆盖与真实入口连接须核实后才能判该条通过。 |

### agents/role-catalog

规范：.bb-spec/docs/spec/agents/role-catalog.md。生产入口：runtime/roles.ts。

关联证据：tests/role-catalog.test.ts、tests/role-prompts.test.ts、tests/integration/settings-dispatch.test.ts。

| 验收 | 证据分类 | 核对结论 |
|---|---|---|
| AC-1 三层合并与覆盖 | 行为回归关联 | 相关回归已定位；逐场景覆盖与真实入口连接须核实后才能判该条通过。 |
| AC-2 三层派工关系 | 行为回归关联 | 相关回归已定位；逐场景覆盖与真实入口连接须核实后才能判该条通过。 |
| AC-3 设置页随目录变化 | 行为回归关联 | 相关回归已定位；逐场景覆盖与真实入口连接须核实后才能判该条通过。 |
| AC-4 损坏定义不静默替代 | 行为回归关联 | 相关回归已定位；逐场景覆盖与真实入口连接须核实后才能判该条通过。 |
| AC-5 未受信任项目忽略项目层定义 | 行为回归关联 | 相关回归已定位；逐场景覆盖与真实入口连接须核实后才能判该条通过。 |

### agents/role-settings

规范：.bb-spec/docs/spec/agents/role-settings.md。生产入口：daemon/run-manager.ts。

关联证据：tests/role-settings.test.ts、tests/mcp-discovery.test.ts、tests/role-session.test.ts、tests/integration/settings-dispatch.test.ts。

| 验收 | 证据分类 | 核对结论 |
|---|---|---|
| AC-1 项目逐项覆盖且角色相互独立 | 行为回归关联 | 相关回归已定位；逐场景覆盖与真实入口连接须核实后才能判该条通过。 |
| AC-2 启动时解析继承与默认值 | 行为回归关联 | 相关回归已定位；逐场景覆盖与真实入口连接须核实后才能判该条通过。 |
| AC-3 保存不改变已启动任务 | 行为回归关联 | 相关回归已定位；逐场景覆盖与真实入口连接须核实后才能判该条通过。 |
| AC-4 无效显式配置不被悄悄替换 | 行为回归关联 | 相关回归已定位；逐场景覆盖与真实入口连接须核实后才能判该条通过。 |
| AC-5 MCP 整体覆盖、默认为空且失效项保留 | 行为回归关联 | 相关回归已定位；逐场景覆盖与真实入口连接须核实后才能判该条通过。 |
| AC-6 通用入口不能绕过角色集合 | 行为回归关联 | 相关回归已定位；逐场景覆盖与真实入口连接须核实后才能判该条通过。 |
| AC-7 缺失服务只阻塞依赖它的任务 | 指令契约 | 仍需核对模型在反例中的实际行为，不能把文本包含检查当作该条验收通过。 |
| AC-8 MCP 不改变角色边界 | 接入待核验 | MCP 工具集合与只读限制有测试；黑盒读取本仓源码的限制目前主要由指令表达。 |

### agents/run-diagnostics

规范：.bb-spec/docs/spec/agents/run-diagnostics.md。生产入口：runtime/error-details.ts。

关联证据：tests/error-details.test.ts、tests/structured-verdict.test.ts、tests/sqlite-business.test.ts。

| 验收 | 证据分类 | 核对结论 |
|---|---|---|
| AC-1 实际错误完整保留且不猜测 | 行为回归关联 | 相关回归已定位；逐场景覆盖与真实入口连接须核实后才能判该条通过。 |
| AC-2 只记错误且成功运行不新增详情 | 行为回归关联 | 相关回归已定位；逐场景覆盖与真实入口连接须核实后才能判该条通过。 |
| AC-3 有界摘要及结束后查询 | 行为回归关联 | 相关回归已定位；逐场景覆盖与真实入口连接须核实后才能判该条通过。 |
| AC-4 保存与读取故障不掩盖原错误 | 行为回归关联 | 相关回归已定位；逐场景覆盖与真实入口连接须核实后才能判该条通过。 |
| AC-5 提交诊断保留各次错误且不保存正文 | 行为回归关联 | 相关回归已定位；逐场景覆盖与真实入口连接须核实后才能判该条通过。 |

### agents/run-lifecycle

规范：.bb-spec/docs/spec/agents/run-lifecycle.md。生产入口：daemon/run-manager.ts。

关联证据：tests/run-manager.test.ts、tests/integration/control-and-resume.test.ts、tests/integration/host-exit.test.ts。

| 验收 | 证据分类 | 核对结论 |
|---|---|---|
| AC-1 关窗与切换不影响运行 | 行为回归关联 | 相关回归已定位；逐场景覆盖与真实入口连接须核实后才能判该条通过。 |
| AC-2 续接核对与重载 | 行为回归关联 | 相关回归已定位；逐场景覆盖与真实入口连接须核实后才能判该条通过。 |
| AC-3 异常退出失败关闭 | 行为回归关联 | 相关回归已定位；逐场景覆盖与真实入口连接须核实后才能判该条通过。 |

### agents/session-records

规范：.bb-spec/docs/spec/agents/session-records.md。生产入口：runtime/session-records.ts。

关联证据：tests/session-records.test.ts、tests/role-session.test.ts、tests/integration/control-and-resume.test.ts。

| 验收 | 证据分类 | 核对结论 |
|---|---|---|
| AC-1 完整记录可定位 | 行为回归关联 | 相关回归已定位；逐场景覆盖与真实入口连接须核实后才能判该条通过。 |
| AC-2 原样保存与本机限定 | 行为回归关联 | 相关回归已定位；逐场景覆盖与真实入口连接须核实后才能判该条通过。 |
| AC-3 重载续接 | 行为回归关联 | 相关回归已定位；逐场景覆盖与真实入口连接须核实后才能判该条通过。 |
| AC-4 写读故障不虚报 | 行为回归关联 | 相关回归已定位；逐场景覆盖与真实入口连接须核实后才能判该条通过。 |

### agents/settings-page

规范：.bb-spec/docs/spec/agents/settings-page.md。生产入口：runtime/settings-ui.ts。

关联证据：tests/settings-page.test.ts、tests/settings-controller.test.ts、tests/integration/settings-dispatch.test.ts。

| 验收 | 证据分类 | 核对结论 |
|---|---|---|
| AC-1 聚焦布局与来源展示 | 行为回归关联 | 相关回归已定位；逐场景覆盖与真实入口连接须核实后才能判该条通过。 |
| AC-2 主页按键与单一界面 | 行为回归关联 | 相关回归已定位；逐场景覆盖与真实入口连接须核实后才能判该条通过。 |
| AC-3 模型与思考候选搜索、定位与原位返回 | 行为回归关联 | 相关回归已定位；逐场景覆盖与真实入口连接须核实后才能判该条通过。 |
| AC-4 MCP 候选来源、勾选交互与不可用标记 | 行为回归关联 | 相关回归已定位；逐场景覆盖与真实入口连接须核实后才能判该条通过。 |
| AC-5 整体保存、空集合与失败不虚报 | 行为回归关联 | 相关回归已定位；逐场景覆盖与真实入口连接须核实后才能判该条通过。 |
| AC-6 页面不设置并发数量限制 | 行为回归关联 | 相关回归已定位；逐场景覆盖与真实入口连接须核实后才能判该条通过。 |

### agents/transcript-view

规范：.bb-spec/docs/spec/agents/transcript-view.md。生产入口：runtime/transcript-view.ts。

关联证据：tests/transcript-view.test.ts、tests/integration/agents-panel.test.ts。

| 验收 | 证据分类 | 核对结论 |
|---|---|---|
| AC-1 打开与返回 | 行为回归关联 | 相关回归已定位；逐场景覆盖与真实入口连接须核实后才能判该条通过。 |
| AC-2 实时跟随与滚动 | 行为回归关联 | 相关回归已定位；逐场景覆盖与真实入口连接须核实后才能判该条通过。 |
| AC-3 结束与不可达显示保存记录 | 行为回归关联 | 相关回归已定位；逐场景覆盖与真实入口连接须核实后才能判该条通过。 |
| AC-4 只读与原样展示 | 行为回归关联 | 相关回归已定位；逐场景覆盖与真实入口连接须核实后才能判该条通过。 |

### agents/user-relay

规范：.bb-spec/docs/spec/agents/user-relay.md。生产入口：daemon/relay-queue.ts。

关联证据：tests/relay-queue.test.ts、tests/requirement-agent-session.test.ts、tests/integration/daemon-dispatch-relay.test.ts。

| 验收 | 证据分类 | 核对结论 |
|---|---|---|
| AC-1 投递范围与首答生效 | 行为回归关联 | 相关回归已定位；逐场景覆盖与真实入口连接须核实后才能判该条通过。 |
| AC-2 无窗口排队与推送 | 行为回归关联 | 相关回归已定位；逐场景覆盖与真实入口连接须核实后才能判该条通过。 |
| AC-3 补充需求转发 | 行为回归关联 | 相关回归已定位；逐场景覆盖与真实入口连接须核实后才能判该条通过。 |
| AC-4 通知经中继且代理间不直连 | 行为回归关联 | 相关回归已定位；逐场景覆盖与真实入口连接须核实后才能判该条通过。 |

### agents/user-stop

规范：.bb-spec/docs/spec/agents/user-stop.md。生产入口：daemon/run-manager.ts。

关联证据：tests/run-manager.test.ts、tests/role-session.test.ts、tests/integration/control-and-resume.test.ts。

| 验收 | 证据分类 | 核对结论 |
|---|---|---|
| AC-1 连带停止与状态归属 | 行为回归关联 | 相关回归已定位；逐场景覆盖与真实入口连接须核实后才能判该条通过。 |
| AC-2 保留成果并通知 | 行为回归关联 | 相关回归已定位；逐场景覆盖与真实入口连接须核实后才能判该条通过。 |
| AC-3 终态无恢复 | 行为回归关联 | 相关回归已定位；逐场景覆盖与真实入口连接须核实后才能判该条通过。 |
| AC-4 后代残留不释放范围 | 行为回归关联 | 相关回归已定位；逐场景覆盖与真实入口连接须核实后才能判该条通过。 |

### agents/workflow-shape

规范：.bb-spec/docs/spec/agents/workflow-shape.md。生产入口：daemon/requirement-agent.ts。

关联证据：tests/requirement-agent-session.test.ts、tests/workflow-state.test.ts、tests/integration/default-workflow.test.ts。

| 验收 | 证据分类 | 核对结论 |
|---|---|---|
| AC-1 提议内容与默认阶段检查 | 行为回归关联 | 相关回归已定位；逐场景覆盖与真实入口连接须核实后才能判该条通过。 |
| AC-2 跳过阶段检查需用户决定 | 行为回归关联 | 相关回归已定位；逐场景覆盖与真实入口连接须核实后才能判该条通过。 |
| AC-3 升级形状再问一次 | 行为回归关联 | 相关回归已定位；逐场景覆盖与真实入口连接须核实后才能判该条通过。 |
| AC-4 形状之外不得派工 | 行为回归关联 | 相关回归已定位；逐场景覆盖与真实入口连接须核实后才能判该条通过。 |

### collaboration/range-handoff

规范：.bb-spec/docs/spec/collaboration/range-handoff.md。生产入口：runtime/range-protection.ts。

关联证据：tests/range-claims.test.ts、tests/write-guard.test.ts、tests/rebuild-delivery.test.ts。

| 验收 | 证据分类 | 核对结论 |
|---|---|---|
| AC-1 并发申请只有一个获准 | 行为回归关联 | 相关回归已定位；逐场景覆盖与真实入口连接须核实后才能判该条通过。 |
| AC-2 局部等待且不抢占 | 行为回归关联 | 相关回归已定位；逐场景覆盖与真实入口连接须核实后才能判该条通过。 |
| AC-3 接手重新核对内容 | 接入待核验 | 指纹辅助函数有测试；仍须证明派工接手入口强制重新读取并核对交付。 |
| AC-4 失联持有者按停止事实释放 | 行为回归关联 | 相关回归已定位；逐场景覆盖与真实入口连接须核实后才能判该条通过。 |
| AC-5 交叉范围不相互永久等待 | 行为回归关联 | 相关回归已定位；逐场景覆盖与真实入口连接须核实后才能判该条通过。 |
| AC-6 命令越界写入判违规 | 接入待核验 | 旧组合守卫测试与生产 createRangeProtection 不同；需迁移全部失效反例到实际调用链。 |

### collaboration/validation-consistency

规范：.bb-spec/docs/spec/collaboration/validation-consistency.md。生产入口：runtime/range-protection.ts。

关联证据：tests/shared-branch-guard.test.ts、tests/rebuild-delivery.test.ts、tests/write-guard.test.ts。

| 验收 | 证据分类 | 核对结论 |
|---|---|---|
| AC-1 验证范围保护与独立并行 | 接入待核验 | 现有读写占用测试不能证明审查启动前实际取得验证范围的保护。 |
| AC-2 对象改变使旧结论失效 | 行为回归关联 | 相关回归已定位；逐场景覆盖与真实入口连接须核实后才能判该条通过。 |
| AC-3 共享提交按范围纳入且他人活动时不切换 | 定向行为通过 | managed-git.test.ts 验证主会话/角色明确路径提交保留他人部分暂存；真实 Shell 的切换、重置、别名和脚本在修改前被拒，提示活动运行身份。默认工作流与 SDK 装载回归覆盖接线。 |
| AC-4 全分支阶段检查不被弱化 | 行为回归关联 | 相关回归已定位；逐场景覆盖与真实入口连接须核实后才能判该条通过。 |

### collaboration/window-ownership

规范：.bb-spec/docs/spec/collaboration/window-ownership.md。生产入口：runtime/daemon-client.ts。

关联证据：tests/daemon-client.test.ts、tests/requirement-agent-session.test.ts、tests/integration/workspace.test.ts、tests/integration/control-and-resume.test.ts。

| 验收 | 证据分类 | 核对结论 |
|---|---|---|
| AC-1 独立与补充需求的归属 | 指令契约 | 仍需核对模型在反例中的实际行为，不能把文本包含检查当作该条验收通过。 |
| AC-2 旧窗口关闭不阻断后续 | 行为回归关联 | 相关回归已定位；逐场景覆盖与真实入口连接须核实后才能判该条通过。 |
| AC-3 工作区内共享可控 | 行为回归关联 | 相关回归已定位；逐场景覆盖与真实入口连接须核实后才能判该条通过。 |
| AC-4 消息不是授权或通过证据 | 指令契约 | 仍需核对模型在反例中的实际行为，不能把文本包含检查当作该条验收通过。 |

### collaboration/workspace-coordination

规范：.bb-spec/docs/spec/collaboration/workspace-coordination.md。生产入口：daemon/requirement-agent.ts。

关联证据：tests/workspace-coordination.test.ts、tests/integration/workspace.test.ts、tests/main-session-skills.test.ts。

| 验收 | 证据分类 | 核对结论 |
|---|---|---|
| AC-1 可见范围随启动路径 | 行为回归关联 | 相关回归已定位；逐场景覆盖与真实入口连接须核实后才能判该条通过。 |
| AC-2 一次澄清、多仓派工、契约各自落盘 | 指令契约 | 仍需核对模型在反例中的实际行为，不能把文本包含检查当作该条验收通过。 |
| AC-3 契约变更经主会话裁定 | 指令契约 | 仍需核对模型在反例中的实际行为，不能把文本包含检查当作该条验收通过。 |
| AC-4 跨仓库等待按本机状态核对 | 行为回归关联 | 相关回归已定位；逐场景覆盖与真实入口连接须核实后才能判该条通过。 |

### review-gates/auto-repair-loop

规范：.bb-spec/docs/spec/review-gates/auto-repair-loop.md。生产入口：daemon/requirement-agent.ts。

关联证据：tests/requirement-agent-session.test.ts、tests/workflow-state.test.ts、tests/integration/repair-authorization.test.ts、tests/role-prompts.test.ts。

| 验收 | 证据分类 | 核对结论 |
|---|---|---|
| AC-1 白盒审查问题自动修复 | 行为回归关联 | 相关回归已定位；逐场景覆盖与真实入口连接须核实后才能判该条通过。 |
| AC-2 超出授权范围不自动返修 | 指令契约 | 仍需核对模型在反例中的实际行为，不能把文本包含检查当作该条验收通过。 |
| AC-3 首次返修覆盖同类场景 | 指令契约 | 仍需核对模型在反例中的实际行为，不能把文本包含检查当作该条验收通过。 |
| AC-4 重复根因先核对设计 | 指令契约 | 仍需核对模型在反例中的实际行为，不能把文本包含检查当作该条验收通过。 |
| AC-5 验收返修内嵌白盒重审并计入轮次 | 指令契约 | 仍需核对模型在反例中的实际行为，不能把文本包含检查当作该条验收通过。 |
| AC-6 三轮后停止且不重置 | 行为回归关联 | 相关回归已定位；逐场景覆盖与真实入口连接须核实后才能判该条通过。 |
| AC-7 用户授权后继续计数 | 行为回归关联 | 相关回归已定位；逐场景覆盖与真实入口连接须核实后才能判该条通过。 |

### review-gates/blackbox-acceptance

规范：.bb-spec/docs/spec/review-gates/blackbox-acceptance.md。生产入口：runtime/delivery.ts。

关联证据：tests/rebuild-delivery.test.ts、tests/structured-verdict.test.ts、tests/role-session.test.ts、tests/integration/default-workflow.test.ts、tests/role-prompts.test.ts。

| 验收 | 证据分类 | 核对结论 |
|---|---|---|
| AC-1 直接调用并以结构化对象裁决 | 行为回归关联 | 相关回归已定位；逐场景覆盖与真实入口连接须核实后才能判该条通过。 |
| AC-2 派工指令约束验收依据 | 指令契约 | 仍需核对模型在反例中的实际行为，不能把文本包含检查当作该条验收通过。 |
| AC-3 逐条通过但不可用即不通过 | 指令契约 | 仍需核对模型在反例中的实际行为，不能把文本包含检查当作该条验收通过。 |
| AC-4 报告由验收者唯一写入并列出命令 | 行为回归关联 | 相关回归已定位；逐场景覆盖与真实入口连接须核实后才能判该条通过。 |
| AC-5 结果与报告不一致时拒绝 | 行为回归关联 | 相关回归已定位；逐场景覆盖与真实入口连接须核实后才能判该条通过。 |
| AC-6 验收者写入工作区即失败 | 行为回归关联 | 相关回归已定位；逐场景覆盖与真实入口连接须核实后才能判该条通过。 |

### review-gates/credible-tests

规范：.bb-spec/docs/spec/review-gates/credible-tests.md。生产入口：runtime/delivery.ts。

关联证据：tests/structured-verdict.test.ts、tests/rebuild-delivery.test.ts、tests/integration/default-workflow.test.ts、tests/role-prompts.test.ts。

| 验收 | 证据分类 | 核对结论 |
|---|---|---|
| AC-1 同次交付证明真实保护 | 指令契约 | 仍需核对模型在反例中的实际行为，不能把文本包含检查当作该条验收通过。 |
| AC-2 无效证明与伪失败不得交付 | 指令契约 | 仍需核对模型在反例中的实际行为，不能把文本包含检查当作该条验收通过。 |
| AC-3 已有行为不人为制造失败 | 行为回归关联 | 相关回归已定位；逐场景覆盖与真实入口连接须核实后才能判该条通过。 |

### review-gates/review-failure-handling

规范：.bb-spec/docs/spec/review-gates/review-failure-handling.md。生产入口：daemon/requirement-agent.ts。

关联证据：tests/requirement-agent-session.test.ts、tests/workspace-coordination.test.ts、tests/integration/repair-authorization.test.ts、tests/main-session-skills.test.ts。

| 验收 | 证据分类 | 核对结论 |
|---|---|---|
| AC-1 未通过先归因并记录 | 指令契约 | 仍需核对模型在反例中的实际行为，不能把文本包含检查当作该条验收通过。 |
| AC-2 记录失败停止派修 | 行为回归关联 | 相关回归已定位；逐场景覆盖与真实入口连接须核实后才能判该条通过。 |
| AC-3 产品决策只在用户选择后留痕 | 行为回归关联 | 相关回归已定位；逐场景覆盖与真实入口连接须核实后才能判该条通过。 |
| AC-4 独立问题只进清单并经用户确认 | 指令契约 | 仍需核对模型在反例中的实际行为，不能把文本包含检查当作该条验收通过。 |

### review-gates/structured-verdict

规范：.bb-spec/docs/spec/review-gates/structured-verdict.md。生产入口：runtime/result.ts。

关联证据：tests/structured-verdict.test.ts、tests/role-session.test.ts、tests/workflow-state.test.ts。

| 验收 | 证据分类 | 核对结论 |
|---|---|---|
| AC-1 合法对象被接受 | 行为回归关联 | 相关回归已定位；逐场景覆盖与真实入口连接须核实后才能判该条通过。 |
| AC-2 偏差结果失败关闭 | 行为回归关联 | 相关回归已定位；逐场景覆盖与真实入口连接须核实后才能判该条通过。 |
| AC-3 运行未正常完成不能提前放行 | 行为回归关联 | 相关回归已定位；逐场景覆盖与真实入口连接须核实后才能判该条通过。 |
| AC-4 失败提交可纠正且事件去重不放宽唯一性 | 行为回归关联 | 相关回归已定位；逐场景覆盖与真实入口连接须核实后才能判该条通过。 |

### review-gates/whitebox-review

规范：.bb-spec/docs/spec/review-gates/whitebox-review.md。生产入口：daemon/run-manager.ts。

关联证据：tests/structured-verdict.test.ts、tests/role-session.test.ts、tests/workflow-state.test.ts、tests/integration/default-workflow.test.ts、tests/role-prompts.test.ts。

| 验收 | 证据分类 | 核对结论 |
|---|---|---|
| AC-1 只在全部完成后审查整个分支 | 行为回归关联 | 相关回归已定位；逐场景覆盖与真实入口连接须核实后才能判该条通过。 |
| AC-2 安全与鲁棒性发现带触发路径 | 指令契约 | 仍需核对模型在反例中的实际行为，不能把文本包含检查当作该条验收通过。 |
| AC-3 测试遗漏是阻断项 | 指令契约 | 仍需核对模型在反例中的实际行为，不能把文本包含检查当作该条验收通过。 |
| AC-4 审查者写入工作区即运行失败 | 行为回归关联 | 相关回归已定位；逐场景覆盖与真实入口连接须核实后才能判该条通过。 |
| AC-5 提交前直接调用并以快照裁决 | 行为回归关联 | 相关回归已定位；逐场景覆盖与真实入口连接须核实后才能判该条通过。 |
| AC-6 非法结果失败关闭 | 行为回归关联 | 相关回归已定位；逐场景覆盖与真实入口连接须核实后才能判该条通过。 |
| AC-7 提交前审查未通过回退执行阶段 | 指令契约 | 仍需核对模型在反例中的实际行为，不能把文本包含检查当作该条验收通过。 |

### review-gates/worker-delivery

规范：.bb-spec/docs/spec/review-gates/worker-delivery.md。生产入口：runtime/delivery.ts。

关联证据：tests/rebuild-delivery.test.ts、tests/workflow-state.test.ts、tests/structured-verdict.test.ts、tests/integration/default-workflow.test.ts。

| 验收 | 证据分类 | 核对结论 |
|---|---|---|
| AC-1 完整证据后独立复跑 | 行为回归关联 | 相关回归已定位；逐场景覆盖与真实入口连接须核实后才能判该条通过。 |
| AC-2 缺项或错误验证不能通过 | 行为回归关联 | 相关回归已定位；逐场景覆盖与真实入口连接须核实后才能判该条通过。 |
| AC-3 相关回归失败有归属且不藏匿 | 指令契约 | 仍需核对模型在反例中的实际行为，不能把文本包含检查当作该条验收通过。 |

### shell/host-lifecycle

规范：.bb-spec/docs/spec/shell/host-lifecycle.md。生产入口：runtime/shell-registry.ts。

关联证据：tests/shell-registry.test.ts、tests/window-lifecycle.test.ts、tests/role-session.test.ts、tests/integration/host-exit.test.ts。

| 验收 | 证据分类 | 核对结论 |
|---|---|---|
| AC-1 结束范围遵循真实宿主 | 行为回归关联 | 相关回归已定位；逐场景覆盖与真实入口连接须核实后才能判该条通过。 |
| AC-2 暂停与继续不重启命令 | 行为回归关联 | 相关回归已定位；逐场景覆盖与真实入口连接须核实后才能判该条通过。 |
| AC-3 会话切换以清理确认为前提 | 行为回归关联 | 相关回归已定位；逐场景覆盖与真实入口连接须核实后才能判该条通过。 |
| AC-4 可处理退出路径清理真实进程 | 行为回归关联 | 相关回归已定位；逐场景覆盖与真实入口连接须核实后才能判该条通过。 |
| AC-5 主命令退出不能隐藏后代且确认手段有序 | 行为回归关联 | 相关回归已定位；逐场景覆盖与真实入口连接须核实后才能判该条通过。 |
| AC-6 重新拉起接管遗留任务 | 行为回归关联 | 相关回归已定位；逐场景覆盖与真实入口连接须核实后才能判该条通过。 |
| AC-7 外部托管进程不在保证范围 | 行为回归关联 | 相关回归已定位；逐场景覆盖与真实入口连接须核实后才能判该条通过。 |

### shell/managed-execution

规范：.bb-spec/docs/spec/shell/managed-execution.md。生产入口：runtime/shell-bash.ts。

关联证据：tests/shell-bash-tool.test.ts、tests/shell-ui.test.ts、tests/shell-registry.test.ts、tests/rebuild-delivery.test.ts。

| 验收 | 证据分类 | 核对结论 |
|---|---|---|
| AC-1 所有入口归属准确且权限不扩大 | 行为回归关联 | 相关回归已定位；逐场景覆盖与真实入口连接须核实后才能判该条通过。 |
| AC-2 默认及手动入口等待真实结果 | 行为回归关联 | 相关回归已定位；逐场景覆盖与真实入口连接须核实后才能判该条通过。 |
| AC-3 agent 显式后台返回可管理任务 | 行为回归关联 | 相关回归已定位；逐场景覆盖与真实入口连接须核实后才能判该条通过。 |
| AC-4 启动失败及取消不失管 | 行为回归关联 | 相关回归已定位；逐场景覆盖与真实入口连接须核实后才能判该条通过。 |
| AC-5 后台回执不解除超时与宿主约束 | 行为回归关联 | 相关回归已定位；逐场景覆盖与真实入口连接须核实后才能判该条通过。 |
| AC-6 隔离后端不可用不启动命令 | 行为回归关联 | 相关回归已定位；逐场景覆盖与真实入口连接须核实后才能判该条通过。 |

### shell/process-list

规范：.bb-spec/docs/spec/shell/process-list.md。生产入口：runtime/shell-page.ts。

关联证据：tests/shell-ui.test.ts、tests/shell-registry.test.ts、tests/integration/agents-panel.test.ts。

| 验收 | 证据分类 | 核对结论 |
|---|---|---|
| AC-1 输入栏位置的管理页 | 行为回归关联 | 相关回归已定位；逐场景覆盖与真实入口连接须核实后才能判该条通过。 |
| AC-2 每行归属可辨且按键不串界面 | 行为回归关联 | 相关回归已定位；逐场景覆盖与真实入口连接须核实后才能判该条通过。 |
| AC-3 详情只读且无冗余操作 | 行为回归关联 | 相关回归已定位；逐场景覆盖与真实入口连接须核实后才能判该条通过。 |
| AC-4 长列表空态与异常不冒充其他任务 | 行为回归关联 | 相关回归已定位；逐场景覆盖与真实入口连接须核实后才能判该条通过。 |
| AC-5 停止确认与精确范围 | 行为回归关联 | 相关回归已定位；逐场景覆盖与真实入口连接须核实后才能判该条通过。 |
| AC-6 停止反馈不依赖模型 | 行为回归关联 | 相关回归已定位；逐场景覆盖与真实入口连接须核实后才能判该条通过。 |
| AC-7 刷新和失败不能导致误停 | 行为回归关联 | 相关回归已定位；逐场景覆盖与真实入口连接须核实后才能判该条通过。 |

### shell/status-entry

规范：.bb-spec/docs/spec/shell/status-entry.md。生产入口：runtime/shell-summary.ts。

关联证据：tests/shell-ui.test.ts、tests/integration/agents-panel.test.ts。

| 验收 | 证据分类 | 核对结论 |
|---|---|---|
| AC-1 所有活动 Shell 合计与位置 | 行为回归关联 | 相关回归已定位；逐场景覆盖与真实入口连接须核实后才能判该条通过。 |
| AC-2 汇总不可聚焦不抢按键 | 行为回归关联 | 相关回归已定位；逐场景覆盖与真实入口连接须核实后才能判该条通过。 |
| AC-3 不确定与读取失败不伪造计数 | 行为回归关联 | 相关回归已定位；逐场景覆盖与真实入口连接须核实后才能判该条通过。 |

### task-planning/mechanical-validation

规范：.bb-spec/docs/spec/task-planning/mechanical-validation.md。生产入口：skills/spec-docs/scripts/task-check.ts。

关联证据：tests/mechanical-validation.test.ts。

| 验收 | 证据分类 | 核对结论 |
|---|---|---|
| AC-1 正确任务稳定通过且不扩大范围 | 行为回归关联 | 相关回归已定位；逐场景覆盖与真实入口连接须核实后才能判该条通过。 |
| AC-2 不合法任务准确拒绝 | 行为回归关联 | 相关回归已定位；逐场景覆盖与真实入口连接须核实后才能判该条通过。 |
| AC-3 本次验收遗漏不能通过 | 行为回归关联 | 相关回归已定位；逐场景覆盖与真实入口连接须核实后才能判该条通过。 |

### task-planning/planning-artifacts

规范：.bb-spec/docs/spec/task-planning/planning-artifacts.md。生产入口：agents/planner.md。

关联证据：tests/planner-role.test.ts、tests/mechanical-validation.test.ts、tests/integration/default-workflow.test.ts。

| 验收 | 证据分类 | 核对结论 |
|---|---|---|
| AC-1 骨架成立后产出局部计划 | 指令契约 | 仍需核对模型在反例中的实际行为，不能把文本包含检查当作该条验收通过。 |
| AC-2 不能以形式合格掩盖不可执行 | 指令契约 | 仍需核对模型在反例中的实际行为，不能把文本包含检查当作该条验收通过。 |

### task-planning/planning-preflight

规范：.bb-spec/docs/spec/task-planning/planning-preflight.md。生产入口：daemon/requirement-agent.ts。

关联证据：tests/requirement-agent-session.test.ts、tests/run-manager.test.ts、tests/integration/default-workflow.test.ts。

| 验收 | 证据分类 | 核对结论 |
|---|---|---|
| AC-1 就绪后一次派工 | 行为回归关联 | 相关回归已定位；逐场景覆盖与真实入口连接须核实后才能判该条通过。 |
| AC-2 阻塞前提不触发空跑 | 行为回归关联 | 相关回归已定位；逐场景覆盖与真实入口连接须核实后才能判该条通过。 |

### task-planning/task-file-line-limit

规范：.bb-spec/docs/spec/task-planning/task-file-line-limit.md。生产入口：skills/spec-docs/scripts/task-check.ts。

关联证据：tests/mechanical-validation.test.ts、tests/planner-role.test.ts、tests/spec-docs-format.test.ts。

| 验收 | 证据分类 | 核对结论 |
|---|---|---|
| AC-1 整份文件计数与 200 行边界 | 行为回归关联 | 相关回归已定位；逐场景覆盖与真实入口连接须核实后才能判该条通过。 |
| AC-2 示例和成品代码块均豁免 | 行为回归关联 | 相关回归已定位；逐场景覆盖与真实入口连接须核实后才能判该条通过。 |
| AC-3 代码改动量不是行数限制对象 | 行为回归关联 | 相关回归已定位；逐场景覆盖与真实入口连接须核实后才能判该条通过。 |

### task-planning/verification-contract

规范：.bb-spec/docs/spec/task-planning/verification-contract.md。生产入口：agents/planner.md。

关联证据：tests/planner-role.test.ts、tests/mechanical-validation.test.ts、tests/role-prompts.test.ts。

| 验收 | 证据分类 | 核对结论 |
|---|---|---|
| AC-1 高风险验证方案覆盖真实行为 | 指令契约 | 仍需核对模型在反例中的实际行为，不能把文本包含检查当作该条验收通过。 |
| AC-2 缺失前提不能用模拟通过替代 | 指令契约 | 仍需核对模型在反例中的实际行为，不能把文本包含检查当作该条验收通过。 |

### workflow-data/controlled-updates

规范：.bb-spec/docs/spec/workflow-data/controlled-updates.md。生产入口：runtime/workflow-tool.ts。

关联证据：tests/workflow-tool.test.ts、tests/workflow-state.test.ts、tests/database.test.ts。

| 验收 | 证据分类 | 核对结论 |
|---|---|---|
| AC-1 局部请求与定向查询 | 行为回归关联 | 相关回归已定位；逐场景覆盖与真实入口连接须核实后才能判该条通过。 |
| AC-2 非法字段不产生部分更新 | 行为回归关联 | 相关回归已定位；逐场景覆盖与真实入口连接须核实后才能判该条通过。 |
| AC-3 两窗口过期更新保护 | 行为回归关联 | 相关回归已定位；逐场景覆盖与真实入口连接须核实后才能判该条通过。 |
| AC-4 保存异常不虚报成功 | 行为回归关联 | 相关回归已定位；逐场景覆盖与真实入口连接须核实后才能判该条通过。 |

### workflow-data/data-ownership

规范：.bb-spec/docs/spec/workflow-data/data-ownership.md。生产入口：runtime/database.ts。

关联证据：tests/sqlite-business.test.ts、tests/database.test.ts、tests/local-identity.test.ts、tests/decision-record-tool.test.ts、tests/workflow-tool.test.ts。

| 验收 | 证据分类 | 核对结论 |
|---|---|---|
| AC-1 定义内容由仓库保存 | 行为回归关联 | 相关回归已定位；逐场景覆盖与真实入口连接须核实后才能判该条通过。 |
| AC-2 推进任务不改定义也不生成决定 | 行为回归关联 | 相关回归已定位；逐场景覆盖与真实入口连接须核实后才能判该条通过。 |
| AC-3 验收报告整体保留 | 行为回归关联 | 相关回归已定位；逐场景覆盖与真实入口连接须核实后才能判该条通过。 |
| AC-4 文档与 worktree 创建前记录 | 行为回归关联 | 相关回归已定位；逐场景覆盖与真实入口连接须核实后才能判该条通过。 |
| AC-5 同仓库共享且不同归属隔离 | 行为回归关联 | 相关回归已定位；逐场景覆盖与真实入口连接须核实后才能判该条通过。 |
| AC-6 工作目录清理与 Git 不带走记录 | 行为回归关联 | 相关回归已定位；逐场景覆盖与真实入口连接须核实后才能判该条通过。 |
| AC-7 身份不明与定义改写被拒绝 | 行为回归关联 | 相关回归已定位；逐场景覆盖与真实入口连接须核实后才能判该条通过。 |
| AC-8 统一数据库与主键 | 行为回归关联 | 业务与审计数据使用 SQLite、UUIDv7；普通日志独立使用 .log 文件。 |
| AC-9 事务并发与中断 | 行为回归关联 | 相关回归已定位；逐场景覆盖与真实入口连接须核实后才能判该条通过。 |

### workflow-data/decision-append

规范：.bb-spec/docs/spec/workflow-data/decision-append.md。生产入口：runtime/decisions.ts。

关联证据：tests/decision-ledger.test.ts、tests/decision-record-tool.test.ts。

| 验收 | 证据分类 | 核对结论 |
|---|---|---|
| AC-1 回执先于行动且失败不放行 | 行为回归关联 | 相关回归已定位；逐场景覆盖与真实入口连接须核实后才能判该条通过。 |
| AC-2 AI 与用户字段分别校验 | 行为回归关联 | 相关回归已定位；逐场景覆盖与真实入口连接须核实后才能判该条通过。 |
| AC-3 改选只追加不改历史 | 行为回归关联 | 相关回归已定位；逐场景覆盖与真实入口连接须核实后才能判该条通过。 |
| AC-4 并发和损坏保护 | 行为回归关联 | 相关回归已定位；逐场景覆盖与真实入口连接须核实后才能判该条通过。 |

### workflow-data/state-transitions

规范：.bb-spec/docs/spec/workflow-data/state-transitions.md。生产入口：runtime/workflow-state.ts。

关联证据：tests/workflow-state.test.ts、tests/workflow-tool.test.ts、tests/integration/default-workflow.test.ts。

| 验收 | 证据分类 | 核对结论 |
|---|---|---|
| AC-1 状态集合不可扩张 | 行为回归关联 | 相关回归已定位；逐场景覆盖与真实入口连接须核实后才能判该条通过。 |
| AC-2 阶段检查随形状逐项核对 | 行为回归关联 | 相关回归已定位；逐场景覆盖与真实入口连接须核实后才能判该条通过。 |
| AC-3 证据只按运行身份读取 | 行为回归关联 | 相关回归已定位；逐场景覆盖与真实入口连接须核实后才能判该条通过。 |
| AC-4 子运行与任务完成分离 | 行为回归关联 | 相关回归已定位；逐场景覆盖与真实入口连接须核实后才能判该条通过。 |
| AC-5 阶段回退带理由与决定编号 | 行为回归关联 | 相关回归已定位；逐场景覆盖与真实入口连接须核实后才能判该条通过。 |
| AC-6 拒绝与重开有依据 | 行为回归关联 | 相关回归已定位；逐场景覆盖与真实入口连接须核实后才能判该条通过。 |

### workflow-data/version-bound-recovery

规范：.bb-spec/docs/spec/workflow-data/version-bound-recovery.md。生产入口：runtime/workflow-state.ts。

关联证据：tests/workflow-state.test.ts、tests/integration/control-and-resume.test.ts、tests/main-session-skills.test.ts。

| 验收 | 证据分类 | 核对结论 |
|---|---|---|
| AC-1 流程从本机定位进度 | 行为回归关联 | 相关回归已定位；逐场景覆盖与真实入口连接须核实后才能判该条通过。 |
| AC-2 不同版本不共享通过结论 | 行为回归关联 | 相关回归已定位；逐场景覆盖与真实入口连接须核实后才能判该条通过。 |
| AC-3 未停止不重派 | 行为回归关联 | 相关回归已定位；逐场景覆盖与真实入口连接须核实后才能判该条通过。 |
| AC-4 缺失和损坏不冒充完成 | 行为回归关联 | 相关回归已定位；逐场景覆盖与真实入口连接须核实后才能判该条通过。 |


## .log 存储验证与收尾

用户已确认普通运行日志使用 .log。每次启动以 UUIDv7 建立独立文件，排他追加、权限 0600；标准输出和标准错误由守护进程持有文件描述符，窗口退出后继续写入。启动反馈只读取本次文件末尾最多 4096 字节。业务状态、决策审计、会话与结构化失败详情仍使用 SQLite。

- 新日志文件行为先在旧实现上因未生成 logs 目录失败，替换实现后定向 3 项通过。
- 守护进程客户端与生命周期、用户文档、SQLite 业务存储及 Node 可剥离语法回归：132 通过、0 失败，5 个文件，346 条断言，133.49 秒。
- 严格类型检查、全部 42 份规范机械检查与 diff 空白检查通过；本轮未重新执行整个项目测试集合。
- 删除 SQLite 日志写读模块与标准错误拦截；检查无剩余导入、环境变量或模块引用。
- diff 范围限日志存储、对应测试与规范、计划、用户文档，没有新增兼容模式或双写来源；未提交或推送。
- 临时产物 log-red.log、log-green.log、log-regression.log、spec-lint.log 及测试临时仓库和数据均已清理；缓存仅保留 .gitignore。本轮无守护进程残留，用户原有后台进程未操作。

此验证只关闭日志存储事项；共享 Git 的提交范围与切换保护仍未通过整个项目验收。

本轮验证结果：相关范围、Shell、角色、运行管理和集成回归 220 项通过、0 失败（8 文件，796 条断言，151.02 秒）；文档与 Node 可剥离语法回归 149 项通过、0 失败（3 文件，228 条断言）。最终路径解析与现场核对收口后，共享 Git 专项、默认工作流及 SDK 装载 14 项通过、0 失败（3 文件，237 条断言，38.21 秒）。严格类型检查、修改的 2 份规范机械检查及 diff 空白检查通过。本轮未重跑整个项目测试集合，未提交或推送。

## 当前命令与数据入口验证

全部会话命令统一使用 /pi-company: 前缀；用户可见文字按检查的用途说明审查、验收或阶段检查。工作流工具仅提供当前动作和参数，数据转换入口、实现、对应测试及规范不属于当前功能。

现行规范总数为 41，验收条件总数为 193。命令、文档、工作流与 SDK 装载定向回归 320 项通过、0 失败；类型检查和全部规范格式检查通过。项目总验收结论仍依照逐项证据，不以测试总数代替。

完整回归执行 68 个文件、2355 项：2354 通过、1 失败，16965 条断言，耗时 480.26 秒。唯一失败是 tests/rebuild-delivery.test.ts 中仍要求普通 Shell 执行提交的断言。测试使用专用提交工具，并通过 git show 验证真实提交内容后，该文件复测 7 项通过、0 失败，20 条断言，耗时 4.74 秒。该修正未改变生产权限规则；没有重新执行完整测试集合，因此不记录为单轮全量通过。

临时日志、清单、测试仓库和缓存已清理，缓存仅保留 .gitignore；本轮测试残留进程已停止，用户原有后台进程未操作。逐条验收及只被测试调用的旧守卫清理仍待完成。
