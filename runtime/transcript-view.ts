import { isKeyRelease, matchesKey, sliceByColumn, visibleWidth } from "@earendil-works/pi-tui";
import { readTranscript } from "./session-records.ts";
import type { TranscriptEntry, TranscriptEntryKind } from "./session-records.ts";
import type { Clock, TimerHandle } from "./clock.ts";

const POLL_INTERVAL_MS = 1_000;

// 保留 \n：换行承载分行语义；其余 C0/C1（含 ESC）会破坏渲染宽度计算，需清除
const CONTROL_CHARS = /[\x00-\x09\x0b-\x1f\x7f-\x9f]/g;
const TAB_EXPANSION = "    ";

function normalizeText(text: string): string {
  const withoutCr = text.replace(/\r\n/g, "\n").replace(/\r/g, "");
  const withoutTabs = withoutCr.replace(/\t/g, TAB_EXPANSION);
  return withoutTabs.replace(CONTROL_CHARS, "");
}

// 用 sliceByColumn 逐段取正好 width 列的子串：只搬运原文字符，不产生省略号/ANSI
function foldPlain(text: string, width: number): string[] {
  if (width <= 0) return [text];
  if (text.length === 0) return [""];
  const total = visibleWidth(text);
  const lines: string[] = [];
  let col = 0;
  while (col < total) {
    let chunk = sliceByColumn(text, col, width, true);
    let consumed = visibleWidth(chunk);
    if (consumed === 0) {
      // 单个宽字符本身就超过 width（如宽度 1 装不下一个全角字符），退化为非严格模式强制前进，避免死循环
      chunk = sliceByColumn(text, col, width, false);
      consumed = visibleWidth(chunk) || 1;
    }
    lines.push(chunk);
    col += consumed;
  }
  return lines;
}

// 宿主没接 tui.terminal（如渲染失败前的过渡态）时给个兜底整屏行数，避免宽度已刷新、高度却停在构造期旧值的混合口径
const DEFAULT_TERMINAL_ROWS = 24;
const MIN_BUDGET_ROWS = 5;

// 总预算（含末尾状态行）随宿主整屏行数打对折，但不超过实际有多少行内容可显示，也不低于一个可用下限
function renderBudget(rows: number, naturalContentLines: number): number {
  const cap = Math.max(MIN_BUDGET_ROWS, Math.floor(rows / 2));
  return Math.min(naturalContentLines + 1, cap);
}

const KIND_LABEL: Record<TranscriptEntryKind, string> = {
  thinking: "思考",
  text: "文本",
  toolcall: "工具调用",
  tool_result: "工具结果",
  error: "错误",
};

export type TranscriptStatus = "running" | "ended" | "unreachable" | "unreadable";

const STATUS_LABEL: Record<TranscriptStatus, string> = {
  running: "运行中",
  ended: "已结束",
  unreachable: "不可达",
  unreadable: "记录不可读",
};

export interface TranscriptDeltaInput {
  runId: string;
  seq: number;
  kind: TranscriptEntryKind;
  delta?: string;
  summary?: string;
}

export interface TranscriptViewTui {
  requestRender(): void;
  terminal?: { rows: number; columns: number };
}

export interface TranscriptViewOptions {
  tui?: TranscriptViewTui;
  onClose?: () => void;
}

interface StoredEntry {
  kind: TranscriptEntryKind;
  text: string;
}

interface LinesCache {
  width: number;
  version: number;
  lines: string[];
}

export class TranscriptView {
  private readonly tui: TranscriptViewTui | undefined;
  private readonly onClose: (() => void) | undefined;
  private readonly entries = new Map<number, StoredEntry>();
  private width = 80;
  private height = 20;
  private explicitTop: number | undefined;
  private status: TranscriptStatus | undefined;
  private version = 0;
  private linesCache: LinesCache | undefined;

