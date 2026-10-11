import { createHash } from "node:crypto";
import { adviceIn } from "./tool-failure.ts";
import type { FailureAdvice } from "./tool-failure.ts";
import { performance } from "node:perf_hooks";
import { isPromise } from "node:util/types";
import { Value } from "typebox/value";
import { repositoryDatabase, uuidv7, withDatabase } from "./database.ts";
import type { LocalDatabase, StoredRecord } from "./database.ts";
import { registeredApprovalManifestIn, APPROVAL_MANIFEST_NAMESPACE } from "./approval-manifest-store.ts";
import { approvalDependencyClosure } from "./approval-manifest.ts";
import type { ApprovalManifest } from "./approval-manifest.ts";
import { assertNoRequirementWriteClaimIn, assertNoUnfinishedRequirementOperationsIn } from "./requirement-coordination.ts";
import { IntakeBindingSchema, IntakeSourceDirectorySchema, IntakeReviewRecordSchema, checkIntakeReviewRecord } from "./pm-intake-contracts.ts";
import type { IntakeBinding, IntakeReviewRecord, IntakeSourceDirectory } from "./pm-intake-contracts.ts";
import { PmRecord, checkRequirement, checked } from "./requirement-contracts.ts";
import type { RequirementRecord, WorkspaceBinding } from "./requirement-contracts.ts";
import { continuityInputProofIn } from "./interaction-continuity.ts";
import { decisionDigest } from "./short-decision-format.ts";
import { canonicalJson } from "./strict-json.ts";
import { checkInteraction, PendingQuestion } from "./user-interaction-format.ts";

export const PM_INTAKE_NAMESPACES = Object.freeze({
  requests: "pm_intake_requests_v1",
  reviews: "pm_intake_reviews_v1",
  directories: "pm_intake_directories_v1",
  heads: "pm_intake_heads_v1",
  operations: "pm_intake_operations_v1",
} as const);
export const PM_INTAKE_ENVELOPE_BYTES = 49_152;

const PM_INTAKE_STORE_ADVICE: Record<string, FailureAdvice> = {
  approval_record_missing: { why: "找不到批准记录", next: "停止操作，不要重试；把这段原因告诉用户" },
  async_callback: { why: "回调不能是异步的", next: "停止操作，不要重试；把这段原因告诉用户" },
  binding_changed: { why: "PM 与需求、工作区的绑定已变化", next: "停止操作，不要重试；把这段原因告诉用户" },
  current_proof_changed: { why: "当前的核对依据已变化", next: "重新发起一次" },
  decision_changed: { why: "相关决定已被改动", next: "重新读取需求后按最新版本再试" },
  directory_conflict: { why: "接手出处目录冲突", next: "停止操作，不要重试；把这段原因告诉用户" },
  foreign_repo: { why: "仓库不属于当前需求", next: "改用当前工作区列出的仓库编号" },
  incomplete_scenario_directory: { why: "接手出处目录缺少必需场景", next: "停止操作，不要重试；把这段原因告诉用户" },
  intake_records_changed: { why: "接手复核记录在处理期间被改动", next: "重新发起一次" },
  invalid_binding: { why: "PM 绑定记录不合规", next: "停止操作，不要重试；把这段原因告诉用户" },
  invalid_deadline: { why: "复核期限设置不合规", next: "停止操作，不要重试；把这段原因告诉用户" },
  invalid_repo: { why: "仓库编号不合规", next: "改用当前工作区列出的仓库编号" },
  invalid_request: { why: "复核请求不合规", next: "用 forward 重新取当前的复核请求" },
  invalid_requirement: { why: "需求编号不合规", next: "核对需求编号" },
  invalid_shape: { why: "接手复核记录格式不合规", next: "按原因改正后重试" },
  invalid_source_directory: { why: "接手出处目录不合规", next: "停止操作，不要重试；把这段原因告诉用户" },
  invalid_time: { why: "系统时间不可用", next: "停止操作，不要重试；把这段原因告诉用户" },
  main_deadline_elapsed: { why: "复核已超过期限", next: "用 forward 重新取当前的复核请求" },
  manifest_binding_changed: { why: "批准清单绑定已变化", next: "重新读取需求后按最新版本再试" },
  operation_conflict: { why: "同一操作编号已用于内容不同的请求", next: "换一个新生成的操作编号重试" },
  pm_missing: { why: "这个需求当前没有 PM", next: "先派出 PM" },
  pm_run_claim_changed: { why: "PM 运行的绑定已变化", next: "停止操作，不要重试；把这段原因告诉用户" },
  question_changed: { why: "相关问题记录已被改动", next: "重新读取需求后按最新版本再试" },
  request_already_reviewed: { why: "这个复核请求已经复核过", next: "用 forward 取当前的复核请求" },
  request_changed: { why: "复核请求在处理期间被改动", next: "用 forward 重新取当前的复核请求" },
  request_missing: { why: "找不到这个复核请求", next: "用 forward 取当前的复核请求" },
  request_not_current: { why: "这个复核请求已不是当前的请求", next: "用 forward 重新取当前的复核请求" },
  resource_limit: { why: "内容超出上限", next: "精简内容后重试" },
  source_directory_mismatch: { why: "接手出处目录与需求当前版本不一致", next: "请 PM 按当前版本重新提交接手理解" },
  stale_pm_lease: { why: "PM 的租约已失效，可能已过期或被新 PM 接管", next: "停止操作，不要重试；由主代理决定是否重新派出 PM" },
  stored_record_invalid: { why: "已存的接手复核记录不合规", next: "停止操作，不要重试；把这段原因告诉用户" },
  unknown_requirement: { why: "找不到这个需求", next: "核对需求编号" },
  untrusted_prepared: { why: "准备好的复核记录不是宿主生成的", next: "停止操作，不要重试；把这段原因告诉用户" },
  untrusted_proof: { why: "核对依据不是宿主生成的", next: "停止操作，不要重试；把这段原因告诉用户" },
  workspace_claim_changed: { why: "需求工作区的占用已变化", next: "停止操作，不要重试；把这段原因告诉用户" },
};
export class PmIntakeStoreError extends Error {
  readonly code: string;
  readonly advice: FailureAdvice;
  constructor(code: string) {
    super(`PM 接手存储被拒绝：${code}`);
    this.name = "PmIntakeStoreError";
    this.code = code;
    this.advice = adviceIn(PM_INTAKE_STORE_ADVICE, code);
  }
}

export type IntakeBindingBasis = Omit<IntakeBinding, "approvalScopeVersion" | "actionScopeVersion">;
export interface IntakeCurrentProof { readonly kind: "pm-intake-current-proof" }
export interface PreparedIntakeRequest { readonly kind: "prepared-intake-request" }
export interface PreparedIntakeReview { readonly kind: "prepared-intake-review" }

export interface IntakeRequestRecord {
  format: "pm-intake-request/v1";
  requestId: string;
  binding: IntakeBinding;
  submissionRef: string;
  submissionHash: string;
  sourceDirectoryHash: string;
  creator: { windowId: string; sessionId: string; toolCallId: string };
  createdAt: number;
}

