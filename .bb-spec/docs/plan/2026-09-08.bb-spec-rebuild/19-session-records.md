---
name: session-records
description: 需求代理与角色会话以可重载的 SQLite 会话记录存入仓库数据库，原样保存、权限限定、按运行身份读取记录、重载前为悬空工具调用补入中断结果并支持续接重载
---
# 会话记录持久化

## 目标
完成后守护进程内每个会话完整记录在仓库数据库内，查看页可离线回读，守护进程重启后可原样重载上下文续接，被中断打断的工具调用有明确的中断结果。

## 业务规则（来源：spec）
- session-records：每个会话以可重载的 SQLite 会话记录保存在本机用户数据区，按仓库与运行身份定位；记录含对话消息、思考、工具调用与结果、结构化提交与错误；内容原样保存不作改写，权限限当前用户，不上传、不进入 Git；压缩由宿主按设置自动产生并追加为会话条目，重载时按压缩后视图重建上下文且数据库保留完整历史；续接时核对工作区后继续；写入失败停止当前会话并报告，读取失败保留已保存历史并拒绝续接。
- run-lifecycle：续接时不回滚改动，中断时未完成的操作以只读核对方式恢复，不盲目重复副作用。
- transcript-view：会话已结束或守护进程不可达时显示本机保存的记录。

## 涉及文件
- 新建：`runtime/session-records.ts`
- 新建：`tests/session-records.test.ts`

## 函数清单
### runtime/session-records.ts
| 函数 | 职责 |
|---|---|
| `sessionRecordRef` | 返回仓库数据库中会话的记录地址 |
| `createSessionManagerForRun` | 创建 SDK 内存会话，以 UUIDv7 保存元数据，将 SDK 条目和当前分支位置同事务写入 SQLite，版本冲突拒绝，保存失败回调停止运行；重复运行身份拒绝覆盖 |
| `openSessionManagerForRun` | 查询元数据与顺序事件、校验身份、父链和当前分支位置后重建 SDK 内存会话；缺失或坏结构返回明确错误 |
| `synthesizeInterruptedResults` | 重载前扫描当前分支，为每个没有对应结果的工具调用（按流内序号，含同一消息内多个）追加一条固定中断结果条目（文本为"调用因守护进程中断"，isError），原条目不改写；幂等；返回 { ok, appended } 或缺失/损坏的明确错误，不抛出 |
| `readTranscript` | 解析 SQLite 会话记录为查看页条目（思考、输出、工具调用、结果摘要、错误），支持从序号起读；seq 稳定（追加与压缩不改变既有序号）；缺失/损坏返回明确错误而非空会话 |
| `transcriptSeq` | 返回当前最新序号，供实时订阅与离线回读衔接；缺失/损坏返回明确错误 |

## 协作关系
`daemon/role-session.ts` 与 `daemon/requirement-agent.ts` 创建会话时使用 `createSessionManagerForRun`；`daemon/run-manager.ts` 续接时先 `synthesizeInterruptedResults` 再 `openSessionManagerForRun`，并把补入清单作为续跑提示的"结果不明操作"；`daemon/server.ts` 的 `subscribe.transcript` 先用 `readTranscript` 回放再接实时事件。

## 验证方式
- 测试入口：以上函数，配合 SDK 会话管理器与受控 provider（不联网）
- 测试输入：一段含思考、文本、两次工具调用（其中结果含 `Bearer` 凭据与独立标记文本）与结构化提交的会话；关闭后重开；追加一条宿主压缩条目后重开；在一次工具调用发出后、结果写入前截断的SQLite 会话记录；删除会话元数据后重开；写入坏结构记录；数据库触发器拒绝写入
- 预期结果：记录在仓库数据库且权限 0600；凭据与标记文本原样保留；`readTranscript` 条目顺序与类型正确且 seq 单调；重开后消息数与关闭前一致；含压缩条目时重建的上下文为摘要加压缩点之后的条目，数据库条目数不减少；截断会话经 `synthesizeInterruptedResults` 后该调用有一条文本为"调用因守护进程中断"的结果条目、原调用条目字节不变、返回清单恰含该调用且随后重载成功，对完整会话调用不追加任何条目；缺失与损坏分别返回明确错误而非抛出到调用方
- [x] 位置与权限
- [x] 原样落盘
- [x] 回读条目与序号
- [x] 重载一致与压缩视图
- [x] 悬空调用补入中断结果
- [x] 缺失/损坏如实
