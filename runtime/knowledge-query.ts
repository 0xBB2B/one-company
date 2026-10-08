import { createHash, randomBytes } from "node:crypto";
import type { CurrentQueryIndex, IndexedFile, IndexedSymbol, SourceFragment } from "./index-store.ts";
import { isKnowledgePath, KNOWLEDGE_QUERY_LIMITS as LIMIT, KnowledgeQueryError, parseKnowledgeQuery } from "./knowledge-query-contracts.ts";
import type { KnowledgeQuery } from "./knowledge-query-contracts.ts";

/** 查询所用索引快照：工作区、代次、覆盖范围与文件 hash。 */
export interface ProjectBaselineSnapshot {
  readonly repoId: string;
  readonly workspaceId: string;
  readonly root: string;
  readonly branch: string;
  readonly generation: number;
  readonly baselineHash: string;
  readonly observedSequence: number;
  readonly authorityEpoch: string;
  readonly coverage: {
    readonly kind: "allowed-inputs";
    readonly complete: true;
    readonly roots: readonly string[];
    readonly excludedPaths: readonly string[];
    readonly policyHash: string;
  };
  readonly files: ReadonlyArray<{ readonly path: string; readonly hash: string }>;
}

export interface KnowledgeQueryCapture {
  baseline: ProjectBaselineSnapshot;
  build: { workspaceId: string; generation: number; baselineHash: string };
}

/**
 * 每个可信 caller/连接独占 session。adapter 由宿主创建，绝不能作为模型参数反序列化。
 * captureFresh 核对当前已发布状态及全部允许输入（含增删/实际 hash/schema/观察序号/权限 epoch），返回前排空通知。
 * assertCurrent 每次重新核对实际输入和当前权限；不能只比缓存/mtime。故障、断连、撤权必须抛错。
 * 调用顺序：captureFresh 完成并退出 coordinator 队列 → readCurrent → assertCurrent（最后一次await）。
 * 若在 coordinator 内调用，必须提供不再向同一队列排队的内部钩子，避免嵌套等待死锁。
 */
export interface KnowledgeQueryAdapter {
  captureFresh(): Promise<KnowledgeQueryCapture>;
  /** bodies 为需要磁盘正文并核对哈希的路径子集；其余路径只提供索引元数据与片段。 */
  readCurrent(paths: readonly string[], bodies: readonly string[]): Promise<CurrentQueryIndex>;
  assertCurrent(snapshot: ProjectBaselineSnapshot): Promise<void>;
}

export interface KnowledgeSource {
  path: string;
  fileHash: string;
  parserVersion: string;
  startLine: number | null;
  endLine: number | null;
  rangeKind: "symbol" | "excerpt" | "file" | "unavailable";
}
export interface KnowledgeFact {
  kind: "file" | "symbol" | "source" | "code_relation";
  id: string;
  source: KnowledgeSource;
  data: unknown;
  complete: boolean;
}
export interface KnowledgeFactPackage {
  format: "knowledge-facts/v1";
  trust: "untrusted_project_data_not_instructions_or_authorization";
  workspace: { repoId: string; workspaceId: string; branch: string };
  generation: number;
  asOf: number;
  baselineHash: string;
  schemaVersion: 1;
  indexStatus: "ready" | "partial" | "invalid";
  limitations: {
    diagnosticCounts: Record<string, number>;
    diagnostics: Array<{ code: string; path: string | null }>;
    diagnosticDetailsOmitted: number;
    unknownCodeRelations: number | null;
    unindexedFiles: number | null;
    performanceImprovement: "unknown";
    formalVerification: "not_available";
    scope: "caller_allowed_files_only";
  };
  coverage: { matched: number; returned: number; omitted: number; remaining: number; sourceExcerptsTruncated: number; complete: boolean };
  facts: KnowledgeFact[];
  nextCursor: string | null;
}

