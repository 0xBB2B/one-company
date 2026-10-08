import { lstat, realpath } from "node:fs/promises";
import { chooseOrWriteWindow, confirmWindow, mutedLines } from "./question-window.ts";
import type { ProgramWindow } from "./question-window.ts";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { isAbsolute, join, posix, resolve } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { assertDataRootOutsideWorktrees, assertRegularDatabaseFiles } from "./database-paths.ts";
import { listWorktrees, repositoryIdentity } from "./identity.ts";
import type { ProjectIndexOperationOptions, ProjectIndexServiceOptions } from "./project-index-service.ts";
import { DEFAULT_INDEX_LIMITS } from "./project-index-policy.ts";
import { readGit } from "./git-read.ts";
import { WorkspaceManageError, WorkspaceManageService } from "./workspace-manage.ts";
import { backup, ProjectMaintenanceError, recoveryCheck, restore } from "./project-maintenance.ts";
import { requestParameters, shapeIssue, unwrapRequest } from "./tool-request.ts";
import { adviceOf, commandOutputTail, toolFailure, toolStep } from "./tool-failure.ts";
import type { FailureAdvice } from "./tool-failure.ts";
import { MAX_CONVENTIONS_BYTES, ProjectConventionsError, updateConventions } from "./project-conventions.ts";

const REPO_ID_PATTERN = "^[0-9a-f]{64}$";
const REQUIREMENT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const MAX_RESULT_BYTES = 32 * 1024;
const MAX_RESULT_ENTRIES = 100;
const MAX_PATH_LENGTH = 512;

const UUID_V7 = "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";
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
  "conventions-update": Type.Object({
    action: Type.Literal("conventions-update"),
    repoId: Type.String({ pattern: REPO_ID_PATTERN }),
    content: Type.String({ maxLength: MAX_CONVENTIONS_BYTES }),
  }, { additionalProperties: false }),
  restore: Type.Object({
    action: Type.Literal("restore"),
    repoId: Type.String({ pattern: REPO_ID_PATTERN }),
    operationId: Type.String({ pattern: UUID_V7 }),
    backupOperationId: Type.String({ pattern: UUID_V7 }),
    backupManifestHash: Type.String({ pattern: REPO_ID_PATTERN }),
  }, { additionalProperties: false }),
} as const;

const publicParameters = requestParameters(Object.values(actionSchemas));
export const PROJECT_MANAGE_PARAMETERS = publicParameters;

export type ProjectManageAction = "init" | "status" | "refresh";

type WorkspaceAction = "workspace-prepare" | "workspace-recycle";
type ProjectManageParams =
  | { action: ProjectManageAction; repoId: string; preview?: boolean }
  | { action: WorkspaceAction; repoId: string; requirementId: string; operationId: string }
  | { action: "recovery-check" | "backup"; repoId: string; operationId: string }
  | { action: "restore"; repoId: string; operationId: string; backupOperationId: string; backupManifestHash: string }
  | { action: "conventions-update"; repoId: string; content: string };

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
}

export type OpenProjectIndexServiceInput = Readonly<Pick<ProjectIndexServiceOptions, "repositoryRoot" | "dataRoot" | "repoId">>;

export type OpenProjectIndexService = (input: OpenProjectIndexServiceInput) => Promise<ProjectIndexServiceHandle>;

export interface CreateProjectManageToolOptions {
  readonly dataRoot: string;
  readonly resolveHost: (ctx: ExtensionContext) => Promise<ProjectManageHostContext>;
  readonly currentHost: (ctx: ExtensionContext) => ProjectManageHostContext;
  readonly openService: OpenProjectIndexService;
}

export interface ProjectManageToolRuntime {
  readonly tool: ToolDefinition<typeof publicParameters, Record<string, unknown>>;
  startSession(host: ProjectManageHostContext): void;
  shutdown(): Promise<void>;
}

