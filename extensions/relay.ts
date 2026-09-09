import { randomUUID } from "node:crypto";
import type { ExtensionAPI, MessageRenderer } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { DaemonClient, WorkspaceClientsHandle } from "../runtime/daemon-client.ts";
import { windowReady as defaultWindowReady } from "./lifecycle.ts";
import type { WindowContextValue } from "./lifecycle.ts";

const CUSTOM_TYPE = "pi-company-relay";
const MAX_RELAY_TEXT_LENGTH = 8000;
const REALTIME_SKIP_THROTTLE_MS = 60_000;

export interface RelayExtensionDeps {
  windowReady?: () => Promise<WindowContextValue>;
}

interface RelayOption {
  label: string;
  description: string;
}

interface RelayQuestionItem {
  id: string;
  requirement: string;
  repoId: string;
  runId: string;
  question: string;
  options: RelayOption[];
  recommended: string;
  createdAt: string;
}

interface RelayNoticeItem {
  id: string;
  requirement: string;
  repoId: string;
  runId: string;
  kind: string;
  message: string;
  createdAt: string;
}

const seenIdsBySession = new Map<string, Set<string>>();
const withdrawnIdsBySession = new Map<string, Set<string>>();
const lastRealtimeSkipAtBySession = new Map<string, number>();
const pendingRealtimeSkipCountBySession = new Map<string, number>();

function sessionSet(store: Map<string, Set<string>>, sessionId: string): Set<string> {
  let set = store.get(sessionId);
  if (!set) {
    set = new Set();
    store.set(sessionId, set);
  }
  return set;
}

function clearSessionState(sessionId: string): void {
  seenIdsBySession.delete(sessionId);
  withdrawnIdsBySession.delete(sessionId);
  lastRealtimeSkipAtBySession.delete(sessionId);
  pendingRealtimeSkipCountBySession.delete(sessionId);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isValidOption(value: unknown): value is RelayOption {
  if (typeof value !== "object" || value === null) return false;
  const option = value as RelayOption;
  return typeof option.label === "string" && typeof option.description === "string";
}

function asQuestionItem(raw: unknown): RelayQuestionItem | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const item = raw as RelayQuestionItem;
  if (!isNonEmptyString(item.id) || !isNonEmptyString(item.question)) return undefined;
  if (!Array.isArray(item.options) || !item.options.every(isValidOption)) return undefined;
  if (typeof item.recommended !== "string" || typeof item.createdAt !== "string") return undefined;
  return item;
}

function asNoticeItem(raw: unknown): RelayNoticeItem | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const item = raw as RelayNoticeItem;
  if (!isNonEmptyString(item.id) || !isNonEmptyString(item.message)) return undefined;
  if (typeof item.kind !== "string" || typeof item.createdAt !== "string") return undefined;
  return item;
}

