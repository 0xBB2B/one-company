import { registeredApprovalManifestIn } from "./approval-manifest-store.ts";
import { activeCheckRoundIn } from "./check-round.ts";
import type { LocalDatabase } from "./database.ts";
import { implementScope, readPlanIn, terminationPending } from "./plan-manage.ts";
import type { TaskRecord } from "./plan-manage.ts";
import { latestPmSubmission } from "./pm-intake-runtime.ts";
import { PmIntakeStore } from "./pm-intake-store.ts";
import type { PmLease, RequirementRecord } from "./requirement-contracts.ts";
import type { RunRecord } from "./run-store.ts";

export type PendingItemKind = "adjudicate" | "intake-review" | "question" | "adjust-requirement";
export interface PendingItem {
  itemId: string;
  kind: PendingItemKind;
  label: string;
  /** 事项所依据记录的版本；登记决定时须与当前一致。 */
  version: string;
}
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
  pendingItems: PendingItem[];
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

const ACTIVE_CHILD = new Set(["queued", "running", "pausing", "waiting_answer", "paused_network"]);
const ROLE_LABEL: Record<string, string> = { "pi-company.worker": "worker", "pi-company.reviewer": "reviewer", "pi-company.qa": "qa", "pi-company.explore": "explore" };

/** 已批准正文里带显式 ID 的标题：`# 标题 {#id}`。 */
export function headingTitlesOf(body: string): Map<string, string> {
  const titles = new Map<string, string>();
  for (const line of body.split("\n")) {
    const match = /^ {0,3}#{1,6}[\t ]+(.+?)[\t ]*\{#([^{}]+)\}[\t ]*$/u.exec(line);
    if (match) titles.set(match[2]!, match[1]!.trim());
  }
  return titles;
}

function reviewPassedFor(dataRoot: string, repoId: string, lease: PmLease): boolean {
  const review = new PmIntakeStore({ dataRoot, repoId }).readHead(lease.requirementId)?.review;
  return review?.result === "passed" && review.binding.pmRunId === lease.runId && review.binding.pmFence === lease.fence &&
    review.binding.contextGeneration === lease.contextGeneration;
}

function questionPending(db: LocalDatabase, repoId: string, record: RequirementRecord, row: ReturnType<typeof requirementRow>, questionId: string): boolean {
  if (!record.approvalManifest) return true;
  const manifest = registeredApprovalManifestIn(db, repoId, record.approvalManifest.reference, row);
  const entry = manifest.questions.find((question) => question.requestId === questionId);
  return entry === undefined || entry.pendingIds.length > 0;
}

function requirementRow(db: LocalDatabase, requirementId: string) {
  return db.read<RequirementRecord>("requirements", requirementId)!;
}

/** 待处理事项只取自已有持久记录：终止后待调整的需求、待用户裁决的任务、待核对的接手理解、阻塞任务的未决问题。 */
export function pendingItemsIn(input: Pick<PmOverviewInput, "dataRoot" | "repoId" | "db" | "record" | "lease">, tasks: TaskRecord[]): PendingItem[] {
  const items: PendingItem[] = [];
  for (const task of tasks) {
    if (!terminationPending([task], input.record.revision)) continue;
    items.push({ itemId: `halt:${task.taskId}`, kind: "adjust-requirement", label: `待你决定：任务 ${task.key} 已终止，请调整需求或取消需求`,
      version: `halt:${task.taskId}:${input.record.revision}` });
  }
  for (const task of tasks) {
    if (task.status !== "awaiting_user") continue;
    const row = input.db.read<TaskRecord>("tasks", task.taskId)!;
    items.push({ itemId: `task:${task.taskId}`, kind: "adjudicate", label: `待你裁决：任务 ${task.key} 两次未完成`, version: `task:${task.taskId}:${row.version}` });
  }
  if (input.record.approved && input.record.approvalManifest && !reviewPassedFor(input.dataRoot, input.repoId, input.lease)) {
    const submission = latestPmSubmission({ dataRoot: input.dataRoot, repoId: input.repoId, runId: input.lease.runId, baseline: {
      approvedRevision: input.record.revision, approvedProdHash: input.record.approved.hash, approvalManifestHash: input.record.approvalManifest.reference.manifestHash } });
    if (submission) items.push({ itemId: `intake:${input.lease.runId}`, kind: "intake-review", label: `待你核对：PM 接手理解 r${input.record.revision}`,
      version: `intake:${input.lease.runId}:${submission.toolCallId}` });
  }
  const row = requirementRow(input.db, input.lease.requirementId);
  const asked = new Set<string>();
  for (const task of tasks) {
    if (["completed", "cancelled"].includes(task.status)) continue;
    for (const questionId of task.blockedByQuestionIds) {
      if (asked.has(questionId) || !questionPending(input.db, input.repoId, input.record, row, questionId)) continue;
      asked.add(questionId);
      items.push({ itemId: `question:${questionId}`, kind: "question", label: `待你回答：任务 ${task.key} 的未决问题`,
        version: `question:${questionId}:${input.record.approvalManifest?.reference.manifestHash ?? "none"}` });
    }
  }
  return items;
}

