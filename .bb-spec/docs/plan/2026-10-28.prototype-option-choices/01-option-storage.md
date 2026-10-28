---
name: option-storage
description: 设计师交稿时附方案清单并在守护进程里检查、存下；确认决定改为带选定方案；去掉补充说明；数据库版本号升到 9
---
# 方案清单与选定方案的存储

## 目标
设计师交稿能附方案清单（不合格就退回），守护进程存下清单并在"待确认"里交给主窗口；用户通过时能带上选定方案存进草稿和批准版本的原型记录；补充说明（userNote）从数据里删掉。

## 业务规则（来源：PRD）
来自 option-window、choice-downstream：
- 设计师交稿时可附方案清单（名称数组）。不附或附空数组都当作没有清单。附了时先对每个名称做 `sanitizeText`（去掉终端控制字符、双向文字控制符和零宽字符）再去首尾空白，然后按顺序检查，第一个不合格的就退回交稿，不进"等确认"：
  - 少于 2 个："方案清单只有 1 个方案，至少 2 个；只画了一种方案时不附清单"
  - 多于 6 个："方案清单有 N 个方案，最多 6 个"
  - 第 k 个为空："第 k 个方案名是空的"
  - 第 k 个超过 20 字（按码点数）："第 k 个方案名超过 20 字"
  - 第 j 个和第 k 个相同（j<k，取最先发现的一对）："第 j 个和第 k 个方案重名"
  - 退回的建议下一步写"改好方案清单后重交"。k、j 从 1 开始数。
- 检查通过后存下处理过的名称，字母按顺序为 A 到 F。交稿后清单不能再改。
- 用户通过时：这一版有清单就必须带一个清单里存在的字母，存下选定方案（字母 + 名称）；没有清单就不能带字母，选定方案为空。否则拒绝登记，原因写清楚。
- 草稿里同名旧版本被新版本替换时，旧版本的选定方案不转到新版本。批准时选定方案和名称、版本、指纹一起进这一版需求的原型记录，之后的版本沿用时跟着沿用。
- 补充说明整个删掉：决定参数里不再有 note，数据里不再有 userNote。
- 主代理和子代理都没有办法写入或修改选定方案：只有主窗口的确认窗口调 `prototypes.decide` 才能写。
- 数据格式变了，data 库版本号从 8 升到 9，版本 8 列入过期版本；不写迁移。

## 涉及文件
- 修改 `src/modules/requirement/requirement-prototypes.ts`
- 修改 `src/modules/requirement/requirement-prototype-revisions.ts`
- 修改 `src/modules/requirement/requirement-state.ts`
- 修改 `src/modules/pm/result-submit.ts`
- 修改 `src/app/daemon/run-manager.ts`（交稿工具说明、`prototypePending` 透传）
- 修改 `src/app/daemon/method-params.ts`
- 修改 `src/core/storage/database-paths.ts`、`src/core/storage/database.ts`

## 成品定义
`requirement-prototypes.ts` 里的结构（替换原 `PrototypeFile`，`userNote` 删除）：
```ts
const OPTION_LETTERS = ["A", "B", "C", "D", "E", "F"] as const;
const PickedOption = object({ letter: Type.Union(OPTION_LETTERS.map((letter) => Type.Literal(letter))), name: Type.String({ minLength: 1, maxLength: 20 }) });
const PrototypeFile = object({ version: positive, hash: sha256Hex, bytes: Type.Integer({ minimum: 1, maximum: 1_048_576 }), note: Type.String({ maxLength: 2000 }),
  options: Type.Array(Type.String({ minLength: 1, maxLength: 20 }), { maxItems: 6 }), picked: Type.Union([PickedOption, Type.Null()]) });
export type PickedOption = Static<typeof PickedOption>;
```
`requirement-prototype-revisions.ts` 快照里每份原型：`{ name, version, hash, bytes, picked: PickedOption 结构 | null }`（替换 `userNote`；结构同上，在本文件内用 typebox 照样定义或从 requirement-prototypes 引入类型后定义 schema）。