interface IntakeDirectoryRecord {
  format: "pm-intake-directory/v1";
  binding: IntakeBinding;
  sourceDirectory: IntakeSourceDirectory;
  sourceDirectoryHash: string;
  createdAt: number;
}

interface IntakeHeadRecord {
  format: "pm-intake-head/v1";
  requirementId: string;
  binding: IntakeBinding;
  requestId: string;
  reviewId: string | null;
  updatedAt: number;
}

interface IntakeOperationRecord {
  format: "pm-intake-operation/v1";
  operationId: string;
  operation: "request" | "review";
  intentHash: string;
  resultId: string;
  createdAt: number;
}

interface CurrentClaim {
  basis: IntakeBindingBasis;
  binding: IntakeBinding;
  sourceDirectory: IntakeSourceDirectory;
  sourceDirectoryHash: string;
  continuityInputProof: string;
  fingerprint: string;
  leaseExpiresAt: number;
  frame?: RowFrame;
}
interface RequestClaim {
  proof: IntakeCurrentProof;
  operationId: string;
  intentHash: string;
  record: IntakeRequestRecord;
  frame: RowFrame;
}
interface ReviewClaim {
  proof: IntakeCurrentProof;
  operationId: string;
  intentHash: string;
  record: IntakeReviewRecord;
  sourceDirectoryHash: string;
  createdAt: number;
  frame: RowFrame;
}

export interface StoredIntakeRequest {
  record: IntakeRequestRecord;
  sourceDirectory: IntakeSourceDirectory;
  currentProof: IntakeCurrentProof;
  idempotent: boolean;
}
export interface StoredIntakeReview {
  record: IntakeReviewRecord;
  currentProof: IntakeCurrentProof;
  idempotent: boolean;
}

function stringPattern(pattern: RegExp) {
  return { test(value: unknown): value is string { return typeof value === "string" && pattern.exec(value)?.[0] === value; } };
}
const UUID = stringPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
const HASH = stringPattern(/^[0-9a-f]{64}$/);
const OPAQUE = stringPattern(/^[A-Za-z0-9][A-Za-z0-9._:/#@+|-]{0,255}$/);
const exactKeys = (value: unknown, keys: readonly string[]) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) deny("invalid_shape");
  const actual = Object.keys(value).sort();
  if (actual.length !== keys.length || actual.some((key, index) => key !== [...keys].sort()[index])) deny("invalid_shape");
};
function deny(code: string): never { throw new PmIntakeStoreError(code); }
const jsonBytes = (value: unknown): number => {
  let serialized: string;
  try { serialized = JSON.stringify(value); } catch { return deny("invalid_shape"); }
  if (Buffer.byteLength(serialized, "utf8") > PM_INTAKE_ENVELOPE_BYTES) deny("resource_limit");
  return Buffer.byteLength(serialized, "utf8");
};
const clone = <T>(value: T): T => {
  try { return structuredClone(value); } catch { return deny("invalid_shape"); }
};
const same = (left: unknown, right: unknown): boolean => decisionDigest(left) === decisionDigest(right);
const sortedUnique = (values: readonly string[]): string[] => [...new Set(values)].sort();
const digest = (value: unknown): string => createHash("sha256").update(canonicalJson(value as Parameters<typeof canonicalJson>[0])).digest("hex");
const scopeVersion = (kind: "approval" | "action", value: unknown): string => `intake-${kind}-scope/v1:${digest(value)}`;

function checkedDirectory(value: unknown): IntakeSourceDirectory {
  const directory = clone(value);
  if (!Value.Check(IntakeSourceDirectorySchema, directory)) deny("invalid_source_directory");
  const result = directory as IntakeSourceDirectory;
  for (const values of [result.prodUnitIds, result.prodScenarioIds, result.decisionIds, result.questionIds, result.requiredScenarioIds]) {
    if (new Set(values).size !== values.length) deny("invalid_source_directory");
  }
  if (!same(result.requiredScenarioIds, result.prodScenarioIds)) deny("incomplete_scenario_directory");
  jsonBytes(result);
  return result;
}

function checkedBindingBasis(value: unknown): IntakeBindingBasis {
  const copy = clone(value) as Record<string, unknown>;
  if (!copy || typeof copy !== "object") deny("invalid_binding");
  exactKeys(copy, ["repoId", "requirementId", "approvedProdCommit", "approvedRevision", "approvedProdHash", "approvalManifestHash",
    "workspaceId", "workspaceRef", "epoch", "pmRunId", "pmFence", "contextGeneration"]);
  const candidate = { ...copy, approvalScopeVersion: `intake-approval-scope/v1:${"0".repeat(64)}`,
    actionScopeVersion: `intake-action-scope/v1:${"0".repeat(64)}` };
  if (!Value.Check(IntakeBindingSchema, candidate)) deny("invalid_binding");
  return copy as unknown as IntakeBindingBasis;
}

function checkedRequest(value: unknown): IntakeRequestRecord {
  const record = clone(value) as IntakeRequestRecord;
  if (!record || typeof record !== "object") deny("invalid_shape");
  exactKeys(record, ["format", "requestId", "binding", "submissionRef", "submissionHash", "sourceDirectoryHash", "creator", "createdAt"]);
  exactKeys(record.creator, ["windowId", "sessionId", "toolCallId"]);
  if (record.format !== "pm-intake-request/v1" || !UUID.test(record.requestId) || !Value.Check(IntakeBindingSchema, record.binding) ||
    !OPAQUE.test(record.submissionRef) || !HASH.test(record.submissionHash) || !HASH.test(record.sourceDirectoryHash) ||
    !Number.isSafeInteger(record.createdAt) || record.createdAt < 0 || Object.values(record.creator).some((id) => !OPAQUE.test(id))) deny("invalid_shape");
  jsonBytes(record);
  return record;
}

function checkedOperation(value: unknown): IntakeOperationRecord {
  const operation = clone(value) as IntakeOperationRecord;
  if (!operation || typeof operation !== "object") deny("stored_record_invalid");
  exactKeys(operation, ["format", "operationId", "operation", "intentHash", "resultId", "createdAt"]);
  if (operation.format !== "pm-intake-operation/v1" || !UUID.test(operation.operationId) || !["request", "review"].includes(operation.operation) ||
    !HASH.test(operation.intentHash) || !UUID.test(operation.resultId) || !Number.isSafeInteger(operation.createdAt) || operation.createdAt < 0) deny("stored_record_invalid");
  return operation;
}

function checkedDirectoryRecord(value: unknown): IntakeDirectoryRecord {
  const record = clone(value) as IntakeDirectoryRecord;
  if (!record || typeof record !== "object") deny("stored_record_invalid");
  exactKeys(record, ["format", "binding", "sourceDirectory", "sourceDirectoryHash", "createdAt"]);
  if (record.format !== "pm-intake-directory/v1" || !Value.Check(IntakeBindingSchema, record.binding) ||
    !HASH.test(record.sourceDirectoryHash) || !Number.isSafeInteger(record.createdAt) || record.createdAt < 0) deny("stored_record_invalid");
  record.sourceDirectory = checkedDirectory(record.sourceDirectory);
  jsonBytes(record);
  return record;
}

