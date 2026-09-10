import { checkAcceptanceReport } from "./delivery.ts";
import { verifyFingerprint } from "./ranges.ts";
import { ACCEPTANCE_SCHEMA, REVIEW_SCHEMA, WORK_SCHEMA, validateResult } from "./result.ts";
import type { AcceptanceResult } from "./result.ts";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { inspectDecision } from "./decisions.ts";
import { repositoryIdentity, requirementIdentity } from "./identity.ts";
import { isTerminalState, RunStore } from "./run-store.ts";
import type { RunRecord, RunState } from "./run-store.ts";
import { createRecord, readRecord, StaleVersionError, writeRecord, putRecord, repositoryDatabase, withDatabase } from "./database.ts";
import type { RecordRef, LocalDatabase } from "./database.ts";

const execFileAsync = promisify(execFile);

export interface WorkflowContext {
  dataRoot: string;
  cwd: string;
  requirement: string;
}

export interface DefinitionVersion {
  definitionFingerprint: string;
  codeHead: string;
}

export interface TaskState {
  progress: string;
  runId: string | null;
  description: string;
  agent: string;
  note: string;
  commit: string | null;
  reason: string;
  repairRound: number;
  blockedReason: string;
  workspaceDir: string;
  [key: string]: unknown;
}

export interface ShapeGates {
  plan: boolean;
  whiteboxReview: boolean;
  blackboxAcceptance: boolean;
}

export interface ShapeSkip {
  gate: string;
  decisionId: string;
}

export interface RequirementShape {
  tasks: Array<{ id: string; roles: string[] }>;
  gates: ShapeGates;
  skipped: ShapeSkip[];
  acceptanceReport: string | null;
  decisionId: string;
}

export interface HistoryEntry {
  stage: string;
  at: string;
  runId: string | null;
  decisionId: string | null;
  reason: string | null;
}

export interface RequirementState {
  requirement: string;
  stage: string;
  shape: RequirementShape | null;
  tasks: Record<string, TaskState>;
  followUps: unknown[];
  history: HistoryEntry[];
}

export type ActionResult = { ok: true; version: number } | { ok: false; reason: string; staleVersion?: true };

function failureFromError(error: unknown): { ok: false; reason: string; staleVersion?: true } {
  if (error instanceof StaleVersionError) return { ok: false, reason: "版本已变化", staleVersion: true };
  return { ok: false, reason: (error as Error).message };
}

export const VALID_STAGES = [
  "draft",
  "confirmed",
  "planned",
  "executing",
  "reviewing",
  "accepting",
  "accepted",
  "rejected",
] as const;

export const VALID_TASK_PROGRESS = ["todo", "doing", "done", "failed"] as const;

export const STAGE_ORDER = ["draft", "confirmed", "planned", "executing", "reviewing", "accepting", "accepted"] as const;

export function assertValidStage(stage: string): void {
  if (!(VALID_STAGES as readonly string[]).includes(stage)) {
    throw new Error(`不合法的阶段: ${stage}，合法值: ${VALID_STAGES.join(", ")}`);
  }
}

export function assertValidTaskProgress(progress: string): void {
  if (!(VALID_TASK_PROGRESS as readonly string[]).includes(progress)) {
    throw new Error(`不合法的任务进度: ${progress}，合法值: ${VALID_TASK_PROGRESS.join(", ")}`);
  }
}

function nextStage(stage: string): string | undefined {
  const idx = STAGE_ORDER.indexOf(stage as (typeof STAGE_ORDER)[number]);
  return idx === -1 ? undefined : STAGE_ORDER[idx + 1];
}

export function requirementStateRef(dataRoot: string, repoId: string, requirement: string): RecordRef {
  requirementIdentity(requirement);
  return { database: repositoryDatabase(dataRoot, repoId), namespace: "requirements", key: requirement };
}

function stateRef(ctx: WorkflowContext, repoId: string): RecordRef {
  return requirementStateRef(ctx.dataRoot, repoId, ctx.requirement);
}

function evidenceRef(ctx: WorkflowContext, repoId: string, stage: string): RecordRef {
  return { database: repositoryDatabase(ctx.dataRoot, repoId), namespace: `evidence:${ctx.requirement}`, key: stage };
}

function newRunStore(ctx: WorkflowContext, repoId: string): RunStore {
  return new RunStore({ dataRoot: ctx.dataRoot, repoId, daemonStartedAt: "workflow-state" });
}

function isStoppedState(state: RunState): boolean {
  return isTerminalState(state) || state === "interrupted";
}

