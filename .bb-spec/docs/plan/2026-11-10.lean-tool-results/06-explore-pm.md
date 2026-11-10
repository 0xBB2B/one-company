---
name: 06-explore-pm
description: PM 收到的检索结果按主代理同一规则只给结论摘要；完整 research 存进 data.db，PM 用 sources 按编号取，重启后仍在
---
# PM 侧：检索结果只给结论，按编号取来源

## 目标

PM 派的检索结束后，守护进程送给 PM 的提示词只有结论摘要（和主代理同一规则）；通过核对的完整 research 写进本机数据库，PM 用 `one_company_agent_manage action=sources` 按运行编号取回本需求派出过的检索的全部来源和检索范围，守护进程重启后照样取得到。[依赖: explore-main]

## 业务规则（来源：PRD 01-explore-results）

- explore 是只读的检索代理；运行编号（runId）是程序派出时生成、派出时就返回给 PM 的编号。research 是 explore 交回、经程序核对过形状和来源的检索内容。
- 约束 6：PM 收到的检索结果按主代理的同一规则组成：含运行编号、成败、已用轮数、全部结论、没查到、没核实、失败、是否截断及原因、来源条数；不含来源的链接、路径、摘录、起止行、文件哈希、抓取时间，不含搜索范围、parent、source、format、kind；用法说明里"写进需求草稿"换成"写进计划或任务"。同一种结果用同一套规则（用户 2026-11-10 决定）。
- 约束 7：PM 的 agent_manage 有按运行编号取检索来源的动作：编号是本需求下派出的检索时，返回全部来源和检索范围；否则失败，原因写"本需求没有派出过这个编号的检索"。守护进程重启后结果不变。PRD 决策：PM 这边从该次检索运行的记录里取。
- 约束 8：检索没交结果时，PM 收到的内容和现在相同：守护进程报告原样（运行编号、成败、原因、下一步建议、运行日志路径）。
- 约束 9：PM 规矩 `role-rules/pm.md` 核对子代理结果那条，检索结果的用法写成"要当依据时先按运行编号取来源核对"。
- 完整 research 现在只在内存里：`dispatchExplore` 用 `onResearch` 把它记在局部变量 `captured`（`src/app/daemon/run-manager.ts:868-870`），`finishExplore` 用完就丢（`run-manager.ts:1220-1231`）。运行记录 `RunRecord`（`src/modules/agents/run-store.ts:28-56`）没有结果字段。explore 会话记录里的 `result_submit` 参数是模型交的原文，宿主补的绝对路径、文件哈希、parent、source 不在里面，要还原得再拿派工输入重跑一遍核对，而派工输入没有落盘。所以本计划把通过核对的 research 在检索结束时写进 data.db 的新记录 `explore_research`，按 runId 存，带所属需求编号；重启后从这里读。
- data.db 的记录表是通用的"命名空间 + 键 + JSON"结构，加一个命名空间不改表结构；升级前派出的检索没有这条记录，按"没有派出过"处理，不读旧格式。
- 按「工具编号」原则，sources 动作的参数只有 `action` 和引用编号 `runId`。

## 涉及文件

- 修改 `src/modules/explore/explore-session.ts`：新增 `explore_research` 记录的形状、写入和读取。
- 修改 `src/app/daemon/run-manager.ts`：`exploreReport` 返回类型改为 05 计划的 `ExploreReport`；`finishExplore` 的 PM 分支写记录、送摘要。
- 修改 `src/app/daemon/pm-tools.ts`：`PM_ACTION_SHAPES` 加 sources 形状；`agentManageTool` 加 sources 分支和工具说明。
- 修改 `role-rules/pm.md`：第 27 行。
- 新建 `tests/pm-explore-sources.test.ts`：PM 收到的摘要、取来源、重启后取来源、别的需求的编号。
- 修改 `tests/explore-dispatch.test.ts`：第 31 行用例名和第 38、45-46 行（等 `"explore-report"`、断言"research 不是 PASS"）改为等 `"sourceCount"`、断言 PM 那句用法说明；第 154-179 行两条用例（断言 PM 报告里有文件哈希和 `${workspace}/src`）改为用 sources 动作取来源后断言；第 268 行的等待条件同样改为 `"sourceCount"`；第 54-60 行到限用例（等 `turn_limit_reached`）不改。
- 修改 `tests/explore-web.test.ts`：第 56 行用例名和第 73、79-81 行同上改法。
- 修改 `tests/role-catalog.test.ts`：在 `loadRoleRules("pm")` 的断言处加核对子代理结果那条的新写法。
- 修改 `tests/acceptance/measure.ts`：第 61、71 行认 PM 收到的检索结果时，条件改为提示词 JSON 里有 `"sourceCount"` 或 `"kind":"explore-report"`（后者是没交结果的报告）。

