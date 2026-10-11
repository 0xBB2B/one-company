import { execFile } from "node:child_process";
import { adviceOf } from "./tool-failure.ts";
import type { FailureAdvice } from "./tool-failure.ts";
import { createHash, randomBytes } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, stat, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const PROD_FILE = "prod.md";
const GIT_DIR = ".git";
const INTERNAL_NAME = "pi prod storage";
const INTERNAL_EMAIL = "pi-prod-storage@localhost";
const GIT_TIMEOUT_MS = 10_000;
const GIT_MAX_BUFFER = 64 * 1024 * 1024;
const UUID_V7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?![\s\S])/;
const SAFE_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}(?![\s\S])/;
const FULL_COMMIT_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})(?![\s\S])/;
const OBJECT_ID_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const HASH_RE = /^sha256:[0-9a-f]{64}(?![\s\S])/;
const SAFE_PARTIAL_GIT_ENTRIES = new Set(["HEAD", "config", "description", "objects", "refs"]);

export type ProdStorageAction = "create" | "updateDraft" | "confirmUpdate";
export type ProdStorageInterfaceAction = "create" | "save" | "readVersion" | "diffVersions" | "verifyVersion";
export type ProdStoragePermissionPhase = "beforeAction" | "beforeWrite" | "beforeReturn" | "beforeReturnBody";

export interface ProdStoragePermissionCheck {
  phase: ProdStoragePermissionPhase;
  action: ProdStorageInterfaceAction;
  repoId: string;
  requirementId: string;
  operationId?: string;
  commit?: string;
  fromCommit?: string;
  toCommit?: string;
  expectedParent?: string | null;
  prodHash?: string;
  expectedHash?: string;
  expectedFromHash?: string;
  expectedToHash?: string;
}

export type ProdStorageAuthorize = (check: ProdStoragePermissionCheck) => unknown;

export interface ProdRepositoryIdentity {
  dev: number;
  ino: number;
}

export interface ProdStorageConfig {
  dataRoot: string;
  repoId: string;
  requirementId: string;
  repositoryRoot?: string;
  worktreeRoots?: string[];
  expectedRepositoryIdentity?: ProdRepositoryIdentity;
  authorize?: ProdStorageAuthorize;
}

export interface ProdStorageSaveInput extends ProdStorageConfig {
  operationId: string;
  expectedParent: string | null;
  bytes: Uint8Array;
}

export interface ProdStorageWriteResult {
  status: "created" | "saved" | "unchanged" | "recovered";
  action: ProdStorageAction;
  operationId: string;
  commit: string;
  parent: string | null;
  prodHash: `sha256:${string}`;
  changed: boolean;
  repositoryRoot: string;
  repositoryIdentity: ProdRepositoryIdentity;
}

export interface ProdStorageReadInput extends ProdStorageConfig {
  commit: string;
  expectedHash: `sha256:${string}`;
}

export interface ProdStorageReadResult {
  commit: string;
  prodHash: `sha256:${string}`;
  bytes: Uint8Array;
}

export interface ProdStorageDiffInput extends ProdStorageConfig {
  fromCommit: string;
  toCommit: string;
  expectedFromHash: `sha256:${string}`;
  expectedToHash: `sha256:${string}`;
}

export interface ProdStorageDiffResult {
  fromCommit: string;
  toCommit: string;
  fromHash: `sha256:${string}`;
  toHash: `sha256:${string}`;
  diff: string;
}

export interface ProdStorageVerifyInput extends ProdStorageConfig {
  commit: string;
  expectedHash: `sha256:${string}`;
}

export interface ProdStorageVerifyResult {
  ok: true;
  commit: string;
  prodHash: `sha256:${string}`;
  repositoryRoot: string;
  repositoryIdentity: ProdRepositoryIdentity;
}

function prodStorageNext(code: string): string {
  if (code === "operation_conflict") return "换一个新生成的操作编号重试";
  if (code === "recovery_required") return "停止操作，请用户在主窗口完成恢复核对";
  if (code === "unknown_version") return "核对版本号，按需求当前的版本重新指定";
  if (/^git_|^data_root_|^unsafe_|permission_denied|invalid_config|path_escape|external_/u.test(code)) return "请用户检查本机 Git 与数据目录的安装、权限和链接";
  if (/_mismatch$|_changed$/u.test(code)) return "需求版本库与记录不一致：停止操作，把这段原因告诉用户";
  return "按原因改正后重试；仍然失败就把这段原因告诉用户";
}
export class ProdStorageError extends Error {
  readonly code: string;
  readonly metadata: Record<string, string | number | boolean | null>;

  get advice(): FailureAdvice { return { why: this.message, next: prodStorageNext(this.code) }; }
  constructor(code: string, message: string, metadata: Record<string, string | number | boolean | null> = {}) {
    super(message);
    this.name = "ProdStorageError";
    this.code = code;
    this.metadata = metadata;
  }
}

interface PreparedPaths {
  dataRoot: string;
  requirementRoot: string;
  prodPath: string;
}

interface GitResult {
  stdout: Buffer;
  stderr: Buffer;
  exitCode: number;
}

interface CommitMetadata {
  action: ProdStorageAction;
  operationId: string;
  prodHash: `sha256:${string}`;
  parents: string[];
}

interface VerifiedCommit {
  metadata: CommitMetadata;
  bytes: Buffer;
  prodHash: `sha256:${string}`;
}

type ProdFileSnapshot =
  | { exists: false }
  | {
    exists: true;
    dev: number;
    ino: number;
    prodHash: `sha256:${string}`;
    bytes: Buffer;
  };

interface ManagedIndexSnapshot {
  blob: string | null;
}

type OwnedObjectKind = "directory" | "file";

interface OwnedObjectIdentity {
  dev: number;
  ino: number;
  uid: number;
  nlink: number;
}

interface OwnedDirectory {
  path: string;
  identity: OwnedObjectIdentity;
}

function fail(code: string, message: string, metadata: Record<string, string | number | boolean | null> = {}): never {
  throw new ProdStorageError(code, message, metadata);
}

function requireAuthorized(config: ProdStorageConfig, check: Omit<ProdStoragePermissionCheck, "repoId" | "requirementId">): void {
  if (!config.authorize) fail("permission_denied", "正文存储权限未授权");
  let result: unknown;
  try {
    result = config.authorize({ ...check, repoId: config.repoId, requirementId: config.requirementId });
  } catch (error) {
    // 授权回调抛出的是调用方程序生成的拒绝，带上它的原因，免得只剩「核验失败」
    const why = adviceOf(error)?.why;
    fail("permission_denied", why ? `正文存储权限核验失败：${why}` : "正文存储权限核验失败");
  }
  if ((typeof result === "object" && result !== null) || typeof result === "function") {
    let then: unknown;
    try { then = (result as { then?: unknown }).then; }
    catch { fail("permission_denied", "正文存储权限核验失败"); }
    if (typeof then === "function") {
      void Promise.resolve(result).catch(() => undefined);
      fail("permission_denied", "正文存储授权回调必须同步返回");
    }
  }
  if (result !== true) fail("permission_denied", "正文存储权限被拒绝");
}

