import { afterEach, expect, test as vitestTest } from "vitest";
import { chmod, mkdir, readFile, rename, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { closeOwnedListener, failAfterOwnedListener } from "../daemon/lifecycle.ts";
import { DaemonServer } from "../daemon/server.ts";
import {
  GIT_EXPECTATION_MAX_BYTES,
  createGitExpectationText,
  decodeGitExpectation,
  verifyPeerGitBinding,
} from "../runtime/git-daemon-binding.ts";
import { createRequest, decodeFrames, encodeFrame, PROTOCOL_VERSION } from "../runtime/protocol.ts";
import type { Frame } from "../runtime/protocol.ts";
import { initializeTestHostGit } from "./helpers/test-git-binding.ts";
import {
  cleanupGitDaemonFixtures,
  ownedTempRoot,
  registerOwnedServer,
  createOwnedSocket,
  withGitDaemonFixtures,
  runJsonChild,
  runOwnedProcess,
} from "./helpers/git-daemon-fixture.ts";

function test(name: string, run: () => Promise<void>, timeout?: number): void {
  vitestTest(name, () => withGitDaemonFixtures(run), timeout);
}

const productRoot = new URL("../", import.meta.url);
const productRootPath = fileURLToPath(productRoot);
initializeTestHostGit([]);

async function temporary(prefix: string): Promise<string> {
  return ownedTempRoot(prefix);
}

function call(socketPath: string, method: string, params: Record<string, unknown>): Promise<Extract<Frame, { t: "res" }>> {
  return new Promise((resolve, reject) => {
    const socket = createOwnedSocket(socketPath);
    let buffer = "";
    let response: Extract<Frame, { t: "res" }> | undefined;
    let failure: Error | undefined;
    const timer = setTimeout(() => {
      failure = new Error(`协议调用超时: ${method}`);
      socket.destroy();
    }, 1_000);
    socket.once("error", (error) => { failure = error; socket.destroy(); });
    socket.once("close", () => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else if (response) resolve(response);
      else reject(new Error("协议连接在响应前关闭"));
    });
    socket.once("connect", () => socket.write(encodeFrame(createRequest(method, params))));
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const decoded = decodeFrames(buffer);
      buffer = decoded.rest;
      response = decoded.frames.find((frame): frame is Extract<Frame, { t: "res" }> => frame.t === "res");
      if (response) socket.destroy();
    });
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  if (!predicate()) throw new Error("等待测试条件超时");
}

function hello(expectation: string, token = "token", cwd = tmpdir()): Record<string, unknown> {
  return {
    authToken: token,
    windowId: "window",
    pid: process.pid,
    sessionId: "session",
    cwd,
    workspaceRoot: cwd,
    repoIds: ["repo"],
    protocolVersion: PROTOCOL_VERSION,
    gitExpectation: expectation,
  };
}

async function child(
  source: string,
  args: string[] = [],
  env: NodeJS.ProcessEnv = {},
  timeoutMs = 4_000,
): Promise<Record<string, unknown>> {
  return runJsonChild(productRootPath, source, args, { env, timeoutMs });
}

afterEach(async () => {
  await cleanupGitDaemonFixtures();
});

test("严格文本先执行UTF-8 64KiB限制，再解析并保留完整roots", async () => {
  const root = await temporary("git-daemon-text-");
  const text = createGitExpectationText([root]);
  const parsed = decodeGitExpectation(text);
  expect(parsed.excludedRootInputs).toContain(root);
  expect(verifyPeerGitBinding(text, [root], [root]).merged.identityKey).toBe(parsed.identityKey);
  expect(() => decodeGitExpectation("x".repeat(GIT_EXPECTATION_MAX_BYTES + 1))).toThrow(/大小无效/);
  expect(() => decodeGitExpectation("{" )).toThrow(/有效 JSON/);
  expect(() => decodeGitExpectation(JSON.stringify({ schemaVersion: 1 }))).toThrow();
});

test("server先拒绝坏token且不解析坏Git文本；认证成功才合并并回传完整期望", async () => {
  const root = await temporary("git-daemon-server-");
  const socketPath = join(root, "server.sock");
  const expectation = createGitExpectationText([root]);
  const server = registerOwnedServer(new DaemonServer({ authToken: "token", repoId: "repo", startedAt: "test", gitRoots: [root] }));
  await server.listen(socketPath);

  const unauthorized = await call(socketPath, "hello", hello("not-json", "wrong", root));
  expect(unauthorized.ok).toBe(false);
  if (!unauthorized.ok) expect(unauthorized.error.code).toBe("unauthorized");

  const accepted = await call(socketPath, "hello", hello(expectation, "token", root));
  expect(accepted.ok).toBe(true);
  if (accepted.ok) {
    const returned = decodeGitExpectation(accepted.result.gitExpectation);
    expect(returned.identityKey).toBe(decodeGitExpectation(expectation).identityKey);
    expect(returned.excludedRootInputs).toContain(root);
  }

  const legacy = { ...hello(expectation, "token", root) };
  delete legacy.gitExpectation;
  const rejectedLegacy = await call(socketPath, "hello", legacy);
  expect(rejectedLegacy.ok).toBe(false);
  if (!rejectedLegacy.ok) expect(rejectedLegacy.error.code).toBe("bad_params");
});

