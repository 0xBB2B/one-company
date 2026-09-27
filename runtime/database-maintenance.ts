import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { closeSync, constants, copyFileSync, fsyncSync, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { UUID_V7_PATTERN, uuidv7 } from "./database.ts";
import { assertRegularDatabaseFiles, DATABASE_APPLICATION_IDS, DATABASE_MAINTENANCE_FILE, DATABASE_RECOVERY_FILE, DATABASE_SCHEMA_VERSIONS, DATABASE_SNAPSHOT_FILE, pathExists } from "./database-paths.ts";
import type { DatabaseKind } from "./database-paths.ts";

export class DatabaseMaintenanceError extends Error {
  readonly code: string;
  constructor(code: string) { super(`数据库维护未完成：${code}；保持原数据，不恢复执行权限`); this.name = "DatabaseMaintenanceError"; this.code = code; }
}

export interface DatabaseManagementAuthorization {
  authorized: true;
  writesStopped: true;
  authorizationId: string;
  principal: string;
}

declare const maintenanceBrand: unique symbol;
export interface DatabaseMaintenancePermit { readonly [maintenanceBrand]: true }
export interface DatabaseMaintenanceScope {
  directory: string;
  worktreeRoots: string[];
  /** 首次维护可固定操作身份；强杀续办必须提供与旧标记完全相同的值。 */
  operationId?: string;
  takeover?: {
    authorize(context: Readonly<{ operationId: string; previousPid: number; previousProcessStartIdentity: string; stage: "takeover" }>): DatabaseManagementAuthorization;
  };
}
interface PrivateFileState { contents: string; inode: number; device: number; size: number; mtimeMs: number; ctimeMs: number }
interface Maintenance {
  directory: string; path: string; file: PrivateFileState; operationId: string; takeover: boolean; active: boolean;
}
interface MaintenanceMarker {
  format: "database-maintenance/v2";
  operationId: string;
  state: "maintenance";
  owner: { pid: number; processStartIdentity: string };
  ownershipEpoch: number;
  createdAt: string;
  takeover?: { authorizationId: string; principal: string; previousOwner: MaintenanceMarker["owner"]; takenOverAt: string };
}
const permits = new WeakMap<DatabaseMaintenancePermit, Maintenance>();

function privateDirectory(path: string): string {
  if (!isAbsolute(path)) throw new DatabaseMaintenanceError("absolute_directory_required");
  const expected = resolve(path), actual = realpathSync(path);
  const stat = lstatSync(expected);
  if (actual !== expected || !stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) throw new DatabaseMaintenanceError("private_directory_required");
  return actual;
}
function assertPrivateChildDirectory(path: string, parent: string, code: string): void {
  if (dirname(path) !== parent || privateDirectory(path) !== path) throw new DatabaseMaintenanceError(code);
}
function overlaps(a: string, b: string): boolean {
  const path = relative(a, b);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}
function syncDirectory(path: string) { const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); try { fsyncSync(fd); } finally { closeSync(fd); } }
function writeNew(path: string, text: string) {
  const fd = openSync(path, "wx", 0o600);
  try { writeFileSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
}
function readPrivateText(path: string, code: string): PrivateFileState {
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch { throw new DatabaseMaintenanceError(code); }
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || (before.mode & 0o077) !== 0 || (process.getuid && before.uid !== process.getuid())) throw new DatabaseMaintenanceError(code);
    const contents = readFileSync(fd, "utf8"), after = fstatSync(fd), named = lstatSync(path);
    if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1 || named.ino !== after.ino || named.dev !== after.dev || before.ino !== after.ino || before.dev !== after.dev || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || Buffer.byteLength(contents) !== after.size) throw new DatabaseMaintenanceError(code);
    return { contents, inode: after.ino, device: after.dev, size: after.size, mtimeMs: after.mtimeMs, ctimeMs: after.ctimeMs };
  } finally { closeSync(fd); }
}
function samePrivateFile(path: string, expected: PrivateFileState, code: string): PrivateFileState {
  const current = readPrivateText(path, code);
  if (current.inode !== expected.inode || current.device !== expected.device || current.size !== expected.size || current.mtimeMs !== expected.mtimeMs || current.ctimeMs !== expected.ctimeMs || current.contents !== expected.contents) throw new DatabaseMaintenanceError(code);
  return current;
}
function processMissing(pid: number): boolean {
  try { process.kill(pid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
}
function processIdentity(pid: number): { state: "active"; identity: string } | { state: "missing" | "unknown" } {
  try {
    const output = execFileSync("/bin/ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5_000,
      env: { PATH: "/usr/bin:/bin", LC_ALL: "C", LANG: "C" },
    }).trim();
    if (output) return { state: "active", identity: `pid:${pid}:lstart:${output}` };
  } catch { /* 无进程查询权限时仍不能把活进程判为已退出。 */ }
  return { state: processMissing(pid) ? "missing" : "unknown" };
}
const PROCESS_INSTANCE = `pid:${process.pid}:instance:${uuidv7()}`;
function ownProcessIdentity(): string {
  const identity = processIdentity(process.pid);
  // 受限安装环境可能禁止执行 ps；随机实例身份只用于保全归属，不能据此抢占活 PID。
  return identity.state === "active" ? identity.identity : PROCESS_INSTANCE;
}
function parseMaintenanceMarker(file: PrivateFileState): MaintenanceMarker {
  let marker: Partial<MaintenanceMarker>;
  try { marker = JSON.parse(file.contents) as Partial<MaintenanceMarker>; } catch { throw new DatabaseMaintenanceError("maintenance_needs_review"); }
  if (marker.format !== "database-maintenance/v2" || marker.state !== "maintenance" || !UUID_V7_PATTERN.test(String(marker.operationId)) || !Number.isSafeInteger(marker.owner?.pid) || Number(marker.owner?.pid) <= 0 || typeof marker.owner?.processStartIdentity !== "string" || !marker.owner.processStartIdentity || !Number.isSafeInteger(marker.ownershipEpoch) || Number(marker.ownershipEpoch) < 1 || typeof marker.createdAt !== "string") throw new DatabaseMaintenanceError("maintenance_needs_review");
  return marker as MaintenanceMarker;
}
function takeoverMarker(path: string, directory: string, existing: PrivateFileState, marker: MaintenanceMarker, scope: DatabaseMaintenanceScope): PrivateFileState {
  if (!scope.takeover || scope.operationId !== marker.operationId) throw new DatabaseMaintenanceError("maintenance_already_exists");
  const identity = marker.owner.processStartIdentity;
  const kernelIdentity = identity.startsWith(`pid:${marker.owner.pid}:lstart:`);
  const instanceIdentity = identity.startsWith(`pid:${marker.owner.pid}:instance:`)
    && UUID_V7_PATTERN.test(identity.slice(`pid:${marker.owner.pid}:instance:`.length));
  if (!kernelIdentity && !instanceIdentity) throw new DatabaseMaintenanceError("maintenance_needs_review");
  if (instanceIdentity && !processMissing(marker.owner.pid)) throw new DatabaseMaintenanceError("maintenance_owner_active");
  const observed = processIdentity(marker.owner.pid);
  if (observed.state === "unknown") throw new DatabaseMaintenanceError("maintenance_owner_unknown");
  if (observed.state === "active" && (instanceIdentity || observed.identity === identity)) throw new DatabaseMaintenanceError("maintenance_owner_active");
  let authorization: DatabaseManagementAuthorization;
  try { authorization = scope.takeover.authorize(Object.freeze({ operationId: marker.operationId, previousPid: marker.owner.pid, previousProcessStartIdentity: marker.owner.processStartIdentity, stage: "takeover" })); }
  catch { throw new DatabaseMaintenanceError("maintenance_takeover_unauthorized"); }
  if (!authorization || authorization.authorized !== true || authorization.writesStopped !== true || !authorization.authorizationId || !authorization.principal) throw new DatabaseMaintenanceError("maintenance_takeover_unauthorized");
  samePrivateFile(path, existing, "maintenance_identity_changed");
  const next: MaintenanceMarker = {
    ...marker,
    owner: { pid: process.pid, processStartIdentity: ownProcessIdentity() },
    ownershipEpoch: marker.ownershipEpoch + 1,
    takeover: { authorizationId: authorization.authorizationId, principal: authorization.principal, previousOwner: marker.owner, takenOverAt: new Date().toISOString() },
  };
  const temporary = join(directory, `.database-maintenance-${uuidv7()}.tmp`), contents = JSON.stringify(next);
  writeNew(temporary, contents);
  samePrivateFile(path, existing, "maintenance_identity_changed");
  renameSync(temporary, path); syncDirectory(directory);
  return readPrivateText(path, "maintenance_identity_changed");
}
function assertPermit(permit: DatabaseMaintenancePermit): Maintenance {
  const state = permits.get(permit);
  if (!state?.active) throw new DatabaseMaintenanceError("invalid_or_expired_permit");
  samePrivateFile(state.path, state.file, "maintenance_identity_changed");
  if (privateDirectory(state.directory) !== state.directory) throw new DatabaseMaintenanceError("directory_identity_changed");
  return state;
}

/** 仅供同一内部维护模块族取得已核验目录；没有有效permit时不会泄露路径。 */
export function databaseMaintenanceDirectory(permit: DatabaseMaintenancePermit, operationId?: string): string {
  const state = assertPermit(permit);
  if (state.takeover && operationId !== state.operationId) throw new DatabaseMaintenanceError("maintenance_operation_mismatch");
  return state.directory;
}

/** 内部协调入口，不是用户授权凭据；上层可信服务仍须核验授权并停止所有写入者。 */
export async function withDatabaseMaintenance<T>(scope: DatabaseMaintenanceScope, operation: (permit: DatabaseMaintenancePermit) => T | Promise<T>): Promise<T> {
  const directory = privateDirectory(scope.directory);
  for (const workspace of scope.worktreeRoots) {
    const actual = realpathSync(workspace);
    if (overlaps(actual, directory) || overlaps(directory, actual)) throw new DatabaseMaintenanceError("storage_overlaps_worktree");
  }
  if (scope.operationId !== undefined && !UUID_V7_PATTERN.test(scope.operationId)) throw new DatabaseMaintenanceError("invalid_operation_id");
  const path = join(directory, DATABASE_MAINTENANCE_FILE), operationId = scope.operationId ?? uuidv7();
  const marker: MaintenanceMarker = { format: "database-maintenance/v2", operationId, state: "maintenance", owner: { pid: process.pid, processStartIdentity: ownProcessIdentity() }, ownershipEpoch: 1, createdAt: new Date().toISOString() };
  const contents = JSON.stringify(marker);
  let file: PrivateFileState, tookOver = false;
  try { writeNew(path, contents); syncDirectory(directory); file = readPrivateText(path, "maintenance_identity_changed"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = readPrivateText(path, "maintenance_needs_review");
    if (!scope.takeover) throw new DatabaseMaintenanceError("maintenance_already_exists");
    const prior = parseMaintenanceMarker(existing);
    file = takeoverMarker(path, directory, existing, prior, scope);
    tookOver = true;
  }
  const state: Maintenance = { directory, path, file, operationId, takeover: tookOver, active: true };
  const permit = Object.freeze({}) as DatabaseMaintenancePermit;
  permits.set(permit, state);
  let result: T;
  let failure: unknown;
  let failed = false;
  try { result = await operation(permit); }
  catch (error) { failed = true; failure = error; }
  try {
    assertPermit(permit);
    unlinkSync(path); syncDirectory(directory);
  } catch (cleanupError) {
    if (failed) throw new AggregateError([failure, cleanupError], "数据库维护及收尾失败，状态需核对", { cause: failure });
    throw cleanupError;
  } finally { state.active = false; permits.delete(permit); }
  if (failed) throw failure;
  return result!;
}

interface FileFingerprint { hash: string; size: number; inode: number; device: number }
function fingerprint(path: string, expectedLinks = 1): FileFingerprint {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.nlink !== expectedLinks || (before.mode & 0o077) !== 0 || (process.getuid && before.uid !== process.getuid())) throw new DatabaseMaintenanceError("invalid_source_file");
    const hash = createHash("sha256"), buffer = Buffer.alloc(64 * 1024);
    for (;;) { const read = readSync(fd, buffer, 0, buffer.length, null); if (!read) break; hash.update(buffer.subarray(0, read)); }
    const after = fstatSync(fd);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new DatabaseMaintenanceError("source_changed");
    return { hash: hash.digest("hex"), size: after.size, inode: after.ino, device: after.dev };
  } finally { closeSync(fd); }
}
function sourceFingerprint(path: string) {
  assertRegularDatabaseFiles(path);
  const wal = pathExists(path + "-wal") ? fingerprint(path + "-wal") : null;
  // 只读SQLite打开WAL库时也可能创建空WAL；零字节文件没有任何已提交帧。
  return { main: fingerprint(path), wal: wal?.size ? wal : null };
}

