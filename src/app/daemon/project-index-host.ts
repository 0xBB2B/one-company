import { createHash } from "node:crypto";
import { adviceOf } from "../../core/exec/tool-failure.ts";
import type { FailureAdvice } from "../../core/exec/tool-failure.ts";
import { readFileSync } from "node:fs";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { repositoryDatabase, withDatabase } from "../../core/storage/database.ts";
import { indexDatabase } from "../../core/storage/database-paths.ts";
import { IndexStore } from "../../modules/project-index/index-store.ts";
import type { WorkspaceIdentity } from "../../modules/project-index/index-store.ts";
import { KnowledgeQuerySession } from "../../modules/project-index/knowledge-query.ts";
import type { KnowledgeFactPackage, KnowledgeQueryCapture } from "../../modules/project-index/knowledge-query.ts";
import { knowledgeContent, parseKnowledgeTransportQuery } from "../../modules/project-index/knowledge-query-tool.ts";
import { DEFAULT_INDEX_LIMITS, scanIndexWorkspace } from "../../modules/project-index/project-index-policy.ts";
import { ProjectIndexService } from "../../modules/project-index/project-index-service.ts";
import type { DaemonServer } from "./server.ts";
import type { ProjectIndexBuildResult } from "../../modules/project-index/project-index-service.ts";

export const PROJECT_INDEX_MANAGEMENT_NAMESPACE = "project_index_management";
const MANAGEMENT_FORMAT = "project-index-management/v2";
const MAX_SESSIONS = 64;

export interface ProjectIndexArchiveRiskHookEvent {
  readonly workspace: Readonly<WorkspaceIdentity>;
  readonly repositoryRoot: string;
}

const HOST_NEXT = {
  not_initialized: "请用户同意后用 one_company_project_manage 的 init 初始化索引",
  index_unavailable: "用 one_company_project_manage 的 status 查看索引状态，必要时 refresh 后重试",
  host_closed: "守护进程正在关闭，稍后重试",
} as const;
export class ProjectIndexHostError extends Error {
  readonly code: "not_initialized" | "index_unavailable" | "host_closed";
  readonly advice: FailureAdvice;
  constructor(code: ProjectIndexHostError["code"], message: string) {
    super(message); this.name = "ProjectIndexHostError"; this.code = code;
    this.advice = { why: message, next: HOST_NEXT[code] };
  }
}

export interface ProjectIndexHostOptions {
  repoId: string;
  dataRoot: string;
  repositoryRoot: string;
  beforeArchiveRisk?: (event: Readonly<ProjectIndexArchiveRiskHookEvent>) => Promise<void>;
}

const policyHash = createHash("sha256").update(readFileSync(new URL("../../modules/project-index/project-index-policy.ts", import.meta.url))).digest("hex");

/**
 * 守护进程持有主工作区索引：init 后登记为已初始化；不监听文件，每次查询前按 mtime/大小/ctime 指纹对账，
 * 有变化才增量重建，再在更新后的索引上查询。查询结果不做交付前复核。
 */
export class ProjectIndexHost {
  private readonly options: ProjectIndexHostOptions;
  private queue: Promise<unknown> = Promise.resolve();
  private current: { workspaceId: string; fingerprint: string; capture: KnowledgeQueryCapture; service: ProjectIndexService } | null = null;
  private readonly sessions = new Map<string, KnowledgeQuerySession>();
  private closed = false;

  constructor(options: ProjectIndexHostOptions) { this.options = options; }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.queue.then(() => {
      if (this.closed) throw new ProjectIndexHostError("host_closed", "项目索引已关闭");
      return operation();
    });
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  private open(): Promise<ProjectIndexService> {
    return ProjectIndexService.open({ repositoryRoot: this.options.repositoryRoot, dataRoot: this.options.dataRoot, repoId: this.options.repoId,
      authorize: (request) => !this.closed && (request.path === null || !/^docs\/prd(?:\/|$)/iu.test(request.path)) });
  }

  initialized(): boolean {
    return withDatabase(repositoryDatabase(this.options.dataRoot, this.options.repoId), (db) =>
      db.read<{ format?: string; root?: string }>(PROJECT_INDEX_MANAGEMENT_NAMESPACE, this.options.repoId)?.data)?.format === MANAGEMENT_FORMAT;
  }

  private markInitialized(): void {
    withDatabase(repositoryDatabase(this.options.dataRoot, this.options.repoId), (db) => {
      const data = { format: MANAGEMENT_FORMAT, repoId: this.options.repoId, root: this.options.repositoryRoot };
      const existing = db.read(PROJECT_INDEX_MANAGEMENT_NAMESPACE, this.options.repoId);
      if (existing) db.update(PROJECT_INDEX_MANAGEMENT_NAMESPACE, this.options.repoId, existing.version, data);
      else db.create(PROJECT_INDEX_MANAGEMENT_NAMESPACE, this.options.repoId, data);
    });
  }

  status(): Promise<Record<string, unknown>> {
    return this.serial(async () => ({ ...await (await this.open()).status(), managed: this.initialized() }));
  }

  preview(): Promise<unknown> {
    return this.serial(async () => (await this.open()).preview({ limits: { ...DEFAULT_INDEX_LIMITS } }));
  }

  init(): Promise<ProjectIndexBuildResult> {
    return this.serial(async () => {
      const service = await this.open();
      const build = await service.init({ limits: { ...DEFAULT_INDEX_LIMITS } });
      if (build.status !== "cancelled" && build.baselineHash) this.markInitialized();
      this.current = null;
      await this.archiveRisk(service);
      return build;
    });
  }

