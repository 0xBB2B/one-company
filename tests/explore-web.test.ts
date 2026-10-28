import { afterEach, expect, test, vi } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Context } from "@earendil-works/pi-ai";
import { defaultPageGetter, webFetch, webSearch } from "../src/modules/explore/web-access.ts";
import type { FetchResponse, WebDeps } from "../src/modules/explore/web-access.ts";
import { registerProtocolHandlers } from "../src/app/daemon/run-manager.ts";
import { createPmRunWorld, until } from "./helpers/run-manager-fixture.ts";

vi.setConfig({ testTimeout: 60_000 });
const cleanups: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });

const exaBody = (hits: Array<{ title: string; url: string }>) => JSON.stringify({ jsonrpc: "2.0", id: 2,
  result: { content: [{ type: "text", text: hits.map((hit) => `Title: ${hit.title}\nURL: ${hit.url}\nText: 摘要 ${hit.title}`).join("\n\n") }] } });
function fakeDeps(options: { exa?: "ok" | 429; hits?: Array<{ title: string; url: string }>; ddg?: string } = {}) {
  const calls: string[] = [];
  const deps: WebDeps = {
    fetch: async (input) => {
      const url = String(input); calls.push(url);
      if (url.startsWith("https://mcp.exa.ai/")) {
        if (options.exa === 429) return new Response("", { status: 429 });
        return new Response(exaBody(options.hits ?? [{ title: "Vitest 文档", url: "https://vitest.dev/guide/" }]), { headers: { "mcp-session-id": "s1" } });
      }
      if (url.startsWith("https://html.duckduckgo.com/")) return new Response(options.ddg ?? "", { status: options.ddg ? 200 : 503 });
      throw new Error(`unexpected ${url}`);
    },
  };
  return { deps, calls };
}

test("M7-AC16：搜索先走 Exa 公开 MCP，限流时改用 DuckDuckGo 并记录实际来源与失败，均失败报失败；抓取允许内网并跟随重定向，只取文本", async () => {
  const ok = fakeDeps();
  expect(await webSearch(ok.deps, "vitest 配置")).toMatchObject({ provider: "exa", failures: [], hits: [{ url: "https://vitest.dev/guide/", title: "Vitest 文档" }] });
  const ddgHtml = `<a class="result__a" href="//duckduckgo.com/l/?uddg=${encodeURIComponent("https://example.org/a")}&amp;rut=1">Example</a><a class="result__snippet" href="#">片段</a>`;
  const limited = fakeDeps({ exa: 429, ddg: ddgHtml });
  expect(await webSearch(limited.deps, "vitest 配置")).toMatchObject({ provider: "duckduckgo", failures: [expect.stringContaining("exa")], hits: [{ url: "https://example.org/a" }] });
  await expect(webSearch(fakeDeps({ exa: 429 }).deps, "vitest 配置")).rejects.toMatchObject({ code: "search_failed" });

  const page = (response: Partial<FetchResponse>) => async () => ({ status: 200, headers: { "content-type": "text/html" }, body: Buffer.from("<p>内网</p>"), ...response });
  expect(await webFetch(page({}), "http://127.0.0.1/")).toMatchObject({ text: "内网" });
  await expect(webFetch(page({}), "file:///etc/passwd")).rejects.toMatchObject({ code: "url_rejected" });
  await expect(webFetch(page({ headers: { "content-type": "image/png" } }), "https://example.org/")).rejects.toMatchObject({ code: "fetch_failed" });
  const hops: string[] = [];
  const redirecting = async (url: URL): Promise<FetchResponse> => {
    hops.push(url.toString());
    return hops.length === 1 ? { status: 302, headers: { location: "http://localhost/admin" }, body: Buffer.from("") }
      : { status: 200, headers: { "content-type": "text/html" }, body: Buffer.from("<html><script>x()</script><p>正文 内容</p></html>") };
  };
  expect(await webFetch(redirecting, "https://example.org/")).toMatchObject({ url: "http://localhost/admin", text: "正文 内容", truncated: false });
});

const systemOf = (requests: Context[]) => requests.find((request) => request.systemPrompt?.includes("检索来源：联网搜索"));
const text = (request: Context | undefined) => JSON.stringify(request?.messages.at(-1) ?? "");

