---
name: 05-line-prototype-board
description: 原型看板按对话线叠加计算；在途原型归派出它的那条线；通过的原型和 DESIGN.md 记进这条线上的需求文件仓库
---
# 原型按对话线走

## 目标
每条对话线看到自己那条线上的原型状态；在途原型做完后只在它那条线上等确认；原型通过时只改这条线上的草稿，主仓库根目录的 DESIGN.md 不动。

## 业务规则（来源：PRD 01-line-bound-draft 约束 8、9；03-approved-files-into-branch 约束 9）
- 原型看板改成"按锚点记的变动"：开始设计、交稿、结束、作废、通过、意见、放弃、移除，每次变动存一条记录，挂到锚点上。某条线上的看板 = 按先后顺序叠加这条线上算数的变动。
- 开始设计、通过、意见、放弃、移除由主窗口发起，各生成一个 prototype 锚点（父 = 线尖）。交稿、结束、作废由守护进程发起，挂到那次开始设计的锚点上，所以它们只在包含那次派发的线上算数。
- 在途原型在用户切走后照样做完。"确认原型"窗口只在停在那条线上的主窗口里弹出；没有窗口停在那条线上就等着，直到有窗口换到那条线（换线时的检查由 07-switch-restore-message 调用本计划的 `awaitingOnLine`）。
- 在途原型只挡住它自己那条线上的批准。
- 原型通过时，原型 HTML 和它的 DESIGN.md 用 02-requirement-file-repo 的 `commitDraftFiles` 记进这条线上的需求文件仓库：`prototypes/<名>.v<N>.html`、`DESIGN.md`，第一次改 DESIGN.md 时同时存 `DESIGN.base.md`（设计师开工时主仓库根目录的内容）。主仓库根目录的 DESIGN.md 字节不变。
- 同一条线上后派的设计师，照这条线上已通过的 DESIGN.md 画；这条线上还没有时照主仓库根目录的。designBase 按设计师实际拿到的那份算。
- 移除原型：在这条线上的文件状态里删掉它的 HTML。
- 只有草稿按对话线叠加；已批准的需求（含批准后的修订）看板对所有线都一样，算数规则沿用 01 的 `countedAnchorsIn` / `isRecordCountedIn`，不另写一套。
- 原型版本号按需求全局编号：同名原型不论在哪条线上派出，都取这个需求下这个名字已有的最大版本 + 1，避免两条线上同名同版本的 HTML 文件撞路径。
- 线上的 DESIGN.md 从需求文件仓库按线尖的提交读（`readDraftFiles`），不在数据库记录里另存一份文本。
- 主窗口发起的原型操作（开始设计、通过、意见、放弃、移除）必须带 line 和 anchor；只有批准后后台读看板的地方不带线。
- 一条线的视图里两样东西分开取：saved（正文是哪一版，用于读取、对比、批准核对）取线尖往上最近的那个 save 锚点的提交和正文哈希；fileCommit（下一次提交的父提交）取线尖锚点的 fileCommit（含这条线上后来通过的原型、DESIGN.md）。批准锚点记下批准那一刻线尖的 fileCommit，供 08 按它读批准的文件。
- 通过时的 DESIGN.md 冲突判断搬到线上：设计师开工时拿到的 DESIGN.md（designBase）和通过那一刻这条线上的 DESIGN.md（线上文件状态里有就用它，没有就用主仓库根目录的）不同，照现有方式标为冲突（窗口 conflict 状态、通过报 `design_changed`）；相同才通过。例外：设计师交的 DESIGN.md 和这条线上现有的一字不差时不算冲突（没有东西会被覆盖），窗口状态和通过判断一致。开工时没有 DESIGN.md、之后线上出现一份一字不差的，同样不算冲突。
- 两个操作停在同一步（传入同一条线）并发通过、意见、放弃、移除时，和 PRD 01 约束 6 同一条规则：都按这条线判断，都成功，各自分出一条线；写入串行，但后到的操作不把先到操作的新锚点拼到自己的线上。同一条线上先通过的原型改了 DESIGN.md，后一份照旧被判冲突，防止两份原型互相覆盖。
- 原型的 DESIGN.md 和 designBase 相同（没改）时，通过不写 DESIGN.md。设计师开工时主仓库根目录没有 DESIGN.md，就不存 DESIGN.base.md（底稿不存在表示当时主仓库没有这个文件）。
- 批准时（04 的 `recordApprovedVersion`），按当前线的看板做"草稿转已批准"和批准快照（`requirement_prototype_revisions`），写法沿用 `promoteOnApprovalIn`、`writePrototypeRevision`。
- "确认原型"窗口里关于 DESIGN.md 的那一行改成：
  - 新建时：`批准需求后随需求分支新建 DESIGN.md，之后这个需求的原型、实现和审查都照它做。`
  - 更新时：`批准需求后随需求分支更新 DESIGN.md：<改了哪几章>。`；多方案时第二行按方案列出各改了哪几章，格式和现在一样。
  - 窗口其余内容、选项、按键不变。
- 通信变了（原型相关请求多了对话线和锚点参数），`PROTOCOL_VERSION` 从 8 升到 9；`upgrade.check`、`upgrade.yield` 不改。

