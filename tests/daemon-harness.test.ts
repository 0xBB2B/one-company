import { afterEach, beforeEach, expect, test as vitestTest } from "vitest";
import { spawn as realSpawn } from "node:child_process";
import type { SpawnOptions } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir } from "node:fs/promises";
import { createServer } from "node:net";
import type { Server, Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runInNewContext } from "node:vm";
import {
  authenticateTestClient,
  connectRawClient as nativeConnectRawClient,
  connectTestClient as nativeConnectTestClient,
  cleanupDaemonHarnessFixtures,
  createDaemonFixture,
  killDaemon,
  removeDaemonFixture,
  spawnDaemonProcess,
  startDaemonForTest,
} from "./helpers/daemon-harness.ts";
import type { DaemonFixture, DaemonHandle, RawClient } from "./helpers/daemon-harness.ts";
import { repoFixtureRootReceipt } from "./helpers/repo-fixture.ts";
import { tempHomeRootReceipt } from "./helpers/temp-home.ts";
import { captureFixtureScope, cleanupGitDaemonFixtures, ownedTempRoot, registerOwnedServer, registerOwnedSocket, withGitDaemonFixtures } from "./helpers/git-daemon-fixture.ts";

function scoped(run: () => Promise<void>): () => Promise<void> {
  return () => withGitDaemonFixtures(async () => {
    captureFixtureScope().onClosing(() => cleanupDaemonHarnessFixtures());
    await run();
  });
}
const test = Object.assign(
  (name: string, run: () => Promise<void>, timeout?: number) => vitestTest(name, scoped(run), timeout),
  { each: ((cases: readonly unknown[]) => (name: string, run: (...args: any[]) => Promise<void>, timeout?: number) =>
    vitestTest.each(cases)(name, (...args: unknown[]) => scoped(() => run(...args))(), timeout)) as typeof vitestTest.each },
);
const fixtures = { push(value: DaemonFixture) { captureFixtureScope().onClosing(() => removeDaemonFixture(value)); } };
const handles = { push(value: DaemonHandle) { captureFixtureScope().onClosing(async () => { await killDaemon(value); }); } };
const clients = { push(value: RawClient) { captureFixtureScope().onClosing(async () => { value.close(); await value.waitClosed(1_000); }); } };
const servers = { push(value: Server) { registerOwnedServer(value); } };

async function ownedConnection<T extends RawClient>(connect: () => Promise<T>): Promise<T> {
  const scope = captureFixtureScope();
  return scope.run(async () => {
    let raw: T;
    try { raw = await connect(); }
    catch (error) {
      const values: unknown[] = [error];
      const seen = new Set<unknown>();
      while (values.length) {
        const value = values.pop();
        if (!value || typeof value !== "object" || seen.has(value)) continue;
        seen.add(value);
        if ("preservedSockets" in value) scope.preserve(error);
        if ("errors" in value && Array.isArray(value.errors)) values.push(...value.errors);
      }
      throw error;
    }
    if (scope.isClosed()) {
      raw.close();
      try { await raw.waitClosed(1_000); }
      catch (error) { scope.preserve(error); throw error; }
      throw new Error("测试scope已关闭，不交付迟到连接");
    }
    clients.push(raw);
    return raw;
  });
}
const connectRawClient = (...args: Parameters<typeof nativeConnectRawClient>) => ownedConnection(() => nativeConnectRawClient(...args));
const connectTestClient = (...args: Parameters<typeof nativeConnectTestClient>) => ownedConnection(() => nativeConnectTestClient(...args));

afterEach(() => cleanupGitDaemonFixtures());

function controlledSpawn(source: string): typeof realSpawn {
  return ((_executable: string, _args: readonly string[], options: SpawnOptions) =>
    realSpawn(process.execPath, ["-e", source], options)) as typeof realSpawn;
}

