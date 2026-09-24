import { afterEach, expect, test, vi } from "vitest";
import { homedir } from "node:os";
import type { Context } from "@earendil-works/pi-ai";
import { checkDisclosure, publicLookup, webFetch, webSearch } from "../runtime/web-access.ts";
import type { FetchResponse, WebDeps } from "../runtime/web-access.ts";
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
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
  };
  return { deps, calls };
}

test("M7-AC16：外发核对拒绝多行超长、控制与不可见字符、疑似密钥与本机路径，通过时给出查询词 hash", () => {
  const reject = (query: string) => expect(checkDisclosure(query)).toHaveProperty("rejected");
  reject("第一行\n第二行");
  reject("第一行\u2028第二行");
  reject("a".repeat(257));
  for (const invisible of ["\u200b", "\u034f", "\ufe0f", "\u3164", "\u2800", "\u{e0100}"]) reject(`gh${invisible}p_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345`);
  reject("token sk-abcdefghijklmnopqrstuvwxyz0123");
  reject("Zx8Qp2Lm9Vt4Rw7Yk3Hn6Bc1Df5Gj0Ks8Aq");
  reject(`读取 ${homedir()}/secret 的方法`);
  reject("为什么 /Users/someone/app 报错");
  expect(checkDisclosure("vitest 并行 worker 配置方法")).toMatchObject({ contentHash: expect.stringMatching(/^[0-9a-f]{64}$/u) });
});

test("M7-AC16：搜索先走 Exa 公开 MCP，限流时改用 DuckDuckGo 并记录实际来源与失败；抓取拒绝内网地址与越界重定向", async () => {
  const ok = fakeDeps();
  expect(await webSearch(ok.deps, "vitest 配置")).toMatchObject({ provider: "exa", failures: [], hits: [{ url: "https://vitest.dev/guide/", title: "Vitest 文档" }] });
  const ddgHtml = `<a class="result__a" href="//duckduckgo.com/l/?uddg=${encodeURIComponent("https://example.org/a")}&amp;rut=1">Example</a><a class="result__snippet" href="#">片段</a>`;
  const limited = fakeDeps({ exa: 429, ddg: ddgHtml });
  expect(await webSearch(limited.deps, "vitest 配置")).toMatchObject({ provider: "duckduckgo", failures: [expect.stringContaining("exa")], hits: [{ url: "https://example.org/a" }] });
  await expect(webSearch(fakeDeps({ exa: 429 }).deps, "vitest 配置")).rejects.toMatchObject({ code: "search_failed" });

  const lookup = publicLookup({ lookup: async () => [{ address: "10.0.0.8", family: 4 }] });
  const error = await new Promise((resolve) => lookup("internal.example", { all: true }, (err) => resolve(err)));
  expect(error).toMatchObject({ code: "private_address" });

  const page = (response: Partial<FetchResponse>) => async () => ({ status: 200, headers: { "content-type": "text/html" }, body: Buffer.from(""), ...response });
  await expect(webFetch(page({}), "http://127.0.0.1/")).rejects.toMatchObject({ code: "private_address" });
  await expect(webFetch(page({}), "file:///etc/passwd")).rejects.toMatchObject({ code: "url_rejected" });
  await expect(webFetch(page({ status: 302, headers: { location: "http://localhost/admin" } }), "https://example.org/")).rejects.toMatchObject({ code: "url_rejected" });
  expect(await webFetch(page({ body: Buffer.from("<html><script>x()</script><p>正文 内容</p></html>") }), "https://example.org/"))
    .toMatchObject({ url: "https://example.org/", text: "正文 内容", truncated: false });
});

const systemOf = (requests: Context[]) => requests.find((request) => request.systemPrompt?.includes("检索来源：联网搜索"));
const text = (request: Context | undefined) => JSON.stringify(request?.messages.at(-1) ?? "");

test("M7-AC15/AC16/AC17：PM 派出联网 explore 自动核对外发后搜索，会话只能取回本次结果、只能抓取结果中的网址，结果非阻塞送回 PM", async () => {
  const net = fakeDeps({ hits: [{ title: "Vitest 文档", url: "https://vitest.dev/guide/" }] });
  const fetched: string[] = [];
  const w = await createPmRunWorld(cleanups, { web: { deps: net.deps, getPage: async (url) => {
    fetched.push(url.toString());
    return { status: 200, headers: { "content-type": "text/plain" }, body: Buffer.from("pool: 'threads' 控制并行") };
  } } });
  const query = "vitest 并行 worker 配置";
  const research = { conclusions: ["用 pool 配置并行"], sources: [{ kind: "web", indexBaseline: "not_applicable", url: "https://vitest.dev/guide/", retrievedAt: Date.now(), quote: "pool: 'threads' 控制并行" }],
    searchedScope: { kind: "web", queries: [query], domains: ["vitest.dev"] }, notFound: [], failures: [], truncation: { truncated: false, reasons: [] }, unknown: [] };
  w.provider.queue.push(
    { type: "toolcall", name: "web_search", input: { query } },
    { type: "toolcall", name: "web_fetch", input: { url: "https://evil.example/x" } },
    { type: "toolcall", name: "web_fetch", input: { url: "https://vitest.dev/guide/" } },
    { type: "toolcall", name: "pi_company_result_submit", input: { action: "research", result: research } },
    { type: "text", text: "PM 收到联网检索结果" });
  const dispatched = await w.manager.dispatchExplore({ parent: { role: "PM", pmRunId: w.pm.runId },
    request: { question: "vitest 如何并行", clues: [], source: { kind: "web", query } }, maxTurns: 6 });
  await until(() => w.provider.requests.some((request) => text(request).includes("explore-report")));
  const system = systemOf(w.provider.requests)!;
  expect(system.tools?.map((tool) => tool.name).sort()).toEqual(["pi_company_result_submit", "web_fetch", "web_search"]);
  expect(JSON.stringify(system)).not.toContain("输入正确验证码后成功");
  expect(net.calls.filter((url) => url.startsWith("https://mcp.exa.ai/")).length).toBe(3);
  expect(fetched).toEqual(["https://vitest.dev/guide/"]);
  expect(JSON.stringify(w.provider.requests)).toContain("web_fetch_denied");
  const report = w.provider.requests.find((entry) => text(entry).includes("explore-report"))!;
  expect(text(report)).toContain("用 pool 配置并行");
  expect(text(report)).toContain("research 不是 PASS");
  const run = await w.runStore.get(dispatched.runId);
  expect(run.ok && run.run).toMatchObject({ role: "pi-company.explore", state: "completed" });
});

test("M7-AC16：查询词含疑似密钥或本机路径时派出即被拒，不联网、不创建检索会话", async () => {
  const net = fakeDeps();
  const w = await createPmRunWorld(cleanups, { review: false, web: { deps: net.deps, getPage: async () => { throw new Error("不应抓取"); } } });
  const before = w.provider.requests.length;
  for (const query of ["ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345 无效", `${homedir()}/project 配置`]) {
    await expect(w.manager.dispatchExplore({ parent: { role: "PM", pmRunId: w.pm.runId },
      request: { question: "查一下", clues: [], source: { kind: "web", query } }, maxTurns: 3 })).rejects.toMatchObject({ code: "disclosure_rejected" });
  }
  expect(net.calls).toEqual([]);
  expect(w.provider.requests.length).toBe(before);
  expect((await w.runStore.list({ limit: 100 })).items.filter((run) => run.role === "pi-company.explore")).toEqual([]);
});
