import type { DatabaseSync } from "node:sqlite";
import { uuidv7 } from "../../core/storage/database.ts";
import type { LocalDatabase, StoredRecord } from "../../core/storage/database.ts";
import { checked, LineAnchorMemberRecord, LineAnchorRecord } from "./requirement-contracts.ts";
import type { PrdReference, RequirementRecord } from "./requirement-contracts.ts";
import { REQUIREMENT_OPERATION_NAMESPACE } from "./requirement-coordination.ts";

export const LINE_ANCHOR_ENTRY = "one-company.line-anchor";

const ANCHORS = "line_anchors";
const MEMBERS = "line_anchor_members";

export function createLineAnchorIn(db: LocalDatabase, input: {
  repoId: string; requirementId: string; anchor: string; kind: LineAnchorRecord["kind"];
  line: readonly string[]; now: number; fileCommit?: string;
}): LineAnchorRecord {
  const all = anchorsOf(db, input.requirementId);
  const parent = viewOf(all, input.line).tip;
  const record = checked(LineAnchorRecord, {
    format: "line-anchor/v1", repoId: input.repoId, requirementId: input.requirementId, anchor: input.anchor,
    parent: parent?.anchor ?? null, kind: input.kind,
    lineVersion: parent ? parent.lineVersion + (input.kind === "save" ? 1 : 0) : input.kind === "save" ? 2 : 1,
    sequence: all.reduce((max, record) => Math.max(max, record.sequence), 0) + 1,
    fileCommit: input.fileCommit ?? parent?.fileCommit ?? null, createdAt: input.now,
  });
  db.create(ANCHORS, record.anchor, record);
  return record;
}

export function attachRecordIn(db: LocalDatabase, input: { namespace: string; key: string; requirementId: string; anchor: string }): void {
  const member = checked(LineAnchorMemberRecord, { format: "line-anchor-member/v1", requirementId: input.requirementId, anchor: input.anchor });
  db.create(MEMBERS, `${input.namespace}:${input.key}`, member);
}

function anchorsOf(db: LocalDatabase, requirementId: string): LineAnchorRecord[] {
  return db.list<LineAnchorRecord>(ANCHORS).map((row) => row.data).filter((record) => record.requirementId === requirementId);
}

function viewOf(all: LineAnchorRecord[], line: readonly string[]): { tip: LineAnchorRecord | null; counted: Set<string>; version: number | null } {
  const byAnchor = new Map(all.map((record) => [record.anchor, record]));
  const ancestorsOf = (start: LineAnchorRecord | null) => {
    const result = new Set<string>();
    for (let cursor = start; cursor && !result.has(cursor.anchor); cursor = cursor.parent ? byAnchor.get(cursor.parent) ?? null : null) result.add(cursor.anchor);
    return result;
  };
  const pick = (records: LineAnchorRecord[], better: (a: number, b: number) => boolean) =>
    records.reduce<LineAnchorRecord | null>((best, record) => !best || better(record.sequence, best.sequence) ? record : best, null);
  const approval = pick(all.filter((record) => record.kind === "approval"), (a, b) => a < b);
  if (approval) {
    const counted = ancestorsOf(approval);
    for (const record of all) if (record.sequence > approval.sequence) counted.add(record.anchor);
    const tip = pick(all, (a, b) => a > b);
    return { tip, counted, version: tip?.lineVersion ?? null };
  }
  let tip: LineAnchorRecord | null = null;
  for (let i = line.length - 1; i >= 0 && !tip; i--) tip = byAnchor.get(line[i]!) ?? null;
  tip ??= latestSaveOf(all);
  return { tip, counted: ancestorsOf(tip), version: tip?.lineVersion ?? null };
}

export function lineViewIn(db: LocalDatabase, requirementId: string, line: readonly string[]) {
  return viewOf(anchorsOf(db, requirementId), line);
}

export function memberAnchorIn(db: LocalDatabase, namespace: string, key: string): string | null {
  return db.read<{ anchor: string }>(MEMBERS, `${namespace}:${key}`)?.data.anchor ?? null;
}

