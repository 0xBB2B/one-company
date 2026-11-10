---
name: 03-main-tool-results
description: 主代理的 agent_manage、prototype、workflow_manage、git_deliver、project_manage 结果按 PRD 表精简，完整结果放 details
---
# 主代理工具结果只发模型用得上的字段

## 目标

主窗口里五个工具成功时，发给模型的 `content` 只留 PRD 表"保留"列的字段，`details` 是完整结果。这五个工具是 one_company_agent_manage、one_company_prototype、one_company_workflow_manage、one_company_git_deliver、one_company_project_manage。表里没列的动作，content 和改前逐字相同，details 也换成完整结果。

## 业务规则（来源：PRD）

来源子文档：`02-lean-tool-results`，「主代理的工具」表和约束 1–4。

| 工具 · 动作 | 发给模型（保留） | 只留在 details（移除） |
|---|---|---|
| agent_manage · dispatch | runId | maxTurns、fence |
| agent_manage · status | run.state、run.stateReason、run.turns、run.log | run 的其余字段、delivery |
| prototype · designers | items 的 name、description | items 的 source |
| prototype · status | entries 的 name、lastVersion、removed；draft、approved、inFlight 的 version、status、note、options、picked；lastOpinion；lastEnded.reason | requirementId、updatedAt、各版本的 hash、bytes、runId、agent、inFlight 的 file 外层 |
| workflow_manage · close | status、next、message、missing、pending、archive 的 status / reason / next | operationId、reason、archive 的 path |
| workflow_manage · delivery-check | deliverable、blockers | receiptId、各种哈希、codeHead、epoch、verificationIds、verdictIds |
| git_deliver | status、url、reason、next、target、merge 的 state / reason / next | head、provider、reused、rebasedAfterAcceptance、method、merge 的 method |
| project_manage · workspace-prepare、recycle | status、version、branch、path | baseCommit、operationId |
| project_manage · init、refresh | status、partial、files（数量）、skippedCount、diagnosticCount、truncation | skipped 清单、diagnostics 清单、budget、archives、generation、parsedFiles、symbols 等其余字段 |

- 约束 1：成功时 details 是完整结果（发给模型的字段加上移除的字段）。
- 约束 2：content 仍是 JSON，留下的字段名和取值与改前相同。
- 约束 3：表里没列的动作，content 不变。这些动作是：
  - agent_manage 的 pause、resume、stop、message；
  - prototype 的 dispatch、confirm、remove；
  - workflow_manage 的 status；
  - project_manage 的 status、init 加 preview、conventions-update、recovery-check、backup、restore。
- 约束 4：工具失败时报错文字不变。所有 `toolFailure` 分支一行不动。
- 怎么挑字段：表里列了保留字段的动作，content 只放保留字段，字段不存在就不写。表外字段只有"写给模型的下一步说明"（reason、next）照留，其余都去掉。依据是 AGENTS.md「产品设计原则 → 工具结果」的五样规则。
- inFlight 的 note、options、picked 在完整结果里放在 `inFlight.file` 下面。PRD 要去掉 file 外层，所以视图把这三项直接放在 inFlight 下；file 为 null 时不写这三项。
- 测试脚本 `tests/acceptance/helpers/user-driver.ts:48-57` 靠 workflow_manage 结果里的 `"status":"closed"` 判断需求已关闭，同时查 details 和 content。status 是保留字段，details 又是完整结果，所以这个脚本不用改。
- 窗口和守护进程之间的通信不变，不升协议版本号。精简只在主窗口工具包装结果时做。
- `agent-manage-extension.ts` 里的 `registerExploreDelivery`（检索结果消息），以及"按运行编号取检索来源"的新动作，由另一份计划负责。本计划只改 `registerAgentManageTool` 里现有动作的结果包装。

## 涉及文件

- 修改 `src/modules/explore/agent-manage-extension.ts`
- 修改 `src/modules/prototype/prototype-extension.ts`
- 修改 `src/modules/delivery/workflow-manage-extension.ts`
- 修改 `src/modules/delivery/git-delivery-extension.ts`
- 修改 `src/modules/project-index/project-manage-tool.ts`
- 新建 `tests/main-tool-results.test.ts`（agent_manage、workflow_manage）
- 修改 `tests/prototype-windows.test.ts`（designers、status 两条）
- 修改 `tests/git-delivery-extension.test.ts`
- 修改 `tests/project-manage-tool.test.ts`

## 函数清单

### src/modules/explore/agent-manage-extension.ts

| 函数名 | 职责 |
|---|---|
| `agentManageView`（新建，文件内） | 按动作挑字段。dispatch 只留 runId。status 只留 `run` 下的 state、stateReason、turns、log。其余动作原样返回 |
| `result`（删除） | 改用 `leanToolResult(value, agentManageView(action, value))` |
| `registerAgentManageTool`（修改） | 各分支成功时用上面的方式包装结果 |

### src/modules/prototype/prototype-extension.ts