test("server重hello先退旧身份，旧异步结果不写给新ClientInfo且disconnect只触发一次", async () => {
  const root = await temporary("git-daemon-rehello-");
  const socketPath = join(root, "server.sock");
  const expectation = createGitExpectationText([root]);
  const server = registerOwnedServer(new DaemonServer({ authToken: "token", repoId: "repo", startedAt: "test", gitRoots: [root] }));
  let release!: () => void;
  let handlerStarted = false;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  server.registerHandler("runs.list", async () => { handlerStarted = true; await blocked; return { items: [] }; });
  server.markHandlersReady();
  const disconnected: string[] = [];
  server.onDisconnect = (info) => { disconnected.push(info.sessionId); };
  await server.listen(socketPath);

  const socket = createOwnedSocket(socketPath);
  const frames: Frame[] = [];
  let buffer = "";
  socket.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    const decoded = decodeFrames(buffer);
    buffer = decoded.rest;
    frames.push(...decoded.frames);
  });
  await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
  const firstHello = createRequest("hello", { ...hello(expectation, "token", root), sessionId: "first" });
  socket.write(encodeFrame(firstHello));
  await waitFor(() => frames.some((frame) => frame.t === "res" && frame.id === firstHello.id));
  const pending = createRequest("runs.list", {});
  socket.write(encodeFrame(pending));
  await waitFor(() => handlerStarted);
  const secondHello = createRequest("hello", { ...hello(expectation, "token", root), sessionId: "second" });
  socket.write(encodeFrame(secondHello));
  await waitFor(() => frames.some((frame) => frame.t === "res" && frame.id === secondHello.id));
  release();
  await new Promise((resolve) => setTimeout(resolve, 50));

  expect(frames.some((frame) => frame.t === "res" && frame.id === pending.id)).toBe(false);
  expect(disconnected).toEqual(["first"]);
  socket.destroy();
});

