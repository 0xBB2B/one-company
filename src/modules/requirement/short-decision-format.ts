import { Type } from "typebox";
import { adviceIn } from "../../core/exec/tool-failure.ts";
import type { FailureAdvice } from "../../core/exec/tool-failure.ts";
import type { Static } from "typebox";
import { Value } from "typebox/value";
import { createHash } from "node:crypto";
import { object, positive, counter, PrdReference } from "./requirement-contracts.ts";
import { UUID_V7_PATTERN } from "../../core/storage/database.ts";
import { canonicalJson, parseStrictJson } from "../../core/storage/strict-json.ts";

export const SHORT_DECISION_LIMITS = Object.freeze({ textCodePoints: 400, requestBytes: 65_536 });
const id = Type.String({ pattern: UUID_V7_PATTERN.source, minLength: 36, maxLength: 36 });
const hash = Type.String({ pattern: "^[0-9a-f]{64}$", minLength: 64, maxLength: 64 });
const text = Type.String({ minLength: 1 });
const refs = Type.Array(Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}(?![\\s\\S])" }), { uniqueItems: true });
const nullableId = Type.Union([id, Type.Null()]);
export const DecisionItem = object({
  conclusion: text, scope: text, references: refs,
  supersedes: Type.Array(id, { maxItems: 16, uniqueItems: true }),
});
export const DecisionBatch = object({
  operationId: id, requirementId: id, version: positive, epoch: positive,
  prd: Type.Union([PrdReference, Type.Null()]),
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
  requirementVersion: positive, epoch: positive, prd: Type.Union([PrdReference, Type.Null()]),
  conclusion: text, scope: text, references: refs, supersedes: Type.Array(id, { maxItems: 16, uniqueItems: true }),
  actor: Type.Union([Type.Literal("user"), Type.Literal("ai")]),
  status: Type.Union([Type.Literal("confirmed"), Type.Literal("pending"), Type.Literal("superseded")]),
  basisReceiptId: nullableId, supersededBy: nullableId, recordedAt: counter,
});
export type ShortDecisionRecord = Static<typeof ShortDecisionRecord>;

const SHORT_DECISION_ADVICE: Record<string, FailureAdvice> = {
  admission_changed: { why: "确认登记后又有变化", next: "请用户重新确认" },
  admission_mismatch: { why: "确认登记与本次决定不对应", next: "重新读取需求后按最新版本再试" },
  authorization_required: { why: "宿主没有授权这次决定登记", next: "停止操作，不要重试；把这段原因告诉用户" },
  decision_identity_conflict: { why: "决定编号与记录不一致", next: "重新读取需求后按最新版本再试" },
  epoch_changed: { why: "需求已换代（epoch 变化）", next: "重新读取需求后按最新版本再试" },
  invalid_record: { why: "决定记录不合规", next: "停止操作，不要重试；把这段原因告诉用户" },
  invalid_reference: { why: "决定引用的格式不对", next: "按待裁决事项给出的引用原样登记" },
  invalid_shape: { why: "决定内容的格式不合规", next: "按原因改正后重试" },
  lifecycle_denied: { why: "需求不在草稿或活动状态，或需要先恢复核对", next: "重新读取需求后按最新版本再试" },
  operation_conflict: { why: "同一操作编号已用于内容不同的请求", next: "换一个新生成的操作编号重试" },
  prd_reference_changed: { why: "决定所基于的需求版本已变化", next: "重新读取需求后按最新版本再试" },
  request_limit: { why: "请求内容超出大小上限", next: "精简内容后重试" },
  supersede_denied: { why: "这个决定不能被取代（状态不允许）", next: "重新读取需求后按最新版本再试" },
  text_limit: { why: "文字超出长度上限", next: "精简文字后重试" },
  trusted_admission_required: { why: "登记决定需要宿主确认用户原话", next: "等用户在主窗口说出新的一句话后再操作" },
  unknown_decision: { why: "找不到这个决定", next: "核对决定编号" },
  unknown_requirement: { why: "找不到这个需求", next: "核对需求编号" },
};
export class ShortDecisionError extends Error {
  readonly code: string;
  readonly advice: FailureAdvice;
  constructor(code: string) { super(`短决策操作被拒绝：${code}`); this.name = "ShortDecisionError"; this.code = code; this.advice = adviceIn(SHORT_DECISION_ADVICE, code); }
}

export function decisionDigest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value as Parameters<typeof canonicalJson>[0])).digest("hex");
}
function checkText(value: string): void {
  if (!value.trim() || Array.from(value).length > SHORT_DECISION_LIMITS.textCodePoints) throw new ShortDecisionError("text_limit");
}
function checkItem(item: Static<typeof DecisionItem>, prd: DecisionBatch["prd"]): void {
  checkText(item.conclusion); checkText(item.scope);
  if (prd && (![40, 64].includes(prd.commit.length) || prd.hash.length !== 64)) throw new ShortDecisionError("invalid_reference");
}

/** 只接收有界JSON文本，不接受文件、对象序列化钩子或任意扩展载荷。 */
export function parseDecisionBatch(source: string): DecisionBatch {
  if (typeof source !== "string" || Buffer.byteLength(source, "utf8") > SHORT_DECISION_LIMITS.requestBytes) throw new ShortDecisionError("request_limit");
  const batch = parseStrictJson(source);
  if (!Value.Check(DecisionBatch, batch)) throw new ShortDecisionError("invalid_shape");
  for (const item of batch.decisions) checkItem(item, batch.prd);
  return batch;
}

export function checkDecisionRecord(value: unknown): ShortDecisionRecord {
  if (!Value.Check(ShortDecisionRecord, value)) throw new ShortDecisionError("invalid_record");
  checkItem(value, value.prd);
  decisionDigest(value); // 同样核对存量记录的Unicode，禁止以孤立代理码点绕过解码约束。
  if ((value.status === "superseded") !== (value.supersededBy !== null) ||
    (value.status === "confirmed" && value.basisReceiptId === null)) throw new ShortDecisionError("invalid_record");
  return value;
}