const CHANGED = "重新发起一次操作；反复出现就请用户确认仓库和窗口没有被切换";
const PROJECT_MANAGE_NEXT: Record<ProjectManageToolError["code"], string> = {
  invalid_action: "改用可用的 action",
  invalid_shape: "按字段要求改正参数后重试",
  host_unavailable: "稍后重试；窗口仍未就绪就请用户重开窗口",
  stale_session: "会话已切换，在当前会话里重新发起",
  stale_window: CHANGED,
  foreign_repo: "改用当前工作区列出的仓库编号",
  repository_changed: CHANGED,
  unsafe_data_root: "请用户检查本机数据目录的位置、权限和链接",
  scan_confirmation_required: "在有界面的主窗口里再做，扫描前要用户确认",
  scan_declined: "不要重试；确实需要时先向用户说明原因再问",
  cancelled: "操作已取消；需要时重新发起",
  operation_failed: "重试一次；仍然失败就把原因告诉用户",
  workspace_confirmation_required: "在有界面的主窗口里再做，这个操作要用户确认",
  workspace_failed: "按原因处理；需要改动仓库时请用户介入",
  maintenance_failed: "按原因处理；仍然失败就把原因告诉用户",
  conventions_confirmation_required: "在有界面的主窗口里再做，写入项目规范要用户在窗口里选择",
  conventions_failed: "按原因处理；仍然失败就把原因告诉用户",
};
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
    | "maintenance_failed"
    | "conventions_confirmation_required"
    | "conventions_failed";

  readonly advice: FailureAdvice;
  constructor(code: ProjectManageToolError["code"], message: string) {
    super(message);
    this.name = "ProjectManageToolError";
    this.code = code;
    this.advice = { why: message, next: PROJECT_MANAGE_NEXT[code] };
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
  finish(): void;
}

const SAFE_ENUM_VALUES: Readonly<Record<string, ReadonlySet<string>>> = Object.freeze({
  action: new Set(["preview", "init", "status", "refresh"]),
  status: new Set(["building", "ready", "partial", "invalid", "cancelled", "interrupted"]),
  reason: new Set([
    "prod_archive", "excluded_directory", "excluded_file", "sensitive", "database", "symbolic_link", "hard_link",
    "special_file", "unreadable", "outside_root", "nested_repository", "git_ignored", "file_too_large", "total_text_limit", "entry_limit",
    "depth_limit", "unstable", "cancelled", "binary", "invalid_utf8", "invalid_archive_name",
    "duplicate_requirement_id",
  ]),
  code: new Set(["syntax_error", "unsupported_language", "unreadable", "budget_exceeded", "parser_unavailable", "unknown"]),
  kind: new Set(["code", "document", "config", "unsupported"]),
  language: new Set(["ts", "tsx", "js", "jsx", "go"]),
  stoppedReason: new Set(["complete", "cancelled", "entry_limit"]),
  source: new Set(["archive", "local"]),
  lifecycle: new Set(["unknown"]),
});
const SAFE_HASH_KEYS = new Set(["workspaceId", "head"]);
const SAFE_BOOLEAN_KEYS = new Set(["initialized", "partial", "invalid", "databaseCreated", "cacheVerified"]);
const SAFE_NUMBER_KEYS = new Set([
  "generation", "currentGeneration", "targetGeneration", "version", "fence", "updatedAt", "size", "entries",
  "maxFileBytes", "maxTotalTextBytes", "maxEntries", "maxDepth", "files", "parsedFiles", "reusedFiles", "readBytes",
  "sourceCodepoints", "symbols", "codeEdges", "textBytes",
]);
const SAFE_OBJECT_KEYS = new Set(["budget", "limits", "used", "workspace", "index", "archives"]);
const SAFE_ARRAY_KEYS = new Set(["files", "skipped", "exhausted", "metadata", "issues", "diagnostics"]);
const PRIORITY_KEYS = [
  "status", "generation", "initialized", "partial", "invalid", "skipped", "budget", "archives", "issues", "metadata", "files",
];

