import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { FileEntry } from "@earendil-works/pi-coding-agent";
import { runDataDir } from "./identity.ts";

interface RunRef {
  dataRoot: string;
  repoId: string;
  runId: string;
}

interface CreateRunContext extends RunRef {
  cwd: string;
}

interface OpenRunContext extends RunRef {
  cwd?: string;
}

export function sessionFilePath(ref: RunRef): string {
  return join(runDataDir(ref.dataRoot, ref.repoId, ref.runId), "session.jsonl");
}

export function createSessionManagerForRun(ctx: CreateRunContext): SessionManager {
  const dir = runDataDir(ctx.dataRoot, ctx.repoId, ctx.runId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = sessionFilePath(ctx);
  writeFileSync(file, "", { mode: 0o600, flag: "wx" });
  return SessionManager.open(file, dir, ctx.cwd);
}

export type SessionFileFailure = { ok: false; reason: "missing" | "corrupt"; detail: string };

interface MinimalEntry {
  type?: string;
  id?: string;
  parentId?: string | null;
}

function validateSessionFile(file: string): { ok: true; entries: FileEntry[] } | SessionFileFailure {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { ok: false, reason: "missing", detail: `会话文件不存在: ${file}` };
    return { ok: false, reason: "corrupt", detail: `会话文件无法读取: ${(error as Error).message}` };
  }
  const lines = raw.split("\n");
  const rawEntries: unknown[] = [];
  const ids = new Set<string>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    if (line.trim() === "") continue;
    const lineNumber = i + 1;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      return { ok: false, reason: "corrupt", detail: `第 ${lineNumber} 行 JSON 解析失败: ${(error as Error).message}` };
    }

    const minimal = parsed as MinimalEntry;
    if (rawEntries.length > 0 && minimal.parentId != null && !ids.has(minimal.parentId)) {
      return {
        ok: false,
        reason: "corrupt",
        detail: `第 ${lineNumber} 行 parentId 指向不存在的条目: ${minimal.parentId}`,
      };
    }
    if (typeof minimal.id === "string") ids.add(minimal.id);
    rawEntries.push(parsed);
  }

  if (rawEntries.length === 0) return { ok: false, reason: "corrupt", detail: `会话文件为空: ${file}` };
  const header = rawEntries[0] as MinimalEntry;
  if (header.type !== "session") return { ok: false, reason: "corrupt", detail: `首条记录不是 session header: ${file}` };

  return { ok: true, entries: rawEntries as FileEntry[] };
}

export type OpenSessionOutcome = { ok: true; manager: SessionManager } | SessionFileFailure;

export function openSessionManagerForRun(ctx: OpenRunContext): OpenSessionOutcome {
  const file = sessionFilePath(ctx);
  const validated = validateSessionFile(file);
  if (!validated.ok) return validated;

  const dir = runDataDir(ctx.dataRoot, ctx.repoId, ctx.runId);
  try {
    return { ok: true, manager: SessionManager.open(file, dir, ctx.cwd) };
  } catch (error) {
    return { ok: false, reason: "corrupt", detail: (error as Error).message };
  }
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
  for (const entry of manager.getEntries()) {
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

const TERMINAL_STOP_REASONS = new Set(["stop", "error", "aborted", "length"]);

function extractText(content: string | Array<{ type: string; text?: string }>): string {
  if (typeof content === "string") return content;
  return content
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("\n");
}

export type ReadTranscriptOutcome = { ok: true; entries: TranscriptEntry[]; ended: boolean } | SessionFileFailure;

export function readTranscript(ctx: RunRef & { fromSeq?: number }): ReadTranscriptOutcome {
  const validated = validateSessionFile(sessionFilePath(ctx));
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

  const lastNonToolResult = [...validated.entries]
    .reverse()
    .find((entry) => entry.type === "message" && entry.message.role !== "toolResult");
  const ended =
    lastNonToolResult !== undefined &&
    lastNonToolResult.type === "message" &&
    lastNonToolResult.message.role === "assistant" &&
    TERMINAL_STOP_REASONS.has(lastNonToolResult.message.stopReason);

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
