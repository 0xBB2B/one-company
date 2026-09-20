import { afterEach, expect, test, vi } from "vitest";
import { createConnection } from "node:net";
import type { Socket } from "node:net";
import { copyFile, mkdir, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import type { KnowledgeFactPackage } from "../runtime/knowledge-query.ts";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DaemonServer } from "../daemon/server.ts";
import type { ClientInfo } from "../daemon/server.ts";
import { ProjectIndexCoordinator } from "../daemon/project-index-coordinator.ts";
import type { ProjectIndexCoordinatorOptions } from "../daemon/project-index-coordinator.ts";
import { repoDataDir, repositoryIdentity } from "../runtime/identity.ts";
import { PROTOCOL_VERSION, createRequest, decodeFrames, encodeFrame } from "../runtime/protocol.ts";
import { ProjectSyncGrantIssuer, ProjectSyncGrantVerifier } from "../runtime/project-sync-grants.ts";
import type { ProjectSyncGrantWorkspace } from "../runtime/project-sync-grants.ts";
import { ProjectIndexService } from "../runtime/project-index-service.ts";
import { ProjectIndexSyncManager } from "../runtime/project-index-sync.ts";
import { addWorktree, createRepoFixture, removeRepoFixture } from "./helpers/repo-fixture.ts";
import type { RepoFixture } from "./helpers/repo-fixture.ts";
import { temporaryRoot } from "./helpers/temporary-root.ts";
import { cleanupOwnedScope } from "./helpers/m3-cleanup.ts";

interface Peer {
  socket: Socket;
  closed: Promise<void>;
  events: Array<{ event: string; data: Record<string, unknown> }>;
  call(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>>;
  close(): void;
}

const repos: RepoFixture[] = [];
const roots: string[] = [];
const servers: DaemonServer[] = [];
const coordinators: ProjectIndexCoordinator[] = [];
const issuers: ProjectSyncGrantIssuer[] = [];
const peers: Peer[] = [];

async function waitFor(check: () => boolean, timeout = 5_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("等待协调器条件超时");
}

async function connect(path: string, token: string, windowId: string, repoId: string, root: string): Promise<Peer> {
  const socket = createConnection(path);
  const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
  await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
  let buffer = "";
  const events: Peer["events"] = [];
  const pending = new Map<string, { resolve(value: Record<string, unknown>): void; reject(error: Error): void }>();
  socket.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    const decoded = decodeFrames(buffer);
    buffer = decoded.rest;
    for (const frame of decoded.frames) {
      if (frame.t === "evt") events.push({ event: frame.event, data: frame.data });
      if (frame.t !== "res") continue;
      const waiter = pending.get(frame.id);
      if (!waiter) continue;
      pending.delete(frame.id);
      if (frame.ok) waiter.resolve(frame.result);
      else waiter.reject(Object.assign(new Error(frame.error.message), { code: frame.error.code, data: frame.error.data }));
    }
  });
  const peer: Peer = {
    socket,
    closed,
    events,
    call(method, params) {
      const request = createRequest(method, params);
      return new Promise((resolve, reject) => {
        pending.set(request.id, { resolve, reject });
        socket.write(encodeFrame(request));
      });
    },
    close() { socket.destroy(); },
  };
  peers.push(peer);
  await peer.call("hello", {
    authToken: token,
    windowId,
    pid: process.pid,
    sessionId: `session-${windowId}`,
    cwd: root,
    workspaceRoot: root,
    repoIds: [repoId],
    protocolVersion: PROTOCOL_VERSION,
  });
  return peer;
}

async function world(options: {
  archiveHook?: (event: unknown) => void | Promise<void>;
  installCoordinator?: boolean;
  managerCounter?: { count: number };
  coordinatorOptions?: Partial<ProjectIndexCoordinatorOptions>;
} = {}) {
  const repo = await createRepoFixture();
  repos.push(repo);
  await mkdir(join(repo.root, "src"), { recursive: true });
  await writeFile(join(repo.root, "src/index.ts"), "export const coordinatorFixture = true;\n");
  const dataRoot = await mkdtemp(join(temporaryRoot(), "project-coordinator-"));
  roots.push(dataRoot);
  const identity = await repositoryIdentity(repo.root);
  await repoDataDir(dataRoot, identity.repoId, identity.commonDir);
  const token = "coordinator-control-token";
  const server = new DaemonServer({ authToken: token, repoId: identity.repoId, startedAt: "test" });
  servers.push(server);
  const socketPath = join(dataRoot, "coordinator.sock");
  await server.listen(socketPath);
  const verifier = new ProjectSyncGrantVerifier({ dataRoot, repoId: identity.repoId, commonDir: identity.commonDir, daemonInstanceId: server.daemonInstanceId });
  const clientIssuers = new Map<ClientInfo, ProjectSyncGrantIssuer>();
  const issue = (client: ClientInfo, workspace: ProjectSyncGrantWorkspace) => {
    let issuer = clientIssuers.get(client);
    if (!issuer) {
      if (!client.daemonInstanceId || !client.connectionId || !server.clients().includes(client)) throw new Error("测试签发必须绑定真实认证连接");
      const principal = {};
      const connection = Object.freeze({ daemonInstanceId: client.daemonInstanceId, connectionId: client.connectionId, connectionSequence: 1 });
      issuer = new ProjectSyncGrantIssuer({
        dataRoot, repoId: identity.repoId, commonDir: identity.commonDir,
        hostPrincipal: principal, currentHostPrincipal: () => principal,
        currentConnectionIdentity: () => server.clients().includes(client) ? connection : null,
        authorize: () => true,
      });
      clientIssuers.set(client, issuer);
      issuers.push(issuer);
    }
    return issuer.issue(client, workspace);
  };
  let coordinator: ProjectIndexCoordinator | undefined;
  if (options.installCoordinator !== false) {
    coordinator = new ProjectIndexCoordinator({
      repoId: identity.repoId,
      dataRoot,
      commonDir: identity.commonDir,
      server,
      grants: verifier,
      beforeArchiveRisk: options.archiveHook as never,
      createManager(managerOptions) {
        if (options.managerCounter) options.managerCounter.count += 1;
        return new ProjectIndexSyncManager({ ...managerOptions, lowFrequencyMs: 60_000 });
      },
      ...options.coordinatorOptions,
    });
    coordinators.push(coordinator);
  }
  server.markHandlersReady();
  const service = await ProjectIndexService.open({ repositoryRoot: repo.root, dataRoot, repoId: identity.repoId, authorize: () => true });
  return { repo, dataRoot, identity, token, server, socketPath, verifier, issue, coordinator: coordinator!, workspace: service.workspace };
}

