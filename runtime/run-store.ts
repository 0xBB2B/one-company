import type { AgentFingerprint } from "./agent-resolve.ts";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { repositoryDatabase, withDatabase, uuidv7, UUID_V7_PATTERN } from "./database.ts";

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
  /** 实际运行所用角色定义与 skills 的来源和 hash。 */
  agent?: AgentFingerprint;
  state: RunState;
  stateReason?: string;
  startedAt: string;
  updatedAt: string;
  endedAt?: string;
  turns: number;
  usage?: RunUsage;
  pausedMs?: number;
  pausedAt?: string;
  errorDetails: { recordId?: string; status: "none" | "saved" | "incomplete" | "unreadable" | "unavailable" };
  daemonStartedAt: string;
}

export interface RunUsage { input: number; output: number; cacheRead: number; cacheWrite: number; toolUses: number }

export interface CreateRunInput {
  /** 缺省生成；派工须先占用尝试再建记录时由调用方给出。 */
  id?: string;
  kind: RunKind;
  role?: string;
  requirement: string;
  parentRunId?: string;
  standalone?: boolean;
  task: string;
  cwd: string;
  writePaths: string[];
  readPaths: string[];
  model: { provider: string; id: string };
  thinking: string;
  mcp: string[];
  agent?: AgentFingerprint;
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
  Pick<RunRecord, "state" | "stateReason" | "turns" | "usage" | "pausedMs" | "pausedAt" | "errorDetails" | "endedAt">
>;

const UPDATE_PATCH_KEYS = [
  "state",
  "stateReason",
  "turns",
  "usage",
  "pausedMs",
  "pausedAt",
  "errorDetails",
  "endedAt",
] as const satisfies readonly (keyof UpdateRunFields)[];

const TERMINAL_STATES = new Set<RunState>(["completed", "failed", "stopped"]);
const UNIVERSAL_TARGETS = new Set<RunState>(["failed", "stopped"]);
const TRANSITIONS: Partial<Record<RunState, Set<RunState>>> = {
  queued: new Set(["running"]),
  running: new Set(["pausing", "paused_network", "waiting_answer", "completed"]),
  pausing: new Set(["paused", "completed"]),
  paused: new Set(["running", "completed"]),
  paused_network: new Set(["running"]),
  waiting_answer: new Set(["running", "pausing"]),
  interrupted: new Set(["queued", "running"]),
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

const UUID_PATTERN = UUID_V7_PATTERN.source;
const RunRecordSchema = Type.Object({
  id: Type.String({ pattern: UUID_PATTERN }),
  shellToken: Type.String({ minLength: 32 }),
  kind: Type.Union([Type.Literal("requirement"), Type.Literal("role")]),
  role: Type.Optional(Type.String({ pattern: "^pi-company\\." })),
  requirement: Type.String({ minLength: 1 }),
  parentRunId: Type.Optional(Type.String({ pattern: UUID_PATTERN })),
  task: Type.String(), cwd: Type.String({ minLength: 1 }),
  writePaths: Type.Array(Type.String()), readPaths: Type.Array(Type.String()),
  model: Type.Object({ provider: Type.String({ minLength: 1 }), id: Type.String({ minLength: 1 }) }),
  thinking: Type.String(), mcp: Type.Array(Type.String()),
  agent: Type.Optional(Type.Object({ name: Type.String(), source: Type.String(), path: Type.String(), hash: Type.String(),
    skills: Type.Array(Type.Object({ name: Type.String(), path: Type.String(), hash: Type.String() })) })),
  state: Type.Union([...Object.keys(TRANSITIONS), ...TERMINAL_STATES].map((state) => Type.Literal(state))),
  stateReason: Type.Optional(Type.String()),
  startedAt: Type.String({ minLength: 1 }), updatedAt: Type.String({ minLength: 1 }), endedAt: Type.Optional(Type.String()),
  turns: Type.Integer({ minimum: 0 }),
  usage: Type.Optional(Type.Object({ input: Type.Integer({ minimum: 0 }), output: Type.Integer({ minimum: 0 }), cacheRead: Type.Integer({ minimum: 0 }),
    cacheWrite: Type.Integer({ minimum: 0 }), toolUses: Type.Integer({ minimum: 0 }) }, { additionalProperties: false })),
  pausedMs: Type.Optional(Type.Integer({ minimum: 0 })),
  pausedAt: Type.Optional(Type.String({ minLength: 1 })),
  errorDetails: Type.Object({
    recordId: Type.Optional(Type.String({ pattern: UUID_PATTERN })),
    status: Type.Union(["none", "saved", "incomplete", "unreadable", "unavailable"].map((status) => Type.Literal(status))),
  }),
  daemonStartedAt: Type.String({ minLength: 1 }),
});

function checkedRun(value: unknown, id: string): RunRecord {
  if (!Value.Check(RunRecordSchema, value) || value.id !== id || (value.kind === "role" && !value.role)) {
    throw new Error(`运行记录损坏: ${id}`);
  }
  return value as RunRecord;
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
      if (!input.standalone && (typeof input.parentRunId !== "string" || input.parentRunId.length === 0)) {
        throw new Error("kind 为 role 时必须提供 parentRunId");
      }
      if (typeof input.role !== "string" || !input.role.startsWith("pi-company.")) {
        throw new Error(`role 必须以 pi-company. 开头: ${input.role}`);
      }
    }

    const id = input.id ?? uuidv7();
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
      ...(input.agent ? { agent: input.agent } : {}),
      state: "queued",
      startedAt: now,
      updatedAt: now,
      turns: 0,
      errorDetails: { status: "none" },
      daemonStartedAt: this.daemonStartedAt,
    };
    checkedRun(run, id);
    withDatabase(this.databasePath(), (db) => db.create("runs", id, run, id));
    return run;
  }

  async createOrReuseRequirement(input: CreateRunInput): Promise<{ run: RunRecord; reused: boolean }> {
    if (input.kind !== "requirement") throw new Error("需求单实例入口只接受需求代理");
    try { return { run: await this.create(input), reused: false }; }
    catch (error) {
      if (!(error as Error).message.includes("active_requirement")) throw error;
      const active = (await this.list({ kind: "requirement", requirement: input.requirement, limit: Number.MAX_SAFE_INTEGER })).items
        .find((run) => !isTerminalState(run.state) && run.state !== "interrupted");
      if (active) return { run: active, reused: true };
      throw error;
    }
  }

  async get(id: string): Promise<GetRunResult> {
    if (!UUID_V7_PATTERN.test(id)) return { ok: false, reason: "not_found" };
    try {
      const result = withDatabase(this.databasePath(), (db) => db.read("runs", id));
      if (!result) return { ok: false, reason: "not_found" };
      return { ok: true, run: checkedRun(result.data, id) };
    } catch { return { ok: false, reason: "unreadable" }; }
  }

  async list(options: ListRunOptions): Promise<ListRunResult> {
    const database = this.databasePath();
    const records = existsSync(database) ? withDatabase(database, (db) => db.list("runs").map((record) => {
      try { return checkedRun(record.data, record.key); }
      catch { throw new Error(`运行记录不可读: ${record.key}（unreadable）`); }
    })) : [];
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
    return this.updateFields(id, () => fields);
  }

  async recordTurn(id: string): Promise<RunRecord> {
    return this.updateFields(id, (run) => ({ turns: run.turns + 1 }));
  }

  async recordUsage(id: string, delta: Partial<RunUsage>): Promise<RunRecord> {
    return this.updateFields(id, (run) => {
      const base = run.usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, toolUses: 0 };
      const add = (key: keyof RunUsage) => base[key] + Math.max(0, Math.floor(delta[key] ?? 0));
      return { usage: { input: add("input"), output: add("output"), cacheRead: add("cacheRead"), cacheWrite: add("cacheWrite"), toolUses: add("toolUses") } };
    });
  }

  /** 确认暂停时记下起点；恢复时把这段时间累加进 pausedMs，面板计时据此扣除。 */
  async recordPause(id: string, at: string): Promise<RunRecord> {
    return this.updateFields(id, (run) => run.pausedAt ? {} : { pausedAt: at });
  }

  async recordResume(id: string, at: string): Promise<RunRecord> {
    return this.updateFields(id, (run) => {
      if (!run.pausedAt) return {};
      const elapsed = Math.max(0, Date.parse(at) - Date.parse(run.pausedAt));
      return { pausedMs: (run.pausedMs ?? 0) + (Number.isFinite(elapsed) ? elapsed : 0), pausedAt: undefined };
    });
  }

  private async updateFields(id: string, build: (run: RunRecord) => UpdateRunFields): Promise<RunRecord> {
    if (!UUID_V7_PATTERN.test(id)) throw new Error("运行编号必须是 UUIDv7");
    return withDatabase(this.databasePath(), (db) => db.transaction(() => {
      const current = db.read("runs", id);
      if (!current) throw new Error(`运行不存在: ${id}`);
      const run = checkedRun(current.data, id);
      const fields = build(run);
      if (fields.state !== undefined) assertTransition(run.state, fields.state);
      const patch = pickUpdatePatch(fields);
      const merged: RunRecord = { ...run, ...patch };
      merged.endedAt = run.endedAt ?? (isTerminalState(merged.state) ? new Date().toISOString() : undefined);
      merged.updatedAt = new Date().toISOString();
      checkedRun(merged, id);
      db.update("runs", id, current.version, merged);
      return merged;
    }));
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
    return withDatabase(this.databasePath(), (db) => db.transaction(() => {
      const current = db.read("runs", id);
      if (!current) throw new Error(`运行不存在: ${id}`);
      const run = checkedRun(current.data, id);
      if (!this.needsOwnInterruptedMark(run)) return false;
      const merged: RunRecord = {
        ...run,
        state: "interrupted",
        stateReason: run.stateReason || "守护进程退出：运行在退出前未完成",
        updatedAt: new Date().toISOString(),
      };
      checkedRun(merged, id);
      db.update("runs", id, current.version, merged);
      return true;
    }));
  }

  private async writeInterrupted(id: string): Promise<boolean> {
    return withDatabase(this.databasePath(), (db) => db.transaction(() => {
      const current = db.read("runs", id);
      if (!current) throw new Error(`运行不存在: ${id}`);
      const run = checkedRun(current.data, id);
      if (!this.needsInterruptedMark(run)) return false;
      const merged: RunRecord = {
        ...run,
        state: "interrupted",
        stateReason: run.stateReason || "守护进程重启：运行在重启前未完成",
        daemonStartedAt: this.daemonStartedAt,
        updatedAt: new Date().toISOString(),
      };
      checkedRun(merged, id);
      db.update("runs", id, current.version, merged);
      return true;
    }));
  }

  private databasePath(): string { return repositoryDatabase(this.dataRoot, this.repoId); }

  private async listRunIds(): Promise<string[]> {
    return withDatabase(this.databasePath(), (db) => db.list("runs").map((record) => record.key));
  }
}
