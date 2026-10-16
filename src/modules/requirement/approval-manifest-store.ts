import { Type } from "typebox";
import { isPromise } from "node:util/types";
import { repositoryDatabase, withDatabase } from "../../core/storage/database.ts";
import type { LocalDatabase, StoredRecord } from "../../core/storage/database.ts";
import { ApprovalManifestReferenceSchema, checkRequirement, checked, object, positive, hash, id } from "./requirement-contracts.ts";
import type { ApprovalSummary, RequirementRecord } from "./requirement-contracts.ts";
import { ApprovalManifest, approvalDependencyClosure, approvalManifestReference, checkApprovalManifest } from "./approval-manifest.ts";
import type { ApprovalManifestExpected, ApprovalManifestReference } from "./approval-manifest.ts";
import { checkDecisionRecord, decisionDigest } from "./short-decision-format.ts";
import { ApprovalPartition } from "./user-interaction-format.ts";
import { RequirementServiceError } from "./requirement-manage-contracts.ts";
import type { RequirementApprovalScope, RequirementServiceErrorCode } from "./requirement-manage-contracts.ts";
import { assertRetainedEvidenceIn, continuityInputProofIn } from "./interaction-continuity.ts";

export const APPROVAL_MANIFEST_NAMESPACE = "approval_manifests_v1";
export interface ManifestAdmission { receiptId: string; version: number; epoch: number; inputProof?: string }
export interface ManifestAccessRequest { action: "register" | "read"; repoId: string; reference: ApprovalManifestReference }
export interface ApprovalManifestStoreOptions {
  dataRoot: string; repoId: string;
  /** 只能接可信服务的真实saved loader；不得使用工具传入的partition。 */
  loadExpected: (reference: ApprovalManifestReference) => Promise<ApprovalManifestExpected>;
  authorize?: (request: Readonly<ManifestAccessRequest>) => boolean;
  /** register必须重新调用当前Core.authorizeDocument，不把JSON或持久行当成能力。 */
  admit?: (request: Readonly<ManifestAccessRequest>) => ManifestAdmission | null;
}
const Admission = object({ receiptId: id, version: positive, epoch: positive, inputProof: Type.Optional(hash) });
const Stored = object({ format: Type.Literal("stored-approval-manifest/v1"), repoId: hash,
  admission: Admission, partition: ApprovalPartition,
  decisionRecords: Type.Array(object({ id, version: positive, hash }), { minItems: 1, maxItems: 40 }),
  manifest: ApprovalManifest });
