import { afterEach, expect, test } from "vitest";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { LocalDatabase, uuidv7 } from "../src/core/storage/database.ts";
import { DATABASE_APPLICATION_IDS, DATABASE_MAINTENANCE_FILE, DATABASE_SCHEMA_VERSIONS } from "../src/core/storage/database-paths.ts";
import {
  DatabaseMigrationError, MIGRATABLE_VERSIONS, migrateRepositoryDatabases, needsMigrationPrompt, readMigrationPlan, withMigrationLock,
} from "../src/core/storage/database-migration.ts";
import type { DataMigrationStep, MigrationPlan } from "../src/core/storage/database-migration.ts";
import { temporaryRoot } from "./helpers/temporary-root.ts";
import { STALE_LSTART, aliveChild, killChild, writeMarker } from "./helpers/maintenance-marker.ts";

process.umask(0o077);
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

const repoId = "b".repeat(64);
const ID_CONSTRAINT = `length(id) = 36 AND substr(id,15,1) = '7' AND substr(id,20,1) IN ('8','9','a','b')`;

async function world() {
  const root = await mkdtemp(join(temporaryRoot(), "db-migration-")); roots.push(root);
  const dataRoot = join(root, "data"), workspace = join(root, "workspace");
  await mkdir(dataRoot, { mode: 0o700 }); await mkdir(workspace, { mode: 0o700 });
  const directory = join(dataRoot, "repos", repoId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  return {
    dataRoot, directory, scope: { directory, worktreeRoots: [workspace] },
    dataPath: join(directory, "data.db"), indexPath: join(directory, "index.db"),
  };
}
const expectBackupPath = (w: Awaited<ReturnType<typeof world>>, path: string | null) => {
  const prefix = join(w.directory, "backups") + "/";
  expect(path?.startsWith(prefix)).toBe(true);
  expect(path!.slice(prefix.length)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/data\.db$/);
  expect(existsSync(path!)).toBe(true);
};

async function createDatabase(path: string, kind: "data" | "index", version: number, rows: Array<[string, string, unknown]> = []) {
  const db = new DatabaseSync(path);
  try {
    db.exec(`CREATE TABLE records (
      id TEXT PRIMARY KEY NOT NULL CHECK (${ID_CONSTRAINT}), namespace TEXT NOT NULL, record_key TEXT NOT NULL,
      version INTEGER NOT NULL CHECK (version > 0), data TEXT NOT NULL CHECK (json_valid(data)), UNIQUE (namespace, record_key)
    ) STRICT;`);
    const insert = db.prepare("INSERT INTO records (id, namespace, record_key, version, data) VALUES (?, ?, ?, 3, ?)");
    for (const [namespace, key, data] of rows) insert.run(uuidv7(), namespace, key, JSON.stringify(data));
    db.exec(`PRAGMA application_id = ${DATABASE_APPLICATION_IDS[kind]}; PRAGMA user_version = ${version};`);
  } finally { db.close(); }
  await writeFile(path, await readFile(path), { mode: 0o600 });
}

function dump(path: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return {
      version: Number(db.prepare("PRAGMA user_version").get()?.user_version),
      records: db.prepare("SELECT id, namespace, record_key, version, data FROM records ORDER BY namespace, record_key").all().map((row) => ({ ...row })),
    };
  } finally { db.close(); }
}

const ROWS: Array<[string, string, unknown]> = [["tasks", "T-1", { title: "旧一" }], ["tasks", "T-2", { title: "旧二" }], ["notes", "N-1", { text: "不动" }]];
const renameTitles: DataMigrationStep = {
  from: 8, losses: [],
  migrate(records) {
    for (const record of records.list("tasks")) records.replace("tasks", record.key, { title: `新${(record.data as { title: string }).title}` });
  },
};

async function oldWorld(options: { data?: boolean; index?: boolean } = { data: true, index: true }) {
  const w = await world();
  if (options.data) await createDatabase(w.dataPath, "data", 8, ROWS);
  if (options.index) {
    await createDatabase(w.indexPath, "index", 1);
    await writeFile(`${w.indexPath}-wal`, "", { mode: 0o600 });
    await writeFile(`${w.indexPath}-shm`, "", { mode: 0o600 });
  }
  return w;
}

const migrate = async (w: Awaited<ReturnType<typeof world>>, steps: DataMigrationStep[]) =>
  withMigrationLock(w.scope, async (permit) => await migrateRepositoryDatabases(permit, steps));

test("可迁移版本表：data 为 8，index 为 1", () => {
  expect(MIGRATABLE_VERSIONS.data).toEqual([8]);
  expect(MIGRATABLE_VERSIONS.index).toEqual([1]);
});

test("data 版本 8、index 版本 1 判为 migratable 并带目标版本", async () => {
  const w = await oldWorld();
  expect(readMigrationPlan(w.dataRoot, repoId)).toEqual({
    data: { kind: "data", status: "migratable", version: 8, target: DATABASE_SCHEMA_VERSIONS.data },
    index: { kind: "index", status: "migratable", version: 1, target: DATABASE_SCHEMA_VERSIONS.index },
  });
  expect(DATABASE_SCHEMA_VERSIONS.data).toBe(9);
  expect(DATABASE_SCHEMA_VERSIONS.index).toBe(2);
});