function checkedRequirement(value: unknown, requirement: string): RequirementState {
  const data = value as RequirementState | null;
  if (!data || typeof data !== "object" || Array.isArray(data) || data.requirement !== requirement
    || !(VALID_STAGES as readonly string[]).includes(data.stage) || !data.tasks || typeof data.tasks !== "object" || Array.isArray(data.tasks)
    || !Array.isArray(data.history) || !Array.isArray(data.followUps) || !(data.shape === null || (typeof data.shape === "object" && !Array.isArray(data.shape)))) throw new Error("需求状态结构无效");
  return data;
}

type ReadStateResult = { ok: true; version: number; data: RequirementState } | { ok: false; reason: string };

async function readStateOrFail(ctx: WorkflowContext, repoId: string): Promise<ReadStateResult> {
  let result;
  try {
    result = await readRecord(stateRef(ctx, repoId));
    if (result.exists) checkedRequirement(result.data, ctx.requirement);
  } catch (error) {
    return { ok: false, reason: `需求状态损坏: ${(error as Error).message}` };
  }
  if (!result.exists) return { ok: false, reason: "需求状态不存在" };
  return { ok: true, version: result.version, data: checkedRequirement(result.data, ctx.requirement) };
}

async function requireUserDecision(
  id: string | undefined,
  ctx: WorkflowContext,
  label: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!id) return { ok: false, reason: `缺少${label}` };
  const decision = await inspectDecision({ dataRoot: ctx.dataRoot, cwd: ctx.cwd, requirement: ctx.requirement, id });
  if (!decision) return { ok: false, reason: `决定不存在: ${id}` };
  if ((decision as { actor?: string }).actor !== "user") {
    return { ok: false, reason: `${label}必须是用户决定: ${id}` };
  }
  return { ok: true };
}

export async function initRequirementState(ctx: WorkflowContext): Promise<ActionResult> {
  const identity = await repositoryIdentity(ctx.cwd);
  const initial: RequirementState = {
    requirement: ctx.requirement,
    stage: "draft",
    shape: null,
    tasks: {},
    followUps: [],
    history: [],
  };
  try {
    const { version } = await createRecord(stateRef(ctx, identity.repoId), initial);
    return { ok: true, version };
  } catch (error) {
    return failureFromError(error);
  }
}

export async function readRequirementState(
  ctx: WorkflowContext,
): Promise<{ exists: false } | { exists: true; version: number; data: RequirementState }> {
  const identity = await repositoryIdentity(ctx.cwd);
  const result = await readRecord(stateRef(ctx, identity.repoId));
  if (!result.exists) return { exists: false };
  return { exists: true, version: result.version, data: checkedRequirement(result.data, ctx.requirement) };
}

interface RunBinding {
  requirement: string;
  task?: string | null;
  definitionFingerprint: string;
  codeHead: string;
  cwd: string;
}

interface RunResultShape {
  phase: string;
  verdict: string;
  binding: RunBinding;
  [key: string]: unknown;
}

async function evidenceFromRun(
  runId: string,
  expected: { phase: string; requirement: string; task?: string; currentVersion: DefinitionVersion },
  ctx: WorkflowContext,
): Promise<{ ok: true; result: RunResultShape } | { ok: false; reason: string }> {
  const identity = await repositoryIdentity(ctx.cwd);
  const runStore = newRunStore(ctx, identity.repoId);
  const got = await runStore.get(runId);
  if (!got.ok) return { ok: false, reason: `运行不存在或不可读: ${runId}` };
  const run = got.run;
  if (run.state !== "completed") return { ok: false, reason: `运行未完成: ${run.state}` };
  const result = run.result as RunResultShape | undefined;
  if (!result || !result.binding) return { ok: false, reason: "运行结果或绑定缺失" };

  const mismatches: string[] = [];
  if (run.requirement !== ctx.requirement || run.task !== (result.binding.task ?? run.task)) mismatches.push("运行身份与结果绑定不一致");
  if (!(await bindingWithinRepo(result.binding.cwd, identity.repoId))) mismatches.push("绑定工作目录不属于本仓库");
  if (expected.phase !== "plan") {
    const { binding: _binding, delivery: _delivery, reportDigest: _reportDigest, ...raw } = result;
    const schema = { work: WORK_SCHEMA, review: REVIEW_SCHEMA, acceptance: ACCEPTANCE_SCHEMA }[expected.phase as "work" | "review" | "acceptance"];
    if (!schema) return { ok: false, reason: "未知的结果阶段" };
    const checked = validateResult(schema, expected.phase as "work" | "review" | "acceptance", raw);
    if (!checked.ok) mismatches.push(...checked.errors);
  }
  if (result.phase !== expected.phase) mismatches.push(`phase 期望 ${expected.phase} 实际 ${result.phase}`);
  if (result.verdict !== "PASS") mismatches.push(`verdict 期望 PASS 实际 ${result.verdict}`);
  if (result.binding.requirement !== expected.requirement) mismatches.push("绑定需求不一致");
  if (expected.task !== undefined && result.binding.task !== expected.task) mismatches.push("绑定任务不一致");
  if (result.binding.definitionFingerprint !== expected.currentVersion.definitionFingerprint) {
    mismatches.push("定义指纹不一致");
  }
  if (result.binding.codeHead !== expected.currentVersion.codeHead) mismatches.push("代码 HEAD 不一致");
  if (mismatches.length > 0) return { ok: false, reason: mismatches.join("; ") };
  return { ok: true, result };
}

