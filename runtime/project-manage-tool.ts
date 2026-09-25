import { lstat, realpath } from "node:fs/promises";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { isAbsolute, join, posix, resolve } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { assertDataRootOutsideWorktrees, assertRegularDatabaseFiles } from "./database-paths.ts";
import { listWorktrees, repositoryIdentity } from "./identity.ts";
import { ProjectIndexService } from "./project-index-service.ts";
import type {
  ProjectIndexAuthorizationRequest,
  ProjectIndexOperationOptions,
  ProjectIndexServiceOptions,
} from "./project-index-service.ts";
import { DEFAULT_INDEX_LIMITS } from "./project-index-policy.ts";
import { readGit } from "./git-read.ts";
import { WorkspaceManageError, WorkspaceManageService } from "./workspace-manage.ts";
import { backup, ProjectMaintenanceError, recoveryCheck, restore } from "./project-maintenance.ts";

const REPO_ID_PATTERN = "^[0-9a-f]{64}$";
const REQUIREMENT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const MAX_RESULT_BYTES = 32 * 1024;
const MAX_RESULT_ENTRIES = 100;
const MAX_PATH_LENGTH = 512;
const MAX_PROGRESS_UPDATES = 64;

const UUID_V7 = "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";
const publicParameters = Type.Object({
  action: StringEnum(["init", "status", "refresh", "recovery-check", "backup", "restore", "workspace-prepare", "workspace-recycle"] as const),
  repoId: Type.String({ pattern: REPO_ID_PATTERN }),
  preview: Type.Optional(Type.Boolean()),
  requirementId: Type.Optional(Type.String({ pattern: UUID_V7 })),
  operationId: Type.Optional(Type.String({ pattern: UUID_V7 })),
  backupOperationId: Type.Optional(Type.String({ pattern: UUID_V7 })),
  backupManifestHash: Type.Optional(Type.String({ pattern: REPO_ID_PATTERN })),
}, { additionalProperties: false });
const maintenanceSchema = (action: "recovery-check" | "backup") => Type.Object({
  action: Type.Literal(action),
  repoId: Type.String({ pattern: REPO_ID_PATTERN }),
  operationId: Type.String({ pattern: UUID_V7 }),
}, { additionalProperties: false });
const workspaceSchema = (action: "workspace-prepare" | "workspace-recycle") => Type.Object({
  action: Type.Literal(action),
  repoId: Type.String({ pattern: REPO_ID_PATTERN }),
  requirementId: Type.String({ pattern: UUID_V7 }),
  operationId: Type.String({ pattern: UUID_V7 }),
}, { additionalProperties: false });

const actionSchemas = {
  init: Type.Object({
    action: Type.Literal("init"),
    repoId: Type.String({ pattern: REPO_ID_PATTERN }),
    preview: Type.Optional(Type.Boolean()),
  }, { additionalProperties: false }),
  status: Type.Object({
    action: Type.Literal("status"),
    repoId: Type.String({ pattern: REPO_ID_PATTERN }),
  }, { additionalProperties: false }),
  refresh: Type.Object({
    action: Type.Literal("refresh"),
    repoId: Type.String({ pattern: REPO_ID_PATTERN }),
  }, { additionalProperties: false }),
  "workspace-prepare": workspaceSchema("workspace-prepare"),
  "workspace-recycle": workspaceSchema("workspace-recycle"),
  "recovery-check": maintenanceSchema("recovery-check"),
  backup: maintenanceSchema("backup"),
  restore: Type.Object({
    action: Type.Literal("restore"),
    repoId: Type.String({ pattern: REPO_ID_PATTERN }),
    operationId: Type.String({ pattern: UUID_V7 }),
    backupOperationId: Type.String({ pattern: UUID_V7 }),
    backupManifestHash: Type.String({ pattern: REPO_ID_PATTERN }),
  }, { additionalProperties: false }),
} as const;

export const PROJECT_MANAGE_PARAMETERS = publicParameters;
export const PROJECT_MANAGE_OUTPUT_LIMITS = Object.freeze({
  maxBytes: MAX_RESULT_BYTES,
  maxEntries: MAX_RESULT_ENTRIES,
  maxPathLength: MAX_PATH_LENGTH,
});

export type ProjectManageAction = "init" | "status" | "refresh";

type WorkspaceAction = "workspace-prepare" | "workspace-recycle";
type ProjectManageParams =
  | { action: ProjectManageAction; repoId: string; preview?: boolean }
  | { action: WorkspaceAction; repoId: string; requirementId: string; operationId: string }
  | { action: "recovery-check" | "backup"; repoId: string; operationId: string }
  | { action: "restore"; repoId: string; operationId: string; backupOperationId: string; backupManifestHash: string };

export interface ProjectManageHostContext {
  readonly windowId: string;
  readonly sessionId: string;
  readonly repositories: ReadonlyMap<string, { readonly path: string }>;
}

export interface ProjectIndexServiceHandle {
  preview(options?: ProjectIndexOperationOptions): Promise<unknown>;
  init(options?: ProjectIndexOperationOptions): Promise<unknown>;
  refresh(options?: ProjectIndexOperationOptions): Promise<unknown>;
  status(): Promise<unknown>;
  cancel?(): boolean;
  close?(): void | Promise<void>;
}

export type OpenProjectIndexServiceInput = Readonly<
  Pick<ProjectIndexServiceOptions, "repositoryRoot" | "dataRoot" | "repoId">
  & {
    authorize: NonNullable<ProjectIndexServiceOptions["authorize"]>;
    action: "preview" | ProjectManageAction;
    host: ProjectManageHostContext;
    readonly authorizedBranch: string;
    /** 只由真实确认后的会话闭包提供；不随单次工具完成撤销。 */
    authorizeContinuous: () => boolean;
  }
>;

export type OpenProjectIndexService = (input: OpenProjectIndexServiceInput) => Promise<ProjectIndexServiceHandle>;

export interface CreateProjectManageToolOptions {
  readonly dataRoot: string;
  readonly resolveHost: (ctx: ExtensionContext) => Promise<ProjectManageHostContext>;
  readonly currentHost: (ctx: ExtensionContext) => ProjectManageHostContext;
  readonly openService?: OpenProjectIndexService;
}

