import { Type } from "typebox";
import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";
import { object, positive, counter } from "./requirement-contracts.ts";
import { UUID_V7_PATTERN } from "./database.ts";
import { DecisionItem, ShortDecisionRecord, checkDecisionRecord, parseDecisionBatch, decisionDigest, SHORT_DECISION_LIMITS } from "./short-decision-format.ts";
import { parseStrictJson } from "./strict-json.ts";
import { partitionProdDocument } from "./prod-view.ts";

const id = Type.String({ pattern: UUID_V7_PATTERN.source, minLength: 36, maxLength: 36 });
const hash = Type.String({ pattern: "^[0-9a-f]{64}$", minLength: 64, maxLength: 64 });
const ProdReference = object({ commit: Type.String({ pattern: "^(?:[0-9a-f]{40}|[0-9a-f]{64})(?![\\s\\S])" }), hash });
const nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);
const enumeration = <T extends string>(values: [T, ...T[]]) => Type.Union([Type.Literal(values[0]), ...values.slice(1).map((value) => Type.Literal(value))]);
export const InteractionAction = enumeration(["analyze", "plan", "implement", "close", "commit", "push"]);
export type InteractionAction = Static<typeof InteractionAction>;
export const InteractionBasis = object({ requirementId: id, version: positive, epoch: positive, prod: nullable(ProdReference) });
export type InteractionBasis = Static<typeof InteractionBasis>;
export const CandidateBinding = object({ candidateId: id, operationId: id, intentHash: hash, from: nullable(ProdReference), to: ProdReference });
export type CandidateBinding = Static<typeof CandidateBinding>;
export const InteractionCandidate = object({ ...CandidateBinding.properties, diff: Type.String({ minLength: 1 }) });
export const ApprovalUnitId = Type.String({ pattern: "^[A-Za-z][A-Za-z0-9._-]{0,95}(?![\\s\\S])", maxLength: 96 });
export const ApprovalUnitIds = Type.Array(ApprovalUnitId, { maxItems: 16, uniqueItems: true });
export const ApprovalPartition = object({ prodHash: hash, totalBytes: positive,
  units: Type.Array(object({ id: ApprovalUnitId, hash, startByte: counter, endByte: positive }), { minItems: 1, maxItems: 20 }) });
export const DocumentAnalysis = object({ candidate: CandidateBinding, title: Type.String(), body: Type.String(), partition: ApprovalPartition });
export type DocumentAnalysis = Static<typeof DocumentAnalysis>;
const ConclusionIndexes = Type.Array(Type.Integer({ minimum: 0, maximum: 19 }), { minItems: 1, maxItems: 16, uniqueItems: true });
export const UnitReview = object({ id: ApprovalUnitId,
  disposition: enumeration(["confirmed", "pending-description", "excluded"]), globalConstraint: Type.Boolean(),
  appliesTo: ApprovalUnitIds, dependsOn: ApprovalUnitIds, conclusionIndexes: ConclusionIndexes });
export const ActionReview = object({ action: InteractionAction, goalIds: ApprovalUnitIds, constraintIds: ApprovalUnitIds,
  conclusionIndexes: ConclusionIndexes, unknown: Type.Boolean() });
export const DocumentReview = object({ faithful: Type.Boolean(),
  units: Type.Array(UnitReview, { minItems: 1, maxItems: 20 }),
  actions: Type.Array(ActionReview, { maxItems: 20 }),
  questions: Type.Array(object({ requestId: id, answeredIds: ApprovalUnitIds, pendingIds: ApprovalUnitIds,
    conclusionIndexes: Type.Array(Type.Integer({ minimum: 0, maximum: 19 }), { maxItems: 16, uniqueItems: true }) }), { maxItems: 20 }) });
export type DocumentReview = Static<typeof DocumentReview>;
export const PendingQuestion = object({
  format: Type.Literal("interaction-question/v1"), requestId: id, repoId: hash, basis: InteractionBasis,
  candidate: nullable(CandidateBinding), proposal: DecisionItem,
  actions: Type.Array(InteractionAction, { maxItems: 6, uniqueItems: true }), createdAt: counter,
  unitIds: Type.Optional(ApprovalUnitIds),
});
export type PendingQuestion = Static<typeof PendingQuestion>;
export const InteractionContext = object({
  basis: InteractionBasis, currentGoal: Type.String(),
  candidates: Type.Array(InteractionCandidate, { maxItems: 20 }),
  questions: Type.Array(PendingQuestion, { maxItems: 20 }),
  priorDecisions: Type.Array(ShortDecisionRecord, { maxItems: 20 }),
  document: Type.Optional(DocumentAnalysis),
});
export type InteractionContext = Static<typeof InteractionContext>;
export const InteractionEntry = object({
  kind: enumeration(["target", "constraint", "exclusion", "future", "delegation", "action", "unresolved", "suggestion", "ai-choice"]),
  basis: enumeration(["explicit", "delegated", "proposed", "uncertain"]),
  resolution: enumeration(["direct", "accept", "modify", "defer", "unclear"]),
  candidateId: nullable(id), requestId: nullable(id),
  actions: Type.Array(InteractionAction, { maxItems: 6, uniqueItems: true }),
  ...DecisionItem.properties,
});
export type InteractionEntry = Static<typeof InteractionEntry>;
export const InteractionInterpretation = object({
  format: Type.Literal("interaction-interpretation/v1"),
  referenceResolution: enumeration(["explicit", "single-question", "ambiguous", "none"]),
  entries: Type.Array(InteractionEntry, { minItems: 1, maxItems: 20 }),
  documentReview: Type.Optional(DocumentReview),
});
export type InteractionInterpretation = Static<typeof InteractionInterpretation>;

