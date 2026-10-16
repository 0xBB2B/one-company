import { afterEach, expect, test } from "vitest";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import type { Socket } from "node:net";
import { dirname, join } from "node:path";
import { uuidv7 } from "../src/core/storage/database.ts";
import { promisify } from "node:util";
import { DaemonServer } from "../src/app/daemon/server.ts";
import { RunManager } from "../src/app/daemon/run-manager.ts";
import { controlToken } from "../src/core/host/daemon-auth.ts";
import { connectDaemon } from "../src/core/host/daemon-client.ts";
import { createClock } from "../src/core/policy/clock.ts";
import { collectGitSnapshot } from "../src/core/exec/git-snapshot.ts";
import { readGit } from "../src/core/exec/git-read.ts";
import { daemonSocketPath, repositoryIdentity } from "../src/core/storage/identity.ts";
import { NetworkPauseGate } from "../src/core/host/network-pause.ts";
import { decodeFrames, encodeFrame, PROTOCOL_VERSION } from "../src/core/host/protocol.ts";
import { RunStore } from "../src/modules/agents/run-store.ts";
import { ShellRegistry } from "../src/core/host/shell-registry.ts";
import { randomUUID } from "node:crypto";


const exec = promisify(execFile);
const cleanups: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function world() {
  const root = await mkdtemp("/private/tmp/pcr-");
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "repo");
  const dataRoot = join(root, "data");
  await mkdir(cwd); await mkdir(dataRoot);
  const git = (...args: string[]) => exec("git", args, { cwd, timeout: 5000, env: {
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

function hello(authToken: string) {
  return { authToken, windowId: "test-window", sessionId: "test-session", protocolVersion: PROTOCOL_VERSION };
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
  expect((await stat(join(w.dataRoot, "global.db"))).mode & 0o777).toBe(0o600);
  const server = new DaemonServer({ repoId: w.repoId, startedAt: "test", authToken: token });
  server.onHello = () => {};
  let calls = 0;
  server.registerHandler("pm.overview", () => { calls++; return { items: [] }; });
  server.markHandlersReady();
  const socketPath = join(w.root, "control.sock");
  await server.listen(socketPath); cleanups.push(() => server.close());
  const client = await rawClient(socketPath);
  expect((await client.call("hello", hello("forged"))).ok).toBe(false);
  expect((await client.call("pm.overview", {})).ok).toBe(false);
  expect(calls).toBe(0);
  const accepted = await client.call("hello", hello(token));
  expect(accepted.ok).toBe(true);
  expect(JSON.stringify(accepted)).not.toContain(token);
  expect((await client.call("pm.overview", {})).ok).toBe(true);
  expect(calls).toBe(1);
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
});

test("服务端跨汉字字节分包仍保留完整中文答复", async () => {
  const w = await world();
  const token = controlToken(w.dataRoot);
  const server = new DaemonServer({ repoId: w.repoId, startedAt: "test", authToken: token });
  server.onHello = () => {};
  server.registerHandler("runs.get", (params) => ({ message: params.runId })); server.markHandlersReady();
  const path = join(w.root, "server.sock");
  await server.listen(path); cleanups.push(() => server.close());
  const client = await rawClient(path);
  await client.call("hello", hello(token));
  const result = await client.call("runs.get", { runId: "确认" }, "确");
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
          socket.write(encodeFrame({ t: "res", id: frame.id, ok: true, result: { repoId: w.repoId, protocolVersion: PROTOCOL_VERSION, daemonPid: process.pid,
            startedAt: new Date().toISOString(), daemonInstanceId: randomUUID(), connectionId: randomUUID() } }));
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
  const client = await connectDaemon({ repoDir: w.cwd, dataRoot: w.dataRoot, sdkDir: w.root, hello: hello("unused") });
  cleanups.push(() => client.close());
  expect(receivedToken).toBe(controlToken(w.dataRoot));
  expect(await client.call("ping")).toEqual({ message: "确认" });
});

test("停止回执保留 Shell 不确定状态，重复停止可核验清理且级联报告失败", async () => {
  const w = await world();
  const clock = createClock(); cleanups.push(() => clock.stopGapWatcher());
  const shells = new ShellRegistry({ clock });
  const store = new RunStore({ dataRoot: w.dataRoot, repoId: w.repoId, daemonStartedAt: "test" });
  const parent = await store.create({ kind: "requirement", requirement: uuidv7(), task: "parent", cwd: w.cwd, writePaths: [], readPaths: [], model: { provider: "test", id: "test" }, thinking: "off", mcp: [] });
  await store.update(parent.id, { state: "running" });
  const { id: _parentId, ...base } = parent;
  const child = await store.create({ ...base, kind: "role", role: "one-company.worker", parentRunId: parent.id });
  await store.update(child.id, { state: "running" });
  let clear = false;
  shells.stopHost = async (host) => host.runId === child.id && !clear ? [{ taskId: "uncertain", result: { ok: false, reason: "无法确认进程身份" } }] : [];
  const manager = new RunManager({ dataRoot: w.dataRoot, repoId: w.repoId, runStore: store, shellRegistry: shells,
    networkGate: new NetworkPauseGate(), roleCatalog: [], runtime: {} as any, clock, workspaceRepoIds: [w.repoId], emit: () => {} });
  const concurrent = await Promise.all([manager.stop(parent.id, { reason: "main_agent" }), manager.stop(parent.id, { reason: "main_agent" })]);
  for (const result of concurrent) expect(result).toMatchObject({ state: "stopped", confirmed: false, reason: "子运行尚未确认停止" });
  expect(await manager.stop(child.id, { reason: "main_agent" })).toMatchObject({ state: "stopped", confirmed: false });
  expect(await manager.stop(parent.id, { reason: "main_agent" })).toMatchObject({ state: "stopped", confirmed: false });
  clear = true;
  expect(await manager.stop(parent.id, { reason: "main_agent" })).toEqual({ state: "stopped", confirmed: true });
  expect(await manager.stop(child.id, { reason: "main_agent" })).toEqual({ state: "stopped", confirmed: true });
});
