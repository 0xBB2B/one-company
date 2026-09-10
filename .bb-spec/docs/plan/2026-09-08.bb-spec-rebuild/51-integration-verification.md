---
name: integration-verification
description: 真实守护进程与多窗口子进程的端到端验证矩阵：派出与中继、控制与续接、断网与睡眠、宿主退出、底部键盘流、多仓库工作区
---
# 集成验证

## 目标
完成后，一组可重复运行的集成测试用真实守护进程、真实子进程与受控模型证明各规范的端到端行为，作为全部任务完成后的统一集成验证与黑盒验收的前置证据。

## 业务规则（来源：spec）
- daemon-host：每仓库单实例、按需拉起、空闲退出、崩溃后中断、睡眠不计入超时。
- requirement-agent / workflow-shape / user-relay：派出前提、形状提议确认、提问投递本工作区窗口首答生效、无窗口排队推送、代理间不直连。
- pause-control / user-stop / run-lifecycle：任意窗口暂停继续停止、级联、断网局部暂停与联网自动续接并通知、中断续接核对与重载。
- cross-window-panel / transcript-view / status-entry / process-list：底部顺序、空输入 ↓ 直接进面板、20 秒保留、查看页只读、状态栏汇总文本与 /ps 跨宿主。
- host-lifecycle / managed-execution：窗口退出路径清理窗口 Shell、守护进程 Shell 不受影响、后台 Shell 超时与后代清理。
- workspace-coordination：父目录窗口看到两个仓库、契约变更经主会话裁定并转发。

## 涉及文件
- 新建 `tests/integration/default-workflow.test.ts`
- 新建 `tests/integration/repair-authorization.test.ts`
- 新建 `tests/integration/settings-dispatch.test.ts`
- 新建 `tests/integration/daemon-dispatch-relay.test.ts`
- 新建 `tests/integration/control-and-resume.test.ts`
- 新建 `tests/integration/network-and-sleep.test.ts`
- 新建 `tests/integration/host-exit.test.ts`
- 新建 `tests/integration/agents-panel.test.ts`
- 新建 `tests/integration/workspace.test.ts`
- 修改 `package.json` — `test:integration` 脚本（`bun test tests/integration`）

## 函数清单
无新增生产代码。测试助手复用：`createTempHome`、`createRepoFixture`、`registerControlledProvider`、`startDaemonForTest`、`connectTestClient`、`renderComponent`。每个测试文件的用例矩阵如下。

### daemon-dispatch-relay
| 用例 | 入口 | 输入 | 预期 |
|---|---|---|---|
| 单实例与拉起 | 两个窗口子进程同时连接 | 守护进程未运行 | 只有一个守护进程；两次连接成功 |
| 派出前提 | `pi_company_dispatch` | 需求 draft / confirmed / 已有活动代理 | 拒绝 / 成功 / 返回已有运行身份 |
| 形状提议确认 | 受控模型让需求代理调用 `pi_company_propose_shape` | 用户在窗口 A 以 `pi_company_reply` 确认 | 确认前无角色运行；确认后按形状派出 worker |
| 首答生效 | 需求代理 `pi_company_ask` | 窗口 A、B 同仓库，工作区外窗口 C | A、B 收到，A 作答后 B 撤回，C 从未收到 |
| 离线排队 | 关闭全部窗口后提问与完成通知 | 打开新窗口 | 各推送一次且顺序一致 |
| 代理间不直连 | 需求代理尝试向另一需求代理发消息 | 两个需求代理 | 被拒绝并未送达 |

### control-and-resume
| 用例 | 入口 | 输入 | 预期 |
|---|---|---|---|
| 跨窗口暂停继续 | 窗口 B `pi_company_agents pause/resume` | 窗口 A 派出的运行 | 确认后才显示已暂停；继续保留上下文 |
| 级联停止 | `pi_company_agents stop` 需求代理 | 两个角色各有后台 Shell | 停止请求发出即确认运行终态；Shell 清理独立展示，未清理前禁止重叠写入；文件保留 |
| 中断续接 | 强杀守护进程后 `resumeInterrupted` | SQLite 会话记录存在 | 标记中断；续接从 SQLite 会话记录重载，未重做已完成步骤 |
| 停止不确定 | 角色启动脱管后代 | 停止 | 显示不确定原因，不派出重叠新运行 |

