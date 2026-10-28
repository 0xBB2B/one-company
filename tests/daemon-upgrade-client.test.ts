import { temporaryRoot } from "./helpers/temporary-root.ts";
import { afterEach, describe, expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { rmSync } from "node:fs";
import { createServer } from "node:net";
import type { Server, Socket } from "node:net";
import { basename, dirname, join } from "node:path";
import { createClock } from "../src/core/policy/clock.ts";
import { daemonSocketPath, repositoryIdentity } from "../src/core/storage/identity.ts";
import { PROTOCOL_VERSION, createErrorResponse, createResponse, decodeFrames, encodeFrame } from "../src/core/host/protocol.ts";
import type { Frame } from "../src/core/host/protocol.ts";
import { DAEMON_CLIENT_LIFECYCLE_EVENTS, WorkspaceClients, connectDaemon } from "../src/core/host/daemon-client.ts";
import type { DaemonClient } from "../src/core/host/daemon-client.ts";
import type { UpgradeNotice } from "../src/core/host/upgrade-notice.ts";
import { failureText } from "../src/core/exec/tool-failure.ts";
import { resolveNodeExecutable, resolveSdkDir } from "./helpers/daemon-harness.ts";
import { createFakeTimeSource } from "./helpers/fake-clock.ts";
import { createRepoFixture, removeRepoFixture } from "./helpers/repo-fixture.ts";
import type { RepoFixture } from "./helpers/repo-fixture.ts";

interface Answer {
  stale: boolean;
  protocolVersion: number;
  requirements: string[];
  otherWindows: number;
  ownSessions: number;
}

interface Generation {
  check: Answer | "unknown_method" | "internal_error" | "close";
  yield: "accept" | "internal_error" | { refuse: Answer };
  helloError?: string;
  helloMessage?: string;
}

interface RequestRecord {
  method: string;
  connection: number;
  params: Record<string, unknown>;
}

interface FakeUpgradeDaemon {
  current: Generation;
  next: Generation | undefined;
  requests: RequestRecord[];
  methods(): string[];
  connectionCount(): number;
  dropConnections(): void;
  close(): void;
}

const CURRENT: Answer = { stale: false, protocolVersion: PROTOCOL_VERSION, requirements: [], otherWindows: 0, ownSessions: 0 };
const STALE_IDLE: Answer = { ...CURRENT, stale: true };
const STALE_BUSY: Answer = { ...STALE_IDLE, otherWindows: 1 };

const accepting = (check: Generation["check"], extra: Partial<Generation> = {}): Generation => ({ check, yield: "accept", ...extra });

let repo: RepoFixture;
let dataRoot: string;
let socketPath: string;
let fake: FakeUpgradeDaemon;
let repoId: string;
const closables: Array<{ close?: () => void; closeAll?: () => void }> = [];

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs = 8_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await delay(20);
  }
  throw new Error(`等待条件满足超时（${timeoutMs}ms）`);
}