function claimKeys(binding: WorkspaceBinding): string[] {
  return [`workspace:${binding.workspaceId}`, `branch:${binding.branch}`, `path:${createHash("sha256").update(binding.path).digest("hex")}`];
}

export function intakeManifestDecisionIds(manifest: ApprovalManifest): string[] {
  return sortedUnique([...manifest.units, ...manifest.actions, ...manifest.questions].flatMap((entry) => entry.decisionIds)
    .concat((manifest.retainedSources ?? []).map((source) => source.decision.id)));
}

function currentQuestionIds(db: LocalDatabase, repoId: string, requirementId: string): string[] {
  const rows = db.list("interaction_questions_v1").filter((row) =>
    (row.data as { basis?: { requirementId?: unknown } } | null)?.basis?.requirementId === requirementId);
  return sortedUnique(rows.map((row) => {
    const question = checkInteraction(PendingQuestion, row.data);
    if (row.id !== question.requestId || question.repoId !== repoId || !OPAQUE.test(row.id)) deny("question_changed");
    return row.id;
  }));
}

function validateDirectory(db: LocalDatabase, repoId: string, requirementId: string, directory: IntakeSourceDirectory, manifest: ApprovalManifest, questions: boolean): void {
  if (!same(directory.prodUnitIds, manifest.units.map((unit) => unit.id))) deny("source_directory_mismatch");
  if (directory.prodScenarioIds.some((id) => !directory.prodUnitIds.includes(id))) deny("source_directory_mismatch");
  if (!same(directory.decisionIds, intakeManifestDecisionIds(manifest))) deny("source_directory_mismatch");
  if (questions && !same(directory.questionIds, currentQuestionIds(db, repoId, requirementId))) deny("source_directory_mismatch");
}

function decisionRows(db: LocalDatabase, manifest: ApprovalManifest) {
  return intakeManifestDecisionIds(manifest).map((id) => {
    const row = db.read("short_decisions", id);
    if (!row || row.id !== id) deny("decision_changed");
    return { id, version: row.version, hash: decisionDigest(row.data) };
  });
}

function normalizedScopes(db: LocalDatabase, manifest: ApprovalManifest, directory: IntakeSourceDirectory, approvalInputProof: string) {
  const decisions = decisionRows(db, manifest);
  const approval = {
    format: "pm-intake-approval-scope/v1",
    manifest: clone(manifest),
    decisionRecords: decisions,
    retainedSources: clone(manifest.retainedSources ?? []),
    sourceDirectory: clone(directory),
    approvalInputProof,
  };
  const actions = manifest.actions.map((action) => {
    const declaredScope = sortedUnique([...action.goalIds, ...action.constraintIds]);
    const closure = approvalDependencyClosure(manifest.units, declaredScope);
    const units = manifest.units.filter((unit) => closure.includes(unit.id));
    const ids = new Set([...action.decisionIds, ...units.flatMap((unit) => unit.decisionIds)]);
    const retainedSources = (manifest.retainedSources ?? []).filter((source) => closure.includes(source.unitId));
    retainedSources.forEach((source) => ids.add(source.decision.id));
    return { ...clone(action), declaredScope, closure, units: clone(units), retainedSources: clone(retainedSources),
      decisionRecords: decisions.filter((row) => ids.has(row.id)) };
  });
  return {
    approvalScopeVersion: scopeVersion("approval", approval),
    actionScopeVersion: scopeVersion("action", { format: "pm-intake-action-scope/v1", actions }),
    decisions,
  };
}

function currentSnapshot(db: LocalDatabase, repoId: string, basis: IntakeBindingBasis, directory: IntakeSourceDirectory, observedAt: number, questions = true) {
  const raw = db.read<RequirementRecord>("requirements", basis.requirementId);
  if (!raw || raw.id !== basis.requirementId) deny("unknown_requirement");
  const record = { ...raw, data: checkRequirement(raw.data, basis.requirementId, repoId) };
  const data = record.data;
  if (data.lifecycle !== "active" || data.recovery !== "ready" || !data.approved || !data.workspace ||
    data.repoId !== repoId || data.requirementId !== basis.requirementId || data.revision !== basis.approvedRevision ||
    data.approved.commit !== basis.approvedProdCommit || data.approved.hash !== basis.approvedProdHash ||
    data.approvalManifest!.reference.manifestHash !== basis.approvalManifestHash || data.workspace.workspaceId !== basis.workspaceId ||
    data.workspace.branch !== basis.workspaceRef || data.epoch !== basis.epoch) deny("binding_changed");

  const ownerRow = db.read("pm_ownership", basis.requirementId);
  if (!ownerRow) deny("pm_missing");
  const owner = checked(PmRecord, ownerRow.data);
  const lease = owner.lease;
  const context = owner.context;
  if (!lease || !context || lease.runId !== basis.pmRunId || lease.fence !== basis.pmFence || lease.contextGeneration !== basis.contextGeneration ||
    lease.workspaceId !== basis.workspaceId || lease.epoch !== basis.epoch || lease.expiresAt <= observedAt || owner.fence !== basis.pmFence ||
    context.runId !== basis.pmRunId || context.fence !== basis.pmFence || context.generation !== basis.contextGeneration) deny("stale_pm_lease");

  const claims = claimKeys(data.workspace).map((key) => {
    const row = db.read("managed_workspace_claims", key);
    if (!row || (row.data as { requirementId?: unknown }).requirementId !== basis.requirementId ||
      (row.data as { workspaceId?: unknown }).workspaceId !== basis.workspaceId) deny("workspace_claim_changed");
    return { key, id: row.id, version: row.version, hash: decisionDigest(row.data) };
  });
  const runClaim = db.read("pm_run_claims", basis.pmRunId);
  if (!runClaim || (runClaim.data as { requirementId?: unknown }).requirementId !== basis.requirementId ||
    (runClaim.data as { workspaceId?: unknown }).workspaceId !== basis.workspaceId) deny("pm_run_claim_changed");
  assertNoRequirementWriteClaimIn(db, repoId, basis.requirementId);
  assertNoUnfinishedRequirementOperationsIn(db, basis.requirementId);

  const manifest = registeredApprovalManifestIn(db, repoId, data.approvalManifest!.reference, record);
  validateDirectory(db, repoId, basis.requirementId, directory, manifest, questions);
  if (manifest.candidate.to.commit !== basis.approvedProdCommit || manifest.candidate.to.hash !== basis.approvedProdHash ||
    manifest.manifestHash !== basis.approvalManifestHash) deny("manifest_binding_changed");
  const manifestRow = db.read(APPROVAL_MANIFEST_NAMESPACE, basis.approvalManifestHash);
  const approvalUse = data.approvalReceiptId ? db.read("requirement_approval_uses", data.approvalReceiptId) : null;
  const approvalInputProof = (manifestRow?.data as { admission?: { inputProof?: string } } | undefined)?.admission?.inputProof;
  if (!manifestRow || !approvalUse || !approvalInputProof) deny("approval_record_missing");
  const continuityProof = continuityInputProofIn(db, basis.requirementId);
  const scopes = normalizedScopes(db, manifest, directory, approvalInputProof);
  const binding: IntakeBinding = { ...basis, approvalScopeVersion: scopes.approvalScopeVersion, actionScopeVersion: scopes.actionScopeVersion };
  const sourceDirectoryHash = digest({ format: "pm-intake-source-directory/v1", binding, sourceDirectory: directory });
  const fingerprint = digest({
    requirement: { id: record.id, version: record.version, hash: decisionDigest(record.data) },
    // PM 租约每 10 秒续期，只改到期时间与记录版本；续期不改变 PM 身份与权限，不能算作依据变化
    owner: { id: ownerRow.id, hash: decisionDigest({ ...owner, lease: { ...lease, expiresAt: 0 } }) },
    approvalUse: { id: approvalUse.id, version: approvalUse.version, hash: decisionDigest(approvalUse.data) },
    manifest: { id: manifestRow.id, version: manifestRow.version, hash: decisionDigest(manifestRow.data) },
    decisions: scopes.decisions,
    claims,
    runClaim: { id: runClaim.id, version: runClaim.version, hash: decisionDigest(runClaim.data) },
    continuityProof,
    sourceDirectoryHash,
    approvalScopeVersion: scopes.approvalScopeVersion,
    actionScopeVersion: scopes.actionScopeVersion,
  });
  return { binding, sourceDirectoryHash, continuityInputProof: continuityProof, fingerprint, leaseExpiresAt: lease.expiresAt };
}

