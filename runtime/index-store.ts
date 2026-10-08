import { createHash } from "node:crypto";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { lstatSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { hasInvalidTransactionOrigin } from "./transaction-context.ts";
import {
  InvalidIndexQueryError,
  LocalDatabase,
  StaleVersionError,
  UUID_V7_PATTERN,
  uuidv7,
} from "./database.ts";
import type { StoredRecord } from "./database.ts";
import { assertDatabasePathReady, assertRegularDatabaseFiles, DATABASE_APPLICATION_IDS, databaseKind } from "./database-paths.ts";

const HASH = /^[0-9a-f]{64}$/;
const ENTITY_ID = /^[\p{L}\p{N}][\p{L}\p{N}._:/#@+-]{0,255}$/u;
const MAX_FILES = 20_000;
const MAX_SYMBOLS = 100_000;
const MAX_EDGES = 200_000;
const MAX_FRAGMENTS = 100_000;
const MAX_FRAGMENT_CODEPOINTS = 131_072;
const MAX_INDEXED_CODEPOINTS = 20 * 1024 * 1024;
const MAX_SEARCH_LIMIT = 20;
const MAX_SEARCH_QUERY_CODEPOINTS = 256;
const MAX_SEARCH_SNIPPET_CODEPOINTS = 800;
const MAX_SEARCH_OUTPUT_CODEPOINTS = 24_000;

const ENTITY_NAMESPACES = [
  "files", "symbols", "code_edges", "source_fragments", "prod_metadata",
] as const;

type EntityNamespace = typeof ENTITY_NAMESPACES[number];
export type IndexState = "building" | "dirty" | "cancelled" | "interrupted" | "ready" | "partial" | "invalid";
export type PublishedIndexState = Extract<IndexState, "ready" | "partial" | "invalid">;
export type IndexedFileKind = "code" | "document" | "config";

export interface WorkspaceIdentity {
  workspaceId: string;
  repoId: string;
  root: string;
  branch: string;
}

export interface IndexDiagnostic {
  code: "syntax_error" | "unsupported_language" | "unreadable" | "budget_exceeded" | "parser_unavailable" | "unknown";
  path: string | null;
}

export interface IndexedFile {
  path: string;
  hash: string;
  parserVersion: string;
  status: "indexed" | "unsupported" | "parse_error" | "invalid" | "skipped";
  kind: IndexedFileKind;
  language: string | null;
  symbolIds: string[];
}

export interface IndexedSymbol {
  id: string;
  path: string;
  name: string;
  kind: "function" | "class" | "method" | "type" | "interface" | "variable" | "constant" | "module" | "export" | "import" | "unknown";
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  /** UTF-16半开区间；存在时必须成对提供。 */
  startOffset?: number;
  endOffset?: number;
}

export type CodeEdgeEvidence = "call_expression" | "new_expression" | "import_clause" | "export_clause" | "identifier_reference" | "member_reference" | "type_reference" | "unknown";

export interface IndexedCodeEdge {
  id: string;
  fromSymbolId: string | null;
  toSymbolId: string | null;
  kind: "calls" | "imports" | "exports" | "references" | "extends" | "implements" | "unknown";
  certainty: "certain" | "unknown";
  /** 引用位置依据为一个完整可选组；不能只提供其中部分字段。 */
  name?: string | null;
  evidence?: CodeEdgeEvidence;
  path?: string;
  startLine?: number;
  startColumn?: number;
  endLine?: number;
  endColumn?: number;
}

export interface SourceFragment {
  id: string;
  path: string;
  kind: IndexedFileKind;
  language: string | null;
  title: string | null;
  body: string;
  startLine: number;
  endLine: number;
  fileHash: string;
}

export interface LocalProdMetadata {
  requirementId: string;
  source: "local";
  path: string;
  fileName: "prod.md";
  lifecycle: "draft" | "active" | "closing" | "closed";
  epoch: number;
  hash: string | null;
}

export interface ArchiveProdMetadata {
  requirementId: string;
  source: "archive";
  path: string;
  fileName: string;
  lifecycle: "unknown";
  epoch: null;
  hash: null;
}

export type ProdMetadata = LocalProdMetadata | ArchiveProdMetadata;

export interface IndexPublication {
  status: PublishedIndexState;
  diagnostics: IndexDiagnostic[];
  files: IndexedFile[];
  symbols: IndexedSymbol[];
  codeEdges: IndexedCodeEdge[];
  sourceFragments: SourceFragment[];
  prodMetadata: ProdMetadata[];
}

export interface IndexBuildToken {
  workspaceId: string;
  operationId: string;
  fence: number;
  baseGeneration: number;
  targetGeneration: number;
  workspaceVersion: number;
}

export interface IndexWorkspaceStatus extends WorkspaceIdentity {
  status: IndexState;
  version: number;
  fence: number;
  currentGeneration: number;
  targetGeneration: number;
  baselineHash: string | null;
  diagnostics: IndexDiagnostic[];
  updatedAt: number;
}

export interface IndexSnapshot extends WorkspaceIdentity {
  status: "ready" | "partial";
  generation: number;
  diagnostics: IndexDiagnostic[];
  files: IndexedFile[];
  symbols: IndexedSymbol[];
  codeEdges: IndexedCodeEdge[];
  sourceFragments: SourceFragment[];
  prodMetadata: ProdMetadata[];
}

export interface CurrentQueryIndex {
  status: IndexWorkspaceStatus;
  /** 服务逐文件授权及hash核对后提供的完整文件视图；不依赖持久片段的ID/排序。 */
  sourceFiles?: SourceFragment[];
  /** invalid 只提供诊断；普通查询不能回退旧正文。 */
  snapshot: (Omit<IndexSnapshot, "prodMetadata" | "codeEdges"> & {
    codeEdges: Array<IndexedCodeEdge & { sourceCertainty?: IndexedCodeEdge["certainty"]; targetOutsideScope?: boolean }>;
  }) | null;
}

export interface IndexSearchResult {
  fragmentId: string;
  path: string;
  kind: IndexedFileKind;
  snippet: string;
  rank: number;
}

export interface IndexSearchResponse {
  results: IndexSearchResult[];
  truncated: boolean;
}

export class IndexStoreError extends Error {
  readonly code: "wrong_database_kind" | "invalid_identity" | "invalid_input" | "invalid_path" | "metadata_body_forbidden" | "no_index" | "index_not_ready" | "stale_build" | "invalid_fts_query" | "budget_exceeded" | "invalid_index_state";
  constructor(code: IndexStoreError["code"]) {
    const messages: Record<IndexStoreError["code"], string> = {
      wrong_database_kind: "索引存储只允许使用index.db",
      invalid_identity: "工作区身份无效",
      invalid_input: "索引发布数据格式无效",
      invalid_path: "索引路径无效或属于禁止范围",
      metadata_body_forbidden: "需求元数据只能保存固定无正文字段",
      no_index: "该工作区尚无索引",
      index_not_ready: "该工作区当前没有可用索引",
      stale_build: "索引构建已被更新的构建代次取代",
      invalid_fts_query: "索引搜索语法无效",
      budget_exceeded: "索引输入或输出超过固定预算",
      invalid_index_state: "持久索引状态无效，需要重建",
    };
    super(messages[code]);
    this.name = "IndexStoreError";
    this.code = code;
  }
}

interface WorkspaceRow extends WorkspaceIdentity {
  format: "index-workspace/v1";
  status: IndexState;
  fence: number;
  currentGeneration: number;
  targetGeneration: number;
  operationId: string;
  baselineHash: string | null;
  diagnostics: IndexDiagnostic[];
  updatedAt: number;
}

interface GenerationRow {
  format: "index-generation/v1";
  workspaceId: string;
  operationId: string;
  fence: number;
  baseGeneration: number;
  targetGeneration: number;
  state: IndexState;
  updatedAt: number;
}

type WorkspaceEntity<T> = T & { workspaceId: string; generation: number };

function fail(code: IndexStoreError["code"] = "invalid_input"): never { throw new IndexStoreError(code); }
/** 查询只拒绝不安全权限，不chmod、不创建或升级数据库。 */
function assertPrivateQueryStorage(databasePath: string): void {
  assertRegularDatabaseFiles(databasePath);
  const directory = lstatSync(dirname(databasePath));
  if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o077) !== 0
    || (process.getuid && directory.uid !== process.getuid())) fail("invalid_index_state");
  for (const path of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
    let stats;
    try { stats = lstatSync(path); }
    catch (error) {
      if (path !== databasePath && (error as NodeJS.ErrnoException).code === "ENOENT") continue;
      fail("invalid_index_state");
    }
    if ((stats.mode & 0o077) !== 0) fail("invalid_index_state");
  }
}
function plain(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function exact(value: unknown, keys: readonly string[], code: IndexStoreError["code"] = "invalid_input"): Record<string, unknown> {
  if (!plain(value)) fail(code);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) fail(code);
  return value;
}
function text(value: unknown, max: number, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0) || Array.from(value).length > max || /[\u0000]/u.test(value)) fail();
  return value;
}
function entityId(value: unknown): string {
  const result = text(value, 256);
  if (!ENTITY_ID.test(result)) fail();
  return result;
}
function digest(value: unknown): string { if (typeof value !== "string" || !HASH.test(value)) fail(); return value; }
function integer(value: unknown, minimum = 0): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) fail();
  return Number(value);
}
function oneOf<T extends string>(value: unknown, values: readonly T[]): T {
  if (typeof value !== "string" || !values.includes(value as T)) fail();
  return value as T;
}
function array(value: unknown, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) fail(value && maximum === MAX_FRAGMENTS ? "budget_exceeded" : "invalid_input");
  return value;
}
function uniqueStrings(value: unknown, maximum: number, item: (value: unknown) => string = entityId): string[] {
  const result = array(value, maximum).map(item);
  if (new Set(result).size !== result.length) fail();
  return result;
}
function normalizedRelativePath(value: unknown, allowProdMetadata = false): string {
  const path = text(value, 4096);
  if (path.startsWith("/") || path.includes("\\") || path.includes("//") || /[\u0000-\u001f\u007f]/u.test(path)) fail("invalid_path");
  const parts = path.split("/"), folded = parts.map((part) => part.toLowerCase());
  if (parts.some((part) => !part || part === "." || part === "..") || folded.includes(".git")) fail("invalid_path");
  if (!allowProdMetadata && folded[0] === "docs" && folded[1] === "prod") fail("invalid_path");
  return path;
}
function safeFileName(value: unknown): string {
  const name = text(value, 255);
  if (name === "." || name === ".." || /[\u0000-\u001f\u007f/\\]/u.test(name)) fail("invalid_path");
  return name;
}
function boundedText(value: unknown, max = 1_500): string { return text(value, max, true); }
function nullableText(value: unknown, max: number): string | null { return value === null ? null : text(value, max, true); }
function nullableHash(value: unknown): string | null { return value === null ? null : digest(value); }
function compareIdentity(row: WorkspaceIdentity, identity: WorkspaceIdentity): boolean {
  return row.workspaceId === identity.workspaceId && row.repoId === identity.repoId && row.root === identity.root && row.branch === identity.branch;
}
function contained(parent: string, child: string): boolean {
  const value = relative(parent, child);
  return value === "" || (value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value));
}
function validateIdentity(databasePath: string, input: WorkspaceIdentity): WorkspaceIdentity {
  const value = exact(input, ["workspaceId", "repoId", "root", "branch"], "invalid_identity");
  if (!HASH.test(String(value.workspaceId)) || !HASH.test(String(value.repoId))) fail("invalid_identity");
  if (typeof value.root !== "string" || !isAbsolute(value.root) || resolve(value.root) !== value.root || value.root.length > 4096 || /[\u0000]/u.test(value.root)) fail("invalid_identity");
  if (typeof value.branch !== "string" || value.branch.length === 0 || value.branch.length > 255 || /[\u0000-\u001f\u007f]/u.test(value.branch)) fail("invalid_identity");
  const root = resolve(value.root), databaseDirectory = resolve(databasePath, "..");
  if (contained(root, resolve(databasePath)) || contained(databaseDirectory, root)) fail("invalid_identity");
  return { workspaceId: String(value.workspaceId), repoId: String(value.repoId), root, branch: String(value.branch) };
}