async function startFakeDaemon(initial: Generation, replacement?: Generation): Promise<FakeUpgradeDaemon> {
  const sockets = new Set<Socket>();
  const servers: Server[] = [];
  let connections = 0;
  const state: FakeUpgradeDaemon = {
    current: initial,
    next: replacement,
    requests: [],
    methods: () => state.requests.map((request) => request.method),
    connectionCount: () => connections,
    dropConnections: () => { for (const socket of sockets) socket.destroy(); },
    close: () => {
      for (const server of servers) server.close();
      for (const socket of sockets) socket.destroy();
    },
  };

  function answerOf(generation: Generation): Record<string, unknown> | undefined {
    return typeof generation.check === "object" ? { ...generation.check } : undefined;
  }

  function listen(): Promise<Server> {
    const own = new Set<Socket>();
    const server = createServer((socket: Socket) => {
      connections += 1;
      const connection = connections;
      sockets.add(socket);
      own.add(socket);
      socket.on("error", () => {});
      socket.on("close", () => { sockets.delete(socket); own.delete(socket); });
      let buffer = "";
      socket.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        const { frames, rest } = decodeFrames(buffer);
        buffer = rest;
        for (const frame of frames) {
          if (frame.t !== "req") continue;
          state.requests.push({ method: frame.method, connection, params: frame.params });
          handle(frame, socket, server, own);
        }
      });
    });
    servers.push(server);
    return new Promise((resolve) => server.listen(socketPath, () => resolve(server)));
  }

  function handle(frame: Extract<Frame, { t: "req" }>, socket: Socket, server: Server, own: Set<Socket>): void {
    const generation = state.current;
    if (frame.method === "upgrade.check") {
      if (generation.check === "close") {
        socket.destroy();
        return;
      }
      const answer = answerOf(generation);
      if (answer) socket.write(encodeFrame(createResponse(frame.id, answer)));
      else if (generation.check === "unknown_method") socket.write(encodeFrame(createErrorResponse(frame.id, "unknown_method", "未知方法 upgrade.check")));
      else socket.write(encodeFrame(createErrorResponse(frame.id, "internal", "守护进程内部错误（测试注入）")));
      return;
    }
    if (frame.method === "upgrade.yield") {
      if (generation.yield === "internal_error") {
        socket.write(encodeFrame(createErrorResponse(frame.id, "internal", "守护进程内部错误（测试注入）")));
        return;
      }
      if (generation.yield !== "accept") {
        socket.write(encodeFrame(createResponse(frame.id, { ...generation.yield.refuse, accepted: false })));
        return;
      }
      const replacement = state.next;
      if (!replacement) throw new Error("假守护进程缺少换新后的回答");
      void (async () => {
        const answer = answerOf(generation) ?? { ...STALE_IDLE };
        await new Promise<void>((resolve) => socket.write(encodeFrame(createResponse(frame.id, { ...answer, accepted: true })), () => resolve()));
        state.current = replacement;
        state.next = undefined;
        server.close();
        rmSync(socketPath, { force: true });
        await listen();
        for (const old of own) old.destroy();
      })();
      return;
    }
    if (frame.method === "hello") {
      if (generation.helloError) {
        socket.write(encodeFrame(createErrorResponse(frame.id, generation.helloError, generation.helloMessage ?? "协议版本不一致（测试注入）")));
        return;
      }
      socket.write(encodeFrame(createResponse(frame.id, {
        daemonPid: process.pid,
        repoId,
        protocolVersion: PROTOCOL_VERSION,
        startedAt: new Date().toISOString(),
        daemonInstanceId: randomUUID(),
        connectionId: randomUUID(),
      })));
      return;
    }
    socket.write(encodeFrame(createResponse(frame.id, {})));
  }

  await listen();
  return state;
}

async function startScenario(initial: Generation, replacement?: Generation): Promise<void> {
  fake = await startFakeDaemon(initial, replacement);
}

const notices: UpgradeNotice[] = [];

function baseOptions(time: ReturnType<typeof createFakeTimeSource>) {
  return {
    dataRoot,
    sdkDir: resolveSdkDir(),
    execPath: resolveNodeExecutable(),
    clock: createClock({ timeSource: time }),
    hello: { windowId: "window-upgrade", sessionId: "session-upgrade" },
    onUpgradeNotice: (notice: UpgradeNotice) => { notices.push(notice); },
  };
}

async function openWithConnectDaemon(time: ReturnType<typeof createFakeTimeSource>, extra: Record<string, unknown> = {}): Promise<DaemonClient> {
  const client = await connectDaemon({ repoDir: repo.root, ...baseOptions(time), ...extra });
  closables.push(client);
  return client;
}

async function openWithWorkspaceClients(time: ReturnType<typeof createFakeTimeSource>): Promise<DaemonClient> {
  const handle = await WorkspaceClients.create({ workspaceRoot: repo.root, ...baseOptions(time) });
  closables.push(handle);
  const client = handle.forRepo(repoId);
  if (!client) throw new Error("工作区客户端缺少当前仓库");
  return client;
}

async function callError(client: DaemonClient): Promise<unknown> {
  try {
    await client.call("ping");
  } catch (error) {
    return error;
  }
  throw new Error("call 本应抛错");
}

async function settle(): Promise<void> {
  await delay(300);
}

const kinds = () => notices.map((notice) => notice.kind);

afterEach(async () => {
  for (const closable of closables.splice(0)) {
    try {
      closable.close?.();
      closable.closeAll?.();
    } catch {
      // 连接可能已被假守护进程断开
    }
  }
  fake?.close();
  notices.length = 0;
  await delay(50);
  if (dataRoot) await rm(dataRoot, { recursive: true, force: true });
  if (repo) await removeRepoFixture(repo);
});

