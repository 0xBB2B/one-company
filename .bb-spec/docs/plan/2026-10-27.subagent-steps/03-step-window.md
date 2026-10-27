---
name: step-window
description: 步骤窗口：按 runs.steps 的结果画出标题、状态行和全部步骤，定时刷新，支持滚动、自动跟到底和各种状态
---
# 步骤窗口

## 目标
给一个运行编号和标题，弹出程序窗口，实时显示这个子代理的全部步骤；Esc 关闭后焦点回到打开前的地方。

## 业务规则（来源：PRD step-window）
- 布局（80 列例子）：
  ```
  ╭──────────────────────────────────────────────────────────────────────────────
  │ T2 执行 · worker（第 1 次尝试）
  │ ⠹ 运行中 · 共 13 步 · ↻9/40 · 3m05s
  ├──────────────────────────────────────────────────────────────────────────────
  │ ✓ 读计划
  │ ✗ 跑命令 pnpm vitest run src/modules/order/export.test.ts
  │ ⠹ 写入 src/modules/order/export.ts
  ├──────────────────────────────────────────────────────────────────────────────
  │ ↑↓ 滚动 · Esc 关闭
  ╰──────────────────────────────────────────────────────────────────────────────
  ```
  横线铺满窗口宽度，左边框后空一格写内容，每行（含边框）不超过窗口宽度，超出从行尾截断加"…"。
- 标题由打开方传入，原样显示（加粗）。
- 状态行：`<图标> <状态> · 共 N 步 · ↻<轮数>/<上限> · <耗时>`，没有上限时只写 `↻<轮数>`；耗时格式与面板相同（`formatElapsed`）。queued、running：转圈图标 + "运行中"，耗时 = 返回值 + 本地距上次取数的时间；pausing、paused：黄色"⏸ 已暂停"；completed：绿色"✓ 已完成"；failed：红色"✗ 失败：<reason>"；stopped：红色"✗ 已停止"；interrupted：红色"✗ 已中断"。只有 queued、running 时耗时增加。
- N 是步骤列表的长度（含正在做的和 codemode 下的），不含"思考中"。
- 步骤行：done 绿色 ✓；error 红色 ✗；running 时看整体状态：queued/running 转圈图标，pausing/paused 黄色 ⏸，已结束（completed、failed、stopped、interrupted）红色 ✗。
- 整体状态为 queued 或 running、且没有 running 的步骤时，最后多一行转圈图标 + 灰色"思考中"。
- 有 parentId 的步骤缩进两格，按先后排在父步骤后面；父步骤不在列表里时按普通步骤排。
- 转圈图标与面板同一组字符，每 200 毫秒换一帧；每 500 毫秒向守护进程取一次数（上一次没回来时跳过），保证变化 1 秒内显示；收到已结束的状态后停止取数，窗口保留最后的内容。
- 步骤区能显示的行数 = 终端行数 − 8，至少 3 行。步骤（含"思考中"）多于这个数时：上面有被盖住的，第一行写灰色"↑ 上面还有 N 步"；下面有被盖住的，最后一行写灰色"↓ 下面还有 M 步"；这两行占步骤区的行数。↑↓ 每次滚一行。
- 打开时显示在最底下；在最底下时新步骤自动滚到最新；往上翻过之后新步骤不让窗口跳，只更新"下面还有"的数字；翻回最底下后恢复自动跟随。
- 还没拿到数据：状态行灰色"读取中…"，步骤区空，底部"Esc 关闭"。
- 取数失败（守护进程断开、返回 not_found 等）：状态行红色"✗ 读不到步骤：<错误说明>"，步骤区一行"守护进程重启后，之前的步骤就没有了。"，底部"Esc 关闭"，停止取数。已经拿到过结束状态后不再取数，所以不会被这条覆盖。
- 有数据时底部"↑↓ 滚动 · Esc 关闭"。Esc 关闭窗口，焦点回到打开前（面板）。
- 参数文字已由守护进程清洗过；窗口再按面板 `fit` 的方式去掉控制字符后截断，不信任返回内容。

