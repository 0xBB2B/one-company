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
| `AgentsPanel` | TUI 组件：按 `AgentsActivity.rows` 渲染树——每行显示标题、状态（中文标签：运行中/暂停中/已暂停/网络暂停/等待答复/已中断/已完成/失败/已停止/排队）、真实活动、轮次（第 N 轮）、耗时、待答标记、中断的活动 Shell 数、已停止的清理未确认数、不可达（有原因附原因，无原因仅标"不可达"），结束条目灰显；渲染的每个外来文本片段（标题、活动、不可达原因、临时提示、状态兜底、Shell/清理计数）都先剥离 C0/C1 控制字符与 ESC；耗时以可读格式显示（秒、分秒、时分秒）；全部按钮同行可见，选中按钮以主题高亮（不附箭头）；标题外来文本渲染前剥离控制字符与 ESC；行宽按显示列（东亚宽字符占 2 列、ANSI 不计）裁剪不超过给定宽度；不拼接宿主状态栏（状态栏由宿主渲染，面板经 `placement: "belowEditor"` 挂在其后） |
| `AgentsPanel.handleInput` | 先用 pi-tui `isKeyRelease` 丢弃按键释放事件（扩展输入监听路径宿主不过滤），再用 `matchesKey` 识别 ↑↓←→ Enter Tab Esc（兼容 Kitty 键盘协议编码），只在真正处理时返回已消费 |
| `AgentsPanel.handleMouse` | 全屏模式下点击按钮与滚轮滚动；行号映射与渲染共用同一个可见窗口计算（含临时提示行占位），点到提示行不做动作 |
| `AgentsPanel.focus` / `blur` | 进入与离开面板焦点，由 BottomDock 切换焦点时调用，影响选中态是否渲染 |
| `AgentsPanel.invalidate` | 转发到宿主 `tui.requestRender()`（主题切换钩子同样触发重绘） |
| `AgentsPanel.tick` | 由 refreshLoop 每秒调用：在途标记到期扫描 |
| `render` | 纯投影：不改写光标等状态（光标夹取在 moveCursor/execute/handleMouse 完成） |
| `AgentsPanel.execute` | 把选中按钮映射为守护进程方法并发送；发送期间显示乐观"暂停中"等标签且忽略对同一行的重复下发（Tab 切换不清除在途标记），守护进程返回后清除乐观标签、交回模型的真实状态；在途标记按注入时钟 30 秒到期（由 `tick()` 扫描，render 不扫描）：恢复按钮并记"未确认"临时提示；结算回调校验令牌，只清除自己那一次的在途标记（迟到结算不误删重试后的新标记）；失败只记临时错误（独立提示行，计入高度上限），条目不隐藏 |
| `AgentsPanel.availableRows` | 按终端高度、编辑器与原状态栏高度算面板上限 |
| `AgentsPanel.hasRows` | 是否有可选条目，供编排判断 ↓ 是否消费 |
| `createAgentsPanel` | 组装组件：注入活动模型、客户端集合、时钟与主题 |
| `mountAgentsPanel` | 经 `ctx.ui.setWidget(key, (tui, theme) => …, { placement: "belowEditor" })` 挂载，接住宿主 `tui` 与 `theme`（主题高亮、`tui.requestRender` 重绘、`tui.hasOverlay()` 与聚焦编辑器的 `isShowingAutocomplete()` 探测、鼠标捕获模式）；返回卸载函数与宿主探测 host（isOverlayOpen/isCompletionOpen/captureMode/requestRender）；`!ctx.hasUI || ctx.mode !== "tui"` 或缺能力时返回未挂载与原因 |
### runtime/dock.ts
| 函数名 | 职责 |
|---|---|
| `BottomDock` | 维护面板引用、当前焦点（输入栏 / 面板）与"页面占用"标志 |
| `BottomDock.attach` | 注册原始终端输入监听，探测编辑器文本是否为空、是否有补全或覆盖层 |
| `BottomDock.handleKey` | 先丢弃按键释放事件，再用 `matchesKey` 识别；空输入 ↓ 且面板已挂载并有条目：焦点交给面板；Esc：归还输入栏；焦点在面板时把按键转交面板，仅当面板报告已处理才消费，其余交还宿主 |
| `BottomDock.markPageOpen` / `markPageClosed` | 页面替换输入栏期间禁止方向键抢占，关闭后恢复来源焦点 |
| `BottomDock.release` | 卸载监听并归还焦点 |
| `canCapture` | 判定条件：tui 模式、输入为空、无补全、无覆盖层、无页面占用、面板已挂载且有条目 |
### extensions/agents-ui.ts
| 函数名 | 职责 |
|---|---|
| `agentsUiExtension` | 默认导出：`session_start` 处理器先卸载上一次残留（切换/fork 重入），在 tui 模式经 `windowReady().then(...)` 异步续接（不 await，避免与 lifecycle 串行 emit 死锁）：创建 `AgentsActivity`（仓库名取 workspace 目录名）、订阅各客户端 `runs.changed`/`activity`、每次刷新 tick 轮询 `client.state()` 喂给 `applyConnectionState`、创建共享 `BottomDock`、挂载面板；`session_shutdown` 卸载并取消订阅 |
| `refreshLoop` | 用睡眠感知时钟每秒轮询连接状态、调用 `panel.tick()`，并经 `tui.requestRender()` 重绘（耗时、20 秒移出、提示消失依赖它）；`windowReady().then` 续接与其 catch 都带取消令牌，shutdown 早于就绪时不再挂载也不再 notify |

