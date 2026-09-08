import { mkdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { withDirLock, writeFileAtomic } from "./store.ts";

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
  toolCallId: string;
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

export type WriteResult = { saved: true; path: string } | { saved: false; reason: string };
export type ReadResult = { readable: true; details: ErrorDetailsDocument } | { readable: false; reason: string };
export interface ErrorDetailsSummary {
  saved: boolean;
  path: string;
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
      ...prior,
      duplicateEvents: Math.max(prior.duplicateEvents, attempt.duplicateEvents),
      conflictingEvents: Math.max(prior.conflictingEvents, attempt.conflictingEvents),
    };
  }
  return {
    attemptCount: Math.max(existing.attemptCount, incoming.attemptCount, attempts.length),
    validCount: Math.max(existing.validCount, incoming.validCount),
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
  return {
    attemptCount: submissions.attemptCount,
    validCount: submissions.validCount,
    attempts: submissions.attempts.map(sanitizeAttempt),
  };
}

function errorDetailsPath(runDir: string): string {
  return join(runDir, "error-details.json");
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function atomicWrite(path: string, content: string): Promise<WriteResult> {
  try {
    await writeFileAtomic(path, content);
    return { saved: true, path };
  } catch (error) {
    return { saved: false, reason: (error as Error).message };
  }
}

async function writeErrorDetailsLocked(runDir: string, input: WriteErrorDetailsInput): Promise<WriteResult> {
  const path = errorDetailsPath(runDir);

  if (await fileExists(path)) {
    const existing = await readErrorDetails(runDir);
    if (!existing.readable) {
      const label = existing.reason.startsWith("无法读取") ? "旧文件无法读取" : "旧文件已损坏";
      return { saved: false, reason: `${label}，拒绝覆盖: ${existing.reason}` };
    }
    const cleanup = existing.details.cleanup.slice();
    if (input.cleanupError !== undefined) {
      const cleanupDetail = extractErrorDetail(input.cleanupError);
      const key = cleanupDedupeKey(cleanupDetail);
      if (!cleanup.some((entry) => cleanupDedupeKey(entry) === key)) cleanup.push(cleanupDetail);
    }
    const submissions = mergeSubmissions(existing.details.submissions, input.submissions);

    const document: ErrorDetailsDocument = {
      version: 1,
      runId: existing.details.runId,
      model: existing.details.model,
      failedAt: existing.details.failedAt,
      original: existing.details.original,
      cleanup,
      submissions,
    };
    return atomicWrite(path, `${JSON.stringify(document, null, 2)}\n`);
  }

  const cleanup: ErrorDetail[] = [];
  if (input.cleanupError !== undefined) cleanup.push(extractErrorDetail(input.cleanupError));

  const document: ErrorDetailsDocument = {
    version: 1,
    runId: input.runId,
    model: input.model,
    failedAt: new Date().toISOString(),
    original: extractErrorDetail(input.error),
    cleanup,
    submissions: sanitizeSubmissions(input.submissions ?? { attemptCount: 0, validCount: 0, attempts: [] }),
  };
  return atomicWrite(path, `${JSON.stringify(document, null, 2)}\n`);
}

export async function writeErrorDetails(runDir: string, input: WriteErrorDetailsInput): Promise<WriteResult> {
  try {
    await mkdir(runDir, { recursive: true, mode: 0o700 });
    return await withDirLock(runDir, () => writeErrorDetailsLocked(runDir, input));
  } catch (error) {
    return { saved: false, reason: (error as Error).message };
  }
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
    if (typeof a.toolCallId !== "string") return false;
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

export async function readErrorDetails(runDir: string): Promise<ReadResult> {
  let raw: string;
  try {
    raw = await readFile(errorDetailsPath(runDir), "utf8");
  } catch (error) {
    return { readable: false, reason: `无法读取: ${(error as Error).message}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { readable: false, reason: `JSON 解析失败: ${(error as Error).message}` };
  }
  const validation = validateDocument(parsed);
  if (!validation.ok) return { readable: false, reason: validation.reason };
  return { readable: true, details: validation.details };
}

function truncateHeadline(text: string, maxLength: number): string {
  let result = "";
  for (const char of text) {
    if (result.length + char.length > maxLength) break;
    result += char;
  }
  return result;
}

export async function summarizeErrorDetails(runDir: string): Promise<ErrorDetailsSummary> {
  const path = errorDetailsPath(runDir);
  const result = await readErrorDetails(runDir);
  if (!result.readable) return { saved: false, path, headline: "", reason: result.reason };

  const firstLine = result.details.original.message.split("\n")[0] ?? "";
  const headline = truncateHeadline(firstLine, HEADLINE_MAX_LENGTH);
  return { saved: true, path, headline };
}
