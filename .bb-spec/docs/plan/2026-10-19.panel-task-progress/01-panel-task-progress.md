---
name: panel-task-progress
description: PM 概览新增任务进度（已完成数/总数），状态面板第一行在目标后面显示"任务 X/N"
---
# 状态面板第一行显示任务进度

## 目标
守护进程算出的 PM 概览带上任务进度，状态面板每个需求的第一行在目标后面显示"任务 已完成数/总数"。

## 业务规则（来源：PRD task-progress）
状态面板：pi 主窗口输入栏下方的区域，每个运行中的需求占一组行。第一行现在是 `<分支> <图标> <目标> · ↻<轮数> · <工具调用次数> tool uses · <token> token<缓存命中率> · <耗时>`。任务：PM 计划里派给子代理做的事，角色有 worker、explore、qa 三种。

- C-1：计划里至少有 1 个没取消的任务时，第一行在目标后面、"↻轮数"前面加一段"任务 X/N"，前后各用" · "隔开：`<分支> <图标> <目标> · 任务 X/N · ↻<轮数> · …`。
- C-2：N = 计划里状态不是 `cancelled` 的任务个数，worker、explore、qa 都算；X = 其中状态为 `completed` 的个数。`awaiting_review`、`reviewing`、`awaiting_rework`、`needs_update`、`awaiting_user` 等其他状态都不算进 X。
- C-3：还没有计划，或计划里的任务全部是 `cancelled` 时，第一行没有"任务"这一段，和改动前逐字一样。
- C-4：只要满足 C-1，PM 不管是在跑（running）、暂停中（pausing）、已暂停（paused）还是等待决定（waiting），也不管计划确认了没有（`plan.confirmedVersion` 为 null 也算），都显示。
- C-5：每次计算概览都按当前计划重新算。概览变化时守护进程已有的指纹比较会广播 `pm.overview.changed`，任务进度作为概览字段自动参与，不另加刷新机制。
- 决策理由：PM 会同时派多个任务，"第几个"没有唯一答案，所以显示完成数和总数；总数和第二行"规划中（计划 vN · M 个任务）"里的 M 用同一个口径（非 cancelled）。用户 2026-10-19 决定。
- 窄终端截断方式不改：整行照旧交给现有的截断逻辑，从行尾截断加"…"。

## 涉及文件
- `src/modules/panel/pm-overview.ts` 修改
- `src/modules/panel/pm-panel.ts` 修改
- `tests/pm-overview.test.ts` 修改
- `tests/pm-panel.test.ts` 修改

## 函数清单
### src/modules/panel/pm-overview.ts
| 函数名 / 类型 | 职责 |
|---|---|
| `PmOverview`（接口） | 新增字段 `taskProgress`：有非 cancelled 任务时为 `{ completed, total }`，否则为 `null` |
| `taskProgressOf`（新增，模块内） | 按 C-2、C-3 从计划任务列表算出 `taskProgress` |
| `pmOverview` | 用已读到的 `plan?.tasks` 调 `taskProgressOf`，把结果放进返回的概览 |

### src/modules/panel/pm-panel.ts
| 函数名 | 职责 |
|---|---|
| `PmPanel.render` | 拼第一行时，`taskProgress` 不为 null 就在目标后插入 ` · 任务 X/N`；为 null 时第一行和现在逐字一样 |

## 协作关系
- `RunManager.overviewOf`（`src/app/daemon/run-manager.ts`）调 `pmOverview` → `pmOverview` 内部调 `taskProgressOf`。
- `RunManager.refreshOverview` 把概览去掉 `elapsedMs` 后整体做指纹，`taskProgress` 变化会触发 `pm.overview.changed`，主窗口的 `pm-panel-extension.ts` 收到后重新拉概览、调 `PmPanel.update`。这两处不改。
- 无数据库表、无外部接口改动，无新增第三方依赖。

## 验证方式
- 测试入口一（面板渲染）：`new PmPanel({ now, openItem, togglePause })` → `update([{ repoId, overview, fetchedAt }])` → `render(width)`；`overview` 是 `PmOverview` 对象，新增字段 `taskProgress: { completed: number; total: number } | null`。
- 测试入口二（概览计算）：`tests/helpers/run-manager-fixture.ts` 的 `createPmRunWorld` 建出的世界里，用 `w.plan.execute({ action: "propose" | "confirm" | ... })` 建计划、`w.manager.dispatchTask` 派任务，再读 `(await w.manager.overviews())[0].taskProgress`。任务状态也可直接改 `TASKS` 表里对应行来构造（参照该测试文件现有写法）。
- 预期结果：
- [ ] AC-1：`render(120)`，概览 `goals: ["角色跳跃"]`、`taskProgress: { completed: 3, total: 8 }`、轮数 5、工具 5 次、token 33_800、命中率 0.62、耗时 12_300ms、状态 running → 第一行恰为 `└─ ⠋ 角色跳跃 · 任务 3/8 · ↻5 · 5 tool uses · 33.8k token (62%) · 12.3s`。
- [ ] AC-1/C-2：计划 8 个任务，其中 1 个 explore、2 个 worker 为 completed，1 个 worker 为 awaiting_review，其余 pending → `taskProgress` 为 `{ completed: 3, total: 8 }`。
- [ ] AC-2：计划 5 个任务，1 个 completed、2 个 cancelled、2 个 pending → `{ completed: 1, total: 3 }`。
- [ ] AC-3：计划 3 个任务，状态分别为 reviewing、awaiting_rework、needs_update → `{ completed: 0, total: 3 }`。
- [ ] AC-4：PM 还没提计划 → `taskProgress` 为 `null`；`render` 的第一行不含"任务"二字，与改动前格式一致（`├─ ⠋ 角色跳跃、跳跃动画 · ↻5 · 5 tool uses · 33.8k token (62%) · 12.3s`）。
- [ ] AC-5：计划里任务全部 cancelled → `taskProgress` 为 `null`，第一行不含"任务"二字。
- [ ] AC-6：`taskProgress: { completed: 2, total: 4 }`，status 分别为 running、pausing、paused、waiting 时，第一行都含 ` · 任务 2/4 · ↻`；propose 了 3 个任务但没 confirm 时，概览 `taskProgress` 为 `{ completed: 0, total: 3 }`。
- [ ] AC-7：同一需求先 1 个 completed、共 3 个 → `{ completed: 1, total: 3 }`；第 2 个改成 completed 后重新取概览 → `{ completed: 2, total: 3 }`；再把一个 completed 改成 needs_update 后重新取 → `{ completed: 1, total: 3 }`。
- [ ] 窄屏：`render(20)` 每行可见宽度 ≤ 20（现有测试保持通过）。
- [ ] `pnpm run typecheck`、`pnpm test` 全部通过。
