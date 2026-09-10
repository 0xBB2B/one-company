import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { FileEntry, SessionEntry } from "@earendil-works/pi-coding-agent";
import { repositoryDatabase, readRecord, withDatabase, UUID_V7_PATTERN, uuidv7, StaleVersionError } from "./database.ts";

interface RunRef {
  dataRoot: string;
  repoId: string;
  runId: string;
  onPersistError?: (error: Error) => void;
}

interface CreateRunContext extends RunRef {
  cwd: string;
}

interface OpenRunContext extends RunRef {
  cwd?: string;
}

export function sessionRecordRef(ref: RunRef) {
  if (!UUID_V7_PATTERN.test(ref.runId)) throw new Error("运行编号必须是 UUIDv7");
  return { database: repositoryDatabase(ref.dataRoot, ref.repoId), namespace: "sessions", key: ref.runId };
}

function persistManager(manager: SessionManager, ref: RunRef, version: number): SessionManager {
  const address = sessionRecordRef(ref);
  let persistError: Error | undefined;
  const saveLeaf = (leafId: string | null, entry?: SessionEntry) => {
    if (persistError) throw persistError;
    withDatabase(address.database, (db) => db.transaction(() => {
      const stored = db.read<{ cwd: string; header: FileEntry; leafId: string | null }>(address.namespace, address.key);
      if (!stored) throw new Error("会话元数据不存在");
      if (stored.version !== version) throw new StaleVersionError();
      if (entry) db.append(`session:${ref.runId}`, entry);
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
  withDatabase(ref.database, (db) => db.create(ref.namespace, ref.key, { cwd: ctx.cwd, header: manager.getHeader(), leafId: null }));
  return persistManager(manager, ctx, 1);
}

export type SessionFileFailure = { ok: false; reason: "missing" | "corrupt"; detail: string };

interface MinimalEntry {
  type?: string;
  id?: string;
  parentId?: string | null;
}

function validateSessionRecord(ref: RunRef): { ok: true; entries: FileEntry[]; leafId: string | null; version: number } | SessionFileFailure {
  let rawEntries: unknown[];
  let leafId: string | null;
  let version: number;
  try {
    const address = sessionRecordRef(ref);
    const stored = readRecord<{ cwd: string; header: FileEntry; leafId: string | null }>(address);
    if (!stored.exists) return { ok: false, reason: "missing", detail: `会话记录不存在: ${ref.runId}` };
    if (!stored.data || typeof stored.data.cwd !== "string" || !(stored.data.leafId === null || typeof stored.data.leafId === "string")) throw new Error("会话元数据结构无效");
    leafId = stored.data.leafId;
    version = stored.version;
    rawEntries = withDatabase(address.database, (db) => [stored.data.header, ...db.events<SessionEntry>(`session:${ref.runId}`).map((event) => event.data)]);
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
  return { ok: true, entries: rawEntries as FileEntry[], leafId, version };
}

export type OpenSessionOutcome = { ok: true; manager: SessionManager } | SessionFileFailure;

export function openSessionManagerForRun(ctx: OpenRunContext): OpenSessionOutcome {
  const validated = validateSessionRecord(ctx);
  if (!validated.ok) return validated;
  try {
    const header = validated.entries[0] as { cwd?: string };
    const manager = SessionManager.inMemory(ctx.cwd ?? header.cwd, undefined, validated.entries);
    if (validated.leafId === null) manager.resetLeaf();
    else manager.branch(validated.leafId);
    return { ok: true, manager: persistManager(manager, ctx, validated.version) };
  } catch (error) { return { ok: false, reason: "corrupt", detail: (error as Error).message }; }
}

export type SynthesizeOutcome =
  | { ok: true; appended: Array<{ toolCallId: string; toolName: string }> }
  | SessionFileFailure;

export function synthesizeInterruptedResults(ctx: RunRef): SynthesizeOutcome {
  const opened = openSessionManagerForRun(ctx);
  if (!opened.ok) return opened;
  const manager = opened.manager;

  const calls: Array<{ toolCallId: string; toolName: string }> = [];
  const resultIds = new Set<string>();
  for (const entry of manager.getBranch()) {
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (message.role === "assistant") {
      for (const block of message.content) {
        if (block.type === "toolCall") calls.push({ toolCallId: block.id, toolName: block.name });
      }
    } else if (message.role === "toolResult") {
      resultIds.add(message.toolCallId);
    }
  }

  const missing = calls.filter((call) => !resultIds.has(call.toolCallId));
  for (const call of missing) {
    manager.appendMessage({
      role: "toolResult",
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      content: [{ type: "text", text: "调用因守护进程中断" }],
      isError: true,
      timestamp: Date.now(),
    });
  }
  return { ok: true, appended: missing };
}

export type TranscriptEntryKind = "thinking" | "text" | "toolcall" | "tool_result" | "error";

export interface TranscriptEntry {
  seq: number;
  kind: TranscriptEntryKind;
  summary: string;
  at?: string;
}

function extractText(content: string | Array<{ type: string; text?: string }>): string {
  if (typeof content === "string") return content;
  return content
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("\n");
}

export type ReadTranscriptOutcome = { ok: true; entries: TranscriptEntry[]; ended: boolean } | SessionFileFailure;

export function readTranscript(ctx: RunRef & { fromSeq?: number }): ReadTranscriptOutcome {
  const validated = validateSessionRecord(ctx);
  if (!validated.ok) return validated;

  const entries: TranscriptEntry[] = [];
  let seq = 0;

  for (const fileEntry of validated.entries) {
    if (fileEntry.type !== "message") continue;
    const message = fileEntry.message;
    const at = fileEntry.timestamp;
    if (message.role === "user") {
      const text = extractText(message.content);
      if (text) entries.push({ seq: ++seq, kind: "text", summary: text, at });
    } else if (message.role === "assistant") {
      for (const block of message.content) {
        if (block.type === "thinking") entries.push({ seq: ++seq, kind: "thinking", summary: block.thinking, at });
        else if (block.type === "text") entries.push({ seq: ++seq, kind: "text", summary: block.text, at });
        else if (block.type === "toolCall") entries.push({ seq: ++seq, kind: "toolcall", summary: block.name, at });
      }
    } else if (message.role === "toolResult") {
      entries.push({
        seq: ++seq,
        kind: message.isError ? "error" : "tool_result",
        summary: extractText(message.content),
        at,
      });
    }
  }

  const run = readRecord<{ state: string }>({ database: repositoryDatabase(ctx.dataRoot, ctx.repoId), namespace: "runs", key: ctx.runId });
  const ended = run.exists && ["completed", "failed", "stopped"].includes(run.data.state);

  const filtered = ctx.fromSeq === undefined ? entries : entries.filter((entry) => entry.seq > (ctx.fromSeq as number));
  return { ok: true, entries: filtered, ended };
}

export type TranscriptSeqOutcome = { ok: true; seq: number } | SessionFileFailure;

export function transcriptSeq(ctx: RunRef): TranscriptSeqOutcome {
  const result = readTranscript(ctx);
  if (!result.ok) return result;
  const last = result.entries[result.entries.length - 1];
  return { ok: true, seq: last ? last.seq : 0 };
}