async function grant(w: Awaited<ReturnType<typeof world>>, windowId: string) {
  const client = w.server.clients().find((item) => item.windowId === windowId)!;
  const issued = await w.issue(client, w.workspace);
  return { client, params: {
    grantId: issued.grantId,
    repoId: w.identity.repoId,
    workspaceId: w.workspace.workspaceId,
    repositoryRoot: w.repo.root,
    branch: w.workspace.branch,
  } };
}

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

function scopeOf(granted: Awaited<ReturnType<typeof grant>>) {
  const { repositoryRoot, ...scope } = granted.params;
  return { ...scope, root: repositoryRoot };
}

afterEach(async () => {
  const ownedRepos = repos.splice(0).reverse();
  const ownedRoots = roots.splice(0).reverse();
  try {
    await cleanupOwnedScope({
      paths: [...ownedRepos.flatMap((repo) => [repo.root, ...repo.worktrees]), ...ownedRoots],
      stop: [
        ...peers.splice(0).map((peer, i) => ({ label: `peer-${i} close event`, run: async () => { peer.close(); await peer.closed; } })),
        ...coordinators.splice(0).map((coordinator, i) => ({ label: `coordinator-${i} close`, run: () => coordinator.close() })),
        ...issuers.splice(0).map((issuer, i) => ({ label: `issuer-${i} close`, run: () => issuer.close() })),
        ...servers.splice(0).map((server, i) => ({ label: `server-${i} close`, run: () => server.close() })),
      ],
      remove: [
        ...ownedRepos.map((repo) => ({ label: `remove ${repo.root}`, run: () => removeRepoFixture(repo) })),
        ...ownedRoots.map((root) => ({ label: `remove ${root}`, run: () => rm(root, { recursive: true, force: true }) })),
      ],
    });
  } finally { vi.restoreAllMocks(); }
});

