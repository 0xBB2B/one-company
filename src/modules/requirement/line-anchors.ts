import type { LocalDatabase } from "../../core/storage/database.ts";
import { checked, LineAnchorMemberRecord, LineAnchorRecord } from "./requirement-contracts.ts";

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
  tip ??= pick(all.filter((record) => record.kind === "save"), (a, b) => a > b);
  return { tip, counted: ancestorsOf(tip), version: tip?.lineVersion ?? null };
}

export function lineViewIn(db: LocalDatabase, requirementId: string, line: readonly string[]) {
  return viewOf(anchorsOf(db, requirementId), line);
}

export function memberAnchorIn(db: LocalDatabase, namespace: string, key: string): string | null {
  return db.read<{ anchor: string }>(MEMBERS, `${namespace}:${key}`)?.data.anchor ?? null;
}

export function latestSaveAnchorIn(db: LocalDatabase, requirementId: string): LineAnchorRecord | null {
  return anchorsOf(db, requirementId).filter((record) => record.kind === "save").reduce<LineAnchorRecord | null>((best, record) => !best || record.sequence > best.sequence ? record : best, null);
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
