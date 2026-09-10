import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Clock } from "./clock.ts";
import { withDatabase, UUID_V7_PATTERN } from "./database.ts";

const execFileAsync = promisify(execFile);

const HEARTBEAT_INTERVAL_MS = 5_000;
const LOST_AFTER_INTERVALS = 3;
const LOST_THRESHOLD_MS = HEARTBEAT_INTERVAL_MS * LOST_AFTER_INTERVALS;
const WINDOW_ID_PATTERN = UUID_V7_PATTERN;

export interface WindowRegisterInput {
  windowId: string;
  pid: number;
  sessionId: string;
  cwd: string;
  workspaceRoot: string;
}

export interface WindowRecord {
  windowId: string;
  pid: number;
  processStartedAt: string;
  bootId: string;
  sessionId: string;
  cwd: string;
  workspaceRoot: string;
  startedAt: string;
  heartbeatAt: string;
  heartbeatSeq: number;
}

export type Liveness = "alive" | "lost" | "gone";

export type WindowListItem = WindowRecord & { liveness: Liveness };

export type HolderGoneResult =
  | { gone: true; evidence: "unregistered" | "boot-changed" | "pid-missing" | "pid-reused" }
  | { gone: false; reason: string };

export interface WindowRegistryOptions {
  repoDir: string;
  clock: Clock;
  bootId: () => Promise<string>;
  processStartedAt: (pid: number) => Promise<string | null>;
}

function validateWindowId(windowId: string): void {
  if (!WINDOW_ID_PATTERN.test(windowId)) throw new Error(`不合法的窗口标识: ${windowId}`);
}

function checkedWindow(value: unknown, id: string): WindowRecord {
  const record = value as WindowRecord | null;
  if (!record || typeof record !== "object" || Array.isArray(record) || record.windowId !== id ||
    !Number.isInteger(record.pid) || record.pid <= 0 || !Number.isSafeInteger(record.heartbeatSeq) || record.heartbeatSeq < 0 ||
    ![record.processStartedAt, record.bootId, record.sessionId, record.cwd, record.workspaceRoot].every((value) => typeof value === "string" && value.length > 0) ||
    ![record.startedAt, record.heartbeatAt].every((value) => typeof value === "string" && Number.isFinite(Date.parse(value)))) throw new Error("窗口记录结构或身份无效");
  validateWindowId(id);
  return record;
}

export class WindowRegistry {
  readonly clock: Clock;
  private readonly database: string;
  private readonly bootIdFn: () => Promise<string>;
  private readonly processStartedAtFn: (pid: number) => Promise<string | null>;

  constructor(options: WindowRegistryOptions) {
    this.clock = options.clock;
    this.database = join(options.repoDir, "data.sqlite");
    this.bootIdFn = options.bootId;
    this.processStartedAtFn = options.processStartedAt;
  }

  async register(input: WindowRegisterInput): Promise<string> {
    if (!input.windowId || !WINDOW_ID_PATTERN.test(input.windowId)) {
      throw new Error(`不合法的窗口标识: ${input.windowId}`);
    }
    const windowId = input.windowId;
    const startedAt = await this.processStartedAtFn(input.pid);
    if (startedAt === null) {
      throw new Error(`无法读取进程启动时刻，拒绝登记窗口: pid=${input.pid}`);
    }
    const now = new Date(this.clock.now()).toISOString();
    const record: WindowRecord = {
      windowId,
      pid: input.pid,
      processStartedAt: startedAt,
      bootId: await this.bootIdFn(),
      sessionId: input.sessionId,
      cwd: input.cwd,
      workspaceRoot: input.workspaceRoot,
      startedAt: now,
      heartbeatAt: now,
      heartbeatSeq: 0,
    };
    checkedWindow(record, windowId);
    withDatabase(this.database, (db) => db.create("windows", windowId, record, windowId));
    return windowId;
  }

  async heartbeat(windowId: string): Promise<void> {
    validateWindowId(windowId);
    withDatabase(this.database, (db) => db.transaction(() => {
      const record = db.read<WindowRecord>("windows", windowId);
      if (!record) return;
      checkedWindow(record.data, windowId);
      db.update("windows", windowId, record.version, { ...record.data, heartbeatAt: new Date(this.clock.now()).toISOString(), heartbeatSeq: record.data.heartbeatSeq + 1 });
    }));
  }

  async unregister(windowId: string): Promise<void> {
    validateWindowId(windowId);
    withDatabase(this.database, (db) => db.transaction(() => {
      const record = db.read("windows", windowId);
      if (record) db.remove("windows", windowId, record.version);
    }));
  }

