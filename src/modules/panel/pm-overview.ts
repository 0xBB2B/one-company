import { registeredApprovalManifestIn } from "../requirement/approval-manifest-store.ts";
import { activeCheckRoundIn } from "../verification/check-round.ts";
import type { LocalDatabase } from "../../core/storage/database.ts";
import { implementScope, latestRound, readPlanIn, REVIEW_OUTCOME_LABEL, REVIEW_REJECTED, reviewFailures, stalledStage, terminationPending, unsentTask } from "../pm/plan-manage.ts";
import type { TaskRecord } from "../pm/plan-manage.ts";
import { reviewDispatchable } from "../pm/task-dispatch.ts";
import { latestPmSubmission } from "../pm/pm-intake-runtime.ts";
import { PmIntakeStore } from "../pm/pm-intake-store.ts";
import { planRejectionsIn, stallIn } from "../pm/pm-attention.ts";
import type { PmLease, RequirementRecord } from "../requirement/requirement-contracts.ts";
import type { RunRecord } from "../agents/run-store.ts";
import { pendingReportIn } from "../delivery/workflow-close.ts";

export type PendingItemKind = "adjudicate" | "intake-review" | "question" | "adjust-requirement" | "acceptance" | "plan-rejected" | "stall";
export interface PendingItem {
  itemId: string;
  kind: PendingItemKind;
  label: string;
  /** 事项所依据记录的版本；登记决定时须与当前一致。 */
  version: string;
  /** 和某个任务有关时为任务号，面板把它画在这个任务的行上。 */
  taskKey?: string;
  /** 画在任务行上时用的短文字，去掉了"任务 <任务号> "。 */
  taskText?: string;
}

export interface PanelRunStats { turns: number; maxTurns: number | null; elapsedMs: number }

export type PanelReviewerState = "running" | "clear" | "blocked" | "awaiting_retry" | "exhausted" | "skipped_disabled" | "skipped_missing" | "passed_earlier";
export interface PanelReviewerRow extends Partial<PanelRunStats> {
  agent: string;
  state: PanelReviewerState;
  /** 本轮第几次派这个代理；只在大于 1 时给出。 */
  attempt?: number;
  /** awaiting_retry 时没交出结论的原因。 */
  reason?: "turn_limit_reached" | "failed" | "stopped" | "superseded";
}

export type PanelTaskRow =
  | ({ kind: "execute"; taskKey: string; agent: string; attempt: number } & PanelRunStats)
  | { kind: "review"; taskKey: string; round: number; reviewers: PanelReviewerRow[] }
  | { kind: "pending"; taskKey: string; itemId: string; text: string }
  | ({ kind: "explore" } & PanelRunStats);
export type PmOverviewStatus = "running" | "pausing" | "paused" | "waiting";
export interface PmOverview {
  requirementId: string;
  pmRunId: string;
  goals: string[];
  status: PmOverviewStatus;
  doing: string;
  turns: number;
  toolUses: number;
  tokens: number;
  /** 缓存读取 ÷（输入 + 缓存读取 + 缓存写入）；尚无输入时为 null。 */
  cacheRate: number | null;
  elapsedMs: number;
  taskProgress: { completed: number; total: number } | null;
  pendingItems: PendingItem[];
  taskRows: PanelTaskRow[];
}

export interface PmOverviewInput {
  dataRoot: string;
  repoId: string;
  db: LocalDatabase;
  record: RequirementRecord;
  lease: PmLease;
  pm: RunRecord;
  /** 该 PM 派出的全部子代理运行，含已结束的。 */
  children: RunRecord[];
  /** PM 会话当前没有进行中的模型回合、排队消息或工具。 */
  pmIdle: boolean;
  /** 已批准正文中各章节 ID 对应的标题。 */
  headingTitles: ReadonlyMap<string, string>;
  now: number;
}

const ACTIVE_CHILD = new Set(["queued", "running", "pausing"]);
const ROLE_LABEL: Record<string, string> = { "one-company.worker": "worker", "one-company.reviewer": "reviewer", "one-company.qa": "qa", "one-company.explore": "explore" };

