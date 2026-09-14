import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { readGit } from "../runtime/git-read.ts";
import { assertRegularDatabaseFiles, indexDatabase } from "../runtime/database-paths.ts";
import { IndexStore } from "../runtime/index-store.ts";
import { assertUnmanagedProjectMetadata } from "../runtime/project-sync-client.ts";
import { classifyIndexWatchEvent } from "../runtime/project-index-policy.ts";
import type { ProjectBaselineCapture, ProjectBaselineInvalidation } from "../runtime/project-baseline.ts";
import type { ClientInfo } from "./server.ts";
import { DaemonServer } from "./server.ts";
import { repositoryIdentity } from "../runtime/identity.ts";
import { ProjectIndexService } from "../runtime/project-index-service.ts";
import type {
  ProjectIndexAuthorizationRequest,
  ProjectIndexBuildResult,
  ProjectIndexPreview,
  ProjectIndexServiceOptions,
} from "../runtime/project-index-service.ts";
import { ProjectIndexSyncManager } from "../runtime/project-index-sync.ts";
import type {
  ProjectIndexBaselineChange,
  ProjectIndexSyncAuthorizationRequest,
  ProjectIndexSyncStatus,
} from "../runtime/project-index-sync.ts";
import type {
  ProjectSyncGrantWorkspace,
  ValidatedProjectSyncGrant,
} from "../runtime/project-sync-grants.ts";

const DEFAULT_MAX_WORKSPACES = 32;
const DEFAULT_MAX_CLIENTS_PER_WORKSPACE = 32;
const DEFAULT_MAX_CLIENT_SCOPES = 128;
const DEFAULT_MAX_PENDING_OPERATIONS = 256;
const REPO_ID = /^[0-9a-f]{64}$/u;
const WORKSPACE_ID = /^[0-9a-f]{64}$/u;

export interface ProjectIndexGrantAuthority {
  validateForClient(grantId: string, client: ClientInfo, expected?: ProjectSyncGrantWorkspace): ValidatedProjectSyncGrant;
  revokeExact(grantId: string): Promise<boolean>;
}

export interface ProjectIndexCoordinatorScope extends ProjectSyncGrantWorkspace {
  readonly grantId: string;
}

export interface ProjectIndexArchiveRiskHookEvent {
  readonly workspace: Readonly<ProjectSyncGrantWorkspace>;
  readonly repositoryRoot: string;
  readonly event: Readonly<{
    eventSequence: number;
    path: string | null;
    eventType: "rename" | "change" | null;
    overflowed: boolean;
  }>;
}

export interface ProjectIndexCoordinatorOptions {
  readonly repoId: string;
  readonly dataRoot: string;
  readonly commonDir: string;
  readonly server: DaemonServer;
  readonly grants: ProjectIndexGrantAuthority;
  readonly beforeArchiveRisk?: (event: Readonly<ProjectIndexArchiveRiskHookEvent>) => void | Promise<void>;
  readonly maxWorkspaces?: number;
  readonly maxClientsPerWorkspace?: number;
  readonly maxClientScopes?: number;
  readonly maxPendingOperations?: number;
  readonly openService?: (options: ProjectIndexServiceOptions) => Promise<ProjectIndexService>;
  readonly createManager?: (options: ConstructorParameters<typeof ProjectIndexSyncManager>[0]) => ProjectIndexSyncManager;
}

export class ProjectIndexCoordinatorError extends Error {
  readonly code:
    | "invalid_scope"
    | "authorization_denied"
    | "resource_limit"
    | "coordinator_closed"
    | "not_attached"
    | "index_not_fresh"
    | "identity_changed";
  readonly data?: Readonly<Record<string, unknown>>;

  constructor(code: ProjectIndexCoordinatorError["code"], message: string, data?: Record<string, unknown>) {
    super(message);
    this.name = "ProjectIndexCoordinatorError";
    this.code = code;
    this.data = data ? Object.freeze({ ...data }) : undefined;
  }
}

interface Attachment {
  readonly client: ClientInfo;
  grantId: string;
  active: boolean;
  unsubscribe: (() => void) | null;
}

interface PendingCreation {
  readonly scope: ProjectSyncGrantWorkspace;
  readonly attachment: Attachment;
  cleanup: Promise<void> | null;
}

interface WorkspaceEntry {
  readonly scope: ProjectSyncGrantWorkspace;
  readonly service: ProjectIndexService;
  manager: ProjectIndexSyncManager;
  readonly clients: Map<ClientInfo, Attachment>;
  started: boolean;
  readonly retiredGrants: Set<string>;
  readonly baselineEpoch: string;
  baselineSequence: number;
  cleanup: Promise<void> | null;
}

type AuthorizationScope = { readonly attachment: Attachment } | { readonly cleanup: true } | { readonly background: true };
interface OperationContext { scope: AuthorizationScope }

function limit(value: number | undefined, fallback: number, maximum: number): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < 1 || selected > maximum) {
    throw new ProjectIndexCoordinatorError("invalid_scope", "项目索引协调器资源上限无效");
  }
  return selected;
}

function validBranch(value: string): boolean {
  return value.startsWith("refs/heads/") && value.length > "refs/heads/".length && value.length <= 512
    && !Array.from(value).some((character) => {
      const code = character.codePointAt(0)!;
      return code <= 0x1f || code === 0x7f;
    });
}