interface StoredManifest {
  format: "stored-approval-manifest/v1"; repoId: string; admission: ManifestAdmission;
  partition: ApprovalManifestExpected["partition"]; manifest: ApprovalManifest;
  decisionRecords: Array<{ id: string; version: number; hash: string }>;
}
function deny(code: RequirementServiceErrorCode): never { throw new RequirementServiceError(code); }
function same(a: unknown, b: unknown): boolean { return decisionDigest(a) === decisionDigest(b); }
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function sync(value: unknown): unknown {
  if (isPromise(value)) { void Promise.prototype.then.call(value, () => undefined, () => undefined); deny("manifest_authorization_required"); }
  return value;
}
function current(db: LocalDatabase, repoId: string, requirementId: string): StoredRecord<RequirementRecord> {
  const stored = db.read("requirements", requirementId);
  if (!stored) deny("unknown_requirement");
  const data = checkRequirement(stored.data, requirementId, repoId);
  if (data.recovery !== "ready" || !["draft", "active"].includes(data.lifecycle)) deny("lifecycle_denied");
  return { ...stored, data };
}
function decisionSnapshots(db: LocalDatabase, manifest: ApprovalManifest, admission: ManifestAdmission, repoId: string) {
  const ids = [...new Set([...manifest.units, ...manifest.actions, ...manifest.questions].flatMap((u) => u.decisionIds))];
  if (ids.length > 40) deny("manifest_store_limit");
  const records = ids.map((decisionId) => {
    const stored = db.read("short_decisions", decisionId);
    if (!stored || stored.id !== decisionId) deny("manifest_decision_missing");
    const d = checkDecisionRecord(stored.data);
    const retained = manifest.retainedSources?.filter((e) => e.decision.id === decisionId) ?? [];
    if (retained.length) {
      const used = manifest.units.filter((u) => u.decisionIds.includes(decisionId));
      if (!used.length || manifest.actions.some((a) => a.decisionIds.includes(decisionId)) || manifest.questions.some((q) => q.decisionIds.includes(decisionId)) ||
        used.some((u) => !retained.some((e) => e.unitId === u.id && e.unitHash === u.hash && u.retainedFactIds?.includes(e.fact.id)))) deny("manifest_retained_escape");
      for (const e of retained) assertRetainedEvidenceIn(db, repoId, { requirementId: manifest.requirementId, version: admission.version, epoch: admission.epoch, prod: manifest.candidate.from },
        { partition: { prodHash: manifest.candidate.to.hash, totalBytes: manifest.totalBytes, units: manifest.units.map(({ id, hash, startByte, endByte }) => ({ id, hash, startByte, endByte })) } }, e);
      return { stored, d, retained: true };
    }
    if (d.decisionId !== decisionId || d.requirementId !== manifest.requirementId || d.repoId !== repoId ||
      d.epoch !== admission.epoch || d.requirementVersion !== admission.version || d.status === "superseded" || !same(d.prod, manifest.candidate.from) ||
      ![manifest.candidate.to.commit, manifest.candidate.to.hash].every((ref) => d.references.includes(ref))) deny("manifest_decision_mismatch");
    return { stored, d, retained: false };
  });
  const candidateRefs = [manifest.candidate.candidateId, manifest.candidate.intentHash, manifest.candidate.to.commit, manifest.candidate.to.hash];
  let sources = 0;
  for (const { d, retained } of records) {
    if (retained) { sources++; continue; }
    const units = manifest.units.filter((u) => u.decisionIds.includes(d.decisionId));
    const actions = manifest.actions.filter((a) => a.decisionIds.includes(d.decisionId));
    const confirmedUse = units.some((u) => u.disposition !== "pending-description") || actions.length > 0;
    const prior = confirmedUse && d.basisReceiptId !== admission.receiptId;
    if (prior) {
      sources++;
      // 原来源只支撑本批明确复制的同单位约束，不能成为目标、动作或问题答复依据。
      const copies = records.filter(({ d: copy }) => copy.actor === "user" && copy.status === "confirmed" &&
        copy.basisReceiptId === admission.receiptId && !copy.supersedes.length &&
        same([...copy.references].sort(), [...new Set([...candidateRefs, d.decisionId])].sort()) &&
        copy.conclusion === d.conclusion && copy.scope === d.scope);
      if (d.actor !== "user" || d.status !== "confirmed" || !d.basisReceiptId || !units.length || actions.length ||
        manifest.questions.some((q) => q.decisionIds.includes(d.decisionId)) || units.some((u) => u.disposition !== "confirmed" ||
          manifest.actions.some((a) => a.goalIds.includes(u.id)) ||
          !copies.some(({ d: copy }) => u.decisionIds.includes(copy.decisionId) &&
            !manifest.actions.some((a) => a.decisionIds.includes(copy.decisionId)) &&
            !manifest.questions.some((q) => q.decisionIds.includes(copy.decisionId))))) deny("manifest_decision_not_confirmed");
    } else {
      if (!candidateRefs.every((ref) => d.references.includes(ref))) deny("manifest_decision_mismatch");
      if (confirmedUse && d.status !== "confirmed") deny("manifest_decision_not_confirmed");
    }
    if (actions.length && d.actor !== "user") deny("manifest_action_not_user");
    if (units.some((u) => u.disposition === "pending-description") && d.status !== "pending") deny("manifest_pending_mismatch");
  }
  // 单次短决定仍限20条；额外20条仅容纳Core核验的独立约束原来源。
  if (sources > 20 || records.length - sources > 20) deny("manifest_store_limit");
  return records.map(({ stored, d }) => ({ id: d.decisionId, version: stored.version, hash: decisionDigest(d) }));
}
export function summarizeApprovalManifest(m: ApprovalManifest): ApprovalSummary {
  return { reference: approvalManifestReference(m),
    confirmed: m.units.filter((u) => u.disposition === "confirmed").map((u) => u.id),
    pending: m.units.filter((u) => u.disposition === "pending-description").map((u) => u.id),
    excluded: m.units.filter((u) => u.disposition === "excluded").map((u) => u.id),
    blocked: m.units.filter((u) => u.disposition === "confirmed" && (approvalDependencyClosure(m.units, [u.id])
      .some((id) => m.units.find((unit) => unit.id === id)!.disposition !== "confirmed") ||
      m.actions.some((a) => a.unknown && a.goalIds.includes(u.id)))).map((u) => u.id) };
}
/** 仅供已授权服务在其短事务中复核。存在行不是授权，调用者必须先完成本次动作授权。 */
export function registeredApprovalManifestIn(db: LocalDatabase, repoId: string, reference: ApprovalManifestReference,
  record: StoredRecord<RequirementRecord>, receiptId?: string): ApprovalManifest {
  const ref = checked(ApprovalManifestReferenceSchema, reference);
  const actual = current(db, repoId, ref.requirementId);
  if (actual.version !== record.version || !same(actual.data, record.data)) deny("manifest_stale");
  const row = db.read(APPROVAL_MANIFEST_NAMESPACE, ref.manifestHash);
  if (!row) deny("manifest_unregistered");
  if (Buffer.byteLength(JSON.stringify(row.data)) > 65_536) deny("manifest_store_limit");
  const s = checked(Stored, row.data) as StoredManifest;
  const m = checkApprovalManifest(s.manifest, { requirementId: ref.requirementId, candidate: ref.candidate, partition: s.partition });
  if (s.repoId !== repoId || !same(approvalManifestReference(m), ref) || record.id !== ref.requirementId ||
    record.data.recovery !== "ready" || !["draft", "active"].includes(record.data.lifecycle) || s.admission.epoch !== record.data.epoch) deny("manifest_binding_mismatch");
  if (receiptId !== undefined) {
    if (s.admission.receiptId !== receiptId || record.version !== s.admission.version || !same(record.data.saved, ref.candidate.to)) deny("manifest_stale");
    if (!s.admission.inputProof || continuityInputProofIn(db, ref.requirementId) !== s.admission.inputProof) deny("manifest_input_changed");
  } else if (!same(record.data.approvalManifest?.reference ?? null, ref) || !same(record.data.approved, ref.candidate.to)) deny("manifest_not_approved");
  if (!same(decisionSnapshots(db, m, s.admission, repoId), s.decisionRecords)) deny("manifest_decisions_changed");
  return m;
}