test("当前版本判为 current，文件不存在判为 missing", async () => {
  const w = await world();
  await createDatabase(w.dataPath, "data", 9, ROWS);
  const plan = readMigrationPlan(w.dataRoot, repoId);
  expect(plan.data).toEqual({ kind: "data", status: "current" });
  expect(plan.index).toEqual({ kind: "index", status: "missing" });
});

test("data 版本 5 判为 too_old", async () => {
  const w = await world();
  await createDatabase(w.dataPath, "data", 5, ROWS);
  expect(readMigrationPlan(w.dataRoot, repoId).data).toEqual({ kind: "data", status: "too_old", version: 5, target: 9 });
});

test("needsMigrationPrompt：有可迁移的库且 data 不过旧时为 true", async () => {
  const w = await oldWorld();
  expect(needsMigrationPrompt(readMigrationPlan(w.dataRoot, repoId))).toBe(true);
});

test("版本 0 的空库和比当前还新的库判为 current，交给打开库的逻辑处理", async () => {
  const w = await world();
  await writeFile(w.dataPath, "", { mode: 0o600 });
  await createDatabase(w.indexPath, "index", 3);
  expect(readMigrationPlan(w.dataRoot, repoId)).toEqual({ data: { kind: "data", status: "current" }, index: { kind: "index", status: "current" } });
});

test("needsMigrationPrompt：data 不存在、只有 index 旧时为 true", async () => {
  const w = await oldWorld({ index: true });
  expect(needsMigrationPrompt(readMigrationPlan(w.dataRoot, repoId))).toBe(true);
});

test("needsMigrationPrompt：data 过旧时为 false", async () => {
  const w = await world();
  await createDatabase(w.dataPath, "data", 5, ROWS);
  await createDatabase(w.indexPath, "index", 1);
  expect(needsMigrationPrompt(readMigrationPlan(w.dataRoot, repoId))).toBe(false);
});

test("needsMigrationPrompt：都是 current 或 missing 时为 false", async () => {
  const plan: MigrationPlan = { data: { kind: "data", status: "current" }, index: { kind: "index", status: "missing" } };
  expect(needsMigrationPrompt(plan)).toBe(false);
});

test("data 8 → 9 成功：备份是版本 8 原样数据，原库升到 9，被替换记录 version 加 1，其他不变", async () => {
  const w = await oldWorld({ data: true });
  const before = dump(w.dataPath);
  const receipt = await migrate(w, [renameTitles]);
  expect(receipt.migratedData).toBe(true);
  expectBackupPath(w, receipt.backupPath);
  expect(dump(receipt.backupPath!)).toEqual(before);
  const after = dump(w.dataPath);
  expect(after.version).toBe(9);
  const byKey = (rows: typeof before.records, key: string) => rows.find((row) => row.record_key === key)!;
  for (const key of ["T-1", "T-2"]) {
    expect(byKey(after.records, key).version).toBe(byKey(before.records, key).version + 1);
    expect(byKey(after.records, key).id).toBe(byKey(before.records, key).id);
  }
  expect(JSON.parse(byKey(after.records, "T-1").data)).toEqual({ title: "新旧一" });
  expect(byKey(after.records, "N-1")).toEqual(byKey(before.records, "N-1"));
});

test("只有 index 旧：不备份，删掉 index.db 及 -wal、-shm，data.db 不变", async () => {
  const w = await world();
  await createDatabase(w.dataPath, "data", 9, ROWS);
  await createDatabase(w.indexPath, "index", 1);
  await writeFile(`${w.indexPath}-wal`, "", { mode: 0o600 });
  await writeFile(`${w.indexPath}-shm`, "", { mode: 0o600 });
  const before = dump(w.dataPath);
  const receipt = await migrate(w, [renameTitles]);
  expect(receipt).toEqual({ backupPath: null, migratedData: false, removedIndex: true });
  expect(existsSync(join(w.directory, "backups"))).toBe(false);
  for (const suffix of ["", "-wal", "-shm"]) expect(existsSync(w.indexPath + suffix)).toBe(false);
  expect(dump(w.dataPath)).toEqual(before);
});

test("data 和 index 都旧：data 迁移成功后 index.db 被删", async () => {
  const w = await oldWorld();
  const receipt = await migrate(w, [renameTitles]);
  expectBackupPath(w, receipt.backupPath);
  expect(receipt).toEqual({ backupPath: receipt.backupPath, migratedData: true, removedIndex: true });
  expect(existsSync(w.indexPath)).toBe(false);
});

