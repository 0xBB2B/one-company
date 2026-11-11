import { Type } from "typebox";
import { Value } from "typebox/value";
import { isPromise } from "node:util/types";
import { uuidv7, repositoryDatabase, withDatabase, StaleVersionError } from "../../core/storage/database.ts";
import type { LocalDatabase } from "../../core/storage/database.ts";
import { RequirementStateStore } from "./requirement-state.ts";
import type { RequirementStoreOptions } from "./requirement-state.ts";
import { checkRequirement, object, id, hash, positive, counter, checked } from "./requirement-contracts.ts";
import type { RequirementRecord } from "./requirement-contracts.ts";
import { parseDecisionBatch, decisionDigest, checkDecisionRecord, DecisionAdmission, ShortDecisionError } from "./short-decision-format.ts";
import type { DecisionBatch, ShortDecisionRecord } from "./short-decision-format.ts";
import { createProcessAnchorIn, extendLine, isRecordCountedIn, lineOf, linedRequirementIn } from "./line-anchors.ts";
import type { WorkingLines } from "./line-anchors.ts";

export interface DecisionAdmissionRequest {
  readonly repoId: string;
  readonly requestHash: string;
  readonly batch: Readonly<DecisionBatch>;
}
export interface ShortDecisionStoreOptions extends RequirementStoreOptions {
  /** 可信交互服务同步核对实际主体、归纳内容及适用范围；未接入时拒绝写入，不能由工具参数填充。 */
  admit?: (request: DecisionAdmissionRequest) => DecisionAdmission | null;
  lines?: WorkingLines;
}
const Operation = object({ requirementId: id, requestHash: hash, admissionHash: hash, decisionIds: Type.Array(id, { minItems: 1, maxItems: 20, uniqueItems: true }) });
const Event = object({ requirementId: id, repoId: hash, operationId: id, decisionId: id, decisionHash: hash, requirementVersion: positive, epoch: positive, recordedAt: counter });
const stream = (requirementId: string) => `short_decision_events:${requirementId}`;
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { for (const item of Object.values(value)) freeze(item); Object.freeze(value); }
  return value;
}
/** successors 是同一需求里带取代关系的决定；被取代者在某条线上已取代，当且仅当取代者在这条线上（counted）。 */
export function supersessionFrom(successors: readonly ShortDecisionRecord[], counted?: (decisionId: string) => boolean): (target: ShortDecisionRecord) => string | null {
  return (target) => target.status === "superseded" ? target.supersededBy
    : successors.find((d) => d.supersedes.includes(target.decisionId) && (!counted || counted(d.decisionId)))?.decisionId ?? null;
}
export function withSupersession(target: ShortDecisionRecord, supersededBy: string | null): ShortDecisionRecord {
  return supersededBy && target.status !== "superseded" ? { ...target, status: "superseded", supersededBy } : target;
}
/** 一次读出本需求带取代关系的决定，返回按当前线（counted）取"谁取代了它"的函数；excludeOperationId 那次操作的决定不算。 */
export function supersessionIn(db: LocalDatabase, requirementId: string, counted?: (decisionId: string) => boolean, excludeOperationId?: string): (target: ShortDecisionRecord) => string | null {
  return supersessionFrom(db.list<ShortDecisionRecord>("short_decisions").map((row) => row.data)
    .filter((d) => d.requirementId === requirementId && d.supersedes.length && d.operationId !== excludeOperationId), counted);
}
export function effectiveDecisionIn(db: LocalDatabase, target: ShortDecisionRecord, counted?: (decisionId: string) => boolean): ShortDecisionRecord {
  return withSupersession(target, supersessionIn(db, target.requirementId, counted)(target));
}
function available(record: RequirementRecord): void {
  if (record.recovery !== "ready" || !["draft", "active"].includes(record.lifecycle)) throw new ShortDecisionError("lifecycle_denied");
}

