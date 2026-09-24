import { randomUUID } from "node:crypto";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Clock } from "../runtime/clock.ts";
import type { NetworkPauseGate } from "../runtime/network-pause.ts";
import type { RoleCatalogEntry } from "../runtime/roles.ts";
import type { DispatchSettingsContext, ListRunOptions, RunKind, RunRecord } from "../runtime/run-store.ts";
import { isTerminalState, RunStore } from "../runtime/run-store.ts";
import type { Host, ShellRegistry, TaskRecord } from "../runtime/shell-registry.ts";
import { repositoryDatabase, UUID_V7_PATTERN } from "../runtime/database.ts";
import { assertLegacyRequirementId, withLegacyReadDatabase } from "../runtime/workflow-state.ts";
import { checkedMetadataPage, legacyMetadataPage } from "../runtime/workflow-tool.ts";
import type { MetadataPageOptions } from "../runtime/workflow-tool.ts";
import { LEGACY_WORKFLOW_RETIRED } from "../runtime/decision-record-tool.ts";
import { createAgentRoleSession } from "./agent-session.ts";
import type { AgentSessionHandle } from "./agent-session.ts";
import { createPmTools } from "./pm-tools.ts";
import { createSubagentTools } from "./subagent-tools.ts";
import { beginTaskAttempt, finishTaskAttempt, TaskDispatchError } from "../runtime/task-dispatch.ts";
import { confirmedPlanKey, readPlanIn, readTaskDetail, replanPending, terminationPending } from "../runtime/plan-manage.ts";
import type { TaskRecord as PlanTask } from "../runtime/plan-manage.ts";
import { VERDICTS } from "../runtime/verdicts.ts";
import { coreToolName } from "../runtime/role-tools.ts";
import type { PmTools } from "./pm-tools.ts";
import { withDatabase } from "../runtime/database.ts";
import type { PmLease, RequirementRecord } from "../runtime/requirement-contracts.ts";
import { RequirementStateStore } from "../runtime/requirement-state.ts";
import type { TimerHandle } from "../runtime/clock.ts";
import { MANAGED_WORKSPACES } from "../runtime/workspace-manage.ts";
import { takeUnnotifiedDecisions } from "../runtime/adjudication.ts";
import { deliverApprovedEvents } from "../runtime/pm-event-delivery.ts";
import { headingTitlesOf, pmOverview } from "../runtime/pm-overview.ts";
import type { PmOverview } from "../runtime/pm-overview.ts";
import { RequirementService } from "../runtime/requirement-service.ts";
import { implementAuthorized } from "../runtime/pm-intake-runtime.ts";
import type { RelayQueue } from "./relay-queue.ts";
import type { ClientInfo, DaemonServer } from "./server.ts";

export interface SelectedModel { provider: string; id: string }
export type ModelSelector = (input: { roleName: string; taskId?: string }) => SelectedModel;
export type EmitFn = (event: string, data: Record<string, unknown>, filter?: (windowId: string) => boolean) => void;
export interface RunManagerOptions {
  repositoryRoot: string; dataRoot: string; repoId: string; runStore: RunStore; shellRegistry: ShellRegistry;
  networkGate: NetworkPauseGate; relayQueue: RelayQueue; roleCatalog: RoleCatalogEntry[];
  runtime: ModelRuntime; selectModel: ModelSelector; clock: Clock; workspaceRepoIds: string[]; emit: EmitFn;
}
export interface WaitForSpec { repo: string; requirement: string; stage: string }
interface SessionEntry { kind: RunKind; handle: AgentSessionHandle; pm?: { lease: PmLease; tools: PmTools; renewal: TimerHandle; delivery: TimerHandle; tick: () => Promise<void>; haltPaused: boolean; halt: { children: string[]; plan: string } | null };
  subagent?: { parentRunId: string; taskId: string; dispose(): void } }
export interface DispatchPmInput { requirementId: string; model: SelectedModel; thinking: string }
const PM_RENEW_MS = 10_000;
const PM_EVENT_POLL_MS = 500;
const PM_STATE_ACTIONS = ["open", "read", "acquire-pm", "renew-pm", "release-pm", "check-pm"];

async function taskContext(task: PlanTask, maxTurns: number): Promise<string> {
  const detail = await readTaskDetail(task);
  return [
    `任务：${task.key}（${task.taskId}，版本 ${task.version}，职责 ${task.role}）`,
    `目标：${detail.objective}`,
    `通过条件：\n${detail.passCriteria.map((item) => `- ${item}`).join("\n")}`,
    `范围：${detail.scope.in.join("、")}；非目标：${detail.scope.out.join("、") || "无"}`,
    `性能条件：${detail.performance.applicable ? detail.performance.thresholds : `不适用（${detail.performance.reason}）`}`,
    `需求章节：${task.goalUnitIds.join("、")}${task.constraintUnitIds.length ? `；约束章节：${task.constraintUnitIds.join("、")}` : ""}`,
    ...(task.writePaths.length ? [`可写范围：${task.writePaths.join("、")}`] : []),
    `对话轮次上限：${maxTurns}。用满后运行时会停止，请在额度内提交结果。`,
  ].join("\n");
}

function pmContext(record: RequirementRecord, lease: PmLease): string {
  const workspace = record.workspace!;
  return [
    `需求 ID：${record.requirementId}`,
    `工作区：${workspace.path}（分支 ${workspace.branch}）`,
    `当前批准版本：revision ${record.revision}，prod hash ${record.approved!.hash}`,
    `PM 运行：${lease.runId}，fence ${lease.fence}`,
    "当前处于受限接手：先用 pi_company_requirement_manage 读取完整批准正文，再提交接手理解等待主代理核对；核对通过前不能正式提出或更新计划，也不能派 worker。",
    "核对通过后，之后每次已批准更新的准确差异会由宿主按序送达本会话；收到后用 pi_company_plan_manage assess-update 逐任务复核。",
  ].join("\n");
}
export type RunMetadata = Pick<RunRecord, "id" | "kind" | "requirement" | "parentRunId" | "state" | "startedAt" | "updatedAt" | "endedAt" | "turns" | "usage" | "pausedMs" | "pausedAt"> & { stateReason?: string };
function runMetadata(run: RunRecord): RunMetadata {
  const timestamp = (value: unknown) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
  if (!run || !UUID_V7_PATTERN.test(run.id) || !["requirement", "role"].includes(run.kind)
    || !["queued", "running", "pausing", "paused", "paused_network", "waiting_answer", "completed", "failed", "stopped", "interrupted"].includes(run.state)
    || !timestamp(run.startedAt) || !timestamp(run.updatedAt) || run.endedAt !== undefined && !timestamp(run.endedAt)
    || !Number.isSafeInteger(run.turns) || run.turns < 0 || run.parentRunId !== undefined && (!UUID_V7_PATTERN.test(run.parentRunId) || run.parentRunId === run.id || run.kind !== "role")) throw protocolError("legacy_metadata_unavailable", "运行元数据不可读，未知记录已保全待核对");
  if (!UUID_V7_PATTERN.test(run.requirement)) assertLegacyRequirementId(run.requirement);
  return { id: run.id, kind: run.kind, requirement: run.requirement, parentRunId: run.parentRunId,
    state: run.state, startedAt: run.startedAt, updatedAt: run.updatedAt, endedAt: run.endedAt, turns: run.turns,
    ...(run.usage ? { usage: { ...run.usage } } : {}), ...(run.pausedMs ? { pausedMs: run.pausedMs } : {}), ...(run.pausedAt ? { pausedAt: run.pausedAt } : {}),
    ...(run.stateReason ? { stateReason: "运行原因已记录；状态元数据不返回旧正文" } : {}) };
}
function shellMetadata(task: TaskRecord) {
  return { taskId: task.taskId, host: { kind: task.host.kind, id: task.host.id, runId: task.host.runId },
    command: "[旧命令正文不提供]", cwd: "[旧工作目录不提供]",
    pid: task.pid, pgid: task.pgid, startedAt: task.startedAt, status: task.status, activity: task.activity,
    exitCode: task.exitCode, descendants: task.descendants, descendantsScanned: task.descendantsScanned,
    identityVerified: task.identityVerified, stoppedBy: task.stoppedBy };
}
function taskHost(run: RunRecord): Host { return { kind: "role", id: run.id, role: run.role, runId: run.id }; }
function protocolError(code: string, message: string): Error & { code: string } { return Object.assign(new Error(message), { code }); }
function retiredError(): Error & { code: string } { return protocolError("legacy_workflow_retired", LEGACY_WORKFLOW_RETIRED); }
const DEFAULT_WAIT_TIMEOUT_MS = 300_000;

