import { afterEach, expect, test } from "vitest";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import type { Socket } from "node:net";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { DaemonServer } from "../daemon/server.ts";
import { RunManager } from "../daemon/run-manager.ts";
import { RelayQueue } from "../daemon/relay-queue.ts";
import { commandBoundary, sandboxLaunch } from "../runtime/command-boundary.ts";
import { controlToken } from "../runtime/daemon-auth.ts";
import { connectDaemon } from "../runtime/daemon-client.ts";
import { createClock } from "../runtime/clock.ts";
import { repositoryDatabase } from "../runtime/database.ts";
import { collectGitSnapshot } from "../runtime/git-snapshot.ts";
import { readGit } from "../runtime/git-read.ts";
import { daemonSocketPath, repositoryIdentity } from "../runtime/identity.ts";
import { NetworkPauseGate } from "../runtime/network-pause.ts";
import { decodeFrames, encodeFrame, PROTOCOL_VERSION } from "../runtime/protocol.ts";
import { createRangeProtection } from "../runtime/range-protection.ts";
import { RunStore } from "../runtime/run-store.ts";
import { createManagedBashOperations } from "../runtime/shell-bash.ts";
import { ShellRegistry } from "../runtime/shell-registry.ts";

const exec = promisify(execFile);
const cleanups: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function world() {
  const root = await mkdtemp("/private/tmp/pcr-");
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "repo");
  const dataRoot = join(root, "data");
  await mkdir(cwd); await mkdir(dataRoot);
  const git = (...args: string[]) => exec("/usr/bin/git", args, { cwd, timeout: 5000, env: {
    PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@example.invalid",
  } });
  await git("init", "-q");
  await writeFile(join(cwd, "a.ts"), "before A\n");
  await writeFile(join(cwd, "b.ts"), "before B\n");
  await git("add", "."); await git("commit", "-qm", "fixture");
  const { repoId } = await repositoryIdentity(cwd);
  return { root, cwd, dataRoot, git, repoId };
}

function hello(cwd: string, authToken: string) {
  return { authToken, windowId: "test-window", pid: process.pid, sessionId: "test-session", cwd, workspaceRoot: cwd, repoIds: [], protocolVersion: PROTOCOL_VERSION };
}

async function rawClient(path: string) {
  const socket = createConnection(path);
  cleanups.push(() => socket.destroy());
  await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
  socket.setEncoding("utf8");
  let buffer = "";
  let sequence = 0;
  const pending = new Map<string, (frame: any) => void>();
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    const { frames, rest } = decodeFrames(buffer); buffer = rest;
    for (const frame of frames) if (frame.t === "res") pending.get(frame.id)?.(frame);
  });
  return {
    socket,
    async call(method: string, params: Record<string, unknown>, splitText?: string) {
      const id = String(++sequence);
      const response = new Promise<any>((resolve) => pending.set(id, resolve));
      const bytes = Buffer.from(encodeFrame({ t: "req", id, method, params }));
      if (splitText) {
        const split = bytes.indexOf(Buffer.from(splitText)) + 1;
        socket.write(bytes.subarray(0, split));
        await new Promise((resolve) => setTimeout(resolve, 20));
        socket.write(bytes.subarray(split));
      } else socket.write(bytes);
      return response;
    },
  };
}

test("控制连接拒绝伪造身份和错误凭证，真实凭证允许调用且不出现在回复中", async () => {
  const w = await world();
  const token = controlToken(w.dataRoot);
  expect(controlToken(w.dataRoot)).toBe(token);
  expect((await stat(join(w.dataRoot, "global.sqlite"))).mode & 0o777).toBe(0o600);
  const server = new DaemonServer({ repoId: w.repoId, startedAt: "test", authToken: token });
  server.onHello = () => {};
  let calls = 0;
  server.registerHandler("runs.stopAll", () => { calls++; return { stopped: true }; });
  server.markHandlersReady();
  const socketPath = join(w.root, "control.sock");
  await server.listen(socketPath); cleanups.push(() => server.close());
  const client = await rawClient(socketPath);
  expect((await client.call("hello", hello(w.cwd, "forged"))).ok).toBe(false);
  expect((await client.call("runs.stopAll", {})).ok).toBe(false);
  expect(calls).toBe(0);
  const accepted = await client.call("hello", hello(w.cwd, token));
  expect(accepted.ok).toBe(true);
  expect(JSON.stringify(accepted)).not.toContain(token);
  expect((await client.call("runs.stopAll", {})).ok).toBe(true);
  expect(calls).toBe(1);
});

