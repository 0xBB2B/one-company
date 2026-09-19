import { afterEach, expect, test, vi } from "vitest";
import crypto, { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import fs, { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { syncBuiltinESMExports } from "node:module";
import syncFs, { existsSync } from "node:fs";
import { join } from "node:path";
import net from "node:net";
import { promisify } from "node:util";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import projectManageExtension, { activeProjectSyncController, captureProjectFreshBaseline } from "../extensions/project-manage.ts";
import lifecycleExtension, { shutdownWindow, windowContext } from "../extensions/lifecycle.ts";
import type { WindowContextValue } from "../extensions/lifecycle.ts";
import { WindowRegistry } from "../runtime/windows.ts";
import type { ShellRegistry } from "../runtime/shell-registry.ts";
import { EventEmitter } from "node:events";
import { DaemonServer } from "../daemon/server.ts";
import { ProjectIndexCoordinator } from "../daemon/project-index-coordinator.ts";
import { ProjectIndexSyncManager } from "../runtime/project-index-sync.ts";
import { ProjectSyncGrantVerifier, PROJECT_INDEX_GRANT_NAMESPACE } from "../runtime/project-sync-grants.ts";
import { connectDaemon } from "../runtime/daemon-client.ts";
import type { DaemonClient, WorkspaceClientsHandle } from "../runtime/daemon-client.ts";
import { controlToken } from "../runtime/daemon-auth.ts";
import { daemonSocketPath, repositoryIdentity, repoDataDir } from "../runtime/identity.ts";
import { LocalDatabase, repositoryDatabase } from "../runtime/database.ts";
import { IndexStore } from "../runtime/index-store.ts";
import { createHostProjectBaselineProvider } from "../extensions/project-baseline.ts";
import { RequestBaselineGate } from "../runtime/project-baseline.ts";
import { createClock } from "../runtime/clock.ts";
import { PROJECT_INDEX_MANAGEMENT_NAMESPACE, ProjectSyncClientSession } from "../runtime/project-sync-client.ts";
import type { ProjectSyncClientChange } from "../runtime/project-sync-client.ts";
import type { createProjectManageTool } from "../runtime/project-manage-tool.ts";
import { createFakePi } from "./helpers/fake-pi.ts";
import { createFakeTimeSource } from "./helpers/fake-clock.ts";
import { GIT_ENV } from "./helpers/repo-fixture.ts";
import { cleanupOwnedScope } from "./helpers/m3-cleanup.ts";
import { createClientSocketProbe, createClientWatcherProbe } from "./helpers/project-sync-client-watchers.ts";


const exec = promisify(execFile);
const cleanup: Array<() => Promise<unknown>> = [];
const fixtureRoots: string[] = [];
const releaseGates: Array<() => void> = [];
const diagnostics: Array<() => Promise<unknown>> = [];
function gate() { let release!: () => void; const promise = new Promise<void>((resolve) => { release = resolve; }); return { promise, release }; }
async function waitFor(check: () => boolean | Promise<boolean>): Promise<void> {
  for (let i = 0; i < 250; i++) { if (await check()) return; await new Promise((resolve) => setTimeout(resolve, 20)); }
  throw new Error("宿主索引条件超时");
}

afterEach(async (context) => {
  const roots = fixtureRoots.splice(0);
  const releases = releaseGates.splice(0);
  const stops = cleanup.splice(0).reverse();
  const checks = diagnostics.splice(0);
  try {
    await cleanupOwnedScope({
      paths: roots,
      stop: [
        ...releases.map((run, index) => ({ label: `释放宿主闸门 ${index}`, run, timeoutMs: 1_000 })),
        ...stops.map((run, index) => ({ label: `停止宿主资源 ${index}`, run, timeoutMs: 1_000 })),
      ],
      diagnose: [
        ...checks.map((run, index) => ({ label: `核对宿主真实关闭 ${index}`, timeoutMs: 1_000, run: async () => {
          const result = await run();
          if (context.task.result?.state === "fail") console.info("失败现场真实关闭诊断", { index, result, stopOperations: stops.length });
        } })),
        { label: "宿主用例结果", run() { if (context.task.result?.state === "fail") throw new Error("用例失败，保留现场"); } },
      ],
      remove: roots.map((root) => ({ label: `回收 ${root}`, run: () => rm(root, { recursive: true, force: true }) })),
    });
  } catch (error) {
    console.error("宿主夹具失败，保留现场：", roots);
    throw error;
  } finally {
    vi.restoreAllMocks();
    syncBuiltinESMExports();
  }
}, 30_000);

test("knowledge controller沿真实grant查询并复核，断线/异步返回竞争/其他窗口不借权", async () => {
  const w = await world({ suppressWatch: true });
  const a = await w.host("query-session", "query-window");
  const b = await w.host("query-other", "query-other-window");
  expect(a.controller()).toBeUndefined();
  await a.call("init");
  expect(b.controller()).toBeUndefined();
  const controller = a.controller()!;
  const result = await controller.knowledgeQuery!({ action: "facts", pageSize: 1 });
  await result.verify();
  expect(() => result.assertLive()).not.toThrow();
  expect(result.page.requirement).toBeNull();
  expect(result.page.nextCursor).not.toBeNull();
  await writeFile(join(w.repositoryRoot, "source.ts"), "export const initial = 1; // 返回后修改\n");
  await expect(result.verify()).rejects.toThrow();
  const original = vi.mocked(a.client.call).getMockImplementation()!;
  let held = false;
  vi.spyOn(a.client, "call").mockImplementation(async (method, params) => {
    const value = await original(method, params);
    if (method === "project.index.query" && params?.action === "query") { held = true; a.client.close(); }
    return value;
  });
  await a.call("refresh");
  await expect(controller.knowledgeQuery!({ action: "facts", pageSize: 1 })).rejects.toThrow();
  expect(held).toBe(true);
  expect(() => result.assertLive()).toThrow();
  await expect(controller.knowledgeQuery!({ action: "facts", pageSize: 1, cursor: result.page.nextCursor })).rejects.toThrow();
  expect(a.confirmations()).toBe(1);
}, 30_000);

test.each([1, 2, 3])("controller真实check RPC后微任务深度%d断连，最外层verify必须拒绝", async (depth) => {
  const w = await world({ suppressWatch: true }), host = await w.host(); await host.call("init");
  const controller = host.controller()!, delivery = await controller.knowledgeQuery!({ action: "facts" });
  const original = vi.mocked(host.client.call).getMockImplementation()!;
  let disconnected = false;
  vi.spyOn(host.client, "call").mockImplementation(async (method, params) => {
    const result = await original(method, params);
    if (method === "project.index.query" && params?.action === "check") {
      const schedule = (remaining: number) => {
        if (!remaining) { host.client.close(); disconnected = true; }
        else queueMicrotask(() => schedule(remaining - 1));
      };
      schedule(depth);
    }
    return result;
  });
  await expect(delivery.verify()).rejects.toThrow();
  expect(disconnected).toBe(true);
  expect(() => delivery.assertLive()).toThrow();
}, 30_000);

test("client watcher装置只在真实close事件后归零，调用次数单独记录", async () => {
  const root = await realpath(await mkdtemp("/tmp/m3-host-fixture-"));
  await chmod(root, 0o700); fixtureRoots.push(root);
  const probe = createClientWatcherProbe();
  const watcher = probe.watch(root, () => {});
  cleanup.push(async () => { watcher.close(); await probe.closed(); });
  let nativeClosed = false;
  watcher.once("close", () => { nativeClosed = true; });
  watcher.close();
  expect(nativeClosed).toBe(false);
  expect(probe.snapshot()).toMatchObject({ active: 1, closeCalls: 1, closeEvents: 0, closeErrors: 0 });
  await probe.closed();
  expect(nativeClosed).toBe(true);
  expect(probe.snapshot()).toMatchObject({ created: 1, active: 0, closeCalls: 1, closeEvents: 1, closeErrors: 0 });
});

test("client收尾逐项有界，超时仍停止后续资源并保留目录，迟到完成不冒充成功", async () => {
  const root = await realpath(await mkdtemp("/tmp/m3-host-fixture-"));
  await chmod(root, 0o700); fixtureRoots.push(root);
  const hold = gate(); releaseGates.push(hold.release);
  const visited: string[] = [];
  const pending = hold.promise.then(() => { visited.push("late-stopped"); });
  cleanup.push(() => pending);
  let removed = false;
  try {
    await expect(cleanupOwnedScope({ paths: [root], stop: [
      { label: "不会自行结束的资源", timeoutMs: 25, run: () => pending },
      { label: "后续资源", run: async () => { visited.push("next-stopped"); hold.release(); await pending; } },
    ], diagnose: [{ label: "实际结束核对", run() { expect(visited).toEqual(["next-stopped", "late-stopped"]); } }],
    remove: [{ label: "不得删除失败现场", run: async () => { removed = true; await rm(root, { recursive: true }); } }],
    })).rejects.toThrow("保留关联现场");
    expect(visited).toEqual(["next-stopped", "late-stopped"]);
    expect(removed).toBe(false);
    expect(existsSync(root)).toBe(true);
  } finally { hold.release(); await pending; }
});

async function world(options: { holdInit?: ReturnType<typeof gate>; initEntered?: ReturnType<typeof gate>; suppressWatch?: boolean } = {}) {
  if (options.holdInit) releaseGates.push(options.holdInit.release);
  const root = await realpath(await mkdtemp("/tmp/m3-host-fixture-"));
  await chmod(root, 0o700);
  fixtureRoots.push(root);
  const repositoryRoot = join(root, "repo");
  const dataRoot = join(root, "data");
  await mkdir(repositoryRoot); await mkdir(dataRoot, { mode: 0o700 });
  await exec("git", ["init", "-b", "main"], { cwd: repositoryRoot, env: GIT_ENV });
  await writeFile(join(repositoryRoot, "source.ts"), "export const initial = 1;\n");
  await exec("git", ["add", "source.ts"], { cwd: repositoryRoot, env: GIT_ENV });
  await exec("git", ["commit", "-m", "fixture"], { cwd: repositoryRoot, env: GIT_ENV });
  const { repoId, commonDir } = await repositoryIdentity(repositoryRoot);
  await repoDataDir(dataRoot, repoId, commonDir);
  await mkdir(join(dataRoot, "sock"), { mode: 0o700 });
  let managerCount = 0;
  const watchers = createClientWatcherProbe(options.suppressWatch);
  const sockets = createClientSocketProbe();
  vi.spyOn(net, "createConnection").mockImplementation(sockets.connect);
  syncBuiltinESMExports();
  diagnostics.push(async () => {
    await sockets.closed();
    const counts = sockets.snapshot();
    expect(counts.active).toBe(0);
    expect(counts.closeEvents).toBe(counts.created);
    return { sockets: counts };
  });
  diagnostics.push(async () => {
    await watchers.closed();
    const counts = watchers.snapshot();
    expect(counts.active).toBe(0);
    expect(counts.closeEvents).toBe(counts.created);
    expect(counts.closeErrors).toBe(0);
    expect(counts.watchErrors).toBe(0);
    return counts;
  });
  const managers: ProjectIndexSyncManager[] = [];
  async function startServer() {
    const server = new DaemonServer({ authToken: controlToken(dataRoot), repoId, startedAt: "host-test" });
    const verifier = new ProjectSyncGrantVerifier({ dataRoot, repoId, commonDir, daemonInstanceId: server.daemonInstanceId });
    const coordinator = new ProjectIndexCoordinator({ repoId, commonDir, dataRoot, server, grants: verifier, beforeArchiveRisk: () => {},
      createManager(input) {
        managerCount++;
        const manager = new ProjectIndexSyncManager({ ...input, debounceMs: 20, lowFrequencyMs: 60_000,
          watchFactory: watchers.watch });
        managers.push(manager);
        if (options.holdInit) {
          const start = manager.start.bind(manager);
          manager.start = async () => { options.initEntered?.release(); await options.holdInit!.promise; return start(); };
        }
        return manager;
      } });
    cleanup.push(() => server.close());
    cleanup.push(() => coordinator.close());
    await server.listen(daemonSocketPath(dataRoot, repoId));
    server.markHandlersReady();
    return { server, coordinator, verifier };
  }
  const first = await startServer();
  const time = createFakeTimeSource();
  const clock = createClock({ timeSource: time });
  cleanup.push(async () => { clock.stopGapWatcher(); });
  const calls: Array<Record<string, unknown>> = [];
  async function host(sessionId = "session-1", windowId = "window-1", hostRoot = repositoryRoot) {
    const client = await connectDaemon({ repoDir: hostRoot, dataRoot, sdkDir: "/not-spawned", clock,
      hello: { sessionId, windowId, pid: process.pid, cwd: hostRoot, workspaceRoot: hostRoot } });
    cleanup.push(async () => { client.close(); });
    const actualCall = client.call.bind(client);
    vi.spyOn(client, "call").mockImplementation((method, params) => {
      if (method === "index.sync") calls.push({ ...params });
      return actualCall(method, params);
    });
    const workspace = { repos: [{ path: hostRoot, repoId, commonDir }], skipped: [] };
    const collection: WorkspaceClientsHandle = { forRepo: (id) => id === repoId ? client : undefined,
      all: () => [client], skipped: () => [], workspace: () => workspace, closeAll: () => client.close() };
    const window: WindowContextValue = { windowId, sessionId, workspace, clients: collection };
    let live = true;
    let approve = true;
    let confirmations = 0;
    const prompts: string[] = [];
    const ctx = { cwd: hostRoot, hasUI: true, mode: "rpc",
      sessionManager: { getSessionId: () => sessionId },
      ui: { confirm: async (_title: string, message: string) => { confirmations++; prompts.push(message); return approve; } },
    } as unknown as ExtensionContext;
    const fake = createFakePi();
    // 只注入 lifecycle 现场；openService 未注入，必须走真实产品默认 daemon adapter。
    projectManageExtension(fake.pi as unknown as ExtensionAPI, { dataRoot, windowReady: async () => window,
      windowContext: () => { if (!live) throw new Error("closed"); return window; } });
    const tool = fake.registeredTools()[0] as ReturnType<typeof createProjectManageTool>["tool"];
    await fake.trigger("session_start", {}, ctx);
    const shutdown = async () => { live = false; await fake.trigger("session_shutdown", {}, ctx); };
    cleanup.push(shutdown);
    return { client, ctx, window, shutdown, binding: { windowId, sessionId, repoId },
      approve: (value: boolean) => { approve = value; }, confirmations: () => confirmations, prompts,
      controller: () => activeProjectSyncController({ windowId, sessionId, repoId }),
      call: (action: "init" | "status" | "refresh", preview?: boolean, signal?: AbortSignal) => tool.execute("host-call",
        { action, repoId, ...(preview === undefined ? {} : { preview }) } as never, signal, undefined, ctx),
    };
  }
  function grants() {
    const db = new LocalDatabase(repositoryDatabase(dataRoot, repoId));
    try { return db.list<Record<string, unknown>>(PROJECT_INDEX_GRANT_NAMESPACE).map((row) => row.data); } finally { db.close(); }
  }
  function management() {
    const db = new LocalDatabase(repositoryDatabase(dataRoot, repoId));
    try { return db.list<Record<string, unknown>>(PROJECT_INDEX_MANAGEMENT_NAMESPACE); } finally { db.close(); }
  }
  return { root, repositoryRoot, dataRoot, repoId, commonDir, first, startServer, host, calls, grants, management, time,
    managerCount: () => managerCount, activeWatchers: () => watchers.snapshot().active, managers };
}

function transactionWindowProbe() {
  const active = new Set<DatabaseSync>();
  const inside: string[] = [], outside: string[] = [];
  let windows = 0;
  const observe = (operation: string) => { (active.size ? inside : outside).push(operation); };
  const exec = DatabaseSync.prototype.exec, close = DatabaseSync.prototype.close;
  vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function(sql) {
    const result = exec.call(this, sql);
    if (/(?:^|;)\s*BEGIN\b/iu.test(sql)) { active.add(this); windows++; }
    if (/(?:^|;)\s*(?:COMMIT|ROLLBACK)\b/iu.test(sql)) active.delete(this);
    return result;
  });
  vi.spyOn(DatabaseSync.prototype, "close").mockImplementation(function() {
    const result = close.call(this); active.delete(this); return result;
  });
  for (const name of ["lstatSync", "realpathSync", "existsSync", "chmodSync", "mkdirSync", "readFileSync", "openSync"] as const) {
    const original = syncFs[name] as (...args: unknown[]) => unknown;
    vi.spyOn(syncFs, name).mockImplementation(((...args: unknown[]) => {
      observe(name); return Reflect.apply(original, syncFs, args);
    }) as never);
  }
  const hash = crypto.createHash;
  vi.spyOn(crypto, "createHash").mockImplementation((...args) => { observe("createHash"); return hash(...args); });
  syncBuiltinESMExports();
  return { inside, outside, observe, active, windows: () => windows };
}

test("管理登记真实事务窗口没有文件IO、指纹计算或宿主回调", async () => {
  const w = await world(); const host = await w.host();
  const open = ProjectSyncClientSession.prototype.openService;
  let probe!: ReturnType<typeof transactionWindowProbe>;
  vi.spyOn(ProjectSyncClientSession.prototype, "openService").mockImplementationOnce(async function(input) {
    probe = transactionWindowProbe();
    const handle = await open.call(this, { ...input, authorizeContinuous: () => {
      probe.observe("authorizeContinuous"); return input.authorizeContinuous();
    } });
    // 打开service即完成登记；不调用init，避免把daemon的其他事务混入本探针。
    return { ...handle, init: async () => { throw new Error("transaction probe stops before daemon init"); } };
  });
  await expect(host.call("init")).rejects.toMatchObject({ code: "operation_failed" });
  console.info("management transaction probe", { windows: probe.windows(), inside: probe.inside,
    outside: [...new Set(probe.outside)] });
  expect(probe.windows()).toBeGreaterThan(0);
  expect(probe.active.size).toBe(0);
  expect(probe.outside).toContain("lstatSync");
  expect(probe.outside).toContain("createHash");
  expect(probe.outside).toContain("authorizeContinuous");
  expect(probe.inside).toEqual([]);
  expect(w.management()).toHaveLength(1);
  expect(w.calls.filter((call) => call.action === "init")).toEqual([]);
});

test("只读管理与索引查询真实事务窗口没有文件IO或指纹计算", async () => {
  const w = await world(); const a = await w.host(); await a.call("init");
  await a.shutdown(); a.client.close();
  await exec("git", ["switch", "-c", "probe-other"], { cwd: w.repositoryRoot, env: GIT_ENV });
  const b = await w.host("probe-b", "probe-b");
  const probe = transactionWindowProbe();
  expect((await captureProjectFreshBaseline(b.binding)).kind).toBe("unmanaged");
  console.info("readonly transaction probe", { windows: probe.windows(), inside: probe.inside,
    outside: [...new Set(probe.outside)] });
  expect(probe.windows()).toBe(2);
  expect(probe.active.size).toBe(0);
  expect(probe.outside).toContain("lstatSync");
  expect(probe.outside).toContain("createHash");
  expect(probe.inside).toEqual([]);
});

test.each(["repository", "management"])("管理登记准备后%s版本变化，短事务拒绝旧准备结果且不覆盖现有事实", async (kind) => {
  const w = await world();
  if (kind === "management") {
    const a = await w.host(); await a.call("init"); await a.shutdown(); a.client.close();
  }
  const b = await w.host("version-b", "version-b");
  const path = repositoryDatabase(w.dataRoot, w.repoId);
  const original = DatabaseSync.prototype.exec;
  let injected = false;
  const hook = vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function(sql) {
    if (!injected && sql === "BEGIN IMMEDIATE") {
      injected = true;
      const competitor = new DatabaseSync(path);
      try { competitor.prepare("UPDATE records SET version = version + 1 WHERE namespace = ?")
        .run(kind === "repository" ? "repository" : PROJECT_INDEX_MANAGEMENT_NAMESPACE); }
      finally { competitor.close(); }
    }
    return original.call(this, sql);
  });
  const callsBefore = w.calls.length, grantsBefore = w.grants();
  await expect(b.call("init")).rejects.toMatchObject({ code: "operation_failed" });
  hook.mockRestore();
  expect(injected).toBe(true);
  expect(b.controller()).toBeUndefined();
  expect(w.calls.length).toBe(callsBefore);
  expect(w.grants()).toEqual(grantsBefore);
  const managed = w.management();
  if (kind === "management") { expect(managed).toHaveLength(1); expect(managed[0]!.version).toBe(2); }
  else expect(managed).toEqual([]);
  await b.call("init");
  expect(b.controller()!.isActive()).toBe(true);
  if (kind === "management") expect(w.management()).toEqual(managed);
});

