import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, renameSync, statSync, writeFileSync, writeSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { UUID_V7_PATTERN } from "../../core/storage/database.ts";
import { databaseFilesFingerprint, reconcileDatabaseRecovery } from "../../core/storage/database-recovery.ts";
import type { RecoveryRequirementStatus } from "../../core/storage/database-recovery.ts";
import { databaseMaintenanceDirectory, withDatabaseMaintenance } from "../../core/storage/database-maintenance.ts";
import type { DatabaseMaintenancePermit } from "../../core/storage/database-maintenance.ts";
import { DATABASE_SNAPSHOT_FILE, pathExists } from "../../core/storage/database-paths.ts";
import { readRequirementBackupOperation, requirementBackupFiles } from "./requirement-backup.ts";
import type { RequirementBackupFile, RequirementBackupManifest, RequirementBackupReference, RequirementBackupRequirement } from "./requirement-backup.ts";
import { REQUIREMENT_WRITE_COORDINATION_NAMESPACE } from "./requirement-coordination.ts";
import { PRD_FILE, PRD_FILE_PATTERN, verifyVersion } from "./prd-storage.ts";
import { sealOperationLog, validOperationLog } from "../../core/storage/operation-log.ts";

const RESTORE_FORMAT = "requirement-restore-operation/v1" as const;
const RESTORE_FILE = ".requirement-restore-operation.json";
const HASH = /^[0-9a-f]{64}$/;
const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export class RequirementRecoveryError extends Error {
  readonly code: string;
  readonly restoreStatus = "needs_review" as const;
  readonly executable = false as const;
  constructor(code: string) {
    super(`需求备份恢复保持待审核：${code}；没有恢复执行授权`);
    this.name = "RequirementRecoveryError";
    this.code = code;
  }
}

export interface RequirementRestoreOptions {
  /** createRequirementBackup返回的私有backupDirectory。 */
  backupDirectory: string;
  backupOperationId: string;
  backupManifestHash: string;
  /** 独立隔离<dataRoot>/repos/<repoId>目录；不会把恢复库切换成这里的活动data.db。 */
  repoDirectory: string;
  repoId: string;
  operationId: string;
  worktreeRoots: readonly string[];
  archiveDirectory?: string;
  registeredArchivePaths?: readonly string[];
}

export interface RequirementRestoreReceipt {
  operationId: string;
  backupOperationId: string;
  repoId: string;
  state: "reconciled";
  restoreStatus: "needs_review";
  executable: false;
  isolationDirectory: string;
  recoveredDatabasePath: string | null;
  backupManifestHash: string;
  filesRestored: number;
  requirements: RecoveryRequirementStatus[];
}

interface RestoreLog {
  integrityHash?: string;
  recoveredDatabaseHash?: string;
  format: typeof RESTORE_FORMAT;
  operationId: string;
  backupOperationId: string;
  repoId: string;
  backupManifestHash: string;
  repoDevice: number;
  repoInode: number;
  registrationHash: string;
  phase: "prepared" | "copying" | "copied" | "reconciled" | "verified" | "completed";
  recoveredDatabasePath?: string | null;
  requirements?: RecoveryRequirementStatus[];
}

interface ScannedFile extends RequirementBackupFile { path: string; dev: number; ino: number; uid: number; mtimeMs: number; ctimeMs: number }

