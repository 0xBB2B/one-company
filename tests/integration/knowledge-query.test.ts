import { expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { AssistantMessage, ToolCall } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import projectManageExtension, { activeProjectSyncController } from "../../extensions/project-manage.ts";
import knowledgeQueryExtension from "../../extensions/knowledge-query.ts";
import { createHostProjectBaselineProvider } from "../../extensions/project-baseline.ts";
import { installProjectBaselineHooks } from "../../runtime/project-baseline-hooks.ts";
import { connectDaemon } from "../../runtime/daemon-client.ts";
import { createClock } from "../../runtime/clock.ts";
import { repoDataDir } from "../../runtime/identity.ts";
import type { WindowContextValue } from "../../extensions/lifecycle.ts";
import type { KnowledgeFactPackage } from "../../runtime/knowledge-query.ts";
import { createDaemonFixture, removeDaemonFixture, resolveSdkDir, spawnDaemonProcess, waitForSocketReady } from "../helpers/daemon-harness.ts";
import { modelProviderEnv, writeTestModelProviders } from "../helpers/daemon-model-fixture.ts";
import { within } from "../helpers/m3-cleanup.ts";
import { BaselineFixture, deferred } from "../helpers/project-baseline-fixture.ts";
import { createKnowledgeQueryTool } from "../../runtime/knowledge-query-tool.ts";
import type { ProjectSyncController } from "../../runtime/project-sync-client.ts";

const queryName = "pi_company_knowledge_query";

test("真实SDK默认40并行只接纳32，结果释放名额后下一次调用成功", async () => {
  const f = await BaselineFixture.create(), home = await mkdtemp("/tmp/m4-query-sdk-budget-"); await chmod(home, 0o700);
  const repoId = "a".repeat(64), workspaceId = "b".repeat(64), snapshot = f.snapshot.bind(f);
  f.snapshot = async () => ({ ...await snapshot(), repoId, workspaceId });
  const barrier = deferred<void>();
  let pending = 0, peak = 0, entered = 0, timestamp = 0, live = true;
  let requested: ToolCall[] = Array.from({ length: 40 }, (_, i) => ({ type: "toolCall", id: `sdk-budget-${i}`, name: queryName, arguments: { repoId, query: { action: "facts" } } }));
  const controller = {
    binding: { repoId, windowId: "budget", sessionId: "budget" }, workspace: { repoId, workspaceId, root: f.root, branch: f.branch }, isActive: () => live,
    async knowledgeQuery() {
      pending++; entered++; peak = Math.max(peak, pending); if (entered === 32) barrier.resolve();
      await barrier.promise; pending--;
      const baseline = await f.snapshot();
      return { page: { format: "knowledge-facts/v1", facts: [], requirement: null } as unknown as KnowledgeFactPackage,
        assertLive() { if (!live) throw new Error("closed"); }, verify: () => f.assertCurrent(baseline) };
    },
  } as unknown as ProjectSyncController;
  const tool = createKnowledgeQueryTool({ controller: () => controller });
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  try {
    const runtime = await ModelRuntime.create({ authPath: join(home, "auth.json"), modelsPath: null, modelsStorePath: join(home, "models.json"), refreshOnCreate: false });
    runtime.registerProvider("query-budget", { apiKey: "fixture", baseUrl: "http://127.0.0.1:1", api: "anthropic-messages",
      models: [{ id: "controlled", name: "controlled", reasoning: false, input: ["text"], contextWindow: 100000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
      streamSimple(model, _context, options) {
        const calls = requested; requested = [];
        const stream = createAssistantMessageEventStream();
        const message: AssistantMessage = { role: "assistant", provider: model.provider, api: model.api, model: model.id, timestamp: ++timestamp,
          content: calls.length ? calls : [{ type: "text", text: "done" }], stopReason: calls.length ? "toolUse" : "stop",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        void (async () => { await options?.onPayload?.({ fixture: true }, model);
          stream.push({ type: "start", partial: { ...message, content: [], stopReason: "pending" } });
          stream.push({ type: "done", reason: calls.length ? "toolUse" : "stop", message });
        })().catch((error) => stream.push({ type: "error", reason: "error", error: { ...message, stopReason: "error", errorMessage: String(error) } }));
        return stream;
      },
    });
    const loader = new DefaultResourceLoader({ cwd: f.root, agentDir: home, settingsManager: SettingsManager.inMemory(), noExtensions: true,
      noSkills: true, noContextFiles: true, noThemes: true, noPromptTemplates: true, extensionFactories: [(pi) => {
        installProjectBaselineHooks(pi, { provider: f }); pi.registerTool(tool.tool);
        pi.on("tool_result", async (event, ctx) => {
          if (event.toolName !== queryName) return;
          try { const guard = await tool.checkResult(event.toolCallId, event.content, ctx); guard(); }
          catch { return { isError: true, content: [{ type: "text", text: "unavailable" }], details: {} }; }
        });
        pi.on("session_shutdown", () => tool.shutdown());
      }] });
    await loader.reload(); expect(loader.getExtensions().errors).toEqual([]);
    ({ session } = await createAgentSession({ cwd: f.root, agentDir: home, modelRuntime: runtime, model: runtime.getModels("query-budget")[0],
      resourceLoader: loader, sessionManager: SessionManager.inMemory(f.root), settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }), tools: [queryName] }));
    await session.bindExtensions({ mode: "rpc" });
    await session.prompt("40-call budget fixture", { source: "interactive" });
    const results = session.messages.filter((message) => message.role === "toolResult");
    expect(results).toHaveLength(40); expect(results.filter((message) => !message.isError)).toHaveLength(32);
    expect(results.filter((message) => message.isError)).toHaveLength(8);
    expect(entered).toBe(32); expect(peak).toBe(32); expect(pending).toBe(0); expect(tool.diagnostics.pending).toBe(0);
    requested = [{ type: "toolCall", id: "sdk-budget-recovered", name: queryName, arguments: { repoId, query: { action: "facts" } } }];
    await session.prompt("new call after budget release", { source: "interactive" });
    expect(session.messages.find((message) => message.role === "toolResult" && message.toolCallId === "sdk-budget-recovered")).toMatchObject({ isError: false });
    expect(tool.diagnostics.pending).toBe(0);
  } finally {
    barrier.resolve(); live = false;
    await session?.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" }); session?.dispose(); tool.shutdown();
    await f.close(); await rm(home, { recursive: true, force: true });
  }
}, 30_000);

test("真实SDK单一主入口注册knowledge工具且公开schema不含宿主能力", async () => {
  const fixture = await createDaemonFixture();
  try {
    const loader = new DefaultResourceLoader({ cwd: fixture.repo.root, agentDir: fixture.home.agentDir,
      settingsManager: SettingsManager.inMemory(), noExtensions: true, noSkills: true, noContextFiles: true, noThemes: true, noPromptTemplates: true,
      additionalExtensionPaths: [fileURLToPath(new URL("../../extensions/index.ts", import.meta.url))] });
    await loader.reload();
    expect(loader.getExtensions().errors).toEqual([]);
    const tool = loader.getExtensions().extensions[0]!.tools.get(queryName)!;
    expect(tool).toBeDefined();
    expect(JSON.stringify(tool.definition.parameters)).not.toMatch(/grantId|connectionId|windowId|sessionId|caller|dataRoot|role/);
  } finally { await removeDaemonFixture(fixture); }
}, 30_000);

test("真实SDK input→project_manage批准→独立daemon→knowledge→tool_result JSON及prod零读取", async () => {
  const f = await createDaemonFixture();
  f.repo.root = await realpath(f.repo.root); f.dataRoot = await realpath(f.dataRoot);
  await repoDataDir(f.dataRoot, f.repoId, f.repoDir);
  await mkdir(join(f.repo.root, "docs/spec"), { recursive: true });
  await mkdir(join(f.repo.root, "docs/prod"), { recursive: true });
  await copyFile(new URL("../../resources/spec/schema.json", import.meta.url), join(f.repo.root, "docs/spec/schema.json"));
  await writeFile(join(f.repo.root, "动作.ts"), 'export const 跳跃 = "角色跳跃\\\"\\n";\n');
  await writeFile(join(f.repo.root, "docs/spec/jump.rules.json"), JSON.stringify({ $schema: "schema.json", schemaVersion: 1,
    feature: { id: "jump", title: "角色跳跃", aliases: [] }, rules: Array.from({ length: 8 }, (_, index) => ({ id: `jump.once${index}`, title: "角色跳跃", condition: "在地面",
      trigger: "输入", expected: `角色跳跃${'"\\\t中文😀'.repeat(140)}`, reason: "只执行一次", dependsOn: [], exceptions: [], acceptance: [{ id: "once", given: "在地面", when: "输入", then: "角色跳跃" }] })) }));
  await writeFile(join(f.repo.root, "docs/prod/0197b7b0-6a20-7c51-8a32-b9465fb72d10.完成.md"), "角色跳跃SECRET_ARCHIVE_BODY", { mode: 0o000 });
  const probePath = join(f.home.home, "query-probe.json"), providerLog = join(f.home.home, "provider-log.jsonl");
  await writeFile(providerLog, "", { mode: 0o600 });
  const providers = await writeTestModelProviders(f.home.home, [{ providerId: "query-daemon", modelId: "controlled", roleName: "requirement-agent", replies: [{ type: "text", text: "not called" }] }]);
  const child = spawnDaemonProcess({ home: f.home, repoDir: f.repoDir, dataRoot: f.dataRoot, idleTimeoutMs: 120_000, captureOutput: true,
    extraEnv: { ...modelProviderEnv(providers, providerLog), NODE_OPTIONS: `--import=${fileURLToPath(new URL("../helpers/project-index-daemon-child.ts", import.meta.url))}`,
      M3_ASSEMBLY_PROBE: probePath, M3_ASSEMBLY_REPOSITORY: f.repo.root } });
  const clock = createClock();
  let shutdownHost: (() => Promise<void>) | undefined;
  let closeClient: (() => void) | undefined;
  try {
    await Promise.race([waitForSocketReady(f.socketPath), child.exited.then((exit) => { throw new Error(exit.stderr); })]);
    const sm = SessionManager.inMemory(f.repo.root), sessionId = sm.getSessionId(), windowId = randomUUID();
    const client = await connectDaemon({ repoDir: f.repo.root, dataRoot: f.dataRoot, sdkDir: resolveSdkDir(), clock,
      hello: { windowId, sessionId, pid: process.pid, cwd: f.repo.root, workspaceRoot: f.repo.root } });
    closeClient = () => client.close();
    expect((await client.call("hello")).daemonPid).toBe(child.proc.pid);
    const workspace = { repos: [{ path: f.repo.root, repoId: f.repoId, commonDir: f.repoDir }], skipped: [] };
    let live = true;
    const window: WindowContextValue = { windowId, sessionId, workspace, clients: {
      forRepo: (repoId) => repoId === f.repoId ? client : undefined, all: () => [client], skipped: () => [], workspace: () => workspace, closeAll: () => client.close(),
    } };
    const currentWindow = () => { if (!live) throw new Error("closed test window"); return window; };
    const baseline = createHostProjectBaselineProvider({ binding: { windowId, sessionId, repoId: f.repoId }, dataRoot: f.dataRoot });
    const runtime = await ModelRuntime.create({ authPath: join(f.home.agentDir, "query-auth.json"), modelsPath: null,
      modelsStorePath: join(f.home.agentDir, "query-models.json"), refreshOnCreate: false });
    let requested: ToolCall[] = [], counter = 0, approvals = 0, allow = true;
    let beforeResult: (() => Promise<void>) | undefined;
    const inputs: Array<{ source: string; text: string }> = [], modelInputs: string[] = [], extensionErrors: string[] = [];
    runtime.registerProvider("query-sdk", { apiKey: "fixture", baseUrl: "http://127.0.0.1:1", api: "anthropic-messages",
      models: [{ id: "controlled", name: "controlled", reasoning: false, input: ["text"], contextWindow: 100000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
      streamSimple(model, context, options) {
        modelInputs.push(JSON.stringify(context.messages));
        const calls = requested; requested = [];
        const stream = createAssistantMessageEventStream();
        const message: AssistantMessage = { role: "assistant", provider: model.provider, api: model.api, model: model.id, timestamp: ++counter,
          content: calls.length ? calls : [{ type: "text", text: "fixture" }], stopReason: calls.length ? "toolUse" : "stop",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        void (async () => {
          await options?.onPayload?.({ fixture: true }, model);
          stream.push({ type: "start", partial: { ...message, content: [], stopReason: "pending" } });
          stream.push({ type: "done", reason: calls.length ? "toolUse" : "stop", message });
        })().catch((error) => stream.push({ type: "error", reason: "error", error: { ...message, stopReason: "error", errorMessage: String(error) } }));
        return stream;
      },
    });
    const loader = new DefaultResourceLoader({ cwd: f.repo.root, agentDir: f.home.agentDir, settingsManager: SettingsManager.inMemory(),
      noExtensions: true, noSkills: true, noContextFiles: true, noThemes: true, noPromptTemplates: true, extensionFactories: [(pi) => {
        projectManageExtension(pi, { dataRoot: f.dataRoot, windowReady: async () => currentWindow(), windowContext: currentWindow });
        installProjectBaselineHooks(pi, { provider: baseline, disposeProvider: () => baseline.dispose() });
        pi.on("input", (event) => { inputs.push({ source: event.source, text: event.text }); });
        // 确定SDK结果钩子竞争点；发生真实文件写入，不伪造current返回。
        pi.on("tool_result", async (event) => { if (event.toolName === queryName) { const once = beforeResult; beforeResult = undefined; await once?.(); } });
        knowledgeQueryExtension(pi, { windowContext: currentWindow });
      }] });
    await loader.reload(); expect(loader.getExtensions().errors).toEqual([]);
    const { session } = await createAgentSession({ cwd: f.repo.root, agentDir: f.home.agentDir, modelRuntime: runtime,
      model: runtime.getModels("query-sdk")[0], resourceLoader: loader, sessionManager: sm,
      settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }), tools: ["pi_company_project_manage", queryName] });
    await session.bindExtensions({ mode: "rpc", uiContext: { confirm: async () => { approvals++; return allow; }, notify: () => {}, setStatus: () => {}, setWidget: () => {} } as unknown as ExtensionUIContext,
      onError: (event) => { extensionErrors.push(event.error); } });
    shutdownHost = async () => { live = false; await session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" }); session.dispose(); };
    let id = 0;
    const run = async (name: string, args: Record<string, unknown>, prompt = "查询当前项目") => {
      const callId = `query-call-${++id}`;
      requested = [{ type: "toolCall", id: callId, name, arguments: args }];
      await session.prompt(prompt, { source: "interactive" });
      const result = session.messages.find((message) => message.role === "toolResult" && message.toolCallId === callId);
      expect(result).toBeDefined();
      if (!result || result.role !== "toolResult") throw new Error("missing result");
      return result;
    };
    expect((await run(queryName, { repoId: f.repoId, query: { action: "facts" } })).isError).toBe(true);
    allow = false;
    expect((await run("pi_company_project_manage", { repoId: f.repoId, action: "init" }, "先不要批准扫描")).isError).toBe(true);
    allow = true;
    expect((await run("pi_company_project_manage", { repoId: f.repoId, action: "init" }, "批准本窗口扫描当前仓库")).isError).toBe(false);
    const pages: KnowledgeFactPackage[] = [];
    let cursor: string | undefined;
    do {
      const result = await run(queryName, { repoId: f.repoId, query: { action: "search", text: "角色跳跃", pageSize: 20, maxBytes: 24576, ...(cursor ? { cursor } : {}) } });
      expect(result.isError, JSON.stringify(result)).toBe(false);
      expect(Buffer.byteLength(JSON.stringify({ content: result.content }))).toBeLessThanOrEqual(51200);
      const first = result.content[0]!;
      if (first.type !== "text") throw new Error("not text");
      const page = JSON.parse(first.text) as KnowledgeFactPackage; pages.push(page); cursor = page.nextCursor ?? undefined;
      expect(result.details).toEqual({});
    } while (cursor);
    const rules = pages.flatMap((page) => page.facts).filter((fact) => fact.kind === "rule");
    expect(rules).toHaveLength(8);
    expect(rules.every((fact) => fact.complete && (fact.data as { expected: string }).expected === `角色跳跃${'"\\\t中文😀'.repeat(140)}`)).toBe(true);
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.flatMap((page) => page.facts).some((fact) => fact.kind === "source" && fact.source.path === "动作.ts")).toBe(true);
    expect(pages[0]).toMatchObject({ requirement: null, limitations: { performanceImprovement: "unknown", formalVerification: "not_available" } });
    expect(approvals).toBe(2); // 一次拒绝、一次批准；查询不重新审批。
    const controller = activeProjectSyncController({ windowId, sessionId, repoId: f.repoId })!;
    const delayed = await controller.knowledgeQuery!({ action: "facts", pageSize: 1 });
    const old = await stat(join(f.repo.root, "动作.ts"));
    await writeFile(join(f.repo.root, "动作.ts"), 'export const 跳跃 = "角色快跑\\\"\\n";\n');
    await utimes(join(f.repo.root, "动作.ts"), old.atime, old.mtime);
    await expect(delayed.verify()).rejects.toThrow();
    beforeResult = async () => { await writeFile(join(f.repo.root, "new.ts"), "export const 新文件 = 1;\n"); };
    expect((await run(queryName, { repoId: f.repoId, query: { action: "facts" } })).isError).toBe(true);
    await writeFile(join(f.repo.root, "docs/spec/jump.rules.json"), "{INVALID}");
    const invalid = await run(queryName, { repoId: f.repoId, query: { action: "facts" } });
    expect(invalid.isError, JSON.stringify(invalid)).toBe(false);
    expect(JSON.parse((invalid.content[0] as { text: string }).text)).toMatchObject({ specStatus: "invalid", indexStatus: "invalid", facts: [] });
    const last = await controller.knowledgeQuery!({ action: "facts" });
    await rm(join(f.repo.root, "docs/spec/jump.rules.json"));
    await writeFile(join(f.repo.root, "动作.ts"), 'export const 跳跃 = "SDK_UNDELIVERED_RACE_BODY";\n');
    const query = controller.knowledgeQuery!.bind(controller); let verifyCount = 0;
    controller.knowledgeQuery = async (...args) => {
      const delivery = await query(...args);
      expect(JSON.stringify(delivery.page)).toContain("SDK_UNDELIVERED_RACE_BODY");
      return { ...delivery, verify: async (signal) => {
        await delivery.verify(signal);
        if (++verifyCount === 2) queueMicrotask(() => queueMicrotask(() => client.close()));
      } };
    };
    const raced = await run(queryName, { repoId: f.repoId, query: { action: "exact", by: "path", value: "动作.ts" } });
    expect(verifyCount).toBe(2); expect(controller.isActive()).toBe(false);
    expect(raced.isError).toBe(true);
    expect(JSON.stringify(raced.content)).not.toContain("SDK_UNDELIVERED_RACE_BODY");
    expect(modelInputs.join("")).not.toContain("SDK_UNDELIVERED_RACE_BODY");
    await expect(last.verify()).rejects.toThrow();
    await expect(controller.knowledgeQuery!({ action: "facts", cursor: delayed.page.nextCursor })).rejects.toThrow();
    expect(inputs.some((event) => event.source === "interactive" && event.text === "批准本窗口扫描当前仓库")).toBe(true);
    expect(modelInputs.join("")).not.toContain("SECRET_ARCHIVE_BODY");
    expect(await readFile(providerLog, "utf8")).toBe("");
    expect(extensionErrors).toEqual([]);
    await shutdownHost(); shutdownHost = undefined;
    child.proc.kill("SIGTERM");
    const exit = await within(() => child.exited, "query daemon close", 15000);
    expect(exit, exit.stderr).toMatchObject({ code: 0, signal: null });
    const probe = JSON.parse(await readFile(probePath, "utf8"));
    expect(probe).toMatchObject({ forbiddenReads: 0, watchers: 0, exited: true, node: process.execPath });
    expect(probe.createdWatchers).toBe(probe.closeEvents);
    const evidence = { node: process.execPath, nodeVersion: process.version, daemonPid: child.proc.pid,
      daemonExit: exit.code, forbiddenReads: probe.forbiddenReads, createdWatchers: probe.createdWatchers, closeEvents: probe.closeEvents,
      approvals, sdkInputEvents: inputs.length, pages: pages.length, generations: pages.map((page) => page.generation),
      contentBytes: pages.map((page) => Buffer.byteLength(JSON.stringify({ content: [{ type: "text", text: JSON.stringify(page) }] }))),
      model: "query-sdk/controlled (local deterministic fixture, no external model)", daemonProviderCalls: 0 };
    const evidenceDirectory = process.env.M4_QUERY_EVIDENCE_DIRECTORY;
    if (evidenceDirectory) {
      const mode = await stat(evidenceDirectory);
      if (!mode.isDirectory() || mode.mode & 0o077) throw new Error("证据目录必须私有");
      await writeFile(join(evidenceDirectory, "assembly-evidence.json"), JSON.stringify(evidence, null, 2), { mode: 0o600 });
    }
  } finally {
    try { await shutdownHost?.(); }
    finally {
      closeClient?.(); clock.stopGapWatcher();
      if (child.proc.exitCode === null && child.proc.signalCode === null) child.proc.kill("SIGTERM");
      await within(() => child.exited, "query daemon final close", 15000);
      await removeDaemonFixture(f);
    }
  }
}, 180_000);
