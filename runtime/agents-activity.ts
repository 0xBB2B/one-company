import { normalize } from "node:path";
import type { Clock } from "./clock.ts";
import type { RunRecord, RunState } from "./run-store.ts";
import { isTerminalState } from "./run-store.ts";
import { sanitizeText } from "./text-sanitize.ts";

export const RETENTION_MS = 20_000;
export const MAX_MIRRORED_RUNS_PER_REPO = 100;
const TOOL_ACTIVITY_LIMIT = 100;
const TOMBSTONE_LIMIT = 512;
const ORPHAN_ROLE_FALLBACK = "角色";
function field(value: unknown, name: string): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return Object.getOwnPropertyDescriptor(value, name)?.value;
}
function checkedPayload(value: unknown): RunsChangedPayload | undefined {
  try {
    const run = field(value, "run");
    const id = field(run, "id"), kind = field(run, "kind"), requirement = field(run, "requirement"), state = field(run, "state"), turns = field(run, "turns");
    const role = field(run, "role"), parentRunId = field(run, "parentRunId"), startedAt = field(run, "startedAt"), title = field(value, "requirementTitle");
    const text = (value: unknown, optional = false) => optional && value === undefined || typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\x00-\x1f\x7f-\x9f]/.test(value);
    const count = (value: unknown) => value === undefined || Number.isSafeInteger(value) && Number(value) >= 0;
    const activeShellTasks = field(value, "activeShellTasks"), pendingShellCleanup = field(value, "pendingShellCleanup");
    if (!text(id) || kind !== "requirement" && kind !== "role" || !text(requirement) || !text(state) || !Number.isSafeInteger(turns) || Number(turns) < 0 ||
      !text(role, true) || !text(parentRunId, true) || !text(startedAt, true) || title !== undefined && typeof title !== "string" || !count(activeShellTasks) || !count(pendingShellCleanup)) return undefined;
    return { run: { id, kind, requirement, state, turns, role, parentRunId, startedAt } as RunRecord,
      requirementTitle: typeof title === "string" ? sanitizeText(title, 256) : undefined, activeShellTasks: activeShellTasks as number | undefined, pendingShellCleanup: pendingShellCleanup as number | undefined };
  } catch { return undefined; }
}

function checkedActivity(value: unknown): ActivityEvent | undefined {
  try {
    const runId = field(value, "runId"), kind = field(value, "kind"), at = field(value, "at");
    const toolName = field(value, "toolName"), toolCallId = field(value, "toolCallId"), filePath = field(value, "filePath"), state = field(value, "state");
    const text = (v: unknown, max = 256) => typeof v === "string" && v.length > 0 && v.length <= max && !/[\x00-\x1f\x7f-\x9f]/.test(v);
    if (!text(runId) || !text(at) || typeof kind !== "string" || !["tool_start", "tool_end", "turn", "state"].includes(kind) ||
      toolName !== undefined && !text(toolName) || toolCallId !== undefined && !text(toolCallId) ||
      filePath !== undefined && !text(filePath, 4096) || state !== undefined && !text(state) ||
      (kind === "tool_start" || kind === "tool_end") && !text(toolCallId) || kind === "tool_start" && !text(toolName)) return undefined;
    return { runId, kind, at, toolName, toolCallId, filePath, state } as ActivityEvent;
  } catch { return undefined; }
}

export interface WorkspaceRepo {
  repoId: string;
  name: string;
}

export interface RunsChangedPayload {
  run: RunRecord;
  requirementTitle?: string;
  activeShellTasks?: number;
  pendingShellCleanup?: number;
}

export interface ActivityEvent {
  runId: string;
  kind: "tool_start" | "tool_end" | "turn" | "state";
  toolName?: string;
  toolCallId?: string;
  filePath?: string;
  state?: string;
  at: string;
}

export interface ConnectionState {
  status: "connected" | "starting" | "unreachable";
  reason?: string;
}

export interface AgentsActivityRow {
  id: string;
  repoId: string;
  indent: number;
  title: string;
  status: RunState;
  activity: string;
  turns: number;
  elapsedMs: number;
  waiting: boolean;
  filesEditedCount: number;
  activeShellTasks?: number;
  pendingShellCleanup?: number;
  unreachable: boolean;
  unreachableReason?: string;
  archived: boolean;
  stopConfirmed: boolean;
  buttons: string[];
}

