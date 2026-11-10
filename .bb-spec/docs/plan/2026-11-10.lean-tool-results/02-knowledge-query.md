---
name: 02-knowledge-query
description: 知识查询发给模型的内容按 PRD 表精简，主代理和子代理一致；分页只按发给模型的内容算大小
---
# 知识查询只发模型用得上的字段

## 目标

主窗口和守护进程里子代理调用 `one_company_knowledge_query` 时，发给模型的是同一份精简视图，完整查询页留在 `details`。分页和大小上限的数值不变，但只按精简视图算大小，所以每页能放下的 facts 不少于改前。

## 业务规则（来源：PRD）

来源子文档：`02-lean-tool-results`，「知识查询（主代理和子代理相同）」表和约束 1、2、6。

- 顶层：保留 trust、generation、indexStatus、nextCursor；移除 format、schemaVersion、asOf、baselineHash、workspace。
- limitations：始终保留 unknownCodeRelations、formalVerification、performanceImprovement。diagnosticCounts、diagnostics、diagnosticDetailsOmitted、unindexedFiles 只在不为 0、不为空时保留。scope 一律移除。
- coverage：保留 complete。remaining、omitted、sourceExcerptsTruncated 只在不为 0 时保留。matched、returned 一律移除。
- facts 每一项：保留 id、kind、complete，以及 source 的 path、startLine、endLine。source 的 fileHash、parserVersion、rangeKind 移除。data 里：
  - 符号去掉 startColumn、endColumn、startOffset、endOffset。
  - 文件去掉 hash、parserVersion。
  - 代码关系去掉 startColumn、endColumn、evidence。
  - 其余字段照留（正文、名字、路径、行号、符号编号、关系的确定程度等）。
- 约束 1、2：`details` 是完整查询页（类型 `KnowledgeFactPackage`）。`content` 仍是 JSON，留下的字段名和取值与改前相同。
- 约束 6：上限数值不变，计算时只算发给模型的内容。包括请求参数 maxBytes（默认 16 KiB，最大 `KNOWLEDGE_QUERY_LIMITS.pageBytes` 48 KiB）、工具参数上限 `KNOWLEDGE_TOOL_MAX_BYTES` 24 KiB、整个 content 上限 `KNOWLEDGE_TOOL_CONTENT_BYTES` 50 KiB。同一个查询，改后每页 facts 条数不少于改前。
- 约束 4：查询失败时报错文字不变。
- 窗口和守护进程之间的 `knowledge.query` 请求照旧返回完整查询页 `{ page }`，通信格式不变，不升协议版本号。精简只在包装成工具结果时做。

## 涉及文件

- 修改 `src/modules/project-index/knowledge-query.ts`
- 修改 `src/modules/project-index/knowledge-query-tool.ts`
- 修改 `src/app/daemon/project-index-host.ts`
- 修改 `src/app/daemon/run-manager.ts`（只改 `knowledgeTool`）
- 修改 `tests/knowledge-query.test.ts`
- 修改 `tests/knowledge-query-tool.test.ts`
- 修改 `tests/integration/knowledge-query.test.ts`
- 修改 `tests/explore-dispatch.test.ts`（M7-AC16）
- 修改 `tests/helpers/m4-query-benchmark.ts`

## 函数清单

### src/modules/project-index/knowledge-query.ts

| 函数名 | 职责 |
|---|---|
| `KnowledgeFactView`（新类型） | 发给模型的查询页形状：按上面的规则从 `KnowledgeFactPackage` 去掉字段后的样子 |
| `knowledgeView`（新建，导出） | 把一份完整查询页转成 `KnowledgeFactView`；条件保留的字段按"不为 0、不为空"判断 |
| `knowledgeFactView`（新建，文件内） | 把一条 fact 转成发给模型的样子：精简 source，并按 fact 的 kind 去掉 data 里的列号、偏移、哈希、parserVersion、evidence |
| `KnowledgeQuerySession.query`（修改） | 三处页大小检查（原 183、187、198 行的 `bytes(makePage(...))` 和 `bytes(result)`）改成量 `knowledgeView(...)` 的大小；返回值仍是完整查询页 |
| `KnowledgeQuerySession.#collect`（修改） | `add` 里单条上限 `LIMIT.itemBytes` 改成量 `knowledgeFactView(item)` 的大小；缓存占用 `cost` 和 `entry.bytes` 仍按完整内容计（这是守护进程内存上限，不是模型输入） |