export interface DatabaseSnapshotReceipt {
  operationId: string;
  kind: DatabaseKind;
  sourceFormat: "current" | "legacy";
  state: "prepared";
  restoreStatus: "needs_review";
  executable: false;
  sourceName: string;
  snapshotPath: string;
  snapshotHash: string;
  userVersion: number;
  applicationId: number;
}

/** SQLite一致副本包含已提交WAL数据；仅返回元数据，不激活、覆盖、重命名或恢复原库。 */
export function createDatabaseSnapshot(permit: DatabaseMaintenancePermit, kind: DatabaseKind, sourceFormat: "current" | "legacy" = "current"): DatabaseSnapshotReceipt {
  if (!["data", "global", "index"].includes(kind) || !["current", "legacy"].includes(sourceFormat) || (kind === "index" && sourceFormat === "legacy")) throw new DatabaseMaintenanceError("invalid_snapshot_kind");
  const state = assertPermit(permit);
  if (state.takeover) throw new DatabaseMaintenanceError("maintenance_operation_mismatch");
  const sourceName = `${kind}.${sourceFormat === "legacy" ? "sqlite" : "db"}`;
  const source = join(state.directory, sourceName);
  const before = sourceFingerprint(source);
  const operationId = uuidv7();
  const backups = join(state.directory, "backups");
  if (!pathExists(backups)) mkdirSync(backups, { mode: 0o700 });
  assertPrivateChildDirectory(backups, state.directory, "invalid_backup_directory");
  const destination = join(backups, operationId);
  mkdirSync(destination, { mode: 0o700 });
  assertPrivateChildDirectory(destination, backups, "invalid_backup_directory");
  const snapshotPath = join(destination, `${kind}.db`);
  const manifestPath = join(destination, DATABASE_SNAPSHOT_FILE);
  const metadata = { operationId, kind, sourceFormat, sourceName, sourceFingerprint: before, restoreStatus: "needs_review", executable: false };
  const prepared = JSON.stringify({ ...metadata, state: "copying" });
  writeNew(manifestPath, prepared); syncDirectory(destination); syncDirectory(backups);
  let manifestFile = readPrivateText(manifestPath, "snapshot_metadata_changed");
  function record(value: object) {
    assertPrivateChildDirectory(backups, state.directory, "invalid_backup_directory");
    assertPrivateChildDirectory(destination, backups, "invalid_backup_directory");
    manifestFile = replaceJson(manifestPath, destination, manifestFile, value);
  }
  let sourceDb: DatabaseSync | undefined;
  try {
    assertPermit(permit);
    sourceDb = new DatabaseSync(source, { readOnly: true, allowExtension: false });
    sourceDb.exec("PRAGMA trusted_schema = OFF; PRAGMA busy_timeout = 5000;");
    const userVersion = Number(sourceDb.prepare("PRAGMA user_version").get()?.user_version);
    const applicationId = Number(sourceDb.prepare("PRAGMA application_id").get()?.application_id);
    if (userVersion !== (sourceFormat === "legacy" ? 1 : DATABASE_SCHEMA_VERSIONS[kind]) || applicationId !== (sourceFormat === "legacy" ? 0 : DATABASE_APPLICATION_IDS[kind])) throw new DatabaseMaintenanceError("unrecognized_source_layout");
    const fd = openSync(snapshotPath, "wx", 0o600); closeSync(fd);
    // VACUUM INTO由SQLite取得一致读视图，不是只复制WAL主文件；所有文件步骤位于受控业务事务之外。
    sourceDb.prepare("VACUUM main INTO ?").run(snapshotPath);
    sourceDb.close(); sourceDb = undefined;
    assertPermit(permit);
    const after = sourceFingerprint(source);
    if (JSON.stringify(before) !== JSON.stringify(after)) throw new DatabaseMaintenanceError("source_changed");
    assertRegularDatabaseFiles(snapshotPath);
    const output = new DatabaseSync(snapshotPath, { readOnly: true, allowExtension: false });
    try {
      if (output.prepare("PRAGMA quick_check").get()?.quick_check !== "ok" || Number(output.prepare("PRAGMA user_version").get()?.user_version) !== userVersion || Number(output.prepare("PRAGMA application_id").get()?.application_id) !== applicationId) throw new DatabaseMaintenanceError("snapshot_check_failed");
    } finally { output.close(); }
    const outputFd = openSync(snapshotPath, "r"); try { fsyncSync(outputFd); } finally { closeSync(outputFd); }
    const snapshotHash = fingerprint(snapshotPath).hash;
    const receipt: DatabaseSnapshotReceipt = { operationId, kind, sourceFormat, sourceName, state: "prepared", restoreStatus: "needs_review", executable: false, snapshotPath, snapshotHash, userVersion, applicationId };
    record({ ...metadata, ...receipt });
    return receipt;
  } catch (error) {
    try { record({ ...metadata, state: "failed", reason: error instanceof DatabaseMaintenanceError ? error.code : "snapshot_failed" }); } catch { /* 保留copying或已被外部改变的现场供核对。 */ }
    throw new DatabaseMaintenanceError(error instanceof DatabaseMaintenanceError ? error.code : "snapshot_failed");
  } finally { sourceDb?.close(); }
}

