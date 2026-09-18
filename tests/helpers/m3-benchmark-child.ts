import assert from "node:assert/strict";
import fs from "node:fs";
import { appendFileSync } from "node:fs";
import { readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { getHeapStatistics } from "node:v8";
import { setTimeout as delay } from "node:timers/promises";
import { appendSample, gitRun, jsonFile, sha, specText, summarize } from "./m3-benchmark.ts";
import type { ChildJob, Sample } from "./m3-benchmark.ts";
import type { ProjectIndexSyncManager, ProjectIndexSyncStatus, ProjectIndexWatchFactory } from "../../runtime/project-index-sync.ts";
import type { ProjectIndexService, ProjectIndexBuildResult } from "../../runtime/project-index-service.ts";
import type { LocalDatabase } from "../../runtime/database.ts";


const job = JSON.parse(await readFile(process.argv[2], "utf8")) as ChildJob;
process.umask(0o077);
const jobCategory = job.mode === "cold" && job.index < 0 ? "restart-warmup" : job.mode;
const samples: Sample[] = [];
const failures: string[] = [];
let aborted = false;
let manager: ProjectIndexSyncManager | undefined;
let service: ProjectIndexService | undefined;
let disposeEvents: (() => void) | undefined;
const onSignal = () => { aborted = true; service?.cancel(); };
process.on("SIGINT", onSignal); process.on("SIGTERM", onSignal);
const record = (sample: Sample) => { samples.push(sample); appendSample(job.output, sample); };
const guard = () => { if (aborted) throw new Error("benchmark_interrupted"); };

/** 只观察真实调用；包装函数始终转发原函数，不替换DB/解析结果。 */
function wrap(target: object, key: string, observer: (args: unknown[], invoke: () => unknown, receiver: unknown) => unknown): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  if (!descriptor || typeof descriptor.value !== "function") throw new Error(`无法安装观察器：${key}`);
  const original = descriptor.value as (...args: unknown[]) => unknown;
  Object.defineProperty(target, key, { ...descriptor, value: function(this: unknown, ...args: unknown[]) {
    return observer(args, () => Reflect.apply(original, this, args), this);
  } });
  return () => { Object.defineProperty(target, key, descriptor); };
}
const restores: Array<() => void> = [];
const probe = { positiveControlReads: 0, archiveReadAttempts: 0, archivePaths: [] as string[] };
const positivePath = join(job.fixtureRoot, "probe-positive.txt");
const archivePrefix = `${join(job.repo, "docs/prod")}${sep}`;
function observeRead(args: unknown[]): void {
  const value = args[0];
  let path: string | null = null;
  if (typeof value === "string") path = resolve(value);
  else if (value instanceof URL) path = fileURLToPath(value);
  else if (Buffer.isBuffer(value)) path = resolve(value.toString());
  if (path === positivePath) probe.positiveControlReads++;
  if (path?.startsWith(archivePrefix)) {
    probe.archiveReadAttempts++;
    probe.archivePaths.push(path.slice(job.repo.length + 1));
    throw new Error("archive_body_read_attempt");
  }
}
for (const key of ["open", "readFile"]) restores.push(wrap(fs.promises, key, (args, invoke) => { observeRead(args); return invoke(); }));
for (const key of ["open", "openSync", "readFile", "readFileSync", "createReadStream"]) {
  restores.push(wrap(fs, key, (args, invoke) => { observeRead(args); return invoke(); }));
}
syncBuiltinESMExports();
await writeFile(positivePath, "probe control\n", { mode: 0o600 });
await fs.promises.readFile(positivePath);
assert.ok(probe.positiveControlReads > 0);

const counters = { watchersCreated: 0, watcherCloseCalls: 0, watchersClosed: 0, watchersActive: 0,
  watcherPeak: 0, watcherErrors: 0, parseCalls: 0, parsersObserved: 0, parserDeleteCalls: 0,
  treesCreated: 0, treeDeleteCalls: 0, grammarLoads: 0 };