function validateDiagnostic(input: unknown): IndexDiagnostic {
  const value = exact(input, ["code", "path"]);
  return {
    code: oneOf(value.code, ["syntax_error", "unsupported_language", "unreadable", "budget_exceeded", "parser_unavailable", "unknown"] as const),
    path: value.path === null ? null : normalizedRelativePath(value.path),
  };
}
function validateFile(input: unknown): IndexedFile {
  const value = exact(input, ["path", "hash", "parserVersion", "status", "kind", "language", "symbolIds"]);
  return {
    path: normalizedRelativePath(value.path), hash: digest(value.hash), parserVersion: text(value.parserVersion, 128),
    status: oneOf(value.status, ["indexed", "unsupported", "parse_error", "invalid", "skipped"] as const),
    kind: oneOf(value.kind, ["code", "document", "config"] as const),
    language: value.language === null ? null : text(value.language, 64), symbolIds: uniqueStrings(value.symbolIds, 20_000),
  };
}
function validateSymbol(input: unknown): IndexedSymbol {
  if (!plain(input)) fail();
  const hasStartOffset = Object.hasOwn(input, "startOffset"), hasEndOffset = Object.hasOwn(input, "endOffset");
  if (hasStartOffset !== hasEndOffset) fail();
  const value = exact(input, ["id", "path", "name", "kind", "startLine", "startColumn", "endLine", "endColumn", ...(hasStartOffset ? ["startOffset", "endOffset"] : [])]);
  const result: IndexedSymbol = {
    id: entityId(value.id), path: normalizedRelativePath(value.path), name: text(value.name, 512),
    kind: oneOf(value.kind, ["function", "class", "method", "type", "interface", "variable", "constant", "module", "export", "import", "unknown"] as const),
    startLine: integer(value.startLine, 1), startColumn: integer(value.startColumn), endLine: integer(value.endLine, 1), endColumn: integer(value.endColumn),
    ...(hasStartOffset ? { startOffset: integer(value.startOffset), endOffset: integer(value.endOffset) } : {}),
  };
  if (result.endLine < result.startLine || (result.endLine === result.startLine && result.endColumn < result.startColumn) || (result.startOffset !== undefined && result.endOffset! < result.startOffset)) fail();
  return result;
}
function validateCodeEdge(input: unknown): IndexedCodeEdge {
  if (!plain(input)) fail();
  const detailKeys = ["name", "evidence", "path", "startLine", "startColumn", "endLine", "endColumn"] as const;
  const detailCount = detailKeys.filter((key) => Object.hasOwn(input, key)).length;
  if (detailCount !== 0 && detailCount !== detailKeys.length) fail();
  const value = exact(input, ["id", "fromSymbolId", "toSymbolId", "kind", "certainty", ...(detailCount ? detailKeys : [])]);
  const result: IndexedCodeEdge = {
    id: entityId(value.id), fromSymbolId: value.fromSymbolId === null ? null : entityId(value.fromSymbolId), toSymbolId: value.toSymbolId === null ? null : entityId(value.toSymbolId),
    kind: oneOf(value.kind, ["calls", "imports", "exports", "references", "extends", "implements", "unknown"] as const),
    certainty: oneOf(value.certainty, ["certain", "unknown"] as const),
  };
  if (result.toSymbolId === null && result.certainty === "certain") fail();
  if (detailCount) {
    result.name = value.name === null ? null : text(value.name, 512, true);
    result.evidence = oneOf(value.evidence, ["call_expression", "new_expression", "import_clause", "export_clause", "identifier_reference", "member_reference", "type_reference", "unknown"] as const);
    result.path = normalizedRelativePath(value.path);
    result.startLine = integer(value.startLine, 1); result.startColumn = integer(value.startColumn);
    result.endLine = integer(value.endLine, 1); result.endColumn = integer(value.endColumn);
    if (result.endLine < result.startLine || (result.endLine === result.startLine && result.endColumn < result.startColumn)) fail();
  }
  return result;
}
function validateFragment(input: unknown): SourceFragment {
  const value = exact(input, ["id", "path", "kind", "language", "title", "body", "startLine", "endLine", "fileHash"]);
  const result: SourceFragment = {
    id: entityId(value.id), path: normalizedRelativePath(value.path), kind: oneOf(value.kind, ["code", "document", "config"] as const),
    language: nullableText(value.language, 64), title: nullableText(value.title, 512), body: boundedText(value.body, MAX_FRAGMENT_CODEPOINTS),
    startLine: integer(value.startLine, 1), endLine: integer(value.endLine, 1), fileHash: digest(value.fileHash),
  };
  if (result.endLine < result.startLine) fail();
  return result;
}
function validateProdMetadata(input: unknown): ProdMetadata {
  const value = exact(input, ["requirementId", "source", "path", "fileName", "lifecycle", "epoch", "hash"], "metadata_body_forbidden");
  if (typeof value.requirementId !== "string" || !UUID_V7_PATTERN.test(value.requirementId)) fail("metadata_body_forbidden");
  const requirementId = value.requirementId, source = oneOf(value.source, ["local", "archive"] as const);
  const path = normalizedRelativePath(value.path, true), fileName = safeFileName(value.fileName);
  if (source === "local") {
    const lifecycle = oneOf(value.lifecycle, ["draft", "active", "closing", "closed"] as const);
    if (path !== `requirements/${requirementId}/prod.md` || fileName !== "prod.md") fail("metadata_body_forbidden");
    return { requirementId, source, path, fileName: "prod.md", lifecycle, epoch: integer(value.epoch, 1), hash: nullableHash(value.hash) };
  }
  const parts = path.split("/");
  if (value.lifecycle !== "unknown" || value.epoch !== null || value.hash !== null || parts.length !== 3 || parts[0]!.toLowerCase() !== "docs" || parts[1]!.toLowerCase() !== "prod" || parts[2] !== fileName || !fileName.startsWith(`${requirementId}.`) || !fileName.endsWith(".md")) fail("metadata_body_forbidden");
  return { requirementId, source, path, fileName, lifecycle: "unknown", epoch: null, hash: null };
}
function uniqueBy<T>(values: T[], key: (value: T) => string): void {
  if (new Set(values.map(key)).size !== values.length) fail();
}

