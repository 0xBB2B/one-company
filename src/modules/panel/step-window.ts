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
  private areaHeight = Math.max(3, DEFAULT_ROWS - 8);

  constructor(options: StepWindowOptions) { this.options = options; }

  apply(view: RunStepsView): void {
    this.data = view;
    this.fetchedAt = this.options.now();
  }

  fail(message: string): void { this.error = message; }

  finished(): boolean { return this.error !== undefined || (this.data !== undefined && FINISHED.has(this.data.state)); }

  tick(): void { this.frame = (this.frame + 1) % SPINNER.length; }

  resize(_width: number, rows: number): void { this.areaHeight = Math.max(3, rows - 8); }

  handleInput(data: string): boolean {
    if (isKeyRelease(data)) return false;
    if (matchesKey(data, "escape")) { this.options.onClose(); return true; }
    if (this.error !== undefined) return false;
    const up = matchesKey(data, "up");
    if (!up && !matchesKey(data, "down")) return false;
    const max = this.maxStart(this.items().length);
    const start = up ? Math.max(0, this.start(max) - 1) : Math.min(max, this.start(max) + 1);
    this.scroll = start;
    this.follow = start >= max;
    return true;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const { theme } = this.options;
    const paint: Paint = (kind, text) => (theme?.fg && text ? theme.fg(kind, text) : text);
    const rule = (head: string) => paint("border", head + "─".repeat(Math.max(0, width - 1)));
    const row = (content: string) => {
      const line = `${paint("border", "│")} ${content}`;
      return visibleWidth(line) <= width ? line : `${truncateToWidth(line, Math.max(0, width - 1), "", false)}…`;
    };
    const title = theme?.bold ? theme.bold(clean(this.options.title)) : clean(this.options.title);
    const area = this.error !== undefined ? [paint("muted", "守护进程重启后，之前的步骤就没有了。")] : this.visible(paint);
    const hint = this.data && this.error === undefined ? "↑↓ 滚动 · Esc 关闭" : "Esc 关闭";
    return [rule("╭"), row(title), row(this.statusLine(paint)), rule("├"), ...area.map(row), rule("├"), row(paint("dim", hint)), rule("╰")];
  }

  private spin(): string { return SPINNER[this.frame]!; }

  private statusLine(paint: Paint): string {
    if (this.error !== undefined) return paint("error", `✗ 读不到步骤：${clean(this.error)}`);
    const view = this.data;
    if (!view) return paint("dim", "读取中…");
    const { state } = view;
    const head = LIVE.has(state) ? `${paint("accent", this.spin())} 运行中`
      : PAUSED.has(state) ? paint("warning", "⏸ 已暂停")
      : state === "completed" ? paint("success", "✓ 已完成")
      : paint("error", state === "failed" ? `✗ 失败：${clean(view.reason ?? "")}` : state === "stopped" ? "✗ 已停止" : "✗ 已中断");
    const turns = view.maxTurns === null ? `↻${view.turns}` : `↻${view.turns}/${view.maxTurns}`;
    const elapsed = view.elapsedMs + (LIVE.has(state) ? this.options.now() - this.fetchedAt : 0);
    return `${head} · 共 ${view.steps.length} 步 · ${turns} · ${formatElapsed(elapsed)}`;
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

  private maxStart(total: number): number { return total > this.areaHeight ? total - (this.areaHeight - 1) : 0; }

  private start(max: number): number { return this.follow ? max : Math.min(this.scroll, max); }

  private visible(paint: Paint): string[] {
    const items = this.items();
    const render = (item: Item) => `${item.indent ? "  " : ""}${paint(item.color, item.icon)} ${item.thinking ? paint("muted", item.text) : item.text}`;
    if (items.length <= this.areaHeight) return items.map(render);
    const start = this.start(this.maxStart(items.length));
    const top = start > 0;
    const room = this.areaHeight - (top ? 1 : 0);
    const bottom = start + room < items.length;
    const content = items.slice(start, start + room - (bottom ? 1 : 0));
    return [
      ...(top ? [paint("dim", `↑ 上面还有 ${start} 步`)] : []),
      ...content.map(render),
      ...(bottom ? [paint("dim", `↓ 下面还有 ${items.slice(start + content.length).filter((item) => !item.thinking).length} 步`)] : []),
    ];
  }
}

export interface OpenStepWindowOptions {
  ctx: ProgramWindowHost;
  dock: { markPageOpen(): void; markPageClosed(): void };
  clock: Clock;
  client: { call(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> };
  runId: string;
  title: string;
}

const FETCH_INTERVAL_MS = 500;
const ANIMATION_INTERVAL_MS = 200;

export async function openStepWindow(options: OpenStepWindowOptions): Promise<void> {
  const { ctx, dock, clock, client, runId, title } = options;
  const timers: Array<ReturnType<Clock["setIntervalExcludingSleep"]>> = [];
  const stopTimers = () => { for (const handle of timers.splice(0)) clock.clearTimer(handle); };
  try {
    await openProgramWindow<undefined>(
      ctx,
      (tui, theme, _keybindings, done) => {
        const hostTui = tui as { requestRender?: () => void; terminal?: { rows: number; columns: number } };
        const win = new StepWindow({ title, now: () => clock.now(), onClose: () => done(undefined), theme: theme as StepWindowTheme });
        dock.markPageOpen();
        if (hostTui.terminal) win.resize(hostTui.terminal.columns, hostTui.terminal.rows);
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
    dock.markPageClosed();
  }
}
