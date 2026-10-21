---
name: panel-tree-render
description: 状态面板按任务行和审查代理行画成树，任务级待处理事项画在任务行上，选中顺序与画出顺序一致
---
# 面板树状显示

## 目标
状态面板上并行的每个任务、每个审查代理各占一行；等用户处理的任务行能被选中并打开决策包。

## 业务规则（来源：PRD status-panel-parallel）
- `taskRows` 不为空时，需求行下面直接列任务行，不写汇总行，也不写 PM 在做什么那一行；用 ├ / └ 连线，审查代理行再缩进一层，用 │ ├ └ 连线。
- 任务行写法：
  - 执行：「⠹ <任务号> 执行 · <定义名>（第 <N> 次尝试）· ↻<已用>/<上限> · <用时>」
  - 审查：「<任务号> 第 <N> 轮审查」
  - 待处理：「⚑ <任务号> <事项短文字>」
  - 检索：「⠹ explore 检索 · ↻<已用>/<上限> · <用时>」
- 审查代理行写法：在跑「⠹ <名> · ↻<已用>/<上限> · <用时>」；通过「✓ <名> 通过 · ↻…」（✓ 绿、其余灰）；打回「✗ <名> 打回 · ↻…」；没交出结论「– <名> 没交出结论 · ↻…」（灰）；跳过「– <名> 已关闭，本轮未审」或「– <名> 已不存在，本轮未审」（黄）；上一轮已通过「✓ <名> 上一轮已通过」（整行灰）。
- 上限未知（`maxTurns` 为 null）时写「↻<已用>」。在跑的行用时按"概览里的用时 + (现在 − 拿到概览的时刻)"计算，和现有检索行一样。
- `taskRows` 为空时照现在显示 PM 在做什么那一行和全部待处理事项。有任务行时，需求级待处理事项（没有 taskKey 的）以「⚑ <事项文字>」排在任务行之后。
- 需求行图标规则不变：没有子代理在跑、PM 也停下、有待处理事项时是 ⏸，否则转圈。
- 可选中的行只有需求行和以 ⚑ 开头的行；↑↓ 的顺序和画出的顺序一致：需求行 → 任务级 ⚑ 行（按任务行顺序）→ 需求级 ⚑ 行。选中 ⚑ 行按 Enter 打开决策包，p 暂停或恢复 PM。
- 每一行按终端宽度截断，不换行。
- 已确认的界面预览：`.bb-spec/.cache/ui-preview/stack-agents-settings.html` 的 ⑦～⑭ 号画面，实现后逐项对照。

## 涉及文件
- 修改 `src/modules/panel/pm-panel.ts`
- 修改 `tests/pm-panel.test.ts`（:11-14 的 `overview(patch)` 默认值加 `taskRows: []`）

## 函数清单
### src/modules/panel/pm-panel.ts
| 函数名 | 职责 |
|---|---|
| `render`（改） | 每个需求：需求行之后，`taskRows` 非空时画任务树，否则画现有的 doing 行和事项行 |
| `taskLines` | 把一个需求的 `taskRows` 画成行（含连线、图标、颜色），并标出哪些行对应可选中的事项 |
| `reviewerLine` | 画一个审查代理行，按状态选符号和颜色（success、warning、dim） |
| `runSuffix` | 生成「· ↻<已用>/<上限> · <用时>」后缀 |
| `rows`（改） | 可选中行的顺序：pm 行 → 任务级事项（按任务行顺序）→ 需求级事项 |
| `rowKey`、`update`、`handleInput`、`mark`、`fit` | 不改 |

## 协作关系
依赖"概览里的任务行数据"计划的 `PmOverview.taskRows`、`PendingItem.taskKey / taskText`。窗口由 `pm-panel-extension.ts` 拉取概览后交给 `PmPanel.update`，不改。

## 验证方式
- 测试入口：`tests/pm-panel.test.ts` 的 `overview(patch)`、`panel(now)`，`render(width)` 取行；颜色用一个记录 `fg(kind, text)` 调用的假主题（`setTheme`）断言
- 预期结果：
  - taskRows 只有 T3 执行（go-worker、第 1 次、8/20、3m2s）→ 需求行下一行是「     └ ⠹ T3 执行 · go-worker（第 1 次尝试）· ↻8/20 · 3m2s」，没有 doing 行
  - T1 第 1 轮审查（reviewer、go-reviewer 在跑，vue-reviewer clear）+ T2 执行 → 行依次为「├ T1 第 1 轮审查」「│ ├ ⠹ reviewer …」「│ ├ ⠹ go-reviewer …」「│ └ ✓ vue-reviewer 通过 …」「└ ⠹ T2 执行 …」
  - 审查代理 blocked 行以「✗」开头含「打回」；skipped_disabled 行为「– go-reviewer 已关闭，本轮未审」且用 warning 色；passed_earlier 行为「✓ vue-reviewer 上一轮已通过」且整行 dim
  - T1 pending + T2 执行，聚焦后按 ↓ 选中 T1 那一行，按 Enter → `openItem` 收到 T1 那条事项的 itemId；再按 ↓ 不会选中 T2 行
  - taskRows 为空、doing 为「等待核对接手理解」、有一条需求级事项 → 和现在显示一致（「└ 等待核对接手理解」下面一行「└ ⚑ 待核对：PM 接手理解 r2」）
  - 40 列宽时所有行 `visibleWidth` ≤ 40
- [ ] 与预览 ⑦～⑭ 逐项对照一致
