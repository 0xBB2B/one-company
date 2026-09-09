import { normalize } from "node:path";
import type { Clock } from "./clock.ts";
import type { RunRecord, RunState } from "./run-store.ts";
import { isTerminalState } from "./run-store.ts";

export const RETENTION_MS = 20_000;
const TOMBSTONE_LIMIT = 512;
const ORPHAN_ROLE_FALLBACK = "角色";

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
  buttons: string[];
}

export interface AgentsActivityNotice {
  message: string;
}

interface RunEntry {
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
      return ["pause", "stop", "view"];
    case "paused":
      return ["resume", "stop", "view"];
    case "interrupted":
      return ["resumeInterrupted", "stop", "view"];
    case "waiting_answer":
      return ["stop", "view"];
    case "queued":
    case "pausing":
    case "paused_network":
      return ["stop", "view"];
    case "completed":
    case "failed":
    case "stopped":
      return [];
    default:
      // 守护进程协议版本可能领先面板引入新状态字面量，未知状态按"仍需人工处理"兜底而非无按钮
      return ["stop", "view"];
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
  private readonly runIdToKey = new Map<string, string>();
  private readonly toolActivity = new Map<string, ToolActivityState>();
  private readonly firstEndAt = new Map<string, number>();
  private readonly tombstoned = new Set<string>();
  private readonly connectionState = new Map<string, ConnectionState>();
  private lastFailure: { message: string; at: number } | undefined;

  constructor(options: { clock: Clock; workspaceRepos: WorkspaceRepo[] }) {
    this.clock = options.clock;
    for (const repo of options.workspaceRepos) this.repoNames.set(repo.repoId, repo.name);
  }

  applyRunsChanged(repoId: string, payload: RunsChangedPayload): void {
    if (!this.repoNames.has(repoId)) return;
    const run = payload.run;
    const runKey = key(repoId, run.id);
    if (this.tombstoned.has(runKey)) return;
    if (!this.runs.has(runKey)) {
      const ids = this.order.get(repoId) ?? [];
      ids.push(runKey);
      this.order.set(repoId, ids);
    }
    let parentRequirementTitleSnapshot: string | undefined;
    if (run.kind === "role" && run.parentRunId) {
      const parentKey = this.runIdToKey.get(run.parentRunId);
      const parent = parentKey ? this.runs.get(parentKey) : undefined;
      if (parent && parent.kind === "requirement") parentRequirementTitleSnapshot = resolvedRequirementTitle(parent);
    }
    const entry: RunEntry = {
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
    this.runIdToKey.set(run.id, runKey);
    this.trackRetention(entry);
  }

  applyActivity(event: ActivityEvent): void {
    const runKey = this.runIdToKey.get(event.runId);
    if (!runKey || !this.runs.has(runKey)) return;
    if ((event.kind === "tool_start" || event.kind === "tool_end") && !event.toolCallId) return;
    let state = this.toolActivity.get(runKey);
    if (!state) {
      state = { activeCalls: new Map(), editedFiles: new Set() };
      this.toolActivity.set(runKey, state);
    }
    switch (event.kind) {
      case "tool_start":
        state.activeCalls.set(event.toolCallId as string, event.toolName ?? "");
        if ((event.toolName === "edit" || event.toolName === "write") && event.filePath) {
          state.editedFiles.add(normalize(event.filePath));
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

  applyConnectionState(repoId: string, state: ConnectionState): void {
    const previous = this.connectionState.get(repoId);
    this.connectionState.set(repoId, state);
    if (state.status === "connected" && previous !== undefined && previous.status !== "connected") {
      for (const [runKey, entry] of this.runs) {
        if (entry.repoId === repoId) this.toolActivity.delete(runKey);
      }
    }
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
      buttons: buttonsFor(entry.state),
    };
  }

  private trackRetention(entry: RunEntry): void {
    if (!isTerminalState(entry.state)) return;
    if (typeof entry.pendingShellCleanup === "number" && entry.pendingShellCleanup > 0) return;
    if (!this.firstEndAt.has(entry.key)) this.firstEndAt.set(entry.key, this.clock.now());
  }

  private prune(): void {
    for (const [runKey, at] of this.firstEndAt) {
      if (this.clock.elapsedExcludingSleep(at) < RETENTION_MS) continue;
      const entry = this.runs.get(runKey);
      if (entry) {
        const ids = this.order.get(entry.repoId);
        const idx = ids?.indexOf(runKey) ?? -1;
        if (ids && idx >= 0) ids.splice(idx, 1);
        if (this.runIdToKey.get(entry.id) === runKey) this.runIdToKey.delete(entry.id);
      }
      this.runs.delete(runKey);
      this.toolActivity.delete(runKey);
      this.firstEndAt.delete(runKey);
      this.addTombstone(runKey);
    }
  }

  private addTombstone(runKey: string): void {
    if (this.tombstoned.size >= TOMBSTONE_LIMIT) {
      const oldest = this.tombstoned.values().next().value;
      if (oldest !== undefined) this.tombstoned.delete(oldest);
    }
    this.tombstoned.add(runKey);
  }
}