async function fixture(): Promise<DaemonFixture> {
  const scope = captureFixtureScope();
  return scope.run(async () => {
    const value = await createDaemonFixture();
    if (scope.isClosed()) { await removeDaemonFixture(value); throw new Error("测试scope已关闭"); }
    fixtures.push(value);
    return value;
  });
}

async function socketServer(
  onRequest: (request: Record<string, unknown>, socket: Socket) => void,
): Promise<{ root: string; dataRoot: string; socketPath: string }> {
  const scope = captureFixtureScope();
  const root = await ownedTempRoot("daemon-harness-socket-");
  const dataRoot = join(root, "data");
  const socketPath = join(dataRoot, "sock", "test.sock");
  await scope.run(async () => { await mkdir(dirname(socketPath), { recursive: true }); });
  scope.assertOpen();
  const server = createServer((socket) => {
    socket.on("error", () => { /* 故障用例会主动断开，错误由客户端断言。 */ });
    if (scope.isClosed()) {
      void scope.cleanupOperation(async () => {
        const closed = new Promise<void>((resolve) => socket.once("close", resolve));
        socket.destroy();
        await closed;
      }).catch((error) => scope.preserve(error));
      return;
    }
    registerOwnedSocket(socket);
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        onRequest(JSON.parse(line) as Record<string, unknown>, socket);
      }
    });
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  scope.assertOpen();
  return { root, dataRoot, socketPath };
}

function response(request: Record<string, unknown>, result: Record<string, unknown>) {
  return `${JSON.stringify({ t: "res", id: request.id, ok: true, result })}\n`;
}

function helloResult(_request: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  return {
    daemonPid: process.pid,
    repoId: "a".repeat(64),
    protocolVersion: 2,
    daemonInstanceId: randomUUID(),
    connectionId: randomUUID(),
    ...overrides,
  };
}

function childDaemonSource(socketPath: string, repoId: string, mode: "ok" | "wrong-pid" | "late" = "ok"): string {
  return `
const { createServer } = require("node:net");
const { randomUUID } = require("node:crypto");
const fs = require("node:fs");
const path = ${JSON.stringify(socketPath)};
fs.mkdirSync(require("node:path").dirname(path), { recursive: true });
if (fs.existsSync(path)) throw new Error("测试端点必须是本次新建的空路径");
const server = createServer((socket) => {
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\\n")) >= 0) {
      const req = JSON.parse(buffer.slice(0, index)); buffer = buffer.slice(index + 1);
      const result = { daemonPid: ${mode === "wrong-pid" ? "process.pid + 1" : "process.pid"}, repoId: ${JSON.stringify(repoId)}, protocolVersion: 2,
        daemonInstanceId: randomUUID(), connectionId: randomUUID() };
      socket.write(JSON.stringify({ t: "res", id: req.id, ok: true, result }) + "\\n");
    }
  });
});
setTimeout(() => server.listen(path), ${mode === "late" ? 500 : 0});
setInterval(() => {}, 1000);
`;
}

test.each(["home", "repo", "dataRoot"] as const)("初始化 %s 阶段失败只回收已经确认的自产根", async (faultAfter) => {
  const before = new Set((await readdir(tmpdir())).filter((name) => name.startsWith("pi-company-home-") || name.startsWith("pi-company-repo-")));
  await expect(createDaemonFixture({ faultAfter })).rejects.toThrow(/专测/);
  const after = (await readdir(tmpdir())).filter((name) => name.startsWith("pi-company-home-") || name.startsWith("pi-company-repo-"));
  expect(after.filter((name) => !before.has(name))).toEqual([]);
});

test("原始 HOME/repo 返回对象持有冻结分配收据，结构克隆不能取得票据", async () => {
  const f = await fixture();
  const homeReceipt = tempHomeRootReceipt(f.home);
  const repoReceipt = repoFixtureRootReceipt(f.repo);
  expect(homeReceipt).toMatchObject({ path: f.home.home, dev: expect.any(Number), ino: expect.any(Number) });
  expect(repoReceipt).toMatchObject({ path: f.repo.root, dev: expect.any(Number), ino: expect.any(Number) });
  expect(Object.isFrozen(homeReceipt)).toBe(true);
  expect(Object.isFrozen(repoReceipt)).toBe(true);
  expect(tempHomeRootReceipt({ ...f.home, env: { ...f.home.env } })).toBeUndefined();
  expect(repoFixtureRootReceipt({ ...f.repo, worktrees: [...f.repo.worktrees] })).toBeUndefined();
});

