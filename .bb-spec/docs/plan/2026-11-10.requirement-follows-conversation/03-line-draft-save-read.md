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
- 当前线上没保存过的需求，用它最近一次保存的那一份；第一次在这条线上保存时从那一份接着存。
- 两个窗口停在不同线上，读写互不影响；停在同一步先后保存，两次都成功、各自分线。
- 主窗口的需求名单和 @ 补全里的标题，按本窗口当前线显示。
- 恢复失败（对话线上的锚点在库里找不到，或对应提交读不出）时，这个需求在本窗口里用最近保存的那一份，不报错打断读取。
- 只对草稿（lifecycle 为 draft）按线；已批准的需求照现在的方式读写，不受对话线影响。
- 工具结果里的 `version` 字段和下一次 updateDraft 的 `version` 入参，对草稿都是线尖的版本号（01-line-anchor-foundation 定义）。

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
| `currentLine` | 从 ctx.sessionManager 读出当前对话线上全部 `one-company.line-anchor` 记录，按仓库、需求分组返回锚点编号列表 |
| `recordLineAnchor` | 写入成功后把新锚点追加进对话（调 core/host 的 `appendCustomEntry`） |

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
| `pendingSave` | 改：按线尖认出这条线上没做完的保存 |

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
| `draft` | 改：调用前取 `currentLine`，传给服务；成功后 `recordLineAnchor` |
| `read`、`metadata` | 改：传当前线 |
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
