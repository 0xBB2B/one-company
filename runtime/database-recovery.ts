import { createHash } from "node:crypto";
import { chmodSync, closeSync, constants, fsyncSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { LocalDatabase, UUID_V7_PATTERN, uuidv7 } from "./database.ts";
import { databaseMaintenanceDirectory } from "./database-maintenance.ts";
import type { DatabaseMaintenancePermit, DatabaseManagementAuthorization } from "./database-maintenance.ts";
import { assertRegularDatabaseFiles, DATABASE_APPLICATION_IDS, DATABASE_RECOVERY_FILE, DATABASE_SCHEMA_VERSIONS, DATABASE_SNAPSHOT_FILE, pathExists } from "./database-paths.ts";

export class DatabaseRecoveryError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(`数据库恢复未开放执行权限：${code}；恢复产物保持待审核`);
    this.name = "DatabaseRecoveryError";
    this.code = code;
  }
}

export type DatabaseRecoveryMode = "current_restart" | "index_rebuild" | "legacy_data";
export type DatabaseRecoveryStage = "inspect" | "prepare" | "copy" | "reconcile" | "complete";

export interface DatabaseRecoveryRequest {
  operationId: string;
  mode: DatabaseRecoveryMode;
  /** legacy_data只接受维护目录backups内登记的一份data.db快照。 */
  snapshotPath?: string;
  /** 只枚举该目录下符合完整UUIDv7命名的归档路径，不读取文件正文或计算正文hash。 */
  archiveDirectory?: string;
  /** 若上层已登记固定归档路径，则只接受这些完整绝对路径；不做短ID或标题匹配。 */
  registeredArchivePaths?: readonly string[];
  authorize(context: Readonly<{ operationId: string; mode: DatabaseRecoveryMode; stage: DatabaseRecoveryStage }>): DatabaseManagementAuthorization;
}

export interface ArchiveMetadata {
  requirementId: string;
  path: string;
  description: string;
}

export interface RecoveryRequirementStatus {
  requirementId: string;
  sourceLifecycle: string | null;
  retainedLifecycle: string | null;
  closeReason: string | null;
  archivePath: string | null;
  recoveryReason: "archive_found" | "history_unknown" | "identity_conflict" | null;
  executable: false;
}

export type DatabaseRecoveryReceipt =
  | { operationId: string; mode: "current_restart"; state: "restart_ready"; executable: true; databasePath: string; databaseHash: string; requirementsChecked: number }
  | { operationId: string; mode: "index_rebuild"; state: "rebuilt"; executable: false; restoreStatus: "needs_review"; rebuiltPath: string; dataHashBefore: string | null; dataHashAfter: string | null }
  | { operationId: string; mode: "legacy_data"; state: "reconciled"; executable: false; restoreStatus: "needs_review"; recoveredPath: string | null; requirements: RecoveryRequirementStatus[]; archives: ArchiveMetadata[] };

interface RecoveryManifest {
  format: "database-recovery/v1";
  operationId: string;
  mode: "index_rebuild" | "legacy_data";
  authorizationId: string;
  principal: string;
  state: "prepared" | "copied" | "reconciled" | "completed";
  snapshotPath?: string;
  snapshotHash?: string;
  archiveDirectory?: string;
  registeredArchivePaths?: string[];
  archivePaths?: string[];
  currentHash?: string | null;
  receipt?: DatabaseRecoveryReceipt;
  lastFailure?: string;
}

interface Fingerprint { hash: string; size: number; inode: number; device: number }
function fingerprint(path: string): Fingerprint {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || (before.mode & 0o077) !== 0 || (process.getuid && before.uid !== process.getuid())) throw new DatabaseRecoveryError("invalid_database_file");
    const hash = createHash("sha256"), buffer = Buffer.alloc(64 * 1024);
    for (;;) { const count = readSync(fd, buffer, 0, buffer.length, null); if (!count) break; hash.update(buffer.subarray(0, count)); }
    const after = fstatSync(fd);
    if (before.ino !== after.ino || before.dev !== after.dev || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new DatabaseRecoveryError("database_changed");
    return { hash: hash.digest("hex"), size: after.size, inode: after.ino, device: after.dev };
  } finally { closeSync(fd); }
}

