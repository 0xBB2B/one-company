import { lstatSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isPromise } from "node:util/types";
import { assertDatabasePathReady, assertRegularDatabaseFiles, DATABASE_APPLICATION_IDS } from "./database-paths.ts";
import { createTransactionOrigin, finishTransactionOrigin, hasInvalidTransactionOrigin, invalidateTransactionOrigin, observeRejectedPromise, runOutsideTransactionOrigin, runWithTransactionOrigin, transactionOriginHasAsyncWork } from "./transaction-context.ts";
import { repositoryIdentity, requirementIdentity } from "./identity.ts";
import { RunStore } from "./run-store.ts";
import { createRecord, readRecord, StaleVersionError, writeRecord, putRecord, repositoryDatabase, withDatabase } from "./database.ts";
import type { RecordRef, SyncResult } from "./database.ts";
import { UUID_V7_PATTERN } from "./database.ts";
import { LEGACY_WORKFLOW_RETIRED } from "./decision-record-tool.ts";

export interface WorkflowContext { dataRoot: string; cwd: string; requirement: string }
export interface DefinitionVersion { definitionFingerprint: string; codeHead: string }
export interface TaskState {
  progress: string; runId: string | null; description: string; agent: string; note: string;
  commit: string | null; reason: string; repairRound: number; blockedReason: string; workspaceDir: string;
  [key: string]: unknown;
}
export interface ShapeGates { plan: boolean; whiteboxReview: boolean; blackboxAcceptance: boolean }
export interface ShapeSkip { gate: string; decisionId: string }
export interface RequirementShape {
  tasks: Array<{ id: string; roles: string[] }>;
  gates: ShapeGates; skipped: ShapeSkip[]; acceptanceReport: string | null; decisionId: string;
}
export interface HistoryEntry { stage: string; at: string; runId: string | null; decisionId: string | null; reason: string | null }
export interface RequirementState {
  requirement: string; stage: string; shape: RequirementShape | null; tasks: Record<string, TaskState>;
  followUps: unknown[]; history: HistoryEntry[];
}
export type ActionResult = { ok: true; version: number } | { ok: false; reason: string; staleVersion?: true };
function failureFromError(error: unknown): { ok: false; reason: string; staleVersion?: true } {
  if (error instanceof StaleVersionError) return { ok: false, reason: "版本已变化", staleVersion: true };
  return { ok: false, reason: "旧需求状态不可读或操作失败" };
}
export const VALID_STAGES = ["draft", "confirmed", "planned", "executing", "reviewing", "accepting", "accepted", "rejected"] as const;
export const VALID_TASK_PROGRESS = ["todo", "doing", "done", "failed"] as const;
export const STAGE_ORDER = ["draft", "confirmed", "planned", "executing", "reviewing", "accepting", "accepted"] as const;
export function assertValidStage(stage: string): void {
  if (!(VALID_STAGES as readonly string[]).includes(stage)) throw new Error(`不合法的阶段: ${stage}`);
}
export function assertValidTaskProgress(progress: string): void {
  if (!(VALID_TASK_PROGRESS as readonly string[]).includes(progress)) throw new Error(`不合法的任务进度: ${progress}`);
}
export function requirementStateRef(dataRoot: string, repoId: string, requirement: string): RecordRef {
  assertLegacyRequirementId(requirement);
  return { database: repositoryDatabase(dataRoot, repoId), namespace: "requirements", key: requirement };
}
function stateRef(ctx: WorkflowContext, repoId: string): RecordRef { return requirementStateRef(ctx.dataRoot, repoId, ctx.requirement); }
function evidenceRef(ctx: WorkflowContext, repoId: string, stage: string): RecordRef {
  return { database: repositoryDatabase(ctx.dataRoot, repoId), namespace: `evidence:${ctx.requirement}`, key: stage };
}
export function assertLegacyRequirementId(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length > 128) throw new Error("旧需求身份无效");
  try { requirementIdentity(value); } catch { throw new Error("旧需求身份无效"); }
}

