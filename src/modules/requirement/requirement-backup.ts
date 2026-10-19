import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, renameSync, statSync, writeFileSync, writeSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { UUID_V7_PATTERN } from "../../core/storage/database.ts";
import { DATABASE_APPLICATION_IDS, DATABASE_SCHEMA_VERSIONS, pathExists } from "../../core/storage/database-paths.ts";
import { createDatabaseSnapshot, databaseMaintenanceDirectory, withDatabaseMaintenance } from "../../core/storage/database-maintenance.ts";
import { checkRequirement } from "./requirement-contracts.ts";
import { REQUIREMENT_WRITE_COORDINATION_NAMESPACE, RequirementWriteCoordinator } from "./requirement-coordination.ts";
import { PRD_FILE, verifyVersion } from "./prd-storage.ts";
import { checkPrototypeName } from "./requirement-prototypes.ts";
import { sealOperationLog, validOperationLog } from "../../core/storage/operation-log.ts";

const FORMAT = "requirement-backup/v1" as const;
const OPERATION_FORMAT = "requirement-backup-operation/v1" as const;
const MANIFEST_FILE = ".requirement-backup.json";
const OPERATION_FILE = ".requirement-backup-operation.json";
const HASH = /^[0-9a-f]{64}$/;
const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export class RequirementBackupError extends Error {
  readonly code: string;
  constructor(code: string, detail?: string) {
    super(`需求备份未完成：${detail ? `${code}：${detail}` : code}；未返回正文或开放执行权限`);
    this.name = "RequirementBackupError";
    this.code = code;
  }
}

export interface RequirementBackupOptions {
  /** <dataRoot>/repos/<repoId> 的绝对私有目录。 */
  repoDirectory: string;
  repoId: string;
  operationId: string;
  worktreeRoots: readonly string[];
}

export interface RequirementBackupReference {
  commit: string;
  prdHash: `sha256:${string}`;
}

export interface RequirementBackupRequirement {
  requirementId: string;
  recordVersion: number;
  lifecycle: "draft" | "active" | "closing" | "closed";
  recovery: "ready" | "needs_review";
  epoch: number;
  revision: number;
  saved: RequirementBackupReference | null;
  approved: RequirementBackupReference | null;
}

export interface RequirementBackupFile {
  relativePath: string;
  size: number;
  hash: string;
}

export interface RequirementBackupManifest {
  format: typeof FORMAT;
  operationId: string;
  repoId: string;
  registrationHash: string;
  stateSource: "data.db:requirements";
  database: RequirementBackupFile;
  requirements: RequirementBackupRequirement[];
  files: RequirementBackupFile[];
}

export interface RequirementBackupReceipt {
  operationId: string;
  repoId: string;
  state: "completed";
  executable: false;
  backupDirectory: string;
  manifestPath: string;
  manifestHash: string;
  databaseHash: string;
  filesCopied: number;
  requirements: RequirementBackupRequirement[];
}

interface FilePlan extends RequirementBackupFile {
  sourcePath: string;
  dev: number;
  ino: number;
  uid: number;
  mtimeMs: number;
  ctimeMs: number;
}

interface RequirementOperationMetadata {
  operationId: string;
  requirementId: string;
  finalVersion: number | null;
  git: null | { commit: string; hash: string; repositoryRoot: string; repositoryIdentity: { dev: number; ino: number } };
}

interface StateInspection {
  requirements: RequirementBackupRequirement[];
  identities: Map<string, { dev: number; ino: number }>;
  fingerprint: string;
}

interface BackupOperationLog {
  integrityHash?: string;
  format: typeof OPERATION_FORMAT;
  operationId: string;
  repoId: string;
  repoDevice: number;
  repoInode: number;
  registrationHash: string;
  phase: "prepared" | "inspected" | "snapshotted" | "copying" | "copied" | "completed";
  sourceFingerprint?: string;
  snapshotRelativePath?: string;
  snapshotHash?: string;
  manifestHash?: string;
}