/** 旧运行只保留元数据、暂停与安全停止；不存在派工、队列执行和恢复器。 */
export class RunManager {
  private readonly repoId: string;
  private readonly database: string;
  private readonly unconfirmedAdoptions = new Set<string>();
  private readonly runStore: RunStore;
  private readonly shellRegistry: ShellRegistry;
  private readonly relayQueue: RelayQueue;
  private readonly emit: EmitFn;
  private readonly options: RunManagerOptions;
  private readonly sessions = new Map<string, SessionEntry>();
  private started = false;
  private resolveStarted!: () => void;
  private readonly startedPromise: Promise<void>;

  constructor(options: RunManagerOptions) {
    this.startedPromise = new Promise((resolve) => { this.resolveStarted = resolve; });
    this.options = options;
    this.repoId = options.repoId;
    this.database = repositoryDatabase(options.dataRoot, options.repoId);
    this.runStore = options.runStore;
    this.shellRegistry = options.shellRegistry;
    this.relayQueue = options.relayQueue;
    this.emit = options.emit;
  }
  markStarted(): void { if (!this.started) { this.started = true; this.resolveStarted(); } }
  async awaitStarted(): Promise<void> { if (!this.started) await this.startedPromise; }
  private async pmState(): Promise<RequirementStateStore> {
    const { repositoryRoot, dataRoot, repoId } = this.options;
    return RequirementStateStore.open({ repositoryRoot, dataRoot, repoId, authorize: (request) => request.repoId === repoId && PM_STATE_ACTIONS.includes(request.action) });
  }

  /** 主代理派出唯一 PM：工作区须已 ready 并绑定，新运行取得更高 fence，旧运行的工具随之失效。 */
  async dispatchPm(input: DispatchPmInput): Promise<{ runId: string; fence: number }> {
    const state = await this.pmState();
    const record = state.read(input.requirementId);
    if (record.data.lifecycle !== "active") throw protocolError("requirement_not_active", "需求不是活动状态");
    const managed = withDatabase(this.database, (db) => db.read<{ status?: string }>(MANAGED_WORKSPACES, input.requirementId));
    if (managed?.data.status !== "ready" || !record.data.workspace || !record.data.approved) throw protocolError("workspace_not_ready", "需求工作区尚未 ready 或尚无批准版本");
    if (!record.data.approvalManifest || !implementAuthorized({ dataRoot: this.options.dataRoot, repoId: this.repoId }, record)) {
      throw protocolError("implement_not_authorized", "批准清单没有实施授权，分析与规划阶段不派 PM");
    }
    const entry = this.options.roleCatalog.find((candidate) => candidate.name === "pm");
    if (!entry?.available || !entry.definition || entry.definition.role !== "pm") throw protocolError("role_unavailable", entry?.reason ?? "PM 定义不可用");
    const definition = entry.definition;
    const modelRef = definition.model
      ? { provider: definition.model.slice(0, definition.model.indexOf("/")), id: definition.model.slice(definition.model.indexOf("/") + 1) }
      : input.model;
    if (!this.options.runtime.getModels(modelRef.provider).some((model) => model.id === modelRef.id)) throw protocolError("model_unavailable", `模型不可用: ${modelRef.provider}/${modelRef.id}`);
    const thinking = definition.thinking ?? input.thinking;
    const owner = state.pmOwner(input.requirementId);
    if (owner?.lease && owner.lease.expiresAt > Date.now()) throw protocolError("pm_already_owned", "本需求已有有效 PM");
    // 旧租约已失效：接管前先停止本需求仍登记在册的旧运行，旧会话不能继续调用工具
    await this.stopRequirement(input.requirementId);
    const expectedFence = owner?.fence ?? 0;
    const workspace = record.data.workspace;
    const run = await this.runStore.create({ kind: "requirement", requirement: input.requirementId, task: "pm", cwd: workspace.path,
      readPaths: [workspace.path], writePaths: [], model: modelRef, thinking, mcp: [] });
    let lease: PmLease;
    try { lease = await state.acquirePm({ requirementId: input.requirementId, version: record.version, runId: run.id, expectedFence }); }
    catch (error) {
      await this.runStore.update(run.id, { state: "failed", stateReason: (error as { code?: string }).code ?? "acquire_failed" });
      throw protocolError((error as { code?: string }).code ?? "acquire_failed", "PM 租约取得失败");
    }
    let registered = false;
    const leaseCurrent = () => withDatabase(this.database, (db) => {
      const owner = db.read<{ fence?: number; lease?: PmLease | null }>("pm_ownership", input.requirementId)?.data;
      return owner?.lease?.runId === lease.runId && owner.lease.fence === lease.fence && owner.lease.expiresAt > Date.now();
    });
    // 工具在会话创建前就会核验一次；登记前视为启动中，登记后按真实会话状态判断；任何时候都要求租约仍属于本运行
    const alive = () => {
      const current = this.sessions.get(run.id);
      const sessionAlive = current === undefined ? !registered : ["running", "paused", "paused_network"].includes(current.handle.state());
      return sessionAlive && leaseCurrent();
    };
    let tools: PmTools | undefined;
    let handle: AgentSessionHandle;
    try {
      tools = await createPmTools({ repositoryRoot: this.options.repositoryRoot, dataRoot: this.options.dataRoot, repoId: this.repoId, lease, workspace,
        epoch: record.data.epoch, alive, checkLease: () => state.checkPm(lease),
        currentBaseline: () => {
          const current = state.read(input.requirementId).data;
          if (!current.approved || !current.approvalManifest) throw new Error("approval_baseline_missing");
          return { approvedRevision: current.revision, approvedProdHash: current.approved.hash, approvalManifestHash: current.approvalManifest.reference.manifestHash };
        },
        stopAgents: (requirementId) => this.stopRequirement(requirementId),
        agents: {
          dispatch: (taskId, retry) => this.dispatchTask({ pmRunId: run.id, taskId, retry }),
          control: async (action, childId) => {
            const child = await this.runStore.get(childId);
            if (!child.ok || child.run.parentRunId !== run.id) throw protocolError("not_found", "不是本 PM 派出的运行");
            return action === "status" ? this.status(childId) : this[action](childId);
          },
        } });
      handle = await createAgentRoleSession({ dataRoot: this.options.dataRoot, repoId: this.repoId, runId: run.id, cwd: workspace.path, definition,
        context: pmContext(record.data, lease), coreTools: tools.tools, readRoots: [workspace.path], runtime: this.options.runtime, modelRef, thinking,
        completion: { kind: "idle-only" }, clock: this.options.clock, networkGate: this.options.networkGate });
    } catch (error) {
      registered = true;
      tools?.dispose();
      try { state.releasePm(lease); } catch { /* 租约到期后自然失效 */ }
      await this.runStore.update(run.id, { state: "failed", stateReason: "pm_session_failed" });
      throw protocolError("pm_session_failed", (error as Error).message);
    }
    const renewal = this.options.clock.setIntervalExcludingSleep(() => {
      void state.renewPm(lease).catch(() => { void this.stop(run.id).catch(() => {}); });
    }, PM_RENEW_MS);
    let delivering: Promise<void> | null = null;
    const delivery = this.options.clock.setIntervalExcludingSleep(() => {
      if (delivering || !alive()) return;
      delivering = deliverApprovedEvents({ repositoryRoot: this.options.repositoryRoot, dataRoot: this.options.dataRoot, repoId: this.repoId, lease,
        deliver: (text) => handle.prompt(text) }).catch(() => {})
        .then(() => { for (const message of takeUnnotifiedDecisions({ dataRoot: this.options.dataRoot, repoId: this.repoId }, input.requirementId)) handle.prompt(message); })
        .catch(() => {}).then(() => this.applyHalt(run.id)).catch(() => {})
        .then(() => this.refreshOverview(run.id)).catch(() => {}).finally(() => { delivering = null; });
    }, PM_EVENT_POLL_MS);
    this.sessions.set(run.id, { kind: "requirement", handle, pm: { lease, tools, renewal, delivery, tick: async () => { await delivering; }, haltPaused: false, halt: null } });
    registered = true;
    handle.events.on("turn", () => { void this.runStore.recordTurn(run.id).catch(() => {}); });
    this.trackUsage(run.id, handle);
    handle.events.on("failed", ({ reason }: { reason: string }) => { void this.finishPm(run.id, "failed", reason); });
    await this.runStore.update(run.id, { state: "running" });
    const running = await this.runStore.get(run.id);
    if (running.ok) this.emitRun(running.run);
    handle.prompt("开始受限接手。");
    return { runId: run.id, fence: lease.fence };
  }