const watchFactory: ProjectIndexWatchFactory = (path, listener) => {
  const watcher = fs.watch(path, { persistent: false, encoding: "utf8" }, listener);
  counters.watchersCreated++; counters.watchersActive++;
  counters.watcherPeak = Math.max(counters.watcherPeak, counters.watchersActive);
  watcher.once("close", () => { counters.watchersClosed++; counters.watchersActive--; });
  watcher.on("error", () => { counters.watcherErrors++; });
  const close = watcher.close.bind(watcher);
  watcher.close = () => { counters.watcherCloseCalls++; return close(); };
  return watcher;
};
function resourceSnapshot(phase: string) {
  const handles = (process as unknown as { _getActiveHandles?: () => object[] })._getActiveHandles?.() ?? [];
  const activeHandles: Record<string, number> = {};
  for (const handle of handles) {
    const name = handle.constructor?.name ?? "unknown";
    activeHandles[name] = (activeHandles[name] ?? 0) + 1;
  }
  const heap = getHeapStatistics();
  return { phase, atMs: performance.now(), memory: process.memoryUsage(), activeHandles,
    activeResourceTypes: process.getActiveResourcesInfo(), counters: { ...counters },
    v8: { mallocedMemory: heap.malloced_memory, peakMallocedMemory: heap.peak_malloced_memory,
      externalMemory: heap.external_memory, usedHeapSize: heap.used_heap_size } };
}
type Resources = ReturnType<typeof resourceSnapshot>;
const resources: Resources[] = [];
const emptyPeak = () => ({ rss: 0, heapUsed: 0, external: 0, arrayBuffers: 0, activeHandleCount: 0, watchers: 0 });
const peak = emptyPeak();
let roundPeak: ReturnType<typeof emptyPeak> | undefined;
function capture(phase: string, save = true) {
  const value = resourceSnapshot(phase);
  for (const target of roundPeak ? [peak, roundPeak] : [peak]) {
    for (const key of ["rss", "heapUsed", "external", "arrayBuffers"] as const) target[key] = Math.max(target[key], value.memory[key]);
    target.activeHandleCount = Math.max(target.activeHandleCount, Object.values(value.activeHandles).reduce((a, b) => a + b, 0));
    target.watchers = Math.max(target.watchers, counters.watchersActive);
  }
  if (save) {
    resources.push(value);
    appendFileSync(join(job.output, "resources.jsonl"), `${JSON.stringify(value)}\n`, { mode: 0o600 });
  }
  return value;
}
capture("before-imports");
const interval = setInterval(() => capture("sampled", false), job.config.resourceIntervalMs);

