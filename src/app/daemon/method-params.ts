import { Type } from "typebox";
import { Value } from "typebox/value";
import type { TSchema } from "typebox";
import { hash, id, positive } from "../../modules/requirement/requirement-contracts.ts";
import { PrototypeDispatchInput } from "../../modules/prototype/prototype-dispatch.ts";
import { KnowledgeTransportQuerySchema, parseKnowledgeTransportQuery } from "../../modules/project-index/knowledge-query-tool.ts";
import { assertKnownMethod, PM_MESSAGE_MAX_CHARS, protocolError } from "../../core/host/protocol.ts";
import type { METHODS } from "../../core/host/protocol.ts";

const PARAM_SCHEMAS: Record<(typeof METHODS)[number], TSchema> = {
  hello: Type.Object(
    {
      authToken: Type.String({ minLength: 1 }),
      windowId: Type.String(),
      sessionId: Type.String(),
      protocolVersion: Type.Number(),
    },
    { additionalProperties: false },
  ),
  ping: Type.Object({}, { additionalProperties: false }),
  shutdown: Type.Object({}, { additionalProperties: false }),
  "runs.get": Type.Object({ runId: Type.String() }, { additionalProperties: false }),
  "runs.steps": Type.Object({ runId: Type.String() }, { additionalProperties: false }),
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
  "explore.list": Type.Object({}, { additionalProperties: false }),
  "prototypes.dispatch": PrototypeDispatchInput,
  "prototypes.designers": Type.Object({}, { additionalProperties: false }),
  "prototypes.list": Type.Object({}, { additionalProperties: false }),
  "prototypes.board": Type.Object({ requirementId: id }, { additionalProperties: false }),
  "prototypes.pending": Type.Object({ requirementId: id, name: Type.String() }, { additionalProperties: false }),
  "prototypes.decide": Type.Object({ requirementId: id, name: Type.String(), version: positive, hash,
    choice: Type.Union([Type.Literal("accept"), Type.Literal("opinion"), Type.Literal("abandon")]),
    opinion: Type.Union([Type.String({ maxLength: 4000 }), Type.Null()]),
    option: Type.Union([Type.String({ pattern: "^[A-F]$" }), Type.Null()]) }, { additionalProperties: false }),
  "prototypes.remove": Type.Object({ requirementId: id, name: Type.String(), version: positive }, { additionalProperties: false }),
  "prototypes.removal": Type.Object({ requirementId: id, name: Type.String() }, { additionalProperties: false }),
  "pm.packet": Type.Object({ requirementId: Type.String(), itemId: Type.String() }, { additionalProperties: false }),
  "pm.message": Type.Object({ requirementId: Type.String(), text: Type.String({ minLength: 1, maxLength: PM_MESSAGE_MAX_CHARS }) }, { additionalProperties: false }),
  "workflow.manage": Type.Object({ requirementId: Type.String(), request: Type.Object({}, { additionalProperties: true }) }, { additionalProperties: false }),
  "runs.stop": Type.Object({ runId: Type.String() }, { additionalProperties: false }),
  "shells.list": Type.Object({}, { additionalProperties: false }),
  "shells.stop": Type.Object(
    {
      taskId: Type.String(),
      expectedPid: Type.Number(),
      expectedStartedAt: Type.String(),
    },
    { additionalProperties: false },
  ),
  "index.manage": Type.Object({ action: Type.Union(["init", "preview", "refresh", "status"].map((action) => Type.Literal(action))) },
    { additionalProperties: false }),
  "knowledge.query": Type.Object({ query: KnowledgeTransportQuerySchema }, { additionalProperties: false }),
};

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