  refresh(): Promise<ProjectIndexBuildResult> {
    return this.serial(async () => {
      if (!this.initialized()) throw new ProjectIndexHostError("not_initialized", "项目索引尚未初始化");
      const service = await this.open();
      const build = await service.refresh({ limits: { ...DEFAULT_INDEX_LIMITS } });
      this.current = null;
      await this.archiveRisk(service);
      return build;
    });
  }

  /** 按调用方（窗口连接或角色运行）分开分页游标；调用方结束时 endCaller 释放。 */
  query(caller: string, input: unknown): Promise<KnowledgeFactPackage> {
    const query = parseKnowledgeTransportQuery(input);
    return this.serial(async () => {
      await this.reconcile();
      let session = this.sessions.get(caller);
      if (!session) {
        if (this.sessions.size >= MAX_SESSIONS) this.endCaller(this.sessions.keys().next().value!);
        session = new KnowledgeQuerySession({
          captureFresh: async () => this.current!.capture,
          readCurrent: (paths, bodies) => this.current!.service.readCurrentForQuery({ paths, bodies }),
          assertCurrent: async () => {},
        });
        this.sessions.set(caller, session);
      }
      const page = await session.query(query);
      knowledgeContent(page);
      return page;
    });
  }

  endCaller(caller: string): void {
    this.sessions.get(caller)?.close();
    this.sessions.delete(caller);
  }

  private async fingerprint(root: string): Promise<string> {
    const scan = await scanIndexWorkspace({ root, dataRoot: this.options.dataRoot, limits: { ...DEFAULT_INDEX_LIMITS } });
    const hash = createHash("sha256");
    for (const path of [...scan.files.map((file) => file.path), ...scan.archives.map((archive) => archive.path)]) {
      const stat = await lstat(join(root, path), { bigint: true }).catch(() => null);
      hash.update(`${path}\0${stat ? `${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}` : "missing"}\n`);
    }
    return hash.digest("hex");
  }

  private async reconcile(): Promise<NonNullable<ProjectIndexHost["current"]>> {
    if (!this.initialized()) throw new ProjectIndexHostError("not_initialized", "项目索引尚未初始化，请先在主窗口执行 project_manage init");
    const service = await this.open();
    const fingerprint = await this.fingerprint(service.workspace.root);
    if (this.current?.workspaceId === service.workspace.workspaceId && this.current.fingerprint === fingerprint) return this.current;
    const build = await service.refresh({ limits: { ...DEFAULT_INDEX_LIMITS } });
    await this.archiveRisk(service);
    if (build.status === "cancelled" || !build.baselineHash) {
      throw new ProjectIndexHostError("index_unavailable", `项目索引重建未完成：${build.status}`);
    }
    if (build.budget.stoppedReason !== "complete" || build.budget.exhausted.length) {
      throw new ProjectIndexHostError("index_unavailable", "项目索引文件覆盖不完整，不提供查询");
    }
    const store = new IndexStore(indexDatabase(this.options.dataRoot, this.options.repoId), service.workspace);
    let files: Array<{ path: string; hash: string }>;
    try { files = store.getFileMetadata().files.map(({ path, hash }) => ({ path, hash })); } finally { store.close(); }
    const workspace = service.workspace;
    const capture: KnowledgeQueryCapture = {
      baseline: { repoId: workspace.repoId, workspaceId: workspace.workspaceId, root: workspace.root, branch: workspace.branch,
        generation: build.generation, baselineHash: build.baselineHash, observedSequence: 0, authorityEpoch: "daemon",
        coverage: { kind: "allowed-inputs", complete: true, roots: ["."], excludedPaths: ["docs/prd"], policyHash }, files },
      build: { workspaceId: workspace.workspaceId, generation: build.generation, baselineHash: build.baselineHash },
    };
    for (const session of this.sessions.values()) session.close();
    this.sessions.clear();
    this.current = { workspaceId: workspace.workspaceId, fingerprint, capture, service };
    return this.current;
  }

  private async archiveRisk(service: ProjectIndexService): Promise<void> {
    await this.options.beforeArchiveRisk?.(Object.freeze({ workspace: Object.freeze({ ...service.workspace }), repositoryRoot: service.workspace.root }));
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const session of this.sessions.values()) session.close();
    this.sessions.clear();
    await this.queue;
  }
}

/** 窗口经 index.manage 管理索引、经 knowledge.query 查询；连接断开时释放其分页游标。 */
export function registerIndexHandlers(server: DaemonServer, host: ProjectIndexHost): void {
  const fail = (error: unknown): never => {
    const code = (error as { code?: unknown }).code;
    const advice = adviceOf(error);
    throw Object.assign(new Error(error instanceof Error ? error.message : "项目索引操作失败"),
      { code: typeof code === "string" ? code : "index_unavailable" }, advice ? { advice } : {});
  };
  server.registerHandler("index.manage", async (params) => {
    try {
      switch (params.action) {
        case "init": return { result: await host.init() };
        case "refresh": return { result: await host.refresh() };
        case "preview": return { result: await host.preview() };
        default: return { result: await host.status() };
      }
    } catch (error) { return fail(error); }
  });
  server.registerHandler("knowledge.query", async (params, client) => {
    try { return { page: await host.query(`connection:${client.connectionId}`, params.query) }; } catch (error) { return fail(error); }
  });
  const previousDisconnect = server.onDisconnect;
  server.onDisconnect = async (client) => {
    host.endCaller(`connection:${client.connectionId}`);
    await previousDisconnect?.(client);
  };
}
