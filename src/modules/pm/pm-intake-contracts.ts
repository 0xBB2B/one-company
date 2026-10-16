import { isDeepStrictEqual } from "node:util";
import { requirementStateWhy } from "../requirement/requirement-contracts.ts";
import { adviceIn } from "../../core/exec/tool-failure.ts";
import type { FailureAdvice } from "../../core/exec/tool-failure.ts";
import { Type } from "typebox";
import type { Static, TProperties, TSchema } from "typebox";
import { Value } from "typebox/value";
import { UUID_V7_PATTERN } from "../../core/storage/database.ts";

/**
 * PM 接手材料及连续关系的纯契约检查。
 * 外部事实、核对者身份、当前授权与来源目录由调用方提供；
 * 本模块不读取或写入任何存储，不制造主代理/用户身份，也不签发规划、派工或执行权限。
 */
export const PM_INTAKE_LIMITS = Object.freeze({
  textCodepoints: 400,
  groupItems: 32,
  sourceRefs: 128,
  sourceRefsPerItem: 32,
  shortIssues: 8,
  jsonBytes: 32_768,
} as const);

const object = <P extends TProperties>(properties: P) => Type.Object(properties, { additionalProperties: false });
const uuidV7 = Type.String({ pattern: UUID_V7_PATTERN.source, minLength: 36, maxLength: 36 });
const hash = Type.String({ pattern: "^[0-9a-f]{64}$", minLength: 64, maxLength: 64 });
const commit = Type.String({ pattern: "^(?:[0-9a-f]{40}|[0-9a-f]{64})$" });
const positive = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const boundedText = Type.String({ minLength: 1 });
const opaqueId = Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._:/#@+|-]{0,255}$", maxLength: 256 });
const workspaceRef = Type.String({ pattern: "^refs/heads/[^\\u0000-\\u0020]+$", maxLength: 1_024 });
const approvalScopeVersion = Type.String({ pattern: "^intake-approval-scope/v1:[0-9a-f]{64}$" });
const actionScopeVersion = Type.String({ pattern: "^intake-action-scope/v1:[0-9a-f]{64}$" });

export const IntakeBindingSchema = object({
  repoId: hash,
  requirementId: uuidV7,
  approvedProdCommit: commit,
  approvedRevision: positive,
  approvedProdHash: hash,
  approvalManifestHash: hash,
  approvalScopeVersion,
  actionScopeVersion,
  workspaceId: hash,
  workspaceRef,
  epoch: positive,
  pmRunId: uuidV7,
  pmFence: positive,
  contextGeneration: positive,
});
export type IntakeBinding = Static<typeof IntakeBindingSchema>;

export const IntakeSourceRefSchema = object({
  kind: Type.Union([
    Type.Literal("prod-unit"),
    Type.Literal("prod-scenario"),
    Type.Literal("decision"),
    Type.Literal("question"),
  ]),
  id: opaqueId,
});
export type IntakeSourceRef = Static<typeof IntakeSourceRefSchema>;

const sourceRefs = Type.Array(IntakeSourceRefSchema, {
  minItems: 1,
  maxItems: PM_INTAKE_LIMITS.sourceRefsPerItem,
});
const statement = object({ text: boundedText, sourceRefs });
const statementGroup = Type.Array(statement, { maxItems: PM_INTAKE_LIMITS.groupItems });
const unresolvedItem = object({ text: boundedText, impact: boundedText, sourceRefs });
const coverageItem = object({
  scenarioId: opaqueId,
  status: Type.Union([Type.Literal("covered"), Type.Literal("uncovered")]),
  summary: boundedText,
  sourceRefs,
});

export const PmUnderstandingSchema = object({
  format: Type.Literal("pm-understanding/v1"),
  binding: IntakeBindingSchema,
  goals: Type.Array(statement, { minItems: 1, maxItems: PM_INTAKE_LIMITS.groupItems }),
  nonGoals: statementGroup,
  constraints: statementGroup,
  allowedActions: statementGroup,
  unresolved: Type.Array(unresolvedItem, { maxItems: PM_INTAKE_LIMITS.groupItems }),
  scenarioCoverage: Type.Array(coverageItem, { minItems: 1, maxItems: PM_INTAKE_LIMITS.groupItems }),
});
export type PmUnderstanding = Static<typeof PmUnderstandingSchema>;

