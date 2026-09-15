import { Type } from "typebox";
import { DatabaseSync } from "node:sqlite";
import { repositoryDatabase } from "./database.ts";
import type { LocalDatabase, StoredRecord } from "./database.ts";
import { checkRequirement, object } from "./requirement-contracts.ts";
import { decisionDigest, checkDecisionRecord } from "./short-decision-format.ts";
import { InteractionBasis, CandidateBinding, ApprovalPartition, ContinuityRecordRef, InteractionEntry, PendingQuestion, checkInteraction, UserInteractionError, resolvesContinuityIssue } from "./user-interaction-format.ts";
import type { InteractionContext, InteractionInterpretation, DocumentAnalysis, RetainedUnitEvidence, EffectiveQuestion, ContinuityIssue, RevisionSource } from "./user-interaction-format.ts";
import type { ShortDecisionRecord } from "./short-decision-format.ts";
import { REQUIREMENT_OPERATION_NAMESPACE } from "./requirement-coordination.ts";
import type { RequirementOperation } from "./requirement-operations.ts";

export const INTERACTION_CONTINUITY_NAMESPACE = "interaction_resolution_facts_v1";
const id = CandidateBinding.properties.candidateId;
const Unit = object({ id: ApprovalPartition.properties.units.items.properties.id, hash: CandidateBinding.properties.intentHash });
const Fact = object({ format: Type.Literal("interaction-resolution-fact/v1"), repoId: CandidateBinding.properties.intentHash,
  basis: InteractionBasis, candidate: CandidateBinding, partition: ApprovalPartition, operationId: id, receiptId: id,
  savedOperation: ContinuityRecordRef,
  byteReview: Type.Optional(object({ accepted: Type.Boolean(), units: Type.Array(object({ ...Unit.properties,
    disposition: Type.Union([Type.Literal("confirmed"), Type.Literal("pending-description"), Type.Literal("excluded")]),
    globalConstraint: Type.Boolean(), appliesTo: Type.Array(Unit.properties.id, { maxItems: 16 }),
    dependsOn: Type.Array(Unit.properties.id, { maxItems: 16 }) }), { minItems: 1, maxItems: 20 }) })),
  decisions: Type.Array(object({ record: ContinuityRecordRef, kind: InteractionEntry.properties.kind,
    basis: InteractionEntry.properties.basis, resolution: InteractionEntry.properties.resolution,
    unitIds: Type.Array(Unit, { maxItems: 20 }), requestId: InteractionEntry.properties.requestId }), { minItems: 1, maxItems: 20 }),
  resolvedIssues: Type.Optional(Type.Array(object({ fact: ContinuityRecordRef, originDecision: ContinuityRecordRef, unit: Unit }), { maxItems: 40 })),
  questions: Type.Array(object({ requestId: id, originalHash: CandidateBinding.properties.intentHash,
    accepted: Type.Array(Unit, { maxItems: 16 }), modified: Type.Array(Unit, { maxItems: 16 }), pending: Type.Optional(Type.Array(Unit, { maxItems: 16 })) }), { maxItems: 20 }) });
