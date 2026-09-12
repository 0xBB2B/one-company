import { afterEach, expect, test, vi } from "vitest";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { LocalDatabase, uuidv7 } from "../runtime/database.ts";
import { migrateLegacyDatabase, withDatabaseMaintenance } from "../runtime/database-maintenance.ts";
import type { DatabaseMigrationStage, DatabaseManagementAuthorization } from "../runtime/database-maintenance.ts";
import { reconcileDatabaseRecovery } from "../runtime/database-recovery.ts";
import type { DatabaseRecoveryMode, DatabaseRecoveryStage } from "../runtime/database-recovery.ts";
import { DATABASE_APPLICATION_IDS, DATABASE_SNAPSHOT_FILE } from "../runtime/database-paths.ts";
import { temporaryRoot } from "./helpers/temporary-root.ts";
import { withoutSqliteExperimentalWarning } from "./helpers/node-warnings.ts";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks(); syncBuiltinESMExports();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function world() {
  const root = await mkdtemp(join(temporaryRoot(), "database-transition-")); roots.push(root);
  const directory = join(root, "data"), workspace = join(root, "workspace");
  await mkdir(directory, { mode: 0o700 }); await mkdir(workspace, { mode: 0o700 });
  return { root, directory, workspace, scope: { directory, worktreeRoots: [workspace] } };
}

interface RequirementFixture { id: string; lifecycle: string; closeReason?: "completed" | "cancelled" | "rejected"; recovery?: "ready" | "needs_review" }
function createStore(path: string, requirements: RequirementFixture[] = [], options: { applicationId?: number; version?: number } = {}): void {
  fs.mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  try {
    db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA wal_autocheckpoint=0;
      CREATE TABLE records(id TEXT PRIMARY KEY NOT NULL, namespace TEXT NOT NULL, record_key TEXT NOT NULL, version INTEGER NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)), UNIQUE(namespace,record_key)) STRICT;
      CREATE TABLE events(id TEXT PRIMARY KEY NOT NULL, stream TEXT NOT NULL, sequence INTEGER NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)), UNIQUE(stream,sequence)) STRICT;
      PRAGMA application_id=${options.applicationId ?? 0};
      PRAGMA user_version=${options.version ?? 1};
    `);
    for (const requirement of requirements) {
      const data = reminders(requirement);
      db.prepare("INSERT INTO records VALUES(?,?,?,?,?)").run(requirement.id, "requirements", requirement.id, 1, JSON.stringify(data));
      db.prepare("INSERT INTO records VALUES(?,?,?,?,?)").run(uuidv7(), "pm_ownership", requirement.id, 1, JSON.stringify({ lease: { fence: 1 } }));
    }
  } finally { db.close(); }
  fs.chmodSync(path, 0o600);
  for (const suffix of ["-wal", "-shm"]) if (fs.existsSync(path + suffix)) fs.chmodSync(path + suffix, 0o600);
}

function reminders(requirement: RequirementFixture): Record<string, unknown> {
  return {
    format: "requirement-lifecycle/v1", requirementId: requirement.id, repoId: "a".repeat(64), lifecycle: requirement.lifecycle,
    epoch: 4, recovery: requirement.recovery ?? "ready", recoveryReason: null,
    close: requirement.closeReason ? { reason: requirement.closeReason, operationId: uuidv7() } : null,
  };
}

function managementAuthorization(id = uuidv7()) {
  const value: DatabaseManagementAuthorization = { authorized: true, writesStopped: true, authorizationId: id, principal: "test-trusted-management-fixture" };
  return () => value;
}
function migrationAuthorization(failOnceAt?: DatabaseMigrationStage) {
  const value: DatabaseManagementAuthorization = { authorized: true, writesStopped: true, authorizationId: uuidv7(), principal: "test-trusted-management-fixture" };
  let failed = false;
  return (_context: { stage: DatabaseMigrationStage }) => {
    if (!failed && failOnceAt === _context.stage) { failed = true; throw new Error("controlled interruption"); }
    return value;
  };
}
function recoveryAuthorization(_mode: DatabaseRecoveryMode, failOnceAt?: DatabaseRecoveryStage) {
  const value: DatabaseManagementAuthorization = { authorized: true, writesStopped: true, authorizationId: uuidv7(), principal: "test-trusted-management-fixture" };
  let failed = false;
  return (_context: { stage: DatabaseRecoveryStage }) => {
    if (!failed && failOnceAt === _context.stage) { failed = true; throw new Error("controlled interruption"); }
    return value;
  };
}
const hash = async (path: string) => createHash("sha256").update(await readFile(path)).digest("hex");

async function makeWalLegacy(path: string, requirementId: string): Promise<DatabaseSync> {
  createStore(path);
  const reader = new DatabaseSync(path); reader.exec("BEGIN; SELECT count(*) FROM records;");
  const writer = new DatabaseSync(path);
  writer.exec("PRAGMA wal_autocheckpoint=0");
  writer.prepare("INSERT INTO records VALUES(?,?,?,?,?)").run(requirementId, "requirements", requirementId, 1, JSON.stringify(reminders({ id: requirementId, lifecycle: "active" })));
  writer.close();
  for (const suffix of ["", "-wal", "-shm"]) if (fs.existsSync(path + suffix)) fs.chmodSync(path + suffix, 0o600);
  expect(fs.existsSync(path + "-wal")).toBe(true);
  return reader;
}

async function snapshotFixture(directory: string, requirements: RequirementFixture[]): Promise<string> {
  const sourceDirectory = join(directory, "backups", `source-${uuidv7()}`);
  await mkdir(sourceDirectory, { recursive: true, mode: 0o700 });
  const path = join(sourceDirectory, "data.db");
  createStore(path, requirements, { applicationId: DATABASE_APPLICATION_IDS.data });
  await writeFile(join(sourceDirectory, DATABASE_SNAPSHOT_FILE), JSON.stringify({ restoreStatus: "needs_review", executable: false }), { mode: 0o600 });
  return path;
}

async function runChild(script: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [script], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", (data) => { stdout += data; }); child.stderr.on("data", (data) => { stderr += data; });
  const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  return { code, stdout, stderr };
}

test("合法data.sqlite切换保留WAL记录、用途标签和原始文件", async () => {
  const w = await world(), id = uuidv7(), legacy = join(w.directory, "data.sqlite");
  const reader = await makeWalLegacy(legacy, id);
  try {
    const receipt = await withDatabaseMaintenance(w.scope, (permit) => migrateLegacyDatabase(permit, { operationId: uuidv7(), kind: "data", authorize: managementAuthorization() }));
    expect(receipt.state).toBe("completed"); expect(receipt.archivedFiles.map((file) => file.name)).toContain("data.sqlite-wal");
    expect(fs.existsSync(legacy)).toBe(false); expect(fs.existsSync(join(receipt.backupDirectory, "legacy", "data.sqlite"))).toBe(true);
    const db = new LocalDatabase(join(w.directory, "data.db"));
    try { expect(db.read("requirements", id)?.data).toMatchObject({ lifecycle: "active" }); } finally { db.close(); }
    const raw = new DatabaseSync(join(w.directory, "data.db"), { readOnly: true });
    try { expect(raw.prepare("PRAGMA application_id").get()?.application_id).toBe(DATABASE_APPLICATION_IDS.data); } finally { raw.close(); }
  } finally { reader.close(); }
});

test("迁移在独立Node进程完成，正常入口真实打开新.db", async () => {
  const w = await world(), id = uuidv7(); createStore(join(w.directory, "global.sqlite"));
  const script = join(w.root, "migrate.mjs"), operationId = uuidv7();
  await writeFile(script, `import {migrateLegacyDatabase,withDatabaseMaintenance} from ${JSON.stringify(new URL("../runtime/database-maintenance.ts", import.meta.url).href)};
