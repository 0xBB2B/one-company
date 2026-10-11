import { afterEach, expect, test, vi } from "vitest";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { createRequirementBackup, requirementBackupFiles, RequirementBackupError } from "../runtime/requirement-backup.ts";
import type { RequirementBackupOptions } from "../runtime/requirement-backup.ts";
import { restoreRequirementBackup, RequirementRecoveryError } from "../runtime/requirement-recovery.ts";
import type { RequirementRestoreOptions } from "../runtime/requirement-recovery.ts";
import { REQUIREMENT_WRITE_COORDINATION_NAMESPACE } from "../runtime/requirement-coordination.ts";
import { RequirementService } from "../runtime/requirement-service.ts";
import { draftApprover } from "./helpers/approval-fixture.ts";
import { RequirementStateStore } from "../runtime/requirement-state.ts";
import { repositoryDatabase, uuidv7, withDatabase } from "../runtime/database.ts";
import { repositoryIdentity } from "../runtime/identity.ts";
import { prodRequirementPath } from "../runtime/prod-storage.ts";
import { addWorktree, createRepoFixture, GIT_ENV, removeRepoFixture } from "./helpers/repo-fixture.ts";
import { temporaryRoot } from "./helpers/temporary-root.ts";
import { sealOperationLog } from "../runtime/operation-log.ts";


const exec = promisify(execFile);
const GIT = "git";
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function privateRepoDirectory(root: string, repoId: string): Promise<{ dataRoot: string; repoDirectory: string }> {
  const dataRoot = join(root, "private");
  const repos = join(dataRoot, "repos");
  const repoDirectory = join(repos, repoId);
  await mkdir(repoDirectory, { recursive: true, mode: 0o700 });
  await chmod(dataRoot, 0o700); await chmod(repos, 0o700); await chmod(repoDirectory, 0o700);
  return { dataRoot, repoDirectory };
}