const OSC_SEQUENCE = /\x1B\][\s\S]*?(?:\x07|\x1B\\)/g;
const CSI_SEQUENCE = /\x1B\[[0-?]*[ -/]*[@-~]/g;
const FE_SEQUENCE = /\x1B[@-_]/g;
const C0_C1_CONTROLS = /[\x00-\x09\x0B-\x1F\x7F-\x9F]/g;
const BIDI_AND_ZERO_WIDTH = /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;

function truncateByCodepoint(text: string, maxLength: number): string {
  const codepoints = Array.from(text);
  return codepoints.length > maxLength ? codepoints.slice(0, maxLength).join("") : text;
}

function sanitizeRelayText(input: string): string {
  // OSC 必须先于通用 ESC 清理处理：其终止符可以是 BEL（\x07），
  // 若先跑通用控制字符清理会把 BEL 提前吃掉，导致 OSC 序列的其余部分被当成普通文本保留
  const withoutOsc = input.replace(OSC_SEQUENCE, "");
  const withoutCsi = withoutOsc.replace(CSI_SEQUENCE, "");
  const withoutFe = withoutCsi.replace(FE_SEQUENCE, "");
  const withoutControls = withoutFe.replace(C0_C1_CONTROLS, "");
  const withoutBidi = withoutControls.replace(BIDI_AND_ZERO_WIDTH, "");
  // 按码点而非 UTF-16 code unit 截断，避免把代理对从中间切开
  return truncateByCodepoint(withoutBidi, MAX_RELAY_TEXT_LENGTH);
}

function displayQuestion(item: RelayQuestionItem): { id: string; question: string; options: RelayOption[]; recommended: string } {
  return {
    id: sanitizeRelayText(item.id),
    question: sanitizeRelayText(item.question),
    options: item.options.map((option) => ({
      label: sanitizeRelayText(option.label),
      description: sanitizeRelayText(option.description),
    })),
    recommended: sanitizeRelayText(item.recommended),
  };
}

function displayNotice(item: RelayNoticeItem): { id: string; kind: string; message: string } {
  return {
    id: sanitizeRelayText(item.id),
    kind: sanitizeRelayText(item.kind),
    message: sanitizeRelayText(item.message),
  };
}

function untrustedBlock(sanitizedText: string, nonce: string): string {
  return [`--- 外部文本开始 ${nonce} ---`, sanitizedText, `--- 外部文本结束 ${nonce} ---`].join("\n");
}

function questionText(display: { id: string; question: string; options: RelayOption[]; recommended: string }, nonce: string): string {
  const lines = [`[Relay] 待答问题`, untrustedBlock(display.question, nonce)];
  if (display.options.length > 0) {
    lines.push(
      `选项: ${display.options.map((option) => (option.description ? `${option.label}：${option.description}` : option.label)).join("、")}`,
    );
  }
  if (display.recommended) lines.push(`推荐: ${display.recommended}`);
  lines.push(`问题标识: ${display.id}`);
  lines.push(`请回答以上问题`);
  return lines.join("\n");
}

function noticeText(display: { id: string; kind: string; message: string }, nonce: string): string {
  return [`[Relay] 通知（${display.kind}）`, untrustedBlock(display.message, nonce), `通知标识: ${display.id}`].join("\n");
}

function withdrawText(displayQuestionId: string): string {
  return [`[Relay] 撤回`, `该问题已在其他窗口作答`, `问题标识: ${displayQuestionId}`].join("\n");
}

function admitQuestion(pi: ExtensionAPI, item: RelayQuestionItem, seenIds: Set<string>, withdrawnIds: Set<string>): void {
  if (seenIds.has(item.id) || withdrawnIds.has(item.id)) return;
  seenIds.add(item.id);
  const nonce = randomUUID();
  pi.sendMessage(
    { customType: CUSTOM_TYPE, content: questionText(displayQuestion(item), nonce), display: true, details: { ...item, kind: "question" } },
    { deliverAs: "steer", triggerTurn: true },
  );
}

function admitNotice(pi: ExtensionAPI, item: RelayNoticeItem, seenIds: Set<string>): void {
  if (seenIds.has(item.id)) return;
  seenIds.add(item.id);
  const nonce = randomUUID();
  pi.sendMessage(
    { customType: CUSTOM_TYPE, content: noticeText(displayNotice(item), nonce), display: false, details: { ...item, kind: "notice" } },
    { deliverAs: "steer", triggerTurn: true },
  );
}

function admitWithdraw(pi: ExtensionAPI, data: unknown, seenIds: Set<string>, withdrawnIds: Set<string>): void {
  // 身份判定用载荷原始 questionId（不净化），避免净化后不同来源的 id 被误判为同一身份
  const questionId = (data as { questionId?: unknown } | null)?.questionId;
  if (!isNonEmptyString(questionId) || withdrawnIds.has(questionId)) return;
  withdrawnIds.add(questionId);
  if (!seenIds.has(questionId)) return;
  pi.sendMessage(
    { customType: CUSTOM_TYPE, content: withdrawText(sanitizeRelayText(questionId)), display: true, details: { questionId, kind: "withdrawn" } },
    { deliverAs: "steer", triggerTurn: true },
  );
}

async function fetchPending(client: DaemonClient): Promise<Record<string, unknown> | undefined> {
  try {
    return await client.call("relay.pending");
  } catch {
    return undefined;
  }
}

interface BacklogEntry {
  createdAt: string;
  inject: () => void;
}

async function injectSortedBacklog(
  pi: ExtensionAPI,
  clients: WorkspaceClientsHandle,
  seenIds: Set<string>,
  withdrawnIds: Set<string>,
): Promise<number> {
  const results = await Promise.all(clients.all().map(fetchPending));
  const entries: BacklogEntry[] = [];
  let skipped = 0;

  for (const result of results) {
    if (!result) continue;
    if (Array.isArray(result.questions)) {
      for (const raw of result.questions) {
        const item = asQuestionItem(raw);
        if (item) entries.push({ createdAt: item.createdAt, inject: () => admitQuestion(pi, item, seenIds, withdrawnIds) });
        else skipped += 1;
      }
    } else {
      skipped += 1;
    }
    if (Array.isArray(result.notices)) {
      for (const raw of result.notices) {
        const item = asNoticeItem(raw);
        if (item) entries.push({ createdAt: item.createdAt, inject: () => admitNotice(pi, item, seenIds) });
        else skipped += 1;
      }
    } else {
      skipped += 1;
    }
  }

  entries.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const entry of entries) {
    try {
      entry.inject();
    } catch {
      skipped += 1;
    }
  }

  return skipped;
}

