import { Type } from "typebox";
import { adviceIn } from "./tool-failure.ts";
import type { FailureAdvice } from "./tool-failure.ts";
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
export const InteractionAction = enumeration(["analyze", "plan", "implement", "commit", "push"]);
export type InteractionAction = Static<typeof InteractionAction>;
export const InteractionBasis = object({ requirementId: id, version: positive, epoch: positive, prod: nullable(ProdReference) });
export type InteractionBasis = Static<typeof InteractionBasis>;
export const CandidateBinding = object({ candidateId: id, operationId: id, intentHash: hash, from: nullable(ProdReference), to: ProdReference });
export type CandidateBinding = Static<typeof CandidateBinding>;
export const InteractionCandidate = object({ ...CandidateBinding.properties, diff: Type.String({ minLength: 1 }) });
export const ApprovalUnitId = Type.String({ pattern: "^[A-Za-z][A-Za-z0-9._-]{0,95}$", maxLength: 96 });
export const ApprovalUnitIds = Type.Array(ApprovalUnitId, { maxItems: 16, uniqueItems: true });
export const ApprovalPartition = object({ prodHash: hash, totalBytes: positive,
  units: Type.Array(object({ id: ApprovalUnitId, hash, startByte: counter, endByte: positive }), { minItems: 1, maxItems: 20 }) });
export const DocumentAnalysis = object({ candidate: CandidateBinding, title: Type.String(), body: Type.String(), partition: ApprovalPartition });
export type DocumentAnalysis = Static<typeof DocumentAnalysis>;
export const ContinuityRecordRef = object({ id, version: positive, hash });
export const RetainedUnitEvidence = object({ fact: ContinuityRecordRef, decision: ContinuityRecordRef,
  sourceBasis: InteractionBasis, sourceBinding: CandidateBinding, unitId: ApprovalUnitId, unitHash: hash,
  kind: enumeration(["target", "constraint", "exclusion"]) });
export type RetainedUnitEvidence = Static<typeof RetainedUnitEvidence>;
export const ContinuityIssue = object({ fact: ContinuityRecordRef, originDecision: ContinuityRecordRef, decision: ContinuityRecordRef,
  questionRefs: Type.Array(object({ requestId: id, hash }), { maxItems: 20 }),
  unitId: ApprovalUnitId, unitHash: hash, targetHash: nullable(hash),
  affectedUnitIds: Type.Array(ApprovalUnitId, { maxItems: 20, uniqueItems: true }),
  reason: enumeration(["modify", "pending"]) });
export type ContinuityIssue = Static<typeof ContinuityIssue>;
export const RevisionSource = object({ fact: ContinuityRecordRef, decision: ContinuityRecordRef, sourceBasis: InteractionBasis,
  unitIds: Type.Array(object({ id: ApprovalUnitId, hash }), { maxItems: 20 }),
  kind: enumeration(["target", "constraint", "exclusion", "future", "delegation", "action", "unresolved", "suggestion", "ai-choice"]) });
export type RevisionSource = Static<typeof RevisionSource>;
export const EffectiveQuestion = object({ requestId: id, originalHash: hash, remainingUnitIds: ApprovalUnitIds,
  currentBinding: CandidateBinding, mode: enumeration(["unchanged", "requires-explicit-review"]),
  resolutions: Type.Array(ContinuityRecordRef, { maxItems: 128 }),
  unitMappings: Type.Array(object({ id: ApprovalUnitId, sourceHash: hash, targetHash: nullable(hash) }), { maxItems: 16 }) });