function fail(code: string, detail?: string): never { throw new RequirementBackupError(code, detail); }
function sha256(bytes: Uint8Array | string): string { return createHash("sha256").update(bytes).digest("hex"); }
function exactKeys(value: object, expected: readonly string[]): boolean { return Object.keys(value).sort().join("\0") === [...expected].sort().join("\0"); }
function syncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function sameIdentity(left: { dev: number; ino: number }, right: { dev: number; ino: number }): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}
function contained(parent: string, child: string): boolean {
  const value = relative(parent, child);
  return value === "" || (value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value));
}
function privateDirectory(path: string, code = "private_directory_required"): string {
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
  const dataRoot = dirname(dirname(actual));
  privateDirectory(dirname(actual), "invalid_repo_directory");
  privateDirectory(dataRoot, "invalid_repo_directory");
  const stats = statSync(actual);
  return { path: actual, dataRoot, identity: { dev: stats.dev, ino: stats.ino } };
}
function ensurePrivateChild(parent: string, name: string): string {
  if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\\")) fail("invalid_internal_path");
  const path = join(parent, name);
  if (!pathExists(path)) { mkdirSync(path, { mode: 0o700 }); syncDirectory(parent); }
  const actual = privateDirectory(path, "unsafe_backup_directory");
  if (dirname(actual) !== parent) fail("unsafe_backup_directory");
  return actual;
}
function writeNewPrivate(path: string, bytes: Uint8Array | string): void {
  const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
}
function replacePrivateJson(path: string, directory: string, value: object): void {
  const temporary = join(directory, ".requirement-backup-next.json");
  if (pathExists(temporary)) fail("operation_log_needs_review");
  writeNewPrivate(temporary, JSON.stringify(sealOperationLog(value)));
  renameSync(temporary, path); syncDirectory(directory);
}
function readPrivateBytes(path: string, code: string): Buffer {
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); } catch { fail(code); }
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || (before.mode & 0o077) !== 0 || (typeof process.getuid === "function" && before.uid !== process.getuid())) fail(code);
    const bytes = readFileSync(fd);
    const after = fstatSync(fd), named = lstatSync(path);
    if (!named.isFile() || named.isSymbolicLink() || named.dev !== after.dev || named.ino !== after.ino || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || bytes.length !== after.size) fail(code);
    return bytes;
  } finally { closeSync(fd); }
}
function registrationHash(value: Omit<BackupOperationLog, "format" | "registrationHash" | "phase" | "sourceFingerprint" | "snapshotRelativePath" | "snapshotHash" | "manifestHash">): string {
  return sha256(JSON.stringify(value));
}
function parseOperation(path: string): BackupOperationLog {
  let value: unknown;
  try { value = JSON.parse(readPrivateBytes(path, "operation_log_invalid").toString("utf8")); } catch (error) { if (error instanceof RequirementBackupError) throw error; fail("operation_log_invalid"); }
  if (!validOperationLog(value) || Object.keys(value).some((key) => !["format", "operationId", "repoId", "repoDevice", "repoInode", "registrationHash", "phase", "sourceFingerprint", "snapshotRelativePath", "snapshotHash", "manifestHash", "integrityHash"].includes(key))) fail("operation_log_invalid");
  const log = value as Partial<BackupOperationLog>;
  const phases = ["prepared", "inspected", "snapshotted", "copying", "copied", "completed"];
  if (log.format !== OPERATION_FORMAT || !UUID_V7_PATTERN.test(String(log.operationId)) || !HASH.test(String(log.repoId)) || !Number.isSafeInteger(log.repoDevice) || !Number.isSafeInteger(log.repoInode) || !HASH.test(String(log.registrationHash)) || !phases.includes(String(log.phase))) fail("operation_log_invalid");
  const registration = { operationId: log.operationId!, repoId: log.repoId!, repoDevice: log.repoDevice!, repoInode: log.repoInode! };
  if (registrationHash(registration) !== log.registrationHash) fail("operation_log_invalid");
  if (log.sourceFingerprint !== undefined && !HASH.test(log.sourceFingerprint)) fail("operation_log_invalid");
  if (log.snapshotHash !== undefined && !HASH.test(log.snapshotHash)) fail("operation_log_invalid");
  if (log.manifestHash !== undefined && !HASH.test(log.manifestHash)) fail("operation_log_invalid");
  const phase = phases.indexOf(log.phase!);
  if (phase >= 1 && !HASH.test(log.sourceFingerprint ?? "")) fail("operation_log_invalid");
  if (phase >= 2 && (!HASH.test(log.snapshotHash ?? "") || typeof log.snapshotRelativePath !== "string" || !log.snapshotRelativePath.startsWith("backups/") || log.snapshotRelativePath.split("/").some((part) => !part || part === "." || part === "..") || !log.snapshotRelativePath.endsWith("/data.db"))) fail("operation_log_invalid");
  if (phase === 5 && !HASH.test(log.manifestHash ?? "")) fail("operation_log_invalid");
  return log as BackupOperationLog;
}