function exactScope(input: ProjectIndexCoordinatorScope, repoId: string): ProjectIndexCoordinatorScope {
  if (!input || typeof input.repoId !== "string" || input.repoId !== repoId || !REPO_ID.test(input.repoId)
    || typeof input.workspaceId !== "string" || !WORKSPACE_ID.test(input.workspaceId)
    || typeof input.root !== "string" || !isAbsolute(input.root) || resolve(input.root) !== input.root
    || typeof input.branch !== "string" || !validBranch(input.branch)
    || typeof input.grantId !== "string") {
    throw new ProjectIndexCoordinatorError("invalid_scope", "项目索引请求范围无效");
  }
  return Object.freeze({ ...input });
}

function workspaceOnly(scope: ProjectIndexCoordinatorScope): ProjectSyncGrantWorkspace {
  return Object.freeze({ repoId: scope.repoId, workspaceId: scope.workspaceId, root: scope.root, branch: scope.branch });
}

function publicChange(event: Readonly<ProjectIndexBaselineChange>): Record<string, unknown> {
  return {
    workspaceId: event.workspaceId,
    repoId: event.repoId,
    eventSequence: event.eventSequence,
    reason: event.reason,
    source: event.source,
    path: event.path,
    eventType: event.eventType,
    archiveMetadataOnly: event.archiveMetadataOnly,
    requiresFullReconcile: event.requiresFullReconcile,
    baselineHash: event.baselineHash,
  };
}

function publicBuild(result: ProjectIndexBuildResult): Record<string, unknown> {
  return {
    action: result.action,
    workspace: { repoId: result.workspace.repoId, workspaceId: result.workspace.workspaceId, root: result.workspace.root, branch: result.workspace.branch },
    head: result.head,
    status: result.status,
    generation: result.generation,
    baselineHash: result.baselineHash,
    parsedFiles: result.parsedFiles,
    reusedFiles: result.reusedFiles,
    readBytes: result.readBytes,
    sourceCodepoints: result.sourceCodepoints,
    files: result.files,
    symbols: result.symbols,
    codeEdges: result.codeEdges,
    diagnostics: result.diagnostics.map((item) => ({ code: item.code, path: item.path })),
    skipped: result.skipped.map((item) => ({ path: item.path, reason: item.reason })),
    archives: result.archives,
    budget: result.budget,
    spec: result.spec,
  };
}

function publicPreview(result: ProjectIndexPreview): Record<string, unknown> {
  return {
    action: "preview",
    workspace: { repoId: result.workspace.repoId, workspaceId: result.workspace.workspaceId, root: result.workspace.root, branch: result.workspace.branch },
    head: result.head,
    files: result.files,
    skipped: result.skipped,
    archives: result.archives,
    budget: result.budget,
    partial: result.partial,
    databaseCreated: false,
  };
}

function publicStatus(status: ProjectIndexSyncStatus, attached: boolean): Record<string, unknown> {
  return { ...status, attached };
}

/** 每仓库daemon内按workspace复用同步管理器；本模块不启动daemon或扩展。 */
export class ProjectIndexCoordinator {
  private readonly repoId: string;
  private readonly dataRoot: string;
  private readonly commonDir: string;
  private readonly server: DaemonServer;
  private readonly grants: ProjectIndexGrantAuthority;
  private readonly beforeArchiveRisk?: ProjectIndexCoordinatorOptions["beforeArchiveRisk"];
  private readonly maxWorkspaces: number;
  private readonly maxClientsPerWorkspace: number;
  private readonly maxClientScopes: number;
  private readonly maxPendingOperations: number;
  private readonly openService: NonNullable<ProjectIndexCoordinatorOptions["openService"]>;
  private readonly createManager: NonNullable<ProjectIndexCoordinatorOptions["createManager"]>;
  private readonly workspaces = new Map<string, WorkspaceEntry>();
  private readonly operationContext = new AsyncLocalStorage<OperationContext>();
  private readonly workspaceQueues = new Map<string, Promise<void>>();
  private readonly baselineListeners = new Map<string, Set<(event: ProjectBaselineInvalidation) => void>>();
  private readonly creating = new Map<string, PendingCreation>();
  private closeOperation: Promise<void> | null = null;
  private pendingOperations = 0;
  private closing = false;
  private closed = false;
  private readonly previousDisconnect: DaemonServer["onDisconnect"];
  private readonly disconnectHandler: NonNullable<DaemonServer["onDisconnect"]>;

