import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { DataMigrationStep, MigrationRecords } from "../../core/storage/database-migration.ts";
import { uuidv7 } from "../../core/storage/database.ts";
import { commitMigrationFiles, keepMainReachable, prdRequirementPath } from "./prd-storage.ts";
import { validBoard } from "./prototype-record-migration.ts";
import { checked, LineAnchorRecord } from "./requirement-contracts.ts";
import type { PrdReference, RequirementRecord } from "./requirement-contracts.ts";
import { PrototypeBoard } from "./requirement-prototypes.ts";

type MigrationCommits = ReadonlyMap<string, string>;
const tipKey = (requirementId: string) => `${requirementId}:tip`;

const requirementsOf = (records: Pick<MigrationRecords, "list">) =>
  records.list("requirements").map((row) => ({ version: row.version, data: row.data as RequirementRecord }));

async function readPrototypeFile(path: string, name: string): Promise<Uint8Array> {
  try { return await readFile(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    throw new Error(`原型「${name}」的 HTML 原文件 ${path} 不在；把文件放回原处后再迁移`);
  }
}

async function inRequirement<T>(requirementId: string, action: () => Promise<T>): Promise<T> {
  try { return await action(); }
  catch (error) { throw new Error(`需求 ${requirementId}：${error instanceof Error ? error.message : String(error)}`); }
}

async function moveDraftPrototypesIntoRepos(context: { dataRoot: string; repoId: string; records: Pick<MigrationRecords, "list"> }): Promise<MigrationCommits> {
  const commits = new Map<string, string>();
  const boards = new Map(context.records.list("requirement_prototypes").map((row) => [row.key, row.data]));
  for (const { data: requirement } of requirementsOf(context.records)) {
    const requirementId = requirement.requirementId;
    const config = { dataRoot: context.dataRoot, repoId: context.repoId, requirementId, authorize: () => true };
    if (!requirement.saved) {
      if (existsSync(prdRequirementPath(config))) await inRequirement(requirementId, () => keepMainReachable(config));
      continue;
    }
    const board = boards.has(requirementId) ? validBoard(boards.get(requirementId), requirementId) : undefined;
    const prototypeFiles = async (pick: (entry: PrototypeBoard["entries"][number]) => { version: number } | null | undefined) => {
      const changes: Record<string, Uint8Array> = {};
      for (const entry of board?.entries ?? []) {
        const staged = pick(entry);
        if (!staged) continue;
        const file = `${entry.name}.v${staged.version}.html`;
        changes[`prototypes/${file}`] = await readPrototypeFile(join(context.dataRoot, "repos", context.repoId, "prototypes", requirementId, file), entry.name);
      }
      return changes;
    };
    const migrate = async (key: string, expectedParent: string, changes: Record<string, Uint8Array>) => {
      if (Object.keys(changes).length === 0) return false;
      const { commit } = await inRequirement(requirementId, () => commitMigrationFiles({ ...config, expectedParent, changes }));
      commits.set(key, commit);
      return true;
    };
    const draftPick = (entry: PrototypeBoard["entries"][number]) => entry.removed ? undefined : entry.draft;
    const { approved, saved } = requirement;
    let migrated: boolean;
    if (requirement.lifecycle === "draft" || !approved) migrated = await migrate(requirementId, saved.commit, await prototypeFiles(draftPick));
    else {
      migrated = await migrate(requirementId, approved.commit, await prototypeFiles((entry) => entry.approved));
      if (approved.commit !== saved.commit) migrated = await migrate(tipKey(requirementId), saved.commit, await prototypeFiles((entry) => entry.removed ? undefined : entry.draft ?? entry.approved)) || migrated;
    }
    if (!migrated) await inRequirement(requirementId, () => keepMainReachable(config, true));
  }
  return commits;
}

type SaveAnchors = Map<string, { anchor: string; parent: string | null }>;
const saveKey = (requirementId: string, reference: PrdReference) => `${requirementId}:${reference.commit}:${reference.hash}`;

function createRootAnchors(records: MigrationRecords, commits: MigrationCommits): { roots: Map<string, string>; saves: SaveAnchors } {
  const roots = new Map<string, string>(), saves: SaveAnchors = new Map();
  for (const { version, data: requirement } of requirementsOf(records)) {
    const { saved, approved } = requirement;
    if (!saved) continue;
    let sequence = 0;
    let parent: string | null = null;
    const add = (kind: "save" | "approval", fileCommit: string, lineVersion: number, savedReference: PrdReference | null) => {
      const anchor = uuidv7();
      const record = checked(LineAnchorRecord, {
        format: "line-anchor/v1", repoId: requirement.repoId, requirementId: requirement.requirementId, anchor, parent, kind,
        lineVersion, sequence: ++sequence, fileCommit, saved: savedReference, createdAt: requirement.updatedAt,
      });
      records.create("line_anchors", anchor, record);
      if (savedReference) saves.set(saveKey(requirement.requirementId, savedReference), { anchor, parent });
      parent = anchor;
      if (sequence === 1) roots.set(requirement.requirementId, anchor);
    };
    if (requirement.lifecycle === "draft" || !approved) {
      add("save", commits.get(requirement.requirementId) ?? saved.commit, version, saved);
    }
    else {
      const approvedFiles = commits.get(requirement.requirementId) ?? approved.commit;
      if (approved.commit === saved.commit) { const lineVersion = version; add("save", approvedFiles, lineVersion, approved); add("approval", approvedFiles, lineVersion, null); }
      else { const lineVersion = version - 1; add("save", approvedFiles, lineVersion, approved); add("approval", approvedFiles, lineVersion, null); add("save", commits.get(tipKey(requirement.requirementId)) ?? saved.commit, version, saved); }
    }
  }
  return { roots, saves };
}

type Change = { kind: string } & Record<string, unknown>;

function boardChanges(board: PrototypeBoard): Change[] {
  const changes: Change[] = [];
  const begin = (name: string, version: number, runId = uuidv7(), agent = "migration", designBase: string | null = null) => {
    changes.push({ kind: "begin", name, version, runId, agent, designBase });
    return runId;
  };
  const stage = (name: string, file: { version: number; picked: unknown }) => {
    const runId = begin(name, file.version);
    changes.push({ kind: "submit", name, version: file.version, runId, file: { ...file, picked: null }, designs: null });
    changes.push({ kind: "accept", name, version: file.version, picked: file.picked });
  };
  for (const entry of board.entries) {
    if (entry.approved) stage(entry.name, entry.approved);
    else { begin(entry.name, entry.lastVersion); changes.push({ kind: "abandon", name: entry.name, version: entry.lastVersion }); }
  }
  if (board.entries.some((entry) => entry.approved)) changes.push({ kind: "approve" });
  for (const entry of board.entries) {
    let last = entry.approved?.version ?? entry.lastVersion;
    if (entry.lastEnded) {
      const runId = begin(entry.name, entry.lastEnded.version);
      changes.push({ kind: "end", name: entry.name, version: entry.lastEnded.version, runId, reason: entry.lastEnded.reason });
      last = entry.lastEnded.version;
    }
    if (entry.draft) { stage(entry.name, entry.draft); last = entry.draft.version; }
    if (entry.removed) changes.push({ kind: "remove", name: entry.name, version: entry.lastVersion });
    const inFlight = entry.inFlight;
    if (inFlight) {
      begin(entry.name, inFlight.version, inFlight.runId, inFlight.agent, inFlight.designBase);
      if (inFlight.status === "awaiting") {
        if (!inFlight.file) throw new Error(`原型「${entry.name}」在等确认，却没有交稿文件`);
        changes.push({ kind: "submit", name: entry.name, version: inFlight.version, runId: inFlight.runId, file: inFlight.file, designs: inFlight.designs });
      }
    } else if (last !== entry.lastVersion) {
      begin(entry.name, entry.lastVersion);
      changes.push({ kind: "abandon", name: entry.name, version: entry.lastVersion });
    }
    if (entry.lastOpinion) changes.push({ kind: "opinion", name: entry.name, ...entry.lastOpinion });
  }
  return changes;
}

function convertPrototypeBoards(records: MigrationRecords): void {
  for (const { key, data } of records.list("requirement_prototypes")) {
    const board = validBoard(data, key);
    boardChanges(board).forEach((change, index) => {
      records.create("prototype_changes", uuidv7(), { format: "prototype-change/v1", requirementId: key, seq: index + 1, at: board.updatedAt, ...change });
    });
    records.remove("requirement_prototypes", key);
  }
}

function migrateLineRecords(records: MigrationRecords, roots: Map<string, string>, saves: SaveAnchors): void {
  for (const { key, data } of records.list("requirement_summaries")) {
    records.create("requirement_summaries", `${key}:${(data as { prdHash: string }).prdHash}`, data);
    records.remove("requirement_summaries", key);
  }
  for (const operation of records.list("requirement_service_operations")) {
    const { requirementId, git, finalVersion } = operation.data as { requirementId: string; git: PrdReference | null; finalVersion: number | null };
    if (finalVersion !== null) continue;
    const save = git ? saves.get(saveKey(requirementId, { commit: git.commit, hash: git.hash })) : undefined;
    records.create("line_operation_anchors", operation.key, { format: "line-operation-anchor/v1", requirementId,
      anchor: save?.anchor ?? uuidv7(), unchangedTip: null, parent: save ? save.parent : roots.get(requirementId) ?? null });
  }
}

export const lineRecordsV10Step: DataMigrationStep = {
  from: 10,
  losses: ["这次迁移不会丢数据。"],
  prepareFiles: moveDraftPrototypesIntoRepos,
  migrate(records, prepared) {
    const { roots, saves } = createRootAnchors(records, prepared as MigrationCommits);
    convertPrototypeBoards(records);
    migrateLineRecords(records, roots, saves);
  },
};
