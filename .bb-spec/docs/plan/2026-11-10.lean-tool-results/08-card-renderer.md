---
name: 08-card-renderer
description: 主窗口卡片的共用渲染（标题行、摘要、展开、失败一行原因），需求工具和交互工具的卡片先接上它
---
# 主窗口卡片共用渲染，需求工具与交互工具卡片

[依赖: lean-result-helper, main-tool-results, explore-main]

## 目标

主窗口里每个 one_company 工具的卡片都能用同一套共用渲染画成"标题行 + 一两行摘要"，按展开键看调用参数和完整结果，失败时一行红字写原因；本计划先让 `one_company_requirement_manage` 和 `one_company_user_interact`（提问以外的动作）用上它。

## 业务规则（来源：PRD 03-summary-cards）

卡片是 pi 主窗口对话流里一次工具调用占的那一块。展开键是 pi 的快捷键 `app.tools.expand`（默认 Ctrl+O），在收起和展开之间切换。工具卡片的底色由 pi 按状态铺：进行中灰、成功绿、失败红。

- 约束 2 标题行：粗体动作名 + 两个空格 + 次要灰（muted）色的对象名。对象名是需求时写需求标题；还没拿到标题时写"需求 <编号前 8 位>"，拿到后原地换成标题。没有对象名的卡片只写粗体动作名。
- 约束 3 摘要：多项信息时，第一项用正文色（个别用成功绿），之后每项前空两格，整项用 muted 色并以"· "开头，例如 `已保存  · 第 14 版`（预览页的写法）。运行编号只写前 8 位。
- 约束 4：收起时一张卡片最多 3 行（标题行 + 最多 2 行摘要），标题和摘要之间不空行（预览页如此；DESIGN.md「结果行：空一行后写正文」说的是提问卡片）。每行超出终端宽度时截断，末尾加"…"，不折行。
- 约束 5：卡片里的文字只用正文色（不另上色，和提问卡片一样）、muted、success、error，不用 dim。
- 约束 6：工具还没返回时卡片只有标题行。
- 约束 7：按展开键后，摘要下面依次是：空一行、muted"调用参数"、排好版的调用参数 JSON（参数外层的 `request` 去掉，只排里面那层）、空一行、muted"完整结果"、排好版的完整结果 JSON（即结果的 `details`，含没发给模型的字段，缩进 2 个空格）。展开部分按宽度折行。再按一次收起。
- 约束 8：失败时（pi 给的 `isError` 为真）卡片是标题行 + 一行错误红"失败：<原因>"。原因取报错文字里"原因："后面、"\n建议："前面那一段（报错文字由 `src/core/exec/tool-failure.ts:78-85` 的 `failureText` 拼成"X 失败。\n原因：…\n建议：…"）；报错文字里没有"原因："时（比如 pi 自己在执行前报的参数错误）取第一行。展开后是"调用参数"和"完整结果"两段，完整结果这段写完整报错文字原文。
- 约束 9：卡片只改显示，结果的 `content`（发给模型的内容）一个字不碰。
- 约束 1：「提问」卡片保持现样。现在提问卡片按 action 是 ask、ask-tech 认（`src/modules/interaction/user-interact-tool.ts:54-58`），purpose 为 user-confirmation（或不写）和 panel-item 的 ask、ask-tech 都是提问卡片，本计划不变；purpose 为 pm-intake 的 ask 不是提问窗口；pm-intake 各动作的"接手复核"卡片要等它的完整结果放进 details，和主代理需求工具的精简一起放到后一批计划，本计划不做，pm-intake 各动作保持现在的默认显示。
- 卡片取数据：摘要从结果的 `details`（完整结果）取。requirement_manage 和 user_interact 的 user-confirmation、adjudicate 动作现在 `details` 就是完整结果（`main-requirement-interaction.ts:208,904`）。
- 需求标题从哪来：只有 create、updateDraft 的参数、read/next 的结果、list 的结果里有需求标题，其余卡片只有需求编号。共用渲染在本进程内存里记一张"需求编号 → 标题"表，渲染这几种卡片时登记；其余卡片按编号查表，查不到写"需求 <前 8 位>"。所有子扩展由同一个入口 `src/app/extension/index.ts` 加载，模块级的表在各工具之间是同一份。会话重开时 pi 按会话顺序重画卡片，表跟着重新登记。
- 原地换标题：结果回来后在 renderResult 里改 renderCall 已返回的那个标题组件的文字，不调 `invalidate()`。理由同提问卡片（`user-interact-tool.ts:81` 的注释）：在这里让 pi 重画整块会重入它正在进行的重画，块被加进去两份。