/** 现存运行库的SQLite只读连接：不创建主库/目录、不升级或chmod；WAL附属文件按驱动读协议管理。 */
export function withLegacyReadDatabase<T>(path: string, read: (db: DatabaseSync) => T & SyncResult<T>): T {
  if (hasInvalidTransactionOrigin()) throw new Error("运行库不可读");
  const check = () => {
    assertDatabasePathReady(path);
    assertRegularDatabaseFiles(path);
    const dir = lstatSync(dirname(path));
    if (!dir.isDirectory() || dir.isSymbolicLink() || (dir.mode & 0o077) || (process.getuid && dir.uid !== process.getuid())) throw new Error("运行库权限无效");
    for (const suffix of ["", "-wal", "-shm"]) {
      const stat = lstatSync(path + suffix, { throwIfNoEntry: false });
      if (!stat && suffix === "") throw new Error("运行库尚未初始化");
      if (stat && (stat.mode & 0o077)) throw new Error("运行库权限无效");
    }
    return lstatSync(path);
  };
  try {
    const before = check();
    const db = new DatabaseSync(path, { readOnly: true, allowExtension: false });
    const origin = createTransactionOrigin();
    try {
      db.exec("PRAGMA query_only = ON; PRAGMA busy_timeout = 5000; BEGIN");
      if (Number(db.prepare("PRAGMA application_id").get()?.application_id) !== DATABASE_APPLICATION_IDS.data || Number(db.prepare("PRAGMA user_version").get()?.user_version) !== 1) throw new Error("运行库身份无效");
      let result!: T;
      let nativePromise = false;
      let then: unknown;
      let callbackFailed = false;
      let callbackError: unknown;
      try {
        runWithTransactionOrigin(origin, () => {
          result = read(db);
          nativePromise = isPromise(result);
          then = !nativePromise && result != null ? (result as { then?: unknown }).then : undefined;
        });
      } catch (error) { callbackFailed = true; callbackError = error; }
      if (transactionOriginHasAsyncWork(origin) || nativePromise || typeof then === "function") {
        invalidateTransactionOrigin(origin);
        if (nativePromise) observeRejectedPromise(result as Promise<unknown>);
        else if (typeof then === "function") runOutsideTransactionOrigin(() => {
          const drained = new Promise((resolve, reject) => {
            runWithTransactionOrigin(origin, () => Reflect.apply(then as Function, result, [resolve, reject]));
          });
          void drained.catch(() => {});
        });
        throw new Error("运行库读取必须同步完成");
      }
      if (callbackFailed) throw callbackError;
      const after = check();
      if (before.dev !== after.dev || before.ino !== after.ino) throw new Error("运行库身份已变化");
      return result;
    } finally { finishTransactionOrigin(origin); db.close(); }
  } catch { throw new Error("运行库尚未初始化、不可读或需要维护核对"); }
}

export function checkedRequirement(value: unknown, requirement: string): RequirementState {
  assertLegacyRequirementId(requirement);
  const data = value as RequirementState | null;
  if (!data || typeof data !== "object" || Array.isArray(data) || data.requirement !== requirement
    || !(VALID_STAGES as readonly string[]).includes(data.stage) || !data.tasks || typeof data.tasks !== "object" || Array.isArray(data.tasks)
    || !Array.isArray(data.history) || !Array.isArray(data.followUps) || !(data.shape === null || (typeof data.shape === "object" && !Array.isArray(data.shape)))) throw new Error("需求状态结构无效");
  return data;
}

/** 仅供既有证据保护基础登记空草稿，不产生批准或执行权限。 */
export async function initRequirementState(ctx: WorkflowContext): Promise<ActionResult> {
  const identity = await repositoryIdentity(ctx.cwd);
  const initial: RequirementState = { requirement: ctx.requirement, stage: "draft", shape: null, tasks: {}, followUps: [], history: [] };
  try { const { version } = createRecord(stateRef(ctx, identity.repoId), initial); return { ok: true, version }; }
  catch (error) { return failureFromError(error); }
}
export async function readRequirementState(ctx: WorkflowContext): Promise<{ exists: false } | { exists: true; version: number; data: RequirementState }> {
  const identity = await repositoryIdentity(ctx.cwd);
  assertLegacyRequirementId(ctx.requirement);
  return withLegacyReadDatabase(repositoryDatabase(ctx.dataRoot, identity.repoId), (db) => {
    const row = db.prepare("SELECT id, version, data FROM records WHERE namespace = 'requirements' AND record_key = ?").get(ctx.requirement);
    if (!row) return { exists: false as const };
    if (typeof row.id !== "string" || !UUID_V7_PATTERN.test(row.id) || !Number.isSafeInteger(row.version) || Number(row.version) < 1 || typeof row.data !== "string") throw new Error("需求记录无效");
    return { exists: true as const, version: Number(row.version), data: checkedRequirement(JSON.parse(row.data), ctx.requirement) };
  });
}

