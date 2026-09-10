import { join } from "node:path";
import { readRecord, withDatabase, uuidv7, UUID_V7_PATTERN } from "../runtime/database.ts";

export interface RelayWindow {
  windowId: string;
  repoIds: string[];
}

export interface RelayDeliverOptions {
  repoId: string;
  excludeWindowId?: string;
}

export type RelayDeliverFn = (
  event: string,
  payload: Record<string, unknown>,
  options: RelayDeliverOptions,
) => Promise<string[]>;

export interface RelayRequirementAgent {
  inject(message: string): void;
}

export type RelayLocateRequirementAgentFn = (requirement: string) => RelayRequirementAgent | undefined;

export interface RelayClock {
  now(): string;
}

export interface RelayOption {
  label: string;
  description: string;
}

export type RelayQuestionStatus = "pending" | "answered" | "withdrawn";

export interface RelayQuestion {
  kind?: "question" | "contract_change";
  id: string;
  requirement: string;
  repoId: string;
  runId: string;
  question: string;
  options: RelayOption[];
  recommended: string;
  createdAt: string;
  status: RelayQuestionStatus;
  answer?: string;
  answeredBy?: string;
  answeredAt?: string;
}

export type RelayPublicQuestion = Omit<RelayQuestion, "status" | "answer" | "answeredBy" | "answeredAt">;

export type RelayNoticeKind = "completed" | "blocked" | "auto_resumed" | "stopped" | "interrupted" | "contract_change";

export interface RelayNotice {
  id: string;
  requirement: string;
  repoId: string;
  runId: string;
  kind: RelayNoticeKind;
  message: string;
  createdAt: string;
  deliveredTo: string[];
}

export type RelayPublicNotice = Omit<RelayNotice, "deliveredTo">;

export interface RelayAskInput {
  kind?: "question" | "contract_change";
  requirement: string;
  repoId: string;
  runId: string;
  question: string;
  options: RelayOption[];
  recommended: string;
}

export interface RelayNotifyInput {
  requirement: string;
  repoId: string;
  runId: string;
  kind: RelayNoticeKind;
  message: string;
}

export interface RelayForwardInput {
  requirement: string;
  message: string;
}

export type RelayAskOutcome = { answered: true; answer: string } | { answered: false; reason: "withdrawn" };

export interface RelayAskHandle {
  id: string;
  answer: Promise<RelayAskOutcome>;
}

export type RelayAnswerResult = { ok: true } | { ok: false; reason: "not_found" | "already_answered" | "withdrawn" };

export type RelayForwardResult = { delivered: true } | { delivered: false; reason: string };

export type RelayEvent =
  | { type: "question_enqueued"; question: RelayQuestion }
  | { type: "question_answered"; questionId: string; answer: string }
  | { type: "question_withdrawn"; questionId: string }
  | { type: "notice_enqueued"; notice: RelayNotice }
  | { type: "deliver_failed"; event: string; repoId: string; reason: string };

export type RelayListener = (event: RelayEvent) => void;

export interface RelayQueueOptions {
  dataDir: string;
  deliver: RelayDeliverFn;
  locateRequirementAgent: RelayLocateRequirementAgentFn;
  clock?: RelayClock;
}

const QUESTION_EVENT = "relay.question";
const NOTICE_EVENT = "relay.notice";
const WITHDRAW_EVENT = "relay.withdraw";

function publicQuestion(question: RelayQuestion): RelayPublicQuestion {
  return {
    id: question.id,
    requirement: question.requirement,
    repoId: question.repoId,
    runId: question.runId,
    question: question.question,
    kind: question.kind ?? "question",
    options: question.options.map((option) => ({ ...option })),
    recommended: question.recommended,
    createdAt: question.createdAt,
  };
}

function publicNotice(notice: RelayNotice): RelayPublicNotice {
  return {
    id: notice.id,
    requirement: notice.requirement,
    repoId: notice.repoId,
    runId: notice.runId,
    kind: notice.kind,
    message: notice.message,
    createdAt: notice.createdAt,
  };
}

