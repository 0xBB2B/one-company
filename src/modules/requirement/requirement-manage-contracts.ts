import { createHash } from "node:crypto";
import { COMMON_ADVICE, withDetail } from "./tool-failure.ts";
import type { FailureAdvice } from "./tool-failure.ts";
import { Type } from "typebox";
import type { Static, TProperties, TSchema } from "typebox";
import { Value } from "typebox/value";
import { UUID_V7_PATTERN } from "./database.ts";
import { canonicalJson } from "./strict-json.ts";
import { ApprovalManifestReferenceSchema, hash, RequirementDocSpecSchema } from "./requirement-contracts.ts";
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
  manifest: ApprovalManifestReferenceSchema, docSpec: Type.Optional(RequirementDocSpecSchema), prototypes: Type.Optional(hash) });
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
export type RequirementApprovalScope = { status: "available"; summary: ApprovalSummary };
export const ReadRequirementInput = strictObject({ requirementId: id, source: Type.Union([Type.Literal("saved"), Type.Literal("approved")]), revision: Type.Optional(revision) });
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
  savedOperationId: string | null;
  approvalScope?: RequirementApprovalScope;
}

const REREAD = "重新读取需求后按最新版本再试";
const INTERNAL = COMMON_ADVICE.internal_state;
const REQUIREMENT_SERVICE_ADVICE = {
  invalid_shape: COMMON_ADVICE.invalid_shape,
  invalid_prod_hash: { why: "需求正文指纹格式不对", next: INTERNAL.next },
  recovery_required: { why: "需求记录需要先恢复核对才能继续", next: "停止操作，请用户在主窗口完成恢复核对" },
  lifecycle_denied: { why: "需求当前的阶段不允许这个操作，可能正在关闭或已关闭", next: REREAD },
  authorization_required: { why: "宿主没有授权这次需求操作", next: "停止操作，不要重试；在回复里说明，由上级处理" },
  working_copy_mismatch: { why: "需求工作副本与登记的版本不一致", next: INTERNAL.next },
  manifest_candidate_mismatch: { why: "批准清单对应的不是当前保存的版本", next: REREAD },
  repository_identity_missing: { why: "读不到仓库身份", next: INTERNAL.next },
  repository_identity_mismatch: { why: "仓库身份与需求登记的不一致", next: INTERNAL.next },
  manifest_stale: { why: "批准范围确认后需求又被改动", next: "重新读取需求，按最新版本请用户确认" },
  manifest_authorization_required: { why: "宿主没有授权这份批准清单", next: "请用户在主窗口重新确认批准" },
  requirement_write_busy: { why: "这个需求正有另一次保存在进行", next: "等几秒再试" },
  requirement_write_pending: { why: "这个需求还有一次没完成的保存", next: "用原来的操作编号重试那次保存，完成后再做新的" },
  write_recovery_required: { why: "上一次保存中途中断，需要先恢复", next: "用原来的操作编号重试那次保存" },
  unfinished_requirement_operation: { why: "这个需求还有没完成的保存或批准", next: "先用原来的操作编号完成它" },
  operation_conflict: { why: "同一操作编号已用于内容不同的请求", next: "换一个新生成的操作编号重试" },
  operation_missing: { why: "找不到这个操作编号对应的保存记录", next: "核对操作编号，或按新的操作重新保存" },
  operation_not_ready: { why: "保存操作还没进行到这一步", next: "用原来的操作编号重试，让它继续完成" },
  operation_state_mismatch: { why: "保存操作的记录与实际状态不一致", next: INTERNAL.next },
  operation_corrupt: { why: "保存操作记录已损坏", next: INTERNAL.next },
  stale_version: { why: "需求在读取后已被改动，提交用的版本号过期了", next: REREAD },
  epoch_changed: { why: "需求已换代（epoch 变化）", next: REREAD },
  saved_version_changed: { why: "保存所基于的上一版本已变化", next: REREAD },
  state_changed_before_storage: { why: "保存前需求被并发改动", next: REREAD },
  state_changed_after_git: { why: "写入版本库后需求被并发改动", next: "用原来的操作编号重试，让它续完" },
  state_changed_during_read: { why: "读取期间需求被并发改动", next: "重新读取一次" },
  version_unavailable: { why: "需求还没有这个版本（可能尚未保存或尚未批准）", next: "先确认需求已保存或已批准，再读取" },
  invalid_revision_range: { why: "请求的批准版本范围不存在", next: "按需求当前的批准版本号重新指定范围" },
  unknown_revision: { why: "找不到这个批准版本", next: "按需求当前的批准版本号重新指定" },
  saved_operation_mismatch: { why: "保存记录与当前保存版本不一致", next: INTERNAL.next },
  unknown_requirement: { why: "找不到这个需求", next: "核对需求编号" },
  git_result_mismatch: { why: "版本库写入结果与记录不一致", next: INTERNAL.next },
  git_result_missing: { why: "版本库写入结果缺失", next: "用原来的操作编号重试，让它续完" },
  approval_not_ready: { why: "这次保存不是可批准的更新", next: "先保存需求，再按用户原话确认批准" },
  invalid_time: { why: "系统时间不可用", next: INTERNAL.next },
  invalid_write_owner: { why: "保存占用记录不合规", next: INTERNAL.next },
  write_claim_corrupt: { why: "保存占用记录已损坏", next: INTERNAL.next },
  invalid_write_claim: { why: "保存占用记录不合规", next: INTERNAL.next },
  write_claim_lost: { why: "保存过程中占用被别的进程拿走", next: "等几秒后用原来的操作编号重试" },
  manifest_store_limit: { why: "批准清单涉及的章节、决定或内容超出上限", next: "拆小需求或减少一次批准的范围" },
  manifest_decision_missing: { why: "批准清单引用的用户决定不存在", next: "按用户原话重新登记决定后再批准" },
  manifest_retained_escape: { why: "批准清单引用了保留事实以外的内容", next: "只引用本版本保留的事实" },
  manifest_decision_mismatch: { why: "用户决定针对的不是这个待批准版本", next: "请用户对当前版本重新确认" },
  manifest_decision_not_confirmed: { why: "批准依据的用户决定还没确认，或已被新的决定取代", next: "重新读取需求，按用户最新的决定处理" },
  manifest_action_not_user: { why: "授权动作只能由用户决定", next: "按用户原话登记后再批准" },
  manifest_pending_mismatch: { why: "待说明的章节与未决决定不对应", next: "按待说明章节重新整理后再确认" },
  manifest_unregistered: { why: "批准清单没有登记", next: "先按用户原话确认批准范围" },
  manifest_binding_mismatch: { why: "批准清单与需求当前状态不对应", next: REREAD },
  manifest_input_changed: { why: "确认批准范围后用户又有新的输入", next: "按用户最新原话重新确认" },
  manifest_not_approved: { why: "这份批准清单不是需求当前的批准依据", next: REREAD },
  manifest_decisions_changed: { why: "批准清单引用的用户决定已变化", next: "请用户按当前情况重新确认" },
  manifest_scope_changed: { why: "批准范围在读取期间变化", next: "重新读取一次" },
  manifest_admission_required: { why: "批准前没有登记用户确认", next: "先按用户原话确认批准范围" },
  manifest_input_proof_required: { why: "批准缺少用户输入的核对依据", next: "按用户当前原话重新确认" },
  manifest_reentry: { why: "上一次批准还没结束", next: "等上一次批准结束后再试" },
  manifest_admission_changed: { why: "批准过程中确认内容变化", next: "请用户重新确认" },
  manifest_conflict: { why: "同一批准清单已登记为不同内容", next: INTERNAL.next },
} as const satisfies Record<string, FailureAdvice>;
export type RequirementServiceErrorCode = keyof typeof REQUIREMENT_SERVICE_ADVICE;

export class RequirementServiceError extends Error {
  readonly code: RequirementServiceErrorCode;
  readonly advice: FailureAdvice;
  constructor(code: RequirementServiceErrorCode, message: string = code) {
    super(message);
    this.name = "RequirementServiceError";
    this.code = code;
    this.advice = withDetail(REQUIREMENT_SERVICE_ADVICE[code], message === code ? undefined : message);
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
