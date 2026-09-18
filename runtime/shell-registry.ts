import { execFile, spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import type { Clock, TimerHandle } from "./clock.ts";
import { withDatabase } from "./database.ts";
import { assertExecutionGuardCurrent, guardedOutputLimit } from "./execution-guard.ts";
import type { ExecutionGuard } from "./execution-guard.ts";

const execFileAsync = promisify(execFile);

export interface Host {
  kind: "main" | "requirement" | "role";
  id: string;
  role?: string;
  runId?: string;
}

export interface PsEntry {
  pid: number;
  pgid: number;
  ppid: number;
  startedAt: number;
  command: string;
  token: string | null;
}

export type TaskStatus =
  | "starting"
  | "running"
  | "stopping"
  | "uncertain"
  | "exited"
  | "failed"
  | "stopped"
  | "timed_out";

export type TaskActivity = "active" | "uncertain" | "ended";

export interface TaskRecord {
  taskId: string;
  host: Host;
  command: string;
  cwd: string;
  mode: "wait" | "background";
  pid: number;
  pgid: number;
  startedAt: number | null;
  timeoutSeconds?: number;
  status: TaskStatus;
  activity: TaskActivity;
  exitCode: number | null;
  reason?: string;
  descendants: number[];
  descendantsScanned: boolean;
  stoppedBy?: "signal" | "user";
  identityVerified: boolean;
}

export interface SpawnInput {
  taskId: string;
  host: Host;
  command: string;
  args?: string[];
  cwd?: string;
  mode: "wait" | "background";
  timeoutSeconds?: number;
  runToken: string;
  env?: NodeJS.ProcessEnv;
  inheritEnv?: boolean;
  onOutput?: (chunk: Buffer, stream: "stdout" | "stderr") => void;
  /** 仅由可信运行时闭包注入，不进入任务记录、环境或持久化数据。 */
  executionGuard?: ExecutionGuard;
}

export type SpawnResult = { ok: true; task: TaskRecord } | { ok: false; reason: string };
export type StopResult = { ok: true; task: TaskRecord } | { ok: false; reason: string };
export type MarkStoppedByUserResult = { ok: true; task: TaskRecord } | { ok: false; reason: string };
export type AdoptOrphansResult = { ok: true; tasks: TaskRecord[] } | { ok: false; reason: string };
export type ProbeGroupResult = { ok: true; state: "alive" | "gone" } | { ok: false; reason: string };

export interface ShellRegistryProbes {
  kill?: (pid: number, signal: NodeJS.Signals | 0) => void;
  ps?: () => Promise<PsEntry[]>;
  pidStartedAt?: (pid: number) => Promise<number | null>;
}

export interface ShellRegistryOptions {
  clock: Clock;
  probes?: ShellRegistryProbes;
  database?: string;
}

interface PersistedTaskRecord {
  cwd: string;
  taskId: string;
  pid: number;
  pgid: number;
  startedAt: number;
  token: string;
  host: Host;
  command: string;
}

interface GuardedExecutionState {
  child: ReturnType<typeof spawn>;
  task?: TaskRecord;
  readonly generation: symbol;
  pid?: number;
  pgid?: number;
  startedAt?: number | null;
  assertCurrent: () => void;
  maxOutputBytes: number;
  onOutput?: (chunk: Buffer, stream: "stdout" | "stderr") => void;
  chunks: Array<{ chunk: Buffer; stream: "stdout" | "stderr" }>;
  outputBytes: number;
  error?: Error;
  exitObserved: boolean;
  exitCode: number | null;
  closeObserved: boolean;
  closePromise: Promise<void>;
  resolveClose: () => void;
  registrationComplete: boolean;
  descendants: number[];
  stopRequested: boolean;
  stopPromise?: Promise<StopResult>;
  terminationProven: boolean;
  terminalStatus?: "exited" | "failed" | "stopped" | "timed_out";
  terminalPromise: Promise<void>;
  resolveTerminal: () => void;
  consumption: "available" | "consuming" | "delivered" | "failed";
}

const MONITOR_INTERVAL_MS = 150;
const GUARDED_WAIT_MS = 5_000;
const GUARDED_OUTPUT_OVERFLOW = "受保护命令输出超过允许上限";
const DESCENDANT_SCAN_THROTTLE_MS = 1_000;
const STOP_POLL_INTERVAL_MS = 150;
const STOP_QUIET_WAIT_MS = 1_000;
const STOP_TIMEOUT_MS = 5_000;
const STOP_CONFIRM_COUNT = 2;
const TOKEN_ENV_VAR = "PI_COMPANY_SHELL_TOKEN";
const PS_SAMPLE_TIMEOUT_MS = 3_000;
const PS_DEGRADE_COOLDOWN_MS = 5_000;
const PS_EXEC_OPTS = {
  env: { ...process.env, LC_ALL: "C" },
  maxBuffer: 32 * 1024 * 1024,
  timeout: PS_SAMPLE_TIMEOUT_MS,
  killSignal: "SIGKILL" as const,
};

function isTerminalStatus(status: TaskStatus): boolean {
  return status === "exited" || status === "failed" || status === "stopped" || status === "timed_out";
}

function hostEquals(a: Host, b: Host): boolean {
  return a.kind === b.kind && a.id === b.id && a.role === b.role && a.runId === b.runId;
}

function isValidPsEntry(entry: PsEntry): boolean {
  return entry.pid > 1 && entry.pgid > 1;
}

function defaultKill(pid: number, signal: NodeJS.Signals | 0): void {
  process.kill(pid, signal);
}

export function shellOwnerKey(input: { windowId: string; cwd: string; sessionId: string }): string {
  return `${input.windowId}:${input.cwd}:${input.sessionId}`;
}

export function probeProcessGroup(
  pgid: number,
  kill: (pid: number, signal: NodeJS.Signals | 0) => void = defaultKill,
): ProbeGroupResult {
  if (!(pgid > 1)) return { ok: false, reason: `拒绝对 pgid=${pgid} 探测/发信号` };
  try {
    kill(-pgid, 0);
    return { ok: true, state: "alive" };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return { ok: true, state: "gone" };
    return { ok: false, reason: (error as Error).message ?? String(error) };
  }
}

function probeSinglePid(
  pid: number,
  kill: (pid: number, signal: NodeJS.Signals | 0) => void,
): { state: "alive" } | { state: "gone" } | { state: "error"; reason: string } {
  try {
    kill(pid, 0);
    return { state: "alive" };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return { state: "gone" };
    return { state: "error", reason: (error as Error).message ?? String(error) };
  }
}

function scanDescendants(pgid: number, token: string, entries: PsEntry[]): number[] {
  return entries
    .filter(isValidPsEntry)
    .filter((entry) => entry.token === token && entry.pgid !== pgid)
    .map((entry) => entry.pid);
}

export async function findEscapedDescendants(
  pgid: number,
  token: string,
  ps: () => Promise<PsEntry[]>,
): Promise<{ ok: true; descendants: number[] } | { ok: false }> {
  let entries: PsEntry[];
  try {
    entries = await ps();
  } catch {
    return { ok: false };
  }
  return { ok: true, descendants: scanDescendants(pgid, token, entries) };
}

async function queryPidStartedAt(pid: number): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync("ps", ["-o", "lstart=", "-p", String(pid)], PS_EXEC_OPTS);
    const trimmed = stdout.trim();
    if (!trimmed) return null;
    const parsed = new Date(trimmed).getTime();
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

const PS_LINE_RE =
  /^\s*(\d+)\s+(\d+)\s+(\d+)\s+((?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+\S+\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.*)$/;

function parsePsLine(line: string): { pid: number; pgid: number; ppid: number; startedAt: number; command: string } | null {
  const match = PS_LINE_RE.exec(line);
  if (!match) return null;
  const startedAt = new Date(match[4]).getTime();
  if (!Number.isFinite(startedAt)) return null;
  return {
    pid: Number(match[1]),
    pgid: Number(match[2]),
    ppid: Number(match[3]),
    startedAt,
    command: match[5].trim(),
  };
}

export function parsePsTable(text: string): PsEntry[] {
  const dataLines = text.split("\n").slice(1).filter((line) => line.trim().length > 0);
  const rows = dataLines
    .map(parsePsLine)
    .filter((row): row is NonNullable<ReturnType<typeof parsePsLine>> => row !== null);
  if (dataLines.length > 0 && rows.length === 0) {
    throw new Error("ps 输出解析失败：未能从非空数据中解析出任何记录");
  }
  return rows.map((row) => ({ ...row, token: null }));
}

async function readTokenMap(): Promise<Map<number, string>> {
  const map = new Map<number, string>();
  if (process.platform === "linux") {
    const { stdout } = await execFileAsync("ps", ["-axo", "pid"], PS_EXEC_OPTS);
    const pids = stdout
      .split("\n")
      .slice(1)
      .map((line) => Number(line.trim()))
      .filter((pid) => Number.isFinite(pid));
    await Promise.all(
      pids.map(async (pid) => {
        try {
          const environ = await readFile(`/proc/${pid}/environ`, "utf8");
          const entry = environ.split("\0").find((item) => item.startsWith(`${TOKEN_ENV_VAR}=`));
          if (entry) map.set(pid, entry.slice(TOKEN_ENV_VAR.length + 1));
        } catch {
          // 进程已退出或无权限读取该 pid 的 environ，跳过
        }
      }),
    );
    return map;
  }

  const [{ stdout: plainOut }, { stdout: envOut }] = await Promise.all([
    execFileAsync("ps", ["-axwwo", "pid,command"], PS_EXEC_OPTS),
    execFileAsync("ps", ["-axwwEo", "pid,command"], PS_EXEC_OPTS),
  ]);
  const plainByPid = new Map<number, string>();
  for (const line of plainOut.split("\n").slice(1)) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (match) plainByPid.set(Number(match[1]), match[2]);
  }
  const tokenRe = new RegExp(`(?:^|\\s)${TOKEN_ENV_VAR}=(\\S+)`);
  let prefixMismatchCount = 0;
  for (const line of envOut.split("\n").slice(1)) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const full = match[2];
    const plain = plainByPid.get(pid);
    if (plain === undefined) continue;
    if (!full.startsWith(plain)) {
      if (full.includes(`${TOKEN_ENV_VAR}=`)) prefixMismatchCount++;
      continue;
    }
    const envSegment = full.slice(plain.length);
    const tokenMatch = tokenRe.exec(envSegment);
    if (tokenMatch) map.set(pid, tokenMatch[1]);
  }
  if (prefixMismatchCount > 0) {
    throw new Error(`ps 环境段切分失败：${prefixMismatchCount} 个 pid 的 -E 输出与纯净命令前缀不一致`);
  }
  return map;
}

