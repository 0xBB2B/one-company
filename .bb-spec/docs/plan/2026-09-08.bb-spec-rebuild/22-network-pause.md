---
name: network-pause
description: 模型请求故障分类、按运行的暂停闸门、连通性探测与网络原因暂停的自动续接策略
---
# 网络暂停与自动续接

## 目标
完成后连接中断只暂停受影响运行且保留上下文，网络恢复后自动核对并续接，手动暂停不受影响，认证与额度错误不被当作断网。

## 业务规则（来源：spec）
- pause-control：已识别的连接故障仅暂停受影响运行并标明网络原因；认证失败、额度不足与业务失败保持真实类别；守护进程周期探测连通性，恢复后对网络原因暂停的运行先只读核对结果不明操作再自动继续并经中继通知；手动暂停保持；探测失败不计入错误或返修轮次；控制不依赖模型服务响应。
- daemon-host：合盖睡眠唤醒时失效的请求按连接中断处理并走自动续接。

## 涉及文件
- 新建：`runtime/network-pause.ts`
- 新建：`daemon/probe.ts`
- 新建：`tests/network-pause.test.ts`

## 函数清单
### runtime/network-pause.ts
| 函数 | 职责 |
|---|---|
| `classifyFailure` | 把请求错误归为 connection / auth / quota / business / cancelled，依据错误名、状态码与消息特征 |
| `NetworkPauseGate.requestPause` | 为运行登记暂停及原因（manual / network） |
| `NetworkPauseGate.canProceed` | 每次模型请求或工具执行前检查是否允许继续 |
| `NetworkPauseGate.resume` | 解除指定运行的暂停 |
| `NetworkPauseGate.listPaused` | 按原因列出已暂停运行 |
| `ConnectivityProbe.start` | 按间隔用睡眠感知时钟对模型服务主机发起轻量请求 |
| `ConnectivityProbe.stop` | 停止探测 |
| `ConnectivityProbe.onRecovered` | 从不可达到可达的边沿触发回调 |

### daemon/probe.ts
| 函数 | 职责 |
|---|---|
| `startConnectivityProbe` | 用运行中记录的模型服务主机构造探测目标，恢复时调用运行管理器的自动续接 |

## 协作关系
`daemon/role-session.ts` 与 `daemon/requirement-agent.ts` 在请求前调用 `canProceed`，请求失败时调用 `classifyFailure`；connection 类由 `daemon/run-manager.ts` 置为 `paused_network` 并登记闸门；`ConnectivityProbe.onRecovered` 触发 `RunManager.resumeNetworkPaused`。

## 验证方式
- 测试入口：`classifyFailure`、`NetworkPauseGate`、`ConnectivityProbe`（注入探测函数与时钟）
- 测试输入：ECONNRESET / ENOTFOUND / 超时 / 401 / 429 与额度文案 / 400 业务错误 / AbortError；两个运行分别登记 network 与 manual；探测函数先失败三次再成功；注入 5 分钟时钟跳变
- 预期结果：分类正确；network 运行在 canProceed 时被拦、manual 同样被拦；恢复边沿只触发一次且只解除 network 运行；探测失败不产生错误记录；睡眠跳变不额外触发探测也不计入失败次数
- [ ] 分类表
- [ ] 闸门拦截与解除
- [ ] 恢复边沿只续接网络暂停
- [ ] 探测失败不计错
- [ ] 睡眠不干扰