async function prepare(): Promise<void> {
  repo = await createRepoFixture();
  dataRoot = await mkdtemp(join(temporaryRoot(), "d"));
  repoId = (await repositoryIdentity(repo.root)).repoId;
  socketPath = daemonSocketPath(dataRoot, repoId);
  await mkdir(dirname(socketPath), { recursive: true });
}

describe("守护进程过旧且不忙：让位换新", () => {
  test("过旧且不忙时让位，连上新守护进程握手成功，收到恰好 1 条 replaced，call 成功", async () => {
    await prepare();
    await startScenario(accepting(STALE_IDLE), accepting(CURRENT));
    const client = await openWithConnectDaemon(createFakeTimeSource());

    expect((await client.call("ping"))).toEqual({});
    await waitUntil(() => notices.length >= 1);
    await settle();
    expect(kinds()).toEqual(["replaced"]);
    expect(notices[0]?.repoName).toBe(basename(repo.root));
    expect(fake.methods().filter((method) => method === "upgrade.yield")).toHaveLength(1);
    expect(fake.methods().indexOf("upgrade.yield")).toBeLessThan(fake.methods().indexOf("hello"));
    expect(fake.methods().filter((method) => method === "hello")).toHaveLength(1);
  });

  test("upgrade.check 与 upgrade.yield 的参数只含 authToken 和 windowId", async () => {
    await prepare();
    await startScenario(accepting(STALE_IDLE), accepting(CURRENT));
    await openWithConnectDaemon(createFakeTimeSource());

    const upgradeRequests = fake.requests.filter((request) => request.method.startsWith("upgrade."));
    expect(upgradeRequests.length).toBeGreaterThanOrEqual(2);
    for (const request of upgradeRequests) {
      expect(Object.keys(request.params).sort()).toEqual(["authToken", "windowId"]);
      expect(request.params.windowId).toBe("window-upgrade");
      expect(String(request.params.authToken)).toMatch(/^[0-9a-f]{64}$/u);
    }
  });

  test("发 upgrade.check 在 hello 之前", async () => {
    await prepare();
    await startScenario(accepting(CURRENT));
    await openWithConnectDaemon(createFakeTimeSource());

    expect(fake.methods().slice(0, 2)).toEqual(["upgrade.check", "hello"]);
    await settle();
    expect(notices).toEqual([]);
  });

  test("让位被拒（期间变忙）且协议版本号相同时按在忙处理：hello 连上、发 waiting_usable", async () => {
    await prepare();
    await startScenario({ check: STALE_IDLE, yield: { refuse: STALE_BUSY } });
    const client = await openWithConnectDaemon(createFakeTimeSource());

    expect(await client.call("ping")).toEqual({});
    await waitUntil(() => notices.length >= 1);
    await settle();
    expect(kinds()).toEqual(["waiting_usable"]);
    expect(notices[0]).toMatchObject({ requirements: [], otherWindows: 1, ownSessions: 0 });
    expect(fake.methods()).toContain("upgrade.yield");
    expect(fake.methods()).toContain("hello");
    expect(fake.connectionCount()).toBe(1);
  });
});

describe("守护进程过旧且在忙、协议版本号相同：先照常用并等待", () => {
  test("hello 连上、call 成功、发 1 条 waiting_usable；30 秒后空闲则换新，只多一条 replaced_after_wait", async () => {
    await prepare();
    const time = createFakeTimeSource();
    await startScenario(accepting(STALE_BUSY), accepting(CURRENT));
    const client = await openWithConnectDaemon(time);

    expect(await client.call("ping")).toEqual({});
    await waitUntil(() => notices.length >= 1);
    expect(kinds()).toEqual(["waiting_usable"]);
    expect(notices[0]).toMatchObject({ otherWindows: 1 });

    await time.advanceAsync(29_000);
    await settle();
    expect(fake.methods().filter((method) => method === "upgrade.check")).toHaveLength(1);
    expect(fake.methods()).not.toContain("upgrade.yield");

    fake.current = accepting(STALE_IDLE);
    await time.advanceAsync(1_500);
    await waitUntil(() => notices.length >= 2);
    expect(kinds()).toEqual(["waiting_usable", "replaced_after_wait"]);

    const secondCheck = fake.requests.filter((request) => request.method === "upgrade.check")[1];
    expect(secondCheck?.connection).toBe(1);

    await waitUntil(async () => {
      try { await client.call("ping"); return true; } catch { return false; }
    });
    await time.advanceAsync(120_000);
    await settle();
    expect(kinds()).toEqual(["waiting_usable", "replaced_after_wait"]);
  });

  test("仍在忙时每 30 秒重查不重复发等待提示", async () => {
    await prepare();
    const time = createFakeTimeSource();
    await startScenario(accepting(STALE_BUSY), accepting(CURRENT));
    await openWithConnectDaemon(time);
    await waitUntil(() => notices.length >= 1);

    await time.advanceAsync(30_000);
    await waitUntil(() => fake.methods().filter((method) => method === "upgrade.check").length >= 2);
    await time.advanceAsync(30_000);
    await waitUntil(() => fake.methods().filter((method) => method === "upgrade.check").length >= 3);
    await settle();
    expect(kinds()).toEqual(["waiting_usable"]);
    expect(fake.methods()).not.toContain("upgrade.yield");
  });
});

