---
name: startup-trust-prompt
description: pi 启动时项目有角色定义、授信记录为空且 pi 自己不问，弹窗问信任 / 不信任 / 以后再说
---
# 启动时问授信

## 目标
用户在一个只带 `.pi/agents` 定义、从没授信过的项目里启动 pi 时，被弹窗问一次是否信任，选择记进授信记录。

## 业务规则（来源：PRD startup-trust-prompt）
术语：授信记录 = pi 在 `~/.pi/agent/trust.json` 里给项目记的决定（信任 / 不信任 / 空），读用 `readProjectTrust`。项目 = `primaryWorktreeRoot(ctx.cwd)`（主仓库根，不在 Git 里时是启动目录），和设置页同一套。项目层定义 = 项目 `.pi/agents/` 下 `.md` 文件，N 为份数。pi 会问授信的文件 = pi 导出的 `hasTrustRequiringProjectResources(ctx.cwd)` 为 true 的情况（pi 1.5.0：`.pi/settings.json`、`.pi/mcp.json`、`.pi/extensions`、`.pi/skills`、`.pi/prompts`、`.pi/themes`、`.pi/SYSTEM.md`、`.pi/APPEND_SYSTEM.md`、当前或上级目录的 `.agents/skills`）。

- C-1 五条同时满足才弹：`session_start` 的 `reason === "startup"`；`ctx.hasUI` 为 true；授信记录为"空"；N ≥ 1；`hasTrustRequiringProjectResources(ctx.cwd)` 为 false。任一不满足不弹、不写文件、不提示。
- C-2 用 `chooseWindow`（警告色）：标题 `要信任这个项目吗？`；lines 依次 `项目：<tilde(项目路径)>`、`项目里有角色定义，项目受信任后才会生效。`、灰色 `你的选择会记进 pi 的授信记录，和在 pi 里输入 /trust 一样。`；选项 `信任`（`项目层马上生效，以后不再问`）、`不信任`（`项目层不加载，以后不再问；要改时输入 /trust`）、`以后再说`（`这次不加载，下次启动 pi 时再问`），都不标推荐，默认光标在 `信任`；提示行末段是 `Esc 以后再说`（用 `escapeHint`），完整为 `↑↓ 选择 · 回车确认 · Esc 以后再说`。不列定义名字和文件。
- C-3 选"信任"：项目记为 true；`ctx.ui.notify` 绿字（`ctx.ui.theme.fg("success", …)`）`✓ 已把本项目设为受信任，项目层的 N 份定义已生效`。守护进程和设置页每次都现读 trust（`src/app/daemon/lifecycle.ts:531-534`、`settings-extension.ts`），之后打开的设置页、PM 和子代理自然按信任读取，不需要额外通知。
- C-4 选"不信任"：项目记为 false；灰字（`theme.fg("muted", …)`）`已把本项目记为不信任，项目层的定义不加载；要改时在 pi 里输入 /trust`。
- C-5 选"以后再说"或 Esc（`chooseWindow` 返回 undefined 也按此处理）：不写文件；灰字 `这次没有加载项目层的 N 份定义，下次启动 pi 时再问`。
- C-6 写 `trust.json` 失败：记录不变；`notify(…, "error")` 红字 `✗ 没有记下你的选择：<错误信息第一行>`。
- C-7 36～80 列下窗口和提示每行不超宽（`chooseWindow` 已折行；notify 文字由 pi 折行）。
- 决策理由：只带 `.pi/agents` 的项目 pi 不问授信，用户不打开设置页就不知道定义没生效；完全没有定义的项目不打扰；pi 自己会问的项目不重复问（pi 窗口有"只信任这一次"选项，不写记录）；三个选项不标推荐，信任与否只能由用户判断。都由用户 2026-11-10 决定。

## 涉及文件
- 修改 `src/modules/settings/project-trust.ts`
- 新建 `src/modules/settings/startup-trust-extension.ts`
- 修改 `src/app/extension/index.ts`
- 新建 `tests/startup-trust-prompt.test.ts`（测试由 Test Agent 写）

