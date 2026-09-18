import { afterEach, expect, test } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import projectManageExtension, { activeProjectSyncController } from "../../extensions/project-manage.ts";
import type { WindowContextValue } from "../../extensions/lifecycle.ts";
import { createClock } from "../../runtime/clock.ts";
import { connectDaemon } from "../../runtime/daemon-client.ts";
import type { WorkspaceClientsHandle } from "../../runtime/daemon-client.ts";
import { indexDatabase, LocalDatabase, repositoryDatabase, uuidv7 } from "../../runtime/database.ts";
import { IndexStore } from "../../runtime/index-store.ts";
import type { WorkspaceIdentity } from "../../runtime/index-store.ts";
import { PROJECT_INDEX_GRANT_NAMESPACE } from "../../runtime/project-sync-grants.ts";
import type { createProjectManageTool } from "../../runtime/project-manage-tool.ts";
import { RequirementService } from "../../runtime/requirement-service.ts";
import { RequirementStateStore } from "../../runtime/requirement-state.ts";
import { readGit, gitExecutable } from "../../runtime/git-read.ts";
import { repoDataDir } from "../../runtime/identity.ts";
import { addWorktree } from "../helpers/repo-fixture.ts";
import { createFakePi } from "../helpers/fake-pi.ts";
import { createDaemonFixture, removeDaemonFixture, resolveSdkDir, spawnDaemonProcess, waitForSocketReady } from "../helpers/daemon-harness.ts";
import type { DaemonExitResult, SpawnedDaemon } from "../helpers/daemon-harness.ts";
import { modelProviderEnv, writeTestModelProviders } from "../helpers/daemon-model-fixture.ts";
import { cleanupOwnedScope, within } from "../helpers/m3-cleanup.ts";
import { classifySleep } from "../helpers/project-index-daemon-child.ts";
import type { SleepEvidence } from "../helpers/project-index-daemon-child.ts";

const cleanups: Array<(testFailed: boolean) => Promise<unknown>> = [];
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const childProbe = fileURLToPath(new URL("../helpers/project-index-daemon-child.ts", import.meta.url));

async function waitFor(check: () => boolean | Promise<boolean>, label: string, timeout = 15_000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { if (await check()) return; await delay(40); }
  throw new Error(`等待失败：${label}`);
}

async function exitWithin(child: SpawnedDaemon): Promise<DaemonExitResult> {
  return within(() => child.exited, `自有daemon ${child.proc.pid} close`, 10_000);
}

interface Resources { at: number; rss: number; heapUsed: number; heapTotal: number; external: number;
  arrayBuffers: number; handles: number; activeResources: number; resourceCounts: Record<string, number> }
interface Probe { pid: number; node: string; nodeVersion: string; watchers: number; peakWatchers: number;
  createdWatchers: number; closedWatchers: number; closeCalls: number; closeEvents: number;
  watcherErrors: unknown[]; closeErrors: string[]; forbiddenReads: number; exited: boolean;
  sampleCount: number; resources: Resources; peakResources: Resources;
  sleep: SleepEvidence;
  sleepGate: null | { call: number; phase: string; sequence: number } }

async function waitForSleepCompletion(child: { probe(): Promise<Probe>; requiredSleepCalls: number[] }): Promise<void> {
  await waitFor(async () => {
    const { sleep } = await child.probe();
    const result = classifySleep(sleep, child.requiredSleepCalls);
    // 目标必须成功；额外回调仅在原始拒绝与实际撤权顺序吻合时单列为cancelled。
    return result.pending.length === 0 && child.requiredSleepCalls.every((call) => result.successful.includes(call));
  }, `真实onSleepGap必测${child.requiredSleepCalls.join(",")}及当前在途Promise结束`, 10_000);
}

afterEach(async (context) => {
  const failures: unknown[] = [];
  for (const cleanup of cleanups.splice(0).reverse()) { try { await cleanup(context.task.result?.state !== "pass"); } catch (error) { failures.push(error); } }
  if (failures.length) throw new AggregateError(failures, "M3装配夹具清理失败");
});