  constructor(options: ProjectIndexCoordinatorOptions) {
    if (!options || !REPO_ID.test(options.repoId) || !isAbsolute(options.dataRoot) || resolve(options.dataRoot) !== options.dataRoot
      || !isAbsolute(options.commonDir) || resolve(options.commonDir) !== options.commonDir
      || !(options.server instanceof DaemonServer) || !options.grants) {
      throw new ProjectIndexCoordinatorError("invalid_scope", "项目索引协调器绑定无效");
    }
    this.repoId = options.repoId;
    this.dataRoot = options.dataRoot;
    this.commonDir = options.commonDir;
    this.server = options.server;
    this.grants = options.grants;
    this.beforeArchiveRisk = options.beforeArchiveRisk;
    this.maxWorkspaces = limit(options.maxWorkspaces, DEFAULT_MAX_WORKSPACES, 128);
    this.maxClientsPerWorkspace = limit(options.maxClientsPerWorkspace, DEFAULT_MAX_CLIENTS_PER_WORKSPACE, 128);
    this.maxClientScopes = limit(options.maxClientScopes, DEFAULT_MAX_CLIENT_SCOPES, 512);
    this.maxPendingOperations = limit(options.maxPendingOperations, DEFAULT_MAX_PENDING_OPERATIONS, 1_024);
    this.openService = options.openService ?? ProjectIndexService.open;
    this.createManager = options.createManager ?? ((managerOptions) => new ProjectIndexSyncManager(managerOptions));

    this.previousDisconnect = this.server.onDisconnect;
    this.disconnectHandler = async (client) => {
      const cleanup = this.disconnect(client);
      const previous = Promise.resolve().then(() => this.previousDisconnect?.(client));
      const results = await Promise.allSettled([cleanup, previous]);
      const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
      if (failures.length) throw new AggregateError(failures.map((result) => result.reason), "项目索引断连回调未完成");
    };
    this.server.onDisconnect = this.disconnectHandler;
    this.server.registerHandler("index.sync", (params, client) => this.handleProtocol(params, client));
  }

  private clientIsConnected(client: ClientInfo): boolean {
    return this.server.clients().some((current) => current === client);
  }

  private totalScopes(): number {
    let total = this.creating.size;
    for (const entry of this.workspaces.values()) total += entry.clients.size + entry.retiredGrants.size;
    return total;
  }

  private validateAttachment(entry: WorkspaceEntry, attachment: Attachment): boolean {
    if (this.closing || this.closed || !attachment.active || entry.clients.get(attachment.client) !== attachment || !this.clientIsConnected(attachment.client)) return false;
    try {
      this.grants.validateForClient(attachment.grantId, attachment.client, entry.scope);
      return true;
    } catch {
      return false;
    }
  }

  private selectAuthorized(entry: WorkspaceEntry): Attachment | null {
    if (this.closing || this.closed) return null;
    const context = this.operationContext.getStore()?.scope;
    if (context && "attachment" in context) return this.validateAttachment(entry, context.attachment) ? context.attachment : null;
    for (const attachment of entry.clients.values()) if (this.validateAttachment(entry, attachment)) return attachment;
    return null;
  }

  private managerAuthorize(entry: WorkspaceEntry, request: Readonly<ProjectIndexSyncAuthorizationRequest>): boolean {
    const context = this.operationContext.getStore()?.scope;
    if (context && "cleanup" in context) return request.action === "stop";
    return request.repoId === entry.scope.repoId && request.workspaceId === entry.scope.workspaceId
      && this.selectAuthorized(entry) !== null;
  }

  private serviceAuthorize(entry: WorkspaceEntry, request: Readonly<ProjectIndexAuthorizationRequest>): boolean {
    if (request.repoId !== entry.scope.repoId || request.workspaceId !== null && request.workspaceId !== entry.scope.workspaceId
      || request.repositoryRoot !== entry.scope.root) return false;
    if (request.path !== null) {
      const path = request.path.toLowerCase();
      if (path === "docs/prod" || path.startsWith("docs/prod/")) return false;
    }
    return this.selectAuthorized(entry) !== null;
  }

  private enqueue<T>(workspaceId: string, operation: () => Promise<T>, cleanup = false): Promise<T> {
    if (!cleanup && this.pendingOperations >= this.maxPendingOperations) {
      return Promise.reject(new ProjectIndexCoordinatorError("resource_limit", "项目索引协调队列已满"));
    }
    if (!cleanup) this.pendingOperations += 1;
    const previous = this.workspaceQueues.get(workspaceId) ?? Promise.resolve();
    const result = previous.then(operation);
    const settled = result.then(() => undefined, () => undefined);
    this.workspaceQueues.set(workspaceId, settled);
    void settled.then(() => {
      if (!cleanup) this.pendingOperations -= 1;
      if (this.workspaceQueues.get(workspaceId) === settled) this.workspaceQueues.delete(workspaceId);
    });
    return result;
  }

  private async forRequest<T>(attachment: Attachment, operation: () => Promise<T>): Promise<T> {
    const context: OperationContext = { scope: { attachment } };
    try { return await this.operationContext.run(context, operation); }
    finally {
      // 请求结束后，继承该上下文的watch/timer按当前订阅授权；在途请求绝不借其他client续权。
      context.scope = { background: true };
    }
  }

  private async releaseEntry(entry: WorkspaceEntry): Promise<void> {
    const failures: unknown[] = [];
    for (const grantId of entry.retiredGrants) {
      try {
        if (await this.grants.revokeExact(grantId) !== true) throw new Error("项目索引许可持久撤销未确认");
        entry.retiredGrants.delete(grantId);
      } catch (error) { failures.push(error); }
    }
    if (entry.clients.size === 0 && this.workspaces.get(entry.scope.workspaceId) === entry) {
      try {
        const status = await this.operationContext.run({ scope: { cleanup: true } }, () => entry.manager.stop());
        if (status.state !== "stopped" || status.started || status.watchers !== 0) throw new Error("项目索引同步管理器仍在收尾");
        entry.started = false;
        if (entry.retiredGrants.size === 0) this.workspaces.delete(entry.scope.workspaceId);
      } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, "项目索引资源收尾未完成");
  }

