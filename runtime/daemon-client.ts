import { controlToken } from "./daemon-auth.ts";
import { closeSync, openSync } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import type { Socket } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getPackageDir } from "@earendil-works/pi-coding-agent";
import { probeExistingInstance } from "../daemon/lifecycle.ts";
import { createClock } from "./clock.ts";
import { uuidv7 } from "./database.ts";
import type { Clock, TimerHandle } from "./clock.ts";
import { daemonSocketPath, discoverWorkspace, repoDataDir, repositoryIdentity } from "./identity.ts";
import type { RepositoryIdentity, Workspace, WorkspaceSkipped } from "./identity.ts";
import { createRequest, decodeFrames, encodeFrame, PROTOCOL_VERSION } from "./protocol.ts";

const moduleDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = dirname(moduleDir);
const daemonMainEntry = join(packageRoot, "daemon", "main.ts");

const RECONNECT_BASE_MS = 200;
const RECONNECT_MAX_MS = 5_000;
const RECONNECT_JITTER_RATIO = 0.25;
const SPAWN_READY_TIMEOUT_MS = 10_000;
const SPAWN_POLL_INTERVAL_MS = 100;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class DaemonCallError extends Error {
  readonly code: string;
  readonly data: Record<string, unknown> | undefined;

  constructor(code: string, message: string, data?: Record<string, unknown>) {
    super(message);
    this.name = "DaemonCallError";
    this.code = code;
    this.data = data;
  }
}

export function resolveSdkDir(): string {
  return getPackageDir();
}

export interface SpawnDaemonOptions {
  repoDir: string;
  dataRoot: string;
  sdkDir: string;
  execPath?: string;
  env?: Record<string, string>;
}

function buildDaemonEnv(params: {
  sdkDir: string;
  repoDir: string;
  dataRoot: string;
  env?: Record<string, string>;
}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...params.env,
    PI_COMPANY_SDK_DIR: params.sdkDir,
    PI_COMPANY_REPO_DIR: params.repoDir,
    PI_COMPANY_DATA_ROOT: params.dataRoot,
  };
}

async function readLogTail(path: string): Promise<string> {
  let file;
  try {
    file = await open(path, "r");
    const { size } = await file.stat();
    const length = Math.min(size, 4096);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await file.read(buffer, 0, length, size - length);
    return buffer.subarray(0, bytesRead).toString("utf8").trim();
  } catch (error) {
    return `日志读取失败: ${(error as Error).message}`;
  } finally { await file?.close(); }
}

interface SpawnedProcess {
  ready: Promise<void>;
}

async function beginSpawnDaemon(options: SpawnDaemonOptions, identity: RepositoryIdentity): Promise<SpawnedProcess> {
  const execPath = options.execPath ?? process.execPath;
  const repoDir = await repoDataDir(options.dataRoot, identity.repoId, identity.commonDir);
  const launchId = uuidv7();
  const logDir = join(repoDir, "logs");
  await mkdir(logDir, { recursive: true, mode: 0o700 });
  const logPath = join(logDir, `${launchId}.log`);
  const logFd = openSync(logPath, "ax", 0o600);
  let child: ReturnType<typeof spawn>;
  try {
    // 子进程持有日志文件描述符，派出窗口退出不会关闭其输出目标或触发 EPIPE。
    child = spawn(execPath, [daemonMainEntry], {
      stdio: ["ignore", logFd, logFd],
      detached: true,
      env: buildDaemonEnv({ sdkDir: options.sdkDir, repoDir: identity.commonDir, dataRoot: options.dataRoot, env: options.env }),
    });
  } finally { closeSync(logFd); }
  child.unref();

  let spawnError: Error | undefined;
  child.once("error", (error: Error) => {
    spawnError = error;
  });

  let exitResult: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  child.once("exit", (code, signal) => {
    exitResult = { code, signal };
  });

  const socketPath = daemonSocketPath(options.dataRoot, identity.repoId);
  const ready = (async () => {
    const start = Date.now();
    while (Date.now() - start < SPAWN_READY_TIMEOUT_MS) {
      if (spawnError) throw new Error(`拉起守护进程失败: ${spawnError.message}`);
      if (exitResult && exitResult.code !== 0) {
        const tail = await readLogTail(logPath);
        throw new Error(`守护进程启动即退出（code=${exitResult.code} signal=${exitResult.signal}）：${tail || "无 stderr 输出"}`);
      }
      const probe = await probeExistingInstance(socketPath);
      if (probe === "existing") return;
      await delay(SPAWN_POLL_INTERVAL_MS);
    }
    const tail = await readLogTail(logPath);
    throw new Error(`等待守护进程启动超时（${SPAWN_READY_TIMEOUT_MS}ms）：${tail || "无 stderr 输出"}`);
  })();

  return { ready };
}

