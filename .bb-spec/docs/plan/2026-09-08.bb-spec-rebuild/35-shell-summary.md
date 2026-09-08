---
name: shell-summary
description: Shell 汇总行：合计本窗口主会话与工作区内守护进程的活动 Shell，按主 agent 与角色分布，不确定单列，读取失败明示
---
# Shell 汇总行

## 目标
用户在原状态栏与 Agents 面板之间随时看到当前有多少 Shell 在跑、分别属于谁，并能从这一行进入管理页。

## 业务规则（来源：spec）
- status-entry：当前主会话有活动 Shell 时，在原状态栏下方、Agents 上方显示汇总行，统计本窗口主会话与本工作区守护进程内全部等待结果及后台运行任务，按主 agent 与角色汇总；一个命令及其后代只计一个 Shell，工作区外和已确认结束的任务不计入。
- status-entry：汇总格式为"shell：总数 · 主 agent：数量 · 角色：数量"，同角色子运行合计。
- status-entry：状态读取失败或停止无法确认时显示具体读取错误或单独的不确定数量，不显示为零活动或已清理；数量不受滚动、分组或重复刷新影响。

## 涉及文件
- 新建 `runtime/shell-summary.ts`
- 新建 `tests/shell-summary.test.ts`

## 函数清单
### runtime/shell-summary.ts
| 函数名 | 职责 |
|---|---|
| `summarizeShells` | 合并本窗口注册表与各守护进程 `shells.list` 结果，按宿主类型与角色计数，分离不确定任务与读取失败 |
| `formatShellSummary` | 生成"shell：N · 主 agent：N · worker：N · 不确定：N"文本，读取失败时改为错误文本 |
| `ShellSummaryRow` | TUI 组件：一行渲染、选中态蓝色整行无箭头、Enter 打开管理页、↓ 交给下一区块 |
| `ShellSummaryRow.refresh` | 拉取最新汇总并请求重绘 |
| `isVisible` | 有活动或不确定任务、或读取失败时可见，否则隐藏 |

## 协作关系
- 依赖 `runtime/shell-registry.ts`（本窗口任务）、`runtime/daemon-client.ts`（`shells.list`、`shells.changed` 事件）、`runtime/dock.ts`（焦点顺序）、`runtime/shell-page.ts`（Enter 打开）。
- 由 `extensions/shell-ui.ts` 挂载为原状态栏之后、面板之前的组件。

## 验证方式
- 测试入口：`summarizeShells`、`formatShellSummary`、`ShellSummaryRow`（`tests/helpers/virtual-terminal.ts` 渲染）。
- 测试输入：本窗口一个后台 Shell（含多个后代）；两个守护进程各返回 worker 任务一个、其中一个标不确定；一个已结束任务；一个仓库读取失败；工作区外仓库任务。
- 预期结果：
  - 文本为"shell：3 · 主 agent：1 · worker：2"，不确定另列为"不确定：1"，已结束与工作区外不计。
  - 读取失败时显示具体错误而非零；重复刷新与分组不改变总数。
  - 选中时整行蓝色且无箭头字符；无活动且无错误时组件不可见。
- [ ] 计数口径
- [ ] 不确定与读取失败
- [ ] 渲染与可见性
