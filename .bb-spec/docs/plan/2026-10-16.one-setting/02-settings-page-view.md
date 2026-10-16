---
name: settings-page-view
description: 设置页视图：左边目录右边内容、窄于 60 列轮流显示、角色定义/模型/开关/问题四类右栏
---
# 设置页视图 SettingsPageView

## 目标
新建 `runtime/settings-page-ui.ts` 的 `SettingsPageView`，取代 `/one:agents` 的 `AgentCatalogView`：一个视图里有目录和右栏，能浏览定义、复制命名、改模型、改 Git 交付开关、看问题，36 到 80 列都不超宽。

## 业务规则（来源：PRD layout-navigation、definitions-and-models、git-delivery-switch）
- **宽终端（≥ 60 列）**：依次是上边框 `─`；第一行 " 设置"（accent 粗体），右侧 "/one:setting "（muted）；项目未受信任时下一行是 " ! 项目未受信任：项目层的定义和设定都没有生效"（warning 色）；分隔线 20 个 `─` + `┬` + 其余 `─`（dim）；每行 = 20 列目录格 + `│`（dim）+ 右栏格；分隔线用 `┴`；底部说明；按键提示；下边框。
- **目录**：" 角色定义"（muted 粗体）；worker、reviewer、qa、explore、prototype 各一行，写可用定义份数；空行；" 设定"；「模型」写 3；「开关」写 1；有问题时再空一行 + 「问题」（error 色）写条数（含项目未受信任那一条）；没有问题时这两行都不出现。
- **光标与焦点**：光标符号 ` ▸ `，展开后 ` ▾ `。焦点在目录：目录选中行铺 selectedBg；焦点在右栏：目录选中行 accent 粗体、不铺底色，右栏选中行铺 selectedBg。
- **按键**：目录里 ↑↓ 换分类（跳过标题和空行），右栏随之换内容；→ 或回车进右栏（光标停在第一行）。右栏里 ← 回目录；↑↓ 选行；回车：职责分类和问题里展开/收起，模型和开关里进入修改步骤；C 只在职责分类有效；R 只在模型和开关有效。列表状态下 Esc 关闭页面（调 `onClose`）；修改步骤和复制命名里 Esc 逐步退回或取消。
- **右栏第一行**：分类名（accent 粗体）+ 两空格 + 说明（dim）。说明：worker"写代码"，reviewer"代码审查：实现是否合理"，qa"功能验收：行为是否符合目标"，explore"只读查资料"，prototype"需求涉及界面时出 HTML 原型"，模型"PM 和两个内部代理用哪个模型"，开关"可选功能，默认都关闭"，问题"这些文件写错了，没有生效"。第二行空，第三行表头。
- **各分类表格**：职责"名称 来源 模型 思考"，排序、来源标签、"跟随主会话""跟随"写法、详情五行（说明/skills/MCP/正文/文件）同原 `/one:agents`；模型"名称 来源 模型 思考"三行，不可用时模型列红字"<模型> 不可用"；开关"名称 来源 状态"一行"Git 交付"，状态"开启"（success）或"关闭"（dim）；问题"文件 层 原因"，原因 error 色（未受信任那条 muted），展开依次是原因、现在是（有原样写法时，error 色）、影响、文件。
- **底部说明**：焦点在目录时写分类说明——职责"<职责>：<说明> · N 份定义（<各层份数>）"（各层按项目、用户、内置，只写份数 > 0 的层，如"worker：写代码 · 2 份定义（用户 1 · 内置 1）"）；模型"模型：PM 和两个内部代理用哪个模型"；开关"开关：可选功能，默认都关闭"；问题"问题：这些文件写错了，没有生效"。焦点在右栏时写选中行说明：定义同原页面；模型同原设定栏（用途 · 来源 · 生效时机，不可用时红字）；开关"Git 交付：开启后主代理可以替你提交归档、推送并建 PR · <内置默认值/来自用户层/来自项目层> · 立即生效"；问题同原问题栏。有提示（notice）时显示提示代替说明：ok 用 success 色、muted 用 muted 色、error 用 error 色。放不下时折行。
- **按键提示**：目录"↑↓ 选分类  → 进右栏  Esc 退出"；职责"← 回左栏  ↑↓ 选择  回车 详情  C 复制  Esc 退出"（展开后"回车 收起"）；模型和开关"← 回左栏  ↑↓ 选择  回车 修改  R 清除本层  Esc 退出"；问题"← 回左栏  ↑↓ 选择  回车 详情  Esc 退出"（展开后"回车 收起"）；修改步骤和命名沿用原有提示。放不下时按两个空格分组折行，一组不拆。
- **修改模型**：三步（模型 → 思考等级 → 存到哪一层）在右栏里显示，标题、选项、✓、灰掉的等级、项目层不可选、Esc 退回、取消提示"已取消修改"、R 清除、内置时"已经是内置默认值"，全部沿用原设定栏。
- **修改开关**：第 1 步标题"修改 Git 交付" + dim"第 1 步，共 2 步"，选项"开启"（主代理可以替你提交归档、推送并建 PR）/"关闭"（推送和合并由你自己做），现值打 ✓，光标默认在另一项；第 2 步标题"Git 交付 改为<开启/关闭>，存到哪一层" + "第 2 步，共 2 步"，选层选项同模型；Esc 退回，第 1 步 Esc 取消并提示"已取消修改"；R 在来源为内置时提示"已经是内置默认值"、否则调清除回调。
- **复制命名**：右栏第一行"复制 <名字> 为新定义"，下面" 新名称  <文字>█"，默认"<名字>-copy"，名字规则灰字、错误红字、重名检查同原页面；回车合规后调 `onCopy`；Esc 回列表并提示"已取消复制"。
- **窄终端（< 60 列）**：焦点在目录时只画目录（占满宽度），提示"↑↓ 选分类  → 进入  Esc 退出"；焦点在右栏时只画右栏，第一行" 设置 › <分类名>"，修改步骤里" 设置 › <分类名> › <角色名或 Git 交付>"，命名时" 设置 › <职责> › 复制"；提示里"← 回左栏"换成"← 回目录"。列宽随宽度收窄，放不下的文字末尾用 … 截断。
- **宽度**：36 到 80 列下每个画面每一行的显示宽度 ≤ 终端宽度。
- 页面高度：目录和右栏取各分类里最高的那个补齐空行，切换分类时页面高度不跳。