test("knowledge RPC来自真实连接grant：中文命中/分页/partial/invalid/当前性/撤权", async () => {
  const counter = { count: 0 };
  const w = await world({ archiveHook: () => {}, managerCounter: counter });
  await mkdir(join(w.repo.root, "docs/spec"), { recursive: true });
  await mkdir(join(w.repo.root, "docs/prod"), { recursive: true });
  await copyFile(new URL("../resources/spec/schema.json", import.meta.url), join(w.repo.root, "docs/spec/schema.json"));
  await writeFile(join(w.repo.root, "docs/spec/jump.rules.json"), JSON.stringify({ $schema: "schema.json", schemaVersion: 1,
    feature: { id: "jump", title: "角色跳跃", aliases: [] }, rules: [{ id: "jump.once", title: "角色跳跃",
      condition: "在地面", trigger: "收到输入", expected: "角色跳跃", reason: "避免重复", dependsOn: [], exceptions: [],
      acceptance: [{ id: "once", given: "在地面", when: "收到输入", then: "角色跳跃" }] }] }));
  await writeFile(join(w.repo.root, "src/index.ts"), 'export const 跳跃 = "角色跳跃";\n');
  await writeFile(join(w.repo.root, "docs/prod/0197b7b0-6a20-7c51-8a32-b9465fb72d10.完成.md"), "角色跳跃SECRET_PROD");
  const a = await connect(w.socketPath, w.token, "query-a", w.identity.repoId, w.repo.root);
  const b = await connect(w.socketPath, w.token, "query-b", w.identity.repoId, w.repo.root);
  const ga = await grant(w, "query-a"), gb = await grant(w, "query-b");
  const request = (query: Record<string, unknown>) => a.call("project.index.query", { action: "query", grantId: ga.params.grantId, query });
  await expect(request({ action: "facts" })).rejects.toMatchObject({ code: "not_attached" });
  await a.call("index.sync", { action: "init", ...ga.params });
  await expect(b.call("project.index.query", { action: "query", grantId: ga.params.grantId, query: { action: "facts" } })).rejects.toThrow();
  await expect(b.call("project.index.query", { action: "query", grantId: gb.params.grantId, query: { action: "facts" } })).rejects.toMatchObject({ code: "not_attached" });
  const pages: KnowledgeFactPackage[] = [];
  let cursor: string | undefined;
  do {
    const result = await request({ action: "search", text: "角色跳跃", pageSize: 1, ...(cursor ? { cursor } : {}) });
    const page = result.page as KnowledgeFactPackage; pages.push(page);
    expect(await a.call("project.index.query", { action: "check", grantId: ga.params.grantId, receipt: result.receipt })).toEqual({ current: true });
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  expect(pages.flatMap((page) => page.facts).some((item) => item.kind === "rule")).toBe(true);
  expect(pages.flatMap((page) => page.facts).some((item) => item.kind === "source" && item.source.path === "src/index.ts")).toBe(true);
  expect(JSON.stringify(pages)).not.toContain("SECRET_PROD");
  expect(pages[0]).toMatchObject({ requirement: null, evidence: { status: "not_available" }, limitations: { formalVerification: "not_available", performanceImprovement: "unknown" } });
  expect(new Set(pages.map((page) => page.generation)).size).toBe(1);
  const old = await request({ action: "facts", pageSize: 1 });
  const before = await stat(join(w.repo.root, "src/index.ts"));
  const observed = (await a.call("index.sync", { action: "status", ...ga.params }) as { eventSequence: number }).eventSequence;
  await writeFile(join(w.repo.root, "src/index.ts"), 'export const 跳跃 = "角色快跑";\n');
  await utimes(join(w.repo.root, "src/index.ts"), before.atime, before.mtime);
  await waitForObservedChange(a, ga.params, observed);
  await expect(a.call("project.index.query", { action: "check", grantId: ga.params.grantId, receipt: old.receipt })).rejects.toThrow();
  await expect(request({ action: "facts", pageSize: 1, cursor: (old.page as KnowledgeFactPackage).nextCursor })).rejects.toThrow();
  const beforeBroken = (await a.call("index.sync", { action: "status", ...ga.params }) as { eventSequence: number }).eventSequence;
  await writeFile(join(w.repo.root, "src/broken.ts"), "export function broken( {\n");
  await waitForObservedChange(a, ga.params, beforeBroken);
  const partial = (await request({ action: "facts" })).page as KnowledgeFactPackage;
  expect(partial.indexStatus).toBe("partial");
  expect(partial.limitations.diagnosticCounts.syntax_error).toBeGreaterThan(0);
  const beforeInvalid = (await a.call("index.sync", { action: "status", ...ga.params }) as { eventSequence: number }).eventSequence;
  await writeFile(join(w.repo.root, "docs/spec/jump.rules.json"), "{INVALID}");
  await waitForObservedChange(a, ga.params, beforeInvalid);
  const invalid = (await request({ action: "facts" })).page as KnowledgeFactPackage;
  expect(invalid).toMatchObject({ indexStatus: "invalid", specStatus: "invalid", facts: [], contractSetHash: null });
  expect(invalid.limitations.diagnosticCounts.invalid_spec).toBeGreaterThan(0);
  await a.call("index.sync", { action: "detach", ...ga.params });
  await expect(request({ action: "facts" })).rejects.toThrow();
  expect(counter.count).toBe(1);
}, 60_000);

async function waitForObservedChange(peer: Peer, params: Record<string, unknown>, after: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const status = await peer.call("index.sync", { action: "status", ...params }) as { eventSequence: number };
    if (status.eventSequence > after) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("watcher 未在限时内观察到变化");
}

test("索引fresh时知识查询与回执核对不重建索引、不读正文；已知文件的大小变化由stat即时发现", async () => {
  let ensureFresh = 0, previews = 0;
  const w = await world({ archiveHook: () => {}, coordinatorOptions: {
    createManager(options) {
      const manager = new ProjectIndexSyncManager({ ...options, lowFrequencyMs: 60_000 });
      const original = manager.ensureFresh.bind(manager);
      manager.ensureFresh = () => { ensureFresh++; return original(); };
      return manager;
    },
    async openService(options) {
      const service = await ProjectIndexService.open(options);
      const preview = service.preview.bind(service);
      service.preview = (input) => { previews++; return preview(input); };
      return service;
    },
  } });
  const peer = await connect(w.socketPath, w.token, "count", w.identity.repoId, w.repo.root);
  const g = await grant(w, "count");
  await peer.call("index.sync", { action: "init", ...g.params });
  const first = await peer.call("project.index.query", { action: "query", grantId: g.params.grantId, query: { action: "facts" } });
  expect(await peer.call("project.index.query", { action: "check", grantId: g.params.grantId, receipt: first.receipt })).toEqual({ current: true });
  ensureFresh = 0; previews = 0;
  const second = await peer.call("project.index.query", { action: "query", grantId: g.params.grantId, query: { action: "facts" } });
  expect(await peer.call("project.index.query", { action: "check", grantId: g.params.grantId, receipt: second.receipt })).toEqual({ current: true });
  expect({ ensureFresh, previews }).toEqual({ ensureFresh: 0, previews: 0 });
  await writeFile(join(w.repo.root, "src/index.ts"), "export const coordinatorFixture = false; // 大小变化\n");
  await expect(peer.call("project.index.query", { action: "check", grantId: g.params.grantId, receipt: second.receipt }))
    .rejects.toMatchObject({ code: "index_not_fresh" });
}, 30_000);

test("一次知识查询对许可的持久核验次数与文件数无关", async () => {
  const w = await world({ archiveHook: () => {} });
  for (let i = 0; i < 300; i++) await writeFile(join(w.repo.root, "src", `g${i}.ts`), `export const g${i} = ${i};\n`);
  const peer = await connect(w.socketPath, w.token, "grant-count", w.identity.repoId, w.repo.root);
  const g = await grant(w, "grant-count");
  await peer.call("index.sync", { action: "init", ...g.params });
  await peer.call("project.index.query", { action: "query", grantId: g.params.grantId, query: { action: "exact", by: "path", value: "src/g1.ts" } });
  const validate = vi.spyOn(w.verifier, "validateForClient");
  const result = await peer.call("project.index.query", { action: "query", grantId: g.params.grantId, query: { action: "exact", by: "path", value: "src/g1.ts" } });
  expect(await peer.call("project.index.query", { action: "check", grantId: g.params.grantId, receipt: result.receipt })).toEqual({ current: true });
  expect(validate.mock.calls.length).toBeLessThan(60);
}, 60_000);

test("周期对账与知识查询互斥：慢速refresh期间连续查询不使manager进入error", async () => {
  const w = await world({ archiveHook: () => {}, coordinatorOptions: {
    createManager(options) { return new ProjectIndexSyncManager({ ...options, lowFrequencyMs: 3000 }); },
  } });
  for (let i = 0; i < 400; i++) await writeFile(join(w.repo.root, "src", `f${i}.ts`), `export function fn${i}(a: number) { return a + ${i}; }\n`);
  const peer = await connect(w.socketPath, w.token, "exclusive", w.identity.repoId, w.repo.root);
  const g = await grant(w, "exclusive");
  await peer.call("index.sync", { action: "init", ...g.params });
  for (let i = 0; i < 10; i++) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    const result = await peer.call("project.index.query", { action: "query", grantId: g.params.grantId, query: { action: "exact", by: "path", value: "src/index.ts" } });
    expect(await peer.call("project.index.query", { action: "check", grantId: g.params.grantId, receipt: result.receipt })).toEqual({ current: true });
  }
  await waitFor(() => (w.coordinator.status(scopeOf(g), g.client) as { state: string }).state === "fresh");
  expect(w.coordinator.status(scopeOf(g), g.client)).toMatchObject({ state: "fresh", dirty: false, lastError: null });
}, 90_000);

