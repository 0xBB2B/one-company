import { isDeepStrictEqual } from "node:util";
import { Type } from "typebox";
import type { Static, TProperties, TSchema } from "typebox";
import { Value } from "typebox/value";
import { UUID_V7_PATTERN } from "./database.ts";

/**
 * M4 只提供 PM 接手材料及连续关系的纯契约检查。
 * 外部事实、核对者身份、当前授权、来源目录和任务全集均须由未来可信服务提供；
 * 本模块不读取或写入任何存储，不制造主代理/用户身份，也不签发规划、派工或执行权限。
 */
export const PM_INTAKE_LIMITS = Object.freeze({
  textCodepoints: 400,
  groupItems: 32,
  sourceRefs: 128,
  sourceRefsPerItem: 32,
  shortIssues: 8,
  impactLinks: 32,
  historicalSourceDirectories: 32,
  tasksPerLink: 32,
  jsonBytes: 32_768,
  identifierCodepoints: 256,
} as const);

const object = <P extends TProperties>(properties: P) => Type.Object(properties, { additionalProperties: false });
const uuidV7 = Type.String({ pattern: UUID_V7_PATTERN.source, minLength: 36, maxLength: 36 });
const hash = Type.String({ pattern: "^[0-9a-f]{64}$", minLength: 64, maxLength: 64 });
const commit = Type.String({ pattern: "^(?:[0-9a-f]{40}|[0-9a-f]{64})$" });
const positive = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const counter = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
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

const sourceIdList = Type.Array(opaqueId, { maxItems: PM_INTAKE_LIMITS.sourceRefs });
export const IntakeSourceDirectorySchema = object({
  prodUnitIds: sourceIdList,
  prodScenarioIds: sourceIdList,
  decisionIds: sourceIdList,
  questionIds: sourceIdList,
  requiredScenarioIds: Type.Array(opaqueId, { minItems: 1, maxItems: PM_INTAKE_LIMITS.groupItems }),
});
export type IntakeSourceDirectory = Static<typeof IntakeSourceDirectorySchema>;

export const IntakeHistoricalSourceDirectorySchema = object({
  binding: IntakeBindingSchema,
  sourceDirectory: IntakeSourceDirectorySchema,
});
export type IntakeHistoricalSourceDirectory = Static<typeof IntakeHistoricalSourceDirectorySchema>;

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

const taskVersionRef = object({ taskId: opaqueId, version: positive });
const assessment = Type.Union([Type.Literal("unaffected"), Type.Literal("affected"), Type.Literal("unknown")]);
export const IntakeImpactSourceRefSchema = object({
  kind: Type.Union([
    Type.Literal("prod-unit"),
    Type.Literal("prod-scenario"),
    Type.Literal("decision"),
    Type.Literal("question"),
  ]),
  id: opaqueId,
  baseline: Type.Union([Type.Literal("from"), Type.Literal("to")]),
});
export type IntakeImpactSourceRef = Static<typeof IntakeImpactSourceRefSchema>;
const impactSourceRefs = Type.Array(IntakeImpactSourceRefSchema, {
  minItems: 1,
  maxItems: PM_INTAKE_LIMITS.sourceRefsPerItem,
});
const taskAssessment = object({ taskId: opaqueId, version: positive, assessment, rationale: boundedText, sourceRefs: impactSourceRefs });
const globalAssessment = object({ assessment, rationale: boundedText, sourceRefs: impactSourceRefs });
const approvedEvent = object({
  eventId: uuidV7,
  sequence: positive,
  fromCommit: commit,
  toCommit: commit,
  fromRevision: positive,
  toRevision: positive,
  fromHash: hash,
  toHash: hash,
});

export const IntakeRootReviewBindingSchema = object({
  reviewId: uuidV7,
  requestId: uuidV7,
  submissionRef: opaqueId,
  submissionHash: hash,
});
export type IntakeRootReviewBinding = Static<typeof IntakeRootReviewBindingSchema>;