test("bootstrap坏继承期望在SDK导入和dataRoot写入前退出，同一loader保持同一runtime实例", async () => {
  const root = await temporary("git-daemon-bootstrap-");
  const dataRoot = join(root, "data");
  const sdkDir = join(root, "sdk");
  const marker = join(root, "sdk-loaded");
  await mkdir(join(sdkDir, "dist"), { recursive: true });
  await writeFile(join(sdkDir, "package.json"), JSON.stringify({ version: "99.0.0", type: "module" }));
  await writeFile(join(sdkDir, "dist", "index.js"), `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "loaded"); export {};`);
  const bootstrap = new URL("daemon/bootstrap.mjs", productRoot);
  const bootstrapResult = await runOwnedProcess(process.execPath, [bootstrap.pathname], root, {
    env: {
      PI_COMPANY_EXPECTED_GIT: "{bad",
      PI_COMPANY_REPO_DIR: root,
      PI_COMPANY_DATA_ROOT: dataRoot,
      PI_COMPANY_SDK_DIR: sdkDir,
    },
  });
  expect(bootstrapResult.code).toBe(1);
  await expect(import("node:fs/promises").then(({ stat }) => stat(dataRoot))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(import("node:fs/promises").then(({ stat }) => stat(marker))).rejects.toMatchObject({ code: "ENOENT" });

  const loaderResult = await child(`
import { daemonLoader } from "./daemon/loader.mjs";
const a = await daemonLoader.import(new URL("./runtime/git-runtime.mjs", import.meta.url).href);
const b = await daemonLoader.import(new URL("./runtime/git-runtime.mjs", import.meta.url).href);
const binding = await daemonLoader.import(new URL("./runtime/git-daemon-binding.ts", import.meta.url).href);
process.stdout.write(JSON.stringify({ sameNamespace: a === b, sameExport: a.currentHostGit === b.currentHostGit,
  bindingUsesState: typeof binding.createGitExpectationText === "function" }));
`);
  expect(loaderResult).toEqual({ sameNamespace: true, sameExport: true, bindingUsesState: true });
});

test("root总预算超过256时拒绝，不缩减或截断", async () => {
  const result = await child(`
import { initializeHostGit, exportGitExpectation } from "./runtime/git-runtime.mjs";
initializeHostGit([]);
let code;
try { exportGitExpectation(Array.from({ length: 257 }, (_, i) => "/tmp/git-daemon-budget-" + i)); }
catch (error) { code = error.code; }
process.stdout.write(JSON.stringify({ code }));
`);
  expect(result).toEqual({ code: "git_expectation_invalid" });
});

test("受控spawn最终环境覆盖调用者伪造期望", async () => {
  const root = await temporary("git-daemon-env-");
  const result = await child(`
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { dirname, join } from "node:path";
import { initializeHostGit } from "./runtime/git-runtime.mjs";
const root = process.argv[1], repo = join(root, "repo"), data = join(root, "data");
mkdirSync(repo, { recursive: true });
const binding = initializeHostGit([root]);
const git = (args) => childProcess.execFileSync(binding.executablePath, args, { cwd: repo,
  env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@example.com" } });
git(["init", "-b", "main"]); writeFileSync(join(repo, "README.md"), "fixture\\n"); git(["add", "README.md"]); git(["commit", "-m", "init"]);
let captured = null, calls = 0;
childProcess.spawn = function (_exec, _args, options) {
  calls += 1; captured = options.env.PI_COMPANY_EXPECTED_GIT;
  const proc = Object.assign(new EventEmitter(), { pid: 900001, unref() {} });
  queueMicrotask(() => proc.emit("error", Object.assign(new Error("controlled spawn stop"), { code: "ENOENT" })));
  return proc;
};
syncBuiltinESMExports();
const loadedClient = await import("./runtime/daemon-client.ts");
const daemonClient = loadedClient.default ?? loadedClient;
let message = "";
try { await daemonClient.connectDaemon({ repoDir: repo, dataRoot: data, sdkDir: root, env: { PI_COMPANY_EXPECTED_GIT: "attacker" },
  execPath: process.execPath, hello: { windowId: "w", pid: process.pid, sessionId: "s", cwd: repo, workspaceRoot: repo } }); }
catch (error) { message = error.message; }
const parsed = captured === null ? null : JSON.parse(captured);
process.stdout.write(JSON.stringify({ calls, overridden: captured !== "attacker", identityKey: parsed?.identityKey ?? null, message }));
`, [root]);
  expect(result.calls, JSON.stringify(result)).toBe(1);
  expect(result.overridden).toBe(true);
  expect(result.identityKey).toMatch(/^[0-9a-f]{64}$/u);
  expect(result.message).toContain("controlled spawn stop");
});

test("ping监听不构成公开spawnDaemon的认证就绪，旧hello回复终止且保留原socket", async () => {
  const root = await temporary("git-daemon-ping-");
  const result = await child(`
import childProcess from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { initializeHostGit } from "./runtime/git-runtime.mjs";
const loadedIdentity = await import("./runtime/identity.ts");
const identityModule = loadedIdentity.default ?? loadedIdentity;
const loadedProtocol = await import("./runtime/protocol.ts");
const protocol = loadedProtocol.default ?? loadedProtocol;
const loadedClient = await import("./runtime/daemon-client.ts");
const daemonClient = loadedClient.default ?? loadedClient;
const root = process.argv[1], repo = join(root, "repo"), data = join(root, "data");
mkdirSync(repo, { recursive: true });
const binding = initializeHostGit([root]);
const git = (args) => childProcess.execFileSync(binding.executablePath, args, { cwd: repo,
  env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@example.com" } });
git(["init", "-b", "main"]); writeFileSync(join(repo, "README.md"), "fixture\\n"); git(["add", "README.md"]); git(["commit", "-m", "init"]);
const identity = await identityModule.repositoryIdentity(repo), socketPath = identityModule.daemonSocketPath(data, identity.repoId);
mkdirSync(dirname(socketPath), { recursive: true });
let hellos = 0, pings = 0;
const server = createServer((socket) => { let buffer = ""; socket.on("data", (chunk) => {
  buffer += chunk.toString("utf8"); const decoded = protocol.decodeFrames(buffer); buffer = decoded.rest;
  for (const frame of decoded.frames) if (frame.t === "req") {
    if (frame.method === "ping") { pings += 1; socket.write(protocol.encodeFrame(protocol.createResponse(frame.id, { now: Date.now() }))); }
    if (frame.method === "hello") { hellos += 1; socket.write(protocol.encodeFrame(protocol.createResponse(frame.id,
      { daemonPid: process.pid, repoId: identity.repoId, protocolVersion: 2, startedAt: "test" }))); }
  }
}); });
await new Promise((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
let code;
try { await daemonClient.spawnDaemon({ repoDir: repo, dataRoot: data, sdkDir: root, hello:
  { windowId: "w", pid: process.pid, sessionId: "s", cwd: repo, workspaceRoot: repo } }); }
catch (error) { code = error.code; }
const socketPreserved = existsSync(socketPath);
await new Promise((resolve) => server.close(resolve));
process.stdout.write(JSON.stringify({ code, hellos, pings, socketPreserved }));
`, [root]);
  expect(result).toEqual({ code: "daemon_identity_mismatch", hellos: 1, pings: 0, socketPreserved: true });
});

test("本地Git失效阻断cached/identity/逐listener与await后RPC交付，且不重试不删除原socket", async () => {
  for (const scenario of ["connected-listener", "remote-event", "rpc-result"]) {
    const root = await temporary(`git-daemon-client-gate-${scenario}-`);
    const childDataRoot = await temporary("gd-");
    const result = await child(`
import childProcess from "node:child_process";
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { initializeHostGit } from "./runtime/git-runtime.mjs";
const identityLoaded = await import("./runtime/identity.ts"), identityApi = identityLoaded.default ?? identityLoaded;
const protocolLoaded = await import("./runtime/protocol.ts"), protocol = protocolLoaded.default ?? protocolLoaded;
const clientLoaded = await import("./runtime/daemon-client.ts"), clientApi = clientLoaded.default ?? clientLoaded;
const root = process.argv[1], scenario = process.argv[2], data = process.argv[3], repo = join(root, "repo"), later = join(root, "later");
mkdirSync(repo, { recursive: true });
const binding = initializeHostGit([root, later]);
const git = (args) => childProcess.execFileSync(binding.executablePath, args, { cwd: repo,
  env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@example.com" } });
git(["init", "-b", "main"]); writeFileSync(join(repo, "README.md"), "fixture\\n"); git(["add", "README.md"]); git(["commit", "-m", "init"]);
const identity = await identityApi.repositoryIdentity(repo), socketPath = identityApi.daemonSocketPath(data, identity.repoId);
mkdirSync(dirname(socketPath), { recursive: true });
let connections = 0, activeSocket;
const response = (id, result) => protocol.encodeFrame(protocol.createResponse(id, result));
const server = createServer((socket) => { connections += 1; activeSocket = socket; let buffer = ""; socket.on("data", (chunk) => {
  buffer += chunk.toString("utf8"); const decoded = protocol.decodeFrames(buffer); buffer = decoded.rest;
  for (const frame of decoded.frames) if (frame.t === "req") {
    if (frame.method === "hello") socket.write(response(frame.id, { daemonPid: process.pid, repoId: identity.repoId,
      protocolVersion: 2, startedAt: "test", daemonInstanceId: "11111111-1111-4111-8111-111111111111",
      connectionId: "22222222-2222-4222-8222-222222222222", gitExpectation: frame.params.gitExpectation }));
    else if (frame.method === "ping") setTimeout(() => socket.write(response(frame.id, { now: Date.now() })), 50);
  }
}); });
await new Promise((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
const client = await clientApi.connectDaemon({ repoDir: repo, dataRoot: data, sdkDir: root,
  hello: { windowId: "w", pid: process.pid, sessionId: "s", cwd: later, workspaceRoot: repo } });
const cachedBefore = await client.call("hello");
let disconnected = [], first = 0, second = 0, code = null;
client.subscribe("daemon.disconnected", (event) => disconnected.push(event));
const mutate = () => symlinkSync(dirname(binding.entryPath), later, "dir");
if (scenario === "connected-listener") {
  client.subscribe("daemon.connected", () => { first += 1; mutate(); });
  client.subscribe("daemon.connected", () => { second += 1; });
  try { client.connectionIdentity(); } catch (error) { code = error.code; }
} else if (scenario === "remote-event") {
  client.subscribe("runs.changed", () => { first += 1; mutate(); });
  client.subscribe("runs.changed", () => { second += 1; });
  activeSocket.write(protocol.encodeFrame({ t: "evt", event: "runs.changed", data: { value: 1 } }));
  await new Promise((resolve) => setTimeout(resolve, 100));
  try { await client.call("hello"); } catch (error) { code = error.code; }
} else {
  const pending = client.call("ping"); mutate();
  try { await pending; } catch (error) { code = error.code; }
}
await new Promise((resolve) => setTimeout(resolve, 500));
const outcome = { scenario, cachedHasGit: Object.hasOwn(cachedBefore, "gitExpectation"), first, second, code,
  disconnected: disconnected.map((event) => ({ willReconnect: event.willReconnect, cause: event.cause })),
  connections, socketPreserved: existsSync(socketPath), status: client.state().status };
client.close(); await new Promise((resolve) => server.close(resolve));
process.stdout.write(JSON.stringify(outcome));
`, [root, scenario, childDataRoot]);
    expect(result.cachedHasGit).toBe(false);
    expect(result.code).toMatch(/^git_/u);
    expect(result.connections).toBe(1);
    expect(result.socketPreserved).toBe(true);
    expect(result.status).toBe("unreachable");
    expect(result.disconnected).toEqual([{ willReconnect: false, cause: "git_binding" }]);
    if (scenario !== "rpc-result") {
      expect(result.first).toBe(1);
      expect(result.second).toBe(0);
    }
  }
}, 30_000);

test("真正transport故障仍按原策略重连并再次完成Git hello", async () => {
  const root = await temporary("git-daemon-transport-");
  const result = await child(`
import childProcess from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { initializeHostGit } from "./runtime/git-runtime.mjs";
const identityLoaded = await import("./runtime/identity.ts"), identityApi = identityLoaded.default ?? identityLoaded;
const protocolLoaded = await import("./runtime/protocol.ts"), protocol = protocolLoaded.default ?? protocolLoaded;
const clientLoaded = await import("./runtime/daemon-client.ts"), clientApi = clientLoaded.default ?? clientLoaded;
const root = process.argv[1], repo = join(root, "repo"), data = join(root, "data"); mkdirSync(repo, { recursive: true });
const binding = initializeHostGit([root]);
const git = (args) => childProcess.execFileSync(binding.executablePath, args, { cwd: repo,
  env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@example.com" } });
git(["init", "-b", "main"]); writeFileSync(join(repo, "README.md"), "fixture\\n"); git(["add", "README.md"]); git(["commit", "-m", "init"]);
const identity = await identityApi.repositoryIdentity(repo), socketPath = identityApi.daemonSocketPath(data, identity.repoId); mkdirSync(dirname(socketPath), { recursive: true });
let connections = 0;
const server = createServer((socket) => { connections += 1; let buffer = ""; socket.on("data", (chunk) => {
  buffer += chunk.toString("utf8"); const decoded = protocol.decodeFrames(buffer); buffer = decoded.rest;
  for (const frame of decoded.frames) if (frame.t === "req" && frame.method === "hello") {
    socket.write(protocol.encodeFrame(protocol.createResponse(frame.id, { daemonPid: process.pid, repoId: identity.repoId,
      protocolVersion: 2, startedAt: "test", daemonInstanceId: "11111111-1111-4111-8111-111111111111",
      connectionId: connections === 1 ? "22222222-2222-4222-8222-222222222222" : "33333333-3333-4333-8333-333333333333",
      gitExpectation: frame.params.gitExpectation })));
    if (connections === 1) setTimeout(() => socket.destroy(), 30);
  }
}); });
await new Promise((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
const client = await clientApi.connectDaemon({ repoDir: repo, dataRoot: data, sdkDir: root,
  hello: { windowId: "w", pid: process.pid, sessionId: "s", cwd: repo, workspaceRoot: repo } });
const lifecycle = []; client.subscribe("daemon.connected", (event) => lifecycle.push({ type: "connected", reconnected: event.reconnected }));
client.subscribe("daemon.disconnected", (event) => lifecycle.push({ type: "disconnected", willReconnect: event.willReconnect }));
const deadline = Date.now() + 5000;
while ((connections < 2 || client.state().status !== "connected") && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
const outcome = { connections, status: client.state().status, lifecycle };
client.close(); await new Promise((resolve) => server.close(resolve)); process.stdout.write(JSON.stringify(outcome));
`, [root], {}, 10_000);
  expect(result.connections).toBeGreaterThanOrEqual(2);
  expect(result.status).toBe("connected");
  expect(result.lifecycle).toContainEqual({ type: "disconnected", willReconnect: true });
  expect(result.lifecycle).toContainEqual({ type: "connected", reconnected: true });
}, 15_000);

test("双hello在handlersReady前和setImmediate中只交付最新身份", async () => {
  for (const mode of ["batch-ready", "sequential-ready", "immediate"] as const) {
    const root = await temporary(`git-daemon-double-${mode}-`);
    const socketPath = join(root, "server.sock");
    const expectation = createGitExpectationText([root]);
    const server = registerOwnedServer(new DaemonServer({ authToken: "token", repoId: "repo", startedAt: "test", gitRoots: [root] }));
    const callbacks: string[] = [];
    const disconnected: string[] = [];
    if (mode === "immediate") server.onHello = async (info) => { callbacks.push(info.sessionId); };
    server.onDisconnect = (info) => { disconnected.push(info.sessionId); };
    await server.listen(socketPath);
    const socket = createOwnedSocket(socketPath);
    const frames: Frame[] = [];
    let buffer = "";
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const decoded = decodeFrames(buffer); buffer = decoded.rest; frames.push(...decoded.frames);
    });
    await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
    const first = createRequest("hello", { ...hello(expectation, "token", root), sessionId: "first" });
    const second = createRequest("hello", { ...hello(expectation, "token", root), sessionId: "second" });
    if (mode === "sequential-ready") {
      socket.write(encodeFrame(first));
      await waitFor(() => frames.some((frame) => frame.t === "res" && frame.id === first.id));
      socket.write(encodeFrame(second));
    } else socket.write(encodeFrame(first) + encodeFrame(second));
    await waitFor(() => frames.some((frame) => frame.t === "res" && frame.id === second.id));
    if (mode !== "immediate") {
      server.onHello = async (info) => { callbacks.push(info.sessionId); };
      server.markHandlersReady();
    }
    await waitFor(() => callbacks.length === 1);
    expect(callbacks, mode).toEqual(["second"]);
    expect(disconnected, mode).toEqual(["first"]);
    expect(server.clients().map((info) => info.sessionId), mode).toEqual(["second"]);
    socket.destroy();
  }
});