export async function spawnDaemon(options: SpawnDaemonOptions): Promise<void> {
  const identity = await repositoryIdentity(options.repoDir);
  const { ready } = await beginSpawnDaemon(options, identity);
  await ready;
}

function rawConnect(socketPath: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    const onError = (error: Error) => {
      socket.removeListener("connect", onConnect);
      reject(error);
    };
    const onConnect = () => {
      socket.removeListener("error", onError);
      resolve(socket);
    };
    socket.once("error", onError);
    socket.once("connect", onConnect);
  });
}

interface ResolvedContext {
  socketPath: string;
  repoId: string;
  commonDir: string;
  dataRoot: string;
  sdkDir: string;
  execPath: string | undefined;
  env: Record<string, string> | undefined;
  clock: Clock;
  ownsClock: boolean;
  helloParams: Record<string, unknown>;
}

interface PendingCall {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
}

class SocketLink {
  readonly socket: Socket;
  private buffer: string;
  private readonly pending: Map<string, PendingCall>;
  private readonly onEvent: (event: string, data: Record<string, unknown>) => void;
  private readonly onClose: (reason: string) => void;
  private lastErrorMessage: string | undefined;

  constructor(
    socket: Socket,
    onEvent: (event: string, data: Record<string, unknown>) => void,
    onClose: (reason: string) => void,
  ) {
    this.socket = socket;
    this.buffer = "";
    this.pending = new Map();
    this.onEvent = onEvent;
    this.onClose = onClose;
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => this.handleData(chunk));
    socket.on("error", (error: Error) => {
      this.lastErrorMessage = error.message;
    });
    socket.once("close", () => this.handleClose());
  }

  private handleData(chunk: string): void {
    this.buffer += chunk;
    const { frames, rest } = decodeFrames(this.buffer);
    this.buffer = rest;
    for (const frame of frames) {
      if (frame.t === "res") {
        const waiter = this.pending.get(frame.id);
        if (!waiter) continue;
        this.pending.delete(frame.id);
        if (frame.ok) waiter.resolve(frame.result);
        else waiter.reject(new DaemonCallError(frame.error.code, frame.error.message, frame.error.data));
      } else if (frame.t === "evt") {
        this.onEvent(frame.event, frame.data);
      }
    }
  }

  private handleClose(): void {
    const reason = this.lastErrorMessage ?? "连接已关闭";
    for (const waiter of this.pending.values()) waiter.reject(new Error(`守护进程不可达: ${reason}`));
    this.pending.clear();
    this.onClose(reason);
  }

  call(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const request = createRequest(method, params);
    return new Promise((resolve, reject) => {
      this.pending.set(request.id, { resolve, reject });
      this.socket.write(encodeFrame(request));
    });
  }

  destroy(): void {
    for (const waiter of this.pending.values()) waiter.reject(new Error("守护进程不可达: 已关闭"));
    this.pending.clear();
    this.socket.removeAllListeners();
    this.socket.destroy();
  }
}

export interface DaemonClientState {
  status: "connected" | "starting" | "unreachable";
  reason?: string;
}

export interface DaemonClient {
  call(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
  subscribe(event: string, listener: (data: Record<string, unknown>) => void): () => void;
  state(): DaemonClientState;
  close(): void;
}

class DaemonClientImpl implements DaemonClient {
  private readonly ctx: ResolvedContext;
  private link: SocketLink | null;
  private status: "connected" | "starting" | "unreachable";
  private reason: string | undefined;
  private closed: boolean;
  private reconnectTimer: TimerHandle | null;
  private reconnectDelayMs: number;
  private readonly listeners: Map<string, Set<(data: Record<string, unknown>) => void>>;

