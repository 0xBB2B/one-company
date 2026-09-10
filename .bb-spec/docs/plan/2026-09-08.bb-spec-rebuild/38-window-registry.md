---
name: window-registry
description: 窗口登记表：按仓库记录窗口进程、会话、工作区与开机标识，睡眠感知心跳，区分失联与已注销，并提供窗口持有者"已消失"的机械判定
---
# 窗口登记表

## 目标
同仓库的各窗口能在本机看到彼此的存在与工作区，失联判定不被睡眠误触发，主会话持有的范围能按机械证据判定持有者已消失。

## 业务规则（来源：spec）
- window-ownership：同一工作目录中各主会话登记负责的需求、阶段与工作范围，必要协作信息在后台共享；工作区内窗口可见可控本工作区需求代理，工作区外不可见。
- range-handoff：持有范围的宿主失联不自动释放；超时、失联和已停止必须分开；只有可机械判定的消失证据才允许自动释放。
- daemon-host：心跳与失联判定扣除睡眠间隔。
- data-ownership：流程数据保存在本机用户数据区，按仓库归属。

## 涉及文件
- 新建 `runtime/windows.ts`
- 新建 `tests/window-registry.test.ts`

## 成品定义
```json

{
  "windowId": "uuid",
  "pid": 12345,
  "processStartedAt": "2026-09-08T09:59:58.000Z",
  "bootId": "<本机开机标识>",
  "sessionId": "pi 会话标识",
  "cwd": "/abs/path",
  "workspaceRoot": "/abs/path",
  "startedAt": "2026-09-08T10:00:00.000Z",
  "heartbeatAt": "2026-09-08T10:05:00.000Z",
  "heartbeatSeq": 61
}
```
失联判定：连续 3 个心跳周期无更新且期间无睡眠间隔；已注销 = 文件被删除。
持有者已消失（任一成立即为机械证据）：记录已注销；心跳过期且记录的 bootId 与当前开机标识不同；pid 不存在或 pid 对应进程的启动时刻与记录不一致。

注入点：`new WindowRegistry({ repoDir, clock, bootId: () => Promise<string>, processStartedAt: (pid: number) => Promise<string | null> })`；心跳周期 5 秒，失联阈值 3 个周期；`list` 的判定字段名为 `liveness`，取值 `alive | lost | gone`；`holderGone` 返回 `{ gone: true, evidence: "unregistered" | "boot-changed" | "pid-missing" | "pid-reused" } | { gone: false, reason }`。

## 函数清单
### runtime/windows.ts
| 函数名 | 职责 |
|---|---|
| `WindowRegistry` | 绑定仓库数据目录，读写窗口记录 |
| `WindowRegistry.register` | 原子写入新记录（含调用方提供的窗口标识 UUID、pid、进程启动时刻、开机标识），返回窗口标识；同一窗口在工作区多个仓库登记时使用同一个标识 |
| `WindowRegistry.heartbeat` | 更新心跳时间与序号，写入前核对文件仍属本窗口 |
| `WindowRegistry.unregister` | 删除记录（幂等） |
| `WindowRegistry.list` | 列出全部记录并附 `alive` / `lost` / `gone` 判定 |
| `WindowRegistry.isAlive` | 单窗口判定：心跳新鲜或进程存在且处于睡眠间隔内 |
| `WindowRegistry.holderGone` | 机械判定窗口持有者已消失：已注销、心跳过期且 bootId 变化、pid 不存在或启动时刻不符；返回成立的证据种类，否则返回"不可判定"与原因 |
| `currentBootId` | 读取本机开机标识（macOS 用 `kern.boottime`，Linux 用 `/proc/sys/kernel/random/boot_id`），不可读时返回明确错误 |
| `processStartedAt` | 读取 pid 的进程启动时刻，用于区分 pid 复用 |
| `startHeartbeat` | 用睡眠感知时钟每 5 秒心跳，返回停止函数 |

## 协作关系
- 依赖 `runtime/identity.ts`（`repoDataDir`）、`runtime/store.ts`（原子写）、`runtime/clock.ts`。
- 由 `extensions/lifecycle.ts` 登记与心跳；`runtime/ranges.ts` 用 `holderGone` 判定主会话持有者，`daemon/relay-queue.ts` 的投递目标筛选读取窗口列表。

## 验证方式
- 测试入口：`WindowRegistry`、`startHeartbeat`、`holderGone`（注入可控时钟、可控开机标识与进程查询）
- 测试输入：两个窗口登记；一个窗口停止心跳 20 秒；注入 10 分钟睡眠间隔后恢复心跳；进程不存在的记录；pid 存在但启动时刻不同的记录；心跳过期且开机标识变化的记录；心跳过期但开机标识相同且进程存在的记录；已注销记录；并发心跳
- 预期结果：
  - 登记后 `list` 返回两条且 `alive`；停止心跳 20 秒后该窗口为 `lost`。
  - 睡眠间隔内未心跳不判 `lost`，唤醒后首个心跳恢复 `alive`。
  - `holderGone` 对进程不存在、启动时刻不符、心跳过期且开机标识变化、已注销四种情况分别返回成立与证据种类；对心跳过期但开机标识相同且进程存在的记录返回不可判定并附原因；`unregister` 两次不报错。
  - 心跳文件内容始终为合法记录（并发写不产生半文件）。
- [x] 登记与存活判定
- [x] 睡眠不判失联
- [x] 持有者消失的机械判定
- [x] 进程消失与幂等注销
- [x] 并发写原子

窗口保存在仓库数据库 `windows` 命名空间，主键为 UUIDv7 windowId。心跳与注销在短事务内完成；迟到心跳不创建记录；身份或结构错误拒绝更新。
