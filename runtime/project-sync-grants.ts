import { createHash, randomUUID } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type { ClientInfo } from "../daemon/server.ts";
import type { DaemonConnectionIdentity } from "./daemon-client.ts";
import { LocalDatabase, repositoryDatabase } from "./database.ts";
import { assertDataRootOutsideWorktrees, assertRegularDatabaseFiles } from "./database-paths.ts";
import { listWorktrees, repositoryIdentity } from "./identity.ts";
import { readGit } from "./git-read.ts";

export const PROJECT_INDEX_GRANT_NAMESPACE = "project_index_grants";
const REPO_ID = /^[0-9a-f]{64}$/u;
const WORKSPACE_ID = /^[0-9a-f]{64}$/u;
const GRANT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
function validBranch(value: string): boolean {
  return value.startsWith("refs/heads/") && value.length > "refs/heads/".length && value.length <= 512
    && !Array.from(value).some((character) => {
      const code = character.codePointAt(0)!;
      return code <= 0x1f || code === 0x7f;
    });
}

export interface ProjectSyncGrantWorkspace {
  readonly repoId: string;
  readonly workspaceId: string;
  readonly root: string;
  readonly branch: string;
}

export interface ProjectSyncGrantAuthorizationRequest {
  readonly action: "issue_project_index_scan";
  readonly repoId: string;
  readonly workspaceId: string;
  readonly repositoryRoot: string;
  readonly branch: string;
  readonly windowId: string;
  readonly sessionId: string;
  readonly pid: number;
}

export type ProjectSyncGrantAuthorize = (
  request: Readonly<ProjectSyncGrantAuthorizationRequest>,
  hostPrincipal: object,
) => boolean;

export interface ProjectSyncGrantIssuerOptions {
  readonly dataRoot: string;
  readonly repoId: string;
  readonly commonDir: string;
  readonly hostPrincipal: object;
  readonly currentHostPrincipal: () => object | null;
  readonly authorize?: ProjectSyncGrantAuthorize;
  /** 必须来自当前已认证的 DaemonClient；缺失或断开时签发默认拒绝。 */
  readonly currentConnectionIdentity?: () => Readonly<DaemonConnectionIdentity> | null;
}

export interface IssuedProjectSyncGrant {
  /** 仅可信宿主与daemon控制面传递；不得写日志或返回模型。 */
  readonly grantId: string;
  readonly workspace: ProjectSyncGrantWorkspace;
}

export interface ValidatedProjectSyncGrant {
  readonly workspace: ProjectSyncGrantWorkspace;
  readonly windowId: string;
  readonly sessionId: string;
  readonly pid: number;
}

interface StoredGrant {
  schemaVersion: 2;
  grantHash: string;
  issuerId: string;
  daemonInstanceId: string;
  connectionId: string;
  repoId: string;
  workspaceId: string;
  root: string;
  branch: string;
  commonDir: string;
  gitDir: string;
  rootDevice: string;
  rootInode: string;
  gitDevice: string;
  gitInode: string;
  windowId: string;
  sessionId: string;
  pid: number;
  status: "active" | "revoked";
  issuedAt: string;
  revokedAt: string | null;
}

interface OwnedGrant {
  readonly client: ClientInfo;
  readonly snapshot: Readonly<Pick<ClientInfo, "windowId" | "sessionId" | "pid" | "cwd" | "workspaceRoot" | "daemonInstanceId" | "connectionId"> & { repoIds: readonly string[] }>;
  active: boolean;
}

export class ProjectSyncGrantError extends Error {
  readonly code:
    | "authorization_denied"
    | "invalid_identity"
    | "invalid_storage"
    | "grant_invalid"
    | "issuer_closed";

  constructor(code: ProjectSyncGrantError["code"], message: string) {
    super(message);
    this.name = "ProjectSyncGrantError";
    this.code = code;
  }
}

function hashParts(...parts: string[]): string {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(String(Buffer.byteLength(part))).update(":").update(part).update("|");
  return hash.digest("hex");
}

