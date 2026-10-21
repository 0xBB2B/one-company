export const PROTOCOL_VERSION = 4;

export const PM_MESSAGE_MAX_CHARS = 4000;

export const METHODS = [
  "hello",
  "ping",
  "shutdown",
  "runs.get",
  "runs.pause",
  "runs.resume",
  "runs.stop",
  "agents.dispatchPm",
  "agents.dispatchExplore",
  "explore.result",
  "explore.list",
  "prototypes.dispatch",
  "prototypes.designers",
  "prototypes.list",
  "prototypes.board",
  "prototypes.pending",
  "prototypes.decide",
  "prototypes.remove",
  "prototypes.removal",
  "pm.overview",
  "pm.packet",
  "pm.message",
  "workflow.manage",
  "shells.list",
  "shells.stop",
  "index.manage",
  "knowledge.query",
] as const;

export const EVENTS = [
  "pm.overview.changed",
  "explore.finished",
  "explore.changed",
  "prototype.changed",
  "prototype.submitted",
  "prototype.finished",
] as const;

type RequestFrame = { t: "req"; id: string; method: string; params: Record<string, unknown> };
type ResponseFrame =
  | { t: "res"; id: string; ok: true; result: Record<string, unknown> }
  | { t: "res"; id: string; ok: false; error: { code: string; message: string; data?: Record<string, unknown> } };
type EventFrame = { t: "evt"; event: string; data: Record<string, unknown> };
export type Frame = RequestFrame | ResponseFrame | EventFrame;

export interface DecodeError {
  line: string;
  reason: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isFrame(value: unknown): value is Frame {
  if (!isPlainObject(value)) return false;
  switch (value.t) {
    case "req":
      return typeof value.id === "string" && typeof value.method === "string" && isPlainObject(value.params);
    case "res":
      if (typeof value.id !== "string") return false;
      if (value.ok === true) return isPlainObject(value.result);
      if (value.ok === false) {
        return isPlainObject(value.error) && typeof value.error.code === "string" && typeof value.error.message === "string";
      }
      return false;
    case "evt":
      return typeof value.event === "string" && isPlainObject(value.data);
    default:
      return false;
  }
}

type ProtocolError = Error & { code: string };

export function protocolError(code: string, message: string): ProtocolError {
  const error = new Error(message) as ProtocolError;
  error.code = code;
  return error;
}

export function encodeFrame(frame: Frame): string {
  return `${JSON.stringify(frame)}\n`;
}

export function decodeFrames(buffer: string): { frames: Frame[]; rest: string; errors: DecodeError[] } {
  const lines = buffer.split("\n");
  const rest = lines.pop() ?? "";
  const frames: Frame[] = [];
  const errors: DecodeError[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (line.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      errors.push({ line, reason: (error as Error).message });
      continue;
    }
    if (!isFrame(parsed)) {
      errors.push({ line, reason: "不是 req/res/evt 帧" });
      continue;
    }
    frames.push(parsed);
  }
  return { frames, rest, errors };
}

let requestCounter = 0;

export function createRequest(method: string, params: Record<string, unknown>): RequestFrame {
  requestCounter += 1;
  return { t: "req", id: String(requestCounter), method, params };
}

export function createResponse(id: string, result: Record<string, unknown>): ResponseFrame {
  return { t: "res", id, ok: true, result };
}

export function createErrorResponse(id: string, code: string, message: string, data?: Record<string, unknown>): ResponseFrame {
  return data === undefined
    ? { t: "res", id, ok: false, error: { code, message } }
    : { t: "res", id, ok: false, error: { code, message, data } };
}

export function assertKnownEvent(event: string): void {
  if (!(EVENTS as readonly string[]).includes(event)) {
    throw protocolError("unknown_event", `未知事件: ${event}`);
  }
}

export function createEvent(event: string, data: Record<string, unknown>): EventFrame {
  assertKnownEvent(event);
  return { t: "evt", event, data };
}

export function assertKnownMethod(method: string): void {
  if (!(METHODS as readonly string[]).includes(method)) {
    throw protocolError("unknown_method", `未知方法: ${method}`);
  }
}

export function assertProtocolVersion(version: number): void {
  if (version !== PROTOCOL_VERSION) {
    throw protocolError("protocol_version", `协议版本不一致: 期望 ${PROTOCOL_VERSION}，收到 ${version}`);
  }
}
