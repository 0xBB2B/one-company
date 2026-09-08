import { createHash, randomBytes } from "node:crypto";
import { link, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { createConnection } from "node:net";
import { dirname, join } from "node:path";
import { createClock } from "../runtime/clock.ts";
import type { Clock, TimeSource } from "../runtime/clock.ts";
import { daemonSocketPath } from "../runtime/identity.ts";
import { createRequest, decodeFrames } from "../runtime/protocol.ts";
import { RunStore } from "../runtime/run-store.ts";
import type { RunState } from "../runtime/run-store.ts";
import { DaemonServer } from "./server.ts";

const PROBE_TIMEOUT_MS = 3_000;
const SOCKET_CHECK_INTERVAL_MS = 5_000;
const IDLE_CHECK_INTERVAL_MS = 200;
const MAX_LISTEN_RETRIES = 20;
const LISTEN_RETRY_DELAY_MS = 50;
const SIGNAL_WATCHDOG_MS = 5_000;
const STALE_TEMP_FILE_MAX_AGE_MS = 10 * 60 * 1000;
const RUN_CHECK_BASE_BACKOFF_MS = 200;
const RUN_CHECK_MAX_BACKOFF_MS = 5_000;
const SOCKET_PATH_BYTE_LIMIT: Record<string, number> = { darwin: 104, linux: 108 };
const ACTIVE_REQUIREMENT_STATES: RunState[] = [
  "queued",
  "running",
  "pausing",
  "paused",
  "paused_network",
  "waiting_answer",
];

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function socketPathByteLimit(platform: NodeJS.Platform = process.platform): number {
  return SOCKET_PATH_BYTE_LIMIT[platform] ?? 108;
}

export interface StartDaemonOptions {
  repoDir: string;
  dataRoot: string;
  idleTimeoutMs: number;
  clockSkewFile?: string;
}

type ProbeResult = "existing" | "stale" | "ambiguous";

export async function probeExistingInstance(socketPath: string): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const socket = createConnection(socketPath);
    let settled = false;
    let buffer = "";
    const finish = (result: ProbeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => finish("ambiguous"), PROBE_TIMEOUT_MS);
    socket.once("error", (error: NodeJS.ErrnoException) => {
      // ECONNREFUSED（崩溃遗留的真实 socket）与 ENOTSOCK（占位普通文件）都能确认无人监听
      finish(error.code === "ECONNREFUSED" || error.code === "ENOTSOCK" ? "stale" : "ambiguous");
    });
    socket.once("connect", () => {
      const request = createRequest("ping", {});
      socket.write(`${JSON.stringify(request)}\n`);
      socket.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        const { frames, rest } = decodeFrames(buffer);
        buffer = rest;
        for (const frame of frames) {
          if (frame.t === "res" && frame.id === request.id) finish(frame.ok ? "existing" : "ambiguous");
        }
      });
    });
  });
}

function tempSocketPath(socketPath: string): string {
  return join(dirname(socketPath), `${randomBytes(8).toString("hex")}.tmp`);
}

async function sweepStaleTempFiles(sockDir: string): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(sockDir);
  } catch {
    return;
  }
  const now = Date.now();
  for (const name of entries) {
    if (!name.endsWith(".tmp")) continue;
    const path = join(sockDir, name);
    try {
      const info = await stat(path);
      if (now - info.mtimeMs > STALE_TEMP_FILE_MAX_AGE_MS) await rm(path, { force: true });
    } catch {
      // 文件已被并发清理或不可读，忽略
    }
  }
}

export async function listenExclusive(
  server: DaemonServer,
  socketPath: string,
): Promise<{ inode: number } | "existing" | "retry"> {
  const tempPath = tempSocketPath(socketPath);
  await server.listen(tempPath);
  try {
    await link(tempPath, socketPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      await server.close();
      await rm(tempPath, { force: true }).catch(() => {});
      throw error;
    }
    const probe = await probeExistingInstance(socketPath);
    await server.close();
    await rm(tempPath, { force: true }).catch(() => {});
    if (probe === "existing") return "existing";
    if (probe === "stale") await rm(socketPath, { force: true }).catch(() => {});
    return "retry";
  }
  try {
    const info = await stat(socketPath);
    await rm(tempPath, { force: true }).catch(() => {});
    return { inode: info.ino };
  } catch {
    await server.close();
    await rm(tempPath, { force: true }).catch(() => {});
    return "retry";
  }
}