test.each(["permission", "file-identity", "directory-identity"])("管理登记提交后%s变化拒绝controller，已提交事实保留且新窗口不能legacy", async (kind) => {
  const w = await world(); const a = await w.host();
  const path = repositoryDatabase(w.dataRoot, w.repoId);
  const directory = join(w.dataRoot, "repos", w.repoId);
  const originalExec = DatabaseSync.prototype.exec, originalClose = DatabaseSync.prototype.close;
  const originalOpen = ProjectSyncClientSession.prototype.openService;
  let permitted = true, committed = false, injected = false;
  vi.spyOn(ProjectSyncClientSession.prototype, "openService").mockImplementationOnce(function(input) {
    return originalOpen.call(this, { ...input, authorizeContinuous: () => permitted && input.authorizeContinuous() });
  });
  const commitHook = vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function(sql) {
    const result = originalExec.call(this, sql);
    if (sql === "COMMIT") committed = true;
    return result;
  });
  const hook = vi.spyOn(DatabaseSync.prototype, "close").mockImplementation(function() {
    const result = originalClose.call(this);
    if (committed && !injected) {
      injected = true;
      if (kind === "permission") permitted = false;
      else if (kind === "file-identity") {
        // 关闭连接后主库已完成checkpoint；保留完整原件，只改变待核对文件的inode。
        syncFs.renameSync(path, `${path}.committed`);
        syncFs.copyFileSync(`${path}.committed`, path);
      } else {
        syncFs.renameSync(directory, `${directory}.committed`);
        syncFs.mkdirSync(directory, { mode: 0o700 });
        for (const name of syncFs.readdirSync(`${directory}.committed`)) {
          syncFs.renameSync(join(`${directory}.committed`, name), join(directory, name));
        }
      }
    }
    return result;
  });
  await expect(a.call("init")).rejects.toMatchObject({ code: "operation_failed" });
  hook.mockRestore(); commitHook.mockRestore();
  expect(committed).toBe(true); expect(injected).toBe(true);
  expect(a.controller()).toBeUndefined();
  expect(w.calls.filter((call) => call.action === "init")).toEqual([]);
  expect(w.grants()).toEqual([]);
  if (kind === "file-identity") {
    syncFs.unlinkSync(path); syncFs.renameSync(`${path}.committed`, path);
  }
  const registered = w.management(); expect(registered).toHaveLength(1);
  const b = await w.host("postcommit-b", "postcommit-b");
  await expect(captureProjectFreshBaseline(b.binding)).rejects.toThrow();
  expect(w.management()).toEqual(registered);
  permitted = true;
  await b.call("init");
  expect(b.controller()!.isActive()).toBe(true);
  expect(w.management()).toEqual(registered);
});

