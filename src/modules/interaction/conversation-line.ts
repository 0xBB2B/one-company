import type { ExtensionAPI, SessionManager } from "@earendil-works/pi-coding-agent";
import { appendCustomEntry, branchCustomEntries } from "../../core/host/conversation-entries.ts";
import { LINE_ANCHOR_ENTRY } from "../requirement/line-anchors.ts";

export const SAVE_START_ENTRY = "one-company.save-start";

interface LineAnchorEntry { repoId: string; requirementId: string; anchor: string }

export function currentLine(sessionManager: Pick<SessionManager, "getBranch">): Record<string, string[]> {
  const line: Record<string, string[]> = {};
  for (const entry of branchCustomEntries<LineAnchorEntry>(sessionManager, LINE_ANCHOR_ENTRY)) (line[entry.requirementId] ??= []).push(entry.anchor);
  return line;
}

export function recordLineAnchor(pi: Pick<ExtensionAPI, "appendEntry">, entry: LineAnchorEntry): void {
  appendCustomEntry(pi, LINE_ANCHOR_ENTRY, entry);
}

export function recordSaveStart(pi: Pick<ExtensionAPI, "appendEntry">, entry: { repoId: string; requirementId: string; operationId: string }): void {
  appendCustomEntry(pi, SAVE_START_ENTRY, entry);
}

export function startedSaves(sessionManager: Pick<SessionManager, "getBranch">): Record<string, string[]> {
  const started: Record<string, string[]> = {};
  for (const entry of branchCustomEntries<{ requirementId: string; operationId: string }>(sessionManager, SAVE_START_ENTRY)) (started[entry.requirementId] ??= []).push(entry.operationId);
  return started;
}