interface StageGateSpec {
  kind: "decision" | "shapeRecorded" | "allTasksDone" | "runEvidence";
  phase?: string;
  skipGateKey?: keyof ShapeGates;
  acceptanceCheck?: boolean;
}

function gateForStage(targetStage: string): StageGateSpec | undefined {
  switch (targetStage) {
    case "confirmed":
      return { kind: "decision" };
    case "planned":
      return { kind: "runEvidence", phase: "plan", skipGateKey: "plan" };
    case "executing":
      return { kind: "shapeRecorded" };
    case "reviewing":
      return { kind: "allTasksDone" };
    case "accepting":
      return { kind: "runEvidence", phase: "review", skipGateKey: "whiteboxReview" };
    case "accepted":
      return { kind: "runEvidence", phase: "acceptance", skipGateKey: "blackboxAcceptance", acceptanceCheck: true };
    default:
      return undefined;
  }
}

interface AdvanceInput {
  expectedVersion: number;
  targetStage: string;
  decisionId?: string;
  runId?: string;
  currentVersion?: DefinitionVersion;
}

async function evaluateStageGate(
  spec: StageGateSpec,
  data: RequirementState,
  input: AdvanceInput,
  ctx: WorkflowContext,
): Promise<{ ok: true; decisionId?: string } | { ok: false; reason: string }> {
  switch (spec.kind) {
    case "decision": {
      const check = await requireUserDecision(input.decisionId, ctx, "用户确认决定编号");
      if (!check.ok) return check;
      return { ok: true, decisionId: input.decisionId };
    }
    case "shapeRecorded": {
      if (!data.shape) return { ok: false, reason: "尚未记录形状" };
      const missing = data.shape.tasks.filter((task) => !data.tasks[task.id]);
      if (missing.length > 0) {
        return { ok: false, reason: `形状任务未登记: ${missing.map((task) => task.id).join(", ")}` };
      }
      return { ok: true };
    }
    case "allTasksDone": {
      if (!data.shape) return { ok: false, reason: "尚未记录形状" };
      const notDone = data.shape.tasks.filter((task) => data.tasks[task.id]?.progress !== "done");
      if (notDone.length > 0) {
        return { ok: false, reason: `存在未完成任务: ${notDone.map((task) => task.id).join(", ")}` };
      }
      return { ok: true };
    }
    case "runEvidence": {
      const gateKey = spec.skipGateKey as keyof ShapeGates;
      const skip =
        data.shape && data.shape.gates[gateKey] === false
          ? data.shape.skipped.find((entry) => entry.gate === gateKey)
          : undefined;
      if (skip) return { ok: true, decisionId: skip.decisionId };
      if (!input.runId || !input.currentVersion) {
        return { ok: false, reason: `缺少 runId 或版本信息以核对 ${spec.phase} 门禁` };
      }
      const evidence = await evidenceFromRun(
        input.runId,
        { phase: spec.phase as string, requirement: ctx.requirement, currentVersion: input.currentVersion },
        ctx,
      );
      if (!evidence.ok) return evidence;
      if (spec.acceptanceCheck) {
        const result = evidence.result as { acceptanceResult?: string; reportPath?: string };
        if (result.acceptanceResult !== "accepted") {
          return { ok: false, reason: `验收结果不是 accepted: ${result.acceptanceResult}` };
        }
        if (result.reportPath !== data.shape?.acceptanceReport) {
          return { ok: false, reason: "验收报告位置与形状记录不一致" };
        }
        try {
          const digest = await checkAcceptanceReport(evidence.result as unknown as AcceptanceResult, data.shape!.acceptanceReport!);
          if (digest !== evidence.result.reportDigest) return { ok: false, reason: "验收报告在交付后已变化" };
        } catch (error) { return failureFromError(error); }
      }
      return { ok: true };
    }
    default:
      return { ok: false, reason: "未支持的阶段门禁" };
  }
}