  async isAlive(windowId: string): Promise<boolean> {
    const record = await this.readRecord(windowId);
    if (!record) return false;
    return this.isAliveRecord(record);
  }

  async holderGone(windowId: string): Promise<HolderGoneResult> {
    const record = await this.readRecord(windowId);
    if (!record) return { gone: true, evidence: "unregistered" };
    return this.holderGoneForRecord(record);
  }

  async list(): Promise<WindowListItem[]> {
    const records = await this.readAllRecords();
    const items: WindowListItem[] = [];
    for (const record of records) {
      const liveness: Liveness = this.isAliveRecord(record)
        ? "alive"
        : (await this.holderGoneForRecord(record)).gone
          ? "gone"
          : "lost";
      items.push({ ...record, liveness });
    }
    return items;
  }

  private isAliveRecord(record: WindowRecord): boolean {
    const now = this.clock.now();
    const heartbeatAt = Date.parse(record.heartbeatAt);
    const elapsed = now - heartbeatAt;
    if (elapsed < LOST_THRESHOLD_MS) return true;
    let overlap = 0;
    for (const gap of this.clock.sleepGaps()) {
      const start = Math.max(gap.sleptFrom, heartbeatAt);
      const end = Math.min(gap.wokeAt, now);
      if (end > start) overlap += end - start;
    }
    return elapsed - overlap < LOST_THRESHOLD_MS;
  }

  private async holderGoneForRecord(record: WindowRecord): Promise<HolderGoneResult> {
    if (this.isAliveRecord(record)) return { gone: false, reason: "心跳新鲜" };
    let bootId: string;
    try {
      bootId = await this.bootIdFn();
    } catch (error) {
      return { gone: false, reason: `开机标识探测失败，无法判定: ${(error as Error).message}` };
    }
    if (bootId !== record.bootId) return { gone: true, evidence: "boot-changed" };
    let startedAt: string | null;
    try {
      startedAt = await this.processStartedAtFn(record.pid);
    } catch (error) {
      return { gone: false, reason: `进程启动时刻探测失败，无法判定: ${(error as Error).message}` };
    }
    if (startedAt === null) return { gone: true, evidence: "pid-missing" };
    if (startedAt !== record.processStartedAt) return { gone: true, evidence: "pid-reused" };
    return { gone: false, reason: "心跳过期但进程存活且启动时刻一致" };
  }

  private async readRecord(windowId: string): Promise<WindowRecord | null> {
    if (!WINDOW_ID_PATTERN.test(windowId)) throw new Error(`不合法的窗口标识: ${windowId}`);
    return withDatabase(this.database, (db) => {
      const record = db.read("windows", windowId);
      return record ? checkedWindow(record.data, windowId) : null;
    });
  }

  private async readAllRecords(): Promise<WindowRecord[]> {
    return withDatabase(this.database, (db) => db.list<WindowRecord>("windows").map((record) => checkedWindow(record.data, record.key)));
  }
}

export async function currentBootId(): Promise<string> {
  if (process.platform === "darwin") {
    try {
      const { stdout } = await execFileAsync("sysctl", ["-n", "kern.bootsessionuuid"]);
      return stdout.trim();
    } catch (error) {
      throw new Error(`无法读取开机标识: ${(error as Error).message}`, { cause: error });
    }
  }
  if (process.platform === "linux") {
    try {
      const raw = await readFile("/proc/sys/kernel/random/boot_id", "utf8");
      return raw.trim();
    } catch (error) {
      throw new Error(`无法读取开机标识: ${(error as Error).message}`, { cause: error });
    }
  }
  throw new Error(`不支持的平台: ${process.platform}`);
}

export async function processStartedAt(pid: number): Promise<string | null> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync("ps", ["-o", "lstart=", "-p", String(pid)]));
  } catch (error) {
    const execError = error as NodeJS.ErrnoException & { stdout?: string };
    if (typeof execError.code !== "number") {
      throw new Error(`无法执行 ps 探测进程启动时刻: ${execError.message}`, { cause: error });
    }
    if ((execError.stdout ?? "").trim() !== "") {
      throw new Error(`ps 探测进程启动时刻异常退出: ${execError.message}`, { cause: error });
    }
    return null;
  }
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`无法解析 ps 输出的进程启动时刻: ${trimmed}`);
  }
  return parsed.toISOString();
}

export function startHeartbeat(
  registry: WindowRegistry,
  windowId: string,
  onError: (error: unknown) => void = () => {},
): () => void {
  const handle = registry.clock.setIntervalExcludingSleep(() => {
    registry.heartbeat(windowId).catch(onError);
  }, HEARTBEAT_INTERVAL_MS);
  return () => registry.clock.clearTimer(handle);
}