async function world() {
  const artifacts = await realpath(await mkdtemp("/tmp/m3-assembly-fixture-"));
  await chmod(artifacts, 0o700);
  const fixture = await createDaemonFixture();
  const children: Array<SpawnedDaemon & { requiredSleepCalls: number[] }> = [];
  const hosts: Array<() => Promise<void>> = [];
  const resourceRounds: Array<{ round: number; stage: string; probe: Probe }> = [];
  const evidence = process.env.M3_ASSEMBLY_EVIDENCE;
  cleanups.push((testFailed) => cleanupOwnedScope({
    paths: [artifacts, fixture.repo.root, ...fixture.repo.worktrees, fixture.dataRoot, fixture.home.home],
    stop: [
      ...hosts.map((close, index) => ({ label: `host-${index} shutdown`, run: close })),
      ...children.map((child, index) => ({ label: `daemon-${index} close`, timeoutMs: 13_000, run: async () => {
        if (child.proc.exitCode === null && child.proc.signalCode === null) {
          child.proc.kill("SIGCONT"); child.proc.kill("SIGTERM");
        }
        try { await exitWithin(child); }
        catch (cause) {
          if (child.proc.exitCode === null && child.proc.signalCode === null) child.proc.kill("SIGKILL");
          await within(() => child.exited, `daemon-${index} 强制停止close`, 2_000);
          throw new Error("daemon需要强制清理，保留诊断现场", { cause });
        }
      } })),
    ],
    diagnose: children.map((child, index) => ({ label: `daemon-${index} evidence`, run: async () => {
      // close回执包含完整stdio；即使一个孩子未结束，其余孩子仍独立停止并保存诊断。
      const exit = await within(() => child.exited, `daemon-${index} 诊断close`, 1_000)
        .then((result) => ({ confirmed: true, ...result }), (error: unknown) => ({ confirmed: false, error: String(error) }));
      const probe = JSON.parse(await readFile(join(artifacts, `probe-${index}.json`), "utf8")) as Probe;
      if (evidence?.startsWith("/tmp/m3-assembly-") || evidence?.startsWith("/tmp/m3-test-lifecycle-") || evidence?.startsWith("/tmp/m3-sleep-evidence-")) {
        await writeFile(join(evidence, `${artifacts.split("/").at(-1)}-${index}.json`), JSON.stringify({
          exit, probe, resourceRounds, requiredSleepCalls: child.requiredSleepCalls,
          sleepClassification: (() => { try { return classifySleep(probe.sleep, child.requiredSleepCalls, true); }
            catch (error) { return { error: String(error) }; } })(),
          testFailed, providerRequests: await readFile(providerLog, "utf8"),
          ownedPaths: [artifacts, fixture.repo.root, ...fixture.repo.worktrees, fixture.dataRoot, fixture.home.home],
          level: "real daemon process; in-process simulated host lifecycle; sampled memory/handles; injected clock gap",
        }, null, 2), { mode: 0o600 });
      }
      if (!exit.confirmed) throw new Error("daemon未确认close");
      if (probe.watchers !== 0 || probe.createdWatchers !== probe.closeEvents || probe.closedWatchers !== probe.closeEvents) {
        throw new Error(`真实watcher关闭未收敛：${JSON.stringify(probe)}`);
      }
      if (probe.closeErrors.length || probe.watcherErrors.length) throw new Error(`watcher错误：${JSON.stringify(probe)}`);
      classifySleep(probe.sleep, child.requiredSleepCalls, true);
    } })).concat([{ label: "test outcome", run: async () => {
      if (testFailed) throw new Error("测试失败或结果未知，保留原始现场供复核");
    } }]),
    remove: [{ label: "remove daemon fixture", run: () => removeDaemonFixture(fixture) },
      { label: "remove artifacts", run: () => rm(artifacts, { recursive: true, force: true }) }],
  }));
  fixture.repo.root = await realpath(fixture.repo.root);
  fixture.dataRoot = await realpath(fixture.dataRoot);
  // 对应真实lifecycle在建立宿主现场前准备本机目录的步骤，不用socket存在代替装配完成。
  await repoDataDir(fixture.dataRoot, fixture.repoId, fixture.repoDir);
  await writeFile(join(fixture.repo.root, "source.ts"), "export const initial = 1;\n");
  // 实际SDK ModelRuntime注册受控provider替身；索引用例不派PM、不调用任何外部LLM。
  const providerLog = join(artifacts, "provider-requests.jsonl");
  await writeFile(providerLog, "", { mode: 0o600 });
  const providers = await writeTestModelProviders(artifacts, [{ providerId: "controlled-index-assembly",
    modelId: "controlled-model", roleName: "requirement-agent", replies: [{ type: "text", text: "unexpected-model-call" }] }]);
  const skew = join(artifacts, "clock-skew");
  async function start(extraEnv: Record<string, string> = {}) {
    const probePath = join(artifacts, `probe-${children.length}.json`);
    const child = spawnDaemonProcess({ home: fixture.home, repoDir: fixture.repoDir, dataRoot: fixture.dataRoot,
      idleTimeoutMs: 60_000, clockSkewFile: skew, captureOutput: true,
      extraEnv: { ...modelProviderEnv(providers, providerLog), NODE_OPTIONS: `--import=${childProbe}`,
        M3_ASSEMBLY_PROBE: probePath, M3_ASSEMBLY_REPOSITORY: fixture.repo.root, ...extraEnv } });
    const requiredSleepCalls: number[] = [];
    children.push({ ...child, requiredSleepCalls });
    await Promise.race([waitForSocketReady(fixture.socketPath), child.exited.then((result) => {
      throw new Error(`装配启动失败：${JSON.stringify(result)}`);
    })]);
    const probe = async () => JSON.parse(await readFile(probePath, "utf8")) as Probe;
    return { ...child, probe, requiredSleepCalls };
  }
  async function host() {
    const windowId = randomUUID(); const sessionId = randomUUID();
    const clock = createClock();
    const client = await connectDaemon({ repoDir: fixture.repo.root, dataRoot: fixture.dataRoot, sdkDir: resolveSdkDir(), clock,
      hello: { windowId, sessionId, pid: process.pid, cwd: fixture.repo.root, workspaceRoot: fixture.repo.root } });
    const workspace = { repos: [{ path: fixture.repo.root, repoId: fixture.repoId, commonDir: fixture.repoDir }], skipped: [] };
    const clients: WorkspaceClientsHandle = { forRepo: (id) => id === fixture.repoId ? client : undefined,
      all: () => [client], skipped: () => [], workspace: () => workspace, closeAll: () => client.close() };
    const window: WindowContextValue = { windowId, sessionId, workspace, clients };
    let live = true; let approvals = 0;
    // 只模拟宿主UI的已批准交互；模型工具参数不含approved、principal或grantId。
    const ctx = { cwd: fixture.repo.root, hasUI: true, mode: "rpc", sessionManager: { getSessionId: () => sessionId },
      ui: { confirm: async () => { approvals++; return true; } } } as unknown as ExtensionContext;
    const fake = createFakePi();
    projectManageExtension(fake.pi as unknown as ExtensionAPI, { dataRoot: fixture.dataRoot,
      windowReady: async () => window, windowContext: () => { if (!live) throw new Error("closed fixture host"); return window; } });
    const tool = fake.registeredTools()[0] as ReturnType<typeof createProjectManageTool>["tool"];
    let closing: Promise<void> | undefined;
    const close = () => closing ??= (async () => {
      try { live = false; await fake.trigger("session_shutdown", {}, ctx); }
      finally { client.close(); clock.stopGapWatcher(); }
    })();
    hosts.push(close);
    await fake.trigger("session_start", {}, ctx);
    return { client, close, approvals: () => approvals,
      controller: () => activeProjectSyncController({ windowId, sessionId, repoId: fixture.repoId })!,
      call: (action: "init" | "status" | "refresh") => tool.execute("assembly-host", { action, repoId: fixture.repoId }, undefined, undefined, ctx) };
  }
  const snapshot = (workspace: WorkspaceIdentity) => {
    const store = new IndexStore(indexDatabase(fixture.dataRoot, fixture.repoId), workspace);
    try { return store.getSnapshot(); } finally { store.close(); }
  };
  const indexStatus = (workspace: WorkspaceIdentity) => {
    const store = new IndexStore(indexDatabase(fixture.dataRoot, fixture.repoId), workspace);
    try { return store.status(); } finally { store.close(); }
  };
  const hasFile = (workspace: WorkspaceIdentity, path: string, content?: string) => {
    try { return snapshot(workspace).files.some((file) => file.path === path && (content === undefined || file.hash === hash(content))); }
    catch { return false; }
  };
  const grants = () => {
    const db = new LocalDatabase(repositoryDatabase(fixture.dataRoot, fixture.repoId));
    try { return db.list<Record<string, unknown>>(PROJECT_INDEX_GRANT_NAMESPACE).map((row) => row.data); } finally { db.close(); }
  };
  return { artifacts, fixture, providerLog, skew, start, host, snapshot, indexStatus, hasFile, grants, resourceRounds };
}

