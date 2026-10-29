import { controlToken } from "./daemon-auth.ts";
import { AdvisedError } from "../exec/tool-failure.ts";
import { MIGRATION_FAILED_NEXT } from "./database-migration-prompt.ts";
import type { BeforeSpawn, BeforeSpawnResult } from "./database-migration-prompt.ts";
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
import { daemonSocketPath, discoverWorkspace, repoDataDir, repoDisplayName, repositoryIdentity } from "../storage/identity.ts";
import type { RepositoryIdentity, Workspace, WorkspaceSkipped } from "../storage/identity.ts";
import { upgradeAdvice } from "./upgrade-notice.ts";
import type { UpgradeNotice } from "./upgrade-notice.ts";
import { createRequest, decodeFrames, encodeFrame, PROTOCOL_VERSION } from "./protocol.ts";

const moduleDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(moduleDir, "../../..");
const daemonBootstrapEntry = join(packageRoot, "src/app/daemon/bootstrap.mjs");

const UPGRADE_BLOCKED_REASON = "后台进程是旧版本，等待换新";
const RECONNECT_BASE_MS = 200;
const RECONNECT_MAX_MS = 5_000;
const RECONNECT_JITTER_RATIO = 0.25;
const SPAWN_READY_TIMEOUT_MS = 10_000;
const SPAWN_POLL_INTERVAL_MS = 100;
const PRE_HANDSHAKE_EVENT_MAX_COUNT = 256;
const PRE_HANDSHAKE_EVENT_MAX_BYTES = 1024 * 1024;
const UPGRADE_POLL_MS = 30_000;
const UPGRADE_YIELD_CLOSE_TIMEOUT_MS = 10_000;

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