`method-params.ts` 的 `prototypes.decide`：
```ts
"prototypes.decide": Type.Object({ requirementId: id, name: Type.String(), version: positive, hash,
  choice: Type.Union([Type.Literal("accept"), Type.Literal("opinion"), Type.Literal("abandon")]),
  opinion: Type.Union([Type.String({ maxLength: 4000 }), Type.Null()]),
  option: Type.Union([Type.String({ pattern: "^[A-F]$" }), Type.Null()]) }, { additionalProperties: false }),
```
`result-submit.ts` 的设计师参数：
```ts
/** 原型设计师看到的参数：html 是完整的单个 HTML 文件，note 用一句话说明画了什么，options 是画了多个方案时按顺序列出的方案名称。 */
export const PROTOTYPE_SUBMIT_PARAMETERS = object({ action: Type.Literal("prototype"), html: Type.String({ minLength: 1 }), note: Type.String({ minLength: 1, maxLength: 1024 }),
  options: Type.Optional(Type.Array(Type.String())) });
```
`run-manager.ts` 交稿工具说明：`"提交原型（action=prototype）：html 是完整的单个 HTML 文件，note 用一句话说明画了什么；一份原型里画了多个方案时，options 按页面里方案 A、B、C……的顺序列出方案名称（2 到 6 个，每个最多 20 字），只画一种时不填。"`

`database-paths.ts`：`data: 9`；`database.ts` 的 `OUTDATED_VERSIONS.data` 加上 `8`。

## 函数清单
### src/modules/requirement/requirement-prototypes.ts
| 函数名 | 职责 |
|---|---|
| `checkOptionList`（新） | 把交来的名称数组清洗、去空白并按上面的顺序检查，不合格用 `deny` 退回，合格返回处理后的名称数组 |
| `optionLetter`（新，导出） | 按下标给出字母 A–F |
| `pickedOptionText`（新，导出） | 把选定方案拼成 `<字母>「<名称>」，其余方案不做`，供批准窗口和下游清单共用 |
| `submitDesign` | 增加可选 options 入参，调用 `checkOptionList` 后写入 `file.options`，`picked` 初始为 null |
| `pendingConfirmation` | 返回值增加 `options` |
| `decidePrototype` | 入参 `note` 换成 `option`；accept 时按这一版有无清单校验字母并写入 `picked`；删除补充说明相关校验 |
| `DraftItem` / `draftSet` | `userNote` 换成 `picked`（类型跟着改） |

### 其他文件
| 文件 | 函数 | 职责 |
|---|---|---|
| requirement-prototype-revisions.ts | `PrototypeRevision` schema | `userNote` 换成 `picked` |
| requirement-state.ts | 批准时写快照处（约 410 行） | 映射 `picked` 代替 `userNote` |
| result-submit.ts | `execute` | 把 `params.options` 传给 `submitDesign` |
| run-manager.ts | `prototypePending`、交稿工具注册 | 透传 options；替换工具说明文字 |

## 协作关系
设计师 `result_submit` → `execute` → `submitDesign`（`checkOptionList`）→ 本地库。主窗口 `prototypes.pending` → `prototypePending` → `pendingConfirmation`（带 options）。主窗口 `prototypes.decide` → `decidePrototype`（写 picked）→ 批准时 `promoteOnApprovalIn` → `writePrototypeRevision`（带 picked）。

## 验证方式
- 测试入口：`createResultSubmitTool` 的 prototype 动作（或 `submitDesign`）、`pendingConfirmation`、`decidePrototype`、`draftPrototypes`、批准后的 `prototypesAtRevision`、新建数据库的 `user_version`。
- 测试输入：PRD AC-1 的六组清单；带清单的版本分别用 option "B"、null、"G"（不在清单）通过；无清单的版本带 option "A" 通过。
- 预期结果：
- [ ] 五组不合格清单依次退回，原因与上面五句一致（N、k、j 是实际数字），这一版仍在设计中；`[" 顶部分栏 ", "左侧导航"]` 存为 `["顶部分栏", "左侧导航"]`；不附或附 `[]` 时 options 为 `[]`
- [ ] 名称含 `​`、`‮`、`\x1b[31m` 时存下的名称里没有这些字符
- [ ] `pendingConfirmation` 返回 options
- [ ] 带清单选 "B" 后草稿里 picked 为 `{ letter: "B", name: "左侧导航" }`；带清单 option 为 null、字母不在清单，或无清单带字母时都拒绝登记，草稿不变
- [ ] 同名新版本以普通通过替换旧版本后 picked 为 null
- [ ] 批准后该版需求和只改正文的下一版需求的原型记录都带 picked
- [ ] `pickedOptionText({ letter: "B", name: "左侧导航" })` 为 `B「左侧导航」，其余方案不做`
- [ ] 新建 data.db 的版本号是 9；版本 8 的旧库打开时按过期版本报错
- [ ] 源码里没有 `userNote`