export const IntakeImpactLinkSchema = object({
  format: Type.Literal("pm-intake-impact-link/v1"),
  linkId: uuidV7,
  previousLinkId: Type.Union([uuidV7, Type.Null()]),
  rootReview: IntakeRootReviewBindingSchema,
  from: IntakeBindingSchema,
  to: IntakeBindingSchema,
  approvedEvent,
  taskAssessments: Type.Array(taskAssessment, { maxItems: PM_INTAKE_LIMITS.tasksPerLink }),
  globalAssessment,
});
export type IntakeImpactLink = Static<typeof IntakeImpactLinkSchema>;

const completeTaskSet = object({
  eventId: uuidV7,
  tasks: Type.Array(taskVersionRef, { maxItems: PM_INTAKE_LIMITS.tasksPerLink }),
});
const submissionBaseline = object({ submissionRef: opaqueId, submissionHash: hash });

/**
 * currentState 是调用方在同一受控操作内提供的竞争检查数据，不是本模块验证出的安全事实。
 * sourceDirectory 只绑定 currentBinding；历史目录只保存链端点对应的有界来源 ID 元数据，不含旧正文。
 * requirementRecordVersion 与 leaseExpiresAt 只用于本次判定，不进入永久接手绑定。
 */
export const IntakeContinuityFactsSchema = object({
  format: Type.Literal("pm-intake-continuity-facts/v1"),
  currentBinding: IntakeBindingSchema,
  currentState: object({
    lifecycle: Type.Union([Type.Literal("draft"), Type.Literal("active"), Type.Literal("closing"), Type.Literal("closed")]),
    requirementRecordVersion: positive,
    leaseExpiresAt: counter,
    observedAt: counter,
    actionAuthorizationReportedCurrent: Type.Boolean(),
    sourceDirectoryReportedCurrent: Type.Boolean(),
    pendingApprovedUpdate: Type.Boolean(),
  }),
  sourceDirectory: IntakeSourceDirectorySchema,
  historicalSourceDirectories: Type.Array(IntakeHistoricalSourceDirectorySchema, {
    maxItems: PM_INTAKE_LIMITS.historicalSourceDirectories,
  }),
  rootReview: Type.Union([IntakeReviewRecordSchema, Type.Null()]),
  understandingBaseline: Type.Union([submissionBaseline, Type.Null()]),
  rootEventSequence: counter,
  impactLinks: Type.Array(IntakeImpactLinkSchema, { maxItems: PM_INTAKE_LIMITS.impactLinks }),
  completeTaskSets: Type.Array(completeTaskSet, { maxItems: PM_INTAKE_LIMITS.impactLinks }),
});
export type IntakeContinuityFacts = Static<typeof IntakeContinuityFactsSchema>;

export type IntakeContractErrorCode =
  | "invalid_shape"
  | "resource_limit"
  | "duplicate_source"
  | "unknown_source"
  | "invalid_source_directory";

export class IntakeContractError extends Error {
  readonly code: IntakeContractErrorCode;
  constructor(code: IntakeContractErrorCode) {
    super(`PM 接手契约拒绝：${code}`);
    this.name = "IntakeContractError";
    this.code = code;
  }
}

const disabled = Object.freeze({ executionEnabled: false as const, scheduling: "not_implemented" as const });
const fail = (code: IntakeContractErrorCode): never => { throw new IntakeContractError(code); };
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
  executionEnabled: false;
  scheduling: "not_implemented";
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
    ...disabled,
  };
}