/** 维护模块之间复用的无正文日志核验入口。 */
export function readRequirementBackupOperation(path: string): BackupOperationLog { return parseOperation(path); }
function saveOperation(path: string, directory: string, prior: BackupOperationLog, next: BackupOperationLog): BackupOperationLog {
  const current = parseOperation(path);
  if (JSON.stringify(current) !== JSON.stringify(prior)) fail("operation_log_changed");
  replacePrivateJson(path, directory, next);
  return parseOperation(path);
}
function metadataReference(value: unknown): RequirementBackupReference | null {
  if (value === null) return null;
  const ref = value as { commit?: unknown; hash?: unknown };
  if (!ref || typeof ref !== "object" || !COMMIT.test(String(ref.commit)) || !HASH.test(String(ref.hash))) fail("invalid_requirement_state");
  return { commit: String(ref.commit), prdHash: `sha256:${String(ref.hash)}` };
}
function parseOperationMetadata(row: Record<string, unknown>, repoId: string): RequirementOperationMetadata {
  let value: unknown;
  try { value = JSON.parse(String(row.data)); } catch { fail("invalid_requirement_operation"); }
  const operation = value as Record<string, unknown>;
  if (operation.format !== "requirement-service-operation/v1" || operation.repoId !== repoId || operation.operationId !== row.record_key || !UUID_V7_PATTERN.test(String(operation.operationId)) || !UUID_V7_PATTERN.test(String(operation.requirementId)) || (operation.finalVersion !== null && (!Number.isSafeInteger(operation.finalVersion) || Number(operation.finalVersion) < 1))) fail("invalid_requirement_operation");
  let git: RequirementOperationMetadata["git"] = null;
  if (operation.git !== null) {
    const raw = operation.git as Record<string, unknown>;
    const identity = raw.repositoryIdentity as Record<string, unknown>;
    if (!raw || typeof raw !== "object" || !COMMIT.test(String(raw.commit)) || !HASH.test(String(raw.hash)) || typeof raw.repositoryRoot !== "string" || !identity || typeof identity !== "object" || !Number.isSafeInteger(identity.dev) || !Number.isSafeInteger(identity.ino)) fail("invalid_requirement_operation");
    git = { commit: String(raw.commit), hash: String(raw.hash), repositoryRoot: String(raw.repositoryRoot), repositoryIdentity: { dev: Number(identity.dev), ino: Number(identity.ino) } };
  }
  return { operationId: String(operation.operationId), requirementId: String(operation.requirementId), finalVersion: operation.finalVersion === null ? null : Number(operation.finalVersion), git };
}
function inspectState(path: string, repoId: string): StateInspection {
  const db = new DatabaseSync(path, { readOnly: true, allowExtension: false });
  try {
    db.exec("PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=5000;");
    if (db.prepare("PRAGMA quick_check").get()?.quick_check !== "ok" || Number(db.prepare("PRAGMA user_version").get()?.user_version) !== DATABASE_SCHEMA_VERSIONS.data || Number(db.prepare("PRAGMA application_id").get()?.application_id) !== DATABASE_APPLICATION_IDS.data) fail("invalid_data_database");
    if (db.prepare("SELECT 1 AS occupied FROM records WHERE namespace=? LIMIT 1").get(REQUIREMENT_WRITE_COORDINATION_NAMESPACE)) fail("requirement_write_busy");
    const operations = db.prepare("SELECT record_key,data FROM records WHERE namespace='requirement_service_operations' ORDER BY record_key").all().map((row) => parseOperationMetadata(row, repoId));
    if (operations.some((operation) => operation.finalVersion === null)) fail("unfinished_requirement_operation");
    const requirements: RequirementBackupRequirement[] = [];
    const identities = new Map<string, { dev: number; ino: number }>();
    for (const row of db.prepare("SELECT record_key,version,data FROM records WHERE namespace='requirements' ORDER BY record_key").all()) {
      let raw: unknown;
      try { raw = JSON.parse(String(row.data)); } catch { fail("invalid_requirement_state"); }
      let checked: ReturnType<typeof checkRequirement>;
      try { checked = checkRequirement(raw, String(row.record_key), repoId); } catch { fail("invalid_requirement_state"); }
      const requirement: RequirementBackupRequirement = {
        requirementId: checked.requirementId,
        recordVersion: Number(row.version),
        lifecycle: checked.lifecycle,
        recovery: checked.recovery,
        epoch: checked.epoch,
        revision: checked.revision,
        saved: metadataReference(checked.saved),
        approved: metadataReference(checked.approved),
      };
      requirements.push(requirement);
      for (const reference of [requirement.saved, requirement.approved]) {
        if (!reference) continue;
        const hash = reference.prdHash.slice("sha256:".length);
        const matches = operations.filter((operation) => operation.finalVersion !== null && operation.requirementId === requirement.requirementId && operation.git?.commit === reference.commit && operation.git.hash === hash);
        if (matches.length < 1) fail("registered_commit_missing");
        const roots = new Set(matches.map((operation) => operation.git!.repositoryRoot));
        const identityValues = matches.map((operation) => operation.git!.repositoryIdentity);
        if (roots.size !== 1 || identityValues.some((identity) => !sameIdentity(identity, identityValues[0]!))) fail("repository_identity_conflict");
        const existing = identities.get(requirement.requirementId);
        if (existing && !sameIdentity(existing, identityValues[0]!)) fail("repository_identity_conflict");
        identities.set(requirement.requirementId, identityValues[0]!);
      }
    }
    const fingerprint = sha256(JSON.stringify({ requirements, operations: operations.map((operation) => ({ ...operation, git: operation.git ? { ...operation.git, repositoryRoot: relative(dirname(dirname(path)), operation.git.repositoryRoot) } : null })) }));
    return { requirements, identities, fingerprint };
  } finally { db.close(); }
}
function scanFile(path: string, relativePath: string): FilePlan {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || (before.mode & 0o077) !== 0 || (typeof process.getuid === "function" && before.uid !== process.getuid())) fail("unsafe_source_file");
    const digest = createHash("sha256"), buffer = Buffer.alloc(64 * 1024);
    for (;;) { const count = readSync(fd, buffer, 0, buffer.length, null); if (!count) break; digest.update(buffer.subarray(0, count)); }
    const after = fstatSync(fd), named = lstatSync(path);
    if (!named.isFile() || named.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || named.dev !== after.dev || named.ino !== after.ino) fail("source_changed");
    return { relativePath, size: after.size, hash: digest.digest("hex"), sourcePath: path, dev: after.dev, ino: after.ino, uid: after.uid, mtimeMs: after.mtimeMs, ctimeMs: after.ctimeMs };
  } finally { closeSync(fd); }
}
function scanTree(root: string, prefix: string): FilePlan[] {
  const rootStats = lstatSync(root);
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink() || (rootStats.mode & 0o077) !== 0 || (typeof process.getuid === "function" && rootStats.uid !== process.getuid())) fail("unsafe_source_directory");
  const identity = { dev: rootStats.dev, ino: rootStats.ino, mtimeMs: rootStats.mtimeMs, ctimeMs: rootStats.ctimeMs };
  const files: FilePlan[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === "." || entry.name === ".." || entry.name.includes("/") || entry.name.includes("\\")) fail("unsafe_source_path");
    const path = join(root, entry.name), rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const stats = lstatSync(path);
    if (stats.isSymbolicLink()) fail("source_link_forbidden");
    if (stats.isDirectory()) files.push(...scanTree(path, rel));
    else if (stats.isFile()) files.push(scanFile(path, rel));
    else fail("unsafe_source_file");
  }
  const after = lstatSync(root);
  if (after.dev !== identity.dev || after.ino !== identity.ino || after.mtimeMs !== identity.mtimeMs || after.ctimeMs !== identity.ctimeMs) fail("source_changed");
  return files;
}
function requirementFiles(repoDirectory: string, requirements: RequirementBackupRequirement[]): FilePlan[] {
  const root = join(repoDirectory, "requirements");
  if (!pathExists(root)) {
    if (requirements.some((requirement) => requirement.saved || requirement.approved)) fail("requirement_repository_missing");
    return [];
  }
  privateDirectory(root, "unsafe_requirements_directory");
  const expected = new Set(requirements.filter((requirement) => requirement.saved || requirement.approved).map((requirement) => requirement.requirementId));
  const actual = readdirSync(root, { withFileTypes: true });
  for (const entry of actual) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !UUID_V7_PATTERN.test(entry.name) || !expected.has(entry.name)) fail("unregistered_requirement_repository");
    const entries = readdirSync(join(root, entry.name)).sort();
    if (entries.length !== 2 || entries[0] !== ".git" || entries[1] !== PRD_FILE) fail("invalid_requirement_repository");
  }
  for (const id of expected) if (!actual.some((entry) => entry.name === id)) fail("requirement_repository_missing");
  return scanTree(root, "requirements");
}
function prototypeFiles(repoDirectory: string, requirements: RequirementBackupRequirement[]): FilePlan[] {
  const db = new DatabaseSync(join(repoDirectory, "data.db"), { readOnly: true, allowExtension: false });
  const items = new Map<string, { requirementId: string; name: string; version: number; hash: string; bytes: number }>();
  try {
    db.exec("PRAGMA busy_timeout=5000;");
    const known = new Set(requirements.map((requirement) => requirement.requirementId));
    for (const row of db.prepare("SELECT data FROM records WHERE namespace='requirement_prototype_revisions' ORDER BY record_key").all()) {
      let data: { requirementId: string; prototypes: Array<{ name: string; version: number; hash: string; bytes: number }> };
      try { data = JSON.parse(String(row.data)); } catch { fail("invalid_prototype_revision"); }
      if (!known.has(data.requirementId)) continue;
      for (const item of data.prototypes) items.set(`${data.requirementId}/${item.name}.v${item.version}`, { requirementId: data.requirementId, ...item });
    }
  } finally { db.close(); }
  return [...items.values()].sort((a, b) => `${a.requirementId}/${a.name}.v${a.version}`.localeCompare(`${b.requirementId}/${b.name}.v${b.version}`)).map((item) => {
    const label = `${item.name}第 ${item.version} 版`;
    try { checkPrototypeName(item.name); } catch { fail("prototype_invalid", `原型 ${label} 的名称不能用作文件名`); }
    const relativePath = `prototypes/${item.requirementId}/${item.name}.v${item.version}.html`;
    const path = join(repoDirectory, ...relativePath.split("/"));
    if (!pathExists(path)) fail("prototype_missing", `原型 ${label} 的文件不存在`);
    const plan = scanFile(path, relativePath);
    if (plan.hash !== item.hash || plan.size !== item.bytes) fail("prototype_changed", `原型 ${label} 的内容与批准时的指纹不一致`);
    return plan;
  });
}
function sourceFilePlans(repoDirectory: string, requirements: RequirementBackupRequirement[]): FilePlan[] {
  return [...requirementFiles(repoDirectory, requirements), ...prototypeFiles(repoDirectory, requirements)];
}
function plansMetadata(plans: FilePlan[]): RequirementBackupFile[] {
  return plans.map(({ relativePath, size, hash }) => ({ relativePath, size, hash })).sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}