/** 内部短结论存储，不签发用户批准、不更新PRD基线、不注册模型工具。 */
export class ShortDecisionStore {
  private readonly options: ShortDecisionStoreOptions;
  private readonly state: RequirementStateStore;
  private constructor(options: ShortDecisionStoreOptions, state: RequirementStateStore) { this.options = options; this.state = state; }
  static async open(options: ShortDecisionStoreOptions): Promise<ShortDecisionStore> {
    const captured = { ...options };
    const state = await RequirementStateStore.open(captured);
    return new ShortDecisionStore(captured, state);
  }
  private path(): string { return repositoryDatabase(this.options.dataRoot, this.options.repoId); }
  private access(action: "record-decisions" | "read-decisions", input: Record<string, unknown>): void {
    const result = this.options.authorize?.(freeze({ action, repoId: this.options.repoId, input: structuredClone(input) }));
    if (isPromise(result)) void Promise.prototype.then.call(result, () => undefined, () => undefined);
    if (result !== true) throw new ShortDecisionError("authorization_required");
  }
  private admit(batch: DecisionBatch, requestHash: string): DecisionAdmission {
    const result = this.options.admit?.(freeze({ repoId: this.options.repoId, requestHash, batch: structuredClone(batch) }));
    if (isPromise(result)) void Promise.prototype.then.call(result, () => undefined, () => undefined);
    let admission: unknown;
    try { admission = structuredClone(result); } catch { throw new ShortDecisionError("trusted_admission_required"); }
    if (!Value.Check(DecisionAdmission, admission)) throw new ShortDecisionError("trusted_admission_required");
    if (admission.requestHash !== requestHash || admission.subjects.length !== batch.decisions.length ||
      admission.subjects.some((subject) => subject.status === "confirmed" && subject.basisReceiptId === null)) throw new ShortDecisionError("admission_mismatch");
    return admission;
  }
  private record(db: LocalDatabase, decisionId: string, requirementId: string): ShortDecisionRecord {
    const stored = db.read("short_decisions", decisionId);
    if (!stored || stored.id !== decisionId) throw new ShortDecisionError("unknown_decision");
    const record = checkDecisionRecord(stored.data);
    if (record.decisionId !== decisionId || record.requirementId !== requirementId || record.repoId !== this.options.repoId) throw new ShortDecisionError("decision_identity_conflict");
    return record;
  }

