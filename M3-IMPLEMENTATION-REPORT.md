# M3 实施记录

## 当前状态

M3（文件同步、prod 事件与关闭撤销通知）正在恢复现场与拆分任务，尚未实现或验收完成。本文件由主代理统一更新，记录已发生的事实，不替代 `SQLITE-KNOWLEDGE-REBUILD-PLAN.md`。

## 基线与保护范围

- 工作目录：`/Users/bb/.bb-spec/worktrees/pi-spec-bb-spec-rebuild`；分支：`bb-spec-rebuild`；起始 HEAD：`2ead578`。
- 已完整读取磁盘 `AGENTS.md`（82 行）和计划（1594 行）。计划 SHA-256：`fb1e28167334eee232da7e7e3715e162b147b44cc1f085c6700a978a9900d956`。
- 原未跟踪文件：`.pi/agents/{Explore,Plan,general-purpose}.md`、`.pi/npm/.gitignore`、`.pi/settings.json`、`.pi/subagents.json`，不纳入本轮提交。
- 旧 PID 52973（`tests/helpers/window-runner.ts /tmp/wr-manual3-QNjx/config.json`）和 53030（旧 Node 26.8.1 daemon）仍运行，保持原状；本轮仅使用独立临时数据根验证，不向旧进程派工或覆盖真实数据库。
- 当前 Node 26.8.2、pnpm 11.7.0；从当前模型配置只提取 provider/model ID，确认 `5x/gpt-5.6-sol` 与 `5x/gpt-6-astra` 已登记，未读取或记录密钥。实际派工模型仍须逐次核对运行回执。
- M0/M1 当前完成结论与相应提交及当前源码路径已核对。M2 的 262 项最终验证输入与现代码相比，仅 `runtime/project-index-policy.ts` 有报告中已登记的未调用函数清理差异；实际 hash 为 `08482c9ab705e218a907f7bc66782aa20b081bfea0597d73f0428f2eaf6630f0`。M2 两 Node 的 typecheck/full/integration/installation 八份 `.exit` 均为 0；旧完整 PASS 不换绑清理后字节。
- M2 未提供 watcher/dirty、自动对账、可靠 prod 消费及聊天基线通知；M3 是首个未完成阶段。M4—M9 不在本窗口实施范围。

## 事件记录（按发生顺序追加）

### 2026-09-12T16:54Z · M3-RECOVER-01 · 主代理恢复现场

- 已核对上述工作区、提交、报告、原进程与模型配置；完整读取 M3 及关联设计 §5.4—5.7、§6.4—6.5、§7、§8、§9.4—9.5、§13 的原文。
- 结果：进入 M3 规划；尚无实现派工、执行失败或功能提交。
- 下一步：只读定位现有索引、需求事件及宿主通知接缝，主代理据实际接口拆分有边界的实现任务。

### 2026-09-12T16:55Z · M3-SCOUT-01 · 已派只读调研

- 代理 ID：`39c25527-3415-4a5`；范围：daemon 生命周期/多窗口通信、需求事件与 PM 消费、宿主基线失效接口；禁止写文件及递归派工。
- 显式配置 `5x/gpt-5.6-sol`；实际 session `2026-09-12T16-55-23-055Z_01a0968b-8caf-70fd-9482-0f0073ba1c30.jsonl` 的 `model_change` 已核对为同一 provider/model。
- 状态：运行中，尚无结果。主代理独立读取 `ProjectIndexService`/`IndexStore`，不重复代理调研范围。
- 另一个 16:50:42 宿主 session 的末条记录已为 `stop`，没有据此接管或停止其他会话；旧 PID 继续保留。

### 2026-09-12T16:57Z · M3-BASELINE-01 · 主代理基线验证

- 在未改动生产代码和测试时执行 `pnpm run typecheck`：exit 0。
- 执行 `pnpm exec vitest run tests/project-index-policy.test.ts tests/index-store.test.ts tests/project-index-service.test.ts tests/requirement-state.test.ts tests/requirement-service.test.ts`：5 文件、91/91，exit 0，45.02 秒。
- 证据：`/tmp/m3-verification-wTYp57/logs/baseline-{typecheck,targeted}.{log,exit}`，目录权限 0700；这仅是 M3 开工基线，不代表 M3 验收通过。
- 当前没有代码实现尝试失败；下一步仍为主代理完成接口拆分。

### 2026-09-12T16:58Z · M3-SYNC-01 · 第一次实现派工