test("创建前完成 Git gate，固定环境拒绝覆盖且最终携带完整 Git 证明", async () => {
  const f = await fixture();
  let called = false;
  expect(() => spawnDaemonProcess({
    home: f.home, repoDir: f.repoDir, dataRoot: f.dataRoot,
    extraEnv: { PI_COMPANY_DATA_ROOT: "/tmp/attacker" },
    spawnImpl: ((..._args: unknown[]) => { called = true; throw new Error("不应调用"); }) as typeof realSpawn,
  })).toThrow(/保护环境变量/);
  expect(called).toBe(false);
  expect(() => spawnDaemonProcess({
    home: f.home, repoDir: f.repoDir, dataRoot: f.dataRoot,
    outputByteLimit: 2 * 1024 * 1024 + 1,
    spawnImpl: ((..._args: unknown[]) => { called = true; throw new Error("不应调用"); }) as typeof realSpawn,
  })).toThrow(/outputByteLimit/);
  expect(called).toBe(false);

  const accessOrder: string[] = [];
  const capturedOptions = { home: f.home, repoDir: f.repoDir, dataRoot: f.dataRoot, outputByteLimit: 32 } as Parameters<typeof spawnDaemonProcess>[0];
  Object.defineProperty(capturedOptions, "captureOutput", { get() { accessOrder.push("capture"); return false; } });
  capturedOptions.spawnImpl = ((_exec: string, _args: readonly string[], spawnOptions: SpawnOptions) => {
    accessOrder.push("spawn");
    return realSpawn(process.execPath, ["-e", "process.exit(0)"], spawnOptions);
  }) as typeof realSpawn;
  await spawnDaemonProcess(capturedOptions).exited;
  expect(accessOrder).toEqual(["capture", "spawn"]);

  let captured: NodeJS.ProcessEnv | undefined;
  const spawned = spawnDaemonProcess({
    home: f.home, repoDir: f.repoDir, dataRoot: f.dataRoot, sdkDir: join(f.dataRoot, "fault-sdk"), captureOutput: true,
    extraEnv: { NODE_OPTIONS: "", PI_COMPANY_TEST_PROVIDER_SCRIPTS: join(f.dataRoot, "providers.json") },
    spawnImpl: ((_exec: string, _args: readonly string[], options: SpawnOptions) => {
      captured = options.env as NodeJS.ProcessEnv;
      return realSpawn(process.execPath, ["-e", "process.exit(0)"], options);
    }) as typeof realSpawn,
  });
  await spawned.exited;
  expect(captured?.HOME).toBe(f.home.home);
  expect(captured?.PI_COMPANY_REPO_DIR).toBe(f.repoDir);
  expect(captured?.PI_COMPANY_DATA_ROOT).toBe(f.dataRoot);
  expect(captured?.PI_COMPANY_SDK_DIR).toBe(join(f.dataRoot, "fault-sdk"));
});

test("真实 ChildProcess 只接受原 proc/exited 配对，VM 伪句柄与错配句柄均不能发信号", async () => {
  const forged = runInNewContext("({ proc: { pid: 52973, kill(){ throw new Error('forbidden') } }, exited: Promise.resolve({}) })") as Pick<DaemonHandle, "proc" | "exited">;
  await expect(killDaemon(forged)).rejects.toThrow(/未知|不匹配/);

  const f = await fixture();
  const spawned = spawnDaemonProcess({ home: f.home, repoDir: f.repoDir, dataRoot: f.dataRoot,
    spawnImpl: controlledSpawn("setInterval(() => {}, 1000)") });
  const handle = { ...spawned, socketPath: f.socketPath };
  await expect(killDaemon({ proc: handle.proc, exited: Promise.resolve({ code: 0, signal: null, stdout: "", stderr: "", outputTruncated: false }) })).rejects.toThrow(/不匹配/);
  const result = await killDaemon(handle);
  expect(result.signal).toBe("SIGKILL");
});