/** 仅供已授权的内部返回路径使用；调用方在最后一次await/宿主回调后开启同步DB快照，摘要不是授权。 */
export function assertApprovalScopeReturnIn(db: LocalDatabase, repoId: string, record: StoredRecord<RequirementRecord>,
  scope: RequirementApprovalScope | undefined): void {
  const actual = current(db, repoId, record.id);
  if (actual.version !== record.version || !same(actual.data, record.data)) deny("manifest_stale");
  const manifest = actual.data.approvalManifest;
  const expected = manifest && { status: "available", summary: summarizeApprovalManifest(registeredApprovalManifestIn(db, repoId, manifest.reference, actual)) };
  if (!same(scope ?? null, expected ?? null) || manifest && !same(manifest, expected!.summary)) deny("manifest_scope_changed");
}

export interface RegisteredScopeReturnProof {
  reference: ApprovalManifestReference;
  admission: ManifestAdmission;
  summary: ApprovalSummary;
}
/** 登记结果的窄检查；不要求active、不产生批准或恢复Core行为能力。 */
export function assertRegisteredScopeReturnIn(db: LocalDatabase, repoId: string, record: StoredRecord<RequirementRecord>, proof: RegisteredScopeReturnProof): void {
  const manifest = registeredApprovalManifestIn(db, repoId, proof.reference, record, proof.admission.receiptId);
  const row = db.read(APPROVAL_MANIFEST_NAMESPACE, proof.reference.manifestHash);
  if (!row) deny("manifest_unregistered");
  const stored = checked(Stored, row.data) as StoredManifest;
  if (!same(stored.admission, proof.admission) || !same(summarizeApprovalManifest(manifest), proof.summary)) deny("manifest_scope_changed");
}