test("远端可信git错误立即terminal且不泄露私有载荷或普通重连", async () => {
  const root = await temporary("git-daemon-remote-terminal-");
  const result = await child(`
import childProcess from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { initializeHostGit } from "./runtime/git-runtime.mjs";
const identityLoaded = await import("./runtime/identity.ts"), identityApi = identityLoaded.default ?? identityLoaded;
const protocolLoaded = await import("./runtime/protocol.ts"), protocol = protocolLoaded.default ?? protocolLoaded;
const clientLoaded = await import("./runtime/daemon-client.ts"), clientApi = clientLoaded.default ?? clientLoaded;
const root = process.argv[1], repo = join(root, "repo"), data = join(root, "data"); mkdirSync(repo, { recursive: true });
const binding = initializeHostGit([root]);
const git = (args) => childProcess.execFileSync(binding.executablePath, args, { cwd: repo, env: process.env });
git(["init", "-b", "main"]); writeFileSync(join(repo, "README.md"), "fixture\\n"); git(["add", "README.md"]); git(["commit", "-m", "init"]);
const identity = await identityApi.repositoryIdentity(repo), socketPath = identityApi.daemonSocketPath(data, identity.repoId); mkdirSync(dirname(socketPath), { recursive: true });
let connections = 0;
const server = createServer((socket) => { connections += 1; let buffer = ""; socket.on("data", (chunk) => {
  buffer += chunk.toString("utf8"); const decoded = protocol.decodeFrames(buffer); buffer = decoded.rest;
  for (const frame of decoded.frames) if (frame.t === "req") {
    if (frame.method === "hello") socket.write(protocol.encodeFrame(protocol.createResponse(frame.id, { daemonPid: process.pid,
      repoId: identity.repoId, protocolVersion: 2, startedAt: "test", daemonInstanceId: "11111111-1111-4111-8111-111111111111",
      connectionId: "22222222-2222-4222-8222-222222222222", gitExpectation: frame.params.gitExpectation })));
    else socket.write(protocol.encodeFrame(protocol.createErrorResponse(frame.id, "git_changed", "REMOTE_PRIVATE", { secret: "REMOTE_DATA" })));
  }
}); });
await new Promise((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
const client = await clientApi.connectDaemon({ repoDir: repo, dataRoot: data, sdkDir: root,
  hello: { windowId: "w", pid: process.pid, sessionId: "s", cwd: repo, workspaceRoot: repo } });
const events = []; client.subscribe("daemon.disconnected", (event) => events.push(event));
let error;
try { await client.call("runs.list"); } catch (caught) { error = { code: caught.code, message: caught.message, data: caught.data }; }
await new Promise((resolve) => setTimeout(resolve, 500));
const outcome = { error, events, connections, status: client.state().status, identity: client.connectionIdentity?.() ?? null };
client.close(); await new Promise((resolve) => server.close(resolve)); process.stdout.write(JSON.stringify(outcome));
`, [root]);
  expect(result.error).toEqual({ code: "git_changed", message: "Git 绑定已失效" });
  expect(result.events).toEqual([expect.objectContaining({ willReconnect: false, cause: "git_binding" })]);
  expect(result.connections).toBe(1);
  expect(result.status).toBe("unreachable");
  expect(result.identity).toBeNull();
});

