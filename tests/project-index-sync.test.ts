import { afterEach, expect, test } from "vitest";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, copyFile, mkdir, mkdtemp, rename, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { extractCode, getCodeExtractorVersion } from "../runtime/code-extractor.ts";
import { indexDatabase } from "../runtime/database-paths.ts";
import { repositoryIdentity } from "../runtime/identity.ts";
import { IndexStore } from "../runtime/index-store.ts";
import { ProjectIndexService } from "../runtime/project-index-service.ts";
import type { ProjectIndexExtractor } from "../runtime/project-index-service.ts";
import {
  ProjectIndexSyncManager,
} from "../runtime/project-index-sync.ts";
import type {
  ProjectIndexBaselineChange,
  ProjectIndexWatcher,
  ProjectIndexWatchFactory,
} from "../runtime/project-index-sync.ts";
import { createRepoFixture, GIT_ENV, removeRepoFixture } from "./helpers/repo-fixture.ts";
import type { RepoFixture } from "./helpers/repo-fixture.ts";
import { temporaryRoot } from "./helpers/temporary-root.ts";

const exec = promisify(execFile);
const roots: string[] = [];
const repositories: RepoFixture[] = [];

async function world(extractor?: ProjectIndexExtractor) {
  const repo = await createRepoFixture();
  repositories.push(repo);
  const dataRoot = await mkdtemp(join(temporaryRoot(), "project-index-sync-data-"));
  roots.push(dataRoot);
  const { repoId } = await repositoryIdentity(repo.root);
  const service = await ProjectIndexService.open({
    repositoryRoot: repo.root,
    dataRoot,
    repoId,
    authorize: () => true,
    extractor,
  });
  return { repo, dataRoot, repoId, service };
}

async function put(root: string, path: string, content: string | Uint8Array): Promise<void> {
  await mkdir(join(root, path, ".."), { recursive: true });
  await writeFile(join(root, path), content);
}

async function putValidSpec(root: string, alias = "起跳", dependency: string[] = []): Promise<void> {
  await mkdir(join(root, "docs/spec"), { recursive: true });
  await copyFile(new URL("../resources/spec/schema.json", import.meta.url), join(root, "docs/spec/schema.json"));
  await writeFile(join(root, "docs/spec/jump.rules.json"), JSON.stringify({
    $schema: "schema.json",
    schemaVersion: 1,
    feature: { id: "player.jump", title: "跳跃", aliases: [alias] },
    rules: [{
      id: "player.jump.once",
      title: "只跳一次",
      condition: "角色在地面",
      trigger: "收到起跳输入",
      expected: "只开始一次跳跃",
      reason: "避免重复起跳",
      dependsOn: dependency,
      exceptions: [],
      acceptance: [{ id: "once", given: "在地面", when: "起跳", then: "只起跳一次" }],
    }],
  }));
}

async function waitFor(check: () => boolean | Promise<boolean>, timeout = 5_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("等待同步条件超时");
}

