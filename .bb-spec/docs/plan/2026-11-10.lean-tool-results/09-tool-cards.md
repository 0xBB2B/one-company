---
name: 09-tool-cards
description: agent_manage、prototype、workflow_manage、git_deliver、project_manage、knowledge_query 和检索结果消息改成简短卡片
---
# 其余主窗口工具和检索结果消息的简短卡片

[依赖: card-renderer, lean-result-helper, main-tool-results, explore-main, knowledge-query]

## 目标

主窗口里 agent_manage（含取检索来源）、prototype、workflow_manage、git_deliver、project_manage、knowledge_query 六个工具的卡片，以及检索结果消息（customType `one-company.explore-result`）的卡片，都显示成"标题行 + 一两行摘要"，按展开键看完整内容，失败一行写原因。

## 业务规则（来源：PRD 03-summary-cards）

- 通用规则同 08-card-renderer：标题行是粗体动作名 + 两个空格 + muted 对象名；摘要第一项正文色（个别成功绿），之后每项前空两格、整项 muted、以"· "开头；收起最多 3 行、超宽截断加"…"；只用正文色、muted、success、error，不用 dim；没返回时只有标题行；展开后接"调用参数""完整结果"两段；失败时一行错误红"失败：<原因>"；卡片不碰发给模型的 content。这些都由 08 的 `toolCard` 做，本计划只给每个工具一张卡片表。
- "需求标签"是 08 的 `requirementLabel`（查到标题写标题，否则"需求 <前 8 位>"），"仓库标签"是 08 的 `repoLabel`（仓库目录名，窗口没就绪写"仓库 <前 8 位>"），"编号"指 `编号 <运行编号前 8 位>`。
- 摘要字段都取自 details（完整结果）：agent_manage、prototype、workflow_manage、git_deliver、project_manage 由 main-tool-results 改成完整结果，knowledge_query 由 knowledge-query 改成完整查询页，取检索来源和检索结果消息的 details 是守护进程交出的完整检索报告（explore-main）。
- 检索结果的标题写检索问题，但完整报告里没有问题（`src/app/daemon/run-manager.ts:255-260` 的 `exploreReport`），往报告里加字段要改窗口和守护进程之间的通信，PRD 非目标不许。所以派出检索的卡片在结果回来时，用 08 的 `noteExploreQuestion` 记下"运行编号 → 参数 question"；检索结果卡片用 `exploreLabel` 查，查不到写"编号 <前 8 位>"。会话重开时 pi 按会话顺序重画，派出卡片在检索结果之前，问题会重新记上。
- 检索结果消息由扩展自己的渲染器画，pi 不给它铺底色（`CustomMessageComponent.rebuild` 用了自定义渲染器就不加默认的 Box）。渲染器自己包一层 pi-tui 的 `Box`：左右边距用 pi 传来的 `outputPad`，上下各 1 行，底色 `customMessageBg`，和 pi 默认的消息卡片一样。

**agent_manage**（参数没有 request 外层；dispatch 按 action + role 认）

| 动作 | 动作名 | 对象名 | 收起时的摘要 |
|---|---|---|---|
| dispatch · explore | 派出检索 | 参数 question | `已派出  · 编号 {runId 前 8 位}  · 最多 {maxTurns} 轮`；同时登记 runId → question |
| dispatch · pm | 派出 PM | 需求标签（参数 requirementId） | `已派出  · 编号 {runId 前 8 位}` |
| 取检索来源（动作名 `sources`，以 explore-main 为准） | 检索来源 | 编号（参数 runId） | `取到 {research.sources 条数} 条来源  · 搜索词 {M} 个`；research.searchedScope.kind 为 web 时 M = queries 条数；为 local_file 时这一项写 `读过 {paths 条数} 个文件` |
| status | 查看运行 | 编号（参数 runId） | `{run.state}  · 第 {run.turns} 轮` |
| pause、resume、stop | 暂停运行、续接运行、停止运行 | 编号（参数 runId） | `{state}`，有 reason 时加 `  · {reason}` |
| message | 转话给 PM | 需求标签 | delivered 为 now：`已转给 PM`；为 after_resume：`PM 续接后转给它` |

