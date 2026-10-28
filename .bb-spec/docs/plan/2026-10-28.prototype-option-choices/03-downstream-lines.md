---
name: downstream-lines
description: 批准需求窗口、PM 说明与更新通知、worker/reviewer/qa 任务说明里的原型清单写选定方案，去掉补充说明行
---
# 选定方案交给批准窗口和下游

## 目标
批准窗口、PM、子代理看到的原型清单里，带选定方案的原型写明"<字母>「<方案名>」，其余方案不做"，不再出现补充说明。

## 业务规则（来源：PRD choice-downstream）
- 批准需求窗口：带选定方案的本次新确认或沿用的原型，那一行下面加一行灰字（muted）`    你选的方案：B「左侧导航」，其余方案不做`（前面 4 个空格）；本次移除的、没有选定方案的不加。清单其他内容（标题行、名称、版本、标签、颜色、排序、最后一行"原型的样子以你在浏览器里通过的那一版为准。"）不变。
- worker、reviewer、qa 的任务说明：带选定方案的原型那一行下面加 `  用户选的方案：B「左侧导航」，其余方案不做`；没有的不加。每个子代理用它所依据的需求版本的原型记录（现有的 promptRevision 逻辑不变）。
- PM 接手说明和需求更新通知里"当前批准版本附带的原型"：带选定方案写 `- 设置页 第 1 版（用户选的方案：B「左侧导航」，其余方案不做）`，没有的写 `- 设置页 第 1 版`；没有原型时仍是"这一版没有原型"。
- 字母和"其余方案不做"由程序写，名称来自交稿时已清洗过的清单，不经模型转述。三处都不再出现"你的说明""用户说明""用户通过时的说明"。
- 拼"B「左侧导航」，其余方案不做"统一用 option-storage 里导出的 `pickedOptionText`。

## 涉及文件
- 修改 `src/modules/interaction/main-requirement-interaction.ts`（`#prototypeLines`）
- 修改 `src/modules/prototype/prototype-dispatch.ts`
- 修改 `src/app/daemon/run-manager.ts`（`pmContext` 的入参类型）
- 修改 `src/modules/pm/pm-event-delivery.ts`（如入参类型需要跟着改）

## 函数清单
| 文件 | 函数名 | 职责 |
|---|---|---|
| main-requirement-interaction.ts | `#prototypeLines` | 选定方案行代替"你的说明"行 |
| prototype-dispatch.ts | `requirementPrototypeLines` | 入参 `userNote` 换成 `picked`，输出"用户选的方案"行 |
| prototype-dispatch.ts | `approvedPrototypeListLines` | 入参 `userNote` 换成 `picked`，括号里写"用户选的方案：…" |
| run-manager.ts | `pmContext` | 原型入参类型改为带 `picked` |

## 协作关系
`#prototypeLines` 读 `draftPrototypes` 的 `DraftItem.picked`；`requirementPrototypeLines`、`approvedPrototypeListLines` 读 `prototypesAtRevision` 的快照 `picked`；三者都调 `pickedOptionText`。依赖 option-storage 完成数据结构替换。

## 验证方式
- 测试入口：`requirementPrototypeLines`、`approvedPrototypeListLines` 纯函数；批准需求窗口（现有 main-requirement-interaction 测试的做法：读 confirmWindow 收到的 lines）；PM 派 worker/reviewer/qa 的上下文与 PM 接手说明、更新通知（现有 downstream-prototypes、pm-event-delivery、pm-overview 测试的做法）。
- 测试输入：草稿/批准版本里"设置页"第 1 版 picked=B「左侧导航」（新确认）、"首页"第 1 版 picked=A「顶部分栏」（沿用）、"命令行输出"第 2 版 picked=null（沿用）、"旧外观弹窗"第 1 版（移除）；AC-4 的两个版本先后派 worker。
- 预期结果：
- [ ] 批准窗口里"设置页"和"首页"下面各有一行 muted 的"    你选的方案：…，其余方案不做"，"命令行输出""旧外观弹窗"下面没有附加行，其余行和现状一致
- [ ] 三类子代理任务说明里"设置页"下面有"  用户选的方案：B「左侧导航」，其余方案不做"，"命令行输出"下面没有附加行
- [ ] 按第 3 版派的 worker 拿到第 1 版和 B，按第 4 版派的拿到第 2 版和 A「双栏布局」
- [ ] PM 接手说明和更新通知都是"- 设置页 第 1 版（用户选的方案：B「左侧导航」，其余方案不做）"和"- 命令行输出 第 2 版"
- [ ] 方案名交稿时含零宽字符、双向控制符的，三处显示都不含
- [ ] 三处输出里都没有"你的说明""用户说明""用户通过时的说明"
