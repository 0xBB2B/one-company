import { isKeyRelease, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { AgentsActivity, AgentsActivityRow } from "./agents-activity.ts";
import type { Clock } from "./clock.ts";
import type { DaemonConnectionIdentity } from "./daemon-client.ts";
import type { CaptureMode } from "./dock.ts";
import { canCapture } from "./dock.ts";
import { sanitizeText } from "./text-sanitize.ts";

type ActionButtonKey = "pause" | "stop";

const BUTTON_LABEL: Record<ActionButtonKey, string> = {
  pause: "暂停",
  stop: "停止",
};

const METHOD_FOR_BUTTON: Record<ActionButtonKey, string> = {
  pause: "runs.pause",
  stop: "runs.stop",
};

const PENDING_LABEL: Record<ActionButtonKey, string> = {
  pause: "暂停中",
  stop: "停止中",
};

const STATE_LABEL: Record<string, string> = {
  queued: "登记排队",
  running: "登记运行中",
  pausing: "登记暂停中",
  paused: "登记暂停",
  paused_network: "登记网络暂停",
  waiting_answer: "登记等待答复",
  interrupted: "登记中断",
  completed: "登记完成（非需求完成）",
  failed: "登记失败",
  stopped: "登记停止",
};

const INFLIGHT_TIMEOUT_MS = 30_000;
const MIN_ACTION_WIDTH = 40;

const CONTROL_CHARS = /[\x00-\x1f\x7f-\x9f]/g;

function stripControlChars(text: string): string {
  return text.replace(CONTROL_CHARS, "");
}

function externalErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : "未知错误";
  return sanitizeText(stripControlChars(raw), 200).replace(/\s+/g, " ").trim() || "未知错误";
}

function resultConfirmation(result: Record<string, unknown>): { confirmed: boolean; reason: string } {
  if (!result || typeof result !== "object" || Array.isArray(result)) return { confirmed: false, reason: "回执结构无法核对" };
  const confirmed = Object.getOwnPropertyDescriptor(result, "confirmed")?.value === true;
  const reasonValue = Object.getOwnPropertyDescriptor(result, "reason")?.value;
  const reason = typeof reasonValue === "string" || typeof reasonValue === "number" || typeof reasonValue === "boolean"
    ? externalErrorMessage(String(reasonValue))
    : "未取得确认回执";
  return { confirmed, reason };
}