function syncCallback(callback: () => unknown): void {
  const result: unknown = callback();
  if (isPromise(result)) {
    void Promise.prototype.then.call(result, () => undefined, () => undefined);
    deny("async_callback");
  }
  if (result !== null && (typeof result === "object" || typeof result === "function")) {
    let then: unknown;
    try { then = (result as { then?: unknown }).then; } catch { return deny("async_callback"); }
    if (typeof then === "function") { void Promise.resolve(result).catch(() => undefined); deny("async_callback"); }
  }
}

interface FrameSelector {
  requirementId: string;
  directoryHash: string;
  requestId?: string;
  reviewId?: string;
  operationId?: string;
}
interface FrameRow { id: string; version: number; data: unknown }
interface RowFrame { selector: FrameSelector; rows: Record<string, FrameRow | null> }
const frameKey = (namespace: string, key: string): string => `${namespace}/${key}`;
const frameData = <T>(frame: RowFrame, namespace: string, key: string): T | undefined => frame.rows[frameKey(namespace, key)]?.data as T | undefined;
function requestIntent(record: IntakeRequestRecord): string {
  return digest({ operation: "request", binding: record.binding, submissionRef: record.submissionRef,
    submissionHash: record.submissionHash, sourceDirectoryHash: record.sourceDirectoryHash });
}
function reviewIntent(record: IntakeReviewRecord): string {
  return digest({ operation: "review", requestId: record.requestId, binding: record.binding,
    submissionRef: record.submissionRef, submissionHash: record.submissionHash, result: record.result,
    sourceRefs: record.sourceRefs, shortIssues: record.shortIssues });
}
function checkedHead(value: unknown): IntakeHeadRecord {
  const head = clone(value) as IntakeHeadRecord;
  if (!head || typeof head !== "object") deny("stored_record_invalid");
  exactKeys(head, ["format", "requirementId", "binding", "requestId", "reviewId", "updatedAt"]);
  if (head.format !== "pm-intake-head/v1" || !UUID.test(head.requirementId) || !UUID.test(head.requestId) ||
    head.reviewId !== null && !UUID.test(head.reviewId) || !Value.Check(IntakeBindingSchema, head.binding) ||
    head.binding.requirementId !== head.requirementId || !Number.isSafeInteger(head.updatedAt) || head.updatedAt < 0) deny("stored_record_invalid");
  jsonBytes(head); return head;
}
/** 只把相关需求的行及显式点查结果纳入凭据；超限拒绝，不截断唯一性集合。 */
function captureFrameIn(db: LocalDatabase, selector: FrameSelector, prior?: RowFrame): RowFrame {
  const ns = PM_INTAKE_NAMESPACES, rows: RowFrame["rows"] = Object.create(null);
  const points = new Map<string, { namespace: string; key: string }>();
  const point = (namespace: string, key: string) => points.set(frameKey(namespace, key), { namespace, key });
  point(ns.heads, selector.requirementId); point(ns.directories, selector.directoryHash);
  if (selector.requestId) point(ns.requests, selector.requestId);
  if (selector.reviewId) point(ns.reviews, selector.reviewId);
  if (selector.operationId) point(ns.operations, selector.operationId);
  for (const key of Object.keys(prior?.rows ?? {})) {
    const slash = key.indexOf("/"); point(key.slice(0, slash), key.slice(slash + 1));
  }
  const put = (namespace: string, key: string, record: StoredRecord) => {
    if (!UUID.test(record.id) || !Number.isSafeInteger(record.version) || record.version < 1) deny("stored_record_invalid");
    let data: unknown;
    if (namespace === ns.requests) {
      const request = checkedRequest(record.data);
      if (request.requestId !== key || record.id !== key || request.binding.requirementId !== selector.requirementId) deny("intake_records_changed");
      data = request;
    } else if (namespace === ns.reviews) {
      if (!Value.Check(IntakeReviewRecordSchema, record.data)) deny("stored_record_invalid");
      const review = record.data as IntakeReviewRecord;
      if (review.reviewId !== key || record.id !== key || review.binding.requirementId !== selector.requirementId) deny("intake_records_changed");
      data = clone(review); jsonBytes(data);
    } else if (namespace === ns.operations) {
      const operation = checkedOperation(record.data);
      if (operation.operationId !== key || record.id !== key) deny("operation_conflict");
      data = operation;
    } else if (namespace === ns.heads) {
      const head = checkedHead(record.data);
      if (head.requirementId !== key || key !== selector.requirementId) deny("intake_records_changed");
      data = head;
    } else {
      const directory = checkedDirectoryRecord(record.data);
      if (directory.sourceDirectoryHash !== key || directory.binding.requirementId !== selector.requirementId ||
        digest({ format: "pm-intake-source-directory/v1", binding: directory.binding, sourceDirectory: directory.sourceDirectory }) !== key) deny("intake_records_changed");
      data = directory;
    }
    rows[frameKey(namespace, key)] = { id: record.id, version: record.version, data };
  };
  const headRow = db.read(ns.heads, selector.requirementId);
  if (headRow) {
    put(ns.heads, selector.requirementId, headRow);
    const head = frameData<IntakeHeadRecord>({ selector, rows }, ns.heads, selector.requirementId)!;
    point(ns.requests, head.requestId); if (head.reviewId) point(ns.reviews, head.reviewId);
  }
  for (const row of db.list<IntakeRequestRecord>(ns.requests)) {
    if (row.data?.binding?.requirementId === selector.requirementId || points.has(frameKey(ns.requests, row.key))) put(ns.requests, row.key, row);
  }
  const requestIds = new Set(Object.entries(rows).filter(([key, row]) => key.startsWith(`${ns.requests}/`) && row).map(([, row]) => (row!.data as IntakeRequestRecord).requestId));
  for (const row of db.list<IntakeReviewRecord>(ns.reviews)) {
    if (row.data?.binding?.requirementId === selector.requirementId || requestIds.has(row.data?.requestId) || points.has(frameKey(ns.reviews, row.key))) put(ns.reviews, row.key, row);
  }
  const reviewIds = new Set(Object.entries(rows).filter(([key, row]) => key.startsWith(`${ns.reviews}/`) && row).map(([, row]) => (row!.data as IntakeReviewRecord).reviewId));
  for (const row of db.list<IntakeOperationRecord>(ns.operations)) {
    if (requestIds.has(row.data?.resultId) || reviewIds.has(row.data?.resultId) || points.has(frameKey(ns.operations, row.key))) put(ns.operations, row.key, row);
  }
  for (const row of Object.values(rows)) {
    const request = row?.data as IntakeRequestRecord | undefined;
    if (request?.format === "pm-intake-request/v1") point(ns.directories, request.sourceDirectoryHash);
  }
  for (const { namespace, key } of points.values()) {
    const record = db.read(namespace, key);
    if (record) put(namespace, key, record); else rows[frameKey(namespace, key)] = null;
  }
  const frame = { selector: clone(selector), rows };
  const records = Object.values(rows).filter((row): row is FrameRow => row !== null);
  const requests = records.map((row) => row.data).filter((value): value is IntakeRequestRecord => (value as IntakeRequestRecord).format === "pm-intake-request/v1");
  const reviews = records.map((row) => row.data).filter((value): value is IntakeReviewRecord => (value as IntakeReviewRecord).format === "pm-intake-review/v1");
  const operations = records.map((row) => row.data).filter((value): value is IntakeOperationRecord => (value as IntakeOperationRecord).format === "pm-intake-operation/v1");
  for (const request of requests) {
    const directory = frameData<IntakeDirectoryRecord>(frame, ns.directories, request.sourceDirectoryHash);
    if (!directory || !same(directory.binding, request.binding)) deny("intake_records_changed");
    const linked = operations.filter((operation) => operation.resultId === request.requestId);
    if (linked.length !== 1 || linked[0]!.operation !== "request" || linked[0]!.intentHash !== requestIntent(request)) deny("operation_conflict");
    if (reviews.filter((review) => review.requestId === request.requestId).length > 1) deny("request_already_reviewed");
  }
  for (const review of reviews) {
    const request = frameData<IntakeRequestRecord>(frame, ns.requests, review.requestId);
    if (!request || !same(review.binding, request.binding) || review.submissionRef !== request.submissionRef || review.submissionHash !== request.submissionHash) deny("request_changed");
    checkIntakeReviewRecord(review, frameData<IntakeDirectoryRecord>(frame, ns.directories, request.sourceDirectoryHash)!.sourceDirectory);
    const linked = operations.filter((operation) => operation.resultId === review.reviewId);
    if (linked.length !== 1 || linked[0]!.operation !== "review" || linked[0]!.intentHash !== reviewIntent(review)) deny("operation_conflict");
  }
  for (const operation of operations) {
    if (operation.operation === "request" ? !requestIds.has(operation.resultId) : !reviewIds.has(operation.resultId)) deny("operation_conflict");
  }
  const head = frameData<IntakeHeadRecord>(frame, ns.heads, selector.requirementId);
  if (head) {
    const request = frameData<IntakeRequestRecord>(frame, ns.requests, head.requestId);
    const linked = reviews.filter((review) => review.requestId === head.requestId);
    if (!request || !same(head.binding, request.binding) || head.reviewId !== (linked[0]?.reviewId ?? null)) deny("request_not_current");
  } else if (requests.length) deny("request_not_current");
  return frame;
}