export type LegacyDatabaseKind = "data" | "global";
export type DatabaseMigrationStage = "prepare" | "copy" | "archive" | "switch" | "complete";

export interface LegacyDatabaseMigrationRequest {
  operationId: string;
  kind: LegacyDatabaseKind;
  authorize(context: Readonly<{ operationId: string; kind: LegacyDatabaseKind; stage: DatabaseMigrationStage }>): DatabaseManagementAuthorization;
}

export interface LegacyDatabaseMigrationReceipt {
  operationId: string;
  kind: LegacyDatabaseKind;
  state: "completed";
  sourceName: string;
  targetName: string;
  targetHash: string;
  backupDirectory: string;
  archivedFiles: ReadonlyArray<{ name: string; hash: string; size: number }>;
  applicationId: number;
  userVersion: 1;
}

type MigrationPhase = "prepared" | "copying" | "copied" | "archiving" | "staging" | "stage_copying" | "switching" | "switched" | "completed";
interface MigrationManifest {
  format: "database-legacy-migration/v1";
  operationId: string;
  kind: LegacyDatabaseKind;
  sourceName: string;
  targetName: string;
  authorizationId: string;
  principal: string;
  phase: MigrationPhase;
  sourceFingerprint: ReturnType<typeof sourceFingerprint>;
  candidateName?: string;
  abandonedCandidates?: string[];
  candidateHash?: string;
  sourceFiles?: Array<{ name: string; hash: string; size: number; inode: number; device: number }>;
  archivedFiles?: Array<{ name: string; hash: string; size: number }>;
  stageName?: string;
  abandonedStages?: string[];
  targetHash?: string;
  lastFailure?: string;
}

