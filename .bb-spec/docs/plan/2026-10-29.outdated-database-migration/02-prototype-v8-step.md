---
name: prototype-v8-step
description: requirement 模块提供 data.db 版本 8 到 9 的转换步骤：原型记录补方案清单和选定方案、去掉补充说明
---
# 原型记录 8 → 9 转换步骤

## 目标
`src/modules/requirement` 导出一个 `DataMigrationStep`（from = 8），把版本 8 的原型记录转成版本 9 的格式，转换后每条记录都通过当前代码的结构校验；转不了时抛出写清需求编号和原型名的错误。

## 业务规则（来源：PRD migration-prompt）
- 版本 9 由「确认原型窗口按方案清单列出方案」引入：原型交稿内容多了方案清单 `options`（字符串数组）和选定方案 `picked`（`{ letter, name }` 或 null），去掉了用户"通过并补充说明"时写的 `userNote`。
- 转换规则：
  - `requirement_prototypes` 命名空间（每个需求一条原型看板）：每个 entry 的 `draft`、`approved`、`inFlight.file` 三处交稿内容（为 null 的跳过）都加 `options: []`、`picked: null`，删掉 `userNote`。
  - `requirement_prototype_revisions` 命名空间（每个需求每个批准版本一条快照）：`prototypes` 里每一项加 `picked: null`，删掉 `userNote`。
  - 其他字段、其他命名空间不动。
- 迁移会丢掉的数据，迁移框里显示这一句：`迁移会丢掉原型记录里的「补充说明」（这个功能已经去掉了）`。
- 转换后的记录必须通过当前代码对原型看板、原型版本快照的结构校验；不通过就抛错，错误文字写"原型记录（需求 <需求编号>，原型「<原型名>」）读不出来：<原因>"，原型版本快照写"原型版本快照（需求 <需求编号>，第 <N> 版）读不出来：<原因>"。原因用结构校验给出的第一条错误（字段路径 + 说明）。
- 迁移后的行为：已通过的原型版本没有选定方案；等确认的原型版本方案清单为空，再弹"确认原型"窗口时列"通过"和"其他"。

## 涉及文件
- 新建 `src/modules/requirement/prototype-record-migration.ts`
- 修改 `src/modules/requirement/requirement-prototypes.ts`（导出原型看板的结构定义 `PrototypeBoard` 值，供校验）
- 修改 `src/modules/requirement/requirement-prototype-revisions.ts`（导出原型版本快照的结构定义 `PrototypeRevision` 值）
- 新建 `tests/prototype-record-migration.test.ts`

## 成品定义
本 plan 实现的接口来自 `src/core/storage/database-migration.ts`（plan 01 落盘），这里复述以便自包含：

```ts
export interface MigrationRecord { key: string; data: unknown }
export interface MigrationRecords {
  list(namespace: string): MigrationRecord[];
  replace(namespace: string, key: string, data: unknown): void;
}
export interface DataMigrationStep {
  from: number;
  losses: string[];
  migrate(records: MigrationRecords): void;
}
```

## 函数清单
### src/modules/requirement/prototype-record-migration.ts
| 函数名 | 职责 |
|---|---|
| `prototypeRecordsV8Step` | 导出的 `DataMigrationStep` 常量：`from: 8`、`losses` 为上面那一句、`migrate` 依次转换两个命名空间 |
| `migratePrototypeFile` | 把一处交稿内容转成版本 9：加 `options: []`、`picked: null`，删 `userNote` |
| `migrateBoard` | 转一条原型看板记录并用 `PrototypeBoard` 校验，失败按规则抛错 |
| `migrateRevision` | 转一条原型版本快照并用 `PrototypeRevision` 校验，失败按规则抛错 |

### src/modules/requirement/requirement-prototypes.ts
| 函数名 | 职责 |
|---|---|
| `PrototypeBoard` | 把已有的结构定义常量改为导出（类型导出保持不变） |

### src/modules/requirement/requirement-prototype-revisions.ts
| 函数名 | 职责 |
|---|---|
| `PrototypeRevision` | 把已有的结构定义常量改为导出 |

## 协作关系
- `prototypeRecordsV8Step.migrate` 用 `records.list("requirement_prototypes")` / `records.list("requirement_prototype_revisions")` 读，转换后用 `records.replace` 写回。
- 只依赖 `src/core/storage` 的类型和本模块的结构定义，被 `src/app/extension` 组装进迁移流程（plan 03）。

## 验证方式
- 测试入口：`prototypeRecordsV8Step`（包级常量），配一个内存里的 `MigrationRecords` 假实现。
- 测试输入：按版本 8 格式手写的记录——一个需求的看板，含已通过且 `userNote` 为"按钮改蓝色"的 entry、`inFlight.status = "awaiting"` 带 `file` 的 entry、`draft`/`approved`/`inFlight` 为 null 的 entry；一条含两项 `userNote` 的版本快照；一条缺 `version` 字段的坏看板记录。
- 预期结果：
- [ ] `from` 是 8，`losses` 恰为 `["迁移会丢掉原型记录里的「补充说明」（这个功能已经去掉了）"]`
- [ ] 看板里三处交稿内容都有 `options: []`、`picked: null`，没有 `userNote`；为 null 的保持 null；其他字段原样
- [ ] 版本快照每项有 `picked: null`、没有 `userNote`，其他字段原样
- [ ] 转换后的看板、快照都通过 `Value.Check(PrototypeBoard / PrototypeRevision)`
- [ ] 坏记录：抛 Error，message 含"原型记录（需求 <编号>，原型「<名>」）读不出来"和字段路径
- [ ] 其他命名空间的记录没有被 `replace` 调用过
- [ ] 等确认那版转换后的 `options` 是空数组；用它调 `src/modules/prototype/prototype-windows.ts` 的 `confirmWindowContent` → 选项是"通过"（另有"其他"行）
