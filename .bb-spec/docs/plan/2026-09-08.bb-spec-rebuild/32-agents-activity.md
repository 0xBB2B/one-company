---
name: agents-activity
description: 把守护进程活动事件投影为面板树模型：仓库·需求→角色行、真实活动、20 秒结束保留与临时提示、待答标记、不可达
---
# 面板活动模型

## 目标
面板只需消费一个纯数据模型即可渲染工作区内全部需求代理与子角色的真实状态。

## 业务规则（来源：spec）
- cross-window-panel：条目为"仓库 · 需求标题"及其子角色缩进行，显示状态、真实活动、轮次、耗时与待答标记，中断条目另显示接管的活动 Shell 任务数，已停止条目另显示清理未确认的 Shell 任务数，不显示任务文件路径，不显示工作区外仓库。
- cross-window-panel：活动来自守护进程推送的实际工具开始与结束事件；守护进程不可达时显示不可达，不用旧活动冒充。
- cross-window-panel：结束或用户停止的条目转灰色静态摘要并保留 20 秒后移出；临时操作失败提示显示 20 秒后恢复；两者自首次出现起计时，重绘与选择不续时，新提示替换并重新计时；暂停、中断与清理未确认的已停止运行不启动移除计时；已移出的条目再次收到同一运行的变更不复活、不续时。
- 规则空白处的裁定：queued、pausing、paused_network 三态按钮为 停止/查看（pausing 与网络暂停期间不提供暂停/继续）。仓库显示名取工作区仓库路径的末段目录名，仓库键用 repoId。
- 编辑文件数按不同文件计数，不把调用次数或上下文占用冒充完成度。

## 涉及文件
- 新建 `runtime/agents-activity.ts`
- 新建 `tests/agents-activity.test.ts`

## 函数清单
### runtime/agents-activity.ts
| 函数名 | 职责 |
|---|---|
| `AgentsActivity` | 构造 `{ clock, workspaceRepos: Array<{ repoId, name }> }`；保存全部仓库的运行树与计时状态，暴露只读投影 |
| `AgentsActivity.applyRunsChanged` | 按 `runs.changed` 载荷 `{ run, requirementTitle?, activeShellTasks?, pendingShellCleanup? }`（单条运行，仓库键为 repoId 参数）增删改需求代理与角色节点；不在工作区内的仓库忽略；已移出条目的同一运行再次到达即丢弃 |
| `AgentsActivity.applyActivity` | 按 `activity` 载荷 `{ runId, kind: tool_start\|tool_end\|turn\|state, toolCallId?, toolName?, filePath?, state?, at }` 更新节点活动（并发工具按 toolCallId 记录在飞调用，同名并发互不干扰，显示最早仍在进行的工具名；缺 toolCallId 的工具事件丢弃）、编辑文件集合（edit 与 write 都计入，按绝对路径 normalize 去重）；轮次只取 runs.changed 的 run.turns；未知运行的事件丢弃 |
| `AgentsActivity.applyConnectionState` | 按 daemon-client 状态 `connected\|starting\|unreachable` 更新仓库：不可达/重连中标记原因并清空活动；仅在已观察到非 connected 状态之后再变为 connected 的跃迁上清空旧活动等待新事件；首次观察到 connected 与重复上报 connected 都不影响活动 |
| `AgentsActivity.reportActionFailure` | 记录一条 20 秒临时错误，新错误替换并重新计时；`notice()` 读取 |
| `AgentsActivity.rows` | 生成有序面板行：仓库·需求首行 + 子角色缩进行，附耗时（扣除睡眠，startedAt 不可解析时为 0）、可用按钮集合；多次调用不改变计时与结果（可顺带移出已到期条目）；父条目已移出的子角色行标题为「仓库 · 需求标题 › 角色名」（需求标题取角色运行登记时父行的快照，不另设全局映射），父标题从未见过时为「仓库 · 角色名」，角色名缺失用「角色」 |
| `AgentsActivity.prune` | 按首次结束时刻移除超过 20 秒的结束条目并记墓碑（定长 FIFO 512 条，运行 id 为 UUID 不复用；512 条以外的历史终态运行若被重放会再次灰显 20 秒，是容量上限的已知代价）；暂停、中断、清理未确认的已停止不移除；父条目移出时仍活跃的子角色行保留可见并在其自身结束后按同规则移出 |
| `RETENTION_MS` | 常量 20000 |
| `buttonsFor` | 按状态给出按钮：运行中暂停/停止/查看，已暂停继续/停止/查看，中断续接/停止/查看，等待答复停止/查看，queued/pausing/paused_network 停止/查看，终态无按钮，未知状态（跨版本）停止/查看 |

## 协作关系
- 输入来自 `runtime/daemon-client.ts` 的事件（`runs.changed`、`activity`，载荷形状以 14 daemon-protocol 事件目录为准）与状态（`connected|starting|unreachable`）；计时用 `runtime/clock.ts`。
- 输出供 `runtime/agents-panel.ts` 渲染；不含任何 TUI 依赖。

## 验证方式
- 测试入口：`AgentsActivity`（注入可控时钟）。
- 测试输入：两个仓库的运行变化事件；读取、搜索、对同一文件两次编辑的工具事件；结束、失败、用户停止、暂停、中断（接管 2 个活动 Shell）、不确定各一条；不可达标记；两次相隔 5 秒的临时错误；注入睡眠间隔。
- 预期结果：
  - 行顺序为仓库·需求首行后紧跟其角色缩进行；首行标题含仓库显示名（目录名）而非 repoId；工作区外仓库不出现；行内无文件路径（含工具事件里的 filePath）；中断行显示活动 Shell 任务数 2；已停止行显示清理未确认 Shell 任务数 1。
  - 两次编辑同一文件（含等价写法）计文件数 1；活动文本等于事件里的工具名；并发两个工具时一个结束后显示仍在进行的那个；工具全部结束后不再显示执行中；未知运行的活动事件被丢弃。
  - 结束/失败/停止条目在 19 秒仍在、20 秒移出；移出后同一运行再次到达不复活；父条目移出后仍在运行的子角色行仍可见；暂停、中断、清理未确认的已停止 60 秒后仍在。
  - 第二次错误自其出现起重新计 20 秒，重绘与选择调用不改变计时。
  - 不可达后行显示不可达与原因，活动为空；恢复连接后旧活动不复现；耗时扣除注入的睡眠间隔；startedAt 缺失或畸形时耗时为 0 而非 NaN。
  - 各状态按钮集合与规则一致。
- [x] 树形行序与范围
- [x] 真实活动与文件计数
- [x] 20 秒保留与例外
- [x] 临时错误替换重计
- [x] 不可达与睡眠感知耗时
