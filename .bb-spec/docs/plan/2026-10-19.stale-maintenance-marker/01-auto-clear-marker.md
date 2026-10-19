---
name: auto-clear-marker
description: 打开本机数据库或开始维护时，留维护标记的进程确认已不在就清掉标记；清不了时报错写明原因和办法
---
# 自动清掉残留的维护标记

## 目标
留维护标记的进程确认已不在时，打开本机数据库、开始备份或恢复对账都照常成功，标记被程序删掉；判断不了或读不出时报错写明原因和下一步。

## 业务规则（来源：PRD auto-clear-stale-marker）
- 维护标记是维护目录里的隐藏文件 `.database-maintenance.json`（常量 `DATABASE_MAINTENANCE_FILE`），格式 `database-maintenance/v2`，`owner` 里记着进程号 `pid` 和进程身份 `processStartIdentity`。进程身份有两种写法：`pid:<N>:lstart:<启动时间>`（查得到进程启动时间时）和 `pid:<N>:instance:<UUIDv7>`（查不了时的随机实例身份）。
- 判断规则（只看 owner，不看 operationId）：
  - owner.pid 等于当前进程的 pid → 一律按还在处理，不比对身份字符串。
  - lstart 写法：这个进程号已经没有进程，或者有进程但现在查到的身份和标记里不同 → 已不在，可清；身份相同 → 还在；查不了进程且进程号上可能有进程 → 判断不了。
  - instance 写法：进程号已经没有进程 → 已不在，可清；否则 → 判断不了（进程号可能被分给了别的进程，又核对不了启动时间）。
  - 文件读不出、不是 JSON、format/state 不对、owner 缺字段、进程身份的进程号和 owner.pid 对不上 → 读不出。
- C-1：打开本机数据库时发现标记且可清 → 删掉标记，这次打开成功。
- C-2：还在（含本进程自己正在维护）→ 打开失败、标记不动，报错 `本机数据正在备份、恢复或对账（进程 <pid>），等它结束再试`，不含"删除"。
- C-3：判断不了 → 打开失败、标记不动，报错 `判断不了留标记的进程是否还在；确认没有别的窗口在备份、恢复或对账后，删除 <标记文件完整路径>`。
- C-4：读不出 → 打开失败、标记不动，报错 `维护标记读不出；确认没有别的窗口在备份、恢复或对账后，删除 <标记文件完整路径>`。
- 上面三种报错仍用错误码 `maintenance_required`。
- C-5：开始维护（`withDatabaseMaintenance`）时发现已有标记且可清 → 清掉后照常开始；不可清 → 照旧报 `maintenance_already_exists`。
- C-6：两个进程同时发现同一个可清标记 → 两边都成功；另一方先删掉了，就当已清。
- C-7：只删标记文件本身，目录里其他文件不动。清除时不能误删"判断之后别人新放的标记"：删之前要核对要删的仍是判断时读到的那份；核对不上就不删，按判断不了报错，并且不能覆盖或破坏别人新放的标记（标记文件必须保持单一硬链接，别人才读得出）。具体怎么做到原子由实现决定。
- 清掉后不写日志、不留记录（用户 2026-10-19 决定）。

## 涉及文件
- `src/core/storage/maintenance-marker.ts` 新建
- `src/core/storage/database-paths.ts` 修改
- `src/core/storage/database-maintenance.ts` 修改

## 函数清单
### src/core/storage/maintenance-marker.ts
| 函数名 | 职责 |
|---|---|
| `processMissing` | 从 database-maintenance.ts 搬来：判断进程号上是否已经没有进程 |
| `processIdentity` | 从 database-maintenance.ts 搬来：用 `ps` 查进程启动时间，得到 active/missing/unknown |
| `readMarkerOwner` | 按私有文件规则读标记并解析出 owner；读不出时返回读不出 |
| `judgeMarkerOwner` | 按判断规则把 owner 判成可清 / 还在 / 判断不了 |
| `releaseStaleMaintenanceMarker` | 对一个目录执行"读 → 判断 → 核对仍是同一份后删除"，返回已清（含标记已不存在）或不可清的原因（还在带 pid / 判断不了 / 读不出）及标记完整路径 |
| `staleMarkerMessage` | 把不可清的原因写成 C-2/C-3/C-4 的报错文字 |

