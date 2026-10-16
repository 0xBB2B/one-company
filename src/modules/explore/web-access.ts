import { request as httpRequest } from "node:http";
import { adviceIn } from "./tool-failure.ts";
import type { FailureAdvice } from "./tool-failure.ts";
import { request as httpsRequest } from "node:https";

const WEB_ADVICE: Record<string, FailureAdvice> = {
  fetch_failed: { why: "抓取网页失败", next: "换一个来源或稍后重试；仍然失败就在 research 的失败项里记下" },
  rate_limited: { why: "搜索服务限流", next: "等一会再搜，或改用 web_fetch 直接读已知网址" },
  search_failed: { why: "联网搜索失败", next: "换个关键词或稍后重试；仍然失败就在 research 的失败项里记下" },
  url_rejected: { why: "这个网址不允许抓取", next: "改用公开的 http 或 https 网址" },
};
export class WebAccessError extends Error {
  readonly code: string;
  readonly advice: FailureAdvice;
  constructor(code: string, detail?: string) {
    super(detail ? `${code}: ${detail}` : code); this.name = "WebAccessError"; this.code = code; this.advice = adviceIn(WEB_ADVICE, code, detail);
  }
}

export interface WebDeps { fetch: typeof fetch }
export const defaultWebDeps: WebDeps = { fetch: (...args) => fetch(...args) };

export interface SearchHit { url: string; title: string; snippet: string }
export interface SearchOutcome { provider: "exa" | "duckduckgo"; hits: SearchHit[]; failures: string[]; retrievedAt: number }

const TIMEOUT_MS = 10_000;
const FETCH_MAX_BYTES = 512 * 1024;
const FETCH_TEXT_CHARS = 20_000;
const MAX_HITS = 8;

function withTimeout(ms: number): AbortSignal { return AbortSignal.timeout(ms); }
function cleanText(value: string): string {
  return value.replace(/<[^>]*>/gu, " ").replace(/&amp;/gu, "&").replace(/&lt;/gu, "<").replace(/&gt;/gu, ">").replace(/&quot;/gu, "\"").replace(/&#x27;|&#39;/gu, "'")
    .replace(/\s+/gu, " ").trim();
}
function webUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url : null;
  } catch { return null; }
}

async function mcpCall(deps: WebDeps, body: unknown, session?: string): Promise<{ text: string; session: string | null }> {
  const response = await deps.fetch("https://mcp.exa.ai/mcp", { method: "POST", signal: withTimeout(TIMEOUT_MS),
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(session ? { "mcp-session-id": session } : {}) },
    body: JSON.stringify(body) });
  if (response.status === 429) throw new WebAccessError("rate_limited", "exa 限流");
  if (!response.ok) throw new WebAccessError("search_failed", `exa ${response.status}`);
  return { text: await response.text(), session: response.headers.get("mcp-session-id") };
}

function mcpResult(text: string): { content?: Array<{ type: string; text?: string }> } | null {
  const payloads = text.trim().startsWith("{") ? [text] : text.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim());
  for (const payload of payloads) {
    try { const message = JSON.parse(payload) as { result?: unknown; error?: unknown }; if (message.error) return null; if (message.result) return message.result as never; } catch { /* 忽略非 JSON 帧 */ }
  }
  return null;
}

/** 免密钥调用 Exa 公开 MCP 端点的 web_search_exa。 */
async function searchExa(deps: WebDeps, query: string): Promise<SearchHit[]> {
  const init = await mcpCall(deps, { jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "one-company", version: "1" } } });
  const session = init.session ?? undefined;
  await mcpCall(deps, { jsonrpc: "2.0", method: "notifications/initialized" }, session).catch(() => undefined);
  const call = await mcpCall(deps, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "web_search_exa", arguments: { query, numResults: MAX_HITS } } }, session);
  const text = (mcpResult(call.text)?.content ?? []).map((part) => part.text ?? "").join("\n");
  const hits: SearchHit[] = [];
  for (const block of text.split(/\n(?=Title:)/u)) {
    const url = /URL:\s*(\S+)/u.exec(block)?.[1];
    if (!url || !webUrl(url)) continue;
    hits.push({ url, title: cleanText(/Title:\s*(.*)/u.exec(block)?.[1] ?? url), snippet: cleanText(block.replace(/^(Title|URL|Published Date|Author):.*$/gmu, "")).slice(0, 400) });
    if (hits.length >= MAX_HITS) break;
  }
  if (hits.length === 0) throw new WebAccessError("search_failed", "exa 未返回可用结果");
  return hits;
}

