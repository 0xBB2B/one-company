---
name: startup-trust-gate
description: 会话开始时按授信记录决定 OneCompany 启用或停用，空就弹窗问；停用时所有子扩展的事件、命令、工具统一拦住
---
# 启动时授信与停用

## 目标
OneCompany 只在会话开始时授信记录为"信任"的项目里启用；pi 刚启动、有界面、记录为空时弹窗问；其他情况本次会话停用，子扩展全部不起作用，`/one:` 命令只回一行说明。

## 业务规则（来源：PRD startup-trust-gate）
术语：项目 = `primaryWorktreeRoot(ctx.cwd)`（主仓库根，不在 Git 里时是启动目录）；授信记录用 `readProjectTrust`（`src/core/host/project-trust.ts`，由 plan 01 提供）读，四种：信任 / 不信任 / 空 / 读不了。`<文件>` = `tilde(trustFilePath(agentDir))`，`<原因>` = 错误第一行；`agentDir = dirname(dataRoot(process.env))`。
- C-1 每次 session_start（startup、new、resume、fork、reload）按记录决定本次会话启用（信任）或停用（其他）。会话开始后记录变了，本次不变。
- C-2 停用：不连接 / 拉起守护进程、不显示状态面板、不注入规则、OneCompany 工具对模型不可用；pi 自带工具和命令照常。启用时一切和现在一样。
- C-3 只在 reason 为 startup + `ctx.hasUI` + 记录为空时弹窗；无界面时不弹窗不提示；new/resume/fork/reload 不弹窗；弹窗前按停用。
- C-4 弹窗（`chooseWindow`，警告色）：标题 `要在这个项目里使用 OneCompany 吗？`；lines：`项目：<项目路径，家目录 ~>`、`OneCompany 只在受信任的项目里运行。信任后，项目里的 .pi 设置、角色定义和 skill 也会一起生效。`、muted `你的选择会记进 pi 的授信记录，和在 pi 里输入 /trust 一样。`；choices：`信任`（`启用 OneCompany，以后不再问`）、`不信任`（`这个项目不用 OneCompany，以后不再问；要改时输入 /trust`）、`这次不用`（`这次不启用，下次启动 pi 时再问`），不标推荐，默认光标在信任；`escapeHint: "Esc 这次不用"`。
- C-5 信任 → `trustProject`，启用，`theme.fg("success")` 绿字 `✓ 已把本项目设为受信任，OneCompany 已启用`。
- C-6 不信任 → `distrustProject`，停用，muted `OneCompany 在这个项目停用：已记为不信任。要用时在 pi 里输入 /trust 选 Trust，再重开 pi`。
- C-7 这次不用 / Esc → 不写，停用，muted `OneCompany 这次没有启用，下次启动 pi 时再问`。
- C-8 写失败 → 记录不变，停用，error 色 `✗ 没有记下你的选择：<原因>；OneCompany 这次没有启用`。
- C-9 有界面、记录为不信任 → 不弹窗，停用，muted `OneCompany 在这个项目停用：你选过不信任这个项目。要用时在 pi 里输入 /trust 选 Trust，再重开 pi`。
- C-10 有界面、记录读不了 → 不弹窗，停用，error 色 `✗ OneCompany 在这个项目停用：读不了授信记录 <文件>：<原因>；改好这个文件后重开 pi`。
- C-11 有界面、new/resume/fork/reload 且记录为空 → 停用，muted `OneCompany 这次没有启用，下次启动 pi 时再问`。
- C-12 停用时任何 `/one:` 命令 → 不执行原命令，`ctx.ui.notify` 一行：空 → muted `OneCompany 在这个项目停用：项目还没授信。重开 pi 时在弹窗里选信任即可启用`；不信任 → muted `OneCompany 在这个项目停用：你选过不信任这个项目。要用时在 pi 里输入 /trust 选 Trust，再重开 pi`；读不了 → error 色 C-10 那句。按会话开始时的记录写。
- C-13 所有提示用 `ctx.ui.notify(theme.fg(...))`，不传 `"error"` 级别（pi 会加 `Error: ` 前缀）；36～80 列不超宽（`chooseWindow` 自带折行）。
- 依据：pi 按注册顺序逐个 await 事件处理函数（`node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/runner.js:112-114`），所以授信判断注册在最前面即可先于其他子扩展完成；pi 没有注销命令的接口，工具用 `pi.setActiveTools` 隐藏（`docs/extensions.md`）。OneCompany 派出的子代理会话 `noExtensions: true`（`src/modules/agents/agent-session.ts:199`），不受影响。

