import { createHash, randomBytes } from "node:crypto";
import type { CurrentQueryIndex, IndexedFile, IndexedSymbol, IndexedRule, IndexedFeature, SourceFragment } from "./index-store.ts";
import type { ProjectBaselineSnapshot } from "./project-baseline.ts";
import type { ProjectIndexSpecSummary } from "./project-index-service.ts";
import { isKnowledgePath, KNOWLEDGE_QUERY_LIMITS as LIMIT, KnowledgeQueryError, parseKnowledgeQuery } from "./knowledge-query-contracts.ts";
import type { KnowledgeQuery } from "./knowledge-query-contracts.ts";

/** 由 ensureFresh 后的同代次 build result 提供，禁止将 baselineHash 当作 contractSetHash。 */
export interface KnowledgeQueryCapture {
  baseline: ProjectBaselineSnapshot;
  build: { workspaceId: string; generation: number; baselineHash: string; spec: ProjectIndexSpecSummary };
}

/** 只接受可信服务的固定无正文记录；本内核不读取报告、命令或会话，也不签发 formal 通过。 */
export interface KnowledgeEvidenceMetadata {
  runId: string;
  kind: "legacy" | "debug" | "formal";
  result: "pass" | "fail" | "cancelled" | "unknown";
  verificationId?: string;
  verificationInputHash?: string;
}
export interface KnowledgeRequirementMetadata {
  requirementId: string;
  workspaceId: string;
  branch: string;
  lifecycle: "active" | "closing" | "closed";
  approvedProdHash?: string;
  lifecycleEpoch?: number;
  targetSpecSetHash?: string;
}

/**
 * 每个可信 caller/连接独占 session。adapter 由宿主创建，绝不能作为模型参数反序列化。
 * captureFresh 核对当前已发布状态及全部允许输入（含增删/实际 hash/schema/观察序号/权限 epoch），返回前排空通知。
 * assertCurrent 每次重新核对实际输入和当前权限；不能只比缓存/mtime。故障、断连、撤权必须抛错。
 * finalCheck 是联合返回门槛：绑定预期需求元数据/epoch、源码、观察序号与当前授权；
 * 所有异步读取结束后以同一协调范围内的同步失效/撤权栅栏核对，不能仅顺序await两种独立检查。
 * 提供 requirementMetadata 时必须提供 finalCheck；没有需求适配器时可仅用 assertCurrent。
 * 调用顺序：captureFresh 完成并退出 coordinator 队列 → readCurrent/元数据 → finalCheck（最后一次await）。
 * 若在 coordinator 内调用，必须提供不再向同一队列排队的内部钩子，避免嵌套等待死锁。
 */
