import { afterEach, expect, test } from "vitest";
import { Type } from "typebox";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createAgentRoleSession } from "../../daemon/agent-session.ts";
import { RunManager } from "../../daemon/run-manager.ts";
import { RelayQueue } from "../../daemon/relay-queue.ts";
import { RunStore } from "../../runtime/run-store.ts";
import { repositoryIdentity } from "../../runtime/identity.ts";
import { createClock } from "../../runtime/clock.ts";
import { ShellRegistry } from "../../runtime/shell-registry.ts";
import { uuidv7 } from "../../runtime/database.ts";
import { ConnectivityProbe, NetworkPauseGate } from "../../runtime/network-pause.ts";
import { startHeartbeat, WindowRegistry } from "../../runtime/windows.ts";
import { createFakeTimeSource, withClockPump } from "../helpers/fake-clock.ts";
import { createDaemonFixture, killDaemon, removeDaemonFixture, startDaemonForTest } from "../helpers/daemon-harness.ts";
import { createRepoFixture, removeRepoFixture } from "../helpers/repo-fixture.ts";
import { createTempHome, removeTempHome } from "../helpers/temp-home.ts";
import { registerControlledProvider, scriptReplies } from "../helpers/controlled-provider.ts";
import type { ScriptedReply } from "../helpers/controlled-provider.ts";

const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
function resultTool() {
  return { name: "pi_company_result_submit", label: "result", description: "fixture", parameters: Type.Object({}),
    async execute() { return { content: [{ type: "text" as const, text: "accepted" }], details: {} }; } } as any;
}
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until(predicate: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 200; i++) { if (await predicate()) return; await delay(25); }
  throw new Error("异步网络操作未收尾");
}
async function world() {
  const repo = await createRepoFixture(); cleanup.push(() => removeRepoFixture(repo));
  const home = await createTempHome(); cleanup.push(() => removeTempHome(home));
  const { repoId } = await repositoryIdentity(repo.root);
  const clock = createClock(); cleanup.push(() => clock.stopGapWatcher());
  const shells = new ShellRegistry({ clock });
  const gate = new NetworkPauseGate();
  const store = new RunStore({ dataRoot: home.dataRoot, repoId, daemonStartedAt: "network-history" });
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, modelsStorePath: join(home.home, "models.json"), refreshOnCreate: false });
  let serial = 0;
  async function role(replies: ScriptedReply[]) {
    const provider = registerControlledProvider(runtime, { providerId: `network-fixture-${++serial}`, modelId: "test" }); scriptReplies(provider, replies);
    const run = await store.create({ kind: "role", standalone: true, role: "pi-company.worker", requirement: "2026-09-10.network", task: `T-${serial}`,
      cwd: repo.root, readPaths: [repo.root], writePaths: [], model: { provider: provider.providerId, id: "test" }, thinking: "off", mcp: [] });
    const handle = await createAgentRoleSession({ dataRoot: home.dataRoot, repoId, runId: run.id, cwd: repo.root,
      definition: { name: "worker", role: "worker", description: "fixture", body: "fixture" }, context: run.task, coreTools: [resultTool()], readRoots: [repo.root],
      runtime, modelRef: run.model, clock, networkGate: gate, completion: { kind: "on-result", resultTool: "pi_company_result_submit" } });
    cleanup.push(async () => { await handle.stop(); handle.dispose(); });
    return { handle, provider, run };
  }
  return { repo, home, repoId, clock, shells, gate, store, runtime, role };
}

test("真实SDK连接故障只暂停受影响角色，同批独立角色正常完成", async () => {
  const w = await world();
  const network = await w.role([{ type: "error", message: "fetch failed: connection reset (network)" }]);
  const normal = await w.role([{ type: "toolcall", name: "pi_company_result_submit", input: {} }, { type: "text", text: "独立只读结果" }]);
  network.handle.prompt("触发连接故障"); normal.handle.prompt("不依赖其他角色");
  await until(() => network.handle.state() === "paused_network"); await normal.handle.result();
  expect(normal.handle.state()).toBe("completed"); expect(w.gate.canProceed(network.run.id)).toEqual({ allowed: false, reason: "network" });
  expect(w.gate.canProceed(normal.run.id)).toEqual({ allowed: true });
  await delay(100); expect(network.provider.requests).toHaveLength(1); expect(normal.provider.requests).toHaveLength(1);
}, 20000);

test("真实SDK认证、额度、业务错误均failed且保留真实原因，不误分类为网络暂停", async () => {
  const w = await world();
  for (const message of ["unauthorized: invalid api key supplied", "quota exceeded for this billing period", "请求参数不合法，缺少必填字段"]) {
    const s = await w.role([{ type: "error", message }]); s.handle.prompt("分类测试");
    await expect(s.handle.result()).rejects.toThrow(message); expect(s.handle.state()).toBe("failed");
    expect(w.gate.canProceed(s.run.id)).toEqual({ allowed: true }); expect(s.provider.requests).toHaveLength(1);
  }
}, 20000);

