import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { appendLine, readLinesLenient } from "../runtime/store.ts";

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
  | { type: "corrupt_skipped"; count: number }
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

interface AskResolver {
  resolve(outcome: RelayAskOutcome): void;
  reject(error: unknown): void;
}

export class RelayQueue {
  private readonly deliver: RelayDeliverFn;
  private readonly locateRequirementAgent: RelayLocateRequirementAgentFn;
  private readonly clock: RelayClock;
  private readonly questionsPath: string;
  private readonly noticesPath: string;
  private readonly questions = new Map<string, RelayQuestion>();
  private readonly notices = new Map<string, RelayNotice>();
  private readonly pendingResolvers = new Map<string, AskResolver>();
  private readonly listeners = new Set<RelayListener>();
  private readonly pendingReplayListeners = new Set<RelayListener>();
  private loaded = false;
  private loadPromise: Promise<void> | null = null;
  private corruptSkippedAtLoad = 0;

  constructor(options: RelayQueueOptions) {
    this.deliver = options.deliver;
    this.locateRequirementAgent = options.locateRequirementAgent;
    this.clock = options.clock ?? { now: () => new Date().toISOString() };
    const relayDir = join(options.dataDir, "relay");
    this.questionsPath = join(relayDir, "questions.jsonl");
    this.noticesPath = join(relayDir, "notices.jsonl");
    this.loadPromise = this.attemptLoad();
  }

  private attemptLoad(): Promise<void> {
    return this.load().then(
      () => {
        this.loaded = true;
        // 加载失败期间订阅的监听器不随失败分支丢弃，等到某次加载成功时统一补发一次
        const waiting = Array.from(this.pendingReplayListeners);
        this.pendingReplayListeners.clear();
        for (const listener of waiting) this.replayCorruptSkipped(listener);
      },
      (error) => {
        // 瞬时故障（如目录锁被存活进程持有）不永久缓存失败，下一次调用重新尝试
        this.loadPromise = null;
        throw error;
      },
    );
  }

  private async load(): Promise<void> {
    // questions.jsonl 与 notices.jsonl 同目录，并发读取会在 store 的目录锁上自我争抢；
    // 两个文件互不依赖，顺序读取即可避免这次自我争抢带来的重试延迟。
    const questionsResult = await readLinesLenient(this.questionsPath);
    const noticesResult = await readLinesLenient(this.noticesPath);
    for (const record of questionsResult.records) {
      const question = record as RelayQuestion;
      this.questions.set(question.id, question);
    }
    for (const record of noticesResult.records) {
      const notice = record as RelayNotice;
      this.notices.set(notice.id, notice);
    }
    this.corruptSkippedAtLoad = questionsResult.skipped + noticesResult.skipped;
  }

  private async ensureReady(): Promise<void> {
    if (this.loaded) return;
    if (!this.loadPromise) this.loadPromise = this.attemptLoad();
    await this.loadPromise;
  }

