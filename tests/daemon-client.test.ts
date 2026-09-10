import { temporaryRoot } from "./helpers/temporary-root.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { UUID_V7_PATTERN } from "../runtime/database.ts";
import { execFileSync, spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import type { Socket } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClock } from "../runtime/clock.ts";
import type { TimeSource } from "../runtime/clock.ts";
import { daemonSocketPath, repoDataDir, repositoryIdentity } from "../runtime/identity.ts";
import { putRecord, repositoryDatabase } from "../runtime/database.ts";
import { deleteRecord } from "./helpers/database-fixture.ts";
import {
  PROTOCOL_VERSION,
  createErrorResponse,
  createEvent,
  createResponse,
  decodeFrames,
  encodeFrame,
} from "../runtime/protocol.ts";
import type { Frame } from "../runtime/protocol.ts";
import { DaemonCallError, WorkspaceClients, connectDaemon, spawnDaemon } from "../runtime/daemon-client.ts";
import {
  connectTestClient,
  createDaemonFixture,
  maxDataRootLength,
  removeDaemonFixture,
  resolveNodeExecutable,
  resolveSdkDir,
} from "./helpers/daemon-harness.ts";
import type { DaemonFixture } from "./helpers/daemon-harness.ts";
import { addWorktree, createRepoFixture, createWorkspaceFixture, removeRepoFixture } from "./helpers/repo-fixture.ts";
import type { RepoFixture, WorkspaceFixture } from "./helpers/repo-fixture.ts";

const GIT_TEST_ENV = {
  PATH: process.env.PATH ?? "",
  HOME: process.env.HOME ?? "",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: "daemon-client-test",
  GIT_AUTHOR_EMAIL: "daemon-client-test@example.com",
  GIT_COMMITTER_NAME: "daemon-client-test",
  GIT_COMMITTER_EMAIL: "daemon-client-test@example.com",
};

function gitAt(args: string[], cwd: string): void {
  execFileSync("git", args, { cwd, env: GIT_TEST_ENV, timeout: 10_000 });
}

async function initRepoAt(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  gitAt(["init", "-b", "main"], dir);
  await writeFile(join(dir, "README.md"), "daemon-client test fixture\n");
  gitAt(["add", "README.md"], dir);
  gitAt(["commit", "-m", "initial commit"], dir);
}

interface Closable {
  close?: () => void;
  closeAll?: () => void;
}

const fixtures: DaemonFixture[] = [];
const repoFixtures: Array<RepoFixture | WorkspaceFixture> = [];
const extraTempDirs: string[] = [];
const daemonPids: number[] = [];
const closables: Closable[] = [];

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs: number, intervalMs = 100): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await delay(intervalMs);
  }
  throw new Error(`等待条件满足超时（${timeoutMs}ms）`);
}

async function probeDaemonPid(socketPath: string): Promise<number> {
  const raw = await connectTestClient(socketPath);
  const pid = raw.helloResult.daemonPid as number;
  raw.close();
  return pid;
}

const helpersDir = join(dirname(fileURLToPath(import.meta.url)), "helpers");
const spawnAndExitDaemonScript = join(helpersDir, "spawn-and-exit-daemon.ts");
const fakeDaemonShimPath = join(helpersDir, "fake-daemon-shim.ts");

function runChildProcess(scriptPath: string, args: string[]): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(resolveNodeExecutable(), [scriptPath, ...args], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, stderr }));
  });
}

// macOS(BSD) 的 "E" 需单独出现在 flag 簇里才会把环境变量附加到输出；Linux(procps) 用小写 "e" 且要求 "www" 加宽，两套语法不通用
function daemonPidsForDataRoot(dataRoot: string): number[] {
  const args = process.platform === "linux" ? ["-axewwo", "pid,command"] : ["-axEwwo", "pid,command"];
  const table = execFileSync("ps", args, { encoding: "utf8", env: { ...process.env, LC_ALL: "C" }, maxBuffer: 32 * 1024 * 1024 });
  const pids: number[] = [];
  for (const line of table.split("\n")) {
    if (!line.includes("daemon/main.ts") || !line.includes(`PI_COMPANY_DATA_ROOT=${dataRoot}`)) continue;
    const pid = Number.parseInt(line.trim().split(/\s+/)[0] ?? "", 10);
    if (Number.isFinite(pid) && pid > 1) pids.push(pid);
  }
  return pids;
}

function killPid(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // 目标进程可能已经退出
  }
}

function captureUncaughtExceptions(): { count: () => number; restore: () => void } {
  let count = 0;
  const handler = () => {
    count += 1;
  };
  process.on("uncaughtException", handler);
  return { count: () => count, restore: () => process.removeListener("uncaughtException", handler) };
}

interface FakeDaemonServer {
  connectionCount: () => number;
  close: () => void;
}

function createFakeDaemonServer(
  socketPath: string,
  onHello: (frame: Extract<Frame, { t: "req" }>, socket: Socket) => void,
  onOtherRequest?: (frame: Extract<Frame, { t: "req" }>, socket: Socket) => void,
): FakeDaemonServer {
  let connectionCount = 0;
  const server = createServer((socket: Socket) => {
    connectionCount += 1;
    let buffer = "";
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const { frames, rest } = decodeFrames(buffer);
      buffer = rest;
      for (const frame of frames) {
        if (frame.t !== "req") continue;
        if (frame.method === "hello") onHello(frame, socket);
        else onOtherRequest?.(frame, socket);
      }
    });
  });
  server.listen(socketPath);
  return { connectionCount: () => connectionCount, close: () => server.close() };
}

async function overLimitDataRoot(): Promise<string> {
  const target = maxDataRootLength() + 1;
  const base = await mkdtemp(join(temporaryRoot(), "d"));
  extraTempDirs.push(base);
  const padLength = target - base.length - 1;
  const dir = padLength > 0 ? join(base, "x".repeat(padLength)) : base;
  await mkdir(dir, { recursive: true });
  return dir;
}

