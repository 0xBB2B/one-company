export type FailureCategory = "connection" | "auth" | "quota" | "business" | "cancelled";

const CONNECTION_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT", "EAI_AGAIN"]);
const CONNECTION_NAMES = new Set(["FetchError", "TimeoutError"]);
// 模型请求超时不算断网：按断网处理会中止请求、SDK 就不再重试，所以交给 SDK 自动重试
const CONNECTION_MESSAGE = /fetch failed|socket hang up|network/i;
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
  private readonly paused = new Set<string>();

  requestPause(runId: string): void {
    this.paused.add(runId);
  }

  canProceed(runId: string): boolean {
    return !this.paused.has(runId);
  }

  resume(runId: string): void {
    this.paused.delete(runId);
  }
}
