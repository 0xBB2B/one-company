import { Type } from "typebox";
import type { Static } from "typebox";
import { object, positive } from "./requirement-contracts.ts";
import { decisionDigest } from "./short-decision-format.ts";
import { ApprovalPartition, ApprovalUnitIds, CandidateBinding, UnitReview, ActionReview,
  checkInteraction, UserInteractionError, RetainedUnitEvidence, resolvesContinuityIssue } from "./user-interaction-format.ts";
import type { InteractionContext, InteractionInterpretation, InteractionEntry } from "./user-interaction-format.ts";
import type { ProdApprovalPartition } from "./prod-view.ts";

const id = CandidateBinding.properties.candidateId, hash = CandidateBinding.properties.intentHash;
const decisionIds = Type.Array(id, { minItems: 1, maxItems: 16, uniqueItems: true });
const { conclusionIndexes: _unitIndexes, ...unitFields } = UnitReview.properties;
const { conclusionIndexes: _actionIndexes, ...actionFields } = ActionReview.properties;
export const ApprovalManifest = object({ format: Type.Literal("approval-manifest/v1"), requirementId: id,
  candidate: CandidateBinding, manifestHash: hash, totalBytes: positive,
  units: Type.Array(object({ ...unitFields, ...ApprovalPartition.properties.units.items.properties, decisionIds }), { minItems: 1 }),
  actions: Type.Array(object({ ...actionFields, decisionIds }), { maxItems: 20 }),
  retainedSources: Type.Optional(Type.Array(RetainedUnitEvidence)),
  questions: Type.Array(object({ requestId: id, answeredIds: ApprovalUnitIds, pendingIds: ApprovalUnitIds,
    decisionIds: Type.Array(id, { maxItems: 16, uniqueItems: true }) }), { maxItems: 20 }) });