const sourceIdList = Type.Array(opaqueId);
export const IntakeSourceDirectorySchema = object({
  prodUnitIds: sourceIdList,
  prodScenarioIds: sourceIdList,
  decisionIds: sourceIdList,
  questionIds: sourceIdList,
  requiredScenarioIds: Type.Array(opaqueId, { minItems: 1, maxItems: PM_INTAKE_LIMITS.groupItems }),
});
export type IntakeSourceDirectory = Static<typeof IntakeSourceDirectorySchema>;

export const IntakeReviewRecordSchema = object({
  format: Type.Literal("pm-intake-review/v1"),
  reviewId: uuidV7,
  requestId: uuidV7,
  binding: IntakeBindingSchema,
  submissionRef: opaqueId,
  submissionHash: hash,
  reviewer: object({ windowId: opaqueId, sessionId: opaqueId, toolCallId: opaqueId }),
  result: Type.Union([
    Type.Literal("passed"),
    Type.Literal("pm_correction_required"),
    Type.Literal("prod_revision_required"),
    Type.Literal("clarification_required"),
  ]),
  sourceRefs: Type.Array(IntakeSourceRefSchema, { maxItems: PM_INTAKE_LIMITS.sourceRefs }),
  shortIssues: Type.Array(boundedText, { maxItems: PM_INTAKE_LIMITS.shortIssues }),
});
export type IntakeReviewRecord = Static<typeof IntakeReviewRecordSchema>;

const submissionBaseline = object({ submissionRef: opaqueId, submissionHash: hash });

/**
 * currentState 是调用方在同一受控操作内提供的竞争检查数据，不是本模块验证出的安全事实。
 * sourceDirectory 只绑定 currentBinding，接手记录的出处也按它核对。
 * requirementRecordVersion 只用于本次判定，不进入永久接手绑定。
 */
export const IntakeContinuityFactsSchema = object({
  format: Type.Literal("pm-intake-continuity-facts/v1"),
  currentBinding: IntakeBindingSchema,
  currentState: object({
    lifecycle: Type.Union([Type.Literal("draft"), Type.Literal("active"), Type.Literal("closing"), Type.Literal("closed")]),
    requirementRecordVersion: positive,
    actionAuthorizationReportedCurrent: Type.Boolean(),
    sourceDirectoryReportedCurrent: Type.Boolean(),
    pendingApprovedUpdate: Type.Boolean(),
  }),
  sourceDirectory: IntakeSourceDirectorySchema,
  rootReview: Type.Union([IntakeReviewRecordSchema, Type.Null()]),
  understandingBaseline: Type.Union([submissionBaseline, Type.Null()]),
});
export type IntakeContinuityFacts = Static<typeof IntakeContinuityFactsSchema>;

export type IntakeContractErrorCode =
  | "invalid_shape"
  | "resource_limit"
  | "duplicate_source"
  | "unknown_source"
  | "invalid_source_directory";

const INTAKE_CONTRACT_ADVICE: Record<string, FailureAdvice> = {
  duplicate_source: { why: "同一个出处被重复引用", next: "去掉重复的出处后重交" },
  invalid_shape: { why: "接手理解的字段不符合格式", next: "按工具说明补齐字段后重交" },
  invalid_source_directory: { why: "接手出处目录不合规", next: "停止操作，不要重试；把这段原因告诉用户" },
  resource_limit: { why: "接手理解内容超出上限", next: "精简内容后重交" },
  unknown_source: { why: "引用了任务上下文里没有的出处编号", next: "只引用任务上下文列出的出处编号" },
};
export class IntakeContractError extends Error {
  readonly code: IntakeContractErrorCode;
  readonly advice: FailureAdvice;
  constructor(code: IntakeContractErrorCode, detail?: string) {
    super(`PM 接手契约拒绝：${code}`);
    this.name = "IntakeContractError";
    this.code = code;
    this.advice = adviceIn(INTAKE_CONTRACT_ADVICE, code, detail);
  }
}

