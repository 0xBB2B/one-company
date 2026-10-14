---
name: designer-dispatch
description: 守护进程按主窗口请求派出原型设计师：绑定连接、跟随主窗口模型、轮数上限进会话配置、交稿与结束发事件、面板显示
---
# 守护进程派出原型设计师

## 目标
主窗口能经守护进程派出原型设计师，并列出原型设计师类的定义。守护进程负责：运行绑定在派出它的连接上；交稿或结束时发事件；面板能列出运行中的设计。

## 业务规则（来源：PRD prototype-designer）
- 只有主窗口连接能派。派出参数写明需求编号、原型名称、要画的界面和要求（最长 4000 字）、轮数上限（1 到 100）、可选的定义名。缺项或越界时拒绝，原因写明缺什么。
- 模型与思考等级：定义里写了就用定义的，没写就用主窗口此刻的值。指定的定义不存在、不可用、或不是 prototype 类时，拒绝派出，原因写明为什么，不换别的定义。没指定定义时用内置的 prototype。
- 轮数上限写进会话配置，用满就停。
- 设计师能读仓库根目录下的文件，以及上一版原型文件（有的话），别的都读不了。
- 任务说明写明：需求标题、原型名称、第几版、要求、轮数上限；返工后重派时，再加上一版文件位置和用户返工原话，原话由程序从看板取出，不经主代理。
- 交稿通过校验后，看板改成 awaiting，再向派出它的窗口发"已交稿"事件。
- 没交稿就结束时（轮数用满、被停止、出错、主窗口断开），看板清掉在途状态、记下原因。连接还在时，再向派出它的窗口发"已结束"事件，带上原因。
- 守护进程启动时，把所有 designing 状态的在途原型清掉（运行只在内存里，重启后一定已经不在了）。
- 面板：本窗口派出、还在运行的设计，每个一行：名称、第几版、定义名、已用轮数/上限、已用时间。
- 主窗口能列出 prototype 类定义的名称、描述和来源，只列这一类。

## 涉及文件
- runtime/protocol.ts（修改：新 RPC 方法与事件）
- daemon/run-manager.ts（修改：派出、结束、列表、停止、断开清理、启动清理、定义列表）
- runtime/prototype-dispatch.ts（新建：派出参数结构、任务说明文字、面板条目类型）
- runtime/result-submit.ts（修改：prototype 动作改绑原型看板）
- daemon/lifecycle.ts（修改：启动时调用 `clearStaleDesigns`）
- tests/prototype-dispatch.test.ts（新建）、tests/daemon-protocol.test.ts（修改）

## 成品定义
新增协议方法和事件（加进 `runtime/protocol.ts` 的 METHODS / EVENTS，参数都是 `additionalProperties:false`）：
```ts
"prototypes.dispatch":  { requirementId: id, name: Type.String({ minLength: 1, maxLength: 40 }), brief: Type.String({ minLength: 1, maxLength: 4000 }),
                          maxTurns: Type.Integer({ minimum: 1, maximum: 100 }), agent: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
                          model: Type.Object({ provider: Type.String(), id: Type.String() }, { additionalProperties: false }), thinking: Type.String() }
"prototypes.designers": {}                                   // 只列 prototype 类定义：name、description、source
"prototypes.list":      {}                                   // 面板用：本连接运行中的设计
"prototypes.board":     { requirementId: id }                // 主代理查看板：各原型状态、lastEnded 原因
// 事件
"prototype.changed"     // 面板刷新信号
"prototype.submitted"   // { parentSessionId, requirementId, name, version }
"prototype.finished"    // { parentSessionId, requirementId, name, version, reason }
```

## 函数清单
### runtime/prototype-dispatch.ts
| 函数名 | 职责 |
|---|---|
| `PrototypeDispatchInput` | 派出参数结构（同上） |
| `prototypeContext` | 拼任务说明文字：需求标题、名称、版本、要求、轮数上限；有返工时附上一版位置和原话 |
| `MainPrototypeOverview` | 面板条目：runId、名称、版本、定义名、已用轮数、上限、已用时间 |
### daemon/run-manager.ts
| 函数名 | 职责 |
|---|---|
| `dispatchPrototype` | 仿主窗口检索分支：先解析定义，再调 `beginDesign`，然后建会话（readRoots 是仓库根加上一版文件，宿主工具用职责默认值，结果工具绑定看板），登记进内存表，最后发 changed |
| `finishPrototype` | 运行结束时调用：交过稿就只从内存表移除；没交稿就调 `endDesign` 并发 finished |
| `abandonMainPrototypes` | 连接断开时停掉本连接的设计，调 `endDesign`，原因记"主窗口断开" |
| `mainPrototypeList` | 面板列表，只列本连接的 |
| `prototypeDesigners` | 定义目录里 prototype 类且可用的定义 |
| `stopMainPrototype` / `mainPrototypeStatus` | 接进现有的 `runs.stop` 和 `runs.get`，只认派出连接 |
### runtime/result-submit.ts
| 函数名 | 职责 |
|---|---|
| `createResultSubmitTool` 的 prototype 分支 | 绑定改成 {requirementId, name, runId}，调 `submitDesign`；拒收原因原样交回设计师 |

## 协作关系
- `agents.dispatchExplore` 的主窗口分支是现成模板：父身份取自已认证的连接、`liveConnections`、`server.onDisconnect` 包装、完成方式是 on-result。
- 交稿成功后，`result_submit` 结束运行，接着进 `finishPrototype`。
- 事件经 `server.broadcast` 发出，主窗口按 parentSessionId 过滤（见 05）。
- `runs.pause` / `runs.resume` 对设计运行拒绝，和主窗口检索一样。

## 验证方式
- 测试入口：守护进程 RPC（`prototypes.dispatch`、`prototypes.designers`、`prototypes.list`、`prototypes.board`、`runs.stop`），用假模型会话驱动。
- 测试输入：草稿状态的需求；内置 prototype；写了模型的用户定义；坏定义；worker 类定义。
- 预期结果：
  - [ ] 缺名称、缺要求、maxTurns 为 0 或 101、需求不存在时，派出都被拒，原因写明。
  - [ ] 用内置 prototype 派出：会话用主窗口传来的模型和思考等级；用写了 B 模型的定义：会话用 B。
  - [ ] 指定的定义不存在、不可用、或是 worker 类时被拒，并且没有开出任何会话。
  - [ ] 会话配置里的轮数上限等于 maxTurns；用满后运行停止，看板清空在途状态，收到 finished 事件，原因写明轮数用满。
  - [ ] 会话读仓库里的文件成功，读仓库外的文件被拒；返工后重派时能读上一版文件，任务说明里有用户原话。
  - [ ] 设计师交合格稿后看板变成 awaiting，收到 submitted 事件；交不合格稿时设计师收到原因，看板仍是 designing。
  - [ ] 断开连接后看板清空在途状态，lastEnded 原因是"主窗口断开"；守护进程重启后，designing 状态被清掉。
  - [ ] `prototypes.list` 只列本连接运行中的设计；`prototypes.designers` 只列 prototype 类定义。
