import { afterEach, expect, test, vi } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { uuidv7 } from "../runtime/database.ts";
import { ProjectSyncClientSession, PROJECT_INDEX_MANAGEMENT_NAMESPACE } from "../runtime/project-sync-client.ts";
import { DatabaseSync } from "node:sqlite";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import fsp from "node:fs/promises";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { createAssistantMessageEventStream, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import type { AssistantMessage, ToolCall } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAgentTool } from "../daemon/requirement-agent.ts";
import { WORK_SCHEMA } from "../runtime/result.ts";
import { DaemonServer } from "../daemon/server.ts";
import { ProjectIndexCoordinator } from "../daemon/project-index-coordinator.ts";
import { createDaemonProjectBaselineProvider } from "../daemon/project-baseline-provider.ts";
import { createRoleSession } from "../daemon/role-session.ts";
import { ProjectSyncGrantIssuer, ProjectSyncGrantVerifier } from "../runtime/project-sync-grants.ts";
import { connectDaemon } from "../runtime/daemon-client.ts";
import { controlToken } from "../runtime/daemon-auth.ts";
import { daemonSocketPath, repositoryIdentity, repoDataDir } from "../runtime/identity.ts";
import { createClock } from "../runtime/clock.ts";
import { NetworkPauseGate } from "../runtime/network-pause.ts";
import { ShellRegistry } from "../runtime/shell-registry.ts";
import { createRangeProtection } from "../runtime/range-protection.ts";
import { RequestBaselineGate } from "../runtime/project-baseline.ts";
import { projectBaselineForContext } from "../runtime/project-baseline-hooks.ts";
import { bindRunResult, verifyTaskDelivery } from "../runtime/delivery.ts";
import { RunStore } from "../runtime/run-store.ts";
import type { RunRecord } from "../runtime/run-store.ts";
import { GIT_ENV } from "./helpers/repo-fixture.ts";
import { deferred } from "./helpers/project-baseline-fixture.ts";

const exec = promisify(execFile);
const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); syncBuiltinESMExports(); });
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const workResult = () => ({ phase: "work", verdict: "PASS", summary: "fixture", issues: [], evidence: ["fixture"],
  changeKind: "refactor", workState: "green-baseline-no-change", coverage: [{ ref: "r1", test: "source.ts:1" }], redCommands: [],
  greenCommands: [{ command: "true", status: "passed", details: "fixture" }], changedFiles: [], productionPath: [], preexistingEvidence: ["fixture"], fakeRed: false });

async function world() {
  const root = await realpath(await mkdtemp("/tmp/m3-role-gate-fixture-")); await chmod(root, 0o700);
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, "repo"), dataRoot = join(root, "agent/data");
  await mkdir(repo); await mkdir(dataRoot, { recursive: true, mode: 0o700 });
  await exec("/usr/bin/git", ["init", "-b", "main"], { cwd: repo, env: GIT_ENV });
  await writeFile(join(repo, "source.ts"), "export const value = 1;\n");
  await exec("/usr/bin/git", ["add", "."], { cwd: repo, env: GIT_ENV });
  await exec("/usr/bin/git", ["commit", "-m", "fixture"], { cwd: repo, env: GIT_ENV });
  const identity = await repositoryIdentity(repo); await repoDataDir(dataRoot, identity.repoId, identity.commonDir);
  await mkdir(join(dataRoot, "sock"), { mode: 0o700 });
  const clock = createClock(); cleanup.push(() => clock.stopGapWatcher());
  const shells = new ShellRegistry({ clock });
  const server = new DaemonServer({ authToken: controlToken(dataRoot), repoId: identity.repoId, startedAt: "fixture" });
  const verifier = new ProjectSyncGrantVerifier({ dataRoot, ...identity, daemonInstanceId: server.daemonInstanceId });
  const coordinator = new ProjectIndexCoordinator({ dataRoot, ...identity, server, grants: verifier, beforeArchiveRisk: () => {} });
  await server.listen(daemonSocketPath(dataRoot, identity.repoId)); server.markHandlersReady();
  cleanup.push(async () => { await coordinator.close(); await server.close(); });
  const client = await connectDaemon({ dataRoot, repoDir: repo, sdkDir: "/not-spawned", clock,
    hello: { sessionId: "role-fixture", windowId: "role-window", pid: process.pid, cwd: repo, workspaceRoot: repo } });
  cleanup.push(() => client.close());
  const actual = server.clients()[0]!;
  const principal = {};
  let approved = false;
  const connection = { daemonInstanceId: actual.daemonInstanceId!, connectionId: actual.connectionId!, connectionSequence: 1 };
  const issuer = new ProjectSyncGrantIssuer({ dataRoot, ...identity, hostPrincipal: principal, currentHostPrincipal: () => principal,
    currentConnectionIdentity: () => server.clients().includes(actual) ? connection : null, authorize: () => approved });
  cleanup.push(() => issuer.close());
  const scope = await coordinator.baselineScope(repo);
  const provider = await createDaemonProjectBaselineProvider(coordinator, repo); cleanup.push(() => provider.dispose());
  return { root, repo, dataRoot, identity, coordinator, provider, clock, shells, client, scope,
    async initialize() { approved = true; const grant = await issuer.issue(actual, scope); await coordinator.attach({ ...scope, grantId: grant.grantId }, actual); },
  };
}

