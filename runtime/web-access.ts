import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { homedir, userInfo } from "node:os";
import { promisify } from "node:util";
import { canonicalDomain } from "./explore-contracts.ts";

const exec = promisify(execFile);

export class WebAccessError extends Error {
  readonly code: string;
  constructor(code: string, detail?: string) { super(detail ? `${code}: ${detail}` : code); this.name = "WebAccessError"; this.code = code; }
}

/** 可注入的网络依赖；缺省为 Node 内置 fetch 与 DNS。 */
export interface WebDeps {
  fetch: typeof fetch;
  lookup: (hostname: string) => Promise<Array<{ address: string }>>;
}
export const defaultWebDeps: WebDeps = { fetch: (...args) => fetch(...args), lookup: (hostname) => lookup(hostname, { all: true }) };

export const QUERY_MAX_CHARS = 256;
const PROD_WINDOW = 12;
const FILE_WINDOW = 20;
const SECRET_PATTERNS = [/\bsk-[A-Za-z0-9_-]{16,}/u, /\bgh[pousr]_[A-Za-z0-9]{20,}/u, /\bAKIA[0-9A-Z]{16}\b/u, /-----BEGIN [A-Z ]*KEY-----/u,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/u, /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/u];

function entropy(text: string): number {
  const counts = new Map<string, number>();
  for (const char of text) counts.set(char, (counts.get(char) ?? 0) + 1);
  return [...counts.values()].reduce((total, count) => total - (count / text.length) * Math.log2(count / text.length), 0);
}

function windows(text: string, size: number): string[] {
  const chars = Array.from(text), result = new Set<string>();
  for (let index = 0; index + size <= chars.length; index++) {
    const window = chars.slice(index, index + size).join("");
    if (window.trim().length === size) result.add(window);
  }
  return [...result];
}

/**
 * 外发核对：查询词由模型拟定，只有逐条通过才签发一次性外发授权。只能挡住原文外发，
 * 挡不住换一种说法描述私有信息。
 */
export async function checkDisclosure(query: string, context: { roots: string[]; privateTexts: string[] }): Promise<{ contentHash: string } | { rejected: string }> {
  if (!query.trim() || /[\p{Cc}\p{Default_Ignorable_Code_Point}\p{Zl}\p{Zp}\u2800]/u.test(query) || Array.from(query).length > QUERY_MAX_CHARS) return { rejected: "查询词须为单行、不含控制或不可见格式字符且不超过 256 字符" };
  if (SECRET_PATTERNS.some((pattern) => pattern.test(query)) || (query.match(/[A-Za-z0-9+/=_-]{32,}/gu) ?? []).some((token) => entropy(token) >= 3.5)) {
    return { rejected: "查询词含疑似密钥" };
  }
  const user = (() => { try { return userInfo().username; } catch { return ""; } })();
  if (/(?:^|[\s"'(])(?:\/Users\/|\/home\/|\/root\/|~\/|[A-Za-z]:\\)/u.test(query) || query.includes(homedir()) || (user.length >= 3 && query.includes(user))) {
    return { rejected: "查询词含本机路径或用户目录" };
  }
  const prodWindows = windows(query, PROD_WINDOW);
  if (context.privateTexts.some((text) => prodWindows.some((window) => text.includes(window)))) return { rejected: "查询词含未关闭需求的 prod 正文片段" };
  const fileWindows = windows(query, FILE_WINDOW);
  if (fileWindows.length > 0) {
    for (const root of context.roots) {
      const args = ["-C", root, "grep", "-F", "-I", "-l", "-q", "--untracked", ...fileWindows.flatMap((window) => ["-e", window]), "--", "."];
      const found = await exec("git", args, { maxBuffer: 1 << 20 }).then(() => true, (error: { code?: number }) => {
        if (error.code === 1) return false;
        throw new WebAccessError("disclosure_check_failed", "无法核对仓库原文");
      });
      if (found) return { rejected: "查询词含仓库文件原文" };
    }
  }
  return { contentHash: createHash("sha256").update(query).digest("hex") };
}

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
function publicUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password && canonicalDomain(url.hostname) ? url : null;
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
    params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "pi-company", version: "1" } } });
  const session = init.session ?? undefined;
  await mcpCall(deps, { jsonrpc: "2.0", method: "notifications/initialized" }, session).catch(() => undefined);
  const call = await mcpCall(deps, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "web_search_exa", arguments: { query, numResults: MAX_HITS } } }, session);
  const text = (mcpResult(call.text)?.content ?? []).map((part) => part.text ?? "").join("\n");
  const hits: SearchHit[] = [];
  for (const block of text.split(/\n(?=Title:)/u)) {
    const url = /URL:\s*(\S+)/u.exec(block)?.[1];
    if (!url || !publicUrl(url)) continue;
    hits.push({ url, title: cleanText(/Title:\s*(.*)/u.exec(block)?.[1] ?? url), snippet: cleanText(block.replace(/^(Title|URL|Published Date|Author):.*$/gmu, "")).slice(0, 400) });
    if (hits.length >= MAX_HITS) break;
  }
  if (hits.length === 0) throw new WebAccessError("search_failed", "exa 未返回可用结果");
  return hits;
}

