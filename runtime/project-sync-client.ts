import { createHash } from "node:crypto";
import { knowledgeContent, parseKnowledgeTransportQuery } from "./knowledge-query-tool.ts";
import type { KnowledgeQueryDelivery } from "./knowledge-query-tool.ts";
import type { KnowledgeFactPackage } from "./knowledge-query.ts";
import { realpath } from "node:fs/promises";
import { lstatSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { join, posix } from "node:path";
import { assertDatabasePathReady, assertDataRootOutsideWorktrees, assertRegularDatabaseFiles, DATABASE_APPLICATION_IDS } from "./database-paths.ts";
import { indexDatabase, LocalDatabase, repositoryDatabase, uuidv7 } from "./database.ts";
import { hasInvalidTransactionOrigin } from "./transaction-context.ts";
import { IndexStore } from "./index-store.ts";
import type { ClientInfo } from "../daemon/server.ts";
import { DAEMON_CLIENT_LIFECYCLE_EVENTS } from "./daemon-client.ts";
import type { DaemonClient, DaemonConnectionIdentity, WorkspaceClientsHandle } from "./daemon-client.ts";
import { readGit } from "./git-read.ts";
import { repositoryIdentity } from "./identity.ts";
import type { OpenProjectIndexServiceInput, ProjectIndexServiceHandle, ProjectManageHostContext } from "./project-manage-tool.ts";
import type { ProjectIndexOperationOptions } from "./project-index-service.ts";
import type { ProjectIndexBaselineChange, ProjectIndexSyncReason } from "./project-index-sync.ts";
import { ProjectSyncGrantIssuer } from "./project-sync-grants.ts";
import type { IssuedProjectSyncGrant, ProjectSyncGrantWorkspace } from "./project-sync-grants.ts";

export interface ProjectSyncBinding {
  readonly windowId: string;
  readonly sessionId: string;
  readonly repoId: string;
}

/** 只包含当前性元数据；不包含路径正文、连接令牌或底层异常。 */
export interface ProjectSyncClientChange extends ProjectSyncBinding {
  readonly workspaceId: string;
  readonly reason: "changed" | "disconnected" | "reconnected" | "unavailable" | "shutdown";
  readonly eventSequence: number;
  readonly observationSequence: number;
  readonly baselineHash: string | null;
  readonly sourceReason: ProjectIndexBaselineChange["reason"] | null;
  readonly source: ProjectIndexSyncReason | null;
  readonly path: string | null;
  readonly eventType: "rename" | "change" | null;
  readonly archiveMetadataOnly: boolean;
  readonly requiresFullReconcile: boolean;
}

export interface ProjectSyncFreshBaseline extends ProjectSyncBinding {
  readonly workspaceId: string;
  readonly repositoryRoot: string;
  readonly root: string;
  readonly branch: string;
  readonly generation: number;
  readonly baselineHash: string;
  readonly eventSequence: number;
  readonly connectionSequence: number;
  readonly observationSequence: number;
  readonly observedSequence: number;
  readonly authorityEpoch: string;
  readonly files: readonly Readonly<{ path: string; hash: string }>[];
}

export type ProjectSyncBaselineCapture = Readonly<{ kind: "fresh"; snapshot: Readonly<ProjectSyncFreshBaseline> }>
  | Readonly<{ kind: "unmanaged"; reason: "not_initialized" }>;

export interface ProjectSyncController {
  readonly binding: ProjectSyncBinding;
  readonly workspace: ProjectSyncGrantWorkspace;
  isActive(): boolean;
  knowledgeQuery?(query: unknown, signal?: AbortSignal): Promise<KnowledgeQueryDelivery>;
  captureFreshBaseline(signal?: AbortSignal): Promise<Readonly<{ kind: "fresh"; snapshot: Readonly<ProjectSyncFreshBaseline> }>>;
  assertCurrent(snapshot: Readonly<ProjectSyncFreshBaseline>, signal?: AbortSignal): Promise<void>;
  subscribeInvalidation(listener: (event: Readonly<ProjectSyncClientChange>) => void): () => void;
  subscribe(listener: (event: Readonly<ProjectSyncClientChange>) => void): () => void;
}

export interface ProjectSyncClientSessionOptions {
  readonly dataRoot: string;
  readonly host: ProjectManageHostContext;
  readonly cwd: string;
  readonly clients: WorkspaceClientsHandle;
  readonly isCurrentHost: () => boolean;
  readonly onController?: (controller: ProjectSyncController) => void;
}

type Action = "init" | "preview" | "refresh" | "ensureFresh" | "status" | "detach";
const HASH = /^[0-9a-f]{64}$/u;
const unavailable = () => new Error("项目持续索引当前不可用；已管理工作区须在当前窗口确认扫描授权后初始化或重建，并保持有效 daemon 连接");
export const PROJECT_INDEX_MANAGEMENT_NAMESPACE = "project_index_management";
const MANAGEMENT_FORMAT = "project-index-management/v1";
const MANAGEMENT_KEYS = ["format", "repoId", "workspaceId", "root", "branch"];

function workspaceDigest(repoId: string, root: string, branch: string): string {
  const hash = createHash("sha256");
  for (const part of [repoId, root, branch]) hash.update(String(Buffer.byteLength(part))).update(":").update(part).update("|");
  return hash.digest("hex");
}

function checkedManagementRecord(value: unknown, key: string, repoId: string): ProjectSyncGrantWorkspace {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw unavailable();
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== MANAGEMENT_KEYS.length || Object.keys(row).some((field) => !MANAGEMENT_KEYS.includes(field))
    || row.format !== MANAGEMENT_FORMAT || row.repoId !== repoId || typeof row.workspaceId !== "string" || !HASH.test(row.workspaceId)
    || key !== row.workspaceId || typeof row.root !== "string" || !posix.isAbsolute(row.root) || posix.normalize(row.root) !== row.root
    || row.root.length > 4096 || /[\u0000-\u001f\u007f]/u.test(row.root)
    || typeof row.branch !== "string" || !row.branch.startsWith("refs/heads/") || row.branch.length > 255
    || /[\u0000-\u001f\u007f]/u.test(row.branch) || workspaceDigest(repoId, row.root, row.branch) !== key) throw unavailable();
  return { repoId, workspaceId: key, root: row.root, branch: row.branch };
}
const CHANGE_REASONS = new Set(["watch", "archive_metadata", "watcher_failure", "overflow", "reconciled_change"]);
const CHANGE_SOURCES = new Set(["start", "reconnect", "watch", "archive_metadata", "watcher_failure", "overflow", "low_frequency", "manual", "read_before"]);