### network-and-sleep
| 用例 | 入口 | 输入 | 预期 |
|---|---|---|---|
| 断网局部暂停 | 受控 provider 抛连接错误 | 另一本地任务运行中 | 只有受影响运行进入 paused_network |
| 故障分类 | 受控 provider 分别抛认证、额度、业务错误 | — | 不进入网络暂停，保持真实类别 |
| 联网自动续接 | 探测恢复（注入探测器） | 一个网络暂停、一个手动暂停 | 网络暂停者核对后自动继续并通知主会话；手动暂停者保持 |
| 睡眠不计超时 | 注入 5 分钟时钟跳变 | 60 秒超时后台 Shell、空闲计时、心跳 | 未超时、未空闲退出、未判失联 |

### host-exit
| 用例 | 入口 | 输入 | 预期 |
|---|---|---|---|
| 窗口 /quit | 窗口子进程执行 /quit | 主会话后台 Shell + 守护进程角色 Shell | 窗口 Shell 及后代停止；守护进程 Shell 继续 |
| 可处理信号 | 向窗口发送挂断与终止信号 | 同上 | 同上 |
| 真实关窗 | 用伪终端启动窗口并关闭伪终端 | 同上 | 同上；不以关闭输入通道替代 |
| 守护进程正常退出 | `shutdown` 方法 | 角色 Shell 运行中 | 守护进程内 Shell 全部停止后退出 |
| 后台超时 | `background: true, timeout: 1` 产生后代 | — | 满 1 秒开始停止，后代清理确认后报告超时 |

### agents-panel
| 用例 | 入口 | 输入 | 预期 |
|---|---|---|---|
| 顺序与导航 | VirtualTerminal 渲染 | 空输入按 ↓、Esc | ↓ 直接进面板，Esc 回输入栏；原状态栏与汇总文本可见，汇总文本不可选中 |
| 不抢按键 | 输入非空 / 设置页打开时按 ↓ | — | 面板不响应 |
| 查看页 | 面板"查看"Enter | 运行中会话 | 替换输入栏、实时跟随、Esc 回原选中 |
| 20 秒保留 | 结束运行与操作失败提示 | 注入时钟 19 秒、20 秒 | 19 秒仍在，20 秒移出 |

### workspace
| 用例 | 入口 | 输入 | 预期 |
|---|---|---|---|
| 可见范围 | 父目录窗口 / 仓库内窗口 / 无关窗口 | 两个仓库各有需求代理 | 父目录看两者；仓库内只看自己；无关看不到 |
| 契约变更 | 后端需求代理 `pi_company_ask` 契约变更 | 主会话裁定后 `pi_company_forward` | 前端需求代理收到补充；直连被拒 |
| 跨仓库等待 | 形状声明等待后端 accepted | 后端未通过 / 通过 | 等待并显示原因 / 核对后执行 |

## 协作关系
- 依赖全部前序 plan 的产物；集成测试不 mock 守护进程、子进程与套接字，只用受控模型与注入时钟。

## 验证方式
- 测试入口：`bun test tests/integration`
- 测试输入：上述矩阵；每个用例在独立临时 HOME 与临时仓库内执行，结束后清理守护进程与子进程
- 预期结果：全部用例通过；进程列表无残留守护进程、窗口子进程或 Shell 后代；临时目录被删除
- [x] 全部集成测试文件通过
- [x] 无进程残留（用例结束后按 token 扫描进程列表为零）
- [x] 全量 `bun test tests` 通过

## SQLite 与完整默认流程补充验收

- `default-workflow.test.ts` 使用真实 SDK、默认角色、真实 Git 和 SQLite，覆盖前检决定、planner 写任务并通过机械检查、用户形状确认、worker 红绿验证和提交、系统独立复跑、系统快照审查、真实黑盒命令与报告、accepted 自动终结。仅模型响应受控。
- `control-and-resume.test.ts` 从真实派工创建 queued 运行，强杀守护进程后恢复同一 UUIDv7，拒绝重复续接，父运行和跨仓依赖未恢复时不启动，取消后不复活。
- `rebuild-delivery.test.ts` 验证复跑期间内容变化拒绝、linked worktree 正常提交、命令不继承认证环境变量、只读角色不能改源码、跨仓访问拒绝。
- `workflow-state.test.ts` 用 SQLite 写入失败证明阶段与证据一起回滚，交错失效不能被旧绑定覆盖。
- `session-records.test.ts` 验证分支与重置位置、压缩恢复、当前分支中断补全、竞争写入拒绝和保存失败后的停止。

- `repair-authorization.test.ts` 经真实中继答复和公开审查派工入口验证门禁三轮后阻塞，拒答不授权；授权仅对指定门禁与轮次有效，改名重派不重置计数。
- `settings-dispatch.test.ts` 在真实设置页保存全局与项目模型，再验证实际 SDK 请求使用对应模型；项目角色正文仅在项目受信任时装载。

- `agents-panel.test.ts` 在派工之后才打开面板，验证订阅快照让已有运行立即可见。
