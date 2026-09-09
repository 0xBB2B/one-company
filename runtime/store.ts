import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomBytes } from "node:crypto";
import { link, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export class StaleVersionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StaleVersionError";
  }
}

export class LockTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LockTimeoutError";
  }
}

const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const LOCK_RETRY_MS = 20;
const RECLAIM_OBSERVE_GAP_MS = 50;
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

export interface WithDirLockOptions {
  timeoutMs?: number;
}

function randomSuffix(): string {
  return randomBytes(8).toString("hex");
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

interface HeldLock {
  lockPath: string;
  active: boolean;
}

const heldLocks = new AsyncLocalStorage<HeldLock[]>();

async function lockOwnerToken(lockPath: string): Promise<string | null> {
  try {
    return (await readFile(join(lockPath, "owner"), "utf8")).trim() || null;
  } catch {
    return null;
  }
}

function tokenPid(token: string): number | null {
  const pid = Number.parseInt(token, 10);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) !== "ESRCH";
  }
}

// 锁目录先在临时名下备齐唯一令牌再 rename 到位；回收残留锁先 rename 抢占，
// 抢到后再核对令牌，搬走的若是别人刚建的活锁就原样归还。
async function tryAcquireLock(lockPath: string): Promise<string | null> {
  const token = `${process.pid}:${randomSuffix()}`;
  const staging = `${lockPath}.${randomSuffix()}`;
  await mkdir(staging, { mode: DIR_MODE });
  try {
    await writeFile(join(staging, "owner"), `${token}\n`, { mode: FILE_MODE });
    await rename(staging, lockPath);
    return token;
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    const code = errorCode(error);
    if (code === "ENOTEMPTY" || code === "EEXIST") return null;
    throw error;
  }
}

async function observeLock(lockPath: string): Promise<{ token: string; ino: number } | null> {
  const token = await lockOwnerToken(lockPath);
  if (token === null) return null;
  try {
    return { token, ino: (await stat(lockPath)).ino };
  } catch {
    return null;
  }
}

// 路径层没有比较交换：两次间隔观察要求令牌与 inode 都不变才搬走，搬走后再按 inode 核对，
// 把"搬走别人刚建的活锁"的窗口压到实际为零；核对不符即归还。
async function reclaimStaleLock(lockPath: string): Promise<boolean> {
  const first = await observeLock(lockPath);
  if (first === null) return false;
  const pid = tokenPid(first.token);
  if (pid === null || processAlive(pid)) return false;
  await new Promise((resolve) => setTimeout(resolve, RECLAIM_OBSERVE_GAP_MS));
  const second = await observeLock(lockPath);
  if (second === null || second.token !== first.token || second.ino !== first.ino) return false;
  const graveyard = `${lockPath}.dead.${randomSuffix()}`;
  try {
    await rename(lockPath, graveyard);
  } catch {
    return false;
  }
  let movedIno: number | null = null;
  try {
    movedIno = (await stat(graveyard)).ino;
  } catch {
    movedIno = null;
  }
  if (movedIno !== first.ino) {
    try {
      await rename(graveyard, lockPath);
    } catch {
      await rm(graveyard, { recursive: true, force: true });
    }
    return false;
  }
  try {
    await rm(graveyard, { recursive: true, force: true });
  } catch {
    return false;
  }
  return true;
}

async function releaseLock(lockPath: string, token: string): Promise<void> {
  try {
    if ((await lockOwnerToken(lockPath)) !== token) return;
    const released = `${lockPath}.rel.${randomSuffix()}`;
    await rename(lockPath, released);
    await rm(released, { recursive: true, force: true });
  } catch {
    // 释放失败不能掩盖临界区的结果；残留锁会被下一次获取按令牌里的 pid 回收
  }
}

export async function withDirLock<T>(dir: string, fn: () => Promise<T>, options: WithDirLockOptions = {}): Promise<T> {
  const lockPath = join(dir, ".lock");
  const held = heldLocks.getStore() ?? [];
  if (held.some((entry) => entry.lockPath === lockPath && entry.active)) return fn();
  const timeoutMs = options.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  let token = await tryAcquireLock(lockPath);
  while (token === null) {
    if (!(await reclaimStaleLock(lockPath))) {
      if (Date.now() > deadline) throw new LockTimeoutError(`获取目录锁超时: ${lockPath}`);
      await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS + Math.random() * LOCK_RETRY_MS));
    }
    token = await tryAcquireLock(lockPath);
  }
  const entry: HeldLock = { lockPath, active: true };
  try {
    return await heldLocks.run([...held, entry], fn);
  } finally {
    entry.active = false;
    await releaseLock(lockPath, token);
  }
}

async function syncDir(dir: string): Promise<void> {
  const handle = await open(dir, "r");
  try {
    await handle.sync();
  } catch (error) {
    if (errorCode(error) !== "EINVAL") throw error;
  } finally {
    await handle.close();
  }
}

async function writeTempFsynced(dir: string, name: string, content: string): Promise<string> {
  const tempPath = join(dir, `.${name}.${randomSuffix()}.tmp`);
  const handle = await open(tempPath, "w", FILE_MODE);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } catch (error) {
    await handle.close();
    await rm(tempPath, { force: true });
    throw error;
  }
  await handle.close();
  return tempPath;
}