## 涉及文件
- 修改 `src/modules/requirement/requirement-prototypes.ts`
- 修改 `src/modules/prototype/prototype-extension.ts`
- 修改 `src/modules/prototype/prototype-windows.ts`
- 修改 `src/modules/prototype/prototype-dispatch.ts`
- 修改 `src/app/daemon/run-manager.ts`（`dispatchPrototype`、`prototypePending`、`prototypeDecide`、`prototypeRemove`、`prototypes.board` / `list` 的处理）
- 修改 `src/app/daemon/method-params.ts`
- 修改 `src/core/host/protocol.ts`
- 修改 `src/modules/interaction/main-requirement-interaction.ts`（批准前在途原型检查带对话线）
- 修改 `role-rules/prototype.md`（第 15 行"用户通过原型时，程序把它写进仓库根目录"）、`role-rules/worker.md`（第 9 行"它只随原型通过由程序写入"），改成"随需求批准进需求分支"的说法
- 修改 `tests/requirement-prototypes.test.ts`、`tests/prototype-windows.test.ts`、`tests/prototype-dispatch.test.ts`、`tests/run-manager.test.ts`、`tests/daemon-protocol.test.ts`

## 成品定义

`src/core/host/protocol.ts`：
```ts
export const PROTOCOL_VERSION = 9;
```

`src/app/daemon/method-params.ts` 里原型相关请求的参数（只列有变化的字段，其余字段保持原样）：
```ts
// line：主窗口当前对话线上这个需求的锚点编号列表；anchor：这次操作由主窗口新生成的锚点编号
"prototypes.dispatch": PrototypeDispatchInput 加 { line: Type.Array(id, { maxItems: 4096 }), anchor: id },
"prototypes.board":    { requirementId: id, line: Type.Array(id, { maxItems: 4096 }) },
"prototypes.pending":  { requirementId: id, name: Type.String(), line: Type.Array(id, { maxItems: 4096 }) },
"prototypes.decide":   原有字段 + { line: Type.Array(id, { maxItems: 4096 }), anchor: id },
"prototypes.remove":   原有字段 + { line: Type.Array(id, { maxItems: 4096 }), anchor: id },
"prototypes.removal":  { requirementId: id, name: Type.String(), line: Type.Array(id, { maxItems: 4096 }) },
```

事件 `prototype.submitted`、`prototype.finished` 的数据加一个字段 `dispatchAnchor`（那次开始设计的锚点编号）。

## 函数清单
### src/modules/requirement/requirement-prototypes.ts
| 函数名 | 职责 |
|---|---|
| `readPrototypeBoard` | 改：按对话线叠加变动得出看板 |
| `beginDesign`、`submitDesign`、`endDesign`、`clearStaleDesigns`、`decidePrototype`、`removeFromDraft` | 改：各自写一条变动记录并挂锚点；`decidePrototype` 通过时调 `commitDraftFiles`，删掉 `writeChosenDesign` |
| `lineDesignSpec` | 新：给出这条线上的 DESIGN.md（线上文件状态里有就用它，没有就读主仓库根目录） |
| `awaitingOnLine` | 新：列出这条线上交了稿、等确认的原型 |
| `inFlightSummary`、`inFlightBlock`、`draftPrototypes`、`verifyDraftFiles`、`pendingConfirmation` | 改：带对话线 |
| `promoteOnApprovalIn` | 改：按当前线的看板转已批准 |

### src/modules/prototype/prototype-extension.ts
| 函数名 | 职责 |
|---|---|
| `confirmPrototypeFlow` | 改：请求带对话线和新锚点；成功后写进对话 |
| `session_start` 里对 `prototype.submitted` 的订阅 | 改：按 `dispatchAnchor` 是否在本窗口当前线上算数来决定是否弹窗，替换按 parentSessionId 的判断 |

### src/modules/prototype/prototype-windows.ts
| 函数名 | 职责 |
|---|---|
| `designLines` | 改：created、changed 两种的文字换成上面规定的 |

### src/app/daemon/run-manager.ts
| 函数名 | 职责 |
|---|---|
| `dispatchPrototype` | 改：用 `lineDesignSpec` 取 DESIGN.md、算 designBase；记下 dispatchAnchor；事件带 dispatchAnchor |
| `prototypePending`、`prototypeDecide`、`prototypeRemove` | 改：透传对话线和锚点 |

## 协作关系
- 主窗口生成锚点 → RPC 带 line、anchor → 守护进程写变动记录（同事务挂锚点）→ 通过时 `commitDraftFiles` 写需求文件仓库（与草稿保存共用 `requirement_service_write_coordination` 写锁）→ 主窗口把锚点写进对话。
- 依赖 01、02、04。

## 验证方式
- 测试入口：`requirement-prototypes.ts` 导出函数；`confirmWindowContent`；`RunManager.dispatchPrototype` / `prototypeDecide`（沿用 `tests/run-manager.test.ts` 的守护进程桩）；协议版本检查。
- 测试输入：线 A 派设计师画「导出弹窗」，线 B 不含这次派发；设计师交稿。
- 预期结果与验证项：
  - [ ] 线 B 的看板里没有这份在途原型，线 B 批准不被挡；线 A 的批准被挡。
  - [ ] `awaitingOnLine(线 A)` 列出它，`awaitingOnLine(线 B)` 为空。
  - [ ] 线 A 上通过后，主仓库根目录 DESIGN.md 字节不变；线 A 的文件状态里有 DESIGN.md、DESIGN.base.md、原型 HTML。
  - [ ] 线 A 上再派设计师，任务说明里的 DESIGN.md 是线 A 上已通过的那份。
  - [ ] 确认窗口新建、更新、多方案三种情况下 DESIGN.md 那一行和规定的一字不差。
  - [ ] 协议版本 9；版本 8 的窗口握手被拒，`upgrade.check` 参数格式不变。
