import { indexPathScope } from "./project-index-policy.ts";
import { withDetail } from "./tool-failure.ts";
import type { FailureAdvice } from "./tool-failure.ts";

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

const KNOWLEDGE_ADVICE = {
  invalid_query: { why: "查询参数不合规", next: "exact 填 by（path、id 或 symbol）与 value；search 与 facts 填 text；第一次查询不带 cursor" },
  unavailable: { why: "本机索引暂时不可用", next: "用 one_company_project_manage 的 refresh 刷新索引后重试；仍然失败就把原因告诉用户" },
  stale: { why: "查询期间索引或文件已变化，这一页的结果作废", next: "不带 cursor 重新查询" },
  invalid_cursor: { why: "cursor 不是上一页结果给出的值，或查询条件变了", next: "第一次查询不带 cursor；翻页时原样填上一页给出的 cursor，其他条件不变" },
  resource_limit: { why: "结果超出了页大小上限", next: "调小 pageSize 或 maxBytes，或把查询条件写得更具体" },
  busy: { why: "上一个查询还没结束", next: "等上一个查询结束后再查" },
} as const satisfies Record<string, FailureAdvice>;
export class KnowledgeQueryError extends Error {
  readonly code: keyof typeof KNOWLEDGE_ADVICE;
  readonly advice: FailureAdvice;
  constructor(code: KnowledgeQueryError["code"], detail?: string) {
    super(detail ? `知识查询被拒绝：${code}：${detail}` : `知识查询被拒绝：${code}`);
    this.name = "KnowledgeQueryError";
    this.code = code;
    this.advice = withDetail(KNOWLEDGE_ADVICE[code], detail);
  }
}

export function isKnowledgePath(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 4096 || /^[A-Za-z]:/u.test(value)
    || /[\u0000-\u001f\u007f]/u.test(value)) return false;
  try { return indexPathScope(value) === "index"; } catch { return false; }
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
