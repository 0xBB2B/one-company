---
name: remove-takeover
description: 删除被自动清取代、全仓没有调用方的维护标记接管写法
---
# 删除维护标记的接管写法

## 目标
维护标记只剩一条处理残留的路径：plan 01 的自动清除。原来的"接管"写法（带旧编号和授权回调接手残留标记、续做维护）连同它专用的类型、报错和检查一起删掉。

## 业务规则（来源：PRD auto-clear-stale-marker 及本次实施）
- 接管写法全仓没有任何调用方：`withDatabaseMaintenance` 的 `scope.takeover` 只在测试里传过。它原本服务于"强杀后用原编号续做备份、恢复"，而备份、恢复已改成中断后从头再来，不再续做。
- plan 01 让 `withDatabaseMaintenance` 遇到残留标记时先自动清再开始。接管分支再留着，就是处理同一件事的两套写法并存，项目规矩要求不做向后兼容、不用的直接删。
- 删除后的行为：`withDatabaseMaintenance` 遇到已有标记，可清 → 清掉后开始；不可清 → 报 `maintenance_already_exists`。不再有 `maintenance_owner_active`、`maintenance_owner_unknown`、`maintenance_takeover_unauthorized`、`maintenance_operation_mismatch` 这几个报错。
- 维护标记的写入格式不变（仍是 `database-maintenance/v2`，`ownershipEpoch` 固定写 1），只是不再写 `takeover` 字段。

## 涉及文件
- `src/core/storage/database-maintenance.ts` 修改
- `src/core/storage/database-recovery.ts` 修改

## 函数清单
### src/core/storage/database-maintenance.ts
| 函数名 | 职责 |
|---|---|
| `DatabaseMaintenanceScope` | 删除 `takeover` 字段，`operationId` 的注释只保留"首次维护可固定操作身份" |
| `DatabaseManagementAuthorization` | 删除（只被接管用） |
| `takeoverMarker` | 删除 |
| `parseMaintenanceMarker` | 删除（读标记改由 maintenance-marker.ts 负责） |
| `Maintenance` / `MaintenanceMarker` | 删除 `takeover` 字段 |
| `databaseMaintenanceDirectory` | 删除 `operationId` 参数和接管时的编号核对 |
| `createDatabaseSnapshot` | 删除接管时拒绝快照的检查 |
| `withDatabaseMaintenance` | 删除接管分支和 `tookOver` 状态 |

### src/core/storage/database-recovery.ts
| 函数名 | 职责 |
|---|---|
| `reconcileDatabaseRecovery` | 调 `databaseMaintenanceDirectory` 时不再传 `request.operationId`（含 `recheckScope`） |

## 协作关系
- `databaseMaintenanceDirectory` 的调用方：`database-recovery.ts`、`requirement-backup.ts`、`requirement-recovery.ts`、`project-maintenance.ts`；只有 database-recovery.ts 传了第二个参数。
- 删完后在 `src/` 里搜 `takeover`、`DatabaseManagementAuthorization`、`maintenance_owner_`、`maintenance_takeover_unauthorized`、`maintenance_operation_mismatch`，应当没有和维护标记相关的命中（PM 租约的 takeover 是另一回事，不动）。

## 验证方式
- 测试入口：`withDatabaseMaintenance`、`reconcileDatabaseRecovery`、`createDatabaseSnapshot`（`src/core/storage/` 下对应文件）。
- 测试输入：沿用 `tests/database-transition.test.ts` 的 `world()` 搭建；用 spawn 子进程在 `withDatabaseMaintenance` 里挂住、再 SIGKILL 的写法制造残留标记。
- 预期结果：
  - [ ] 子进程还挂在维护里时，本进程 `withDatabaseMaintenance(scope, () => null)` → `maintenance_already_exists`，标记仍是子进程的。
  - [ ] SIGKILL 子进程后，本进程 `withDatabaseMaintenance(scope, (permit) => reconcileDatabaseRecovery(permit, { operationId, mode: "current_restart" }))` → 成功，`restart_ready`；结束后标记不存在；子进程写下的其他文件原样保留。
  - [ ] 维护期间写下的标记 JSON 没有 `takeover` 字段，`ownershipEpoch` 为 1。
  - [ ] `tests/database-transition.test.ts` 里依赖 `takeover` 参数和 `DatabaseManagementAuthorization` 的旧用例改写为上面的行为或删除（"旧维护标记即使提供接管回调也保持needs_review"改成：格式不对的旧标记 → `withDatabaseMaintenance` 报 `maintenance_already_exists`，标记不动）。
  - [ ] `pnpm run typecheck` 通过；`src/` 里按「协作关系」最后一条搜索无命中。