运行状态的说法：queued 排队中、running 运行中、pausing 暂停中、paused 已暂停、completed 已完成、failed 失败、stopped 已停止、interrupted 已中断。

**检索结果消息**（message.details 是完整报告：kind、runId、outcome、turnsUsed、research，以及 note 或 reason、next、log）

| 情况 | 动作名 | 对象名 | 收起时的摘要 |
|---|---|---|---|
| research 不为 null | 检索结果 | `exploreLabel(runId)` | 第一行 `完成  · {turnsUsed} 轮  · 结论 {conclusions 条数} 条  · 来源 {sources 条数} 条`；第二行每项都是 muted 的"· "开头、项与项空两格：`没查到 {notFound 条数} 条`、`没核实 {unknown 条数} 条`、`网页没读全`（truncation.truncated 为真时；searchedScope.kind 为 local_file 时写`文件没读全`）、`编号 {runId 前 8 位}`；条数为 0 的项不写 |
| research 为 null | 检索结果 | 同上 | 一行错误红 `没有结果：{原因}`，原因是 reason 里第一个"："之后的部分（reason 由 `run-manager.ts:258` 拼成"未提交 research，没有可用结果：<原因>"） |

展开时只接空行、muted"完整结果"、完整报告的 2 空格缩进 JSON（含来源摘录 quote）。界面不显示结论正文。

**prototype**（参数 `{request:{action,…}}`）

| 动作 | 动作名 | 对象名 | 收起时的摘要 |
|---|---|---|---|
| designers | 列出原型设计师 | 无 | `{items 条数} 位设计师` |
| dispatch | 派出原型设计 | 参数 name | `已派出  · 第 {version} 版  · 编号 {runId 前 8 位}` |
| status | 原型状态 | 需求标签 | 每个原型一行 `{name}：{状态}`；超过 2 个时只写前 2 个，第 2 行末尾加 `  · 还有 {K} 个原型`；entries 为空写 `还没有原型` |
| confirm | 确认原型 | 参数 name | details 那句话原样（confirm、remove 的完整结果就是工具返回的那句话） |
| remove | 删除原型 | 参数 name | 同上 |

原型的状态按先后取第一条符合的：removed 为真 → `已从草稿移除`；inFlight.status 为 awaiting → `第 {inFlight.version} 版等你确认`；为 designing → `第 {inFlight.version} 版设计中`；有 draft → `第 {draft.version} 版已通过`；有 approved → `第 {approved.version} 版已随需求批准`；有 lastEnded → `第 {lastEnded.version} 版没交稿：{lastEnded.reason}`；都没有 → `还没交稿`。

**workflow_manage**（参数没有 request 外层；details 是 `{ result }`）

| 动作 | 动作名 | 对象名 | 收起时的摘要 |
|---|---|---|---|
| status | 需求流程 | 需求标签 | result.close.status：none `没在关闭`、closing `关闭中`、closed `已关闭` |
| delivery-check | 需求流程 | 需求标签 | result.deliverable 为真：success 色 `可以交付`；否则 `还不能交付  · {blockers 第 1 条}`，多于 1 条时再加 `  · 共 {N} 项` |
| close | 关闭需求 | 需求标签 | result.status 为 closed：success 色 `已关闭`；closing：`关闭中  · {result.next}`；rejected：`没关闭  · {result.next}` |

**git_deliver**（参数只有 repoId、requirementId，只有一种卡片）

| 动作名 | 对象名 | 收起时的摘要 |
|---|---|---|
| 交付 | 需求标签 | status 为 delivered：`{merge.state}  · {url}`，merge.state：merged 已合并、queued 已排队合并、review 等审查、failed 合并没成功；merged-locally：`已合进 {target}`；not-merged：`没合并  · {reason}`；cancelled：`已取消`；rejected：`没交付  · {reason}`；conflict：`有冲突  · {reason}` |

**project_manage**（参数 `{request:{action,…}}`；结果 status 为 blocked 的动作，摘要一律 `没办成  · {reason}`）

