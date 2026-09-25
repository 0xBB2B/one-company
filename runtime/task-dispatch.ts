import { posix } from "node:path";
import { registeredApprovalManifestIn } from "./approval-manifest-store.ts";
import { activeCheckRoundIn } from "./check-round.ts";
import { repositoryDatabase, withDatabase } from "./database.ts";
import type { LocalDatabase, StoredRecord } from "./database.ts";
import { countedAttempts, implementScope, PlanManageError, readPlanIn, replanPending, reviewFailures, reviewRejections, TASKS, terminationPending } from "./plan-manage.ts";
import type { TaskAttempt, TaskRecord, TaskReview } from "./plan-manage.ts";
import { evaluatePmIntakeGate } from "./pm-intake-runtime.ts";
import type { PmLease, RequirementRecord } from "./requirement-contracts.ts";

export type TaskDispatchErrorCode = "intake_gate" | "pending_update" | "plan_not_confirmed" | "task_not_ready" | "dependency_pending"
  | "question_pending" | "check_phase_active" | "retry_required" | "retry_exhausted" | "retry_not_needed" | "requirement_halted"
  | "write_scope_busy" | "rework_required" | "rework_exhausted" | "rework_not_needed";
export class TaskDispatchError extends Error {
  readonly code: TaskDispatchErrorCode;
  readonly detail: string[];
  constructor(code: TaskDispatchErrorCode, detail: string[] = []) {
    super(detail.length ? `${code}: ${detail.join("；")}` : code); this.name = "TaskDispatchError"; this.code = code; this.detail = detail;
  }
}
function deny(code: TaskDispatchErrorCode, detail: string[] = []): never { throw new TaskDispatchError(code, detail); }

export interface TaskDispatchRequest {
  dataRoot: string;
  repoId: string;
  lease: PmLease;
  taskId: string;
  /** 首次派工为 null；一次重试须由父代理给出原因与新的轮次上限。 */
  retry: { reason: string; maxTurns: number } | null;
  /** 审查打回后的返修：须由父代理给出原因与新的轮次上限，不占执行重试。 */
  rework?: { reason: string; maxTurns: number } | null;
}

function questionResolved(db: LocalDatabase, repoId: string, record: StoredRecord<RequirementRecord>, questionId: string): boolean {
  if (!record.data.approvalManifest) return false;
  const manifest = registeredApprovalManifestIn(db, repoId, record.data.approvalManifest.reference, record);
  const entry = manifest.questions.find((question) => question.requestId === questionId);
  return entry !== undefined && entry.pendingIds.length === 0;
}

type SchedulingGate = { task: TaskRecord; tasks: TaskRecord[] };

/**
 * 派子代理前共用的程序门槛：接手核对通过且有实施授权、无待处理更新、任务在已冻结版本中、依赖已完成、未决问题已解决、
 * 目标仍在实施授权内、没有运行中的同任务子代理。
 */