function authorizeMigration(request: LegacyDatabaseMigrationRequest, stage: DatabaseMigrationStage, expected?: Pick<MigrationManifest, "authorizationId" | "principal">): DatabaseManagementAuthorization {
  let authorization: DatabaseManagementAuthorization;
  try { authorization = request.authorize(Object.freeze({ operationId: request.operationId, kind: request.kind, stage })); }
  catch { throw new DatabaseMaintenanceError("migration_authorization_failed"); }
  if (!authorization || authorization.authorized !== true || authorization.writesStopped !== true || typeof authorization.authorizationId !== "string" || !authorization.authorizationId || typeof authorization.principal !== "string" || !authorization.principal) {
    throw new DatabaseMaintenanceError("migration_authorization_failed");
  }
  if (expected && (authorization.authorizationId !== expected.authorizationId || authorization.principal !== expected.principal)) throw new DatabaseMaintenanceError("migration_authorization_changed");
  return authorization;
}

function parseMigrationManifest(file: PrivateFileState): MigrationManifest {
  let value: unknown;
  try { value = JSON.parse(file.contents); } catch { throw new DatabaseMaintenanceError("migration_log_invalid"); }
  const manifest = value as Partial<MigrationManifest>;
  const phases: MigrationPhase[] = ["prepared", "copying", "copied", "archiving", "staging", "stage_copying", "switching", "switched", "completed"];
  const phase = phases.indexOf(manifest.phase as MigrationPhase), hash = /^[0-9a-f]{64}$/;
  const allowedFiles = new Set([manifest.sourceName, `${manifest.sourceName}-wal`, `${manifest.sourceName}-shm`]);
  const validFiles = (files: MigrationManifest["sourceFiles"]) => Array.isArray(files) && files.length > 0 && new Set(files.map((file) => file.name)).size === files.length && files.every((file) => allowedFiles.has(file?.name) && hash.test(String(file.hash)) && Number.isSafeInteger(file.size) && file.size >= 0);
  if (manifest.format !== "database-legacy-migration/v1" || !UUID_V7_PATTERN.test(String(manifest.operationId)) || !["data", "global"].includes(String(manifest.kind)) || phase < 0 || !manifest.authorizationId || !manifest.principal || !manifest.sourceFingerprint?.main || !hash.test(String(manifest.sourceFingerprint.main.hash))) throw new DatabaseMaintenanceError("migration_log_invalid");
  if (phase >= 1 && (typeof manifest.candidateName !== "string" || !safeCandidateName(manifest.candidateName))) throw new DatabaseMaintenanceError("migration_log_invalid");
  if (phase >= 2 && (!hash.test(String(manifest.candidateHash)) || !validFiles(manifest.sourceFiles))) throw new DatabaseMaintenanceError("migration_log_invalid");
  if (phase >= 4 && (!Array.isArray(manifest.archivedFiles) || manifest.archivedFiles.length !== manifest.sourceFiles!.length || new Set(manifest.archivedFiles.map((file) => file.name)).size !== manifest.archivedFiles.length || !manifest.archivedFiles.every((file) => allowedFiles.has(file?.name) && hash.test(String(file?.hash)) && Number.isSafeInteger(file.size) && file.size >= 0))) throw new DatabaseMaintenanceError("migration_log_invalid");
  if (phase >= 5 && (typeof manifest.stageName !== "string" || !safeStageName(manifest.stageName))) throw new DatabaseMaintenanceError("migration_log_invalid");
  if (phase >= 6 && !hash.test(String(manifest.targetHash))) throw new DatabaseMaintenanceError("migration_log_invalid");
  return manifest as MigrationManifest;
}

