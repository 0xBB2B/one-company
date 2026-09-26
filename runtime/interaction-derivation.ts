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
    retainedFactIds: UnitReview.properties.retainedFactIds }), { maxItems: 20 })),
});
type ModelEntry = Static<typeof ModelInterpretation>["entries"][number];
type Entry = Static<typeof InteractionEntry>;

const confirmed = (e: Entry) => ["explicit", "delegated"].includes(e.basis) && !["modify", "defer", "unclear"].includes(e.resolution);
const explicit = (e: Entry) => e.basis === "explicit" && !["modify", "defer", "unclear"].includes(e.resolution);
const invalid = (): never => { throw new UserInteractionError("invalid_shape"); };

/** 把模型回答转成标准解释结果；只做编号与闭包记账，是否可批准仍由 checkInterpretation 与 validateDocumentReview 判定。 */
export function deriveInterpretation(source: string, context: InteractionContext): Static<typeof InteractionInterpretation> {
  const model = parseInteraction(ModelInterpretation, source);
  const unitIds = model.entries.map((e) => e.unitIds ?? []);
  const entries: Entry[] = model.entries.map(({ unitIds: _unitIds, ...entry }: ModelEntry) => entry);
  const { faithful, unitHints, ...rest } = model;
  const document = context.document;
  if (!document) {
    if (faithful !== undefined || unitHints !== undefined || unitIds.some((ids) => ids.length)) invalid();
    return { ...rest, entries };
  }
  if (faithful === undefined) return invalid();
  const hint = (id: string) => unitHints?.find((h) => h.id === id);
  const candidateId = document.candidate.candidateId;
  const units = document.partition.units.map(({ id }) => {
    let indexes = entries.flatMap((e, i) => e.kind !== "action" && unitIds[i]!.includes(id) ? [i] : []);
    // 身份与标题段：用户明确确认了同一候选的目标，即视为确认了这份草稿的身份；它永远不作动作目标
    if (id === "metadata" && !indexes.length) {
      indexes = entries.flatMap((e, i) => e.kind === "target" && explicit(e) && e.requestId === null && e.candidateId === candidateId ? [i] : []);
    }
    const related = indexes.map((i) => entries[i]!);
    const disposition = related.length && related.every((e) => e.kind === "exclusion" && explicit(e)) ? "excluded" as const
      : related.some((e) => !confirmed(e)) ? "pending-description" as const : "confirmed" as const;
    const h = hint(id);
    return { id, disposition, globalConstraint: h?.globalConstraint ?? false, appliesTo: h?.appliesTo ?? [], dependsOn: h?.dependsOn ?? [],
      conclusionIndexes: indexes, ...(h?.retainedFactIds?.length ? { retainedFactIds: h.retainedFactIds } : {}) };
  });
  const goalUnits = new Set(units.filter((u) => u.id !== "metadata" && u.conclusionIndexes.some((i) => entries[i]!.kind === "target" && explicit(entries[i]!))).map((u) => u.id));
  const scopes = new Map<string, DocumentReview["actions"][number]>();
  entries.forEach((e, i) => {
    if (e.kind !== "action") return;
    const goalIds = unitIds[i]!.filter((id) => goalUnits.has(id)).sort();
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
