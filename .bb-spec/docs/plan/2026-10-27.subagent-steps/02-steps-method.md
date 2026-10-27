---
name: steps-method
description: 守护进程新增 runs.steps 方法按运行编号返回步骤和状态；面板概览里每个子代理行带上运行编号
---
# 守护进程的步骤查询方法

## 目标
主窗口能用 `runs.steps` 按运行编号查到一个子代理的全部步骤、状态、轮数和耗时；面板概览里每个执行行、审查代理行、PM 派出的检索行都带着运行编号，方便面板打开对应的步骤窗口。

## 业务规则（来源：PRD step-window、select-subagent）
- 状态和数字与面板上这一行一致：PM 派出的子代理（执行、审查、检索）按运行记录取状态（queued、running、pausing、paused、completed、failed、stopped、interrupted）、失败原因（运行记录的 stateReason）、轮数、上限和耗时，耗时扣掉暂停时间，算法与面板概览相同。
- 主窗口派出的检索和原型设计没有运行记录，按步骤簿的状态快照取：会话状态 running → running，paused → paused，completed → completed，stopped → stopped，failed → failed（原因用会话给的错误说明），turn_limit_reached → failed（原因"用完轮次上限仍没有提交结果"），ended_without_result → failed（原因"模型停止回复，但没有提交结果"）；耗时为开始到现在（已结束的到结束时间）；上限为派出时给的轮数上限。
- 主窗口派出的检索和原型设计只有派出它的那个窗口连接能查，别的连接查按"查不到"处理，和现在 `runs.get` 对主窗口运行的规则一致。
- 步骤簿里没有这个运行的步骤时（守护进程重启过、运行编号不存在、不是本连接的主窗口运行），返回错误 `not_found`，说明"守护进程里没有这个子代理的步骤"，建议"守护进程重启后，之前的步骤就没有了"。
- PM 本身的运行不记步骤。
- 新增方法和概览字段后，主窗口和守护进程的通信版本号加 1，旧版本的守护进程会被换掉，避免新窗口调到不认识这个方法的旧守护进程。

## 涉及文件
- 修改 `src/core/host/protocol.ts`
- 修改 `src/app/daemon/method-params.ts`
- 修改 `src/app/daemon/run-manager.ts`
- 修改 `src/modules/panel/pm-overview.ts`

## 成品定义
`src/core/host/protocol.ts`：`PROTOCOL_VERSION` 从 5 改成 6；`METHODS` 里紧跟 `"runs.get"` 加一项 `"runs.steps"`。

`src/app/daemon/method-params.ts` 的 `PARAM_SCHEMAS` 里紧跟 `"runs.get"` 加：

```ts
  "runs.steps": Type.Object({ runId: Type.String() }, { additionalProperties: false }),
```

`src/modules/panel/pm-overview.ts` 的面板行类型改成（只加 `runId` 字段，其余不变）：

```ts
export interface PanelReviewerRow extends Partial<PanelRunStats> {
  agent: string;
  state: PanelReviewerState;
  /** 运行中的行带运行编号，面板据此打开步骤窗口。 */
  runId?: string;
  attempt?: number;
  reason?: "turn_limit_reached" | "failed" | "stopped" | "superseded";
}

export type PanelTaskRow =
  | ({ kind: "execute"; taskKey: string; agent: string; attempt: number; runId: string } & PanelRunStats)
  | { kind: "review"; taskKey: string; round: number; reviewers: PanelReviewerRow[] }
  | { kind: "pending"; taskKey: string; itemId: string; text: string }
  | ({ kind: "explore"; runId: string } & PanelRunStats);
```

（`PanelReviewerRow` 里 `attempt` 原有的注释保留不动。）

## 函数清单
### src/modules/panel/pm-overview.ts
| 函数名 | 职责 |
|---|---|
| `runStatsOf` | 改为导出，供守护进程按同一算法算步骤窗口的轮数和耗时 |
| `reviewerRowsOf` | 运行中的审查代理行带上 runId |
| `taskRowsOf` | 执行行、PM 派出的检索行带上 runId |

### src/app/daemon/run-manager.ts
| 函数名 | 职责 |
|---|---|
| `RunManager` 构造 / 字段 | 持有一个 `RunStepBook` |
| 子代理、PM 派出的检索、主窗口检索、原型设计的会话创建处 | 会话建好后调用 `RunStepBook.track`；主窗口检索和原型设计带上轮数上限和窗口连接 |
| `RunManager.runSteps` | 按上面的规则拼出 `RunStepsView`：先看步骤簿有没有这个运行，再取运行记录或主窗口状态快照；都拿不到时抛 `not_found` |
| `registerProtocolHandlers` | 登记 `runs.steps`，调用 `RunManager.runSteps` 并传入调用方的连接编号 |

## 协作关系
- `runs.steps` → `RunManager.runSteps` → `RunStepBook.steps` / `RunStepBook.mainStatus`（01 计划）+ `RunStore.get` + `runStatsOf`。
- 失败原因复用 run-manager 里现有的 `outcomeReason` 文字。
- 步骤窗口（03 计划）调用 `runs.steps`；面板（04 计划）读概览行上的 runId。

## 验证方式
- 测试入口：守护进程方法 `runs.steps`（按 `tests/run-manager.test.ts`、`tests/daemon-protocol.test.ts` 的方式起 RunManager 或守护进程）；`pmOverview`（按 `tests/pm-overview.test.ts`）；`assertKnownMethod` / 参数校验。
- 测试输入：派出一个 worker 并让假会话依次调用工具；主窗口派出一个检索；不存在的运行编号；另一个窗口连接。
- 预期结果：
- [ ] worker 调了两次工具后，`runs.steps` 返回 state running、两步、turns 和 maxTurns 与运行记录一致；暂停后返回 paused 或 pausing；完成后返回 completed，耗时不再随时间增加。
- [ ] worker 失败后返回 failed，reason 等于运行记录的 stateReason。
- [ ] 主窗口检索：派出它的连接能查到 running；别的连接查返回 not_found；检索用满轮数结束后返回 failed、原因"用完轮次上限仍没有提交结果"；结果被取走之后再查，仍返回结束时的状态和全部步骤。
- [ ] 不存在的运行编号、PM 自己的运行编号返回 not_found，错误说明为"守护进程里没有这个子代理的步骤"。
- [ ] `runs.steps` 多带一个参数时参数校验报错；`PROTOCOL_VERSION` 为 6。
- [ ] `pmOverview` 的执行行、PM 派出的检索行带 runId，运行中的审查代理行带 runId，其余审查代理行不带。
