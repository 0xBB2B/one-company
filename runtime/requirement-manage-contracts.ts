import { createHash } from "node:crypto";
import { Type } from "typebox";
import type { Static, TProperties, TSchema } from "typebox";
import { Value } from "typebox/value";
import { UUID_V7_PATTERN } from "./database.ts";
import { canonicalJson } from "./strict-json.ts";
import { ApprovalManifestReferenceSchema } from "./requirement-contracts.ts";
import type { ApprovalSummary, ProdReference, WorkspaceBinding } from "./requirement-contracts.ts";
import type { ApprovalManifestReference } from "./approval-manifest.ts";
import type { CandidateBinding, InteractionBasis } from "./user-interaction-format.ts";
import type { ProdApprovalPartition } from "./prod-view.ts";

const strictObject = <P extends TProperties>(properties: P) => Type.Object(properties, { additionalProperties: false });
const id = Type.String({ pattern: UUID_V7_PATTERN.source });
const version = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const revision = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const text = Type.String();

export const RequirementServiceAction = Type.Union([
  Type.Literal("create"),
  Type.Literal("updateDraft"),
  Type.Literal("confirmUpdate"),
  Type.Literal("readSaved"),
  Type.Literal("readApproved"),
  Type.Literal("diff"),
  Type.Literal("metadata"),
]);
export type RequirementServiceAction = Static<typeof RequirementServiceAction>;

export interface ServiceAuthorizationRequest {
  readonly action: RequirementServiceAction;
  readonly repoId: string;
  readonly requestId?: string;
  readonly operationId?: string;
  readonly requirementId?: string;
  readonly intentHash?: string;
  readonly prodHash?: `sha256:${string}`;
  readonly version?: number;
  readonly epoch?: number;
  readonly receiptId?: string;
  readonly manifest?: ApprovalManifestReference;
}

export const CreateRequirementInput = strictObject({ requestId: id, operationId: id, title: text, body: text });
export const UpdateDraftInput = strictObject({ requirementId: id, operationId: id, version, title: text, body: text });
export const ConfirmUpdateInput = strictObject({ requirementId: id, operationId: id, version, title: text, body: text, receiptId: id,
  manifest: Type.Optional(ApprovalManifestReferenceSchema) });
const confirmationId = ApprovalManifestReferenceSchema.properties.requirementId;
export const LoadConfirmationInput = strictObject({ requirementId: confirmationId, savedOperationId: confirmationId, operationId: confirmationId });
export type LoadConfirmationInput = Static<typeof LoadConfirmationInput>;
export interface ConfirmationContext {
  requirementId: string; repoId: string; version: number; epoch: number;
  basis: InteractionBasis; candidate: CandidateBinding; savedOperationId: string;
  saved: ProdReference; approved: ProdReference | null; workspace: WorkspaceBinding | null;
  title: string; body: string; partition: ProdApprovalPartition;
  difference: { kind: "full_candidate"; from: null; to: ProdReference; text: string }
    | { kind: "diff"; from: ProdReference; to: ProdReference; text: string };
}
export type RequirementApprovalScope = { status: "available"; summary: ApprovalSummary } | { status: "unavailable" };
export const ReadRequirementInput = strictObject({ requirementId: id, source: Type.Union([Type.Literal("saved"), Type.Literal("approved")]) });
export const DiffRequirementInput = strictObject({ requirementId: id, fromRevision: revision, toRevision: Type.Optional(revision) });
export const MetadataRequirementInput = id;

export type CreateRequirementInput = Static<typeof CreateRequirementInput>;
export type UpdateDraftInput = Static<typeof UpdateDraftInput>;
export type ConfirmUpdateInput = Static<typeof ConfirmUpdateInput>;
export type ReadRequirementInput = Static<typeof ReadRequirementInput>;
export type DiffRequirementInput = Static<typeof DiffRequirementInput>;

export type RequirementWriteStatus = "created" | "saved" | "unchanged" | "recovered";

export interface RequirementReceipt {
  action: "create" | "updateDraft" | "confirmUpdate";
  operationId: string;
  requirementId: string;
  commit: string;
  prodHash: `sha256:${string}`;
  status: RequirementWriteStatus;
  archivePath: string;
  lifecycle: "draft" | "active";
  version: number;
  epoch: number;
  revision: number;
  approvalScope?: RequirementApprovalScope;
}

export interface RequirementReadResult {
  requirementId: string;
  source: "saved" | "approved";
  commit: string;
  prodHash: `sha256:${string}`;
  version: number;
  epoch: number;
  title: string;
  body: string;
  approvalScope?: RequirementApprovalScope;
}

export interface RequirementDiffResult {
  requirementId: string;
  fromRevision: number;
  toRevision: number;
  fromCommit: string;
  toCommit: string;
  fromHash: `sha256:${string}`;
  toHash: `sha256:${string}`;
  version: number;
  epoch: number;
  diff: string;
  approvalScope?: RequirementApprovalScope;
}

export interface RequirementMetadataResult {
  requirementId: string;
  lifecycle: "draft" | "active" | "closing" | "closed";
  recovery: "ready" | "needs_review";
  version: number;
  epoch: number;
  revision: number;
  saved: { commit: string; prodHash: `sha256:${string}` } | null;
  approved: { commit: string; prodHash: `sha256:${string}` } | null;
  archivePath: string | null;
  approvalScope?: RequirementApprovalScope;
}

export class RequirementServiceError extends Error {
  readonly code: string;
  constructor(code: string, message = code) {
    super(message);
    this.name = "RequirementServiceError";
    this.code = code;
  }
}

export function checkServiceInput<T extends TSchema>(schema: T, input: unknown): Static<T> {
  let copy: unknown;
  try { copy = structuredClone(input); }
  catch { throw new RequirementServiceError("invalid_shape", "参数必须是可复制的纯数据"); }
  if (!Value.Check(schema, copy)) throw new RequirementServiceError("invalid_shape", "参数不符合固定字段白名单");
  return copy as Static<T>;
}

/** title/body 的授权绑定指纹；只返回摘要，不保存或回显正文。 */
export function requirementIntentHash(input: { title: string; body: string }): string {
  const checkedInput = checkServiceInput(strictObject({ title: text, body: text }), input);
  return createHash("sha256").update(canonicalJson({ title: checkedInput.title, body: checkedInput.body })).digest("hex");
}
