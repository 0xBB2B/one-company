import { repositoryDatabase, readRecord, withDatabase } from "./database.ts";

export interface ErrorFields {
  code?: string;
  status?: number;
  requestId?: string;
}

export interface ErrorDetail {
  message: string;
  name?: string;
  stack?: string;
  cause?: ErrorDetail;
  fields: ErrorFields;
  noAdditionalCause?: true;
  causeCycle?: true;
}

export interface SubmissionAttempt {
  toolCallId?: string;
  valid: boolean;
  accepted: boolean;
  error: string | null;
  duplicateEvents: number;
  conflictingEvents: number;
}

export interface Submissions {
  attemptCount: number;
  validCount: number;
  attempts: SubmissionAttempt[];
}

export interface ErrorDetailsDocument {
  version: 1;
  runId: string;
  model: { provider: string; id: string };
  failedAt: string;
  original: ErrorDetail;
  cleanup: ErrorDetail[];
  submissions: Submissions;
}

export interface WriteErrorDetailsInput {
  runId: string;
  model: { provider: string; id: string };
  error: unknown;
  cleanupError?: unknown;
  submissions?: Submissions;
}

export type WriteResult = { saved: true; recordId: string } | { saved: false; reason: string };
export type ReadResult = { readable: true; details: ErrorDetailsDocument } | { readable: false; reason: string };
export interface ErrorDetailsSummary {
  saved: boolean;
  recordId?: string;
  headline: string;
  reason?: string;
}

const HEADLINE_MAX_LENGTH = 120;

function safeGet(record: Record<string, unknown>, key: string): unknown {
  try {
    return record[key];
  } catch {
    return undefined;
  }
}