function assertSafeSegment(name: string, value: string): void {
  if (!SAFE_SEGMENT_RE.test(value) || value === "." || value === "..") fail("invalid_config", `${name} 不是安全路径片段`);
}

function assertRequirementId(requirementId: string): void {
  if (!UUID_V7_RE.test(requirementId)) fail("invalid_requirement_id", "requirementId 必须是小写 UUIDv7");
}

function assertFullCommit(commit: string, name = "commit"): void {
  if (!FULL_COMMIT_RE.test(commit)) fail("invalid_commit", `${name} 必须是完整提交哈希`);
}

function assertHash(hash: string): asserts hash is `sha256:${string}` {
  if (!HASH_RE.test(hash)) fail("hash_mismatch", "prod hash 格式无效");
}

function sha256(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function pathInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !rel.includes(`..${sep}`) && !isAbsolute(rel));
}

function errno(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

function ownedObjectIdentity(stats: Stats): OwnedObjectIdentity {
  return { dev: stats.dev, ino: stats.ino, uid: stats.uid, nlink: stats.nlink };
}

// 目录的链接数随目录内条目增减而变（别的进程写同一目录时会变），不能算身份；文件的链接数用来防硬链接，照旧核对
function sameOwnedObjectIdentity(a: OwnedObjectIdentity, b: OwnedObjectIdentity, kind: OwnedObjectKind): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.uid === b.uid && (kind === "directory" || a.nlink === b.nlink);
}

function assertOwnedObject(stats: Stats, kind: OwnedObjectKind, code: string, message: string): void {
  const correctType = kind === "directory" ? stats.isDirectory() : stats.isFile();
  if (stats.isSymbolicLink() || !correctType) fail(code, message);
  if (kind === "file" && stats.nlink !== 1) fail(code, message);
  if (kind === "directory" && stats.nlink < 1) fail(code, message);
  if (typeof process.getuid === "function" && stats.uid !== process.getuid()) fail("unsafe_owner", "正文存储对象不属于当前用户");
}

function failOpenedPathRace(error: unknown, code: string, message: string): never {
  if (["ENOENT", "ELOOP", "ENOTDIR"].includes(errno(error) ?? "")) fail(code, message);
  throw error;
}

async function assertPathStillOwnedObject(path: string, expected: OwnedObjectIdentity, kind: OwnedObjectKind, code: string, message: string): Promise<void> {
  let stats: Stats;
  try { stats = await lstat(path); }
  catch (error) { failOpenedPathRace(error, code, message); }
  assertOwnedObject(stats, kind, code, message);
  if (!sameOwnedObjectIdentity(ownedObjectIdentity(stats), expected, kind)) fail(code, message);
}

async function assertOwnedDirectories(parents: readonly OwnedDirectory[], code: string, message: string): Promise<void> {
  for (const parent of parents) {
    let current: Stats;
    try { current = await lstat(parent.path); }
    catch (error) { failOpenedPathRace(error, code, message); }
    assertOwnedObject(current, "directory", code, message);
    if (current.dev !== parent.identity.dev || current.ino !== parent.identity.ino || current.uid !== parent.identity.uid) fail(code, message);
  }
}

async function chmodOpenedObject(path: string, observed: Stats, kind: OwnedObjectKind, mode: number, code: string, message: string, parents: readonly OwnedDirectory[] = []): Promise<OwnedObjectIdentity> {
  await assertOwnedDirectories(parents, code, message);
  assertOwnedObject(observed, kind, code, message);
  let handle;
  try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { failOpenedPathRace(error, code, message); }
  try {
    const opened = await handle.stat();
    assertOwnedObject(opened, kind, code, message);
    const expected = ownedObjectIdentity(observed);
    const openedIdentity = ownedObjectIdentity(opened);
    if (!sameOwnedObjectIdentity(openedIdentity, expected, kind)) fail(code, message);
    await assertOwnedDirectories(parents, code, message);
    await assertPathStillOwnedObject(path, openedIdentity, kind, code, message);
    await handle.chmod(mode);
    const hardened = await handle.stat();
    assertOwnedObject(hardened, kind, code, message);
    if (!sameOwnedObjectIdentity(ownedObjectIdentity(hardened), openedIdentity, kind)) fail(code, message);
    await assertPathStillOwnedObject(path, openedIdentity, kind, code, message);
    return openedIdentity;
  } finally {
    await handle.close();
  }
}

async function realpathIfExists(path: string): Promise<string | undefined> {
  try { return await realpath(path); }
  catch (error) {
    if (errno(error) === "ENOENT") return undefined;
    throw error;
  }
}

async function assertNoUntrustedSymlinkAncestors(path: string): Promise<void> {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  const parts = absolute.slice(root.length).split(sep).filter(Boolean);
  let current = root;
  for (const part of parts) {
    current = join(current, part);
    try {
      const stats = await lstat(current);
      if (stats.isSymbolicLink()) {
        if (typeof process.getuid !== "function" || stats.uid !== 0) fail("unsafe_path", "正文存储路径祖先不能经过用户可替换的软链接");
        continue;
      }
      if (!stats.isDirectory() && current !== absolute) fail("unsafe_path", "正文存储路径祖先必须是目录");
    } catch (error) {
      if (errno(error) !== "ENOENT") throw error;
    }
  }
}

async function canonicalCandidate(path: string): Promise<string> {
  const absolute = resolve(path);
  let existing = absolute;
  const missing: string[] = [];
  while (!(await realpathIfExists(existing))) {
    const parent = dirname(existing);
    if (parent === existing) fail("unsafe_path", "无法解析正文存储路径");
    missing.unshift(basename(existing));
    existing = parent;
  }
  const realExisting = await realpath(existing);
  return join(realExisting, ...missing);
}

async function preparePaths(config: ProdStorageConfig, allowCreateDataRoot: boolean): Promise<PreparedPaths> {
  if (!isAbsolute(config.dataRoot)) fail("invalid_config", "dataRoot 必须是绝对路径");
  assertSafeSegment("repoId", config.repoId);
  assertRequirementId(config.requirementId);
  const protectedRoots = [config.repositoryRoot, ...(config.worktreeRoots ?? [])].filter((path): path is string => path !== undefined);
  for (const protectedRoot of protectedRoots) {
    if (!isAbsolute(protectedRoot)) fail("invalid_config", "repositoryRoot/worktreeRoots 必须是绝对路径");
  }
  await assertNoUntrustedSymlinkAncestors(config.dataRoot);

  const dataCandidate = await canonicalCandidate(config.dataRoot);
  for (const protectedRoot of protectedRoots) {
    await assertNoUntrustedSymlinkAncestors(protectedRoot);
    const protectedCandidate = await canonicalCandidate(protectedRoot);
    if (pathInside(protectedCandidate, dataCandidate) || pathInside(dataCandidate, protectedCandidate)) {
      fail("data_root_in_workspace", "dataRoot 不能位于业务仓库或 worktree 内，也不能包含业务仓库");
    }
  }

  if (allowCreateDataRoot) await mkdir(dataCandidate, { recursive: true, mode: 0o700 });
  const dataRoot = await realpathIfExists(dataCandidate);
  if (!dataRoot) fail("data_root_missing", "dataRoot 不存在");
  const dataRootStats = await lstat(dataRoot);
  await chmodOpenedObject(dataRoot, dataRootStats, "directory", 0o700, "unsafe_path", "dataRoot 在权限收紧期间发生变化或不是自有目录");

  const requirementRoot = join(dataRoot, "repos", config.repoId, "requirements", config.requirementId);
  if (!pathInside(dataRoot, requirementRoot)) fail("path_escape", "需求正文路径越过 dataRoot");
  await assertNoUntrustedSymlinkAncestors(requirementRoot);
  return { dataRoot, requirementRoot, prodPath: join(requirementRoot, PROD_FILE) };
}

