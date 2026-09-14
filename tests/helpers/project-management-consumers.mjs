import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

// 框架分别走 Node 原生 TS 与产品正式 loader；SDK 使用发布的 JS 实例，不联网。
const mode = process.argv[2] ?? "loader";
assert.ok(["native", "loader"].includes(mode));
const source = new URL("../../", import.meta.url);
const { daemonLoader } = await import(new URL("daemon/loader.mjs", source));
const load = (path) => mode === "loader" ? daemonLoader.import(new URL(path, source).href) : import(new URL(path, source));
const { repositoryIdentity, repoDataDir } = await load("runtime/identity.ts");
const { uuidv7 } = await load("runtime/database.ts");
const { ProjectSyncClientSession, PROJECT_INDEX_MANAGEMENT_NAMESPACE } = await load("runtime/project-sync-client.ts");
const { ProjectIndexService } = await load("runtime/project-index-service.ts");
const { ProjectIndexCoordinator } = await load("daemon/project-index-coordinator.ts");
const { DaemonServer } = await load("daemon/server.ts");
const { createDaemonProjectBaselineProvider } = await load("daemon/project-baseline-provider.ts");
const { RequestBaselineGate } = await load("runtime/project-baseline.ts");
const { installProjectBaselineHooks } = await load("runtime/project-baseline-hooks.ts");
const { createProtectedFileTools } = await load("extensions/write-protection.ts");
const sdk = await import(new URL("node_modules/@earendil-works/pi-coding-agent/dist/index.js", source));
const ai = await import(new URL("node_modules/@earendil-works/pi-ai/dist/index.js", source));
const exec = promisify(execFile);
const records = [];