function checkedChange(data: Record<string, unknown>): Readonly<ProjectIndexBaselineChange> | null {
  if (typeof data.repoId !== "string" || !HASH.test(data.repoId) || typeof data.workspaceId !== "string" || !HASH.test(data.workspaceId)
    || !Number.isSafeInteger(data.eventSequence) || (data.eventSequence as number) < 0
    || typeof data.reason !== "string" || !CHANGE_REASONS.has(data.reason)
    || typeof data.source !== "string" || !CHANGE_SOURCES.has(data.source)
    || data.eventType !== null && data.eventType !== "rename" && data.eventType !== "change"
    || typeof data.archiveMetadataOnly !== "boolean" || typeof data.requiresFullReconcile !== "boolean"
    || data.baselineHash !== null && (typeof data.baselineHash !== "string" || !HASH.test(data.baselineHash))) return null;
  if (data.path !== null && (typeof data.path !== "string" || !data.path || data.path.length > 4096
    || /[\\\\\u0000-\u001f\u007f]/u.test(data.path) || posix.isAbsolute(data.path) || posix.normalize(data.path) !== data.path
    || data.path === ".." || data.path.startsWith("../"))) return null;
  return Object.freeze({ repoId: data.repoId, workspaceId: data.workspaceId, eventSequence: data.eventSequence as number,
    reason: data.reason as ProjectIndexBaselineChange["reason"], source: data.source as ProjectIndexSyncReason,
    path: data.path as string | null, eventType: data.eventType, archiveMetadataOnly: data.archiveMetadataOnly,
    requiresFullReconcile: data.requiresFullReconcile, baselineHash: data.baselineHash as string | null });
}

function sameConnection(left: Readonly<DaemonConnectionIdentity> | null, right: Readonly<DaemonConnectionIdentity> | null): boolean {
  return !!left && !!right && left.daemonInstanceId === right.daemonInstanceId
    && left.connectionId === right.connectionId && left.connectionSequence === right.connectionSequence;
}

async function workspaceFor(input: Pick<OpenProjectIndexServiceInput, "repositoryRoot" | "repoId"> & { authorizedBranch?: string }): Promise<{ workspace: ProjectSyncGrantWorkspace; commonDir: string }> {
  const root = await realpath(input.repositoryRoot);
  const identity = await repositoryIdentity(root);
  const top = await realpath((await readGit(root, ["rev-parse", "--show-toplevel"])).stdout.trim());
  const branch = (await readGit(root, ["symbolic-ref", "-q", "HEAD"])).stdout.trim();
  if (root !== input.repositoryRoot || top !== root || identity.repoId !== input.repoId || input.authorizedBranch !== undefined && branch !== input.authorizedBranch
    || !branch.startsWith("refs/heads/") || /[\u0000-\u001f\u007f]/u.test(branch)) throw unavailable();
  // 与 ProjectIndexService 的长度前缀 SHA-256 工作区身份协议一致。
  return { workspace: Object.freeze({ repoId: identity.repoId, workspaceId: workspaceDigest(identity.repoId, root, branch), root, branch }), commonDir: identity.commonDir };
}

function assertMetadataStorage(dataRoot: string, workspace: ProjectSyncGrantWorkspace, path: string): void {
  assertDataRootOutsideWorktrees(dataRoot, [workspace.root]);
  for (const directory of [dataRoot, join(dataRoot, "repos"), join(dataRoot, "repos", workspace.repoId)]) {
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(directory) !== directory
      || process.getuid && stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) throw unavailable();
  }
  assertRegularDatabaseFiles(path);
  for (const suffix of ["", "-wal", "-shm"]) {
    const stat = lstatSync(path + suffix, { throwIfNoEntry: false });
    if (stat && (stat.mode & 0o077) !== 0) throw unavailable();
  }
}