test("捕获输出按 UTF-8 字节总量截断并使自产短进程失败收尾", async () => {
  const f = await fixture();
  const spawned = spawnDaemonProcess({ home: f.home, repoDir: f.repoDir, dataRoot: f.dataRoot,
    captureOutput: true, outputByteLimit: 17,
    spawnImpl: controlledSpawn("process.stdout.write('你'.repeat(10000)); setInterval(() => {}, 1000)") });
  const result = await spawned.exited;
  expect(result.outputTruncated).toBe(true);
  expect(result.outputFailure).toMatch(/17/);
  expect(Buffer.byteLength(result.stdout, "utf8") + Buffer.byteLength(result.stderr, "utf8")).toBeLessThanOrEqual(17);
});

test("start 使用单一 deadline，认证自产 PID/repoId 后才就绪", async () => {
  const f = await fixture();
  const handle = await startDaemonForTest(f, { waitTimeoutMs: 2_000, spawnImpl: controlledSpawn(childDaemonSource(f.socketPath, f.repoId)) });
  handles.push(handle);
  expect(handle.proc.pid).toBeGreaterThan(0);
});

test.each([
  ["错误 PID", "wrong-pid" as const, 350],
  ["迟到 ready", "late" as const, 120],
])("start 对%s取消败方并只收尾自产 child", async (_label, mode, waitTimeoutMs) => {
  const f = await fixture();
  await expect(startDaemonForTest(f, { waitTimeoutMs, spawnImpl: controlledSpawn(childDaemonSource(f.socketPath, f.repoId, mode)) })).rejects.toThrow();
});

test("start 在 spawn error 或 early close 时给出真实失败且不遗留 child", async () => {
  const f = await fixture();
  const spawnError = ((_exec: string, _args: readonly string[], options: SpawnOptions) =>
    realSpawn(join(f.dataRoot, "missing-node"), [], options)) as typeof realSpawn;
  await expect(startDaemonForTest(f, { waitTimeoutMs: 500, spawnImpl: spawnError })).rejects.toThrow();
  await expect(startDaemonForTest(f, { waitTimeoutMs: 500, spawnImpl: controlledSpawn("process.stderr.write('early-close'); process.exit(7)") })).rejects.toThrow(/early-close|code=7/);
});

test("remove 先 fence 并等待自己仍存活的 ChildProcess 真实 close/进程组消失再删根", async () => {
  const f = await fixture();
  const spawned = spawnDaemonProcess({ home: f.home, repoDir: f.repoDir, dataRoot: f.dataRoot,
    spawnImpl: controlledSpawn("setInterval(() => {}, 1000)") });
  await removeDaemonFixture(f);
  expect((await spawned.exited).signal).toBe("SIGKILL");
  expect(existsSync(f.home.home)).toBe(false);
  expect(existsSync(f.repo.root)).toBe(false);
  expect(existsSync(f.dataRoot)).toBe(false);
});

test("RawClient 保留显式 token 且不自动补 Git，不触碰默认凭据", async () => {
  let seen: Record<string, unknown> | undefined;
  const endpoint = await socketServer((request, socket) => {
    seen = request.params as Record<string, unknown>;
    socket.write(response(request, { accepted: true }));
  });
  const raw = await connectRawClient(endpoint.socketPath);
  clients.push(raw);
  await raw.call("hello", { authToken: "explicit-bad-token" });
  expect(seen).toEqual({ authToken: "explicit-bad-token" });
  expect(existsSync(join(endpoint.dataRoot, "global.db"))).toBe(false);
});

