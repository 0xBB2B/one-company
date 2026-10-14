---
name: approval-integration
description: 批准带上原型：在途拦截、批准窗口原型清单、窗口所见集合经操作记录绑定、批准时写版本快照、只换原型也能批准、PM 通知原型变化
---
# 批准需求时带上原型

## 目标
批准一版需求，就是连同草稿里的原型集合一起批准。批准时程序按版本写一份只读快照。PM 收到的更新通知里写明原型怎么变了。

## 业务规则（来源：PRD approval-with-prototypes）
- 草稿里有在途原型时，拒绝批准，不弹窗。拒绝原因逐个写出在途原型的名称和状态（"原型「X」第 v 版还在等你确认""原型「Y」设计师还在做"），建议"先把这些处理完（通过、返工或放弃），再说批准"。
- 草稿集合或最近批准版本里只要有原型（包括本次要移除的），批准时一定弹"批准需求"窗口，用户 @ 了需求也弹。窗口在原来的需求、编号、仓库、简介之后加一段：
  - 一行"这一版一起批准的原型（N 份）："，N 只数新确认和沿用的。
  - 每份原型一行"名称  第 v 版  标签"，顺序是新确认、沿用、移除。标签有三种：本次新确认（绿色）、"沿用第 M 版需求"（普通颜色，M 是当前已批准的版本号）、本次移除（红色）。
  - 最后一行灰色的"原型的样子以你在浏览器里通过的那一版为准。"
- 没有原型时行为不变：@ 了需求不弹窗；没 @ 时弹的窗口里没有清单。
- 窗口显示时算出草稿集合的指纹，经批准操作记录一路带到写入批准的那个事务。事务里要再确认两件事：没有在途原型，指纹没变。不满足就拒绝，原因写"原型在批准过程中变了，请重新批准"。
- 批准成功后，这一版包含新确认和沿用的原型，不包含移除的。程序写一份只读的版本快照（第几版需求含哪些原型的哪一版）。没动过的原型原样沿用。
- 草稿正文一个字没改、只改了原型时，也能批准，版本号加 1。主代理用 metadata 就能拿到当前草稿对应的保存操作编号，不必再存一次草稿。
- 批准时交给解读模型的差异文字：正文有差异时照旧给差异；没有差异时写"正文没有差异。"。原型有变化时，再加几行"原型变化：设置页 换成第 3 版；命令行输出 新确认第 1 版；旧外观弹窗 移除"。
- PM 收到的"已批准更新"通知，在原有两行后加原型变化行（格式同上，按两个版本的快照算）；原型没变化时不加。
- 用户在窗口里取消时不批准，草稿和原型状态都不变。

## 涉及文件
- runtime/requirement-prototype-revisions.ts（新建：版本快照的读写与两版比较）
- runtime/main-requirement-interaction.ts（修改：confirm 拦截、窗口清单、差异文字、把指纹交给 confirmUpdate）
- runtime/requirement-service.ts（修改：confirmUpdate 带上原型集合指纹；metadata 返回 savedOperationId）
- runtime/requirement-operations.ts（修改：操作记录加可选字段 `prototypes`；按当前 saved 查保存操作编号）
- runtime/requirement-state.ts（修改：`recordApprovedVersion` 在同一事务里调用 `promoteOnApproval` 并写快照）
- runtime/requirement-manage-contracts.ts（修改：ConfirmUpdateInput、metadata 结果）
- runtime/pm-event-delivery.ts（修改：通知加原型变化行）
- runtime/host-authorization.ts（修改：新增两个原因 `prototype_in_flight`、`prototype_changed`）
- tests/main-requirement-interaction.test.ts、tests/requirement-service.test.ts、tests/pm-event-delivery.test.ts（修改）、tests/requirement-prototype-revisions.test.ts（新建）

## 成品定义
版本快照（命名空间 `requirement_prototype_revisions`，键 `<requirementId>:<revision>`，只在批准时写一次，之后不改）：
```ts
const PrototypeRevision = object({ requirementId: id, revision: positive,
  prototypes: Type.Array(object({ name: Type.String({ minLength: 1, maxLength: 40 }), version: positive, hash: sha256Hex, bytes: positive }), { maxItems: 50 }) });
```
操作记录新增字段（照 `docSpec` 的写法，只允许 confirmUpdate 带）：`prototypes: Type.Optional(sha256Hex)`，内容是草稿原型集合的指纹。幂等比较要把它算进去。

