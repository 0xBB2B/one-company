---
name: 02-delivery-settings
description: 设置文件和设置页：git-delivery 改为 remote/local 并按仓库自动选默认值，新增 merge-methods 勾选；交付工具一直在工具列表里
---
# 设置：Git 交付档位和合并方式

## 目标
设置文件能读写 `git-delivery`（`"remote"`/`"local"`）和 `merge-methods`；设置页「开关」分类按已确认的预览显示两行、可修改和清除；交付工具两档下都一直在主窗口工具列表里。

## 业务规则（来源：PRD 03-delivery-settings；已确认预览 `.bb-spec/.cache/ui-preview/git-delivery-modes.html` 画面 1–10）
- 取值顺序：项目层（项目受信任时）> 用户层 > 内置默认值。`git-delivery` 内置默认值由 plan 01 的 `detectDeliveryMode` 得出；`merge-methods` 内置默认值是三种都勾 `["squash","merge","rebase"]`。
- 写错的值：`git-delivery` 不是 `"remote"`/`"local"`（含旧的 true/false）→ 这一层不生效，问题原因"git-delivery 只能写 remote 或 local"；`merge-methods` 不是由 squash/merge/rebase 组成、不重复的非空数组 → 原因"merge-methods 只能是 squash、merge、rebase 里的一到三个，不能重复"；不认识的键 → "不认识的设定 <键名>，只能是 pm、interpreter、draft-verifier、git-delivery、merge-methods"。问题里"现在的写法"写出原样。
- 分类说明 `DESCRIPTION.switches` = "Git 交付怎么交、用哪些合并方式"。表头"名称  来源  状态"，两行：
  - Git 交付：状态"远程"或"仅本地"，强调色。
  - 合并方式：按 squash、merge、rebase 顺序列出勾了的，名称"压缩合并""普通合并""rebase 合并"，用" · "隔开；三种都勾时写"压缩 · 普通合并 · rebase"。
- 选中 Git 交付时底部："Git 交付：远程＝推送需求分支、开 PR，在 GitHub/GitLab 上合并；仅本地＝在本机把需求分支合进主仓库当前分支，不推送 · <来源说明> · 立即生效"。来源说明："来自用户层"/"来自项目层"，或内置默认值的依据之一："内置默认值：origin 在 <主机>，gh 已登录 → 远程"（glab 时写 glab）、"内置默认值：origin 在 <主机>，gh 和 glab 都没登录这台主机 → 仅本地"、"内置默认值：没有 origin → 仅本地"。选中合并方式时底部："合并方式：远程和仅本地都只用勾了的方式，压缩合并是推荐方式 · <来源说明> · 立即生效"（来源说明内置时写"内置默认值：三种都勾"）。
- 改 Git 交付：第 1 步标题"修改 Git 交付"+灰字"第 1 步，共 2 步"，选项"远程"（"推送需求分支、开 PR，在 GitHub/GitLab 上合并"）、"仅本地"（"在本机合进主仓库当前分支，不推送"），现值打 ✓、光标在另一项；第 2 步"Git 交付 改为<远程或仅本地>，存到哪一层"，选层同模型设定。保存只写所选层的 `"git-delivery": "remote"|"local"`，这一行名字变绿，底部绿字"✓ Git 交付 改为<…>，存到<项目层或用户层>，立即生效"。
- 改合并方式：第 1 步标题"修改合并方式"，三行复选框 `[x]`/`[ ]`：压缩合并（绿色"推荐"，"一个需求在主分支上是一个提交"）、普通合并（"保留每个提交，另加一个合并提交"）、rebase 合并（"保留每个提交，历史是一条直线"），按生效值预先勾好；下方灰字"远程和仅本地都生效。远程时只列出仓库也允许的方式；交付窗口里压缩合并排第一、标推荐。"；提示"↑↓ 选择  空格 勾选  回车 下一步  Esc 取消"；一种都没勾时回车停在第 1 步并红字"✗ 至少勾一种合并方式"。第 2 步"合并方式 改为 <勾了的，用顿号隔开>，存到哪一层"。保存写数组（按 squash、merge、rebase 顺序），底部绿字"✓ 合并方式 改为 <…>，存到<层>，立即生效"。
- Esc：第 2 步退回第 1 步，第 1 步取消并提示"已取消修改"。R：清除生效层的这一项，绿字"✓ 已清除<层>的<Git 交付或合并方式> 设定，现在用<下一层的值的说明>"；Git 交付回到内置默认时说明为"内置默认值：<远程或仅本地>（<依据>）"，合并方式为"内置默认值：压缩合并、普通合并、rebase 合并"；已是内置时只提示"已经是内置默认值"。
- 交付工具两档下都一直在工具列表里，改设置不用重开 pi；"Git 交付已关闭"的拒绝去掉。

