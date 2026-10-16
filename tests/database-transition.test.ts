import { afterEach, expect, test, vi } from "vitest";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { LocalDatabase, uuidv7 } from "../src/core/storage/database.ts";
import { withDatabaseMaintenance } from "../src/core/storage/database-maintenance.ts";
import type { DatabaseManagementAuthorization } from "../src/core/storage/database-maintenance.ts";
import { reconcileDatabaseRecovery } from "../src/core/storage/database-recovery.ts";
import { DATABASE_APPLICATION_IDS, DATABASE_SCHEMA_VERSIONS, DATABASE_SNAPSHOT_FILE } from "../src/core/storage/database-paths.ts";
import { temporaryRoot } from "./helpers/temporary-root.ts";

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
      PRAGMA user_version=${options.version ?? DATABASE_SCHEMA_VERSIONS.data};
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
const hash = async (path: string) => createHash("sha256").update(await readFile(path)).digest("hex");

async function snapshotFixture(directory: string, requirements: RequirementFixture[]): Promise<string> {
  const sourceDirectory = join(directory, "backups", `source-${uuidv7()}`);
  await mkdir(sourceDirectory, { recursive: true, mode: 0o700 });
  const path = join(sourceDirectory, "data.db");
  createStore(path, requirements, { applicationId: DATABASE_APPLICATION_IDS.data });
  await writeFile(join(sourceDirectory, DATABASE_SNAPSHOT_FILE), JSON.stringify({ restoreStatus: "needs_review", executable: false }), { mode: 0o600 });
  return path;
}

test("当前data.db正常重启只核对现状，不生成恢复副本", async () => {
  const w = await world(), id = uuidv7(), path = join(w.directory, "data.db");
  createStore(path, [{ id, lifecycle: "active" }], { applicationId: DATABASE_APPLICATION_IDS.data }); const before = await hash(path);
  const result = await withDatabaseMaintenance(w.scope, (permit) => reconcileDatabaseRecovery(permit, { operationId: uuidv7(), mode: "current_restart" }));
  expect(result).toMatchObject({ mode: "current_restart", state: "restart_ready", executable: true, requirementsChecked: 1 });
  expect(await hash(path)).toBe(before); expect(fs.existsSync(join(w.directory, "backups"))).toBe(false);
});

for (const hasArchive of [false, true]) {
  test(`旧active且${hasArchive ? "有" : "无"}同UUID归档均保持needs_review和禁止执行`, async () => {
    const w = await world(), id = uuidv7(), snapshotPath = await snapshotFixture(w.directory, [{ id, lifecycle: "active" }]);
    const archiveDirectory = join(w.root, "docs-prod"); await mkdir(archiveDirectory, { mode: 0o755 });
    if (hasArchive) await writeFile(join(archiveDirectory, `${id}.恢复线索.md`), "ARCHIVE_BODY_MUST_NOT_BE_READ");
    const result = await withDatabaseMaintenance(w.scope, (permit) => reconcileDatabaseRecovery(permit, { operationId: uuidv7(), mode: "backup_data", snapshotPath, archiveDirectory }));
    expect(result).toMatchObject({ mode: "backup_data", state: "reconciled", executable: false, restoreStatus: "needs_review" });
    if (result.mode === "backup_data") {
      expect(result.requirements).toEqual([expect.objectContaining({ requirementId: id, retainedLifecycle: "active", recoveryReason: hasArchive ? "archive_found" : "history_unknown", executable: false })]);
      const output = new DatabaseSync(result.recoveredPath!, { readOnly: true });
      try {
        const data = JSON.parse(String(output.prepare("SELECT data FROM records WHERE namespace='requirements' AND record_key=?").get(id)?.data));
        expect(data).toMatchObject({ lifecycle: "active", recovery: "needs_review", recoveryReason: hasArchive ? "archive_found" : "history_unknown" });
        expect(output.prepare("SELECT count(*) AS n FROM records WHERE namespace='pm_ownership' AND record_key=?").get(id)?.n).toBe(0);
        expect(output.prepare("PRAGMA user_version").get()?.user_version).toBe(DATABASE_SCHEMA_VERSIONS.data);
        expect(output.prepare("PRAGMA application_id").get()?.application_id).toBe(DATABASE_APPLICATION_IDS.data);
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
    operationId: uuidv7(), mode: "backup_data", snapshotPath, archiveDirectory: archives,
  }));
  expect(receipt.mode).toBe("backup_data");
  if (receipt.mode !== "backup_data") throw new Error("unexpected mode");
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
    operationId: uuidv7(), mode: "current_restart",
  }))).rejects.toThrow(/snapshot_not_current/);
});

test("当前可信closing记录覆盖旧active并保全真实拒绝原因", async () => {
  const w = await world(), id = uuidv7(), snapshotPath = await snapshotFixture(w.directory, [{ id, lifecycle: "active" }]);
  createStore(join(w.directory, "data.db"), [{ id, lifecycle: "closing", closeReason: "rejected" }], { applicationId: DATABASE_APPLICATION_IDS.data });
  const result = await withDatabaseMaintenance(w.scope, (permit) => reconcileDatabaseRecovery(permit, { operationId: uuidv7(), mode: "backup_data", snapshotPath }));
  expect(result.mode).toBe("backup_data");
  if (result.mode === "backup_data") expect(result.requirements).toEqual([expect.objectContaining({ requirementId: id, sourceLifecycle: "active", retainedLifecycle: "closing", closeReason: "rejected", recoveryReason: null, executable: false })]);
});

