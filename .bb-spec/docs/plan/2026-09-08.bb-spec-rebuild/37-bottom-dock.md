---
name: bottom-dock
description: 底部区块与焦点编排：空输入 ↓ 依次进入汇总行与面板，Esc 返回，输入非空或页面占用时不抢键，仅 tui 挂载
---
# 底部区块编排

## 目标
输入栏、原状态栏、Shell 汇总行、Agents 面板与替换输入栏的页面之间的顺序和按键归属固定且互不干扰。

## 业务规则（来源：spec）
- status-entry / cross-window-panel：输入栏完全为空且没有补全菜单、设置页或其他交互界面占用按键时，↓ 先选择可见 Shell 汇总行，再按 ↓ 进入 Agents；无汇总行时直接进入面板；只选择不执行；Esc 或条目全部消失时返回输入栏。
- status-entry / cross-window-panel：输入非空或界面占用时不得抢方向键，不同时操作两页。
- process-list / transcript-view：管理页与查看页在输入栏位置打开，保持底部其他区块相对顺序，关闭后恢复输入栏或来源焦点。
- 面板只在具备真实终端组件能力的主会话渲染。

## 涉及文件
- 新建 `runtime/dock.ts`
- 新建 `tests/bottom-dock.test.ts`

## 函数清单
### runtime/dock.ts
| 函数名 | 职责 |
|---|---|
| `BottomDock` | 维护区块顺序（汇总行、面板）、当前焦点区块与"页面占用"标志 |
| `BottomDock.attach` | 注册原始终端输入监听，探测编辑器文本是否为空、是否有补全或覆盖层 |
| `BottomDock.handleKey` | 空输入 ↓：按可见性依次把焦点交给汇总行、面板；Esc：归还输入栏；焦点在区块内时把按键转交该区块 |
| `BottomDock.markPageOpen` / `markPageClosed` | 页面替换输入栏期间禁止方向键抢占，关闭后恢复来源焦点 |
| `BottomDock.release` | 卸载监听并归还焦点 |
| `canCapture` | 判定条件：tui 模式、输入为空、无补全、无覆盖层、无页面占用、目标区块可见 |

## 协作关系
- 被 `runtime/shell-summary.ts`、`runtime/agents-panel.ts`、`runtime/shell-page.ts`、`runtime/transcript-view.ts` 使用；由 `extensions/agents-ui.ts` 与 `extensions/shell-ui.ts` 在 `session_start` 创建一次共享实例。
- 依赖 `ctx.ui.onTerminalInput`、`ctx.ui.getEditorText`、TUI 的覆盖层与补全探测。

## 验证方式
- 测试入口：`BottomDock`（注入假终端输入源、可控的编辑器文本、补全/覆盖层标志与两个假区块）。
- 测试输入：空输入按 ↓↓ Esc；输入"abc"按 ↓；补全打开时按 ↓；页面打开时按 ↓；汇总行不可见时按 ↓；面板条目全部消失。
- 预期结果：
  - 空输入首个 ↓ 焦点到汇总行且未打开页面，第二个 ↓ 到面板，Esc 回输入栏。
  - 输入非空、补全打开、页面占用三种情况 ↓ 不被消费。
  - 汇总行不可见时 ↓ 直接进入面板；面板条目全部消失后焦点自动回输入栏。
  - 页面关闭后焦点恢复为打开前的区块。
- [ ] 顺序进入与返回
- [ ] 不抢键条件
- [ ] 可见性跳过与空面板回退
- [ ] 页面关闭恢复焦点
