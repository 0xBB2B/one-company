import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import type { Stats } from "node:fs";
import { chmod, lstat, mkdir, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { assertDataRootOutsideWorktrees, assertRegularDatabaseFiles, indexDatabase } from "./database-paths.ts";
import { UUID_V7_PATTERN } from "./database.ts";
import { extractCode, getCodeExtractorVersion } from "./code-extractor.ts";
import type { ExtractCodeInput, ExtractCodeResult, CodeRange } from "./code-extractor.ts";
import { readGit } from "./git-read.ts";
import { listWorktrees, repositoryIdentity } from "./identity.ts";
import { IndexStore, IndexStoreError } from "./index-store.ts";
import type {
  ArchiveProdMetadata,
  CurrentQueryIndex,
  CodeEdgeEvidence,
  IndexDiagnostic,
  IndexedCodeEdge,
  IndexedFeature,
  IndexedFile,
  IndexedFileKind,
  IndexedRule,
  IndexedRuleEdge,
  IndexedSymbol,
  IndexPublication,
  IndexSnapshot,
  IndexWorkspaceStatus,
  SourceFragment,
  WorkspaceIdentity,
} from "./index-store.ts";
import {
  DEFAULT_INDEX_LIMITS,
  classifyIndexWatchEvent,
  readIndexFile,
  scanIndexWorkspace,
} from "./project-index-policy.ts";
import type {
  IndexArchiveMetadata,
  IndexBudgetResult,
  IndexFile,
  IndexLimits,
  IndexSkippedPath,
  IndexWorkspaceScan,
  ReadIndexFileResult,
} from "./project-index-policy.ts";
import { checkSpecSet, SpecFormatError } from "./spec-format.ts";
import type { CheckedSpecSet, SpecDocument, SpecSource } from "./spec-format.ts";
import { canonicalJson, parseStrictJson } from "./strict-json.ts";
import { verifySyntaxResources } from "./syntax-parser.ts";
import type { SyntaxLanguage } from "./syntax-parser.ts";

const HASH = /^[0-9a-f]{64}$/;
const MAX_FRAGMENT_CODEPOINTS = 131_072;
const TEXT_PARSER_VERSION = "project-index-text@1";
const UNSUPPORTED_PARSER_VERSION = "project-index-unsupported@1";
const ARCHIVE_NAME_LIMIT = 255;
const MAX_PUBLISHED_SYMBOLS = 100_000;
const MAX_PUBLISHED_EDGES = 200_000;

export type ProjectIndexAction = "open" | "status" | "preview" | "init" | "refresh" | "invalidate" | "query";
export type ProjectIndexAuthorizationPhase = "before" | "after" | "read" | "publish" | "return";

export interface ProjectIndexAuthorizationRequest {
  action: ProjectIndexAction;
  phase: ProjectIndexAuthorizationPhase;
  repoId: string;
  repositoryRoot: string;
  workspaceId: string | null;
  path: string | null;
}

export type ProjectIndexAuthorize = (request: Readonly<ProjectIndexAuthorizationRequest>) => boolean;

export interface ProjectIndexExtractor {
  extract(input: ExtractCodeInput): Promise<ExtractCodeResult>;
  version(language: SyntaxLanguage): string;
}

export interface ProjectIndexServiceOptions {
  repositoryRoot: string;
  dataRoot: string;
  repoId: string;
  authorize?: ProjectIndexAuthorize;
  extractor?: ProjectIndexExtractor;
}

export interface ProjectIndexOperationOptions {
  signal?: AbortSignal;
  limits?: Partial<IndexLimits>;
  onProgress?: (progress: { phase: "scan" | "read" | "parse" | "verify"; path: string; completed: number; total: number }) => void;
}

export interface ProjectIndexArchiveIssue {
  path: string | null;
  requirementId: string | null;
  reason: "invalid_archive_name" | "duplicate_requirement_id";
}

export interface ProjectIndexArchiveSummary {
  metadata: ArchiveProdMetadata[];
  issues: ProjectIndexArchiveIssue[];
}

export interface ProjectIndexPreview {
  action: "preview";
  workspace: WorkspaceIdentity;
  head: string | null;
  files: IndexFile[];
  skipped: IndexSkippedPath[];
  archives: ProjectIndexArchiveSummary;
  budget: IndexBudgetResult;
  partial: boolean;
  databaseCreated: false;
}

export interface ProjectIndexStatus {
  action: "status";
  workspace: WorkspaceIdentity;
  head: string | null;
  initialized: boolean;
  cacheVerified: false;
  index: IndexWorkspaceStatus | null;
}

export interface ProjectIndexSpecSummary {
  status: "absent" | "valid" | "invalid";
  contractSetHash: string | null;
  schemaHash: string | null;
}

export interface ProjectIndexBuildResult {
  action: "init" | "refresh";
  workspace: WorkspaceIdentity;
  head: string | null;
  status: "ready" | "partial" | "invalid" | "cancelled";
  generation: number;
  /** 工作区身份与当前允许文件/规则/配置/归档元数据的稳定内容指纹；不包含generation。 */
  baselineHash: string | null;
  parsedFiles: number;
  reusedFiles: number;
  /** 构建读取与发布前hash复核的实际完整文件字节上界；两轮合计最多为公开文本集合预算的两倍。 */
  readBytes: number;
  sourceCodepoints: number;
  files: number;
  symbols: number;
  codeEdges: number;
  diagnostics: IndexDiagnostic[];
  skipped: IndexSkippedPath[];
  archives: ProjectIndexArchiveSummary;
  budget: IndexBudgetResult;
  spec: ProjectIndexSpecSummary;
  watchPlan: {
    directories: string[];
    archiveDirectories: string[];
  };
}

export type ProjectIndexServiceErrorCode =
  | "authorization_denied"
  | "invalid_identity"
  | "identity_changed"
  | "invalid_data_root"
  | "invalid_database"
  | "operation_in_progress"
  | "unstable"
  | "index_failure";

export class ProjectIndexServiceError extends Error {
  readonly code: ProjectIndexServiceErrorCode;
  readonly metadata: Readonly<{ stage: string; retryable: boolean }>;

  constructor(code: ProjectIndexServiceErrorCode, stage: string, retryable = false) {
    const messages: Record<ProjectIndexServiceErrorCode, string> = {
      authorization_denied: "项目索引操作未获授权",
      invalid_identity: "项目索引仓库身份无效",
      identity_changed: "项目索引仓库身份已变化",
      invalid_data_root: "项目索引数据目录不安全",
      invalid_database: "项目索引数据库不可用",
      operation_in_progress: "项目索引已有操作正在进行",
      unstable: "项目文件在索引期间发生变化",
      index_failure: "项目索引操作失败",
    };
    super(messages[code]);
    this.name = "ProjectIndexServiceError";
    this.code = code;
    this.metadata = Object.freeze({ stage, retryable });
  }
}

interface DirectorySnapshot {
  path: string;
  dev: number;
  ino: number;
}

interface DataDirectoryChain {
  complete: boolean;
  snapshots: DirectorySnapshot[];
}

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function inspectDirectory(path: string, stage: string): Promise<DirectorySnapshot | null> {
  let stats: Stats;
  try { stats = await lstat(path); }
  catch (error) {
    if (missing(error)) return null;
    throw new ProjectIndexServiceError("invalid_data_root", stage);
  }
  let actual: string;
  try { actual = await realpath(path); }
  catch { throw new ProjectIndexServiceError("invalid_data_root", stage); }
  if (!stats.isDirectory() || stats.isSymbolicLink() || actual !== path
    || (process.getuid && stats.uid !== process.getuid())) {
    throw new ProjectIndexServiceError("invalid_data_root", stage);
  }
  return { path, dev: stats.dev, ino: stats.ino };
}

async function verifyDirectories(snapshots: DirectorySnapshot[], stage: string): Promise<void> {
  for (const snapshot of snapshots) {
    const current = await inspectDirectory(snapshot.path, stage);
    if (!current || current.dev !== snapshot.dev || current.ino !== snapshot.ino) {
      throw new ProjectIndexServiceError("invalid_data_root", stage, true);
    }
  }
}

/** 查询返回门槛同步核对受控目录链，拒绝过宽权限而不修复用户数据。 */
function verifyPrivateQueryDirectories(snapshots: DirectorySnapshot[]): void {
  try {
    for (const snapshot of snapshots) {
      const stats = lstatSync(snapshot.path);
      if (!stats.isDirectory() || stats.isSymbolicLink() || realpathSync(snapshot.path) !== snapshot.path
        || stats.dev !== snapshot.dev || stats.ino !== snapshot.ino || (stats.mode & 0o077) !== 0
        || (process.getuid && stats.uid !== process.getuid())) throw new Error("unsafe directory");
    }
  } catch { throw new ProjectIndexServiceError("invalid_data_root", "query-private-directory"); }
}

async function inspectDataDirectoryChain(dataRoot: string, repoId: string, stage: string): Promise<DataDirectoryChain> {
  const data = await inspectDirectory(dataRoot, stage);
  if (!data) return { complete: false, snapshots: [] };
  const repos = await inspectDirectory(join(dataRoot, "repos"), stage);
  if (!repos) return { complete: false, snapshots: [data] };
  const repository = await inspectDirectory(join(dataRoot, "repos", repoId), stage);
  if (!repository) return { complete: false, snapshots: [data, repos] };
  const snapshots = [data, repos, repository];
  await verifyDirectories(snapshots, stage);
  return { complete: true, snapshots };
}

async function createDirectoryAfterParentCheck(path: string, parent: DirectorySnapshot, stage: string): Promise<DirectorySnapshot> {
  await verifyDirectories([parent], stage);
  try { await mkdir(path, { recursive: false, mode: 0o700 }); }
  catch (error) {
    // 并发创建也必须重新按真实目录检查，不能把EEXIST或链接当成功。
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new ProjectIndexServiceError("invalid_data_root", stage);
  }
  const created = await inspectDirectory(path, stage);
  if (!created) throw new ProjectIndexServiceError("invalid_data_root", stage);
  await verifyDirectories([parent, created], stage);
  return created;
}

async function ensureDataDirectoryChain(dataRoot: string, repoId: string): Promise<DirectorySnapshot[]> {
  // 首轮只读预检完整已有链；发现任一链接时，在mkdir/chmod之前失败。
  const preflight = await inspectDataDirectoryChain(dataRoot, repoId, "database-directory-preflight");
  const snapshots = [...preflight.snapshots];
  if (!snapshots.length) {
    const parentPath = dirname(dataRoot);
    const parent = await inspectDirectory(parentPath, "database-directory-parent");
    if (!parent) throw new ProjectIndexServiceError("invalid_data_root", "database-directory-parent");
    snapshots.push(await createDirectoryAfterParentCheck(dataRoot, parent, "database-directory-create-root"));
  }
  if (snapshots.length === 1) {
    snapshots.push(await createDirectoryAfterParentCheck(join(dataRoot, "repos"), snapshots[0]!, "database-directory-create-repos"));
  }
  if (snapshots.length === 2) {
    snapshots.push(await createDirectoryAfterParentCheck(join(dataRoot, "repos", repoId), snapshots[1]!, "database-directory-create-repository"));
  }
  await verifyDirectories(snapshots, "database-directory-created");
  return snapshots;
}

interface VerifiedIdentity {
  root: string;
  commonDir: string;
  repoId: string;
  branch: string;
  head: string | null;
}

interface PreparedRead {
  file: IndexFile;
  result: ReadIndexFileResult;
}

interface SpecBuild {
  summary: ProjectIndexSpecSummary;
  diagnostics: IndexDiagnostic[];
  features: IndexedFeature[];
  rules: IndexedRule[];
  ruleEdges: IndexedRuleEdge[];
  invalid: boolean;
}

interface CodeBuild {
  file: IndexedFile;
  symbols: IndexedSymbol[];
  edges: IndexedCodeEdge[];
  diagnostics: IndexDiagnostic[];
  reused: boolean;
  parsed: boolean;
}

interface BuildMetrics {
  readBytes: number;
  parsedFiles: number;
  reusedFiles: number;
  sourceCodepoints: number;
}

function serviceError(error: unknown, stage: string): ProjectIndexServiceError {
  if (error instanceof ProjectIndexServiceError) return error;
  if (error instanceof IndexStoreError && error.code === "wrong_database_kind") {
    return new ProjectIndexServiceError("invalid_database", stage);
  }
  return new ProjectIndexServiceError("index_failure", stage, true);
}

function hashParts(...parts: string[]): string {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(String(Buffer.byteLength(part))).update(":").update(part).update("|");
  return hash.digest("hex");
}

function codepoints(value: string): number {
  return Array.from(value).length;
}

function safeIssuePath(path: string): string | null {
  return /[\u0000-\u001f\u007f\\]/u.test(path) ? null : path;
}

function archiveSummary(entries: IndexArchiveMetadata[]): ProjectIndexArchiveSummary {
  const metadata: ArchiveProdMetadata[] = [];
  const issues: ProjectIndexArchiveIssue[] = [];
  const counts = new Map<string, number>();
  for (const entry of entries) {
    const fileName = basename(entry.path);
    const requirementId = fileName.slice(0, 36);
    const valid = fileName.length <= ARCHIVE_NAME_LIMIT
      && UUID_V7_PATTERN.test(requirementId)
      && fileName[36] === "."
      && fileName.endsWith(".md")
      && fileName.slice(37, -3).length > 0
      && !/[\u0000-\u001f\u007f/\\]/u.test(fileName)
      && entry.requirementId === requirementId
      && entry.path.split("/").length === 3;
    if (!valid) {
      issues.push({ path: safeIssuePath(entry.path), requirementId: entry.requirementId, reason: "invalid_archive_name" });
      continue;
    }
    metadata.push({
      requirementId,
      source: "archive",
      path: entry.path,
      fileName,
      lifecycle: "unknown",
      epoch: null,
      hash: null,
    });
    counts.set(requirementId, (counts.get(requirementId) ?? 0) + 1);
  }
  for (const item of metadata) {
    if ((counts.get(item.requirementId) ?? 0) > 1) {
      issues.push({ path: item.path, requirementId: item.requirementId, reason: "duplicate_requirement_id" });
    }
  }
  metadata.sort((a, b) => a.path.localeCompare(b.path));
  issues.sort((a, b) => (a.path ?? "").localeCompare(b.path ?? "") || a.reason.localeCompare(b.reason));
  return { metadata, issues };
}

function mappedKind(file: IndexFile): IndexedFileKind {
  if (file.kind === "unsupported") return "code";
  if (file.kind === "schema") return "config";
  return file.kind;
}

function oneBasedRange(range: CodeRange): Pick<IndexedSymbol, "startLine" | "startColumn" | "endLine" | "endColumn" | "startOffset" | "endOffset"> {
  return {
    startLine: range.start.line + 1,
    startColumn: range.start.column,
    endLine: range.end.line + 1,
    endColumn: range.end.column,
    startOffset: range.start.offset,
    endOffset: range.end.offset,
  };
}

function edgeRange(path: string, range: CodeRange, name: string | null, evidence: CodeEdgeEvidence) {
  return {
    name,
    evidence,
    path,
    startLine: range.start.line + 1,
    startColumn: range.start.column,
    endLine: range.end.line + 1,
    endColumn: range.end.column,
  };
}

function structuredImportName(module: string, bindings: ExtractCodeResult["imports"][number]["bindings"]): string {
  const value = canonicalJson({ module, bindings } as never);
  return codepoints(value) <= 512 ? value : `module-sha256:${hashParts(module, value)}`;
}

function structuredExportName(entry: ExtractCodeResult["exports"][number]): string {
  const value = canonicalJson({ exported: entry.exported, local: entry.local, module: entry.module } as never);
  return codepoints(value) <= 512 ? value : `export-sha256:${hashParts(value)}`;
}

function mapExtraction(path: string, result: ExtractCodeResult): { symbols: IndexedSymbol[]; edges: IndexedCodeEdge[] } {
  const symbols: IndexedSymbol[] = result.symbols.map((symbol) => ({
    id: symbol.id,
    path,
    name: symbol.qualifiedName ?? symbol.name,
    kind: symbol.kind === "arrow_function" ? "function" : symbol.kind,
    ...oneBasedRange(symbol.range),
  }));
  for (const item of result.imports) {
    symbols.push({ id: item.id, path, name: structuredImportName(item.module, item.bindings), kind: "import", ...oneBasedRange(item.range) });
  }
  for (const item of result.exports) {
    symbols.push({ id: item.id, path, name: structuredExportName(item), kind: "export", ...oneBasedRange(item.range) });
  }
  const edges: IndexedCodeEdge[] = result.references.map((reference) => ({
    id: reference.id,
    fromSymbolId: reference.fromSymbolId,
    toSymbolId: reference.targetSymbolId,
    kind: "calls",
    certainty: reference.certainty,
    ...edgeRange(path, reference.range, reference.name, "call_expression"),
  }));
  return { symbols, edges };
}

function fragments(file: IndexFile, content: string, fileHash: string): SourceFragment[] {
  if (content.length === 0) return [];
  const points = Array.from(content);
  const result: SourceFragment[] = [];
  let startLine = 1;
  for (let offset = 0, index = 0; offset < points.length; offset += MAX_FRAGMENT_CODEPOINTS, index++) {
    const body = points.slice(offset, offset + MAX_FRAGMENT_CODEPOINTS).join("");
    const newlineCount = (body.match(/\n/gu) ?? []).length;
    const endLine = startLine + newlineCount;
    result.push({
      id: `fragment_${hashParts(file.path, fileHash, String(index))}`,
      path: file.path,
      kind: mappedKind(file),
      language: file.language,
      title: null,
      body,
      startLine,
      endLine,
      fileHash,
    });
    startLine = endLine;
  }
  return result;
}

function diagnosticPush(diagnostics: IndexDiagnostic[], value: IndexDiagnostic): void {
  if (diagnostics.length < 1_000 && !diagnostics.some((item) => item.code === value.code && item.path === value.path)) diagnostics.push(value);
}

function comparableScan(scan: IndexWorkspaceScan): string {
  return JSON.stringify({
    files: scan.files,
    archives: scan.archives,
    watchDirectories: scan.watchDirectories,
    archiveWatchDirectories: scan.archiveWatchDirectories,
  });
}

function readSignature(result: ReadIndexFileResult): string {
  if (result.status === "success") return `success:${result.size}:${result.sha256}`;
  return `${result.status}:${result.reason}`;
}

function contentBaselineHash(
  workspace: WorkspaceIdentity,
  scan: IndexWorkspaceScan,
  prepared: PreparedRead[],
  publication: IndexPublication,
  spec: ProjectIndexSpecSummary,
): string {
  const payload = {
    format: "project-index-baseline/v1",
    workspace,
    files: prepared.map((item) => ({
      path: item.file.path,
      kind: item.file.kind,
      language: item.file.language,
      read: readSignature(item.result),
    })),
    parsedFiles: [...publication.files]
      .sort((left, right) => left.path.localeCompare(right.path))
      .map(({ path, hash, parserVersion, status, kind, language }) => ({ path, hash, parserVersion, status, kind, language })),
    spec,
    skipped: scan.skipped,
    archives: scan.archives,
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function cacheForFile(snapshot: IndexSnapshot | null, path: string, hash: string, parserVersion: string): CodeBuild | null {
  if (!snapshot) return null;
  const file = snapshot.files.find((item) => item.path === path);
  if (!file || file.hash !== hash || file.parserVersion !== parserVersion || file.kind !== "code") return null;
  const diagnostics = snapshot.diagnostics.filter((item) => item.path === path);
  // 资源不可用是运行环境事实，不是源码解析结论；环境恢复后必须重新提取。
  if (diagnostics.some((item) => item.code === "parser_unavailable")) return null;
  const ids = new Set(file.symbolIds);
  const symbols = snapshot.symbols.filter((item) => ids.has(item.id));
  if (symbols.length !== ids.size) return null;
  const edges = snapshot.codeEdges.filter((item) => item.path === path || (item.fromSymbolId !== null && ids.has(item.fromSymbolId)));
  return {
    file: { ...file },
    symbols,
    edges,
    diagnostics,
    reused: true,
    parsed: false,
  };
}

function parseSpecDocuments(sources: SpecSource[]): Map<string, SpecDocument> {
  return new Map(sources.map((source) => [source.path, parseStrictJson(source.content) as unknown as SpecDocument]));
}

function buildValidSpec(checked: CheckedSpecSet, documents: Map<string, SpecDocument>): SpecBuild {
  const features = new Map<string, IndexedFeature>();
  let conflict = false;
  for (const [path, document] of [...documents].sort(([a], [b]) => a.localeCompare(b))) {
    const featureHash = createHash("sha256").update(canonicalJson(document.feature as never)).digest("hex");
    const candidate: IndexedFeature = {
      id: document.feature.id,
      path,
      title: document.feature.title,
      aliases: [...document.feature.aliases],
      contractHash: featureHash,
    };
    const existing = features.get(candidate.id);
    if (!existing) features.set(candidate.id, candidate);
    else if (existing.contractHash !== candidate.contractHash) conflict = true;
  }
  if (checked.semanticReview.conflictCandidates.length || conflict) {
    return {
      summary: { status: "invalid", contractSetHash: null, schemaHash: checked.schemaHash },
      diagnostics: [{ code: "invalid_spec", path: checked.rules[0]?.path ?? "docs/spec/schema.json" }],
      features: [], rules: [], ruleEdges: [], invalid: true,
    };
  }
  const rules: IndexedRule[] = checked.rules.map((entry) => {
    const document = documents.get(entry.path)!;
    return {
      id: entry.rule.id,
      featureId: document.feature.id,
      path: entry.path,
      title: entry.rule.title,
      condition: entry.rule.condition,
      trigger: entry.rule.trigger,
      expected: entry.rule.expected,
      reason: entry.rule.reason,
      dependsOn: [...entry.rule.dependsOn],
      exceptions: [...entry.rule.exceptions],
      acceptance: entry.rule.acceptance.map((item) => ({ ...item })),
      contractHash: entry.contractHash,
      codePointCount: entry.codepoints,
    };
  });
  const ruleEdges: IndexedRuleEdge[] = [];
  for (const rule of rules) {
    for (const target of rule.dependsOn) ruleEdges.push({ id: `rule_edge_${hashParts(rule.id, "depends_on", target)}`, fromRuleId: rule.id, toRuleId: target, kind: "depends_on" });
    for (const target of rule.exceptions) ruleEdges.push({ id: `rule_edge_${hashParts(rule.id, "references", target)}`, fromRuleId: rule.id, toRuleId: target, kind: "references" });
  }
  return {
    summary: { status: "valid", contractSetHash: checked.contractSetHash, schemaHash: checked.schemaHash },
    diagnostics: [], features: [...features.values()], rules, ruleEdges, invalid: false,
  };
}

function validateSpecs(prepared: PreparedRead[], scan: IndexWorkspaceScan): SpecBuild {
  const specFiles = prepared.filter((item) => item.file.kind === "spec" || item.file.kind === "schema");
  const hiddenSpecPath = scan.skipped.find((item) => {
    const path = item.path.toLowerCase();
    return path === "docs" || path === "docs/spec" || path.startsWith("docs/spec/")
      || (path === "." && item.reason === "entry_limit");
  });
  if (hiddenSpecPath) {
    return {
      summary: { status: "invalid", contractSetHash: null, schemaHash: null },
      diagnostics: [{ code: "invalid_spec", path: hiddenSpecPath.path === "." ? null : hiddenSpecPath.path }],
      features: [], rules: [], ruleEdges: [], invalid: true,
    };
  }
  if (!specFiles.length) {
    return { summary: { status: "absent", contractSetHash: null, schemaHash: null }, diagnostics: [], features: [], rules: [], ruleEdges: [], invalid: false };
  }
  const successful = specFiles.filter((item): item is PreparedRead & { result: Extract<ReadIndexFileResult, { status: "success" }> } => item.result.status === "success");
  const schemaFiles = successful.filter((item) => item.file.path === "docs/spec/schema.json");
  const rules = successful.filter((item) => item.file.path.endsWith(".rules.json") && item.file.kind === "spec");
  const unknown = specFiles.filter((item) => item.file.path !== "docs/spec/schema.json" && !item.file.path.endsWith(".rules.json"));
  const failed = specFiles.filter((item) => item.result.status !== "success");
  let actualSchemaHash: string | null = null;
  try {
    const supported = checkSpecSet([]);
    if (schemaFiles.length !== 1 || unknown.length || failed.length) throw new SpecFormatError("invalid_schema", "当前spec集合不完整");
    const diskSchema = parseStrictJson(schemaFiles[0]!.result.content);
    actualSchemaHash = createHash("sha256").update(canonicalJson(diskSchema)).digest("hex");
    if (actualSchemaHash !== supported.schemaHash) throw new SpecFormatError("invalid_schema", "当前schema与已支持格式不一致");
    const sources = rules.map((item) => ({ path: item.file.path, content: item.result.content }));
    const checked = checkSpecSet(sources);
    return buildValidSpec(checked, parseSpecDocuments(sources));
  } catch {
    const first = failed[0]?.file.path ?? unknown[0]?.file.path ?? schemaFiles[0]?.file.path ?? specFiles[0]?.file.path ?? "docs/spec/schema.json";
    return {
      summary: { status: "invalid", contractSetHash: null, schemaHash: actualSchemaHash },
      diagnostics: [{ code: "invalid_spec", path: first }],
      features: [], rules: [], ruleEdges: [], invalid: true,
    };
  }
}

async function readBranch(root: string, signal?: AbortSignal): Promise<string> {
  try {
    const result = await readGit(root, ["symbolic-ref", "-q", "HEAD"], { signal });
    const branch = result.stdout.trim();
    if (!branch.startsWith("refs/heads/") || /[\u0000-\u001f\u007f]/u.test(branch)) throw new Error("invalid branch");
    return branch;
  } catch {
    throw new ProjectIndexServiceError("invalid_identity", "git-branch");
  }
}

async function readHead(root: string, signal?: AbortSignal): Promise<string | null> {
  try {
    const result = await readGit(root, ["rev-parse", "--verify", "HEAD"], { signal });
    const head = result.stdout.trim();
    return /^[0-9a-f]{40,64}$/.test(head) ? head : null;
  } catch {
    return null;
  }
}

async function verifyRepository(rootInput: string, expectedRepoId: string, signal?: AbortSignal): Promise<VerifiedIdentity> {
  try {
    if (!isAbsolute(rootInput) || resolve(rootInput) !== rootInput) throw new Error("root");
    const stat = await lstat(rootInput);
    const root = await realpath(rootInput);
    if (!stat.isDirectory() || stat.isSymbolicLink() || root !== rootInput) throw new Error("root");
    const topResult = await readGit(root, ["rev-parse", "--show-toplevel"], { signal });
    const top = await realpath(topResult.stdout.trim());
    if (top !== root) throw new Error("top");
    const identity = await repositoryIdentity(root);
    if (identity.repoId !== expectedRepoId) throw new Error("repo");
    const branch = await readBranch(root, signal);
    const head = await readHead(root, signal);
    return { root, commonDir: identity.commonDir, repoId: identity.repoId, branch, head };
  } catch (error) {
    if (error instanceof ProjectIndexServiceError) throw error;
    throw new ProjectIndexServiceError("invalid_identity", "git-identity");
  }
}

export class ProjectIndexService {
  readonly workspace: WorkspaceIdentity;
  private readonly dataRoot: string;
  private readonly commonDir: string;
  private readonly authorize: ProjectIndexAuthorize;
  private readonly extractor: ProjectIndexExtractor;
  private readonly usesDefaultExtractor: boolean;
  private activeController: AbortController | null = null;

  private constructor(options: {
    workspace: WorkspaceIdentity;
    dataRoot: string;
    commonDir: string;
    authorize: ProjectIndexAuthorize;
    extractor: ProjectIndexExtractor;
    usesDefaultExtractor: boolean;
  }) {
    this.workspace = Object.freeze({ ...options.workspace });
    this.dataRoot = options.dataRoot;
    this.commonDir = options.commonDir;
    this.authorize = options.authorize;
    this.extractor = options.extractor;
    this.usesDefaultExtractor = options.usesDefaultExtractor;
  }

  static async open(options: ProjectIndexServiceOptions): Promise<ProjectIndexService> {
    const repositoryRoot = String(options?.repositoryRoot ?? "");
    const dataRoot = String(options?.dataRoot ?? "");
    const repoId = String(options?.repoId ?? "");
    const authorize = options?.authorize ?? (() => false);
    const extractorOption = options?.extractor;
    if (!HASH.test(repoId)) throw new ProjectIndexServiceError("invalid_identity", "open-input");
    if (!isAbsolute(dataRoot) || resolve(dataRoot) !== dataRoot) throw new ProjectIndexServiceError("invalid_data_root", "open-input");
    const authorizeAt = (phase: ProjectIndexAuthorizationPhase) => {
      let allowed = false;
      try { allowed = authorize(Object.freeze({ action: "open", phase, repoId, repositoryRoot, workspaceId: null, path: null })) === true; }
      catch { allowed = false; }
      if (!allowed) throw new ProjectIndexServiceError("authorization_denied", `open-${phase}`);
    };
    authorizeAt("before");
    const identity = await verifyRepository(repositoryRoot, repoId);
    try {
      const worktrees = await listWorktrees(identity.commonDir);
      assertDataRootOutsideWorktrees(dataRoot, worktrees);
      await inspectDataDirectoryChain(dataRoot, repoId, "open-data-root-chain");
    } catch {
      throw new ProjectIndexServiceError("invalid_data_root", "open-data-root");
    }
    authorizeAt("after");
    const workspaceId = hashParts(identity.repoId, identity.root, identity.branch);
    let extractor: ProjectIndexExtractor;
    try {
      extractor = extractorOption
        ? { extract: extractorOption.extract.bind(extractorOption), version: extractorOption.version.bind(extractorOption) }
        : { extract: extractCode, version: getCodeExtractorVersion };
    } catch {
      throw new ProjectIndexServiceError("index_failure", "open-extractor");
    }
    return new ProjectIndexService({
      workspace: { workspaceId, repoId: identity.repoId, root: identity.root, branch: identity.branch },
      dataRoot,
      commonDir: identity.commonDir,
      authorize,
      extractor,
      usesDefaultExtractor: extractorOption === undefined,
    });
  }

  cancel(): boolean {
    if (!this.activeController) return false;
    this.activeController.abort();
    return true;
  }

  /**
   * 监听器先调用本方法使普通IndexStore查询失效。它不参加构建串行锁，因而可提高fence阻止在途旧构建发布。
   */
  async markDirty(): Promise<IndexWorkspaceStatus | null> {
    this.authorizeAt("invalidate", "before");
    await this.identity();
    const chain = await inspectDataDirectoryChain(this.dataRoot, this.workspace.repoId, "invalidate-directory-chain");
    if (!chain.complete) {
      this.authorizeAt("invalidate", "return");
      return null;
    }
    const databasePath = await this.checkedDatabasePath(chain.snapshots, "invalidate-database-path");
    let stats: Stats;
    try { stats = await lstat(databasePath); }
    catch (error) {
      if (missing(error)) {
        this.authorizeAt("invalidate", "return");
        return null;
      }
      throw new ProjectIndexServiceError("invalid_database", "invalidate-database");
    }
    if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1 || (process.getuid && stats.uid !== process.getuid())) {
      throw new ProjectIndexServiceError("invalid_database", "invalidate-database");
    }
    let store: IndexStore | null = null;
    try {
      await verifyDirectories(chain.snapshots, "invalidate-before-store");
      assertRegularDatabaseFiles(databasePath);
      store = new IndexStore(databasePath, this.workspace);
      const status = store.markDirty();
      await verifyDirectories(chain.snapshots, "invalidate-after-store");
      await this.identity();
      this.authorizeAt("invalidate", "return");
      return status;
    } catch (error) {
      if (error instanceof IndexStoreError && error.code === "no_index") {
        this.authorizeAt("invalidate", "return");
        return null;
      }
      throw serviceError(error, "invalidate-store");
    } finally {
      try { store?.close(); } catch { /* 已标dirty的结果不能因关闭错误恢复成可查询。 */ }
    }
  }

  private authorizeAt(action: ProjectIndexAction, phase: ProjectIndexAuthorizationPhase, path: string | null = null): void {
    let allowed = false;
    try {
      allowed = this.authorize(Object.freeze({
        action,
        phase,
        repoId: this.workspace.repoId,
        repositoryRoot: this.workspace.root,
        workspaceId: this.workspace.workspaceId,
        path,
      })) === true;
    } catch {
      allowed = false;
    }
    if (!allowed) throw new ProjectIndexServiceError("authorization_denied", `${action}-${phase}`);
  }

  private async identity(signal?: AbortSignal): Promise<VerifiedIdentity> {
    const current = await verifyRepository(this.workspace.root, this.workspace.repoId, signal);
    if (current.commonDir !== this.commonDir || current.root !== this.workspace.root || current.branch !== this.workspace.branch) {
      throw new ProjectIndexServiceError("identity_changed", "identity-recheck");
    }
    try {
      const worktrees = await listWorktrees(current.commonDir);
      assertDataRootOutsideWorktrees(this.dataRoot, worktrees);
    } catch {
      throw new ProjectIndexServiceError("invalid_data_root", "identity-data-root");
    }
    return current;
  }

  private rawDatabasePath(): string {
    return join(this.dataRoot, "repos", this.workspace.repoId, "index.db");
  }

  private async checkedDatabasePath(snapshots: DirectorySnapshot[], stage: string): Promise<string> {
    await verifyDirectories(snapshots, `${stage}-before-path-check`);
    let path: string;
    try { path = indexDatabase(this.dataRoot, this.workspace.repoId); }
    catch { throw new ProjectIndexServiceError("invalid_database", stage); }
    if (path !== this.rawDatabasePath()) throw new ProjectIndexServiceError("invalid_database", stage);
    await verifyDirectories(snapshots, `${stage}-after-path-check`);
    return path;
  }

  private async withOperation<T>(action: ProjectIndexAction, inputSignal: AbortSignal | undefined, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.activeController) throw new ProjectIndexServiceError("operation_in_progress", `${action}-start`, true);
    const own = new AbortController();
    this.activeController = own;
    const signal = inputSignal ? AbortSignal.any([own.signal, inputSignal]) : own.signal;
    try { return await run(signal); }
    finally { if (this.activeController === own) this.activeController = null; }
  }

  async status(): Promise<ProjectIndexStatus> {
    return this.withOperation("status", undefined, async (signal) => {
      this.authorizeAt("status", "before");
      let identity = await this.identity(signal);
      this.authorizeAt("status", "after");
      const chain = await inspectDataDirectoryChain(this.dataRoot, this.workspace.repoId, "status-directory-chain");
      let index: IndexWorkspaceStatus | null = null;
      if (chain.complete) {
        const databasePath = await this.checkedDatabasePath(chain.snapshots, "status-database-path");
        let stat;
        try { stat = await lstat(databasePath); }
        catch (error) {
          if (!missing(error)) throw new ProjectIndexServiceError("invalid_database", "status-database");
        }
        if (stat) {
          if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (process.getuid && stat.uid !== process.getuid())) {
            throw new ProjectIndexServiceError("invalid_database", "status-database");
          }
          try {
            await verifyDirectories(chain.snapshots, "status-before-store");
            assertRegularDatabaseFiles(databasePath);
            await verifyDirectories(chain.snapshots, "status-before-open");
            const store = new IndexStore(databasePath, this.workspace);
            try {
              await verifyDirectories(chain.snapshots, "status-after-open");
              assertRegularDatabaseFiles(databasePath);
              try { index = store.status(); }
              catch (error) { if (!(error instanceof IndexStoreError && error.code === "no_index")) throw error; }
              await verifyDirectories(chain.snapshots, "status-after-read");
            } finally { store.close(); }
          } catch (error) { throw serviceError(error, "status-store"); }
        }
      }
      const finalChain = await inspectDataDirectoryChain(this.dataRoot, this.workspace.repoId, "status-return-chain");
      if (finalChain.complete !== chain.complete) throw new ProjectIndexServiceError("unstable", "status-directory-change", true);
      if (finalChain.complete) await verifyDirectories(finalChain.snapshots, "status-return-chain");
      identity = await this.identity(signal);
      this.authorizeAt("status", "return");
      return { action: "status", workspace: this.workspace, head: identity.head, initialized: index !== null, cacheVerified: false, index };
    });
  }

  /**
   * 可信宿主专用只读入口。paths 是调用者范围与可信基线文件的交集，不能从模型取授权。
   * 不创建空库、不刷新、不使用重建快照；全文件新增/删除与观察序号由外层基线钩子核验。
   * sourceFiles来自第一轮实际读取，单文件沿用读取策略上限、整组最多20MiB；持久片段顺序不作为连续性依据。
   * 外层先 captureFresh，再调用本方法，最后联合核对需求/文件/权限；不要在同一 coordinator 队列内嵌套排队。
   */
  async readCurrentForQuery(options: { paths: readonly string[]; signal?: AbortSignal }): Promise<CurrentQueryIndex> {
    return this.withOperation("query", options?.signal, async (signal) => {
      this.authorizeAt("query", "before");
      if (!Array.isArray(options?.paths) || options.paths.length > DEFAULT_INDEX_LIMITS.maxEntries) {
        throw new ProjectIndexServiceError("authorization_denied", "query-scope");
      }
      const paths = [...new Set(options.paths)];
      for (const path of paths) {
        try {
          if (typeof path !== "string" || /^[A-Za-z]:/u.test(path) || /[\u0000-\u001f\u007f]/u.test(path)
            || classifyIndexWatchEvent(path) !== "index") throw new Error("scope");
        } catch { throw new ProjectIndexServiceError("authorization_denied", "query-scope"); }
        this.authorizeAt("query", "read", path);
      }
      await this.identity(signal);
      const chain = await inspectDataDirectoryChain(this.dataRoot, this.workspace.repoId, "query-directory-chain");
      if (!chain.complete) throw new ProjectIndexServiceError("index_failure", "query-not-initialized");
      const databasePath = await this.checkedDatabasePath(chain.snapshots, "query-database-path");
      verifyPrivateQueryDirectories(chain.snapshots);
      try {
        const sourceFiles: SourceFragment[] = [];
        const before = IndexStore.readCurrent(databasePath, this.workspace, paths, true);
        const verifyFiles = async (collectSources = false) => {
          let bytes = 0;
          for (const file of before.snapshot?.files ?? []) {
            if (signal.aborted) throw new ProjectIndexServiceError("unstable", "query-cancelled");
            this.authorizeAt("query", "read", file.path);
            const read = await readIndexFile(this.workspace.root, file.path, { signal, readUnsupported: true });
            this.authorizeAt("query", "after", file.path);
            if (read.status !== "success" || read.sha256 !== file.hash) throw new ProjectIndexServiceError("unstable", "query-file-changed", true);
            bytes += read.size;
            if (bytes > DEFAULT_INDEX_LIMITS.maxTotalTextBytes) throw new ProjectIndexServiceError("index_failure", "query-read-budget");
            if (collectSources) sourceFiles.push({ id: `source_${hashParts(file.path, file.hash)}`, path: file.path,
              kind: file.kind, language: file.language, title: null, body: read.content, startLine: 1,
              endLine: 1 + (read.content.match(/\n/gu)?.length ?? 0), fileHash: read.sha256 });
          }
        };
        await verifyFiles(true);
        verifyPrivateQueryDirectories(chain.snapshots);
        const current = IndexStore.readCurrent(databasePath, this.workspace, paths);
        if (current.status.version !== before.status.version) throw new ProjectIndexServiceError("unstable", "query-version", true);
        await verifyFiles();
        verifyPrivateQueryDirectories(chain.snapshots);
        await verifyDirectories(chain.snapshots, "query-return-chain");
        await this.identity(signal);
        verifyPrivateQueryDirectories(chain.snapshots);
        const after = IndexStore.readCurrent(databasePath, this.workspace, paths, true);
        if (after.status.version !== before.status.version) throw new ProjectIndexServiceError("unstable", "query-return-version", true);
        for (const path of paths) this.authorizeAt("query", "return", path);
        this.authorizeAt("query", "return");
        if (signal.aborted) throw new ProjectIndexServiceError("unstable", "query-cancelled");
        return { ...current, sourceFiles };
      } catch (error) { throw serviceError(error, "query-read"); }
    });
  }

  async preview(options: ProjectIndexOperationOptions = {}): Promise<ProjectIndexPreview> {
    return this.withOperation("preview", options.signal, async (signal) => {
      this.authorizeAt("preview", "before");
      let identity = await this.identity(signal);
      this.authorizeAt("preview", "after");
      let scan: IndexWorkspaceScan;
      try {
        scan = await scanIndexWorkspace({
          root: this.workspace.root,
          dataRoot: this.dataRoot,
          signal,
          limits: options.limits,
          onProgress: (progress) => options.onProgress?.({ phase: "scan", path: progress.path, completed: progress.files, total: progress.entries }),
        });
      } catch (error) { throw serviceError(error, "preview-scan"); }
      identity = await this.identity(signal);
      this.authorizeAt("preview", "return");
      return {
        action: "preview",
        workspace: this.workspace,
        head: identity.head,
        files: scan.files,
        skipped: scan.skipped,
        archives: archiveSummary(scan.archives),
        budget: scan.budget,
        partial: scan.partial,
        databaseCreated: false,
      };
    });
  }

  async init(options: ProjectIndexOperationOptions = {}): Promise<ProjectIndexBuildResult> {
    return this.build("init", options);
  }

  async refresh(options: ProjectIndexOperationOptions = {}): Promise<ProjectIndexBuildResult> {
    return this.build("refresh", options);
  }

  private async prepareDatabase(signal: AbortSignal): Promise<{ path: string; snapshots: DirectorySnapshot[] }> {
    await this.identity(signal);
    try {
      const snapshots = await ensureDataDirectoryChain(this.dataRoot, this.workspace.repoId);
      await this.identity(signal);
      let path = await this.checkedDatabasePath(snapshots, "database-prepare-path");
      assertRegularDatabaseFiles(path);
      for (const snapshot of snapshots) {
        await verifyDirectories(snapshots, "database-directory-before-chmod");
        try { await chmod(snapshot.path, 0o700); }
        catch { throw new ProjectIndexServiceError("invalid_data_root", "database-directory-chmod"); }
        await verifyDirectories(snapshots, "database-directory-after-chmod");
      }
      path = await this.checkedDatabasePath(snapshots, "database-prepare-final-path");
      assertRegularDatabaseFiles(path);
      await verifyDirectories(snapshots, "database-prepare-return");
      return { path, snapshots };
    } catch (error) {
      if (error instanceof ProjectIndexServiceError) throw error;
      throw new ProjectIndexServiceError("invalid_database", "database-prepare");
    }
  }

  private async build(action: "init" | "refresh", options: ProjectIndexOperationOptions): Promise<ProjectIndexBuildResult> {
    return this.withOperation(action, options.signal, async (signal) => {
      const metrics: BuildMetrics = { readBytes: 0, parsedFiles: 0, reusedFiles: 0, sourceCodepoints: 0 };
      this.authorizeAt(action, "before");
      if (signal.aborted) {
        this.authorizeAt(action, "return");
        return this.cancelledResult(action, null, undefined, metrics);
      }
      await this.identity(signal);
      this.authorizeAt(action, "after");
      const database = await this.prepareDatabase(signal);
      const databasePath = database.path;
      let store: IndexStore | null = null;
      let token: ReturnType<IndexStore["begin"]> | null = null;
      let snapshot: IndexSnapshot | null = null;
      let activeScan: IndexWorkspaceScan | undefined;
      try {
        await verifyDirectories(database.snapshots, "build-before-store");
        assertRegularDatabaseFiles(databasePath);
        store = new IndexStore(databasePath, this.workspace);
        await verifyDirectories(database.snapshots, "build-after-store");
        assertRegularDatabaseFiles(databasePath);
        let previousStatus: IndexWorkspaceStatus | null = null;
        try { previousStatus = store.status(); }
        catch (error) { if (!(error instanceof IndexStoreError && error.code === "no_index")) throw error; }
        if (previousStatus && previousStatus.currentGeneration > 0) {
          try { snapshot = store.getRebuildSnapshot(); } catch { snapshot = null; }
        }
        await verifyDirectories(database.snapshots, "build-before-begin");
        token = store.begin(previousStatus?.version);
        if (signal.aborted) {
          const cancelled = store.cancel(token);
          token = null;
          this.authorizeAt(action, "return");
          return this.cancelledResult(action, cancelled, undefined, metrics);
        }

        const scan = await scanIndexWorkspace({
          root: this.workspace.root,
          dataRoot: this.dataRoot,
          signal,
          limits: options.limits,
          onProgress: (progress) => options.onProgress?.({ phase: "scan", path: progress.path, completed: progress.files, total: progress.entries }),
        });
        activeScan = scan;
        if (signal.aborted || scan.budget.stoppedReason === "cancelled") {
          const cancelled = store.cancel(token);
          token = null;
          this.authorizeAt(action, "return");
          return this.cancelledResult(action, cancelled, scan, metrics);
        }

        const prepared: PreparedRead[] = [];
        const readSkipped: IndexSkippedPath[] = [];
        for (let index = 0; index < scan.files.length; index++) {
          const file = scan.files[index]!;
          if (signal.aborted) {
            const cancelled = store.cancel(token); token = null;
            this.authorizeAt(action, "return");
            return this.cancelledResult(action, cancelled, scan, metrics);
          }
          this.authorizeAt(action, "read", file.path);
          options.onProgress?.({ phase: "read", path: file.path, completed: index, total: scan.files.length });
          const result = await readIndexFile(this.workspace.root, file, { signal, readUnsupported: true });
          this.authorizeAt(action, "after", file.path);
          metrics.readBytes += file.size;
          if (result.status !== "success") readSkipped.push({ path: file.path, reason: result.reason });
          if (metrics.readBytes > scan.budget.limits.maxTotalTextBytes) throw new ProjectIndexServiceError("index_failure", "read-budget");
          prepared.push({ file, result });
        }

        const resourceHealth = new Map<SyntaxLanguage, boolean>();
        if (this.usesDefaultExtractor) {
          const languages = [...new Set(prepared
            .filter((item) => item.result.status === "success" && item.file.kind === "code" && item.file.language !== null)
            .map((item) => item.file.language as SyntaxLanguage))].sort();
          for (const language of languages) {
            if (signal.aborted) break;
            try { await verifySyntaxResources(language); resourceHealth.set(language, true); }
            catch { resourceHealth.set(language, false); }
          }
        }

        const spec = validateSpecs(prepared, scan);
        const publication: IndexPublication = {
          status: "ready",
          diagnostics: [...spec.diagnostics],
          files: [], symbols: [], codeEdges: [],
          features: spec.features, rules: spec.rules, ruleEdges: spec.ruleEdges,
          sourceFragments: [], prodMetadata: archiveSummary(scan.archives).metadata,
        };
        for (let index = 0; index < prepared.length; index++) {
          const item = prepared[index]!;
          if (signal.aborted) {
            const cancelled = store.cancel(token); token = null;
            this.authorizeAt(action, "return");
            return this.cancelledResult(action, cancelled, scan, metrics);
          }
          if (item.result.status !== "success") {
            if (item.file.kind === "spec" || item.file.kind === "schema") diagnosticPush(publication.diagnostics, { code: "invalid_spec", path: item.file.path });
            else diagnosticPush(publication.diagnostics, { code: item.result.reason === "unreadable" ? "unreadable" : "unknown", path: item.file.path });
            continue;
          }
          const fileHash = item.result.sha256;
          let indexed: IndexedFile;
          if (item.file.kind === "code" && item.file.language) {
            options.onProgress?.({ phase: "parse", path: item.file.path, completed: index, total: prepared.length });
            const built = await this.codeFile(
              item.file,
              item.result.content,
              fileHash,
              snapshot,
              signal,
              !this.usesDefaultExtractor || resourceHealth.get(item.file.language as SyntaxLanguage) === true,
            );
            if (publication.symbols.length + built.symbols.length > MAX_PUBLISHED_SYMBOLS) {
              indexed = { ...built.file, status: "parse_error", symbolIds: [] };
              diagnosticPush(publication.diagnostics, { code: "budget_exceeded", path: item.file.path });
            } else {
              indexed = built.file;
              publication.symbols.push(...built.symbols);
              const edgeCapacity = MAX_PUBLISHED_EDGES - publication.codeEdges.length;
              if (built.edges.length > edgeCapacity) {
                publication.codeEdges.push(...built.edges.slice(0, Math.max(0, edgeCapacity)));
                diagnosticPush(publication.diagnostics, { code: "budget_exceeded", path: item.file.path });
              } else publication.codeEdges.push(...built.edges);
            }
            for (const diagnostic of built.diagnostics) diagnosticPush(publication.diagnostics, diagnostic);
            if (built.reused) metrics.reusedFiles++;
            else if (built.parsed) metrics.parsedFiles++;
          } else if (item.file.kind === "unsupported") {
            indexed = { path: item.file.path, hash: fileHash, parserVersion: UNSUPPORTED_PARSER_VERSION, status: "unsupported", kind: "code", language: null, symbolIds: [] };
            diagnosticPush(publication.diagnostics, { code: "unsupported_language", path: item.file.path });
          } else {
            const specInvalid = spec.invalid && (item.file.kind === "spec" || item.file.kind === "schema");
            indexed = {
              path: item.file.path,
              hash: fileHash,
              parserVersion: item.file.kind === "schema" ? `spec-schema@${spec.summary.schemaHash ?? "invalid"}` : item.file.kind === "spec" ? `spec-format@${spec.summary.schemaHash ?? "invalid"}` : TEXT_PARSER_VERSION,
              status: specInvalid ? "invalid" : "indexed",
              kind: mappedKind(item.file),
              language: item.file.kind === "spec" || item.file.kind === "schema" ? "json" : null,
              symbolIds: [],
            };
          }
          publication.files.push(indexed);
          const includeBody = !spec.invalid || (item.file.kind !== "spec" && item.file.kind !== "schema");
          if (includeBody) {
            const next = fragments(item.file, item.result.content, fileHash);
            publication.sourceFragments.push(...next);
            metrics.sourceCodepoints += next.reduce((sum, fragment) => sum + codepoints(fragment.body), 0);
          }
        }

        if (scan.partial || publication.files.some((file) => file.status === "parse_error" || file.status === "unsupported")
          || prepared.some((item) => item.result.status !== "success")
          || publication.diagnostics.some((item) => item.code === "budget_exceeded" || item.code === "parser_unavailable" || item.code === "syntax_error" || item.code === "unreadable")) {
          publication.status = "partial";
        }
        if (scan.budget.exhausted.length) diagnosticPush(publication.diagnostics, { code: "budget_exceeded", path: null });
        if (spec.invalid) publication.status = "invalid";

        options.onProgress?.({ phase: "verify", path: ".", completed: 0, total: scan.files.length });
        this.authorizeAt(action, "publish");
        await this.identity(signal);
        const finalScan = await scanIndexWorkspace({ root: this.workspace.root, dataRoot: this.dataRoot, signal, limits: options.limits });
        if (signal.aborted) {
          const cancelled = store.cancel(token); token = null;
          this.authorizeAt(action, "return");
          return this.cancelledResult(action, cancelled, finalScan, metrics);
        }
        if (comparableScan(finalScan) !== comparableScan(scan)) throw new ProjectIndexServiceError("unstable", "verify-file-list", true);
        let verificationReadBytes = 0;
        for (let index = 0; index < prepared.length; index++) {
          const item = prepared[index]!;
          this.authorizeAt(action, "read", item.file.path);
          options.onProgress?.({ phase: "verify", path: item.file.path, completed: index, total: prepared.length });
          const current = await readIndexFile(this.workspace.root, item.file, { signal, readUnsupported: true });
          verificationReadBytes += item.file.size;
          metrics.readBytes += item.file.size;
          if (verificationReadBytes > finalScan.budget.limits.maxTotalTextBytes) {
            throw new ProjectIndexServiceError("index_failure", "verify-read-budget");
          }
          this.authorizeAt(action, "after", item.file.path);
          if (readSignature(current) !== readSignature(item.result)) throw new ProjectIndexServiceError("unstable", "verify-hash", true);
        }
        await this.identity(signal);
        const baselineHash = contentBaselineHash(this.workspace, scan, prepared, publication, spec.summary);
        await verifyDirectories(database.snapshots, "build-before-publish");
        this.authorizeAt(action, "publish");
        const status = store.publish(token, publication, baselineHash);
        token = null;
        await verifyDirectories(database.snapshots, "build-after-publish");
        const finalIdentity = await this.identity(signal);
        this.authorizeAt(action, "return");
        const archives = archiveSummary(scan.archives);
        return {
          action,
          workspace: this.workspace,
          head: finalIdentity.head,
          status: status.status as "ready" | "partial" | "invalid",
          generation: status.currentGeneration,
          baselineHash: status.baselineHash,
          parsedFiles: metrics.parsedFiles,
          reusedFiles: metrics.reusedFiles,
          readBytes: metrics.readBytes,
          sourceCodepoints: metrics.sourceCodepoints,
          files: publication.files.length,
          symbols: publication.symbols.length,
          codeEdges: publication.codeEdges.length,
          diagnostics: publication.diagnostics,
          skipped: [...scan.skipped, ...readSkipped].sort((a, b) => a.path.localeCompare(b.path) || a.reason.localeCompare(b.reason)),
          archives,
          budget: scan.budget,
          spec: spec.summary,
          watchPlan: {
            directories: [...scan.watchDirectories],
            archiveDirectories: [...scan.archiveWatchDirectories],
          },
        };
      } catch (error) {
        let cancelledStatus: IndexWorkspaceStatus | null = null;
        if (store && token) {
          try {
            if (signal.aborted) cancelledStatus = store.cancel(token);
            else store.interrupt(token);
          } catch {
            // 新fence或数据库故障时保持原真实状态，不用第二个错误覆盖固定对外错误。
          }
        }
        if (error instanceof ProjectIndexServiceError && error.code === "authorization_denied") throw error;
        if (signal.aborted && cancelledStatus) {
          this.authorizeAt(action, "return");
          return this.cancelledResult(action, cancelledStatus, activeScan, metrics);
        }
        throw serviceError(error, "build");
      } finally {
        try { store?.close(); } catch { /* 关闭错误不暴露底层正文或OS细节。 */ }
      }
    });
  }

  private async codeFile(
    file: IndexFile,
    source: string,
    hash: string,
    snapshot: IndexSnapshot | null,
    signal: AbortSignal,
    resourcesAvailable: boolean,
  ): Promise<CodeBuild> {
    const language = file.language as SyntaxLanguage;
    if (!resourcesAvailable) {
      return {
        file: { path: file.path, hash, parserVersion: "parser-unavailable@1", status: "parse_error", kind: "code", language, symbolIds: [] },
        symbols: [], edges: [], diagnostics: [{ code: "parser_unavailable", path: file.path }], reused: false, parsed: false,
      };
    }
    let parserVersion: string;
    try { parserVersion = this.extractor.version(language); }
    catch {
      return {
        file: { path: file.path, hash, parserVersion: "parser-unavailable@1", status: "parse_error", kind: "code", language, symbolIds: [] },
        symbols: [], edges: [], diagnostics: [{ code: "parser_unavailable", path: file.path }], reused: false, parsed: false,
      };
    }
    const cached = cacheForFile(snapshot, file.path, hash, parserVersion);
    if (cached) return cached;
    try {
      const result = await this.extractor.extract({ path: file.path, language, source, signal });
      if (result.path !== file.path || result.language !== language || result.extractorVersion !== parserVersion) throw new Error("extractor result mismatch");
      const mapped = mapExtraction(file.path, result);
      return {
        file: {
          path: file.path,
          hash,
          parserVersion,
          status: result.status === "complete" ? "indexed" : "parse_error",
          kind: "code",
          language,
          symbolIds: mapped.symbols.map((symbol) => symbol.id),
        },
        ...mapped,
        diagnostics: result.status === "partial" ? [{ code: "syntax_error", path: file.path }] : [],
        reused: false,
        parsed: true,
      };
    } catch (error) {
      if (signal.aborted || (error as { code?: unknown }).code === "cancelled") throw error;
      return {
        file: { path: file.path, hash, parserVersion, status: "parse_error", kind: "code", language, symbolIds: [] },
        symbols: [], edges: [], diagnostics: [{ code: "parser_unavailable", path: file.path }], reused: false, parsed: true,
      };
    }
  }

  private cancelledResult(
    action: "init" | "refresh",
    status: IndexWorkspaceStatus | null,
    scan?: IndexWorkspaceScan,
    metrics: BuildMetrics = { readBytes: 0, parsedFiles: 0, reusedFiles: 0, sourceCodepoints: 0 },
  ): ProjectIndexBuildResult {
    const emptyBudget: IndexBudgetResult = {
      limits: { ...DEFAULT_INDEX_LIMITS },
      used: { entries: 0, textBytes: 0 },
      exhausted: [],
      stoppedReason: "cancelled",
    };
    return {
      action,
      workspace: this.workspace,
      head: null,
      status: "cancelled",
      generation: status?.currentGeneration ?? 0,
      baselineHash: null,
      parsedFiles: metrics.parsedFiles,
      reusedFiles: metrics.reusedFiles,
      readBytes: metrics.readBytes,
      sourceCodepoints: metrics.sourceCodepoints,
      files: 0,
      symbols: 0,
      codeEdges: 0,
      diagnostics: [],
      skipped: scan?.skipped ?? [],
      archives: archiveSummary(scan?.archives ?? []),
      budget: scan ? { ...scan.budget, stoppedReason: "cancelled" } : emptyBudget,
      spec: { status: "absent", contractSetHash: null, schemaHash: null },
      watchPlan: {
        directories: [...(scan?.watchDirectories ?? [])],
        archiveDirectories: [...(scan?.archiveWatchDirectories ?? [])],
      },
    };
  }
}