export interface AgentsPanelClient {
  call(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
  connectionIdentity?(): Readonly<DaemonConnectionIdentity> | null;
}

export interface AgentsPanelClients {
  forRepo(repoId: string): AgentsPanelClient | undefined;
}

export interface AgentsPanelTheme {
  fg?: (kind: string, text: string) => string;
  bg?: (kind: string, text: string) => string;
}

export interface AgentsPanelMouseEvent {
  type: string;
  y: number;
  width: number;
}

export interface AgentsPanelMouseResult {
  handled: boolean;
}

export interface AgentsPanelOptions {
  activity: AgentsActivity;
  clock: Clock;
  clients: AgentsPanelClients;
  theme?: AgentsPanelTheme;
  availableRows?: () => number;
  captureMode?: CaptureMode;
}

export interface MountAgentsPanelCtx {
  mode?: string;
  hasUI?: boolean;
  ui?: {
    setWidget?: import("@earendil-works/pi-coding-agent").ExtensionUIContext["setWidget"];
    onTerminalInput?: (handler: (data: string) => { consume?: boolean; data?: string } | undefined) => () => void;
  };
}

export interface MountAgentsPanelHost {
  isOverlayOpen(): boolean;
  isCompletionOpen(): boolean;
  captureMode(): CaptureMode;
  requestRender(): void;
}

export interface MountAgentsPanelResult {
  mounted: boolean;
  reason?: string;
  unmount?: () => void;
  panel?: AgentsPanel;
  host?: MountAgentsPanelHost;
}

interface PendingAction {
  action: ActionButtonKey;
  startedAt: number;
  isCurrent(): boolean;
}

interface RenderBinding { client: AgentsPanelClient | undefined; isCurrent(): boolean }
type VisibleLine = { kind: "row"; row: AgentsActivityRow } | { kind: "notice"; message: string };

type RenderedLine =
  | { kind: "mode"; text: string }
  | { kind: "notice"; text: string }
  | { kind: "row"; text: string; row: AgentsActivityRow; action?: ActionButtonKey; fingerprint: string; binding: RenderBinding };

interface VisibleWindow {
  entries: VisibleLine[];
  selectable: AgentsActivityRow[];
  cursorRow: AgentsActivityRow | undefined;
  viewportOmitted: number;
  limit: number;
}

interface RenderSnapshot {
  width: number;
  limit: number;
  batchMode: boolean;
  selectedButtonIndex: number;
  lines: RenderedLine[];
  keyboardTargets: Array<{ row: AgentsActivityRow; action: ActionButtonKey; fingerprint: string; binding: RenderBinding }>;
}

interface AgentsPanelHostBinding {
  captureMode?: () => CaptureMode;
  requestRender?: () => void;
}

function windowFor(
  rows: AgentsActivityRow[],
  cursorRow: AgentsActivityRow | undefined,
  limit: number,
): { start: number; end: number } {
  if (rows.length <= limit) return { start: 0, end: rows.length };
  const idx = cursorRow ? rows.indexOf(cursorRow) : 0;
  const half = Math.floor(limit / 2);
  const start = Math.max(0, Math.min(idx - half, rows.length - limit));
  return { start, end: start + limit };
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return totalSeconds < 3600 ? `${minutes}m${seconds}s` : `${hours}h${minutes}m${seconds}s`;
}

function rowKey(row: Pick<AgentsActivityRow, "repoId" | "id">): string {
  return `${row.repoId}::${row.id}`;
}

function rowFingerprint(row: AgentsActivityRow): string {
  return JSON.stringify([
    row.repoId,
    row.id,
    row.title,
    row.status,
    row.activity,
    row.turns,
    row.waiting,
    row.filesEditedCount,
    row.activeShellTasks,
    row.pendingShellCleanup,
    row.unreachable,
    row.unreachableReason,
    row.archived,
    row.stopConfirmed,
    row.buttons,
  ]);
}

export class AgentsPanel {
  private readonly options: AgentsPanelOptions;
  private theme: AgentsPanelTheme | undefined;
  private hostBinding: AgentsPanelHostBinding = {};
  private cursor = 0;
  private selectedButtonIndex = 0;
  private batchMode = false;
  private focused = true;
  private readonly pendingActions = new Map<string, PendingAction>();
  private lastRender: RenderSnapshot | undefined;

  constructor(options: AgentsPanelOptions) {
    this.options = options;
    this.theme = options.theme;
  }

  setTheme(theme: AgentsPanelTheme): void {
    if (this.theme === undefined) this.theme = theme;
  }

  bindHost(binding: AgentsPanelHostBinding): void {
    this.hostBinding = binding;
  }