function staleDaemonError(): Error {
  return Object.assign(new Error("后台进程是旧版本，和当前安装的 one-company 不一致：请关闭所有 pi 窗口后重新打开"), { code: "protocol_version" });
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
  onUpgradeNotice: ((notice: UpgradeNotice) => void) | undefined;
  beforeSpawn: BeforeSpawn | undefined;
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
    if (this.closeHandled || this.socket.destroyed) return Promise.reject(unreachable(this.lastErrorMessage ?? "连接已关闭"));
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

interface UpgradeAnswer {
  stale: boolean;
  protocolVersion: number;
  requirements: string[];
  otherWindows: number;
  ownSessions: number;
  accepted?: boolean;
}

type UpgradeVerdict =
  | { kind: "unsupported" | "unknown" | "current" | "yielded" }
  | { kind: "busy"; answer: UpgradeAnswer };

function isBusy(answer: UpgradeAnswer): boolean {
  return answer.requirements.length > 0 || answer.otherWindows > 0 || answer.ownSessions > 0;
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
  private migrationStop: AdvisedError | undefined;
  private upgradeWait: { kind: "usable" | "blocked"; answer: UpgradeAnswer } | null = null;
  private upgradeTimer: TimerHandle | null = null;
  private windowStale = false;
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
    return this.track((async () => {
      const socket = await this.attemptConnect();
      if (this.closed) {
        socket.destroy();
        throw new Error("客户端已关闭");
      }
      const link = this.createLink(socket);
      if (this.ctx.connectOnly) {
        await this.helloOrStale(link, "other");
        return;
      }
      await this.applyVerdict(await this.inspectOn(link), link, false);
    })());
  }

  private track(operation: Promise<void>): Promise<void> {
    this.connectionOperations.add(operation);
    const settled = () => { this.connectionOperations.delete(operation); };
    void operation.then(settled, settled);
    return operation;
  }

  private createLink(socket: Socket): SocketLink {
    const link: SocketLink = new SocketLink(
      socket,
      (event, data) => this.dispatchEvent(event, data),
      (reason) => this.handleDisconnect(link, reason),
    );
    return link;
  }

  private upgradeParams(): Record<string, unknown> {
    return { authToken: controlToken(this.ctx.dataRoot), windowId: this.ctx.helloParams.windowId };
  }

  private async inspectOn(link: SocketLink): Promise<UpgradeVerdict> {
    let answer: UpgradeAnswer;
    try {
      answer = await link.call("upgrade.check", this.upgradeParams()) as unknown as UpgradeAnswer;
    } catch (error) {
      return { kind: error instanceof DaemonCallError && error.code === "unknown_method" ? "unsupported" : "unknown" };
    }
    if (!answer.stale) return { kind: "current" };
    if (isBusy(answer)) return { kind: "busy", answer };
    const yielded = await this.yieldOn(link);
    if (!yielded) return { kind: "unknown" };
    return yielded.accepted ? { kind: "yielded" } : { kind: "busy", answer: yielded };
  }

  private async yieldOn(link: SocketLink): Promise<UpgradeAnswer | undefined> {
    try {
      return await link.call("upgrade.yield", this.upgradeParams()) as unknown as UpgradeAnswer;
    } catch {
      return undefined;
    }
  }

  private async reconnectAfterYield(old: SocketLink): Promise<SocketLink> {
    const closed = old.socket.destroyed || await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), UPGRADE_YIELD_CLOSE_TIMEOUT_MS);
      old.socket.once("close", () => { clearTimeout(timer); resolve(true); });
    });
    old.destroy();
    if (!closed) throw new Error(`旧的后台进程同意让位后 ${UPGRADE_YIELD_CLOSE_TIMEOUT_MS / 1000} 秒内没有断开连接`);
    if (this.closed) throw new Error("客户端已关闭");
    const socket = await this.attemptConnect();
    if (this.closed) {
      socket.destroy();
      throw new Error("客户端已关闭");
    }
    return this.createLink(socket);
  }

  private async helloOrStale(link: SocketLink, basis: "current" | "unknown" | "other"): Promise<void> {
    try {
      await this.helloOn(link);
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code === "protocol_version") {
        if (basis === "current") this.enterWindowStale();
        // 检查没查清守护进程是不是旧的，不能直接判终止；交给退避重连下次重查
        else if (basis === "unknown") throw new Error("后台进程和这个窗口协议版本不同，这次没能确认它是否过旧，正在重新连接检查");
      }
      throw error;
    }
  }

  private notice(kind: UpgradeNotice["kind"], answer?: UpgradeAnswer): UpgradeNotice {
    return {
      kind,
      repoName: repoDisplayName(this.ctx.commonDir),
      requirements: answer?.requirements ?? [],
      otherWindows: answer?.otherWindows ?? 0,
      ownSessions: answer?.ownSessions ?? 0,
    };
  }

  private clearUpgradeWait(): void {
    this.upgradeWait = null;
    if (this.upgradeTimer) {
      this.ctx.clock.clearTimer(this.upgradeTimer);
      this.upgradeTimer = null;
    }
  }

  private enterWindowStale(): void {
    if (this.windowStale) return;
    this.windowStale = true;
    this.clearUpgradeWait();
    this.ctx.onUpgradeNotice?.(this.notice("window_stale"));
  }

  private enterUpgradeWait(kind: "usable" | "blocked", answer: UpgradeAnswer): void {
    if (this.closed) return;
    const first = this.upgradeWait === null;
    this.upgradeWait = { kind, answer };
    if (kind === "blocked") {
      this.status = "unreachable";
      this.reason = UPGRADE_BLOCKED_REASON;
    }
    if (first) this.ctx.onUpgradeNotice?.(this.notice(kind === "usable" ? "waiting_usable" : "waiting_blocked", answer));
    this.scheduleUpgradePoll();
  }

  private async applyVerdict(verdict: UpgradeVerdict, link: SocketLink, handshaken: boolean): Promise<void> {
    switch (verdict.kind) {
      case "unsupported":
        if (!handshaken) await this.helloOrStale(link, "other");
        return;
      case "current":
        if (!handshaken) await this.helloOrStale(link, "current");
        if (this.upgradeWait !== null) this.finishReplacement(false);
        return;
      case "yielded":
        if (handshaken) await this.replaceAfterYield(link);
        else await this.connectReplacement(link);
        return;
      case "busy":
        if (verdict.answer.protocolVersion === PROTOCOL_VERSION) {
          if (!handshaken) await this.helloOrStale(link, "other");
          this.enterUpgradeWait("usable", verdict.answer);
        } else {
          link.destroy();
          this.enterUpgradeWait("blocked", verdict.answer);
        }
        return;
      case "unknown":
        // 协议版本号不同的等待（blocked）里检查失败，去握手只会被拒；保持 30 秒重查，别掉进退避重连，并继续给模型返回"正在等换新"
        if (this.upgradeWait?.kind === "blocked") {
          if (!handshaken) link.destroy();
          this.enterUpgradeWait("blocked", this.upgradeWait.answer);
          return;
        }
        if (!handshaken) await this.helloOrStale(link, "unknown");
        this.scheduleUpgradePoll();
        return;
    }
  }

  private async connectReplacement(old: SocketLink): Promise<void> {
    const link = await this.reconnectAfterYield(old);
    await this.helloOrStale(link, "current");
    this.finishReplacement(true);
  }

  private finishReplacement(replaced: boolean): void {
    const waited = this.upgradeWait !== null;
    this.clearUpgradeWait();
    if (waited) this.ctx.onUpgradeNotice?.(this.notice("replaced_after_wait"));
    else if (replaced) this.ctx.onUpgradeNotice?.(this.notice("replaced"));
  }

  private scheduleUpgradePoll(): void {
    if (this.closed || this.upgradeTimer) return;
    this.upgradeTimer = this.ctx.clock.setTimeoutExcludingSleep(() => {
      this.upgradeTimer = null;
      void this.pollUpgrade();
    }, UPGRADE_POLL_MS);
  }

  private async pollUpgrade(): Promise<void> {
    if (this.closed || this.handshakeTerminal || this.windowStale) return;
    const link = this.link;
    if (!link || this.status !== "connected") {
      // 已连上过的窗口掉线后由退避重连接手，这里再连会和它并发
      if (this.upgradeWait?.kind === "blocked" && this.connectionOperations.size === 0 && !this.reconnectTimer) await this.tryReconnect();
      else this.scheduleUpgradePoll();
      return;
    }
    const verdict = await this.inspectOn(link);
    if (this.closed || this.link !== link) return;
    await this.applyVerdict(verdict, link, true);
  }

  private async replaceAfterYield(old: SocketLink): Promise<void> {
    this.link = null;
    this.identity = null;
    this.helloResult = null;
    this.status = "starting";
    this.reason = "后台进程正在换成新版本";
    this.dispatchEvent(
      DAEMON_CLIENT_LIFECYCLE_EVENTS.disconnected,
      this.disconnectedEventData(this.reason, true, "transport"),
    );
    try {
      await this.track(this.connectReplacement(old));
    } catch (error) {
      this.handleConnectFailure(error);
    }
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
      // 检查本身出错也要停下：照常重连会反复检查，可能反复弹迁移框
      const check = await this.ctx.beforeSpawn?.(identity).catch((failure: unknown): BeforeSpawnResult => ({ proceed: false, code: "database_migration_failed",
        why: `守护进程不可达：检查本机数据库版本时失败：${failure instanceof Error ? failure.message : String(failure)}`, next: MIGRATION_FAILED_NEXT }));
      if (check && !check.proceed) throw new AdvisedError(check.code, { why: check.why, next: check.next });
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

  private async helloOn(link: SocketLink): Promise<void> {
    try {
      this.link = link;
      const authToken = controlToken(this.ctx.dataRoot);
      const result = await link.call("hello", { ...this.ctx.helloParams, authToken }).catch((error: unknown) => {
        throw error instanceof DaemonCallError && error.code === "protocol_version" ? staleDaemonError() : error;
      });
      if (this.closed) return;
      const handshakeFailure = link.handshakeFailure();
      if (handshakeFailure) throw new Error(handshakeFailure);
      if (this.link !== link) throw new Error("hello 完成前连接已关闭");
      const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
      if (result.protocolVersion !== PROTOCOL_VERSION) throw staleDaemonError();
      if (result.repoId !== this.ctx.repoId
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
      link.destroy();
      if (this.link === link) this.link = null;
      throw error;
    } finally {
      if (this.closed) {
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
    return error instanceof DaemonCallError || code === "daemon_identity_mismatch" || code === "protocol_version"
      || code === "database_migration_declined" || code === "database_migration_failed";
  }

  private terminateHandshake(error: Error, expectedLink?: SocketLink): void {
    if (this.handshakeTerminal || this.closed || (expectedLink && this.link !== expectedLink)) return;
    this.handshakeTerminal = true;
    if (error instanceof AdvisedError && error.code.startsWith("database_migration_")) this.migrationStop = error;
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
      this.handleConnectFailure(error);
    }
  }

  private handleConnectFailure(error: unknown): void {
    if (this.closed || this.handshakeTerminal) return;
    if (this.isTerminalHandshakeFailure(error)) {
      this.terminateHandshake(error as Error);
    } else {
      this.status = "unreachable";
      this.reason = (error as Error).message;
      this.scheduleReconnect();
    }
  }

  async call(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    if (this.migrationStop) throw new AdvisedError(this.migrationStop.code, this.migrationStop.advice);
    if (this.windowStale) throw new AdvisedError("window_stale", upgradeAdvice(this.notice("window_stale")));
    if (this.upgradeWait?.kind === "blocked" && this.status !== "connected" && this.reason === UPGRADE_BLOCKED_REASON) {
      throw new AdvisedError("daemon_upgrade_pending", upgradeAdvice(this.notice("waiting_blocked", this.upgradeWait.answer)));
    }
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
    this.clearUpgradeWait();
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
  onUpgradeNotice?: (notice: UpgradeNotice) => void;
  beforeSpawn?: BeforeSpawn;
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
    onUpgradeNotice: options.onUpgradeNotice,
    beforeSpawn: options.beforeSpawn,
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
    onUpgradeNotice: captured.onUpgradeNotice,
    beforeSpawn: captured.beforeSpawn,
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
  onUpgradeNotice?: (notice: UpgradeNotice) => void;
  beforeSpawn?: BeforeSpawn;
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
    const results = await Promise.allSettled(
      Array.from(uniqueRepos.entries()).map(async ([repoId, repoPath]) => {
        const ctx = await resolveContext({
          repoDir: repoPath,
          dataRoot: options.dataRoot,
          sdkDir: options.sdkDir,
          execPath: options.execPath,
          env: options.env,
          clock: options.clock,
          hello: options.hello,
          onUpgradeNotice: options.onUpgradeNotice,
          beforeSpawn: options.beforeSpawn,
        });
        const client = new DaemonClientImpl(ctx);
        await client.connectInitialOrDegrade();
        clients.set(repoId, client);
      }),
    );
    const failure = results.find((result) => result.status === "rejected");
    if (failure) {
      for (const client of clients.values()) client.close();
      throw failure.reason;
    }

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