  constructor(options: TranscriptViewOptions = {}) {
    this.tui = options.tui;
    this.onClose = options.onClose;
  }

  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
  }

  appendDelta(input: TranscriptDeltaInput): void {
    const existing = this.entries.get(input.seq);
    const text =
      input.summary !== undefined
        ? input.summary
        : input.delta !== undefined
          ? (existing?.text ?? "") + input.delta
          : (existing?.text ?? "");
    this.entries.set(input.seq, { kind: input.kind, text });
    this.version += 1;
    this.requestRender();
  }

  // 每条记录一旦落盘内容不再变化：已存在的 seq 保留先到者，只补入本地尚未见过的 seq
  loadFromRecord(entries: TranscriptEntry[]): void {
    let changed = false;
    for (const entry of entries) {
      if (this.entries.has(entry.seq)) continue;
      this.entries.set(entry.seq, { kind: entry.kind, text: entry.summary });
      changed = true;
    }
    if (changed) this.version += 1;
  }

  setStatus(status: TranscriptStatus): void {
    this.status = status;
    this.requestRender();
  }

  handleInput(data: string): boolean {
    if (isKeyRelease(data)) return false;
    if (matchesKey(data, "escape")) {
      this.onClose?.();
      return true;
    }
    if (matchesKey(data, "up")) {
      this.scrollUp(1);
      return true;
    }
    if (matchesKey(data, "down")) {
      this.scrollDown(1);
      return true;
    }
    if (matchesKey(data, "pageUp")) {
      this.scrollUp(this.height);
      return true;
    }
    if (matchesKey(data, "pageDown")) {
      this.scrollDown(this.height);
      return true;
    }
    if (matchesKey(data, "end")) {
      this.explicitTop = undefined;
      return true;
    }
    return false;
  }

  render(width: number): string[] {
    // width 由宿主每次渲染传入即为当前真实列数；接了 tui 的实例还要按同一公式随渲染周期刷新高度，两者不共用陈旧状态
    this.width = width;
    const lines = this.wrappedLines(width);
    if (this.tui) {
      const rows = this.tui.terminal?.rows ?? DEFAULT_TERMINAL_ROWS;
      this.height = Math.max(0, renderBudget(rows, lines.length) - 1);
    }
    const top = this.clampedTop(lines.length);
    return [...lines.slice(top, top + this.height), this.renderStatusLine(width)];
  }

  invalidate(): void {
    this.requestRender();
  }

  private requestRender(): void {
    this.tui?.requestRender();
  }

  private scrollUp(amount: number): void {
    const max = this.maxTop(this.wrappedLines(this.width).length);
    const current = this.explicitTop ?? max;
    this.explicitTop = Math.max(0, Math.min(current - amount, max));
  }

  private scrollDown(amount: number): void {
    const max = this.maxTop(this.wrappedLines(this.width).length);
    const current = this.explicitTop ?? max;
    const next = Math.min(current + amount, max);
    this.explicitTop = next >= max ? undefined : next;
  }

  private maxTop(totalLines: number): number {
    return Math.max(0, totalLines - this.height);
  }

  private clampedTop(totalLines: number): number {
    const max = this.maxTop(totalLines);
    return this.explicitTop === undefined ? max : Math.max(0, Math.min(this.explicitTop, max));
  }

  private orderedEntries(): StoredEntry[] {
    return Array.from(this.entries.keys())
      .sort((a, b) => a - b)
      .map((seq) => this.entries.get(seq) as StoredEntry);
  }

  private wrappedLines(width: number): string[] {
    if (this.linesCache && this.linesCache.width === width && this.linesCache.version === this.version) {
      return this.linesCache.lines;
    }
    const lines: string[] = [];
    for (const entry of this.orderedEntries()) {
      lines.push(sliceByColumn(KIND_LABEL[entry.kind], 0, Math.max(0, width), true));
      for (const rawLine of normalizeText(entry.text).split("\n")) lines.push(...foldPlain(rawLine, width));
    }
    this.linesCache = { width, version: this.version, lines };
    return lines;
  }

  private renderStatusLine(width: number): string {
    const label = this.status ? STATUS_LABEL[this.status] : "";
    return sliceByColumn(label, 0, Math.max(0, width), true);
  }
}

export interface TranscriptViewComponent {
  render(width: number): string[];
  handleInput?(data: string): boolean | void;
  invalidate(): void;
}

export interface TranscriptViewCtx {
  ui: {
    custom<T>(
      factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (result: T) => void) => TranscriptViewComponent,
      options?: { overlay?: boolean },
    ): Promise<T>;
    notify(message: string, level?: string): void;
  };
}

