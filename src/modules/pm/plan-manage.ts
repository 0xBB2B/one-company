import { createHash } from "node:crypto";
import { intakeReasonText } from "./pm-intake-contracts.ts";
import { COMMON_ADVICE, withDetail } from "../../core/exec/tool-failure.ts";
import type { FailureAdvice } from "../../core/exec/tool-failure.ts";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isPromise } from "node:util/types";
import { Type } from "typebox";
import type { Static } from "typebox";
import { Value } from "typebox/value";
import { approvalDependencyClosure } from "../requirement/approval-manifest.ts";
import type { ApprovalManifest } from "../requirement/approval-manifest.ts";
import { registeredApprovalManifestIn } from "../requirement/approval-manifest-store.ts";
import { VerificationPerformance } from "../verification/check-round.ts";
import { authorizeToolAction, writePathAllowed } from "../../core/policy/core-permissions.ts";
import { repositoryDatabase, uuidv7, withDatabase } from "../../core/storage/database.ts";
import type { LocalDatabase, StoredRecord } from "../../core/storage/database.ts";
import { clearPlanRejections, notePlanRejection, PLAN_CONTENT_CODES } from "./pm-attention.ts";
import { evaluatePmIntakeGate } from "./pm-intake-runtime.ts";
import { checked, hash, id, object, PmLease, positive } from "../requirement/requirement-contracts.ts";
import type { RequirementRecord } from "../requirement/requirement-contracts.ts";
import type { RequirementDocSection } from "../requirement/requirement-doc.ts";
import { checkServiceInput } from "../requirement/requirement-manage-contracts.ts";
import { RequirementStateStore } from "../requirement/requirement-state.ts";
import { writeFileAtomic } from "../../core/storage/store.ts";

export const PLANS = "plans";
export const TASKS = "tasks";
const text = Type.String({ minLength: 1, maxLength: 1024 });
const texts = (min: number) => Type.Array(text, { minItems: min, maxItems: 16 });
const unitId = Type.String({ pattern: "^[A-Za-z][A-Za-z0-9._-]{0,95}$" });
const unitIds = (min: number) => Type.Array(unitId, { minItems: min, uniqueItems: true });
const key = Type.String({ minLength: 1, maxLength: 64, pattern: "^[A-Za-z0-9._-]+$" });
/** 执行该任务的角色定义名称；缺省用与职责同名的默认定义。 */
const agentName = Type.String({ pattern: "^[a-z0-9][a-z0-9-]{0,63}$" });
const reviewerEntry = object({ agent: agentName, reason: Type.String({ maxLength: 1024 }), auto: Type.Optional(Type.Literal(true)) });
const DelegatedRole = Type.Union([Type.Literal("explore"), Type.Literal("worker"), Type.Literal("qa")]);
export const TaskSpec = object({
  key, role: DelegatedRole, goalUnitIds: unitIds(1), constraintUnitIds: unitIds(0),
  dependsOn: Type.Array(key, { maxItems: 32, uniqueItems: true }),
  writePaths: Type.Array(Type.String({ minLength: 1, maxLength: 1024 }), { maxItems: 64, uniqueItems: true }),
  blockedByQuestionIds: Type.Array(id, { maxItems: 16, uniqueItems: true }),
  maxTurns: Type.Integer({ minimum: 1, maximum: 1000 }),
  objective: text, passCriteria: texts(1), scope: object({ in: texts(1), out: texts(0) }), performance: VerificationPerformance,
  agent: Type.Optional(agentName), agentReason: Type.Optional(text),
  /** 通用审查之外的专项审查定义，每项须写理由。 */
  reviewers: Type.Optional(Type.Array(reviewerEntry, { maxItems: 16 })),
});
export type TaskSpec = Static<typeof TaskSpec>;
const MAX_PASS_CRITERIA = 8;
const MAX_PM_TURNS = 100;
/** 任务超出拆分上限的原因；有原因的任务登记后停在待用户裁决，由用户决定照做、让 PM 调整或终止。 */
function sizeHoldOf(spec: Pick<TaskSpec, "passCriteria" | "maxTurns">): string[] {
  return [...(spec.passCriteria.length > MAX_PASS_CRITERIA ? [`通过条件 ${spec.passCriteria.length} 条，超过 ${MAX_PASS_CRITERIA} 条`] : []),
    ...(spec.maxTurns > MAX_PM_TURNS ? [`申请 ${spec.maxTurns} 轮，超过 ${MAX_PM_TURNS} 轮`] : [])];
}
const Assessment = Type.Union([Type.Literal("unaffected"), Type.Literal("affected"), Type.Literal("unknown")]);
export const PLAN_MANAGE_PARAMETERS = Type.Union([
  object({ action: Type.Literal("propose"), tasks: Type.Array(TaskSpec, { minItems: 1, maxItems: 64 }) }),
  object({ action: Type.Literal("update"), planVersion: positive,
    add: Type.Optional(Type.Array(TaskSpec, { maxItems: 64 })),
    modify: Type.Optional(Type.Array(object({ taskId: id, version: positive, spec: TaskSpec }), { maxItems: 64 })),
    cancel: Type.Optional(Type.Array(object({ taskId: id, version: positive }), { maxItems: 64 })) }),
  object({ action: Type.Literal("confirm"), planVersion: positive }),
  object({ action: Type.Literal("read") }),
  object({ action: Type.Literal("assess-update"), revision: positive, assessmentId: id,
    tasks: Type.Array(object({ taskId: id, version: positive, assessment: Assessment, rationale: text }), { maxItems: 256 }),
    global: object({ assessment: Assessment, rationale: text }) }),
]);
export type PlanManageParameters = Static<typeof PLAN_MANAGE_PARAMETERS>;
export type PlanManageAction = PlanManageParameters["action"];

const UnitRef = object({ unitId, hash });
export type TaskStatus = "pending" | "running" | "completed" | "failed" | "needs_update" | "blocked" | "cancelled" | "awaiting_parent" | "awaiting_user"
  | "awaiting_review" | "reviewing" | "awaiting_rework";
const Attempt = object({ runId: id, maxTurns: positive, turnsUsed: Type.Integer({ minimum: 0 }), reason: Type.Union([text, Type.Null()]),
  outcome: Type.Union([Type.Literal("running"), Type.Literal("completed"), Type.Literal("incomplete"), Type.Literal("turn_limit_reached"),
    Type.Literal("failed"), Type.Literal("stopped"), Type.Literal("superseded")]),
  rework: Type.Optional(Type.Literal(true)),
  /** PM 放弃自行处置、交用户裁决时写的说明；是模型说法，只作展示。 */
  escalation: Type.Optional(text) });
