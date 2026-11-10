---
name: settings-trust-entry
description: 设置页「问题」里授信记录为空的那一条按回车，弹确认窗口，确认后写授信记录并按受信任重开页面
---
# 设置页里设为受信任

## 目标
授信记录为"空"时，用户在 `/one:setting` 的「问题」里选中授信那一条按回车，经确认窗口后把项目设为受信任，设置页当场按受信任重新显示。

## 业务规则（来源：PRD settings-trust-entry）
术语：授信记录 = pi 在 `~/.pi/agent/trust.json` 里给项目记的决定（信任 / 不信任 / 空）。项目 = 主仓库根目录（不在 Git 里时是启动目录），即 `settings-extension.ts` 里现有的 `repositoryRoot`。授信那一条 = 「问题」里 `catalog.problems` 中 `kind: "untrusted"` 生成的那一行（总在第一行）。N = 项目 `.pi/agents/` 下 `.md` 份数，即现有的 `untrustedProjectCount`。

- C-1 记录为"空"、光标在授信那一条：按键提示 `←/Esc 回左栏  ↑↓ 选择  回车 设为受信任`（窄于 60 列时"回左栏"写"回目录"，沿用 `hintFor` 现有替换）；底部说明 `按回车把本项目设为受信任，项目层的 N 份定义就会生效`，N 为 0 时 `按回车把本项目设为受信任，项目层的定义就会生效`。「问题」其他行的提示和回车行为不变（`回车 详情/收起`）。
- C-2 记录为"空"时在授信那一条按回车：设置页关闭，用 `chooseWindow`（警告色，和复制选层窗口同一种）弹窗。标题 `把这个项目设为受信任？`；lines 依次：`项目：<tilde(项目路径)>`（普通色）、`设为受信任后，项目里的 .pi 设置和角色定义都会生效。`（普通色）、`和在 pi 里输入 /trust 选 Trust 一样，会记进 pi 的授信记录。`（灰色）；选项 `设为受信任`（description `记进授信记录，项目层马上生效`）、`取消`（description `不改授信记录，回到设置页`），默认光标在第一项、不标推荐；提示行 `↑↓ 选择 · 回车确认 · Esc 取消（不改授信记录）`（用 `cancelNote: "不改授信记录"`）。窗口里不列定义名字和文件。
- C-3 选"设为受信任"且此刻记录仍为"空"：`trustProject` 写 true；重开设置页：黄字和授信那一条消失（「问题」无其他行时整个分区消失，这是现有行为，重读 trust 即可）；焦点在左栏、选中 worker；所有角色分区里 `source === "project"` 的定义名字显示为绿色，按任意键后恢复；底部绿字 `✓ 已把本项目设为受信任，项目层的 N 份定义已生效`，N 为 0 时 `✓ 已把本项目设为受信任`。
- C-4 选"设为受信任"时记录已是"信任"：不写文件，页面和提示同 C-3。已是"不信任"：不写文件，回到「问题」授信那一条（焦点右栏），红字 `✗ 没有设为受信任：你在 pi 里选过不信任这个项目，先输入 /trust 选 Trust`。
- C-5 写 `trust.json` 失败：记录不变，回到「问题」授信那一条，黄字还在，红字 `✗ 没有设为受信任：<错误信息第一行>`。
- C-6 选"取消"或 Esc：不写文件，回到「问题」授信那一条，灰字 `已取消，授信记录没有改`。
- C-7 记录为"不信任"时授信那一条行为完全不变：回车展开/收起，提示 `回车 详情/收起`，底部说明沿用现有 `在 pi 里把这个项目设为受信任后，项目层的 N 份定义就会生效`。
- C-8 36～80 列下新增或改动的每行都不超宽，放不下折行（现有 `wrapText`/`wrapHint`/`chooseWindow` 已折行，不要用截断）。
- 决策理由：只在"空"时开放，尊重用户在 pi 里选过的"不信任"；先确认再写，避免陌生仓库被一键放行；窗口只写项目路径和一句说明，用户 2026-11-10 决定不逐个列出。

## 涉及文件
- 修改 `src/modules/settings/settings-page-ui.ts`
- 修改 `src/modules/settings/settings-extension.ts`
- 修改 `tests/settings-page.test.ts`、`tests/settings-page-ui.test.ts`（测试由 Test Agent 写）