function plansFingerprint(plans: FilePlan[]): string { return sha256(JSON.stringify(plansMetadata(plans))); }
function assertPlanIdentity(plan: FilePlan): number {
  const fd = openSync(plan.sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  const stats = fstatSync(fd);
  if (!stats.isFile() || stats.nlink !== 1 || stats.dev !== plan.dev || stats.ino !== plan.ino || stats.uid !== plan.uid || stats.size !== plan.size || stats.mtimeMs !== plan.mtimeMs || stats.ctimeMs !== plan.ctimeMs) { closeSync(fd); fail("source_changed"); }
  return fd;
}
function ensureDestinationParents(root: string, relativePath: string): string {
  const parts = relativePath.split("/");
  const file = parts.pop();
  if (!file || parts.some((part) => !part || part === "." || part === "..")) fail("invalid_relative_path");
  let current = root;
  for (const part of parts) current = ensurePrivateChild(current, part);
  return join(current, file);
}
function fingerprintPrivateFile(path: string): RequirementBackupFile {
  const plan = scanFile(path, "");
  return { relativePath: "", size: plan.size, hash: plan.hash };
}
function copyPlan(plan: FilePlan, destinationRoot: string): void {
  const destination = ensureDestinationParents(destinationRoot, plan.relativePath);
  if (pathExists(destination)) {
    const existing = fingerprintPrivateFile(destination);
    if (existing.size !== plan.size || existing.hash !== plan.hash) fail("backup_target_conflict");
    return;
  }
  const source = assertPlanIdentity(plan);
  let target: number | undefined;
  try {
    target = openSync(destination, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    const digest = createHash("sha256"), buffer = Buffer.alloc(64 * 1024);
    let size = 0;
    for (;;) {
      const count = readSync(source, buffer, 0, buffer.length, null);
      if (!count) break;
      const chunk = buffer.subarray(0, count); digest.update(chunk); size += count;
      let offset = 0; while (offset < count) offset += writeSync(target, chunk, offset, count - offset);
    }
    fsyncSync(target);
    if (size !== plan.size || digest.digest("hex") !== plan.hash) fail("source_changed");
  } finally { if (target !== undefined) closeSync(target); closeSync(source); }
  syncDirectory(dirname(destination));
  const copied = fingerprintPrivateFile(destination);
  if (copied.size !== plan.size || copied.hash !== plan.hash) fail("backup_copy_mismatch");
}
function assertExactPayload(root: string, expected: RequirementBackupFile[]): void {
  const actual = plansMetadata(scanTree(root, ""));
  if (JSON.stringify(actual) !== JSON.stringify([...expected].sort((a, b) => a.relativePath.localeCompare(b.relativePath)))) fail("backup_payload_mismatch");
}
async function verifyReferences(options: RequirementBackupOptions, dataRoot: string, requirements: RequirementBackupRequirement[], identities: Map<string, { dev: number; ino: number }>): Promise<void> {
  const allowed = new Map<string, Set<string>>();
  for (const requirement of requirements) {
    const refs = [...new Map([requirement.saved, requirement.approved]
      .filter((value): value is RequirementBackupReference => value !== null)
      .map((reference) => [`${reference.commit}:${reference.prdHash}`, reference])).values()];
    allowed.set(requirement.requirementId, new Set(refs.map((ref) => `${ref.commit}:${ref.prdHash}`)));
    for (const reference of refs) {
      const identity = identities.get(requirement.requirementId);
      if (!identity) fail("repository_identity_missing");
      await verifyVersion({
        dataRoot, repoId: options.repoId, requirementId: requirement.requirementId,
        worktreeRoots: [...options.worktreeRoots], expectedRepositoryIdentity: identity, commit: reference.commit, expectedHash: reference.prdHash,
        authorize: (check) => {
          const checkedHash = check.expectedHash ?? check.prdHash;
          if (check.action !== "verifyVersion" || !check.commit || !checkedHash || !allowed.get(requirement.requirementId)?.has(`${check.commit}:${checkedHash}`)) return false;
          return true;
        },
      });
    }
  }
}
function validateCompleted(log: BackupOperationLog, operationDirectory: string): RequirementBackupReceipt {
  if (log.phase !== "completed" || !log.manifestHash) fail("backup_not_completed");
  const manifestPath = join(operationDirectory, MANIFEST_FILE);
  const bytes = readPrivateBytes(manifestPath, "manifest_invalid");
  if (sha256(bytes) !== log.manifestHash) fail("manifest_changed");
  let manifest: RequirementBackupManifest;
  try { manifest = JSON.parse(bytes.toString("utf8")) as RequirementBackupManifest; } catch { fail("manifest_invalid"); }
  if (!manifest || typeof manifest !== "object" || !exactKeys(manifest, ["format", "operationId", "repoId", "registrationHash", "stateSource", "database", "requirements", "files"]) || manifest.format !== FORMAT || manifest.operationId !== log.operationId || manifest.repoId !== log.repoId || manifest.registrationHash !== log.registrationHash || manifest.stateSource !== "data.db:requirements" || !manifest.database || !exactKeys(manifest.database, ["relativePath", "size", "hash"]) || manifest.database.relativePath !== "data.db" || !Number.isSafeInteger(manifest.database.size) || manifest.database.size < 0 || !HASH.test(manifest.database.hash) || !Array.isArray(manifest.files) || manifest.files.some((file) => !file || !exactKeys(file, ["relativePath", "size", "hash"]) || typeof file.relativePath !== "string" || !Number.isSafeInteger(file.size) || file.size < 0 || !HASH.test(file.hash)) || !Array.isArray(manifest.requirements) || manifest.requirements.some((item) => !item || !exactKeys(item, ["requirementId", "recordVersion", "lifecycle", "recovery", "epoch", "revision", "saved", "approved"]) || !UUID_V7_PATTERN.test(item.requirementId) || !Number.isSafeInteger(item.recordVersion) || item.recordVersion < 1 || !["draft", "active", "closing", "closed"].includes(item.lifecycle) || !["ready", "needs_review"].includes(item.recovery) || !Number.isSafeInteger(item.epoch) || item.epoch < 1 || !Number.isSafeInteger(item.revision) || item.revision < 0 || [item.saved, item.approved].some((ref) => ref !== null && (!exactKeys(ref, ["commit", "prdHash"]) || !COMMIT.test(ref.commit) || !/^sha256:[0-9a-f]{64}$/.test(ref.prdHash))))) fail("manifest_invalid");
  const payload = join(operationDirectory, "payload");
  assertExactPayload(payload, manifest.files);
  return { operationId: log.operationId, repoId: log.repoId, state: "completed", executable: false, backupDirectory: operationDirectory, manifestPath, manifestHash: log.manifestHash, databaseHash: manifest.database.hash, filesCopied: manifest.files.length, requirements: manifest.requirements };
}

/**
 * 在数据库维护许可内取得data.db一致快照，并按原始字节复制所有已登记需求仓库。
 * 返回值和manifest只有hash、大小、状态与提交引用，不包含PRD正文或Git对象字节。
 */
export async function createRequirementBackup(options: RequirementBackupOptions): Promise<RequirementBackupReceipt> {
  if (!options || !UUID_V7_PATTERN.test(options.operationId) || !Array.isArray(options.worktreeRoots) || options.worktreeRoots.length === 0) fail("invalid_options");
  const repo = assertRepoDirectory(options.repoDirectory, options.repoId);
  const dataPath = join(repo.path, "data.db");
  if (!pathExists(dataPath)) fail("data_database_missing");
  try {
    new RequirementWriteCoordinator({ dataRoot: repo.dataRoot, repoId: options.repoId }).assertQuiescent();
  } catch {
    fail("requirement_write_busy");
  }
  return withDatabaseMaintenance({ directory: repo.path, worktreeRoots: [...options.worktreeRoots], operationId: options.operationId }, async (permit) => {
    if (databaseMaintenanceDirectory(permit) !== repo.path) fail("maintenance_scope_changed");
    const backups = ensurePrivateChild(repo.path, "backups");
    const family = ensurePrivateChild(backups, "requirement-backups");
    const operationDirectory = join(family, options.operationId);
    const operationPath = join(operationDirectory, OPERATION_FILE);
    let log: BackupOperationLog;
    if (pathExists(operationDirectory)) {
      privateDirectory(operationDirectory, "operation_directory_invalid");
      if (!pathExists(operationPath)) fail("operation_conflict");
      log = parseOperation(operationPath);
      if (log.operationId !== options.operationId || log.repoId !== options.repoId || !sameIdentity(repo.identity, { dev: log.repoDevice, ino: log.repoInode })) fail("operation_conflict");
      if (log.phase === "completed") {
        inspectState(dataPath, options.repoId);
        return validateCompleted(log, operationDirectory);
      }
    } else {
      mkdirSync(operationDirectory, { mode: 0o700 }); syncDirectory(family);
      const registration = { operationId: options.operationId, repoId: options.repoId, repoDevice: repo.identity.dev, repoInode: repo.identity.ino };
      log = { format: OPERATION_FORMAT, ...registration, registrationHash: registrationHash(registration), phase: "prepared" };
      writeNewPrivate(operationPath, JSON.stringify(sealOperationLog(log))); syncDirectory(operationDirectory);
      log = parseOperation(operationPath);
    }
    const state = inspectState(dataPath, options.repoId);
    await verifyReferences(options, repo.dataRoot, state.requirements, state.identities);
    const sourceFiles = sourceFilePlans(repo.path, state.requirements);
    const sourceFingerprint = sha256(JSON.stringify({ state: state.fingerprint, files: plansFingerprint(sourceFiles) }));
    if (log.sourceFingerprint !== undefined && log.sourceFingerprint !== sourceFingerprint) fail("source_changed");
    if (log.phase === "prepared") log = saveOperation(operationPath, operationDirectory, log, { ...log, phase: "inspected", sourceFingerprint });

    let snapshotPath: string;
    if (log.snapshotRelativePath) {
      snapshotPath = join(repo.path, ...log.snapshotRelativePath.split("/"));
      if (!contained(backups, realpathSync(snapshotPath)) || basename(snapshotPath) !== "data.db") fail("snapshot_path_invalid");
      const snapshot = fingerprintPrivateFile(snapshotPath);
      if (snapshot.hash !== log.snapshotHash) fail("snapshot_changed");
    } else {
      const snapshot = createDatabaseSnapshot(permit, "data");
      snapshotPath = snapshot.snapshotPath;
      const relativePath = relative(repo.path, snapshotPath).split(sep).join("/");
      if (!contained(backups, realpathSync(snapshotPath)) || !HASH.test(snapshot.snapshotHash)) fail("snapshot_path_invalid");
      log = saveOperation(operationPath, operationDirectory, log, { ...log, phase: "snapshotted", snapshotRelativePath: relativePath, snapshotHash: snapshot.snapshotHash });
    }
    inspectState(snapshotPath, options.repoId);

    const payloadTemporary = pathExists(join(operationDirectory, "payload")) ? join(operationDirectory, "payload") : ensurePrivateChild(operationDirectory, "payload.tmp");
    if (log.phase === "inspected" || log.phase === "snapshotted") log = saveOperation(operationPath, operationDirectory, log, { ...log, phase: "copying" });
    const snapshotPlan = scanFile(snapshotPath, "data.db");
    if (snapshotPlan.hash !== log.snapshotHash) fail("snapshot_changed");
    const allPlans = [snapshotPlan, ...sourceFiles];
    for (const plan of allPlans) copyPlan(plan, payloadTemporary);
    const files = plansMetadata(allPlans);
    assertExactPayload(payloadTemporary, files);
    const afterState = inspectState(dataPath, options.repoId);
    const afterFiles = sourceFilePlans(repo.path, afterState.requirements);
    const afterFingerprint = sha256(JSON.stringify({ state: afterState.fingerprint, files: plansFingerprint(afterFiles) }));
    if (afterFingerprint !== sourceFingerprint) fail("source_changed");
    await verifyReferences(options, repo.dataRoot, afterState.requirements, afterState.identities);
    if (basename(payloadTemporary) === "payload.tmp") { renameSync(payloadTemporary, join(operationDirectory, "payload")); syncDirectory(operationDirectory); }
    if (log.phase !== "copied") log = saveOperation(operationPath, operationDirectory, log, { ...log, phase: "copied" });

    const database = files.find((file) => file.relativePath === "data.db");
    if (!database) fail("snapshot_missing");
    const manifest: RequirementBackupManifest = { format: FORMAT, operationId: options.operationId, repoId: options.repoId, registrationHash: log.registrationHash, stateSource: "data.db:requirements", database, requirements: state.requirements, files };
    const manifestPath = join(operationDirectory, MANIFEST_FILE);
    const manifestBytes = Buffer.from(JSON.stringify(manifest));
    const manifestHash = sha256(manifestBytes);
    if (pathExists(manifestPath)) {
      if (!readPrivateBytes(manifestPath, "manifest_invalid").equals(manifestBytes)) fail("manifest_conflict");
    } else { writeNewPrivate(manifestPath, manifestBytes); syncDirectory(operationDirectory); }
    const finalState = inspectState(dataPath, options.repoId);
    const finalFiles = sourceFilePlans(repo.path, finalState.requirements);
    const finalFingerprint = sha256(JSON.stringify({ state: finalState.fingerprint, files: plansFingerprint(finalFiles) }));
    if (finalFingerprint !== sourceFingerprint) fail("source_changed");
    log = saveOperation(operationPath, operationDirectory, log, { ...log, phase: "completed", manifestHash });
    return validateCompleted(log, operationDirectory);
  });
}

export const requirementBackupFiles = Object.freeze({ manifest: MANIFEST_FILE, operation: OPERATION_FILE, format: FORMAT, operationFormat: OPERATION_FORMAT });