export async function advanceStage(input: AdvanceInput, ctx: WorkflowContext): Promise<ActionResult> {
  try {
    assertValidStage(input.targetStage);
  } catch (error) {
    return failureFromError(error);
  }
  const identity = await repositoryIdentity(ctx.cwd);
  const current = await readStateOrFail(ctx, identity.repoId);
  if (!current.ok) return current;
  const data = current.data;
  if (nextStage(data.stage) !== input.targetStage) {
    return { ok: false, reason: `阶段 ${data.stage} 不能直接推进到 ${input.targetStage}` };
  }
  const spec = gateForStage(input.targetStage);
  if (!spec) return { ok: false, reason: `未支持的阶段门禁: ${input.targetStage}` };
  const binding = spec.kind === "runEvidence" ? observeEvidence(ctx, identity.repoId, spec.phase!) : undefined;
  const gateResult = await evaluateStageGate(spec, data, input, ctx);
  if (!gateResult.ok) return gateResult;

  let prepared: PreparedEvidence | undefined;
  if (binding && input.runId && input.currentVersion && !gateResult.decisionId) {
    try {
      const bound = await prepareEvidence({ stage: spec.phase!, runId: input.runId, currentVersion: input.currentVersion }, ctx, binding);
      if (!bound.ok) return bound;
      prepared = bound.prepared;
    } catch (error) { return failureFromError(error); }
  }
  const history: HistoryEntry[] = [
    ...data.history,
    {
      stage: input.targetStage,
      at: new Date().toISOString(),
      runId: input.runId ?? null,
      decisionId: gateResult.decisionId ?? input.decisionId ?? null,
      reason: null,
    },
  ];
  try {
    const version = commitWithEvidence(stateRef(ctx, identity.repoId), { ...data, stage: input.targetStage, history }, input.expectedVersion, prepared);
    return { ok: true, version };
  } catch (error) {
    return failureFromError(error);
  }
}

const RETREAT_PATHS: Record<string, string> = {
  reviewing: "executing",
  accepting: "executing",
  planned: "confirmed",
  accepted: "executing",
};

function mostRecentRunIdForStage(history: HistoryEntry[], stage: string): string | null {
  for (let i = history.length - 1; i >= 0; i--) {
    const entry = history[i];
    if (entry && entry.stage === stage) return entry.runId;
  }
  return null;
}

const UNSTOPPED_STATES: RunState[] = ["queued", "running", "pausing", "paused", "paused_network", "waiting_answer"];

async function blockingActiveRun(ctx: WorkflowContext, repoId: string): Promise<RunRecord | undefined> {
  const page = await newRunStore(ctx, repoId).list({ kind: "role", requirement: ctx.requirement, states: UNSTOPPED_STATES, limit: 1 });
  return page.items[0];
}

export async function retreatStage(
  input: { expectedVersion: number; targetStage: string; reason: string; decisionId?: string; runId?: string },
  ctx: WorkflowContext,
): Promise<ActionResult> {
  const identity = await repositoryIdentity(ctx.cwd);
  const current = await readStateOrFail(ctx, identity.repoId);
  if (!current.ok) return current;
  const data = current.data;
  if (data.stage === "accepted") {
    if (!input.runId) return { ok: false, reason: "已验收需求禁止无提交前审查证据回退" };
    const review = await newRunStore(ctx, identity.repoId).get(input.runId);
    if (!review.ok || review.run.requirement !== ctx.requirement || review.run.task !== "submit-review" || review.run.state !== "completed" || (review.run.result as { phase?: string; verdict?: string } | undefined)?.phase !== "review" || (review.run.result as { verdict?: string }).verdict !== "FAIL") return { ok: false, reason: "已验收需求回退需要本需求提交前白盒未通过证据" };
  }
  if (RETREAT_PATHS[data.stage] !== input.targetStage) {
    return { ok: false, reason: `不允许从 ${data.stage} 回退到 ${input.targetStage}` };
  }
  if (!input.reason) return { ok: false, reason: "缺少回退理由" };
  if (!input.decisionId) return { ok: false, reason: "缺少决定编号" };
  const decision = await inspectDecision({ dataRoot: ctx.dataRoot, cwd: ctx.cwd, requirement: ctx.requirement, id: input.decisionId }) as { actor?: string; effects?: string[] } | null;
  if (!decision || (decision.actor !== "user" && !decision.effects?.some((effect) => effect === "repair:review" || effect === "repair:acceptance"))) return { ok: false, reason: "回退需用户决定或已记录的 AI 门禁归因" };
  const blocking = await blockingActiveRun(ctx, identity.repoId);
  if (blocking) {
    return { ok: false, reason: `存在未停止的运行 ${blocking.id}（${blocking.state}${blocking.task ? `，任务 ${blocking.task}` : ""}），回退前须先停止` };
  }

  const departureRunId = mostRecentRunIdForStage(data.history, data.stage);
  const history: HistoryEntry[] = [
    ...data.history,
    {
      stage: input.targetStage,
      at: new Date().toISOString(),
      runId: departureRunId,
      decisionId: input.decisionId as string,
      reason: input.reason,
    },
  ];
  try {
    const version = commitWithEvidence(stateRef(ctx, identity.repoId), { ...data, stage: input.targetStage, history }, input.expectedVersion);
    return { ok: true, version };
  } catch (error) {
    return failureFromError(error);
  }
}

