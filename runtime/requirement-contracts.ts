import { Type } from "typebox";
import { COMMON_ADVICE, withDetail } from "./tool-failure.ts";
import type { FailureAdvice } from "./tool-failure.ts";
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
export const RequirementDocSpecSchema = object({
  sections: Type.Array(object({ id: Type.String({ pattern: "^[a-zA-Z][a-zA-Z0-9._-]{0,95}$" }), title: Type.String({ minLength: 1, maxLength: 200 }),
    record: Type.Optional(Type.Union([Type.Literal("implementation"), Type.Literal("acceptance")])), goal: Type.Optional(Type.Literal(true)) }), { minItems: 1, maxItems: 64 }),
  skillHash: Type.String({ pattern: "^sha256:[0-9a-f]{64}$" }),
});
const manifestId = Type.String({ pattern: UUID_V7_PATTERN.source, minLength: 36, maxLength: 36 });
const manifestHash = Type.String({ pattern: "^[0-9a-f]{64}$", minLength: 64, maxLength: 64 });
const manifestProd = object({ commit: Type.String({ pattern: "^(?:[0-9a-f]{40}|[0-9a-f]{64})(?![\\s\\S])" }), hash: manifestHash });
export const ApprovalManifestReferenceSchema = object({ requirementId: manifestId, manifestHash,
  candidate: object({ candidateId: manifestId, operationId: manifestId, intentHash: manifestHash,
    from: nullable(manifestProd), to: manifestProd }) });
const summaryIds = Type.Array(Type.String({ pattern: "^[A-Za-z][A-Za-z0-9._-]{0,95}(?![\\s\\S])", maxLength: 96 }), { uniqueItems: true });
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
  approvalManifest: Type.Optional(ApprovalSummary), docSpec: Type.Optional(RequirementDocSpecSchema),
  recovery: Type.Union([Type.Literal("ready"), Type.Literal("needs_review")]), recoveryReason: nullable(RecoveryReason), createdAt: counter, updatedAt: counter,
});
export type RequirementRecord = Static<typeof RequirementRecord>;
export type ProdReference = Static<typeof ProdReference>;
export type WorkspaceBinding = Static<typeof WorkspaceBinding>;
export type CloseIntent = Static<typeof CloseIntent>;
export const PmLease = object({
  requirementId: id, runId: id, workspaceId: hash, epoch: positive, fence: positive,
  contextGeneration: positive,
});
export type PmLease = Static<typeof PmLease>;
export const PmContextBaseline = object({
  runId: id, fence: positive, contextGeneration: positive, revision: positive,
  reference: ProdReference, recordVersion: positive, epoch: positive,
});
export type PmContextBaseline = Static<typeof PmContextBaseline>;
export const PmContext = object({
  format: Type.Literal("pm-physical-context/v1"), runId: id, fence: positive,
  generation: positive, baseline: nullable(PmContextBaseline),
  diffRevision: Type.Optional(positive),
});
export type PmContext = Static<typeof PmContext>;
export const ApprovedProdChange = object({
  format: Type.Literal("approved-prod-change/v1"), requirementId: id, repoId: hash,
  fromRevision: nullable(positive), toRevision: positive,
  from: nullable(ProdReference), to: ProdReference, receiptId: id,
  lifecycleEpoch: positive, recordVersion: positive,
  approvalManifest: ApprovalSummary,
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
  requirementId: id, fence: counter, lease: nullable(PmLease),
  prodEvents: Type.Optional(PmEventCursor), context: PmContext,
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
    manifest: ApprovalManifestReferenceSchema, docSpec: Type.Optional(RequirementDocSpecSchema) }),
  bind: object({ requirementId: id, version: positive, path: Type.String({ minLength: 1, maxLength: 4096 }), prepareOperationId: id, baseCommit: commit }),
  acquire: object({ requirementId: id, version: positive, runId: id, expectedFence: counter }),
  close: object({ requirementId: id, version: positive, intent: CloseIntent }),
  finish: object({ requirementId: id, version: positive, operationId: id }),
  block: object({ requirementId: id, version: positive, reason: RecoveryReason }),
  assess: object({ lease: PmLease, version: positive, revision: positive, assessmentId: id,
    tasks: Type.Array(object({ taskId: Type.String({ minLength: 1, maxLength: 256 }), impact: Type.Union([Type.Literal("unaffected"), Type.Literal("affected"), Type.Literal("unknown")]),
      reason: Type.String({ maxLength: 1024 }) }), { minItems: 1, maxItems: 512 }) }),
  eventLease: object({ lease: PmLease }),
  recordPmDiff: object({ lease: PmLease, revision: positive }),
  issueBaseline: object({ lease: PmLease, version: positive, epoch: positive, revision: positive, reference: ProdReference }),
  acknowledgeBaseline: object({ lease: PmLease, deliveryId: id }),
  eventDelivery: object({ lease: PmLease, eventId: id, sequence: positive }),
  acknowledgeApproved: object({ lease: PmLease, eventId: id, sequence: positive, revision: positive, reference: ProdReference }),
};

