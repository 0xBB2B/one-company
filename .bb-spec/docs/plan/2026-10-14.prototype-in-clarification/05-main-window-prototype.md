---
name: main-window-prototype
description: 主窗口原型工具与三个程序窗口：交稿后自动打开浏览器并弹确认窗口、重开、移除；面板显示设计运行；主代理提示词
---
# 主窗口原型工具与窗口

## 目标
主代理能派原型设计师、挑设计师定义、查看原型状态、让程序重开确认窗口或弹出移除窗口。设计师交稿后，程序自动打开浏览器并弹出确认窗口。用户的决定由程序直接登记，不经过模型。

## 业务规则（来源：PRD confirm-prototype、prototype-designer）
- **确认原型窗口**依次显示：
  - 标题"确认原型"
  - "需求：<标题>（草稿，第 N 版）"，其中 N 等于 revision+1
  - "原型：<名称>（第 v 版）"
  - 文件位置（灰色，过长时按目录断行）
  - "大小 … · 指纹 sha256:<前 12 位>…"
  - 浏览器是否打开：打开了显示灰色的"已在默认浏览器打开这个文件。"，没打开显示普通颜色的"浏览器没有打开，请手动打开上面的文件。"
  - 返工后的版本多一行"上一版你的意见：「…」"
  - "设计师的说明（模型写的，仅供参考）：「…」"
- 确认窗口的选项依次是"通过（写进需求草稿）""放弃这一版""返工（自己输入要改什么）"，提示"↑↓ 选择 · 回车确认 · Esc 暂不决定（之后让主代理再打开）"。
- 选完后在对话里写一条绿色的程序记录，不发给模型：
  - 通过："已登记：原型「X」第 v 版通过，已写进需求草稿。"
  - 放弃："已登记：放弃原型「X」第 v 版，它不再挡住批准。"
  - 返工："已登记：原型「X」第 v 版返工，你的意见已原话交给主代理重派设计师。"返工还要给主代理发一条消息并让它接着回复，消息里写上一版文件位置和用户原话。通过和放弃不让主代理回复。
- 按 Esc 不登记任何决定，这一版仍在途。
- 没有界面（hasUI 为假）或窗口没有返回结果时，按 Esc 处理。
- 同时有几份原型交稿时，确认窗口排队，一个一个弹。
- **移除原型窗口**依次显示：
  - 标题"移除原型"
  - "需求：<标题>（草稿，第 N 版）"
  - "原型：X（第 v 版，第 M 版需求里批准过 / 本次草稿新通过）"
  - 灰色的"移除后，批准第 N 版时它不再交给 PM 和子代理；文件留在本机，不删除。"
  - 选项"移除""保留"，提示"↑↓ 选择 · 回车确认 · Esc 取消（保留）"
  - 选"移除"后记录"已登记：原型「X」从草稿移除，批准第 N 版后生效。"
- 设计师没交稿就结束时，程序给主代理发一条消息写明原因，并让它接着回复。
- 主代理只能让程序弹窗、查状态，没有任何工具能直接登记通过、返工、放弃或移除。
- 面板：显示"● N 个原型设计运行中"，每行"├─/└─ 转圈 名称（第 v 版）· 定义名 · ↻已用/上限 · 用时"；位置在需求一组之后、检索一组之前。
- 主代理提示词要写明以下几点：
  - 需求涉及界面时，在澄清阶段先建草稿，再派原型设计师；
  - 用户点名的设计师定义优先，没点名就按描述挑，点名的用不了要告诉用户、不换别的；
  - 用户想再看原型时，让程序重开确认窗口；
  - 用户不要某份原型时，弹移除窗口；
  - 批准被在途原型拦下时，照实转告原因。

## 涉及文件
- extensions/prototype.ts（新建：注册 `one_company_prototype` 工具，订阅 submitted、finished 事件，弹窗队列）
- extensions/index.ts（修改：加载新扩展）
- runtime/prototype-windows.ts（新建：两个窗口的内容与登记文字，`pathLines`、`formatBytes` 从 extensions/pm-panel.ts 搬过来；`openWithSystem` 搬进 extensions/prototype.ts，pm-panel 里这几处随之删掉）
- runtime/protocol.ts（修改：`prototypes.pending`、`prototypes.decide`、`prototypes.remove`）
- daemon/run-manager.ts（修改：注册上面三个 RPC，调用看板函数）
- extensions/pm-panel.ts、runtime/pm-panel.ts（修改：订阅 prototype.changed，拉 `prototypes.list`，渲染新的一组）
- rules/01-main-session.md（修改：加原型这一步）
- tests/prototype-windows.test.ts（新建）、tests/pm-panel.test.ts（修改）

