---
name: prototype-board
description: 每个需求一份原型看板：在途、草稿、已批准三种状态，版本只增不减，交稿校验、决定与移除都在这里落库
---
# 原型看板存储

## 目标
程序能为每个需求记下各份原型的当前状态，包括在途、草稿里通过的、最近批准版本里的。它还要负责校验交稿、登记用户的决定和移除。文件留在本机数据目录，路径由名称和版本推出。

## 业务规则（来源：PRD confirm-prototype、prototype-designer）
- 原型名称在派出时校验：不能为空，不能是 `.` 或 `..`，不能含 `<>:"/\|?*` 和控制字符，最长 40 字。名称会出现在文件名里。
- 同一个需求里，同名原型的版本号只增不减；条目永不删除，版本文件也永不覆盖。
- 同名原型同一时间只能有一版在途。在途分两种：设计师还在做（designing），已交稿等用户决定（awaiting）。
- 只有需求处于草稿或进行中、并且不在待恢复状态时，才能开始设计。
- 交稿校验：
  - 不能超过 1 MiB；
  - 去掉开头的空白后，必须以 `<!doctype html` 或 `<html` 开头（不分大小写）；
  - 只收当前那次设计运行交的稿；
  - 不合格的稿拒收，原因交回设计师，在途状态不变。
- 用户的四种决定：
  - 通过：这一版写进草稿，替换同名的旧版本。
  - 返工：必须写意见，意见非空，最长 4000 字。
  - 放弃：草稿里同名的旧版本保持不变。
  - 移除：只对草稿里有的原型；移除后草稿里不再有它，批准时生效。
- 决定前要再算一次文件指纹，和交稿时的不一致就拒绝登记，原因是"文件在交稿后被改过"。
- 返工意见要留到下一次同名派出时交给设计师。通过、放弃、移除后，这条意见清掉。
- 设计没交稿就结束时：清掉在途状态，记下结束原因，主代理查状态时能看到。

## 涉及文件
- runtime/requirement-prototypes.ts（新建）
- runtime/requirement-identity.ts（修改：把文件名字符校验导出，供原型名称复用）
- tests/requirement-prototypes.test.ts（新建）

## 成品定义
看板记录（命名空间 `requirement_prototypes`，键是 requirementId，只存最新状态）：
```ts
const PrototypeFile = object({ version: positive, hash: sha256Hex, bytes: Type.Integer({ minimum: 1, maximum: 1_048_576 }), note: Type.String({ maxLength: 2000 }) });
const PrototypeEntry = object({
  name: Type.String({ minLength: 1, maxLength: 40 }),
  lastVersion: positive,                                   // 已发出的最大版本号，只增不减
  draft: Type.Union([PrototypeFile, Type.Null()]),          // 草稿里用户通过的那一版
  approved: Type.Union([PrototypeFile, Type.Null()]),       // 最近一次批准版本里的那一版
  removed: Type.Boolean(),                                  // 用户已在窗口里移除，下一次批准时生效
  inFlight: Type.Union([object({ version: positive, runId: id, agent: Type.String(), status: Type.Union([Type.Literal("designing"), Type.Literal("awaiting")]),
    file: Type.Union([PrototypeFile, Type.Null()]) }), Type.Null()]),
  lastRework: Type.Union([object({ version: positive, opinion: Type.String({ minLength: 1, maxLength: 4000 }) }), Type.Null()]),
  lastEnded: Type.Union([object({ version: positive, reason: Type.String({ maxLength: 500 }) }), Type.Null()]),
});
const PrototypeBoard = object({ requirementId: id, entries: Type.Array(PrototypeEntry, { maxItems: 50 }), updatedAt: positive });
```
文件位置：`<dirname(data.db)>/prototypes/<requirementId>/<name>.v<version>.html`，目录权限 0700，原子写入。

## 函数清单
### runtime/requirement-prototypes.ts
| 函数名 | 职责 |
|---|---|
| `prototypeFilePath` | 由数据目录、需求、名称、版本推出文件位置 |
| `checkPrototypeName` | 按上面的名称规则校验，不合格抛带原因的错误 |
| `readPrototypeBoard` | 读看板，没有时返回空看板 |
| `beginDesign` | 事务内：检查需求状态、同名无在途；版本号 = lastVersion+1；记 designing；返回版本、上一版文件位置和返工原话 |
| `submitDesign` | 校验 html，写文件，事务内确认 runId 仍是 designing，再改成 awaiting 并带上文件信息 |
| `endDesign` | 按 runId 清掉 designing 的在途状态，记 lastEnded；awaiting 不动 |
| `clearStaleDesigns` | 守护进程启动时把所有 designing 清掉，原因记"守护进程重启，设计中断" |
| `pendingConfirmation` | 取某份原型 awaiting 那一版的确认信息：先重算指纹，不一致就拒绝 |
| `decidePrototype` | 登记通过、返工或放弃，只对窗口显示的那一版（版本号加指纹）有效 |
| `removeFromDraft` | 登记移除：只对草稿集合里有的原型；draft 置空、removed 置真；之后再通过新版本时 removed 复位 |
| `inFlightSummary` | 列出全部在途原型的名称、版本和状态，供批准拦截使用 |
| `draftPrototypes` | 算出草稿里的原型集合（removed 的不算；draft 优先，否则沿用 approved）、每份的标签（新确认 / 沿用 / 本次移除）和集合的摘要指纹 |
| `promoteOnApproval` | 批准事务内调用：再查无在途、指纹与窗口显示时一致；各条目 approved 换成草稿集合里的那份（removed 的置空），draft 置空、removed 复位；返回本次集合 |
| `PrototypeBoardError` | 错误类型，带"为什么、下一步"两段原因 |

## 协作关系
- 读写本仓库数据库，复用 `runtime/database.ts` 的 `withDatabase` 和事务。需求状态从 `requirements` 命名空间读。
- 被 04（守护进程派出与交稿）、05（主窗口工具与窗口）、06（批准）调用。

## 验证方式
- 测试入口：`runtime/requirement-prototypes.ts` 导出的函数，配合临时数据目录（单层 `/tmp/pi-t-XXXXXX`）和一个草稿状态的需求记录。
- 预期结果：
  - [ ] 名称为空、为 `..`、含 `/`、超过 40 字时，`beginDesign` 抛错，原因写明哪条不合格。
  - [ ] 同名第二次 `beginDesign` 时，若上一版是 designing 或 awaiting，被拒；原因分别写"还在做""还在等确认"。
  - [ ] 需求不存在或已完成时，`beginDesign` 被拒。
  - [ ] 交稿超过 1 MiB 或不是 HTML 时，`submitDesign` 被拒，看板仍是 designing；runId 不对时也被拒。
  - [ ] 交稿后看板是 awaiting；改动文件一个字节后，`pendingConfirmation` 和 `decidePrototype` 都报"文件在交稿后被改过"。
  - [ ] 通过：draft 换成新版本。返工：没有意见时被拒；有意见时 lastRework 记下原话，下一次 `beginDesign` 返回上一版位置和这句原话。放弃：draft 不变。
  - [ ] 设计 v1 → 通过 → 移除 → 再派时得到 v2，v1 文件仍在且没被覆盖。
  - [ ] `endDesign` 后在途状态清空、lastEnded 有原因；`clearStaleDesigns` 只清 designing，不动 awaiting。
  - [ ] `draftPrototypes`：draft 优先；没动过的沿用 approved；已移除的不在集合里；集合一样时指纹也一样。