export interface AgentsActivityNotice {
  message: string;
}

interface ActivityCoverage {
  total?: number;
  returned?: number;
  remaining?: number;
  unknown?: number;
  unconfirmed?: number;
  offset?: number;
  nextOffset?: number | null;
  truncated?: boolean;
}

interface CoverageState {
  value: ActivityCoverage;
  freshness: "fresh" | "stale" | "loading" | "failed";
}

interface SnapshotRequest {
  sequence: number;
  revision: number;
}

interface RunEntry {
  instance: number;
  key: string;
  repoId: string;
  id: string;
  kind: RunRecord["kind"];
  role?: string;
  requirement: string;
  requirementTitle?: string;
  parentRunId?: string;
  state: RunState;
  turns: number;
  startedAt: unknown;
  activeShellTasks?: number;
  pendingShellCleanup?: number;
  parentRequirementTitleSnapshot?: string;
}

function resolvedRequirementTitle(entry: RunEntry): string {
  return entry.requirementTitle ?? entry.requirement;
}

interface ToolActivityState {
  activeCalls: Map<string, string>;
  editedFiles: Set<string>;
}

function buttonsFor(state: RunState): string[] {
  switch (state) {
    case "running":
      return ["pause", "stop"];
    case "paused":
    case "interrupted":
    case "waiting_answer":
    case "queued":
    case "pausing":
    case "paused_network":
      return ["stop"];
    case "completed":
    case "failed":
    case "stopped":
      return ["stop"];
    default:
      // 守护进程协议版本可能领先面板引入新状态字面量，未知状态按"仍需人工处理"兜底而非无按钮
      return ["stop"];
  }
}

function firstActiveTool(state: ToolActivityState | undefined): string {
  if (!state) return "";
  for (const toolName of state.activeCalls.values()) return toolName;
  return "";
}

function key(repoId: string, runId: string): string {
  return `${repoId}::${runId}`;
}

export class AgentsActivity {
  private readonly clock: Clock;
  private readonly repoNames = new Map<string, string>();
  private readonly runs = new Map<string, RunEntry>();
  private readonly order = new Map<string, string[]>();
  private readonly toolActivity = new Map<string, ToolActivityState>();
  private readonly firstEndAt = new Map<string, number>();
  private readonly tombstoned = new Map<string, string>();
  private readonly stopEpochs = new Map<string, number>();
  private readonly connectionState = new Map<string, ConnectionState>();
  private readonly coverage = new Map<string, CoverageState>();
  private readonly revisions = new Map<string, number>();
  private readonly snapshotRequests = new Map<string, SnapshotRequest>();
  private readonly mirrorOverflow = new Set<string>();
  private readonly hiddenCleanup = new Set<string>();
  private readonly cleanupClaims = new Map<string, Map<string, string>>();
  private readonly metadataInvalid = new Set<string>();
  private readonly confirmedStops = new Set<string>();
  private snapshotSequence = 0;
  private runInstanceSequence = 0;
  private lastFailure: { message: string; at: number } | undefined;

  constructor(options: { clock: Clock; workspaceRepos: WorkspaceRepo[] }) {
    this.clock = options.clock;
    for (const repo of options.workspaceRepos) {
      this.repoNames.set(repo.repoId, sanitizeText(typeof repo.name === "string" ? repo.name : "未知仓库", 128).replace(/[\x00-\x1f\x7f-\x9f]/g, ""));
      this.revisions.set(repo.repoId, 0);
    }
  }

  applyRunsChanged(repoId: string, payload: RunsChangedPayload): void {
    if (!this.repoNames.has(repoId)) return;
    this.bumpRevision(repoId);
    this.invalidateCoverage(repoId, "stale");
    this.upsertRun(repoId, payload, true);
  }

  beginSnapshot(repoId: string): number | undefined {
    if (!this.repoNames.has(repoId)) return undefined;
    const request = { sequence: ++this.snapshotSequence, revision: this.revisions.get(repoId) ?? 0 };
    this.snapshotRequests.set(repoId, request);
    this.invalidateCoverage(repoId, "loading");
    return request.sequence;
  }