**requirement_manage 的卡片**（对象名里"需求标签"指按编号查标题表的结果；字段都取自 details）

| 动作 | 动作名 | 对象名 | 收起时的摘要 | 登记标题 |
|---|---|---|---|---|
| create | 新建需求 | 参数 title | `<状态>  · 第 {version} 版`；status：created 已创建、recovered 已续完 | details.requirementId → 参数 title |
| updateDraft | 修改需求草稿 | 参数 title | 同上；status：saved 已保存、unchanged 没有改动、recovered 已续完 | 参数 requirementId → 参数 title |
| read、next | 读需求 | 需求标签，结果回来后换成 details.title | `第 {version} 版  · 读了 {X} KB  · {已读完/还有下一页}`；X = (coverage.endByte − coverage.startByte) ÷ 1024，保留一位小数；coverage.nextCursor 为 null 写已读完，否则写还有下一页 | details.requirementId → details.title |
| diff | 对比需求修订 | 需求标签 | `第 {fromRevision} 版 → 第 {toRevision} 版  · {已读完/还有下一页}` | — |
| metadata | 需求状态 | 需求标签 | `{lifecycle}  · 第 {version} 版  · 还有 {K} 段没确认`；lifecycle：draft 草稿、active 已生效、closing 关闭中、closed 已关闭；K = approvalScope.summary.pending 的条数，没有 approvalScope 或 K 为 0 时不写这一项 | — |
| confirmUpdate | 确认更新 | 需求标签 | prdActivated 为 true：success 色"需求已生效"`  · 第 {version} 版`；否则 `没生效  · {blockedReason}`，没有 blockedReason 时只写"没生效" | — |
| list | 列出需求 | 参数有 repoId 写仓库标签，没有写"本窗口" | `{requirements 的条数} 个需求` | 每一项 requirementId → title |

**user_interact 的卡片**（参数是 `{request:{purpose,action,…}}`，purpose 不写时按 user-confirmation 算）

| purpose · action | 动作名 | 对象名 | 收起时的摘要 |
|---|---|---|---|
| user-confirmation、panel-item 的 ask、ask-tech | 提问 | 现样 | 现样 |
| user-confirmation · reply | 确认更新 | 需求标签 | 同 requirement_manage confirmUpdate |
| adjudicate · reply | 登记决定 | 需求标签 | status 为 recorded：`已登记  · {choice}`；choice：retry 再给一次机会、adjust 调整目标或范围、keep 保持不拆、terminate 终止任务、cancel 取消需求、reject 拒绝需求、accept 验收通过、rework 返工。status 为 unclear：`没登记  · {next}` |

仓库标签：在 `windowContext().workspace.repos`（`src/core/host/extension-lifecycle.ts:337`）里按 repoId 找到仓库就写它的目录名；窗口还没就绪（`windowContext` 抛错）或找不到时写"仓库 <repoId 前 8 位>"。

## 涉及文件