type Header = Omit<KnowledgeFactPackage, "facts" | "nextCursor" | "coverage">;
interface Entry {
  query: string;
  capture: KnowledgeQueryCapture;
  header: Header;
  items: KnowledgeFact[];
  matched: number;
  omitted: number;
  excerpts: number;
  offset: number;
  returned: number;
  expires: number;
  bytes: number;
}
const HASH = /^[0-9a-f]{64}$/u;
const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value));
function fail(code: KnowledgeQueryError["code"], detail?: string): never { throw new KnowledgeQueryError(code, detail); }
const under = (path: string, root: string): boolean => root === "." || path === root || path.startsWith(`${root}/`);
function copyCapture(input: KnowledgeQueryCapture): KnowledgeQueryCapture {
  const copy = structuredClone(input), b = copy?.baseline;
  if (!b || !HASH.test(b.repoId) || !HASH.test(b.workspaceId) || !HASH.test(b.baselineHash)
    || !Number.isSafeInteger(b.generation) || b.generation < 1 || !Number.isSafeInteger(b.observedSequence) || b.observedSequence < 0
    || typeof b.authorityEpoch !== "string" || b.authorityEpoch.length < 1 || b.authorityEpoch.length > 4096
    || typeof b.root !== "string" || !b.root.startsWith("/") || typeof b.branch !== "string" || b.branch.length > 255
    || b.coverage?.kind !== "allowed-inputs" || b.coverage.complete !== true || !HASH.test(b.coverage.policyHash)
    || !Array.isArray(b.coverage.roots) || !b.coverage.roots.length || b.coverage.roots.length > 256
    || !Array.isArray(b.coverage.excludedPaths) || b.coverage.excludedPaths.length > 256
    || !b.coverage.roots.every((path) => path === "." || isKnowledgePath(path))
    || !b.coverage.excludedPaths.includes("docs/prod")
    || !Array.isArray(b.files) || b.files.length > 20_000
    || b.files.some((file) => !isKnowledgePath(file.path) || !HASH.test(file.hash)
      || !b.coverage.roots.some((root) => under(file.path, root)) || b.coverage.excludedPaths.some((path) => under(file.path, path)))
    || new Set(b.files.map((file) => file.path)).size !== b.files.length
    || copy.build.workspaceId !== b.workspaceId || copy.build.generation !== b.generation || copy.build.baselineHash !== b.baselineHash) fail("unavailable");
  return copy;
}
function sameCapture(a: KnowledgeQueryCapture, b: KnowledgeQueryCapture): boolean {
  const normalized = (value: KnowledgeQueryCapture) => ({ ...value.baseline, generation: 0,
    files: [...value.baseline.files].sort((a, b) => a.path.localeCompare(b.path)) });
  return b.baseline.generation >= a.baseline.generation && JSON.stringify(normalized(a)) === JSON.stringify(normalized(b));
}
function queryKey(query: KnowledgeQuery): string {
  const selector = query.action === "exact" ? { by: query.by, value: query.value } : { text: query.text ?? null };
  return JSON.stringify({ action: query.action, ...selector, pageSize: query.pageSize, maxBytes: query.maxBytes });
}
function excerpt(fragment: SourceFragment, text: string): { body: string; startLine: number; endLine: number; complete: boolean } {
  const found = text ? fragment.body.indexOf(text) : 0;
  // 从命中所在行开始，码点截断不会切开 emoji；CRLF 的行号按 LF 计算。
  const lineStart = found > 0 ? fragment.body.lastIndexOf("\n", found - 1) + 1 : 0;
  const prefix = fragment.body.slice(lineStart, Math.max(lineStart, found));
  const start = found > lineStart && Array.from(prefix).length > 200 ? found - Array.from(prefix).slice(-200).join("").length : lineStart;
  let body = "", cost = 0, count = 0;
  for (const point of fragment.body.slice(start)) {
    const size = Buffer.byteLength(point);
    if (count >= LIMIT.snippetCodepoints || cost + size > LIMIT.snippetBytes) break;
    body += point; cost += size; count++;
  }
  const startLine = fragment.startLine + (fragment.body.slice(0, start).match(/\n/gu)?.length ?? 0);
  return { body, startLine, endLine: startLine + (body.match(/\n/gu)?.length ?? 0), complete: start === 0 && body.length === fragment.body.length };
}