/** DuckDuckGo HTML 页兜底。 */
async function searchDuckDuckGo(deps: WebDeps, query: string): Promise<SearchHit[]> {
  const response = await deps.fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, { signal: withTimeout(TIMEOUT_MS),
    headers: { "user-agent": "Mozilla/5.0 (compatible; one-company)", accept: "text/html" } });
  if (!response.ok) throw new WebAccessError("search_failed", `duckduckgo ${response.status}`);
  const html = await response.text(), hits: SearchHit[] = [];
  const snippets = [...html.matchAll(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gu)].map((match) => cleanText(match[1]!));
  for (const [index, match] of [...html.matchAll(/<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gu)].entries()) {
    let href = match[1]!.replace(/&amp;/gu, "&");
    if (href.startsWith("//")) href = `https:${href}`;
    const redirect = webUrl(href);
    const target = redirect?.searchParams.get("uddg") ?? href;
    if (!webUrl(target)) continue;
    hits.push({ url: target, title: cleanText(match[2]!), snippet: (snippets[index] ?? "").slice(0, 400) });
    if (hits.length >= MAX_HITS) break;
  }
  if (hits.length === 0) throw new WebAccessError("search_failed", "duckduckgo 未返回可用结果");
  return hits;
}

/** 先 Exa 公开 MCP，限流或失败时改用 DuckDuckGo；记录实际来源，均失败则报失败，不假称成功。 */
export async function webSearch(deps: WebDeps, query: string): Promise<SearchOutcome> {
  const failures: string[] = [];
  try { return { provider: "exa", hits: await searchExa(deps, query), failures, retrievedAt: Date.now() }; }
  catch (error) { failures.push(`exa：${(error as Error).message}`); }
  try { return { provider: "duckduckgo", hits: await searchDuckDuckGo(deps, query), failures, retrievedAt: Date.now() }; }
  catch (error) { failures.push(`duckduckgo：${(error as Error).message}`); }
  throw new WebAccessError("search_failed", failures.join("；"));
}

export interface FetchResponse { status: number; headers: Record<string, string | undefined>; body: Buffer }
export type PageGetter = (url: URL) => Promise<FetchResponse>;
export const defaultPageGetter: PageGetter = (url) => new Promise((resolve, reject) => {
    const client = url.protocol === "https:" ? httpsRequest : httpRequest;
    const signal = withTimeout(TIMEOUT_MS);
    const request = client(url, { method: "GET", signal,
      headers: { "user-agent": "Mozilla/5.0 (compatible; one-company)" } }, (response) => {
      const chunks: Buffer[] = []; let size = 0;
      response.on("data", (chunk: Buffer) => { size += chunk.length; if (size <= FETCH_MAX_BYTES) chunks.push(chunk); else response.destroy(); });
      response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: { location: response.headers.location, "content-type": response.headers["content-type"] }, body: Buffer.concat(chunks) }));
      response.on("close", () => resolve({ status: response.statusCode ?? 0, headers: { location: response.headers.location, "content-type": response.headers["content-type"] }, body: Buffer.concat(chunks) }));
      response.on("error", reject);
    });
    signal.addEventListener("abort", () => reject(new WebAccessError("fetch_failed", "超时")), { once: true });
    request.on("error", reject);
    request.end();
});

/** 抓取网址（含内网），跟随有限次重定向，只返回有界纯文本。 */
export async function webFetch(get: PageGetter, target: string): Promise<{ url: string; retrievedAt: number; text: string; truncated: boolean }> {
  let url = webUrl(target);
  if (!url) throw new WebAccessError("url_rejected", target);
  for (let hop = 0; hop < 4; hop++) {
    const response = await get(url);
    if (response.status >= 300 && response.status < 400) {
      const next = webUrl(new URL(response.headers.location ?? "", url).toString());
      if (!next) throw new WebAccessError("url_rejected", "重定向目标无效");
      url = next;
      continue;
    }
    if (response.status < 200 || response.status >= 300) throw new WebAccessError("fetch_failed", `${response.status}`);
    const type = response.headers["content-type"] ?? "";
    if (!/text\/|json|xml/u.test(type)) throw new WebAccessError("fetch_failed", `不支持的内容类型 ${type}`);
    const raw = response.body.subarray(0, FETCH_MAX_BYTES).toString("utf8");
    const text = /html/u.test(type) ? cleanText(raw.replace(/<(script|style)[\s\S]*?<\/\1>/giu, " ")) : raw;
    return { url: url.toString(), retrievedAt: Date.now(), text: text.slice(0, FETCH_TEXT_CHARS), truncated: text.length > FETCH_TEXT_CHARS };
  }
  throw new WebAccessError("fetch_failed", "重定向次数过多");
}