  private async finishPm(runId: string, state: "failed" | "stopped", reason?: string): Promise<void> {
    const entry = this.sessions.get(runId);
    if (!entry?.pm) return;
    this.options.clock.clearTimer(entry.pm.renewal);
    this.options.clock.clearTimer(entry.pm.delivery);
    // 已开始的投递与概览刷新须结束后才释放租约与工具，避免停止后仍有迟到写入
    await entry.pm.tick();
    if (this.overviewFingerprints.delete(runId)) this.emit("pm.overview.changed", { requirementId: entry.pm.lease.requirementId, pmRunId: runId });
    entry.pm.tools.dispose();
    try { (await this.pmState()).releasePm(entry.pm.lease); } catch { /* 已被接管或到期的租约无需释放 */ }
    const current = await this.runStore.get(runId);
    if (current.ok && !isTerminalState(current.run.state)) await this.runStore.update(runId, { state, ...(reason ? { stateReason: reason } : {}) });
    delete entry.pm;
  }

  /** PM 按已冻结任务派出受限子代理：门槛与尝试登记在同一事务，子代理带运行时轮次上限，结局自动上报直属 PM。 */
  async dispatchTask(input: { pmRunId: string; taskId: string; retry: { reason: string; maxTurns: number } | null }): Promise<{ runId: string; maxTurns: number }> {
    const pm = this.sessions.get(input.pmRunId);
    if (!pm?.pm) throw protocolError("pm_not_running", "派工的 PM 会话不存在");
    const lease = pm.pm.lease;
    const pmRun = await this.runStore.get(input.pmRunId);
    if (!pmRun.ok) throw protocolError("pm_not_running", "派工的 PM 运行不存在");
    const state = await this.pmState();
    const record = state.read(lease.requirementId).data;
    const task = withDatabase(this.database, (db) => readPlanIn(db, lease.requirementId)?.tasks.find((candidate) => candidate.taskId === input.taskId));
    if (!task) throw protocolError("task_not_ready", "任务不存在");
    if (task.role === "explore") throw protocolError("role_unavailable", "explore 派工由检索入口负责");
    const entry = this.options.roleCatalog.find((candidate) => candidate.name === task.role);
    if (!entry?.available || !entry.definition || entry.definition.role !== task.role) throw protocolError("role_unavailable", entry?.reason ?? `${task.role} 定义不可用`);
    const definition = entry.definition;
    const modelRef = definition.model
      ? { provider: definition.model.slice(0, definition.model.indexOf("/")), id: definition.model.slice(definition.model.indexOf("/") + 1) }
      : pmRun.run.model;
    const thinking = definition.thinking ?? pmRun.run.thinking;
    const workspace = record.workspace!;
    const run = await this.runStore.create({ kind: "role", role: `pi-company.${task.role}`, requirement: lease.requirementId, parentRunId: input.pmRunId, task: task.taskId,
      cwd: workspace.path, readPaths: [workspace.path], writePaths: task.writePaths, model: modelRef, thinking, mcp: [] });
    let maxTurns: number;
    try { ({ maxTurns } = beginTaskAttempt({ dataRoot: this.options.dataRoot, repoId: this.repoId, lease, taskId: task.taskId, runId: run.id, retry: input.retry })); }
    catch (error) {
      await this.runStore.update(run.id, { state: "failed", stateReason: (error as { code?: string }).code ?? "dispatch_denied" });
      if (error instanceof TaskDispatchError) throw protocolError(error.code, error.message);
      throw error;
    }
    let registered = false;
    const alive = () => {
      const current = this.sessions.get(run.id), parent = this.sessions.get(input.pmRunId);
      const sessionAlive = current === undefined ? !registered : current.handle.state() === "running" || current.handle.state() === "paused";
      return sessionAlive && parent?.pm?.lease.fence === lease.fence;
    };
    let tools: Awaited<ReturnType<typeof createSubagentTools>> | undefined;
    let handle: AgentSessionHandle;
    try {
      tools = await createSubagentTools({ repositoryRoot: this.options.repositoryRoot, dataRoot: this.options.dataRoot, repoId: this.repoId, runId: run.id,
        pmLease: lease, workspace, epoch: record.epoch, task, alive });
      handle = await createAgentRoleSession({ dataRoot: this.options.dataRoot, repoId: this.repoId, runId: run.id, cwd: workspace.path, definition,
        context: await taskContext(task, maxTurns), coreTools: tools.tools, readRoots: task.role === "qa" ? [] : [workspace.path], runtime: this.options.runtime,
        modelRef, thinking, maxTurns, completion: { kind: "on-result", resultTool: coreToolName("result_submit") }, clock: this.options.clock, networkGate: this.options.networkGate });
    } catch (error) {
      registered = true;
      tools?.dispose();
      finishTaskAttempt({ dataRoot: this.options.dataRoot, repoId: this.repoId, taskId: task.taskId, runId: run.id, turnsUsed: 0, outcome: "failed" });
      await this.runStore.update(run.id, { state: "failed", stateReason: "subagent_session_failed" });
      throw protocolError("subagent_session_failed", (error as Error).message);
    }
    const toolSet = tools;
    this.sessions.set(run.id, { kind: "role", handle, subagent: { parentRunId: input.pmRunId, taskId: task.taskId, dispose: () => toolSet.dispose() } });
    registered = true;
    handle.events.on("turn_counted", () => { void this.runStore.recordTurn(run.id).catch(() => {}); });
    this.trackUsage(run.id, handle);
    handle.events.on("completed", () => { void this.finishSubagent(run.id, "completed"); });
    handle.events.on("turn_limit_reached", () => { void this.finishSubagent(run.id, "turn_limit_reached"); });
    handle.events.on("failed", () => { void this.finishSubagent(run.id, "failed"); });
    await this.runStore.update(run.id, { state: "running" });
    handle.prompt("开始执行任务。");
    return { runId: run.id, maxTurns };
  }