  render(width: number): string[] {
    const safeWidth = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
    const { entries, cursorRow, viewportOmitted, limit } = this.visibleWindow();
    if (limit <= 0 || safeWidth <= 0) {
      this.lastRender = { width: safeWidth, limit, batchMode: this.batchMode, selectedButtonIndex: this.selectedButtonIndex, lines: [], keyboardTargets: [] };
      return [];
    }

    const desiredAction = cursorRow ? this.selectedButtonKey(cursorRow) : undefined;
    const renderedEntries = entries.map<RenderedLine>((entry, index) => {
      if (entry.kind === "notice") {
        return { kind: "notice", text: sanitizeText(truncateToWidth(stripControlChars(entry.message), safeWidth, "", false)) } as const;
      }
      const action = desiredAction && entry.row.buttons.includes(desiredAction) && !this.pendingActions.get(rowKey(entry.row))?.isCurrent()
        && this.actionPrefixFits(entry.row, desiredAction, index + 1, safeWidth) ? desiredAction : undefined;
      return {
        kind: "row",
        text: this.renderRow(entry.row, entry.row === cursorRow, index + 1, safeWidth),
        row: entry.row,
        action,
        fingerprint: rowFingerprint(entry.row),
        binding: this.captureBinding(entry.row),
      };
    });
    const visibleRows = renderedEntries.filter((entry): entry is Extract<RenderedLine, { kind: "row" }> => entry.kind === "row");
    const eligible = visibleRows.filter((entry) => entry.action === desiredAction && entry.action !== undefined);
    const keyboardTargets = this.batchMode
      ? eligible.map((entry) => ({ row: entry.row, action: entry.action!, fingerprint: entry.fingerprint, binding: entry.binding }))
      : eligible.filter((entry) => entry.row === cursorRow).map((entry) => ({ row: entry.row, action: entry.action!, fingerprint: entry.fingerprint, binding: entry.binding }));
    const refusal = keyboardTargets.length === 0
      ? (safeWidth < MIN_ACTION_WIDTH ? "宽度不足" : visibleRows.length === 0 ? "空间不足" : "目标/动作不可辨")
      : undefined;
    const modeText = `${this.batchMode ? "批量" : "单项"} 目标${keyboardTargets.length}${desiredAction ? ` ${BUTTON_LABEL[desiredAction]}` : ""}${refusal ? ` 拒绝：${refusal}` : ""} 视口省略${viewportOmitted}`;
    const modeLine: RenderedLine = { kind: "mode", text: sanitizeText(truncateToWidth(modeText, safeWidth, "", false)) };
    const lines = [modeLine, ...renderedEntries].slice(0, limit);
    this.lastRender = { width: safeWidth, limit, batchMode: this.batchMode, selectedButtonIndex: this.selectedButtonIndex, lines, keyboardTargets };
    return lines.map((line) => line.text);
  }

  handleInput(data: string): boolean {
    if (isKeyRelease(data)) return false;
    if (matchesKey(data, "down")) {
      this.moveCursor(1);
      this.lastRender = undefined;
      return true;
    }
    if (matchesKey(data, "up")) {
      this.moveCursor(-1);
      this.lastRender = undefined;
      return true;
    }
    if (matchesKey(data, "right")) {
      this.moveButton(1);
      this.lastRender = undefined;
      return true;
    }
    if (matchesKey(data, "left")) {
      this.moveButton(-1);
      this.lastRender = undefined;
      return true;
    }
    if (matchesKey(data, "tab")) {
      this.batchMode = !this.batchMode;
      this.lastRender = undefined;
      return true;
    }
    if (matchesKey(data, "enter")) {
      this.execute();
      return true;
    }
    return false;
  }

  handleMouse(event: AgentsPanelMouseEvent): AgentsPanelMouseResult | undefined {
    const captureMode = this.hostBinding.captureMode ? this.hostBinding.captureMode() : (this.options.captureMode ?? "regular");
    if (!canCapture(captureMode)) return undefined;
    if (event.type !== "click") return undefined;

    const snapshot = this.lastRender;
    if (!snapshot || snapshot.width !== Math.max(0, Math.floor(event.width)) || !this.snapshotWindowIsCurrent(snapshot)) {
      this.rejectOperation("操作已拒绝：请先按当前尺寸刷新面板");
      return { handled: true };
    }
    const target = snapshot.lines[event.y];
    if (!target || target.kind !== "row" || !target.action) return { handled: true };
    const currentRows = this.currentRows();
    const current = currentRows.find((row) => rowKey(row) === rowKey(target.row));
    if (!current || rowFingerprint(current) !== target.fingerprint || !target.binding.isCurrent() || !current.buttons.includes(target.action)) {
      this.rejectOperation("操作已拒绝：可见目标已变化");
      return { handled: true };
    }
    const selectable = currentRows.filter((row) => row.buttons.length > 0);
    const targetIndex = selectable.findIndex((row) => rowKey(row) === rowKey(current));
    if (targetIndex !== -1) this.cursor = targetIndex;
    this.dispatchAction(current, target.action, target.binding);
    return { handled: true };
  }

  focus(): void {
    this.focused = true;
  }

  blur(): void {
    this.focused = false;
  }

  hasRows(): boolean {
    return this.currentRows().some((row) => row.buttons.length > 0);
  }