test("真实daemon装配：init外改自动更新、两窗口共用watcher、A退出B继续、关闭收尾", async () => {
  const w = await world(); const child = await w.start(); const a = await w.host();
  expect((await a.client.call("hello")).daemonPid).toBe(child.proc.pid);
  const helloA = a.client.connectionIdentity()!;
  expect(helloA.daemonInstanceId).toMatch(/^[0-9a-f-]{36}$/u);
  expect(helloA.connectionId).toMatch(/^[0-9a-f-]{36}$/u);
  await a.call("status");
  expect(existsSync(indexDatabase(w.fixture.dataRoot, w.fixture.repoId))).toBe(false);
  expect((await child.probe()).watchers).toBe(0);
  await a.call("init");
  const workspace = a.controller().workspace;
  const firstWatchers = (await child.probe()).watchers;
  expect(firstWatchers).toBeGreaterThan(0);
  const b = await w.host(); await b.call("init");
  const helloB = b.client.connectionIdentity()!;
  expect(helloB.daemonInstanceId).toBe(helloA.daemonInstanceId);
  expect(helloB.connectionId).not.toBe(helloA.connectionId);
  expect(b.controller().workspace).toEqual(workspace);
  expect((await child.probe()).watchers).toBe(firstWatchers);
  expect(w.grants().filter((grant) => grant.status === "active")).toHaveLength(2);
  expect(w.grants().every((grant) => grant.daemonInstanceId === helloA.daemonInstanceId)).toBe(true);
  const events: Record<string, unknown>[] = [];
  const off = b.client.subscribe("project.index.changed", (event) => { events.push(event); });
  const changed = "export const changed = 2;\n";
  await writeFile(join(w.fixture.repo.root, "source.ts"), changed);
  // 仅观察SQLite已发布结果；不调用refresh/ensureFresh来代替watcher促发。
  await waitFor(() => w.hasFile(workspace, "source.ts", changed), "外部编辑自动发布");
  await waitFor(() => events.length > 0, "普通基线通知");
  await a.close();
  expect((await child.probe()).watchers).toBe(firstWatchers);
  await rename(join(w.fixture.repo.root, "source.ts"), join(w.fixture.repo.root, "renamed.ts"));
  await waitFor(() => w.hasFile(workspace, "renamed.ts", changed) && !w.hasFile(workspace, "source.ts"), "重命名自动发布");
  await writeFile(join(w.fixture.repo.root, "added.ts"), "export const added = 3;\n");
  await waitFor(() => w.hasFile(workspace, "added.ts"), "新增自动发布");
  await rm(join(w.fixture.repo.root, "added.ts"));
  await waitFor(() => { try { return !w.snapshot(workspace).files.some((file) => file.path === "added.ts"); } catch { return false; } }, "删除自动发布").catch((error) => { throw new Error(`${error.message}: ${JSON.stringify({ status: w.indexStatus(workspace), events })}`); });
  expect((await b.client.call("runs.list", { limit: 10 })).items).toEqual([]);
  expect(await readFile(w.providerLog, "utf8")).toBe("");
  expect(a.approvals()).toBe(1); expect(b.approvals()).toBe(1);
  off();
  // B仍持有索引时执行真实shutdown，覆盖daemon自身资源收尾而非只测客户端detach。
  expect(await b.client.call("shutdown")).toMatchObject({ accepted: true });
  const result = await exitWithin(child);
  expect(result, result.stderr).toMatchObject({ code: 0, signal: null });
  expect(existsSync(w.fixture.socketPath)).toBe(false);
  expect(await child.probe()).toMatchObject({ watchers: 0, forbiddenReads: 0, exited: true, node: process.execPath });
  expect((await child.probe()).createdWatchers).toBe((await child.probe()).closedWatchers);
  expect(w.grants().every((grant) => grant.status === "revoked")).toBe(true);
}, 90_000);

