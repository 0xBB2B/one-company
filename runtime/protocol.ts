import { Type } from "typebox";
import { Value } from "typebox/value";
import type { TSchema } from "typebox";
import { KnowledgeTransportQuerySchema, parseKnowledgeTransportQuery } from "./knowledge-query-tool.ts";

export const PROTOCOL_VERSION = 2;

export const PM_MESSAGE_MAX_CHARS = 4000;

export const METHODS = [
  "hello",
  "ping",
  "shutdown",
  "runs.list",
  "runs.get",
  "runs.pause",
  "runs.resume",
  "runs.stop",
  "agents.dispatchPm",
  "agents.dispatchExplore",
  "explore.result",
  "pm.overview",
  "pm.packet",
  "pm.prototype",
  "pm.prototypeDecide",
  "pm.message",
  "workflow.manage",
  "runs.pauseAll",
  "runs.stopAll",
  "shells.list",
  "shells.stop",
  "shells.markStopped",
  "mcp.register",
  "index.manage",
  "knowledge.query",
] as const;

export const EVENTS = [
  "runs.changed",
  "pm.overview.changed",
  "explore.finished",
  "relay.notice",
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
  "authorization_denied",
  "resource_limit",
  "not_initialized",
  "index_unavailable",
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
  "agents.dispatchPm": Type.Object({ requirementId: Type.String(), model: Type.Object({ provider: Type.String(), id: Type.String() }, { additionalProperties: false }),
    thinking: Type.String() }, { additionalProperties: false }),
  "pm.overview": Type.Object({}, { additionalProperties: false }),
  "agents.dispatchExplore": Type.Object({ request: Type.Object({ question: Type.String(), clues: Type.Array(Type.String()),
    source: Type.Union([Type.Object({ kind: Type.Literal("local_file") }, { additionalProperties: false }),
      Type.Object({ kind: Type.Literal("web"), query: Type.String() }, { additionalProperties: false })]) }, { additionalProperties: false }),
    maxTurns: Type.Integer({ minimum: 1, maximum: 100 }), model: Type.Object({ provider: Type.String(), id: Type.String() }, { additionalProperties: false }),
    thinking: Type.String() }, { additionalProperties: false }),
  "explore.result": Type.Object({ runId: Type.String() }, { additionalProperties: false }),
  "pm.packet": Type.Object({ requirementId: Type.String(), itemId: Type.String() }, { additionalProperties: false }),
  "pm.prototype": Type.Object({ requirementId: Type.String(), itemId: Type.String() }, { additionalProperties: false }),
  "pm.prototypeDecide": Type.Object({ requirementId: Type.String(), itemId: Type.String(), itemVersion: Type.String(),
    choice: Type.Union([Type.Literal("accept"), Type.Literal("rework")]), opinion: Type.Union([Type.String(), Type.Null()]) }, { additionalProperties: false }),
  "pm.message": Type.Object({ requirementId: Type.String(), text: Type.String({ minLength: 1, maxLength: PM_MESSAGE_MAX_CHARS }) }, { additionalProperties: false }),
  "workflow.manage": Type.Object({ requirementId: Type.String(), request: Type.Object({}, { additionalProperties: true }) }, { additionalProperties: false }),
  "runs.stop": Type.Object({ runId: Type.String() }, { additionalProperties: false }),
  "runs.pauseAll": Type.Object({}, { additionalProperties: false }),
  "runs.stopAll": Type.Object({}, { additionalProperties: false }),
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
  "index.manage": Type.Object({ action: Type.Union(["init", "preview", "refresh", "status"].map((action) => Type.Literal(action))) },
    { additionalProperties: false }),
  "knowledge.query": Type.Object({ query: KnowledgeTransportQuerySchema }, { additionalProperties: false }),
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
  if (Value.Check(schema, params)) {
    if (method === "knowledge.query") {
      try { parseKnowledgeTransportQuery((params as Record<string, unknown>).query); }
      catch { throw protocolError("bad_params", "知识查询参数无效"); }
    }
    return;
  }
  const messages = Array.from(Value.Errors(schema, params)).map((error) =>
    error.instancePath ? `${error.instancePath} ${error.message}` : error.message,
  );
  throw protocolError("bad_params", messages.join("; "));
}