/** 已批准正文里带显式 ID 的标题：`# 标题 {#id}`。 */
export function headingTitlesOf(body: string): Map<string, string> {
  const titles = new Map<string, string>();
  for (const line of body.split("\n")) {
    const match = /^ {0,3}#{1,6}[\t ]+(.+?)[\t ]*\{#([^{}]+)\}[\t ]*$/u.exec(line);
    if (match) titles.set(match[2]!, match[1]!.trim());
  }
  return titles;
}

/** 主代理的核对是否仍算数：通过的须是当前这个 PM 最新提交的那份，与派工门槛同一标准；PM 通过后又交了新的一份就要重新核对。 */
function reviewPassedFor(input: Pick<PmOverviewInput, "dataRoot" | "repoId" | "lease" | "record">): boolean {
  const { lease, record } = input;
  const review = new PmIntakeStore({ dataRoot: input.dataRoot, repoId: input.repoId }).readHead(lease.requirementId)?.review;
  if (review?.result !== "passed" || review.binding.pmRunId !== lease.runId || review.binding.pmFence !== lease.fence ||
    review.binding.contextGeneration !== lease.contextGeneration) return false;
  if (!record.approved || review.binding.approvedRevision !== record.revision) return true;
  const latest = latestPmSubmission({ dataRoot: input.dataRoot, repoId: input.repoId, runId: lease.runId, baseline: {
    approvedRevision: record.revision, approvedPrdHash: record.approved.hash, approvalManifestHash: record.approvalManifest!.reference.manifestHash } });
  return !latest || review.submissionRef === `pm/${lease.runId}/${latest.toolCallId}`;
}

function questionPending(db: LocalDatabase, repoId: string, record: RequirementRecord, row: ReturnType<typeof requirementRow>, questionId: string): boolean {
  const manifest = registeredApprovalManifestIn(db, repoId, record.approvalManifest!.reference, row);
  const entry = manifest.questions.find((question) => question.requestId === questionId);
  return entry === undefined || entry.pendingIds.length > 0;
}

function requirementRow(db: LocalDatabase, requirementId: string) {
  return db.read<RequirementRecord>("requirements", requirementId)!;
}

/** 最近一轮里没交出结论达到 2 次的审查代理。 */
export function unfinishedReviewers(task: TaskRecord): string[] {
  return latestRound(task).reviews.map((review) => review.agent).filter((agent) => reviewFailures(task.reviews, agent) >= 2);
}

export function reviewLine(review: TaskRecord["reviews"][number]): string {
  return `第 ${review.round} 轮 ${review.agent}：${REVIEW_OUTCOME_LABEL[review.outcome]}`;
}

export function namesIn(names: string[]): string {
  return names.length ? `（${names.join("、")}）` : "";
}

function stallCauseOf(task: TaskRecord): string {
  const stage = stalledStage(task);
  if (stage === "execute") return "两次未完成";
  if (stage === "review") return `两次审查未完成${namesIn(unfinishedReviewers(task))}`;
  const rejectors = [...new Set(task.reviews.filter((review) => REVIEW_REJECTED.has(review.outcome)).map((review) => review.agent))];
  return `两次未通过审查${namesIn(rejectors)}`;
}

function onTask(task: TaskRecord, label: string): Pick<PendingItem, "taskKey" | "taskText"> {
  return { taskKey: task.key, taskText: label.replace(`任务 ${task.key} `, "") };
}

