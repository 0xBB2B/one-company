---
name: settings-command
description: 注册 /one:setting、删 /one:agents，设置页落盘与工具刷新，改给模型看的报错文字和 README 命令表
---
# /one:setting 命令与设置页接线

## 目标
`/one:setting` 打开 `SettingsPageView`，保存、清除、复制都落盘并刷新页面；开关改动后当前窗口工具列表立刻更新；旧命令和旧页面代码删除，相关文字改到新命令。

## 业务规则（来源：PRD layout-navigation、definitions-and-models、git-delivery-switch）
- 注册 `one:setting`（描述"打开设置页"）；不再注册 `one:agents`。没有交互终端（`!ctx.hasUI || ctx.mode !== "tui"`）时提示"需要交互终端才能打开设置页"，不打开。`one:ps` 不变。
- 页面循环沿用现有 `openSettingsPage` 的做法：在程序窗口里打开视图，用户触发保存/清除/复制后关窗、落盘、带着 `state()` 重开。打开时没有带状态，视图默认焦点在目录、分类 worker。
- 模型保存/清除的成功提示文字不变；**失败时**提示改成 error 色，文字"✗ 没有保存：<错误信息首行>"。
- 开关保存：调 `saveGitDeliverySetting` 写所选层；成功提示"✓ Git 交付 改为<开启/关闭>，存到<项目层/用户层>，立即生效"（ok）；然后重读设置，按新的生效值调 `showGitDeliveryTool`。
- 开关清除：调 `clearGitDeliverySetting`；成功提示"✓ 已清除<项目层/用户层>的 Git 交付 设定，现在用<说明>"，说明为"内置默认值：关闭"或"<用户层/项目层>的值：<开启/关闭>"；然后同样刷新工具列表。失败时同上用 error 色"✗ 没有保存：…"。
- 保存或清除后重开页面时，刚改的那一行名字是绿色（`fresh`）。
- 复制流程（选层程序窗口、各类失败提示、成功提示）不变。
- 给模型看的报错文字：`runtime/host-authorization.ts` 的 `internal_model_unavailable` 建议改为"请用户在 /one:setting 的「模型」里检查这个角色的模型，或在主窗口选定模型、在本机配置该模型的凭据；不要自行改用别的模型重试"；`daemon/run-manager.ts` 的 `thinking_unsupported` 建议改为"请用户改选模型，或在 /one:setting 的「模型」里给这个角色设定该模型支持的思考等级"。
- 旧的 pm/解释器/草稿核验器定义列进问题时，底部说明改为"这份定义没有生效，模型和思考等级改在「模型」里"（这段文字在视图里，若 settings-page-view 计划未改到，本计划补上）。
- 主代理提示词 `rules/01-main-session.md` 里"用户用 /one:git-delivery 开启交付工具后"改成"用户在 /one:setting 的开关里开启 Git 交付后"；全仓库（`.bb-spec/docs/prd` 已合并的需求文档除外）不再出现 `/one:agents`、`/one:git-delivery`。
- `resolveRepoRoot` 从 `extensions/settings.ts` 挪到 `runtime/` 下（如 `runtime/git-read.ts`），`extensions/settings.ts` 和 `extensions/git-delivery.ts` 都从那里引用，避免两个扩展文件互相引用。
- README 命令表：删掉 `/one:agents`、`/one:git-delivery` 两行，加一行 `/one:setting`："查看和复制角色定义，改 PM 和两个内部代理的模型，开关 Git 交付"；正文里提到这两个旧命令的地方改成 `/one:setting`（其余文档的整体同步交给收尾的 /doc-update）。
- 删除 `runtime/agent-catalog-ui.ts`（被 `runtime/settings-page-ui.ts` 取代）和只服务它的残留。