## 成品定义

### data.db 新命名空间 `explore_research`（键为 runId）

```ts
export const EXPLORE_RESEARCH = "explore_research";
export const ExploreResearchRecord = object({
  format: Type.Literal("explore-research/v1"),
  runId: id,
  requirementId: id,
  research: ExploreResultSchema,
});
```

`object`、`id` 沿用 `explore-session.ts` 已引用的 `requirement-contracts.ts` 定义，`ExploreResultSchema` 取自 `explore-contracts.ts`。

### PM 收到的提示词

交了结果：`JSON.stringify(exploreReportView(report, "pm"))`，即 05 计划成品定义里的摘要对象，`next` 为：

`结论要写进计划或任务，或当作回答用户的依据时，先用 one_company_agent_manage action=sources 按 runId 取来源核对；只用来决定下一步再查什么时不用取。`

没交结果：`JSON.stringify(report)`，与现在相同。

### PM agent_manage 参数新增的一种形状

```ts
sources: [Type.Object({ action: Type.Literal("sources"), runId: Type.String({ pattern: UUID_V7 }) }, { additionalProperties: false })],
```

### 返回给 PM 的内容

用 01-lean-result-helper 在 `src/core/exec/tool-result.ts` 定义的结果包装函数：发给模型的视图是 `exploreSourcesView(runId, record.research)`（`{ runId, sources, searchedScope }`），details 是整条 `explore_research` 记录。[依赖: lean-result-helper]

### 失败文字

- 原因：`本需求没有派出过这个编号的检索`
- 建议：`核对运行编号，用本需求派出检索时返回、检索结果里写的 runId`

### PM agent_manage 工具说明

在现有说明的"status/pause/resume/stop 控制本 PM 派出的运行。"之后插入原文：

`sources 按运行编号取本需求派出过的检索的全部来源和检索范围。`

### `role-rules/pm.md` 第 27 行最终原文（整行替换）

```markdown
- 子代理结果必须由你核对实际证据后整合：结束通知里的验证引用用 one_company_verification_run action=status 逐条查看；检索结果只有结论、没查到、没核实和来源条数，要当依据时先按运行编号取来源核对：结论要写进计划或任务时，先用 one_company_agent_manage action=sources 取来源，只用来决定下一步再查什么时不用取；非阻塞建议不自动变成任务。
```

## 函数清单

### src/modules/explore/explore-session.ts（修改）

| 函数名 | 职责 |
|---|---|
| `ExploreResearchRecord`（形状） | `explore_research` 记录的形状，见成品定义 |
| `saveExploreResearch`（新增） | 把一次检索通过核对的 research 和所属需求编号按 runId 写进 `explore_research`；同一 runId 已有记录时报错 |
| `readExploreResearch`（新增） | 按 runId 读回并核对形状，没有记录返回 null |

### src/app/daemon/run-manager.ts（修改）

| 函数名 | 职责 |
|---|---|
| `exploreReport` | 只把返回类型改为 `ExploreReport`，内容不变（主窗口经 `explore.result` 拿到的完整报告不变） |
| `finishExplore` | PM 分支：research 非空时先用 `saveExploreResearch` 写记录（需求编号取该检索运行记录的 `requirement`），写入失败不挡住送结果；再把 `exploreReportView(report, "pm")` 的 JSON 用 `parent.handle.prompt` 送给 PM；主窗口分支不改 |

### src/app/daemon/pm-tools.ts（修改）

| 函数名 | 职责 |
|---|---|
| `PM_ACTION_SHAPES` | 加 sources 形状 |
| `agentManageTool` | 说明加一句；`manage` 在授权核对之后、现有派工分支之前处理 sources，调 `pmExploreSources` |
| `pmExploreSources`（新增） | 用 `readExploreResearch` 按 runId 读记录；记录不存在或 `requirementId` 不是本 PM 租约的需求编号时按成品定义失败；否则返回包装后的来源视图 |

## 协作关系

- `dispatchExplore` 的 `onResearch` 收下通过核对的 research（不变）→ `finishExplore` → `saveExploreResearch`（data.db）→ `exploreReportView`（05 计划）→ PM 会话提示词。
- PM 调 sources → `agentManageTool.manage` → `pmExploreSources` → `readExploreResearch`（只读 data.db，不依赖 RunManager 内存，所以守护进程重启后结果不变）→ `exploreSourcesView`（05 计划）→ 01 计划的结果包装函数。
- 依赖 05 计划：`ExploreReport`、`exploreReportView`、`exploreSourcesView`、`CORE_TOOL_ACTIONS` 里的 `"sources"`（PM 授权由职责矩阵自动带上）。
- 04-subagent-tool-results 计划也改 `pm-tools.ts` 里 agent_manage 现有动作的结果包装（`pm-tools.ts:171`），先于本计划执行；本计划只加 sources 分支，不动那一行。
- 主窗口派的检索不写 `explore_research`（它没有运行记录，完整报告存在主会话消息 details 里，归 05 计划）。