export type TaskAttempt = Static<typeof Attempt>;
/** 任务级审查的一次运行；attemptRunId 是被审的 worker 尝试。 */
const Review = object({ runId: id, attemptRunId: id, maxTurns: positive, turnsUsed: Type.Integer({ minimum: 0 }),
  agent: agentName, round: positive,
  outcome: Type.Union([Type.Literal("running"), Type.Literal("clear"), Type.Literal("blocked"), Type.Literal("unverified"), Type.Literal("turn_limit_reached"),
    Type.Literal("failed"), Type.Literal("stopped"), Type.Literal("superseded"), Type.Literal("skipped")]),
  skipReason: Type.Optional(Type.Union([Type.Literal("disabled"), Type.Literal("missing")])) });
export type TaskReview = Static<typeof Review>;
/** 计入"首次加一次重试"的尝试次数：审查返修与用户终止后因计划变更被统一停止的尝试不计。 */
export function countedAttempts(task: { attempts: readonly TaskAttempt[] }): number {
  return task.attempts.filter((attempt) => attempt.outcome !== "superseded" && !attempt.rework).length;
}
/** 任务还没派出过：没有计入次数的尝试（作废的不算）。 */
export function unsentTask(task: { attempts: readonly TaskAttempt[] }): boolean {
  return countedAttempts(task) === 0;
}
export const REVIEW_REJECTED: ReadonlySet<TaskReview["outcome"]> = new Set(["blocked", "unverified"]);
export const REVIEW_OUTCOME_LABEL: Readonly<Record<TaskReview["outcome"], string>> = { clear: "通过", blocked: "打回", unverified: "未验证",
  failed: "没交出结论（运行失败）", turn_limit_reached: "没交出结论（轮次用满）", stopped: "没交出结论（被停止）", superseded: "被作废", skipped: "已跳过", running: "进行中" };
export const REVIEW_UNFINISHED: ReadonlySet<TaskReview["outcome"]> = new Set(["failed", "turn_limit_reached", "stopped"]);
/** 最近一轮的轮次，以及这一轮每个代理的最近一条记录。 */
export function latestRound(task: { reviews: readonly TaskReview[] }): { round: number; reviews: TaskReview[] } {
  const round = Math.max(0, ...task.reviews.map((review) => review.round));
  const byAgent = new Map<string, TaskReview>();
  for (const review of task.reviews) if (review.round === round) byAgent.set(review.agent, review);
  return { round, reviews: [...byAgent.values()] };
}
/** 有打回的轮数：返修机会按此单独计数，同一轮多个代理打回只算一轮。 */
export function reviewRejections(task: { reviews: readonly TaskReview[] }): number {
  return new Set(task.reviews.filter((review) => REVIEW_REJECTED.has(review.outcome)).map((review) => review.round)).size;
}
/** 某个审查代理在最近一轮里没交出结论的次数：与执行尝试同样允许一次再派，新一轮重新数。 */
export function reviewFailures(reviews: readonly TaskReview[], agent: string): number {
  const { round } = latestRound({ reviews });
  return reviews.filter((review) => review.round === round && review.agent === agent && REVIEW_UNFINISHED.has(review.outcome)).length;
}
/** 任务停在哪一环：最近完成的尝试已被审查时看最近一轮，有打回即返修、否则再审；否则是执行。 */
export function stalledStage(task: Pick<TaskRecord, "attempts" | "reviews">): "execute" | "review" | "rework" {
  const attempt = task.attempts.at(-1), { reviews } = latestRound(task);
  if (attempt?.outcome !== "completed" || reviews.length === 0 || reviews.some((review) => review.attemptRunId !== attempt.runId)) return "execute";
  return reviews.some((review) => REVIEW_REJECTED.has(review.outcome)) ? "rework" : "review";
}
/** 用户对待裁决任务的决定：只由可信登记写入，PM 不能构造；revision/taskVersion 为登记时的批准版本与任务版本。 */
const UserDecision = object({
  decisionId: id, choice: Type.Union([Type.Literal("retry"), Type.Literal("adjust"), Type.Literal("terminate")]),
  maxTurns: Type.Union([positive, Type.Null()]), revision: positive, taskVersion: positive,
  usedByRunId: Type.Union([id, Type.Null()]), notified: Type.Boolean(),
  /** 登记决定那一刻已确认计划的任务清单指纹，终止后据此判断新计划是否有变更。 */
  confirmedPlan: Type.Optional(Type.String({ pattern: "^[0-9a-f]{64}$" })),
});
export type UserDecision = Static<typeof UserDecision>;
const TaskRecord = object({
  format: Type.Literal("plan-task/v1"), taskId: id, requirementId: id, version: positive, key, role: DelegatedRole,
  goalUnitIds: unitIds(1), constraintUnitIds: unitIds(0), closure: Type.Array(UnitRef),
  dependsOn: Type.Array(id, { maxItems: 32 }), writePaths: Type.Array(Type.String(), { maxItems: 64 }),
  blockedByQuestionIds: Type.Array(id, { maxItems: 16 }), maxTurns: positive,
  agent: Type.Optional(agentName), agentReason: Type.Optional(text),
  reviewers: Type.Optional(Type.Array(object({ agent: agentName, reason: Type.String({ maxLength: 1024 }), auto: Type.Optional(Type.Literal(true)) }), { maxItems: 17 })),
  detail: object({ path: Type.String({ minLength: 1 }), hash }),
  status: Type.Union([Type.Literal("pending"), Type.Literal("running"), Type.Literal("completed"), Type.Literal("failed"),
    Type.Literal("needs_update"), Type.Literal("blocked"), Type.Literal("cancelled"), Type.Literal("awaiting_parent"), Type.Literal("awaiting_user"),
    Type.Literal("awaiting_review"), Type.Literal("reviewing"), Type.Literal("awaiting_rework")]),
  attempts: Type.Array(Attempt),
  reviews: Type.Array(Review),
  userDecision: Type.Optional(UserDecision),
  sizeHold: Type.Optional(Type.Array(text, { minItems: 1, maxItems: 2 })),
  holdNote: Type.Optional(text),
  lastAssessedRevision: positive, updatedAt: positive,
});
export type TaskRecord = Static<typeof TaskRecord>;
/** 修改后的任务除了说明文字（objective、passCriteria、agentReason、reviewers 的理由）之外是否与原任务一致。 */
async function textOnlyChange(task: TaskRecord, spec: TaskSpec, keys: ReadonlyMap<string, string>): Promise<boolean> {
  const previous = JSON.parse(await readFile(task.detail.path, "utf8")) as Pick<TaskSpec, "scope" | "performance">;
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  return spec.key === task.key && spec.role === task.role && same(spec.goalUnitIds, task.goalUnitIds) && same(spec.constraintUnitIds, task.constraintUnitIds) &&
    same(spec.dependsOn.map((dep) => keys.get(dep)), task.dependsOn) && same(spec.writePaths, task.writePaths) && same(spec.blockedByQuestionIds, task.blockedByQuestionIds) &&
    spec.maxTurns === task.maxTurns && spec.agent === task.agent &&
    same((spec.reviewers ?? []).filter((entry) => !entry.auto).map((entry) => entry.agent), (task.reviewers ?? []).filter((entry) => !entry.auto).map((entry) => entry.agent)) &&
    same(spec.scope, previous.scope) && same(spec.performance, previous.performance);
}
/** 修改任务时带上用户的决定：还没用掉的"再给一次机会"跟到新版本，PM 可以先补任务说明再派出；这时只允许改说明文字。 */
function carriedDecision(decision: UserDecision, version: number): UserDecision {
  return decision.choice === "retry" && decision.usedByRunId === null ? { ...decision, taskVersion: version } : decision;
}
const PlanRecord = object({
  format: Type.Literal("plan/v1"), requirementId: id, planVersion: positive, confirmedVersion: Type.Union([positive, Type.Null()]),
  confirmedTasks: Type.Array(object({ taskId: id, version: positive }), { maxItems: 256 }),
  taskIds: Type.Array(id, { maxItems: 256 }), knownUnits: Type.Array(UnitRef), prdRevision: positive, confirmedRevision: Type.Optional(positive), updatedAt: positive,
});
export type PlanRecord = Static<typeof PlanRecord>;

