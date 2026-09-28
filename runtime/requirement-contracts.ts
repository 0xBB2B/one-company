import { Type } from "typebox";
import type { Static, TProperties, TSchema } from "typebox";
import { Value } from "typebox/value";
import { UUID_V7_PATTERN } from "./database.ts";

export const object = <P extends TProperties>(properties: P) => Type.Object(properties, { additionalProperties: false });
export const id = Type.String({ pattern: UUID_V7_PATTERN.source });
export const hash = Type.String({ pattern: "^[0-9a-f]{64}$" });
export const commit = Type.String({ pattern: "^(?:[0-9a-f]{40}|[0-9a-f]{64})$" });
export const counter = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
export const positive = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);
export const RecoveryReason = Type.Union([Type.Literal("archive_found"), Type.Literal("history_unknown"), Type.Literal("identity_conflict")]);
export const ProdReference = object({ commit, hash });
const manifestId = Type.String({ pattern: UUID_V7_PATTERN.source, minLength: 36, maxLength: 36 });
const manifestHash = Type.String({ pattern: "^[0-9a-f]{64}$", minLength: 64, maxLength: 64 });
const manifestProd = object({ commit: Type.String({ pattern: "^(?:[0-9a-f]{40}|[0-9a-f]{64})(?![\\s\\S])" }), hash: manifestHash });
export const ApprovalManifestReferenceSchema = object({ requirementId: manifestId, manifestHash,
  candidate: object({ candidateId: manifestId, operationId: manifestId, intentHash: manifestHash,
    from: nullable(manifestProd), to: manifestProd }) });
const summaryIds = Type.Array(Type.String({ pattern: "^[A-Za-z][A-Za-z0-9._-]{0,95}(?![\\s\\S])", maxLength: 96 }), { maxItems: 20, uniqueItems: true });
export const ApprovalSummary = object({ reference: ApprovalManifestReferenceSchema,
  confirmed: summaryIds, pending: summaryIds, excluded: summaryIds, blocked: summaryIds });