function safeCandidateName(name: string): boolean { return /^(?:data|global)\.converted-[0-9a-f-]{36}\.db$/.test(name); }
function safeStageName(name: string): boolean { return /^(?:data|global)\.stage-[0-9a-f-]{36}\.db$/.test(name); }

function replaceJson(path: string, directory: string, expected: PrivateFileState, value: object): PrivateFileState {
  assertPrivateChildDirectory(directory, dirname(directory), "migration_operation_directory_changed");
  samePrivateFile(path, expected, "migration_log_changed");
  const temporary = join(directory, `.migration-log-${uuidv7()}.tmp`);
  writeNew(temporary, JSON.stringify(value));
  samePrivateFile(path, expected, "migration_log_changed");
  renameSync(temporary, path);
  syncDirectory(directory);
  return readPrivateText(path, "migration_log_changed");
}

function exactFileSet(path: string, name: string): Array<{ name: string; hash: string; size: number; inode: number; device: number }> {
  const files: Array<{ name: string; hash: string; size: number; inode: number; device: number }> = [];
  for (const suffix of ["", "-wal", "-shm"]) {
    const candidate = path + suffix;
    if (!pathExists(candidate)) continue;
    const value = fingerprint(candidate);
    files.push({ name: name + suffix, ...value });
  }
  if (!files.some((file) => file.name === name)) throw new DatabaseMaintenanceError("legacy_source_missing");
  return files;
}

function validateConverted(path: string, kind: LegacyDatabaseKind, expectedHash?: string): string {
  assertRegularDatabaseFiles(path);
  const hash = fingerprint(path).hash;
  if (expectedHash && hash !== expectedHash) throw new DatabaseMaintenanceError("migration_copy_changed");
  const db = new DatabaseSync(path, { readOnly: true, allowExtension: false });
  try {
    if (db.prepare("PRAGMA quick_check").get()?.quick_check !== "ok" || Number(db.prepare("PRAGMA user_version").get()?.user_version) !== 1 || Number(db.prepare("PRAGMA application_id").get()?.application_id) !== DATABASE_APPLICATION_IDS[kind]) {
      throw new DatabaseMaintenanceError("migration_copy_invalid");
    }
  } finally { db.close(); }
  return hash;
}

