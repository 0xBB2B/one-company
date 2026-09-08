---
name: daemon-lifecycle
description: 守护进程入口、SDK 动态加载、每仓库单实例锁、socket 监听、心跳与空闲退出、启动时标记中断运行
---
# 守护进程生命周期

## 目标
完成后窗口能按需拉起对应仓库唯一的守护进程；守护进程加载 SDK、监听 socket、在无活动且无连接超过空闲时限后退出，崩溃重启后把旧运行标记为中断。

## 业务规则（来源：spec）
- daemon-host：一个仓库对应一个守护进程；首个需要它的窗口自动拉起，已运行时只连接，同一仓库不得同时存在两个；直接用本机模型配置与凭据，不依赖窗口在线，不把凭据写入记录；无运行中、暂停中或等待答复的需求代理且无窗口连接持续超过空闲时限时退出；崩溃或机器重启后其中运行标记为中断并保留现场，不自动重跑；睡眠唤醒后继续，超时、失联与空闲计时扣除睡眠间隔。
- run-lifecycle：守护进程无法确认已停止的运行标记为中断，不判为成功。
- builtin-execution：守护进程、模型服务或资源不可用时如实报告错误，不切换其他执行方式。

## 涉及文件
- 新建：`daemon/main.ts` — 进程入口
- 新建：`daemon/sdk.ts` — SDK 动态加载
- 新建：`daemon/lifecycle.ts` — 单实例、监听、空闲退出
- 新建：`daemon/server.ts` — 连接管理与方法分发（本 plan 只建骨架：hello / ping / shutdown / 订阅登记）
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
锁文件 daemon.lock（原子创建，内容 JSON）：{ "pid": 123, "startedAt": "<UTC RFC3339>", "protocolVersion": 1 }
socket：repos/<repoId>/daemon.sock；监听前删除残留但 pid 已死的旧 socket 与锁
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
| `startDaemon` | 取锁、清理死 socket、建服务端、启动心跳与空闲检查、注册退出清理 |
| `acquireInstanceLock` | 以原子创建方式写锁文件；已有锁且 pid 存活则失败退出 |
| `releaseInstanceLock` | 退出时删除属于本进程的锁与 socket |
| `isPidAlive` | 判断锁中 pid 是否存活 |
| `IdleExit.touch` | 记录最近活动时刻（连接、请求、运行事件） |
| `IdleExit.check` | 按扣除睡眠后的时长判断是否应退出，有活动需求代理时不退出 |
| `installSignalHandlers` | 处理可处理终止信号：停止运行的 Shell、标记运行中断、释放锁后退出 |

### daemon/server.ts
| 函数 | 职责 |
|---|---|
| `DaemonServer.listen` | 在 socket 路径监听，逐连接解码帧 |
| `DaemonServer.handleHello` | 校验协议版本，登记客户端的窗口身份、工作区与仓库集合 |
| `DaemonServer.dispatchMethod` | 按方法名路由到处理器，未知方法返回错误 |
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
`main` → `loadSdk` → `startDaemon` → `DaemonServer.listen`。`startDaemon` 使用 `runtime/identity.ts` 的 `daemonSocketPath`/`daemonLockPath`、`runtime/clock.ts` 的睡眠感知计时、`runtime/run-store.ts` 的 `markInterruptedOnStartup`。窗口侧 `runtime/daemon-client.ts` 的 `spawnDaemon` 按上方启动契约拉起。

## 验证方式
- 测试入口：`tests/helpers/daemon-harness.ts` 的 `startDaemonForTest` / `connectTestClient`；socket 上的 `hello`、`ping`、`shutdown`
- 测试输入：同一仓库并发两次拉起；锁文件含已死 pid；客户端断开后等待超过空闲时限（注入时钟跳变模拟睡眠 5 分钟）；运行目录预置一条 `running` 记录后启动
- 预期结果：只有一个进程存活且两次连接都成功；死锁被清理并正常启动；无连接无运行时超过 10 分钟退出并删除锁与 socket；睡眠跳变不计入空闲时长；预置记录在启动后变为 `interrupted`
- [ ] 并发拉起单实例
- [ ] 死锁清理
- [ ] 空闲退出与睡眠扣除
- [ ] 存在暂停或等待答复运行时不退出
- [ ] 启动标记中断
- [ ] SDK 目录缺失或版本不足时以非零退出并给出原因