  applySnapshot(repoId: string, sequence: number, snapshot: RunsChangedPayload[], coverage: unknown, sourceLength = snapshot.length): boolean {
    const request = this.snapshotRequests.get(repoId);
    if (!request || request.sequence !== sequence || request.revision !== (this.revisions.get(repoId) ?? 0)) return false;
    if (!Number.isSafeInteger(sourceLength) || sourceLength < snapshot.length) { this.failSnapshot(repoId, sequence); return false; }
    this.snapshotRequests.delete(repoId);
    this.stopEpochs.set(repoId, (this.stopEpochs.get(repoId) ?? 0) + 1);
    for (const entry of this.runs.values()) {
      if (entry.repoId === repoId && typeof entry.pendingShellCleanup === "number" && entry.pendingShellCleanup > 0) this.rememberCleanup(repoId, entry.id, this.runIdentity(entry));
    }
    this.clearRepoMirror(repoId);
    this.metadataInvalid.delete(repoId);
    this.mirrorOverflow.delete(repoId);
    for (const payload of snapshot.slice(0, MAX_MIRRORED_RUNS_PER_REPO)) this.upsertRun(repoId, payload, false);
    if (sourceLength > MAX_MIRRORED_RUNS_PER_REPO) {
      this.mirrorOverflow.add(repoId);
      for (const payload of snapshot.slice(MAX_MIRRORED_RUNS_PER_REPO, MAX_MIRRORED_RUNS_PER_REPO * 2)) {
        const safe = checkedPayload(payload);
        if (safe) {
          this.resolveCleanup(repoId, safe);
          if (typeof safe.pendingShellCleanup === "number" && safe.pendingShellCleanup > 0) this.rememberCleanup(repoId, safe.run.id, this.runIdentity(safe.run));
        }
      }
      if (sourceLength > MAX_MIRRORED_RUNS_PER_REPO * 2) this.hiddenCleanup.add(repoId);
    }
    this.coverage.set(repoId, { value: this.sanitizeCoverage(coverage), freshness: this.metadataInvalid.has(repoId) ? "failed" : "fresh" });
    return true;
  }

  failSnapshot(repoId: string, sequence: number | undefined): void {
    const request = this.snapshotRequests.get(repoId);
    if (!request || sequence === undefined || request.sequence !== sequence) return;
    this.snapshotRequests.delete(repoId);
    this.invalidateCoverage(repoId, "failed");
  }

  applyActivity(repoId: string, event: ActivityEvent): void;
  applyActivity(event: ActivityEvent): void;
  applyActivity(repoIdOrEvent: string | ActivityEvent, suppliedEvent?: ActivityEvent): void {
    const event = checkedActivity(typeof repoIdOrEvent === "string" ? suppliedEvent : repoIdOrEvent);
    let repoId = typeof repoIdOrEvent === "string" ? repoIdOrEvent : undefined;
    if (!event) {
      if (repoId !== undefined && this.repoNames.has(repoId)) { this.metadataInvalid.add(repoId); this.invalidateCoverage(repoId, "failed"); }
      return;
    }
    if (repoId !== undefined && !this.repoNames.has(repoId)) return;
    if (repoId === undefined) {
      const matches = [...this.repoNames.keys()].filter((candidate) => this.runs.has(key(candidate, event.runId)));
      if (matches.length !== 1) return;
      repoId = matches[0];
    }
    const runKey = key(repoId, event.runId);
    if (!this.runs.has(runKey)) return;
    if ((event.kind === "tool_start" || event.kind === "tool_end") && !event.toolCallId) return;
    let state = this.toolActivity.get(runKey);
    if (!state) {
      state = { activeCalls: new Map(), editedFiles: new Set() };
      this.toolActivity.set(runKey, state);
    }
    switch (event.kind) {
      case "tool_start":
        if (!state.activeCalls.has(event.toolCallId as string) && state.activeCalls.size >= TOOL_ACTIVITY_LIMIT) {
          this.mirrorOverflow.add(repoId);
          return;
        }
        state.activeCalls.set(event.toolCallId as string, event.toolName ?? "");
        if ((event.toolName === "edit" || event.toolName === "write") && event.filePath) {
          if (state.editedFiles.size >= TOOL_ACTIVITY_LIMIT) this.mirrorOverflow.add(repoId);
          else state.editedFiles.add(normalize(event.filePath));
        }
        break;
      case "tool_end":
        state.activeCalls.delete(event.toolCallId as string);
        break;
      case "turn":
      case "state":
        break;
    }
  }

