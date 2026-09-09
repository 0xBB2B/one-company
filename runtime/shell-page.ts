import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import type { Clock } from "./clock.ts";
import type { Host, ShellRegistry, TaskActivity, TaskRecord, TaskStatus } from "./shell-registry.ts";
import { sanitizeText } from "./text-sanitize.ts";

export interface ShellPageClient {
  call(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export interface ShellPageRepo {
  repoId: string;
  requirementTitle?: string;
  client: ShellPageClient;
}

export type ShellPageDecisionResult = { ok: true; decisionId: string } | { ok: false; reason: string };

export interface ShellPageDecisionTask {
  taskId: string;
  host: Host;
  command: string;
  requirement: string;
}

export interface ShellPageTheme {
  bg?(kind: string, text: string): string;
}

export interface ShellPageOptions {
  registry: ShellRegistry;
  repos: ShellPageRepo[];
  clock: Clock;
  recordStopDecision: (task: ShellPageDecisionTask) => Promise<ShellPageDecisionResult>;
  theme?: ShellPageTheme;
  onClose?: () => void;
  onChange?: () => void;
}

interface DaemonTaskPayload {
  taskId: string;
  host: Host;
  command: string;
  cwd: string;
  pid: number;
  startedAt: string;
  status: TaskStatus;
  activity: TaskActivity;
  inWorkspace?: boolean;
  reason?: string;
}

type RowSource = { kind: "local" } | { kind: "daemon"; repo: ShellPageRepo };

interface ShellRow {
  taskId: string;
  host: Host;
  command: string;
  cwd: string;
  pid: number;
  startedAt: string;
  status: TaskStatus;
  activity: TaskActivity;
  reason?: string;
  source: RowSource;
}

type PageMode = "list" | "detail" | "confirm";
type ConfirmSelection = "cancel" | "confirm";

const STATUS_LABEL: Record<TaskStatus, string> = {
  starting: "启动中",
  running: "运行中",
  stopping: "停止中",
  uncertain: "不确定",
  exited: "已结束",
  failed: "失败",
  stopped: "已停止",
  timed_out: "超时停止",
};

const ENDED_STATUSES = new Set<TaskStatus>(["exited", "stopped", "failed", "timed_out"]);
const ENDED_TTL_MS = 20_000;
const MAIN_SESSION_REQUIREMENT = "shell-ops";

export function hostLabel(host: Host, requirementTitle?: string): string {
  if (host.kind === "main") return "主 agent";
  if (host.kind === "requirement") {
    const title = requirementTitle ? sanitizeText(requirementTitle) : undefined;
    return title ? `需求代理 ${title}` : "需求代理";
  }
  const role = sanitizeText(host.role ?? "worker");
  const code = (host.runId ?? host.id).replace(/-/g, "").slice(0, 6);
  return `${role}#${code}`;
}

function rowFromTaskRecord(task: TaskRecord): ShellRow {
  return {
    taskId: task.taskId,
    host: task.host,
    command: sanitizeText(task.command),
    cwd: sanitizeText(task.cwd),
    pid: task.pid,
    startedAt: task.startedAt !== null ? new Date(task.startedAt).toISOString() : "",
    status: task.status,
    activity: task.activity,
    reason: task.reason !== undefined ? sanitizeText(task.reason) : undefined,
    source: { kind: "local" },
  };
}

function rowFromDaemonPayload(repo: ShellPageRepo, task: DaemonTaskPayload): ShellRow {
  return {
    taskId: task.taskId,
    host: task.host,
    command: sanitizeText(task.command),
    cwd: sanitizeText(task.cwd),
    pid: task.pid,
    startedAt: task.startedAt,
    status: task.status,
    activity: task.activity,
    reason: task.reason !== undefined ? sanitizeText(task.reason) : undefined,
    source: { kind: "daemon", repo },
  };
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return totalSeconds < 3600 ? `${minutes}m${seconds}s` : `${hours}h${minutes}m${seconds}s`;
}

// 从光标行向两侧扩展直到用满行预算：多行 reason 行也按实际占用行数计入，
// 保证按 ↓ 移动光标到末项时，末项所在的行组一定被纳入可见窗口
function computeLineWindow(groups: string[][], selected: number, limit: number): { start: number; end: number } {
  if (groups.length === 0) return { start: 0, end: 0 };
  let start = selected;
  let end = selected + 1;
  let used = groups[selected]?.length ?? 0;
  while (start > 0 && used + (groups[start - 1]?.length ?? 0) <= limit) {
    start -= 1;
    used += groups[start]?.length ?? 0;
  }
  while (end < groups.length && used + (groups[end]?.length ?? 0) <= limit) {
    used += groups[end]?.length ?? 0;
    end += 1;
  }
  return { start, end };
}

const DEFAULT_WIDTH = 80;
const DEFAULT_HEIGHT = 24;

export class ShellPage {
  private readonly registry: ShellRegistry;
  private readonly repos: ShellPageRepo[];
  private readonly clock: Clock;
  private readonly recordStopDecision: ShellPageOptions["recordStopDecision"];
  private readonly theme: ShellPageTheme | undefined;
  private readonly onClose: (() => void) | undefined;
  private readonly onChange: (() => void) | undefined;

  private rows: ShellRow[] = [];
  private errors: string[] = [];
  private selectedIndex = 0;
  private mode: PageMode = "list";
  private width = DEFAULT_WIDTH;
  private height = DEFAULT_HEIGHT;

  private detailTaskId: string | undefined;
  private detailSnapshot: ShellRow | undefined;
  private detailIndex = 0;

  private confirmTarget: ShellRow | undefined;
  private confirmSelection: ConfirmSelection = "cancel";
  private readonly pendingStops = new Set<string>();
  private readonly pendingDecisions = new Set<string>();
  private readonly noticeOverlay = new Map<string, string>();
  private readonly endedAt = new Map<string, number>();

  constructor(options: ShellPageOptions) {
    this.registry = options.registry;
    this.repos = options.repos;
    this.clock = options.clock;
    this.recordStopDecision = options.recordStopDecision;
    this.theme = options.theme;
    this.onClose = options.onClose;
    this.onChange = options.onChange;
  }

  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
  }

  async refresh(): Promise<void> {
    const rawRows: ShellRow[] = [];
    for (const task of this.registry.list()) rawRows.push(rowFromTaskRecord(task));

    const errors: string[] = [];
    for (const repo of this.repos) {
      try {
        const result = await repo.client.call("shells.list");
        const tasks = (result.tasks ?? []) as DaemonTaskPayload[];
        for (const task of tasks) {
          if (task.inWorkspace === false) continue;
          rawRows.push(rowFromDaemonPayload(repo, task));
        }
      } catch (error) {
        errors.push(`${repo.repoId}：${(error as Error).message}`);
      }
    }

    const now = this.clock.now();
    const rows = rawRows.filter((row) => {
      if (!ENDED_STATUSES.has(row.status)) {
        this.endedAt.delete(row.taskId);
        return true;
      }
      let at = this.endedAt.get(row.taskId);
      if (at === undefined) {
        at = now;
        this.endedAt.set(row.taskId, at);
      }
      return now - at < ENDED_TTL_MS;
    });

    this.rows = rows;
    this.errors = errors;
    if (this.selectedIndex >= rows.length) this.selectedIndex = Math.max(0, rows.length - 1);

    const liveIds = new Set(rows.map((row) => row.taskId));
    for (const taskId of this.noticeOverlay.keys()) if (!liveIds.has(taskId)) this.noticeOverlay.delete(taskId);
    for (const taskId of this.endedAt.keys()) if (!liveIds.has(taskId)) this.endedAt.delete(taskId);
  }

  handleInput(data: string): boolean {
    if (this.mode === "detail") return this.handleDetailInput(data);
    if (this.mode === "confirm") return this.handleConfirmInput(data);
    return this.handleListInput(data);
  }

  render(width: number): string[] {
    if (this.mode === "detail") return this.renderDetail(width);
    if (this.mode === "confirm") return this.renderConfirm(width);
    return this.renderList(width);
  }

  invalidate(): void {}

  private handleListInput(data: string): boolean {
    if (matchesKey(data, "down")) {
      if (this.rows.length > 0) this.selectedIndex = Math.min(this.selectedIndex + 1, this.rows.length - 1);
      return true;
    }
    if (matchesKey(data, "up")) {
      if (this.rows.length > 0) this.selectedIndex = Math.max(this.selectedIndex - 1, 0);
      return true;
    }
    if (matchesKey(data, "enter")) {
      const row = this.rows[this.selectedIndex];
      if (row) {
        this.detailTaskId = row.taskId;
        this.detailSnapshot = row;
        this.detailIndex = this.selectedIndex;
        this.mode = "detail";
      }
      return true;
    }
    if (data === "K") {
      if (this.rows.length > 0) {
        this.confirmTarget = this.rows[this.selectedIndex];
        this.confirmSelection = "cancel";
        this.mode = "confirm";
      }
      return true;
    }
    if (matchesKey(data, "escape")) {
      this.onClose?.();
      return true;
    }
    return false;
  }

  private handleDetailInput(data: string): boolean {
    if (matchesKey(data, "escape")) {
      this.mode = "list";
      return true;
    }
    return false;
  }

  private handleConfirmInput(data: string): boolean {
    if (matchesKey(data, "left") || matchesKey(data, "right")) {
      this.confirmSelection = this.confirmSelection === "cancel" ? "confirm" : "cancel";
      return true;
    }
    if (matchesKey(data, "enter")) {
      const target = this.confirmTarget;
      const selection = this.confirmSelection;
      this.mode = "list";
      this.confirmTarget = undefined;
      if (target && selection === "confirm") {
        if (target.activity === "uncertain") void this.markStoppedByUser(target);
        else void this.requestStop(target);
      }
      return true;
    }
    if (matchesKey(data, "escape")) {
      this.mode = "list";
      this.confirmTarget = undefined;
      return true;
    }
    return false;
  }

  private applyRowUpdate(taskId: string, row: ShellRow): void {
    this.noticeOverlay.delete(taskId);
    const index = this.rows.findIndex((r) => r.taskId === taskId);
    if (index !== -1) this.rows[index] = row;
  }

  private setFailureNotice(taskId: string, reason: string): void {
    this.noticeOverlay.set(taskId, sanitizeText(reason));
  }

  private async requestStop(target: ShellRow): Promise<void> {
    this.pendingStops.add(target.taskId);
    this.onChange?.();
    try {
      if (target.source.kind === "local") {
        const result = await this.registry.stop(target.taskId);
        if (result.ok) this.applyRowUpdate(target.taskId, rowFromTaskRecord(result.task));
        else this.setFailureNotice(target.taskId, result.reason);
      } else {
        const repo = target.source.repo;
        try {
          const result = await repo.client.call("shells.stop", {
            taskId: target.taskId,
            expectedPid: target.pid,
            expectedStartedAt: target.startedAt,
          });
          const task = result.task as DaemonTaskPayload | undefined;
          if (task) this.applyRowUpdate(target.taskId, rowFromDaemonPayload(repo, task));
        } catch (error) {
          this.setFailureNotice(target.taskId, (error as Error).message);
        }
      }
    } finally {
      this.pendingStops.delete(target.taskId);
      this.onChange?.();
    }
  }

  private async markStoppedByUser(target: ShellRow): Promise<void> {
    if (this.pendingDecisions.has(target.taskId)) return;
    this.pendingDecisions.add(target.taskId);
    this.onChange?.();
    try {
      const requirement = target.source.kind === "local" ? MAIN_SESSION_REQUIREMENT : target.host.id;
      const decision = await this.recordStopDecision({
        taskId: target.taskId,
        host: target.host,
        command: target.command,
        requirement,
      });
      if (!decision.ok) {
        this.setFailureNotice(target.taskId, decision.reason);
        return;
      }
      if (target.source.kind === "local") {
        const result = this.registry.markStoppedByUser(target.taskId, { decisionId: decision.decisionId });
        if (result.ok) this.applyRowUpdate(target.taskId, rowFromTaskRecord(result.task));
        else this.setFailureNotice(target.taskId, result.reason);
        return;
      }
      const repo = target.source.repo;
      try {
        const result = await repo.client.call("shells.markStopped", {
          taskId: target.taskId,
          expectedPid: target.pid,
          expectedStartedAt: target.startedAt,
          decisionId: decision.decisionId,
        });
        const task = result.task as DaemonTaskPayload | undefined;
        if (task) this.applyRowUpdate(target.taskId, rowFromDaemonPayload(repo, task));
      } catch (error) {
        this.setFailureNotice(target.taskId, (error as Error).message);
      }
    } finally {
      this.pendingDecisions.delete(target.taskId);
      this.onChange?.();
    }
  }

  private rowHostLabel(row: ShellRow): string {
    const title = row.source.kind === "daemon" ? row.source.repo.requirementTitle : undefined;
    return hostLabel(row.host, title);
  }

  private rowStatusLabel(row: ShellRow): string {
    if (this.pendingStops.has(row.taskId)) return "停止中";
    if (this.pendingDecisions.has(row.taskId)) return "处理中";
    if (this.noticeOverlay.has(row.taskId)) return "不确定";
    return STATUS_LABEL[row.status];
  }

  private rowReasonText(row: ShellRow): string | undefined {
    return this.noticeOverlay.get(row.taskId) ?? row.reason;
  }

  private rowElapsed(row: ShellRow): string {
    const elapsedSource = Date.parse(row.startedAt);
    return Number.isFinite(elapsedSource) ? formatElapsed(this.clock.now() - elapsedSource) : "未知";
  }

  private renderList(width: number): string[] {
    if (this.rows.length === 0) {
      if (this.errors.length > 0) return this.errors.map((error) => truncateToWidth(sanitizeText(error), width, "", false));
      return ["无活动 Shell"];
    }

    const groups = this.rows.map((row, i) => this.renderListRow(row, i, i === this.selectedIndex, width));
    const errorLines = this.errors.map((error) => truncateToWidth(sanitizeText(error), width, "", false));
    const limit = Math.max(1, this.height - errorLines.length);
    const clampedSelected = Math.min(this.selectedIndex, groups.length - 1);
    const { start, end } = computeLineWindow(groups, clampedSelected, limit);

    const lines: string[] = [];
    for (let i = start; i < end; i++) lines.push(...(groups[i] ?? []));
    lines.push(...errorLines);
    return lines;
  }

  // reason 独立成行：与命令行拼在一起容易在 CJK 文本下把 reason 挤出 truncateToWidth 的可见宽度
  private renderListRow(row: ShellRow, index: number, isSelected: boolean, width: number): string[] {
    const content = [this.rowHostLabel(row), this.rowStatusLabel(row), this.rowElapsed(row), row.command].join("  ");
    const highlighted = isSelected && this.theme?.bg ? this.theme.bg("selectedBg", content) : content;
    const mainLine = truncateToWidth(`${index + 1}  ${highlighted}`, width, "", false);
    const reason = this.rowReasonText(row);
    if (!reason) return [mainLine];
    return [mainLine, truncateToWidth(`   ${reason}`, width, "", false)];
  }

  private renderDetail(width: number): string[] {
    if (!this.detailTaskId) {
      this.mode = "list";
      return this.renderList(width);
    }
    const live = this.rows.find((r) => r.taskId === this.detailTaskId);
    const row = live ?? this.detailSnapshot;
    if (!row) {
      this.mode = "list";
      return this.renderList(width);
    }
    const statusText = live ? this.rowStatusLabel(live) : "无法核对";
    return [
      `${this.detailIndex + 1}  ${this.rowHostLabel(row)}`,
      `状态：${statusText}`,
      `命令：${row.command}`,
      `目录：${row.cwd}`,
      `进程号：${row.pid}`,
      `耗时：${this.rowElapsed(row)}`,
      "Esc 返回",
    ];
  }

  private renderConfirm(width: number): string[] {
    const target = this.confirmTarget;
    if (!target) {
      this.mode = "list";
      return this.renderList(width);
    }
    const index = this.rows.findIndex((r) => r.taskId === target.taskId);
    const confirmLabel = target.activity === "uncertain" ? "视为已停止" : "停止";
    const cancelText = this.decorateOption("取消", this.confirmSelection === "cancel");
    const confirmText = this.decorateOption(confirmLabel, this.confirmSelection === "confirm");
    const line = `${(index === -1 ? this.selectedIndex : index) + 1}  ${this.rowHostLabel(target)}  ${target.command}`;
    return [truncateToWidth(line, width, "", false), `${cancelText}  ${confirmText}`];
  }

  private decorateOption(label: string, isSelected: boolean): string {
    return isSelected && this.theme?.bg ? this.theme.bg("selectedBg", label) : label;
  }
}

export interface OpenShellPageTui {
  requestRender?: () => void;
  terminal?: { rows: number; columns: number };
}

export interface OpenShellPageCtx {
  ui: {
    custom<T>(
      factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (result: T) => void) => ShellPage,
      options?: { overlay?: boolean },
    ): Promise<T>;
    theme?: { fg(kind: string, text: string): string; bg(kind: string, text: string): string };
  };
}

