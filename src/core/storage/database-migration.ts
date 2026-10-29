import { rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createDatabaseSnapshot, DatabaseMaintenanceError, databaseMaintenanceDirectory, withDatabaseMaintenance } from "./database-maintenance.ts";
import type { DatabaseMaintenancePermit, DatabaseMaintenanceScope } from "./database-maintenance.ts";
import { DATABASE_SCHEMA_VERSIONS, indexDatabase, pathExists, repositoryDatabase } from "./database-paths.ts";
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

export const MIGRATABLE_VERSIONS: Readonly<Record<"data" | "index", readonly number[]>> = Object.freeze({ data: [8], index: [1] });

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

function runSteps(path: string, from: number, steps: DataMigrationStep[], backupPath: string | null): void {
  const db = new DatabaseSync(path);
  let step = "";
  try {
    db.exec("BEGIN IMMEDIATE");
    const records: MigrationRecords = {
      list: (namespace) => (db.prepare("SELECT record_key, data FROM records WHERE namespace = ? ORDER BY record_key").all(namespace) as Array<{ record_key: string; data: string }>)
        .map((row) => ({ key: row.record_key, data: JSON.parse(row.data) as unknown })),
      replace: (namespace, key, data) => { db.prepare("UPDATE records SET data = ?, version = version + 1 WHERE namespace = ? AND record_key = ?").run(JSON.stringify(data), namespace, key); },
    };
    for (let version = from; version < DATABASE_SCHEMA_VERSIONS.data; version++) {
      step = `data.db 版本 ${version} → ${version + 1}`;
      steps.find((candidate) => candidate.from === version)!.migrate(records);
      db.exec(`PRAGMA user_version = ${version + 1}`);
    }
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* 事务已不存在时无需回滚 */ }
    const reason = error instanceof Error ? error.message : String(error);
    throw new DatabaseMigrationError("migration_failed", `${step || "data.db 迁移"} 时，${reason}；原库未改动，备份在 ${backupPath}`, reason, step || null, backupPath);
  } finally { db.close(); }
}

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
      const reason = error instanceof DatabaseMaintenanceError ? error.code : error instanceof Error ? error.message : String(error);
      throw new DatabaseMigrationError("migration_failed", `备份 data.db 时失败：${reason}；原库未改动`, reason, "备份 data.db");
    }
    runSteps(join(directory, "data.db"), plan.data.version, steps, backupPath);
    migratedData = true;
  }
  const removedIndex = plan.index.status === "migratable";
  if (removedIndex) for (const suffix of ["", "-wal", "-shm"]) rmSync(join(directory, "index.db") + suffix, { force: true });
  return { backupPath, migratedData, removedIndex };
}