export function databaseFilesFingerprint(path: string): string {
  const main = fingerprint(path);
  const wal = pathExists(path + "-wal") ? fingerprint(path + "-wal") : null;
  return createHash("sha256").update(JSON.stringify({ main: { hash: main.hash, size: main.size }, wal: wal?.size ? { hash: wal.hash, size: wal.size } : null })).digest("hex");
}

function privateDirectory(path: string): string {
  if (!isAbsolute(path)) throw new DatabaseRecoveryError("absolute_directory_required");
  const expected = resolve(path), actual = realpathSync(path), stat = lstatSync(expected);
  if (actual !== expected || !stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) throw new DatabaseRecoveryError("private_directory_required");
  return actual;
}

function assertPrivateChildDirectory(path: string, parent: string): void {
  if (dirname(path) !== parent || privateDirectory(path) !== path) throw new DatabaseRecoveryError("private_directory_required");
}

function metadataDirectory(path: string): string {
  if (!isAbsolute(path)) throw new DatabaseRecoveryError("absolute_directory_required");
  const expected = resolve(path), actual = realpathSync(path), stat = lstatSync(expected);
  if (actual !== expected || !stat.isDirectory() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid())) throw new DatabaseRecoveryError("archive_directory_invalid");
  return actual;
}

function contained(parent: string, child: string): boolean {
  const value = relative(parent, child);
  return value === "" || (value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value));
}

function privateDescendantFile(root: string, path: string): string {
  const expected = resolve(path), actual = realpathSync(path);
  if (actual !== expected || !contained(root, actual)) throw new DatabaseRecoveryError("snapshot_path_invalid");
  const directories: string[] = [];
  for (let current = dirname(actual); current !== root; current = dirname(current)) {
    if (!contained(root, current) || current === dirname(current)) throw new DatabaseRecoveryError("snapshot_path_invalid");
    directories.push(current);
  }
  let parent = root;
  for (const directory of directories.reverse()) { assertPrivateChildDirectory(directory, parent); parent = directory; }
  fingerprint(actual);
  return actual;
}

interface PrivateFileState { contents: string; inode: number; device: number; size: number; mtimeMs: number; ctimeMs: number }
function syncDirectory(path: string): void { const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); try { fsyncSync(fd); } finally { closeSync(fd); } }
function writeNew(path: string, text: string): void {
  const fd = openSync(path, "wx", 0o600);
  try { writeFileSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
}
function readPrivateText(path: string, code: string): PrivateFileState {
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch { throw new DatabaseRecoveryError(code); }
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || (before.mode & 0o077) !== 0 || (process.getuid && before.uid !== process.getuid())) throw new DatabaseRecoveryError(code);
    const contents = readFileSync(fd, "utf8"), after = fstatSync(fd), named = lstatSync(path);
    if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1 || named.ino !== after.ino || named.dev !== after.dev || before.ino !== after.ino || before.dev !== after.dev || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || Buffer.byteLength(contents) !== after.size) throw new DatabaseRecoveryError(code);
    return { contents, inode: after.ino, device: after.dev, size: after.size, mtimeMs: after.mtimeMs, ctimeMs: after.ctimeMs };
  } finally { closeSync(fd); }
}
function samePrivateFile(path: string, expected: PrivateFileState, code: string): void {
  const current = readPrivateText(path, code);
  if (current.inode !== expected.inode || current.device !== expected.device || current.size !== expected.size || current.mtimeMs !== expected.mtimeMs || current.ctimeMs !== expected.ctimeMs || current.contents !== expected.contents) throw new DatabaseRecoveryError(code);
}
function replaceJson(path: string, directory: string, expected: PrivateFileState, value: object): PrivateFileState {
  privateDirectory(directory);
  samePrivateFile(path, expected, "recovery_log_changed");
  const temporary = join(directory, `.recovery-log-${uuidv7()}.tmp`);
  writeNew(temporary, JSON.stringify(value));
  samePrivateFile(path, expected, "recovery_log_changed");
  renameSync(temporary, path); syncDirectory(directory);
  return readPrivateText(path, "recovery_log_changed");
}

