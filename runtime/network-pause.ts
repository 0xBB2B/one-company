import type { Clock, TimerHandle } from "./clock.ts";

export type FailureCategory = "connection" | "auth" | "quota" | "business" | "cancelled";
export type PauseReason = "manual" | "network";

export type CanProceedResult = { allowed: true } | { allowed: false; reason: PauseReason };

const CONNECTION_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT", "EAI_AGAIN"]);
const CONNECTION_NAMES = new Set(["FetchError", "TimeoutError"]);
const CONNECTION_MESSAGE = /fetch failed|socket hang up|network|timed out/i;
const AUTH_MESSAGE = /unauthorized|invalid api key|authentication/i;
const QUOTA_MESSAGE = /quota|insufficient credits|billing|rate limit/i;
const CANCELLED_MESSAGE = /aborted/i;

interface CollectedFailureInfo {
  hasConnection: boolean;
  hasCancelled: boolean;
  statuses: number[];
  messages: string[];
}

function collectFailureInfo(error: unknown, acc: CollectedFailureInfo, seen: WeakSet<object>): void {
  if (typeof error === "string") {
    acc.messages.push(error);
    return;
  }
  if (typeof error !== "object" || error === null) return;
  if (seen.has(error)) return;
  seen.add(error);

  const obj = error as Record<string, unknown>;
  if (typeof obj.code === "string" && CONNECTION_CODES.has(obj.code)) acc.hasConnection = true;
  if (typeof obj.name === "string" && CONNECTION_NAMES.has(obj.name)) acc.hasConnection = true;
  if (obj.name === "AbortError") acc.hasCancelled = true;

  const rawStatus = obj.status ?? obj.statusCode;
  const status = typeof rawStatus === "string" ? Number(rawStatus) : rawStatus;
  if (typeof status === "number" && Number.isFinite(status)) acc.statuses.push(status);

  if (typeof obj.message === "string") acc.messages.push(obj.message);

  if (obj.cause !== undefined) collectFailureInfo(obj.cause, acc, seen);
  if (Array.isArray(obj.errors)) {
    for (const nested of obj.errors) collectFailureInfo(nested, acc, seen);
  }
}

export function classifyFailure(error: unknown): FailureCategory {
  const info: CollectedFailureInfo = { hasConnection: false, hasCancelled: false, statuses: [], messages: [] };
  collectFailureInfo(error, info, new WeakSet());

  if (info.hasCancelled) return "cancelled";
  if (info.hasConnection) return "connection";

  for (const status of info.statuses) {
    if (status < 400) continue;
    if (status === 401 || status === 403) return "auth";
    if (status === 402 || status === 429) return "quota";
    return "business";
  }

  const message = info.messages.join(" ");
  if (AUTH_MESSAGE.test(message)) return "auth";
  if (CONNECTION_MESSAGE.test(message)) return "connection";
  if (QUOTA_MESSAGE.test(message)) return "quota";
  if (CANCELLED_MESSAGE.test(message)) return "cancelled";
  return "business";
}

export class NetworkPauseGate {
  private readonly paused = new Map<string, PauseReason>();

  requestPause(runId: string, reason: PauseReason): void {
    this.paused.set(runId, reason);
  }

  canProceed(runId: string): CanProceedResult {
    const reason = this.paused.get(runId);
    return reason === undefined ? { allowed: true } : { allowed: false, reason };
  }

  resume(runId: string): void {
    this.paused.delete(runId);
  }

  resumeAll(reason: PauseReason): void {
    for (const [runId, pausedReason] of this.paused) {
      if (pausedReason === reason) this.paused.delete(runId);
    }
  }

  listPaused(reason?: PauseReason): Array<{ runId: string; reason: PauseReason }> {
    const result: Array<{ runId: string; reason: PauseReason }> = [];
    for (const [runId, pausedReason] of this.paused) {
      if (reason === undefined || pausedReason === reason) result.push({ runId, reason: pausedReason });
    }
    return result;
  }
}

// 探测目标是登记在案的 provider baseUrl（已带 scheme），不是裸主机名——校验其可解析、
// 无内嵌凭据、协议受限于 http/https，拦掉畸形或夹带凭据的地址后再放它去发起探测请求
export function toValidHostUrl(baseUrl: string): URL | null {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return null;
  }
  if (url.username !== "" || url.password !== "") return null;
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  return url;
}

export interface ConnectivityProbeOptions {
  clock: Clock;
  probe: () => Promise<unknown>;
  intervalMs: number;
}

// 通用的异步 tick 调度器：按固定间隔调用一次 probe，保证同一时刻至多一次在飞调用（inFlight），
// stop 后晚到的旧代际调用不再生效（generation）；探测结果如何解读完全由调用方决定，本类不解释返回值
export class ConnectivityProbe {
  private readonly clock: Clock;
  private readonly probeFn: () => Promise<unknown>;
  private readonly intervalMs: number;
  private timerHandle: TimerHandle | null = null;
  private generation = 0;
  private inFlight = false;

  constructor(options: ConnectivityProbeOptions) {
    this.clock = options.clock;
    this.probeFn = options.probe;
    this.intervalMs = options.intervalMs;
  }

  private async runTick(generation: number): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      await this.probeFn();
    } catch {
      // 单次探测的异常不该冒泡成未处理拒绝，也不该打断后续周期的调度
    } finally {
      if (generation === this.generation) this.inFlight = false;
    }
  }

  start(): void {
    if (this.timerHandle) return;
    this.generation++;
    const generation = this.generation;
    this.timerHandle = this.clock.setIntervalExcludingSleep(() => {
      void this.runTick(generation);
    }, this.intervalMs);
  }

  stop(): void {
    this.generation++;
    this.inFlight = false;
    if (!this.timerHandle) return;
    this.clock.clearTimer(this.timerHandle);
    this.timerHandle = null;
  }
}
