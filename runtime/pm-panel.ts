import { isKeyRelease, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import type { PendingItem, PmOverview } from "./pm-overview.ts";
import { sanitizeText } from "./text-sanitize.ts";

export interface PmPanelEntry { repoId: string; overview: PmOverview; fetchedAt: number }
export interface PmPanelTheme {
  fg?: (kind: string, text: string) => string;
  bg?: (kind: string, text: string) => string;
}
export interface PmPanelOptions {
  now: () => number;
  /** 用户在事项行按回车：插入该事项的决策包。 */
  openItem: (entry: PmPanelEntry, item: PendingItem) => void;
  /** 用户在 PM 行按 p：暂停或恢复该 PM（连带子代理由守护进程处理）。 */
  togglePause: (entry: PmPanelEntry) => void;
}

type Row = { kind: "pm"; entry: PmPanelEntry } | { kind: "item"; entry: PmPanelEntry; item: PendingItem };

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const HINT = "↑↓ 选择 · Enter 查看 · p 暂停/恢复 · Esc 返回输入框";

export function formatTokens(value: number): string {
  if (value < 1_000) return String(value);
  if (value < 1_000_000) return `${(value / 1_000).toFixed(1)}k`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}

export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, ms) / 1_000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const total = Math.floor(seconds), hours = Math.floor(total / 3_600), minutes = Math.floor((total % 3_600) / 60), rest = total % 60;
  return hours > 0 ? `${hours}h${minutes}m${rest}s` : `${minutes}m${rest}s`;
}

/** 输入栏下方的 PM 面板：只显示运行中与暂停的 PM；数据来自守护进程概览，窗口只做投影，不保存事项。 */
export class PmPanel {
  private readonly options: PmPanelOptions;
  private entries: PmPanelEntry[] = [];
  private theme: PmPanelTheme | undefined;
  private cursor = 0;
  private frame = 0;
  private focused = false;
  private requestRender: (() => void) | undefined;

  constructor(options: PmPanelOptions) { this.options = options; }

  setTheme(theme: PmPanelTheme): void { this.theme = theme; }
  bindHost(binding: { requestRender?: () => void }): void { this.requestRender = binding.requestRender; }
  invalidate(): void { this.requestRender?.(); }
  focus(): void { this.focused = true; }
  blur(): void { this.focused = false; }
  tick(): void { this.frame = (this.frame + 1) % SPINNER.length; }

  /** 用最新概览替换投影；选中项按事项或 PM 身份保持，已消失时落到相邻行。 */
  update(entries: PmPanelEntry[]): void {
    const selected = this.rows()[this.cursor];
    const key = selected ? rowKey(selected) : undefined;
    this.entries = [...entries].sort((a, b) => a.overview.pmRunId.localeCompare(b.overview.pmRunId));
    const rows = this.rows(), index = key ? rows.findIndex((row) => rowKey(row) === key) : -1;
    this.cursor = index >= 0 ? index : Math.max(0, Math.min(this.cursor, rows.length - 1));
  }

  hasRows(): boolean { return this.entries.length > 0; }

  private rows(): Row[] {
    return this.entries.flatMap((entry) => [{ kind: "pm" as const, entry }, ...entry.overview.pendingItems.map((item) => ({ kind: "item" as const, entry, item }))]);
  }

  handleInput(data: string): boolean {
    if (isKeyRelease(data)) return false;
    const rows = this.rows();
    if (matchesKey(data, "down")) { this.cursor = Math.min(this.cursor + 1, Math.max(0, rows.length - 1)); return true; }
    if (matchesKey(data, "up")) { this.cursor = Math.max(this.cursor - 1, 0); return true; }
    const row = rows[this.cursor];
    if (!row) return false;
    if (matchesKey(data, "enter")) { if (row.kind === "item") this.options.openItem(row.entry, row.item); return true; }
    if (data === "p" || data === "P") { this.options.togglePause(row.entry); return true; }
    return false;
  }

