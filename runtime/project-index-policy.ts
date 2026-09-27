import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, lstatSync, realpathSync } from "node:fs";
import type { BigIntStats, Dirent, Stats } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { extname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { assertDataRootOutsideWorktrees } from "./database-paths.ts";

export const DEFAULT_INDEX_LIMITS = Object.freeze({
  maxFileBytes: 2 * 1024 * 1024,
  maxTotalTextBytes: 20 * 1024 * 1024,
  maxEntries: 20_000,
  maxDepth: 64,
});

export type IndexLanguage = "ts" | "tsx" | "js" | "jsx" | "go" | null;
export type IndexFileKind = "code" | "document" | "config" | "unsupported";
export type IndexSkipReason =
  | "prod_archive"
  | "excluded_directory"
  | "excluded_file"
  | "sensitive"
  | "database"
  | "symbolic_link"
  | "hard_link"
  | "special_file"
  | "unreadable"
  | "outside_root"
  | "nested_repository"
  | "git_ignored"
  | "file_too_large"
  | "total_text_limit"
  | "entry_limit"
  | "depth_limit"
  | "unstable"
  | "cancelled"
  | "binary"
  | "invalid_utf8"
  | "unsupported";

export interface IndexLimits {
  maxFileBytes: number;
  maxTotalTextBytes: number;
  maxEntries: number;
  maxDepth: number;
}

export interface IndexFile {
  path: string;
  kind: IndexFileKind;
  language: IndexLanguage;
  size: number;
}

export interface IndexSkippedPath {
  path: string;
  reason: IndexSkipReason;
}

export interface IndexArchiveMetadata {
  path: string;
  requirementId: string | null;
}

export interface IndexBudgetResult {
  limits: IndexLimits;
  used: {
    entries: number;
    textBytes: number;
  };
  exhausted: Array<"file_bytes" | "total_text_bytes" | "entries" | "depth">;
  stoppedReason: "complete" | "cancelled" | "entry_limit";
}

export interface IndexScanProgress {
  path: string;
  entries: number;
  files: number;
  textBytes: number;
}

export interface ScanIndexWorkspaceInput {
  root: string;
  dataRoot: string;
  signal?: AbortSignal;
  limits?: Partial<IndexLimits>;
  onProgress?: (progress: IndexScanProgress) => void;
}

export interface IndexWorkspaceScan {
  root: string;
  files: IndexFile[];
  skipped: IndexSkippedPath[];
  archives: IndexArchiveMetadata[];
  /** 已通过真实路径、链接、嵌套仓库和排除策略核验，可注册非递归监听的目录。 */
  watchDirectories: string[];
  /** 只监听直接目录项名称、不得读取正文的归档目录。 */
  archiveWatchDirectories: string[];
  budget: IndexBudgetResult;
  partial: boolean;
}

export type ReadIndexFileResult =
  | { status: "success"; path: string; content: string; size: number; sha256: string }
  | { status: "skipped"; path: string; reason: IndexSkipReason }
  | { status: "unstable"; path: string; reason: "unstable" };

export interface ReadIndexFileOptions {
  signal?: AbortSignal;
  maxBytes?: number;
  readUnsupported?: boolean;
}

export class ProjectIndexPolicyError extends Error {
  readonly code: "invalid_root" | "invalid_data_root" | "data_root_overlap" | "invalid_limits" | "invalid_path";

  constructor(code: ProjectIndexPolicyError["code"], message: string) {
    super(message);
    this.name = "ProjectIndexPolicyError";
    this.code = code;
  }
}

const UUID_V7_PREFIX = /^([0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\./;
const DIRECTORY_EXCLUSIONS = new Set([
  ".git",
  ".pi",
  ".bb-spec",
  "node_modules",
  "bower_components",
  "dependencies",
  "deps",
  "vendor",
  "third_party",
  "third-party",
  "build",
  "dist",
  "coverage",
  "out",
  "target",
  ".cache",
  "cache",
  "caches",
  ".parcel-cache",
  ".next",
  ".nuxt",
  ".turbo",
  ".vite",
  "log",
  "logs",
]);
const SENSITIVE_DIRECTORIES = new Set([".ssh", ".gnupg", ".aws", ".azure", ".secrets", "secrets", "credentials"]);
const SENSITIVE_FILENAMES = new Set([
  ".git-credentials",
  ".netrc",
  ".npmrc",
  ".pypirc",
  "credentials",
  "credentials.json",
  "secrets.json",
  "service-account.json",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
]);
const SENSITIVE_EXTENSIONS = new Set([".pem", ".key", ".p12", ".pfx", ".jks", ".keystore"]);
const DOCUMENT_EXTENSIONS = new Set([".md", ".mdx", ".txt", ".rst", ".adoc"]);
const CONFIG_EXTENSIONS = new Set([
  ".json",
  ".jsonc",
  ".yaml",
  ".yml",
  ".toml",
  ".ini",
  ".cfg",
  ".conf",
  ".properties",
  ".xml",
  ".graphql",
  ".gql",
]);
const CONFIG_FILENAMES = new Set([
  "package.json",
  "tsconfig.json",
  "jsconfig.json",
  "deno.json",
  "dockerfile",
  "makefile",
  "justfile",
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
  "go.mod",
  "go.sum",
]);
const EXCLUDED_FILE_EXTENSIONS = new Set([".log", ".tmp", ".temp", ".cache"]);
const DATABASE_EXTENSIONS = new Set([".db", ".sqlite", ".sqlite3"]);
const GIT_MARKER_CASE_VARIANTS = [".git", ".giT", ".gIt", ".gIT", ".Git", ".GiT", ".GIt", ".GIT"] as const;

function normalizedLimits(input: Partial<IndexLimits> | undefined): IndexLimits {
  const merged: IndexLimits = { ...DEFAULT_INDEX_LIMITS, ...input };
  for (const key of ["maxFileBytes", "maxTotalTextBytes", "maxEntries"] as const) {
    if (!Number.isSafeInteger(merged[key]) || merged[key] < 1 || merged[key] > DEFAULT_INDEX_LIMITS[key]) {
      throw new ProjectIndexPolicyError("invalid_limits", "索引预算必须是正整数且不能超过安全默认值");
    }
  }
  if (!Number.isSafeInteger(merged.maxDepth) || merged.maxDepth < 0 || merged.maxDepth > DEFAULT_INDEX_LIMITS.maxDepth) {
    throw new ProjectIndexPolicyError("invalid_limits", "索引深度必须是非负整数且不能超过安全默认值");
  }
  return merged;
}

function normalizeReadLimit(value: number | undefined): number {
  const limit = value ?? DEFAULT_INDEX_LIMITS.maxFileBytes;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > DEFAULT_INDEX_LIMITS.maxFileBytes) {
    throw new ProjectIndexPolicyError("invalid_limits", "单文件读取预算必须是正整数且不能超过安全默认值");
  }
  return limit;
}

function isAccessFailure(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EACCES" || code === "EPERM" || code === "EMFILE" || code === "ENFILE";
}

function pathWithin(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

function sameIdentity(left: Pick<Stats, "dev" | "ino">, right: Pick<Stats, "dev" | "ino">): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameBigIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameBigVersion(left: BigIntStats, right: BigIntStats): boolean {
  return sameBigIdentity(left, right)
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs
    && left.mode === right.mode
    && left.nlink === right.nlink;
}

function prodArchivePath(parts: string[]): boolean {
  return parts.length >= 2 && parts[0]?.toLowerCase() === "docs" && parts[1]?.toLowerCase() === "prod";
}

function directoryPolicy(name: string): IndexSkipReason | undefined {
  const lower = name.toLowerCase();
  if (SENSITIVE_DIRECTORIES.has(lower)) return "sensitive";
  if (DIRECTORY_EXCLUSIONS.has(lower)) return "excluded_directory";
  return undefined;
}

function filePolicy(parts: string[]): IndexSkipReason | undefined {
  if (prodArchivePath(parts)) return "prod_archive";
  for (const part of parts.slice(0, -1)) {
    const reason = directoryPolicy(part);
    if (reason) return reason;
  }
  const name = (parts.at(-1) ?? "").toLowerCase();
  if (name === ".git") return "excluded_file";
  const extension = extname(name);
  if (name === ".env" || name.startsWith(".env.") || SENSITIVE_FILENAMES.has(name)
    || name.startsWith("credentials.") || name.startsWith("secret.") || name.startsWith("secrets.")
    || SENSITIVE_EXTENSIONS.has(extension)) return "sensitive";
  if (DATABASE_EXTENSIONS.has(extension) || /\.(?:db|sqlite|sqlite3)-(?:wal|shm)$/u.test(name)) return "database";
  if (name === ".ds_store" || name === ".eslintcache" || EXCLUDED_FILE_EXTENSIONS.has(extension)) return "excluded_file";
  return undefined;
}

export type IndexWatchEventKind = "index" | "archive_metadata" | "ignored";

/** 只按规范相对路径分类监听事件；不访问目标，因此归档事件不会先读正文。 */
export function classifyIndexWatchEvent(path: string): IndexWatchEventKind {
  const parts = safeRelativePath(path);
  if (prodArchivePath(parts)) return "archive_metadata";
  if (parts.some((part) => directoryPolicy(part) !== undefined)) return "ignored";
  return filePolicy(parts) ? "ignored" : "index";
}

function classifyFile(parts: string[]): Pick<IndexFile, "kind" | "language"> {
  const name = (parts.at(-1) ?? "").toLowerCase();
  const extension = extname(name);
  const languages: Readonly<Record<string, Exclude<IndexLanguage, null>>> = {
    ".ts": "ts",
    ".tsx": "tsx",
    ".js": "js",
    ".jsx": "jsx",
    ".go": "go",
  };
  const language = languages[extension];
  if (language) return { kind: "code", language };
  if (DOCUMENT_EXTENSIONS.has(extension) || ["readme", "license", "notice", "changelog"].includes(name)) {
    return { kind: "document", language: null };
  }
  if (CONFIG_EXTENSIONS.has(extension) || CONFIG_FILENAMES.has(name)) return { kind: "config", language: null };
  return { kind: "unsupported", language: null };
}

function safeRelativePath(file: string): string[] {
  if (typeof file !== "string" || file.length === 0 || file.includes("\0") || file.includes("\\") || posix.isAbsolute(file)) {
    throw new ProjectIndexPolicyError("invalid_path", "索引文件路径必须是规范的相对 POSIX 路径");
  }
  const normalized = posix.normalize(file.replace(/^\.\/+/, ""));
  if (normalized === "." || normalized !== file || normalized === ".." || normalized.startsWith("../")) {
    throw new ProjectIndexPolicyError("invalid_path", "索引文件路径必须是规范的相对 POSIX 路径");
  }
  const parts = normalized.split("/");
  if (parts.length - 1 > DEFAULT_INDEX_LIMITS.maxDepth) {
    throw new ProjectIndexPolicyError("invalid_path", "索引文件路径深度超过安全上限");
  }
  return parts;
}

async function safeWorkspaceRoot(root: string, synchronousMetadata = false): Promise<{ root: string; stats: Stats }> {
  if (typeof root !== "string" || !isAbsolute(root)) {
    throw new ProjectIndexPolicyError("invalid_root", "工作区根必须是绝对路径");
  }
  const requested = resolve(root);
  let stats: Stats;
  let actual: string;
  try {
    stats = synchronousMetadata ? lstatSync(requested) : await lstat(requested);
    actual = synchronousMetadata ? realpathSync(requested) : await realpath(requested);
  } catch {
    throw new ProjectIndexPolicyError("invalid_root", "工作区根不可访问");
  }
  if (stats.isSymbolicLink() || !stats.isDirectory() || actual !== requested) {
    throw new ProjectIndexPolicyError("invalid_root", "工作区根必须是真实目录，不能经过链接");
  }
  return { root: actual, stats };
}

function assertExternalDataRoot(dataRoot: string, root: string): void {
  if (typeof dataRoot !== "string" || !isAbsolute(dataRoot)) {
    throw new ProjectIndexPolicyError("invalid_data_root", "本机数据根必须是绝对路径");
  }
  const requested = resolve(dataRoot);
  if (pathWithin(root, requested) || pathWithin(requested, root)) {
    throw new ProjectIndexPolicyError("data_root_overlap", "本机数据根路径不能位于工作区内或包含工作区");
  }
  try {
    assertDataRootOutsideWorktrees(dataRoot, [root]);
  } catch {
    throw new ProjectIndexPolicyError("data_root_overlap", "本机数据根必须与工作区真实路径分离");
  }
}

async function boundedDirectoryEntries(path: string, remaining: number): Promise<{ entries: Dirent[]; exceeded: boolean }> {
  const entries: Dirent[] = [];
  const directory = await opendir(path);
  try {
    for await (const entry of directory) {
      if (entries.length >= remaining) return { entries, exceeded: true };
      entries.push(entry);
    }
  } finally {
    await directory.close().catch(() => undefined);
  }
  entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  return { entries, exceeded: false };
}

async function openedFileMetadata(path: string, synchronousMetadata = false): Promise<
  | { status: "ok"; stats: BigIntStats }
  | { status: "skip"; reason: IndexSkipReason }
> {
  let before: BigIntStats;
  try {
    before = synchronousMetadata ? lstatSync(path, { bigint: true }) : await lstat(path, { bigint: true });
  } catch (error) {
    return { status: "skip", reason: isAccessFailure(error) ? "unreadable" : "unstable" };
  }
  if (before.isSymbolicLink()) return { status: "skip", reason: "symbolic_link" };
  if (!before.isFile()) return { status: "skip", reason: "special_file" };
  if (before.nlink !== 1n) return { status: "skip", reason: "hard_link" };

  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { status: "skip", reason: code === "ELOOP" ? "symbolic_link" : isAccessFailure(error) ? "unreadable" : "unstable" };
  }
  try {
    const opened = await handle.stat({ bigint: true });
    let after: BigIntStats;
    try {
      after = synchronousMetadata ? lstatSync(path, { bigint: true }) : await lstat(path, { bigint: true });
    } catch {
      return { status: "skip", reason: "unstable" };
    }
    if (!opened.isFile() || opened.nlink !== 1n || !sameBigVersion(before, opened) || !sameBigVersion(opened, after)) {
      return { status: "skip", reason: "unstable" };
    }
    return { status: "ok", stats: opened };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function numericSize(size: bigint): number | undefined {
  const value = Number(size);
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** 被 Git 忽略的路径（整目录被忽略时以 `/` 结尾）；不在 Git 仓库内时视为无忽略。 */
async function gitIgnoredPaths(root: string): Promise<Set<string>> {
  try {
    const { stdout } = await promisify(execFile)("git", ["-C", root, "ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"],
      { maxBuffer: 64 << 20 });
    return new Set(stdout.split("\0").filter(Boolean));
  } catch { return new Set(); }
}

export async function scanIndexWorkspace(input: ScanIndexWorkspaceInput): Promise<IndexWorkspaceScan> {
  const limits = normalizedLimits(input.limits);
  const workspace = await safeWorkspaceRoot(input.root);
  assertExternalDataRoot(input.dataRoot, workspace.root);
  const ignored = await gitIgnoredPaths(workspace.root);

  const files: IndexFile[] = [];
  const skipped: IndexSkippedPath[] = [];
  const archives: IndexArchiveMetadata[] = [];
  const watchDirectories: string[] = [];
  const archiveWatchDirectories: string[] = [];
  const exhausted = new Set<IndexBudgetResult["exhausted"][number]>();
  let entriesUsed = 0;
  let textBytes = 0;
  let stoppedReason: IndexBudgetResult["stoppedReason"] = "complete";
  let stopped = false;

  const report = (path: string): void => {
    input.onProgress?.({ path, entries: entriesUsed, files: files.length, textBytes });
  };
  const addSkip = (path: string, reason: IndexSkipReason): void => {
    skipped.push({ path, reason });
    report(path);
  };
  const cancelAtBoundary = (path: string): boolean => {
    if (!input.signal?.aborted) return false;
    stopped = true;
    stoppedReason = "cancelled";
    addSkip(path, "cancelled");
    return true;
  };
  const stopForEntries = (path: string): void => {
    stopped = true;
    stoppedReason = "entry_limit";
    exhausted.add("entries");
    addSkip(path, "entry_limit");
  };

  const enumerateArchives = async (directoryPath: string, directoryRelative: string, before: Stats): Promise<void> => {
    if (cancelAtBoundary(directoryRelative)) return;
    let actual: string;
    try {
      actual = await realpath(directoryPath);
    } catch {
      addSkip(directoryRelative, "unreadable");
      return;
    }
    if (actual !== directoryPath || !pathWithin(workspace.root, actual)) {
      addSkip(directoryRelative, "outside_root");
      return;
    }
    const remaining = limits.maxEntries - entriesUsed;
    if (remaining <= 0) {
      stopForEntries(directoryRelative);
      return;
    }
    let listed: { entries: Dirent[]; exceeded: boolean };
    try {
      listed = await boundedDirectoryEntries(directoryPath, remaining);
    } catch {
      addSkip(directoryRelative, "unreadable");
      return;
    }
    if (listed.exceeded) {
      stopForEntries(directoryRelative);
      return;
    }
    let after: Stats;
    try {
      after = await lstat(directoryPath);
    } catch {
      addSkip(directoryRelative, "unstable");
      return;
    }
    if (!after.isDirectory() || after.isSymbolicLink() || !sameIdentity(before, after)) {
      addSkip(directoryRelative, "unstable");
      return;
    }
    archiveWatchDirectories.push(directoryRelative);
    entriesUsed += listed.entries.length;
    for (const entry of listed.entries) {
      if (cancelAtBoundary(directoryRelative)) return;
      const path = `${directoryRelative}/${entry.name}`;
      const match = UUID_V7_PREFIX.exec(entry.name);
      archives.push({ path, requirementId: match?.[1] ?? null });
      report(path);
    }
    addSkip(directoryRelative, "prod_archive");
  };

  const walk = async (directoryPath: string, directoryRelative: string, depth: number, before: Stats): Promise<void> => {
    if (stopped || cancelAtBoundary(directoryRelative)) return;
    let actual: string;
    try {
      actual = await realpath(directoryPath);
    } catch {
      addSkip(directoryRelative, "unreadable");
      return;
    }
    if (actual !== directoryPath || !pathWithin(workspace.root, actual)) {
      addSkip(directoryRelative, "outside_root");
      return;
    }
    const remaining = limits.maxEntries - entriesUsed;
    if (remaining <= 0) {
      stopForEntries(directoryRelative);
      return;
    }
    let listed: { entries: Dirent[]; exceeded: boolean };
    try {
      listed = await boundedDirectoryEntries(directoryPath, remaining);
    } catch {
      addSkip(directoryRelative, "unreadable");
      return;
    }
    if (listed.exceeded) {
      stopForEntries(directoryRelative);
      return;
    }
    let after: Stats;
    try {
      after = await lstat(directoryPath);
    } catch {
      addSkip(directoryRelative, "unstable");
      return;
    }
    if (!after.isDirectory() || after.isSymbolicLink() || !sameIdentity(before, after)) {
      addSkip(directoryRelative, "unstable");
      return;
    }
    entriesUsed += listed.entries.length;

    if (directoryRelative !== "." && listed.entries.some((entry) => entry.name.toLowerCase() === ".git")) {
      addSkip(directoryRelative, "nested_repository");
      return;
    }
    watchDirectories.push(directoryRelative);

    for (const entry of listed.entries) {
      if (stopped || cancelAtBoundary(directoryRelative)) return;
      const fullPath = join(directoryPath, entry.name);
      const rel = directoryRelative === "." ? entry.name : `${directoryRelative}/${entry.name}`;
      const parts = rel.split("/");
      let stats: Stats;
      try {
        stats = await lstat(fullPath);
      } catch (error) {
        addSkip(rel, isAccessFailure(error) ? "unreadable" : "unstable");
        continue;
      }
      if (stats.isSymbolicLink()) {
        addSkip(rel, "symbolic_link");
        continue;
      }
      if (prodArchivePath(parts)) {
        if (stats.isDirectory()) await enumerateArchives(fullPath, rel, stats);
        else addSkip(rel, "prod_archive");
        continue;
      }
      if (ignored.has(stats.isDirectory() ? `${rel}/` : rel)) {
        addSkip(rel, "git_ignored");
        continue;
      }
      if (stats.isDirectory()) {
        const reason = directoryPolicy(entry.name);
        if (reason) {
          addSkip(rel, reason);
          continue;
        }
        if (depth + 1 > limits.maxDepth) {
          exhausted.add("depth");
          addSkip(rel, "depth_limit");
          continue;
        }
        await walk(fullPath, rel, depth + 1, stats);
        continue;
      }
      if (!stats.isFile()) {
        addSkip(rel, "special_file");
        continue;
      }
      const excluded = filePolicy(parts);
      if (excluded) {
        addSkip(rel, excluded);
        continue;
      }
      let actualFile: string;
      try {
        actualFile = await realpath(fullPath);
      } catch {
        addSkip(rel, "unreadable");
        continue;
      }
      if (actualFile !== fullPath || !pathWithin(workspace.root, actualFile)) {
        addSkip(rel, "outside_root");
        continue;
      }
      const metadata = await openedFileMetadata(fullPath);
      if (metadata.status === "skip") {
        addSkip(rel, metadata.reason);
        continue;
      }
      const size = numericSize(metadata.stats.size);
      if (size === undefined || size > limits.maxFileBytes) {
        exhausted.add("file_bytes");
        addSkip(rel, "file_too_large");
        continue;
      }
      const classification = classifyFile(parts);
      if (textBytes + size > limits.maxTotalTextBytes) {
        exhausted.add("total_text_bytes");
        addSkip(rel, "total_text_limit");
        continue;
      }
      files.push({ path: rel, ...classification, size });
      textBytes += size;
      report(rel);
    }
  };

  await walk(workspace.root, ".", 0, workspace.stats);
  let rootAfter: Stats | undefined;
  try {
    rootAfter = await lstat(workspace.root);
  } catch {
    addSkip(".", "unstable");
  }
  if (rootAfter && (!rootAfter.isDirectory() || rootAfter.isSymbolicLink() || !sameIdentity(workspace.stats, rootAfter))) {
    addSkip(".", "unstable");
  }

  files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  archives.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  watchDirectories.sort();
  archiveWatchDirectories.sort();
  skipped.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : left.reason.localeCompare(right.reason));
  const exhaustedList = [...exhausted].sort();
  return {
    root: workspace.root,
    files,
    skipped,
    archives,
    watchDirectories,
    archiveWatchDirectories,
    budget: {
      limits,
      used: { entries: entriesUsed, textBytes },
      exhausted: exhaustedList,
      stoppedReason,
    },
    partial: stoppedReason !== "complete"
      || exhaustedList.length > 0
      || skipped.some((entry) => entry.reason === "unstable" || entry.reason === "unreadable"),
  };
}

interface AncestorSnapshot {
  path: string;
  stats: Stats;
}

type AncestorCapture =
  | { status: "ok"; snapshots: AncestorSnapshot[] }
  | { status: "skip"; reason: IndexSkipReason };

async function gitMarkerReason(directory: string): Promise<IndexSkipReason | undefined> {
  for (const name of GIT_MARKER_CASE_VARIANTS) {
    try {
      // 每个边界最多探测八个名称；缺失不创建异常，结果不跨边界缓存。
      if (lstatSync(join(directory, name), { throwIfNoEntry: false })) return "nested_repository";
    } catch (error) {
      return isAccessFailure(error) ? "unreadable" : "unstable";
    }
  }
  return undefined;
}

async function captureAncestorChain(root: string, parts: string[]): Promise<AncestorCapture> {
  const snapshots: AncestorSnapshot[] = [];
  let current = root;
  for (const part of parts.slice(0, -1)) {
    current = join(current, part);
    let before: Stats;
    let actual: string;
    let after: Stats;
    try {
      before = lstatSync(current);
      actual = realpathSync(current);
      after = lstatSync(current);
    } catch (error) {
      return { status: "skip", reason: isAccessFailure(error) ? "unreadable" : "unstable" };
    }
    if (before.isSymbolicLink() || after.isSymbolicLink()) return { status: "skip", reason: "symbolic_link" };
    if (!before.isDirectory() || !after.isDirectory() || !sameIdentity(before, after)) {
      return { status: "skip", reason: "unstable" };
    }
    if (actual !== current || !pathWithin(root, actual)) return { status: "skip", reason: "outside_root" };
    const markerReason = await gitMarkerReason(current);
    if (markerReason) return { status: "skip", reason: markerReason };
    snapshots.push({ path: current, stats: after });
  }
  return { status: "ok", snapshots };
}

async function verifyReadBoundary(
  workspace: { root: string; stats: Stats },
  snapshots: AncestorSnapshot[],
): Promise<boolean> {
  let rootStats: Stats;
  let actualRoot: string;
  try {
    rootStats = lstatSync(workspace.root);
    actualRoot = realpathSync(workspace.root);
  } catch {
    return false;
  }
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory() || !sameIdentity(workspace.stats, rootStats)
    || actualRoot !== workspace.root) return false;

  for (const snapshot of snapshots) {
    let stats: Stats;
    let actual: string;
    try {
      stats = lstatSync(snapshot.path);
      actual = realpathSync(snapshot.path);
    } catch {
      return false;
    }
    if (stats.isSymbolicLink() || !stats.isDirectory() || !sameIdentity(snapshot.stats, stats)
      || actual !== snapshot.path || !pathWithin(workspace.root, actual)) return false;
    if (await gitMarkerReason(snapshot.path)) return false;
  }
  return true;
}

async function readBoundedFile(
  path: string,
  expected: BigIntStats,
  maxBytes: number,
  signal: AbortSignal | undefined,
  verifyBoundary: () => Promise<boolean>,
): Promise<
  | { status: "success"; bytes: Buffer; stats: BigIntStats }
  | { status: "skipped"; reason: IndexSkipReason }
  | { status: "unstable" }
> {
  if (!await verifyBoundary()) return { status: "unstable" };
  let before: BigIntStats;
  try {
    before = lstatSync(path, { bigint: true });
  } catch (error) {
    return isAccessFailure(error) ? { status: "skipped", reason: "unreadable" } : { status: "unstable" };
  }
  if (before.isSymbolicLink()) return { status: "skipped", reason: "symbolic_link" };
  if (!before.isFile()) return { status: "skipped", reason: "special_file" };
  if (before.nlink !== 1n) return { status: "skipped", reason: "hard_link" };
  if (!sameBigVersion(expected, before)) return { status: "unstable" };
  const initialSize = numericSize(before.size);
  if (initialSize === undefined || initialSize > maxBytes) return { status: "skipped", reason: "file_too_large" };
  if (signal?.aborted) return { status: "skipped", reason: "cancelled" };

  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ELOOP") return { status: "skipped", reason: "symbolic_link" };
    return isAccessFailure(error) ? { status: "skipped", reason: "unreadable" } : { status: "unstable" };
  }
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n || !sameBigVersion(before, opened) || !await verifyBoundary()) {
      return { status: "unstable" };
    }
    const chunks: Buffer[] = [];
    let offset = 0;
    while (offset <= maxBytes) {
      if (signal?.aborted) return { status: "skipped", reason: "cancelled" };
      const length = Math.min(64 * 1024, maxBytes + 1 - offset);
      const buffer = Buffer.allocUnsafe(length);
      const result = await handle.read(buffer, 0, length, offset);
      if (result.bytesRead === 0) break;
      chunks.push(buffer.subarray(0, result.bytesRead));
      offset += result.bytesRead;
    }
    if (!await verifyBoundary()) return { status: "unstable" };
    const openedAfter = await handle.stat({ bigint: true });
    let pathAfter: BigIntStats;
    try {
      pathAfter = lstatSync(path, { bigint: true });
    } catch {
      return { status: "unstable" };
    }
    if (!sameBigVersion(opened, openedAfter) || !sameBigVersion(openedAfter, pathAfter) || BigInt(offset) !== openedAfter.size
      || !await verifyBoundary()) return { status: "unstable" };
    if (offset > maxBytes) return { status: "skipped", reason: "file_too_large" };
    return { status: "success", bytes: Buffer.concat(chunks, offset), stats: openedAfter };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

export async function readIndexFile(
  rootInput: string,
  file: string | Pick<IndexFile, "path" | "size">,
  options: ReadIndexFileOptions = {},
): Promise<ReadIndexFileResult> {
  const maxBytes = normalizeReadLimit(options.maxBytes);
  // 路径深度受限；每次读取独立核验元数据，文件与句柄 I/O 保持异步。
  const workspace = await safeWorkspaceRoot(rootInput, true);
  const path = typeof file === "string" ? file : file.path;
  const expectedSize = typeof file === "string" ? undefined : file.size;
  const parts = safeRelativePath(path);
  const excluded = filePolicy(parts);
  if (excluded) return { status: "skipped", path, reason: excluded };
  const classification = classifyFile(parts);
  if (classification.kind === "unsupported" && options.readUnsupported !== true) {
    return { status: "skipped", path, reason: "unsupported" };
  }
  if (options.signal?.aborted) return { status: "skipped", path, reason: "cancelled" };

  const ancestors = await captureAncestorChain(workspace.root, parts);
  if (ancestors.status === "skip") return { status: "skipped", path, reason: ancestors.reason };
  const verifyBoundary = () => verifyReadBoundary(workspace, ancestors.snapshots);
  const fullPath = join(workspace.root, ...parts);
  if (!await verifyBoundary()) return { status: "unstable", path, reason: "unstable" };
  const target = await openedFileMetadata(fullPath, true);
  if (target.status === "skip") {
    return target.reason === "unstable"
      ? { status: "unstable", path, reason: "unstable" }
      : { status: "skipped", path, reason: target.reason };
  }
  const targetSize = numericSize(target.stats.size);
  if (targetSize === undefined || targetSize > maxBytes) return { status: "skipped", path, reason: "file_too_large" };
  if (expectedSize !== undefined && targetSize !== expectedSize) return { status: "unstable", path, reason: "unstable" };
  if (!await verifyBoundary()) return { status: "unstable", path, reason: "unstable" };
  let actual: string;
  try {
    actual = realpathSync(fullPath);
  } catch (error) {
    return isAccessFailure(error)
      ? { status: "skipped", path, reason: "unreadable" }
      : { status: "unstable", path, reason: "unstable" };
  }
  if (actual !== fullPath || !pathWithin(workspace.root, actual)) return { status: "skipped", path, reason: "outside_root" };
  if (!await verifyBoundary()) return { status: "unstable", path, reason: "unstable" };

  const read = await readBoundedFile(fullPath, target.stats, maxBytes, options.signal, verifyBoundary);
  if (read.status === "unstable") return { status: "unstable", path, reason: "unstable" };
  if (read.status === "skipped") return { status: "skipped", path, reason: read.reason };
  if (!await verifyBoundary()) return { status: "unstable", path, reason: "unstable" };
  const size = numericSize(read.stats.size);
  if (size === undefined || (expectedSize !== undefined && size !== expectedSize)) {
    return { status: "unstable", path, reason: "unstable" };
  }
  if (read.bytes.includes(0)) return { status: "skipped", path, reason: "binary" };
  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(read.bytes);
  } catch {
    return { status: "skipped", path, reason: "invalid_utf8" };
  }
  let rootAfter: Stats;
  try {
    rootAfter = lstatSync(workspace.root);
  } catch {
    return { status: "unstable", path, reason: "unstable" };
  }
  if (!sameIdentity(workspace.stats, rootAfter) || !await verifyBoundary()) {
    return { status: "unstable", path, reason: "unstable" };
  }
  return {
    status: "success",
    path,
    content,
    size,
    sha256: createHash("sha256").update(read.bytes).digest("hex"),
  };
}