  constructor(ctx: ResolvedContext) {
    this.ctx = ctx;
    this.link = null;
    this.status = "starting";
    this.reason = undefined;
    this.closed = false;
    this.reconnectTimer = null;
    this.reconnectDelayMs = RECONNECT_BASE_MS;
    this.listeners = new Map();
  }

  async connectInitial(): Promise<void> {
    try {
      const socket = await this.attemptConnect();
      await this.helloOn(socket);
    } catch (error) {
      this.close();
      throw error;
    }
  }

  // 首连失败时不 reject：调用方（工作区多仓库场景）需要一个即便当下不可达也能持有、
  // 订阅、并在后台自动重连恢复的客户端，而不是让一个仓库的失败拖垮整个工作区连接的建立
  async connectInitialOrDegrade(): Promise<void> {
    try {
      const socket = await this.attemptConnect();
      await this.helloOn(socket);
    } catch (error) {
      this.status = "unreachable";
      this.reason = (error as Error).message;
      this.scheduleReconnect();
    }
  }

  // ENOENT（socket 文件不存在）、ECONNREFUSED（崩溃遗留的旧 socket 文件）、ENOTSOCK（socket 路径被普通文件占据，
  // 生产 Node 运行时的实际错误码；同一场景在 Bun 下表现为 ENOENT）都意味着无人监听，此时才需要拉起新实例
  private async attemptConnect(): Promise<Socket> {
    try {
      return await rawConnect(this.ctx.socketPath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ECONNREFUSED" && code !== "ENOTSOCK") throw error;
      const identity: RepositoryIdentity = { repoId: this.ctx.repoId, commonDir: this.ctx.commonDir };
      const spawned = await beginSpawnDaemon(
        {
          repoDir: this.ctx.commonDir,
          dataRoot: this.ctx.dataRoot,
          sdkDir: this.ctx.sdkDir,
          execPath: this.ctx.execPath,
          env: this.ctx.env,
        },
        identity,
      );
      await spawned.ready;
      return rawConnect(this.ctx.socketPath);
    }
  }

  private async helloOn(socket: Socket): Promise<void> {
    const link = new SocketLink(
      socket,
      (event, data) => this.dispatchEvent(event, data),
      (reason) => this.handleDisconnect(reason),
    );
    this.link = link;
    let result: Record<string, unknown>;
    try {
      result = await link.call("hello", { ...this.ctx.helloParams, authToken: controlToken(this.ctx.dataRoot) });
    } catch (error) {
      // 失败的这次握手在关闭协商完成前不摘掉监听器，其 socket 稍后触发的 close 事件会调用
      // handleDisconnect 误伤此后可能已建立好的新连接；这里提前摘监听器切断这条迟到的回调路径
      link.destroy();
      if (this.link === link) this.link = null;
      throw error;
    }
    if (this.closed) {
      link.destroy();
      if (this.link === link) this.link = null;
      return;
    }
    if (result.repoId !== this.ctx.repoId) {
      link.destroy();
      if (this.link === link) this.link = null;
      throw new Error(`hello 响应 repoId 不一致: 期望 ${this.ctx.repoId}，实际 ${String(result.repoId)}`);
    }
    this.status = "connected";
    this.reason = undefined;
    this.reconnectDelayMs = RECONNECT_BASE_MS;
  }

  private dispatchEvent(event: string, data: Record<string, unknown>): void {
    for (const listener of this.listeners.get(event) ?? []) {
      try {
        listener(data);
      } catch {
        // 单个监听器抛错不应影响同一事件的其他监听器，也不应拆连接
      }
    }
  }

  private handleDisconnect(reason: string): void {
    if (this.closed) return;
    this.link = null;
    this.status = "unreachable";
    this.reason = reason;
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;
    const baseDelay = this.reconnectDelayMs;
    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, RECONNECT_MAX_MS);
    const jitter = baseDelay * RECONNECT_JITTER_RATIO * (Math.random() * 2 - 1);
    const delayMs = Math.max(0, Math.round(baseDelay + jitter));
    this.reconnectTimer = this.ctx.clock.setTimeoutExcludingSleep(() => {
      this.reconnectTimer = null;
      this.tryReconnect();
    }, delayMs);
  }

