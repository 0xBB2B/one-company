---
name: design-submit-dispatch
description: 交稿必须带 DESIGN.md 并经检查后存盘；派设计师时带上仓库里的 DESIGN.md 并记下指纹；数据库升到 10 并作废旧的在做原型
---
# DESIGN.md 交稿、派工和数据库迁移

## 目标
设计师交原型时必须带合格的 DESIGN.md（一份或每个方案一份），程序把它存在原型文件旁边；派设计师时任务说明里有仓库根目录 DESIGN.md 的全文或"还没有"的说明，程序记下派工时它的内容指纹；数据库升到版本 10，升级时作废还在做或还在等确认的原型。

## 业务规则（来源：PRD design-spec-file C-1、C-8、C-9、C-17）
- 交稿工具 `result_submit` 的 `prototype` 动作新增参数 `design`：字符串表示一份 DESIGN.md 对应所有方案；字符串数组表示按 `options` 顺序每个方案一份。
- 没带 `design`：退回，原因"交稿没带 DESIGN.md 全文"，下一步"在 design 里带上 DESIGN.md 全文后重交"。
- `design` 是数组但没有方案清单：退回，原因"只画了一种方案，DESIGN.md 交一份就行"。数组长度和方案数不同：退回，原因"画了 <N> 个方案，DESIGN.md 交了 <M> 份；各方案风格不同时每个方案各交一份，按方案顺序，相同时交一份"；数组里某一项为空字符串：原因"方案 <字母> 的 DESIGN.md 没交"。
- 每份都用 `checkDesignSpec`（plan design-spec-check）检查；多方案每份一份时，原因前加"方案 <字母> 的"，如"方案 B 的 DESIGN.md 缺少「颜色」章"。不合格退回、不弹确认窗口，退回码 `invalid_design`，下一步"按原因改好 DESIGN.md 后重交"。检查放在拼原型文件之前。
- 合格时，每份 DESIGN.md 原子写到原型文件同一目录：一份时 `<原型名>.v<版本>.design.md`，每方案一份时 `<原型名>.v<版本>.design-<字母>.md`；看板记录 `inFlight.designs` 记下每份的方案字母（一份时为 `null`）、sha256 指纹和字节数。
- 派设计师（`RunManager` 处理 `prototypes.dispatch`）时：读仓库根目录 `DESIGN.md`（`repositoryRoot`），有就算 sha256，没有记 `null`，作为 `designBase` 交给 `beginDesign` 存进 `inFlight.designBase`。
- 设计师任务说明（`prototypeContext`）在"要求"之后加：有 DESIGN.md 时"仓库根目录的 DESIGN.md（原型照它画；交稿时在 design 里带全文，没改的章原样照抄）：\n<全文>"；没有时"仓库根目录还没有 DESIGN.md，这次交稿要新建一份，在 design 里带全文。"。重派下一版、被替换的在做版本有 `designs` 时，加一行"上一版交的 DESIGN.md：<路径，多份用顿号隔开>"，并把这些路径加进设计师的 `readRoots`。
- 数据库：`DATABASE_SCHEMA_VERSIONS.data` 从 9 升到 10；`MIGRATABLE_VERSIONS.data` 为 `[8, 9]`。新增 v9→v10 步骤：每个原型看板里 `inFlight` 不为空的条目，`lastEnded` 写成 `{ version: inFlight.version, reason: "升级后交原型要带 DESIGN.md，这一版作废，请重派" }`，`inFlight` 置空；`lastOpinion`、`draft`、`approved`、`removed` 不动；转换后按新结构校验，不合格时报错写明需求编号和原型名。`losses` 一句："升级前还在做、或还在等你确认的原型会作废，需要重派（它们交稿时没带 DESIGN.md）"。v8 步骤只做它原来的字段转换，看板的结构校验统一由最后的 v9 步骤做（v8 的看板输出还没有 `designBase`，按新结构校验会失败）；版本快照的校验保留。
- 主窗口扩展注册迁移步骤时两条都传：`[prototypeRecordsV8Step, prototypeRecordsV9Step]`。

## 涉及文件
- 修改 `src/modules/requirement/requirement-prototypes.ts`
- 修改 `src/modules/requirement/prototype-record-migration.ts`
- 修改 `src/modules/pm/result-submit.ts`
- 修改 `src/modules/prototype/prototype-dispatch.ts`
- 修改 `src/app/daemon/run-manager.ts`（`prototypes.dispatch` 那段）
- 修改 `src/core/storage/database-paths.ts`、`src/core/storage/database-migration.ts`（两个版本常量）
- 修改 `src/app/extension/index.ts`
- 修改相关测试：`tests/requirement-prototypes.test.ts`、`tests/prototype-dispatch.test.ts`、`tests/prototype-record-migration.test.ts`、`tests/pm-tools-failure.test.ts` 等凡是调 `submitDesign`、`beginDesign`、`result_submit prototype` 或断言库版本 9 的测试

