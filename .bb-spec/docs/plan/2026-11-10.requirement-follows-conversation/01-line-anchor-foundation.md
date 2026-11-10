---
name: 01-line-anchor-foundation
description: 锚点存储与对话线解析：每次跟线写入记一个锚点，换线后按锚点算出这条线上算数的记录
---
# 锚点与对话线解析

## 目标
程序能回答："在 pi 的这条对话线上，需求 X 当前停在哪个锚点、算数的锚点有哪些、主代理看到的版本号是多少"。

## 业务规则（来源：PRD 01-line-bound-draft、04-upgrade-migration）
- 对话线：pi 主会话里从对话开头走到当前位置的那一条路线（`ctx.sessionManager.getBranch()` 返回的记录列表）。回到某一步再继续就多出一条新线，原来的线还在。
- 批准前的每次跟线写入（保存草稿、登记短决定、提问、登记批准清单、原型派发/通过/移除、项目规范写进草稿）都生成一个锚点：程序生成的 UUIDv7。锚点同时写在两处：本机数据库的锚点记录；对话里一条只给程序看的记录 `pi.appendEntry("one-company.line-anchor", {repoId, requirementId, anchor})`，这条记录不进模型上下文。
- 新锚点的父锚点 = 写入时这条线上这个需求的当前锚点（线尖）；线上没有这个需求的锚点时，父锚点 = 这个需求最近一次保存的锚点，不管它在哪条线上（PRD 01 约束 5）。
- 线尖：在当前对话线上从后往前找，第一条属于该需求、且数据库里有对应记录的锚点记录；找不到时用这个需求最近一次保存的锚点。
- 算数的锚点 = 线尖和它的全部祖先。数据库里没有挂锚点的过程记录（升级前产生的）算作所有对话线共同的起点，在每条线上都算数（PRD 04 约束 3、6）。
- 版本号：主代理看到的版本号 = 线尖锚点记的版本号。保存草稿的锚点版本号 = 父锚点版本号 + 1；其他种类的锚点沿用父锚点的版本号。新建需求的第一次保存版本号是 2，和现在一样（reserve 得 1、保存加 1）。
- 两个窗口停在同一步先后写入，两次都成功，各自从这一步分出一条线（PRD 01 约束 6）。
- 需求批准时记一个批准锚点。以第一次批准为准：批准后算数的记录 = 第一次批准锚点及其祖先 + 在它之后写入的全部记录；批准后线尖 = 最后写入的锚点，版本号、新锚点的父锚点都和对话线无关（PRD 01 约束 12）。
- "先后"一律按锚点记录的 `sequence` 判断：写入时在同一事务里取这个需求已有锚点的最大 sequence 加 1（第一个为 1），不看 createdAt 和记录 id：同一毫秒或时钟回拨都不会判错。"最近一次保存" = 最后写入的 save 锚点。
- 需求的第一个锚点不是 save 时版本号为 1，之后第一次保存为 2。
- 对话被 pi 压缩过以后，`getBranch()` 仍返回压缩前的记录，所以压缩不影响线尖解析（PRD 01 约束 15）。

## 涉及文件
- 新建 `src/core/host/conversation-entries.ts`
- 新建 `src/modules/requirement/line-anchors.ts`
- 修改 `src/modules/requirement/requirement-contracts.ts`（锚点记录的 schema）
- 新建 `tests/line-anchors.test.ts`、`tests/conversation-entries.test.ts`

## 成品定义

锚点记录，存在 data.db 的 records 表，命名空间 `line_anchors`，键 = anchor：
```json
{
  "format": "line-anchor/v1",
  "repoId": "<64 位十六进制>",
  "requirementId": "<UUIDv7>",
  "anchor": "<UUIDv7>",
  "parent": "<UUIDv7> 或 null（需求的第一个锚点）",
  "kind": "save | decision | question | manifest | prototype | conventions | approval",
  "lineVersion": 2,
  "sequence": 1,
  "fileCommit": "<需求自己 Git 仓库里这个锚点时的文件状态提交，没有时为 null>",
  "createdAt": 1762740000000
}
```

