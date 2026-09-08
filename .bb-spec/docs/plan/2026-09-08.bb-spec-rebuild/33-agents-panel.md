---
name: agents-panel
description: Agents 面板 TUI 组件：树形渲染、限高滚动、按状态按钮、键鼠操作经守护进程执行并按真实结果更新，挂在原状态栏之后
---
# Agents 面板组件

## 目标
用户在任意窗口底部看到本工作区全部需求代理与子角色，并能对任一运行执行暂停、继续、停止、续接与查看。

## 业务规则（来源：spec）
- cross-window-panel：面板位于输入栏、原状态栏及可见 Shell 汇总行下方，是界面最后一块，原状态栏内容保持可见。
- cross-window-panel：面板内 ↑↓ 选条目、←→ 选按钮、Enter 执行、Tab 切换单项与批量、Esc 返回；选中按钮蓝色不附箭头；只提供符合状态的操作。
- cross-window-panel：任意窗口的控制请求送达对应守护进程并按真实结果更新状态；操作失败显示 20 秒临时提示。
- cross-window-panel：条目超出容量时保持高度上限并可滚动选择全部条目，不挤掉输入区域。
- 普通终端模式不捕获鼠标，全屏模式可点击按钮。

## 涉及文件
- 新建 `runtime/agents-panel.ts`
- 新建 `extensions/agents-ui.ts`
- 新建 `tests/agents-panel.test.ts`

## 函数清单
### runtime/agents-panel.ts
| 函数名 | 职责 |
|---|---|
| `AgentsPanel` | TUI 组件：按 `AgentsActivity.rows` 渲染树、选中态与按钮，行宽不超过给定宽度 |
| `AgentsPanel.handleInput` | 处理 ↑↓←→ Enter Tab Esc，返回是否消费 |
| `AgentsPanel.handleMouse` | 全屏模式下点击按钮与滚轮滚动 |
| `AgentsPanel.focus` / `blur` | 进入与离开面板焦点 |
| `AgentsPanel.execute` | 把选中按钮映射为守护进程方法并发送，等待真实结果后刷新，失败记临时错误 |
| `AgentsPanel.availableRows` | 按终端高度、编辑器与原状态栏高度算面板上限 |
| `createAgentsPanel` | 组装组件：注入活动模型、客户端集合、时钟与主题 |
| `mountAgentsPanel` | 定位宿主 footer 容器并把面板追加在其后，返回卸载函数；能力不足时返回未挂载与原因 |
### extensions/agents-ui.ts
| 函数名 | 职责 |
|---|---|
| `agentsUiExtension` | 默认导出：`session_start` 时在 tui 模式挂载面板与查看页入口，订阅事件，`session_shutdown` 卸载 |
| `refreshLoop` | 用睡眠感知时钟定时重绘并调用 `prune` |

## 协作关系
- 依赖 `runtime/agents-activity.ts`、`runtime/daemon-client.ts`（`runs.pause/resume/stop/resumeInterrupted`）、`runtime/transcript-view.ts`（查看按钮打开）、`runtime/dock.ts`（焦点编排）、`runtime/clock.ts`。
- 挂载点用 SDK `FooterComponent` 在组件树中定位；能力探测用 `ctx.mode === "tui"`、`ctx.hasUI`、`ctx.ui.setWidget`、`ctx.ui.onTerminalInput`、`ctx.ui.getEditorText`。

## 验证方式
- 测试入口：`AgentsPanel`（注入活动模型、假客户端、可控时钟），用 `tests/helpers/virtual-terminal.ts` 渲染；`mountAgentsPanel` 用带 footer 的宿主组件树夹具。
- 测试输入：两个仓库共五个条目（运行中、已暂停、中断、等待答复、已结束）；固定 80×24 终端；超出容量的 12 个条目；按键序列；假客户端返回 `pausing` 未确认与失败。
- 预期结果：
  - 渲染行顺序：原状态栏行 → 汇总行 → 面板；每行宽度 ≤ 80；首行格式"仓库 · 需求标题"，角色行缩进。
  - 运行中行按钮为暂停/停止/查看，已暂停为继续/停止/查看，中断为续接/停止/查看；选中按钮含蓝色样式且无箭头字符。
  - 12 个条目时面板高度不超过上限，↓ 到末项可选中并执行正确目标。
  - Enter 暂停后在客户端返回确认前状态显示"暂停中"，确认后"已暂停"；客户端失败时出现临时错误行且 20 秒后消失。
  - Esc 后焦点返回输入栏；非 tui 模式 `mountAgentsPanel` 返回未挂载与原因且不抛错。
- [ ] 布局与行宽
- [ ] 状态按钮与样式
- [ ] 限高滚动
- [ ] 真实结果更新与临时错误
- [ ] 能力不足不挂载
