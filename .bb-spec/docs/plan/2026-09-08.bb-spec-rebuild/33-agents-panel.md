---
name: agents-panel
description: Agents 面板 TUI 组件与底部焦点编排：树形渲染、限高滚动、按状态按钮、键鼠操作经守护进程执行并按真实结果更新，挂在原状态栏之后；空输入 ↓ 直接进面板，页面占用时不抢键
---
# Agents 面板与底部编排

## 目标
用户在任意窗口底部看到本工作区全部需求代理与子角色，能对任一运行执行暂停、继续、停止、续接与查看；输入栏、原状态栏、面板与替换输入栏的页面之间的顺序和按键归属固定且互不干扰。

## 业务规则（来源：spec）
- cross-window-panel：面板位于输入栏与原状态栏下方，是界面最后一块，原状态栏内容保持可见。
- cross-window-panel：面板内 ↑↓ 选条目、←→ 选按钮、Enter 执行、Tab 切换单项与批量、Esc 返回；选中按钮蓝色不附箭头；只提供符合状态的操作。
- cross-window-panel：任意窗口的控制请求送达对应守护进程并按真实结果更新状态；操作失败显示 20 秒临时提示。
- cross-window-panel：条目超出容量时保持高度上限并可滚动选择全部条目，不挤掉输入区域。
- cross-window-panel：输入栏完全为空且没有补全菜单、设置页或其他交互界面占用按键时，↓ 直接进入 Agents 面板，只选择不执行；面板不存在或无条目时不消费该键；Esc 或条目全部消失时返回输入栏；输入非空或界面占用时不得抢方向键。
- process-list / transcript-view：管理页与查看页在输入栏位置打开，保持底部其他区块相对顺序，关闭后恢复输入栏或来源焦点。
- 普通终端模式不捕获鼠标，全屏模式可点击按钮；面板只在具备真实终端组件能力的主会话渲染。

## 涉及文件
- 新建 `runtime/agents-panel.ts`
- 新建 `runtime/dock.ts`
- 新建 `extensions/agents-ui.ts`
- 新建 `tests/agents-panel.test.ts`
- 新建 `tests/bottom-dock.test.ts`

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
| `AgentsPanel.hasRows` | 是否有可选条目，供编排判断 ↓ 是否消费 |
| `createAgentsPanel` | 组装组件：注入活动模型、客户端集合、时钟与主题 |
| `mountAgentsPanel` | 定位宿主 footer 容器并把面板追加在其后，返回卸载函数；能力不足时返回未挂载与原因 |
### runtime/dock.ts
| 函数名 | 职责 |
|---|---|
| `BottomDock` | 维护面板引用、当前焦点（输入栏 / 面板）与"页面占用"标志 |
| `BottomDock.attach` | 注册原始终端输入监听，探测编辑器文本是否为空、是否有补全或覆盖层 |
| `BottomDock.handleKey` | 空输入 ↓ 且面板已挂载并有条目：焦点交给面板；Esc：归还输入栏；焦点在面板时把按键转交面板 |
| `BottomDock.markPageOpen` / `markPageClosed` | 页面替换输入栏期间禁止方向键抢占，关闭后恢复来源焦点 |
| `BottomDock.release` | 卸载监听并归还焦点 |
| `canCapture` | 判定条件：tui 模式、输入为空、无补全、无覆盖层、无页面占用、面板已挂载且有条目 |
### extensions/agents-ui.ts
| 函数名 | 职责 |
|---|---|
| `agentsUiExtension` | 默认导出：`session_start` 时在 tui 模式创建共享 `BottomDock`、挂载面板与查看页入口，订阅事件，`session_shutdown` 卸载 |
| `refreshLoop` | 用睡眠感知时钟定时重绘并调用 `prune` |

## 协作关系
- 依赖 `runtime/agents-activity.ts`、`runtime/daemon-client.ts`（`runs.pause/resume/stop/resumeInterrupted`）、`runtime/transcript-view.ts`（查看按钮打开）、`runtime/clock.ts`。
- `BottomDock` 实例由本单元在 `session_start` 创建一次，供 `runtime/shell-page.ts` 与 `runtime/transcript-view.ts` 调用 `markPageOpen` / `markPageClosed`；Shell 状态只是宿主状态栏文本，不参与焦点编排。
- 挂载点用 SDK `FooterComponent` 在组件树中定位；能力探测用 `ctx.mode === "tui"`、`ctx.hasUI`、`ctx.ui.setWidget`、`ctx.ui.onTerminalInput`、`ctx.ui.getEditorText`。

## 验证方式
- 测试入口：`AgentsPanel`（注入活动模型、假客户端、可控时钟），用 `tests/helpers/virtual-terminal.ts` 渲染；`mountAgentsPanel` 用带 footer 的宿主组件树夹具；`BottomDock`（注入假终端输入源、可控的编辑器文本、补全/覆盖层标志与假面板）
- 测试输入：两个仓库共五个条目（运行中、已暂停、中断、等待答复、已结束）；固定 80×24 终端；超出容量的 12 个条目；按键序列；假客户端返回 `pausing` 未确认与失败；编排：空输入按 ↓ Esc；输入"abc"按 ↓；补全打开时按 ↓；页面打开时按 ↓；面板无条目时按 ↓；面板条目全部消失
- 预期结果：
  - 渲染行顺序：原状态栏行 → 面板；每行宽度 ≤ 80；首行格式"仓库 · 需求标题"，角色行缩进。
  - 运行中行按钮为暂停/停止/查看，已暂停为继续/停止/查看，中断为续接/停止/查看；选中按钮含蓝色样式且无箭头字符。
  - 12 个条目时面板高度不超过上限，↓ 到末项可选中并执行正确目标。
  - Enter 暂停后在客户端返回确认前状态显示"暂停中"，确认后"已暂停"；客户端失败时出现临时错误行且 20 秒后消失。
  - 空输入首个 ↓ 焦点直接到面板且未执行任何操作，Esc 回输入栏；输入非空、补全打开、页面占用、面板无条目四种情况 ↓ 不被消费；面板条目全部消失后焦点自动回输入栏；页面关闭后焦点恢复为打开前的位置。
  - 非 tui 模式 `mountAgentsPanel` 返回未挂载与原因且不抛错。
- [ ] 布局与行宽
- [ ] 状态按钮与样式
- [ ] 限高滚动
- [ ] 真实结果更新与临时错误
- [ ] 空输入 ↓ 进面板与不抢键条件
- [ ] 页面占用与焦点恢复
- [ ] 能力不足不挂载
