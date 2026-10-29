---
name: migration-runner
description: 存储层迁移执行器：读库版本、判断能否迁移、加维护标记后备份 data.db、在一次事务里跑转换步骤、删旧 index.db
---
# 存储层迁移执行器

## 目标
`src/core/storage` 能告诉调用方某个仓库的 `data.db`、`index.db` 是不是可迁移的旧版本，并在维护标记保护下完成一次迁移：先备份 `data.db`，再在一次事务里跑由上层注入的转换步骤并把版本号改成当前版本；`index.db` 旧时删掉。失败时库原样不动。

## 业务规则（来源：PRD）
- 当前版本：`data.db` 9、`index.db` 2（`DATABASE_SCHEMA_VERSIONS`）。可迁移的旧版本：`data.db` 8、`index.db` 1。`data.db` 1–7 太旧，不能迁移。（migration-prompt / unmigratable-errors）
- 库文件不存在、或已是当前版本时，不需要迁移。
- 迁移 `data.db` 前先把旧库复制到 `<仓库本机数据目录>/backups/<编号>/data.db`，复制成功才开始改；备份里是版本 8 的原样数据。只迁移 `index.db` 时不备份。
- `data.db` 的转换在一次事务里完成：任何一条记录转换失败，所有改动都不写入，版本号和内容保持原样，此时 `index.db` 也不删。
- `index.db` 版本 1 的迁移是删掉 `index.db` 及其 `-wal`、`-shm` 文件，由守护进程以后按当前格式重建。
- 迁移进行中，别的进程打不开这个库：整个"再次核对版本 → 备份 → 转换 → 删索引"在维护标记（`withDatabaseMaintenance`，数据目录里的 `.database-maintenance.json`）保护下进行。拿不到维护标记（别人正在迁移）时，调用方要能等它结束后重新核对。
- 失败报错写明失败的那一步（如"data.db 版本 8 → 9"）和转换步骤给出的原因（含需求编号、原型名），以及已备份时备份的完整路径。
- 代码只认当前格式：执行器不让普通的 `LocalDatabase` 打开旧库，迁移用独立的原生连接完成。

## 涉及文件
- 新建 `src/core/storage/database-migration.ts`
- 修改 `src/core/storage/database-maintenance.ts`（`createDatabaseSnapshot` 允许给迁移备份旧版本）
- 新建 `tests/database-migration.test.ts`

## 成品定义
`src/core/storage/database-migration.ts` 对外的类型契约（plan 02、03 按它实现和调用，exec 原样落盘，可按项目风格调整换行）：

```ts
import type { DatabaseKind } from "./database-paths.ts";

/** 一条 records 表记录，data 为解析后的 JSON。 */
export interface MigrationRecord { key: string; data: unknown }

/** 转换步骤在事务内读写 records 表的入口。 */
export interface MigrationRecords {
  list(namespace: string): MigrationRecord[];
  replace(namespace: string, key: string, data: unknown): void;
}

/** 由上层注入的 data.db 转换步骤：from → from + 1。转换失败时抛 Error，message 写清哪条记录、为什么。 */
export interface DataMigrationStep {
  from: number;
  /** 迁移会丢掉的数据，每项一句话，显示在迁移框里。 */
  losses: string[];
  migrate(records: MigrationRecords): void;
}

export type DatabaseVersionState =
  | { kind: DatabaseKind; status: "missing" | "current" }
  | { kind: DatabaseKind; status: "migratable" | "too_old"; version: number; target: number };

export interface MigrationPlan { data: DatabaseVersionState; index: DatabaseVersionState }

export interface MigrationReceipt { backupPath: string | null; migratedData: boolean; removedIndex: boolean }
```

