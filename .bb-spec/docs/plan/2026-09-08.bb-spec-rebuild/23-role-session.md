---
name: role-session
description: 守护进程内角色子会话：角色提示、工具白名单、读写路径与占用校验、MCP 集合装载、结构化提交工具、模型流空闲超时、只读角色 bash 前后工作区指纹核对、暂停后只读核对、会话文件
---
# 角色子会话

## 目标
完成后需求代理能在守护进程内为角色目录中的任一角色创建独立会话，会话只拥有该角色的工具、范围与 MCP 集合，模型流停滞被判为连接故障而非无限等待，审查者与验收者的任何写入在命令层被判失败，按格式提交唯一结构化结果并完整落盘。

## 业务规则（来源：spec）
- role-catalog：角色来自三层定义文件；定义损坏的角色不可用。
- builtin-execution：每次派工是独立会话，返回运行身份；模型服务不可用时如实报告错误。
- role-settings：角色只获得其配置中勾选且当前可用的服务，发现、查看、调用入口同受集合约束；缺失服务只阻塞依赖它的任务；MCP 不改变角色的读写边界。
- structured-verdict：角色按调用方格式提交唯一对象，必须作为最后一个动作。
- pause-control：继续时结果不明的操作先只读核对，不盲目重复副作用；网络故障走网络暂停并自动续接。
- whitebox-review / blackbox-acceptance：审查者只读不改代码；验收者只写指定报告；边界由命令层执行而非仅靠提示。
- session-records：会话文件落运行目录并原样保存。
- daemon-host：凭据不进提示；超时扣除睡眠间隔。

## 涉及文件
- 新建：`daemon/role-session.ts`
- 新建：`tests/role-session.test.ts`

## 函数清单
### daemon/role-session.ts
| 函数 | 职责 |
|---|---|
| `createRoleSession` | 组装设置、模型运行时（经 `withStreamIdleTimeout` 包装）、资源加载器、会话管理器与工具集，创建角色会话并返回控制句柄 |
| `buildRolePrompt` | 由角色定义正文、任务说明、读写范围、结构化格式说明、MCP 缺失说明拼装系统提示 |
| `configureRoleExtension` | 作为子扩展工厂：注入系统提示、注册 `structured_output`、装载 MCP、挂 `tool_call` 与工具执行事件 |
| `registerStructuredOutput` | 注册提交工具，校验后标记 terminate，二次调用抛错 |
| `checkToolCall` | 校验工具在白名单内、写路径在 writePaths 且经注入的占用核对 `occupancy.checkWrite(path)` 未被他人占用（缺省由 `runtime/ranges.ts` 的 `holderOf` 实现）、读路径在 readPaths、MCP 服务在集合内、暂停后核对期只放行只读工具 |
| `withStreamIdleTimeout` | 包装模型流：两块数据之间的间隔（用 `runtime/clock.ts` 扣除睡眠间隔）超过阈值即中止该请求并抛连接故障错误，交由 `runtime/network-pause.ts` 的分类走网络暂停。实施前先核实 SDK 模型请求层是否已提供可配置的流空闲超时：已有则只配置该选项并把其错误映射到同一分类，不重复实现 |
| `guardReadOnlyBash` | 对审查者与验收者会话的每条 bash：执行前后用注入的工作区指纹函数核对（验收者的指定报告路径除外），有任何写入即把该运行判失败并记违规，结束会话；性能上排除 `.git` 与 `node_modules` 整体，但以 git 元数据真实落点（`git rev-parse --path-format=absolute --git-common-dir` 与 `--git-dir`，兼容 linked worktree 下 `.git` 为文件的形态；并读取当前 `core.hooksPath` 决定实际 hooks 目录，相对值按工作树顶层解析）定点纳入 `<common>/hooks/`、`<common>/info/attributes`、`<common>/info/exclude`、`<git-dir>/config.worktree`、`node_modules/.bin/`；对 git 配置做全量指纹（不带作用域参数的 `git config --list` 合并视图，一次调用同时覆盖 local 与 global 改动，只豁免 `core.untrackedCache`、`remote.*.promisor`、`remote.*.partialclonefilter` 这类不可执行的 git 自写良性键），任何其它键值变化即违规；命令窗口期内第三方进程并发写配置会被算到本会话头上，属前后比对的固有误判面 |
| `trackActiveTools` | 维护在飞工具集合，供暂停确认与静止判据 |
| `RoleSessionHandle.prompt` | 发送任务提示，不等待完成；模型结束回合而未提交时会话保持 running 并发出 `idle` 事件（供派工方续 prompt、投递答复或裁定等待答复），不视为运行结束 |
| `RoleSessionHandle.finalize` | 派工方宣告不再追加输入：已提交则 completed，未提交则 failed（原因含未提交）并结算 result |
| `RoleSessionHandle.pause` | 阻止新操作、收回排队消息、abort 会话（注入时钟 5 秒超时）并**无论 abort 是否确认都** `stopHost` 停止其 Shell，`confirmed` 由 abort 确认与 Shell 停止结果合成，返回确认或不确定及原因 |
| `RoleSessionHandle.resume` | 以续跑提示（含不明操作清单与排队消息）恢复；核对期由工具级拦截保障（未做只读核对前有副作用工具一律拒绝），模型在核对期内自然结束回合时照常结算，系统不自动追加核验提示 |
| `RoleSessionHandle.stop` | 用户停止：先置 `stopped` 终态再 abort 会话（abort 产生的取消错误不再被当作运行失败），停止 Shell 并返回真实清理结果；保留已产生的成果与记录，不判为通过也不判为失败；已处于终态时不重复结算，仍执行并如实返回 Shell 清理结果 |
| `RoleSessionHandle.dispose` | 释放会话与监听，暂停态禁止释放 |