## 函数清单
### runtime/requirement-prototype-revisions.ts
| 函数名 | 职责 |
|---|---|
| `writePrototypeRevision` | 批准事务内写快照，同键已存在且内容不同就报错 |
| `prototypesAtRevision` | 读某一版的原型集合，revision 为 0 或没有快照时返回空 |
| `prototypeChanges` | 比较两版集合，得出新确认、替换、移除的清单 |
| `prototypeChangeLines` | 把变化清单写成"原型变化：…"文字 |
| `allRevisionPrototypes` | 某个需求所有快照引用的文件（备份用） |
### runtime/main-requirement-interaction.ts
| 函数名 | 职责 |
|---|---|
| `confirm`（修改） | 在现有前置检查之后、弹窗之前：用 `inFlightSummary` 拦截在途原型；有原型时不管是否 @ 都弹窗并加清单；把集合指纹交给 confirmUpdate |
| `#prototypeLines`（新增） | 按 `draftPrototypes` 的标签拼清单行，使用现有颜色 added、normal、removed |
| `#ensureCore` 的差异文字（修改） | 无正文差异时用"正文没有差异。"，再接上原型变化行 |
### runtime/requirement-service.ts、runtime/requirement-operations.ts
| 函数名 | 职责 |
|---|---|
| `confirmUpdate` / `writeOwned`（修改） | 把 `prototypes` 指纹写进操作记录，并传给 `recordApprovedVersion` |
| `metadata`（修改） | 结果加 `savedOperationId`：指向当前 saved 的、已完成的保存操作 |
| `savedOperationFor`（新增，operations） | 按需求和 saved 引用找到这个操作编号 |
### runtime/requirement-state.ts
| 函数名 | 职责 |
|---|---|
| `recordApprovedVersion`（修改） | 在原有事务里递增 revision 之后，调用 `promoteOnApproval` 和 `writePrototypeRevision`；只要看板或任一快照里有原型，就要求带指纹 |
### runtime/pm-event-delivery.ts
| 函数名 | 职责 |
|---|---|
| `deliverApprovedEvents`（修改） | 通知末尾加上 `prototypeChangeLines(from, to)` |

## 协作关系
- 依赖 02 的 `inFlightSummary`、`draftPrototypes`、`promoteOnApproval`。
- 指纹的传递路线跟现有 `docSpec` 一样：confirm → service.confirmUpdate → 操作记录 → recordApprovedVersion。
- 恢复时重放操作，用的是操作记录里存下的指纹。

## 验证方式
- 测试入口：`MainRequirementInteraction.confirm`（用假窗口宿主和脚本化的解读模型）、`RequirementService.metadata`、`deliverApprovedEvents`。
- 预期结果：
  - [ ] 有 designing 和 awaiting 各一份时，带 @ 和不带 @ 的批准都被拒，没有弹窗。原因文字逐个列出两份的名称和状态。
  - [ ] 草稿新通过"设置页" v3、沿用 v2 需求里的"命令行输出" v1、移除"旧外观弹窗"时，@ 批准也弹窗。清单标题"（2 份）"，三行的顺序、颜色和标签都正确，最后一行文字正确。
  - [ ] 首次批准时清单只有新确认的；不带原型的需求，@ 批准时不弹窗，不 @ 时窗口没有清单。
  - [ ] 取消后看板不变；确认后第 N 版快照只有"设置页" v3 和"命令行输出" v1，看板上 approved 已更新、draft 已清空。
  - [ ] 窗口显示之后、写入之前，看板被改（例如通过了一份新原型），批准被拒，原因是"原型在批准过程中变了"。
  - [ ] 只改原型、正文不动：用 metadata 返回的 savedOperationId 批准成功，revision 加 1；解读模型收到的差异文字含"正文没有差异。"和原型变化行。
  - [ ] 只改正文再批准：新快照里沿用上一版的原型。
  - [ ] PM 通知含"原型变化：设置页 换成第 3 版；命令行输出 新确认第 1 版；旧外观弹窗 移除"；原型没变时通知和现在一样。