export type EffectiveQuestion = Static<typeof EffectiveQuestion>;
const ConclusionIndexes = Type.Array(Type.Integer({ minimum: 0, maximum: 19 }), { minItems: 1, maxItems: 16, uniqueItems: true });
export const UnitReview = object({ id: ApprovalUnitId,
  disposition: enumeration(["confirmed", "pending-description", "excluded"]), globalConstraint: Type.Boolean(),
  appliesTo: ApprovalUnitIds, dependsOn: ApprovalUnitIds, conclusionIndexes: Type.Array(Type.Integer({ minimum: 0, maximum: 19 }), { maxItems: 16, uniqueItems: true }),
  retainedFactIds: Type.Optional(Type.Array(id, { maxItems: 16, uniqueItems: true })) });
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
  partition: Type.Optional(ApprovalPartition),
});
export type PendingQuestion = Static<typeof PendingQuestion>;
/** 当前待用户裁决的事项：由宿主从持久记录生成，解释器只能引用它，不能改写。 */
export const AdjudicationSubject = object({
  itemId: Type.String({ pattern: "^(task|requirement|report):[0-9a-f-]{36}$" }), version: Type.String({ pattern: "^(task|requirement|report):[0-9a-f-]{36}:[1-9][0-9]{0,15}$" }),
  summary: Type.String({ minLength: 1, maxLength: 2000 }),
});
export type AdjudicationSubject = Static<typeof AdjudicationSubject>;
export const ADJUDICATION_CHOICES = ["retry", "adjust", "terminate", "cancel", "reject", "accept", "rework"] as const;
/** 任务事项只能再给一次机会、调整或终止；需求事项只能取消或拒绝；完成报告只能通过或返工。 */
const CHOICES_BY_SUBJECT: Readonly<Record<string, readonly string[]>> = { task: ["retry", "adjust", "terminate"], requirement: ["cancel", "reject"], report: ["accept", "rework"] };
const ADJUDICATION_PREFIXES = ["item:", "version:", "choice:", "max-turns:"];
export type AdjudicationChoice = (typeof ADJUDICATION_CHOICES)[number];
export const InteractionContext = object({
  basis: InteractionBasis, currentGoal: Type.String(),
  candidates: Type.Array(InteractionCandidate, { maxItems: 20 }),
  questions: Type.Array(PendingQuestion, { maxItems: 20 }),
  priorDecisions: Type.Array(ShortDecisionRecord, { maxItems: 20 }),
  document: Type.Optional(DocumentAnalysis),
  savedOperationId: Type.Optional(id),
  inputProof: Type.Optional(hash),
  effectiveQuestions: Type.Optional(Type.Array(EffectiveQuestion, { maxItems: 20 })),
  retainedEvidence: Type.Optional(Type.Array(RetainedUnitEvidence, { maxItems: 40 })),
  continuityIssues: Type.Optional(Type.Array(ContinuityIssue, { maxItems: 40 })),
  revisionSources: Type.Optional(Type.Array(RevisionSource, { maxItems: 20 })),
  adjudication: Type.Optional(AdjudicationSubject),
});
export type InteractionContext = Static<typeof InteractionContext>;
export const InteractionEntry = object({
  kind: enumeration(["target", "constraint", "exclusion", "future", "delegation", "action", "unresolved", "suggestion", "ai-choice", "adjudication"]),
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

const USER_INTERACTION_ADVICE: Record<string, FailureAdvice> = {
  action_candidate_required: { why: "用户原话的解读把它当成授权动作，但没有对应的待批准版本", next: "请用户把话说得更明确（说清针对哪个问题、哪个版本、要做什么）后重试" },
  action_kind_required: { why: "用户原话的解读带了授权动作，但没有标成授权类决定", next: "重试一次；仍然失败就把这段原因告诉用户" },
  adjudication_ambiguous: { why: "一句话里解读出多个裁决，无法确定用户要处理哪一个", next: "请用户把话说得更明确（说清针对哪个问题、哪个版本、要做什么）后重试" },
  adjudication_invalid: { why: "裁决类决定的解读内容不合规", next: "重试一次；仍然失败就把这段原因告诉用户" },
  adjudication_reference_reserved: { why: "非裁决的决定引用了裁决事项", next: "请用户把话说得更明确（说清针对哪个问题、哪个版本、要做什么）后重试" },
  ai_subject_required: { why: "交给 AI 选择的决定缺少\"提议\"或\"委托\"依据", next: "重试一次；仍然失败就把这段原因告诉用户" },
  ambiguous_reference: { why: "用户原话指向\"这个问题\"，但当前待回答的问题不止一个", next: "请用户把话说得更明确（说清针对哪个问题、哪个版本、要做什么）后重试" },
  authorization_required: { why: "宿主没有授权这次用户交互操作", next: "停止操作，不要重试；把这段原因告诉用户" },
  basis_changed: { why: "解读期间需求被改动", next: "重新读取需求后按最新版本再试" },
  candidate_baseline_mismatch: { why: "待批准版本不是基于当前批准版本", next: "重新读取需求后按最新版本再试" },
  candidate_not_resaved: { why: "需要先按用户的修改重新保存草稿", next: "先按用户的修改重新保存草稿，再确认" },
  candidate_not_saved: { why: "待确认的版本不是当前保存的版本", next: "重新读取需求后按最新版本再试" },
  changed_question_requires_review: { why: "问题在提出后已变化，不能直接按原问题同意", next: "把变化后的问题重新展示给用户确认" },
  continuity_changed: { why: "确认期间用户又有新的输入", next: "按用户最新的原话重新确认" },
  continuity_fact_changed: { why: "确认依据的事实记录已变化", next: "重新读取需求后按最新版本再试" },
  continuity_issue_mismatch: { why: "连续性问题引用的章节不在待确认版本里", next: "重新读取需求后按最新版本再试" },
  decision_changed: { why: "此前的决定在处理期间被改动", next: "重新读取需求后按最新版本再试" },
  delegation_kind_required: { why: "委托给 AI 的决定必须标成 AI 选择类", next: "重试一次；仍然失败就把这段原因告诉用户" },
  delegation_required: { why: "用户没有明确把这件事委托给 AI 决定", next: "请用户把话说得更明确（说清针对哪个问题、哪个版本、要做什么）后重试" },
  document_candidate_mismatch: { why: "文档复核对应的不是唯一的待批准版本", next: "重新读取需求后按最新版本再试" },
  document_partition_mismatch: { why: "文档复核的章节划分与待批准版本不一致", next: "重新读取需求后按最新版本再试" },
  document_review_required: { why: "有待批准版本时必须同时给出文档复核结论，没有时不能给", next: "重试一次；仍然失败就把这段原因告诉用户" },
  duplicate_document_candidate: { why: "同一待批准版本出现了多次", next: "重新读取需求后按最新版本再试" },
  duplicate_reference: { why: "同一个问题被重复引用", next: "重新读取需求后按最新版本再试" },
  empty_input: { why: "用户原话是空的", next: "等用户在主窗口说出新的一句话后再操作" },
  foreign_decision: { why: "引用了别的需求的决定", next: "重新读取需求后按最新版本再试" },
  foreign_requirement: { why: "上下文属于别的需求", next: "重新读取需求后按最新版本再试" },
  input_changed: { why: "处理期间用户又说了新的话", next: "按用户最新的原话重新处理" },
  input_expired: { why: "用户原话已过期", next: "等用户在主窗口说出新的一句话后再操作" },
  input_reentry: { why: "同一句用户原话被重复使用", next: "等用户在主窗口说出新的一句话后再操作" },
  interpretation_denied: { why: "用户原话的解读不能作为这次决定的依据", next: "请用户把话说得更明确（说清针对哪个问题、哪个版本、要做什么）后重试" },
  invalid_capability: { why: "确认能力无效或已用过", next: "重新读取需求后按最新版本再试" },
  invalid_input_ticket: { why: "用户原话的凭据无效或已用过", next: "等用户在主窗口说出新的一句话后再操作" },
  invalid_model_timeout: { why: "解读模型的超时设置不合规", next: "停止操作，不要重试；把这段原因告诉用户" },
  invalid_shape: { why: "参数或解读结果的格式不合规", next: "按原因改正后重试" },
  invalid_ttl: { why: "有效期设置不合规", next: "停止操作，不要重试；把这段原因告诉用户" },
  lifecycle_denied: { why: "需求不在草稿或活动状态，或需要先恢复核对", next: "重新读取需求后按最新版本再试" },
  model_auth_unavailable: { why: "解读用的模型没有配置凭据", next: "请用户检查模型配置或改选模型" },
  model_cancelled: { why: "解读被取消", next: "需要时重新发起" },
  model_changed: { why: "解读期间模型被切换", next: "重试一次；仍然失败就把这段原因告诉用户" },
  model_configuration_changed: { why: "解读用的模型配置已变化", next: "重试一次；仍然失败就把这段原因告诉用户" },
  model_interpretation_denied: { why: "解读模型没有给出可用的解读", next: "请用户把话说得更明确（说清针对哪个问题、哪个版本、要做什么）后重试" },
  model_response_denied: { why: "解读模型的回答格式不对或没有正常结束", next: "重试一次；仍然失败就把这段原因告诉用户" },
  model_unavailable: { why: "解读用的模型不可用", next: "请用户检查模型配置或改选模型" },
  pending_description_mismatch: { why: "同一段落里既有已确认的条目，又有未决、暂缓或不清楚的条目；每个段落只能整段确认或整段待定", next: "把这段里的未决事项拆到单独小节后重存草稿；或本次只确认其他段落，这一段的条目都标成未生效" },
  pending_basis_required: { why: "未来项、未决项或建议必须标成提议或不确定", next: "重试一次；仍然失败就把这段原因告诉用户" },
  question_action_mismatch: { why: "决定里的授权动作不在问题允许的范围内", next: "请用户把话说得更明确（说清针对哪个问题、哪个版本、要做什么）后重试" },
  question_baseline_mismatch: { why: "问题基于的需求版本已不是当前版本", next: "重新读取需求后按最新版本再试" },
  question_candidate_mismatch: { why: "问题对应的待批准版本已变化", next: "重新读取需求后按最新版本再试" },
  question_changed: { why: "问题记录已被改动", next: "重新读取需求后按最新版本再试" },
  question_identity_mismatch: { why: "问题编号与记录不一致", next: "重新读取需求后按最新版本再试" },
  question_partition_mismatch: { why: "问题引用的章节不在待批准版本里", next: "只引用待批准版本里的章节编号" },
  question_required: { why: "同意类决定必须针对一个已提出的问题", next: "请用户把话说得更明确（说清针对哪个问题、哪个版本、要做什么）后重试" },
  question_unit_mismatch: { why: "问题引用的章节不在待批准版本里", next: "重新读取需求后按最新版本再试" },
  question_view_mismatch: { why: "问题剩余的章节与原问题不一致", next: "重新读取需求后按最新版本再试" },
  reconsideration_denied: { why: "不能再次复核：文档复核已判定一致、复核次数已用完（最多 3 次），或正在保存", next: "按当前复核结果继续，不要再次复核" },
  reference_limit: { why: "引用的问题、决定或章节太多（最多 16 个），或引用章节时没有待批准版本", next: "减少引用数量后重试" },
  request_limit: { why: "请求内容超出大小上限", next: "精简内容后重试" },
  resave_not_finalized: { why: "重新保存还没完成", next: "用原来的操作编号重试，让它续完" },
  resave_origin_mismatch: { why: "重新保存的起点与原复核不一致", next: "重新读取需求后按最新版本再试" },
  resave_state_mismatch: { why: "重新保存前后需求状态不一致", next: "重新读取需求后按最新版本再试" },
  retained_source_mismatch: { why: "保留的来源章节在待批准版本里不存在", next: "重新读取需求后按最新版本再试" },
  revision_link_mismatch: { why: "修订的决定与被取代的决定对应不上", next: "重新读取需求后按最新版本再试" },
  revision_scope_mismatch: { why: "修订范围超出了原决定涉及的章节", next: "请用户把话说得更明确（说清针对哪个问题、哪个版本、要做什么）后重试" },
  revision_source_changed: { why: "被修订的原决定已变化", next: "重新读取需求后按最新版本再试" },
  revision_source_reused: { why: "被修订的原决定又被当成新约束引用", next: "请用户把话说得更明确（说清针对哪个问题、哪个版本、要做什么）后重试" },
  save_reentry: { why: "上一次保存还没结束", next: "等上一次保存结束后再试" },
  saved_decision_changed: { why: "已保存的决定与预期不一致", next: "重新读取需求后按最新版本再试" },
  saved_decision_missing: { why: "找不到已保存的决定", next: "重新读取需求后按最新版本再试" },
  single_question_scope_escape: { why: "针对单个问题的回答超出了这个问题的范围", next: "请用户把话说得更明确（说清针对哪个问题、哪个版本、要做什么）后重试" },
  unknown_question: { why: "找不到这个问题", next: "核对问题编号" },
  unknown_reference: { why: "引用了不存在的问题或待批准版本", next: "只引用此前工具结果给出的编号" },
  unknown_supersedes: { why: "要取代的决定不存在或已被取代", next: "重新读取需求后按最新版本再试" },
  untrusted_session: { why: "当前会话不是登记的会话", next: "在当前主窗口会话里重新发起" },
};
export class UserInteractionError extends Error {
  readonly code: string;
  readonly advice: FailureAdvice;
  constructor(code: string, detail?: string) { super(`用户交互被拒绝：${code}`); this.name = "UserInteractionError"; this.code = code; this.advice = adviceIn(USER_INTERACTION_ADVICE, code, detail); }
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
    for (const q of context.questions) {
      const view = context.effectiveQuestions?.find((v) => v.requestId === q.requestId);
      if (!q.unitIds?.length || (!view && q.unitIds.some((unitId) => !partition.units.some((u) => u.id === unitId)))) throw new UserInteractionError("question_unit_mismatch");
      if (view && (view.originalHash !== decisionDigest(q) || decisionDigest(view.currentBinding) !== decisionDigest(doc.candidate) ||
        view.remainingUnitIds.some((id) => !q.unitIds!.includes(id)))) throw new UserInteractionError("question_view_mismatch");
    }
    for (const e of context.retainedEvidence ?? []) if (e.sourceBasis.requirementId !== context.basis.requirementId || e.sourceBasis.epoch !== context.basis.epoch ||
      !partition.units.some((u) => u.id === e.unitId && u.hash === e.unitHash)) throw new UserInteractionError("retained_source_mismatch");
    for (const issue of context.continuityIssues ?? []) if ((partition.units.find((u) => u.id === issue.unitId)?.hash ?? null) !== issue.targetHash ||
      issue.affectedUnitIds.some((id) => !partition.units.some((u) => u.id === id))) throw new UserInteractionError("continuity_issue_mismatch");
  }
  for (const old of context.priorDecisions) {
    checkDecisionRecord(old);
    if (old.requirementId !== context.basis.requirementId) throw new UserInteractionError("foreign_decision");
  }
  for (const q of context.questions) {
    if (decisionDigest(q.basis) !== decisionDigest(context.basis) && !context.effectiveQuestions?.some((v) => v.requestId === q.requestId)) throw new UserInteractionError("question_baseline_mismatch");
    checkProposal(q.proposal, q.basis);
  }
  return context;
}
export function resolvesContinuityIssue(context: InteractionContext, result: InteractionInterpretation, issue: ContinuityIssue): boolean {
  const review = result.documentReview, doc = context.document;
  if (!review?.faithful || !doc || result.referenceResolution === "ambiguous") return false;
  const explicit = (entry: InteractionEntry) => entry.basis === "explicit" && ["direct", "accept"].includes(entry.resolution);
  const unit = review.units.find((u) => u.id === issue.unitId);
  if (result.entries.some((entry, index) => entry.supersedes.includes(issue.decision.id) && explicit(entry) &&
    (unit ? unit.conclusionIndexes.includes(index) : entry.kind === "exclusion"))) return true;
  if (issue.targetHash !== null && issue.targetHash !== issue.unitHash && unit && unit.disposition !== "pending-description" &&
    unit.conclusionIndexes.some((index) => explicit(result.entries[index]!))) return true;
  if (issue.reason !== "pending" || !unit) return false;
  return issue.questionRefs.some((ref) => {
    const question = context.questions.find((q) => q.requestId === ref.requestId);
    const view = context.effectiveQuestions?.find((q) => q.requestId === ref.requestId);
    const answer = review.questions.find((q) => q.requestId === ref.requestId);
    return question && decisionDigest(question) === ref.hash && question.unitIds?.includes(issue.unitId) &&
      (view ? view.mode === "unchanged" : decisionDigest(question.candidate) === decisionDigest(doc.candidate)) && answer?.answeredIds.includes(issue.unitId) &&
      unit.conclusionIndexes.some((index) => result.entries[index]?.requestId === ref.requestId && result.entries[index]!.kind !== "action" && explicit(result.entries[index]!));
  });
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
    const view = context.effectiveQuestions?.find((v) => v.requestId === question?.requestId);
    if (question?.candidate && (!candidate || decisionDigest(view?.currentBinding ?? question.candidate) !== decisionDigest(candidateBinding(candidate)))) throw new UserInteractionError("question_candidate_mismatch");
    if (view?.mode === "requires-explicit-review" && entry.resolution === "accept") throw new UserInteractionError("changed_question_requires_review");
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
    if (entry.kind === "adjudication") adjudicationOf(entry, context);
    // 短决定记录不存条目类型，裁决引用前缀只能出现在裁决条目里，否则其他条目可被冒充为裁决
    else if (entry.references.some((reference) => ADJUDICATION_PREFIXES.some((prefix) => reference.startsWith(prefix)))) throw new UserInteractionError("adjudication_reference_reserved");
  }
  if (result.entries.filter((entry) => entry.kind === "adjudication").length > 1) throw new UserInteractionError("adjudication_ambiguous");
  return result;
}