## 成品定义
看板结构里 `inFlight` 的新形状（其余字段不变）：

```ts
inFlight: Type.Union([object({ version: positive, runId: id, agent: Type.String(), status: Type.Union([Type.Literal("designing"), Type.Literal("awaiting")]),
  file: Type.Union([PrototypeFile, Type.Null()]),
  designBase: Type.Union([sha256Hex, Type.Null()]),
  designs: Type.Union([Type.Array(object({ letter: Type.Union([Type.Enum(OPTION_LETTERS), Type.Null()]), hash: sha256Hex, bytes: Type.Integer({ minimum: 1, maximum: 16384 }) }), { minItems: 1, maxItems: 6 }), Type.Null()]) }), Type.Null()]),
```

交稿参数（`PROTOTYPE_SUBMIT_PARAMETERS`）新增字段，参数说明注释同步写上 design 的含义：

```ts
design: Type.Optional(Type.Union([Type.String(), Type.Array(Type.String(), { maxItems: 6 })])),
```

## 函数清单
### src/modules/requirement/requirement-prototypes.ts
| 函数名 | 职责 |
|---|---|
| `designFilePath` | 新增：按需求、原型名、版本、方案字母（可空）给出 DESIGN.md 候选文件路径 |
| `checkSubmittedDesigns` | 新增：按上面规则判定 `design` 的份数和每份内容，返回要存的每份（字母、全文） |
| `submitDesign` | 改：先调 `checkSubmittedDesigns`，再拼原型；写原型文件时一并写 DESIGN.md 候选文件，记 `inFlight.designs` |
| `beginDesign` | 改：入参多 `designBase`，存进新 `inFlight`；返回的 `previous` 多 `designPaths`（被替换的在做版本的候选文件路径，没有时为空数组） |
### src/modules/requirement/prototype-record-migration.ts
| 函数名 | 职责 |
|---|---|
| `prototypeRecordsV9Step` | 新增：v9→v10 作废在做原型 |
| `migrateBoard` | 改：去掉看板结构校验（移到 v9 步骤） |
### src/modules/pm/result-submit.ts
| 函数名 | 职责 |
|---|---|
| `PROTOTYPE_SUBMIT_PARAMETERS` | 加 `design` |
| `createResultSubmitTool` 的 prototype 分支 | 把 `design` 传给 `submitDesign` |
### src/modules/prototype/prototype-dispatch.ts
| 函数名 | 职责 |
|---|---|
| `prototypeContext` | 入参多 `design: { content: string \| null; previousPaths: string[] }`，按规则加行 |
### src/app/daemon/run-manager.ts
| 函数名 | 职责 |
|---|---|
| 派设计师的方法（调 `beginDesign` 处） | 读根目录 DESIGN.md 算 `designBase`；把全文和 `previous.designPaths` 交给 `prototypeContext`，`readRoots` 加上这些路径 |

## 协作关系
`result_submit` → `submitDesign` → `checkSubmittedDesigns` → `checkDesignSpec`（design-spec.ts）。`RunManager` → `beginDesign` / `prototypeContext`。迁移步骤由 `lifecycleExtension` 在拉起守护进程前经 `migrateRepositoryDatabases` 执行。

## 验证方式
- 测试入口：`submitDesign`、`beginDesign`、`prototypeContext`、`prototypeRecordsV9Step.migrate`（配假的 `MigrationRecords`）、`migrateRepositoryDatabases`（v8、v9 库）、`createResultSubmitTool` 的 prototype 动作。
- 测试输入：plan design-spec-check 成品里的合格 DESIGN.md 及其变体；带 2 个方案的交稿；v9 库里一条 `designing`、一条 `awaiting`、一条已通过的看板。
- 预期结果：
- [ ] 没带 design、数组无方案、份数不对、某份为空各被退回，原因文字与规则一致，看板仍是 `designing`
- [ ] 方案 B 那份缺章被退回，原因以"方案 B 的"开头
- [ ] 一份对应多方案、每方案一份两种交法都被收下；候选文件写在规定路径，内容与交的一致，`inFlight.designs` 的字母、指纹、字节数正确
- [ ] `beginDesign` 存下传入的 `designBase`（含 `null`）；有意见重派时 `previous.designPaths` 是上一版候选文件路径
- [ ] `prototypeContext` 有 DESIGN.md 时含全文和那句说明，没有时含"还没有 DESIGN.md"那句，有上一版时含路径行
- [ ] v9 库迁移后：两条在做原型 `inFlight` 为 `null`、`lastEnded.reason` 与规则一致，已通过的和 `lastOpinion` 不变，库版本 10；v8 库能一路迁到 10；`losses` 含那句固定的话