test("真实daemon休眠接线和重连：同mtime改动、自动重连对账、旧扫描许可不自行恢复", async () => {
  const w = await world(); const first = await w.start(); const host = await w.host(); await host.call("init");
  const workspace = host.controller().workspace;
  const oldIdentity = host.client.connectionIdentity()!;
  const generation = w.snapshot(workspace).generation;
  first.requiredSleepCalls.push((await first.probe()).sleep.started + 1);
  await writeFile(w.skew, "3600000");
  await waitFor(() => { try { return w.snapshot(workspace).generation > generation; } catch { return false; } }, "clock.onSleepGap触发真实协调器对账", 10_000);
  await waitForSleepCompletion(first);
  expect(existsSync(w.skew)).toBe(false);
  const before = await stat(join(w.fixture.repo.root, "source.ts"));
  first.proc.kill("SIGTERM");
  expect(await exitWithin(first)).toMatchObject({ code: 0, signal: null });
  const changed = "export const initial = 9;\n";
  await writeFile(join(w.fixture.repo.root, "source.ts"), changed);
  await utimes(join(w.fixture.repo.root, "source.ts"), before.atime, before.mtime);
  expect((await stat(join(w.fixture.repo.root, "source.ts"))).size).toBe(before.size);
  const second = await w.start();
  // 同一个仍获扫描授权的宿主会话重连，真实hello换连接后重新签发许可并在读取前对账。
  await waitFor(() => host.client.connectionIdentity()?.daemonInstanceId !== oldIdentity.daemonInstanceId && host.controller().isActive(), "宿主自动重连");
  await waitFor(() => w.hasFile(workspace, "source.ts", changed), "离线变更在重连后发布");
  expect(host.approvals()).toBe(1);
  expect(host.client.connectionIdentity()!.connectionId).not.toBe(oldIdentity.connectionId);
  await host.close();
  await waitFor(async () => (await second.probe()).watchers === 0, "最后窗口退出关闭watcher");
  second.proc.kill("SIGTERM"); expect(await exitWithin(second)).toMatchObject({ code: 0 });
  const third = await w.start(); const newHost = await w.host();
  await newHost.call("status");
  expect((await third.probe()).watchers).toBe(0);
  expect(w.grants().every((grant) => grant.status === "revoked")).toBe(true);
  await newHost.call("init");
  expect(w.hasFile(workspace, "source.ts", changed)).toBe(true);
  expect(await newHost.client.call("shutdown")).toMatchObject({ accepted: true });
  expect(await exitWithin(third)).toMatchObject({ code: 0 });
  for (const child of [first, second, third]) {
    const probe = await child.probe();
    expect(probe).toMatchObject({ watchers: 0, forbiddenReads: 0, exited: true });
    expect(probe.createdWatchers).toBe(probe.closedWatchers);
  }
}, 90_000);

