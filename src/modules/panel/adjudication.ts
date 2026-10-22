import { repositoryDatabase, withDatabase } from "../../core/storage/database.ts";
import type { FailureAdvice } from "../../core/exec/tool-failure.ts";
import type { LocalDatabase } from "../../core/storage/database.ts";
import { reviewRoundOpen } from "../pm/task-dispatch.ts";
import { currentEscalation, confirmedPlanKey, latestRound, readPlanIn, REVIEW_UNFINISHED, reviewFailures, stalledStage, TASKS, terminationPending, unsentTask } from "../pm/plan-manage.ts";
import type { TaskRecord, UserDecision } from "../pm/plan-manage.ts";
import { namesIn, pendingItemsIn, reviewLine, unfinishedReviewers } from "./pm-overview.ts";
import { checked } from "../requirement/requirement-contracts.ts";
import type { PmLease, RequirementRecord } from "../requirement/requirement-contracts.ts";
import { checkDecisionRecord } from "../requirement/short-decision-format.ts";
import type { AdjudicationChoice, AdjudicationSubject } from "../requirement/user-interaction-format.ts";
import { ADJUDICATION_CHOICES } from "../requirement/user-interaction-format.ts";
import { COMPLETION_REPORTS, CompletionReport, decideReportIn, pendingReportIn, reportsIn } from "../delivery/workflow-close.ts";

const ADJUDICATION_ADVICE = {
  unknown_requirement: { why: "找不到这个需求", next: "核对需求编号" },
  pm_missing: { why: "这个需求当前没有 PM，待裁决事项无从交回", next: "先派出 PM，再登记用户决定" },
  requirement_not_active: { why: "需求不在活动状态", next: "重新读取需求状态后再决定" },
  item_not_pending: { why: "这个事项已不在待裁决列表里", next: "重新读取待裁决事项，按当前列表登记" },
  plan_missing: { why: "需求还没有计划", next: "等 PM 提出计划后再登记任务决定" },
  decision_shape: { why: "决定的引用格式不对，事项、版本或选项无法识别", next: "按待裁决事项给出的引用原样登记" },
  decision_missing: { why: "找不到这个决定编号对应的用户决定", next: "核对决定编号，或先按用户原话登记决定" },
  decision_not_current: { why: "这个决定不是用户对本需求当前版本确认过的有效决定", next: "按用户最新原话重新登记决定" },
  item_changed: { why: "事项在用户做决定后已变化，或选项与事项不符", next: "重新读取待裁决事项，请用户按当前情况重新决定" },
  task_missing: { why: "找不到决定所指的任务", next: "重新读取待裁决事项" },
} as const satisfies Record<string, FailureAdvice>;
type AdjudicationErrorCode = keyof typeof ADJUDICATION_ADVICE;
export class AdjudicationError extends Error {
  readonly code: AdjudicationErrorCode;
  readonly advice: FailureAdvice;
  constructor(code: AdjudicationErrorCode) { super(`adjudication_denied:${code}`); this.name = "AdjudicationError"; this.code = code; this.advice = ADJUDICATION_ADVICE[code]; }
}
const deny = (code: AdjudicationErrorCode): never => { throw new AdjudicationError(code); };

type Ref = { dataRoot: string; repoId: string };

function current(db: LocalDatabase, requirementId: string): { record: RequirementRecord; version: number; lease: PmLease } {
  const row = db.read<RequirementRecord>("requirements", requirementId) ?? deny("unknown_requirement");
  const lease = db.read<{ lease?: PmLease | null }>("pm_ownership", requirementId)?.data.lease ?? deny("pm_missing");
  if (row.data.lifecycle !== "active") deny("requirement_not_active");
  return { record: row.data, version: row.version, lease };
}

/**
 * 给解释器的事项摘要只含程序记录的内容；PM 与子代理写的文字不进入解释用户原话的上下文。
 * 任务事项须当前正待用户裁决；需求事项绑定当前需求记录版本，可随时取消或拒绝；报告事项须仍待验收。
 */