## 涉及文件
- 新建 `src/app/extension/trust-gate.ts`
- 新建 `src/modules/settings/startup-trust.ts`（取代 `startup-trust-extension.ts`）
- 删除 `src/modules/settings/startup-trust-extension.ts`
- 修改 `src/app/extension/index.ts`
- 修改测试素材：`tests/acceptance/helpers/installed-host.ts`、`tests/helpers/project-index-installed-fixture.ts`、`tests/integration/knowledge-query.test.ts`、`tests/integration/sdk-loading.test.ts`、`tests/installation/*.test.ts` 等经过 `src/app/extension/index.ts` 的测试，启动前给样例仓库写好授信记录（由 Test Agent 改）

## 函数清单
### src/modules/settings/startup-trust.ts
| 函数 | 职责 |
|---|---|
| `resolveSessionTrust` | 给定 session_start 的 event 和 ctx：读记录，按 C-3～C-11 决定是否弹窗、写记录、发提示，返回本次会话是否启用以及停用原因（空 / 不信任 / 读不了 + 原因文字） |
| `askProjectTrust` | 弹 C-4 窗口并按 C-5～C-8 写记录、发提示（由现有 startup-trust-extension.ts 的同名函数改写） |
| `disabledNotice` | 按停用原因给出 C-12 那一行（文字和颜色） |

### src/app/extension/trust-gate.ts
| 函数 | 职责 |
|---|---|
| `createTrustGate` | 用真实 `pi` 先注册一个 session_start 处理，调 `resolveSessionTrust` 记下本次会话的启用状态；返回一个包了一层的 `pi` 给子扩展用：`on(event, handler)` 注册的处理在停用时直接返回不执行；`registerCommand` 注册的命令在停用时只发 `disabledNotice`；`registerTool` 照常注册并记下工具名，停用时在 session_start 里用真实 `pi.setActiveTools` 把这些工具从可用列表里去掉；其余属性原样转发 |

### src/app/extension/index.ts
| 函数 | 职责 |
|---|---|
| `registerExtensions` | 第一步 `createTrustGate(pi)`，之后所有子扩展都用它返回的 `pi`；去掉 `startupTrustExtension` |

## 协作关系
pi → `registerExtensions` → `createTrustGate`（真实 pi 上最先注册的 session_start）→ `resolveSessionTrust`（`readProjectTrust`、`trustProject`、`distrustProject`、`trustFilePath` 来自 `src/core/host/project-trust.ts`；`chooseWindow`、`mutedLines` 来自 `src/core/host/question-window.ts`；`primaryWorktreeRoot`、`dataRoot` 来自 `src/core/storage`；`tilde` 来自 `settings-page-ui.ts`）→ 之后各子扩展的处理经包装层按启用状态执行或跳过。

## 验证方式
- 测试入口：
  - `src/app/extension/trust-gate.ts` 的 `createTrustGate(pi)`：传入假 pi（记录 `on`、`registerCommand`、`registerTool`、`setActiveTools`、`getActiveTools` 调用），在返回的包装 pi 上注册假的子扩展处理、命令、工具，再用假事件 `{ type: "session_start", reason }` 和假 ctx（`hasUI`、`cwd`、`ui.custom` 驱动窗口、`ui.notify`、`ui.theme.fg`）依次调用真实 pi 上登记的 session_start 处理函数。
  - 弹窗按键驱动参考现有 `tests/startup-trust-prompt.test.ts`（改写为针对新入口，旧用例按新规则删改）。
  - `PI_CODING_AGENT_DIR` 指向临时目录，项目为临时 Git 仓库。
- 预期结果：
- [ ] 记录为信任：各 reason 下都启用，子扩展的 session_start 处理被执行、命令正常执行、工具不被移出可用列表（AC-1、AC-2）
- [ ] 记录为空 / 不信任 / 读不了：停用，子扩展处理不执行、命令只发说明、OneCompany 工具被移出可用列表、pi 自带工具保留（AC-1、AC-2）
- [ ] 启用后把记录改成不信任，同一会话里子扩展处理仍执行（AC-1）
- [ ] startup + 有界面 + 空 才弹窗；无界面、new/resume/fork/reload 不弹（AC-3）
- [ ] 弹窗文字、选项、默认光标、提示行符合 C-4，无"推荐"（AC-4）
- [ ] 信任 / 不信任 / 这次不用 / Esc / 写失败（文件只读、目录可写）各自的记录与提示符合 C-5～C-8（AC-5～AC-8）
- [ ] 记录不信任、读不了（写坏、目录只读）启动不弹窗，提示符合 C-9、C-10；空 + reload 符合 C-11（AC-9～AC-11）
- [ ] 三种停用原因下执行命令，原命令不执行，提示符合 C-12（AC-12）
- [ ] 所有提示 `notify` 第二参数不是 "error"；36、44、60、80 列下弹窗每行不超宽（AC-13）
- [ ] `tests/extension-entry.test.ts`、`tests/module-layout.test.ts`、`tests/module-dependencies.test.ts` 通过；经过扩展入口的集成 / 安装测试在样例仓库写好授信记录后通过