/** 待处理事项只取自已有持久记录：终止后待调整的需求、待用户裁决的任务、待核对的接手理解、阻塞任务的未决问题。 */
export function pendingItemsIn(input: Pick<PmOverviewInput, "dataRoot" | "repoId" | "db" | "record" | "lease">, tasks: TaskRecord[]): PendingItem[] {
  const items: PendingItem[] = [];
  for (const task of tasks) {
    if (!terminationPending([task], input.record.revision)) continue;
    const label = `待决定：任务 ${task.key} 已终止，请调整需求或取消需求`;
    items.push({ itemId: `halt:${task.taskId}`, kind: "adjust-requirement", label, version: `halt:${task.taskId}:${input.record.revision}`, ...onTask(task, label) });
  }
  for (const task of tasks) {
    if (task.status !== "awaiting_user") continue;
    const row = input.db.read<TaskRecord>("tasks", task.taskId)!;
    const cause = task.sizeHold && unsentTask(task) ? task.sizeHold.join("；")
      : task.attempts.at(-1)?.escalation !== undefined || task.holdNote !== undefined && unsentTask(task) ? "PM 上报需要决定"
      : stallCauseOf(task);
    const label = `待裁决：任务 ${task.key} ${cause}`;
    items.push({ itemId: `task:${task.taskId}`, kind: "adjudicate", label, version: `task:${task.taskId}:${row.version}`, ...onTask(task, label) });
  }
  if (input.record.approved && !reviewPassedFor(input)) {
    const submission = latestPmSubmission({ dataRoot: input.dataRoot, repoId: input.repoId, runId: input.lease.runId, baseline: {
      approvedRevision: input.record.revision, approvedPrdHash: input.record.approved.hash, approvalManifestHash: input.record.approvalManifest!.reference.manifestHash } });
    if (submission) items.push({ itemId: `intake:${input.lease.runId}`, kind: "intake-review", label: `待核对：PM 接手理解 r${input.record.revision}`,
      version: `intake:${input.lease.runId}:${submission.toolCallId}` });
  }
  const row = requirementRow(input.db, input.lease.requirementId);
  const asked = new Set<string>();
  for (const task of tasks) {
    if (["completed", "cancelled"].includes(task.status)) continue;
    for (const questionId of task.blockedByQuestionIds) {
      if (asked.has(questionId) || !questionPending(input.db, input.repoId, input.record, row, questionId)) continue;
      asked.add(questionId);
      items.push({ itemId: `question:${questionId}`, kind: "question", label: `待回答：任务 ${task.key} 的未决问题`,
        version: `question:${questionId}:${input.record.approvalManifest!.reference.manifestHash}`,
        taskKey: task.key, taskText: "待回答：未决问题" });
    }
  }
  const report = input.record.lifecycle === "active" ? pendingReportIn(input.db, input.repoId, input.lease.requirementId) : null;
  if (report) items.push({ itemId: `report:${report.data.reportId}`, kind: "acceptance", label: "待验收：PM 完成报告", version: `report:${report.data.reportId}:${report.version}` });
  const rejected = planRejectionsIn(input.db, input.lease.requirementId);
  if (rejected?.pmRunId === input.lease.runId && rejected.count >= 2) items.push({ itemId: `plan:${input.lease.requirementId}`, kind: "plan-rejected",
    label: "待裁决：PM 计划两次提交被拒", version: `plan:${input.lease.requirementId}:${rejected.count}` });
  // 已有别的事项交用户处理时，停下提醒是多余的
  const stall = stallIn(input.db, input.lease.requirementId);
  if (stall?.pmRunId === input.lease.runId && items.length === 0) items.push({ itemId: `stall:${input.lease.runId}`, kind: "stall",
    label: "待处理：PM 停下了，没有在跑的子任务", version: `stall:${input.lease.runId}:${stall.at}` });
  return items;
}

