---
name: 01-lean-result-helper
description: 新建共用小工具，把完整结果和发给模型的视图包成 pi 工具结果；子代理工具的公共包装接上它
---
# 共用的精简工具结果包装

## 目标

程序里任何一个 one_company 工具，只要给出"完整结果"和"发给模型的视图"两样，就能用同一个函数得到 pi 工具结果：`content` 是视图的 JSON 文字，`details` 是完整结果。子代理工具共用的包装 `toPiTool` 也改用它，从此子代理工具成功时 `details` 都是完整结果。

## 业务规则（来源：PRD）

来源子文档：`02-lean-tool-results`。

- pi 的工具结果分两部分：`content` 发给模型、进上下文；`details` 存进会话记录，界面和程序能用，不发给模型。
- 约束 1：主代理和子代理的 one_company 工具成功时，留存部分（`details`）是完整结果，包含发给模型的所有字段和被移除的字段。
- 约束 2：发给模型的内容仍是 JSON，字段名和取值与改前相同，只是少了字段。
- 约束 3（表里没列的动作）：发给模型的内容和改前一样。所以"视图就是完整结果本身"时，`content` 必须和改前逐字相同。
- 约束 4：工具失败时发给模型的报错文字不变。本计划只改成功分支，失败分支（`toolFailure` 抛错）一行不动。
- 原型工具的 confirm、remove 两个动作改前返回的是一句话（不是 JSON），`content` 是这句话本身；这两个动作不在精简表里，改后必须保持原样。所以视图是字符串时，`content` 直接放这句话，不再套一层 JSON 引号。
- 改前 `toPiTool` 遇到工具返回 `undefined` 时发 `null`（`src/modules/agents/role-tools.ts:44` 的 `JSON.stringify(result ?? null)`），改后保持这个行为。
- 项目规矩（AGENTS.md「产品设计原则 → 工具结果」）：发给模型的只留五样（要回填的编号和版本、提示词点名的字段、下一步说明、正文和回答、状态），其余放 `details`。本计划只提供包装手段，具体留哪些字段由各工具自己的视图函数决定（计划 02、03 及其他计划）。

## 涉及文件

- 新建 `src/core/exec/tool-result.ts`
- 修改 `src/modules/agents/role-tools.ts`
- 新建 `tests/tool-result.test.ts`

放在 `src/core/exec/` 的理由：同目录已有工具失败的共用处理 `tool-failure.ts` 和请求参数包装 `tool-request.ts`，都是"工具调用这一层"的小工具；`core/exec` 在模块顺序里排第 2（`tests/module-dependencies.test.ts` 的 `MODULE_DIRS`），所有功能模块和 `src/app` 都能引用它。新文件只做纯数据组装，不引用 pi 的类型，不新增依赖。

## 函数清单

### src/core/exec/tool-result.ts

| 函数名 | 职责 |
|---|---|
| `leanToolResult` | 收完整结果和视图，返回 `{ content: [{ type: "text", text }], details }`：视图是字符串时 text 就是这句话，否则 text 是视图的 JSON（视图为 `undefined` 时写 `null`）；details 是完整结果（为 `undefined` 时写 `null`） |

### src/modules/agents/role-tools.ts

| 函数名 | 职责 |
|---|---|
| `CoreToolRuntime`（接口，修改） | 增加一个可选的 `view`：拿到工具的完整结果和这次的调用参数，返回发给模型的视图；不给时视图就是完整结果。传调用参数是为了让视图按动作（如 `params.action`）选字段，不用从结果的长相去猜是哪个动作 |
| `toPiTool`（修改） | 成功分支改用 `leanToolResult(完整结果, view ? view(完整结果, 调用参数) : 完整结果)`；失败分支保持原样 |

## 协作关系

- `leanToolResult` 不调用任何其他函数，不碰数据库、文件或网络。
- `toPiTool` 被 `src/app/daemon/run-manager.ts`、`src/app/daemon/pm-tools.ts`、`src/modules/pm/subagent-tools.ts` 用来包装子代理工具。本计划不给它们传 `view`，所以这些工具发给模型的内容和改前逐字相同，只是 `details` 从 `{}` 变成完整结果。
- 后续计划怎么接：
  - 计划 02（知识查询）在守护进程的 `knowledge_query` 包装上传 `view`。
  - 计划 03（主代理工具）在各主窗口工具里直接调 `leanToolResult`。
  - 子代理其他工具的精简由另外的计划在各自的 `toPiTool` 调用处传 `view`。
- `src/app/daemon/run-manager.ts:1182` 联网工具的 `reply`、`src/modules/pm/pm-commit.ts:81` 等不经 `toPiTool` 的工具，留给负责子代理工具的计划改，本计划不碰。

## 验证方式

- 测试入口：
  1. `pnpm test tests/tool-result.test.ts`，直接调用 `src/core/exec/tool-result.ts` 导出的 `leanToolResult`。
  2. 调 `src/modules/agents/role-tools.ts` 导出的 `toPiTool` 生成工具，再调它的 `execute("t", params)`。
  3. 回归：`pnpm test tests/tool-failure.test.ts tests/agent-session.test.ts`、`pnpm run typecheck`。
- 测试输入：
  1. `leanToolResult({ runId: "r1", fence: 3 }, { runId: "r1" })`。
  2. `leanToolResult("用户选择保留，没有移除", "用户选择保留，没有移除")`。
  3. `leanToolResult(undefined, undefined)`。
  4. `toPiTool("plan_manage", "计划", Type.Object({}), { execute: () => ({ a: 1, hash: "x" }), view: (r, p) => ({ a: (r as { a: number }).a, action: (p as { action?: string }).action ?? null }), dispose() {} })`，用参数 `{ action: "read" }` 执行一次。
  5. 同上，但不传 `view`。
  6. 同上，`execute` 返回 `undefined`、不传 `view`。
- 预期结果：
  1. `content` 只有一项：`{ type: "text", text: '{"runId":"r1"}' }`，`details` 深等于 `{ runId: "r1", fence: 3 }`。
  2. `content[0].text` 恰好是 `用户选择保留，没有移除`（没有外层引号），`details` 是同一句话。
  3. `content[0].text` 是 `null`，`details` 是 `null`。
  4. `content[0].text` 是 `{"a":1,"action":"read"}`（视图拿到了调用参数），`details` 深等于 `{ a: 1, hash: "x" }`。
  5. `content[0].text` 逐字等于 `JSON.stringify({ a: 1, hash: "x" })`，`details` 深等于完整结果。
  6. `content[0].text` 是 `null`。
- [ ] 视图和完整结果不同时，content 只含视图字段，details 含全部字段
- [ ] view 能拿到这次的调用参数
- [ ] 视图是字符串时 content 就是这句话本身
- [ ] 不传 view 时 toPiTool 发给模型的文字和改前逐字相同，details 变成完整结果
- [ ] 工具返回 undefined 时 content 写 null
- [ ] `tests/tool-failure.test.ts` 里核心工具抛错时的三段报错文字测试照常通过（失败分支不变）
- [ ] `pnpm run typecheck` 通过；`tests/module-dependencies.test.ts` 通过（引用 `core/exec` 的都是排在它上面的模块）
