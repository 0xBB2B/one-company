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

export interface DecisionAdmissionRequest {
  readonly repoId: string;
  readonly requestHash: string;
  readonly batch: Readonly<DecisionBatch>;
}
export interface ShortDecisionStoreOptions extends RequirementStoreOptions {
  /** 可信交互服务同步核对实际主体、归纳内容及适用范围；未接入时拒绝写入，不能由工具参数填充。 */
  admit?: (request: DecisionAdmissionRequest) => DecisionAdmission | null;
}
const Operation = object({ requirementId: id, requestHash: hash, admissionHash: hash, decisionIds: Type.Array(id, { minItems: 1, maxItems: 20, uniqueItems: true }) });
const Event = object({ requirementId: id, repoId: hash, operationId: id, decisionId: id, decisionHash: hash, requirementVersion: positive, epoch: positive, recordedAt: counter });
const stream = (requirementId: string) => `short_decision_events:${requirementId}`;
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { for (const item of Object.values(value)) freeze(item); Object.freeze(value); }
  return value;
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
    return withDatabase(this.path(), (db) => db.transaction(() => {
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
      if (stored.version !== batch.version) throw new StaleVersionError();
      if (decisionDigest(batch.prd) !== decisionDigest(requirement.lifecycle === "active" ? requirement.approved : requirement.saved)) throw new ShortDecisionError("prd_reference_changed");
      for (const [index, item] of batch.decisions.entries()) {
        const subject = admission.subjects[index]!, decisionId = ids[index]!;
        const record: ShortDecisionRecord = { format: "short-decision/v1", decisionId, operationId: batch.operationId,
          requirementId: batch.requirementId, repoId: this.options.repoId, requirementVersion: batch.version, epoch: batch.epoch,
          prd: batch.prd, ...item, ...subject, supersededBy: null, recordedAt: now };
        checkDecisionRecord(record);
        for (const target of item.supersedes) {
          const old = this.record(db, target, batch.requirementId);
          if (old.status === "superseded" || (subject.actor === "ai" && old.actor === "user") ||
            (subject.status === "pending" && old.status !== "pending")) throw new ShortDecisionError("supersede_denied");
          const version = db.read("short_decisions", target)!.version;
          db.update("short_decisions", target, version, { ...old, status: "superseded", supersededBy: decisionId });
        }
        db.create("short_decisions", decisionId, record, decisionId);
        db.append(stream(batch.requirementId), checked(Event, { requirementId: batch.requirementId, repoId: this.options.repoId,
          operationId: batch.operationId, decisionId, decisionHash: decisionDigest(record), requirementVersion: batch.version, epoch: batch.epoch, recordedAt: now }));
      }
      db.create("short_decision_operations", batch.operationId, { requirementId: batch.requirementId, requestHash, admissionHash, decisionIds: ids });
      if (decisionDigest(this.admit(batch, requestHash)) !== admissionHash) throw new ShortDecisionError("admission_changed");
      this.access("record-decisions", batch);
      const after = db.read("requirements", batch.requirementId);
      if (!after || after.version !== stored.version || decisionDigest(after.data) !== decisionDigest(requirement)) throw new StaleVersionError();
      return { operationId: batch.operationId, decisionIds: ids };
    }));
  }

  read(requirementId: string, decisionId: string): ShortDecisionRecord {
    checked(id, decisionId);
    this.access("read-decisions", { requirementId, decisionId });
    const before = this.state.read(requirementId); available(before.data);
    const result = withDatabase(this.path(), (db) => this.record(db, decisionId, requirementId));
    const after = this.state.read(requirementId); available(after.data);
    if (after.version !== before.version || decisionDigest(after.data) !== decisionDigest(before.data)) throw new StaleVersionError();
    this.access("read-decisions", { requirementId, decisionId });
    return result;
  }
}