## 函数清单
### src/core/storage/database-migration.ts
| 函数名 | 职责 |
|---|---|
| `MIGRATABLE_VERSIONS` | 常量：每种库可迁移的旧版本（data: [8]，index: [1]），plan 04 的报错也读它 |
| `readMigrationPlan` | 按仓库编号只读打开 `data.db`、`index.db`，读出版本号，归类成 missing / current / migratable / too_old |
| `needsMigrationPrompt` | 判断一份 `MigrationPlan` 该不该弹框：`data.db` too_old 时不弹；任一库 migratable 时弹 |
| `withMigrationLock` | 用 `withDatabaseMaintenance` 给仓库本机数据目录加维护标记后执行回调（plan 03 在弹框和迁移期间一直持有它）；标记被活着的进程占着时抛 `migration_busy` |
| `migrateRepositoryDatabases` | 必须在 `withMigrationLock` 的回调里调用（凭 permit）：再次读版本（已是当前就直接返回）→ 需要时备份 data.db → 事务内按 `from` 依次跑步骤并改 `user_version` → 删旧 index.db；返回 `MigrationReceipt` |
| `DatabaseMigrationError` | 迁移失败的错误类：带 `step`（如"data.db 版本 8 → 9"）、`backupPath`、原因文字；code 区分 `migration_failed`、`migration_busy`（拿不到维护标记）、`missing_step` |

### src/core/storage/database-maintenance.ts
| 函数名 | 职责 |
|---|---|
| `createDatabaseSnapshot` | 增加一个可选参数：允许源库是指定的旧版本（只给迁移用），其余校验不变 |

## 协作关系
- `withMigrationLock` 调 `withDatabaseMaintenance`（维护目录 = 仓库本机数据目录，`worktreeRoots` 由调用方传入）；`migrateRepositoryDatabases` 在它给的 permit 内调 `createDatabaseSnapshot(permit, "data", 允许版本 8)` 备份。
- 转换用 `node:sqlite` 的 `DatabaseSync` 原生连接 `BEGIN IMMEDIATE` … `COMMIT`；`MigrationRecords.replace` 更新 `records.data` 并把 `version` 列加 1；出错 `ROLLBACK`，把错误包成 `DatabaseMigrationError`。
- 维护标记已存在且属于活着的进程时，`withDatabaseMaintenance` 抛 `maintenance_already_exists`，执行器转成 `migration_busy`，由 plan 03 的调用方等待重试。
- 不依赖任何 `src/modules/*`；具体转换步骤由调用方注入。

## 验证方式
- 测试入口：`readMigrationPlan`、`needsMigrationPrompt`、`withMigrationLock` + `migrateRepositoryDatabases`（包级入口），用临时目录 `temporaryRoot()` 下手工建好的 SQLite 文件（设 `application_id`、`user_version`，建 `records` 表并插入 JSON 记录）。
- 测试输入：data.db 版本 8/9/5/不存在 × index.db 版本 1/2/不存在 的组合；一个把某 namespace 记录加字段的假步骤；一个对某条记录抛错的假步骤；预先放一个属于当前进程的维护标记。
- 预期结果：
- [ ] 版本 8 / 1 归为 migratable（target 9 / 2），9 / 2 为 current，文件不存在为 missing，data 版本 5 为 too_old
- [ ] `needsMigrationPrompt`：任一 migratable 且 data 不是 too_old 时为 true；data too_old 时为 false；都 current/missing 时为 false
- [ ] 迁移 data 8 → 9 成功：`backups/<编号>/data.db` 存在且 `user_version` 是 8、记录与迁移前一致；原库 `user_version` 是 9，被替换的记录 `version` 列加 1，其他记录不变
- [ ] 只有 index 旧：不产生备份，`index.db`、`-wal`、`-shm` 被删，`data.db` 不变；receipt 的 `backupPath` 为 null
- [ ] 步骤对某条记录抛错：原库 `user_version` 仍是 8、所有记录逐条与迁移前相同，`index.db` 仍在；抛出的 `DatabaseMigrationError` 含"data.db 版本 8 → 9"、步骤给的原因、备份完整路径
- [ ] 缺少 from=8 的步骤：抛 `missing_step`，库不变
- [ ] 维护标记被活着的进程占着：`withMigrationLock` 抛 `migration_busy`，回调没有执行，库不变；回调结束（成功或抛错）后维护标记被删除
- [ ] 在 `withMigrationLock` 回调执行期间，用 `LocalDatabase` 打开这个目录的 `data.db` 被拒绝
- [ ] 两个库都已是当前版本时调用：不备份、不改动，receipt 三项都是"没做"