test("knowledge覆盖不足默认无正文阻塞，返回竞争真实修改使旧页失效", async () => {
  let changed = false;
  const w = await world({ archiveHook: () => {}, coordinatorOptions: {
    async openService(options) {
      const service = await ProjectIndexService.open(options);
      const read = service.readCurrentForQuery.bind(service);
      service.readCurrentForQuery = async (input) => {
        const result = await read(input);
        if (!changed) { changed = true; await writeFile(join(options.repositoryRoot, "src/index.ts"), "export const coordinatorFixture = true; // 返回前修改\n"); }
        return result;
      };
      return service;
    },
  } });
  const peer = await connect(w.socketPath, w.token, "race", w.identity.repoId, w.repo.root);
  const g = await grant(w, "race");
  const initialized = await peer.call("index.sync", { action: "init", ...g.params }) as { generation: number };
  // 返回前的真实修改要么使本次查询失败，要么经重试后只返回新内容，不能把旧页当当前。
  const outcome = await peer.call("project.index.query", { action: "query", grantId: g.params.grantId, query: { action: "facts" } })
    .then((result) => ({ page: result.page as KnowledgeFactPackage }), (error: unknown) => ({ error }));
  expect(changed).toBe(true);
  if ("page" in outcome) {
    expect(outcome.page.generation).toBeGreaterThan(initialized.generation);
    expect(JSON.stringify(outcome.page)).toContain("返回前修改");
  }
  const observed = (await peer.call("index.sync", { action: "status", ...g.params }) as { eventSequence: number }).eventSequence;
  await writeFile(join(w.repo.root, "huge.txt"), "x".repeat(3 * 1024 * 1024));
  await waitForObservedChange(peer, g.params, observed);
  await expect(peer.call("project.index.query", { action: "query", grantId: g.params.grantId, query: { action: "facts" } }))
    .rejects.toMatchObject({ code: "index_not_fresh", data: { coverage: "incomplete", bodyAvailable: false } });
}, 30_000);

test("两个已认证ClientInfo共享一个manager，重复init不重复watcher，最后断连才释放", async () => {
  const counter = { count: 0 };
  const w = await world({ archiveHook: () => {}, managerCounter: counter });
  const a = await connect(w.socketPath, w.token, "a", w.identity.repoId, w.repo.root);
  const b = await connect(w.socketPath, w.token, "b", w.identity.repoId, w.repo.root);
  const ga = await grant(w, "a");
  const gb = await grant(w, "b");

  const [first, second] = await Promise.all([
    a.call("index.sync", { action: "init", ...ga.params }),
    b.call("index.sync", { action: "init", ...gb.params }),
  ]);
  expect(first).toMatchObject({ status: expect.stringMatching(/ready|partial|invalid/), generation: expect.any(Number) });
  expect(second).toMatchObject({ baselineHash: first.baselineHash });
  expect(counter.count).toBe(1);

  const repeated = await a.call("index.sync", { action: "init", ...ga.params });
  expect(repeated).toMatchObject({ baselineHash: first.baselineHash, reusedFiles: expect.any(Number) });
  expect(counter.count).toBe(1);
  const status = await a.call("index.sync", { action: "status", ...ga.params });
  expect(status).toMatchObject({ attached: true, started: true, watchers: expect.any(Number) });

  a.close();
  await waitFor(() => w.server.clients().length === 1);
  expect(await b.call("index.sync", { action: "status", ...gb.params })).toMatchObject({ attached: true, started: true });
  b.close();
  await waitFor(() => w.server.clients().length === 0);
  await waitFor(() => (w.coordinator.status(scopeOf(gb), gb.client) as { state?: string }).state === "absent");
});