/** 无扫描授权时只读既有索引的身份/登记元数据；不使用会创建或升级库的 LocalDatabase。 */
function assertNoPersistentIndex(dataRoot: string, workspace: ProjectSyncGrantWorkspace): void {
  const path = indexDatabase(dataRoot, workspace.repoId);
  assertMetadataStorage(dataRoot, workspace, path);
  const before = lstatSync(path, { throwIfNoEntry: false });
  if (!before) {
    if (["-wal", "-shm"].some((suffix) => lstatSync(path + suffix, { throwIfNoEntry: false }))) throw unavailable();
    return;
  }
  const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
  const db = new DatabaseSync(path, { readOnly: true });
  let rows: Record<string, unknown>[];
  let ownEntities: Record<string, unknown> | undefined;
  try {
    db.exec("PRAGMA query_only = ON; BEGIN");
    if (db.prepare("PRAGMA application_id").get()?.application_id !== DATABASE_APPLICATION_IDS.index
      || db.prepare("PRAGMA user_version").get()?.user_version !== 1
      || db.prepare("SELECT schema_version FROM index_schema_metadata WHERE schema_key = 'current'").get()?.schema_version !== 1) throw unavailable();
    // 缺失登记但仍有代次/实体记录不能被当成从未初始化；其他完整工作区不串用身份。
    rows = db.prepare(`SELECT record_key, json_extract(data, '$.format') AS format,
      json_extract(data, '$.workspaceId') AS workspaceId, json_extract(data, '$.repoId') AS repoId,
      json_extract(data, '$.root') AS root, json_extract(data, '$.branch') AS branch
      FROM records WHERE namespace = 'workspaces'`).all();
    ownEntities = db.prepare(`SELECT 1 FROM records WHERE
      (namespace = 'index_generations' AND record_key = ?)
      OR substr(record_key, 1, 65) = ? LIMIT 1`).get(workspace.workspaceId, `${workspace.workspaceId}:`);
  } finally { db.close(); }
  const after = lstatSync(path);
  assertMetadataStorage(dataRoot, workspace, path);
  if (before.dev !== after.dev || before.ino !== after.ino || rows.length === 0 || ownEntities) throw unavailable();
  for (const row of rows) {
    if (row.format !== "index-workspace/v1" || typeof row.workspaceId !== "string" || !HASH.test(row.workspaceId)
      || row.record_key !== row.workspaceId || row.repoId !== workspace.repoId
      || typeof row.root !== "string" || typeof row.branch !== "string") throw unavailable();
    if (workspaceDigest(row.repoId, row.root, row.branch) !== row.workspaceId || row.workspaceId === workspace.workspaceId) throw unavailable();
  }
}

/** data.db 中的管理登记不是扫描授权；缺少当前窗口许可时仍须拒绝执行。 */
function assertNoManagementRecord(dataRoot: string, workspace: ProjectSyncGrantWorkspace, commonDir: string): void {
  const path = repositoryDatabase(dataRoot, workspace.repoId);
  assertMetadataStorage(dataRoot, workspace, path);
  const before = lstatSync(path); // 已建立的宿主若丢失运行库，不能新建空库掩盖未知状态。
  const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
  const db = new DatabaseSync(path, { readOnly: true });
  let rows: Record<string, unknown>[];
  try {
    db.exec("PRAGMA query_only = ON; BEGIN");
    if (db.prepare("PRAGMA application_id").get()?.application_id !== DATABASE_APPLICATION_IDS.data
      || db.prepare("PRAGMA user_version").get()?.user_version !== 1
      || db.prepare("SELECT json_extract(data, '$.commonDir') AS commonDir FROM records WHERE namespace = 'repository' AND record_key = ?")
        .get(workspace.repoId)?.commonDir !== commonDir) throw unavailable();
    rows = db.prepare(`SELECT record_key, json_extract(data, '$.format') AS format,
      json_extract(data, '$.repoId') AS repoId, json_extract(data, '$.workspaceId') AS workspaceId,
      json_extract(data, '$.root') AS root, json_extract(data, '$.branch') AS branch,
      (json_type(data) = 'object' AND (SELECT count(*) FROM json_each(records.data)) = 5
        AND NOT EXISTS (SELECT 1 FROM json_each(records.data) WHERE key NOT IN ('format','repoId','workspaceId','root','branch'))) AS validShape
      FROM records WHERE namespace = ?`).all(PROJECT_INDEX_MANAGEMENT_NAMESPACE);
  } finally { db.close(); }
  const after = lstatSync(path);
  assertMetadataStorage(dataRoot, workspace, path);
  if (before.dev !== after.dev || before.ino !== after.ino) throw unavailable();
  for (const { record_key: key, validShape, ...data } of rows) {
    if (validShape !== 1 || typeof key !== "string") throw unavailable();
    const registered = checkedManagementRecord(data, key, workspace.repoId);
    if (registered.workspaceId === workspace.workspaceId) throw unavailable();
  }
}

/** HOST 与 daemon 共用的只读管理状态核验；已有登记、索引或未知状态均拒绝，不创建库或授予扫描能力。 */
export function assertUnmanagedProjectMetadata(dataRoot: string, workspace: ProjectSyncGrantWorkspace, commonDir: string): void {
  assertNoManagementRecord(dataRoot, workspace, commonDir);
  assertNoPersistentIndex(dataRoot, workspace);
}