  selectedRunId(): string | undefined {
    const selectable = this.currentRows().filter((row) => row.buttons.length > 0);
    if (selectable.length === 0) return undefined;
    return selectable[this.clampedCursor(selectable.length)]?.id;
  }

  selectedRunKey(): { repoId: string; runId: string } | undefined {
    const selectable = this.currentRows().filter((row) => row.buttons.length > 0);
    const row = selectable[this.clampedCursor(selectable.length)];
    return row ? { repoId: row.repoId, runId: row.id } : undefined;
  }

  selectRun(runId: string, repoId?: string): boolean {
    const selectable = this.currentRows().filter((row) => row.buttons.length > 0);
    const matches = selectable
      .map((row, index) => ({ row, index }))
      .filter(({ row }) => row.id === runId && (repoId === undefined || row.repoId === repoId));
    if (matches.length !== 1) return false;
    this.cursor = matches[0]!.index;
    this.lastRender = undefined;
    return true;
  }

  invalidate(): void {
    this.hostBinding.requestRender?.();
  }

  tick(): void {
    this.sweepExpiredPending();
  }

  private currentRows(): AgentsActivityRow[] {
    return this.options.activity.rows();
  }

  private clampedCursor(selectableCount: number): number {
    if (selectableCount === 0) return 0;
    return Math.max(0, Math.min(this.cursor, selectableCount - 1));
  }

  private moveCursor(delta: number): void {
    const count = this.currentRows().filter((row) => row.buttons.length > 0).length;
    this.cursor = count === 0 ? 0 : Math.max(0, Math.min(this.clampedCursor(count) + delta, count - 1));
  }

  private moveButton(delta: number): void {
    const selectable = this.currentRows().filter((row) => row.buttons.length > 0);
    const row = selectable[this.clampedCursor(selectable.length)];
    const max = row ? row.buttons.length - 1 : 0;
    this.selectedButtonIndex = Math.max(0, Math.min(this.selectedButtonIndex + delta, max));
  }

  private selectedButtonKey(row: AgentsActivityRow): ActionButtonKey | undefined {
    if (row.buttons.length === 0) return undefined;
    const idx = Math.min(this.selectedButtonIndex, row.buttons.length - 1);
    const key = row.buttons[idx];
    return key === "pause" || key === "stop" ? key : undefined;
  }

  private execute(): void {
    const snapshot = this.lastRender;
    if (!snapshot || snapshot.batchMode !== this.batchMode || snapshot.selectedButtonIndex !== this.selectedButtonIndex
      || !this.snapshotWindowIsCurrent(snapshot)) {
      this.rejectOperation("操作已拒绝：请先刷新面板确认目标");
      return;
    }
    if (snapshot.keyboardTargets.length === 0) {
      this.rejectOperation("操作已拒绝：当前没有可见且可辨的目标");
      return;
    }
    const currentRows = this.currentRows();
    const currentByKey = new Map(currentRows.map((row) => [rowKey(row), row]));
    const targets: Array<{ row: AgentsActivityRow; action: ActionButtonKey; binding: RenderBinding }> = [];
    for (const target of snapshot.keyboardTargets) {
      const current = currentByKey.get(rowKey(target.row));
      if (!current || rowFingerprint(current) !== target.fingerprint || !target.binding.isCurrent() || !current.buttons.includes(target.action)) {
        this.rejectOperation("操作已拒绝：可见目标已变化");
        return;
      }
      targets.push({ row: current, action: target.action, binding: target.binding });
    }
    for (const target of targets) this.dispatchAction(target.row, target.action, target.binding);
  }

  private rejectOperation(message: string): void {
    this.options.activity.reportActionFailure(message);
    this.invalidate();
  }

  private snapshotWindowIsCurrent(snapshot: RenderSnapshot): boolean {
    const current = this.visibleWindow();
    if (current.limit !== snapshot.limit) return false;
    const previousKeys = snapshot.lines.filter((line): line is Extract<RenderedLine, { kind: "row" }> => line.kind === "row")
      .map((line) => rowKey(line.row));
    const currentKeys = current.entries.filter((line): line is Extract<VisibleLine, { kind: "row" }> => line.kind === "row")
      .map((line) => rowKey(line.row));
    return JSON.stringify(previousKeys) === JSON.stringify(currentKeys);
  }