function assertTransition(before: RowFrame, after: RowFrame, prepared: RequestClaim | ReviewClaim,
  winner: IntakeRequestRecord | IntakeReviewRecord, claim: CurrentClaim): void {
  const ns = PM_INTAKE_NAMESPACES, expected = clone(before.rows);
  const isRequest = winner.format === "pm-intake-request/v1";
  const winnerId = isRequest ? winner.requestId : winner.reviewId;
  const candidate = prepared.record;
  const candidateId = candidate.format === "pm-intake-request/v1" ? candidate.requestId : candidate.reviewId;
  const namespace = isRequest ? ns.requests : ns.reviews;
  const resultKey = frameKey(namespace, winnerId), operationKey = frameKey(ns.operations, prepared.operationId);
  if (before.rows[resultKey] || before.rows[operationKey]) deny("intake_records_changed");
  if (winnerId === candidateId && !same(winner, candidate)) deny("operation_conflict");
  if ((isRequest ? requestIntent(winner) : reviewIntent(winner)) !== prepared.intentHash) deny("operation_conflict");
  const insert = (namespace: string, key: string, data: unknown, id?: string) => {
    const actual = after.rows[frameKey(namespace, key)];
    if (!actual || actual.version !== 1 || id !== undefined && actual.id !== id) deny("intake_records_changed");
    expected[frameKey(namespace, key)] = { id: id ?? actual.id, version: 1, data: clone(data) };
  };
  insert(namespace, winnerId, winner, winnerId);
  const actualOperation = frameData<IntakeOperationRecord>(after, ns.operations, prepared.operationId);
  if (!actualOperation) deny("operation_conflict");
  const createdAt = isRequest ? winner.createdAt : winnerId === candidateId ? (prepared as ReviewClaim).createdAt : actualOperation.createdAt;
  insert(ns.operations, prepared.operationId, { format: "pm-intake-operation/v1", operationId: prepared.operationId,
    operation: isRequest ? "request" : "review", intentHash: prepared.intentHash, resultId: winnerId, createdAt }, prepared.operationId);
  const headKey = frameKey(ns.heads, claim.binding.requirementId), oldHead = before.rows[headKey], actualHead = after.rows[headKey];
  if (!actualHead) deny("request_not_current");
  let head: IntakeHeadRecord;
  if (isRequest) {
    head = { format: "pm-intake-head/v1", requirementId: claim.binding.requirementId, binding: clone(winner.binding),
      requestId: winner.requestId, reviewId: null, updatedAt: winner.createdAt };
    const directoryKey = frameKey(ns.directories, claim.sourceDirectoryHash);
    if (!before.rows[directoryKey]) insert(ns.directories, claim.sourceDirectoryHash, { format: "pm-intake-directory/v1",
      binding: clone(claim.binding), sourceDirectory: clone(claim.sourceDirectory), sourceDirectoryHash: claim.sourceDirectoryHash, createdAt: winner.createdAt });
  } else {
    const previous = oldHead?.data as IntakeHeadRecord | undefined;
    const request = frameData<IntakeRequestRecord>(before, ns.requests, winner.requestId);
    if (!previous || !request || previous.requestId !== winner.requestId || previous.reviewId !== null || !same(previous.binding, claim.binding)) deny("request_not_current");
    head = { ...previous, reviewId: winner.reviewId, updatedAt: request.createdAt };
  }
  expected[headKey] = { id: oldHead?.id ?? actualHead.id, version: (oldHead?.version ?? 0) + 1, data: head };
  if (!same(expected, after.rows)) deny("intake_records_changed");
}