  applyConnectionState(repoId: string, state: ConnectionState): boolean {
    if (!this.repoNames.has(repoId)) return false;
    const previous = this.connectionState.get(repoId);
    const generationChanged = previous?.status !== state.status;
    this.connectionState.set(repoId, state);
    if (generationChanged) {
      this.stopEpochs.set(repoId, (this.stopEpochs.get(repoId) ?? 0) + 1);
      this.bumpRevision(repoId);
      this.invalidateCoverage(repoId, state.status === "connected" ? "loading" : "stale");
      if (previous !== undefined) {
        for (const [runKey, entry] of this.runs) {
          if (entry.repoId !== repoId) continue;
          this.toolActivity.delete(runKey);
          this.confirmedStops.delete(runKey);
          this.firstEndAt.delete(runKey);
        }
      }
    }
    return state.status === "connected" && previous !== undefined && previous.status !== "connected";
  }

  applyCoverage(repoId: string, value: unknown): void {
    if (!this.repoNames.has(repoId)) return;
    this.coverage.set(repoId, { value: this.sanitizeCoverage(value), freshness: "fresh" });
  }

  coverageNotices(maxLines = Number.POSITIVE_INFINITY): string[] {
    const count = (n: number | undefined) => n === undefined ? "未知" : String(n);
    const entries = [...this.repoNames].map(([repoId, name]) => {
      const state = this.coverage.get(repoId) ?? { value: {}, freshness: "stale" as const };
      const fresh = state.freshness === "fresh";
      const c = fresh ? state.value : {};
      const outside = c.total !== undefined && c.returned !== undefined && c.total >= c.returned && c.unknown !== undefined
        ? Math.max(c.remaining ?? 0, c.total - c.returned - c.unknown) : c.remaining;
      const connection = this.connectionState.get(repoId);
      const availability = connection?.status === "unreachable"
        ? ` 不可达${connection.reason ? `：${connection.reason}` : ""}`
        : connection?.status === "starting" ? " 连接中"
        : connection === undefined ? " 连接未知" : "";
      const freshness = fresh ? "当前快照" : state.freshness === "loading" ? "快照刷新中" : state.freshness === "failed" ? "快照读取失败" : "快照过期";
      return { repoId, name, c, outside, fresh, availability, freshness };
    });
    const lines = entries.map(({ repoId, name, c, outside, availability, freshness }) =>
      `覆盖${freshness === "当前快照" ? "当前" : "未知"}${this.metadataInvalid.has(repoId) ? "：元数据无效" : ""}${this.hasHiddenCleanup(repoId) ? "：未展示待清理目标尚未核对" : ""}${this.mirrorOverflow.has(repoId) ? "：溢出，省略事件/运行数未知" : ""}（${freshness}）：查询页外未展示${count(outside)} 未知${count(c.unknown)} 停止未核实${count(c.unconfirmed)}${availability} 仓库=${name} 总${count(c.total)}/返回${count(c.returned)}${c.truncated === true ? " 截断" : c.truncated === undefined ? " 完整性未知" : ""}${c.nextOffset !== undefined && c.nextOffset !== null ? ` 下一偏移${c.nextOffset}` : ""}${this.mirrorOverflow.has(repoId) ? ` 镜像上限${MAX_MIRRORED_RUNS_PER_REPO}` : ""}`);
    if (lines.length <= maxLines) return lines;
    if (maxLines <= 0) return [];
    const shown = Math.max(0, maxLines - 1);
    const hidden = entries.slice(shown);
    const sum = (field: "outside" | "unknown" | "unconfirmed") => {
      const values = hidden.map((entry) => entry.fresh ? (field === "outside" ? entry.outside : entry.c[field]) : undefined);
      return values.some((value) => value === undefined) ? "未知" : String(values.reduce<number>((total, value) => total + value!, 0));
    };
    const hiddenOverflow = hidden.some((entry) => this.mirrorOverflow.has(entry.repoId));
    return [...lines.slice(0, shown), `覆盖${hidden.some((entry) => !entry.fresh) ? "未知" : "合计"}${hidden.some((entry) => this.hasHiddenCleanup(entry.repoId)) ? "：未展示待清理尚未核对" : ""}${hiddenOverflow ? "：省略事件/运行数未知" : ""}；另${hidden.length}仓库覆盖详项未展示：查询页外未展示${sum("outside")} 未知${sum("unknown")} 停止未核实${sum("unconfirmed")}`];
  }

