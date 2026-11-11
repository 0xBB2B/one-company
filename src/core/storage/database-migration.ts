import { rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { uuidv7 } from "./database.ts";
import { createDatabaseSnapshot, DatabaseMaintenanceError, databaseMaintenanceDirectory, withDatabaseMaintenance } from "./database-maintenance.ts";
import type { DatabaseMaintenancePermit, DatabaseMaintenanceScope } from "./database-maintenance.ts";
import { DATABASE_SCHEMA_VERSIONS, indexDatabase, pathExists, repositoryDatabase } from "./database-paths.ts";
import type { DatabaseKind } from "./database-paths.ts";

/** 一条 records 表记录，data 为解析后的 JSON。 */
export interface MigrationRecord { key: string; version: number; data: unknown }

/** 转换步骤在事务内读写 records 表的入口。 */
export interface MigrationRecords {
  list(namespace: string): MigrationRecord[];
  replace(namespace: string, key: string, data: unknown): void;
  /** 新建一条记录，版本号为 1；键已存在时抛错。 */
  create(namespace: string, key: string, data: unknown): void;
  /** 删除一条记录；不存在时抛错。 */
  remove(namespace: string, key: string): void;
}

/** 由上层注入的 data.db 转换步骤：from → from + 1。转换失败时抛 Error，message 写清哪条记录、为什么。 */
export interface DataMigrationStep {
  from: number;
  /** 迁移会丢掉的数据，每项一句话，显示在迁移框里。 */
  losses: string[];
  /** 数据库事务之前执行的文件搬运；必须可重复执行。records 是前面各步骤转换之后的样子；返回值交给同一步骤的 migrate。 */
  prepareFiles?(context: { dataRoot: string; repoId: string; records: Pick<MigrationRecords, "list"> }): Promise<unknown>;
  migrate(records: MigrationRecords, prepared: unknown): void;
}

export type DatabaseVersionState =
  | { kind: DatabaseKind; status: "missing" | "current" }
  | { kind: DatabaseKind; status: "migratable" | "too_old"; version: number; target: number };

export interface MigrationPlan { data: DatabaseVersionState; index: DatabaseVersionState }

export interface MigrationReceipt { backupPath: string | null; migratedData: boolean; removedIndex: boolean }

export const MIGRATABLE_VERSIONS: Readonly<Record<"data" | "index", readonly number[]>> = Object.freeze({ data: [8, 9, 10], index: [1] });

export class DatabaseMigrationError extends Error {
  readonly code: "migration_failed" | "migration_busy" | "missing_step";
  readonly step: string | null;
  readonly backupPath: string | null;
  readonly reason: string;
  constructor(code: DatabaseMigrationError["code"], message: string, reason: string, step: string | null = null, backupPath: string | null = null) {
    super(message);
    this.name = "DatabaseMigrationError"; this.code = code; this.reason = reason; this.step = step; this.backupPath = backupPath;
  }
}

function readVersionState(path: string, kind: "data" | "index"): DatabaseVersionState {
  if (!pathExists(path)) return { kind, status: "missing" };
  const db = new DatabaseSync(path, { readOnly: true });
  let version: number;
  try { version = Number(db.prepare("PRAGMA user_version").get()?.user_version); } finally { db.close(); }
  const target = DATABASE_SCHEMA_VERSIONS[kind];
  if (MIGRATABLE_VERSIONS[kind].includes(version)) return { kind, status: "migratable", version, target };
  if (kind === "data" && version > 0 && version < Math.min(...MIGRATABLE_VERSIONS.data)) return { kind, status: "too_old", version, target };
  // 空库和比当前还新的库不需要迁移，交给 LocalDatabase 照原样初始化或报错
  return { kind, status: "current" };
}

function readDirectoryPlan(directory: string): MigrationPlan {
  return { data: readVersionState(join(directory, "data.db"), "data"), index: readVersionState(join(directory, "index.db"), "index") };
}

export function readMigrationPlan(dataRoot: string, repoId: string): MigrationPlan {
  return { data: readVersionState(repositoryDatabase(dataRoot, repoId), "data"), index: readVersionState(indexDatabase(dataRoot, repoId), "index") };
}

export function readLockedMigrationPlan(permit: DatabaseMaintenancePermit): MigrationPlan {
  return readDirectoryPlan(databaseMaintenanceDirectory(permit));
}

export function needsMigrationPrompt(plan: MigrationPlan): boolean {
  return plan.data.status !== "too_old" && (plan.data.status === "migratable" || plan.index.status === "migratable");
}

export async function withMigrationLock<T>(scope: DatabaseMaintenanceScope, operation: (permit: DatabaseMaintenancePermit) => T | Promise<T>): Promise<T> {
  try { return await withDatabaseMaintenance(scope, operation); }
  catch (error) {
    if (error instanceof DatabaseMaintenanceError && error.code === "maintenance_already_exists") {
      throw new DatabaseMigrationError("migration_busy", "另一个进程正在迁移这个仓库的本机数据库，请等它结束后再试", "另一个进程正在迁移");
    }
    throw error;
  }
}

const listRecords = (db: DatabaseSync): MigrationRecords["list"] => (namespace) =>
  (db.prepare("SELECT record_key, version, data FROM records WHERE namespace = ? ORDER BY record_key").all(namespace) as Array<{ record_key: string; version: number; data: string }>)
    .map((row) => ({ key: row.record_key, version: Number(row.version), data: JSON.parse(row.data) as unknown }));

function migrationFailure(step: string, error: unknown, backupPath: string | null): DatabaseMigrationError {
  const reason = error instanceof Error ? error.message : String(error);
  return new DatabaseMigrationError("migration_failed", `${step || "data.db 迁移"} 时，${reason}；原库未改动，备份在 ${backupPath}`, reason, step || null, backupPath);
}

function transactionRecords(db: DatabaseSync): MigrationRecords {
  return {
    list: listRecords(db),
    replace: (namespace, key, data) => { db.prepare("UPDATE records SET data = ?, version = version + 1 WHERE namespace = ? AND record_key = ?").run(JSON.stringify(data), namespace, key); },
    create: (namespace, key, data) => { db.prepare("INSERT INTO records (id, namespace, record_key, version, data) VALUES (?, ?, ?, 1, ?)").run(uuidv7(), namespace, key, JSON.stringify(data)); },
    remove: (namespace, key) => {
      if (Number(db.prepare("DELETE FROM records WHERE namespace = ? AND record_key = ?").run(namespace, key).changes) !== 1) throw new Error(`要删除的记录 ${namespace}/${key} 不存在`);
    },
  };
}

const stepLabel = (version: number) => `data.db 版本 ${version} → ${version + 1}`;

async function prepareStepFiles(directory: string, path: string, from: number, steps: DataMigrationStep[], backupPath: string | null): Promise<Map<DataMigrationStep, unknown>> {
  const prepared = new Map<DataMigrationStep, unknown>();
  const dataRoot = dirname(dirname(directory)), repoId = basename(directory);
  for (let version = from; version < DATABASE_SCHEMA_VERSIONS.data; version++) {
    const target = steps.find((candidate) => candidate.from === version)!;
    if (!target.prepareFiles) continue;
    const db = new DatabaseSync(path);
    const step = stepLabel(version);
    try {
      db.exec("BEGIN IMMEDIATE");
      const records = transactionRecords(db);
      for (let earlier = from; earlier < version; earlier++) {
        const previous = steps.find((candidate) => candidate.from === earlier)!;
        previous.migrate(records, prepared.get(previous));
      }
      prepared.set(target, await target.prepareFiles({ dataRoot, repoId, records: { list: records.list } }));
    } catch (error) { throw migrationFailure(step, error, backupPath); }
    finally {
      try { db.exec("ROLLBACK"); } catch { /* 事务已不存在时无需回滚 */ }
      db.close();
    }
  }
  return prepared;
}

function runSteps(path: string, from: number, steps: DataMigrationStep[], prepared: Map<DataMigrationStep, unknown>, backupPath: string | null): void {
  const db = new DatabaseSync(path);
  let step = "";
  try {
    db.exec("BEGIN IMMEDIATE");
    const records = transactionRecords(db);
    for (let version = from; version < DATABASE_SCHEMA_VERSIONS.data; version++) {
      step = stepLabel(version);
      const target = steps.find((candidate) => candidate.from === version)!;
      target.migrate(records, prepared.get(target));
      db.exec(`PRAGMA user_version = ${version + 1}`);
    }
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* 事务已不存在时无需回滚 */ }
    throw migrationFailure(step, error, backupPath);
  } finally { db.close(); }
}

