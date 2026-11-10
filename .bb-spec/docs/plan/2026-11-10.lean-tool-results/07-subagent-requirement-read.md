---
name: 07-subagent-requirement-read
description: PM、reviewer、qa 读需求正文时只把正文和必要字段发给模型，分页上限按发给模型的内容算，每页能放更多正文
---
# 子代理读需求正文的结果精简与分页

[依赖: lean-result-helper, subagent-tool-results]

## 目标

PM、reviewer、qa 用 requirement_manage 的 read、diff、next 读已批准的需求正文时，发给模型的内容只留正文、标题、翻页和完整性说明、章节编号、批准版本号和已确认段落；每页的大小上限按发给模型的这部分算，上限数值不变，同一份正文每页放下的正文不少于改前。

## 业务规则（来源：PRD 02-lean-tool-results）

先说几个词：`content` 是 pi 工具结果里发给模型的部分，`details` 存进会话记录、不发给模型。「视图」指从完整结果里挑出发给模型的字段组成的对象。「完整结果」指读需求工具（src/modules/pm/requirement-read-tool.ts 的 execute）现在返回的整份对象。

1. read、diff 和按游标翻页的 next（next 返回的就是 read 或 diff 的下一页）成功时，视图只有：
   - `source.revision`、`source.approvalScope.summary.confirmed`（qa 的规矩 role-rules/qa.md:4 点名要用它）；
   - `coverage.nextCursor`、`coverage.blocking`、`coverage.selectedTextComplete`、`coverage.entirePrdCovered`；
   - `title`（只有 read 有）、`text`；
   - `structure.sections` 每项只留 `id`（结果里有 structure 时）。
2. 视图里去掉：coverage 的 representation、sectionId、startByte、endByte、totalBytes、businessCompleteness、verification、performance；structure 的 status、reason、businessCompleteness 和分页计数（totalSections、startSection、endSection、remainingSections、complete），sections 的 startByte、endByte、hash；source 的其余字段（commit、prdHash、version、lifecycleEpoch、asOf、requirementId、repoId、workspaceId、branch、role、purpose、checkRoundId）；approvalScope 的 status 和 summary 的 reference、pending、excluded、blocked；diff 的 difference（含提交号和哈希）；顶层 kind。这些都留在 details 的完整结果里。
3. 字段名、嵌套位置和取值与改前相同；视图里键的顺序保持 source、coverage 在 text 前面（现有测试 tests/requirement-read-tool.test.ts:95-100 检查这个顺序，外层截断时元数据不丢）。
4. metadata 动作和需求关闭后只能读的 metadata 结果不在表里：视图就是完整结果，content 与改前逐字相同，details 是完整结果。
5. 分页上限：整页上限 `PRD_RESPONSE_MAX_BYTES`（49152 字节，src/modules/requirement/prd-view.ts:12）、正文默认每页 `PRD_PAGE_BYTES`、最大 `PRD_MAX_PAGE_BYTES` 都不变。`pagePrdResponse` 的二分（:183-215 的 `fits()`）和工具里的 `bounded()`（requirement-read-tool.ts:131-133）改成只量视图的 JSON 字节数。完整结果可能超过 49152 字节，不受限制。
6. 同一份正文、同样的 maxBytes，改后每页的 text 字节数和每页带的章节数都不少于改前（视图是完整结果的子集，量出来只会更小）。
7. 失败时报错文字不变：超上限仍报 `response_too_large`（"这一页的结果超出了返回上限"），其他原因照旧。
8. 结果送达前的核对 `assertCurrent` 照旧在 execute 里对原对象做，取视图在它之后，不影响核对。

## 涉及文件

- 修改 src/modules/requirement/prd-view.ts
- 修改 src/modules/pm/requirement-read-tool.ts
- 修改 src/modules/pm/subagent-tools.ts（reviewer、qa 的 requirement_manage 运行体带上 view）
- 修改 src/app/daemon/pm-tools.ts（PM 的 requirement_manage 运行体带上 view）
- 修改 tests/prd-view.test.ts
- 修改 tests/requirement-read-tool.test.ts

## 函数清单

### src/modules/requirement/prd-view.ts
| 函数名 | 职责 |
|---|---|
| `pagePrdResponse`（修改） | 新增必填选项「量体积用的视图函数」；二分正文长度和章节数时，`fits()` 只量视图的 JSON 字节数，返回的 response 仍是完整结果 |

### src/modules/pm/requirement-read-tool.ts
| 函数名 | 职责 |
|---|---|
| `requirementReadView`（新增，导出） | kind 为 read 或 diff 时按规则 1 挑字段、按规则 3 排键；kind 为 metadata 时原样返回 |
| `bounded`（修改，文件内） | 量 `requirementReadView(response)` 的 JSON 字节数判断是否超 `PRD_RESPONSE_MAX_BYTES`，超了照旧报 response_too_large，返回冻结的完整结果 |
| `execute`（修改，文件内） | 调 `pagePrdResponse` 时传入 `requirementReadView` 作为量体积用的视图函数，其余流程不变 |

### src/modules/pm/subagent-tools.ts、src/app/daemon/pm-tools.ts
| 函数名 | 职责 |
|---|---|
| `createSubagentTools`（修改） | reviewer、qa 的 requirement_manage 传给 toPiTool 的运行体写成 `{ ...读需求运行体, view: requirementReadView }` |
| `createPmTools`（修改） | PM 的 requirement_manage 传给 toPiTool 的运行体同样带上 `view: requirementReadView` |

## 协作关系