- 新建 `src/core/host/tool-card.ts`：共用渲染。放在 core/host 的理由：用到它的工具分散在 interaction、explore、prototype、delivery、project-index 五个模块，共用部分只能放在它们全都排在后面的一层；`tests/module-dependencies.test.ts` 的 `MODULE_DIRS` 里 core/host 排在所有 modules 前面，它本来就放着画在 pi 终端里的程序窗口和底部面板（`question-window.ts`、`dock.ts`），也已经引用 pi-tui；仓库标签要用的 `windowContext` 也在 core/host。
- 修改 `src/core/exec/tool-failure.ts`：加取原因的函数，和拼报错文字的 `failureText` 放在一处，格式和解析不分家。
- 修改 `src/modules/interaction/requirement-manage-tool.ts`
- 修改 `src/modules/interaction/user-interact-tool.ts`
- 新建 `tests/tool-card.test.ts`
- 新建 `tests/requirement-manage-cards.test.ts`
- 修改 `tests/user-interact-tool.test.ts`：用例"M8D-AC9：提问以外的动作不改显示，交给 pi 的默认样式"（:231-236）断言 reply 抛错、由 pi 退回默认显示，本需求改了这个行为，整条换成 reply、adjudicate 的卡片断言；pm-intake 的动作仍断言交给 pi 默认显示。

## 函数清单

### src/core/host/tool-card.ts（新建）

| 函数名 | 职责 |
|---|---|
| `CardTheme`（类型） | 卡片用到的主题方法：fg、bold、bg |
| `CardText`（类） | 卡片里的一块文字组件（pi-tui 的 Component）：收起部分每一行按宽度用 `truncateToWidth` 截断、省略号用"…"；展开部分按宽度用 `wrapTextWithAnsi` 折行；`setLines` 原地换掉收起部分的行 |
| `cardHeader` | 拼标题行文字：粗体动作名，有对象名时加两个空格和 muted 对象名 |
| `summaryLine` | 拼一行摘要：第一项原样，其余各项依次加两个空格和 muted 的"· <项>"；值为空的项跳过 |
| `expandedText` | 拼展开部分：空行、muted"调用参数"、参数 JSON（先用 `unwrapRequest` 去掉 request 外层）、空行、muted"完整结果"、完整结果（对象排成 2 空格缩进的 JSON，字符串原样） |
| `failureLine` | 错误红的"失败：<原因>"，原因用 `failureReason` 取 |
| `shortId` | 编号取前 8 位 |
| `noteRequirementTitle` | 往"需求编号 → 标题"表里登记一个标题 |
| `requirementLabel` | 按编号查标题表，查到写标题，查不到写"需求 <前 8 位>" |
| `noteExploreQuestion` | 往"运行编号 → 检索问题"表里登记一个问题（09-tool-cards 使用） |
| `exploreLabel` | 按运行编号查问题表，查不到写"编号 <前 8 位>"（09-tool-cards 使用） |
| `repoLabel` | 按 repoId 写仓库标签（规则见业务规则） |
| `toolCard` | 按一张卡片表生成一对 renderCall、renderResult。卡片表由工具给出：怎么从参数认出动作，以及每个动作的动作名、对象名（参数和结果回来后的 details 都能用）、摘要（1~2 行）、要登记的标题或问题。renderCall：用对象名拼标题行，放进 `CardText`，记在 `context.state` 里返回。renderResult：`isPartial` 为真时返回空的 `CardText`；失败时返回 `failureLine`（展开时接 `expandedText`，完整结果写报错原文）；成功时先登记标题或问题，再用 details 重算对象名，和标题行不同就对 state 里的标题组件 `setLines`（不调 invalidate），然后返回摘要行（展开时接 `expandedText`）。表里认不出的动作抛错，由 pi 退回默认显示（只有参数本身不合法时才会走到） |

### src/core/exec/tool-failure.ts（修改）

| 函数名 | 职责 |
|---|---|
| `failureReason`（新增） | 从报错文字里取"原因："之后、"\n建议："之前的那一段（原因里可以带"："和换行）；没有"原因："时取第一行 |

### src/modules/interaction/requirement-manage-tool.ts（修改）

| 函数名 | 职责 |
|---|---|
| `REQUIREMENT_CARDS`（新增常量） | requirement_manage 的卡片表，内容按业务规则第一张表 |
| `confirmSummary`（新增，导出） | 确认更新那一行摘要；requirement_manage confirmUpdate 和 user_interact reply 共用 |
| `createRequirementManageTool` | 返回的工具定义加上 `toolCard(REQUIREMENT_CARDS)` 生成的 renderCall、renderResult |