function registerTasks(existing: Record<string, TaskState>, shapeTasks: Array<{ id: string; roles: string[] }>): Record<string, TaskState> {
  const tasks = { ...existing };
  for (const task of shapeTasks) {
    if (tasks[task.id]) continue;
    tasks[task.id] = {
      progress: "todo",
      runId: null,
      description: "",
      agent: "",
      note: "",
      commit: null,
      reason: "",
      repairRound: 0,
      blockedReason: "",
      workspaceDir: "",
    };
  }
  return tasks;
}

export async function recordShape(
  input: { expectedVersion: number; shape: RequirementShape },
  ctx: WorkflowContext,
): Promise<ActionResult> {
  const identity = await repositoryIdentity(ctx.cwd);
  const current = await readStateOrFail(ctx, identity.repoId);
  if (!current.ok) return current;
  const data = current.data;
  const shape = input.shape;

  if (!shape.tasks || shape.tasks.length === 0) return { ok: false, reason: "形状任务集不能为空" };

  const shapeDecisionCheck = await requireUserDecision(shape.decisionId, ctx, "形状确认决定编号");
  if (!shapeDecisionCheck.ok) return shapeDecisionCheck;

  for (const [gate, enabled] of Object.entries(shape.gates)) {
    if (enabled) continue;
    const skip = shape.skipped.find((entry) => entry.gate === gate);
    if (!skip) return { ok: false, reason: `门禁 ${gate} 声明为跳过但缺少用户决定编号` };
    const skipCheck = await requireUserDecision(skip.decisionId, ctx, `门禁 ${gate} 关联的决定编号`);
    if (!skipCheck.ok) return skipCheck;
  }

  const tasks = registerTasks(data.tasks, shape.tasks);
  try {
    const { version } = await writeRecord(
      stateRef(ctx, identity.repoId),
      { ...data, shape, tasks },
      { expectedVersion: input.expectedVersion },
    );
    return { ok: true, version };
  } catch (error) {
    return failureFromError(error);
  }
}

export function skippedGates(shape: RequirementShape | null): ShapeSkip[] {
  return shape?.skipped ?? [];
}

export async function updateTaskFields(
  input: { expectedVersion: number; taskId?: string; fields?: Record<string, unknown>; followUps?: unknown[] },
  ctx: WorkflowContext,
): Promise<ActionResult> {
  const identity = await repositoryIdentity(ctx.cwd);
  const current = await readStateOrFail(ctx, identity.repoId);
  if (!current.ok) return current;
  const data = current.data;
  const tasks = { ...data.tasks };

  if (input.taskId !== undefined) {
    const task = tasks[input.taskId];
    if (!task) return { ok: false, reason: `任务不存在: ${input.taskId}` };
    const fields = input.fields ?? {};
    const allowed = ["note", "description", "agent", "commit", "blockedReason", "workspaceDir"];
    for (const key of Object.keys(fields)) {
      if (!allowed.includes(key)) return { ok: false, reason: `不允许更新的字段: ${key}` };
    }
    tasks[input.taskId] = { ...task, ...fields };
  }

  const followUps = input.followUps ?? data.followUps;
  try {
    const { version } = await writeRecord(
      stateRef(ctx, identity.repoId),
      { ...data, tasks, followUps },
      { expectedVersion: input.expectedVersion },
    );
    return { ok: true, version };
  } catch (error) {
    return failureFromError(error);
  }
}

export async function startTask(
  input: { expectedVersion: number; taskId: string; runId: string },
  ctx: WorkflowContext,
): Promise<ActionResult> {
  const identity = await repositoryIdentity(ctx.cwd);
  const current = await readStateOrFail(ctx, identity.repoId);
  if (!current.ok) return current;
  const data = current.data;
  const task = data.tasks[input.taskId];
  if (!task) return { ok: false, reason: `任务不存在: ${input.taskId}` };
  if (task.progress !== "todo" && task.progress !== "failed") {
    return { ok: false, reason: `任务进度 ${task.progress} 不能启动` };
  }
  const tasks = { ...data.tasks, [input.taskId]: { ...task, progress: "doing", runId: input.runId } };
  try {
    const { version } = await writeRecord(
      stateRef(ctx, identity.repoId),
      { ...data, tasks },
      { expectedVersion: input.expectedVersion },
    );
    return { ok: true, version };
  } catch (error) {
    return failureFromError(error);
  }
}

const COMMIT_SHA_PATTERN = /^[0-9a-f]{7,40}$/;

