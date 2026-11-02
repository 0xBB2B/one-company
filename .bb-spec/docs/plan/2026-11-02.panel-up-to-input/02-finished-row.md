---
name: finished-row
description: 光标选中的子代理跑完后留在面板最下面，步骤由窗口取一份存内存，光标移开后丢掉
---
# 已结束行

## 目标
光标选中的子代理跑完后，这一行留在面板最下面，按回车能看到全部步骤，光标移开后消失。

## 业务规则（来源：PRD 子文档 finished-row）
- 子代理行：面板上带转圈图标的行，包括执行行、审查代理行、PM 派出的检索行、原型设计行、主窗口检索行。已结束行：选中的子代理跑完后留下的那一行。
- 触发：焦点在面板、光标在子代理行上，这一行从新数据里消失，并且读到的步骤状态是 completed、failed、stopped、interrupted 之一。审查代理从运行中变成通过、打回后不能再选中，同样算消失。
- 位置：所有分组之后，分组标题"● 已结束（光标移开后消失）"，最多一条。
- 文字：`└─ <结果> · <标题> · ↻<轮数>[/<上限>] · <耗时>`；结果依次是"✓ 已完成""✗ 失败""✗ 已停止""✗ 已中断"；上限为空时只写"↻<轮数>"；耗时不随时间增加。
- 取结果期间显示 `└─ 读取中… · <标题>`，光标留在它上面，分组标题相同；这时按回车走普通打开方式。
- 光标在已结束行上，高亮和其他选中行一样。按回车打开步骤窗口，用存着的那一份，不向后台进程发请求，过多久都能看。
- 光标移开或焦点回输入框时，这一行消失，存的步骤丢掉。按 ↓ 光标不动。按 p 不发任何请求。
- 焦点不在面板、光标不在这一行，或者消失的是需求行、⚑ 事项行：按原规则处理，不读步骤。
- 读取报错，或读到 pausing、paused：这一行消失，光标落回原来的位置（超出时落到最后一行），不显示已结束分组。读取返回时这一行已被丢掉的，结果作废。
- 读到 queued、running：子代理还在收尾（设计师交稿后面板就去掉这一行，会话要过几秒才结束），这一行保持"读取中…"，约每秒再读一次，直到上面两种结果。光标移开后不再读。
- 同一运行又出现在运行行里：已结束行消失，光标落在运行行上。
- 只存在当前窗口内存里。不新增协议请求、事件和数据库内容，`PROTOCOL_VERSION` 不变。
- 已结束行算能选中的行，它是唯一一行时焦点留在面板。
- 决策理由：后台进程在子代理结束 60 秒后删除步骤（`src/modules/agents/run-steps.ts` 的 `ENDED_KEEP_MS`），所以窗口要在结束时取一份；把 60 秒改长没有依据，写数据库是用户否决过的方向。放在底部分组是因为插回任务列表要多处理一整组结束的情况。

## 涉及文件
- `src/modules/panel/pm-panel.ts` — 修改
- `src/modules/panel/pm-panel-extension.ts` — 修改
- `src/modules/panel/step-window.ts` — 修改
- `tests/pm-panel.test.ts` — 修改（`PmPanelOptions` 多了必填项；"消失后落到相邻行"的测试要给 `readSteps`）
- `tests/step-window.test.ts` — 修改

## 函数清单
### src/modules/panel/pm-panel.ts
| 函数名 | 职责 |
|---|---|
| `PmPanelOptions.readSteps`（新增必填项） | 读一个运行的步骤，返回 `RunStepsView` |
| `PmPanelOptions.openSteps`（目标新增可选 `view`） | 已结束行打开时带上存着的那一份 |
| `Row` 的 steps 分支（新增 `finished` 标记与 `view`） | 区分已结束行 |
| `PmPanel.replace` | 刷新后发现选中的子代理行消失时生成已结束行；同运行重新出现时丢掉它 |
| `PmPanel.settleFinished`（新增） | 处理读取结果：写入 `view`、继续等，或丢掉这一行并让光标落回原位 |
| `PmPanel.tick` | 已结束行还在等结果、没有读取在途时，每 5 次（约 1 秒）再读一次 |
| `PmPanel.rows` | 在最后追加已结束行 |
| `PmPanel.handleInput` | 回车时带上 `view`；光标移开已结束行时丢掉它 |
| `PmPanel.blur` | 焦点离开时丢掉已结束行 |
| `PmPanel.render` | 没有其他分组时也渲染，追加已结束分组 |
### src/modules/panel/pm-panel-extension.ts
| 函数名 | 职责 |
|---|---|
| `readSteps`（传给 `mountPmPanel` 的选项） | 用对应仓库的客户端调 `runs.steps`，没有客户端时报错 |
| `openSteps`（选项） | 把 `view` 传给 `openStepWindow` |
### src/modules/panel/step-window.ts
| 函数名 | 职责 |
|---|---|
| `OpenStepWindowOptions.view`（新增可选项） | 给了就直接显示，不向后台进程发请求 |
| `openStepWindow` | 有 `view` 时先 `win.apply(view)`，后续取数被 `win.finished()` 拦下 |