### src/core/storage/database-paths.ts
| 函数名 | 职责 |
|---|---|
| `assertDatabasePathReady` | 发现标记时调 `releaseStaleMaintenanceMarker`；已清则继续后面的检查，不可清则抛 `DatabaseStorageError("maintenance_required", staleMarkerMessage(...))` |

### src/core/storage/database-maintenance.ts
| 函数名 | 职责 |
|---|---|
| `withDatabaseMaintenance` | 写新标记遇到 EEXIST 时先调 `releaseStaleMaintenanceMarker`，已清就再写一次新标记；不可清抛 `maintenance_already_exists`（接管分支由 plan 02 删除） |
| `ownProcessIdentity` | 改为引用搬走后的 `processIdentity` |

## 协作关系
- maintenance-marker.ts 只依赖 node 内置模块，不引用 database.ts、database-paths.ts、database-maintenance.ts，避免存储层文件之间互相引用成环（database.ts 引用 database-paths.ts，database-maintenance.ts 在模块加载时就调用 `uuidv7`）。标记文件名由调用方传入完整路径。
- `assertDatabasePathReady` 被 `database.ts`、`run-metadata.ts`、`index-store.ts` 调用，所有打开本机数据库的地方都经过它。

## 验证方式
- 测试入口：`new LocalDatabase(<data.db 路径>)` / `withDatabase(...)`（`src/core/storage/database.ts`）、`withDatabaseMaintenance`（`src/core/storage/database-maintenance.ts`）、project-manage 工具的 backup / recovery-check（参照 `tests/project-manage-tool.test.ts` 的 `requirementWorld`）。
- 测试输入：在数据目录写 `.database-maintenance.json`（权限 0600），内容 `{"format":"database-maintenance/v2","operationId":<UUIDv7>,"state":"maintenance","owner":{"pid":<N>,"processStartIdentity":<身份>},"ownershipEpoch":1,"createdAt":<ISO 时间>}`。
  - 已退出进程：spawn 一个子进程后杀掉，用它的 pid 和 `pid:<pid>:lstart:Thu Jan  1 00:00:00 2026`。
  - 启动时间不同：spawn 一个保持存活的子进程，用它的 pid 和一个与它真实启动时间不同的 `pid:<子进程 pid>:lstart:Thu Jan  1 00:00:00 2026`；测完杀掉子进程。
  - 判断不了：spawn 一个保持存活的子进程，用它的 pid 和 `pid:<子进程 pid>:instance:<UUIDv7>`；测完杀掉子进程。
  - 记着本进程：用 `process.pid` 和任意 lstart 身份 → 按还在处理。
  - 读不出：内容 `{}` 或 `{"state":"external"}`。
  - 还在：本进程在 `withDatabaseMaintenance` 回调里，从另一个连接打开同一个库。
- 预期结果：
  - [ ] C-1：已退出进程、启动时间不同 → 打开成功，标记文件不存在。
  - [ ] C-2：本进程正在维护时另一个连接打开、或标记记着本进程 pid 时打开 → 报错含 `maintenance_required`、`正在备份、恢复或对账`、本进程 pid、`等它结束再试`，不含 `删除`；标记仍在。
  - [ ] C-3：报错含 `判断不了留标记的进程是否还在` 和标记文件完整路径；标记仍在。
  - [ ] C-4：报错含 `维护标记读不出` 和标记文件完整路径；标记内容不变。
  - [ ] C-5：留下可清标记后 `withDatabaseMaintenance(scope, () => null)` 成功；project-manage backup → `completed`；recovery-check → `restart_ready`。
  - [ ] C-6：留下可清标记后，两个子进程同时打开同一个库 → 都成功退出。
  - [ ] C-7：留下可清标记和 `backups/<任意编号>/x.txt` → 打开后标记不存在，`x.txt` 还在。
