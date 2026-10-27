---
name: step-recording
description: 子代理会话把每次工具调用的开始和结束报出来，步骤簿按运行记下每一步的中文文字和状态
---
# 记录子代理的步骤

## 目标
守护进程能按运行编号（runId）拿到这个子代理从开始到现在每一次工具调用的中文文字和状态；主窗口派出的检索和原型设计结束后，还能拿到它结束时的状态。

## 业务规则（来源：PRD step-window）
- 一次工具调用算一步，按开始的先后排列；codemode 脚本里调用的工具也各算一步，记下它属于哪一次 codemode 调用（父调用编号）。
- 每一步三种状态：还没结束（running）、成功结束（done）、工具报错结束（error）。
- 每一步的文字按下表取；表里"<…>"是参数里的值，参数里没有这个值时连同前面的连接词一起不写；多个文件用"、"连接；不在表里的工具写工具名本身。

  | 工具（action） | 文字 |
  |---|---|
  | read | `读 <path>` |
  | grep | `搜 "<pattern>" 在 <path>` |
  | find | `找文件 <pattern> 在 <path>` |
  | ls | `列目录 <path>`，没给 path 时 `列目录 .` |
  | one_company_knowledge_query（exact 取 value；search、facts 取 text） | `查项目知识 "<值>"` |
  | one_company_knowledge_query（next，或 facts 没给 text） | `查项目知识` |
  | one_company_change_apply（prepare / apply / import） | `预检改动` / `写入` / `导入` + 空格 + files[].path 用"、"连接 |
  | one_company_change_apply（status） | `查写入结果` |
  | one_company_verification_run（run / status / stop） | `跑命令 <command>` / `查命令结果` / `停命令` |
  | one_company_requirement_manage | `读需求` |
  | one_company_plan_manage | `读计划` |
  | one_company_result_submit | `交结果` |

- 参数来自模型，不可信：取值时只认字符串，类型不对按"没有这个值"处理；换行、制表符和其他控制字符换成一个空格；记下的文字最多 1000 个字符（超出的截掉），避免把整份文件内容（change_apply 的 content）或超长参数存进内存。
- 步骤只记在守护进程内存里，守护进程退出后清空；同一个任务重派是新的运行编号，从 0 步开始。
- 主窗口派出的检索和原型设计没有运行记录：步骤簿要自己记下它们的轮数上限、开始时间、派出它的窗口连接，以及结束时的会话状态、失败原因、已用轮数和结束时间；结束后不再持有会话句柄。

## 涉及文件
- 修改 `src/modules/agents/agent-session.ts`
- 新建 `src/modules/agents/run-steps.ts`

## 成品定义
`src/modules/agents/run-steps.ts` 对外的数据形状（守护进程方法 `runs.steps` 原样返回 `RunStepsView`，状态面板的步骤窗口按它渲染）：

```ts
export type RunStepStatus = "running" | "done" | "error";
export interface RunStep { id: string; parentId?: string; text: string; status: RunStepStatus }
export type RunStepsState = "queued" | "running" | "pausing" | "paused" | "completed" | "failed" | "stopped" | "interrupted";
export interface RunStepsView { state: RunStepsState; reason?: string; turns: number; maxTurns: number | null; elapsedMs: number; steps: RunStep[] }
```

## 函数清单
### src/modules/agents/agent-session.ts
| 函数名 | 职责 |
|---|---|
| `tool_execution_start` 处理（扩展工厂内） | 原有登记之外，再发出 `tool_start` 事件，带 toolCallId、toolName、args、parentToolCallId |
| `stop` | 切到 stopped 后发出 `stopped` 事件，让旁观者知道会话被停止了（现在只有完成、失败、用满轮数、没交结果四种结束会发事件） |

### src/modules/agents/run-steps.ts
| 函数名 | 职责 |
|---|---|
| `stepText` | 按上表把一次工具调用的工具名和参数转成一行中文文字，清洗控制字符并限制长度 |
| `RunStepBook`（类） | 守护进程内存里的步骤簿，按运行编号保存步骤列表和主窗口运行的状态快照 |
| `RunStepBook.track` | 订阅一个会话句柄：`tool_start` 追加一步（running），`tool_end` 按 toolCallId 把那一步改成 done 或 error；可选传入轮数上限和派出它的窗口连接，用于主窗口的运行；收到 completed / failed / turn_limit_reached / ended_without_result / stopped 时记下结束快照并放掉句柄 |
| `RunStepBook.steps` | 返回某个运行的步骤列表副本；没记过这个运行时返回 undefined |
| `RunStepBook.mainStatus` | 只对 track 时带了窗口连接的运行：连接对得上时返回会话状态（在跑时读句柄，结束后读快照）、失败原因、已用轮数、轮数上限、开始和结束时间；连接对不上或不是主窗口运行时返回 undefined |

## 协作关系
- `RunStepBook.track` 由守护进程的运行管理在创建子代理、PM 派出的检索、主窗口检索、原型设计会话后调用（02 计划接线）。
- `stepText` 只用 `src/core/policy/text-sanitize.ts` 的 `sanitizeText` 和 `src/modules/agents/role-tools.ts` 的 `CORE_TOOL_PREFIX`，不依赖其他模块。

## 验证方式
- 测试入口：`stepText`、`RunStepBook`（构造一个带 `events: EventEmitter`、`state()`、`turnsUsed()` 的假会话句柄）；`createAgentRoleSession` 的现有测试方式（`tests/agent-session.test.ts`）。
- 测试输入：上表每种工具调用的参数；依次发出的 `tool_start` / `tool_end` / 结束事件。
- 预期结果：
- [ ] 上表每一行的文字都对：如 read `{path:"src/a.ts"}` → `读 src/a.ts`；grep `{pattern:"foo",path:"src/"}` → `搜 "foo" 在 src/`；grep 只有 pattern → `搜 "foo"`；ls `{}` → `列目录 .`；change_apply apply 两个文件 → `写入 a.ts、b.ts`；verification_run run `{command:"pnpm test\n--run"}` → `跑命令 pnpm test --run`；`mcp__github__search` → `mcp__github__search`；参数类型不对（如 path 是数字）按没有处理。
- [ ] 2000 个字符的 command 记下的文字不超过 1000 个字符。
- [ ] 三次 tool_start（第三次带 parentToolCallId 指向第二次）后，第一次 tool_end 成功、第二次 tool_end 报错：steps 依次是 done、error、running，第三步 parentId 是第二步的 id。
- [ ] 没 track 过的运行编号，steps 返回 undefined。
- [ ] 带窗口连接 track 的运行：用同一连接查 mainStatus 能拿到 running 和 turnsUsed；换一个连接查返回 undefined；发出 failed（reason "x"）后返回 failed、原因 "x"，之后句柄的 state() 变化不再影响结果。
- [ ] 真实会话调用 `stop()` 后发出 `stopped` 事件；工具执行时发出带 toolName、args 的 `tool_start` 事件。