async function ensurePrivateDirectoryChain(dataRoot: string, requirementRoot: string): Promise<void> {
  const rel = relative(dataRoot, requirementRoot);
  if (rel.startsWith("..") || isAbsolute(rel)) fail("path_escape", "需求正文路径越过 dataRoot");
  let current = dataRoot;
  const rootStats = await lstat(dataRoot);
  assertOwnedObject(rootStats, "directory", "unsafe_path", "正文存储根目录身份无效");
  const parents: OwnedDirectory[] = [{ path: dataRoot, identity: ownedObjectIdentity(rootStats) }];
  for (const segment of rel.split(sep).filter(Boolean)) {
    await assertOwnedDirectories(parents, "unsafe_path", "正文存储父目录身份已变化");
    current = join(current, segment);
    try { await mkdir(current, { mode: 0o700 }); }
    catch (error) { if (errno(error) !== "EEXIST") throw error; }
    const stats = await lstat(current);
    const identity = await chmodOpenedObject(current, stats, "directory", 0o700, "unsafe_path", "正文存储目录链在权限收紧期间发生变化或包含链接、非目录", parents);
    parents.push({ path: current, identity });
  }
}

async function assertCurrentUser(statsPath: string): Promise<void> {
  if (typeof process.getuid !== "function") return;
  const stats = await lstat(statsPath);
  if (stats.uid !== process.getuid()) fail("unsafe_owner", "正文存储路径不属于当前用户");
}

function assertRegularOwnedFile(stats: Stats): void {
  if (!stats.isFile()) fail("unsafe_path", "正文路径必须是普通文件");
  if (stats.nlink !== 1) fail("unsafe_path", "拒绝硬链接正文文件");
  if (typeof process.getuid === "function" && stats.uid !== process.getuid()) fail("unsafe_owner", "正文文件不属于当前用户");
}

async function readFileSnapshot(path: string): Promise<ProdFileSnapshot> {
  let handle;
  try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) {
    if (errno(error) === "ENOENT") return { exists: false };
    if (errno(error) === "ELOOP") fail("unsafe_path", "拒绝软链接正文文件");
    throw error;
  }
  try {
    const openedStats = await handle.stat();
    assertRegularOwnedFile(openedStats);
    const bytes = await handle.readFile();
    const pathStats = await lstat(path);
    if (pathStats.isSymbolicLink() || pathStats.dev !== openedStats.dev || pathStats.ino !== openedStats.ino) {
      fail("working_copy_changed", "读取正文期间文件身份发生变化");
    }
    assertRegularOwnedFile(pathStats);
    return { exists: true, dev: openedStats.dev, ino: openedStats.ino, prodHash: sha256(bytes), bytes };
  } finally {
    await handle.close();
  }
}

async function readProdIfExists(path: string): Promise<Buffer | undefined> {
  const snapshot = await readFileSnapshot(path);
  return snapshot.exists ? snapshot.bytes : undefined;
}

function sameFileSnapshot(actual: ProdFileSnapshot, expected: ProdFileSnapshot): boolean {
  if (actual.exists !== expected.exists) return false;
  if (!actual.exists || !expected.exists) return true;
  return actual.dev === expected.dev && actual.ino === expected.ino && actual.prodHash === expected.prodHash;
}

async function assertFileSnapshot(path: string, expected: ProdFileSnapshot): Promise<void> {
  const actual = await readFileSnapshot(path);
  if (!sameFileSnapshot(actual, expected)) fail("working_copy_changed", "prod.md 在授权核对后被外部替换或修改，拒绝覆盖");
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, "r");
  try { await directory.sync(); }
  catch (error) { if (errno(error) !== "EINVAL" && errno(error) !== "ENOTSUP") throw error; }
  finally { await directory.close(); }
}

async function assertNoUnverifiedTemporaryFiles(requirementRoot: string): Promise<void> {
  const pending = (await readdir(requirementRoot)).filter((entry) => entry.startsWith(".prod-storage-") && entry.endsWith(".tmp"));
  if (pending.length > 0) {
    fail("recovery_required", "发现没有可信持久操作记录可核对的正文临时文件，已保留并等待人工复核", { count: pending.length });
  }
}

async function assertOnlyProdAndGit(requirementRoot: string): Promise<void> {
  let entries: string[];
  try { entries = await readdir(requirementRoot); }
  catch (error) {
    if (errno(error) === "ENOENT") return;
    throw error;
  }
  const extras = entries.filter((entry) => entry !== PROD_FILE && entry !== GIT_DIR);
  if (extras.length > 0) fail("external_content", "需求正文仓库含有 prod.md 之外的文件", { count: extras.length });
}

async function assertGitDirectory(requirementRoot: string, required: boolean): Promise<boolean> {
  const gitPath = join(requirementRoot, GIT_DIR);
  let stats;
  try { stats = await lstat(gitPath); }
  catch (error) {
    if (errno(error) === "ENOENT") {
      if (required) fail("git_missing", "已登记版本仓库缺失 .git，拒绝补建空库");
      return false;
    }
    throw error;
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) fail("git_invalid", ".git 必须是本目录自有目录，不能是 gitfile 或链接");
  if (typeof process.getuid === "function" && stats.uid !== process.getuid()) fail("unsafe_owner", ".git 不属于当前用户");
  return true;
}

async function assertPartialGitSafe(requirementRoot: string): Promise<void> {
  const gitPath = join(requirementRoot, GIT_DIR);
  for (const entry of await readdir(gitPath)) {
    if (!SAFE_PARTIAL_GIT_ENTRIES.has(entry)) fail("git_invalid", "中断的 .git 含未知资料，拒绝自动修复");
    const stats = await lstat(join(gitPath, entry));
    if (stats.isSymbolicLink()) fail("git_invalid", "中断的 .git 含路径链接，拒绝自动修复");
  }
}

async function repositoryIdentity(requirementRoot: string): Promise<ProdRepositoryIdentity> {
  const stats = await stat(join(requirementRoot, GIT_DIR));
  return { dev: stats.dev, ino: stats.ino };
}

function sameIdentity(a: ProdRepositoryIdentity, b: ProdRepositoryIdentity): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

async function assertRepositoryIdentity(config: ProdStorageConfig, requirementRoot: string): Promise<ProdRepositoryIdentity> {
  const identity = await repositoryIdentity(requirementRoot);
  if (config.expectedRepositoryIdentity && !sameIdentity(config.expectedRepositoryIdentity, identity)) {
    fail("repository_identity_mismatch", "需求仓库身份与绑定信息不一致");
  }
  return identity;
}