test("M7-AC15/AC16/AC17：PM 派出联网 explore，会话可按需搜索与抓取任意网址（含内网），结果非阻塞送回 PM 并标明不是 PASS", async () => {
  const net = fakeDeps({ hits: [{ title: "Vitest 文档", url: "https://vitest.dev/guide/" }] });
  const fetched: string[] = [];
  const w = await createPmRunWorld(cleanups, { web: { deps: net.deps, getPage: async (url) => {
    fetched.push(url.toString());
    return { status: 200, headers: { "content-type": "text/plain" }, body: Buffer.from("pool: 'threads' 控制并行") };
  } } });
  const query = "vitest 并行 worker 配置";
  const research = { conclusions: ["用 pool 配置并行"], sources: [{ kind: "web", indexBaseline: "not_applicable", url: "http://wiki.intranet.local/vitest", retrievedAt: Date.now(), quote: "pool: 'threads' 控制并行" }],
    searchedScope: { kind: "web", queries: [query, "vitest pool"] }, notFound: [], failures: [], truncation: { truncated: false, reasons: [] }, unknown: [] };
  w.provider.queue.push(
    { type: "toolcall", name: "web_search", input: { query: "vitest pool" } },
    { type: "toolcall", name: "web_fetch", input: { url: "http://wiki.intranet.local/vitest" } },
    { type: "toolcall", name: "one_company_result_submit", input: { action: "research", result: research } },
    { type: "text", text: "PM 收到联网检索结果" });
  const dispatched = await w.manager.dispatchExplore({ parent: { role: "PM", pmRunId: w.pm.runId },
    request: { question: "vitest 如何并行", clues: [], source: { kind: "web", query } }, maxTurns: 6 });
  await until(() => w.provider.requests.some((request) => text(request).includes("explore-report")));
  const system = systemOf(w.provider.requests)!;
  expect(system.tools?.map((tool) => tool.name).sort()).toEqual(["one_company_result_submit", "web_fetch", "web_search"]);
  expect(JSON.stringify(system)).not.toContain("输入正确验证码后成功");
  expect(net.calls.filter((url) => url.startsWith("https://mcp.exa.ai/")).length).toBe(3);
  expect(fetched).toEqual(["http://wiki.intranet.local/vitest"]);
  const report = w.provider.requests.find((entry) => text(entry).includes("explore-report"))!;
  expect(text(report)).toContain("用 pool 配置并行");
  expect(text(report)).toContain("research 不是 PASS");
  const run = await w.runStore.get(dispatched.runId);
  expect(run.ok && run.run).toMatchObject({ role: "one-company.explore", state: "completed" });
});

test("M7-AC16：main 在无需求、索引未初始化时派出纯网页检索成功，index 基线 not_applicable；结果只交给派出连接，不创建需求、运行记录或工作区", async () => {
  const net = fakeDeps({ hits: [{ title: "Node 文档", url: "https://nodejs.org/api/" }] });
  const w = await createPmRunWorld(cleanups, { review: false, web: { deps: net.deps, getPage: async () =>
    ({ status: 200, headers: { "content-type": "text/plain" }, body: Buffer.from("fs.promises 提供异步接口") }) } });
  const runsBefore = (await w.runStore.list({ limit: 100 })).items.length;
  const requirements = () => w.db((d) => d.list("requirements").length);
  const requirementsBefore = requirements();
  expect(requirementsBefore).toBeGreaterThan(0);
  const research = { conclusions: ["用 fs.promises"], sources: [{ kind: "web", indexBaseline: "not_applicable", url: "https://nodejs.org/api/", retrievedAt: Date.now(), quote: "fs.promises 提供异步接口" }],
    searchedScope: { kind: "web", queries: ["node 异步文件"] }, notFound: [], failures: [], truncation: { truncated: false, reasons: [] }, unknown: [] };
  w.provider.queue.push(
    { type: "toolcall", name: "web_search", input: { query: "node 异步文件" } },
    { type: "toolcall", name: "web_fetch", input: { url: "https://nodejs.org/api/" } },
    { type: "toolcall", name: "one_company_result_submit", input: { action: "research", result: research } });
  w.manager.connectionOpened("conn-main");
  const parent = { role: "main" as const, sessionId: "session-main", connectionId: "conn-main", model: { provider: "team-model", id: "test" }, thinking: "off" };
  const dispatched = await w.manager.dispatchExplore({ parent, request: { question: "node 如何异步读文件", clues: [], source: { kind: "web", query: "node 异步文件" } }, maxTurns: 5 });
  await until(() => w.emit.mock.calls.some(([event, data]) => event === "explore.finished" && (data as { runId: string }).runId === dispatched.runId));
  expect(() => w.manager.takeMainExploreReport(dispatched.runId, "conn-other")).toThrow();
  const report = w.manager.takeMainExploreReport(dispatched.runId, "conn-main") as { outcome: string; research: { source: { kind: string; indexBaseline: string }; parent: { requirementBinding: unknown } } };
  expect(report).toMatchObject({ outcome: "completed", research: { source: { kind: "web", indexBaseline: "not_applicable" }, parent: { role: "main", requirementBinding: null } } });
  expect(JSON.stringify(report)).not.toMatch(/generation|baselineHash|requirementId/u);
  expect((await w.runStore.list({ limit: 100 })).items.length).toBe(runsBefore);
  expect(requirements()).toBe(requirementsBefore);
});