## 成品定义
主窗口工具参数（`one_company_prototype`，参数写成 {request:{action,...}}）：
```ts
Type.Union([
  object({ action: Type.Literal("designers"), repoId }),
  object({ action: Type.Literal("dispatch"), repoId, requirementId: id, name, brief, maxTurns: Type.Integer({ minimum: 1, maximum: 100 }), agent: Type.Optional(agentName) }),
  object({ action: Type.Literal("status"), repoId, requirementId: id }),
  object({ action: Type.Literal("confirm"), repoId, requirementId: id, name }),
  object({ action: Type.Literal("remove"), repoId, requirementId: id, name }),
])
```
协议新增：
```ts
"prototypes.pending": { requirementId: id, name }                       // 返回确认窗口要显示的内容；没有待确认版本时报原因和当前状态
"prototypes.decide":  { requirementId: id, name, version: positive, hash: sha256Hex, choice: "accept"|"rework"|"abandon", opinion: Type.Union([Type.String({ maxLength: 4000 }), Type.Null()]) }
"prototypes.remove":  { requirementId: id, name }
```

## 函数清单
### extensions/prototype.ts
| 函数名 | 职责 |
|---|---|
| `registerPrototypeTool` | 注册工具：dispatch 带上主窗口当前的模型和思考等级；confirm 和 remove 走窗口流程；status、designers 原样返回 |
| `registerPrototypeDelivery` | session_start 后订阅 submitted 和 finished，按本会话 id 过滤：submitted 进窗口队列，finished 给主代理发消息 |
| `confirmPrototypeFlow` | 先取 pending，用浏览器打开文件，弹确认窗口，再调 decide，写程序记录；返工时额外发消息 |
| `removePrototypeFlow` | 弹移除窗口，选"移除"后调 remove，写程序记录 |
### runtime/prototype-windows.ts
| 函数名 | 职责 |
|---|---|
| `confirmWindowContent` / `removeWindowContent` | 按上面的文字拼窗口内容 |
| `decisionEntryText` | 三种决定、移除各自的登记文字 |
| `pathLines` / `formatBytes` | 从 extensions/pm-panel.ts 搬过来 |
### runtime/pm-panel.ts
| 函数名 | 职责 |
|---|---|
| `updatePrototypes` 和渲染 | 新增"原型设计运行中"这一组 |

## 协作关系
- 工具调用守护进程的方式照抄 `extensions/agent-manage.ts`：校验参数，`clients.forRepo` 找到连接，`call`，失败时用 `toolFailure` 包装。
- 自动弹窗用 session_start 时拿到的 ctx；先 `revokeCapturedInput()`，再 `pi.sendMessage(..., {triggerTurn:true})`，和检索结果送达时一样。
- 窗口复用 `runtime/question-window.ts` 的 `chooseOrWriteWindow` 和 `chooseWindow`。

## 验证方式
- 测试入口：用假 pi 宿主加载扩展（同 tests/pm-panel.test.ts 的写法），手动发出守护进程事件，并调用工具。
- 预期结果：
  - [ ] 收到 submitted 后，浏览器打开函数被调用一次，弹出的窗口内容和选项顺序与上面一致；没打开时那一行文字正确。
  - [ ] 选通过、放弃、返工后，decide 收到对应的 choice；程序记录文字正确；只有返工时 sendMessage 被调用，内容有文件位置和原话。
  - [ ] 返工意见为空时窗口不能确认；按 Esc 时 decide 没被调用。
  - [ ] 两份几乎同时交稿：第一个窗口关掉之后才弹第二个。hasUI 为假时不弹，也不调用 decide。
  - [ ] confirm 动作在有待确认版本时重开窗口；没有时返回原因和当前状态，不弹窗。
  - [ ] remove 动作：选"移除"后调用 remove；选"保留"或按 Esc 时不调用；草稿里没有的名字直接返回原因。
  - [ ] 收到 finished 后，sendMessage 内容带原因。
  - [ ] 面板同时有需求、设计、检索时，按这个顺序显示，设计行格式正确。
  - [ ] 主代理能用的工具里，没有直接登记决定的入口。
  - [ ] 主代理提示词包含上面列出的几点。
