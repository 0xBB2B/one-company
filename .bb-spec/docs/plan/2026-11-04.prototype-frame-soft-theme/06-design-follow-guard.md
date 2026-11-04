---
name: design-follow-guard
description: 派 worker、reviewer 时带上 DESIGN.md，三类代理的规矩写明怎么照它做；代理用 edit、write 改 DESIGN.md 时拦下
---
# 照 DESIGN.md 实现、审查，代理不能直接改它

## 目标
worker、reviewer 的任务说明里有仓库根目录 DESIGN.md 全文；原型设计师、worker、reviewer 的规矩写明怎么用它；主窗口和子代理改 DESIGN.md 被拦下。

## 业务规则（来源：PRD design-spec-file C-10、C-14、C-15、C-16）
- 派 worker、reviewer 时，仓库根目录有 `DESIGN.md` 就把全文放进任务说明，开头一行"界面设计规范（来源：仓库根目录 DESIGN.md；界面改动必须遵守）："，接全文；没有文件或内容为空时不放。PM、qa、explore、原型设计师不放这一块（设计师由 plan design-submit-dispatch 的任务说明单独给）。
- 主窗口的 edit、write 指向任一已接入仓库根目录的 `DESIGN.md`（不分大小写，按真实路径比较，和 AGENTS.md 的拦法一样）时拦下，原因"DESIGN.md 只能随原型通过写入：派原型设计师出一版原型，用户通过后由程序写入"。
- 子代理写入：仓库相对路径只有一段且小写后是 `design.md` 的，路径分类为 `design_spec`，不允许 worker 写入、不允许 PM 提交；worker 写时报错码 `design_spec`，原因"DESIGN.md 只能随原型通过写入"，下一步"派原型设计师出一版原型，用户通过后由程序写入；需要改设计规范时在结果里说明"；PM 提交时原因"这是界面设计规范文件 DESIGN.md，只能随原型通过写入，不能提交：<路径>"；计划里把它列进 worker 写入范围时，报"<任务> 的 DESIGN.md 不能由 worker 写入"（沿用现有写法）。
- 用户自己在编辑器里改不受影响。

## 涉及文件
- 修改 `src/modules/verification/project-conventions.ts`
- 修改 `src/app/daemon/run-manager.ts`（`withConventions` 调用处，worker/reviewer 那条）
- 修改 `src/core/policy/core-permissions.ts`
- 修改 `src/modules/verification/change-apply.ts`
- 修改 `src/modules/pm/pm-commit.ts`
- 修改 `role-rules/prototype.md`、`role-rules/worker.md`、`role-rules/reviewer.md`
- 修改相关测试：`tests/core-permissions.test.ts`、`tests/change-apply.test.ts`、`tests/role-rules.test.ts`、`tests/daemon-harness.test.ts` 或现有项目规范注入、主窗口拦截的测试文件

## 成品定义
`role-rules/prototype.md` 末尾追加（在 plan designer-project-ui 改过的版本上）：

```markdown
- 任务说明里给出仓库根目录的 DESIGN.md 时，原型照它画。每次交稿都在 design 里带 DESIGN.md 全文，没改的章原样照抄；画了多个方案且各方案风格不同时，design 写成数组，按 options 的顺序每个方案一份；风格相同时只交一份。用户通过原型时，程序把它写进仓库根目录，之后的原型、实现和审查都照它做。
- 仓库里还没有 DESIGN.md 时，先从项目界面代码里读出现有的值写进去，代码里没有的项按现代界面设计规范补。现有的值达不到下面的对比度要求时，写合规的新值，原型也按新值画，并在 openQuestions 里写"<项名>由<老值>改为<新值>，老页面会跟着变"。
- DESIGN.md 固定十章，每章一个二级标题，依次是 ## 风格、## 颜色、## 字体、## 间距、## 圆角与阴影、## 布局、## 组件、## 状态、## 无障碍、## 终端界面。每个必填项写一行"- 项名：值"，章里还可以写别的说明。必填项：
  - 风格：主题（明亮、暗黑或"明亮、暗黑"）、参考设计体系（名称或"无"）。
  - 颜色：主题写了几套就分几节，每节一个三级标题 ### 明亮 或 ### 暗黑；每节有主色、主色悬停、文字、次要文字、禁用文字、边框、背景、卡片背景、成功、警告、出错、提示，都写 #rrggbb。
  - 字体：字体；标题 1 字号、标题 2 字号、标题 3 字号、正文字号、辅助文字字号（如 14px）；正文行高（如 1.5）；常规字重、加粗字重（100 到 900 的整百）。
  - 间距：基本单位（如 4px）；档位（如 4px、8px、16px，每档都是基本单位的整数倍）。
  - 圆角与阴影：小圆角、大圆角（像素）；卡片阴影、弹窗阴影（CSS 阴影值或"无"）。
  - 布局：内容区最大宽度、页面边距、手机平板分界、平板桌面分界（像素）；侧栏宽度、顶栏高度（像素或"无"）。
  - 组件：按钮高度、按钮左右内边距、输入框高度、表格行高、弹窗宽度、图标尺寸（像素）。
  - 状态：加载中出现时间、动画时长（如 300ms）；提示条消失时间（毫秒或"不自动消失"）。
  - 无障碍：正文最低对比度（不低于 4.5:1）、图标和边框最低对比度（不低于 3:1）、焦点框宽度（像素）、最小点击区域（如 44×44px）。
  - 终端界面：每行列数；成功颜色、警告颜色、出错颜色、提示颜色（红、绿、黄、蓝、品红、青、白、灰之一）。项目没有终端界面时这章只写一行"无"。
- 程序会按颜色章的色值算对比度：每节里文字和背景、次要文字和背景要达到正文最低对比度，主色和背景要达到图标和边框最低对比度。不合格的交稿会被退回并写明原因，按原因改好后重交。
```

