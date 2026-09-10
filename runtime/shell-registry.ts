import { execFile, spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import type { Clock, TimerHandle } from "./clock.ts";
import { withDatabase } from "./database.ts";

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

const MONITOR_INTERVAL_MS = 150;
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
  private readonly taskTokens = new Map<string, string>();
  private readonly monitors = new Map<string, ReturnType<typeof setInterval>>();
  private readonly inspecting = new Set<string>();
  private readonly timeoutTimers = new Map<string, TimerHandle>();
  private readonly listeners = new Map<string, Set<(task: TaskRecord) => void>>();
  private readonly lastDescendantScanAt = new Map<string, number>();

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

  private async writeTaskRecord(task: TaskRecord, token: string): Promise<void> {
    if (!this.database) return;
    const record: PersistedTaskRecord = {
      cwd: task.cwd,
      taskId: task.taskId,
      pid: task.pid,
      pgid: task.pgid,
      startedAt: task.startedAt ?? 0,
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

  async spawn(input: SpawnInput): Promise<SpawnResult> {
    if (this.tasks.has(input.taskId)) {
      return { ok: false, reason: `任务 ${input.taskId} 已登记` };
    }

    const token = `${input.runToken}:${input.taskId}`;
    const child = spawn(input.command, input.args ?? [], {
      cwd: input.cwd,
      detached: true,
      stdio: input.mode === "wait" ? ["ignore", "pipe", "pipe"] : "ignore",
      env: { ...(input.inheritEnv === false ? {} : process.env), ...input.env, [TOKEN_ENV_VAR]: token },
    });

    if (input.mode === "wait") {
      const onOutput = input.onOutput;
      child.stdout?.on("data", (chunk: Buffer) => onOutput?.(chunk, "stdout"));
      child.stderr?.on("data", (chunk: Buffer) => onOutput?.(chunk, "stderr"));
    }

    const spawnOutcome = await new Promise<{ ok: true } | { ok: false; reason: string }>((resolve) => {
      child.once("spawn", () => resolve({ ok: true }));
      child.once("error", (error) => resolve({ ok: false, reason: (error as Error).message }));
    });

    if (!spawnOutcome.ok) {
      return { ok: false, reason: spawnOutcome.reason };
    }

    child.unref();
    const pid = child.pid as number;
    const pgid = pid;

    let task: TaskRecord | undefined;
    let earlyExitCode: number | null | undefined;
    child.on("close", () => {
      child.stdout?.destroy();
      child.stderr?.destroy();
    });
    child.on("exit", (code) => {
      if (task) this.handleExit(task, code);
      else earlyExitCode = code;
    });

    const startedAt = await this.baselineStartedAt(pid);

    task = {
      taskId: input.taskId,
      host: input.host,
      command: [input.command, ...(input.args ?? [])].join(" "),
      cwd: input.cwd ?? process.cwd(),
      mode: input.mode,
      pid,
      pgid,
      startedAt,
      timeoutSeconds: input.timeoutSeconds,
      status: "starting",
      activity: "active",
      exitCode: null,
      descendants: [],
      descendantsScanned: false,
      identityVerified: startedAt !== null,
    };
    this.tasks.set(input.taskId, task);
    this.taskTokens.set(input.taskId, token);
    this.notify(task);
    try { await this.writeTaskRecord(task, token); }
    catch (error) {
      await this.stop(task.taskId);
      return { ok: false, reason: `Shell 登记失败: ${(error as Error).message}` };
    }

    if (earlyExitCode !== undefined) this.handleExit(task, earlyExitCode);
    task.status = "running";
    this.notify(task);

    this.startMonitor(task);
    if (input.timeoutSeconds) this.scheduleTimeout(task, input.timeoutSeconds);

    return { ok: true, task };
  }

  private async baselineStartedAt(pid: number): Promise<number | null> {
    try {
      return await this.pidStartedAt(pid);
    } catch {
      return null;
    }
  }

  private async checkIdentity(task: TaskRecord): Promise<{ mismatched: boolean; reason?: string; verified: boolean }> {
    if (task.startedAt === null) return { mismatched: false, verified: false };
    const current = await this.baselineStartedAt(task.pid);
    if (current === null) return { mismatched: false, verified: false };
    if (current !== task.startedAt) {
      return { mismatched: true, reason: `进程 ${task.pid} 启动时刻与登记不一致，疑似 pid 复用`, verified: true };
    }
    return { mismatched: false, verified: true };
  }

  private async scanDescendantsInto(task: TaskRecord): Promise<void> {
    const token = this.taskTokens.get(task.taskId) ?? "";
    const entries = await this.trySample();
    this.lastDescendantScanAt.set(task.taskId, this.clock.now());
    if (entries) {
      task.descendants = scanDescendants(task.pgid, token, entries);
      task.descendantsScanned = true;
    } else {
      task.descendantsScanned = false;
    }
  }

  private async inspect(taskId: string): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) return;
    if (isTerminalStatus(task.status)) {
      this.stopMonitor(taskId);
      return;
    }

    this.inspecting.add(taskId);
    try {
      const probe = probeProcessGroup(task.pgid, this.kill);
      if (!probe.ok) {
        this.stopMonitor(taskId);
        this.markUncertain(task, probe.reason);
        return;
      }

      if (probe.state === "alive") {
        const identity = await this.checkIdentity(task);
        task.identityVerified = identity.verified;
        if (identity.mismatched) {
          this.stopMonitor(taskId);
          this.markUncertain(task, identity.reason ?? "身份核对不一致");
          return;
        }

        const lastScan = this.lastDescendantScanAt.get(taskId);
        if (lastScan === undefined || this.clock.elapsedExcludingSleep(lastScan) >= DESCENDANT_SCAN_THROTTLE_MS) {
          await this.scanDescendantsInto(task);
        }

        if (task.status === "starting") task.status = "running";
        task.activity = "active";
        this.notify(task);
        return;
      }

      await this.scanDescendantsInto(task);

      const descendantProbes = task.descendants.map((pid) => probeSinglePid(pid, this.kill));
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

      this.stopMonitor(taskId);
      task.status = "exited";
      task.activity = "ended";
      this.clearTimeoutTimer(taskId);
      this.notify(task);
      await this.deleteTaskRecord(task);
    } finally {
      this.inspecting.delete(taskId);
    }
  }

  async stop(taskId: string): Promise<StopResult> {
    return this.stopWithFinalStatus(taskId, "stopped");
  }

  private async stopWithFinalStatus(taskId: string, finalStatus: "stopped" | "timed_out"): Promise<StopResult> {
    const task = this.tasks.get(taskId);
    if (!task) return { ok: false, reason: `未知任务：${taskId}` };
    if (!(task.pgid > 1)) return { ok: false, reason: `任务 pgid 非法：${task.pgid}` };
    if (isTerminalStatus(task.status)) return { ok: true, task };

    const identity = await this.checkIdentity(task);
    task.identityVerified = identity.verified;
    if (identity.mismatched) {
      this.stopMonitor(taskId);
      this.markUncertain(task, identity.reason ?? "身份核对不一致");
      return { ok: true, task };
    }

    const leaderProbe = probeSinglePid(task.pid, this.kill);
    if (leaderProbe.state === "error") {
      this.stopMonitor(taskId);
      this.markUncertain(task, leaderProbe.reason);
      return { ok: true, task };
    }

    this.stopMonitor(taskId);
    task.status = "stopping";
    this.notify(task);

    const token = this.taskTokens.get(taskId) ?? "";
    const entries = await this.trySample();
    if (entries) {
      task.descendants = scanDescendants(task.pgid, token, entries);
      task.descendantsScanned = true;
    } else {
      task.descendantsScanned = false;
    }

    const signalAll = (signal: NodeJS.Signals): void => {
      try {
        this.kill(-task.pgid, signal);
      } catch {
        // 组可能已消失，忽略
      }
      for (const pid of task.descendants) {
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

      const finish = (result: StopResult): void => {
        this.clock.clearTimer(pollHandle);
        resolve(result);
      };

      const pollHandle = this.clock.setIntervalExcludingSleep(() => {
        if (this.clock.deadline(startWait, STOP_TIMEOUT_MS)) {
          this.markUncertain(task, "停止超时未确认");
          finish({ ok: true, task });
          return;
        }

        const probe = probeProcessGroup(task.pgid, this.kill);
        if (!probe.ok) {
          this.markUncertain(task, probe.reason);
          finish({ ok: true, task });
          return;
        }

        const descendantProbes = task.descendants.map((pid) => probeSinglePid(pid, this.kill));
        const descendantError = descendantProbes.find((p) => p.state === "error");
        if (descendantError && descendantError.state === "error") {
          this.markUncertain(task, descendantError.reason);
          finish({ ok: true, task });
          return;
        }
        const descendantsAlive = descendantProbes.filter((p) => p.state === "alive").length;

        if (probe.state === "gone" && descendantsAlive === 0) {
          consecutiveGone++;
          if (consecutiveGone >= STOP_CONFIRM_COUNT) {
            task.status = finalStatus;
            task.stoppedBy = "signal";
            task.activity = "ended";
            this.clearTimeoutTimer(taskId);
            this.notify(task);
            void this.deleteTaskRecord(task);
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
      }, STOP_POLL_INTERVAL_MS);
    });
  }

  markStoppedByUser(taskId: string, input: { decisionId: string }): MarkStoppedByUserResult {
    const task = this.tasks.get(taskId);
    if (!task) return { ok: false, reason: `未知任务：${taskId}` };
    if (task.status !== "uncertain") {
      return { ok: false, reason: `任务当前状态为 ${task.status}，非 uncertain 不可裁定` };
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
      if (this.tasks.has(taskId)) continue;
      if (!record.token?.startsWith(prefix)) continue;
      const currentStartedAt = await this.baselineStartedAt(record.pid);
      if (currentStartedAt === null || currentStartedAt !== record.startedAt) continue;

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

    let entries: PsEntry[];
    try {
      entries = await this.ps();
    } catch (error) {
      if (fromRecords.length > 0) return { ok: true, tasks: fromRecords };
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
    for (const [taskId, group] of groups) {
      if (this.tasks.has(taskId)) continue;
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