function registerManagement(dataRoot: string, workspace: ProjectSyncGrantWorkspace, commonDir: string, permitted: () => boolean): void {
  if (hasInvalidTransactionOrigin()) throw unavailable();
  const path = repositoryDatabase(dataRoot, workspace.repoId);
  const storageIdentity = () => {
    assertDatabasePathReady(path);
    assertMetadataStorage(dataRoot, workspace, path);
    return [dataRoot, join(dataRoot, "repos"), join(dataRoot, "repos", workspace.repoId), path].map((entry) => {
      const stat = lstatSync(entry);
      return `${stat.dev}:${stat.ino}`;
    }).join("|");
  };
  const before = storageIdentity();
  const record = { format: MANAGEMENT_FORMAT, repoId: workspace.repoId, workspaceId: workspace.workspaceId, root: workspace.root, branch: workspace.branch };
  checkedManagementRecord(record, workspace.workspaceId, workspace.repoId);
  const payload = JSON.stringify(record), id = uuidv7();
  const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
  const db = new DatabaseSync(path);
  try {
    // 固定SQL不接收宿主回调；路径、许可、随机ID和指纹均在BEGIN之前准备。
    db.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL");
    const application = db.prepare("PRAGMA application_id"), version = db.prepare("PRAGMA user_version");
    if (application.get()?.application_id !== DATABASE_APPLICATION_IDS.data || version.get()?.user_version !== 1
      || db.prepare("PRAGMA journal_mode").get()?.journal_mode !== "wal") throw unavailable();
    const read = db.prepare("SELECT id, version, data FROM records WHERE namespace = ? AND record_key = ?");
    const repository = read.get("repository", workspace.repoId);
    if (!repository || typeof repository.data !== "string" || JSON.parse(repository.data)?.commonDir !== commonDir) throw unavailable();
    const existing = read.get(PROJECT_INDEX_MANAGEMENT_NAMESPACE, workspace.workspaceId);
    if (existing) {
      if (typeof existing.data !== "string") throw unavailable();
      const registered = checkedManagementRecord(JSON.parse(existing.data), workspace.workspaceId, workspace.repoId);
      if (registered.root !== workspace.root || registered.branch !== workspace.branch) throw unavailable();
    }
    const insert = db.prepare("INSERT INTO records (id, namespace, record_key, version, data) VALUES (?, ?, ?, 1, ?)");
    if (!permitted() || storageIdentity() !== before) throw unavailable();
    db.exec("BEGIN IMMEDIATE");
    try {
      const currentRepository = read.get("repository", workspace.repoId);
      const current = read.get(PROJECT_INDEX_MANAGEMENT_NAMESPACE, workspace.workspaceId);
      if (application.get()?.application_id !== DATABASE_APPLICATION_IDS.data || version.get()?.user_version !== 1
        || currentRepository?.id !== repository.id || currentRepository?.version !== repository.version || currentRepository?.data !== repository.data
        || current?.id !== existing?.id || current?.version !== existing?.version || current?.data !== existing?.data) throw unavailable();
      if (!existing) insert.run(id, PROJECT_INDEX_MANAGEMENT_NAMESPACE, workspace.workspaceId, payload);
      db.exec("COMMIT");
    } catch (error) {
      try { db.exec("ROLLBACK"); }
      catch (cleanupError) { throw new AggregateError([error, cleanupError], "管理登记事务结果待核对"); }
      throw error;
    }
  } finally { db.close(); }
  // 提交后的失败只阻止controller/投递，不能把已提交的管理事实撤销为未管理。
  if (!permitted() || storageIdentity() !== before) throw unavailable();
}

function rpcParams(action: Action, workspace: ProjectSyncGrantWorkspace, grant?: IssuedProjectSyncGrant): Record<string, unknown> {
  return { action, repoId: workspace.repoId, workspaceId: workspace.workspaceId, repositoryRoot: workspace.root,
    branch: workspace.branch, ...(grant ? { grantId: grant.grantId } : {}) };
}

class Controller implements ProjectSyncController {
  readonly binding: ProjectSyncBinding;
  readonly workspace: ProjectSyncGrantWorkspace;
  private readonly session: ProjectSyncClientSession;
  private readonly client: DaemonClient;
  private readonly input: OpenProjectIndexServiceInput;
  private readonly issuer: ProjectSyncGrantIssuer;
  private grant: IssuedProjectSyncGrant | undefined;
  private connection: Readonly<DaemonConnectionIdentity> | null = null;
  private attached = false;
  private closed = false;
  private serial: Promise<void> = Promise.resolve();
  private closing: Promise<void> | undefined;
  private eventSequence = 0;
  private observationSequence = 0;
  private readonly listeners = new Set<(event: Readonly<ProjectSyncClientChange>) => void>();
  private readonly unsubscribe: Array<() => void> = [];

  constructor(session: ProjectSyncClientSession, input: OpenProjectIndexServiceInput, workspace: ProjectSyncGrantWorkspace,
    client: DaemonClient, issuer: ProjectSyncGrantIssuer) {
    this.session = session;
    this.input = input;
    this.workspace = workspace;
    this.client = client;
    this.issuer = issuer;
    this.binding = Object.freeze({ windowId: input.host.windowId, sessionId: input.host.sessionId, repoId: input.repoId });
    this.unsubscribe.push(client.subscribe(DAEMON_CLIENT_LIFECYCLE_EVENTS.disconnected, () => {
      const grant = this.invalidate("disconnected");
      if (grant) this.session.background(this.issuer.revokeExact(grant.grantId).then((ok) => { if (!ok) throw unavailable(); }));
    }));
    this.unsubscribe.push(client.subscribe("project.index.changed", (data) => {
      if (!this.isActive() || data.repoId !== workspace.repoId || data.workspaceId !== workspace.workspaceId) return;
      const event = checkedChange(data);
      if (!event) { this.notify("unavailable"); return; }
      this.eventSequence = Math.max(this.eventSequence, event.eventSequence);
      this.notify("changed", event);
    }));
  }

  permitted(): boolean {
    return !this.closed && this.session.current() && this.input.authorizeContinuous();
  }

  isActive(): boolean {
    return this.permitted() && this.attached && !!this.grant
      && sameConnection(this.connection, this.client.connectionIdentity?.() ?? null);
  }

