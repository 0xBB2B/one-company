---
name: range-claims
description: 工作范围声明：SQLite 短事务内原子申请多范围、独占与等待、机械证据成立才自动释放失联持有者、否则保留并提供用户显式释放、交接前重新读取与指纹核对
---
# 工作范围声明

## 目标
同仓库内主会话、需求代理与角色对重叠文件的写入同一时间只有一个获准，冲突只影响冲突部分，失联持有者的范围只按机械证据自动释放，交接安全。

## 业务规则（来源：spec）
- range-handoff：多个窗口同时请求重叠写入范围时只允许一个任务取得写入权，适用于主会话、需求代理及角色；不重叠任务不被阻止；没有两边先检查后都成功的竞争。
- range-handoff：等待只等待冲突部分并显示受阻原因，不自动暂停、取消或抢占原任务；原任务安全释放后再允许接手。
- range-handoff：接手时重新读取文件与交付信息，文件已变化不得用旧内容覆盖。
- range-handoff：持有范围的宿主失联或旧运行停止不确定时保留冲突保护并报告原因，不仅凭超时释放；只有可机械判定的证据成立才自动释放，否则由用户显式释放并留决策记录。
- range-handoff：多个任务请求交叉重叠的多个范围时避免双方各占一部分互等。

## 涉及文件
- 新建 `runtime/ranges.ts`
- 新建 `tests/range-claims.test.ts`

## 成品定义
```json

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
  ],
  "released": [
    { "claimId": "uuid", "holder": { "…" : "…" }, "decisionId": "USER-3", "evidence": "run-terminal", "releasedAt": "…", "fingerprints": { "src/a.ts": "sha256-hex" } }
  ]
}
```
路径在入口统一规范化为仓库相对 POSIX 路径（别名 `./a`、`a/../b`、`src//a`、仓库内绝对路径均等价），逃逸仓库根的路径一律拒绝；目录以斜杠结尾表示整棵子树，`a.ts` 与 `a.ts/` 视为重叠。`waiting` 按（持有者, 路径集）去重，本方获准、等待结束或取消时移除。`released` 供接手方核对交付指纹，最多保留 200 条（丢弃最旧）；决策记录本身由调用方写入决策台账。

持有者消失的机械证据：
```
kind=role|requirement：运行记录为终态（completed|failed|stopped）或 interrupted，且 Shell 登记表中该运行无活动或不确定任务
kind=main：窗口登记表 holderGone 成立（已注销 / 心跳过期且开机标识变化 / 进程不存在或启动时刻不符）
任一不成立：保留占用，返回原因；用户可经 releaseByUser 显式释放（需决定编号）
```

## 函数清单
### runtime/ranges.ts
| 函数名 | 职责 |
|---|---|
| `RangeClaims` | 绑定仓库数据目录，所有变更在SQLite 短事务内读改写；构造时注入运行记录读取、窗口登记表与"运行活动任务查询"三个依赖 |
| `RangeClaims.claim` | 一次申请多个范围：规范化路径后在SQLite 短事务内判定，全部无冲突则先写入不带指纹的占位占用（此刻范围已独占），事务外计算指纹，再以短事务核对身份后补写；补写前占位已被释放则返回不获准；补写失败（数据库写入失败、指纹计算抛错）时补偿移除占位并在错误中携带占位标识，不得残留无指纹占位；否则整体不获准并进入等待队列（按持有者与排序后的路径集去重），返回冲突范围与持有者；获准时只移除本方对应该路径集的等待条目 |
| `RangeClaims.release` | 持有者释放：校验调用方持有者与记录一致，不一致拒绝；释放前记录交付指纹到 `released`；重复释放幂等返回未持有 |
| `RangeClaims.wait` | 轮询等待指定范围释放，可取消；持有者必填，结束或取消时只移除本方条目（清理失败不改写原始取消原因）；返回受阻原因文本 |
| `RangeClaims.holderOf` | 查询某路径当前持有者 |
| `RangeClaims.releaseIfHolderGone` | 对指定占用按持有者种类核对机械证据（探针合计预算约 2 秒，小于数据库忙等待上限）：成立即自动释放并返回证据种类；不成立、探针抛错或超时、记录缺少持有者标识时保留并返回原因 |
| `RangeClaims.releaseByUser` | 用户显式释放：要求决定编号，释放并把编号写入释放记录；写决策记录由调用方负责 |
| `overlaps` | 判断两个范围集合是否重叠（文件、目录前缀） |
| `fingerprint` | 计算范围内文件内容指纹：目录递归并为目录范围写一个清单散列键，指向目录的符号链接按目标串参与不递归，FIFO/设备文件记 nonfile:<类型>，不存在记 absent |
| `verifyFingerprint` | 接手前比对指纹，变化则返回差异清单（含目录范围内新增与删除的文件、类型变化；每项只报一次；目录清单散列只覆盖真实文件键，嵌套目录范围顺序无关） |

## 协作关系
- 依赖 `runtime/identity.ts`、`runtime/database.ts`（短事务与版本条件更新）、`runtime/windows.ts`（`holderGone`）、`runtime/run-store.ts`（运行状态）、`runtime/clock.ts`；"运行活动任务查询"由守护进程用 `runtime/shell-registry.ts` 实现、窗口侧经 `shells.list` 实现后注入。
- 由 `runtime/write-guard.ts`、`daemon/run-manager.ts`（派工前申请任务写入范围，运行结束后 `releaseIfHolderGone`）、`extensions/lifecycle.ts`（主会话文档编辑范围）使用；Agents 面板与 Shell 管理页对保留占用提供"显式释放"入口，先写决策记录再调用 `releaseByUser`。

## 验证方式
- 测试入口：`RangeClaims`（临时数据目录；并发用两个真实子进程各自调用 `claim`；注入运行记录、窗口登记表与活动任务桩）
- 测试输入：两个进程同时申请同一文件；申请互不重叠文件；甲持有 A，乙申请 A+B；两个任务以相反顺序申请 A、B；role 持有者运行 stopped 且无活动任务；role 持有者运行 stopped 但登记表仍有一条 uncertain 任务；role 持有者运行 running；main 持有者窗口已注销；main 持有者心跳过期但开机标识相同且进程存在；对保留占用调用 `releaseByUser`（有与无决定编号）；释放后文件被修改再接手
- 预期结果：
  - 同文件并发申请恰一个获准；不重叠申请均获准。
  - 乙申请 A+B 整体不获准且不占 B，等待原因指向 A 的持有者；甲释放后乙整体获准。
  - 相反顺序申请不出现各占一个互等，其中一方整体获准另一方等待。
  - stopped 且无活动任务的 role 持有者与已注销的 main 持有者被自动释放并返回证据种类；仍有 uncertain 任务、运行 running、心跳过期但开机标识相同的三种情况保持占用并返回原因。
  - `releaseByUser` 有决定编号时释放并记录编号，无编号拒绝。
  - 接手前 `verifyFingerprint` 报告被修改文件。
- [x] 并发独占
- [x] 整体申请与局部等待
- [x] 交叉范围不互等
- [x] 机械证据自动释放与不成立保留
- [x] 用户显式释放
- [x] 指纹核对

占用、等待、已释放记录分别存 `range_claims`、`range_waiting`、`range_released` 命名空间，每条记录主键 UUIDv7；聚合视图不另行持久化。