  private async finishSubagent(runId: string, reported: "completed" | "turn_limit_reached" | "failed" | "stopped"): Promise<void> {
    const entry = this.sessions.get(runId);
    if (!entry?.subagent) return;
    const outcome = this.supersededRuns.delete(runId) && reported === "stopped" ? "superseded" : reported;
    const { parentRunId, taskId } = entry.subagent;
    entry.subagent.dispose();
    delete entry.subagent;
    // 结局以本运行提交的分级裁决为准：只有无阻塞、无未验证项才算完成
    const report = withDatabase(this.database, (db) => db.list<{ runId?: string; conclusion?: string; summary?: string; verificationIds?: string[]; findings?: unknown[] }>(VERDICTS)
      .map((row) => row.data).find((verdict) => verdict.runId === runId));
    const effective = outcome === "completed" && report?.conclusion !== "clear" ? "incomplete" : outcome;
    const task = finishTaskAttempt({ dataRoot: this.options.dataRoot, repoId: this.repoId, taskId, runId, turnsUsed: entry.handle.turnsUsed(), outcome: effective });
    const current = await this.runStore.get(runId);
    if (current.ok && !isTerminalState(current.run.state)) {
      await this.runStore.update(runId, { state: outcome === "completed" ? "completed" : outcome === "stopped" ? "stopped" : "failed", stateReason: outcome });
    }
    const parent = this.sessions.get(parentRunId);
    const attempt = task.attempts.find((item) => item.runId === runId);
    const lines = [`子代理运行 ${runId} 已结束：任务 ${task.key}，结局 ${effective}，已用 ${attempt?.turnsUsed ?? 0}/${attempt?.maxTurns ?? 0} 轮，任务状态 ${task.status}。`,
      report ? `提交结论 ${report.conclusion}：${report.summary ?? ""}；验证引用 ${report.verificationIds?.join("、") || "无"}；分级问题 ${report.findings?.length ?? 0} 项。` : "没有提交结果。",
      task.status === "awaiting_parent" ? "请核对已有成果与原因后决定：用 retry 给出原因和新的轮次上限重试一次，或向主代理报告需求/条件不足。"
        : task.status === "awaiting_user" ? "该任务两次尝试均未完成，已进入等待用户裁决，不能再派工；请向主代理报告。" : "请核对实际证据后再整合结果。"];
    if (parent?.pm && ["running", "paused", "paused_network"].includes(parent.handle.state())) parent.handle.prompt(lines.join("\n"));
  }