  subscribe(listener: (event: Readonly<ProjectSyncClientChange>) => void): () => void {
    if (this.closed || this.listeners.size >= 64) throw unavailable();
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  subscribeInvalidation(listener: (event: Readonly<ProjectSyncClientChange>) => void): () => void { return this.subscribe(listener); }

  private notify(reason: ProjectSyncClientChange["reason"], change?: Readonly<ProjectIndexBaselineChange>): void {
    this.observationSequence += 1;
    const event: Readonly<ProjectSyncClientChange> = Object.freeze({ ...this.binding, workspaceId: this.workspace.workspaceId, reason,
      eventSequence: change?.eventSequence ?? this.eventSequence, observationSequence: this.observationSequence,
      baselineHash: change?.baselineHash ?? null, sourceReason: change?.reason ?? null, source: change?.source ?? null,
      path: change?.path ?? null, eventType: change?.eventType ?? null, archiveMetadataOnly: change?.archiveMetadataOnly ?? false,
      requiresFullReconcile: change?.requiresFullReconcile ?? true });
    for (const listener of this.listeners) { try { listener(event); } catch { /* 单个消费者不能阻止其他消费者失效。 */ } }
  }

  private invalidate(reason: ProjectSyncClientChange["reason"]): IssuedProjectSyncGrant | undefined {
    const grant = this.grant;
    this.grant = undefined;
    this.connection = null;
    this.attached = false;
    this.notify(reason);
    return grant;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.serial.then(operation);
    this.serial = result.then(() => undefined, () => undefined);
    return this.session.track(result);
  }

  reconnect(): void {
    if (!this.permitted()) return;
    this.session.background(this.enqueue(async () => {
      await this.ensureAttached();
      this.notify("reconnected");
    }).catch(() => { this.notify("unavailable"); }));
  }

  private async ensureAttached(signal?: AbortSignal): Promise<Record<string, unknown> | undefined> {
    if (!this.permitted()) throw unavailable();
    const connection = this.client.connectionIdentity?.() ?? null;
    if (!connection) throw unavailable();
    if (this.isActive()) return undefined;
    const old = this.invalidate("unavailable");
    if (old && !await this.issuer.revokeExact(old.grantId)) { this.session.failCleanup(); throw unavailable(); }
    const grant = await this.issuer.issue(this.session.clientInfo(this.client, this.workspace.repoId), this.workspace);
    if (signal?.aborted || !this.permitted() || !sameConnection(connection, this.client.connectionIdentity?.() ?? null)) {
      if (!this.closed && !await this.issuer.revokeExact(grant.grantId)) this.session.failCleanup();
      throw unavailable();
    }
    this.grant = grant;
    this.connection = connection;
    try {
      const result = await this.client.call("index.sync", rpcParams("init", this.workspace, grant));
      if (!this.permitted() || this.grant !== grant || !sameConnection(connection, this.client.connectionIdentity?.() ?? null)) throw unavailable();
      this.attached = true;
      return result;
    } catch {
      const owned = this.grant === grant;
      this.invalidate("unavailable");
      if (owned) {
        if (!await this.issuer.revokeExact(grant.grantId)) this.session.failCleanup();
        await this.detach(grant, connection);
      }
      throw unavailable();
    }
  }

  private async detach(grant: IssuedProjectSyncGrant, connection: Readonly<DaemonConnectionIdentity> | null): Promise<void> {
    if (sameConnection(connection, this.client.connectionIdentity?.() ?? null)) {
      try { await this.client.call("index.sync", rpcParams("detach", this.workspace, grant)); }
      catch { if (sameConnection(connection, this.client.connectionIdentity?.() ?? null)) throw unavailable(); }
    }
  }

  async run(action: "init" | "refresh", options?: ProjectIndexOperationOptions): Promise<unknown> {
    return this.enqueue(async () => {
      options?.signal?.throwIfAborted();
      const cancel = () => {
        const connection = this.connection;
        const grant = this.invalidate("unavailable");
        if (grant) this.session.background((async () => {
          const revoked = await this.issuer.revokeExact(grant.grantId);
          await this.detach(grant, connection);
          if (!revoked) throw unavailable();
        })());
      };
      options?.signal?.addEventListener("abort", cancel, { once: true });
      try {
        const initial = await this.ensureAttached(options?.signal);
        options?.signal?.throwIfAborted();
        const connection = this.connection;
        const grant = this.grant;
        const result = initial ?? await this.client.call("index.sync", rpcParams(action === "init" ? "ensureFresh" : "refresh", this.workspace, grant));
        options?.signal?.throwIfAborted();
        if (!this.isActive() || this.grant !== grant || !sameConnection(connection, this.connection)) throw unavailable();
        return { ...result, action };
      } finally { options?.signal?.removeEventListener("abort", cancel); }
    });
  }

  async status(): Promise<unknown> {
    return this.enqueue(async () => {
      const result = await this.client.call("index.sync", rpcParams("status", this.workspace, this.isActive() ? this.grant : undefined));
      return this.session.statusResult(this.workspace, result);
    });
  }

  captureFreshBaseline(signal?: AbortSignal): Promise<Readonly<{ kind: "fresh"; snapshot: Readonly<ProjectSyncFreshBaseline> }>> {
    return this.enqueue(async () => {
      signal?.throwIfAborted();
      // 已管理的断线/撤权不能变成 unmanaged，也不由基线消费者偷偷恢复附件。
      if (!this.isActive()) throw unavailable();
      const grant = this.grant;
      const connection = this.connection;
      const build = await this.client.call("index.sync", rpcParams("ensureFresh", this.workspace, grant));
      const status = await this.client.call("index.sync", rpcParams("status", this.workspace, grant));
      if (!this.isActive() || this.grant !== grant || !sameConnection(connection, this.connection)
        || status.state !== "fresh" || status.dirty !== false || status.eventSequence !== status.reconciledSequence
        || !Number.isSafeInteger(status.eventSequence) || (status.eventSequence as number) < 0
        || !Number.isSafeInteger(build.generation) || (build.generation as number) < 1
        || typeof build.baselineHash !== "string" || !HASH.test(build.baselineHash) || build.baselineHash !== status.baselineHash) throw unavailable();
      this.eventSequence = Math.max(this.eventSequence, status.eventSequence as number);
      signal?.throwIfAborted();
      const budget = build.budget as { stoppedReason?: unknown; exhausted?: unknown } | undefined;
      if (!budget || budget.stoppedReason !== "complete" || !Array.isArray(budget.exhausted) || budget.exhausted.length > 0) throw unavailable();
      const files = this.session.fileMetadata(this.workspace, build.generation as number, build.baselineHash);
      if (!this.isActive() || build.files !== files.length) throw unavailable();
      const snapshot = Object.freeze({ ...this.binding, workspaceId: this.workspace.workspaceId, repositoryRoot: this.workspace.root,
        root: this.workspace.root, branch: this.workspace.branch, generation: build.generation as number, baselineHash: build.baselineHash,
        eventSequence: status.eventSequence as number, connectionSequence: connection!.connectionSequence,
        observationSequence: this.observationSequence, observedSequence: this.observationSequence,
        authorityEpoch: createHash("sha256").update(JSON.stringify([this.binding, connection])).digest("hex"), files });
      return Object.freeze({ kind: "fresh" as const, snapshot });
    });
  }

  async assertCurrent(snapshot: Readonly<ProjectSyncFreshBaseline>, signal?: AbortSignal): Promise<void> {
    if (!snapshot || !this.isActive() || snapshot.windowId !== this.binding.windowId || snapshot.sessionId !== this.binding.sessionId
      || snapshot.repoId !== this.binding.repoId || snapshot.workspaceId !== this.workspace.workspaceId
      || snapshot.repositoryRoot !== this.workspace.root || snapshot.root !== this.workspace.root || snapshot.branch !== this.workspace.branch
      || snapshot.observationSequence !== this.observationSequence) throw unavailable();
    const { snapshot: current } = await this.captureFreshBaseline(signal);
    // ensureFresh 的主动对账可递增索引代次/请求序号；真正的失效依据是内容、观察事件及连接权限。
    if (snapshot.connectionSequence !== current.connectionSequence || snapshot.authorityEpoch !== current.authorityEpoch
      || snapshot.observationSequence !== current.observationSequence || snapshot.observedSequence !== current.observedSequence
      || snapshot.baselineHash !== current.baselineHash || JSON.stringify(snapshot.files) !== JSON.stringify(current.files)) throw unavailable();
  }

  async knowledgeQuery(input: unknown, signal?: AbortSignal): Promise<KnowledgeQueryDelivery> {
    const query = parseKnowledgeTransportQuery(input);
    signal?.throwIfAborted();
    if (!this.isActive()) throw unavailable();
    const connection = this.connection, grant = this.grant!;
    const observation = this.observationSequence;
    const assertLive = () => {
      signal?.throwIfAborted();
      if (!this.isActive() || this.grant !== grant || !sameConnection(connection, this.connection)
        || this.observationSequence !== observation) throw unavailable();
    };
    const delivery = await this.enqueue(async () => {
      assertLive();
      const result = await this.client.call("project.index.query", { action: "query", grantId: grant.grantId, query });
      assertLive();
      const page = result.page as KnowledgeFactPackage;
      const receipt = result.receipt;
      if (!page || page.format !== "knowledge-facts/v1" || page.workspace?.repoId !== this.binding.repoId
        || page.workspace.workspaceId !== this.workspace.workspaceId || page.workspace.branch !== this.workspace.branch
        || typeof receipt !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(receipt)) throw unavailable();
      knowledgeContent(page);
      return {
        page, assertLive,
        verify: async (checkSignal?: AbortSignal) => {
          checkSignal?.throwIfAborted(); assertLive();
          await this.enqueue(async () => {
            checkSignal?.throwIfAborted(); assertLive();
            const checked = await this.client.call("project.index.query", { action: "check", grantId: grant.grantId, receipt });
            checkSignal?.throwIfAborted(); assertLive();
            if (checked.current !== true) throw unavailable();
          });
          checkSignal?.throwIfAborted(); assertLive();
        },
      };
    });
    assertLive();
    return delivery;
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    const connection = this.connection;
    const grant = this.invalidate("shutdown");
    for (const unsubscribe of this.unsubscribe.splice(0)) unsubscribe();
    this.listeners.clear();
    // 先废止 principal/内存引用并请求撤权；不等待慢 RPC 才撤销权限。
    this.closing = (async () => {
      const outcomes = await Promise.allSettled([this.session.retireIssuer(this.issuer), grant ? this.detach(grant, connection) : Promise.resolve()]);
      await this.serial;
      if (outcomes.some((outcome) => outcome.status === "rejected")) throw unavailable();
    })();
    return this.closing;
  }
}

/** 每个真实 lifecycle session 一份；所有扫描与 watcher 都留在已有仓库 daemon。 */
export class ProjectSyncClientSession {
  private readonly options: ProjectSyncClientSessionOptions;
  private readonly principal = Object.freeze({});
  private closed = false;
  private closing: Promise<void> | undefined;
  private readonly controllers = new Map<string, Controller>();
  private readonly unmanagedScopes = new Map<string, string>();
  private readonly uncertainManagement = new Set<string>();
  private readonly issuers = new Set<ProjectSyncGrantIssuer>();
  private readonly operations = new Set<Promise<unknown>>();
  private readonly unsubscribers: Array<() => void> = [];
  private cleanupFailed = false;