## 协作关系
- 依赖 `runtime/agents-activity.ts`（行数据增加不渲染的 `repoId` 字段供面板定位客户端）、`runtime/daemon-client.ts`（`runs.pause/resume/stop/resumeInterrupted`）、查看按钮经 `onView(runId)` 回调（本单元交付时 agents-ui 传入的是占位回调，"查看"暂无动作，34 单元接入查看页时替换）、`runtime/clock.ts`。
- `BottomDock.markPageOpen/markPageClosed` 的"恢复来源焦点"语义在 35/34 页面接入前没有真实调用方；本单元用例只验证接口存在与状态转换，真实焦点恢复由 35 单元用例验证。
- `BottomDock` 实例由本单元在 `session_start` 创建一次，供 `runtime/shell-page.ts` 与 `runtime/transcript-view.ts` 调用 `markPageOpen` / `markPageClosed`；Shell 状态只是宿主状态栏文本，不参与焦点编排。
- 挂载点用 SDK `FooterComponent` 在组件树中定位；能力探测用 `ctx.mode === "tui"`、`ctx.hasUI`、`ctx.ui.setWidget`、`ctx.ui.onTerminalInput`、`ctx.ui.getEditorText`。

## 验证方式
- 测试入口：`AgentsPanel`（注入活动模型、假客户端、可控时钟），用 `tests/helpers/virtual-terminal.ts` 渲染；`mountAgentsPanel` 用带 footer 的宿主组件树夹具；`BottomDock`（注入假终端输入源、可控的编辑器文本、补全/覆盖层标志与假面板）
- 测试输入：两个仓库共五个条目（运行中、已暂停、中断、等待答复、已结束）；固定 80×24 终端；超出容量的 12 个条目；按键序列；假客户端返回 `pausing` 未确认与失败；编排：空输入按 ↓ Esc；输入"abc"按 ↓；补全打开时按 ↓；页面打开时按 ↓；面板无条目时按 ↓；面板条目全部消失
- 预期结果：
  - 挂载调用 `setWidget` 的 `placement` 为 `belowEditor`；每行显示宽度 ≤ 80（60 个汉字标题仍不溢出，ANSI 不计入）；首行格式"仓库 · 需求标题"，角色行缩进；行内含状态、活动、轮次、耗时、待答标记、Shell 计数、不可达原因，结束条目灰显；标题中的 ESC/控制字符不出现在输出中。
  - 运行中行按钮为暂停/停止/查看，已暂停为继续/停止/查看，中断为续接/停止/查看；三个按钮字样始终共存，选中按钮带主题高亮标记且 ←→ 使高亮位移，无箭头字符；Kitty 协议下同一按键的按下+释放序列只触发一次（↓ 只移一行、Tab 只切换一次）。
  - 行内状态为中文标签，待答行含"待答"（夹具标题不得含该词）；不可达无原因时行含"不可达"；活动名、不可达原因、临时提示中的 ESC/控制字符不出现在输出；有提示时点击首行命中渲染首行对应的运行，点击提示行无动作。
  - 在途标记到期：Enter 后守护进程 30 秒未回执，推进注入时钟后按钮恢复且出现"未确认"提示；Tab 切换不清除在途标记（切换后再 Enter 仍不重复下发）。
  - `invalidate()` 与 refreshLoop tick 都会调用宿主 requestRender（假 tui 计数）。
  - 12 个条目时面板高度不超过上限，↓ 到末项可选中并执行正确目标。
  - Enter 暂停后在客户端返回确认前状态显示"暂停中"，确认后行按钮恢复为已暂停态的继续/停止/查看（乐观标签清除）；发送期间重复 Enter 不重复下发；客户端失败时条目仍在、独立提示行出现，19 秒仍在、20 秒消失，新提示替换并重新计时；有提示时总行数仍不超过上限。
  - 空输入首个 ↓ 焦点直接到面板且未执行任何操作，Esc（含 Kitty 协议编码）回输入栏；输入非空、补全打开、覆盖层打开、markPageOpen 页面占用、面板无条目五种情况 ↓ 不被消费；面板焦点下未处理的按键（如 Ctrl+C）不被消费；面板条目全部消失后焦点自动回输入栏；markPageClosed 后焦点恢复为打开前的位置。
  - 非 tui 模式 `mountAgentsPanel` 返回未挂载与原因且不抛错。
  - `agentsUiExtension`：与 lifecycle 扩展按任意顺序串行 emit session_start 均不挂起且面板最终挂载；连接状态经轮询进入模型（客户端 unreachable 后行显示不可达）；第二次 session_start 先卸载前一次（onTerminalInput 订阅数不增长）；session_shutdown 卸载。
- [ ] 布局与行宽
- [ ] 状态按钮与样式
- [ ] 限高滚动
- [ ] 真实结果更新与临时错误
- [ ] 空输入 ↓ 进面板与不抢键条件
- [ ] 页面占用与焦点恢复
- [ ] 能力不足不挂载
