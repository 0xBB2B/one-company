import { afterEach, describe, expect, test, vi } from "vitest";
import { readFile, writeFile, mkdir, readdir, chmod, stat, symlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { RunManager, registerProtocolHandlers } from "../daemon/run-manager.ts";
import { RelayQueue } from "../daemon/relay-queue.ts";
import { RunStore, type RunState, type RunRecord } from "../runtime/run-store.ts";
import { ShellRegistry, type ShellRegistryProbes } from "../runtime/shell-registry.ts";
import { createClock } from "../runtime/clock.ts";
import { NetworkPauseGate, toValidHostUrl } from "../runtime/network-pause.ts";
import { repositoryDatabase, withDatabase, putRecord, uuidv7 } from "../runtime/database.ts";
import { overlaps } from "../runtime/ranges.ts";
import { authenticateTestClient, createDaemonFixture, removeDaemonFixture, startDaemonForTest, killDaemon, connectTestClient, connectRawClient } from "./helpers/daemon-harness.ts";
import { modelProviderEnv, writeTestModelProviders, readProviderRequestsLog } from "./helpers/daemon-model-fixture.ts";

const SECRET = "RUN_OLD_BODY_不能补进模型上下文";
const REQUIREMENT = "2026-09-09.retired-manager";
const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const fn of cleanup.splice(0).reverse()) await fn(); });
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => Promise<boolean> | boolean, timeout = 5000) { const end = Date.now() + timeout; while (!await check()) { if (Date.now() > end) throw new Error("测试等待条件超时"); await delay(25); } }
function alive(pid: number) { try { process.kill(pid, 0); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; } }
async function world(probes?: ShellRegistryProbes) {
  const fixture = await createDaemonFixture(); cleanup.push(() => removeDaemonFixture(fixture));
  const database = repositoryDatabase(fixture.dataRoot, fixture.repoId); const clock = createClock(); cleanup.push(() => clock.stopGapWatcher());
  const runs = new RunStore({ dataRoot: fixture.dataRoot, repoId: fixture.repoId, daemonStartedAt: "historical" });
  const shells = new ShellRegistry({ clock, database, probes }); cleanup.push(async () => { for (const task of shells.list()) { const result = await shells.stop(task.taskId); if (alive(task.pid)) throw new Error(`测试进程未清理 ${task.pid}: ${JSON.stringify(result)}`); } });
  const gate = new NetworkPauseGate(); const deliver = vi.fn(async () => []); const inject = vi.fn(); const emit = vi.fn(); const selectModel = vi.fn(() => { throw new Error("不应选择模型"); }); const modelAccess = vi.fn(() => { throw new Error("不应构造模型上下文"); });
  const relay = new RelayQueue({ dataDir: join(fixture.dataRoot, "repos", fixture.repoId), deliver, locateRequirementAgent: () => ({ inject }) });
  const options = { dataRoot: fixture.dataRoot, repoId: fixture.repoId, runStore: runs, shellRegistry: shells, networkGate: gate, relayQueue: relay, roleCatalog: [], runtime: new Proxy({}, { get: modelAccess }) as any, selectModel, clock, workspaceRepoIds: [fixture.repoId], emit };
  const manager = new RunManager(options); manager.markStarted();
  const snapshot = () => withDatabase(database, (db) => JSON.stringify({ runs: db.list("runs"), sessions: db.list("sessions"), questions: db.list("relay_questions") }));
  async function create(state: RunState = "queued", parent?: RunRecord, provider = "provider-a") {
    const run = await runs.create({ kind: parent ? "role" : "requirement", role: parent ? "pi-company.worker" : undefined, parentRunId: parent?.id, requirement: parent?.requirement ?? `${REQUIREMENT}-${uuidv7()}`, task: SECRET, cwd: fixture.repo.root, writePaths: ["src"], readPaths: [], model: { provider, id: "test" }, thinking: "off", mcp: [], pendingDispatch: { instructions: SECRET }, reportPath: join(fixture.repo.root, "must-not-create.md") });
    // 无授权的历史记录夹具，不经过会话工厂或重新启动入口。
    withDatabase(database, (db) => { const r = db.read<any>("runs", run.id)!; db.update("runs", run.id, r.version, { ...r.data, state, stateReason: SECRET, result: { verdict: "PASS", body: SECRET }, commands: [SECRET] }); });
    const result = await runs.get(run.id); if (!result.ok) throw new Error("夹具记录损坏"); return result.run;
  }
  async function spawn(run: RunRecord, script = "setInterval(()=>{},1000)") {
    const result = await shells.spawn({ taskId: uuidv7(), host: { kind: "role", id: run.id, role: run.role, runId: run.id }, command: process.execPath, args: ["-e", script], cwd: fixture.repo.root, mode: "background", runToken: run.shellToken });
    if (!result.ok) throw new Error(result.reason); expect(result.task.pid).toBeGreaterThan(1); expect(result.task.identityVerified).toBe(true); expect(alive(result.task.pid)).toBe(true); return result.task;
  }
  return { fixture, database, clock, runs, shells, gate, relay, manager, options, snapshot, create, spawn, emit, deliver, selectModel, modelAccess, inject };
}
function handlers(w: Awaited<ReturnType<typeof world>>) {
  const map = new Map<string, (p: any, c?: any) => Promise<any>>(); registerProtocolHandlers({ manager: w.manager, relayQueue: w.relay, shellRegistry: w.shells, server: { registerHandler: (n: string, f: any) => map.set(n, f), markHandlersReady() {} } as any }); return map;
}