async function defaultPsSampler(): Promise<PsEntry[]> {
  const [{ stdout: baseOut }, tokenMap] = await Promise.all([
    execFileAsync("ps", ["-axwwo", "pid,pgid,ppid,lstart,command"], PS_EXEC_OPTS),
    readTokenMap(),
  ]);
  const rows = parsePsTable(baseOut);
  return rows.map((row) => ({ ...row, token: tokenMap.get(row.pid) ?? null }));
}

export class ShellRegistry {
  private readonly clock: Clock;
  private readonly kill: (pid: number, signal: NodeJS.Signals | 0) => void;
  private readonly rawPs: () => Promise<PsEntry[]>;
  private psChain: Promise<void> = Promise.resolve();
  private psDegradedUntil = 0;
  private readonly tasks = new Map<string, TaskRecord>();
  private readonly launching = new Map<string, symbol>();
  private readonly taskGenerations = new WeakMap<TaskRecord, symbol>();
  private readonly taskTokens = new Map<string, string>();
  private readonly monitors = new Map<string, ReturnType<typeof setInterval>>();
  private readonly inspecting = new Map<string, Promise<void>>();
  private readonly stopping = new Map<string, Promise<StopResult>>();
  private readonly stopVersions = new Map<string, number>();
  private readonly timeoutTimers = new Map<string, TimerHandle>();
  private readonly listeners = new Map<string, Set<(task: TaskRecord) => void>>();
  private readonly lastDescendantScanAt = new Map<string, number>();
  private readonly guardedTasks = new WeakMap<TaskRecord, GuardedExecutionState>();