const fail = (code: IntakeContractErrorCode, detail?: string): never => { throw new IntakeContractError(code, detail); };
const codepoints = (value: string): number => Array.from(value).length;
const bytes = (value: string): number => Buffer.byteLength(value, "utf8");

function cloneChecked<T>(schema: TSchema, value: unknown): { value: T; json: string } {
  try {
    const copy = structuredClone(value);
    if (!Value.Check(schema, copy)) fail("invalid_shape");
    const json = JSON.stringify(copy);
    if (json === undefined) fail("invalid_shape");
    return { value: copy as T, json };
  } catch (error) {
    if (error instanceof IntakeContractError) throw error;
    return fail("invalid_shape");
  }
}

function checkText(value: string): void {
  if (value.trim().length === 0) fail("invalid_shape");
  for (const character of value) {
    const point = character.codePointAt(0)!;
    if (point >= 0xd800 && point <= 0xdfff) fail("invalid_shape");
  }
  if (codepoints(value) > PM_INTAKE_LIMITS.textCodepoints) fail("resource_limit");
}

function checkUnique(values: readonly string[], code: IntakeContractErrorCode = "invalid_shape"): void {
  if (new Set(values).size !== values.length) fail(code);
}

function sourceKey(ref: IntakeSourceRef): string { return `${ref.kind}\u0000${ref.id}`; }

function checkedDirectory(value: unknown): IntakeSourceDirectory {
  const checked = cloneChecked<IntakeSourceDirectory>(IntakeSourceDirectorySchema, value);
  if (bytes(checked.json) > PM_INTAKE_LIMITS.jsonBytes) fail("resource_limit");
  const directory = checked.value;
  for (const ids of [directory.prodUnitIds, directory.prodScenarioIds, directory.decisionIds, directory.questionIds, directory.requiredScenarioIds]) {
    checkUnique(ids, "duplicate_source");
  }
  if (directory.requiredScenarioIds.some((id) => !directory.prodScenarioIds.includes(id))) fail("invalid_source_directory");
  return directory;
}

function knownSource(ref: IntakeSourceRef, directory: IntakeSourceDirectory): boolean {
  const ids = ref.kind === "prod-unit" ? directory.prodUnitIds
    : ref.kind === "prod-scenario" ? directory.prodScenarioIds
      : ref.kind === "decision" ? directory.decisionIds : directory.questionIds;
  return ids.includes(ref.id);
}

/** 接手理解里不在出处清单中的引用（kind:id），供 PM 提交时当场改正。 */
export function unknownIntakeSourceRefs(value: Omit<PmUnderstanding, "format" | "binding">, directory: IntakeSourceDirectory): string[] {
  const refs = understandingRefs(value as PmUnderstanding).flat().filter((ref) => !knownSource(ref, directory)).map((ref) => `${ref.kind}:${ref.id}`);
  const scenarios = value.scenarioCoverage.filter((item) => !directory.prodScenarioIds.includes(item.scenarioId)).map((item) => `prod-scenario:${item.scenarioId}`);
  return [...new Set([...refs, ...scenarios])];
}

/** 出处里没有引用场景本身（prod-scenario:场景编号）的场景覆盖项；主代理核对时这样的提交会被拒收。 */
export function scenariosWithoutOwnRef(value: Pick<PmUnderstanding, "scenarioCoverage">): string[] {
  return value.scenarioCoverage.filter((item) => !item.sourceRefs.some((ref) => ref.kind === "prod-scenario" && ref.id === item.scenarioId)).map((item) => item.scenarioId);
}

function checkRefs(refs: readonly IntakeSourceRef[], directory: IntakeSourceDirectory): void {
  checkUnique(refs.map(sourceKey), "duplicate_source");
  if (refs.some((ref) => !knownSource(ref, directory))) fail("unknown_source");
}

