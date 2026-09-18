import { afterEach, expect, test } from "vitest";
import type { ChildProcess } from "node:child_process";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { connectTestClient, createDaemonFixture, killDaemon, removeDaemonFixture, resolveNodeExecutable, resolveSdkDir, startDaemonForTest } from "../helpers/daemon-harness.ts";
import type { DaemonFixture, DaemonHandle, TestClient } from "../helpers/daemon-harness.ts";
import { createClock } from "../../runtime/clock.ts";
import { RunStore } from "../../runtime/run-store.ts";
import { repositoryDatabase, uuidv7 } from "../../runtime/database.ts";
import { ShellRegistry } from "../../runtime/shell-registry.ts";

const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => {
  const errors: unknown[] = [];
  for (const fn of cleanup.splice(0).reverse()) {
    try { await fn(); } catch (error) { errors.push(error); }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "host-exit测试清理失败");
});
const exec = promisify(execFile);
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const runner = fileURLToPath(new URL("../helpers/window-runner.ts", import.meta.url));
function alive(pid: number) { try { process.kill(pid, 0); return true; } catch { return false; } }
async function until<T>(read: () => Promise<T>, ready: (value: T) => boolean, ms = 15000): Promise<T> {
  const end = Date.now() + ms;
  do { const value = await read(); if (ready(value)) return value; await delay(50); } while (Date.now() < end);
  throw new Error("真实生命周期操作未收尾");
}
async function exit(child: ChildProcess) {
  await until(async () => child.exitCode !== null || child.signalCode !== null, Boolean, 10000);
}
async function groupPids(pgid: number) {
  const { stdout } = await exec("ps", ["-axo", "pid=,pgid="]);
  return stdout.split("\n").map((line) => line.trim().split(/\s+/).map(Number)).filter((row) => row[1] === pgid).map((row) => row[0]!);
}