## 协作关系
`replace` → `options.readSteps` → 后台进程已有的 `runs.steps` 请求 → `settleFinished` → `requestRender`。回车 → `options.openSteps({ ..., view })` → `openStepWindow`。`step-window.ts` 已经引用 `pm-panel.ts`，所以 `pm-panel.ts` 只引用 `RunStepsView` 类型（来自 `../agents/run-steps.ts`），不引用 step-window。

## 验证方式
- 测试入口：`new PmPanel({ now, openItem, togglePause, openSteps, readSteps })` 的 `update`、`updateExplores`、`updatePrototypes`、`focus`、`blur`、`handleInput`、`render`、`hasRows`、`atFirstRow`；`readSteps(target)` 收到 `{ repoId, runId }`，返回 `Promise<RunStepsView>`。`openSteps(target)` 收到 `{ repoId, runId, title, view? }`。`openStepWindow({ ctx, clock, client, runId, title, view })`。
- 测试输入：现有测试里的面板数据；`RunStepsView` 形如 `{ state, reason?, turns, maxTurns, elapsedMs, steps }`。
- 预期结果：按下面逐项判断。
- [ ] AC-1：五种子代理行分别选中后从数据里消失、读到 completed → 出现已结束行。审查代理从 running 变成 clear → 出现已结束行，任务下"✓ reviewer 通过"还在。
- [ ] AC-2：有需求、原型设计、检索三组时已结束分组排最后，标题文字一致；全程最多一条。
- [ ] AC-3：四种状态的文字开头正确；`maxTurns` 为 12 写"↻12/12"，为 null 写"↻12"；`now` 增加 2 秒后耗时不变。
- [ ] AC-4：已结束行带选中背景色，其他行不带。
- [ ] AC-5：回车时 `openSteps` 收到 `view`；`openStepWindow` 给了 `view` 时 `client.call` 一次都没被调用，窗口显示全部步骤和"✓ 已完成"。
- [ ] AC-6：已结束行上 ↑ 后这一行消失，再 ↓ 回不到；唯一一行时经 `BottomDock` 按 ↑ 焦点 `editor`、`render` 返回空；↓ 光标不动。
- [ ] AC-7：已结束行上按 p，`togglePause` 没被调用。
- [ ] AC-8：`blur` 状态下或光标在别的行时子代理消失，`readSteps` 没被调用；光标在需求行、需求消失时也没被调用，光标落到相邻行。
- [ ] AC-9：`readSteps` 拒绝，或返回 pausing、paused → 这一行消失，光标落回原位，没有已结束分组。读取还没返回时光标移开，之后返回也不出现这一行。
- [ ] AC-10：`readSteps` 未返回时渲染"└─ 读取中… · <标题>"，光标在它上面；回车时 `openSteps` 收到的 `view` 是 undefined。`readSteps` 返回 running 后仍是这一行；调 `tick()` 5 次后再读一次，返回 completed 后变成已结束行，之后不再读；返回 running 后光标移开，再调 `tick()` 不再读；上一次读取未返回时调 `tick()` 不重复读。
- [ ] AC-11：已结束行存在时新数据里又有同一 `runId` → 分组消失，光标在运行行上。
- [ ] AC-12：`src/core/host/protocol.ts` 没有改动。
- [ ] AC-13：已结束行是唯一一行时 `hasRows()` 为真，经 `BottomDock` 按 Enter、p 后焦点仍是 `panel`。