/** DuckDuckGo HTML 页兜底。 */
async function searchDuckDuckGo(deps: WebDeps, query: string): Promise<SearchHit[]> {
  const response = await deps.fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, { signal: withTimeout(TIMEOUT_MS),
    headers: { "user-agent": "Mozilla/5.0 (compatible; pi-company)", accept: "text/html" } });
  if (!response.ok) throw new WebAccessError("search_failed", `duckduckgo ${response.status}`);
  const html = await response.text(), hits: SearchHit[] = [];
  const snippets = [...html.matchAll(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gu)].map((match) => cleanText(match[1]!));
  for (const [index, match] of [...html.matchAll(/<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gu)].entries()) {
    let href = match[1]!.replace(/&amp;/gu, "&");
    if (href.startsWith("//")) href = `https:${href}`;
    const redirect = publicUrl(href);
    const target = redirect?.searchParams.get("uddg") ?? href;
    if (!publicUrl(target)) continue;
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

function privateAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    const [a, b] = address.split(".").map(Number) as [number, number];
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  if (version === 6) {
    const lower = address.toLowerCase();
    if (lower.startsWith("::ffff:")) return privateAddress(lower.slice(7));
    return lower === "::" || lower === "::1" || lower.startsWith("fc") || lower.startsWith("fd") || lower.startsWith("fe8") || lower.startsWith("fe9")
      || lower.startsWith("fea") || lower.startsWith("feb") || lower.startsWith("ff");
  }
  return true;
}

/** 连接时才解析并核验地址：解析到内网地址即拒绝连接，避免先查后连之间被改指向。 */
export function publicLookup(deps: Pick<WebDeps, "lookup">) {
  return (hostname: string, options: { all?: boolean } | undefined, callback: (error: Error | null, address?: string | Array<{ address: string; family: number }>, family?: number) => void) => {
    deps.lookup(hostname).then((addresses) => {
      const first = addresses[0];
      if (!first || addresses.some((entry) => privateAddress(entry.address))) callback(new WebAccessError("private_address", hostname));
      else if (options?.all) callback(null, addresses.map((entry) => ({ address: entry.address, family: isIP(entry.address) })));
      else callback(null, first.address, isIP(first.address));
    }, () => callback(new WebAccessError("fetch_failed", `无法解析 ${hostname}`)));
  };
}

export interface FetchResponse { status: number; headers: Record<string, string | undefined>; body: Buffer }
/** 抓取实现：缺省走 Node http/https 并在连接时用 publicLookup 核验地址。 */
export type PageGetter = (url: URL) => Promise<FetchResponse>;
export function defaultPageGetter(deps: Pick<WebDeps, "lookup">): PageGetter {
  return (url) => new Promise((resolve, reject) => {
    const client = url.protocol === "https:" ? httpsRequest : httpRequest;
    const request = client(url, { method: "GET", lookup: publicLookup(deps) as never, timeout: TIMEOUT_MS,
      headers: { "user-agent": "Mozilla/5.0 (compatible; pi-company)" } }, (response) => {
      const chunks: Buffer[] = []; let size = 0;
      response.on("data", (chunk: Buffer) => { size += chunk.length; if (size <= FETCH_MAX_BYTES) chunks.push(chunk); else response.destroy(); });
      response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: { location: response.headers.location, "content-type": response.headers["content-type"] }, body: Buffer.concat(chunks) }));
      response.on("close", () => resolve({ status: response.statusCode ?? 0, headers: { location: response.headers.location, "content-type": response.headers["content-type"] }, body: Buffer.concat(chunks) }));
      response.on("error", reject);
    });
    request.on("timeout", () => request.destroy(new WebAccessError("fetch_failed", "超时")));
    request.on("error", reject);
    request.end();
  });
}

/** 抓取已登记的搜索结果网址：连接时核验地址不在内网，逐跳复核重定向，只返回有界纯文本。 */
export async function webFetch(get: PageGetter, target: string): Promise<{ url: string; retrievedAt: number; text: string; truncated: boolean }> {
  let url = publicUrl(target);
  if (!url) throw new WebAccessError("url_rejected", target);
  if (isIP(url.hostname) || url.hostname === "localhost") throw new WebAccessError("private_address", url.hostname);
  for (let hop = 0; hop < 4; hop++) {
    const response = await get(url);
    if (response.status >= 300 && response.status < 400) {
      const next = publicUrl(new URL(response.headers.location ?? "", url).toString());
      if (!next || isIP(next.hostname) || next.hostname === "localhost") throw new WebAccessError("url_rejected", "重定向目标无效");
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