/** 仅元数据复用data.db；不初始化新后端、不保存正文、不激活prod。 */
export class ApprovalManifestStore {
  readonly #options: ApprovalManifestStoreOptions;
  #busy = false;
  constructor(options: ApprovalManifestStoreOptions) { this.#options = { ...options }; }
  #request(action: ManifestAccessRequest["action"], reference: ApprovalManifestReference): ManifestAccessRequest {
    return freeze({ action, repoId: this.#options.repoId, reference: checked(ApprovalManifestReferenceSchema, reference) });
  }
  #access(request: ManifestAccessRequest): void {
    if (sync(this.#options.authorize?.(request)) !== true) deny("manifest_authorization_required");
  }
  #admit(request: ManifestAccessRequest): ManifestAdmission {
    const value = sync(this.#options.admit?.(request));
    if (!value) deny("manifest_admission_required");
    const admission = checked(Admission, value);
    if (!admission.inputProof) deny("manifest_input_proof_required");
    return admission;
  }
  async register(value: unknown): Promise<ApprovalManifestReference> {
    if (this.#busy) deny("manifest_reentry");
    this.#busy = true;
    try {
      // 从候选中只取严格引用以请求可信loader，完整字段仍由checkApprovalManifest校验。
      const raw = value as ApprovalManifest;
      const ref = checked(ApprovalManifestReferenceSchema, { requirementId: raw?.requirementId, candidate: raw?.candidate, manifestHash: raw?.manifestHash });
      const request = this.#request("register", ref); this.#access(request);
      const admission = this.#admit(request);
      const expected = await this.#options.loadExpected(ref);
      const manifest = checkApprovalManifest(value, expected);
      this.#access(request);
      if (!same(this.#admit(request), admission)) deny("manifest_admission_changed");
      // Core核验会使用自己的SQLite快照，必须在此写事务外完成；事务内只比较固定依据。
      const path = repositoryDatabase(this.#options.dataRoot, this.#options.repoId);
      return withDatabase(path, (db) => db.transaction(() => {
        const before = current(db, this.#options.repoId, ref.requirementId);
        if (before.version !== admission.version || before.data.epoch !== admission.epoch || !same(before.data.saved, ref.candidate.to)) deny("manifest_stale");
        if (continuityInputProofIn(db, ref.requirementId) !== admission.inputProof) deny("manifest_input_changed");
        const stored: StoredManifest = { format: "stored-approval-manifest/v1", repoId: this.#options.repoId, admission,
          partition: expected.partition, manifest, decisionRecords: decisionSnapshots(db, manifest, admission, this.#options.repoId) };
        checked(Stored, stored);
        if (Buffer.byteLength(JSON.stringify(stored)) > 65_536) deny("manifest_store_limit");
        const old = db.read(APPROVAL_MANIFEST_NAMESPACE, ref.manifestHash);
        if (old && !same(old.data, stored)) deny("manifest_conflict");
        if (!old) db.create(APPROVAL_MANIFEST_NAMESPACE, ref.manifestHash, stored);
        const after = current(db, this.#options.repoId, ref.requirementId);
        if (after.version !== before.version || !same(after.data, before.data) ||
          !same(decisionSnapshots(db, manifest, admission, this.#options.repoId), stored.decisionRecords)) deny("manifest_stale");
        return ref;
      }));
    } finally { this.#busy = false; }
  }
  read(reference: ApprovalManifestReference): ApprovalManifest {
    if (this.#busy) deny("manifest_reentry");
    this.#busy = true;
    try {
      const request = this.#request("read", reference); this.#access(request);
      return withDatabase(repositoryDatabase(this.#options.dataRoot, this.#options.repoId), (db) => db.transaction(() => {
        const before = current(db, this.#options.repoId, reference.requirementId);
        const m = registeredApprovalManifestIn(db, this.#options.repoId, request.reference, before);
        const after = current(db, this.#options.repoId, reference.requirementId);
        if (after.version !== before.version || !same(after.data, before.data)) deny("manifest_stale");
        registeredApprovalManifestIn(db, this.#options.repoId, request.reference, after);
        return m;
      }));
    } finally { this.#busy = false; }
  }
}