function retired(): { ok: false; reason: string } { return { ok: false, reason: LEGACY_WORKFLOW_RETIRED }; }
interface AdvanceInput { expectedVersion: number; targetStage: string; decisionId?: string; runId?: string; currentVersion?: DefinitionVersion }
export async function advanceStage(_input: AdvanceInput, _ctx: WorkflowContext): Promise<ActionResult> { return retired(); }
export async function retreatStage(_input: { expectedVersion: number; targetStage: string; reason: string; decisionId?: string; runId?: string }, _ctx: WorkflowContext): Promise<ActionResult> { return retired(); }
export async function recordShape(_input: { expectedVersion: number; shape: RequirementShape }, _ctx: WorkflowContext): Promise<ActionResult> { return retired(); }
export function skippedGates(_shape: RequirementShape | null): ShapeSkip[] { return []; }
export async function updateTaskFields(_input: { expectedVersion: number; taskId?: string; fields?: Record<string, unknown>; followUps?: unknown[] }, _ctx: WorkflowContext): Promise<ActionResult> { return retired(); }
export async function startTask(_input: { expectedVersion: number; taskId: string; runId: string }, _ctx: WorkflowContext): Promise<ActionResult> { return retired(); }
export async function finishTask(_input: { expectedVersion: number; taskId: string; runId: string; currentVersion: DefinitionVersion }, _ctx: WorkflowContext): Promise<ActionResult> { return retired(); }
export async function rollbackTask(_input: { expectedVersion: number; taskId: string; decisionId?: string }, _ctx: WorkflowContext): Promise<ActionResult> { return retired(); }
export async function rejectRequirement(_input: { expectedVersion: number; decisionId?: string }, _ctx: WorkflowContext): Promise<ActionResult> { return retired(); }
export async function checkResume(_ctx: WorkflowContext, _currentVersion?: DefinitionVersion): Promise<{ ok: true; stage: string; version: number } | { ok: false; reason: string }> { return retired(); }

/** 记录真实失败只减权限；不经模型公开变更入口调用。 */
export async function failTask(input: { expectedVersion: number; taskId: string; runId: string; reason: string }, ctx: WorkflowContext): Promise<ActionResult> {
  const identity = await repositoryIdentity(ctx.cwd);
  try {
    const current = readRecord(stateRef(ctx, identity.repoId));
    if (!current.exists) return { ok: false, reason: "需求状态不存在" };
    const data = checkedRequirement(current.data, ctx.requirement);
    const task = data.tasks[input.taskId];
    if (!task || task.progress !== "doing" || task.runId !== input.runId) return { ok: false, reason: "任务或失败运行绑定不符" };
    const run = await new RunStore({ dataRoot: ctx.dataRoot, repoId: identity.repoId, daemonStartedAt: "workflow-state" }).get(input.runId);
    if (!run.ok || run.run.state !== "failed" || run.run.requirement !== ctx.requirement || run.run.task !== input.taskId) return { ok: false, reason: "缺少真实失败运行" };
    const tasks = { ...data.tasks, [input.taskId]: { ...task, progress: "failed", reason: input.reason, repairRound: (task.repairRound ?? 0) + 1 } };
    const { version } = writeRecord(stateRef(ctx, identity.repoId), { ...data, tasks }, { expectedVersion: input.expectedVersion });
    return { ok: true, version };
  } catch (error) { return failureFromError(error); }
}

/** 旧证据不能生成批准或当前通过；保留导出仅用于固定拒绝。 */
export async function bindEvidence(_input: { stage: string; runId: string; currentVersion: DefinitionVersion }, _ctx: WorkflowContext): Promise<{ ok: true } | { ok: false; reason: string }> { return retired(); }
export async function checkEvidence(_input: { stage: string; currentVersion: DefinitionVersion }, _ctx: WorkflowContext): Promise<{ ok: true } | { ok: false; reason: string }> { return retired(); }
export async function invalidateEvidence(ctx: WorkflowContext, stage: string, reason: string): Promise<void> {
  const identity = await repositoryIdentity(ctx.cwd);
  putRecord(evidenceRef(ctx, identity.repoId, stage), { stage, invalid: true, reason, invalidatedAt: new Date().toISOString() });
}
export async function listEvidenceStages(ctx: WorkflowContext): Promise<string[]> {
  const identity = await repositoryIdentity(ctx.cwd);
  return withDatabase(repositoryDatabase(ctx.dataRoot, identity.repoId), (db) => db.list(`evidence:${ctx.requirement}`).map((record) => record.key));
}
