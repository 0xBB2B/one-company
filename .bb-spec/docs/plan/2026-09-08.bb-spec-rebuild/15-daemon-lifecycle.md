---
name: daemon-lifecycle
description: 守护进程入口、SDK 动态加载、以 socket 连接探测实现每仓库单实例并自动收敛、空闲退出、启动时标记中断运行
---
# 守护进程生命周期

## 目标
完成后窗口能按需拉起对应仓库唯一的守护进程；守护进程加载 SDK、监听 socket、在无活动且无连接超过空闲时限后退出，崩溃重启后把旧运行标记为中断；并发拉起自动收敛为一个实例。

## 业务规则（来源：spec）
- daemon-host：一个仓库对应一个守护进程；首个需要它的窗口自动拉起，已运行时只连接，同一仓库不得同时存在两个；直接用本机模型配置与凭据，不依赖窗口在线，不把凭据写入记录；无运行中、暂停中或等待答复的需求代理且无窗口连接持续超过空闲时限时退出；崩溃或机器重启后其中运行标记为中断并保留现场，不自动重跑；睡眠唤醒后继续，超时、失联与空闲计时扣除睡眠间隔。
- run-lifecycle：守护进程无法确认已停止的运行标记为中断，不判为成功。
- builtin-execution：守护进程、模型服务或资源不可用时如实报告错误，不切换其他执行方式。

## 涉及文件
- 新建：`daemon/main.ts` — 进程入口
- 新建：`daemon/sdk.ts` — SDK 动态加载
- 新建：`daemon/lifecycle.ts` — 单实例、监听、空闲退出
- 新建：`daemon/server.ts` — 连接管理与方法分发骨架（hello / ping / shutdown / 订阅登记；业务方法处理器由 run-manager 单元接入）
- 修改：`runtime/identity.ts` — `daemonSocketPath` 改为返回 `<dataRoot>/sock/<repoId 前 16 位>.sock`（目录 0o700，首次创建）；删除 `daemonLockPath`
- 新建：`tests/helpers/daemon-harness.ts` — 测试用真实拉起与连接
- 新建：`tests/daemon-lifecycle.test.ts`

## 成品定义

守护进程启动契约（窗口侧 `spawnDaemon` 与守护进程入口共同遵守）：

```
可执行文件：process.execPath（运行 pi 的 Node）
参数：<包目录>/daemon/main.ts
环境变量：
  PI_COMPANY_SDK_DIR    = getPackageDir() 得到的 SDK 包根目录
  PI_COMPANY_REPO_DIR   = 仓库 git common dir 的 realpath
  PI_COMPANY_DATA_ROOT  = 本机数据根（缺省 ~/.pi/agent/pi-company）
  PI_CODING_AGENT_DIR   = 透传（缺省 ~/.pi/agent）
stdio：ignore；detached：true；spawn 后 unref
socket：<dataRoot>/sock/<repoId 前 16 位>.sock（不在 repos/<repoId>/ 下，避免路径超出 Unix socket 长度上限）
单实例：无锁文件、不判 pid。拉起方与守护进程都先连接 socket：连上即复用现有实例；
  连接被拒或文件不存在才删除残留 socket 并监听。守护进程监听后记录 socket 文件 inode，
  周期核对路径仍指向自己；不是自己（被并发实例替换）即退出，最终恰一个实例持有该路径。
```

## 函数清单
### daemon/main.ts
| 函数 | 职责 |
|---|---|
| `main` | 读环境变量、加载 SDK、调用 `startDaemon`，任何启动失败以非零退出并写 stderr |

### daemon/sdk.ts
| 函数 | 职责 |
|---|---|
| `loadSdk` | 动态 import `<sdkDir>/dist/index.js`，返回需要的 SDK 符号集合 |
| `loadSdkModule` | 用 SDK 目录的 `createRequire` 解析并 import 指定包（pi-ai 兼容入口、jiti） |
| `assertSdkVersion` | 读取 SDK package 版本并校验满足下限 |