function checkedQuestion(value: RelayQuestion & { sequence: number }, id: string): typeof value {
  if (!value || value.id !== id || !UUID_V7_PATTERN.test(id) || !["pending", "answered", "withdrawn"].includes(value.status) ||
    !Number.isSafeInteger(value.sequence) || value.sequence < 1 || typeof value.question !== "string" || !Array.isArray(value.options) ||
    !value.options.every((option) => option && typeof option.label === "string" && typeof option.description === "string") ||
    (value.status === "answered" && ![value.answer, value.answeredBy, value.answeredAt].every((field) => typeof field === "string")) ||
    ![value.requirement, value.repoId, value.runId, value.createdAt, value.recommended].every((field) => typeof field === "string")) throw new Error("中继问题记录无效");
  return value;
}

function checkedNotice(value: RelayNotice & { sequence: number }, id: string): typeof value {
  if (!value || value.id !== id || !UUID_V7_PATTERN.test(id) || !Number.isSafeInteger(value.sequence) || value.sequence < 1 ||
    !Array.isArray(value.deliveredTo) || !value.deliveredTo.every((field) => typeof field === "string") ||
    ![value.requirement, value.repoId, value.runId, value.createdAt, value.message].every((field) => typeof field === "string")) throw new Error("中继通知记录无效");
  return value;
}

interface AskResolver {
  resolve(outcome: RelayAskOutcome): void;
  reject(error: unknown): void;
}

export class RelayQueue {
  private readonly database: string;
  private readonly deliver: RelayDeliverFn;
  private readonly locateRequirementAgent: RelayLocateRequirementAgentFn;
  private readonly clock: RelayClock;
  private readonly pendingResolvers = new Map<string, AskResolver>();
  private pollTimer?: ReturnType<typeof setInterval>;
  private readonly listeners = new Set<RelayListener>();

  constructor(options: RelayQueueOptions) {
    this.database = join(options.dataDir, "data.sqlite");
    this.deliver = options.deliver;
    this.locateRequirementAgent = options.locateRequirementAgent;
    this.clock = options.clock ?? { now: () => new Date().toISOString() };
  }

  private emit(event: RelayEvent): void {
    for (const listener of this.listeners) {
      try { listener(event); } catch {}
    }
  }

  private async deliverSafe(event: string, payload: Record<string, unknown>, options: RelayDeliverOptions): Promise<string[]> {
    try { return await this.deliver(event, payload, options); }
    catch (error) {
      this.emit({ type: "deliver_failed", event, repoId: options.repoId, reason: (error as Error).message });
      return [];
    }
  }