  /** 连接或快照替换使旧停止回执失效；正常停止的状态事件不改变此绑定。 */
  stopBinding(repoId: string, runId: string): string | undefined {
    const entry = this.runs.get(key(repoId, runId));
    return entry ? JSON.stringify([this.stopEpochs.get(repoId) ?? 0, entry.instance, this.runIdentity(entry)]) : undefined;
  }
  /** 仅记录本次安全停止 RPC 的实际确认；登记状态及原因不构成确认。 */
  recordStopResult(repoId: string, runId: string, confirmed: boolean): void {
    const runKey = key(repoId, runId);
    const entry = this.runs.get(runKey);
    if (confirmed && !(entry && isTerminalState(entry.state)
      && typeof entry.pendingShellCleanup === "number" && entry.pendingShellCleanup > 0)) {
      this.confirmedStops.add(runKey);
    } else {
      this.confirmedStops.delete(runKey);
      this.firstEndAt.delete(runKey);
    }
    if (entry) this.trackRetention(entry);
  }

  reportActionFailure(message: string): void {
    this.lastFailure = { message, at: this.clock.now() };
  }

  notice(): AgentsActivityNotice | undefined {
    if (!this.lastFailure) return undefined;
    if (this.clock.elapsedExcludingSleep(this.lastFailure.at) >= RETENTION_MS) return undefined;
    return { message: this.lastFailure.message };
  }

  rows(): AgentsActivityRow[] {
    this.prune();
    const output: AgentsActivityRow[] = [];
    for (const repoId of this.repoNames.keys()) {
      const keys = this.order.get(repoId) ?? [];
      const emitted = new Set<string>();
      for (const runKey of keys) {
        const entry = this.runs.get(runKey);
        if (!entry || entry.kind !== "requirement") continue;
        output.push(this.toRow(entry, 0, this.requirementTitle(entry)));
        emitted.add(runKey);
        for (const childKey of keys) {
          if (emitted.has(childKey)) continue;
          const child = this.runs.get(childKey);
          if (child && child.kind === "role" && child.parentRunId === entry.id) {
            output.push(this.toRow(child, 1, child.role ?? ""));
            emitted.add(childKey);
          }
        }
      }
      for (const runKey of keys) {
        if (emitted.has(runKey)) continue;
        const entry = this.runs.get(runKey);
        if (entry) output.push(this.toRow(entry, 0, this.orphanRoleTitle(entry)));
      }
    }
    return output;
  }

  private requirementTitle(entry: RunEntry): string {
    const name = this.repoNames.get(entry.repoId) ?? "";
    return `${name} · ${resolvedRequirementTitle(entry)}`;
  }

  private orphanRoleTitle(entry: RunEntry): string {
    const roleName = entry.role ?? ORPHAN_ROLE_FALLBACK;
    const name = this.repoNames.get(entry.repoId) ?? "";
    if (!entry.parentRequirementTitleSnapshot) return `${name} · ${roleName}`;
    return `${name} · ${entry.parentRequirementTitleSnapshot} › ${roleName}`;
  }

  private toRow(entry: RunEntry, indent: number, title: string): AgentsActivityRow {
    const connection = this.connectionState.get(entry.repoId);
    const unreachable = connection?.status === "unreachable" || connection?.status === "starting";
    const tool = this.toolActivity.get(entry.key);
    const startMs = typeof entry.startedAt === "string" ? Date.parse(entry.startedAt) : NaN;
    return {
      id: entry.id,
      repoId: entry.repoId,
      indent,
      title,
      status: entry.state,
      activity: unreachable ? "" : firstActiveTool(tool),
      turns: entry.turns,
      elapsedMs: Number.isNaN(startMs) ? 0 : this.clock.elapsedExcludingSleep(startMs),
      waiting: entry.state === "waiting_answer",
      filesEditedCount: tool?.editedFiles.size ?? 0,
      activeShellTasks: entry.activeShellTasks,
      pendingShellCleanup: entry.pendingShellCleanup,
      unreachable,
      unreachableReason: unreachable ? connection?.reason : undefined,
      archived: isTerminalState(entry.state),
      stopConfirmed: this.confirmedStops.has(entry.key),
      buttons: buttonsFor(entry.state),
    };
  }

