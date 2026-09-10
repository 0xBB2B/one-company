---
name: sleep-aware-clock
description: 统一计时器：检测时钟跳变并从超时、保留期、心跳与空闲计时中扣除睡眠间隔，可注入假时钟供测试
---
# 睡眠感知时钟

## 目标
所有依赖时间的判定（Shell 超时、结束保留 20 秒、临时提示 20 秒、心跳失联、守护进程空闲退出、暂停确认超时）共用一个时钟，机器睡眠期间的时间不计入任何计时。

## 业务规则（来源：spec）
- daemon-host：机器睡眠后唤醒时继续守护进程内的会话，并从 Shell 超时、结束保留、心跳失联和空闲退出等计时中扣除睡眠间隔，不因睡眠误判超时、失联或空闲。
- cross-window-panel：结束条目与临时提示各保留 20 秒，自首次出现起计时，重绘与选择不续时。
- managed-execution：后台 Shell 的超时按秒从进程启动时计时。

## 涉及文件
- 新建：runtime/clock.ts
- 新建：tests/sleep-aware-clock.test.ts

## 函数清单

### runtime/clock.ts
| 函数名 | 职责 |
|---|---|
| `createClock` | 创建时钟实例：封装当前时间、单调时间、定时器与睡眠间隔账本；可传入假时间源用于测试 |
| `detectSleepGap` | 比较定时器实际触发时刻与期望时刻，超过阈值（默认 5 秒）的差值记为一次睡眠间隔 |
| `startGapWatcher` | 以固定周期的看门狗定时器持续检测睡眠间隔并累计到账本 |
| `elapsedExcludingSleep` | 计算自某一时刻起扣除已记录睡眠间隔后的经过时间 |
| `deadline` | 基于扣除睡眠的经过时间判断某个超时是否届满 |
| `setTimeoutExcludingSleep` | 到期判定按扣除睡眠的时间，睡眠后自动顺延剩余时间 |
| `setIntervalExcludingSleep` | 周期任务在唤醒后不补发睡眠期间错过的次数 |
| `onSleepGap` | 注册睡眠间隔回调，供连通性探测与心跳模块响应唤醒 |

## 协作关系
- 守护进程与窗口各自创建一个时钟实例并注入到 shell-registry、agents-activity、windows、daemon-lifecycle、network-pause。
- 假时间源允许测试直接推进时间与模拟跳变，不真实等待。
- 依赖：Node 内置 timers 与 performance.now；不依赖 pi SDK。

## 验证方式
- 测试入口：`runtime/clock.ts` 导出函数，注入假时间源
- 测试输入：一系列"推进时间"与"跳变"指令
- 预期结果：
  - 正常推进 60 秒，`elapsedExcludingSleep` 为 60 秒；期间出现一次 300 秒跳变后仍为 60 秒
  - 设置 60 秒的 `setTimeoutExcludingSleep`，推进 10 秒、跳变 300 秒、再推进 50 秒后才触发；跳变前后各触发 0 次与 1 次
  - `setIntervalExcludingSleep` 周期 5 秒，跳变 300 秒后唤醒只触发一次，不补发 60 次
  - 跳变小于阈值（3 秒）不记为睡眠间隔
  - `onSleepGap` 回调收到间隔长度与唤醒时刻；注销后不再收到
  - 用真实时间源运行 100 毫秒定时器能正常触发（冒烟）
- [x] 扣除睡眠的经过时间
- [x] 超时顺延
- [x] 周期不补发
- [x] 阈值与回调
