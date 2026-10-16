import { controlToken } from "./daemon-auth.ts";
import { AdvisedError } from "../exec/tool-failure.ts";
import { closeSync, openSync } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import type { Socket } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getPackageDir } from "@earendil-works/pi-coding-agent";
import { probeExistingInstance, socketPathByteLimit } from "./daemon-probe.ts";
import { createClock } from "../policy/clock.ts";
import { uuidv7 } from "../storage/database.ts";
import type { Clock, TimerHandle } from "../policy/clock.ts";
import { daemonSocketPath, discoverWorkspace, repoDataDir, repositoryIdentity } from "../storage/identity.ts";
import type { RepositoryIdentity, Workspace, WorkspaceSkipped } from "../storage/identity.ts";
import { createRequest, decodeFrames, encodeFrame, PROTOCOL_VERSION } from "./protocol.ts";

const moduleDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(moduleDir, "../../..");
const daemonBootstrapEntry = join(packageRoot, "src/app/daemon/bootstrap.mjs");

const RECONNECT_BASE_MS = 200;
const RECONNECT_MAX_MS = 5_000;
const RECONNECT_JITTER_RATIO = 0.25;
const SPAWN_READY_TIMEOUT_MS = 10_000;
const SPAWN_POLL_INTERVAL_MS = 100;
const PRE_HANDSHAKE_EVENT_MAX_COUNT = 256;
const PRE_HANDSHAKE_EVENT_MAX_BYTES = 1024 * 1024;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function unreachable(reason: string): AdvisedError {
  return new AdvisedError("daemon_unreachable", { why: `守护进程不可达: ${reason}`, next: "稍等几秒重试；反复出现就请用户重开窗口" });
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
  hello: HelloInput;
}

type DaemonLaunchOptions = Omit<SpawnDaemonOptions, "hello">;

function buildDaemonEnv(params: {
  sdkDir: string;
  repoDir: string;
  dataRoot: string;
  env?: Record<string, string>;
}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...params.env,
    ONE_COMPANY_SDK_DIR: params.sdkDir,
    ONE_COMPANY_REPO_DIR: params.repoDir,
    ONE_COMPANY_DATA_ROOT: params.dataRoot,
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
  listening: Promise<void>;
}

const pendingSpawns = new Map<string, Promise<SpawnedProcess>>();

function beginSpawnDaemon(options: DaemonLaunchOptions, identity: RepositoryIdentity): Promise<SpawnedProcess> {
  const key = JSON.stringify([identity.commonDir, options.dataRoot, options.sdkDir, options.execPath ?? process.execPath,
    Object.entries(options.env ?? {}).sort(([a], [b]) => a.localeCompare(b))]);
  const existing = pendingSpawns.get(key);
  if (existing) return existing;
  const pending = launchDaemon(options, identity).then(async (spawned) => {
    await spawned.listening;
    return spawned;
  });
  pendingSpawns.set(key, pending);
  const clear = () => { if (pendingSpawns.get(key) === pending) pendingSpawns.delete(key); };
  void pending.then(clear, clear);
  return pending;
}