export async function registerRelayInbox(
  pi: ExtensionAPI,
  clients: WorkspaceClientsHandle,
  sessionId: string,
  onSkipped?: (count: number) => void,
  options: { now?: () => number } = {},
): Promise<() => void> {
  const nowFn = options.now ?? Date.now;
  const seenIds = sessionSet(seenIdsBySession, sessionId);
  const withdrawnIds = sessionSet(withdrawnIdsBySession, sessionId);
  const unsubscribes: Array<() => void> = [];
  // 积压拉取期间到达的实时事件先缓冲，拉取完成后再按到达顺序冲刷，
  // 保证「积压先于加载期实时事件」这一顺序，而不按各自的 createdAt 重新排序
  const buffered: Array<() => void> = [];
  let loaded = false;

  // 节流的是回调频率而非计数：窗口内被压下的条目先累加，等窗口过去后下一条
  // 到达时把累计总数一次性报出，避免频繁畸形事件刷屏又不丢失发生过的次数
  const reportRealtimeSkip = (): void => {
    if (!onSkipped) return;
    const now = nowFn();
    const last = lastRealtimeSkipAtBySession.get(sessionId);
    const pending = pendingRealtimeSkipCountBySession.get(sessionId) ?? 0;
    if (last !== undefined && now - last < REALTIME_SKIP_THROTTLE_MS) {
      pendingRealtimeSkipCountBySession.set(sessionId, pending + 1);
      return;
    }
    lastRealtimeSkipAtBySession.set(sessionId, now);
    pendingRealtimeSkipCountBySession.set(sessionId, 0);
    onSkipped(pending + 1);
  };

  const runOrBuffer = (run: () => void): void => {
    if (!loaded) {
      buffered.push(run);
      return;
    }
    try {
      run();
    } catch {
      // 单条实时事件处理异常不应影响其它事件
    }
  };

  for (const client of clients.all()) {
    unsubscribes.push(
      client.subscribe("relay.question", (data) => {
        const item = asQuestionItem(data);
        if (item) runOrBuffer(() => admitQuestion(pi, item, seenIds, withdrawnIds));
        else reportRealtimeSkip();
      }),
    );
    unsubscribes.push(
      client.subscribe("relay.notice", (data) => {
        const item = asNoticeItem(data);
        if (item) runOrBuffer(() => admitNotice(pi, item, seenIds));
        else reportRealtimeSkip();
      }),
    );
    unsubscribes.push(
      client.subscribe("relay.withdraw", (data) => {
        runOrBuffer(() => admitWithdraw(pi, data, seenIds, withdrawnIds));
      }),
    );
  }

  let skippedCount = 0;
  try {
    skippedCount = await injectSortedBacklog(pi, clients, seenIds, withdrawnIds);
  } catch {
    // 保证即使积压处理出现未预料的异常，取消函数也一定被返回
  } finally {
    loaded = true;
    for (const run of buffered) {
      try {
        run();
      } catch {
        // 单条缓冲事件处理异常不应影响后续缓冲事件
      }
    }
  }

  if (skippedCount > 0) onSkipped?.(skippedCount);

  return () => {
    for (const unsubscribe of unsubscribes) unsubscribe();
  };
}

const renderRelayMessage: MessageRenderer = (message) => {
  return new Text(typeof message.content === "string" ? message.content : "");
};

export default function relayExtension(pi: ExtensionAPI, deps: RelayExtensionDeps = {}): void {
  const resolveWindowReady = deps.windowReady ?? defaultWindowReady;

  pi.registerMessageRenderer(CUSTOM_TYPE, renderRelayMessage);

  let pendingCancel: Promise<() => void> | undefined;
  let currentSessionId: string | undefined;
  // windowReady/registerRelayInbox 都可能晚于 shutdown、甚至晚于再下一次 session_start 才兑现；
  // 用世代号而非布尔标志，才能让「快速 start→shutdown→start」里第一代的迟到兑现
  // 识别出自己已经不是当前这一代，而不会被第二次 start 重置的标志误放行
  let generation = 0;

  pi.on("session_start", (_event, ctx) => {
    const myGeneration = ++generation;
    void resolveWindowReady().then(
      (ready) => {
        if (myGeneration !== generation) return;
        currentSessionId = ready.sessionId;
        pendingCancel = registerRelayInbox(pi, ready.clients, ready.sessionId, (count) => {
          if (myGeneration !== generation) return;
          ctx.ui.notify(`已跳过 ${count} 条异常中继载荷`, "warning");
        });
      },
      (error: Error) => {
        if (myGeneration !== generation) return;
        ctx.ui.notify(error.message, "error");
      },
    );
  });

  pi.on("session_shutdown", (event) => {
    generation++;
    // 不 await：registerRelayInbox 若还没兑现，取消动作挂到它自己的 Promise 上稍后执行，
    // 不能让 session_shutdown 处理器被一次挂起的 relay.pending 拖住
    pendingCancel?.then((cancel) => cancel(), () => {});
    pendingCancel = undefined;
    if (event.reason !== "reload") {
      if (currentSessionId) clearSessionState(currentSessionId);
      currentSessionId = undefined;
    }
  });
}