function gitEnvironment(config: ProdStorageConfig, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const nullDevice = process.platform === "win32" ? "NUL" : "/dev/null";
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "",
    HOME: config.dataRoot,
    XDG_CONFIG_HOME: join(config.dataRoot, ".config-disabled"),
    LC_ALL: "C",
    LANG: "C",
    GIT_CONFIG_GLOBAL: nullDevice,
    GIT_CONFIG_SYSTEM: nullDevice,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: nullDevice,
    SSH_ASKPASS: nullDevice,
    GIT_PAGER: "cat",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_AUTHOR_NAME: INTERNAL_NAME,
    GIT_AUTHOR_EMAIL: INTERNAL_EMAIL,
    GIT_COMMITTER_NAME: INTERNAL_NAME,
    GIT_COMMITTER_EMAIL: INTERNAL_EMAIL,
    ...extra,
  };
  if (process.platform === "win32") {
    env.SystemRoot = process.env.SystemRoot;
    env.ComSpec = process.env.ComSpec;
  }
  return env;
}

function fixedGitArgs(requirementRoot: string, args: string[], repository = true): string[] {
  return [
    "--literal-pathspecs",
    "-c", "core.hooksPath=/dev/null",
    "-c", "core.fsmonitor=false",
    "-c", "core.untrackedCache=false",
    "-c", "core.attributesFile=/dev/null",
    "-c", "core.excludesFile=/dev/null",
    "-c", "commit.gpgSign=false",
    "-c", "tag.gpgSign=false",
    "-c", "log.showSignature=false",
    "-c", "diff.external=",
    "-c", "interactive.diffFilter=",
    "-c", "protocol.allow=never",
    ...(repository ? [`--git-dir=${join(requirementRoot, GIT_DIR)}`, `--work-tree=${requirementRoot}`] : []),
    ...args,
  ];
}

async function runGit(config: ProdStorageConfig, paths: PreparedPaths, args: string[], options: {
  input?: string | Buffer;
  env?: Record<string, string>;
  allowedExitCodes?: number[];
  maxBuffer?: number;
  repository?: boolean;
} = {}): Promise<GitResult> {
  const child = execFileAsync("git", fixedGitArgs(paths.requirementRoot, args, options.repository !== false), {
    cwd: paths.requirementRoot, env: gitEnvironment(config, options.env), encoding: "buffer",
    timeout: GIT_TIMEOUT_MS, maxBuffer: options.maxBuffer ?? GIT_MAX_BUFFER, killSignal: "SIGKILL",
  });
  if (options.input !== undefined) {
    child.child.stdin?.on("error", () => undefined);
    child.child.stdin?.end(options.input);
  } else child.child.stdin?.end();
  let result: GitResult;
  try {
    const completed = await child;
    result = { stdout: completed.stdout, stderr: completed.stderr, exitCode: 0 };
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { stdout?: Buffer; stderr?: Buffer; code?: string | number; killed?: boolean; signal?: string | null };
    if (failure.code === "ENOENT") fail("git_unavailable", "Git 可执行文件不可用");
    if (typeof failure.code !== "number" || failure.killed || failure.signal) fail("git_failed", "Git 子进程执行失败");
    result = { stdout: failure.stdout ?? Buffer.alloc(0), stderr: failure.stderr ?? Buffer.alloc(0), exitCode: failure.code };
  }
  if (!(options.allowedExitCodes ?? [0]).includes(result.exitCode)) fail("git_failed", "Git 调用失败", { exitCode: result.exitCode });
  return result;
}

async function assertGitTreeSafe(path: string): Promise<void> {
  const stats = await lstat(path);
  if (stats.isSymbolicLink()) fail("git_invalid", ".git 内不能包含路径链接");
  if (typeof process.getuid === "function" && stats.uid !== process.getuid()) fail("unsafe_owner", ".git 内资料不属于当前用户");
  if (stats.isDirectory()) {
    for (const entry of await readdir(path)) await assertGitTreeSafe(join(path, entry));
  } else if (!stats.isFile() || stats.nlink !== 1) {
    fail("git_invalid", ".git 内只能包含独占的普通文件和目录");
  }
}

async function hardenGitPermissions(path: string, parents: readonly OwnedDirectory[] = []): Promise<void> {
  await assertOwnedDirectories(parents, "git_invalid", ".git 父目录在遍历期间发生变化");
  const stats = await lstat(path);
  if (stats.isDirectory()) {
    const identity = await chmodOpenedObject(path, stats, "directory", 0o700, "git_invalid", ".git 目录在权限收紧期间发生变化或包含路径链接、非目录", parents);
    const directories = [...parents, { path, identity }];
    const entries = await readdir(path);
    await assertOwnedDirectories(directories, "git_invalid", ".git 目录在遍历期间发生变化");
    for (const entry of entries) {
      await hardenGitPermissions(join(path, entry), directories);
      await assertOwnedDirectories(directories, "git_invalid", ".git 目录在遍历期间发生变化");
    }
  } else if (stats.isFile()) {
    await chmodOpenedObject(path, stats, "file", 0o600, "git_invalid", ".git 文件在权限收紧期间发生变化或不是独占普通文件", parents);
  } else {
    fail("git_invalid", ".git 内只能包含独占的普通文件和目录");
  }
}

