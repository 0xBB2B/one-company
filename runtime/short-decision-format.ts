import { Type } from "typebox";
import type { Static } from "typebox";
import { Value } from "typebox/value";
import { createHash } from "node:crypto";
import { object, positive, counter, ProdReference } from "./requirement-contracts.ts";
import { UUID_V7_PATTERN } from "./database.ts";
import { canonicalJson, parseStrictJson } from "./strict-json.ts";

export const SHORT_DECISION_LIMITS = Object.freeze({ textCodePoints: 400, references: 16, referenceLength: 128, batch: 20, requestBytes: 65_536 });
const id = Type.String({ pattern: UUID_V7_PATTERN.source, minLength: 36, maxLength: 36 });
const hash = Type.String({ pattern: "^[0-9a-f]{64}$", minLength: 64, maxLength: 64 });
const text = Type.String({ minLength: 1 });
const refs = Type.Array(Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}(?![\\s\\S])" }), { maxItems: 16, uniqueItems: true });
const nullableId = Type.Union([id, Type.Null()]);
export const DecisionItem = object({
  conclusion: text, scope: text, references: refs,
  supersedes: Type.Array(id, { maxItems: 16, uniqueItems: true }),
});
export const DecisionBatch = object({
  operationId: id, requirementId: id, version: positive, epoch: positive,
  prod: Type.Union([ProdReference, Type.Null()]),
  decisions: Type.Array(DecisionItem, { minItems: 1, maxItems: 20 }),
});
export type DecisionBatch = Static<typeof DecisionBatch>;
export const DecisionSubject = object({
  actor: Type.Union([Type.Literal("user"), Type.Literal("ai")]),
  status: Type.Union([Type.Literal("confirmed"), Type.Literal("pending")]),
  basisReceiptId: nullableId,
});
export type DecisionSubject = Static<typeof DecisionSubject>;
export const DecisionAdmission = object({ requestHash: hash, subjects: Type.Array(DecisionSubject, { minItems: 1, maxItems: 20 }) });
export type DecisionAdmission = Static<typeof DecisionAdmission>;
export const ShortDecisionRecord = object({
  format: Type.Literal("short-decision/v1"), decisionId: id, operationId: id, requirementId: id, repoId: hash,
  requirementVersion: positive, epoch: positive, prod: Type.Union([ProdReference, Type.Null()]),
  conclusion: text, scope: text, references: refs, supersedes: Type.Array(id, { maxItems: 16, uniqueItems: true }),
  actor: Type.Union([Type.Literal("user"), Type.Literal("ai")]),
  status: Type.Union([Type.Literal("confirmed"), Type.Literal("pending"), Type.Literal("superseded")]),
  basisReceiptId: nullableId, supersededBy: nullableId, recordedAt: counter,
});
export type ShortDecisionRecord = Static<typeof ShortDecisionRecord>;

export class ShortDecisionError extends Error {
  readonly code: string;
  constructor(code: string) { super(`短决策操作被拒绝：${code}`); this.name = "ShortDecisionError"; this.code = code; }
}

export function decisionDigest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value as Parameters<typeof canonicalJson>[0])).digest("hex");
}
function checkText(value: string): void {
  if (!value.trim() || Array.from(value).length > SHORT_DECISION_LIMITS.textCodePoints) throw new ShortDecisionError("text_limit");
}
function checkItem(item: Static<typeof DecisionItem>, prod: DecisionBatch["prod"]): void {
  checkText(item.conclusion); checkText(item.scope);
  if (prod && (![40, 64].includes(prod.commit.length) || prod.hash.length !== 64)) throw new ShortDecisionError("invalid_reference");
  // 提交/hash及修订目标也是引用；需求和操作身份字段不计入业务引用限额。
  if (item.references.length + item.supersedes.length + (prod ? 2 : 0) > SHORT_DECISION_LIMITS.references) throw new ShortDecisionError("reference_limit");
}

/** 只接收有界JSON文本，不接受文件、对象序列化钩子或任意扩展载荷。 */
export function parseDecisionBatch(source: string): DecisionBatch {
  if (typeof source !== "string" || Buffer.byteLength(source, "utf8") > SHORT_DECISION_LIMITS.requestBytes) throw new ShortDecisionError("request_limit");
  const batch = parseStrictJson(source);
  if (!Value.Check(DecisionBatch, batch)) throw new ShortDecisionError("invalid_shape");
  for (const item of batch.decisions) checkItem(item, batch.prod);
  return batch;
}

export function checkDecisionRecord(value: unknown): ShortDecisionRecord {
  if (!Value.Check(ShortDecisionRecord, value)) throw new ShortDecisionError("invalid_record");
  checkItem(value, value.prod);
  decisionDigest(value); // 同样核对存量记录的Unicode，禁止以孤立代理码点绕过解码约束。
  if ((value.status === "superseded") !== (value.supersededBy !== null) ||
    (value.status === "confirmed" && value.basisReceiptId === null)) throw new ShortDecisionError("invalid_record");
  return value;
}