describe("运行执行器永久淘汰", () => {
  test.each(["queued", "running", "pausing", "paused", "paused_network", "waiting_answer", "completed", "failed", "stopped", "interrupted"] as RunState[])("R01 %s 历史运行不能单个、批量、网络恢复，也不新增运行或模型请求", async (state) => {
    const w = await world(); const run = await w.create(state); const before = w.snapshot();
    await expect(w.manager.dispatchRequirement({ requirement: run.requirement, cwd: w.fixture.repo.root })).rejects.toThrow("永久淘汰");
    await expect(w.manager.dispatchReview({ requirement: run.requirement, cwd: "/other-repo", baseline: "HEAD", snapshot: { head: "old", fingerprint: "old" } })).rejects.toThrow("永久淘汰");
    await expect(w.manager.resume(run.id)).rejects.toThrow("永久淘汰"); await expect(w.manager.resumeAll()).rejects.toThrow("永久淘汰");
    expect(await w.manager.resumeInterrupted(run.id)).toMatchObject({ ok: false, confirmed: false, state }); await w.manager.resumeNetworkPaused("provider-a");
    expect(await w.manager.canRunInParallel({ cwd: w.fixture.repo.root, requirement: run.requirement, task: "T-2", writePaths: ["other"] })).toMatchObject({ ok: false });
    await expect(w.manager.verifyDelivery(run.id, run.requirement)).rejects.toThrow("永久淘汰");
    expect(w.manager.locateRequirementAgent(run.requirement)).toBeUndefined(); expect(w.snapshot()).toBe(before); expect(w.selectModel).not.toHaveBeenCalled(); expect(w.modelAccess).not.toHaveBeenCalled(); expect(w.emit).not.toHaveBeenCalled();
  });
  test("R02 不存在旧子派工、排队、idle、结果回填或会话注册入口", async () => {
    const w = await world();
    for (const key of ["registerSession", "dispatchRoleInternal", "startRoleRun", "scheduleWaitingTasks", "assertRepairAllowed", "resumeInterruptedLocked", "buildRequirementDispatch", "buildRequirementRelay"]) expect((w.manager as any)[key]).toBeUndefined();
    expect(await w.manager.resumeInterrupted(uuidv7())).toMatchObject({ ok: false, confirmed: false, state: "unknown" });
  });
  test("R03 status/list/activity 仅元数据，不输出旧任务、模型、命令、结果或错误正文", async () => {
    const w = await world(); const run = await w.create("failed"); const before = w.snapshot(); const map = handlers(w);
    for (const output of [await w.manager.status(run.id), await w.manager.list(), await map.get("subscribe.activity")!({})]) {
      expect(JSON.stringify(output)).not.toContain(SECRET); expect(JSON.stringify(output)).not.toContain("provider-a");
    }
    const status = await w.manager.status(run.id); expect(status).toMatchObject({ ok: true, run: { id: run.id, state: "failed" } });
    if (status.ok) for (const key of ["task", "result", "commands", "cwd", "shellToken", "pendingDispatch", "errorDetails"]) expect(status.run).not.toHaveProperty(key);
    await expect(w.manager.subscribeTranscript(run.id, 0, "window", () => true)).rejects.toThrow("永久淘汰"); expect(w.snapshot()).toBe(before);
  });
});

describe("暂停与等待不伪造进程确认", () => {
  test.each(["queued", "running", "pausing", "paused", "paused_network", "waiting_answer", "interrupted"] as RunState[])("R04 %s 没有内存会话不确认暂停，不更改记录", async (state) => {
    const w = await world(); const run = await w.create(state); const before = w.snapshot();
    expect(await w.manager.pause(run.id)).toMatchObject({ state, confirmed: false }); expect(w.snapshot()).toBe(before);
  });
  test("R05 pauseAll 只计顶层非终态且不重复孩子，终态暂停保持原事实", async () => {
    const w = await world(); const parent = await w.create("running"); await w.create("running", parent); const terminal = await w.create("failed");
    expect((await w.manager.pauseAll()).results).toEqual([{ runId: parent.id, state: "running", confirmed: false, reason: expect.any(String) }]);
    expect(await w.manager.pause(terminal.id)).toEqual({ state: "failed", confirmed: true }); await expect(w.manager.pause(uuidv7())).rejects.toThrow("不存在");
  });
  test("R06 wait 真实等待终态，超时返回当前态，未知运行拒绝", async () => {
    const w = await world(); const run = await w.create("running"); let settled = false;
    const waiting = w.manager.wait(run.id, 2000).then((v) => { settled = true; return v; }); await delay(120); expect(settled).toBe(false);
    await w.runs.update(run.id, { state: "failed" }); expect(await waiting).toEqual({ state: "failed" });
    const queued = await w.create(); const start = Date.now(); expect(await w.manager.wait(queued.id, 150)).toEqual({ state: "queued" }); expect(Date.now() - start).toBeGreaterThanOrEqual(100); expect(Date.now() - start).toBeLessThan(1000);
    await expect(w.manager.wait(uuidv7(), 1)).rejects.toThrow("不存在");
  });
});