export interface TranscriptViewClient {
  call(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
  subscribe(event: string, listener: (data: unknown) => void): () => void;
  state(): { status: string };
}

export interface TranscriptViewDock {
  markPageOpen(): void;
  markPageClosed(): void;
}

export interface OpenTranscriptViewOptions {
  ctx: TranscriptViewCtx;
  client: TranscriptViewClient;
  runId: string;
  dataRoot: string;
  repoId: string;
  dock: TranscriptViewDock;
  clock: Clock;
  restoreSelection: (runId: string) => void;
}

type LocalReadResult = ReturnType<typeof readTranscript>;

// readTranscript 在畸形会话文件上会直接抛出（而非返回 ok:false），按不可读会话统一处理
function safeReadTranscript(ref: { dataRoot: string; repoId: string; runId: string }): LocalReadResult {
  try {
    return readTranscript(ref);
  } catch (error) {
    return { ok: false, reason: "corrupt", detail: (error as Error).message };
  }
}

// 同时只允许一个查看页在途：闸门与强制关闭钩子都挂在这一个槽位上，槽位空即可打开
let activeRunId: string | undefined;
let forceCloseActive: (() => void) | undefined;

export function closeActiveTranscriptView(): void {
  forceCloseActive?.();
}

export async function openTranscriptView(options: OpenTranscriptViewOptions): Promise<void> {
  const { ctx, client, runId, dataRoot, repoId, dock, clock, restoreSelection } = options;
  if (activeRunId !== undefined) return;

  let closed = false;
  let unsubscribeLive: (() => void) | undefined;
  let subscriptionId: string | undefined;
  let pollHandle: TimerHandle | undefined;

  try {
    activeRunId = runId;
    const localResult = safeReadTranscript({ dataRoot, repoId, runId });
    const localEntries = localResult.ok ? localResult.entries : [];
    const lastSeq = localEntries[localEntries.length - 1]?.seq ?? 0;

    await ctx.ui.custom(
      (tui, _theme, _keybindings, done) => {
        const requestClose = () => {
          // Esc 与 closeActiveTranscriptView 都可能触发这里；先到者置位并立即摘除钩子，后到者直接短路，不会二次 resolve done
          if (closed) return;
          closed = true;
          forceCloseActive = undefined;
          done(undefined);
        };
        const view = new TranscriptView({ tui: tui as TranscriptViewTui, onClose: requestClose });
        forceCloseActive = requestClose;
        view.loadFromRecord(localEntries);
        dock.markPageOpen();

        if (!localResult.ok) {
          view.setStatus("unreadable");
          ctx.ui.notify(`会话记录读取失败：${localResult.detail}`, "error");
          return view;
        }
        if (localResult.ended) {
          // 已结束是终态：不会再有新增量，订阅与轮询都没有意义
          view.setStatus("ended");
          return view;
        }
        view.setStatus("running");

        client.call("subscribe.transcript", { runId, fromSeq: lastSeq }).then(
          (result) => {
            const remoteEntries = result.entries as TranscriptEntry[] | undefined;
            if (remoteEntries) view.loadFromRecord(remoteEntries);
            if (result.ended) view.setStatus("ended");
            subscriptionId = result.subscriptionId as string | undefined;
            if (closed) {
              // 关闭发生在订阅兑现之前：不再建立监听，只把服务端侧的订阅收尾掉
              if (subscriptionId) client.call("unsubscribe", { subscriptionId }).catch(() => {});
              return;
            }
            unsubscribeLive = client.subscribe("transcript", (data) => {
              const payload = data as { runId?: string } & TranscriptDeltaInput;
              if (payload.runId !== runId) return;
              view.appendDelta(payload);
            });
          },
          () => {
            if (!closed) view.setStatus("unreachable");
          },
        );

        pollHandle = clock.setIntervalExcludingSleep(() => {
          if (client.state().status === "unreachable") view.setStatus("unreachable");
        }, POLL_INTERVAL_MS);

        return view;
      },
      { overlay: false },
    );
  } finally {
    closed = true;
    dock.markPageClosed();
    unsubscribeLive?.();
    if (pollHandle !== undefined) clock.clearTimer(pollHandle);
    if (subscriptionId) await client.call("unsubscribe", { subscriptionId }).catch(() => {});
    activeRunId = undefined;
    forceCloseActive = undefined;
    restoreSelection(runId);
  }
}
