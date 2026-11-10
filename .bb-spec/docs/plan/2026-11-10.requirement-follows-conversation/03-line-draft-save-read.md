---
name: 03-line-draft-save-read
description: 需求草稿的新建、保存、读取、对比、名单和 @ 补全都按主窗口当前对话线来
---
# 草稿按对话线保存和读取

## 目标
主代理在任意一条对话线上读取、保存草稿，看到和用到的都是这条线上的版本；照对话里看到的版本号保存不会被拒。

## 业务规则（来源：PRD 01-line-bound-draft 约束 1、2、4、5、6、7、14）
- 换线（两次 Esc、`/tree`、`/fork`、`/resume`、`pi -c`、`pi --session`）后，读取需求得到新线上最后一次保存时的标题和正文。
- 主代理在一条线上最后从工具结果里看到版本号 N，照 N 保存成功，不报 `stale_version`；保存后这条线上是 N+1，别的线不变。
- 当前线上没保存过的需求，主窗口第一次读到它时用它最近一次保存的那一份，并把这一份的锚点记进当前线（钉住，用户 2026-11-10 决定）；之后别的线、别的窗口再保存，当前线仍是这一份。第一次在这条线上保存时从这一份接着存。保存前线上还没有这个需求的锚点时，同样先按当时最近一次保存的那份钉住再存，保证同一次保存里前后用的是同一版。
- 两个窗口停在不同线上，读写互不影响；停在同一步先后保存，两次都成功、各自分线。
- 主窗口的需求名单和 @ 补全里的标题，按本窗口当前线显示。
- 恢复失败（对话线上的锚点在库里找不到，或对应提交读不出）时，这个需求在本窗口里用最近保存的那一份，不报错打断读取。
- 只对草稿（lifecycle 为 draft）按线；已批准的需求照现在的方式读写，不受对话线影响。
- 工具结果里的 `version` 字段和下一次 updateDraft 的 `version` 入参，对草稿都是线尖的版本号（01-line-anchor-foundation 定义）。
- 接口约定：`RequirementService.open` 多一个选项 `lines`（当前对话线上每个需求的锚点编号，按对话顺序；后台进程不传，视为空）；保存回执多一个 `anchor` 字段，主窗口用它把锚点写进对话。
- 恢复失败的判定：这个需求在线上的最后一个锚点在库里找不到，或线尖那次保存的正文在需求文件仓库里读不出（只认 Git 读取类错误）时，用最近一次保存的那份（不往前找更早的锚点），read、metadata 的结果带 `restoreFailure`（白话原因：哪一步、为什么，不含编号、哈希、内部用词和错误码），主窗口随即把这一份的锚点记进当前线（钉住），之后读取、主窗口核对、保存核对都按这一份，不再带 `restoreFailure`。线尖就是最近一次保存时不退回。01 的 `resolveLineTipIn` 跳过找不到的锚点只用于给新锚点找父锚点。
- 一条线的视图（版本号、saved 引用、父提交、线尖、是否退回）只在一个函数里算，服务读取、主窗口核对、保存核对、续完认领都用它，不各算各的。
- 内容和线尖那一版完全相同的保存：不建新锚点、版本号不变，回执里的 anchor 是现在的线尖锚点；已批准需求取它最近一次保存的锚点。回执里的 anchor 必须是库里存在的锚点。
- 别的线上停在半路的保存（PRD 01 约束 16，用户 2026-11-10 决定）：主窗口开始一次保存前，先在对话里记一条“这次保存开始了”（custom entry `one-company.save-start`：repoId、requirementId、operationId）。当前线上有这条记录、又没做完的那次保存才算“能续的”，主窗口复用它的 operationId，照旧要求主代理用原内容再调一次（内容不同报 `requirement_write_pending`）。其余没做完的保存，在 `prepare` 里：写占用还在且占用进程活着 → `requirement_write_busy`；否则程序先处理掉它再做这次保存——它的结果已写进 requirements 行（按 `requirement_operations` 里有没有它的记录判断），只补齐 savedVersion/finalVersion；Git 结果已记下、requirements 行版本号仍是它开始时的 `saveVersion`，补记成一次正常保存（锚点用它自己的锚点，父锚点是它开始时的线尖）；其余作废，删掉它的操作记录、锚点记录和写占用（Git 里可能已有的提交不动）。