async function parserInstrumentation(): Promise<void> {
  const binding = await import("web-tree-sitter");
  const parsers = new WeakSet<object>();
  restores.push(wrap(binding.Parser.prototype, "setLanguage", (_args, invoke, receiver) => {
    const result = invoke();
    if (!parsers.has(receiver as object)) { parsers.add(receiver as object); counters.parsersObserved++; }
    return result;
  }));
  restores.push(wrap(binding.Parser.prototype, "parse", (_args, invoke) => {
    counters.parseCalls++;
    const tree = invoke(); if (tree !== null) counters.treesCreated++;
    return tree;
  }));
  restores.push(wrap(binding.Parser.prototype, "delete", (_args, invoke) => {
    const result = invoke(); counters.parserDeleteCalls++; return result;
  }));
  restores.push(wrap(binding.Tree.prototype, "delete", (_args, invoke) => {
    const result = invoke(); counters.treeDeleteCalls++; return result;
  }));
  restores.push(wrap(binding.Language, "load", (_args, invoke) => { counters.grammarLoads++; return invoke(); }));
}
function buildMetadata(built: ProjectIndexBuildResult) {
  return { status: built.status, generation: built.generation, parsedFiles: built.parsedFiles, reusedFiles: built.reusedFiles,
    readBytes: built.readBytes, sourceCodepoints: built.sourceCodepoints, files: built.files, symbols: built.symbols,
    codeEdges: built.codeEdges, diagnostics: built.diagnostics, spec: built.spec, budget: built.budget,
    archiveMetadataCount: built.archives.metadata.length, baselineHash: built.baselineHash };
}
async function openIndex() {
  const { repositoryIdentity } = await import("../../runtime/identity.ts");
  const { ProjectIndexService: Service } = await import("../../runtime/project-index-service.ts");
  const identity = await repositoryIdentity(job.repo);
  service = await Service.open({ repositoryRoot: job.repo, dataRoot: job.dataRoot, repoId: identity.repoId, authorize: () => true });
  return service;
}
async function indexBoot() {
  const start = performance.now();
  const instance = await openIndex();
  const openedAt = performance.now();
  const cached = await instance.status();
  const cacheReadAt = performance.now();
  if (job.mode === "restart") assert.equal(cached.initialized, true, "重启样本必须有真实已发布索引");
  else assert.equal(cached.initialized, false, "冷样本必须是新库");
  const progresses: unknown[] = [];
  const beforeBuild = performance.now();
  const built = await instance[job.mode === "cold" ? "init" : "refresh"]({ onProgress: (progress) => {
    progresses.push({ ...progress, elapsedMs: performance.now() - beforeBuild });
  } });
  const end = performance.now();
  jsonFile(join(job.output, "progress.json"), progresses);
  assert.equal(built.status, "ready");
  assert.equal(built.files, job.config.files);
  assert.equal(built.archives.metadata.length, job.archives);
  if (job.mode === "restart") assert.equal(built.parsedFiles, 0, "未变文件不能重新解析");
  record({ category: jobCategory, index: job.index, ok: true, durationMs: job.mode === "cold" ? end : end - start,
    processStartToPublicationMs: end,
    serviceOpenMs: openedAt - start, cacheStatusReadMs: cacheReadAt - openedAt, reconciliationMs: end - beforeBuild,
    parsedCallsObserved: counters.parseCalls, build: buildMetadata(built),
    timingScope: job.mode === "cold" ? "Node process start through complete publication, includes observer setup; parent spawn-to-exit wall time separate"
      : "service import/open + persisted status + complete reconciliation; parser observer import and process start separate" });
}
async function waitPublished(previous: ProjectIndexSyncStatus, requireWatch: boolean): Promise<{ status: ProjectIndexSyncStatus; dirtyObserved: boolean }> {
  const start = performance.now();
  let dirtyObserved = false;
  while (performance.now() - start <= job.config.updateTimeoutMs) {
    guard();
    const status = manager!.status(); // 只读观察，不调用ensureFresh/reconcile促发更新。
    dirtyObserved ||= status.dirty;
    if (status.state === "error") throw new Error(`index_sync_error:${JSON.stringify(status.lastError)}`);
    if (status.state === "fresh" && !status.dirty && status.generation > previous.generation && status.baselineHash !== previous.baselineHash) {
      if (requireWatch) assert.equal(status.lastReason, "watch", "非watch发布不能算监听延迟");
      return { status, dirtyObserved };
    }
    await delay(job.config.pollIntervalMs);
  }
  throw new Error(`publication_timeout:${JSON.stringify(manager!.status())}`);
}
async function assertFiles(expectations: Map<string, string | null>) {
  const { IndexStore } = await import("../../runtime/index-store.ts");
  const { indexDatabase } = await import("../../runtime/database-paths.ts");
  const store = new IndexStore(indexDatabase(job.dataRoot, service!.workspace.repoId), service!.workspace);
  try {
    const snapshot = store.getSnapshot();
    for (const [path, hash] of expectations) {
      const file = snapshot.files.find((item) => item.path === path);
      if (hash === null) assert.equal(file, undefined, `删除文件仍被发布：${path}`);
      else assert.equal(file?.hash, hash, `发布内容不匹配：${path}`);
    }
    assert.equal(snapshot.files.some((item) => item.path.startsWith("docs/prod/")), false);
    assert.equal(JSON.stringify(snapshot).includes("M3_ARCHIVE_BODY_CANARY_"), false);
  } finally { store.close(); }
}
async function live() {
  const instance = await openIndex();
  const { ProjectIndexSyncManager: Manager } = await import("../../runtime/project-index-sync.ts");
  manager = new Manager({ service: instance, authorize: () => true, watchFactory });
  const warmupStart = performance.now();
  assert.equal((await manager.start()).state, "fresh");
  record({ category: "live-warmup", index: 0, ok: true, durationMs: performance.now() - warmupStart,
    parseCalls: counters.parseCalls, build: buildMetadata(manager.latestBuildResult()!) });
  capture("after-warmup");
  const subscribers: Array<() => void> = [];
  for (let i = 0; i < 3; i++) subscribers.push(manager.subscribe({ id: `benchmark-consumer-${i}`, authorize: () => true,
    onBaselineChange: () => {} }));
  capture("three-kernel-subscribers-not-host-windows");
  const expectations = new Map<string, string | null>();
  for (let i = 0; i < job.config.updateSamples; i++) {
    const slot = i % 10, round = Math.floor(i / 10), isSpec = slot >= 5, action = slot % 5;
    const base = isSpec ? "docs/spec/rule0000.rules.json" : "src/file0000.ts";
    const temporary = isSpec ? "docs/spec/added.rules.json" : "src/added.ts";
    const renamed = isSpec ? "docs/spec/renamed.rules.json" : "src/renamed.ts";
    const path = action === 0 || action === 4 ? base : action === 3 ? renamed : temporary;
    let writeFinishedAt: number | undefined;
    const beganAt = performance.now();
    try {
      guard();
      const previous = manager.status();
      const parseBefore = counters.parseCalls;
      if (action === 2) {
        await rename(join(job.repo, temporary), join(job.repo, renamed));
        expectations.set(renamed, expectations.get(temporary)!); expectations.set(temporary, null);
      } else if (action === 3) {
        await rm(join(job.repo, renamed)); expectations.set(renamed, null);
      } else {
        const text = isSpec ? specText(action === 1 ? 9999 : 0, round * 2 + (action === 4 ? 2 : 1))
          : `export function ${action === 1 ? "added" : "value0"}() { return ${String(round * 2 + (action === 4 ? 2 : 1)).padStart(4, "0")}; }\n`;
        // 十进制字符串避免带前导零的数字触发语言语法降级。
        const content = isSpec ? text : text.replace(/return (\d+);/, "return '$1';");
        const before = action === 4 ? await stat(join(job.repo, path)) : null;
        await writeFile(join(job.repo, path), content, { mode: 0o600 });
        if (before) { assert.equal(Buffer.byteLength(content), before.size); await utimes(join(job.repo, path), before.atime, before.mtime); }
        expectations.set(path, sha(content));
      }
      writeFinishedAt = performance.now();
      const observed = await waitPublished(previous, true);
      const publishedAt = performance.now();
      await assertFiles(expectations);
      const built: ProjectIndexBuildResult | null = manager.latestBuildResult(); assert.ok(built); assert.equal(built.status, "ready");
      record({ category: "watch-update", index: i, ok: true, durationMs: publishedAt - writeFinishedAt,
        operation: ["modify", "add", "rename", "delete", "same-size-mtime"][action], language: isSpec ? "spec" : "ts",
        path, writeOperationMs: writeFinishedAt - beganAt, parseCalls: counters.parseCalls - parseBefore,
        dirtyObserved: observed.dirtyObserved, reason: observed.status.lastReason,
        generation: observed.status.generation, build: buildMetadata(built), contentVerified: true,
        expectedFileHashes: [...expectations].map(([filePath, hash]) => ({ path: filePath, hash })) });
    } catch (error) {
      record({ category: "watch-update", index: i, ok: false, durationMs: writeFinishedAt === undefined ? null : performance.now() - writeFinishedAt,
        operation: ["modify", "add", "rename", "delete", "same-size-mtime"][action], path, error: String(error) });
    }
  }
  for (const unsubscribe of subscribers) unsubscribe();
  for (let round = 0; round < job.config.resourceRounds; round++) {
    const start = performance.now();
    const parseBefore = counters.parseCalls;
    roundPeak = emptyPeak();
    try {
      guard();
      capture(`round-${round}-before-stop`);
      const stopStart = performance.now();
      const stopped: ProjectIndexSyncStatus = await manager.stop();
      const stopMs = performance.now() - stopStart;
      assert.equal(stopped.watchers, 0); assert.equal(stopped.activeCallbacks, 0);
      await delay(job.config.settleMs);
      const settled = capture(`round-${round}-stopped-settled`);
      assert.equal(counters.watchersActive, 0, "真实watcher close事件未收敛");
      assert.equal(counters.watchersCreated, counters.watchersClosed);
      assert.equal(counters.parsersObserved, counters.parserDeleteCalls);
      assert.equal(counters.treesCreated, counters.treeDeleteCalls);
      const offlinePath = join(job.repo, "src/file0000.ts");
      const beforeOffline = await stat(offlinePath);
      const priorText = await readFile(offlinePath, "utf8");
      const offlineText = priorText.replace(/'([^']*)'/, (_match, value: string) => `'${value.slice(0, -1)}${value.endsWith("0") ? "1" : "0"}'`);
      assert.notEqual(offlineText, priorText);
      assert.equal(Buffer.byteLength(offlineText), beforeOffline.size);
      await writeFile(offlinePath, offlineText, { mode: 0o600 });
      await utimes(offlinePath, beforeOffline.atime, beforeOffline.mtime);
      const startAt = performance.now();
      assert.equal((await manager.start()).state, "fresh");
      const startMs = performance.now() - startAt;
      await assertFiles(new Map([["src/file0000.ts", sha(offlineText)]]));
      capture(`round-${round}-restarted`);
      record({ category: "resource-round", index: round, ok: true, durationMs: performance.now() - start,
        stopMs, startAndOfflineReconcileMs: startMs, settled, peak: { ...roundPeak }, parseCalls: counters.parseCalls - parseBefore,
        parsedFiles: manager.latestBuildResult()?.parsedFiles, offlineChangeVerified: true,
        sameSizeMtimeOfflineReconcile: true, fileHash: sha(offlineText) });
    } catch (error) { record({ category: "resource-round", index: round, ok: false, durationMs: performance.now() - start, peak: { ...roundPeak }, error: String(error) }); }
    finally { roundPeak = undefined; }
  }
}