type FactData = import("typebox").Static<typeof Fact>;
const same = (a: unknown, b: unknown) => decisionDigest(a) === decisionDigest(b);
function deny(code: string): never { throw new UserInteractionError(code); }
function ref(row: StoredRecord) { return { id: row.id, version: row.version, hash: decisionDigest(row.data) }; }
function checkRef(row: StoredRecord | null, expected: { id: string; version: number; hash: string }): StoredRecord {
  if (!row || !same(ref(row), expected)) deny("continuity_source_changed"); return row;
}
function checkedFact(row: StoredRecord): FactData {
  if (row.version !== 1) deny("continuity_fact_mutated");
  const f = checkInteraction(Fact, row.data);
  if (row.id !== f.operationId || f.partition.prodHash !== f.candidate.to.hash || f.byteReview &&
    (f.byteReview.units.length !== f.partition.units.length || f.byteReview.units.some((u, i) => u.id !== f.partition.units[i]!.id || u.hash !== f.partition.units[i]!.hash))) deny("continuity_fact_identity");
  return f;
}
function savedMatches(row: StoredRecord, f: FactData): void {
  const op = row.data as RequirementOperation;
  if (op.format !== "requirement-service-operation/v1" || op.repoId !== f.repoId || op.requirementId !== f.basis.requirementId ||
    op.epoch !== f.basis.epoch || !op.finalVersion || op.finalVersion > f.basis.version || op.git?.hash !== f.candidate.to.hash ||
    op.git.commit !== f.candidate.to.commit) deny("continuity_version_source");
}
/** 只在真实Core短决定保存后调用；仅保存来源元数据，固定operation使失败补登记不再写决定。 */
export function recordInteractionResolutionIn(db: LocalDatabase, repoId: string, context: InteractionContext, result: InteractionInterpretation,
  saved: { operationId: string; decisionIds: string[] }, receiptId: string): void {
  if (!context.document || !context.savedOperationId) return;
  const savedOperation = db.read(REQUIREMENT_OPERATION_NAMESPACE, context.savedOperationId);
  if (!savedOperation) deny("continuity_version_source");
  const doc = context.document, review = result.documentReview!;
  const units = (ids: string[]) => ids.map((id) => { const u = doc.partition.units.find((u) => u.id === id); if (!u) return deny("continuity_unit_missing"); return { id, hash: u.hash }; });
  const fact: FactData = { format: "interaction-resolution-fact/v1", repoId, basis: context.basis, candidate: doc.candidate, partition: doc.partition,
    operationId: saved.operationId, receiptId, savedOperation: ref(savedOperation),
    byteReview: { accepted: review.faithful && result.referenceResolution !== "ambiguous", units: review.units.map((u) => ({
      ...units([u.id])[0]!, disposition: u.disposition, globalConstraint: u.globalConstraint, appliesTo: u.appliesTo, dependsOn: u.dependsOn })) },
    decisions: result.entries.map((entry, index) => {
      const row = db.read("short_decisions", saved.decisionIds[index]!); if (!row) return deny("continuity_decision_missing");
      const d = checkDecisionRecord(row.data);
      if (d.operationId !== saved.operationId || d.requirementVersion !== context.basis.version || d.epoch !== context.basis.epoch ||
        d.requirementId !== context.basis.requirementId || d.status === "superseded") deny("continuity_decision_mismatch");
      return { record: ref(row), kind: entry.kind, basis: entry.basis, resolution: entry.resolution, requestId: entry.requestId,
        unitIds: units(review.units.filter((u) => u.conclusionIndexes.includes(index)).map((u) => u.id)) };
    }),
    resolvedIssues: (context.continuityIssues ?? []).filter((issue) => resolvesContinuityIssue(context, result, issue))
      .map((issue) => ({ fact: issue.fact, originDecision: issue.originDecision, unit: { id: issue.unitId, hash: issue.unitHash } })),
    questions: context.questions.map((q) => {
      const mapped = review.questions.find((r) => r.requestId === q.requestId)!;
      const accepted = mapped.answeredIds.filter((id) => review.faithful && result.referenceResolution !== "ambiguous" &&
        review.units.find((u) => u.id === id)!.disposition !== "pending-description" && review.units.find((u) => u.id === id)!.conclusionIndexes.some((i) =>
        result.entries[i]?.requestId === q.requestId && result.entries[i]?.basis === "explicit" && ["direct", "accept"].includes(result.entries[i]!.resolution)));
      const modified = (q.unitIds ?? []).filter((id) => review.units.find((u) => u.id === id)?.conclusionIndexes.some((i) =>
        result.entries[i]?.requestId === q.requestId && result.entries[i]?.resolution === "modify"));
      return { requestId: q.requestId, originalHash: decisionDigest(q), accepted: units(accepted), modified: units(modified), pending: units(mapped.pendingIds) };
    }) };
  checkInteraction(Fact, fact); savedMatches(savedOperation, fact);
  const old = db.read(INTERACTION_CONTINUITY_NAMESPACE, saved.operationId);
  if (old && (old.version !== 1 || !same(old.data, fact))) deny("continuity_fact_conflict");
  if (!old) db.create(INTERACTION_CONTINUITY_NAMESPACE, saved.operationId, fact, saved.operationId);
}
function acceptedUnit(fact: FactData, unitId: string, kind?: string): boolean {
  const unit = fact.byteReview?.units.find((u) => u.id === unitId);
  return fact.byteReview?.accepted === true && unit !== undefined && unit.disposition !== "pending-description" &&
    (kind === undefined || unit.disposition === (kind === "exclusion" ? "excluded" : "confirmed"));
}
/** 原来源只解释已接受的未改字节；缺少原文审核证明的事实只能作描述/修订参考。 */
export function assertRetainedEvidenceIn(db: Pick<LocalDatabase, "read">, repoId: string, basis: InteractionBasis, doc: Pick<DocumentAnalysis, "partition">, e: RetainedUnitEvidence): void {
  const row = checkRef(db.read(INTERACTION_CONTINUITY_NAMESPACE, e.fact.id), e.fact), fact = checkedFact(row);
  const source = fact.decisions.find((d) => d.record.id === e.decision.id);
  if (fact.repoId !== repoId || fact.basis.requirementId !== basis.requirementId || fact.basis.epoch !== basis.epoch || fact.basis.version > basis.version ||
    !same(fact.basis, e.sourceBasis) || !same(fact.candidate, e.sourceBinding) || !source || !same(source.record, e.decision) ||
    source.kind !== e.kind || source.basis !== "explicit" || !["direct", "accept"].includes(source.resolution) || !acceptedUnit(fact, e.unitId, e.kind) ||
    !source.unitIds.some((u) => u.id === e.unitId && u.hash === e.unitHash) || !doc.partition.units.some((u) => u.id === e.unitId && u.hash === e.unitHash)) deny("continuity_source_mismatch");
  const decision = checkDecisionRecord(checkRef(db.read("short_decisions", e.decision.id), e.decision).data);
  if (decision.actor !== "user" || decision.status !== "confirmed" || decision.basisReceiptId !== fact.receiptId ||
    decision.requirementId !== basis.requirementId || decision.requirementVersion !== fact.basis.version || decision.epoch !== basis.epoch ||
    !same(decision.prod, fact.basis.prod)) deny("continuity_decision_changed");
  savedMatches(checkRef(db.read(REQUIREMENT_OPERATION_NAMESPACE, fact.savedOperation.id), fact.savedOperation), fact);
}
type ProofRow = StoredRecord & { key?: string };
function collectionProof(facts: ProofRow[], questions: ProofRow[], read: Pick<LocalDatabase, "read">["read"]): string {
  if (facts.length > 128 || questions.length > 256 || [...facts, ...questions].reduce((n, row) => n + Buffer.byteLength(JSON.stringify(row.data)), 0) > 2_097_152) deny("continuity_scan_limit");
  const ids = new Set(facts.flatMap((row) => checkedFact(row).decisions.map((decision) => decision.record.id)));
  const records = (rows: ProofRow[]) => rows.map((row) => ({ ...ref(row), key: row.key ?? row.id })).sort((a, b) => a.key.localeCompare(b.key) || a.id.localeCompare(b.id));
  return decisionDigest({ facts: records(facts), questions: records(questions), decisions: [...ids].sort().map((id) => {
    const row = read("short_decisions", id); return { id, value: row ? ref(row) : null };
  }) });
}
/** 在调用方现有SQLite快照中核对整个输入集合，覆盖新增/删除；不向调用方返回其他需求元数据。 */
export function continuityInputProofIn(db: LocalDatabase, requirementId: string, inputCheck?: { excludeOperationId: string; originals: ReadonlyMap<string, StoredRecord<ShortDecisionRecord>> }): string {
  const belongs = (row: StoredRecord) => (row.data as { basis?: { requirementId?: unknown } } | null)?.basis?.requirementId === requirementId;
  const facts = db.list(INTERACTION_CONTINUITY_NAMESPACE).filter((row) => belongs(row) && row.id !== inputCheck?.excludeOperationId);
  const questions = db.list("interaction_questions_v1").filter(belongs);
  const read = <T = unknown>(namespace: string, key: string): StoredRecord<T> | null => {
    const original = namespace === "short_decisions" ? inputCheck?.originals.get(key) : undefined;
    return original ? original as unknown as StoredRecord<T> : db.read<T>(namespace, key);
  };
  return collectionProof(facts, questions, read);
}
/** 查询只读取有界元数据。超过扫描预算拒绝，绝不截掉未答问题。 */
export function loadInteractionContinuity(dataRoot: string, repoId: string, basis: InteractionBasis, doc: DocumentAnalysis,
  inputCheck?: { excludeOperationId: string; originals: ReadonlyMap<string, StoredRecord<ShortDecisionRecord>>;
    replacements: ReadonlyMap<string, StoredRecord<ShortDecisionRecord>> }) {
  const db = new DatabaseSync(repositoryDatabase(dataRoot, repoId), { readOnly: true });
  try {
    db.exec("BEGIN");
    const actualRead = <T = unknown>(namespace: string, key: string): StoredRecord<T> | null => {
      const r = db.prepare("SELECT id,version,data FROM records WHERE namespace=? AND record_key=?").get(namespace, key);
      return r ? { id: String(r.id), version: Number(r.version), data: JSON.parse(String(r.data)) as T } : null;
    };
    // 输入对照只允许本次准确的双向取代；不会恢复数据库或向授权器提供旧决定。
    const read = <T = unknown>(namespace: string, key: string): StoredRecord<T> | null => {
      const actual = actualRead<T>(namespace, key);
      const original = namespace === "short_decisions" ? inputCheck?.originals.get(key) : undefined;
      if (!original) return actual;
      const changed = actual?.data as ShortDecisionRecord | undefined;
      const replacement = changed?.supersededBy ? inputCheck!.replacements.get(changed.supersededBy) : undefined;
      if (!actual || actual.id !== original.id || actual.version !== original.version + 1 || !replacement ||
        replacement.data.operationId !== inputCheck!.excludeOperationId || !replacement.data.supersedes.includes(key) ||
        !same(actual.data, { ...original.data, status: "superseded", supersededBy: replacement.id }) ||
        !same(actualRead("short_decisions", replacement.id), replacement)) deny("continuity_revision_changed");
      return original as unknown as StoredRecord<T>;
    };
    const current = read("requirements", basis.requirementId);
    if (!current || current.version !== basis.version) deny("continuity_state_changed");
    const requirement = checkRequirement(current.data, basis.requirementId, repoId);
    if (requirement.epoch !== basis.epoch || requirement.recovery !== "ready" || !["draft", "active"].includes(requirement.lifecycle) || !same(requirement.saved, doc.candidate.to)) deny("continuity_state_changed");
    const scan = (namespace: string, jsonPath: string, max: number) => {
      const rows = db.prepare("SELECT record_key,id,version,data FROM records WHERE namespace=? AND json_extract(data,?)=? ORDER BY id LIMIT ?").all(namespace, jsonPath, basis.requirementId, max + 1);
      if (rows.length > max || rows.reduce((n, r) => n + Buffer.byteLength(String(r.data)), 0) > 1_048_576) deny("continuity_scan_limit");
      return rows.map((r) => ({ id: String(r.id), key: String(r.record_key), version: Number(r.version), data: JSON.parse(String(r.data)) }));
    };
    const facts = scan(INTERACTION_CONTINUITY_NAMESPACE, "$.basis.requirementId", 128)
      .filter((row) => row.id !== inputCheck?.excludeOperationId).map((row) => ({ row, fact: checkedFact(row) }));
    type Source = { row: StoredRecord; fact: FactData; decision: FactData["decisions"][number] };
    const sources = facts.flatMap(({ row, fact }) => fact.decisions.map((decision) => ({ row, fact, decision })));
    const byDecision = new Map(sources.map((source) => [source.decision.record.id, source]));
    const currentSource = (source: Source) => {
      const { fact, decision: d } = source;
      if (fact.repoId !== repoId || fact.basis.requirementId !== basis.requirementId || fact.basis.epoch !== basis.epoch || fact.basis.version > basis.version) return null;
      savedMatches(checkRef(read(REQUIREMENT_OPERATION_NAMESPACE, fact.savedOperation.id), fact.savedOperation), fact);
      const row = read("short_decisions", d.record.id); if (!row) return null;
      const value = checkDecisionRecord(row.data);
      if (value.repoId !== repoId || value.requirementId !== basis.requirementId || value.epoch !== basis.epoch || value.operationId !== fact.operationId ||
        value.requirementVersion !== fact.basis.version || value.basisReceiptId !== null && value.basisReceiptId !== fact.receiptId || !same(value.prod, fact.basis.prod)) return null;
      if (value.status !== "superseded") return same(ref(row), d.record) &&
        value.basisReceiptId === (value.status === "confirmed" ? fact.receiptId : null) ? { row, value } : null;
      // 原字段只能发生ShortDecisionStore的单次状态取代，不能把任意行变化解释成修订。
      if (row.version !== d.record.version + 1 || !["confirmed", "pending"].some((status) => decisionDigest({ ...value, status, supersededBy: null }) === d.record.hash)) return null;
      return { row, value };
    };
    const latestSource = (source: Source, unitId: string, seen = new Set<string>()): Source | null => {
      if (seen.has(source.decision.record.id) || seen.size >= 32) return null;
      seen.add(source.decision.record.id);
      const current = currentSource(source); if (!current) return null;
      if (current.value.status !== "superseded") return source;
      const next = byDecision.get(current.value.supersededBy!); if (!next) return null;
      const nextCurrent = currentSource(next);
      if (!nextCurrent || !nextCurrent.value.supersedes.includes(source.decision.record.id) || next.fact.basis.version < source.fact.basis.version ||
        !next.decision.unitIds.some((u) => u.id === unitId) && !(next.decision.kind === "exclusion" && !doc.partition.units.some((u) => u.id === unitId))) return null;
      return latestSource(next, unitId, seen);
    };
    const sourceAcceptsCurrentUnit = (source: Source, unitId: string): boolean => {
      const current = currentSource(source); if (!current || current.value.status !== "confirmed" || current.value.actor !== "user") return false;
      const unit = doc.partition.units.find((u) => u.id === unitId);
      return unit ? source.decision.unitIds.some((u) => u.id === unit.id && u.hash === unit.hash && acceptedUnit(source.fact, u.id, source.decision.kind))
        : source.decision.kind === "exclusion" && source.decision.unitIds.some((u) => acceptedUnit(source.fact, u.id, "exclusion"));
    };
    const questions: PendingQuestion[] = [], effectiveQuestions: EffectiveQuestion[] = [], retainedEvidence: RetainedUnitEvidence[] = [], continuityIssues: ContinuityIssue[] = [];
    const priors = new Map<string, ShortDecisionRecord>(), revisionSources = new Map<string, RevisionSource>();
    for (const source of sources) {
      const current = currentSource(source), d = source.decision;
      if (current?.value.status !== "superseded" && current && d.kind !== "action" && d.unitIds.some((u) => u.id !== "metadata")) {
        priors.set(d.record.id, current.value);
        revisionSources.set(d.record.id, { fact: ref(source.row), decision: ref(current.row), sourceBasis: source.fact.basis, unitIds: d.unitIds, kind: d.kind });
      }
      if (!d.unitIds.length || !(d.resolution === "modify" || ["defer", "unclear"].includes(d.resolution) || ["proposed", "uncertain"].includes(d.basis))) continue;
      if (!current) deny("continuity_issue_source_changed");
      for (const unit of d.unitIds.filter((u) => u.id !== "metadata")) {
        const latest = latestSource(source, unit.id), target = doc.partition.units.find((u) => u.id === unit.id);
        if (latest && sourceAcceptsCurrentUnit(latest, unit.id)) continue;
        if (facts.some(({ row, fact }) => fact.resolvedIssues?.some((resolution) => same(resolution.fact, ref(source.row)) &&
          same(resolution.originDecision, d.record) && resolution.unit.id === unit.id && resolution.unit.hash === unit.hash) &&
          fact.decisions.some((decision) => { const next = latestSource({ row, fact, decision }, unit.id); return next && sourceAcceptsCurrentUnit(next, unit.id); }))) continue;
        // 真正的新字节经后续完整审核后可解决重存待办；同hash或只改其他单位不能解决。
        if (target && target.hash !== unit.hash && sources.some((s) => s.fact.basis.version > source.fact.basis.version && sourceAcceptsCurrentUnit(s, unit.id))) continue;
        const policy = source.fact.byteReview?.units.find((u) => u.id === unit.id);
        const affected = new Set<string>(target ? [target.id] : []);
        if (!policy && d.kind === "constraint" || policy?.globalConstraint) {
          for (const id of policy?.appliesTo.length ? policy.appliesTo : doc.partition.units.filter((u) => u.id !== "metadata").map((u) => u.id)) affected.add(id);
        }
        let changed = true;
        while (changed) {
          changed = false;
          for (const u of source.fact.byteReview?.units ?? []) {
            if (!affected.has(u.id) && u.dependsOn.some((id) => affected.has(id))) { affected.add(u.id); changed = true; }
            if (affected.has(u.id) && u.globalConstraint) for (const id of u.appliesTo.length ? u.appliesTo : doc.partition.units.filter((unit) => unit.id !== "metadata").map((unit) => unit.id)) {
              if (!affected.has(id)) { affected.add(id); changed = true; }
            }
          }
        }
        const questionRefs = source.fact.byteReview?.accepted && d.resolution !== "modify" ? source.fact.questions
          .filter((q) => q.pending?.some((u) => u.id === unit.id && u.hash === unit.hash)).map((q) => ({ requestId: q.requestId, hash: q.originalHash })) : [];
        continuityIssues.push({ fact: ref(source.row), originDecision: d.record, decision: ref(latest ? currentSource(latest)!.row : current.row), questionRefs, unitId: unit.id, unitHash: unit.hash,
          targetHash: target?.hash ?? null, affectedUnitIds: [...affected].filter((id) => doc.partition.units.some((u) => u.id === id)), reason: d.resolution === "modify" ? "modify" : "pending" });
      }
    }
    for (const source of sources) {
      const { row, fact, decision: d } = source;
      if (!["target", "constraint", "exclusion"].includes(d.kind) || d.basis !== "explicit" || !["direct", "accept"].includes(d.resolution)) continue;
      for (const u of d.unitIds) {
        if (!doc.partition.units.some((current) => current.id === u.id && current.hash === u.hash) || continuityIssues.some((issue) => issue.unitId === u.id)) continue;
        const e: RetainedUnitEvidence = { fact: ref(row), decision: d.record, sourceBasis: fact.basis, sourceBinding: fact.candidate,
          unitId: u.id, unitHash: u.hash, kind: d.kind as RetainedUnitEvidence["kind"] };
        try { assertRetainedEvidenceIn({ read }, repoId, basis, doc, e); retainedEvidence.push(e); } catch { /* 无效来源不授予字节许可 */ }
      }
    }
    const questionRows = scan("interaction_questions_v1", "$.basis.requirementId", 256);
    for (const row of questionRows) {
      const q = checkInteraction(PendingQuestion, row.data);
      if (row.version !== 1 || row.id !== q.requestId || q.repoId !== repoId || !q.unitIds?.length || q.basis.epoch !== basis.epoch) deny("continuity_question_identity");
      const resolved = new Set<string>(), resolutions: EffectiveQuestion["resolutions"] = [];
      for (const { row: frow, fact } of facts) {
        const answer = fact.questions.find((a) => a.requestId === q.requestId && a.originalHash === decisionDigest(q));
        if (!answer || fact.basis.epoch !== basis.epoch) continue;
        for (const unit of answer.accepted) {
          if (!acceptedUnit(fact, unit.id)) continue;
          const relevant = fact.decisions.filter((d) => d.requestId === q.requestId && d.unitIds.some((u) => u.id === unit.id));
          if (relevant.length && relevant.every((d) => { const latest = latestSource({ row: frow, fact, decision: d }, unit.id); return latest && sourceAcceptsCurrentUnit(latest, unit.id); })) {
            resolved.add(unit.id);
            if (!resolutions.some((r) => r.id === frow.id)) resolutions.push(ref(frow));
          }
        }
      }
      const remaining = q.unitIds.filter((id) => !resolved.has(id));
      if (!remaining.length) continue;
      const unitMappings = q.unitIds.map((id) => ({ id, sourceHash: q.partition?.units.find((u) => u.id === id)?.hash ?? q.candidate?.to.hash ?? "0".repeat(64),
        targetHash: doc.partition.units.find((u) => u.id === id)?.hash ?? null }));
      const unchanged = q.partition ? unitMappings.every((u) => u.sourceHash === u.targetHash) : same(q.candidate?.to, doc.candidate.to);
      questions.push(q); effectiveQuestions.push({ requestId: q.requestId, originalHash: decisionDigest(q), remainingUnitIds: remaining,
        currentBinding: doc.candidate, mode: unchanged ? "unchanged" : "requires-explicit-review", resolutions, unitMappings });
    }
    for (const [id, decision] of priors) if (decision.status === "pending" && !continuityIssues.some((issue) => issue.decision.id === id || issue.originDecision.id === id)) {
      priors.delete(id); revisionSources.delete(id);
    }
    if (questions.length > 20 || retainedEvidence.length > 40 || priors.size > 20 || continuityIssues.length > 40) deny("interaction_context_limit");
    const result = { questions, effectiveQuestions, retainedEvidence, continuityIssues, priorDecisions: [...priors.values()], revisionSources: [...revisionSources.values()],
      inputProof: collectionProof(facts.map((item) => item.row), questionRows, read) };
    if (Buffer.byteLength(JSON.stringify(result)) > 49_152) deny("interaction_context_limit");
    db.exec("COMMIT"); return result;
  } finally { db.close(); }
}