test("受管命令不能连接控制目录 socket 或读取控制凭证，获准目录 socket 可用", async () => {
  const w = await world();
  controlToken(w.dataRoot);
  const deniedPath = join(w.dataRoot, "control.sock");
  const allowedPath = join(w.cwd, "test.sock");
  for (const path of [deniedPath, allowedPath]) {
    const server = createServer((socket) => socket.end("connected"));
    await new Promise<void>((resolve) => server.listen(path, resolve));
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  }
  const boundary = await commandBoundary({ cwd: w.cwd, dataRoot: w.dataRoot, writePaths: [], foreignPaths: [] });
  const node = await realpath(process.execPath);
  boundary.readRoots.push(dirname(node));
  const run = (source: string) => {
    // 普通 Shell 允许启动子进程，但仍受文件与控制 socket 边界约束。
    const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
    const launch = sandboxLaunch(`${quote(node)} -e ${quote(source)}`, boundary);
    return exec(launch.command, launch.args, { cwd: w.cwd, env: launch.env, timeout: 3000 });
  };
  const connect = (path: string) => `const s=require('node:net').createConnection(${JSON.stringify(path)});s.on('data',b=>process.stdout.write(b));s.on('error',()=>process.exitCode=1);`;
  await expect(run(connect(deniedPath))).rejects.toThrow();
  expect((await run(connect(allowedPath))).stdout).toBe("connected");
  await expect(run(`require('node:fs').readFileSync(${JSON.stringify(join(w.dataRoot, "global.sqlite"))})`)).rejects.toThrow();
});

