import { registeredApprovalManifestIn } from "./approval-manifest-store.ts";
import { activeCheckRoundIn } from "./check-round.ts";
import { repositoryDatabase, withDatabase } from "./database.ts";
import type { LocalDatabase, StoredRecord } from "./database.ts";
import { PlanManageError, readPlanIn, TASKS } from "./plan-manage.ts";
import type { TaskAttempt, TaskRecord } from "./plan-manage.ts";
import { evaluatePmIntakeGate } from "./pm-intake-runtime.ts";
import type { PmLease, RequirementRecord } from "./requirement-contracts.ts";

export type TaskDispatchErrorCode = "intake_gate" | "pending_update" | "plan_not_confirmed" | "task_not_ready" | "dependency_pending"
  | "question_pending" | "check_phase_active" | "retry_required" | "retry_exhausted" | "retry_not_needed";
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
}

function questionResolved(db: LocalDatabase, repoId: string, record: StoredRecord<RequirementRecord>, questionId: string): boolean {
  if (!record.data.approvalManifest) return false;
  const manifest = registeredApprovalManifestIn(db, repoId, record.data.approvalManifest.reference, record);
  const entry = manifest.questions.find((question) => question.requestId === questionId);
  return entry !== undefined && entry.pendingIds.length === 0;
}

/**
 * 派子代理前的程序门槛：接手核对通过且有实施授权、无待处理更新、任务在已冻结版本中、依赖已完成、未决问题已解决、
 * 修改类任务不在检查阶段；首次尝试之外只允许一次带原因的重试，第二次仍未完成即等待用户裁决。
 * 通过后在同一事务中登记本次尝试为运行中。
 */
export function beginTaskAttempt(request: TaskDispatchRequest & { runId: string; now?: number }): { task: TaskRecord; maxTurns: number } {
  const gate = evaluatePmIntakeGate({ dataRoot: request.dataRoot, repoId: request.repoId, lease: request.lease });
  if (!gate.allowed) deny(gate.reasons.includes("pending_approved_update") ? "pending_update" : "intake_gate", gate.reasons);
  return withDatabase(repositoryDatabase(request.dataRoot, request.repoId), (db) => db.transaction(() => {
    const requirementId = request.lease.requirementId;
    const recordRow = db.read<RequirementRecord>("requirements", requirementId);
    if (!recordRow || recordRow.data.pendingRevision !== null) deny("pending_update");
    const current = readPlanIn(db, requirementId);
    if (!current || current.plan.confirmedVersion === null) deny("plan_not_confirmed");
    const task = current.tasks.find((candidate) => candidate.taskId === request.taskId);
    const confirmed = current.plan.confirmedTasks.find((entry) => entry.taskId === request.taskId);
    if (!task || !confirmed || confirmed.version !== task.version) deny("plan_not_confirmed", ["任务不在已冻结的计划版本中"]);
    if (!["pending", "awaiting_parent"].includes(task.status)) deny("task_not_ready", [`${task.key}:${task.status}`]);
    const byId = new Map(current.tasks.map((candidate) => [candidate.taskId, candidate]));
    const pendingDeps = task.dependsOn.filter((dep) => byId.get(dep)?.status !== "completed");
    if (pendingDeps.length) deny("dependency_pending", pendingDeps.map((dep) => byId.get(dep)?.key ?? dep));
    const openQuestions = task.blockedByQuestionIds.filter((question) => !questionResolved(db, request.repoId, recordRow, question));
    if (openQuestions.length) deny("question_pending", openQuestions);
    if (task.role === "worker" && activeCheckRoundIn(db, request.repoId, requirementId) !== null) deny("check_phase_active");
    if (task.attempts.length >= 2) deny("retry_exhausted");
    if (task.attempts.length === 1 && !request.retry) deny("retry_required");
    if (task.attempts.length === 0 && request.retry) deny("retry_not_needed");
    const maxTurns = request.retry?.maxTurns ?? task.maxTurns;
    const attempt: TaskAttempt = { runId: request.runId, maxTurns, turnsUsed: 0, reason: request.retry?.reason ?? null, outcome: "running" };
    const row = db.read<unknown>(TASKS, task.taskId)!;
    db.update(TASKS, task.taskId, row.version, { ...task, status: "running", attempts: [...task.attempts, attempt], updatedAt: request.now ?? Date.now() });
    return { task, maxTurns };
  }));
}

/** 登记一次尝试的真实结局：完成即完成；其余首次进入等待父代理处置，第二次进入等待用户裁决。计数来自运行时，不由子代理自报。 */
export function finishTaskAttempt(request: { dataRoot: string; repoId: string; taskId: string; runId: string; turnsUsed: number;
  outcome: Exclude<TaskAttempt["outcome"], "running">; now?: number }): TaskRecord {
  return withDatabase(repositoryDatabase(request.dataRoot, request.repoId), (db) => db.transaction(() => {
    const row = db.read<TaskRecord>(TASKS, request.taskId);
    if (!row) throw new PlanManageError("plan_missing");
    const task = row.data;
    const index = task.attempts.findIndex((attempt) => attempt.runId === request.runId);
    if (index < 0 || task.attempts[index]!.outcome !== "running") return task;
    const attempts = task.attempts.map((attempt, i) => i === index ? { ...attempt, outcome: request.outcome, turnsUsed: request.turnsUsed } : attempt);
    const status = request.outcome === "completed" ? "completed" : attempts.length >= 2 ? "awaiting_user" : "awaiting_parent";
    const next = { ...task, status, attempts, updatedAt: request.now ?? Date.now() } as TaskRecord;
    db.update(TASKS, task.taskId, row.version, next);
    return next;
  }));
}
