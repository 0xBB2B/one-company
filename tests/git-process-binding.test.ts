import { afterEach, expect, test } from "vitest";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { RequirementService } from "../runtime/requirement-service.ts";
import { runManagedGit, withGitProcessSession } from "../runtime/git-process-session.ts";
import { exportGitExpectation } from "../runtime/git-runtime.mjs";
import { initializeTestHostGit } from "./helpers/test-git-binding.ts";

const productRoot = fileURLToPath(new URL("../", import.meta.url));
const runnerPath = fileURLToPath(new URL("../runtime/git-process-runner.mjs", import.meta.url));
const runtimeUrl = pathToFileURL(fileURLToPath(new URL("../runtime/git-runtime.mjs", import.meta.url))).href;
const sessionUrl = pathToFileURL(fileURLToPath(new URL("../runtime/git-process-session.ts", import.meta.url))).href;
const serviceUrl = pathToFileURL(fileURLToPath(new URL("../runtime/requirement-service.ts", import.meta.url))).href;
const extensionUrl = pathToFileURL(fileURLToPath(new URL("../extensions/requirement-manage.ts", import.meta.url))).href;
const roots: string[] = [];
const retainedRoots = new Set<string>();
const hostBinding = initializeTestHostGit([]);

async function temp(prefix: string, inHome = false): Promise<string> {
  const root = await mkdtemp(join(inHome ? homedir() : tmpdir(), prefix));
  roots.push(root);
  await chmod(root, 0o755);
  return root;
}

async function fakeGit(name: string, body: string): Promise<{ root: string; bin: string; executable: string }> {
  const root = await temp(`.pi-company-git-binding-${name}-`, true);
  const bin = join(root, "bin");
  await mkdir(bin, { mode: 0o755 });
  const executable = join(bin, process.platform === "win32" ? "git.exe" : "git");
  await writeFile(executable, `#!${process.execPath}\n${body}\n`, { mode: 0o755 });
  return { root, bin, executable };
}