async function events() {
  const { RequirementService } = await import("../../runtime/requirement-service.ts");
  const { RequirementStateStore } = await import("../../runtime/requirement-state.ts");
  const { RequirementEventService } = await import("../../runtime/requirement-events.ts");
  const { LocalDatabase: DB, repositoryDatabase, uuidv7, withDatabase } = await import("../../runtime/database.ts");
  const { repositoryIdentity } = await import("../../runtime/identity.ts");
  const identity = await repositoryIdentity(job.repo);
  const options = { repositoryRoot: job.repo, dataRoot: job.dataRoot, repoId: identity.repoId, authorize: () => true };
  const requirements = await RequirementService.open(options);
  const state = await RequirementStateStore.open(options);
  const eventService = await RequirementEventService.open(options);
  disposeEvents = () => eventService.dispose();
  const created = await requirements.create({ requestId: uuidv7(), operationId: uuidv7(), title: "测量夹具", body: "BASELINE_0" });
  const worktree = join(job.fixtureRoot, "event-worktree");
  gitRun(job.git, job.repo, ["worktree", "add", "-b", "benchmark-events", worktree], job.fixtureRoot);
  const baseCommit = gitRun(job.git, worktree, ["rev-parse", "HEAD"], job.fixtureRoot);
  const bound = await state.bindWorkspace({ requirementId: created.requirementId, version: created.version,
    path: worktree, prepareOperationId: uuidv7(), baseCommit });
  let previous = await requirements.confirmUpdate({ requirementId: created.requirementId, operationId: uuidv7(), version: bound.version,
    title: "测量夹具", body: "BASELINE_0", receiptId: uuidv7() });
  let lease = await state.acquirePm({ requirementId: created.requirementId, version: previous.version, runId: uuidv7(), expectedFence: 0 });
  const baseline = await eventService.prepareCurrentBaseline({ lease });
  eventService.consumePreparedDelivery({ lease, handle: baseline.handle, contextGeneration: lease.contextGeneration, version: baseline.version },
    (content) => { assert.equal(content.kind, "baseline"); });
  await eventService.acknowledgeBaseline({ lease, deliveryId: baseline.deliveryId });
  capture("events-after-baseline");
  // 同步原事务返回说明真实COMMIT已结束。只观察目标prod.approved，不用confirmUpdate返回时间替代落库边界。
  const pending = new WeakMap<LocalDatabase, { revision: number; eventId: string }[]>();
  const committed = new Map<number, { at: number; eventId: string }>();
  const restoreTransaction = wrap(DB.prototype, "transaction", (_args, invoke, receiver) => {
    const db = receiver as LocalDatabase;
    pending.set(db, []);
    try {
      const result = invoke();
      const at = performance.now();
      for (const event of pending.get(db) ?? []) committed.set(event.revision, { at, eventId: event.eventId });
      return result;
    } finally { pending.delete(db); }
  });
  const restoreAppend = wrap(DB.prototype, "append", (args, invoke, receiver) => {
    const result = invoke() as { id: string };
    const data = args[1] as { kind?: string; revision?: number };
    if (args[0] === `requirement_events:${created.requirementId}` && data.kind === "prod.approved") {
      const transaction = pending.get(receiver as LocalDatabase);
      assert.ok(transaction, "批准事件必须位于实际同步事务中");
      transaction.push({ revision: data.revision!, eventId: result.id });
    }
    return result;
  });
  try {
    for (let i = 0; i < job.config.eventSamples; i++) {
      let persisted: { at: number; eventId: string } | undefined;
      const started = performance.now();
      try {
        guard();
        lease = await state.renewPm(lease);
        assert.equal((await eventService.poll({ lease })).status, "caught_up", "样本开始不得已有积压");
        const draft = await requirements.updateDraft({ requirementId: created.requirementId, operationId: uuidv7(),
          version: state.read(created.requirementId).version, title: "测量夹具", body: `DRAFT_NOT_APPROVED_${i}` });
        const saveStarted = performance.now();
        const approved = await requirements.confirmUpdate({ requirementId: created.requirementId, operationId: uuidv7(),
          version: draft.version, title: "测量夹具", body: `APPROVED_${i + 1}`, receiptId: uuidv7() });
        const saveReturnedAt = performance.now();
        persisted = committed.get(approved.revision); assert.ok(persisted, "没有观察到真实提交边界");
        const delivery = await eventService.poll({ lease });
        const deliverableAt = performance.now();
        assert.equal(delivery.status, "event");
        if (delivery.status !== "event") throw new Error("event_not_deliverable");
        assert.equal(delivery.eventId, persisted.eventId);
        assert.equal(delivery.fromCommit, previous.commit); assert.equal(delivery.toCommit, approved.commit);
        assert.equal(delivery.fromHash, previous.prodHash); assert.equal(delivery.toHash, approved.prodHash);
        const prepared = await eventService.prepareDiff({ lease, eventId: delivery.eventId, sequence: delivery.sequence });
        let diffHash: string | undefined;
        eventService.consumePreparedDelivery({ lease, handle: prepared.handle, contextGeneration: lease.contextGeneration, version: prepared.version },
          (content) => {
            assert.equal(content.kind, "diff");
            if (content.kind !== "diff") throw new Error("diff_required");
            assert.equal(content.fromCommit, previous.commit); assert.equal(content.toCommit, approved.commit);
            assert.equal(content.diff.includes("DRAFT_NOT_APPROVED_"), false);
            diffHash = sha(content.diff);
          });
        await eventService.acknowledgeEvent({ lease, eventId: delivery.eventId, sequence: delivery.sequence,
          toRevision: delivery.toRevision, toCommit: delivery.toCommit, toHash: delivery.toHash });
        const metadata = withDatabase(repositoryDatabase(job.dataRoot, identity.repoId), (db) => JSON.stringify(db.events(`requirement_events:${created.requirementId}`)));
        assert.equal(/DRAFT_NOT_APPROVED_|APPROVED_|BASELINE_0|"(?:body|patch|diff|prodBody)"/.test(metadata), false);
        record({ category: "approved-event", index: i, ok: true, durationMs: deliverableAt - persisted.at,
          commitToServiceReturnMs: saveReturnedAt - persisted.at, saveWithGitMs: saveReturnedAt - saveStarted,
          preparationAndAckMs: performance.now() - deliverableAt, noBacklog: true, modelMs: null,
          fromCommit: delivery.fromCommit, toCommit: delivery.toCommit, fromHash: delivery.fromHash, toHash: delivery.toHash,
          draftCommit: draft.commit, eventId: delivery.eventId, sequence: delivery.sequence, diffHash,
          timingScope: "real SQLite COMMIT return to RequirementEventService.poll event return; not host/PM model delivery" });
        previous = approved;
      } catch (error) {
        record({ category: "approved-event", index: i, ok: false, durationMs: persisted ? performance.now() - persisted.at : null,
          attemptMs: performance.now() - started, error: String(error) });
      }
      if (i % 10 === 0) capture(`events-${i}-consumed`);
    }
  } finally {
    restoreAppend(); restoreTransaction();
    eventService.dispose(); disposeEvents = undefined;
    state.releasePm(lease);
    capture("events-disposed-lease-released");
  }
}