## 涉及文件
- 修改 `src/modules/requirement/requirement-service.ts`
- 修改 `src/modules/requirement/requirement-operations.ts`
- 修改 `src/modules/requirement/requirement-state.ts`
- 修改 `src/modules/requirement/requirement-summary.ts`
- 修改 `src/modules/requirement/host-authorization.ts`
- 修改 `src/modules/interaction/main-requirement-interaction.ts`
- 修改 `src/modules/interaction/requirement-manage-extension.ts`
- 新建 `src/modules/interaction/conversation-line.ts`
- 修改 `tests/requirement-service.test.ts`、`tests/main-requirement-interaction.test.ts`、`tests/requirement-manage-session.test.ts`

## 函数清单
### src/modules/interaction/conversation-line.ts
| 函数名 | 职责 |
|---|---|
| `currentLine` | 从 sessionManager 读出当前对话线上全部 `one-company.line-anchor` 记录，按需求分组返回锚点编号列表 |
| `recordLineAnchor` | 写入成功后、或读到需要钉住的那一版时，把锚点追加进对话（调 core/host 的 `appendCustomEntry`） |
| `recordSaveStart`、`startedSaves` | 新：开始保存前把 operationId 记进对话；读出当前线上记过的 operationId（按需求分组） |

### src/modules/requirement/requirement-service.ts
| 函数名 | 职责 |
|---|---|
| `create` | 改：生成 save 锚点（无父），提交第一版，返回带线尖版本号的回执；调 prd-storage `create` / `save` 时传真正的锚点编号（02 里这两处暂时传的是 operationId） |
| `updateDraft` | 改：入参多一个对话线锚点列表；按线尖核对版本号，父提交用线尖 fileCommit，生成 save 锚点 |
| `read` | 改：草稿的 saved 读取按线尖的提交；approved 读取不变 |
| `diff` | 改：草稿的对比按线上的提交 |
| `metadata` | 改：草稿的版本号和引用取线尖 |
| `lineDraftState` | 新：给出这条线上的草稿视图 {version, epoch, saved 引用, fileCommit, 线尖锚点}，读不出时退回最近保存的那份并标记失败原因 |
| `currentReceipt` | 改：草稿回执的 version 取新锚点的版本号 |

### src/modules/requirement/requirement-operations.ts
| 函数名 | 职责 |
|---|---|
| `prepare` | 改：草稿保存核对"线尖版本号 = 入参 version、expectedParent = 线尖 fileCommit"，替换对 requirements 行版本号的核对 |
| `pendingSave` | 改：只认当前线上记过开始记录（`startedSaves`）的没做完的保存 |
| `settleAbandoned` | 新：处理已经没人在做、又不是当前线上能续的保存（见业务规则），由 `prepare` 在发现别的没做完的保存时调用；能不能续由主窗口按保存开始记录认定 |
| （新命名空间）`line_operation_anchors` | 键 operationId，数据 `{ format: "line-operation-anchor/v1", requirementId, anchor, parent, unchangedTip }`（parent 是开始保存时的线尖锚点，补记时用），在 `prepare` 的事务里写，重试时读回同一个锚点；不改 `requirement_service_operations` 的格式，因为别的记录按它的版本号和哈希引用它 |

### src/modules/requirement/requirement-state.ts
| 函数名 | 职责 |
|---|---|
| `recordSavedVersion` | 改：requirements 行的 saved 记成最近一次保存（不论哪条线）；同一事务里调 `createLineAnchorIn` |

### src/modules/requirement/requirement-summary.ts
| 函数名 | 职责 |
|---|---|
| `saveRequirementSummary` | 改：每一版正文各存一份简介，键改为 `<requirementId>:<prdHash>` |
| `requirementSummary` | 改：按传入的 prdHash（线尖那一版正文的哈希）读对应的简介 |

### src/modules/requirement/host-authorization.ts
| 函数名 | 职责 |
|---|---|
| `snapshot` | 改：草稿返回线上视图（来自 `lineDraftState`） |

