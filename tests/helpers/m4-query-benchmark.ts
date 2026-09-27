import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import { appendFileSync, chmodSync, lstatSync, realpathSync, writeFileSync } from "node:fs";
import type { ProjectIndexHost } from "../../daemon/project-index-host.ts";
import type { DaemonServer } from "../../daemon/server.ts";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, statfs, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { createConnection } from "node:net";
import type { Socket } from "node:net";
import { cpus, release, tmpdir, totalmem, version } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export interface QueryBenchmarkConfig {
  files: number;
  scriptFiles: number;
  goFiles: number;
  specFiles: number;
  archiveCounts: readonly number[];
  samplesPerQuery: number;
  maxTextBytes: number;
  rpcTimeoutMs: number;
}

export interface QueryCase {
  id: "exact-path" | "chinese-search" | "finite-facts";
  request: Readonly<Record<string, unknown>>;
  combinedThresholdMs: number;
  thresholdSource: string;
}

export interface QuerySample {
  archiveCount: number;
  queryId: QueryCase["id"];
  index: number;
  ok: boolean;
  queryMs: number | null;
  combinedMs: number | null;
  responseBytes: number | null;
  pageBytes: number | null;
  generation: number | null;
  baselineHash: string | null;
  requirement: unknown;
  hitCount: number | null;
  hitIdentifiers: string[];
  hitPaths: string[];
  expectedHitObserved: boolean;
  coverage: null | {
    matched: number;
    returned: number;
    omitted: number;
    remaining: number;
    sourceExcerptsTruncated: number;
    complete: boolean;
    nextCursor: boolean;
  };
  unknown: null | {
    performanceImprovement: unknown;
    formalVerification: unknown;
    unknownCodeRelations: unknown;
    unindexedFiles: unknown;
  };
  error?: { code: string; message: string };
}

export const FORMAL_QUERY_BENCHMARK: Readonly<QueryBenchmarkConfig> = Object.freeze({
  files: 1000,
  scriptFiles: 600,
  goFiles: 300,
  specFiles: 100,
  archiveCounts: Object.freeze([0, 1000, 10000]),
  samplesPerQuery: 100,
  maxTextBytes: 20 * 1024 * 1024,
  rpcTimeoutMs: 30_000,
});

export const SMOKE_QUERY_BENCHMARK: Readonly<QueryBenchmarkConfig> = Object.freeze({
  files: 12,
  scriptFiles: 7,
  goFiles: 3,
  specFiles: 2,
  archiveCounts: Object.freeze([2]),
  samplesPerQuery: 2,
  maxTextBytes: 20 * 1024 * 1024,
  rpcTimeoutMs: 30_000,
});

export const QUERY_CASES: readonly QueryCase[] = Object.freeze([
  Object.freeze({
    id: "exact-path" as const,
    request: Object.freeze({ action: "exact", by: "path", value: "src/file0000.ts", pageSize: 10, maxBytes: 16_384 }),
    combinedThresholdMs: 500,
    thresholdSource: "SQLITE-KNOWLEDGE-REBUILD-PLAN.md §13.2 hot exact query reference",
  }),
  Object.freeze({
    id: "chinese-search" as const,
    request: Object.freeze({ action: "search", text: "中文搜索问题固定词", pageSize: 20, maxBytes: 24_576 }),
    combinedThresholdMs: 2_000,
    thresholdSource: "SQLITE-KNOWLEDGE-REBUILD-PLAN.md §13.2 bounded combined fact package reference",
  }),
  Object.freeze({
    id: "finite-facts" as const,
    request: Object.freeze({ action: "facts", text: "有限事实问题固定词", pageSize: 20, maxBytes: 24_576 }),
    combinedThresholdMs: 2_000,
    thresholdSource: "SQLITE-KNOWLEDGE-REBUILD-PLAN.md §13.2 bounded combined fact package reference",
  }),
]);

interface QuerySummary {
  archiveCount: number;
  queryId: QueryCase["id"];
  count: number;
  failures: number;
  rank: number;
  queryP95Ms: number | null;
  combinedP95Ms: number | null;
  p95IncludesFailure: boolean;
  responseBytes: { minimum: number | null; maximum: number | null; total: number };
  truncationSamples: number;
  unknownSamples: number;
  combinedThresholdMs: number;
  thresholdResult: "within_reference" | "outside_reference";
}

const sha256 = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");
const byteLength = (value: unknown): number => Buffer.byteLength(JSON.stringify(value));

function errorRecord(error: unknown): { code: string; message: string } {
  const value = error as { code?: unknown; message?: unknown };
  return {
    code: typeof value?.code === "string" ? value.code : "unknown",
    message: typeof value?.message === "string" ? value.message : String(error),
  };
}

interface QueryHitFact {
  kind?: unknown;
  id?: unknown;
  source?: { path?: unknown };
}

export interface QueryHitSummary {
  hitCount: number;
  hitIdentifiers: string[];
  hitPaths: string[];
  expectedHitObserved: boolean;
}

/** 只保留有界标识和路径，不把命中的源码/spec正文复制进样本证据。 */
export function summarizeQueryHits(queryId: QueryCase["id"], facts: unknown): QueryHitSummary {
  if (!Array.isArray(facts)) throw Object.assign(new Error("query_facts_missing"), { code: "query_facts_missing" });
  const normalized = facts.map((fact): { kind: string; id: string; path: string } | null => {
    const value = fact as QueryHitFact;
    return typeof value?.kind === "string" && typeof value.id === "string" && typeof value.source?.path === "string"
      ? { kind: value.kind, id: value.id, path: value.source.path }
      : null;
  }).filter((fact): fact is { kind: string; id: string; path: string } => fact !== null);
  const expectedHitObserved = queryId === "exact-path"
    ? normalized.some((fact) => fact.path === "src/file0000.ts")
    : normalized.some((fact) => fact.kind === "source" && fact.path === "docs/spec/rule0000.rules.json");
  if (!normalized.length || !expectedHitObserved) {
    throw Object.assign(new Error(`query_expected_hit_missing:${queryId}`), { code: "query_expected_hit_missing" });
  }
  return {
    hitCount: normalized.length,
    hitIdentifiers: [...new Set(normalized.map((fact) => `${fact.kind}:${fact.id}`))].sort().slice(0, 32),
    hitPaths: [...new Set(normalized.map((fact) => fact.path))].sort().slice(0, 32),
    expectedHitObserved,
  };
}

