---
name: settings-tab-ui
description: /one:agents 最右边的「内部」栏换成「设定」栏：列出三个角色，三步修改、按 R 清除本层，写错与没凭据有提示
---
# 设定栏界面

## 目标
在 /one:agents 里切到最右边的「设定」栏，就能查看、分层修改、清除 PM、解释器、草稿核验器的模型和思考等级；问题栏同时列出设定写错的地方。

## 业务规则（来源：PRD settings-tab、settings-recovery）
- 界面以用户已确认的预览为准：`.bb-spec/.cache/ui-preview/agents-settings.html` 里「一、设定栏」的 9 个画面（列表、改模型、改思考等级、选存到哪一层、项目未受信任、保存后、清除本层、模型不可用、没有可选模型）。实现完成后逐个画面对照，不一致要报告。
- 分类栏右边原来「内部」的位置换成「设定 3」；左边的职责栏本计划不动（pm 栏在 06 去掉）。
- 列表三行：名称、来源标签（内置 / 用户 / 项目，配色同现有来源标签：内置灰底、用户强调色、项目成功色）、模型（强调色；跟随主会话显示"跟随主会话"）、思考等级（解释器和草稿核验器的 off 显示"不思考"）。底部一行：`<名称>：<用途> · <来源说明> · <生效时机>`，来源说明为"内置默认值""来自用户层""来自项目层"。
- 回车进入三步，画面标题后写"第 N 步，共 3 步"：
  1. 选模型：列出本机配了凭据的模型（名字 + 灰色提供方），最后一项"跟随主会话"（灰色，后面写"现在是 <提供方>/<模型>"）；当前生效的那项前面打绿色 ✓；底部写"只列出本机配了凭据的模型"。一个都没有时只剩"跟随主会话"，底部写"本机还没有其他配了凭据的模型，先在 pi 里登录模型服务"。
  2. 选思考等级：off、minimal、low、medium、high、xhigh、max；所选模型不支持的等级变灰、光标跳过，后面写"<模型> 不支持"；选的是跟随主会话时按主窗口当前的模型判断；当前值打 ✓。
  3. 选层：项目层（`.pi/settings.json · 只对这个项目生效`）、用户层（`~/.pi/agent/settings.json · 所有项目`）。项目未受信任时项目层变灰，写"项目未受信任，项目层的设定不会生效"，底部写"在 pi 里把这个项目设为受信任后，才能存到项目层"，光标停在用户层。
  - 按键提示依次为"↑↓ 选择  回车 下一步  Esc 取消""↑↓ 选择  回车 下一步  Esc 上一步""↑↓ 选择  回车 保存  Esc 上一步"。Esc 退回上一步，第一步 Esc 取消，什么也不保存，底部提示"已取消修改"。
- 保存后回到设定栏，选中这一行，名字变绿一下，底部绿字"✓ <名称> 改为 <模型> · <思考>，存到<层>，<生效时机>"。
- 设定栏的按键提示："←→ 分类  ↑↓ 选择  回车 修改  R 清除本层  Esc 退出"。按 R：来源是用户或项目时删掉那一层的这一项，底部绿字"✓ 已清除<层>的 <名称> 设定，现在用<下一层说明> <模型> · <思考>"；来源是内置时底部灰字"已经是内置默认值"，不改文件。
- 生效的模型不是"跟随主会话"、又在本机找不到配了凭据的同名模型时，这一行的模型标红并在后面写"不可用"，选中时底部红字"✗ <模型> 没有可用的凭据，<后果>；回车重新选"（后果取固定表里的 failure）。
- 问题栏新增设定的问题：文件列写设置文件的显示路径，原因列写读取模块给的原因；展开详情写原因、文件、影响"这一项没有生效，改用下一层"。项目未受信任那一条的说明改成"项目未受信任，项目层的定义和设定没有生效"。

## 涉及文件
- 新建 `runtime/agent-settings-ui.ts`
- 修改 `runtime/agent-catalog-ui.ts`
- 修改 `extensions/settings.ts`
- 修改 `runtime/agent-resolve.ts`（导出判断思考等级是否受支持的函数，05 也会用）
- 修改测试：`tests/agent-catalog-ui.test.ts`、`tests/agents-page.test.ts`；新建 `tests/agent-settings-ui.test.ts`