  private readonly pidStartedAt: (pid: number) => Promise<number | null>;
  private readonly database?: string;

  constructor(options: ShellRegistryOptions) {
    this.clock = options.clock;
    this.kill = options.probes?.kill ?? defaultKill;
    this.rawPs = options.probes?.ps ?? defaultPsSampler;
    this.pidStartedAt = options.probes?.pidStartedAt ?? queryPidStartedAt;
    this.database = options.database;
    this.clock.startGapWatcher();
  }

  private async writeTaskRecord(task: TaskRecord, token: string, guarded?: GuardedExecutionState): Promise<void> {
    if (!this.database) return;
    const record: PersistedTaskRecord = {
      cwd: task.cwd,
      taskId: task.taskId,
      pid: guarded?.pid ?? task.pid,
      pgid: guarded?.pgid ?? task.pgid,
      startedAt: (guarded ? guarded.startedAt : task.startedAt) ?? 0,
      token,
      host: task.host,
      command: task.command,
    };
    withDatabase(this.database, (db) => db.create("shells", task.taskId, record));
  }

  private async deleteTaskRecord(task: TaskRecord): Promise<void> {
    if (!this.database) return;
    try {
      withDatabase(this.database, (db) => db.transaction(() => {
        const record = db.read("shells", task.taskId);
        if (record) db.remove("shells", task.taskId, record.version);
      }));
    } catch (error) { task.reason = `Shell 登记清理失败: ${(error as Error).message}`; this.notify(task); }
  }

