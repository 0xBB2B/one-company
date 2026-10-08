import { afterEach, expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, realpath, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClock } from "../../runtime/clock.ts";
import { connectDaemon } from "../../runtime/daemon-client.ts";
import { uuidv7 } from "../../runtime/database.ts";
import type { KnowledgeFactPackage } from "../../runtime/knowledge-query.ts";
import { RequirementService } from "../../runtime/requirement-service.ts";
import { RequirementStateStore } from "../../runtime/requirement-state.ts";
import { readGit } from "../../runtime/git-read.ts";
import { repoDataDir } from "../../runtime/identity.ts";
import { addWorktree } from "../helpers/repo-fixture.ts";
import { createDaemonFixture, removeDaemonFixture, resolveSdkDir, spawnDaemonProcess, waitForSocketReady } from "../helpers/daemon-harness.ts";
import type { SpawnedDaemon } from "../helpers/daemon-harness.ts";
import { modelProviderEnv, writeTestModelProviders } from "../helpers/daemon-model-fixture.ts";
import { within } from "../helpers/within.ts";

const cleanups: Array<() => Promise<unknown>> = [];
const probeModule = fileURLToPath(new URL("../helpers/project-index-daemon-child.ts", import.meta.url));

afterEach(async () => {
  const failures: unknown[] = [];
  for (const cleanup of cleanups.splice(0).reverse()) { try { await cleanup(); } catch (error) { failures.push(error); } }
  if (failures.length) throw new AggregateError(failures, "项目索引装配夹具清理失败");
});

interface Probe { pid: number; node: string; forbiddenReads: number; exited: boolean }

async function world() {
  const fixture = await createDaemonFixture();
  cleanups.push(() => removeDaemonFixture(fixture));
  fixture.repo.root = await realpath(fixture.repo.root);
  fixture.dataRoot = await realpath(fixture.dataRoot);
  await repoDataDir(fixture.dataRoot, fixture.repoId, fixture.repoDir);
  await writeFile(join(fixture.repo.root, "source.ts"), 'export const alpha = "AAAA";\n');
  const providerLog = join(fixture.home.home, "provider-requests.jsonl");
  await writeFile(providerLog, "", { mode: 0o600 });
  const providers = await writeTestModelProviders(fixture.home.home, [{ providerId: "controlled-index", modelId: "controlled-model",
    replies: [{ type: "text", text: "unexpected-model-call" }] }]);
  const probePath = join(fixture.home.home, "probe.json");
  let daemon: SpawnedDaemon | undefined;
  cleanups.push(async () => {
    if (!daemon) return;
    if (daemon.proc.exitCode === null && daemon.proc.signalCode === null) daemon.proc.kill("SIGTERM");
    await within(() => daemon!.exited, "daemon close", 13_000);
  });
  async function start() {
    daemon = spawnDaemonProcess({ home: fixture.home, repoDir: fixture.repoDir, dataRoot: fixture.dataRoot, idleTimeoutMs: 60_000, captureOutput: true,
      extraEnv: { ...modelProviderEnv(providers, providerLog), NODE_OPTIONS: `--import=${probeModule}`,
        M3_ASSEMBLY_PROBE: probePath, M3_ASSEMBLY_REPOSITORY: fixture.repo.root } });
    const started = daemon;
    await Promise.race([waitForSocketReady(fixture.socketPath), started.exited.then((result) => {
      throw new Error(`装配启动失败：${JSON.stringify(result)}`);
    })]);
    return started;
  }
  async function connect() {
    const clock = createClock();
    const client = await connectDaemon({ repoDir: fixture.repo.root, dataRoot: fixture.dataRoot, sdkDir: resolveSdkDir(), clock,
      hello: { windowId: randomUUID(), sessionId: randomUUID() } });
    const close = () => { client.close(); clock.stopGapWatcher(); };
    cleanups.push(async () => close());
    const query = async (query: Record<string, unknown>) => (await client.call("knowledge.query", { query })).page as KnowledgeFactPackage;
    return { client, close, query, manage: (action: string) => client.call("index.manage", { action }) };
  }
  const probe = async () => JSON.parse(await readFile(probePath, "utf8")) as Probe;
  return { fixture, providerLog, start, connect, probe };
}

const searchAlpha = { action: "search", text: "alpha" };

test("未初始化时knowledge.query返回not_initialized；init后可查询", async () => {
  const w = await world(); await w.start(); const a = await w.connect();
  await expect(a.query(searchAlpha)).rejects.toMatchObject({ code: "not_initialized" });
  expect((await a.manage("status")).result).toMatchObject({ managed: false });
  expect((await a.manage("init")).result).toMatchObject({ status: "ready" });
  const page = await a.query(searchAlpha);
  expect(page).toMatchObject({ format: "knowledge-facts/v1", indexStatus: "ready" });
  expect(JSON.stringify(page)).toContain("AAAA");
  expect(await readFile(w.providerLog, "utf8")).toBe("");
}, 60_000);