## 涉及文件
- 新建 `runtime/settings-page-ui.ts`
- 修改 `runtime/agent-settings-ui.ts`（`SettingsTab` 改成能画在给定宽度的右栏里、光标改 ▸，按键提示交给页面）
- 新建 `tests/settings-page-ui.test.ts`；`tests/agent-catalog-ui.test.ts`、`tests/agent-settings-ui.test.ts` 里视图层的用例迁过来改写后删除这两个文件中对应部分（页面层用例由 settings-command 计划处理）

## 函数清单
### runtime/settings-page-ui.ts
| 函数名 | 职责 |
|---|---|
| `SettingsPageView`（类） | 页面状态（分类、焦点、光标、展开、命名、提示）与按键分发 |
| `SettingsPageView.render` | 按宽度选宽/窄布局，拼出整页 |
| `SettingsPageView.handleInput` | 按焦点和当前状态处理按键 |
| `SettingsPageView.state` | 导出当前分类、焦点、选中行，供保存/复制后重开页面时还原 |
| `navRows` | 画目录各行 |
| `definitionPane` / `problemPane` / `switchPane` | 画三类右栏（模型右栏用 `SettingsTab`） |
| `SwitchPicker`（类） | 开关的两步修改 |
| `categoryFooter` / `hintFor` | 底部说明和按键提示 |
### runtime/agent-settings-ui.ts
| `SettingsTab.renderList` / `renderPicker` / `footer` | 修改：按传入宽度画，光标 ▸，不再自带按键提示 |

## 协作关系
`SettingsPageView` 只回调，不读写文件：`onCopy`、`onSaveSetting`、`onClearSetting`、`onSaveSwitch`、`onClearSwitch`、`onClose`；由 `extensions/settings.ts` 落盘后重开页面。复用 `wrapText`、`wrapHint`、`fit`、`pad`（agent-settings-ui.ts）和 `tilde`、`NAME_PATTERN`。

## 验证方式
- 测试入口：`new SettingsPageView(options)`，`render(width): string[]`、`handleInput(data)`、`state()`。options：`catalog`（`loadRoleCatalog` 结果）、`theme`（`{ fg(kind,text), bg(kind,text), bold(text), inverse(text) }`）、`projectTrusted`、`untrustedProjectCount`、`state?`（`{ section?: "worker"|"reviewer"|"qa"|"explore"|"prototype"|"models"|"switches"|"problems", focus?: "nav"|"pane", selectName?, fresh?, notice?: { tone: "ok"|"muted"|"error", text } }`）、`settings`（`readAgentSettings` 结果，含 `gitDelivery`）、`models`、`mainModel`、`mainThinking`、`nameTaken(name)`、`onCopy({ entry, name })`、`onSaveSetting({ role, model, thinking, layer })`、`onClearSetting({ role, layer })`、`onSaveSwitch({ enabled, layer })`、`onClearSwitch({ layer })`、`onClose()`。按键用 `\x1b[A` 上、`\x1b[B` 下、`\x1b[C` 右、`\x1b[D` 左、`\r` 回车、`\x1b` Esc。
- 测试输入：临时目录里的三层定义和两层设置文件；宽度 36、44、56、59、60、80。
- 预期结果：
- [ ] 80 列打开：目录顺序、份数、无问题时没有「问题」和它上面的空行；第一行含"设置"和"/one:setting"；目录 worker 行带 ▸。
- [ ] 有写错的定义 + 设置问题时「问题」写条数；未受信任时多黄字行且条数 +1。
- [ ] ↓ 到模型后右栏三行；→ 后提示变成模型那组；← 回目录；目录 Esc 调 `onClose`。
- [ ] 八个分类的右栏第一行与说明文字一致；目录焦点下底部说明与规则一致。
- [ ] 职责回车展开出现五行详情、光标变 ▾；C → 命名画面 → 非法名红字 → 合规名触发 `onCopy`；Esc 提示"已取消复制"。
- [ ] 模型三步走完触发 `onSaveSetting`，请求内容同原设定栏；R 的两种情况同原设定栏。
- [ ] 开关：两步走完触发 `onSaveSwitch({ enabled: true, layer: "user" })`；未受信任时项目层不可选；R 内置时提示、否则触发 `onClearSwitch`。
- [ ] 44 列：只有目录、无 `│`；→ 后首行"设置 › 模型"、提示含"← 回目录"；回车后首行"设置 › 模型 › PM"。
- [ ] 36/44/56/59/60/80 列下所有上述画面每一行 `visibleWidth` ≤ 宽度；提示折行不拆组。
- [ ] `state()` 在右栏选中解释器时返回 `{ section: "models", focus: "pane", selectName: "interpreter" }`，用它构造新视图后光标还原。
