---
name: 05-explore-main
description: 检索结果送到主窗口时只给模型看结论摘要，完整报告存进消息 details；agent_manage 新增 sources 动作按运行编号取来源
---
# 主代理侧：检索结果只给结论，按编号取来源

## 目标

检索结果送到主窗口后，发给主代理的只有结论、没查到、没核实、来源条数和用法说明，完整报告存在这条消息的 `details` 里；主代理用 `one_company_agent_manage action=sources` 按运行编号从本会话当前分支取回全部来源和检索范围，窗口重开、守护进程重启后照样取得到。

## 业务规则（来源：PRD 01-explore-results）

- explore 是只读的检索代理，交回的报告叫检索结果；运行编号（runId）是程序派出时生成、派出时就返回给主代理的编号。
- 约束 1：交了结果时，发给主代理的内容含运行编号、成败、已用轮数、全部结论、没查到、没核实、失败、是否截断及原因、来源条数；不含来源的链接、路径、摘录、起止行、文件哈希、抓取时间，不含搜索范围、派出方信息（parent）、检索输入来源（source）、格式字段（format、kind）。
- 约束 2：内容里写明用法：结论要写进需求草稿，或当作回答用户的依据时，先按运行编号取来源核对；只用来决定下一步再查什么时不用取。
- 约束 3：这条检索结果消息的 `details` 存完整报告（守护进程交出的原样），pi 不把 `details` 发给模型。
- 约束 4：`one_company_agent_manage` 的取来源动作：编号是本会话当前分支里收到过的检索结果时，返回该报告的全部来源和检索范围；否则失败，原因写"本会话里没有这个编号的检索结果"。
- 约束 5：窗口重开、守护进程重启后，按同一编号取来源，结果和重启前相同。完整报告跟着会话记录走，所以只有新开会话后才取不到（用户 2026-11-10 决定，否决了留在守护进程内存里的做法）。
- 约束 8：检索没交结果时，发给主代理的内容和现在相同：守护进程报告原样（运行编号、成败、原因、下一步建议、运行日志路径）。
- 约束 9：主代理规矩 `rules/01-main-session.md` 第 7 条里检索结果的用法写成约束 2 的写法。
- 目标：同一份报告，发给模型的字数比现在少一半以上。
- 窗口和守护进程之间的通信不变：守护进程的 `explore.result` 照旧交出完整报告，拆分全在窗口这边做；取来源只读本会话记录，不经守护进程。按 AGENTS.md「协议版本号只在窗口和守护进程之间的通信变了时升」，本计划不升 `PROTOCOL_VERSION`（现为 8）。
- 按「工具编号」原则，sources 动作的参数只有 `action` 和指向已有检索的引用编号 `runId`，不带新操作编号；它只读会话记录，不需要 `repoId`。

## 涉及文件

- 新建 `src/modules/explore/explore-report.ts`：完整报告类型和两个视图函数，主窗口和守护进程（06 计划）共用。explore 在模块顺序里排在 pm、app 之下，两边都能引用。
- 修改 `src/modules/explore/agent-manage-extension.ts`：送达时拆 content / details；新增 sources 动作和工具说明。
- 修改 `src/core/policy/core-permissions.ts`：`CORE_TOOL_ACTIONS.agent_manage` 末尾加 `"sources"`（main 拿到除 catalog 外全部动作、pm 拿到除 message 外全部动作，两边自动获得 sources）。
- 修改 `rules/01-main-session.md`：第 7 条（文件第 15 行）。
- 新建 `tests/explore-report.test.ts`：视图函数单元测试。
- 修改 `tests/explore-delivery.test.ts`：现有用例的假报告 `{ summary: "报告" }` 换成完整报告形状；新增送达内容和 details 的断言。
- 新建 `tests/main-explore-sources.test.ts`：sources 动作，含重新打开会话文件后的取来源。
- 修改 `tests/core-permissions.test.ts`：第 90 行 main 的 agent_manage 授权清单加 `"sources"`。
- 修改 `tests/role-catalog.test.ts`：在读 `01-main-session.md` 的用例旁加第 7 条新写法的断言。
- 新建 `tests/acceptance/points/p22-main-explore-sources.test.ts`：真实模型验收，主代理先取来源再写草稿。
- 修改 `tests/acceptance/measure.ts`：第 61 行读主窗口卡片时，消息带 `details` 就从 `details` 读完整报告（content 里已经没有来源）。