const auth=()=>({authorized:true,writesStopped:true,authorizationId:${JSON.stringify(id)},principal:"child-management-fixture"});
const result=await withDatabaseMaintenance(${JSON.stringify(w.scope)},p=>migrateLegacyDatabase(p,{operationId:${JSON.stringify(operationId)},kind:"global",authorize:auth}));
console.log(JSON.stringify(result));`);
  const child = await runChild(script);
  expect(child.code).toBe(0); expect(withoutSqliteExperimentalWarning(child.stderr)).toBe(""); expect(JSON.parse(child.stdout).state).toBe("completed");
  const db = new LocalDatabase(join(w.directory, "global.db")); db.close();
});

test("未知旧版本拒绝且不创建目标、不移动旧库", async () => {
  const w = await world(), source = join(w.directory, "data.sqlite"); createStore(source, [], { version: 99 });
  const before = await hash(source);
  await expect(withDatabaseMaintenance(w.scope, (permit) => migrateLegacyDatabase(permit, { operationId: uuidv7(), kind: "data", authorize: managementAuthorization() }))).rejects.toThrow(/unrecognized_source_layout/);
  expect(await hash(source)).toBe(before); expect(fs.existsSync(join(w.directory, "data.db"))).toBe(false);
  expect(() => new LocalDatabase(join(w.directory, "data.db"))).toThrow(/recovery_required/);
  expect(fs.existsSync(join(w.directory, "data.db"))).toBe(false);
});

test("冲突目标拒绝且旧库、目标及附属文件均保留", async () => {
  const w = await world(), source = join(w.directory, "data.sqlite"), target = join(w.directory, "data.db");
  createStore(source, [{ id: uuidv7(), lifecycle: "active" }]); createStore(target, [{ id: uuidv7(), lifecycle: "closed", closeReason: "completed" }], { applicationId: DATABASE_APPLICATION_IDS.data });
  const sourceHash = await hash(source), targetHash = await hash(target);
  await expect(withDatabaseMaintenance(w.scope, (permit) => migrateLegacyDatabase(permit, { operationId: uuidv7(), kind: "data", authorize: managementAuthorization() }))).rejects.toThrow(/migration_target_conflict/);
  expect(await hash(source)).toBe(sourceHash); expect(await hash(target)).toBe(targetHash);
});

test("VACUUM复制完成后进程异常，同operationId重试保留未确认副本并完成唯一切换", async () => {
  const w = await world(), source = join(w.directory, "data.sqlite"), id = uuidv7(), operationId = uuidv7(), authorize = managementAuthorization();
  createStore(source, [{ id, lifecycle: "active" }]);
  const originalPrepare = DatabaseSync.prototype.prepare; let injected = false;
  vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (sql) {
    const statement = originalPrepare.call(this, sql);
    if (!injected && sql === "VACUUM main INTO ?") {
      const run = statement.run.bind(statement);
      statement.run = (...args) => { run(...args); injected = true; throw new Error("controlled post-copy interruption"); };
    }
    return statement;
  });
  await expect(withDatabaseMaintenance(w.scope, (permit) => migrateLegacyDatabase(permit, { operationId, kind: "data", authorize }))).rejects.toThrow(/migration_failed/);
  vi.restoreAllMocks();
  const receipt = await withDatabaseMaintenance(w.scope, (permit) => migrateLegacyDatabase(permit, { operationId, kind: "data", authorize }));
  expect(injected).toBe(true); expect(receipt.state).toBe("completed");
  const candidates = (await readdir(receipt.backupDirectory)).filter((name) => name.startsWith("data.converted-"));
  expect(candidates).toHaveLength(2);
  const db = new LocalDatabase(join(w.directory, "data.db")); try { expect(db.read("requirements", id)).not.toBeNull(); } finally { db.close(); }
});

test("copying阶段未登记hash的合法异内容候选不会被误认成源库副本", async () => {
  const w = await world(), source = join(w.directory, "data.sqlite"), sourceId = uuidv7(), replacementId = uuidv7(), operationId = uuidv7(), authorize = managementAuthorization();
  createStore(source, [{ id: sourceId, lifecycle: "active" }]);
  const originalPrepare = DatabaseSync.prototype.prepare; let injected = false;
  vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (sql) {
    const statement = originalPrepare.call(this, sql);
    if (!injected && sql === "VACUUM main INTO ?") {
      const run = statement.run.bind(statement);
      statement.run = (...args) => { run(...args); injected = true; throw new Error("controlled post-copy interruption"); };
    }
    return statement;
  });
  await expect(withDatabaseMaintenance(w.scope, (permit) => migrateLegacyDatabase(permit, { operationId, kind: "data", authorize }))).rejects.toThrow(/migration_failed/);
  vi.restoreAllMocks();
  const operationDirectory = join(w.directory, "backups", operationId), manifestPath = join(operationDirectory, ".database-migration.json");
  const interrupted = JSON.parse(await readFile(manifestPath, "utf8"));
  const unknownCandidate = join(operationDirectory, interrupted.candidateName);
  await rm(unknownCandidate);
  createStore(unknownCandidate, [{ id: replacementId, lifecycle: "closed", closeReason: "completed" }], { applicationId: DATABASE_APPLICATION_IDS.data });
  const replacementHash = await hash(unknownCandidate);
  const receipt = await withDatabaseMaintenance(w.scope, (permit) => migrateLegacyDatabase(permit, { operationId, kind: "data", authorize }));
  expect(await hash(unknownCandidate)).toBe(replacementHash);
  const completed = JSON.parse(await readFile(manifestPath, "utf8"));
  expect(completed.abandonedCandidates).toContain(interrupted.candidateName);
  expect(completed.candidateName).not.toBe(interrupted.candidateName);
  const db = new LocalDatabase(join(w.directory, "data.db"));
  try { expect(db.read("requirements", sourceId)).not.toBeNull(); expect(db.read("requirements", replacementId)).toBeNull(); } finally { db.close(); }
  expect(receipt.state).toBe("completed");
});

test("目标暂存复制后异常，同operationId重试复用已核对暂存文件", async () => {
  const w = await world(), source = join(w.directory, "data.sqlite"), id = uuidv7(), operationId = uuidv7(), authorize = managementAuthorization();
  createStore(source, [{ id, lifecycle: "active" }]);
  const originalCopy = fs.copyFileSync; let copies = 0;
  vi.spyOn(fs, "copyFileSync").mockImplementation(((...args: Parameters<typeof fs.copyFileSync>) => {
    const result = originalCopy(...args); copies += 1; throw new Error("controlled post-stage interruption"); return result;
  }) as typeof fs.copyFileSync); syncBuiltinESMExports();
  await expect(withDatabaseMaintenance(w.scope, (permit) => migrateLegacyDatabase(permit, { operationId, kind: "data", authorize }))).rejects.toThrow(/migration_failed/);
  vi.restoreAllMocks(); syncBuiltinESMExports();
  const receipt = await withDatabaseMaintenance(w.scope, (permit) => migrateLegacyDatabase(permit, { operationId, kind: "data", authorize }));
  expect(copies).toBe(1); expect(receipt.state).toBe("completed");
  const manifest = JSON.parse(await readFile(join(receipt.backupDirectory, ".database-migration.json"), "utf8"));
  expect(manifest).toMatchObject({ phase: "completed" }); expect(manifest.abandonedStages).toBeUndefined();
});

test("归档目标出现外部新文件时不覆盖源或冲突目标", async () => {
  const w = await world(), source = join(w.directory, "data.sqlite"), operationId = uuidv7(), authorize = migrationAuthorization("archive");
  createStore(source, [{ id: uuidv7(), lifecycle: "active" }]);
  await expect(withDatabaseMaintenance(w.scope, (permit) => migrateLegacyDatabase(permit, { operationId, kind: "data", authorize }))).rejects.toThrow(/migration_authorization_failed/);
  const sourceHash = await hash(source), archiveDirectory = join(w.directory, "backups", operationId, "legacy"), conflict = join(archiveDirectory, "data.sqlite");
  await mkdir(archiveDirectory, { mode: 0o700 }); await writeFile(conflict, "USER_NEW_FILE", { mode: 0o600 });
  await expect(withDatabaseMaintenance(w.scope, (permit) => migrateLegacyDatabase(permit, { operationId, kind: "data", authorize }))).rejects.toThrow(/migration_archive_conflict/);
  expect(await hash(source)).toBe(sourceHash); expect(await readFile(conflict, "utf8")).toBe("USER_NEW_FILE"); expect(fs.existsSync(join(w.directory, "data.db"))).toBe(false);
});

for (const interruptedAt of ["archive", "complete"] as const) {
  test(`${interruptedAt}阶段中断后同operationId重试不重复迁移副作用`, async () => {
    const w = await world(), source = join(w.directory, "data.sqlite"), requirementId = uuidv7(), operationId = uuidv7();
    createStore(source, [{ id: requirementId, lifecycle: "active" }]);
    const authorize = migrationAuthorization(interruptedAt);
    await expect(withDatabaseMaintenance(w.scope, (permit) => migrateLegacyDatabase(permit, { operationId, kind: "data", authorize }))).rejects.toThrow(/migration_authorization_failed/);
    const receipt = await withDatabaseMaintenance(w.scope, (permit) => migrateLegacyDatabase(permit, { operationId, kind: "data", authorize }));
    const repeated = await withDatabaseMaintenance(w.scope, (permit) => migrateLegacyDatabase(permit, { operationId, kind: "data", authorize }));
    expect(repeated).toEqual(receipt);
    expect((await readdir(join(w.directory, "backups"))).filter((name) => name === operationId)).toHaveLength(1);
    expect(receipt.archivedFiles.filter((file) => file.name === "data.sqlite")).toHaveLength(1);
    const db = new LocalDatabase(join(w.directory, "data.db")); try { expect(db.read("requirements", requirementId)).not.toBeNull(); } finally { db.close(); }
  });
}

test("当前data.db正常重启只核对现状，不生成恢复副本", async () => {
  const w = await world(), id = uuidv7(), path = join(w.directory, "data.db");
  createStore(path, [{ id, lifecycle: "active" }], { applicationId: DATABASE_APPLICATION_IDS.data }); const before = await hash(path);
  const result = await withDatabaseMaintenance(w.scope, (permit) => reconcileDatabaseRecovery(permit, { operationId: uuidv7(), mode: "current_restart", authorize: recoveryAuthorization("current_restart") }));
  expect(result).toMatchObject({ mode: "current_restart", state: "restart_ready", executable: true, requirementsChecked: 1 });
  expect(await hash(path)).toBe(before); expect(fs.existsSync(join(w.directory, "backups"))).toBe(false);
});

test("仅index重建生成不可执行候选且data任务授权字节不变", async () => {
  const w = await world(), id = uuidv7(), path = join(w.directory, "data.db");
  createStore(path, [{ id, lifecycle: "active" }], { applicationId: DATABASE_APPLICATION_IDS.data }); const before = await hash(path);
  const result = await withDatabaseMaintenance(w.scope, (permit) => reconcileDatabaseRecovery(permit, { operationId: uuidv7(), mode: "index_rebuild", authorize: recoveryAuthorization("index_rebuild") }));
  expect(result).toMatchObject({ mode: "index_rebuild", state: "rebuilt", executable: false });
  if (result.mode === "index_rebuild") expect(result.dataHashAfter).toBe(result.dataHashBefore);
  expect(await hash(path)).toBe(before);
  if (result.mode === "index_rebuild") {
    expect((await stat(result.rebuiltPath)).mode & 0o777).toBe(0o600);
    const raw = new DatabaseSync(result.rebuiltPath);
    try {
      expect(() => raw.prepare("INSERT INTO records(id,namespace,record_key,version,data) VALUES(?,?,?,?,?)").run("not-a-uuid", "files", "bad-id", 1, "{}")).toThrow();
      expect(() => raw.prepare("INSERT INTO records(id,namespace,record_key,version,data) VALUES(?,?,?,?,?)").run(uuidv7(), "files", "bad-version", 0, "{}")).toThrow();
      expect(() => raw.prepare("INSERT INTO events(id,stream,sequence,data) VALUES(?,?,?,?)").run(uuidv7(), "index_events", 0, "{}")).toThrow();
      const recordId = uuidv7();
      raw.prepare("INSERT INTO records(id,namespace,record_key,version,data) VALUES(?,?,?,?,?)").run(recordId, "files", "same", 1, "{}");
      expect(() => raw.prepare("INSERT INTO records(id,namespace,record_key,version,data) VALUES(?,?,?,?,?)").run(uuidv7(), "files", "same", 1, "{}")).toThrow();
    } finally { raw.close(); }
    expect(() => new LocalDatabase(result.rebuiltPath)).toThrow(/snapshot_only/);
  }
});

for (const hasArchive of [false, true]) {
  test(`旧active且${hasArchive ? "有" : "无"}同UUID归档均保持needs_review和禁止执行`, async () => {
    const w = await world(), id = uuidv7(), snapshotPath = await snapshotFixture(w.directory, [{ id, lifecycle: "active" }]);
    const archiveDirectory = join(w.root, "docs-prod"); await mkdir(archiveDirectory, { mode: 0o755 });
    if (hasArchive) await writeFile(join(archiveDirectory, `${id}.恢复线索.md`), "ARCHIVE_BODY_MUST_NOT_BE_READ");
    const result = await withDatabaseMaintenance(w.scope, (permit) => reconcileDatabaseRecovery(permit, { operationId: uuidv7(), mode: "legacy_data", snapshotPath, archiveDirectory, authorize: recoveryAuthorization("legacy_data") }));
    expect(result).toMatchObject({ mode: "legacy_data", state: "reconciled", executable: false, restoreStatus: "needs_review" });
    if (result.mode === "legacy_data") {
      expect(result.requirements).toEqual([expect.objectContaining({ requirementId: id, retainedLifecycle: "active", recoveryReason: hasArchive ? "archive_found" : "history_unknown", executable: false })]);
      const output = new DatabaseSync(result.recoveredPath!, { readOnly: true });
      try {
        const data = JSON.parse(String(output.prepare("SELECT data FROM records WHERE namespace='requirements' AND record_key=?").get(id)?.data));
        expect(data).toMatchObject({ lifecycle: "active", recovery: "needs_review", recoveryReason: hasArchive ? "archive_found" : "history_unknown" });
        expect(output.prepare("SELECT count(*) AS n FROM records WHERE namespace='pm_ownership' AND record_key=?").get(id)?.n).toBe(0);
      } finally { output.close(); }
      expect(() => new LocalDatabase(result.recoveredPath!)).toThrow(/snapshot_only/);
    }
  });
}

test("旧快照中不存在的当前终态仍完整保全，归档元数据不重复插入", async () => {
  const w = await world();
  const terminalRows: RequirementFixture[] = [
    { id: uuidv7(), lifecycle: "closed", closeReason: "completed" },
    { id: uuidv7(), lifecycle: "closing", closeReason: "cancelled" },
    { id: uuidv7(), lifecycle: "closed", closeReason: "rejected" },
  ];
  createStore(join(w.directory, "data.db"), terminalRows, { applicationId: DATABASE_APPLICATION_IDS.data });
  const snapshotPath = await snapshotFixture(w.directory, []);
  const archives = join(w.workspace, "docs", "prod");
  await mkdir(archives, { recursive: true });
  await writeFile(join(archives, `${terminalRows[0]!.id}.归档.md`), "不应读取正文");
  const before = await hash(join(w.directory, "data.db"));
  const receipt = await withDatabaseMaintenance(w.scope, (permit) => reconcileDatabaseRecovery(permit, {
    operationId: uuidv7(), mode: "legacy_data", snapshotPath, archiveDirectory: archives, authorize: managementAuthorization(),
  }));
  expect(receipt.mode).toBe("legacy_data");
  if (receipt.mode !== "legacy_data") throw new Error("unexpected mode");
  expect(receipt.requirements).toHaveLength(3);
  const db = new DatabaseSync(receipt.recoveredPath!, { readOnly: true });
  try {
    for (const row of terminalRows) {
      const saved = JSON.parse(String(db.prepare("SELECT data FROM records WHERE namespace='requirements' AND record_key=?").get(row.id)!.data));
      expect(saved.lifecycle).toBe(row.lifecycle);
      expect(saved.close.reason).toBe(row.closeReason);
      expect(receipt.requirements.find((item) => item.requirementId === row.id)).toMatchObject({ sourceLifecycle: null, retainedLifecycle: row.lifecycle, closeReason: row.closeReason, executable: false });
    }
  } finally { db.close(); }
  expect(await hash(join(w.directory, "data.db"))).toBe(before);
});

test("带快照标记的目录不能借current_restart成为当前执行库", async () => {
  const w = await world();
  const snapshotPath = await snapshotFixture(w.directory, []);
  await expect(withDatabaseMaintenance({ directory: join(snapshotPath, ".."), worktreeRoots: [] }, (permit) => reconcileDatabaseRecovery(permit, {
    operationId: uuidv7(), mode: "current_restart", authorize: managementAuthorization(),
  }))).rejects.toThrow(/snapshot_not_current/);
});

test("当前可信closing记录覆盖旧active并保全真实拒绝原因", async () => {
  const w = await world(), id = uuidv7(), snapshotPath = await snapshotFixture(w.directory, [{ id, lifecycle: "active" }]);
  createStore(join(w.directory, "data.db"), [{ id, lifecycle: "closing", closeReason: "rejected" }], { applicationId: DATABASE_APPLICATION_IDS.data });
  const result = await withDatabaseMaintenance(w.scope, (permit) => reconcileDatabaseRecovery(permit, { operationId: uuidv7(), mode: "legacy_data", snapshotPath, authorize: recoveryAuthorization("legacy_data") }));
  expect(result.mode).toBe("legacy_data");
  if (result.mode === "legacy_data") expect(result.requirements).toEqual([expect.objectContaining({ requirementId: id, sourceLifecycle: "active", retainedLifecycle: "closing", closeReason: "rejected", recoveryReason: null, executable: false })]);
});

test("旧快照中的completed/cancelled/rejected终态保全原因但恢复产物仍不可执行", async () => {
  const w = await world();
  const fixtures = (["completed", "cancelled", "rejected"] as const).map((closeReason) => ({ id: uuidv7(), lifecycle: "closed", closeReason }));
  const snapshotPath = await snapshotFixture(w.directory, fixtures);
  const result = await withDatabaseMaintenance(w.scope, (permit) => reconcileDatabaseRecovery(permit, { operationId: uuidv7(), mode: "legacy_data", snapshotPath, authorize: recoveryAuthorization("legacy_data") }));
  expect(result.mode).toBe("legacy_data");
  if (result.mode === "legacy_data") {
    for (const fixture of fixtures) expect(result.requirements).toContainEqual(expect.objectContaining({ requirementId: fixture.id, retainedLifecycle: "closed", closeReason: fixture.closeReason, executable: false }));
  }
});

test("仅归档存在只登记archive_found线索，不创建active或completed状态", async () => {
  const w = await world(), id = uuidv7(), snapshotPath = await snapshotFixture(w.directory, []);
  const archiveDirectory = join(w.root, "docs-prod"); await mkdir(archiveDirectory); await writeFile(join(archiveDirectory, `${id}.only-archive.md`), "SECRET_ARCHIVE");
  const result = await withDatabaseMaintenance(w.scope, (permit) => reconcileDatabaseRecovery(permit, { operationId: uuidv7(), mode: "legacy_data", snapshotPath, archiveDirectory, authorize: recoveryAuthorization("legacy_data") }));
  expect(result.mode).toBe("legacy_data");
  if (result.mode === "legacy_data") expect(result.requirements).toEqual([{ requirementId: id, sourceLifecycle: null, retainedLifecycle: null, closeReason: null, archivePath: join(archiveDirectory, `${id}.only-archive.md`), recoveryReason: "archive_found", executable: false }]);
});

test("迁移日志被外部改写后不会被维护进程覆盖", async () => {
  const w = await world(), operationId = uuidv7(), source = join(w.directory, "data.sqlite"), authorization = managementAuthorization()();
  createStore(source, [{ id: uuidv7(), lifecycle: "active" }]);
  const manifestPath = join(w.directory, "backups", operationId, ".database-migration.json");
  let changed = false;
  const authorize = (context: { stage: DatabaseMigrationStage }) => {
    if (!changed && context.stage === "copy") {
      fs.writeFileSync(manifestPath, "EXTERNAL_REWRITE_MUST_BE_PRESERVED", { mode: 0o600 });
      changed = true;
    }
    return authorization;
  };
  await expect(withDatabaseMaintenance(w.scope, (permit) => migrateLegacyDatabase(permit, { operationId, kind: "data", authorize }))).rejects.toThrow(/migration_log_changed/);
  expect(await readFile(manifestPath, "utf8")).toBe("EXTERNAL_REWRITE_MUST_BE_PRESERVED");
  expect(fs.existsSync(source)).toBe(true); expect(fs.existsSync(join(w.directory, "data.db"))).toBe(false);
});

test("已存在迁移与恢复操作的目录或日志链接被拒绝且外部内容不被读写", async () => {
  const migrationWorld = await world(), migrationId = uuidv7(), source = join(migrationWorld.directory, "data.sqlite"), authorizeMigration = migrationAuthorization("archive");
  createStore(source, [{ id: uuidv7(), lifecycle: "active" }]);
  await expect(withDatabaseMaintenance(migrationWorld.scope, (permit) => migrateLegacyDatabase(permit, { operationId: migrationId, kind: "data", authorize: authorizeMigration }))).rejects.toThrow(/migration_authorization_failed/);
  const migrationDirectory = join(migrationWorld.directory, "backups", migrationId), migrationLog = join(migrationDirectory, ".database-migration.json"), outsideLog = join(migrationWorld.root, "outside-migration-log");
  await writeFile(outsideLog, "OUTSIDE_MIGRATION_LOG", { mode: 0o600 });
  await rm(migrationLog); await fs.promises.symlink(outsideLog, migrationLog);
  await expect(withDatabaseMaintenance(migrationWorld.scope, (permit) => migrateLegacyDatabase(permit, { operationId: migrationId, kind: "data", authorize: authorizeMigration }))).rejects.toThrow(/migration_log_invalid/);
  expect(await readFile(outsideLog, "utf8")).toBe("OUTSIDE_MIGRATION_LOG");

  const recoveryWorld = await world(), recoveryId = uuidv7(), dataPath = join(recoveryWorld.directory, "data.db"), authorizeRecovery = recoveryAuthorization("index_rebuild", "complete");
  createStore(dataPath, [], { applicationId: DATABASE_APPLICATION_IDS.data });
  await expect(withDatabaseMaintenance(recoveryWorld.scope, (permit) => reconcileDatabaseRecovery(permit, { operationId: recoveryId, mode: "index_rebuild", authorize: authorizeRecovery }))).rejects.toThrow(/authorization_failed/);
  const recoveryDirectory = join(recoveryWorld.directory, "backups", "recovery", recoveryId), recoveryLog = join(recoveryDirectory, ".database-recovery.json"), outsideRecoveryLog = join(recoveryWorld.root, "outside-recovery-log");
  await writeFile(outsideRecoveryLog, "OUTSIDE_RECOVERY_LOG", { mode: 0o600 });
  await rm(recoveryLog); await fs.promises.symlink(outsideRecoveryLog, recoveryLog);
  await expect(withDatabaseMaintenance(recoveryWorld.scope, (permit) => reconcileDatabaseRecovery(permit, { operationId: recoveryId, mode: "index_rebuild", authorize: authorizeRecovery }))).rejects.toThrow(/recovery_log_invalid/);
  expect(await readFile(outsideRecoveryLog, "utf8")).toBe("OUTSIDE_RECOVERY_LOG");

  const directoryWorld = await world(), directoryOperationId = uuidv7(), directorySource = join(directoryWorld.directory, "data.sqlite"), directoryAuthorize = migrationAuthorization("archive");
  createStore(directorySource, [{ id: uuidv7(), lifecycle: "active" }]);
  await expect(withDatabaseMaintenance(directoryWorld.scope, (permit) => migrateLegacyDatabase(permit, { operationId: directoryOperationId, kind: "data", authorize: directoryAuthorize }))).rejects.toThrow(/migration_authorization_failed/);
  const operationDirectory = join(directoryWorld.directory, "backups", directoryOperationId), preservedDirectory = operationDirectory + ".preserved", outsideDirectory = join(directoryWorld.root, "outside-operation");
  fs.renameSync(operationDirectory, preservedDirectory); await mkdir(outsideDirectory, { mode: 0o700 }); await writeFile(join(outsideDirectory, "sentinel"), "OUTSIDE_DIRECTORY", { mode: 0o600 }); await fs.promises.symlink(outsideDirectory, operationDirectory);
  await expect(withDatabaseMaintenance(directoryWorld.scope, (permit) => migrateLegacyDatabase(permit, { operationId: directoryOperationId, kind: "data", authorize: directoryAuthorize }))).rejects.toThrow(/private_directory_required/);
  expect(await readFile(join(outsideDirectory, "sentinel"), "utf8")).toBe("OUTSIDE_DIRECTORY");
  expect(fs.existsSync(join(preservedDirectory, ".database-migration.json"))).toBe(true);
});

test("维护进程SIGKILL退出后仅同operationId和可信授权可接管续办", async () => {
  const w = await world(), operationId = uuidv7(), script = join(w.root, "maintenance-owner.mjs"), preservedLog = join(w.directory, "preserved-operation.log");
  createStore(join(w.directory, "data.db"), [], { applicationId: DATABASE_APPLICATION_IDS.data });
  await writeFile(script, `import fs from "node:fs";