async function commitExists(cwd: string, commit: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["rev-parse", "--verify", "--end-of-options", `${commit}^{commit}`], {
      cwd,
      timeout: 10_000,
    });
    return true;
  } catch {
    return false;
  }
}

async function bindingWithinRepo(cwd: string, repoId: string): Promise<boolean> {
  try {
    const bindingIdentity = await repositoryIdentity(cwd);
    return bindingIdentity.repoId === repoId;
  } catch {
    return false;
  }
}

export async function finishTask(
  input: { expectedVersion: number; taskId: string; runId: string; currentVersion: DefinitionVersion },
  ctx: WorkflowContext,
): Promise<ActionResult> {
  const identity = await repositoryIdentity(ctx.cwd);
  const current = await readStateOrFail(ctx, identity.repoId);
  if (!current.ok) return current;
  const data = current.data;
  const task = data.tasks[input.taskId];
  if (!task) return { ok: false, reason: `任务不存在: ${input.taskId}` };
  if (task.progress !== "doing") return { ok: false, reason: `任务进度 ${task.progress} 不能完成` };

  const binding = observeEvidence(ctx, identity.repoId, `work-${input.taskId}`);
  const evidence = await evidenceFromRun(
    input.runId,
    { phase: "work", requirement: ctx.requirement, task: input.taskId, currentVersion: input.currentVersion },
    ctx,
  );
  if (!evidence.ok) return evidence;
  const result = evidence.result as {
    changedFiles?: string[];
    workState?: string;
    preexistingEvidence?: string[];
    delivery?: { commit?: string | null; verificationOk?: boolean };
    binding: RunBinding;
  };
  if (!result.delivery?.verificationOk) return { ok: false, reason: "delivery.verificationOk 不为 true" };

  const changedFiles = result.changedFiles ?? [];
  if (changedFiles.length > 0) {
    const commit = result.delivery.commit;
    if (!commit || !COMMIT_SHA_PATTERN.test(commit)) {
      return { ok: false, reason: `提交格式不合法: ${commit}` };
    }
    if (!(await bindingWithinRepo(result.binding.cwd, identity.repoId))) {
      return { ok: false, reason: `绑定工作目录不在本需求仓库内: ${result.binding.cwd}` };
    }
    if (!(await commitExists(result.binding.cwd, commit))) {
      return { ok: false, reason: `提交在仓库中不存在: ${commit}` };
    }
  } else {
    if (result.workState !== "green-baseline-no-change") {
      return { ok: false, reason: "changedFiles 为空但 workState 不是 green-baseline-no-change" };
    }
    if (!result.preexistingEvidence || result.preexistingEvidence.length === 0) {
      return { ok: false, reason: "changedFiles 为空但缺少既有证据" };
    }
  }

  let prepared: PreparedEvidence;
  try {
    const bound = await prepareEvidence({ stage: `work-${input.taskId}`, runId: input.runId, currentVersion: input.currentVersion }, ctx, binding);
    if (!bound.ok) return bound;
    prepared = bound.prepared;
  } catch (error) { return failureFromError(error); }
  const tasks = {
    ...data.tasks,
    [input.taskId]: { ...task, progress: "done", runId: input.runId, commit: result.delivery.commit ?? null },
  };
  try {
    const version = commitWithEvidence(stateRef(ctx, identity.repoId), { ...data, tasks }, input.expectedVersion, prepared);
    return { ok: true, version };
  } catch (error) {
    return failureFromError(error);
  }
}

export async function failTask(
  input: { expectedVersion: number; taskId: string; runId: string; reason: string },
  ctx: WorkflowContext,
): Promise<ActionResult> {
  const identity = await repositoryIdentity(ctx.cwd);
  const current = await readStateOrFail(ctx, identity.repoId);
  if (!current.ok) return current;
  const data = current.data;
  const task = data.tasks[input.taskId];
  if (!task) return { ok: false, reason: `任务不存在: ${input.taskId}` };
  if (task.progress !== "doing") return { ok: false, reason: `任务进度 ${task.progress} 不能标记失败` };
  const tasks = {
    ...data.tasks,
    [input.taskId]: { ...task, progress: "failed", reason: input.reason, repairRound: (task.repairRound ?? 0) + 1 },
  };
  try {
    const { version } = await writeRecord(
      stateRef(ctx, identity.repoId),
      { ...data, tasks },
      { expectedVersion: input.expectedVersion },
    );
    return { ok: true, version };
  } catch (error) {
    return failureFromError(error);
  }
}