try {
  const importStart = performance.now();
  await parserInstrumentation();
  capture("parser-observers-installed");
  jsonFile(join(job.output, "instrumentation.json"), { parserObserverImportMs: performance.now() - importStart,
    node: { version: process.version, executable: process.execPath, arch: process.arch, execArgv: process.execArgv, pid: process.pid },
    sqlite: "real node:sqlite, pass-through commit observation only", filesystem: "real fs.watch, read/open observation",
    authorization: "kernel fixture trusted adapter; no user approval/host authorization end-to-end claim",
    archiveProbe: "Node fs/promises open/readFile and fs open/readFile/readFileSync/openSync/createReadStream; no arbitrary external-tool coverage",
    wasmMetrics: "actual Parser setLanguage/parse/delete, Tree delete, Language.load counts; process external/arrayBuffers not WASM-only bytes",
    unavailable: ["binding internal WASM heap capacity", "complete language object unload", "OS-wide handles"] });
  if (job.mode === "cold" || job.mode === "restart") await indexBoot();
  else if (job.mode === "live") await live();
  else if (job.mode === "events") await events();
  else throw new Error("未知场景");
} catch (error) {
  failures.push(String(error));
  record({ category: jobCategory, index: job.index, ok: false, durationMs: null, error: String(error) });
} finally {
  try { if (manager) await manager.stop(); } catch (error) { failures.push(`stop:${String(error)}`); }
  try { disposeEvents?.(); } catch (error) { failures.push(`dispose:${String(error)}`); }
  clearInterval(interval);
  await delay(job.config.settleMs);
  const final = capture("final-same-process-settled");
  if (probe.archiveReadAttempts !== 0) failures.push("archive_read_probe_nonzero");
  if (counters.watchersActive !== 0 || counters.watchersCreated !== counters.watchersClosed) failures.push("watcher_not_closed");
  if (counters.parsersObserved !== counters.parserDeleteCalls || counters.treesCreated !== counters.treeDeleteCalls) failures.push("parser_tree_count_not_converged");
  const expected = job.mode === "live" ? [["watch-update", job.config.updateSamples], ["resource-round", job.config.resourceRounds]]
    : job.mode === "events" ? [["approved-event", job.config.eventSamples]] : [[jobCategory, 1]];
  for (const [category, count] of expected) {
    const actual = samples.filter((sample) => sample.category === category).length;
    if (actual !== count) {
      failures.push(`sample_count:${category}:${actual}/${count}`);
      for (let i = actual; i < Number(count); i++) record({ category: String(category), index: i, ok: false, durationMs: null, error: "blocked_by_incomplete_setup_or_interruption" });
    }
  }
  jsonFile(join(job.output, "result.json"), { level: "kernel", smoke: job.smoke, mode: job.mode,
    failures, aborted, probe, counters, peak, final, resourcePoints: resources.length,
    samples: samples.length, summaries: summarize(samples),
    resourceConclusion: "counts_checked; inspect same-process memory trend; no threshold invented; exit is not leak-freedom proof",
    settledMemoryTrend: resources.filter((point) => point.phase.endsWith("stopped-settled")).map((point) => ({ phase: point.phase, memory: point.memory,
      activeHandles: point.activeHandles, watchers: point.counters.watchersActive })),
    smokeReferenceComparisonsNotEvidence: job.smoke,
    unmeasured: ["real daemon multi-window", "physical sleep", "native watcher failure/overflow", "directory deletion resource stress",
      "repeated requirement close cycles", "cancellation latency", "PM backlog performance", "model time", "knowledge_query"],
    ok: !aborted && failures.length === 0 && samples.every((sample) => sample.ok) });
  for (const restore of restores.reverse()) restore();
  syncBuiltinESMExports();
  process.removeListener("SIGINT", onSignal); process.removeListener("SIGTERM", onSignal);
  if (aborted || failures.length || samples.some((sample) => !sample.ok)) process.exitCode = 1;
}