export interface ProjectManageToolRuntime {
  readonly tool: ToolDefinition<typeof publicParameters, Record<string, unknown>>;
  startSession(host: ProjectManageHostContext): void;
  shutdown(): Promise<void>;
}

export class ProjectManageToolError extends Error {
  readonly code:
    | "invalid_action"
    | "invalid_shape"
    | "host_unavailable"
    | "stale_session"
    | "stale_window"
    | "foreign_repo"
    | "repository_changed"
    | "unsafe_data_root"
    | "scan_confirmation_required"
    | "scan_declined"
    | "cancelled"
    | "operation_failed"
    | "workspace_confirmation_required"
    | "workspace_failed"
    | "maintenance_failed";

  constructor(code: ProjectManageToolError["code"], message: string) {
    super(message);
    this.name = "ProjectManageToolError";
    this.code = code;
  }
}

interface PathIdentity {
  readonly path: string;
  readonly device: bigint;
  readonly inode: bigint;
}

interface RootIdentity {
  readonly branch: string;
  readonly gitDir: PathIdentity;
  readonly gitMarker: PathIdentity;
  readonly gitMarkerContents: string | null;
  readonly repoId: string;
  readonly path: string;
  readonly device: bigint;
  readonly inode: bigint;
  readonly worktrees: readonly string[];
  readonly storage: readonly PathIdentity[];
}

interface ScanGrant {
  readonly branch: string;
  readonly sessionId: string;
  readonly windowId: string;
  readonly repoId: string;
  readonly repositoryRoot: string;
  readonly device: bigint;
  readonly inode: bigint;
}

interface ActiveOperation {
  readonly controller: AbortController;
  readonly completion: Promise<void>;
  service?: ProjectIndexServiceHandle;
  finish(): void;
}

const SERVICE_ACTIONS: Readonly<Record<"preview" | ProjectManageAction, ReadonlySet<string>>> = Object.freeze({
  preview: new Set(["open", "preview"]),
  init: new Set(["open", "init"]),
  status: new Set(["open", "status"]),
  refresh: new Set(["open", "refresh"]),
});

const SAFE_ENUM_VALUES: Readonly<Record<string, ReadonlySet<string>>> = Object.freeze({
  action: new Set(["preview", "init", "status", "refresh"]),
  status: new Set(["absent", "building", "dirty", "ready", "partial", "valid", "invalid", "cancelled", "interrupted", "indexed", "unsupported", "parse_error", "skipped", "running"]),
  state: new Set(["absent", "ready", "partial", "invalid", "cancelled", "interrupted", "building"]),
  phase: new Set(["scan", "read", "parse", "verify", "before", "after", "publish", "return"]),
  mode: new Set(["preview", "init", "status", "refresh"]),
  reason: new Set([
    "prod_archive", "excluded_directory", "excluded_file", "sensitive", "database", "symbolic_link", "hard_link",
    "special_file", "unreadable", "outside_root", "nested_repository", "git_ignored", "file_too_large", "total_text_limit", "entry_limit",
    "depth_limit", "unstable", "cancelled", "binary", "invalid_utf8", "unsupported", "invalid_archive_name",
    "duplicate_requirement_id",
  ]),
  code: new Set(["syntax_error", "invalid_spec", "unsupported_language", "unreadable", "budget_exceeded", "parser_unavailable", "unknown"]),
  kind: new Set(["code", "spec", "schema", "document", "config", "unsupported"]),
  language: new Set(["ts", "tsx", "js", "jsx", "go", "json"]),
  stoppedReason: new Set(["complete", "cancelled", "entry_limit"]),
  source: new Set(["archive", "local"]),
  lifecycle: new Set(["unknown"]),
});
const SAFE_VERSION_KEYS = new Set(["parserVersion", "policyVersion", "schemaVersion"]);
const SAFE_HASH_KEYS = new Set(["workspaceId", "head", "hash", "contractSetHash", "schemaHash"]);
const SAFE_BOOLEAN_KEYS = new Set([
  "initialized", "reused", "changed", "published", "complete", "cancelled", "partial", "invalid", "databaseCreated",
  "cacheVerified",
]);
const SAFE_NUMBER_KEYS = new Set([
  "generation", "previousGeneration", "currentGeneration", "targetGeneration", "version", "fence", "updatedAt", "count", "total",
  "completed", "size", "entries", "maxFileBytes", "maxTotalTextBytes", "maxEntries", "maxDepth", "files", "parsedFiles",
  "reusedFiles", "readBytes", "sourceCodepoints",
  "symbols", "codeEdges", "edges", "rules", "features", "fragments", "archives", "skipped", "errors", "warnings",
  "textBytes", "valid", "unsupported",
]);
const SAFE_OBJECT_KEYS = new Set([
  "metadata", "counts", "budget", "limits", "used", "preview", "result", "summary", "truncation", "workspace", "index",
  "archives", "spec",
]);
const SAFE_ARRAY_KEYS = new Set([
  "files", "paths", "items", "skipped", "invalid", "errors", "warnings", "archives", "exhausted", "languages", "metadata",
  "issues", "diagnostics",
]);
const PRIORITY_KEYS = [
  "status", "state", "generation", "previousGeneration", "initialized", "reused", "partial", "invalid", "errors",
  "warnings", "skipped", "budget", "counts", "archives", "issues", "metadata", "files", "paths", "items",
];

function checkedParams(value: unknown): ProjectManageParams {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProjectManageToolError("invalid_shape", "project_manage 参数不符合固定字段白名单");
  }
  const action = (value as { action?: unknown }).action;
  if (typeof action !== "string" || !(action in actionSchemas)) {
    throw new ProjectManageToolError("invalid_action", "未知或尚未开放的 project_manage action");
  }
  if (!Value.Check(actionSchemas[action as keyof typeof actionSchemas], value)) {
    throw new ProjectManageToolError("invalid_shape", "project_manage 参数不符合该 action 的固定字段白名单");
  }
  return structuredClone(value) as ProjectManageParams;
}