  private cleanupEntry(entry: WorkspaceEntry): Promise<void> {
    if (entry.cleanup) return entry.cleanup;
    // 每个已登记workspace最多一个清理操作，退休许可仍计入scope预算，不占用业务队列名额。
    const operation = this.enqueue(entry.scope.workspaceId, () => this.releaseEntry(entry), true);
    entry.cleanup = operation;
    const clear = () => { if (entry.cleanup === operation) entry.cleanup = null; };
    void operation.then(clear, clear);
    return operation;
  }

  private cancelCreation(workspaceId: string, creation: PendingCreation): Promise<void> {
    creation.attachment.active = false;
    if (creation.cleanup) return creation.cleanup;
    const operation = this.enqueue(workspaceId, async () => {
      if (await this.grants.revokeExact(creation.attachment.grantId) !== true) throw new Error("项目索引许可持久撤销未确认");
      const entry = this.workspaces.get(workspaceId);
      if (entry) await this.releaseEntry(entry);
      if (this.creating.get(workspaceId) === creation) this.creating.delete(workspaceId);
    }, true);
    creation.cleanup = operation;
    const clear = () => { if (creation.cleanup === operation) creation.cleanup = null; };
    void operation.then(clear, clear);
    return operation;
  }

  private deactivateCreations(client: ClientInfo, scope?: ProjectIndexCoordinatorScope): Promise<void>[] {
    const pending: Promise<void>[] = [];
    for (const [workspaceId, creation] of this.creating) {
      if (creation.attachment.client === client && (!scope || scope.workspaceId === workspaceId && scope.grantId === creation.attachment.grantId
        && scope.root === creation.scope.root && scope.branch === creation.scope.branch)) {
        pending.push(this.cancelCreation(workspaceId, creation));
      }
    }
    return pending;
  }

  private async createEntry(scope: ProjectSyncGrantWorkspace, attachment: Attachment): Promise<WorkspaceEntry> {
    const identity = await repositoryIdentity(scope.root).catch(() => null);
    if (!identity || identity.repoId !== this.repoId || identity.commonDir !== this.commonDir) {
      throw new ProjectIndexCoordinatorError("identity_changed", "项目索引仓库公共目录身份已变化");
    }
    let entry!: WorkspaceEntry;
    const service = await this.openService({
      repositoryRoot: scope.root,
      dataRoot: this.dataRoot,
      repoId: this.repoId,
      authorize: (request) => {
        if (entry) return this.serviceAuthorize(entry, request);
        if (request.repoId !== scope.repoId || request.repositoryRoot !== scope.root
          || request.workspaceId !== null && request.workspaceId !== scope.workspaceId || request.path !== null) return false;
        if (!attachment.active || !this.clientIsConnected(attachment.client)) return false;
        try { this.grants.validateForClient(attachment.grantId, attachment.client, scope); return true; }
        catch { return false; }
      },
    });
    if (service.workspace.workspaceId !== scope.workspaceId || service.workspace.repoId !== scope.repoId
      || service.workspace.root !== scope.root || service.workspace.branch !== scope.branch) {
      throw new ProjectIndexCoordinatorError("identity_changed", "项目索引服务工作区身份与许可不一致");
    }
    const clients = new Map<ClientInfo, Attachment>([[attachment.client, attachment]]);
    entry = {
      scope: Object.freeze({ ...scope }),
      service,
      manager: undefined as unknown as ProjectIndexSyncManager,
      clients,
      started: false,
      retiredGrants: new Set(),
      baselineEpoch: randomUUID(), baselineSequence: 0,
      cleanup: null,
    };
    const manager = this.createManager({
      service,
      maxSubscribers: Math.min(128, this.maxClientsPerWorkspace + 1),
      authorize: (request) => this.managerAuthorize(entry, request),
      beforeArchiveRisk: async (event) => {
        const hook = this.beforeArchiveRisk;
        if (!hook) throw new ProjectIndexCoordinatorError("authorization_denied", "发现归档风险，但可信生命周期核对hook未配置");
        await hook(Object.freeze({
          workspace: Object.freeze({ ...entry.scope }),
          repositoryRoot: entry.scope.root,
          event: Object.freeze({ eventSequence: event.eventSequence, path: event.path, eventType: event.eventType, overflowed: event.overflowed }),
        }));
      },
    });
    entry.manager = manager;
    manager.subscribe({
      id: `baseline-${entry.baselineEpoch}`,
      authorize: () => this.selectAuthorized(entry) !== null,
      onBaselineChange: (event) => {
        entry.baselineSequence++;
        this.emitBaseline(entry.scope.workspaceId, { ...event, observedSequence: entry.baselineSequence,
          authorityEpoch: this.baselineAuthority(entry) });
      },
    });
    return entry;
  }

  private subscribe(entry: WorkspaceEntry, attachment: Attachment): void {
    if (attachment.unsubscribe) return;
    const id = `index-client-${randomUUID()}`;
    attachment.unsubscribe = entry.manager.subscribe({
      id,
      authorize: () => this.validateAttachment(entry, attachment),
      onBaselineChange: (event) => {
        if (!this.validateAttachment(entry, attachment)) return;
        this.server.broadcast("project.index.changed", publicChange(event), (info) => info === attachment.client
          && this.validateAttachment(entry, attachment));
      },
    });
  }

