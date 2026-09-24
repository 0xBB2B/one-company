import { afterEach, describe, expect, test } from "vitest";
import { spawn, execFileSync } from "node:child_process";
import { chmodSync, existsSync, statSync, mkdirSync, writeFileSync, unlinkSync, linkSync, readFileSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { RunManager, registerProtocolHandlers } from "../daemon/run-manager.ts";
import { DaemonServer } from "../daemon/server.ts";
import { RelayQueue } from "../daemon/relay-queue.ts";
import { ShellRegistry } from "../runtime/shell-registry.ts";
import type { ShellRegistryProbes } from "../runtime/shell-registry.ts";
import { createClock } from "../runtime/clock.ts";
import { NetworkPauseGate } from "../runtime/network-pause.ts";
import { daemonSocketPath, repositoryIdentity } from "../runtime/identity.ts";
import { controlToken } from "../runtime/daemon-auth.ts";
import { RunStore } from "../runtime/run-store.ts";
import { repositoryDatabase, withDatabase, uuidv7 } from "../runtime/database.ts";
import { readDecisions, inspectDecision, buildRecord, validateDecisionInput, nextDecisionId } from "../runtime/decisions.ts";
import { bindEvidence, checkEvidence, withLegacyReadDatabase } from "../runtime/workflow-state.ts";
import { createWorkflowTool, executeWorkflowAction } from "../runtime/workflow-tool.ts";
import { createDaemonFixture, removeDaemonFixture, connectTestClient } from "./helpers/daemon-harness.ts";

const REQ = "2026-09-08.safety";
const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function fixture(probes?: ShellRegistryProbes, quotedName = false) {
  const f = await createDaemonFixture(); cleanup.push(() => removeDaemonFixture(f));
  if (quotedName) {
    const original = { root: f.repo.root, repoId: f.repoId, repoDir: f.repoDir, socketPath: f.socketPath };
    const path = join(dirname(f.repo.root), '"'.repeat(120) + uuidv7().slice(-8));
    renameSync(f.repo.root, path); f.repo.root = path;
    const identity = await repositoryIdentity(path);
    f.repoId = identity.repoId; f.repoDir = identity.commonDir; f.socketPath = daemonSocketPath(f.dataRoot, f.repoId);
    cleanup.push(() => {
      renameSync(path, original.root);
      f.repo.root = original.root; f.repoId = original.repoId; f.repoDir = original.repoDir; f.socketPath = original.socketPath;
    });
  }
  const database = repositoryDatabase(f.dataRoot, f.repoId);
  withDatabase(database, () => {});
  const clock = createClock(); cleanup.push(() => clock.stopGapWatcher());
  const shells = new ShellRegistry({ database, clock, probes });
  const runs = new RunStore({ dataRoot: f.dataRoot, repoId: f.repoId, daemonStartedAt: "new" });
  const relay = new RelayQueue({ dataDir: join(f.dataRoot, "repos", f.repoId), deliver: async () => [], locateRequirementAgent: () => undefined });
  const manager = new RunManager({ dataRoot: f.dataRoot, repoId: f.repoId, runStore: runs, shellRegistry: shells, clock, relayQueue: relay,
    networkGate: new NetworkPauseGate(), roleCatalog: [], runtime: {} as any, selectModel: () => { throw new Error("不得选择模型"); }, workspaceRepoIds: [f.repoId], emit: () => {} });
  manager.markStarted();
  const create = () => new RunStore({ dataRoot: f.dataRoot, repoId: f.repoId, daemonStartedAt: "old" }).create({ kind: "role", standalone: true, role: "pi-company.worker", task: "T-1", requirement: REQ, cwd: f.repo.root, writePaths: [], readPaths: [], model: { provider: "test", id: "test" }, thinking: "off", mcp: [] });
  return { ...f, database, clock, shells, runs, manager, relay, create, ctx: { dataRoot: f.dataRoot, cwd: f.repo.root } };
}
async function socket(w: Awaited<ReturnType<typeof fixture>>) {
  mkdirSync(join(w.dataRoot, "sock"), { mode: 0o700 });
  const server = new DaemonServer({ authToken: controlToken(w.dataRoot), repoId: w.repoId, startedAt: new Date().toISOString() });
  registerProtocolHandlers({ server, manager: w.manager, shellRegistry: w.shells, relayQueue: w.relay });
  await server.listen(w.socketPath); cleanup.push(() => server.close());
  const client = await connectTestClient(w.socketPath, { cwd: w.repo.root, workspaceRoot: w.repo.root, repoIds: [w.repoId] }, { dataRoot: w.dataRoot }); cleanup.push(() => client.close());
  return client;
}
async function ownProcess() {
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { detached: true, stdio: "ignore" });
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
  const pid = child.pid!;
  cleanup.push(async () => { if (alive(pid)) process.kill(-pid, "SIGKILL"); await exited; expect(alive(pid)).toBe(false); });
  const startedAt = Date.parse(execFileSync("/bin/ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } }).trim());
  expect(Number.isFinite(startedAt)).toBe(true);
  return { pid, startedAt };
}
function state(requirement: string, stage = "draft", tasks = {}) { return { requirement, stage, tasks, history: [], followUps: [], shape: null }; }

describe("M4-LEGACY-RETIRE-01 F1—F6 实际安全矩阵", () => {
  test.each([
    { action: "stop", late: false, finalScanFailure: false }, { action: "close", late: false, finalScanFailure: false },
    { action: "stop", late: true, finalScanFailure: false }, { action: "close", late: true, finalScanFailure: false },
    { action: "stop", late: true, finalScanFailure: true }, { action: "close", late: true, finalScanFailure: true },
  ])("R1 $action：信号后新建=$late、末次扫描失败=$finalScanFailure 的逃逸后代必须核验", async ({ action, late, finalScanFailure }) => {
    let unavailable = !late;
    let failAfterSignal = finalScanFailure;
    let descendant = 0;
    let token = "";
    let pidFile = "";
    const w = await fixture({ ps: async () => {
      if (unavailable) throw new Error("scan unavailable");
      if (!descendant && pidFile && existsSync(pidFile)) descendant = Number(readFileSync(pidFile, "utf8"));
      if (failAfterSignal && descendant > 0) throw new Error("post-signal scan unavailable");
      if (!descendant || !alive(descendant)) return [];
      const columns = execFileSync("/bin/ps", ["-p", String(descendant), "-o", "pgid=,ppid=,lstart="], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } }).trim().split(/\s+/);
      return [{ pid: descendant, pgid: Number(columns[0]), ppid: Number(columns[1]), startedAt: Date.parse(columns.slice(2).join(" ")), token, command: "test descendant" }];
    } });
    const run = await w.create(); const taskId = uuidv7(); token = `${run.shellToken}:${taskId}`;
    pidFile = join(w.home.home, `descendant-${taskId}`);
    const readyFile = join(w.home.home, `ready-${taskId}`);
    const createDescendant = `const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore',env:process.env});child.unref();fs.writeFileSync(${JSON.stringify(pidFile)},String(child.pid));`;
    const script = `const {spawn}=require('node:child_process');const fs=require('node:fs');${late ? `process.on('SIGTERM',()=>{${createDescendant}process.exit(0)});` : createDescendant}fs.writeFileSync(${JSON.stringify(readyFile)},'ready');setInterval(()=>{},1000);`;
    const leader = spawn(process.execPath, ["-e", script], { detached: true, stdio: "ignore", env: { ...process.env, PI_COMPANY_SHELL_TOKEN: token } });
    const exited = new Promise<void>((resolve) => leader.once("exit", () => resolve()));
    cleanup.push(async () => {
      if (existsSync(pidFile)) descendant = Number(readFileSync(pidFile, "utf8"));
      if (descendant > 1 && alive(descendant)) process.kill(descendant, "SIGKILL");
      if (leader.pid && alive(leader.pid)) process.kill(-leader.pid, "SIGKILL");
      await exited;
      for (let n = 0; n < 200 && alive(descendant); n++) await new Promise((resolve) => setTimeout(resolve, 10));
      expect(alive(descendant)).toBe(false);
    });
    await new Promise<void>((resolve, reject) => { leader.once("spawn", resolve); leader.once("error", reject); });
    for (let n = 0; n < 200 && !existsSync(readyFile); n++) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(existsSync(readyFile)).toBe(true);
    if (!late) { descendant = Number(readFileSync(pidFile, "utf8")); expect(alive(descendant)).toBe(true); }
    const pid = leader.pid!;
    const startedAt = Date.parse(execFileSync("/bin/ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } }).trim());
    withDatabase(w.database, (db) => db.create("shells", taskId, { taskId, pid, pgid: pid, startedAt, token, host: { kind: "role", id: run.id, runId: run.id, role: run.role }, command: "test leader", cwd: w.repo.root }));
    if (late && !finalScanFailure) {
      if (action === "stop") expect(await w.manager.stop(run.id)).toMatchObject({ confirmed: true });
      else await w.manager.close();
      descendant = Number(readFileSync(pidFile, "utf8"));
      expect(descendant).toBeGreaterThan(1);
      expect(alive(pid)).toBe(false); expect(alive(descendant)).toBe(false);
      expect(withDatabase(w.database, (db) => db.read("shells", taskId))).toBeNull();
      return;
    }
    if (action === "stop") expect(await w.manager.stop(run.id)).toMatchObject({ confirmed: false });
    else await expect(w.manager.close()).rejects.toThrow("关闭未完成");
    expect(alive(descendant)).toBe(true);
    expect(withDatabase(w.database, (db) => db.read("shells", taskId))).not.toBeNull();
    // 模拟进程恢复时遇到已登记的旧终态，仍须核对同 token 的实际成员。
    const task = w.shells.get(taskId)!; task.status = "stopped"; task.activity = "ended";
    unavailable = false; failAfterSignal = false;
    expect(await w.manager.pause(run.id)).toMatchObject({ confirmed: false });
    expect(alive(descendant)).toBe(true);
    expect(await w.manager.stop(run.id)).toMatchObject({ confirmed: true });
    expect(alive(descendant)).toBe(false);
    await w.manager.close();
  }, 20_000);

  test("C1 只读回调拒绝Promise/thenable和后台延续，关闭捕获连接且不污染合法读取", async () => {
    const w = await fixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let raw: any; let delayedReadRejected = false; let delayedWriteRejected = false;
    let finished!: () => void;
    const done = new Promise<void>((resolve) => { finished = resolve; });
    expect(() => withLegacyReadDatabase(w.database, ((db: any) => {
      raw = db;
      return (async () => {
        await gate;
        try { db.prepare("SELECT 1").get(); } catch { delayedReadRejected = true; }
        try { withDatabase(w.database, (next) => next.create("probe", "late", {})); } catch { delayedWriteRejected = true; }
        finished(); throw new Error("late rejection must be consumed");
      })();
    }) as any)).toThrow();
    expect(() => raw.prepare("SELECT 1").get()).toThrow();
    release(); await done;
    expect(delayedReadRejected).toBe(true); expect(delayedWriteRejected).toBe(true);
    let thenCalled = false;
    expect(() => withLegacyReadDatabase(w.database, (() => ({ then(_resolve: unknown, reject: (error: Error) => void) { thenCalled = true; reject(new Error("thenable rejection")); } })) as any)).toThrow();
    expect(thenCalled).toBe(true);
    expect(withDatabase(w.database, (db) => db.read("probe", "late"))).toBeNull();
    expect(() => withLegacyReadDatabase(w.database, () => { throw new Error("sync failure"); })).toThrow();
    expect(withLegacyReadDatabase(w.database, (db) => Number(db.prepare("SELECT 1 AS n").get()!.n))).toBe(1);
  });

  test("F1 接管失败后stop/终态pause/stopAll/close均不能把活进程报已停", async () => {
    const w = await fixture({ pidStartedAt: async () => null, ps: async () => { throw new Error("probe ps denied"); } });
    const run = await w.create(); await w.runs.markInterruptedOnStartup();
    expect((await w.runs.get(run.id))).toMatchObject({ ok: true, run: { state: "interrupted" } });
    const process = await ownProcess(); const taskId = uuidv7();
    withDatabase(w.database, (db) => db.create("shells", taskId, { taskId, ...process, pgid: process.pid, token: `${run.shellToken}:${taskId}`, host: { kind: "role", id: run.id, role: run.role, runId: run.id }, command: "test-node", cwd: w.repo.root }));
    await w.manager.adoptInterruptedShells(); expect(w.shells.list()).toHaveLength(0);
    expect(await w.manager.stop(run.id)).toMatchObject({ confirmed: false });
    expect(await w.manager.pause(run.id)).toMatchObject({ confirmed: false });
    expect((await w.manager.stopAll()).results).toContainEqual(expect.objectContaining({ runId: run.id, confirmed: false }));
    await expect(w.manager.close()).rejects.toThrow();
    expect(alive(process.pid)).toBe(true);
    expect(withDatabase(w.database, (db) => db.list("shells"))).toHaveLength(1);
  });
  test("F2 close拒绝EPERM/uncertain而不是吞失败；真实进程保留可重试", async () => {
    let denied = true;
    const w = await fixture({ kill(pid, signal) { if (denied) throw Object.assign(new Error("probe EPERM body"), { code: "EPERM" }); process.kill(pid, signal); } });
    const taskId = uuidv7();
    const spawned = await w.shells.spawn({ taskId, host: { kind: "main", id: "safety" }, command: process.execPath, args: ["-e", "setInterval(()=>{},1000)"], cwd: w.repo.root, mode: "background", runToken: uuidv7() });
    if (!spawned.ok) throw new Error(spawned.reason);
    const pid = spawned.task.pid;
    cleanup.push(async () => { denied = false; await w.shells.stop(taskId); expect(alive(pid)).toBe(false); });
    await expect(w.manager.close()).rejects.toThrow();
    expect(w.shells.get(taskId)?.status).toBe("uncertain"); expect(alive(pid)).toBe(true);
    denied = false; await w.manager.close(); expect(alive(pid)).toBe(false);
  }, 15_000);
  test("F3 主窗口及直接动作不能以params.cwd切换到另一真实仓库", async () => {
    const a = await fixture(); const b = await fixture();
    for (const [w, stage] of [[a, "draft"], [b, "rejected"]] as const) withDatabase(w.database, (db) => db.create("requirements", REQ, state(REQ, stage)));
    const tool = createWorkflowTool({ dataRoot: b.dataRoot, cwd: a.repo.root });
    await expect(tool.execute("x", { action: "query", cwd: b.repo.root, requirement: REQ }, undefined, undefined, { cwd: a.repo.root })).rejects.toThrow();
    expect(await executeWorkflowAction({ action: "query", cwd: b.repo.root, requirement: REQ }, { dataRoot: b.dataRoot, cwd: a.repo.root })).toMatchObject({ ok: false });
    expect(await executeWorkflowAction({ action: "query", requirement: REQ }, a.ctx)).toMatchObject({ ok: true, details: { data: { stage: "draft" } } });
    const bound = createWorkflowTool({ ...a.ctx });
    await bound.execute("x", { action: "query", requirement: REQ }, undefined, undefined, a.ctx);
    execFileSync("git", ["checkout", "-b", "safety-branch"], { cwd: a.repo.root, stdio: "ignore" });
    await expect(bound.execute("x", { action: "query", requirement: REQ }, undefined, undefined, a.ctx)).rejects.toThrow("可信当前");
    const empty = join(a.repo.root, "empty-repo"); mkdirSync(empty, { mode: 0o700 });
    execFileSync("git", ["init", empty], { stdio: "ignore" });
    const identity = await repositoryIdentity(empty);
    withDatabase(repositoryDatabase(a.dataRoot, identity.repoId), (db) => db.create("requirements", REQ, state(REQ)));
    expect(await executeWorkflowAction({ action: "query", requirement: REQ }, { dataRoot: a.dataRoot, cwd: empty })).toMatchObject({ ok: true });
  });
  test("F4 缺库list/query不初始化；不chmod不安全库", async () => {
    const f = await createDaemonFixture(); cleanup.push(() => removeDaemonFixture(f));
    const database = repositoryDatabase(f.dataRoot, f.repoId); const ctx = { dataRoot: f.dataRoot, cwd: f.repo.root };
    for (const action of ["list", "query"]) { expect(await executeWorkflowAction({ action, requirement: REQ }, ctx)).toMatchObject({ ok: false }); expect(existsSync(database)).toBe(false); }
    withDatabase(database, (db) => db.create("requirements", REQ, state(REQ)));
    chmodSync(database, 0o644);
    expect(await executeWorkflowAction({ action: "list" }, ctx)).toMatchObject({ ok: false });
    expect(statSync(database).mode & 0o777).toBe(0o644);
    chmodSync(database, 0o600);
    const inode = statSync(database).ino;
    for (const marker of [".database-maintenance.json", ".database-recovery-required.json", ".database-snapshot.json"]) {
      const path = join(f.dataRoot, "repos", f.repoId, marker);
      writeFileSync(path, "{}", { mode: 0o600 });
      expect(await executeWorkflowAction({ action: "list" }, ctx)).toMatchObject({ ok: false });
      expect(statSync(database).ino).toBe(inode); unlinkSync(path);
    }
    const linked = join(f.dataRoot, "own-hardlink"); linkSync(database, linked);
    expect(await executeWorkflowAction({ action: "list" }, ctx)).toMatchObject({ ok: false }); unlinkSync(linked);
    expect(await executeWorkflowAction({ action: "list" }, ctx)).toMatchObject({ ok: true });
    expect(statSync(database).ino).toBe(inode);
  });
  test("F5 坏metadata key经真实socket只返回固定安全错误", async () => {
    const w = await fixture(); const secret = "OLD_DETAIL_KEY_未核对正文";
    withDatabase(w.database, (db) => db.create("runs", secret, { bad: true }));
    const client = await socket(w);
    let error: unknown; try { await client.call("runs.list", { limit: 10 }); } catch (e) { error = e; }
    expect(error).toBeDefined(); expect(String(error)).not.toContain(secret);
  });
  test("F5/F6 2000合法元数据与未知记录；小预算必须说明遗漏和未确认", async () => {
    const w = await fixture(); const template = await w.create();
    withDatabase(w.database, (db) => db.transaction(() => {
      for (let i = 0; i < 2000; i++) {
        const requirement = `2026-09-08.item-${i}`; db.create("requirements", requirement, state(requirement));
        const id = uuidv7(); db.create("runs", id, { ...template, id, requirement, state: i === 1999 ? "interrupted" : "stopped" }, id);
      }
      db.create("requirements", "UNCLASSIFIED_OLD_DETAIL_正文", state("UNCLASSIFIED_OLD_DETAIL_正文"));
    }));
    const list = await executeWorkflowAction({ action: "list", limit: 3 }, w.ctx);
    expect(list.ok).toBe(true); expect((list.details.items as unknown[]).length).toBeLessThanOrEqual(3);
    expect(JSON.stringify(list)).not.toContain("UNCLASSIFIED");
    expect(list.details.coverage).toMatchObject({ unknown: 1, truncated: true });
    const runs = await w.manager.list({ limit: 3 });
    expect(runs.items).toHaveLength(3); expect((runs as any).coverage).toMatchObject({ truncated: true, unconfirmedOutsidePage: 1998 });
    expect(Buffer.byteLength(JSON.stringify(runs))).toBeLessThanOrEqual(16_384);
    const client = await socket(w);
    const listed = await client.call("runs.list", { limit: 100 });
    expect(Buffer.byteLength(JSON.stringify(listed))).toBeLessThanOrEqual(16_384);
    expect((listed.items as unknown[]).length).toBeLessThanOrEqual(100);
    expect(listed.coverage).toMatchObject({ truncated: true });
    for (const limit of [0, -1, 1.5, Number.MAX_SAFE_INTEGER]) {
      expect(await executeWorkflowAction({ action: "list", limit }, w.ctx)).toMatchObject({ ok: false });
      await expect(w.manager.list({ limit })).rejects.toThrow();
    }
  });
  test("F1 持久Shell未接管即使ps扫描成功也不能以空列表确认，修复探针后可真实停止", async () => {
    let unavailable = true;
    const starts = new Map<number, number>();
    const w = await fixture({ pidStartedAt: async (pid) => unavailable ? null : starts.get(pid) ?? null, ps: async () => [] });
    const run = await w.create(); const child = await ownProcess(); starts.set(child.pid, child.startedAt);
    const taskId = uuidv7();
    withDatabase(w.database, (db) => db.create("shells", taskId, { taskId, ...child, pgid: child.pid, token: `${run.shellToken}:${taskId}`, host: { kind: "role", id: run.id, role: run.role, runId: run.id }, command: "test-node", cwd: w.repo.root }));
    expect(await w.manager.stop(run.id)).toMatchObject({ confirmed: false }); expect(alive(child.pid)).toBe(true);
    unavailable = false;
    expect(await w.manager.stop(run.id)).toMatchObject({ confirmed: true }); expect(alive(child.pid)).toBe(false);
    await w.manager.close();
  }, 15_000);
  test("F1/F2 内存USER终态不是证明；close不把已停止其他进程一并否认", async () => {
    let deniedPid = 0;
    const w = await fixture({ kill(pid, signal) { if (Math.abs(pid) === deniedPid) throw Object.assign(new Error("probe EPERM"), { code: "EPERM" }); process.kill(pid, signal); } });
    const spawned = [];
    for (const id of ["uncertain", "healthy"]) {
      const result = await w.shells.spawn({ taskId: uuidv7(), host: { kind: "main", id }, command: process.execPath, args: ["-e", "setInterval(()=>{},1000)"], cwd: w.repo.root, mode: "background", runToken: uuidv7() });
      if (!result.ok) throw new Error(result.reason); spawned.push(result.task);
    }
    deniedPid = spawned[0]!.pid;
    cleanup.push(async () => { deniedPid = 0; for (const task of spawned) { if (alive(task.pid)) { process.kill(-task.pid, "SIGKILL"); for (let n = 0; n < 100 && alive(task.pid); n++) await new Promise((r) => setTimeout(r, 10)); } expect(alive(task.pid)).toBe(false); } });
    await expect(w.manager.close()).rejects.toThrow("关闭未完成");
    expect(alive(spawned[0]!.pid)).toBe(true); expect(alive(spawned[1]!.pid)).toBe(false);
    expect(w.shells.markStoppedByUser(spawned[0]!.taskId, { decisionId: "USER-001" }).ok).toBe(true);
    await expect(w.manager.close()).rejects.toThrow("关闭未完成"); expect(alive(spawned[0]!.pid)).toBe(true);
  }, 15_000);
  test("F6 stopAll覆盖展示预算之外的旧终态运行及无run记录Shell", async () => {
    const w = await fixture({ ps: async () => [] });
    const template = await w.create(); const ids: string[] = [];
    withDatabase(w.database, (db) => db.transaction(() => { for (let i = 0; i < 105; i++) { const id = uuidv7(); ids.push(id); db.create("runs", id, { ...template, id, shellToken: id, state: "stopped" }, id); } }));
    const id = ids[104]!;
    const result = await w.shells.spawn({ taskId: uuidv7(), host: { kind: "role", id, runId: id, role: "pi-company.worker" }, command: process.execPath, args: ["-e", "setInterval(()=>{},1000)"], cwd: w.repo.root, mode: "background", runToken: id });
    const main = await w.shells.spawn({ taskId: uuidv7(), host: { kind: "main", id: "extra" }, command: process.execPath, args: ["-e", "setInterval(()=>{},1000)"], cwd: w.repo.root, mode: "background", runToken: uuidv7() });
    if (!result.ok || !main.ok) throw new Error("spawn failed");
    cleanup.push(async () => { for (const task of [result.task, main.task]) { await w.shells.stop(task.taskId); expect(alive(task.pid)).toBe(false); } });
    const stopped = await w.manager.stopAll();
    expect(alive(result.task.pid)).toBe(false); expect(alive(main.task.pid)).toBe(false);
    expect(stopped.coverage).toMatchObject({ confirmed: 106, unconfirmed: 0, unknown: 0, shellUnconfirmed: 0, truncated: true });
    expect(stopped.results.length).toBeLessThanOrEqual(100);
    expect(Buffer.byteLength(JSON.stringify(stopped))).toBeLessThanOrEqual(16_384);
  }, 30_000);
  test("F2/F5 损坏run记录不能遮蔽其他持久Shell停止，但关闭仍报告未知", async () => {
    const w = await fixture({ ps: async () => [] }); const run = await w.create(); const child = await ownProcess(); const taskId = uuidv7();
    withDatabase(w.database, (db) => {
      db.create("runs", "UNVERIFIED_BODY", { bad: true });
      db.create("shells", taskId, { taskId, ...child, pgid: child.pid, token: `${run.shellToken}:${taskId}`, host: { kind: "role", id: run.id, runId: run.id, role: run.role }, command: "test-node", cwd: w.repo.root });
    });
    await expect(w.manager.close()).rejects.toThrow("关闭未完成"); expect(alive(child.pid)).toBe(false);
    expect(withDatabase(w.database, (db) => db.read("runs", "UNVERIFIED_BODY"))).not.toBeNull();
    expect((await w.manager.stopAll()).coverage.unknown).toBeGreaterThan(0);
  }, 15_000);
  test("F5/F6 task展开验证关联且限额；旧读取和证据构建桩不访问载荷", async () => {
    const w = await fixture(); const run = await w.create(); const tasks: Record<string, unknown> = {};
    for (let n = 0; n < 2000; n++) tasks[`T-${n}`] = { progress: "todo", runId: null };
    tasks["T-2001"] = { progress: "doing", runId: run.id }; // 真实运行只绑定T-1。
    tasks["BAD_旧正文"] = { progress: "unknown", runId: "old" };
    withDatabase(w.database, (db) => db.create("requirements", REQ, state(REQ, "executing", tasks)));
    const query = await executeWorkflowAction({ action: "query", requirement: REQ, limit: 3, byteLimit: 2048 }, w.ctx);
    expect(query.ok).toBe(true); expect(JSON.stringify(query)).not.toContain("BAD_");
    expect(query.details.coverage).toMatchObject({ returned: 3, unknown: 2, truncated: true });
    expect(Buffer.byteLength(JSON.stringify(query))).toBeLessThanOrEqual(2048);
    const poison = new Proxy({}, { get() { throw new Error("不得读取正文"); } });
    for (const method of [readDecisions, inspectDecision]) await expect((method as any)(poison)).rejects.toThrow("永久淘汰");
    for (const method of [validateDecisionInput, nextDecisionId, buildRecord]) expect(() => (method as any)(poison, poison)).toThrow("永久淘汰");
    for (const method of [bindEvidence, checkEvidence]) expect(await (method as any)(poison, poison)).toMatchObject({ ok: false, reason: expect.stringContaining("永久淘汰") });
    withDatabase(w.database, (db) => { const stored = db.read<any>("runs", run.id)!; db.update("runs", run.id, stored.version, { ...stored.data, startedAt: "UNVERIFIED_旧正文" }); });
    await expect(w.manager.status(run.id)).rejects.toThrow("运行元数据不可读");
  });
});