test.each(["data.db", "index.db"])("只读查询关闭连接后%s身份变化仍拒绝，不把旧元数据当未管理", async (name) => {
  const w = await world(); const a = await w.host(); await a.call("init");
  await a.shutdown(); a.client.close();
  await exec("git", ["switch", "-c", "readonly-race"], { cwd: w.repositoryRoot, env: GIT_ENV });
  const b = await w.host("readonly-b", "readonly-b");
  const path = join(w.dataRoot, "repos", w.repoId, name);
  const originalExec = DatabaseSync.prototype.exec, originalClose = DatabaseSync.prototype.close;
  const readers = new Set<DatabaseSync>();
  let readersClosed = 0, replaced = false;
  vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function(sql) {
    const result = originalExec.call(this, sql);
    if (sql === "PRAGMA query_only = ON; BEGIN") readers.add(this);
    return result;
  });
  const hook = vi.spyOn(DatabaseSync.prototype, "close").mockImplementation(function() {
    const result = originalClose.call(this);
    if (readers.delete(this) && ++readersClosed === (name === "data.db" ? 1 : 2)) {
      syncFs.renameSync(path, `${path}.original`);
      syncFs.copyFileSync(`${path}.original`, path);
      replaced = true;
    }
    return result;
  });
  const callsBefore = w.calls.length;
  await expect(captureProjectFreshBaseline(b.binding)).rejects.toThrow();
  hook.mockRestore();
  expect(replaced).toBe(true);
  expect(w.calls.length).toBe(callsBefore);
  syncFs.unlinkSync(path); syncFs.renameSync(`${path}.original`, path);
  await expect(captureProjectFreshBaseline(b.binding)).rejects.toThrow();
  expect(b.controller()).toBeUndefined();
});