function schedulingGateIn(db: LocalDatabase, request: { repoId: string; lease: PmLease; taskId: string }): SchedulingGate {
  const requirementId = request.lease.requirementId;
  const recordRow = db.read<RequirementRecord>("requirements", requirementId);
  if (!recordRow || recordRow.data.pendingRevision !== null) deny("pending_update");
  const current = readPlanIn(db, requirementId);
  if (!current || current.plan.confirmedVersion === null) deny("plan_not_confirmed");
  // 用户终止任务后整个需求暂停：新的批准版本前不派任何子代理，批准后须先确认基于新版本的计划
  if (terminationPending(current.tasks, recordRow.data.revision)) deny("requirement_halted", ["任务已被用户终止，须先调整需求或取消需求"]);
  if (replanPending(current.plan, current.tasks)) deny("plan_not_confirmed", ["须确认基于调整后批准版本的计划"]);
  const task = current.tasks.find((candidate) => candidate.taskId === request.taskId);
  const confirmed = current.plan.confirmedTasks.find((entry) => entry.taskId === request.taskId);
  if (!task || !confirmed || confirmed.version !== task.version) deny("plan_not_confirmed", ["任务不在已冻结的计划版本中"]);
  const byId = new Map(current.tasks.map((candidate) => [candidate.taskId, candidate]));
  const pendingDeps = task.dependsOn.filter((dep) => byId.get(dep)?.status !== "completed");
  if (pendingDeps.length) deny("dependency_pending", pendingDeps.map((dep) => byId.get(dep)?.key ?? dep));
  const manifest = registeredApprovalManifestIn(db, request.repoId, recordRow.data.approvalManifest!.reference, recordRow);
  const scope = implementScope(manifest);
  const revoked = task.goalUnitIds.filter((unit) => !scope.has(unit));
  if (revoked.length) deny("task_not_ready", revoked.map((unit) => `${unit} 已不在实施授权内`));
  const openQuestions = task.blockedByQuestionIds.filter((question) => !questionResolved(db, request.repoId, recordRow, question));
  if (openQuestions.length) deny("question_pending", openQuestions);
  if (activeCheckRoundIn(db, request.repoId, requirementId) !== null && task.role === "worker") deny("check_phase_active");
  if (task.attempts.some((attempt) => attempt.outcome === "running") || task.reviews.some((review) => review.outcome === "running")) {
    deny("task_not_ready", [`${task.key} 仍有运行中的子代理`]);
  }
  return { task, tasks: current.tasks };
}

/** 可写范围所在目录：以 / 结尾的是目录本身，其余是文件的上级目录；仓库根记为空串。 */
function directoriesOf(writePaths: readonly string[]): string[] {
  return writePaths.map((path) => {
    const normalized = posix.normalize(path);
    const dir = normalized.endsWith("/") ? normalized : posix.dirname(normalized) + "/";
    return dir === "./" ? "" : dir;
  });
}
const OCCUPYING: ReadonlySet<TaskRecord["status"]> = new Set(["running", "awaiting_review", "reviewing", "awaiting_rework"]);
/** 同时执行的 worker 任务所在目录不能重叠：同目录的半成品会让另一个任务的自测失败。 */
function assertDirectoriesFree(task: TaskRecord, tasks: readonly TaskRecord[]): void {
  const mine = directoriesOf(task.writePaths);
  const busy = tasks.filter((other) => other.taskId !== task.taskId && other.role === "worker" && OCCUPYING.has(other.status) &&
    directoriesOf(other.writePaths).some((dir) => mine.some((own) => own.startsWith(dir) || dir.startsWith(own))));
  if (busy.length) deny("write_scope_busy", busy.map((other) => other.key));
}

/** 用户对待裁决任务的"再给一次机会"：只用于裁决时的任务版本，用过即失效。 */
function userRetryGranted(task: TaskRecord): boolean {
  const decision = task.userDecision;
  return decision !== undefined && decision.usedByRunId === null && decision.choice === "retry" && task.version === decision.taskVersion;
}

/**
 * 派出执行或返修：执行首次尝试之外只允许一次带原因的重试，第二次仍未完成即等待用户裁决；审查打回后的返修另有一次机会，
 * 须给出原因与新的轮次上限，再次打回即等待用户裁决。worker 任务所在目录不能与执行中、待审查、待返修的任务重叠。
 * 通过后在同一事务中登记本次尝试为运行中。
 */