| 动作 | 动作名 | 对象名 | 收起时的摘要 |
|---|---|---|---|
| init（preview 不为 true）、refresh | 初始化项目索引、刷新项目索引 | 仓库标签 | `{状态}  · {files} 个文件  · 跳过 {skipped 条数} 个  · 有截断`；状态：ready、partial 完成，invalid 索引无效，cancelled 已取消；truncation.truncated 不为真时不写"有截断" |
| init（preview 为 true） | 预览项目索引 | 仓库标签 | `预览  · {files 条数} 个文件  · 跳过 {skipped 条数} 个` |
| status | 项目索引状态 | 仓库标签 | initialized 为假：`还没初始化`；否则 index.status：ready 就绪、building 建立中、partial 部分完成、invalid 无效、cancelled 已取消、interrupted 中断了 |
| workspace-prepare | 准备需求工作区 | 需求标签 | status 为 ready：第一行 `就绪  · 分支 {branch 去掉开头的 refs/heads/}`，第二行 muted 的 path |
| workspace-recycle | 回收需求工作区 | 需求标签 | recycled：`已回收` |
| recovery-check、backup、restore | 恢复核对、备份、恢复 | 仓库标签 | status：restart_ready、reconciled、completed 完成，needs_review 已恢复，待核对 |
| conventions-update | 更新项目规范 | 仓库标签 | status：written 已写入、unchanged 内容没变、cancelled 没写入、revise 你要修改 |

**knowledge_query**（参数 `{repoId, query}`，按 query.action 认）

| 动作 | 动作名 | 对象名 | 收起时的摘要 |
|---|---|---|---|
| exact | 查代码 | query.value | `找到 {facts 条数} 条  · {nextCursor 为 null 写已读完，否则还有下一页}` |
| search；facts（有 text） | 查代码 | `搜索「{query.text}」` | 同上 |
| facts（没有 text） | 查代码 | `项目事实` | 同上 |
| next | 查代码 | `下一页` | 同上 |

## 涉及文件

- 修改 `src/modules/explore/agent-manage-extension.ts`
- 修改 `src/modules/prototype/prototype-extension.ts`
- 修改 `src/modules/delivery/workflow-manage-extension.ts`
- 修改 `src/modules/delivery/git-delivery-extension.ts`
- 修改 `src/modules/project-index/project-manage-tool.ts`
- 修改 `src/modules/project-index/knowledge-query-tool.ts`
- 修改 `tests/helpers/fake-pi.ts`：`registerMessageRenderer` 现在是空函数，改成按 customType 记下渲染器，加 `messageRenderer(customType)` 取回
- 新建 `tests/main-tool-cards.test.ts`
- 新建 `tests/explore-result-card.test.ts`

## 函数清单

### src/modules/explore/agent-manage-extension.ts（修改）

| 函数名 | 职责 |
|---|---|
| `AGENT_CARDS`（新增常量） | agent_manage 的卡片表，按 action（dispatch 再按 role）认动作 |
| `RUN_STATE_TEXT`（新增常量） | 运行状态的中文说法 |
| `renderExploreResult`（新增） | 检索结果消息的渲染器：用 08 的 `cardHeader`、`summaryLine`、`CardText` 拼出标题行和摘要，展开时接完整报告，外面包一层 `Box`（边距 outputPad、上下 1 行、底色 customMessageBg） |
| `registerAgentManageTool` | 工具定义加上 `toolCard(AGENT_CARDS)` 的 renderCall、renderResult |
| `registerExploreDelivery` | 加 `pi.registerMessageRenderer("one-company.explore-result", renderExploreResult)` |

### src/modules/prototype/prototype-extension.ts（修改）

| 函数名 | 职责 |
|---|---|
| `PROTOTYPE_CARDS`（新增常量） | prototype 的卡片表 |
| `prototypeLine`（新增） | 一份原型的那一行：`{name}：{状态}`，状态按业务规则的先后取 |
| `prototypeExtension` | 注册 one_company_prototype 时加上 renderCall、renderResult |

### src/modules/delivery/workflow-manage-extension.ts（修改）

| 函数名 | 职责 |
|---|---|
| `WORKFLOW_CARDS`（新增常量） | workflow_manage 的卡片表 |
| `registerWorkflowManageTool` | 加上 renderCall、renderResult |

