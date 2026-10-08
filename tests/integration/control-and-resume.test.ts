import { afterEach, expect, test } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { connectTestClient, createDaemonFixture, killDaemon, removeDaemonFixture, startDaemonForTest } from "../helpers/daemon-harness.ts";
import { modelProviderEnv, readProviderRequestsLog, writeTestModelProviders } from "../helpers/daemon-model-fixture.ts";
import { RunStore } from "../../runtime/run-store.ts";
import type { RunRecord } from "../../runtime/run-store.ts";
import { repositoryDatabase, uuidv7, withDatabase } from "../../runtime/database.ts";
import { createSessionManagerForRun } from "../../runtime/session-records.ts";
import { createClock } from "../../runtime/clock.ts";
import { ShellRegistry } from "../../runtime/shell-registry.ts";

const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until<T>(read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
  for (let i = 0; i < 160; i++) { const value = await read(); if (ready(value)) return value; await delay(50); }
  throw new Error("真实进程/状态未在期限内收尾");
}
function alive(pid: number) { try { process.kill(pid, 0); return true; } catch { return false; } }

async function world(blockedStop?: { value: boolean }) {
  const fixture = await createDaemonFixture(); cleanup.push(() => removeDaemonFixture(fixture));
  const database = repositoryDatabase(fixture.dataRoot, fixture.repoId);
  const store = new RunStore({ dataRoot: fixture.dataRoot, repoId: fixture.repoId, daemonStartedAt: "历史数据夹具，不授予执行权限" });
  const clock = createClock(); cleanup.push(() => clock.stopGapWatcher());
  const shells = new ShellRegistry({ clock, database, probes: blockedStop ? { kill(pid, signal) {
    if (signal !== 0 && blockedStop.value) throw Object.assign(new Error("测试停止系统调用被拒绝"), { code: "EPERM" });
    process.kill(pid, signal);
  } } : undefined });
  cleanup.push(async () => {
    if (blockedStop) blockedStop.value = false;
    for (const task of shells.list()) { await shells.stop(task.taskId); expect(alive(task.pid)).toBe(false); }
  });
  const log = join(fixture.dataRoot, "requests.jsonl"); await writeFile(log, "");
  const scripts = await writeTestModelProviders(fixture.dataRoot, [{ providerId: "control-fixture", modelId: "test", replies: [{ type: "text", text: "不应恢复旧运行" }] }]);
  async function run(kind: "requirement" | "role" = "role", parentRunId?: string) {
    return store.create({ kind, standalone: true, role: "one-company.worker", parentRunId, requirement: "2026-09-10.control",
      task: "历史记录", cwd: fixture.repo.root, writePaths: ["README.md"], readPaths: [fixture.repo.root], model: { provider: "control-fixture", id: "test" }, thinking: "off", mcp: [],
      pendingDispatch: { instructions: "历史说明不能重新发给模型" } });
  }
  async function spawn(run: RunRecord) {
    const result = await shells.spawn({ taskId: uuidv7(), host: { kind: "role", id: run.id, runId: run.id, role: run.role },
      command: process.execPath, args: ["-e", "setInterval(()=>{},1000)"], cwd: fixture.repo.root, mode: "background", runToken: run.shellToken });
    if (!result.ok) throw new Error(result.reason); expect(alive(result.task.pid)).toBe(true); return result.task;
  }
  async function start() {
    const handle = await startDaemonForTest(fixture, { extraEnv: modelProviderEnv(scripts, log) }); cleanup.push(() => killDaemon(handle));
    const client = await connectTestClient(fixture.socketPath, { cwd: fixture.repo.root, workspaceRoot: fixture.repo.root, repoIds: [fixture.repoId] }); cleanup.push(() => client.close());
    await client.call("runs.list");
    return { handle, client };
  }
  const sessions = () => withDatabase(database, (db) => JSON.stringify(db.list("sessions").map((record) => ({ record, events: db.events(`session:${record.key}`) }))));
  const history = (run: RunRecord) => {
    createSessionManagerForRun({ dataRoot: fixture.dataRoot, repoId: fixture.repoId, runId: run.id, cwd: fixture.repo.root })
      .appendMessage({ role: "user", content: "测试历史 STEP-A-DONE-71539", timestamp: 1 });
  };
  return { fixture, store, shells, clock, run, spawn, start, log, database, sessions, history };
}

test("真实强杀重启后旧排队记录保持同一编号且内容不变，不创建会话或模型调用", async () => {
  const w = await world(); const run = await w.run();
  const first = await w.start();
  expect(await first.client.call("runs.get", { runId: run.id })).toMatchObject({ run: { state: "interrupted" } });
  first.client.close(); await killDaemon(first.handle);
  await w.start(); const before = await w.store.get(run.id);
  await delay(1150);
  expect(await w.store.get(run.id)).toEqual(before);
  expect((await w.store.list({ limit: 100 })).items.map((item) => item.id)).toEqual([run.id]);
  expect(w.sessions()).toBe("[]"); expect(await readProviderRequestsLog(w.log)).toEqual([]);
}, 30000);