test("真实默认extension：无授权status和UI拒绝不扫描；preview一次许可不升级；一次批准持续同步", async () => {
  const w = await world(); const host = await w.host();
  expect(await captureProjectFreshBaseline(host.binding)).toEqual({ kind: "unmanaged", reason: "not_initialized" });
  await host.call("status");
  host.approve(false);
  await expect(host.call("init")).rejects.toMatchObject({ code: "scan_declined" });
  expect(w.managerCount()).toBe(0); expect(w.grants()).toEqual([]);
  expect(existsSync(join(w.dataRoot, "repos", w.repoId, "index.db"))).toBe(false);
  host.approve(true);
  await host.call("init", true);
  expect(w.management()).toEqual([]);
  expect(w.grants().map((grant) => grant.status)).toEqual(["revoked"]);
  expect(w.managerCount()).toBe(0);
  expect(host.controller()).toBeUndefined();
  expect(host.prompts.at(-1)).toContain("仅允许一次路径枚举");
  const output = await host.call("init");
  expect(host.confirmations()).toBe(3);
  expect(w.managerCount()).toBe(1);
  expect(host.prompts.at(-1)).toContain("断线重连");
  const controller = host.controller()!;
  expect(controller.isActive()).toBe(true);
  expect((await host.call("status")).details).toMatchObject({ initialized: true, cacheVerified: false, index: { status: "ready" } });
  const events: ProjectSyncClientChange[] = [];
  const unsubscribe = controller.subscribeInvalidation((event) => events.push(event));
  const { snapshot: baseline } = await controller.captureFreshBaseline();
  expect(baseline.files).toEqual([{ path: "source.ts", hash: createHash("sha256").update("export const initial = 1;\n").digest("hex") }]);
  expect(Object.isFrozen(baseline.files)).toBe(true);
  expect(Object.isFrozen(baseline.files[0])).toBe(true);
  await controller.assertCurrent(baseline);
  await writeFile(join(w.repositoryRoot, "source.ts"), "export const changed = 2;\n");
  const index = new IndexStore(join(w.dataRoot, "repos", w.repoId, "index.db"), controller.workspace);
  try { await waitFor(() => { const status = index.status(); return !!status && status.status === "ready" && status.baselineHash !== baseline.baselineHash; }); }
  finally { index.close(); }
  expect(events.some((event) => event.reason === "changed")).toBe(true);
  await expect(controller.assertCurrent(baseline)).rejects.toThrow();
  await host.call("refresh"); expect(host.confirmations()).toBe(3);
  expect(w.managerCount()).toBe(1);
  const tokens = w.calls.filter((call) => typeof call.grantId === "string").map((call) => call.grantId as string);
  for (const token of tokens) expect(JSON.stringify([output, events, baseline])).not.toContain(token);
  expect(events.some((event) => (event as unknown as { path?: string }).path === "source.ts")).toBe(true);
  unsubscribe();
  await host.shutdown();
  await expect(captureProjectFreshBaseline(host.binding)).rejects.toThrow();
  expect(controller.isActive()).toBe(false);
  expect(w.grants().every((grant) => grant.status === "revoked")).toBe(true);
});

test("未初始化legacy每次写入前只查元数据，不扫描正文、不创建index.db或签发许可", async () => {
  const w = await world(); const host = await w.host();
  const provider = createHostProjectBaselineProvider({ binding: host.binding, dataRoot: w.dataRoot });
  const baseline = new RequestBaselineGate(provider);
  cleanup.push(async () => { baseline.dispose(); provider.dispose(); });
  const reads = vi.spyOn(fs, "open"), enumerations = vi.spyOn(fs, "opendir");
  syncBuiltinESMExports();
  const request = await baseline.beginRequest();
  expect(request.kind).toBe("unmanaged");
  baseline.bindCalls(["legacy-write"], request);
  await baseline.validateRequest(request);
  let ran = false;
  await baseline.withMutation("legacy-write", { paths: ["source.ts"] }, async () => { ran = true; });
  expect(ran).toBe(true);
  expect(reads.mock.calls.filter(([path]) => String(path).startsWith(w.repositoryRoot))).toEqual([]);
  expect(enumerations.mock.calls).toEqual([]);
  expect(w.calls).toEqual([]);
  expect(w.grants()).toEqual([]);
  expect(w.managerCount()).toBe(0);
  expect(host.confirmations()).toBe(0);
  expect(existsSync(join(w.dataRoot, "repos", w.repoId, "index.db"))).toBe(false);
});

test("unmanaged元数据核对在途时shutdown先失效绑定，再等待自有核对结束", async () => {
  const w = await world(); const host = await w.host();
  const entered = gate(), release = gate();
  const actual = fs.realpath;
  vi.spyOn(fs, "realpath").mockImplementationOnce(async (...args: Parameters<typeof fs.realpath>) => {
    entered.release(); await release.promise; return actual(...args);
  });
  syncBuiltinESMExports();
  const pending = captureProjectFreshBaseline(host.binding);
  const rejected = pending.then(() => "unexpected", () => "rejected");
  await entered.promise;
  let stopped = false;
  const shutdown = host.shutdown().then(() => { stopped = true; });
  try { await Promise.resolve(); expect(stopped).toBe(false); }
  finally { release.release(); expect(await rejected).toBe("rejected"); await shutdown; }
  expect(stopped).toBe(true);
  expect(existsSync(join(w.dataRoot, "repos", w.repoId, "index.db"))).toBe(false);
});