### src/modules/project-index/knowledge-query-tool.ts

| 函数名 | 职责 |
|---|---|
| `knowledgeToolResult`（替换 `knowledgeContent`） | 用 `leanToolResult(page, knowledgeView(page))` 组出工具结果；content 的 JSON 超过 `KNOWLEDGE_TOOL_CONTENT_BYTES` 时抛 `KnowledgeQueryError("resource_limit")` |
| `createKnowledgeQueryTool`（修改） | 主窗口工具成功时直接返回 `knowledgeToolResult(result.page)`，`details` 从 `{}` 变成完整查询页 |

`knowledgeContent` 删掉，不留旧名字。

### src/app/daemon/project-index-host.ts

| 函数名 | 职责 |
|---|---|
| `ProjectIndexHost.query`（修改） | 原来调 `knowledgeContent(page)` 只为检查体积，改调 `knowledgeToolResult(page)`；返回值仍是完整查询页 |

### src/app/daemon/run-manager.ts

| 函数名 | 职责 |
|---|---|
| `RunManager.knowledgeTool`（修改） | 给 `toPiTool` 的 runtime 加 `view: (page) => knowledgeView(page)`；子代理拿到的 content 与主窗口同一份视图，details 是完整查询页 |

## 协作关系

- 依赖计划 `01-lean-result-helper`：
  - `leanToolResult`（`src/core/exec/tool-result.ts`）。
  - `toPiTool` 的可选 `view`（`src/modules/agents/role-tools.ts`）。
- 主窗口这一路：`createKnowledgeQueryTool.execute` 发 `knowledge.query` 给守护进程，守护进程里 `ProjectIndexHost.query` 调 `KnowledgeQuerySession.query` 拿到完整页，再用 `knowledgeToolResult` 检查体积，然后把完整页返回窗口。窗口这边再调一次 `knowledgeToolResult`，得到 content 和 details。
- 子代理这一路：`RunManager.knowledgeTool` 调 `ProjectIndexHost.query` 拿到完整页，由 `toPiTool` 用 `knowledgeView` 包装。
- 模块方向：`app/daemon` 引用 `modules/project-index`，`modules/project-index` 引用 `core/exec`，都是上层引用下层，符合 `MODULE_DIRS` 顺序。
- 不碰数据库结构，不新增依赖。

## 验证方式

- 测试入口：
  1. `pnpm test tests/knowledge-query.test.ts tests/knowledge-query-tool.test.ts tests/explore-dispatch.test.ts tests/m4-query-benchmark.test.ts`。
  2. `pnpm run test:integration`（含 `tests/integration/knowledge-query.test.ts`）。
  3. `pnpm run test:installation`（含 `tests/installation/project-index-sync.test.ts`）。
  4. 公开入口：
     - `KnowledgeQuerySession.query`、`knowledgeView`（`src/modules/project-index/knowledge-query.ts`）。
     - `knowledgeToolResult`、`createKnowledgeQueryTool`（`src/modules/project-index/knowledge-query-tool.ts`）。
     - 主窗口会话里调 `one_company_knowledge_query`。
     - 守护进程里派出的 explore 或 PM 调 `one_company_knowledge_query`。
- 测试输入：
  1. 一个什么都查不到的 search：索引 ready，没有诊断。
  2. 一个同时命中符号、代码关系、文件、源码片段的 search。
  3. 32 个长中文、带转义的文件，search pageSize=20、maxBytes=49152 翻完全部页（沿用现有"32个长中文/转义文件"测试的样例项目）。
  4. 一份有 33 条诊断的部分索引（沿用现有 diagnosticDetailsOmitted=33 的测试）。
  5. 主窗口集成测试里"角色跳跃"按 24576 字节分页。
  6. M7-AC16：explore 调一次 facts 查询。