function understandingRefs(value: PmUnderstanding): IntakeSourceRef[][] {
  return [
    ...value.goals.map((item) => item.sourceRefs),
    ...value.nonGoals.map((item) => item.sourceRefs),
    ...value.constraints.map((item) => item.sourceRefs),
    ...value.allowedActions.map((item) => item.sourceRefs),
    ...value.unresolved.map((item) => item.sourceRefs),
    ...value.scenarioCoverage.map((item) => item.sourceRefs),
  ];
}

export interface PmUnderstandingCheck {
  status: "accepted" | "uncovered";
  understanding: PmUnderstanding;
  uncoveredScenarioIds: string[];
}

/** 校验并复制 PM 业务理解；不要求 task 方案，也不读取或保存用户原话。 */
export function checkPmUnderstanding(value: unknown, sourceDirectory: unknown): PmUnderstandingCheck {
  const directory = checkedDirectory(sourceDirectory);
  const checked = cloneChecked<PmUnderstanding>(PmUnderstandingSchema, value);
  if (bytes(checked.json) > PM_INTAKE_LIMITS.jsonBytes) fail("resource_limit");
  const understanding = checked.value;
  const groups = [...understanding.goals, ...understanding.nonGoals, ...understanding.constraints, ...understanding.allowedActions];
  for (const item of groups) checkText(item.text);
  for (const item of understanding.unresolved) { checkText(item.text); checkText(item.impact); }
  for (const item of understanding.scenarioCoverage) { checkText(item.summary); }
  const allRefs = understandingRefs(understanding);
  if (allRefs.reduce((total, refs) => total + refs.length, 0) > PM_INTAKE_LIMITS.sourceRefs) fail("resource_limit");
  allRefs.forEach((refs) => checkRefs(refs, directory));
  checkUnique(understanding.scenarioCoverage.map((item) => item.scenarioId));
  for (const item of understanding.scenarioCoverage) {
    if (!directory.prodScenarioIds.includes(item.scenarioId)) fail("unknown_source");
    if (!item.sourceRefs.some((ref) => ref.kind === "prod-scenario" && ref.id === item.scenarioId)) fail("unknown_source");
  }
  const coverage = new Map(understanding.scenarioCoverage.map((item) => [item.scenarioId, item.status]));
  const uncoveredScenarioIds = directory.requiredScenarioIds.filter((id) => coverage.get(id) !== "covered");
  return {
    status: uncoveredScenarioIds.length ? "uncovered" : "accepted",
    understanding,
    uncoveredScenarioIds,
  };
}

export interface IntakeReviewRecordCheck {
  status: "accepted";
  record: IntakeReviewRecord;
}

/**
 * 校验待可信服务登记的核对元数据。该函数不制造 reviewer 身份、不登记记录，
 * passed 也不代表用户批准、当前权限或真实主代理核对已经成立。
 */
export function checkIntakeReviewRecord(value: unknown, sourceDirectory: unknown): IntakeReviewRecordCheck {
  const directory = checkedDirectory(sourceDirectory);
  const checked = cloneChecked<IntakeReviewRecord>(IntakeReviewRecordSchema, value);
  if (bytes(checked.json) > PM_INTAKE_LIMITS.jsonBytes) fail("resource_limit");
  const record = checked.value;
  checkRefs(record.sourceRefs, directory);
  record.shortIssues.forEach(checkText);
  if (record.result === "passed" && record.shortIssues.length) fail("invalid_shape", "result 为 passed 时 shortIssues 必须是空数组，核对通过的说明不要写进 shortIssues；确有问题要写时，result 改选 pm_correction_required、prod_revision_required 或 clarification_required");
  if (record.result !== "passed" && !record.shortIssues.length) fail("invalid_shape", `result 为 ${record.result} 时 shortIssues 至少写一条问题；没有问题就把 result 改为 passed`);
  return { status: "accepted", record };
}

