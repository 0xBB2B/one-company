---
name: settings-project-trust
description: 授信记录分信任、不信任、空三种；设置页在记录为空时放开项目层，选了先写授信记录再保存或复制
---
# 设置页项目层当场授信

## 目标
`/one:setting` 在授信记录为空时能把模型设定、Git 交付、合并方式存到项目层，也能把角色定义复制到项目层；选项目层时程序先把主仓库根目录在 pi 的 `trust.json` 里记为 true。

## 业务规则（来源：PRD project-layer-trust）
- 授信记录：pi 的 `ProjectTrustStore(agentDir).get(主仓库根目录)`，从主仓库根目录往上找最近一条：true 为"信任"，false 为"不信任"，null 为"空"。项目层只在"信任"时生效，这条规则不变（C-1）：角色目录、设置读取仍只在"信任"时读项目层。
- 存到哪一层选择框（模型第 3 步、Git 交付第 2 步、合并方式第 2 步）：
  - 空：项目层可选，说明".pi/settings.json · 选它会把本项目设为受信任"，光标默认在项目层；下面灰字"选项目层会把这个项目设为受信任，和在 pi 里输入 /trust 选 Trust 一样；项目里已有的 .pi 设置和角色定义也会一起生效"（C-2）。
  - 不信任：项目层灰掉不能选，说明"你在 pi 里选过不信任这个项目"，光标在用户层；下面灰字"你在 pi 里选过不信任这个项目。要存到项目层，先在 pi 里输入 /trust 选 Trust，再重开本页"（C-3）。
  - 信任：和现在一样（".pi/settings.json · 只对这个项目生效"，没有灰字）（C-7）。
- 空时选项目层：先 `ProjectTrustStore.set(主仓库根目录, true)`，再写项目设置文件；成功提示在原文字末尾加"· 已把本项目设为受信任"；回到页面按新记录重新读取（C-4）。例："✓ PM 改为 gpt-5.5 · high，存到项目层，下次启动 PM 时生效 · 已把本项目设为受信任"。
- 写授信记录失败：不写项目层文件，红字"✗ 没有保存：<原因>"；复制定义时是"复制没有完成：<原因>"（C-5）。
- 只在项目层上按回车确认时写授信记录；打开、浏览、Esc、选用户层都不写（C-6）。信任时不写、不加后缀（C-7）。
- 复制定义窗口：空时项目层可选，说明"<目标文件路径> · 选它会把本项目设为受信任"，选了先写授信记录再复制，成功提示"✓ 已复制到 <路径>，打开它写专长、skills 和 mcp · 已把本项目设为受信任"；不信任时项目层灰掉，写"你在 pi 里选过不信任这个项目，先输入 /trust 选 Trust"（C-8）。用户层也已有同名文件、两项都灰时，沿用现有的合并提示逻辑，提示里"项目未受信任"只在不信任时出现。
- 第一行下面黄字：空时"! 项目还没设为受信任：项目层的定义和设定都没有生效"，不信任时"! 项目未受信任：项目层的定义和设定都没有生效"，信任时没有。「问题」第一条灰字：空时"项目还没设为受信任，项目层的定义和设定没有生效"（详情"原因"同样用"项目还没设为受信任"开头），不信任时保持现在的"项目未受信任，项目层的定义和设定没有生效"（C-11）。
- 36 到 80 列下新增、改动的每一行不超过终端宽度（C-12）。

## 涉及文件
- 新建 `src/modules/settings/project-trust.ts`
- 修改 `src/modules/settings/agent-settings-ui.ts`
- 修改 `src/modules/settings/settings-page-ui.ts`
- 修改 `src/modules/settings/settings-extension.ts`

