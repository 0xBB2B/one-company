---
name: session-records
description: 需求代理与角色会话以可重载会话文件落本机运行目录，原样保存、权限限定、按运行身份读取记录并支持续接重载
---
# 会话记录持久化

## 目标
完成后守护进程内每个会话完整记录在运行目录内，查看页可离线回读，守护进程重启后可原样重载上下文续接。

## 业务规则（来源：spec）
- session-records：每个会话以可重载会话文件保存在本机用户数据区，按仓库与运行身份定位；记录含对话消息、思考、工具调用与结果、结构化提交与错误；内容原样保存不作改写，权限限当前用户，不上传不入库；压缩由宿主按设置自动产生并追加为会话条目，重载时按压缩后视图重建上下文且文件保留完整历史；续接时核对工作区后继续；写读失败明确报告且运行判定不变。
- transcript-view：会话已结束或守护进程不可达时显示本机保存的记录。

## 涉及文件
- 新建：`runtime/session-records.ts`
- 新建：`tests/session-records.test.ts`

## 函数清单
### runtime/session-records.ts
| 函数 | 职责 |
|---|---|
| `sessionFilePath` | 返回运行目录下会话文件位置 |
| `createSessionManagerForRun` | 用 SDK 的会话管理器在运行目录创建新会话文件并设置权限 |
| `openSessionManagerForRun` | 打开已存在的会话文件供续接，缺失或损坏时返回明确错误 |
| `readTranscript` | 解析会话文件为查看页条目（思考、输出、工具调用、结果摘要、错误），支持从序号起读 |
| `transcriptSeq` | 返回当前最新序号，供实时订阅与离线回读衔接 |

## 协作关系
`daemon/role-session.ts` 与 `daemon/requirement-agent.ts` 创建会话时使用 `createSessionManagerForRun`；`daemon/run-manager.ts` 续接时使用 `openSessionManagerForRun`；`daemon/server.ts` 的 `subscribe.transcript` 先用 `readTranscript` 回放再接实时事件。

## 验证方式
- 测试入口：以上函数，配合 SDK 会话管理器与受控 provider（不联网）
- 测试输入：一段含思考、文本、两次工具调用（其中结果含 `Bearer` 凭据与独立标记文本）与结构化提交的会话；关闭后重开；追加一条宿主压缩条目后重开；删除文件后重开；文件替换为半行损坏内容
- 预期结果：文件在运行目录且权限 0600；文件内凭据与标记文本原样保留；`readTranscript` 条目顺序与类型正确且 seq 单调；重开后消息数与关闭前一致；含压缩条目时重建的上下文为摘要加压缩点之后的条目，文件条目数不减少；缺失与损坏分别返回明确错误而非抛出到调用方
- [ ] 位置与权限
- [ ] 原样落盘
- [ ] 回读条目与序号
- [ ] 重载一致与压缩视图
- [ ] 缺失/损坏如实