  constructor(options: ProjectSyncClientSessionOptions) {
    this.options = options;
    for (const [repoId] of options.host.repositories) {
      const client = options.clients.forRepo(repoId);
      if (client) this.unsubscribers.push(client.subscribe(DAEMON_CLIENT_LIFECYCLE_EVENTS.connected, () => {
        this.controllers.get(repoId)?.reconnect();
      }));
    }
  }

  current(): boolean {
    try { return !this.closed && !this.cleanupFailed && this.options.isCurrentHost(); } catch { return false; }
  }

  clientInfo(client: DaemonClient, repoId: string): ClientInfo {
    const identity = client.connectionIdentity?.();
    if (!this.current() || !identity) throw unavailable();
    return Object.freeze({ windowId: this.options.host.windowId, sessionId: this.options.host.sessionId,
      pid: process.pid, cwd: this.options.cwd, workspaceRoot: this.options.cwd, repoIds: [repoId],
      daemonInstanceId: identity.daemonInstanceId, connectionId: identity.connectionId });
  }

  track<T>(promise: Promise<T>): Promise<T> {
    this.operations.add(promise);
    void promise.then(() => this.operations.delete(promise), () => this.operations.delete(promise));
    return promise;
  }

  background(promise: Promise<unknown>): void {
    this.track(promise).catch(() => this.failCleanup());
  }