  private freshResult(entry: WorkspaceEntry, status: ProjectIndexSyncStatus): Record<string, unknown> {
    if (status.state !== "fresh" || status.dirty) {
      throw new ProjectIndexCoordinatorError("index_not_fresh", "项目索引仍为dirty或不稳定，不能返回旧汇总", {
        state: status.state,
        dirty: status.dirty,
        eventSequence: status.eventSequence,
        reconciledSequence: status.reconciledSequence,
      });
    }
    const latest = entry.manager.latestBuildResult();
    if (!latest || latest.baselineHash !== status.baselineHash) {
      throw new ProjectIndexCoordinatorError("index_not_fresh", "项目索引当前构建结果不可用", { state: "unstable", dirty: true });
    }
    return publicBuild(latest);
  }

  private baselineAuthority(entry: WorkspaceEntry): string {
    const grants = [...entry.clients.values()].filter((attachment) => this.validateAttachment(entry, attachment))
      .map((attachment) => attachment.grantId).sort();
    return createHash("sha256").update(JSON.stringify([entry.baselineEpoch, grants])).digest("hex");
  }

  private emitBaseline(workspaceId: string, event: ProjectBaselineInvalidation): void {
    for (const listener of this.baselineListeners.get(workspaceId) ?? []) listener(Object.freeze(event));
  }

  /** 内部角色source，不是RPC；只有现有有效扫描持有者才可触发对账。 */
  async baselineScope(cwd: string): Promise<ProjectSyncGrantWorkspace> {
    this.assertUsable();
    const identity = await repositoryIdentity(cwd);
    if (identity.repoId !== this.repoId || identity.commonDir !== this.commonDir) throw new ProjectIndexCoordinatorError("identity_changed", "角色仓库身份已变化");
    const root = await realpath((await readGit(cwd, ["rev-parse", "--show-toplevel"])).stdout.trim());
    const branch = (await readGit(root, ["symbolic-ref", "HEAD"])).stdout.trim();
    const hash = createHash("sha256");
    for (const part of [this.repoId, root, branch]) hash.update(String(Buffer.byteLength(part))).update(":").update(part).update("|");
    return Object.freeze({ repoId: this.repoId, root, branch, workspaceId: hash.digest("hex") });
  }

  subscribeBaseline(scope: ProjectSyncGrantWorkspace, listener: (event: ProjectBaselineInvalidation) => void): () => void {
    this.assertUsable();
    let listeners = this.baselineListeners.get(scope.workspaceId);
    if (!listeners) { listeners = new Set(); this.baselineListeners.set(scope.workspaceId, listeners); }
    if ([...this.baselineListeners.values()].reduce((count, set) => count + set.size, 0) >= 128) throw new ProjectIndexCoordinatorError("resource_limit", "角色基线订阅超过上限");
    listeners.add(listener);
    return () => { listeners!.delete(listener); if (!listeners!.size) this.baselineListeners.delete(scope.workspaceId); };
  }

  private assertUnmanagedMetadata(scope: ProjectSyncGrantWorkspace): void {
    if (this.workspaces.has(scope.workspaceId) || this.creating.has(scope.workspaceId)) {
      throw new ProjectIndexCoordinatorError("not_attached", "工作区已有管理现场，不能确认未管理基线");
    }
    try { assertUnmanagedProjectMetadata(this.dataRoot, scope, this.commonDir); }
    catch { throw new ProjectIndexCoordinatorError("not_attached", "工作区已登记管理或状态未知，不能确认未管理基线"); }
  }

  /** 旧 unmanaged 请求仅核对身份和管理元数据，不触发刷新、初始化或扫描授权。 */
  async assertUnmanagedBaseline(scope: ProjectSyncGrantWorkspace, signal?: AbortSignal): Promise<void> {
    this.assertUsable();
    return this.enqueue(scope.workspaceId, async () => {
      this.assertUsable(); signal?.throwIfAborted();
      const actual = await this.baselineScope(scope.root);
      if (JSON.stringify(actual) !== JSON.stringify(scope)) throw new ProjectIndexCoordinatorError("identity_changed", "角色工作区身份已变化");
      signal?.throwIfAborted();
      this.assertUnmanagedMetadata(scope);
    });
  }