test("持久管理跨窗口：B未批准、A关闭和重建session/provider均拒绝，不借A许可或偷偷扫描", async () => {
  const w = await world(); const a = await w.host();
  await a.call("init");
  const b = await w.host("b", "b");
  const provider = createHostProjectBaselineProvider({ binding: b.binding, dataRoot: w.dataRoot });
  cleanup.push(async () => { provider.dispose(); });
  const grantsBefore = w.grants().length, callsBefore = w.calls.length;
  const reads = vi.spyOn(fs, "open"), enumerations = vi.spyOn(fs, "opendir");
  syncBuiltinESMExports();
  await expect(captureProjectFreshBaseline(b.binding)).rejects.toThrow();
  await expect(provider.captureFresh()).rejects.toThrow();
  expect(w.calls.length).toBe(callsBefore);
  expect(b.confirmations()).toBe(0);
  await a.shutdown(); a.client.close();
  const afterShutdown = w.calls.length;
  await expect(provider.captureFresh()).rejects.toThrow();
  await b.shutdown(); b.client.close();
  const c = await w.host("new-session", "b");
  const renewed = createHostProjectBaselineProvider({ binding: c.binding, dataRoot: w.dataRoot });
  cleanup.push(async () => { renewed.dispose(); });
  await expect(renewed.captureFresh()).rejects.toThrow();
  expect(reads.mock.calls.filter(([path]) => String(path).startsWith(w.repositoryRoot))).toEqual([]);
  expect(enumerations.mock.calls).toEqual([]);
  expect(w.calls.length).toBe(afterShutdown);
  expect(w.grants().length).toBe(grantsBefore);
  expect(c.confirmations()).toBe(0);
  expect(w.activeWatchers()).toBe(0);
  await c.call("init");
  expect(c.confirmations()).toBe(1);
  expect((await renewed.captureFresh()).kind).toBe("fresh");
  // 阳性对照：同一探针确实捕获获批后产品的 opendir/open 扫描入口。
  expect(enumerations.mock.calls.length).toBeGreaterThan(0);
  expect(reads.mock.calls.some(([path]) => String(path).startsWith(w.repositoryRoot))).toBe(true);
});

test.each(["active", "closed"])("B原unmanaged请求之后A初始化（%s）：实际写入边界拒绝旧请求，不升级origin", async (state) => {
  const w = await world(); const a = await w.host(); const b = await w.host("b", "b");
  const provider = createHostProjectBaselineProvider({ binding: b.binding, dataRoot: w.dataRoot });
  const baseline = new RequestBaselineGate(provider);
  cleanup.push(async () => { baseline.dispose(); provider.dispose(); });
  const request = await baseline.beginRequest();
  expect(request.kind).toBe("unmanaged");
  baseline.bindCalls(["old-write"], request);
  await baseline.validateRequest(request);
  await a.call("init");
  if (state === "closed") { await a.shutdown(); a.client.close(); }
  await writeFile(join(w.repositoryRoot, "source.ts"), "export const external = true;\n");
  let ran = false;
  const callsBefore = w.calls.length;
  await expect(baseline.withMutation("old-write", { paths: ["source.ts"] }, async () => { ran = true; })).rejects.toMatchObject({ code: "stale" });
  expect(ran).toBe(false);
  expect(request.origin).toBeNull();
  expect(baseline.diagnostics.stale).toBe(true);
  expect(w.calls.length).toBe(callsBefore);
  expect(b.confirmations()).toBe(0);
  await expect(baseline.beginRequest()).rejects.toMatchObject({ code: "unavailable" });
});

test.each(["corrupt", "schema", "workspace", "registration", "empty", "identity", "application", "permissions"])("持久元数据损坏或缺失（%s）拒绝新窗口且不自动建库修复", async (kind) => {
  const w = await world(); const a = await w.host(); await a.call("init");
  await a.shutdown(); a.client.close();
  // 模拟旧版本已有索引但尚无独立管理登记，确保索引损坏检查本身仍被覆盖。
  const legacy = new DatabaseSync(repositoryDatabase(w.dataRoot, w.repoId));
  try { legacy.prepare("DELETE FROM records WHERE namespace = ?").run(PROJECT_INDEX_MANAGEMENT_NAMESPACE); }
  finally { legacy.close(); }
  const path = join(w.dataRoot, "repos", w.repoId, "index.db");
  if (kind === "corrupt") await writeFile(path, "not a SQLite database");
  else if (kind === "permissions") await chmod(path, 0o644);
  else {
    const db = new DatabaseSync(path);
    try {
      if (kind === "schema") db.exec("DELETE FROM index_schema_metadata");
      else if (kind === "workspace") db.exec("DELETE FROM records WHERE namespace = 'workspaces'");
      else if (kind === "registration") db.exec("DELETE FROM records WHERE namespace IN ('workspaces', 'index_generations')");
      else if (kind === "empty") db.exec("DELETE FROM records");
      else if (kind === "identity") db.exec("UPDATE records SET data = json_set(data, '$.root', '/wrong-root') WHERE namespace = 'workspaces'");
      else db.exec("PRAGMA application_id = 42");
    } finally { db.close(); }
  }
  const before = await fs.readFile(path);
  const b = await w.host("b", "b");
  const callsBefore = w.calls.length;
  await expect(captureProjectFreshBaseline(b.binding)).rejects.toThrow();
  expect(await fs.readFile(path)).toEqual(before);
  expect(w.calls.length).toBe(callsBefore);
  expect(b.confirmations()).toBe(0);
  expect(w.activeWatchers()).toBe(0);
});

test("data.db管理登记跨index全部删除和全新窗口持久保留，只在新窗口获权后重建", async () => {
  const w = await world(); const a = await w.host(); await a.call("init");
  const scope = a.controller()!.workspace;
  const before = w.management();
  expect(before).toHaveLength(1);
  expect(before[0]!.key).toBe(scope.workspaceId);
  expect(before[0]!.data).toEqual({ format: "project-index-management/v1", ...scope });
  await a.shutdown(); a.client.close();
  const path = join(w.dataRoot, "repos", w.repoId, "index.db");
  for (const suffix of ["", "-wal", "-shm"]) await rm(path + suffix, { force: true });
  const b = await w.host("fresh-session", "fresh-window");
  const provider = createHostProjectBaselineProvider({ binding: b.binding, dataRoot: w.dataRoot });
  const baseline = new RequestBaselineGate(provider);
  cleanup.push(async () => { baseline.dispose(); provider.dispose(); });
  const callsBefore = w.calls.length;
  await expect(baseline.beginRequest()).rejects.toMatchObject({ code: "unavailable" });
  expect(existsSync(path)).toBe(false);
  expect(w.management()).toEqual(before);
  expect(w.calls.length).toBe(callsBefore);
  expect(b.confirmations()).toBe(0);
  expect(w.activeWatchers()).toBe(0);
  await b.call("init");
  expect((await provider.captureFresh()).kind).toBe("fresh");
  expect(existsSync(path)).toBe(true);
  expect(w.management()).toEqual(before);
  expect(b.confirmations()).toBe(1);
});

test("preview不创建管理登记，也不能覆盖或删除已登记但缺index的scope", async () => {
  const w = await world(); const a = await w.host();
  await a.call("init", true);
  expect(w.management()).toEqual([]);
  expect((await captureProjectFreshBaseline(a.binding)).kind).toBe("unmanaged");
  await a.call("init");
  const before = w.management();
  await a.shutdown(); a.client.close();
  const path = join(w.dataRoot, "repos", w.repoId, "index.db");
  for (const suffix of ["", "-wal", "-shm"]) await rm(path + suffix, { force: true });
  const b = await w.host("preview-session", "preview-window");
  await b.call("init", true);
  expect(b.controller()).toBeUndefined();
  expect(w.management()).toEqual(before);
  expect(existsSync(path)).toBe(false);
  await expect(captureProjectFreshBaseline(b.binding)).rejects.toThrow();
});