  private trackRetention(entry: RunEntry): void {
    if (!isTerminalState(entry.state) || !this.confirmedStops.has(entry.key)) return;
    if (typeof entry.pendingShellCleanup === "number" && entry.pendingShellCleanup > 0) return;
    if (!this.firstEndAt.has(entry.key)) this.firstEndAt.set(entry.key, this.clock.now());
  }

  private prune(): void {
    for (const [runKey, at] of this.firstEndAt) {
      if (this.clock.elapsedExcludingSleep(at) < RETENTION_MS) continue;
      const entry = this.runs.get(runKey);
      if (!entry || !isTerminalState(entry.state) || !this.confirmedStops.has(runKey)
        || (typeof entry.pendingShellCleanup === "number" && entry.pendingShellCleanup > 0)) {
        this.firstEndAt.delete(runKey);
        this.confirmedStops.delete(runKey);
        continue;
      }
      const ids = this.order.get(entry.repoId);
      const idx = ids?.indexOf(runKey) ?? -1;
      if (ids && idx >= 0) ids.splice(idx, 1);
      this.runs.delete(runKey);
      this.toolActivity.delete(runKey);
      this.firstEndAt.delete(runKey);
      this.confirmedStops.delete(runKey);
      this.addTombstone(runKey, this.endFingerprint(entry));
    }
  }

  private upsertRun(repoId: string, payload: RunsChangedPayload, liveEvent: boolean): void {
    const safe = checkedPayload(payload);
    if (!safe) {
      this.metadataInvalid.add(repoId); this.invalidateCoverage(repoId, "failed");
      const id = field(field(payload, "run"), "id");
      if (typeof id === "string") { this.confirmedStops.delete(key(repoId, id)); this.firstEndAt.delete(key(repoId, id)); }
      return;
    }
    payload = safe;
    const run = safe.run;
    const runKey = key(repoId, run.id);
    const prior = this.runs.get(runKey);
    if (prior && this.runIdentity(prior) !== this.runIdentity(run)) {
      if (typeof prior.pendingShellCleanup === "number" && prior.pendingShellCleanup > 0) this.rememberCleanup(repoId, prior.id, this.runIdentity(prior));
      this.confirmedStops.delete(runKey); this.firstEndAt.delete(runKey); this.toolActivity.delete(runKey);
    }
    this.resolveCleanup(repoId, payload);
    const tombstone = this.tombstoned.get(runKey);
    if (tombstone !== undefined) {
      if (isTerminalState(run.state) && tombstone === this.endFingerprint({ ...run, activeShellTasks: payload.activeShellTasks, pendingShellCleanup: payload.pendingShellCleanup })) return;
      this.tombstoned.delete(runKey);
      this.confirmedStops.delete(runKey); this.firstEndAt.delete(runKey);
    }
    if (!this.runs.has(runKey)) {
      const ids = this.order.get(repoId) ?? [];
      if (ids.length >= MAX_MIRRORED_RUNS_PER_REPO) {
        if (liveEvent) this.mirrorOverflow.add(repoId);
        if (typeof payload.pendingShellCleanup === "number" && payload.pendingShellCleanup > 0) this.rememberCleanup(repoId, run.id, this.runIdentity(run));
        return;
      }
      ids.push(runKey);
      this.order.set(repoId, ids);
    }
    let parentRequirementTitleSnapshot: string | undefined;
    if (run.kind === "role" && run.parentRunId) {
      const parent = this.runs.get(key(repoId, run.parentRunId));
      if (parent?.kind === "requirement") parentRequirementTitleSnapshot = resolvedRequirementTitle(parent);
    }
    const identityUnchanged = prior && this.runIdentity(prior) === this.runIdentity(run);
    if (!identityUnchanged && !Number.isSafeInteger(this.runInstanceSequence + 1)) {
      this.metadataInvalid.add(repoId); this.invalidateCoverage(repoId, "failed"); return;
    }
    const entry: RunEntry = {
      instance: identityUnchanged ? prior.instance : ++this.runInstanceSequence,
      key: runKey,
      repoId,
      id: run.id,
      kind: run.kind,
      role: run.role,
      requirement: run.requirement,
      requirementTitle: payload.requirementTitle,
      parentRunId: run.parentRunId,
      state: run.state,
      turns: run.turns,
      startedAt: run.startedAt,
      activeShellTasks: payload.activeShellTasks,
      pendingShellCleanup: payload.pendingShellCleanup,
      parentRequirementTitleSnapshot,
    };
    this.runs.set(runKey, entry);
    if (!isTerminalState(entry.state)
      || (this.confirmedStops.has(runKey) && payload.pendingShellCleanup !== 0)) {
      this.confirmedStops.delete(runKey);
      this.firstEndAt.delete(runKey);
    }
    this.trackRetention(entry);
  }