test("首次公开hello的Git拒绝只交付固定错误，不交付私有消息data或cause", async () => {
  const root = await temporary("gh-");
  const result = await child(`
import cp from "node:child_process";
import { mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { join, dirname } from "node:path";
import { initializeHostGit } from "./runtime/git-runtime.mjs";
const i = await import("./runtime/identity.ts"), identity = i.default ?? i;
const p = await import("./runtime/protocol.ts"), protocol = p.default ?? p;
const c = await import("./runtime/daemon-client.ts"), clientApi = c.default ?? c;
const root = process.argv[1], repo = join(root, "repo"), data = join(root, "data");
mkdirSync(repo); const binding = initializeHostGit([root]);
cp.execFileSync(binding.executablePath, ["init", "-b", "main"], { cwd: repo, env: process.env, timeout: 3000 });
const id = await identity.repositoryIdentity(repo), path = identity.daemonSocketPath(data, id.repoId);
mkdirSync(dirname(path), { recursive: true }); let connections = 0;
const server = createServer((socket) => { connections += 1; let buffer = ""; socket.on("data", (chunk) => {
  buffer += chunk.toString(); const decoded = protocol.decodeFrames(buffer); buffer = decoded.rest;
  for (const frame of decoded.frames) if (frame.t === "req") socket.end(protocol.encodeFrame(protocol.createErrorResponse(
    frame.id, "git_changed", "HELLO_PRIVATE", { secret: "HELLO_DATA" })));
}); });
await new Promise((resolve, reject) => { server.once("error", reject); server.listen(path, resolve); });
let outcome;
try { const client = await clientApi.connectDaemon({ repoDir: repo, dataRoot: data, sdkDir: root,
  hello: { windowId: "w", pid: process.pid, sessionId: "s", cwd: repo, workspaceRoot: repo } }); client.close(); outcome = { unexpected: true }; }
catch (error) { outcome = { code: error.code, message: error.message, data: error.data ?? null, cause: error.cause ?? null }; }
await new Promise((resolve) => server.close(resolve));
process.stdout.write(JSON.stringify({ ...outcome, connections }));
`, [root]);
  expect(result).toEqual({ code: "git_changed", message: "Git 绑定已失效", data: null, cause: null, connections: 1 });
});