test("无许可status不建manager；preview只枚举且不建watcher/index.db", async () => {
  const counter = { count: 0 };
  const w = await world({ archiveHook: () => {}, managerCounter: counter });
  const peer = await connect(w.socketPath, w.token, "preview", w.identity.repoId, w.repo.root);
  const noGrant = await peer.call("index.sync", {
    action: "status",
    repoId: w.identity.repoId,
    workspaceId: w.workspace.workspaceId,
    repositoryRoot: w.repo.root,
    branch: w.workspace.branch,
  });
  expect(noGrant).toEqual({ state: "absent", attached: false });
  expect(counter.count).toBe(0);
  expect(existsSync(join(w.dataRoot, "repos", w.identity.repoId, "index.db"))).toBe(false);

  const granted = await grant(w, "preview");
  const preview = await peer.call("index.sync", { action: "preview", ...granted.params });
  expect(preview).toMatchObject({ action: "preview", databaseCreated: false, files: expect.any(Array) });
  expect(counter.count).toBe(0);
  expect(existsSync(join(w.dataRoot, "repos", w.identity.repoId, "index.db"))).toBe(false);
});

test("伪造grant、跨root和另一个ClientInfo对象均不能attach", async () => {
  const w = await world({ archiveHook: () => {} });
  const peer = await connect(w.socketPath, w.token, "secure", w.identity.repoId, w.repo.root);
  const granted = await grant(w, "secure");
  await expect(peer.call("index.sync", { action: "init", ...granted.params, grantId: "00000000-0000-4000-8000-000000000000" }))
    .rejects.toMatchObject({ code: "grant_invalid" });
  await expect(peer.call("index.sync", { action: "init", ...granted.params, repositoryRoot: `${w.repo.root}-other` }))
    .rejects.toMatchObject({ code: "grant_invalid" });
  await expect(w.coordinator.init({
    grantId: granted.params.grantId,
    repoId: granted.params.repoId,
    workspaceId: granted.params.workspaceId,
    root: granted.params.repositoryRoot,
    branch: granted.params.branch,
  }, { ...granted.client }))
    .rejects.toMatchObject({ code: "authorization_denied" });
});

test("归档风险hook缺失或异常时默认阻塞，不返回旧汇总", async () => {
  for (const mode of ["missing", "throwing"] as const) {
    const w = await world({ archiveHook: mode === "throwing" ? () => { throw new Error("risk failed"); } : undefined });
    await mkdir(join(w.repo.root, "docs/prod"), { recursive: true });
    await writeFile(join(w.repo.root, "docs/prod/0197b7b0-6a20-7c51-8a32-b9465fb72d10.完成.md"), "SECRET_ARCHIVE_BODY");
    const peer = await connect(w.socketPath, w.token, `risk-${mode}`, w.identity.repoId, w.repo.root);
    const granted = await grant(w, `risk-${mode}`);
    await expect(peer.call("index.sync", { action: "init", ...granted.params })).rejects.toMatchObject({ code: "index_not_fresh" });
    expect(w.coordinator.status(scopeOf(granted), granted.client)).toMatchObject({ state: "absent", attached: false });
    peer.close();
    await w.coordinator.close();
    coordinators.splice(coordinators.indexOf(w.coordinator), 1);
  }
});

test("普通广播只发无正文结构，并只投递给当前ClientInfo与有效grant", async () => {
  const hookEvents: unknown[] = [];
  const w = await world({ archiveHook: (event) => { hookEvents.push(event); } });
  await mkdir(join(w.repo.root, "docs/prod"), { recursive: true });
  const a = await connect(w.socketPath, w.token, "notify-a", w.identity.repoId, w.repo.root);
  const b = await connect(w.socketPath, w.token, "notify-b", w.identity.repoId, w.repo.root);
  const ga = await grant(w, "notify-a");
  await a.call("index.sync", { action: "init", ...ga.params });

  const body = "BODY_MUST_NEVER_BE_BROADCAST";
  await writeFile(join(w.repo.root, "docs/prod/0197b7b0-6a20-7c51-8a32-b9465fb72d10.完成.md"), body);
  await waitFor(() => a.events.some((event) => event.event === "project.index.changed"));
  await a.call("index.sync", { action: "ensureFresh", ...ga.params });
  expect(hookEvents.length).toBeGreaterThan(0);
  expect(JSON.stringify(hookEvents)).not.toContain(body);
  expect(JSON.stringify(a.events)).not.toContain(body);
  expect(a.events.every((item) => item.event !== "project.index.changed" || !("body" in item.data))).toBe(true);
  expect(b.events.filter((event) => event.event === "project.index.changed")).toEqual([]);

  await a.call("index.sync", { action: "detach", ...ga.params });
  const count = a.events.length;
  await writeFile(join(w.repo.root, "src/index.ts"), "export const changedAfterDetach = true;\n");
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(a.events).toHaveLength(count);
});