### daemon/lifecycle.ts
| 函数 | 职责 |
|---|---|
| `startDaemon` | 先 `probeExistingInstance`：已有实例在监听则以退出码 0 退出；否则 `listenExclusive`、建服务端、启动空闲检查、socket 自检与退出清理 |
| `probeExistingInstance` | 连接 socket 路径并完成 `ping`：成功返回"已有实例"；ECONNREFUSED / ENOENT 返回"残留或缺失" |
| `listenExclusive` | 删除残留 socket 文件后监听，监听成功后记录自身 socket 文件的 inode |
| `checkSocketOwnership` | 用睡眠感知时钟周期（5 秒）stat socket 路径并比对 inode；不一致或文件消失时停止接受新连接、标记运行中断、退出 |
| `releaseSocket` | 退出时只删除 inode 仍等于自身记录的 socket 文件 |
| `IdleExit.touch` | 记录最近活动时刻（连接、请求、运行事件） |
| `IdleExit.check` | 按扣除睡眠后的时长判断是否应退出，有活动需求代理时不退出 |
| `installSignalHandlers` | 处理可处理终止信号：停止运行的 Shell、标记运行中断、释放 socket 后退出 |

### daemon/server.ts
| 函数 | 职责 |
|---|---|
| `DaemonServer.listen` | 在 socket 路径监听，逐连接解码帧 |
| `DaemonServer.handleHello` | 校验协议版本，登记客户端的窗口身份、工作区与仓库集合 |
| `DaemonServer.dispatchMethod` | 按方法名路由到已注册处理器，未知方法返回错误 |
| `DaemonServer.registerHandler` | 供 run-manager 单元登记 dispatch/runs/relay/shells/subscribe 方法处理器 |
| `DaemonServer.broadcast` | 向满足过滤条件的客户端发送事件帧 |
| `DaemonServer.clients` | 列出当前连接及其登记信息 |
| `DaemonServer.close` | 关闭全部连接与监听 |

### tests/helpers/daemon-harness.ts
| 函数 | 职责 |
|---|---|
| `startDaemonForTest` | 在临时 HOME 与临时仓库下以真实子进程启动守护进程，返回句柄 |
| `connectTestClient` | 连接 socket 并完成 hello，返回可 `call`/`onEvent` 的客户端 |
| `killDaemon` | 强杀守护进程模拟崩溃 |

## 协作关系
`main` → `loadSdk` → `startDaemon` → `DaemonServer.listen`。`startDaemon` 使用 `runtime/identity.ts` 的 `daemonSocketPath`、`runtime/clock.ts` 的睡眠感知计时、`runtime/run-store.ts` 的 `markInterruptedOnStartup`。窗口侧 `runtime/daemon-client.ts` 的 `spawnDaemon` 按上方启动契约拉起，并以"连接成功"而非锁文件作为就绪判据。

## 验证方式
- 测试入口：`tests/helpers/daemon-harness.ts` 的 `startDaemonForTest` / `connectTestClient`；socket 上的 `hello`、`ping`、`shutdown`
- 测试输入：同一仓库并发两次与三次拉起；预置无监听者的残留 socket 文件；已有实例运行时再次拉起；用另一个监听者替换正在运行实例的 socket 文件；客户端断开后等待超过空闲时限（注入时钟跳变模拟睡眠 5 分钟）；运行目录预置一条 `running` 记录后启动；数据根路径很长的仓库
- 预期结果：并发拉起后一个自检周期内只有一个进程存活且 socket 可连、`hello` 返回同一 daemonPid；残留 socket 被清理并正常启动；已有实例时新实例退出码 0 且原实例连接不受影响；socket 被替换后原实例在一个自检周期内退出且不删除新文件；无连接无运行时超过 10 分钟退出并删除 socket；睡眠跳变不计入空闲时长；预置记录在启动后变为 `interrupted`；socket 路径位于 `<dataRoot>/sock/` 且文件名为 repoId 前 16 位，长路径仓库也能监听
- [ ] 并发拉起收敛为单实例
- [ ] 残留 socket 清理与已有实例复用
- [ ] socket 被替换即退出
- [ ] 空闲退出与睡眠扣除
- [ ] 存在暂停或等待答复运行时不退出
- [ ] 启动标记中断
- [ ] SDK 目录缺失或版本不足时以非零退出并给出原因
