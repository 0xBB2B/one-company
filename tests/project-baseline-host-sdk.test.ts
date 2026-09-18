import { afterEach, expect, test, vi } from "vitest";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { watch } from "node:fs";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { AssistantMessage, ToolCall } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DaemonServer } from "../daemon/server.ts";
import { ProjectIndexCoordinator } from "../daemon/project-index-coordinator.ts";
import { ProjectIndexSyncManager } from "../runtime/project-index-sync.ts";
import { ProjectSyncGrantVerifier, PROJECT_INDEX_GRANT_NAMESPACE } from "../runtime/project-sync-grants.ts";
import { LocalDatabase, indexDatabase, repositoryDatabase } from "../runtime/database.ts";
import { connectDaemon } from "../runtime/daemon-client.ts";
import { controlToken } from "../runtime/daemon-auth.ts";
import { daemonSocketPath, repositoryIdentity, repoDataDir } from "../runtime/identity.ts";
import { createClock } from "../runtime/clock.ts";
import { ShellRegistry } from "../runtime/shell-registry.ts";
import { createRangeProtection } from "../runtime/range-protection.ts";
import { createGitCommitTool } from "../runtime/git-commit-tool.ts";
import { createProtectedFileTools } from "../extensions/write-protection.ts";
import projectManageExtension, { activeProjectSyncController } from "../extensions/project-manage.ts";
import { createHostProjectBaselineProvider } from "../extensions/project-baseline.ts";
import type { ProjectBaselineInvalidation } from "../runtime/project-baseline.ts";
import { installProjectBaselineHooks, OLD_PROJECT_SNAPSHOT } from "../runtime/project-baseline-hooks.ts";
import type { ProjectBaselineHooks } from "../runtime/project-baseline-hooks.ts";
import type { WindowContextValue } from "../extensions/lifecycle.ts";
import { createFakePi } from "./helpers/fake-pi.ts";
import { GIT_ENV } from "./helpers/repo-fixture.ts";
import { deferred } from "./helpers/project-baseline-fixture.ts";


const exec = promisify(execFile);
const cleanup: Array<() => unknown | Promise<unknown>> = [];
const fixtureRoots: string[] = [];
afterEach(async (context) => {
  const failures: unknown[] = [];
  for (const close of cleanup.splice(0).reverse()) { try { await close(); } catch (error) { failures.push(error); } }
  const roots = fixtureRoots.splice(0);
  if (failures.length || context.task.result?.state === "fail") console.error("SDK宿主夹具失败，保留现场：", roots);
  else for (const root of roots) await rm(root, { recursive: true, force: true });
  if (failures.length) throw new AggregateError(failures, "SDK宿主夹具收尾失败");
});