  private captureBinding(row: AgentsActivityRow): RenderBinding {
    try {
      const client = this.options.clients.forRepo(row.repoId), binding = this.options.activity.stopBinding(row.repoId, row.id);
      const stamp = () => {
        const identity = client?.connectionIdentity?.();
        return client?.connectionIdentity ? identity ? JSON.stringify([identity.daemonInstanceId, identity.connectionId, identity.connectionSequence]) : null : "static-client";
      };
      const connection = stamp();
      return { client, isCurrent: () => {
        try { return binding !== undefined && connection !== null && this.options.clients.forRepo(row.repoId) === client &&
          stamp() === connection && this.options.activity.stopBinding(row.repoId, row.id) === binding; } catch { return false; }
      } };
    } catch { return { client: undefined, isCurrent: () => false }; }
  }

  private dispatchAction(row: AgentsActivityRow, buttonKey: ActionButtonKey, rendered: RenderBinding): void {
    if (!rendered.isCurrent()) { this.rejectOperation("操作已拒绝：可见目标或连接已变化"); return; }
    const actionKey = rowKey(row);
    const previous = this.pendingActions.get(actionKey);
    if (previous?.isCurrent()) return;
    if (previous) this.pendingActions.delete(actionKey);
    const client = rendered.client;
    if (!client) {
      this.options.activity.reportActionFailure(`${BUTTON_LABEL[buttonKey]}失败：找不到该仓库的守护进程连接`);
      return;
    }
    if (buttonKey === "stop") this.options.activity.recordStopResult(row.repoId, row.id, false);
    const binding = this.options.activity.stopBinding(row.repoId, row.id);
    const connectionStamp = () => {
      const identity = client.connectionIdentity?.();
      return client.connectionIdentity ? identity ? JSON.stringify([identity.daemonInstanceId, identity.connectionId, identity.connectionSequence]) : null : "static-client";
    };
    const connection = connectionStamp();
    const token: PendingAction = { action: buttonKey, startedAt: this.options.clock.now(), isCurrent: () => {
      try { return connection !== null && this.options.clients.forRepo(row.repoId) === client && connectionStamp() === connection &&
        this.options.activity.stopBinding(row.repoId, row.id) === binding; } catch { return false; }
    } };
    this.pendingActions.set(actionKey, token);
    this.lastRender = undefined;
    // 到期后重新下发会换成一枚新令牌；旧请求这时才姗姗来迟，结算前必须核对令牌，否则会误清掉新一轮的在途标记
    client.call(METHOD_FOR_BUTTON[buttonKey], { runId: row.id }).then(
      (result) => {
        if (this.pendingActions.get(actionKey) !== token) return;
        this.pendingActions.delete(actionKey);
        if (!token.isCurrent()) { this.options.activity.reportActionFailure("旧连接或快照的停止回执未确认"); this.invalidate(); return; }
        const confirmation = resultConfirmation(result);
        if (buttonKey === "stop") this.options.activity.recordStopResult(row.repoId, row.id, confirmation.confirmed);
        if (!confirmation.confirmed) {
          this.options.activity.reportActionFailure(`${BUTTON_LABEL[buttonKey]}未确认：${confirmation.reason}`);
        } else {
          this.options.activity.reportActionFailure(`本次${BUTTON_LABEL[buttonKey]}已确认：${row.title}（非需求完成）`);
        }
        this.invalidate();
      },
      (error: unknown) => {
        if (this.pendingActions.get(actionKey) !== token) return;
        this.pendingActions.delete(actionKey);
        if (!token.isCurrent()) { this.options.activity.reportActionFailure("旧连接或快照的操作回执未确认"); return; }
        this.options.activity.reportActionFailure(`${BUTTON_LABEL[buttonKey]}失败：${externalErrorMessage(error)}`);
      },
    );
  }

