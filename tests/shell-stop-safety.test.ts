import { afterEach, describe, expect, test, vi } from "vitest";
import { spawn, execFileSync } from "node:child_process";
import { chmodSync, existsSync, statSync, mkdirSync, writeFileSync, unlinkSync, linkSync, readFileSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { RunManager, registerProtocolHandlers } from "../daemon/run-manager.ts";
import { DaemonServer } from "../daemon/server.ts";
import { ShellRegistry } from "../runtime/shell-registry.ts";
import type { ShellRegistryProbes } from "../runtime/shell-registry.ts";
import { createClock } from "../runtime/clock.ts";
import { NetworkPauseGate } from "../runtime/network-pause.ts";
import { daemonSocketPath, repositoryIdentity } from "../runtime/identity.ts";
import { controlToken } from "../runtime/daemon-auth.ts";
import { RunStore } from "../runtime/run-store.ts";
import { repositoryDatabase, withDatabase, uuidv7 } from "../runtime/database.ts";
import { withReadOnlyDatabase } from "../runtime/run-metadata.ts";
import { createDaemonFixture, removeDaemonFixture, connectTestClient } from "./helpers/daemon-harness.ts";

const REQ = uuidv7();
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
  const manager = new RunManager({ dataRoot: f.dataRoot, repoId: f.repoId, runStore: runs, shellRegistry: shells, clock,
    networkGate: new NetworkPauseGate(), roleCatalog: [], runtime: {} as any, workspaceRepoIds: [f.repoId], emit: () => {} });
  manager.markStarted();
  const old = new RunStore({ dataRoot: f.dataRoot, repoId: f.repoId, daemonStartedAt: "old" });
  const parent = await old.create({ kind: "requirement", task: "pm", requirement: REQ, cwd: f.repo.root, writePaths: [], readPaths: [], model: { provider: "test", id: "test" }, thinking: "off", mcp: [] });
  await old.update(parent.id, { state: "failed" });
  const create = () => old.create({ kind: "role", parentRunId: parent.id, role: "one-company.worker", task: "T-1", requirement: REQ, cwd: f.repo.root, writePaths: [], readPaths: [], model: { provider: "test", id: "test" }, thinking: "off", mcp: [] });
  return { ...f, database, clock, shells, runs, manager, create, ctx: { dataRoot: f.dataRoot, cwd: f.repo.root } };
}
async function socket(w: Awaited<ReturnType<typeof fixture>>) {
  mkdirSync(join(w.dataRoot, "sock"), { mode: 0o700 });
  const server = new DaemonServer({ authToken: controlToken(w.dataRoot), repoId: w.repoId, startedAt: new Date().toISOString() });
  registerProtocolHandlers({ server, manager: w.manager, shellRegistry: w.shells });
  await server.listen(w.socketPath); cleanup.push(() => server.close());
  const client = await connectTestClient(w.socketPath, {}, { dataRoot: w.dataRoot }); cleanup.push(() => client.close());
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

describe("M4 F1—F6 Shell 停止实际安全矩阵", () => {
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
    const leader = spawn(process.execPath, ["-e", script], { detached: true, stdio: "ignore", env: { ...process.env, ONE_COMPANY_SHELL_TOKEN: token } });
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
      if (action === "stop") expect(await w.manager.stop(run.id, { reason: "main_agent" })).toMatchObject({ confirmed: true });
      else await w.manager.close();
      descendant = Number(readFileSync(pidFile, "utf8"));
      expect(descendant).toBeGreaterThan(1);
      expect(alive(pid)).toBe(false); expect(alive(descendant)).toBe(false);
      expect(withDatabase(w.database, (db) => db.read("shells", taskId))).toBeNull();
      return;
    }
    if (action === "stop") expect(await w.manager.stop(run.id, { reason: "main_agent" })).toMatchObject({ confirmed: false });
    else await expect(w.manager.close()).rejects.toThrow("关闭未完成");
    expect(alive(descendant)).toBe(true);
    expect(withDatabase(w.database, (db) => db.read("shells", taskId))).not.toBeNull();
    // 模拟进程恢复时遇到已登记的旧终态，仍须核对同 token 的实际成员。
    const task = w.shells.get(taskId)!; task.status = "stopped"; task.activity = "ended";
    unavailable = false; failAfterSignal = false;
    expect(await w.manager.pause(run.id)).toMatchObject({ confirmed: false });
    expect(alive(descendant)).toBe(true);
    expect(await w.manager.stop(run.id, { reason: "main_agent" })).toMatchObject({ confirmed: true });
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
    expect(() => withReadOnlyDatabase(w.database, ((db: any) => {
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
    expect(() => withReadOnlyDatabase(w.database, (() => ({ then(_resolve: unknown, reject: (error: Error) => void) { thenCalled = true; reject(new Error("thenable rejection")); } })) as any)).toThrow();
    expect(thenCalled).toBe(true);
    expect(withDatabase(w.database, (db) => db.read("probe", "late"))).toBeNull();
    expect(() => withReadOnlyDatabase(w.database, () => { throw new Error("sync failure"); })).toThrow();
    expect(withReadOnlyDatabase(w.database, (db) => Number(db.prepare("SELECT 1 AS n").get()!.n))).toBe(1);
  });

  test("F1 接管失败后stop/终态pause/close均不能把活进程报已停", async () => {
    const w = await fixture({ pidStartedAt: async () => null, ps: async () => { throw new Error("probe ps denied"); } });
    const run = await w.create(); await w.runs.markInterruptedOnStartup();
    expect((await w.runs.get(run.id))).toMatchObject({ ok: true, run: { state: "interrupted" } });
    const process = await ownProcess(); const taskId = uuidv7();
    withDatabase(w.database, (db) => db.create("shells", taskId, { taskId, ...process, pgid: process.pid, token: `${run.shellToken}:${taskId}`, host: { kind: "role", id: run.id, role: run.role, runId: run.id }, command: "test-node", cwd: w.repo.root }));
    await w.manager.adoptInterruptedShells(); expect(w.shells.list()).toHaveLength(0);
    expect(await w.manager.stop(run.id, { reason: "main_agent" })).toMatchObject({ confirmed: false });
    expect(await w.manager.pause(run.id)).toMatchObject({ confirmed: false });
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
  test("F4 只读元数据连接缺库不初始化；不chmod不安全库", async () => {
    const f = await createDaemonFixture(); cleanup.push(() => removeDaemonFixture(f));
    const database = repositoryDatabase(f.dataRoot, f.repoId);
    const readable = () => { try { withReadOnlyDatabase(database, (db) => db.prepare("SELECT count(*) AS n FROM records").get()); return true; } catch { return false; } };
    expect(readable()).toBe(false); expect(existsSync(database)).toBe(false);
    withDatabase(database, (db) => db.create("requirements", REQ, { requirement: REQ }));
    chmodSync(database, 0o644);
    expect(readable()).toBe(false);
    expect(statSync(database).mode & 0o777).toBe(0o644);
    chmodSync(database, 0o600);
    const inode = statSync(database).ino;
    for (const marker of [".database-maintenance.json", ".database-snapshot.json"]) {
      const path = join(f.dataRoot, "repos", f.repoId, marker);
      writeFileSync(path, "{}", { mode: 0o600 });
      expect(readable()).toBe(false);
      expect(statSync(database).ino).toBe(inode); unlinkSync(path);
    }
    const linked = join(f.dataRoot, "own-hardlink"); linkSync(database, linked);
    expect(readable()).toBe(false); unlinkSync(linked);
    expect(readable()).toBe(true);
    expect(statSync(database).ino).toBe(inode);
  });
  test("F5 坏metadata key经真实socket只返回固定安全错误", async () => {
    const w = await fixture(); const secret = "OLD_DETAIL_KEY_未核对正文";
    withDatabase(w.database, (db) => db.create("runs", secret, { bad: true }));
    const client = await socket(w);
    let error: unknown; try { await client.call("runs.get", { runId: uuidv7() }); } catch (e) { error = e; }
    expect(error).toBeDefined(); expect(String(error)).not.toContain(secret);
  });
  test("F5/F6 2000条运行元数据：状态查询只返回所查运行，输出有界", async () => {
    const w = await fixture(); const template = await w.create(); let last = "";
    withDatabase(w.database, (db) => db.transaction(() => {
      for (let i = 0; i < 2000; i++) {
        const id = uuidv7(); last = id; db.create("runs", id, { ...template, id, state: i === 1999 ? "interrupted" : "stopped" }, id);
      }
    }));
    const client = await socket(w);
    const got = await client.call("runs.get", { runId: last });
    expect(got).toMatchObject({ run: { id: last, state: "interrupted" } });
    expect(Buffer.byteLength(JSON.stringify(got))).toBeLessThanOrEqual(16_384);
  });
  test("F1 持久Shell未接管即使ps扫描成功也不能以空列表确认，修复探针后可真实停止", async () => {
    let unavailable = true;
    const starts = new Map<number, number>();
    const w = await fixture({ pidStartedAt: async (pid) => unavailable ? null : starts.get(pid) ?? null, ps: async () => [] });
    const run = await w.create(); const child = await ownProcess(); starts.set(child.pid, child.startedAt);
    const taskId = uuidv7();
    withDatabase(w.database, (db) => db.create("shells", taskId, { taskId, ...child, pgid: child.pid, token: `${run.shellToken}:${taskId}`, host: { kind: "role", id: run.id, role: run.role, runId: run.id }, command: "test-node", cwd: w.repo.root }));
    expect(await w.manager.stop(run.id, { reason: "main_agent" })).toMatchObject({ confirmed: false }); expect(alive(child.pid)).toBe(true);
    unavailable = false;
    expect(await w.manager.stop(run.id, { reason: "main_agent" })).toMatchObject({ confirmed: true }); expect(alive(child.pid)).toBe(false);
    await w.manager.close();
  }, 15_000);
  test("F1/F2 close不把已停止其他进程一并否认，未确认的进程重试仍报未完成", async () => {
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
    await expect(w.manager.close()).rejects.toThrow("关闭未完成"); expect(alive(spawned[0]!.pid)).toBe(true);
  }, 15_000);
  test("F6 close覆盖第100条之外的旧终态运行及无run记录Shell", async () => {
    const w = await fixture({ ps: async () => [] });
    const template = await w.create(); const ids: string[] = [];
    withDatabase(w.database, (db) => db.transaction(() => { for (let i = 0; i < 105; i++) { const id = uuidv7(); ids.push(id); db.create("runs", id, { ...template, id, shellToken: id, state: "stopped" }, id); } }));
    const id = ids[104]!;
    const result = await w.shells.spawn({ taskId: uuidv7(), host: { kind: "role", id, runId: id, role: "one-company.worker" }, command: process.execPath, args: ["-e", "setInterval(()=>{},1000)"], cwd: w.repo.root, mode: "background", runToken: id });
    const main = await w.shells.spawn({ taskId: uuidv7(), host: { kind: "main", id: "extra" }, command: process.execPath, args: ["-e", "setInterval(()=>{},1000)"], cwd: w.repo.root, mode: "background", runToken: uuidv7() });
    if (!result.ok || !main.ok) throw new Error("spawn failed");
    cleanup.push(async () => { for (const task of [result.task, main.task]) { await w.shells.stop(task.taskId); expect(alive(task.pid)).toBe(false); } });
    await w.manager.close();
    expect(alive(result.task.pid)).toBe(false); expect(alive(main.task.pid)).toBe(false);
  }, 30_000);
  test("带旧字段的历史运行记录原样保留，仍可只读查询并参与停止枚举", async () => {
    const w = await fixture({ ps: async () => [] }); const run = await w.create(); const id = uuidv7();
    const legacy = { ...run, id, shellToken: id, requirement: REQ, state: "stopped", phase: "review", pendingDispatch: { instructions: "OLD_DISPATCH_正文" },
      dispatchContext: { projectTrusted: true }, sourceVersion: { definitionFingerprint: "old", codeHead: "old" }, reviewSnapshot: { head: "old", fingerprint: "old" },
      reportPath: "old/report.md", commands: ["old command"], result: { verdict: "PASS", details: "OLD_RESULT_正文" } };
    withDatabase(w.database, (db) => db.create("runs", id, legacy, id));
    const stored = await w.runs.get(id);
    expect(stored).toMatchObject({ ok: true, run: { id, phase: "review", pendingDispatch: { instructions: "OLD_DISPATCH_正文" }, result: { verdict: "PASS" } } });
    const status = await w.manager.status(id);
    expect(status).toMatchObject({ ok: true, run: { id, state: "stopped" } });
    expect(JSON.stringify(status)).not.toContain("OLD_DISPATCH"); expect(JSON.stringify(status)).not.toContain("OLD_RESULT");
    const verify = vi.spyOn(w.shells, "adoptOrphans");
    await w.manager.close();
    expect(verify.mock.calls.map(([input]) => input.owner.id)).toContain(id);
    expect(withDatabase(w.database, (db) => db.read<any>("runs", id)!.data)).toMatchObject({ phase: "review", commands: ["old command"], reportPath: "old/report.md" });
  }, 15_000);
  test("F2/F5 损坏run记录不能遮蔽其他持久Shell停止，但关闭仍报告未知", async () => {
    const w = await fixture({ ps: async () => [] }); const run = await w.create(); const child = await ownProcess(); const taskId = uuidv7();
    withDatabase(w.database, (db) => {
      db.create("runs", "UNVERIFIED_BODY", { bad: true });
      db.create("shells", taskId, { taskId, ...child, pgid: child.pid, token: `${run.shellToken}:${taskId}`, host: { kind: "role", id: run.id, runId: run.id, role: run.role }, command: "test-node", cwd: w.repo.root });
    });
    await expect(w.manager.close()).rejects.toThrow("关闭未完成"); expect(alive(child.pid)).toBe(false);
    expect(withDatabase(w.database, (db) => db.read("runs", "UNVERIFIED_BODY"))).not.toBeNull();
  }, 15_000);
  test("F5 运行元数据不合法时状态查询说明读取失败，不回显字段内容", async () => {
    const w = await fixture(); const run = await w.create();
    withDatabase(w.database, (db) => { const stored = db.read<any>("runs", run.id)!; db.update("runs", run.id, stored.version, { ...stored.data, startedAt: "UNVERIFIED_旧正文" }); });
    await expect(w.manager.status(run.id)).rejects.toThrow("运行记录读取失败");
    await expect(w.manager.status(run.id)).rejects.not.toThrow("UNVERIFIED_旧正文");
  });
});
