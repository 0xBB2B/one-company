import { afterEach, expect, test } from "vitest";
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { join, relative } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { stream as streamAnthropic } from "@earendil-works/pi-ai/api/anthropic-messages";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createProtectedFileTools } from "../extensions/write-protection.ts";
import { installProjectBaselineHooks, OLD_PROJECT_SNAPSHOT } from "../runtime/project-baseline-hooks.ts";
import type { ProjectBaselineHooks } from "../runtime/project-baseline-hooks.ts";
import { BaselineFixture, deferred } from "./helpers/project-baseline-fixture.ts";

const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const alias = "configured-alias";
const canonical = "canonical-server-model";

/** 真实 SDK 与 Anthropic SSE 解析器；fetch 只返回本机 Response，不联网。 */
async function sdk(returnedModel: string, failFirst = false) {
  const f = await BaselineFixture.create(); cleanup.push(() => f.close());
  const home = await mkdtemp("/tmp/m3-model-identity-sdk-"); await chmod(home, 0o700);
  cleanup.push(() => rm(home, { recursive: true, force: true }));
  const runtime = await ModelRuntime.create({ authPath: join(home, "auth.json"), modelsPath: null,
    modelsStorePath: join(home, "models.json"), refreshOnCreate: false });
  let fetches = 0;
  let nextWrite: string | undefined;
  let bodyReady: ReturnType<typeof deferred<void>> | undefined;
  const events: Array<{ type: "start" | "end"; model: string; timestamp: number; responseId?: string; stopReason: string }> = [];
  const starts: AssistantMessage[] = [];
  const ends: AssistantMessage[] = [];
  const transport = async () => {
    fetches++;
    if (failFirst && fetches === 1) throw new Error("controlled pre-start connection failure");
    const content = nextWrite; nextWrite = undefined;
    const tool = content !== undefined;
    const frames = [
      { type: "message_start", message: { id: `response-${fetches}`, type: "message", role: "assistant", model: returnedModel,
        content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: tool
        ? { type: "tool_use", id: `write-${fetches}`, name: "write", input: {} } : { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: tool
        ? { type: "input_json_delta", partial_json: JSON.stringify({ path: "a.ts", content }) } : { type: "text_delta", text: "answer" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: tool ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
      { type: "message_stop" },
    ];
    const ready = deferred<void>(); bodyReady = ready;
    const body = new ReadableStream<Uint8Array>({ async start(controller) {
      // 等真实扩展 message_start 已观察到配置别名，再交给解析器服务端帧。
      await ready.promise;
      for (const frame of frames) controller.enqueue(new TextEncoder().encode(`event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`));
      controller.close();
    } });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  runtime.registerProvider("model-identity", { api: "anthropic-messages", baseUrl: "http://never-contacted.invalid", apiKey: "fixture",
    models: [{ id: alias, name: alias, reasoning: false, input: ["text"], contextWindow: 10000, maxTokens: 1000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple(model, context, options) { return streamAnthropic(model, context, { ...options, fetch: transport, maxRetries: 0 }); },
  });
  let hooks!: ProjectBaselineHooks;
  const loader = new DefaultResourceLoader({ cwd: f.root, agentDir: home, noExtensions: true, noSkills: true, noPromptTemplates: true,
    noThemes: true, agentsFilesOverride: () => ({ agentsFiles: [] }), extensionFactories: [(pi) => {
      hooks = installProjectBaselineHooks(pi, { provider: f, checkPath: async (path) => relative(f.root, path) });
      const [write] = createProtectedFileTools(async () => ({ checkWrite: async () => ({ ok: true as const }) })); pi.registerTool(write);
      pi.on("message_start", (event) => {
        if (event.message.role !== "assistant") return;
        const m = event.message; starts.push(m);
        events.push({ type: "start", model: m.model, timestamp: m.timestamp, responseId: m.responseId, stopReason: m.stopReason });
        bodyReady?.resolve(); bodyReady = undefined;
      });
      pi.on("message_end", (event) => {
        if (event.message.role !== "assistant") return;
        const m = event.message; ends.push(m);
        events.push({ type: "end", model: m.model, timestamp: m.timestamp, responseId: m.responseId, stopReason: m.stopReason });
      });
    }] });
  await loader.reload();
  const { session } = await createAgentSession({ cwd: f.root, agentDir: home, modelRuntime: runtime, model: runtime.getModels("model-identity")[0],
    resourceLoader: loader, sessionManager: SessionManager.inMemory(f.root),
    settingsManager: SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } }), tools: ["write"] });
  cleanup.push(async () => { await hooks.shutdown(); session.dispose(); expect(f.listeners.size).toBe(0); });
  return { f, hooks, session, events, starts, ends, fetches: () => fetches,
    prompt: async (write?: string) => { nextWrite = write; await session.prompt("fixture"); } };
}

test.each([alias, canonical])("真实SSE模型%s：工具写入、原消息seal和第二次prompt均正常", async (returnedModel) => {
  const s = await sdk(returnedModel);
  await s.prompt("FIRST");
  expect(await readFile(join(s.f.root, "a.ts"), "utf8")).toBe("FIRST");
  expect(s.fetches()).toBe(2);
  const first = s.ends.at(-1)!;
  const firstRequest = await s.hooks.assertMessage(first);
  const seal = await s.hooks.sealMessage(first);
  expect((await s.hooks.assertDelivery(seal)).messageId).toBeTypeOf("string");
  await expect(s.hooks.assertMessage(structuredClone(first))).rejects.toMatchObject({ code: "stale" });
  first.content.push({ type: "text", text: "tampered" });
  await expect(s.hooks.assertMessage(first)).rejects.toMatchObject({ code: "stale" });
  first.content.pop();
  await s.prompt("SECOND");
  expect(await readFile(join(s.f.root, "a.ts"), "utf8")).toBe("SECOND");
  expect(s.fetches()).toBe(4);
  expect(s.session.messages.filter((m) => m.role === "toolResult").map((m) => m.isError)).toEqual([false, false]);
  expect(JSON.stringify(s.session.messages)).not.toContain(OLD_PROJECT_SNAPSHOT);
  expect(await s.hooks.assertMessage(s.ends.at(-1)!)).not.toBe(firstRequest);
  await expect(s.hooks.assertDelivery(seal)).rejects.toMatchObject({ code: "invalid_seal" });
  await expect(s.hooks.assertMessage(first)).rejects.toMatchObject({ code: "stale" });
  // 真实SDK在start发送浅拷贝；不能依赖start/end对象相等或尚未出现的responseId。
  for (let i = 0; i < s.starts.length; i++) {
    expect(s.starts[i]).not.toBe(s.ends[i]);
    expect(s.events[i * 2]).toMatchObject({ type: "start", model: alias, responseId: undefined });
    expect(s.events[i * 2 + 1]).toMatchObject({ type: "end", model: returnedModel, timestamp: s.events[i * 2]!.timestamp,
      responseId: `response-${i + 1}` });
  }
  expect((await s.hooks.beginRequest()).kind).toBe("managed");
  expect(s.hooks.gate.diagnostics).toMatchObject({ stale: false, pending: 0, mutations: 0 });
});

test("真实SSE start前网络失败对照：SDK补出成对消息，下一prompt可写入", async () => {
  const s = await sdk(alias, true);
  await s.prompt();
  expect(s.fetches()).toBe(1);
  expect(s.events).toHaveLength(2);
  expect(s.events[0]).toMatchObject({ type: "start", model: alias, stopReason: "error" });
  expect(s.events[1]).toMatchObject({ type: "end", model: alias, timestamp: s.events[0]!.timestamp, stopReason: "error" });
  expect(await readFile(join(s.f.root, "a.ts"), "utf8")).toBe("A");
  await expect(s.hooks.sealMessage(s.ends[0]!)).rejects.toMatchObject({ code: "stale" });
  await s.prompt("RECOVERED");
  expect(await readFile(join(s.f.root, "a.ts"), "utf8")).toBe("RECOVERED");
  expect(s.session.messages.find((m) => m.role === "toolResult")).toMatchObject({ isError: false });
  expect((await s.hooks.beginRequest()).kind).toBe("managed");
});

test("真实SSE别名旧消息迟到，不借新request给旧工具或plain消息续权", async () => {
  const s = await sdk(canonical);
  await s.prompt("FIRST");
  const oldTool = s.ends[0]!, oldPlain = s.ends[1]!;
  await s.hooks.assertMessage(oldPlain);
  const current = await s.hooks.beginRequest(); await s.hooks.beforeProviderRequest();
  const captures = s.f.captures;
  expect(await s.hooks.messageEnd(oldTool)).toBe(false);
  expect(await s.hooks.messageEnd(oldPlain)).toBe(false);
  await expect(s.hooks.assertCall("write-1")).rejects.toMatchObject({ code: "stale" });
  await expect(s.hooks.sealMessage(oldPlain)).rejects.toMatchObject({ code: "stale" });
  expect(s.f.captures).toBe(captures);
  // 未匹配任何start的end也不能取当前request；它不消费已派出的新请求。
  const orphan = { ...oldPlain, timestamp: oldPlain.timestamp + 1000 };
  expect(await s.hooks.messageEnd(orphan)).toBe(false);
  const next = { ...oldPlain, timestamp: oldPlain.timestamp + 2000 };
  s.hooks.messageStart({ ...next, model: alias });
  expect(await s.hooks.messageEnd(next)).toBe(true);
  expect(await s.hooks.assertMessage(next)).toBe(current);
});