function authorize(request: DatabaseRecoveryRequest, stage: DatabaseRecoveryStage, expected?: Pick<RecoveryManifest, "authorizationId" | "principal">): DatabaseManagementAuthorization {
  let result: DatabaseManagementAuthorization;
  try { result = request.authorize(Object.freeze({ operationId: request.operationId, mode: request.mode, stage })); }
  catch { throw new DatabaseRecoveryError("authorization_failed"); }
  if (!result || result.authorized !== true || result.writesStopped !== true || !result.authorizationId || !result.principal) throw new DatabaseRecoveryError("authorization_failed");
  if (expected && (result.authorizationId !== expected.authorizationId || result.principal !== expected.principal)) throw new DatabaseRecoveryError("authorization_changed");
  return result;
}

function validateDatabase(path: string, applicationId: number, acceptedLegacy = false): { hash: string; requirements: Array<{ id: string; key: string; version: number; data: Record<string, unknown> }> } {
  assertRegularDatabaseFiles(path);
  const before = databaseFilesFingerprint(path);
  const db = new DatabaseSync(path, { readOnly: true, allowExtension: false });
  try {
    const version = Number(db.prepare("PRAGMA user_version").get()?.user_version);
    const identity = Number(db.prepare("PRAGMA application_id").get()?.application_id);
    if (db.prepare("PRAGMA quick_check").get()?.quick_check !== "ok" || (version !== 1 && version !== DATABASE_SCHEMA_VERSIONS.data) || (identity !== applicationId && !(acceptedLegacy && identity === 0))) throw new DatabaseRecoveryError("unrecognized_database");
    const table = Number(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='records'").get()?.n);
    if (table !== 1) throw new DatabaseRecoveryError("unrecognized_database");
    const requirements = db.prepare("SELECT id, record_key, version, data FROM records WHERE namespace='requirements'").all().map((row) => {
      let data: unknown;
      try { data = JSON.parse(String(row.data)); } catch { throw new DatabaseRecoveryError("invalid_requirement_state"); }
      if (!data || typeof data !== "object" || Array.isArray(data)) throw new DatabaseRecoveryError("invalid_requirement_state");
      return { id: String(row.id), key: String(row.record_key), version: Number(row.version), data: data as Record<string, unknown> };
    });
    const after = databaseFilesFingerprint(path);
    if (before !== after) throw new DatabaseRecoveryError("database_changed");
    return { hash: after, requirements };
  } finally { db.close(); }
}

function archiveName(entry: string): { requirementId: string; description: string } | null {
  const match = /^([0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.(.+)\.md$/u.exec(entry);
  if (!match || !UUID_V7_PATTERN.test(match[1]!) || !match[2] || match[2] === "." || match[2] === ".." || /[\u0000-\u001f\u007f/\\]/u.test(match[2]!)) return null;
  return { requirementId: match[1]!, description: match[2]! };
}

/** 仅解析完整UUIDv7归档文件名及登记路径；不打开归档文件。 */
export function enumerateArchiveMetadata(directory: string, registeredPaths?: readonly string[]): ArchiveMetadata[] {
  const root = metadataDirectory(directory), before = lstatSync(root);
  const registered = registeredPaths ? new Set(registeredPaths.map((path) => {
    if (!isAbsolute(path) || resolve(path) !== path || dirname(path) !== root) throw new DatabaseRecoveryError("registered_archive_path_invalid");
    return path;
  })) : null;
  const archives: ArchiveMetadata[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isFile() || entry.isSymbolicLink()) continue;
    const parsed = archiveName(entry.name); if (!parsed) continue;
    const path = join(root, entry.name);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (process.getuid && stat.uid !== process.getuid())) throw new DatabaseRecoveryError("archive_path_changed");
    archives.push({ ...parsed, path });
  }
  const after = lstatSync(root);
  if (before.ino !== after.ino || before.dev !== after.dev || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || metadataDirectory(root) !== root) throw new DatabaseRecoveryError("archive_directory_changed");
  if (registered) for (const path of registered) if (!archives.some((archive) => archive.path === path)) throw new DatabaseRecoveryError("registered_archive_missing");
  archives.sort((a, b) => a.path.localeCompare(b.path));
  const seen = new Set<string>();
  for (const archive of archives) {
    if (seen.has(archive.requirementId)) throw new DatabaseRecoveryError("archive_identity_conflict");
    seen.add(archive.requirementId);
  }
  return registered ? archives.filter((archive) => registered.has(archive.path)) : archives;
}

function terminal(data: Record<string, unknown>): { lifecycle: "closing" | "closed"; reason: string | null } | null {
  if (data.lifecycle !== "closing" && data.lifecycle !== "closed") return null;
  const close = data.close;
  const reason = close && typeof close === "object" && !Array.isArray(close) && typeof (close as Record<string, unknown>).reason === "string" ? String((close as Record<string, unknown>).reason) : null;
  return { lifecycle: data.lifecycle, reason };
}

function createEmptyIndex(path: string): void {
  // 在独立恢复目录复用正式初始化器，确保UUID、版本、唯一性及索引命名空间约束完全一致。
  const db = new LocalDatabase(path);
  db.close();
  chmodSync(path, 0o600);
  const syncFd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); try { fsyncSync(syncFd); } finally { closeSync(syncFd); }
}