## 函数清单
### runtime/agent-settings-ui.ts
| 函数名 | 职责 |
|---|---|
| `SettingsTab` | 设定栏的状态与渲染：列表、光标、三步选择的当前步骤和已选值 |
| `SettingsTab.renderList` | 画三行列表和底部说明（含标红行） |
| `SettingsTab.renderPicker` | 画当前步骤的选择画面 |
| `SettingsTab.handleInput` | 处理 ↑↓、回车、Esc、R；保存或清除时通过回调交给调用方 |
| `modelChoices` | 由配了凭据的模型和主窗口模型生成第一步的选项 |
| `thinkingChoices` | 由所选模型生成第二步的选项和不支持的标记 |
| `rowAvailability` | 判断某一行生效的模型能不能用，不能用时给出原因 |

### runtime/agent-catalog-ui.ts
| 函数名 | 职责 |
|---|---|
| `AgentCatalogView` 构造选项 | 新增：设定读取结果、可选模型、主窗口模型、项目是否受信任、保存与清除回调 |
| `tabs` / `tabsLine` | 修改：右侧「内部」换成「设定」，计数为 3 |
| `handleInput` / `render` | 修改：当前栏是设定时交给 `SettingsTab` |
| `problemRows` | 修改：加入设定的问题；未受信任说明改文字 |
| `state` | 修改：页面状态记住设定栏的选中行和提示 |

### runtime/agent-resolve.ts
| 函数名 | 职责 |
|---|---|
| `thinkingSupported` | 新增导出：按模型的 reasoning 与 thinkingLevelMap 判断某个思考等级能不能用（与 `resolveAgent` 现有判断同一规则，`resolveAgent` 改为调用它） |

### extensions/settings.ts
| 函数名 | 职责 |
|---|---|
| `openSettingsPage` | 修改：每轮读取 `readAgentSettings`；从 `ctx.modelRegistry` 取配了凭据的模型、`ctx.model` 取主窗口模型；视图结束时按结果分三种处理：复制（现有流程）、保存（`saveAgentSetting` 写所选层）、清除（`clearAgentSetting` 写来源层）；处理完带提示重开页面，写入失败时把原因作为提示显示 |

## 协作关系
- 读写走 03 的 `readAgentSettings`、`saveAgentSetting`、`clearAgentSetting`、`SETTINGS_ROLES`；路径用 `userSettingsPath`、`projectSettingsPath`。
- 模型写法匹配复用 `runtime/model-ref.ts` 的 `findDefinedModel`。
- 本计划只管页面；守护进程和内部代理改用这些设定在 05。

## 验证方式
- 测试入口：`AgentCatalogView` 的 `render(80)` 与 `handleInput`（现有 tests/agent-catalog-ui.test.ts 的做法，去掉颜色后比对文字）；`openSettingsPage`（tests/agents-page.test.ts 的假 ctx 做法），测试目录用单层 `/tmp/pi-t-XXXXXX`。
- 测试输入：两层都没有设定；用户层设了解释器；项目受信任与不受信任；可选模型 [gpt-6.1-sol（支持全部等级）、gpt-6-luna（不支持 minimal、max）]、没有可选模型；解释器设定的模型没有凭据；项目层文件写错。
- 预期结果：
  - [ ] 按 → 到最右边看到"设定 3"，三行显示默认值，来源都是"内置"，底部有用途和生效时机
  - [ ] 回车 → 选 gpt-6-luna → 思考等级里 minimal、max 变灰且光标跳过 → 选 xhigh → 选项目层 → 项目设置文件 one-company 下有 PM 的 gpt-6-luna、xhigh；回到列表后 PM 来源为"项目"，底部绿字含"下次启动 PM 时生效"
  - [ ] 三步里任一步连续按 Esc 退出，两层文件都没变，底部显示"已取消修改"
  - [ ] 项目不受信任时第三步的项目层变灰并写明原因，光标在用户层
  - [ ] 没有可选模型时第一步只有"跟随主会话"和登录提示；选它之后保存的条目 model 为 null，列表显示"跟随主会话"
  - [ ] 来源为项目的 PM 按 R 后改回下一层，文件里这一项被删；来源为内置的按 R 只提示"已经是内置默认值"
  - [ ] 没有凭据的那行模型标红带"不可用"，选中时底部写明后果
  - [ ] 问题栏出现项目设置文件写错的那一条
  - [ ] 解释器的 off 显示为"不思考"
  - [ ] 和预览的 9 个画面逐个对照：文案、按键提示、标记一致