async function role(w: Awaited<ReturnType<typeof world>>, options: { slow?: () => Promise<void>; calls?: ToolCall[]; plain?: boolean; pm?: boolean; runId?: string; extra?: (pi: ExtensionAPI) => void } = {}) {
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, modelsStorePath: join(w.root, "models.json"), refreshOnCreate: false });
  let requests = 0;
  runtime.registerProvider("role-fixture", { apiKey: "fixture", baseUrl: "http://127.0.0.1:1", api: "anthropic-messages",
    models: [{ id: "slow", name: "slow", reasoning: false, input: ["text"], contextWindow: 100000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple(model, _context, transport) {
      const stream = createAssistantMessageEventStream(); const request = ++requests;
      const calls = request === 1 ? options.calls ?? [] : [];
      const content: AssistantMessage["content"] = calls.length ? calls : options.plain || request > 2 ? [{ type: "text", text: "plain original result" }] : [{ type: "toolCall", id: `result-${request}`, name: "structured_output", arguments: workResult() }];
      const message: AssistantMessage = { role: "assistant", provider: model.provider, api: model.api, model: model.id, timestamp: request,
        content, stopReason: content.some((item) => item.type === "toolCall") ? "toolUse" : "stop",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      void (async () => { await transport?.onPayload?.({ fixture: true }, model);
        stream.push({ type: "start", partial: { ...message, content: [], stopReason: "pending" } });
        if (request === 1) await options.slow?.();
        stream.push({ type: "done", reason: message.stopReason === "toolUse" ? "toolUse" : "stop", message });
      })().catch((error) => stream.push({ type: "error", reason: "error", error: { ...message, stopReason: "error", errorMessage: String(error) } }));
      return stream;
    } });
  const runId = options.runId ?? uuidv7();
  const protection = await createRangeProtection({ cwd: w.repo, dataRoot: w.dataRoot, holder: { kind: "role", runId, requirement: "2026-09-13.fixture" }, writePaths: [w.repo], clock: w.clock, shells: w.shells });
  cleanup.push(() => protection.release());
  const handle = await createRoleSession({ dataRoot: w.dataRoot, repoId: w.identity.repoId, runId, shellToken: "fixture", cwd: w.repo,
    roleName: options.pm ? "requirement-agent" : "worker", role: { name: "worker", available: true, source: "project", path: join(w.root, "worker.md"),
      definition: { name: "worker", kind: options.pm ? "manage" : "work", description: "fixture", tools: ["write", "edit", "bash", ...(options.extra ? ["pi_company_agent"] : [])], skills: false, contextFiles: false, promptMode: "append", body: "fixture" } },
    task: "fixture", readPaths: [w.repo], writePaths: [w.repo], runtime, modelRef: { provider: "role-fixture", id: "slow" },
    clock: w.clock, shellRegistry: w.shells, networkGate: new NetworkPauseGate(),
    guards: { ...protection, baselineProvider: async () => w.provider, checkWrite: (path) => protection.checkWrite(path),
      fingerprint: async () => ({}), verifyFingerprint: async () => [] },
    extraExtensionFactories: options.extra ? [options.extra] : [],
    contract: options.plain ? { kind: "plain", completion: "complete-on-idle" } : { kind: "structured", expectedPhase: "work", outputSchema: WORK_SCHEMA },
  });
  cleanup.push(async () => { await handle.stop(); handle.dispose(); });
  const toolErrors: unknown[] = [];
  handle.events.on("transcript_message", (event) => { if (event.type === "message_end" && event.message.role === "toolResult" && event.message.isError) toolErrors.push(event.message.content); });
  return { handle, requests: () => requests, toolErrors };
}

const write = (id: string, content: string): ToolCall => ({ type: "toolCall", id, name: "write", arguments: { path: "source.ts", content } });

async function registerCancelled(w: Awaited<ReturnType<typeof world>>) {
  const host = { windowId: "role-window", sessionId: "role-fixture", repositories: new Map([[w.identity.repoId, { path: w.repo }]]) };
  const owner = new ProjectSyncClientSession({ dataRoot: w.dataRoot, host, cwd: w.repo,
    clients: { forRepo: () => w.client, closeAll: () => w.client.close() }, isCurrentHost: () => true });
  try {
    const service = await owner.openService({ dataRoot: w.dataRoot, repoId: w.identity.repoId, repositoryRoot: w.repo,
      authorizedBranch: "refs/heads/main", host, action: "init", authorize: () => true, authorizeContinuous: () => true });
    await expect(service.init({ signal: AbortSignal.abort() })).rejects.toThrow();
  } finally { await owner.shutdown(); }
  const db = new DatabaseSync(join(w.dataRoot, "repos", w.identity.repoId, "data.db"), { readOnly: true });
  try { expect(db.prepare("SELECT record_key FROM records WHERE namespace=?").all(PROJECT_INDEX_MANAGEMENT_NAMESPACE)).toEqual([{ record_key: w.scope.workspaceId }]); }
  finally { db.close(); }
  expect(fs.existsSync(join(w.dataRoot, "repos", w.identity.repoId, "index.db"))).toBe(false);
}

test("持久管理登记后取消：原unmanaged请求、已完成角色结果和交付不能恢复legacy", async () => {
  const w = await world();
  const gate = new RequestBaselineGate(w.provider); cleanup.push(() => gate.dispose());
  const request = await gate.beginRequest(); expect(request.kind).toBe("unmanaged");
  const s = await role(w, { plain: true }); s.handle.prompt("legacy result"); await s.handle.result();
  const baseline = await s.handle.resultBaseline!(); expect(baseline?.kind).toBe("unmanaged");
  await baseline!.assertCurrent();
  const run = { cwd: w.repo, requirement: "2026-09-13.fixture", task: "T-1", phase: "work", state: "completed" } as RunRecord;
  run.result = await bindRunResult(run, "work", workResult(), baseline);
  const original = JSON.stringify(run.result);
  await registerCancelled(w);
  await expect(gate.validateRequest(request)).rejects.toThrow();
  await expect(baseline!.assertCurrent()).rejects.toThrow();
  await expect(bindRunResult(run, "work", workResult(), baseline)).rejects.toThrow();
  const fresh = await createDaemonProjectBaselineProvider(w.coordinator, w.repo); cleanup.push(() => fresh.dispose());
  let executed = 0;
  await expect(verifyTaskDelivery({ run, assertBaseline: async (metadata) => {
    expect(metadata).toBeUndefined();
    if ((await fresh.captureFresh()).kind !== "unmanaged") throw new Error("legacy delivery requires unmanaged");
  }, execute: async () => { executed++; } })).rejects.toThrow();
  expect(executed).toBe(0); expect(JSON.stringify(run.result)).toBe(original);
}, 30000);

test("真实SDK旧unmanaged慢消息：登记后取消，write与structured_output都拒绝", async () => {
  const w = await world(); const entered = deferred<void>(), release = deferred<void>();
  const s = await role(w, { slow: async () => { entered.resolve(); await release.promise; }, calls: [write("old-unmanaged-write", "BAD"),
    { type: "toolCall", id: "old-unmanaged-result", name: "structured_output", arguments: workResult() }] });
  const ends: Array<{ toolCallId: string; isError: boolean }> = []; s.handle.events.on("tool_end", (event) => ends.push(event));
  const idle = new Promise<void>((done) => s.handle.events.once("idle", () => done()));
  s.handle.prompt("legacy in flight"); await entered.promise;
  try { await registerCancelled(w); } finally { release.resolve(); }
  await idle;
  expect(ends.find((event) => event.toolCallId === "old-unmanaged-write")?.isError).toBe(true);
  expect(ends.find((event) => event.toolCallId === "old-unmanaged-result")?.isError).toBe(true);
  expect(await readFile(join(w.repo, "source.ts"), "utf8")).toBe("export const value = 1;\n");
  await expect(s.handle.finalize()).rejects.toThrow();
}, 30000);

test("真实SDK新provider新角色：只持久登记也拒绝写入和交付，不需沿用内存managed", async () => {
  const w = await world(); await registerCancelled(w);
  const provider = await createDaemonProjectBaselineProvider(w.coordinator, w.repo); cleanup.push(() => provider.dispose());
  const s = await role({ ...w, provider }, { calls: [write("new-unmanaged-write", "BAD")] });
  const ends: Array<{ toolCallId: string; isError: boolean }> = []; s.handle.events.on("tool_end", (event) => ends.push(event));
  const idle = new Promise<void>((done) => s.handle.events.once("idle", () => done()));
  s.handle.prompt("registered workspace"); await idle;
  await expect(s.handle.finalize()).rejects.toThrow();
  expect(ends.find((event) => event.toolCallId === "new-unmanaged-write")?.isError).toBe(true);
  expect(await readFile(join(w.repo, "source.ts"), "utf8")).toBe("export const value = 1;\n");
  expect(fs.existsSync(join(w.dataRoot, "repos", w.identity.repoId, "index.db"))).toBe(false);
}, 30000);

test("daemon source：未初始化legacy不创建watcher；已初始化断线与重启均拒绝降级", async () => {
  const w = await world();
  expect(await w.provider.captureFresh()).toMatchObject({ kind: "unmanaged" });
  await w.initialize(); const captured = await w.provider.captureFresh(); expect(captured.kind).toBe("fresh");
  if (captured.kind !== "fresh") throw new Error("fixture");
  await w.provider.assertCurrent(captured.snapshot);
  w.client.close();
  await expect(w.provider.captureFresh()).rejects.toThrow();
  await w.coordinator.close();
  const restarted = new ProjectIndexCoordinator({ dataRoot: w.dataRoot, ...w.identity, server: new DaemonServer({ authToken: "fixture", repoId: w.identity.repoId, startedAt: "restart" }),
    grants: { validateForClient() { throw new Error("no live grant"); }, revokeExact: async () => true } });
  cleanup.push(() => restarted.close());
  const provider = await createDaemonProjectBaselineProvider(restarted, w.repo); cleanup.push(() => provider.dispose());
  await expect(provider.captureFresh()).rejects.toMatchObject({ code: "not_attached" });
}, 30000);

test("真实socket/watch：原seal外改失效；观察A→B→A也不能恢复", async () => {
  const w = await world(); await w.initialize();
  const gate = new RequestBaselineGate(w.provider); cleanup.push(() => gate.dispose());
  const request = await gate.beginRequest(); gate.bindCalls(["result"], request); const seal = await gate.sealResult("result");
  const changed = deferred<void>(); const stop = w.provider.subscribeInvalidation(() => changed.resolve()); cleanup.push(stop);
  const original = await readFile(join(w.repo, "source.ts"), "utf8");
  await writeFile(join(w.repo, "source.ts"), "export const value = 2;\n"); await changed.promise;
  await writeFile(join(w.repo, "source.ts"), original);
  await expect(Promise.resolve().then(() => gate.assertDelivery(seal))).rejects.toThrow();
}, 30000);

test("真实SQLite/watch：精确自写推进原请求executionHead，seal保存原hash而非换绑", async () => {
  const w = await world(); await w.initialize();
  const gate = new RequestBaselineGate(w.provider); cleanup.push(() => gate.dispose());
  const request = await gate.beginRequest(); gate.bindCalls(["write", "result"], request);
  const content = "export const value = 3;\n";
  await gate.withMutation("write", { paths: ["source.ts"], expectedWrites: [{ path: "source.ts", hash: hash(content) }] }, async () => { await writeFile(join(w.repo, "source.ts"), content); });
  const seal = await gate.sealResult("result");
  expect(seal.metadata.origin.files.find((file) => file.path === "source.ts")!.hash).not.toBe(hash(content));
  expect(seal.metadata.executionHead.files.find((file) => file.path === "source.ts")!.hash).toBe(hash(content));
  await gate.assertDelivery(seal);
}, 30000);

test("真实SDK角色慢模型：外改后同一旧消息的write及structured_output都拒绝", async () => {
  const w = await world(); await w.initialize(); const entered = deferred<void>(), release = deferred<void>();
  const s = await role(w, { slow: async () => { entered.resolve(); await release.promise; }, calls: [write("stale-write", "BAD"),
    { type: "toolCall", id: "stale-result", name: "structured_output", arguments: { phase: "work", verdict: "PASS", summary: "old", issues: [], evidence: [] } }] });
  const ends: Array<{ toolCallId: string; isError: boolean }> = []; s.handle.events.on("tool_end", (event) => ends.push(event));
  s.handle.prompt("fixture"); await entered.promise; await writeFile(join(w.repo, "source.ts"), "export const external = true;\n");
  w.client.close(); release.resolve();
  await new Promise<void>((resolve) => { s.handle.events.on("idle", () => resolve()); });
  expect(await readFile(join(w.repo, "source.ts"), "utf8")).toBe("export const external = true;\n");
  expect(ends.find((event) => event.toolCallId === "stale-write")?.isError).toBe(true);
  expect(ends.find((event) => event.toolCallId === "stale-result")?.isError).toBe(true);
  await expect(s.handle.finalize()).rejects.toThrow();
}, 30000);

test("真实SDK角色：精确write后正常原请求提交；完成seal复核后dispose撤权", async () => {
  const w = await world(); await w.initialize(); const s = await role(w, { calls: [write("own", "export const own = true;\n")] });
  s.handle.prompt("fixture"); await s.handle.result();
  const baseline = await s.handle.resultBaseline!(); expect(baseline?.kind).toBe("managed"); await baseline!.assertCurrent();
  s.handle.dispose(); await expect(baseline!.assertCurrent()).rejects.toThrow();
  expect(w.shells.list().filter((task) => ["starting", "running", "stopping", "uncertain"].includes(task.status))).toEqual([]);
}, 30000);

test("未初始化plain角色保留legacy收尾，结果明确不属于M3索引覆盖", async () => {
  const w = await world(); const s = await role(w, { plain: true });
  s.handle.prompt("plain legacy"); await s.handle.result();
  expect((await s.handle.resultBaseline!())?.kind).toBe("unmanaged");
  expect(fs.existsSync(join(w.dataRoot, "repos", w.identity.repoId, "index.db"))).toBe(false);
}, 30000);

test("真实SDK managed plain：完整原消息seal使用messageId；重复finalize不换绑", async () => {
  const w = await world(); await w.initialize();
  const before = await w.provider.captureFresh();
  const s = await role(w, { plain: true });
  s.handle.prompt("plain managed"); await s.handle.result();
  const baseline = await s.handle.resultBaseline!();
  expect(baseline?.kind).toBe("managed");
  if (baseline?.kind !== "managed" || before.kind !== "fresh") throw new Error("fixture");
  expect(baseline.seal.metadata).toMatchObject({ messageId: expect.any(String), origin: { baselineHash: before.snapshot.baselineHash } });
  expect(baseline.seal.metadata).not.toHaveProperty("callId");
  await Promise.all([s.handle.finalize(), s.handle.finalize()]);
  expect(await s.handle.resultBaseline!()).toBe(baseline);
  s.handle.dispose(); await expect(baseline.assertCurrent()).rejects.toThrow();
}, 30000);

test("真实SDK managed plain慢消息：外改后不能拿当前hash给旧文字结果换绑", async () => {
  const w = await world(); await w.initialize(); const entered = deferred<void>(), release = deferred<void>();
  const s = await role(w, { plain: true, slow: async () => { entered.resolve(); await release.promise; } });
  s.handle.prompt("plain old"); await entered.promise;
  await writeFile(join(w.repo, "source.ts"), "export const external = true;\n");
  release.resolve(); await expect(s.handle.result()).rejects.toThrow();
  await expect(s.handle.resultBaseline!()).rejects.toThrow();
  expect(s.handle.state()).toBe("failed");
}, 30000);

test("真实SDK plain最终消息被后置扩展替换：原消息seal不得替修改后的输出背书", async () => {
  const w = await world(); await w.initialize();
  const s = await role(w, { plain: true, extra: (pi) => pi.on("message_end", (event) => {
    if (event.message.role === "assistant") return { message: { ...event.message, content: [{ type: "text", text: "replacement" }] } };
  }) });
  s.handle.prompt("original"); await expect(s.handle.result()).rejects.toThrow();
  expect(s.handle.state()).toBe("failed");
}, 30000);

for (const action of ["pause", "stop"] as const) test(`真实SDK plain异步seal期间${action}：重复finalize与迟到seal不能完成`, async () => {
  const w = await world(); await w.initialize(); const entered = deferred<void>(), release = deferred<void>();
  let seals = 0;
  const s = await role(w, { plain: true, extra: (pi) => pi.on("before_provider_request", (_event, ctx) => {
    const hooks = projectBaselineForContext(ctx)!;
    const sealMessage = hooks.sealMessage.bind(hooks);
    vi.spyOn(hooks, "sealMessage").mockImplementation(async (message) => {
      seals++; entered.resolve(); await release.promise; return sealMessage(message);
    });
  }) });
  s.handle.prompt("seal pending"); await entered.promise;
  const finalizing = Promise.allSettled([s.handle.finalize(), s.handle.finalize()]);
  const stopping = s.handle[action](); release.resolve(); await stopping;
  expect(s.handle.state()).toBe(action === "pause" ? "paused" : "stopped");
  await expect(s.handle.resultBaseline!()).rejects.toThrow();
  if (action === "pause") await s.handle.stop();
  expect((await finalizing).every((result) => result.status === "rejected")).toBe(true);
  expect(seals).toBe(1);
}, 30000);

test("真实角色后台进程未结束不能封结果，新模型请求不自动杀掉已授权命令", async () => {
  const w = await world();
  // 检查输出目录先于模型基线准备；首次创建输入父目录本身属于真实watch变化。
  await mkdir(join(w.repo, ".pi-company/.cache"), { recursive: true });
  await writeFile(join(w.repo, ".pi-company/.cache/.gitignore"), "*\n");
  await w.initialize();
  const s = await role(w, { calls: [{ type: "toolCall", id: "background", name: "bash", arguments: { command: "sleep 1; printf FINISHED > source.ts", background: true } }] });
  const idle = new Promise<void>((done) => s.handle.events.once("idle", () => done()));
  const errors: Array<{ toolCallId: string; isError: boolean }> = []; s.handle.events.on("tool_end", (event) => errors.push(event));
  s.handle.prompt("fixture background"); await idle;
  const tasks = w.shells.list(); if (!tasks.length) console.error("角色命令拒绝依据", JSON.stringify(s.toolErrors)); expect(tasks.length).toBe(1);
  const task = tasks[0]!;
  if (task.status !== "exited") await new Promise<void>((done) => {
    const stop = w.shells.subscribe(task.taskId, (updated) => { if (updated.status === "exited") { stop(); done(); } });
  });
  expect(await readFile(join(w.repo, "source.ts"), "utf8")).toBe("FINISHED");
  expect(errors.find((event) => event.toolCallId === "result-2")?.isError).toBe(true);
  expect(s.handle.state()).not.toBe("completed");
  await expect(s.handle.finalize()).rejects.toThrow();
}, 30000);

test("反复角色完成后基线订阅回到原值，不因sessions丢引用残留", async () => {
  const w = await world(); await w.initialize();
  const count = () => [...(w.coordinator as unknown as { baselineListeners: Map<string, Set<unknown>> }).baselineListeners.values()].reduce((n, listeners) => n + listeners.size, 0);
  const before = count();
  for (let round = 0; round < 3; round++) {
    const provider = await createDaemonProjectBaselineProvider(w.coordinator, w.repo);
    const s = await role({ ...w, provider }); s.handle.prompt("fixture"); await s.handle.result(); await s.handle.resultBaseline!();
    s.handle.dispose(); await new Promise<void>((done) => setImmediate(done));
    expect(count()).toBe(before);
  }
}, 30000);

test("真实SDK PM submit：旧请求不能借新建子run换绑，SQLite没有新交付记录", async () => {
  const w = await world(); await w.initialize();
  const store = new RunStore({ dataRoot: w.dataRoot, repoId: w.identity.repoId, daemonStartedAt: "fixture" });
  const parent = await store.create({ kind: "requirement", requirement: "2026-09-13.fixture", task: "PM", cwd: w.repo,
    writePaths: [w.repo], readPaths: [w.repo], model: { provider: "role-fixture", id: "slow" }, thinking: "off", mcp: [] });
  await store.update(parent.id, { state: "running" });
  const entered = deferred<void>(), release = deferred<void>();
  const s = await role(w, { pm: true, runId: parent.id, calls: [{ type: "toolCall", id: "pm-submit", name: "pi_company_agent", arguments: { action: "submit", task: "T-1", result: workResult() } }],
    slow: async () => { entered.resolve(); await release.promise; }, extra: (pi) => registerAgentTool(pi, {
      baselineRequired: true, dataRoot: w.dataRoot, repoId: w.identity.repoId, requirement: parent.requirement, cwd: w.repo, roleCatalog: [],
      roleName: "requirement-agent", runId: parent.id, runStore: store, workspaceRepoIds: [w.identity.repoId], modelRef: parent.model,
      dispatch: {} as never, relay: {} as never,
    }) });
  const ends: Array<{ toolCallId: string; isError: boolean }> = []; s.handle.events.on("tool_end", (event) => ends.push(event));
  const idle = new Promise<void>((done) => s.handle.events.once("idle", () => done()));
  s.handle.prompt("submit original"); await entered.promise;
  await writeFile(join(w.repo, "source.ts"), "export const updated = true;\n"); w.client.close(); release.resolve(); await idle;
  expect(ends.find((event) => event.toolCallId === "pm-submit")?.isError).toBe(true);
  expect((await store.list({ limit: 100 })).items.map((run) => run.id)).toEqual([parent.id]);
}, 30000);

async function delivery(w: Awaited<ReturnType<typeof world>>) {
  const requirement = "2026-09-13.fixture";
  const taskDir = join(w.repo, ".pi-company/requirements", requirement, "tasks"); await mkdir(taskDir, { recursive: true });
  await mkdir(join(w.repo, ".pi-company/spec/demo"), { recursive: true });
  await writeFile(join(w.repo, ".pi-company/spec/demo/source.md"), "# AC-1\nfixture\n");
  await writeFile(join(taskDir, "T-1.md"), "---\nid: T-1\nrefs: [demo/source/AC-1]\nfiles: [source.ts]\nverify: 'true'\n---\n");
  await exec("/usr/bin/git", ["add", "."], { cwd: w.repo, env: GIT_ENV });
  await exec("/usr/bin/git", ["commit", "-m", "fixture inputs"], { cwd: w.repo, env: GIT_ENV });
  await w.initialize();
  const gate = new RequestBaselineGate(w.provider); cleanup.push(() => gate.dispose());
  const request = await gate.beginRequest(); gate.bindCalls(["delivery"], request); const seal = await gate.sealResult("delivery");
  const run = { cwd: w.repo, requirement, task: "T-1", phase: "work", writePaths: ["source.ts"], state: "completed" } as RunRecord;
  const raw = { ...workResult(), coverage: [{ ref: "demo/source/AC-1", test: "source.ts:1" }] };
  run.result = await bindRunResult(run, "work", raw, { kind: "managed", seal, assertCurrent: () => gate.assertDelivery(seal) });
  return { run, seal, gate };
}

test("真实交付复跑保留原binding，结束角色后仍按coordinator原观察代次核验", async () => {
  const w = await world(); const d = await delivery(w);
  const original = (d.run.result as Record<string, unknown>).binding;
  d.gate.dispose();
  const verificationProvider = await createDaemonProjectBaselineProvider(w.coordinator, w.repo); cleanup.push(() => verificationProvider.dispose());
  let executed = 0;
  const result = await verifyTaskDelivery({ run: d.run, assertBaseline: async (metadata) => verificationProvider.assertCurrent(metadata!.executionHead),
    execute: async (command) => { executed++; await exec("/bin/sh", ["-c", command], { cwd: w.repo }); } });
  expect(executed).toBe(1); expect(result.binding).toBe(original);
}, 30000);

test("真实交付检查期间A→B→A：即使最终字节相同也拒绝且原binding未改", async () => {
  const w = await world(); const d = await delivery(w);
  const original = JSON.stringify(d.run.result);
  await expect(verifyTaskDelivery({ run: d.run, assertBaseline: async (metadata) => w.provider.assertCurrent(metadata!.executionHead), execute: async () => {
    const previous = await readFile(join(w.repo, "source.ts"), "utf8"), changed = deferred<void>();
    const unsubscribe = w.provider.subscribeInvalidation(() => changed.resolve());
    try { await writeFile(join(w.repo, "source.ts"), "export const temporary = 2;\n"); await changed.promise; await writeFile(join(w.repo, "source.ts"), previous); }
    finally { unsubscribe(); }
  } })).rejects.toThrow();
  expect(JSON.stringify(d.run.result)).toBe(original);
}, 30000);

test("daemon角色基线与交付检查不打开归档正文，策略排除不是任意路径写权限", async () => {
  const w = await world(); const archive = join(w.repo, "docs/prod/0197b7b0-6a20-7c51-8a32-b9465fb72d10.完成.md");
  await mkdir(join(w.repo, "docs/prod"), { recursive: true }); await writeFile(archive, "ARCHIVE_BODY_PROBE");
  let reads = 0;
  const forbidden = (path: unknown) => { if (String(path).includes("/docs/prod/")) { reads++; throw new Error("archive body forbidden"); } };
  const open = fsp.open, read = fsp.readFile, stream = fs.createReadStream;
  vi.spyOn(fsp, "open").mockImplementation(((...args: Parameters<typeof fsp.open>) => { forbidden(args[0]); return open(...args); }) as typeof fsp.open);
  vi.spyOn(fsp, "readFile").mockImplementation(((...args: Parameters<typeof fsp.readFile>) => { forbidden(args[0]); return read(...args); }) as typeof fsp.readFile);
  vi.spyOn(fs, "createReadStream").mockImplementation(((...args: Parameters<typeof fs.createReadStream>) => { forbidden(args[0]); return stream(...args); }) as typeof fs.createReadStream);
  syncBuiltinESMExports();
  await w.initialize(); const snapshot = await w.provider.captureFresh(); expect(snapshot.kind).toBe("fresh");
  if (snapshot.kind !== "fresh") throw new Error("fixture");
  await w.provider.assertCurrent(snapshot.snapshot);
  await expect(w.provider.checkPath(archive)).rejects.toThrow();
  await expect(w.provider.checkPath(join(w.repo, ".env"))).rejects.toThrow();
  await expect(w.provider.checkPath(join(w.repo, "node_modules/new.ts"))).rejects.toThrow();
  const gate = new RequestBaselineGate(w.provider); cleanup.push(() => gate.dispose());
  const request = await gate.beginRequest(); gate.bindCalls(["archive-check"], request); const seal = await gate.sealResult("archive-check");
  await bindRunResult({ cwd: w.repo, requirement: "2026-09-13.fixture", task: "T-1", phase: "work" } as RunRecord, "work", workResult(),
    { kind: "managed", seal, assertCurrent: () => gate.assertDelivery(seal) });
  expect(reads).toBe(0); expect(snapshot.snapshot.files.some((file) => file.path.startsWith("docs/prod/"))).toBe(false);
}, 30000);

test("bindRunResult不信模型hash：旧seal在任何异步检查前就拒绝", async () => {
  const w = await world(); await w.initialize(); const gate = new RequestBaselineGate(w.provider); cleanup.push(() => gate.dispose());
  const request = await gate.beginRequest(); gate.bindCalls(["result"], request); const seal = await gate.sealResult("result");
  await writeFile(join(w.repo, "source.ts"), "export const changed = true;\n");
  const run = { cwd: w.repo, requirement: "2026-09-13.fixture", task: "T-1", phase: "work" } as RunRecord;
  await expect(bindRunResult(run, "work", { verdict: "PASS", binding: { hash: "forged" } }, { kind: "managed", seal, assertCurrent: () => gate.assertDelivery(seal) })).rejects.toThrow();
}, 30000);