test("跨窗口暂停不虚报确认；安全停止确认对应真实进程退出，旧恢复不重发上下文", async () => {
  const w = await world(); const run = await w.run(); await w.store.update(run.id, { state: "running" }); w.history(run);
  const task = await w.spawn(run); const a = await w.start();
  const b = await connectTestClient(w.fixture.socketPath, { windowId: "window-b", cwd: w.fixture.repo.root, workspaceRoot: w.fixture.repo.root, repoIds: [w.fixture.repoId] }); cleanup.push(() => b.close());
  const before = w.sessions();
  expect(await b.call("runs.pause", { runId: run.id })).toMatchObject({ confirmed: false });
  expect(alive(task.pid)).toBe(true);
  expect(await b.call("runs.stop", { runId: run.id })).toMatchObject({ state: "stopped", confirmed: true });
  expect(alive(task.pid)).toBe(false);
  expect(await a.client.call("runs.get", { runId: run.id })).toMatchObject({ run: { state: "stopped" } });
  await expect(b.call("runs.resume", { runId: run.id })).rejects.toThrow("not_resumable");
  await delay(1150); expect(w.sessions()).toBe(before); expect(await readProviderRequestsLog(w.log)).toEqual([]);
}, 30000);

test("终态运行pause幂等且保留原结果与状态", async () => {
  const w = await world(); const run = await w.run(); await w.store.update(run.id, { state: "running" });
  await w.store.update(run.id, { state: "completed", result: { verdict: "PASS", evidence: "历史结果不是新授权" } });
  const before = await w.store.get(run.id); const { client } = await w.start();
  expect(await client.call("runs.pause", { runId: run.id })).toEqual({ state: "completed", confirmed: true });
  expect(await w.store.get(run.id)).toEqual(before);
}, 20000);

test("父运行安全停止级联两个真实Shell子运行，确认进程退出后保留会话和文件", async () => {
  const w = await world(); const parent = await w.run("requirement"); const children = [await w.run("role", parent.id), await w.run("role", parent.id)];
  for (const run of [parent, ...children]) { await w.store.update(run.id, { state: "running" }); w.history(run); }
  const tasks = await Promise.all(children.map(w.spawn)); const { client } = await w.start(); const before = w.sessions();
  const source = await readFile(join(w.fixture.repo.root, "README.md"), "utf8");
  expect(await client.call("runs.stop", { runId: parent.id })).toMatchObject({ confirmed: true, state: "stopped" });
  for (const task of tasks) expect(alive(task.pid)).toBe(false);
  for (const run of [parent, ...children]) expect(await client.call("runs.get", { runId: run.id })).toMatchObject({ run: { state: "stopped" } });
  expect(w.sessions()).toBe(before); expect(await readFile(join(w.fixture.repo.root, "README.md"), "utf8")).toBe(source);
}, 30000);

test("真实重启接管本测试遗留Shell：身份不符不停止，正确停止后不新建会话、不调模型", async () => {
  const w = await world(); const run = await w.run(); await w.store.update(run.id, { state: "running" }); w.history(run);
  const task = await w.spawn(run); const first = await w.start(); first.client.close(); await killDaemon(first.handle);
  const second = await w.start(); const before = w.sessions();
  const list = await until(() => second.client.call("shells.list"), (value) => (value.tasks as Array<{ taskId: string }>).some((item) => item.taskId === task.taskId));
  expect(list.tasks).toEqual(expect.arrayContaining([expect.objectContaining({ taskId: task.taskId, identityVerified: true })]));
  const params = { taskId: task.taskId, expectedPid: task.pid, expectedStartedAt: String(task.startedAt) };
  expect(await second.client.call("shells.stop", { ...params, expectedPid: task.pid + 1 })).toMatchObject({ status: "mismatch" }); expect(alive(task.pid)).toBe(true);
  expect(await second.client.call("shells.stop", params)).toMatchObject({ status: "stopped" }); expect(alive(task.pid)).toBe(false);
  await delay(1150); expect(w.sessions()).toBe(before); expect(await readProviderRequestsLog(w.log)).toEqual([]);
}, 30000);

test("停止系统调用失败保持真实Shell uncertain；实际停止后才确认结束", async () => {
  const blockedStop = { value: false };
  const w = await world(blockedStop); const first = await w.run();
  await w.store.update(first.id, { state: "running" });
  const task = await w.spawn(first);
  await w.store.update(first.id, { state: "stopped", stateReason: "停止请求不证明进程结束" });
  expect(alive(task.pid)).toBe(true);
  blockedStop.value = true;
  const uncertain = await w.shells.stop(task.taskId);
  expect(uncertain).toMatchObject({ ok: true, task: { status: "uncertain", reason: "停止超时未确认" } });
  expect(alive(task.pid)).toBe(true);
  blockedStop.value = false;
  const stopped = await w.shells.stop(task.taskId); expect(stopped).toMatchObject({ ok: true, task: { status: "stopped" } });
  expect(alive(task.pid)).toBe(false);
  expect((await w.store.list({ limit: 100 })).items.some((run) => String(run.state) === "uncertain")).toBe(false);
}, 20000);
