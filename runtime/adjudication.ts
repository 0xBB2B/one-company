import { repositoryDatabase, withDatabase } from "./database.ts";
import type { LocalDatabase } from "./database.ts";
import { confirmedPlanKey, readPlanIn, TASKS } from "./plan-manage.ts";
import type { TaskRecord, UserDecision } from "./plan-manage.ts";
import { pendingItemsIn } from "./pm-overview.ts";
import type { PmLease, RequirementRecord } from "./requirement-contracts.ts";
import { checkDecisionRecord } from "./short-decision-format.ts";
import type { AdjudicationChoice, AdjudicationSubject } from "./user-interaction-format.ts";
import { ADJUDICATION_CHOICES } from "./user-interaction-format.ts";

export class AdjudicationError extends Error {
  readonly code: string;
  constructor(code: string) { super(`adjudication_denied:${code}`); this.name = "AdjudicationError"; this.code = code; }
}
const deny = (code: string): never => { throw new AdjudicationError(code); };

type Ref = { dataRoot: string; repoId: string };

function current(db: LocalDatabase, requirementId: string): { record: RequirementRecord; version: number; lease: PmLease } {
  const row = db.read<RequirementRecord>("requirements", requirementId) ?? deny("unknown_requirement");
  const lease = db.read<{ lease?: PmLease | null }>("pm_ownership", requirementId)?.data.lease ?? deny("pm_missing");
  if (row.data.lifecycle !== "active") deny("requirement_not_active");
  return { record: row.data, version: row.version, lease };
}

/** 给解释器的事项摘要只含程序记录的任务、轮数与结局；PM 与子代理写的文字不进入解释用户原话的上下文。 */
export function adjudicationSubject(ref: Ref, requirementId: string, itemId: string): AdjudicationSubject {
  return withDatabase(repositoryDatabase(ref.dataRoot, ref.repoId), (db) => {
    const { record, lease } = current(db, requirementId);
    const plan = readPlanIn(db, requirementId) ?? deny("plan_missing");
    const item = pendingItemsIn({ ...ref, db, record, lease }, plan.tasks).find((candidate) => candidate.itemId === itemId && candidate.kind === "adjudicate")
      ?? deny("item_not_pending");
    const task = plan.tasks.find((candidate) => `task:${candidate.taskId}` === itemId)!;
    const lines = [`任务 ${task.key}（${task.role}）目标章节：${task.goalUnitIds.join("、")}`,
      ...task.attempts.map((attempt, index) => `尝试 ${index + 1}：${attempt.turnsUsed}/${attempt.maxTurns} 轮 · 结局 ${attempt.outcome}`),
      `依据：prod r${record.revision}`];
    return { itemId, version: item.version, summary: lines.join("\n").slice(0, 2000) };
  });
}

function parse(references: readonly string[]): { itemId: string; version: string; choice: AdjudicationChoice; maxTurns: number | null } {
  const value = (prefix: string) => {
    const found = references.filter((reference) => reference.startsWith(`${prefix}:`));
    return found.length === 1 ? found[0]!.slice(prefix.length + 1) : null;
  };
  const choice = value("choice") as AdjudicationChoice | null, turns = value("max-turns");
  const itemId = value("item"), version = value("version");
  if (!itemId || !version || !choice || !ADJUDICATION_CHOICES.includes(choice)) deny("decision_shape");
  const maxTurns = turns === null ? null : /^[1-9][0-9]{0,3}$/.test(turns) && Number(turns) <= 1000 ? Number(turns) : deny("decision_shape");
  if ((choice === "retry") !== (maxTurns !== null)) deny("decision_shape");
  return { itemId: itemId!, version: version!, choice: choice!, maxTurns };
}

/**
 * 按已登记的用户短决定让待裁决任务生效。只认可信内核写入、由真实输入回执确认的用户决定，且须绑定当前需求版本与事项版本；
 * 调用方给出的只是决定 ID，选项与轮数一律从持久记录读取。
 */
export function applyAdjudication(ref: Ref, input: { requirementId: string; decisionId: string; now?: number }): TaskRecord {
  return withDatabase(repositoryDatabase(ref.dataRoot, ref.repoId), (db) => db.transaction(() => {
    const { record, version } = current(db, input.requirementId);
    const stored = db.read<unknown>("short_decisions", input.decisionId) ?? deny("decision_missing");
    const decision = checkDecisionRecord(stored.data);
    if (decision.decisionId !== input.decisionId || decision.requirementId !== input.requirementId || decision.repoId !== ref.repoId ||
      decision.actor !== "user" || decision.status !== "confirmed" || decision.basisReceiptId === null ||
      decision.requirementVersion !== version || decision.epoch !== record.epoch) deny("decision_not_current");
    const parsed = parse(decision.references);
    const taskId = /^task:([0-9a-f-]{36})$/.exec(parsed.itemId)?.[1] ?? deny("decision_shape");
    const row = db.read<TaskRecord>(TASKS, taskId!) ?? deny("task_missing");
    const task = row.data;
    if (task.requirementId !== input.requirementId || task.status !== "awaiting_user" || parsed.version !== `task:${taskId}:${row.version}`) deny("item_changed");
    const userDecision: UserDecision = { decisionId: input.decisionId, choice: parsed.choice, maxTurns: parsed.maxTurns, revision: record.revision,
      taskVersion: task.version, usedByRunId: null, notified: false, confirmedPlan: confirmedPlanKey(readPlanIn(db, input.requirementId)?.plan) };
    const status = parsed.choice === "retry" ? "pending" : parsed.choice === "adjust" ? "needs_update" : "cancelled";
    const next = { ...task, status, userDecision, updatedAt: input.now ?? Date.now() } as TaskRecord;
    db.update(TASKS, taskId!, row.version, next);
    return next;
  }));
}

/** 取出尚未告知 PM 的用户决定并标记已告知；只返回固定文字，不含正文。 */
export function takeUnnotifiedDecisions(ref: Ref, requirementId: string): string[] {
  return withDatabase(repositoryDatabase(ref.dataRoot, ref.repoId), (db) => db.transaction(() => {
    const plan = readPlanIn(db, requirementId);
    const messages: string[] = [];
    for (const task of plan?.tasks ?? []) {
      const decision = task.userDecision;
      if (!decision || decision.notified) continue;
      const row = db.read<TaskRecord>(TASKS, task.taskId)!;
      db.update(TASKS, task.taskId, row.version, { ...row.data, userDecision: { ...decision, notified: true } });
      messages.push(decision.choice === "retry"
        ? `用户决定：任务 ${task.key} 再给一次机会，轮数上限 ${decision.maxTurns}。可用 agent_manage dispatch 直接派出，不带 retry；这次不占你的重试机会。`
        : decision.choice === "adjust"
          ? `用户决定：任务 ${task.key} 调整目标或范围。等用户批准新的 prod 版本后，复核并按新范围修改该任务，修改后可再派出一次。`
          : `用户决定：终止任务 ${task.key}，任务已取消，整个需求暂停，等用户调整需求或取消需求。恢复后先复核新批准版本的差异，确认基于新版本的计划后才能派子代理；此前暂停的子代理由你决定恢复或停止。`);
    }
    return messages;
  }));
}