export function beginTaskAttempt(request: TaskDispatchRequest & { runId: string; now?: number }): { task: TaskRecord; maxTurns: number } {
  const gate = evaluatePmIntakeGate({ dataRoot: request.dataRoot, repoId: request.repoId, lease: request.lease });
  if (!gate.allowed) deny(gate.reasons.includes("pending_approved_update") ? "pending_update" : "intake_gate", gate.reasons);
  return withDatabase(repositoryDatabase(request.dataRoot, request.repoId), (db) => db.transaction(() => {
    const { task, tasks } = schedulingGateIn(db, request);
    if (!["pending", "awaiting_parent", "awaiting_rework"].includes(task.status)) deny("task_not_ready", [`${task.key}:${task.status}`]);
    if (task.role === "worker") assertDirectoriesFree(task, tasks);
    const rework = request.rework ?? null;
    let maxTurns: number, reason: string | null, grantedDecision = false;
    if (task.status === "awaiting_rework") {
      if (request.retry) deny("retry_not_needed");
      grantedDecision = reviewRejections(task) >= 2 && userRetryGranted(task);
      if (reviewRejections(task) >= 2 && !grantedDecision) deny("rework_exhausted");
      if (grantedDecision && rework) deny("rework_not_needed");
      if (!grantedDecision && !rework) deny("rework_required");
      maxTurns = grantedDecision ? task.userDecision!.maxTurns! : rework!.maxTurns;
      reason = grantedDecision ? "用户决定" : rework!.reason;
    } else {
      if (rework) deny("rework_not_needed");
      // 两次尝试之后只有用户的新决定能再开一次：再给一次机会只用于用户裁决时的任务版本并按用户给的上限，调整范围须任务已按新批准版本修改
      const decision = task.userDecision;
      const counted = countedAttempts(task);
      grantedDecision = counted >= 2 && decision !== undefined && decision.usedByRunId === null &&
        ((decision.choice === "retry" && task.version === decision.taskVersion) || (decision.choice === "adjust" && task.version > decision.taskVersion));
      if (counted >= 2 && !grantedDecision) deny("retry_exhausted");
      if (grantedDecision && request.retry) deny("retry_not_needed");
      if (counted === 1 && !request.retry) deny("retry_required");
      if (counted === 0 && request.retry) deny("retry_not_needed");
      maxTurns = grantedDecision && decision!.choice === "retry" ? decision!.maxTurns! : request.retry?.maxTurns ?? task.maxTurns;
      reason = grantedDecision ? "用户决定" : request.retry?.reason ?? null;
    }
    const attempt: TaskAttempt = { runId: request.runId, maxTurns, turnsUsed: 0, reason, outcome: "running", ...(task.status === "awaiting_rework" ? { rework: true as const } : {}) };
    const row = db.read<unknown>(TASKS, task.taskId)!;
    db.update(TASKS, task.taskId, row.version, { ...task, status: "running", attempts: [...task.attempts, attempt],
      ...(grantedDecision ? { userDecision: { ...task.userDecision!, usedByRunId: request.runId } } : {}), updatedAt: request.now ?? Date.now() });
    return { task, maxTurns };
  }));
}

/**
 * 派出任务级审查：只审待审查 worker 任务最近一次完成的尝试。审查运行未交出结论时允许再派一次，第二次仍未交出即等待用户裁决。
 * 不需要检查阶段令牌；检查阶段中不派。通过后在同一事务中登记本次审查为运行中。
 */
export function beginTaskReview(request: Omit<TaskDispatchRequest, "retry" | "rework"> & { runId: string; maxTurns: number; now?: number }):
  { task: TaskRecord; maxTurns: number; attemptRunId: string } {
  const gate = evaluatePmIntakeGate({ dataRoot: request.dataRoot, repoId: request.repoId, lease: request.lease });
  if (!gate.allowed) deny(gate.reasons.includes("pending_approved_update") ? "pending_update" : "intake_gate", gate.reasons);
  return withDatabase(repositoryDatabase(request.dataRoot, request.repoId), (db) => db.transaction(() => {
    const { task } = schedulingGateIn(db, request);
    if (task.role !== "worker" || task.status !== "awaiting_review") deny("task_not_ready", [`${task.key}:${task.status} 不在待审查`]);
    if (activeCheckRoundIn(db, request.repoId, request.lease.requirementId) !== null) deny("check_phase_active");
    const attempt = task.attempts.findLast((candidate) => candidate.outcome === "completed");
    if (!attempt) deny("task_not_ready", [`${task.key} 没有完成的尝试`]);
    const failures = reviewFailures(task.reviews, attempt!.runId);
    const granted = failures >= 2 && userRetryGranted(task);
    if (failures >= 2 && !granted) deny("retry_exhausted");
    const maxTurns = granted ? task.userDecision!.maxTurns! : request.maxTurns;
    const review: TaskReview = { runId: request.runId, attemptRunId: attempt!.runId, maxTurns, turnsUsed: 0, outcome: "running" };
    const row = db.read<unknown>(TASKS, task.taskId)!;
    db.update(TASKS, task.taskId, row.version, { ...task, status: "reviewing", reviews: [...task.reviews, review],
      ...(granted ? { userDecision: { ...task.userDecision!, usedByRunId: request.runId } } : {}), updatedAt: request.now ?? Date.now() });
    return { task, maxTurns, attemptRunId: attempt!.runId };
  }));
}