test("listener归属来自自己的临时socket，取得归属前后替换正式路径均保留替换者", async () => {
  for (const mode of ["before", "after"]) {
    const root = await temporary("gl-");
    const result = await child(`
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
const root = process.argv[1], mode = process.argv[2], target = join(root, "final.sock"), otherPath = join(root, "other.sock");
const originalLink = fs.link;
let originalInode;
fs.link = async (from, to) => {
  await originalLink(from, to);
  if (to === target) {
    originalInode = (await fs.stat(from)).ino;
    if (mode === "before") { await fs.rename(target, target + ".saved"); await originalLink(otherPath, target); }
  }
};
syncBuiltinESMExports();
const s = await import("./daemon/server.ts"), Server = (s.default ?? s).DaemonServer;
const l = await import("./daemon/lifecycle.ts"), lifecycle = l.default ?? l;
const options = { authToken: "token", repoId: "repo", startedAt: "test" };
const own = new Server(options), other = new Server(options);
await other.listen(otherPath); const replacementInode = (await fs.stat(otherPath)).ino;
let outcome;
try {
  const acquired = await lifecycle.listenExclusive(own, target);
  if (mode === "after") {
    if (typeof acquired !== "object") throw new Error("missing ownership");
    await fs.rename(target, target + ".saved"); await originalLink(otherPath, target);
    await lifecycle.closeOwnedListener(own, target, acquired.inode);
  }
  outcome = { mode, rejected: acquired === "retry", ownIdentity: typeof acquired === "object" ? acquired.inode === originalInode : null,
    different: originalInode !== replacementInode, replacementPreserved: (await fs.stat(target)).ino === replacementInode };
} finally { await own.close(); await other.close(); }
process.stdout.write(JSON.stringify(outcome));
`, [root, mode]);
    expect(result).toEqual({ mode, rejected: mode === "before", ownIdentity: mode === "after" ? true : null,
      different: true, replacementPreserved: true });
  }
});

