---
name: window-notices
description: 窗口把换新、等待、旧窗口提示显示到 pi 终端；Shell 汇总里的仓库前缀换成项目目录名
---
# 宿主端：显示提示与去掉仓库编号

## 目标
用户在 pi 终端里按确认过的颜色和文字看到 ①–⑤ 五种提示；用户看到的守护进程相关错误前缀是项目目录名，不是 64 位仓库编号。

## 业务规则（来源：PRD replace-when-idle、wait-then-replace、stale-window）
- 提示用 pi 的 `ctx.ui.notify`：`info` 显示为灰色普通消息，`warning` 显示为黄色 `Warning: …`，`error` 显示为红色 `Error: …`。① ④ 用 `info`，② ③ 用 `warning`，⑤ 用 `error`。文字由 `upgradeNoticeText`（计划 03）生成，这里不改文字。
- 打开窗口时发生的情况（①②③⑤）在窗口启动时就显示，不等主代理调用工具；之后等待中换上（④）、或重连时才发现的情况，也在发生时显示。
- 窗口关掉或会话切换后，旧窗口的客户端不再弹提示。
- Shell 汇总（状态栏里的 shell 统计）和 Shell 页面的出错行，前缀用项目目录名：仓库主目录名，worktree 用主仓库目录名（`repoDisplayName(commonDir)`，计划 01）。
- 现有没有 Git 仓库时的提醒、启动失败报错不变。

## 涉及文件
- `src/core/host/extension-lifecycle.ts` 修改
- `src/modules/shell/shell-summary.ts` 修改
- `src/modules/shell/shell-page.ts` 修改
- `src/modules/shell/shell-ui-extension.ts` 修改
- `tests/window-lifecycle.test.ts`、`tests/shell-summary.test.ts`、`tests/shell-page.test.ts` 修改

## 函数清单
### src/core/host/extension-lifecycle.ts
| 函数名 | 职责 |
|---|---|
| `LifecycleDeps.connectWorkspaceClients` 入参（修改） | 增加 `onUpgradeNotice`，由 `startWindow` 传入 |
| `defaultConnectWorkspaceClients`（修改） | 把 `onUpgradeNotice` 交给 `WorkspaceClients.create` |
| `startWindow`（修改） | 生成本窗口的 `onUpgradeNotice`：用 `upgradeNoticeText` 转成文字和级别后调用 `input.notify`；窗口已不是当前窗口（`activeWindow` 换了或已关闭）时丢弃 |

### src/modules/shell/shell-summary.ts
| 函数名 | 职责 |
|---|---|
| `ShellSummaryRepo`（修改） | 增加 `name` 字段 |
| `summarizeShells`（修改） | 出错行前缀用 `repo.name` |

### src/modules/shell/shell-page.ts
| 函数名 | 职责 |
|---|---|
| `ShellPageRepo`（修改） | 增加 `name` 字段 |
| 刷新逻辑中拼出错行处（修改） | 前缀用 `repo.name` |

### src/modules/shell/shell-ui-extension.ts
| 函数名 | 职责 |
|---|---|
| 组装 `repos` / `summaryRepos` 处（修改） | 从 `window.workspace.repos` 的 `commonDir` 用 `repoDisplayName` 填 `name` |

## 协作关系
- `extension-lifecycle` → `upgradeNoticeText`（计划 03）、`WorkspaceClients.create` 的 `onUpgradeNotice`（计划 03）。
- `shell-ui-extension` → `repoDisplayName`（计划 01）。模块只引用下层模块：`modules/shell` 引用 `core/storage`，`core/host` 引用 `core/storage`，符合架构测试里的顺序。

## 验证方式
- 测试入口：`lifecycleExtension(pi, deps)` 触发 `session_start`（`deps.connectWorkspaceClients` 用假实现，在调用时立刻回调传入的 `onUpgradeNotice`）；`summarizeShells`；Shell 页面刷新。
- 测试输入与预期结果：
  - 假实现回调一条 `replaced`（`repoName: "企微BOT"`）→ `ctx.ui.notify` 收到 `("企微BOT 的后台进程跑的是旧代码，已停掉并换成当前安装的版本。", "info")`
  - 回调 `waiting_blocked`（需求 `订单导出`、另 1 个窗口）→ 收到 ③ 的全文，级别 `warning`；回调 `window_stale` → 级别 `error`
  - `session_shutdown` 之后假实现再回调一条 → `notify` 不再被调用
  - `summarizeShells` 中某仓库 `shells.list` 抛错、`name: "企微BOT"`、`repoId` 为 64 位串 → 错误行以 `企微BOT：` 开头，整段不含该 64 位串
  - Shell 页面同样场景 → 出错行以 `企微BOT` 开头，不含 64 位串
- [ ] 上述用例全部通过；`tests/module-dependencies.test.ts`、`tests/module-layout.test.ts` 通过
- [ ] 与界面预览 `.bb-spec/.cache/ui-preview/2026-10-28.daemon-auto-replace.html` 的 ①–⑤ 逐项对照文字和颜色一致
