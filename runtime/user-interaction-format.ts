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
export const ApprovalUnitIds = Type.Array(ApprovalUnitId, { uniqueItems: true });
export const ApprovalPartition = object({ prodHash: hash, totalBytes: positive,
  units: Type.Array(object({ id: ApprovalUnitId, hash, startByte: counter, endByte: positive }), { minItems: 1 }) });
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
  affectedUnitIds: Type.Array(ApprovalUnitId, { uniqueItems: true }),
  reason: enumeration(["modify", "pending"]) });
export type ContinuityIssue = Static<typeof ContinuityIssue>;
export const RevisionSource = object({ fact: ContinuityRecordRef, decision: ContinuityRecordRef, sourceBasis: InteractionBasis,
  unitIds: Type.Array(object({ id: ApprovalUnitId, hash })),
  kind: enumeration(["target", "constraint", "exclusion", "future", "delegation", "action", "unresolved", "suggestion", "ai-choice"]) });
export type RevisionSource = Static<typeof RevisionSource>;
export const EffectiveQuestion = object({ requestId: id, originalHash: hash, remainingUnitIds: ApprovalUnitIds,
  currentBinding: CandidateBinding,
  resolutions: Type.Array(ContinuityRecordRef, { maxItems: 128 }),
  unitMappings: Type.Array(object({ id: ApprovalUnitId, sourceHash: hash, targetHash: nullable(hash) })) });
export type EffectiveQuestion = Static<typeof EffectiveQuestion>;
const ConclusionIndexes = Type.Array(Type.Integer({ minimum: 0, maximum: 19 }), { minItems: 1, maxItems: 16, uniqueItems: true });
export const UnitReview = object({ id: ApprovalUnitId,
  disposition: enumeration(["confirmed", "pending-description", "excluded"]), globalConstraint: Type.Boolean(),
  appliesTo: ApprovalUnitIds, dependsOn: ApprovalUnitIds, conclusionIndexes: Type.Array(Type.Integer({ minimum: 0, maximum: 19 }), { maxItems: 16, uniqueItems: true }),
  retainedFactIds: Type.Optional(Type.Array(id, { maxItems: 16, uniqueItems: true })) });
export const ActionReview = object({ action: InteractionAction, goalIds: ApprovalUnitIds, constraintIds: ApprovalUnitIds,
  conclusionIndexes: ConclusionIndexes, unknown: Type.Boolean() });
export const DocumentReview = object({ faithful: Type.Boolean(),
  units: Type.Array(UnitReview, { minItems: 1 }),
  actions: Type.Array(ActionReview, { maxItems: 20 }),
  questions: Type.Array(object({ requestId: id, answeredIds: ApprovalUnitIds, pendingIds: ApprovalUnitIds,
    conclusionIndexes: Type.Array(Type.Integer({ minimum: 0, maximum: 19 }), { maxItems: 16, uniqueItems: true }) }), { maxItems: 20 }) });