  append(source: string): { operationId: string; decisionIds: string[] } {
    const batch = parseDecisionBatch(source);
    const requestHash = decisionDigest({ repoId: this.options.repoId, batch });
    this.access("record-decisions", batch);
    const before = this.state.read(batch.requirementId); available(before.data);
    const admission = this.admit(batch, requestHash), admissionHash = decisionDigest(admission);
    const now = checked(counter, this.options.now?.() ?? Date.now());
    const ids = batch.decisions.map(() => uuidv7());
    const line = lineOf(this.options.lines, batch.requirementId);
    let anchor: string | undefined;
    const result = withDatabase(this.path(), (db) => db.transaction(() => {
      this.access("record-decisions", batch);
      const stored = db.read("requirements", batch.requirementId);
      if (!stored || stored.id !== batch.requirementId) throw new ShortDecisionError("unknown_requirement");
      const requirement = checkRequirement(stored.data, batch.requirementId, this.options.repoId); available(requirement);
      if (stored.version !== before.version || decisionDigest(requirement) !== decisionDigest(before.data)) throw new StaleVersionError();
      if (decisionDigest(this.admit(batch, requestHash)) !== admissionHash) throw new ShortDecisionError("admission_changed");
      if (requirement.epoch !== batch.epoch) throw new ShortDecisionError("epoch_changed");
      const operation = db.read("short_decision_operations", batch.operationId);
      if (operation) {
        const existing = checked(Operation, operation.data);
        if (existing.requirementId !== batch.requirementId || existing.requestHash !== requestHash || existing.admissionHash !== admissionHash) throw new ShortDecisionError("operation_conflict");
        if (existing.decisionIds.length !== batch.decisions.length) throw new ShortDecisionError("operation_conflict");
        for (const decisionId of existing.decisionIds) {
          if (this.record(db, decisionId, batch.requirementId).operationId !== batch.operationId) throw new ShortDecisionError("operation_conflict");
        }
        return { operationId: batch.operationId, decisionIds: existing.decisionIds };
      }
      const lined = linedRequirementIn(db, { ...stored, data: requirement }, line ?? []);
      if (lined.version !== batch.version) throw new StaleVersionError();
      if (decisionDigest(batch.prd) !== decisionDigest(requirement.lifecycle === "active" ? requirement.approved : lined.data.saved)) throw new ShortDecisionError("prd_reference_changed");
      const counted = line && ((key: string) => isRecordCountedIn(db, { namespace: "short_decisions", key, requirementId: batch.requirementId, line }));
            const countedDecision = line && ((decisionId: string) => isRecordCountedIn(db, { namespace: "short_decisions", key: decisionId, requirementId: batch.requirementId, line }));
      const supersededBy = supersessionIn(db, batch.requirementId, countedDecision), supersedingNow = new Set<string>();
      for (const [index, item] of batch.decisions.entries()) {
        const subject = admission.subjects[index]!, decisionId = ids[index]!;
        const record: ShortDecisionRecord = { format: "short-decision/v1", decisionId, operationId: batch.operationId,
          requirementId: batch.requirementId, repoId: this.options.repoId, requirementVersion: batch.version, epoch: batch.epoch,
          prd: batch.prd, ...item, ...subject, supersededBy: null, recordedAt: now };
        checkDecisionRecord(record);
        for (const target of item.supersedes) {
          const old = this.record(db, target, batch.requirementId);
          if (counted && !counted(target)) throw new ShortDecisionError("superseded_off_line");
          if (supersedingNow.has(target) || supersededBy(old) !== null || (subject.actor === "ai" && old.actor === "user") ||
            (subject.status === "pending" && old.status !== "pending")) throw new ShortDecisionError("supersede_denied");
          supersedingNow.add(target);
          if (!this.options.lines) db.update("short_decisions", target, db.read("short_decisions", target)!.version, { ...old, status: "superseded", supersededBy: decisionId });
        }
        db.create("short_decisions", decisionId, record, decisionId);
        db.append(stream(batch.requirementId), checked(Event, { requirementId: batch.requirementId, repoId: this.options.repoId,
          operationId: batch.operationId, decisionId, decisionHash: decisionDigest(record), requirementVersion: batch.version, epoch: batch.epoch, recordedAt: now }));
      }
      db.create("short_decision_operations", batch.operationId, { requirementId: batch.requirementId, requestHash, admissionHash, decisionIds: ids });
      if (this.options.lines) anchor = createProcessAnchorIn(db, { repoId: this.options.repoId, requirementId: batch.requirementId, kind: "decision", lines: this.options.lines, now,
        members: ids.map((key) => ({ namespace: "short_decisions", key })) });
      if (decisionDigest(this.admit(batch, requestHash)) !== admissionHash) throw new ShortDecisionError("admission_changed");
      this.access("record-decisions", batch);
      const after = db.read("requirements", batch.requirementId);
      if (!after || after.version !== stored.version || decisionDigest(after.data) !== decisionDigest(requirement)) throw new StaleVersionError();
      return { operationId: batch.operationId, decisionIds: ids };
    }));
    if (anchor && this.options.lines) extendLine(this.options.lines, batch.requirementId, anchor);
    return result;
  }

  read(requirementId: string, decisionId: string): ShortDecisionRecord {
    checked(id, decisionId);
    this.access("read-decisions", { requirementId, decisionId });
    const before = this.state.read(requirementId); available(before.data);
    const line = lineOf(this.options.lines, requirementId);
    const result = withDatabase(this.path(), (db) => {
      const record = this.record(db, decisionId, requirementId);
      if (line && !isRecordCountedIn(db, { namespace: "short_decisions", key: decisionId, requirementId, line })) throw new ShortDecisionError("unknown_decision");
      return effectiveDecisionIn(db, record, line && ((id) => isRecordCountedIn(db, { namespace: "short_decisions", key: id, requirementId, line })));
    });
    const after = this.state.read(requirementId); available(after.data);
    if (after.version !== before.version || decisionDigest(after.data) !== decisionDigest(before.data)) throw new StaleVersionError();
    this.access("read-decisions", { requirementId, decisionId });
    return result;
  }
}