afterEach(async () => {
  for (const closable of closables.splice(0)) {
    try {
      closable.close?.();
      closable.closeAll?.();
    } catch {
      // 连接可能已因守护进程退出而关闭
    }
  }
  for (const pid of daemonPids.splice(0)) killPid(pid);
  await delay(200);
  const knownDataRoots = new Set([...fixtures.map((f) => f.dataRoot), ...extraTempDirs]);
  for (const dataRoot of knownDataRoots) {
    for (const pid of daemonPidsForDataRoot(dataRoot)) killPid(pid);
  }
  await delay(300);
  for (const fixture of fixtures.splice(0)) await removeDaemonFixture(fixture);
  for (const repoFixture of repoFixtures.splice(0)) await removeRepoFixture(repoFixture);
  for (const dir of extraTempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("单实例收敛", () => {
  test("未运行时并发两次 connectDaemon 只拉起一个守护进程实例", async () => {
    const fixture = await createDaemonFixture();
    fixtures.push(fixture);

    const [clientA, clientB] = await Promise.all([
      connectDaemon({
        repoDir: fixture.repoDir,
        dataRoot: fixture.dataRoot,
        sdkDir: resolveSdkDir(),
        execPath: resolveNodeExecutable(),
        hello: {
          windowId: "window-a",
          pid: process.pid,
          sessionId: "session-a",
          cwd: fixture.repo.root,
          workspaceRoot: fixture.repo.root,
        },
      }),
      connectDaemon({
        repoDir: fixture.repoDir,
        dataRoot: fixture.dataRoot,
        sdkDir: resolveSdkDir(),
        execPath: resolveNodeExecutable(),
        hello: {
          windowId: "window-b",
          pid: process.pid,
          sessionId: "session-b",
          cwd: fixture.repo.root,
          workspaceRoot: fixture.repo.root,
        },
      }),
    ]);
    closables.push(clientA, clientB);

    expect(clientA.state().status).toBe("connected");
    expect(clientB.state().status).toBe("connected");

    const pidA = await probeDaemonPid(fixture.socketPath);
    const pidB = await probeDaemonPid(fixture.socketPath);
    daemonPids.push(pidA);
    expect(pidA).toBe(pidB);
    expect(daemonPidsForDataRoot(fixture.dataRoot)).toHaveLength(1);
  }, 30_000);

  test("已运行的守护进程被再次 connectDaemon 时不再拉起新实例", async () => {
    const fixture = await createDaemonFixture();
    fixtures.push(fixture);

    const client1 = await connectDaemon({
      repoDir: fixture.repoDir,
      dataRoot: fixture.dataRoot,
      sdkDir: resolveSdkDir(),
      execPath: resolveNodeExecutable(),
      hello: {
        windowId: "window-first",
        pid: process.pid,
        sessionId: "session-first",
        cwd: fixture.repo.root,
        workspaceRoot: fixture.repo.root,
      },
    });
    closables.push(client1);
    expect(client1.state().status).toBe("connected");

    const pidBefore = await probeDaemonPid(fixture.socketPath);
    daemonPids.push(pidBefore);

    const client2 = await connectDaemon({
      repoDir: fixture.repoDir,
      dataRoot: fixture.dataRoot,
      sdkDir: resolveSdkDir(),
      execPath: resolveNodeExecutable(),
      hello: {
        windowId: "window-second",
        pid: process.pid,
        sessionId: "session-second",
        cwd: fixture.repo.root,
        workspaceRoot: fixture.repo.root,
      },
    });
    closables.push(client2);
    expect(client2.state().status).toBe("connected");

    const pidAfter = await probeDaemonPid(fixture.socketPath);
    expect(pidAfter).toBe(pidBefore);
  }, 30_000);
});

describe("worktree 与工作区", () => {
  test("同一仓库主目录与其 worktree 连接到同一个守护进程（socket 路径相同）", async () => {
    const repo = await createRepoFixture();
    repoFixtures.push(repo);
    const worktree = await addWorktree(repo);

    const dataRoot = await mkdtemp(join(temporaryRoot(), "d"));
    extraTempDirs.push(dataRoot);

    const mainIdentity = await repositoryIdentity(repo.root);
    const worktreeIdentity = await repositoryIdentity(worktree.root);
    expect(worktreeIdentity.repoId).toBe(mainIdentity.repoId);
    const expectedSocketPath = daemonSocketPath(dataRoot, mainIdentity.repoId);

    const clientMain = await connectDaemon({
      repoDir: repo.root,
      dataRoot,
      sdkDir: resolveSdkDir(),
      execPath: resolveNodeExecutable(),
      hello: {
        windowId: "window-main",
        pid: process.pid,
        sessionId: "session-main",
        cwd: repo.root,
        workspaceRoot: repo.root,
      },
    });
    closables.push(clientMain);
    expect(clientMain.state().status).toBe("connected");

    const clientWorktree = await connectDaemon({
      repoDir: worktree.root,
      dataRoot,
      sdkDir: resolveSdkDir(),
      execPath: resolveNodeExecutable(),
      hello: {
        windowId: "window-worktree",
        pid: process.pid,
        sessionId: "session-worktree",
        cwd: worktree.root,
        workspaceRoot: worktree.root,
      },
    });
    closables.push(clientWorktree);
    expect(clientWorktree.state().status).toBe("connected");

    const pidMain = await probeDaemonPid(expectedSocketPath);
    daemonPids.push(pidMain);
    const pidWorktree = await probeDaemonPid(expectedSocketPath);
    expect(pidWorktree).toBe(pidMain);
  }, 30_000);

  test("工作区夹具下 WorkspaceClients.all 恰有两个连接，工作区外仓库不在其中", async () => {
    const workspace = await createWorkspaceFixture();
    repoFixtures.push(workspace);
    const outside = await createRepoFixture();
    repoFixtures.push(outside);

    const dataRoot = await mkdtemp(join(temporaryRoot(), "d"));
    extraTempDirs.push(dataRoot);

    const workspaceClients = await WorkspaceClients.create({
      workspaceRoot: workspace.root,
      dataRoot,
      sdkDir: resolveSdkDir(),
      execPath: resolveNodeExecutable(),
      hello: {
        windowId: "window-workspace",
        pid: process.pid,
        sessionId: "session-workspace",
        cwd: workspace.root,
        workspaceRoot: workspace.root,
      },
    });
    closables.push(workspaceClients);

    const all = workspaceClients.all();
    expect(all.length).toBe(2);
    for (const client of all) expect(client.state().status).toBe("connected");

    const repoIds = await Promise.all(workspace.repos.map(async (repoPath) => (await repositoryIdentity(repoPath)).repoId));
    for (const repoId of repoIds) {
      expect(workspaceClients.forRepo(repoId)).toBeDefined();
      daemonPids.push(await probeDaemonPid(daemonSocketPath(dataRoot, repoId)));
    }

    const outsideId = (await repositoryIdentity(outside.root)).repoId;
    expect(workspaceClients.forRepo(outsideId)).toBeUndefined();
  }, 40_000);

  test("workspace() 返回含两仓库 path/repoId 的发现结果", async () => {
    const workspace = await createWorkspaceFixture();
    repoFixtures.push(workspace);

    const dataRoot = await mkdtemp(join(temporaryRoot(), "d"));
    extraTempDirs.push(dataRoot);

    const workspaceClients = await WorkspaceClients.create({
      workspaceRoot: workspace.root,
      dataRoot,
      sdkDir: resolveSdkDir(),
      execPath: resolveNodeExecutable(),
      hello: {
        windowId: "window-workspace-accessor",
        pid: process.pid,
        sessionId: "session-workspace-accessor",
        cwd: workspace.root,
        workspaceRoot: workspace.root,
      },
    });
    closables.push(workspaceClients);

    const discovered = workspaceClients.workspace();
    expect(discovered.repos.length).toBe(2);

    for (const repoPath of workspace.repos) {
      const identity = await repositoryIdentity(repoPath);
      const match = discovered.repos.find((repo) => repo.repoId === identity.repoId);
      expect(match).toBeDefined();
      expect(typeof match?.path).toBe("string");
      expect(match?.path.length ?? 0).toBeGreaterThan(0);
    }

    const repoIds = await Promise.all(workspace.repos.map(async (repoPath) => (await repositoryIdentity(repoPath)).repoId));
    for (const repoId of repoIds) {
      daemonPids.push(await probeDaemonPid(daemonSocketPath(dataRoot, repoId)));
    }
  }, 40_000);
});

describe("不可达状态与自动重连", () => {
  test("守护进程被强杀后连接经历 unreachable → 拒绝调用 → 自动重连恢复", async () => {
    const fixture = await createDaemonFixture();
    fixtures.push(fixture);

    const client = await connectDaemon({
      repoDir: fixture.repoDir,
      dataRoot: fixture.dataRoot,
      sdkDir: resolveSdkDir(),
      execPath: resolveNodeExecutable(),
      hello: {
        windowId: "window-outage",
        pid: process.pid,
        sessionId: "session-outage",
        cwd: fixture.repo.root,
        workspaceRoot: fixture.repo.root,
      },
    });
    closables.push(client);
    await waitUntil(() => client.state().status === "connected", 15_000);

    const cancelSubscription = client.subscribe("runs.changed", () => {});

    const pidBefore = await probeDaemonPid(fixture.socketPath);
    process.kill(pidBefore, "SIGKILL");

    await waitUntil(() => client.state().status === "unreachable", 10_000);
    expect(client.state().reason).toBeTruthy();

    const rejectStart = Date.now();
    await expect(client.call("ping", {})).rejects.toThrow();
    expect(Date.now() - rejectStart).toBeLessThan(3_000);

    await spawnDaemon({
      repoDir: fixture.repoDir,
      dataRoot: fixture.dataRoot,
      sdkDir: resolveSdkDir(),
      execPath: resolveNodeExecutable(),
    });
    const pidAfter = await probeDaemonPid(fixture.socketPath);
    daemonPids.push(pidAfter);
    expect(pidAfter).not.toBe(pidBefore);

    await waitUntil(() => client.state().status === "connected", 15_000);

    expect(typeof cancelSubscription).toBe("function");
    expect(() => cancelSubscription()).not.toThrow();
  }, 60_000);
});

describe("睡眠感知重连", () => {
  test("注入 5 分钟睡眠间隔后客户端仍在正常时间内重连，不被误判为失联超时", async () => {
    const fixture = await createDaemonFixture();
    fixtures.push(fixture);

    const offset = { value: 0 };
    const timeSource: TimeSource = {
      now: () => Date.now() + offset.value,
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    };
    const clock = createClock({ timeSource });

    const client = await connectDaemon({
      repoDir: fixture.repoDir,
      dataRoot: fixture.dataRoot,
      sdkDir: resolveSdkDir(),
      execPath: resolveNodeExecutable(),
      clock,
      hello: {
        windowId: "window-sleep",
        pid: process.pid,
        sessionId: "session-sleep",
        cwd: fixture.repo.root,
        workspaceRoot: fixture.repo.root,
      },
    });
    closables.push(client);
    await waitUntil(() => client.state().status === "connected", 15_000);

    const pidBefore = await probeDaemonPid(fixture.socketPath);
    process.kill(pidBefore, "SIGKILL");
    await waitUntil(() => client.state().status === "unreachable", 10_000);

    offset.value += 5 * 60 * 1000;
    await delay(1_500);

    await spawnDaemon({
      repoDir: fixture.repoDir,
      dataRoot: fixture.dataRoot,
      sdkDir: resolveSdkDir(),
      execPath: resolveNodeExecutable(),
    });
    const pidAfter = await probeDaemonPid(fixture.socketPath);
    daemonPids.push(pidAfter);

    const recoveryStart = Date.now();
    await waitUntil(() => client.state().status === "connected", 20_000);
    expect(Date.now() - recoveryStart).toBeLessThan(20_000);
    expect(clock.sleepGaps().length).toBeGreaterThanOrEqual(1);
  }, 60_000);
});

describe("hello 帧", () => {
  test("hello 请求帧包含 windowId、pid、sessionId、cwd、workspaceRoot、repoIds、protocolVersion", async () => {
    const repo = await createRepoFixture();
    repoFixtures.push(repo);
    const dataRoot = await mkdtemp(join(temporaryRoot(), "d"));
    extraTempDirs.push(dataRoot);

    const identity = await repositoryIdentity(repo.root);
    const socketPath = daemonSocketPath(dataRoot, identity.repoId);
    await mkdir(dirname(socketPath), { recursive: true });

    const capturedFrame = new Promise<Frame>((resolve) => {
      const server = createServer((socket: Socket) => {
        let buffer = "";
        socket.on("data", (chunk: Buffer) => {
          buffer += chunk.toString("utf8");
          const { frames, rest } = decodeFrames(buffer);
          buffer = rest;
          for (const frame of frames) {
            if (frame.t === "req" && frame.method === "hello") {
              socket.write(
                encodeFrame(
                  createResponse(frame.id, {
                    daemonPid: process.pid,
                    repoId: identity.repoId,
                    protocolVersion: PROTOCOL_VERSION,
                    startedAt: new Date().toISOString(),
                  }),
                ),
              );
              resolve(frame);
              server.close();
            }
          }
        });
      });
      server.listen(socketPath);
    });

    const hello = {
      windowId: "window-hello",
      pid: 4242,
      sessionId: "session-hello",
      cwd: repo.root,
      workspaceRoot: repo.root,
    };

    const client = await connectDaemon({
      repoDir: repo.root,
      dataRoot,
      sdkDir: resolveSdkDir(),
      execPath: resolveNodeExecutable(),
      hello,
    });
    closables.push(client);

    const frame = await capturedFrame;
    if (frame.t !== "req") throw new Error("未捕获到 hello 请求帧");
    const params = frame.params;
    expect(params.windowId).toBe(hello.windowId);
    expect(params.pid).toBe(hello.pid);
    expect(params.sessionId).toBe(hello.sessionId);
    expect(params.cwd).toBe(hello.cwd);
    expect(params.workspaceRoot).toBe(hello.workspaceRoot);
    expect(Array.isArray(params.repoIds)).toBe(true);
    expect(params.repoIds).toContain(identity.repoId);
    expect(params.protocolVersion).toBe(PROTOCOL_VERSION);
  }, 15_000);
});

describe("spawn 失败归因", () => {
  test("execPath 指向不存在路径时 connectDaemon 携带具体原因 reject 且不触发未捕获异常", async () => {
    const fixture = await createDaemonFixture();
    fixtures.push(fixture);

    const guard = captureUncaughtExceptions();
    try {
      await expect(
        connectDaemon({
          repoDir: fixture.repoDir,
          dataRoot: fixture.dataRoot,
          sdkDir: resolveSdkDir(),
          execPath: "/no/such/executable-daemon-client-test",
          hello: {
            windowId: "window-bad-exec",
            pid: process.pid,
            sessionId: "session-bad-exec",
            cwd: fixture.repo.root,
            workspaceRoot: fixture.repo.root,
          },
        }),
      ).rejects.toThrow();
    } finally {
      guard.restore();
    }
    expect(guard.count()).toBe(0);
  }, 15_000);

  test("SDK 目录不存在导致守护进程启动即退出时 connectDaemon 的 reject 原因包含守护进程的失败信息", async () => {
    const repo = await createRepoFixture();
    repoFixtures.push(repo);
    const dataRoot = await mkdtemp(join(temporaryRoot(), "d"));
    extraTempDirs.push(dataRoot);

    await expect(
      connectDaemon({
        repoDir: repo.root,
        dataRoot,
        sdkDir: "/no/such/sdk-dir-daemon-client-test",
        execPath: resolveNodeExecutable(),
        hello: {
          windowId: "window-badsdk",
          pid: process.pid,
          sessionId: "session-badsdk",
          cwd: repo.root,
          workspaceRoot: repo.root,
        },
      }),
    ).rejects.toThrow(/sdk-dir-daemon-client-test|SDK/);
  }, 20_000);

  test("dataRoot 过长导致 socket 路径超限时 connectDaemon 携带具体原因 reject", async () => {
    const repo = await createRepoFixture();
    repoFixtures.push(repo);
    const dataRoot = await overLimitDataRoot();

    await expect(
      connectDaemon({
        repoDir: repo.root,
        dataRoot,
        sdkDir: resolveSdkDir(),
        execPath: resolveNodeExecutable(),
        hello: {
          windowId: "window-toolong",
          pid: process.pid,
          sessionId: "session-toolong",
          cwd: repo.root,
          workspaceRoot: repo.root,
        },
      }),
    ).rejects.toThrow(/超限|超出|exceed/);
  }, 15_000);
});

describe("守护进程日志归因边界", () => {
  async function silentExitScript(dir: string): Promise<string> {
    const path = join(dir, "silent-exit.sh");
    await writeFile(path, "#!/bin/sh\nexit 0\n");
    await chmod(path, 0o755);
    return path;
  }

  test("上一次启动失败留下的日志不会被当作本次启动失败的原因", async () => {
    const repo = await createRepoFixture();
    repoFixtures.push(repo);
    const dataRoot = await mkdtemp(join(temporaryRoot(), "d"));
    extraTempDirs.push(dataRoot);
    const hello = { windowId: "window-stale-log", pid: process.pid, sessionId: "session-stale-log", cwd: repo.root, workspaceRoot: repo.root };

    await expect(
      connectDaemon({ repoDir: repo.root, dataRoot, sdkDir: "/no/such/sdk-STALE-LOG-MARKER", execPath: resolveNodeExecutable(), hello }),
    ).rejects.toThrow(/STALE-LOG-MARKER/);

    await expect(
      connectDaemon({ repoDir: repo.root, dataRoot, sdkDir: resolveSdkDir(), execPath: await silentExitScript(dataRoot), hello }),
    ).rejects.not.toThrow(/STALE-LOG-MARKER/);
  }, 30_000);

  test("启动失败写入独立 UUIDv7 日志，权限私有且不写入 SQLite 事件", async () => {
    const repo = await createRepoFixture();
    repoFixtures.push(repo);
    const dataRoot = await mkdtemp(join(temporaryRoot(), "d"));
    extraTempDirs.push(dataRoot);
    const identity = await repositoryIdentity(repo.root);
    const logDir = join(dataRoot, "repos", identity.repoId, "logs");
    const markers = ["第一次启动失败标记", "第二次启动失败标记"];
    await Promise.all(markers.map(async (marker) => {
      await expect(spawnDaemon({ repoDir: repo.root, dataRoot, sdkDir: `/no/such/${marker}`, execPath: resolveNodeExecutable() })).rejects.toThrow(marker);
    }));
    const files = await readdir(logDir);
    expect(files).toHaveLength(2);
    const contents: string[] = [];
    for (const file of files) {
      expect(file.endsWith(".log")).toBe(true);
      expect(file.slice(0, -4)).toMatch(UUID_V7_PATTERN);
      expect((await stat(join(logDir, file))).mode & 0o777).toBe(0o600);
      contents.push(await readFile(join(logDir, file), "utf8"));
    }
    for (const marker of markers) expect(contents.filter((content) => content.includes(marker))).toHaveLength(1);
    expect(contents.every((content) => markers.filter((marker) => content.includes(marker)).length === 1)).toBe(true);
    const database = new Database(repositoryDatabase(dataRoot, identity.repoId), { readonly: true });
    try { expect(database.query("SELECT count(*) AS count FROM events").get()).toEqual({ count: 0 }); }
    finally { database.close(); }
  }, 15_000);
});

describe("事件分发隔离", () => {
  test("一个事件监听器抛错不影响同一事件的其他监听器", async () => {
    const repo = await createRepoFixture();
    repoFixtures.push(repo);
    const dataRoot = await mkdtemp(join(temporaryRoot(), "d"));
    extraTempDirs.push(dataRoot);
    const identity = await repositoryIdentity(repo.root);
    const socketPath = daemonSocketPath(dataRoot, identity.repoId);
    await mkdir(dirname(socketPath), { recursive: true });

    let pushEvent: (() => void) | undefined;
    const fake = createFakeDaemonServer(socketPath, (frame, socket) => {
      socket.write(
        encodeFrame(
          createResponse(frame.id, {
            daemonPid: process.pid,
            repoId: identity.repoId,
            protocolVersion: PROTOCOL_VERSION,
            startedAt: new Date().toISOString(),
          }),
        ),
      );
      pushEvent = () => socket.write(encodeFrame(createEvent("runs.changed", { note: "test-event" })));
    });

    const guard = captureUncaughtExceptions();
    try {
      const client = await connectDaemon({
        repoDir: repo.root,
        dataRoot,
        sdkDir: resolveSdkDir(),
        execPath: resolveNodeExecutable(),
        hello: {
          windowId: "window-isolation",
          pid: process.pid,
          sessionId: "session-isolation",
          cwd: repo.root,
          workspaceRoot: repo.root,
        },
      });
      closables.push(client);

      const secondReceived: unknown[] = [];
      client.subscribe("runs.changed", () => {
        throw new Error("监听器故意抛错");
      });
      client.subscribe("runs.changed", (data) => secondReceived.push(data));

      pushEvent?.();
      await waitUntil(() => secondReceived.length > 0, 3_000);
      expect(secondReceived).toHaveLength(1);
    } finally {
      guard.restore();
      fake.close();
    }
  }, 15_000);
});

describe("close 语义", () => {
  test("close 后在途调用以不可达在 1 秒内 reject 而非挂起", async () => {
    const repo = await createRepoFixture();
    repoFixtures.push(repo);
    const dataRoot = await mkdtemp(join(temporaryRoot(), "d"));
    extraTempDirs.push(dataRoot);
    const identity = await repositoryIdentity(repo.root);
    const socketPath = daemonSocketPath(dataRoot, identity.repoId);
    await mkdir(dirname(socketPath), { recursive: true });

    const fake = createFakeDaemonServer(
      socketPath,
      (frame, socket) => {
        socket.write(
          encodeFrame(
            createResponse(frame.id, {
              daemonPid: process.pid,
              repoId: identity.repoId,
              protocolVersion: PROTOCOL_VERSION,
              startedAt: new Date().toISOString(),
            }),
          ),
        );
      },
      () => {
        // 故意不回应，模拟一个悬而未决的调用
      },
    );

    try {
      const client = await connectDaemon({
        repoDir: repo.root,
        dataRoot,
        sdkDir: resolveSdkDir(),
        execPath: resolveNodeExecutable(),
        hello: {
          windowId: "window-close-pending",
          pid: process.pid,
          sessionId: "session-close-pending",
          cwd: repo.root,
          workspaceRoot: repo.root,
        },
      });

      const pendingCall = client.call("ping", {});
      await delay(100);
      client.close();

      const raced = await Promise.race([
        pendingCall.then(
          () => ({ kind: "resolved" as const }),
          (error: Error) => ({ kind: "rejected" as const, message: error.message }),
        ),
        delay(1_000).then(() => ({ kind: "timeout" as const })),
      ]);
      expect(raced.kind).toBe("rejected");
      if (raced.kind === "rejected") expect(raced.message).toContain("不可达");
    } finally {
      fake.close();
    }
  }, 15_000);

  test("守护进程被强杀后立即 close 不再重连，重新拉起的守护进程随后自行空闲退出", async () => {
    const fixture = await createDaemonFixture();
    fixtures.push(fixture);

    const client = await connectDaemon({
      repoDir: fixture.repoDir,
      dataRoot: fixture.dataRoot,
      sdkDir: resolveSdkDir(),
      execPath: resolveNodeExecutable(),
      env: { PI_COMPANY_IDLE_TIMEOUT_MS: "1000" },
      hello: {
        windowId: "window-close-race",
        pid: process.pid,
        sessionId: "session-close-race",
        cwd: fixture.repo.root,
        workspaceRoot: fixture.repo.root,
      },
    });
    closables.push(client);
    await waitUntil(() => client.state().status === "connected", 15_000);

    const pidBefore = await probeDaemonPid(fixture.socketPath);
    process.kill(pidBefore, "SIGKILL");

    await waitUntil(() => client.state().status === "starting", 10_000);
    client.close();

    expect(client.state().status).not.toBe("connected");
    await waitUntil(() => daemonPidsForDataRoot(fixture.dataRoot).length === 0, 10_000);
    await delay(2_000);
    expect(daemonPidsForDataRoot(fixture.dataRoot)).toHaveLength(0);
  }, 30_000);
});

describe("hello 阶段失败", () => {
  test("hello 阶段协议版本不一致时 connectDaemon reject 且不留下后台重连循环", async () => {
    const repo = await createRepoFixture();
    repoFixtures.push(repo);
    const dataRoot = await mkdtemp(join(temporaryRoot(), "d"));
    extraTempDirs.push(dataRoot);
    const identity = await repositoryIdentity(repo.root);
    const socketPath = daemonSocketPath(dataRoot, identity.repoId);
    await mkdir(dirname(socketPath), { recursive: true });

    const fake = createFakeDaemonServer(socketPath, (frame, socket) => {
      socket.write(encodeFrame(createErrorResponse(frame.id, "protocol_version", "协议版本不一致（测试注入）")));
      socket.end();
    });

    try {
      await expect(
        connectDaemon({
          repoDir: repo.root,
          dataRoot,
          sdkDir: resolveSdkDir(),
          execPath: resolveNodeExecutable(),
          hello: {
            windowId: "window-version",
            pid: process.pid,
            sessionId: "session-version",
            cwd: repo.root,
            workspaceRoot: repo.root,
          },
        }),
      ).rejects.toThrow();

      const connectionsAfterReject = fake.connectionCount();
      await delay(3_000);
      expect(fake.connectionCount()).toBe(connectionsAfterReject);
    } finally {
      fake.close();
    }
  }, 15_000);

  test("hello 响应的 repoId 与预期不一致时 connectDaemon reject", async () => {
    const repo = await createRepoFixture();
    repoFixtures.push(repo);
    const dataRoot = await mkdtemp(join(temporaryRoot(), "d"));
    extraTempDirs.push(dataRoot);
    const identity = await repositoryIdentity(repo.root);
    const socketPath = daemonSocketPath(dataRoot, identity.repoId);
    await mkdir(dirname(socketPath), { recursive: true });

    const fake = createFakeDaemonServer(socketPath, (frame, socket) => {
      socket.write(
        encodeFrame(
          createResponse(frame.id, {
            daemonPid: process.pid,
            repoId: "wrong-repo-id-injected-by-test",
            protocolVersion: PROTOCOL_VERSION,
            startedAt: new Date().toISOString(),
          }),
        ),
      );
    });

    try {
      await expect(
        connectDaemon({
          repoDir: repo.root,
          dataRoot,
          sdkDir: resolveSdkDir(),
          execPath: resolveNodeExecutable(),
          hello: {
            windowId: "window-repoid",
            pid: process.pid,
            sessionId: "session-repoid",
            cwd: repo.root,
            workspaceRoot: repo.root,
          },
        }),
      ).rejects.toThrow();
    } finally {
      fake.close();
    }
  }, 15_000);
});

describe("失败帧转换为 DaemonCallError", () => {
  test("守护进程返回带 data 的错误帧时，client.call reject 的是 DaemonCallError 实例且 code/data 正确", async () => {
    const repo = await createRepoFixture();
    repoFixtures.push(repo);
    const dataRoot = await mkdtemp(join(temporaryRoot(), "d"));
    extraTempDirs.push(dataRoot);
    const identity = await repositoryIdentity(repo.root);
    const socketPath = daemonSocketPath(dataRoot, identity.repoId);
    await mkdir(dirname(socketPath), { recursive: true });

    const fake = createFakeDaemonServer(
      socketPath,
      (frame, socket) => {
        socket.write(
          encodeFrame(
            createResponse(frame.id, {
              daemonPid: process.pid,
              repoId: identity.repoId,
              protocolVersion: PROTOCOL_VERSION,
              startedAt: new Date().toISOString(),
            }),
          ),
        );
      },
      (frame, socket) => {
        socket.write(encodeFrame(createErrorResponse(frame.id, "already_active", "需求已有活动运行", { runId: "run-1" })));
      },
    );

    try {
      const client = await connectDaemon({
        repoDir: repo.root,
        dataRoot,
        sdkDir: resolveSdkDir(),
        execPath: resolveNodeExecutable(),
        hello: {
          windowId: "window-error-data",
          pid: process.pid,
          sessionId: "session-error-data",
          cwd: repo.root,
          workspaceRoot: repo.root,
        },
      });
      closables.push(client);

      let caught: unknown;
      try {
        await client.call("dispatch.requirement", { requirement: "2026-09-09.demo", cwd: repo.root });
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(DaemonCallError);
      expect((caught as DaemonCallError).code).toBe("already_active");
      expect((caught as DaemonCallError).data).toEqual({ runId: "run-1" });
    } finally {
      fake.close();
    }
  }, 15_000);
});

describe("WorkspaceClients 去重与降级", () => {
  test("主目录与其 worktree 同处工作区时只建立一个连接", async () => {
    const workspaceRoot = await mkdtemp(join(temporaryRoot(), "d"));
    extraTempDirs.push(workspaceRoot);
    const mainDir = join(workspaceRoot, "main");
    await initRepoAt(mainDir);
    const worktreeDir = join(workspaceRoot, "wt");
    gitAt(["worktree", "add", "-b", "wt-branch", worktreeDir], mainDir);

    const dataRoot = await mkdtemp(join(temporaryRoot(), "d"));
    extraTempDirs.push(dataRoot);

    const workspaceClients = await WorkspaceClients.create({
      workspaceRoot,
      dataRoot,
      sdkDir: resolveSdkDir(),
      execPath: resolveNodeExecutable(),
      hello: {
        windowId: "window-dedupe",
        pid: process.pid,
        sessionId: "session-dedupe",
        cwd: workspaceRoot,
        workspaceRoot,
      },
    });
    closables.push(workspaceClients);

    expect(workspaceClients.all()).toHaveLength(1);

    const identity = await repositoryIdentity(mainDir);
    daemonPids.push(await probeDaemonPid(daemonSocketPath(dataRoot, identity.repoId)));
  }, 30_000);

  test("某仓库首连失败时其余仓库连接不因整体 reject 而泄漏", async () => {
    const workspaceRoot = await mkdtemp(join(temporaryRoot(), "d"));
    extraTempDirs.push(workspaceRoot);
    const repoADir = join(workspaceRoot, "repo-a");
    const repoBDir = join(workspaceRoot, "repo-b");
    await initRepoAt(repoADir);
    await initRepoAt(repoBDir);

    const dataRoot = await mkdtemp(join(temporaryRoot(), "d"));
    extraTempDirs.push(dataRoot);

    const identityA = await repositoryIdentity(repoADir);
    const identityB = await repositoryIdentity(repoBDir);
    const socketPathA = daemonSocketPath(dataRoot, identityA.repoId);
    await mkdir(dirname(socketPathA), { recursive: true });

    const fakeA = createFakeDaemonServer(socketPathA, (frame, socket) => {
      socket.write(encodeFrame(createErrorResponse(frame.id, "protocol_version", "协议版本不一致（测试注入）")));
      socket.end();
    });

    try {
      const workspaceClients = await WorkspaceClients.create({
        workspaceRoot,
        dataRoot,
        sdkDir: resolveSdkDir(),
        execPath: resolveNodeExecutable(),
        hello: {
          windowId: "window-degrade",
          pid: process.pid,
          sessionId: "session-degrade",
          cwd: workspaceRoot,
          workspaceRoot,
        },
      });
      closables.push(workspaceClients);

      const clientB = workspaceClients.forRepo(identityB.repoId);
      expect(clientB).toBeDefined();
      expect(clientB?.state().status).toBe("connected");
      daemonPids.push(await probeDaemonPid(daemonSocketPath(dataRoot, identityB.repoId)));

      const clientA = workspaceClients.forRepo(identityA.repoId);
      if (clientA) expect(clientA.state().status).toBe("unreachable");
    } finally {
      fakeA.close();
    }
  }, 30_000);
});

describe("socket 残留文件", () => {
  test("socket 路径被普通文件占据时 connectDaemon 仍视为残留并拉起新实例", async () => {
    const fixture = await createDaemonFixture();
    fixtures.push(fixture);
    await mkdir(dirname(fixture.socketPath), { recursive: true });
    await writeFile(fixture.socketPath, "不是 socket 文件");

    const client = await connectDaemon({
      repoDir: fixture.repoDir,
      dataRoot: fixture.dataRoot,
      sdkDir: resolveSdkDir(),
      execPath: resolveNodeExecutable(),
      hello: {
        windowId: "window-enotsock",
        pid: process.pid,
        sessionId: "session-enotsock",
        cwd: fixture.repo.root,
        workspaceRoot: fixture.repo.root,
      },
    });
    closables.push(client);
    expect(client.state().status).toBe("connected");
    daemonPids.push(await probeDaemonPid(fixture.socketPath));
  }, 20_000);
});

describe("env 透传", () => {
  test("connectDaemon 的 env 选项透传给守护进程，PI_COMPANY_IDLE_TIMEOUT_MS 生效后空闲自动退出", async () => {
    const fixture = await createDaemonFixture();
    fixtures.push(fixture);

    const client = await connectDaemon({
      repoDir: fixture.repoDir,
      dataRoot: fixture.dataRoot,
      sdkDir: resolveSdkDir(),
      execPath: resolveNodeExecutable(),
      env: { PI_COMPANY_IDLE_TIMEOUT_MS: "1000" },
      hello: {
        windowId: "window-idle",
        pid: process.pid,
        sessionId: "session-idle",
        cwd: fixture.repo.root,
        workspaceRoot: fixture.repo.root,
      },
    });
    closables.push(client);
    expect(client.state().status).toBe("connected");
    client.close();

    await delay(3_500);
    expect(daemonPidsForDataRoot(fixture.dataRoot)).toHaveLength(0);
  }, 20_000);
});

describe("重连事件恢复", () => {
  test("断线后自动重连成功的新连接上，既有监听器仍能收到事件", async () => {
    const repo = await createRepoFixture();
    repoFixtures.push(repo);
    const dataRoot = await mkdtemp(join(temporaryRoot(), "d"));
    extraTempDirs.push(dataRoot);
    const identity = await repositoryIdentity(repo.root);
    const socketPath = daemonSocketPath(dataRoot, identity.repoId);
    await mkdir(dirname(socketPath), { recursive: true });

    let connectionIndex = 0;
    const fake = createFakeDaemonServer(socketPath, (frame, socket) => {
      connectionIndex += 1;
      socket.write(
        encodeFrame(
          createResponse(frame.id, {
            daemonPid: process.pid,
            repoId: identity.repoId,
            protocolVersion: PROTOCOL_VERSION,
            startedAt: new Date().toISOString(),
          }),
        ),
      );
      if (connectionIndex === 1) {
        setTimeout(() => socket.destroy(), 200);
      } else {
        setTimeout(() => socket.write(encodeFrame(createEvent("runs.changed", { note: "after-reconnect" }))), 200);
      }
    });

    try {
      const client = await connectDaemon({
        repoDir: repo.root,
        dataRoot,
        sdkDir: resolveSdkDir(),
        execPath: resolveNodeExecutable(),
        hello: {
          windowId: "window-resub",
          pid: process.pid,
          sessionId: "session-resub",
          cwd: repo.root,
          workspaceRoot: repo.root,
        },
      });
      closables.push(client);
      await waitUntil(() => client.state().status === "connected", 5_000);

      const received: unknown[] = [];
      client.subscribe("runs.changed", (data) => received.push(data));

      await waitUntil(() => client.state().status === "unreachable", 5_000);
      await waitUntil(() => client.state().status === "connected", 5_000);
      await waitUntil(() => received.length > 0, 5_000);
      expect(received).toHaveLength(1);
    } finally {
      fake.close();
    }
  }, 20_000);
});

describe("窗口退出不影响守护进程存活", () => {
  test("拉起守护进程的窗口进程退出后，守护进程在写入诊断 stderr 期间仍存活并可被新窗口连接", async () => {
    const fixture = await createDaemonFixture();
    fixtures.push(fixture);

    const childOptions = {
      repoDir: fixture.repoDir,
      dataRoot: fixture.dataRoot,
      sdkDir: resolveSdkDir(),
      execPath: resolveNodeExecutable(),
      env: { PI_COMPANY_IDLE_TIMEOUT_MS: "500" },
      hello: {
        windowId: "window-exiting",
        pid: process.pid,
        sessionId: "session-exiting",
        cwd: fixture.repo.root,
        workspaceRoot: fixture.repo.root,
      },
    };
    const childRun = await runChildProcess(spawnAndExitDaemonScript, [JSON.stringify(childOptions)]);
    expect(childRun.code).toBe(0);

    const pidBefore = await probeDaemonPid(fixture.socketPath);

    const corrupt = { database: repositoryDatabase(fixture.dataRoot, fixture.repoId), namespace: "runs", key: "corrupt-run" };
    putRecord(corrupt, {});
    await delay(2_000);

    const pidDuringFailure = await probeDaemonPid(fixture.socketPath);
    expect(pidDuringFailure).toBe(pidBefore);
    const logDir = join(fixture.dataRoot, "repos", fixture.repoId, "logs");
    const logs = await Promise.all((await readdir(logDir)).map((file) => readFile(join(logDir, file), "utf8")));
    expect(logs.join("\n")).toContain("读取运行记录失败");

    const client = await connectDaemon({
      repoDir: fixture.repoDir,
      dataRoot: fixture.dataRoot,
      sdkDir: resolveSdkDir(),
      execPath: resolveNodeExecutable(),
      hello: {
        windowId: "window-new",
        pid: process.pid,
        sessionId: "session-new",
        cwd: fixture.repo.root,
        workspaceRoot: fixture.repo.root,
      },
    });
    closables.push(client);
    expect(client.state().status).toBe("connected");
    await expect(client.call("ping", {})).resolves.toBeDefined();

    deleteRecord(corrupt);

    const pidAfter = await probeDaemonPid(fixture.socketPath);
    expect(pidAfter).toBe(pidBefore);
    daemonPids.push(pidBefore);
  }, 30_000);
});

describe("spawn 后 hello 失败不得杀掉刚拉起的守护进程", () => {
  test("hello 阶段被拒绝时，刚成为唯一实例的守护进程仍存活，随后可用正确参数连上同一实例", async () => {
    const fixture = await createDaemonFixture();
    fixtures.push(fixture);

    await expect(
      connectDaemon({
        repoDir: fixture.repoDir,
        dataRoot: fixture.dataRoot,
        sdkDir: resolveSdkDir(),
        execPath: fakeDaemonShimPath,
        hello: {
          windowId: "window-hello-reject",
          pid: process.pid,
          sessionId: "session-hello-reject",
          cwd: fixture.repo.root,
          workspaceRoot: fixture.repo.root,
        },
      }),
    ).rejects.toThrow();

    const pidsRightAfterReject = daemonPidsForDataRoot(fixture.dataRoot);
    expect(pidsRightAfterReject).toHaveLength(1);
    const shimPid = pidsRightAfterReject[0] as number;

    await delay(2_000);
    expect(daemonPidsForDataRoot(fixture.dataRoot)).toEqual([shimPid]);

    const client = await connectDaemon({
      repoDir: fixture.repoDir,
      dataRoot: fixture.dataRoot,
      sdkDir: resolveSdkDir(),
      execPath: fakeDaemonShimPath,
      hello: {
        windowId: "window-hello-retry",
        pid: process.pid,
        sessionId: "session-hello-retry",
        cwd: fixture.repo.root,
        workspaceRoot: fixture.repo.root,
      },
    });
    closables.push(client);
    expect(client.state().status).toBe("connected");

    const pidViaRetry = await probeDaemonPid(fixture.socketPath);
    expect(pidViaRetry).toBe(shimPid);
    daemonPids.push(shimPid);
  }, 20_000);
});

describe("工作区内单仓库首连失败自愈", () => {
  interface ControllableFakeServer {
    succeed: () => void;
    pushEvent: () => void;
    connectionCount: () => number;
    close: () => void;
  }

  function createControllableFakeServer(socketPath: string, repoId: string): ControllableFakeServer {
    let shouldFail = true;
    let connectionCount = 0;
    let pushEvent: (() => void) | undefined;
    const server = createServer((socket: Socket) => {
      connectionCount += 1;
      let buffer = "";
      socket.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        const { frames, rest } = decodeFrames(buffer);
        buffer = rest;
        for (const frame of frames) {
          if (frame.t !== "req") continue;
          if (frame.method !== "hello") {
            socket.write(encodeFrame(createResponse(frame.id, {})));
            continue;
          }
          if (shouldFail) {
            socket.write(encodeFrame(createErrorResponse(frame.id, "protocol_version", "协议版本不一致（测试注入）")));
            socket.end();
          } else {
            socket.write(
              encodeFrame(
                createResponse(frame.id, {
                  daemonPid: process.pid,
                  repoId,
                  protocolVersion: PROTOCOL_VERSION,
                  startedAt: new Date().toISOString(),
                }),
              ),
            );
            pushEvent = () => socket.write(encodeFrame(createEvent("runs.changed", { note: "workspace-repair" })));
          }
        }
      });
    });
    server.listen(socketPath);
    return {
      succeed: () => {
        shouldFail = false;
      },
      pushEvent: () => pushEvent?.(),
      connectionCount: () => connectionCount,
      close: () => server.close(),
    };
  }

  test("工作区内某仓库首连失败后自动重连恢复，既有监听器仍能收到事件，close 后不再重连", async () => {
    const workspace = await createWorkspaceFixture();
    repoFixtures.push(workspace);

    const dataRoot = await mkdtemp(join(temporaryRoot(), "d"));
    extraTempDirs.push(dataRoot);

    const [repoADir, repoBDir] = workspace.repos;
    const identityA = await repositoryIdentity(repoADir as string);
    const identityB = await repositoryIdentity(repoBDir as string);
    const socketPathB = daemonSocketPath(dataRoot, identityB.repoId);
    await mkdir(dirname(socketPathB), { recursive: true });

    const fakeB = createControllableFakeServer(socketPathB, identityB.repoId);

    try {
      const workspaceClients = await WorkspaceClients.create({
        workspaceRoot: workspace.root,
        dataRoot,
        sdkDir: resolveSdkDir(),
        execPath: resolveNodeExecutable(),
        env: { PI_COMPANY_IDLE_TIMEOUT_MS: "1000" },
        hello: {
          windowId: "window-workspace-repair",
          pid: process.pid,
          sessionId: "session-workspace-repair",
          cwd: workspace.root,
          workspaceRoot: workspace.root,
        },
      });
      closables.push(workspaceClients);
      daemonPids.push(await probeDaemonPid(daemonSocketPath(dataRoot, identityA.repoId)));

      const clientB = workspaceClients.forRepo(identityB.repoId);
      expect(clientB).toBeDefined();
      expect(clientB?.state().status).toBe("unreachable");
      expect(clientB?.state().reason).toBeDefined();
      await expect(clientB?.call("ping", {})).rejects.toThrow(/不可达/);

      const received: unknown[] = [];
      const cancelSubscription = clientB?.subscribe("runs.changed", (data) => received.push(data));

      fakeB.succeed();

      await waitUntil(() => clientB?.state().status === "connected", 20_000);
      await expect(clientB?.call("ping", {})).resolves.toBeDefined();

      fakeB.pushEvent();
      await waitUntil(() => received.length > 0, 3_000);
      expect(received).toHaveLength(1);
      expect(typeof cancelSubscription).toBe("function");

      const connectionsBeforeClose = fakeB.connectionCount();
      workspaceClients.closeAll();
      await delay(3_000);

      expect(fakeB.connectionCount()).toBe(connectionsBeforeClose);
      expect(daemonPidsForDataRoot(dataRoot)).toHaveLength(0);
    } finally {
      fakeB.close();
    }
  }, 40_000);
});

describe("睡眠感知重连（连接正常时不误判）", () => {
  test("连接正常时注入 5 分钟睡眠间隔不造成失联误判", async () => {
    const fixture = await createDaemonFixture();
    fixtures.push(fixture);

    const offset = { value: 0 };
    const timeSource: TimeSource = {
      now: () => Date.now() + offset.value,
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    };
    const clock = createClock({ timeSource });

    const client = await connectDaemon({
      repoDir: fixture.repoDir,
      dataRoot: fixture.dataRoot,
      sdkDir: resolveSdkDir(),
      execPath: resolveNodeExecutable(),
      clock,
      hello: {
        windowId: "window-sleep-connected",
        pid: process.pid,
        sessionId: "session-sleep-connected",
        cwd: fixture.repo.root,
        workspaceRoot: fixture.repo.root,
      },
    });
    closables.push(client);
    await waitUntil(() => client.state().status === "connected", 15_000);

    offset.value += 5 * 60 * 1000;
    const start = Date.now();
    while (Date.now() - start < 3_000) {
      expect(client.state().status).toBe("connected");
      await delay(200);
    }

    await expect(client.call("ping", {})).resolves.toBeDefined();
    daemonPids.push(await probeDaemonPid(fixture.socketPath));
  }, 20_000);
});