  failCleanup(): void {
    this.cleanupFailed = true;
    // 持久撤权失败时断开现有控制连接，让 daemon 的连接撤销路径立即拒绝旧能力。
    this.options.clients.closeAll();
  }

  controller(repoId: string): ProjectSyncController | undefined { return this.current() ? this.controllers.get(repoId) : undefined; }

  /** 不连接/扫描/签发许可，只确认可信宿主精确工作区仍无持久索引登记。 */
  captureUnmanaged(repoId: string, signal?: AbortSignal): Promise<Readonly<{ kind: "unmanaged"; reason: "not_initialized" }>> {
    return this.track(this.inspectUnmanaged(repoId, signal));
  }

  private async inspectUnmanaged(repoId: string, signal?: AbortSignal): Promise<Readonly<{ kind: "unmanaged"; reason: "not_initialized" }>> {
    signal?.throwIfAborted();
    const repositoryRoot = this.options.host.repositories.get(repoId)?.path;
    if (!this.current() || !repositoryRoot || this.controllers.has(repoId) || this.uncertainManagement.has(repoId)) throw unavailable();
    try {
      const before = lstatSync(repositoryRoot);
      const { workspace, commonDir } = await workspaceFor({ repositoryRoot, repoId });
      const after = lstatSync(repositoryRoot);
      const scope = JSON.stringify([workspace, after.dev, after.ino]);
      const previous = this.unmanagedScopes.get(repoId);
      if (!before.isDirectory() || before.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino
        || previous !== undefined && previous !== scope) throw unavailable();
      this.unmanagedScopes.set(repoId, scope);
      signal?.throwIfAborted();
      if (!this.current() || this.controllers.has(repoId)) throw unavailable();
      assertUnmanagedProjectMetadata(this.options.dataRoot, workspace, commonDir);
      return Object.freeze({ kind: "unmanaged", reason: "not_initialized" });
    } catch {
      // 已发现管理事实、身份变化或未知状态后，本会话不能借元数据消失恢复 legacy。
      if (!signal?.aborted) this.uncertainManagement.add(repoId);
      throw unavailable();
    }
  }

  statusResult(workspace: ProjectSyncGrantWorkspace, result: Record<string, unknown>): Record<string, unknown> {
    return { action: "status", workspace, initialized: result.attached === true, cacheVerified: false,
      index: typeof result.indexState === "string" ? { status: result.indexState, currentGeneration: result.generation } : null };
  }

  fileMetadata(workspace: ProjectSyncGrantWorkspace, generation: number, baselineHash: string): readonly Readonly<{ path: string; hash: string }>[] {
    if (!this.current()) throw unavailable();
    const path = indexDatabase(this.options.dataRoot, workspace.repoId);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw unavailable();
    const store = new IndexStore(path, workspace);
    let database: LocalDatabase | undefined;
    try {
      const db = new LocalDatabase(path);
      database = db;
      const status = store.status();
      return db.transaction(() => {
        if (!status || !["ready", "partial", "invalid"].includes(status.status)
          || status.currentGeneration !== generation || status.baselineHash !== baselineHash) throw unavailable();
        const row = db.read("workspaces", workspace.workspaceId);
        if (!row || row.version !== status.version) throw unavailable();
        const files = db.list<{ workspaceId: string; generation: number; path: string; hash: string }>("files")
          .filter((row) => row.data.workspaceId === workspace.workspaceId).map(({ data }) => {
            if (data.generation !== generation || !HASH.test(data.hash) || typeof data.path !== "string" || !data.path
              || data.path.length > 4096 || /[\\\\\u0000-\u001f\u007f]/u.test(data.path) || posix.isAbsolute(data.path)
              || posix.normalize(data.path) !== data.path || data.path === ".." || data.path.startsWith("../")
              || data.path.toLowerCase() === "docs/prod" || data.path.toLowerCase().startsWith("docs/prod/")) throw unavailable();
            return Object.freeze({ path: data.path, hash: data.hash });
          }).sort((left, right) => left.path.localeCompare(right.path));
        if (files.length > 20_000 || new Set(files.map((file) => file.path)).size !== files.length) throw unavailable();
        return Object.freeze(files);
      });
    } finally { try { database?.close(); } finally { store.close(); } }
  }