export async function rollbackTask(
  input: { expectedVersion: number; taskId: string; decisionId?: string },
  ctx: WorkflowContext,
): Promise<ActionResult> {
  const identity = await repositoryIdentity(ctx.cwd);
  const current = await readStateOrFail(ctx, identity.repoId);
  if (!current.ok) return current;
  const data = current.data;
  if (data.stage === "accepted") return { ok: false, reason: "已验收需求禁止回滚任务" };
  const task = data.tasks[input.taskId];
  if (!task) return { ok: false, reason: `任务不存在: ${input.taskId}` };
  if (task.progress !== "done" && task.progress !== "failed") {
    return { ok: false, reason: `任务进度 ${task.progress} 不能回滚` };
  }
  const check = await requireUserDecision(input.decisionId, ctx, "决定编号");
  if (!check.ok) return check;
  if (task.runId) {
    const runStore = newRunStore(ctx, identity.repoId);
    const got = await runStore.get(task.runId);
    if (!got.ok) return { ok: false, reason: `原运行不可读: ${task.runId}` };
    if (!isStoppedState(got.run.state)) return { ok: false, reason: `原运行仍处于活动状态: ${got.run.state}` };
  }
  const tasks = { ...data.tasks, [input.taskId]: { ...task, progress: "todo" } };
  try {
    const { version } = await writeRecord(
      stateRef(ctx, identity.repoId),
      { ...data, tasks },
      { expectedVersion: input.expectedVersion },
    );
    return { ok: true, version };
  } catch (error) {
    return failureFromError(error);
  }
}

export async function rejectRequirement(
  input: { expectedVersion: number; decisionId?: string },
  ctx: WorkflowContext,
): Promise<ActionResult> {
  const check = await requireUserDecision(input.decisionId, ctx, "用户裁决决定编号");
  if (!check.ok) return check;
  const identity = await repositoryIdentity(ctx.cwd);
  const current = await readStateOrFail(ctx, identity.repoId);
  if (!current.ok) return current;
  const data = current.data;
  if (data.stage === "accepted") return { ok: false, reason: "已验收需求禁止拒绝" };
  const history: HistoryEntry[] = [
    ...data.history,
    { stage: "rejected", at: new Date().toISOString(), runId: null, decisionId: input.decisionId as string, reason: null },
  ];
  try {
    const { version } = await writeRecord(
      stateRef(ctx, identity.repoId),
      { ...data, stage: "rejected", history },
      { expectedVersion: input.expectedVersion },
    );
    return { ok: true, version };
  } catch (error) {
    return failureFromError(error);
  }
}

interface EvidenceObservation {
  ref: RecordRef;
  id?: string;
  version?: number;
}

interface PreparedEvidence extends EvidenceObservation {
  payload: unknown;
}

function observeEvidence(ctx: WorkflowContext, repoId: string, stage: string): EvidenceObservation {
  const ref = evidenceRef(ctx, repoId, stage);
  const record = readRecord(ref);
  return record.exists ? { ref, id: record.id, version: record.version } : { ref };
}

function commitEvidence(db: LocalDatabase, prepared: PreparedEvidence): void {
  const { ref, id, version, payload } = prepared;
  const current = db.read(ref.namespace, ref.key);
  if (current?.id !== id || current?.version !== version) throw new StaleVersionError();
  if (current) db.update(ref.namespace, ref.key, current.version, payload);
  else db.create(ref.namespace, ref.key, payload);
}

function commitWithEvidence(ref: RecordRef, data: RequirementState, version: number, prepared?: PreparedEvidence): number {
  return withDatabase(ref.database, (db) => db.transaction(() => {
    const nextVersion = db.update(ref.namespace, ref.key, version, data);
    if (prepared) commitEvidence(db, prepared);
    return nextVersion;
  }));
}

async function prepareEvidence(
  input: { stage: string; runId: string; currentVersion: DefinitionVersion },
  ctx: WorkflowContext,
  observed: EvidenceObservation,
): Promise<{ ok: true; prepared: PreparedEvidence } | { ok: false; reason: string }> {
  const evidence = await evidenceFromRun(
    input.runId,
    { phase: input.stage.startsWith("work-") ? "work" : input.stage, task: input.stage.startsWith("work-") ? input.stage.slice(5) : undefined, requirement: ctx.requirement, currentVersion: input.currentVersion },
    ctx,
  );
  if (!evidence.ok) return evidence;
  const payload = {
    stage: input.stage,
    runId: input.runId,
    phase: evidence.result.phase,
    definitionFingerprint: input.currentVersion.definitionFingerprint,
    codeHead: input.currentVersion.codeHead,
    cwd: evidence.result.binding.cwd,
    boundAt: new Date().toISOString(),
    fileFingerprints: (evidence.result.delivery as { fileFingerprints?: Record<string, string> } | undefined)?.fileFingerprints,
  };
  return { ok: true, prepared: { ...observed, payload } };
}