async function launchDaemon(options: DaemonLaunchOptions, identity: RepositoryIdentity): Promise<SpawnedProcess> {
  const captured = {
    execPath: options.execPath ?? process.execPath,
    sdkDir: options.sdkDir,
    dataRoot: options.dataRoot,
    env: options.env === undefined ? undefined : { ...options.env },
    repoId: identity.repoId,
    commonDir: identity.commonDir,
  };
  const repoDir = await repoDataDir(captured.dataRoot, captured.repoId, captured.commonDir);
  const launchId = uuidv7();
  const logDir = join(repoDir, "logs");
  await mkdir(logDir, { recursive: true, mode: 0o700 });
  const logPath = join(logDir, `${launchId}.log`);
  const logFd = openSync(logPath, "ax", 0o600);
  let child: ReturnType<typeof spawn>;
  try {
    const env = buildDaemonEnv({ sdkDir: captured.sdkDir, repoDir: captured.commonDir, dataRoot: captured.dataRoot, env: captured.env });
    child = spawn(captured.execPath, [daemonBootstrapEntry], {
      stdio: ["ignore", logFd, logFd],
      detached: true,
      env,
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

  const socketPath = daemonSocketPath(captured.dataRoot, captured.repoId);
  const listening = (async () => {
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

  return { listening };
}

function rawConnect(socketPath: string, register: (socket: Socket) => void): Promise<Socket> {
  const length = Buffer.byteLength(socketPath, "utf8");
  const limit = socketPathByteLimit();
  if (length > limit) return Promise.reject(new Error(`socket 路径超限（${length} 字节 > 平台上限 ${limit} 字节）: ${socketPath}`));
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let settled = false;
    let firstError: Error | undefined;
    const cleanup = () => {
      socket.removeListener("error", onError);
      socket.removeListener("connect", onConnect);
      socket.removeListener("close", onClose);
    };
    const rejectOnce = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onError = (error: Error) => {
      firstError ??= error;
      rejectOnce(firstError);
      socket.destroy();
    };
    const onConnect = () => {
      if (settled) return;
      if (socket.destroyed) {
        rejectOnce(firstError ?? new Error("连接在完成前已关闭"));
        return;
      }
      settled = true;
      cleanup();
      resolve(socket);
    };
    const onClose = () => rejectOnce(firstError ?? new Error("连接在完成前已关闭"));
    socket.once("error", onError);
    socket.once("connect", onConnect);
    socket.once("close", onClose);
    register(socket);
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
  connectOnly: boolean;
}

interface PendingCall {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
}

interface BufferedEvent {
  event: string;
  data: Record<string, unknown>;
}

class SocketLink {
  readonly socket: Socket;
  private buffer: string;
  private readonly pending: Map<string, PendingCall>;
  private readonly onEvent: (event: string, data: Record<string, unknown>) => void;
  private readonly onClose: (reason: string) => void;
  private eventState: "pending" | "open" | "discarded";
  private bufferedEvents: BufferedEvent[];
  private bufferedEventBytes: number;
  private closeHandled: boolean;
  private failureMessage: string | undefined;
  private lastErrorMessage: string | undefined;
  private readonly dataListener: (chunk: string) => void;
  private readonly errorListener: (error: Error) => void;
  private readonly closeListener: () => void;

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
    this.eventState = "pending";
    this.bufferedEvents = [];
    this.bufferedEventBytes = 0;
    this.closeHandled = false;
    this.failureMessage = undefined;
    this.dataListener = (chunk: string) => this.handleData(chunk);
    this.errorListener = (error: Error) => { this.lastErrorMessage = error.message; };
    this.closeListener = () => this.handleClose();
    socket.setEncoding("utf8");
    socket.on("data", this.dataListener);
    socket.on("error", this.errorListener);
    socket.once("close", this.closeListener);
  }

  private handleData(chunk: string): void {
    if (this.eventsDiscarded()) return;
    if (this.eventState === "pending"
      && this.bufferedEventBytes + Buffer.byteLength(this.buffer, "utf8") + Buffer.byteLength(chunk, "utf8") > PRE_HANDSHAKE_EVENT_MAX_BYTES) {
      this.failHandshake("hello 完成前收到的数据超出暂存上限");
      return;
    }
    this.buffer += chunk;
    const { frames, rest } = decodeFrames(this.buffer);
    this.buffer = rest;
    for (const frame of frames) {
      if (this.eventsDiscarded()) return;
      if (frame.t === "res") {
        const waiter = this.pending.get(frame.id);
        if (!waiter) continue;
        this.pending.delete(frame.id);
        if (frame.ok) waiter.resolve(frame.result);
        else waiter.reject(new DaemonCallError(frame.error.code, frame.error.message, frame.error.data));
      } else if (frame.t === "evt") {
        if (this.eventState === "open") {
          this.onEvent(frame.event, frame.data);
          continue;
        }
        const bytes = Buffer.byteLength(JSON.stringify(frame), "utf8");
        if (
          this.bufferedEvents.length >= PRE_HANDSHAKE_EVENT_MAX_COUNT
          || this.bufferedEventBytes + bytes > PRE_HANDSHAKE_EVENT_MAX_BYTES
        ) {
          this.failHandshake("hello 完成前收到的事件超出暂存上限");
          return;
        }
        this.bufferedEvents.push({ event: frame.event, data: frame.data });
        this.bufferedEventBytes += bytes;
      }
    }
  }

  private eventsDiscarded(): boolean {
    return this.eventState === "discarded";
  }

  private discardBufferedEvents(): void {
    this.eventState = "discarded";
    this.buffer = "";
    this.bufferedEvents = [];
    this.bufferedEventBytes = 0;
  }

  private failHandshake(reason: string): void {
    if (this.failureMessage) return;
    this.failureMessage = reason;
    this.lastErrorMessage = reason;
    this.discardBufferedEvents();
    this.socket.destroy(new Error(reason));
  }

  handshakeFailure(): string | undefined {
    if (this.failureMessage) return this.failureMessage;
    if (this.closeHandled || this.socket.destroyed) return this.lastErrorMessage ?? "hello 完成前连接已关闭";
    return undefined;
  }

  releaseBufferedEvents(): boolean {
    if (this.handshakeFailure() || this.eventState !== "pending") return false;
    const events = this.bufferedEvents;
    this.bufferedEvents = [];
    this.bufferedEventBytes = 0;
    this.eventState = "open";
    for (const event of events) {
      if (this.eventState !== "open") return false;
      this.onEvent(event.event, event.data);
    }
    return this.eventState === "open";
  }

  private handleClose(): void {
    if (this.closeHandled) return;
    this.closeHandled = true;
    this.discardBufferedEvents();
    const reason = this.lastErrorMessage ?? "连接已关闭";
    for (const waiter of this.pending.values()) waiter.reject(unreachable(reason));
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
    this.discardBufferedEvents();
    for (const waiter of this.pending.values()) waiter.reject(unreachable("已关闭"));
    this.pending.clear();
    this.socket.removeListener("data", this.dataListener);
    this.socket.removeListener("error", this.errorListener);
    this.socket.removeListener("close", this.closeListener);
    this.socket.destroy();
  }
}

export interface DaemonClientState {
  status: "connected" | "starting" | "unreachable";
  reason?: string;
}

/**
 * 仅在当前客户端进程内分发的连接生命周期事件，不属于 daemon 协议事件。
 * 它只提示宿主重新核对权限并重建自己的订阅，不授予用户权限，也不会重放任何调用或写操作。
 */
export const DAEMON_CLIENT_LIFECYCLE_EVENTS = {
  connected: "daemon.connected",
  disconnected: "daemon.disconnected",
} as const;

export interface DaemonConnectionIdentity {
  readonly daemonInstanceId: string;
  readonly connectionId: string;
  readonly connectionSequence: number;
}

export interface DaemonClientConnectedData extends Record<string, unknown> {
  status: "connected";
  repoId: string;
  connectionSequence: number;
  daemonInstanceId: string;
  connectionId: string;
  reconnected: boolean;
}

export interface DaemonClientDisconnectedData extends Record<string, unknown> {
  status: "unreachable";
  repoId: string;
  connectionSequence: number;
  reason: string;
  willReconnect: boolean;
  cause: "transport" | "handshake" | "client_close";
}

export interface DaemonClient {
  call(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
  subscribe(event: string, listener: (data: Record<string, unknown>) => void): () => void;
  state(): DaemonClientState;
  /** 仅可信宿主控制面使用；未连接、已关闭或握手失败时返回 null，不能签发索引许可。 */
  connectionIdentity(): Readonly<DaemonConnectionIdentity> | null;
  close(): void;
  /** 等待本客户端已开始的连接/握手以及全部原始 socket 实际 close。 */
  waitClosed(): Promise<void>;
}

class DaemonClientImpl implements DaemonClient {
  private readonly ctx: ResolvedContext;
  private link: SocketLink | null;
  private status: "connected" | "starting" | "unreachable";
  private reason: string | undefined;
  private closed: boolean;
  private reconnectTimer: TimerHandle | null;
  private reconnectDelayMs: number;
  private connectionSequence: number;
  private handshakeTerminal: boolean;
  private identity: Readonly<DaemonConnectionIdentity> | null = null;
  private helloResult: Readonly<Record<string, unknown>> | null = null;
  private readonly listeners: Map<string, Set<(data: Record<string, unknown>) => void>>;
  private readonly connectionOperations = new Set<Promise<void>>();
  private readonly socketClosures = new Map<Socket, Promise<void>>();

  constructor(ctx: ResolvedContext) {
    this.ctx = ctx;
    this.link = null;
    this.status = "starting";
    this.reason = undefined;
    this.closed = false;
    this.reconnectTimer = null;
    this.reconnectDelayMs = RECONNECT_BASE_MS;
    this.connectionSequence = 0;
    this.handshakeTerminal = false;
    this.listeners = new Map();
  }

  async connectInitial(): Promise<void> {
    try {
      await this.startConnectionOperation();
    } catch (error) {
      this.close();
      await this.waitClosed();
      throw error;
    }
  }

  private startConnectionOperation(): Promise<void> {
    const operation = (async () => {
      const socket = await this.attemptConnect();
      if (this.closed) {
        socket.destroy();
        throw new Error("客户端已关闭");
      }
      await this.helloOn(socket);
    })();
    this.connectionOperations.add(operation);
    const settled = () => { this.connectionOperations.delete(operation); };
    void operation.then(settled, settled);
    return operation;
  }

  private registerSocket(socket: Socket): void {
    if (this.socketClosures.has(socket)) throw new Error("socket 已登记");
    let settle!: () => void;
    const closed = new Promise<void>((resolve) => { settle = resolve; });
    this.socketClosures.set(socket, closed);
    socket.once("close", () => {
      this.socketClosures.delete(socket);
      settle();
    });
    if (this.closed) socket.destroy();
  }

  // 首连失败时不 reject：调用方（工作区多仓库场景）需要一个即便当下不可达也能持有、
  // 订阅、并在后台自动重连恢复的客户端，而不是让一个仓库的失败拖垮整个工作区连接的建立
  async connectInitialOrDegrade(): Promise<void> {
    try {
      await this.startConnectionOperation();
    } catch (error) {
      if (this.isTerminalHandshakeFailure(error)) {
        this.terminateHandshake(error as Error);
      } else {
        this.status = "unreachable";
        this.reason = (error as Error).message;
        this.scheduleReconnect();
      }
    }
  }

  // ENOENT（socket 文件不存在）、ECONNREFUSED（崩溃遗留的旧 socket 文件）、ENOTSOCK（socket 路径被普通文件占据）
  // 都意味着无人监听，此时才需要拉起新实例。
  private async attemptConnect(): Promise<Socket> {
    try {
      return await rawConnect(this.ctx.socketPath, (created) => this.registerSocket(created));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ECONNREFUSED" && code !== "ENOTSOCK") throw error;
      if (this.ctx.connectOnly) throw error;
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
      await spawned.listening;
      return rawConnect(this.ctx.socketPath, (created) => this.registerSocket(created));
    }
  }

  private async helloOn(socket: Socket): Promise<void> {
    let link: SocketLink | null = null;
    try {
      link = new SocketLink(
        socket,
        (event, data) => this.dispatchEvent(event, data),
        (reason) => this.handleDisconnect(link!, reason),
      );
      this.link = link;
      const authToken = controlToken(this.ctx.dataRoot);
      const result = await link.call("hello", { ...this.ctx.helloParams, authToken });
      if (this.closed) return;
      const handshakeFailure = link.handshakeFailure();
      if (handshakeFailure) throw new Error(handshakeFailure);
      if (this.link !== link) throw new Error("hello 完成前连接已关闭");
      const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
      if (result.repoId !== this.ctx.repoId || result.protocolVersion !== PROTOCOL_VERSION
        || typeof result.daemonPid !== "number" || !Number.isSafeInteger(result.daemonPid) || result.daemonPid <= 0
        || typeof result.startedAt !== "string" || result.startedAt.length === 0
        || typeof result.daemonInstanceId !== "string" || !uuid.test(result.daemonInstanceId)
        || typeof result.connectionId !== "string" || !uuid.test(result.connectionId)) {
        throw Object.assign(new Error("hello 响应身份字段缺失或不一致"), { code: "daemon_identity_mismatch" });
      }
      this.status = "connected";
      this.reason = undefined;
      this.reconnectDelayMs = RECONNECT_BASE_MS;
      this.connectionSequence += 1;
      this.identity = Object.freeze({ daemonInstanceId: result.daemonInstanceId, connectionId: result.connectionId,
        connectionSequence: this.connectionSequence });
      this.helloResult = Object.freeze({ ...result, connectionSequence: this.connectionSequence });
      this.dispatchEvent(DAEMON_CLIENT_LIFECYCLE_EVENTS.connected, this.connectedEventData());
      if (this.closed || this.handshakeTerminal || this.link !== link) return;
      if (!link.releaseBufferedEvents()) throw new Error("hello 完成后无法放行暂存事件");
      return;
    } catch (error) {
      // raw socket创建成功后始终由本次握手负责；任何pre-link或握手失败都只关闭自己的连接。
      if (link) {
        link.destroy();
        if (this.link === link) this.link = null;
      } else socket.destroy();
      throw error;
    } finally {
      if (this.closed && link) {
        link.destroy();
        if (this.link === link) this.link = null;
      }
    }
  }

  private connectedEventData(): DaemonClientConnectedData {
    return {
      status: "connected",
      repoId: this.ctx.repoId,
      connectionSequence: this.connectionSequence,
      reconnected: this.connectionSequence > 1,
      daemonInstanceId: this.identity!.daemonInstanceId,
      connectionId: this.identity!.connectionId,
    };
  }

  private disconnectedEventData(
    reason: string,
    willReconnect: boolean,
    cause: "transport" | "handshake" | "client_close",
  ): DaemonClientDisconnectedData {
    return {
      status: "unreachable",
      repoId: this.ctx.repoId,
      connectionSequence: this.connectionSequence,
      reason,
      willReconnect,
      cause,
    };
  }

  private notifyListener(listener: (data: Record<string, unknown>) => void, data: Record<string, unknown>): void {
    try {
      listener(data);
    } catch {
      // 单个监听器抛错不应影响同一事件的其他监听器，也不应拆连接
    }
  }

  private dispatchEvent(event: string, data: Record<string, unknown>): void {
    for (const listener of this.listeners.get(event) ?? []) this.notifyListener(listener, data);
  }

  private isTerminalHandshakeFailure(error: unknown): boolean {
    const code = (error as { code?: unknown } | null)?.code;
    return error instanceof DaemonCallError || code === "daemon_identity_mismatch" || code === "protocol_version";
  }

  private terminateHandshake(error: Error, expectedLink?: SocketLink): void {
    if (this.handshakeTerminal || this.closed || (expectedLink && this.link !== expectedLink)) return;
    this.handshakeTerminal = true;
    const wasConnected = this.status === "connected";
    const link = this.link;
    this.link = null;
    this.identity = null;
    this.helloResult = null;
    if (this.reconnectTimer) {
      this.ctx.clock.clearTimer(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    link?.destroy();
    this.status = "unreachable";
    this.reason = error.message;
    if (wasConnected) {
      this.dispatchEvent(
        DAEMON_CLIENT_LIFECYCLE_EVENTS.disconnected,
        this.disconnectedEventData(error.message, false, "handshake"),
      );
    }
  }

  private handleDisconnect(link: SocketLink, reason: string): void {
    if (this.closed || this.link !== link) return;
    const wasConnected = this.status === "connected";
    this.link = null;
    this.identity = null;
    this.helloResult = null;
    this.status = "unreachable";
    this.reason = reason;
    if (wasConnected) {
      this.dispatchEvent(
        DAEMON_CLIENT_LIFECYCLE_EVENTS.disconnected,
        this.disconnectedEventData(reason, true, "transport"),
      );
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.closed || this.handshakeTerminal || this.reconnectTimer) return;
    const baseDelay = this.reconnectDelayMs;
    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, RECONNECT_MAX_MS);
    const jitter = baseDelay * RECONNECT_JITTER_RATIO * (Math.random() * 2 - 1);
    const delayMs = Math.max(0, Math.round(baseDelay + jitter));
    this.reconnectTimer = this.ctx.clock.setTimeoutExcludingSleep(() => {
      this.reconnectTimer = null;
      void this.tryReconnect();
    }, delayMs);
  }

  private async tryReconnect(): Promise<void> {
    if (this.closed || this.handshakeTerminal) return;
    this.status = "starting";
    try {
      await this.startConnectionOperation();
    } catch (error) {
      if (this.closed || this.handshakeTerminal) return;
      if (this.isTerminalHandshakeFailure(error)) {
        this.terminateHandshake(error as Error);
      } else {
        this.status = "unreachable";
        this.reason = (error as Error).message;
        this.scheduleReconnect();
      }
    }
  }

  async call(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    if (this.status !== "connected" || !this.link || this.link.handshakeFailure()) {
      throw unreachable(this.reason ?? "尚未连接");
    }
    // 查询当前握手结果不再次发送 hello，避免查询 PID 时退役已绑定的连接能力。
    if (method === "hello") {
      if (Object.keys(params).length > 0) throw new Error("重建身份须关闭并重新连接客户端");
      return { ...this.helloResult };
    }
    const link = this.link;
    let result: Record<string, unknown>;
    try {
      result = await link.call(method, params);
    } catch (error) {
      if (this.closed || this.handshakeTerminal || this.link !== link) {
        throw unreachable(this.reason ?? "连接已变化");
      }
      throw error;
    }
    if (this.closed || this.handshakeTerminal || this.status !== "connected" || this.link !== link || link.handshakeFailure()) {
      throw unreachable(this.reason ?? "连接已变化");
    }
    return result;
  }

  connectionIdentity(): Readonly<DaemonConnectionIdentity> | null {
    return !this.closed && this.status === "connected" && this.link && !this.link.handshakeFailure() ? this.identity : null;
  }

  subscribe(event: string, listener: (data: Record<string, unknown>) => void): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    const activeSet = set;
    activeSet.add(listener);
    // connectDaemon 在首次 hello 完成后才返回；补发当前连接状态，宿主因此无需新增注册时机。
    // 这只是本地状态通知，不会重放远端事件、RPC 或任意写操作。
    if (event === DAEMON_CLIENT_LIFECYCLE_EVENTS.connected && this.status === "connected" && this.connectionSequence > 0) {
      this.notifyListener(listener, this.connectedEventData());
    }
    return () => activeSet.delete(listener);
  }

  state(): DaemonClientState {
    return this.reason === undefined ? { status: this.status } : { status: this.status, reason: this.reason };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.identity = null;
    this.helloResult = null;
    if (this.reconnectTimer) {
      this.ctx.clock.clearTimer(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.link?.destroy();
    this.link = null;
    for (const socket of this.socketClosures.keys()) socket.destroy();
    const reason = "客户端已关闭";
    this.status = "unreachable";
    this.reason = reason;
    if (!this.handshakeTerminal) {
      this.dispatchEvent(
        DAEMON_CLIENT_LIFECYCLE_EVENTS.disconnected,
        this.disconnectedEventData(reason, false, "client_close"),
      );
    }
    this.listeners.clear();
    if (this.ctx.ownsClock) this.ctx.clock.stopGapWatcher();
  }

  async waitClosed(): Promise<void> {
    if (!this.closed) throw new Error("必须先关闭客户端再等待连接结束");
    for (;;) {
      const operations = [...this.connectionOperations];
      if (operations.length) await Promise.allSettled(operations);
      const sockets = [...this.socketClosures.values()];
      if (sockets.length) await Promise.all(sockets);
      if (this.connectionOperations.size === 0 && this.socketClosures.size === 0) return;
    }
  }
}

export interface HelloInput {
  windowId: string;
  sessionId: string;
}

export interface ConnectDaemonOptions {
  repoDir: string;
  dataRoot: string;
  sdkDir: string;
  execPath?: string;
  env?: Record<string, string>;
  clock?: Clock;
  hello: HelloInput;
  /** 只连接现有 daemon；首连和重连均不会隐式创建进程。 */
  connectOnly?: boolean;
}

async function resolveContext(options: ConnectDaemonOptions): Promise<ResolvedContext> {
  const captured = {
    repoDir: options.repoDir,
    dataRoot: options.dataRoot,
    sdkDir: options.sdkDir,
    execPath: options.execPath,
    env: options.env === undefined ? undefined : { ...options.env },
    clock: options.clock,
    hello: { ...options.hello },
    connectOnly: options.connectOnly === true,
  };
  const identity = await repositoryIdentity(captured.repoDir);
  return {
    socketPath: daemonSocketPath(captured.dataRoot, identity.repoId),
    repoId: identity.repoId,
    commonDir: identity.commonDir,
    dataRoot: captured.dataRoot,
    sdkDir: captured.sdkDir,
    execPath: captured.execPath,
    env: captured.env,
    clock: captured.clock ?? createClock(),
    ownsClock: captured.clock === undefined,
    helloParams: {
      windowId: captured.hello.windowId,
      sessionId: captured.hello.sessionId,
      protocolVersion: PROTOCOL_VERSION,
    },
    connectOnly: captured.connectOnly,
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