describe("真实 Shell 停止、级联和身份", () => {
  test("R07 停止父子运行真实进程树，等待 leader/后代/进程组消失；无结果注入父模型", async () => {
    const w = await world(); const parent = await w.create("running"); const child = await w.create("running", parent); const pidFile = join(w.fixture.dataRoot, "child.pid");
    const p = await w.spawn(parent); const c = await w.spawn(child, `const {spawn}=require('node:child_process'); const fs=require('node:fs'); const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync(${JSON.stringify(pidFile)},String(c.pid));setInterval(()=>{},1000);`);
    await until(async () => { try { return Number(await readFile(pidFile, "utf8")) > 1; } catch { return false; } }); const descendant = Number(await readFile(pidFile, "utf8")); expect(alive(descendant)).toBe(true);
    const result = await w.manager.stop(parent.id); expect(result).toMatchObject({ state: "stopped", confirmed: true });
    for (const pid of [p.pid, c.pid, descendant, -p.pgid, -c.pgid]) expect(alive(pid)).toBe(false);
    expect(await w.runs.get(child.id)).toMatchObject({ ok: true, run: { state: "stopped" } }); expect(w.inject).not.toHaveBeenCalled(); expect(w.modelAccess).not.toHaveBeenCalled();
    expect(JSON.stringify(w.emit.mock.calls)).not.toContain(SECRET); expect(JSON.stringify(w.deliver.mock.calls)).not.toContain(SECRET);
  }, 15_000);
  test("R08 真实EPERM不报告确认，stopAll重试实际结束进程；并发终态不能换成completed", async () => {
    let denied = false;
    const w = await world({ kill(pid, signal) { if (denied) throw Object.assign(new Error(SECRET), { code: "EPERM" }); process.kill(pid, signal); } });
    const run = await w.create("running"); const task = await w.spawn(run); cleanup.push(() => { denied = false; }); denied = true;
    const first = await w.manager.stop(run.id);
    expect(first.confirmed).toBe(false); expect(alive(task.pid)).toBe(true); expect(first.reason).not.toContain(SECRET); expect(w.shells.get(task.taskId)?.status).toBe("uncertain");
    const blocked = await w.manager.stopAll(); expect(blocked.coverage).toMatchObject({ confirmed: 0, unconfirmed: 1 }); expect(blocked.coverage.shellUnconfirmed).toBeGreaterThan(0); expect(alive(task.pid)).toBe(true);
    denied = false;
    const retry = await w.manager.stopAll(); expect(retry.results).toContainEqual({ runId: run.id, state: "stopped", confirmed: true }); expect(retry.coverage).toMatchObject({ confirmed: 1, unconfirmed: 0, unknown: 0, shellUnconfirmed: 0 }); expect(alive(task.pid)).toBe(false);
    await expect(w.runs.update(run.id, { state: "completed" })).rejects.toThrow("状态转换"); expect(await w.manager.stop(run.id)).toMatchObject({ confirmed: true, state: "stopped" });
  }, 15_000);
  test("R09 Shell PID/startedAt 不匹配不发送停止，USER字符串裁定不能代替真实停止", async () => {
    const w = await world(); const run = await w.create("running"); const task = await w.spawn(run); const map = handlers(w); const stop = vi.spyOn(w.shells, "stop"); const mark = vi.spyOn(w.shells, "markStoppedByUser");
    const params = { taskId: task.taskId, expectedPid: task.pid, expectedStartedAt: String(task.startedAt) };
    for (const bad of [{ ...params, expectedPid: task.pid + 1 }, { ...params, expectedStartedAt: "0" }]) expect(await map.get("shells.stop")!(bad)).toMatchObject({ status: "mismatch" });
    await expect(map.get("shells.markStopped")!({ ...params, decisionId: "USER-001", actor: "user" })).rejects.toThrow("可信"); expect(stop).not.toHaveBeenCalled(); expect(mark).not.toHaveBeenCalled(); expect(alive(task.pid)).toBe(true);
    const list = await map.get("shells.list")!({}); expect(list.tasks[0]).toMatchObject({ pid: task.pid, identityVerified: true, command: "[旧命令正文不提供]", cwd: "[旧工作目录不提供]" });
    expect(["stopped", "exited"]).toContain((await map.get("shells.stop")!(params)).status); expect(alive(task.pid)).toBe(false);
    expect(await map.get("shells.stop")!({ ...params, taskId: "missing" })).toMatchObject({ status: "not_found" });
  }, 15_000);
  test("R10 真 PID 的身份核验失败保持 uncertain/未确认，修复探针后才可真实停止", async () => {
    const w = await world(); const run = await w.create("running"); const task = await w.spawn(run); const startedAt = task.startedAt!;
    const identity = vi.spyOn(w.shells as any, "baselineStartedAt").mockResolvedValue(startedAt + 1000);
    try { const result = await w.manager.stop(run.id); expect(result.confirmed).toBe(false); expect(w.shells.get(task.taskId)?.status).toBe("uncertain"); expect(alive(task.pid)).toBe(true); expect((await w.manager.list()).items.every((r) => r.state !== ("uncertain" as any))).toBe(true); }
    finally { identity.mockRestore(); }
    expect(await w.manager.stop(run.id)).toMatchObject({ confirmed: true }); expect(alive(task.pid)).toBe(false);
  }, 15_000);
  test("R11 stop Promise 在真实延迟退出前不确认，忽略TERM也能核实强杀结束", async () => {
    const w = await world(); const run = await w.create("running"); const ready = join(w.fixture.dataRoot, "ready");
    const task = await w.spawn(run, `process.on('SIGTERM',()=>setTimeout(()=>process.exit(0),400));require('node:fs').writeFileSync(${JSON.stringify(ready)},'ready');setInterval(()=>{},1000);`);
    await until(async () => { try { return await readFile(ready, "utf8") === "ready"; } catch { return false; } });
    let settled = false; const pending = w.manager.stop(run.id).then((r) => { settled = true; return r; }); await delay(100); expect(settled).toBe(false); expect(alive(task.pid)).toBe(true);
    expect(await pending).toMatchObject({ confirmed: true }); expect(alive(task.pid)).toBe(false);
    const other = await w.create("running"); const ready2 = join(w.fixture.dataRoot, "ready2"); const hard = await w.spawn(other, `process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(${JSON.stringify(ready2)},'ready');setInterval(()=>{},1000);`);
    await until(async () => { try { return await readFile(ready2, "utf8") === "ready"; } catch { return false; } }); expect(await w.manager.stop(other.id)).toMatchObject({ confirmed: true }); expect(alive(hard.pid)).toBe(false);
  }, 15_000);
  test("R12 close 清理无会话登记的真实 Shell，不以停止状态字段代替 PID 确认", async () => {
    const w = await world(); const a = await w.create("interrupted"); const task = await w.spawn(a); await w.manager.close(); expect(alive(task.pid)).toBe(false); expect(alive(-task.pgid)).toBe(false);
  }, 15_000);
  test("R13 接管历史 Shell 仅为安全停止，不恢复旧运行；接管失败只记原因", async () => {
    const w = await world(); const run = await w.create("interrupted"); const task = await w.spawn(run);
    const adopted = new ShellRegistry({ clock: w.clock, database: w.database }); const manager = new RunManager({ ...w.options, shellRegistry: adopted }); manager.markStarted();
    await manager.adoptInterruptedShells(); expect(adopted.get(task.taskId)).toMatchObject({ pid: task.pid, identityVerified: true });
    expect(await manager.resumeInterrupted(run.id)).toMatchObject({ ok: false, confirmed: false }); await manager.close(); expect(alive(task.pid)).toBe(false);
    vi.spyOn(adopted, "adoptOrphans").mockResolvedValue({ ok: false, reason: SECRET }); await manager.adoptInterruptedShells(); expect(await w.runs.get(run.id)).toMatchObject({ ok: true, run: { state: "interrupted", stateReason: "Shell 接管或进程结束尚未确认" } });
  }, 15_000);
});