  private pollAnswers(): void {
    for (const [id, waiter] of this.pendingResolvers) {
      try {
        const record = readRecord<RelayQuestion & { sequence: number }>({ database: this.database, namespace: "relay_questions", key: id });
        if (!record.exists) throw new Error("等待中的问题记录不存在");
        const question = checkedQuestion(record.data, id);
        if (question.status === "pending") continue;
        waiter.resolve(question.status === "answered" ? { answered: true, answer: question.answer! } : { answered: false, reason: "withdrawn" });
      } catch (error) { waiter.reject(error); }
      this.pendingResolvers.delete(id);
    }
    if (this.pendingResolvers.size === 0 && this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  async ask(input: RelayAskInput): Promise<RelayAskHandle> {
    const id = uuidv7();
    const question: RelayQuestion = { ...input, id, kind: input.kind ?? "question", options: input.options.map((option) => ({ ...option })), createdAt: this.clock.now(), status: "pending" };
    withDatabase(this.database, (db) => db.transaction(() => {
      const event = db.append("relay", { kind: "question", id });
      db.create("relay_questions", id, { ...question, sequence: event.sequence }, id);
    }));
    let resolveAnswer!: AskResolver["resolve"];
    let rejectAnswer!: AskResolver["reject"];
    const answer = new Promise<RelayAskOutcome>((resolve, reject) => { resolveAnswer = resolve; rejectAnswer = reject; });
    answer.catch(() => {});
    this.pendingResolvers.set(id, { resolve: resolveAnswer, reject: rejectAnswer });
    if (!this.pollTimer) {
      this.pollTimer = setInterval(() => this.pollAnswers(), 250);
      this.pollTimer.unref();
    }
    this.emit({ type: "question_enqueued", question });
    await this.deliverSafe(QUESTION_EVENT, publicQuestion(question) as unknown as Record<string, unknown>, { repoId: question.repoId });
    return { id, answer };
  }

  async answer(questionId: string, answerText: string, windowId: string): Promise<RelayAnswerResult> {
    const result = withDatabase(this.database, (db) => db.transaction(() => {
      const record = db.read<RelayQuestion>("relay_questions", questionId);
      if (!record) return { ok: false as const, reason: "not_found" as const };
      if (record.data.status === "withdrawn") return { ok: false as const, reason: "withdrawn" as const };
      if (record.data.status === "answered") return { ok: false as const, reason: "already_answered" as const };
      if (record.data.status !== "pending") throw new Error("问题状态无效");
      const answered: RelayQuestion = { ...record.data, status: "answered", answer: answerText, answeredBy: windowId, answeredAt: this.clock.now() };
      db.update("relay_questions", questionId, record.version, answered);
      return { ok: true as const, question: answered };
    }));
    if (!result.ok) return result;
    this.pendingResolvers.get(questionId)?.resolve({ answered: true, answer: answerText });
    this.pendingResolvers.delete(questionId);
    this.emit({ type: "question_answered", questionId, answer: answerText });
    await this.deliverSafe(WITHDRAW_EVENT, { questionId }, { repoId: result.question.repoId, excludeWindowId: windowId });
    return { ok: true };
  }

  async notify(input: RelayNotifyInput): Promise<{ id: string }> {
    const id = uuidv7();
    const notice: RelayNotice = { ...input, id, createdAt: this.clock.now(), deliveredTo: [] };
    withDatabase(this.database, (db) => db.transaction(() => {
      const event = db.append("relay", { kind: "notice", id });
      db.create("relay_notices", id, { ...notice, sequence: event.sequence }, id);
    }));
    this.emit({ type: "notice_enqueued", notice });
    const delivered = await this.deliverSafe(NOTICE_EVENT, publicNotice(notice) as unknown as Record<string, unknown>, { repoId: notice.repoId });
    for (const windowId of delivered) await this.markDelivered(windowId, id);
    return { id };
  }

  async pendingFor(window: RelayWindow): Promise<{ questions: RelayPublicQuestion[]; notices: RelayPublicNotice[] }> {
    return withDatabase(this.database, (db) => {
      const questions = db.list<RelayQuestion & { sequence: number }>("relay_questions").map((row) => checkedQuestion(row.data, row.key))
        .filter((question) => question.status === "pending" && window.repoIds.includes(question.repoId))
        .sort((a, b) => a.sequence - b.sequence).map(publicQuestion);
      const notices = db.list<RelayNotice & { sequence: number }>("relay_notices").map((row) => checkedNotice(row.data, row.key))
        .filter((notice) => notice.deliveredTo.length === 0 && window.repoIds.includes(notice.repoId))
        .sort((a, b) => a.sequence - b.sequence).map(publicNotice);
      return { questions, notices };
    });
  }

  async markDelivered(windowId: string, noticeId: string): Promise<void> {
    withDatabase(this.database, (db) => db.transaction(() => {
      const record = db.read<RelayNotice>("relay_notices", noticeId);
      if (!record || record.data.deliveredTo.includes(windowId)) return;
      db.update("relay_notices", noticeId, record.version, { ...record.data, deliveredTo: [...record.data.deliveredTo, windowId] });
    }));
  }

  async forward(input: RelayForwardInput): Promise<RelayForwardResult> {
    const agent = this.locateRequirementAgent(input.requirement);
    if (!agent) return { delivered: false, reason: "not_found" };
    try { agent.inject(input.message); }
    catch (error) { return { delivered: false, reason: (error as Error).message }; }
    return { delivered: true };
  }

  async withdraw(questionId: string): Promise<void> {
    const question = withDatabase(this.database, (db) => db.transaction(() => {
      const record = db.read<RelayQuestion>("relay_questions", questionId);
      if (!record || record.data.status !== "pending") return null;
      db.update("relay_questions", questionId, record.version, { ...record.data, status: "withdrawn" });
      return record.data;
    }));
    if (!question) return;
    this.pendingResolvers.get(questionId)?.resolve({ answered: false, reason: "withdrawn" });
    this.pendingResolvers.delete(questionId);
    this.emit({ type: "question_withdrawn", questionId });
    await this.deliverSafe(WITHDRAW_EVENT, { questionId }, { repoId: question.repoId });
  }

  subscribe(listener: RelayListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
}