function latestSaveOf(anchors: readonly LineAnchorRecord[]): LineAnchorRecord | null {
  return anchors.filter((record) => record.kind === "save").reduce<LineAnchorRecord | null>((best, record) => !best || record.sequence > best.sequence ? record : best, null);
}

export function latestSaveAnchorIn(db: LocalDatabase, requirementId: string): LineAnchorRecord | null {
  return latestSaveOf(anchorsOf(db, requirementId));
}

export function resolveLineTipIn(db: LocalDatabase, requirementId: string, line: readonly string[]): LineAnchorRecord | null {
  return lineViewIn(db, requirementId, line).tip;
}

export function countedAnchorsIn(db: LocalDatabase, requirementId: string, line: readonly string[]): Set<string> {
  return lineViewIn(db, requirementId, line).counted;
}

export function isRecordCountedIn(db: LocalDatabase, input: { namespace: string; key: string; requirementId: string; line: readonly string[] }): boolean {
  const anchor = memberAnchorIn(db, input.namespace, input.key);
  return anchor === null || countedAnchorsIn(db, input.requirementId, input.line).has(anchor);
}

export function lineVersionIn(db: LocalDatabase, requirementId: string, line: readonly string[]): number | null {
  return lineViewIn(db, requirementId, line).version;
}

export const RESTORE_FAILURE = {
  anchorMissing: "这条对话线上最后一次保存的记录在库里找不到，改用最近一次保存的那份",
  gitUnreadable: "这条对话线上最后一次保存的正文在需求自己的 Git 仓库里读不出，改用最近一次保存的那份",
} as const;

export function savedHashAt(operations: Iterable<{ requirementId: string; git: { commit: string; hash: string } | null }>, requirementId: string, commit: string): string | undefined {
  for (const operation of operations) if (operation.requirementId === requirementId && operation.git?.commit === commit) return operation.git.hash;
  return undefined;
}

export interface DraftLineView { version: number; saved: PrdReference | null; fileCommit: string | null; tip: LineAnchorRecord | null; updatedAt: number; restoreFailure?: string }

export function draftLineView(
  row: Pick<StoredRecord<RequirementRecord>, "version" | "data">, anchors: LineAnchorRecord[], line: readonly string[], hashAt: (commit: string) => string | undefined,
  forcedFailure?: string,
): DraftLineView {
  const rowSaved = row.data.saved;
  const last = line.at(-1);
  const latestSave = latestSaveOf(anchors);
  const hashOf = (tip: LineAnchorRecord) => tip.fileCommit === null ? undefined : tip.fileCommit === rowSaved?.commit ? rowSaved.hash : hashAt(tip.fileCommit);
  let failure = forcedFailure;
  let tip = latestSave;
  if (last !== undefined && !failure) {
    if (!anchors.some((record) => record.anchor === last)) failure = RESTORE_FAILURE.anchorMissing;
    else tip = viewOf(anchors, line).tip;
  }
  const restore = failure ? { restoreFailure: failure } : {};
  if (!tip) return { version: row.version, saved: rowSaved, fileCommit: rowSaved?.commit ?? null, tip: null, updatedAt: row.data.updatedAt, ...restore };
  const commit = tip.fileCommit;
  const hash = hashOf(tip);
  return { version: tip.lineVersion, saved: commit !== null && hash !== undefined ? { commit, hash } : null, fileCommit: commit, tip, updatedAt: Math.max(row.data.createdAt, tip.createdAt), ...restore };
}

export function draftLineViewIn(
  db: LocalDatabase, row: Pick<StoredRecord<RequirementRecord>, "version" | "data">, line: readonly string[], anyLifecycle = false, forcedFailure?: string,
): DraftLineView {
  const requirementId = row.data.requirementId;
  if (!anyLifecycle && row.data.lifecycle !== "draft") return { version: row.version, saved: row.data.saved, fileCommit: row.data.saved?.commit ?? null, tip: null, updatedAt: row.data.updatedAt };
  return draftLineView(row, anchorsOf(db, requirementId), line, (commit) =>
    savedHashAt(db.list<{ requirementId: string; git: { commit: string; hash: string } | null }>(REQUIREMENT_OPERATION_NAMESPACE).map((stored) => stored.data), requirementId, commit), forcedFailure);
}