| 函数名 | 职责 |
|---|---|
| `prototypeView`（新建，文件内） | designers 的每项只留 name、description。status 只留 entries，每项交给 `prototypeEntryView`。其余动作原样返回 |
| `prototypeEntryView`（新建，文件内） | 一份原型只留 name、lastVersion、removed、lastOpinion。lastEnded 只留 reason。draft、approved 只留 version、note、options、picked。inFlight 只留 version、status，再把 file 里的 note、options、picked 提上来。值为 null 的版本照写 null |
| `textResult`（删除） | 改用 `leanToolResult`。confirm、remove 两个动作完整结果和视图都是那句话 |

### src/modules/delivery/workflow-manage-extension.ts

| 函数名 | 职责 |
|---|---|
| `workflowManageView`（新建，文件内） | 守护进程返回 `{ result }`。close 时 result 只留 status、next、message、missing、pending，以及 archive 里的 status、reason、next（存在的项；不留 path）。delivery-check 时只留 deliverable、blockers。status 原样返回。外层 `result` 照留 |
| `result`（删除） | 改用 `leanToolResult(value, workflowManageView(request.action, value))` |

### src/modules/delivery/git-delivery-extension.ts

| 函数名 | 职责 |
|---|---|
| `gitDeliverView`（新建，文件内） | 只留 status、url、reason、next、target 中存在的项，以及 merge 里的 state、reason、next（存在的项；不留 method） |
| `result`（删除） | 改用 `leanToolResult(value, gitDeliverView(value))` |

### src/modules/project-index/project-manage-tool.ts

| 函数名 | 职责 |
|---|---|
| `projectManageView`（新建，文件内） | 按结果里的 action 挑字段。workspace-prepare、workspace-recycle 留 status、version、branch、path、reason、next 中存在的项。init、refresh 留 status、partial、files、truncation，再加 `skippedCount`（skipped 清单的条数）和 `diagnosticCount`（diagnostics 清单的条数）。其余 action（含 preview）原样返回 |
| `textResult`（修改） | 返回 `leanToolResult(value, projectManageView(value))`。`sanitizeResult` 的 32 KiB 截断照旧作用在完整结果上，所以条数是截断后清单的条数，截断情况由 truncation 说明 |

## 协作关系

- 依赖计划 `01-lean-result-helper` 的 `leanToolResult`（`src/core/exec/tool-result.ts`）。五个文件都是 `src/modules/*` 引用 `src/core/exec`，符合模块顺序。
- 视图函数都是纯函数，只读守护进程或服务已经返回的对象。不新增守护进程请求，不碰数据库，不新增依赖。
- 主窗口卡片（PRD 子文档 `03-summary-cards`）会读这里的 details 来画摘要和展开内容，所以 details 必须是完整结果。

## 验证方式

- 测试入口：
  1. `pnpm test tests/main-tool-results.test.ts tests/prototype-windows.test.ts tests/git-delivery-extension.test.ts tests/project-manage-tool.test.ts`，再跑 `pnpm run typecheck`。
  2. 公开入口：
     - `registerAgentManageTool`、`registerWorkflowManageTool`、`registerGitDelivery`：传一个记录 registerTool 的假 pi，和返回预设结果的假守护进程客户端。
     - `prototypeExtension`：用现有测试里的 harness。
     - `createProjectManageTool`：用现有测试里的假服务。
  3. 调注册到的工具的 `execute`。
- 测试输入（假守护进程或服务的返回）：
  1. agent_manage 派 explore：`agents.dispatchExplore` 返回 `{ runId, maxTurns: 30 }`。派 PM：`agents.dispatchPm` 返回 `{ runId, fence: 2 }`。
  2. agent_manage 的 status：`runs.get` 返回 `{ run: { id, kind, requirement, state: "running", stateReason: "x", stopCause: { reason: "main_agent" }, startedAt, updatedAt, turns: 3, usage, log: "/路径" } }`。主窗口检索返回 `{ run: { id, kind: "explore", state: "running", turns: 2, delivery: "…" } }`。
  3. agent_manage 的 pause：返回任意对象。
  4. workflow_manage 的 close，`workflow.manage` 依次返回：
     - `{ result: { status: "closed", operationId, reason: "completed", archive: { path, status: "archived" }, message: "…" } }`；
     - `{ result: { status: "rejected", missing: ["…"], next: "…" } }`；
     - `{ result: { status: "closing", operationId, pending: ["…"], next: "…" } }`。
  5. workflow_manage 的 delivery-check：返回 `{ result: 一份完整交付回执 }`，含 receiptId、codeHead、epoch、verificationIds、verdictIds、approvedPrdHash、inputHash、deliverable: false、blockers: ["…"]。status 动作返回 `{ result: { close: {…} } }`。
  6. prototype：
     - designers 返回两项，每项有 name、description、source；
     - status 返回一份真实形状的看板，`{ requirementId, updatedAt, entries }`，其中一份原型同时有 draft、approved、inFlight（file 不为 null）、lastOpinion、lastEnded；
     - confirm、remove 走现有用例。
  7. git_deliver：远程交付 mock 返回 `{ status: "delivered", head, provider, url, reused, rebasedAfterAcceptance, merge }`。拒绝时返回 `{ status: "rejected", reason, next }`。
  8. project_manage：
     - init、refresh：服务返回 2 个 skipped、3 条 diagnostics；
     - workspace-prepare：成功一次，再让 `WorkspaceManageService` 报错一次；
     - status、init 加 preview：原样走一遍。
