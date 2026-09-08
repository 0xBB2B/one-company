---
name: settings-controller
description: 设置页：界面无关控制器（主页行模型、模型/思考/MCP 三种候选、按键状态机、保存回执）与 /pi-company:setting 的终端界面（替换输入栏、全宽蓝线、限宽、候选页渲染、非交互如实失败）
---
# 设置页控制器与终端界面

## 目标
设置页的全部状态与行为在不依赖终端组件的控制器中实现并可单独测试；用户执行 /pi-company:setting 后在输入栏位置得到符合布局规范的单页界面，操作全部交给控制器，保存结果如实显示。

## 业务规则（来源：spec）
- settings-page：主页依次为标题、保存范围行（两种范围始终显示、当前范围方括号）、角色目录全部角色标签（含需求代理，当前角色方括号）、模型区、思考区、MCP 区、操作提示；字段标题带来源（默认/全局/项目）；值另行缩进两格；MCP 值为已勾选服务列表或"无"，不可用项标注"不可用"；左右切角色、上下切字段、Tab 原位切范围且不保存、Enter 进候选；模型候选可搜索并含"沿用主会话"，思考候选只含有效模型支持等级并含"使用上级/角色默认"；初始定位当前显式项或沿用项；确认或 Esc 原位返回原角色原字段；只有持久化成功才提示成功。
- settings-page：MCP 候选为探测到的全部服务加已保存但不可用的服务（标注不可用）；Space 切换勾选、Enter 确认、Esc 取消；初始勾选反映当前范围显式配置或其回退来源；确认整体保存，允许空集合；不可用项保留勾选直到用户取消；未探测到适配器时没有候选。
- settings-page：上下蓝线始终等于终端可用宽度，内容区独立限宽（72 列上限）且窄屏不超宽；主页各区块之间各一行空白、标题与范围行之间不插空行；宽度足够时提示合为"←→ 角色 · ↑↓ 字段 · Tab 范围 · Enter 修改 · Esc 关闭"一行，窄屏折行仍可操作；高度不足先压缩空白；当前角色方括号突出，仅选中值行蓝底，来源灰色；模型页依次为标题、搜索行、列表、提示，思考页与 MCP 页无搜索行；候选页标题为"<角色> 模型选择 / 思考选择 / MCP 选择"；整个设置只打开一次界面，视图切换不关闭重建、不闪屏；主页 Esc 才关闭；非交互环境或保存失败显示具体原因，不报告成功，不破坏原配置。
- namespaced-entrypoints：命令为 /pi-company:setting，无法加载设置页时显示具体失败原因。

## 涉及文件
- 新建：runtime/settings-ui.ts — 控制器
- 新建：extensions/settings.ts — 命令与终端界面
- 新建：tests/settings-controller.test.ts
- 新建：tests/settings-page.test.ts

## 函数清单

### runtime/settings-ui.ts
| 函数名 | 职责 |
|---|---|
| `createSettingsSession` | 初始化会话状态：角色目录、当前角色、当前字段、当前范围、两层配置、模型上下文与可用 MCP |
| `settingsRows` | 生成主页各行（标题、范围行、角色标签行、三个字段的标题与值行、提示行），值行标注来源与选中态 |
| `applyMainPageKey` | 处理主页按键：左右切角色、上下切字段、Tab 切范围、Enter 进候选、Esc 关闭 |
| `modelCandidates` | 生成模型候选（含沿用主会话）并按搜索词过滤，标出初始定位项 |
| `thinkingCandidates` | 生成思考候选（含使用上级/角色默认），只含有效模型支持等级 |
| `mcpCandidates` | 生成 MCP 多选候选：探测到的服务 + 已保存不可用项，带勾选态与不可用标注；初始勾选按当前范围（global 取 global 层显式值否则空；project 取 project 层显式值否则 global 层） |
| `applyCandidateKey` | 处理候选页按键：上下移动、输入搜索（仅模型）、Space 勾选（仅 MCP）、Enter 确认、Esc 取消 |
| `saveField` | 调用配置保存并返回回执（成功含范围与来源；失败含原因，状态回退到保存前）；沿用项/默认项在内存层删除该字段使来源随之回退；MCP 空集合作为显式值保存 |
| `fieldSource` | 判断某角色某字段当前值的来源：项目、全局或默认 |
| `createSettingsComponent` | 由会话生成界面组件（`render(width)`、`handleInput(data)`，并满足宿主 EditorComponent 契约的 `getText`/`setText`/`invalidate`；选项 `theme?`（`{ fg(kind, text), bg(kind, text) }`，kind 含 muted/border/selectedBg，缺省不着色）、`onClose?`、`rows?`（终端行数）、`requestRender?`）：横线经 border 着色、来源经 muted 着色、仅选中值行 selectedBg；角色标签行按宽度折行；限宽 72；高度不足先压缩空白；候选页标题/搜索行/列表（按可用行数窗口化，游标可见，多选页当前项带 › 标记）/提示（窄屏折行）、候选为空显示明确空态；保存回执渲染在提示行上方（失败原因可见）；候选确认为异步，settle 后调用 requestRender，确认期间重复 Enter 被忽略；不依赖 pi-tui，文本宽度按东亚全角计 2 |