import {withDatabaseMaintenance} from ${JSON.stringify(new URL("../runtime/database-maintenance.ts", import.meta.url).href)};
await withDatabaseMaintenance({...${JSON.stringify(w.scope)},operationId:${JSON.stringify(operationId)}},async()=>{fs.writeFileSync(${JSON.stringify(preservedLog)},"ORIGINAL_OPERATION_LOG",{mode:0o600});console.log("LOCKED");await new Promise(()=>{});});`);
  const child = spawn(process.execPath, [script], { stdio: ["ignore", "pipe", "pipe"] });
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("维护子进程未就绪")), 3000);
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.stdout.once("data", (data) => { clearTimeout(timer); data.toString().includes("LOCKED") ? resolve() : reject(new Error("维护标记未确认")); });
    });
    let activeAuthorizationCalls = 0;
    const takeoverAuthorization = () => { activeAuthorizationCalls += 1; return managementAuthorization()(); };
    await expect(withDatabaseMaintenance({ ...w.scope, operationId, takeover: { authorize: takeoverAuthorization } }, () => null)).rejects.toThrow(/maintenance_owner_active/);
    expect(activeAuthorizationCalls).toBe(0);
    child.kill("SIGKILL"); await closed;
    await expect(withDatabaseMaintenance({ ...w.scope, operationId: uuidv7(), takeover: { authorize: takeoverAuthorization } }, () => null)).rejects.toThrow(/maintenance_already_exists/);
    await expect(withDatabaseMaintenance({ ...w.scope, operationId, takeover: { authorize: () => { throw new Error("no management authorization"); } } }, () => null)).rejects.toThrow(/maintenance_takeover_unauthorized/);
    await withDatabaseMaintenance({ ...w.scope, operationId, takeover: { authorize: takeoverAuthorization } }, async (permit) => {
      expect(await readFile(preservedLog, "utf8")).toBe("ORIGINAL_OPERATION_LOG");
      const marker = JSON.parse(await readFile(join(w.directory, ".database-maintenance.json"), "utf8"));
      expect(marker).toMatchObject({ operationId, ownershipEpoch: 2, takeover: { previousOwner: { pid: child.pid } } });
      const result = reconcileDatabaseRecovery(permit, { operationId, mode: "current_restart", authorize: recoveryAuthorization("current_restart") });
      expect(result).toMatchObject({ mode: "current_restart", state: "restart_ready", executable: true });
    });
    expect(activeAuthorizationCalls).toBe(1);
    expect(fs.existsSync(join(w.directory, ".database-maintenance.json"))).toBe(false);
  } finally { child.kill("SIGKILL"); await closed; }
});

test("旧维护标记即使提供接管回调也保持needs_review", async () => {
  const w = await world(), marker = join(w.directory, ".database-maintenance.json");
  await writeFile(marker, JSON.stringify({ operationId: uuidv7(), state: "maintenance" }), { mode: 0o600 });
  await expect(withDatabaseMaintenance({ ...w.scope, operationId: uuidv7(), takeover: { authorize: managementAuthorization() } }, () => null)).rejects.toThrow(/maintenance_needs_review/);
  expect(fs.existsSync(marker)).toBe(true);
});

test("归档枚举正文读取探针为零，并拒绝同UUID多路径冲突", async () => {
  const w = await world(), id = uuidv7(), snapshotPath = await snapshotFixture(w.directory, [{ id, lifecycle: "active" }]);
  const archiveDirectory = join(w.root, "docs-prod"); await mkdir(archiveDirectory);
  const first = join(archiveDirectory, `${id}.one.md`); await writeFile(first, "DO_NOT_READ_ARCHIVE_BODY");
  const original = fs.readFileSync; let archiveReads = 0;
  vi.spyOn(fs, "readFileSync").mockImplementation(((path: fs.PathOrFileDescriptor, ...args: unknown[]) => {
    if (typeof path === "string" && path.startsWith(archiveDirectory + "/")) { archiveReads += 1; throw new Error("archive body read probe"); }
    return Reflect.apply(original, fs, [path, ...args]);
  }) as typeof fs.readFileSync); syncBuiltinESMExports();
  const result = await withDatabaseMaintenance(w.scope, (permit) => reconcileDatabaseRecovery(permit, { operationId: uuidv7(), mode: "legacy_data", snapshotPath, archiveDirectory, registeredArchivePaths: [first], authorize: recoveryAuthorization("legacy_data") }));
  expect(result.mode).toBe("legacy_data"); expect(archiveReads).toBe(0);
  vi.restoreAllMocks(); syncBuiltinESMExports();
  await writeFile(join(archiveDirectory, `${id}.two.md`), "OTHER_BODY");
  await expect(withDatabaseMaintenance(w.scope, (permit) => reconcileDatabaseRecovery(permit, { operationId: uuidv7(), mode: "legacy_data", snapshotPath, archiveDirectory, registeredArchivePaths: [first], authorize: recoveryAuthorization("legacy_data") }))).rejects.toThrow(/archive_identity_conflict/);
  await expect(withDatabaseMaintenance(w.scope, (permit) => reconcileDatabaseRecovery(permit, { operationId: uuidv7(), mode: "legacy_data", snapshotPath, archiveDirectory, authorize: recoveryAuthorization("legacy_data") }))).rejects.toThrow(/archive_identity_conflict/);
});