- 预期结果（"content"指 `JSON.parse(content[0].text)`）：
  1. 派 explore、派 PM 的 content 都正好是 `{ runId }`。details 分别含 maxTurns、fence。
  2. status 的 content 正好是 `{ run: { state, stateReason, turns, log } }`，主窗口检索时正好是 `{ run: { state, turns } }`。details 含 id、usage、stopCause、delivery 等全部字段。
  3. pause 的 content 与 `JSON.stringify(返回值)` 逐字相同，details 等于返回值。
  4. close 三种情况的 content 依次是：
     - `{ result: { status: "closed", message, archive: { status: "archived" } } }`；归档卡住时为 `{ result: { status: "closed", message, archive: { status: "blocked", reason, next } } }`；
     - `{ result: { status: "rejected", missing, next } }`；
     - `{ result: { status: "closing", pending, next } }`。
     closed 时 content 文字里仍能匹配 `/"status":"closed"/`。details 含 operationId、reason、archive（含 path）。
  5. delivery-check 的 content 正好是 `{ result: { deliverable: false, blockers } }`，details 是完整回执。status 动作的 content 与改前逐字相同。
  6. prototype：
     - designers 的 content 是 `{ items: [{ name, description }, …] }`；
     - status 的 content 只有 entries，没有 requirementId、updatedAt，也没有任何 hash、bytes、runId、agent、file 键。inFlight 下直接有 note、options、picked。
     - 两个动作的 details 都等于守护进程原样返回的值。
     - confirm、remove 的 content 仍是那句话本身。
  7. git_deliver 的 delivered content 正好是 `{ status, url, merge: { state } }`（merge 失败时 merge 里还有 reason、next），rejected 正好是 `{ status, reason, next }`，conflict 正好是 `{ status, target, reason, next }`。content 仍是合法 JSON，details 是 mock 的完整返回。
  8. project_manage：
     - init、refresh 的 content 正好有 status、partial、files、`skippedCount: 2`、`diagnosticCount: 3`、truncation，没有 skipped、diagnostics、generation、budget、archives。details 仍有逐项清单（现有 details 断言照常通过）。
     - workspace-prepare 成功时 content 正好有 status、version、branch、path；报错时正好有 `status: "blocked"`、reason、next。
     - status 和 preview 的 content 与改前逐字相同。
- [ ] 表里每个动作的 content 包含"保留"列全部存在的字段，不含"移除"列任何字段；details 两列都有
- [ ] 保留字段的名字和取值与 details 里的同名字段相同
- [ ] 表外动作 content 与改前逐字相同，details 是完整结果
- [ ] 各工具失败时报错文字与改前相同（现有失败用例照常通过）
- [ ] 需求关闭后 content 仍能匹配 `"status":"closed"`
- [ ] `pnpm run typecheck` 通过，文件里不再有没人用的 `result` / `textResult`

## 与 PRD 不一致

1. workflow_manage 的结果外面还套着一层 `result`（`src/app/daemon/run-manager.ts:1848`，经 `src/modules/delivery/workflow-manage-extension.ts:41` 原样发出）。PRD 表直接写 status、deliverable。按约束 2（字段名不变），本计划保留外层 `result`。
2. delivery-check 的回执里还有 format、requirementId、repoId、workspaceId、branch、revision、checkRoundId、pendingRevision、suggestions、createdAt（`src/modules/delivery/workflow-close.ts:60-65`）。PRD 两列都没列这些字段，本计划一律移除。
3. workspace-prepare、recycle 失败时返回 `{ action, status: "blocked", reason, next }`（`src/modules/project-index/project-manage-tool.ts:798`）。PRD 保留列没列 reason、next，本计划照留（属于下一步说明）。action、requirementId 两列都没列，本计划移除。
4. prototype 看板 inFlight 里还有 designBase、designs（每个方案的 letter、hash、bytes，`src/modules/requirement/requirement-prototypes.ts:42-43`），PRD 两列都没列，本计划移除。lastEnded 按表只留 reason，不留 version。
5. project_manage 的 init 加 `preview: true` 时，结果的 action 是 preview（`project-manage-tool.ts:846`）。本计划把它当表外动作，content 不变。
6. 现有测试 `tests/prototype-windows.test.ts:384` 用的看板形状（`{ inFlight: [], draft: [], approved: [] }`）和真实的 `PrototypeBoard` 对不上，要换成真实形状再断言。
