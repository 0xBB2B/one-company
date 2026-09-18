import { withDatabase, uuidv7, databaseFile } from "../runtime/database.ts";
import { LEGACY_WORKFLOW_RETIRED } from "../runtime/decision-record-tool.ts";

export interface RelayWindow { windowId: string; repoIds: string[] }
export interface RelayDeliverOptions { repoId: string; excludeWindowId?: string }
export type RelayDeliverFn = (event: string, payload: Record<string, unknown>, options: RelayDeliverOptions) => Promise<string[]>;
export interface RelayRequirementAgent { inject(message: string): void }
export type RelayLocateRequirementAgentFn = (requirement: string) => RelayRequirementAgent | undefined;
export interface RelayClock { now(): string }
export interface RelayOption { label: string; description: string }
export type RelayQuestionStatus = "pending" | "answered" | "withdrawn";
export interface RelayQuestion {
  kind?: "question" | "contract_change"; id: string; requirement: string; repoId: string; runId: string;
  question: string; options: RelayOption[]; recommended: string; createdAt: string; status: RelayQuestionStatus;
  answer?: string; answeredBy?: string; answeredAt?: string;
}
export type RelayPublicQuestion = Omit<RelayQuestion, "status" | "answer" | "answeredBy" | "answeredAt">;
export type RelayNoticeKind = "completed" | "blocked" | "auto_resumed" | "stopped" | "interrupted" | "contract_change";
export interface RelayNotice { id: string; requirement: string; repoId: string; runId: string; kind: RelayNoticeKind; message: string; createdAt: string; deliveredTo: string[] }
export type RelayPublicNotice = Omit<RelayNotice, "deliveredTo">;
export interface RelayAskInput { kind?: "question" | "contract_change"; requirement: string; repoId: string; runId: string; question: string; options: RelayOption[]; recommended: string }
export interface RelayNotifyInput { requirement: string; repoId: string; runId: string; kind: RelayNoticeKind; message: string }
export interface RelayForwardInput { requirement: string; message: string }
export type RelayAskOutcome = { answered: true; answer: string } | { answered: false; reason: "withdrawn" };
export interface RelayAskHandle { id: string; answer: Promise<RelayAskOutcome> }
export type RelayAnswerResult = { ok: true } | { ok: false; reason: "not_found" | "already_answered" | "withdrawn" | "legacy_workflow_retired" };
export type RelayForwardResult = { delivered: true } | { delivered: false; reason: string };
export type RelayEvent =
  | { type: "question_enqueued"; question: RelayQuestion }
  | { type: "question_answered"; questionId: string; answer: string }
  | { type: "question_withdrawn"; questionId: string }
  | { type: "notice_enqueued"; notice: RelayNotice }
  | { type: "deliver_failed"; event: string; repoId: string; reason: string };
export type RelayListener = (event: RelayEvent) => void;
export interface RelayQueueOptions { dataDir: string; deliver: RelayDeliverFn; locateRequirementAgent: RelayLocateRequirementAgentFn; clock?: RelayClock }

/** 只发送固定运行状态通知；不恢复旧问题、旧正文或字符串授权链。 */
export class RelayQueue {
  private readonly database: string;
  private readonly deliver: RelayDeliverFn;
  private readonly clock: RelayClock;
  private readonly listeners = new Set<RelayListener>();
  constructor(options: RelayQueueOptions) {
    this.database = databaseFile(options.dataDir, "data");
    this.deliver = options.deliver;
    this.clock = options.clock ?? { now: () => new Date().toISOString() };
  }
  private emit(event: RelayEvent): void { for (const listener of this.listeners) { try { listener(event); } catch {} } }
  async ask(_input: RelayAskInput): Promise<RelayAskHandle> { throw new Error(LEGACY_WORKFLOW_RETIRED); }
  async answer(_questionId: string, _answerText: string, _windowId: string): Promise<RelayAnswerResult> { return { ok: false, reason: "legacy_workflow_retired" }; }
  async forward(_input: RelayForwardInput): Promise<RelayForwardResult> { return { delivered: false, reason: LEGACY_WORKFLOW_RETIRED }; }
  async pendingFor(_window: RelayWindow): Promise<{ questions: RelayPublicQuestion[]; notices: RelayPublicNotice[] }> { return { questions: [], notices: [] }; }
  async notify(input: RelayNotifyInput): Promise<{ id: string }> {
    if (!["stopped", "blocked", "interrupted"].includes(input.kind)) throw new Error(LEGACY_WORKFLOW_RETIRED);
    const id = uuidv7();
    const notice: RelayNotice = { id, requirement: input.requirement, repoId: input.repoId, runId: input.runId, kind: input.kind,
      message: "运行状态发生变化，请查询状态元数据；通知不表示进程已停止或需求已完成", createdAt: this.clock.now(), deliveredTo: [] };
    withDatabase(this.database, (db) => db.transaction(() => {
      const event = db.append("relay", { kind: "notice", id });
      db.create("relay_notices", id, { ...notice, sequence: event.sequence }, id);
    }));
    this.emit({ type: "notice_enqueued", notice });
    try {
      const { deliveredTo: _deliveredTo, ...payload } = notice;
      const delivered = await this.deliver("relay.notice", payload, { repoId: notice.repoId });
      for (const windowId of delivered) await this.markDelivered(windowId, id);
    } catch { this.emit({ type: "deliver_failed", event: "relay.notice", repoId: notice.repoId, reason: "状态通知投递失败" }); }
    return { id };
  }
  async markDelivered(windowId: string, noticeId: string): Promise<void> {
    withDatabase(this.database, (db) => db.transaction(() => {
      const record = db.read<RelayNotice>("relay_notices", noticeId);
      if (!record || record.data.deliveredTo.includes(windowId)) return;
      db.update("relay_notices", noticeId, record.version, { ...record.data, deliveredTo: [...record.data.deliveredTo, windowId] });
    }));
  }
  /** 撤回只撤销旧问题，不接受答复、不投递问题正文。 */
  async withdraw(questionId: string): Promise<void> {
    withDatabase(this.database, (db) => db.transaction(() => {
      const record = db.read<RelayQuestion>("relay_questions", questionId);
      if (!record || record.data.status !== "pending") return;
      db.update("relay_questions", questionId, record.version, { ...record.data, status: "withdrawn" });
    }));
  }
  subscribe(listener: RelayListener): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
}