## 涉及文件
- src/modules/settings/agent-settings.ts（修改）
- src/modules/settings/agent-settings-ui.ts（修改）
- src/modules/settings/settings-page-ui.ts（修改）
- src/modules/settings/settings-extension.ts（修改）
- src/app/extension/commands.ts（修改）
- src/modules/delivery/git-delivery-extension.ts（修改）
- tests/agent-settings.test.ts、tests/settings-page-ui.test.ts、tests/settings-page.test.ts、tests/git-delivery-extension.test.ts、tests/commands.test.ts（修改）
- tests/helpers/run-manager-fixture.ts（修改：默认 `loadAgentSettings` 返回值带上新形状）

## 函数清单
### src/modules/settings/agent-settings.ts
| 函数名 | 职责 |
|---|---|
| `parseSettingsLayer` | 改：按上面规则校验 `git-delivery`、`merge-methods`，合法键加入 `merge-methods` |
| `readAgentSettings` | 改：返回 `gitDelivery: { mode, source, detected }`（detected 仅内置时有，来自 `detectDeliveryMode`）和 `mergeMethods: { methods, source }` |
| `saveGitDeliverySetting` / `clearGitDeliverySetting` | 改：写入 `"remote"`/`"local"` 字符串；清除不变 |
| `saveMergeMethodsSetting` / `clearMergeMethodsSetting` | 新增：写入或删除 `merge-methods` |
| `MERGE_METHODS` | 新增常量：三种方式的固定顺序 `squash, merge, rebase` 与中文名 |
### src/modules/settings/agent-settings-ui.ts
| 函数名 | 职责 |
|---|---|
| `checkList` | 新增：渲染复选框列表（光标标记、`[x]`/`[ ]`、名称、可选绿色徽标、灰色说明） |
### src/modules/settings/settings-page-ui.ts
| 函数名 | 职责 |
|---|---|
| `DeliveryModePicker` | 由 `SwitchPicker` 改名改写：两步选远程/仅本地和层 |
| `MergeMethodsPicker` | 新增：两步，第 1 步勾选（空格切换、全空时红字），第 2 步选层 |
| `switchPane` / `categoryFooter` / `crumbs` / `rowNames` / `rowCount` / `hintFor` | 改：两行、各自底部文字、面包屑"Git 交付"或"合并方式"、复选提示 |
| `SaveSwitchRequest` / `ClearSwitchRequest` | 改：带 `key: "git-delivery" \| "merge-methods"` 和对应的值 |
### src/modules/settings/settings-extension.ts
| 函数名 | 职责 |
|---|---|
| `openSettingsPage` | 改：按 key 调对应的保存/清除函数并写底部提示；去掉 `onGitDeliveryChanged` 选项 |
### src/app/extension/commands.ts、src/modules/delivery/git-delivery-extension.ts
| 函数名 | 职责 |
|---|---|
| `/one:setting` 注册处 | 改：不再传开关回调 |
| `registerGitDelivery` | 改：删掉 `gitDeliveryOn`、`showGitDeliveryTool`、session_start 显隐和"已关闭"拒绝；工具一直注册在列表里 |

## 协作关系
- `readAgentSettings` 调 plan 01 的 `detectDeliveryMode(repositoryRoot)`；主窗口（设置页、交付工具）和守护进程（`src/app/daemon/lifecycle.ts:508` 的 `loadAgentSettings`）都经它取值。

## 验证方式
- 测试入口：`readAgentSettings`、保存/清除函数；`SettingsPageView` 的 `render`/`handleInput`；`openSettingsPage`（真实写文件）；`registerGitDelivery` 的假 pi 对象。
- 测试输入：临时 agentDir 与仓库；origin 设为各种主机并配合假 gh（同 plan 01）；用户层/项目层设置文件写入各种值；项目受信任与否。
- 预期结果：
- [ ] 两层都没写时 `gitDelivery` 等于探测结果、source 为 default；`mergeMethods.methods` 为三种、source 为 default；项目层 `"local"` 覆盖用户层 `"remote"`；项目不受信任时忽略项目层。
- [ ] `"git-delivery": true`、`["squash","squash"]`、`[]`、`["fast"]`、`"foo": 1` 各产生对应原因的问题，且这一层不生效。
- [ ] 开关分类渲染两行、状态和底部文字逐字如业务规则（三种内置依据各一例）。
- [ ] 改 Git 交付两步的标题、✓、光标、保存后文件内容和绿字提示如规则；改合并方式取消两项后保存，文件是 `["merge"]`、状态"普通合并"；全取消回车停在第 1 步并出现红字；Esc 两次提示"已取消修改"且文件不变。
- [ ] R 清除项目层 `"local"` 后底部提示含"现在用内置默认值：远程（origin 在 github.com，gh 已登录）"；来源已是内置时只提示"已经是内置默认值"。
- [ ] 不管设置是什么，session_start 后交付工具都在活动工具列表里；调用时不会因档位被拒。