  /** 结束绑定该需求的全部运行；关闭协议以运行记录终态为准。 */
  async stopRequirement(requirementId: string): Promise<void> {
    const page = await this.runStore.list({ requirement: requirementId, limit: Number.MAX_SAFE_INTEGER });
    for (const run of page.items) if (!isTerminalState(run.state)) await this.stop(run.id);
  }
  async dispatchReview(_params: { requirement: string; cwd: string; baseline: string; context?: DispatchSettingsContext; snapshot: { head: string; fingerprint: string } }): Promise<{ runId: string }> { throw retiredError(); }
  locateRequirementAgent(_requirement: string): { inject(message: string): void } | undefined { return undefined; }
  async canRunInParallel(_input: { cwd: string; requirement: string; task: string; writePaths: string[] }): Promise<{ ok: true } | { ok: false; reason: string }> { return { ok: false, reason: LEGACY_WORKFLOW_RETIRED }; }
  async verifyDelivery(_runId: string, _requirement: string, _signal?: AbortSignal): Promise<void> { throw retiredError(); }
  /** 只续接本进程内仍持有会话的暂停运行；没有会话不能证明原运行可安全续接。 */
  async resume(runId: string, options: { children?: boolean } = {}): Promise<{ state: string }> {
    const entry = this.sessions.get(runId);
    if (!entry || entry.handle.state() !== "paused") throw protocolError("not_resumable", "运行没有可续接的暂停会话");
    const run = await this.runStore.get(runId);
    if (run.ok && this.halted(run.run.requirement)) throw protocolError("requirement_halted", "任务已被用户终止，须先调整需求或取消需求");
    if (run.ok && entry.subagent && this.replanPending(run.run.requirement)) throw protocolError("plan_not_confirmed", "须先确认基于调整后批准版本的计划");
    // 恢复前当场结算终止后的统一停止，不留"先恢复、后停止"的窗口
    if (entry.subagent) {
      await this.settleHalt(entry.subagent.parentRunId);
      if (this.supersededRuns.has(runId) || this.sessions.get(runId)?.handle.state() !== "paused") throw protocolError("not_resumable", "该子代理已因计划变更被停止");
    }
    await entry.handle.resume();
    await this.runStore.update(runId, { state: "running" });
    const updated = await this.runStore.recordResume(runId, new Date().toISOString());
    this.emitRun(updated);
    // 暂停连带子代理，恢复同样连带；子代理已结束或本就在运行的跳过
    const children = (await this.runStore.list({ requirement: updated.requirement, limit: Number.MAX_SAFE_INTEGER })).items
      .filter((child) => child.parentRunId === runId && this.sessions.get(child.id)?.handle.state() === "paused");
    // 须重新确认计划时子代理保持暂停；已因计划变更待停的子代理不连带恢复，也不因此把已恢复的 PM 报成失败
    if (options.children !== false && !this.replanPending(updated.requirement)) {
      if (entry.pm) await this.settleHalt(runId);
      for (const child of children) {
        if (!this.supersededRuns.has(child.id) && this.sessions.get(child.id)?.handle.state() === "paused") await this.resume(child.id);
      }
    }
    return { state: updated.state };
  }
  async resumeAll(): Promise<{ results: Array<{ runId: string; state: string }> }> { throw retiredError(); }
  async resumeInterrupted(runId: string): Promise<{ ok: boolean; state: string; confirmed: boolean; reason?: string }> {
    const result = await this.runStore.get(runId);
    return { ok: false, state: result.ok ? result.run.state : "unknown", confirmed: false, reason: LEGACY_WORKFLOW_RETIRED };
  }
  /** 网络探测恢复只更新网络自身状态，不恢复任何旧运行。 */
  async resumeNetworkPaused(_providerId: string): Promise<void> {}
  async subscribeTranscript(_runId: string, _fromSeq: number, _windowId: string, _connected: () => boolean): Promise<Record<string, unknown>> { throw retiredError(); }
  unsubscribeTranscript(_subscriptionId: string, _windowId: string): void {}
  private metadataRows(): RunMetadata[] {
    try {
      return withLegacyReadDatabase(this.database, (db) => {
        const rows = db.prepare("SELECT id, record_key, version, data FROM records WHERE namespace = 'runs'").all();
        const items = rows.map((row) => {
          if (typeof row.record_key !== "string" || !UUID_V7_PATTERN.test(row.record_key) || row.id !== row.record_key || !Number.isSafeInteger(row.version) || Number(row.version) < 1 || typeof row.data !== "string") throw new Error("invalid");
          const run = JSON.parse(row.data) as RunRecord;
          if (run.id !== row.record_key) throw new Error("invalid");
          return runMetadata(run);
        });
        const byId = new Map(items.map((run) => [run.id, run]));
        for (const run of items) if (run.parentRunId && (byId.get(run.parentRunId)?.kind !== "requirement" || byId.get(run.parentRunId)?.requirement !== run.requirement)) throw new Error("invalid");
        return items.sort((a, b) => b.startedAt.localeCompare(a.startedAt) || a.id.localeCompare(b.id));
      });
    } catch { throw protocolError("legacy_metadata_unavailable", "运行元数据不可读，未知记录已保全待核对"); }
  }
  async status(runId: string): Promise<{ ok: true; run: RunMetadata } | { ok: false; reason: string }> {
    if (typeof runId !== "string" || !UUID_V7_PATTERN.test(runId)) return { ok: false, reason: "not_found" };
    const run = this.metadataRows().find((run) => run.id === runId);
    return run ? { ok: true, run } : { ok: false, reason: "not_found" };
  }
  async list(options: ListRunOptions & MetadataPageOptions = { limit: 100 }) {
    checkedMetadataPage(options);
    if (options.kind !== undefined && !["requirement", "role"].includes(options.kind)) throw protocolError("invalid_params", "运行查询参数无效");
    if (options.requirement !== undefined && !UUID_V7_PATTERN.test(options.requirement)) assertLegacyRequirementId(options.requirement);
    if (options.states !== undefined && (!Array.isArray(options.states) || options.states.length > 10 || options.states.some((state) => !["queued", "running", "pausing", "paused", "paused_network", "waiting_answer", "completed", "failed", "stopped", "interrupted"].includes(state)))) throw protocolError("invalid_params", "运行查询状态无效");
    const rows = this.metadataRows().filter((run) => (options.kind === undefined || run.kind === options.kind) && (options.requirement === undefined || run.requirement === options.requirement) && (options.states === undefined || options.states.includes(run.state)));
    return { ...legacyMetadataPage(rows, options, 0, true), total: rows.length, runningCount: rows.filter((run) => ["running", "pausing", "waiting_answer"].includes(run.state)).length };
  }
  private async childrenOf(run: RunRecord): Promise<RunRecord[]> {
    const page = await this.runStore.list({ kind: "role", requirement: run.requirement, limit: Number.MAX_SAFE_INTEGER });
    // 旧层级只有需求父运行和role子运行；畸形环不允许递归调用。
    const children = page.items.filter((candidate) => candidate.parentRunId === run.id);
    if ((children.length > 0 && run.kind !== "requirement") || children.some((child) => child.id === run.id || child.kind !== "role")) throw protocolError("legacy_metadata_unavailable", "运行关联无效，未知记录已保全待核对");
    return children;
  }
  private readonly overviewFingerprints = new Map<string, string>();
  /** 因计划变更被统一停止的子代理运行：其尝试记为因重新规划作废。 */
  private readonly supersededRuns = new Set<string>();
  private readonly headingCache = new Map<string, { hash: string; titles: Map<string, string> }>();

  private async headingTitles(record: RequirementRecord): Promise<Map<string, string>> {
    const hash = record.approved?.hash;
    const cached = this.headingCache.get(record.requirementId);
    if (!hash) return new Map();
    if (cached?.hash === hash) return cached.titles;
    const service = await RequirementService.open({ repositoryRoot: this.options.repositoryRoot, dataRoot: this.options.dataRoot, repoId: this.repoId,
      authorize: (request) => request.repoId === this.repoId && ["metadata", "readApproved"].includes(request.action) &&
        (request.requirementId === undefined || request.requirementId === record.requirementId) });
    const read = await service.read({ requirementId: record.requirementId, source: "approved" });
    const titles = read.prodHash === `sha256:${hash}` ? headingTitlesOf(read.body) : new Map<string, string>();
    this.headingCache.set(record.requirementId, { hash, titles });
    return titles;
  }

  /** 计算 PM 面板概览：只读持久记录与本进程会话状态，不改 PM 行为。 */
  private async overviewOf(pmRunId: string): Promise<PmOverview | null> {
    const entry = this.sessions.get(pmRunId);
    if (!entry?.pm) return null;
    const pm = await this.runStore.get(pmRunId);
    if (!pm.ok || isTerminalState(pm.run.state)) return null;
    const lease = entry.pm.lease;
    const record = (await this.pmState()).read(lease.requirementId).data;
    const children = (await this.runStore.list({ requirement: lease.requirementId, limit: Number.MAX_SAFE_INTEGER })).items.filter((run) => run.parentRunId === pmRunId);
    const headingTitles = await this.headingTitles(record);
    return withDatabase(this.database, (db) => pmOverview({ dataRoot: this.options.dataRoot, repoId: this.repoId, db, record, lease, pm: pm.run, children,
      pmIdle: entry.handle.idle(), headingTitles, now: Date.now() }));
  }