  // 只有超时才计入熔断——解析失败等其他拒绝仅让本轮采样按不可用处理，不影响后续调用
  private timedRawPs(): Promise<PsEntry[]> {
    return new Promise<PsEntry[]>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.psDegradedUntil = this.clock.now() + PS_DEGRADE_COOLDOWN_MS;
        reject(new Error("ps 采样超时"));
      }, PS_SAMPLE_TIMEOUT_MS);
      timer.unref?.();
      this.rawPs().then(
        (entries) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(entries);
        },
        (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  // 全局串行化，避免多路 ps 采样并发在飞
  private readonly ps = (): Promise<PsEntry[]> => {
    if (this.clock.now() < this.psDegradedUntil) {
      return Promise.reject(new Error("ps 近期超时，冷却中"));
    }
    const run = this.psChain.then(() => this.timedRawPs());
    this.psChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  private async trySample(): Promise<PsEntry[] | null> {
    try {
      return await this.ps();
    } catch {
      return null;
    }
  }

  list(owner?: Host): TaskRecord[] {
    const all = Array.from(this.tasks.values());
    return owner ? all.filter((task) => hostEquals(task.host, owner)) : all;
  }

  get(taskId: string): TaskRecord | undefined {
    return this.tasks.get(taskId);
  }

  subscribe(taskId: string, listener: (task: TaskRecord) => void): () => void {
    const set = this.listeners.get(taskId) ?? new Set();
    set.add(listener);
    this.listeners.set(taskId, set);
    return () => {
      set.delete(listener);
    };
  }

  private notify(task: TaskRecord): void {
    const set = this.listeners.get(task.taskId);
    if (!set) return;
    for (const listener of set) {
      try {
        listener(task);
      } catch {
        // 单个订阅方故障不能影响任务状态流转或其他订阅方
      }
    }
  }

  private markUncertain(task: TaskRecord, reason: string): void {
    const guarded = this.guardedTasks.get(task);
    if (guarded) {
      guarded.terminationProven = false;
      delete guarded.terminalStatus;
      this.discardGuardedOutput(task);
    }
    task.status = "uncertain";
    task.activity = "uncertain";
    task.reason = reason;
    this.clearTimeoutTimer(task.taskId);
    this.notify(task);
  }

  private clearTimeoutTimer(taskId: string): void {
    const handle = this.timeoutTimers.get(taskId);
    if (handle) {
      this.clock.clearTimer(handle);
      this.timeoutTimers.delete(taskId);
    }
  }

  private stopMonitor(taskId: string): void {
    const timer = this.monitors.get(taskId);
    if (timer) {
      clearInterval(timer);
      this.monitors.delete(taskId);
    }
  }

  private startMonitor(task: TaskRecord): void {
    this.stopMonitor(task.taskId);
    const timer = setInterval(() => {
      if (this.inspecting.has(task.taskId)) return;
      void this.inspect(task.taskId);
    }, MONITOR_INTERVAL_MS);
    timer.unref?.();
    this.monitors.set(task.taskId, timer);
  }

  private handleExit(task: TaskRecord, code: number | null): void {
    task.exitCode = code;
  }

  private isCurrentGuardedState(task: TaskRecord, state: GuardedExecutionState): boolean {
    return state.task === task
      && this.tasks.get(task.taskId) === task
      && this.taskGenerations.get(task) === state.generation
      && this.guardedTasks.get(task) === state
      && state.pid !== undefined
      && state.child.pid === state.pid;
  }

  private assertCurrentGuardedState(task: TaskRecord, state: GuardedExecutionState): void {
    if (!this.isCurrentGuardedState(task, state)) throw new Error("本次受保护命令的私有结果证明已失效");
  }

  private lockGuardFailure(state: GuardedExecutionState, error: unknown): void {
    if (!state.error) state.error = error instanceof Error ? error : new Error(String(error));
    state.chunks.length = 0;
    state.outputBytes = 0;
    state.consumption = "failed";
  }

  discardGuardedOutput(task: TaskRecord): void {
    const state = this.guardedTasks.get(task);
    if (!state || state.task !== task) return;
    state.chunks.length = 0;
    state.outputBytes = 0;
    state.consumption = "failed";
  }

  private requestGuardedFailure(state: GuardedExecutionState): void {
    state.stopRequested = true;
    if (!state.registrationComplete || !state.task || state.stopPromise) return;
    const task = state.task;
    const operation = this.stopWithFinalStatus(task.taskId, "failed", task);
    state.stopPromise = operation;
    void operation.then(
      (result) => {
        if (!this.isCurrentGuardedState(task, state)) return;
        if (!result.ok || result.task !== task || result.task.activity !== "ended") {
          this.markUncertain(task, result.ok ? "受保护命令停止未形成可靠结束证明" : result.reason);
        }
      },
      (error) => {
        if (!this.isCurrentGuardedState(task, state)) return;
        this.stopMonitor(task.taskId);
        this.markUncertain(task, `受保护命令停止失败: ${(error as Error).message ?? String(error)}`);
      },
    );
  }

  async spawn(input: SpawnInput): Promise<SpawnResult> {
    const taskId = input.taskId;
    if (this.tasks.has(taskId) || this.launching.has(taskId)) {
      return { ok: false, reason: `任务 ${taskId} 已登记或正在启动` };
    }
    const generation = Symbol(taskId);
    this.launching.set(taskId, generation);
    try {

    const token = `${input.runToken}:${taskId}`;
    const command = input.command;
    const args = input.args ? [...input.args] : [];
    const cwd = input.cwd;
    const mode = input.mode;
    const timeoutSeconds = input.timeoutSeconds;
    const host = { ...input.host };
    const onOutput = input.onOutput;
    const runToken = input.runToken;
    const inheritEnv = input.inheritEnv;
    const env = { ...(inheritEnv === false ? {} : process.env), ...input.env, [TOKEN_ENV_VAR]: `${runToken}:${taskId}` };
    const guardInput = input.executionGuard;
    const guard = guardInput ? {
      assertCurrent: guardInput.assertCurrent,
      maxOutputBytes: guardedOutputLimit(guardInput.maxOutputBytes),
    } : undefined;

    if (guard) assertExecutionGuardCurrent(guard.assertCurrent);
    const child = spawn(command, args, {
      cwd,
      detached: true,
      stdio: mode === "wait" ? ["ignore", "pipe", "pipe"] : "ignore",
      env,
    });

    let task: TaskRecord | undefined;
    let earlyExitCode: number | null | undefined;
    let guarded: GuardedExecutionState | undefined;
    if (guard) {
      let resolveClose!: () => void;
      let resolveTerminal!: () => void;
      const closePromise = new Promise<void>((resolve) => { resolveClose = resolve; });
      const terminalPromise = new Promise<void>((resolve) => { resolveTerminal = resolve; });
      guarded = {
        child,
        generation,
        assertCurrent: guard.assertCurrent,
        maxOutputBytes: guard.maxOutputBytes,
        onOutput,
        chunks: [],
        outputBytes: 0,
        exitObserved: false,
        exitCode: null,
        closeObserved: false,
        closePromise,
        resolveClose,
        registrationComplete: false,
        descendants: [],
        stopRequested: false,
        terminationProven: false,
        terminalPromise,
        resolveTerminal,
        consumption: "available",
      };
    }

    const collect = (stream: "stdout" | "stderr") => (chunk: Buffer): void => {
      if (!guarded) {
        onOutput?.(chunk, stream);
        return;
      }
      if (guarded.error || guarded.consumption === "failed" || guarded.consumption === "delivered") return;
      guarded.outputBytes += chunk.length;
      if (guarded.outputBytes > guarded.maxOutputBytes) {
        this.lockGuardFailure(guarded, new Error(`${GUARDED_OUTPUT_OVERFLOW}: ${guarded.maxOutputBytes} 字节`));
        this.requestGuardedFailure(guarded);
        return;
      }
      guarded.chunks.push({ chunk: Buffer.from(chunk), stream });
    };
    if (mode === "wait") {
      child.stdout?.on("data", collect("stdout"));
      child.stderr?.on("data", collect("stderr"));
    }
    child.on("exit", (code) => {
      if (guarded) {
        guarded.exitObserved = true;
        guarded.exitCode = code;
      }
      if (task) this.handleExit(task, code);
      else earlyExitCode = code;
    });
    child.on("close", () => {
      child.stdout?.destroy();
      child.stderr?.destroy();
      if (guarded && !guarded.closeObserved) {
        guarded.closeObserved = true;
        try { assertExecutionGuardCurrent(guarded.assertCurrent); }
        catch (error) {
          this.lockGuardFailure(guarded, error);
          this.requestGuardedFailure(guarded);
        }
        guarded.resolveClose();
      }
      if (task) void this.inspect(task.taskId);
    });

    const spawnOutcome = await new Promise<{ ok: true } | { ok: false; reason: string }>((resolve) => {
      child.once("spawn", () => resolve({ ok: true }));
      child.once("error", (error) => resolve({ ok: false, reason: (error as Error).message }));
    });
    if (this.launching.get(taskId) !== generation) return { ok: false, reason: "任务启动代次已失效" };

    if (!spawnOutcome.ok) {
      if (guarded) this.lockGuardFailure(guarded, new Error(`受保护命令启动失败: ${spawnOutcome.reason}`));
      return { ok: false, reason: spawnOutcome.reason };
    }

    child.unref();
    const pid = child.pid as number;
    const pgid = pid;
    if (guarded) {
      guarded.pid = pid;
      guarded.pgid = pgid;
    }
    const startedAt = await this.baselineStartedAt(pid);
    if (guarded) guarded.startedAt = startedAt;
    if (this.launching.get(taskId) !== generation) return { ok: false, reason: "任务启动代次已失效" };

    task = {
      taskId,
      host,
      command: [command, ...args].join(" "),
      cwd: cwd ?? process.cwd(),
      mode,
      pid,
      pgid,
      startedAt,
      timeoutSeconds,
      status: "starting",
      activity: "active",
      exitCode: earlyExitCode !== undefined ? earlyExitCode : null,
      descendants: [],
      descendantsScanned: false,
      identityVerified: startedAt !== null,
    };
    this.tasks.set(taskId, task);
    this.taskGenerations.set(task, generation);
    this.taskTokens.set(taskId, token);
    if (guarded) {
      guarded.task = task;
      this.guardedTasks.set(task, guarded);
    }
    this.notify(task);
    try {
      await this.writeTaskRecord(task, token, guarded);
      if (this.tasks.get(taskId) !== task || this.taskGenerations.get(task) !== generation) {
        throw new Error("任务登记代次已失效");
      }
    }
    catch (error) {
      if (guarded) this.lockGuardFailure(guarded, new Error("受保护命令登记失败"));
      await this.stop(task.taskId);
      return { ok: false, reason: `Shell 登记失败: ${(error as Error).message}` };
    }

    task.status = "running";
    this.notify(task);
    if (guarded) guarded.registrationComplete = true;

    this.startMonitor(task);
    if (timeoutSeconds) this.scheduleTimeout(task, timeoutSeconds);
    if (guarded?.stopRequested || guarded?.error) this.requestGuardedFailure(guarded);
    else if (guarded?.closeObserved) void this.inspect(task.taskId);

    return { ok: true, task };
    } finally {
      if (this.launching.get(taskId) === generation) this.launching.delete(taskId);
    }
  }

  private async baselineStartedAt(pid: number): Promise<number | null> {
    try {
      return await this.pidStartedAt(pid);
    } catch {
      return null;
    }
  }

  private async checkIdentity(task: TaskRecord, guarded?: GuardedExecutionState): Promise<{ mismatched: boolean; reason?: string; verified: boolean }> {
    const pid = guarded?.pid ?? task.pid;
    const startedAt = guarded ? guarded.startedAt : task.startedAt;
    if (startedAt === null || pid === undefined) return { mismatched: false, verified: false };
    const current = await this.baselineStartedAt(pid);
    if (current === null) return { mismatched: false, verified: false };
    if (current !== startedAt) {
      return { mismatched: true, reason: `进程 ${pid} 启动时刻与登记不一致，疑似 pid 复用`, verified: true };
    }
    return { mismatched: false, verified: true };
  }

  private async scanDescendantsInto(task: TaskRecord, guarded?: GuardedExecutionState): Promise<{ descendants: number[]; scanned: boolean }> {
    const token = this.taskTokens.get(task.taskId) ?? "";
    const pgid = guarded?.pgid ?? task.pgid;
    const entries = await this.trySample();
    if (this.tasks.get(task.taskId) !== task || (guarded && !this.isCurrentGuardedState(task, guarded))) return { descendants: [], scanned: false };
    const descendants = entries ? scanDescendants(pgid, token, entries) : [];
    if (guarded && entries) guarded.descendants = [...descendants];
    this.lastDescendantScanAt.set(task.taskId, this.clock.now());
    if (entries) task.descendants = [...descendants];
    task.descendantsScanned = Boolean(entries);
    return { descendants, scanned: Boolean(entries) };
  }

  private async inspect(taskId: string): Promise<void> {
    if (this.stopping.has(taskId)) return;
    const existing = this.inspecting.get(taskId);
    if (existing) return existing;
    const operation = this.inspectTask(taskId);
    this.inspecting.set(taskId, operation);
    try { await operation; }
    finally { if (this.inspecting.get(taskId) === operation) this.inspecting.delete(taskId); }
  }

  private async inspectTask(taskId: string): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) return;
    const guarded = this.guardedTasks.get(task);
    if (guarded ? guarded.terminalStatus !== undefined : isTerminalStatus(task.status)) {
      this.stopMonitor(taskId);
      return;
    }

    {
      const pgid = guarded?.pgid ?? task.pgid;
      const probe = probeProcessGroup(pgid, this.kill);
      if (!probe.ok) {
        this.stopMonitor(taskId);
        this.markUncertain(task, probe.reason);
        return;
      }

      if (probe.state === "alive") {
        const identity = await this.checkIdentity(task, guarded);
        if (guarded && !this.isCurrentGuardedState(task, guarded)) return;
        task.identityVerified = identity.verified;
        if (identity.mismatched) {
          this.stopMonitor(taskId);
          this.markUncertain(task, identity.reason ?? "身份核对不一致");
          return;
        }

        const lastScan = this.lastDescendantScanAt.get(taskId);
        if (lastScan === undefined || this.clock.elapsedExcludingSleep(lastScan) >= DESCENDANT_SCAN_THROTTLE_MS) {
          await this.scanDescendantsInto(task, guarded);
          if (guarded && !this.isCurrentGuardedState(task, guarded)) return;
        }

        if (guarded || task.status === "starting") task.status = "running";
        task.activity = "active";
        this.notify(task);
        return;
      }

      const scan = await this.scanDescendantsInto(task, guarded);
      if (guarded && !this.isCurrentGuardedState(task, guarded)) return;
      if (!scan.scanned) {
        this.stopMonitor(taskId);
        this.markUncertain(task, "后代进程扫描未完成");
        return;
      }

      const descendantProbes = scan.descendants.map((pid) => probeSinglePid(pid, this.kill));
      const descendantError = descendantProbes.find((p) => p.state === "error");
      if (descendantError && descendantError.state === "error") {
        this.stopMonitor(taskId);
        this.markUncertain(task, descendantError.reason);
        return;
      }
      const stillAlive = descendantProbes.some((p) => p.state === "alive");
      if (stillAlive) {
        task.activity = "active";
        this.notify(task);
        return;
      }

      if (guarded) {
        guarded.terminationProven = true;
        if (!guarded.closeObserved) {
          task.status = "running";
          task.activity = "active";
          this.notify(task);
          return;
        }
      }

      this.stopMonitor(taskId);
      const terminalStatus = guarded?.error ? "failed" : "exited";
      if (guarded) {
        if (!this.isCurrentGuardedState(task, guarded)) return;
        guarded.terminalStatus = terminalStatus;
        guarded.resolveTerminal();
      }
      task.status = terminalStatus;
      if (guarded?.error) task.reason = guarded.error.message;
      task.activity = "ended";
      this.clearTimeoutTimer(taskId);
      this.notify(task);
      if (!guarded || (guarded.closeObserved && guarded.terminationProven)) await this.deleteTaskRecord(task);
    }
  }

  private async waitForGuardedProof(promise: Promise<void>, label: string): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(label)), GUARDED_WAIT_MS);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async deliverGuardedOutput(task: TaskRecord): Promise<void> {
    const state = this.guardedTasks.get(task);
    if (!state) throw new Error("缺少本次受保护命令的私有结果证明");
    this.assertCurrentGuardedState(task, state);
    if (state.consumption !== "available") throw new Error("受保护命令结果已消费或已失效");
    state.consumption = "consuming";
    try {
      const assertPermit = () => {
        this.assertCurrentGuardedState(task, state);
        if (state.consumption !== "consuming") throw new Error("受保护命令结果已失效");
      };
      await this.waitForGuardedProof(state.closePromise, "等待受保护命令 close 超时");
      assertPermit();
      await this.waitForGuardedProof(state.terminalPromise, "等待受保护命令真实结束超时");
      assertPermit();
      if (!state.registrationComplete || !state.closeObserved || !state.terminationProven
        || state.terminalStatus !== "exited" || task.stoppedBy || state.error) {
        throw new Error(state.error?.message ?? task.reason ?? "受保护命令未形成可交付结果");
      }
      assertExecutionGuardCurrent(state.assertCurrent);
      while (state.chunks.length > 0) {
        assertPermit();
        assertExecutionGuardCurrent(state.assertCurrent);
        const item = state.chunks.shift()!;
        state.outputBytes -= item.chunk.length;
        state.onOutput?.(item.chunk, item.stream);
        this.assertCurrentGuardedState(task, state);
        if (state.consumption !== "consuming") throw new Error("受保护命令结果已失效");
        assertExecutionGuardCurrent(state.assertCurrent);
      }
      state.outputBytes = 0;
      assertPermit();
      assertExecutionGuardCurrent(state.assertCurrent);
      assertPermit();
      state.consumption = "delivered";
    } catch (error) {
      state.chunks.length = 0;
      state.outputBytes = 0;
      state.consumption = "failed";
      throw error;
    }
  }

  exitCodeFor(task: TaskRecord): number | null {
    const guarded = this.guardedTasks.get(task);
    if (!guarded) return task.exitCode;
    this.assertCurrentGuardedState(task, guarded);
    return guarded.exitObserved ? guarded.exitCode : null;
  }

  isTaskExecutionEnded(task: TaskRecord): boolean {
    const guarded = this.guardedTasks.get(task);
    if (!guarded) return this.tasks.get(task.taskId) === task && isTerminalStatus(task.status) && task.activity === "ended";
    this.assertCurrentGuardedState(task, guarded);
    return guarded.terminalStatus !== undefined && guarded.closeObserved && guarded.terminationProven;
  }

  async stop(taskId: string): Promise<StopResult> {
    return this.stopWithFinalStatus(taskId, "stopped");
  }

  async stopTask(task: TaskRecord): Promise<StopResult> {
    if (this.tasks.get(task.taskId) !== task) return { ok: false, reason: "任务对象已被替代" };
    const guarded = this.guardedTasks.get(task);
    if (guarded && !this.isCurrentGuardedState(task, guarded)) return { ok: false, reason: "受保护任务代次已失效" };
    return this.stopWithFinalStatus(task.taskId, "stopped", task);
  }

  private async stopWithFinalStatus(taskId: string, finalStatus: "stopped" | "timed_out" | "failed", expected = this.tasks.get(taskId)): Promise<StopResult> {
    if (!expected || this.tasks.get(taskId) !== expected) return { ok: false, reason: "停止请求的原任务已被替代或不存在" };
    const existing = this.stopping.get(taskId);
    if (existing) return existing;
    this.stopVersions.set(taskId, (this.stopVersions.get(taskId) ?? 0) + 1);
    const operation = (async () => {
      await this.inspecting.get(taskId);
      if (this.tasks.get(taskId) !== expected) return { ok: false as const, reason: "停止请求的原任务已被替代" };
      return this.performStop(taskId, finalStatus, expected);
    })();
    this.stopping.set(taskId, operation);
    try { return await operation; }
    finally {
      if (this.stopping.get(taskId) === operation) this.stopping.delete(taskId);
      this.stopVersions.set(taskId, (this.stopVersions.get(taskId) ?? 0) + 1);
    }
  }

  private async performStop(taskId: string, finalStatus: "stopped" | "timed_out" | "failed", task: TaskRecord): Promise<StopResult> {
    if (this.tasks.get(taskId) !== task) return { ok: false, reason: `停止请求的原任务已被替代：${taskId}` };
    const guarded = this.guardedTasks.get(task);
    const pid = guarded?.pid ?? task.pid;
    const pgid = guarded?.pgid ?? task.pgid;
    if (!(pgid > 1)) return { ok: false, reason: `任务 pgid 非法：${pgid}` };
    if (guarded ? guarded.terminalStatus !== undefined : isTerminalStatus(task.status)) {
      const scan = await this.scanDescendantsInto(task, guarded);
      if (this.tasks.get(taskId) !== task || (guarded && !this.isCurrentGuardedState(task, guarded))) return { ok: false, reason: "停止请求的原任务已被替代" };
      const group = probeProcessGroup(pgid, this.kill);
      if (task.stoppedBy !== "user" && scan.scanned && group.ok && group.state === "gone"
        && scan.descendants.every((pid) => probeSinglePid(pid, this.kill).state === "gone")
        && (!guarded || (guarded.closeObserved && guarded.terminationProven))) return { ok: true, task };
      this.markUncertain(task, "结束状态需重新核对进程、close及后代");
      return { ok: true, task };
    }

    const identity = await this.checkIdentity(task, guarded);
    if (guarded && !this.isCurrentGuardedState(task, guarded)) return { ok: false, reason: "受保护任务已被替代" };
    const previouslyVerified = task.identityVerified;
    task.identityVerified = identity.verified;
    if (identity.mismatched) {
      this.stopMonitor(taskId);
      this.markUncertain(task, identity.reason ?? "身份核对不一致");
      return { ok: true, task };
    }

    const leaderProbe = probeSinglePid(pid, this.kill);
    if (leaderProbe.state === "error") {
      this.stopMonitor(taskId);
      this.markUncertain(task, leaderProbe.reason);
      return { ok: true, task };
    }

    if (leaderProbe.state === "gone" && previouslyVerified && !identity.mismatched) task.identityVerified = true;
    this.stopMonitor(taskId);
    task.status = "stopping";
    this.notify(task);

    const token = this.taskTokens.get(taskId) ?? "";
    const entries = await this.trySample();
    if (guarded && !this.isCurrentGuardedState(task, guarded)) return { ok: false, reason: "受保护任务已被替代" };
    let descendants = entries ? scanDescendants(pgid, token, entries) : [...(guarded ? guarded.descendants : task.descendants)];
    if (entries) {
      task.descendants = [...descendants];
      if (guarded) guarded.descendants = [...descendants];
      task.descendantsScanned = true;
    } else {
      task.descendantsScanned = false;
    }

    const signalAll = (signal: NodeJS.Signals): void => {
      if (this.tasks.get(taskId) !== task || (guarded && !this.isCurrentGuardedState(task, guarded))) return;
      try {
        this.kill(-pgid, signal);
      } catch {
        // 组可能已消失，忽略
      }
      for (const pid of descendants) {
        if (this.tasks.get(taskId) !== task || (guarded && !this.isCurrentGuardedState(task, guarded))) return;
        try {
          this.kill(pid, signal);
        } catch {
          // 后代可能已消失，忽略
        }
      }
    };

    signalAll("SIGTERM");

    return new Promise<StopResult>((resolve) => {
      const startWait = this.clock.now();
      let hardKilled = false;
      let consecutiveGone = 0;
      let polling = false;
      let finished = false;

      const finish = (result: StopResult): void => {
        finished = true;
        this.clock.clearTimer(pollHandle);
        resolve(result);
      };

      const pollHandle = this.clock.setIntervalExcludingSleep(() => {
        if (polling || finished) return;
        polling = true;
        void poll().catch(() => {
          this.markUncertain(task, "停止核验失败");
          finish({ ok: true, task });
        }).finally(() => { polling = false; });
      }, STOP_POLL_INTERVAL_MS);
      const poll = async () => {
        if (guarded && !this.isCurrentGuardedState(task, guarded)) {
          finish({ ok: false, reason: "受保护任务已被替代" });
          return;
        }
        if (this.clock.deadline(startWait, STOP_TIMEOUT_MS)) {
          this.markUncertain(task, "停止超时未确认");
          finish({ ok: true, task });
          return;
        }

        const probe = probeProcessGroup(pgid, this.kill);
        if (!probe.ok) {
          this.markUncertain(task, probe.reason);
          finish({ ok: true, task });
          return;
        }

        const descendantProbes = descendants.map((pid) => probeSinglePid(pid, this.kill));
        const descendantError = descendantProbes.find((p) => p.state === "error");
        if (descendantError && descendantError.state === "error") {
          this.markUncertain(task, descendantError.reason);
          finish({ ok: true, task });
          return;
        }
        const descendantsAlive = descendantProbes.filter((p) => p.state === "alive").length;

        if (probe.state === "gone" && descendantsAlive === 0) {
          // 每次终态确认都重新扫描信号后的成员，不能复用停止前的范围。
          const finalEntries = await this.trySample();
          if (finished) return;
          if (guarded && !this.isCurrentGuardedState(task, guarded)) {
            finish({ ok: false, reason: "受保护任务已被替代" });
            return;
          }
          if (!finalEntries || this.clock.deadline(startWait, STOP_TIMEOUT_MS)) {
            task.descendantsScanned = false;
            this.markUncertain(task, "主进程组已结束，但后代扫描未完成");
            finish({ ok: true, task });
            return;
          }
          descendants = [...new Set([...descendants, ...scanDescendants(pgid, token, finalEntries)])];
          task.descendants = [...descendants];
          if (guarded) guarded.descendants = [...descendants];
          task.descendantsScanned = true;
          const finalGroup = probeProcessGroup(pgid, this.kill);
          const finalMembers = descendants.map((pid) => probeSinglePid(pid, this.kill));
          if (!finalGroup.ok || finalMembers.some((member) => member.state === "error")) {
            this.markUncertain(task, "停止后成员状态无法核对");
            finish({ ok: true, task });
            return;
          }
          if (finalGroup.state !== "gone" || finalMembers.some((member) => member.state === "alive")) {
            consecutiveGone = 0;
            signalAll(hardKilled ? "SIGKILL" : "SIGTERM");
            return;
          }
          consecutiveGone++;
          if (consecutiveGone >= STOP_CONFIRM_COUNT) {
            if (guarded) {
              guarded.terminationProven = true;
              if (!guarded.closeObserved) return;
              if (!this.isCurrentGuardedState(task, guarded)) {
                finish({ ok: false, reason: "受保护任务已被替代" });
                return;
              }
              guarded.terminalStatus = finalStatus;
              guarded.resolveTerminal();
            }
            task.status = finalStatus;
            task.stoppedBy = "signal";
            task.activity = "ended";
            if (finalStatus === "failed") task.reason = guarded?.error?.message ?? "受保护命令执行失败";
            this.clearTimeoutTimer(taskId);
            this.notify(task);
            if (!guarded || (guarded.closeObserved && guarded.terminationProven)) void this.deleteTaskRecord(task);
            finish({ ok: true, task });
            return;
          }
        } else {
          consecutiveGone = 0;
          if (!hardKilled && this.clock.elapsedExcludingSleep(startWait) >= STOP_QUIET_WAIT_MS) {
            signalAll("SIGKILL");
            hardKilled = true;
          }
        }
      };
    });
  }

  markStoppedByUser(taskId: string, input: { decisionId: string }): MarkStoppedByUserResult {
    const task = this.tasks.get(taskId);
    if (!task) return { ok: false, reason: `未知任务：${taskId}` };
    if (task.status !== "uncertain") {
      return { ok: false, reason: `任务当前状态为 ${task.status}，非 uncertain 不可裁定` };
    }
    if (this.guardedTasks.has(task)) {
      return { ok: false, reason: "受保护命令不能用人工裁定生成结果许可" };
    }
    task.status = "stopped";
    task.stoppedBy = "user";
    task.activity = "ended";
    task.reason = `用户裁定停止（决定编号 ${input.decisionId}）`;
    this.clearTimeoutTimer(taskId);
    this.notify(task);
    void this.deleteTaskRecord(task);
    return { ok: true, task };
  }

  async stopHost(host: Host): Promise<{ taskId: string; result: StopResult }[]> {
    const results: { taskId: string; result: StopResult }[] = [];
    for (const task of this.tasks.values()) {
      if (hostEquals(task.host, host)) {
        results.push({ taskId: task.taskId, result: await this.stop(task.taskId) });
      }
    }
    return results;
  }

  async closeOwner(host: Host): Promise<{ taskId: string; result: StopResult }[]> {
    return this.stopHost(host);
  }

  // 持久记录接管：macOS 只对非系统签名二进制在 ps -E 中暴露环境变量，sh -c 展开为 sleep 等
  // 系统二进制后环境令牌扫描读不到，只能凭 spawn 时落盘的记录按 pid+startedAt 核对身份接管
  private async adoptFromRecords(input: { runToken: string; owner: Host }): Promise<TaskRecord[]> {
    if (!this.database) return [];
    const records = withDatabase(this.database, (db) => db.list<PersistedTaskRecord>("shells").map((record) => record.data));
    const prefix = `${input.runToken}:`;
    const tasks: TaskRecord[] = [];
    for (const record of records) {
      if (!record || typeof record !== "object" || typeof record.taskId !== "string" || typeof record.token !== "string" ||
        !Number.isSafeInteger(record.pid) || record.pid <= 1 || !Number.isSafeInteger(record.pgid) || record.pgid <= 1 ||
        typeof record.command !== "string" || typeof record.cwd !== "string" || !record.host ||
        (record.startedAt !== null && !Number.isFinite(record.startedAt))) throw new Error("Shell 持久记录损坏");
      const taskId = record.taskId;
      if (this.tasks.has(taskId) || this.launching.has(taskId)) continue;
      if (!record.token?.startsWith(prefix)) continue;
      const currentStartedAt = await this.baselineStartedAt(record.pid);
      if (this.tasks.has(taskId) || this.launching.has(taskId) || currentStartedAt === null || currentStartedAt !== record.startedAt) continue;

      const task: TaskRecord = {
        taskId: record.taskId,
        host: input.owner,
        command: record.command,
        cwd: record.cwd,
        mode: "background",
        pid: record.pid,
        pgid: record.pgid,
        startedAt: record.startedAt,
        status: "running",
        activity: "active",
        exitCode: null,
        descendants: [],
        descendantsScanned: false,
        identityVerified: true,
      };
      this.tasks.set(taskId, task);
      this.taskTokens.set(taskId, record.token);
      this.startMonitor(task);
      tasks.push(task);
    }
    return tasks;
  }

  async adoptOrphans(input: { runToken: string; owner: Host }): Promise<AdoptOrphansResult> {
    let fromRecords: TaskRecord[];
    try {
      fromRecords = await this.adoptFromRecords(input);
    } catch (error) {
      return { ok: false, reason: (error as Error).message ?? String(error) };
    }

    const versions = new Map(this.stopVersions);
    let entries: PsEntry[];
    try {
      entries = await this.ps();
    } catch (error) {
      for (const task of this.tasks.values()) {
        if (this.taskTokens.get(task.taskId)?.startsWith(`${input.runToken}:`)) task.descendantsScanned = false;
      }
      return { ok: false, reason: (error as Error).message ?? String(error) };
    }

    const prefix = `${input.runToken}:`;
    const groups = new Map<string, PsEntry[]>();
    for (const entry of entries) {
      if (!isValidPsEntry(entry)) continue;
      if (!entry.token || !entry.token.startsWith(prefix)) continue;
      const taskId = entry.token.slice(prefix.length);
      const group = groups.get(taskId) ?? [];
      group.push(entry);
      groups.set(taskId, group);
    }

    const tasks: TaskRecord[] = [...fromRecords];
    for (const task of this.tasks.values()) {
      const token = this.taskTokens.get(task.taskId);
      if (!token?.startsWith(prefix)) continue;
      if (this.stopping.has(task.taskId) || (this.stopVersions.get(task.taskId) ?? 0) !== (versions.get(task.taskId) ?? 0)) {
        return { ok: false, reason: "停止核验进行中或采样已过期" };
      }
      task.descendants = scanDescendants(task.pgid, token, entries);
      task.descendantsScanned = true;
      const guarded = this.guardedTasks.get(task);
      const ended = guarded ? guarded.terminalStatus !== undefined || guarded.terminationProven : isTerminalStatus(task.status);
      if (ended && groups.has(task.taskId)) {
        this.markUncertain(task, "发现同一任务仍有存活进程，结束状态未确认");
      }
    }
    for (const [taskId, group] of groups) {
      if (this.tasks.has(taskId) || this.launching.has(taskId)) continue;
      const root = group.reduce((earliest, entry) => (entry.startedAt < earliest.startedAt ? entry : earliest));
      const task: TaskRecord = {
        taskId,
        host: input.owner,
        command: root.command,
        cwd: process.cwd(),
        mode: "background",
        pid: root.pid,
        pgid: root.pgid,
        startedAt: root.startedAt,
        status: "running",
        activity: "active",
        exitCode: null,
        descendants: [],
        descendantsScanned: false,
        identityVerified: true,
      };
      this.tasks.set(taskId, task);
      this.taskTokens.set(taskId, `${input.runToken}:${taskId}`);
      this.startMonitor(task);
      tasks.push(task);
    }

    return { ok: true, tasks };
  }

  private scheduleTimeout(task: TaskRecord, timeoutSeconds: number): void {
    const handle = this.clock.setTimeoutExcludingSleep(() => {
      void this.handleTimeout(task.taskId);
    }, timeoutSeconds * 1000);
    this.timeoutTimers.set(task.taskId, handle);
  }

  private async handleTimeout(taskId: string): Promise<void> {
    this.timeoutTimers.delete(taskId);
    const task = this.tasks.get(taskId);
    if (!task || isTerminalStatus(task.status)) return;
    await this.stopWithFinalStatus(taskId, "timed_out");
  }
}
