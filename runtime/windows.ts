import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Clock } from "./clock.ts";
import { withDirLock, writeFileAtomic } from "./store.ts";

const execFileAsync = promisify(execFile);

const HEARTBEAT_INTERVAL_MS = 5_000;
const LOST_AFTER_INTERVALS = 3;
const LOST_THRESHOLD_MS = HEARTBEAT_INTERVAL_MS * LOST_AFTER_INTERVALS;
const DIR_MODE = 0o700;
const WINDOW_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

export class WindowRegistry {
  readonly clock: Clock;
  private readonly windowsDir: string;
  private readonly bootIdFn: () => Promise<string>;
  private readonly processStartedAtFn: (pid: number) => Promise<string | null>;

  constructor(options: WindowRegistryOptions) {
    this.clock = options.clock;
    this.windowsDir = join(options.repoDir, "windows");
    this.bootIdFn = options.bootId;
    this.processStartedAtFn = options.processStartedAt;
  }

  private recordPath(windowId: string): string {
    if (!WINDOW_ID_PATTERN.test(windowId)) {
      throw new Error(`不合法的窗口标识: ${windowId}`);
    }
    return join(this.windowsDir, `${windowId}.json`);
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
    await mkdir(this.windowsDir, { recursive: true, mode: DIR_MODE });
    await writeFileAtomic(this.recordPath(windowId), JSON.stringify(record));
    return windowId;
  }

  async heartbeat(windowId: string): Promise<void> {
    const path = this.recordPath(windowId);
    await withDirLock(this.windowsDir, async () => {
      const record = await this.readRecord(windowId);
      if (!record || record.windowId !== windowId) return;
      const updated: WindowRecord = {
        ...record,
        heartbeatAt: new Date(this.clock.now()).toISOString(),
        heartbeatSeq: record.heartbeatSeq + 1,
      };
      await writeFileAtomic(path, JSON.stringify(updated));
    });
  }

  async unregister(windowId: string): Promise<void> {
    const path = this.recordPath(windowId);
    await mkdir(this.windowsDir, { recursive: true, mode: DIR_MODE });
    await withDirLock(this.windowsDir, async () => {
      await rm(path, { force: true });
    });
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
    try {
      const raw = await readFile(this.recordPath(windowId), "utf8");
      return JSON.parse(raw) as WindowRecord;
    } catch (error) {
      if (errorCode(error) === "ENOENT") return null;
      throw error;
    }
  }

  private async readAllRecords(): Promise<WindowRecord[]> {
    let entries: string[];
    try {
      entries = await readdir(this.windowsDir);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return [];
      throw error;
    }
    const records: WindowRecord[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      const stem = entry.slice(0, -".json".length);
      if (!WINDOW_ID_PATTERN.test(stem)) continue;
      const record = await this.readRecord(stem);
      if (record) records.push(record);
    }
    return records;
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
