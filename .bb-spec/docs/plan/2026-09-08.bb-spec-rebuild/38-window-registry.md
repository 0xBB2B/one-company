---
name: window-registry
description: 窗口登记表：按仓库记录窗口进程、会话与工作区，睡眠感知心跳，区分失联与已注销
---
# 窗口登记表

## 目标
同仓库的各窗口能在本机看到彼此的存在与工作区，失联判定不被睡眠误触发。

## 业务规则（来源：spec）
- window-ownership：同一工作目录中各主会话登记负责的需求、阶段与工作范围，必要协作信息在后台共享；工作区内窗口可见可控本工作区需求代理，工作区外不可见。
- range-handoff：持有范围的宿主失联不自动释放；超时、失联和已停止必须分开。
- daemon-host：心跳与失联判定扣除睡眠间隔。
- local-ownership：流程数据保存在本机用户数据区，按仓库归属。

## 涉及文件
- 新建 `runtime/windows.ts`
- 新建 `tests/window-registry.test.ts`

## 成品定义
```json
// ~/.pi/agent/pi-company/repos/<repoId>/windows/<windowId>.json
{
  "windowId": "uuid",
  "pid": 12345,
  "sessionId": "pi 会话标识",
  "cwd": "/abs/path",
  "workspaceRoot": "/abs/path",
  "startedAt": "2026-09-08T10:00:00.000Z",
  "heartbeatAt": "2026-09-08T10:05:00.000Z",
  "heartbeatSeq": 61
}
```
失联判定：连续 3 个心跳周期无更新且期间无睡眠间隔；已注销 = 文件被删除。

## 函数清单
### runtime/windows.ts
| 函数名 | 职责 |
|---|---|
| `WindowRegistry` | 绑定仓库数据目录，读写窗口记录 |
| `WindowRegistry.register` | 原子写入新记录，返回窗口标识 |
| `WindowRegistry.heartbeat` | 更新心跳时间与序号，写入前核对文件仍属本窗口 |
| `WindowRegistry.unregister` | 删除记录（幂等） |
| `WindowRegistry.list` | 列出全部记录并附 `alive` / `lost` / 进程不存在判定 |
| `WindowRegistry.isAlive` | 单窗口判定：心跳新鲜或进程存在且处于睡眠间隔内 |
| `startHeartbeat` | 用睡眠感知时钟每 5 秒心跳，返回停止函数 |

## 协作关系
- 依赖 `runtime/identity.ts`（`repoDataDir`）、`runtime/store.ts`（原子写）、`runtime/clock.ts`。
- 由 `extensions/lifecycle.ts` 登记与心跳；`runtime/ranges.ts` 与 `daemon/relay-queue.ts` 读取以判断窗口存活与投递目标。

## 验证方式
- 测试入口：`WindowRegistry`、`startHeartbeat`（注入可控时钟）。
- 测试输入：两个窗口登记；一个窗口停止心跳 20 秒；注入 10 分钟睡眠间隔后恢复心跳；进程不存在的记录；并发心跳。
- 预期结果：
  - 登记后 `list` 返回两条且 `alive`；停止心跳 20 秒后该窗口为 `lost`。
  - 睡眠间隔内未心跳不判 `lost`，唤醒后首个心跳恢复 `alive`。
  - 进程不存在的记录标为已死；`unregister` 两次不报错。
  - 心跳文件内容始终为合法记录（并发写不产生半文件）。
- [ ] 登记与存活判定
- [ ] 睡眠不判失联
- [ ] 进程消失与幂等注销
- [ ] 并发写原子