export interface IntakeReviewRecordCheck {
  status: "accepted";
  record: IntakeReviewRecord;
  executionEnabled: false;
  scheduling: "not_implemented";
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
  if ((record.result === "passed") !== (record.shortIssues.length === 0)) fail("invalid_shape");
  return { status: "accepted", record, ...disabled };
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
  | "unexpected_impact_links"
  | "impact_link_duplicate"
  | "impact_link_conflict"
  | "impact_link_out_of_order"
  | "impact_link_gap"
  | "impact_link_event_mismatch"
  | "impact_link_root_mismatch"
  | "impact_link_task_set_missing"
  | "impact_link_task_set_conflict"
  | "impact_link_unknown_task"
  | "impact_link_missing_task"
  | "impact_link_terminal_not_current"
  | "impact_affected"
  | "impact_unknown";

export interface IntakeContinuityEvaluation {
  status: "contract_ready" | "review_required" | "impact_action_required" | "blocked";
  reasons: IntakeContinuityReason[];
  contractReady: boolean;
  reviewRequired: boolean;
  impact: "not_applicable" | "unaffected" | "affected" | "unknown";
  affectedTasks: Array<{ taskId: string; version: number }>;
  unknownTasks: Array<{ taskId: string; version: number }>;
  executionEnabled: false;
  scheduling: "not_implemented";
}

const bindingKeys = Object.keys(IntakeBindingSchema.properties) as Array<keyof IntakeBinding>;
function sameBinding(left: IntakeBinding, right: IntakeBinding): boolean {
  return bindingKeys.every((key) => left[key] === right[key]);
}
function sameTask(left: { taskId: string; version: number }, right: { taskId: string; version: number }): boolean {
  return left.taskId === right.taskId && left.version === right.version;
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
function bindingKey(value: IntakeBinding): string {
  return bindingKeys.map((key) => `${String(key)}=${String(value[key])}`).join("\u0000");
}
function checkedHistoricalDirectories(
  facts: IntakeContinuityFacts,
  currentDirectory: IntakeSourceDirectory,
): Map<string, IntakeSourceDirectory> {
  const allowedBindings: IntakeBinding[] = [];
  if (facts.rootReview) allowedBindings.push(facts.rootReview.binding);
  for (const link of facts.impactLinks) allowedBindings.push(link.from, link.to);
  const directories = new Map<string, IntakeSourceDirectory>();
  for (const entry of facts.historicalSourceDirectories) {
    const entryDirectory = checkedDirectory(entry.sourceDirectory);
    if (sameBinding(entry.binding, facts.currentBinding)
      || !allowedBindings.some((allowed) => sameBinding(allowed, entry.binding))) {
      fail("invalid_source_directory");
    }
    const key = bindingKey(entry.binding);
    if (directories.has(key)) fail("duplicate_source");
    directories.set(key, entryDirectory);
  }
  directories.set(bindingKey(facts.currentBinding), currentDirectory);
  return directories;
}
function directoryForBinding(
  binding: IntakeBinding,
  directories: ReadonlyMap<string, IntakeSourceDirectory>,
): IntakeSourceDirectory {
  return directories.get(bindingKey(binding)) ?? fail("invalid_source_directory");
}
function checkImpactRefs(
  refs: readonly IntakeImpactSourceRef[],
  link: IntakeImpactLink,
  directories: ReadonlyMap<string, IntakeSourceDirectory>,
): void {
  checkUnique(refs.map((ref) => `${sourceKey(ref)}\u0000${ref.baseline}`), "duplicate_source");
  for (const ref of refs) {
    const directory = directoryForBinding(ref.baseline === "from" ? link.from : link.to, directories);
    if (!knownSource(ref, directory)) fail("unknown_source");
  }
}
function sameRootReview(link: IntakeImpactLink, review: IntakeReviewRecord): boolean {
  return link.rootReview.reviewId === review.reviewId
    && link.rootReview.requestId === review.requestId
    && link.rootReview.submissionRef === review.submissionRef
    && link.rootReview.submissionHash === review.submissionHash;
}
function exactEvent(link: IntakeImpactLink): boolean {
  return link.approvedEvent.fromCommit === link.from.approvedProdCommit
    && link.approvedEvent.toCommit === link.to.approvedProdCommit
    && link.approvedEvent.fromRevision === link.from.approvedRevision
    && link.approvedEvent.toRevision === link.to.approvedRevision
    && link.approvedEvent.fromHash === link.from.approvedProdHash
    && link.approvedEvent.toHash === link.to.approvedProdHash;
}
function uniqueTasks(tasks: ReadonlyArray<{ taskId: string; version: number }>): boolean {
  return new Set(tasks.map((task) => task.taskId)).size === tasks.length;
}

/**
 * 纯判定接手记录到当前批准绑定的连续关系。输入中的“当前”布尔值只是未来服务提供的事实参数；
 * contractReady 只说明契约材料齐备，永远不签发权限或宣称外部事实已被本模块真实验证。
 */
export function evaluateIntakeContinuity(value: unknown): IntakeContinuityEvaluation {
  const checked = cloneChecked<IntakeContinuityFacts>(IntakeContinuityFactsSchema, value);
  if (bytes(checked.json) > PM_INTAKE_LIMITS.jsonBytes) fail("resource_limit");
  const facts = checked.value;
  const directory = checkedDirectory(facts.sourceDirectory);
  const historicalDirectories = checkedHistoricalDirectories(facts, directory);
  const reasons: IntakeContinuityReason[] = [];
  const affectedTasks: Array<{ taskId: string; version: number }> = [];
  const unknownTasks: Array<{ taskId: string; version: number }> = [];

  if (facts.currentState.lifecycle !== "active") addReason(reasons, "requirement_not_active");
  if (facts.currentState.leaseExpiresAt <= facts.currentState.observedAt) addReason(reasons, "lease_not_current");
  if (!facts.currentState.actionAuthorizationReportedCurrent) addReason(reasons, "action_authorization_not_reported_current");
  if (!facts.currentState.sourceDirectoryReportedCurrent) addReason(reasons, "source_directory_not_reported_current");
  if (facts.currentState.pendingApprovedUpdate) addReason(reasons, "pending_approved_update");

  const review = facts.rootReview;
  if (review === null) {
    addReason(reasons, "review_missing");
    if (facts.impactLinks.length || facts.completeTaskSets.length) addReason(reasons, "unexpected_impact_links");
  } else {
    checkIntakeReviewRecord(review, directoryForBinding(review.binding, historicalDirectories));
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
    else if (sameApprovedRevision && sameApprovedBundle) {
      if (facts.impactLinks.length || facts.completeTaskSets.length) addReason(reasons, "unexpected_impact_links");
    } else if (facts.currentBinding.approvedRevision > review.binding.approvedRevision) {
      const linkIds = facts.impactLinks.map((link) => link.linkId);
      const eventIds = facts.impactLinks.map((link) => link.approvedEvent.eventId);
      const taskSetEventIds = facts.completeTaskSets.map((set) => set.eventId);
      if (new Set(linkIds).size !== linkIds.length || new Set(eventIds).size !== eventIds.length || new Set(taskSetEventIds).size !== taskSetEventIds.length) {
        addReason(reasons, "impact_link_duplicate");
      }
      if (facts.completeTaskSets.length !== facts.impactLinks.length || facts.completeTaskSets.some((set) => !eventIds.includes(set.eventId))) {
        addReason(reasons, "impact_link_task_set_conflict");
      }
      let cursor = review.binding;
      let previousLinkId: string | null = null;
      let expectedSequence = facts.rootEventSequence + 1;
      let impactReferenceCount = review.sourceRefs.length;
      for (const link of facts.impactLinks) {
        link.taskAssessments.forEach((item) => { checkText(item.rationale); checkImpactRefs(item.sourceRefs, link, historicalDirectories); });
        checkText(link.globalAssessment.rationale);
        checkImpactRefs(link.globalAssessment.sourceRefs, link, historicalDirectories);
        impactReferenceCount += link.globalAssessment.sourceRefs.length
          + link.taskAssessments.reduce((total, item) => total + item.sourceRefs.length, 0);
        if (impactReferenceCount > PM_INTAKE_LIMITS.sourceRefs) fail("resource_limit");
        if (!sameBinding(link.from, cursor) || link.previousLinkId !== previousLinkId) addReason(reasons, "impact_link_out_of_order");
        if (!sameRootReview(link, review)) addReason(reasons, "impact_link_root_mismatch");
        samePhysicalBinding(review.binding, link.from, reasons);
        samePhysicalBinding(review.binding, link.to, reasons);
        if (link.to.approvedRevision !== link.from.approvedRevision + 1 || link.approvedEvent.sequence !== expectedSequence) {
          addReason(reasons, "impact_link_gap");
        }
        if (!exactEvent(link) || link.from.approvedProdCommit.length !== link.to.approvedProdCommit.length) {
          addReason(reasons, "impact_link_event_mismatch");
        }

        const expectedSet = facts.completeTaskSets.find((set) => set.eventId === link.approvedEvent.eventId);
        if (!expectedSet) addReason(reasons, "impact_link_task_set_missing");
        else {
          if (!uniqueTasks(expectedSet.tasks) || !uniqueTasks(link.taskAssessments)) addReason(reasons, "impact_link_task_set_conflict");
          for (const item of link.taskAssessments) {
            if (!expectedSet.tasks.some((task) => sameTask(task, item))) addReason(reasons, "impact_link_unknown_task");
            if (item.assessment === "affected" && !affectedTasks.some((task) => sameTask(task, item))) affectedTasks.push({ taskId: item.taskId, version: item.version });
            if (item.assessment === "unknown" && !unknownTasks.some((task) => sameTask(task, item))) unknownTasks.push({ taskId: item.taskId, version: item.version });
          }
          if (expectedSet.tasks.some((task) => !link.taskAssessments.some((item) => sameTask(task, item)))) addReason(reasons, "impact_link_missing_task");
        }
        if (link.globalAssessment.assessment === "affected") addReason(reasons, "impact_affected");
        if (link.globalAssessment.assessment === "unknown") addReason(reasons, "impact_unknown");
        if (link.taskAssessments.some((item) => item.assessment === "affected")) addReason(reasons, "impact_affected");
        if (link.taskAssessments.some((item) => item.assessment === "unknown")) addReason(reasons, "impact_unknown");
        cursor = link.to;
        previousLinkId = link.linkId;
        expectedSequence++;
      }
      if (!sameBinding(cursor, facts.currentBinding)) addReason(reasons, "impact_link_terminal_not_current");
      if (!facts.impactLinks.length) addReason(reasons, "impact_link_gap");
    }
  }

  const reviewReasons = new Set<IntakeContinuityReason>([
    "review_missing", "pm_correction_required", "prod_revision_required", "clarification_required",
    "understanding_baseline_missing", "understanding_baseline_mismatch", "requirement_binding_changed", "workspace_changed",
    "epoch_changed", "new_pm_run", "new_pm_fence", "context_changed", "action_scope_changed",
    "approved_revision_regressed", "approved_binding_changed_without_revision",
  ]);
  const reviewRequired = reasons.some((reason) => reviewReasons.has(reason));
  const impact = reasons.includes("impact_unknown") ? "unknown"
    : reasons.includes("impact_affected") ? "affected"
      : review && facts.currentBinding.approvedRevision > review.binding.approvedRevision ? "unaffected" : "not_applicable";
  const contractReady = reasons.length === 0;
  const status = contractReady ? "contract_ready"
    : reviewRequired ? "review_required"
      : impact === "affected" || impact === "unknown" ? "impact_action_required" : "blocked";
  const result: IntakeContinuityEvaluation = {
    status,
    reasons,
    contractReady,
    reviewRequired,
    impact,
    affectedTasks,
    unknownTasks,
    ...disabled,
  };
  if (bytes(JSON.stringify(result)) > PM_INTAKE_LIMITS.jsonBytes) fail("resource_limit");
  return result;
}

/** 对象键顺序不参与契约等值判断；数组顺序仍保留协议语义。 */
export function intakeBindingsEqual(left: unknown, right: unknown): {
  equal: boolean;
  executionEnabled: false;
  scheduling: "not_implemented";
} {
  const a = cloneChecked<IntakeBinding>(IntakeBindingSchema, left).value;
  const b = cloneChecked<IntakeBinding>(IntakeBindingSchema, right).value;
  return { equal: isDeepStrictEqual(a, b), ...disabled };
}
