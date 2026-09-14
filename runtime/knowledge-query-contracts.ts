import { classifyIndexWatchEvent } from "./project-index-policy.ts";

export const KNOWLEDGE_QUERY_LIMITS = Object.freeze({
  queryCodepoints: 256, pageSize: 20, pageBytes: 49_152, minimumPageBytes: 4_096,
  snippetCodepoints: 800, snippetBytes: 4_096, itemBytes: 24_576,
  cachedItems: 500, sessions: 8, cacheBytes: 2 * 1024 * 1024, ttlMs: 30_000,
});

export type KnowledgeQuery = (
  | { action: "exact"; by: "id" | "path" | "symbol"; value: string }
  | { action: "search"; text: string }
  | { action: "facts"; text?: string }
) & { pageSize?: number; maxBytes?: number; cursor?: string };

export class KnowledgeQueryError extends Error {
  readonly code: "invalid_query" | "unavailable" | "stale" | "invalid_cursor" | "resource_limit" | "busy";
  constructor(code: KnowledgeQueryError["code"]) {
    super(`知识查询被拒绝：${code}`);
    this.name = "KnowledgeQueryError";
    this.code = code;
  }
}

const pageProperties = {
  pageSize: { type: "integer", minimum: 1, maximum: KNOWLEDGE_QUERY_LIMITS.pageSize },
  maxBytes: { type: "integer", minimum: KNOWLEDGE_QUERY_LIMITS.minimumPageBytes, maximum: KNOWLEDGE_QUERY_LIMITS.pageBytes },
  cursor: { type: "string", pattern: "^[A-Za-z0-9_-]{43}$" },
};
/** 模型参数只有查询条件和预算；授权、角色、工作区和数据根由可信宿主绑定。 */
export const KnowledgeQuerySchema = Object.freeze({
  oneOf: [
    { type: "object", additionalProperties: false, required: ["action", "by", "value"], properties: {
      action: { const: "exact" }, by: { enum: ["id", "path", "symbol"] }, value: { type: "string", minLength: 1, maxLength: 4096 }, ...pageProperties,
    } },
    { type: "object", additionalProperties: false, required: ["action", "text"], properties: {
      action: { const: "search" }, text: { type: "string", minLength: 1, maxLength: 256 }, ...pageProperties,
    } },
    { type: "object", additionalProperties: false, required: ["action"], properties: {
      action: { const: "facts" }, text: { type: "string", minLength: 1, maxLength: 256 }, ...pageProperties,
    } },
  ],
});

export function isKnowledgePath(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 4096 || /^[A-Za-z]:/u.test(value)
    || /[\u0000-\u001f\u007f]/u.test(value)) return false;
  try { return classifyIndexWatchEvent(value) === "index"; } catch { return false; }
}

export function parseKnowledgeQuery(input: unknown): KnowledgeQuery {
  const fail = (): never => { throw new KnowledgeQueryError("invalid_query"); };
  if (!input || typeof input !== "object" || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) fail();
  const value = input as Record<string, unknown>;
  const keys = value.action === "exact" ? ["action", "by", "value"] : value.action === "search" || value.action === "facts" ? ["action", "text"] : fail();
  if (Object.keys(value).some((key) => ![...keys, "pageSize", "maxBytes", "cursor"].includes(key))) fail();
  const text = (item: unknown, maximum: number): item is string => typeof item === "string" && item.trim().length > 0
    && Array.from(item).length <= maximum && !/[\u0000-\u001f\u007f\ud800-\udfff]/u.test(item);
  if (value.action === "exact") {
    if (!["id", "path", "symbol"].includes(String(value.by)) || !text(value.value, value.by === "path" ? 4096 : 512)) fail();
    if (value.by === "path" && !isKnowledgePath(value.value)) fail();
    if (value.by === "id" && (typeof value.value !== "string" || !/^[\p{L}\p{N}][\p{L}\p{N}._:/#@+-]{0,255}$/u.test(value.value))) fail();
  } else if ((value.action === "search" || value.text !== undefined) && !text(value.text, KNOWLEDGE_QUERY_LIMITS.queryCodepoints)) fail();
  if (value.cursor !== undefined && (typeof value.cursor !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(value.cursor))) fail();
  for (const [key, min, max] of [["pageSize", 1, KNOWLEDGE_QUERY_LIMITS.pageSize], ["maxBytes", KNOWLEDGE_QUERY_LIMITS.minimumPageBytes, KNOWLEDGE_QUERY_LIMITS.pageBytes]] as const) {
    if (value[key] !== undefined && (!Number.isSafeInteger(value[key]) || Number(value[key]) < min || Number(value[key]) > max)) fail();
  }
  return { ...value, pageSize: value.pageSize ?? 10, maxBytes: value.maxBytes ?? 16_384 } as KnowledgeQuery;
}