export type IntakeContinuityReason =
  | "review_missing"
  | "pm_correction_required"
  | "prod_revision_required"
  | "clarification_required"
  | "understanding_baseline_missing"
  | "understanding_baseline_mismatch"
  | "requirement_binding_changed"
  | "workspace_changed"
  | "epoch_changed"
  | "new_pm_run"
  | "new_pm_fence"
  | "context_changed"
  | "action_scope_changed"
  | "approved_revision_regressed"
  | "approved_binding_changed_without_revision"
  | "requirement_not_active"
  | "lease_not_current"
  | "action_authorization_not_reported_current"
  | "source_directory_not_reported_current"
  | "pending_approved_update"
  | "impact_link_gap";
const INTAKE_REASON_TEXT: Record<IntakeContinuityReason | "requirement_not_ready", string> = {
  review_missing: "主代理还没有核对 PM 的接手理解",
  pm_correction_required: "主代理核对后要求 PM 改正接手理解",
  prod_revision_required: "主代理核对后认为需要先修订需求",
  clarification_required: "主代理核对后认为需要先向用户澄清",
  understanding_baseline_missing: "当前 PM 还没有提交接手理解",
  understanding_baseline_mismatch: "核对过的接手理解不是 PM 最新提交的那份",
  requirement_binding_changed: "需求绑定已变化",
  workspace_changed: "需求工作区已变化",
  epoch_changed: "需求已换代（epoch 变化）",
  new_pm_run: "现在是新派出的 PM，需要重新接手",
  new_pm_fence: "PM 已换代，需要重新接手",
  context_changed: "PM 会话上下文已换代，需要重新接手",
  action_scope_changed: "授权动作范围已变化",
  approved_revision_regressed: "批准版本号倒退",
  approved_binding_changed_without_revision: "批准内容变了但版本号没变",
  requirement_not_active: "需求不在活动状态",
  requirement_not_ready: "需求还没有批准版本、工作区或批准清单",
  lease_not_current: "PM 租约已失效",
  action_authorization_not_reported_current: "接手理解里的授权动作与当前批准不一致",
  source_directory_not_reported_current: "接手理解引用的出处目录不是当前的",
  pending_approved_update: "有新批准的需求版本还没复核",
  impact_link_gap: "有批准更新还没做影响复核",
};
/** 接手核对未通过的缺项说明；租约等状态类原因取需求状态的说明。 */
export function intakeReasonText(code: string): string {
  return Object.hasOwn(INTAKE_REASON_TEXT, code) ? INTAKE_REASON_TEXT[code as keyof typeof INTAKE_REASON_TEXT] : requirementStateWhy(code) ?? `未归类（${code}）`;
}

export interface IntakeContinuityEvaluation {
  status: "contract_ready" | "review_required" | "blocked";
  reasons: IntakeContinuityReason[];
  contractReady: boolean;
  reviewRequired: boolean;
}

function addReason(reasons: IntakeContinuityReason[], reason: IntakeContinuityReason): void {
  if (!reasons.includes(reason)) reasons.push(reason);
}
function samePhysicalBinding(root: IntakeBinding, current: IntakeBinding, reasons: IntakeContinuityReason[]): void {
  if (root.repoId !== current.repoId || root.requirementId !== current.requirementId) addReason(reasons, "requirement_binding_changed");
  if (root.workspaceId !== current.workspaceId || root.workspaceRef !== current.workspaceRef) addReason(reasons, "workspace_changed");
  if (root.epoch !== current.epoch) addReason(reasons, "epoch_changed");
  if (root.pmRunId !== current.pmRunId) addReason(reasons, "new_pm_run");
  if (root.pmFence !== current.pmFence) addReason(reasons, "new_pm_fence");
  if (root.contextGeneration !== current.contextGeneration) addReason(reasons, "context_changed");
}
/**
 * 纯判定接手记录到当前批准绑定的连续关系。输入中的“当前”布尔值由调用方提供，本模块不核实；
 * 批准版本前进后的逐次影响复核由调用方的门槛核对，这里只记缺口。
 * contractReady 只说明契约材料齐备，永远不签发权限或宣称外部事实已被本模块真实验证。
 */