### src/modules/delivery/git-delivery-extension.ts（修改）

| 函数名 | 职责 |
|---|---|
| `DELIVER_CARDS`（新增常量） | git_deliver 的卡片表，只有一种卡片 |
| `registerGitDelivery` | 加上 renderCall、renderResult |

### src/modules/project-index/project-manage-tool.ts（修改）

| 函数名 | 职责 |
|---|---|
| `PROJECT_CARDS`（新增常量） | project_manage 的卡片表，init 再按 preview 分成两种 |
| `createProjectManageTool` | `tool` 加上 renderCall、renderResult |

### src/modules/project-index/knowledge-query-tool.ts（修改）

| 函数名 | 职责 |
|---|---|
| `KNOWLEDGE_CARDS`（新增常量） | knowledge_query 的卡片表 |
| `createKnowledgeQueryTool` | `tool` 加上 renderCall、renderResult |

## 协作关系

- 每个工具的卡片表 → 08 的 `toolCard`；`renderExploreResult` → 08 的 `cardHeader`、`summaryLine`、`CardText`、`exploreLabel` 和 pi-tui 的 `Box`。
- 派出检索卡片（`AGENT_CARDS` 的 dispatch · explore）写问题表，`renderExploreResult` 读问题表，两者都在 explore 模块，表在 core/host。
- 依赖方向都是 modules → core/host，不新增依赖，不改守护进程，不改通信。

## 验证方式

- 测试入口：`pnpm test tests/main-tool-cards.test.ts tests/explore-result-card.test.ts tests/explore-delivery.test.ts`。包级入口：
  1. 用 `tests/helpers/fake-pi.ts` 的假 pi 调 `registerAgentManageTool`、`registerWorkflowManageTool`、`registerGitDelivery`、`prototypeExtension`、`registerExploreDelivery`，从 `registeredTools()` 取工具、从 `messageRenderer("one-company.explore-result")` 取消息渲染器；
  2. `createProjectManageTool(...)` 的 `tool`、`createKnowledgeQueryTool({ client: () => undefined }).tool`。