  openService(input: OpenProjectIndexServiceInput): Promise<ProjectIndexServiceHandle> {
    return this.track(this.open(input));
  }

  private async open(input: OpenProjectIndexServiceInput): Promise<ProjectIndexServiceHandle> {
    const host = this.options.host;
    if (!this.current() || input.dataRoot !== this.options.dataRoot || input.host.windowId !== host.windowId
      || input.host.sessionId !== host.sessionId || host.repositories.get(input.repoId)?.path !== input.repositoryRoot) throw unavailable();
    const client = this.options.clients.forRepo(input.repoId);
    if (!client) throw unavailable();
    const { workspace, commonDir } = await workspaceFor(input);
    if (!this.current()) throw unavailable();
    const existing = this.controllers.get(input.repoId);
    if (existing && (existing.workspace.workspaceId !== workspace.workspaceId || !existing.permitted())) {
      this.controllers.delete(input.repoId);
      await existing.close();
    }
    const wrongAction = async (): Promise<never> => { throw unavailable(); };
    if (input.action === "status") return {
      preview: wrongAction, init: wrongAction, refresh: wrongAction,
      status: async () => {
        if (!this.current()) throw unavailable();
        const controller = this.controllers.get(input.repoId);
        return controller ? controller.status() : this.statusResult(workspace, await this.track(client.call("index.sync", rpcParams("status", workspace))));
      },
    };
    const continuous = input.action !== "preview";
    const permitted = () => this.current() && (continuous ? input.authorizeContinuous() : input.authorize({ action: "preview", phase: "before",
      repoId: workspace.repoId, workspaceId: workspace.workspaceId, repositoryRoot: workspace.root, path: null }));
    if (!permitted()) throw unavailable();
    if (continuous) {
      // 持久登记先于 controller 和 daemon init；取消/断线只撤扫描能力，不删除管理事实。
      registerManagement(this.options.dataRoot, workspace, commonDir, permitted);
      let controller = this.controllers.get(input.repoId);
      if (!controller) {
        const issuer = this.issuer(input, workspace, commonDir, permitted);
        controller = new Controller(this, input, workspace, client, issuer);
        this.controllers.set(input.repoId, controller);
        this.options.onController?.(controller);
      }
      const selected = controller;
      return { preview: wrongAction, status: () => selected.status(),
        init: (options) => selected.run("init", options), refresh: (options) => selected.run("refresh", options) };
    }
    const issuer = this.issuer(input, workspace, commonDir, permitted);
    const connection = client.connectionIdentity?.() ?? null;
    const grant = await issuer.issue(this.clientInfo(client, input.repoId), workspace);
    if (!permitted() || !sameConnection(connection, client.connectionIdentity?.() ?? null)) {
      await this.retireIssuer(issuer);
      throw unavailable();
    }
    return {
      init: wrongAction, refresh: wrongAction, status: wrongAction,
      preview: async (options) => {
        options?.signal?.throwIfAborted();
        if (!permitted() || !sameConnection(connection, client.connectionIdentity?.() ?? null)) throw unavailable();
        const cancel = () => { this.background(this.retireIssuer(issuer)); };
        options?.signal?.addEventListener("abort", cancel, { once: true });
        try {
          const result = await this.track(client.call("index.sync", rpcParams("preview", workspace, grant)));
          options?.signal?.throwIfAborted();
          if (!permitted() || !sameConnection(connection, client.connectionIdentity?.() ?? null)) throw unavailable();
          return result;
        } finally { options?.signal?.removeEventListener("abort", cancel); }
      },
      close: () => this.retireIssuer(issuer),
    };
  }

  async retireIssuer(issuer: ProjectSyncGrantIssuer): Promise<void> {
    try { await issuer.close(); this.issuers.delete(issuer); }
    catch { this.failCleanup(); throw unavailable(); }
  }

  private issuer(input: OpenProjectIndexServiceInput, workspace: ProjectSyncGrantWorkspace, commonDir: string, permitted: () => boolean): ProjectSyncGrantIssuer {
    const issuer = new ProjectSyncGrantIssuer({ dataRoot: this.options.dataRoot, repoId: input.repoId, commonDir,
      hostPrincipal: this.principal, currentHostPrincipal: () => permitted() ? this.principal : null,
      currentConnectionIdentity: () => this.options.clients.forRepo(input.repoId)?.connectionIdentity?.() ?? null,
      authorize: (request, principal) => principal === this.principal && permitted()
        && request.repoId === workspace.repoId && request.workspaceId === workspace.workspaceId
        && request.repositoryRoot === workspace.root && request.branch === workspace.branch
        && request.windowId === input.host.windowId && request.sessionId === input.host.sessionId && request.pid === process.pid });
    this.issuers.add(issuer);
    return issuer;
  }

  shutdown(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
    const closings = [...this.controllers.values()].map((controller) => controller.close());
    closings.push(...[...this.issuers].map((issuer) => this.retireIssuer(issuer)));
    this.closing = (async () => {
      const results = await Promise.allSettled(closings);
      while (this.operations.size) await Promise.allSettled([...this.operations]);
      this.controllers.clear();
      this.unmanagedScopes.clear();
      this.uncertainManagement.clear();
      this.issuers.clear();
      if (this.cleanupFailed || results.some((result) => result.status === "rejected")) { this.failCleanup(); throw unavailable(); }
    })();
    return this.closing;
  }
}
