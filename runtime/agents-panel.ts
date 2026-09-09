import { isKeyRelease, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import type { AgentsActivity, AgentsActivityRow } from "./agents-activity.ts";
import type { Clock } from "./clock.ts";
import type { CaptureMode } from "./dock.ts";
import { canCapture } from "./dock.ts";

type ActionButtonKey = "pause" | "resume" | "resumeInterrupted" | "stop";
type ButtonKey = ActionButtonKey | "view";

const BUTTON_LABEL: Record<ButtonKey, string> = {
  pause: "暂停",
  resume: "继续",
  resumeInterrupted: "续接",
  stop: "停止",
  view: "查看",
};

const METHOD_FOR_BUTTON: Record<ActionButtonKey, string> = {
  pause: "runs.pause",
  resume: "runs.resume",
  resumeInterrupted: "runs.resumeInterrupted",
  stop: "runs.stop",
};

const PENDING_LABEL: Record<ActionButtonKey, string> = {
  pause: "暂停中",
  resume: "继续中",
  resumeInterrupted: "续接中",
  stop: "停止中",
};

const STATE_LABEL: Record<string, string> = {
  queued: "排队",
  running: "运行中",
  pausing: "暂停中",
  paused: "已暂停",
  paused_network: "网络暂停",
  waiting_answer: "等待答复",
  interrupted: "已中断",
  completed: "已完成",
  failed: "失败",
  stopped: "已停止",
};

const INFLIGHT_TIMEOUT_MS = 30_000;

const CONTROL_CHARS = /[\x00-\x1f\x7f-\x9f]/g;

function stripControlChars(text: string): string {
  return text.replace(CONTROL_CHARS, "");
}

export interface AgentsPanelClient {
  call(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
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
  onView: (runId: string) => void;
  availableRows?: () => number;
  captureMode?: CaptureMode;
}

export interface MountAgentsPanelCtx {
  mode?: string;
  hasUI?: boolean;
  ui?: {
    setWidget?: (key: string, content: unknown, options?: { placement?: string }) => void;
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
}

type VisibleLine = { kind: "row"; row: AgentsActivityRow } | { kind: "notice" };

interface VisibleWindow {
  entries: VisibleLine[];
  selectable: AgentsActivityRow[];
  cursorRow: AgentsActivityRow | undefined;
  noticeMessage: string | undefined;
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

export class AgentsPanel {
  private readonly options: AgentsPanelOptions;
  private theme: AgentsPanelTheme | undefined;
  private hostBinding: AgentsPanelHostBinding = {};
  private cursor = 0;
  private selectedButtonIndex = 0;
  private batchMode = false;
  private focused = true;
  private readonly pendingActions = new Map<string, PendingAction>();

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
    const { entries, cursorRow, noticeMessage } = this.visibleWindow();
    return entries.map((entry) =>
      entry.kind === "row"
        ? this.renderRow(entry.row, entry.row === cursorRow, width)
        : truncateToWidth(stripControlChars(noticeMessage ?? ""), width, "", false),
    );
  }

  handleInput(data: string): boolean {
    if (isKeyRelease(data)) return false;
    if (matchesKey(data, "down")) {
      this.moveCursor(1);
      return true;
    }
    if (matchesKey(data, "up")) {
      this.moveCursor(-1);
      return true;
    }
    if (matchesKey(data, "right")) {
      this.moveButton(1);
      return true;
    }
    if (matchesKey(data, "left")) {
      this.moveButton(-1);
      return true;
    }
    if (matchesKey(data, "tab")) {
      this.batchMode = !this.batchMode;
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

    const { entries, selectable } = this.visibleWindow();
    const target = entries[event.y];
    if (!target || target.kind === "notice") return { handled: true };

    const row = target.row;
    if (row.buttons.length === 0) return { handled: true };
    const targetIndex = selectable.indexOf(row);
    if (targetIndex !== -1) this.cursor = targetIndex;

    const buttonKey = this.selectedButtonKey(row);
    if (buttonKey === "view") this.options.onView(row.id);
    else if (buttonKey) this.dispatchAction(row, buttonKey);
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

  private selectedButtonKey(row: AgentsActivityRow): ButtonKey | undefined {
    if (row.buttons.length === 0) return undefined;
    const idx = Math.min(this.selectedButtonIndex, row.buttons.length - 1);
    return row.buttons[idx] as ButtonKey;
  }

  private execute(): void {
    const selectable = this.currentRows().filter((row) => row.buttons.length > 0);
    const cursorRow = selectable[this.clampedCursor(selectable.length)];
    if (!cursorRow) return;
    const buttonKey = this.selectedButtonKey(cursorRow);
    if (!buttonKey) return;

    if (buttonKey === "view") {
      this.options.onView(cursorRow.id);
      return;
    }
    if (this.batchMode) {
      for (const row of selectable) {
        if (row.buttons.includes(buttonKey)) this.dispatchAction(row, buttonKey);
      }
      return;
    }
    this.dispatchAction(cursorRow, buttonKey);
  }

  private dispatchAction(row: AgentsActivityRow, buttonKey: ActionButtonKey): void {
    if (this.pendingActions.has(row.id)) return;
    const client = this.options.clients.forRepo(row.repoId);
    if (!client) {
      this.options.activity.reportActionFailure(`${BUTTON_LABEL[buttonKey]}失败：找不到该仓库的守护进程连接`);
      return;
    }
    const token: PendingAction = { action: buttonKey, startedAt: this.options.clock.now() };
    this.pendingActions.set(row.id, token);
    // 到期后重新下发会换成一枚新令牌；旧请求这时才姗姗来迟，结算前必须核对令牌，否则会误清掉新一轮的在途标记
    client.call(METHOD_FOR_BUTTON[buttonKey], { runId: row.id }).then(
      () => {
        if (this.pendingActions.get(row.id) !== token) return;
        this.pendingActions.delete(row.id);
      },
      (error: unknown) => {
        if (this.pendingActions.get(row.id) !== token) return;
        this.pendingActions.delete(row.id);
        this.options.activity.reportActionFailure(`${BUTTON_LABEL[buttonKey]}失败：${(error as Error).message}`);
      },
    );
  }

  // 请求发出后一直没等到 runs.changed/回执确认，30 秒后不能让按钮永远卡在"暂停中"
  private sweepExpiredPending(): void {
    for (const [rowId, entry] of this.pendingActions) {
      if (this.options.clock.elapsedExcludingSleep(entry.startedAt) < INFLIGHT_TIMEOUT_MS) continue;
      this.pendingActions.delete(rowId);
      this.options.activity.reportActionFailure(`${BUTTON_LABEL[entry.action]}未确认`);
    }
  }

  private computeAvailableRows(): number {
    return this.options.availableRows ? this.options.availableRows() : Number.POSITIVE_INFINITY;
  }

  private visibleWindow(): VisibleWindow {
    const notice = this.options.activity.notice();
    const limit = this.computeAvailableRows();
    const rowBudget = notice ? Math.max(0, limit - 1) : limit;

    const rows = this.currentRows();
    const selectable = rows.filter((row) => row.buttons.length > 0);
    const cursorRow = selectable[this.clampedCursor(selectable.length)];
    const { start, end } = windowFor(rows, cursorRow, rowBudget);

    const entries: VisibleLine[] = rows.slice(start, end).map((row) => ({ kind: "row", row }) as const);
    if (notice) entries.push({ kind: "notice" });
    return { entries, selectable, cursorRow, noticeMessage: notice?.message };
  }

  private renderRow(row: AgentsActivityRow, isCursorRow: boolean, width: number): string {
    const indent = "  ".repeat(row.indent);
    const title = stripControlChars(row.title);
    const parts = [
      `${indent}${title}`,
      Object.hasOwn(STATE_LABEL, row.status) ? STATE_LABEL[row.status] : stripControlChars(String(row.status ?? "")),
      formatElapsed(row.elapsedMs),
      `第 ${row.turns} 轮`,
    ];
    if (row.activity) parts.push(stripControlChars(row.activity));
    if (row.activeShellTasks !== undefined) parts.push(`Shell${stripControlChars(String(row.activeShellTasks))}`);
    if (row.pendingShellCleanup !== undefined) parts.push(`清理${stripControlChars(String(row.pendingShellCleanup))}`);
    if (row.unreachable) parts.push(row.unreachableReason ? stripControlChars(row.unreachableReason) : "不可达");
    const buttonsText = this.buttonsSegment(row, isCursorRow);
    if (buttonsText) parts.push(buttonsText);

    let line = parts.join("  ");
    if (row.archived) line = this.theme?.fg ? this.theme.fg("dim", line) : line;
    return truncateToWidth(line, width, "", false);
  }

  private buttonsSegment(row: AgentsActivityRow, isCursorRow: boolean): string {
    const pending = this.pendingActions.get(row.id);
    if (pending) return PENDING_LABEL[pending.action];
    if (row.buttons.length === 0) return "";

    const selectedIdx = Math.min(this.selectedButtonIndex, row.buttons.length - 1);
    return row.buttons
      .map((key, idx) => this.decorate(BUTTON_LABEL[key as ButtonKey], isCursorRow && idx === selectedIdx))
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

  const panel = createAgentsPanel(options);
  let boundTui: HostTuiLike | undefined;

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
