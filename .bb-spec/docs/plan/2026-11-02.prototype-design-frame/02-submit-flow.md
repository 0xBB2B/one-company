---
name: submit-flow
description: 交稿工具收页面清单和两张说明清单，检查不合格就退回，合格则写入拼好的文件
---
# 分开交稿

## 目标
设计师用交稿工具分开交页面、页面清单和说明清单；程序检查后把拼好的单个 HTML 写到这一版原型的文件位置。

## 业务规则（来源：PRD frame-submission）
- 交稿必交：`html`（被设计的页面，一份完整 HTML）、`note`（一句话说明）、`pages`（页面清单）。可选：`options`（方案清单，规则不变）、`prototypeOnly`（只在原型里成立的事）、`openQuestions`（还没确认的问题）。
- `pages` 每项有 `name`、`views`（画面清单），可选 `group`（切换组名，不写时为"状态"）；`views` 每项有 `name`，可选 `notes`（多条说明）。
- 名称检查前和方案名一样处理：去掉终端控制字符、双向文字控制符和零宽字符，中间的换行和连续空白合并成一个空格，去掉首尾空白。说明文字不清洗，只去掉首尾空白并丢掉空条。
- 不合格时退回，错误码 `invalid_pages`，`next` 是"改好页面清单后重交"，这一版仍是设计中，不弹确认窗口。退回原因按这个顺序检查，文字固定：
  - 页面清单为空："页面清单是空的，至少写 1 个页面"
  - 第 k 个页面名为空："第 k 个页面名是空的"
  - 两个页面重名："页面「X」重名"
  - 页面没有画面："页面「X」没有画面，至少写 1 个"
  - 画面名为空："页面「X」的第 k 个画面名是空的"
  - 同一页面里两个画面重名："页面「X」的画面「Y」重名"
- 页面不是 HTML、交稿说明太长、方案清单不合格的退回规则不变。
- 文件大小、文件指纹、1 MiB 上限都按拼好后的文件计算；超过上限时用现有错误码 `too_large`，原因写实际字节数和上限。这个上限保护读文件的下游模型。
- 交稿工具字段缺失或类型不对时，退回原因写明哪个字段不符合，复用现有 `shapeIssue`。
- 数据库记录格式、数据库版本号、协议版本号都不变：`pages` 和两张说明清单只存在拼好的文件里，不写看板。

## 涉及文件
- `src/modules/requirement/requirement-prototypes.ts`（修改）
- `src/modules/pm/result-submit.ts`（修改）
- `src/app/daemon/run-manager.ts`（修改第 921 行工具说明）
- `tests/requirement-prototypes.test.ts`（修改）
- `tests/prototype-dispatch.test.ts`、`tests/requirement-service.test.ts`、`tests/main-requirement-interaction.test.ts`、`tests/core-permissions.test.ts`（修改：交稿调用补上页面清单）
- `tests/acceptance/points/p10-qa-prototype.test.ts`（修改：交稿调用补上页面清单）

## 成品定义
`src/modules/pm/result-submit.ts` 的 `PROTOTYPE_SUBMIT_PARAMETERS` 改成：

```ts
const PROTOTYPE_VIEW = object({ name: Type.String(), notes: Type.Optional(Type.Array(Type.String())) });
const PROTOTYPE_PAGE = object({ name: Type.String(), group: Type.Optional(Type.String()), views: Type.Array(PROTOTYPE_VIEW) });
/** 原型设计师看到的参数：html 是被设计的页面，pages 列出页面和画面，note 用一句话说明画了什么，options 是画了多个方案时按顺序列出的方案名称，prototypeOnly 和 openQuestions 分别是只在原型里成立的事和还没确认的问题。 */
export const PROTOTYPE_SUBMIT_PARAMETERS = object({ action: Type.Literal("prototype"), html: Type.String({ minLength: 1 }), note: Type.String({ minLength: 1, maxLength: 1024 }),
  pages: Type.Array(PROTOTYPE_PAGE), options: Type.Optional(Type.Array(Type.String())),
  prototypeOnly: Type.Optional(Type.Array(Type.String())), openQuestions: Type.Optional(Type.Array(Type.String())) });
```

`src/app/daemon/run-manager.ts` 里 `toPiTool("result_submit", …)` 的说明文字改成：

```text
提交原型（action=prototype）：html 是被设计的页面，只含正式上线后用户能看到的内容；pages 列出要看的页面，每个页面的 views 列出它的画面，notes 写这个画面的说明，group 是这组切换的名字，不写时显示"状态"；note 用一句话说明画了什么；prototypeOnly 写只在原型里成立的事；openQuestions 写还没确认的问题；一份原型里画了多个方案时，options 按方案 A、B、C……的顺序列出方案名称（2 到 6 个，每个最多 20 字），只画一种时不填。
```

## 函数清单
### src/modules/requirement/requirement-prototypes.ts
| 函数名 | 职责 |
|---|---|
| `checkPageList`（新增） | 按业务规则检查并整理页面清单，不合格时退回 |
| `submitDesign`（修改） | 收页面清单和两张说明清单；在看板事务里取到版本号后调用 `buildPrototypeFrame`，按拼好的文件检查上限、写文件、记大小和指纹 |

### src/modules/pm/result-submit.ts
| 函数名 | 职责 |
|---|---|
| `execute`（修改） | 把新字段传给 `submitDesign`；`prototype` 动作字段不符合时用 `shapeIssue` 写明原因 |

## 协作关系
`createResultSubmitTool.execute` → `submitDesign` → `checkPageList`、`buildPrototypeFrame`。`checkPageList` 放在 `checkOptionList` 旁边，复用同一套名称处理。看板、确认窗口、批准、备份和归档读到的都是拼好的文件，它们的代码不改。

## 验证方式
- 测试入口：`submitDesign`、`createResultSubmitTool(...).execute`、`pendingConfirmation`、`prototypeFilePath`。
- 测试输入：一条有效需求和设计中的原型，配合下面各项的页面清单。
- 预期结果：合格时写入拼好的文件并进入等确认；不合格时退回，这一版仍是设计中。
- [ ] 带全部字段交稿被收下；只带 `html`、`note`、`pages` 也被收下。
- [ ] 六种不合格的页面清单各自退回，`advice.why` 与业务规则的文字完全一致，`advice.next` 是"改好页面清单后重交"，看板状态仍是 `designing`。
- [ ] 名称带换行和连续空白时按合并后的结果判重。
- [ ] 文件位置的内容含外框固定文字，也含页面的 `<h1>`；`pendingConfirmation` 返回的 `bytes` 和 `hash` 与文件实际内容一致。
- [ ] 页面本身不到 1 MiB、拼好后超过时，退回错误码 `too_large`，原因含实际字节数和 1048576。
- [ ] 不是 HTML 的页面仍退回"交稿内容不是 HTML 页面"。
- [ ] 工具调用缺 `pages` 时退回 `invalid_shape`，原因里写到 `pages`。
- [ ] 确认窗口的选项和通过流程不变：`tests/prototype-windows.test.ts` 全过。
- [ ] 全量 `pnpm test`、`pnpm run test:integration` 通过。