function snapshotHost(host: ProjectManageHostContext): ProjectManageHostContext {
  return {
    windowId: host.windowId,
    sessionId: host.sessionId,
    repositories: new Map([...host.repositories].map(([repoId, repository]) => [repoId, { path: repository.path }])),
  };
}

function sameHost(left: ProjectManageHostContext, right: ProjectManageHostContext): boolean {
  if (left.windowId !== right.windowId || left.sessionId !== right.sessionId || left.repositories.size !== right.repositories.size) return false;
  for (const [repoId, repository] of left.repositories) {
    if (right.repositories.get(repoId)?.path !== repository.path) return false;
  }
  return true;
}

function assertSessionHost(
  activeHost: ProjectManageHostContext | undefined,
  resolved: ProjectManageHostContext,
  ctx: ExtensionContext,
): void {
  if (!activeHost) throw new ProjectManageToolError("host_unavailable", "项目管理工具当前没有有效 lifecycle 窗口");
  const sessionId = ctx.sessionManager.getSessionId();
  if (sessionId !== activeHost.sessionId || resolved.sessionId !== sessionId) {
    throw new ProjectManageToolError("stale_session", "项目管理工具上下文与当前 session 不一致");
  }
  if (!sameHost(activeHost, resolved)) {
    throw new ProjectManageToolError("stale_window", "项目管理工具上下文与当前 lifecycle 窗口不一致");
  }
}

function currentHostMatches(
  options: CreateProjectManageToolOptions,
  activeHost: ProjectManageHostContext | undefined,
  expected: ProjectManageHostContext,
  ctx: ExtensionContext,
): boolean {
  if (!activeHost || !sameHost(activeHost, expected)) return false;
  try {
    if (ctx.sessionManager.getSessionId() !== expected.sessionId) return false;
    return sameHost(options.currentHost(ctx), expected);
  } catch {
    return false;
  }
}

async function inspectIndexStorage(dataRoot: string, repoId: string): Promise<PathIdentity[]> {
  if (!isAbsolute(dataRoot) || resolve(dataRoot) !== dataRoot) {
    throw new ProjectManageToolError("unsafe_data_root", "本机索引数据根必须是规范绝对路径");
  }
  const paths = [dataRoot, join(dataRoot, "repos"), join(dataRoot, "repos", repoId)];
  const identities: PathIdentity[] = [];
  for (const path of paths) {
    let actual: string;
    let stats;
    try {
      actual = await realpath(path);
      stats = await lstat(path, { bigint: true });
    } catch {
      throw new ProjectManageToolError("unsafe_data_root", "lifecycle 尚未建立受保护的本机索引目录");
    }
    const wrongOwner = typeof process.getuid === "function" && stats.uid !== BigInt(process.getuid());
    if (actual !== path || !stats.isDirectory() || stats.isSymbolicLink() || wrongOwner || (stats.mode & 0o077n) !== 0n) {
      throw new ProjectManageToolError("unsafe_data_root", "本机索引目录必须是真实且仅当前用户可访问的目录");
    }
    identities.push({ path, device: stats.dev, inode: stats.ino });
  }
  const databasePath = join(dataRoot, "repos", repoId, "index.db");
  try {
    assertRegularDatabaseFiles(databasePath);
    for (const suffix of ["", "-wal", "-shm"]) {
      const path = databasePath + suffix;
      const stats = lstatSync(path, { throwIfNoEntry: false });
      if (stats && realpathSync(path) !== path) {
        throw new ProjectManageToolError("unsafe_data_root", "索引数据库文件不能经过链接");
      }
    }
  } catch (error) {
    if (error instanceof ProjectManageToolError) throw error;
    throw new ProjectManageToolError("unsafe_data_root", "索引数据库文件或附属文件不安全");
  }
  return identities;
}

/** 固定 Git 身份元数据的有界只读；不跟随链接，不读取任何源码或归档。 */
function readGitIdentityFile(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size > 4096n) throw new Error("invalid Git identity file");
    const bytes = Buffer.alloc(Number(before.size) + 1);
    const length = readSync(fd, bytes, 0, bytes.length, 0);
    const after = fstatSync(fd, { bigint: true });
    if (BigInt(length) !== before.size || before.size !== after.size || before.mtimeNs !== after.mtimeNs
      || before.ctimeNs !== after.ctimeNs) throw new Error("unstable Git identity file");
    return bytes.subarray(0, length).toString("utf8").trim();
  } finally { closeSync(fd); }
}

async function inspectRoot(dataRoot: string, repoId: string, repositoryRoot: string): Promise<RootIdentity> {
  if (!isAbsolute(repositoryRoot) || resolve(repositoryRoot) !== repositoryRoot) {
    throw new ProjectManageToolError("repository_changed", "lifecycle 提供的仓库根不是规范绝对路径");
  }
  let actualRoot: string;
  let stats;
  try {
    actualRoot = await realpath(repositoryRoot);
    stats = await lstat(repositoryRoot, { bigint: true });
  } catch {
    throw new ProjectManageToolError("repository_changed", "已绑定仓库根当前不可访问");
  }
  if (actualRoot !== repositoryRoot || !stats.isDirectory() || stats.isSymbolicLink()) {
    throw new ProjectManageToolError("repository_changed", "已绑定仓库根身份已变化");
  }
  const identity = await repositoryIdentity(repositoryRoot).catch(() => undefined);
  if (!identity || identity.repoId !== repoId) {
    throw new ProjectManageToolError("repository_changed", "已绑定仓库身份与 repoId 不一致");
  }
  const worktrees = await listWorktrees(identity.commonDir).catch(() => undefined);
  if (!worktrees) throw new ProjectManageToolError("repository_changed", "无法核对仓库 worktree 身份");
  try {
    assertDataRootOutsideWorktrees(dataRoot, worktrees);
  } catch {
    throw new ProjectManageToolError("unsafe_data_root", "本机索引数据根必须位于全部业务 worktree 之外");
  }
  const storage = await inspectIndexStorage(dataRoot, repoId);
  const branch = (await readGit(actualRoot, ["symbolic-ref", "-q", "HEAD"])).stdout.trim();
  if (!branch.startsWith("refs/heads/") || /[\u0000-\u001f\u007f]/u.test(branch)) throw new ProjectManageToolError("repository_changed", "项目索引需要有效分支身份");
  const gitDirPath = await realpath((await readGit(actualRoot, ["rev-parse", "--absolute-git-dir"])).stdout.trim());
  const gitDirStat = lstatSync(gitDirPath, { bigint: true });
  const markerPath = join(actualRoot, ".git");
  const markerStat = lstatSync(markerPath, { bigint: true });
  const root: RootIdentity = { branch, repoId, path: actualRoot, device: stats.dev, inode: stats.ino, worktrees, storage,
    gitDir: { path: gitDirPath, device: gitDirStat.dev, inode: gitDirStat.ino },
    gitMarker: { path: markerPath, device: markerStat.dev, inode: markerStat.ino },
    gitMarkerContents: markerStat.isFile() ? readGitIdentityFile(markerPath) : null };
  if (!rootStillMatches(dataRoot, root)) throw new ProjectManageToolError("repository_changed", "项目索引 Git 身份发生变化");
  return root;
}