export function adjudicationSubject(ref: Ref, requirementId: string, itemId: string): AdjudicationSubject {
  return withDatabase(repositoryDatabase(ref.dataRoot, ref.repoId), (db) => {
    const { record, version, lease } = current(db, requirementId);
    const plan = readPlanIn(db, requirementId);
    if (itemId === `requirement:${requirementId}`) {
      const halted = terminationPending(plan?.tasks ?? [], record.revision);
      return { itemId, version: `requirement:${requirementId}:${version}`, summary: [`需求 ${requirementId} · 当前批准版本 r${record.revision}`,
        halted ? "已有任务被用户终止，需求正暂停等待调整或取消" : "需求正在进行", "可选：取消（不再需要）或拒绝（需求本身不成立或做不了）"].join("\n") };
    }
    if (itemId.startsWith("report:")) {
      const item = pendingItemsIn({ ...ref, db, record, lease }, plan?.tasks ?? []).find((candidate) => candidate.itemId === itemId && candidate.kind === "acceptance")
        ?? deny("item_not_pending");
      const report = checked(CompletionReport, db.read<unknown>(COMPLETION_REPORTS, itemId.slice("report:".length))!.data);
      return { itemId, version: item.version, summary: [`需求 ${requirementId} · 当前批准版本 r${record.revision}`, "PM 提交了完成报告，等待用户验收",
        `检查轮 ${report.basis.checkRoundId ?? "无"} · 正式验证 ${report.basis.verificationIds.length} 项 · 裁决 ${report.basis.verdictIds.length} 项 · 分支提交 ${report.commits.length} 个`,
        "可选：accept 验收通过（随后以完成关闭需求）；rework 返工（意见交回 PM）"].join("\n") };
    }
    if (!plan) deny("plan_missing");
    const item = pendingItemsIn({ ...ref, db, record, lease }, plan!.tasks).find((candidate) => candidate.itemId === itemId && candidate.kind === "adjudicate")
      ?? deny("item_not_pending");
    const task = plan!.tasks.find((candidate) => `task:${candidate.taskId}` === itemId)!;
    const lines = [`任务 ${task.key}（${task.role}）目标章节：${task.goalUnitIds.join("、")}`,
      ...(task.sizeHold && unsentTask(task) ? [`拆分上限：${task.sizeHold.join("；")}`] : []),
      ...task.attempts.map((attempt, index) => `${attempt.rework ? "返修" : "尝试"} ${index + 1}：${attempt.turnsUsed}/${attempt.maxTurns} 轮 · 结局 ${attempt.outcome}${attempt.escalation ? " · PM 已上报" : ""}`),
      ...task.reviews.map(reviewLine),
      ...(currentEscalation(task) ? ["PM 已上报（审查中）"] : []),
      `依据：PRD r${record.revision}`];
    return { itemId, version: item.version, summary: lines.join("\n").slice(0, 2000) };
  });
}