export class PmIntakeStore {
  readonly #dataRoot: string;
  readonly #repoId: string;
  readonly #now: () => number;
  readonly #hasInjectedClock: boolean;
  readonly #deadlineMonotonic: number | undefined;
  readonly #proofs = new WeakMap<object, CurrentClaim>();
  readonly #requests = new WeakMap<object, RequestClaim>();
  readonly #reviews = new WeakMap<object, ReviewClaim>();

  constructor(options: { dataRoot: string; repoId: string; now?: () => number; deadlineMonotonic?: number }) {
    if (!HASH.test(options.repoId)) deny("invalid_repo");
    if (options.deadlineMonotonic !== undefined &&
      (!Number.isFinite(options.deadlineMonotonic) || options.deadlineMonotonic < 0)) deny("invalid_deadline");
    this.#dataRoot = options.dataRoot;
    this.#repoId = options.repoId;
    this.#hasInjectedClock = options.now !== undefined;
    this.#now = options.now ?? Date.now;
    this.#deadlineMonotonic = options.deadlineMonotonic;
  }

  #time(): number {
    const value = this.#now();
    if (!Number.isSafeInteger(value) || value < 0) deny("invalid_time");
    return value;
  }

  #mainDeadline(): void {
    if (this.#deadlineMonotonic !== undefined && performance.now() >= this.#deadlineMonotonic) deny("main_deadline_elapsed");
  }

  #clockAfter(callback?: () => void): { base: number; sampledAt: number } {
    // 单调起点包住时钟采样与最后授权回调；回调之后不再调用注入时钟。
    this.#mainDeadline();
    const sampledAt = performance.now(), first = this.#time(), second = this.#time();
    callback && syncCallback(callback);
    this.#mainDeadline();
    return { base: Math.max(first, second), sampledAt };
  }

  #observedAt(clock: { base: number; sampledAt: number }): number {
    const elapsed = Math.max(0, Math.ceil(performance.now() - clock.sampledAt));
    if (clock.base > Number.MAX_SAFE_INTEGER - elapsed) deny("invalid_time");
    const conservative = clock.base + elapsed;
    return this.#hasInjectedClock ? conservative : Math.max(conservative, Date.now());
  }

  /** 扫描、摘要和结果复制完成后只比较数值，不重新调用授权或注入时钟。 */
  #ready<T>(result: T, claim: { leaseExpiresAt: number }, clock: { base: number; sampledAt: number }): T {
    if (claim.leaseExpiresAt <= this.#observedAt(clock)) deny("stale_pm_lease");
    this.#mainDeadline();
    return result;
  }

  /** 正式规划与派工门槛用：按接手时记下的出处清单取当前绑定；接手后新增的提问不让已通过的核对失效。 */
  recordedBinding(basisValue: unknown, directoryValue: unknown): IntakeBinding {
    const basis = checkedBindingBasis(basisValue);
    if (basis.repoId !== this.#repoId) deny("foreign_repo");
    const sourceDirectory = checkedDirectory(directoryValue), clock = this.#clockAfter();
    return withDatabase(repositoryDatabase(this.#dataRoot, this.#repoId), (db) => db.transaction(() =>
      clone(currentSnapshot(db, this.#repoId, basis, sourceDirectory, this.#observedAt(clock), false).binding)));
  }

  captureCurrent(basisValue: unknown, directoryValue: unknown): { binding: IntakeBinding; sourceDirectoryHash: string; proof: IntakeCurrentProof } {
    const basis = checkedBindingBasis(basisValue);
    if (basis.repoId !== this.#repoId) deny("foreign_repo");
    const sourceDirectory = checkedDirectory(directoryValue), clock = this.#clockAfter();
    const snapshot = withDatabase(repositoryDatabase(this.#dataRoot, this.#repoId), (db) => db.transaction(() =>
      currentSnapshot(db, this.#repoId, basis, sourceDirectory, this.#observedAt(clock))));
    const proof: IntakeCurrentProof = Object.freeze({ kind: "pm-intake-current-proof" });
    this.#proofs.set(proof, { basis, binding: snapshot.binding, sourceDirectory, sourceDirectoryHash: snapshot.sourceDirectoryHash,
      continuityInputProof: snapshot.continuityInputProof, fingerprint: snapshot.fingerprint, leaseExpiresAt: snapshot.leaseExpiresAt });
    return this.#ready({ binding: clone(snapshot.binding), sourceDirectoryHash: snapshot.sourceDirectoryHash, proof }, snapshot, clock);
  }

  prepareRequest(input: { operationId: string; proof: IntakeCurrentProof; submissionRef: string; submissionHash: string;
    creator: { windowId: string; sessionId: string; toolCallId: string } }): PreparedIntakeRequest {
    const claim = this.#proofs.get(input.proof as object);
    if (!claim || !UUID.test(input.operationId) || !OPAQUE.test(input.submissionRef) || !HASH.test(input.submissionHash)) deny("untrusted_prepared");
    const record = checkedRequest({ format: "pm-intake-request/v1", requestId: uuidv7(), binding: claim.binding,
      submissionRef: input.submissionRef, submissionHash: input.submissionHash, sourceDirectoryHash: claim.sourceDirectoryHash,
      creator: clone(input.creator), createdAt: this.#time() });
    // operationId描述业务重试；可信调用凭据每次单独核验，新的toolCallId不会把同一业务意图变成冲突。
    const intentHash = requestIntent(record);
    const frame = this.#prepareFrame(input.proof, { requirementId: claim.binding.requirementId, directoryHash: claim.sourceDirectoryHash,
      requestId: record.requestId, operationId: input.operationId });
    const prepared: PreparedIntakeRequest = Object.freeze({ kind: "prepared-intake-request" });
    this.#requests.set(prepared, { proof: input.proof, operationId: input.operationId, intentHash, record, frame });
    return prepared;
  }

  requestMetadata(prepared: PreparedIntakeRequest): IntakeRequestRecord {
    const claim = this.#requests.get(prepared as object);
    if (!claim) deny("untrusted_prepared");
    return clone(claim.record);
  }

  prepareReview(input: { operationId: string; proof: IntakeCurrentProof; record: IntakeReviewRecord }): PreparedIntakeReview {
    const claim = this.#proofs.get(input.proof as object);
    if (!claim || !UUID.test(input.operationId)) deny("untrusted_prepared");
    const record = checkIntakeReviewRecord(input.record, claim.sourceDirectory).record;
    if (!same(record.binding, claim.binding)) deny("binding_changed");
    // reviewId和reviewer来自本次可信调用，不属于业务意图；幂等重试返回首次保存的真实身份和结果ID。
    const intentHash = reviewIntent(record), createdAt = this.#time();
    const frame = this.#prepareFrame(input.proof, { requirementId: claim.binding.requirementId, directoryHash: claim.sourceDirectoryHash,
      requestId: record.requestId, reviewId: record.reviewId, operationId: input.operationId });
    const prepared: PreparedIntakeReview = Object.freeze({ kind: "prepared-intake-review" });
    this.#reviews.set(prepared, { proof: input.proof, operationId: input.operationId, intentHash, record,
      sourceDirectoryHash: claim.sourceDirectoryHash, createdAt, frame });
    return prepared;
  }

  #prepareFrame(proof: IntakeCurrentProof, selector: FrameSelector): RowFrame {
    const clock = this.#clockAfter();
    return withDatabase(repositoryDatabase(this.#dataRoot, this.#repoId), (db) => db.transaction(() => {
      const claim = this.#assertClaimIn(db, proof, this.#observedAt(clock));
      return this.#ready(captureFrameIn(db, selector), claim, clock);
    }));
  }

  #resultProof(claim: CurrentClaim, frame: RowFrame): IntakeCurrentProof {
    const proof: IntakeCurrentProof = Object.freeze({ kind: "pm-intake-current-proof" });
    this.#proofs.set(proof, { ...claim, frame: clone(frame) });
    return proof;
  }

  #currentResult(frame: RowFrame, claim: CurrentClaim, requestId: string, reviewId?: string): IntakeRequestRecord {
    const head = frameData<IntakeHeadRecord>(frame, PM_INTAKE_NAMESPACES.heads, claim.binding.requirementId);
    const request = frameData<IntakeRequestRecord>(frame, PM_INTAKE_NAMESPACES.requests, requestId);
    if (!head || !request || head.requestId !== requestId || reviewId !== undefined && head.reviewId !== reviewId ||
      !same(head.binding, claim.binding) || !same(request.binding, claim.binding) || request.sourceDirectoryHash !== claim.sourceDirectoryHash) deny("request_not_current");
    return request;
  }

  #assertClaimIn(db: LocalDatabase, proof: IntakeCurrentProof, observedAt: number, checkFrame = true): CurrentClaim {
    const claim = this.#proofs.get(proof as object);
    if (!claim) deny("untrusted_proof");
    const current = currentSnapshot(db, this.#repoId, claim.basis, claim.sourceDirectory, observedAt);
    if (!same(current.binding, claim.binding) || current.sourceDirectoryHash !== claim.sourceDirectoryHash ||
      current.continuityInputProof !== claim.continuityInputProof || current.fingerprint !== claim.fingerprint) deny("current_proof_changed");
    if (checkFrame && claim.frame && !same(captureFrameIn(db, claim.frame.selector, claim.frame), claim.frame)) deny("intake_records_changed");
    return { ...claim, leaseExpiresAt: current.leaseExpiresAt };
  }

  assertReturnCurrent(proof: IntakeCurrentProof, beforeTransaction: () => void): void {
    if (!this.#proofs.has(proof as object)) deny("untrusted_proof");
    const clock = this.#clockAfter(beforeTransaction);
    const checked = withDatabase(repositoryDatabase(this.#dataRoot, this.#repoId), (db) => db.transaction(() => {
      const claim = this.#assertClaimIn(db, proof, this.#observedAt(clock));
      return this.#ready(claim, claim, clock);
    }));
    this.#ready(undefined, checked, clock);
  }

  commitRequest(prepared: PreparedIntakeRequest, beforeTransaction: () => void): StoredIntakeRequest {
    const preparedClaim = this.#requests.get(prepared as object);
    if (!preparedClaim) deny("untrusted_prepared");
    const clock = this.#clockAfter(beforeTransaction);
    return withDatabase(repositoryDatabase(this.#dataRoot, this.#repoId), (db) => db.transaction(() => {
      const claim = this.#assertClaimIn(db, preparedClaim.proof, this.#observedAt(clock), false);
      const frame = captureFrameIn(db, preparedClaim.frame.selector, preparedClaim.frame);
      const operation = frameData<IntakeOperationRecord>(frame, PM_INTAKE_NAMESPACES.operations, preparedClaim.operationId);
      if (operation) {
        if (operation.operation !== "request" || operation.intentHash !== preparedClaim.intentHash) deny("operation_conflict");
        const record = this.#currentResult(frame, claim, operation.resultId);
        if (requestIntent(record) !== preparedClaim.intentHash) deny("operation_conflict");
        if (preparedClaim.frame.rows[frameKey(PM_INTAKE_NAMESPACES.operations, preparedClaim.operationId)]) {
          if (!same(frame, preparedClaim.frame)) deny("intake_records_changed");
        } else assertTransition(preparedClaim.frame, frame, preparedClaim, record, claim);
        this.#assertClaimIn(db, preparedClaim.proof, this.#observedAt(clock), false);
        return this.#ready({ record: clone(record), sourceDirectory: clone(claim.sourceDirectory), currentProof: this.#resultProof(claim, frame), idempotent: true }, claim, clock);
      }
      if (!same(frame, preparedClaim.frame)) deny("intake_records_changed");
      const directoryData: IntakeDirectoryRecord = { format: "pm-intake-directory/v1", binding: claim.binding,
        sourceDirectory: claim.sourceDirectory, sourceDirectoryHash: claim.sourceDirectoryHash, createdAt: preparedClaim.record.createdAt };
      jsonBytes(directoryData);
      const oldDirectory = db.read<IntakeDirectoryRecord>(PM_INTAKE_NAMESPACES.directories, claim.sourceDirectoryHash);
      if (oldDirectory) {
        const storedDirectory = checkedDirectoryRecord(oldDirectory.data);
        if (!same(storedDirectory.binding, directoryData.binding) || !same(storedDirectory.sourceDirectory, directoryData.sourceDirectory) ||
          storedDirectory.sourceDirectoryHash !== directoryData.sourceDirectoryHash) deny("directory_conflict");
      } else db.create(PM_INTAKE_NAMESPACES.directories, claim.sourceDirectoryHash, directoryData);
      db.create(PM_INTAKE_NAMESPACES.requests, preparedClaim.record.requestId, preparedClaim.record, preparedClaim.record.requestId);
      const operationRecord: IntakeOperationRecord = { format: "pm-intake-operation/v1", operationId: preparedClaim.operationId,
        operation: "request", intentHash: preparedClaim.intentHash, resultId: preparedClaim.record.requestId, createdAt: preparedClaim.record.createdAt };
      db.create(PM_INTAKE_NAMESPACES.operations, preparedClaim.operationId, operationRecord, preparedClaim.operationId);
      const head = db.read<IntakeHeadRecord>(PM_INTAKE_NAMESPACES.heads, claim.binding.requirementId);
      const next: IntakeHeadRecord = { format: "pm-intake-head/v1", requirementId: claim.binding.requirementId, binding: claim.binding,
        requestId: preparedClaim.record.requestId, reviewId: null, updatedAt: preparedClaim.record.createdAt };
      jsonBytes(next);
      if (head) db.update(PM_INTAKE_NAMESPACES.heads, claim.binding.requirementId, head.version, next);
      else db.create(PM_INTAKE_NAMESPACES.heads, claim.binding.requirementId, next);
      const after = captureFrameIn(db, preparedClaim.frame.selector, preparedClaim.frame);
      assertTransition(preparedClaim.frame, after, preparedClaim, preparedClaim.record, claim);
      this.#currentResult(after, claim, preparedClaim.record.requestId);
      this.#assertClaimIn(db, preparedClaim.proof, this.#observedAt(clock), false);
      return this.#ready({ record: clone(preparedClaim.record), sourceDirectory: clone(claim.sourceDirectory), currentProof: this.#resultProof(claim, after), idempotent: false }, claim, clock);
    }));
  }

  commitReview(prepared: PreparedIntakeReview, beforeTransaction: () => void): StoredIntakeReview {
    const preparedClaim = this.#reviews.get(prepared as object);
    if (!preparedClaim) deny("untrusted_prepared");
    const clock = this.#clockAfter(beforeTransaction);
    return withDatabase(repositoryDatabase(this.#dataRoot, this.#repoId), (db) => db.transaction(() => {
      const claim = this.#assertClaimIn(db, preparedClaim.proof, this.#observedAt(clock), false);
      const frame = captureFrameIn(db, preparedClaim.frame.selector, preparedClaim.frame);
      const operation = frameData<IntakeOperationRecord>(frame, PM_INTAKE_NAMESPACES.operations, preparedClaim.operationId);
      if (operation) {
        if (operation.operation !== "review" || operation.intentHash !== preparedClaim.intentHash) deny("operation_conflict");
        const record = frameData<IntakeReviewRecord>(frame, PM_INTAKE_NAMESPACES.reviews, operation.resultId);
        if (!record || reviewIntent(record) !== preparedClaim.intentHash) deny("operation_conflict");
        this.#currentResult(frame, claim, record.requestId, record.reviewId);
        if (preparedClaim.frame.rows[frameKey(PM_INTAKE_NAMESPACES.operations, preparedClaim.operationId)]) {
          if (!same(frame, preparedClaim.frame)) deny("intake_records_changed");
        } else assertTransition(preparedClaim.frame, frame, preparedClaim, record, claim);
        this.#assertClaimIn(db, preparedClaim.proof, this.#observedAt(clock), false);
        return this.#ready({ record: clone(record), currentProof: this.#resultProof(claim, frame), idempotent: true }, claim, clock);
      }
      if (!same(frame, preparedClaim.frame)) deny("intake_records_changed");
      const request = db.read<IntakeRequestRecord>(PM_INTAKE_NAMESPACES.requests, preparedClaim.record.requestId);
      if (!request || request.id !== preparedClaim.record.requestId) deny("request_missing");
      const requestData = checkedRequest(request.data);
      if (!same(requestData.binding, preparedClaim.record.binding) || requestData.submissionRef !== preparedClaim.record.submissionRef ||
        requestData.submissionHash !== preparedClaim.record.submissionHash || requestData.sourceDirectoryHash !== preparedClaim.sourceDirectoryHash) deny("request_changed");
      const head = db.read<IntakeHeadRecord>(PM_INTAKE_NAMESPACES.heads, claim.binding.requirementId);
      if (!head || head.data.requestId !== requestData.requestId || head.data.reviewId !== null || !same(head.data.binding, claim.binding)) deny("request_not_current");
      if (db.list<IntakeReviewRecord>(PM_INTAKE_NAMESPACES.reviews).some((entry) => (entry.data as { requestId?: unknown }).requestId === requestData.requestId)) deny("request_already_reviewed");
      db.create(PM_INTAKE_NAMESPACES.reviews, preparedClaim.record.reviewId, preparedClaim.record, preparedClaim.record.reviewId);
      const operationRecord: IntakeOperationRecord = { format: "pm-intake-operation/v1", operationId: preparedClaim.operationId,
        operation: "review", intentHash: preparedClaim.intentHash, resultId: preparedClaim.record.reviewId, createdAt: preparedClaim.createdAt };
      db.create(PM_INTAKE_NAMESPACES.operations, preparedClaim.operationId, operationRecord, preparedClaim.operationId);
      db.update(PM_INTAKE_NAMESPACES.heads, claim.binding.requirementId, head.version,
        { ...head.data, reviewId: preparedClaim.record.reviewId, updatedAt: requestData.createdAt });
      const after = captureFrameIn(db, preparedClaim.frame.selector, preparedClaim.frame);
      assertTransition(preparedClaim.frame, after, preparedClaim, preparedClaim.record, claim);
      this.#currentResult(after, claim, preparedClaim.record.requestId, preparedClaim.record.reviewId);
      this.#assertClaimIn(db, preparedClaim.proof, this.#observedAt(clock), false);
      return this.#ready({ record: clone(preparedClaim.record), currentProof: this.#resultProof(claim, after), idempotent: false }, claim, clock);
    }));
  }

  readRequest(requestId: string, proof: IntakeCurrentProof): StoredIntakeRequest {
    if (!UUID.test(requestId)) deny("invalid_request");
    const clock = this.#clockAfter();
    return withDatabase(repositoryDatabase(this.#dataRoot, this.#repoId), (db) => db.transaction(() => {
      const claim = this.#assertClaimIn(db, proof, this.#observedAt(clock));
      const frame = captureFrameIn(db, { requirementId: claim.binding.requirementId, directoryHash: claim.sourceDirectoryHash, requestId });
      const record = this.#currentResult(frame, claim, requestId);
      this.#assertClaimIn(db, proof, this.#observedAt(clock));
      return this.#ready({ record: clone(record), sourceDirectory: clone(claim.sourceDirectory), currentProof: this.#resultProof(claim, frame), idempotent: true }, claim, clock);
    }));
  }

  /** 只读本需求当前接手头及其请求、核对与来源目录，供调度门槛组装连续性事实；不签发凭据或权限。 */
  readHead(requirementId: string): { request: IntakeRequestRecord; review: IntakeReviewRecord | null; directory: IntakeSourceDirectory } | null {
    if (!UUID.test(requirementId)) deny("invalid_requirement");
    const ns = PM_INTAKE_NAMESPACES;
    return withDatabase(repositoryDatabase(this.#dataRoot, this.#repoId), (db) => db.transaction(() => {
      const headRow = db.read(ns.heads, requirementId);
      if (!headRow) return null;
      const head = checkedHead(headRow.data);
      const requestRow = db.read(ns.requests, head.requestId);
      if (!requestRow) deny("stored_record_invalid");
      const request = checkedRequest(requestRow.data);
      const directoryRow = db.read(ns.directories, request.sourceDirectoryHash);
      if (!directoryRow) deny("stored_record_invalid");
      const directory = checkedDirectoryRecord(directoryRow.data).sourceDirectory;
      const reviewRow = head.reviewId ? db.read(ns.reviews, head.reviewId) : null;
      if (head.reviewId && !reviewRow) deny("stored_record_invalid");
      const review = reviewRow ? clone(reviewRow.data) as IntakeReviewRecord : null;
      return { request: clone(request), review, directory: clone(directory) };
    }));
  }
}
