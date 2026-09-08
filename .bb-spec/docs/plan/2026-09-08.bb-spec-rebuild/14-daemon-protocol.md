---
name: daemon-protocol
description: 窗口与守护进程之间的 JSON Lines over Unix socket 协议：帧格式、方法与事件目录、编解码与传输
---
# 守护进程协议

## 目标
完成后窗口与守护进程可以通过本机 Unix socket 以请求/响应/事件三类帧通信，方法与事件目录固定，双方共用一份编解码。

## 业务规则（来源：spec）
- daemon-host：一个仓库一个守护进程，窗口经本机通信通道与其交互；工作区窗口连接其启动目录子树内全部仓库的守护进程；守护进程不可达时窗口如实显示不可达，不把旧状态当作运行中。
- cross-window-panel：面板活动来自守护进程推送的实际工具开始与结束事件，任意窗口可对本工作区任一运行发起暂停、继续、停止、续接，按真实结果更新状态。
- whitebox-review / role-catalog：提交前审查由主会话记录审查快照（分支头与内容指纹）后一次直接派出白盒审查者，快照随派工传入；派工权由守护进程按调用方身份判定。
- process-list / user-stop：Shell 任务的清理是否确认是任务自身状态；用户可把不确定任务显式裁定为已停止，裁定先写决策记录再登记；运行状态不再有停止不确定。
- transcript-view：查看页订阅某会话的实时事件流，区分思考、输出、工具调用与结果摘要。
- user-relay：提问投递到本工作区已连接窗口，首答生效其余撤回；无窗口时排队，新窗口连接后推送。
- 协议只承载已定义的方法与事件；未知方法返回错误，不静默忽略。

## 涉及文件
- 新建：`runtime/protocol.ts` — 帧类型、方法与事件常量、编解码
- 新建：`tests/daemon-protocol.test.ts`

## 成品定义

帧格式（每帧一行 JSON，LF 结尾，UTF-8；解析只按 LF 切分，不按其他分隔符）：

```json
{"t":"req","id":"<客户端递增整数或 uuid>","method":"<方法名>","params":{}}
{"t":"res","id":"<对应请求 id>","ok":true,"result":{}}
{"t":"res","id":"<对应请求 id>","ok":false,"error":{"code":"<错误码>","message":"<原因>"}}
{"t":"evt","event":"<事件名>","data":{}}
```

`PROTOCOL_VERSION = 1`。`hello` 必须是连接后的第一个请求，携带 `{ windowId, pid, sessionId, cwd, workspaceRoot, repoIds[], protocolVersion }`；版本不一致返回 `error.code = "protocol_version"` 并关闭连接。

方法目录：

| 方法 | params | result |
|---|---|---|
| `hello` | 见上 | `{ daemonPid, repoId, protocolVersion, startedAt }` |
| `ping` | `{}` | `{ now }` |
| `shutdown` | `{}` | `{ accepted }`（仅在无活动运行时接受） |
| `dispatch.requirement` | `{ requirement, cwd, mcp?: { adapterEntry, configPath } }` | `{ runId }` 或错误 `already_active`（附现有 runId）、`not_confirmed` |
| `dispatch.review` | `{ requirement, cwd, baseline, snapshot: { head, fingerprint }, mcp?: { adapterEntry, configPath } }` | `{ runId }` 或错误 `already_active`（该需求已有活动的提交前审查运行）、`not_confirmed`；主会话经窗口连接派出提交前白盒审查者，快照原样传给审查者 |
| `runs.list` | `{ kind?, offset?, limit? }` | `{ items: RunRecord[], total, runningCount }` |
| `runs.get` | `{ runId }` | `{ run: RunRecord, errorDetails?: 摘要 }` |
| `runs.pause` / `runs.resume` / `runs.stop` | `{ runId }` | `{ state, confirmed: boolean, reason? }` |
| `runs.resumeInterrupted` | `{ runId }` | `{ state, confirmed: boolean, reason?, blockingTasks?: ShellTask[] }`（注册表中该运行仍有活动或不确定 Shell 任务时拒绝续接，回执携带任务清单且状态不变） |
| `runs.pauseAll` / `runs.resumeAll` / `runs.stopAll` | `{}` | `{ results: [{ runId, state, confirmed, reason? }] }` |
| `subscribe.activity` | `{}` | `{ subscriptionId, snapshot: RunRecord[] }` |
| `subscribe.transcript` | `{ runId, fromSeq? }` | `{ subscriptionId, entries: TranscriptEntry[], ended: boolean }` |
| `unsubscribe` | `{ subscriptionId }` | `{}` |
| `relay.pending` | `{}` | `{ questions: RelayQuestion[], notices: RelayNotice[] }` |
| `relay.answer` | `{ questionId, answer, windowId }` | `{ accepted: boolean, reason? }` |
| `relay.forward` | `{ requirement, message, windowId }` | `{ delivered: boolean, runId?, reason? }` |
| `shells.list` | `{}` | `{ items: ShellTask[] }` |
| `shells.stop` | `{ taskId, expectedPid, expectedStartedAt }` | `{ status, reason? }` |
| `shells.markStopped` | `{ taskId, expectedPid, expectedStartedAt, decisionId }` | `{ status, reason? }`（用户裁定把不确定的 Shell 任务登记为已停止，决策记录编号随请求携带；非不确定任务拒绝） |
| `mcp.register` | `{ adapterEntry, configPath }` | `{ servers: string[] }` |

