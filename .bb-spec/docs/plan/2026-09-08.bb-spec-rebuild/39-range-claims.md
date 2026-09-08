---
name: range-claims
description: 工作范围声明：文件锁下原子申请多范围、独占与等待、释放需持有者确认停止、失联不释放、交接前重新读取与指纹核对
---
# 工作范围声明

## 目标
同仓库内主会话、需求代理与角色对重叠文件的写入同一时间只有一个获准，冲突只影响冲突部分，且交接安全。

## 业务规则（来源：spec）
- range-handoff：多个窗口同时请求重叠写入范围时只允许一个任务取得写入权，适用于主会话、需求代理及角色；不重叠任务不被阻止；没有两边先检查后都成功的竞争。
- range-handoff：等待只等待冲突部分并显示受阻原因，不自动暂停、取消或抢占原任务；原任务安全释放后再允许接手。
- range-handoff：接手时重新读取文件与交付信息，文件已变化不得用旧内容覆盖。
- range-handoff：持有范围的宿主失联或旧运行停止不确定时保留冲突保护并报告原因，不仅凭超时释放。
- range-handoff：多个任务请求交叉重叠的多个范围时避免双方各占一部分互等。

## 涉及文件
- 新建 `runtime/ranges.ts`
- 新建 `tests/range-claims.test.ts`

## 成品定义
```json
// ~/.pi/agent/pi-company/repos/<repoId>/ranges/claims.json
{
  "version": 12,
  "claims": [
    {
      "claimId": "uuid",
      "holder": { "kind": "role", "runId": "uuid", "windowId": "uuid", "requirement": "2026-09-08.slug" },
      "paths": ["src/a.ts", "docs/"],
      "claimedAt": "2026-09-08T10:00:00.000Z",
      "fingerprints": { "src/a.ts": "sha256-hex" }
    }
  ],
  "waiting": [
    { "waitId": "uuid", "holder": { "kind": "main", "windowId": "uuid" }, "paths": ["src/a.ts"], "since": "…" }
  ]
}
```
路径为仓库相对路径；目录以斜杠结尾表示整棵子树。

## 函数清单
### runtime/ranges.ts
| 函数名 | 职责 |
|---|---|
| `RangeClaims` | 绑定仓库数据目录，所有变更在目录锁内读改写 |
| `RangeClaims.claim` | 一次申请多个范围：全部无冲突则整体获准，否则整体不获准并进入等待队列，返回冲突范围与持有者 |
| `RangeClaims.release` | 持有者释放；释放前记录交付指纹 |
| `RangeClaims.wait` | 轮询等待指定范围释放，可取消；返回受阻原因文本 |
| `RangeClaims.holderOf` | 查询某路径当前持有者 |
| `RangeClaims.forceState` | 对失联持有者：只有其运行被确认停止（由调用方给出证据）才释放，否则保持 |
| `overlaps` | 判断两个范围集合是否重叠（文件、目录前缀） |
| `fingerprint` | 计算范围内文件内容指纹 |
| `verifyFingerprint` | 接手前比对指纹，变化则返回差异清单 |

## 协作关系
- 依赖 `runtime/identity.ts`、`runtime/store.ts`（`withDirLock`、CAS 写）、`runtime/windows.ts`（窗口存活）、`runtime/clock.ts`。
- 由 `runtime/write-guard.ts`、`daemon/run-manager.ts`（派工前申请任务写入范围）、`extensions/lifecycle.ts`（主会话文档编辑范围）使用。

## 验证方式
- 测试入口：`RangeClaims`（临时数据目录；并发用两个真实子进程各自调用 `claim`）。
- 测试输入：两个进程同时申请同一文件；申请互不重叠文件；甲持有 A，乙申请 A+B；两个任务以相反顺序申请 A、B；持有者窗口记录失联但运行未确认停止；释放后文件被修改再接手。
- 预期结果：
  - 同文件并发申请恰一个获准；不重叠申请均获准。
  - 乙申请 A+B 整体不获准且不占 B，等待原因指向 A 的持有者；甲释放后乙整体获准。
  - 相反顺序申请不出现各占一个互等，其中一方整体获准另一方等待。
  - 失联持有者的范围在没有停止证据时保持占用并返回原因；给出停止证据后可释放。
  - 接手前 `verifyFingerprint` 报告被修改文件。
- [ ] 并发独占
- [ ] 整体申请与局部等待
- [ ] 交叉范围不互等
- [ ] 失联不释放
- [ ] 指纹核对