## 涉及文件
- 新建 `src/modules/panel/step-window.ts`
- 修改 `src/modules/panel/pm-panel.ts`（导出转圈字符组 `SPINNER`，供步骤窗口共用）

## 函数清单
### src/modules/panel/step-window.ts
| 函数名 | 职责 |
|---|---|
| `StepWindow`（类） | 窗口本体：保存最近一次取到的 `RunStepsView`、取数时间、错误、滚动位置、是否跟随到底、动画帧 |
| `StepWindow.apply` | 收下一次取数结果：更新数据和取数时间；在跟随状态时把滚动位置放到最底下 |
| `StepWindow.fail` | 收下取数失败的说明，进入"读不到步骤"状态 |
| `StepWindow.finished` | 当前数据是否已是结束状态（或已失败），供外层决定停止取数 |
| `StepWindow.tick` | 动画前进一帧 |
| `StepWindow.resize` | 记下终端行数，算出步骤区高度 |
| `StepWindow.handleInput` | ↑↓ 滚动并维护是否跟随；Esc 调用关闭回调 |
| `StepWindow.render` | 按上面的规则画出整个窗口 |
| `orderedSteps` | 把扁平步骤列表排成显示顺序并标出缩进 |
| `openStepWindow` | 用 `openProgramWindow`（`overlay: false`）打开窗口：标记底部区块有页面打开、按终端尺寸 resize、起 200 毫秒动画和 500 毫秒取数两个定时器（用传入的 clock 的 `setIntervalExcludingSleep`），关闭时清掉定时器并标记页面关闭 |

## 协作关系
- `openStepWindow` 的入参：窗口宿主（pi 的 ctx）、底部区块（`BottomDock`，用 `markPageOpen` / `markPageClosed`）、clock、守护进程客户端（有 `call(method, params)`）、运行编号、标题、主题。
- 取数调用 `runs.steps`（02 计划），结果类型 `RunStepsView` 来自 `src/modules/agents/run-steps.ts`（01 计划）。
- 打开方式照 `src/modules/shell/shell-page.ts` 的 `openShellPage`；面板（04 计划）在子代理行按回车时调用 `openStepWindow`。

## 验证方式
- 测试入口：`StepWindow`（直接构造，喂 `apply` / `fail` / `handleInput` / `tick` / `resize`，读 `render(80)` 的输出，去掉颜色码后比文字）；`openStepWindow`（假 ctx.ui.custom、假 clock、假客户端，按 `tests/shell-page.test.ts` 的方式）。
- 测试输入：各种 `RunStepsView`；60 个步骤；取数失败；键盘输入。
- 预期结果：
- [ ] 标题行、状态行文字：running 13 步、turns 9、maxTurns 40、185000 毫秒 → "运行中 · 共 13 步 · ↻9/40 · 3m5s"前带转圈图标；maxTurns 为 null 时只有"↻9"；八种状态各自的图标和文字（failed 带原因）对得上；非运行中状态下推进时间，耗时不变。
- [ ] done / error / running 三步在 running、paused、stopped 三种整体状态下的图标；running 且无 running 步骤时末尾有"思考中"，0 步时步骤区只有"思考中"、状态行"共 0 步"。
- [ ] codemode 下两步缩进两格紧跟其后，后面的普通步骤不缩进。
- [ ] 80 列下每行可见宽度不超过 80，超长步骤以"…"结尾。
- [ ] 终端 28 行（步骤区 20 行）、60 步：打开时最后一行是最新一步；按 ↑ 10 次后首行"↑ 上面还有 N 步"、末行"↓ 下面还有 M 步"，N + M + 中间显示的步数 = 60；此时 apply 多一步，显示不变、M 加 1；按 ↓ 到底后再 apply 一步，最后一行是这新的一步。
- [ ] 没 apply 过时是"读取中…"和"Esc 关闭"；fail("连不上守护进程") 后是"✗ 读不到步骤：连不上守护进程"和"守护进程重启后，之前的步骤就没有了。"。
- [ ] `openStepWindow`：打开后立即取一次数；推进 500 毫秒再取一次；返回 completed 后不再取数；取数抛错后不再取数；按 Esc 后窗口关闭、定时器清掉、底部区块收到页面关闭。