async function world() {
  const root = await mkdtemp(join(temporaryRoot(), "requirement-backup-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const repo = await createRepoFixture();
  cleanups.push(() => removeRepoFixture(repo));
  const identity = await repositoryIdentity(repo.root);
  const local = await privateRepoDirectory(root, identity.repoId);
  const options = { repositoryRoot: repo.root, dataRoot: local.dataRoot, repoId: identity.repoId, authorize: () => true, authorizeManifest: () => true };
  const service = await RequirementService.open(options);
  const state = await RequirementStateStore.open({ ...options, authorize: () => true });
  const worktrees: string[] = [repo.root];
  const bind = async (requirementId: string) => {
    const worktree = await addWorktree(repo); worktrees.push(worktree.root);
    const baseCommit = (await exec(GIT, ["rev-parse", "HEAD"], { cwd: worktree.root, env: GIT_ENV })).stdout.trim();
    const current = state.read(requirementId);
    return state.bindWorkspace({ requirementId, version: current.version, path: worktree.root, prepareOperationId: uuidv7(), baseCommit });
  };
  return { root, repo, identity, ...local, options, service, state, worktrees, bind };
}

async function populatedWorld() {
  const w = await world();
  const secret = "PROD-BODY-MUST-NOT-ENTER-RECEIPTS-OR-SQLITE-85b179";
  const created = await w.service.create({ requestId: uuidv7(), operationId: uuidv7(), title: "活动需求", body: `${secret}\n版本一` });
  await w.bind(created.requirementId);
  const approve = draftApprover(w.options, w.service, { requirementId: created.requirementId, operationId: created.operationId, title: "活动需求", body: `${secret}\n版本一` });
  const first = await approve();
  await w.service.updateDraft({ requirementId: created.requirementId, operationId: uuidv7(), version: first.version, title: "活动需求", body: `${secret}\n版本二草稿` });
  const active = await approve(`${secret}\n版本三批准`);

  const closedCreated = await w.service.create({ requestId: uuidv7(), operationId: uuidv7(), title: "关闭需求", body: `${secret}\n关闭正文` });
  const closing = w.state.beginClose({ requirementId: closedCreated.requirementId, version: closedCreated.version, intent: { operationId: uuidv7(), reason: "cancelled", receiptId: uuidv7() } });
  const closed = w.state.finishClose({ requirementId: closedCreated.requirementId, version: closing.version, operationId: closing.data.close!.operationId });
  return { ...w, secret, activeId: created.requirementId, active, closedId: closedCreated.requirementId, closed };
}

function backupOptions(w: Awaited<ReturnType<typeof world>>, operationId = uuidv7()): RequirementBackupOptions {
  return { repoDirectory: w.repoDirectory, repoId: w.identity.repoId, operationId, worktreeRoots: w.worktrees };
}

async function isolation(w: Awaited<ReturnType<typeof world>>) {
  const root = join(w.root, `isolation-${uuidv7()}`);
  return privateRepoDirectory(root, w.identity.repoId);
}

function restoreOptions(
  w: Awaited<ReturnType<typeof world>>,
  backup: Awaited<ReturnType<typeof createRequirementBackup>>,
  target: Awaited<ReturnType<typeof isolation>>,
  operationId = uuidv7(),
): RequirementRestoreOptions {
  return {
    backupDirectory: backup.backupDirectory,
    backupOperationId: backup.operationId,
    backupManifestHash: backup.manifestHash,
    repoDirectory: target.repoDirectory,
    repoId: w.identity.repoId,
    operationId,
    worktreeRoots: w.worktrees,
  };
}

async function gitCount(path: string): Promise<number> {
  return Number((await exec(GIT, ["rev-list", "--count", "HEAD"], { cwd: path, env: GIT_ENV })).stdout.trim());
}

test("完整备份包含WAL一致状态、prod多版本Git对象/refs/config，回执和manifest不回显正文且没有远端动作", async () => {
  const w = await populatedWorld();
  const remoteProbe = join(w.root, "remote-probe.sh"), remoteSentinel = join(w.root, "remote-ran");
  await writeFile(remoteProbe, `#!/bin/sh\nprintf remote > ${JSON.stringify(remoteSentinel)}\nexit 91\n`, { mode: 0o755 });
  const sourceGitConfig = join(w.repoDirectory, "requirements", w.activeId, ".git", "config");
  await writeFile(sourceGitConfig, Buffer.concat([await readFile(sourceGitConfig), Buffer.from(`\n[remote "origin"]\n\turl = ext::${remoteProbe}\n`)]), { mode: 0o600 });
  await chmod(sourceGitConfig, 0o600);
  const writer = new DatabaseSync(repositoryDatabase(w.dataRoot, w.identity.repoId));
  writer.exec("PRAGMA wal_autocheckpoint=0");
  writer.prepare("INSERT INTO records(id,namespace,record_key,version,data) VALUES(?,?,?,?,?)").run(uuidv7(), "backup_fixture", "wal-only", 1, JSON.stringify({ marker: "wal-committed" }));
  try {
    const receipt = await createRequirementBackup(backupOptions(w));
    expect(receipt).toMatchObject({ state: "completed", executable: false, repoId: w.identity.repoId });
    expect(JSON.stringify(receipt)).not.toContain(w.secret);
    const manifestBytes = await readFile(receipt.manifestPath);
    expect(manifestBytes.includes(Buffer.from(w.secret))).toBe(false);
    const manifest = JSON.parse(manifestBytes.toString("utf8"));
    expect(manifest.stateSource).toBe("data.db:requirements");
    expect(manifest.files.some((file: { relativePath: string }) => file.relativePath.endsWith("/.git/config"))).toBe(true);
    expect(manifest.files.some((file: { relativePath: string }) => file.relativePath.includes("/.git/objects/"))).toBe(true);
    expect(manifest.files.every((file: Record<string, unknown>) => Object.keys(file).sort().join(",") === "hash,relativePath,size")).toBe(true);

    const payloadRepo = join(receipt.backupDirectory, "payload", "requirements", w.activeId);
    expect(await gitCount(payloadRepo)).toBe(3);
    expect((await exec(GIT, ["rev-parse", "HEAD"], { cwd: payloadRepo, env: GIT_ENV })).stdout.trim()).toBe(w.active.commit);
    expect((await readdir(join(payloadRepo, ".git", "refs", "heads"))).includes("main")).toBe(true);
    expect(await readFile(join(payloadRepo, ".git", "config"))).toEqual(await readFile(sourceGitConfig));
    expect(existsSync(remoteSentinel)).toBe(false);
    const snapshot = new DatabaseSync(join(receipt.backupDirectory, "payload", "data.db"), { readOnly: true });
    try { expect(JSON.parse(String(snapshot.prepare("SELECT data FROM records WHERE namespace='backup_fixture'").get()?.data))).toEqual({ marker: "wal-committed" }); }
    finally { snapshot.close(); }
    expect((await stat(receipt.backupDirectory)).mode & 0o077).toBe(0);
  } finally { writer.close(); }
});

// 多次真实 Git/SQLite 恢复属于集成流程；测试调度预算独立于产品 Git/停止操作的超时约束。
test("恢复复制到隔离目录并完整核对Git/数据引用；旧能力不复用、可信终态及正文原始字节保留", async () => {
  const w = await populatedWorld();
  const backup = await createRequirementBackup(backupOptions(w));

  // 测试装置构造含旧能力的可信备份输入，并重新计算其清单和内容校验值。
  const payloadDatabasePath = join(backup.backupDirectory, "payload", "data.db");
  const staleClaim = { format: "requirement-service-write-claim/v1", repoId: w.identity.repoId, requirementId: w.activeId,
    operationId: uuidv7(), ownerToken: uuidv7(), pid: process.pid, acquiredAt: Date.now() };
  const payloadDatabase = new DatabaseSync(payloadDatabasePath);
  try {
    payloadDatabase.prepare("INSERT INTO records(id,namespace,record_key,version,data) VALUES(?,?,?,?,?)").run(uuidv7(), REQUIREMENT_WRITE_COORDINATION_NAMESPACE, w.activeId, 1, JSON.stringify(staleClaim));
    payloadDatabase.prepare("INSERT INTO records(id,namespace,record_key,version,data) VALUES(?,?,?,?,?)").run(uuidv7(), "pm_ownership", w.activeId, 1, JSON.stringify({ requirementId: w.activeId, fence: 9, lease: { requirementId: w.activeId, fence: 9 } }));
  } finally { payloadDatabase.close(); }
  const payloadBytes = await readFile(payloadDatabasePath);
  const payloadHash = createHash("sha256").update(payloadBytes).digest("hex");
  const manifest = JSON.parse(await readFile(backup.manifestPath, "utf8"));
  manifest.database = { relativePath: "data.db", size: payloadBytes.length, hash: payloadHash };
  manifest.files = manifest.files.map((file: { relativePath: string; size: number; hash: string }) => file.relativePath === "data.db" ? manifest.database : file);
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  const legacyManifestHash = createHash("sha256").update(manifestBytes).digest("hex");
  await writeFile(backup.manifestPath, manifestBytes);
  const backupOperationPath = join(backup.backupDirectory, requirementBackupFiles.operation);
  const backupOperation = JSON.parse(await readFile(backupOperationPath, "utf8"));
  backupOperation.manifestHash = legacyManifestHash;
  await writeFile(backupOperationPath, JSON.stringify(sealOperationLog(backupOperation)));

  const sourceClosing = w.state.beginClose({ requirementId: w.activeId, version: w.active.version,
    intent: { operationId: uuidv7(), reason: "rejected", receiptId: uuidv7() } });
  const sourceClosed = w.state.finishClose({ requirementId: w.activeId, version: sourceClosing.version, operationId: sourceClosing.data.close!.operationId });
  const target = await isolation(w);
  const targetDataPath = repositoryDatabase(target.dataRoot, w.identity.repoId);
  withDatabase(targetDataPath, (db) => db.create("requirements", w.activeId, sourceClosed.data));
  const restoreRequest = restoreOptions(w, { ...backup, manifestHash: legacyManifestHash }, target);
  const restored = await restoreRequirementBackup(restoreRequest);
  expect(restored).toMatchObject({ state: "reconciled", restoreStatus: "needs_review", executable: false });
  expect(await restoreRequirementBackup(restoreRequest)).toEqual(restored);
  expect(JSON.stringify(restored)).not.toContain(w.secret);
  expect(existsSync(targetDataPath)).toBe(true);
  const current = new DatabaseSync(targetDataPath, { readOnly: true });
  try {
    expect(JSON.parse(String(current.prepare("SELECT data FROM records WHERE namespace='requirements' AND record_key=?").get(w.activeId)?.data))).toMatchObject({ lifecycle: "closed", close: { reason: "rejected" } });
  } finally { current.close(); }
  expect(await gitCount(join(target.repoDirectory, "requirements", w.activeId))).toBe(3);
  expect(await readFile(join(target.repoDirectory, "requirements", w.closedId, "prod.md"))).toEqual(await readFile(join(w.repoDirectory, "requirements", w.closedId, "prod.md")));

  const activeStatus = restored.requirements.find((item) => item.requirementId === w.activeId)!;
  const closedStatus = restored.requirements.find((item) => item.requirementId === w.closedId)!;
  expect(activeStatus).toMatchObject({ sourceLifecycle: "active", retainedLifecycle: "closed", closeReason: "rejected", recoveryReason: null, executable: false });
  expect(closedStatus).toMatchObject({ sourceLifecycle: "closed", retainedLifecycle: "closed", closeReason: "cancelled", executable: false });

  const recovered = new DatabaseSync(restored.recoveredDatabasePath!, { readOnly: true });
  try {
    const active = JSON.parse(String(recovered.prepare("SELECT data FROM records WHERE namespace='requirements' AND record_key=?").get(w.activeId)?.data));
    const closed = JSON.parse(String(recovered.prepare("SELECT data FROM records WHERE namespace='requirements' AND record_key=?").get(w.closedId)?.data));
    expect(active).toMatchObject({ lifecycle: "closed", close: { reason: "rejected" }, saved: { commit: w.active.commit }, approved: { commit: w.active.commit } });
    expect(closed).toMatchObject({ lifecycle: "closed", recovery: "needs_review", close: { reason: "cancelled" } });
    expect(recovered.prepare("SELECT count(*) AS n FROM records WHERE namespace='pm_ownership'").get()?.n).toBe(0);
    expect(recovered.prepare("SELECT count(*) AS n FROM records WHERE namespace=?").get(REQUIREMENT_WRITE_COORDINATION_NAMESPACE)?.n).toBe(0);
  } finally { recovered.close(); }
  expect((await readFile(restored.recoveredDatabasePath!)).includes(Buffer.from(w.secret))).toBe(false);
}, 30_000);

test("恢复完成后仍逐项核对完整Git和恢复库，不覆盖后续外部改动", async () => {
  const w = await populatedWorld();
  const backup = await createRequirementBackup(backupOptions(w));
  const target = await isolation(w);
  const input = restoreOptions(w, backup, target);
  const result = await restoreRequirementBackup(input);
  const restoredRepo = join(target.repoDirectory, "requirements", w.activeId);
  const configPath = join(restoredRepo, ".git", "config");
  const config = await readFile(configPath);
  await writeFile(configPath, Buffer.concat([config, Buffer.from("\n# external change\n")]));
  await expect(restoreRequirementBackup(input)).rejects.toMatchObject({ code: "restore_target_conflict" });
  await writeFile(configPath, config);
  const firstCommit = (await exec(GIT, ["rev-list", "--reverse", "HEAD"], { cwd: restoredRepo, env: GIT_ENV })).stdout.trim().split("\n")[0]!;
  const oldBlob = (await exec(GIT, ["rev-parse", `${firstCommit}:prod.md`], { cwd: restoredRepo, env: GIT_ENV })).stdout.trim();
  const objectPath = join(restoredRepo, ".git", "objects", oldBlob.slice(0, 2), oldBlob.slice(2));
  const object = await readFile(objectPath);
  await rm(objectPath);
  await expect(restoreRequirementBackup(input)).rejects.toMatchObject({ code: "restore_target_conflict" });
  await writeFile(objectPath, object, { mode: 0o600 });
  const db = new DatabaseSync(result.recoveredDatabasePath!);
  try {
    db.prepare("INSERT INTO records VALUES(?,?,?,?,?)").run(uuidv7(), REQUIREMENT_WRITE_COORDINATION_NAMESPACE, w.activeId, 1, JSON.stringify({ external: true }));
  } finally { db.close(); }
  await expect(restoreRequirementBackup(input)).rejects.toMatchObject({ code: "recovered_database_changed" });
  const after = new DatabaseSync(result.recoveredDatabasePath!, { readOnly: true });
  try { expect(after.prepare("SELECT count(*) AS n FROM records WHERE namespace=?").get(REQUIREMENT_WRITE_COORDINATION_NAMESPACE)?.n).toBe(1); }
  finally { after.close(); }
}, 30_000);

test("旧备份之后更新并关闭的可信状态保留，内容仍明确来自原备份", async () => {
  const w = await populatedWorld();
  const backup = await createRequirementBackup(backupOptions(w));
  const later = await w.service.updateDraft({ requirementId: w.activeId, operationId: uuidv7(), version: w.active.version,
    title: "活动需求", body: "备份后新增的当前版本" });
  const closing = w.state.beginClose({ requirementId: w.activeId, version: later.version,
    intent: { operationId: uuidv7(), reason: "rejected", receiptId: uuidv7() } });
  const closed = w.state.finishClose({ requirementId: w.activeId, version: closing.version, operationId: closing.data.close!.operationId });
  const target = await isolation(w);
  withDatabase(repositoryDatabase(target.dataRoot, w.identity.repoId), (db) => db.create("requirements", w.activeId, closed.data, w.activeId));
  const input = restoreOptions(w, backup, target);
  const result = await restoreRequirementBackup(input);
  expect(result).toMatchObject({ executable: false, restoreStatus: "needs_review" });
  const db = new DatabaseSync(result.recoveredDatabasePath!, { readOnly: true });
  try {
    const record = JSON.parse(String(db.prepare("SELECT data FROM records WHERE namespace='requirements' AND record_key=?").get(w.activeId)!.data));
    expect(record).toEqual(closed.data);
    expect(record.saved.commit).toBe(later.commit);
  } finally { db.close(); }
  expect((await exec(GIT, ["rev-parse", "HEAD"], { cwd: join(target.repoDirectory, "requirements", w.activeId), env: GIT_ENV })).stdout.trim()).toBe(w.active.commit);
  await expect(restoreRequirementBackup(input)).resolves.toEqual(result);
}, 30_000);

test("已完成操作日志的未知字段和闲置阶段字段改写均拒绝", async () => {
  const w = await world();
  await w.service.create({ requestId: uuidv7(), operationId: uuidv7(), title: "日志", body: "正文" });
  const options = backupOptions(w);
  const backup = await createRequirementBackup(options);
  const path = join(backup.backupDirectory, requirementBackupFiles.operation);
  const original = await readFile(path);
  const log = JSON.parse(original.toString());
  await writeFile(path, JSON.stringify({ ...log, sourceFingerprint: "0".repeat(64) }));
  await expect(createRequirementBackup(options)).rejects.toMatchObject({ code: "operation_log_invalid" });
  await writeFile(path, JSON.stringify(sealOperationLog({ ...log, unknown: true })));
  await expect(createRequirementBackup(options)).rejects.toMatchObject({ code: "operation_log_invalid" });
  await writeFile(path, original);
  const target = await isolation(w);
  const input = restoreOptions(w, backup, target);
  await restoreRequirementBackup(input);
  const restorePath = join(target.repoDirectory, "backups", "requirement-restores", input.operationId, ".requirement-restore-operation.json");
  const restoreLog = JSON.parse(await readFile(restorePath, "utf8"));
  await writeFile(restorePath, JSON.stringify(sealOperationLog({ ...restoreLog, unknown: "unexpected" })));
  await expect(restoreRequirementBackup(input)).rejects.toMatchObject({ code: "restore_log_invalid" });
}, 30_000);

test("已完成操作仍有有效或损坏写占用、未完成操作或缺少业务现场均默认拒绝；无占用时可备份", async () => {
  const w = await world();
  const completedOperationId = uuidv7();
  const created = await w.service.create({ requestId: uuidv7(), operationId: completedOperationId, title: "需求", body: "正文" });
  const dataPath = repositoryDatabase(w.dataRoot, w.identity.repoId);
  const writeClaim = { format: "requirement-service-write-claim/v2", processGroups: [], repoId: w.identity.repoId, requirementId: created.requirementId,
    operationId: completedOperationId, ownerToken: uuidv7(), pid: process.pid, acquiredAt: Date.now() };
  withDatabase(dataPath, (db) => {
    expect((db.read("requirement_service_operations", completedOperationId)?.data as { finalVersion: number | null }).finalVersion).not.toBeNull();
    db.create(REQUIREMENT_WRITE_COORDINATION_NAMESPACE, created.requirementId, writeClaim);
  });
  await expect(createRequirementBackup(backupOptions(w))).rejects.toMatchObject({ name: "RequirementBackupError", code: "requirement_write_busy" });
  withDatabase(dataPath, (db) => {
    const claim = db.read(REQUIREMENT_WRITE_COORDINATION_NAMESPACE, created.requirementId)!;
    db.remove(REQUIREMENT_WRITE_COORDINATION_NAMESPACE, created.requirementId, claim.version);
    db.create(REQUIREMENT_WRITE_COORDINATION_NAMESPACE, created.requirementId, { corrupt: true });
  });
  await expect(createRequirementBackup(backupOptions(w))).rejects.toMatchObject({ name: "RequirementBackupError", code: "requirement_write_busy" });
  withDatabase(dataPath, (db) => {
    const claim = db.read(REQUIREMENT_WRITE_COORDINATION_NAMESPACE, created.requirementId)!;
    db.remove(REQUIREMENT_WRITE_COORDINATION_NAMESPACE, created.requirementId, claim.version);
  });
  let injectedDuringMaintenance = false;
  const prepare = DatabaseSync.prototype.prepare;
  vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (this: DatabaseSync, sql: string) {
    if (!injectedDuringMaintenance && sql.includes("AS occupied") && existsSync(join(w.repoDirectory, ".database-maintenance.json"))) {
      injectedDuringMaintenance = true;
      const raw = new DatabaseSync(dataPath);
      try {
        raw.prepare("INSERT INTO records(id,namespace,record_key,version,data) VALUES(?,?,?,?,?)").run(uuidv7(), REQUIREMENT_WRITE_COORDINATION_NAMESPACE, created.requirementId, 1, JSON.stringify({ corrupt: "maintenance-race" }));
      } finally { raw.close(); }
    }
    return prepare.call(this, sql);
  });
  try {
    await expect(createRequirementBackup(backupOptions(w))).rejects.toMatchObject({ name: "RequirementBackupError", code: "requirement_write_busy" });
  } finally { vi.restoreAllMocks(); }
  expect(injectedDuringMaintenance).toBe(true);
  withDatabase(dataPath, (db) => {
    const claim = db.read(REQUIREMENT_WRITE_COORDINATION_NAMESPACE, created.requirementId)!;
    db.remove(REQUIREMENT_WRITE_COORDINATION_NAMESPACE, created.requirementId, claim.version);
  });
  await expect(createRequirementBackup(backupOptions(w))).resolves.toMatchObject({ state: "completed", executable: false });

  const unfinishedId = uuidv7();
  withDatabase(repositoryDatabase(w.dataRoot, w.identity.repoId), (db) => db.create("requirement_service_operations", unfinishedId, {
    format: "requirement-service-operation/v1", operationId: unfinishedId, repoId: w.identity.repoId,
    requirementId: created.requirementId, finalVersion: null, git: null,
  }));
  await expect(createRequirementBackup(backupOptions(w))).rejects.toMatchObject({ name: "RequirementBackupError", code: "unfinished_requirement_operation" });
  await expect(createRequirementBackup({ ...backupOptions(w), worktreeRoots: [] })).rejects.toMatchObject({ code: "invalid_options" });
  expect(RequirementBackupError).toBeTypeOf("function");
});

test("备份完成响应中断后同operation重试复用快照与文件，不重复复制", async () => {
  const w = await populatedWorld();
  const operationId = uuidv7();
  const options = backupOptions(w, operationId);
  const first = await createRequirementBackup(options);
  const operationPath = join(first.backupDirectory, requirementBackupFiles.operation);
  // 把日志退回写完 manifest、尚未记 completed 的阶段，等价于完成那一步中断
  const { manifestHash: _manifestHash, ...completed } = JSON.parse(await readFile(operationPath, "utf8"));
  await writeFile(operationPath, JSON.stringify(sealOperationLog({ ...completed, phase: "copied" })), { mode: 0o600 });
  const helperBefore = (await readdir(join(w.repoDirectory, "backups"))).filter((name) => /^[0-9a-f-]{36}$/.test(name));
  const receipt = await createRequirementBackup(options);
  expect(receipt).toEqual(first);
  const helperAfter = (await readdir(join(w.repoDirectory, "backups"))).filter((name) => /^[0-9a-f-]{36}$/.test(name));
  expect(helperAfter).toEqual(helperBefore);
  expect(await createRequirementBackup(options)).toEqual(receipt);
  expect((await readdir(join(w.repoDirectory, "backups", "requirement-backups"))).filter((name) => name === operationId)).toHaveLength(1);
}, 30_000);

test("恢复中断重试不覆盖外部新文件，且伪manifest或不同目标hash不能冒充本次备份", async () => {
  const w = await populatedWorld();
  const backup = await createRequirementBackup(backupOptions(w));
  const target = await isolation(w);
  const operationId = uuidv7();
  // 归档目录不存在会让对账在复制完成后失败，留下停在 copied 阶段的恢复操作
  const options = { ...restoreOptions(w, backup, target, operationId), archiveDirectory: join(w.root, "missing-archives") };
  await expect(restoreRequirementBackup(options)).rejects.toMatchObject({ code: "recovery_failed" });
  const restoredProd = join(target.repoDirectory, "requirements", w.activeId, "prod.md");
  await writeFile(restoredProd, "external-new-content", { mode: 0o600 });
  await expect(restoreRequirementBackup(options)).rejects.toMatchObject({ code: "restore_target_conflict", restoreStatus: "needs_review", executable: false });
  expect(await readFile(restoredProd, "utf8")).toBe("external-new-content");

  const another = await isolation(w);
  await expect(restoreRequirementBackup({ ...restoreOptions(w, backup, another), backupManifestHash: "0".repeat(64) })).rejects.toMatchObject({ code: "backup_operation_invalid" });
  expect(RequirementRecoveryError).toBeTypeOf("function");
});

test("归档只按完整UUID路径作线索，文件不可读仍可对账且读取探针为零", async () => {
  const w = await populatedWorld();
  const backup = await createRequirementBackup(backupOptions(w));
  const target = await isolation(w);
  const archiveDirectory = join(w.root, "archives");
  await mkdir(archiveDirectory, { mode: 0o700 });
  const archivePath = join(archiveDirectory, `${w.activeId}.归档线索.md`);
  await writeFile(archivePath, "ARCHIVE-BODY-MUST-NOT-BE-READ", { mode: 0o000 });
  let restore: Awaited<ReturnType<typeof restoreRequirementBackup>>;
  try {
    restore = await restoreRequirementBackup({ ...restoreOptions(w, backup, target), archiveDirectory, registeredArchivePaths: [archivePath] });
  } finally { await chmod(archivePath, 0o600); }
  expect(restore.requirements.find((item) => item.requirementId === w.activeId)).toMatchObject({ recoveryReason: "archive_found", archivePath, executable: false });
  expect(JSON.stringify(restore)).not.toContain("ARCHIVE-BODY-MUST-NOT-BE-READ");
});