  // 请求发出后一直没等到 runs.changed/回执确认，30 秒后不能让按钮永远卡在"暂停中"
  private sweepExpiredPending(): void {
    for (const [rowId, entry] of this.pendingActions) {
      if (entry.isCurrent() && this.options.clock.elapsedExcludingSleep(entry.startedAt) < INFLIGHT_TIMEOUT_MS) continue;
      this.pendingActions.delete(rowId);
      this.options.activity.reportActionFailure(`${BUTTON_LABEL[entry.action]}未确认`);
    }
  }

  private visibleWindow(): VisibleWindow {
    const notice = this.options.activity.notice();
    const rows = this.currentRows();
    const allCoverage = this.options.activity.coverageNotices();
    const requested = this.options.availableRows?.();
    const limit = requested === undefined || !Number.isFinite(requested)
      ? 1 + rows.length + allCoverage.length + (notice ? 1 : 0)
      : Math.max(0, Math.floor(requested));
    const remainingAfterMode = Math.max(0, limit - 1);
    const coverageBudget = allCoverage.length === 0 || remainingAfterMode === 0
      ? 0
      : requested === undefined || !Number.isFinite(requested)
        ? allCoverage.length
        : 1;
    const coverage = this.options.activity.coverageNotices(Math.min(coverageBudget, remainingAfterMode));
    const noticeBudget = notice && remainingAfterMode > coverage.length ? 1 : 0;
    const rowBudget = Math.max(0, remainingAfterMode - coverage.length - noticeBudget);
    const selectable = rows.filter((row) => row.buttons.length > 0);
    const cursorRow = selectable[this.clampedCursor(selectable.length)];
    const { start, end } = windowFor(rows, cursorRow, rowBudget);
    const visibleRows = rows.slice(start, end);

    const entries: VisibleLine[] = visibleRows.map((row) => ({ kind: "row", row }) as const);
    if (noticeBudget > 0 && notice) entries.push({ kind: "notice", message: notice.message });
    for (const message of coverage) entries.push({ kind: "notice", message });
    return { entries, selectable, cursorRow, viewportOmitted: rows.length - visibleRows.length, limit };
  }

  private protectedRowParts(row: AgentsActivityRow, ordinal: number): string[] {
    const safe = (value: unknown) => typeof value === "string" ? sanitizeText(stripControlChars(value), 256) : "未知";
    const short = (value: string, values: string[], suffix = false) => {
      if (value.length <= 12) return safe(value);
      const part = (text: string, size: number) => suffix ? text.slice(-size) : text.slice(0, size);
      let size = 8;
      while (size < value.length && values.some((other) => other !== value && part(other, size) === part(value, size))) size++;
      return safe(part(value, size));
    };
    const rows = this.currentRows();
    const identity = `${short(row.repoId, rows.map((item) => item.repoId))}/${short(row.id, rows.filter((item) => item.repoId === row.repoId).map((item) => item.id), true)}`;
    const title = safe(row.title), separator = title.indexOf(" · ");
    const target = sanitizeText(truncateToWidth(separator >= 0 ? title.slice(separator + 3) : title, 12, "…", false));
    return [String(ordinal), typeof row.pendingShellCleanup === "number" && row.pendingShellCleanup > 0 ? `待清理${row.pendingShellCleanup}` : "",
      row.unreachable ? "不可达" : "", row.stopConfirmed ? "本次停止已确认" : "停止未核实",
      Object.hasOwn(STATE_LABEL, row.status) ? STATE_LABEL[row.status]! : `登记${safe(row.status)}`, identity, target].filter(Boolean);
  }
  private renderRow(row: AgentsActivityRow, isCursorRow: boolean, ordinal: number, width: number): string {
    const safety = [...this.protectedRowParts(row, ordinal), this.buttonsSegment(row, isCursorRow)];
    const turns = Number.isSafeInteger(row.turns) && row.turns >= 0 ? row.turns : "未知";
    const details = [Number.isFinite(row.elapsedMs) ? formatElapsed(row.elapsedMs) : "耗时未知", `第 ${turns} 轮`];
    if (typeof row.activity === "string") details.push(sanitizeText(stripControlChars(row.activity), 128));
    if (row.activeShellTasks !== undefined) details.push(`Shell${Number.isSafeInteger(row.activeShellTasks) && row.activeShellTasks >= 0 ? row.activeShellTasks : "未知"}`);
    if (typeof row.unreachableReason === "string") details.push(sanitizeText(stripControlChars(row.unreachableReason), 128));
    let line = [...safety, ...details].join("  ");
    if (row.archived && this.theme?.fg) line = this.theme.fg("dim", line);
    const truncated = truncateToWidth(line, width, "", false);
    return this.theme?.fg || this.theme?.bg ? truncated : sanitizeText(truncated);
  }

