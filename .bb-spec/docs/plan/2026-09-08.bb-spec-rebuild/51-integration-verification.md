---
name: integration-verification
description: 真实守护进程与多窗口子进程的端到端验证矩阵：派出与中继、控制与续接、断网与睡眠、宿主退出、底部键盘流、多仓库工作区、迁移演练
---
# 集成验证

## 目标
完成后，一组可重复运行的集成测试用真实守护进程、真实子进程与受控模型证明各规范的端到端行为，作为全部任务完成后的统一集成验证与黑盒验收的前置证据。

## 业务规则（来源：spec）
- daemon-host：每仓库单实例、按需拉起、空闲退出、崩溃后中断、睡眠不计入超时。
- requirement-agent / workflow-shape / user-relay：派出前提、形状提议确认、提问投递本工作区窗口首答生效、无窗口排队推送、代理间不直连。
- pause-control / user-stop / run-lifecycle：任意窗口暂停继续停止、级联、断网局部暂停与联网自动续接并通知、中断续接核对与重载。
- cross-window-panel / transcript-view / status-entry / process-list：底部顺序、空输入 ↓ 导航、20 秒保留、查看页只读、汇总行与 /ps 跨宿主。
- host-lifecycle / managed-execution：窗口退出路径清理窗口 Shell、守护进程 Shell 不受影响、后台 Shell 超时与后代清理。
- workspace-coordination：父目录窗口看到两个仓库、契约变更经主会话裁定并转发。
- safe-migration：旧格式预检、停写校验、保真迁移、中断恢复。

## 涉及文件
- 新建 `tests/integration/daemon-dispatch-relay.test.ts`
- 新建 `tests/integration/control-and-resume.test.ts`
- 新建 `tests/integration/network-and-sleep.test.ts`
- 新建 `tests/integration/host-exit.test.ts`
- 新建 `tests/integration/bottom-dock.test.ts`
- 新建 `tests/integration/workspace.test.ts`
- 新建 `tests/integration/migration.test.ts`
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
| 级联停止 | `pi_company_agents stop` 需求代理 | 两个角色各有后台 Shell | 全部停止且 Shell 后代无残留后才确认；文件保留 |
| 中断续接 | 强杀守护进程后 `resumeInterrupted` | 会话文件存在 | 标记中断；续接从会话文件重载，未重做已完成步骤 |
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

### bottom-dock
| 用例 | 入口 | 输入 | 预期 |
|---|---|---|---|
| 顺序与导航 | VirtualTerminal 渲染 | 空输入按 ↓、↓、Esc | 先选汇总行再进面板，Esc 回输入栏；原状态栏可见 |
| 不抢按键 | 输入非空 / 设置页打开时按 ↓ | — | 面板不响应 |
| 查看页 | 面板"查看"Enter | 运行中会话 | 替换输入栏、实时跟随、Esc 回原选中 |
| 20 秒保留 | 结束运行与操作失败提示 | 注入时钟 19 秒、20 秒 | 19 秒仍在，20 秒移出 |

### workspace
| 用例 | 入口 | 输入 | 预期 |
|---|---|---|---|
| 可见范围 | 父目录窗口 / 仓库内窗口 / 无关窗口 | 两个仓库各有需求代理 | 父目录看两者；仓库内只看自己；无关看不到 |
| 契约变更 | 后端需求代理 `pi_company_ask` 契约变更 | 主会话裁定后 `pi_company_forward` | 前端需求代理收到补充；直连被拒 |
| 跨仓库等待 | 形状声明等待后端 accepted | 后端未通过 / 通过 | 等待并显示原因 / 核对后执行 |

### migration
| 用例 | 入口 | 输入 | 预期 |
|---|---|---|---|
| 预检 | `pi_company_workflow migrate-preflight` | 含两个 worktree 的旧 `.pi-spec` 夹具 | 列出全部来源；未修改文件 |
| 停写阻塞 | `migrate-apply` | 存在活动窗口 | 阻塞并列明条件 |
| 保真迁移 | 停写后 `migrate-apply` | 含重复记录与替代关系 | 本机可查、编号与引用一致、仓库只移除运行字段 |
| 中断恢复 | 校验阶段中断后重试 | — | 源数据未删除；重试不重复 |

## 协作关系
- 依赖全部前序 plan 的产物；集成测试不 mock 守护进程、子进程与套接字，只用受控模型与注入时钟。

## 验证方式
- 测试入口：`bun test tests/integration`
- 测试输入：上述矩阵；每个用例在独立临时 HOME 与临时仓库内执行，结束后清理守护进程与子进程
- 预期结果：全部用例通过；进程列表无残留守护进程、窗口子进程或 Shell 后代；临时目录被删除
- [ ] 七个测试文件全部通过
- [ ] 无进程残留（用例结束后按 token 扫描进程列表为零）
- [ ] 全量 `bun test tests` 通过
