import { controlToken } from "../runtime/daemon-auth.ts";
import { databaseFile } from "../runtime/database.ts";
import { createHash, randomBytes } from "node:crypto";
import { link, mkdir, readFile, readdir, realpath, rm, stat } from "node:fs/promises";
import { createConnection } from "node:net";
import { dirname, join } from "node:path";
import { ModelRuntime, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { createClock } from "../runtime/clock.ts";
import type { Clock, TimeSource, TimerHandle } from "../runtime/clock.ts";
import { daemonSocketPath, listWorktrees, repoDataDir, repositoryIdentity } from "../runtime/identity.ts";
import { readGit } from "../runtime/git-read.ts";
import { ProjectSyncGrantVerifier } from "../runtime/project-sync-grants.ts";
import { ProjectIndexCoordinator } from "./project-index-coordinator.ts";
import { ProjectIndexRequirements } from "./project-index-requirements.ts";
import { ConnectivityProbe, NetworkPauseGate, toValidHostUrl } from "../runtime/network-pause.ts";
import { createRequest, decodeFrames } from "../runtime/protocol.ts";
import { defaultRoleDir, loadRoleCatalog, projectRoleDir, userRoleDir } from "../runtime/roles.ts";
import { RunStore } from "../runtime/run-store.ts";
import type { RunState } from "../runtime/run-store.ts";
import { ShellRegistry } from "../runtime/shell-registry.ts";
import { RelayQueue } from "./relay-queue.ts";
import { registerProtocolHandlers, RunManager } from "./run-manager.ts";
import type { ModelSelector, SelectedModel } from "./run-manager.ts";
import { DaemonServer } from "./server.ts";

function loadDaemonRoleCatalog(agentDir: string, repoRoot: string) {
  return loadRoleCatalog({
    defaultDir: defaultRoleDir(),
    userDir: userRoleDir(agentDir),
    projectDir: projectRoleDir(repoRoot),
    parseFrontmatter,
    projectTrusted: false,
  });
}

function defaultSelectModel(runtime: ModelRuntime): ModelSelector {
  return () => {
    const models = runtime.getModels();
    if (models.length === 0) throw new Error("没有可用模型：未配置任何模型提供方");
    const first = models[0] as SelectedModel;
    return { provider: first.provider, id: first.id };
  };
}

async function setupModelRuntime(modulePath: string | undefined): Promise<{ runtime: ModelRuntime; selectModel: ModelSelector }> {
  const runtime = await ModelRuntime.create({ refreshOnCreate: false });
  if (!modulePath) return { runtime, selectModel: defaultSelectModel(runtime) };

  const providerModule = (await import(modulePath)) as {
    registerProviders: (runtime: ModelRuntime) => Promise<void>;
    selectModel?: ModelSelector;
  };
  await providerModule.registerProviders(runtime);
  return { runtime, selectModel: providerModule.selectModel ?? defaultSelectModel(runtime) };
}

const DEFAULT_NETWORK_PROBE_INTERVAL_MS = 30_000;
const NETWORK_PROBE_TIMEOUT_MS = 3_000;

// 探测按已校验合法的 provider baseUrl 发起，不绑死任何具体厂商域名；
// 测试经 modulePath 注入自己的探测模块时完全绕过生产 fetch 路径
async function buildConnectivityProbeFn(modulePath: string | undefined): Promise<(baseUrl: string) => Promise<boolean | null>> {
  if (modulePath) {
    const probeModule = (await import(modulePath)) as { probe: (baseUrl?: string) => Promise<boolean | null> };
    return (baseUrl: string) => probeModule.probe(baseUrl);
  }
  return async (baseUrl: string) => {
    try {
      await fetch(baseUrl, { signal: AbortSignal.timeout(NETWORK_PROBE_TIMEOUT_MS) });
      return true;
    } catch {
      return false;
    }
  };
}

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
  modelProviderModulePath?: string;
  connectivityProbeModulePath?: string;
  networkProbeIntervalMs?: number;
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
  let listenerIdentity;
  try {
    listenerIdentity = await stat(tempPath);
  } catch (error) {
    try { await server.close(); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], "无法确认自有 listener 身份及关闭失败"); }
    throw error;
  }
  try {
    await link(tempPath, socketPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      return failAfterOwnedListener(server, tempPath, listenerIdentity.ino, error);
    }
    // 探测期间其他进程可能替换旧 socket；只回收本次实际探测的同一文件。
    const observed = await stat(socketPath).catch(() => undefined);
    const probe = await probeExistingInstance(socketPath);
    await closeOwnedListener(server, tempPath, listenerIdentity.ino);
    if (probe === "existing") return "existing";
    if (probe === "stale" && observed) await releaseSocket(socketPath, observed.ino);
    return "retry";
  }
  let linkedIdentity;
  try { linkedIdentity = await stat(socketPath); }
  catch (error) {
    try { await closeOwnedListener(server, tempPath, listenerIdentity.ino); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], "listener 归属检查及清理失败"); }
    return "retry";
  }
  if (linkedIdentity.dev !== listenerIdentity.dev || linkedIdentity.ino !== listenerIdentity.ino) {
    await closeOwnedListener(server, tempPath, listenerIdentity.ino);
    return "retry";
  }
  try { await releaseSocket(tempPath, listenerIdentity.ino); }
  catch (error) { return failAfterOwnedListener(server, tempPath, listenerIdentity.ino, error); }
  return { inode: listenerIdentity.ino };
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
  let info;
  try {
    info = await stat(socketPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (info.ino === ourInode) await rm(socketPath, { force: true });
}

export async function closeOwnedListener(
  server: Pick<DaemonServer, "close">,
  socketPath: string,
  ourInode: number,
): Promise<void> {
  const errors: unknown[] = [];
  try {
    await server.close();
  } catch (error) {
    errors.push(error);
  }
  try {
    await releaseSocket(socketPath, ourInode);
  } catch (error) {
    errors.push(error);
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "关闭自有 listener 失败");
}

export async function failAfterOwnedListener(
  server: Pick<DaemonServer, "close">,
  socketPath: string,
  ourInode: number,
  primaryError: unknown,
): Promise<never> {
  try {
    await closeOwnedListener(server, socketPath, ourInode);
  } catch (cleanupError) {
    throw new AggregateError([primaryError, cleanupError], "daemon 启动检查及自有 listener 清理失败");
  }
  throw primaryError;
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

export function installSignalHandlers(
  onSignal: () => Promise<void> | void,
  options?: { onFatalException?: () => Promise<void> | void; forceCleanup?: () => Promise<void> },
): void {
  let signalled = false;
  const run = (task: () => Promise<void> | void) => {
    if (signalled) {
      process.exit(1);
      return;
    }
    signalled = true;
    // 装配期异常可能发生在 shutdown() 依赖的对象都就绪之前，导致其自身的收尾逻辑挂住；
    // 看门狗独立于 onSignal/onFatalException 的执行结果，到点强制退出前尽力清理 socket
    setTimeout(() => {
      Promise.resolve(options?.forceCleanup?.())
        .catch(() => {})
        .finally(() => process.exit(1));
    }, SIGNAL_WATCHDOG_MS);
    Promise.resolve(task()).catch((error: unknown) => {
      process.stderr.write(`收尾处理失败: ${error instanceof Error ? error.message : String(error)}\n`);
    });
  };
  for (const signal of ["SIGTERM", "SIGHUP", "SIGINT"] as const) {
    process.on(signal, () => run(onSignal));
  }
  process.on("uncaughtException", (error) => {
    process.stderr.write(`未捕获异常: ${error.message}\n`);
    run(options?.onFatalException ?? onSignal);
  });
}

async function verifiedRepositoryRoot(commonDir: string, repoId: string): Promise<string> {
  const identity = await repositoryIdentity(commonDir);
  if (identity.commonDir !== commonDir || identity.repoId !== repoId) throw new Error("daemon 仓库公共目录身份不一致");
  // Git登记顺序中的首个非裸工作区是主工作区；不根据.git父目录猜测业务根目录。
  const registered = await listWorktrees(commonDir);
  const primary = registered[0];
  if (!primary) throw new Error("daemon 仓库没有可核对的主工作区");
  const root = await realpath(primary);
  const top = await realpath((await readGit(root, ["rev-parse", "--show-toplevel"])).stdout.trim());
  const actual = await repositoryIdentity(root);
  if (top !== root || actual.repoId !== repoId || actual.commonDir !== commonDir) {
    throw new Error("daemon 主工作区与仓库公共目录身份不一致");
  }
  return root;
}

export async function startDaemon(options: StartDaemonOptions): Promise<void> {
  const capturedOptions = { ...options };
  const repoId = createHash("sha256").update(capturedOptions.repoDir).digest("hex");
  const socketPath = daemonSocketPath(capturedOptions.dataRoot, repoId);

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
  const runStore = new RunStore({ dataRoot: capturedOptions.dataRoot, repoId, daemonStartedAt: startedAt });
  const runActivity = new RunActivityChecker({ clock, runStore });

  let idleExit: IdleExit | undefined;
  let ready = false;
  const server = new DaemonServer({
    authToken: controlToken(capturedOptions.dataRoot),
    repoId,
    startedAt,
    onActivity: () => idleExit?.touch(),
    // 显式 shutdown 是不可逆操作，读不到运行记录时无法确认真的没有活动运行，宁可拒绝也不能误关；
    // 与自动空闲退出的保守判定（runActivity）各自独立，这里把读失败原因直接带回给调用方
    hasActiveRuns: async () => {
      try {
        const result = await runStore.list({ kind: "requirement", states: ACTIVE_REQUIREMENT_STATES, limit: 1 });
        return { active: result.total > 0 };
      } catch (error) {
        return { active: true, reason: `读取运行记录失败，拒绝显式 shutdown: ${(error as Error).message}` };
      }
    },
    isReady: () => ready,
    onShutdownRequested: () => {
      shutdown().catch((error: unknown) => {
        process.stderr.write(`关闭失败: ${error instanceof Error ? error.message : String(error)}\n`);
      });
    },
  });

  // acquireListener 必须在任何耗时的异步装配之前调用：并发拉起时输家要能尽快从 socket
  // 竞争中出局退出，不能被 ModelRuntime/角色目录等重活拖住，否则单实例收敛会变慢变得不可靠
  const acquired = await acquireListener(server, socketPath);
  if (acquired === "existing") return;
  const ownership = acquired;

  // 信号处理必须在赢得 socket 归属后立刻装好：hello 不等 ready 就能响应，若信号处理还没
  // 装上就收到 SIGTERM，进程会被系统默认行为直接终止而不会走到下面的优雅关闭与状态标记
  let resolveInitialized!: () => void;
  const initializedPromise = new Promise<void>((resolve) => {
    resolveInitialized = resolve;
  });
  let shuttingDown = false;
  let startupFailed = false;
  let indexCoordinator: ProjectIndexCoordinator | undefined;
  let indexRequirements: ProjectIndexRequirements | undefined;
  let unsubscribeSleep: (() => void) | undefined;
  let runManager: RunManager | undefined;
  let networkProbe: ConnectivityProbe | undefined;
  let idleTimer: TimerHandle | undefined;
  let ownershipTimer: TimerHandle | undefined;
  async function shutdown(exitCode = 0): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    ready = false;
    unsubscribeSleep?.();
    // close同步拒绝新索引操作；装配或在途请求的清理随后必须确实完成。
    const stoppingIndex = indexCoordinator?.close().then(() => null, (error: unknown) => error);
    await initializedPromise;
    unsubscribeSleep?.();
    if (idleTimer) clock.clearTimer(idleTimer);
    if (ownershipTimer) clock.clearTimer(ownershipTimer);
    networkProbe?.stop();
    clock.stopGapWatcher();

    try {
      if (stoppingIndex) {
        const error = await stoppingIndex;
        if (error !== null) throw error;
      } else await indexCoordinator?.close();
    } catch (error) {
      exitCode = 1;
      process.stderr.write(`停止项目索引失败: ${error instanceof Error ? error.message : String(error)}\n`);
    }
    try {
      await indexRequirements?.close();
    } catch (error) {
      exitCode = 1;
      process.stderr.write(`关闭归档生命周期核对失败: ${error instanceof Error ? error.message : String(error)}\n`);
    }
    try {
      await runManager?.close();
    } catch (error) {
      exitCode = 1;
      process.stderr.write(`停止运行 Shell 失败: ${(error as Error).message}\n`);
    }
    try {
      await runStore.markOwnRunsInterrupted();
    } catch (error) {
      exitCode = 1;
      process.stderr.write(`标记自身运行为 interrupted 失败: ${(error as Error).message}\n`);
    }

    try {
      await closeOwnedListener(server, socketPath, ownership.inode);
    } catch (error) {
      exitCode = 1;
      process.stderr.write(`关闭 daemon listener 失败: ${error instanceof Error ? error.message : String(error)}\n`);
    }
    process.exit(startupFailed ? 1 : exitCode);
  }
  // 孤立的未处理拒绝不该拖垮已确认单实例的守护进程，只记录；未捕获异常已破坏当前调用栈的
  // 不变量，走与 SIGTERM 共用的看门狗收尾但以非零码退出，强退前尽力释放 socket 归属
  installSignalHandlers(() => shutdown(), {
    onFatalException: () => shutdown(1),
    forceCleanup: async () => {
      if (await checkSocketOwnership(socketPath, ownership.inode)) {
        await releaseSocket(socketPath, ownership.inode);
      }
    },
  });
  process.on("unhandledRejection", (reason) => {
    process.stderr.write(`未处理的 Promise 拒绝: ${reason instanceof Error ? reason.message : String(reason)}\n`);
  });
  // shutdown() 内部会先 await initializedPromise 再动手，所以 ready 可以早于重活配装完成前置位：
  // 一旦成为确认的单实例即可接受 shutdown 请求，不必等 ModelRuntime/角色目录等装配完
  try {
    ready = true;
    const agentDir = dirname(capturedOptions.dataRoot);
    const repositoryRoot = await verifiedRepositoryRoot(capturedOptions.repoDir, repoId);
    const [{ runtime, selectModel }, roleCatalogResult, repoDir] = await Promise.all([
      setupModelRuntime(capturedOptions.modelProviderModulePath),
      loadDaemonRoleCatalog(agentDir, repositoryRoot),
      repoDataDir(capturedOptions.dataRoot, repoId, capturedOptions.repoDir),
    ]);

    indexRequirements = new ProjectIndexRequirements({
      repositoryRoot, dataRoot: capturedOptions.dataRoot, repoId,
    });
    indexCoordinator = new ProjectIndexCoordinator({
      repoId, dataRoot: capturedOptions.dataRoot, commonDir: capturedOptions.repoDir, server,
      grants: new ProjectSyncGrantVerifier({
        dataRoot: capturedOptions.dataRoot, repoId, commonDir: capturedOptions.repoDir, daemonInstanceId: server.daemonInstanceId,
      }),
      beforeArchiveRisk: indexRequirements.beforeArchiveRisk,
    });
    if (shuttingDown) await indexCoordinator.close();
    else unsubscribeSleep = clock.onSleepGap(() => {
      indexCoordinator!.onSleepGap().catch((error: unknown) => {
        process.stderr.write(`休眠后项目索引对账失败: ${error instanceof Error ? error.message : String(error)}\n`);
      });
    });

    const shellRegistry = new ShellRegistry({
      clock,
      database: databaseFile(repoDir, "data"),
    });
    const networkGate = new NetworkPauseGate();
    const relayQueue = new RelayQueue({
      dataDir: repoDir,
      deliver: async (event, payload, deliverOptions) => {
        const targets = server
          .clients()
          .filter((info) => info.repoIds.includes(deliverOptions.repoId) && info.windowId !== deliverOptions.excludeWindowId);
        for (const target of targets) {
          server.broadcast(event, payload, (info) => info.windowId === target.windowId);
        }
        return targets.map((info) => info.windowId);
      },
      locateRequirementAgent: (requirement) => runManager!.locateRequirementAgent(requirement),
    });
    runManager = new RunManager({
      repositoryRoot,
      dataRoot: capturedOptions.dataRoot,
      repoId,
      runStore,
      shellRegistry,
      networkGate,
      relayQueue,
      roleCatalog: roleCatalogResult.roles,
      runtime,
      selectModel,
      clock,
      workspaceRepoIds: [repoId],
      emit: (event, data, filter) => server.broadcast(event, data, filter ? (info) => filter(info.windowId) : undefined),
    });
    registerProtocolHandlers({ server, manager: runManager, relayQueue, shellRegistry });

    const probeProvider = await buildConnectivityProbeFn(capturedOptions.connectivityProbeModulePath);
    // 每轮只探测当前确有 paused_network 运行挂着的 provider，且只续接探测到已恢复的那个 provider——
    // 无遗留暂停运行时完全不发起探测调用；baseUrl 未注册或校验不合法时跳过该 provider 本轮探测
    networkProbe = new ConnectivityProbe({
      clock,
      intervalMs: capturedOptions.networkProbeIntervalMs ?? DEFAULT_NETWORK_PROBE_INTERVAL_MS,
      probe: async () => {
        const paused = await runStore.list({ states: ["paused_network"], limit: Number.MAX_SAFE_INTEGER });
        const providerIds = new Set(paused.items.map((run) => run.model.provider));
        for (const providerId of providerIds) {
          const baseUrl = runtime.getProvider(providerId)?.baseUrl;
          const validUrl = baseUrl ? toValidHostUrl(baseUrl) : null;
          if (!validUrl) {
            process.stderr.write(`跳过非法探测目标: provider=${providerId} baseUrl=${baseUrl ?? "未注册"}\n`);
            continue;
          }
          if (await probeProvider(baseUrl!)) await runManager!.resumeNetworkPaused(providerId);
        }
      },
    });
    networkProbe.start();

    try {
      await runStore.markInterruptedOnStartup();
    } catch (error) {
      process.stderr.write(`标记启动前中断运行失败: ${(error as Error).message}\n`);
    }
    try {
      await runManager.adoptInterruptedShells();
    } catch (error) {
      process.stderr.write(`接管遗留 Shell 任务失败: ${(error as Error).message}\n`);
    }
    runManager.markStarted();

    idleExit = new IdleExit({
      clock,
      timeoutMs: capturedOptions.idleTimeoutMs,
      hasConnections: () => server.clients().length > 0,
      hasActiveRuns: () => runActivity.hasActiveRuns(),
    });

    idleTimer = clock.setIntervalExcludingSleep(() => {
      (async () => {
        await applyPendingClockSkew(capturedOptions.clockSkewFile, clock, offsetState);
        if (idleExit && (await idleExit.check())) await shutdown();
      })().catch((error: unknown) => {
        process.stderr.write(`空闲检查失败: ${error instanceof Error ? error.message : String(error)}\n`);
      });
    }, IDLE_CHECK_INTERVAL_MS);

    ownershipTimer = clock.setIntervalExcludingSleep(() => {
      (async () => {
        const stillOwned = await checkSocketOwnership(socketPath, ownership.inode);
        if (!stillOwned) await shutdown();
      })().catch((error: unknown) => {
        process.stderr.write(`socket 归属检查失败: ${error instanceof Error ? error.message : String(error)}\n`);
      });
    }, SOCKET_CHECK_INTERVAL_MS);
  } catch (error) {
    startupFailed = true;
    process.stderr.write(`daemon 装配失败: ${error instanceof Error ? error.message : String(error)}\n`);
    resolveInitialized();
    await shutdown(1);
  } finally {
    resolveInitialized();
  }
}