function checkedParams(raw: unknown): ProjectManageParams {
  const value = unwrapRequest(raw);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProjectManageToolError("invalid_shape", "project_manage 参数须为 { request: { action, repoId, ... } }");
  }
  const action = (value as { action?: unknown }).action;
  if (typeof action !== "string" || !Object.hasOwn(actionSchemas, action)) {
    throw new ProjectManageToolError("invalid_action", `未知的 project_manage action；可用 action：${Object.keys(actionSchemas).join("、")}`);
  }
  const schema = actionSchemas[action as keyof typeof actionSchemas];
  if (!Value.Check(schema, value)) {
    throw new ProjectManageToolError("invalid_shape", `project_manage 参数不符合该 action 的固定字段白名单：${shapeIssue(schema, value)}`);
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

/** 索引由守护进程持有、只针对主工作区；在链接 worktree 中执行时，确认框须显示实际被索引的主工作区。 */
async function indexedWorkspace(path: string): Promise<{ root: string; branch: string }> {
  const [main] = await listWorktrees((await repositoryIdentity(path)).commonDir);
  const root = await realpath(main ?? path);
  return { root, branch: (await readGit(root, ["symbolic-ref", "--quiet", "HEAD"])).stdout.trim() };
}

function scanConfirmationLines(repositoryRoot: string, dataRoot: string, repoId: string, preview: boolean, branch: string): string[] {
  return [
    `仓库根：${repositoryRoot}`,
    `当前分支：${branch}`,
    "允许读取：该仓库内通过安全边界核对的当前代码、配置、测试与文档。",
    "固定排除：.git、被 Git 忽略的路径、依赖、构建/缓存/日志、数据库、敏感凭据、符号/硬链接、嵌套仓库；docs/prod 只枚举有限路径元数据，不读取正文。",
    `允许写入：仅仓库外本机目录 ${resolve(dataRoot, "repos", repoId)} 中的 index.db、data.db 的初始化登记及 SQLite 必要附属文件。`,
    "不运行仓库脚本，不创建需求、规则、PM、业务提交或其他共享文件。init 的 preview=true 仅枚举路径，不创建 index.db 或共享输出。",
    preview
      ? "本次仅允许一次路径枚举预览，不能用于批准后续 init/refresh。"
      : "初始化后由仓库守护进程持有索引，不监听文件；每次知识查询前自动对账当前文件，窗口关闭后 PM 与子代理仍可查询。",
  ];
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
      continue;
    }
    budget.entries += 1;
    if (typeof item === "number" && Number.isSafeInteger(item) && item >= 0) output.push(item);
    else if (typeof item === "string") {
      const safe = key === "files"
        ? safeRelativePath(item)
        : key === "exhausted"
          ? (["file_bytes", "total_text_bytes", "entries", "depth"].includes(item) ? item : undefined)
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
  throw new ProjectManageToolError("operation_failed", "项目索引服务返回的结果格式不对");
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
    if (index && !["building", "cancelled", "interrupted", "ready", "partial", "invalid"].includes(String(indexStatus))) {
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
  return {
    ...common,
    status: raw.status,
    generation: raw.generation,
    partial: raw.status === "partial",
    invalid: raw.status === "invalid",
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
  };
}

function sanitizeResult(value: unknown): Record<string, unknown> {
  const budget: SanitizeBudget = { entries: 0, omittedEntries: 0, omittedFields: 0, invalidOmitted: 0 };
  const output = value && typeof value === "object" && !Array.isArray(value)
    ? sanitizeObject(value as Record<string, unknown>, budget)
    : {};
  output.truncation = truncationMetadata(budget, budget.omittedEntries > 0);
  let encoded = JSON.stringify(output);
  const removalOrder = ["files", "metadata", "exhausted", "diagnostics", "skipped", "issues"];
  while (Buffer.byteLength(encoded) > MAX_RESULT_BYTES) {
    const key = removalOrder.find((candidate) => removeOneArrayEntry(output, candidate));
    if (!key) break;
    budget.omittedEntries += 1;
    if (key === "issues" || key === "diagnostics") budget.invalidOmitted += 1;
    output.truncation = truncationMetadata(budget, true);
    encoded = JSON.stringify(output);
  }
  if (Buffer.byteLength(encoded) <= MAX_RESULT_BYTES) return output;
  const fallback: Record<string, unknown> = {};
  for (const key of ["action", "status", "generation", "initialized", "partial", "invalid"]) {
    if (output[key] !== undefined && !Array.isArray(output[key])) fallback[key] = output[key];
  }
  fallback.truncation = { ...truncationMetadata(budget, true), outputBudgetExceeded: true };
  return fallback;
}

function textResult(value: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }], details: value };
}