  private actionPrefixFits(row: AgentsActivityRow, action: ActionButtonKey, ordinal: number, width: number): boolean {
    if (width < MIN_ACTION_WIDTH) return false;
    const actionIndex = row.buttons.indexOf(action);
    const visibleButtons = row.buttons.slice(0, actionIndex + 1)
      .filter((key): key is ActionButtonKey => key === "pause" || key === "stop")
      .map((key) => BUTTON_LABEL[key])
      .join(" ");
    const prefix = [...this.protectedRowParts(row, ordinal), visibleButtons].filter(Boolean).join("  ");
    return visibleWidth(prefix) <= width;
  }

  private buttonsSegment(row: AgentsActivityRow, isCursorRow: boolean): string {
    const pending = this.pendingActions.get(rowKey(row));
    if (pending?.isCurrent()) return PENDING_LABEL[pending.action];
    if (row.buttons.length === 0) return "";

    const selectedIdx = Math.min(this.selectedButtonIndex, row.buttons.length - 1);
    return row.buttons
      .map((key, idx) => key === "pause" || key === "stop" ? this.decorate(BUTTON_LABEL[key], isCursorRow && idx === selectedIdx) : "")
      .join(" ");
  }

  private decorate(label: string, isSelected: boolean): string {
    if (!isSelected || !this.focused) return label;
    return this.theme?.bg ? this.theme.bg("selectedBg", label) : label;
  }
}

export function createAgentsPanel(options: AgentsPanelOptions): AgentsPanel {
  return new AgentsPanel(options);
}

const FOOTER_WIDGET_KEY = "agents-panel";

interface HostTuiLike {
  terminal?: { rows: number };
  mode?: CaptureMode;
  hasOverlay?: () => boolean;
  getFocusedComponent?: () => { isShowingAutocomplete?: () => boolean } | null | undefined;
  requestRender?: () => void;
}

export function mountAgentsPanel(ctx: MountAgentsPanelCtx, options: AgentsPanelOptions): MountAgentsPanelResult {
  if (ctx.mode !== "tui") return { mounted: false, reason: "非 tui 模式无法挂载面板" };
  if (!ctx.hasUI) return { mounted: false, reason: "无终端能力，无法挂载面板" };
  const setWidget = ctx.ui?.setWidget;
  const onTerminalInput = ctx.ui?.onTerminalInput;
  if (!setWidget || !onTerminalInput) {
    return { mounted: false, reason: "宿主缺少 setWidget/onTerminalInput 能力，无法挂载面板" };
  }

  let boundTui: HostTuiLike | undefined;
  const panel = createAgentsPanel({ ...options, availableRows: options.availableRows ?? (() => Math.max(3, (boundTui?.terminal?.rows ?? process.stdout.rows ?? 24) - 8)) });

  const host: MountAgentsPanelHost = {
    isOverlayOpen: () => boundTui?.hasOverlay?.() ?? false,
    isCompletionOpen: () => {
      const focused = boundTui?.getFocusedComponent?.();
      return typeof focused?.isShowingAutocomplete === "function" && focused.isShowingAutocomplete();
    },
    captureMode: () => boundTui?.mode ?? "regular",
    requestRender: () => boundTui?.requestRender?.(),
  };

  setWidget(
    FOOTER_WIDGET_KEY,
    (tui: unknown, theme: unknown) => {
      boundTui = tui as HostTuiLike;
      panel.setTheme(theme as AgentsPanelTheme);
      panel.bindHost({ captureMode: host.captureMode, requestRender: host.requestRender });
      return panel;
    },
    { placement: "belowEditor" },
  );

  return {
    mounted: true,
    panel,
    host,
    unmount: () => setWidget(FOOTER_WIDGET_KEY, undefined),
  };
}