describe("守护进程过旧且在忙、协议版本号不同：暂时用不了", () => {
  const BLOCKED: Answer = { stale: true, protocolVersion: 6, requirements: ["订单导出"], otherWindows: 1, ownSessions: 0 };

  test("不发 hello、关掉连接；call 抛 daemon_upgrade_pending，原因和建议与约定一致且不含 64 位十六进制串", async () => {
    await prepare();
    const time = createFakeTimeSource();
    await startScenario(accepting(BLOCKED), accepting(CURRENT));
    const client = await openWithWorkspaceClients(time);

    await waitUntil(() => notices.length >= 1);
    expect(kinds()).toEqual(["waiting_blocked"]);
    expect(notices[0]).toMatchObject({ requirements: ["订单导出"], otherWindows: 1, ownSessions: 0 });
    expect(fake.methods()).not.toContain("hello");
    expect(fake.methods()).not.toContain("upgrade.yield");

    const error = await callError(client);
    expect((error as { code?: unknown }).code).toBe("daemon_upgrade_pending");
    const name = basename(repo.root);
    const text = failureText("需求查询", error);
    expect(text).toBe(
      `需求查询失败。\n原因：${name} 的后台进程是旧版本，和这个窗口不兼容；正在等需求「订单导出」运行结束、另外 1 个窗口关闭后自动换成新版本。\n建议：告诉用户需求和代理功能要等后台换成新版本后才能用；换好后窗口里会有提示，再重试这一步。`,
    );
    expect(text).not.toMatch(/[0-9a-f]{64}/u);
  });

  test("等待中某次检查失败时仍保持等待，之后空闲照样换新", async () => {
    await prepare();
    const time = createFakeTimeSource();
    await startScenario(accepting(BLOCKED), accepting(CURRENT));
    const client = await openWithWorkspaceClients(time);
    await waitUntil(() => notices.length >= 1);

    fake.current = accepting("internal_error", { helloError: "protocol_version" });
    await time.advanceAsync(30_500);
    await settle();
    expect((await callError(client) as { code?: unknown }).code).toBe("daemon_upgrade_pending");

    fake.current = accepting({ ...BLOCKED, requirements: [], otherWindows: 0 });
    await time.advanceAsync(30_500);
    await waitUntil(() => notices.length >= 2);
    expect(kinds()).toEqual(["waiting_blocked", "replaced_after_wait"]);
  });

  test("空闲后 30 秒内让位换新，call 成功，共收到 1 条 waiting_blocked 和 1 条 replaced_after_wait", async () => {
    await prepare();
    const time = createFakeTimeSource();
    await startScenario(accepting(BLOCKED), accepting(CURRENT));
    const client = await openWithWorkspaceClients(time);
    await waitUntil(() => notices.length >= 1);

    fake.current = accepting({ ...BLOCKED, requirements: [], otherWindows: 0 });
    await time.advanceAsync(30_500);
    await waitUntil(() => notices.length >= 2);
    expect(kinds()).toEqual(["waiting_blocked", "replaced_after_wait"]);

    await waitUntil(async () => {
      try { await client.call("ping"); return true; } catch { return false; }
    });
    expect(fake.methods().filter((method) => method === "hello")).toHaveLength(1);
    await time.advanceAsync(120_000);
    await settle();
    expect(kinds()).toEqual(["waiting_blocked", "replaced_after_wait"]);
  });

  test("换上新守护进程时，连上事件监听器里同步发起的 call 成功", async () => {
    await prepare();
    const time = createFakeTimeSource();
    await startScenario(accepting(BLOCKED), accepting(CURRENT));
    const client = await openWithWorkspaceClients(time);
    await waitUntil(() => notices.length >= 1);

    const outcomes: unknown[] = [];
    client.subscribe(DAEMON_CLIENT_LIFECYCLE_EVENTS.connected, () => {
      client.call("ping").then(() => outcomes.push("ok"), (error: { code?: unknown }) => outcomes.push(error.code));
    });
    fake.current = accepting({ ...BLOCKED, requirements: [], otherWindows: 0 });
    await time.advanceAsync(30_500);
    await waitUntil(() => notices.length >= 2);
    await waitUntil(() => outcomes.length >= 1);
    expect(outcomes).toEqual(["ok"]);
  });

  test("等待中重查遇到不认识 upgrade.check 的老守护进程且 hello 报 protocol_version：call 报后台进程是旧版本，不再报等换新", async () => {
    await prepare();
    const time = createFakeTimeSource();
    await startScenario(accepting(BLOCKED), accepting(CURRENT));
    const client = await openWithWorkspaceClients(time);
    await waitUntil(() => notices.length >= 1);

    fake.current = accepting("unknown_method", { helloError: "protocol_version" });
    await time.advanceAsync(30_500);
    await waitUntil(() => fake.methods().includes("hello"));
    await settle();
    const error = await callError(client);
    expect((error as { code?: unknown }).code).not.toBe("daemon_upgrade_pending");
    expect(String((error as Error).message)).toContain("后台进程是旧版本");
  });

  test("等待中重查得到过旧且不忙并让位，新守护进程 hello 报非协议版本错误：call 报该错误原因，不再报等换新", async () => {
    await prepare();
    const time = createFakeTimeSource();
    await startScenario(accepting(BLOCKED), accepting(CURRENT, { helloError: "internal", helloMessage: "新守护进程启动失败（测试注入）" }));
    const client = await openWithWorkspaceClients(time);
    await waitUntil(() => notices.length >= 1);

    fake.current = accepting(STALE_IDLE);
    await time.advanceAsync(30_500);
    await waitUntil(() => fake.methods().includes("hello"));
    await settle();
    const error = await callError(client);
    expect((error as { code?: unknown }).code).not.toBe("daemon_upgrade_pending");
    expect(String((error as Error).message)).toContain("新守护进程启动失败（测试注入）");
  });

  test("重查得到过旧且不忙但 upgrade.yield 失败：仍保持等待，29 秒内没有新的连接尝试，到 30 秒才再查", async () => {
    await prepare();
    const time = createFakeTimeSource();
    await startScenario(accepting(BLOCKED), accepting(CURRENT));
    const client = await openWithWorkspaceClients(time);
    await waitUntil(() => notices.length >= 1);

    fake.current = { check: STALE_IDLE, yield: "internal_error", helloError: "protocol_version" };
    await time.advanceAsync(30_500);
    await waitUntil(() => fake.methods().includes("upgrade.yield"));
    await settle();
    expect((await callError(client) as { code?: unknown }).code).toBe("daemon_upgrade_pending");
    expect(fake.methods()).not.toContain("hello");

    const connectionsAfterRecheck = fake.connectionCount();
    const checkCount = () => fake.methods().filter((method) => method === "upgrade.check").length;
    const checksAfterRecheck = checkCount();
    await time.advanceAsync(29_000);
    await settle();
    expect(fake.connectionCount()).toBe(connectionsAfterRecheck);
    expect(checkCount()).toBe(checksAfterRecheck);

    await time.advanceAsync(1_500);
    await waitUntil(() => checkCount() > checksAfterRecheck);
    expect((await callError(client) as { code?: unknown }).code).toBe("daemon_upgrade_pending");
  });

  test("不走 200 毫秒到 5 秒的退避重连：29 秒内没有新的连接尝试，到 30 秒才重新连接查一次", async () => {
    await prepare();
    const time = createFakeTimeSource();
    await startScenario(accepting(BLOCKED), accepting(CURRENT));
    await openWithWorkspaceClients(time);
    await waitUntil(() => notices.length >= 1);
    const connectionsBefore = fake.connectionCount();
    expect(connectionsBefore).toBe(1);

    await time.advanceAsync(29_000);
    await settle();
    expect(fake.connectionCount()).toBe(connectionsBefore);

    await time.advanceAsync(1_500);
    await waitUntil(() => fake.connectionCount() > connectionsBefore);
    await settle();
    expect(kinds()).toEqual(["waiting_blocked"]);
    expect(fake.methods()).not.toContain("hello");
  });
});