const PLAN_ADVICE = {
  tool_closed: COMMON_ADVICE.tool_closed,
  action_not_allowed: COMMON_ADVICE.action_not_allowed,
  session_inactive: COMMON_ADVICE.session_inactive,
  open_failed: COMMON_ADVICE.open_failed,
  grant_invalid: { why: "派工身份与 PM 租约不一致", next: "停止操作，不要重试；由主代理决定是否重新派出 PM" },
  lease_required: { why: "这个动作只有持有租约的 PM 能做", next: "改用职责内的动作" },
  invalid_shape: COMMON_ADVICE.invalid_shape,
  intake_gate: { why: "接手核对还没通过，不能正式提出或修改计划", next: "先读完批准正文并提交接手理解，等主代理核对通过" },
  pending_update: { why: "有新批准的需求版本还没复核", next: "先用 requirement_manage diff 读完新版本与上一版的差异（上下文压缩后可再查），再用 plan_manage assess-update 逐任务复核，再提出或修改计划" },
  plan_exists: { why: "本需求已有计划，不能再次提出", next: "用 read 读取现有计划，需要调整时用 update" },
  plan_missing: { why: "本需求还没有计划", next: "先用 propose 提出计划" },
  version_conflict: { why: "计划或需求在读取后已被改动", next: "用 read 读取最新计划，按最新版本号重新提交" },
  unknown_unit: { why: "任务引用了批准正文里不存在的章节", next: "只引用批准正文里的章节编号" },
  unit_not_authorized: { why: "任务目标不在用户批准的实施范围内", next: "这些章节若是用户已确认的约束或说明（如不做事项、边界条件），放进 constraintUnitIds；若确实是要实现的目标，交用户裁决是否授权实施；不要为此修改需求内容" },
  dependency_invalid: { why: "任务的依赖或写入范围不合规", next: "按原因改正任务后重新提交" },
  agent_invalid: { why: "计划里的角色定义用法不对", next: "按逐条原因改任务的 agent 或 reviewers 后重新提交" },
  coverage_incomplete: { why: "计划没有覆盖所有实施授权的目标章节", next: "为缺少的章节补任务后再确认" },
  task_not_ready: { why: "任务当前状态不允许这个操作", next: "用 read 查看任务状态，按原因处理后再试" },
  goal_held: { why: "目标被已有尝试的任务占住", next: "已有尝试的任务保留原有目标、不能取消；新增任务只放新增的段落，改好计划再交" },
  assessment_incomplete: { why: "复核没有覆盖所有受影响的任务", next: "为缺少的任务补上复核结论后重交" },
  assessment_invalid: { why: "复核结论不成立", next: "按原因改正复核结论后重交" },
} as const satisfies Record<string, FailureAdvice>;
export type PlanManageErrorCode = keyof typeof PLAN_ADVICE;
export class PlanManageError extends Error {
  readonly code: PlanManageErrorCode;
  readonly detail: string[];
  readonly advice: FailureAdvice;
  constructor(code: PlanManageErrorCode, detail: string[] = []) {
    super(detail.length ? `${code}: ${detail.join("；")}` : code); this.name = "PlanManageError"; this.code = code; this.detail = detail;
    this.advice = withDetail(PLAN_ADVICE[code], detail.join("；"));
  }
}

const Grant = object({
  role: Type.Union([Type.Literal("pm"), Type.Literal("reviewer")]), callerId: id, runId: id, requirementId: id, repoId: hash, workspaceId: hash,
  lease: Type.Optional(PmLease),
});
export type PlanManageGrant = Static<typeof Grant>;
export type AgentDirectoryEntry = { name: string; role: string; disabled: boolean };
export interface PlanManageToolOptions {
  repositoryRoot: string;
  dataRoot: string;
  grant: PlanManageGrant;
  /** 必须由宿主核验当前物理角色会话/调用者及动作许可；不能从工具参数或角色文本构造 true。 */
  authorize: (request: Readonly<{ grant: PlanManageGrant; action: PlanManageAction }>) => boolean;
  /** 目录里可用的角色定义；缺省按空目录处理。 */
  agentDirectory?: () => Promise<AgentDirectoryEntry[]>;
}