test("返修：一个worktree慢操作不挡其他worktree，同workspace仍串行且共享业务预算", async () => {
  const blocked = gate();
  let slowRoot = "";
  let entered = 0;
  const w = await world({ coordinatorOptions: {
    maxPendingOperations: 3,
    async openService(options) {
      if (options.repositoryRoot === slowRoot) { entered += 1; await blocked.promise; }
      return ProjectIndexService.open(options);
    },
  } });
  const other = await addWorktree(w.repo);
  const otherService = await ProjectIndexService.open({ repositoryRoot: other.root, dataRoot: w.dataRoot, repoId: w.identity.repoId, authorize: () => true });
  const a = await connect(w.socketPath, w.token, "lane-a", w.identity.repoId, w.repo.root);
  await connect(w.socketPath, w.token, "lane-b", w.identity.repoId, other.root);
  const ga = await grant(w, "lane-a");
  const cb = w.server.clients().find((client) => client.windowId === "lane-b")!;
  const issued = await w.issue(cb, otherService.workspace);
  const sb = { ...otherService.workspace, grantId: issued.grantId };
  slowRoot = w.repo.root;
  const first = w.coordinator.preview(scopeOf(ga), ga.client);
  await waitFor(() => entered === 1);
  const second = w.coordinator.preview(scopeOf(ga), ga.client);
  let otherFinished = false;
  const independent = w.coordinator.preview(sb, cb).then(() => { otherFinished = true; });
  try {
    await expect(w.coordinator.preview(sb, cb)).rejects.toMatchObject({ code: "resource_limit" });
    await waitFor(() => otherFinished, 1_000);
    expect(entered).toBe(1);
  } finally {
    blocked.release();
    await Promise.all([first, second, independent]);
  }
  expect(entered).toBe(2);
  a.close();
});

test.each(["watch", "low_frequency"] as const)("返修：A init/B attach/A断开后B仍由%s自动同步", async (source) => {
  const w = await world({ archiveHook: () => {}, coordinatorOptions: {
    createManager(options) {
      return new ProjectIndexSyncManager({ ...options, lowFrequencyMs: source === "low_frequency" ? 100 : 60_000,
        ...(source === "low_frequency" ? { watchFactory: () => ({ close() {}, on() { return this; } }) } : {}),
      });
    },
  } });
  const a = await connect(w.socketPath, w.token, `owner-a-${source}`, w.identity.repoId, w.repo.root);
  const b = await connect(w.socketPath, w.token, `owner-b-${source}`, w.identity.repoId, w.repo.root);
  const ga = await grant(w, `owner-a-${source}`);
  const gb = await grant(w, `owner-b-${source}`);
  const first = await a.call("index.sync", { action: "init", ...ga.params });
  await b.call("index.sync", { action: "init", ...gb.params });
  a.close();
  await waitFor(() => w.server.clients().length === 1);
  b.events.length = 0;
  await writeFile(join(w.repo.root, "src/index.ts"), `export const afterOwnerDisconnect = "${source}";\n`);
  await waitFor(() => b.events.some((event) => event.data.reason === "reconciled_change"
    && event.data.baselineHash !== first.baselineHash), 2_000);
  expect(w.coordinator.status(scopeOf(gb), gb.client)).toMatchObject({ state: "fresh", attached: true, dirty: false });
  const service = await ProjectIndexService.open({ repositoryRoot: w.repo.root, dataRoot: w.dataRoot, repoId: w.identity.repoId, authorize: () => true });
  expect((await service.status()).index?.baselineHash).not.toBe(first.baselineHash);
});

test.each(["disconnect", "close-race"] as const)("返修：队列满时%s仍立即撤权并等待实际stop", async (mode) => {
  const blocked = gate();
  const stopping = gate();
  let hold = false;
  let entered = false;
  let stopEntered = false;
  let stopCalls = 0;
  let manager!: ProjectIndexSyncManager;
  const w = await world({ archiveHook: () => {}, coordinatorOptions: {
    maxPendingOperations: 1,
    async openService(options) {
      if (hold) { entered = true; await blocked.promise; }
      return ProjectIndexService.open(options);
    },
    createManager(options) {
      manager = new ProjectIndexSyncManager(options);
      const original = manager.stop.bind(manager);
      vi.spyOn(manager, "stop").mockImplementation(async () => {
        stopCalls += 1;
        stopEntered = true;
        await stopping.promise;
        return original();
      });
      return manager;
    },
  } });
  await connect(w.socketPath, w.token, `cleanup-${mode}`, w.identity.repoId, w.repo.root);
  const ga = await grant(w, `cleanup-${mode}`);
  await w.coordinator.init(scopeOf(ga), ga.client);
  hold = true;
  const business = w.coordinator.preview(scopeOf(ga), ga.client).catch((error: unknown) => error);
  await waitFor(() => entered);
  // 调用真实server上登记的断连入口，并持有清理Promise来核对失败与结束时机。
  let disconnected = false;
  const disconnect = Promise.resolve(w.server.onDisconnect!(ga.client)).then(() => { disconnected = true; });
  let closed = false;
  const close = mode === "close-race" ? w.coordinator.close().then(() => { closed = true; }) : Promise.resolve();
  void close.catch(() => undefined);
  try {
    expect(w.coordinator.status(scopeOf(ga), ga.client).attached).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(disconnected).toBe(false);
    expect(closed).toBe(false);
    blocked.release();
    await business;
    await waitFor(() => stopEntered, 1_000);
    expect(disconnected).toBe(false);
    expect(closed).toBe(false);
  } finally {
    blocked.release();
    stopping.release();
    await Promise.allSettled([business, disconnect, close]);
  }
  await expect(disconnect).resolves.toBeUndefined();
  await expect(close).resolves.toBeUndefined();
  expect(stopCalls).toBe(1);
  const internal = manager as unknown as { watchers: Map<string, unknown>; lowFrequencyTimer: unknown; started: boolean };
  expect(internal.watchers.size).toBe(0);
  expect(internal.lowFrequencyTimer).toBeNull();
  expect(internal.started).toBe(false);
  expect(w.coordinator.status(scopeOf(ga), ga.client)).toMatchObject({ state: mode === "close-race" ? "closed" : "absent", attached: false });
});