function validatePublication(input: IndexPublication): IndexPublication {
  const value = exact(input, ["status", "diagnostics", "files", "symbols", "codeEdges", "sourceFragments", "prodMetadata"]);
  let bodyPoints = 0;
  const sourceFragments = array(value.sourceFragments, MAX_FRAGMENTS).map((item) => {
    const fragment = validateFragment(item);
    bodyPoints += Array.from(fragment.body).length;
    if (bodyPoints > MAX_INDEXED_CODEPOINTS) fail("budget_exceeded");
    return fragment;
  });
  const publication: IndexPublication = {
    status: oneOf(value.status, ["ready", "partial", "invalid"] as const),
    diagnostics: array(value.diagnostics, 1_000).map(validateDiagnostic),
    files: array(value.files, MAX_FILES).map(validateFile), symbols: array(value.symbols, MAX_SYMBOLS).map(validateSymbol),
    codeEdges: array(value.codeEdges, MAX_EDGES).map(validateCodeEdge), sourceFragments, prodMetadata: array(value.prodMetadata, MAX_FILES).map(validateProdMetadata),
  };
  uniqueBy(publication.files, (item) => item.path); uniqueBy(publication.symbols, (item) => item.id); uniqueBy(publication.codeEdges, (item) => item.id);
  uniqueBy(publication.sourceFragments, (item) => item.id); uniqueBy(publication.prodMetadata, (item) => `${item.source}:${item.path}`);
  const files = new Map(publication.files.map((item) => [item.path, item]));
  const symbols = new Map(publication.symbols.map((item) => [item.id, item]));
  for (const file of publication.files) for (const id of file.symbolIds) if (symbols.get(id)?.path !== file.path) fail();
  for (const symbol of publication.symbols) if (!files.get(symbol.path)?.symbolIds.includes(symbol.id)) fail();
  for (const edge of publication.codeEdges) if ((edge.fromSymbolId !== null && !symbols.has(edge.fromSymbolId)) || (edge.toSymbolId !== null && !symbols.has(edge.toSymbolId)) || (edge.path !== undefined && !files.has(edge.path))) fail();
  for (const fragment of publication.sourceFragments) {
    const file = files.get(fragment.path);
    if (!file || file.kind !== fragment.kind || file.hash !== fragment.fileHash) fail();
  }
  return publication;
}