test("Git 快照禁用 fsmonitor 与 textconv，无法在仓库外执行辅助程序", async () => {
  const w = await world();
  const marker = join(w.root, "outside-marker");
  const helper = join(w.cwd, "helper.sh");
  await writeFile(helper, `#!/bin/sh\nprintf invoked > '${marker}'\nprintf '\\0'\n`, { mode: 0o700 });
  await w.git("config", "core.fsmonitor", helper);
  await w.git("config", "diff.audit.textconv", helper);
  await writeFile(join(w.cwd, ".gitattributes"), "*.ts diff=audit\n");
  await writeFile(join(w.cwd, "a.ts"), "changed\n");
  expect((await collectGitSnapshot({ repoRoot: w.cwd })).head).toMatch(/^[0-9a-f]+$/);
  await expect(stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
  expect((await readGit(w.cwd, ["diff", "HEAD"])).stdout).toContain("changed");
  // 即使调用入口被误用，进程仍没有写权限。
  await expect(readGit(w.cwd, ["config", "audit.write", "forbidden"])).rejects.toThrow();
  await expect(readGit(w.cwd, ["config", "--get", "audit.write"])).rejects.toThrow();
});

test("服务端跨汉字字节分包仍保留完整中文答复", async () => {
  const w = await world();
  const token = controlToken(w.dataRoot);
  const server = new DaemonServer({ repoId: w.repoId, startedAt: "test", authToken: token });
  server.onHello = () => {};
  server.registerHandler("relay.forward", (params) => ({ message: params.message })); server.markHandlersReady();
  const path = join(w.root, "server.sock");
  await server.listen(path); cleanups.push(() => server.close());
  const client = await rawClient(path);
  await client.call("hello", hello(w.cwd, token));
  const result = await client.call("relay.forward", { requirement: "test", message: "确认", windowId: "test-window" }, "确");
  expect(result.result.message).toBe("确认");
});

test("生产客户端携带凭证并正确解码跨包中文响应", async () => {
  const w = await world();
  const path = daemonSocketPath(w.dataRoot, w.repoId);
  await mkdir(dirname(path), { recursive: true });
  const sockets = new Set<Socket>();
  let receivedToken: unknown;
  const server = createServer((socket) => {
    sockets.add(socket); socket.on("close", () => sockets.delete(socket)); socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const { frames, rest } = decodeFrames(buffer); buffer = rest;
      for (const frame of frames) {
        if (frame.t !== "req") continue;
        if (frame.method === "hello") {
          receivedToken = frame.params.authToken;
          socket.write(encodeFrame({ t: "res", id: frame.id, ok: true, result: { repoId: w.repoId } }));
        } else {
          const bytes = Buffer.from(encodeFrame({ t: "res", id: frame.id, ok: true, result: { message: "确认" } }));
          const split = bytes.indexOf(Buffer.from("确")) + 1;
          socket.write(bytes.subarray(0, split)); setTimeout(() => socket.write(bytes.subarray(split)), 20);
        }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  cleanups.push(async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  const client = await connectDaemon({ repoDir: w.cwd, dataRoot: w.dataRoot, sdkDir: w.root, hello: hello(w.cwd, "unused") });
  cleanups.push(() => client.close());
  expect(receivedToken).toBe(controlToken(w.dataRoot));
  expect(await client.call("ping")).toEqual({ message: "确认" });
});

test("两个真实受管命令并行修改各自文件时不误报，越界写仍被阻止", async () => {
  const w = await world();
  const clock = createClock(); cleanups.push(() => clock.stopGapWatcher());
  const shells = new ShellRegistry({ clock, database: repositoryDatabase(w.dataRoot, w.repoId) });
  const store = new RunStore({ dataRoot: w.dataRoot, repoId: w.repoId, daemonStartedAt: "test" });
  const runs = await Promise.all(["a", "b"].map((name) => store.create({ kind: "role", standalone: true, role: "pi-company.worker", requirement: `2026-09-10.${name}`, task: name,
    cwd: w.cwd, writePaths: [`${name}.ts`], readPaths: [w.cwd], model: { provider: "test", id: "test" }, thinking: "off", mcp: [] })));
  for (const run of runs) await store.update(run.id, { state: "running" });
  const guards = await Promise.all(runs.map((run) => createRangeProtection({ cwd: w.cwd, dataRoot: w.dataRoot, holder: { kind: "role", runId: run.id, requirement: run.requirement }, writePaths: run.writePaths, clock, shells })));
  cleanups.push(async () => { for (let i = 0; i < runs.length; i++) { await shells.stopHost({ kind: "role", id: runs[i]!.id, runId: runs[i]!.id }); await store.update(runs[i]!.id, { state: "stopped" }); await guards[i]!.release(); } });
  const violations: string[] = [];
  const operations = runs.map((run, i) => createManagedBashOperations({ registry: shells, host: { kind: "role", id: run.id, runId: run.id }, runToken: run.shellToken,
    guard: { ...guards[i]!.commandGuard, after: async (token, outcome) => { const found = await guards[i]!.commandGuard.after(token, outcome); violations.push(...found); return found; } } }));
  for (let i = 0; i < guards.length; i++) expect((await guards[i]!.checkWrite(runs[i]!.writePaths[0]!)).ok).toBe(true);
  let begin!: () => void;
  const begun = new Promise<void>((resolve) => { begin = resolve; });
  const a = operations[0]!.exec(`printf ready; while [ "$(cat b.ts)" != B ]; do sleep 0.01; done; printf A > a.ts`, w.cwd, { timeout: 3, onData: () => begin() });
  await begun;
  const b = operations[1]!.exec("printf B > b.ts", w.cwd, { timeout: 3, onData: () => {} });
  expect((await Promise.all([a, b])).map((result) => result.exitCode)).toEqual([0, 0]);
  expect(violations).toEqual([]);
  for (const run of runs) { const saved = await store.get(run.id); expect(saved.ok && saved.run.state).toBe("running"); }
  const bad = await operations[0]!.exec("printf forbidden > b.ts", w.cwd, { timeout: 3, onData: () => {} });
  expect(bad.exitCode).not.toBe(0); expect(await readFile(join(w.cwd, "b.ts"), "utf8")).toBe("B");
});

test("停止回执保留 Shell 不确定状态，重复停止可核验清理且级联报告失败", async () => {
  const w = await world();
  const clock = createClock(); cleanups.push(() => clock.stopGapWatcher());
  const shells = new ShellRegistry({ clock });
  const store = new RunStore({ dataRoot: w.dataRoot, repoId: w.repoId, daemonStartedAt: "test" });
  const parent = await store.create({ kind: "requirement", requirement: "2026-09-10.stop", task: "parent", cwd: w.cwd, writePaths: [], readPaths: [], model: { provider: "test", id: "test" }, thinking: "off", mcp: [] });
  await store.update(parent.id, { state: "running" });
  const child = await store.create({ ...parent, kind: "role", role: "pi-company.worker", parentRunId: parent.id });
  await store.update(child.id, { state: "running" });
  let clear = false;
  shells.stopHost = async (host) => host.runId === child.id && !clear ? [{ taskId: "uncertain", result: { ok: false, reason: "无法确认进程身份" } }] : [];
  const manager = new RunManager({ dataRoot: w.dataRoot, repoId: w.repoId, runStore: store, shellRegistry: shells,
    networkGate: new NetworkPauseGate(), relayQueue: new RelayQueue({ dataDir: join(w.dataRoot, "repos", w.repoId), deliver: async () => [], locateRequirementAgent: () => undefined }),
    roleCatalog: [], runtime: {} as any, selectModel: () => ({ provider: "test", id: "test" }), clock, workspaceRepoIds: [w.repoId], emit: () => {} });
  const concurrent = await Promise.all([manager.stop(parent.id), manager.stop(parent.id)]);
  for (const result of concurrent) expect(result).toMatchObject({ state: "stopped", confirmed: false, reason: "子运行尚未确认停止" });
  expect(await manager.stop(child.id)).toMatchObject({ state: "stopped", confirmed: false });
  clear = true;
  expect(await manager.stopAll()).toEqual({ results: [{ runId: parent.id, state: "stopped", confirmed: true }] });
});