现有断言 explore 结果内容的位置：`tests/explore-dispatch.test.ts:73,255`、`tests/explore-web.test.ts:56-58,71-73,118-120` 断言的是守护进程 `takeMainExploreReport` 交出的完整报告，本计划不改守护进程，这些断言保持不变；PM 收到的报告（`explore-dispatch.test.ts:38-46,163-179,268`、`explore-web.test.ts:73-81`）归 06 计划。

## 成品定义

### 发给模型的检索结果摘要（`exploreReportView` 的输出）

交了结果（`research` 非空）时，content 是下面这个对象的 JSON，字段名和顺序固定：

```json
{
  "runId": "<报告的 runId>",
  "outcome": "<报告的 outcome>",
  "turnsUsed": 3,
  "conclusions": ["<research.conclusions 全部>"],
  "notFound": ["<research.notFound 全部>"],
  "unknown": ["<research.unknown 全部>"],
  "failures": ["<research.failures 全部>"],
  "truncation": { "truncated": true, "reasons": ["<research.truncation.reasons 全部>"] },
  "sourceCount": 8,
  "next": "<按派出方取下面两句之一>"
}
```

`next` 原文：

- 主代理（audience 为 main）：`结论要写进需求草稿，或当作回答用户的依据时，先用 one_company_agent_manage action=sources 按 runId 取来源核对；只用来决定下一步再查什么时不用取。`
- PM（audience 为 pm，06 计划使用）：`结论要写进计划或任务，或当作回答用户的依据时，先用 one_company_agent_manage action=sources 按 runId 取来源核对；只用来决定下一步再查什么时不用取。`

没交结果（`research` 为 null）时，`exploreReportView` 原样返回完整报告。

### 取来源返回给模型的内容（`exploreSourcesView` 的输出）

```json
{ "runId": "<runId>", "sources": ["<research.sources 原样，全部条目>"], "searchedScope": "<research.searchedScope 原样>" }
```

工具结果用 01-lean-result-helper 在 `src/core/exec/tool-result.ts` 里定义的包装函数生成：发给模型的视图是上面这个对象，`details` 是完整报告。[依赖: lean-result-helper]

### 主窗口 agent_manage 参数新增的一种形状

```ts
Type.Object({ action: Type.Literal("sources"), runId }, strict)
```

`runId` 用文件里现有的 UUIDv7 `runId` 定义。

### 主窗口 agent_manage 工具说明

在现有说明的"或查询、暂停、续接、停止运行，"之后插入原文：

`或用 sources 按运行编号取本会话收到过的检索结果的全部来源和检索范围，`

### 失败文字

- 原因：`本会话里没有这个编号的检索结果`
- 建议：`核对运行编号，用派出检索时返回、检索结果里写的 runId；别的会话派出的检索在这里取不到`

### `rules/01-main-session.md` 第 7 条最终原文（整行替换第 15 行）

```markdown
7. **检索**：回答功能或行为问题前先查代码，回答里写出依据的文件与行号；行号取自知识查询结果里的起止行或 `grep -n` 的输出，读文件工具返回的正文不带行号，不要自己数；归档、说明注释和代码说的不一样时，以代码为准，并说清哪里不一样。查当前代码用 `one_company_knowledge_query`，查函数说明可直接 grep 注释；需要广泛检索或联网时用 agent_manage 派 explore，结果以卡片送回，只有结论、没查到、没核实和来源条数。检索结果要当依据时先按运行编号取来源核对：结论要写进需求草稿，或当作回答用户的依据时，先用 agent_manage action=sources 取来源；只用来决定下一步再查什么时不用取。
```

## 函数清单

### src/modules/explore/explore-report.ts（新建）