### src/modules/interaction/main-requirement-interaction.ts
| 函数名 | 职责 |
|---|---|
| `draft` | 改：调用前取 `currentLine`、`startedSaves`，按 `pendingSave` 决定复用还是新建 operationId，新建时先 `recordSaveStart`；成功后 `recordLineAnchor` |
| `read`、`metadata` | 改：传当前线；结果里的线尖不是当前线最后一个锚点时（空线、退回），先 `recordLineAnchor` 钉住再做结果核对 |
| `#requirementTitle` | 改：标题缓存键用线尖的 prd 哈希 |
| `#snapshot`、`#checkProof`、`#prove` | 改：草稿的结果绑定比对线上视图，别的线保存不让本窗口的结果送达失败 |

### src/modules/interaction/requirement-manage-extension.ts
| 函数名 | 职责 |
|---|---|
| `resolveHost` | 改：把 ctx.sessionManager 带给交互层，用于读当前线 |

## 协作关系
- 主窗口 `MainRequirementInteraction` → `currentLine` → `RequirementService.updateDraft(…, line)` → `RequirementOperations.prepare` → prd-storage `save`（父提交 = 线尖 fileCommit）→ `RequirementStateStore.recordSavedVersion`（同事务写锚点）→ 回到主窗口 `recordLineAnchor`。
- 依赖 01-line-anchor-foundation、02-requirement-file-repo。

## 验证方式
- 测试入口：`RequirementService` 的 create/updateDraft/read/diff/metadata；`MainRequirementInteraction` 的 draft/read/list/mentionCandidates（用现有测试里的假 ctx，sessionManager 换成能返回指定对话记录的假对象）。
- 测试输入：同一需求在线 A 上保存到版本 5、再到 10；构造线 B = 线 A 截到版本 5 的锚点。
- 预期结果与验证项：
  - [ ] 线 B 上 read 得到版本 5 的正文，metadata 版本号 5。
  - [ ] 线 B 上照版本 5 updateDraft 成功，回执版本号 6；线 A 上 read 仍是版本 10。
  - [ ] 线 B 上照版本 10 保存，报 `stale_version`。
  - [ ] 不含任何锚点的新线上 read 得到最近一次保存的版本；在它上面保存后，原线不变。
  - [ ] 两条线同时停在版本 5 先后保存，两次都成功，回执版本号都是 6，之后各自读到自己的内容。
  - [ ] 两条线标题不同，list 和 mentionCandidates 按传入的线显示标题。
  - [ ] 线上锚点在库里不存在时，read 返回最近保存的那份，并带"没能恢复"的原因。
  - [ ] 已批准需求在任意线上 read、metadata 结果相同。
  - [ ] 线上锚点存在但提交读不出时，read 不报错，返回最近保存的那份并带 `restoreFailure`；恢复成功时没有这个字段。
  - [ ] 已批准需求保存相同内容，回执 anchor 是库里存在的锚点。
  - [ ] 空线上读到版本 7 后，别的线保存成版本 8，这条线再读仍是 7，照 7 保存成功（主窗口路径）。
  - [ ] 线尖正文读不出时，主窗口 read、metadata 都成功返回最近保存那份并带原因；之后照显示的版本号保存成功，再读不带原因（主窗口路径）。
  - [ ] 新开对话（空线）保存一个在别的对话里停在半路（Git 已记下 / 没记下两种）的需求：主窗口路径保存成功，不报 `requirement_write_pending`。
  - [ ] 补记之后这次保存因版本号不对被拒时，再照正确版本号保存能成功（不会永久卡住）。
  - [ ] 停在半路的保存结果已写进 requirements 行、之后行又被改过：处理后它的锚点和操作记录都在，读到这个锚点不报恢复失败。
  - [ ] 线 A 上一次保存停在半路（Git 结果已记下）、没人在做，线 B 上保存：成功；那次保存补记成最近一次保存，空线上 read 得到它的内容；线 B 是新的一版。
  - [ ] 同上但 Git 结果没记下：线 B 保存成功，那次保存的操作记录、锚点记录都不在了。
  - [ ] 那次保存的写占用还在、占用进程活着时，线 B 保存报 `requirement_write_busy`。
  - [ ] 停在半路的保存就在当前线上时，照旧要求用原内容续完（内容不同报 `requirement_write_pending`）。