### extensions/settings.ts
| 函数名 | 职责 |
|---|---|
| `settingsExtension` | 默认导出：注册 /pi-company:setting 命令；`ctx.mode !== "tui"` 时提示"需要交互终端"并返回 |
| `openSettingsPage` | 仓库根经 git 顶层目录（非 ctx.cwd）读取角色目录、两层配置、模型上下文（尊重 ctx.scopedModels）与 MCP 探测结果建立会话（读取失败时通知具体原因、不打开界面），用宿主 `setEditorComponent` 替换输入栏，factory 内复用同一个组件实例并传入宿主主题与 `requestRender`，直到主页 Esc 才 `setEditorComponent(undefined)`；MCP 空集合经 saveRoleSettings 写显式 [] |

已知取舍：组件以鸭子类型满足宿主编辑器契约（getText/setText/invalidate，输入栏草稿原样往返），不继承 CustomEditor，设置页打开期间 Ctrl+C/Ctrl+D 等应用级按键不接线，唯一出口为主页 Esc；保存成功以刷新后的值与来源作为反馈，不另弹成功提示；主页任一导航键清除上一次保存回执；候选为空时模型/思考页回车不保存。

## 协作关系
- 控制器读写配置经 `runtime/settings.ts`；角色列表经 `runtime/roles.ts`；MCP 候选经 `runtime/mcp.ts` 的窗口探测服务清单。
- 终端界面的状态与行为全部来自控制器，只把 `settingsRows` 与候选列表画出来并把按键交给 `applyMainPageKey` / `applyCandidateKey`；模型上下文来自宿主模型注册表与当前会话模型、思考等级。
- 组件渲染在控制器模块内完成，只经注入的主题着色；扩展层不含渲染逻辑。

## 验证方式
- 测试入口：`runtime/settings-ui.ts` 导出函数与 `createSettingsComponent`；`extensions/settings.ts` 默认导出（假宿主收集命令与自定义组件工厂），用 `renderComponent` 在 100×40 与 60×12 两种终端尺寸渲染
- 测试输入：三层角色目录（含需求代理与一个用户自定义角色）、两层配置、假模型上下文、可用 MCP 集合；按键序列
- 预期结果（控制器）：
  - 主页行顺序为标题、范围行、角色标签行、模型标题、模型值、思考标题、思考值、MCP 标题、MCP 值、提示行；范围行同时含"全局"与"项目"且仅当前范围带方括号；角色标签按目录顺序且含需求代理与自定义角色
  - 右键切到下一个角色后字段保持；Tab 切范围不触发保存且角色字段不变；上下键在模型、思考、MCP 三字段间循环
  - 模型候选输入"son"只剩匹配项；未显式设置时初始定位"沿用主会话"；直接确认沿用项保存值仍为沿用；思考候选只含当前有效模型支持的等级
  - MCP 候选含 context7、chrome-devtools 与已保存但不可用的 codegraph（标注不可用且勾选）；Space 两次切换勾选；Esc 后配置不变；Enter 后配置为最终勾选集合，全部取消后为空集合且来源为当前范围；未探测到适配器时候选为空
  - 保存失败时回执含原因，行模型显示保存前的值；候选页确认或取消后当前角色与字段与进入前相同
- 预期结果（终端界面）：
  - 100×40：首行与末行为全宽蓝线；主页行序为标题、范围行、空行、角色标签行、空行、"模型 - 来源"标题、缩进两格模型值、空行、"思考 - 来源"标题、缩进两格思考值、空行、"MCP - 来源"标题、缩进两格已勾选列表（无勾选为"无"、不可用项标注）、空行、一行完整提示；内容行宽度不超过 72 列
  - 60×12：蓝线仍等于 60 列；区块间空行被压缩后操作提示仍可见；无行超过 60 列
  - 在 MCP 字段按 Enter：标题为"worker MCP 选择"，无搜索行，Space 后勾选标记变化，Esc 回到主页且选中仍在 worker 的 MCP 字段；主页 Esc 才结束组件；视图切换期间自定义组件工厂只被调用一次
  - 非终端模式调用命令：通知含"需要交互终端"，未创建组件；保存目标不可写时通知含失败原因，主页显示原值
- [ ] 主页行模型与来源
- [ ] 按键状态机与三种候选
- [ ] 保存回执与回退
- [ ] 主页布局、限宽与窄屏压缩
- [ ] 候选页与原位返回
- [ ] 单次打开与失败不虚报
