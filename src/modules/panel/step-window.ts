import { isKeyRelease, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { openProgramWindow } from "../../core/host/question-window.ts";
import type { ProgramWindowHost } from "../../core/host/question-window.ts";
import type { Clock } from "../../core/policy/clock.ts";
import { sanitizeText } from "../../core/policy/text-sanitize.ts";
import type { RunStep, RunStepsState, RunStepsView } from "../agents/run-steps.ts";
import { SPINNER, formatElapsed } from "./pm-panel.ts";

export interface StepWindowTheme {
  fg?: (kind: string, text: string) => string;
  bold?: (text: string) => string;
}
export interface StepWindowOptions {
  title: string;
  now: () => number;
  onClose: () => void;
  theme?: StepWindowTheme;
}

type Paint = (kind: string, text: string) => string;

const FINISHED = new Set<RunStepsState>(["completed", "failed", "stopped", "interrupted"]);
const LIVE = new Set<RunStepsState>(["queued", "running"]);
const PAUSED = new Set<RunStepsState>(["pausing", "paused"]);
const DEFAULT_ROWS = 24;
const clean = (text: string): string => sanitizeText(text.replace(/[\x00-\x1f\x7f-\x9f]/g, " "));

const CJK = "\\u2E80-\\u9FFF\\uF900-\\uFAFF\\uFF00-\\uFFEF\\uAC00-\\uD7AF";
const UNITS = new RegExp(`\\s+|[${CJK}]|[^\\s${CJK}]+`, "gu");
const plain: Paint = (_kind, text) => text;
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function wrap(text: string, width: number): string[] {
  const max = Math.max(1, width);
  const lines: string[] = [];
  let line = "";
  let used = 0;
  const flush = () => { lines.push(line.trimEnd()); line = ""; used = 0; };
  const add = (piece: string, w: number) => { line += piece; used += w; };
  for (const unit of text.match(UNITS) ?? []) {
    const w = visibleWidth(unit);
    if (/^\s/.test(unit)) {
      if (used === 0 && lines.length > 0) continue;
      if (used + w <= max) add(unit, w); else flush();
    } else if (used + w <= max) add(unit, w);
    else if (w <= max) { flush(); add(unit, w); }
    else for (const { segment: ch } of graphemes.segment(unit)) {
      const cw = visibleWidth(ch);
      if (used + cw > max && used > 0) flush();
      add(ch, cw);
    }
  }
  lines.push(line);
  return lines;
}

interface StepLine { text: string; first: boolean; thinking: boolean }
interface Item { text: string; icon: string; color: string; indent?: boolean; thinking?: boolean }

function orderedSteps(steps: RunStep[]): Array<{ step: RunStep; indent: boolean }> {
  const ids = new Set(steps.map((step) => step.id));
  const out: Array<{ step: RunStep; indent: boolean }> = [];
  for (const step of steps) {
    if (step.parentId !== undefined && ids.has(step.parentId)) continue;
    out.push({ step, indent: false });
    for (const child of steps) if (child.parentId === step.id) out.push({ step: child, indent: true });
  }
  return out;
}

export class StepWindow {
  private readonly options: StepWindowOptions;
  private data: RunStepsView | undefined;
  private fetchedAt = 0;
  private error: string | undefined;
  private scroll = 0;
  private follow = true;
  private frame = 0;
  private rows = DEFAULT_ROWS;
  private width = 80;

  constructor(options: StepWindowOptions) { this.options = options; }

  apply(view: RunStepsView): void {
    this.data = view;
    this.fetchedAt = this.options.now();
  }

  fail(message: string): void { this.error = message; }

  finished(): boolean { return this.error !== undefined || (this.data !== undefined && FINISHED.has(this.data.state)); }

  tick(): void { this.frame = (this.frame + 1) % SPINNER.length; }

  resize(_width: number, rows: number): void { this.rows = rows; }

  handleInput(data: string): boolean {
    if (isKeyRelease(data)) return false;
    if (matchesKey(data, "escape")) { this.options.onClose(); return true; }
    if (this.error !== undefined) return false;
    const up = matchesKey(data, "up");
    if (!up && !matchesKey(data, "down")) return false;
    const { cw, areaHeight } = this.layout(this.width, plain);
    const max = this.maxStart(this.stepLines(plain, cw).length, areaHeight);
    const start = up ? Math.max(0, this.start(max) - 1) : Math.min(max, this.start(max) + 1);
    this.scroll = start;
    this.follow = start >= max;
    return true;
  }

  invalidate(): void {}

  render(width: number): string[] {
    this.width = width;
    const { theme } = this.options;
    const paint: Paint = (kind, text) => (theme?.fg && text ? theme.fg(kind, text) : text);
    const { cw, title, status, hint, areaHeight } = this.layout(width, paint);
    const area = this.error !== undefined
      ? wrap("守护进程重启后，之前的步骤就没有了。", cw).map((line) => paint("muted", line))
      : this.visible(paint, cw, areaHeight);
    const rule = (left: string, right: string) => paint("border", `${left}${"─".repeat(Math.max(0, width - 2))}${right}`);
    const row = (content: string) => {
      const fitted = visibleWidth(content) > cw ? truncateToWidth(content, cw, "", false) : content;
      return `${paint("border", "│")} ${fitted}${" ".repeat(Math.max(0, cw - visibleWidth(fitted)))} ${paint("border", "│")}`;
    };
    const lines = [rule("╭", "╮"), ...title.map(row), ...status.map(row), rule("├", "┤"), ...area.map(row), rule("├", "┤"), ...hint.map(row), rule("╰", "╯")];
    return lines.map((line) => (visibleWidth(line) > width ? truncateToWidth(line, width, "", false) : line));
  }

  private layout(width: number, paint: Paint) {
    const cw = Math.max(1, width - 4);
    const { bold } = this.options.theme ?? {};
    const title = wrap(clean(this.options.title), cw).map((line) => (bold ? bold(line) : line));
    const status = this.statusLines(cw, paint);
    const hint = wrap(this.data && this.error === undefined ? "↑↓ 滚动 · Esc 关闭" : "Esc 关闭", cw).map((line) => paint("dim", line));
    const areaHeight = Math.max(3, this.rows - 1 - (4 + title.length + status.length + hint.length));
    return { cw, title, status, hint, areaHeight };
  }

  private spin(): string { return SPINNER[this.frame]!; }

  private statusLines(cw: number, paint: Paint): string[] {
    const { text, head, kind } = this.statusParts();
    let left = head.replace(/\s/g, "").length;
    return wrap(text, cw).map((line) => {
      let i = 0;
      while (i < line.length && left > 0) { if (!/\s/.test(line[i]!)) left--; i++; }
      return i > 0 ? paint(kind, line.slice(0, i)) + line.slice(i) : line;
    });
  }

  private statusParts(): { text: string; head: string; kind: string } {
    if (this.error !== undefined) {
      const text = `✗ 读不到步骤：${clean(this.error)}`;
      return { text, head: text, kind: "error" };
    }
    const view = this.data;
    if (!view) return { text: "读取中…", head: "读取中…", kind: "dim" };
    const { state } = view;
    const [label, kind] = LIVE.has(state) ? [`${this.spin()} 运行中`, "accent"]
      : PAUSED.has(state) ? ["⏸ 已暂停", "warning"]
      : state === "completed" ? ["✓ 已完成", "success"]
      : [state === "failed" ? `✗ 失败：${clean(view.reason ?? "")}` : state === "stopped" ? "✗ 已停止" : "✗ 已中断", "error"];
    const turns = view.maxTurns === null ? `↻${view.turns}` : `↻${view.turns}/${view.maxTurns}`;
    const elapsed = view.elapsedMs + (LIVE.has(state) ? this.options.now() - this.fetchedAt : 0);
    return { text: `${label} · 共 ${view.steps.length} 步 · ${turns} · ${formatElapsed(elapsed)}`, head: LIVE.has(state) ? this.spin() : label!, kind: kind! };
  }

  private items(): Item[] {
    const view = this.data;
    if (!view) return [];
    const live = LIVE.has(view.state);
    const running = live ? { icon: this.spin(), color: "accent" } : PAUSED.has(view.state) ? { icon: "⏸", color: "warning" } : { icon: "✗", color: "error" };
    const items: Item[] = orderedSteps(view.steps).map(({ step, indent }) => ({
      text: clean(step.text),
      indent,
      ...(step.status === "done" ? { icon: "✓", color: "success" } : step.status === "error" ? { icon: "✗", color: "error" } : running),
    }));
    if (live && !view.steps.some((step) => step.status === "running")) items.push({ text: "思考中", icon: this.spin(), color: "accent", thinking: true });
    return items;
  }

  private stepLines(paint: Paint, cw: number): StepLine[] {
    const out: StepLine[] = [];
    for (const item of this.items()) {
      const lead = item.indent ? "  " : "";
      const hang = lead.length + visibleWidth(item.icon) + 1;
      wrap(item.text, cw - hang).forEach((part, i) => {
        const text = item.thinking ? paint("muted", part) : part;
        out.push({ first: i === 0, thinking: item.thinking === true, text: i === 0 ? `${lead}${paint(item.color, item.icon)} ${text}` : `${" ".repeat(hang)}${text}` });
      });
    }
    return out;
  }

  private maxStart(total: number, height: number): number { return total > height ? total - (height - 1) : 0; }

  private start(max: number): number { return this.follow ? max : Math.min(this.scroll, max); }

  private visible(paint: Paint, cw: number, height: number): string[] {
    const lines = this.stepLines(paint, cw);
    if (lines.length <= height) return lines.map((line) => line.text);
    const start = this.start(this.maxStart(lines.length, height));
    const top = start > 0;
    const room = height - (top ? 1 : 0);
    const bottom = start + room < lines.length;
    const end = start + room - (bottom ? 1 : 0);
    const steps = (from: number, to: number) => lines.slice(from, to).filter((line) => line.first && !line.thinking).length;
    return [
      ...(top ? [paint("dim", `↑ 上面还有 ${steps(0, start)} 步`)] : []),
      ...lines.slice(start, end).map((line) => line.text),
      ...(bottom ? [paint("dim", `↓ 下面还有 ${steps(end, lines.length)} 步`)] : []),
    ];
  }
}

export interface OpenStepWindowOptions {
  ctx: ProgramWindowHost;
  clock: Clock;
  client: { call(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> };
  runId: string;
  title: string;
  view?: RunStepsView;
}

const FETCH_INTERVAL_MS = 500;
const ANIMATION_INTERVAL_MS = 200;

export async function openStepWindow(options: OpenStepWindowOptions): Promise<void> {
  const { ctx, clock, client, runId, title, view } = options;
  const timers: Array<ReturnType<Clock["setIntervalExcludingSleep"]>> = [];
  const stopTimers = () => { for (const handle of timers.splice(0)) clock.clearTimer(handle); };
  try {
    await openProgramWindow<undefined>(
      ctx,
      (tui, theme, _keybindings, done) => {
        const hostTui = tui as { requestRender?: () => void; terminal?: { rows: number; columns: number } };
        const win = new StepWindow({ title, now: () => clock.now(), onClose: () => done(undefined), theme: theme as StepWindowTheme });
        if (hostTui.terminal) win.resize(hostTui.terminal.columns, hostTui.terminal.rows);
        if (view) win.apply(view);
        let fetching = false;
        const fetchSteps = async (): Promise<void> => {
          if (fetching || win.finished()) return;
          fetching = true;
          try { win.apply(await client.call("runs.steps", { runId }) as unknown as RunStepsView); }
          catch (error) { win.fail(error instanceof Error ? error.message : String(error)); }
          finally {
            fetching = false;
            hostTui.requestRender?.();
            if (win.finished()) stopTimers();
          }
        };
        void fetchSteps();
        timers.push(
          clock.setIntervalExcludingSleep(() => void fetchSteps(), FETCH_INTERVAL_MS),
          clock.setIntervalExcludingSleep(() => { win.tick(); hostTui.requestRender?.(); }, ANIMATION_INTERVAL_MS),
        );
        return win;
      },
      undefined,
      { overlay: false },
    );
  } finally {
    stopTimers();
  }
}
