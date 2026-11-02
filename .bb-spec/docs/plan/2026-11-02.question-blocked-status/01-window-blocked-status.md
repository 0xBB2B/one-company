---
name: 01-window-blocked-status
description: 问答窗口显示时上报 blocked，关闭时恢复 working
---
# 问答窗口上报等待状态

## 目标
主代理运行中，问答窗口显示时 pi 向终端上报 `blocked`，窗口关闭时恢复 `working`，Vibe42 这类终端能显示等待状态并发通知。

## 业务规则（来源：PRD 01-window-blocked-status）
- 问答窗口是提问、确认、选择、选择或输入四种，也就是 `askWindow`、`confirmWindow`、`chooseWindow`、`chooseOrWriteWindow`。设置页、Shell 页、步骤窗口直接用 `openProgramWindow`，不上报。
- 主代理正在运行时，窗口显示出来的那一刻上报：状态 `blocked`，种类 `question`，程序名固定为 `pi`，文字是窗口的问题文字（确认和选择窗口的标题就存在问题字段里）。
- 换行变成空格由 pi-tui 的 `formatProgramStatus` 完成，不用自己处理；但测试要确认写到终端的是这种结果。
- 上报过 `blocked` 的窗口关闭时，不论回答、取消还是信号中断，主代理还在运行就上报 `working`，程序名 `pi`，文字是当前会话名，没有会话名时不带文字。
- 窗口关闭时主代理已停下，不上报，pi 上报的 `done`、`idle`、`error` 不能被盖掉。
- 窗口打开时主代理没在运行，打开和关闭都不上报。
- 排队未显示的窗口不上报；两个窗口排队时，前一个的 `working` 要排在后一个的 `blocked` 之前。

## 涉及文件
- `src/core/host/question-window.ts`（修改）
- `tests/program-window-queue.test.ts`（修改：增加上报测试）

## 函数清单
### src/core/host/question-window.ts
| 函数名 | 职责 |
|---|---|
| `reportWaiting`（新增，模块内部） | 主代理运行中时写入 `blocked`，返回关窗时调用的恢复函数；没在运行时不写入 |
| `openProgramWindow`（修改） | 接受一项可选的等待文字；带这项时在窗口显示时调用 `reportWaiting`，在窗口结束的同一步恢复 |
| `showWindow`（修改） | 打开窗口时把第一个问题的文字作为等待文字传给 `openProgramWindow` |

类型改动：`WindowHost`、`ProgramWindowHost` 增加可选的 `isIdle`、`sessionManager`（只用 `getSessionName`）。测试里的假窗口宿主没有 `isIdle`，缺这项时按"没在运行"处理，不上报。

## 协作关系
- `askWindow` 等四个入口 → `showWindow` → `openProgramWindow` → `reportWaiting` → `tui.terminal.setProgramStatus`。
- 恢复必须放在 `openProgramWindow` 的窗口结束函数里，在调用 pi 的 `done` 之前同步执行。放到 `await` 之后或 `finally` 里，下一个排队窗口可能先上报 `blocked`，再被前一个的 `working` 盖掉。
- pi 的状态上报器会跳过和上次相同的状态，它不知道我们写过 `blocked`，所以 `working` 只能由我们补写。
- `ctx.isIdle()`、`ctx.sessionManager` 在会话被替换后可能抛错（pi `extensions/runner.js` 的 `assertActive`）。恢复时抛错要按"不上报"处理，不能挡住窗口关闭。
- 终端不支持程序状态时，`setProgramStatus` 自己不写入，不用判断。

## 验证方式
- 测试入口：`askWindow`、`confirmWindow`、`chooseWindow`、`chooseOrWriteWindow`、`openProgramWindow`。
- 测试输入：假窗口宿主带 `isIdle`、`sessionManager.getSessionName`，假 `tui.terminal.setProgramStatus` 记录每次调用；用回车、Esc、`AbortController` 关闭窗口。
- 预期结果：`setProgramStatus` 的调用序列符合下面各项。
- [ ] 运行中打开提问窗口：记录一次 `{ state: "blocked", kind: "question", app: "pi", message: <问题> }`。
- [ ] 确认、选择、选择或输入窗口：同样上报，`message` 是窗口标题。
- [ ] 带换行的问题经 `formatProgramStatus` 编码后，解码出的文字是一行，换行变成空格。
- [ ] 回车、Esc、信号中断关闭且仍在运行：记录 `{ state: "working", app: "pi", message: <会话名> }`。
- [ ] 没有会话名：`working` 不带 `message`。
- [ ] 打开后 `isIdle` 变成 true 再关闭：没有 `working` 记录。
- [ ] 打开时 `isIdle` 为 true：没有任何记录。
- [ ] 关闭时 `isIdle` 抛错：窗口照常关闭、返回结果，没有 `working` 记录。
- [ ] 两个窗口排队：序列是第一个 `blocked`、`working`、第二个 `blocked`、`working`，第一个开着时没有第二个的记录。
- [ ] 不带等待文字的 `openProgramWindow`（设置页、Shell 页、步骤窗口的用法）：没有任何记录。