function fail(code: string): never { throw new RequirementRecoveryError(code); }
function sha256(bytes: Uint8Array | string): string { return createHash("sha256").update(bytes).digest("hex"); }
function contained(parent: string, child: string): boolean {
  const value = relative(parent, child);
  return value === "" || (value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value));
}
function syncDirectory(path: string): void { const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); try { fsyncSync(fd); } finally { closeSync(fd); } }
function privateDirectory(path: string, code: string): string {
  if (!isAbsolute(path)) fail("absolute_directory_required");
  let actual: string;
  try { actual = realpathSync(path); } catch { fail(code); }
  const stats = lstatSync(path);
  if (actual !== resolve(path) || !stats.isDirectory() || stats.isSymbolicLink() || stats.nlink < 1 || (stats.mode & 0o077) !== 0 || (typeof process.getuid === "function" && stats.uid !== process.getuid())) fail(code);
  return actual;
}
function assertRepoDirectory(path: string, repoId: string): { path: string; dataRoot: string; identity: { dev: number; ino: number } } {
  if (!HASH.test(repoId)) fail("invalid_repo_id");
  if (basename(path) !== repoId || basename(dirname(path)) !== "repos") fail("invalid_repo_directory");
  const actual = privateDirectory(path, "invalid_repo_directory");
  privateDirectory(dirname(actual), "invalid_repo_directory");
  const dataRoot = privateDirectory(dirname(dirname(actual)), "invalid_repo_directory");
  const stats = statSync(actual);
  return { path: actual, dataRoot, identity: { dev: stats.dev, ino: stats.ino } };
}
function ensurePrivateChild(parent: string, name: string): string {
  if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\\")) fail("invalid_internal_path");
  const path = join(parent, name);
  if (!pathExists(path)) { mkdirSync(path, { mode: 0o700 }); syncDirectory(parent); }
  const actual = privateDirectory(path, "unsafe_restore_directory");
  if (dirname(actual) !== parent) fail("unsafe_restore_directory");
  return actual;
}
function writeNewPrivate(path: string, bytes: Uint8Array | string): void {
  const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
}
function replacePrivateJson(path: string, directory: string, value: object): void {
  const temporary = join(directory, ".requirement-restore-next.json");
  if (pathExists(temporary)) fail("restore_log_needs_review");
  writeNewPrivate(temporary, JSON.stringify(sealOperationLog(value))); renameSync(temporary, path); syncDirectory(directory);
}
function readPrivateBytes(path: string, code: string): Buffer {
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); } catch { fail(code); }
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || (before.mode & 0o077) !== 0 || (typeof process.getuid === "function" && before.uid !== process.getuid())) fail(code);
    const bytes = readFileSync(fd), after = fstatSync(fd), named = lstatSync(path);
    if (!named.isFile() || named.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || named.dev !== after.dev || named.ino !== after.ino || bytes.length !== after.size) fail(code);
    return bytes;
  } finally { closeSync(fd); }
}
function registrationHash(value: Omit<RestoreLog, "format" | "registrationHash" | "phase" | "recoveredDatabasePath" | "requirements">): string { return sha256(JSON.stringify(value)); }
function parseRestoreLog(path: string): RestoreLog {
  let value: unknown;
  try { value = JSON.parse(readPrivateBytes(path, "restore_log_invalid").toString("utf8")); } catch (error) { if (error instanceof RequirementRecoveryError) throw error; fail("restore_log_invalid"); }
  if (!validOperationLog(value) || Object.keys(value).some((key) => !["format", "operationId", "backupOperationId", "repoId", "backupManifestHash", "repoDevice", "repoInode", "registrationHash", "phase", "recoveredDatabasePath", "recoveredDatabaseHash", "requirements", "integrityHash"].includes(key))) fail("restore_log_invalid");
  const log = value as Partial<RestoreLog>;
  if (log.format !== RESTORE_FORMAT || !UUID_V7_PATTERN.test(String(log.operationId)) || !UUID_V7_PATTERN.test(String(log.backupOperationId)) || !HASH.test(String(log.repoId)) || !HASH.test(String(log.backupManifestHash)) || !Number.isSafeInteger(log.repoDevice) || !Number.isSafeInteger(log.repoInode) || !HASH.test(String(log.registrationHash)) || !["prepared", "copying", "copied", "reconciled", "verified", "completed"].includes(String(log.phase))) fail("restore_log_invalid");
  const registration = { operationId: log.operationId!, backupOperationId: log.backupOperationId!, repoId: log.repoId!, backupManifestHash: log.backupManifestHash!, repoDevice: log.repoDevice!, repoInode: log.repoInode! };
  if (registrationHash(registration) !== log.registrationHash) fail("restore_log_invalid");
  if (["reconciled", "verified", "completed"].includes(log.phase!)) {
    if (typeof log.recoveredDatabasePath !== "string" || !isAbsolute(log.recoveredDatabasePath)) fail("restore_log_invalid");
    checkedRecoveryStatuses(log.requirements);
  }
  if (["verified", "completed"].includes(log.phase!) && !HASH.test(log.recoveredDatabaseHash ?? "")) fail("restore_log_invalid");
  return log as RestoreLog;
}
function saveRestoreLog(path: string, directory: string, prior: RestoreLog, next: RestoreLog): RestoreLog {
  if (JSON.stringify(parseRestoreLog(path)) !== JSON.stringify(prior)) fail("restore_log_changed");
  replacePrivateJson(path, directory, next); return parseRestoreLog(path);
}
function exactKeys(value: object, expected: readonly string[]): boolean {
  return Object.keys(value).sort().join("\0") === [...expected].sort().join("\0");
}
function validReference(value: unknown): value is RequirementBackupReference {
  const ref = value as Partial<RequirementBackupReference> | null;
  return !!ref && exactKeys(ref, ["commit", "prdHash"]) && COMMIT.test(String(ref.commit)) && /^sha256:[0-9a-f]{64}$/.test(String(ref.prdHash));
}
function validRequirement(value: unknown): value is RequirementBackupRequirement {
  const item = value as Partial<RequirementBackupRequirement> | null;
  return !!item && exactKeys(item, ["requirementId", "recordVersion", "lifecycle", "recovery", "epoch", "revision", "saved", "approved"]) && UUID_V7_PATTERN.test(String(item.requirementId)) && Number.isSafeInteger(item.recordVersion) && Number(item.recordVersion) > 0 && ["draft", "active", "closing", "closed"].includes(String(item.lifecycle)) && ["ready", "needs_review"].includes(String(item.recovery)) && Number.isSafeInteger(item.epoch) && Number(item.epoch) > 0 && Number.isSafeInteger(item.revision) && Number(item.revision) >= 0 && (item.saved === null || validReference(item.saved)) && (item.approved === null || validReference(item.approved));
}
function safeRelativePath(path: string): boolean {
  if (!path || path.startsWith("/") || path.includes("\\") || path.includes("\0")) return false;
  const parts = path.split("/");
  return parts.every((part) => !!part && part !== "." && part !== "..");
}
function validBackupFile(value: unknown): value is RequirementBackupFile {
  const file = value as Partial<RequirementBackupFile> | null;
  return !!file && exactKeys(file, ["relativePath", "size", "hash"]) && safeRelativePath(String(file.relativePath)) && Number.isSafeInteger(file.size) && Number(file.size) >= 0 && HASH.test(String(file.hash));
}
function validateManifest(value: unknown, options: RequirementRestoreOptions, registrationHash: string): RequirementBackupManifest {
  const manifest = value as Partial<RequirementBackupManifest>;
  if (!manifest || typeof manifest !== "object" || !exactKeys(manifest, ["format", "operationId", "repoId", "registrationHash", "stateSource", "database", "requirements", "files"]) || manifest.format !== requirementBackupFiles.format || manifest.operationId !== options.backupOperationId || manifest.repoId !== options.repoId || manifest.registrationHash !== registrationHash || manifest.stateSource !== "data.db:requirements" || !validBackupFile(manifest.database) || manifest.database.relativePath !== "data.db" || !Array.isArray(manifest.requirements) || !manifest.requirements.every(validRequirement) || !Array.isArray(manifest.files) || !manifest.files.every(validBackupFile)) fail("manifest_invalid");
  const ids = manifest.requirements.map((item) => item.requirementId);
  const paths = manifest.files.map((item) => item.relativePath);
  if (new Set(ids).size !== ids.length || new Set(paths).size !== paths.length) fail("manifest_invalid");
  const database = manifest.files.find((file) => file.relativePath === "data.db");
  if (!database || database.hash !== manifest.database.hash || database.size !== manifest.database.size) fail("manifest_invalid");
  const known = new Set(ids);
  for (const file of manifest.files) {
    if (file.relativePath === "data.db") continue;
    const match = new RegExp(`^requirements/([0-9a-f-]{36})/(${PRD_FILE_PATTERN}|\\.git/.+)$`).exec(file.relativePath) ?? /^prototypes\/([0-9a-f-]{36})\/[^/]+\.v\d+\.html$/.exec(file.relativePath);
    if (!match || !UUID_V7_PATTERN.test(match[1]!) || !known.has(match[1]!)) fail("manifest_path_not_allowed");
  }
  for (const requirement of manifest.requirements.filter((item) => item.saved || item.approved)) {
    if (!paths.includes(`requirements/${requirement.requirementId}/${PRD_FILE}`) || !paths.some((path) => path.startsWith(`requirements/${requirement.requirementId}/.git/`))) fail("manifest_requirement_incomplete");
  }
  return manifest as RequirementBackupManifest;
}
function readBackup(options: RequirementRestoreOptions): { directory: string; payload: string; manifest: RequirementBackupManifest } {
  const directory = privateDirectory(options.backupDirectory, "backup_directory_invalid");
  if (basename(directory) !== options.backupOperationId || !UUID_V7_PATTERN.test(options.backupOperationId) || !HASH.test(options.backupManifestHash)) fail("backup_identity_invalid");
  const operationPath = join(directory, requirementBackupFiles.operation);
  let operation: ReturnType<typeof readRequirementBackupOperation>;
  try { operation = readRequirementBackupOperation(operationPath); } catch { fail("backup_operation_invalid"); }
  if (operation.format !== requirementBackupFiles.operationFormat || operation.operationId !== options.backupOperationId || operation.repoId !== options.repoId || operation.phase !== "completed" || !HASH.test(String(operation.registrationHash)) || operation.manifestHash !== options.backupManifestHash) fail("backup_operation_invalid");
  const manifestBytes = readPrivateBytes(join(directory, requirementBackupFiles.manifest), "manifest_invalid");
  if (sha256(manifestBytes) !== options.backupManifestHash) fail("manifest_hash_mismatch");
  let raw: unknown;
  try { raw = JSON.parse(manifestBytes.toString("utf8")); } catch { fail("manifest_invalid"); }
  const manifest = validateManifest(raw, options, String(operation.registrationHash));
  const payload = privateDirectory(join(directory, "payload"), "backup_payload_invalid");
  return { directory, payload, manifest };
}
function scanFile(path: string, relativePath: string): ScannedFile {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || (before.mode & 0o077) !== 0 || (typeof process.getuid === "function" && before.uid !== process.getuid())) fail("unsafe_backup_file");
    const digest = createHash("sha256"), buffer = Buffer.alloc(64 * 1024);
    for (;;) { const count = readSync(fd, buffer, 0, buffer.length, null); if (!count) break; digest.update(buffer.subarray(0, count)); }
    const after = fstatSync(fd), named = lstatSync(path);
    if (!named.isFile() || named.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || named.dev !== after.dev || named.ino !== after.ino) fail("backup_changed");
    return { relativePath, size: after.size, hash: digest.digest("hex"), path, dev: after.dev, ino: after.ino, uid: after.uid, mtimeMs: after.mtimeMs, ctimeMs: after.ctimeMs };
  } finally { closeSync(fd); }
}
function scanTree(root: string, prefix = ""): ScannedFile[] {
  const before = lstatSync(root);
  if (!before.isDirectory() || before.isSymbolicLink() || (before.mode & 0o077) !== 0 || (typeof process.getuid === "function" && before.uid !== process.getuid())) fail("unsafe_backup_directory");
  const files: ScannedFile[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(root, entry.name), rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const stats = lstatSync(path);
    if (stats.isSymbolicLink()) fail("backup_link_forbidden");
    if (stats.isDirectory()) files.push(...scanTree(path, rel));
    else if (stats.isFile()) files.push(scanFile(path, rel));
    else fail("unsafe_backup_file");
  }
  const after = lstatSync(root);
  if (before.dev !== after.dev || before.ino !== after.ino || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) fail("backup_changed");
  return files;
}
// 备份时按当时进程的语言环境排序，恢复时语言环境可能不同，所以两边都按码位重排后再比较
const byPath = (a: RequirementBackupFile, b: RequirementBackupFile) => a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0;
function metadata(files: RequirementBackupFile[]): RequirementBackupFile[] { return files.map(({ relativePath, size, hash }) => ({ relativePath, size, hash })).sort(byPath); }
function assertPayload(payload: string, expected: RequirementBackupFile[]): Map<string, ScannedFile> {
  const scanned = scanTree(payload);
  if (JSON.stringify(metadata(scanned)) !== JSON.stringify(metadata(expected))) fail("backup_payload_mismatch");
  return new Map(scanned.map((file) => [file.relativePath, file]));
}
function assertRestoredPayload(repoDirectory: string, manifest: RequirementBackupManifest): void {
  for (const family of ["requirements", "prototypes"]) {
    const expected = manifest.files.filter((file) => file.relativePath.startsWith(`${family}/`));
    const directory = join(repoDirectory, family);
    const actual = pathExists(directory) ? metadata(scanTree(directory, family)) : [];
    if (JSON.stringify(actual) !== JSON.stringify(metadata(expected))) fail("restore_target_conflict");
  }
  const copiedDatabase = scanFile(join(repoDirectory, "backups", "requirement-restore-sources", manifest.operationId, "data.db"), "data.db");
  if (copiedDatabase.hash !== manifest.database.hash || copiedDatabase.size !== manifest.database.size) fail("restore_copy_mismatch");
}
function ensureDestinationParents(root: string, relativePath: string): string {
  const parts = relativePath.split("/"), file = parts.pop();
  if (!file || parts.some((part) => !part || part === "." || part === "..")) fail("invalid_relative_path");
  let current = root;
  for (const part of parts) current = ensurePrivateChild(current, part);
  return join(current, file);
}
function destinationFingerprint(path: string): RequirementBackupFile {
  const scanned = scanFile(path, ""); return { relativePath: "", size: scanned.size, hash: scanned.hash };
}
function copyScanned(source: ScannedFile, destinationRoot: string, targetRelativePath: string): void {
  const destination = ensureDestinationParents(destinationRoot, targetRelativePath);
  if (pathExists(destination)) {
    const existing = destinationFingerprint(destination);
    if (existing.size !== source.size || existing.hash !== source.hash) fail("restore_target_conflict");
    return;
  }
  const input = openSync(source.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let output: number | undefined;
  try {
    const before = fstatSync(input);
    if (!before.isFile() || before.nlink !== 1 || before.dev !== source.dev || before.ino !== source.ino || before.uid !== source.uid || before.size !== source.size || before.mtimeMs !== source.mtimeMs || before.ctimeMs !== source.ctimeMs) fail("backup_changed");
    output = openSync(destination, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    const digest = createHash("sha256"), buffer = Buffer.alloc(64 * 1024); let size = 0;
    for (;;) {
      const count = readSync(input, buffer, 0, buffer.length, null); if (!count) break;
      const chunk = buffer.subarray(0, count); digest.update(chunk); size += count;
      let offset = 0; while (offset < count) offset += writeSync(output, chunk, offset, count - offset);
    }
    fsyncSync(output);
    if (size !== source.size || digest.digest("hex") !== source.hash) fail("backup_changed");
  } finally { if (output !== undefined) closeSync(output); closeSync(input); }
  syncDirectory(dirname(destination));
  const copied = destinationFingerprint(destination);
  if (copied.size !== source.size || copied.hash !== source.hash) fail("restore_copy_mismatch");
}
async function verifyRestoredRepositories(options: RequirementRestoreOptions, dataRoot: string, requirements: RequirementBackupRequirement[]): Promise<void> {
  for (const requirement of requirements) {
    const refs = [...new Map([requirement.saved, requirement.approved]
      .filter((value): value is RequirementBackupReference => value !== null)
      .map((reference) => [`${reference.commit}:${reference.prdHash}`, reference])).values()];
    const allowed = new Set(refs.map((ref) => `${ref.commit}:${ref.prdHash}`));
    for (const reference of refs) {
      await verifyVersion({
        dataRoot, repoId: options.repoId, requirementId: requirement.requirementId,
        worktreeRoots: [...options.worktreeRoots], commit: reference.commit, expectedHash: reference.prdHash,
        authorize: (check) => {
          const checkedHash = check.expectedHash ?? check.prdHash;
          if (check.action !== "verifyVersion" || !check.commit || !checkedHash || !allowed.has(`${check.commit}:${checkedHash}`)) return false;
          return true;
        },
      });
    }
  }
}
function revokeRecoveredCapabilities(permit: DatabaseMaintenancePermit, path: string, operationId: string): void {
  const maintenanceDirectory = databaseMaintenanceDirectory(permit);
  const expectedDirectory = join(maintenanceDirectory, "backups", "recovery", operationId);
  if (dirname(path) !== expectedDirectory || privateDirectory(expectedDirectory, "unsafe_restore_directory") !== expectedDirectory || realpathSync(path) !== path) fail("recovered_capability_scope_invalid");
  const db = new DatabaseSync(path, { allowExtension: false });
  let transaction = false;
  try {
    db.exec("PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=5000; BEGIN IMMEDIATE");
    transaction = true;
    db.prepare("DELETE FROM records WHERE namespace=?").run(REQUIREMENT_WRITE_COORDINATION_NAMESPACE);
    db.prepare("DELETE FROM records WHERE namespace='pm_ownership'").run();
    db.exec("COMMIT");
    transaction = false;
  } catch {
    if (transaction) {
      try { db.exec("ROLLBACK"); } catch { /* 恢复产物保持不可执行并由调用方报告待审核。 */ }
    }
    fail("recovered_capability_revoke_failed");
  } finally { db.close(); }
}
function verifyRecoveredState(path: string, manifest: RequirementBackupManifest, statuses: RecoveryRequirementStatus[], currentPath: string): void {
  const currentTerminals = new Map<string, Record<string, unknown>>();
  if (pathExists(currentPath)) {
    readPrivateBytes(currentPath, "current_database_invalid");
    const current = new DatabaseSync(currentPath, { readOnly: true, allowExtension: false });
    try {
      for (const row of current.prepare("SELECT record_key,data FROM records WHERE namespace='requirements'").all()) {
        const data = JSON.parse(String(row.data)) as Record<string, unknown>;
        if (data.lifecycle === "closing" || data.lifecycle === "closed") currentTerminals.set(String(row.record_key), data);
      }
    } finally { current.close(); }
  }
  const db = new DatabaseSync(path, { readOnly: true, allowExtension: false });
  try {
    if (db.prepare("PRAGMA quick_check").get()?.quick_check !== "ok") fail("recovered_database_invalid");
    for (const expected of manifest.requirements) {
      const row = db.prepare("SELECT data FROM records WHERE namespace='requirements' AND record_key=?").get(expected.requirementId);
      if (!row) fail("recovered_requirement_missing");
      let data: Record<string, unknown>;
      try { data = JSON.parse(String(row.data)) as Record<string, unknown>; } catch { fail("recovered_requirement_invalid"); }
      const saved = data.saved as Record<string, unknown> | null;
      const approved = data.approved as Record<string, unknown> | null;
      const currentTerminal = currentTerminals.get(expected.requirementId);
      if (currentTerminal) {
        if (JSON.stringify(data) !== JSON.stringify(currentTerminal)) fail("terminal_state_not_retained");
      } else if ((expected.saved === null) !== (saved === null) || (expected.approved === null) !== (approved === null) || (expected.saved && (saved?.commit !== expected.saved.commit || `sha256:${saved?.hash}` !== expected.saved.prdHash)) || (expected.approved && (approved?.commit !== expected.approved.commit || `sha256:${approved?.hash}` !== expected.approved.prdHash))) fail("recovered_reference_mismatch");
      const status = statuses.find((item) => item.requirementId === expected.requirementId);
      if (!status || status.executable !== false) fail("recovery_status_missing");
      if (data.lifecycle !== status.retainedLifecycle) fail("retained_state_mismatch");
      const retainedTerminal = status.retainedLifecycle === "closing" || status.retainedLifecycle === "closed";
      if (!currentTerminal && (expected.lifecycle === "closing" || expected.lifecycle === "closed") && status.retainedLifecycle !== expected.lifecycle) fail("terminal_state_not_retained");
      if ((expected.lifecycle === "draft" || expected.lifecycle === "active") && !retainedTerminal && data.recovery !== "needs_review") fail("old_active_not_blocked");
      if (retainedTerminal) {
        const close = data.close as Record<string, unknown> | null;
        if (!close || close.reason !== status.closeReason) fail("terminal_state_not_retained");
      }
    }
    for (const [requirementId, expected] of currentTerminals) {
      const row = db.prepare("SELECT data FROM records WHERE namespace='requirements' AND record_key=?").get(requirementId);
      if (!row || JSON.stringify(JSON.parse(String(row.data))) !== JSON.stringify(expected)) fail("terminal_state_not_retained");
      const status = statuses.find((item) => item.requirementId === requirementId);
      if (!status || status.executable !== false || status.retainedLifecycle !== expected.lifecycle) fail("recovery_status_missing");
    }
    const owners = Number(db.prepare("SELECT count(*) AS n FROM records WHERE namespace='pm_ownership'").get()?.n);
    if (owners !== 0) fail("pm_ownership_not_revoked");
    const writeClaims = Number(db.prepare("SELECT count(*) AS n FROM records WHERE namespace=?").get(REQUIREMENT_WRITE_COORDINATION_NAMESPACE)?.n);
    if (writeClaims !== 0) fail("requirement_write_claim_not_revoked");
  } finally { db.close(); }
}
function checkedRecoveryStatuses(value: unknown): RecoveryRequirementStatus[] {
  if (!Array.isArray(value)) fail("restore_log_invalid");
  return value.map((raw) => {
    const item = raw as Partial<RecoveryRequirementStatus> | null;
    if (!item || !exactKeys(item, ["requirementId", "sourceLifecycle", "retainedLifecycle", "closeReason", "archivePath", "recoveryReason", "executable"]) || !UUID_V7_PATTERN.test(String(item.requirementId)) || (item.sourceLifecycle !== null && (typeof item.sourceLifecycle !== "string" || item.sourceLifecycle.length > 32)) || (item.retainedLifecycle !== null && (typeof item.retainedLifecycle !== "string" || item.retainedLifecycle.length > 32)) || (item.closeReason !== null && (typeof item.closeReason !== "string" || item.closeReason.length > 64)) || (item.archivePath !== null && (typeof item.archivePath !== "string" || !isAbsolute(item.archivePath))) || ![null, "archive_found", "history_unknown", "identity_conflict"].includes(item.recoveryReason ?? null) || item.executable !== false) fail("restore_log_invalid");
    return { requirementId: item.requirementId!, sourceLifecycle: item.sourceLifecycle!, retainedLifecycle: item.retainedLifecycle!, closeReason: item.closeReason!, archivePath: item.archivePath!, recoveryReason: item.recoveryReason!, executable: false };
  });
}
function completedReceipt(options: RequirementRestoreOptions, repoDirectory: string, log: RestoreLog, manifest: RequirementBackupManifest): RequirementRestoreReceipt {
  const expectedRecoveredPath = join(repoDirectory, "backups", "recovery", options.operationId, "data.db");
  if (log.phase !== "completed" || log.recoveredDatabasePath !== expectedRecoveredPath) fail("restore_not_completed");
  const requirements = checkedRecoveryStatuses(log.requirements);
  return { operationId: options.operationId, backupOperationId: options.backupOperationId, repoId: options.repoId, state: "reconciled", restoreStatus: "needs_review", executable: false, isolationDirectory: repoDirectory, recoveredDatabasePath: log.recoveredDatabasePath, backupManifestHash: options.backupManifestHash, filesRestored: manifest.files.length, requirements };
}

/**
 * 把完整备份复制到独立私有目录，并调用备份快照分级对账。恢复结果始终needs_review，
 * 不切换活动data.db、不恢复PM、任务或执行授权，也不读取归档正文。
 */
export async function restoreRequirementBackup(options: RequirementRestoreOptions): Promise<RequirementRestoreReceipt> {
  if (!options || !UUID_V7_PATTERN.test(options.operationId) || !UUID_V7_PATTERN.test(options.backupOperationId) || !HASH.test(options.backupManifestHash) || !Array.isArray(options.worktreeRoots) || options.worktreeRoots.length === 0) fail("invalid_options");
  const backup = readBackup(options);
  const destination = assertRepoDirectory(options.repoDirectory, options.repoId);
  if (contained(destination.path, backup.directory) || contained(backup.directory, destination.path)) fail("backup_overlaps_isolation");
  return withDatabaseMaintenance({ directory: destination.path, worktreeRoots: [...options.worktreeRoots], operationId: options.operationId }, async (permit) => {
    if (databaseMaintenanceDirectory(permit) !== destination.path) fail("maintenance_scope_changed");
    const backups = ensurePrivateChild(destination.path, "backups");
    const restoreRoot = ensurePrivateChild(backups, "requirement-restores");
    const operationDirectory = join(restoreRoot, options.operationId);
    const logPath = join(operationDirectory, RESTORE_FILE);
    let log: RestoreLog;
    if (pathExists(operationDirectory)) {
      privateDirectory(operationDirectory, "restore_operation_invalid");
      if (!pathExists(logPath)) fail("restore_operation_conflict");
      log = parseRestoreLog(logPath);
      if (log.operationId !== options.operationId || log.backupOperationId !== options.backupOperationId || log.repoId !== options.repoId || log.backupManifestHash !== options.backupManifestHash || log.repoDevice !== destination.identity.dev || log.repoInode !== destination.identity.ino) fail("restore_operation_conflict");
      if (log.phase === "completed") {
        assertPayload(backup.payload, backup.manifest.files);
        assertRestoredPayload(destination.path, backup.manifest);
        await verifyRestoredRepositories(options, destination.dataRoot, backup.manifest.requirements);
        const receipt = completedReceipt(options, destination.path, log, backup.manifest);
        if (!receipt.recoveredDatabasePath) fail("recovered_database_missing");
        if (databaseFilesFingerprint(receipt.recoveredDatabasePath) !== log.recoveredDatabaseHash) fail("recovered_database_changed");
        verifyRecoveredState(receipt.recoveredDatabasePath, backup.manifest, receipt.requirements, join(destination.path, "data.db"));
        assertRestoredPayload(destination.path, backup.manifest);
        if (databaseFilesFingerprint(receipt.recoveredDatabasePath) !== log.recoveredDatabaseHash) fail("recovered_database_changed");
        return receipt;
      }
    } else {
      mkdirSync(operationDirectory, { mode: 0o700 }); syncDirectory(restoreRoot);
      const registration = { operationId: options.operationId, backupOperationId: options.backupOperationId, repoId: options.repoId, backupManifestHash: options.backupManifestHash, repoDevice: destination.identity.dev, repoInode: destination.identity.ino };
      log = { format: RESTORE_FORMAT, ...registration, registrationHash: registrationHash(registration), phase: "prepared" };
      writeNewPrivate(logPath, JSON.stringify(sealOperationLog(log))); syncDirectory(operationDirectory);
      log = parseRestoreLog(logPath);
    }
    const sources = assertPayload(backup.payload, backup.manifest.files);
    if (log.phase === "prepared") log = saveRestoreLog(logPath, operationDirectory, log, { ...log, phase: "copying" });
    const sourceFamily = ensurePrivateChild(backups, "requirement-restore-sources");
    const sourceDirectory = ensurePrivateChild(sourceFamily, options.backupOperationId);
    let restored = 0;
    for (const file of backup.manifest.files) {
      const source = sources.get(file.relativePath); if (!source) fail("backup_payload_mismatch");
      const targetRelative = file.relativePath === "data.db" ? `backups/requirement-restore-sources/${options.backupOperationId}/data.db` : file.relativePath;
      copyScanned(source, destination.path, targetRelative); restored += 1;
    }
    const snapshotPath = join(sourceDirectory, "data.db");
    const copiedDatabase = destinationFingerprint(snapshotPath);
    if (copiedDatabase.hash !== backup.manifest.database.hash || copiedDatabase.size !== backup.manifest.database.size) fail("restore_copy_mismatch");
    const snapshotMarkerPath = join(sourceDirectory, DATABASE_SNAPSHOT_FILE);
    const snapshotMarker = JSON.stringify({ format: "requirement-backup-restore-source/v1", backupOperationId: options.backupOperationId, backupManifestHash: options.backupManifestHash, restoreStatus: "needs_review", executable: false });
    if (pathExists(snapshotMarkerPath)) {
      if (readPrivateBytes(snapshotMarkerPath, "snapshot_marker_invalid").toString("utf8") !== snapshotMarker) fail("snapshot_marker_conflict");
    } else { writeNewPrivate(snapshotMarkerPath, snapshotMarker); syncDirectory(sourceDirectory); }
    if (log.phase === "copying") log = saveRestoreLog(logPath, operationDirectory, log, { ...log, phase: "copied" });

    const recovery = reconcileDatabaseRecovery(permit, {
      operationId: options.operationId,
      mode: "backup_data",
      snapshotPath,
      archiveDirectory: options.archiveDirectory,
      registeredArchivePaths: options.registeredArchivePaths,
    });
    if (recovery.mode !== "backup_data" || recovery.executable !== false || recovery.restoreStatus !== "needs_review") fail("unsafe_recovery_result");
    if (!recovery.recoveredPath) fail("recovered_database_missing");
    revokeRecoveredCapabilities(permit, recovery.recoveredPath, options.operationId);
    log = saveRestoreLog(logPath, operationDirectory, log, { ...log, phase: "reconciled", recoveredDatabasePath: recovery.recoveredPath, requirements: recovery.requirements });
    await verifyRestoredRepositories(options, destination.dataRoot, backup.manifest.requirements);
    verifyRecoveredState(recovery.recoveredPath, backup.manifest, recovery.requirements, join(destination.path, "data.db"));
    assertPayload(backup.payload, backup.manifest.files);
    assertRestoredPayload(destination.path, backup.manifest);
    const recoveredDatabaseHash = databaseFilesFingerprint(recovery.recoveredPath);
    log = saveRestoreLog(logPath, operationDirectory, log, { ...log, phase: "verified", recoveredDatabaseHash });
    assertRestoredPayload(destination.path, backup.manifest);
    if (databaseFilesFingerprint(recovery.recoveredPath) !== recoveredDatabaseHash) fail("recovered_database_changed");
    log = saveRestoreLog(logPath, operationDirectory, log, { ...log, phase: "completed" });
    return { operationId: options.operationId, backupOperationId: options.backupOperationId, repoId: options.repoId, state: "reconciled", restoreStatus: "needs_review", executable: false, isolationDirectory: destination.path, recoveredDatabasePath: recovery.recoveredPath, backupManifestHash: options.backupManifestHash, filesRestored: restored, requirements: recovery.requirements };
  });
}