| 函数名 | 职责 |
|---|---|
| `ExploreReport`（类型） | 守护进程交出的完整检索报告：kind、runId、outcome、turnsUsed、research，以及 note 或 reason、next、log |
| `exploreReportView` | 把完整报告变成发给模型的摘要：交了结果时按成品定义只留约束 1 的字段并按派出方（main / pm）填 next；没交结果时原样返回 |
| `exploreSourcesView` | 从 runId 和 research 取出全部来源和检索范围，作为取来源动作发给模型的内容 |

### src/modules/explore/agent-manage-extension.ts（修改）

| 函数名 | 职责 |
|---|---|
| `MAIN_AGENT_MANAGE_PARAMETERS` | 联合类型里加 sources 形状 |
| `findExploreReport`（新增） | 在 `ctx.sessionManager.getBranch()` 的条目里找 type 为 custom_message、customType 为 `one-company.explore-result`、`details.runId` 等于给定编号且 `details.research` 非空的条目，返回它的 details；找不到返回 undefined |
| `registerAgentManageTool` | 说明加一句；execute 在找仓库客户端之前处理 sources：调 `findExploreReport`，找到就用结果包装函数返回 `exploreSourcesView`，找不到按成品定义的失败文字失败 |
| `registerExploreDelivery` | 送达时 `pi.sendMessage` 的 content 改为 `exploreReportView(report, "main")` 的 JSON，`details` 放守护进程交出的完整报告；customType、display、triggerTurn 不变 |

### src/core/policy/core-permissions.ts（修改）

| 函数名 | 职责 |
|---|---|
| `CORE_TOOL_ACTIONS` | agent_manage 动作表末尾加 `"sources"` |

## 协作关系

- `registerExploreDelivery` → 守护进程 `explore.result`（不变）→ `exploreReportView` → `pi.sendMessage`（content 进模型，details 只进会话记录）。
- `registerAgentManageTool` 的 sources → `findExploreReport`（读 pi 会话当前分支，不调守护进程）→ `exploreSourcesView` → 01 计划的结果包装函数。
- 06 计划依赖本计划的 `exploreReportView`（audience 为 pm）、`exploreSourcesView` 和 `CORE_TOOL_ACTIONS` 里的 `"sources"`。
- 03-main-tool-results 计划也改 `agent-manage-extension.ts` 里 dispatch、status 等现有动作的结果包装，先于本计划执行；本计划只加 sources 分支、改送达，不动那几处。卡片显示归 08、09 计划。

## 验证方式