  async captureBaseline(scope: ProjectSyncGrantWorkspace, signal?: AbortSignal): Promise<ProjectBaselineCapture> {
    this.assertUsable();
    return this.enqueue(scope.workspaceId, async () => {
      this.assertUsable(); signal?.throwIfAborted();
      const actual = await this.baselineScope(scope.root);
      if (JSON.stringify(actual) !== JSON.stringify(scope)) throw new ProjectIndexCoordinatorError("identity_changed", "角色工作区身份已变化");
      const entry = this.workspaces.get(scope.workspaceId);
      if (!entry) {
        signal?.throwIfAborted();
        this.assertUnmanagedMetadata(scope);
        return { kind: "unmanaged", reason: "工作区从未初始化；不提供M3索引覆盖" };
      }
      const attachment = this.selectAuthorized(entry);
      if (!attachment || !entry.started) throw new ProjectIndexCoordinatorError("not_attached", "角色基线没有有效持续扫描持有者");
      return this.forRequest(attachment, async () => {
        const epoch = this.baselineAuthority(entry);
        const status = await entry.manager.ensureFresh();
        this.freshResult(entry, status);
        const build = entry.manager.latestBuildResult()!;
        const preview = await entry.service.preview();
        if (preview.partial || build.budget.stoppedReason !== "complete" || build.budget.exhausted.length || preview.budget.exhausted.length) throw new ProjectIndexCoordinatorError("index_not_fresh", "基线文件覆盖不完整");
        const path = indexDatabase(this.dataRoot, this.repoId); assertRegularDatabaseFiles(path);
        const store = new IndexStore(path, scope);
        let metadata;
        try { metadata = store.getFileMetadata(); } finally { store.close(); }
        if (metadata.status.baselineHash !== status.baselineHash || metadata.status.currentGeneration !== status.generation
          || preview.files.length !== metadata.files.length || preview.files.some((file) => !metadata.files.some((row) => row.path === file.path))) throw new ProjectIndexCoordinatorError("index_not_fresh", "基线文件集合不匹配");
        // 排空同步manager已发出的通知；通知本身不能回调本队列进行扫描。
        await new Promise<void>((done) => setImmediate(done));
        const end = entry.manager.status();
        if (!this.validateAttachment(entry, attachment) || this.baselineAuthority(entry) !== epoch || end.dirty || end.eventSequence !== status.eventSequence
          || end.baselineHash !== status.baselineHash) throw new ProjectIndexCoordinatorError("index_not_fresh", "基线捕获期间发生变化");
        signal?.throwIfAborted();
        const snapshot = { ...scope, generation: status.generation, baselineHash: status.baselineHash!, observedSequence: entry.baselineSequence,
          authorityEpoch: epoch, files: metadata.files.map(({ path, hash }) => ({ path, hash })),
          coverage: { kind: "allowed-inputs" as const, complete: true as const, roots: ["."], excludedPaths: ["docs/prod"],
            policyHash: createHash("sha256").update(readFileSync(new URL("../runtime/project-index-policy.ts", import.meta.url))).digest("hex") } };
        return { kind: "fresh", snapshot };
      });
    });
  }

  async checkBaselinePath(scope: ProjectSyncGrantWorkspace, absolutePath: string): Promise<string> {
    return this.enqueue(scope.workspaceId, async () => {
      this.assertUsable();
      const entry = this.workspaces.get(scope.workspaceId), attachment = entry && this.selectAuthorized(entry);
      if (!entry || !attachment || !entry.started) throw new ProjectIndexCoordinatorError("not_attached", "写入缺少有效扫描持有者");
      return this.forRequest(attachment, async () => {
        const path = relative(scope.root, absolutePath).split(sep).join("/");
        if (classifyIndexWatchEvent(path) !== "index") throw new ProjectIndexCoordinatorError("authorization_denied", "写入目标不在索引策略覆盖内");
        const preview = await entry.service.preview();
        if (preview.partial || preview.skipped.some((item) => path === item.path || path.startsWith(`${item.path}/`)) || !this.validateAttachment(entry, attachment)) throw new ProjectIndexCoordinatorError("authorization_denied", "写入目标未通过实际路径策略");
        return path;
      });
    });
  }

  private assertUsable(): void {
    if (this.closing || this.closed) throw new ProjectIndexCoordinatorError("coordinator_closed", "项目索引协调器正在关闭或已经关闭");
  }

  async attach(scopeInput: ProjectIndexCoordinatorScope, client: ClientInfo): Promise<Record<string, unknown>> {
    this.assertUsable();
    const scope = exactScope(scopeInput, this.repoId);
    const validated = this.grants.validateForClient(scope.grantId, client, workspaceOnly(scope));
    return this.enqueue(scope.workspaceId, async () => {
      this.assertUsable();
      if (!this.clientIsConnected(client)) throw new ProjectIndexCoordinatorError("authorization_denied", "项目索引客户端连接已失效");
      this.grants.validateForClient(scope.grantId, client, workspaceOnly(scope));
      let entry = this.workspaces.get(scope.workspaceId);
      if (entry && (entry.scope.root !== validated.workspace.root || entry.scope.branch !== validated.workspace.branch
        || entry.scope.repoId !== validated.workspace.repoId)) {
        throw new ProjectIndexCoordinatorError("identity_changed", "项目索引workspace身份发生冲突");
      }
      if (entry?.retiredGrants.has(scope.grantId) || this.creating.has(scope.workspaceId)) {
        throw new ProjectIndexCoordinatorError("authorization_denied", "项目索引许可或创建操作仍在收尾");
      }
      let attachment = entry?.clients.get(client);
      if (!entry) {
        if (this.totalScopes() >= this.maxClientScopes) throw new ProjectIndexCoordinatorError("resource_limit", "项目索引客户端scope超过上限");
        if (this.workspaces.size + this.creating.size >= this.maxWorkspaces) {
          throw new ProjectIndexCoordinatorError("resource_limit", "项目索引workspace实例超过上限");
        }
        attachment = { client, grantId: scope.grantId, active: true, unsubscribe: null };
        // 预留是同步元数据步骤，其他workspace可继续IO，但不能超售实例或client总预算。
        const creation: PendingCreation = { scope: validated.workspace, attachment, cleanup: null };
        this.creating.set(scope.workspaceId, creation);
        try { entry = await this.forRequest(attachment, () => this.createEntry(validated.workspace, attachment!)); }
        finally { if (!creation.cleanup) this.creating.delete(scope.workspaceId); }
        this.workspaces.set(scope.workspaceId, entry);
      } else if (!attachment) {
        if (entry.clients.size >= this.maxClientsPerWorkspace || this.totalScopes() >= this.maxClientScopes) {
          throw new ProjectIndexCoordinatorError("resource_limit", "项目索引workspace客户端超过上限");
        }
        attachment = { client, grantId: scope.grantId, active: true, unsubscribe: null };
        entry.clients.set(client, attachment);
      } else {
        attachment.grantId = scope.grantId;
        attachment.active = true;
      }
      try {
        this.assertUsable();
        if (!this.validateAttachment(entry, attachment)) throw new ProjectIndexCoordinatorError("authorization_denied", "项目索引客户端连接已失效");
        return await this.forRequest(attachment, async () => {
          this.subscribe(entry!, attachment!);
          const status = entry!.started ? await entry!.manager.ensureFresh() : await entry!.manager.start();
          entry!.started = true;
          return this.freshResult(entry!, status);
        });
      } catch (error) {
        if (entry.clients.get(client) === attachment) {
          attachment.active = false;
          attachment.unsubscribe?.();
          attachment.unsubscribe = null;
          entry.clients.delete(client);
          entry.retiredGrants.add(attachment.grantId);
        }
        try { await this.releaseEntry(entry); }
        catch (cleanupError) { throw new AggregateError([error, cleanupError], "项目索引接入失败且收尾未完成"); }
        throw error;
      }
    });
  }