`role-rules/worker.md` 在"任务说明里有项目规范时……AGENTS.md 不能改。"那一行之后插入：

```markdown
- 任务说明里有界面设计规范 DESIGN.md 时，改动涉及界面的，颜色、字号、间距、圆角、组件尺寸都用 DESIGN.md 里的值。DESIGN.md 不能改，它只随原型通过由程序写入；需要改时在结果里说明。
```

`role-rules/reviewer.md` 在"核对项目规范"那一行之后插入：

```markdown
- 核对界面设计规范：任务说明里有 DESIGN.md 时，本次界面改动用了 DESIGN.md 之外的颜色、字号、间距、圆角或组件尺寸，列为阻塞；结论 summary 写明核对结果。
```

## 函数清单
### src/modules/verification/project-conventions.ts
| 函数名 | 职责 |
|---|---|
| `designSpecContext` | 新增：读仓库根目录 DESIGN.md，有内容时返回带开头说明的一块文字，否则 `null` |
| `checkConventionsWrite` | 改：目标是任一仓库根目录的 `DESIGN.md` 时也拦下，用上面的原因 |
### src/app/daemon/run-manager.ts
| 函数名 | 职责 |
|---|---|
| 派 worker/reviewer/qa 的那段（`withConventions(context)` 处） | `role` 是 worker 或 reviewer 时，把 `designSpecContext` 的结果接在项目规范后面 |
### src/core/policy/core-permissions.ts
| 函数名 | 职责 |
|---|---|
| `classifyManagedWritePath` | 加 `design_spec` 分类 |
### src/modules/verification/change-apply.ts、src/modules/pm/pm-commit.ts
| 函数名 | 职责 |
|---|---|
| 写入路径检查、提交路径说明表 | 认 `design_spec`，给出上面的原因 |

## 协作关系
`designSpecContext` 用 `DESIGN_SPEC_FILE`（design-spec.ts）。`conventions-guard-extension.ts` 继续调 `checkConventionsWrite`，不改。

## 验证方式
- 测试入口：`designSpecContext`、`checkConventionsWrite`、`classifyManagedWritePath`、change-apply 的写入入口、pm-commit 的提交入口、RunManager 派工（用 `createPmRunWorld` 抓派出的任务说明）、`loadRoleRules`。
- 测试输入：临时仓库根目录有/没有 DESIGN.md；路径 `DESIGN.md`、`design.md`、`docs/DESIGN.md`。
- 预期结果：
- [ ] worker、reviewer 任务说明含开头那行和全文；PM、qa、explore 不含；没有文件时 worker、reviewer 也不含
- [ ] 主窗口 edit/write `DESIGN.md`、`design.md` 被拦，原因一致；`docs/DESIGN.md` 不拦
- [ ] `classifyManagedWritePath("DESIGN.md")`、`("design.md")` 为 `design_spec`，`("docs/DESIGN.md")` 为 `code`；worker 写它报 `design_spec`；PM 提交它被拒，原因一致
- [ ] 三份规矩含成品定义里的句子