test("SQLite管理登记事务失败时不创建controller或调用daemon init，修复后显式重试幂等登记", async () => {
  const w = await world(); const a = await w.host();
  const path = repositoryDatabase(w.dataRoot, w.repoId);
  const db = new DatabaseSync(path);
  try { db.exec(`CREATE TRIGGER refuse_management BEFORE INSERT ON records
    WHEN new.namespace = '${PROJECT_INDEX_MANAGEMENT_NAMESPACE}' BEGIN SELECT RAISE(ABORT, 'controlled registration failure'); END`); }
  finally { db.close(); }
  await expect(a.call("init")).rejects.toMatchObject({ code: "operation_failed" });
  expect(a.controller()).toBeUndefined();
  expect(w.management()).toEqual([]);
  expect(w.grants()).toEqual([]);
  expect(w.calls.filter((call) => call.action === "init")).toEqual([]);
  expect(w.managerCount()).toBe(0);
  const retry = new DatabaseSync(path);
  try { retry.exec("DROP TRIGGER refuse_management"); } finally { retry.close(); }
  await a.call("init");
  const first = w.management(); expect(first).toHaveLength(1);
  await a.call("init");
  expect(w.management()).toEqual(first);
  expect(a.controller()!.isActive()).toBe(true);
});

test("A获权登记已提交但daemon init尚未执行时，B旧unmanaged请求不能写入", async () => {
  const w = await world(); const a = await w.host(); const b = await w.host("b", "b");
  const provider = createHostProjectBaselineProvider({ binding: b.binding, dataRoot: w.dataRoot });
  const baseline = new RequestBaselineGate(provider);
  cleanup.push(async () => { baseline.dispose(); provider.dispose(); });
  const request = await baseline.beginRequest(); baseline.bindCalls(["old-write"], request);
  const entered = gate(), release = gate();
  const original = vi.mocked(a.client.call).getMockImplementation()!;
  vi.spyOn(a.client, "call").mockImplementation(async (method, params) => {
    if (method === "index.sync" && params?.action === "init") { entered.release(); await release.promise; }
    return original(method, params);
  });
  const pending = a.call("init");
  const result = pending.then(() => "initialized", () => "failed");
  await entered.promise;
  try {
    expect(w.management()).toHaveLength(1);
    expect(w.managerCount()).toBe(0);
    expect(existsSync(join(w.dataRoot, "repos", w.repoId, "index.db"))).toBe(false);
    let ran = false;
    await expect(baseline.withMutation("old-write", { paths: ["source.ts"] }, async () => { ran = true; })).rejects.toMatchObject({ code: "stale" });
    expect(ran).toBe(false); expect(request.origin).toBeNull();
  } finally { release.release(); expect(await result).toBe("initialized"); }
});

test("管理登记提交后daemon init失败不删除事实，后续获权重试沿用原登记", async () => {
  const w = await world(); const a = await w.host();
  const original = vi.mocked(a.client.call).getMockImplementation()!;
  let rejectInit = true;
  vi.spyOn(a.client, "call").mockImplementation(async (method, params) => {
    if (rejectInit && method === "index.sync" && params?.action === "init") { rejectInit = false; throw new Error("controlled daemon init failure"); }
    return original(method, params);
  });
  await expect(a.call("init")).rejects.toMatchObject({ code: "operation_failed" });
  const registered = w.management(); expect(registered).toHaveLength(1);
  expect(existsSync(join(w.dataRoot, "repos", w.repoId, "index.db"))).toBe(false);
  const b = await w.host("b", "b");
  await expect(captureProjectFreshBaseline(b.binding)).rejects.toThrow();
  expect(w.management()).toEqual(registered);
  await a.call("init");
  expect(a.controller()!.isActive()).toBe(true);
  expect(w.management()).toEqual(registered);
});

test.each(["unknown-field", "identity"])("data.db管理登记%s损坏时只读和获批重试均拒绝，不覆盖登记", async (kind) => {
  const w = await world(); const a = await w.host(); await a.call("init");
  await a.shutdown(); a.client.close();
  const db = new DatabaseSync(repositoryDatabase(w.dataRoot, w.repoId));
  try {
    db.prepare("UPDATE records SET data = json_set(data, ?, ?) WHERE namespace = ?")
      .run(kind === "identity" ? "$.root" : "$.unknown", "invalid-metadata", PROJECT_INDEX_MANAGEMENT_NAMESPACE);
  } finally { db.close(); }
  const registered = w.management();
  const b = await w.host("b", "b");
  await expect(captureProjectFreshBaseline(b.binding)).rejects.toThrow();
  await expect(b.call("init")).rejects.toMatchObject({ code: "operation_failed" });
  expect(w.management()).toEqual(registered);
  expect(b.controller()).toBeUndefined();
});

test("旧版本索引只读核对不偷偷登记，正常获批接入才补齐data.db管理事实", async () => {
  const w = await world(); const a = await w.host(); await a.call("init");
  await a.shutdown(); a.client.close();
  const db = new DatabaseSync(repositoryDatabase(w.dataRoot, w.repoId));
  try { db.prepare("DELETE FROM records WHERE namespace = ?").run(PROJECT_INDEX_MANAGEMENT_NAMESPACE); } finally { db.close(); }
  const b = await w.host("b", "b");
  await expect(captureProjectFreshBaseline(b.binding)).rejects.toThrow();
  expect(w.management()).toEqual([]);
  await b.call("init");
  expect(w.management()).toHaveLength(1);
  expect(b.controller()!.isActive()).toBe(true);
});

test("B已发现持久管理后删除索引文件仍不能在原session降回legacy", async () => {
  const w = await world(); const a = await w.host(); await a.call("init");
  await a.shutdown(); a.client.close();
  const b = await w.host("b", "b");
  await expect(captureProjectFreshBaseline(b.binding)).rejects.toThrow();
  const path = join(w.dataRoot, "repos", w.repoId, "index.db");
  for (const suffix of ["", "-wal", "-shm"]) await rm(path + suffix, { force: true });
  await expect(captureProjectFreshBaseline(b.binding)).rejects.toThrow();
  expect(existsSync(path)).toBe(false);
  expect(b.confirmations()).toBe(0);
});

test("原unmanaged请求后切到另一未初始化分支也拒绝，不把新身份当旧请求的依据", async () => {
  const w = await world(); const b = await w.host();
  const provider = createHostProjectBaselineProvider({ binding: b.binding, dataRoot: w.dataRoot });
  const baseline = new RequestBaselineGate(provider);
  cleanup.push(async () => { baseline.dispose(); provider.dispose(); });
  const request = await baseline.beginRequest();
  baseline.bindCalls(["old-branch"], request);
  await exec("git", ["switch", "-c", "changed-identity"], { cwd: w.repositoryRoot, env: GIT_ENV });
  let ran = false;
  await expect(baseline.withMutation("old-branch", { paths: ["source.ts"] }, async () => { ran = true; })).rejects.toMatchObject({ code: "stale" });
  expect(ran).toBe(false);
  expect(w.managerCount()).toBe(0);
  expect(existsSync(join(w.dataRoot, "repos", w.repoId, "index.db"))).toBe(false);
});

test("缺少主库但遗留WAL不能被判为从未初始化；未知host绑定拒绝", async () => {
  const w = await world(); const b = await w.host();
  const path = join(w.dataRoot, "repos", w.repoId, "index.db");
  await writeFile(`${path}-wal`, "orphan metadata", { mode: 0o600 });
  await expect(captureProjectFreshBaseline(b.binding)).rejects.toThrow();
  await expect(captureProjectFreshBaseline({ ...b.binding, sessionId: "unknown" })).rejects.toThrow();
  expect(existsSync(path)).toBe(false);
  expect(w.managerCount()).toBe(0);
});