  /** 等待用户决定的时间与暂停一样不计入耗时；概览除耗时外有变化时向所有窗口广播不含正文的变更信号。 */
  private async refreshOverview(pmRunId: string): Promise<void> {
    const overview = await this.overviewOf(pmRunId);
    if (!overview) return;
    const pm = await this.runStore.get(pmRunId);
    if (pm.ok && pm.run.state === "running") {
      if (overview.status === "waiting" && !pm.run.pausedAt) this.emitRun(await this.runStore.recordPause(pmRunId, new Date().toISOString()));
      if (overview.status !== "waiting" && pm.run.pausedAt) this.emitRun(await this.runStore.recordResume(pmRunId, new Date().toISOString()));
    }
    const { elapsedMs: _elapsed, ...stable } = overview;
    const fingerprint = JSON.stringify(stable);
    if (this.overviewFingerprints.get(pmRunId) === fingerprint) return;
    this.overviewFingerprints.set(pmRunId, fingerprint);
    this.emit("pm.overview.changed", { requirementId: overview.requirementId, pmRunId });
  }

  private replanPending(requirementId: string): boolean {
    return withDatabase(this.database, (db) => {
      const current = readPlanIn(db, requirementId);
      return current !== null && replanPending(current.plan, current.tasks);
    });
  }

  private halted(requirementId: string): boolean {
    return withDatabase(this.database, (db) => {
      const record = db.read<RequirementRecord>("requirements", requirementId)?.data;
      return record !== undefined && terminationPending(readPlanIn(db, requirementId)?.tasks ?? [], record.revision);
    });
  }

  /** 用户终止任务后暂停整个需求；用户批准新的 prod 版本后只恢复 PM，此前暂停的子代理由 PM 决定。 */
  private async applyHalt(pmRunId: string): Promise<void> {
    const entry = this.sessions.get(pmRunId);
    if (!entry?.pm) return;
    const halted = this.halted(entry.pm.lease.requirementId), state = entry.handle.state();
    if (halted && !entry.pm.haltPaused) {
      // 用户先暂停再终止时也记为终止暂停，批准新版本后同样只自动恢复 PM；暂停失败则下一轮重试
      if (state === "running") await this.pause(pmRunId);
      entry.pm.haltPaused = true;
      const children = (await this.runStore.list({ requirement: entry.pm.lease.requirementId, limit: Number.MAX_SAFE_INTEGER })).items
        .filter((run) => run.parentRunId === pmRunId && ["paused", "paused_network"].includes(this.sessions.get(run.id)?.handle.state() ?? ""))
        .map((run) => run.id);
      entry.pm.halt = { children, plan: this.terminationPlanKey(entry.pm.lease.requirementId) };
    } else if (!halted && entry.pm.haltPaused && state === "paused") {
      entry.pm.haltPaused = false;
      await this.resume(pmRunId, { children: false });
    }
    await this.settleHalt(pmRunId);
  }

  /** 新计划确认后与终止时的已确认计划有变更：原暂停子代理统一停止，由 PM 按新计划重新派出；未确认前不结算。 */
  private async settleHalt(pmRunId: string): Promise<void> {
    const entry = this.sessions.get(pmRunId), halt = entry?.pm?.halt;
    if (!entry?.pm || !halt) return;
    const requirementId = entry.pm.lease.requirementId;
    if (this.halted(requirementId) || this.replanPending(requirementId)) return;
    entry.pm.halt = null;
    if (withDatabase(this.database, (db) => confirmedPlanKey(readPlanIn(db, requirementId)?.plan)) === halt.plan) return;
    // 先整体标记为待停，再逐个停止：停止期间对名单内任何子代理的恢复都被拒绝
    for (const child of halt.children) this.supersededRuns.add(child);
    for (const child of halt.children) await this.stop(child).catch(() => {});
  }

  /** 最近一次终止决定登记时的已确认计划指纹。 */
  private terminationPlanKey(requirementId: string): string {
    return withDatabase(this.database, (db) => {
      const current = readPlanIn(db, requirementId);
      const latest = (current?.tasks ?? []).filter((task) => task.userDecision?.choice === "terminate")
        .sort((a, b) => b.userDecision!.revision - a.userDecision!.revision)[0];
      return latest?.userDecision?.confirmedPlan ?? confirmedPlanKey(current?.plan);
    });
  }

  /** 本仓库全部运行中/暂停的 PM 概览，供任一主窗口拉取。 */
  async overviews(): Promise<PmOverview[]> {
    const result: PmOverview[] = [];
    for (const [runId, entry] of this.sessions) {
      if (!entry.pm) continue;
      const overview = await this.overviewOf(runId);
      if (overview) result.push(overview);
    }
    return result;
  }

  /** 模型每次回复的用量与每次工具结束都累加进本运行记录；PM 与子代理的汇总在读取时按父运行相加。 */
  private trackUsage(runId: string, handle: AgentSessionHandle): void {
    const record = (delta: Parameters<RunStore["recordUsage"]>[1]) => {
      void this.runStore.recordUsage(runId, delta).then((run) => this.emitRun(run)).catch(() => {});
    };
    handle.events.on("usage", (usage: { input: number; output: number; cacheRead: number; cacheWrite: number }) => record(usage));
    handle.events.on("tool_end", () => record({ toolUses: 1 }));
  }
  private emitRun(run: RunRecord): void { this.emit("runs.changed", { run: runMetadata(run) }); }