test("hello回复缺少本次raw或canonical请求根均拒绝", async () => {
  const root = await temporary("git-daemon-full-roots-");
  const real = join(root, "real");
  const alias = join(root, "alias");
  await mkdir(real);
  await symlink(real, alias, "dir");
  const exported = JSON.parse(createGitExpectationText([alias])) as { excludedRootInputs: string[]; excludedRoots: string[] };
  const rawOnly = join(root, "request-raw");
  const canonicalOnly = join(root, "request-canonical");
  exported.excludedRootInputs.push(rawOnly);
  exported.excludedRoots.push(canonicalOnly);
  const text = JSON.stringify(exported);
  const parsed = decodeGitExpectation(text);
  const required = [...new Set([...parsed.excludedRootInputs, ...parsed.excludedRoots])];
  const missingRaw = JSON.parse(text) as { excludedRootInputs: string[] };
  missingRaw.excludedRootInputs = missingRaw.excludedRootInputs.filter((value) => value !== rawOnly);
  const missingCanonical = JSON.parse(text) as { excludedRoots: string[] };
  missingCanonical.excludedRoots = missingCanonical.excludedRoots.filter((value) => value !== canonicalOnly);
  expect(() => verifyPeerGitBinding(JSON.stringify(missingRaw), [root], required)).toThrow(/缺少已请求根/);
  expect(() => verifyPeerGitBinding(JSON.stringify(missingCanonical), [root], required)).toThrow(/缺少已请求根/);
});