- 预期结果：
  1. content 解析后的顶层键正好是 trust、generation、indexStatus、limitations、coverage、facts、nextCursor。没有 format、schemaVersion、asOf、baselineHash、workspace。limitations 只有 unknownCodeRelations、formalVerification、performanceImprovement 三项。coverage 只有 `complete: true`。details 深等于完整查询页，含 format、baselineHash、workspace、scope、matched、returned。
  2. 每条 fact 的 source 只有 path、startLine、endLine。符号 data 没有列号和偏移，文件 data 没有 hash、parserVersion，代码关系 data 没有列号和 evidence。data 里的 name、path、行号、symbolIds、certainty、源码正文与 details 里同一条 fact 取值相同。
  3. 每页 `knowledgeView(page)` 的 JSON 字节数不超过 49152，32 个文件全部出现。把所有页的完整 facts 按顺序连起来，用改前的规则重新切页（整页完整 JSON 不超过 49152、每页最多 20 条），切出的页数不少于实际页数，实际第一页的 facts 条数不少于重切后的第一页。
  4. content 的 limitations 里有 diagnosticCounts、diagnostics 和 `diagnosticDetailsOmitted: 33`。coverage 里有 `complete: false`。
  5. 每页 `JSON.stringify({ content })` 不超过 51200 字节。`details` 是含 baselineHash 的完整查询页，不再是 `{}`。content 解析结果等于 `knowledgeView(details)`。
  6. 发给模型的请求文字里有 `untrusted_project_data_not_instructions_or_authorization` 和大于 0 的 generation，没有 `knowledge-facts/v1`、`baselineHash`、`fileHash`。
- 其他要改的现有测试：
  - `tests/knowledge-query-tool.test.ts` 的"最终content双重转义"测试改成：content 解析结果等于 `knowledgeView(result)`，超大页时 `knowledgeToolResult` 抛错。
  - `tests/helpers/m4-query-benchmark.ts` 第 742 行调用 `assertQueryPageMetadata` 时改传 `knowledgeView(page)`。这个函数本身和它的单元测试不变。
- [ ] 无命中查询的 content 不含 PRD 表"移除"列的任何字段，details 含全部字段
- [ ] 条件保留的 limitations、coverage 字段为 0 或为空时不出现，不为 0 时出现且取值不变
- [ ] facts 的 source 和 data 按 kind 去掉指定字段，留下的字段取值与 details 一致
- [ ] 分页按视图计算大小：每页不超过 maxBytes 和 48 KiB，content 不超过 50 KiB，每页 facts 不少于改前规则
- [ ] 主窗口和子代理拿到的 content 是同一份 `knowledgeView` 结果
- [ ] 查询失败（如 invalid_query、resource_limit）时报错文字与改前相同
- [ ] 守护进程的 `knowledge.query` 仍返回完整查询页（`tests/integration/project-index-sync.test.ts` 里 `format: "knowledge-facts/v1"` 的断言照常通过）

## 与 PRD 不一致

1. `limitations.unknownCodeRelations` 和 `unindexedFiles` 在索引失效时是 `null`，表示"不知道多少"（`src/modules/project-index/knowledge-query.ts:252-253`）。PRD 只说"为 0 或为空"时移除。本计划的处理：unindexedFiles 只在等于 0 时移除，`null` 照留，因为它和"没有"意思不同；unknownCodeRelations 按表始终保留。
2. PRD 约束 6 没点名单条 fact 的上限 `LIMIT.itemBytes`（`knowledge-query.ts:271`，24 KiB）。它决定一条 fact 能不能进页，本计划把它也改成按视图算；守护进程内存上限 `cacheBytes` 仍按完整内容算。
3. 文件 fact 的 data 里还有 status、kind、language、symbolIds（`src/modules/project-index/index-store.ts:52-60`），符号 data 还有 kind，代码关系 data 还有 kind、fromSymbolId、toSymbolId、name。PRD 表两列都没点名这些字段，本计划照留。