test("返修：在途A请求撤权不能借仍有效的B返回结果，后台之后仍可用B同步", async () => {
  const blocked = gate();
  let hold = false;
  let entered = false;
  const w = await world({ archiveHook: () => {}, coordinatorOptions: {
    createManager(options) {
      const manager = new ProjectIndexSyncManager({ ...options, lowFrequencyMs: 60_000 });
      const original = manager.ensureFresh.bind(manager);
      vi.spyOn(manager, "ensureFresh").mockImplementation(async () => {
        if (hold) { entered = true; await blocked.promise; }
        return original();
      });
      return manager;
    },
  } });
  const a = await connect(w.socketPath, w.token, "revoked-a", w.identity.repoId, w.repo.root);
  const b = await connect(w.socketPath, w.token, "revoked-b", w.identity.repoId, w.repo.root);
  const ga = await grant(w, "revoked-a");
  const gb = await grant(w, "revoked-b");
  await a.call("index.sync", { action: "init", ...ga.params });
  await b.call("index.sync", { action: "init", ...gb.params });
  hold = true;
  const request = w.coordinator.refresh(scopeOf(ga), ga.client);
  const denied = expect(request).rejects.toMatchObject({ code: "authorization_denied" });
  await waitFor(() => entered);
  const detached = w.coordinator.detach(scopeOf(ga), ga.client);
  try {
    expect(w.coordinator.status(scopeOf(ga), ga.client).attached).toBe(false);
    blocked.release();
    await denied;
    await detached;
  } finally { blocked.release(); await Promise.allSettled([request, detached]); }
  hold = false;
  b.events.length = 0;
  await writeFile(join(w.repo.root, "src/index.ts"), "export const afterRequestRevocation = true;\n");
  await waitFor(() => b.events.some((event) => event.data.reason === "reconciled_change"), 2_000);
  expect(w.coordinator.status(scopeOf(gb), gb.client)).toMatchObject({ state: "fresh", attached: true });
});

test.each(["workspace", "client-scope"] as const)("返修：并发创建期间预留%s全局预算", async (budget) => {
  const blocked = gate();
  let slowRoot = "";
  let entered = false;
  const w = await world({ archiveHook: () => {}, coordinatorOptions: {
    ...(budget === "workspace" ? { maxWorkspaces: 1 } : { maxClientScopes: 1 }),
    async openService(options) {
      if (options.repositoryRoot === slowRoot) { entered = true; await blocked.promise; }
      return ProjectIndexService.open(options);
    },
  } });
  const other = await addWorktree(w.repo);
  const service = await ProjectIndexService.open({ repositoryRoot: other.root, dataRoot: w.dataRoot, repoId: w.identity.repoId, authorize: () => true });
  await connect(w.socketPath, w.token, `reserve-a-${budget}`, w.identity.repoId, w.repo.root);
  await connect(w.socketPath, w.token, `reserve-b-${budget}`, w.identity.repoId, other.root);
  const ga = await grant(w, `reserve-a-${budget}`);
  const cb = w.server.clients().find((client) => client.windowId === `reserve-b-${budget}`)!;
  const issued = await w.issue(cb, service.workspace);
  slowRoot = w.repo.root;
  const first = w.coordinator.init(scopeOf(ga), ga.client);
  void first.catch(() => undefined);
  await waitFor(() => entered);
  try {
    await expect(w.coordinator.init({ ...service.workspace, grantId: issued.grantId }, cb)).rejects.toMatchObject({ code: "resource_limit" });
  } finally { blocked.release(); await first; }
});

test.each(["detach", "close"] as const)("返修：创建尚未登记时%s等待创建安全结束且撤销许可", async (mode) => {
  const blocked = gate();
  let entered = false;
  let managerCount = 0;
  const w = await world({ archiveHook: () => {}, coordinatorOptions: {
    maxPendingOperations: 1,
    async openService(options) { entered = true; await blocked.promise; return ProjectIndexService.open(options); },
    createManager(options) { managerCount += 1; return new ProjectIndexSyncManager(options); },
  } });
  await connect(w.socketPath, w.token, `creating-${mode}`, w.identity.repoId, w.repo.root);
  const ga = await grant(w, `creating-${mode}`);
  const init = w.coordinator.init(scopeOf(ga), ga.client);
  const denied = expect(init).rejects.toMatchObject({ code: "authorization_denied" });
  await waitFor(() => entered);
  let finished = false;
  const cleanup = (mode === "close" ? w.coordinator.close() : w.coordinator.detach(scopeOf(ga), ga.client)).then(() => { finished = true; });
  try {
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(finished).toBe(false);
  } finally { blocked.release(); await Promise.all([denied, cleanup]); }
  expect(managerCount).toBe(0);
  expect(() => w.verifier.validateForClient(ga.params.grantId, ga.client)).toThrow();
  expect(w.coordinator.status(scopeOf(ga), ga.client)).toMatchObject({ state: mode === "close" ? "closed" : "absent", attached: false });
});