export interface OpenShellPageDock {
  markPageOpen(): void;
  markPageClosed(): void;
}

export interface OpenShellPageOptions {
  ctx: OpenShellPageCtx;
  registry: ShellRegistry;
  repos: ShellPageRepo[];
  clock: Clock;
  dock: OpenShellPageDock;
  recordStopDecision: ShellPageOptions["recordStopDecision"];
  theme?: ShellPageTheme;
}

const PAGE_REFRESH_INTERVAL_MS = 1_000;

export async function openShellPage(options: OpenShellPageOptions): Promise<void> {
  const { ctx, dock, clock, ...pageOptions } = options;
  let stopRefresh: (() => void) | undefined;
  try {
    await ctx.ui.custom<undefined>(
      (tui, _theme, _keybindings, done) => {
        const hostTui = tui as OpenShellPageTui;
        const page = new ShellPage({
          ...pageOptions,
          clock,
          onClose: () => done(undefined),
          onChange: () => hostTui.requestRender?.(),
        });
        dock.markPageOpen();

        if (hostTui.terminal) page.resize(hostTui.terminal.columns, hostTui.terminal.rows);

        const tick = (): void => {
          void page.refresh().then(() => hostTui.requestRender?.());
        };
        tick();
        const handle = clock.setIntervalExcludingSleep(tick, PAGE_REFRESH_INTERVAL_MS);
        stopRefresh = () => clock.clearTimer(handle);

        return page;
      },
      { overlay: false },
    );
  } finally {
    stopRefresh?.();
    dock.markPageClosed();
  }
}