- 代理 ID：`3da2c831-1aa0-4da`；配置及实际模型为 `5x/gpt-5.6-sol`，运行元数据：session `2026-09-12T16-58-49-104Z_01a0968e-b190-70fd-9482-0f0255732722.jsonl` 的 `model_change`。
- 允许范围：新增 `runtime/project-index-sync.ts`、对应测试，以及必要的 `project-index-service.ts`、`index-store.ts`、`project-index-policy.ts` 及其测试；不改宿主/daemon/需求服务/记录文件/依赖。
- 目标：基于 M2 安全扫描与内容指纹实现 dirty、watch/debounce、有界串行对账、读取前新鲜度、错误恢复与资源收尾；为后续 daemon 单实例及优先归档风险处理提供接口。对应 M3-AC1/2/3/9 的内核部分，不宣称已覆盖宿主闭环。
- 基线依赖：91项测试与typecheck通过；实现结果尚未返回，失败计数0。日志约定 `logs/m3-sync-01-*`。
- 下一步：代理实现与任务内验证，主代理继续拆分不冲突的需求事件任务；返回后独立核对实际差异。

### 2026-09-12T17:03Z · M3-HOST-PREP-01 · 主代理接口准备

- 已完整读取实际宿主 `docs/extensions.md`、其相关 `docs/session-format.md`，以及 `examples/extensions/file-trigger.ts`、`event-bus.ts`；确认 `sendMessage` 的 steering 只在安全边界送达，不能声称刷新正在进行的推理；工厂不应启动后台资源，session_shutdown 必须释放。
- 全局宿主与项目锁定 SDK 均为 0.85.1，extensions 文档逐字节一致。
- 已保存 270 项跟踪文件指纹至 `logs/opening-tracked-source.json`；保存时生产代码和测试仍无 diff。模型证据仅含 provider/model ID，见 `logs/agent-model-evidence.json`。
- 结果：主代理可据实际 API 规划聊天基线通知；尚未派出宿主实现任务。

### 2026-09-12T17:03Z · M3-SCOUT-01 · 收到结果并核对

- 只读调研已结束，无代码修改。主代理随后读取 `requirement-state.ts` 的批准/租约/事件/关闭方法、`requirement-contracts.ts` 全文及 `requirement-service.ts` read/diff，确认准确批准提交对和 seenSequence 基础存在。
- 采纳边界：新 UUID 需求不能接入仍使用旧 WorkflowState 的 PM 调度；M3 提供受有效 PmLease 约束的消费接缝，完整调度仍属 M7。索引同步应复用单 daemon，多窗口不能各建 watcher。
- 审查修正：不能把关闭排在慢正文读取后；正文采用操作中及实际交付前版本/epoch/授权检查，撤权优先。

### 2026-09-12T17:03Z · M3-EVENT-01 · 第一次实现派工

- 代理 ID：`c4228b36-3207-44c`；配置及实际模型 `5x/gpt-5.6-sol`，session `2026-09-12T17-03-48-627Z_01a09693-4393-70fd-9482-0f04014f45c6.jsonl` 已核对并追加 `logs/agent-model-evidence.json`。
- 允许范围：新增 `runtime/requirement-events.ts` 及测试，必要的 requirement-contracts/state/service 及对应测试；与索引代理无文件重叠。
- 目标：有效租约下可靠事件读取/投递/消费、持久理解基线、准确批准提交 diff、归档元数据风险先撤权、实际正文返回守卫。对应 M3-AC4/5/6/8 基础；不新增旧 PM 派工、不解除 pendingRevision、不实现 M7。
- 状态：运行中，结果未返回，失败计数0；证据约定 `logs/m3-event-01-*`。下一步主代理读取 daemon 接缝，准备后续宿主集成。

### 2026-09-12T17:07Z · M3-TRANSPORT-01 · 第一次实现派工

- 主代理已完整读取 `daemon/server.ts`、`daemon/lifecycle.ts`、`runtime/protocol.ts`，核对客户端连接/重连及现有 project_manage 的单次授权生命期。
- 代理 ID：`ba9f26ef-832a-471`；配置及实际模型 `5x/gpt-5.6-sol`，session `2026-09-12T17-07-05-392Z_01a09696-4430-70fd-9482-0f07a0bbf461.jsonl` 已核对。
- 允许范围：`daemon/server.ts`、`runtime/daemon-client.ts`、对应连接测试。补幂等认证连接断开回调、阻止迟到 hello、客户端本地连接状态通知，供后续单 daemon 引用计数和授权订阅重建使用；不自动重放写操作。
- 状态：运行中，结果未返回，失败计数0；日志约定 `logs/m3-transport-01-*`。与索引和需求代理文件范围不冲突。
- 下一步：主代理待接口与结果交付后审查整合，宿主/daemon同步接线尚未实施。