function sameClient(client: ClientInfo, snapshot: OwnedGrant["snapshot"]): boolean {
  return client.daemonInstanceId === snapshot.daemonInstanceId
    && client.connectionId === snapshot.connectionId
    && client.windowId === snapshot.windowId
    && client.sessionId === snapshot.sessionId
    && client.pid === snapshot.pid
    && client.cwd === snapshot.cwd
    && client.workspaceRoot === snapshot.workspaceRoot
    && client.repoIds.length === snapshot.repoIds.length
    && client.repoIds.every((value, index) => value === snapshot.repoIds[index]);
}

function snapshotClient(client: ClientInfo): OwnedGrant["snapshot"] {
  return Object.freeze({
    daemonInstanceId: client.daemonInstanceId,
    connectionId: client.connectionId,
    windowId: client.windowId,
    sessionId: client.sessionId,
    pid: client.pid,
    cwd: client.cwd,
    workspaceRoot: client.workspaceRoot,
    repoIds: Object.freeze([...client.repoIds]),
  });
}

function assertPrivateDirectory(path: string): void {
  const stat = lstatSync(path, { bigint: true });
  const wrongOwner = typeof process.getuid === "function" && stat.uid !== BigInt(process.getuid());
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== path || wrongOwner || (stat.mode & 0o077n) !== 0n) {
    throw new ProjectSyncGrantError("invalid_storage", "项目索引许可存储目录不安全");
  }
}