过程记录与锚点的对应，存在命名空间 `line_anchor_members`，键 = `<命名空间>:<记录键>`，原记录的内容和版本号不动：
```json
{ "format": "line-anchor-member/v1", "requirementId": "<UUIDv7>", "anchor": "<UUIDv7>" }
```

对话里的锚点记录：`customType` 固定为 `one-company.line-anchor`，`data` 为 `{ "repoId": "...", "requirementId": "...", "anchor": "..." }`。

## 函数清单
### src/core/host/conversation-entries.ts
| 函数名 | 职责 |
|---|---|
| `branchCustomEntries` | 从 `sessionManager.getBranch()` 里按顺序取出指定 customType 的自定义记录的 data |
| `appendCustomEntry` | 包一层 `pi.appendEntry`，写入指定 customType 的记录 |

### src/modules/requirement/line-anchors.ts
| 函数名 | 职责 |
|---|---|
| `LINE_ANCHOR_ENTRY` | 对话里锚点记录的 customType 常量 |
| `createLineAnchorIn` | 在调用方的事务里写锚点记录：算父锚点、版本号、fileCommit |
| `attachRecordIn` | 在调用方的事务里写 `line_anchor_members`，把一条过程记录挂到锚点上 |
| `resolveLineTipIn` | 给定需求和对话线上的锚点编号列表，按上面的规则算线尖 |
| `countedAnchorsIn` | 给出线尖的全部祖先；需求已批准时按批准锚点规则给出 |
| `isRecordCountedIn` | 判断一条过程记录在这条线上算不算数（没挂锚点的算） |
| `lineVersionIn` | 线尖的版本号 |
| `latestSaveAnchorIn` | 需求最近一次保存的锚点 |
| `lineViewIn` | 一次扫描算出 {线尖, 算数集合, 版本号}，供调用方批量判断过程记录时复用 |
| `memberAnchorIn` | 读一条过程记录挂的锚点编号，没挂返回 null；调用方拿它和 `lineViewIn` 的算数集合比对 |

## 协作关系
- 主窗口在每次跟线写入前，用 `branchCustomEntries` 读当前线上的锚点编号，交给下游的需求服务；写入成功后用 `appendCustomEntry` 把新锚点写进对话。
- `createLineAnchorIn` 和 `attachRecordIn` 都不自己开事务，由调用方（02～06 的写入函数）在写主记录的同一事务里调用。
- 依赖 `src/core/storage/database.ts` 的 LocalDatabase。

## 验证方式
- 测试入口：`line-anchors.ts` 的导出函数，配一个用 `temporaryRoot()` 建的 data.db；`conversation-entries.ts` 用假的 sessionManager（`getBranch` 返回构造好的记录数组）。
- 测试输入：在一个需求上构造锚点树：A(save,v2) → B(save,v3) → C(decision) ；B → D(save,v4)；另一个需求的锚点混在对话记录里。
- 预期结果与验证项：
  - [ ] 对话线含 A、B、C 时线尖是 C，算数集合是 {A,B,C}，版本号 3。
  - [ ] 对话线含 A、B、D 时线尖是 D，算数集合是 {A,B,D}，版本号 4，C 不算数。
  - [ ] 对话线不含这个需求的任何锚点时，线尖是最近一次保存的锚点（最后写入的 save，按 sequence）。
  - [ ] 对话线里的锚点在数据库里查不到时跳过它，继续往前找。
  - [ ] 两次 `createLineAnchorIn` 用同一个父锚点都成功，得到两个兄弟锚点。
  - [ ] 没有 `line_anchor_members` 记录的过程记录，`isRecordCountedIn` 在任意线上都返回算数。
  - [ ] 需求有批准锚点时，批准之后产生的记录不论锚点在哪都算数，批准前不在批准锚点祖先链上的记录不算数。
  - [ ] `branchCustomEntries` 只返回指定 customType 的记录，顺序和对话一致；`getBranch` 含压缩记录时照样返回压缩前的记录。