## 函数清单
### src/modules/settings/settings-page-ui.ts
| 函数名 | 职责 |
|---|---|
| `PageState`（类型） | `fresh` 改为能带多个名字，用来让多份项目层定义一起显示绿色 |
| `SettingsPageView` 构造参数 | 新增回调 `onTrustProject`，用户在授信那一条（记录为空）按回车时调用 |
| `SettingsPageView.handleInput` | 右栏在「问题」、光标在授信那一条、`projectTrust === "unset"` 时，回车调 `onTrustProject`，不再切换展开；其他情况不变 |
| `SettingsPageView.problemRows` | 记录为空时授信那一条的 footer 改为 C-1 的写法；不信任时保持现有写法 |
| `SettingsPageView.hintFor` | 光标在授信那一条且记录为空时，回车那一段写 `回车 设为受信任` |
| `SettingsPageView.definitionPane` / 模型、开关里用到 `fresh` 的地方 | 按新的 `fresh`（多个名字）判断是否显示绿色，单个名字的现有用法行为不变 |
| `SettingsPageView.state` / 构造里恢复状态 | 让 `focus: "nav"` + `section: "worker"` 的状态能把左栏光标落在 worker |

### src/modules/settings/settings-extension.ts
| 函数名 | 职责 |
|---|---|
| `openSettingsPage` 里的 `Picked` 联合类型 | 增加"设为受信任"这一种结果 |
| `openSettingsPage` 循环里新增分支 | 收到"设为受信任"：用 `chooseWindow` 弹 C-2 的窗口；按结果走 C-3～C-6，算出下一轮的 `state`（section、focus、selectName、fresh、notice） |
| `confirmProjectTrust`（新，文件内） | 弹 C-2 窗口并按选的那一刻的 `readProjectTrust` 结果写 / 不写 `trustProject`，返回成功、已不信任、写失败（带原因）、取消四种结果之一 |

## 协作关系
`SettingsPageView.handleInput` → `onTrustProject` → `openProgramWindow` 的 `done({ trust, state })` → `openSettingsPage` 循环 → `confirmProjectTrust` → `chooseWindow`（`src/core/host/question-window.ts`）、`readProjectTrust` / `trustProject`（`project-trust.ts`，不改）→ 下一轮循环重读 trust、catalog、settings 并用新 `state` 打开页面。成功时 `fresh` 取重读后 `catalog.roles` 里 `source === "project"` 的定义名。外部依赖：`~/.pi/agent/trust.json`（pi 的 `ProjectTrustStore`）。

## 验证方式
- 测试入口：`openSettingsPage(ctx, { mainThinking })`（`src/modules/settings/settings-extension.ts`），沿用 `tests/settings-page.test.ts` 的 `scripted` 按键驱动方式（`ctx.ui.custom` 渲染页面和窗口、按键序列、读屏）；`PI_CODING_AGENT_DIR` 指向临时目录，项目是临时 Git 仓库，`.pi/agents/` 下放若干份定义；`trust.json` 用 `{ "<仓库路径>": true|false }` 或不存在表示空。
- 测试输入 / 预期结果：
- [ ] 记录为空、5 份定义：进「问题」，授信那一条的按键提示含 `回车 设为受信任`，底部是 C-1 写法；0 份定义时底部没有 N 份；「问题」里另一行（如写错的定义）提示是 `回车 详情`（AC-1）
- [ ] 回车后窗口的标题、三行文字、两个选项及说明、默认光标、提示行符合 C-2，窗口文字里不含定义名（AC-2）
- [ ] 选"设为受信任"：`trust.json` 里仓库为 true；重开页面无黄字、无「问题」分区、左栏选中 worker、项目层定义名带 success 色、底部绿字 C-3 写法；再按一个键后 success 色消失；仓库里另有写错的定义时「问题」还在、授信那一条消失（AC-3）
- [ ] 窗口打开后把 `trust.json` 改成 true 再确认：文件内容不变、页面同上；改成 false 再确认：仍为 false、红字 C-4 写法（AC-4）
- [ ] `trust.json` 所在目录只读时确认：记录仍为空、停在授信那一条、黄字还在、红字 `✗ 没有设为受信任：` 加原因第一行（AC-5）
- [ ] 选"取消"、按 Esc：`trust.json` 不变、停在授信那一条、灰字 `已取消，授信记录没有改`（AC-6）
- [ ] 记录为 false：回车展开详情、再回车收起，不弹窗，提示和底部说明为 C-7 写法（AC-7）
- [ ] 36、44、60、80 列下上述画面每行显示宽度不超过终端宽度（AC-8）