## 协作关系
`daemon/run-manager.ts` 调用 `createRoleSession` 并订阅其事件流投影为 `activity`/`transcript` 事件；`runtime/result.ts` 的 `ResultCollector` 接收提交完成事件；`runtime/shell-bash.ts` 提供 managed bash；`runtime/mcp.ts` 的 `loadMcpForRole` 在子扩展内装载；`runtime/session-records.ts` 提供会话管理器；`runtime/network-pause.ts` 的闸门在每次请求前检查、其分类接收流空闲超时错误；占用核对与工作区指纹经 `createRoleSession` 的 `guards` 选项注入（必填，缺省实现由 40 write-guard 提供）；`shellRegistry`（仓库级共享的 ShellRegistry，由守护进程持有并传入，供 /ps、退出清理与孤儿接管跨会话使用）与 `networkGate` 同为必填注入，不在会话内自建。是否为审查者/验收者按派工时传入的角色名判定，不看定义 kind；所有角色（含审查者与验收者）在 finalize 时无结构化提交即判失败并结算；stop 一律结算为用户停止（`stopped`），与 completed/failed 并列为终态；三种终态都要停止本运行的 Shell；abort 产生的取消类错误按取消归类，不冒充业务失败；回合结束不等于运行结束。

## 验证方式
- 测试入口：`createRoleSession` 返回的句柄与事件流；受控 provider 脚本化模型行为（不联网），可控制流分块间隔；可控时钟
- 测试输入：worker 定义（工具 read/bash/edit/write）；脚本让模型依次读范围外文件、写范围外文件、写他人占用文件、调用未勾选 MCP、写范围内文件、提交结构化对象、提交后再次提交；另一脚本在写入中途被暂停后继续并尝试直接再次写入；流在两块之间停滞超过阈值，另一次停滞期间注入等长睡眠间隔；reviewer 会话执行 `git status` 与 `echo x >> src/a.ts`；acceptance 会话执行写入指定报告路径的命令与写入其他路径的命令
- 预期结果：范围外读写、他人占用文件与集合外 MCP 被拒绝且会话继续；范围内写入成功；首个提交被接受且会话终止，第二次提交报错；worker/reviewer/acceptance 任一角色在 finalize 时未提交即 failed 且原因含未提交；模型结束回合未提交时发出 idle 事件、state 仍 running、不产生额外模型请求，第二轮 prompt 后提交即 completed；核对期内模型只回文字结束回合时同样只发 idle；暂停确认后无新写入，继续时提示含不明操作，核对前的直接写入被拒、只读检查放行；真实停滞被判连接故障并进入 paused_network，睡眠期间的停滞不触发；reviewer 的只读命令放行、写入命令后运行 failed 且违规记录含 `src/a.ts`；写 .git/hooks/、node_modules/.bin/、执行 `git config core.hooksPath <外部目录>`、`credential.helper`、`core.sshCommand`、`filter.*.clean` 都判 failed，readPaths 为子树时仍如此，cwd 为 linked worktree 时写主仓 hooks 同样判 failed，`git status` 自写 core.untrackedCache 不误判；pause 显式调用 stopHost（经注入 probes 的 kill 记录可观测）；pause 的 abort 超时也停止 Shell；stop 返回注入 ShellRegistry 的真实清理结果（测试经注入 probes 制造不确定，不改全局 process.kill）；acceptance 写报告路径放行、写其他路径判失败；会话文件在运行目录且不含凭据；两个角色会话同进程互不串上下文；运行中 stop 后终态为 stopped、失败事件不含 abort 文本、result 不结算为通过；已提交后 stop 同样为 stopped 且不判通过；completed/failed 后本运行的后台 Shell 已被停止且注册表中该任务已为终态（记录保留供 /ps 显示真实结束状态）、其后再调 stop 返回真实清理结果而非恒 true；`git config --global core.hooksPath <外部目录>` 判 failed；cwd 为子目录时相对 `core.hooksPath` 按工作树顶层定位
- [ ] 工具、范围与占用拦截
- [ ] MCP 集合约束
- [ ] 唯一结构化提交
- [ ] 流空闲超时与睡眠扣除
- [ ] 只读角色写入失败关闭
- [ ] 暂停、核对、继续
- [ ] 隔离与落盘