test("真实归档通知顺序：旧active先needs_review撤权，才收到普通project.index.changed", async () => {
  const w = await world();
  const options = { repositoryRoot: w.fixture.repo.root, dataRoot: w.fixture.dataRoot, repoId: w.fixture.repoId,
    gitExecutable: await gitExecutable(), authorize: () => true };
  // 封闭准备夹具创建当前active状态，之后daemon探针禁止读取其本机正文及版本库。
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
  const child = await w.start(); const host = await w.host(); await host.call("init");
  const observed: Array<{ event: Record<string, unknown>; recovery: string; lifecycle: string; lease: unknown }> = [];
  const off = host.client.subscribe("project.index.changed", (event) => {
    const record = state.read(created.requirementId);
    observed.push({ event, recovery: record.data.recovery, lifecycle: record.data.lifecycle, lease: state.pmOwner(created.requirementId).lease });
  });
  const archive = join(w.fixture.repo.root, "docs", "prod", `${created.requirementId}.归档装配.md`);
  await writeFile(archive, "ARCHIVE-BODY-SENTINEL", { mode: 0o000 });
  await waitFor(() => observed.length > 0, "归档事件在撤权后通知").catch((error) => {
    throw new Error(`${error.message}: ${JSON.stringify({ observed, state: state.read(created.requirementId).data.recovery,
      status: w.indexStatus(host.controller().workspace) })}`);
  });
  // 通知允许合并为整库基线变更；无论是否保留单条路径，不能在撤权完成前送达。
  for (const item of observed) expect(item).toMatchObject({ recovery: "needs_review", lifecycle: "active", lease: null });
  expect(state.read(created.requirementId).data).toMatchObject({ lifecycle: "active", recovery: "needs_review", recoveryReason: "archive_found", close: null });
  await expect(state.checkPm(lease)).rejects.toThrow(/recovery_required/);
  const workspace = host.controller().workspace;
  await waitFor(() => { try { return w.snapshot(workspace).prodMetadata.some((item) => item.requirementId === created.requirementId); } catch { return false; } }, "只发布归档元数据");
  expect(JSON.stringify(w.snapshot(workspace))).not.toContain("ARCHIVE-BODY-SENTINEL");
  const blocked = state.read(created.requirementId);
  await rm(archive);
  await waitFor(() => { try { return !w.snapshot(workspace).prodMetadata.some((item) => item.requirementId === created.requirementId); } catch { return false; } }, "归档删除自动对账");
  expect(state.read(created.requirementId)).toEqual(blocked);
  off();
  expect(await host.client.call("shutdown")).toMatchObject({ accepted: true });
  const result = await exitWithin(child); expect(result, result.stderr).toMatchObject({ code: 0 });
  expect(await child.probe()).toMatchObject({ forbiddenReads: 0, watchers: 0, exited: true });
  expect(await readFile(w.providerLog, "utf8")).toBe("");
}, 90_000);