export class UserInteractionError extends Error {
  readonly code: string;
  constructor(code: string) { super(`用户交互被拒绝：${code}`); this.name = "UserInteractionError"; this.code = code; }
}
export function parseInteraction<T extends TSchema>(schema: T, source: string): Static<T> {
  if (typeof source !== "string" || Buffer.byteLength(source) > SHORT_DECISION_LIMITS.requestBytes) throw new UserInteractionError("request_limit");
  const value = parseStrictJson(source);
  if (!Value.Check(schema, value)) throw new UserInteractionError("invalid_shape");
  return value as Static<T>;
}
export function checkInteraction<T extends TSchema>(schema: T, value: unknown): Static<T> {
  let copy: unknown;
  try { copy = structuredClone(value); } catch { throw new UserInteractionError("invalid_shape"); }
  return parseInteraction(schema, JSON.stringify(copy));
}
export function checkProposal(item: Static<typeof DecisionItem>, basis: InteractionBasis): void {
  parseDecisionBatch(JSON.stringify({ ...basis, operationId: basis.requirementId, decisions: [item] }));
}
export function checkContext(value: unknown): InteractionContext {
  const context = checkInteraction(InteractionContext, value);
  if (new Set(context.candidates.map((c) => c.candidateId)).size !== context.candidates.length ||
    new Set(context.questions.map((q) => q.requestId)).size !== context.questions.length) throw new UserInteractionError("duplicate_reference");
  if (new Set(context.candidates.map((c) => c.to.hash)).size !== context.candidates.length) throw new UserInteractionError("duplicate_document_candidate");
  for (const c of context.candidates) if (decisionDigest(c.from) !== decisionDigest(context.basis.prod)) throw new UserInteractionError("candidate_baseline_mismatch");
  if (context.document) {
    const doc = context.document;
    if (context.candidates.length !== 1 || decisionDigest(candidateBinding(context.candidates[0]!)) !== decisionDigest(doc.candidate)) throw new UserInteractionError("document_candidate_mismatch");
    const partition = partitionProdDocument(context.basis.requirementId, doc.title, doc.body);
    if (partition.prodHash !== doc.candidate.to.hash || decisionDigest(partition) !== decisionDigest(doc.partition)) throw new UserInteractionError("document_partition_mismatch");
    for (const q of context.questions) if (!q.unitIds?.length || q.unitIds.some((unitId) => !partition.units.some((u) => u.id === unitId))) throw new UserInteractionError("question_unit_mismatch");
  }
  for (const old of context.priorDecisions) {
    checkDecisionRecord(old);
    if (old.requirementId !== context.basis.requirementId) throw new UserInteractionError("foreign_decision");
  }
  for (const q of context.questions) {
    if (decisionDigest(q.basis) !== decisionDigest(context.basis)) throw new UserInteractionError("question_baseline_mismatch");
    checkProposal(q.proposal, q.basis);
  }
  return context;
}
export function candidateBinding(candidate: Static<typeof InteractionCandidate>): CandidateBinding {
  const { diff: _diff, ...binding } = candidate;
  return binding;
}
/** 结构与范围一致性检查不证明自然语言理解正确；不使用关键词判断用户意图。 */
export function checkInterpretation(source: string, context: InteractionContext): InteractionInterpretation {
  const result = parseInteraction(InteractionInterpretation, source);
  if (Boolean(result.documentReview) !== Boolean(context.document)) throw new UserInteractionError("document_review_required");
  if (result.referenceResolution === "single-question" && context.questions.length !== 1) throw new UserInteractionError("ambiguous_reference");
  for (const entry of result.entries) {
    checkProposal({ conclusion: entry.conclusion, scope: entry.scope, references: entry.references, supersedes: entry.supersedes }, context.basis);
    const candidate = context.candidates.find((c) => c.candidateId === entry.candidateId);
    const question = context.questions.find((q) => q.requestId === entry.requestId);
    if (entry.supersedes.some((oldId) => !context.priorDecisions.some((old) => old.decisionId === oldId && old.status !== "superseded"))) throw new UserInteractionError("unknown_supersedes");
    if (entry.candidateId !== null && !candidate || entry.requestId !== null && !question) throw new UserInteractionError("unknown_reference");
    if (question?.candidate && (!candidate || decisionDigest(question.candidate) !== decisionDigest(candidateBinding(candidate)))) throw new UserInteractionError("question_candidate_mismatch");
    if (entry.resolution === "accept" && !question) throw new UserInteractionError("question_required");
    if (question && entry.actions.some((action) => !question.actions.includes(action))) throw new UserInteractionError("question_action_mismatch");
    if (!context.document && result.referenceResolution === "single-question" && ["explicit", "delegated"].includes(entry.basis) &&
      !["modify", "defer", "unclear"].includes(entry.resolution) &&
      (entry.requestId !== context.questions[0]!.requestId || entry.resolution !== "accept")) throw new UserInteractionError("single_question_scope_escape");
    if (entry.actions.length > 0 && entry.kind !== "action") throw new UserInteractionError("action_kind_required");
    if (entry.kind === "action" && (entry.actions.length === 0 || !candidate)) throw new UserInteractionError("action_candidate_required");
    if (entry.basis === "delegated" && entry.kind !== "ai-choice") throw new UserInteractionError("delegation_kind_required");
    if (entry.kind === "ai-choice" && entry.basis !== "delegated" && entry.basis !== "proposed") throw new UserInteractionError("ai_subject_required");
    if (["future", "unresolved", "suggestion"].includes(entry.kind) && !["proposed", "uncertain"].includes(entry.basis)) throw new UserInteractionError("pending_basis_required");
    if (result.referenceResolution === "ambiguous" && entry.requestId !== null && entry.basis === "explicit") throw new UserInteractionError("ambiguous_reference");
  }
  return result;
}