test.each(["worktree", "branch"])("其他%s有持久索引不串身份，当前精确未初始化现场仍可legacy且不扫描", async (kind) => {
  const w = await world(); const a = await w.host(); await a.call("init");
  await a.shutdown(); a.client.close();
  const root = kind === "worktree" ? join(w.root, "other") : w.repositoryRoot;
  await exec("git", kind === "worktree" ? ["worktree", "add", "-b", "other", root] : ["switch", "-c", "other"],
    { cwd: w.repositoryRoot, env: GIT_ENV });
  const b = await w.host("b", "b", root);
  const provider = createHostProjectBaselineProvider({ binding: b.binding, dataRoot: w.dataRoot });
  const baseline = new RequestBaselineGate(provider);
  cleanup.push(async () => { baseline.dispose(); provider.dispose(); });
  const reads = vi.spyOn(fs, "open"), enumerations = vi.spyOn(fs, "opendir");
  syncBuiltinESMExports();
  const callsBefore = w.calls.length, grantsBefore = w.grants().length;
  const request = await baseline.beginRequest();
  expect(request.kind).toBe("unmanaged");
  baseline.bindCalls(["own-write"], request);
  await expect(baseline.withMutation("own-write", { paths: ["source.ts"] }, async () => "legacy")).resolves.toBe("legacy");
  expect(reads.mock.calls.filter(([path]) => String(path).startsWith(root))).toEqual([]);
  expect(enumerations.mock.calls).toEqual([]);
  expect(b.confirmations()).toBe(0);
  expect(w.calls.length).toBe(callsBefore);
  expect(w.grants().length).toBe(grantsBefore);
  expect(w.activeWatchers()).toBe(0);
});

test("同一存活session断线先失效，再经新daemon/connection签新token，对账离线变化；换session重新确认", async () => {
  const w = await world(); const host = await w.host();
  await host.call("init");
  const controller = host.controller()!;
  const { snapshot: before } = await controller.captureFreshBaseline();
  const oldToken = w.calls.find((call) => call.action === "init")!.grantId;
  await w.first.server.close(); await w.first.coordinator.close();
  await waitFor(() => host.client.state().status !== "connected");
  expect(controller.isActive()).toBe(false);
  await expect(controller.captureFreshBaseline()).rejects.toThrow();
  await writeFile(join(w.repositoryRoot, "offline.ts"), "export const offline = true;\n");
  const replacement = await w.startServer();
  w.time.advance(1_000);
  await waitFor(() => controller.isActive());
  const { snapshot: after } = await controller.captureFreshBaseline();
  expect(after.baselineHash).not.toBe(before.baselineHash);
  expect(after.connectionSequence).toBeGreaterThan(before.connectionSequence);
  expect(after.files.some((file) => file.path === "offline.ts")).toBe(true);
  expect(host.confirmations()).toBe(1);
  const newToken = w.calls.filter((call) => call.action === "init").at(-1)!.grantId;
  expect(newToken).not.toBe(oldToken);
  expect(() => replacement.verifier.validateForClient(oldToken as string, replacement.server.clients()[0]!)).toThrow();
  await expect(controller.assertCurrent(before)).rejects.toThrow();
  await host.shutdown(); host.client.close();
  const next = await w.host("session-2", "window-2");
  next.approve(false);
  await expect(next.call("init")).rejects.toMatchObject({ code: "scan_declined" });
  expect(next.controller()).toBeUndefined();
  next.approve(true); await next.call("init"); expect(next.confirmations()).toBe(2);
});

test("两个宿主窗口共用daemon manager；退出一个不停止另一个，最终shutdown等待并释放自有资源", async () => {
  const w = await world(); const a = await w.host(); const b = await w.host("session-b", "window-b");
  await a.call("init"); await b.call("init");
  expect(w.managerCount()).toBe(1);
  await a.shutdown();
  expect(b.controller()!.isActive()).toBe(true);
  await b.controller()!.captureFreshBaseline();
  await b.shutdown();
  expect(w.grants().every((grant) => grant.status === "revoked")).toBe(true);
  await waitFor(() => w.activeWatchers() === 0);
  expect(w.activeWatchers()).toBe(0);
});

test("并发shutdown在慢init返回前先撤权且等待真实收尾，不让迟到结果重新接入", async () => {
  const holdInit = gate(); const initEntered = gate();
  const w = await world({ holdInit, initEntered }); const host = await w.host();
  const pending = host.call("init").then(() => "unexpected", () => "rejected");
  cleanup.push(() => pending);
  await initEntered.promise;
  let settled = false;
  const shutdown = host.shutdown().then(() => { settled = true; });
  cleanup.push(() => shutdown);
  try {
    expect(host.controller()).toBeUndefined();
    expect(w.grants().every((grant) => grant.status === "revoked")).toBe(true);
    expect(settled).toBe(false);
  } finally { holdInit.release(); }
  await shutdown; expect(await pending).toBe("rejected");
  expect(settled).toBe(true);
});

test("取消慢init撤销本次附件，等待RPC真实结束且不关闭仍有效的宿主client", async () => {
  const holdInit = gate(); const initEntered = gate();
  const w = await world({ holdInit, initEntered }); const host = await w.host();
  const abort = new AbortController();
  const pending = host.call("init", undefined, abort.signal).then(() => "unexpected", (error) => error.code);
  cleanup.push(() => pending);
  await initEntered.promise;
  const registered = w.management();
  try {
    expect(registered).toHaveLength(1);
    abort.abort();
    expect(w.management()).toEqual(registered);
    expect(host.controller()!.isActive()).toBe(false);
    expect(w.grants().every((grant) => grant.status === "revoked")).toBe(true);
  } finally { holdInit.release(); }
  expect(await pending).toBe("cancelled");
  expect(w.management()).toEqual(registered);
  expect(host.client.state().status).toBe("connected");
  await host.call("init");
  expect(host.controller()!.isActive()).toBe(true);
  expect(host.confirmations()).toBe(1);
});

test("同daemon重新连接也重签token；旧连接事件和未授权分支不能复用持续许可", async () => {
  const w = await world(); const host = await w.host();
  await host.call("init");
  const controller = host.controller()!;
  const oldIdentity = host.client.connectionIdentity!()!;
  const oldToken = w.calls.find((call) => call.action === "init")!.grantId;
  await w.first.server.close();
  await waitFor(() => host.client.state().status !== "connected");
  await w.first.server.listen(daemonSocketPath(w.dataRoot, w.repoId));
  w.time.advance(1_000);
  await waitFor(() => controller.isActive());
  const identity = host.client.connectionIdentity!()!;
  expect(identity.daemonInstanceId).toBe(oldIdentity.daemonInstanceId);
  expect(identity.connectionId).not.toBe(oldIdentity.connectionId);
  expect(w.calls.filter((call) => call.action === "init").at(-1)!.grantId).not.toBe(oldToken);
  expect(host.confirmations()).toBe(1);
  await exec("git", ["switch", "-c", "other"], { cwd: w.repositoryRoot, env: GIT_ENV });
  host.approve(false);
  await expect(host.call("init")).rejects.toMatchObject({ code: "scan_declined" });
  await expect(controller.captureFreshBaseline()).rejects.toThrow();
  host.approve(true);
  await host.call("init");
  expect(host.confirmations()).toBe(3);
  expect(host.controller()!.workspace.branch).toBe("refs/heads/other");
});

test("确认后adapter打开前切分支：原批准不能为新workspace签发或扫描", async () => {
  const w = await world(); const host = await w.host();
  const original = ProjectSyncClientSession.prototype.openService;
  const intercepted = vi.spyOn(ProjectSyncClientSession.prototype, "openService").mockImplementationOnce(async function(input) {
    await exec("git", ["switch", "-c", "approval-race"], { cwd: w.repositoryRoot, env: GIT_ENV });
    return original.call(this, input);
  });
  await expect(host.call("init")).rejects.toThrow();
  expect(w.grants()).toEqual([]);
  expect(w.managerCount()).toBe(0);
  expect(w.calls.filter((call) => call.action === "init")).toEqual([]);
  intercepted.mockRestore();
  await host.call("init");
  expect(host.confirmations()).toBe(2);
  expect(host.controller()!.workspace.branch).toBe("refs/heads/approval-race");
});