export async function writeFileAtomic(path: string, content: string): Promise<void> {
  const dir = dirname(path);
  const tempPath = await writeTempFsynced(dir, basename(path), content);
  try {
    await rename(tempPath, path);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
  await syncDir(dir);
}

function parseDocumentContent(raw: string): { version: number; data: unknown } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("文档损坏: 内容不是合法 JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("文档损坏: 内容不是 JSON 对象");
  }
  const version = (parsed as Record<string, unknown>).version;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    throw new Error("文档损坏: version 字段缺失或非法");
  }
  return { version, data: (parsed as Record<string, unknown>).data };
}

export type ReadDocumentResult = { exists: false } | { exists: true; version: number; data: unknown };

async function readDocumentUnlocked(path: string): Promise<ReadDocumentResult> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { exists: false };
    throw error;
  }
  const { version, data } = parseDocumentContent(raw);
  return { exists: true, version, data };
}

export async function readDocument(path: string): Promise<ReadDocumentResult> {
  return readDocumentUnlocked(path);
}

function serializeLine(data: unknown): string {
  const line = JSON.stringify(data);
  if (typeof line !== "string") throw new Error("记录无法序列化为 JSON");
  return line;
}

export async function createDocument(path: string, data: unknown): Promise<{ version: number }> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: DIR_MODE });
  const tempPath = await writeTempFsynced(dir, basename(path), `${serializeLine({ version: 1, data })}\n`);
  try {
    await link(tempPath, path);
  } catch (error) {
    if (errorCode(error) === "EEXIST") throw new Error(`文档已存在: ${path}`);
    throw error;
  } finally {
    await rm(tempPath, { force: true });
  }
  await syncDir(dir);
  return { version: 1 };
}

export interface WriteDocumentOptions {
  expectedVersion: number;
  beforeRename?: () => Promise<void>;
}

export async function writeDocument(path: string, data: unknown, options: WriteDocumentOptions): Promise<{ version: number }> {
  const dir = dirname(path);
  return withDirLock(dir, async () => {
    const current = await readDocumentUnlocked(path);
    if (!current.exists) {
      throw new Error(`文档不存在，请先 createDocument: ${path}`);
    }
    if (current.version !== options.expectedVersion) {
      throw new StaleVersionError("版本已变化，请重新读取后重试");
    }
    const newVersion = current.version + 1;
    const tempPath = await writeTempFsynced(dir, basename(path), `${serializeLine({ version: newVersion, data })}\n`);
    try {
      if (options.beforeRename) await options.beforeRename();
      await rename(tempPath, path);
    } catch (error) {
      await rm(tempPath, { force: true });
      throw error;
    }
    await syncDir(dir);
    return { version: newVersion };
  });
}

async function readRawOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
}

function splitRecordLines(raw: string, path: string): string[] {
  if (raw.length === 0) return [];
  if (!raw.endsWith("\n")) {
    throw new Error(`记录文件损坏: 缺少结尾换行: ${path}`);
  }
  return raw.slice(0, -1).split("\n");
}

function validateRecordLines(lines: string[], path: string): void {
  lines.forEach((line, index) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(`记录文件损坏: 第 ${index + 1} 行不是合法 JSON: ${path}`);
    }
    if (JSON.stringify(parsed) !== line) {
      throw new Error(`记录文件损坏: 第 ${index + 1} 行不是 canonical JSON: ${path}`);
    }
  });
}

async function readLinesUnlocked(path: string): Promise<unknown[]> {
  const raw = await readRawOrNull(path);
  if (raw === null) return [];
  const lines = splitRecordLines(raw, path);
  validateRecordLines(lines, path);
  return lines.map((line) => JSON.parse(line));
}

export async function readLines(path: string, options: WithDirLockOptions = {}): Promise<unknown[]> {
  try {
    return await withDirLock(dirname(path), () => readLinesUnlocked(path), options);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return [];
    throw error;
  }
}

export interface ReadLinesLenientResult {
  records: unknown[];
  skipped: number;
}

async function readLinesLenientUnlocked(path: string): Promise<ReadLinesLenientResult> {
  const raw = await readRawOrNull(path);
  if (raw === null || raw.length === 0) return { records: [], skipped: 0 };
  // 结尾换行是 appendLine 写入格式的一部分，不算一条记录；其它空行按损坏行计数。
  const body = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
  const records: unknown[] = [];
  let skipped = 0;
  for (const rawLine of body.split("\n")) {
    try {
      records.push(JSON.parse(rawLine));
    } catch {
      skipped += 1;
    }
  }
  return { records, skipped };
}

export async function readLinesLenient(path: string, options: WithDirLockOptions = {}): Promise<ReadLinesLenientResult> {
  try {
    return await withDirLock(dirname(path), () => readLinesLenientUnlocked(path), options);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { records: [], skipped: 0 };
    throw error;
  }
}

export async function appendLine(path: string, data: unknown): Promise<{ lineNumber: number; line: string }> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: DIR_MODE });
  return withDirLock(dir, async () => {
    const line = serializeLine(data);
    const raw = await readRawOrNull(path);
    const lines = raw === null ? [] : splitRecordLines(raw, path);
    validateRecordLines(lines, path);
    const beforeContent = raw ?? "";
    const handle = await open(path, "a", FILE_MODE);
    try {
      await handle.writeFile(`${line}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    const after = await readFile(path, "utf8");
    if (after !== `${beforeContent}${line}\n`) {
      throw new Error(`记录文件损坏: 追加后内容校验失败: ${path}`);
    }
    return { lineNumber: lines.length + 1, line };
  });
}

export async function fileFingerprint(path: string): Promise<string> {
  const buffer = await readFile(path);
  return createHash("sha256").update(buffer).digest("hex");
}
