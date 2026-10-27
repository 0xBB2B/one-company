---
name: confirm-flow
description: 确认原型窗口换成通过、通过并补充说明、返工三项，Esc 登记放弃，补充说明下一轮交给主代理
---
# 确认原型流程

## 目标
"确认原型"窗口按新选项工作：通过、通过并补充说明（输入）、返工（输入）；按 Esc 登记放弃；中断或没有界面时不登记；补充说明在主代理下一轮交给它。

## 业务规则（来源：PRD confirm-window）
- 选项依次："通过（写进需求草稿）""通过并补充说明（自己输入）""返工（自己输入要改什么）"。底部提示：不在输入行时"↑↓ 选择 · 回车确认 · Esc 放弃这一版"；在输入行时"直接输入 · 回车确认 · ↑↓ 选择 · Esc 放弃这一版"。窗口其他行保持现状。补充说明和返工意见上限都是 4000 字。
- 通过并补充说明：守护进程登记 accept 并带上去掉首尾空白的说明；对话里绿字"已登记：原型「<名称>」第 v 版通过，已写进需求草稿。你的说明：「<补充说明>」"；再给主代理发一条消息，内容两行："用户通过了原型「<名称>」第 v 版，并补充说明：<补充说明>"和"这句说明已和这一版原型一起存下，批准需求后会原话交给 PM 和子代理。需求正文和这句说明对不上时，按它改正文。"这条消息不在对话里显示，不触发回复，用户下一次说话时主代理才看到（pi `sendMessage` 的 `deliverAs: "nextTurn"`、`display: false`）。
- 普通通过：登记 accept，note 为 null；绿字和现状一致；不发消息给主代理。
- 按 Esc：登记 abandon；绿字"已登记：放弃原型「<名称>」第 v 版，它不再挡住批准。"；不触发主代理。经 `confirm` 工具打开的窗口按 Esc 也一样，工具结果写明用户放弃了这一版。
- 工具被中断（signal abort）或没有界面：不调用 decide，这一版仍在途。
- 返工保持现状（意见原话交主代理并触发回复）。
- 文件被改过等登记失败的处理保持现状。

## 涉及文件
- 修改 `src/modules/prototype/prototype-windows.ts`
- 修改 `src/modules/prototype/prototype-extension.ts`
- 修改 `tests/prototype-windows.test.ts`

## 函数清单
### src/modules/prototype/prototype-windows.ts
| 函数名 | 职责 |
|---|---|
| `ACCEPT_NOTE_LABEL`（新常量） | "通过并补充说明（自己输入）" |
| `ABANDON_LABEL` | 保留值"放弃这一版"，只作为 Esc 的指定答案 |
| `confirmWindowContent` | 选项改为通过、通过并补充说明（`writable: true`）；`otherLabel` 返工；`escapeChoice: ABANDON_LABEL`；`escapeHint: "Esc 放弃这一版"` |
| `PrototypeRecord` / `decisionEntryText` | accept 记录可带补充说明；有说明时绿字末尾加"你的说明：「…」" |

### src/modules/prototype/prototype-extension.ts
| 函数名 | 职责 |
|---|---|
| `confirmPrototypeFlow` | 按答案映射 choice 与 note（通过并补充说明 → accept + 说明；通过 → accept + null；Esc 指定答案 → abandon；"其他"文字 → rework）；`decide` 调用带 `note`；有说明时发 nextTurn 消息；返回结果区分放弃 |
| `FlowResult` / `confirm` 动作的结果文字 | 新增"放弃"结果，文字写明"用户按 Esc 放弃了这一版" |

## 协作关系
依赖 plan 01 的 `writable`、`escapeChoice`，依赖 plan 02 的 `prototypes.decide` 接收 `note`。消息走 `pi.sendMessage({ customType, content, display: false }, { deliverAs: "nextTurn" })`，不经 `tell`（`tell` 会触发回复）。

## 验证方式
- 测试入口：`tests/prototype-windows.test.ts` 现有的 harness（`prototypeExtension(pi, { windowReady, openFile })`，`emit("prototype.submitted")` 弹窗、`run({ action: "confirm" })` 走工具），通过 `called("prototypes.decide")`、`appendEntry`、`sendMessage` 断言。
- 测试输入：待确认的"设置页"第 2 版。
- 预期结果：
- [ ] 窗口逐行画面：选项三行顺序和文字如上，提示行为"{↑↓ 选择 · 回车确认 · Esc 放弃这一版}"，其他行和现状一致
- [ ] ↓ 到第 2 行，提示为"{直接输入 · 回车确认 · ↑↓ 选择 · Esc 放弃这一版}"；直接回车不调用 decide；输入"用 B 方案"回车 → decide 参数 `choice: "accept", note: "用 B 方案", opinion: null`；绿字带"你的说明：「用 B 方案」"；`sendMessage` 只调用 1 次，content 含上面两行，选项为 `{ deliverAs: "nextTurn" }`，消息 `display` 为 false
- [ ] 第 1 行回车 → decide `choice: "accept", note: null`；绿字和现状一致；`sendMessage` 没被调用
- [ ] 按 Esc → decide `choice: "abandon", note: null, opinion: null`；放弃的绿字；`sendMessage` 没被调用
- [ ] 经 `confirm` 工具打开后按 Esc → 工具结果含"放弃"
- [ ] 经 `confirm` 工具打开后中断 signal → 不调用 decide，没有记录
- [ ] 没有界面时不弹窗、不调用 decide
- [ ] 返工：decide `choice: "rework", opinion: <原话>, note: null`，主代理消息 `{ triggerTurn: true }`（与现状一致）
