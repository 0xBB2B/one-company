import type { TSchema } from "typebox";
import { Value } from "typebox/value";
import type { DataMigrationStep } from "../../core/storage/database-migration.ts";
import { PrototypeBoard } from "./requirement-prototypes.ts";
import { PrototypeRevision } from "./requirement-prototype-revisions.ts";

const firstError = (schema: TSchema, data: unknown) => {
  const error = Value.Errors(schema, data)[0];
  return { path: error?.instancePath ?? "", reason: error ? `${error.instancePath || "/"} ${error.message}` : "结构不符" };
};

type JsonObject = Record<string, unknown>;

function migratePrototypeFile(file: unknown): unknown {
  // 缺键时原样交给结构校验，报错才能带上原型名和字段路径
  if (file === null || file === undefined) return file;
  const { userNote: _dropped, ...rest } = file as JsonObject;
  return { ...rest, options: [], picked: null };
}

function migrateBoard(data: unknown): unknown {
  const source = data as { requirementId: string; entries: JsonObject[] };
  const entries = source.entries.map((entry) => {
    const inFlight = entry.inFlight as JsonObject | null;
    return {
      ...entry,
      draft: migratePrototypeFile(entry.draft),
      approved: migratePrototypeFile(entry.approved),
      inFlight: inFlight && { ...inFlight, file: migratePrototypeFile(inFlight.file) },
    };
  });
  const board = { ...source, entries };
  if (!Value.Check(PrototypeBoard, board)) {
    const { path, reason } = firstError(PrototypeBoard, board);
    const index = Number(/^\/entries\/(\d+)/.exec(path)?.[1]);
    throw new Error(`原型记录（需求 ${source.requirementId}，原型「${source.entries[index]?.name ?? ""}」）读不出来：${reason}`);
  }
  return board;
}

function migrateRevision(data: unknown): unknown {
  const source = data as { requirementId: string; revision: number; prototypes: JsonObject[] };
  const revision = {
    ...source,
    prototypes: source.prototypes.map(({ userNote: _dropped, ...rest }) => ({ ...rest, picked: null })),
  };
  if (!Value.Check(PrototypeRevision, revision)) {
    throw new Error(`原型版本快照（需求 ${source.requirementId}，第 ${source.revision} 版）读不出来：${firstError(PrototypeRevision, revision).reason}`);
  }
  return revision;
}

export const prototypeRecordsV8Step: DataMigrationStep = {
  from: 8,
  losses: ["迁移会丢掉原型记录里的「补充说明」（这个功能已经去掉了）"],
  migrate(records) {
    for (const { key, data } of records.list("requirement_prototypes")) records.replace("requirement_prototypes", key, migrateBoard(data));
    for (const { key, data } of records.list("requirement_prototype_revisions")) records.replace("requirement_prototype_revisions", key, migrateRevision(data));
  },
};