test("外部修改后下一次查询读到新内容，包括大小与mtime都不变的改写", async () => {
  const w = await world(); await w.start(); const a = await w.connect();
  await a.manage("init");
  const first = await a.query(searchAlpha);
  const path = join(w.fixture.repo.root, "source.ts");
  await writeFile(path, 'export const alpha = "BBBB";\n');
  const second = await a.query(searchAlpha);
  expect(JSON.stringify(second)).toContain("BBBB");
  expect(JSON.stringify(second)).not.toContain("AAAA");
  expect(second.generation).toBeGreaterThan(first.generation);
  const before = await stat(path);
  await writeFile(path, 'export const alpha = "CCCC";\n');
  // 数值秒保留亚毫秒精度，Date对象会截断原mtime，使“同mtime”夹具失真。
  await utimes(path, before.atimeMs / 1000, before.mtimeMs / 1000);
  const after = await stat(path);
  expect(after.size).toBe(before.size);
  expect(after.mtimeMs).toBeCloseTo(before.mtimeMs, 2);
  const third = await a.query(searchAlpha);
  expect(JSON.stringify(third)).toContain("CCCC");
  expect(JSON.stringify(third)).not.toContain("BBBB");
  const unchanged = await a.query(searchAlpha);
  expect(unchanged.generation).toBe(third.generation);
}, 60_000);

test("发起init的连接断开后，新连接仍能查询当前内容", async () => {
  const w = await world(); await w.start(); const a = await w.connect();
  await a.manage("init");
  await a.query(searchAlpha);
  a.close();
  await writeFile(join(w.fixture.repo.root, "source.ts"), 'export const alpha = "DDDD";\n');
  const b = await w.connect();
  expect(JSON.stringify(await b.query(searchAlpha))).toContain("DDDD");
}, 60_000);

test("查询前对账发现docs/prod归档时先经归档风险核对，旧active需求被标记且不读取归档正文", async () => {
  const w = await world();
  const options = { repositoryRoot: w.fixture.repo.root, dataRoot: w.fixture.dataRoot, repoId: w.fixture.repoId, authorize: () => true };
  const service = await RequirementService.open(options); const state = await RequirementStateStore.open(options);
  const created = await service.create({ requestId: uuidv7(), operationId: uuidv7(), title: "归档装配", body: "PRIVATE-ACTIVE-SENTINEL" });
  const worktree = await addWorktree(w.fixture.repo);
  cleanups.push(async () => {
    await rm(worktree.root, { recursive: true, force: true });
    w.fixture.repo.worktrees.splice(w.fixture.repo.worktrees.indexOf(worktree.root), 1);
  });
  const bound = await state.bindWorkspace({ requirementId: created.requirementId, version: created.version,
    path: await realpath(worktree.root), prepareOperationId: uuidv7(), baseCommit: (await readGit(worktree.root, ["rev-parse", "HEAD"])).stdout.trim() });
  const active = await service.confirmUpdate({ requirementId: created.requirementId, version: bound.version,
    operationId: uuidv7(), title: "归档装配", body: "PRIVATE-ACTIVE-SENTINEL", receiptId: uuidv7() });
  const lease = await state.acquirePm({ requirementId: created.requirementId, version: active.version, runId: uuidv7(), expectedFence: 0 });
  await mkdir(join(w.fixture.repo.root, "docs", "prod"), { recursive: true });
  await w.start(); const a = await w.connect();
  await a.manage("init");
  await a.query(searchAlpha);
  expect(state.read(created.requirementId).data.recovery).not.toBe("needs_review");
  await writeFile(join(w.fixture.repo.root, "docs", "prod", `${created.requirementId}.归档装配.md`), "ARCHIVE-BODY-SENTINEL", { mode: 0o000 });
  const page = await a.query(searchAlpha);
  // 查询返回时撤权已完成：对账在交付查询结果之前触发归档风险核对。
  expect(state.read(created.requirementId).data).toMatchObject({ lifecycle: "active", recovery: "needs_review", recoveryReason: "archive_found", close: null });
  expect(state.pmOwner(created.requirementId)).toMatchObject({ lease: null });
  await expect(state.checkPm(lease)).rejects.toThrow(/recovery_required/);
  expect(JSON.stringify(page)).not.toContain("ARCHIVE-BODY-SENTINEL");
  expect((await w.probe()).forbiddenReads).toBe(0);
}, 90_000);

test("守护进程shutdown时正常收尾：退出码0、移除socket、零禁读", async () => {
  const w = await world(); const daemon = await w.start(); const a = await w.connect();
  expect((await a.client.call("hello")).daemonPid).toBe(daemon.proc.pid);
  await a.manage("init");
  await a.query(searchAlpha);
  expect(await a.client.call("shutdown")).toMatchObject({ accepted: true });
  const result = await within(() => daemon.exited, "daemon shutdown", 10_000);
  expect(result, result.stderr).toMatchObject({ code: 0, signal: null });
  expect(existsSync(w.fixture.socketPath)).toBe(false);
  expect(await w.probe()).toMatchObject({ forbiddenReads: 0, exited: true, node: process.execPath });
  expect(await readFile(w.providerLog, "utf8")).toBe("");
}, 60_000);

test("新索引对象装配之后的启动失败必须非零退出并清理socket", async () => {
  const w = await world();
  const fixture = w.fixture;
  const child = spawnDaemonProcess({ home: fixture.home, repoDir: fixture.repoDir, dataRoot: fixture.dataRoot, idleTimeoutMs: 60_000, captureOutput: true,
    extraEnv: { ONE_COMPANY_MODEL_PROVIDER_MODULE: new URL("file:///nonexistent-m3-assembly-provider.ts").href } });
  const result = await within(() => child.exited, "装配失败退出", 10_000);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("daemon 装配失败");
  expect(existsSync(fixture.socketPath)).toBe(false);
}, 30_000);