function sha256(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
function deny(code: PlanManageErrorCode, detail: string[] = []): never { throw new PlanManageError(code, detail); }

/** 用户批准并授权实施时，实施目标板块下全部已确认的段落都是实施目标，不看解读模型在实施动作里列了哪些段。 */
export function implementScope(manifest: ApprovalManifest, sections: readonly RequirementDocSection[]): Set<string> {
  if (!manifest.actions.some((action) => action.action === "implement" && !action.unknown)) return new Set();
  const goals = sections.filter((section) => section.goal).map((section) => section.id);
  return new Set(manifest.units.filter((unit) => unit.disposition === "confirmed" &&
    goals.some((goal) => unit.id === goal || unit.id.startsWith(`${goal}.`))).map((unit) => unit.id));
}
function closureOf(manifest: ApprovalManifest, goalIds: string[], constraintIds: string[]): Array<{ unitId: string; hash: string }> {
  // 当前正文已删掉的段不再参与：算出的依据与原来不同，引用它的任务随之被判为受影响
  const present = new Set(manifest.units.map((unit) => unit.id));
  const ids = approvalDependencyClosure(manifest.units, [...goalIds, ...constraintIds].filter((unit) => present.has(unit)));
  return manifest.units.filter((unit) => ids.includes(unit.id)).map((unit) => ({ unitId: unit.id, hash: unit.hash }));
}
function sameRefs(a: ReadonlyArray<{ unitId: string; hash: string }>, b: ReadonlyArray<{ unitId: string; hash: string }>): boolean {
  const norm = (refs: ReadonlyArray<{ unitId: string; hash: string }>) => JSON.stringify([...refs].sort((x, y) => x.unitId.localeCompare(y.unitId)));
  return norm(a) === norm(b);
}

export function taskDetailPath(dataRoot: string, repoId: string, requirementId: string, taskId: string, version: number): string {
  return join(dirname(repositoryDatabase(dataRoot, repoId)), "plans", requirementId, `${taskId}.v${version}.json`);
}

/** 按依据读取任务说明；文件内容指纹与登记不符即拒绝，不回退旧内容。 */
export async function readTaskDetail(task: TaskRecord): Promise<Pick<TaskSpec, "objective" | "passCriteria" | "scope" | "performance">> {
  const content = await readFile(task.detail.path, "utf8");
  if (sha256(content) !== task.detail.hash) throw new PlanManageError("task_not_ready", ["任务说明与登记指纹不符"]);
  return JSON.parse(content) as Pick<TaskSpec, "objective" | "passCriteria" | "scope" | "performance">;
}

/** 用户终止了某任务且此后尚无新的批准版本：该需求整体暂停，等待用户调整需求或取消需求。 */
export function terminationPending(tasks: readonly TaskRecord[], revision: number): boolean {
  return tasks.some((task) => task.userDecision?.choice === "terminate" && task.userDecision.revision >= revision);
}

/** 用户终止任务后、或计划确认后又批准了新版本，须确认基于当前批准版本的计划才能派出或恢复子代理。 */
export function replanPending(plan: Pick<PlanRecord, "confirmedVersion" | "confirmedRevision">, tasks: readonly TaskRecord[], revision: number): boolean {
  const last = Math.max(0, ...tasks.filter((task) => task.userDecision?.choice === "terminate").map((task) => task.userDecision!.revision));
  return last > 0 && (plan.confirmedRevision ?? 0) <= last || plan.confirmedVersion !== null && (plan.confirmedRevision ?? 0) < revision;
}

/** 批准新版本时暂停的子代理属于哪个任务、是该任务的哪种运行，以及当时的任务版本。 */
export type HoldRef = { taskId: string; version: number; kind: "attempt" | "review" };
/** 计划确认后该子代理是否恢复：所属任务版本没变、在已确认计划里，且这次运行仍是任务当前在做的那次；不属于任务的运行直接恢复。 */
export function holdResumes(ref: HoldRef | null, current: { plan: PlanRecord; tasks: readonly TaskRecord[] } | null, runId: string): boolean {
  if (!ref) return true;
  const task = current?.tasks.find((candidate) => candidate.taskId === ref.taskId);
  if (!task || task.version !== ref.version || !current!.plan.confirmedTasks.some((entry) => entry.taskId === ref.taskId && entry.version === ref.version)) return false;
  return task.status === (ref.kind === "review" ? "reviewing" : "running");
}

function otherShapeErrors(input: unknown): string[] {
  const action = (input as { action?: unknown } | null)?.action;
  const branch = PLAN_MANAGE_PARAMETERS.anyOf.find((candidate) => candidate.properties.action.const === action) ?? PLAN_MANAGE_PARAMETERS;
  return [...Value.Errors(branch, input)]
    .filter((issue) => !issue.instancePath.endsWith("/ui") && !(issue.keyword === "additionalProperties" && JSON.stringify(issue.params.additionalProperties) === '["ui"]'))
    .map((issue) => `${issue.instancePath} ${issue.message}`);
}

function hasUiMark(input: unknown): boolean {
  const { tasks, add, modify } = (input ?? {}) as { tasks?: unknown; add?: unknown; modify?: unknown };
  const specs = [tasks, add, Array.isArray(modify) ? modify.map((item) => item?.spec) : undefined].flatMap((list) => (Array.isArray(list) ? list : []));
  return specs.some((spec) => spec && typeof spec === "object" && "ui" in spec);
}

export function confirmedPlanKey(plan: Pick<PlanRecord, "confirmedTasks"> | undefined): string {
  return sha256(JSON.stringify(plan?.confirmedTasks ?? []));
}

export function readPlanIn(db: LocalDatabase, requirementId: string): { plan: PlanRecord; tasks: TaskRecord[] } | null {
  const row = db.read<unknown>(PLANS, requirementId);
  if (!row) return null;
  const plan = checked(PlanRecord, row.data);
  return { plan, tasks: plan.taskIds.map((taskId) => checked(TaskRecord, db.read<unknown>(TASKS, taskId)!.data)) };
}

export async function createPlanManageTool(options: PlanManageToolOptions) {
  try { return await openPlanManageTool(options); }
  catch (error) { throw error instanceof PlanManageError ? error : new PlanManageError("open_failed", [(error as Error).message]); }
}

async function openPlanManageTool(options: PlanManageToolOptions) {
  const grant = Object.freeze(checked(Grant, structuredClone(options.grant)));
  if ((grant.role === "pm") !== (grant.lease !== undefined)) deny("grant_invalid");
  if (grant.lease && (grant.lease.requirementId !== grant.requirementId || grant.lease.runId !== grant.runId || grant.lease.workspaceId !== grant.workspaceId)) deny("grant_invalid");
  let disposed = false;
  function host(action: PlanManageAction) {
    if (disposed) deny("tool_closed");
    if (!authorizeToolAction(grant.role, "plan_manage", action)) deny("action_not_allowed", [`${grant.role} 不能做 ${action}`]);
    let result: unknown;
    try { result = options.authorize(Object.freeze({ grant, action })); } catch (error) { return deny("session_inactive", [(error as Error).message]); }
    if (isPromise(result)) void Promise.prototype.then.call(result, () => undefined, () => undefined);
    if (result !== true) deny("session_inactive");
  }
  host("read");
  const config = { repositoryRoot: options.repositoryRoot, dataRoot: options.dataRoot, repoId: grant.repoId };
  const state = await RequirementStateStore.open({ ...config, authorize: (request) => !disposed && request.repoId === grant.repoId &&
    ["open", "read", "check-pm", "check-scheduling", "assess-update"].includes(request.action) });
  const database = repositoryDatabase(options.dataRoot, grant.repoId);
  const now = () => Date.now();
  const agentDirectory = options.agentDirectory ?? (async () => []);

  function manifestFor(db: LocalDatabase, record: StoredRecord<RequirementRecord>): ApprovalManifest {
    return registeredApprovalManifestIn(db, grant.repoId, record.data.approvalManifest!.reference, record);
  }
  function lease() { if (!grant.lease) deny("lease_required"); return structuredClone(grant.lease); }

  async function formalGate(): Promise<void> {
    const current = lease();
    const verdict = evaluatePmIntakeGate({ dataRoot: options.dataRoot, repoId: grant.repoId, lease: current });
    if (!verdict.allowed) deny("intake_gate", verdict.reasons.map(intakeReasonText));
    try { await state.checkScheduling(current); }
    catch (error) { if ((error as { code?: string }).code === "pending_update") deny("pending_update"); throw error; }
  }

  /** 事务外写入不可变的任务说明文件，登记时只存路径与指纹。 */
  async function writeDetail(taskId: string, version: number, spec: TaskSpec) {
    const path = taskDetailPath(options.dataRoot, grant.repoId, grant.requirementId, taskId, version);
    const content = JSON.stringify({ objective: spec.objective, passCriteria: spec.passCriteria, scope: spec.scope, performance: spec.performance });
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFileAtomic(path, content);
    return { path, hash: sha256(content) };
  }

  function validateSpecs(manifest: ApprovalManifest, scope: Set<string>, specs: TaskSpec[], known: Map<string, string>): void {
    const units = new Set(manifest.units.map((unit) => unit.id));
    const unknownUnits = specs.flatMap((spec) => [...spec.goalUnitIds, ...spec.constraintUnitIds]).filter((unit) => !units.has(unit));
    if (unknownUnits.length) deny("unknown_unit", [...new Set(unknownUnits)]);
    const outside = specs.flatMap((spec) => spec.goalUnitIds).filter((unit) => !scope.has(unit));
    if (outside.length) deny("unit_not_authorized", [...new Set(outside)]);
    const noScope = specs.filter((spec) => spec.role === "worker" && spec.writePaths.length === 0);
    if (noScope.length) deny("dependency_invalid", noScope.map((spec) => `${spec.key} 是实现任务，须声明可写范围`));
    const unwritable = specs.filter((spec) => spec.role === "worker")
      .flatMap((spec) => spec.writePaths.filter((path) => !writePathAllowed(path)).map((path) => `${spec.key} 的 ${path} 不能由 worker 写入`));
    if (unwritable.length) deny("dependency_invalid", unwritable);
    const keys = specs.map((spec) => spec.key);
    if (new Set(keys).size !== keys.length || keys.some((value) => known.has(value) && !specs.some((spec) => spec.key === value))) deny("dependency_invalid", ["任务 key 重复"]);
    for (const spec of specs) for (const dep of spec.dependsOn) if (!keys.includes(dep) && !known.has(dep)) deny("dependency_invalid", [`${spec.key} 依赖未知任务 ${dep}`]);
  }

  /** auto 标记只由程序按目录写入，PM 交上来的一律丢弃。 */
  function dropAuto(spec: TaskSpec): TaskSpec {
    return spec.reviewers ? { ...spec, reviewers: spec.reviewers.filter((entry) => !entry.auto) } : spec;
  }

  function validateAgents(specs: TaskSpec[], directory: readonly AgentDirectoryEntry[]): void {
    const byName = new Map(directory.map((entry) => [entry.name, entry]));
    const problems: string[] = [];
    for (const spec of specs) {
      if (spec.agent && byName.get(spec.agent)?.disabled) problems.push(`${spec.key} 的执行定义 ${spec.agent} 已关闭`);
      if (!spec.reviewers?.length) continue;
      if (spec.role !== "worker") { problems.push(`${spec.key} 是 ${spec.role} 任务，只有 worker 任务可写 reviewers`); continue; }
      const seen = new Set<string>();
      for (const { agent, reason } of spec.reviewers) {
        const entry = byName.get(agent);
        if (!reason.trim()) problems.push(`${spec.key} 的 ${agent} 没写理由，须写明为什么需要这个专项审查`);
        if (seen.has(agent)) problems.push(`${spec.key} 的 ${agent} 重复`);
        seen.add(agent);
        if (agent === "reviewer") problems.push(`${spec.key} 写了 reviewer：通用审查不用写`);
        else if (!entry) problems.push(`${spec.key} 的 ${agent} 在目录里不存在`);
        else if (entry.role !== "reviewer") problems.push(`${spec.key} 的 ${agent} 职责不是 reviewer`);
        else if (entry.disabled) problems.push(`${spec.key} 的 ${agent} 已关闭`);
      }
    }
    if (problems.length) deny("agent_invalid", problems);
  }

  function withAutoReviewers(specs: TaskSpec[], directory: readonly AgentDirectoryEntry[]): TaskSpec[] {
    const roles = new Map(directory.map((entry) => [entry.name, entry.role]));
    return specs.map((spec) => {
      const prefix = spec.role === "worker" ? spec.agent?.match(/^(.+)-worker$/)?.[1] : undefined;
      const auto = prefix && roles.get(`${prefix}-reviewer`) === "reviewer" && !spec.reviewers?.some((entry) => entry.agent === `${prefix}-reviewer`)
        ? [{ agent: `${prefix}-reviewer`, reason: "同栈自动挂上", auto: true as const }] : [];
      return auto.length ? { ...spec, reviewers: [...(spec.reviewers ?? []), ...auto] } as TaskSpec : spec;
    });
  }

  function assertAcyclic(tasks: Array<{ taskId: string; dependsOn: string[] }>): void {
    const byId = new Map(tasks.map((task) => [task.taskId, task]));
    const done = new Set<string>(), visiting = new Set<string>();
    const visit = (taskId: string) => {
      if (visiting.has(taskId)) deny("dependency_invalid", ["任务依赖成环"]);
      if (done.has(taskId)) return;
      visiting.add(taskId); byId.get(taskId)?.dependsOn.forEach(visit); visiting.delete(taskId); done.add(taskId);
    };
    tasks.forEach((task) => visit(task.taskId));
  }

  function snapshot() {
    return withDatabase(database, (db) => db.transaction(() => {
      const record = state.read(grant.requirementId);
      return { record, manifest: manifestFor(db, record), current: readPlanIn(db, grant.requirementId) };
    }));
  }

  async function materialize(manifest: ApprovalManifest, specs: TaskSpec[], existingKeys: Map<string, string>, revision: number,
    previous?: Map<string, TaskRecord>) {
    const ids = new Map(existingKeys);
    for (const spec of specs) if (!ids.has(spec.key)) ids.set(spec.key, uuidv7());
    const records: TaskRecord[] = [];
    for (const spec of specs) {
      const taskId = ids.get(spec.key)!;
      const version = (previous?.get(taskId)?.version ?? 0) + 1;
      const hold = sizeHoldOf(spec);
      const prior = previous?.get(taskId), decision = prior?.userDecision && carriedDecision(prior.userDecision, version);
      // 两次机会已用完又没有能用的用户决定时，待派出也派不出去，只能交回用户裁决
      const exhausted = prior !== undefined && countedAttempts(prior) >= 2 && !(decision && decision.usedByRunId === null &&
        ((decision.choice === "retry" && decision.taskVersion === version) || (decision.choice === "adjust" && version > decision.taskVersion)));
      records.push(checked(TaskRecord, { format: "plan-task/v1", taskId, requirementId: grant.requirementId, version, key: spec.key, role: spec.role,
        goalUnitIds: spec.goalUnitIds, constraintUnitIds: spec.constraintUnitIds, closure: closureOf(manifest, spec.goalUnitIds, spec.constraintUnitIds),
        dependsOn: spec.dependsOn.map((dep) => ids.get(dep)!), writePaths: spec.writePaths, blockedByQuestionIds: spec.blockedByQuestionIds,
        maxTurns: spec.maxTurns, ...(spec.agent ? { agent: spec.agent } : {}), ...(spec.agentReason ? { agentReason: spec.agentReason } : {}),
        ...(spec.reviewers?.length ? { reviewers: spec.reviewers } : {}),
        detail: await writeDetail(taskId, version, spec), status: hold.length || exhausted ? "awaiting_user" : "pending", ...(hold.length ? { sizeHold: hold } : {}), attempts: previous?.get(taskId)?.attempts ?? [], reviews: previous?.get(taskId)?.reviews ?? [],
        ...(previous?.get(taskId)?.userDecision ? { userDecision: carriedDecision(previous.get(taskId)!.userDecision!, version) } : {}),
        lastAssessedRevision: revision, updatedAt: now() }));
    }
    return records;
  }

  /** 写入前逐任务比对快照时的内容：快照后被派工或结局登记改动过的任务不被覆盖。 */
  function commit(expected: { planVersion: number | null; recordVersion: number; tasks: ReadonlyMap<string, TaskRecord> }, plan: PlanRecord, tasks: TaskRecord[],
    merge?: (fresh: TaskRecord) => TaskRecord) {
    return withDatabase(database, (db) => db.transaction(() => {
      const record = state.read(grant.requirementId);
      if (record.version !== expected.recordVersion) deny("version_conflict", ["需求状态已变化"]);
      const row = db.read<unknown>(PLANS, grant.requirementId);
      const stored = row ? checked(PlanRecord, row.data) : null;
      if ((stored?.planVersion ?? null) !== expected.planVersion) deny("version_conflict", ["计划版本已变化"]);
      for (const task of tasks) {
        const existing = db.read<unknown>(TASKS, task.taskId);
        if (merge) {
          if (!existing) deny("version_conflict", [`任务 ${task.key} 不存在`]);
          db.update(TASKS, task.taskId, existing.version, merge(checked(TaskRecord, existing.data)));
          continue;
        }
        const seen = expected.tasks.get(task.taskId);
        if ((existing === null) !== (seen === undefined) || (existing && JSON.stringify(existing.data) !== JSON.stringify(seen))) deny("version_conflict", [`任务 ${task.key} 已被并发改动`]);
        if (existing) db.update(TASKS, task.taskId, existing.version, task); else db.create(TASKS, task.taskId, task);
      }
      if (row) db.update(PLANS, grant.requirementId, row.version, plan); else db.create(PLANS, grant.requirementId, plan);
      return { plan, tasks: plan.taskIds.map((taskId) => checked(TaskRecord, db.read<unknown>(TASKS, taskId)!.data)) };
    }));
  }

  async function propose(submitted: TaskSpec[]) {
    const specs = submitted.map(dropAuto);
    await formalGate();
    const { record, manifest, current } = snapshot();
    if (current) deny("plan_exists");
    validateSpecs(manifest, implementScope(manifest, record.data.docSpec?.sections ?? []), specs, new Map());
    const directory = await agentDirectory();
    validateAgents(specs, directory);
    const tasks = await materialize(manifest, withAutoReviewers(specs, directory), new Map(), record.data.revision);
    assertAcyclic(tasks);
    const plan = checked(PlanRecord, { format: "plan/v1", requirementId: grant.requirementId, planVersion: 1, confirmedVersion: null, confirmedTasks: [],
      taskIds: tasks.map((task) => task.taskId), knownUnits: manifest.units.map((unit) => ({ unitId: unit.id, hash: unit.hash })),
      prdRevision: record.data.revision, updatedAt: now() });
    return commit({ planVersion: null, recordVersion: record.version, tasks: new Map() }, plan, tasks);
  }

  async function update(params: Extract<PlanManageParameters, { action: "update" }>) {
    await formalGate();
    const { record, manifest, current } = snapshot();
    if (!current) deny("plan_missing");
    if (current.plan.planVersion !== params.planVersion) deny("version_conflict", ["计划版本已变化"]);
    const byId = new Map(current.tasks.map((task) => [task.taskId, task]));
    const keys = new Map(current.tasks.map((task) => [task.key, task.taskId]));
    for (const item of [...(params.modify ?? []), ...(params.cancel ?? [])]) {
      const task = byId.get(item.taskId);
      if (!task || task.version !== item.version) deny("version_conflict", [`任务 ${item.taskId} 版本已变化`]);
      if (task.status === "awaiting_user") deny("task_not_ready", [`${task.key} 等待用户裁决，不能修改或取消`]);
      if (task.userDecision?.choice === "terminate") deny("task_not_ready", [`${task.key} 已被用户终止，不能修改或取消`]);
    }
    // 用户选择调整目标或范围后，须等新的批准版本才能按新范围修改该任务本身；只放开该任务修改时保留原目标的要求，且决定用过即失效
    const readjusted = (task: TaskRecord) => task.userDecision?.choice === "adjust" && task.userDecision.usedByRunId === null &&
      record.data.revision > task.userDecision.revision;
    // 因超出拆分上限或 PM 在派出前上报而被用户要求调整的任务还没派出过，PM 直接拆分或精简，不等新的批准版本
    const resized = (task: TaskRecord) => (task.sizeHold !== undefined || task.holdNote !== undefined) && unsentTask(task);
    const waiting = (params.modify ?? []).filter((item) => { const task = byId.get(item.taskId)!; return task.userDecision?.choice === "adjust" && !readjusted(task) && !resized(task); });
    if (waiting.length) deny("task_not_ready", waiting.map((item) => `${byId.get(item.taskId)!.key} 等待调整后的新批准版本`));
    // 用户给的再一次机会还没用时只能改说明文字，机会随之带到新版本；改了别的，用户的决定就对不上原来的任务了
    const beyondText: string[] = [];
    for (const item of params.modify ?? []) {
      const task = byId.get(item.taskId)!;
      if (task.userDecision?.choice === "retry" && task.userDecision.usedByRunId === null && !await textOnlyChange(task, item.spec, keys)) beyondText.push(task.key);
    }
    if (beyondText.length) deny("task_not_ready", beyondText.map((key) => `${key} 有用户给的再一次机会还没用，这时只能改任务说明文字（objective、passCriteria、agentReason、reviewers 的理由）；要改其他内容，先把这一次派出去`));
    // 一次重试按目标计：有过尝试且未完成的任务不能取消，其目标也不能被同角色的其他新增或修改任务揽走；用户终止的任务在新的批准版本前同样占住其目标。
    // 只占同角色：QA 的目标本就覆盖验收单元，若跨角色占用，QA 一报问题就再也追加不了 worker 返修任务。
    // 复核中判为受影响的任务按当前批准版本重排，不再占住目标
    const tried = current.tasks.filter((task) => countedAttempts(task) > 0 && task.status !== "completed" && task.status !== "needs_update" &&
      (task.status !== "cancelled" || terminationPending([task], record.data.revision)));
    // 当前批准不再列为实施目标的段谁也拿不走：从已开工任务里去掉它、目标全都不在授权内时取消任务，都绕不开一次重试
    const authorized = implementScope(manifest, record.data.docSpec?.sections ?? []);
    const cancelTried = (params.cancel ?? []).filter((item) => tried.some((task) => task.taskId === item.taskId && task.goalUnitIds.some((unit) => authorized.has(unit))));
    if (cancelTried.length) deny("goal_held", cancelTried.map((item) => `${byId.get(item.taskId)!.key} 已有尝试，不能取消`));
    const shrunk = (params.modify ?? []).filter((item) => tried.some((task) => task.taskId === item.taskId && !readjusted(task)
      && task.goalUnitIds.some((unit) => authorized.has(unit) && !item.spec.goalUnitIds.includes(unit))));
    if (shrunk.length) deny("goal_held", shrunk.map((item) => `${item.spec.key} 已有尝试，修改须保留原有目标`));
    const heldBy = (unit: string, role: string, except?: string) => tried.some((task) => task.taskId !== except && task.role === role && task.goalUnitIds.includes(unit));
    const bypass = [...(params.add ?? []).map((spec) => ({ spec, taskId: undefined as string | undefined })),
      ...(params.modify ?? []).map((item) => ({ spec: item.spec, taskId: item.taskId }))]
      .filter(({ spec, taskId }) => spec.goalUnitIds.some((unit) => heldBy(unit, spec.role, taskId)));
    if (bypass.length) deny("goal_held", bypass.map(({ spec }) => `${spec.key} 覆盖已有尝试任务的目标`));
    const modifySpecs = (params.modify ?? []).map((item) => {
      if (item.spec.key !== byId.get(item.taskId)!.key) deny("dependency_invalid", ["修改不能改变任务 key"]);
      return item.spec;
    });
    const specs = [...(params.add ?? []), ...modifySpecs].map(dropAuto);
    validateSpecs(manifest, authorized, specs, keys);
    const directory = await agentDirectory();
    validateAgents(specs, directory);
    const changed = await materialize(manifest, withAutoReviewers(specs, directory), keys, record.data.revision, byId);
    const cancelled = (params.cancel ?? []).map((item) => ({ ...byId.get(item.taskId)!, status: "cancelled" as const, updatedAt: now() }));
    const merged = new Map(current.tasks.map((task) => [task.taskId, task]));
    for (const task of [...changed, ...cancelled]) merged.set(task.taskId, task);
    const live = [...merged.values()].filter((task) => task.status !== "cancelled");
    for (const task of live) for (const dep of task.dependsOn) if (merged.get(dep)?.status === "cancelled") deny("dependency_invalid", [`${task.key} 依赖已取消的任务`]);
    assertAcyclic(live);
    const plan = checked(PlanRecord, { ...current.plan, planVersion: current.plan.planVersion + 1, taskIds: [...merged.keys()], updatedAt: now() });
    return commit({ planVersion: current.plan.planVersion, recordVersion: record.version, tasks: byId }, plan, [...changed, ...cancelled]);
  }

  async function confirm(planVersion: number) {
    await formalGate();
    const { record, manifest, current } = snapshot();
    if (!current) deny("plan_missing");
    if (current.plan.planVersion !== planVersion) deny("version_conflict", ["计划版本已变化"]);
    const live = current.tasks.filter((task) => task.status !== "cancelled");
    const notReady = live.filter((task) => task.status === "needs_update" || task.status === "blocked");
    if (notReady.length) deny("task_not_ready", notReady.map((task) => `${task.key}:${task.status}`));
    const stale = live.filter((task) => !sameRefs(task.closure, closureOf(manifest, task.goalUnitIds, task.constraintUnitIds)));
    if (stale.length) deny("task_not_ready", stale.map((task) => `${task.key}:依据已变化`));
    const covered = new Set(live.flatMap((task) => task.goalUnitIds));
    const missing = [...implementScope(manifest, record.data.docSpec?.sections ?? [])].filter((unit) => !covered.has(unit));
    if (missing.length) deny("coverage_incomplete", missing);
    const plan = checked(PlanRecord, { ...current.plan, confirmedVersion: planVersion, confirmedRevision: record.data.revision,
      confirmedTasks: live.map((task) => ({ taskId: task.taskId, version: task.version })), updatedAt: now() });
    return commit({ planVersion, recordVersion: record.version, tasks: new Map() }, plan, []);
  }

  /** 逐任务影响复核：依据闭包变化的任务只能判为受影响，结论不全或理由缺失拒绝；unknown 保持阻塞与待处理更新。 */
  async function assessUpdate(params: Extract<PlanManageParameters, { action: "assess-update" }>) {
    const current = lease();
    const { record, manifest, current: plan } = snapshot();
    if (!plan) deny("plan_missing");
    if (record.data.pendingRevision !== params.revision || record.data.revision !== params.revision) deny("assessment_invalid", ["没有待复核的该批准版本"]);
    const pmContext = withDatabase(database, (db) => db.read<{ context?: { diffRevision?: number; baseline: { runId: string; fence: number; contextGeneration: number; revision: number } | null } }>(
      "pm_ownership", grant.requirementId)?.data.context);
    const context = pmContext?.baseline;
    if (context?.revision !== params.revision || context.runId !== current.runId || context.fence !== current.fence || context.contextGeneration !== current.contextGeneration) {
      deny("assessment_invalid", [`本 PM 会话尚未收到 revision ${params.revision} 的更新通知`]);
    }
    if ((pmContext!.diffRevision ?? 0) < params.revision) {
      deny("assessment_invalid", [`本 PM 会话还没有完整读过到 revision ${params.revision} 的差异：先用 one_company_requirement_manage diff（fromRevision 取更新通知里的起点，toRevision ${params.revision}）读完全部分页，再复核`]);
    }
    const live = plan.tasks.filter((task) => task.status !== "cancelled");
    const given = new Map(params.tasks.map((item) => [item.taskId, item]));
    const missing = live.filter((task) => given.get(task.taskId)?.version !== task.version);
    if (missing.length || given.size !== params.tasks.length || params.tasks.some((item) => !live.some((task) => task.taskId === item.taskId))) {
      deny("assessment_incomplete", missing.map((task) => task.key));
    }
    const forced = live.filter((task) => !sameRefs(task.closure, closureOf(manifest, task.goalUnitIds, task.constraintUnitIds)))
      .filter((task) => given.get(task.taskId)!.assessment === "unaffected");
    if (forced.length) deny("assessment_invalid", forced.map((task) => `${task.key} 依据的章节已变化，不能判为无关`));
    const scope = implementScope(manifest, record.data.docSpec?.sections ?? []);
    const revoked = live.filter((task) => task.goalUnitIds.some((unit) => !scope.has(unit)) && given.get(task.taskId)!.assessment === "unaffected");
    if (revoked.length) deny("assessment_invalid", revoked.map((task) => `${task.key} 的目标已不在实施授权内，不能判为无关`));
    // 复核结论套用在提交时的最新任务行上：复核期间子代理结局登记的状态与尝试记录不被覆盖
    const apply = (fresh: TaskRecord): TaskRecord => {
      const assessment = given.get(fresh.taskId)!.assessment;
      const status: TaskStatus = assessment === "unknown" ? "blocked" : assessment === "affected" ? "needs_update" : fresh.status;
      return checked(TaskRecord, { ...fresh, status, lastAssessedRevision: params.revision, updatedAt: now() });
    };
    await state.assessUpdate({ lease: current, version: record.version, revision: params.revision, assessmentId: params.assessmentId,
      tasks: [...params.tasks.map((item) => ({ taskId: item.taskId, impact: item.assessment, reason: item.rationale })),
        { taskId: "global", impact: params.global.assessment, reason: params.global.rationale }] });
    const after = state.read(grant.requirementId);
    const next = checked(PlanRecord, { ...plan.plan, planVersion: plan.plan.planVersion + 1,
      knownUnits: manifest.units.map((unit) => ({ unitId: unit.id, hash: unit.hash })), prdRevision: params.revision, updatedAt: now() });
    return commit({ planVersion: plan.plan.planVersion, recordVersion: after.version, tasks: new Map() }, next, live, apply);
  }

  async function read() {
    const current = withDatabase(database, (db) => readPlanIn(db, grant.requirementId));
    if (!current) return { plan: null };
    const tasks = await Promise.all(current.tasks.map(async (task) => ({ ...task, detail: { hash: task.detail.hash, ...(await readTaskDetail(task)) } })));
    return { plan: current.plan, tasks };
  }

  async function execute(input: unknown) {
    let params: PlanManageParameters;
    try { params = checkServiceInput(PLAN_MANAGE_PARAMETERS, input); } catch (error) {
      if (!hasUiMark(input)) throw new PlanManageError("invalid_shape", [(error as Error).message]);
      throw new PlanManageError("invalid_shape", ["任务里的 ui 字段无效：界面标记已不存在，原型在主窗口澄清阶段做", ...otherShapeErrors(input)]);
    }
    host(params.action);
    if (params.action === "read") return read();
    if (params.action === "assess-update") return assessUpdate(params);
    const action = params.action;
    try {
      const result = action === "propose" ? await propose(params.tasks) : action === "update" ? await update(params) : await confirm(params.planVersion);
      if (grant.lease) clearPlanRejections(config, grant.requirementId);
      return result;
    } catch (error) {
      if (grant.lease && error instanceof PlanManageError && PLAN_CONTENT_CODES.has(error.code)) {
        notePlanRejection(config, grant.requirementId, grant.runId, { action, reason: PLAN_ADVICE[error.code].why, detail: error.detail.join("；"), at: now() });
      }
      throw error;
    }
  }
  return { execute, dispose() { disposed = true; } };
}
