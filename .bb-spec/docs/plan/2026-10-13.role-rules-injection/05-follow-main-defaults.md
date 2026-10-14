---
name: follow-main-defaults
description: 设定与内置定义默认跟随主窗口的模型和思考等级；思考等级可选跟随主会话；表格里统一写"跟随"
---
# 默认跟随主窗口

## 目标
PM、解释器、草稿核验器的内置默认值，以及 worker、reviewer、qa、explore 四个内置定义，都改为跟随主窗口当时的模型和思考等级；设定栏第 2 步多一个"跟随主会话"；表格里跟随时统一写"跟随主会话"（模型列）和"跟随"（思考列）。

## 业务规则（来源：PRD settings-tab、definition-tabs，用户 2026-10-14 决定）
- 设置文件里 thinking 也可以写 null，表示跟随主会话；条目仍须同时有 model 和 thinking。三个角色的内置默认值都是 model null、thinking null。
- 设定栏列表：模型为 null 写"跟随主会话"，思考为 null 写"跟随"（都用灰色）；解释器、草稿核验器的 off 仍写"不思考"。
- 第 2 步：在 max 后面加一项"跟随主会话"，后面写"现在是 <主窗口当前思考等级>"（解释器、草稿核验器的 off 写"不思考"）；它总是可选；当前生效的是跟随时 ✓ 打在它上面；选它保存的 thinking 为 null。
- 第 3 步标题、保存后、清除后提示里的模型和思考写法同上：模型 null 写"跟随主会话"，思考 null 写"跟随"；清除后落到内置默认值时提示"✓ 已清除<层>的 <名称> 设定，现在用内置默认值：跟随主会话"。
- 模型为 null 的行不会被标"不可用"。
- 角色定义表：没写模型的写"跟随主会话"（原"继承主会话"），没写思考的写"跟随"（原"继承"）。
- 内置四个定义删掉 model、thinking 两行。
- 界面以用户确认的预览第 2 版为准：`.bb-spec/.cache/ui-preview/agents-settings.html`。

## 涉及文件
- 修改 `runtime/agent-settings.ts`、`runtime/agent-settings-ui.ts`、`runtime/agent-catalog-ui.ts`、`extensions/settings.ts`、`extensions/commands.ts`
- 修改 `agents/worker.md`、`agents/reviewer.md`、`agents/qa.md`、`agents/explore.md`
- 修改测试：`tests/agent-settings.test.ts`、`tests/agent-settings-ui.test.ts`、`tests/agent-catalog-ui.test.ts`、`tests/agents-page.test.ts`、`tests/role-rules.test.ts`

## 成品定义
三个角色固定表里的内置默认值改为：
```ts
model: null, thinking: null
```
思考等级写错时的原因文字改为：
```text
「<角色名>」的思考等级写错了：<原值>；只能是 off、minimal、low、medium、high、xhigh、max，或 null（跟随主会话）
```

## 函数清单
### runtime/agent-settings.ts
| 函数名 | 职责 |
|---|---|
| `SETTINGS_ROLES` | 修改：三项的 model、thinking 都为 null |
| `parseSettingsLayer` | 修改：thinking 接受 null；原因文字按成品 |

### runtime/agent-settings-ui.ts
| 函数名 | 职责 |
|---|---|
| `SettingsTab.renderList` | 修改：null 的写法与灰色 |
| `thinkingChoices` | 修改：末尾加"跟随主会话"项，备注写主窗口当前等级 |
| `SettingsTab.renderPicker` / `handleInput` | 修改：第 3 步标题与保存请求支持 thinking 为 null |
| `rowAvailability` | 修改：model 为 null 时可用 |

### runtime/agent-catalog-ui.ts
| 函数名 | 职责 |
|---|---|
| `entryTable` | 修改："继承主会话""继承"改为"跟随主会话""跟随" |
| 构造选项 | 新增主窗口当前思考等级，交给设定栏 |

### extensions/settings.ts、extensions/commands.ts
| 函数名 | 职责 |
|---|---|
| `openSettingsPage` | 修改：接收取主窗口思考等级的函数并交给视图；保存、清除提示按新写法 |
| `registerCommands` | 修改：打开设定页时传入 `() => pi.getThinkingLevel()` |

## 协作关系
- 视图第 2 步的"现在是"取自页面传入的主窗口思考等级；不支持判断仍用 `thinkingSupported`。
- 守护进程与内部代理怎么用 null 在 06。

## 验证方式
- 测试入口：`readAgentSettings`、`saveAgentSetting`；`AgentCatalogView` 的 `render` / `handleInput`；`openSettingsPage`（假 ctx 加一个返回主窗口思考等级的函数）；`readRoleDefinition` 读内置定义。
- 测试输入：两层都没有设定；thinking 写 null 的条目；主窗口思考等级 high；内置 worker 与写了 gpt-6.1-sol、high 的用户定义。
- 预期结果：
  - [ ] 没有设定时三行模型都写"跟随主会话"、思考都写"跟随"，来源"内置"
  - [ ] thinking 为 null 的条目读得出来、不报问题；写成别的字符串时原因含"或 null（跟随主会话）"
  - [ ] 第 2 步最后一项是"跟随主会话"、写"现在是 high"、默认打 ✓；选它保存的请求 thinking 为 null；保存后列表写"跟随"
  - [ ] 清除到内置默认值时提示"现在用内置默认值：跟随主会话"
  - [ ] model 为 null 的行不显示"不可用"
  - [ ] 内置 worker 等四个定义读出来 model、thinking 都是未定义；角色定义表里写"跟随主会话""跟随"，用户定义仍写 gpt-6.1-sol、high
  - [ ] 36–80 列不超宽；与预览第 2 版逐项一致