describe("窗口自己旧：协议版本号不一致", () => {
  test("不过旧的守护进程在 hello 报 protocol_version：call 抛 window_stale，发 1 条 window_stale", async () => {
    await prepare();
    const time = createFakeTimeSource();
    await startScenario(accepting(CURRENT, { helloError: "protocol_version" }));
    const client = await openWithWorkspaceClients(time);

    await waitUntil(() => notices.length >= 1);
    const error = await callError(client);
    expect((error as { code?: unknown }).code).toBe("window_stale");
    const name = basename(repo.root);
    const text = failureText("需求查询", error);
    expect(text).toBe(
      `需求查询失败。\n原因：这个窗口是旧版本，和${name} 已更新的后台进程不兼容。\n建议：请用户关掉这个窗口，运行 pi -c 重新打开，接着原来的对话。`,
    );
    expect(text).not.toMatch(/[0-9a-f]{64}/u);
    expect(kinds()).toEqual(["window_stale"]);
    expect(notices[0]?.repoName).toBe(name);
  });

  test("进入旧窗口状态后推进 2 分钟没有新的连接尝试，也没有第二条提示", async () => {
    await prepare();
    const time = createFakeTimeSource();
    await startScenario(accepting(CURRENT, { helloError: "protocol_version" }));
    await openWithWorkspaceClients(time);
    await waitUntil(() => notices.length >= 1);
    const connectionsBefore = fake.connectionCount();

    await time.advanceAsync(120_000);
    await settle();
    expect(fake.connectionCount()).toBe(connectionsBefore);
    expect(kinds()).toEqual(["window_stale"]);
  });
});

