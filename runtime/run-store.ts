import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { runDataDir, runsDataDir } from "./identity.ts";
import { createDocument, readDocument, withDirLock, writeDocument } from "./store.ts";

export type RunKind = "requirement" | "role";

export type RunState =
  | "queued"
  | "running"
  | "pausing"
  | "paused"
  | "paused_network"
  | "waiting_answer"
  | "completed"
  | "failed"
  | "stopped"
  | "interrupted";

export interface RunRecord {
  id: string;
  shellToken: string;
  kind: RunKind;
  role?: string;
  requirement: string;
  parentRunId?: string;
  task: string;
  cwd: string;
  writePaths: string[];
  readPaths: string[];
  model: { provider: string; id: string };
  thinking: string;
  mcp: string[];
  state: RunState;
  stateReason?: string;
  startedAt: string;
  updatedAt: string;
  endedAt?: string;
  turns: number;
  result?: unknown;
  errorDetails: { path?: string; status: "none" | "saved" | "incomplete" | "unreadable" | "unavailable" };
  daemonStartedAt: string;
}

export interface CreateRunInput {
  kind: RunKind;
  role?: string;
  requirement: string;
  parentRunId?: string;
  task: string;
  cwd: string;
  writePaths: string[];
  readPaths: string[];
  model: { provider: string; id: string };
  thinking: string;
  mcp: string[];
}

export type GetRunResult = { ok: true; run: RunRecord } | { ok: false; reason: "not_found" | "unreadable" };

export interface ListRunOptions {
  kind?: RunKind;
  requirement?: string;
  states?: RunState[];
  offset?: number;
  limit: number;
}

export interface ListRunResult {
  items: RunRecord[];
  total: number;
  runningCount: number;
}

export type UpdateRunFields = Partial<
  Pick<RunRecord, "state" | "stateReason" | "turns" | "result" | "errorDetails" | "endedAt">
>;

const UPDATE_PATCH_KEYS = [
  "state",
  "stateReason",
  "turns",
  "result",
  "errorDetails",
  "endedAt",
] as const satisfies readonly (keyof UpdateRunFields)[];

const TERMINAL_STATES = new Set<RunState>(["completed", "failed", "stopped"]);
const UNIVERSAL_TARGETS = new Set<RunState>(["failed", "stopped"]);
const TRANSITIONS: Partial<Record<RunState, Set<RunState>>> = {
  queued: new Set(["running"]),
  running: new Set(["pausing", "paused_network", "waiting_answer", "completed"]),
  pausing: new Set(["paused"]),
  paused: new Set(["running"]),
  paused_network: new Set(["running"]),
  waiting_answer: new Set(["running"]),
  interrupted: new Set(["running"]),
};

const RUNNING_LIKE_STATES = new Set<RunState>(["running", "pausing", "waiting_answer"]);

export function isTerminalState(state: RunState): boolean {
  return TERMINAL_STATES.has(state);
}

export function assertTransition(from: RunState, to: RunState): void {
  if (
    isTerminalState(from) ||
    from === to ||
    (!UNIVERSAL_TARGETS.has(to) && !TRANSITIONS[from]?.has(to))
  ) {
    throw new Error(`不允许的状态转换: ${from} → ${to}`);
  }
}

function pickUpdatePatch(fields: Record<string, unknown>): UpdateRunFields {
  if ("shellToken" in fields) throw new Error("不允许改写 shellToken");
  const patch: Record<string, unknown> = {};
  for (const key of UPDATE_PATCH_KEYS) {
    if (key in fields) patch[key] = fields[key];
  }
  return patch as UpdateRunFields;
}

export class RunStore {
  private readonly dataRoot: string;
  private readonly repoId: string;
  private readonly daemonStartedAt: string;

  constructor(options: { dataRoot: string; repoId: string; daemonStartedAt: string }) {
    this.dataRoot = options.dataRoot;
    this.repoId = options.repoId;
    this.daemonStartedAt = options.daemonStartedAt;
  }

  async create(input: CreateRunInput): Promise<RunRecord> {
    if (typeof input.requirement !== "string" || input.requirement.length === 0) {
      throw new Error("缺少 requirement");
    }
    if (input.kind === "role") {
      if (typeof input.parentRunId !== "string" || input.parentRunId.length === 0) {
        throw new Error("kind 为 role 时必须提供 parentRunId");
      }
      if (typeof input.role !== "string" || !input.role.startsWith("pi-company.")) {
        throw new Error(`role 必须以 pi-company. 开头: ${input.role}`);
      }
    }

    const id = randomUUID();
    const now = new Date().toISOString();
    const run: RunRecord = {
      id,
      shellToken: randomUUID(),
      kind: input.kind,
      role: input.kind === "role" ? input.role : undefined,
      requirement: input.requirement,
      parentRunId: input.kind === "role" ? input.parentRunId : undefined,
      task: input.task,
      cwd: input.cwd,
      writePaths: input.writePaths,
      readPaths: input.readPaths,
      model: input.model,
      thinking: input.thinking,
      mcp: input.mcp,
      state: "queued",
      startedAt: now,
      updatedAt: now,
      turns: 0,
      errorDetails: { status: "none" },
      daemonStartedAt: this.daemonStartedAt,
    };
    await createDocument(this.statePath(id), run);
    return run;
  }

  async get(id: string): Promise<GetRunResult> {
    let path: string;
    try {
      path = this.statePath(id);
    } catch {
      return { ok: false, reason: "not_found" };
    }
    let result;
    try {
      result = await readDocument(path);
    } catch {
      return { ok: false, reason: "unreadable" };
    }
    if (!result.exists) return { ok: false, reason: "not_found" };
    return { ok: true, run: result.data as RunRecord };
  }

