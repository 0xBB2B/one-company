import { afterEach, expect, test } from "vitest";
import { chmod, lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import { relative, join } from "node:path";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { AssistantMessage, ToolCall } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ProjectBaselineHooks, installProjectBaselineHooks, projectBaselineForContext, OLD_PROJECT_SNAPSHOT } from "../runtime/project-baseline-hooks.ts";
import { createProtectedFileTools } from "../extensions/write-protection.ts";
import { createManagedBashTool } from "../runtime/shell-bash.ts";
import { ShellRegistry } from "../runtime/shell-registry.ts";
import { createClock } from "../runtime/clock.ts";
import { BaselineFixture, deferred } from "./helpers/project-baseline-fixture.ts";
import { createFakePi } from "./helpers/fake-pi.ts";

const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const message = (id: number, content: AssistantMessage["content"] = []): AssistantMessage => ({ role: "assistant", api: "anthropic-messages",
  provider: "baseline-fixture", model: "slow-model", timestamp: id, content, stopReason: content.some((c) => c.type === "toolCall") ? "toolUse" : "stop",
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
const call = (id: string, name: string, args: Record<string, unknown>): ToolCall => ({ type: "toolCall", id, name, arguments: args });
async function fixture() { const f = await BaselineFixture.create(); cleanup.push(() => f.close()); return f; }

async function sdk(f: BaselineFixture, options: { preflight?: () => Promise<void>; slow?: () => Promise<void>; afterRead?: () => Promise<void>; checkWrite?: (path: string) => Promise<void> } = {}) {
  const home = await mkdtemp("/tmp/m3-sdk-gate-home-"); await chmod(home, 0o700);
  cleanup.push(() => rm(home, { recursive: true, force: true }));
  const runtime = await ModelRuntime.create({ authPath: join(home, "auth.json"), modelsPath: null, modelsStorePath: join(home, "models-store.json"), refreshOnCreate: false });
  const queue: AssistantMessage[] = [];
  let requests = 0;
  let payloads = 0;
  const modelInputs: string[] = [];
  runtime.registerProvider("baseline-fixture", { apiKey: "fixture", baseUrl: "http://127.0.0.1:1", api: "anthropic-messages",
    models: [{ id: "slow-model", name: "slow-model", reasoning: false, input: ["text"], contextWindow: 100000, maxTokens: 1024,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple(model, context, opts) {
      modelInputs.push(JSON.stringify(context.messages));
      const stream = createAssistantMessageEventStream();
      const final = queue.shift() ?? message(++requests + 1000, [{ type: "text", text: "done" }]);
      requests++;
      void (async () => {
        // 模型传输替身显式经过 SDK onPayload；不访问外部 LLM。
        await opts?.onPayload?.({ fixture: true }, model); payloads++;
        stream.push({ type: "start", partial: { ...final, content: [], stopReason: "pending" } });
        if (requests === 1) await options.slow?.();
        stream.push({ type: "done", reason: final.stopReason === "toolUse" ? "toolUse" : "stop", message: final });
      })().catch((error) => stream.push({ type: "error", reason: "error", error: { ...final, stopReason: "error", errorMessage: String(error) } }));
      return stream;
    },
  });
  let hooks!: ProjectBaselineHooks;
  let writesChecked = 0;
  let providerResolutions = 0;
  const loader = new DefaultResourceLoader({ cwd: f.root, agentDir: home, noExtensions: true, noSkills: true, noPromptTemplates: true,
    noThemes: true, agentsFilesOverride: () => ({ agentsFiles: [] }), extensionFactories: [(pi: ExtensionAPI) => {
      hooks = installProjectBaselineHooks(pi, { provider: async (ctx) => { providerResolutions++; expect(ctx.cwd).toBe(f.root); return f; },
        checkPath: async (path) => relative(f.root, path) });
      const [write, edit] = createProtectedFileTools(async () => ({ checkWrite: async (path) => { writesChecked++; await options.checkWrite?.(path); return { ok: true as const }; } }));
      pi.registerTool(write); pi.registerTool(edit);
      pi.on("tool_call", async () => { await options.preflight?.(); });
      pi.on("turn_end", async (event) => { if (event.toolResults.some((result) => result.toolName === "read")) await options.afterRead?.(); });
    }] });
  await loader.reload();
  const { session } = await createAgentSession({ cwd: f.root, agentDir: home, modelRuntime: runtime, model: runtime.getModels("baseline-fixture")[0],
    resourceLoader: loader, sessionManager: SessionManager.inMemory(f.root), settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }), tools: ["read", "write", "edit"] });
  cleanup.push(() => { hooks.dispose(); session.dispose(); });
  return { session, hooks, queue, modelInputs, payloads: () => payloads, writesChecked: () => writesChecked, providerResolutions: () => providerResolutions };
}

async function publishDuringCapture(f: BaselineFixture): Promise<void> {
  f.sequence++;
  const snapshot = await f.snapshot();
  for (const listener of f.listeners) listener({ reason: "reconciled_change", source: "read_before",
    observedSequence: f.sequence, path: null, eventType: null, requiresFullReconcile: true,
    archiveMetadataOnly: false, baselineHash: snapshot.baselineHash,
    repoId: snapshot.repoId, workspaceId: snapshot.workspaceId, authorityEpoch: snapshot.authorityEpoch });
}

test("模型发送前的准备遇到已知发布通知中止，仅有限重做新准备", async () => {
  const f = await fixture();
  const hooks = new ProjectBaselineHooks({ provider: f }); cleanup.push(() => hooks.dispose());
  f.captureHook = async (signal) => {
    if (f.captures === 1) { await f.write("b.ts", "CURRENT"); await publishDuringCapture(f); }
    signal?.throwIfAborted();
    return { kind: "fresh", snapshot: await f.snapshot() };
  };
  const request = await hooks.beginRequest();
  expect(f.captures).toBe(2);
  expect(request.kind).toBe("managed");
  expect(request.origin?.observedSequence).toBe(f.sequence);
  await hooks.beforeProviderRequest();
  const answer = message(900, [call("prepared-current", "write", { path: "a.ts", content: "next" })]);
  hooks.messageStart(answer); expect(await hooks.messageEnd(answer)).toBe(true);
  expect(await hooks.assertCall("prepared-current")).toBe(request);
});

test("准备期间持续发布最多尝试三次，不在发送模型后自动更新基础", async () => {
  const f = await fixture();
  const hooks = new ProjectBaselineHooks({ provider: f }); cleanup.push(() => hooks.dispose());
  f.captureHook = async (signal) => { await publishDuringCapture(f); signal?.throwIfAborted(); return { kind: "fresh", snapshot: await f.snapshot() }; };
  await expect(hooks.beginRequest()).rejects.toMatchObject({ code: "unavailable" });
  expect(f.captures).toBe(3);
  await expect(hooks.beforeProviderRequest()).rejects.toMatchObject({ code: "stale" });
  expect(f.captures).toBe(3);
});

test.each(["watch", "disconnected", "unknown"])("准备期间%s失效不自动重试或恢复权限", async (reason) => {
  const f = await fixture();
  const hooks = new ProjectBaselineHooks({ provider: f }); cleanup.push(() => hooks.dispose());
  f.captureHook = async (signal) => { f.notify(reason); signal?.throwIfAborted(); return { kind: "fresh", snapshot: await f.snapshot() }; };
  await expect(hooks.beginRequest()).rejects.toBeDefined(); expect(f.captures).toBe(1);
});

test("发布通知同时显式撤权，不能借准备重试重新签发", async () => {
  const f = await fixture();
  const hooks = new ProjectBaselineHooks({ provider: f }); cleanup.push(() => hooks.dispose());
  f.captureHook = async (signal) => { await publishDuringCapture(f); hooks.revoke(); signal?.throwIfAborted(); return { kind: "fresh", snapshot: await f.snapshot() }; };
  await expect(hooks.beginRequest()).rejects.toBeDefined(); expect(f.captures).toBe(1);
});

test("before_provider_request遇到发布失效仍拒绝，不能调用准备重试换绑", async () => {
  const f = await fixture();
  const hooks = new ProjectBaselineHooks({ provider: f }); cleanup.push(() => hooks.dispose());
  await hooks.beginRequest();
  f.assertHook = async () => { await publishDuringCapture(f); };
  await expect(hooks.beforeProviderRequest()).rejects.toMatchObject({ code: "stale" });
  expect(f.captures).toBe(1);
});

test("真实 SDK context捕获失败被吞后，工具仍拒绝；失败提醒固定且无底层正文", async () => {
  const f = await fixture(); f.captureFailure = true;
  const s = await sdk(f);
  s.queue.push(message(1, [call("w1", "write", { path: "a.ts", content: "BAD" })]));
  await s.session.prompt("fixture");
  expect(await readFile(join(f.root, "a.ts"), "utf8")).toBe("A");
  expect(s.session.messages.find((m) => m.role === "toolResult")).toMatchObject({ isError: true });
  expect(JSON.stringify(s.session.messages)).toContain(OLD_PROJECT_SNAPSHOT);
  expect(JSON.stringify(s.session.messages)).not.toContain("private failure");
  expect(s.payloads()).toBeGreaterThan(0);
  expect(s.providerResolutions()).toBe(1);
});

test("真实 SDK 批量tool_call预检后外改，实际write/edit入口二次拒绝", async () => {
  const f = await fixture(); let preflights = 0;
  const s = await sdk(f, { preflight: async () => { if (++preflights === 2) await f.write("b.ts", "EXTERNAL"); } });
  s.queue.push(message(2, [call("w2", "write", { path: "a.ts", content: "BAD" }),
    call("e2", "edit", { path: "b.ts", edits: [{ oldText: "B", newText: "BAD" }] })]));
  await s.session.prompt("fixture");
  expect(await readFile(join(f.root, "a.ts"), "utf8")).toBe("A");
  expect(await readFile(join(f.root, "b.ts"), "utf8")).toBe("EXTERNAL");
  expect(s.session.messages.filter((m) => m.role === "toolResult").every((m) => m.isError)).toBe(true);
  expect(s.writesChecked()).toBeGreaterThan(0);
});

test("真实 SDK 同批精确自写推进executionHead；SDK edit保留BOM和CRLF", async () => {
  const f = await fixture(); await f.write("a.ts", "\ufeffA\r\n");
  const s = await sdk(f);
  s.queue.push(message(3, [call("e3", "edit", { path: "a.ts", edits: [{ oldText: "A", newText: "NEW" }] }),
    call("w3", "write", { path: "b.ts", content: "SECOND" })]));
  await s.session.prompt("fixture");
  expect(await readFile(join(f.root, "a.ts"), "utf8")).toBe("\ufeffNEW\r\n");
  expect(await readFile(join(f.root, "b.ts"), "utf8")).toBe("SECOND");
  expect(s.session.messages.filter((m) => m.role === "toolResult").every((m) => !m.isError)).toBe(true);
});

test("真实SDK 新建目录记录严格父目录，mkdir后的撤权阻止文件落盘", async () => {
  const f = await BaselineFixture.create(true); cleanup.push(() => f.close());
  let revoked = false;
  const s = await sdk(f, { checkWrite: async (path) => {
    if (path !== join(f.root, "new/nested/file.ts")) return;
    if (await lstat(join(f.root, "new/nested")).then(() => true, () => false)) { revoked = true; f.notify(); }
  } });
  const records: string[][] = [];
  const mutate = s.hooks.withMutation.bind(s.hooks);
  s.hooks.withMutation = (id, mutation, operation) => { records.push([...(mutation.expectedDirectories ?? [])]); return mutate(id, mutation, operation); };
  s.queue.push(message(410, [call("new-revoked", "write", { path: "new/nested/file.ts", content: "BAD" })]));
  await s.session.prompt("fixture");
  expect(revoked).toBe(true);
  expect(records).toEqual([["new/nested", "new"]]);
  expect((await lstat(join(f.root, "new/nested"))).isDirectory()).toBe(true);
  await expect(readFile(join(f.root, "new/nested/file.ts"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(s.session.messages.find((m) => m.role === "toolResult")).toMatchObject({ isError: true });
});

test("真实SDK 无监听替身的新目录精确写入与同父目录同批写入均保留", async () => {
  const f = await BaselineFixture.create(true); cleanup.push(() => f.close()); const s = await sdk(f);
  s.queue.push(message(412, [call("dir-first", "write", { path: "new/nested/first.ts", content: "FIRST" }),
    call("dir-second", "write", { path: "new/nested/second.ts", content: "SECOND" })]));
  await s.session.prompt("fixture");
  expect(await readFile(join(f.root, "new/nested/first.ts"), "utf8")).toBe("FIRST");
  expect(await readFile(join(f.root, "new/nested/second.ts"), "utf8")).toBe("SECOND");
  expect(s.session.messages.filter((m) => m.role === "toolResult").every((m) => !m.isError)).toBe(true);
});

test("真实SDK 精确自写后下一请求标已核实自身写入，而非外部/未知失效", async () => {
  const f = await fixture(); const s = await sdk(f);
  s.queue.push(message(411, [call("own-notice", "write", { path: "a.ts", content: "OWN" })]));
  await s.session.prompt("fixture");
  expect(s.modelInputs[1]).toContain("verified_own_write");
  expect(s.modelInputs[1]).not.toContain("external_or_unknown");
  expect(s.modelInputs[1]).toContain((await f.snapshot()).baselineHash);
});

test("真实 SDK 慢传输中外改标旧快照，旧消息无法绑定工具；下一请求才取得新基线", async () => {
  const f = await fixture(); const started = deferred<void>(); const release = deferred<void>();
  const s = await sdk(f, { slow: async () => { started.resolve(); await release.promise; } });
  s.queue.push(message(4, [call("w4", "write", { path: "a.ts", content: "BAD" })]));
  const run = s.session.prompt("fixture"); await started.promise;
  await f.write("b.ts", "EXTERNAL"); f.notify(); release.resolve(); await run;
  expect(await readFile(join(f.root, "a.ts"), "utf8")).toBe("A");
  expect(JSON.stringify(s.session.messages)).toContain(OLD_PROJECT_SNAPSHOT);
});

test.each([true, false])("真实SDK read返回后外改（通知=%s），下一模型请求含旧资料提醒和当前hash", async (notified) => {
  const f = await fixture();
  const s = await sdk(f, { afterRead: async () => { await f.write("a.ts", "EXTERNAL_NEW_BODY"); if (notified) f.notify(); } });
  s.queue.push(message(501, [call("read-gap", "read", { path: "a.ts" })]));
  await s.session.prompt("fixture");
  expect(s.session.messages.find((m) => m.role === "toolResult")).toMatchObject({ isError: false, content: [{ type: "text", text: "A" }] });
  expect(s.modelInputs).toHaveLength(2);
  expect(s.modelInputs[1]).toContain("旧快照");
  expect(s.modelInputs[1]).toContain("external_or_unknown");
  expect(s.modelInputs[1]).toContain((await f.snapshot()).baselineHash);
  expect(s.modelInputs[1]).toContain("workspace");
  expect(s.modelInputs[1]).not.toContain("EXTERNAL_NEW_BODY");
  expect(s.hooks.gate.diagnostics.stale).toBe(false);
});

test("真实SDK plain消息封存绑定原对象、内容和request；clone/改写/旧seal拒绝", async () => {
  const f = await fixture(); const s = await sdk(f);
  s.queue.push(message(601, [{ type: "text", text: "plain plan" }]));
  await s.session.prompt("fixture");
  const actual = s.session.messages.find((m) => m.role === "assistant")!;
  const request = await s.hooks.assertMessage(actual);
  expect(request.kind).toBe("managed");
  const seal = await s.hooks.sealMessage(actual);
  expect((await s.hooks.assertDelivery(seal)).messageId).toBeTypeOf("string");
  expect(seal.metadata).not.toHaveProperty("callId");
  await expect(s.hooks.assertMessage(structuredClone(actual))).rejects.toMatchObject({ code: "stale" });
  actual.content.push({ type: "text", text: "tampered" });
  await expect(s.hooks.assertMessage(actual)).rejects.toMatchObject({ code: "stale" });
  actual.content.pop();
  await s.hooks.beginRequest();
  await expect(s.hooks.sealMessage(actual)).rejects.toMatchObject({ code: "stale" });
  await expect(s.hooks.assertDelivery(seal)).rejects.toMatchObject({ code: "invalid_seal" });
});

test("消息封存期间实际消息被改写，不能交付已不匹配的消息seal", async () => {
  const f = await fixture(); const h = new ProjectBaselineHooks({ provider: f }); cleanup.push(() => h.shutdown());
  await h.beginRequest(); await h.beforeProviderRequest();
  const actual = message(603, [{ type: "text", text: "original" }]); h.messageStart(actual); expect(await h.messageEnd(actual)).toBe(true);
  let assertions = 0;
  f.assertHook = async () => { if (++assertions === 2) actual.content.push({ type: "text", text: "late replacement" }); };
  await expect(h.sealMessage(actual)).rejects.toMatchObject({ code: "stale" });
});

test("消息封存拒绝未完成、伪消息及busy；合法未管理消息明确返回kind", async () => {
  const f = await fixture(); const h = new ProjectBaselineHooks({ provider: f }); cleanup.push(() => h.shutdown());
  await h.beginRequest(); await h.beforeProviderRequest();
  const actual = message(602, [{ type: "text", text: "plain" }]); h.messageStart(actual);
  await expect(h.assertMessage(actual)).rejects.toMatchObject({ code: "stale" });
  expect(await h.messageEnd(actual)).toBe(true);
  const request = await h.assertMessage(actual);
  h.gate.bindCalls(["message-busy"], request);
  const entered = deferred<void>(), release = deferred<void>();
  const operation = h.withMutation("message-busy", { paths: [] }, async () => { entered.resolve(); await release.promise; });
  await entered.promise;
  try { await expect(h.sealMessage(actual)).rejects.toMatchObject({ code: "busy" }); }
  finally { release.resolve(); await operation; }
  const legacy = await fixture(); legacy.unmanaged = true;
  const l = new ProjectBaselineHooks({ provider: legacy }); cleanup.push(() => l.shutdown());
  await l.beginRequest(); await l.beforeProviderRequest(); l.messageStart(actual); expect(await l.messageEnd(actual)).toBe(true);
  expect((await l.assertMessage(actual)).kind).toBe("unmanaged");
  await expect(l.sealMessage(actual)).rejects.toMatchObject({ code: "unmanaged" });
});

test.each([false, true])("模型名不同但稳定身份重复仍拒绝（原消息已结束=%s）", async (completed) => {
  const f = await fixture(); const h = new ProjectBaselineHooks({ provider: f }); cleanup.push(() => h.shutdown());
  await h.beginRequest(); await h.beforeProviderRequest();
  const original = message(604, [{ type: "text", text: "original" }]); h.messageStart(original);
  if (completed) {
    expect(await h.messageEnd(original)).toBe(true);
    await h.beginRequest(); await h.beforeProviderRequest();
  }
  const duplicate = { ...original, model: "different-model", content: [call("duplicate-identity", "write", {})] };
  h.messageStart(duplicate);
  expect(await h.messageEnd(duplicate)).toBe(false);
  expect(await h.messageEnd(original)).toBe(false);
  await expect(h.assertCall("duplicate-identity")).rejects.toMatchObject({ code: "stale" });
  await expect(h.sealMessage(original)).rejects.toMatchObject({ code: "stale" });
});

test("别名消息未结束时重叠新请求仍busy，改名end不能消除并发歧义或重捕获", async () => {
  const f = await fixture(); const h = new ProjectBaselineHooks({ provider: f }); cleanup.push(() => h.shutdown());
  await h.beginRequest(); await h.beforeProviderRequest();
  const old = message(605, [call("overlapped-alias", "write", {})]); h.messageStart(old);
  const captures = f.captures;
  await expect(h.beginRequest()).rejects.toMatchObject({ code: "busy" });
  expect(await h.messageEnd({ ...old, model: "canonical-model" })).toBe(false);
  await expect(h.assertCall("overlapped-alias")).rejects.toMatchObject({ code: "stale" });
  await expect(h.beginRequest()).rejects.toMatchObject({ code: "busy" });
  expect(f.captures).toBe(captures);
});

test("迟到旧assistant不得借新request恢复；shutdown释放订阅", async () => {
  const f = await fixture(); const h = new ProjectBaselineHooks({ provider: f }); cleanup.push(() => h.dispose());
  await h.beginRequest(); await h.beforeProviderRequest(); const old = message(10, [call("old", "write", {})]); h.messageStart(old);
  expect(await h.messageEnd(old)).toBe(true);
  await h.beginRequest(); await h.beforeProviderRequest(); const next = message(11, [call("next", "write", {})]); h.messageStart(next);
  expect(await h.messageEnd(old)).toBe(false); expect(await h.messageEnd(next)).toBe(true);
  await expect(h.assertCall("old")).rejects.toMatchObject({ code: "stale" });
  const seal = await h.sealResult("next"); expect((await h.assertDelivery(seal)).callId).toBe("next");
  const ctx = { sessionManager: {} } as Pick<ExtensionContext, "sessionManager">;
  h.bindContext(ctx); h.dispose(); expect(f.listeners.size).toBe(0);
  expect(projectBaselineForContext(ctx)).toBe(h);
  await expect(h.assertCall("next")).rejects.toMatchObject({ code: "stale" });
  await expect(h.assertDelivery(seal)).rejects.toMatchObject({ code: "invalid_seal" });
  await h.shutdown();
});

test("provider(ctx)迟到返回也被shutdown回收；同步撤权先于异步清理", async () => {
  const f = await fixture(); const entered = deferred<void>(), release = deferred<void>(), cleanupRelease = deferred<void>();
  const fake = createFakePi(); let disposed = 0;
  const ctx = { cwd: f.root, sessionManager: {}, hasUI: false } as ExtensionContext;
  const hooks = installProjectBaselineHooks(fake.pi as unknown as ExtensionAPI, {
    provider: async (actual) => { expect(actual).toBe(ctx); entered.resolve(); await release.promise; return f; },
    disposeProvider: async (actual) => { expect(actual).toBe(f); disposed++; await cleanupRelease.promise; },
  });
  const capture = fake.trigger("context", { messages: [] }, ctx); await entered.promise;
  const shutdown = hooks.shutdown(); expect(hooks.gate.diagnostics.closed).toBe(true);
  release.resolve(); await capture;
  cleanupRelease.resolve(); await shutdown;
  expect(disposed).toBe(1); expect(f.listeners.size).toBe(0);
  await hooks.shutdown(); expect(disposed).toBe(1);
});

test("未结束旧流与新context重叠时明确拒绝，不用新request给迟到message_start续权", async () => {
  const f = await fixture(); const h = new ProjectBaselineHooks({ provider: f }); cleanup.push(() => h.dispose());
  await h.beginRequest(); await h.beforeProviderRequest();
  await expect(h.beginRequest()).rejects.toMatchObject({ code: "busy" });
  const late = message(99, [call("late-start", "write", {})]); h.messageStart(late);
  expect(await h.messageEnd(late)).toBe(false);
  await expect(h.assertCall("late-start")).rejects.toMatchObject({ code: "stale" });
});

test("before_provider_request只复核原request，外改不以capture刷新偷换", async () => {
  const f = await fixture(); const h = new ProjectBaselineHooks({ provider: f }); cleanup.push(() => h.dispose());
  await h.beginRequest(); const captures = f.captures;
  await f.write("a.ts", "EXTERNAL");
  await expect(h.beforeProviderRequest()).rejects.toMatchObject({ code: "stale" });
  expect(f.captures).toBe(captures);
});

test("真实SDK精确自写后混入外部写，首个实际结果保留但同批后续写拒绝", async () => {
  const f = await fixture(); const s = await sdk(f);
  f.captureHook = async () => {
    if (await readFile(join(f.root, "a.ts"), "utf8") === "OWN") await f.write("b.ts", "EXTERNAL");
    return { kind: "fresh", snapshot: await f.snapshot() };
  };
  s.queue.push(message(100, [call("mixed1", "write", { path: "a.ts", content: "OWN" }),
    call("mixed2", "write", { path: "b.ts", content: "BAD" })]));
  await s.session.prompt("fixture");
  expect(await readFile(join(f.root, "a.ts"), "utf8")).toBe("OWN");
  expect(await readFile(join(f.root, "b.ts"), "utf8")).toBe("EXTERNAL");
  const results = s.session.messages.filter((m) => m.role === "toolResult");
  expect(results[0]).toMatchObject({ isError: false }); expect(results[1]).toMatchObject({ isError: true });
});

test("真实Shell guard.launch后外改，actual spawn前拒绝，注册表无进程", async () => {
  const f = await fixture(); const h = new ProjectBaselineHooks({ provider: f }); cleanup.push(() => h.dispose());
  await h.beginRequest(); await h.beforeProviderRequest(); const m = message(12, [call("shell", "bash", {})]); h.messageStart(m); expect(await h.messageEnd(m)).toBe(true);
  const clock = createClock(); cleanup.push(() => clock.stopGapWatcher()); const registry = new ShellRegistry({ clock });
  const tool = createManagedBashTool({ cwd: f.root, registry, host: { kind: "main", id: "fixture" }, runToken: "fixture", baseline: h,
    guard: { before: async () => ({}), after: async () => [], launch: async () => { await f.write("b.ts", "EXTERNAL"); return { command: "/bin/sh", args: ["-c", "printf BAD > a.ts"] }; } } });
  await expect(tool.execute("shell", { command: "printf BAD > a.ts" }, undefined, undefined, undefined!)).rejects.toThrow();
  expect(registry.list()).toEqual([]); expect(await readFile(join(f.root, "a.ts"), "utf8")).toBe("A");
});

test("未管理legacy后台寿命不阻塞下一请求；不能签发受管理seal", async () => {
  const f = await fixture(); f.unmanaged = true;
  const h = new ProjectBaselineHooks({ provider: f }); cleanup.push(() => h.shutdown());
  await h.beginRequest(); await h.beforeProviderRequest();
  const m = message(140, [call("legacy-shell", "bash", {})]); h.messageStart(m); expect(await h.messageEnd(m)).toBe(true);
  const entered = deferred<void>(), release = deferred<void>();
  const shell = h.runShell("legacy-shell", f.root, async () => { entered.resolve(); await release.promise; return "finished"; });
  await entered.promise;
  expect((await h.beginRequest()).kind).toBe("unmanaged"); await h.beforeProviderRequest();
  const next = message(141, [call("legacy-result", "result", {})]); h.messageStart(next); expect(await h.messageEnd(next)).toBe(true);
  await expect(h.sealResult("legacy-result")).rejects.toMatchObject({ code: "unmanaged" });
  release.resolve(); expect(await shell).toBe("finished");
});

test("真实后台Shell立即回执，未结束seal拒绝；新请求不杀后台也不捕获写入中现场", async () => {
  const f = await fixture(); const h = new ProjectBaselineHooks({ provider: f }); cleanup.push(() => h.dispose());
  await h.beginRequest(); await h.beforeProviderRequest(); const m = message(13, [call("bg", "bash", {})]); h.messageStart(m); expect(await h.messageEnd(m)).toBe(true);
  const clock = createClock(); cleanup.push(() => clock.stopGapWatcher()); const registry = new ShellRegistry({ clock });
  cleanup.push(async () => { await registry.stopHost({ kind: "main", id: "fixture" }); });
  const tool = createManagedBashTool({ cwd: f.root, registry, host: { kind: "main", id: "fixture" }, runToken: "fixture", baseline: h });
  const result = await tool.execute("bg", { command: "sleep 1; printf FINISHED > a.ts", background: true }, undefined, undefined, undefined!);
  const taskId = (result.details as unknown as { taskId: string }).taskId;
  expect(registry.get(taskId)?.status).toBe("running");
  await expect(Promise.resolve().then(() => h.gate.sealResult("bg"))).rejects.toMatchObject({ code: "busy" });
  const captures = f.captures; await expect(h.beginRequest()).rejects.toMatchObject({ code: "busy" }); expect(f.captures).toBe(captures);
  await new Promise<void>((resolve) => { const unsubscribe = registry.subscribe(taskId, (task) => { if (task.status === "exited") { unsubscribe(); resolve(); } }); });
  expect(await readFile(join(f.root, "a.ts"), "utf8")).toBe("FINISHED");
}, 15000);