interface ProcessIdentity { pid: number; pgid: number; startedAt: string }
interface ProcessObservation extends ProcessIdentity {
  state: "alive" | "gone" | "reused";
  currentPgid?: number;
  currentStartedAt?: string;
  psStatus?: string;
}
interface ExitObservation {
  observedAt: string;
  target: { pgid: number; groupAlive: boolean; members: ProcessObservation[] };
  independent: { pgid: number; groupAlive: boolean; members: ProcessObservation[] };
}
async function processRow(pid: number): Promise<{ pid: number; pgid: number; startedAt: string; psStatus: string } | undefined> {
  let stdout: string;
  try {
    ({ stdout } = await exec("ps", ["-p", String(pid), "-o", "pid=", "-o", "pgid=", "-o", "lstart=", "-o", "stat="]));
  } catch (error) {
    if (!alive(pid)) return undefined;
    throw new Error(`无法核对自产PID ${pid} 的进程身份: ${error instanceof Error ? error.message : String(error)}`);
  }
  const fields = stdout.trim().split(/\s+/);
  if (fields.length < 8 || Number(fields[0]) !== pid || !Number.isSafeInteger(Number(fields[1]))) {
    if (!alive(pid)) return undefined;
    throw new Error(`无法核对自产PID ${pid} 的ps身份字段`);
  }
  return { pid, pgid: Number(fields[1]), startedAt: fields.slice(2, 7).join(" "), psStatus: fields.slice(7).join(" ") };
}
async function captureIdentity(pid: number, pgid: number): Promise<ProcessIdentity> {
  const row = await processRow(pid);
  if (!row || row.pgid !== pgid) throw new Error(`自产PID ${pid} 无法绑定到目标PGID ${pgid}`);
  return { pid, pgid, startedAt: row.startedAt };
}
async function observeProcess(identity: ProcessIdentity): Promise<ProcessObservation> {
  const row = await processRow(identity.pid);
  if (!row) return { ...identity, state: "gone" };
  if (row.startedAt !== identity.startedAt) {
    return { ...identity, state: "reused", currentPgid: row.pgid, currentStartedAt: row.startedAt, psStatus: row.psStatus };
  }
  return { ...identity, state: "alive", currentPgid: row.pgid, currentStartedAt: row.startedAt, psStatus: row.psStatus };
}
async function groupMembers(pgid: number): Promise<ProcessIdentity[]> {
  const pids = await until(() => groupPids(pgid), (value) => value.length >= 3);
  return Promise.all([...pids].sort((a, b) => a - b).map((pid) => captureIdentity(pid, pgid)));
}
async function observeGroup(pgid: number, members: ProcessIdentity[]) {
  return { pgid, groupAlive: alive(-pgid), members: await Promise.all(members.map(observeProcess)) };
}
function safeObservation(observation: ExitObservation | undefined) {
  return observation ?? { observedAt: new Date().toISOString(), observation: "unavailable" };
}
async function writeExitEvidence(action: string, evidence: unknown) {
  const dir = process.env.PI_HOST_EXIT_EVIDENCE_DIR;
  if (!dir) return;
  await writeFile(join(dir, `${action.toLowerCase()}.json`), `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
}
function assertIndependentAlive(observation: ExitObservation) {
  const invalid = !observation.independent.groupAlive || observation.independent.members.some((member) => member.state !== "alive" || member.currentPgid !== member.pgid);
  if (invalid) throw new Error(`独立role组在窗口退出等待期间被误停或身份无法核对: ${JSON.stringify(observation.independent)}`);
}
async function waitForWindowMembersExit(action: string, targetPgid: number, targetMembers: ProcessIdentity[], independentPgid: number, independentMembers: ProcessIdentity[]) {
  let latest: ExitObservation | undefined;
  let firstGroupGone: ExitObservation | undefined;
  try {
    const completed = await until(async () => {
      latest = {
        observedAt: new Date().toISOString(),
        target: await observeGroup(targetPgid, targetMembers),
        independent: await observeGroup(independentPgid, independentMembers),
      };
      assertIndependentAlive(latest);
      const reused = latest.target.members.find((member) => member.state === "reused");
      if (reused) throw new Error(`目标成员PID发生复用，不能冒充原对象已结束: ${JSON.stringify(reused)}`);
      if (!latest.target.groupAlive && !firstGroupGone) {
        firstGroupGone = latest;
        await writeExitEvidence(action, { action, status: "observed-group-gone", firstGroupGone });
        if (latest.target.members.some((member) => member.state === "alive") && !process.env.PI_HOST_EXIT_EVIDENCE_DIR) {
          console.warn(`[host-exit-member-observation] ${JSON.stringify(firstGroupGone)}`);
        }
      }
      return latest;
    }, (observation) => !observation.target.groupAlive && observation.target.members.every((member) => member.state === "gone"));
    assertIndependentAlive(completed);
    await writeExitEvidence(action, { action, status: "passed", firstGroupGone, completed });
    return completed;
  } catch (error) {
    const failure = { action, status: "failed", firstGroupGone, latest: safeObservation(latest), reason: error instanceof Error ? error.message : String(error) };
    await writeExitEvidence(action, failure);
    throw new Error(`窗口退出未在原15秒预算内完成PGID及全部原成员收尾: ${JSON.stringify(failure)}`, { cause: error });
  }
}
async function trackedGroupObservation(pgid: number, members: ProcessIdentity[]) {
  const observations = await Promise.all(members.map(observeProcess));
  const reused = observations.find((member) => member.state === "reused");
  if (reused) throw new Error(`自产PID身份已变化，拒绝把PID复用当作结束: ${JSON.stringify(reused)}`);
  return { pgid, groupAlive: alive(-pgid), members: observations };
}
async function waitForTrackedMembersGone(pgid: number, members: ProcessIdentity[]) {
  await until(() => trackedGroupObservation(pgid, members), (observation) =>
    !observation.groupAlive && observation.members.every((member) => member.state === "gone"));
  const observation = await trackedGroupObservation(pgid, members);
  expect(observation.groupAlive).toBe(false);
  for (const member of observation.members) {
    expect(member.state).toBe("gone");
    expect(alive(member.pid)).toBe(false);
  }
}
async function expectTrackedMembersGoneNow(pgid: number, members: ProcessIdentity[]) {
  const observation = await trackedGroupObservation(pgid, members);
  expect(observation.groupAlive).toBe(false);
  for (const member of observation.members) {
    expect(member.state).toBe("gone");
    expect(alive(member.pid)).toBe(false);
  }
}
async function assertTrackedMembersGoneNow(pgid: number, members: ProcessIdentity[]) {
  const observation = await trackedGroupObservation(pgid, members);
  const aliveMembers = observation.members.filter((member) => member.state !== "gone");
  if (observation.groupAlive || aliveMembers.length > 0) {
    throw new Error(`自产进程尚未全部结束: ${JSON.stringify(observation)}`);
  }
}

interface TrackedShellGroup { taskId: string; pgid: number; members?: ProcessIdentity[] }
interface WorldResources {
  fixture: DaemonFixture;
  clock?: ReturnType<typeof createClock>;
  shells?: ShellRegistry;
  shell?: TrackedShellGroup;
  handle?: DaemonHandle;
  daemonIdentity?: ProcessIdentity;
  client?: TestClient;
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
function throwCleanupErrors(errors: unknown[], message: string): never {
  if (errors.length === 1) throw new Error(`${message}: ${errorText(errors[0])}`, { cause: errors[0] });
  throw new AggregateError(errors, message);
}
async function cleanupDaemon(handle: DaemonHandle, identity: ProcessIdentity | undefined) {
  if (!identity) throw new Error("daemon已启动但缺少本次进程身份，拒绝向未知PID发信号");
  const observation = await observeProcess(identity);
  if (observation.state === "reused" || (observation.state === "alive" && observation.currentPgid !== identity.pgid)) {
    throw new Error(`daemon身份已变化，拒绝向未知PID发信号: ${JSON.stringify(observation)}`);
  }
  if (observation.state === "alive") {
    await killDaemon(handle);
    await waitForTrackedMembersGone(identity.pgid, [identity]);
  } else if (alive(-identity.pgid)) {
    throw new Error(`daemon原PID已结束但PGID仍存活，拒绝清理身份不明的进程组 ${identity.pgid}`);
  }
}
async function cleanupShellRegistry(shells: ShellRegistry, tracked: TrackedShellGroup | undefined) {
  const tasks = shells.list();
  if (!tracked) {
    if (tasks.length > 0) throw new Error(`Shell已创建但缺少本次成员身份，拒绝向未知PID发信号: ${JSON.stringify(tasks.map((task) => ({ taskId: task.taskId, pgid: task.pgid })))}`);
    return;
  }
  if (!tracked.members || tracked.members.length === 0) {
    throw new Error(`Shell ${tracked.taskId} 缺少本次成员身份，拒绝向未知PID发信号`);
  }
  const unrelated = tasks.filter((task) => task.taskId !== tracked.taskId);
  if (unrelated.length > 0) {
    throw new Error(`发现未绑定成员身份的Shell，拒绝向未知PID发信号: ${JSON.stringify(unrelated.map((task) => ({ taskId: task.taskId, pgid: task.pgid })))}`);
  }
  const task = tasks.find((candidate) => candidate.taskId === tracked.taskId);
  const before = await trackedGroupObservation(tracked.pgid, tracked.members);
  const moved = before.members.find((member) => member.state === "alive" && member.currentPgid !== member.pgid);
  if (moved) throw new Error(`Shell成员已离开原PGID，拒绝向身份不明的进程组发信号: ${JSON.stringify(moved)}`);
  if (before.groupAlive && before.members.every((member) => member.state === "gone")) {
    throw new Error(`Shell原成员已结束但PGID仍存活，拒绝清理身份不明的进程组 ${tracked.pgid}`);
  }
  if (before.groupAlive) {
    if (!task) throw new Error(`Shell登记已丢失，拒绝绕过ShellRegistry向PGID ${tracked.pgid} 发信号`);
    await shells.stop(task.taskId);
  } else {
    for (const member of before.members.filter((item) => item.state === "alive")) process.kill(member.pid, "SIGKILL");
  }
  await waitForTrackedMembersGone(tracked.pgid, tracked.members);
}
async function worldDiagnostic(resources: WorldResources) {
  const inspect = async (identity: ProcessIdentity | undefined) => identity ? observeProcess(identity).catch((error) => ({ ...identity, state: "identity-check-failed", reason: errorText(error) })) : undefined;
  const members = resources.shell?.members
    ? await Promise.all(resources.shell.members.map((identity) => inspect(identity)))
    : undefined;
  return {
    roots: { dataRoot: resources.fixture.dataRoot, repoRoot: resources.fixture.repo.root, homeRoot: resources.fixture.home.home },
    daemon: await inspect(resources.daemonIdentity),
    shell: resources.shell ? { taskId: resources.shell.taskId, pgid: resources.shell.pgid, groupAlive: alive(-resources.shell.pgid), members } : undefined,
  };
}
async function cleanupWorld(resources: WorldResources) {
  const errors: unknown[] = [];
  try { resources.client?.close(); } catch (error) { errors.push(error); }
  if (resources.handle) {
    try { await cleanupDaemon(resources.handle, resources.daemonIdentity); } catch (error) { errors.push(error); }
  }
  if (resources.shells) {
    try { await cleanupShellRegistry(resources.shells, resources.shell); } catch (error) { errors.push(error); }
  }
  try { resources.clock?.stopGapWatcher(); } catch (error) { errors.push(error); }

  try {
    if (resources.handle) {
      if (!resources.daemonIdentity) throw new Error("daemon缺少身份，无法确认world根可删除");
      await assertTrackedMembersGoneNow(resources.daemonIdentity.pgid, [resources.daemonIdentity]);
    }
    if (resources.shell) {
      if (!resources.shell.members) throw new Error("Shell缺少成员身份，无法确认world根可删除");
      await assertTrackedMembersGoneNow(resources.shell.pgid, resources.shell.members);
    }
  } catch (error) {
    errors.push(error);
  }
  if (process.env.PI_HOST_EXIT_INJECT_CLEANUP_FAILURE === "1") {
    errors.push(new Error("注入world清理门槛失败"));
  }
  if (errors.length === 0) {
    await removeDaemonFixture(resources.fixture);
    return;
  }
  const diagnostic = await worldDiagnostic(resources);
  const evidenceDir = process.env.PI_HOST_EXIT_EVIDENCE_DIR;
  if (evidenceDir) {
    await writeFile(join(evidenceDir, `cleanup-retained-${process.pid}.json`), `${JSON.stringify({ status: "retained", errors: errors.map(errorText), ...diagnostic }, null, 2)}\n`, { mode: 0o600 });
  }
  throwCleanupErrors(errors, `world清理未满足删除前置，已保留根 ${resources.fixture.dataRoot}`);
}

async function world() {
  const fixture = await createDaemonFixture();
  const resources: WorldResources = { fixture };
  cleanup.push(() => cleanupWorld(resources));
  const clock = createClock(); resources.clock = clock;
  const shells = new ShellRegistry({ clock, database: repositoryDatabase(fixture.dataRoot, fixture.repoId) }); resources.shells = shells;
  const store = new RunStore({ dataRoot: fixture.dataRoot, repoId: fixture.repoId, daemonStartedAt: "host-exit-history" });
  const run = await store.create({ kind: "role", standalone: true, role: "pi-company.worker", requirement: "2026-09-10.host-exit", task: "测试自建待停止记录",
    cwd: fixture.repo.root, readPaths: [], writePaths: [], model: { provider: "unused", id: "unused" }, thinking: "off", mcp: [] });
  await store.update(run.id, { state: "running" });
  const spawned = await shells.spawn({ taskId: uuidv7(), host: { kind: "role", id: run.id, runId: run.id, role: run.role },
    command: "/bin/sh", args: ["-c", "sleep 60 & sleep 60 & wait"], mode: "background", runToken: run.shellToken });
  if (!spawned.ok) throw new Error(spawned.reason);
  resources.shell = { taskId: spawned.task.taskId, pgid: spawned.task.pgid };
  const members = await groupMembers(spawned.task.pgid); resources.shell.members = members;
  const handle = await startDaemonForTest(fixture); resources.handle = handle;
  if (!handle.proc.pid) throw new Error("daemon未提供PID");
  resources.daemonIdentity = await captureIdentity(handle.proc.pid, handle.proc.pid);
  const client = await connectTestClient(fixture.socketPath, { cwd: fixture.repo.root, workspaceRoot: fixture.repo.root, repoIds: [fixture.repoId] }); resources.client = client;
  await client.call("runs.list");
  await until(() => client.call("shells.list"), (result) => (result.tasks as Array<{ taskId: string }>).some((task) => task.taskId === spawned.task.taskId));
  return { fixture, handle, client, task: spawned.task, members };
}

interface WindowState { phase: string; pgid?: number; connected?: boolean; reason?: string }
const PTY_HOST = `import os, pty, sys
pid, master = pty.fork()
if pid == 0:
    os.execv(sys.argv[1], sys.argv[1:])
try:
    while os.read(master, 65536):
        pass
except OSError:
    pass
finally:
    os.close(master)
    os.waitpid(pid, 0)
`;
async function windowHost(w: Awaited<ReturnType<typeof world>>, pty = false) {
  const dir = await mkdtemp(join(tmpdir(), "host-exit-window-"));
  const stateFile = join(dir, "state.json"), config = join(dir, "config.json");
  await writeFile(config, JSON.stringify({ cwd: w.fixture.repo.root, dataRoot: w.fixture.dataRoot, sdkDir: resolveSdkDir(), stateFile, shellCommand: "sleep 60 & sleep 60 & wait" }));
  const args = [resolveNodeExecutable(), runner, config];
  const proc = pty ? spawn("python3", ["-c", PTY_HOST, ...args], { stdio: ["pipe", "pipe", "pipe"], env: w.fixture.home.env })
    : spawn(args[0]!, args.slice(1), { stdio: ["pipe", "pipe", "pipe"], env: w.fixture.home.env });
  let stderr = ""; proc.stderr?.on("data", (chunk) => { stderr += String(chunk); }); proc.stdout?.resume();
  let pgid: number | undefined;
  let members: ProcessIdentity[] = [];
  cleanup.push(async () => {
    if (proc.exitCode === null && proc.signalCode === null) { proc.kill("SIGTERM"); await exit(proc); }
    if (pgid && members.length > 0) {
      const observations = await Promise.all(members.map(observeProcess));
      const reused = observations.find((member) => member.state === "reused");
      if (reused) throw new Error(`窗口清理拒绝操作已复用PID: ${JSON.stringify(reused)}`);
      if (alive(-pgid)) process.kill(-pgid, "SIGKILL");
      else for (const member of observations.filter((item) => item.state === "alive")) process.kill(member.pid, "SIGKILL");
      await waitForTrackedMembersGone(pgid, members);
    } else if (pgid && alive(-pgid)) {
      process.kill(-pgid, "SIGKILL");
      await until(async () => !alive(-pgid!), Boolean);
    }
    await rm(dir, { recursive: true, force: true });
  });
  const state = await until(async () => { try { return JSON.parse(await readFile(stateFile, "utf8")) as WindowState; } catch { return { phase: "pending" }; } }, (state) => ["ready", "failed"].includes(state.phase));
  expect({ phase: state.phase, reason: state.reason, stderr: state.phase === "failed" ? stderr : "" }).toEqual({ phase: "ready", reason: undefined, stderr: "" });
  if (!state.pgid) throw new Error("窗口未登记真实进程组"); pgid = state.pgid;
  expect(state.connected).toBe(true); expect(alive(-pgid)).toBe(true);
  members = await groupMembers(pgid);
  return { proc, pgid, members };
}

for (const action of ["QUIT", "SIGTERM", "SIGHUP", "PTY"] as const) test(`窗口${action}退出只结束自身Shell及后代，daemon接管的测试角色Shell不受影响`, async () => {
  const w = await world(); const window = await windowHost(w, action === "PTY");
  for (const member of [...w.members, ...window.members]) expect(alive(member.pid)).toBe(true);
  if (action === "QUIT") window.proc.stdin!.write("QUIT\n");
  else window.proc.kill(action === "PTY" ? "SIGKILL" : action);
  await exit(window.proc);
  await waitForWindowMembersExit(action, window.pgid, window.members, w.task.pgid, w.members);
  for (const member of window.members) expect(alive(member.pid)).toBe(false);
  expect(alive(-w.task.pgid)).toBe(true);
  for (const member of w.members) {
    expect((await observeProcess(member)).state).toBe("alive");
    expect(alive(member.pid)).toBe(true);
  }
  const tasks = (await w.client.call("shells.list")).tasks as Array<{ taskId: string; status: string }>;
  expect(tasks.find((task) => task.taskId === w.task.taskId)?.status).toBe("running");
}, 40000);

test("daemon SIGTERM退出必须先清理接管的真实角色Shell及全部组内后代", async () => {
  const w = await world(); w.client.close(); w.handle.proc.kill("SIGTERM");
  const result = await w.handle.exited; expect(result.code).toBe(0);
  await expectTrackedMembersGoneNow(w.task.pgid, w.members);
}, 40000);

test("后台Shell一秒超时不提前触发，timed_out只在真实后代清理后返回", async () => {
  const clock = createClock(); cleanup.push(() => clock.stopGapWatcher());
  const shells = new ShellRegistry({ clock });
  let tracked: TrackedShellGroup | undefined;
  cleanup.push(() => cleanupShellRegistry(shells, tracked));
  const start = Date.now();
  const spawned = await shells.spawn({ taskId: uuidv7(), host: { kind: "role", id: "timeout-fixture" }, command: "/bin/sh", args: ["-c", "sleep 30 & sleep 30 & wait"], mode: "background", timeoutSeconds: 1, runToken: uuidv7() });
  if (!spawned.ok) throw new Error(spawned.reason);
  tracked = { taskId: spawned.task.taskId, pgid: spawned.task.pgid };
  const members = await groupMembers(spawned.task.pgid); tracked.members = members;
  await delay(400);
  expect(shells.get(spawned.task.taskId)?.status).not.toBe("timed_out"); expect(alive(-spawned.task.pgid)).toBe(true);
  await until(async () => shells.get(spawned.task.taskId)?.status, (status) => status === "timed_out");
  expect(Date.now() - start).toBeGreaterThanOrEqual(1000);
  await expectTrackedMembersGoneNow(spawned.task.pgid, members);
}, 20000);