  private clearRepoMirror(repoId: string): void {
    for (const runKey of this.order.get(repoId) ?? []) {
      this.runs.delete(runKey);
      this.toolActivity.delete(runKey);
      this.firstEndAt.delete(runKey);
      this.confirmedStops.delete(runKey);
    }
    this.order.set(repoId, []);
  }

  private bumpRevision(repoId: string): void {
    this.revisions.set(repoId, (this.revisions.get(repoId) ?? 0) + 1);
  }

  private invalidateCoverage(repoId: string, freshness: CoverageState["freshness"]): void {
    const previous = this.coverage.get(repoId);
    this.coverage.set(repoId, { value: previous?.value ?? {}, freshness });
  }

  private sanitizeCoverage(value: unknown): ActivityCoverage {
    const safe: ActivityCoverage = {};
    if (!value || typeof value !== "object") return safe;
    for (const field of ["total", "returned", "remaining", "unknown", "unconfirmed", "offset", "nextOffset"] as const) {
      const descriptor = Object.getOwnPropertyDescriptor(value, field);
      const count: unknown = descriptor && "value" in descriptor ? descriptor.value : undefined;
      if (typeof count === "number" && Number.isSafeInteger(count) && count >= 0) safe[field] = count;
      else if (field === "nextOffset" && count === null) safe.nextOffset = null;
    }
    const truncated = Object.getOwnPropertyDescriptor(value, "truncated")?.value;
    if (typeof truncated === "boolean") safe.truncated = truncated;
    return safe;
  }

  private runIdentity(entry: Pick<RunEntry, "kind" | "role" | "requirement" | "parentRunId" | "startedAt">): string {
    return JSON.stringify([entry.kind, entry.role, entry.requirement, entry.parentRunId, entry.startedAt]);
  }
  private resolveCleanup(repoId: string, payload: RunsChangedPayload): void {
    if (payload.pendingShellCleanup === 0 && this.cleanupClaims.get(repoId)?.get(payload.run.id) === this.runIdentity(payload.run)) this.cleanupClaims.get(repoId)?.delete(payload.run.id);
  }
  private rememberCleanup(repoId: string, id: string, identity: string): void {
    const claims = this.cleanupClaims.get(repoId) ?? new Map<string, string>();
    this.cleanupClaims.set(repoId, claims);
    if (claims.has(id) && claims.get(id) !== identity || !claims.has(id) && claims.size >= MAX_MIRRORED_RUNS_PER_REPO) {
      this.hiddenCleanup.add(repoId); return;
    }
    claims.set(id, identity);
  }
  private hasHiddenCleanup(repoId: string): boolean {
    if (this.hiddenCleanup.has(repoId)) return true;
    for (const [id, identity] of this.cleanupClaims.get(repoId) ?? []) {
      const visible = this.runs.get(key(repoId, id));
      if (!visible || this.runIdentity(visible) !== identity || !(typeof visible.pendingShellCleanup === "number" && visible.pendingShellCleanup > 0)) return true;
    }
    return false;
  }
  private endFingerprint(entry: Pick<RunEntry, "kind" | "role" | "requirement" | "parentRunId" | "state" | "turns" | "startedAt" | "activeShellTasks" | "pendingShellCleanup">): string {
    return JSON.stringify([entry.kind, entry.role, entry.requirement, entry.parentRunId, entry.state, entry.turns, entry.startedAt, entry.activeShellTasks, entry.pendingShellCleanup]);
  }
  private addTombstone(runKey: string, fingerprint: string): void {
    if (this.tombstoned.size >= TOMBSTONE_LIMIT) {
      const oldest = this.tombstoned.keys().next().value;
      if (oldest !== undefined) this.tombstoned.delete(oldest);
    }
    this.tombstoned.set(runKey, fingerprint);
  }
}