export interface KnowledgeQueryAdapter {
  captureFresh(): Promise<KnowledgeQueryCapture>;
  readCurrent(paths: readonly string[]): Promise<CurrentQueryIndex>;
  assertCurrent(snapshot: ProjectBaselineSnapshot): Promise<void>;
  evidenceMetadata?(): Promise<readonly KnowledgeEvidenceMetadata[]>;
  requirementMetadata?(): Promise<KnowledgeRequirementMetadata | null>;
  finalCheck?(expected: { baseline: ProjectBaselineSnapshot; requirementMetadata: KnowledgeRequirementMetadata | null }): Promise<void>;
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
  kind: "file" | "symbol" | "feature" | "rule" | "source" | "code_relation" | "rule_relation";
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
  schemaHash: string | null;
  contractSetHash: string | null;
  specStatus: ProjectIndexSpecSummary["status"];
  indexStatus: "ready" | "partial" | "invalid";
  limitations: {
    diagnosticCounts: Record<string, number>;
    diagnostics: Array<{ code: string; path: string | null }>;
    diagnosticDetailsOmitted: number;
    unknownCodeRelations: number | null;
    unindexedFiles: number | null;
    codeRuleBindings: "not_available";
    performanceImprovement: "unknown";
    formalVerification: "not_available";
    scope: "caller_allowed_files_only";
  };
  coverage: { matched: number; returned: number; omitted: number; remaining: number; sourceExcerptsTruncated: number; complete: boolean };
  evidence: { status: "not_available" | "metadata_only"; records: Array<KnowledgeEvidenceMetadata & { applicability: "unknown"; currentPass: false }>; omitted: number };
  requirement: { requirementId: string; lifecycle: "active" | "closing" | "closed"; approvedProdHash?: string; lifecycleEpoch?: number; targetSpecSetHash?: string } | null;
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
  requirementMetadata?: KnowledgeRequirementMetadata | null;
  expires: number;
  bytes: number;
}
const HASH = /^[0-9a-f]{64}$/u;
const idText = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 256 && /^[\p{L}\p{N}._:/#@+-]+$/u.test(value);
const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value));
function fail(code: KnowledgeQueryError["code"]): never { throw new KnowledgeQueryError(code); }
const under = (path: string, root: string): boolean => root === "." || path === root || path.startsWith(`${root}/`);
function copyCapture(input: KnowledgeQueryCapture): KnowledgeQueryCapture {
  const copy = structuredClone(input), b = copy?.baseline, spec = copy?.build?.spec;
  if (!b || !spec || !HASH.test(b.repoId) || !HASH.test(b.workspaceId) || !HASH.test(b.baselineHash)
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
    || copy.build.workspaceId !== b.workspaceId || copy.build.generation !== b.generation || copy.build.baselineHash !== b.baselineHash
    || !["valid", "absent", "invalid"].includes(spec.status)
    || (spec.schemaHash !== null && !HASH.test(spec.schemaHash)) || (spec.contractSetHash !== null && !HASH.test(spec.contractSetHash))
    || (spec.status === "valid" && (!spec.schemaHash || !spec.contractSetHash))
    || (spec.status !== "valid" && spec.contractSetHash !== null)
    || (spec.status === "absent" && spec.schemaHash !== null)) fail("unavailable");
  return copy;
}
function sameCapture(a: KnowledgeQueryCapture, b: KnowledgeQueryCapture): boolean {
  const normalized = (value: KnowledgeQueryCapture) => ({ ...value.baseline, generation: 0,
    files: [...value.baseline.files].sort((a, b) => a.path.localeCompare(b.path)),
    spec: value.build.spec });
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
function fixedEvidence(values: readonly KnowledgeEvidenceMetadata[]): Header["evidence"] {
  if (!Array.isArray(values) || values.length > 1000) fail("unavailable");
  for (const value of values) {
    if (!value || Object.keys(value).some((key) => !["runId", "kind", "result", "verificationId", "verificationInputHash"].includes(key))
      || !idText(value.runId) || !["legacy", "debug", "formal"].includes(value.kind) || !["pass", "fail", "cancelled", "unknown"].includes(value.result)
      || (value.verificationId !== undefined && !idText(value.verificationId)) || (value.verificationInputHash !== undefined && !HASH.test(value.verificationInputHash))) fail("unavailable");
  }
  // 元数据不是 formal 阶段、原始输入及当前适用性的证明；即使标注 PASS 也保持 unknown。
  const ordered = [...values].sort((a, b) => Number(a.result === "pass") - Number(b.result === "pass"));
  return { status: "metadata_only", records: ordered.slice(0, 4).map((value) => ({ ...value, applicability: "unknown", currentPass: false })), omitted: Math.max(0, values.length - 4) };
}
function fixedRequirement(value: KnowledgeRequirementMetadata | null, baseline: ProjectBaselineSnapshot): Header["requirement"] {
  if (value === null) return null;
  if (!value || Object.keys(value).some((key) => !["requirementId", "workspaceId", "branch", "lifecycle", "approvedProdHash", "lifecycleEpoch", "targetSpecSetHash"].includes(key))
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value.requirementId)
    || value.workspaceId !== baseline.workspaceId || value.branch !== baseline.branch || !["active", "closing", "closed"].includes(value.lifecycle)) fail("unavailable");
  if (value.lifecycle !== "active") return { requirementId: value.requirementId, lifecycle: value.lifecycle };
  if (!value.approvedProdHash || !HASH.test(value.approvedProdHash) || !Number.isSafeInteger(value.lifecycleEpoch) || value.lifecycleEpoch! < 1
    || (value.targetSpecSetHash !== undefined && !HASH.test(value.targetSpecSetHash))) fail("unavailable");
  return { requirementId: value.requirementId, lifecycle: value.lifecycle, approvedProdHash: value.approvedProdHash,
    lifecycleEpoch: value.lifecycleEpoch, ...(value.targetSpecSetHash ? { targetSpecSetHash: value.targetSpecSetHash } : {}) };
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
    if (adapter.requirementMetadata && typeof adapter.finalCheck !== "function") fail("unavailable");
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
    let cursor = query.cursor;
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
        if (this.#entries.size >= LIMIT.sessions) fail("resource_limit");
        const capture = copyCapture(await this.#adapter.captureFresh());
        entry = await this.#collect(query, capture, this.#time());
      }
      // 每一页都重新读取元数据适配器；不能缓存已关闭目标或旧证据授权。
      entry.header.evidence = this.#adapter.evidenceMetadata ? fixedEvidence(await this.#adapter.evidenceMetadata()) : { status: "not_available", records: [], omitted: 0 };
      const requirementMetadata = this.#adapter.requirementMetadata ? structuredClone(await this.#adapter.requirementMetadata()) : null;
      const requirement = fixedRequirement(requirementMetadata, entry.capture.baseline);
      if (cursor && JSON.stringify(requirementMetadata) !== JSON.stringify(entry.requirementMetadata)) fail("stale");
      entry.requirementMetadata = requirementMetadata;
      entry.header.requirement = requirement;
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
      // 返回前只经过一个可信联合门槛；其后不得再进行异步元数据/文件读取。
      if (this.#adapter.finalCheck) await this.#adapter.finalCheck(structuredClone({ baseline: entry.capture.baseline, requirementMetadata }));
      else {
        if (this.#adapter.requirementMetadata) fail("unavailable");
        await this.#adapter.assertCurrent(structuredClone(entry.capture.baseline));
      }
      if (this.#closed || entry.expires <= this.#time()) fail("stale");
      const next = offset < entry.items.length ? pendingCursor : null;
      const result = makePage(next);
      if (bytes(result) > query.maxBytes! || bytes(result) > LIMIT.pageBytes) fail("resource_limit");
      if (cursor) this.#entries.delete(cursor);
      if (next) {
        entry.offset = offset; entry.returned += facts.length; entry.omitted = omitted;
        const used = [...this.#entries.values()].reduce((sum, value) => sum + value.bytes, 0);
        if (used + entry.bytes > LIMIT.cacheBytes) fail("resource_limit");
        this.#entries.set(next, entry);
        cursor = next;
      }
      return structuredClone(result);
    } catch (error) {
      if (cursor) this.#entries.delete(cursor);
      if (error instanceof KnowledgeQueryError) throw error;
      fail("unavailable");
    } finally { this.#busy = false; }
  }

  async #collect(query: KnowledgeQuery, capture: KnowledgeQueryCapture, asOf: number): Promise<Entry> {
    const baseline = capture.baseline;
    const index = await this.#adapter.readCurrent(baseline.files.map((file) => file.path));
    if (index.status.workspaceId !== baseline.workspaceId || index.status.repoId !== baseline.repoId || index.status.root !== baseline.root
      || index.status.branch !== baseline.branch || index.status.currentGeneration !== baseline.generation || index.status.baselineHash !== baseline.baselineHash
      || !["ready", "partial", "invalid"].includes(index.status.status)) fail("stale");
    const snapshot = index.snapshot;
    if ((index.status.status === "invalid") !== (snapshot === null) || (capture.build.spec.status === "invalid") !== (index.status.status === "invalid")) fail("unavailable");
    if (snapshot && (snapshot.generation !== baseline.generation || snapshot.workspaceId !== baseline.workspaceId || snapshot.files.length !== baseline.files.length)) fail("stale");
    const allowedFiles = new Map(baseline.files.map((file) => [file.path, file.hash]));
    const files = new Map<string, IndexedFile>();
    for (const file of snapshot?.files ?? []) {
      if (allowedFiles.get(file.path) !== file.hash) fail("stale");
      files.set(file.path, file);
    }
    // 同路径/hash的已核验完整文件视图避免把哈希ID或相同行号误当片段顺序。
    const sourceFiles = index.sourceFiles ?? [];
    if (snapshot && (!index.sourceFiles || sourceFiles.length !== files.size)) fail("unavailable");
    let sourceBytes = 0;
    const sourcePaths = new Set<string>();
    for (const file of sourceFiles) {
      sourceBytes += Buffer.byteLength(file.body);
      if (sourceBytes > 20 * 1024 * 1024 || sourcePaths.has(file.path) || file.startLine !== 1
        || file.endLine !== 1 + (file.body.match(/\n/gu)?.length ?? 0)
        || files.get(file.path)?.kind !== file.kind || files.get(file.path)?.hash !== file.fileHash
        || createHash("sha256").update(file.body).digest("hex") !== file.fileHash) fail("unavailable");
      sourcePaths.add(file.path);
    }
    const diagnosticCounts: Record<string, number> = {};
    for (const diagnostic of index.status.diagnostics) diagnosticCounts[diagnostic.code] = (diagnosticCounts[diagnostic.code] ?? 0) + 1;
    // 完整类别计数优先；诊断详情有独立固定预算，不会挤掉 invalid/unknown/未覆盖统计。
    const diagnostics = index.status.diagnostics.slice(0, 8).map(({ code, path }) => ({ code, path: path && path.length <= 128 && allowedFiles.has(path) ? path : null }));
    const header: Header = {
      format: "knowledge-facts/v1", trust: "untrusted_project_data_not_instructions_or_authorization",
      workspace: { repoId: baseline.repoId, workspaceId: baseline.workspaceId, branch: baseline.branch }, generation: baseline.generation, asOf,
      baselineHash: baseline.baselineHash, schemaVersion: 1, schemaHash: capture.build.spec.schemaHash, contractSetHash: capture.build.spec.contractSetHash,
      specStatus: capture.build.spec.status, indexStatus: index.status.status as Header["indexStatus"],
      limitations: { diagnosticCounts, diagnostics, diagnosticDetailsOmitted: index.status.diagnostics.length - diagnostics.length,
        unknownCodeRelations: snapshot?.codeEdges.filter((edge) => edge.certainty === "unknown").length ?? null,
        unindexedFiles: snapshot?.files.filter((file) => file.status !== "indexed").length ?? null,
        codeRuleBindings: "not_available", performanceImprovement: "unknown", formalVerification: "not_available", scope: "caller_allowed_files_only" },
      evidence: { status: "not_available", records: [], omitted: 0 }, requirement: null,
    };
    let matched = 0, omitted = 0, excerpts = 0, cost = 0;
    const items: KnowledgeFact[] = [];
    const sourceRanges = new Map<string, { startLine: number; endLine: number }>();
    for (const fragment of sourceFiles) {
      const previous = sourceRanges.get(fragment.path);
      sourceRanges.set(fragment.path, { startLine: Math.min(previous?.startLine ?? fragment.startLine, fragment.startLine),
        endLine: Math.max(previous?.endLine ?? fragment.endLine, fragment.endLine) });
    }
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
    const featureMatch = new Set<string>();
    for (const feature of snapshot?.features ?? []) if (selected("feature", feature, [feature.id, feature.title, ...feature.aliases])) featureMatch.add(feature.id);
    const addEntity = (kind: "symbol" | "rule" | "feature", item: IndexedSymbol | IndexedRule | IndexedFeature) => {
      const range = kind === "symbol" ? { startLine: (item as IndexedSymbol).startLine, endLine: (item as IndexedSymbol).endLine, rangeKind: "symbol" as const } : undefined;
      add({ kind, id: item.id, source: source(item.path, range), data: item, complete: true });
    };
    for (const rule of snapshot?.rules ?? []) if (selected("rule", rule, [rule.id, rule.title, rule.condition, rule.trigger, rule.expected, rule.reason, ...rule.acceptance.flatMap((value) => [value.given, value.when, value.then])])
      || (query.action !== "exact" && featureMatch.has(rule.featureId))) addEntity("rule", rule);
    for (const feature of snapshot?.features ?? []) if (featureMatch.has(feature.id)) addEntity("feature", feature);
    for (const symbol of snapshot?.symbols ?? []) if (selected("symbol", symbol, [symbol.id, symbol.name, symbol.path])) addEntity("symbol", symbol);
    const chosenSymbols = new Set(items.filter((item) => item.kind === "symbol").map((item) => item.id));
    const chosenRules = new Set(items.filter((item) => item.kind === "rule").map((item) => item.id));
    for (const edge of snapshot?.codeEdges ?? []) if (edge.path && (selected("code_relation", edge as { id: string; path: string }, [edge.name ?? "", edge.path])
      || chosenSymbols.has(edge.fromSymbolId ?? "") || chosenSymbols.has(edge.toSymbolId ?? ""))) {
      add({ kind: "code_relation", id: edge.id, source: source(edge.path, { startLine: edge.startLine ?? null, endLine: edge.endLine ?? null, rangeKind: edge.startLine ? "symbol" : "unavailable" }), data: edge, complete: true });
    }
    for (const edge of snapshot?.ruleEdges ?? []) if (chosenRules.has(edge.fromRuleId) || chosenRules.has(edge.toRuleId)) {
      const rule = snapshot!.rules.find((rule) => rule.id === edge.fromRuleId)!;
      add({ kind: "rule_relation", id: edge.id, source: source(rule.path), data: edge, complete: true });
    }
    for (const file of files.values()) if (selected("file", file, [file.path])) add({ kind: "file", id: file.path, source: source(file.path), data: file, complete: true });
    for (const fragment of sourceFiles) {
      if (fragment.fileHash !== files.get(fragment.path)?.hash) fail("stale");
      if (!selected("source", fragment, [fragment.body, fragment.path, fragment.title ?? ""])) continue;
      const part = excerpt(fragment, text);
      if (!part.complete) excerpts++;
      add({ kind: "source", id: fragment.id, source: source(fragment.path, { startLine: part.startLine, endLine: part.endLine, rangeKind: "excerpt" }), data: { body: part.body, kind: fragment.kind }, complete: part.complete });
    }
    return { query: queryKey(query), capture, header, items, matched, omitted, excerpts, offset: 0, returned: 0, expires: asOf + LIMIT.ttlMs, bytes: cost + bytes(header) + bytes(capture) };
  }
}