/** 第二行"在做什么"只按真实状态生成，不采用 PM 模型的自述。 */
function doingOf(input: PmOverviewInput, tasks: TaskRecord[], plan: ReturnType<typeof readPlanIn>, status: PmOverviewStatus, items: PendingItem[]): string {
  if (status === "paused") return terminationPending(tasks, input.record.revision) ? "等待调整需求" : "已暂停";
  if (status === "pausing") {
    const running = input.children.filter((child) => ACTIVE_CHILD.has(child.state));
    return running.length ? `暂停中：等待 ${running.map((child) => child.agent?.name ?? ROLE_LABEL[child.role ?? ""] ?? "子代理").join("、")} 结束` : "暂停中：等待当前工具结束";
  }
  const rejected = planRejectionsIn(input.db, input.lease.requirementId);
  const rejectedCount = rejected?.pmRunId === input.lease.runId ? rejected.count : 0;
  if (rejectedCount > 0 && !input.children.some((child) => ACTIVE_CHILD.has(child.state))) {
    return `规划中（计划提交被拒 ${rejectedCount} 次，${rejectedCount >= 2 ? "等待决定" : "PM 正在按原因修改"}）`;
  }
  // 停下提醒不改第二行：仍按 PM 停下时的真实进度显示
  if (status === "waiting" && items.some((item) => item.kind !== "stall")) return items.some((item) => item.kind === "acceptance") ? "等待验收完成报告" : "等待决定";
  if (!reviewPassedFor(input)) return items.some((item) => item.kind === "intake-review") ? "等待核对接手理解" : "接手中";
  if (input.record.pendingRevision !== null) return `复核批准更新 r${input.record.pendingRevision}`;
  if (activeCheckRoundIn(input.db, input.repoId, input.lease.requirementId)) return "检查中";
  const running = input.children.filter((child) => ACTIVE_CHILD.has(child.state));
  if (running.length) {
    const child = running[0]!, task = tasks.find((candidate) => candidate.taskId === child.task);
    const attempt = task ? task.attempts.findIndex((entry) => entry.runId === child.id) + 1 : 0;
    const review = task ? task.reviews.findIndex((entry) => entry.runId === child.id) + 1 : 0;
    const name = child.agent?.name ?? ROLE_LABEL[child.role ?? ""] ?? "子代理";
    const head = child.role === "one-company.explore" ? "派 explore 检索"
      : review > 0 ? `派 ${name} 审查 ${task!.key}（第 ${review} 次审查）`
        : `派 ${name} 执行 ${task?.key ?? "任务"}${attempt > 0 ? `（第 ${attempt} 次尝试）` : ""}`;
    return running.length > 1 ? `${head} 等 ${running.length} 个` : head;
  }
  if (!plan) return "规划中";
  if (plan.plan.confirmedVersion === null) return `规划中（计划 v${plan.plan.planVersion} · ${tasks.filter((task) => task.status !== "cancelled").length} 个任务）`;
  return "空闲";
}

function runStatsOf(run: RunRecord, now: number): PanelRunStats {
  const end = run.endedAt ? Date.parse(run.endedAt) : now;
  const pausedNow = run.pausedAt ? Math.max(0, end - Date.parse(run.pausedAt)) : 0;
  return { turns: run.turns, maxTurns: run.maxTurns ?? null, elapsedMs: Math.max(0, end - Date.parse(run.startedAt) - (run.pausedMs ?? 0) - pausedNow) };
}

function reviewerRowsOf(task: TaskRecord, round: number, runs: ReadonlyMap<string, RunRecord>, now: number): PanelReviewerRow[] {
  const rows = latestRound(task).reviews.map((review): PanelReviewerRow => {
    const { outcome } = review;
    if (outcome === "running") {
      const run = runs.get(review.runId);
      const attempt = task.reviews.filter((entry) => entry.round === round && entry.agent === review.agent).length;
      return { agent: review.agent, state: "running", ...(attempt > 1 ? { attempt } : {}), ...(run ? runStatsOf(run, now) : {}) };
    }
    const run = runs.get(review.runId);
    const stats = run ? runStatsOf(run, now) : { turns: review.turnsUsed, maxTurns: review.maxTurns };
    if (outcome === "failed" || outcome === "turn_limit_reached" || outcome === "stopped" || outcome === "superseded") {
      return { agent: review.agent, state: outcome !== "superseded" && !reviewDispatchable(task, review.agent) ? "exhausted" : "awaiting_retry", reason: outcome, ...stats };
    }
    if (outcome === "skipped") return { agent: review.agent, state: review.skipReason === "missing" ? "skipped_missing" : "skipped_disabled" };
    return { agent: review.agent, state: outcome === "clear" ? "clear" : "blocked", ...stats };
  });
  const present = new Set(rows.map((row) => row.agent));
  const earlier = new Map<string, TaskRecord["reviews"][number]>();
  for (const review of task.reviews) if (review.round < round) earlier.set(review.agent, review);
  for (const [agent, review] of earlier) if (review.outcome === "clear" && !present.has(agent)) rows.push({ agent, state: "passed_earlier" });
  return rows;
}