/** 页面预算只约束page，不包含RPC外壳；索引代次允许在内容基线不变时前进。 */
export function assertQueryPageMetadata(page: { generation?: unknown }, maxBytes: number): void {
  if (byteLength(page) > maxBytes) throw Object.assign(new Error("query_page_budget_exceeded"), { code: "query_page_budget_exceeded" });
  if (!Number.isSafeInteger(page.generation) || Number(page.generation) < 1) {
    throw Object.assign(new Error("query_generation_invalid"), { code: "query_generation_invalid" });
  }
}

async function settleWithin(completion: Promise<void>, timeoutMs: number, code: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      completion,
      new Promise<void>((_accept, reject) => { timer = setTimeout(() => reject(new Error(code)), timeoutMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function percentile(values: Array<number | null>, successes: boolean[], rank: number): number | null {
  const ordered = values.map((value, index) => successes[index] && value !== null ? value : Infinity).sort((a, b) => a - b);
  const selected = ordered[rank - 1];
  return Number.isFinite(selected) ? selected! : null;
}

export function summarizeQuerySamples(samples: readonly QuerySample[]): QuerySummary[] {
  const summaries: QuerySummary[] = [];
  for (const archiveCount of [...new Set(samples.map((sample) => sample.archiveCount))].sort((a, b) => a - b)) {
    for (const query of QUERY_CASES) {
      const selected = samples.filter((sample) => sample.archiveCount === archiveCount && sample.queryId === query.id);
      if (!selected.length) continue;
      const rank = Math.ceil(0.95 * selected.length);
      const successes = selected.map((sample) => sample.ok);
      const combinedP95Ms = percentile(selected.map((sample) => sample.combinedMs), successes, rank);
      const responseBytes = selected.map((sample) => sample.responseBytes).filter((value): value is number => value !== null);
      summaries.push({
        archiveCount,
        queryId: query.id,
        count: selected.length,
        failures: selected.filter((sample) => !sample.ok).length,
        rank,
        queryP95Ms: percentile(selected.map((sample) => sample.queryMs), successes, rank),
        combinedP95Ms,
        p95IncludesFailure: combinedP95Ms === null,
        responseBytes: {
          minimum: responseBytes.length ? Math.min(...responseBytes) : null,
          maximum: responseBytes.length ? Math.max(...responseBytes) : null,
          total: responseBytes.reduce((sum, value) => sum + value, 0),
        },
        truncationSamples: selected.filter((sample) => sample.coverage && (!sample.coverage.complete || sample.coverage.omitted > 0
          || sample.coverage.remaining > 0 || sample.coverage.sourceExcerptsTruncated > 0 || sample.coverage.nextCursor)).length,
        unknownSamples: selected.filter((sample) => sample.unknown !== null).length,
        combinedThresholdMs: query.combinedThresholdMs,
        thresholdResult: combinedP95Ms !== null && combinedP95Ms <= query.combinedThresholdMs ? "within_reference" : "outside_reference",
      });
    }
  }
  return summaries;
}

function createJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
}

function appendSample(output: string, sample: QuerySample): void {
  appendFileSync(join(output, "samples.jsonl"), `${JSON.stringify(sample)}\n`, { mode: 0o600 });
}

function specText(index: number): string {
  const markers = index === 0 ? " 中文搜索问题固定词 有限事实问题固定词" : "";
  return `${JSON.stringify({
    $schema: "schema.json",
    schemaVersion: 1,
    feature: { id: `benchmark.feature${index}`, title: `基准功能${index}${markers}`, aliases: [`基准别名${index}`] },
    rules: [{
      id: `benchmark.rule${index}`,
      title: `基准规则${index}`,
      condition: "收到固定输入",
      trigger: "查询当前项目",
      expected: `返回可核对结果${index}${markers}`,
      reason: "保持事实包范围有限且可重复",
      dependsOn: [],
      exceptions: [],
      acceptance: [{ id: "result", given: "输入有效", when: "执行查询", then: `结果可核对${index}` }],
    }],
  })}\n`;
}

interface GitProcessRecord {
  args: string[];
  pid: number | null;
  code: number | null;
  signal: NodeJS.Signals | null;
  durationMs: number;
}

class GitRunner {
  readonly records: GitProcessRecord[] = [];
  readonly active = new Set<number>();
  private readonly home: string;
  constructor(home: string) {
    this.home = home;
  }

  async run(cwd: string, args: string[]): Promise<string> {
    const completeArgs = ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", "-c", "core.fsmonitor=false", ...args];
    const started = performance.now();
    const child = spawn("git", completeArgs, {
      cwd,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: this.home,
        TMPDIR: this.home,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
        GIT_AUTHOR_NAME: "m4-query-benchmark",
        GIT_AUTHOR_EMAIL: "benchmark@localhost",
        GIT_COMMITTER_NAME: "m4-query-benchmark",
        GIT_COMMITTER_EMAIL: "benchmark@localhost",
        GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
        GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (child.pid) this.active.add(child.pid);
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 30_000);
    try {
      const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((accept, reject) => {
        child.once("error", reject);
        child.once("close", (code, signal) => accept({ code, signal }));
      });
      this.records.push({ args: [...args], pid: child.pid ?? null, ...result, durationMs: performance.now() - started });
      if (timedOut || result.code !== 0 || result.signal !== null) {
        throw new Error(`git_failed:${args[0] ?? "unknown"}:${Buffer.concat(stderr).toString("utf8").trim()}`);
      }
      return Buffer.concat(stdout).toString("utf8").trim();
    } finally {
      clearTimeout(timer);
      if (child.pid) this.active.delete(child.pid);
    }
  }
}

interface FixtureManifest {
  generator: string;
  sourceFiles: number;
  textBytes: number;
  distinctContentHashes: number;
  sourceManifestHash: string;
  scripts: number;
  go: number;
  specsIncludingSchema: number;
  archiveMetadataCount: number;
  archivePathSetHash: string;
  files: Array<{ path: string; bytes: number; sha256: string; kind: string }>;
}

async function createFixture(
  fixtureRoot: string,
  config: Readonly<QueryBenchmarkConfig>,
  archiveCount: number,
  scriptRoot: string,
  git: GitRunner,
): Promise<{ repo: string; dataRoot: string; manifest: FixtureManifest }> {
  const repo = join(fixtureRoot, "repo");
  const dataRoot = join(fixtureRoot, "data");
  await mkdir(repo, { mode: 0o700 });
  await mkdir(dataRoot, { mode: 0o700 });
  const files: FixtureManifest["files"] = [];
  const put = async (path: string, text: string, kind: string) => {
    const target = join(repo, path);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, text, { mode: 0o600, flag: "wx" });
    const actual = await readFile(target);
    files.push({ path, bytes: actual.byteLength, sha256: sha256(actual), kind });
  };
  const extensions = ["ts", "tsx", "js", "jsx"];
  for (let index = 0; index < config.scriptFiles; index++) {
    const extension = extensions[index % extensions.length]!;
    const markers = index === 0 ? "中文搜索问题固定词 有限事实问题固定词" : `唯一内容${index}`;
    const body = extension === "tsx" || extension === "jsx"
      ? `export function component${index}() { return <span>${markers}-${index}</span>; }\n`
      : `export function value${index}() { return ${JSON.stringify(`${markers}-${index}`)}; }\n`;
    await put(`src/file${String(index).padStart(4, "0")}.${extension}`, body, extension);
  }
  for (let index = 0; index < config.goFiles; index++) {
    await put(`go/file${String(index).padStart(4, "0")}.go`, `package benchmark\nfunc Value${index}() string { return "唯一Go内容${index}" }\n`, "go");
  }
  await put("docs/spec/schema.json", `${JSON.stringify({ note: "遗留规则目录里的普通文件" })}\n`, "schema");
  for (let index = 0; index < config.specFiles - 1; index++) {
    await put(`docs/spec/rule${String(index).padStart(4, "0")}.rules.json`, specText(index), "spec");
  }
  files.sort((left, right) => left.path.localeCompare(right.path, "en"));
  const textBytes = files.reduce((sum, file) => sum + file.bytes, 0);
  const distinctContentHashes = new Set(files.map((file) => file.sha256)).size;
  if (files.length !== config.files || config.scriptFiles + config.goFiles + config.specFiles !== config.files
    || distinctContentHashes !== config.files || textBytes > config.maxTextBytes) {
    throw new Error(`fixture_contract_failed:${JSON.stringify({ files: files.length, distinctContentHashes, textBytes })}`);
  }
  await git.run(repo, ["init", "--template=", "-b", "main"]);
  await git.run(repo, ["add", "--", "src", "go", "docs/spec"]);
  await git.run(repo, ["commit", "-m", "query benchmark fixture"]);
  await mkdir(join(repo, "docs/prod"), { recursive: true, mode: 0o700 });
  const archivePaths: string[] = [];
  for (let index = 0; index < archiveCount; index++) {
    const requirementId = `019b76da-a800-7000-8000-${index.toString(16).padStart(12, "0")}`;
    const path = `docs/prod/${requirementId}.基准归档.md`;
    await writeFile(join(repo, path), `M4_ARCHIVE_BODY_CANARY_${index}\n`, { mode: 0o600, flag: "wx" });
    archivePaths.push(path);
  }
  return {
    repo,
    dataRoot,
    manifest: {
      generator: "m4-query-benchmark-deterministic-v1",
      sourceFiles: files.length,
      textBytes,
      distinctContentHashes,
      sourceManifestHash: sha256(JSON.stringify(files)),
      scripts: config.scriptFiles,
      go: config.goFiles,
      specsIncludingSchema: config.specFiles,
      archiveMetadataCount: archiveCount,
      archivePathSetHash: sha256(JSON.stringify(archivePaths)),
      files,
    },
  };
}

interface ReadProbe {
  positiveControlReads: number;
  archiveBodyReadAttempts: number;
  attemptedArchivePaths: string[];
}

function pathFromFsArgument(value: unknown): string | null {
  if (typeof value === "string") return resolve(value);
  if (value instanceof URL) return fileURLToPath(value);
  if (Buffer.isBuffer(value)) return resolve(value.toString());
  return null;
}

function installArchiveReadProbe(repo: string, positivePath: string): { probe: ReadProbe; restore(): void } {
  const probe: ReadProbe = { positiveControlReads: 0, archiveBodyReadAttempts: 0, attemptedArchivePaths: [] };
  const archivePrefix = `${join(repo, "docs/prod")}${sep}`;
  const restorers: Array<() => void> = [];
  const observe = (args: unknown[]) => {
    const path = pathFromFsArgument(args[0]);
    if (path === positivePath) probe.positiveControlReads++;
    if (path?.startsWith(archivePrefix)) {
      probe.archiveBodyReadAttempts++;
      if (probe.attemptedArchivePaths.length < 20) probe.attemptedArchivePaths.push(relative(repo, path));
      throw Object.assign(new Error("archive_body_read_attempt"), { code: "archive_body_read_attempt" });
    }
  };
  const wrap = (target: object, key: string) => {
    const descriptor = Object.getOwnPropertyDescriptor(target, key);
    if (!descriptor || typeof descriptor.value !== "function") throw new Error(`read_probe_install_failed:${key}`);
    const original = descriptor.value as (...args: unknown[]) => unknown;
    Object.defineProperty(target, key, { ...descriptor, value: function(this: unknown, ...args: unknown[]) {
      observe(args);
      return Reflect.apply(original, this, args);
    } });
    restorers.push(() => Object.defineProperty(target, key, descriptor));
  };
  for (const key of ["open", "readFile"]) wrap(fs.promises, key);
  for (const key of ["open", "openSync", "readFile", "readFileSync", "createReadStream"]) wrap(fs, key);
  syncBuiltinESMExports();
  return {
    probe,
    restore() {
      for (const restore of restorers.reverse()) restore();
      syncBuiltinESMExports();
    },
  };
}

interface ProtocolModule {
  PROTOCOL_VERSION: number;
  createRequest(method: string, params: Record<string, unknown>): { id: string } & Record<string, unknown>;
  decodeFrames(buffer: string): { frames: Array<Record<string, unknown>>; rest: string };
  encodeFrame(frame: Record<string, unknown>): string;
}

interface Peer {
  call(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>>;
  close(): void;
  closed: Promise<void>;
}

async function connectPeer(
  path: string,
  token: string,
  repoId: string,
  root: string,
  timeoutMs: number,
  protocol: ProtocolModule,
): Promise<Peer> {
  const socket: Socket = createConnection(path);
  let buffer = "";
  let closed = false;
  const pending = new Map<string, { accept(value: Record<string, unknown>): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  const closedPromise = new Promise<void>((accept) => socket.once("close", () => accept()));
  socket.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    const decoded = protocol.decodeFrames(buffer);
    buffer = decoded.rest;
    for (const frame of decoded.frames) {
      if (frame.t !== "res" || typeof frame.id !== "string") continue;
      const waiter = pending.get(frame.id);
      if (!waiter) continue;
      pending.delete(frame.id);
      clearTimeout(waiter.timer);
      if (frame.ok === true) waiter.accept(frame.result as Record<string, unknown>);
      else {
        const payload = frame.error as { code?: string; message?: string; data?: Record<string, unknown> };
        waiter.reject(Object.assign(new Error(payload?.message ?? "rpc_error"), { code: payload?.code ?? "rpc_error", data: payload?.data }));
      }
    }
  });
  const rejectPending = () => {
    if (closed) return;
    closed = true;
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(Object.assign(new Error("rpc_connection_closed"), { code: "connection_closed" }));
    }
    pending.clear();
  };
  socket.once("close", rejectPending);
  socket.once("error", rejectPending);
  try {
    await new Promise<void>((accept, reject) => {
      socket.once("connect", accept);
      socket.once("error", reject);
    });
  } catch (error) {
    socket.destroy();
    try { await settleWithin(closedPromise, 5_000, "peer_connect_cleanup_timeout"); }
    catch (cleanupError) {
      throw Object.assign(new AggregateError([error, cleanupError], "peer_connect_cleanup_failed"),
        { code: "peer_cleanup_failed", resourceCleanupFailed: true });
    }
    throw error;
  }
  const peer: Peer = {
    closed: closedPromise,
    call(method, params) {
      if (closed) return Promise.reject(Object.assign(new Error("rpc_connection_closed"), { code: "connection_closed" }));
      const request = protocol.createRequest(method, params);
      return new Promise((accept, reject) => {
        const timer = setTimeout(() => {
          pending.delete(request.id);
          reject(Object.assign(new Error(`rpc_timeout:${method}`), { code: "rpc_timeout" }));
          socket.destroy();
        }, timeoutMs);
        pending.set(request.id, { accept, reject, timer });
        socket.write(protocol.encodeFrame(request));
      });
    },
    close() { socket.destroy(); },
  };
  try {
    await peer.call("hello", {
      authToken: token,
      windowId: "m4-query-benchmark",
      pid: process.pid,
      sessionId: "m4-query-benchmark-session",
      cwd: root,
      workspaceRoot: root,
      repoIds: [repoId],
      protocolVersion: protocol.PROTOCOL_VERSION,
    });
    return peer;
  } catch (error) {
    peer.close();
    try { await settleWithin(peer.closed, 5_000, "peer_hello_cleanup_timeout"); }
    catch (cleanupError) {
      throw Object.assign(new AggregateError([error, cleanupError], "peer_hello_cleanup_failed"),
        { code: "peer_cleanup_failed", resourceCleanupFailed: true });
    }
    throw error;
  }
}

function emptySample(archiveCount: number, queryId: QueryCase["id"], index: number, error: unknown): QuerySample {
  return {
    archiveCount,
    queryId,
    index,
    ok: false,
    queryMs: null,
    combinedMs: null,
    responseBytes: null,
    pageBytes: null,
    generation: null,
    baselineHash: null,
    requirement: null,
    hitCount: null,
    hitIdentifiers: [],
    hitPaths: [],
    expectedHitObserved: false,
    coverage: null,
    unknown: null,
    error: errorRecord(error),
  };
}

function resourceSnapshot() {
  const handles = (process as unknown as { _getActiveHandles?: () => object[] })._getActiveHandles?.() ?? [];
  const byType: Record<string, number> = {};
  for (const handle of handles) {
    const name = handle.constructor?.name ?? "unknown";
    byType[name] = (byType[name] ?? 0) + 1;
  }
  return { memory: process.memoryUsage(), activeHandles: byType, activeResources: process.getActiveResourcesInfo() };
}

async function codeInputs(scriptRoot: string): Promise<Array<{ path: string; sha256: string }>> {
  const paths = [
    "tests/helpers/m4-query-benchmark.ts",
    "daemon/project-index-host.ts",
    "daemon/server.ts",
    "runtime/knowledge-query.ts",
    "runtime/knowledge-query-contracts.ts",
    "runtime/project-index-service.ts",
    "runtime/project-index-policy.ts",
    "runtime/index-store.ts",
    "runtime/protocol.ts",
    "runtime/identity.ts",
    "runtime/git-read.ts",
    "runtime/command-boundary.ts",
    "runtime/database.ts",
    "resources/tree-sitter/manifest.json",
    "package.json",
    "pnpm-lock.yaml",
  ];
  return Promise.all(paths.map(async (path) => ({ path, sha256: sha256(await readFile(join(scriptRoot, path))) })));
}

async function runTier(input: {
  output: string;
  scriptRoot: string;
  config: Readonly<QueryBenchmarkConfig>;
  archiveCount: number;
  git: GitRunner;
  interrupted: () => boolean;
  faultInjection: "host_close_after_success" | null;
}): Promise<{ samples: QuerySample[]; setup: Record<string, unknown>; cleanup: Record<string, unknown> }> {
  const tierOutput = join(input.output, `closed-metadata-${input.archiveCount}`);
  await mkdir(tierOutput, { mode: 0o700 });
  const fixtureRoot = await realpath(await mkdtemp(join(await realpath(tmpdir()), "m4-query-benchmark-fixture-")));
  const socketRoot = await realpath(await mkdtemp(join(await realpath("/tmp"), "m4q-")));
  chmodSync(fixtureRoot, 0o700);
  chmodSync(socketRoot, 0o700);
  const samples: QuerySample[] = [];
  const cleanupErrors: string[] = [];
  let peer: Peer | undefined;
  let host: ProjectIndexHost | undefined;
  let server: DaemonServer | undefined;
  let probeControl: ReturnType<typeof installArchiveReadProbe> | undefined;
  let manifest: FixtureManifest | undefined;
  let setup: Record<string, unknown> = { ok: false };
  let preHandoffPeerCleanupFailed = false;
  const started = performance.now();
  try {
    const fixture = await createFixture(fixtureRoot, input.config, input.archiveCount, input.scriptRoot, input.git);
    manifest = fixture.manifest;
    createJson(join(tierOutput, "fixture-manifest.json"), manifest);
    const positivePath = join(fixtureRoot, "read-probe-positive.txt");
    await writeFile(positivePath, "positive control\n", { mode: 0o600 });
    probeControl = installArchiveReadProbe(fixture.repo, positivePath);
    await fs.promises.readFile(positivePath);
    if (probeControl.probe.positiveControlReads < 1) throw new Error("archive_read_probe_positive_control_failed");

    const [{ DaemonServer }, { ProjectIndexHost: Host, registerIndexHandlers }, { repoDataDir, repositoryIdentity }, { ProjectIndexService }, protocolModule] = await Promise.all([
      import("../../daemon/server.ts"),
      import("../../daemon/project-index-host.ts"),
      import("../../runtime/identity.ts"),
      import("../../runtime/project-index-service.ts"),
      import("../../runtime/protocol.ts"),
    ]);
    const identity = await repositoryIdentity(fixture.repo);
    await repoDataDir(fixture.dataRoot, identity.repoId, identity.commonDir);
    const token = randomBytes(32).toString("hex");
    const activeServer = new DaemonServer({
      authToken: token,
      repoId: identity.repoId,
      startedAt: "m4-query-benchmark",
    });
    server = activeServer;
    // macOS的Unix socket路径上限较短；单独使用本轮创建的短私有目录，并在finally精确清理。
    const socketPath = join(socketRoot, "q.sock");
    await activeServer.listen(socketPath);
    let archiveRiskHooks = 0;
    host = new Host({
      repoId: identity.repoId,
      dataRoot: fixture.dataRoot,
      repositoryRoot: fixture.repo,
      beforeArchiveRisk: async () => { archiveRiskHooks++; },
    });
    registerIndexHandlers(activeServer, host);
    activeServer.markHandlersReady();
    const service = await ProjectIndexService.open({
      repositoryRoot: fixture.repo,
      dataRoot: fixture.dataRoot,
      repoId: identity.repoId,
      authorize: () => true,
    });
    peer = await connectPeer(
      socketPath,
      token,
      identity.repoId,
      fixture.repo,
      input.config.rpcTimeoutMs,
      protocolModule as unknown as ProtocolModule,
    );
    const initStarted = performance.now();
    const initialized = (await peer.call("index.manage", { action: "init" })).result as Record<string, unknown>;
    const initMs = performance.now() - initStarted;
    // init后首次查询要做一次完整对账重建；预热一次，计时样本只测指纹未变时的查询。
    const warmupStarted = performance.now();
    await peer.call("knowledge.query", { query: QUERY_CASES[0]!.request });
    const warmupMs = performance.now() - warmupStarted;
    const archives = initialized.archives as { metadata?: unknown[]; issues?: unknown[] };
    if (initialized.status !== "ready" || initialized.files !== input.config.files
      || archives?.metadata?.length !== input.archiveCount || archives?.issues?.length !== 0
      || typeof initialized.baselineHash !== "string" || !/^[0-9a-f]{64}$/u.test(initialized.baselineHash)) {
      throw new Error(`index_initialization_contract_failed:${JSON.stringify(initialized)}`);
    }
    setup = {
      ok: true,
      initMs,
      warmupMs,
      status: initialized.status,
      generation: initialized.generation,
      baselineHash: initialized.baselineHash,
      indexedFiles: initialized.files,
      archiveMetadataCount: archives.metadata.length,
      archiveIssues: archives.issues.length,
      daemon: "authenticated DaemonServer + ProjectIndexHost via registerIndexHandlers",
      archiveRiskHooks,
    };
    createJson(join(tierOutput, "setup.json"), setup);

    for (const query of QUERY_CASES) {
      for (let index = 0; index < input.config.samplesPerQuery; index++) {
        if (input.interrupted()) {
          const sample = emptySample(input.archiveCount, query.id, index, Object.assign(new Error("benchmark_interrupted"), { code: "interrupted" }));
          samples.push(sample); appendSample(input.output, sample); continue;
        }
        const sample = emptySample(input.archiveCount, query.id, index, new Error("sample_not_completed"));
        const queryStarted = performance.now();
        try {
          const result = await peer.call("knowledge.query", { query: query.request });
          const queryFinished = performance.now();
          sample.queryMs = queryFinished - queryStarted;
          sample.responseBytes = byteLength(result);
          const page = result.page as {
            format?: string;
            workspace?: { repoId?: string; workspaceId?: string; branch?: string };
            generation?: number;
            baselineHash?: string;
            requirement?: unknown;
            limitations?: Record<string, unknown>;
            coverage?: Record<string, unknown>;
            facts?: Array<{ kind?: string; id?: string; source?: { path?: string } }>;
            nextCursor?: unknown;
          };
          sample.pageBytes = byteLength(page);
          sample.generation = typeof page.generation === "number" ? page.generation : null;
          sample.baselineHash = typeof page.baselineHash === "string" ? page.baselineHash : null;
          sample.requirement = page.requirement;
          assertQueryPageMetadata(page, Number(query.request.maxBytes));
          const hits = summarizeQueryHits(query.id, page.facts);
          sample.hitCount = hits.hitCount;
          sample.hitIdentifiers = hits.hitIdentifiers;
          sample.hitPaths = hits.hitPaths;
          sample.expectedHitObserved = hits.expectedHitObserved;
          const coverage = page.coverage;
          if (!coverage) throw new Error("query_coverage_missing");
          sample.coverage = {
            matched: Number(coverage.matched),
            returned: Number(coverage.returned),
            omitted: Number(coverage.omitted),
            remaining: Number(coverage.remaining),
            sourceExcerptsTruncated: Number(coverage.sourceExcerptsTruncated),
            complete: coverage.complete === true,
            nextCursor: page.nextCursor !== null,
          };
          sample.unknown = {
            performanceImprovement: page.limitations?.performanceImprovement,
            formalVerification: page.limitations?.formalVerification,
            unknownCodeRelations: page.limitations?.unknownCodeRelations,
            unindexedFiles: page.limitations?.unindexedFiles,
          };
          const serialized = JSON.stringify(page);
          if (page.format !== "knowledge-facts/v1" || page.requirement !== null
            || page.workspace?.repoId !== identity.repoId || page.workspace?.workspaceId !== service.workspace.workspaceId
            || page.workspace?.branch !== service.workspace.branch || page.baselineHash !== initialized.baselineHash
            || page.limitations?.performanceImprovement !== "unknown" || page.limitations?.formalVerification !== "not_available"
            || serialized.includes("M4_ARCHIVE_BODY_CANARY_")
            || page.facts?.some((fact) => fact.source?.path === "docs/prod" || fact.source?.path?.startsWith("docs/prod/"))) {
            throw new Error("query_result_contract_failed");
          }
          if (!sample.coverage.complete || sample.coverage.omitted !== 0 || sample.coverage.remaining !== 0
            || sample.coverage.sourceExcerptsTruncated !== 0 || sample.coverage.nextCursor) {
            throw new Error("finite_query_was_truncated");
          }
          sample.combinedMs = performance.now() - queryStarted;
          sample.ok = true;
          delete sample.error;
        } catch (error) {
          const finished = performance.now();
          if (sample.queryMs === null) sample.queryMs = finished - queryStarted;
          sample.combinedMs = finished - queryStarted;
          sample.error = errorRecord(error);
        }
        samples.push(sample);
        appendSample(input.output, sample);
      }
    }
    if (probeControl.probe.archiveBodyReadAttempts !== 0) throw new Error("archive_body_read_probe_nonzero");
  } catch (error) {
    preHandoffPeerCleanupFailed = (error as { resourceCleanupFailed?: unknown })?.resourceCleanupFailed === true;
    if (!manifest) createJson(join(tierOutput, "setup-error.json"), { error: errorRecord(error) });
    else if (!lstatExists(join(tierOutput, "setup.json"))) createJson(join(tierOutput, "setup-error.json"), { error: errorRecord(error), manifest });
    for (const query of QUERY_CASES) {
      const actual = samples.filter((sample) => sample.queryId === query.id).length;
      for (let index = actual; index < input.config.samplesPerQuery; index++) {
        const sample = emptySample(input.archiveCount, query.id, index, error);
        samples.push(sample); appendSample(input.output, sample);
      }
    }
    setup = { ok: false, error: errorRecord(error), elapsedMs: performance.now() - started };
  } finally {
    let peerClosed: boolean | null = peer || preHandoffPeerCleanupFailed ? false : null;
    let hostClosed: boolean | null = host ? false : null;
    let serverClosed: boolean | null = server ? false : null;
    let probeRestored: boolean | null = probeControl ? false : null;
    if (peer) {
      try { peer.close(); await settleWithin(peer.closed, 5_000, "peer_close_timeout"); peerClosed = true; }
      catch (error) { cleanupErrors.push(`peer:${String(error)}`); }
    }
    if (host) {
      try {
        await host.close();
        if (input.faultInjection === "host_close_after_success") throw new Error("injected_host_close_failure");
        hostClosed = true;
      } catch (error) { cleanupErrors.push(`host:${String(error)}`); }
    }
    if (server) {
      try { await server.close(); serverClosed = true; }
      catch (error) { cleanupErrors.push(`server:${String(error)}`); }
    }
    const probe = probeControl?.probe ?? { positiveControlReads: 0, archiveBodyReadAttempts: 0, attemptedArchivePaths: [] };
    if (probeControl) {
      try { probeControl.restore(); probeRestored = true; }
      catch (error) { cleanupErrors.push(`probe:${String(error)}`); }
    }
    let removed = false, socketRootRemoved = false;
    const resourcesClosed = peerClosed !== false && hostClosed !== false
      && serverClosed !== false && probeRestored !== false;
    const rootsSafeToRemove = resourcesClosed && input.git.active.size === 0;
    if (rootsSafeToRemove) {
      try { await rm(fixtureRoot, { recursive: true, force: true }); removed = !lstatExists(fixtureRoot); }
      catch (error) { cleanupErrors.push(`fixture:${String(error)}`); }
      try { await rm(socketRoot, { recursive: true, force: true }); socketRootRemoved = !lstatExists(socketRoot); }
      catch (error) { cleanupErrors.push(`socket-root:${String(error)}`); }
    } else if (input.git.active.size > 0) cleanupErrors.push(`git_children_active:${[...input.git.active].join(",")}`);
    const cleanup = {
      fixtureRoot,
      fixtureRemoved: removed,
      socketRoot,
      socketRootRemoved,
      rootsPreservedForDiagnostics: !rootsSafeToRemove,
      peerClosed,
      hostClosed,
      serverClosed,
      probeRestored,
      activeGitChildren: [...input.git.active],
      archiveReadProbe: probe,
      errors: cleanupErrors,
      ok: rootsSafeToRemove && removed && socketRootRemoved && probe.positiveControlReads > 0
        && probe.archiveBodyReadAttempts === 0 && cleanupErrors.length === 0,
    };
    createJson(join(tierOutput, "cleanup.json"), cleanup);
    return { samples, setup, cleanup };
  }
}

function lstatExists(path: string): boolean {
  try { lstatSync(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

function help(): string {
  return [
    "M4 knowledge_query真实RPC基准装置",
    "用法：node --experimental-strip-types tests/helpers/m4-query-benchmark.ts --output <全新绝对私有目录> --scenario smoke|formal",
    `formal固定参数：${JSON.stringify(FORMAL_QUERY_BENCHMARK)}`,
    `smoke固定参数：${JSON.stringify(SMOKE_QUERY_BENCHMARK)}`,
    `固定查询：${JSON.stringify(QUERY_CASES)}`,
    "smoke仅验证装置，formal=false，不构成性能过门槛证据。",
    "formal也只测认证daemon上knowledge.query RPC（含查询前对账），不是SDK、云模型或M4阶段正式验收。",
  ].join("\n");
}

export async function runQueryBenchmark(options: { output: string; scenario: "smoke" | "formal" }): Promise<Record<string, unknown>> {
  if (!options || !isAbsolute(options.output) || !["smoke", "formal"].includes(options.scenario)) throw new Error(help());
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (!major || major < 22 || major === 22 && (minor ?? 0) < 19) throw new Error(`unsupported_node:${process.version}`);
  process.umask(0o077);
  const output = resolve(options.output);
  const parent = await realpath(dirname(output));
  if (lstatExists(output)) throw new Error("output_must_not_exist");
  if (join(parent, relative(parent, output)) !== output) throw new Error("output_path_not_normalized");
  await mkdir(output, { mode: 0o700 });
  chmodSync(output, 0o700);
  const outputStat = await stat(output);
  if (!outputStat.isDirectory() || (outputStat.mode & 0o077) !== 0) throw new Error("output_directory_not_private");

  const scriptRoot = realpathSync(fileURLToPath(new URL("../../", import.meta.url)));
  const config = options.scenario === "formal" ? FORMAL_QUERY_BENCHMARK : SMOKE_QUERY_BENCHMARK;
  const formal = options.scenario === "formal";
  const requestedFault = process.env.M4_QUERY_BENCHMARK_FAULT ?? "";
  if (requestedFault && (formal || requestedFault !== "host_close_after_success")) throw new Error("invalid_fault_injection");
  const faultInjection = requestedFault === "host_close_after_success" ? requestedFault : null;
  const beforeInputs = await codeInputs(scriptRoot);
  const git = new GitRunner(output);
  const beforeHead = await git.run(scriptRoot, ["rev-parse", "HEAD"]);
  const disk = await statfs(output);
  const resourcesBefore = resourceSnapshot();
  const startedAt = new Date().toISOString();
  const started = performance.now();
  createJson(join(output, "run.json"), {
    format: "m4-query-benchmark/v1",
    formal,
    scenario: options.scenario,
    evidenceClass: formal ? "measurement-not-stage-acceptance" : "development-smoke-not-performance-evidence",
    performanceClaimAllowed: false,
    timingLayer: "authenticated DaemonServer knowledge.query RPC including pre-query fingerprint reconciliation, plus client page validation",
    timingSegments: {
      queryMs: "knowledge.query RPC request/response decoding, including daemon-side fingerprint reconciliation; not pure SQL or RPC time",
      combinedMs: "knowledge.query RPC plus client page checks; excludes one post-init warm-up query, sample log writes and cleanup",
    },
    excludedTimingLayers: ["pi SDK tool lifecycle", "host/UI approval", "cloud/model request", "network service", "M4 formal check-round freeze"],
    config,
    queries: QUERY_CASES,
    p95Method: "all preregistered samples remain in denominator; rank=ceil(0.95*N); failed samples sort as infinity",
    faultInjection,
    expectedHits: {
      exactPath: { path: "src/file0000.ts" },
      chineseSearchAndFiniteFacts: { kind: "source", path: "docs/spec/rule0000.rules.json" },
      codeStringHitRequired: false,
    },
    cwd: process.cwd(),
    argv: process.argv,
    node: {
      execPath: await realpath(process.execPath),
      version: process.version,
      arch: process.arch,
      versions: process.versions,
      execArgv: process.execArgv,
      typescriptLoading: "Node --experimental-strip-types from caller; no Bun or runtime download",
    },
    host: {
      platform: process.platform,
      release: release(),
      version: version(),
      cpuModel: cpus()[0]?.model ?? null,
      cpuCount: cpus().length,
      memoryBytes: totalmem(),
      disk: { blockSize: disk.bsize, blocks: disk.blocks, availableBlocks: disk.bavail },
    },
    inputs: beforeInputs,
    head: beforeHead,
    startedAt,
  });

  let interrupted = false;
  const onSignal = () => { interrupted = true; };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  const allSamples: QuerySample[] = [];
  const tiers: Array<Record<string, unknown>> = [];
  try {
    for (const archiveCount of config.archiveCounts) {
      const result = await runTier({ output, scriptRoot, config, archiveCount, git, interrupted: () => interrupted, faultInjection });
      allSamples.push(...result.samples);
      tiers.push({ archiveCount, setup: result.setup, cleanup: result.cleanup });
      if (interrupted) break;
    }
    if (interrupted) {
      for (const archiveCount of config.archiveCounts.filter((count) => !tiers.some((tier) => tier.archiveCount === count))) {
        for (const query of QUERY_CASES) for (let index = 0; index < config.samplesPerQuery; index++) {
          const sample = emptySample(archiveCount, query.id, index, Object.assign(new Error("benchmark_interrupted"), { code: "interrupted" }));
          allSamples.push(sample); appendSample(output, sample);
        }
      }
    }
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
  }
  const afterInputs = await codeInputs(scriptRoot);
  const afterHead = await git.run(scriptRoot, ["rev-parse", "HEAD"]);
  const inputsStable = JSON.stringify(beforeInputs) === JSON.stringify(afterInputs);
  const headStable = beforeHead === afterHead;
  const summaries = summarizeQuerySamples(allSamples);
  const expectedSamples = config.archiveCounts.length * QUERY_CASES.length * config.samplesPerQuery;
  const sampleCountComplete = allSamples.length === expectedSamples
    && config.archiveCounts.every((archiveCount) => QUERY_CASES.every((query) => allSamples.filter((sample) => sample.archiveCount === archiveCount && sample.queryId === query.id).length === config.samplesPerQuery));
  const cleanupComplete = tiers.length === config.archiveCounts.length && tiers.every((tier) => (tier.cleanup as { ok?: boolean }).ok === true) && git.active.size === 0;
  const samplesPassed = allSamples.every((sample) => sample.ok);
  const referenceTargetsObserved = formal && summaries.length === config.archiveCounts.length * QUERY_CASES.length
    && summaries.every((summary) => summary.thresholdResult === "within_reference");
  const ok = !interrupted && inputsStable && headStable && sampleCountComplete && cleanupComplete && samplesPassed
    && (!formal || referenceTargetsObserved);
  const summary = {
    format: "m4-query-benchmark/v1",
    formal,
    scenario: options.scenario,
    ok,
    startedAt,
    finishedAt: new Date().toISOString(),
    totalMs: performance.now() - started,
    sampleCount: allSamples.length,
    expectedSamples,
    sampleCountComplete,
    failures: allSamples.filter((sample) => !sample.ok).length,
    interrupted,
    inputsStable,
    headStable,
    headBefore: beforeHead,
    headAfter: afterHead,
    inputHashBefore: sha256(JSON.stringify(beforeInputs)),
    inputHashAfter: sha256(JSON.stringify(afterInputs)),
    summaries,
    tiers,
    gitSubprocesses: { records: git.records, activeAtEnd: [...git.active], allExited: git.active.size === 0 },
    resources: { before: resourcesBefore, after: resourceSnapshot(), cleanupComplete },
    referenceTargetsObserved: formal ? referenceTargetsObserved : null,
    smokeMustNotClaimThreshold: !formal,
    stageAcceptance: "not_issued",
    resultScope: formal
      ? "formal fixture shape measured at authenticated daemon knowledge.query RPC layer; SDK/cloud end-to-end remains required before acceptance"
      : "smoke harness self-check only; fixture and sample counts are intentionally reduced",
    unmeasured: ["pi SDK end-to-end", "host/UI", "cloud/model", "formal frozen check round", "concurrent production workload"],
    inputsAfter: afterInputs,
  };
  createJson(join(output, "summary.json"), summary);
  return summary;
}

async function cli(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help")) { console.log(help()); return; }
  let output = "";
  let scenario = "";
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (seen.has(arg)) throw new Error(`duplicate_argument:${arg}`);
    seen.add(arg);
    if (arg !== "--output" && arg !== "--scenario") throw new Error(`unknown_argument:${arg}\n${help()}`);
    const value = args[++index];
    if (!value || value.startsWith("--")) throw new Error(`missing_argument_value:${arg}\n${help()}`);
    if (arg === "--output") output = value;
    else scenario = value;
  }
  if (!output || (scenario !== "smoke" && scenario !== "formal")) throw new Error(help());
  const summary = await runQueryBenchmark({ output, scenario });
  console.log(JSON.stringify({ output: resolve(output), scenario, formal: scenario === "formal", ok: summary.ok }));
  if (summary.ok !== true) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  cli().catch((error) => { console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error)); process.exitCode = 1; });
}