const BACKUP_FAILURE_FALLBACK = "复制 data.db 时出错";
const BACKUP_FAILURE_REASONS: Record<string, string> = {
  invalid_source_file: "data.db 不是只允许当前用户读写的普通文件，复制不了",
  source_changed: "备份时 data.db 被别的进程改了",
  unrecognized_source_layout: "data.db 的版本或用途和预期不符",
  snapshot_check_failed: "备份出来的副本校验没通过",
};

export async function migrateRepositoryDatabases(permit: DatabaseMaintenancePermit, steps: DataMigrationStep[]): Promise<MigrationReceipt> {
  const directory = databaseMaintenanceDirectory(permit);
  const plan = readDirectoryPlan(directory);
  let backupPath: string | null = null;
  let migratedData = false;
  if (plan.data.status === "migratable") {
    for (let version = plan.data.version; version < plan.data.target; version++) {
      if (!steps.some((step) => step.from === version)) {
        throw new DatabaseMigrationError("missing_step", `缺少 data.db 版本 ${version} → ${version + 1} 的迁移步骤`, `缺少 data.db 版本 ${version} → ${version + 1} 的迁移步骤`, `data.db 版本 ${version} → ${version + 1}`);
      }
    }
    try { backupPath = createDatabaseSnapshot(permit, "data", plan.data.version).snapshotPath; }
    catch (error) {
      const reason = error instanceof DatabaseMaintenanceError ? BACKUP_FAILURE_REASONS[error.code] ?? BACKUP_FAILURE_FALLBACK : BACKUP_FAILURE_FALLBACK;
      throw new DatabaseMigrationError("migration_failed", `备份 data.db 时失败：${reason}；原库未改动`, reason, "备份 data.db");
    }
    const prepared = await prepareStepFiles(directory, join(directory, "data.db"), plan.data.version, steps, backupPath);
    runSteps(join(directory, "data.db"), plan.data.version, steps, prepared, backupPath);
    migratedData = true;
  }
  const removedIndex = plan.index.status === "migratable";
  if (removedIndex) for (const suffix of ["", "-wal", "-shm"]) rmSync(join(directory, "index.db") + suffix, { force: true });
  return { backupPath, migratedData, removedIndex };
}
