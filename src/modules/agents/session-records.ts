import { appendFileSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync, constants } from "node:fs";
import { dirname, join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { FileEntry, SessionEntry } from "@earendil-works/pi-coding-agent";
import { repositoryDatabase, readRecord, withDatabase, UUID_V7_PATTERN, uuidv7, StaleVersionError } from "../../core/storage/database.ts";

interface RunRef {
  dataRoot: string;
  repoId: string;
  runId: string;
  onPersistError?: (error: Error) => void;
}

interface CreateRunContext extends RunRef {
  cwd: string;
}

export function sessionRecordRef(ref: RunRef) {
  if (!UUID_V7_PATTERN.test(ref.runId)) throw new Error("运行编号必须是 UUIDv7");
  return { database: repositoryDatabase(ref.dataRoot, ref.repoId), namespace: "sessions", key: ref.runId };
}

/** 会话条目可能含 prod 正文，只存本机私有文件；data.db 只留 cwd 与当前位置元数据。 */
export function sessionFilePath(ref: RunRef): string {
  if (!UUID_V7_PATTERN.test(ref.runId)) throw new Error("运行编号必须是 UUIDv7");
  return join(dirname(repositoryDatabase(ref.dataRoot, ref.repoId)), "sessions", ref.runId, "session.jsonl");
}

function appendEntry(path: string, entry: unknown): void {
  appendFileSync(path, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
}

function readEntries(path: string): unknown[] {
  const text = readFileSync(path, "utf8");
  const lines = text.split("\n");
  // 每条都以换行结尾，末段要么为空，要么是进程写到一半退出留下的残行，都按未写入处理
  lines.pop();
  return lines.map((line) => JSON.parse(line) as unknown);
}

function persistManager(manager: SessionManager, ref: RunRef, version: number): SessionManager {
  const address = sessionRecordRef(ref);
  let persistError: Error | undefined;
  const saveLeaf = (leafId: string | null, entry?: SessionEntry) => {
    if (persistError) throw persistError;
    // 先核对版本再追加文件，过期写入者不留下条目；文件追加在数据库事务之外
    if (withDatabase(address.database, (db) => db.read(address.namespace, address.key)?.version) !== version) throw new StaleVersionError();
    if (entry) appendEntry(sessionFilePath(ref), entry);
    withDatabase(address.database, (db) => db.transaction(() => {
      const stored = db.read<{ cwd: string; leafId: string | null }>(address.namespace, address.key);
      if (!stored) throw new Error("会话元数据不存在");
      if (stored.version !== version) throw new StaleVersionError();
      version = db.update(address.namespace, address.key, stored.version, { ...stored.data, leafId });
    }));
  };
  manager._persist = (entry: SessionEntry) => {
    try { saveLeaf(entry.id, entry); }
    catch (error) {
      if (persistError) {
        if (!ref.onPersistError) throw persistError;
        return;
      }
      persistError = error instanceof Error ? error : new Error(String(error));
      if (!ref.onPersistError) throw error;
      ref.onPersistError(persistError);
    }
  };
  const branch = manager.branch.bind(manager);
  manager.branch = (id) => {
    if (!manager.getEntry(id)) throw new Error(`会话分支条目不存在: ${id}`);
    saveLeaf(id);
    branch(id);
  };
  const resetLeaf = manager.resetLeaf.bind(manager);
  manager.resetLeaf = () => { saveLeaf(null); resetLeaf(); };
  manager.newSession = manager.createBranchedSession = manager.setSessionFile = () => { throw new Error("受管理运行不能替换会话身份或改用文件存储"); };
  return manager;
}

export function createSessionManagerForRun(ctx: CreateRunContext): SessionManager {
  const manager = SessionManager.inMemory(ctx.cwd, { id: uuidv7() });
  const ref = sessionRecordRef(ctx);
  const path = sessionFilePath(ctx);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { writeSync(fd, `${JSON.stringify(manager.getHeader())}\n`); fsyncSync(fd); } finally { closeSync(fd); }
  withDatabase(ref.database, (db) => db.create(ref.namespace, ref.key, { cwd: ctx.cwd, leafId: null }));
  return persistManager(manager, ctx, 1);
}

export type SessionFileFailure = { ok: false; reason: "missing" | "corrupt"; detail: string };

interface MinimalEntry {
  type?: string;
  id?: string;
  parentId?: string | null;
}

/** 只读已登记运行的会话条目；不打开可写会话，也不据此恢复运行。 */
export function readSessionEntries(ref: RunRef): { ok: true; entries: FileEntry[] } | SessionFileFailure {
  let rawEntries: unknown[];
  let leafId: string | null;
  try {
    const address = sessionRecordRef(ref);
    const stored = readRecord<{ cwd: string; leafId: string | null }>(address);
    if (!stored.exists) return { ok: false, reason: "missing", detail: `会话记录不存在: ${ref.runId}` };
    if (!stored.data || typeof stored.data.cwd !== "string" || !(stored.data.leafId === null || typeof stored.data.leafId === "string")) throw new Error("会话元数据结构无效");
    leafId = stored.data.leafId;
    rawEntries = readEntries(sessionFilePath(ref));
  } catch (error) { return { ok: false, reason: "corrupt", detail: `会话记录无法读取: ${(error as Error).message}` }; }
  const ids = new Set<string>();

  for (let i = 0; i < rawEntries.length; i++) {
    const parsed = rawEntries[i];
    const lineNumber = i + 1;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false, reason: "corrupt", detail: `第 ${lineNumber} 条会话记录结构无效` };
    const minimal = parsed as MinimalEntry;
    if (rawEntries.length > 0 && minimal.parentId != null && !ids.has(minimal.parentId)) {
      return {
        ok: false,
        reason: "corrupt",
        detail: `第 ${lineNumber} 行 parentId 指向不存在的条目: ${minimal.parentId}`,
      };
    }
    if (typeof minimal.id !== "string" || ids.has(minimal.id)) return { ok: false, reason: "corrupt", detail: `第 ${lineNumber} 条记录编号缺失或重复` };
    ids.add(minimal.id);
    if (minimal.type === "message") {
      const message = (parsed as { message?: { role?: unknown; content?: unknown } }).message;
      if (!message || typeof message.role !== "string" || !(typeof message.content === "string" || (Array.isArray(message.content) && message.content.every((block) => block && typeof block === "object" && typeof block.type === "string")))) return { ok: false, reason: "corrupt", detail: `第 ${lineNumber} 条消息结构无效` };
    }
  }

  if (rawEntries.length === 0) return { ok: false, reason: "corrupt", detail: `会话记录为空: ${ref.runId}` };
  const header = rawEntries[0] as MinimalEntry;
  if (header.type !== "session") return { ok: false, reason: "corrupt", detail: `首条记录不是 session header: ${ref.runId}` };

  if (leafId !== null && !ids.has(leafId)) return { ok: false, reason: "corrupt", detail: "会话当前位置指向不存在的条目" };
  return { ok: true, entries: rawEntries as FileEntry[] };
}