  async list(options: ListRunOptions): Promise<ListRunResult> {
    const ids = await this.listRunIds();
    const records: RunRecord[] = [];
    for (const id of ids) {
      const result = await this.get(id);
      if (result.ok) records.push(result.run);
    }
    const filtered = records.filter(
      (run) =>
        (options.kind === undefined || run.kind === options.kind) &&
        (options.requirement === undefined || run.requirement === options.requirement) &&
        (options.states === undefined || options.states.includes(run.state)),
    );
    filtered.sort((a, b) => {
      if (a.startedAt !== b.startedAt) return a.startedAt < b.startedAt ? 1 : -1;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    const offset = options.offset ?? 0;
    return {
      items: filtered.slice(offset, offset + options.limit),
      total: filtered.length,
      runningCount: filtered.filter((run) => RUNNING_LIKE_STATES.has(run.state)).length,
    };
  }

  async update(id: string, fields: UpdateRunFields): Promise<RunRecord> {
    const dir = runDataDir(this.dataRoot, this.repoId, id);
    const path = join(dir, "state.json");
    const precheck = await readDocument(path);
    if (!precheck.exists) throw new Error(`运行不存在: ${id}`);
    return withDirLock(dir, async () => {
      const current = await readDocument(path);
      if (!current.exists) throw new Error(`运行不存在: ${id}`);
      const run = current.data as RunRecord;
      if (fields.state !== undefined) assertTransition(run.state, fields.state);
      const patch = pickUpdatePatch(fields);
      const merged: RunRecord = { ...run, ...patch };
      merged.endedAt = run.endedAt ?? (isTerminalState(merged.state) ? new Date().toISOString() : undefined);
      merged.updatedAt = new Date().toISOString();
      await writeDocument(path, merged, { expectedVersion: current.version });
      return merged;
    });
  }

  async markInterruptedOnStartup(): Promise<{ interrupted: string[]; failed: Array<{ id: string; reason: string }> }> {
    const ids = await this.listRunIds();
    const interrupted: string[] = [];
    const failed: Array<{ id: string; reason: string }> = [];
    for (const id of ids) {
      const result = await this.get(id);
      if (!result.ok) {
        failed.push({ id, reason: result.reason });
        continue;
      }
      if (!this.needsInterruptedMark(result.run)) continue;
      try {
        if (await this.writeInterrupted(id)) interrupted.push(id);
      } catch (error) {
        failed.push({ id, reason: (error as Error).message });
      }
    }
    return { interrupted, failed };
  }

  async markOwnRunsInterrupted(): Promise<{ interrupted: string[]; failed: Array<{ id: string; reason: string }> }> {
    const ids = await this.listRunIds();
    const interrupted: string[] = [];
    const failed: Array<{ id: string; reason: string }> = [];
    for (const id of ids) {
      const result = await this.get(id);
      if (!result.ok) {
        failed.push({ id, reason: result.reason });
        continue;
      }
      if (!this.needsOwnInterruptedMark(result.run)) continue;
      try {
        if (await this.writeOwnInterrupted(id)) interrupted.push(id);
      } catch (error) {
        failed.push({ id, reason: (error as Error).message });
      }
    }
    return { interrupted, failed };
  }

  private needsInterruptedMark(run: RunRecord): boolean {
    if (run.state === "interrupted" || isTerminalState(run.state)) return false;
    return run.daemonStartedAt !== this.daemonStartedAt;
  }

  private needsOwnInterruptedMark(run: RunRecord): boolean {
    if (run.state === "interrupted" || isTerminalState(run.state)) return false;
    return run.daemonStartedAt === this.daemonStartedAt;
  }

  private async writeOwnInterrupted(id: string): Promise<boolean> {
    const dir = runDataDir(this.dataRoot, this.repoId, id);
    const path = join(dir, "state.json");
    return withDirLock(dir, async () => {
      const current = await readDocument(path);
      if (!current.exists) throw new Error(`运行不存在: ${id}`);
      const run = current.data as RunRecord;
      if (!this.needsOwnInterruptedMark(run)) return false;
      const merged: RunRecord = {
        ...run,
        state: "interrupted",
        stateReason: run.stateReason || "守护进程退出：运行在退出前未完成",
        updatedAt: new Date().toISOString(),
      };
      await writeDocument(path, merged, { expectedVersion: current.version });
      return true;
    });
  }

  private async writeInterrupted(id: string): Promise<boolean> {
    const dir = runDataDir(this.dataRoot, this.repoId, id);
    const path = join(dir, "state.json");
    return withDirLock(dir, async () => {
      const current = await readDocument(path);
      if (!current.exists) throw new Error(`运行不存在: ${id}`);
      const run = current.data as RunRecord;
      if (!this.needsInterruptedMark(run)) return false;
      const merged: RunRecord = {
        ...run,
        state: "interrupted",
        stateReason: run.stateReason || "守护进程重启：运行在重启前未完成",
        daemonStartedAt: this.daemonStartedAt,
        updatedAt: new Date().toISOString(),
      };
      await writeDocument(path, merged, { expectedVersion: current.version });
      return true;
    });
  }

  private statePath(id: string): string {
    return join(runDataDir(this.dataRoot, this.repoId, id), "state.json");
  }

  private runsDir(): string {
    return runsDataDir(this.dataRoot, this.repoId);
  }

  private async listRunIds(): Promise<string[]> {
    try {
      const entries = await readdir(this.runsDir(), { withFileTypes: true });
      return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }
}