test("真实daemon的spec自动同步及监听目录删除回收", async () => {
  const w = await world();
  const specDir = join(w.fixture.repo.root, "docs", "spec");
  await mkdir(specDir, { recursive: true });
  await copyFile(new URL("../../resources/spec/schema.json", import.meta.url), join(specDir, "schema.json"));
  const spec = (expected: string) => JSON.stringify({ $schema: "schema.json", schemaVersion: 1,
    feature: { id: "assembly.feature", title: "装配规则", aliases: [] },
    rules: [{ id: "assembly.rule", title: "单一行为", condition: "已初始化", trigger: "外部编辑",
      expected, reason: "保持当前", dependsOn: [], exceptions: [],
      acceptance: [{ id: "sync", given: "允许扫描", when: "修改规则", then: expected }] }] });
  await writeFile(join(specDir, "current.rules.json"), spec("同步当前文件"));
  const child = await w.start(); const host = await w.host(); await host.call("init");
  const workspace = host.controller().workspace;
  expect(w.snapshot(workspace).rules).toHaveLength(1);
  const initialWatchers = (await child.probe()).watchers;
  await writeFile(join(specDir, "current.rules.json"), spec("同步新的行为"));
  await waitFor(() => { try { return w.snapshot(workspace).rules[0]?.expected === "同步新的行为"; } catch { return false; } }, "spec修改自动发布");
  await rename(join(specDir, "current.rules.json"), join(specDir, "renamed.rules.json"));
  await waitFor(() => { try { return w.snapshot(workspace).rules[0]?.path === "docs/spec/renamed.rules.json"; } catch { return false; } }, "spec改名更新定位");
  await rm(specDir, { recursive: true });
  await waitFor(() => { try { return w.snapshot(workspace).rules.length === 0; } catch { return false; } }, "监听目录删除清除规则");
  await waitFor(async () => (await child.probe()).watchers < initialWatchers, "删除目录回收watcher");
  expect(await host.client.call("shutdown")).toMatchObject({ accepted: true });
  const result = await exitWithin(child); expect(result, result.stderr).toMatchObject({ code: 0 });
  expect(await child.probe()).toMatchObject({ watchers: 0, forbiddenReads: 0, exited: true });
}, 90_000);