### src/modules/interaction/user-interact-tool.ts（修改）

| 函数名 | 职责 |
|---|---|
| `isAskCard`（新增） | 参数是不是提问卡片：action 为 ask 或 ask-tech，且 purpose 不是 pm-intake（pm-intake 本批保持默认显示） |
| `INTERACT_CARDS`（新增常量） | 提问以外各动作的卡片表，按 purpose:action 认动作，内容按业务规则第二张表；reply 用 `confirmSummary` |
| `askRequest` | 只在 `isAskCard` 为真时调用；第 53 行"只有提问改样式；其余动作抛错，由 pi 退回它的默认显示"这条注释已不成立，删掉 |
| `RenderTheme`（删除） | 改用 `CardTheme` |
| `createUserInteractTool` | renderCall、renderResult 按 `isAskCard` 分流：是提问卡片走原来的 `renderAskCall`、`renderAskResult`，否则走 `toolCard(INTERACT_CARDS)` |

## 协作关系

- 各工具的 renderCall / renderResult → `toolCard` → `cardHeader`、`summaryLine`、`expandedText`、`failureLine` → `CardText`；`failureLine` → `failureReason`（core/exec）；`repoLabel` → `windowContext`（core/host）。
- 依赖方向：modules/interaction → core/host → core/exec，符合 `MODULE_DIRS` 的顺序。只用已有依赖 `@earendil-works/pi-tui`（`truncateToWidth`、`wrapTextWithAnsi`、Component 接口），不新增依赖。
- 09-tool-cards 用本计划的 `toolCard`、`CardText`、`noteExploreQuestion`、`exploreLabel` 等画其余六个工具和检索结果消息。
- details 的形状由 lean-result-helper、main-tool-results 和 user_interact pm-intake 的精简改动决定；本计划只读 details，不改发给模型的 content。

## 验证方式

- 测试入口：`pnpm test tests/tool-card.test.ts tests/requirement-manage-cards.test.ts tests/user-interact-tool.test.ts tests/module-dependencies.test.ts`。包级入口：`createRequirementManageTool({ interaction: {} as never })`、`createUserInteractTool({ interaction: {} as never })` 返回的 `renderCall`、`renderResult`；`src/core/host/tool-card.ts` 的导出函数；`failureReason`。真实组件：`@earendil-works/pi-coding-agent` 的 `ToolExecutionComponent`（先 `initTheme("dark")`，写法同 `tests/user-interact-tool.test.ts:238-250`）。
- 测试输入：
  1. 假主题给颜色打标记：`fg: (k, t) => "<" + k + ">" + t + "</>"`、`bold: (t) => "<b>" + t + "</b>"`、`bg: (k, t) => t`。
  2. context：`{ args, state: {}, isError, expanded, isPartial, invalidate }`，同一个 state 先传 renderCall 再传 renderResult；renderResult 的第二个参数是 `{ expanded, isPartial }`。渲染结果 `render(80)`，每行 `trimEnd()`。
  3. 每个用例用不同的需求编号，免得标题表在用例之间串。需求编号例子 `01a1aaf0-9038-77ec-99a8-5a5580056de8`，标题例子"跨平台 Codex 桌面应用中台模型接入与更新工具"。
  4. details 按上面两张表的字段造，例如 updateDraft：`{ action: "updateDraft", operationId, requirementId, commit: "b81db5973f940277e660000ad15af8adb8c2631f", prdHash, status: "saved", archivePath, lifecycle: "draft", version: 14, epoch: 1, revision: 0 }`；read：`{ requirementId, title, version: 13, text, coverage: { startByte: 0, endByte: 2458, totalBytes: 2458, complete: true, nextCursor: null, blocking: [] } }`。