interface ProbeResult {
  error?: Error;
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

function groupAlive(groupId: number): boolean {
  try { process.kill(-groupId, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

async function waitForGroupExit(groupId: number, timeout = 3_000): Promise<boolean> {
  const deadline = performance.now() + timeout;
  while (groupAlive(groupId) && performance.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  return !groupAlive(groupId);
}

function stopLiveProbeGroup(child: ReturnType<typeof spawn>): void {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  try { process.kill(-child.pid, "SIGKILL"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
}

interface ActiveProbe {
  roots: readonly string[];
  done: Promise<void>;
  stop(error: Error): void;
}
const activeProbes = new Set<ActiveProbe>();
function trackProbe(child: ReturnType<typeof spawn>, ownedRoots: readonly string[], onError: (error: Error) => void) {
  const snapshot = [...ownedRoots];
  let release!: () => void;
  const done = new Promise<void>((resolve) => { release = resolve; });
  const preserve = () => { for (const root of snapshot) retainedRoots.add(root); };
  const entry: ActiveProbe = { roots: snapshot, done, stop(error) {
    preserve();
    onError(error);
    try { stopLiveProbeGroup(child); }
    catch (stopError) { onError(new AggregateError([error, stopError], "自产活句柄停止失败")); }
  } };
  activeProbes.add(entry);
  return { entry, preserve, finish() { activeProbes.delete(entry); release(); } };
}

async function drainActiveProbes(): Promise<void> {
  const pending = [...activeProbes];
  for (const probe of pending) probe.stop(new Error("测试结束时探针尚未收尾；保全所属根"));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([Promise.all(pending.map((probe) => probe.done)),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, 4_000); })]);
  } finally { if (timer) clearTimeout(timer); }
  for (const probe of activeProbes) for (const root of probe.roots) retainedRoots.add(root);
}

async function node(source: string, args: string[] = [], env: NodeJS.ProcessEnv = {}, timeout = 30_000): Promise<ProbeResult> {
  const preloadSource = `
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
const originalSpawn = childProcess.spawn;
const detached = [];
function report(message, callback = () => {}) {
  try { process.send(message, (error) => { if (error) process.exitCode = 1; callback(error); }); }
  catch (error) { process.exitCode = 1; callback(error); }
}
childProcess.spawn = function (...args) {
  const spawned = Reflect.apply(originalSpawn, this, args);
  if (args[2]?.detached) {
    const row = { groupId: spawned.pid ?? null, closed: false };
    detached.push(row);
    spawned.once("spawn", () => { row.groupId = spawned.pid; report({ type: "test-detached-group", groupId: spawned.pid }); });
    spawned.once("close", () => { row.closed = true; });
  }
  return spawned;
};
let reported = false;
process.on("beforeExit", () => {
  if (reported) return;
  reported = true;
  report({ type: "test-probe-complete", groups: detached }, () => {
    try { if (process.connected) process.disconnect(); } catch { process.exitCode = 1; }
  });
});
syncBuiltinESMExports();`;
  const preload = `data:text/javascript,${encodeURIComponent(preloadSource)}`;
  return new Promise<ProbeResult>((resolve) => {
    const probe = spawn(process.execPath, ["--import", preload, "--input-type=module", "-e", source, ...args], {
      cwd: productRoot,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      detached: true,
    });
    const groups = new Set<number>();
    if (probe.pid) groups.add(probe.pid);
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    let size = 0, failure: Error | undefined, settled = false, completionReceived = false;
    const tracked = trackProbe(probe, roots, (error) => { failure = failure ? new AggregateError([failure, error], failure.message) : error; });
    const requestStop = tracked.entry.stop;
    const timer = setTimeout(() => requestStop(new Error(`node probe timeout；groups=${[...groups].join(",")}`)), timeout);
    const watchdog = setTimeout(() => {
      if (settled || !failure) return;
      tracked.preserve();
      settled = true;
      resolve({ error: new Error(`${failure.message}；未观察到真实close，保全roots=${tracked.entry.roots.join(",")}`),
        status: null, signal: null, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
    }, timeout + 5_000);
    probe.on("message", (message: unknown) => {
      if (!message || typeof message !== "object") return;
      const received = message as { type?: unknown; groupId?: unknown; groups?: unknown };
      if (received.type === "test-detached-group") {
        if (Number.isSafeInteger(received.groupId) && (received.groupId as number) > 0) groups.add(received.groupId as number);
      } else if (received.type === "test-probe-complete") {
        const rows = received.groups;
        if (completionReceived || !Array.isArray(rows) || rows.some((row) => !row || !Number.isSafeInteger(row.groupId)
          || row.groupId <= 0 || row.closed !== true)) {
          requestStop(new Error("node probe完成证明无效；保全根"));
          return;
        }
        for (const row of rows) groups.add(row.groupId);
        completionReceived = true;
      }
    });
    const collect = (target: Buffer[]) => (chunk: Buffer) => {
      size += chunk.length;
      if (size > 4 * 1024 * 1024) { requestStop(new Error("node probe maxBuffer exceeded")); return; }
      target.push(Buffer.from(chunk));
    };
    probe.stdout.on("data", collect(stdout));
    probe.stderr.on("data", collect(stderr));
    probe.once("error", (error) => requestStop(error));
    probe.once("close", async (status, signal) => {
      clearTimeout(timer);
      if (status !== 0 || signal !== null || !completionReceived) {
        failure ??= new Error(`node probe异常退出或缺少完整收尾证明；status=${status}; signal=${signal}`);
        tracked.preserve();
      }
      // 历史组号只作保守的只读检查，不能产生新的停止权限。
      const deadline = performance.now() + 3_000;
      let active = [...groups].filter(groupAlive);
      while (active.length && performance.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        active = active.filter(groupAlive);
      }
      if (active.length) failure = new Error(`node probe进程组未确认结束；groups=${active.join(",")}`);
      if (failure) tracked.preserve();
      tracked.finish();
      clearTimeout(watchdog);
      if (settled) return;
      settled = true;
      resolve({ ...(failure ? { error: failure } : {}), status, signal,
        stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
    });
  });
}

function json(result: ProbeResult): Record<string, unknown> {
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

async function rawRunner(sendMessages: (worker: ReturnType<typeof spawn>, message: Record<string, unknown>,
  context: { cwd: string; expectation: ReturnType<typeof exportGitExpectation>; send(message: Record<string, unknown>): void }) => void) {
  const cwd = await temp("pi-company-runner-protocol-");
  const expectation = exportGitExpectation([cwd]);
  return new Promise<{ messages: Record<string, unknown>[]; code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    const messages: Record<string, unknown>[] = [];
    const worker = spawn(process.execPath, [runnerPath], {
      cwd,
      env: { PATH: "" },
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      detached: true,
    });
    let failure: Error | undefined, settled = false;
    const tracked = trackProbe(worker, [cwd], (error) => { failure = failure ? new AggregateError([failure, error], failure.message) : error; });
    const stop = tracked.entry.stop;
    const send = (outgoing: Record<string, unknown>) => {
      try { worker.send(outgoing, (error) => { if (error) stop(error); }); }
      catch (error) { stop(error as Error); }
    };
    const timer = setTimeout(() => stop(new Error(`runner protocol timeout；root=${cwd}; pid=${worker.pid ?? "unknown"}`)), 10_000);
    const watchdog = setTimeout(() => {
      if (settled || !failure) return;
      retainedRoots.add(cwd);
      settled = true;
      reject(new Error(`${failure.message}；未观察到真实close，保全root=${cwd}`));
    }, 15_000);
    worker.on("message", (raw) => {
      const message = raw as Record<string, unknown>;
      messages.push(message);
      try { sendMessages(worker, message, { cwd, expectation, send }); }
      catch (error) { stop(error as Error); }
    });
    worker.once("error", (error) => stop(error));
    worker.once("close", async (code, signal) => {
      clearTimeout(timer);
      const groupGone = worker.pid ? await waitForGroupExit(worker.pid) : true;
      if (!groupGone) {
        retainedRoots.add(cwd);
        failure = new Error(`runner进程组未确认结束；root=${cwd}; pid=${worker.pid ?? "unknown"}`);
      }
      tracked.finish();
      clearTimeout(watchdog);
      if (settled) return;
      settled = true;
      if (failure) reject(Object.assign(new Error(failure.message, { cause: failure }), { cleanupConfirmed: groupGone }));
      else resolve({ messages, code, signal });
    });
  });
}

afterEach(async () => {
  await drainActiveProbes();
  for (const root of roots.splice(0).reverse()) {
    if (retainedRoots.has(root)) continue;
    await chmod(root, 0o755).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("受管worker在登记后独立重建同一Git，净PATH不影响执行且真实组退出后才finished", async () => {
  const cwd = await temp("pi-company-managed-git-");
  const events: string[] = [];
  let childPath = "", groupId = 0;
  const result = await withGitProcessSession({
    started(id) { groupId = id; events.push("started"); },
    ready(id, _key, executablePath) { expect(id).toBe(groupId); childPath = executablePath; events.push("ready"); },
    running(id) { expect(id).toBe(groupId); events.push("running"); },
    finished(id) {
      expect(id).toBe(groupId);
      expect(() => process.kill(-id, 0)).toThrow();
      events.push("finished");
    },
  }, () => runManagedGit({
    executable: hostBinding.executablePath,
    args: ["--version"],
    cwd,
    env: { PATH: "", LANG: "C", LC_ALL: "C" },
    timeout: 5_000,
    maxBuffer: 64 * 1024,
    command: "version",
    excludedRoots: [cwd],
  }));
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toEqual(Buffer.alloc(0));
  expect(result.stdout.toString("utf8")).toMatch(/^git version /);
  expect(childPath).toBe(hostBinding.executablePath);
  expect(events).toEqual(["started", "ready", "running", "finished"]);
}, 20_000);

test("observer.started登记失败时不向worker发送git-init，也不执行Git version", async () => {
  const counterGit = await fakeGit("registration", `process.stdout.write("git version 9.9.1\\n");`);
  const cwd = await temp("pi-company-registration-failure-", true);
  const counter = join(counterGit.root, "counter");
  await writeFile(counterGit.executable, `#!${process.execPath}\nimport { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(counter)}, "x");\nprocess.stdout.write("git version 9.9.1\\n");\n`, { mode: 0o755 });
  const result = await node(`
import { writeFileSync, readFileSync } from "node:fs";
import { initializeHostGit } from ${JSON.stringify(runtimeUrl)};
import { runManagedGit, withGitProcessSession } from ${JSON.stringify(sessionUrl)};
const binding = initializeHostGit([process.argv[1]]);
writeFileSync(process.env.COUNTER, "");
let code, running = 0, finished = 0;
try {
  await withGitProcessSession({ started() { throw new Error("registration_failed"); }, running() { running += 1; }, finished() { finished += 1; } },
    () => runManagedGit({ executable: binding.executablePath, args: ["--version"], cwd: process.argv[1],
      env: { PATH: "", COUNTER: process.env.COUNTER }, timeout: 1000, maxBuffer: 65536, command: "version", excludedRoots: [process.argv[1]] }));
} catch (error) { code = error.message; }
process.stdout.write(JSON.stringify({ code, running, finished, counter: readFileSync(process.env.COUNTER, "utf8") }));
`, [cwd], { PATH: counterGit.bin, COUNTER: counter });
  expect(json(result)).toEqual({ code: "registration_failed", running: 0, finished: 0, counter: "" });
}, 20_000);

test("runner拒绝ready前run和重复git-init，不执行请求命令", async () => {
  const early = await rawRunner((_worker, message, context) => {
    if (message.type !== "bootstrap-ready") return;
    context.send({ type: "run", id: 1, executable: hostBinding.executablePath, args: ["--version"],
      cwd: context.cwd, env: { PATH: "" }, timeout: 1000, maxBuffer: 65536,
      expected: context.expectation, identityKey: context.expectation.identityKey, excludedRoots: [context.cwd] });
  });
  expect(early.messages.map((message) => message.type)).toEqual(["bootstrap-ready"]);
  expect(early.signal).toBe("SIGKILL");

  const earlyInput = await rawRunner((_worker, message, context) => {
    if (message.type === "bootstrap-ready") context.send({ type: "input", id: 1, identityKey: context.expectation.identityKey });
  });
  expect(earlyInput.messages.map((message) => message.type)).toEqual(["bootstrap-ready"]);
  expect(earlyInput.signal).toBe("SIGKILL");

  const repeated = await rawRunner((_worker, message, context) => {
    if (message.type === "bootstrap-ready" || message.type === "ready") {
      context.send({ type: "git-init", expected: context.expectation, cwd: context.cwd,
        excludedRoots: [context.cwd], identityKey: context.expectation.identityKey });
    }
  });
  expect(repeated.messages.map((message) => message.type)).toEqual(["bootstrap-ready", "ready"]);
  expect(repeated.signal).toBe("SIGKILL");
}, 20_000);

test("Git在执行后发生权限/内容身份变化时只返回固定失败，不泄露已收集stdout", async () => {
  const mutable = await fakeGit("post-close", `
import { chmodSync } from "node:fs";
import { fileURLToPath } from "node:url";
if (process.argv.includes("--version")) process.stdout.write("git version 9.9.2\\n");
else {
  process.stdout.write("restricted-output");
  chmodSync(fileURLToPath(import.meta.url), 0o775);
}`);
  const cwd = await temp("pi-company-post-close-", true);
  const result = await node(`
import { initializeHostGit } from ${JSON.stringify(runtimeUrl)};
import { runManagedGit, withGitProcessSession } from ${JSON.stringify(sessionUrl)};
const binding = initializeHostGit([process.argv[1]]);
let code, stdout = null;
try {
  const result = await withGitProcessSession(undefined, () => runManagedGit({ executable: binding.executablePath,
    args: ["mutate"], cwd: process.argv[1], env: { PATH: "" }, timeout: 3000, maxBuffer: 65536,
    command: "mutate", excludedRoots: [process.argv[1]] }));
  stdout = result.stdout.toString("utf8");
} catch (error) { code = error.code; }
process.stdout.write(JSON.stringify({ code, stdout }));
`, [cwd], { PATH: mutable.bin });
  expect(json(result)).toEqual({ code: "git_binding_invalid", stdout: null });
}, 20_000);

test("Git入口链接在执行中重建时同样固定失败且不返回受限输出", async () => {
  const root = await temp(".pi-company-git-binding-link-", true);
  const bin = join(root, "bin"), targetDir = join(root, "target");
  await mkdir(bin, { mode: 0o755 });
  await mkdir(targetDir, { mode: 0o755 });
  const target = join(targetDir, process.platform === "win32" ? "git.exe" : "git");
  const entry = join(bin, process.platform === "win32" ? "git.exe" : "git");
  await writeFile(target, `#!${process.execPath}\nimport { unlinkSync, symlinkSync } from "node:fs";\nif (process.argv.includes("--version")) process.stdout.write("git version 9.9.4\\n");\nelse { process.stdout.write("linked-restricted-output"); unlinkSync(process.env.ENTRY); symlinkSync(${JSON.stringify(target)}, process.env.ENTRY); }\n`, { mode: 0o755 });
  const { symlink } = await import("node:fs/promises");
  await symlink(target, entry);
  const cwd = await temp("pi-company-link-close-", true);
  const result = await node(`
import { initializeHostGit } from ${JSON.stringify(runtimeUrl)};
import { runManagedGit, withGitProcessSession } from ${JSON.stringify(sessionUrl)};
const binding = initializeHostGit([process.argv[1]]);
let code, stdout = null;
try {
  const result = await withGitProcessSession(undefined, () => runManagedGit({ executable: binding.executablePath,
    args: ["mutate-link"], cwd: process.argv[1], env: { PATH: "", ENTRY: process.env.ENTRY }, timeout: 3000,
    maxBuffer: 65536, command: "mutate-link", excludedRoots: [process.argv[1]] }));
  stdout = result.stdout.toString("utf8");
} catch (error) { code = error.code; }
process.stdout.write(JSON.stringify({ code, stdout }));
`, [cwd], { PATH: bin, ENTRY: entry });
  expect(json(result)).toEqual({ code: "git_binding_invalid", stdout: null });
}, 20_000);

test("超时会杀掉Git子进程并在真实进程组消失后完成登记收尾", async () => {
  const hanging = await fakeGit("timeout", `
if (process.argv.includes("--version")) process.stdout.write("git version 9.9.3\\n");
else setInterval(() => undefined, 1000);`);
  const cwd = await temp("pi-company-timeout-", true);
  const result = await node(`
import { initializeHostGit } from ${JSON.stringify(runtimeUrl)};
import { gitProcessGroupAlive, runManagedGit, withGitProcessSession } from ${JSON.stringify(sessionUrl)};
const binding = initializeHostGit([process.argv[1]]);
let groupId = 0, finished = false;
const command = await withGitProcessSession({ started(id) { groupId = id; }, finished(id) {
  if (id !== groupId || gitProcessGroupAlive(id)) throw new Error("group_not_reaped");
  finished = true;
} }, () => runManagedGit({ executable: binding.executablePath, args: ["hang"], cwd: process.argv[1],
  env: { PATH: "" }, timeout: 100, maxBuffer: 65536, command: "hang", excludedRoots: [process.argv[1]] }));
process.stdout.write(JSON.stringify({ timedOut: command.timedOut, exitCode: command.exitCode, finished,
  groupAlive: gitProcessGroupAlive(groupId) }));
`, [cwd], { PATH: hanging.bin });
  expect(json(result)).toEqual({ timedOut: true, exitCode: -1, finished: true, groupAlive: false });
}, 20_000);

test("超maxBuffer会杀掉Git子进程并在真实进程组消失后完成登记收尾", async () => {
  const noisy = await fakeGit("overflow", `
if (process.argv.includes("--version")) process.stdout.write("git version 9.9.3\\n");
else process.stdout.write("x".repeat(1024 * 1024));`);
  const cwd = await temp("pi-company-overflow-", true);
  const result = await node(`
import { initializeHostGit } from ${JSON.stringify(runtimeUrl)};
import { gitProcessGroupAlive, runManagedGit, withGitProcessSession } from ${JSON.stringify(sessionUrl)};
const binding = initializeHostGit([process.argv[1]]);
let groupId = 0, finished = false;
const command = await withGitProcessSession({ started(id) { groupId = id; }, finished(id) {
  if (id !== groupId || gitProcessGroupAlive(id)) throw new Error("group_not_reaped");
  finished = true;
} }, () => runManagedGit({ executable: binding.executablePath, args: ["noisy"], cwd: process.argv[1],
  env: { PATH: "" }, timeout: 3000, maxBuffer: 1024, command: "noisy", excludedRoots: [process.argv[1]] }));
process.stdout.write(JSON.stringify({ overflow: command.overflow, exitCode: command.exitCode, finished,
  groupAlive: gitProcessGroupAlive(groupId) }));
`, [cwd], { PATH: noisy.bin });
  expect(json(result)).toEqual({ overflow: true, exitCode: -1, finished: true, groupAlive: false });
}, 20_000);

test("错误显式Git和未初始化runtime都在RequirementService首次DB打开前拒绝", async () => {
  const root = await temp("pi-company-zero-db-");
  const dataRoot = join(root, "data"), repositoryRoot = join(root, "repo"), otherBin = join(root, "bin");
  await mkdir(repositoryRoot, { mode: 0o755 });
  await mkdir(otherBin, { mode: 0o755 });
  const otherGit = join(otherBin, process.platform === "win32" ? "git.exe" : "git");
  await writeFile(otherGit, `#!${process.execPath}\nprocess.stdout.write("git version 1.0.0\\n")\n`, { mode: 0o755 });
  await expect(RequirementService.open({ repositoryRoot, dataRoot, repoId: "a".repeat(64), gitExecutable: otherGit,
    authorize: () => true })).rejects.toMatchObject({ code: "untrusted_git" });
  await expect(readFile(join(dataRoot, "repos", "a".repeat(64), "data.db"))).rejects.toMatchObject({ code: "ENOENT" });

  const childRoot = await temp("pi-company-uninitialized-zero-db-");
  const childData = join(childRoot, "data"), childRepo = join(childRoot, "repo");
  await mkdir(childRepo, { mode: 0o755 });
  const uninitialized = await node(`
import { existsSync } from "node:fs";
import { RequirementService } from ${JSON.stringify(serviceUrl)};
let code;
try { await RequirementService.open({ repositoryRoot: process.argv[2], dataRoot: process.argv[1], repoId: "b".repeat(64),
  gitExecutable: process.argv[3], authorize: () => true }); } catch (error) { code = error.code; }
process.stdout.write(JSON.stringify({ code, dataExists: existsSync(process.argv[1]) }));
`, [childData, childRepo, hostBinding.executablePath]);
  expect(json(uninitialized)).toEqual({ code: "untrusted_git", dataExists: false });
}, 20_000);

test("单独加载requirement-manage子扩展在host未统一初始化时零注册拒绝", async () => {
  const result = await node(`
const extension = await import(${JSON.stringify(extensionUrl)});
let accesses = 0, code;
const pi = new Proxy({}, { get() { accesses += 1; return () => { accesses += 1; }; } });
try { extension.default(pi, { dataRoot: process.argv[1] }); } catch (error) { code = error.code; }
process.stdout.write(JSON.stringify({ code, accesses }));
`, [join(tmpdir(), "pi-company-uninitialized-extension-data")]);
  expect(json(result)).toEqual({ code: "git_runtime_uninitialized", accesses: 0 });
});

test("worker把每轮expected新增根纳入spawn前与close复验，冲突时不交付输出", async () => {
  const controlled = await fakeGit("new-root", `
import { appendFileSync, symlinkSync } from "node:fs";
if (process.argv.includes("--version")) process.stdout.write("git version 9.9.8\\n");
else {
  appendFileSync(process.env.COUNTER, "x");
  process.stdout.write("restricted-output");
  if (process.env.MODE === "during") symlinkSync(process.env.BIN, process.env.LATER, "dir");
}`);
  for (const mode of ["before", "during"]) {
    const cwd = await temp(`pi-company-new-root-${mode}-`, true);
    const later = join(cwd, "later-root");
    const counter = join(cwd, "counter");
    await writeFile(counter, "");
    const result = await node(`
import { spawn } from "node:child_process";
import { readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { initializeHostGit, exportGitExpectation } from ${JSON.stringify(runtimeUrl)};
const [cwd, runner, later, bin, executable, counter, mode] = process.argv.slice(1);
const binding = initializeHostGit([cwd]);
const initial = exportGitExpectation([cwd]);
const messages = [];
let shrinkAttempted = false;
const worker = spawn(process.execPath, [runner], { cwd, env: { PATH: "" }, stdio: ["ignore", "ignore", "ignore", "ipc"], detached: true });
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("scenario timeout")), 5000);
  worker.on("message", (message) => {
    messages.push(message);
    if (message.type === "bootstrap-ready") worker.send({ type: "git-init", expected: initial, cwd, excludedRoots: [cwd], identityKey: initial.identityKey });
    if (message.type === "ready") {
      writeFileSync(counter, "");
      const expected = exportGitExpectation([later]);
      if (mode === "before") symlinkSync(bin, later, "dir");
      worker.send({ type: "run", id: 1, executable: binding.executablePath, args: ["command"], cwd,
        env: { PATH: "", COUNTER: counter, MODE: mode, BIN: bin, LATER: later }, timeout: 2000, maxBuffer: 65536,
        expected, identityKey: expected.identityKey, excludedRoots: [cwd] });
    }
    if (message.type === "started") worker.send({ type: "input", id: 1, identityKey: initial.identityKey });
    if (message.type === "binding-failed" && !shrinkAttempted) {
      shrinkAttempted = true;
      worker.send({ type: "run", id: 2, executable: binding.executablePath, args: ["command"], cwd,
        env: { PATH: "", COUNTER: counter, MODE: mode, BIN: bin, LATER: later }, timeout: 2000, maxBuffer: 65536,
        expected: initial, identityKey: initial.identityKey, excludedRoots: [cwd] }, () => undefined);
    }
  });
  worker.once("error", reject);
  worker.once("close", () => { clearTimeout(timer); resolve(); });
});
process.stdout.write(JSON.stringify({ types: messages.map((message) => message.type), shrinkAttempted,
  result: messages.find((message) => message.type === "result") ?? null, counter: readFileSync(counter, "utf8") }));
`, [cwd, runnerPath, later, controlled.bin, controlled.executable, counter, mode], { PATH: controlled.bin });
    const outcome = json(result);
    expect(outcome.types).toContain("binding-failed");
    expect(outcome.shrinkAttempted).toBe(true);
    expect(outcome.result).toBeNull();
    expect(outcome.counter).toBe(mode === "before" ? "" : "x");
  }
}, 30_000);

test("worker锁存错误input并以单调run id安全忽略已完成旧input", async () => {
  const controlled = await fakeGit("input-state", `
if (process.argv.includes("--version")) process.stdout.write("git version 9.9.9\\n");
else if (process.argv.includes("quick")) process.stdout.write("quick-output");
else {
  process.stdout.write("restricted-output");
  process.stdin.resume();
  process.stdin.on("end", () => process.exit(0));
}`);
  const cwd = await temp("pi-company-input-state-", true);
  const matrix = await node(`
import { spawn } from "node:child_process";
import { initializeHostGit, exportGitExpectation } from ${JSON.stringify(runtimeUrl)};
const [cwd, runner] = process.argv.slice(1);
const binding = initializeHostGit([cwd]);
const expected = exportGitExpectation([cwd]);
async function scenario(kind) {
  const messages = [];
  const worker = spawn(process.execPath, [runner], { cwd, env: { PATH: "" }, stdio: ["ignore", "ignore", "ignore", "ipc"], detached: true });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(kind + " timeout")), 5000);
    worker.on("message", (message) => {
      messages.push(message);
      if (message.type === "bootstrap-ready") worker.send({ type: "git-init", expected, cwd, excludedRoots: [cwd], identityKey: expected.identityKey });
      if (message.type === "ready") {
        if (kind === "early") worker.send({ type: "input", id: 1, identityKey: expected.identityKey });
        else worker.send({ type: "run", id: 1, executable: binding.executablePath, args: [kind === "old" ? "quick" : "wait"], cwd,
          env: { PATH: "" }, timeout: 2000, maxBuffer: 65536, expected, identityKey: expected.identityKey, excludedRoots: [cwd] });
      }
      if (message.type === "started" && message.id === 1 && kind !== "old") {
        if (kind === "wrong-key") setTimeout(() => worker.send({ type: "input", id: 1, identityKey: "0".repeat(64) }), 100);
        if (kind === "duplicate") {
          worker.send({ type: "input", id: 1, identityKey: expected.identityKey });
          worker.send({ type: "input", id: 1, identityKey: expected.identityKey });
        }
        if (kind === "future") worker.send({ type: "input", id: 2, identityKey: expected.identityKey });
        if (kind === "invalid") worker.send({ type: "input", id: 1, identityKey: expected.identityKey, extra: true });
      }
      if (message.type === "result" && message.id === 1 && kind === "old") {
        worker.send({ type: "input", id: 1, identityKey: "0".repeat(64) });
        worker.send({ type: "run", id: 2, executable: binding.executablePath, args: ["quick"], cwd,
          env: { PATH: "" }, timeout: 2000, maxBuffer: 65536, expected, identityKey: expected.identityKey, excludedRoots: [cwd] });
      }
      if (message.type === "started" && message.id === 2 && kind === "old") {
        worker.send({ type: "input", id: 1, identityKey: "0".repeat(64) });
        worker.send({ type: "input", id: 2, identityKey: expected.identityKey });
      }
      if (message.type === "result" && message.id === 2 && kind === "old") worker.send({ type: "shutdown" });
    });
    worker.once("error", reject);
    worker.once("close", () => { clearTimeout(timer); resolve(); });
  });
  return messages;
}
const failures = {};
for (const kind of ["early", "wrong-key", "duplicate", "future", "invalid"]) {
  const messages = await scenario(kind);
  failures[kind] = { types: messages.map((message) => message.type), result: messages.find((message) => message.type === "result") ?? null };
}
const old = await scenario("old");
process.stdout.write(JSON.stringify({ failures, oldResults: old.filter((message) => message.type === "result").map((message) => ({ id: message.id, stdout: Buffer.from(message.stdout, "base64").toString("utf8") })) }));
`, [cwd, runnerPath], { PATH: controlled.bin });
  const outcome = json(matrix) as { failures: Record<string, { types: string[]; result: unknown }>; oldResults: unknown[] };
  expect(outcome.failures.early.types).toEqual(["bootstrap-ready", "ready"]);
  for (const kind of ["wrong-key", "duplicate", "future", "invalid"]) {
    expect(outcome.failures[kind]!.types).toContain("binding-failed");
    expect(outcome.failures[kind]!.result).toBeNull();
  }
  expect(outcome.oldResults).toEqual([{ id: 1, stdout: "quick-output" }, { id: 2, stdout: "quick-output" }]);
}, 30_000);

test("observer所有hook拒绝Promise与thenable且安全等待迟到延续", async () => {
  const controlled = await fakeGit("observer-sync", `
import { appendFileSync } from "node:fs";
if (process.argv.includes("--version")) { if (process.env.COUNTER) appendFileSync(process.env.COUNTER, "v"); process.stdout.write("git version 9.9.7\\n"); }
else { if (process.env.COUNTER) appendFileSync(process.env.COUNTER, "x"); process.stdout.write("ok"); }
`);
  const cwd = await temp("pi-company-observer-sync-", true);
  const counter = join(cwd, "counter");
  for (const [phase, mode] of [["started", "resolve"], ["started", "reject"], ["started", "thenable"], ["started", "reassimilate"],
    ["ready", "reject"], ["running", "reject"], ["finished", "reject"]] as const) {
    await writeFile(counter, "");
    const result = await node(`
import { readFileSync, writeFileSync } from "node:fs";
import { initializeHostGit } from ${JSON.stringify(runtimeUrl)};
import { runManagedGit, withGitProcessSession } from ${JSON.stringify(sessionUrl)};
const [cwd, counter, phase, mode] = process.argv.slice(1);
const binding = initializeHostGit([cwd]);
writeFileSync(counter, "");
let continuation = false, thenCalls = 0, code, stdout = null;
const unhandled = [];
process.on("unhandledRejection", (error) => unhandled.push(String(error)));
const value = () => {
  if (mode === "thenable") return { then() { thenCalls += 1; } };
  if (mode === "reassimilate") {
    const value = {};
    const promise = Promise.resolve(value);
    Object.defineProperty(value, "then", { get() { thenCalls += 1; throw new Error("late then getter"); } });
    return promise;
  }
  return new Promise((resolve, reject) => setTimeout(() => { continuation = true; mode === "resolve" ? resolve("late") : reject(new Error("late")); }, 20));
};
const observer = {
  started() { if (phase === "started") return value(); },
  ready() { if (phase === "ready") return value(); },
  running() { if (phase === "running") return value(); },
  finished() { if (phase === "finished") return value(); },
};
try {
  const command = await withGitProcessSession(observer, () => runManagedGit({ executable: binding.executablePath,
    args: ["plain"], cwd, env: { PATH: "", COUNTER: counter }, timeout: 2000, maxBuffer: 65536,
    command: "plain", excludedRoots: [cwd] }));
  stdout = command.stdout.toString("utf8");
} catch (error) { code = error.code; }
await new Promise((resolve) => setTimeout(resolve, 60));
process.stdout.write(JSON.stringify({ code, stdout, continuation, thenCalls, unhandled, counter: readFileSync(counter, "utf8") }));
`, [cwd, counter, phase, mode], { PATH: controlled.bin, COUNTER: counter });
    const outcome = json(result);
    expect(outcome).toMatchObject({ code: "observer_async_result", stdout: null, thenCalls: 0, unhandled: [] });
    expect(outcome.continuation).toBe(mode === "thenable" || mode === "reassimilate" ? false : true);
    if (phase === "started") expect(outcome.counter).toBe("");
  }
}, 40_000);

test("observer普通同步返回值兼容，finished后绑定变化阻止最终stdout，空session无需Git初始化", async () => {
  const cwd = await temp("pi-company-observer-final-", true);
  const normal = await withGitProcessSession({ started() { return 1; }, ready() { return "ready"; },
    running() { return false; }, finished() { return { ok: true }; } }, () => runManagedGit({ executable: hostBinding.executablePath,
    args: ["--version"], cwd, env: { PATH: "", LANG: "C", LC_ALL: "C" }, timeout: 2000, maxBuffer: 65536,
    command: "version", excludedRoots: [cwd] }));
  expect(normal.exitCode).toBe(0);

  const mutable = await fakeGit("finished-mutate", `if (process.argv.includes("--version")) process.stdout.write("git version 9.9.6\\n"); else process.stdout.write("secret");`);
  const mutated = await node(`
import { chmodSync } from "node:fs";
import { initializeHostGit } from ${JSON.stringify(runtimeUrl)};
import { runManagedGit, withGitProcessSession } from ${JSON.stringify(sessionUrl)};
const binding = initializeHostGit([process.argv[1]]);
let code, stdout = null;
try {
  const result = await withGitProcessSession({ started() {}, finished() { chmodSync(binding.executablePath, 0o775); } },
    () => runManagedGit({ executable: binding.executablePath, args: ["plain"], cwd: process.argv[1], env: { PATH: "" },
      timeout: 2000, maxBuffer: 65536, command: "plain", excludedRoots: [process.argv[1]] }));
  stdout = result.stdout.toString("utf8");
} catch (error) { code = error.code; }
process.stdout.write(JSON.stringify({ code, stdout }));
`, [cwd], { PATH: mutable.bin });
  expect(json(mutated)).toEqual({ code: "git_binding_invalid", stdout: null });

  const empty = await node(`
import { withGitProcessSession } from ${JSON.stringify(sessionUrl)};
let code, value;
try { value = await withGitProcessSession(undefined, async () => 42); } catch (error) { code = error.code; }
process.stdout.write(JSON.stringify({ code: code ?? null, value }));
`);
  expect(json(empty)).toEqual({ code: null, value: 42 });
}, 30_000);

test("rawRunner回调异常经真实close与PGID消失后才报告且安全根仍可清理", async () => {
  let ownedRoot = "";
  await expect(rawRunner((_worker, message, context) => {
    ownedRoot = context.cwd;
    if (message.type === "bootstrap-ready") throw new Error("controlled callback failure");
  })).rejects.toMatchObject({ message: "controlled callback failure", cleanupConfirmed: true });
  expect(ownedRoot).not.toBe("");
  expect(retainedRoots.has(ownedRoot)).toBe(true);
  retainedRoots.delete(ownedRoot);
});

test("rawRunner发送失败也统一等待真实close与PGID消失", async () => {
  let ownedRoot = "";
  await expect(rawRunner((_worker, message, context) => {
    ownedRoot = context.cwd;
    if (message.type === "bootstrap-ready") {
      const cyclic: Record<string, unknown> = { type: "git-init" };
      cyclic.self = cyclic;
      context.send(cyclic);
    }
  })).rejects.toMatchObject({ cleanupConfirmed: true });
  expect(ownedRoot).not.toBe("");
  expect(retainedRoots.has(ownedRoot)).toBe(true);
  retainedRoots.delete(ownedRoot);
});

test("探针收尾故障矩阵：旧组只读、未上报退出保全、首错与外层结束保护活根", async () => {
  const text = await readFile(fileURLToPath(import.meta.url), "utf8");
  const source = stripTypeScriptTypes(text.slice(text.indexOf("function groupAlive("), text.indexOf("function json(")));
  for (const scenario of ["closed-number", "early-nonzero", "early-zero", "stop-failed", "outer-finish", "late-report", "delayed-close"]) {
    const child = Object.assign(new EventEmitter(), { pid: 555, exitCode: null as number | null,
      signalCode: null as string | null, stdout: new EventEmitter(), stderr: new EventEmitter() });
    const kept = new Set<string>();
    const signals: { pid: number; signal: string | number; closed: boolean }[] = [];
    let clock = 0, closed = false;
    const context = {
      roots: ["controlled-root"], retainedRoots: kept, Buffer, productRoot: "/controlled", console,
      setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms >= 1000 ? 200 : ms), clearTimeout,
      performance: { now: () => clock += 2000 },
      spawn: () => child,
      process: { execPath: "controlled-node", env: {}, kill(pid: number, signal: string | number) {
        signals.push({ pid, signal, closed });
        if (signal !== 0) {
          if (scenario === "stop-failed") throw Object.assign(new Error("denied"), { code: "EPERM" });
          return;
        }
        if (scenario === "closed-number" && pid === -777) throw Object.assign(new Error("unknown"), { code: "EPERM" });
        throw Object.assign(new Error("gone"), { code: "ESRCH" });
      } },
    };
    const harness = runInNewContext(`${source}\n({ node, activeProbes, drainActiveProbes })`, context);
    const pending: Promise<ProbeResult> = harness.node("controlled");
    expect(harness.activeProbes.size).toBe(1);
    const finish = (code: number) => { closed = true; child.exitCode = code; child.emit("close", code, null); };
    if (scenario === "delayed-close") {
      const result = await pending;
      expect(result.error?.message).toContain("未观察到真实close");
      expect(kept.has("controlled-root")).toBe(true);
      expect(harness.activeProbes.size).toBe(1);
      const cleanup: Promise<void> = [...harness.activeProbes][0].done;
      finish(1);
      await cleanup;
    } else if (scenario === "closed-number") {
      child.emit("message", { type: "test-detached-group", groupId: 777 });
      child.emit("message", { type: "test-probe-complete", groups: [{ groupId: 777, closed: true }] });
      finish(0);
    } else if (scenario === "early-zero" || scenario === "early-nonzero") {
      finish(scenario === "early-zero" ? 0 : 3);
    } else if (scenario === "outer-finish") {
      const draining: Promise<void> = harness.drainActiveProbes();
      expect(kept.has("controlled-root")).toBe(true);
      expect(harness.activeProbes.size).toBe(1);
      finish(1);
      await draining;
    } else {
      [...harness.activeProbes][0].stop(new Error("first failure"));
      expect(kept.has("controlled-root")).toBe(true);
      expect(harness.activeProbes.size).toBe(1);
      finish(1);
      child.emit("message", { type: "test-detached-group", groupId: 777 });
    }
    const result = await pending;
    expect(result.error).toBeDefined();
    expect(kept.has("controlled-root")).toBe(true);
    expect(harness.activeProbes.size).toBe(0);
    expect(signals.filter((item) => item.signal !== 0).every((item) => item.pid === -555 && !item.closed)).toBe(true);
    if (scenario === "closed-number") expect(signals.every((item) => item.signal === 0)).toBe(true);
  }
});

test("真实Node提前退出、超时和外层收尾均保全根并等活句柄结束", async () => {
  for (const scenario of ["zero", "nonzero", "timeout", "outer-finish"]) {
    const root = await temp("pi-company-node-cleanup-");
    const source = scenario === "zero" ? "process.exit(0)" : scenario === "nonzero" ? "process.exit(3)" : "setInterval(() => {}, 1000)";
    const pending = node(source, [], {}, scenario === "timeout" ? 100 : 30_000);
    if (scenario === "outer-finish") {
      const draining = drainActiveProbes();
      expect(retainedRoots.has(root)).toBe(true);
      await draining;
    }
    const result = await pending;
    expect(result.error?.message).toContain(scenario === "timeout" ? "node probe timeout" : scenario === "outer-finish"
      ? "测试结束时探针尚未收尾" : "异常退出或缺少完整收尾证明");
    expect(activeProbes.size).toBe(0);
    expect(retainedRoots.has(root)).toBe(true);
    if (scenario === "zero" || scenario === "nonzero") expect(result.status).toBe(scenario === "zero" ? 0 : 3);
    else expect(result.signal).toBe("SIGKILL");
    // 该固定脚本不创建任何子进程；已确认close且没有组存活错误，允许清理自产空根。
    retainedRoots.delete(root);
  }
}, 10_000);

test("探针上报异常设置失败，记录完整性缺失不能被正常退出冒充", async () => {
  const text = await readFile(fileURLToPath(import.meta.url), "utf8");
  const source = stripTypeScriptTypes(text.slice(text.indexOf("function groupAlive("), text.indexOf("function json(")));
  for (const mode of ["throw", "callback"]) {
    const probe = Object.assign(new EventEmitter(), { pid: 555, exitCode: null as number | null, signalCode: null,
      stdout: new EventEmitter(), stderr: new EventEmitter() });
    let preload = "";
    const harness = runInNewContext(`${source}\n({ node })`, {
      roots: [], retainedRoots: new Set(), Buffer, productRoot: "/controlled", console, setTimeout, clearTimeout, performance,
      process: { execPath: "controlled", env: {}, kill() { throw Object.assign(new Error("gone"), { code: "ESRCH" }); } },
      spawn: (_exe: string, args: string[]) => { preload = decodeURIComponent(args[1]!.slice("data:text/javascript,".length)); return probe; },
    });
    const pending: Promise<ProbeResult> = harness.node("controlled");
    const events = Object.assign(new EventEmitter(), { connected: true, exitCode: 0,
      send(_message: unknown, callback: (error: Error) => void) {
        if (mode === "throw") throw new Error("send throw");
        callback(new Error("send callback"));
      }, disconnect() { this.connected = false; } });
    const spawned = Object.assign(new EventEmitter(), { pid: 777 });
    const childProcess = { spawn: () => spawned };
    runInNewContext(preload.replace(/^import .*;\n/gmu, ""), { childProcess, process: events, syncBuiltinESMExports() {} });
    const wrappedSpawn = childProcess.spawn as unknown as (...args: unknown[]) => typeof spawned;
    wrappedSpawn("controlled", [], { detached: true });
    expect(() => spawned.emit("spawn")).not.toThrow();
    expect(events.exitCode).toBe(1);
    expect(() => events.emit("beforeExit")).not.toThrow();
    expect(events.connected).toBe(false);
    probe.exitCode = 1;
    probe.emit("close", 1, null);
    expect((await pending).error).toBeDefined();
  }
});

test("PM fixture的Git初始化失败进入原保全catch并输出已分配root", async () => {
  const fixtureUrl = pathToFileURL(fileURLToPath(new URL("./helpers/pm-intake-fixture.ts", import.meta.url))).href;
  const failedGit = await fakeGit("fixture-version-failed", `process.stderr.write("controlled version failure\\n"); process.exitCode = 2;`);
  const invalidGit = await fakeGit("fixture-invalid", `process.stdout.write("git version 9.9.5\\n");`);
  for (const scenario of ["missing", "version-failed", "invalid-binding"]) {
    const path = scenario === "version-failed" ? failedGit.bin : scenario === "invalid-binding" ? invalidGit.bin : "";
    const result = await node(`
import { chmodSync, existsSync, rmSync } from "node:fs";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
let repoCalls = 0;
childProcess.execFile = () => { repoCalls += 1; throw new Error("unexpected repository subprocess"); };
syncBuiltinESMExports();
await import("jiti/register");
const { initializeHostGit } = await import(${JSON.stringify(runtimeUrl)});
if (process.argv[1] === "invalid-binding") {
  const binding = initializeHostGit([]);
  chmodSync(binding.executablePath, 0o775);
}
const loadedFixture = await import(${JSON.stringify(fixtureUrl)});
const createPmIntakeFixture = loadedFixture.createPmIntakeFixture ?? loadedFixture.default?.createPmIntakeFixture;
let message = "", root = "", existed = false, originalCode;
try { await createPmIntakeFixture(); } catch (error) {
  message = error.message;
  originalCode = error.errors?.[0]?.code;
  root = /保全自有根 ([^ ]+)/u.exec(message)?.[1] ?? "";
  existed = Boolean(root && existsSync(root));
  if (existed && repoCalls === 0 && ["git_not_found", "git_version_failed", "git_unsafe"].includes(originalCode)) {
    rmSync(root, { recursive: true, force: true });
  }
}
process.stdout.write(JSON.stringify({ message, root, existed, originalCode, repoCalls }));
`, [scenario], { PATH: path });
    const outcome = json(result) as { message: string; root: string; existed: boolean; originalCode: string; repoCalls: number };
    expect(outcome.originalCode).toBe(scenario === "missing" ? "git_not_found" : scenario === "version-failed" ? "git_version_failed" : "git_unsafe");
    expect(outcome.repoCalls).toBe(0);
    expect(result.stderr).toContain('"repoRoot":null');
    expect(outcome.message).toContain("PM夹具初始化失败；保全自有根");
    expect(outcome.root).not.toBe("");
    expect(outcome.existed).toBe(true);
    expect(result.stderr).toContain("pm_intake_fixture_setup_preserved");
    expect(result.stderr).toContain(outcome.root);
  }
}, 40_000);