function toMessage(value: unknown): string {
  if (value instanceof Error) {
    const message = safeGet(value as unknown as Record<string, unknown>, "message");
    return typeof message === "string" ? message : "";
  }
  if (typeof value === "string") return value;
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  try {
    return String(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

function mergeSubmissions(existing: Submissions, incoming: Submissions | undefined): Submissions {
  if (!incoming) return existing;
  const attempts = existing.attempts.slice();
  for (const attempt of incoming.attempts.map(sanitizeAttempt)) {
    const index = attempt.toolCallId === undefined ? -1 : attempts.findIndex((prior) => prior.toolCallId === attempt.toolCallId);
    if (index === -1) {
      attempts.push(attempt);
      continue;
    }
    const prior = attempts[index]!;
    attempts[index] = {
      ...attempt,
      error: prior.error ?? attempt.error,
      duplicateEvents: Math.max(prior.duplicateEvents, attempt.duplicateEvents),
      conflictingEvents: Math.max(prior.conflictingEvents, attempt.conflictingEvents),
    };
  }
  return {
    attemptCount: Math.max(existing.attemptCount, incoming.attemptCount, attempts.length),
    validCount: Math.max(existing.validCount, incoming.validCount, attempts.filter((a) => a.valid).length),
    attempts,
  };
}

function normalizeCode(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function normalizeStatus(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

function normalizeRequestId(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function extractFields(source: Record<string, unknown>): ErrorFields {
  const fields: ErrorFields = {};
  const code = normalizeCode(safeGet(source, "code"));
  if (code !== undefined) fields.code = code;
  const status = normalizeStatus(safeGet(source, "status") ?? safeGet(source, "statusCode"));
  if (status !== undefined) fields.status = status;
  const requestId = normalizeRequestId(safeGet(source, "requestId") ?? safeGet(source, "request_id"));
  if (requestId !== undefined) fields.requestId = requestId;
  return fields;
}

function buildDetail(error: unknown, visited: Set<unknown>): ErrorDetail {
  visited.add(error);
  const isObjectLike = typeof error === "object" && error !== null;
  const record = isObjectLike ? (error as Record<string, unknown>) : undefined;
  const name = record ? safeGet(record, "name") : undefined;
  const stack = record ? safeGet(record, "stack") : undefined;
  const fields = record ? extractFields(record) : {};
  const rawCause = record ? safeGet(record, "cause") : undefined;

  const detail: ErrorDetail = { message: toMessage(error), fields };
  if (typeof name === "string") detail.name = name;
  if (typeof stack === "string") detail.stack = stack;
  if (rawCause === undefined) {
    detail.noAdditionalCause = true;
  } else if (visited.has(rawCause)) {
    detail.causeCycle = true;
  } else {
    detail.cause = buildDetail(rawCause, visited);
  }
  return detail;
}

export function extractErrorDetail(error: unknown): ErrorDetail {
  return buildDetail(error, new Set());
}

function cleanupDedupeKey(detail: ErrorDetail): string {
  return `${detail.name ?? ""} ${detail.message}`;
}

function sanitizeAttempt(attempt: SubmissionAttempt): SubmissionAttempt {
  return {
    toolCallId: attempt.toolCallId,
    valid: attempt.valid,
    accepted: attempt.accepted,
    error: attempt.error,
    duplicateEvents: attempt.duplicateEvents,
    conflictingEvents: attempt.conflictingEvents,
  };
}

function sanitizeSubmissions(submissions: Submissions): Submissions {
  const attempts = submissions.attempts.map(sanitizeAttempt);
  return {
    attemptCount: Math.max(submissions.attemptCount, attempts.length),
    validCount: Math.max(submissions.validCount, attempts.filter((a) => a.valid).length),
    attempts,
  };
}

export interface ErrorDetailsRef { dataRoot: string; repoId: string; runId: string }

function errorDetailsRef(ref: ErrorDetailsRef) {
  return { database: repositoryDatabase(ref.dataRoot, ref.repoId), namespace: "error_details", key: ref.runId };
}

export async function writeErrorDetails(ref: ErrorDetailsRef, input: WriteErrorDetailsInput): Promise<WriteResult> {
  try {
    if (ref.runId !== input.runId) throw new Error("错误详情的运行归属不一致");
    const address = errorDetailsRef(ref);
    return withDatabase(address.database, (db) => db.transaction(() => {
      const stored = db.read<ErrorDetailsDocument>(address.namespace, address.key);
      if (stored) {
        const validation = validateDocument(stored.data);
        if (!validation.ok) throw new Error(`旧记录损坏，拒绝覆盖: ${validation.reason}`);
      }
      const cleanup = stored?.data.cleanup.slice() ?? [];
      if (input.cleanupError !== undefined) {
        const detail = extractErrorDetail(input.cleanupError);
        if (!cleanup.some((entry) => cleanupDedupeKey(entry) === cleanupDedupeKey(detail))) cleanup.push(detail);
      }
      const document: ErrorDetailsDocument = {
        version: 1, runId: input.runId,
        model: stored?.data.model ?? { provider: input.model.provider, id: input.model.id },
        failedAt: stored?.data.failedAt ?? new Date().toISOString(),
        original: stored?.data.original ?? extractErrorDetail(input.error),
        cleanup,
        submissions: stored ? mergeSubmissions(stored.data.submissions, input.submissions)
          : sanitizeSubmissions(input.submissions ?? { attemptCount: 0, validCount: 0, attempts: [] }),
      };
      const validation = validateDocument(document);
      if (!validation.ok) throw new Error(`写入前自检失败: ${validation.reason}`);
      if (stored) { db.update(address.namespace, address.key, stored.version, document); return { saved: true, recordId: stored.id }; }
      return { saved: true, recordId: db.create(address.namespace, address.key, document).id };
    }));
  } catch (error) { return { saved: false, reason: (error as Error).message }; }
}

function isErrorDetailShape(value: unknown): value is ErrorDetail {
  if (value === null || typeof value !== "object") return false;
  const detail = value as Record<string, unknown>;
  if (typeof detail.message !== "string") return false;
  if (detail.name !== undefined && typeof detail.name !== "string") return false;
  if (detail.stack !== undefined && typeof detail.stack !== "string") return false;
  if (detail.cause !== undefined && !isErrorDetailShape(detail.cause)) return false;
  if (detail.fields === undefined || typeof detail.fields !== "object" || detail.fields === null) return false;
  const fields = detail.fields as Record<string, unknown>;
  if (fields.code !== undefined && typeof fields.code !== "string") return false;
  if (fields.status !== undefined && typeof fields.status !== "number") return false;
  if (fields.requestId !== undefined && typeof fields.requestId !== "string") return false;
  return true;
}

function isSubmissionsShape(value: unknown): value is Submissions {
  if (value === null || typeof value !== "object") return false;
  const submissions = value as Record<string, unknown>;
  if (typeof submissions.attemptCount !== "number" || submissions.attemptCount < 0) return false;
  if (typeof submissions.validCount !== "number" || submissions.validCount < 0) return false;
  if (submissions.attemptCount < submissions.validCount) return false;
  if (!Array.isArray(submissions.attempts)) return false;
  return submissions.attempts.every((attempt) => {
    if (attempt === null || typeof attempt !== "object") return false;
    const a = attempt as Record<string, unknown>;
    if (a.toolCallId !== undefined && typeof a.toolCallId !== "string") return false;
    if (typeof a.valid !== "boolean") return false;
    if (typeof a.accepted !== "boolean") return false;
    if (a.error !== null && typeof a.error !== "string") return false;
    if (typeof a.duplicateEvents !== "number") return false;
    if (typeof a.conflictingEvents !== "number") return false;
    return true;
  });
}

function validateDocument(value: unknown): { ok: true; details: ErrorDetailsDocument } | { ok: false; reason: string } {
  if (value === null || typeof value !== "object") return { ok: false, reason: "文档不是对象" };
  const doc = value as Record<string, unknown>;
  if (doc.version !== 1) return { ok: false, reason: "version 字段非法" };
  if (typeof doc.runId !== "string") return { ok: false, reason: "runId 字段非法" };
  const model = doc.model as Record<string, unknown> | undefined;
  if (!model || typeof model.provider !== "string" || typeof model.id !== "string") {
    return { ok: false, reason: "model 字段非法" };
  }
  if (typeof doc.failedAt !== "string") return { ok: false, reason: "failedAt 字段非法" };
  if (!isErrorDetailShape(doc.original)) return { ok: false, reason: "original 字段非法" };
  if (!Array.isArray(doc.cleanup) || !doc.cleanup.every(isErrorDetailShape)) {
    return { ok: false, reason: "cleanup 字段非法" };
  }
  if (!isSubmissionsShape(doc.submissions)) return { ok: false, reason: "submissions 字段非法" };
  return { ok: true, details: doc as unknown as ErrorDetailsDocument };
}

export async function readErrorDetails(ref: ErrorDetailsRef): Promise<ReadResult> {
  try {
    const record = readRecord(errorDetailsRef(ref));
    if (!record.exists) return { readable: false, reason: "错误详情不存在" };
    const validation = validateDocument(record.data);
    if (!validation.ok) return { readable: false, reason: validation.reason };
    return { readable: true, details: validation.details };
  } catch (error) { return { readable: false, reason: `无法读取: ${(error as Error).message}` }; }
}

function truncateHeadline(text: string, maxLength: number): string {
  let result = "";
  for (const char of text) {
    if (result.length + char.length > maxLength) break;
    result += char;
  }
  return result;
}

export async function summarizeErrorDetails(ref: ErrorDetailsRef): Promise<ErrorDetailsSummary> {
  const result = await readErrorDetails(ref);
  if (!result.readable) return { saved: false, headline: "", reason: result.reason };
  const record = readRecord(errorDetailsRef(ref));
  const firstLine = result.details.original.message.split("\n")[0] ?? "";
  return { saved: true, recordId: record.exists ? record.id : undefined, headline: truncateHeadline(firstLine, HEADLINE_MAX_LENGTH) };
}