## 函数清单
### src/modules/settings/project-trust.ts
| 函数名 | 职责 |
|---|---|
| `ProjectTrust` 类型 | "trusted" / "denied" / "unset" 三种授信记录状态 |
| `readProjectTrust` | 用 pi 的 `ProjectTrustStore` 读主仓库根目录的授信记录，换成三种状态之一 |
| `trustProject` | 用 `ProjectTrustStore.set` 把主仓库根目录记为 true |

### src/modules/settings/agent-settings-ui.ts
| 函数名 | 职责 |
|---|---|
| `layerRows` | 改为按三种授信状态生成项目层、用户层两行（文字、能否选按上面规则） |
| `untrustedLayerNote` | 改为按三种状态返回选择框下面的灰字，信任时返回空；可改名为 `layerNote` |
| `SettingsTab`（options、`rows`、`renderPicker`） | `projectTrusted: boolean` 换成 `projectTrust: ProjectTrust`，第 3 步用新的 `layerRows` 和灰字 |

### src/modules/settings/settings-page-ui.ts
| 函数名 | 职责 |
|---|---|
| `SwitchPicker`（构造、`handleInput`、`rows`、`layerStep`） | 换成 `projectTrust`；进第 2 步时光标：不信任停用户层，其余停项目层 |
| `SettingsPageView`（options、构造、`render`、`problemRows`） | 换成 `projectTrust`；黄字和「问题」第一条按状态取文字 |

### src/modules/settings/settings-extension.ts
| 函数名 | 职责 |
|---|---|
| `openSettingsPage` | 每轮读 `readProjectTrust`；加载角色目录、读设置时 `projectTrusted` 取"是否 trusted"；把三态传给视图 |
| `openSettingsPage` 内的 `applyChange` | 保存或复制前，层是项目层且状态为 unset 时先 `trustProject`；成功后在提示末尾加"· 已把本项目设为受信任" |
| `openSettingsPage` 内的复制分支 | 复制窗口的项目层按三态生成说明或灰掉原因；选项目层且 unset 时先 `trustProject` 再复制 |

## 协作关系
`openSettingsPage` → `readProjectTrust` → 视图（`SettingsPageView` → `SettingsTab` / `SwitchPicker` → `layerRows`、灰字）。用户在项目层回车 → `onSaveSetting` / `onSaveSwitch` 回到 `applyChange` → unset 时 `trustProject` → `saveAgentSetting` 等写文件 → 下一轮重新 `readProjectTrust`。外部依赖：pi 的 `ProjectTrustStore`（`@earendil-works/pi-coding-agent`），授信文件是 `<agentDir>/trust.json`，键是规范化后的绝对路径。守护进程 `src/app/daemon/lifecycle.ts` 的判断不改。

## 验证方式
- 测试入口：`openSettingsPage(ctx, { mainThinking })` 配合 tests/settings-page.test.ts 的脚本化 ctx；`SettingsPageView` 的 `render` / `handleInput`（tests/settings-page-ui.test.ts）。
- 测试输入：临时 agentDir 下 `trust.json` 分别为不存在、`{仓库: false}`、`{仓库: true}`；按键走到各选择框；`trust.json` 所在目录设为只读模拟写入失败。
- 预期结果：选择框文字、光标位置、灰字、黄字、「问题」第一条按上面规则；unset 时选项目层后 `trust.json` 里仓库为 true、`.pi/settings.json` 写入、提示带后缀；Esc 或选用户层后 `trust.json` 不变；写入失败时红字且项目设置文件未写入；复制定义同理。
- [ ] 三种状态下模型第 3 步、Git 交付第 2 步、合并方式第 2 步的项目层行、光标、灰字
- [ ] unset 存到项目层：授信记录写入、设置写入、提示后缀、黄字消失
- [ ] unset 下 Esc、选用户层不写授信记录；trusted 时不写、不加后缀
- [ ] 写授信记录失败：红字，项目设置文件不变
- [ ] 复制定义到项目层：unset 可选并授信，denied 灰掉并写原因
- [ ] 黄字与「问题」第一条两种写法；36/44/60/80 列不超宽