export function evaluateIntakeContinuity(value: unknown): IntakeContinuityEvaluation {
  const checked = cloneChecked<IntakeContinuityFacts>(IntakeContinuityFactsSchema, value);
  if (bytes(checked.json) > PM_INTAKE_LIMITS.jsonBytes) fail("resource_limit");
  const facts = checked.value;
  const directory = checkedDirectory(facts.sourceDirectory);
  const reasons: IntakeContinuityReason[] = [];

  if (facts.currentState.lifecycle !== "active") addReason(reasons, "requirement_not_active");
  if (!facts.currentState.actionAuthorizationReportedCurrent) addReason(reasons, "action_authorization_not_reported_current");
  if (!facts.currentState.sourceDirectoryReportedCurrent) addReason(reasons, "source_directory_not_reported_current");
  if (facts.currentState.pendingApprovedUpdate) addReason(reasons, "pending_approved_update");

  const review = facts.rootReview;
  if (review === null) addReason(reasons, "review_missing");
  else {
    checkIntakeReviewRecord(review, directory);
    if (review.result !== "passed") addReason(reasons, review.result);
    if (facts.understandingBaseline === null) addReason(reasons, "understanding_baseline_missing");
    else if (facts.understandingBaseline.submissionRef !== review.submissionRef || facts.understandingBaseline.submissionHash !== review.submissionHash) {
      addReason(reasons, "understanding_baseline_mismatch");
    }
    samePhysicalBinding(review.binding, facts.currentBinding, reasons);

    const sameApprovedRevision = review.binding.approvedRevision === facts.currentBinding.approvedRevision;
    const sameApprovedBundle = review.binding.approvedProdCommit === facts.currentBinding.approvedProdCommit
      && review.binding.approvedProdHash === facts.currentBinding.approvedProdHash
      && review.binding.approvalManifestHash === facts.currentBinding.approvalManifestHash
      && review.binding.approvalScopeVersion === facts.currentBinding.approvalScopeVersion;

    if (facts.currentBinding.approvedRevision < review.binding.approvedRevision) addReason(reasons, "approved_revision_regressed");
    else if (sameApprovedRevision && review.binding.actionScopeVersion !== facts.currentBinding.actionScopeVersion) {
      addReason(reasons, "action_scope_changed");
    }
    if (sameApprovedRevision && !sameApprovedBundle) addReason(reasons, "approved_binding_changed_without_revision");
    else if (facts.currentBinding.approvedRevision > review.binding.approvedRevision) addReason(reasons, "impact_link_gap");
  }

  const reviewReasons = new Set<IntakeContinuityReason>([
    "review_missing", "pm_correction_required", "prod_revision_required", "clarification_required",
    "understanding_baseline_missing", "understanding_baseline_mismatch", "requirement_binding_changed", "workspace_changed",
    "epoch_changed", "new_pm_run", "new_pm_fence", "context_changed", "action_scope_changed",
    "approved_revision_regressed", "approved_binding_changed_without_revision",
  ]);
  const reviewRequired = reasons.some((reason) => reviewReasons.has(reason));
  const contractReady = reasons.length === 0;
  const status = contractReady ? "contract_ready" : reviewRequired ? "review_required" : "blocked";
  const result: IntakeContinuityEvaluation = { status, reasons, contractReady, reviewRequired };
  if (bytes(JSON.stringify(result)) > PM_INTAKE_LIMITS.jsonBytes) fail("resource_limit");
  return result;
}

/** 对象键顺序不参与契约等值判断；数组顺序仍保留协议语义。 */
export function intakeBindingsEqual(left: unknown, right: unknown): { equal: boolean } {
  const a = cloneChecked<IntakeBinding>(IntakeBindingSchema, left).value;
  const b = cloneChecked<IntakeBinding>(IntakeBindingSchema, right).value;
  return { equal: isDeepStrictEqual(a, b) };
}