test("main 派出的检索在模型连接断开时按失败交回并写明请重派，不停在无法续接的暂停", async () => {
  const w = await createPmRunWorld(cleanups, { review: false, web: { deps: fakeDeps().deps, getPage: async () => { throw new TypeError("fetch failed"); } } });
  w.provider.queue.push({ type: "error", message: "fetch failed: connection reset (network)" });
  w.manager.connectionOpened("conn-main");
  const parent = { role: "main" as const, sessionId: "session-main", connectionId: "conn-main", model: { provider: "team-model", id: "test" }, thinking: "off" };
  const dispatched = await w.manager.dispatchExplore({ parent, request: { question: "node 如何异步读文件", clues: [], source: { kind: "web", query: "node 异步文件" } }, maxTurns: 5 });
  await until(() => w.emit.mock.calls.some(([event, data]) => event === "explore.finished" && (data as { runId: string }).runId === dispatched.runId));
  expect(w.manager.mainExploreStatus(dispatched.runId, "conn-main")).toMatchObject({ state: "failed" });
  const report = w.manager.takeMainExploreReport(dispatched.runId, "conn-main") as { outcome: string; research: unknown; reason: string };
  expect(report).toMatchObject({ outcome: "failed", research: null });
  expect(report.reason).toContain("断网，检索已中止，网络恢复后请重派");
});

test("main 派出的检索断网中止后，runs.steps 返回 failed 和请重派的原因；主代理主动停掉的仍是 stopped 且没有原因", async () => {
  const w = await createPmRunWorld(cleanups, { review: false, web: { deps: fakeDeps().deps, getPage: async () => { throw new TypeError("fetch failed"); } } });
  const handlers = new Map<string, (params: Record<string, unknown>, client: unknown) => Promise<unknown>>();
  registerProtocolHandlers({ server: { registerHandler: (method: string, handler: never) => handlers.set(method, handler), markHandlersReady: () => {} } as never,
    manager: w.manager, shellRegistry: {} as never });
  const client = { connectionId: "conn-main", sessionId: "session-main" };
  const steps = (runId: string) => handlers.get("runs.steps")!({ runId }, client) as Promise<Record<string, unknown>>;
  w.manager.connectionOpened("conn-main");
  const parent = { role: "main" as const, sessionId: "session-main", connectionId: "conn-main", model: { provider: "team-model", id: "test" }, thinking: "off" };
  const request = { question: "node 如何异步读文件", clues: [], source: { kind: "web" as const, query: "node 异步文件" } };

  w.provider.queue.push({ type: "error", message: "fetch failed: connection reset (network)" });
  const offline = await w.manager.dispatchExplore({ parent, request, maxTurns: 5 });
  await until(() => w.emit.mock.calls.some(([event, data]) => event === "explore.finished" && (data as { runId: string }).runId === offline.runId));
  const failed = await steps(offline.runId);
  expect(failed).toMatchObject({ state: "failed", reason: "断网，检索已中止，网络恢复后请重派" });

  w.provider.queue.push({ type: "text", text: "慢慢查", chunkDelayMs: 20_000 });
  const slow = await w.manager.dispatchExplore({ parent, request, maxTurns: 5 });
  await until(async () => (await steps(slow.runId)).state === "running");
  await handlers.get("runs.stop")!({ runId: slow.runId }, client);
  const stopped = await steps(slow.runId);
  expect(stopped.state).toBe("stopped");
  expect(stopped.reason).toBeUndefined();
});