test("同一真实daemon多轮窗口和目录增删、模拟休眠后资源回到有界稳定值", async () => {
  const w = await world(); const child = await w.start();
  let stableBaseline: Resources | undefined;
  let baseWatchers: number | undefined;
  let lastSample = -1;
  const record = async (round: number, stage: string) => {
    let probe!: Probe;
    await waitFor(async () => { probe = await child.probe(); return probe.sampleCount > lastSample; }, `资源采样 ${stage}`);
    lastSample = probe.sampleCount;
    w.resourceRounds.push({ round, stage, probe });
    expect(probe).toMatchObject({ pid: child.proc.pid, exited: false, forbiddenReads: 0, watcherErrors: [], closeErrors: [] });
    expect(child.proc.exitCode).toBeNull(); expect(child.proc.signalCode).toBeNull();
    return probe;
  };
  for (let round = 0; round < 6; round++) {
    const a = await w.host(); await a.call("init");
    const workspace = a.controller().workspace;
    const single = await record(round, "one-window");
    baseWatchers ??= single.watchers;
    expect(single.watchers).toBe(baseWatchers);
    const b = await w.host(); await b.call("init");
    const shared = await record(round, "two-windows");
    expect(shared.watchers).toBe(baseWatchers);
    const directory = join(w.fixture.repo.root, "round-directory");
    await mkdir(directory);
    await writeFile(join(directory, "source.ts"), `export const roundValue = ${round};\n`);
    await waitFor(() => w.hasFile(workspace, "round-directory/source.ts"), "新增目录自动发布");
    await waitFor(async () => (await child.probe()).watchers === baseWatchers! + 1, "新目录真实watcher安装");
    const added = await record(round, "directory-added");
    expect(added.watchers).toBeGreaterThan(baseWatchers);
    // 只增加一个目录，原生watcher数必须受这一个新增目录约束。
    expect(added.watchers).toBeLessThanOrEqual(baseWatchers + 1);
    expect(a.controller().isActive()).toBe(true);
    expect(b.controller().isActive()).toBe(true);
    expect(w.grants().filter((grant) => grant.status === "active")).toHaveLength(2);
    await waitForSleepCompletion(child);
    const beforeSleep = (await child.probe()).sleep;
    expect(beforeSleep).toMatchObject({ installed: true, observerErrors: 0 });
    let generation = 0;
    await waitFor(() => { try { generation = w.snapshot(workspace).generation; return true; } catch { return false; } }, "休眠前已发布基线");
    child.requiredSleepCalls.push(beforeSleep.started + 1);
    await record(round, `required-sleep-call-${beforeSleep.started + 1}-with-two-grants`);
    await writeFile(w.skew, "3600000");
    await waitFor(() => { try { return !existsSync(w.skew) && w.snapshot(workspace).generation > generation; } catch { return false; } },
      "模拟clock sleep gap在当前daemon对账", 10_000);
    await record(round, "simulated-sleep-generation-observed");
    await waitForSleepCompletion(child);
    expect(a.controller().isActive()).toBe(true);
    expect(b.controller().isActive()).toBe(true);
    expect(w.grants().filter((grant) => grant.status === "active")).toHaveLength(2);
    await record(round, "simulated-sleep-promise-completed-with-two-grants");
    await a.close();
    expect((await record(round, "first-window-detached")).watchers).toBe(added.watchers);
    await rm(directory, { recursive: true });
    await waitFor(() => { try { return !w.snapshot(workspace).files.some((file) => file.path === "round-directory/source.ts"); } catch { return false; } }, "删除目录自动发布");
    await waitFor(async () => (await child.probe()).watchers === baseWatchers, "删除目录真实close事件");
    await record(round, "directory-removed");
    // 排空当前在途后仍可能新增timer回调；后续失败必须由同进程的实际撤权证据归因。
    await waitForSleepCompletion(child);
    expect(b.controller().isActive()).toBe(true);
    expect(w.grants().filter((grant) => grant.status === "active")).toHaveLength(1);
    await record(round, "before-last-detach-sleep-settled");
    await b.close();
    let consecutive = 0;
    await waitFor(async () => {
      const probe = await child.probe();
      if (probe.sampleCount <= lastSample) return false;
      lastSample = probe.sampleCount;
      w.resourceRounds.push({ round, stage: "detach-settling", probe });
      const sleep = classifySleep(probe.sleep, child.requiredSleepCalls);
      const resources = probe.resources;
      const bounded = !stableBaseline || (resources.handles <= stableBaseline.handles
        && resources.activeResources <= stableBaseline.activeResources
        && Object.entries(resources.resourceCounts).every(([name, count]) => count <= (stableBaseline!.resourceCounts[name] ?? 0)));
      const closed = !probe.exited && probe.watchers === 0 && probe.createdWatchers === probe.closeEvents
        && probe.closedWatchers === probe.closeEvents;
      consecutive = bounded && closed && sleep.pending.length === 0 ? consecutive + 1 : 0;
      return consecutive >= 3;
    }, "同进程真实关闭及连续三次有界资源采样");
    const stable = await record(round, "detached-stable");
    stableBaseline ??= stable.resources;
    expect(stable.watchers).toBe(0);
    expect(stable.createdWatchers).toBe(stable.closeEvents);
    expect(stable.closedWatchers).toBe(stable.closeEvents);
    expect(stable.closeCalls).toBeGreaterThanOrEqual(stable.closeEvents);
    expect(stable.resources.handles).toBeLessThanOrEqual(stableBaseline.handles);
    expect(stable.resources.activeResources).toBeLessThanOrEqual(stableBaseline.activeResources);
  }
  expect(w.resourceRounds.filter((item) => item.stage === "detached-stable")).toHaveLength(6);
  // RSS/heap/外部内存保留每轮原值及采样峰值，不设置没有依据的零增长阈值。
  child.proc.kill("SIGTERM");
  expect(await exitWithin(child)).toMatchObject({ code: 0, signal: null });
}, 90_000);