export type ApprovalManifest = Static<typeof ApprovalManifest>;
export interface ApprovalManifestReference { requirementId: string; candidate: CandidateBinding; manifestHash: string }
export interface ApprovalManifestExpected { requirementId: string; candidate: CandidateBinding; partition: ProdApprovalPartition }
function deny(code: string, detail?: string): never { throw new UserInteractionError(code, detail); }
function sameSet(a: readonly string[], b: readonly string[]): boolean { return a.length === b.length && a.every((v) => b.includes(v)); }
function explicit(e: InteractionEntry): boolean { return e.basis === "explicit" && !["modify", "defer", "unclear"].includes(e.resolution); }
export function confirmed(e: InteractionEntry): boolean { return ["explicit", "delegated"].includes(e.basis) && !["modify", "defer", "unclear"].includes(e.resolution); }
type Unit = { id: string; dependsOn: string[]; globalConstraint: boolean; appliesTo: string[] };
function graph(units: Unit[]): void {
  const ids = new Set(units.map((u) => u.id));
  if (ids.size !== units.length) deny("duplicate_unit");
  const done = new Set<string>(), visiting = new Set<string>();
  function visit(id: string): void {
    if (visiting.has(id)) deny("unit_dependency_cycle", `段落 ${id}`);
    if (done.has(id)) return;
    const unit = units.find((u) => u.id === id);
    if (!unit) deny("unknown_unit", `编号 ${id}`);
    if ((!unit.globalConstraint && unit.appliesTo.length) || unit.appliesTo.some((v) => !ids.has(v) || v === id)) deny("invalid_global_scope", `段落 ${id}`);
    visiting.add(id); unit.dependsOn.forEach(visit); visiting.delete(id); done.add(id);
  }
  units.forEach((u) => visit(u.id));
}
/** 必需闭包包括显式依赖及作用于该闭包的全局条件；空appliesTo表示适用于全部目标。 */
export function approvalDependencyClosure(units: Unit[], goalIds: string[]): string[] {
  graph(units);
  const found = new Set<string>();
  function add(id: string): void {
    const unit = units.find((u) => u.id === id); if (!unit) deny("unknown_unit", `编号 ${id}`);
    if (found.has(id)) return; found.add(id); unit.dependsOn.forEach(add);
  }
  goalIds.forEach(add);
  let previous = -1;
  while (previous !== found.size) {
    previous = found.size;
    for (const u of units) if (u.globalConstraint && (!u.appliesTo.length || u.appliesTo.some((id) => found.has(id)))) add(u.id);
  }
  return [...found].sort();
}
function validateScopes(units: Unit[], actions: Array<{ goalIds: string[]; constraintIds: string[]; action: string }>): void {
  graph(units);
  const scopeKeys = actions.map((a) => decisionDigest({ action: a.action, goalIds: [...a.goalIds].sort(), constraintIds: [...a.constraintIds].sort() }));
  if (new Set(scopeKeys).size !== scopeKeys.length) deny("duplicate_action_scope");
  for (const a of actions) {
    if (!a.goalIds.length || a.goalIds.some((id) => id === "metadata" || a.constraintIds.includes(id))) deny("invalid_action_scope");
    const closure = approvalDependencyClosure(units, a.goalIds);
    if (!sameSet(closure, [...a.goalIds, ...a.constraintIds])) deny("incomplete_action_closure");
  }
}
/** hash不包含自身；只接受清单固定字段的调用方应先使用checkApprovalManifest。 */
export function approvalManifestDigest(manifest: Omit<ApprovalManifest, "manifestHash"> | ApprovalManifest): string {
  const { manifestHash: _hash, ...payload } = manifest as ApprovalManifest;
  return decisionDigest(payload);
}
/** 严格格式/范围证明。expected必须来自可信整份字节复算；返回JSON不是授权或可信决策回执。 */
export function checkApprovalManifest(value: unknown, expected: ApprovalManifestExpected): ApprovalManifest {
  const m = checkInteraction(ApprovalManifest, value);
  const p = checkInteraction(ApprovalPartition, expected.partition);
  if (m.requirementId !== expected.requirementId || decisionDigest(m.candidate) !== decisionDigest(expected.candidate) ||
    p.prodHash !== m.candidate.to.hash || p.totalBytes !== m.totalBytes || p.units.length !== m.units.length) deny("manifest_binding_mismatch");
  let end = 0;
  for (const [index, u] of m.units.entries()) {
    const actual = { id: u.id, hash: u.hash, startByte: u.startByte, endByte: u.endByte };
    if (u.startByte !== end || u.endByte <= end || decisionDigest(actual) !== decisionDigest(p.units[index])) deny("manifest_partition_mismatch");
    end = u.endByte;
  }
  if (end !== m.totalBytes || m.units[0]?.id !== "metadata") deny("manifest_partition_mismatch");
  for (const e of m.retainedSources ?? []) {
    const u = m.units.find((u) => u.id === e.unitId);
    if (!u || u.hash !== e.unitHash || !u.retainedFactIds?.includes(e.fact.id) || !u.decisionIds.includes(e.decision.id) ||
      e.sourceBasis.requirementId !== m.requirementId || (u.disposition === "excluded" ? e.kind !== "exclusion" : u.disposition !== "confirmed" || e.kind === "exclusion")) deny("manifest_retained_mismatch");
  }
  for (const u of m.units) if ((u.retainedFactIds ?? []).some((id) => !m.retainedSources?.some((e) => e.fact.id === id && e.unitId === u.id))) deny("manifest_retained_mismatch");
  validateScopes(m.units, m.actions);
  const ids = new Set(m.units.map((u) => u.id));
  if (new Set(m.questions.map((q) => q.requestId)).size !== m.questions.length) deny("duplicate_question");
  for (const q of m.questions) {
    if (q.answeredIds.some((id) => q.pendingIds.includes(id)) || [...q.answeredIds, ...q.pendingIds].some((id) => !ids.has(id))) deny("question_scope_mismatch");
  }
  if (approvalManifestDigest(m) !== m.manifestHash) deny("manifest_hash_mismatch");
  return m;
}
export function approvalManifestReference(manifest: ApprovalManifest): ApprovalManifestReference {
  return { requirementId: manifest.requirementId, candidate: structuredClone(manifest.candidate), manifestHash: manifest.manifestHash };
}
function retainedForReview(context: InteractionContext, result: InteractionInterpretation) {
  const revised = new Set(result.entries.flatMap((entry) => entry.supersedes));
  return (context.retainedEvidence ?? []).filter((source) => !revised.has(source.decision.id));
}
/** 语义由无工具模型归纳；机械核验覆盖、请求反向范围、分类与依赖，不能证明理解必然正确。 */
export function validateDocumentReview(context: InteractionContext, result: InteractionInterpretation): void {
  const doc = context.document, review = result.documentReview;
  const retainedEvidence = retainedForReview(context, result);
  if (!doc || !review) deny("document_review_required");
  if (review.units.length !== doc.partition.units.length || review.units.some((u, i) => u.id !== doc.partition.units[i]!.id)) deny("incomplete_document_review");
  const unitUsed = new Set<number>(), actionUsed = new Set<number>(), candidateId = doc.candidate.candidateId;
  function entries(indexes: number[]): InteractionEntry[] {
    return indexes.map((i) => {
      const e = result.entries[i]; if (!e || e.candidateId !== candidateId) deny("review_entry_mismatch");
      return e;
    });
  }
  for (const u of review.units) {
    u.conclusionIndexes.forEach((i) => unitUsed.add(i));
    const related = entries(u.conclusionIndexes);
    const retained = (u.retainedFactIds ?? []).map((id) => {
      const evidence = retainedEvidence.find((e) => e.fact.id === id && e.unitId === u.id);
      if (!evidence) return deny("retained_source_missing", `段落 ${u.id}`); return evidence;
    });
    if (!related.length && !retained.length || retained.length && u.disposition === "pending-description") deny("review_entry_mismatch", `段落 ${u.id}`);
    if (u.globalConstraint && (!related.every((e) => ["constraint", "unresolved", "suggestion"].includes(e.kind)) || !retained.every((e) => e.kind === "constraint"))) deny("global_constraint_kind", `段落 ${u.id}`);
    if (review.faithful) {
      if (related.some((e) => e.resolution === "modify")) deny("document_needs_resave", `段落 ${u.id}`);
      if (u.disposition === "confirmed" && (retained.some((e) => e.kind === "exclusion") || related.some((e) => !confirmed(e)) ||
        !related.some((e) => ["target", "constraint", "delegation", "ai-choice"].includes(e.kind)) && !retained.some((e) => ["target", "constraint"].includes(e.kind)))) deny("unit_not_confirmed", `段落 ${u.id}`);
      if (u.disposition === "excluded" && (!related.every((e) => e.kind === "exclusion" && explicit(e)) || !retained.every((e) => e.kind === "exclusion"))) deny("unit_not_excluded", `段落 ${u.id}`);
      if (u.disposition === "pending-description" && !related.every((e) => !confirmed(e))) deny("pending_description_mismatch", `段落 ${u.id}`);
    }
  }
  if (review.faithful) for (const issue of context.continuityIssues ?? []) {
    const unit = review.units.find((u) => u.id === issue.unitId);
    if (resolvesContinuityIssue(context, result, issue)) continue;
    if (!unit || unit.disposition !== "pending-description") deny("continuity_resolution_required");
    if (review.actions.some((action) => !action.unknown && [...action.goalIds, ...action.constraintIds].some((id) => issue.affectedUnitIds.includes(id)))) deny("continuity_action_unresolved");
  }
  validateScopes(review.units, review.actions);
  for (const a of review.actions) {
    a.conclusionIndexes.forEach((i) => actionUsed.add(i));
    const related = entries(a.conclusionIndexes);
    if (!related.every((e) => e.kind === "action" && explicit(e) && e.actions.includes(a.action))) deny("action_not_explicit", `动作 ${a.action}`);
    for (const goalId of a.goalIds) {
      const u = review.units.find((u) => u.id === goalId)!;
      if (!entries(u.conclusionIndexes).some((e) => e.kind === "target" && explicit(e)) && !(u.retainedFactIds ?? []).some((id) =>
        retainedEvidence.some((e) => e.fact.id === id && e.unitId === u.id && e.kind === "target"))) deny("goal_not_explicit", `段落 ${goalId}`);
    }
  }
  if (review.questions.length !== context.questions.length || new Set(review.questions.map((q) => q.requestId)).size !== review.questions.length) deny("incomplete_question_review");
  for (const q of review.questions) {
    const actual = context.questions.find((v) => v.requestId === q.requestId);
    const remaining = context.effectiveQuestions?.find((v) => v.requestId === q.requestId)?.remainingUnitIds ?? actual?.unitIds;
    if (!actual?.unitIds || !remaining || !sameSet(remaining, [...q.answeredIds, ...q.pendingIds]) || q.answeredIds.some((id) => q.pendingIds.includes(id))) deny("question_scope_mismatch");
    const related = entries(q.conclusionIndexes);
    // 从实际entries反查全部使用者，不允许通过问题索引漏列结论逃逸。
    const linked = result.entries.flatMap((e, i) => e.requestId === q.requestId ? [i] : []);
    if (linked.length !== q.conclusionIndexes.length || linked.some((i) => !q.conclusionIndexes.includes(i))) deny("question_entry_coverage");
    for (const i of linked) {
      const e = result.entries[i]!;
      const allowedIds = confirmed(e) ? q.answeredIds : remaining;
      if (review.units.some((u) => u.conclusionIndexes.includes(i) && !allowedIds.includes(u.id))) deny("question_unit_escape");
      if (review.actions.some((a) => a.conclusionIndexes.includes(i) &&
        (!actual.actions.includes(a.action) || a.goalIds.some((id) => !q.answeredIds.includes(id))))) deny("question_action_escape");
    }
    if (related.some((e) => e.requestId !== q.requestId) || q.answeredIds.some((id) => {
      const u = review.units.find((u) => u.id === id);
      return !u || u.disposition === "pending-description" || !u.conclusionIndexes.some((i) => q.conclusionIndexes.includes(i) && explicit(result.entries[i]!));
    })) deny("question_answer_mismatch");
    if (q.pendingIds.some((id) => review.units.find((u) => u.id === id)?.disposition !== "pending-description")) deny("question_answer_mismatch");
  }
  for (const [i, e] of result.entries.entries()) {
    if (context.questions.length && ["target", "action"].includes(e.kind) && confirmed(e) && e.requestId === null &&
      result.referenceResolution !== "explicit") deny("direct_instruction_reference_required");
    if (result.referenceResolution === "single-question" && confirmed(e)) {
      const q = context.questions[0];
      if (!q || context.questions.length !== 1) deny("ambiguous_reference");
      if (e.requestId !== q.requestId || e.resolution !== "accept") {
        const uses = review.units.filter((u) => u.conclusionIndexes.includes(i));
        // 唯一结构例外是可信分区的metadata，不含业务段落，不能用作动作目标或共享约束。
        const structural = e.kind === "constraint" && e.basis === "explicit" && e.resolution === "direct" && e.requestId === null &&
          !e.references.length && !e.supersedes.length && uses.length === 1 && uses[0]!.id === "metadata" &&
          !uses[0]!.globalConstraint && !uses[0]!.dependsOn.length && !uses[0]!.appliesTo.length;
        // 引用已核对的同版本当前短记录仅能支持约束，不能变成当前输入的新目标或动作。
        const prior = e.references.length === 1 ? context.priorDecisions.find((d) => d.decisionId === e.references[0]) : undefined;
        const existingConstraint = e.kind === "constraint" && e.basis === "explicit" && e.resolution === "direct" && e.requestId === null &&
          !e.supersedes.length && prior?.actor === "user" && prior.status === "confirmed" && prior.basisReceiptId !== null &&
          prior.requirementId === context.basis.requirementId && prior.requirementVersion === context.basis.version && prior.epoch === context.basis.epoch &&
          decisionDigest(prior.prod) === decisionDigest(context.basis.prod) && prior.references.includes(doc.candidate.to.commit) &&
          prior.references.includes(doc.candidate.to.hash) && e.conclusion === prior.conclusion && e.scope === prior.scope;
        if ((!structural && !existingConstraint) || actionUsed.has(i) ||
          review.actions.some((a) => a.goalIds.some((id) => uses.some((u) => u.id === id)))) deny("single_question_scope_escape");
      }
    }
    if (!(e.kind === "action" ? actionUsed : unitUsed).has(i) && (e.candidateId !== null || e.kind !== "future")) deny("unmapped_review_entry");
  }
}
export function createApprovalManifest(context: InteractionContext, result: InteractionInterpretation, savedDecisionIds: string[]): ApprovalManifest {
  validateDocumentReview(context, result);
  const doc = context.document!, review = result.documentReview!, retainedEvidence = retainedForReview(context, result);
  if (!review.faithful || result.referenceResolution === "ambiguous" || savedDecisionIds.length !== result.entries.length || new Set(savedDecisionIds).size !== savedDecisionIds.length) deny("document_not_approved");
  // 清单同时保留独立约束的原始来源ID，持久化消费者必须核验它，不能只检查本次复制的短记录。
  const mapped = (indexes: number[]) => [...new Set(indexes.flatMap((i) => {
    const e = result.entries[i]!;
    const sources = result.referenceResolution === "single-question" && e.kind === "constraint" && e.requestId === null && e.resolution === "direct"
      ? e.references.filter((id) => context.priorDecisions.some((d) => d.decisionId === id)) : [];
    return [savedDecisionIds[i]!, ...sources];
  }))];
  const payload = { format: "approval-manifest/v1" as const, requirementId: context.basis.requirementId, candidate: doc.candidate,
    totalBytes: doc.partition.totalBytes,
    units: review.units.map(({ conclusionIndexes, ...u }, i) => ({ ...u, ...doc.partition.units[i]!, decisionIds: [...new Set([...mapped(conclusionIndexes),
      ...(u.retainedFactIds ?? []).flatMap((id) => retainedEvidence.filter((e) => e.fact.id === id && e.unitId === u.id).map((e) => e.decision.id))])] })),
    ...(review.units.some((u) => u.retainedFactIds?.length) ? { retainedSources: retainedEvidence.filter((e) =>
      review.units.some((u) => u.id === e.unitId && u.retainedFactIds?.includes(e.fact.id))) } : {}),
    actions: review.actions.map(({ conclusionIndexes, ...a }) => ({ ...a, decisionIds: mapped(conclusionIndexes) })),
    questions: review.questions.map(({ conclusionIndexes, ...q }) => ({ ...q, decisionIds: mapped(conclusionIndexes) })) };
  return checkApprovalManifest({ ...payload, manifestHash: approvalManifestDigest(payload) }, { requirementId: context.basis.requirementId, candidate: doc.candidate, partition: doc.partition });
}