test("未送达watch的外部修改后status不把cached fresh当作本次文件核验", async () => {
  const w = await world({ suppressWatch: true }); const host = await w.host();
  await host.call("init");
  const controller = host.controller()!;
  const { snapshot: before } = await controller.captureFreshBaseline();
  await writeFile(join(w.repositoryRoot, "source.ts"), "export const changed = 2;\n");
  const rawStatusCall = w.calls.length;
  const result = await host.call("status");
  expect(w.calls.slice(rawStatusCall).map((call) => call.action)).toEqual(["status"]);
  expect(result.details).toMatchObject({ initialized: true, cacheVerified: false });
  const { snapshot: after } = await controller.captureFreshBaseline();
  expect(after.baselineHash).not.toBe(before.baselineHash);
});

test("宿主保留固定无正文事件字段供归因，非法事件只产生不可归因的失效", async () => {
  const w = await world(); const host = await w.host();
  await host.call("init");
  const controller = host.controller()!;
  const events: ProjectSyncClientChange[] = [];
  controller.subscribeInvalidation((event) => events.push(event));
  const raw = { repoId: w.repoId, workspaceId: controller.workspace.workspaceId, eventSequence: 71,
    reason: "watch", source: "watch", path: "source.ts", eventType: "change", archiveMetadataOnly: false,
    requiresFullReconcile: false, baselineHash: null, body: "EVENT_BODY_SENTINEL", grantId: "TOKEN_SENTINEL" };
  w.first.server.broadcast("project.index.changed", raw);
  await waitFor(() => events.length > 0);
  expect(events[0]).toMatchObject({ reason: "changed", sourceReason: "watch", source: "watch", path: "source.ts",
    eventType: "change", requiresFullReconcile: false, eventSequence: 71, observationSequence: expect.any(Number) });
  expect(Object.isFrozen(events[0])).toBe(true);
  expect(JSON.stringify(events)).not.toContain("SENTINEL");
  for (const patch of [{ path: "../escape" }, { source: "arbitrary" }, { eventSequence: -1 }, { requiresFullReconcile: "false" }]) {
    const count = events.length;
    w.first.server.broadcast("project.index.changed", { ...raw, ...patch });
    await waitFor(() => events.length > count);
    expect(events.at(-1)).toMatchObject({ reason: "unavailable", path: null, requiresFullReconcile: true });
  }
  const previous = events.at(-1) as unknown as { observationSequence: number };
  host.client.close();
  expect(events.at(-1)).toMatchObject({ reason: "disconnected", path: null, requiresFullReconcile: true });
  expect((events.at(-1) as unknown as { observationSequence: number }).observationSequence).toBeGreaterThan(previous.observationSequence);
});

test.each(["direct", "signal"] as const)("真实lifecycle关闭开始即撤权，Shell挂起期间保留原client停止通道（%s）", async (mode) => {
  const w = await world();
  const fake = createFakePi();
  const holdShell = gate();
  releaseGates.push(holdShell.release);
  const shellEntered = gate();
  const clock = createClock({ timeSource: createFakeTimeSource() });
  const sessionId = "real-lifecycle-session";
  let client!: DaemonClient;
  let closeCalls = 0;
  const fakeProcess = Object.assign(new EventEmitter(), { pid: process.pid });
  const ctx = { cwd: w.repositoryRoot, hasUI: true, mode: "rpc", shutdown() {},
    sessionManager: { getSessionId: () => sessionId }, ui: { confirm: async () => true, notify() {} } } as unknown as ExtensionContext;
  lifecycleExtension(fake.pi as unknown as ExtensionAPI, {
    process: fakeProcess as unknown as NodeJS.Process,
    createClock: () => clock,
    createShellRegistry: () => ({ stopHost: async () => { shellEntered.release(); await holdShell.promise; return []; } }) as unknown as ShellRegistry,
    createWindowRegistry: async () => new WindowRegistry({ repoDir: join(w.dataRoot, "repos", w.repoId), clock,
      bootId: async () => "host-test", processStartedAt: async () => "host-test" }),
    connectWorkspaceClients: async (input) => {
      client = await connectDaemon({ repoDir: w.repositoryRoot, dataRoot: w.dataRoot, sdkDir: "/not-spawned", clock,
        hello: { ...input, pid: process.pid, workspaceRoot: input.cwd } });
      const workspace = { repos: [{ repoId: w.repoId, commonDir: w.commonDir, path: w.repositoryRoot }], skipped: [] };
      return { forRepo: (id) => id === w.repoId ? client : undefined, all: () => [client], workspace: () => workspace,
        skipped: () => [], closeAll: () => { closeCalls++; client.close(); } };
    },
  });
  projectManageExtension(fake.pi as unknown as ExtensionAPI, { dataRoot: w.dataRoot });
  cleanup.push(async () => { clock.stopGapWatcher(); });
  cleanup.push(async () => { client?.close(); });
  cleanup.push(() => shutdownWindow());
  await fake.trigger("session_start", {}, ctx);
  const actualCall = client.call.bind(client);
  let attachedParams: Record<string, unknown> | undefined;
  vi.spyOn(client, "call").mockImplementation((method, params) => {
    if (method === "index.sync" && params?.action === "init") attachedParams = { ...params };
    return actualCall(method, params);
  });
  const tool = fake.registeredTools()[0] as ReturnType<typeof createProjectManageTool>["tool"];
  const call = () => tool.execute("real-lifecycle-init", { action: "init", repoId: w.repoId }, undefined, undefined, ctx);
  await call();
  const window = windowContext();
  const controller = activeProjectSyncController({ windowId: window.windowId, sessionId, repoId: w.repoId })!;
  if (mode === "signal") fakeProcess.emit("SIGTERM");
  const shutdown = shutdownWindow();
  let repeatedSettled = false;
  const repeated = shutdownWindow().then(() => { repeatedSettled = true; });
  try {
    await shellEntered.promise;
    expect(w.grants().every((grant) => grant.status === "revoked")).toBe(true);
    expect(controller.isActive()).toBe(false);
    expect(repeatedSettled).toBe(false);
    expect(closeCalls).toBe(0);
    expect(client.state().status).toBe("connected");
    const status = await client.call("index.sync", { action: "status", repoId: w.repoId,
      workspaceId: controller.workspace.workspaceId, repositoryRoot: w.repositoryRoot, branch: controller.workspace.branch });
    expect(status.attached).toBe(false);
    await expect(actualCall("index.sync", attachedParams!)).rejects.toThrow();
    await expect(call()).rejects.toThrow();
  } finally { holdShell.release(); await Promise.all([shutdown, repeated]); }
  expect(closeCalls).toBe(1);
  await waitFor(() => w.activeWatchers() === 0);
  expect(w.activeWatchers()).toBe(0);
});

test("lifecycle先关闭原client也可完整撤权，反复新session收尾后watcher归零", async () => {
  const w = await world();
  for (let round = 0; round < 3; round++) {
    const host = await w.host(`session-${round}`, `window-${round}`);
    await host.call("init");
    const controller = host.controller()!;
    expect(w.activeWatchers()).toBeGreaterThan(0);
    host.client.close();
    expect(controller.isActive()).toBe(false);
    await expect(controller.captureFreshBaseline()).rejects.toThrow();
    await host.shutdown();
    await waitFor(() => w.activeWatchers() === 0);
    expect(w.grants().every((grant) => grant.status === "revoked")).toBe(true);
  }
});