async function world() {
  const root = await realpath(await mkdtemp("/tmp/m3-sdk-gate-host-")); await chmod(root, 0o700);
  fixtureRoots.push(root);
  const repo = join(root, "repo"), dataRoot = join(root, "data"), home = join(root, "agent");
  await mkdir(repo); await mkdir(dataRoot, { mode: 0o700 }); await mkdir(home, { mode: 0o700 });
  await exec("git", ["init", "-b", "main"], { cwd: repo, env: GIT_ENV });
  await writeFile(join(repo, "source.ts"), "export const initial = 1;\n");
  await exec("git", ["add", "source.ts"], { cwd: repo, env: GIT_ENV });
  await exec("git", ["commit", "-m", "fixture"], { cwd: repo, env: GIT_ENV });
  const { repoId, commonDir } = await repositoryIdentity(repo); await repoDataDir(dataRoot, repoId, commonDir);
  await mkdir(join(dataRoot, "sock"), { mode: 0o700 });
  const clock = createClock(); cleanup.push(() => clock.stopGapWatcher());
  const registry = new ShellRegistry({ clock });
  let scans = 0, watchers = 0;
  const startServer = async (initGate?: { entered: ReturnType<typeof deferred<void>>; release: ReturnType<typeof deferred<void>> }) => {
    const server = new DaemonServer({ authToken: controlToken(dataRoot), repoId, startedAt: "sdk-fixture" });
    const verifier = new ProjectSyncGrantVerifier({ dataRoot, repoId, commonDir, daemonInstanceId: server.daemonInstanceId });
    const coordinator = new ProjectIndexCoordinator({ repoId, commonDir, dataRoot, server, grants: verifier, beforeArchiveRisk: () => {},
      createManager(input) {
        scans++;
        const manager = new ProjectIndexSyncManager({ ...input, debounceMs: 20, lowFrequencyMs: 60000,
          watchFactory(path, listener) { watchers++; return watch(path, listener); } });
        if (initGate) {
          const start = manager.start.bind(manager);
          manager.start = async () => { initGate.entered.resolve(); await initGate.release.promise; return start(); };
        }
        return manager;
      } });
    cleanup.push(() => server.close()); cleanup.push(() => coordinator.close());
    await server.listen(daemonSocketPath(dataRoot, repoId)); server.markHandlersReady();
    return { server, coordinator };
  };
  const first = await startServer();
  const sessionManager = SessionManager.inMemory(repo);
  const sessionId = sessionManager.getSessionId(), windowId = "sdk-host";
  const client = await connectDaemon({ repoDir: repo, dataRoot, sdkDir: "/not-spawned", clock,
    hello: { sessionId, windowId, pid: process.pid, cwd: repo, workspaceRoot: repo } });
  cleanup.push(() => client.close());
  const workspace = { repos: [{ path: repo, repoId, commonDir }], skipped: [] };
  const window: WindowContextValue = { windowId, sessionId, workspace, shellRegistry: registry, clients: {
    forRepo: (id) => id === repoId ? client : undefined, all: () => [client], skipped: () => [], workspace: () => workspace, closeAll: () => client.close(),
  } };
  const hostCtx = { cwd: repo, sessionManager, hasUI: true, mode: "rpc", ui: { confirm: async () => true } } as unknown as ExtensionContext;
  const hostPi = createFakePi();
  projectManageExtension(hostPi.pi as unknown as ExtensionAPI, { dataRoot, windowReady: async () => window, windowContext: () => window });
  await hostPi.trigger("session_start", {}, hostCtx);
  cleanup.push(() => hostPi.trigger("session_shutdown", {}, hostCtx));
  const project = hostPi.registeredTools()[0]!;
  const provider = createHostProjectBaselineProvider({ binding: { repoId, windowId, sessionId }, dataRoot }); cleanup.push(() => provider.dispose());
  const events: ProjectBaselineInvalidation[] = [];
  const trace: unknown[] = [];
  const capture = provider.captureFresh.bind(provider), assert = provider.assertCurrent.bind(provider);
  const assertUnmanaged = provider.assertUnmanaged.bind(provider);
  provider.assertUnmanaged = async (signal) => {
    trace.push({ action: "assert_unmanaged" });
    const before = trace.filter((event) => (event as { action: string }).action === "capture_start").length;
    try { await assertUnmanaged(signal); }
    finally { trace.push({ action: "assert_unmanaged_end", capturesDuringCheck:
      trace.filter((event) => (event as { action: string }).action === "capture_start").length - before }); }
  };
  provider.captureFresh = async (signal) => {
    trace.push({ action: "capture_start", aborted: signal?.aborted });
    try { const result = await capture(signal); trace.push({ action: "capture_end", result }); return result; }
    catch (error) { trace.push({ action: "capture_failed", error: error instanceof Error ? error.stack : String(error), aborted: signal?.aborted }); throw error; }
  };
  provider.assertCurrent = async (snapshot, signal) => {
    try { await assert(snapshot, signal); }
    catch (error) { trace.push({ action: "assert_failed", snapshot, error: String(error), aborted: signal?.aborted }); throw error; }
  };
  cleanup.push(provider.subscribeInvalidation((event) => { events.push(event); trace.push({ action: "event", event }); }));
  const protection = await createRangeProtection({ cwd: repo, dataRoot, holder: { kind: "main", windowId }, writePaths: [repo], clock, shells: registry });
  cleanup.push(() => protection.release());
  const runtime = await ModelRuntime.create({ authPath: join(home, "auth.json"), modelsPath: null, modelsStorePath: join(home, "models-store.json"), refreshOnCreate: false });
  let counter = 0;
  let requested: ToolCall[] = [];
  let slow: (() => Promise<void>) | undefined;
  let afterRead: (() => Promise<void>) | undefined;
  const modelInputs: string[] = [];
  runtime.registerProvider("sdk-host", { apiKey: "fixture", baseUrl: "http://127.0.0.1:1", api: "anthropic-messages",
    models: [{ id: "slow", name: "slow", reasoning: false, input: ["text"], contextWindow: 100000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple(model, context, options) {
      modelInputs.push(JSON.stringify(context.messages));
      const stream = createAssistantMessageEventStream(); const calls = requested; requested = [];
      const message: AssistantMessage = { role: "assistant", provider: model.provider, api: model.api, model: model.id, timestamp: ++counter,
        content: calls.length ? calls : [{ type: "text", text: "fixture answer" }], stopReason: calls.length ? "toolUse" : "stop",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      const wait = slow; slow = undefined;
      void (async () => { await options?.onPayload?.({ fixture: true }, model);
        stream.push({ type: "start", partial: { ...message, content: [], stopReason: "pending" } }); await wait?.();
        stream.push({ type: "done", reason: calls.length ? "toolUse" : "stop", message });
      })().catch((error) => stream.push({ type: "error", reason: "error", error: { ...message, stopReason: "error", errorMessage: String(error) } }));
      return stream;
    } });
  let hooks!: ProjectBaselineHooks;
  let beforeTool: (() => Promise<void>) | undefined;
  const loader = new DefaultResourceLoader({ cwd: repo, agentDir: home, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
    agentsFilesOverride: () => ({ agentsFiles: [] }), extensionFactories: [(pi) => {
      hooks = installProjectBaselineHooks(pi, { provider, checkPath: (path) => provider.checkPath(path) });
      const [write, edit] = createProtectedFileTools(async () => protection); pi.registerTool(write); pi.registerTool(edit);
      pi.registerTool(createGitCommitTool(async () => protection.commit));
      pi.on("tool_call", async () => { const once = beforeTool; beforeTool = undefined; await once?.(); });
      pi.on("turn_end", async (event) => { if (event.toolResults.some((result) => result.toolName === "read")) { const once = afterRead; afterRead = undefined; await once?.(); } });
    }] });
  await loader.reload();
  const { session } = await createAgentSession({ cwd: repo, agentDir: home, modelRuntime: runtime, model: runtime.getModels("sdk-host")[0], resourceLoader: loader,
    sessionManager, settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }), tools: ["read", "write", "edit", "pi_company_git_commit"] });
  cleanup.push(() => { hooks.dispose(); session.dispose(); });
  const initializeOtherWindow = async () => {
    const otherSession = SessionManager.inMemory(repo), otherWindowId = "sdk-other-window";
    const otherClient = await connectDaemon({ repoDir: repo, dataRoot, sdkDir: "/not-spawned", clock,
      hello: { sessionId: otherSession.getSessionId(), windowId: otherWindowId, pid: process.pid, cwd: repo, workspaceRoot: repo } });
    cleanup.push(() => otherClient.close());
    const otherWindow: WindowContextValue = { windowId: otherWindowId, sessionId: otherSession.getSessionId(), workspace, clients: {
      forRepo: (id) => id === repoId ? otherClient : undefined, all: () => [otherClient], skipped: () => [], workspace: () => workspace,
      closeAll: () => otherClient.close(),
    } };
    const otherCtx = { ...hostCtx, sessionManager: otherSession } as ExtensionContext;
    const otherPi = createFakePi();
    projectManageExtension(otherPi.pi as unknown as ExtensionAPI, { dataRoot, windowReady: async () => otherWindow, windowContext: () => otherWindow });
    await otherPi.trigger("session_start", {}, otherCtx);
    cleanup.push(() => otherPi.trigger("session_shutdown", {}, otherCtx));
    await otherPi.registeredTools()[0]!.execute("other-init", { action: "init", repoId }, undefined, undefined, otherCtx);
  };
  const metadata = () => {
    const db = new LocalDatabase(repositoryDatabase(dataRoot, repoId));
    try { return db.list<Record<string, unknown>>(PROJECT_INDEX_GRANT_NAMESPACE).map(({ data }) => ({
      status: data.status, daemonInstanceId: data.daemonInstanceId, connectionId: data.connectionId, windowId: data.windowId, sessionId: data.sessionId,
    })); } finally { db.close(); }
  };
  const indexedHash = () => {
    const db = new LocalDatabase(indexDatabase(dataRoot, repoId));
    try { return db.list<{ path: string; hash: string }>("files").find(({ data }) => data.path === "source.ts")?.data.hash; }
    finally { db.close(); }
  };
  return { repo, provider, session, client, hooks, events, trace, modelInputs, initializeOtherWindow, scans: () => scans,
    first, startServer, metadata, indexedHash, watchers: () => watchers,
    controller: () => activeProjectSyncController({ repoId, windowId, sessionId }),
    afterRead: (operation: () => Promise<void>) => { afterRead = operation; },
    initialize: () => project.execute("init", { action: "init", repoId }, undefined, undefined, hostCtx),
    run: async (calls: ToolCall[], pause?: () => Promise<void>, preflight?: () => Promise<void>) => { requested = calls; slow = pause; beforeTool = preflight; await session.prompt("fixture"); } };
}
const writeCall = (id: string, path: string, content: string): ToolCall => ({ type: "toolCall", id, name: "write", arguments: { path, content } });

async function heldReconnect(w: Awaited<ReturnType<typeof world>>) {
  const gate = { entered: deferred<void>(), release: deferred<void>() };
  // 清理必须先释放真实init，才能等待HOST/daemon串行队列结束。
  cleanup.push(() => gate.release.resolve());
  await w.first.coordinator.close(); await w.first.server.close();
  await vi.waitFor(() => expect(w.controller()?.isActive()).toBe(false));
  const offline = "export const offline = 2;\n";
  await writeFile(join(w.repo, "source.ts"), offline);
  const watchersBefore = w.watchers();
  const next = await w.startServer(gate);
  // 新server的清理项之后再登记释放，确保失败路径也不会卡住init。
  cleanup.push(() => gate.release.resolve());
  await gate.entered.promise;
  expect(w.controller()?.isActive()).toBe(false);
  expect(w.watchers()).toBe(watchersBefore);
  expect(w.indexedHash()).not.toBe(createHash("sha256").update(offline).digest("hex"));
  expect(w.metadata()).toContainEqual(expect.objectContaining({ status: "active", daemonInstanceId: next.server.daemonInstanceId }));
  return { gate, offline, watchersBefore, next };
}

test("重连读取屏障：新grant已签发但真实init未结束，首次SDK read等待索引补齐", async () => {
  const w = await world(); await w.initialize();
  const previous = await w.provider.captureFresh(); expect(previous.kind).toBe("fresh");
  const controller = w.controller();
  const { gate, offline, watchersBefore, next } = await heldReconnect(w);
  const hash = createHash("sha256").update(offline).digest("hex");
  const capturesBefore = w.trace.filter((event) => (event as { action: string }).action === "capture_start").length;
  let completed = false;
  let firstReadHash: string | undefined;
  // turn_end紧接read结果，先记录索引，再让SDK开始下一次模型捕获。
  w.afterRead(async () => { firstReadHash = w.indexedHash(); });
  const pending = w.run([{ type: "toolCall", id: "first-reconnected-read", name: "read", arguments: { path: "source.ts" } }])
    .finally(() => { completed = true; });
  try {
    await vi.waitFor(() => expect(w.trace.filter((event) => (event as { action: string }).action === "capture_start").length).toBeGreaterThan(capturesBefore));
    // 给已进入捕获的Promise完成当前事件循环；真实init仍由独立闸门阻塞。
    await new Promise<void>((resolve) => setImmediate(resolve));
    console.info("reconnect read held", { daemonInstanceId: next.server.daemonInstanceId, grants: w.metadata(),
      sameController: controller === w.controller(), active: w.controller()?.isActive(), newWatchers: w.watchers() - watchersBefore,
      indexedHash: w.indexedHash(), expectedHash: hash, completed, trace: w.trace.slice(-3) });
    expect(w.trace.slice().reverse().find((event) => ["capture_start", "capture_end", "capture_failed"].includes((event as { action: string }).action)))
      .toMatchObject({ action: "capture_start" });
    expect(completed).toBe(false);
    expect(w.session.messages.some((message) => message.role === "toolResult")).toBe(false);
    expect(w.controller()).toBe(controller);
  } finally { gate.release.resolve(); await pending; }
  const read = w.session.messages.find((message) => message.role === "toolResult");
  expect(read).toMatchObject({ toolName: "read", isError: false });
  expect(JSON.stringify(read)).toContain("offline");
  // 采用首次read的即时观测，不让后续模型回合的capture替它补齐。
  expect(firstReadHash).toBe(hash);
  expect(w.indexedHash()).toBe(hash);
  expect(w.controller()?.isActive()).toBe(true);
  const fresh = await w.provider.captureFresh(); expect(fresh.kind).toBe("fresh");
  if (previous.kind !== "fresh" || fresh.kind !== "fresh") throw new Error("fresh required");
  expect(fresh.snapshot.authorityEpoch).not.toBe(previous.snapshot.authorityEpoch);
  await expect(w.provider.assertCurrent(previous.snapshot)).rejects.toThrow();
  console.info("reconnect read delivered", { active: w.controller()?.isActive(), firstReadHash, indexedHash: w.indexedHash(),
    expectedHash: hash, newWatchers: w.watchers() - watchersBefore, previousEpoch: previous.snapshot.authorityEpoch, currentEpoch: fresh.snapshot.authorityEpoch });
}, 30000);

test("重连读取屏障：旧请求写入与旧snapshot即时拒绝，取消的新捕获不能获得新epoch", async () => {
  const w = await world(); await w.initialize();
  const old = await w.provider.captureFresh(); if (old.kind !== "fresh") throw new Error("fresh required");
  const modelEntered = deferred<void>(), modelRelease = deferred<void>();
  cleanup.push(() => modelRelease.resolve());
  const oldRun = w.run([writeCall("old-epoch", "source.ts", "MUST_NOT_WRITE")], async () => { modelEntered.resolve(); await modelRelease.promise; });
  await modelEntered.promise;
  const { gate, offline } = await heldReconnect(w);
  const cancel = new AbortController();
  const cancelled = w.provider.captureFresh(cancel.signal).then(() => "fresh", () => "rejected");
  try {
    await expect(w.provider.assertCurrent(old.snapshot)).rejects.toThrow();
    cancel.abort(); modelRelease.resolve();
    // 旧工具必须在init闸门释放前拒绝；SDK后续模型回合属于新捕获，可以等待重连。
    await vi.waitFor(() => expect(w.session.messages.filter((message) => message.role === "toolResult").at(-1)).toMatchObject({ isError: true }));
    expect(await readFile(join(w.repo, "source.ts"), "utf8")).toBe(offline);
    expect(w.controller()?.isActive()).toBe(false);
  } finally { modelRelease.resolve(); gate.release.resolve(); await oldRun; }
  expect(await cancelled).toBe("rejected");
  await expect(w.provider.assertCurrent(old.snapshot)).rejects.toThrow();
  expect(await readFile(join(w.repo, "source.ts"), "utf8")).toBe(offline);
}, 30000);

test("重连读取屏障：新window无批准不借用其他controller，失联捕获不自动init", async () => {
  const w = await world(); await w.initializeOtherWindow();
  const before = w.metadata();
  expect(w.controller()).toBeUndefined();
  await expect(w.provider.captureFresh()).rejects.toThrow();
  await expect(w.provider.assertUnmanaged()).rejects.toThrow();
  expect(w.metadata()).toEqual(before);
  await w.initialize();
  w.client.close();
  const scans = w.scans();
  await expect(w.provider.captureFresh()).rejects.toThrow();
  await expect(w.provider.assertUnmanaged()).rejects.toThrow();
  expect(w.scans()).toBe(scans);
}, 30000);

test("真实SQLite/socket/watch HOST+SDK：新目录及文件在同一精确自写窗口，同批继续", async () => {
  const w = await world(); await w.initialize();
  await w.run([writeCall("dir1", "new/nested/source.ts", "export const newFile = 1;\n"), writeCall("dir2", "next.ts", "export const next = 2;\n")]);
  if (w.session.messages.filter((m) => m.role === "toolResult").some((m) => m.isError)) console.error("新目录真实事件", JSON.stringify(w.trace));
  expect(await readFile(join(w.repo, "new/nested/source.ts"), "utf8")).toBe("export const newFile = 1;\n");
  expect(await readFile(join(w.repo, "next.ts"), "utf8")).toBe("export const next = 2;\n");
  expect(w.session.messages.filter((m) => m.role === "toolResult").every((m) => !m.isError)).toBe(true);
}, 30000);

test("真实HOST+SDK read返回后watch变化，下一模型请求提醒旧资料且给当前hash", async () => {
  const w = await world(); await w.initialize();
  w.afterRead(async () => {
    const observed = deferred<void>();
    const stop = w.provider.subscribeInvalidation(() => observed.resolve());
    try { await writeFile(join(w.repo, "source.ts"), "export const externalSecret = 99;\n"); await observed.promise; }
    finally { stop(); }
  });
  await w.run([{ type: "toolCall", id: "host-read-gap", name: "read", arguments: { path: "source.ts" } }]);
  const captured = await w.provider.captureFresh(); expect(captured.kind).toBe("fresh");
  expect(w.modelInputs).toHaveLength(2);
  expect(w.modelInputs[1]).toContain("旧快照");
  expect(w.modelInputs[1]).toContain("external_or_unknown");
  expect(w.modelInputs[1]).toContain(captured.kind === "fresh" ? captured.snapshot.baselineHash : "missing-fresh");
  expect(w.modelInputs[1]).not.toContain("externalSecret");
}, 30000);

test("真实HOST+SDK commit预检后外改，在实际提交前拒绝且HEAD/index不变", async () => {
  const w = await world(); await w.initialize();
  const before = (await exec("git", ["rev-parse", "HEAD"], { cwd: w.repo, env: GIT_ENV })).stdout;
  await w.run([{ type: "toolCall", id: "stale-commit", name: "pi_company_git_commit", arguments: { paths: ["source.ts"], message: "must not commit" } }], undefined,
    async () => { await writeFile(join(w.repo, "source.ts"), "export const external = 8;\n"); });
  expect((await exec("git", ["rev-parse", "HEAD"], { cwd: w.repo, env: GIT_ENV })).stdout).toBe(before);
  expect((await exec("git", ["diff", "--cached", "--name-only"], { cwd: w.repo, env: GIT_ENV })).stdout).toBe("");
  expect(w.session.messages.find((m) => m.role === "toolResult")).toMatchObject({ isError: true });
}, 30000);

test("真实SQLite/socket HOST+SDK：未初始化不额外扫描，初始化后拒绝策略排除路径", async () => {
  const w = await world();
  await w.run([]); expect(w.scans()).toBe(0);
  await w.initialize(); expect(w.scans()).toBe(1);
  await w.run([writeCall("secret", ".env", "SECRET")]);
  expect(w.session.messages.filter((m) => m.role === "toolResult").at(-1)).toMatchObject({ isError: true });
  await expect(readFile(join(w.repo, ".env"))).rejects.toMatchObject({ code: "ENOENT" });
}, 30000);

test("真实SQLite/socket HOST+SDK：旧unmanaged消息在另一窗口初始化后拒绝写入，逐层转发元数据核对", async () => {
  const w = await world(); const entered = deferred<void>(), release = deferred<void>();
  const pending = w.run([writeCall("legacy-before-registration", "source.ts", "MUST_NOT_WRITE")], async () => { entered.resolve(); await release.promise; });
  await entered.promise;
  const checksBefore = w.trace.filter((event) => (event as { action: string }).action === "assert_unmanaged").length;
  try {
    expect(checksBefore).toBeGreaterThan(0);
    await w.initializeOtherWindow();
    expect(w.scans()).toBe(1);
  } finally { release.resolve(); await pending; }
  expect(await readFile(join(w.repo, "source.ts"), "utf8")).toBe("export const initial = 1;\n");
  expect(w.session.messages.filter((m) => m.role === "toolResult").at(-1)).toMatchObject({ isError: true });
  expect(JSON.stringify(w.session.messages)).toContain(OLD_PROJECT_SNAPSHOT);
  expect(w.trace.filter((event) => (event as { action: string }).action === "assert_unmanaged").length).toBeGreaterThan(checksBefore);
  // 元数据入口真实执行；失败时没有调用 captureFresh 给旧请求补鲜度。
  const checks = w.trace.filter((event) => (event as { action: string }).action === "assert_unmanaged_end");
  expect(checks.length).toBeGreaterThan(0);
  expect(checks.every((event) => (event as { capturesDuringCheck: number }).capturesDuringCheck === 0)).toBe(true);
}, 30000);

test("真实SQLite/socket HOST+慢SDK：回答中外改与断线拒绝旧基础写入", async () => {
  const w = await world(); await w.initialize(); const entered = deferred<void>(); const release = deferred<void>();
  const run = w.run([writeCall("stale", "source.ts", "BAD")], async () => { entered.resolve(); await release.promise; });
  await entered.promise; await writeFile(join(w.repo, "source.ts"), "export const external = 2;\n"); w.client.close(); release.resolve(); await run;
  expect(await readFile(join(w.repo, "source.ts"), "utf8")).toBe("export const external = 2;\n");
  expect(w.session.messages.filter((m) => m.role === "toolResult").at(-1)).toMatchObject({ isError: true });
  expect(JSON.stringify(w.session.messages)).toContain(OLD_PROJECT_SNAPSHOT);
}, 30000);

test("真实SQLite/socket HOST+SDK：预检后外改在实际文件入口拒绝", async () => {
  const w = await world(); await w.initialize();
  await w.run([writeCall("preflight", "source.ts", "BAD")], undefined, async () => { await writeFile(join(w.repo, "source.ts"), "export const external = 3;\n"); });
  expect(await readFile(join(w.repo, "source.ts"), "utf8")).toBe("export const external = 3;\n");
  expect(w.session.messages.filter((m) => m.role === "toolResult").at(-1)).toMatchObject({ isError: true });
}, 30000);

test("真实SQLite/socket/watch HOST+SDK：精确自写同批后续动作", async () => {
  const w = await world(); await w.initialize();
  await w.run([writeCall("own1", "source.ts", "export const own = 1;\n"), writeCall("own2", "next.ts", "export const own = 2;\n")]);
  expect(await readFile(join(w.repo, "source.ts"), "utf8")).toBe("export const own = 1;\n");
  if (w.session.messages.filter((m) => m.role === "toolResult").some((m) => m.isError)) {
    console.error("自写续接失败的真实元数据事件", JSON.stringify(w.trace));
  }
  expect(await readFile(join(w.repo, "next.ts"), "utf8")).toBe("export const own = 2;\n");
  expect(w.session.messages.filter((m) => m.role === "toolResult").every((m) => !m.isError)).toBe(true);
}, 90000);
