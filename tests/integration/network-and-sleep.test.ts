import { afterEach, expect, test } from "vitest";
import { Type } from "typebox";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createAgentRoleSession } from "../../src/modules/agents/agent-session.ts";
import { RunStore } from "../../src/modules/agents/run-store.ts";
import { repositoryIdentity } from "../../src/core/storage/identity.ts";
import { createClock } from "../../src/core/policy/clock.ts";
import { ShellRegistry } from "../../src/core/host/shell-registry.ts";
import { uuidv7 } from "../../src/core/storage/database.ts";
import { NetworkPauseGate } from "../../src/core/host/network-pause.ts";
import { createFakeTimeSource, withClockPump } from "../helpers/fake-clock.ts";
import { createDaemonFixture, killDaemon, removeDaemonFixture, startDaemonForTest } from "../helpers/daemon-harness.ts";
import { createRepoFixture, removeRepoFixture } from "../helpers/repo-fixture.ts";
import { createTempHome, removeTempHome } from "../helpers/temp-home.ts";
import { registerControlledProvider, scriptReplies } from "../helpers/controlled-provider.ts";
import { createPmRunWorld } from "../helpers/run-manager-fixture.ts";
import type { ScriptedReply } from "../helpers/controlled-provider.ts";

const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
function resultTool() {
  return { name: "one_company_result_submit", label: "result", description: "fixture", parameters: Type.Object({}),
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
  const requirement = uuidv7();
  const parent = await store.create({ kind: "requirement", requirement, task: "pm", cwd: repo.root, readPaths: [repo.root], writePaths: [],
    model: { provider: "network-parent", id: "test" }, thinking: "off", mcp: [] });
  let serial = 0;
  async function role(replies: ScriptedReply[]) {
    const provider = registerControlledProvider(runtime, { providerId: `network-fixture-${++serial}`, modelId: "test" }); scriptReplies(provider, replies);
    const run = await store.create({ kind: "role", parentRunId: parent.id, role: "one-company.worker", requirement, task: `T-${serial}`,
      cwd: repo.root, readPaths: [repo.root], writePaths: [], model: { provider: provider.providerId, id: "test" }, thinking: "off", mcp: [] });
    const handle = await createAgentRoleSession({ dataRoot: home.dataRoot, repoId, runId: run.id, cwd: repo.root,
      definition: { name: "worker", role: "worker", description: "fixture", body: "fixture" }, roleRules: "fixture", context: run.task, coreTools: [resultTool()], readRoots: [repo.root],
      runtime, modelRef: run.model, clock, networkGate: gate, completion: { kind: "on-result", resultTool: "one_company_result_submit" } });
    cleanup.push(async () => { await handle.stop(); handle.dispose(); });
    return { handle, provider, run };
  }
  return { repo, home, repoId, clock, shells, gate, store, runtime, role };
}

test("真实SDK连接故障只暂停受影响角色，同批独立角色正常完成", async () => {
  const w = await world();
  const network = await w.role([{ type: "error", message: "fetch failed: connection reset (network)" }]);
  const normal = await w.role([{ type: "toolcall", name: "one_company_result_submit", input: {} }, { type: "text", text: "独立只读结果" }]);
  network.handle.prompt("触发连接故障"); normal.handle.prompt("不依赖其他角色");
  await until(() => network.handle.state() === "paused"); await normal.handle.result();
  expect(normal.handle.state()).toBe("completed"); expect(w.gate.canProceed(network.run.id)).toBe(false);
  expect(w.gate.canProceed(normal.run.id)).toBe(true);
  await delay(100); expect(network.provider.requests).toHaveLength(1); expect(normal.provider.requests).toHaveLength(1);
}, 20000);

test("连接故障当作按了暂停：运行记录写成 paused 并计暂停时间，按 resume 原地恢复后继续请求模型", async () => {
  const cleanups: Array<() => unknown | Promise<unknown>> = []; cleanup.push(async () => { for (const fn of cleanups.reverse()) await fn(); });
  const w = await createPmRunWorld(cleanups);
  const before = w.provider.requests.length;
  w.provider.queue.push({ type: "error", message: "fetch failed: connection reset (network)" });
  expect(await w.manager.messagePm({ requirementId: w.fixture.requirementId, text: "继续" })).toEqual({ delivered: "now" });
  await until(async () => { const run = await w.runStore.get(w.pm.runId); return run.ok && run.run.state === "paused"; });
  const paused = await w.runStore.get(w.pm.runId);
  expect(paused.ok && paused.run.pausedAt).toEqual(expect.any(String));
  expect((await w.manager.status(w.pm.runId))).toMatchObject({ ok: true, run: { state: "paused" } });
  expect(await w.manager.messagePm({ requirementId: w.fixture.requirementId, text: "断网期间的消息" })).toEqual({ delivered: "after_resume" });
  await delay(100); expect(w.provider.requests).toHaveLength(before + 1);
  w.provider.queue.push({ type: "text", text: "网络恢复后继续" });
  expect(await w.manager.resume(w.pm.runId)).toEqual({ state: "running" });
  await until(() => w.provider.requests.length === before + 2);
  expect(JSON.stringify(w.provider.requests.at(-1)?.messages.at(-1))).toContain("断网期间的消息");
  const resumed = await w.runStore.get(w.pm.runId);
  expect(resumed.ok && resumed.run.state).toBe("running");
  expect(resumed.ok && resumed.run.pausedAt).toBeUndefined();
  expect(resumed.ok && resumed.run.pausedMs).toBeGreaterThan(0);
}, 30000);

test("服务商断流、连接被中断等瞬时错误由 SDK 有限次重试后继续，不判失败也不转网络暂停", async () => {
  const w = await world();
  const flaky = await w.role([{ type: "error", message: "OpenAI Responses stream ended before a terminal response event" }, { type: "error", message: "terminated" },
    { type: "toolcall", name: "one_company_result_submit", input: {} }, { type: "text", text: "重试后完成" }]);
  flaky.handle.prompt("遇到断流");
  await flaky.handle.result();
  expect(flaky.handle.state()).toBe("completed");
  expect(flaky.provider.requests).toHaveLength(3);
  expect(w.gate.canProceed(flaky.run.id)).toBe(true);
}, 30000);

test("真实SDK认证、额度、业务错误均failed且保留真实原因，不误分类为网络暂停", async () => {
  const w = await world();
  for (const message of ["unauthorized: invalid api key supplied", "quota exceeded for this billing period", "请求参数不合法，缺少必填字段"]) {
    const s = await w.role([{ type: "error", message }]); s.handle.prompt("分类测试");
    await expect(s.handle.result()).rejects.toThrow(message); expect(s.handle.state()).toBe("failed");
    expect(w.gate.canProceed(s.run.id)).toBe(true); expect(s.provider.requests).toHaveLength(1);
  }
}, 20000);

test("daemon空闲计时不因注入五分钟睡眠时钟跳变提前退出", async () => {
  const fixture = await createDaemonFixture(); cleanup.push(() => removeDaemonFixture(fixture));
  const skewFile = join(fixture.home.home, "clock-skew.json"); await writeFile(skewFile, "0");
  const handle = await startDaemonForTest(fixture, { idleTimeoutMs: 3000, clockSkewFile: skewFile }); cleanup.push(() => killDaemon(handle));
  await delay(500); await writeFile(skewFile, String(5 * 60 * 1000)); await delay(500);
  expect(handle.proc.exitCode).toBeNull(); expect(handle.proc.signalCode).toBeNull();
}, 15000);

test("60秒后台Shell超时不因五分钟睡眠跳变失效", async () => {
  const time = createFakeTimeSource(), clock = createClock({ timeSource: time }); cleanup.push(() => clock.stopGapWatcher());
  const shells = new ShellRegistry({ clock });
  const spawned = await shells.spawn({ taskId: uuidv7(), host: { kind: "main", id: "sleep-test" }, command: process.execPath, args: ["-e", "setInterval(()=>{},1000)"], mode: "background", timeoutSeconds: 60, runToken: uuidv7() });
  if (!spawned.ok) throw new Error(spawned.reason);
  cleanup.push(async () => { await withClockPump(time, () => shells.stop(spawned.task.taskId)); expect(() => process.kill(spawned.task.pid, 0)).toThrow(); });
  time.jump(5 * 60000); await delay(50);
  expect(shells.get(spawned.task.taskId)?.status).not.toBe("timed_out");
}, 15000);
