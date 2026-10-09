import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import type { Clock } from "./clock.ts";
import type { DaemonConnectionIdentity } from "./daemon-client.ts";
import type { Host, ShellRegistry, TaskActivity, TaskRecord, TaskStatus } from "./shell-registry.ts";
import { sanitizeText } from "./text-sanitize.ts";

export interface ShellPageClient {
  call(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
  connectionIdentity(): Readonly<DaemonConnectionIdentity> | null;
}

export interface ShellPageRepo {
  repoId: string;
  resolveClient: () => ShellPageClient | undefined;
}

export interface ShellPageTheme {
  bg?(kind: string, text: string): string;
}

export interface ShellPageOptions {
  registry: ShellRegistry;
  repos: ShellPageRepo[];
  clock: Clock;
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
  startedAt: string | number | null;
  status: TaskStatus;
  activity: TaskActivity;
  inWorkspace?: boolean;
  reason?: string;
}

type RowSource =
  | { kind: "local"; repoId: string }
  | { kind: "daemon"; repo: ShellPageRepo; client: ShellPageClient; connectionStamp: string };

interface ShellRow {
  key: string;
  taskId: string;
  host: Host;
  command: string;
  cwd: string;
  pid: number;
  startedAt: string;
  status: TaskStatus;
  activity: TaskActivity;
  endVerified: boolean;
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
function lineText(value: string, limit = 256): string { return sanitizeText(value, limit).replace(/[\x00-\x1f\x7f-\x9f]/g, " "); }

export function hostLabel(host: Host): string {
  if (host.kind === "main") return "主 agent";
  const role = lineText(host.role ?? "worker");
  const code = (host.runId ?? host.id).replace(/-/g, "").slice(0, 6);
  return `${role}#${code}`;
}

function hostIdentity(host: Host): string {
  return JSON.stringify([host.kind, host.id, host.runId ?? "", host.role ?? ""]);
}

function localRepoIdentity(host: Host): string {
  return `local:${hostIdentity(host)}`;
}

function rowIdentity(source: { kind: "local"; repoId: string } | { kind: "daemon"; repoId: string; connectionStamp: string }, task: {
  taskId: string;
  pid: number;
  startedAt: string;
}): string {
  return JSON.stringify([source.kind, source.repoId, task.taskId, task.pid, task.startedAt, source.kind === "daemon" ? source.connectionStamp : null]);
}

function shortIdentity(value: string, max = 12): string {
  const sanitized = sanitizeText(value);
  const clean = /^[0-9a-f-]{32,}$/i.test(sanitized) ? sanitized.replace(/-/g, "") : sanitized;
  if (clean.length <= max) return clean;
  return `${clean.slice(0, Math.max(1, max - 5))}…${clean.slice(-4)}`;
}

function truncatePlain(text: string, width: number): string {
  return sanitizeText(truncateToWidth(sanitizeText(text), width, "", false));
}

const clientIds = new WeakMap<object, number>();
let nextClientId = 0;
function connectionStamp(client: ShellPageClient): string | null {
  let id = clientIds.get(client);
  if (id === undefined) { id = ++nextClientId; clientIds.set(client, id); }
  const identity = client.connectionIdentity();
  return identity ? `${id}:${identity.daemonInstanceId}:${identity.connectionId}:${identity.connectionSequence}` : null;
}
function safeError(error: unknown): string {
  try {
    const message = typeof error === "string" ? error : error && typeof error === "object" ? Object.getOwnPropertyDescriptor(error, "message")?.value : undefined;
    return typeof message === "string" ? sanitizeText(message, 200).replace(/[\x00-\x1f\x7f-\x9f]/g, " ") : "未知错误";
  } catch { return "未知错误"; }
}
function validHost(host: Host): boolean {
  const text = (value: unknown, optional = false) => optional && value === undefined || typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\x00-\x1f\x7f-\x9f]/.test(value);
  return !!host && typeof host === "object" && ["main", "role"].includes(host.kind) && text(host.id) && text(host.runId, true) && (host.role === undefined || typeof host.role === "string" && host.role.length <= 256);
}

function rowFromTaskRecord(task: TaskRecord): ShellRow {
  if (!task || !validHost(task.host) || typeof task.taskId !== "string" || !Number.isSafeInteger(task.pid) || task.pid <= 1 ||
    !Object.hasOwn(STATUS_LABEL, task.status) || !["active", "uncertain", "ended"].includes(task.activity) || typeof task.command !== "string" || typeof task.cwd !== "string") throw new Error("本地Shell元数据无法核对");
  const startedAt = task.startedAt !== null ? new Date(task.startedAt).toISOString() : "";
  const repoId = localRepoIdentity(task.host);
  return {
    key: rowIdentity({ kind: "local", repoId }, { taskId: task.taskId, pid: task.pid, startedAt }),
    taskId: task.taskId,
    host: task.host,
    command: lineText(task.command, 4096),
    cwd: lineText(task.cwd, 4096),
    pid: task.pid,
    startedAt,
    status: task.status,
    activity: task.activity,
    endVerified: ENDED_STATUSES.has(task.status)
      && task.activity === "ended"
      && task.identityVerified === true
      && task.descendantsScanned === true,
    reason: typeof task.reason === "string" ? lineText(task.reason) : undefined,
    source: { kind: "local", repoId },
  };
}

function rowFromDaemonPayload(repo: ShellPageRepo, client: ShellPageClient, stamp: string, task: DaemonTaskPayload): ShellRow {
  if (!task || typeof task.taskId !== "string" || !task.taskId || task.taskId.length > 256 || /[\x00-\x1f\x7f-\x9f]/.test(task.taskId) ||
    !Number.isSafeInteger(task.pid) || task.pid <= 1 || !validHost(task.host) || !Object.hasOwn(STATUS_LABEL, task.status) ||
    !["active", "uncertain", "ended"].includes(task.activity) || !(task.startedAt === null || typeof task.startedAt === "number" && Number.isFinite(task.startedAt) ||
      typeof task.startedAt === "string" && task.startedAt.length <= 128 && !/[\x00-\x1f\x7f-\x9f]/.test(task.startedAt))) {
    throw new Error("Shell 元数据无法核对");
  }
  const startedAt = String(task.startedAt);
  return {
    key: rowIdentity({ kind: "daemon", repoId: repo.repoId, connectionStamp: stamp }, { taskId: task.taskId, pid: task.pid, startedAt }),
    taskId: task.taskId,
    host: task.host,
    command: "[旧命令正文不提供]",
    cwd: "[旧工作目录不提供]",
    pid: task.pid,
    startedAt,
    status: task.status,
    activity: task.activity,
    endVerified: false,
    reason: task.activity === "uncertain" ? "进程停止未确认" : undefined,
    source: { kind: "daemon", repo, client, connectionStamp: stamp },
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

const DEFAULT_HEIGHT = 24;

export class ShellPage {
  private readonly registry: ShellRegistry;
  private readonly repos: ShellPageRepo[];
  private readonly clock: Clock;
  private readonly theme: ShellPageTheme | undefined;
  private readonly onClose: (() => void) | undefined;
  private readonly onChange: (() => void) | undefined;

  private rows: ShellRow[] = [];
  private errors: string[] = [];
  private selectedIndex = 0;
  private selectedKey: string | undefined;
  private mode: PageMode = "list";
  private height = DEFAULT_HEIGHT;
  private refreshSequence = 0;
  private stopSequence = 0;

  private detailKey: string | undefined;
  private detailSnapshot: ShellRow | undefined;
  private detailIndex = 0;

  private confirmTarget: ShellRow | undefined;
  private confirmSelection: ConfirmSelection = "cancel";
  private readonly pendingStops = new Map<string, { token: string; target: ShellRow }>();
  private readonly noticeOverlay = new Map<string, string>();
  private readonly endedAt = new Map<string, number>();

  constructor(options: ShellPageOptions) {
    this.registry = options.registry;
    this.repos = options.repos;
    this.clock = options.clock;
    this.theme = options.theme;
    this.onClose = options.onClose;
    this.onChange = options.onChange;
  }

  resize(_width: number, height: number): void {
    this.height = height;
  }

  async refresh(): Promise<void> {
    const refreshToken = ++this.refreshSequence;
    const rawRows: ShellRow[] = [];
    const remotes: Array<{ repo: ShellPageRepo; client: ShellPageClient; stamp: string; rows: ShellRow[] }> = [];
    const errors: string[] = [];
    for (const repo of this.repos) {
      try {
        const client = repo.resolveClient(), stamp = client ? connectionStamp(client) : null;
        if (!client || stamp === null) throw new Error("连接不可用");
        const result = await client.call("shells.list");
        if (repo.resolveClient() !== client || connectionStamp(client) !== stamp) throw new Error("查询连接已变化");
        if (!result || !Array.isArray(result.tasks)) throw new Error("缺少有效Shell列表");
        const rows = (result.tasks as DaemonTaskPayload[]).filter((task) => task?.inWorkspace !== false).map((task) => rowFromDaemonPayload(repo, client, stamp, task));
        remotes.push({ repo, client, stamp, rows });
      } catch (error) {
        errors.push(`未知：${repo.repoId} ${safeError(error)}，Shell 覆盖不完整`);
      }
    }
    if (refreshToken !== this.refreshSequence) return;
    for (const remote of remotes) {
      try {
        if (remote.repo.resolveClient() !== remote.client || connectionStamp(remote.client) !== remote.stamp) throw new Error("查询连接已变化");
        rawRows.push(...remote.rows);
      } catch (error) { errors.push(`未知：${remote.repo.repoId} ${safeError(error)}，Shell 覆盖不完整`); }
    }
    // 本地证明在全部异步查询之后取得，迟到的远端结果不能还原旧PID或旧结束证明。
    const locals: ShellRow[] = [];
    try {
      for (const task of this.registry.list()) {
        try { locals.push(rowFromTaskRecord(task)); }
        catch (error) { errors.push(`未知：本地Shell ${safeError(error)}，覆盖不完整`); }
      }
    } catch (error) { errors.push(`未知：本地Shell ${safeError(error)}，覆盖不完整`); }
    rawRows.unshift(...locals);

    const liveKeys = new Set(rawRows.map((row) => row.key));
    for (const key of this.pendingStops.keys()) if (!liveKeys.has(key)) this.pendingStops.delete(key);
    for (const key of this.noticeOverlay.keys()) if (!liveKeys.has(key)) this.noticeOverlay.delete(key);
    for (const key of this.endedAt.keys()) if (!liveKeys.has(key)) this.endedAt.delete(key);

    const now = this.clock.now();
    const rows = rawRows.filter((row) => {
      if (!row.endVerified || this.noticeOverlay.has(row.key) || this.pendingStops.has(row.key)) {
        this.endedAt.delete(row.key);
        return true;
      }
      let at = this.endedAt.get(row.key);
      if (at === undefined) {
        at = now;
        this.endedAt.set(row.key, at);
      }
      return now - at < ENDED_TTL_MS;
    });

    const selectedKey = this.selectedKey;
    this.rows = rows;
    this.errors = errors;
    const selected = selectedKey === undefined ? -1 : rows.findIndex((row) => row.key === selectedKey);
    if (selected !== -1) {
      this.selectedIndex = selected;
    } else {
      this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, rows.length - 1));
      this.selectedKey = rows[this.selectedIndex]?.key;
    }
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

  reportRefreshFailure(error: unknown): void {
    this.errors = [`未知：Shell 刷新未完成 ${safeError(error)}`];
    this.endedAt.clear();
    for (const row of this.rows) row.endVerified = false;
  }

  private handleListInput(data: string): boolean {
    if (matchesKey(data, "down")) {
      if (this.rows.length > 0) {
        this.selectedIndex = Math.min(this.selectedIndex + 1, this.rows.length - 1);
        this.selectedKey = this.rows[this.selectedIndex]?.key;
      }
      return true;
    }
    if (matchesKey(data, "up")) {
      if (this.rows.length > 0) {
        this.selectedIndex = Math.max(this.selectedIndex - 1, 0);
        this.selectedKey = this.rows[this.selectedIndex]?.key;
      }
      return true;
    }
    if (matchesKey(data, "enter")) {
      const row = this.rows[this.selectedIndex];
      if (row) {
        this.detailKey = row.key;
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
        void this.requestStop(target);
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

  private applyRowUpdate(key: string, row: ShellRow): void {
    if (row.key !== key) return;
    this.noticeOverlay.delete(key);
    const index = this.rows.findIndex((candidate) => candidate.key === key);
    if (index !== -1) this.rows[index] = row;
  }

  private setFailureNotice(key: string, reason: string): void {
    if (this.rows.some((row) => row.key === key)) this.noticeOverlay.set(key, lineText(reason));
  }

  private requestIsCurrent(key: string, token: string): boolean {
    return this.pendingStops.get(key)?.token === token && this.rows.some((row) => row.key === key);
  }

  private currentLocalRow(target: ShellRow): ShellRow | undefined {
    const current = this.registry.get(target.taskId);
    if (!current) return undefined;
    const row = rowFromTaskRecord(current);
    return row.key === target.key ? row : undefined;
  }

  private async requestStop(targetRow: ShellRow): Promise<void> {
    const key = targetRow.key;
    if (this.pendingStops.has(key)) return;
    const target: ShellRow = { ...targetRow, host: { ...targetRow.host }, source: { ...targetRow.source } };
    const token = `shell-stop-${++this.stopSequence}`;
    this.noticeOverlay.delete(key);
    this.pendingStops.set(key, { token, target });
    this.onChange?.();
    try {
      if (target.source.kind === "local") {
        if (!this.currentLocalRow(target)) {
          if (this.requestIsCurrent(key, token)) this.setFailureNotice(key, "停止未确认：目标身份已经变化，请刷新后重试");
          return;
        }
        const result = await this.registry.stop(target.taskId);
        if (!this.requestIsCurrent(key, token)) return;
        if (!result.ok) {
          this.setFailureNotice(key, result.reason);
          return;
        }
        const returned = rowFromTaskRecord(result.task);
        const current = this.currentLocalRow(target);
        if (returned.key !== key || !current) {
          this.setFailureNotice(key, "停止未确认：停止回执与原目标身份不一致");
          return;
        }
        this.applyRowUpdate(key, current);
        if (!returned.endVerified || !current.endVerified) {
          this.setFailureNotice(key, `停止未确认：${current.reason ?? returned.reason ?? "当前结束状态缺少身份或后代扫描证明"}`);
        }
      } else {
        const currentClient = target.source.repo.resolveClient();
        if (currentClient !== target.source.client || connectionStamp(target.source.client) !== target.source.connectionStamp) {
          if (this.requestIsCurrent(key, token)) this.setFailureNotice(key, "停止未确认：仓库连接已经变化，请刷新后重试");
          return;
        }
        try {
          const result = await target.source.client.call("shells.stop", {
            taskId: target.taskId,
            expectedPid: target.pid,
            expectedStartedAt: target.startedAt,
          });
          if (!this.requestIsCurrent(key, token)) return;
          if (target.source.repo.resolveClient() !== target.source.client || connectionStamp(target.source.client) !== target.source.connectionStamp) {
            this.setFailureNotice(key, "停止未确认：连接代次已变化或无法核对"); return;
          }
          // shells.stop 只提供登记状态；没有完整结束证明时必须保留目标和未核实提示。
          this.setFailureNotice(key, `停止未确认：${typeof result.reason === "string" ? result.reason : "回执仅含登记状态，请核对实际进程"}`);
        } catch (error) {
          if (this.requestIsCurrent(key, token)) this.setFailureNotice(key,
            target.source.repo.resolveClient() === target.source.client && connectionStamp(target.source.client) === target.source.connectionStamp
              ? safeError(error) : "停止未确认：连接代次已变化");
        }
      }
    } catch (error) {
      if (this.requestIsCurrent(key, token)) this.setFailureNotice(key, `停止未确认：${safeError(error)}`);
    } finally {
      if (this.pendingStops.get(key)?.token === token) this.pendingStops.delete(key);
      this.onChange?.();
    }
  }

  private rowHostLabel(row: ShellRow): string {
    return hostLabel(row.host);
  }

  private rowStatusLabel(row: ShellRow): string {
    if (this.pendingStops.has(row.key)) return "停止中";
    if (this.noticeOverlay.has(row.key)) return "不确定";
    if (row.source.kind === "daemon" || ENDED_STATUSES.has(row.status) && !row.endVerified) {
      const label = row.status === "stopped" ? "停止" : row.status === "exited" ? "结束" : STATUS_LABEL[row.status];
      return `登记${label}（未核实）`;
    }
    return STATUS_LABEL[row.status];
  }

  private rowReasonText(row: ShellRow): string | undefined {
    return this.noticeOverlay.get(row.key) ?? row.reason;
  }

  private rowElapsed(row: ShellRow): string {
    const elapsedSource = /^\d+$/.test(row.startedAt) ? Number(row.startedAt) : Date.parse(row.startedAt);
    return Number.isFinite(elapsedSource) ? formatElapsed(this.clock.now() - elapsedSource) : "未知";
  }

  private rowIdentityLabel(row: ShellRow): string {
    const source = row.source.kind === "daemon"
      ? `仓库:${shortIdentity(row.source.repo.repoId, 12)}`
      : `本机:${shortIdentity(row.host.id, 8)}`;
    const taskWidth = /^[0-9a-f-]{32,}$/i.test(row.taskId) ? 8 : 14;
    return `${source}/${shortIdentity(row.taskId, taskWidth)}@${row.pid}`;
  }

  private renderList(width: number): string[] {
    const lineBudget = Math.max(1, this.height);
    const errorLines = this.errors.map((error) => truncatePlain(error, width));
    if (this.rows.length === 0) {
      if (errorLines.length > 0) return errorLines.slice(0, lineBudget);
      return [truncatePlain("无活动 Shell", width)];
    }

    const visibleErrors = errorLines.slice(0, lineBudget);
    if (visibleErrors.length >= lineBudget) return visibleErrors;

    const groups = this.rows.map((row, i) => this.renderListRow(row, i, i === this.selectedIndex, width));
    const limit = lineBudget - visibleErrors.length;
    const clampedSelected = Math.min(this.selectedIndex, groups.length - 1);
    const { start, end } = computeLineWindow(groups, clampedSelected, limit);

    const lines: string[] = [...visibleErrors];
    for (let i = start; i < end && lines.length < lineBudget; i++) {
      for (const line of groups[i] ?? []) {
        if (lines.length >= lineBudget) break;
        lines.push(line);
      }
    }
    return lines;
  }

  // reason 独立成行：与命令行拼在一起容易在 CJK 文本下把 reason 挤出 truncateToWidth 的可见宽度
  private renderListRow(row: ShellRow, index: number, isSelected: boolean, width: number): string[] {
    const content = [this.rowIdentityLabel(row), this.rowStatusLabel(row), row.source.kind === "daemon" ? "[正文占位]" : row.command, this.rowElapsed(row), this.rowHostLabel(row)].join("  ");
    const plainLine = truncatePlain(`${index + 1}  ${content}`, width);
    const mainLine = isSelected && this.theme?.bg ? this.theme.bg("selectedBg", plainLine) : plainLine;
    const reason = this.rowReasonText(row);
    if (!reason) return [mainLine];
    return [mainLine, truncatePlain(`   ${reason}`, width)];
  }

  private renderDetail(width: number): string[] {
    if (!this.detailKey) {
      this.mode = "list";
      return this.renderList(width);
    }
    const live = this.rows.find((row) => row.key === this.detailKey);
    const row = live ?? this.detailSnapshot;
    if (!row) {
      this.mode = "list";
      return this.renderList(width);
    }
    const statusText = live ? this.rowStatusLabel(live) : "无法核对";
    return [
      truncatePlain(`${this.detailIndex + 1}  ${this.rowIdentityLabel(row)}  ${this.rowHostLabel(row)}`, width),
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
    const index = this.rows.findIndex((row) => row.key === target.key);
    const confirmLabel = "停止";
    const cancelText = this.decorateOption("取消", this.confirmSelection === "cancel");
    const confirmText = this.decorateOption(confirmLabel, this.confirmSelection === "confirm");
    const line = `${(index === -1 ? this.selectedIndex : index) + 1}  ${this.rowIdentityLabel(target)}  ${this.rowHostLabel(target)}  ${target.command}`;
    const lines = [truncatePlain(line, width)];
    if (target.activity === "uncertain") lines.push(truncatePlain("停止尚未确认；仅请求实际停止，不能人工标记已停止", width));
    lines.push(`${cancelText}  ${confirmText}`);
    return lines;
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
          void page.refresh().then(() => hostTui.requestRender?.()).catch((error: unknown) => {
            page.reportRefreshFailure(error); hostTui.requestRender?.();
          });
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