事件目录：

| 事件 | data |
|---|---|
| `activity` | `{ runId, kind: "tool_start"\|"tool_end"\|"turn"\|"state", toolName?, filePath?, state?, at }` |
| `transcript` | `{ runId, seq, kind: "thinking"\|"text"\|"toolcall"\|"tool_result"\|"error", delta?, summary?, at }` |
| `runs.changed` | `{ run: RunRecord, activeShellTasks?: number }`（中断运行携带接管的活动 Shell 任务数） |
| `relay.question` | `RelayQuestion` |
| `relay.notice` | `RelayNotice` |
| `relay.withdraw` | `{ questionId }` |
| `shells.changed` | `{ task: ShellTask }` |
| `daemon.idle` | `{ exitAt }` |

错误码：`protocol_version`、`unknown_method`、`unknown_event`、`bad_params`、`not_found`、`already_active`、`not_confirmed`、`shape_violation`、`daemon_busy`、`internal`。

## 函数清单
### runtime/protocol.ts
| 函数 | 职责 |
|---|---|
| `encodeFrame` | 把帧对象序列化为单行 JSON 并追加 LF |
| `decodeFrames` | 从累积缓冲区按 LF 切出完整帧并解析，保留残余字节；空行跳过，非法 JSON 或非帧形状的行进入错误列表而不丢弃其余帧 |
| `createRequest` | 生成带递增 id 的请求帧 |
| `createResponse` | 生成成功响应帧 |
| `createErrorResponse` | 生成失败响应帧 |
| `createEvent` | 生成事件帧 |
| `assertKnownMethod` | 校验方法名在目录内，否则抛 `unknown_method` |
| `assertKnownEvent` | 校验事件名在目录内，否则抛 `unknown_event`；`createEvent` 内调用 |
| `isFrame` | 按 `t` 分支判别帧类型并校验各类帧的必需字段（req 的 id/method/params，res 的 id 与 ok 对应的 result 或 error，evt 的 event/data） |
| `validateParams` | 用各方法的 typebox schema 校验 params，失败抛 `bad_params` |

## 协作关系
`runtime/protocol.ts` 只依赖 `typebox`；被 `runtime/daemon-client.ts`（窗口侧）与 `daemon/server.ts`（守护进程侧）共同使用；类型 `RunRecord`、`ShellTask`、`TranscriptEntry`、`RelayQuestion`、`RelayNotice` 从各自模块 `import type` 引入。

## 验证方式
- 测试入口：`runtime/protocol.ts` 的 `encodeFrame`、`decodeFrames`、`validateParams`、`assertKnownMethod`
- 测试输入：完整帧、跨两次写入拆开的半帧、一次写入含三帧、含 U+2028 的字符串字段、未知方法名、缺字段的 params、版本不一致的 hello
- 预期结果：解码只按 LF 切分并保留残余；三帧全部解出；U+2028 不被当作分隔符；未知方法抛 `unknown_method`；缺字段抛 `bad_params`；每个目录内方法都有 schema
- [ ] 半帧拼接与多帧一次解出
- [ ] U+2028 / U+2029 不切分
- [ ] 目录内每个方法与事件都有 schema 且 `validateParams` 对合法示例通过
- [ ] 未知方法、坏参数、版本不一致分别返回对应错误码