export function readAnchorIn(db: LocalDatabase, anchor: string): LineAnchorRecord | null {
  return db.read<LineAnchorRecord>(ANCHORS, anchor)?.data ?? null;
}

export function rawLinedRequirement(db: RawDb, row: StoredRecord<RequirementRecord>, line: readonly string[]): StoredRecord<RequirementRecord> {
  const view = rawLineView(db, row, line);
  return { ...row, version: view.version, data: { ...row.data, saved: view.saved, updatedAt: view.updatedAt } };
}

export function linedRequirementIn(db: LocalDatabase, row: StoredRecord<RequirementRecord>, line: readonly string[]): StoredRecord<RequirementRecord> {
  const view = draftLineViewIn(db, row, line);
  return { ...row, version: view.version, data: { ...row.data, saved: view.saved, updatedAt: view.updatedAt } };
}

type RawDb = Pick<DatabaseSync, "prepare">;

function rawAnchors(db: RawDb, requirementId: string): LineAnchorRecord[] {
  return db.prepare("SELECT data FROM records WHERE namespace='line_anchors' AND json_extract(data,'$.requirementId')=?").all(requirementId)
    .map((row) => checked(LineAnchorRecord, JSON.parse(String(row.data))));
}

export function rawLineView(db: RawDb, row: Pick<StoredRecord<RequirementRecord>, "version" | "data">, line: readonly string[]): DraftLineView {
  const requirementId = row.data.requirementId;
  if (row.data.lifecycle !== "draft") return { version: row.version, saved: row.data.saved, fileCommit: row.data.saved?.commit ?? null, tip: null, updatedAt: row.data.updatedAt };
  const operations = db.prepare("SELECT data FROM records WHERE namespace=? AND json_extract(data,'$.requirementId')=?").all(REQUIREMENT_OPERATION_NAMESPACE, requirementId)
    .map((operation) => JSON.parse(String(operation.data)) as { requirementId: string; git: { commit: string; hash: string } | null });
  return draftLineView(row, rawAnchors(db, requirementId), line, (commit) => savedHashAt(operations, requirementId, commit));
}

export function rawLineCounter(db: RawDb, requirementId: string, line: readonly string[]): (namespace: string, key: string) => boolean {
  const counted = viewOf(rawAnchors(db, requirementId), line).counted;
  return (namespace, key) => {
    const member = db.prepare("SELECT json_extract(data,'$.anchor') AS anchor FROM records WHERE namespace='line_anchor_members' AND record_key=?").get(`${namespace}:${key}`);
    return member === undefined || counted.has(String(member.anchor));
  };
}

/** 当前对话线上每个需求的锚点编号；新建的过程记录锚点追加在末尾。后台进程不传，不按对话线筛选。 */
export type WorkingLines = Record<string, string[]>;

export function lineOf(lines: Readonly<Record<string, readonly string[]>> | undefined, requirementId: string): readonly string[] | undefined {
  return lines ? lines[requirementId] ?? [] : undefined;
}

export function createProcessAnchorIn(db: LocalDatabase, input: {
  repoId: string; requirementId: string; kind: "decision" | "question" | "manifest"; lines: WorkingLines; now: number; members: Array<{ namespace: string; key: string }>;
}): string {
  const anchor = uuidv7();
  createLineAnchorIn(db, { repoId: input.repoId, requirementId: input.requirementId, anchor, kind: input.kind, line: input.lines[input.requirementId] ?? [], now: input.now });
  for (const member of input.members) attachRecordIn(db, { ...member, requirementId: input.requirementId, anchor });
  return anchor;
}

export function extendLine(lines: WorkingLines, requirementId: string, anchor: string): void {
  (lines[requirementId] ??= []).push(anchor);
}