function recoverLegacyCopy(source: string, destination: string): void {
  const sourceDb = new DatabaseSync(source, { readOnly: true, allowExtension: false });
  try {
    sourceDb.exec("PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=5000;");
    const fd = openSync(destination, "wx", 0o600); closeSync(fd);
    sourceDb.prepare("VACUUM main INTO ?").run(destination);
  } finally { sourceDb.close(); }
  const output = new DatabaseSync(destination, { allowExtension: false });
  try { output.exec(`PRAGMA application_id=${DATABASE_APPLICATION_IDS.data}; PRAGMA user_version=1;`); }
  finally { output.close(); }
}

function parseManifest(file: PrivateFileState): RecoveryManifest {
  let value: unknown;
  try { value = JSON.parse(file.contents); } catch { throw new DatabaseRecoveryError("recovery_log_invalid"); }
  const manifest = value as Partial<RecoveryManifest>;
  if (manifest.format !== "database-recovery/v1" || !UUID_V7_PATTERN.test(String(manifest.operationId)) || !["index_rebuild", "legacy_data"].includes(String(manifest.mode)) || !["prepared", "copied", "reconciled", "completed"].includes(String(manifest.state))) throw new DatabaseRecoveryError("recovery_log_invalid");
  return manifest as RecoveryManifest;
}

/**
 * 分级核对当前运行库、可重建索引和历史不明的旧data快照。
 * 旧data产物始终位于带snapshot标记的私有恢复目录，并把活动状态改为needs_review；本接口不激活它。
 */