- 测试输入：假主题、context 和渲染方式同 08-card-renderer 的验证方式（`fg` 打 `<kind>` 标记、`bold` 打 `<b>`、`bg` 原样返回，`render(80)` 后 `trimEnd()`）。消息渲染器的调用是 `renderer(message, { expanded, outputPad: 1, keyHint, keyText }, theme)`，输出外面有 Box 的上下空行和左右边距，断言前去掉空行、每行去掉首尾空格。details 按上面各表的字段造；检索报告用：runId `01a1bdf1-abe9-7aa8-a969-2a66887b6230`、outcome completed、turnsUsed 13，research 为联网结果，6 条结论、8 条来源（每条有 url、retrievedAt、quote）、searchedScope.queries 9 个、notFound 2 条、unknown 3 条、`truncation: { truncated: true, reasons: ["网页过长"] }`。仓库目录名的用例用 `vi.mock` 替换 `src/core/host/extension-lifecycle.ts` 的 `windowContext`，让它返回含 `{ repoId, path: "/x/one-company" }` 的 workspace。
- 预期结果与验证项：
- [ ] 每张表每一行用测试素材各渲染一次，摘要与表一致，例如：派出检索 `已派出  <muted>· 编号 01a1bdf1</>  <muted>· 最多 18 轮</>`；取检索来源 `取到 8 条来源  <muted>· 搜索词 9 个</>`，本地检索时最后一项是 `读过 N 个文件`；查看运行 `运行中  <muted>· 第 5 轮</>`；原型状态 `桌面接入工具安装配置原型：第 3 版等你确认`；初始化项目索引 `完成  <muted>· 166 个文件</>  <muted>· 跳过 11 个</>  <muted>· 有截断</>`，没截断时没有最后一项；准备需求工作区两行，第 2 行是 muted 的目录；关闭需求 `<success>已关闭</>`；查代码 search 的标题行 `<b>查代码</b>  <muted>搜索「approvalScope」</>`，摘要 `找到 12 条  <muted>· 已读完</>`；交付 `已合并  <muted>· https://github.com/acme/x/pull/12</>`。
- [ ] 检索结果收起：先渲染一次该 runId 的派出检索卡片（带结果），再渲染消息，得到 3 行：`<b>检索结果</b>  <muted>{问题}</>`、`完成  <muted>· 13 轮</>  <muted>· 结论 6 条</>  <muted>· 来源 8 条</>`、`<muted>· 没查到 2 条</>  <muted>· 没核实 3 条</>  <muted>· 网页没读全</>  <muted>· 编号 01a1bdf1</>`；不含任何一条结论正文。没先渲染派出卡片时标题行对象名是 `编号 01a1bdf1`。
- [ ] 检索计数为 0：notFound、unknown 为空、没截断时，第 2 行只有 `<muted>· 编号 01a1bdf1</>`。
- [ ] 检索没交结果：research 为 null、reason 为"未提交 research，没有可用结果：用完轮次上限仍没有提交结果"时，第 2 行是 `<error>没有结果：用完轮次上限仍没有提交结果</>`，共 2 行。
- [ ] 检索结果展开：`expanded: true` 时出现 `<muted>完整结果</>` 和来源的 quote 原文，没有"调用参数"；再以 `expanded: false` 渲染回到 3 行。
- [ ] 工具卡片展开：原型状态展开后出现"调用参数""完整结果"，完整结果里有 `"updatedAt"` 和各版本的 `"hash"`；初始化项目索引展开后有 skipped 的逐项清单。
- [ ] 进行中：每个工具只调 renderCall 时只有 1 行标题行，例如 `<b>初始化项目索引</b>  <muted>one-company</>`（mock 了 windowContext）、`<b>检索来源</b>  <muted>编号 01a1bdf1</>`。
- [ ] 失败：确认原型 isError，content 为"one_company_prototype 的 confirm 动作失败。\n原因：原型「桌面接入工具安装配置原型」没有待你确认的版本，当前第 3 版已通过\n建议：刷新后按看板当前状态操作"，第 2 行为 `<error>失败：原型「桌面接入工具安装配置原型」没有待你确认的版本，当前第 3 版已通过</>`，不含"建议"；取检索来源失败时第 2 行为 `<error>失败：本会话里没有这个编号的检索结果</>`。
- [ ] 行数与颜色：所有收起用例 `render(80)` 不超过 3 行（检索结果按去掉 Box 空行后算），原型状态 5 个原型时仍是 3 行且第 2 行以 `<muted>· 还有 3 个原型</>` 结尾；全部输出没有 `<dim>`。
- [ ] 发给模型的内容不变：每个用例渲染前深拷贝结果对象和消息对象，收起、展开、收起渲染后与拷贝深相等。
- [ ] pi 自带工具不受影响：`tests/explore-delivery.test.ts` 等现有用例不改也通过；假 pi 记下的消息渲染器只有 `one-company.explore-result` 这一个是本计划加的。
- [ ] 全量：`pnpm run typecheck`、`pnpm test`、`pnpm run test:integration`、`pnpm run test:installation` 全部通过。
- [ ] 界面对比：在样例项目里打开 pi 主窗口，走一遍派检索、改草稿、查原型状态、确认原型失败，用 `/prototype --compare` 和 `.bb-spec/.cache/ui-preview/2026-11-10.lean-tool-results.html` 逐项对比。

## 拿不准

- 预览页里"确认原型"成功写的是绿色"第 3 版已通过"，PRD 表写"工具返回的那句话"（实际是"用户已在窗口里作出决定，结果以程序记录为准"这类句子），本计划按 PRD 表。
- 预览页里"交付"失败是红色卡片；实际代码里推送被拒、有冲突是正常返回（status 为 rejected、conflict），卡片是成功底色，摘要写"没交付 · 原因"。只有抛错的情况才是红色失败卡片。
- 原型状态超过 2 个时怎么收进 2 行、各状态的说法、project_manage 其余动作和 knowledge_query facts / next 的对象名，PRD 没有写，是本计划补的。
- 检索结果的问题只能靠派出卡片登记；派出检索那次调用要是不在当前会话分支里，标题只能写编号。