test("步骤对某条记录抛错：原库版本和记录原样，index.db 仍在，报错写明步骤、原因和备份路径", async () => {
  const w = await oldWorld();
  const before = dump(w.dataPath);
  const failing: DataMigrationStep = {
    from: 8, losses: [],
    migrate(records) {
      records.replace("tasks", "T-1", { title: "已改" });
      throw new Error("T-2 缺少 owner 字段");
    },
  };
  const error = await migrate(w, [failing]).then(() => undefined, (e: unknown) => e);
  expect(error).toBeInstanceOf(DatabaseMigrationError);
  const failure = error as DatabaseMigrationError;
  expect(failure.code).toBe("migration_failed");
  expect(failure.message).toContain("data.db 版本 8 → 9");
  expect(failure.message).toContain("T-2 缺少 owner 字段");
  expect(failure.step).toContain("data.db 版本 8 → 9");
  expectBackupPath(w, failure.backupPath);
  expect(failure.message).toContain(failure.backupPath!);
  expect(dump(w.dataPath)).toEqual(before);
  expect(existsSync(w.indexPath)).toBe(true);
  expect(existsSync(join(w.directory, DATABASE_MAINTENANCE_FILE))).toBe(false);
});

test("缺少 from=8 的步骤：报 missing_step，库不变", async () => {
  const w = await oldWorld();
  const before = dump(w.dataPath);
  const error = await migrate(w, [{ ...renameTitles, from: 7 }]).then(() => undefined, (e: unknown) => e);
  expect(error).toBeInstanceOf(DatabaseMigrationError);
  expect((error as DatabaseMigrationError).code).toBe("missing_step");
  expect(dump(w.dataPath)).toEqual(before);
  expect(existsSync(w.indexPath)).toBe(true);
});

test("维护标记被活着的进程占着：加锁报 migration_busy，回调不执行，库不变，标记不动", async () => {
  const w = await oldWorld(); const child = await aliveChild();
  try {
    const marker = await writeMarker(w.directory, child.pid!, `pid:${child.pid}:instance:${uuidv7()}`);
    const before = dump(w.dataPath);
    let called = false;
    const error = await withMigrationLock(w.scope, async () => { called = true; }).then(() => undefined, (e: unknown) => e);
    expect(error).toBeInstanceOf(DatabaseMigrationError);
    expect((error as DatabaseMigrationError).code).toBe("migration_busy");
    expect(called).toBe(false);
    expect(dump(w.dataPath)).toEqual(before);
    expect(existsSync(marker)).toBe(true);
  } finally { await killChild(child); }
});

test("记着启动时间对不上的存活进程的标记视为过期，可以加锁", async () => {
  const w = await oldWorld(); const child = await aliveChild();
  try {
    await writeMarker(w.directory, child.pid!, `pid:${child.pid}:lstart:${STALE_LSTART}`);
    await expect(withMigrationLock(w.scope, async () => "done")).resolves.toBe("done");
  } finally { await killChild(child); }
});

test("回调正常结束后维护标记被删除，并返回回调结果", async () => {
  const w = await oldWorld();
  const result = await withMigrationLock(w.scope, async () => 42);
  expect(result).toBe(42);
  expect(existsSync(join(w.directory, DATABASE_MAINTENANCE_FILE))).toBe(false);
});

test("回调抛错后维护标记被删除，错误原样抛出", async () => {
  const w = await oldWorld();
  await expect(withMigrationLock(w.scope, async () => { throw new Error("回调失败"); })).rejects.toThrow("回调失败");
  expect(existsSync(join(w.directory, DATABASE_MAINTENANCE_FILE))).toBe(false);
});

test("回调执行期间别的连接打不开该目录的 data.db", async () => {
  const w = await world();
  await createDatabase(w.dataPath, "data", 9, ROWS);
  await withMigrationLock(w.scope, async () => {
    expect(existsSync(join(w.directory, DATABASE_MAINTENANCE_FILE))).toBe(true);
    expect(() => new LocalDatabase(w.dataPath)).toThrow(expect.objectContaining({ code: "maintenance_required" }));
  });
});

test("备份 data.db 失败：报错写明是备份这一步，两个库都不变", async () => {
  const w = await oldWorld();
  await chmod(w.dataPath, 0o644);
  const before = dump(w.dataPath);
  const error = await migrate(w, [renameTitles]).then(() => undefined, (e: unknown) => e);
  expect(error).toBeInstanceOf(DatabaseMigrationError);
  const failure = error as DatabaseMigrationError;
  expect(failure.code).toBe("migration_failed");
  expect(failure.step).toBe("备份 data.db");
  expect(failure.message).toContain("备份 data.db");
  expect(failure.backupPath).toBeNull();
  expect(dump(w.dataPath)).toEqual(before);
  expect(existsSync(w.indexPath)).toBe(true);
});

test("两个库都已是当前版本：不备份、库不变，回执三项都是没做", async () => {
  const w = await world();
  await createDatabase(w.dataPath, "data", 9, ROWS);
  await createDatabase(w.indexPath, "index", 2);
  const before = dump(w.dataPath);
  const receipt = await migrate(w, [renameTitles]);
  expect(receipt).toEqual({ backupPath: null, migratedData: false, removedIndex: false });
  expect(existsSync(join(w.directory, "backups"))).toBe(false);
  expect(dump(w.dataPath)).toEqual(before);
  expect(existsSync(w.indexPath)).toBe(true);
});