function rootStillMatches(dataRoot: string, root: RootIdentity): boolean {
  try {
    const stats = lstatSync(root.path, { bigint: true });
    if (!stats.isDirectory() || stats.isSymbolicLink() || stats.dev !== root.device || stats.ino !== root.inode) return false;
    if (realpathSync(root.path) !== root.path) return false;
    const gitDir = lstatSync(root.gitDir.path, { bigint: true });
    const marker = lstatSync(root.gitMarker.path, { bigint: true });
    if (!gitDir.isDirectory() || gitDir.isSymbolicLink() || realpathSync(root.gitDir.path) !== root.gitDir.path
      || gitDir.dev !== root.gitDir.device || gitDir.ino !== root.gitDir.inode || marker.isSymbolicLink()
      || marker.dev !== root.gitMarker.device || marker.ino !== root.gitMarker.inode) return false;
    if (root.gitMarkerContents === null) {
      if (!marker.isDirectory() || root.gitMarker.path !== root.gitDir.path) return false;
    } else if (!marker.isFile() || readGitIdentityFile(root.gitMarker.path) !== root.gitMarkerContents
      || !root.gitMarkerContents.startsWith("gitdir: ")
      || resolve(root.path, root.gitMarkerContents.slice(8)) !== root.gitDir.path) return false;
    if (readGitIdentityFile(join(root.gitDir.path, "HEAD")) !== `ref: ${root.branch}`) return false;
    assertDataRootOutsideWorktrees(dataRoot, [...root.worktrees]);
    for (const expected of root.storage) {
      const current = lstatSync(expected.path, { bigint: true });
      const wrongOwner = typeof process.getuid === "function" && current.uid !== BigInt(process.getuid());
      if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== expected.device || current.ino !== expected.inode
        || wrongOwner || (current.mode & 0o077n) !== 0n || realpathSync(expected.path) !== expected.path) return false;
    }
    const databasePath = join(dataRoot, "repos", root.repoId, "index.db");
    assertRegularDatabaseFiles(databasePath);
    for (const suffix of ["", "-wal", "-shm"]) {
      const path = databasePath + suffix;
      const databaseStats = lstatSync(path, { throwIfNoEntry: false });
      if (databaseStats && realpathSync(path) !== path) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function beginOperation(externalSignal: AbortSignal | undefined): ActiveOperation & { signal: AbortSignal } {
  const controller = new AbortController();
  let resolveCompletion!: () => void;
  let finished = false;
  const completion = new Promise<void>((resolvePromise) => { resolveCompletion = resolvePromise; });
  const signal = externalSignal ? AbortSignal.any([externalSignal, controller.signal]) : controller.signal;
  return {
    controller,
    completion,
    signal,
    finish() {
      if (finished) return;
      finished = true;
      resolveCompletion();
    },
  };
}

function scanConfirmationMessage(repositoryRoot: string, dataRoot: string, repoId: string, preview: boolean, branch: string): string {
  return [
    `仓库根：${repositoryRoot}`,
    `当前分支：${branch}`,
    "允许读取：该仓库内通过安全边界核对的当前代码、配置、测试与 docs/spec。",
    "固定排除：.git、依赖、构建/缓存/日志、数据库、敏感凭据、符号/硬链接、嵌套仓库；docs/prod 只枚举有限路径元数据，不读取正文。",
    `允许写入：仅仓库外本机目录 ${resolve(dataRoot, "repos", repoId)} 中的 index.db、data.db 的扫描授权元数据及 SQLite 必要附属文件。`,
    "不运行仓库脚本，不创建需求、规则、PM、业务提交或其他共享文件。init 的 preview=true 仅枚举路径，不创建 index.db 或共享输出；确认与撤销在外部 data.db 登记授权元数据。",
    preview
      ? "本次仅允许一次路径枚举预览；不会创建持续监听，不能用于批准后续 init/refresh。"
      : "本次允许仅在当前 session 和当前 lifecycle 窗口内持续扫描当前仓库/worktree/分支；工具结束后继续监听。同一存活会话断线重连时重新签发连接许可并对账；关闭会话、切换身份或宿主重启后必须重新确认。",
  ].join("\n");
}

function safeIdentifier(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > 96) return undefined;
  return /^[a-zA-Z0-9_.:@/-]+$/u.test(value) ? value : undefined;
}

function safeEnum(key: string, value: unknown): string | undefined {
  return typeof value === "string" && SAFE_ENUM_VALUES[key]?.has(value) ? value : undefined;
}

function safeRelativePath(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_PATH_LENGTH || /[\0\r\n]/u.test(value)) return undefined;
  if (value.includes("\\") || posix.isAbsolute(value)) return undefined;
  const normalized = posix.normalize(value.replace(/^\.\/+/, ""));
  if (normalized === ".." || normalized.startsWith("../") || normalized !== value) return undefined;
  return normalized;
}

interface SanitizeBudget {
  entries: number;
  omittedEntries: number;
  omittedFields: number;
  invalidOmitted: number;
}