- 模型调 requirement_manage read/diff/next → `toPiTool`（01 计划已让它在运行体带 view 时取视图）→ 读需求工具 execute：读正文 → `pagePrdResponse`（用 `requirementReadView` 量每个候选页）→ `bounded`（再用同一个视图量一次）→ 登记游标、`assertCurrent` 核对原对象 → 返回完整结果 → 运行体的 view（即 `requirementReadView`）→ `leanToolResult`（src/core/exec/tool-result.ts）→ content=视图、details=完整结果。
- 量体积和发给模型用的是同一个 `requirementReadView`，保证"量的就是发的"。
- 翻页游标仍记完整结果里的 `page.endByte` 和 `endSection`（requirement-read-tool.ts:302），游标里的提交号、哈希仍在程序内存里核对，模型只拿 nextCursor。
- 读需求工具的运行体是冻结对象、方法都是闭包，展开成新对象加 view 后照常工作；assertCurrent 只在 execute 内部用，不受影响。
- 与 04-subagent-tool-results 改同两个组装文件（subagent-tools.ts、pm-tools.ts）的相邻行，排在它之后做。
- 主代理的需求读取不经这里，由主代理那份计划处理；`pagePrdResponse` 现在只有本工具调用（另有 tests/prd-view.test.ts）。
- 外部依赖：无新增依赖。

## 验证方式

- 测试入口：`pnpm test`（vitest）、`pnpm run typecheck`；公开入口为 `pagePrdResponse`、`inspectPrdStructure`、`PRD_RESPONSE_MAX_BYTES`（src/modules/requirement/prd-view.ts），`createRequirementReadTool`、`requirementReadView`（src/modules/pm/requirement-read-tool.ts），`toPiTool`（src/modules/agents/role-tools.ts，运行体写成 `{ ...读需求运行体, view: requirementReadView }`），`createSubagentTools`、`createPmTools`。tests/requirement-read-tool.test.ts 现有的搭建（批准需求、绑定 PM/reviewer/qa 的 world）可直接复用。
- 测试输入：
  - 一份约 60 KB 的需求正文，含很多带编号的章节和需要 JSON 转义的字符（如现有的 `LONG_STRUCTURE_BODY` 加长到 60 KB），maxBytes 分别取默认和 32768，read 第一页后按 nextCursor 一直 next 到底；diff 同样分页一次。
  - `pagePrdResponse` 同一组输入调两次：一次视图函数传「原样返回完整结果」（等于改前的量法），一次传按规则 1 挑字段的视图函数。
  - 一次 metadata 调用；一次 maxBytes 合法但固定元数据已超上限的调用。
- 预期结果：每页视图 JSON ≤ 49152 字节；所有页的 text 拼起来等于正文；按视图量的那次每页 `page.endByte` 不小于、`endSection` 不小于原样量的那次；content 是视图、details 是完整结果。

- [ ] read、diff、next 每页经 `toPiTool` 包装后：content 含 text、coverage.nextCursor、coverage.blocking、coverage.selectedTextComplete、coverage.entirePrdCovered、source.revision、source.approvalScope.summary.confirmed，read 时含 title，有章节时 structure.sections 每项只有 id。
- [ ] 同上 content 不含 coverage.startByte/endByte/totalBytes/representation/businessCompleteness/verification/performance、sections 的 startByte/endByte/hash、structure 的分页计数、source.commit、source.prdHash、source.lifecycleEpoch、approvalScope.summary 的 pending/excluded/blocked/reference、difference；details 全部含有。
- [ ] content 里保留字段的值与 details 同位置的值相等；JSON 里 `"source":`、`"coverage":` 出现在 `"text":` 之前。
- [ ] 60 KB 正文分页：每页 content 的字节数 ≤ 49152；拼起来的 text 等于正文；完整结果（details）允许超过 49152。
- [ ] `pagePrdResponse` 对比：按视图量时每页正文字节数和章节数都不少于原样量时，至少有一页严格更多（输入让原样量时受整页上限限制）。
- [ ] metadata：content 与 `JSON.stringify(完整结果)` 逐字相同，details 是完整结果。
- [ ] 固定元数据超上限时仍抛 `prd_response_budget_exceeded`（`pagePrdResponse`）或工具报"这一页的结果超出了返回上限"，文字与改前相同。
- [ ] 现有断言跟着改并通过：tests/requirement-read-tool.test.ts:95-100 的 `bounded` 改成量 `requirementReadView(结果)`；tests/prd-view.test.ts:38-42、54-58 调 `pagePrdResponse` 时补上视图函数，:42 的体积断言改成量视图。
- [ ] 纯代码测试四项全部通过；真实模型验收全部单点测试（P1–P22）、零自定义完整流程（M9-AC12）、渐进需求完整流程（M9-AC2/AC3/AC11）按 2 次、必要时第 3 次的规则通过。

## 与 PRD 不一致

1. PRD 子代理表只写 read、diff；代码里 next 返回的是 read 或 diff 的下一页（src/modules/pm/requirement-read-tool.ts:212-214、290），本计划对 next 用同一个视图。
2. PRD 子代理表写 `coverage.blocking` 保留，没写"非空时"（主代理表写了）；代码里 blocking 读全时是空数组（:294）。本计划照子代理表一直保留。
3. 两列都没写的字段：顶层 kind、coverage.sectionId、structure 的 status/reason/businessCompleteness、difference 的 fromRevision/toRevision（:282-283、290-297）。本计划都不发给模型，留在 details；理由是模型自己传了 sectionId 和版本范围，章节不可用时按章节读会直接报错说明。
4. PRD 写"structure.sections 的 id"保留、"sections 的字节位置和 hash 及分页计数"移除；代码里分页计数（totalSections、startSection、endSection、remainingSections、complete）在 structure 这一层，不在 sections 里（src/modules/requirement/prd-view.ts:173-180）。本计划按 structure 层去掉。