function isCancellation(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (error instanceof Error && (error.name === "AbortError" || error.message === "This operation was aborted"));
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
    for (const operation of current) operation.controller.abort();
    await Promise.allSettled(current.map((operation) => operation.completion));
  };

  const tool: ToolDefinition<typeof publicParameters, Record<string, unknown>> = {
    name: "one_company_project_manage",
    label: "管理项目索引",
    description: "参数写成 {request:{action,...}}，只填该 action 格式里的字段；operationId 每次新生成 UUIDv7，requirementId 取自需求工具结果，不要自编。初始化、查看或刷新当前 lifecycle 已接入仓库的本机索引；workspace-prepare/workspace-recycle 为指定需求创建或回收独立分支与 worktree，均需用户在界面确认；结果里的 version 是需求的新版本号，后续需求操作要用它。conventions-update 以 content 给出仓库根目录 AGENTS.md 的完整新内容，界面显示与现有文件的差异，用户选「写入」后才写文件，此后派出的子代理按新内容工作；用户输入修改意见时结果为 status=revise。init 可传 preview=true 仅预览；不接受路径、角色、主体、SQL、正文或 Git 命令。输出最多 32KiB/100 项并明确标记截断。",
    promptSnippet: "预览、初始化、查看或刷新当前项目索引；为需求建立或回收独立工作区；更新项目规范 AGENTS.md",
    parameters: publicParameters,
    executionMode: "sequential",
    async execute(_toolCallId, rawParams, externalSignal, _onUpdate, ctx) {
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
            confirm: (window) => confirmWindow(ctx, window, operation.signal) });
          try {
            const result = params.action === "workspace-prepare"
              ? await workspace.prepare({ requirementId: params.requirementId, operationId: params.operationId })
              : await workspace.recycle({ requirementId: params.requirementId, operationId: params.operationId });
            return textResult({ action: params.action, requirementId: result.requirementId, status: result.status, branch: result.branch,
              path: result.path, baseCommit: result.baseCommit, version: workspace.requirementVersion(result.requirementId) });
          } catch (error) {
            if (error instanceof WorkspaceManageError) {
              return textResult({ action: params.action, status: "blocked", reason: error.advice.why, next: error.advice.next });
            }
            if (adviceOf(error)) throw error;
            throw new ProjectManageToolError("workspace_failed", `工作区操作失败：${commandOutputTail(error)}`);
          }
        }

        if (params.action === "conventions-update") {
          if (!ctx.hasUI) throw new ProjectManageToolError("conventions_confirmation_required", "更新项目规范需要当前 session 的真实宿主 UI 确认");
          try {
            const result = await updateConventions({ repositoryRoot: root.path, content: params.content,
              decide: (window) => chooseOrWriteWindow(ctx, window, operation.signal) });
            return textResult({ action: params.action, ...result,
              ...(result.status === "revise" ? { next: "feedback 是用户的修改意见原话；按它改好 AGENTS.md 全文后重新提交 conventions-update" } : {}) });
          } catch (error) {
            if (error instanceof ProjectConventionsError) return textResult({ action: params.action, status: "blocked", reason: error.advice.why, next: error.advice.next });
            if (adviceOf(error)) throw error;
            throw new ProjectManageToolError("conventions_failed", `更新项目规范失败：${commandOutputTail(error)}`);
          }
        }

        if (params.action === "recovery-check" || params.action === "backup" || params.action === "restore") {
          if (!ctx.hasUI) throw new ProjectManageToolError("workspace_confirmation_required", "恢复对账、备份与恢复需要当前 session 的真实宿主 UI 确认");
          const maintenance = { repositoryRoot: root.path, dataRoot: options.dataRoot, repoId: params.repoId,
            confirm: (window: ProgramWindow) => confirmWindow(ctx, window, operation.signal) };
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
            if (error instanceof ProjectMaintenanceError) return textResult({ action: params.action, status: "blocked", reason: error.advice.why, next: error.advice.next });
            if (adviceOf(error)) throw error;
            throw new ProjectManageToolError("maintenance_failed", `维护操作失败：${commandOutputTail(error)}`);
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
            const approved = await confirmWindow(ctx, {
              title: serviceAction === "preview" ? "确认预览项目索引范围" : "确认项目索引范围",
              lines: mutedLines(await indexedWorkspace(root.path).then((indexed) =>
                scanConfirmationLines(indexed.root, options.dataRoot, params.repoId, serviceAction === "preview", indexed.branch))),
            }, operation.signal);
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

        const grant = grants.get(params.repoId);
        const needsGrant = serviceAction === "init" || serviceAction === "refresh";
        if (disposed || operation.signal.aborted || !operations.has(operation)
          || !currentHostMatches(options, activeHost, host, ctx) || !rootStillMatches(options.dataRoot, root)
          || (needsGrant && (!grant || grant.sessionId !== host.sessionId || grant.windowId !== host.windowId
            || grant.repositoryRoot !== root.path || grant.device !== root.device || grant.inode !== root.inode))) {
          throw new ProjectManageToolError("stale_window", "项目索引操作授权在启动前已失效");
        }
        const service = await options.openService(Object.freeze({
          repositoryRoot: root.path,
          dataRoot: options.dataRoot,
          repoId: params.repoId,
        }));
        const operationOptions: ProjectIndexOperationOptions = {
          signal: operation.signal,
          limits: Object.freeze({ ...DEFAULT_INDEX_LIMITS }),
        };
        let rawResult: unknown;
        switch (serviceAction) {
          case "preview": rawResult = await service.preview(operationOptions); break;
          case "init": rawResult = await service.init(operationOptions); break;
          case "refresh": rawResult = await service.refresh(operationOptions); break;
          case "status": rawResult = await service.status(); break;
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
          throw toolFailure(toolStep("one_company_project_manage", rawParams), new ProjectManageToolError("cancelled", "项目索引操作已取消"));
        }
        throw toolFailure(toolStep("one_company_project_manage", rawParams),
          error instanceof ProjectManageToolError || adviceOf(error) ? error : new ProjectManageToolError("operation_failed", "项目索引操作失败；底层错误可能含正文，不回显"));
      } finally {
        operations.delete(operation);
        operation.finish();
      }
    },
  };

  return { tool, startSession, shutdown };
}