test("bootstrap默认与显式dataRoot在任何Git版本执行前纳入排除根", async () => {
  for (const mode of ["home", "agent", "explicit"] as const) {
    const root = await temporary(`git-daemon-bootstrap-${mode}-`);
    const home = join(root, "home");
    const agent = join(root, "agent");
    const explicit = join(root, "explicit");
    const dataRoot = mode === "home" ? join(home, ".pi", "agent", "pi-company")
      : mode === "agent" ? join(agent, "pi-company") : explicit;
    const bin = join(dataRoot, "bin");
    const marker = join(root, "git-ran");
    const fakeGit = join(bin, "git");
    await mkdir(bin, { recursive: true });
    await writeFile(fakeGit, `#!/bin/sh\nprintf ran > ${JSON.stringify(marker)}\nprintf 'git version 2.42.0\\n'\n`);
    await chmod(fakeGit, 0o755);
    const repo = join(root, "repo");
    await mkdir(repo);
    const env: NodeJS.ProcessEnv = {
      PATH: bin,
      HOME: home,
      PI_COMPANY_REPO_DIR: repo,
      PI_COMPANY_SDK_DIR: join(root, "sdk"),
      ...(mode === "agent" ? { PI_CODING_AGENT_DIR: agent } : {}),
      ...(mode === "explicit" ? { PI_COMPANY_DATA_ROOT: explicit } : {}),
    };
    const result = await runOwnedProcess(process.execPath, [fileURLToPath(new URL("daemon/bootstrap.mjs", productRoot))], productRootPath, { env });
    expect(result.code, `${mode}: ${result.stderr}`).toBe(1);
    await expect(stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
  }
});

test("listener关闭失败仍释放匹配inode并保留原Git错误；替换inode不删除", async () => {
  const root = await temporary("git-daemon-owned-listener-");
  const socketPath = join(root, "owned.sock");
  await writeFile(socketPath, "owned");
  const inode = (await stat(socketPath)).ino;
  const gitError = Object.assign(new Error("git failed"), { code: "git_changed" });
  const closeError = new Error("close failed");
  let caught: unknown;
  try {
    await failAfterOwnedListener({ close: async () => { throw closeError; } }, socketPath, inode, gitError);
  } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(AggregateError);
  expect((caught as AggregateError).errors[0]).toBe(gitError);
  expect(String((caught as AggregateError).errors[1])).toContain("close failed");
  await expect(stat(socketPath)).rejects.toMatchObject({ code: "ENOENT" });

  await writeFile(socketPath, "first");
  const oldInode = (await stat(socketPath)).ino;
  await rename(socketPath, `${socketPath}.held`);
  await writeFile(socketPath, "replacement");
  await closeOwnedListener({ close: async () => {} }, socketPath, oldInode);
  expect(await readFile(socketPath, "utf8")).toBe("replacement");
});

test("专用夹具过滤恶意环境并在外层超时内结束自有挂起进程", async () => {
  const malicious = ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_CONFIG_COUNT", "NODE_OPTIONS"] as const;
  const previous = new Map(malicious.map((name) => [name, process.env[name]]));
  try {
    for (const name of malicious) process.env[name] = `/tmp/should-not-inherit-${name}`;
    const observed = await child(`process.stdout.write(JSON.stringify(Object.fromEntries(${JSON.stringify(malicious)}.map((name) => [name, process.env[name] ?? null]))));`);
    expect(observed).toEqual(Object.fromEntries(malicious.map((name) => [name, null])));
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
  const root = await temporary("git-daemon-hang-");
  const started = Date.now();
  await expect(runOwnedProcess(process.execPath, ["-e", "setInterval(() => {}, 1000)"], root, { timeoutMs: 100 }))
    .rejects.toThrow(/超时/);
  expect(Date.now() - started).toBeLessThan(2_000);
});

test("server在业务入口、await续点、拒绝写回和broadcast处统一撤销失效身份", async () => {
  for (const scenario of ["entry", "ready", "reject", "shutdown", "broadcast"] as const) {
    const root = await temporary(`git-daemon-server-gate-${scenario}-`);
    const data = await temporary("gs-");
    const result = await child(`
import childProcess from "node:child_process";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { dirname, join } from "node:path";
import { initializeHostGit } from "./runtime/git-runtime.mjs";
const bindingLoaded = await import("./runtime/git-daemon-binding.ts"), bindingApi = bindingLoaded.default ?? bindingLoaded;
const identityLoaded = await import("./runtime/identity.ts"), identityApi = identityLoaded.default ?? identityLoaded;
const protocolLoaded = await import("./runtime/protocol.ts"), protocol = protocolLoaded.default ?? protocolLoaded;
const serverLoaded = await import("./daemon/server.ts"), Server = (serverLoaded.default ?? serverLoaded).DaemonServer;
const root = process.argv[1], data = process.argv[2], scenario = process.argv[3], repo = join(root, "repo"), later = join(root, "later");
mkdirSync(repo, { recursive: true });
const binding = initializeHostGit([root, later]);
const git = (args) => childProcess.execFileSync(binding.executablePath, args, { cwd: repo, env: process.env });
git(["init", "-b", "main"]); writeFileSync(join(repo, "README.md"), "fixture\\n"); git(["add", "README.md"]); git(["commit", "-m", "init"]);
const identity = await identityApi.repositoryIdentity(repo), socketPath = identityApi.daemonSocketPath(data, identity.repoId); mkdirSync(dirname(socketPath), { recursive: true });
let handlerCalls = 0, shutdownCalls = 0, disconnects = 0, release, continued;
const blocked = new Promise((resolve) => { release = resolve; });
const started = new Promise((resolve) => { continued = resolve; });
const server = new Server({ authToken: "token", repoId: identity.repoId, startedAt: "test", gitRoots: [root, later],
  hasActiveRuns: scenario === "shutdown" ? async () => { continued(); await blocked; return false; } : undefined,
  onShutdownRequested: () => { shutdownCalls += 1; } });
server.onDisconnect = () => { disconnects += 1; };
if (scenario === "entry" || scenario === "reject") server.registerHandler("runs.list", async () => {
  handlerCalls += 1;
  if (scenario === "reject") { continued(); await blocked; throw Object.assign(new Error("PRIVATE_HANDLER_MESSAGE"), { data: { secret: "PRIVATE_HANDLER_DATA" } }); }
  return { items: [] };
});
if (scenario !== "ready") server.markHandlersReady();
await server.listen(socketPath);
const socket = createConnection(socketPath); let buffer = "", frames = [], closed = false;
socket.on("close", () => { closed = true; });
socket.on("data", (chunk) => { buffer += chunk.toString("utf8"); const decoded = protocol.decodeFrames(buffer); buffer = decoded.rest; frames.push(...decoded.frames); });
await new Promise((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
const expectation = bindingApi.createGitExpectationText([root, later]);
const request = (method, params = {}) => { const frame = protocol.createRequest(method, params); socket.write(protocol.encodeFrame(frame)); return frame; };
const wait = async (predicate) => { const until = Date.now() + 1000; while (!predicate() && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 5)); if (!predicate()) throw new Error("wait timeout"); };
const helloFrame = request("hello", { authToken: "token", windowId: "w", pid: process.pid, sessionId: "s", cwd: repo,
  workspaceRoot: repo, repoIds: [identity.repoId], protocolVersion: 2, gitExpectation: expectation });
await wait(() => frames.some((frame) => frame.t === "res" && frame.id === helloFrame.id));
const mutate = () => symlinkSync(dirname(binding.entryPath), later, "dir");
let target;
if (scenario === "broadcast") {
  let code;
  try { server.broadcast("runs.changed", {}, () => { mutate(); return true; }); } catch (error) { code = error.code; }
  await wait(() => disconnects === 1);
  target = { id: "broadcast", code };
} else {
  target = request(scenario === "shutdown" ? "shutdown" : "runs.list");
  if (scenario === "entry") mutate();
  else if (scenario === "ready") { await new Promise((resolve) => setTimeout(resolve, 20)); mutate(); server.registerHandler("runs.list", () => { handlerCalls += 1; return { items: [] }; }); server.markHandlersReady(); }
  else { await started; mutate(); release(); }
  await wait(() => frames.some((frame) => frame.t === "res" && frame.id === target.id) || closed);
}
await new Promise((resolve) => setTimeout(resolve, 30));
const response = frames.find((frame) => frame.t === "res" && frame.id === target.id);
const outcome = { scenario, handlerCalls, shutdownCalls, disconnects, clients: server.clients().length, closed,
  response: response?.ok === false ? response.error : response?.ok === true ? response.result : null };
socket.destroy(); await server.close(); process.stdout.write(JSON.stringify(outcome)); process.exit(0);
`, [root, data, scenario]);
    expect(result.disconnects, scenario).toBe(1);
    expect(result.clients, scenario).toBe(0);
    if (scenario === "entry" || scenario === "ready") expect(result.handlerCalls, scenario).toBe(0);
    if (scenario === "shutdown") expect(result.shutdownCalls).toBe(0);
    if (scenario === "reject") expect(result.handlerCalls).toBe(1);
    if (scenario !== "broadcast") {
      if (result.response === null) expect(result.closed, scenario).toBe(true);
      else {
        expect(result.response, scenario).toEqual(expect.objectContaining({ message: "Git 绑定已失效" }));
        expect((result.response as { code: string }).code).toMatch(/^git_/u);
        expect(result.response).not.toHaveProperty("data");
      }
    }
  }
}, 15_000);