async function world() {
  const root = await fsp.realpath(await fsp.mkdtemp("/tmp/m3-management-fixture-")); await fsp.chmod(root, 0o700);
  const repo = join(root, "repo"), dataRoot = join(root, "data"), home = join(root, "home");
  const closes = [];
  const env = { PATH: "/usr/bin:/bin", HOME: home, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" };
  const git = (args) => exec("/usr/bin/git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd: repo, env });
  for (const dir of [repo, dataRoot, home]) await fsp.mkdir(dir, { mode: 0o700 });
  await git(["init", "-b", "main"]);
  await fsp.writeFile(join(repo, "source.ts"), "ORIGINAL", { mode: 0o600 });
  await git(["add", "source.ts"]); await git(["commit", "-m", "fixture"]);
  const identity = await repositoryIdentity(repo); await repoDataDir(dataRoot, identity.repoId, identity.commonDir);
  const indexPath = join(dataRoot, "repos", identity.repoId, "index.db"), dataPath = join(dataRoot, "repos", identity.repoId, "data.db");
  let rpc = 0, grants = 0, managers = 0;
  // 只为尚未发 init 的 HOST 提供连接身份；真实 RPC、grant 和 watcher 创建一律报错。
  const client = { subscribe: () => () => {}, connectionIdentity: () => ({ daemonInstanceId: "fixture", connectionId: "fixture", connectionSequence: 1 }),
    call: async () => { rpc++; throw new Error("NO_RPC_ALLOWED"); } };
  const host = (path = repo) => {
    const context = { windowId: "window", sessionId: "session", repositories: new Map([[identity.repoId, { path }]]) };
    const owner = new ProjectSyncClientSession({ dataRoot, host: context, cwd: path, clients: { forRepo: () => client, closeAll() {} }, isCurrentHost: () => true });
    closes.push(() => owner.shutdown()); return { owner, context };
  };
  const coordinator = new ProjectIndexCoordinator({ dataRoot, ...identity,
    server: new DaemonServer({ authToken: "fixture", repoId: identity.repoId, startedAt: "fixture" }),
    createManager() { managers++; throw new Error("NO_MANAGER_ALLOWED"); },
    grants: { validateForClient() { grants++; throw new Error("NO_GRANT_ALLOWED"); }, async revokeExact() { throw new Error("NO_GRANT_TO_REVOKE"); } } });
  closes.push(() => coordinator.close());
  const provider = async (path = repo) => {
    const p = await createDaemonProjectBaselineProvider(coordinator, path); closes.push(() => p.dispose()); return p;
  };
  const cancelledRegistration = async (path = repo) => {
    const { owner, context } = host(path);
    const branch = (await exec("/usr/bin/git", ["symbolic-ref", "HEAD"], { cwd: path, env })).stdout.trim();
    const service = await owner.openService({ dataRoot, repoId: identity.repoId, repositoryRoot: path, authorizedBranch: branch,
      host: context, action: "init", authorize: () => true, authorizeContinuous: () => true });
    await assert.rejects(service.init({ signal: AbortSignal.abort() })); await owner.shutdown();
    const db = new DatabaseSync(dataPath, { readOnly: true });
    try { assert.equal(db.prepare("SELECT count(*) AS n FROM records WHERE namespace=?").get(PROJECT_INDEX_MANAGEMENT_NAMESPACE).n, 1); }
    finally { db.close(); }
  };
  return { root, repo, home, dataRoot, identity, indexPath, dataPath, git, host, provider, coordinator, cancelledRegistration, closes,
    async close() {
      const failures = [];
      for (const close of closes.reverse()) try { await close(); } catch (error) { failures.push(error); }
      if (failures.length) throw new AggregateError(failures, `fixture cleanup failed: ${root}`);
      assert.deepEqual({ rpc, grants, managers }, { rpc: 0, grants: 0, managers: 0 });
      await fsp.rm(root, { recursive: true, force: true }); assert.equal(fs.existsSync(root), false);
    } };
}

// 禁止 unmanaged 元数据检查读取源码/归档或创建文件；SQLite 自身读元数据不经这些正文入口。
async function metadataOnly(w, action) {
  let reads = 0;
  const restorations = [];
  for (const [object, methods] of [[fsp, ["open", "readFile", "readdir", "writeFile"]], [fs, ["openSync", "readFileSync", "readdirSync", "createReadStream", "writeFileSync"]]]) {
    for (const method of methods) {
      const original = object[method];
      object[method] = function (path, ...args) {
        const value = path instanceof URL ? fileURLToPath(path) : String(path);
        if (value === w.repo || value.startsWith(`${w.repo}/`)) { reads++; throw new Error("NO_PROJECT_BODY_IO"); }
        return original.call(this, path, ...args);
      };
      restorations.push(() => { object[method] = original; });
    }
  }
  syncBuiltinESMExports();
  try { await action(); assert.equal(reads, 0); }
  finally { for (const restore of restorations.reverse()) restore(); syncBuiltinESMExports(); }
}

async function sdkSession(w, provider, beforeFirstMessage) {
  const runtime = await sdk.ModelRuntime.create({ authPath: join(w.home, "auth.json"), modelsPath: null, modelsStorePath: join(w.home, "models.json"), refreshOnCreate: false });
  let calls = 0, hooks;
  runtime.registerProvider("fixture", { api: "anthropic-messages", apiKey: "fixture", baseUrl: "http://never-contacted.invalid",
    models: [{ id: "fixture", name: "fixture", reasoning: false, input: ["text"], contextWindow: 10000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple(model, context, options) {
      const stream = ai.createAssistantMessageEventStream(), call = ++calls;
      const message = { role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: call,
        content: call === 1 ? [{ type: "toolCall", id: "write", name: "write", arguments: { path: "source.ts", content: "SDK_WRITE" } }] : [{ type: "text", text: "done" }],
        stopReason: call === 1 ? "toolUse" : "stop", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      void (async () => {
        await options?.onPayload?.({}, model); stream.push({ type: "start", partial: { ...message, content: [], stopReason: "pending" } });
        if (call === 1) await beforeFirstMessage?.(); stream.push({ type: "done", reason: message.stopReason, message });
      })().catch((error) => stream.push({ type: "error", reason: "error", error: { ...message, stopReason: "error", errorMessage: String(error) } }));
      return stream;
    } });
  const loader = new sdk.DefaultResourceLoader({ cwd: w.repo, agentDir: w.home, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
    agentsFilesOverride: () => ({ agentsFiles: [] }), extensionFactories: [(pi) => {
      hooks = installProjectBaselineHooks(pi, { provider, checkPath: async (path, request) => request.kind === "unmanaged" ? path : provider.checkPath(path) });
      // 夹具显式给予 source.ts 原有写范围；管理状态仍由生产 gate/工具核验，不替换其结果。
      pi.registerTool(createProtectedFileTools(async () => ({ checkWrite: async (path) => ({ ok: path === join(w.repo, "source.ts") }) }))[0]);
    }] });
  await loader.reload();
  const { session } = await sdk.createAgentSession({ cwd: w.repo, agentDir: w.home, modelRuntime: runtime, model: runtime.getModels("fixture")[0], resourceLoader: loader,
    sessionManager: sdk.SessionManager.inMemory(w.repo), settingsManager: sdk.SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } }), tools: ["write"] });
  w.closes.push(async () => { await hooks.shutdown(); session.dispose(); });
  return { session, hooks };
}

for (const scenario of ["cancelled", "deleted-index", "legacy-index", "unknown-record", "missing-data", "other-worktree", "legacy"]) {
  const w = await world();
  try {
    const currentRoot = scenario === "other-worktree" ? join(w.root, "other") : w.repo;
    if (currentRoot !== w.repo) await w.git(["worktree", "add", "-b", "other", currentRoot]);
    const current = { ...w, repo: currentRoot };
    const p = await w.provider(currentRoot), gate = new RequestBaselineGate(p); w.closes.push(() => gate.dispose());
    const old = await gate.beginRequest(); assert.equal(old.kind, "unmanaged");
    if (["cancelled", "deleted-index"].includes(scenario)) await w.cancelledRegistration();
    if (["deleted-index", "legacy-index"].includes(scenario)) {
      const service = await ProjectIndexService.open({ repositoryRoot: w.repo, dataRoot: w.dataRoot, repoId: w.identity.repoId, authorize: () => true });
      assert.equal((await service.init()).budget.stoppedReason, "complete"); assert.equal(fs.existsSync(w.indexPath), true);
      if (scenario === "deleted-index") for (const suffix of ["", "-wal", "-shm"]) await fsp.rm(w.indexPath + suffix, { force: true });
    }
    if (scenario === "unknown-record") {
      const db = new DatabaseSync(w.dataPath);
      try { db.prepare("INSERT INTO records (id,namespace,record_key,version,data) VALUES (?,?,?,1,?)").run(uuidv7(), PROJECT_INDEX_MANAGEMENT_NAMESPACE, "bad-key", JSON.stringify({ format: "unknown" })); }
      finally { db.close(); }
    }
    if (scenario === "missing-data") for (const suffix of ["", "-wal", "-shm"]) await fsp.rm(w.dataPath + suffix, { force: true });
    if (scenario === "other-worktree") {
      await w.cancelledRegistration();
      const service = await ProjectIndexService.open({ repositoryRoot: w.repo, dataRoot: w.dataRoot, repoId: w.identity.repoId, authorize: () => true });
      assert.equal((await service.init()).budget.stoppedReason, "complete");
    }
    const fresh = await w.provider(currentRoot), host = w.host(currentRoot).owner;
    const legacy = ["other-worktree", "legacy"].includes(scenario);
    await metadataOnly(current, async () => {
      // 精确 scope 来自生产身份计算，避免向协调器传入自填身份。
      const scope = await w.coordinator.baselineScope(currentRoot);
      const checks = [() => gate.validateRequest(old), () => fresh.captureFresh(), () => fresh.assertUnmanaged(),
        () => w.coordinator.assertUnmanagedBaseline(scope), () => host.captureUnmanaged(w.identity.repoId)];
      for (const check of checks) if (legacy) await check(); else await assert.rejects(check());
    });
    if (legacy) {
      const s = await sdkSession(current, fresh); await s.session.prompt("legacy");
      assert.equal((await fsp.readFile(join(currentRoot, "source.ts"), "utf8")), "SDK_WRITE");
      assert.equal(s.session.messages.find((m) => m.role === "toolResult").isError, false);
    } else {
      const s = await sdkSession(current, await w.provider(currentRoot));
      await s.session.prompt("registered or unknown");
      assert.equal(s.session.messages.find((m) => m.role === "toolResult").isError, true);
      assert.equal(s.hooks.gate.diagnostics.stale, true);
      assert.equal((await fsp.readFile(join(w.repo, "source.ts"), "utf8")), "ORIGINAL");
    }
    if (scenario === "unknown-record") {
      const db = new DatabaseSync(w.dataPath);
      try { db.prepare("DELETE FROM records WHERE namespace=? AND record_key='bad-key'").run(PROJECT_INDEX_MANAGEMENT_NAMESPACE); }
      finally { db.close(); }
      // 已观察到未知状态的同一消费者，不因记录消失便恢复旧权限。
      await assert.rejects(fresh.captureFresh()); await assert.rejects(fresh.assertUnmanaged());
      await assert.rejects(host.captureUnmanaged(w.identity.repoId));
    }
    records.push({ scenario, legacy, passed: true, unmanagedMetadataProjectBodyIO: 0, rpc: 0, grantValidations: 0, managers: 0 });
  } finally { await w.close(); }
}

// 在真实模型已开始后登记，旧 toolCall 必须拒绝；不是仅在请求准备时阻断。
{
  const w = await world();
  try {
    const s = await sdkSession(w, await w.provider(), () => w.cancelledRegistration());
    await s.session.prompt("old unmanaged");
    assert.equal(s.session.messages.find((m) => m.role === "toolResult").isError, true);
    assert.equal(await fsp.readFile(join(w.repo, "source.ts"), "utf8"), "ORIGINAL");
    assert.equal(fs.existsSync(w.indexPath), false);
    records.push({ scenario: "sdk-inflight-registration", passed: true });
  } finally { await w.close(); }
}
console.log(JSON.stringify({ node: process.version, execPath: process.execPath, mode, installed: false, records, cleaned: true }, null, 2));