## 涉及文件
- 修改 `extensions/settings.ts`、`extensions/commands.ts`、`extensions/git-delivery.ts`（仅在需要时调整导出）
- 修改 `runtime/host-authorization.ts`、`daemon/run-manager.ts`
- 修改 `README.md`、`rules/01-main-session.md`
- 修改 `runtime/git-read.ts`（接收 `resolveRepoRoot`）
- 删除 `runtime/agent-catalog-ui.ts`
- 修改测试：`tests/commands.test.ts`、`tests/extension-entry.test.ts`、`tests/user-documentation.test.ts`（命令来源与期望命令名）、`tests/agents-page.test.ts`（改为设置页的页面层用例，可改名 `tests/settings-page.test.ts`）、`tests/agent-settings-ui.test.ts` 里页面层用例、`tests/program-window-queue.test.ts`、`tests/agent-definition-copy.test.ts`，以及引用两段报错文字的测试

## 函数清单
### extensions/settings.ts
| 函数名 | 职责 |
|---|---|
| `openSettingsPage` | 修改：改用 `SettingsPageView`；处理开关保存/清除；失败提示改 error；选项新增开关改动后的回调 |
### extensions/commands.ts
| `registerCommands` | 修改：注册 `one:setting` 取代 `one:agents`；把开关改动回调接到 `showGitDeliveryTool` |
| `commandsExtension` | 修改：传入真实 `pi` 用于刷新工具列表 |

## 协作关系
`one:setting` → `openSettingsPage` → `SettingsPageView`（回调）→ `saveAgentSetting`/`clearAgentSetting`/`saveGitDeliverySetting`/`clearGitDeliverySetting`/`copyAgentDefinition` → 重开；开关改动 → `readAgentSettings` → `showGitDeliveryTool(pi, enabled)`。

## 验证方式
- 测试入口：`registerCommands(pi, options)`（`options` 含 `openSettingsPage`、`openShellPage`、开关改动回调 `onGitDeliveryChanged(enabled)`）；`openSettingsPage(ctx, { mainThinking, onGitDeliveryChanged })`，ctx 用现有测试的程序窗口假宿主（`tests/helpers/window-host.ts`）驱动按键；`registerExtensions`（extensions/index.ts）配 `tests/helpers/fake-pi.ts`。
- 测试输入：临时 `PI_CODING_AGENT_DIR` 和仓库目录、两层设置文件、各层定义。
- 预期结果：
- [ ] 注册的命令恰好是 `one:setting`、`one:ps`（加 requirement-manage 自己注册的，若有）；没有 `one:agents`、`one:git-delivery`；README 命令表与注册的命令一致。
- [ ] 非 TUI 时提示"需要交互终端才能打开设置页"，不打开。
- [ ] 页面：开关 → 开启 → 用户层后，用户设置文件 `one-company.git-delivery` 为 true，其他内容不变；重开后这一行来源用户、状态开启、名字绿色、底部是保存成功文字；`onGitDeliveryChanged` 收到 true。
- [ ] 页面：开关 R 清除后提示"✓ 已清除用户层的 Git 交付 设定，现在用内置默认值：关闭"，`onGitDeliveryChanged` 收到 false。
- [ ] 页面：用户设置文件不是合法 JSON 时在模型或开关里保存到用户层，底部 error 色"✗ 没有保存："开头并含文件路径，文件不变，页面仍开着。
- [ ] 页面：模型三步保存到项目层、复制定义到用户层的原有页面层用例照样通过（命令名、光标符号、导航按键按新页面调整）。
- [ ] 两段给模型看的报错里是 /one:setting 的「模型」，不再有 /one:agents。
- [ ] 在 README.md、CONTRIBUTING.md、rules/、shared/、role-rules/、skills/、runtime/、daemon/、extensions/ 里搜不到 `/one:agents` 和 `/one:git-delivery`；`rules/01-main-session.md` 写的是在 /one:setting 的开关里开启 Git 交付。
- [ ] `runtime/agent-catalog-ui.ts` 不存在；`pnpm run typecheck` 通过。