async function acquireListener(server: DaemonServer, socketPath: string): Promise<{ inode: number } | "existing"> {
  const sockDir = dirname(socketPath);
  await mkdir(sockDir, { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < MAX_LISTEN_RETRIES; attempt += 1) {
    const result = await listenExclusive(server, socketPath);
    if (result === "retry") {
      await delay(LISTEN_RETRY_DELAY_MS);
      continue;
    }
    if (result !== "existing") await sweepStaleTempFiles(sockDir);
    return result;
  }
  throw new Error(`无法获得 socket 监听权: ${socketPath}`);
}

export async function checkSocketOwnership(socketPath: string, ourInode: number): Promise<boolean> {
  try {
    const info = await stat(socketPath);
    return info.ino === ourInode;
  } catch {
    return false;
  }
}

export async function releaseSocket(socketPath: string, ourInode: number): Promise<void> {
  try {
    const info = await stat(socketPath);
    if (info.ino === ourInode) await rm(socketPath, { force: true });
  } catch {
    // socket 文件已不存在
  }
}

async function applyPendingClockSkew(
  clockSkewFile: string | undefined,
  clock: Clock,
  offsetState: { value: number },
): Promise<void> {
  if (!clockSkewFile) return;
  let raw: string;
  try {
    raw = await readFile(clockSkewFile, "utf8");
  } catch {
    return;
  }
  const skewMs = Number(raw.trim());
  if (!Number.isFinite(skewMs) || skewMs <= 0) return;
  const before = clock.now();
  offsetState.value += skewMs;
  clock.detectSleepGap(before, clock.now());
  await rm(clockSkewFile, { force: true }).catch(() => {});
}

// 连续读失败按指数退避拉长重试间隔（读健康时每次都真查），只在失败/恢复翻转时各写一次 stderr
class RunActivityChecker {
  private readonly clock: Clock;
  private readonly runStore: RunStore;
  private consecutiveFailures = 0;
  private backoffMs = RUN_CHECK_BASE_BACKOFF_MS;
  private nextAttemptAt = 0;
  private lastResult = true;

  constructor(options: { clock: Clock; runStore: RunStore }) {
    this.clock = options.clock;
    this.runStore = options.runStore;
  }

  async hasActiveRuns(): Promise<boolean> {
    if (this.consecutiveFailures > 0 && this.clock.now() < this.nextAttemptAt) {
      return this.lastResult;
    }
    try {
      const result = await this.runStore.list({ kind: "requirement", states: ACTIVE_REQUIREMENT_STATES, limit: 1 });
      if (this.consecutiveFailures > 0) process.stderr.write("运行记录读取已恢复正常\n");
      this.consecutiveFailures = 0;
      this.backoffMs = RUN_CHECK_BASE_BACKOFF_MS;
      this.lastResult = result.total > 0;
      return this.lastResult;
    } catch (error) {
      this.consecutiveFailures += 1;
      if (this.consecutiveFailures === 1) {
        process.stderr.write(`读取运行记录失败，按存在活动运行保守处理: ${(error as Error).message}\n`);
      }
      this.nextAttemptAt = this.clock.now() + this.backoffMs;
      this.backoffMs = Math.min(this.backoffMs * 2, RUN_CHECK_MAX_BACKOFF_MS);
      this.lastResult = true;
      return this.lastResult;
    }
  }
}

export class IdleExit {
  private readonly clock: Clock;
  private readonly timeoutMs: number;
  private readonly hasConnections: () => boolean;
  private readonly hasActiveRuns: () => Promise<boolean>;
  private lastActivity: number;

  constructor(options: {
    clock: Clock;
    timeoutMs: number;
    hasConnections: () => boolean;
    hasActiveRuns: () => Promise<boolean>;
  }) {
    this.clock = options.clock;
    this.timeoutMs = options.timeoutMs;
    this.hasConnections = options.hasConnections;
    this.hasActiveRuns = options.hasActiveRuns;
    this.lastActivity = options.clock.now();
  }

  touch(): void {
    this.lastActivity = this.clock.now();
  }

  async check(): Promise<boolean> {
    if (this.hasConnections()) return false;
    if (this.clock.elapsedExcludingSleep(this.lastActivity) < this.timeoutMs) return false;
    return !(await this.hasActiveRuns());
  }
}

export function installSignalHandlers(onSignal: () => Promise<void> | void): void {
  let signalled = false;
  const handle = () => {
    if (signalled) {
      process.exit(1);
      return;
    }
    signalled = true;
    setTimeout(() => process.exit(1), SIGNAL_WATCHDOG_MS);
    Promise.resolve(onSignal()).catch((error: unknown) => {
      process.stderr.write(`信号处理失败: ${error instanceof Error ? error.message : String(error)}\n`);
    });
  };
  for (const signal of ["SIGTERM", "SIGHUP", "SIGINT"] as const) {
    process.on(signal, handle);
  }
}

export async function startDaemon(options: StartDaemonOptions): Promise<void> {
  const repoId = createHash("sha256").update(options.repoDir).digest("hex");
  const socketPath = daemonSocketPath(options.dataRoot, repoId);

  const limit = socketPathByteLimit();
  const socketPathLength = Buffer.byteLength(socketPath, "utf8");
  if (socketPathLength > limit) {
    throw new Error(`socket 路径超限（${socketPathLength} 字节 > 平台上限 ${limit} 字节）: ${socketPath}`);
  }

  const offsetState = { value: 0 };
  const timeSource: TimeSource = {
    now: () => Date.now() + offsetState.value,
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    unref: (handle) => {
      (handle as ReturnType<typeof setTimeout>).unref?.();
    },
  };
  const clock = createClock({ timeSource });

  const startedAt = new Date().toISOString();
  const runStore = new RunStore({ dataRoot: options.dataRoot, repoId, daemonStartedAt: startedAt });
  const runActivity = new RunActivityChecker({ clock, runStore });

  let idleExit: IdleExit | undefined;
  let ready = false;
  const server = new DaemonServer({
    repoId,
    startedAt,
    onActivity: () => idleExit?.touch(),
    hasActiveRuns: () => runActivity.hasActiveRuns(),
    isReady: () => ready,
    onShutdownRequested: () => {
      shutdown().catch((error: unknown) => {
        process.stderr.write(`关闭失败: ${error instanceof Error ? error.message : String(error)}\n`);
      });
    },
  });

  const acquired = await acquireListener(server, socketPath);
  if (acquired === "existing") return;
  const ownership = acquired;

  await runStore.markInterruptedOnStartup();

  idleExit = new IdleExit({
    clock,
    timeoutMs: options.idleTimeoutMs,
    hasConnections: () => server.clients().length > 0,
    hasActiveRuns: () => runActivity.hasActiveRuns(),
  });

  let shuttingDown = false;
  async function shutdown(): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    clock.clearTimer(idleTimer);
    clock.clearTimer(ownershipTimer);
    clock.stopGapWatcher();

    try {
      await runStore.markOwnRunsInterrupted();
    } catch (error) {
      process.stderr.write(`标记自身运行为 interrupted 失败: ${(error as Error).message}\n`);
    }

    if (await checkSocketOwnership(socketPath, ownership.inode)) {
      await server.close();
      await releaseSocket(socketPath, ownership.inode);
    }
    process.exit(0);
  }

  const idleTimer = clock.setIntervalExcludingSleep(() => {
    (async () => {
      await applyPendingClockSkew(options.clockSkewFile, clock, offsetState);
      if (idleExit && (await idleExit.check())) await shutdown();
    })().catch((error: unknown) => {
      process.stderr.write(`空闲检查失败: ${error instanceof Error ? error.message : String(error)}\n`);
    });
  }, IDLE_CHECK_INTERVAL_MS);

  const ownershipTimer = clock.setIntervalExcludingSleep(() => {
    (async () => {
      const stillOwned = await checkSocketOwnership(socketPath, ownership.inode);
      if (!stillOwned) await shutdown();
    })().catch((error: unknown) => {
      process.stderr.write(`socket 归属检查失败: ${error instanceof Error ? error.message : String(error)}\n`);
    });
  }, SOCKET_CHECK_INTERVAL_MS);

  installSignalHandlers(() => shutdown());
  ready = true;
}
