---
name: settings-page-switch
description: 设置页角色定义列表加「状态」列，按空格直接开关定义，详情多「开关」「审查」两行
---
# 设置页的定义开关

## 目标
在 /one:setting 的角色定义列表里能看到每个定义的开关状态，按空格直接开或关，底部提示生效范围。

## 业务规则（来源：PRD definitions-and-switches C-3～C-9）
- 列表表头「名称  来源  状态  模型  思考」。状态：通用定义「必须」（灰）；开启「开启」（绿）；关闭「关闭」（灰，名字也灰）。右栏放不下全部列时先去掉「思考」列，状态列始终保留，任何宽度不超出终端（36 列也要能用）。
- 在非通用定义上按空格直接切换，不弹确认。写到定义文件所在的那一层：来源是内置或用户 → 用户层设置文件；来源是项目 → 项目层设置文件。
- 切换成功：这一行按新状态显示并高亮（fresh），底部绿字「已开启 <名字> · 全局生效」或「已关闭 <名字> · 全局生效」；写到项目层时「全局生效」换成「本项目生效」。
- 开启后另一层列表里仍有这个名字：这一行仍是「关闭」，底部黄字「<名字> 仍是关闭：<用户层或项目层>设置文件里也写了关闭」。
- 写文件失败：什么都不改，底部红字「✗ 没有保存：<原因>」。
- 在通用定义上按空格：不写文件，底部黄字「<名字> 是通用定义，流程离不开它，不能关闭」。
- 操作提示「←/Esc 回左栏  ↑↓ 选择  回车 详情  空格 开关  C 复制」，展开时「详情」换「收起」；窄屏沿用现有替换规则。
- 展开详情时，非通用定义在「说明」下面多两行：「开关」开启时「开启 · 默认值 · 切换后<全局生效或本项目生效>」（绿），关闭时「关闭 · 来自<用户层或项目层>」（灰）；「审查」只在名字是 `<前缀>-worker` 且存在 `<前缀>-reviewer` 定义时出现，写「用了它的任务自动加 <前缀>-reviewer」。
- 「问题」分类里列出 disabled-agents 的三种错误（类型不对由解析给出；通用名、不存在的名字由 `disabledAgentProblems` 给出）。
- 已确认的界面预览：`.bb-spec/.cache/ui-preview/stack-agents-settings.html` 的 ①～⑥ 号画面；实现后逐项对照，选中行的底部说明沿用现有格式（描述 · skills …）。

## 涉及文件
- 修改 `src/modules/settings/agent-settings-ui.ts`（`PageNotice` 的 tone 加 `warning`；新增定义表格的列宽函数）
- 修改 `src/modules/settings/settings-page-ui.ts`
- 修改 `src/modules/settings/settings-extension.ts`
- 修改 `tests/settings-page-ui.test.ts`、`tests/settings-page.test.ts`

## 函数清单
### src/modules/settings/agent-settings-ui.ts
| 函数名 | 职责 |
|---|---|
| `PageNotice`（类型） | tone 增加 `warning`，渲染为 `theme.fg("warning")` |
| `definitionColumns` | 角色定义表格的列宽：在名称、来源、模型、思考之外加 6 列宽的状态列；总宽超出时先去掉思考列，再按 `tableColumns` 的顺序压模型、名称；返回各列宽和是否显示思考列。`tableColumns` 本身不变（模型设定页继续用它） |

### src/modules/settings/settings-page-ui.ts
| 函数名 | 职责 |
|---|---|
| `SettingsPageView` 构造 options（改） | 新增 `onToggleAgent` 回调（参数是选中的目录条目） |
| `SettingsPageView.handleInput`（改） | 在定义分类右栏按空格（`data === " "` 或 `matchesKey(data, "space")`，同 `MergeMethodsPicker` 写法）：通用定义设黄字 notice；否则调 `onToggleAgent` |
| `definitionPane`（改） | 用 `definitionColumns` 排版，加状态列；关闭的定义名字和状态灰显 |
| `entryDetail`（改） | 非通用定义多「开关」「审查」两行 |
| `hintFor`（改） | 定义分类的提示加「空格 开关」 |
| `footerLines`（改） | notice tone 为 `warning` 时用黄字 |
| `switchStateOf` | 由 `options.settings.disabledAgents` 和条目来源算出这一行的状态文字、颜色和详情「开关」行（内部调用 `agentSwitchOf`） |

### src/modules/settings/settings-extension.ts
| 函数名 | 职责 |
|---|---|
| `Picked`（类型，改） | 加 `toggle` 分支，携带目录条目 |
| `applyChange`（改） | `toggle` 分支：按条目来源选层，读该层现有列表，加入或删除名字后调用 `saveDisabledAgentsSetting`；保存后重读设置判断是否仍关闭；返回 notice 文字、tone（ok / warning）和 fresh |
| 主循环（改） | 把 `onToggleAgent` 接到 `done({ toggle, state })`；构造页面前把 `disabledAgentProblems(...)` 的结果并入 `settings.problems`；保存抛错时沿用现有「✗ 没有保存：」红字分支 |

## 协作关系
依赖"定义开关的存储与解析"计划的 `readAgentSettings().disabledAgents`、`agentSwitchOf`、`disabledAgentProblems`、`saveDisabledAgentsSetting`，以及"内置专项定义"计划的 `isGenericDefinition`。

## 验证方式
- 测试入口：`tests/settings-page-ui.test.ts` 的 `page(options)`（返回 `view, text, pane, press, …`）、`enterSection`、`moveToRowWith`、`SPACE` 常量；`tests/settings-page.test.ts` 的 `scripted(steps, { trusted })`、`writeSettings`、`readJson`
- 预期结果：
  - 80 列：worker 分类表头「名称  来源  状态  模型  思考」；worker 行「必须」，go-worker「开启」；用户层写 `["python-worker"]` 时 python-worker 行含「关闭」
  - 36 列进入右栏：表头不含「思考」、含「状态」，每行 `visibleWidth` ≤ 36
  - 在 reviewer 上按空格：不触发 `onToggleAgent`，底部文字「reviewer 是通用定义，流程离不开它，不能关闭」
  - 提示行等于「←/Esc 回左栏  ↑↓ 选择  回车 详情  空格 开关  C 复制」
  - 展开 go-worker：含「开启 · 默认值 · 切换后全局生效」「用了它的任务自动加 go-reviewer」；展开没有配对审查的用户定义 acme-worker 不含「审查」行
  - 完整流程（settings-page.test）：在 go-worker 上按空格 → 用户设置文件 `disabled-agents` 为 `["go-worker"]`、原有键保留，底部「已关闭 go-worker · 全局生效」；再按 → 键被删，「已开启 go-worker · 全局生效」；受信任项目里的项目层定义 acme-worker → 只写项目层，「已关闭 acme-worker · 本项目生效」
  - 项目层手写 `["go-worker"]` 后在 go-worker 上开启 → 用户设置文件不新增内容，行仍「关闭」，底部「go-worker 仍是关闭：项目层设置文件里也写了关闭」
  - 用户设置文件只读 → 底部以「✗ 没有保存：」开头
  - 用户层写 `["reviewer","nope"]` → 「问题」分类出现这两条
- [ ] 与预览 ①～⑥ 逐项对照一致