/** 裁决确认窗口里显示的事项名：面板上那一行的文字；取消或拒绝整个需求不对应面板的某一行。 */
export function adjudicationItemLabel(ref: Ref, requirementId: string, itemId: string): string {
  if (itemId === `requirement:${requirementId}`) return "取消或拒绝整个需求";
  return withDatabase(repositoryDatabase(ref.dataRoot, ref.repoId), (db) => {
    const { record, lease } = current(db, requirementId);
    const item = pendingItemsIn({ ...ref, db, record, lease }, readPlanIn(db, requirementId)?.tasks ?? []).find((candidate) => candidate.itemId === itemId);
    return item?.label ?? deny("item_not_pending");
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

/** 只认可信内核写入、由真实输入回执确认、属于该需求的用户短决定。 */
function userDecisionIn(db: LocalDatabase, ref: Ref, requirementId: string, decisionId: string) {
  const stored = db.read<unknown>("short_decisions", decisionId) ?? deny("decision_missing");
  const decision = checkDecisionRecord(stored.data);
  if (decision.decisionId !== decisionId || decision.requirementId !== requirementId || decision.repoId !== ref.repoId ||
    decision.actor !== "user" || decision.status !== "confirmed" || decision.basisReceiptId === null) deny("decision_not_current");
  return { decision, parsed: parse(decision.references) };
}

export type AdjudicationEffect = { kind: "task"; task: TaskRecord } | { kind: "requirement"; choice: "cancel" | "reject" } | { kind: "report"; choice: "accept" | "rework" };

/**
 * 按已登记的用户短决定生效。调用方给出的只是决定 ID，选项与轮数一律从持久记录读取，且须绑定当前需求版本与事项版本。
 * 任务决定改写任务状态；取消/拒绝需求只核对，由主代理随后以该决定关闭需求；报告决定改写报告状态，通过后由主代理以该决定完成关闭。
 */
export function applyAdjudication(ref: Ref, input: { requirementId: string; decisionId: string; now?: number }): AdjudicationEffect {
  return withDatabase(repositoryDatabase(ref.dataRoot, ref.repoId), (db) => db.transaction(() => {
    const { record, version } = current(db, input.requirementId);
    const { decision, parsed } = userDecisionIn(db, ref, input.requirementId, input.decisionId);
    if (decision.requirementVersion !== version || decision.epoch !== record.epoch) deny("decision_not_current");
    if (parsed.itemId === `requirement:${input.requirementId}`) {
      if (parsed.version !== `requirement:${input.requirementId}:${version}` || (parsed.choice !== "cancel" && parsed.choice !== "reject")) deny("item_changed");
      return { kind: "requirement" as const, choice: parsed.choice as "cancel" | "reject" };
    }
    if (parsed.itemId.startsWith("report:")) {
      const pending = pendingReportIn(db, ref.repoId, input.requirementId);
      if (!pending || `report:${pending.data.reportId}` !== parsed.itemId || `report:${pending.data.reportId}:${pending.version}` !== parsed.version ||
        (parsed.choice !== "accept" && parsed.choice !== "rework")) deny("item_changed");
      decideReportIn(db, parsed.itemId.slice("report:".length), { decisionId: input.decisionId, choice: parsed.choice as "accept" | "rework", now: input.now ?? Date.now() });
      return { kind: "report" as const, choice: parsed.choice as "accept" | "rework" };
    }
    const taskId = /^task:([0-9a-f-]{36})$/.exec(parsed.itemId)?.[1] ?? deny("decision_shape");
    const row = db.read<TaskRecord>(TASKS, taskId!) ?? deny("task_missing");
    const task = row.data;
    if (task.requirementId !== input.requirementId || task.status !== "awaiting_user" || parsed.version !== `task:${taskId}:${row.version}` ||
      !["retry", "adjust", "terminate"].includes(parsed.choice)) deny("item_changed");
    const stage = reviewRoundOpen(task) ? "review" : stalledStage(task);
    const round = latestRound(task);
    const exhausted = round.reviews.map((review) => review.agent).filter((agent) => reviewFailures(task.reviews, agent) >= 2);
    const waiting = round.reviews.filter((review) => REVIEW_UNFINISHED.has(review.outcome) && reviewFailures(task.reviews, review.agent) < 2).map((review) => review.agent);
    const lastAttempt = task.attempts.at(-1);
    const movedEscalation = stage === "review" ? lastAttempt?.escalation : undefined;
    const escalation = movedEscalation ?? currentEscalation(task);
    const userDecision: UserDecision = { decisionId: input.decisionId, choice: parsed.choice as UserDecision["choice"], maxTurns: parsed.maxTurns,
      revision: record.revision, taskVersion: task.version, usedByRunId: null, notified: false,
      confirmedPlan: confirmedPlanKey(readPlanIn(db, input.requirementId)?.plan), ...(escalation ? { escalation } : {}),
      ...(parsed.choice === "retry" && stage === "review" ? { agents: [...exhausted, ...waiting], extra: exhausted, round: round.round } : {}) };
    // 再给一次机会回到用完机会的那一环
    const retryStatus = stage === "review" && waiting.length ? "reviewing" : ({ execute: "pending", review: "awaiting_review", rework: "awaiting_rework" } as const)[stage];
    const status = parsed.choice === "retry" ? retryStatus : parsed.choice === "adjust" ? "needs_update" : "cancelled";
    const attempts = movedEscalation ? task.attempts.map((attempt) => { if (attempt !== lastAttempt) return attempt; const { escalation: _moved, ...rest } = attempt; return rest; }) : task.attempts;
    const next = { ...task, status, attempts, userDecision, updatedAt: input.now ?? Date.now() } as TaskRecord;
    db.update(TASKS, taskId!, row.version, next);
    return { kind: "task" as const, task: next };
  }));
}

/**
 * 关闭需求的依据：receiptId 须是用户对该需求做出的对应决定——取消或拒绝需求，或验收通过完成报告——且决定时的需求版本仍是当前版本，
 * 或需求已按这一决定进入关闭（关闭本身会改变记录版本）。完成报告绑定的交付依据是否仍当前由关闭协议核对。
 */
/** 关闭依据不成立时返回具体原因，成立时返回 null。 */
export function closeDecisionProblem(ref: Ref, input: { requirementId: string; receiptId: string; reason: "completed" | "cancelled" | "rejected" }): string | null {
  try {
    return withDatabase(repositoryDatabase(ref.dataRoot, ref.repoId), (db) => {
      const row = db.read<RequirementRecord>("requirements", input.requirementId);
      if (!row) return "找不到这个需求";
      const { decision, parsed } = userDecisionIn(db, ref, input.requirementId, input.receiptId);
      if (input.reason === "completed") {
        const report = reportsIn(db, ref.repoId, input.requirementId).find((entry) => `report:${entry.data.reportId}` === parsed.itemId)?.data;
        if (parsed.choice !== "accept") return "这个决定不是验收通过完成报告";
        if (report?.status !== "accepted" || report.decisionId !== input.receiptId) return "完成报告没有按这个决定验收通过";
      } else {
        if (parsed.itemId !== `requirement:${input.requirementId}`) return "这个决定不是针对需求本身的取消或拒绝";
        if (parsed.choice !== (input.reason === "cancelled" ? "cancel" : "reject")) return `这个决定的选项与关闭原因 ${input.reason} 不符`;
        if (parsed.version !== `requirement:${input.requirementId}:${decision.requirementVersion}`) return "这个决定针对的不是做决定时的需求版本";
      }
      // 进入关闭会提升 epoch，续办同一关闭时只核对关闭意图绑定的正是这一决定
      const sameVersion = row.version === decision.requirementVersion && row.data.lifecycle === "active" && decision.epoch === row.data.epoch;
      const closingByIt = row.data.close?.receiptId === input.receiptId && row.data.close.reason === input.reason;
      return sameVersion || closingByIt ? null : "用户做出决定后需求已被改动，这个决定已过期";
    });
  } catch (error) { return error instanceof AdjudicationError ? error.advice.why : `读取用户决定失败：${(error as Error).message}`; }
}

/** 取出尚未告知 PM 的用户决定并标记已告知；只含固定文字与用户返工意见，不含正文。 */
export function takeUnnotifiedDecisions(ref: Ref, requirementId: string): string[] {
  return withDatabase(repositoryDatabase(ref.dataRoot, ref.repoId), (db) => db.transaction(() => {
    const messages: string[] = [];
    for (const row of reportsIn(db, ref.repoId, requirementId)) {
      if (row.data.status !== "rework" || row.data.notified) continue;
      db.update(COMPLETION_REPORTS, row.data.reportId, row.version, checked(CompletionReport, { ...row.data, notified: true }));
      const opinion = db.read<{ conclusion?: string }>("short_decisions", row.data.decisionId!)?.data.conclusion ?? "";
      messages.push(`用户未通过完成报告，要求返工。用户意见：「${opinion}」\n原报告已作废。在本需求内按意见追加返修任务，经任务级审查与新的检查轮后重新提交完成报告；意见超出已批准范围时，说明情况等待用户调整需求。`);
    }
    for (const task of readPlanIn(db, requirementId)?.tasks ?? []) {
      const decision = task.userDecision;
      if (!decision || decision.notified) continue;
      const row = db.read<TaskRecord>(TASKS, task.taskId)!;
      db.update(TASKS, task.taskId, row.version, { ...row.data, userDecision: { ...decision, notified: true } });
      messages.push(decision.choice === "retry"
        ? `用户决定：任务 ${task.key} 再给一次机会，轮数上限 ${decision.maxTurns}。${task.status === "awaiting_rework" ? "可用 agent_manage dispatch 直接派 worker 返修，不带 rework"
          : task.status === "awaiting_review" || task.status === "reviewing" ? `可用 agent_manage dispatch 带 review 再派审查${namesIn(unfinishedReviewers(task))}，轮数按用户决定` : "可用 agent_manage dispatch 直接派出，不带 retry"}；这次不占你的重试机会。`
        : decision.choice === "adjust" && task.sizeHold && unsentTask(task)
          ? `用户决定：任务 ${task.key} 由你拆分或精简（${task.sizeHold.join("；")}）。用 plan_manage update 修改该任务，或取消后另加任务，不需要等新的批准版本；改完仍超出上限会再次交用户裁决。`
        : decision.choice === "adjust" && task.holdNote && unsentTask(task)
          ? `用户决定：任务 ${task.key} 按你上报的问题调整（${task.holdNote}）。用 plan_manage update 修改该任务，或取消后另加任务，不需要等新的批准版本。`
        : decision.choice === "adjust"
          ? `用户决定：任务 ${task.key} 调整目标或范围。等用户批准新的 PRD 版本后，复核并按新范围修改该任务，修改后可再派出一次。`
          : `用户决定：终止任务 ${task.key}，任务已取消，整个需求暂停，等用户调整需求或取消需求。恢复后先复核新批准版本的差异，确认基于新版本的计划后才能派子代理；此前暂停的子代理由你决定恢复或停止。`);
    }
    return messages;
  }));
}