test("真实网络探测恢复不复活旧暂停运行，手动暂停保持，且不调用模型", async () => {
  const w = await world();
  const network = await w.role([{ type: "error", message: "network fetch failed" }]);
  const manual = await w.role([{ type: "text", text: "不应发出" }]);
  // 历史状态数据不作为角色恢复授权；此处不启动两个SDK会话。
  await w.store.update(network.run.id, { state: "running" }); await w.store.update(network.run.id, { state: "paused_network" });
  await w.store.update(manual.run.id, { state: "running" }); await w.store.update(manual.run.id, { state: "pausing" }); await w.store.update(manual.run.id, { state: "paused" });
  w.gate.requestPause(network.run.id, "network"); w.gate.requestPause(manual.run.id, "manual");
  const relay = new RelayQueue({ dataDir: join(w.home.dataRoot, "repos", w.repoId), deliver: async () => [] });
  const manager = new RunManager({ dataRoot: w.home.dataRoot, repoId: w.repoId, runStore: w.store, shellRegistry: w.shells, networkGate: w.gate, relayQueue: relay,
    roleCatalog: [], runtime: w.runtime, selectModel: () => { throw new Error("不得选模型"); }, clock: w.clock, workspaceRepoIds: [w.repoId], emit: () => {} });
  manager.markStarted(); cleanup.push(() => manager.close());
  const before = await w.store.list({ limit: 100 }); let reachable = false, offlineTicks = 0, onlineTicks = 0;
  const probe = new ConnectivityProbe({ clock: w.clock, intervalMs: 30, probe: async () => {
    if (!reachable) { offlineTicks++; return; }
    await manager.resumeNetworkPaused(network.run.model.provider); onlineTicks++;
  } }); cleanup.push(() => probe.stop()); probe.start();
  await until(() => offlineTicks > 0); reachable = true; await until(() => onlineTicks > 1); probe.stop();
  expect(await w.store.list({ limit: 100 })).toEqual(before);
  expect(w.gate.canProceed(manual.run.id)).toEqual({ allowed: false, reason: "manual" });
  expect(w.gate.canProceed(network.run.id)).toEqual({ allowed: false, reason: "network" });
  expect(network.provider.requests).toEqual([]); expect(manual.provider.requests).toEqual([]);
}, 20000);

test("daemon空闲计时不因注入五分钟睡眠时钟跳变提前退出", async () => {
  const fixture = await createDaemonFixture(); cleanup.push(() => removeDaemonFixture(fixture));
  const skewFile = join(fixture.home.home, "clock-skew.json"); await writeFile(skewFile, "0");
  const handle = await startDaemonForTest(fixture, { idleTimeoutMs: 3000, clockSkewFile: skewFile }); cleanup.push(() => killDaemon(handle));
  await delay(500); await writeFile(skewFile, String(5 * 60 * 1000)); await delay(500);
  expect(handle.proc.exitCode).toBeNull(); expect(handle.proc.signalCode).toBeNull();
}, 15000);

test("同一时钟的60秒后台Shell超时与窗口心跳不因五分钟睡眠跳变失效", async () => {
  const time = createFakeTimeSource(), clock = createClock({ timeSource: time }); cleanup.push(() => clock.stopGapWatcher());
  const shells = new ShellRegistry({ clock });
  const spawned = await shells.spawn({ taskId: uuidv7(), host: { kind: "main", id: "sleep-test" }, command: process.execPath, args: ["-e", "setInterval(()=>{},1000)"], mode: "background", timeoutSeconds: 60, runToken: uuidv7() });
  if (!spawned.ok) throw new Error(spawned.reason);
  cleanup.push(async () => { await withClockPump(time, () => shells.stop(spawned.task.taskId)); expect(() => process.kill(spawned.task.pid, 0)).toThrow(); });
  const dir = await mkdtemp(join(tmpdir(), "sleep-window-")); cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const registry = new WindowRegistry({ repoDir: dir, clock, bootId: async () => "boot-fixed", processStartedAt: async (pid) => `start-${pid}` });
  const id = uuidv7(); await registry.register({ windowId: id, pid: process.pid, sessionId: "sleep", cwd: dir, workspaceRoot: dir });
  cleanup.push(() => registry.unregister(id)); const heartbeat = startHeartbeat(registry, id); cleanup.push(heartbeat);
  time.jump(5 * 60000); await delay(50);
  expect(shells.get(spawned.task.taskId)?.status).not.toBe("timed_out"); expect(await registry.isAlive(id)).toBe(true);
  expect((await registry.holderGone(id)).gone).toBe(false);
}, 15000);