- 预期结果与验证项：
- [ ] 进行中：只调 renderCall，得到 1 行 `<b>修改需求草稿</b>  <muted>跨平台…工具</>`；renderResult 收到 `isPartial: true` 时渲染出 0 行。
- [ ] 两张表每一行各渲染一次，第 2 行与表一致，例如 updateDraft 为 `已保存  <muted>· 第 14 版</>`，read 为 `第 13 版  <muted>· 读了 2.4 KB</>  <muted>· 已读完</>`，metadata（pending 2 条）为 `草稿  <muted>· 第 8 版</>  <muted>· 还有 2 段没确认</>`、pending 为空时没有第三项，confirmUpdate 生效为 `<success>需求已生效</>  <muted>· 第 16 版</>`、没生效为 `没生效  <muted>· <blockedReason></>`，list 3 项且参数无 repoId 时标题行为 `<b>列出需求</b>  <muted>本窗口</>`、摘要 `3 个需求`，diff 有 nextCursor 时为 `第 2 版 → 第 3 版  <muted>· 还有下一页</>`；adjudicate、pm-intake 各状态同理。
- [ ] 标题原地换：用 `ToolExecutionComponent` 画一张 read 卡片，`updateResult` 前标题行含"需求 01a1aaf0"，之后标题行是需求标题，整块文字里标题只出现 1 次、"需求 01a1aaf0"不再出现；随后同一编号的 metadata 卡片 renderCall 直接显示标题。
- [ ] 展开：`expanded: true` 时摘要后依次是空行、`<muted>调用参数</>`、参数 JSON（第一行是 `{`，没有 `"request"` 键）、空行、`<muted>完整结果</>`、完整结果 JSON，其中有 `"commit": "b81db5973f940277e660000ad15af8adb8c2631f"`；再用 `expanded: false` 渲染回到 2 行。
- [ ] 失败：`isError: true`，content 为 `one_company_requirement_manage 的 confirmUpdate 动作失败。\n原因：草稿已经被改过，要确认的不是最新一版\n建议：重新读取需求后按最新版本再试`，渲染为 2 行，第 2 行 `<error>失败：草稿已经被改过，要确认的不是最新一版</>`，不含"建议"；展开后含完整报错原文。
- [ ] `failureReason`：原因里带"："时整段取出；原因跨两行时两行都取出；没有"原因："的文字取第一行。
- [ ] 行数：所有收起用例 `render(80)` 不超过 3 行；标题 200 字的卡片 `render(24)` 仍不超过 3 行，被截的行以"…"结尾、每行可见宽度不超过 24。
- [ ] 颜色：所有用例渲染出的文字里没有 `<dim>`，出现的颜色标记只有 muted、success、error（正文不打标记）。
- [ ] 发给模型的内容不变：渲染前深拷贝结果对象，依次以收起、展开、收起渲染，结果对象（含 content）与拷贝深相等；`ToolExecutionComponent` 上 `setExpanded(true)`、`setExpanded(false)` 前后同样。
- [ ] 提问卡片不变：`tests/user-interact-tool.test.ts` 里 M8D-AC9 的提问记录块、TB-28、TB-29 等现有提问用例不改也通过；purpose 为 panel-item 的 ask 仍渲染为 `<b>提问</b>` 开头的提问卡片；purpose 为 pm-intake 的 ask、forward、reply 仍交给 pi 默认显示（渲染函数抛错退回）。
- [ ] 仓库标签：窗口没启动时，list 带 repoId `4ba2e0aa…` 的标题行对象名为"仓库 4ba2e0aa"。
- [ ] 分层：`tests/module-dependencies.test.ts` 通过。
- [ ] 全量：`pnpm run typecheck`、`pnpm test`、`pnpm run test:integration`、`pnpm run test:installation` 全部通过。

## 拿不准

- create、updateDraft 的 unchanged、recovered，metadata 的 closing、closed，表里的说法是本计划补的，PRD 只写了已创建、已保存、草稿、已生效。
- 需求标题只在本进程内存里记；会话里第一次出现某个需求、又没有任何带标题的卡片时，这张卡片一直显示"需求 <前 8 位>"。