function sanitizeArray(value: unknown[], key: string, budget: SanitizeBudget): unknown[] {
  const output: unknown[] = [];
  for (const item of value) {
    if (budget.entries >= MAX_RESULT_ENTRIES) {
      budget.omittedEntries += 1;
      if (key === "invalid" || key === "errors") budget.invalidOmitted += 1;
      continue;
    }
    budget.entries += 1;
    if (typeof item === "number" && Number.isSafeInteger(item) && item >= 0) output.push(item);
    else if (typeof item === "string") {
      const safe = key === "paths" || key === "files"
        ? safeRelativePath(item)
        : key === "exhausted"
          ? (["file_bytes", "total_text_bytes", "entries", "depth"].includes(item) ? item : undefined)
          : key === "languages"
            ? safeEnum("language", item)
            : undefined;
      if (safe !== undefined) output.push(safe);
      else budget.omittedFields += 1;
    } else if (item && typeof item === "object" && !Array.isArray(item)) {
      output.push(sanitizeObject(item as Record<string, unknown>, budget));
    } else budget.omittedFields += 1;
  }
  return output;
}

function sanitizeObject(value: Record<string, unknown>, budget: SanitizeBudget): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  const keys = Object.keys(value).sort((left, right) => {
    const a = PRIORITY_KEYS.indexOf(left);
    const b = PRIORITY_KEYS.indexOf(right);
    return (a < 0 ? Number.MAX_SAFE_INTEGER : a) - (b < 0 ? Number.MAX_SAFE_INTEGER : b) || left.localeCompare(right);
  });
  for (const key of keys) {
    const item = value[key];
    if (key === "repoId" && typeof item === "string" && new RegExp(REPO_ID_PATTERN).test(item)) output[key] = item;
    else if (SAFE_HASH_KEYS.has(key)) {
      if (item === null) output[key] = null;
      else if (typeof item === "string" && /^[0-9a-f]{40,64}$/u.test(item)) output[key] = item;
      else budget.omittedFields += 1;
    } else if (key === "requirementId") {
      if (typeof item === "string" && REQUIREMENT_ID_PATTERN.test(item)) output[key] = item;
      else if (item === null) output[key] = null;
      else budget.omittedFields += 1;
    } else if (key === "path") {
      const path = safeRelativePath(item);
      if (path) output[key] = path;
      else if (item === null) output[key] = null;
      else budget.omittedFields += 1;
    } else if (Object.hasOwn(SAFE_ENUM_VALUES, key)) {
      const identifier = safeEnum(key, item);
      if (identifier) output[key] = identifier;
      else if (key === "language" && item === null) output[key] = null;
      else budget.omittedFields += 1;
    } else if (SAFE_VERSION_KEYS.has(key)) {
      const version = safeIdentifier(item);
      if (version) output[key] = version;
      else budget.omittedFields += 1;
    } else if (SAFE_BOOLEAN_KEYS.has(key) && typeof item === "boolean") output[key] = item;
    else if (SAFE_NUMBER_KEYS.has(key) && typeof item === "number" && Number.isSafeInteger(item) && item >= 0) output[key] = item;
    else if (SAFE_OBJECT_KEYS.has(key) && item && typeof item === "object" && !Array.isArray(item)) {
      output[key] = sanitizeObject(item as Record<string, unknown>, budget);
    } else if (SAFE_ARRAY_KEYS.has(key) && Array.isArray(item)) output[key] = sanitizeArray(item, key, budget);
    else budget.omittedFields += 1;
  }
  return output;
}

function removeOneArrayEntry(value: Record<string, unknown>, targetKey: string): boolean {
  for (const [key, item] of Object.entries(value)) {
    if (key === "truncation") continue;
    if (key === targetKey && Array.isArray(item) && item.length > 0) {
      item.pop();
      return true;
    }
    if (item && typeof item === "object" && !Array.isArray(item)
      && removeOneArrayEntry(item as Record<string, unknown>, targetKey)) return true;
  }
  return false;
}

function truncationMetadata(budget: SanitizeBudget, truncated: boolean): Record<string, unknown> {
  return {
    truncated,
    maxBytes: MAX_RESULT_BYTES,
    maxEntries: MAX_RESULT_ENTRIES,
    maxPathLength: MAX_PATH_LENGTH,
    omittedEntries: budget.omittedEntries,
    redactedFields: budget.omittedFields,
    invalidOmitted: budget.invalidOmitted,
  };
}

function publicRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function shapeWorkspace(value: unknown): Record<string, unknown> | undefined {
  const workspace = publicRecord(value);
  if (!workspace) return undefined;
  return { workspaceId: workspace.workspaceId, repoId: workspace.repoId };
}

function shapeDiagnostics(value: unknown): unknown[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    const diagnostic = publicRecord(item);
    return diagnostic ? { code: diagnostic.code, path: diagnostic.path } : {};
  });
}

function shapeSkipped(value: unknown): unknown[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    const skipped = publicRecord(item);
    return skipped ? { path: skipped.path, reason: skipped.reason } : {};
  });
}

function shapeArchives(value: unknown): Record<string, unknown> {
  const archives = publicRecord(value);
  const metadata = Array.isArray(archives?.metadata) ? archives.metadata.map((item) => {
    const entry = publicRecord(item);
    return entry ? { requirementId: entry.requirementId, source: entry.source, path: entry.path, lifecycle: entry.lifecycle } : {};
  }) : [];
  const issues = Array.isArray(archives?.issues) ? archives.issues.map((item) => {
    const issue = publicRecord(item);
    return issue ? { path: issue.path, requirementId: issue.requirementId, reason: issue.reason } : {};
  }) : [];
  return { issues, metadata };
}

function shapeBudget(value: unknown): Record<string, unknown> | undefined {
  const budget = publicRecord(value);
  if (!budget) return undefined;
  const limits = publicRecord(budget.limits);
  const used = publicRecord(budget.used);
  return {
    limits: limits ? {
      maxFileBytes: limits.maxFileBytes,
      maxTotalTextBytes: limits.maxTotalTextBytes,
      maxEntries: limits.maxEntries,
      maxDepth: limits.maxDepth,
    } : undefined,
    used: used ? { entries: used.entries, textBytes: used.textBytes } : undefined,
    exhausted: budget.exhausted,
    stoppedReason: budget.stoppedReason,
  };
}