/**
 * 裁决条目只能引用宿主给出的当前事项，引用恰为 item、version、choice，选"再给一次机会"时另带正整数轮数上限；
 * 须是当前输入明确直接的表达，不关联候选、问题或动作。
 */
export function adjudicationOf(entry: InteractionEntry, context: Pick<InteractionContext, "adjudication" | "document">): { itemId: string; version: string; choice: AdjudicationChoice; maxTurns: number | null } {
  const subject = context.adjudication;
  if (!subject || context.document || entry.kind !== "adjudication" || entry.basis !== "explicit" || entry.resolution !== "direct" || entry.candidateId !== null ||
    entry.requestId !== null || entry.actions.length > 0 || entry.supersedes.length > 0) throw new UserInteractionError("adjudication_invalid");
  const value = (prefix: string) => {
    const found = entry.references.filter((reference) => reference.startsWith(`${prefix}:`));
    return found.length === 1 ? found[0]!.slice(prefix.length + 1) : null;
  };
  const choice = value("choice") as AdjudicationChoice | null, turns = value("max-turns");
  const maxTurns = turns !== null && /^[1-9][0-9]{0,3}$/.test(turns) && Number(turns) <= 1000 ? Number(turns) : null;
  const expected = 3 + (choice === "retry" ? 1 : 0);
  if (value("item") !== subject.itemId || value("version") !== subject.version || !choice || !CHOICES_BY_SUBJECT[subject.itemId.split(":")[0]!]?.includes(choice) ||
    (choice === "retry") !== (maxTurns !== null) || (choice !== "retry" && turns !== null) || entry.references.length !== expected) throw new UserInteractionError("adjudication_invalid");
  return { itemId: subject.itemId, version: subject.version, choice, maxTurns };
}