/** 第二行"在做什么"只按真实状态生成，不采用 PM 模型的自述。 */
function doingOf(input: PmOverviewInput, tasks: TaskRecord[], plan: ReturnType<typeof readPlanIn>, status: PmOverviewStatus, items: PendingItem[]): string {
  if (status === "paused") return terminationPending(tasks, input.record.revision) ? "等待你调整需求" : "已暂停";
  if (status === "pausing") {
    const running = input.children.filter((child) => ACTIVE_CHILD.has(child.state));
    return running.length ? `暂停中：等待 ${running.map((child) => ROLE_LABEL[child.role ?? ""] ?? "子代理").join("、")} 结束` : "暂停中：等待当前工具结束";
  }
  if (status === "waiting") return "等待你的决定";
  if (!reviewPassedFor(input.dataRoot, input.repoId, input.lease)) return items.some((item) => item.kind === "intake-review") ? "等待核对接手理解" : "接手中";
  if (input.record.pendingRevision !== null) return `复核批准更新 r${input.record.pendingRevision}`;
  if (activeCheckRoundIn(input.db, input.repoId, input.lease.requirementId)) return "检查中";
  const running = input.children.filter((child) => ACTIVE_CHILD.has(child.state));
  if (running.length) {
    const child = running[0]!, task = tasks.find((candidate) => candidate.taskId === child.task);
    const attempt = task ? task.attempts.findIndex((entry) => entry.runId === child.id) + 1 : 0;
    const head = `派 ${ROLE_LABEL[child.role ?? ""] ?? "子代理"} 执行 ${task?.key ?? "任务"}${attempt > 0 ? `（第 ${attempt} 次尝试）` : ""}`;
    return running.length > 1 ? `${head} 等 ${running.length} 个` : head;
  }
  if (!plan) return "规划中";
  if (plan.plan.confirmedVersion === null) return `规划中（计划 v${plan.plan.planVersion} · ${tasks.filter((task) => task.status !== "cancelled").length} 个任务）`;
  return "空闲";
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
  const manifest = input.record.approvalManifest
    ? registeredApprovalManifestIn(input.db, input.repoId, input.record.approvalManifest.reference, requirementRow(input.db, input.lease.requirementId)) : null;
  const goals = manifest ? [...implementScope(manifest)].map((unitId) => input.headingTitles.get(unitId) ?? unitId) : [];
  return {
    requirementId: input.lease.requirementId, pmRunId: input.pm.id, goals, status,
    doing: doingOf(input, tasks, plan, status, items),
    turns: sum((run) => run.turns), toolUses: sum((run) => run.usage?.toolUses ?? 0),
    tokens: prompt + sum((run) => run.usage?.output ?? 0), cacheRate: prompt > 0 ? cacheRead / prompt : null,
    elapsedMs: Math.max(0, input.now - Date.parse(input.pm.startedAt) - (input.pm.pausedMs ?? 0) - pausedNow),
    pendingItems: items,
  };
}