export type ApprovalSummary = Static<typeof ApprovalSummary>;
export const WorkspaceBinding = object({
  requirementId: id, repoId: hash, workspaceId: hash, prepareOperationId: id,
  path: Type.String({ minLength: 1, maxLength: 4096 }),
  gitDir: Type.String({ minLength: 1, maxLength: 4096 }),
  rootDevice: counter, rootInode: positive, gitDevice: counter, gitInode: positive,
  branch: Type.String({ pattern: "^refs/heads/[^\\u0000-\\u0020]+$", maxLength: 1024 }),
  baseCommit: commit,
});
export const CloseIntent = object({ operationId: id, reason: Type.Union([Type.Literal("completed"), Type.Literal("cancelled"), Type.Literal("rejected")]), receiptId: id });
export const RequirementRecord = object({
  format: Type.Literal("requirement-lifecycle/v1"), requirementId: id, repoId: hash,
  requestId: id, intentHash: hash,
  lifecycle: Type.Union([Type.Literal("draft"), Type.Literal("active"), Type.Literal("closing"), Type.Literal("closed")]),
  revision: counter, epoch: positive, saved: nullable(ProdReference), approved: nullable(ProdReference), approvalReceiptId: nullable(id),
  workspace: nullable(WorkspaceBinding), pendingRevision: nullable(positive), close: nullable(CloseIntent),
  approvalManifest: Type.Optional(ApprovalSummary),
  recovery: Type.Union([Type.Literal("ready"), Type.Literal("needs_review")]), recoveryReason: nullable(RecoveryReason), createdAt: counter, updatedAt: counter,
});
export type RequirementRecord = Static<typeof RequirementRecord>;
export type ProdReference = Static<typeof ProdReference>;
export type WorkspaceBinding = Static<typeof WorkspaceBinding>;
export type CloseIntent = Static<typeof CloseIntent>;
export const PmLease = object({
  requirementId: id, runId: id, workspaceId: hash, epoch: positive, fence: positive,
  contextGeneration: positive, expiresAt: counter,
});
export type PmLease = Static<typeof PmLease>;
/** 仅用于识别已有持久记录；此租约格式不能作为当前调用授权。 */
export const LegacyPmRecord = object({
  requirementId: id, fence: counter, seenSequence: counter,
  lease: nullable(object({ requirementId: id, runId: id, workspaceId: hash, epoch: positive, fence: positive, expiresAt: counter })),
});
export const PmContextBaseline = object({
  runId: id, fence: positive, contextGeneration: positive, revision: positive,
  reference: ProdReference, recordVersion: positive, epoch: positive,
});
export type PmContextBaseline = Static<typeof PmContextBaseline>;
export const PmContext = object({
  format: Type.Literal("pm-physical-context/v1"), runId: id, fence: positive,
  generation: positive, baseline: nullable(PmContextBaseline),
});
export type PmContext = Static<typeof PmContext>;
export const ApprovedProdChange = object({
  format: Type.Literal("approved-prod-change/v1"), requirementId: id, repoId: hash,
  fromRevision: nullable(positive), toRevision: positive,
  from: nullable(ProdReference), to: ProdReference, receiptId: id,
  lifecycleEpoch: positive, recordVersion: positive,
  changedSections: Type.Null(), impactReason: Type.Literal("section_structure_unavailable"),
  approvalManifest: Type.Optional(ApprovalSummary),
});
export type ApprovedProdChange = Static<typeof ApprovedProdChange>;
export const BaselineDelivery = object({
  deliveryId: id, throughSequence: counter, revision: positive, reference: ProdReference,
  recordVersion: positive, epoch: positive, runId: id, fence: positive, contextGeneration: positive,
  mode: Type.Union([Type.Literal("cursor_recovery"), Type.Literal("context_refresh")]),
});
export type BaselineDelivery = Static<typeof BaselineDelivery>;
export const PmEventCursor = object({
  format: Type.Literal("pm-prod-event-cursor/v1"), requirementId: id,
  deliveredSequence: counter, consumedSequence: counter,
  understoodRevision: nullable(positive), understood: nullable(ProdReference),
  baselineDelivery: nullable(BaselineDelivery),
});
export type PmEventCursor = Static<typeof PmEventCursor>;
export const PmRecord = object({
  requirementId: id, fence: counter, seenSequence: counter, lease: nullable(PmLease),
  prodEvents: Type.Optional(PmEventCursor), context: Type.Optional(PmContext),
});
export type PmRecord = Static<typeof PmRecord>;
export const OwnerClaim = object({ requirementId: id, workspaceId: hash });
export const RequestRecord = object({ requirementId: id, intentHash: hash });
export const RequirementEvent = object({
  requirementId: id, repoId: hash, kind: Type.Union([
    Type.Literal("reserved"), Type.Literal("workspace.bound"), Type.Literal("prod.saved"), Type.Literal("prod.approved"),
    Type.Literal("pm.acquired"), Type.Literal("pm.released"), Type.Literal("update.assessed"), Type.Literal("closing"), Type.Literal("closed"), Type.Literal("recovery.blocked"),
  ]), version: positive, epoch: positive, revision: counter, from: nullable(ProdReference), to: nullable(ProdReference), receiptId: nullable(id), recoveryReason: nullable(RecoveryReason),
  approvalManifest: Type.Optional(ApprovalSummary),
});
export type RequirementEvent = Static<typeof RequirementEvent>;
export const commands = {
  reserve: object({ requestId: id, intentHash: hash }),
  save: object({ requirementId: id, version: positive, operationId: id, reference: ProdReference }),
  approve: object({ requirementId: id, version: positive, receiptId: id, reference: ProdReference,
    manifest: Type.Optional(ApprovalManifestReferenceSchema) }),
  bind: object({ requirementId: id, version: positive, path: Type.String({ minLength: 1, maxLength: 4096 }), prepareOperationId: id, baseCommit: commit }),
  acquire: object({ requirementId: id, version: positive, runId: id, expectedFence: counter }),
  close: object({ requirementId: id, version: positive, intent: CloseIntent }),
  finish: object({ requirementId: id, version: positive, operationId: id }),
  block: object({ requirementId: id, version: positive, reason: RecoveryReason }),
  acknowledge: object({ lease: PmLease, sequence: counter }),
  assess: object({ lease: PmLease, version: positive, revision: positive, assessmentId: id,
    tasks: Type.Array(object({ taskId: Type.String({ minLength: 1, maxLength: 256 }), impact: Type.Union([Type.Literal("unaffected"), Type.Literal("affected"), Type.Literal("unknown")]),
      reason: Type.String({ maxLength: 1024 }) }), { minItems: 1, maxItems: 512 }) }),
  eventLease: object({ lease: PmLease }),
  rotateContext: object({ lease: PmLease }),
  restoreContext: object({ lease: PmLease, version: positive, epoch: positive, revision: positive, reference: ProdReference }),
  issueBaseline: object({ lease: PmLease, version: positive, epoch: positive, revision: positive, reference: ProdReference }),
  acknowledgeBaseline: object({ lease: PmLease, deliveryId: id }),
  eventDelivery: object({ lease: PmLease, eventId: id, sequence: positive }),
  acknowledgeApproved: object({ lease: PmLease, eventId: id, sequence: positive, revision: positive, reference: ProdReference }),
};

export class RequirementStateError extends Error {
  readonly code: string;
  constructor(code: string) { super(`需求状态操作被拒绝：${code}`); this.name = "RequirementStateError"; this.code = code; }
}

export function checked<T extends TSchema>(schema: T, input: unknown): Static<T> {
  let copy: unknown;
  try { copy = structuredClone(input); } catch { throw new RequirementStateError("invalid_shape"); }
  if (!Value.Check(schema, copy)) throw new RequirementStateError("invalid_shape");
  return copy as Static<T>;
}

export function checkRequirement(value: unknown, requirementId: string, repoId: string): RequirementRecord {
  const record = checked(RequirementRecord, value);
  if (record.requirementId !== requirementId || record.repoId !== repoId || record.updatedAt < record.createdAt ||
    ((record.approved === null) !== (record.approvalReceiptId === null)) || ((record.approved === null) !== (record.revision === 0)) ||
    (record.approved !== null && record.saved === null) ||
    (record.approvalManifest !== undefined && (!record.approved || record.approvalManifest.reference.requirementId !== requirementId ||
      record.approvalManifest.reference.candidate.to.commit !== record.approved.commit || record.approvalManifest.reference.candidate.to.hash !== record.approved.hash)) ||
    (record.lifecycle === "draft" && record.approved !== null) ||
    ((record.recovery === "ready") !== (record.recoveryReason === null)) ||
    (record.close?.reason === "completed" && (record.approved === null || record.workspace === null || record.pendingRevision !== null)) ||
    (record.lifecycle === "active" && record.approved === null) ||
    ((record.lifecycle === "closing" || record.lifecycle === "closed") !== (record.close !== null)) ||
    (record.pendingRevision !== null && record.pendingRevision !== record.revision) ||
    (record.workspace !== null && (record.workspace.requirementId !== requirementId || record.workspace.repoId !== repoId))) throw new RequirementStateError("invalid_state");
  return record;
}