  private async tryReconnect(): Promise<void> {
    if (this.closed) return;
    this.status = "starting";
    try {
      const socket = await this.attemptConnect();
      if (this.closed) {
        socket.destroy();
        return;
      }
      await this.helloOn(socket);
    } catch (error) {
      if (this.closed) return;
      this.status = "unreachable";
      this.reason = (error as Error).message;
      this.scheduleReconnect();
    }
  }

  call(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    if (this.status !== "connected" || !this.link) {
      return Promise.reject(new Error(`守护进程不可达: ${this.reason ?? "尚未连接"}`));
    }
    return this.link.call(method, params);
  }

  subscribe(event: string, listener: (data: Record<string, unknown>) => void): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    const activeSet = set;
    activeSet.add(listener);
    return () => activeSet.delete(listener);
  }

  state(): DaemonClientState {
    return this.reason === undefined ? { status: this.status } : { status: this.status, reason: this.reason };
  }

  close(): void {
    this.closed = true;
    this.link?.destroy();
    this.link = null;
    this.listeners.clear();
    if (this.reconnectTimer) {
      this.ctx.clock.clearTimer(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ctx.ownsClock) this.ctx.clock.stopGapWatcher();
  }
}

export interface HelloInput {
  windowId: string;
  pid: number;
  sessionId: string;
  cwd: string;
  workspaceRoot: string;
}

export interface ConnectDaemonOptions {
  repoDir: string;
  dataRoot: string;
  sdkDir: string;
  execPath?: string;
  env?: Record<string, string>;
  clock?: Clock;
  hello: HelloInput;
}

async function resolveContext(options: ConnectDaemonOptions): Promise<ResolvedContext> {
  const identity = await repositoryIdentity(options.repoDir);
  return {
    socketPath: daemonSocketPath(options.dataRoot, identity.repoId),
    repoId: identity.repoId,
    commonDir: identity.commonDir,
    dataRoot: options.dataRoot,
    sdkDir: options.sdkDir,
    execPath: options.execPath,
    env: options.env,
    clock: options.clock ?? createClock(),
    ownsClock: options.clock === undefined,
    helloParams: {
      windowId: options.hello.windowId,
      pid: options.hello.pid,
      sessionId: options.hello.sessionId,
      cwd: options.hello.cwd,
      workspaceRoot: options.hello.workspaceRoot,
      repoIds: [identity.repoId],
      protocolVersion: PROTOCOL_VERSION,
    },
  };
}

export async function connectDaemon(options: ConnectDaemonOptions): Promise<DaemonClient> {
  const client = new DaemonClientImpl(await resolveContext(options));
  await client.connectInitial();
  return client;
}

export interface WorkspaceClientsOptions {
  workspaceRoot: string;
  dataRoot: string;
  sdkDir: string;
  execPath?: string;
  env?: Record<string, string>;
  clock?: Clock;
  hello: HelloInput;
}

export interface WorkspaceClientsHandle {
  forRepo(repoId: string): DaemonClient | undefined;
  all(): DaemonClient[];
  skipped(): WorkspaceSkipped[];
  workspace(): Workspace;
  closeAll(): void;
}

export const WorkspaceClients = {
  async create(options: WorkspaceClientsOptions): Promise<WorkspaceClientsHandle> {
    const workspace = await discoverWorkspace(options.workspaceRoot);
    const uniqueRepos = new Map<string, string>();
    for (const repo of workspace.repos) {
      if (!uniqueRepos.has(repo.repoId)) uniqueRepos.set(repo.repoId, repo.path);
    }

    const clients = new Map<string, DaemonClient>();
    await Promise.all(
      Array.from(uniqueRepos.entries()).map(async ([repoId, repoPath]) => {
        const ctx = await resolveContext({
          repoDir: repoPath,
          dataRoot: options.dataRoot,
          sdkDir: options.sdkDir,
          execPath: options.execPath,
          env: options.env,
          clock: options.clock,
          hello: options.hello,
        });
        const client = new DaemonClientImpl(ctx);
        await client.connectInitialOrDegrade();
        clients.set(repoId, client);
      }),
    );

    return {
      forRepo: (repoId: string) => clients.get(repoId),
      all: () => Array.from(clients.values()),
      skipped: () => workspace.skipped,
      workspace: () => workspace,
      closeAll: () => {
        for (const client of clients.values()) client.close();
      },
    };
  },
};