/** 登记一次尝试的真实结局：worker 完成进入待审查，其他职责完成即完成；其余首次进入等待父代理处置，第二次进入等待用户裁决。计数来自运行时，不由子代理自报。 */
export function finishTaskAttempt(request: { dataRoot: string; repoId: string; taskId: string; runId: string; turnsUsed: number;
  outcome: Exclude<TaskAttempt["outcome"], "running">; now?: number }): TaskRecord {
  return withDatabase(repositoryDatabase(request.dataRoot, request.repoId), (db) => db.transaction(() => {
    const row = db.read<TaskRecord>(TASKS, request.taskId);
    if (!row) throw new PlanManageError("plan_missing");
    const task = row.data;
    const index = task.attempts.findIndex((attempt) => attempt.runId === request.runId);
    if (index < 0 || task.attempts[index]!.outcome !== "running") return task;
    const attempts = task.attempts.map((attempt, i) => i === index ? { ...attempt, outcome: request.outcome, turnsUsed: request.turnsUsed } : attempt);
    // 运行期间影响复核已把任务改为待更新或受阻时，结局只记入尝试，不覆盖复核结论
    const status = task.status !== "running" ? task.status
      : request.outcome === "completed" ? (task.role === "worker" ? "awaiting_review" : "completed") : request.outcome === "superseded" ? "pending"
        : countedAttempts({ attempts }) >= 2 ? "awaiting_user" : "awaiting_parent";
    const next = { ...task, status, attempts, updatedAt: request.now ?? Date.now() } as TaskRecord;
    db.update(TASKS, task.taskId, row.version, next);
    return next;
  }));
}

/**
 * 登记一次任务级审查的真实结局：通过则被审任务完成；打回首次进入待返修、再次打回等待用户裁决；
 * 未交出结论首次回到待审查、再次即等待用户裁决。
 */
export function finishTaskReview(request: { dataRoot: string; repoId: string; taskId: string; runId: string; turnsUsed: number;
  outcome: Exclude<TaskReview["outcome"], "running">; now?: number }): TaskRecord {
  return withDatabase(repositoryDatabase(request.dataRoot, request.repoId), (db) => db.transaction(() => {
    const row = db.read<TaskRecord>(TASKS, request.taskId);
    if (!row) throw new PlanManageError("plan_missing");
    const task = row.data;
    const index = task.reviews.findIndex((review) => review.runId === request.runId);
    if (index < 0 || task.reviews[index]!.outcome !== "running") return task;
    const reviews = task.reviews.map((review, i) => i === index ? { ...review, outcome: request.outcome, turnsUsed: request.turnsUsed } : review);
    const outcome = request.outcome;
    // 运行期间影响复核已把任务改为待更新或受阻时，结局只记入审查，不覆盖复核结论
    const status = task.status !== "reviewing" ? task.status
      : outcome === "clear" ? "completed"
        : outcome === "blocked" || outcome === "unverified" ? (reviewRejections({ reviews }) >= 2 ? "awaiting_user" : "awaiting_rework")
          : outcome === "superseded" ? "awaiting_review"
            : reviewFailures(reviews, reviews[index]!.attemptRunId) >= 2 ? "awaiting_user" : "awaiting_review";
    const next = { ...task, status, reviews, updatedAt: request.now ?? Date.now() } as TaskRecord;
    db.update(TASKS, task.taskId, row.version, next);
    return next;
  }));
}