describe("持久重查、只读元数据与完整停止覆盖", () => {
  test("R18 缺库list/status不创建库或目录，非法root/权限拒绝且不修改原库", async () => {
    const w = await world(); const dir = join(w.fixture.dataRoot, "repos", w.fixture.repoId);
    expect(existsSync(dir)).toBe(false);
    await expect(w.manager.list()).rejects.toThrow("运行元数据不可读"); await expect(w.manager.status(uuidv7())).rejects.toThrow("运行元数据不可读"); expect(existsSync(dir)).toBe(false);
    const run = await w.create("failed"); const before = w.snapshot(); const inode = (await stat(w.database)).ino;
    await chmod(w.database, 0o644);
    try { await expect(w.manager.list()).rejects.toThrow("运行元数据不可读"); expect((await stat(w.database)).mode & 0o777).toBe(0o644); } finally { await chmod(w.database, 0o600); }
    expect(() => new RunManager({ ...w.options, dataRoot: "relative-root" })).toThrow("绝对路径");
    const alias = join(w.fixture.dataRoot, "alias-root"); await mkdir(join(alias, "repos"), { recursive: true, mode: 0o700 }); await symlink(dir, join(alias, "repos", w.fixture.repoId));
    const invalid = new RunManager({ ...w.options, dataRoot: alias }); invalid.markStarted();
    await expect(invalid.list()).rejects.toThrow("运行元数据不可读"); expect((await stat(w.database)).ino).toBe(inode); expect(w.snapshot()).toBe(before);
    expect(await w.manager.status(run.id)).toMatchObject({ ok: true, run: { id: run.id, state: "failed" } });
  });
  test("R19 合法身份/时间/父子metadata正例；坏key、时间及跨需求关联拒绝且保全", async () => {
    const w = await world(); const parent = await w.create("failed"); const child = await w.create("stopped", parent); const before = w.snapshot();
    const probe = vi.spyOn(w.shells, "adoptOrphans");
    expect(await w.manager.status(child.id)).toMatchObject({ ok: true, run: { id: child.id, parentRunId: parent.id, requirement: parent.requirement, startedAt: child.startedAt, turns: 0 } });
    expect((await w.manager.list()).coverage).toMatchObject({ returned: 2, unknown: 0, unconfirmed: 2 }); expect(probe).not.toHaveBeenCalled(); expect(w.snapshot()).toBe(before);
    for (const fields of [{ startedAt: SECRET }, { updatedAt: "2026-02-30T00:00:00.000Z" }, { endedAt: SECRET }, { turns: Number.MAX_SAFE_INTEGER + 1 }, { requirement: "2026-13-45.invalid" }, { parentRunId: child.id }, { parentRunId: uuidv7() }, { requirement: uuidv7() }]) {
      withDatabase(w.database, (db) => { const r = db.read<any>("runs", child.id)!; db.update("runs", child.id, r.version, { ...child, ...fields }); });
      const bad = w.snapshot();
      await expect(w.manager.list()).rejects.toThrow("运行元数据不可读"); await expect(w.manager.status(child.id)).rejects.toThrow("运行元数据不可读"); expect(w.snapshot()).toBe(bad);
    }
    withDatabase(w.database, (db) => { const r = db.read<any>("runs", child.id)!; db.update("runs", child.id, r.version, child); db.create("runs", SECRET, { body: SECRET }); });
    const corrupted = w.snapshot(); const map = handlers(w);
    await expect(map.get("runs.list")!({ limit: 1 })).rejects.toThrow("运行元数据不可读");
    try { await w.manager.list(); } catch (error) { expect(String(error)).not.toContain(SECRET); }
    expect(await w.manager.status(SECRET)).toEqual({ ok: false, reason: "not_found" }); expect(w.snapshot()).toBe(corrupted); expect(probe).not.toHaveBeenCalled();
  });
  test("R20 limit至多100且coverage明确页外未确认；stopAll实际停止展示页外运行", async () => {
    const w = await world({ ps: async () => [] }); const template = await w.create("stopped"); const ids: string[] = [];
    withDatabase(w.database, (db) => db.transaction(() => { for (let i = 0; i < 105; i++) { const id = uuidv7(); ids.push(id); db.create("runs", id, { ...template, id, shellToken: id }, id); } }));
    const initial = await w.manager.stopAll(); const omitted = ids.find((id) => !initial.results.some((r) => r.runId === id)); expect(omitted).toBeDefined();
    const last = await w.runs.get(omitted!); if (!last.ok) throw new Error("夹具缺失"); const task = await w.spawn(last.run); const before = w.snapshot(); const probe = vi.spyOn(w.shells, "adoptOrphans");
    const page = await w.manager.list({ limit: 3, offset: 1 }); expect(page.items).toHaveLength(3); expect(page.coverage).toMatchObject({ total: 106, returned: 3, offset: 1, remaining: 102, unconfirmed: 106, unconfirmedOutsidePage: 103, truncated: true });
    const activity = await handlers(w).get("subscribe.activity")!({}); expect(activity.snapshot.length).toBeLessThanOrEqual(100); expect(activity.coverage).toMatchObject({ total: 106, unconfirmed: 106, truncated: true });
    for (const result of [page, activity]) expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(16384);
    for (const limit of [0, -1, 1.5, 101, Number.MAX_SAFE_INTEGER]) await expect(w.manager.list({ limit })).rejects.toThrow();
    expect(probe).not.toHaveBeenCalled(); expect(w.snapshot()).toBe(before); expect(alive(task.pid)).toBe(true);
    const stopped = await w.manager.stopAll(); expect(stopped.results.length).toBeLessThanOrEqual(100); expect(stopped.results.some((r) => r.runId === last.run.id)).toBe(false);
    expect(stopped.coverage).toMatchObject({ total: 106, confirmed: 106, unconfirmed: 0, unknown: 0, shellUnconfirmed: 0, truncated: true }); expect(alive(task.pid)).toBe(false); expect(alive(-task.pgid)).toBe(false);
    expect(Buffer.byteLength(JSON.stringify(stopped))).toBeLessThanOrEqual(16384);
  }, 30_000);
  test("R21 空接管表不是停止证明；旧terminal重查持久Shell，恢复真实探针后重试", async () => {
    const w = await world(); const run = await w.create("stopped"); const task = await w.spawn(run);
    let unavailable = true;
    const adopted = new ShellRegistry({ clock: w.clock, database: w.database, probes: { ps: async () => [], pidStartedAt: async (pid) => {
      if (unavailable) return null;
      try { const timestamp = Date.parse(execFileSync("/bin/ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } }).trim()); return Number.isFinite(timestamp) ? timestamp : null; } catch { return null; }
    } } });
    const manager = new RunManager({ ...w.options, shellRegistry: adopted }); manager.markStarted();
    const before = withDatabase(w.database, (db) => db.list("shells"));
    expect(await manager.pause(run.id)).toMatchObject({ state: "stopped", confirmed: false }); expect(await manager.stop(run.id)).toMatchObject({ state: "stopped", confirmed: false });
    expect(adopted.list()).toHaveLength(0); expect((await manager.stopAll()).coverage).toMatchObject({ confirmed: 0, unconfirmed: 1 }); await expect(manager.close()).rejects.toThrow("关闭未完成"); expect(alive(task.pid)).toBe(true); expect(withDatabase(w.database, (db) => db.list("shells"))).toEqual(before);
    unavailable = false;
    expect(await manager.stop(run.id)).toMatchObject({ confirmed: true }); expect(alive(task.pid)).toBe(false); expect(adopted.get(task.taskId)).toMatchObject({ pid: task.pid, startedAt: task.startedAt, identityVerified: true, activity: "ended" }); await manager.close();
  }, 15_000);
  test("R22 close EPERM失败不吞且继续停止其他进程，解除故障可重试", async () => {
    let deniedPid = 0; const w = await world({ kill(pid, signal) { if (Math.abs(pid) === deniedPid) throw Object.assign(new Error(SECRET), { code: "EPERM" }); process.kill(pid, signal); } });
    const a = await w.create("interrupted"); const b = await w.create("failed"); const blocked = await w.spawn(a); const healthy = await w.spawn(b); cleanup.push(() => { deniedPid = 0; }); deniedPid = blocked.pid;
    await expect(w.manager.close()).rejects.toMatchObject({ code: "stop_unconfirmed", message: expect.not.stringContaining(SECRET) }); expect(alive(blocked.pid)).toBe(true); expect(alive(healthy.pid)).toBe(false);
    expect(w.shells.get(blocked.taskId)?.status).toBe("uncertain"); deniedPid = 0; await w.manager.close(); expect(alive(blocked.pid)).toBe(false);
  }, 15_000);
  test.each([
    { label: "EPERM持续", release: false },
    { label: "故障解除", release: true },
  ])("R23 $label：USER标记不证明停止，stopAll按真实信号和探活更新coverage", async ({ release }) => {
    let deniedPid = 0; const attempts: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const w = await world({ ps: async () => [], kill(pid, signal) {
      if (signal !== 0) attempts.push({ pid, signal });
      if (Math.abs(pid) === deniedPid) throw Object.assign(new Error(SECRET), { code: "EPERM" });
      process.kill(pid, signal);
    } });
    const run = await w.create("stopped"); const task = await w.spawn(run);
    cleanup.push(async () => {
      deniedPid = 0;
      if (alive(task.pid) || alive(-task.pgid)) process.kill(-task.pgid, "SIGKILL");
      await until(() => !alive(task.pid) && !alive(-task.pgid));
    });
    deniedPid = task.pid;
    expect(await w.manager.stop(run.id)).toMatchObject({ state: "stopped", confirmed: false });
    expect(w.shells.get(task.taskId)).toMatchObject({ status: "uncertain", identityVerified: true, descendantsScanned: true });
    deniedPid = 0;
    expect(w.shells.markStoppedByUser(task.taskId, { decisionId: "USER-001" })).toMatchObject({ ok: true });
    const attemptsBeforeUserChecks = attempts.length;
    expect(await w.manager.stop(run.id)).toMatchObject({ state: "stopped", confirmed: false });
    expect(await w.manager.pause(run.id)).toMatchObject({ state: "stopped", confirmed: false });
    expect(attempts).toHaveLength(attemptsBeforeUserChecks); expect(alive(task.pid)).toBe(true); expect(alive(-task.pgid)).toBe(true);

    const other = await w.create("running"); const healthy = await w.spawn(other);
    putRecord({ database: w.database, namespace: "runs", key: SECRET }, { body: SECRET });
    if (!release) deniedPid = task.pid;
    const result = await w.manager.stopAll();
    expect(result.coverage.unknown).toBeGreaterThan(0); expect(result.coverage.unconfirmed).toBeGreaterThan(0);
    expect(result.results).toContainEqual({ runId: other.id, state: "stopped", confirmed: false, reason: "子运行停止失败" });
    expect(alive(healthy.pid)).toBe(false); expect(alive(-healthy.pgid)).toBe(false);
    expect(w.shells.get(healthy.taskId)).toMatchObject({ status: "stopped", stoppedBy: "signal", identityVerified: true, descendantsScanned: true, activity: "ended" });
    expect(attempts).toContainEqual({ pid: -healthy.pgid, signal: "SIGTERM" }); expect(JSON.stringify(result)).not.toContain(SECRET);

    const userTask = w.shells.get(task.taskId);
    if (release) {
      expect(result.coverage.shellUnconfirmed).toBe(0); expect(alive(task.pid)).toBe(false); expect(alive(-task.pgid)).toBe(false);
      expect(userTask).toMatchObject({ status: "stopped", stoppedBy: "signal", identityVerified: true, descendantsScanned: true, activity: "ended" });
      expect(attempts).toContainEqual({ pid: -task.pgid, signal: "SIGTERM" });
    } else {
      expect(result.coverage.shellUnconfirmed).toBeGreaterThan(0); expect(alive(task.pid)).toBe(true); expect(alive(-task.pgid)).toBe(true);
      expect(userTask).toMatchObject({ status: "uncertain", stoppedBy: "user", identityVerified: true, descendantsScanned: true });
    }

    let closeError: unknown;
    try { await w.manager.close(); } catch (error) { closeError = error; }
    expect(closeError).toBeInstanceOf(Error); expect((closeError as Error).message).toContain("关闭未完成"); expect((closeError as Error).message).not.toContain(SECRET);
    expect(await w.runs.get(run.id)).toMatchObject({ ok: true, run: { id: run.id, state: "stopped" } });
    expect(withDatabase(w.database, (db) => db.read("runs", SECRET))).not.toBeNull();
  }, 15_000);
});

describe("网络、版本及重启不能产生旧执行权限", () => {
  test("R14 网络按运行区分手动暂停；任意 provider 恢复回调都不改变历史运行", async () => {
    const w = await world(); const a = await w.create("paused_network", undefined, "a"); const b = await w.create("paused_network", undefined, "b"); const manual = await w.create("paused");
    w.gate.requestPause(a.id, "network"); w.gate.requestPause(b.id, "network"); w.gate.requestPause(manual.id, "manual"); const before = w.snapshot();
    for (const provider of ["a", "b", "", undefined]) await w.manager.resumeNetworkPaused(provider as any);
    expect(w.snapshot()).toBe(before); expect(w.gate.listPaused()).toHaveLength(3); w.gate.resume(a.id); expect(w.gate.canProceed(b.id)).toEqual({ allowed: false, reason: "network" }); expect(w.gate.canProceed(manual.id)).toEqual({ allowed: false, reason: "manual" });
    expect(w.snapshot()).toBe(before); expect(w.emit).not.toHaveBeenCalled(); expect(w.modelAccess).not.toHaveBeenCalled();
    expect(toValidHostUrl("http://user:pass@evil.invalid/path")).toBeNull(); expect(toValidHostUrl("file:///tmp/a")).toBeNull(); expect(toValidHostUrl("https://example.invalid/v1")?.protocol).toBe("https:");
  });
  test("R15 真实 RunStore 并发版本不丢 turn，身份/token不能改写；范围规整保护仍独立有效", async () => {
    const w = await world(); const run = await w.create("running"); await Promise.all(Array.from({ length: 8 }, () => w.runs.recordTurn(run.id)));
    expect(await w.runs.get(run.id)).toMatchObject({ ok: true, run: { turns: 8, shellToken: run.shellToken } }); await expect(w.runs.update(run.id, { shellToken: "forged" } as any)).rejects.toThrow("shellToken");
    expect(overlaps("./src/", "src/a.ts")).toBe(true); expect(overlaps("src/", "other/a.ts")).toBe(false);
    const stale = withDatabase(w.database, (db) => db.read<any>("runs", run.id)!); await w.runs.recordTurn(run.id);
    expect(() => withDatabase(w.database, (db) => db.update("runs", run.id, stale.version, stale.data))).toThrow(); expect(await w.runs.get(run.id)).toMatchObject({ ok: true, run: { turns: 9 } });
  });
  test("R16 真实 socket 两次 daemon 启动：旧会话/排队/待答不加载、不投递、不发模型请求", async () => {
    const w = await world(); const run = await w.create("queued"); const completed = await w.create("completed");
    const oldFile = join(w.fixture.dataRoot, "old-session.jsonl"); await writeFile(oldFile, SECRET, { mode: 0o600 });
    // 测试自产的无授权旧会话，含待结算工具调用；重启不得补写结果或读取它续跑。
    const sessionId = uuidv7(); const entryId = uuidv7();
    putRecord({ database: w.database, namespace: "sessions", key: run.id }, { cwd: w.fixture.repo.root, header: { type: "session", version: 3, id: sessionId, timestamp: "2026-01-01T00:00:00Z", cwd: w.fixture.repo.root }, leafId: entryId });
    withDatabase(w.database, (db) => db.append(`session:${run.id}`, { type: "message", id: entryId, parentId: sessionId, message: { role: "assistant", content: [{ type: "text", text: SECRET }, { type: "toolCall", id: "old-call", name: "pi_company_agent", arguments: { action: "run", instructions: SECRET } }] } }));
    const sessionEvents = () => withDatabase(w.database, (db) => db.events(`session:${run.id}`)); const eventsBefore = sessionEvents();
    const legacyDir = join(w.fixture.repo.root, ".pi-company", "requirements", run.requirement); await mkdir(legacyDir, { recursive: true }); await writeFile(join(legacyDir, "spec.md"), SECRET, { mode: 0o600 });
    putRecord({ database: w.database, namespace: "relay_questions", key: uuidv7() }, { ...{ id: uuidv7(), requirement: run.requirement, repoId: w.fixture.repoId, runId: run.id, status: "pending", question: SECRET, options: [], recommended: "确认", createdAt: "old" } });
    const providers = await writeTestModelProviders(w.fixture.dataRoot, [{ providerId: "provider-a", modelId: "test", roleName: "requirement-agent", replies: [{ type: "text", text: SECRET }] }]);
    const log = join(w.fixture.dataRoot, "requests.jsonl"); await writeFile(log, "", { mode: 0o600 });
    const sessionsBefore = withDatabase(w.database, (db) => db.list("sessions"));
    for (let i = 0; i < 2; i++) {
      const handle = await startDaemonForTest(w.fixture, { extraEnv: modelProviderEnv(providers, log) }); cleanup.push(async () => { if (handle.proc.exitCode === null && handle.proc.signalCode === null) await killDaemon(handle); });
      const raw = await connectRawClient(w.fixture.socketPath); cleanup.push(() => raw.close()); const events: unknown[] = [];
      for (const name of ["relay.question", "relay.notice"]) raw.onEvent(name, (d) => events.push(d));
      await authenticateTestClient(raw, { windowId: "window", pid: process.pid, sessionId: "session", cwd: w.fixture.repo.root, workspaceRoot: w.fixture.repo.root, repoIds: [w.fixture.repoId] }, { dataRoot: w.fixture.dataRoot, expectedRepoId: w.fixture.repoId });
      expect(await raw.call("runs.get", { runId: run.id })).toMatchObject({ run: { state: "interrupted" } }); expect(await raw.call("runs.get", { runId: completed.id })).toMatchObject({ run: { state: "completed" } });
      const before = w.snapshot();
      for (const [method, params] of [["dispatch.requirement", { requirement: run.requirement, cwd: w.fixture.repo.root }], ["dispatch.review", { requirement: run.requirement, cwd: w.fixture.repo.root, baseline: "HEAD", snapshot: { head: "old", fingerprint: "old" } }], ["runs.resume", { runId: run.id }], ["runs.resumeAll", {}], ["runs.resumeInterrupted", { runId: run.id }], ["relay.answer", { questionId: uuidv7(), answer: "USER-001", windowId: "window" }], ["relay.forward", { requirement: run.requirement, message: SECRET, windowId: "window" }], ["subscribe.transcript", { runId: run.id, fromSeq: 0 }]] as Array<[string, any]>) await expect(raw.call(method, params)).rejects.toThrow("legacy_workflow_retired");
      expect(await raw.call("relay.pending")).toEqual({ questions: [], notices: [] }); expect(JSON.stringify(await raw.call("runs.list", { limit: 100 }))).not.toContain(SECRET);
      await delay(1150); expect(events).toEqual([]); expect(await readProviderRequestsLog(log)).toEqual([]); expect(w.snapshot()).toBe(before);
      raw.close(); await killDaemon(handle);
    }
    expect(withDatabase(w.database, (db) => db.list("sessions"))).toEqual(sessionsBefore); expect(sessionEvents()).toEqual(eventsBefore); expect(await readFile(oldFile, "utf8")).toBe(SECRET); expect(await readFile(join(legacyDir, "spec.md"), "utf8")).toBe(SECRET); expect(await readdir(w.fixture.repo.root)).not.toContain("must-not-create.md");
  }, 30_000);
  test("R17 socket 调用未 hello 不取得状态或执行权限", async () => {
    const w = await world(); const handle = await startDaemonForTest(w.fixture); cleanup.push(() => killDaemon(handle)); const raw = await connectRawClient(w.fixture.socketPath); cleanup.push(() => raw.close());
    await expect(raw.call("runs.list", { limit: 1 })).rejects.toThrow();
    const good = await connectTestClient(w.fixture.socketPath, { cwd: w.fixture.repo.root, repoIds: [w.fixture.repoId] }, { dataRoot: w.fixture.dataRoot }); cleanup.push(() => good.close()); expect(await good.call("runs.list", { limit: 1 })).toMatchObject({ items: [] });
  }, 15_000);
});
