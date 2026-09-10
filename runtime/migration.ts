import { createHash } from "node:crypto";
import { lstat, readFile, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { repositoryIdentity, requirementIdentity, listWorktrees } from "./identity.ts";
import { writeFileAtomic } from "./store.ts";
import { repositoryDatabase, readRecord, putRecord, withDatabase } from "./database.ts";
import type { RecordRef } from "./database.ts";
import { requirementStateRef } from "./workflow-state.ts";
import { decisionStream } from "./decisions.ts";
import { currentBootId, processStartedAt } from "./windows.ts";
import { assertValidStage } from "./workflow-state.ts";
import type { RequirementState, TaskState } from "./workflow-state.ts";

const LEGACY_ROOT_SEGMENTS = [".pi-spec", "requirements"] as const;
const GLOBAL_PROBLEM_KINDS = new Set(["legacy-root-unreadable", "progress-unreadable", "definition-directory-conflict"]);

export interface MigrationSource {
  worktree: string;
  requirement: string;
  files: string[];
  status: string;
}

export interface MigrationProblem {
  requirement: string;
  kind: string;
  detail: string;
}

export interface MigrationPreflightResult {
  sources: MigrationSource[];
  problems: MigrationProblem[];
  fingerprint: string;
}

export interface MigrationApplyHooks {
  beforeVerify?: () => Promise<void>;
  beforeClear?: () => Promise<void>;
}

export interface MigrationApplyInput {
  cwd: string;
  dataRoot: string;
  authorized: boolean;
  legacyWritesStopped: boolean;
  expectedFingerprint: string;
  hasActiveWindows: () => Promise<boolean | null>;
  hooks?: MigrationApplyHooks;
}

export type MigrationApplyResult = { ok: true; migrated: string[] } | { ok: false; blocked: string[]; migrated: string[] };

export interface MigrationStatusResult {
  completed: string[];
  inProgress: string[];
  failed: Array<{ requirement: string; reason: string }>;
  remaining: string[];
}

interface LegacyTaskFile {
  fields: Record<string, string>;
}

interface LegacyIssue {
  kind: string;
  detail: string;
}

interface LegacyRequirementScan {
  worktree: string;
  requirement: string;
  dir: string;
  fileEntries: Array<{ path: string; content: string }>;
  requirementFields: Record<string, string>;
  tasks: LegacyTaskFile[];
  aiDecisions: unknown[];
  userDecisions: unknown[];
  aiDecisionsFileExists: boolean;
  userDecisionsFileExists: boolean;
  issues: LegacyIssue[];
}

interface ProgressEntry {
  status?: "written" | "verified" | "cleared";
  sourceFingerprint?: string;
  lastFailure?: { reason: string; at: string };
}

interface ProgressFile {
  requirements: Record<string, ProgressEntry>;
}

function parseFrontmatter(raw: string): { fields: Record<string, string> } {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(raw);
  if (!match) return { fields: {} };
  const frontmatter = match[1] ?? "";
  const fields: Record<string, string> = {};
  for (const line of frontmatter.split("\n")) {
    const kv = /^([A-Za-z_][A-Za-z0-9_]*):\s?(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1] as string;
    let value = (kv[2] ?? "").trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) value = value.slice(1, -1);
    fields[key] = value;
  }
  return { fields };
}

function canonicalStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalStringify(item)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalStringify((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function parseDecisionContent(content: string): { records: unknown[]; corrupted: boolean } {
  const records: unknown[] = [];
  let corrupted = false;
  for (const line of content.split("\n")) {
    if (line.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      corrupted = true;
      continue;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      corrupted = true;
      continue;
    }
    records.push(parsed);
  }
  return { records, corrupted };
}

async function tryReadFile(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

interface GatheredFiles {
  entries: Array<{ path: string; content: string }>;
  requirementContent: string | undefined;
  taskContents: string[];
  aiContent: string | undefined;
  userContent: string | undefined;
}

async function gatherLegacyFiles(dir: string): Promise<GatheredFiles> {
  const entries: Array<{ path: string; content: string }> = [];
  const reqPath = join(dir, "requirements.md");
  const requirementContent = await tryReadFile(reqPath);
  if (requirementContent !== undefined) entries.push({ path: reqPath, content: requirementContent });

  const tasksDir = join(dir, "tasks");
  let taskNames: string[] = [];
  try {
    taskNames = (await readdir(tasksDir)).filter((name) => name.endsWith(".md")).sort();
  } catch {
    taskNames = [];
  }
  const taskContents: string[] = [];
  for (const name of taskNames) {
    const path = join(tasksDir, name);
    const content = await tryReadFile(path);
    if (content === undefined) continue;
    entries.push({ path, content });
    taskContents.push(content);
  }

  const aiPath = join(dir, "ai-decisions.jsonl");
  const userPath = join(dir, "user-decisions.jsonl");
  const aiContent = await tryReadFile(aiPath);
  if (aiContent !== undefined) entries.push({ path: aiPath, content: aiContent });
  const userContent = await tryReadFile(userPath);
  if (userContent !== undefined) entries.push({ path: userPath, content: userContent });

  const acceptancePath = join(dir, "acceptance.md");
  const acceptanceContent = await tryReadFile(acceptancePath);
  if (acceptanceContent !== undefined) entries.push({ path: acceptancePath, content: acceptanceContent });

  return { entries, requirementContent, taskContents, aiContent, userContent };
}

async function scanLegacyRequirement(worktree: string, dir: string, reqId: string): Promise<LegacyRequirementScan> {
  const issues: LegacyIssue[] = [];
  try {
    requirementIdentity(reqId);
  } catch (error) {
    issues.push({ kind: "invalid-requirement-id", detail: (error as Error).message });
  }

  const gathered = await gatherLegacyFiles(dir);

  let requirementFields: Record<string, string> = {};
  if (gathered.requirementContent === undefined) {
    issues.push({ kind: "missing-requirements-md", detail: dir });
  } else {
    requirementFields = parseFrontmatter(gathered.requirementContent).fields;
    const status = requirementFields.status;
    if (status !== undefined) {
      try {
        assertValidStage(status);
      } catch {
        issues.push({ kind: "unknown-status", detail: status });
      }
    }
  }

  const tasks = gathered.taskContents.map((content) => parseFrontmatter(content));
  for (const task of tasks) {
    if (!task.fields.id) issues.push({ kind: "task-missing-id", detail: dir });
  }

  const aiScan = parseDecisionContent(gathered.aiContent ?? "");
  const userScan = parseDecisionContent(gathered.userContent ?? "");
  if (aiScan.corrupted) issues.push({ kind: "corrupted-line", detail: join(dir, "ai-decisions.jsonl") });
  if (userScan.corrupted) issues.push({ kind: "corrupted-line", detail: join(dir, "user-decisions.jsonl") });

  return {
    worktree,
    requirement: reqId,
    dir,
    fileEntries: gathered.entries,
    requirementFields,
    tasks,
    aiDecisions: aiScan.records,
    userDecisions: userScan.records,
    aiDecisionsFileExists: gathered.aiContent !== undefined,
    userDecisionsFileExists: gathered.userContent !== undefined,
    issues,
  };
}

interface ScanOutcome {
  scans: LegacyRequirementScan[];
  rootIssues: MigrationProblem[];
}

async function scanRepository(cwd: string): Promise<ScanOutcome> {
  const worktrees = await listWorktrees(cwd);
  const scans: LegacyRequirementScan[] = [];
  const rootIssues: MigrationProblem[] = [];
  for (const worktree of worktrees) {
    const legacyRoot = join(worktree, ...LEGACY_ROOT_SEGMENTS);
    let reqIds: string[] = [];
    try {
      reqIds = (await readdir(legacyRoot, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        rootIssues.push({ requirement: worktree, kind: "legacy-root-unreadable", detail: (error as Error).message });
      }
      reqIds = [];
    }
    for (const reqId of reqIds) {
      scans.push(await scanLegacyRequirement(worktree, join(legacyRoot, reqId), reqId));
    }
  }
  return { scans, rootIssues };
}

async function computeFingerprint(entries: Array<{ path: string; content: string }>): Promise<string> {
  const sorted = [...entries].sort((a, b) => a.path.localeCompare(b.path));
  const hash = createHash("sha256");
  for (const entry of sorted) {
    hash.update(entry.path);
    hash.update(" ");
    hash.update(entry.content);
    hash.update(" ");
  }
  return hash.digest("hex");
}

export function dedupeDecisions(records: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const seen = new Set<string>();
  const unique: Array<Record<string, unknown>> = [];
  for (const record of records) {
    const key = canonicalStringify(record);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(record);
  }
  return unique;
}

function conflictingIds(records: Array<Record<string, unknown>>): string[] {
  const byId = new Map<string, Set<string>>();
  for (const record of records) {
    const id = (record as { id?: unknown }).id;
    if (id === undefined) continue;
    const key = String(id);
    const contents = byId.get(key) ?? new Set<string>();
    contents.add(canonicalStringify(record));
    byId.set(key, contents);
  }
  return [...byId.entries()].filter(([, contents]) => contents.size > 1).map(([id]) => id);
}

async function buildPreflightResult(scans: LegacyRequirementScan[]): Promise<MigrationPreflightResult> {
  const sources: MigrationSource[] = scans.map((scan) => ({
    worktree: scan.worktree,
    requirement: scan.requirement,
    files: scan.fileEntries.map((entry) => entry.path),
    status: scan.requirementFields.status ?? "",
  }));

  const problems: MigrationProblem[] = [];
  const byRequirement = new Map<string, LegacyRequirementScan[]>();
  for (const scan of scans) {
    const list = byRequirement.get(scan.requirement) ?? [];
    list.push(scan);
    byRequirement.set(scan.requirement, list);
  }

  for (const [reqId, group] of byRequirement) {
    for (const scan of group) {
      for (const issue of scan.issues) {
        problems.push({ requirement: reqId, kind: issue.kind, detail: issue.detail });
      }
    }

    const statusSet = new Set(group.map((scan) => scan.requirementFields.status ?? ""));
    if (statusSet.size > 1) {
      problems.push({ requirement: reqId, kind: "requirement-status-conflict", detail: [...statusSet].join(",") });
    }

    const aiConflicts = conflictingIds(group.flatMap((scan) => scan.aiDecisions) as Array<Record<string, unknown>>);
    if (aiConflicts.length > 0) problems.push({ requirement: reqId, kind: "decision-conflict", detail: aiConflicts.join(",") });
    const userConflicts = conflictingIds(group.flatMap((scan) => scan.userDecisions) as Array<Record<string, unknown>>);
    if (userConflicts.length > 0) problems.push({ requirement: reqId, kind: "decision-conflict", detail: userConflicts.join(",") });

    const taskSignatures = new Map<string, Set<string>>();
    for (const scan of group) {
      for (const task of scan.tasks) {
        const id = task.fields.id ?? "";
        const signature = JSON.stringify({
          status: task.fields.status,
          step: task.fields.step,
          agent: task.fields.agent,
          commit: task.fields.commit,
          note: task.fields.note,
        });
        const set = taskSignatures.get(id) ?? new Set<string>();
        set.add(signature);
        taskSignatures.set(id, set);
      }
    }
    for (const [taskId, signatures] of taskSignatures) {
      if (signatures.size > 1) problems.push({ requirement: reqId, kind: "task-phase-conflict", detail: taskId });
    }
  }

  const fingerprint = await computeFingerprint(scans.flatMap((scan) => scan.fileEntries));
  return { sources, problems, fingerprint };
}

async function progressRef(dataRoot: string, cwd: string): Promise<RecordRef> {
  const identity = await repositoryIdentity(cwd);
  return { database: repositoryDatabase(dataRoot, identity.repoId), namespace: "migration", key: "progress" };
}

interface ReadProgressResult {
  progress: ProgressFile;
  unreadable: boolean;
  detail?: string;
}

async function readProgress(ref: RecordRef): Promise<ReadProgressResult> {
  try {
    const record = readRecord<ProgressFile>(ref);
    if (!record.exists) return { progress: { requirements: {} }, unreadable: false };
    const value = record.data;
    if (!value || typeof value !== "object" || Array.isArray(value) || !value.requirements || typeof value.requirements !== "object" || Array.isArray(value.requirements)) throw new Error("迁移进度结构无效");
    for (const entry of Object.values(value.requirements) as ProgressEntry[]) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)
        || (entry.status !== undefined && !["written", "verified", "cleared"].includes(entry.status))
        || (entry.sourceFingerprint !== undefined && typeof entry.sourceFingerprint !== "string")
        || (entry.lastFailure !== undefined && (!entry.lastFailure || typeof entry.lastFailure.reason !== "string" || typeof entry.lastFailure.at !== "string"))) throw new Error("迁移进度条目无效");
    }
    return { progress: value, unreadable: false };
  } catch (error) {
    return { progress: { requirements: {} }, unreadable: true, detail: (error as Error).message };
  }
}

async function writeProgress(ref: RecordRef, data: ProgressFile): Promise<void> {
  putRecord(ref, data);
}

async function computeFullPreflight(
  input: { cwd: string; dataRoot: string },
): Promise<{ scans: LegacyRequirementScan[]; preflight: MigrationPreflightResult }> {
  const { scans, rootIssues } = await scanRepository(input.cwd);
  const preflight = await buildPreflightResult(scans);
  preflight.problems.push(...rootIssues);
  for (const worktree of await listWorktrees(input.cwd)) {
    const legacy = join(worktree, ".pi-spec");
    const target = join(worktree, ".pi-company");
    const exists = async (path: string) => lstat(path).then(() => true, (error) => { if (error.code === "ENOENT") return false; throw error; });
    if (await exists(legacy) && await exists(target)) preflight.problems.push({ requirement: "", kind: "definition-directory-conflict", detail: `定义目录同时存在，无法安全迁移: ${legacy} → ${target}` });
  }


  const identity = await repositoryIdentity(input.cwd);
  const progFile = await progressRef(input.dataRoot, input.cwd);
  const progressResult = await readProgress(progFile);
  if (progressResult.unreadable) {
    preflight.problems.push({
      requirement: "",
      kind: "progress-unreadable",
      detail: `迁移进度无法读取: ${progressResult.detail ?? ""}`,
    });
  }
  const progress = progressResult.progress;
  const requirementIds = [...new Set(scans.map((scan) => scan.requirement))];
  for (const reqId of requirementIds) {
    if (progress.requirements[reqId]) continue;
    let statePath: RecordRef;
    try {
      statePath = requirementStateRef(input.dataRoot, identity.repoId, reqId);
    } catch {
      continue;
    }
    const doc = await readRecord(statePath);
    if (!doc.exists) continue;
    if (!hasMigrationHistory(doc.data as RequirementState)) {
      preflight.problems.push({ requirement: reqId, kind: "target-state-exists", detail: reqId });
    }
  }

  return { scans, preflight };
}

export async function migrationPreflight(input: { cwd: string; dataRoot: string }): Promise<MigrationPreflightResult> {
  const { preflight } = await computeFullPreflight(input);
  return preflight;
}

async function assertLedgerContains(
  dataRoot: string,
  repoId: string,
  reqId: string,
  actor: "ai" | "user",
  expected: Array<Record<string, unknown>>,
): Promise<void> {
  const actual = withDatabase(repositoryDatabase(dataRoot, repoId), (db) => db.events(decisionStream(reqId, actor)).map((event) => event.data));
  const actualKeys = new Set(actual.map((record) => canonicalStringify(record)));
  for (const record of expected) {
    if (!actualKeys.has(canonicalStringify(record))) {
      throw new Error(`决策记录核对失败: ${actor}`);
    }
  }
}

function resolveStage(group: LegacyRequirementScan[]): string {
  return group[0]?.requirementFields.status ?? "";
}

function buildTaskState(fields: Record<string, string>): TaskState {
  return {
    progress: fields.status ?? "todo",
    runId: null,
    description: "",
    agent: fields.agent ?? "",
    note: fields.note ?? "",
    commit: fields.commit ?? null,
    reason: "",
    repairRound: 0,
    blockedReason: "",
    workspaceDir: "",
  };
}

function buildRequirementStateData(reqId: string, stage: string, group: LegacyRequirementScan[]): RequirementState {
  const tasks: Record<string, TaskState> = {};
  for (const scan of group) {
    for (const task of scan.tasks) {
      const id = task.fields.id;
      if (!id || tasks[id]) continue;
      tasks[id] = buildTaskState(task.fields);
    }
  }
  const sourceWorktree = group[0]?.worktree ?? "";
  return {
    requirement: reqId,
    stage,
    shape: null,
    tasks,
    followUps: [],
    history: [{ stage, at: new Date().toISOString(), runId: null, decisionId: null, reason: `migrated from ${sourceWorktree}` }],
  };
}

function hasMigrationHistory(data: RequirementState): boolean {
  return !!data && Array.isArray(data.history) && data.history.some((entry) => entry && typeof entry.reason === "string" && entry.reason.startsWith("migrated from"));
}

function isSourceAlreadyCleared(group: LegacyRequirementScan[]): boolean {
  return group.every(
    (scan) => scan.requirementFields.status === undefined && !scan.aiDecisionsFileExists && !scan.userDecisionsFileExists,
  );
}

async function writeTargets(dataRoot: string, repoId: string, reqId: string, group: LegacyRequirementScan[]): Promise<void> {
  const state = buildRequirementStateData(reqId, resolveStage(group), group);
  const ledgers = { ai: dedupeDecisions(group.flatMap((scan) => scan.aiDecisions) as Array<Record<string, unknown>>), user: dedupeDecisions(group.flatMap((scan) => scan.userDecisions) as Array<Record<string, unknown>>) };
  withDatabase(repositoryDatabase(dataRoot, repoId), (db) => db.transaction(() => {
    const existing = db.read("requirements", reqId);
    if (existing) db.update("requirements", reqId, existing.version, state);
    else db.create("requirements", reqId, state);
    for (const actor of ["ai", "user"] as const) {
      const stream = decisionStream(reqId, actor);
      const known = new Set(db.events(stream).map((event) => canonicalStringify(event.data)));
      for (const record of ledgers[actor]) {
        const key = canonicalStringify(record);
        if (!known.has(key)) { db.append(stream, record); known.add(key); }
      }
    }
  }));
}

async function verifyTargets(dataRoot: string, repoId: string, reqId: string, group: LegacyRequirementScan[]): Promise<void> {
  const stage = resolveStage(group);
  const statePath = requirementStateRef(dataRoot, repoId, reqId);
  const doc = await readRecord(statePath);
  if (!doc.exists) throw new Error(`需求状态未写入: ${reqId}`);
  const data = doc.data as RequirementState;
  if (data.stage !== stage) throw new Error(`阶段核对失败: ${reqId}`);

  const expected = buildRequirementStateData(reqId, stage, group);
  for (const [taskId, expectedTask] of Object.entries(expected.tasks)) {
    const actualTask = data.tasks[taskId];
    if (
      !actualTask ||
      actualTask.progress !== expectedTask.progress ||
      (actualTask.agent ?? "") !== expectedTask.agent ||
      (actualTask.commit ?? null) !== expectedTask.commit ||
      (actualTask.note ?? "") !== expectedTask.note
    ) {
      throw new Error(`任务字段核对失败: ${reqId} ${taskId}`);
    }
  }

  const ai = dedupeDecisions(group.flatMap((scan) => scan.aiDecisions) as Array<Record<string, unknown>>);
  const user = dedupeDecisions(group.flatMap((scan) => scan.userDecisions) as Array<Record<string, unknown>>);
  await assertLedgerContains(dataRoot, repoId, reqId, "ai", ai);
  await assertLedgerContains(dataRoot, repoId, reqId, "user", user);
}

async function assertSourceStillMatchesTarget(
  dataRoot: string,
  repoId: string,
  reqId: string,
  group: LegacyRequirementScan[],
): Promise<void> {
  const statePath = requirementStateRef(dataRoot, repoId, reqId);
  const doc = await readRecord(statePath);
  if (!doc.exists) throw new Error(`需求状态未写入: ${reqId}`);
  const data = doc.data as RequirementState;
  for (const scan of group) {
    const status = scan.requirementFields.status;
    if (status !== undefined && status !== data.stage) {
      throw new Error(`源在核对后被修改，需重新预检: ${reqId}（需求阶段）`);
    }
    for (const task of scan.tasks) {
      const id = task.fields.id;
      if (!id || task.fields.status === undefined) continue;
      const target = data.tasks[id];
      const expected = buildTaskState(task.fields);
      if (
        !target ||
        target.progress !== expected.progress ||
        (target.agent ?? "") !== expected.agent ||
        (target.commit ?? null) !== expected.commit ||
        (target.note ?? "") !== expected.note
      ) {
        throw new Error(`源在核对后被修改，需重新预检: ${reqId} ${id}`);
      }
    }
  }
}

const TASK_REMOVE_KEYS = ["status", "step", "agent", "commit", "note", "parallel"];
const REQUIREMENT_REMOVE_KEYS = ["status"];

async function stripFrontmatterKeys(path: string, keysToRemove: string[]): Promise<void> {
  const raw = await readFile(path, "utf8");
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(raw);
  if (!match) return;
  const frontmatter = match[1] ?? "";
  const body = match[2] ?? "";
  const keptLines = frontmatter.split("\n").filter((line) => {
    const key = /^([A-Za-z_][A-Za-z0-9_]*):/.exec(line)?.[1];
    return key === undefined || !keysToRemove.includes(key);
  });
  await writeFileAtomic(path, `---\n${keptLines.join("\n")}\n---\n${body}`);
}

export async function clearMigratedSourceFields(input: { requirementDir: string }): Promise<void> {
  await stripFrontmatterKeys(join(input.requirementDir, "requirements.md"), REQUIREMENT_REMOVE_KEYS);

  const tasksDir = join(input.requirementDir, "tasks");
  let taskNames: string[] = [];
  try {
    taskNames = (await readdir(tasksDir)).filter((name) => name.endsWith(".md"));
  } catch {
    taskNames = [];
  }
  for (const name of taskNames) {
    await stripFrontmatterKeys(join(tasksDir, name), TASK_REMOVE_KEYS);
  }

  await rm(join(input.requirementDir, "ai-decisions.jsonl"), { force: true });
  await rm(join(input.requirementDir, "user-decisions.jsonl"), { force: true });
}

async function migrateOneRequirement(
  input: MigrationApplyInput,
  repoId: string,
  reqId: string,
  group: LegacyRequirementScan[],
  progress: ProgressFile,
): Promise<void> {
  const entry = progress.requirements[reqId];
  if (entry?.status === "cleared") return;

  if (!entry?.status && isSourceAlreadyCleared(group)) {
    const statePath = requirementStateRef(input.dataRoot, repoId, reqId);
    const doc = await readRecord(statePath);
    if (doc.exists && hasMigrationHistory(doc.data as RequirementState)) {
      progress.requirements[reqId] = { status: "cleared" };
      return;
    }
  }

  const fingerprint = await computeFingerprint(group.flatMap((scan) => scan.fileEntries));
  if (entry?.status === "written" && entry.sourceFingerprint !== fingerprint) {
    throw new Error(`源已变化，需重新预检: ${reqId}`);
  }

  if (!entry?.status) {
    await writeTargets(input.dataRoot, repoId, reqId, group);
    progress.requirements[reqId] = { ...entry, status: "written", sourceFingerprint: fingerprint };
  }

  if (progress.requirements[reqId]?.status === "written") {
    if (input.hooks?.beforeVerify) await input.hooks.beforeVerify();
    await verifyTargets(input.dataRoot, repoId, reqId, group);
    progress.requirements[reqId] = { ...progress.requirements[reqId], status: "verified", sourceFingerprint: fingerprint };
  }

  if (progress.requirements[reqId]?.status === "verified") {
    if (input.hooks?.beforeClear) await input.hooks.beforeClear();
    await assertSourceStillMatchesTarget(input.dataRoot, repoId, reqId, group);
    for (const scan of group) {
      await clearMigratedSourceFields({ requirementDir: scan.dir });
    }
    progress.requirements[reqId] = { ...progress.requirements[reqId], status: "cleared", sourceFingerprint: fingerprint };
  }
}

async function applyRequirements(
  input: MigrationApplyInput,
  scans: LegacyRequirementScan[],
  problemRequirements: Map<string, MigrationProblem[]>,
): Promise<MigrationApplyResult> {
  const identity = await repositoryIdentity(input.cwd);
  const progFile = await progressRef(input.dataRoot, input.cwd);
  const progress = (await readProgress(progFile)).progress;

  const requirementIds = [...new Set(scans.map((scan) => scan.requirement))];
  const migrated: string[] = [];
  const blocked: string[] = [];

  for (const reqId of requirementIds) {
    const problems = problemRequirements.get(reqId);
    if (problems && problems.length > 0) {
      blocked.push(`需求 ${reqId} 存在问题，已跳过: ${problems.map((p) => `${p.kind}(${p.detail})`).join("; ")}`);
      continue;
    }
    const group = scans.filter((scan) => scan.requirement === reqId);
    try {
      await migrateOneRequirement(input, identity.repoId, reqId, group, progress);
      migrated.push(reqId);
      const successEntry = progress.requirements[reqId];
      if (successEntry) delete successEntry.lastFailure;
    } catch (error) {
      const current = progress.requirements[reqId] ?? {};
      current.lastFailure = { reason: (error as Error).message, at: new Date().toISOString() };
      progress.requirements[reqId] = current;
      blocked.push(`需求 ${reqId} 迁移中断: ${current.lastFailure.reason}`);
    } finally {
      await writeProgress(progFile, progress);
    }
  }

  if (blocked.length > 0) return { ok: false, blocked, migrated };
  return { ok: true, migrated };
}

async function checkActiveWindows(probe: () => Promise<boolean | null>): Promise<boolean | null> {
  try {
    return await probe();
  } catch {
    return null;
  }
}

async function applyMigration(input: MigrationApplyInput): Promise<MigrationApplyResult> {
  const blocked: string[] = [];
  if (!input.authorized) blocked.push("未授权");
  if (!input.legacyWritesStopped) blocked.push("旧写入方式未切换");
  const activeWindows = await checkActiveWindows(input.hasActiveWindows);
  if (activeWindows !== false) blocked.push("存在或无法确认活动窗口");

  const { scans, preflight } = await computeFullPreflight({ cwd: input.cwd, dataRoot: input.dataRoot });
  if (preflight.fingerprint !== input.expectedFingerprint) blocked.push("预检指纹已变化，需重新预检");
  for (const problem of preflight.problems) {
    if (GLOBAL_PROBLEM_KINDS.has(problem.kind)) {
      blocked.push(`存在问题（${problem.kind}）: ${problem.detail}`);
    }
  }

  if (blocked.length > 0) return { ok: false, blocked, migrated: [] };

  const problemRequirements = new Map<string, MigrationProblem[]>();
  for (const problem of preflight.problems) {
    if (GLOBAL_PROBLEM_KINDS.has(problem.kind)) continue;
    const list = problemRequirements.get(problem.requirement) ?? [];
    list.push(problem);
    problemRequirements.set(problem.requirement, list);
  }

  const applied = await applyRequirements(input, scans, problemRequirements);
  if (!applied.ok) return applied;
  try {
    if (await checkActiveWindows(input.hasActiveWindows) !== false) throw new Error("迁移定义目录前存在或无法确认活动写入者");
    for (const worktree of await listWorktrees(input.cwd)) {
      const legacy = join(worktree, ".pi-spec");
      const target = join(worktree, ".pi-company");
      try { await lstat(legacy); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
      try { await lstat(target); throw new Error(`迁移目标目录已存在: ${target}`); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      await rename(legacy, target);
    }
  } catch (error) { return { ok: false, migrated: applied.migrated, blocked: [`定义目录迁移未完成: ${(error as Error).message}`] }; }
  return applied;
}

export async function migrationApply(input: MigrationApplyInput): Promise<MigrationApplyResult> {
  if (!input.authorized || !input.legacyWritesStopped) return { ok: false, migrated: [], blocked: [!input.authorized ? "未授权" : "旧写入方式未切换"] };
  const ref = await progressRef(input.dataRoot, input.cwd);
  const bootId = await currentBootId();
  const startedAt = await processStartedAt(process.pid);
  if (!startedAt) return { ok: false, migrated: [], blocked: ["无法核对迁移进程身份"] };
  const existing = readRecord<{ pid: number; bootId: string; startedAt: string }>({ ...ref, key: "owner" });
  if (existing.exists && existing.data.bootId === bootId && await processStartedAt(existing.data.pid) === existing.data.startedAt) {
    return { ok: false, migrated: [], blocked: ["已有迁移正在运行"] };
  }
  let owner: { id: string } | undefined;
  try {
    owner = withDatabase(ref.database, (db) => db.transaction(() => {
      const current = db.read("migration", "owner");
      if (current && (!existing.exists || current.id !== existing.id || current.version !== existing.version)) throw new Error("迁移占用已变化，请重试");
      if (current) db.remove("migration", "owner", current.version);
      return db.create("migration", "owner", { pid: process.pid, bootId, startedAt });
    }));
    return await applyMigration(input);
  } finally {
    if (owner) withDatabase(ref.database, (db) => db.transaction(() => {
      const current = db.read("migration", "owner");
      if (current && current.id === owner!.id) db.remove("migration", "owner", current.version);
    }));
  }
}

export const resumeMigration = migrationApply;

export async function migrationStatus(input: { cwd: string; dataRoot: string }): Promise<MigrationStatusResult> {
  const identity = await repositoryIdentity(input.cwd);
  const progFile = await progressRef(input.dataRoot, input.cwd);
  const progressResult = await readProgress(progFile);
  const progress = progressResult.progress;

  const completed = new Set<string>();
  const inProgress: string[] = [];
  const failed: Array<{ requirement: string; reason: string }> = progressResult.unreadable ? [{ requirement: "", reason: progressResult.detail ?? "迁移进度不可读" }] : [];
  for (const [reqId, entry] of Object.entries(progress.requirements)) {
    if (entry.status === "cleared") completed.add(reqId);
    else if (entry.status === "written" || entry.status === "verified") inProgress.push(reqId);
    if (entry.lastFailure) failed.push({ requirement: reqId, reason: entry.lastFailure.reason });
  }

  const { scans } = await scanRepository(input.cwd);
  const allRequirementIds = [...new Set(scans.map((scan) => scan.requirement))];
  for (const worktree of await listWorktrees(input.cwd)) {
    let entries;
    try { entries = await readdir(join(worktree, ".pi-company", "requirements"), { withFileTypes: true }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      failed.push({ requirement: "", reason: `定义目录不可读: ${(error as Error).message}` });
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        const doc = await readRecord(requirementStateRef(input.dataRoot, identity.repoId, entry.name));
        if (doc.exists && hasMigrationHistory(doc.data as RequirementState)) completed.add(entry.name);
      } catch (error) { failed.push({ requirement: entry.name, reason: (error as Error).message }); }
    }
  }

  for (const reqId of allRequirementIds) {
    if (completed.delete(reqId) && !inProgress.includes(reqId)) inProgress.push(reqId);
  }
  const remaining = allRequirementIds.filter((reqId) => !completed.has(reqId));

  return { completed: [...completed], inProgress, failed, remaining };
}
