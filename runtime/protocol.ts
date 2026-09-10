import { Type } from "typebox";
import { Value } from "typebox/value";
import type { TSchema } from "typebox";

export const PROTOCOL_VERSION = 2;

export const METHODS = [
  "hello",
  "ping",
  "shutdown",
  "dispatch.requirement",
  "dispatch.review",
  "runs.list",
  "runs.get",
  "runs.pause",
  "runs.resume",
  "runs.stop",
  "runs.resumeInterrupted",
  "runs.pauseAll",
  "runs.resumeAll",
  "runs.stopAll",
  "subscribe.activity",
  "subscribe.transcript",
  "unsubscribe",
  "relay.pending",
  "relay.answer",
  "relay.forward",
  "shells.list",
  "shells.stop",
  "shells.markStopped",
  "mcp.register",
] as const;

export const EVENTS = [
  "activity",
  "transcript",
  "runs.changed",
  "relay.question",
  "relay.notice",
  "relay.withdraw",
  "shells.changed",
  "daemon.idle",
] as const;

export const ERROR_CODES = [
  "protocol_version",
  "unauthorized",
  "unknown_method",
  "unknown_event",
  "bad_params",
  "not_found",
  "already_active",
  "not_confirmed",
  "shape_violation",
  "daemon_busy",
  "daemon_starting",
  "internal",
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

function protocolError(code: string, message: string): ProtocolError {
  const error = new Error(message) as ProtocolError;
  error.code = code;
  return error;
}

const McpConfigSchema = Type.Object(
  { adapterEntry: Type.String(), configPath: Type.String() },
  { additionalProperties: false },
);

const DispatchContextSchema = Type.Object({
  projectTrusted: Type.Boolean(),
  model: Type.Optional(Type.Object({ provider: Type.String(), id: Type.String() }, { additionalProperties: false })),
  thinking: Type.Optional(Type.String()),
}, { additionalProperties: false });

const PARAM_SCHEMAS: Record<(typeof METHODS)[number], TSchema> = {
  hello: Type.Object(
    {
      authToken: Type.String({ minLength: 1 }),
      windowId: Type.String(),
      pid: Type.Number(),
      sessionId: Type.String(),
      cwd: Type.String(),
      workspaceRoot: Type.String(),
      repoIds: Type.Array(Type.String()),
      protocolVersion: Type.Number(),
    },
    { additionalProperties: false },
  ),
  ping: Type.Object({}, { additionalProperties: false }),
  shutdown: Type.Object({}, { additionalProperties: false }),
  "dispatch.requirement": Type.Object(
    {
      requirement: Type.String(),
      cwd: Type.String(),
      mcp: Type.Optional(McpConfigSchema),
      context: Type.Optional(DispatchContextSchema),
    },
    { additionalProperties: false },
  ),
  "dispatch.review": Type.Object(
    {
      requirement: Type.String(),
      cwd: Type.String(),
      baseline: Type.String(),
      snapshot: Type.Object(
        { head: Type.String(), fingerprint: Type.String() },
        { additionalProperties: false },
      ),
      mcp: Type.Optional(McpConfigSchema),
      context: Type.Optional(DispatchContextSchema),
    },
    { additionalProperties: false },
  ),
  "runs.list": Type.Object(
    {
      kind: Type.Optional(Type.String()),
      offset: Type.Optional(Type.Number()),
      limit: Type.Optional(Type.Number()),
    },
    { additionalProperties: false },
  ),
  "runs.get": Type.Object({ runId: Type.String() }, { additionalProperties: false }),
  "runs.pause": Type.Object({ runId: Type.String() }, { additionalProperties: false }),
  "runs.resume": Type.Object({ runId: Type.String() }, { additionalProperties: false }),
  "runs.stop": Type.Object({ runId: Type.String() }, { additionalProperties: false }),
  "runs.resumeInterrupted": Type.Object({ runId: Type.String() }, { additionalProperties: false }),
  "runs.pauseAll": Type.Object({}, { additionalProperties: false }),
  "runs.resumeAll": Type.Object({}, { additionalProperties: false }),
  "runs.stopAll": Type.Object({}, { additionalProperties: false }),
  "subscribe.activity": Type.Object({}, { additionalProperties: false }),
  "subscribe.transcript": Type.Object(
    {
      runId: Type.String(),
      fromSeq: Type.Optional(Type.Number()),
    },
    { additionalProperties: false },
  ),
  unsubscribe: Type.Object({ subscriptionId: Type.String() }, { additionalProperties: false }),
  "relay.pending": Type.Object({}, { additionalProperties: false }),
  "relay.answer": Type.Object(
    {
      questionId: Type.String(),
      answer: Type.String(),
      windowId: Type.String(),
    },
    { additionalProperties: false },
  ),
  "relay.forward": Type.Object(
    {
      requirement: Type.String(),
      message: Type.String(),
      windowId: Type.String(),
    },
    { additionalProperties: false },
  ),
  "shells.list": Type.Object({}, { additionalProperties: false }),
  "shells.stop": Type.Object(
    {
      taskId: Type.String(),
      expectedPid: Type.Number(),
      expectedStartedAt: Type.String(),
    },
    { additionalProperties: false },
  ),
  "shells.markStopped": Type.Object(
    {
      taskId: Type.String(),
      expectedPid: Type.Number(),
      expectedStartedAt: Type.String(),
      decisionId: Type.String(),
    },
    { additionalProperties: false },
  ),
  "mcp.register": McpConfigSchema,
};

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

export function validateParams(method: string, params: unknown): void {
  assertKnownMethod(method);
  const schema = PARAM_SCHEMAS[method as (typeof METHODS)[number]];
  if (Value.Check(schema, params)) return;
  const messages = Array.from(Value.Errors(schema, params)).map((error) =>
    error.instancePath ? `${error.instancePath} ${error.message}` : error.message,
  );
  throw protocolError("bad_params", messages.join("; "));
}
