import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { closeSync, constants, fsyncSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { UUID_V7_PATTERN, uuidv7 } from "./database.ts";
import { assertRegularDatabaseFiles, DATABASE_APPLICATION_IDS, DATABASE_MAINTENANCE_FILE, DATABASE_SCHEMA_VERSIONS, DATABASE_SNAPSHOT_FILE, pathExists } from "./database-paths.ts";
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
function fingerprint(path: string): FileFingerprint {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || (before.mode & 0o077) !== 0 || (process.getuid && before.uid !== process.getuid())) throw new DatabaseMaintenanceError("invalid_source_file");
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
export function createDatabaseSnapshot(permit: DatabaseMaintenancePermit, kind: DatabaseKind): DatabaseSnapshotReceipt {
  if (!["data", "global", "index"].includes(kind)) throw new DatabaseMaintenanceError("invalid_snapshot_kind");
  const state = assertPermit(permit);
  if (state.takeover) throw new DatabaseMaintenanceError("maintenance_operation_mismatch");
  const sourceName = `${kind}.db`;
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
  const metadata = { operationId, kind, sourceName, sourceFingerprint: before, restoreStatus: "needs_review", executable: false };
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
    if (userVersion !== DATABASE_SCHEMA_VERSIONS[kind] || applicationId !== DATABASE_APPLICATION_IDS[kind]) throw new DatabaseMaintenanceError("unrecognized_source_layout");
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
    const receipt: DatabaseSnapshotReceipt = { operationId, kind, sourceName, state: "prepared", restoreStatus: "needs_review", executable: false, snapshotPath, snapshotHash, userVersion, applicationId };
    record({ ...metadata, ...receipt });
    return receipt;
  } catch (error) {
    try { record({ ...metadata, state: "failed", reason: error instanceof DatabaseMaintenanceError ? error.code : "snapshot_failed" }); } catch { /* 保留copying或已被外部改变的现场供核对。 */ }
    throw new DatabaseMaintenanceError(error instanceof DatabaseMaintenanceError ? error.code : "snapshot_failed");
  } finally { sourceDb?.close(); }
}

function replaceJson(path: string, directory: string, expected: PrivateFileState, value: object): PrivateFileState {
  assertPrivateChildDirectory(directory, dirname(directory), "invalid_backup_directory");
  samePrivateFile(path, expected, "snapshot_metadata_changed");
  const temporary = join(directory, `.snapshot-metadata-${uuidv7()}.tmp`);
  writeNew(temporary, JSON.stringify(value));
  samePrivateFile(path, expected, "snapshot_metadata_changed");
  renameSync(temporary, path);
  syncDirectory(directory);
  return readPrivateText(path, "snapshot_metadata_changed");
}