function assertGrantStorage(dataRoot: string, repoId: string): void {
  try {
    assertPrivateDirectory(dataRoot);
    assertPrivateDirectory(join(dataRoot, "repos"));
    assertPrivateDirectory(join(dataRoot, "repos", repoId));
    const path = repositoryDatabase(dataRoot, repoId);
    assertRegularDatabaseFiles(path);
    for (const suffix of ["", "-wal", "-shm"]) {
      const candidate = path + suffix;
      try { if (realpathSync(candidate) !== candidate) throw new Error("linked database"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
  } catch (error) {
    if (error instanceof ProjectSyncGrantError) throw error;
    throw new ProjectSyncGrantError("invalid_storage", "项目索引许可数据库或目录不安全");
  }
}

function grantHash(grantId: string): string {
  return createHash("sha256").update(grantId).digest("hex");
}

function branchAtGitDir(gitDir: string): string {
  try {
    const stat = lstatSync(join(gitDir, "HEAD"));
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("unsafe HEAD");
    const value = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
    if (!value.startsWith("ref: ")) throw new Error("detached HEAD");
    const branch = value.slice(5);
    if (!validBranch(branch)) throw new Error("invalid branch");
    return branch;
  } catch {
    throw new ProjectSyncGrantError("grant_invalid", "项目索引许可绑定的分支身份已变化");
  }
}

function storedShape(value: unknown): value is StoredGrant {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  const keys = ["schemaVersion", "grantHash", "issuerId", "daemonInstanceId", "connectionId", "repoId", "workspaceId", "root", "branch", "commonDir", "gitDir", "rootDevice", "rootInode", "gitDevice", "gitInode", "windowId", "sessionId", "pid", "status", "issuedAt", "revokedAt"];
  if (Object.keys(row).some((key) => !keys.includes(key)) || keys.some((key) => !(key in row))) return false;
  return row.schemaVersion === 2
    && typeof row.grantHash === "string" && REPO_ID.test(row.grantHash)
    && typeof row.issuerId === "string" && GRANT_ID.test(row.issuerId)
    && typeof row.daemonInstanceId === "string" && GRANT_ID.test(row.daemonInstanceId)
    && typeof row.connectionId === "string" && GRANT_ID.test(row.connectionId)
    && typeof row.repoId === "string" && REPO_ID.test(row.repoId)
    && typeof row.workspaceId === "string" && WORKSPACE_ID.test(row.workspaceId)
    && typeof row.root === "string" && isAbsolute(row.root) && resolve(row.root) === row.root
    && typeof row.branch === "string" && validBranch(row.branch)
    && typeof row.commonDir === "string" && isAbsolute(row.commonDir) && resolve(row.commonDir) === row.commonDir
    && typeof row.gitDir === "string" && isAbsolute(row.gitDir) && resolve(row.gitDir) === row.gitDir
    && typeof row.rootDevice === "string" && /^\d+$/u.test(row.rootDevice)
    && typeof row.rootInode === "string" && /^\d+$/u.test(row.rootInode)
    && typeof row.gitDevice === "string" && /^\d+$/u.test(row.gitDevice)
    && typeof row.gitInode === "string" && /^\d+$/u.test(row.gitInode)
    && typeof row.windowId === "string" && row.windowId.length > 0
    && typeof row.sessionId === "string" && row.sessionId.length > 0
    && typeof row.pid === "number" && Number.isSafeInteger(row.pid) && row.pid > 0
    && (row.status === "active" || row.status === "revoked")
    && typeof row.issuedAt === "string" && (row.revokedAt === null || typeof row.revokedAt === "string");
}

function assertStoredWorkspace(stored: StoredGrant): void {
  try {
    const root = lstatSync(stored.root, { bigint: true });
    const git = lstatSync(stored.gitDir, { bigint: true });
    const dotGit = join(stored.root, ".git");
    const dotGitStat = lstatSync(dotGit);
    if (dotGitStat.isSymbolicLink()) throw new Error("linked gitdir");
    let actualGitDir = dotGit;
    if (dotGitStat.isFile()) {
      const pointer = readFileSync(dotGit, "utf8").trim();
      if (!pointer.startsWith("gitdir: ")) throw new Error("gitdir pointer");
      actualGitDir = resolve(stored.root, pointer.slice(8));
    } else if (!dotGitStat.isDirectory()) throw new Error("gitdir");
    let actualCommonDir = stored.gitDir;
    try {
      const commonPath = join(stored.gitDir, "commondir");
      const stat = lstatSync(commonPath);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("common dir pointer");
      actualCommonDir = resolve(stored.gitDir, readFileSync(commonPath, "utf8").trim());
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (!root.isDirectory() || root.isSymbolicLink() || realpathSync(stored.root) !== stored.root
      || String(root.dev) !== stored.rootDevice || String(root.ino) !== stored.rootInode
      || !git.isDirectory() || git.isSymbolicLink() || realpathSync(stored.gitDir) !== stored.gitDir
      || realpathSync(actualGitDir) !== stored.gitDir || realpathSync(actualCommonDir) !== stored.commonDir
      || String(git.dev) !== stored.gitDevice || String(git.ino) !== stored.gitInode
      || branchAtGitDir(stored.gitDir) !== stored.branch
      || hashParts(stored.repoId, stored.root, stored.branch) !== stored.workspaceId) throw new Error("identity changed");
  } catch (error) {
    if (error instanceof ProjectSyncGrantError) throw error;
    throw new ProjectSyncGrantError("grant_invalid", "项目索引许可绑定的目录或分支身份已变化");
  }
}

export interface ProjectSyncGrantVerifierOptions {
  readonly dataRoot: string;
  readonly repoId: string;
  readonly commonDir: string;
  readonly daemonInstanceId: string;
}

/** daemon 内部验证器。调用方必须先确认 client 仍在 server.clients() 中，不能传模型提供的身份。 */
export class ProjectSyncGrantVerifier {
  private readonly options: Readonly<ProjectSyncGrantVerifierOptions>;

  constructor(options: ProjectSyncGrantVerifierOptions) {
    if (!options || !isAbsolute(options.dataRoot) || resolve(options.dataRoot) !== options.dataRoot
      || !REPO_ID.test(options.repoId) || !isAbsolute(options.commonDir) || resolve(options.commonDir) !== options.commonDir
      || !GRANT_ID.test(options.daemonInstanceId)) {
      throw new ProjectSyncGrantError("invalid_identity", "项目索引许可验证器绑定无效");
    }
    this.options = Object.freeze({ dataRoot: options.dataRoot, repoId: options.repoId, commonDir: options.commonDir, daemonInstanceId: options.daemonInstanceId });
  }

  validateForClient(grantId: string, client: ClientInfo, expected?: ProjectSyncGrantWorkspace): ValidatedProjectSyncGrant {
    const { dataRoot, repoId, commonDir, daemonInstanceId } = this.options;
    if (typeof grantId !== "string" || !GRANT_ID.test(grantId) || !client
      || client.daemonInstanceId !== daemonInstanceId || !client.connectionId || !GRANT_ID.test(client.connectionId)
      || !client.repoIds.includes(repoId)) {
      throw new ProjectSyncGrantError("grant_invalid", "项目索引许可与当前连接不匹配");
    }
    assertGrantStorage(dataRoot, repoId);
    const hash = grantHash(grantId);
    const db = new LocalDatabase(repositoryDatabase(dataRoot, repoId));
    let stored: StoredGrant | null = null;
    try {
      const row = db.read<unknown>(PROJECT_INDEX_GRANT_NAMESPACE, hash);
      if (row && storedShape(row.data)) stored = row.data;
    } finally { db.close(); }
    if (!stored || stored.status !== "active" || stored.revokedAt !== null || stored.grantHash !== hash
      || stored.repoId !== repoId || stored.commonDir !== commonDir || stored.daemonInstanceId !== daemonInstanceId
      || stored.connectionId !== client.connectionId || stored.windowId !== client.windowId
      || stored.sessionId !== client.sessionId || stored.pid !== client.pid) {
      throw new ProjectSyncGrantError("grant_invalid", "项目索引许可已失效");
    }
    if (expected && (expected.repoId !== stored.repoId || expected.workspaceId !== stored.workspaceId
      || expected.root !== stored.root || expected.branch !== stored.branch)) {
      throw new ProjectSyncGrantError("grant_invalid", "项目索引许可不属于请求的工作区范围");
    }
    assertStoredWorkspace(stored);
    return Object.freeze({
      workspace: Object.freeze({ repoId: stored.repoId, workspaceId: stored.workspaceId, root: stored.root, branch: stored.branch }),
      windowId: stored.windowId, sessionId: stored.sessionId, pid: stored.pid,
    });
  }

  revokeExact(grantId: string): Promise<boolean> {
    if (typeof grantId !== "string" || !GRANT_ID.test(grantId)) return Promise.resolve(false);
    const { dataRoot, repoId, commonDir, daemonInstanceId } = this.options;
    try {
      assertGrantStorage(dataRoot, repoId);
      const hash = grantHash(grantId);
      const db = new LocalDatabase(repositoryDatabase(dataRoot, repoId));
      try {
        return Promise.resolve(db.transaction(() => {
          const row = db.read<unknown>(PROJECT_INDEX_GRANT_NAMESPACE, hash);
          if (!row || !storedShape(row.data) || row.data.grantHash !== hash || row.data.repoId !== repoId
            || row.data.commonDir !== commonDir || row.data.daemonInstanceId !== daemonInstanceId) return false;
          if (row.data.status === "revoked") return true;
          db.update(PROJECT_INDEX_GRANT_NAMESPACE, hash, row.version, { ...row.data, status: "revoked", revokedAt: new Date().toISOString() } satisfies StoredGrant);
          return true;
        }));
      } finally { db.close(); }
    } catch { return Promise.resolve(false); }
  }
}

/**
 * 真实 UI 宿主内部签发器；授权确认与当前连接来自可信回调，不暴露签发 RPC。
 * 宿主关闭或切换 session 时须 close 并完成撤权；失败时保持控制连接断开。
 * daemon 使用独立验证器读取固定元数据，不共享本实例或 ClientInfo 对象。
 */
export class ProjectSyncGrantIssuer {
  private readonly dataRoot: string;
  private readonly repoId: string;
  private readonly commonDir: string;
  private readonly hostPrincipal: object;
  private readonly currentHostPrincipal: () => object | null;
  private readonly authorize: ProjectSyncGrantAuthorize;
  private readonly currentConnectionIdentity: () => Readonly<DaemonConnectionIdentity> | null;
  private readonly issuerId = randomUUID();
  private readonly owned = new Map<string, OwnedGrant>();
  private closing = false;
  private closed = false;
  private serial: Promise<void> = Promise.resolve();

  constructor(options: ProjectSyncGrantIssuerOptions) {
    if (!options || !isAbsolute(options.dataRoot) || resolve(options.dataRoot) !== options.dataRoot
      || !REPO_ID.test(options.repoId) || !isAbsolute(options.commonDir) || resolve(options.commonDir) !== options.commonDir
      || !options.hostPrincipal || typeof options.hostPrincipal !== "object" || typeof options.currentHostPrincipal !== "function") {
      throw new ProjectSyncGrantError("invalid_identity", "项目索引许可签发器绑定无效");
    }
    this.dataRoot = options.dataRoot;
    this.repoId = options.repoId;
    this.commonDir = options.commonDir;
    this.hostPrincipal = options.hostPrincipal;
    this.currentHostPrincipal = options.currentHostPrincipal;
    this.authorize = options.authorize ?? (() => false);
    this.currentConnectionIdentity = options.currentConnectionIdentity ?? (() => null);
  }

  private databasePath(): string {
    return repositoryDatabase(this.dataRoot, this.repoId);
  }

  private assertPrincipalCurrent(): void {
    let current: object | null = null;
    try { current = this.currentHostPrincipal(); } catch { current = null; }
    if (this.closing || this.closed || current !== this.hostPrincipal) {
      for (const id of this.owned.keys()) this.revokeInDatabase(id);
      throw new ProjectSyncGrantError(this.closing || this.closed ? "issuer_closed" : "authorization_denied", "项目索引许可的可信宿主上下文已失效");
    }
  }

  private assertStorage(): void {
    assertGrantStorage(this.dataRoot, this.repoId);
  }

  private assertConnectionCurrent(client: ClientInfo): Readonly<DaemonConnectionIdentity> {
    let current: Readonly<DaemonConnectionIdentity> | null = null;
    try { current = this.currentConnectionIdentity(); } catch { current = null; }
    if (!current || !GRANT_ID.test(current.daemonInstanceId) || !GRANT_ID.test(current.connectionId)
      || !Number.isSafeInteger(current.connectionSequence) || current.connectionSequence < 1
      || client.daemonInstanceId !== current.daemonInstanceId || client.connectionId !== current.connectionId) {
      throw new ProjectSyncGrantError("authorization_denied", "项目索引许可的当前认证连接已失效");
    }
    return Object.freeze({ ...current });
  }

  private assertAuthorized(request: ProjectSyncGrantAuthorizationRequest): void {
    let allowed = false;
    try { allowed = this.authorize(request, this.hostPrincipal) === true; } catch { allowed = false; }
    if (!allowed) throw new ProjectSyncGrantError("authorization_denied", "项目索引扫描许可未获真实宿主同意");
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.serial.then(operation, operation);
    this.serial = result.then(() => undefined, () => undefined);
    return result;
  }

  private async inspectWorkspace(workspace: ProjectSyncGrantWorkspace): Promise<{
    workspace: ProjectSyncGrantWorkspace;
    rootDevice: bigint;
    rootInode: bigint;
    gitDir: string;
    gitDevice: bigint;
    gitInode: bigint;
  }> {
    if (!workspace || workspace.repoId !== this.repoId || !WORKSPACE_ID.test(workspace.workspaceId)
      || typeof workspace.root !== "string" || !isAbsolute(workspace.root) || resolve(workspace.root) !== workspace.root
      || typeof workspace.branch !== "string" || !validBranch(workspace.branch)) {
      throw new ProjectSyncGrantError("invalid_identity", "项目索引许可工作区范围无效");
    }
    try {
      const rootStat = await lstat(workspace.root, { bigint: true });
      const root = await realpath(workspace.root);
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || root !== workspace.root) throw new Error("root");
      const identity = await repositoryIdentity(root);
      if (identity.repoId !== this.repoId || identity.commonDir !== this.commonDir) throw new Error("repository");
      const worktrees = await listWorktrees(identity.commonDir);
      assertDataRootOutsideWorktrees(this.dataRoot, worktrees);
      const branchResult = await readGit(root, ["symbolic-ref", "-q", "HEAD"]);
      const branch = branchResult.stdout.trim();
      if (branch !== workspace.branch) throw new Error("branch");
      const gitResult = await readGit(root, ["rev-parse", "--absolute-git-dir"]);
      const gitDir = await realpath(gitResult.stdout.trim());
      const gitStat = await lstat(gitDir, { bigint: true });
      if (!gitStat.isDirectory() || gitStat.isSymbolicLink()) throw new Error("gitdir");
      const expectedWorkspaceId = hashParts(this.repoId, root, branch);
      if (expectedWorkspaceId !== workspace.workspaceId) throw new Error("workspace");
      this.assertStorage();
      return { workspace: Object.freeze({ ...workspace, root }), rootDevice: rootStat.dev, rootInode: rootStat.ino, gitDir, gitDevice: gitStat.dev, gitInode: gitStat.ino };
    } catch (error) {
      if (error instanceof ProjectSyncGrantError) throw error;
      throw new ProjectSyncGrantError("invalid_identity", "项目索引许可工作区身份核对失败");
    }
  }

  async issue(client: ClientInfo, workspace: ProjectSyncGrantWorkspace): Promise<IssuedProjectSyncGrant> {
    return this.enqueue(async () => {
      this.assertPrincipalCurrent();
      if (!client || typeof client !== "object" || !Array.isArray(client.repoIds) || !client.repoIds.includes(this.repoId)
        || typeof client.windowId !== "string" || !client.windowId || typeof client.sessionId !== "string" || !client.sessionId
        || !workspace || !Number.isSafeInteger(client.pid) || client.pid <= 0) {
        throw new ProjectSyncGrantError("invalid_identity", "项目索引许可客户端身份无效");
      }
      const snapshot = snapshotClient(client);
      const connection = this.assertConnectionCurrent(client);
      const checked = await this.inspectWorkspace(Object.freeze({
        repoId: workspace.repoId, workspaceId: workspace.workspaceId, root: workspace.root, branch: workspace.branch,
      }));
      const request: ProjectSyncGrantAuthorizationRequest = Object.freeze({
        action: "issue_project_index_scan",
        repoId: this.repoId,
        workspaceId: checked.workspace.workspaceId,
        repositoryRoot: checked.workspace.root,
        branch: checked.workspace.branch,
        windowId: client.windowId,
        sessionId: client.sessionId,
        pid: client.pid,
      });
      this.assertAuthorized(request);
      this.assertPrincipalCurrent();
      const after = await this.inspectWorkspace(checked.workspace);
      if (after.rootDevice !== checked.rootDevice || after.rootInode !== checked.rootInode
        || after.gitDir !== checked.gitDir || after.gitDevice !== checked.gitDevice || after.gitInode !== checked.gitInode) {
        throw new ProjectSyncGrantError("invalid_identity", "项目索引许可确认期间工作区身份已变化");
      }
      const grantId = randomUUID();
      const now = new Date().toISOString();
      const stored: StoredGrant = {
        schemaVersion: 2,
        grantHash: grantHash(grantId),
        issuerId: this.issuerId,
        daemonInstanceId: connection.daemonInstanceId,
        connectionId: connection.connectionId,
        repoId: this.repoId,
        workspaceId: checked.workspace.workspaceId,
        root: checked.workspace.root,
        branch: checked.workspace.branch,
        commonDir: this.commonDir,
        gitDir: checked.gitDir,
        rootDevice: String(checked.rootDevice),
        rootInode: String(checked.rootInode),
        gitDevice: String(checked.gitDevice),
        gitInode: String(checked.gitInode),
        windowId: client.windowId,
        sessionId: client.sessionId,
        pid: client.pid,
        status: "active",
        issuedAt: now,
        revokedAt: null,
      };
      this.assertStorage();
      const db = new LocalDatabase(this.databasePath());
      try {
        assertStoredWorkspace(stored);
        this.assertAuthorized(request);
        const current = this.assertConnectionCurrent(client);
        this.assertPrincipalCurrent();
        if (!sameClient(client, snapshot) || current.connectionSequence !== connection.connectionSequence) {
          throw new ProjectSyncGrantError("invalid_identity", "项目索引许可确认期间客户端身份已变化");
        }
        db.transaction(() => db.create(PROJECT_INDEX_GRANT_NAMESPACE, stored.grantHash, stored));
      } finally { db.close(); }
      this.owned.set(grantId, { client, snapshot, active: true });
      return Object.freeze({ grantId, workspace: Object.freeze({ ...checked.workspace }) });
    });
  }

  validateForClient(grantId: string, client: ClientInfo, expected?: ProjectSyncGrantWorkspace): ValidatedProjectSyncGrant {
    this.assertPrincipalCurrent();
    if (!GRANT_ID.test(grantId)) throw new ProjectSyncGrantError("grant_invalid", "项目索引许可无效");
    const owned = this.owned.get(grantId);
    if (!owned || !owned.active || owned.client !== client || !sameClient(client, owned.snapshot)) {
      throw new ProjectSyncGrantError("grant_invalid", "项目索引许可与当前连接不匹配");
    }
    this.assertConnectionCurrent(client);
    return new ProjectSyncGrantVerifier({
      dataRoot: this.dataRoot, repoId: this.repoId, commonDir: this.commonDir,
      daemonInstanceId: client.daemonInstanceId!,
    }).validateForClient(grantId, client, expected);
  }

  private revokeInDatabase(grantId: string): boolean {
    const owned = this.owned.get(grantId);
    if (!owned) return false;
    // 先同步撤销内存能力；数据库失败时保留不可用条目，允许同一issuer准确重试持久撤权。
    owned.active = false;
    try {
      this.assertStorage();
      const db = new LocalDatabase(this.databasePath());
      const hash = grantHash(grantId);
      try {
        const persisted = db.transaction(() => {
          const row = db.read<unknown>(PROJECT_INDEX_GRANT_NAMESPACE, hash);
          if (!row || !storedShape(row.data) || row.data.issuerId !== this.issuerId || row.data.grantHash !== hash) return false;
          if (row.data.status === "revoked") return true;
          db.update(PROJECT_INDEX_GRANT_NAMESPACE, hash, row.version, { ...row.data, status: "revoked", revokedAt: new Date().toISOString() } satisfies StoredGrant);
          return true;
        });
        if (persisted) this.owned.delete(grantId);
        return persisted;
      } finally { db.close(); }
    } catch {
      // 内存撤权先于持久化；本issuer不会因数据库故障继续认可该许可。
      return false;
    }
  }

  revokeExact(grantId: string): Promise<boolean> {
    return Promise.resolve(GRANT_ID.test(grantId) && this.revokeInDatabase(grantId));
  }

  revokeOwned(client?: ClientInfo): Promise<number> {
    const ids = [...this.owned].filter(([, owned]) => client === undefined || owned.client === client).map(([id]) => id);
    let revoked = 0;
    for (const id of ids) if (this.revokeInDatabase(id)) revoked += 1;
    return Promise.resolve(revoked);
  }

  async close(): Promise<void> {
    this.closing = true;
    // 持久撤权同步开始，不等待正在进行的异步身份核对；晚到签发会在写库前拒绝。
    const failed = [...this.owned.keys()].filter((id) => !this.revokeInDatabase(id));
    this.closed = true;
    await this.serial;
    if (failed.length) throw new ProjectSyncGrantError("invalid_storage", "项目索引许可持久撤权未全部完成，宿主须保持控制连接断开");
  }
}
