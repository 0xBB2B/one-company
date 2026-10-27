import { mutedLines } from "../../core/host/question-window.ts";
import type { WindowLine } from "../../core/host/question-window.ts";
import { sanitizeText } from "../../core/policy/text-sanitize.ts";

export const ACCEPT_LABEL = "通过（写进需求草稿）";
export const ACCEPT_NOTE_LABEL = "通过并补充说明（自己输入）";
export const ABANDON_LABEL = "放弃这一版";
export const REWORK_LABEL = "返工（自己输入要改什么）";
export const REMOVE_LABEL = "移除";
export const KEEP_LABEL = "保留";

export interface PendingPrototype {
  requirementTitle: string; draftVersion: number; name: string; version: number; path: string; bytes: number; hash: string; note: string; previousOpinion: string | null;
}
export interface PrototypeRemoval { requirementTitle: string; draftVersion: number; name: string; version: number; approvedRevision: number | null }

/** 长路径在目录分隔处断开，续行缩进对齐，避免在 80 列窗口里被从中间硬折。 */
export function pathLines(path: string): string[] {
  const lines: string[] = [];
  let line = "文件：";
  for (const segment of path.split(/(?<=\/)/)) {
    if (line.trim() && line !== "文件：" && line.length + segment.length > 72) { lines.push(line); line = "      "; }
    line += segment;
  }
  return [...lines, line];
}

export function formatBytes(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : bytes < 1_048_576 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1_048_576).toFixed(1)} MB`;
}

export function confirmWindowContent(pending: PendingPrototype, opened: boolean) {
  const lines: WindowLine[] = [
    { text: `需求：${pending.requirementTitle}（草稿，第 ${pending.draftVersion} 版）` },
    { text: `原型：${pending.name}（第 ${pending.version} 版）` },
    ...mutedLines(pathLines(pending.path)),
    { text: `大小 ${formatBytes(pending.bytes)} · 指纹 sha256:${pending.hash.slice(0, 12)}…`, tone: "muted" },
    opened ? { text: "已在默认浏览器打开这个文件。", tone: "muted" } : { text: "浏览器没有打开，请手动打开上面的文件。" },
    ...(pending.previousOpinion ? [{ text: `上一版你的意见：「${pending.previousOpinion}」`, tone: "muted" as const }] : []),
    { text: `设计师的说明（模型写的，仅供参考）：「${sanitizeText(pending.note, 2000).replace(/\s+/g, " ").trim()}」`, tone: "muted" },
  ];
  return { title: "确认原型", lines, choices: [{ label: ACCEPT_LABEL }, { label: ACCEPT_NOTE_LABEL, writable: true }], otherLabel: REWORK_LABEL, escapeChoice: ABANDON_LABEL, escapeHint: "Esc 放弃这一版" };
}

export function removeWindowContent(removal: PrototypeRemoval) {
  const origin = removal.approvedRevision === null ? "本次草稿新通过" : `第 ${removal.approvedRevision} 版需求里批准过`;
  const lines: WindowLine[] = [
    { text: `需求：${removal.requirementTitle}（草稿，第 ${removal.draftVersion} 版）` },
    { text: `原型：${removal.name}（第 ${removal.version} 版，${origin}）` },
    ...mutedLines([`移除后，批准第 ${removal.draftVersion} 版时它不再交给 PM 和子代理；文件留在本机，不删除。`]),
  ];
  return { title: "移除原型", lines, choices: [{ label: REMOVE_LABEL }, { label: KEEP_LABEL }], cancelNote: KEEP_LABEL };
}

export type PrototypeRecord =
  | { kind: "accept"; name: string; version: number; note?: string }
  | { kind: "abandon" | "rework"; name: string; version: number }
  | { kind: "remove"; name: string; draftVersion: number };

export function decisionEntryText(record: PrototypeRecord): string {
  switch (record.kind) {
    case "accept": return `已登记：原型「${record.name}」第 ${record.version} 版通过，已写进需求草稿。${record.note ? `你的说明：「${record.note}」` : ""}`;
    case "abandon": return `已登记：放弃原型「${record.name}」第 ${record.version} 版，它不再挡住批准。`;
    case "rework": return `已登记：原型「${record.name}」第 ${record.version} 版返工，你的意见已原话交给主代理重派设计师。`;
    case "remove": return `已登记：原型「${record.name}」从草稿移除，批准第 ${record.draftVersion} 版后生效。`;
  }
}
