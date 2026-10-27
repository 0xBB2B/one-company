---
name: note-downstream
description: 批准需求窗口、PM 清单和子代理任务说明里的原型清单带上补充说明原话
---
# 补充说明交给批准窗口和下游

## 目标
用户写的补充说明原话出现在"批准需求"窗口里，并出现在 PM 和 worker、reviewer、qa 拿到的原型清单里。

## 业务规则（来源：PRD note-downstream）
- 批准窗口原型清单：带补充说明的"本次新确认"或"沿用"原型，在它那一行下面多一行灰字（muted）"    你的说明：「<补充说明>」"（前面 4 个空格）；"本次移除"和没有说明的原型不加。其他内容（标题行、名称、版本、标签、颜色、排序、末行"原型的样子以你在浏览器里通过的那一版为准。"）保持现状。
- worker、reviewer、qa 的任务说明里的原型清单：带说明的原型在它那一行下面多一行"  用户通过时的说明：<补充说明>"（前面 2 个空格）；没有说明的和现状一样。说明来自子代理所依据的那一版需求。
- PM 接手说明和需求更新通知里"当前批准版本附带的原型"：带说明的写成"- <名称> 第 v 版（用户说明：<补充说明>）"；没有说明的和现状一样（"- <名称> 第 v 版"）。
- 补充说明一律原话，不改写、不截断。

## 涉及文件
- 修改 `src/modules/prototype/prototype-dispatch.ts`
- 修改 `src/modules/interaction/main-requirement-interaction.ts`
- 修改 `tests/prototype-dispatch.test.ts`、`tests/main-requirement-interaction.test.ts`、`tests/downstream-prototypes.test.ts`、`tests/pm-event-delivery.test.ts`（按需补用例）

## 函数清单
### src/modules/prototype/prototype-dispatch.ts
| 函数名 | 职责 |
|---|---|
| `requirementPrototypeLines` | 入参每项带 `userNote`；有说明时在该项下面加"  用户通过时的说明：…" |
| `approvedPrototypeListLines` | 入参每项带 `userNote`；有说明时该项末尾加"（用户说明：…）" |

### src/modules/interaction/main-requirement-interaction.ts
| 函数名 | 职责 |
|---|---|
| `#prototypeLines` | new / kept 且有 `userNote` 的行后面加一行 muted 的"    你的说明：「…」" |

## 协作关系
依赖 plan 02：`DraftItem` 和 `prototypesAtRevision` 读出的每项带 `userNote`。调用方 `run-manager.ts`（pmContext、派子代理处）和 `pm-event-delivery.ts` 直接把快照条目传入，不用改调用代码；类型对不上时只改参数类型。

## 验证方式
- 测试入口：`requirementPrototypeLines(revision, items, pathOf)`、`approvedPrototypeListLines(items)`；批准窗口沿用 `tests/main-requirement-interaction.test.ts` 里画批准窗口原型清单的现有用例方式；子代理提示词沿用 `tests/downstream-prototypes.test.ts` 的方式；PM 更新通知沿用 `tests/pm-event-delivery.test.ts` 的方式。
- 测试输入：快照/草稿里"设置页"第 1 版 `userNote: "用 B 方案（顶部分栏），A 和 C 不要"`，"命令行输出"第 2 版 `userNote: null`；批准窗口另有一份移除的"旧外观弹窗"（`userNote: "旧说明"`）和一份新确认的"首页"（`userNote: null`）。
- 预期结果：
- [ ] `requirementPrototypeLines`："设置页"那一行下面紧跟"  用户通过时的说明：用 B 方案（顶部分栏），A 和 C 不要"；"命令行输出"下面没有说明行；其他行与现状一致
- [ ] `approvedPrototypeListLines`：["当前批准版本附带的原型：", "- 设置页 第 1 版（用户说明：用 B 方案（顶部分栏），A 和 C 不要）", "- 命令行输出 第 2 版"]；空列表仍为 ["这一版没有原型"]
- [ ] 批准窗口："设置页"行后紧跟 muted 行"    你的说明：「用 B 方案（顶部分栏），A 和 C 不要」"；"旧外观弹窗"（移除）和"首页"下面没有说明行；其余行与现状一致
- [ ] worker 提示词的原型清单含"  用户通过时的说明：用 B 方案（顶部分栏），A 和 C 不要"
- [ ] 第 3 版带"用 B"、第 4 版换成第 2 版带"用 C"时，按各自版本派出的子代理分别拿到"用 B"和"用 C"
- [ ] PM 更新通知的原型清单含"- 设置页 第 1 版（用户说明：…）"