export async function bindEvidence(
  input: { stage: string; runId: string; currentVersion: DefinitionVersion },
  ctx: WorkflowContext,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    const identity = await repositoryIdentity(ctx.cwd);
    const observed = observeEvidence(ctx, identity.repoId, input.stage);
    const result = await prepareEvidence(input, ctx, observed);
    if (!result.ok) return result;
    withDatabase(observed.ref.database, (db) => db.transaction(() => commitEvidence(db, result.prepared)));
    return { ok: true };
  } catch (error) { return failureFromError(error); }
}

export async function checkEvidence(
  input: { stage: string; currentVersion: DefinitionVersion },
  ctx: WorkflowContext,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const identity = await repositoryIdentity(ctx.cwd);
  let evidence: { definitionFingerprint: string; codeHead: string; invalid?: boolean; reason?: string; fileFingerprints?: Record<string, string> };
  try {
    const record = readRecord<typeof evidence>(evidenceRef(ctx, identity.repoId, input.stage));
    if (!record.exists) return { ok: false, reason: "证据不存在，待重新核对" };
    evidence = record.data;
    if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) throw new Error("证据结构无效");
  } catch { return { ok: false, reason: "证据不可读，待重新核对" }; }
  if (evidence.invalid) {
    return { ok: false, reason: `证据已失效: ${evidence.reason ?? ""}` };
  }
  if (input.stage.startsWith("work-")) {
    if (!evidence.fileFingerprints || Object.keys(evidence.fileFingerprints).length === 0) return { ok: false, reason: "交付缺少文件保护证据" };
    try {
      if ((await verifyFingerprint(ctx.cwd, evidence.fileFingerprints)).length > 0) return { ok: false, reason: "交付涉及文件已变化，待重新核对" };
      return { ok: true };
    } catch (error) { return failureFromError(error); }
  }
  if (
    evidence.definitionFingerprint !== input.currentVersion.definitionFingerprint ||
    evidence.codeHead !== input.currentVersion.codeHead
  ) {
    return { ok: false, reason: "证据版本已过期，待重新核对" };
  }
  return { ok: true };
}

export async function invalidateEvidence(ctx: WorkflowContext, stage: string, reason: string): Promise<void> {
  const identity = await repositoryIdentity(ctx.cwd);
  const payload = { stage, invalid: true, reason, invalidatedAt: new Date().toISOString() };
  putRecord(evidenceRef(ctx, identity.repoId, stage), payload);
}

export async function listEvidenceStages(ctx: WorkflowContext): Promise<string[]> {
  const identity = await repositoryIdentity(ctx.cwd);
  return withDatabase(repositoryDatabase(ctx.dataRoot, identity.repoId), (db) => db.list(`evidence:${ctx.requirement}`).map((record) => record.key));
}

export async function checkResume(
  ctx: WorkflowContext,
  currentVersion?: DefinitionVersion,
): Promise<{ ok: true; stage: string; version: number } | { ok: false; reason: string }> {
  let stateResult: Awaited<ReturnType<typeof readRequirementState>>;
  try {
    stateResult = await readRequirementState(ctx);
  } catch (error) {
    return { ok: false, reason: `需求状态损坏: ${(error as Error).message}` };
  }
  if (!stateResult.exists) return { ok: false, reason: "需求状态不存在" };
  const data = stateResult.data;
  const identity = await repositoryIdentity(ctx.cwd);
  const runStore = newRunStore(ctx, identity.repoId);

  for (const [taskId, task] of Object.entries(data.tasks)) {
    if (task.progress !== "doing" || !task.runId) continue;
    const got = await runStore.get(task.runId);
    if (!got.ok) return { ok: false, reason: `任务 ${taskId} 关联运行不可读: ${task.runId}` };
    if (!isStoppedState(got.run.state)) {
      return { ok: false, reason: `任务 ${taskId} 关联运行未停止: ${got.run.state}` };
    }
  }

  if (currentVersion) {
    try {
      const existing = await listEvidenceStages(ctx);
      const stages = Object.entries(data.tasks).filter(([, task]) => task.progress === "done").map(([id]) => `work-${id}`);
      if (data.stage === "planned" && data.shape?.gates.plan !== false) stages.push("plan");
      if (["accepting", "accepted"].includes(data.stage) && data.shape?.gates.whiteboxReview !== false) stages.push("review");
      if (data.stage === "accepted" && data.shape?.gates.blackboxAcceptance !== false) stages.push("acceptance");
      for (const stage of new Set([...stages, ...existing.filter((stage) => stage !== "plan" || data.stage === "planned")])) {
        const checked = await checkEvidence({ stage, currentVersion }, ctx);
        if (!checked.ok) return checked;
      }
    } catch (error) { return failureFromError(error); }
  }

  return { ok: true, stage: data.stage, version: stateResult.version };
}