test("RawClient 仅为已知隔离 endpoint 的 hello 补默认 token，显式 undefined 不改写", async () => {
  const requests: Record<string, unknown>[] = [];
  const endpoint = await socketServer((request, socket) => {
    requests.push(request.params as Record<string, unknown>);
    socket.write(response(request, { accepted: true }));
  });
  const raw = await connectRawClient(endpoint.socketPath, { dataRoot: endpoint.dataRoot });
  clients.push(raw);
  await raw.call("hello", { protocolVersion: 99 });
  await raw.call("hello", { authToken: undefined, protocolVersion: 99 });
  expect(requests[0]?.authToken).toEqual(expect.any(String));
  expect(Object.prototype.hasOwnProperty.call(requests[1], "authToken")).toBe(false);
  expect(existsSync(join(endpoint.dataRoot, "global.db"))).toBe(true);
});

test("RawClient 预取消在登记或写入前结算，close 后不留悬挂", async () => {
  let requests = 0;
  const endpoint = await socketServer((_request, _socket) => { requests += 1; });
  const raw = await connectRawClient(endpoint.socketPath, { dataRoot: endpoint.dataRoot });
  clients.push(raw);
  const cancel = new AbortController();
  cancel.abort(new Error("pre-cancelled"));
  await expect(raw.call("ping", {}, { timeoutMs: 50, signal: cancel.signal })).rejects.toThrow("pre-cancelled");
  raw.close();
  await raw.waitClosed(500);
  expect(requests).toBe(0);
});

test("便利客户端保持同一登记对象，重 hello 确实发送并取得新 connectionId", async () => {
  let requests = 0;
  const endpoint = await socketServer((request, socket) => {
    requests += 1;
    socket.write(response(request, helloResult(request)));
  });
  const client = await connectTestClient(endpoint.socketPath, { cwd: endpoint.root, workspaceRoot: endpoint.root }, {
    dataRoot: endpoint.dataRoot,
    expectedDaemonPid: process.pid,
    expectedRepoId: "a".repeat(64),
  });
  clients.push(client);
  const first = client.helloResult.connectionId;
  const second = await authenticateTestClient(client, { cwd: endpoint.root, workspaceRoot: endpoint.root }, {
    dataRoot: endpoint.dataRoot,
    expectedDaemonPid: process.pid,
    expectedRepoId: "a".repeat(64),
  });
  expect(requests).toBe(2);
  expect(second.connectionId).not.toBe(first);
});

test("RawClient 对无响应、半帧、断线 pending 和多字节缓冲统一有界结算", async () => {
  const noResponse = await socketServer(() => {});
  const timed = await connectRawClient(noResponse.socketPath); clients.push(timed);
  await expect(timed.call("ping", {}, { timeoutMs: 50 })).rejects.toThrow(/超时/);

  const half = await socketServer((_request, socket) => { socket.end('{"t":"res"'); });
  const halfClient = await connectRawClient(half.socketPath); clients.push(halfClient);
  await expect(halfClient.call("ping", {}, { timeoutMs: 500 })).rejects.toThrow(/关闭|半帧/);

  const disconnected = await socketServer((_request, socket) => socket.destroy());
  const disconnectedClient = await connectRawClient(disconnected.socketPath); clients.push(disconnectedClient);
  await expect(disconnectedClient.call("ping", {}, { timeoutMs: 500 })).rejects.toThrow();

  const huge = await socketServer((_request, socket) => socket.write("你".repeat(400_000)));
  const hugeClient = await connectRawClient(huge.socketPath); clients.push(hugeClient);
  await expect(hugeClient.call("ping", {}, { timeoutMs: 2_000 })).rejects.toThrow(/缓冲|关闭/);
});