  async pause(runId: string): Promise<{ state: string; confirmed: boolean; reason?: string }> {
    const result = await this.runStore.get(runId);
    if (!result.ok) throw protocolError("not_found", "运行不存在");
    const run = result.run;
    if (isTerminalState(run.state)) {
      let confirmed = await this.verifyRunShells(run, false);
      for (const child of await this.childrenOf(run)) if (!await this.verifyRunShells(child, false)) confirmed = false;
      return { state: run.state, confirmed, ...(!confirmed ? { reason: "进程结束尚未核对" } : {}) };
    }
    if (!["running", "waiting_answer", "pausing", "paused", "paused_network"].includes(run.state)) return { state: run.state, confirmed: false, reason: "运行状态不可暂停" };
    // 没有内存会话不能证明进程已停；已有 Shell 仍由安全停止入口核验。
    const entry = this.sessions.get(runId);
    if (!entry) return { state: run.state, confirmed: false, reason: "没有可确认暂停的会话，请使用安全停止并核对进程" };
    if (run.state === "paused" || run.state === "paused_network") return { state: run.state, confirmed: true };
    if (run.state === "running" || run.state === "waiting_answer") await this.runStore.update(runId, { state: "pausing" });
    const children = (await this.childrenOf(run)).filter((child) => !isTerminalState(child.state) && child.state !== "interrupted" && child.state !== "queued");
    const childResults = await Promise.all(children.map((child) => this.pause(child.id)));
    const outcome = await entry.handle.pause();
    const confirmed = outcome.confirmed && childResults.every((child) => child.confirmed);
    if (confirmed) {
      await this.runStore.update(runId, { state: "paused" });
      await this.runStore.recordPause(runId, new Date().toISOString());
    }
    const updated = await this.runStore.get(runId);
    if (updated.ok) this.emitRun(updated.run);
    return { state: confirmed ? "paused" : "pausing", confirmed, ...(!confirmed ? { reason: "会话或子运行尚未确认暂停" } : {}) };
  }
  async stop(runId: string): Promise<{ state: string; confirmed: boolean; reason?: string }> {
    const result = await this.runStore.get(runId);
    if (!result.ok) throw protocolError("not_found", "运行不存在");
    let run = result.run;
    let requested = false;
    if (!isTerminalState(run.state)) {
      try { run = await this.runStore.update(runId, { state: "stopped" }); requested = true; }
      catch (error) {
        const latest = await this.runStore.get(runId);
        if (!latest.ok || !isTerminalState(latest.run.state)) throw error;
        run = latest.run;
      }
    }
    if (requested) this.emitRun(run);
    const entry = this.sessions.get(runId);
    const [sessionStop, shellStop, childrenStop] = await Promise.allSettled([
      entry ? entry.handle.stop() : Promise.resolve({ stopped: true }),
      this.verifyRunShells(run, true),
      this.childrenOf(run).then((children) => Promise.all(children.map((child) => this.stop(child.id)))),
    ]);
    const reasons: string[] = [];
    if (sessionStop.status === "rejected") reasons.push("会话停止失败");
    else if (!sessionStop.value.stopped) reasons.push("会话操作尚未确认停止");
    if (shellStop.status === "rejected") reasons.push("Shell 停止失败");
    else if (!shellStop.value) reasons.push("Shell 接管或进程结束尚未确认");
    if (childrenStop.status === "rejected") reasons.push("子运行停止失败");
    else if (childrenStop.value.some((child) => !child.confirmed)) reasons.push("子运行尚未确认停止");
    const confirmed = reasons.length === 0;
    if (confirmed && entry?.pm) await this.finishPm(runId, "stopped");
    if (confirmed && entry?.subagent) await this.finishSubagent(runId, "stopped");
    if (confirmed && this.sessions.get(runId) === entry) { entry?.handle.dispose(); this.sessions.delete(runId); }
    const reason = confirmed ? undefined : reasons.join("；");
    if (run.state === "stopped") await this.runStore.update(runId, { stateReason: reason ?? "" });
    const updated = await this.runStore.get(runId);
    if (updated.ok) this.emitRun(updated.run);
    if (requested) await this.relayQueue.notify({ requirement: run.requirement, repoId: this.repoId, runId, kind: "stopped", message: confirmed ? `运行 ${runId} 已确认停止` : `运行 ${runId} 已接受停止请求；${reason}` }).catch(() => {});
    return { state: run.state, confirmed, ...(reason ? { reason } : {}) };
  }
  async pauseAll(): Promise<{ results: Array<{ runId: string; state: string; confirmed: boolean; reason?: string }> }> {
    const page = await this.runStore.list({ limit: Number.MAX_SAFE_INTEGER });
    const topLevel = page.items.filter((run) => !isTerminalState(run.state) && run.state !== "interrupted" && (run.kind === "requirement" || run.parentRunId === undefined));
    const results = [];
    for (const run of topLevel) results.push({ runId: run.id, ...(await this.pause(run.id)) });
    return { results };
  }
  private async runsForStop(): Promise<{ runs: RunRecord[]; unknown: number }> {
    const rows = withLegacyReadDatabase(this.database, (db) => db.prepare("SELECT id, record_key FROM records WHERE namespace = 'runs'").all());
    const runs: RunRecord[] = []; let unknown = 0;
    for (const row of rows) {
      if (typeof row.record_key !== "string" || !UUID_V7_PATTERN.test(row.record_key) || row.id !== row.record_key) { unknown++; continue; }
      const result = await this.runStore.get(row.record_key);
      if (result.ok) runs.push(result.run); else unknown++;
    }
    return { runs, unknown };
  }
  async stopAll() {
    let unknown = 0;
    const results: Array<{ runId: string; state: string; confirmed: boolean; reason?: string }> = [];
    try {
      const page = await this.runsForStop(); unknown += page.unknown;
      // 展示分页及旧终态不决定停止范围；一个坏记录不遮蔽其他可定位运行。
      for (const run of page.runs) {
        try { runMetadata(run); results.push({ runId: run.id, ...(await this.stop(run.id)) }); }
        catch { unknown++; await this.verifyRunShells(run, true); }
      }
    } catch { unknown++; }
    let shellUnconfirmed = 0;
    const hosts = new Map<string, Host>();
    for (const task of this.shellRegistry.list()) hosts.set(JSON.stringify(task.host), task.host);
    for (const host of hosts.values()) {
      try { shellUnconfirmed += (await this.shellRegistry.stopHost(host)).filter(({ result }) => !result.ok || !this.verifiedEnd(result.task)).length; }
      catch { shellUnconfirmed++; }
    }
    try { unknown += this.persistedShells().filter((row) => { const task = this.shellRegistry.get(row.taskId as string); return !task || !this.verifiedEnd(task) || task.pid !== row.pid || task.startedAt !== row.startedAt; }).length; }
    catch { unknown++; }
    const page = legacyMetadataPage(results, { limit: 100 }, unknown);
    return { results: page.items, coverage: { ...page.coverage, confirmed: results.filter((item) => item.confirmed).length,
      unconfirmed: results.filter((item) => !item.confirmed).length, shellUnconfirmed, notice: "停止已遍历全部可读运行及已知Shell；未知或未确认项仍受阻，展示可能分页" } };
  }
  private verifiedEnd(task: TaskRecord): boolean {
    return ["exited", "stopped", "timed_out"].includes(task.status) && task.activity === "ended" && task.stoppedBy !== "user" && task.identityVerified && task.descendantsScanned;
  }
  private persistedShells() {
    return withLegacyReadDatabase(this.database, (db) => db.prepare("SELECT record_key, json_extract(data, '$.taskId') AS taskId, json_extract(data, '$.token') AS token, json_extract(data, '$.pid') AS pid, json_extract(data, '$.pgid') AS pgid, json_extract(data, '$.startedAt') AS startedAt, json_extract(data, '$.host.id') AS hostId, json_extract(data, '$.host.runId') AS runId FROM records WHERE namespace = 'shells'").all().map((row) => {
      if (typeof row.taskId !== "string" || row.taskId.length > 128 || row.taskId !== row.record_key || typeof row.token !== "string" || row.token.length > 256 || !Number.isSafeInteger(row.pid) || Number(row.pid) <= 1 || !Number.isSafeInteger(row.pgid) || Number(row.pgid) <= 1 || row.startedAt !== null && !Number.isSafeInteger(row.startedAt)) throw new Error("Shell 持久身份不可读");
      return row;
    }));
  }
  private async verifyRunShells(run: RunRecord, stop: boolean): Promise<boolean> {
    let confirmed = false;
    try {
      if (typeof run.shellToken !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[47][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(run.shellToken)) throw new Error("Shell 令牌无效");
      // 每次重新核对持久记录与当前令牌；空内存表和旧stateReason都不是停止证明。
      const adopted = await this.shellRegistry.adoptOrphans({ runToken: run.shellToken, owner: taskHost(run) });
      const results = stop ? await this.shellRegistry.stopHost(taskHost(run)) : [];
      const tasks = this.shellRegistry.list().filter((task) => task.host.id === run.id || task.host.runId === run.id);
      const records = this.persistedShells().filter((row) => (row.token as string).startsWith(`${run.shellToken}:`) || row.hostId === run.id || row.runId === run.id);
      confirmed = adopted.ok && results.every(({ result }) => result.ok && this.verifiedEnd(result.task)) && tasks.every((task) => this.verifiedEnd(task))
        && records.every((row) => {
          const task = this.shellRegistry.get(row.taskId as string);
          return (row.token as string).startsWith(`${run.shellToken}:`) && task !== undefined && task.pid === row.pid && task.pgid === row.pgid && task.startedAt === row.startedAt && this.verifiedEnd(task);
        });
    } catch { confirmed = false; }
    if (confirmed) this.unconfirmedAdoptions.delete(run.id); else this.unconfirmedAdoptions.add(run.id);
    return confirmed;
  }
  async adoptInterruptedShells(): Promise<void> {
    const page = await this.runStore.list({ limit: Number.MAX_SAFE_INTEGER });
    for (const run of page.items) {
      if (!await this.verifyRunShells(run, false)) await this.runStore.update(run.id, { stateReason: "Shell 接管或进程结束尚未确认" });
    }
  }
  async close(): Promise<void> {
    let failed = false;
    // 查询失败不阻止尝试停止内存中仍可定位的其他进程。
    try {
      const page = await this.runsForStop();
      if (page.unknown) failed = true;
      for (const run of page.runs) {
        if (!await this.verifyRunShells(run, true)) {
          failed = true;
          try { await this.runStore.update(run.id, { stateReason: "Shell 接管或进程结束尚未确认" }); }
          catch { /* 已确认的其他停止事实保留；关闭仍失败。 */ }
        }
      }
    } catch { failed = true; }
    const hosts = new Map<string, Host>();
    for (const task of this.shellRegistry.list()) hosts.set(JSON.stringify(task.host), task.host);
    for (const host of hosts.values()) {
      try {
        const results = await this.shellRegistry.stopHost(host);
        if (results.some(({ result }) => !result.ok || !this.verifiedEnd(result.task))) failed = true;
      } catch { failed = true; }
    }
    try {
      if (this.persistedShells().some((row) => {
        const task = this.shellRegistry.get(row.taskId as string);
        return !task || task.pid !== row.pid || task.pgid !== row.pgid || task.startedAt !== row.startedAt || !this.verifiedEnd(task);
      })) failed = true;
    } catch { failed = true; }
    if (failed || this.unconfirmedAdoptions.size > 0) throw protocolError("stop_unconfirmed", "关闭未完成：Shell 身份或进程结束尚未确认，保留现场待重试");
  }
  async wait(runId: string, timeoutMs = DEFAULT_WAIT_TIMEOUT_MS): Promise<{ state: string }> {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const result = await this.runStore.get(runId);
      if (!result.ok) throw protocolError("not_found", "运行不存在");
      if (isTerminalState(result.run.state) || Date.now() >= deadline) return { state: result.run.state };
      await new Promise((resolve) => setTimeout(resolve, Math.min(100, deadline - Date.now())));
    }
  }
}

