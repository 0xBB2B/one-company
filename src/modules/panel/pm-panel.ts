import { isKeyRelease, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { MainExploreOverview } from "../explore/explore-dispatch.ts";
import type { MainPrototypeOverview } from "../prototype/prototype-dispatch.ts";
import type { PanelReviewerRow, PanelReviewerState, PanelRunStats, PendingItem, PmOverview } from "./pm-overview.ts";
import { REVIEW_SUPERSEDED_TEXT, REVIEW_UNFINISHED_TEXT } from "../pm/review-outcome-text.ts";
import { sanitizeText } from "../../core/policy/text-sanitize.ts";

export interface PmPanelEntry { repoId: string; overview: PmOverview; fetchedAt: number }
export interface ExplorePanelEntry { repoId: string; explore: MainExploreOverview; fetchedAt: number }
export interface PrototypePanelEntry { repoId: string; prototype: MainPrototypeOverview; fetchedAt: number }
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

export const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const RETRY_TEXT = { ...REVIEW_UNFINISHED_TEXT, superseded: REVIEW_SUPERSEDED_TEXT } as const;
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

/** 输入栏下方的状态面板：显示运行中与暂停的 PM，以及本窗口派出、还在运行的检索和原型设计；数据来自守护进程，窗口只做投影，不保存事项。 */
export class PmPanel {
  private readonly options: PmPanelOptions;
  private entries: PmPanelEntry[] = [];
  private explores: ExplorePanelEntry[] = [];
  private prototypes: PrototypePanelEntry[] = [];
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

  updateExplores(entries: ExplorePanelEntry[]): void {
    this.explores = [...entries].sort((a, b) => a.explore.runId.localeCompare(b.explore.runId));
  }

  updatePrototypes(entries: PrototypePanelEntry[]): void { this.prototypes = [...entries]; }

  /** 只有 PM 与事项行可选；检索和原型设计行没有可做的操作。 */
  hasRows(): boolean { return this.entries.length > 0; }

  private rows(): Row[] {
    return this.entries.flatMap((entry) => [{ kind: "pm" as const, entry }, ...selectableItems(entry.overview).map((item) => ({ kind: "item" as const, entry, item }))]);
  }

  private runSuffix(stats: Partial<PanelRunStats>, running: boolean, fetchedAt: number): string {
    const parts: string[] = [];
    if (stats.turns !== undefined) parts.push(`↻${stats.turns}${stats.maxTurns == null ? "" : `/${stats.maxTurns}`}`);
    if (stats.elapsedMs !== undefined) parts.push(formatElapsed(stats.elapsedMs + (running ? Math.max(0, this.options.now() - fetchedAt) : 0)));
    return parts.map((part) => ` · ${part}`).join("");
  }

  private reviewerLine(prefix: string, row: PanelReviewerRow, entry: PmPanelEntry, width: number): string {
    const suffix = this.runSuffix(row, row.state === "running", entry.fetchedAt);
    const text: Record<PanelReviewerState, string> = {
      running: `${SPINNER[this.frame]} ${row.agent}${row.attempt ? `（第 ${row.attempt} 次）${suffix.trimStart()}` : suffix}`,
      clear: ` ${row.agent} 通过${suffix}`,
      blocked: `✗ ${row.agent} 打回${suffix}`,
      awaiting_retry: `– ${row.agent} ${row.reason ? RETRY_TEXT[row.reason] : ""}，等 PM 重派${suffix}`,
      exhausted: `– ${row.agent} ${row.attempt} 次没交出结论，本轮结束后交你裁决${suffix}`,
      skipped_disabled: `– ${row.agent} 已关闭，本轮未审`,
      skipped_missing: `– ${row.agent} 已不存在，本轮未审`,
    };
    const body = text[row.state];
    const kind = row.state === "awaiting_retry" ? "dim" : row.state === "exhausted" || row.state === "skipped_disabled" || row.state === "skipped_missing" ? "warning" : undefined;
    return this.segments(row.state === "clear" ? [["dim", prefix], ["success", "✓"], ["muted", body]] : [["dim", prefix], [kind, body]], width);
  }

  /** 各段分别按剩余宽度截断后再着色，着色码不会被截断切开。 */
  private segments(parts: Array<[string | undefined, string]>, width: number): string {
    let used = 0;
    return parts.map(([kind, text]) => {
      const fitted = width > used ? this.fit(text, width - used) : "";
      used += visibleWidth(fitted);
      return kind ? this.paint(kind, fitted) : fitted;
    }).join("");
  }

  private taskLines(entry: PmPanelEntry, rail: string, selected: Row | undefined, width: number): string[] {
    const { overview, fetchedAt } = entry;
    const byId = new Map(overview.pendingItems.map((item) => [item.itemId, item]));
    const nodes: Array<{ text: string; item?: PendingItem; reviewers?: PanelReviewerRow[] }> = overview.taskRows.map((row) => {
      if (row.kind === "execute") return { text: `${SPINNER[this.frame]} ${row.taskKey} 执行 · ${row.agent}（第 ${row.attempt} 次尝试）${this.runSuffix(row, true, fetchedAt).trimStart()}` };
      if (row.kind === "review") return { text: `${row.taskKey} 第 ${row.round} 轮审查`, reviewers: row.reviewers };
      if (row.kind === "pending") return { text: `⚑ ${row.taskKey} ${row.text}`, item: byId.get(row.itemId) };
      return { text: `${SPINNER[this.frame]} explore 检索${this.runSuffix(row, true, fetchedAt)}` };
    });
    for (const item of overview.pendingItems) if (item.taskKey === undefined) nodes.push({ text: `⚑ ${item.label}`, item });
    return nodes.flatMap((node, index) => {
      const last = index === nodes.length - 1;
      const prefix = `${rail}   ${last ? "└" : "├"} `;
      const isSelected = node.item !== undefined && selected !== undefined && selected.kind === "item" && selected.entry === entry && selected.item.itemId === node.item.itemId;
      const line = isSelected ? this.mark(this.fit(prefix + node.text, width), true) : this.segments([["dim", prefix], [undefined, node.text]], width);
      const sub = `${rail}   ${last ? "  " : "│ "}`;
      return [line, ...(node.reviewers ?? []).map((reviewer, i) => this.reviewerLine(`${sub}${i === node.reviewers!.length - 1 ? "└" : "├"} `, reviewer, entry, width))];
    });
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
    if (safeWidth === 0 || (this.entries.length === 0 && this.explores.length === 0 && this.prototypes.length === 0)) return [];
    const rows = this.rows(), selected = this.focused ? rows[this.cursor] : undefined;
    const lines = this.entries.length ? [this.fit(`● ${this.entries.length} 个需求运行中`, safeWidth)] : [];
    this.entries.forEach((entry, index) => {
      const last = index === this.entries.length - 1, branch = last ? "└─" : "├─", rail = last ? "  " : "│ ";
      const { overview } = entry;
      const icon = overview.status === "paused" || overview.status === "waiting" ? "⏸" : SPINNER[this.frame]!;
      const running = overview.status === "running" || overview.status === "pausing";
      const elapsed = overview.elapsedMs + (running ? Math.max(0, this.options.now() - entry.fetchedAt) : 0);
      const goals = overview.goals.length ? overview.goals.join("、") : overview.requirementId.slice(-8);
      const cache = overview.cacheRate === null ? "" : ` (${Math.round(overview.cacheRate * 100)}%)`;
      const head = `${branch} ${icon} ${goals}${overview.taskProgress ? ` · 任务 ${overview.taskProgress.completed}/${overview.taskProgress.total}` : ""} · ↻${overview.turns} · ${overview.toolUses} tool uses · ${formatTokens(overview.tokens)} token${cache} · ${formatElapsed(elapsed)}`;
      lines.push(this.mark(this.fit(head, safeWidth), selected !== undefined && selected.kind === "pm" && selected.entry === entry));
      if (overview.taskRows.length) { lines.push(...this.taskLines(entry, rail, selected, safeWidth)); return; }
      lines.push(this.fit(`${rail}   └ ${overview.doing}`, safeWidth));
      overview.pendingItems.forEach((item, itemIndex) => {
        const itemBranch = itemIndex === overview.pendingItems.length - 1 ? "└" : "├";
        const isSelected = selected !== undefined && selected.kind === "item" && selected.item.itemId === item.itemId && selected.entry === entry;
        lines.push(this.mark(this.fit(`${rail}     ${itemBranch} ⚑ ${item.label}`, safeWidth), isSelected));
      });
    });
    if (this.prototypes.length) lines.push(this.fit(`● ${this.prototypes.length} 个原型设计运行中`, safeWidth));
    this.prototypes.forEach(({ prototype, fetchedAt }, index) => {
      const branch = index === this.prototypes.length - 1 ? "└─" : "├─";
      const elapsed = prototype.elapsedMs + Math.max(0, this.options.now() - fetchedAt);
      lines.push(this.fit(`${branch} ${SPINNER[this.frame]} ${prototype.name}（第 ${prototype.version} 版）· ${prototype.agent} · ↻${prototype.turns}/${prototype.maxTurns} · ${formatElapsed(elapsed)}`, safeWidth));
    });
    if (this.explores.length) lines.push(this.fit(`● ${this.explores.length} 个检索运行中`, safeWidth));
    this.explores.forEach(({ explore, fetchedAt }, index) => {
      const branch = index === this.explores.length - 1 ? "└─" : "├─";
      const elapsed = explore.elapsedMs + Math.max(0, this.options.now() - fetchedAt);
      const source = explore.source === "web" ? "联网" : "本地";
      lines.push(this.fit(`${branch} ${SPINNER[this.frame]} ${source} · ${explore.question.replace(/\s+/g, " ")} · ↻${explore.turns}/${explore.maxTurns} · ${formatElapsed(elapsed)}`, safeWidth));
    });
    if (this.focused) lines.push(this.paint("dim", this.fit(HINT, safeWidth)));
    return lines;
  }

  private fit(text: string, width: number): string {
    return truncateToWidth(sanitizeText(text.replace(/[\x00-\x1f\x7f-\x9f]/g, ""), 4_096), width, "…", false);
  }
  private mark(line: string, selected: boolean): string {
    return selected && this.theme?.bg ? this.theme.bg("selectedBg", line) : selected ? `›${line.slice(1)}` : line;
  }
  private paint(kind: string, text: string): string { return text && this.theme?.fg ? this.theme.fg(kind, text) : text; }
}

function selectableItems(overview: PmOverview): PendingItem[] {
  if (!overview.taskRows.length) return overview.pendingItems;
  const byId = new Map(overview.pendingItems.map((item) => [item.itemId, item]));
  const taskLevel = overview.taskRows.flatMap((row) => (row.kind === "pending" && byId.has(row.itemId) ? [byId.get(row.itemId)!] : []));
  return [...taskLevel, ...overview.pendingItems.filter((item) => item.taskKey === undefined)];
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