export type DocumentReview = Static<typeof DocumentReview>;
export const PendingQuestion = object({
  format: Type.Literal("interaction-question/v1"), requestId: id, repoId: hash, basis: InteractionBasis,
  candidate: nullable(CandidateBinding), proposal: DecisionItem,
  actions: Type.Array(InteractionAction, { maxItems: 5, uniqueItems: true }), createdAt: counter,
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
  retainedEvidence: Type.Optional(Type.Array(RetainedUnitEvidence)),
  continuityIssues: Type.Optional(Type.Array(ContinuityIssue)),
  revisionSources: Type.Optional(Type.Array(RevisionSource, { maxItems: 20 })),
  adjudication: Type.Optional(AdjudicationSubject),
  addressed: Type.Optional(object({ how: enumeration(["mention", "window"]), others: Type.Optional(Type.Integer({ minimum: 0, maximum: 32 })),
    otherDrafts: Type.Optional(Type.Array(object({ title: Type.String(), version: Type.Integer({ minimum: 1 }) }), { minItems: 1, maxItems: 32 })) })),
});
export type InteractionContext = Static<typeof InteractionContext>;
export const InteractionEntry = object({
  kind: enumeration(["target", "constraint", "exclusion", "future", "delegation", "action", "unresolved", "suggestion", "ai-choice", "adjudication"]),
  basis: enumeration(["explicit", "delegated", "proposed", "uncertain"]),
  resolution: enumeration(["direct", "accept", "modify", "defer", "unclear"]),
  candidateId: nullable(id), requestId: nullable(id),
  actions: Type.Array(InteractionAction, { maxItems: 5, uniqueItems: true }),
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
  continuity_changed: { why: "确认期间用户又有新的输入", next: "按用户最新的原话重新确认" },
  continuity_decision_changed: { why: "沿用的原依据对应的用户决定已变化，或已不是用户确认的状态", next: "重新读取需求后按最新版本再试" },
  continuity_decision_mismatch: { why: "登记确认依据时，刚保存的决定与这次确认的需求、版本或操作对不上", next: "不要重试，重试结果相同；把这段原因告诉用户" },
  continuity_decision_missing: { why: "登记确认依据时找不到刚保存的决定", next: "不要重试，重试结果相同；把这段原因告诉用户" },
  continuity_fact_changed: { why: "确认依据的事实记录已变化", next: "重新读取需求后按最新版本再试" },
  continuity_fact_conflict: { why: "同一次保存已经登记过一份内容不同的确认依据", next: "不要重试，重试结果相同；把这段原因告诉用户" },
  continuity_fact_identity: { why: "确认依据记录前后对不上：编号、草稿指纹或段落与记录本身不一致", next: "不要重试，重试结果相同；把这段原因告诉用户" },
  continuity_fact_mutated: { why: "确认依据记录被改写过，这类记录只能写一次", next: "不要重试，重试结果相同；把这段原因告诉用户" },
  continuity_issue_mismatch: { why: "连续性问题引用的章节不在待确认版本里", next: "重新读取需求后按最新版本再试" },
  continuity_issue_source_changed: { why: "待修订或待定事项依据的原决定已被改动或不再有效", next: "重新读取需求后按最新版本再试" },
  continuity_question_identity: { why: "本需求的一条待答问题记录与当前需求对不上：编号、仓库或需求轮次不一致，或没有关联段落", next: "不要重试，重试结果相同；把这段原因告诉用户" },
  continuity_revision_changed: { why: "保存这次决定期间，被取代的原决定又被别的操作改动", next: "重新读取需求后按最新版本再试" },
  continuity_scan_limit: { why: "本需求的确认记录或待答问题太多，超出程序一次能读取的上限（确认记录 128 份、问题 256 个，单类记录合计 1 MiB，两类合计 2 MiB）", next: "不要重试，重试结果相同；把这段原因告诉用户" },
  continuity_source_changed: { why: "确认依据引用的记录已被改动，可能刚被新的决定取代", next: "重新读取需求后按最新版本再试" },
  continuity_source_mismatch: { why: "沿用的原依据与它的来源对不上：来源不是用户明确确认的内容，或段落已经改过", next: "重新读取需求后按最新版本再试" },
  continuity_state_changed: { why: "读取确认依据期间需求已变化：版本、状态或已保存的草稿与这次确认时不同", next: "重新读取需求后按最新版本再试" },
  continuity_unit_missing: { why: "登记确认依据时，解读结果引用了草稿里不存在的段落", next: "不要重试，重试结果相同；把这段原因告诉用户" },
  continuity_version_source: { why: "找不到确认依据对应的草稿保存记录，或两者对不上", next: "不要重试，重试结果相同；把这段原因告诉用户" },
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
  interaction_context_limit: { why: "本需求累积的待答问题、以往决定或原依据太多，发给解释器的材料超出上限", next: "不要重试，重试结果相同；先回答或处理掉已有的问题和待定事项，仍不行就把这段原因告诉用户" },
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
  action_not_explicit: { why: "授权动作不是用户明确说出的，或动作条目与授权范围对不上", next: "只把用户明确要求的动作写成 action 条目，并让它和授权范围一致" },
  continuity_action_unresolved: { why: "有待修订或待澄清的段落，却被写进了本次授权的动作范围", next: "先解决这些段落的修订或澄清，或本次授权不要包含它们" },
  continuity_resolution_required: { why: "之前待修订或待澄清的段落，这次既没有解决，也没有标成待定", next: "在草稿里把它标成待定，或按用户原话明确解决后再确认" },
  direct_instruction_reference_required: { why: "有待回答的问题时，直接给出的目标或动作必须标明是明确的新指令", next: "把这类条目的指代方式标成明确（explicit），或让它回答对应的问题" },
  document_needs_resave: { why: "用户要求修改这一段，草稿需要先按修改重新保存", next: "先按用户的修改更新并保存草稿，再请用户确认" },
  document_not_approved: { why: "整份草稿没有被判定为忠实表达用户意思，或指代不明，不能批准", next: "把不符之处告诉用户，按用户原话修改草稿后再确认" },
  duplicate_action_scope: { why: "同一授权范围被重复列出", next: "合并重复的授权范围后重试" },
  duplicate_question: { why: "同一个问题被重复列出", next: "去掉重复的问题后重试" },
  duplicate_unit: { why: "段落编号重复", next: "让每个段落编号只出现一次" },
  global_constraint_kind: { why: "标成全局约束的段落里混入了目标或动作条目", next: "全局约束段落只放约束、未决或建议条目" },
  goal_not_explicit: { why: "授权要实施的目标段落没有用户明确确认的目标条目", next: "只把用户明确确认的目标写进授权范围" },
  incomplete_action_closure: { why: "授权范围缺了目标依赖的段落或适用的全局约束", next: "把依赖段落和全局约束补进授权范围" },
  incomplete_document_review: { why: "逐段复核没有覆盖草稿的全部段落，或顺序不对", next: "按草稿分区逐段给出复核" },
  incomplete_question_review: { why: "没有逐一处理全部待回答的问题", next: "每个待回答的问题都要有对应的处理" },
  invalid_action_scope: { why: "授权范围没有目标，或把元数据当成目标，或同一段既是目标又是约束", next: "只把正文段落作为目标，约束与目标不要重复" },
  invalid_global_scope: { why: "全局约束的影响范围写错了：非全局约束不能列影响范围，影响范围里有不存在的段落或引用了自己", next: "按真实段落修正影响范围" },
  manifest_binding_mismatch: { why: "批准清单与待批准版本不一致", next: "重新读取需求后按最新版本再试" },
  manifest_hash_mismatch: { why: "批准清单的指纹与内容不符", next: "重新读取需求后按最新版本再试" },
  manifest_partition_mismatch: { why: "批准清单的段落划分与待批准版本不一致", next: "重新读取需求后按最新版本再试" },
  manifest_retained_mismatch: { why: "批准清单里保留的原依据与段落对不上", next: "重新读取需求后按最新版本再试" },
  question_action_escape: { why: "回答问题时授权了问题范围以外的动作或目标", next: "只在问题允许的动作与段落内作答；新增的目标或动作用明确的新指令" },
  question_answer_mismatch: { why: "问题的回答与段落复核结果对不上：答复了的段落仍是待定，或待定段落被当成已答", next: "让回答与各段落的确认或待定状态一致" },
  question_entry_coverage: { why: "关联到问题的条目与问题的处理结果不一致", next: "让每个问题的条目编号与实际关联的条目一致" },
  question_scope_mismatch: { why: "问题的答复范围与问题剩余的段落不一致，或引用太多", next: "按问题剩余的段落作答，已答与待定不要重叠" },
  question_unit_escape: { why: "回答问题的条目涉及了问题范围以外的段落", next: "只在问题涉及的段落内作答" },
  retained_source_missing: { why: "引用的原依据不存在", next: "只引用真实存在的原依据" },
  review_entry_mismatch: { why: "逐段复核里有段落没有被任何条目涉及，或引用了别的版本的条目", next: "让每个段落至少有一个本版本的条目涉及" },
  unit_dependency_cycle: { why: "段落之间的依赖形成了循环", next: "去掉循环依赖" },
  unit_not_confirmed: { why: "标成已确认的段落里有未生效的条目，或缺少目标、约束类的确认条目", next: "给这段补上明确的确认条目，或把它标成待定" },
  unit_not_excluded: { why: "标成排除的段落里有不是明确排除的条目", next: "只有用户明确不要的段落才标排除" },
  unknown_unit: { why: "引用了草稿里不存在的段落编号", next: "只引用草稿里真实的段落编号" },
  unmapped_review_entry: { why: "有条目没有对应到任何段落或授权动作", next: "让每个条目都对应到段落或动作，或删掉它" },
  pending_description_mismatch: { why: "同一段落里既有已确认的条目，又有未决、暂缓或不清楚的条目；每个段落只能整段确认或整段待定", next: "把这段里的未决事项拆到单独小节后重存草稿；或本次只确认其他段落，这一段的条目都标成未生效" },
  pending_basis_required: { why: "未来项、未决项或建议必须标成提议或不确定", next: "重试一次；仍然失败就把这段原因告诉用户" },
  question_action_mismatch: { why: "决定里的授权动作不在问题允许的范围内", next: "请用户把话说得更明确（说清针对哪个问题、哪个版本、要做什么）后重试" },
  question_baseline_mismatch: { why: "问题基于的需求版本已不是当前版本", next: "重新读取需求后按最新版本再试" },
  question_candidate_mismatch: { why: "问题对应的待批准版本已变化", next: "重新读取需求后按最新版本再试" },
  question_changed: { why: "问题记录已被改动", next: "重新读取需求后按最新版本再试" },
  question_identity_mismatch: { why: "问题编号与记录不一致", next: "重新读取需求后按最新版本再试" },
  question_partition_mismatch: { why: "问题引用的章节不在待批准版本里", next: "只引用待批准版本里的章节编号" },
  question_required: { why: "同意类决定必须针对一个已提出的问题", next: "请用户把话说得更明确（说清针对哪个问题、哪个版本、要做什么）后重试" },
  question_units_without_candidate: { why: "问题引用了章节，但没有对应的待批准版本", next: "只在有待批准版本时引用章节编号" },
  question_unit_mismatch: { why: "问题引用的章节不在待批准版本里", next: "重新读取需求后按最新版本再试" },
  question_view_mismatch: { why: "问题剩余的章节与原问题不一致", next: "重新读取需求后按最新版本再试" },
  reconsideration_denied: { why: "不能再次复核：文档复核已判定一致、复核次数已用完（最多 3 次），或正在保存", next: "按当前复核结果继续，不要再次复核" },
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
export function parseInteraction<T extends TSchema>(schema: T, source: string, maxBytes: number = SHORT_DECISION_LIMITS.requestBytes): Static<T> {
  if (typeof source !== "string" || Buffer.byteLength(source) > maxBytes) throw new UserInteractionError("request_limit");
  const value = parseStrictJson(source);
  if (!Value.Check(schema, value)) throw new UserInteractionError("invalid_shape", shapeProblems(schema, value));
  return value as Static<T>;
}
// 格式检查最多报 8 条错误，取值列表会被截断，所以只指出字段，允许的取值让模型按 JSON schema 核对
function shapeProblems(schema: TSchema, value: unknown): string {
  const problems = new Set<string>();
  for (const error of Value.Errors(schema, value)) {
    const path = error.instancePath || "/";
    if (error.keyword === "const") problems.add(`${path} 的取值不在 JSON schema 允许的范围里`);
    else if (error.keyword === "additionalProperties") problems.add(`${path} 多了 JSON schema 里没有的字段 ${(error.params.additionalProperties as string[]).join("、")}`);
    else if (error.keyword !== "boolean") problems.add(`${path} ${error.message}`);
  }
  return [...problems].slice(0, 3).map((problem) => problem.slice(0, 300)).join("；");
}
export function checkInteraction<T extends TSchema>(schema: T, value: unknown, maxBytes?: number): Static<T> {
  let copy: unknown;
  try { copy = structuredClone(value); } catch { throw new UserInteractionError("invalid_shape"); }
  return parseInteraction(schema, JSON.stringify(copy), maxBytes);
}
export function checkProposal(item: Static<typeof DecisionItem>, basis: InteractionBasis): void {
  parseDecisionBatch(JSON.stringify({ ...basis, operationId: basis.requirementId, decisions: [item] }));
}
const HASH = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const isHash = (value: unknown) => typeof value === "string" && HASH.test(value);
/** 发给解释器的内容：去掉哈希。模型只按编号引用，哈希留在程序侧核对，发过去只占输入大小。 */
export function interpreterView<T>(value: T): T {
  if (Array.isArray(value)) return value.filter((item) => !isHash(item)).map(interpreterView) as T;
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([, item]) => !isHash(item)).map(([key, item]) => [key, interpreterView(item)])) as T;
  return value;
}
export function checkContext(value: unknown): InteractionContext {
  // 大小上限按发给解释器的内容（interpreterView）算，完整上下文里只供程序核对的哈希不计入
  const context = checkInteraction(InteractionContext, value, Number.POSITIVE_INFINITY);
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
      (view !== undefined || decisionDigest(question.candidate) === decisionDigest(doc.candidate)) && answer?.answeredIds.includes(issue.unitId) &&
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