describe("兼容老守护进程与只连现有进程的客户端", () => {
  test("守护进程不认识 upgrade.check（unknown_method）：直接 hello，call 成功，不发任何提示", async () => {
    await prepare();
    await startScenario(accepting("unknown_method"));
    const client = await openWithConnectDaemon(createFakeTimeSource());

    expect(await client.call("ping")).toEqual({});
    await settle();
    expect(fake.methods()).toContain("hello");
    expect(fake.methods()).not.toContain("upgrade.yield");
    expect(notices).toEqual([]);
  });

  test("不认识 upgrade.check 的老守护进程在 hello 报 protocol_version：报后台进程是旧版本，不当成窗口旧", async () => {
    await prepare();
    const time = createFakeTimeSource();
    await startScenario(accepting("unknown_method", { helloError: "protocol_version" }));
    const client = await openWithWorkspaceClients(time);

    await waitUntil(() => fake.methods().includes("hello"));
    await settle();
    const error = await callError(client);
    expect((error as { code?: unknown }).code).not.toBe("window_stale");
    expect(String((error as Error).message)).toContain("后台进程是旧版本");
    expect(notices).toEqual([]);

    const connectionsBefore = fake.connectionCount();
    await time.advanceAsync(120_000);
    await settle();
    expect(fake.connectionCount()).toBe(connectionsBefore);
  });

  test("upgrade.check 报内部错误且 hello 报 protocol_version：按退避重连，重新检查后守护进程过旧且不忙则换新，call 成功", async () => {
    await prepare();
    const time = createFakeTimeSource();
    await startScenario(accepting("internal_error", { helloError: "protocol_version" }), accepting(CURRENT));
    const client = await openWithWorkspaceClients(time);
    await waitUntil(() => fake.methods().includes("hello"));

    fake.current = accepting(STALE_IDLE);
    await time.advanceAsync(6_000);
    await waitUntil(() => kinds().includes("replaced"));
    await waitUntil(async () => {
      try { await client.call("ping"); return true; } catch { return false; }
    });
    expect(fake.methods().filter((method) => method === "upgrade.check").length).toBeGreaterThanOrEqual(2);
  });

  test("upgrade.check 在途时守护进程断开连接：首连不会卡住，call 报不可达", async () => {
    await prepare();
    await startScenario(accepting("close"));
    const opened = openWithWorkspaceClients(createFakeTimeSource());
    const outcome = await Promise.race([opened.then(() => "opened"), delay(5_000).then(() => "timeout")]);

    expect(outcome).toBe("opened");
    const error = await callError(await opened);
    expect((error as { code?: unknown }).code).toBe("daemon_unreachable");
  });

  test("upgrade.check 报守护进程内部错误：直接 hello，call 成功，不发任何提示", async () => {
    await prepare();
    await startScenario(accepting("internal_error"));
    const client = await openWithConnectDaemon(createFakeTimeSource());

    expect(await client.call("ping")).toEqual({});
    await settle();
    expect(fake.methods()).toContain("hello");
    expect(fake.methods()).not.toContain("upgrade.yield");
    expect(notices).toEqual([]);
  });

  test("connectOnly 客户端不发 upgrade.check，也不让位，行为和现在一样", async () => {
    await prepare();
    await startScenario(accepting(STALE_IDLE), accepting(CURRENT));
    const client = await openWithConnectDaemon(createFakeTimeSource(), { connectOnly: true });

    expect(await client.call("ping")).toEqual({});
    await settle();
    expect(fake.methods().filter((method) => method.startsWith("upgrade."))).toEqual([]);
    expect(fake.methods()).toContain("hello");
    expect(notices).toEqual([]);
  });
});