  private emit(event: RelayEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // 单个监听器异常不得阻断其它监听器与调用方
      }
    }
  }

  private replayCorruptSkipped(listener: RelayListener): void {
    if (this.corruptSkippedAtLoad === 0 || !this.listeners.has(listener)) return;
    try {
      listener({ type: "corrupt_skipped", count: this.corruptSkippedAtLoad });
    } catch {
      // 单个监听器异常不得阻断调用方
    }
  }

  private async deliverSafe(event: string, payload: Record<string, unknown>, options: RelayDeliverOptions): Promise<string[]> {
    try {
      return await this.deliver(event, payload, options);
    } catch (error) {
      this.emit({
        type: "deliver_failed",
        event,
        repoId: options.repoId,
        reason: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  private settleAskResolved(questionId: string, outcome: RelayAskOutcome): void {
    const resolver = this.pendingResolvers.get(questionId);
    if (!resolver) return;
    this.pendingResolvers.delete(questionId);
    resolver.resolve(outcome);
  }

  private settleAskRejected(questionId: string, error: unknown): void {
    const resolver = this.pendingResolvers.get(questionId);
    if (!resolver) return;
    this.pendingResolvers.delete(questionId);
    resolver.reject(error);
  }

  async ask(input: RelayAskInput): Promise<RelayAskHandle> {
    await this.ensureReady();
    const id = randomUUID();
    const question: RelayQuestion = {
      id,
      requirement: input.requirement,
      repoId: input.repoId,
      runId: input.runId,
      question: input.question,
      options: input.options,
      recommended: input.recommended,
      createdAt: this.clock.now(),
      status: "pending",
    };
    await appendLine(this.questionsPath, question);
    this.questions.set(id, question);
    this.emit({ type: "question_enqueued", question });
    let resolveAnswer!: (outcome: RelayAskOutcome) => void;
    let rejectAnswer!: (error: unknown) => void;
    const answer = new Promise<RelayAskOutcome>((resolve, reject) => {
      resolveAnswer = resolve;
      rejectAnswer = reject;
    });
    // 调用方可能晚于 settle 才附加 .then/.catch；这里先接一个空 catch 占位，
    // 避免 settle 到附加处理器之间的窗口被判定为未处理拒绝。
    answer.catch(() => {});
    this.pendingResolvers.set(id, { resolve: resolveAnswer, reject: rejectAnswer });
    await this.deliverSafe(QUESTION_EVENT, publicQuestion(question) as unknown as Record<string, unknown>, {
      repoId: question.repoId,
    });
    return { id, answer };
  }

  async answer(questionId: string, answerText: string, windowId: string): Promise<RelayAnswerResult> {
    await this.ensureReady();
    const question = this.questions.get(questionId);
    if (!question) return { ok: false, reason: "not_found" };
    if (question.status === "withdrawn") return { ok: false, reason: "withdrawn" };
    if (question.status === "answered") return { ok: false, reason: "already_answered" };
    const answered: RelayQuestion = {
      ...question,
      status: "answered",
      answer: answerText,
      answeredBy: windowId,
      answeredAt: this.clock.now(),
    };
    // 判定与内存抢占同一 tick 完成，中间不让出，并发调用只有先抢到的一个能通过上面的状态判定
    this.questions.set(questionId, answered);
    try {
      await appendLine(this.questionsPath, answered);
    } catch (error) {
      this.questions.set(questionId, question);
      this.settleAskRejected(questionId, error);
      throw error;
    }
    this.settleAskResolved(questionId, { answered: true, answer: answerText });
    this.emit({ type: "question_answered", questionId, answer: answerText });
    await this.deliverSafe(WITHDRAW_EVENT, { questionId }, { repoId: question.repoId, excludeWindowId: windowId });
    return { ok: true };
  }

  async notify(input: RelayNotifyInput): Promise<{ id: string }> {
    await this.ensureReady();
    const id = randomUUID();
    const notice: RelayNotice = {
      id,
      requirement: input.requirement,
      repoId: input.repoId,
      runId: input.runId,
      kind: input.kind,
      message: input.message,
      createdAt: this.clock.now(),
      deliveredTo: [],
    };
    await appendLine(this.noticesPath, notice);
    this.notices.set(id, notice);
    this.emit({ type: "notice_enqueued", notice });
    const delivered = await this.deliverSafe(NOTICE_EVENT, publicNotice(notice) as unknown as Record<string, unknown>, {
      repoId: notice.repoId,
    });
    if (delivered.length > 0) {
      const settled: RelayNotice = { ...notice, deliveredTo: delivered };
      await appendLine(this.noticesPath, settled);
      this.notices.set(id, settled);
    }
    return { id };
  }

  async pendingFor(window: RelayWindow): Promise<{ questions: RelayPublicQuestion[]; notices: RelayPublicNotice[] }> {
    await this.ensureReady();
    const questions = Array.from(this.questions.values())
      .filter((question) => question.status === "pending" && window.repoIds.includes(question.repoId))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map(publicQuestion);
    const notices = Array.from(this.notices.values())
      .filter((notice) => notice.deliveredTo.length === 0 && window.repoIds.includes(notice.repoId))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map(publicNotice);
    return { questions, notices };
  }

  async markDelivered(windowId: string, noticeId: string): Promise<void> {
    await this.ensureReady();
    const notice = this.notices.get(noticeId);
    if (!notice || notice.deliveredTo.includes(windowId)) return;
    const updated: RelayNotice = { ...notice, deliveredTo: [...notice.deliveredTo, windowId] };
    this.notices.set(noticeId, updated);
    try {
      await appendLine(this.noticesPath, updated);
    } catch (error) {
      // 回滚只撤销本次窗口自己的贡献：并发 ack 下内存可能已被另一方抢占推进，
      // 还原成本次调用前捕获的整条快照会连带抹掉对方已经写入的贡献。
      const current = this.notices.get(noticeId);
      if (current) this.notices.set(noticeId, { ...current, deliveredTo: current.deliveredTo.filter((w) => w !== windowId) });
      throw error;
    }
  }

  async forward(input: RelayForwardInput): Promise<RelayForwardResult> {
    await this.ensureReady();
    const agent = this.locateRequirementAgent(input.requirement);
    if (!agent) return { delivered: false, reason: "not_found" };
    try {
      agent.inject(input.message);
    } catch (error) {
      return { delivered: false, reason: error instanceof Error ? error.message : String(error) };
    }
    return { delivered: true };
  }

  async withdraw(questionId: string): Promise<void> {
    await this.ensureReady();
    const question = this.questions.get(questionId);
    if (!question || question.status !== "pending") return;
    const withdrawn: RelayQuestion = { ...question, status: "withdrawn" };
    this.questions.set(questionId, withdrawn);
    try {
      await appendLine(this.questionsPath, withdrawn);
    } catch (error) {
      this.questions.set(questionId, question);
      this.settleAskRejected(questionId, error);
      throw error;
    }
    this.settleAskResolved(questionId, { answered: false, reason: "withdrawn" });
    this.emit({ type: "question_withdrawn", questionId });
    await this.deliverSafe(WITHDRAW_EVENT, { questionId }, { repoId: question.repoId });
  }

  subscribe(listener: RelayListener): () => void {
    this.listeners.add(listener);
    if (this.loaded) {
      this.replayCorruptSkipped(listener);
    } else {
      this.pendingReplayListeners.add(listener);
    }
    return () => {
      this.listeners.delete(listener);
      this.pendingReplayListeners.delete(listener);
    };
  }
}
