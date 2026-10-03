import { Type } from "typebox";
import type { Static } from "typebox";
import { object } from "./requirement-contracts.ts";
import { approvalDependencyClosure } from "./approval-manifest.ts";
import { ApprovalUnitId, ApprovalUnitIds, InteractionEntry, InteractionInterpretation, parseInteraction, UnitReview, UserInteractionError } from "./user-interaction-format.ts";
import type { DocumentReview, InteractionAction, InteractionContext } from "./user-interaction-format.ts";

const { documentReview: _review, ...interpretationFields } = InteractionInterpretation.properties;
/** 解释器模型的回答：每条决定写明涉及哪些段，逐段审阅的编号与闭包由程序生成，模型不再维护交叉编号。 */
export const ModelInterpretation = object({
  ...interpretationFields,
  entries: Type.Array(object({ ...InteractionEntry.properties, unitIds: Type.Optional(ApprovalUnitIds) }), { minItems: 1, maxItems: 20 }),
  faithful: Type.Optional(Type.Boolean()),
  unitHints: Type.Optional(Type.Array(object({ id: ApprovalUnitId, globalConstraint: Type.Boolean(), appliesTo: ApprovalUnitIds, dependsOn: ApprovalUnitIds,
    retainedFactIds: UnitReview.properties.retainedFactIds }))),
});
type ModelEntry = Static<typeof ModelInterpretation>["entries"][number];
type Entry = Static<typeof InteractionEntry>;

const confirmed = (e: Entry) => ["explicit", "delegated"].includes(e.basis) && !["modify", "defer", "unclear"].includes(e.resolution);
const explicit = (e: Entry) => e.basis === "explicit" && !["modify", "defer", "unclear"].includes(e.resolution);
const invalid = (): never => { throw new UserInteractionError("invalid_shape"); };

/** 没有任何条目涉及、也未保留原依据的单位；只含分区单位 ID，供解释器改正遗漏。 */
export function uncoveredUnits(result: Static<typeof InteractionInterpretation>): string[] {
  return result.documentReview?.units.filter((u) => !u.conclusionIndexes.length && !u.retainedFactIds?.length).map((u) => u.id) ?? [];
}