  render(width: number): string[] {
    const safeWidth = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
    if (safeWidth === 0 || this.entries.length === 0) return [];
    const rows = this.rows(), selected = this.focused ? rows[this.cursor] : undefined;
    const lines = [this.fit(`● ${this.entries.length} 个需求运行中`, safeWidth)];
    this.entries.forEach((entry, index) => {
      const last = index === this.entries.length - 1, branch = last ? "└─" : "├─", rail = last ? "  " : "│ ";
      const { overview } = entry;
      const icon = overview.status === "paused" || overview.status === "waiting" ? "⏸" : SPINNER[this.frame]!;
      const running = overview.status === "running" || overview.status === "pausing";
      const elapsed = overview.elapsedMs + (running ? Math.max(0, this.options.now() - entry.fetchedAt) : 0);
      const goals = overview.goals.length ? overview.goals.join("、") : overview.requirementId.slice(-8);
      const cache = overview.cacheRate === null ? "" : ` (${Math.round(overview.cacheRate * 100)}%)`;
      const head = `${branch} ${icon} ${goals} · ↻${overview.turns} · ${overview.toolUses} tool uses · ${formatTokens(overview.tokens)} token${cache} · ${formatElapsed(elapsed)}`;
      lines.push(this.mark(this.fit(head, safeWidth), selected !== undefined && selected.kind === "pm" && selected.entry === entry));
      lines.push(this.fit(`${rail}   └ ${overview.doing}`, safeWidth));
      overview.pendingItems.forEach((item, itemIndex) => {
        const itemBranch = itemIndex === overview.pendingItems.length - 1 ? "└" : "├";
        const isSelected = selected !== undefined && selected.kind === "item" && selected.item.itemId === item.itemId && selected.entry === entry;
        lines.push(this.mark(this.fit(`${rail}     ${itemBranch} ⚑ ${item.label}`, safeWidth), isSelected));
      });
    });
    if (this.focused) lines.push(this.dim(this.fit(HINT, safeWidth)));
    return lines;
  }

  private fit(text: string, width: number): string {
    return truncateToWidth(sanitizeText(text.replace(/[\x00-\x1f\x7f-\x9f]/g, ""), 4_096), width, "…", false);
  }
  private mark(line: string, selected: boolean): string {
    return selected && this.theme?.bg ? this.theme.bg("selectedBg", line) : selected ? `›${line.slice(1)}` : line;
  }
  private dim(line: string): string { return this.theme?.fg ? this.theme.fg("dim", line) : line; }
}

function rowKey(row: Row): string {
  return row.kind === "pm" ? `pm:${row.entry.overview.pmRunId}` : `item:${row.entry.overview.pmRunId}:${row.item.itemId}`;
}

interface HostTuiLike {
  hasOverlay?: () => boolean;
  getFocusedComponent?: () => { isShowingAutocomplete?: () => boolean } | null | undefined;
  requestRender?: () => void;
}
export interface MountPmPanelCtx {
  mode?: string;
  hasUI?: boolean;
  ui?: { setWidget?: import("@earendil-works/pi-coding-agent").ExtensionUIContext["setWidget"] };
}
export interface MountPmPanelHost { isOverlayOpen(): boolean; isCompletionOpen(): boolean; requestRender(): void }

const WIDGET_KEY = "pm-panel";

export function mountPmPanel(ctx: MountPmPanelCtx, options: PmPanelOptions): { panel: PmPanel; host: MountPmPanelHost; unmount: () => void } | null {
  const setWidget = ctx.ui?.setWidget;
  if (ctx.mode !== "tui" || !ctx.hasUI || !setWidget) return null;
  const panel = new PmPanel(options);
  let boundTui: HostTuiLike | undefined;
  const host: MountPmPanelHost = {
    isOverlayOpen: () => boundTui?.hasOverlay?.() ?? false,
    isCompletionOpen: () => {
      const focused = boundTui?.getFocusedComponent?.();
      return typeof focused?.isShowingAutocomplete === "function" && focused.isShowingAutocomplete();
    },
    requestRender: () => boundTui?.requestRender?.(),
  };
  setWidget(WIDGET_KEY, (tui: unknown, theme: unknown) => {
    boundTui = tui as HostTuiLike;
    panel.setTheme(theme as PmPanelTheme);
    panel.bindHost({ requestRender: host.requestRender });
    return panel as never;
  }, { placement: "belowEditor" });
  return { panel, host, unmount: () => setWidget(WIDGET_KEY, undefined) };
}