/**
 * 将固定旧库转换为带用途标签的一致副本，再把旧主文件及附属文件移入本次备份目录。
 * 授权回调是可信管理服务的集成点；本模块不把布尔夹具当成真实宿主授权。
 */
export function migrateLegacyDatabase(permit: DatabaseMaintenancePermit, request: LegacyDatabaseMigrationRequest): LegacyDatabaseMigrationReceipt {
  const state = assertPermit(permit);
  if (!UUID_V7_PATTERN.test(request.operationId) || !["data", "global"].includes(request.kind) || typeof request.authorize !== "function") throw new DatabaseMaintenanceError("invalid_migration_request");
  if (state.takeover && request.operationId !== state.operationId) throw new DatabaseMaintenanceError("maintenance_operation_mismatch");
  const sourceName = `${request.kind}.sqlite`, targetName = `${request.kind}.db`;
  const source = join(state.directory, sourceName), target = join(state.directory, targetName);
  const backups = join(state.directory, "backups"), operationDirectory = join(backups, request.operationId);
  const manifestPath = join(operationDirectory, ".database-migration.json");
  const recoveryMarkerPath = join(state.directory, DATABASE_RECOVERY_FILE);
  const archiveDirectory = join(operationDirectory, "legacy");
  let manifest: MigrationManifest | undefined;
  let manifestFile: PrivateFileState | undefined;

  const assertOperationDirectories = () => {
    assertPrivateChildDirectory(backups, state.directory, "invalid_backup_directory");
    assertPrivateChildDirectory(operationDirectory, backups, "migration_operation_directory_changed");
    if (pathExists(archiveDirectory)) assertPrivateChildDirectory(archiveDirectory, operationDirectory, "migration_archive_invalid");
  };
  const save = (next: MigrationManifest) => {
    if (!manifestFile) throw new DatabaseMaintenanceError("migration_log_invalid");
    assertOperationDirectories();
    manifestFile = replaceJson(manifestPath, operationDirectory, manifestFile, next);
    manifest = next;
  };
  const reauthorize = (stage: DatabaseMigrationStage) => {
    assertPermit(permit);
    return authorizeMigration(request, stage, manifest);
  };

  try {
    const firstAuthorization = authorizeMigration(request, "prepare");
    if (pathExists(operationDirectory)) {
      if (!pathExists(backups)) throw new DatabaseMaintenanceError("migration_operation_conflict");
      assertOperationDirectories();
      if (!pathExists(manifestPath)) throw new DatabaseMaintenanceError("migration_operation_conflict");
      manifestFile = readPrivateText(manifestPath, "migration_log_invalid");
      manifest = parseMigrationManifest(manifestFile);
      if (manifest.operationId !== request.operationId || manifest.kind !== request.kind || manifest.sourceName !== sourceName || manifest.targetName !== targetName) throw new DatabaseMaintenanceError("migration_operation_conflict");
      if (firstAuthorization.authorizationId !== manifest.authorizationId || firstAuthorization.principal !== manifest.principal) throw new DatabaseMaintenanceError("migration_authorization_changed");
    } else {
      if (pathExists(target) || pathExists(target + "-wal") || pathExists(target + "-shm")) throw new DatabaseMaintenanceError("migration_target_conflict");
      const before = sourceFingerprint(source);
      if (!pathExists(backups)) mkdirSync(backups, { mode: 0o700 });
      assertPrivateChildDirectory(backups, state.directory, "invalid_backup_directory");
      mkdirSync(operationDirectory, { mode: 0o700 });
      assertOperationDirectories();
      manifest = {
        format: "database-legacy-migration/v1", operationId: request.operationId, kind: request.kind, sourceName, targetName,
        authorizationId: firstAuthorization.authorizationId, principal: firstAuthorization.principal, phase: "prepared", sourceFingerprint: before,
      };
      writeNew(manifestPath, JSON.stringify(manifest)); syncDirectory(operationDirectory); syncDirectory(backups);
      manifestFile = readPrivateText(manifestPath, "migration_log_invalid");
    }
    const recoveryMarker = JSON.stringify({ format: "database-transition-block/v1", operationId: request.operationId, kind: request.kind, executable: false });
    let recoveryMarkerFile: PrivateFileState | undefined;
    if (pathExists(recoveryMarkerPath)) {
      recoveryMarkerFile = readPrivateText(recoveryMarkerPath, "recovery_marker_conflict");
      if (recoveryMarkerFile.contents !== recoveryMarker) throw new DatabaseMaintenanceError("recovery_marker_conflict");
    } else if (manifest.phase !== "completed") {
      writeNew(recoveryMarkerPath, recoveryMarker); syncDirectory(state.directory);
      recoveryMarkerFile = readPrivateText(recoveryMarkerPath, "recovery_marker_conflict");
    }
    const removeRecoveryMarker = () => {
      if (!recoveryMarkerFile) return;
      samePrivateFile(recoveryMarkerPath, recoveryMarkerFile, "recovery_marker_conflict");
      unlinkSync(recoveryMarkerPath); syncDirectory(state.directory);
      recoveryMarkerFile = undefined;
    };

    if (manifest.phase === "completed") {
      reauthorize("complete");
      const targetHash = validateConverted(target, request.kind, manifest.targetHash);
      const archivedFiles = manifest.archivedFiles ?? [];
      for (const file of archivedFiles) {
        const value = fingerprint(join(archiveDirectory, file.name));
        if (value.hash !== file.hash || value.size !== file.size) throw new DatabaseMaintenanceError("migration_archive_changed");
      }
      removeRecoveryMarker();
      return { operationId: request.operationId, kind: request.kind, state: "completed", sourceName, targetName, targetHash, backupDirectory: operationDirectory, archivedFiles, applicationId: DATABASE_APPLICATION_IDS[request.kind], userVersion: 1 };
    }

    while (["prepared", "copying"].includes(manifest.phase)) {
      reauthorize("copy");
      if (manifest.phase === "prepared") {
        save({ ...manifest, phase: "copying", candidateName: `${request.kind}.converted-${uuidv7()}.db`, lastFailure: undefined });
      }
      if (!manifest.candidateName || !new RegExp(`^${request.kind}\\.converted-[0-9a-f-]{36}\\.db$`).test(manifest.candidateName)) throw new DatabaseMaintenanceError("migration_log_invalid");
      const candidate = join(operationDirectory, manifest.candidateName);
      if (pathExists(candidate)) {
        // copying阶段尚未持久登记内容hash；无论SQLite格式是否看似合法，都不能证明它来自本次源库。
        save({ ...manifest, phase: "prepared", abandonedCandidates: [...(manifest.abandonedCandidates ?? []), manifest.candidateName], candidateName: undefined, lastFailure: "unregistered_candidate_preserved" });
        continue;
      }
      const sourceDb = new DatabaseSync(source, { readOnly: true, allowExtension: false });
      try {
        sourceDb.exec("PRAGMA trusted_schema = OFF; PRAGMA busy_timeout = 5000;");
        if (Number(sourceDb.prepare("PRAGMA user_version").get()?.user_version) !== 1 || Number(sourceDb.prepare("PRAGMA application_id").get()?.application_id) !== 0) throw new DatabaseMaintenanceError("unrecognized_source_layout");
        const fd = openSync(candidate, "wx", 0o600); closeSync(fd);
        sourceDb.prepare("VACUUM main INTO ?").run(candidate);
      } finally { sourceDb.close(); }
      if (JSON.stringify(sourceFingerprint(source)) !== JSON.stringify(manifest.sourceFingerprint)) throw new DatabaseMaintenanceError("source_changed");
      const converted = new DatabaseSync(candidate, { allowExtension: false });
      try { converted.exec(`PRAGMA application_id = ${DATABASE_APPLICATION_IDS[request.kind]}; PRAGMA user_version = 1;`); }
      finally { converted.close(); }
      const fd = openSync(candidate, "r"); try { fsyncSync(fd); } finally { closeSync(fd); }
      const candidateHash = validateConverted(candidate, request.kind);
      const sourceFiles = exactFileSet(source, sourceName);
      save({ ...manifest, phase: "copied", candidateHash, sourceFiles, lastFailure: undefined });
    }

    if (!manifest.candidateName) throw new DatabaseMaintenanceError("migration_log_invalid");
    const candidate = join(operationDirectory, manifest.candidateName);
    if (["copied", "archiving"].includes(manifest.phase)) {
      reauthorize("archive");
      validateConverted(candidate, request.kind, manifest.candidateHash);
      if (!pathExists(archiveDirectory)) mkdirSync(archiveDirectory, { mode: 0o700 });
      if (privateDirectory(archiveDirectory) !== archiveDirectory) throw new DatabaseMaintenanceError("migration_archive_invalid");
      let archivedFiles = manifest.archivedFiles ?? [];
      for (const file of manifest.sourceFiles ?? []) {
        const original = join(state.directory, file.name), archived = join(archiveDirectory, file.name);
        save({ ...manifest, phase: "archiving", archivedFiles, lastFailure: undefined });
        const originalExists = pathExists(original), archivedExists = pathExists(archived);
        if (originalExists && archivedExists) {
          const originalMetadata = lstatSync(original), archiveMetadata = lstatSync(archived);
          if (!originalMetadata.isFile() || originalMetadata.isSymbolicLink() || !archiveMetadata.isFile() || archiveMetadata.isSymbolicLink() || originalMetadata.ino !== archiveMetadata.ino || originalMetadata.dev !== archiveMetadata.dev) throw new DatabaseMaintenanceError("migration_archive_conflict");
          const linkedOriginal = fingerprint(original, 2), linkedArchive = fingerprint(archived, 2);
          if (linkedOriginal.inode !== linkedArchive.inode || linkedOriginal.device !== linkedArchive.device || linkedArchive.hash !== file.hash || linkedArchive.size !== file.size || linkedOriginal.inode !== file.inode || linkedOriginal.device !== file.device) throw new DatabaseMaintenanceError("migration_archive_conflict");
          unlinkSync(original); syncDirectory(state.directory);
        } else if (originalExists) {
          const current = fingerprint(original);
          if (current.hash !== file.hash || current.size !== file.size || current.inode !== file.inode || current.device !== file.device) throw new DatabaseMaintenanceError("source_changed");
          // 同文件系统硬链接是“不覆盖”发布：竞争者先创建目标时linkSync以EEXIST失败，不会被rename覆盖。
          linkSync(original, archived);
          const linkedOriginal = fingerprint(original, 2), linkedArchive = fingerprint(archived, 2);
          if (linkedOriginal.inode !== linkedArchive.inode || linkedOriginal.device !== linkedArchive.device || linkedArchive.hash !== file.hash || linkedArchive.size !== file.size) throw new DatabaseMaintenanceError("migration_archive_changed");
          syncDirectory(archiveDirectory);
          unlinkSync(original); syncDirectory(state.directory);
        } else if (!archivedExists) throw new DatabaseMaintenanceError("migration_source_lost");
        const moved = fingerprint(archived);
        if (moved.hash !== file.hash || moved.size !== file.size) throw new DatabaseMaintenanceError("migration_archive_changed");
        if (!archivedFiles.some((entry) => entry.name === file.name)) archivedFiles = [...archivedFiles, { name: file.name, hash: file.hash, size: file.size }];
        save({ ...manifest, phase: "archiving", archivedFiles, lastFailure: undefined });
      }
      save({ ...manifest, phase: "staging", archivedFiles, lastFailure: undefined });
    }

    while (["staging", "stage_copying"].includes(manifest.phase)) {
      reauthorize("switch");
      const candidateHash = validateConverted(candidate, request.kind, manifest.candidateHash);
      if (manifest.phase === "staging") save({ ...manifest, phase: "stage_copying", stageName: `${request.kind}.stage-${uuidv7()}.db`, lastFailure: undefined });
      if (!manifest.stageName || !new RegExp(`^${request.kind}\\.stage-[0-9a-f-]{36}\\.db$`).test(manifest.stageName)) throw new DatabaseMaintenanceError("migration_log_invalid");
      const staged = join(operationDirectory, manifest.stageName);
      if (pathExists(staged)) {
        try {
          if (fingerprint(staged).hash !== candidateHash) throw new DatabaseMaintenanceError("migration_stage_invalid");
          save({ ...manifest, phase: "switching", targetHash: candidateHash, lastFailure: undefined });
          break;
        } catch {
          save({ ...manifest, phase: "staging", abandonedStages: [...(manifest.abandonedStages ?? []), manifest.stageName], stageName: undefined, lastFailure: "incomplete_stage_preserved" });
          continue;
        }
      }
      copyFileSync(candidate, staged, constants.COPYFILE_EXCL);
      const fd = openSync(staged, "r"); try { fsyncSync(fd); } finally { closeSync(fd); }
      if (fingerprint(staged).hash !== candidateHash) throw new DatabaseMaintenanceError("migration_stage_invalid");
      save({ ...manifest, phase: "switching", targetHash: candidateHash, lastFailure: undefined });
    }

    if (!manifest.stageName) throw new DatabaseMaintenanceError("migration_log_invalid");
    const staged = join(operationDirectory, manifest.stageName);
    if (manifest.phase === "switching") {
      reauthorize("switch");
      const targetExists = pathExists(target);
      const stageIdentity = fingerprint(staged, targetExists ? 2 : 1);
      if (stageIdentity.hash !== manifest.targetHash) throw new DatabaseMaintenanceError("migration_stage_invalid");
      if (targetExists) {
        const targetIdentity = fingerprint(target, 2);
        if (targetIdentity.hash !== manifest.targetHash || targetIdentity.inode !== stageIdentity.inode || targetIdentity.device !== stageIdentity.device) throw new DatabaseMaintenanceError("migration_target_conflict");
      } else {
        linkSync(staged, target); syncDirectory(state.directory);
      }
      save({ ...manifest, phase: "switched", lastFailure: undefined });
    }

    if (manifest.phase === "switched") {
      reauthorize("complete");
      if (pathExists(staged)) {
        const stageIdentity = fingerprint(staged, 2), targetIdentity = fingerprint(target, 2);
        if (stageIdentity.hash !== manifest.targetHash || targetIdentity.hash !== manifest.targetHash || stageIdentity.inode !== targetIdentity.inode || stageIdentity.device !== targetIdentity.device) throw new DatabaseMaintenanceError("migration_target_conflict");
        unlinkSync(staged); syncDirectory(state.directory);
      }
      validateConverted(target, request.kind, manifest.targetHash);
      save({ ...manifest, phase: "completed", lastFailure: undefined });
    }

    const targetHash = validateConverted(target, request.kind, manifest.targetHash);
    removeRecoveryMarker();
    return { operationId: request.operationId, kind: request.kind, state: "completed", sourceName, targetName, targetHash, backupDirectory: operationDirectory, archivedFiles: manifest.archivedFiles ?? [], applicationId: DATABASE_APPLICATION_IDS[request.kind], userVersion: 1 };
  } catch (error) {
    if (manifest && pathExists(manifestPath)) {
      try { save({ ...manifest, lastFailure: error instanceof DatabaseMaintenanceError ? error.code : "migration_failed" }); } catch { /* 保留最后一个可核对阶段。 */ }
    }
    if (error instanceof DatabaseMaintenanceError) throw error;
    throw new DatabaseMaintenanceError("migration_failed");
  }
}