  init(scope: ProjectIndexCoordinatorScope, client: ClientInfo): Promise<Record<string, unknown>> {
    return this.attach(scope, client);
  }

  async preview(scopeInput: ProjectIndexCoordinatorScope, client: ClientInfo): Promise<Record<string, unknown>> {
    this.assertUsable();
    const scope = exactScope(scopeInput, this.repoId);
    this.grants.validateForClient(scope.grantId, client, workspaceOnly(scope));
    return this.enqueue(scope.workspaceId, async () => {
      this.assertUsable();
      if (!this.clientIsConnected(client)) throw new ProjectIndexCoordinatorError("authorization_denied", "项目索引客户端连接已失效");
      this.grants.validateForClient(scope.grantId, client, workspaceOnly(scope));
      // preview单独打开服务，不创建同步manager、watcher或index.db，服务本身只枚举允许的路径元数据。
      const service = await this.openService({
        repositoryRoot: scope.root,
        dataRoot: this.dataRoot,
        repoId: this.repoId,
        authorize: (request) => {
          if (this.closing || this.closed || !this.clientIsConnected(client)
            || this.workspaces.get(scope.workspaceId)?.retiredGrants.has(scope.grantId)) return false;
          try { this.grants.validateForClient(scope.grantId, client, workspaceOnly(scope)); } catch { return false; }
          return request.repoId === scope.repoId && request.repositoryRoot === scope.root
            && (request.workspaceId === null || request.workspaceId === scope.workspaceId)
            && request.path === null;
        },
      });
      const result = await service.preview();
      return publicPreview(result);
    });
  }

  private attached(scopeInput: ProjectIndexCoordinatorScope, client: ClientInfo): { entry: WorkspaceEntry; attachment: Attachment } {
    const scope = exactScope(scopeInput, this.repoId);
    const entry = this.workspaces.get(scope.workspaceId);
    const attachment = entry?.clients.get(client);
    if (!entry || !attachment || attachment.grantId !== scope.grantId || !this.validateAttachment(entry, attachment)) {
      throw new ProjectIndexCoordinatorError("not_attached", "当前连接没有该workspace的有效索引引用");
    }
    return { entry, attachment };
  }

  async refresh(scope: ProjectIndexCoordinatorScope, client: ClientInfo): Promise<Record<string, unknown>> {
    this.assertUsable();
    const checked = exactScope(scope, this.repoId);
    return this.enqueue(checked.workspaceId, async () => {
      this.assertUsable();
      const { entry, attachment } = this.attached(checked, client);
      return this.forRequest(attachment, async () => this.freshResult(entry, await entry.manager.ensureFresh()));
    });
  }

  ensureFresh(scope: ProjectIndexCoordinatorScope, client: ClientInfo): Promise<Record<string, unknown>> {
    return this.refresh(scope, client);
  }

  status(scopeInput: Omit<ProjectIndexCoordinatorScope, "grantId"> & { grantId?: string }, client: ClientInfo): Record<string, unknown> {
    if (this.closed) return { state: "closed", attached: false };
    if (!scopeInput || scopeInput.repoId !== this.repoId || !WORKSPACE_ID.test(scopeInput.workspaceId)) return { state: "unavailable", attached: false };
    const entry = this.workspaces.get(scopeInput.workspaceId);
    if (!entry || !scopeInput.grantId) return { state: "absent", attached: false };
    if (scopeInput.repoId !== entry.scope.repoId || scopeInput.root !== entry.scope.root || scopeInput.branch !== entry.scope.branch) {
      return { state: "unavailable", attached: false };
    }
    const attachment = entry.clients.get(client);
    if (!attachment || attachment.grantId !== scopeInput.grantId || !this.validateAttachment(entry, attachment)) {
      return { state: "unavailable", attached: false };
    }
    try { return publicStatus(this.operationContext.run({ scope: { attachment } }, () => entry.manager.status()), true); }
    catch { return { state: "unavailable", attached: false }; }
  }