test("真实sleep撤权竞争：额外调用取消不算成功，持权必测或无撤权证据仍拒绝", async () => {
  const w = await world();
  const gate = join(w.artifacts, "sleep-gate");
  const child = await w.start({ M3_SLEEP_GATE: gate });
  const host = await w.host(); await host.call("init");
  expect(w.grants().filter((grant) => grant.status === "active")).toHaveLength(1);
  await writeFile(gate, "armed", { mode: 0o600 });
  await writeFile(w.skew, "3600000");
  await waitFor(async () => (await child.probe()).sleepGate?.phase === "held", "真实sleep持权后在ensureFresh边界暂停", 10_000);
  const held = await child.probe();
  const call = held.sleepGate!.call;
  expect(held.sleep.authority.calls.find((item) => item.call === call)!.selections).toBeGreaterThan(0);
  w.resourceRounds.push({ round: 0, stage: "controlled-sleep-held-with-grant", probe: held });
  // detach先同步撤权，close仍等待排队的sleep；必须先发出close，再放行受控操作边界。
  const closing = host.close();
  try {
    await waitFor(async () => (await child.probe()).sleep.authority.revocations.length > 0, "实际attachment移除", 10_000);
    w.resourceRounds.push({ round: 0, stage: "controlled-attachment-revoked", probe: await child.probe() });
  } finally { await writeFile(`${gate}.release`, "release", { mode: 0o600 }); }
  await closing;
  await waitFor(async () => (await child.probe()).sleep.events.some((event) => event.call === call && event.phase === "failed"), "原sleep Promise真实拒绝", 10_000);
  const rejected = await child.probe();
  w.resourceRounds.push({ round: 0, stage: "controlled-sleep-rejected", probe: rejected });
  expect(rejected.sleep.failed).toBeGreaterThan(0);
  const classified = classifySleep(rejected.sleep);
  expect(classified.cancelled).toContain(call);
  expect(classified.successful).not.toContain(call);
  expect(() => classifySleep(rejected.sleep, [call])).toThrow("持权必测");
  const withoutRevocation = structuredClone(rejected.sleep);
  withoutRevocation.authority.revocations = [];
  expect(() => classifySleep(withoutRevocation)).toThrow("没有匹配");
  expect(w.grants().every((grant) => grant.status === "revoked")).toBe(true);
  child.proc.kill("SIGTERM");
  expect(await exitWithin(child)).toMatchObject({ code: 0, signal: null });
}, 30_000);

test("新索引对象装配之后的启动失败必须非零退出并清理socket", async () => {
  const w = await world();
  const child = await w.start({ PI_COMPANY_CONNECTIVITY_PROBE_MODULE: new URL("file:///nonexistent-m3-assembly-probe.ts").href });
  const result = await exitWithin(child);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("daemon 装配失败");
  expect(existsSync(w.fixture.socketPath)).toBe(false);
  expect(await child.probe()).toMatchObject({ watchers: 0, forbiddenReads: 0, exited: true });
}, 30_000);