test("返修：stop失败必须报告且保留拒绝状态，重复close共享操作并可明确重试", async () => {
  let fail = true;
  let calls = 0;
  let manager!: ProjectIndexSyncManager;
  const w = await world({ archiveHook: () => {}, coordinatorOptions: {
    createManager(options) {
      manager = new ProjectIndexSyncManager(options);
      const original = manager.stop.bind(manager);
      vi.spyOn(manager, "stop").mockImplementation(async () => {
        calls += 1;
        if (fail) throw new Error("injected stop failure");
        return original();
      });
      return manager;
    },
  } });
  await connect(w.socketPath, w.token, "stop-failure", w.identity.repoId, w.repo.root);
  const ga = await grant(w, "stop-failure");
  await w.coordinator.init(scopeOf(ga), ga.client);
  const first = w.coordinator.close();
  expect(w.coordinator.close()).toBe(first);
  try {
    await expect(first).rejects.toThrow("关闭收尾未完成");
    expect(w.coordinator.status(scopeOf(ga), ga.client).state).not.toBe("closed");
    await expect(w.coordinator.init(scopeOf(ga), ga.client)).rejects.toMatchObject({ code: "coordinator_closed" });
    expect(calls).toBe(1);
  } finally { fail = false; await w.coordinator.close(); }
  expect(calls).toBe(2);
  expect((manager as unknown as { watchers: Map<string, unknown> }).watchers.size).toBe(0);
  expect(w.coordinator.status(scopeOf(ga), ga.client).state).toBe("closed");
});

test("返修：重复detach等待同一个实际清理，不重复stop或提前完成", async () => {
  const stopping = gate();
  let entered = false;
  let calls = 0;
  const w = await world({ archiveHook: () => {}, coordinatorOptions: {
    createManager(options) {
      const manager = new ProjectIndexSyncManager(options);
      const original = manager.stop.bind(manager);
      vi.spyOn(manager, "stop").mockImplementation(async () => { calls += 1; entered = true; await stopping.promise; return original(); });
      return manager;
    },
  } });
  await connect(w.socketPath, w.token, "repeat-detach", w.identity.repoId, w.repo.root);
  const ga = await grant(w, "repeat-detach");
  await w.coordinator.init(scopeOf(ga), ga.client);
  const first = w.coordinator.detach(scopeOf(ga), ga.client);
  await waitFor(() => entered);
  let finished = false;
  const repeated = w.coordinator.detach(scopeOf(ga), ga.client).then((result) => { finished = true; return result; });
  try {
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(finished).toBe(false);
  } finally { stopping.release(); await Promise.all([first, repeated]); }
  expect(await first).toEqual({ detached: true });
  expect(await repeated).toEqual({ detached: false });
  expect(calls).toBe(1);
});

test.each(["detach", "close"] as const)("撤权返回false时%s不得假报完成或重新认可退休许可", async (action) => {
  const w = await world({ archiveHook: () => {} });
  await connect(w.socketPath, w.token, "revoke-false", w.identity.repoId, w.repo.root);
  const granted = await grant(w, "revoke-false");
  const scope = scopeOf(granted);
  await w.coordinator.init(scope, granted.client);
  const revoke = vi.spyOn(w.verifier, "revokeExact").mockResolvedValue(false);
  try {
    const outcome = await (action === "detach" ? w.coordinator.detach(scope, granted.client) : w.coordinator.close())
      .then(() => null, (error: unknown) => error);
    if (action === "detach") {
      const reattached = await w.coordinator.init(scope, granted.client).then(() => true, () => false);
      expect(reattached).toBe(false);
    } else expect(w.coordinator.status(scope, granted.client).state).not.toBe("closed");
    expect(outcome).toBeInstanceOf(Error);
    expect(revoke).toHaveBeenCalled();
  } finally {
    revoke.mockRestore();
    await w.coordinator.close();
  }
  expect(w.coordinator.status(scope, granted.client).state).toBe("closed");
});

test("创建中撤权返回false保留待恢复标记，拒绝旧许可重试并允许准确清理重试", async () => {
  const opening = gate();
  const entered = gate();
  const w = await world({ archiveHook: () => {}, coordinatorOptions: {
    async openService(options) {
      entered.release();
      await opening.promise;
      return ProjectIndexService.open(options);
    },
  } });
  await connect(w.socketPath, w.token, "creating-revoke-false", w.identity.repoId, w.repo.root);
  const granted = await grant(w, "creating-revoke-false");
  const scope = scopeOf(granted);
  const attaching = w.coordinator.init(scope, granted.client).then(() => null, (error: unknown) => error);
  await entered.promise;
  const revoke = vi.spyOn(w.verifier, "revokeExact").mockResolvedValue(false);
  try {
    const detaching = w.coordinator.detach(scope, granted.client).then(() => null, (error: unknown) => error);
    opening.release();
    expect(await attaching).toBeInstanceOf(Error);
    expect(await detaching).toBeInstanceOf(Error);
    await expect(w.coordinator.init(scope, granted.client)).rejects.toMatchObject({ code: "authorization_denied" });
  } finally {
    opening.release();
    revoke.mockRestore();
    await w.coordinator.detach(scope, granted.client);
    await w.coordinator.close();
  }
  expect(w.coordinator.status(scope, granted.client).state).toBe("closed");
});

test("并发attach/disconnect/close收敛，close等待实际操作且不留下manager", async () => {
  const counter = { count: 0 };
  const w = await world({ archiveHook: () => {}, managerCounter: counter });
  const peer = await connect(w.socketPath, w.token, "race", w.identity.repoId, w.repo.root);
  const granted = await grant(w, "race");
  const attaching = peer.call("index.sync", { action: "init", ...granted.params });
  void attaching.catch(() => undefined);
  peer.close();
  await w.coordinator.close();
  expect(w.coordinator.status(scopeOf(granted), granted.client)).toEqual({ state: "closed", attached: false });
  expect(counter.count).toBeLessThanOrEqual(1);
});