function validateWorkspaceRow(stored: StoredRecord<unknown>, identity: WorkspaceIdentity): StoredRecord<WorkspaceRow> {
  const value = exact(stored.data, ["format", "workspaceId", "repoId", "root", "branch", "status", "fence", "currentGeneration", "targetGeneration", "operationId", "baselineHash", "diagnostics", "updatedAt"], "invalid_index_state");
  if (value.format !== "index-workspace/v1") fail("invalid_index_state");
  const row: WorkspaceRow = {
    format: "index-workspace/v1", workspaceId: String(value.workspaceId), repoId: String(value.repoId), root: String(value.root), branch: String(value.branch),
    status: oneOf(value.status, ["building", "dirty", "cancelled", "interrupted", "ready", "partial", "invalid"] as const),
    fence: integer(value.fence, 1), currentGeneration: integer(value.currentGeneration), targetGeneration: integer(value.targetGeneration, 1),
    operationId: String(value.operationId), baselineHash: nullableHash(value.baselineHash),
    diagnostics: array(value.diagnostics, 1_000).map(validateDiagnostic), updatedAt: integer(value.updatedAt),
  };
  if (!UUID_V7_PATTERN.test(row.operationId) || !compareIdentity(row, identity) || row.targetGeneration !== row.currentGeneration + 1) fail("invalid_index_state");
  return { ...stored, data: row };
}