async function assertRepositoryLayout(config: ProdStorageConfig, paths: PreparedPaths): Promise<void> {
  await assertGitDirectory(paths.requirementRoot, true);
  await assertGitTreeSafe(join(paths.requirementRoot, GIT_DIR));
  for (const unsafe of ["commondir", "gitdir", "shallow", join("info", "grafts"), join("objects", "info", "alternates")]) {
    if (await realpathIfExists(join(paths.requirementRoot, GIT_DIR, unsafe))) fail("git_invalid", "需求仓库含外部对象或共享仓库指向");
  }
  const top = (await runGit(config, paths, ["rev-parse", "--path-format=absolute", "--show-toplevel"])).stdout.toString("utf8").trim();
  const gitDir = (await runGit(config, paths, ["rev-parse", "--path-format=absolute", "--absolute-git-dir"])).stdout.toString("utf8").trim();
  const commonDir = (await runGit(config, paths, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).stdout.toString("utf8").trim();
  const bare = (await runGit(config, paths, ["rev-parse", "--is-bare-repository"])).stdout.toString("utf8").trim();
  if (await realpath(top) !== await realpath(paths.requirementRoot)) fail("git_invalid", "Git 根目录不是需求正文目录");
  const expectedGit = await realpath(join(paths.requirementRoot, GIT_DIR));
  if (await realpath(gitDir) !== expectedGit || await realpath(commonDir) !== expectedGit || bare !== "false") {
    fail("git_invalid", ".git 不是本目录独占的非裸仓库");
  }
  const branch = await runGit(config, paths, ["symbolic-ref", "-q", "HEAD"], { allowedExitCodes: [0, 1] });
  if (branch.exitCode !== 0 || branch.stdout.toString("utf8").trim() !== "refs/heads/main") fail("git_invalid", "需求仓库必须使用固定 main 分支");
}

async function initRepository(config: ProdStorageConfig, paths: PreparedPaths, mayResumeInitialOperation: boolean): Promise<void> {
  const exists = await assertGitDirectory(paths.requirementRoot, false);
  if (!exists) {
    if (await readProdIfExists(paths.prodPath)) fail("git_missing", "已有 prod.md 但缺少 .git，拒绝补建仓库");
  } else {
    try {
      await assertRepositoryLayout(config, paths);
      return;
    } catch (error) {
      if (!mayResumeInitialOperation) throw error;
      await assertPartialGitSafe(paths.requirementRoot);
      await assertGitTreeSafe(join(paths.requirementRoot, GIT_DIR));
    }
  }
  await runGit(config, paths, ["init", "-q", "-b", "main", "--template="], { repository: false });
  await hardenGitPermissions(join(paths.requirementRoot, GIT_DIR));
  await assertRepositoryLayout(config, paths);
}

async function currentHead(config: ProdStorageConfig, paths: PreparedPaths): Promise<string | null> {
  const result = await runGit(config, paths, ["rev-parse", "--verify", "--quiet", "HEAD"], { allowedExitCodes: [0, 1] });
  if (result.exitCode === 1) return null;
  const head = result.stdout.toString("utf8").trim();
  if (!FULL_COMMIT_RE.test(head)) fail("git_invalid", "HEAD 不是完整提交");
  return head;
}

async function assertOnlyMainRef(config: ProdStorageConfig, paths: PreparedPaths, head: string | null): Promise<void> {
  const refs = (await runGit(config, paths, ["for-each-ref", "--format=%(refname)%00%(objectname)"])).stdout.toString("utf8").split("\n").filter(Boolean);
  if (head === null) {
    if (refs.length !== 0) fail("git_invalid", "无提交仓库不能含其他引用");
    return;
  }
  if (refs.length !== 1 || refs[0] !== `refs/heads/main\0${head}`) fail("git_invalid", "需求仓库只能有指向 HEAD 的 main 引用");
}

async function repositoryProdBlob(config: ProdStorageConfig, paths: PreparedPaths, commit: string): Promise<string> {
  const entries = (await runGit(config, paths, ["ls-tree", "-r", "-z", commit])).stdout.toString("utf8").split("\0").filter(Boolean);
  if (entries.length !== 1) fail("tree_mismatch", "提交树只能包含 prod.md");
  const match = /^100644 blob ([0-9a-f]+)\tprod\.md$/.exec(entries[0]!);
  if (!match || !OBJECT_ID_RE.test(match[1]!)) fail("tree_mismatch", "提交中的 prod.md 必须是普通文件");
  return match[1]!;
}

async function managedIndexSnapshot(config: ProdStorageConfig, paths: PreparedPaths): Promise<ManagedIndexSnapshot> {
  const entries = (await runGit(config, paths, ["ls-files", "--stage", "-z"])).stdout.toString("utf8").split("\0").filter(Boolean);
  const extras = entries.filter((entry) => !entry.endsWith(`\t${PROD_FILE}`));
  if (extras.length > 0) fail("extra_index", "暂存区含有 prod.md 之外的路径", { count: extras.length });
  if (entries.length === 0) return { blob: null };
  if (entries.length !== 1) fail("external_index", "prod.md 暂存区含多个阶段或未知内容");
  const match = /^100644 ([0-9a-f]+) 0\tprod\.md$/.exec(entries[0]!);
  if (!match || !OBJECT_ID_RE.test(match[1]!)) fail("external_index", "prod.md 暂存内容不是固定普通文件");
  return { blob: match[1]! };
}

async function assertManagedIndexClean(config: ProdStorageConfig, paths: PreparedPaths, head: string | null): Promise<void> {
  const index = await managedIndexSnapshot(config, paths);
  const expectedBlob = head === null ? null : await repositoryProdBlob(config, paths, head);
  if (index.blob !== expectedBlob) fail("external_index", head === null ? "首次提交前暂存区必须为空" : "prod.md 暂存内容被外部修改");
}

async function recoverManagedIndex(config: ProdStorageConfig, paths: PreparedPaths, expectedParent: string | null, commit: string): Promise<void> {
  const index = await managedIndexSnapshot(config, paths);
  const committedBlob = await repositoryProdBlob(config, paths, commit);
  if (index.blob === committedBlob) {
    await hardenGitPermissions(join(paths.requirementRoot, GIT_DIR));
    return;
  }
  const parentBlob = expectedParent === null ? null : await repositoryProdBlob(config, paths, expectedParent);
  if (index.blob !== parentBlob) fail("external_index", "提交中断后的暂存区既不匹配旧父树，也不匹配本操作的新树，已保留外部内容");
  await runGit(config, paths, ["update-index", "--add", "--cacheinfo", `100644,${committedBlob},${PROD_FILE}`]);
  const repaired = await managedIndexSnapshot(config, paths);
  if (repaired.blob !== committedBlob) fail("external_index", "暂存区补齐后未匹配本操作提交树");
  await hardenGitPermissions(join(paths.requirementRoot, GIT_DIR));
}

async function showProd(config: ProdStorageConfig, paths: PreparedPaths, commit: string): Promise<Buffer> {
  assertFullCommit(commit);
  await repositoryProdBlob(config, paths, commit);
  return (await runGit(config, paths, ["show", `${commit}:${PROD_FILE}`])).stdout;
}

function exactIdentity(line: string, kind: "author" | "committer"): boolean {
  const escapedName = INTERNAL_NAME.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escapedEmail = INTERNAL_EMAIL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${kind} ${escapedName} <${escapedEmail}> [0-9]+ [+-][0-9]{4}$`).test(line);
}

async function parseCommitMetadata(config: ProdStorageConfig, paths: PreparedPaths, commit: string): Promise<CommitMetadata> {
  const raw = (await runGit(config, paths, ["cat-file", "-p", commit])).stdout.toString("utf8");
  const separator = raw.indexOf("\n\n");
  if (separator < 0) fail("message_mismatch", "提交缺少固定正文信息");
  const header = raw.slice(0, separator);
  const message = raw.slice(separator + 2);
  const lines = header.split("\n");
  const trees = lines.filter((line) => line.startsWith("tree "));
  const parents = lines.filter((line) => line.startsWith("parent ")).map((line) => line.slice(7));
  const authors = lines.filter((line) => line.startsWith("author "));
  const committers = lines.filter((line) => line.startsWith("committer "));
  if (trees.length !== 1 || !OBJECT_ID_RE.test(trees[0]!.slice(5)) || parents.some((parent) => !FULL_COMMIT_RE.test(parent)) || parents.length > 1) {
    fail("history_mismatch", "正文提交历史必须是单父线性历史");
  }
  if (authors.length !== 1 || committers.length !== 1 || !exactIdentity(authors[0]!, "author") || !exactIdentity(committers[0]!, "committer")) {
    fail("identity_mismatch", "正文提交身份不是固定内部服务身份");
  }
  if (lines.length !== trees.length + parents.length + authors.length + committers.length) fail("history_mismatch", "正文提交含非固定元数据");
  const escapedRequirement = config.requirementId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`^prod\\(${escapedRequirement}\\): (create|updateDraft|confirmUpdate)\\n\\nOperation-Id: ([A-Za-z0-9][A-Za-z0-9._-]{0,127})\\nProd-Hash: (sha256:[0-9a-f]{64})\\n(?![\\s\\S])`).exec(message);
  if (!match) fail("message_mismatch", "提交信息不符合固定正文格式");
  return { action: match[1] as ProdStorageAction, operationId: match[2]!, prodHash: match[3] as `sha256:${string}`, parents };
}

function assertCommitMetadataMatches(meta: CommitMetadata, expectedHash?: `sha256:${string}`, expectedParent?: string | null, operationId?: string, action?: ProdStorageAction): void {
  if (expectedHash && meta.prodHash !== expectedHash) fail("hash_mismatch", "提交信息中的 Prod-Hash 与期望 hash 不一致");
  if (operationId && meta.operationId !== operationId) fail("message_mismatch", "提交信息中的 Operation-Id 与操作不一致");
  if (action && meta.action !== action) fail("message_mismatch", "提交信息中的 action 与操作不一致");
  if (expectedParent !== undefined) {
    if (expectedParent === null && meta.parents.length !== 0) fail("parent_mismatch", "首次提交不应含父提交");
    if (expectedParent !== null && (meta.parents.length !== 1 || meta.parents[0] !== expectedParent)) fail("parent_mismatch", "提交父节点与 expectedParent 不一致");
  }
}

async function verifyCommitMatches(config: ProdStorageConfig, paths: PreparedPaths, commit: string, expectedHash?: `sha256:${string}`, expectedParent?: string | null, operationId?: string, action?: ProdStorageAction): Promise<VerifiedCommit> {
  const metadata = await parseCommitMetadata(config, paths, commit);
  assertCommitMetadataMatches(metadata, expectedHash, expectedParent, operationId, action);
  const bytes = await showProd(config, paths, commit);
  const prodHash = sha256(bytes);
  if (metadata.prodHash !== prodHash) fail("message_mismatch", "提交信息中的 Prod-Hash 与实际正文不一致");
  return { metadata, bytes, prodHash };
}

async function validatedLineage(config: ProdStorageConfig, paths: PreparedPaths, head: string | null): Promise<Map<string, string | null>> {
  await assertOnlyMainRef(config, paths, head);
  const lineage = new Map<string, string | null>();
  if (!head) return lineage;
  const rows = (await runGit(config, paths, ["rev-list", "--topo-order", "--parents", head])).stdout.toString("utf8").trim().split("\n").filter(Boolean);
  for (const row of rows) {
    const [commit, ...parents] = row.split(" ");
    if (!commit || !FULL_COMMIT_RE.test(commit) || parents.length > 1 || (parents[0] && !FULL_COMMIT_RE.test(parents[0]))) {
      fail("history_mismatch", "正文提交历史不是单条线性链");
    }
    lineage.set(commit, parents[0] ?? null);
  }
  if (!lineage.has(head)) fail("history_mismatch", "HEAD 不在正文提交历史中");
  for (const [commit, parent] of lineage) {
    if (parent !== null && !lineage.has(parent)) fail("history_mismatch", "正文提交父链不完整", { commit });
  }
  return lineage;
}

async function operationIdsInHistory(config: ProdStorageConfig, paths: PreparedPaths, head: string | null): Promise<Set<string>> {
  if (!head) return new Set();
  const messages = (await runGit(config, paths, ["log", "--format=%B%x00", head])).stdout.toString("utf8");
  const operationIds = new Set<string>();
  for (const match of messages.matchAll(/^Operation-Id: ([A-Za-z0-9][A-Za-z0-9._-]{0,127})$/gm)) operationIds.add(match[1]!);
  return operationIds;
}

async function assertWorktreeMatchesHash(prodPath: string, expectedHash: `sha256:${string}`): Promise<void> {
  const bytes = await readProdIfExists(prodPath);
  if (!bytes) fail("working_copy_mismatch", "prod.md 缺失，拒绝把版本记录当成当前正文");
  if (sha256(bytes) !== expectedHash) fail("working_copy_mismatch", "prod.md 含未登记的外部内容，拒绝覆盖或返回旧状态");
}

async function writeProdFile(requirementRoot: string, prodPath: string, bytes: Uint8Array, operationId: string, prodHash: `sha256:${string}`, expectedWorkingFile: ProdFileSnapshot): Promise<void> {
  const prepared = Buffer.from(bytes);
  if (expectedWorkingFile.exists && expectedWorkingFile.prodHash === prodHash) {
    await assertFileSnapshot(prodPath, expectedWorkingFile);
    return;
  }
  const temp = join(requirementRoot, `.prod-storage-${operationId}-${prodHash.slice("sha256:".length)}-${randomBytes(8).toString("hex")}.tmp`);
  const handle = await open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.chmod(0o600);
    await handle.writeFile(prepared);
    await handle.sync();
    await assertFileSnapshot(prodPath, expectedWorkingFile);
    // 文件系统没有可移植的“按身份比较后替换”原语；这里缩小并在替换后核对竞争窗口，但不能宣称外部程序绝不可能在两步之间改写。
    await rename(temp, prodPath);
    await syncDirectory(requirementRoot);
    const ownedStats = await handle.stat();
    assertRegularOwnedFile(ownedStats);
    if (ownedStats.size !== prepared.length || (ownedStats.mode & 0o077) !== 0) fail("write_mismatch", "自有正文临时文件的长度或权限不符合预期");
    const pathStats = await lstat(prodPath);
    if (pathStats.isSymbolicLink() || pathStats.dev !== ownedStats.dev || pathStats.ino !== ownedStats.ino) {
      fail("working_copy_changed", "prod.md 在原子替换后被外部替换，拒绝继续提交");
    }
    assertRegularOwnedFile(pathStats);
    const actual = Buffer.alloc(prepared.length);
    const read = await handle.read(actual, 0, actual.length, 0);
    if (read.bytesRead !== prepared.length || !prepared.equals(actual)) fail("write_mismatch", "落盘正文与准备正文不一致");
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function writeTreeCommit(config: ProdStorageConfig, paths: PreparedPaths, bytes: Uint8Array, action: ProdStorageAction, operationId: string, expectedParent: string | null, prodHash: `sha256:${string}`): Promise<string> {
  const gitRoot = join(paths.requirementRoot, GIT_DIR);
  const rootStats = await lstat(gitRoot);
  assertOwnedObject(rootStats, "directory", "git_invalid", "Git 目录身份无效");
  const directories = [{ path: gitRoot, identity: ownedObjectIdentity(rootStats) }];
  const indexFile = join(gitRoot, `prod-storage-index-${process.pid}-${randomBytes(8).toString("hex")}`);
  const treeEnv = { GIT_INDEX_FILE: indexFile };
  let indexIdentity: OwnedObjectIdentity | undefined;
  let failure: unknown;
  let failed = false;
  try {
    const blob = (await runGit(config, paths, ["hash-object", "-w", "--stdin", "--no-filters"], { input: Buffer.from(bytes) })).stdout.toString("utf8").trim();
    if (!OBJECT_ID_RE.test(blob)) fail("git_failed", "Git 未返回有效 blob");
    await runGit(config, paths, ["update-index", "--add", "--cacheinfo", `100644,${blob},${PROD_FILE}`], { env: treeEnv });
    const tree = (await runGit(config, paths, ["write-tree"], { env: treeEnv })).stdout.toString("utf8").trim();
    if (!OBJECT_ID_RE.test(tree)) fail("git_failed", "Git 未返回有效 tree");
    const indexStats = await lstat(indexFile);
    assertOwnedObject(indexStats, "file", "git_invalid", "临时 Git 索引身份无效");
    indexIdentity = ownedObjectIdentity(indexStats);
    const message = `prod(${config.requirementId}): ${action}\n\nOperation-Id: ${operationId}\nProd-Hash: ${prodHash}\n`;
    const commitArgs = expectedParent ? ["commit-tree", tree, "-p", expectedParent] : ["commit-tree", tree];
    const commit = (await runGit(config, paths, commitArgs, { input: message })).stdout.toString("utf8").trim();
    assertFullCommit(commit);
    if (expectedParent) await runGit(config, paths, ["update-ref", "HEAD", commit, expectedParent]);
    else await runGit(config, paths, ["update-ref", "HEAD", commit, "0".repeat(commit.length)]);
    await runGit(config, paths, ["update-index", "--add", "--cacheinfo", `100644,${blob},${PROD_FILE}`]);
    return commit;
  } catch (error) {
    failed = true;
    failure = error;
    throw error;
  } finally {
    const cleanupErrors: unknown[] = [];
    try { await hardenGitPermissions(gitRoot, directories); }
    catch (error) { cleanupErrors.push(error); }
    if (indexIdentity) {
      try {
        await assertOwnedDirectories(directories, "git_invalid", "Git 目录在清理期间发生变化");
        await assertPathStillOwnedObject(indexFile, indexIdentity, "file", "git_invalid", "临时 Git 索引已被替换，保留现场");
        await unlink(indexFile);
      } catch (error) { if (errno(error) !== "ENOENT") cleanupErrors.push(error); }
    }
    if (cleanupErrors.length) {
      if (!failed) throw cleanupErrors[0];
      if (failure instanceof ProdStorageError) failure.metadata.cleanupRequired = true;
      else throw new AggregateError([failure, ...cleanupErrors], "正文存储失败且收尾未完成");
    }
  }
}

async function ensureReadyForRead(config: ProdStorageConfig, interfaceAction: ProdStorageInterfaceAction, authorization: Omit<ProdStoragePermissionCheck, "phase" | "action" | "repoId" | "requirementId">): Promise<{ paths: PreparedPaths; identity: ProdRepositoryIdentity; head: string; lineage: Map<string, string | null> }> {
  requireAuthorized(config, { phase: "beforeAction", action: interfaceAction, ...authorization });
  const paths = await preparePaths(config, false);
  await assertGitDirectory(paths.requirementRoot, true);
  await assertRepositoryLayout(config, paths);
  const identity = await assertRepositoryIdentity(config, paths.requirementRoot);
  await assertOnlyProdAndGit(paths.requirementRoot);
  await assertCurrentUser(paths.requirementRoot);
  const head = await currentHead(config, paths);
  if (!head) fail("git_invalid", "正文仓库尚无首个提交");
  await assertManagedIndexClean(config, paths, head);
  const lineage = await validatedLineage(config, paths, head);
  const headMetadata = await parseCommitMetadata(config, paths, head);
  if ((headMetadata.parents[0] ?? null) !== lineage.get(head) || headMetadata.parents.length !== (lineage.get(head) === null ? 0 : 1)) {
    fail("history_mismatch", "HEAD 父提交元数据与线性历史不一致");
  }
  return { paths, identity, head, lineage };
}

async function saveInternal(input: ProdStorageSaveInput, action: ProdStorageAction, interfaceAction: ProdStorageInterfaceAction): Promise<ProdStorageWriteResult> {
  if (!SAFE_SEGMENT_RE.test(input.operationId)) fail("invalid_operation", "operationId 必须是安全短标识");
  if (input.expectedParent !== null) assertFullCommit(input.expectedParent, "expectedParent");
  requireAuthorized(input, { phase: "beforeAction", action: interfaceAction, operationId: input.operationId, expectedParent: input.expectedParent });
  const bytes = Buffer.from(input.bytes);
  const prodHash = sha256(bytes);
  const paths = await preparePaths(input, true);
  await ensurePrivateDirectoryChain(paths.dataRoot, paths.requirementRoot);
  await assertCurrentUser(paths.requirementRoot);
  await assertNoUnverifiedTemporaryFiles(paths.requirementRoot);
  await assertOnlyProdAndGit(paths.requirementRoot);
  const gitExists = await assertGitDirectory(paths.requirementRoot, false);
  if (!gitExists && input.expectedParent !== null) fail("git_missing", "已有版本记录却缺失 .git");
  await initRepository(input, paths, input.expectedParent === null);
  const identity = await assertRepositoryIdentity(input, paths.requirementRoot);
  await assertOnlyProdAndGit(paths.requirementRoot);

  const head = await currentHead(input, paths);
  const lineage = await validatedLineage(input, paths, head);
  const headMetadata = head ? await parseCommitMetadata(input, paths, head) : undefined;
  if (head && ((headMetadata!.parents[0] ?? null) !== lineage.get(head) || headMetadata!.parents.length !== (lineage.get(head) === null ? 0 : 1))) {
    fail("history_mismatch", "HEAD 父提交元数据与线性历史不一致");
  }

  if (head && head !== input.expectedParent) {
    const recoverable = headMetadata!.operationId === input.operationId
      && headMetadata!.action === action
      && headMetadata!.prodHash === prodHash
      && (input.expectedParent === null ? headMetadata!.parents.length === 0 : headMetadata!.parents.length === 1 && headMetadata!.parents[0] === input.expectedParent);
    if (!recoverable) fail("parent_mismatch", "HEAD 与 expectedParent 不一致，拒绝覆盖外部内容");
    const working = await readFileSnapshot(paths.prodPath);
    if (!working.exists || working.prodHash !== prodHash) fail("working_copy_mismatch", "prod.md 含未登记的外部内容，拒绝恢复旧操作");
    await verifyCommitMatches(input, paths, head, prodHash, input.expectedParent, input.operationId, action);
    await recoverManagedIndex(input, paths, input.expectedParent, head);
    requireAuthorized(input, { phase: "beforeReturn", action: interfaceAction, operationId: input.operationId, expectedParent: input.expectedParent, prodHash });
    return { status: "recovered", action, operationId: input.operationId, commit: head, parent: input.expectedParent, prodHash, changed: true, repositoryRoot: paths.requirementRoot, repositoryIdentity: identity };
  }

  await assertManagedIndexClean(input, paths, head);
  const operationIds = await operationIdsInHistory(input, paths, head);
  let expectedWorkingFile: ProdFileSnapshot;
  if (head) {
    const headHash = headMetadata!.prodHash;
    expectedWorkingFile = await readFileSnapshot(paths.prodPath);
    if (!expectedWorkingFile.exists) fail("working_copy_mismatch", "prod.md 缺失，拒绝覆盖版本记录");
    if (expectedWorkingFile.prodHash !== headHash && expectedWorkingFile.prodHash !== prodHash) {
      fail("working_copy_mismatch", "prod.md 含不属于当前操作的外部内容，拒绝覆盖");
    }
    if (operationIds.has(input.operationId)) fail("operation_conflict", "operationId 已用于其他正文提交");
    if (headHash === prodHash) {
      requireAuthorized(input, { phase: "beforeReturn", action: interfaceAction, operationId: input.operationId, expectedParent: input.expectedParent, prodHash });
      return { status: "unchanged", action, operationId: input.operationId, commit: head, parent: headMetadata!.parents[0] ?? null, prodHash, changed: false, repositoryRoot: paths.requirementRoot, repositoryIdentity: identity };
    }
  } else {
    if (input.expectedParent !== null) fail("parent_mismatch", "仓库尚无提交，expectedParent 不为 null");
    expectedWorkingFile = await readFileSnapshot(paths.prodPath);
    if (expectedWorkingFile.exists && expectedWorkingFile.prodHash !== prodHash) {
      fail("working_copy_mismatch", "无提交仓库中的 prod.md 与登记操作目标不同，拒绝覆盖");
    }
  }

  requireAuthorized(input, { phase: "beforeWrite", action: interfaceAction, operationId: input.operationId, expectedParent: input.expectedParent, prodHash });
  await writeProdFile(paths.requirementRoot, paths.prodPath, bytes, input.operationId, prodHash, expectedWorkingFile);
  await assertOnlyProdAndGit(paths.requirementRoot);
  const commit = await writeTreeCommit(input, paths, bytes, action, input.operationId, head, prodHash);
  await verifyCommitMatches(input, paths, commit, prodHash, head, input.operationId, action);
  await assertWorktreeMatchesHash(paths.prodPath, prodHash);
  const newHead = await currentHead(input, paths);
  if (newHead !== commit) fail("head_mismatch", "提交后 HEAD 与实际提交不一致");
  await assertManagedIndexClean(input, paths, commit);
  const newLineage = await validatedLineage(input, paths, commit);
  if (newLineage.get(commit) !== head) fail("history_mismatch", "新提交没有接到预期父提交");
  requireAuthorized(input, { phase: "beforeReturn", action: interfaceAction, operationId: input.operationId, expectedParent: input.expectedParent, prodHash });
  return { status: head ? "saved" : "created", action, operationId: input.operationId, commit, parent: head, prodHash, changed: true, repositoryRoot: paths.requirementRoot, repositoryIdentity: identity };
}

export async function create(input: ProdStorageSaveInput): Promise<ProdStorageWriteResult> {
  if (input.expectedParent !== null) fail("invalid_parent", "create 的 expectedParent 必须为 null");
  return saveInternal(input, "create", "create");
}

export async function save(input: ProdStorageSaveInput & { action: Exclude<ProdStorageAction, "create"> }): Promise<ProdStorageWriteResult> {
  if (input.action !== "updateDraft" && input.action !== "confirmUpdate") fail("invalid_action", "save action 只能是 updateDraft 或 confirmUpdate");
  return saveInternal(input, input.action, "save");
}

function assertRequestedVersion(lineage: Map<string, string | null>, commit: string): void {
  if (!lineage.has(commit)) fail("unknown_version", "请求的提交不属于当前线性正文历史");
}

export async function verifyVersion(input: ProdStorageVerifyInput): Promise<ProdStorageVerifyResult> {
  assertFullCommit(input.commit);
  assertHash(input.expectedHash);
  const { paths, identity, lineage } = await ensureReadyForRead(input, "verifyVersion", { commit: input.commit, expectedHash: input.expectedHash });
  assertRequestedVersion(lineage, input.commit);
  const verified = await verifyCommitMatches(input, paths, input.commit, input.expectedHash, lineage.get(input.commit)!);
  requireAuthorized(input, { phase: "beforeReturn", action: "verifyVersion", commit: input.commit, prodHash: verified.prodHash });
  return { ok: true, commit: input.commit, prodHash: verified.prodHash, repositoryRoot: paths.requirementRoot, repositoryIdentity: identity };
}

export async function readVersion(input: ProdStorageReadInput): Promise<ProdStorageReadResult> {
  assertFullCommit(input.commit);
  assertHash(input.expectedHash);
  const { paths, lineage } = await ensureReadyForRead(input, "readVersion", { commit: input.commit, expectedHash: input.expectedHash });
  assertRequestedVersion(lineage, input.commit);
  const verified = await verifyCommitMatches(input, paths, input.commit, input.expectedHash, lineage.get(input.commit)!);
  requireAuthorized(input, { phase: "beforeReturnBody", action: "readVersion", commit: input.commit, prodHash: verified.prodHash });
  return { commit: input.commit, prodHash: verified.prodHash, bytes: verified.bytes };
}

export async function diffVersions(input: ProdStorageDiffInput): Promise<ProdStorageDiffResult> {
  assertFullCommit(input.fromCommit, "fromCommit");
  assertFullCommit(input.toCommit, "toCommit");
  assertHash(input.expectedFromHash);
  assertHash(input.expectedToHash);
  const { paths, lineage } = await ensureReadyForRead(input, "diffVersions", {
    fromCommit: input.fromCommit,
    toCommit: input.toCommit,
    expectedFromHash: input.expectedFromHash,
    expectedToHash: input.expectedToHash,
  });
  assertRequestedVersion(lineage, input.fromCommit);
  assertRequestedVersion(lineage, input.toCommit);
  const from = await verifyCommitMatches(input, paths, input.fromCommit, input.expectedFromHash, lineage.get(input.fromCommit)!);
  const to = input.toCommit === input.fromCommit
    ? from
    : await verifyCommitMatches(input, paths, input.toCommit, input.expectedToHash, lineage.get(input.toCommit)!);
  if (to.prodHash !== input.expectedToHash) fail("hash_mismatch", "toCommit 正文 hash 与期望不一致");
  const diff = (await runGit(input, paths, ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--full-index", input.fromCommit, input.toCommit, "--", PROD_FILE])).stdout.toString("utf8");
  requireAuthorized(input, {
    phase: "beforeReturnBody",
    action: "diffVersions",
    fromCommit: input.fromCommit,
    toCommit: input.toCommit,
    expectedFromHash: input.expectedFromHash,
    expectedToHash: input.expectedToHash,
    prodHash: to.prodHash,
  });
  return { fromCommit: input.fromCommit, toCommit: input.toCommit, fromHash: from.prodHash, toHash: to.prodHash, diff };
}

export function prodRequirementPath(config: Pick<ProdStorageConfig, "dataRoot" | "repoId" | "requirementId">): string {
  if (!isAbsolute(config.dataRoot)) fail("invalid_config", "dataRoot 必须是绝对路径");
  assertSafeSegment("repoId", config.repoId);
  assertRequirementId(config.requirementId);
  return join(config.dataRoot, "repos", config.repoId, "requirements", config.requirementId);
}