## 函数清单
### src/modules/settings/project-trust.ts
| 函数名 | 职责 |
|---|---|
| `distrustProject`（新） | 把项目在 `trust.json` 里记为 false（`ProjectTrustStore.set(root, false)`），供"不信任"使用 |

### src/modules/settings/startup-trust-extension.ts
| 函数名 | 职责 |
|---|---|
| `startupTrustExtension`（默认导出） | 注册 `session_start` 处理：按 C-1 判断后调 `askProjectTrust` |
| `askProjectTrust` | 弹 C-2 窗口，按选择写授信记录并发 C-3～C-6 的提示 |
| `projectDefinitionCount` | 数项目 `.pi/agents/` 下 `.md` 文件份数，目录不存在或读不了时为 0 |

### src/app/extension/index.ts
| 函数名 | 职责 |
|---|---|
| `registerExtensions` | 在现有子扩展之后加上 `startupTrustExtension(pi)` |

## 协作关系
pi 启动 → `session_start`（`event.reason`、`ctx.hasUI`、`ctx.cwd`、`ctx.ui`）→ `startupTrustExtension` 处理函数 → `primaryWorktreeRoot`（`src/core/storage/identity.ts`）、`readProjectTrust`、`projectDefinitionCount`（`projectRoleDir` 来自 `src/modules/agents/roles.ts`）、`hasTrustRequiringProjectResources`（`@earendil-works/pi-coding-agent` 导出）→ `askProjectTrust` → `chooseWindow`（`src/core/host/question-window.ts`）→ `trustProject` / `distrustProject` → `ctx.ui.notify`。`agentDir` 取法和设置页一致：`dirname(dataRoot(process.env))`。模块依赖只能往下引用（core、agents、settings 本身），`src/app/extension/index.ts` 引用 settings 模块符合架构测试的顺序。外部依赖：`~/.pi/agent/trust.json`。

## 验证方式
- 测试入口：`src/modules/settings/startup-trust-extension.ts` 的默认导出，传入假 `pi`（只实现 `on(event, handler)`，记下 `session_start` 处理函数），再用假事件 `{ type: "session_start", reason }` 和假 `ctx`（`hasUI`、`cwd`、`ui.custom` 驱动窗口按键、`ui.notify` 记录消息、`ui.theme.fg` 打标记）调用处理函数；窗口驱动方式参考 `tests/examples-command.test.ts`。`PI_CODING_AGENT_DIR` 指向临时目录，项目为临时 Git 仓库。
- 测试输入 / 预期结果：
- [ ] 五个条件都满足（startup、有界面、无 trust 记录、`.pi/agents/` 下 5 份 `.md`、无 pi 会问的文件）时弹窗；分别改成 `reason` 为 `new`/`resume`、`hasUI: false`、trust 为 true/false、`.pi/agents/` 为空或不存在、仓库里有 `.pi/settings.json`、仓库上级目录有 `.agents/skills`，都不弹窗、不写文件、不 notify（AC-1）
- [ ] 窗口标题、三行文字、三个选项及说明、默认光标、提示行符合 C-2，没有"推荐"，没有定义名（AC-2）
- [ ] 选"信任"：`trust.json` 里仓库为 true，notify 文字是 C-3 写法且带 success 色（AC-3）
- [ ] 选"不信任"：仓库为 false，notify 是 C-4 写法且带 muted 色（AC-4）
- [ ] 选"以后再说"、按 Esc：`trust.json` 不存在或不变，notify 是 C-5 写法（AC-5）
- [ ] `trust.json` 所在目录只读时选"信任"：记录仍为空，notify 级别为 error，文字 `✗ 没有记下你的选择：` 加原因第一行（AC-6）
- [ ] 36、44、60、80 列下窗口每行显示宽度不超过终端宽度（AC-7）
- [ ] `tests/extension-entry.test.ts`、`tests/module-dependencies.test.ts` 等现有入口和架构测试仍通过