test("RawClient 可在同一数据块解析多个响应且 waitClosed 依赖真实 close", async () => {
  const pending: Record<string, unknown>[] = [];
  const endpoint = await socketServer((request, socket) => {
    pending.push(request);
    if (pending.length === 2) socket.write(response(pending[0]!, { order: 1 }) + response(pending[1]!, { order: 2 }));
  });
  const raw = await connectRawClient(endpoint.socketPath); clients.push(raw);
  await expect(Promise.all([raw.call("ping"), raw.call("ping")])).resolves.toEqual([{ order: 1 }, { order: 2 }]);
  await expect(raw.waitClosed(30)).rejects.toThrow(/超时/);
  raw.close();
  await raw.waitClosed(500);
});

test("authenticate 核验响应版本、PID、UUID 和 repoId", async () => {
  const endpoint = await socketServer((request, socket) => {
    socket.write(response(request, helloResult(request)));
  });
  const raw = await connectRawClient(endpoint.socketPath, { dataRoot: endpoint.dataRoot }); clients.push(raw);
  const result = await authenticateTestClient(raw, { cwd: endpoint.root, workspaceRoot: endpoint.dataRoot, repoIds: ["a".repeat(64)] },
    { dataRoot: endpoint.dataRoot, expectedDaemonPid: process.pid, expectedRepoId: "a".repeat(64) });
  expect(result.daemonPid).toBe(process.pid);
});

test.each([
  ["错误 PID", { daemonPid: process.pid + 1 }],
  ["错误 repoId", { repoId: "b".repeat(64) }],
  ["坏 UUID", { connectionId: "not-uuid" }],
  ["错误版本", { protocolVersion: 99 }],
])("authenticate 对%s不升级认证", async (_label, overrides) => {
  const endpoint = await socketServer((request, socket) => socket.write(response(request, helloResult(request, overrides))));
  const raw = await connectRawClient(endpoint.socketPath, { dataRoot: endpoint.dataRoot }); clients.push(raw);
  await expect(authenticateTestClient(raw, { cwd: endpoint.root, workspaceRoot: endpoint.root }, {
    dataRoot: endpoint.dataRoot, expectedDaemonPid: process.pid, expectedRepoId: "a".repeat(64), timeoutMs: 500,
  })).rejects.toThrow();
});

test("未知 socket 不从路径猜 dataRoot，显式路径不匹配也拒绝写凭据", async () => {
  const endpoint = await socketServer((request, socket) => socket.write(response(request, helloResult(request))));
  const raw = await connectRawClient(endpoint.socketPath); clients.push(raw);
  await expect(authenticateTestClient(raw, { cwd: endpoint.root, workspaceRoot: endpoint.root })).rejects.toThrow(/显式提供/);
  await expect(authenticateTestClient(raw, { cwd: endpoint.root, workspaceRoot: endpoint.root }, { dataRoot: join(endpoint.root, "other") })).rejects.toThrow(/不匹配/);
});

test("remove 先 fence 资源；结构化外来参数和后来可变 worktree 均不取得删除权", async () => {
  const unknownRoot = await ownedTempRoot("daemon-harness-unknown-");
  const forged = runInNewContext(`({ home: { home: ${JSON.stringify(unknownRoot)}, agentDir: "x", dataRoot: "x", env: {} }, repo: { root: ${JSON.stringify(unknownRoot)}, worktrees: [] }, repoDir: ${JSON.stringify(unknownRoot)}, dataRoot: ${JSON.stringify(unknownRoot)}, repoId: "${"a".repeat(64)}", socketPath: "x" })`) as DaemonFixture;
  await expect(removeDaemonFixture(forged)).rejects.toThrow(/未由本 daemon 夹具创建/);
  expect(existsSync(unknownRoot)).toBe(true);

  const f = await fixture();
  f.repo.worktrees.push(join(f.repo.root, "later-unproven-worktree"));
  await expect(removeDaemonFixture(f)).rejects.toThrow(/worktree|保全精确根/);
  expect(existsSync(f.home.home)).toBe(true);
  expect(existsSync(f.repo.root)).toBe(true);
  expect(existsSync(f.dataRoot)).toBe(true);
  // 仅撤销本用例注入的不存在路径；不重新采样身份取得删除权。
  f.repo.worktrees.pop();
  await removeDaemonFixture(f);
});
