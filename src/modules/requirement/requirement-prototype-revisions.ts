import { Type } from "typebox";
import type { Static } from "typebox";
import { Value } from "typebox/value";
import { repositoryDatabase, withDatabase } from "../../core/storage/database.ts";
import type { LocalDatabase } from "../../core/storage/database.ts";
import { PickedOption } from "./requirement-prototypes.ts";
import { hash as sha256Hex, id, object, positive } from "./requirement-contracts.ts";

const REVISIONS = "requirement_prototype_revisions";

const PrototypeRevision = object({ requirementId: id, revision: positive,
  prototypes: Type.Array(object({ name: Type.String({ minLength: 1, maxLength: 40 }), version: positive, hash: sha256Hex, bytes: positive, picked: Type.Union([PickedOption, Type.Null()]) }), { maxItems: 50 }) });
type PrototypeRevision = Static<typeof PrototypeRevision>;
export type RevisionPrototype = PrototypeRevision["prototypes"][number];

export interface PrototypeChanges {
  added: Array<{ name: string; version: number }>;
  replaced: Array<{ name: string; from: number; to: number }>;
  removed: Array<{ name: string; version: number }>;
}

type Ref = { dataRoot: string; repoId: string };
const keyOf = (requirementId: string, revision: number) => `${requirementId}:${revision}`;
const byName = (items: RevisionPrototype[]) => new Map(items.map((item) => [item.name, item]));

export function writePrototypeRevision(db: LocalDatabase, input: PrototypeRevision): void {
  if (!Value.Check(PrototypeRevision, input)) throw new Error("原型版本快照不符合结构");
  const key = keyOf(input.requirementId, input.revision);
  const existing = db.read<PrototypeRevision>(REVISIONS, key);
  if (!existing) { db.create(REVISIONS, key, input); return; }
  if (JSON.stringify(existing.data) !== JSON.stringify(input)) throw new Error(`第 ${input.revision} 版需求的原型快照已存在且内容不同`);
}

export async function prototypesAtRevision(ref: Ref, requirementId: string, revision: number): Promise<RevisionPrototype[]> {
  if (revision < 1) return [];
  return withDatabase(repositoryDatabase(ref.dataRoot, ref.repoId), (db) => db.read<PrototypeRevision>(REVISIONS, keyOf(requirementId, revision))?.data.prototypes ?? []);
}

export function prototypeChanges(from: RevisionPrototype[], to: RevisionPrototype[]): PrototypeChanges {
  const before = byName(from), after = byName(to);
  const changes: PrototypeChanges = { added: [], replaced: [], removed: [] };
  for (const item of to) {
    const previous = before.get(item.name);
    if (!previous) changes.added.push({ name: item.name, version: item.version });
    else if (previous.version !== item.version) changes.replaced.push({ name: item.name, from: previous.version, to: item.version });
  }
  for (const item of from) if (!after.has(item.name)) changes.removed.push({ name: item.name, version: item.version });
  return changes;
}

export function prototypeChangeLines(changes: PrototypeChanges): string {
  const parts = [
    ...changes.replaced.map((item) => `${item.name} 换成第 ${item.to} 版`),
    ...changes.added.map((item) => `${item.name} 新确认第 ${item.version} 版`),
    ...changes.removed.map((item) => `${item.name} 移除`),
  ];
  return parts.length ? `原型变化：${parts.join("；")}` : "";
}