function shapePreviewFiles(value: unknown): unknown[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    const file = publicRecord(item);
    return file ? { path: file.path, kind: file.kind, language: file.language, size: file.size } : {};
  });
}

function invalidServiceResult(): never {
  throw new ProjectManageToolError("operation_failed", "项目索引操作失败；未返回底层正文或错误详情");
}

function shapeServiceResult(action: "preview" | ProjectManageAction, value: unknown): Record<string, unknown> {
  const raw = publicRecord(value);
  if (!raw || raw.action !== action) return invalidServiceResult();
  const common = {
    action: raw.action,
    workspace: shapeWorkspace(raw.workspace),
    head: raw.head,
  };
  if (action === "preview") {
    if (typeof raw.partial !== "boolean" || raw.databaseCreated !== false) return invalidServiceResult();
    return {
      ...common,
      partial: raw.partial,
      invalid: false,
      databaseCreated: raw.databaseCreated,
      budget: shapeBudget(raw.budget),
      skipped: shapeSkipped(raw.skipped),
      archives: shapeArchives(raw.archives),
      files: shapePreviewFiles(raw.files),
    };
  }
  if (action === "status") {
    if (typeof raw.initialized !== "boolean" || typeof raw.cacheVerified !== "boolean") return invalidServiceResult();
    const index = raw.index === null ? null : publicRecord(raw.index);
    if (raw.index !== null && !index) return invalidServiceResult();
    const indexStatus = index?.status;
    if (index && !["building", "dirty", "cancelled", "interrupted", "ready", "partial", "invalid"].includes(String(indexStatus))) {
      return invalidServiceResult();
    }
    return {
      ...common,
      initialized: raw.initialized,
      cacheVerified: raw.cacheVerified,
      partial: indexStatus === "partial",
      invalid: indexStatus === "invalid",
      index: index ? {
        status: index.status,
        version: index.version,
        fence: index.fence,
        currentGeneration: index.currentGeneration,
        targetGeneration: index.targetGeneration,
        updatedAt: index.updatedAt,
        diagnostics: shapeDiagnostics(index.diagnostics),
      } : undefined,
    };
  }
  if (!["ready", "partial", "invalid", "cancelled"].includes(String(raw.status))
    || typeof raw.generation !== "number") return invalidServiceResult();
  const spec = publicRecord(raw.spec);
  if (spec && !["absent", "valid", "invalid"].includes(String(spec.status))) return invalidServiceResult();
  return {
    ...common,
    status: raw.status,
    generation: raw.generation,
    partial: raw.status === "partial",
    invalid: raw.status === "invalid" || spec?.status === "invalid",
    parsedFiles: raw.parsedFiles,
    reusedFiles: raw.reusedFiles,
    readBytes: raw.readBytes,
    sourceCodepoints: raw.sourceCodepoints,
    files: raw.files,
    symbols: raw.symbols,
    codeEdges: raw.codeEdges,
    diagnostics: shapeDiagnostics(raw.diagnostics),
    skipped: shapeSkipped(raw.skipped),
    archives: shapeArchives(raw.archives),
    budget: shapeBudget(raw.budget),
    spec: spec ? { status: spec.status, contractSetHash: spec.contractSetHash, schemaHash: spec.schemaHash } : undefined,
  };
}

function sanitizeResult(value: unknown): Record<string, unknown> {
  const budget: SanitizeBudget = { entries: 0, omittedEntries: 0, omittedFields: 0, invalidOmitted: 0 };
  const output = value && typeof value === "object" && !Array.isArray(value)
    ? sanitizeObject(value as Record<string, unknown>, budget)
    : {};
  output.truncation = truncationMetadata(budget, budget.omittedEntries > 0);
  let encoded = JSON.stringify(output);
  const removalOrder = ["files", "paths", "items", "metadata", "languages", "exhausted", "warnings", "diagnostics", "skipped", "issues", "errors", "invalid"];
  while (Buffer.byteLength(encoded) > MAX_RESULT_BYTES) {
    const key = removalOrder.find((candidate) => removeOneArrayEntry(output, candidate));
    if (!key) break;
    budget.omittedEntries += 1;
    if (key === "invalid" || key === "errors" || key === "issues" || key === "diagnostics") budget.invalidOmitted += 1;
    output.truncation = truncationMetadata(budget, true);
    encoded = JSON.stringify(output);
  }
  if (Buffer.byteLength(encoded) <= MAX_RESULT_BYTES) return output;
  const fallback: Record<string, unknown> = {};
  for (const key of ["action", "status", "state", "generation", "previousGeneration", "initialized", "partial", "invalid", "counts"]) {
    if (output[key] !== undefined && !Array.isArray(output[key])) fallback[key] = output[key];
  }
  fallback.truncation = { ...truncationMetadata(budget, true), outputBudgetExceeded: true };
  return fallback;
}

function progressResult(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { status: "running" };
  const input = value as Record<string, unknown>;
  const output: Record<string, unknown> = { status: "running" };
  const phase = safeEnum("phase", input.phase) ?? safeEnum("status", input.status);
  if (phase) output.phase = phase;
  const path = safeRelativePath(input.path);
  if (path) output.path = path;
  for (const key of ["completed", "total", "entries", "files", "textBytes", "symbols", "rules"] as const) {
    const item = input[key];
    if (typeof item === "number" && Number.isSafeInteger(item) && item >= 0) output[key] = item;
  }
  return output;
}

function textResult(value: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }], details: value };
}

function isCancellation(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (error instanceof Error && (error.name === "AbortError" || error.message === "This operation was aborted"));
}

async function defaultOpenService(input: OpenProjectIndexServiceInput): Promise<ProjectIndexServiceHandle> {
  return ProjectIndexService.open(input);
}

function serviceRequestMatches(
  request: ProjectIndexAuthorizationRequest,
  allowedActions: ReadonlySet<string>,
  repoId: string,
  repositoryRoot: string,
): boolean {
  if (!request || typeof request !== "object" || request.repoId !== repoId || !allowedActions.has(request.action)) return false;
  if (!["before", "after", "read", "publish", "return"].includes(request.phase)) return false;
  if (request.repositoryRoot !== repositoryRoot) return false;
  if (request.workspaceId !== null && !/^[0-9a-f]{64}$/u.test(request.workspaceId)) return false;
  if (request.path !== null) {
    const path = safeRelativePath(request.path);
    if (!path || path.toLowerCase() === "docs/prod" || path.toLowerCase().startsWith("docs/prod/")) return false;
  }
  return Object.keys(request).every((key) => ["action", "phase", "repoId", "repositoryRoot", "workspaceId", "path"].includes(key));
}

