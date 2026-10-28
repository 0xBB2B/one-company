---
name: confirm-window
description: 确认原型窗口按清单列"方案 X：名称"和"其他"，没清单时列"通过"和"其他"；选中方案的登记、绿字、主代理消息；其他的意图确认提示；设计师规矩
---
# 确认原型窗口与主窗口的处理

## 目标
主窗口的确认原型窗口按方案清单列选项，选中即带选定方案通过；"通过并补充说明"删掉；"其他"交给主代理的提示改为先弄清意图；设计师职责规矩写明清单要求。

## 业务规则（来源：PRD option-window）
- 有清单时选项依次是"方案 <字母>：<名称>"（字母 A–F 按顺序，名称是守护进程返回的已清洗名称）和"其他（自己输入）"，打开时光标在方案 A。没有清单时依次是"通过（写进需求草稿）"和"其他（自己输入）"。任何情况下都没有"通过并补充说明（自己输入）"。
- 底部提示：光标在选项行"↑↓ 选择 · 回车确认 · Esc 放弃这一版"；在"其他"行"直接输入 · 回车确认 · Shift+Enter 换行 · ↑↓ 选择 · Esc 放弃这一版"。窗口其余内容（标题、需求、原型名称版本、文件、大小指纹、浏览器是否打开、上一版你的意见、设计师的说明）不变。6 个方案、每个 20 个汉字时 80 列里不超宽、不折行。
- 选中方案回车：调 `prototypes.decide`（choice=accept，option=该字母）；绿字"已登记：原型「<名称>」第 v 版通过，已写进需求草稿。你选了方案 <字母>：<方案名>。"；再把下面两行作为一条消息交给主代理：不在对话显示、不触发回复、下一轮开始时送达（`display: false`，`deliverAs: "nextTurn"`）：
  `用户通过了原型「<名称>」第 v 版，选了方案 <字母>：<方案名>，其余方案不做。`
  `这个选择已和这一版原型一起存下，批准需求后会交给 PM 和子代理。需求正文和它对不上时，按它改正文。`
- 选"通过"：option=null，绿字"已登记：原型「<名称>」第 v 版通过，已写进需求草稿。"，不发消息。
- "其他"回车：照现状登记意见、显示绿字、触发主代理回复，消息逐行为：
  `用户对原型「<名称>」第 v 版提了意见，这一版仍在等用户确认。` / `文件：<路径>` / `用户原话：` / <原话> /
  `先弄清用户想要什么：可能是提问、要改原型，也可能是要改需求正文；拿不准就先用 one_company_user_interact ask 问用户。是提问就回答；要改需求正文就用 updateDraft 改草稿；处理完都用 one_company_prototype confirm 重开这份原型的确认窗口。要改原型时，先把你理解的修改要点告诉用户，问要不要按这些重出一版；用户明确同意后，才用 one_company_prototype dispatch 重派设计师，把确认过的修改要点写进要画什么。设计师会拿到这一版文件和用户原话，重派后这一版作废。`
- Esc、中断、没有界面的处理不变。`confirm` 动作重开的窗口和交稿后自动弹出的一样（都走同一个流程）。
- 设计师职责规矩（`role-rules/prototype.md`）加一条，并把交稿那条的"html 全文和一句说明"补上清单：
  `- 一份原型里画了多个方案时，交稿必须附方案清单（options），最少 2 个、最多 6 个，每个名称最多 20 字；页面里每个方案标上"方案 A""方案 B"……，字母和清单顺序一致。只画了一种方案时不附清单。`

## 涉及文件
- 修改 `src/modules/prototype/prototype-windows.ts`
- 修改 `src/modules/prototype/prototype-extension.ts`
- 修改 `role-rules/prototype.md`

## 函数清单
### src/modules/prototype/prototype-windows.ts
| 函数名 | 职责 |
|---|---|
| `ACCEPT_NOTE_LABEL` | 删除 |
| `optionLabel`（新，导出） | 按字母和名称拼出"方案 X：名称" |
| `PendingPrototype` | 增加 `options: string[]` |
| `confirmWindowContent` | 有清单时 choices 为各方案行，没有时为 `ACCEPT_LABEL` 一行；不再有可输入的通过行 |
| `PrototypeRecord` / `decisionEntryText` | accept 的 `note` 换成可选 `picked`（字母 + 名称），绿字按上面写 |

### src/modules/prototype/prototype-extension.ts
| 函数名 | 职责 |
|---|---|
| `confirmPrototypeFlow` | 把选中的标签映射成 accept + 字母（方案行）或 accept + null（通过行）；删除补充说明分支；选中方案时发下一轮消息；替换"其他"的消息文字 |

## 协作关系
`confirmPrototypeFlow` → `prototypes.pending`（拿 options）→ `confirmWindowContent` → `chooseOrWriteWindow` → `prototypes.decide`（option 字段）→ `decisionEntryText` + `pi.sendMessage`。依赖 option-storage 提供的 `pendingConfirmation` 返回 options、`prototypes.decide` 接受 option。

## 验证方式
- 测试入口：`confirmWindowContent`、`decisionEntryText` 的纯函数输出；用 `QuestionWindowView` 以 80 列渲染 `confirmWindowContent` 的结果；原型扩展在假守护进程客户端和假窗口下跑确认流程（现有 prototype 扩展测试的做法）；读 `role-rules/prototype.md`。
- 测试输入：options `["顶部分栏","左侧导航","卡片网格"]`、`[]`、6 个 20 字名称；窗口里分别选方案 B、选"通过"、在"其他"写"  侧栏窄一点 "、按 Esc。
- 预期结果：
- [ ] 有清单时选项标签依次为"方案 A：顶部分栏""方案 B：左侧导航""方案 C：卡片网格"，另有"其他（自己输入）"，初始光标在方案 A；没清单时为"通过（写进需求草稿）"和"其他（自己输入）"；两者都不含"通过并补充说明"
- [ ] 两种光标位置的底部提示与上面一致；6 × 20 字时每行可见宽度 ≤ 80 且每个方案只占一行
- [ ] 选方案 B：decide 收到 choice=accept、option="B"；绿字和发给主代理的消息与上面一字不差，消息 `display: false`、`deliverAs: "nextTurn"`、不触发回复
- [ ] 选"通过"：option=null；绿字没有"你选了方案"；不发消息
- [ ] "其他"：消息逐行与上面一致，原话去掉首尾空白，触发回复；Esc 登记放弃，行为不变
- [ ] `role-rules/prototype.md` 含上面那条规矩
- [ ] 源码里没有 `ACCEPT_NOTE_LABEL`、`prototype-note`、"补充说明"