function validateBuildToken(input: IndexBuildToken): IndexBuildToken {
  const value = exact(input, ["workspaceId", "operationId", "fence", "baseGeneration", "targetGeneration", "workspaceVersion"], "stale_build");
  const result = {
    workspaceId: String(value.workspaceId), operationId: String(value.operationId), fence: integer(value.fence, 1),
    baseGeneration: integer(value.baseGeneration), targetGeneration: integer(value.targetGeneration, 1), workspaceVersion: integer(value.workspaceVersion, 1),
  };
  if (!HASH.test(result.workspaceId) || !UUID_V7_PATTERN.test(result.operationId) || result.targetGeneration !== result.baseGeneration + 1) fail("stale_build");
  return result;
}

function withoutScope<T extends object>(value: WorkspaceEntity<T>): T {
  const { workspaceId: _workspaceId, generation: _generation, ...result } = value;
  return result as T;
}

function publicationBaselineHash(identity: WorkspaceIdentity, publication: IndexPublication): string {
  const sorted = <T>(values: T[], key: (value: T) => string) => [...values].sort((left, right) => key(left).localeCompare(key(right)));
  const payload = {
    format: "project-index-baseline/v1",
    workspace: identity,
    status: publication.status,
    files: sorted(publication.files, (item) => item.path).map(({ path, hash, parserVersion, status, kind, language }) => ({ path, hash, parserVersion, status, kind, language })),
    diagnostics: sorted(publication.diagnostics, (item) => `${item.path ?? ""}:${item.code}`),
    prodMetadata: sorted(publication.prodMetadata, (item) => `${item.source}:${item.path}`),
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

/**
 * index.db中的当前索引存储。调用方在构造前负责真实Git/worktree身份核验；本类固定数据库用途、代次和数据形状。
 */
export class IndexStore {
  private readonly database: LocalDatabase;
  private readonly identity: WorkspaceIdentity;
  private readonly now: () => number;

  constructor(databasePath: string, identity: WorkspaceIdentity, options: { now?: () => number } = {}) {
    if (databaseKind(databasePath) !== "index") throw new IndexStoreError("wrong_database_kind");
    this.identity = validateIdentity(resolve(databasePath), identity);
    this.now = options.now ?? Date.now;
    this.database = new LocalDatabase(databasePath);
  }

  private time(): number {
    const value = this.now();
    if (!Number.isSafeInteger(value) || value < 0) fail("invalid_index_state");
    return value;
  }
  private workspace(db = this.database): StoredRecord<WorkspaceRow> | null {
    const stored = db.read("workspaces", this.identity.workspaceId);
    return stored ? validateWorkspaceRow(stored, this.identity) : null;
  }
  private generation(db: LocalDatabase): StoredRecord<GenerationRow> {
    const stored = db.read<GenerationRow>("index_generations", this.identity.workspaceId);
    if (!stored || !plain(stored.data) || stored.data.format !== "index-generation/v1") fail("invalid_index_state");
    return stored;
  }
  private assertBuild(db: LocalDatabase, input: IndexBuildToken): { workspace: StoredRecord<WorkspaceRow>; generation: StoredRecord<GenerationRow>; token: IndexBuildToken } {
    const token = validateBuildToken(input), workspace = this.workspace(db);
    if (!workspace || token.workspaceId !== this.identity.workspaceId || workspace.data.status !== "building" || workspace.data.operationId !== token.operationId || workspace.data.fence !== token.fence || workspace.data.currentGeneration !== token.baseGeneration || workspace.data.targetGeneration !== token.targetGeneration || workspace.version !== token.workspaceVersion) fail("stale_build");
    const generation = this.generation(db), data = generation.data;
    if (data.workspaceId !== token.workspaceId || data.operationId !== token.operationId || data.fence !== token.fence || data.baseGeneration !== token.baseGeneration || data.targetGeneration !== token.targetGeneration || data.state !== "building") fail("stale_build");
    return { workspace, generation, token };
  }

  begin(expectedVersion?: number): IndexBuildToken {
    if (expectedVersion !== undefined && (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0)) fail();
    return this.database.transaction(() => {
      const current = this.workspace(this.database);
      if ((!current && expectedVersion !== undefined && expectedVersion !== 0) || (current && expectedVersion !== undefined && current.version !== expectedVersion)) throw new StaleVersionError();
      const fence = (current?.data.fence ?? 0) + 1, baseGeneration = current?.data.currentGeneration ?? 0, targetGeneration = baseGeneration + 1;
      if (!Number.isSafeInteger(fence) || !Number.isSafeInteger(targetGeneration)) fail("invalid_index_state");
      const operationId = uuidv7(), updatedAt = this.time();
      const row: WorkspaceRow = {
        format: "index-workspace/v1", ...this.identity, status: "building", fence, currentGeneration: baseGeneration,
        targetGeneration, operationId, baselineHash: current?.data.baselineHash ?? null, diagnostics: [], updatedAt,
      };
      const workspaceVersion = current
        ? this.database.update("workspaces", this.identity.workspaceId, current.version, row)
        : this.database.create("workspaces", this.identity.workspaceId, row).version;
      const generation: GenerationRow = { format: "index-generation/v1", workspaceId: this.identity.workspaceId, operationId, fence, baseGeneration, targetGeneration, state: "building", updatedAt };
      const previousGeneration = this.database.read("index_generations", this.identity.workspaceId);
      if (previousGeneration) this.database.update("index_generations", this.identity.workspaceId, previousGeneration.version, generation);
      else this.database.create("index_generations", this.identity.workspaceId, generation);
      return Object.freeze({ workspaceId: this.identity.workspaceId, operationId, fence, baseGeneration, targetGeneration, workspaceVersion });
    });
  }

  private stop(input: IndexBuildToken, state: "cancelled" | "interrupted"): IndexWorkspaceStatus {
    return this.database.transaction(() => {
      const { workspace, generation } = this.assertBuild(this.database, input), updatedAt = this.time();
      const nextWorkspace: WorkspaceRow = { ...workspace.data, status: state, diagnostics: [], updatedAt };
      const version = this.database.update("workspaces", this.identity.workspaceId, workspace.version, nextWorkspace);
      this.database.update("index_generations", this.identity.workspaceId, generation.version, { ...generation.data, state, updatedAt });
      return this.toStatus({ id: workspace.id, version, data: nextWorkspace });
    });
  }

  cancel(input: IndexBuildToken): IndexWorkspaceStatus { return this.stop(input, "cancelled"); }
  interrupt(input: IndexBuildToken): IndexWorkspaceStatus { return this.stop(input, "interrupted"); }

  /** 先使普通查询失效；若构建正在进行，同时提高fence，旧构建不能清除这次dirty。 */
  markDirty(): IndexWorkspaceStatus {
    return this.database.transaction(() => {
      const current = this.workspace(this.database);
      if (!current) fail("no_index");
      if (current.data.status === "dirty") return this.toStatus(current);
      const fence = current.data.fence + 1;
      if (!Number.isSafeInteger(fence)) fail("invalid_index_state");
      const operationId = uuidv7(), updatedAt = this.time();
      const row: WorkspaceRow = {
        ...current.data,
        status: "dirty",
        fence,
        operationId,
        targetGeneration: current.data.currentGeneration + 1,
        updatedAt,
      };
      const version = this.database.update("workspaces", this.identity.workspaceId, current.version, row);
      const generation = this.database.read<GenerationRow>("index_generations", this.identity.workspaceId);
      const nextGeneration: GenerationRow = {
        format: "index-generation/v1",
        workspaceId: this.identity.workspaceId,
        operationId,
        fence,
        baseGeneration: current.data.currentGeneration,
        targetGeneration: current.data.currentGeneration + 1,
        state: "dirty",
        updatedAt,
      };
      if (generation) this.database.update("index_generations", this.identity.workspaceId, generation.version, nextGeneration);
      else this.database.create("index_generations", this.identity.workspaceId, nextGeneration);
      return this.toStatus({ id: current.id, version, data: row });
    });
  }

  publish(input: IndexBuildToken, publicationInput: IndexPublication, verifiedBaselineHash?: string): IndexWorkspaceStatus {
    const publication = validatePublication(publicationInput);
    const baselineHash = verifiedBaselineHash === undefined ? publicationBaselineHash(this.identity, publication) : digest(verifiedBaselineHash);
    return this.database.transaction(() => {
      const { workspace, generation, token } = this.assertBuild(this.database, input);
      if (!Number.isSafeInteger(token.targetGeneration + 1)) fail("invalid_index_state");
      const reconcile = <T extends object>(namespace: EntityNamespace, items: T[], id: (item: T) => string) => {
        const previous = new Map(this.database.list<Record<string, unknown>>(namespace)
          .filter((stored) => plain(stored.data) && stored.data.workspaceId === this.identity.workspaceId)
          .map((stored) => [stored.key, stored]));
        for (const item of items) {
          const key = `${this.identity.workspaceId}:${namespace}:${id(item)}`;
          const data = { workspaceId: this.identity.workspaceId, generation: token.targetGeneration, ...item };
          const stored = previous.get(key);
          // 同键保留内部行身份；正文和代次始终由本次已校验发布完整替换。
          if (stored) this.database.update(namespace, key, stored.version, data);
          else this.database.create(namespace, key, data);
          previous.delete(key);
        }
        for (const stored of previous.values()) this.database.remove(namespace, stored.key, stored.version);
      };
      reconcile("files", publication.files, (item) => item.path);
      reconcile("symbols", publication.symbols, (item) => item.id);
      reconcile("code_edges", publication.codeEdges, (item) => item.id);
      reconcile("source_fragments", publication.sourceFragments, (item) => item.id);
      reconcile("prod_metadata", publication.prodMetadata, (item) => `${item.source}:${item.path}`);
      const updatedAt = this.time();
      const nextWorkspace: WorkspaceRow = {
        ...workspace.data, status: publication.status, currentGeneration: token.targetGeneration,
        targetGeneration: token.targetGeneration + 1, baselineHash, diagnostics: publication.diagnostics, updatedAt,
      };
      const version = this.database.update("workspaces", this.identity.workspaceId, workspace.version, nextWorkspace);
      this.database.update("index_generations", this.identity.workspaceId, generation.version, { ...generation.data, state: publication.status, updatedAt });
      return this.toStatus({ id: workspace.id, version, data: nextWorkspace });
    });
  }

  private toStatus(record: StoredRecord<WorkspaceRow>): IndexWorkspaceStatus {
    const { format: _format, operationId: _operationId, ...data } = record.data;
    return { ...data, version: record.version };
  }

  status(): IndexWorkspaceStatus {
    const record = this.workspace();
    if (!record) fail("no_index");
    return this.toStatus(record);
  }

  private snapshot(allowUnready: boolean): IndexSnapshot {
    return this.database.transaction(() => {
      const workspace = this.workspace(this.database);
      if (!workspace) fail("no_index");
      if (!allowUnready && workspace.data.status !== "ready" && workspace.data.status !== "partial") fail("index_not_ready");
      if (allowUnready && workspace.data.currentGeneration === 0) fail("index_not_ready");
      const generation = workspace.data.currentGeneration;
      const rows = <T extends object>(namespace: EntityNamespace): T[] => this.database.list<WorkspaceEntity<T>>(namespace)
        .filter((record) => record.data.workspaceId === this.identity.workspaceId && record.data.generation === generation)
        .map((record) => withoutScope(record.data));
      const by = <T>(values: T[], key: (value: T) => string) => values.sort((a, b) => key(a).localeCompare(key(b)));
      return {
        ...this.identity,
        status: workspace.data.status === "partial" || workspace.data.diagnostics.length > 0 ? "partial" : "ready",
        generation,
        diagnostics: workspace.data.diagnostics,
        files: by(rows<IndexedFile>("files"), (item) => item.path), symbols: by(rows<IndexedSymbol>("symbols"), (item) => item.id),
        codeEdges: by(rows<IndexedCodeEdge>("code_edges"), (item) => item.id),
        sourceFragments: by(rows<SourceFragment>("source_fragments"), (item) => item.id), prodMetadata: by(rows<ProdMetadata>("prod_metadata"), (item) => `${item.source}:${item.path}`),
      };
    });
  }

  /** 可信基线核对只读取文件元数据，不加载符号、规则、FTS或正文片段。 */
  getFileMetadata(): { status: IndexWorkspaceStatus; files: IndexedFile[] } {
    return this.database.transaction(() => {
      const status = this.status();
      if (status.currentGeneration < 1 || !["ready", "partial", "invalid"].includes(status.status)) fail("index_not_ready");
      const files = this.database.list<WorkspaceEntity<IndexedFile>>("files")
        .filter((row) => row.data.workspaceId === this.identity.workspaceId && row.data.generation === status.currentGeneration)
        .map((row) => validateFile(withoutScope(row.data)))
        .sort((a, b) => a.path.localeCompare(b.path));
      return { status, files };
    });
  }

  /** 普通查询只读取已发布且未dirty的当前代次。 */
  getSnapshot(): IndexSnapshot { return this.snapshot(false); }

  /** 仅供可信重建复用已发布代次；即使dirty也不会把旧正文返回给普通查询。 */
  getRebuildSnapshot(): IndexSnapshot { return this.snapshot(true); }

  search(query: string, limit = 10): IndexSearchResponse {
    if (typeof query !== "string" || query.trim().length === 0 || Array.from(query).length > MAX_SEARCH_QUERY_CODEPOINTS || /[\u0000-\u001f\u007f]/u.test(query) || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_SEARCH_LIMIT) fail("invalid_fts_query");
    return this.database.transaction(() => {
      const workspace = this.workspace(this.database);
      if (!workspace) fail("no_index");
      if (workspace.data.status !== "ready" && workspace.data.status !== "partial") fail("index_not_ready");
      let hits;
      try { hits = this.database.searchIndexFragments(this.identity.workspaceId, query, limit + 1); }
      catch (error) { if (error instanceof InvalidIndexQueryError) fail("invalid_fts_query"); throw error; }
      let used = 0, truncated = hits.length > limit;
      const results: IndexSearchResult[] = [];
      for (const hit of hits.slice(0, limit)) {
        let snippet = hit.snippet;
        const points = Array.from(snippet);
        if (points.length > MAX_SEARCH_SNIPPET_CODEPOINTS) { snippet = points.slice(0, MAX_SEARCH_SNIPPET_CODEPOINTS).join(""); truncated = true; }
        const cost = Array.from(hit.fragmentId + hit.path + hit.kind + snippet).length;
        if (used + cost > MAX_SEARCH_OUTPUT_CODEPOINTS) { truncated = true; break; }
        used += cost; results.push({ ...hit, snippet });
      }
      return { results, truncated };
    });
  }

  /**
   * 固定只读接缝，不初始化/升级数据库，也不加载 prod_metadata。
   * paths 来自可信调用者已核验的允许文件清单；在 SQLite 返回正文之前应用范围。
   * metadataOnly 用于授权/真实文件检查前的无正文预检。实际全文件当前性由宿主核对。
   */
  static readCurrent(databasePath: string, identity: WorkspaceIdentity, paths: readonly string[], metadataOnly = false): CurrentQueryIndex {
    if (hasInvalidTransactionOrigin()) fail("invalid_index_state");
    if (databaseKind(databasePath) !== "index") fail("wrong_database_kind");
    const workspaceIdentity = validateIdentity(resolve(databasePath), identity);
    if (!Array.isArray(paths) || paths.length > MAX_FILES) fail("invalid_input");
    const permitted = new Set(paths.map((path) => normalizedRelativePath(path)));
    assertDatabasePathReady(databasePath);
    assertPrivateQueryStorage(databasePath);
    const before = lstatSync(databasePath);
    const db = new DatabaseSync(databasePath, { readOnly: true, allowExtension: false });
    try {
      db.exec("PRAGMA query_only = ON; PRAGMA busy_timeout = 5000; BEGIN");
      if (Number(db.prepare("PRAGMA application_id").get()?.application_id) !== DATABASE_APPLICATION_IDS.index
        || Number(db.prepare("PRAGMA user_version").get()?.user_version) !== 1
        || Number(db.prepare("SELECT schema_version FROM index_schema_metadata WHERE schema_key = 'current'").get()?.schema_version) !== 1) fail("invalid_index_state");
      const row = db.prepare("SELECT id, version, data FROM records WHERE namespace = 'workspaces' AND record_key = ?").get(identity.workspaceId);
      if (!row || typeof row.data !== "string") fail("no_index");
      const checked = validateWorkspaceRow({ id: String(row.id), version: Number(row.version), data: JSON.parse(row.data) }, workspaceIdentity);
      const { format: _format, operationId: _operationId, ...state } = checked.data;
      const status = { ...state, version: checked.version };
      if (!["ready", "partial", "invalid"].includes(status.status) || status.currentGeneration < 1) fail("index_not_ready");
      const finish = (snapshot: CurrentQueryIndex["snapshot"]): CurrentQueryIndex => {
        assertDatabasePathReady(databasePath);
        assertPrivateQueryStorage(databasePath);
        const after = lstatSync(databasePath);
        if (before.dev !== after.dev || before.ino !== after.ino) fail("invalid_index_state");
        // 无权限路径只保留诊断类别，不能回显其名称。
        return { status: { ...status, diagnostics: status.diagnostics.map((item) => ({ code: item.code, path: item.path && permitted.has(item.path) ? item.path : null })) }, snapshot };
      };
      if (status.status === "invalid") return finish(null);
      const read = <T extends object>(namespace: EntityNamespace, validate: (value: unknown) => T): T[] => {
        const rows = db.prepare("SELECT data FROM records WHERE namespace = ? AND json_extract(data, '$.workspaceId') = ? AND json_extract(data, '$.generation') = ? AND json_extract(data, '$.path') IN (SELECT value FROM json_each(?)) ORDER BY record_key")
          .all(namespace, identity.workspaceId, status.currentGeneration, JSON.stringify([...permitted]));
        return rows.map((item) => validate(withoutScope(JSON.parse(String(item.data)))));
      };
      const files = read("files", validateFile);
      const snapshot: NonNullable<CurrentQueryIndex["snapshot"]> = {
        ...workspaceIdentity, status: status.status as "ready" | "partial", generation: status.currentGeneration,
        diagnostics: status.diagnostics.map((item) => ({ code: item.code, path: item.path && permitted.has(item.path) ? item.path : null })),
        files, symbols: [], codeEdges: [], sourceFragments: [],
      };
      if (metadataOnly) return finish(snapshot);
      snapshot.symbols = read("symbols", validateSymbol);
      snapshot.sourceFragments = read("source_fragments", validateFragment);
      const symbolIds = new Set(snapshot.symbols.map((symbol) => symbol.id));
      snapshot.codeEdges = read("code_edges", validateCodeEdge).map((edge) => ({ ...edge,
        fromSymbolId: edge.fromSymbolId && symbolIds.has(edge.fromSymbolId) ? edge.fromSymbolId : null,
        toSymbolId: edge.toSymbolId && symbolIds.has(edge.toSymbolId) ? edge.toSymbolId : null,
        certainty: edge.toSymbolId && symbolIds.has(edge.toSymbolId) ? edge.certainty : "unknown",
        sourceCertainty: edge.certainty,
        targetOutsideScope: edge.toSymbolId !== null && !symbolIds.has(edge.toSymbolId),
      }));
      return finish(snapshot);
    } catch (error) {
      if (error instanceof IndexStoreError) throw error;
      fail("invalid_index_state");
    } finally { db.close(); }
  }

  close(): void { this.database.close(); }
}