function taskRowsOf(input: PmOverviewInput, tasks: TaskRecord[], items: PendingItem[]): PanelTaskRow[] {
  if (input.pm.state === "pausing" || input.pm.state === "paused") return [];
  const runs = new Map(input.children.map((child) => [child.id, child]));
  const rows: PanelTaskRow[] = [];
  for (const task of tasks) {
    for (const item of items) if (item.taskKey === task.key) rows.push({ kind: "pending", taskKey: task.key, itemId: item.itemId, text: item.taskText! });
    const attemptIndex = task.attempts.findIndex((attempt) => attempt.outcome === "running");
    const run = attemptIndex >= 0 ? runs.get(task.attempts[attemptIndex]!.runId) : undefined;
    if (run) rows.push({ kind: "execute", taskKey: task.key, agent: run.agent?.name ?? ROLE_LABEL[run.role ?? ""] ?? "子代理", attempt: attemptIndex + 1, ...runStatsOf(run, input.now) });
    const { round, reviews } = latestRound(task);
    if (task.status === "reviewing" || reviews.some((review) => review.outcome === "running")) {
      rows.push({ kind: "review", taskKey: task.key, round, reviewers: reviewerRowsOf(task, round, runs, input.now) });
    }
  }
  for (const child of input.children) {
    if (child.role === "one-company.explore" && ACTIVE_CHILD.has(child.state)) rows.push({ kind: "explore", ...runStatsOf(child, input.now) });
  }
  return rows;
}

function taskProgressOf(tasks: TaskRecord[]): PmOverview["taskProgress"] {
  const counted = tasks.filter((task) => task.status !== "cancelled");
  return counted.length ? { completed: counted.filter((task) => task.status === "completed").length, total: counted.length } : null;
}

export function pmOverview(input: PmOverviewInput): PmOverview {
  const plan = readPlanIn(input.db, input.lease.requirementId);
  const tasks = plan?.tasks ?? [];
  const items = pendingItemsIn(input, tasks);
  const childActive = input.children.some((child) => ACTIVE_CHILD.has(child.state));
  const status: PmOverviewStatus = input.pm.state === "paused" ? "paused" : input.pm.state === "pausing" ? "pausing"
    : items.length > 0 && input.pmIdle && !childActive ? "waiting" : "running";
  const runs = [input.pm, ...input.children];
  const sum = (pick: (run: RunRecord) => number) => runs.reduce((total, run) => total + pick(run), 0);
  const input_ = sum((run) => run.usage?.input ?? 0), cacheRead = sum((run) => run.usage?.cacheRead ?? 0), cacheWrite = sum((run) => run.usage?.cacheWrite ?? 0);
  const prompt = input_ + cacheRead + cacheWrite;
  const pausedNow = input.pm.pausedAt ? Math.max(0, input.now - Date.parse(input.pm.pausedAt)) : 0;
  const manifest = registeredApprovalManifestIn(input.db, input.repoId, input.record.approvalManifest!.reference, requirementRow(input.db, input.lease.requirementId));
  const goals = [...implementScope(manifest, input.record.docSpec?.sections ?? [])].map((unitId) => input.headingTitles.get(unitId) ?? unitId);
  return {
    requirementId: input.lease.requirementId, pmRunId: input.pm.id, goals, status,
    doing: doingOf(input, tasks, plan, status, items),
    turns: sum((run) => run.turns), toolUses: sum((run) => run.usage?.toolUses ?? 0),
    tokens: prompt + sum((run) => run.usage?.output ?? 0), cacheRate: prompt > 0 ? cacheRead / prompt : null,
    elapsedMs: Math.max(0, input.now - Date.parse(input.pm.startedAt) - (input.pm.pausedMs ?? 0) - pausedNow),
    taskProgress: taskProgressOf(tasks),
    pendingItems: items,
    taskRows: taskRowsOf(input, tasks, items),
  };
}