## 验证方式

- 测试入口：`pnpm test`；包级入口 `RunManager.dispatchExplore`（用 `tests/helpers/run-manager-fixture.ts` 的 `createPmRunWorld` 起真实 PM 会话和受控模型，查 `w.provider.requests` 看 PM 收到什么）、`agentManageTool`（`src/app/daemon/pm-tools.ts`）、`saveExploreResearch`（`src/modules/explore/explore-session.ts`）、`loadRoleRules("pm")`。
- 测试输入：沿用 `explore-dispatch.test.ts` 的本地检索样例（工作区 README.md，research 含 1 条结论、1 条来源、检索范围 1 个路径）；联网用 `explore-web.test.ts` 的样例（来源 url 为 `http://wiki.intranet.local/vitest`，搜索词两个）；"重启后"用一个新建的 `agentManageTool` 实例，只给 `dataRoot`、`repoId`、`lease`（需求编号为样例需求）、`alive: () => true`，不经原 RunManager。
- 预期结果：见下面各项。
- [ ] PM 收到摘要：PM 派的检索交了结果后，PM 会话最后一条输入解析成 JSON 后正好有 05 计划成品定义里的 10 个键，`sourceCount` 等于来源条数，conclusions 含"登录模块在 src/auth"，`next` 等于本计划成品定义里 PM 那句原文。
- [ ] 摘要不含来源：这条输入里不出现来源的文件绝对路径、文件哈希、起止行，联网样例里不出现 `http://wiki.intranet.local/vitest`、搜索词、quote，也没有 `parent`、`format`、`searchedScope` 键。
- [ ] 取来源：同一检索结束后，用新建的 `agentManageTool` 调 `{ action: "sources", runId }`，返回 content 解析后等于 `{ runId, sources, searchedScope }`，sources 每条带宿主补上的绝对路径和与实际内容一致的文件哈希（替代原来在 PM 报告里断言哈希和路径的两条用例）；检索范围写 `src/` 的样例，searchedScope 里有 `${workspace}/src`。
- [ ] 重启后：上一条的工具实例与派出检索的 RunManager 没有共享内存，结果和在原守护进程里取到的逐字相同。
- [ ] 别的需求：用 `saveExploreResearch` 写一条 `requirementId` 为另一个 UUIDv7 的记录，PM 按它的 runId 调 sources，失败文字含"原因：本需求没有派出过这个编号的检索"；按一个从没派出过的 UUIDv7 调，失败文字相同。
- [ ] 没交结果：检索用完轮次没交结果时，PM 收到的输入与改前相同：含 `"kind":"explore-report"`、`turn_limit_reached`、reason、next、log，`research` 为 null；这次检索的 runId 调 sources 按"本需求没有派出过这个编号的检索"失败。
- [ ] 参数与授权：`{ action: "sources" }`、runId 不是 UUIDv7、多带 `taskId` 时按"参数不符合该动作的格式"失败；PM 会话已结束时 sources 按"本 PM 会话已结束、被停止或已被新 PM 取代"失败。
- [ ] 规矩原文：`loadRoleRules("pm")` 含成品定义里第 27 行的整行原文，含"要当依据时先按运行编号取来源核对"和"写进计划或任务"。
- [ ] 通信不变：`tests/daemon-protocol.test.ts` 不改仍通过，`PROTOCOL_VERSION` 仍为 8。
- [ ] 全量：`pnpm run typecheck`、`pnpm test`、`pnpm run test:integration`、`pnpm run test:installation` 全部通过；本计划改了 `role-rules/pm.md`，合并前按 AGENTS.md 加跑真实模型 P1–P22、M9-AC12 和 M9-AC2/AC3/AC11。

## 拿不准

- 新命名空间 `explore_research` 不改表结构，本计划判断不用升 data.db 版本号、不写迁移；AGENTS.md 写的是"数据格式变了就升数据库版本号"，加命名空间算不算，需要用户确认。
- 派出了、但没交结果的检索，取来源时也报"本需求没有派出过这个编号的检索"，字面上不准确。PRD 只定了这一种失败原因，本计划没有另加；要分开说（例如"这次检索没有交结果，没有来源可取"）需要用户决定。
- `explore_research` 记录在需求关闭后不删，每条不超过 32KB（research 输出上限）。要不要随需求关闭清理，PRD 没有写。