  private deactivate(client: ClientInfo, scope?: ProjectIndexCoordinatorScope): Array<{ entry: WorkspaceEntry; attachment: Attachment }> {
    const removed: Array<{ entry: WorkspaceEntry; attachment: Attachment }> = [];
    for (const entry of this.workspaces.values()) {
      if (scope && (entry.scope.workspaceId !== scope.workspaceId || entry.scope.repoId !== scope.repoId
        || entry.scope.root !== scope.root || entry.scope.branch !== scope.branch)) continue;
      const attachment = entry.clients.get(client);
      if (!attachment || scope?.grantId && attachment.grantId !== scope.grantId) continue;
      attachment.active = false;
      attachment.unsubscribe?.();
      attachment.unsubscribe = null;
      entry.clients.delete(client);
      entry.retiredGrants.add(attachment.grantId);
      this.emitBaseline(entry.scope.workspaceId, { reason: "attachment_revoked" });
      removed.push({ entry, attachment });
    }
    return removed;
  }

  private async finishDetach(removed: Array<{ entry: WorkspaceEntry; attachment: Attachment }>, creations: Promise<void>[]): Promise<void> {
    const results = await Promise.allSettled([...creations, ...[...new Set(removed.map(({ entry }) => entry))].map((entry) => this.cleanupEntry(entry))]);
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failures.length) throw new AggregateError(failures.map((result) => result.reason), "项目索引断连收尾未完成");
  }

  detach(scopeInput: ProjectIndexCoordinatorScope, client: ClientInfo): Promise<Record<string, unknown>> {
    const scope = exactScope(scopeInput, this.repoId);
    // 权限先同步移除；后续排队的通知和服务回调立即不能再使用该连接。
    const removed = this.deactivate(client, scope);
    const creations = this.deactivateCreations(client, scope);
    const entry = this.workspaces.get(scope.workspaceId);
    const detached = removed.length > 0 || creations.length > 0;
    if (entry && entry.scope.root === scope.root && entry.scope.branch === scope.branch && (entry.cleanup || entry.clients.size === 0)) {
      creations.push(this.cleanupEntry(entry));
    }
    return this.finishDetach(removed, creations).then(() => ({ detached }));
  }

  private disconnect(client: ClientInfo): Promise<void> {
    const removed = this.deactivate(client);
    return this.finishDetach(removed, this.deactivateCreations(client));
  }

  async onSleepGap(): Promise<Record<string, unknown>> {
    this.assertUsable();
    const results = await Promise.all([...this.workspaces.values()].map((entry) => this.enqueue(entry.scope.workspaceId, async () => {
      this.assertUsable();
      if (this.workspaces.get(entry.scope.workspaceId) !== entry) return null;
      return this.operationContext.run({ scope: { background: true } }, async () => {
        if (!this.selectAuthorized(entry)) {
          for (const client of entry.clients.keys()) this.deactivate(client, { ...entry.scope, grantId: entry.clients.get(client)!.grantId });
          await this.releaseEntry(entry);
          return null;
        }
        const status = await entry.manager.ensureFresh();
        return { workspaceId: entry.scope.workspaceId, state: status.state, dirty: status.dirty, generation: status.generation, baselineHash: status.baselineHash };
      });
    })));
    return { workspaces: results.filter((result) => result !== null) };
  }

  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.closeOperation) return this.closeOperation;
    this.closing = true;
    for (const workspaceId of this.baselineListeners.keys()) this.emitBaseline(workspaceId, { reason: "coordinator_closed" });
    if (this.server.onDisconnect === this.disconnectHandler) this.server.onDisconnect = this.previousDisconnect;
    const creations = [...this.creating].map(([workspaceId, creation]) => this.cancelCreation(workspaceId, creation));
    // 立即挂上错误处理，长业务操作不能使已失败的清理产生未处理拒绝。
    const creationResults = Promise.allSettled(creations);
    for (const entry of this.workspaces.values()) {
      for (const client of entry.clients.keys()) this.deactivate(client, { ...entry.scope, grantId: entry.clients.get(client)!.grantId });
    }
    const operation = (async () => {
      // 先等已接纳请求（含尚未登记的创建）安全结束；关闭不受业务队列预算拒绝。
      await Promise.all([...this.workspaceQueues.values()]);
      const results = [...await creationResults, ...await Promise.allSettled([...this.workspaces.values()].map((entry) => this.cleanupEntry(entry)))];
      const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
      if (failures.length) throw new AggregateError(failures.map((result) => result.reason), "项目索引关闭收尾未完成");
      this.closed = true;
      this.baselineListeners.clear();
    })();
    this.closeOperation = operation;
    const clear = () => { if (this.closeOperation === operation) this.closeOperation = null; };
    void operation.then(clear, clear);
    return operation;
  }

  private handleProtocol(params: Record<string, unknown>, client: ClientInfo): Promise<Record<string, unknown>> | Record<string, unknown> {
    const action = params.action as string;
    const root = params.repositoryRoot as string;
    const scope = {
      grantId: params.grantId as string,
      repoId: params.repoId as string,
      workspaceId: params.workspaceId as string,
      root,
      branch: params.branch as string,
    };
    switch (action) {
      case "init": return this.init(scope, client);
      case "preview": return this.preview(scope, client);
      case "refresh": return this.refresh(scope, client);
      case "ensureFresh": return this.ensureFresh(scope, client);
      case "status": return this.status({ repoId: scope.repoId, workspaceId: scope.workspaceId, root, branch: scope.branch, grantId: params.grantId as string | undefined }, client);
      case "detach": return this.detach(scope, client);
      default: throw new ProjectIndexCoordinatorError("invalid_scope", "未知项目索引同步action");
    }
  }
}