/** 把模型回答转成标准解释结果；只做编号与闭包记账，是否可批准仍由 checkInterpretation 与 validateDocumentReview 判定。 */
export function deriveInterpretation(source: string, context: InteractionContext): Static<typeof InteractionInterpretation> {
  const model = parseInteraction(ModelInterpretation, source);
  let unitIds = model.entries.map((e) => e.unitIds ?? []);
  let entries: Entry[] = model.entries.map(({ unitIds: _unitIds, ...entry }: ModelEntry) => entry);
  const { faithful: modelFaithful, unitHints, ...rest } = model;
  let faithful = modelFaithful;
  const document = context.document;
  if (!document) {
    // 没有正文时 faithful: true 与空 unitHints 不带信息，照忽略；带了单位或表示不忠实的仍拒绝
    if (faithful === false || unitHints?.length || unitIds.some((ids) => ids.length)) invalid();
    return { ...rest, entries };
  }
  if (faithful === undefined) return invalid();
  const hint = (id: string) => unitHints?.find((h) => h.id === id);
  const candidateId = document.candidate.candidateId;
  // 字节没变且以前由用户明确确认过的段落，程序直接沿用原依据，不依赖模型每次都记得引用；
  // 模型说要修改、排除，或条目挂在某个问题下的，仍按模型的来
  const retainedFacts = new Map<string, string[]>(), retainedExclusion = new Map<string, boolean[]>();
  for (const e of context.retainedEvidence ?? []) {
    retainedFacts.set(e.unitId, [...(retainedFacts.get(e.unitId) ?? []), e.fact.id]);
    retainedExclusion.set(e.unitId, [...(retainedExclusion.get(e.unitId) ?? []), e.kind === "exclusion"]);
  }
  // 同一段里排除与确认两类原依据混在一起时不替模型决定
  const sameKind = (id: string) => new Set(retainedExclusion.get(id)).size === 1;
  const onlyUnconfirmed = (e: Entry) => e.kind === "unresolved" && e.requestId === null && !e.supersedes.length;
  const reused = new Set([...retainedFacts.keys()].filter((id) => sameKind(id) && !hint(id)?.retainedFactIds?.length &&
    entries.every((e, i) => e.kind === "action" || !unitIds[i]!.includes(id) || onlyUnconfirmed(e))));
  const stripped = unitIds.map((ids, i) => onlyUnconfirmed(entries[i]!) ? ids.filter((id) => !reused.has(id)) : ids);
  const emptied = stripped.map((ids, i) => unitIds[i]!.length > 0 && ids.length === 0);
  if (reused.size && !emptied.every(Boolean)) {
    const cleared = stripped.some((ids, i) => ids.length !== unitIds[i]!.length);
    entries = entries.filter((_, i) => !emptied[i]); unitIds = stripped.filter((_, i) => !emptied[i]);
    // 模型判不忠实的理由若只是这些段落没被重新确认，沿用之后就不再成立
    // 正文里写明的未决事项照样可以列为待定，不影响忠实；仍有要修改、暂缓或说不清的条目才算不忠实
    if (cleared && !entries.some((e) => ["modify", "defer", "unclear"].includes(e.resolution))) faithful = true;
  } else reused.clear();
  const units = document.partition.units.map(({ id }) => {
    let indexes = entries.flatMap((e, i) => e.kind !== "action" && unitIds[i]!.includes(id) ? [i] : []);
    // 身份与标题段：用户明确确认了同一候选的目标，即视为确认了这份草稿的身份；它永远不作动作目标
    if (id === "metadata" && !indexes.length) {
      indexes = entries.flatMap((e, i) => e.kind === "target" && explicit(e) && e.requestId === null && e.candidateId === candidateId ? [i] : []);
    }
    const related = indexes.map((i) => entries[i]!);
    const h = hint(id);
    const reusing = !h?.retainedFactIds?.length && reused.has(id) && !indexes.length;
    const retainedFactIds = h?.retainedFactIds?.length ? h.retainedFactIds : reusing ? retainedFacts.get(id) : undefined;
    const disposition = related.length && related.every((e) => e.kind === "exclusion" && explicit(e)) || reusing && retainedExclusion.get(id)![0] ? "excluded" as const
      : related.some((e) => !confirmed(e)) ? "pending-description" as const : "confirmed" as const;
    return { id, disposition, globalConstraint: h?.globalConstraint ?? false, appliesTo: h?.appliesTo ?? [], dependsOn: h?.dependsOn ?? [],
      conclusionIndexes: indexes, ...(retainedFactIds ? { retainedFactIds } : {}) };
  });
  const goalUnits = new Set(units.filter((u) => u.id !== "metadata" && u.conclusionIndexes.some((i) => entries[i]!.kind === "target" && explicit(entries[i]!))).map((u) => u.id));
  const targetGroups = entries.flatMap((e, i) => e.kind === "target" && explicit(e) ? [unitIds[i]!.filter((id) => goalUnits.has(id))] : []);
  const scopes = new Map<string, DocumentReview["actions"][number]>();
  entries.forEach((e, i) => {
    if (e.kind !== "action") return;
    // 用户确认的一条目标是整体：动作列了其中一段就覆盖整条，模型漏列同条目标里的其他段（如对应验收小节）不收窄授权
    const listed = unitIds[i]!.filter((id) => goalUnits.has(id));
    const goalIds = [...new Set([...listed, ...targetGroups.filter((group) => group.some((id) => listed.includes(id))).flat()])].sort();
    if (!goalIds.length) return;
    const constraintIds = approvalDependencyClosure(units, goalIds).filter((id) => !goalIds.includes(id));
    for (const action of e.actions as InteractionAction[]) {
      const key = JSON.stringify([action, goalIds, constraintIds]);
      const scope = scopes.get(key) ?? { action, goalIds, constraintIds, conclusionIndexes: [], unknown: false };
      scope.conclusionIndexes.push(i);
      scopes.set(key, scope);
    }
  });
  const questions = context.questions.map((q) => {
    const remaining = context.effectiveQuestions?.find((v) => v.requestId === q.requestId)?.remainingUnitIds ?? q.unitIds ?? [];
    const linked = entries.flatMap((e, i) => e.requestId === q.requestId ? [i] : []);
    const answeredIds = remaining.filter((id) => linked.some((i) => confirmed(entries[i]!) && unitIds[i]!.includes(id)));
    return { requestId: q.requestId, answeredIds, pendingIds: remaining.filter((id) => !answeredIds.includes(id)), conclusionIndexes: linked };
  });
  return { ...rest, entries, documentReview: { faithful, units, actions: [...scopes.values()], questions } };
}