export function reconcileDatabaseRecovery(permit: DatabaseMaintenancePermit, request: DatabaseRecoveryRequest): DatabaseRecoveryReceipt {
  if (!UUID_V7_PATTERN.test(request.operationId) || !["current_restart", "index_rebuild", "legacy_data"].includes(request.mode) || typeof request.authorize !== "function") throw new DatabaseRecoveryError("invalid_request");
  const directory = databaseMaintenanceDirectory(permit, request.operationId);
  const first = authorize(request, "inspect");
  const currentData = join(directory, "data.db");

  if (request.mode === "current_restart") {
    if (request.snapshotPath || request.archiveDirectory || request.registeredArchivePaths) throw new DatabaseRecoveryError("invalid_request");
    if (pathExists(join(directory, DATABASE_SNAPSHOT_FILE)) || pathExists(join(directory, DATABASE_RECOVERY_FILE))) throw new DatabaseRecoveryError("snapshot_not_current");
    const result = validateDatabase(currentData, DATABASE_APPLICATION_IDS.data);
    const completed = authorize(request, "complete");
    if (completed.authorizationId !== first.authorizationId || completed.principal !== first.principal) throw new DatabaseRecoveryError("authorization_changed");
    return { operationId: request.operationId, mode: "current_restart", state: "restart_ready", executable: true, databasePath: currentData, databaseHash: result.hash, requirementsChecked: result.requirements.length };
  }

  const backupsDirectory = join(directory, "backups");
  const recoveryRoot = join(backupsDirectory, "recovery");
  const operationDirectory = join(recoveryRoot, request.operationId);
  const manifestPath = join(operationDirectory, ".database-recovery.json");
  const assertOperationDirectories = () => {
    assertPrivateChildDirectory(backupsDirectory, directory);
    assertPrivateChildDirectory(recoveryRoot, backupsDirectory);
    assertPrivateChildDirectory(operationDirectory, recoveryRoot);
  };
  let manifest: RecoveryManifest;
  let manifestFile: PrivateFileState;
  if (pathExists(operationDirectory)) {
    if (!pathExists(backupsDirectory) || !pathExists(recoveryRoot)) throw new DatabaseRecoveryError("operation_conflict");
    assertOperationDirectories();
    if (!pathExists(manifestPath)) throw new DatabaseRecoveryError("operation_conflict");
    manifestFile = readPrivateText(manifestPath, "recovery_log_invalid");
    manifest = parseManifest(manifestFile);
    if (manifest.operationId !== request.operationId || manifest.mode !== request.mode || manifest.authorizationId !== first.authorizationId || manifest.principal !== first.principal) throw new DatabaseRecoveryError("operation_conflict");
  } else {
    if (!pathExists(backupsDirectory)) mkdirSync(backupsDirectory, { mode: 0o700 });
    assertPrivateChildDirectory(backupsDirectory, directory);
    if (!pathExists(recoveryRoot)) mkdirSync(recoveryRoot, { mode: 0o700 });
    assertPrivateChildDirectory(recoveryRoot, backupsDirectory);
    mkdirSync(operationDirectory, { mode: 0o700 });
    assertOperationDirectories();
    manifest = { format: "database-recovery/v1", operationId: request.operationId, mode: request.mode, authorizationId: first.authorizationId, principal: first.principal, state: "prepared", snapshotPath: request.snapshotPath, archiveDirectory: request.archiveDirectory, registeredArchivePaths: request.registeredArchivePaths ? [...request.registeredArchivePaths] : undefined };
    writeNew(manifestPath, JSON.stringify(manifest)); syncDirectory(operationDirectory); syncDirectory(recoveryRoot);
    manifestFile = readPrivateText(manifestPath, "recovery_log_invalid");
  }
  if (manifest.snapshotPath !== request.snapshotPath || manifest.archiveDirectory !== request.archiveDirectory || JSON.stringify(manifest.registeredArchivePaths) !== JSON.stringify(request.registeredArchivePaths ? [...request.registeredArchivePaths] : undefined)) throw new DatabaseRecoveryError("operation_input_changed");
  const save = (next: RecoveryManifest) => {
    assertOperationDirectories();
    manifestFile = replaceJson(manifestPath, operationDirectory, manifestFile, next);
    manifest = next;
  };
  const reauthorize = (stage: DatabaseRecoveryStage) => { databaseMaintenanceDirectory(permit, request.operationId); assertOperationDirectories(); authorize(request, stage, manifest); };

  try {
    if (manifest.state === "completed") {
      reauthorize("complete");
      if (!manifest.receipt || manifest.receipt.operationId !== request.operationId || manifest.receipt.mode !== request.mode) throw new DatabaseRecoveryError("recovery_log_invalid");
      if (manifest.receipt.mode === "index_rebuild") {
        if (manifest.receipt.rebuiltPath !== join(operationDirectory, "index.db")) throw new DatabaseRecoveryError("recovery_log_invalid");
        validateDatabase(manifest.receipt.rebuiltPath, DATABASE_APPLICATION_IDS.index);
      } else {
        if (manifest.receipt.recoveredPath !== join(operationDirectory, "data.db")) throw new DatabaseRecoveryError("recovery_log_invalid");
        if (manifest.receipt.recoveredPath) validateDatabase(manifest.receipt.recoveredPath, DATABASE_APPLICATION_IDS.data);
      }
      readPrivateText(join(operationDirectory, DATABASE_SNAPSHOT_FILE), "snapshot_marker_invalid");
      return manifest.receipt;
    }

    const dataHashBefore = pathExists(currentData) ? databaseFilesFingerprint(currentData) : null;
    if (request.mode === "index_rebuild") {
      if (request.snapshotPath || request.archiveDirectory || request.registeredArchivePaths) throw new DatabaseRecoveryError("invalid_request");
      const rebuiltPath = join(operationDirectory, "index.db");
      if (manifest.state === "prepared") {
        reauthorize("prepare");
        if (pathExists(rebuiltPath)) throw new DatabaseRecoveryError("rebuild_output_conflict");
        createEmptyIndex(rebuiltPath);
        validateDatabase(rebuiltPath, DATABASE_APPLICATION_IDS.index);
        save({ ...manifest, state: "reconciled", lastFailure: undefined });
      }
      validateDatabase(rebuiltPath, DATABASE_APPLICATION_IDS.index);
      const dataHashAfter = pathExists(currentData) ? databaseFilesFingerprint(currentData) : null;
      if (dataHashBefore !== dataHashAfter) throw new DatabaseRecoveryError("data_database_changed");
      const reviewMarkerPath = join(operationDirectory, DATABASE_SNAPSHOT_FILE);
      const reviewMarker = JSON.stringify({ operationId: request.operationId, kind: "index", restoreStatus: "needs_review", executable: false });
      if (!pathExists(reviewMarkerPath)) writeNew(reviewMarkerPath, reviewMarker);
      if (readPrivateText(reviewMarkerPath, "snapshot_marker_invalid").contents !== reviewMarker) throw new DatabaseRecoveryError("snapshot_marker_invalid");
      syncDirectory(operationDirectory);
      const receipt: DatabaseRecoveryReceipt = { operationId: request.operationId, mode: "index_rebuild", state: "rebuilt", executable: false, restoreStatus: "needs_review", rebuiltPath, dataHashBefore, dataHashAfter };
      reauthorize("complete"); save({ ...manifest, state: "completed", receipt, lastFailure: undefined });
      return receipt;
    }

    const snapshotPath = request.snapshotPath;
    if (!snapshotPath || !isAbsolute(snapshotPath) || basename(snapshotPath) !== "data.db") throw new DatabaseRecoveryError("snapshot_path_invalid");
    const snapshotActual = privateDescendantFile(backupsDirectory, snapshotPath);
    if (contained(operationDirectory, snapshotActual)) throw new DatabaseRecoveryError("snapshot_path_invalid");
    readPrivateText(join(dirname(snapshotActual), DATABASE_SNAPSHOT_FILE), "snapshot_marker_invalid");
    const snapshot = validateDatabase(snapshotActual, DATABASE_APPLICATION_IDS.data, true);
    const archiveDirectory = request.archiveDirectory;
    const archives = archiveDirectory ? enumerateArchiveMetadata(archiveDirectory, request.registeredArchivePaths) : [];
    if (!archiveDirectory && request.registeredArchivePaths) throw new DatabaseRecoveryError("registered_archive_path_invalid");
    const current = pathExists(currentData) ? validateDatabase(currentData, DATABASE_APPLICATION_IDS.data) : null;
    const archivePaths = archives.map((archive) => archive.path);
    if (manifest.snapshotHash !== undefined && manifest.snapshotHash !== snapshot.hash) throw new DatabaseRecoveryError("snapshot_changed");
    if (manifest.archivePaths !== undefined && JSON.stringify(manifest.archivePaths) !== JSON.stringify(archivePaths)) throw new DatabaseRecoveryError("archives_changed");
    if (manifest.currentHash !== undefined && manifest.currentHash !== (current?.hash ?? null)) throw new DatabaseRecoveryError("current_database_changed");
    if (manifest.snapshotHash === undefined) save({ ...manifest, snapshotHash: snapshot.hash, archivePaths, currentHash: current?.hash ?? null, lastFailure: undefined });
    const archiveById = new Map(archives.map((archive) => [archive.requirementId, archive]));
    const currentTerminal = new Map((current?.requirements ?? []).flatMap((row) => terminal(row.data) ? [[row.key, row] as const] : []));
    const sourceById = new Map(snapshot.requirements.map((row) => [row.key, row]));
    const reconciliationRows = new Map([...sourceById, ...currentTerminal]);
    const recoveredPath = join(operationDirectory, "data.db");

    if (manifest.state === "prepared") {
      reauthorize("copy");
      if (pathExists(recoveredPath)) throw new DatabaseRecoveryError("recovery_output_conflict");
      recoverLegacyCopy(snapshotActual, recoveredPath);
      save({ ...manifest, state: "copied", lastFailure: undefined });
    }

    let statuses: RecoveryRequirementStatus[] = [];
    if (manifest.state === "copied") {
      reauthorize("reconcile");
      validateDatabase(recoveredPath, DATABASE_APPLICATION_IDS.data);
      const output = new DatabaseSync(recoveredPath, { allowExtension: false });
      try {
        output.exec("BEGIN IMMEDIATE");
        try {
          output.exec("CREATE TABLE IF NOT EXISTS recovery_reconciliation(requirement_id TEXT PRIMARY KEY, source_lifecycle TEXT, retained_lifecycle TEXT, close_reason TEXT, archive_path TEXT, recovery_reason TEXT, executable INTEGER NOT NULL CHECK(executable=0)) STRICT");
          for (const row of reconciliationRows.values()) {
            const source = sourceById.get(row.key);
            const sourceLifecycle = typeof source?.data.lifecycle === "string" ? source.data.lifecycle : null;
            const trustedCurrent = currentTerminal.get(row.key);
            const sourceTerminal = terminal(row.data);
            let retained = row.data, retainedLifecycle = sourceLifecycle, closeReason = sourceTerminal?.reason ?? null;
            let recoveryReason: RecoveryRequirementStatus["recoveryReason"] = null;
            if (trustedCurrent) {
              retained = trustedCurrent.data;
              const kept = terminal(retained)!;
              retainedLifecycle = kept.lifecycle; closeReason = kept.reason;
              output.prepare("INSERT INTO records(id,namespace,record_key,version,data) VALUES(?,'requirements',?,?,?) ON CONFLICT(namespace,record_key) DO UPDATE SET id=excluded.id,version=excluded.version,data=excluded.data")
                .run(trustedCurrent.id, row.key, trustedCurrent.version, JSON.stringify(retained));
            } else {
              recoveryReason = archiveById.has(row.key) ? "archive_found" : "history_unknown";
              const epoch = typeof retained.epoch === "number" && Number.isSafeInteger(retained.epoch) ? retained.epoch + 1 : 1;
              retained = { ...retained, recovery: "needs_review", recoveryReason, epoch };
              output.prepare("UPDATE records SET data=?, version=version+1 WHERE namespace='requirements' AND record_key=?").run(JSON.stringify(retained), row.key);
            }
            output.prepare("DELETE FROM records WHERE namespace='pm_ownership' AND record_key=?").run(row.key);
            const archivePath = archiveById.get(row.key)?.path ?? null;
            output.prepare("INSERT INTO recovery_reconciliation VALUES(?,?,?,?,?,?,0)").run(row.key, sourceLifecycle, retainedLifecycle, closeReason, archivePath, recoveryReason);
            statuses.push({ requirementId: row.key, sourceLifecycle, retainedLifecycle, closeReason, archivePath, recoveryReason, executable: false });
          }
          for (const archive of archives) if (!reconciliationRows.has(archive.requirementId)) {
            output.prepare("INSERT INTO recovery_reconciliation VALUES(?,?,?,?,?,?,0)").run(archive.requirementId, null, null, null, archive.path, "archive_found");
            statuses.push({ requirementId: archive.requirementId, sourceLifecycle: null, retainedLifecycle: null, closeReason: null, archivePath: archive.path, recoveryReason: "archive_found", executable: false });
          }
          output.exec("COMMIT");
        } catch (error) { output.exec("ROLLBACK"); throw error; }
      } finally { output.close(); }
      statuses.sort((a, b) => a.requirementId.localeCompare(b.requirementId));
      save({ ...manifest, state: "reconciled", lastFailure: undefined });
    } else {
      validateDatabase(recoveredPath, DATABASE_APPLICATION_IDS.data);
      const output = new DatabaseSync(recoveredPath, { readOnly: true, allowExtension: false });
      try {
        statuses = output.prepare("SELECT requirement_id,source_lifecycle,retained_lifecycle,close_reason,archive_path,recovery_reason FROM recovery_reconciliation ORDER BY requirement_id").all().map((row) => ({
          requirementId: String(row.requirement_id), sourceLifecycle: row.source_lifecycle == null ? null : String(row.source_lifecycle), retainedLifecycle: row.retained_lifecycle == null ? null : String(row.retained_lifecycle), closeReason: row.close_reason == null ? null : String(row.close_reason), archivePath: row.archive_path == null ? null : String(row.archive_path), recoveryReason: row.recovery_reason == null ? null : String(row.recovery_reason) as RecoveryRequirementStatus["recoveryReason"], executable: false as const,
        }));
      } finally { output.close(); }
    }

    const reviewMarkerPath = join(operationDirectory, DATABASE_SNAPSHOT_FILE);
    const reviewMarker = JSON.stringify({ operationId: request.operationId, kind: "data", sourceHash: snapshot.hash, restoreStatus: "needs_review", executable: false });
    if (!pathExists(reviewMarkerPath)) writeNew(reviewMarkerPath, reviewMarker);
    if (readPrivateText(reviewMarkerPath, "snapshot_marker_invalid").contents !== reviewMarker) throw new DatabaseRecoveryError("snapshot_marker_invalid");
    syncDirectory(operationDirectory);
    const receipt: DatabaseRecoveryReceipt = { operationId: request.operationId, mode: "legacy_data", state: "reconciled", executable: false, restoreStatus: "needs_review", recoveredPath, requirements: statuses, archives };
    reauthorize("complete"); save({ ...manifest, state: "completed", receipt, lastFailure: undefined });
    return receipt;
  } catch (error) {
    try { save({ ...manifest, lastFailure: error instanceof DatabaseRecoveryError ? error.code : "recovery_failed" }); } catch { /* 保留最后一个可核对阶段。 */ }
    if (error instanceof DatabaseRecoveryError) throw error;
    throw new DatabaseRecoveryError("recovery_failed");
  }
}