export function createProjectManageTool(options: CreateProjectManageToolOptions): ProjectManageToolRuntime {
  if (!isAbsolute(options.dataRoot)) throw new ProjectManageToolError("unsafe_data_root", "本机索引数据根必须是绝对路径");
  let activeHost: ProjectManageHostContext | undefined;
  let disposed = true;
  const grants = new Map<string, ScanGrant>();
  const operations = new Set<ActiveOperation>();

  const startSession = (host: ProjectManageHostContext): void => {
    if (operations.size > 0) throw new ProjectManageToolError("host_unavailable", "旧 session 的项目索引操作尚未真实结束");
    grants.clear();
    activeHost = snapshotHost(host);
    disposed = false;
  };

  const shutdown = async (): Promise<void> => {
    disposed = true;
    activeHost = undefined;
    grants.clear();
    const current = [...operations];
    for (const operation of current) {
      operation.controller.abort();
      operation.service?.cancel?.();
    }
    await Promise.allSettled(current.map((operation) => operation.completion));
  };

  const tool: ToolDefinition<typeof publicParameters, Record<string, unknown>> = {
    name: "pi_company_project_manage",
    label: "管理项目索引",
    description: "初始化、查看或刷新当前 lifecycle 已接入仓库的本机索引；workspace-prepare/workspace-recycle 为指定需求创建或回收独立分支与 worktree，均需用户在界面确认。init 可传 preview=true 仅预览；不接受路径、角色、主体、SQL、正文或 Git 命令。输出最多 32KiB/100 项并明确标记截断。",
    promptSnippet: "通过受控宿主入口预览、初始化、查看或刷新当前项目索引",
    parameters: publicParameters,
    executionMode: "sequential",
    async execute(_toolCallId, rawParams, externalSignal, onUpdate, ctx) {
      const operation = beginOperation(externalSignal);
      operations.add(operation);
      try {
        operation.signal.throwIfAborted();
        const params = checkedParams(rawParams);
        const host = await options.resolveHost(ctx).catch(() => {
          throw new ProjectManageToolError("host_unavailable", "无法取得当前 lifecycle 窗口");
        });
        assertSessionHost(activeHost, host, ctx);
        if (!currentHostMatches(options, activeHost, host, ctx)) {
          throw new ProjectManageToolError("stale_window", "项目管理工具上下文与当前 lifecycle 窗口不一致");
        }
        const repository = host.repositories.get(params.repoId);
        if (!repository) throw new ProjectManageToolError("foreign_repo", "repoId 不属于当前 lifecycle 已接入 workspace");
        let root = await inspectRoot(options.dataRoot, params.repoId, repository.path);
        if (params.action === "workspace-prepare" || params.action === "workspace-recycle") {
          if (!ctx.hasUI) throw new ProjectManageToolError("workspace_confirmation_required", "创建或回收工作区需要当前 session 的真实宿主 UI 确认");
          const workspace = await WorkspaceManageService.open({ repositoryRoot: root.path, dataRoot: options.dataRoot, repoId: params.repoId,
            confirm: (title, message) => ctx.ui.confirm(title, message, { signal: operation.signal }) });
          try {
            const result = params.action === "workspace-prepare"
              ? await workspace.prepare({ requirementId: params.requirementId, operationId: params.operationId })
              : await workspace.recycle({ requirementId: params.requirementId, operationId: params.operationId });
            return textResult({ action: params.action, requirementId: result.requirementId, status: result.status, branch: result.branch,
              path: result.path, baseCommit: result.baseCommit });
          } catch (error) {
            if (error instanceof WorkspaceManageError) {
              return textResult({ action: params.action, status: "blocked", code: error.code, blockers: error.blockers });
            }
            throw new ProjectManageToolError("workspace_failed", "工作区操作失败；未返回底层错误详情");
          }
        }

        if (params.action === "recovery-check" || params.action === "backup" || params.action === "restore") {
          if (!ctx.hasUI) throw new ProjectManageToolError("workspace_confirmation_required", "恢复对账、备份与恢复需要当前 session 的真实宿主 UI 确认");
          const maintenance = { repositoryRoot: root.path, dataRoot: options.dataRoot, repoId: params.repoId,
            confirm: (title: string, message: string) => ctx.ui.confirm(title, message, { signal: operation.signal }) };
          try {
            if (params.action === "recovery-check") {
              const receipt = await recoveryCheck(maintenance, params);
              return textResult({ action: params.action, status: receipt.state, requirementsChecked: "requirementsChecked" in receipt ? receipt.requirementsChecked : 0 });
            }
            if (params.action === "backup") {
              const receipt = await backup(maintenance, params);
              return textResult({ action: params.action, status: receipt.state, operationId: receipt.operationId, manifestHash: receipt.manifestHash,
                filesCopied: receipt.filesCopied, requirements: receipt.requirements.length });
            }
            if (params.action !== "restore") throw new ProjectManageToolError("invalid_action", "未知的维护 action");
            const receipt = await restore(maintenance, params);
            return textResult({ action: params.action, status: receipt.restoreStatus, operationId: receipt.operationId, executable: receipt.executable,
              filesRestored: receipt.filesRestored, requirements: receipt.requirements.map((item) => ({ requirementId: item.requirementId, recoveryReason: item.recoveryReason })) });
          } catch (error) {
            if (error instanceof ProjectMaintenanceError) return textResult({ action: params.action, status: "blocked", code: error.code });
            throw new ProjectManageToolError("maintenance_failed", "维护操作失败；未返回底层错误详情");
          }
        }

        const serviceAction: "preview" | ProjectManageAction = params.action === "init" && params.preview === true ? "preview" : params.action;
        if (serviceAction !== "status") {
          const grant = grants.get(params.repoId);
          const reusable = serviceAction !== "preview" && grant
            && grant.branch === root.branch
            && grant.sessionId === host.sessionId
            && grant.windowId === host.windowId
            && grant.repositoryRoot === root.path
            && grant.device === root.device
            && grant.inode === root.inode;
          if (!reusable) {
            if (!ctx.hasUI) {
              throw new ProjectManageToolError("scan_confirmation_required", "项目索引扫描需要当前 session 的真实宿主 UI 确认");
            }
            const approved = await ctx.ui.confirm(
              serviceAction === "preview" ? "确认预览项目索引范围" : "确认项目索引范围",
              scanConfirmationMessage(root.path, options.dataRoot, params.repoId, serviceAction === "preview", root.branch),
              { signal: operation.signal },
            );
            if (!approved) throw new ProjectManageToolError("scan_declined", "用户取消或拒绝项目索引扫描授权");
            const afterPrompt = await options.resolveHost(ctx).catch(() => {
              throw new ProjectManageToolError("host_unavailable", "确认后无法取得当前 lifecycle 窗口");
            });
            assertSessionHost(activeHost, afterPrompt, ctx);
            if (!sameHost(host, afterPrompt) || !currentHostMatches(options, activeHost, afterPrompt, ctx)) {
              throw new ProjectManageToolError("stale_window", "确认期间 lifecycle 窗口身份已变化");
            }
            const afterRoot = await inspectRoot(options.dataRoot, params.repoId, afterPrompt.repositories.get(params.repoId)!.path);
            if (afterRoot.branch !== root.branch || afterRoot.path !== root.path || afterRoot.device !== root.device || afterRoot.inode !== root.inode
              || afterRoot.gitDir.path !== root.gitDir.path || afterRoot.gitDir.inode !== root.gitDir.inode || afterRoot.gitDir.device !== root.gitDir.device
              || afterRoot.gitMarker.inode !== root.gitMarker.inode || afterRoot.gitMarker.device !== root.gitMarker.device
              || afterRoot.gitMarkerContents !== root.gitMarkerContents) {
              throw new ProjectManageToolError("repository_changed", "确认期间仓库根身份已变化");
            }
            root = afterRoot;
            if (serviceAction !== "preview") grants.set(params.repoId, {
              branch: root.branch,
              sessionId: host.sessionId,
              windowId: host.windowId,
              repoId: params.repoId,
              repositoryRoot: root.path,
              device: root.device,
              inode: root.inode,
            });
          }
        }

        let updates = 0;
        const onProgress = (progress: { phase: "scan" | "read" | "parse" | "verify"; path: string; completed: number; total: number }): void => {
          if (updates >= MAX_PROGRESS_UPDATES || operation.signal.aborted) return;
          updates += 1;
          onUpdate?.(textResult(progressResult(progress)));
        };
        const allowedActions = SERVICE_ACTIONS[serviceAction];
        const authorize = (request: ProjectIndexAuthorizationRequest): boolean => {
          if (disposed || operation.signal.aborted || !operations.has(operation)) return false;
          if (!currentHostMatches(options, activeHost, host, ctx) || !rootStillMatches(options.dataRoot, root)) return false;
          if (serviceAction !== "status" && serviceAction !== "preview") {
            const grant = grants.get(params.repoId);
            if (!grant || grant.sessionId !== host.sessionId || grant.windowId !== host.windowId
              || grant.repositoryRoot !== root.path || grant.device !== root.device || grant.inode !== root.inode) return false;
          }
          return serviceRequestMatches(request, allowedActions, params.repoId, root.path);
        };

        if (!authorize({
          action: serviceAction,
          phase: "before",
          repoId: params.repoId,
          repositoryRoot: root.path,
          workspaceId: null,
          path: null,
        })) {
          throw new ProjectManageToolError("stale_window", "项目索引操作授权在启动前已失效");
        }
        const continuousGrant = grants.get(params.repoId);
        const authorizeContinuous = (): boolean => serviceAction !== "preview" && !!continuousGrant
          && grants.get(params.repoId) === continuousGrant && continuousGrant.branch === root.branch && !disposed
          && currentHostMatches(options, activeHost, host, ctx) && rootStillMatches(options.dataRoot, root);
        const service = await (options.openService ?? defaultOpenService)(Object.freeze({
          repositoryRoot: root.path,
          dataRoot: options.dataRoot,
          repoId: params.repoId,
          authorize,
          action: serviceAction,
          host: snapshotHost(host),
          authorizedBranch: root.branch,
          authorizeContinuous,
        }));
        operation.service = service;
        let rawResult: unknown;
        try {
          const operationOptions: ProjectIndexOperationOptions = {
            signal: operation.signal,
            limits: Object.freeze({ ...DEFAULT_INDEX_LIMITS }),
            onProgress,
          };
          switch (serviceAction) {
            case "preview": rawResult = await service.preview(operationOptions); break;
            case "init": rawResult = await service.init(operationOptions); break;
            case "refresh": rawResult = await service.refresh(operationOptions); break;
            case "status": rawResult = await service.status(); break;
          }
        } finally {
          await service.close?.();
        }
        operation.signal.throwIfAborted();
        const finalHost = await options.resolveHost(ctx).catch(() => {
          throw new ProjectManageToolError("host_unavailable", "项目索引操作结束时 lifecycle 窗口不可用");
        });
        assertSessionHost(activeHost, finalHost, ctx);
        if (!sameHost(host, finalHost) || !currentHostMatches(options, activeHost, finalHost, ctx) || !rootStillMatches(options.dataRoot, root)) {
          throw new ProjectManageToolError("repository_changed", "项目索引操作期间宿主或仓库身份已变化");
        }
        return textResult(sanitizeResult(shapeServiceResult(serviceAction, rawResult)));
      } catch (error) {
        if (isCancellation(error, operation.signal)) {
          throw new ProjectManageToolError("cancelled", "项目索引操作已取消");
        }
        if (error instanceof ProjectManageToolError) throw error;
        throw new ProjectManageToolError("operation_failed", "项目索引操作失败；未返回底层正文或错误详情");
      } finally {
        operations.delete(operation);
        operation.finish();
      }
    },
  };

  return { tool, startSession, shutdown };
}