test("旧快照中的completed/cancelled/rejected终态保全原因但恢复产物仍不可执行", async () => {
  const w = await world();
  const fixtures = (["completed", "cancelled", "rejected"] as const).map((closeReason) => ({ id: uuidv7(), lifecycle: "closed", closeReason }));
  const snapshotPath = await snapshotFixture(w.directory, fixtures);
  const result = await withDatabaseMaintenance(w.scope, (permit) => reconcileDatabaseRecovery(permit, { operationId: uuidv7(), mode: "backup_data", snapshotPath }));
  expect(result.mode).toBe("backup_data");
  if (result.mode === "backup_data") {
    for (const fixture of fixtures) expect(result.requirements).toContainEqual(expect.objectContaining({ requirementId: fixture.id, retainedLifecycle: "closed", closeReason: fixture.closeReason, executable: false }));
  }
});

test("仅归档存在只登记archive_found线索，不创建active或completed状态", async () => {
  const w = await world(), id = uuidv7(), snapshotPath = await snapshotFixture(w.directory, []);
  const archiveDirectory = join(w.root, "docs-prod"); await mkdir(archiveDirectory); await writeFile(join(archiveDirectory, `${id}.only-archive.md`), "SECRET_ARCHIVE");
  const result = await withDatabaseMaintenance(w.scope, (permit) => reconcileDatabaseRecovery(permit, { operationId: uuidv7(), mode: "backup_data", snapshotPath, archiveDirectory }));
  expect(result.mode).toBe("backup_data");
  if (result.mode === "backup_data") expect(result.requirements).toEqual([{ requirementId: id, sourceLifecycle: null, retainedLifecycle: null, closeReason: null, archivePath: join(archiveDirectory, `${id}.only-archive.md`), recoveryReason: "archive_found", executable: false }]);
});

test("已存在恢复操作的日志链接被拒绝且外部内容不被读写", async () => {
  const w = await world(), recoveryId = uuidv7(), snapshotPath = await snapshotFixture(w.directory, []);
  await withDatabaseMaintenance(w.scope, (permit) => reconcileDatabaseRecovery(permit, { operationId: recoveryId, mode: "backup_data", snapshotPath }));
  const recoveryLog = join(w.directory, "backups", "recovery", recoveryId, ".database-recovery.json"), outsideRecoveryLog = join(w.root, "outside-recovery-log");
  await writeFile(outsideRecoveryLog, "OUTSIDE_RECOVERY_LOG", { mode: 0o600 });
  await rm(recoveryLog); await fs.promises.symlink(outsideRecoveryLog, recoveryLog);
  await expect(withDatabaseMaintenance(w.scope, (permit) => reconcileDatabaseRecovery(permit, { operationId: recoveryId, mode: "backup_data", snapshotPath }))).rejects.toThrow(/recovery_log_invalid/);
  expect(await readFile(outsideRecoveryLog, "utf8")).toBe("OUTSIDE_RECOVERY_LOG");
});

test("维护进程SIGKILL退出后仅同operationId和可信授权可接管续办", async () => {
  const w = await world(), operationId = uuidv7(), script = join(w.root, "maintenance-owner.mjs"), preservedLog = join(w.directory, "preserved-operation.log");
  createStore(join(w.directory, "data.db"), [], { applicationId: DATABASE_APPLICATION_IDS.data });
  await writeFile(script, `import fs from "node:fs";
import {withDatabaseMaintenance} from ${JSON.stringify(new URL("../src/core/storage/database-maintenance.ts", import.meta.url).href)};
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
      const result = reconcileDatabaseRecovery(permit, { operationId, mode: "current_restart" });
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
  const result = await withDatabaseMaintenance(w.scope, (permit) => reconcileDatabaseRecovery(permit, { operationId: uuidv7(), mode: "backup_data", snapshotPath, archiveDirectory, registeredArchivePaths: [first] }));
  expect(result.mode).toBe("backup_data"); expect(archiveReads).toBe(0);
  vi.restoreAllMocks(); syncBuiltinESMExports();
  await writeFile(join(archiveDirectory, `${id}.two.md`), "OTHER_BODY");
  await expect(withDatabaseMaintenance(w.scope, (permit) => reconcileDatabaseRecovery(permit, { operationId: uuidv7(), mode: "backup_data", snapshotPath, archiveDirectory, registeredArchivePaths: [first] }))).rejects.toThrow(/archive_identity_conflict/);
  await expect(withDatabaseMaintenance(w.scope, (permit) => reconcileDatabaseRecovery(permit, { operationId: uuidv7(), mode: "backup_data", snapshotPath, archiveDirectory }))).rejects.toThrow(/archive_identity_conflict/);
});