describe("检查不可靠时的处理", () => {
  test("检查不可靠且 hello 报 protocol_version 退避重连期间，call 的原因写明协议版本不同、正在重新检查，不让用户关闭所有 pi 窗口", async () => {
    await prepare();
    const time = createFakeTimeSource();
    await startScenario(accepting("internal_error", { helloError: "protocol_version" }));
    const client = await openWithWorkspaceClients(time);
    await waitUntil(() => fake.methods().includes("hello"));
    await settle();

    const text = failureText("需求查询", await callError(client));
    const reasonLine = text.split("\n").find((line) => line.startsWith("原因：")) ?? "";
    expect(reasonLine).toContain("协议版本不同");
    expect(reasonLine).toContain("重新");
    expect(text).not.toContain("关闭所有 pi 窗口");
  });

  test("过旧且不忙但 upgrade.yield 失败、协议版本号相同：先照常可用不发提示，30 秒后在当前连接重查并换新，只发 1 条 replaced", async () => {
    await prepare();
    const time = createFakeTimeSource();
    await startScenario({ check: STALE_IDLE, yield: "internal_error" }, accepting(CURRENT));
    const client = await openWithWorkspaceClients(time);

    expect(await client.call("ping")).toEqual({});
    await settle();
    expect(notices).toEqual([]);
    expect(fake.methods()).toContain("hello");

    fake.current = accepting(STALE_IDLE);
    await time.advanceAsync(30_500);
    await waitUntil(() => notices.length >= 1);
    await settle();
    expect(kinds()).toEqual(["replaced"]);
    const checks = fake.requests.filter((request) => request.method === "upgrade.check");
    expect(checks[1]?.connection).toBe(1);
    await waitUntil(async () => {
      try { await client.call("ping"); return true; } catch { return false; }
    });
  });

  test("等待中连接掉线、重连时 upgrade.check 报内部错误：不发 replaced_after_wait，等待保持，30 秒后在当前连接重查，空闲让位后才发", async () => {
    await prepare();
    const time = createFakeTimeSource();
    await startScenario(accepting(STALE_BUSY), accepting(CURRENT));
    const client = await openWithWorkspaceClients(time);
    await waitUntil(() => kinds().includes("waiting_usable"));

    fake.current = accepting("internal_error");
    fake.dropConnections();
    await time.advanceAsync(6_000);
    await waitUntil(() => fake.connectionCount() >= 2 && fake.methods().filter((method) => method === "hello").length >= 2);
    await settle();
    expect(kinds()).toEqual(["waiting_usable"]);
    expect(await client.call("ping")).toEqual({});

    const checksBefore = fake.requests.filter((request) => request.method === "upgrade.check").length;
    fake.current = accepting(STALE_IDLE);
    await time.advanceAsync(30_500);
    await waitUntil(() => kinds().includes("replaced_after_wait"));
    expect(kinds()).toEqual(["waiting_usable", "replaced_after_wait"]);
    const recheck = fake.requests.filter((request) => request.method === "upgrade.check")[checksBefore];
    expect(recheck?.connection).toBe(2);
  });

  test("检查不可靠且 hello 成功后，30 秒重查得到不过旧就停止重查，不发提示", async () => {
    await prepare();
    const time = createFakeTimeSource();
    await startScenario(accepting("internal_error"));
    const client = await openWithWorkspaceClients(time);
    expect(await client.call("ping")).toEqual({});

    fake.current = accepting(CURRENT);
    await time.advanceAsync(30_500);
    await settle();
    const checkCount = () => fake.methods().filter((method) => method === "upgrade.check").length;
    expect(checkCount()).toBe(2);

    await time.advanceAsync(120_000);
    await settle();
    expect(checkCount()).toBe(2);
    expect(notices).toEqual([]);
  });

  test("首次检查不可靠、hello 成功，30 秒后重查得到过旧且在忙：进入等待，只发 1 条 waiting_usable，call 可用，再 30 秒仍忙不重复提示", async () => {
    await prepare();
    const time = createFakeTimeSource();
    await startScenario(accepting("internal_error"), accepting(CURRENT));
    const client = await openWithWorkspaceClients(time);
    expect(await client.call("ping")).toEqual({});
    expect(notices).toEqual([]);

    fake.current = accepting(STALE_BUSY);
    await time.advanceAsync(30_500);
    await waitUntil(() => notices.length >= 1);
    await settle();
    expect(kinds()).toEqual(["waiting_usable"]);
    expect(notices[0]).toMatchObject({ requirements: [], otherWindows: 1, ownSessions: 0 });
    expect(await client.call("ping")).toEqual({});

    const checkCount = () => fake.methods().filter((method) => method === "upgrade.check").length;
    const checksBefore = checkCount();
    await time.advanceAsync(30_500);
    await waitUntil(() => checkCount() > checksBefore);
    await settle();
    expect(kinds()).toEqual(["waiting_usable"]);
  });

  test("等待中旧守护进程退出、新一代首次检查不可靠：重连 hello 成功后 30 秒重查得到不过旧，发 1 条 replaced_after_wait 并停止重查", async () => {
    await prepare();
    const time = createFakeTimeSource();
    await startScenario(accepting(STALE_BUSY), accepting(CURRENT));
    const client = await openWithWorkspaceClients(time);
    await waitUntil(() => kinds().includes("waiting_usable"));

    fake.current = accepting("internal_error");
    fake.dropConnections();
    await time.advanceAsync(6_000);
    await waitUntil(() => fake.methods().filter((method) => method === "hello").length >= 2);
    await settle();
    expect(kinds()).toEqual(["waiting_usable"]);
    expect(await client.call("ping")).toEqual({});

    const checkCount = () => fake.methods().filter((method) => method === "upgrade.check").length;
    const checksBefore = checkCount();
    fake.current = accepting(CURRENT);
    await time.advanceAsync(30_500);
    await waitUntil(() => kinds().includes("replaced_after_wait"));
    await settle();
    expect(kinds()).toEqual(["waiting_usable", "replaced_after_wait"]);

    const checksAfterNotice = checkCount();
    expect(checksAfterNotice).toBeGreaterThan(checksBefore);
    await time.advanceAsync(120_000);
    await settle();
    expect(checkCount()).toBe(checksAfterNotice);
    expect(kinds()).toEqual(["waiting_usable", "replaced_after_wait"]);
  });

  test("过旧且不忙、upgrade.yield 失败、hello 报 protocol_version：不停止重连，退避期间 call 的原因写明协议版本不同、正在重新检查", async () => {
    await prepare();
    const time = createFakeTimeSource();
    await startScenario({ check: STALE_IDLE, yield: "internal_error", helloError: "protocol_version" });
    const client = await openWithWorkspaceClients(time);
    await waitUntil(() => fake.methods().includes("hello"));
    await settle();

    const text = failureText("需求查询", await callError(client));
    const reasonLine = text.split("\n").find((line) => line.startsWith("原因：")) ?? "";
    expect(reasonLine).toContain("协议版本不同");
    expect(reasonLine).toContain("重新");
    expect(text).not.toContain("关闭所有 pi 窗口");

    const connectionsBefore = fake.connectionCount();
    await time.advanceAsync(6_000);
    await waitUntil(() => fake.connectionCount() > connectionsBefore);
    expect(kinds()).not.toContain("window_stale");
  });
});
