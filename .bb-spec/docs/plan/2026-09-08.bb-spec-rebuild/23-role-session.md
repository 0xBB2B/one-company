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
| `checkToolCall` | 校验工具在白名单内、写路径在 writePaths 且经 write-guard `checkWrite` 未被他人占用、读路径在 readPaths、MCP 服务在集合内、暂停后核对期只放行只读工具 |
| `withStreamIdleTimeout` | 包装模型流：两块数据之间的间隔（用 `runtime/clock.ts` 扣除睡眠间隔）超过阈值即中止该请求并抛连接故障错误，交由 `runtime/network-pause.ts` 的分类走网络暂停。实施前先核实 SDK 模型请求层是否已提供可配置的流空闲超时：已有则只配置该选项并把其错误映射到同一分类，不重复实现 |
| `guardReadOnlyBash` | 对审查者与验收者会话的每条 bash：执行前后用 write-guard 的工作区指纹函数核对（验收者的指定报告路径除外），有任何写入即把该运行判失败并记违规，结束会话 |
| `trackActiveTools` | 维护在飞工具集合，供暂停确认与静止判据 |
| `RoleSessionHandle.prompt` | 发送任务提示，不等待完成 |
| `RoleSessionHandle.pause` | 阻止新操作、收回排队消息、abort 会话并停止其 Shell，返回确认或不确定 |
| `RoleSessionHandle.resume` | 以续跑提示（含不明操作清单与排队消息）恢复 |
| `RoleSessionHandle.stop` | 终止会话、停止 Shell，返回 Shell 清理结果 |
| `RoleSessionHandle.dispose` | 释放会话与监听，暂停态禁止释放 |

## 协作关系
`daemon/run-manager.ts` 调用 `createRoleSession` 并订阅其事件流投影为 `activity`/`transcript` 事件；`runtime/result.ts` 的 `ResultCollector` 接收提交完成事件；`runtime/shell-bash.ts` 提供 managed bash；`runtime/mcp.ts` 的 `loadMcpForRole` 在子扩展内装载；`runtime/session-records.ts` 提供会话管理器；`runtime/network-pause.ts` 的闸门在每次请求前检查、其分类接收流空闲超时错误；`runtime/write-guard.ts` 提供 `checkWrite` 与工作区指纹函数，由本单元在工具调用钩子接入。是否为审查者/验收者按派工时传入的角色名判定，不看定义 kind。

## 验证方式
- 测试入口：`createRoleSession` 返回的句柄与事件流；受控 provider 脚本化模型行为（不联网），可控制流分块间隔；可控时钟
- 测试输入：worker 定义（工具 read/bash/edit/write）；脚本让模型依次读范围外文件、写范围外文件、写他人占用文件、调用未勾选 MCP、写范围内文件、提交结构化对象、提交后再次提交；另一脚本在写入中途被暂停后继续并尝试直接再次写入；流在两块之间停滞超过阈值，另一次停滞期间注入等长睡眠间隔；reviewer 会话执行 `git status` 与 `echo x >> src/a.ts`；acceptance 会话执行写入指定报告路径的命令与写入其他路径的命令
- 预期结果：范围外读写、他人占用文件与集合外 MCP 被拒绝且会话继续；范围内写入成功；首个提交被接受且会话终止，第二次提交报错；暂停确认后无新写入，继续时提示含不明操作，核对前的直接写入被拒、只读检查放行；真实停滞被判连接故障并进入 paused_network，睡眠期间的停滞不触发；reviewer 的只读命令放行、写入命令后运行 failed 且违规记录含 `src/a.ts`；acceptance 写报告路径放行、写其他路径判失败；会话文件在运行目录且不含凭据；两个角色会话同进程互不串上下文
- [ ] 工具、范围与占用拦截
- [ ] MCP 集合约束
- [ ] 唯一结构化提交
- [ ] 流空闲超时与睡眠扣除
- [ ] 只读角色写入失败关闭
- [ ] 暂停、核对、继续
- [ ] 隔离与落盘