const REREAD = "重新读取需求状态后再决定下一步";
const STOP = "停止操作，不要重试；在回复里说明，由上级处理";
const REQUIREMENT_STATE_ADVICE = {
  invalid_shape: COMMON_ADVICE.invalid_shape,
  invalid_state: { why: "需求记录与工作区绑定不一致", next: COMMON_ADVICE.internal_state.next },
  state_changed_during_read: { why: "读取期间需求状态被并发改动", next: "重新读取一次" },
  counter_exhausted: { why: "需求的内部计数已到上限", next: COMMON_ADVICE.internal_state.next },
  foreign_repository: { why: "请求的仓库不是当前需求所在的仓库", next: "改用当前工作区的仓库" },
  authorization_required: { why: "宿主没有授权这次需求状态操作", next: STOP },
  unknown_requirement: { why: "找不到这个需求", next: "核对需求编号；需求可能尚未创建或已被清理" },
  identity_conflict: { why: "需求编号与记录不一致", next: COMMON_ADVICE.internal_state.next },
  approval_record_missing: { why: "找不到这个需求的批准操作记录", next: COMMON_ADVICE.internal_state.next },
  recovery_required: { why: "需求记录需要先恢复核对才能继续", next: "停止操作，请用户在主窗口完成恢复核对" },
  lifecycle_denied: { why: "需求当前的阶段不允许这个操作，可能是草稿、正在关闭或已关闭", next: REREAD },
  invalid_pm_owner: { why: "PM 租约记录不一致", next: STOP },
  invalid_pm_event_cursor: { why: "PM 已收到的批准事件位置记录不一致", next: STOP },
  event_identity_conflict: { why: "批准事件不属于这个需求或与登记不符", next: COMMON_ADVICE.internal_state.next },
  approved_event_invalid: { why: "批准事件记录不完整", next: COMMON_ADVICE.internal_state.next },
  invalid_pm_context: { why: "PM 会话的接手上下文已换代", next: STOP },
  request_conflict: { why: "同一操作编号已用于内容不同的请求", next: "换一个新生成的操作编号重试" },
  identity_collision: { why: "需求编号已被占用", next: "换一个新生成的编号重试" },
  base_commit_changed: { why: "工作区的基线提交已变化", next: "重新准备需求工作区" },
  workspace_already_bound: { why: "需求已绑定了另一个工作区", next: "沿用已绑定的工作区，或先回收再重新准备" },
  workspace_occupied: { why: "这个工作区已被别的需求占用", next: "为本需求准备新的工作区" },
  workspace_claim_missing: { why: "找不到工作区的占用登记", next: COMMON_ADVICE.internal_state.next },
  operation_conflict: { why: "同一操作编号已用于不同的需求或内容", next: "换一个新生成的操作编号重试" },
  saved_event_missing: { why: "找不到已保存版本的事件记录", next: COMMON_ADVICE.internal_state.next },
  manifest_authorization_required: { why: "宿主没有授权这份批准清单", next: "请用户在主窗口重新确认批准" },
  workspace_binding_changed: { why: "需求的工作区绑定已变化", next: STOP },
  saved_version_mismatch: { why: "要批准的版本不是当前保存的版本", next: "重新读取当前保存版本，按它重新确认" },
  approval_conflict: { why: "这个版本已按另一份批准清单批准过", next: REREAD },
  manifest_stale: { why: "批准期间需求记录被并发改动", next: "重新读取后再批准" },
  workspace_not_ready: { why: "需求还没有准备好工作区", next: "先用项目管理工具准备需求工作区" },
  pm_already_owned: { why: "这个需求已有一个有效的 PM", next: "查询现有 PM 的运行状态，不要重复派出" },
  stale_fence: { why: "PM 租约代次已变化，可能刚有新 PM 接手", next: REREAD },
  pm_run_already_bound: { why: "这个 PM 运行已绑定到别的需求或工作区", next: STOP },
  stale_pm_lease: { why: "PM 已交还租约、被新 PM 接管，或守护进程重启后作废了旧租约", next: "停止操作，不要重试；由主代理决定是否重新派出 PM" },
  pm_run_binding_changed: { why: "本 PM 运行与需求的绑定已变化", next: "停止操作，不要重试；由主代理决定是否重新派出 PM" },
  pending_update: { why: "有新批准的需求版本还没复核", next: "先用 requirement_manage diff 读完新版本与上一版的差异（上下文压缩后可再查），再用 plan_manage assess-update 逐任务复核，再继续" },
  baseline_changed: { why: "接手时的批准基线已变化", next: "重新读取批准正文后再提交接手理解" },
  event_gap: { why: "批准事件没有按顺序送达", next: STOP },
  approved_version_missing: { why: "需求还没有批准版本", next: "等用户批准需求后再继续" },
  baseline_not_required: { why: "当前不需要再送接手基线", next: REREAD },
  stale_baseline_delivery: { why: "接手基线的送达记录已过时", next: STOP },
  assessment_conflict: { why: "复核针对的不是当前待复核的批准版本", next: REREAD },
  close_intent_conflict: { why: "需求已有另一个关闭请求在办理", next: "以原决定编号再次 close 续办已有的关闭，或按已有请求的原因处理" },
  completion_blocked: { why: "还有未完成的事项，不能以完成关闭：可能有待复核的新版本、阻塞项或仍在运行的子代理", next: "先用 status 查看阻塞项并处理完再关闭" },
  pm_not_revoked: { why: "PM 仍持有租约，不能完成关闭", next: "等 PM 停止后以原决定编号再次 close 续办" },
  invalid_git_ref_output: { why: "Git 返回的分支名无法识别", next: COMMON_ADVICE.internal_state.next },
  absolute_workspace_required: { why: "工作区路径必须是绝对路径", next: COMMON_ADVICE.internal_state.next },
  independent_worktree_required: { why: "需求工作区必须是独立的 Git worktree，不能是主仓库本身", next: "重新准备需求工作区" },
  branch_required: { why: "需求工作区必须在一个分支上，不能处于分离状态", next: "请用户把工作区切回需求分支" },
  close_basis_changed: { why: "关闭依据在确认后又发生了变化", next: "重新做交付核对，按新结果请用户决定" },
  check_phase_active: { why: "检查阶段还没结束", next: "先结束检查轮再继续" },
  completion_report_stale: { why: "用户验收的完成报告已不是最新依据", next: "请 PM 重新提交完成报告，用户验收后再关闭" },
  archive_path_missing: { why: "找不到需求的归档位置", next: COMMON_ADVICE.internal_state.next },
} as const satisfies Record<string, FailureAdvice>;
export type RequirementStateErrorCode = keyof typeof REQUIREMENT_STATE_ADVICE;
export function requirementStateWhy(code: string): string | undefined {
  return Object.hasOwn(REQUIREMENT_STATE_ADVICE, code) ? REQUIREMENT_STATE_ADVICE[code as RequirementStateErrorCode].why : undefined;
}

export class RequirementStateError extends Error {
  readonly code: RequirementStateErrorCode;
  readonly advice: FailureAdvice;
  constructor(code: RequirementStateErrorCode, detail?: string) {
    super(`需求状态操作被拒绝：${code}`); this.name = "RequirementStateError"; this.code = code;
    this.advice = withDetail(REQUIREMENT_STATE_ADVICE[code], detail);
  }
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
    (record.approved === null ? record.approvalManifest !== undefined : (record.approvalManifest === undefined || record.approvalManifest.reference.requirementId !== requirementId ||
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