function sha(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

class FakeWatcher implements ProjectIndexWatcher {
  closed = false;
  private errorListener: ((error: Error) => void) | null = null;
  constructor(readonly path: string, private readonly listener: Parameters<ProjectIndexWatchFactory>[1]) {}
  close(): void { this.closed = true; }
  on(_event: "error", listener: (error: Error) => void): this { this.errorListener = listener; return this; }
  emit(eventType: "rename" | "change", path: string | null): void { if (!this.closed) this.listener(eventType, path); }
  fail(): void { if (!this.closed) this.errorListener?.(new Error("injected watcher failure")); }
}

function fakeWatchers() {
  const watchers: FakeWatcher[] = [];
  const factory: ProjectIndexWatchFactory = (path, listener) => {
    const watcher = new FakeWatcher(path, listener);
    watchers.push(watcher);
    return watcher;
  };
  return { watchers, factory };
}

afterEach(async () => {
  for (const repo of repositories.splice(0).reverse()) await removeRepoFixture(repo);
  for (const root of roots.splice(0).reverse()) await rm(root, { recursive: true, force: true });
});

test("M3-AC1/2：真实watch同步增删改名、同size/mtime内容、spec全集合和锁文件，未变代码不重parse", async () => {
  const counts = new Map<string, number>();
  const extractor: ProjectIndexExtractor = {
    version: getCodeExtractorVersion,
    async extract(input) {
      counts.set(input.path, (counts.get(input.path) ?? 0) + 1);
      return extractCode(input);
    },
  };
  const w = await world(extractor);
  await put(w.repo.root, "src/a.ts", "export const alpha = 'one';\n");
  await put(w.repo.root, "src/b.ts", "export const stable = 'same';\n");
  await put(w.repo.root, "pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
  await putValidSpec(w.repo.root);
  const manager = new ProjectIndexSyncManager({ service: w.service, authorize: () => true, debounceMs: 25, lowFrequencyMs: 60_000 });
  expect(await manager.start()).toMatchObject({ state: "fresh", dirty: false, watchHealthy: true });
  counts.clear();

  const changedPath = join(w.repo.root, "src/a.ts");
  const before = await stat(changedPath);
  const changed = "export const alpha = 'two';\n";
  expect(Buffer.byteLength(changed)).toBe(before.size);
  const sequence = manager.status().eventSequence;
  await writeFile(changedPath, changed);
  await utimes(changedPath, before.atime, before.mtime);
  await waitFor(() => manager.status().eventSequence > sequence);
  const first = await manager.ensureFresh();
  expect(first).toMatchObject({ state: "fresh", dirty: false });
  expect(counts.get("src/a.ts")).toBe(1);
  expect(counts.get("src/b.ts") ?? 0).toBe(0);

  counts.clear();
  await put(w.repo.root, "src/new.ts", "export function added() {}\n");
  await rm(join(w.repo.root, "src/a.ts"));
  await rename(join(w.repo.root, "src/b.ts"), join(w.repo.root, "src/renamed.ts"));
  await put(w.repo.root, "pnpm-lock.yaml", "lockfileVersion: '9.1'\n");
  await appendFile(join(w.repo.root, "docs/spec/schema.json"), "\n");
  await put(w.repo.root, "docs/spec/land.rules.json", JSON.stringify({
    $schema: "schema.json",
    schemaVersion: 1,
    feature: { id: "player.land", title: "落地", aliases: [] },
    rules: [{
      id: "player.land",
      title: "接触地面",
      condition: "角色正在下落",
      trigger: "接触地面",
      expected: "进入地面状态",
      reason: "结束跳跃",
      dependsOn: [], exceptions: [],
      acceptance: [{ id: "land", given: "正在下落", when: "接触地面", then: "进入地面状态" }],
    }],
  }));
  await putValidSpec(w.repo.root, "跃起", ["player.land"]);
  await manager.ensureFresh();

  const store = new IndexStore(indexDatabase(w.dataRoot, w.repoId), w.service.workspace);
  try {
    const snapshot = store.getSnapshot();
    expect(snapshot.files.some((file) => file.path === "src/a.ts")).toBe(false);
    expect(snapshot.files.some((file) => file.path === "src/new.ts")).toBe(true);
    expect(snapshot.files.some((file) => file.path === "src/b.ts")).toBe(false);
    expect(snapshot.files.some((file) => file.path === "src/renamed.ts")).toBe(true);
    expect(store.search("stable").results).toHaveLength(1);
    expect(snapshot.features.find((feature) => feature.id === "player.jump")?.aliases).toEqual(["跃起"]);
    expect(snapshot.ruleEdges).toContainEqual(expect.objectContaining({ fromRuleId: "player.jump.once", toRuleId: "player.land", kind: "depends_on" }));
    expect(snapshot.files.find((file) => file.path === "pnpm-lock.yaml")?.hash).toBe(sha("lockfileVersion: '9.1'\n"));
    expect(snapshot.codeEdges.every((edge) => edge.certainty === "unknown" || edge.toSymbolId !== null)).toBe(true);
  } finally { store.close(); }
  expect(counts.get("src/new.ts")).toBe(1);
  expect(counts.get("src/renamed.ts")).toBe(1);
  await manager.stop();
});

test("所有对账入口按稳定baselineHash通知实际变化，未变周期不重复通知，latestBuildResult只返回fresh深拷贝", async () => {
  const w = await world();
  const initial = "export const missed = 'one';\n";
  const changed = "export const missed = 'two';\n";
  await put(w.repo.root, "src/missed.ts", initial);
  const fakes = fakeWatchers();
  const events: ProjectIndexBaselineChange[] = [];
  const manager = new ProjectIndexSyncManager({
    service: w.service,
    authorize: () => true,
    watchFactory: fakes.factory,
    debounceMs: 1_000,
    lowFrequencyMs: 60_000,
  });
  manager.subscribe({ id: "baseline-reader", authorize: () => true, onBaselineChange: (event) => { events.push(event); } });
  const started = await manager.start();
  expect(started.baselineHash).toMatch(/^[0-9a-f]{64}$/);
  expect(events.filter((event) => event.reason === "reconciled_change")).toEqual([]);
  const firstBuild = manager.latestBuildResult()!;
  expect(firstBuild).toMatchObject({ baselineHash: started.baselineHash, files: expect.any(Number), spec: expect.any(Object) });
  firstBuild.watchPlan.directories.length = 0;
  expect(manager.latestBuildResult()!.watchPlan.directories.length).toBeGreaterThan(0);

  const file = join(w.repo.root, "src/missed.ts");
  const before = await stat(file);
  expect(Buffer.byteLength(initial)).toBe(Buffer.byteLength(changed));
  await writeFile(file, changed);
  await utimes(file, before.atime, before.mtime);
  expect(manager.latestBuildResult()).not.toBeNull();
  const fresh = await manager.ensureFresh();
  expect(fresh.baselineHash).not.toBe(started.baselineHash);
  await waitFor(() => events.some((event) => event.reason === "reconciled_change" && event.source === "read_before"));
  const afterReadChanges = events.filter((event) => event.reason === "reconciled_change").length;
  const unchanged = await manager.ensureFresh();
  expect(unchanged.baselineHash).toBe(fresh.baselineHash);
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(events.filter((event) => event.reason === "reconciled_change")).toHaveLength(afterReadChanges);

  await writeFile(file, "export const missed = 'tri';\n");
  await manager.reconcile();
  await waitFor(() => events.some((event) => event.reason === "reconciled_change" && event.source === "manual"));
  await manager.stop();
  expect(manager.latestBuildResult()).toBeNull();
  await writeFile(file, "export const missed = 'off';\n");
  await manager.reconnect();
  await waitFor(() => events.some((event) => event.reason === "reconciled_change" && event.source === "reconnect"));

  const rootWatcher = fakes.watchers.filter((watcher) => !watcher.closed && watcher.path === w.repo.root).at(-1)!;
  rootWatcher.emit("change", "src");
  expect(manager.latestBuildResult()).toBeNull();
  await manager.ensureFresh();
  expect(manager.latestBuildResult()).toMatchObject({ baselineHash: manager.status().baselineHash });
  await manager.stop();

  const restartedEvents: ProjectIndexBaselineChange[] = [];
  await writeFile(file, "export const missed = 'new';\n");
  const restarted = new ProjectIndexSyncManager({ service: w.service, authorize: () => true, watchFactory: fakeWatchers().factory, lowFrequencyMs: 60_000 });
  restarted.subscribe({ id: "restarted", authorize: () => true, onBaselineChange: (event) => { restartedEvents.push(event); } });
  await restarted.start();
  await waitFor(() => restartedEvents.some((event) => event.reason === "reconciled_change" && event.source === "start"));
  await restarted.stop();
});

test("漏watch的内容变化由低频hash对账发现并发送来源明确的无正文通知", async () => {
  const w = await world();
  await put(w.repo.root, "src/low.ts", "export const low = 'before';\n");
  const fakes = fakeWatchers();
  const events: ProjectIndexBaselineChange[] = [];
  const manager = new ProjectIndexSyncManager({
    service: w.service,
    authorize: () => true,
    watchFactory: fakes.factory,
    debounceMs: 1_000,
    lowFrequencyMs: 100,
  });
  manager.subscribe({ id: "low-reader", authorize: () => true, onBaselineChange: (event) => { events.push(event); } });
  await manager.start();
  const lowPath = join(w.repo.root, "src/low.ts");
  const before = await stat(lowPath);
  await writeFile(lowPath, "export const low = 'after!';\n");
  await utimes(lowPath, before.atime, before.mtime);
  await waitFor(() => events.some((event) => event.reason === "reconciled_change" && event.source === "low_frequency"), 8_000);
  const event = events.find((item) => item.reason === "reconciled_change" && item.source === "low_frequency")!;
  expect(event).toMatchObject({ path: null, requiresFullReconcile: true, baselineHash: expect.stringMatching(/^[0-9a-f]{64}$/) });
  expect(JSON.stringify(event)).not.toContain("after!");
  await manager.stop();
}, 12_000);

test("同路径目录inode替换后关闭旧watcher并重新注册，真实watch仍能观察新目录文件", async () => {
  const w = await world();
  await put(w.repo.root, "src/a.ts", "export const oldDirectory = true;\n");
  const events: ProjectIndexBaselineChange[] = [];
  const manager = new ProjectIndexSyncManager({ service: w.service, authorize: () => true, debounceMs: 1_000, lowFrequencyMs: 60_000 });
  manager.subscribe({ id: "inode-reader", authorize: () => true, onBaselineChange: (event) => { events.push(event); } });
  await manager.start();
  const oldInode = (await stat(join(w.repo.root, "src"))).ino;
  await rename(join(w.repo.root, "src"), join(w.repo.root, "src-old"));
  await mkdir(join(w.repo.root, "src"));
  await writeFile(join(w.repo.root, "src/a.ts"), "export const newDirectory = true;\n");
  expect((await stat(join(w.repo.root, "src"))).ino).not.toBe(oldInode);
  await manager.ensureFresh();
  await waitFor(() => events.some((event) => event.reason === "reconciled_change"));
  events.length = 0;
  await writeFile(join(w.repo.root, "src/after.ts"), "export const watchedAfterReplacement = true;\n");
  await waitFor(() => events.some((event) => event.path === "src/after.ts"));
  await manager.ensureFresh();
  const store = new IndexStore(indexDatabase(w.dataRoot, w.repoId), w.service.workspace);
  try { expect(store.search("watchedAfterReplacement").results).toHaveLength(1); }
  finally { store.close(); }
  await manager.stop();
}, 12_000);

test("每订阅者只有一个在途回调和一个合并待通知，排队后撤权或取消订阅不会调用旧回调", async () => {
  const w = await world();
  await put(w.repo.root, "src/a.ts", "export const a = 1;\n");
  const fakes = fakeWatchers();
  const manager = new ProjectIndexSyncManager({
    service: w.service,
    authorize: () => true,
    watchFactory: fakes.factory,
    debounceMs: 1_000,
    lowFrequencyMs: 60_000,
    maxQueuedEvents: 2,
  });
  let release!: () => void;
  let entered!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const received: ProjectIndexBaselineChange[] = [];
  manager.subscribe({
    id: "slow",
    authorize: () => true,
    async onBaselineChange(event) {
      received.push(event);
      if (received.length === 1) { entered(); await held; }
    },
  });
  await manager.start();
  const rootWatcher = fakes.watchers.find((watcher) => watcher.path === w.repo.root)!;
  rootWatcher.emit("change", "first.ts");
  await started;
  for (let index = 0; index < 1_000; index++) rootWatcher.emit("change", `f${index}.ts`);
  expect(manager.status()).toMatchObject({ activeCallbacks: 1, pendingNotifications: 1, overflowed: true });
  release();
  await waitFor(() => received.length === 2);
  expect(received[1]).toMatchObject({ reason: "overflow", path: null, requiresFullReconcile: true });
  expect(manager.status().activeCallbacks).toBeLessThanOrEqual(1);
  expect(manager.status().pendingNotifications).toBeLessThanOrEqual(1);

  let allowRevocable = true;
  let releaseRevocable!: () => void;
  let enteredRevocable!: () => void;
  const revocableHeld = new Promise<void>((resolve) => { releaseRevocable = resolve; });
  const revocableStarted = new Promise<void>((resolve) => { enteredRevocable = resolve; });
  let revocableCalls = 0;
  manager.subscribe({
    id: "revocable",
    authorize: () => allowRevocable,
    async onBaselineChange() {
      revocableCalls++;
      if (revocableCalls === 1) { enteredRevocable(); await revocableHeld; }
    },
  });
  rootWatcher.emit("change", "revocable-first.ts");
  await revocableStarted;
  rootWatcher.emit("change", "revocable-queued.ts");
  allowRevocable = false;
  releaseRevocable();
  await waitFor(() => manager.status().activeCallbacks === 0);
  expect(revocableCalls).toBe(1);

  let cancelledCalls = 0;
  const unsubscribe = manager.subscribe({ id: "cancelled", authorize: () => true, onBaselineChange: () => { cancelledCalls++; } });
  rootWatcher.emit("change", "cancelled-before-start.ts");
  unsubscribe();
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(cancelledCalls).toBe(0);
  await manager.stop();
}, 15_000);

test("订阅回调可以等待manager操作并从回调内stop，不与stop等待已开始回调互锁", async () => {
  const w = await world();
  await put(w.repo.root, "src/a.ts", "export const a = 1;\n");
  const fakes = fakeWatchers();
  const manager = new ProjectIndexSyncManager({
    service: w.service,
    authorize: () => true,
    watchFactory: fakes.factory,
    debounceMs: 1_000,
    lowFrequencyMs: 60_000,
  });
  let completed = false;
  manager.subscribe({
    id: "self-stop",
    authorize: () => true,
    async onBaselineChange() {
      await manager.stop();
      completed = true;
    },
  });
  await manager.start();
  fakes.watchers.find((watcher) => watcher.path === w.repo.root)!.emit("change", "stop.ts");
  await waitFor(() => completed && manager.status().activeCallbacks === 0);
  expect(manager.status()).toMatchObject({ state: "stopped", started: false, watchers: 0, activeCallbacks: 0 });
}, 10_000);

test("M3-AC3：两克隆各用自己的index.db，离线pull在reconnect和有效读取前完整补账", async () => {
  const root = await mkdtemp(join(temporaryRoot(), "project-index-sync-clones-"));
  roots.push(root);
  const origin = join(root, "origin.git"), cloneA = join(root, "clone-a"), cloneB = join(root, "clone-b");
  await exec("git", ["init", "--bare", "--initial-branch=main", origin], { env: GIT_ENV });
  await exec("git", ["clone", origin, cloneA], { env: GIT_ENV });
  await put(cloneA, "src/shared.ts", "export const shared = 'before_pull';\n");
  await exec("git", ["add", "src/shared.ts"], { cwd: cloneA, env: GIT_ENV });
  await exec("git", ["commit", "-m", "initial source"], { cwd: cloneA, env: GIT_ENV });
  await exec("git", ["push", "-u", "origin", "main"], { cwd: cloneA, env: GIT_ENV });
  await exec("git", ["clone", origin, cloneB], { env: GIT_ENV });

  const dataA = join(root, "data-a"), dataB = join(root, "data-b");
  await mkdir(dataA); await mkdir(dataB);
  const idA = await repositoryIdentity(cloneA), idB = await repositoryIdentity(cloneB);
  const serviceA = await ProjectIndexService.open({ repositoryRoot: cloneA, dataRoot: dataA, repoId: idA.repoId, authorize: () => true });
  const serviceB = await ProjectIndexService.open({ repositoryRoot: cloneB, dataRoot: dataB, repoId: idB.repoId, authorize: () => true });
  const managerA = new ProjectIndexSyncManager({ service: serviceA, authorize: () => true, lowFrequencyMs: 60_000 });
  const managerB = new ProjectIndexSyncManager({ service: serviceB, authorize: () => true, lowFrequencyMs: 60_000 });
  try {
    await managerA.start(); await managerB.start(); await managerB.stop();
    await writeFile(join(cloneA, "src/shared.ts"), "export const shared = 'after_pull';\n");
    await exec("git", ["add", "src/shared.ts"], { cwd: cloneA, env: GIT_ENV });
    await exec("git", ["commit", "-m", "update source"], { cwd: cloneA, env: GIT_ENV });
    await exec("git", ["push"], { cwd: cloneA, env: GIT_ENV });
    expect(await managerA.ensureFresh()).toMatchObject({ state: "fresh", dirty: false });
    await exec("git", ["pull", "--ff-only"], { cwd: cloneB, env: GIT_ENV });
    expect(await managerB.reconnect()).toMatchObject({ state: "fresh", dirty: false });
    expect(await managerB.ensureFresh()).toMatchObject({ state: "fresh", dirty: false });
    const storeA = new IndexStore(indexDatabase(dataA, idA.repoId), serviceA.workspace);
    const storeB = new IndexStore(indexDatabase(dataB, idB.repoId), serviceB.workspace);
    try {
      expect(storeA.search("after_pull").results).toHaveLength(1);
      expect(storeB.search("after_pull").results).toHaveLength(1);
      expect(storeB.search("before_pull").results).toEqual([]);
      expect(indexDatabase(dataA, idA.repoId)).not.toBe(indexDatabase(dataB, idB.repoId));
    } finally { storeA.close(); storeB.close(); }
  } finally {
    await managerA.stop().catch(() => undefined);
    await managerB.stop().catch(() => undefined);
  }
}, 20_000);

test("构建中事件先使旧正文失效、提高fence，旧构建不能清dirty且最终使用最新内容", async () => {
  let block = false;
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  const extractor: ProjectIndexExtractor = {
    version: getCodeExtractorVersion,
    async extract(input) {
      if (block && input.path === "src/a.ts") { entered(); await held; }
      return extractCode(input);
    },
  };
  const w = await world(extractor);
  await put(w.repo.root, "src/a.ts", "export const during = 'before';\n");
  await put(w.repo.root, "src/b.ts", "export const companion = 'before';\n");
  const fakes = fakeWatchers();
  const manager = new ProjectIndexSyncManager({
    service: w.service,
    authorize: () => true,
    watchFactory: fakes.factory,
    debounceMs: 1_000,
    lowFrequencyMs: 60_000,
    maxReconcilePasses: 4,
  });
  await manager.start();
  block = true;
  await writeFile(join(w.repo.root, "src/a.ts"), "export const during = 'middle';\n");
  const reconciling = manager.reconcile();
  await started;
  const active = fakes.watchers.find((watcher) => watcher.path === join(w.repo.root, "src"))!;
  await writeFile(join(w.repo.root, "src/b.ts"), "export const companion = 'latest';\n");
  active.emit("change", "b.ts");

  await waitFor(() => {
    const store = new IndexStore(indexDatabase(w.dataRoot, w.repoId), w.service.workspace);
    try { store.getSnapshot(); return false; }
    catch (error) { return (error as { code?: string }).code === "index_not_ready"; }
    finally { store.close(); }
  });
  release();
  expect(await reconciling).toMatchObject({ state: "fresh", dirty: false, eventSequence: expect.any(Number) });
  const store = new IndexStore(indexDatabase(w.dataRoot, w.repoId), w.service.workspace);
  try {
    expect(store.search("latest").results).toHaveLength(1);
    expect(store.search("before").results).toEqual([]);
  } finally { store.close(); }
  await manager.stop();
});

test("归档watch只发无正文metadata，优先异步风险hook后才常规重建", async () => {
  const order: string[] = [];
  const extractor: ProjectIndexExtractor = {
    version: getCodeExtractorVersion,
    async extract(input) { order.push("parse"); return extractCode(input); },
  };
  const w = await world(extractor);
  await put(w.repo.root, "src/a.ts", "export const value = true;\n");
  await mkdir(join(w.repo.root, "docs/prod"), { recursive: true });
  const existingId = "0197b7b0-6a20-7c51-8a32-b9465fb72d10";
  await writeFile(join(w.repo.root, "docs/prod", `${existingId}.已有.md`), "EXISTING_ARCHIVE_BODY_MUST_NOT_BE_READ");
  const events: ProjectIndexBaselineChange[] = [];
  const manager = new ProjectIndexSyncManager({
    service: w.service,
    authorize: () => true,
    debounceMs: 1_000,
    lowFrequencyMs: 60_000,
    beforeArchiveRisk: async (event) => {
      expect(event).not.toHaveProperty("body");
      order.push("archive-hook-start");
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push("archive-hook-end");
    },
  });
  manager.subscribe({ id: "window-a", authorize: () => true, onBaselineChange: (event) => { events.push(event); } });
  await manager.start();
  expect(order.indexOf("archive-hook-end")).toBeGreaterThanOrEqual(0);
  expect(order.indexOf("parse")).toBeGreaterThan(order.indexOf("archive-hook-end"));
  order.length = 0;
  const id = "0197b7b0-6a21-7c51-8a32-b9465fb72d10";
  const archivePath = join(w.repo.root, "docs/prod", `${id}.完成.md`);
  await writeFile(archivePath, "ARCHIVE_BODY_MUST_NOT_BE_READ");
  await waitFor(() => events.some((event) => event.archiveMetadataOnly));
  const result = await manager.ensureFresh();
  expect(result.state).toBe("fresh");
  expect(order.slice(0, 2)).toEqual(["archive-hook-start", "archive-hook-end"]);
  expect(events.find((event) => event.archiveMetadataOnly)).toMatchObject({
    reason: "archive_metadata",
    archiveMetadataOnly: true,
    path: `docs/prod/${id}.完成.md`,
  });
  expect(JSON.stringify(events)).not.toContain("ARCHIVE_BODY_MUST_NOT_BE_READ");
  expect(JSON.stringify(events)).not.toContain("EXISTING_ARCHIVE_BODY_MUST_NOT_BE_READ");
  const store = new IndexStore(indexDatabase(w.dataRoot, w.repoId), w.service.workspace);
  try {
    expect(store.search("ARCHIVE_BODY_MUST_NOT_BE_READ").results).toEqual([]);
    expect(store.getSnapshot().prodMetadata).toContainEqual(expect.objectContaining({ path: `docs/prod/${id}.完成.md`, lifecycle: "unknown", hash: null }));
  } finally { store.close(); }
  await manager.stop();
});

test("有界事件队列、多个授权订阅者、watch失败和stop等待回调并清理资源", async () => {
  const w = await world();
  await put(w.repo.root, "src/a.ts", "export const a = 1;\n");
  const fakes = fakeWatchers();
  const delivered: string[] = [];
  let finishSlow!: () => void;
  const slow = new Promise<void>((resolve) => { finishSlow = resolve; });
  const manager = new ProjectIndexSyncManager({
    service: w.service,
    authorize: () => true,
    watchFactory: fakes.factory,
    debounceMs: 1_000,
    lowFrequencyMs: 60_000,
    maxQueuedEvents: 2,
  });
  manager.subscribe({ id: "allowed", authorize: () => true, onBaselineChange: async () => { delivered.push("allowed"); await slow; } });
  manager.subscribe({ id: "revoked", authorize: () => false, onBaselineChange: () => { delivered.push("revoked"); } });
  await manager.start();
  const rootWatcher = fakes.watchers.find((watcher) => watcher.path === w.repo.root)!;
  rootWatcher.emit("change", "one.ts");
  rootWatcher.emit("change", "two.ts");
  rootWatcher.emit("change", "three.ts");
  await waitFor(() => delivered.includes("allowed"));
  expect(manager.status()).toMatchObject({ dirty: true, overflowed: true, activeCallbacks: 1 });
  expect(manager.status().queuedEvents).toBeLessThanOrEqual(2);
  expect(delivered).not.toContain("revoked");
  rootWatcher.fail();
  expect(manager.status()).toMatchObject({ dirty: true, watchHealthy: false });

  const stopping = manager.stop();
  let stopped = false;
  void stopping.then(() => { stopped = true; });
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(stopped).toBe(false);
  finishSlow();
  expect(await stopping).toMatchObject({ state: "stopped", started: false, watchers: 0 });
  expect(fakes.watchers.every((watcher) => watcher.closed)).toBe(true);
});

test("ensureFresh返回前事件序号变化时明确unstable，未授权调用与订阅默认拒绝", async () => {
  const w = await world();
  await put(w.repo.root, "src/a.ts", "export const a = 1;\n");
  const denied = new ProjectIndexSyncManager({ service: w.service });
  await expect(denied.start()).rejects.toMatchObject({ code: "authorization_denied" });
  expect(() => denied.status()).toThrowError(expect.objectContaining({ code: "authorization_denied" }));

  const fakes = fakeWatchers();
  let manager!: ProjectIndexSyncManager;
  let injectAtReturn = false;
  const authorized = new ProjectIndexSyncManager({
    service: w.service,
    watchFactory: fakes.factory,
    debounceMs: 1_000,
    lowFrequencyMs: 60_000,
    authorize(request) {
      if (injectAtReturn && request.action === "ensureFresh" && request.phase === "return") {
        injectAtReturn = false;
        const watcher = fakes.watchers.find((item) => item.path === w.repo.root)!;
        watcher.emit("change", "src");
      }
      return true;
    },
  });
  manager = authorized;
  await manager.start();
  injectAtReturn = true;
  expect(await manager.ensureFresh()).toMatchObject({ state: "unstable", dirty: true });
  await manager.stop();
});

test("watch计划不进入排除目录、嵌套仓库或链接，只在docs/prod目录接收元数据事件", async () => {
  const w = await world();
  const outside = await mkdtemp(join(temporaryRoot(), "project-index-sync-outside-"));
  roots.push(outside);
  await put(w.repo.root, "src/a.ts", "export const a = 1;\n");
  await put(w.repo.root, "node_modules/pkg/hidden.ts", "export const hidden = true;\n");
  await put(w.repo.root, "nested/.git/config", "[core]\n");
  await put(w.repo.root, "nested/hidden.ts", "export const nested = true;\n");
  await put(outside, "outside.ts", "export const outsideValue = true;\n");
  await symlink(outside, join(w.repo.root, "linked"), "dir");
  await mkdir(join(w.repo.root, "docs/prod/private-child"), { recursive: true });
  await put(w.repo.root, "docs/prod/private-child/body.md", "NEVER_WATCH_BODY");
  const fakes = fakeWatchers();
  const manager = new ProjectIndexSyncManager({
    service: w.service,
    authorize: () => true,
    watchFactory: fakes.factory,
    lowFrequencyMs: 60_000,
  });
  expect(await manager.start()).toMatchObject({ state: "fresh", watchHealthy: true });
  const paths = fakes.watchers.map((watcher) => watcher.path);
  expect(paths).toContain(join(w.repo.root, "docs/prod"));
  expect(paths.some((path) => path.startsWith(`${join(w.repo.root, "docs/prod")}/`))).toBe(false);
  expect(paths.some((path) => path.includes("node_modules") || path.includes("nested") || path.includes("linked"))).toBe(false);
  expect(paths.some((path) => path.startsWith(w.dataRoot))).toBe(false);
  await manager.stop();
});

test("watch注册超过上限时有界并明确unstable/dirty，不把不完整监听说成fresh", async () => {
  const w = await world();
  await put(w.repo.root, "src/a.ts", "export const a = 1;\n");
  const fakes = fakeWatchers();
  const manager = new ProjectIndexSyncManager({
    service: w.service,
    authorize: () => true,
    watchFactory: fakes.factory,
    maxWatchers: 1,
    lowFrequencyMs: 60_000,
  });
  expect(await manager.start()).toMatchObject({
    state: "unstable",
    dirty: true,
    watchHealthy: false,
    watchers: 1,
    lastError: { code: "watcher_limit" },
  });
  const store = new IndexStore(indexDatabase(w.dataRoot, w.repoId), w.service.workspace);
  try { expect(() => store.getSnapshot()).toThrowError(expect.objectContaining({ code: "index_not_ready" })); }
  finally { store.close(); }
  await manager.stop();
});

test("归档风险hook失败保持error/dirty，普通IndexStore查询不能返回旧正文", async () => {
  const w = await world();
  await put(w.repo.root, "src/a.ts", "export const OLD_INDEX_BODY = true;\n");
  await mkdir(join(w.repo.root, "docs/prod"), { recursive: true });
  const fakes = fakeWatchers();
  const manager = new ProjectIndexSyncManager({
    service: w.service,
    authorize: () => true,
    watchFactory: fakes.factory,
    debounceMs: 1_000,
    lowFrequencyMs: 60_000,
    beforeArchiveRisk: async () => { throw new Error("injected archive gate failure"); },
  });
  await manager.start();
  const archiveWatcher = fakes.watchers.find((watcher) => watcher.path === join(w.repo.root, "docs/prod"))!;
  archiveWatcher.emit("rename", "0197b7b0-6a20-7c51-8a32-b9465fb72d10.完成.md");
  expect(await manager.ensureFresh()).toMatchObject({ state: "error", dirty: true, lastError: { code: "archive_risk_failed" } });
  const store = new IndexStore(indexDatabase(w.dataRoot, w.repoId), w.service.workspace);
  try {
    expect(() => store.getSnapshot()).toThrowError(expect.objectContaining({ code: "index_not_ready" }));
    expect(() => store.search("OLD_INDEX_BODY")).toThrowError(expect.objectContaining({ code: "index_not_ready" }));
    expect(store.getRebuildSnapshot().sourceFragments.some((fragment) => fragment.body.includes("OLD_INDEX_BODY"))).toBe(true);
  } finally { store.close(); }
  await manager.stop();
});

test("stop取消并等待真实构建收尾，reconnect和低频对账可恢复且watcher不累积", async () => {
  let armed = false;
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  const extractor: ProjectIndexExtractor = {
    version: getCodeExtractorVersion,
    async extract(input) {
      if (armed) { entered(); await held; armed = false; }
      return extractCode(input);
    },
  };
  const w = await world(extractor);
  await put(w.repo.root, "src/a.ts", "export const a = 1;\n");
  const fakes = fakeWatchers();
  const manager = new ProjectIndexSyncManager({
    service: w.service,
    authorize: () => true,
    watchFactory: fakes.factory,
    debounceMs: 1_000,
    lowFrequencyMs: 500,
  });
  await manager.start();
  armed = true;
  await writeFile(join(w.repo.root, "src/a.ts"), "export const a = 2;\n");
  const building = manager.reconcile();
  await started;
  const stopping = manager.stop();
  let stopped = false;
  void stopping.then(() => { stopped = true; });
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(stopped).toBe(false);
  release();
  await building;
  expect(await stopping).toMatchObject({ state: "stopped", watchers: 0 });
  expect(fakes.watchers.every((watcher) => watcher.closed)).toBe(true);

  const reconnected = await manager.reconnect();
  expect(reconnected).toMatchObject({ state: "fresh", started: true, dirty: false });
  const generation = reconnected.generation;
  await waitFor(() => manager.status().generation > generation);
  expect(manager.status().watchers).toBeLessThanOrEqual(2);
  await manager.stop();
}, 15_000);

// 这些用例控制真实服务周围的异步边界，核对收尾而非只检查返回标签。
test("生命周期竞争：退订重注册仍受运行回调总上限约束", async () => {
  const w = await world();
  await put(w.repo.root, "src/a.ts", "export const a = 1;\n");
  const fakes = fakeWatchers();
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const manager = new ProjectIndexSyncManager({ service: w.service, authorize: () => true, watchFactory: fakes.factory,
    maxSubscribers: 1, debounceMs: 1_000, lowFrequencyMs: 60_000 });
  await manager.start();
  try {
    const watcher = fakes.watchers.find((item) => !item.closed && item.path === w.repo.root)!;
    for (let index = 0; index < 12; index++) {
      const unsubscribe = manager.subscribe({ id: "churn", authorize: () => true, onBaselineChange: async () => { await held; } });
      watcher.emit("change", `churn-${index}.ts`);
      await new Promise<void>((resolve) => setImmediate(resolve));
      unsubscribe();
    }
    expect(manager.status().activeCallbacks).toBeLessThanOrEqual(1);
  } finally { release(); await manager.stop(); }
});

test("生命周期竞争：stop等待真实回调期间拒绝start，不复活watcher", async () => {
  const w = await world();
  await put(w.repo.root, "src/a.ts", "export const a = 1;\n");
  const fakes = fakeWatchers();
  let release!: () => void;
  let entered!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
  const manager = new ProjectIndexSyncManager({ service: w.service, authorize: () => true, watchFactory: fakes.factory,
    debounceMs: 1_000, lowFrequencyMs: 60_000 });
  manager.subscribe({ id: "slow-stop", authorize: () => true, onBaselineChange: async () => { entered(); await held; } });
  await manager.start();
  fakes.watchers.find((item) => item.path === w.repo.root)!.emit("change", "stop.ts");
  await enteredPromise;
  const stopping = manager.stop();
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    await expect(manager.start()).rejects.toMatchObject({ code: "operation_in_progress" });
    release();
    expect(await stopping).toMatchObject({ state: "stopped", started: false, watchers: 0 });
    expect(fakes.watchers.every((watcher) => watcher.closed)).toBe(true);
  } finally { release(); await stopping; await manager.stop(); }
});

test("生命周期竞争：watchFactory触发stop后新建watcher立即关闭", async () => {
  const w = await world();
  await put(w.repo.root, "src/a.ts", "export const a = 1;\n");
  const watchers: FakeWatcher[] = [];
  let manager!: ProjectIndexSyncManager;
  let stopping: Promise<unknown> | undefined;
  manager = new ProjectIndexSyncManager({ service: w.service, authorize: () => true, lowFrequencyMs: 60_000,
    watchFactory(path, listener) {
      const watcher = new FakeWatcher(path, listener);
      watchers.push(watcher);
      if (!stopping) stopping = manager.stop();
      return watcher;
    },
  });
  try {
    await manager.start();
    await stopping;
    expect(manager.status()).toMatchObject({ state: "stopped", started: false, watchers: 0 });
    expect(watchers.every((watcher) => watcher.closed)).toBe(true);
  } finally { await stopping; await manager.stop(); }
});

test("生命周期竞争：归档风险处理完成前不向普通订阅者发通知", async () => {
  const w = await world();
  await put(w.repo.root, "src/a.ts", "export const a = 1;\n");
  await mkdir(join(w.repo.root, "docs/prod"), { recursive: true });
  const fakes = fakeWatchers();
  const order: string[] = [];
  const manager = new ProjectIndexSyncManager({ service: w.service, authorize: () => true, watchFactory: fakes.factory,
    debounceMs: 1_000, lowFrequencyMs: 60_000,
    beforeArchiveRisk: async () => { order.push("risk-start"); await Promise.resolve(); order.push("risk-end"); },
  });
  manager.subscribe({ id: "ordinary", authorize: () => true, onBaselineChange: () => { order.push("subscriber"); } });
  await manager.start();
  try {
    fakes.watchers.find((item) => item.path === join(w.repo.root, "docs/prod"))!
      .emit("rename", "0197b7b0-6a20-7c51-8a32-b9465fb72d10.完成.md");
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(order).toEqual([]);
    await manager.reconcile();
    await waitFor(() => order.includes("subscriber"));
    expect(order.indexOf("subscriber")).toBeGreaterThan(order.indexOf("risk-end"));
  } finally { await manager.stop(); }
});

test("生命周期竞争：start返回授权拒绝后没有后台资源", async () => {
  const w = await world();
  await put(w.repo.root, "src/a.ts", "export const a = 1;\n");
  const fakes = fakeWatchers();
  const manager = new ProjectIndexSyncManager({ service: w.service, watchFactory: fakes.factory,
    authorize: (request) => !(request.action === "start" && request.phase === "return"), lowFrequencyMs: 60_000 });
  try {
    await expect(manager.start()).rejects.toMatchObject({ code: "authorization_denied" });
    expect(manager.status()).toMatchObject({ state: "stopped", started: false, watchers: 0, activeCallbacks: 0 });
    expect(fakes.watchers.every((watcher) => watcher.closed)).toBe(true);
  } finally { await manager.stop(); }
});