/** 有界、短时、caller/连接独占的分页缓存；close 后所有游标立即失效。 */
export class KnowledgeQuerySession {
  readonly #adapter: KnowledgeQueryAdapter;
  readonly #now: () => number;
  readonly #entries = new Map<string, Entry>();
  #closed = false;
  #busy = false;
  constructor(adapter: KnowledgeQueryAdapter, options: { now?: () => number } = {}) {
    if (!adapter || typeof adapter.captureFresh !== "function" || typeof adapter.assertCurrent !== "function" || typeof adapter.readCurrent !== "function") fail("unavailable");
    this.#adapter = adapter;
    this.#now = options.now ?? Date.now;
  }
  close(): void { this.#closed = true; this.#entries.clear(); }
  get diagnostics() { return { closed: this.#closed, sessions: this.#entries.size, bytes: [...this.#entries.values()].reduce((sum, entry) => sum + entry.bytes, 0) }; }
  #time(): number { const value = this.#now(); if (!Number.isSafeInteger(value) || value < 0) fail("unavailable"); return value; }
  async query(input: unknown): Promise<KnowledgeFactPackage> {
    const query = parseKnowledgeQuery(input);
    if (this.#closed) fail("stale");
    if (this.#busy) fail("busy");
    this.#busy = true;
    // 模型常给选填的 cursor 填全零字节的占位（base64url 下是全 A）；程序发的游标是随机字节，按第一页处理
    let cursor = query.cursor && !/^A+$/.test(query.cursor) ? query.cursor : undefined;
    try {
      const now = this.#time();
      for (const [key, value] of this.#entries) if (value.expires <= now) this.#entries.delete(key);
      let entry: Entry;
      if (cursor) {
        const cached = this.#entries.get(cursor);
        if (!cached || cached.query !== queryKey(query)) fail("invalid_cursor");
        entry = cached;
        const fresh = copyCapture(await this.#adapter.captureFresh());
        if (!sameCapture(entry.capture, fresh)) fail("stale");
      } else {
        const capture = copyCapture(await this.#adapter.captureFresh());
        entry = await this.#collect(query, capture, this.#time());
      }
      const facts: KnowledgeFact[] = [];
      let offset = entry.offset, omitted = entry.omitted;
      const makePage = (nextCursor: string | null): KnowledgeFactPackage => ({ ...entry.header,
        coverage: { matched: entry.matched, returned: entry.returned + facts.length, omitted, remaining: entry.items.length - offset,
          sourceExcerptsTruncated: entry.excerpts, complete: entry.header.indexStatus === "ready" && omitted === 0 && entry.excerpts === 0 && offset === entry.items.length },
        facts, nextCursor });
      const pendingCursor = randomBytes(32).toString("base64url");
      // 强制诊断/限制在每页保留；正文预算不足时整项省略规则，绝不截断规则后称完整。
      if (bytes(makePage(pendingCursor)) > query.maxBytes!) fail("resource_limit");
      while (offset < entry.items.length && facts.length < query.pageSize!) {
        const item = entry.items[offset]!;
        facts.push(item); offset++;
        if (bytes(makePage(pendingCursor)) > query.maxBytes!) {
          facts.pop(); offset--;
          if (facts.length) break;
          offset++; omitted++;
        }
      }
      // 返回前只经过一次当前性核对；其后不得再进行异步文件读取。
      await this.#adapter.assertCurrent(structuredClone(entry.capture.baseline));
      if (this.#closed || entry.expires <= this.#time()) fail("stale");
      const next = offset < entry.items.length ? pendingCursor : null;
      const result = makePage(next);
      if (bytes(result) > query.maxBytes! || bytes(result) > LIMIT.pageBytes) fail("resource_limit");
      if (cursor) this.#entries.delete(cursor);
      if (next) {
        entry.offset = offset; entry.returned += facts.length; entry.omitted = omitted;
        if (entry.bytes > LIMIT.cacheBytes) fail("resource_limit");
        // 未消费的旧游标按最早创建顺序淘汰，不让遗留游标拒绝新查询。
        for (const key of this.#entries.keys()) {
          const used = [...this.#entries.values()].reduce((sum, value) => sum + value.bytes, 0);
          if (this.#entries.size < LIMIT.sessions && used + entry.bytes <= LIMIT.cacheBytes) break;
          this.#entries.delete(key);
        }
        this.#entries.set(next, entry);
        cursor = next;
      }
      return structuredClone(result);
    } catch (error) {
      if (cursor) this.#entries.delete(cursor);
      if (error instanceof KnowledgeQueryError) throw error;
      fail("unavailable", (error as Error).message);
    } finally { this.#busy = false; }
  }

  async #collect(query: KnowledgeQuery, capture: KnowledgeQueryCapture, asOf: number): Promise<Entry> {
    const baseline = capture.baseline;
    const paths = baseline.files.map((file) => file.path);
    const index = await this.#adapter.readCurrent(paths, []);
    if (index.status.workspaceId !== baseline.workspaceId || index.status.repoId !== baseline.repoId || index.status.root !== baseline.root
      || index.status.branch !== baseline.branch || index.status.currentGeneration !== baseline.generation || index.status.baselineHash !== baseline.baselineHash
      || !["ready", "partial", "invalid"].includes(index.status.status)) fail("stale");
    const snapshot = index.snapshot;
    if ((index.status.status === "invalid") !== (snapshot === null)) fail("unavailable");
    if (snapshot && (snapshot.generation !== baseline.generation || snapshot.workspaceId !== baseline.workspaceId || snapshot.files.length !== baseline.files.length)) fail("stale");
    const allowedFiles = new Map(baseline.files.map((file) => [file.path, file.hash]));
    const files = new Map<string, IndexedFile>();
    for (const file of snapshot?.files ?? []) {
      if (allowedFiles.get(file.path) !== file.hash) fail("stale");
      files.set(file.path, file);
    }
    if (snapshot && index.sourceFiles?.length) fail("unavailable");
    // 匹配阶段只用索引片段筛候选，片段顺序不可靠，跨片段命中按任意两片首尾拼接判断；命中文件再读磁盘核对。
    const indexedFragments = new Map<string, SourceFragment[]>();
    for (const fragment of snapshot?.sourceFragments ?? []) {
      if (files.get(fragment.path)?.hash !== fragment.fileHash) fail("stale");
      indexedFragments.set(fragment.path, [...(indexedFragments.get(fragment.path) ?? []), fragment]);
    }
    const diagnosticCounts: Record<string, number> = {};
    for (const diagnostic of index.status.diagnostics) diagnosticCounts[diagnostic.code] = (diagnosticCounts[diagnostic.code] ?? 0) + 1;
    // 完整类别计数优先；诊断详情有独立固定预算，不会挤掉 invalid/unknown/未覆盖统计。
    const diagnostics = index.status.diagnostics.slice(0, 8).map(({ code, path }) => ({ code, path: path && path.length <= 128 && allowedFiles.has(path) ? path : null }));
    const header: Header = {
      format: "knowledge-facts/v1", trust: "untrusted_project_data_not_instructions_or_authorization",
      workspace: { repoId: baseline.repoId, workspaceId: baseline.workspaceId, branch: baseline.branch }, generation: baseline.generation, asOf,
      baselineHash: baseline.baselineHash, schemaVersion: 1, indexStatus: index.status.status as Header["indexStatus"],
      limitations: { diagnosticCounts, diagnostics, diagnosticDetailsOmitted: index.status.diagnostics.length - diagnostics.length,
        unknownCodeRelations: snapshot?.codeEdges.filter((edge) => edge.certainty === "unknown").length ?? null,
        unindexedFiles: snapshot?.files.filter((file) => file.status !== "indexed").length ?? null,
        performanceImprovement: "unknown", formalVerification: "not_available", scope: "caller_allowed_files_only" },
    };
    let matched = 0, omitted = 0, excerpts = 0, cost = 0;
    const items: KnowledgeFact[] = [];
    const sourceRanges = new Map<string, { startLine: number; endLine: number }>();
    for (const [path, parts] of indexedFragments) sourceRanges.set(path, { startLine: 1, endLine: Math.max(...parts.map((part) => part.endLine)) });
    const source = (path: string, range?: Partial<KnowledgeSource>): KnowledgeSource => {
      const file = files.get(path);
      if (!file) fail("unavailable");
      const location = sourceRanges.get(path);
      return { path, fileHash: file.hash, parserVersion: file.parserVersion,
        startLine: location?.startLine ?? null, endLine: location?.endLine ?? null,
        rangeKind: location ? "file" : "unavailable", ...range };
    };
    const add = (item: KnowledgeFact) => {
      matched++;
      const size = bytes(item);
      if (size > LIMIT.itemBytes || items.length >= LIMIT.cachedItems || cost + size > LIMIT.cacheBytes / 2) { omitted++; return; }
      cost += size; items.push(item);
    };
    const text = query.action === "exact" ? "" : query.text ?? "";
    const literal = (values: string[]) => !text || values.some((value) => value.includes(text));
    const selected = (kind: string, item: { id?: string; path: string; name?: string }, values: string[]) => query.action !== "exact" ? literal(values)
      : query.by === "path" ? item.path === query.value : query.by === "id" ? item.id === query.value : kind === "symbol" && item.name === query.value;
    const addSymbol = (item: IndexedSymbol) =>
      add({ kind: "symbol", id: item.id, source: source(item.path, { startLine: item.startLine, endLine: item.endLine, rangeKind: "symbol" }), data: item, complete: true });
    for (const symbol of snapshot?.symbols ?? []) if (selected("symbol", symbol, [symbol.id, symbol.name, symbol.path])) addSymbol(symbol);
    const chosenSymbols = new Set(items.filter((item) => item.kind === "symbol").map((item) => item.id));
    for (const edge of snapshot?.codeEdges ?? []) if (edge.path && (selected("code_relation", edge as { id: string; path: string }, [edge.name ?? "", edge.path])
      || chosenSymbols.has(edge.fromSymbolId ?? "") || chosenSymbols.has(edge.toSymbolId ?? ""))) {
      add({ kind: "code_relation", id: edge.id, source: source(edge.path, { startLine: edge.startLine ?? null, endLine: edge.endLine ?? null, rangeKind: edge.startLine ? "symbol" : "unavailable" }), data: edge, complete: true });
    }
    for (const file of files.values()) if (selected("file", file, [file.path])) add({ kind: "file", id: file.path, source: source(file.path), data: file, complete: true });
    const spanning = (parts: SourceFragment[]): boolean => {
      const edge = Array.from(text).length - 1;
      if (edge < 1 || parts.length < 2) return false;
      const edges = parts.map((part) => { const points = Array.from(part.body); return { head: points.slice(0, edge).join(""), tail: points.slice(-edge).join("") }; });
      return edges.some((a, i) => edges.some((b, j) => i !== j && (a.tail + b.head).includes(text)));
    };
    const candidates: string[] = [];
    for (const [path, parts] of indexedFragments) {
      if (selected("source", { path }, [path, ...parts.map((part) => part.body)]) || (query.action !== "exact" && spanning(parts))) candidates.push(path);
    }
    // 超出缓存条数上限的命中不读磁盘，直接按省略计数；字节上限仍在 add 内核对。
    const wanted = candidates.slice(0, Math.max(0, LIMIT.cachedItems - items.length));
    for (let index = wanted.length; index < candidates.length; index++) { matched++; omitted++; }
    const verified = wanted.length ? await this.#adapter.readCurrent(paths, wanted) : null;
    if (verified && (verified.status.version !== index.status.version || verified.status.currentGeneration !== baseline.generation)) fail("stale");
    const sourceFiles = verified?.sourceFiles ?? [];
    if (sourceFiles.length !== wanted.length) fail("unavailable");
    let sourceBytes = 0;
    const sourcePaths = new Set<string>();
    for (const file of sourceFiles) {
      sourceBytes += Buffer.byteLength(file.body);
      if (sourceBytes > 20 * 1024 * 1024 || sourcePaths.has(file.path) || !wanted.includes(file.path) || file.startLine !== 1
        || file.endLine !== 1 + (file.body.match(/\n/gu)?.length ?? 0)
        || files.get(file.path)?.kind !== file.kind || files.get(file.path)?.hash !== file.fileHash
        || createHash("sha256").update(file.body).digest("hex") !== file.fileHash) fail("unavailable");
      sourcePaths.add(file.path);
    }
    for (const fragment of sourceFiles) {
      if (!selected("source", fragment, [fragment.body, fragment.path, fragment.title ?? ""])) continue;
      const part = excerpt(fragment, text);
      if (!part.complete) excerpts++;
      add({ kind: "source", id: fragment.id, source: source(fragment.path, { startLine: part.startLine, endLine: part.endLine, rangeKind: "excerpt" }), data: { body: part.body, kind: fragment.kind }, complete: part.complete });
    }
    return { query: queryKey(query), capture, header, items, matched, omitted, excerpts, offset: 0, returned: 0, expires: asOf + LIMIT.ttlMs, bytes: cost + bytes(header) + bytes(capture) };
  }
}