- 测试入口：`pnpm test`（vitest，`tests/` 下）；包级入口 `exploreReportView`、`exploreSourcesView`（`src/modules/explore/explore-report.ts`）、`registerExploreDelivery`、`registerAgentManageTool`（`src/modules/explore/agent-manage-extension.ts`，用 `tests/helpers/fake-pi.ts` 的假 pi 截获 `sendMessage` 和注册的工具）、`authorizeToolAction`；真实模型验收 `ONE_COMPANY_ACCEPTANCE_OUTPUT=<绝对路径> pnpm run test:acceptance:parallel --only P22`。
- 测试输入：一份完整报告：`kind: "explore-report"`、一个 UUIDv7 的 runId、`outcome: "completed"`、`turnsUsed: 3`、`note`，research 为联网结果，含 6 条结论、8 条来源（每条有 url、retrievedAt、quote）、`searchedScope.queries` 9 个搜索词、2 条 notFound、3 条 unknown、1 条 failures、`truncation: { truncated: true, reasons: ["网页过长"] }`、parent、source、format、kind；另一份没交结果的报告：`outcome: "turn_limit_reached"`、`research: null`、reason、next、log。
- 预期结果：见下面各项。
- [ ] 摘要字段：完整报告经 `exploreReportView(report, "main")` 得到的对象，键正好是成品定义里的 10 个，`sourceCount` 为 8，conclusions / notFound / unknown / failures / truncation 与 research 里的逐项相同。
- [ ] 摘要不含来源：摘要的 JSON 里不出现任何一条来源的 url 或 quote、任何一个搜索词，也没有 `parent`、`source`、`format`、`kind`、`searchedScope`、`retrievedAt` 这些键。
- [ ] 用法说明：audience 为 main 时 `next` 等于成品定义里主代理那句原文；audience 为 pm 时等于 PM 那句原文。
- [ ] 字数：摘要 JSON 的字数不到完整报告 JSON 字数的一半。
- [ ] 没交结果：`exploreReportView` 对没交结果的报告返回值与原报告深相等。
- [ ] 送达：假客户端 `explore.result` 返回完整报告，触发 `explore.finished` 后，`sendMessage` 收到的 content 等于 `JSON.stringify(exploreReportView(report, "main"))`，`details` 与完整报告深相等，customType 为 `one-company.explore-result`；没交结果的报告送达时 content 等于 `JSON.stringify(report)`；现有"先撤销已记下的用户原话再 sendMessage"的顺序断言仍通过。
- [ ] 取来源：用 pi 的 `SessionManager.create(cwd, 临时目录)` 建会话，写入一条用户消息、一条 assistant 消息（让会话落盘），再用 `appendCustomMessageEntry("one-company.explore-result", 摘要JSON, true, 完整报告)` 写入检索结果；以 `{ sessionManager }` 为 ctx 调 sources（参数 `{ action: "sources", runId }`），返回的 content 文本解析后等于 `{ runId, sources: 8 条原样, searchedScope: 原样 }`，details 与完整报告深相等；假客户端的 `call` 一次都没被调用。
- [ ] 编号不在本会话：换一个格式正确但会话里没有的 UUIDv7 调 sources，失败文字含"原因：本会话里没有这个编号的检索结果"；没交结果那份报告的 runId 同样失败。
- [ ] 重开会话：用 `SessionManager.open(会话文件路径)` 重新打开同一会话，换一个全新注册的工具实例（假客户端不可用）再按同一 runId 调 sources，返回与重开前逐字相同。
- [ ] 参数：`{ action: "sources", runId, repoId }`、`{ action: "sources" }`、runId 不是 UUIDv7 时都按"参数不符合该动作的格式"失败。
- [ ] 授权：`authorizeToolAction("main", "agent_manage", "sources")` 与 `authorizeToolAction("pm", "agent_manage", "sources")` 为 true，其他角色为 false；main 的授权清单为 `["dispatch", "status", "pause", "resume", "stop", "message", "sources"]`；"已注册工具的 action 枚举都落在核心表内"仍通过。
- [ ] 规矩原文：`rules/01-main-session.md` 第 7 条与成品定义逐字相同，含"要当依据时先按运行编号取来源核对"和"agent_manage action=sources"。
- [ ] 通信不变：`tests/daemon-protocol.test.ts` 不改仍通过，`PROTOCOL_VERSION` 仍为 8。
- [ ] 真实模型 P22：样例项目里有 `src/login.ts`（验证码 5 分钟过期），用户说"我要给登录加验证码重发功能。先派 explore 在本地查清验证码多久过期、在哪定义，把查到的写进需求草稿"；等主代理收到检索结果并结束回合（等到出现 requirement_manage 的 create 或 updateDraft，或 30 分钟超时）。判定：检索结果送达之后，出现一次 `one_company_agent_manage` 的 `action: "sources"`，其 runId 等于派出 explore 返回的 runId，且它排在送达之后第一次 `one_company_requirement_manage` create 或 updateDraft 之前。按 AGENTS.md 每条跑 2 次、一过一不过补跑第 3 次判定。
- [ ] 全量：`pnpm run typecheck`、`pnpm test`、`pnpm run test:integration`、`pnpm run test:installation` 全部通过。

## 拿不准

- sources 动作不要 `repoId`（来源只在本会话记录里，跟仓库无关）。主窗口其他动作都要 `repoId`，模型可能照习惯多填一个而被格式校验拒绝；失败文字会让它改正，真实模型 P22 能看出这是不是问题。
- 没交结果的检索，按它的 runId 取来源也报"本会话里没有这个编号的检索结果"，字面上不准确；PRD 只定了这一种失败原因，本计划没有另加。
- 完整报告里的 `note`（"research 不是 PASS……"）只留在 details 里，模型看不到；删掉它会改变 `explore.result` 的返回内容，要升协议版本号，所以不删。
- `tests/acceptance/measure.ts` 读的 `main-session*.json` 里，自定义消息是否带 `details` 没有实测；不带时检索回读统计会少掉被引用文件，测量本身不报错。