export function registerProtocolHandlers(input: { server: DaemonServer; manager: RunManager; relayQueue: RelayQueue; shellRegistry: ShellRegistry }): void {
  const { server, manager, shellRegistry } = input;
  const register = (method: string, handler: (params: Record<string, unknown>, client: ClientInfo) => Promise<Record<string, unknown>>): void => {
    server.registerHandler(method, async (params, client) => {
      await manager.awaitStarted();
      try { return await handler(params, client); }
      catch (error) {
        if (error instanceof Error && ["legacy_workflow_retired", "trusted_stop_required", "stop_unconfirmed", "legacy_metadata_unavailable", "not_found", "invalid_params",
          "requirement_not_active", "workspace_not_ready", "role_unavailable", "model_unavailable", "pm_already_owned", "stale_fence", "acquire_failed", "pm_session_failed", "not_resumable", "implement_not_authorized", "pm_not_running", "task_not_ready", "subagent_session_failed",
          "intake_gate", "pending_update", "plan_not_confirmed", "dependency_pending", "question_pending", "check_phase_active", "retry_required", "retry_exhausted", "retry_not_needed", "requirement_halted"].includes((error as { code?: string }).code ?? "")) throw error;
        throw protocolError("legacy_metadata_unavailable", "旧运行状态不可读或操作尚未确认，未知记录已保全待核对");
      }
    });
  };
  // RPC 层与执行器分别拒绝；过期客户端不能靠旧方法名进入执行器。
  register("agents.dispatchPm", async (params) => {
    const model = params.model as { provider?: unknown; id?: unknown } | undefined;
    if (typeof params.requirementId !== "string" || !UUID_V7_PATTERN.test(params.requirementId) || typeof model?.provider !== "string" || typeof model.id !== "string"
      || typeof params.thinking !== "string") throw protocolError("invalid_params", "派出 PM 参数无效");
    return manager.dispatchPm({ requirementId: params.requirementId, model: { provider: model.provider, id: model.id }, thinking: params.thinking });
  });
  register("runs.resume", async (params) => manager.resume(params.runId as string));
  register("pm.overview", async () => ({ items: await manager.overviews() }));
  for (const method of ["dispatch.requirement", "dispatch.review", "runs.resumeAll", "runs.resumeInterrupted", "relay.answer", "relay.forward", "subscribe.transcript"]) {
    register(method, async () => { throw retiredError(); });
  }
  register("runs.list", async (params) => manager.list({ kind: params.kind as RunKind | undefined, offset: params.offset as number | undefined, limit: params.limit === undefined ? 100 : params.limit as number }));
  register("runs.get", async (params) => {
    const result = await manager.status(params.runId as string);
    if (!result.ok) throw protocolError("not_found", "运行不存在");
    return { run: result.run };
  });
  register("runs.pause", async (params) => manager.pause(params.runId as string));
  register("runs.stop", async (params) => manager.stop(params.runId as string));
  register("runs.pauseAll", async () => manager.pauseAll());
  register("runs.stopAll", async () => manager.stopAll());
  register("relay.pending", async () => ({ questions: [], notices: [] }));
  register("shells.list", async () => ({ tasks: shellRegistry.list().map(shellMetadata) }));
  register("shells.stop", async (params) => {
    const taskId = params.taskId as string;
    const task = shellRegistry.get(taskId);
    if (!task) return { status: "not_found", reason: "未知任务" };
    if (task.pid !== params.expectedPid || String(task.startedAt) !== params.expectedStartedAt) return { status: "mismatch", reason: "任务身份已变化" };
    const result = await shellRegistry.stop(taskId);
    return result.ok ? { status: result.task.status } : { status: "error", reason: "Shell 进程尚未确认停止" };
  });
  register("shells.markStopped", async () => {
    throw protocolError("trusted_stop_required", "缺少可信的人工停止裁定入口；USER 字符串不能证明进程已停止，请使用安全停止并核对真实进程");
  });
  register("subscribe.activity", async () => {
    const page = await manager.list({ limit: 100 });
    return { subscriptionId: randomUUID(), snapshot: page.items, coverage: page.coverage };
  });
  register("unsubscribe", async () => ({}));
  server.onHello = async () => {};
  server.markHandlersReady();
}