test("M9-AC10：断网时 main 派出的联网检索如实交回失败：搜索与抓取都报网络错误，结果不带任何网页来源、写明失败与未找到，不当作联网成功", async () => {
  const offline: WebDeps = { fetch: async () => { throw new TypeError("fetch failed"); } };
  const w = await createPmRunWorld(cleanups, { review: false, web: { deps: offline, getPage: async () => { throw new TypeError("fetch failed"); } } });
  const research = { conclusions: [], sources: [], searchedScope: { kind: "web", queries: ["node 异步文件"] }, notFound: ["node 如何异步读文件"],
    failures: ["web_search：网络不可用", "web_fetch：网络不可用"], truncation: { truncated: false, reasons: [] }, unknown: [] };
  w.provider.queue.push(
    { type: "toolcall", name: "web_search", input: { query: "node 异步文件" } },
    { type: "toolcall", name: "web_fetch", input: { url: "https://nodejs.org/api/" } },
    { type: "toolcall", name: "one_company_result_submit", input: { action: "research", result: research } });
  w.manager.connectionOpened("conn-main");
  const parent = { role: "main" as const, sessionId: "session-main", connectionId: "conn-main", model: { provider: "team-model", id: "test" }, thinking: "off" };
  const dispatched = await w.manager.dispatchExplore({ parent, request: { question: "node 如何异步读文件", clues: [], source: { kind: "web", query: "node 异步文件" } }, maxTurns: 5 });
  await until(() => w.emit.mock.calls.some(([event, data]) => event === "explore.finished" && (data as { runId: string }).runId === dispatched.runId));
  const toolErrors = w.provider.requests.filter((request) => request.systemPrompt?.includes("检索来源：联网搜索")).at(-1)!.messages
    .filter((message) => message.role === "toolResult" && ["web_search", "web_fetch"].includes((message as { toolName: string }).toolName));
  expect(toolErrors.map((message) => [(message as { toolName: string }).toolName, (message as { isError: boolean }).isError])).toEqual([["web_search", true], ["web_fetch", true]]);
  const report = w.manager.takeMainExploreReport(dispatched.runId, "conn-main") as { outcome: string; research: { sources: unknown[]; failures: string[]; notFound: string[] } };
  expect(report.research).toMatchObject({ sources: [], notFound: ["node 如何异步读文件"] });
  expect(report.research.failures.length).toBeGreaterThan(0);
});

async function serve(handler: Parameters<typeof createServer>[1]): Promise<URL> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => { server.closeAllConnections(); server.close(); });
  return new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`);
}

test("抓取按总时长计 10 秒：对方一直在发数据但发得慢，约 10 秒时也要失败；快速响应照常成功", async () => {
  const fast = await serve((_req, res) => { res.writeHead(200, { "content-type": "text/plain" }); res.end("快速响应"); });
  expect((await defaultPageGetter(fast)).body.toString("utf8")).toBe("快速响应");

  const slow = await serve((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    let sent = 0;
    const timer = setInterval(() => { res.write("x"); if (++sent >= 7) { clearInterval(timer); res.end(); } }, 2_000);
    res.on("close", () => clearInterval(timer));
  });
  const started = Date.now();
  await expect(defaultPageGetter(slow)).rejects.toThrow("超时");
  const elapsed = Date.now() - started;
  expect(elapsed).toBeGreaterThan(9_000);
  expect(elapsed).toBeLessThan(11_500);
}, 20_000);
