---
name: note-storage
description: 通过时的补充说明存进原型草稿和批准版本快照，守护进程接收 note，数据库版本号升到 8
---
# 补充说明的存储

## 目标
守护进程登记"通过"时能收下一段补充说明，和这一版原型一起存进需求草稿；批准需求时随原型记进这一版的原型快照，之后的版本沿用时跟着沿用。

## 业务规则（来源：PRD confirm-window、note-downstream）
- 补充说明是用户在确认窗口"通过并补充说明"一行写的话：去掉首尾空白后不能为空，最长 4000 字。
- 普通"通过"时这一版没有补充说明（存 null）；同名旧版本的补充说明不转到新版本。
- 放弃（按 Esc）时：这一版不再在途，不进草稿；草稿里同名已通过版本和它的补充说明不变。返工保持现状。
- 批准需求时，每份原型的补充说明和名称、版本、指纹、大小一起记进这一版的原型快照；沿用的原型带着原来的说明。
- 有在途原型时拒绝批准，给主代理的处理办法改为"先把它处理完（通过、返工，或在确认窗口按 Esc 放弃），再说批准"；多份时"它"换成"这 N 份"。
- 数据格式变了：按项目规矩把 data.db 版本号从 7 升到 8，7 列入过期版本，旧库打开时按现有方式报错；不写迁移。

## 涉及文件
- 修改 `src/modules/requirement/requirement-prototypes.ts`
- 修改 `src/modules/requirement/requirement-prototype-revisions.ts`
- 修改 `src/modules/requirement/requirement-state.ts`
- 修改 `src/app/daemon/method-params.ts`
- 修改 `src/core/storage/database-paths.ts`
- 修改 `src/core/storage/database.ts`
- 修改 `tests/requirement-prototypes.test.ts`、`tests/requirement-prototype-revisions.test.ts`、`tests/database-storage.test.ts`

## 函数清单
### src/modules/requirement/requirement-prototypes.ts
| 函数名 | 职责 |
|---|---|
| `PrototypeFile`（schema） | 新增 `userNote`：字符串（1–4000 字）或 null；设计师交稿时为 null |
| `submitDesign` | 交稿写入的文件记录带 `userNote: null` |
| `decidePrototype` | 输入新增 `note: string \| null`；choice 为 accept 且 note 非空时，校验去空白后非空、≤ 4000 字，写进草稿的那一版带 `userNote`；accept 且 note 为 null 时 `userNote: null` |
| `DraftItem`（接口）/ `draftSet` | 草稿清单每项带 `userNote` |
| `inFlightBlock` | 处理办法改成新措辞 |
| `promoteOnApprovalIn` | 不变（随 `draftSet` 带出 `userNote`） |

### src/modules/requirement/requirement-prototype-revisions.ts
| 函数名 | 职责 |
|---|---|
| `PrototypeRevision`（schema）/ `RevisionPrototype` | 每项新增 `userNote`：字符串或 null |

### src/modules/requirement/requirement-state.ts
| 函数名 | 职责 |
|---|---|
| 批准写快照处（约 409 行） | 映射时带上 `userNote` |

### 其他
| 位置 | 职责 |
|---|---|
| `method-params.ts` 的 `prototypes.decide` | 新增 `note: string(≤4000) \| null` |
| `DATABASE_SCHEMA_VERSIONS.data` | 7 → 8 |
| `database.ts` 的 `OUTDATED_VERSIONS.data` | 追加 7 |

## 协作关系
扩展调用守护进程 `prototypes.decide`（`run-manager.ts` 的 `prototypeDecide` 原样透传，不用改）→ `decidePrototype`。批准时 `requirement-state` 调 `promoteOnApprovalIn` 再 `writePrototypeRevision`。`prototypesAtRevision` 读出的每项自然带 `userNote`，供 plan 04 使用。备份读快照时多一个字段不影响。

## 验证方式
- 测试入口：`decidePrototype(ref, input)`、`draftPrototypes(ref, requirementId)`、`inFlightBlock(items)`、`writePrototypeRevision` / `prototypesAtRevision`、新建数据库后读 `PRAGMA user_version`、打开 user_version=7 的旧库。
- 测试输入：沿用 `tests/requirement-prototypes.test.ts` 现有的交稿准备方式造出一版在等确认的原型。
- 预期结果：
- [ ] accept + note "  用 B  " → `draftPrototypes` 里这份的 `userNote` 是 "用 B"
- [ ] accept + note "   " 或 4001 字 → 被拒，草稿不变
- [ ] accept + note null → `userNote` 为 null；草稿里原有带说明的同名旧版被替换后，新版 `userNote` 仍为 null
- [ ] abandon → 草稿里同名已通过版本和它的 `userNote` 不变，这一版不再在途
- [ ] `inFlightBlock` 一份时处理办法是"先把它处理完（通过、返工，或在确认窗口按 Esc 放弃），再说批准"，两份时是"先把这 2 份处理完（通过、返工，或在确认窗口按 Esc 放弃），再说批准"
- [ ] 快照写入带 `userNote` 的原型后按版本读回，`userNote` 一致；`userNote` 为 null 的也能写入读回
- [ ] 新建 data.db 的版本号是 8；版本号 7 的旧库打开时报现有的"旧版本"错误
