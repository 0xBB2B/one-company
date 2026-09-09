import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { resolve as resolvePath, sep } from "node:path";
import type { EventEmitter } from "node:events";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Clock } from "../runtime/clock.ts";
import { repositoryIdentity, runDataDir } from "../runtime/identity.ts";
import type { ErrorDetailsSummary } from "../runtime/error-details.ts";
import { summarizeErrorDetails, writeErrorDetails } from "../runtime/error-details.ts";
import type { NetworkPauseGate } from "../runtime/network-pause.ts";
import { fingerprint as rangesFingerprint, verifyFingerprint as rangesVerifyFingerprint } from "../runtime/ranges.ts";
import type { RoleCatalogEntry } from "../runtime/roles.ts";
import { ACCEPTANCE_SCHEMA, REVIEW_SCHEMA, WORK_SCHEMA } from "../runtime/result.ts";
import type { CreateRunInput, ListRunOptions, ListRunResult, RunKind, RunRecord } from "../runtime/run-store.ts";
import { isTerminalState, RunStore } from "../runtime/run-store.ts";
import { synthesizeInterruptedResults } from "../runtime/session-records.ts";
import type { Host, ShellRegistry, TaskRecord, TaskStatus } from "../runtime/shell-registry.ts";
import { executeWorkflowAction } from "../runtime/workflow-tool.ts";
import type { RelayQueue } from "./relay-queue.ts";
import { bestEffortRealpath, createRoleSession, withinScope } from "./role-session.ts";
import type { RoleOutputContract, RoleSessionGuards, RoleSessionHandle } from "./role-session.ts";
import { createRequirementAgentSession, resumeRequirementAgentSession } from "./requirement-agent.ts";
import type {
  RequirementAgentDispatch,
  RequirementAgentHandle,
  RequirementAgentRelay,
} from "./requirement-agent.ts";
import type { ClientInfo, DaemonServer } from "./server.ts";

export interface SelectedModel {
  provider: string;
  id: string;
}

export type ModelSelector = (input: { roleName: string; taskId?: string }) => SelectedModel;

export type EmitFn = (
  event: string,
  data: Record<string, unknown>,
  filter?: (windowId: string) => boolean,
) => void;

export interface RunManagerOptions {
  dataRoot: string;
  repoId: string;
  runStore: RunStore;
  shellRegistry: ShellRegistry;
  networkGate: NetworkPauseGate;
  relayQueue: RelayQueue;
  roleCatalog: RoleCatalogEntry[];
  runtime: ModelRuntime;
  selectModel: ModelSelector;
  clock: Clock;
  workspaceRepoIds: string[];
  emit: EmitFn;
}

type DispatchCaller = { kind: "requirement"; runId: string } | { kind: "window" };

interface SessionEntry {
  kind: RunKind;
  handle: RoleSessionHandle | RequirementAgentHandle;
  requirement: string;
  parentRunId?: string;
  writePaths: string[];
}

type DispatchOutcome = { ok: true; runId: string } | { ok: false; reason: string };

const ACTIVE_OR_UNCERTAIN_TASK_STATUSES = new Set<TaskStatus>(["starting", "running", "stopping", "uncertain"]);
const WAIT_POLL_INTERVAL_MS = 100;
const DEFAULT_WAIT_TIMEOUT_MS = 300_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function segmentOverlaps(a: string, b: string): boolean {
  if (a === b) return true;
  const da = a.endsWith("/") ? a : `${a}/`;
  const db = b.endsWith("/") ? b : `${b}/`;
  return da.startsWith(db) || db.startsWith(da);
}

function pathsOverlap(a: string[], b: string[]): boolean {
  return a.some((x) => b.some((y) => segmentOverlaps(x, y)));
}

function resolveWritePaths(cwd: string, paths: string[]): string[] {
  return paths.map((p) => resolvePath(cwd, p));
}

type OutputContractResult = { ok: true; contract: RoleOutputContract } | { ok: false; reason: string };

// 结果格式（含收尾方式）由角色定义的 kind 决定，不是派工参数；plan 单轮即完成，没有结构化契约可言；
// 未知 kind 明确拒绝派工，不静默套用某个默认契约
function outputContractForRole(roleEntry: RoleCatalogEntry): OutputContractResult {
  const kind = roleEntry.definition?.kind;
  if (kind === "work") return { ok: true, contract: { kind: "structured", outputSchema: WORK_SCHEMA, expectedPhase: "work" } };
  if (kind === "review") return { ok: true, contract: { kind: "structured", outputSchema: REVIEW_SCHEMA, expectedPhase: "review" } };
  if (kind === "acceptance") {
    return { ok: true, contract: { kind: "structured", outputSchema: ACCEPTANCE_SCHEMA, expectedPhase: "acceptance" } };
  }
  if (kind === "plan") return { ok: true, contract: { kind: "plain", completion: "complete-on-idle" } };
  return { ok: false, reason: `角色 ${roleEntry.name} 的 kind 不支持派工: ${kind ?? "未知"}` };
}

function taskHost(run: RunRecord): Host {
  return { kind: "role", id: run.id, role: run.role, runId: run.id };
}

function protocolError(code: string, message: string, data?: Record<string, unknown>): Error & { code: string; data?: Record<string, unknown> } {
  const error = new Error(message) as Error & { code: string; data?: Record<string, unknown> };
  error.code = code;
  if (data) error.data = data;
  return error;
}

export class RunManager {
  private readonly dataRoot: string;
  private readonly repoId: string;
  private readonly runStore: RunStore;
  private readonly shellRegistry: ShellRegistry;
  private readonly networkGate: NetworkPauseGate;
  private readonly relayQueue: RelayQueue;
  private readonly roleCatalog: RoleCatalogEntry[];
  private readonly runtime: ModelRuntime;
  private readonly selectModel: ModelSelector;
  private readonly clock: Clock;
  private readonly workspaceRepoIds: string[];
  private readonly emit: EmitFn;
  private readonly sessions = new Map<string, SessionEntry>();
  // 角色 idle 续跑提醒的上界：每个角色运行最多提醒一次，避免和用户显式停止前的观察窗口无限拉锯
  private readonly idleReminded = new Set<string>();
  private allPaused = false;
  private started = false;
  private resolveStarted!: () => void;
  private readonly startedPromise: Promise<void>;
  // 冲突检查（canRunInParallel）与运行创建必须作为一个不可分割的临界区，
  // 否则两个并发派工请求可能都通过检查后各自创建出写入范围重叠的运行
  private dispatchLock: Promise<unknown> = Promise.resolve();

  constructor(options: RunManagerOptions) {
    this.startedPromise = new Promise((resolve) => {
      this.resolveStarted = resolve;
    });
    this.dataRoot = options.dataRoot;
    this.repoId = options.repoId;
    this.runStore = options.runStore;
    this.shellRegistry = options.shellRegistry;
    this.networkGate = options.networkGate;
    this.relayQueue = options.relayQueue;
    this.roleCatalog = options.roleCatalog;
    this.runtime = options.runtime;
    this.selectModel = options.selectModel;
    this.clock = options.clock;
    this.workspaceRepoIds = options.workspaceRepoIds;
    this.emit = options.emit;
  }

  // 启动期 markInterruptedOnStartup 与 adoptInterruptedShells 之间的运行状态对客户端不算最终态；
  // 在两者都完成前挂起协议方法而非报错，避免刚重启时的极短窗口期内续接请求误判为无遗留任务
  markStarted(): void {
    if (this.started) return;
    this.started = true;
    this.resolveStarted();
  }

  async awaitStarted(): Promise<void> {
    if (this.started) return;
    await this.startedPromise;
  }

  private findRole(name: string): RoleCatalogEntry | undefined {
    return this.roleCatalog.find((entry) => entry.name === name);
  }

  private withDispatchLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.dispatchLock.then(fn, fn);
    this.dispatchLock = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async childrenOf(run: RunRecord): Promise<RunRecord[]> {
    const page = await this.runStore.list({ kind: "role", requirement: run.requirement, limit: 500 });
    return page.items.filter((candidate) => candidate.parentRunId === run.id);
  }

  private buildGuards(cwd: string, writePaths: string[]): RoleSessionGuards {
    return {
      checkWrite: async (path: string) => {
        const real = await bestEffortRealpath(resolvePath(cwd, path));
        const allowed = writePaths.some((wp) => {
          const boundary = resolvePath(cwd, wp);
          return real === boundary || real.startsWith(`${boundary}${sep}`);
        });
        return allowed ? { ok: true as const } : { ok: false as const, reason: `写入路径超出授权范围: ${path}` };
      },
      fingerprint: (paths: string[]) => rangesFingerprint(cwd, paths),
      verifyFingerprint: (fp: Record<string, string>) => rangesVerifyFingerprint(cwd, fp),
    };
  }

  private async assertOwnsCwd(cwd: string): Promise<string> {
    const realCwd = await bestEffortRealpath(resolvePath(cwd));
    let identity;
    try {
      identity = await repositoryIdentity(realCwd);
    } catch (error) {
      throw new Error(`cwd 不属于任何 Git 仓库: ${(error as Error).message}`);
    }
    if (identity.repoId !== this.repoId) {
      throw new Error(`cwd 不属于本仓库: ${cwd}`);
    }
    return realCwd;
  }

  async dispatchRequirement(input: { requirement: string; cwd: string }): Promise<{ runId: string }> {
    if (this.allPaused) throw protocolError("daemon_busy", "本仓库已全部暂停，暂不接受新派工");
    const realCwd = await this.assertOwnsCwd(input.cwd);

    const stateResult = await executeWorkflowAction(
      { action: "query", requirement: input.requirement },
      { dataRoot: this.dataRoot, cwd: realCwd },
    );
    if (stateResult.details.isError) throw new Error(stateResult.text);
    const stage = (stateResult.details.data as { stage: string }).stage;
    if (stage === "draft") throw protocolError("not_confirmed", `需求尚未确认: ${input.requirement}`);

    const roleEntry = this.findRole("requirement-agent");
    if (!roleEntry) throw new Error("角色目录缺少 requirement-agent");
    const modelRef = this.selectModel({ roleName: "requirement-agent" });

    const result = await createRequirementAgentSession({
      dataRoot: this.dataRoot,
      repoId: this.repoId,
      requirement: input.requirement,
      cwd: realCwd,
      role: roleEntry,
      roleCatalog: this.roleCatalog,
      runtime: this.runtime,
      modelRef,
      clock: this.clock,
      shellRegistry: this.shellRegistry,
      guards: this.buildGuards(realCwd, [realCwd]),
      networkGate: this.networkGate,
      dispatch: this.buildRequirementDispatch(realCwd, input.requirement),
      relay: this.buildRequirementRelay(input.requirement),
      runStore: this.runStore,
      workspaceRepoIds: this.workspaceRepoIds,
    });

    if (!result.ok) throw new Error(result.reason);
    if (result.reused) throw protocolError("already_active", "该需求已有活动的需求代理运行", { runId: result.runId });

    this.registerSession(result.runId, {
      kind: "requirement",
      handle: result.handle,
      requirement: input.requirement,
      writePaths: [realCwd],
    });
    result.handle.prompt("请先提议工作流形状并等待确认，随后按已确认形状统筹推进需求，需要用户决策时用提问工具。");
    return { runId: result.runId };
  }

  async dispatchReview(params: {
    requirement: string;
    cwd: string;
    baseline: string;
    snapshot: { head: string; fingerprint: string };
  }): Promise<{ runId: string }> {
    const realCwd = await this.assertOwnsCwd(params.cwd);
    const instructions = `对提交前的完整变更执行白盒审查。基线：${params.baseline}；审查快照 head：${params.snapshot.head}；内容指纹：${params.snapshot.fingerprint}。`;
    const outcome = await this.dispatchRoleInternal(
      { kind: "window" },
      {
        requirement: params.requirement,
        cwd: realCwd,
        role: "reviewer",
        task: "submit-review",
        instructions,
        writePaths: [],
        readPaths: [realCwd],
      },
    );
    if (!outcome.ok) throw new Error(outcome.reason);
    return { runId: outcome.runId };
  }

  private findRequirementSession(requirement: string): [string, SessionEntry] | undefined {
    return [...this.sessions.entries()].find(([, entry]) => entry.kind === "requirement" && entry.requirement === requirement);
  }

  locateRequirementAgent(requirement: string): { inject(message: string): void } | undefined {
    const found = this.findRequirementSession(requirement);
    if (!found) return undefined;
    const [, entry] = found;
    return { inject: (message: string) => entry.handle.prompt(message) };
  }

  private buildRequirementDispatch(cwd: string, requirement: string): RequirementAgentDispatch {
    return {
      dispatchRole: async (input) => {
        const parentRunId = this.findRequirementSession(requirement)?.[0];
        if (!parentRunId) return { ok: false, reason: "调用方不是有效的需求代理运行" };
        return this.dispatchRoleInternal(
          { kind: "requirement", runId: parentRunId },
          {
            requirement,
            cwd,
            role: input.role,
            task: input.task,
            instructions: input.instructions,
            writePaths: input.writePaths,
            readPaths: input.readPaths,
            reportPath: input.reportPath,
          },
        );
      },
      status: async (runId) => {
        const result = await this.runStore.get(runId);
        return result.ok ? { ok: true, state: result.run.state } : { ok: false, reason: result.reason };
      },
      wait: async (runId) => {
        try {
          const result = await this.wait(runId, DEFAULT_WAIT_TIMEOUT_MS);
          return { ok: true, state: result.state };
        } catch (error) {
          return { ok: false, reason: (error as Error).message };
        }
      },
      list: async () => {
        const page = await this.runStore.list({ kind: "role", requirement, limit: 500 });
        return page.items.map((run) => ({ runId: run.id, role: run.role ?? "", task: run.task, state: run.state }));
      },
      cancel: async (runId) => {
        try {
          await this.stop(runId);
          return { ok: true };
        } catch (error) {
          return { ok: false, reason: (error as Error).message };
        }
      },
    };
  }

  private buildRequirementRelay(requirement: string): RequirementAgentRelay {
    return {
      ask: async (input, opts) => {
        const runId = this.findRequirementSession(requirement)?.[0] ?? requirement;
        const handle = await this.relayQueue.ask({
          requirement,
          repoId: this.repoId,
          runId,
          question: input.question,
          options: input.options ?? [],
          recommended: input.recommended ?? input.options?.[0]?.label ?? "",
        });
        const signal = opts?.signal;
        const onAbort = () => {
          void this.relayQueue.withdraw(handle.id);
        };
        if (signal) {
          if (signal.aborted) onAbort();
          else signal.addEventListener("abort", onAbort, { once: true });
        }
        try {
          const outcome = await handle.answer;
          if (!outcome.answered) {
            const error = new Error("提问被撤回") as Error & { name: string };
            error.name = "AbortError";
            throw error;
          }
          return outcome.answer;
        } finally {
          signal?.removeEventListener("abort", onAbort);
        }
      },
    };
  }

  private async dispatchRoleInternal(
    caller: DispatchCaller,
    params: {
      requirement: string;
      cwd: string;
      role: string;
      task: string;
      instructions?: string;
      writePaths: string[];
      readPaths: string[];
      reportPath?: string;
    },
  ): Promise<DispatchOutcome> {
    if (this.allPaused) return { ok: false, reason: "本仓库已全部暂停，暂不接受新派工" };

    if (caller.kind === "requirement") {
      const entry = this.sessions.get(caller.runId);
      if (!entry || entry.kind !== "requirement") return { ok: false, reason: "调用方不是有效的需求代理运行" };
    } else if (params.role !== "reviewer") {
      return { ok: false, reason: "窗口连接只能派出提交前白盒审查者" };
    }

    const roleEntry = this.findRole(params.role);
    if (!roleEntry || !roleEntry.available) return { ok: false, reason: `角色不在目录内: ${params.role}` };

    let reportPath: string | undefined;
    if (params.role === "acceptance") {
      if (!params.reportPath) return { ok: false, reason: "验收角色派工缺少 reportPath" };
      if (!(await withinScope(params.cwd, params.reportPath, [params.cwd]))) {
        return { ok: false, reason: `报告路径越出需求 cwd: ${params.reportPath}` };
      }
      reportPath = params.reportPath;
    }

    return this.withDispatchLock(async () => {
      const conflict = await this.canRunInParallel({
        cwd: params.cwd,
        requirement: params.requirement,
        task: params.task,
        writePaths: params.writePaths,
      });
      if (!conflict.ok) return { ok: false, reason: conflict.reason };

      return this.startRoleRun({
        parentRunId: caller.kind === "requirement" ? caller.runId : undefined,
        standalone: caller.kind !== "requirement",
        requirement: params.requirement,
        cwd: params.cwd,
        role: params.role,
        roleEntry,
        task: params.task,
        instructions: params.instructions,
        writePaths: params.writePaths,
        readPaths: params.readPaths,
        reportPath,
      });
    });
  }

  private async startRoleRun(input: {
    parentRunId?: string;
    standalone: boolean;
    requirement: string;
    cwd: string;
    role: string;
    roleEntry: RoleCatalogEntry;
    task: string;
    instructions?: string;
    writePaths: string[];
    readPaths: string[];
    reportPath?: string;
  }): Promise<DispatchOutcome> {
    const taskId = /^T-\d+$/.test(input.task) ? input.task : undefined;
    let modelRef: SelectedModel;
    try {
      modelRef = this.selectModel({ roleName: input.role, taskId });
    } catch (error) {
      return { ok: false, reason: (error as Error).message };
    }

    const outputContract = outputContractForRole(input.roleEntry);
    if (!outputContract.ok) return { ok: false, reason: outputContract.reason };

    const createInput: CreateRunInput = {
      kind: "role",
      role: `pi-company.${input.role}`,
      parentRunId: input.parentRunId,
      standalone: input.standalone,
      requirement: input.requirement,
      task: input.task,
      cwd: input.cwd,
      writePaths: input.writePaths,
      readPaths: input.readPaths,
      reportPath: input.reportPath,
      model: modelRef,
      thinking: "high",
      mcp: [],
    };
    const run = await this.runStore.create(createInput);
    await this.runStore.update(run.id, { state: "running" });

    let handle: RoleSessionHandle;
    try {
      handle = await createRoleSession({
        dataRoot: this.dataRoot,
        repoId: this.repoId,
        runId: run.id,
        shellToken: run.shellToken,
        cwd: input.cwd,
        roleName: input.role,
        role: input.roleEntry,
        task: input.instructions ?? input.task,
        readPaths: input.readPaths,
        writePaths: input.writePaths,
        reportPath: input.reportPath,
        contract: outputContract.contract,
        runtime: this.runtime,
        modelRef,
        clock: this.clock,
        shellRegistry: this.shellRegistry,
        guards: this.buildGuards(input.cwd, input.writePaths),
        networkGate: this.networkGate,
      });
    } catch (error) {
      await this.runStore.update(run.id, { state: "failed", stateReason: (error as Error).message }).catch(() => {});
      return { ok: false, reason: (error as Error).message };
    }

    this.registerSession(run.id, {
      kind: "role",
      handle,
      requirement: input.requirement,
      parentRunId: input.parentRunId,
      writePaths: input.writePaths,
    });
    handle.prompt(input.instructions ?? `请完成任务 ${input.task}`);
    return { ok: true, runId: run.id };
  }

  async canRunInParallel(input: {
    cwd: string;
    requirement: string;
    task: string;
    writePaths: string[];
  }): Promise<{ ok: true } | { ok: false; reason: string }> {
    // 只有需求确有工作流状态（形状已确认）时才谈得上"依赖"；提交前审查等不挂在形状任务上的
    // 派工，需求状态查询本就不存在，不构成依赖查询失败，不应据此拒绝派工
    let declared: { id: string; dependsOn: string[] } | undefined;
    let taskStates: Record<string, { progress: string }> = {};
    const state = await executeWorkflowAction(
      { action: "query", requirement: input.requirement },
      { dataRoot: this.dataRoot, cwd: input.cwd },
    ).catch((error: unknown) => ({ details: { isError: true }, text: (error as Error).message }) as const);
    if (!state.details.isError) {
      const data = state.details.data as {
        shape: { tasks: Array<{ id: string; dependsOn: string[] }> } | null;
        tasks: Record<string, { progress: string }>;
      };
      declared = data.shape?.tasks.find((task) => task.id === input.task);
      taskStates = data.tasks;
    }
    if (declared) {
      for (const dep of declared.dependsOn) {
        if (taskStates[dep]?.progress !== "done") {
          return { ok: false, reason: `依赖任务未完成: ${dep}` };
        }
      }
    }

    const candidateRunIds = new Set<string>();
    for (const task of this.shellRegistry.list()) {
      if (task.host.runId && ACTIVE_OR_UNCERTAIN_TASK_STATUSES.has(task.status)) candidateRunIds.add(task.host.runId);
    }
    for (const [runId, entry] of this.sessions) {
      if (entry.kind === "role" && entry.handle.state() === "running") candidateRunIds.add(runId);
    }

    const inputResolved = resolveWritePaths(input.cwd, input.writePaths);
    for (const runId of candidateRunIds) {
      const result = await this.runStore.get(runId);
      if (!result.ok) continue;
      if (result.run.kind !== "role") continue;
      if (isTerminalState(result.run.state)) continue;
      const candidateResolved = resolveWritePaths(result.run.cwd, result.run.writePaths);
      if (pathsOverlap(candidateResolved, inputResolved)) {
        return { ok: false, reason: `写入范围与在跑任务重叠: ${result.run.task}（运行 ${runId}）` };
      }
    }
    return { ok: true };
  }

  async status(runId: string): Promise<{ ok: true; run: RunRecord; errorDetails?: ErrorDetailsSummary } | { ok: false; reason: string }> {
    const result = await this.runStore.get(runId);
    if (!result.ok) return { ok: false, reason: result.reason };
    let errorDetails: ErrorDetailsSummary | undefined;
    if (result.run.errorDetails.status !== "none") {
      errorDetails = await summarizeErrorDetails(runDataDir(this.dataRoot, this.repoId, runId));
    }
    return { ok: true, run: result.run, errorDetails };
  }

  async list(options: ListRunOptions = { limit: 100 }): Promise<ListRunResult> {
    return this.runStore.list(options);
  }

  async pause(runId: string): Promise<{ state: string; confirmed: boolean; reason?: string }> {
    const result = await this.runStore.get(runId);
    if (!result.ok) throw protocolError("not_found", `运行不存在: ${runId}`);
    const run = result.run;
    if (isTerminalState(run.state)) return { state: run.state, confirmed: true };
    if (run.state === "paused" || run.state === "paused_network") return { state: run.state, confirmed: true };
    if (run.state !== "running" && run.state !== "waiting_answer" && run.state !== "pausing") {
      return { state: run.state, confirmed: false, reason: `运行状态 ${run.state} 不可暂停` };
    }

    if (run.state === "running" || run.state === "waiting_answer") {
      try {
        await this.runStore.update(runId, { state: "pausing" });
      } catch (error) {
        return { state: run.state, confirmed: false, reason: (error as Error).message };
      }
    }

    const children = (await this.childrenOf(run)).filter(
      (candidate) => !isTerminalState(candidate.state) && candidate.state !== "interrupted",
    );
    const childResults = await Promise.all(children.map((child) => this.pause(child.id)));

    const entry = this.sessions.get(runId);
    let ownConfirmed = true;
    let ownReason: string | undefined;
    if (entry) {
      const outcome = await entry.handle.pause();
      ownConfirmed = outcome.confirmed;
      ownReason = outcome.reason;
    }

    const confirmed = ownConfirmed && childResults.every((child) => child.confirmed);
    const reasons = [ownReason, ...childResults.map((child) => child.reason)].filter(Boolean) as string[];
    if (confirmed) {
      await this.runStore.update(runId, { state: "paused" }).catch(() => {});
    } else {
      await this.runStore.update(runId, { stateReason: reasons.join("；") || "暂停确认超时" }).catch(() => {});
    }
    const updated = await this.runStore.get(runId);
    if (updated.ok) this.emit("runs.changed", { run: updated.run });

    return { state: confirmed ? "paused" : "pausing", confirmed, reason: reasons.length > 0 ? reasons.join("；") : undefined };
  }

  async resume(runId: string): Promise<{ state: string }> {
    const result = await this.runStore.get(runId);
    if (!result.ok) throw protocolError("not_found", `运行不存在: ${runId}`);
    const run = result.run;
    if (run.state !== "paused" && run.state !== "paused_network") {
      throw protocolError("bad_params", `运行状态不是可继续的暂停态: ${run.state}`);
    }
    await this.runStore.update(runId, { state: "running" });
    this.idleReminded.delete(runId);
    const entry = this.sessions.get(runId);
    if (entry) void entry.handle.resume().catch(() => {});
    const updated = await this.runStore.get(runId);
    if (updated.ok) this.emit("runs.changed", { run: updated.run });

    const children = (await this.childrenOf(run)).filter(
      (candidate) => candidate.state === "paused" || candidate.state === "paused_network",
    );
    for (const child of children) await this.resume(child.id).catch(() => {});
    return { state: "running" };
  }

  async stop(runId: string): Promise<{ state: string; confirmed: boolean }> {
    const result = await this.runStore.get(runId);
    if (!result.ok) throw protocolError("not_found", `运行不存在: ${runId}`);
    const run = result.run;
    if (isTerminalState(run.state)) return { state: run.state, confirmed: true };

    await this.runStore.update(runId, { state: "stopped" }).catch(() => {});
    const stopped = await this.runStore.get(runId);
    if (stopped.ok) {
      this.emit("runs.changed", { run: stopped.run });
      this.notifyParentOfChildTermination(stopped.run);
      await this.relayQueue
        .notify({ requirement: run.requirement, repoId: this.repoId, runId, kind: "stopped", message: `运行 ${runId} 已被用户停止` })
        .catch(() => {});
    }

    const entry = this.sessions.get(runId);
    if (entry) {
      void entry.handle
        .stop()
        .catch(() => {})
        .then(() => {
          this.sessions.delete(runId);
        });
    }
    // 会话持有的宿主是否真的收到停止请求不依赖 handle.stop() 内部实现是否抛错，
    // 独立向登记表发起一次停止确保该宿主的 Shell 任务不被漏掉
    void this.shellRegistry.stopHost(taskHost(run)).catch(() => {});

    const children = (await this.childrenOf(run)).filter((candidate) => !isTerminalState(candidate.state));
    for (const child of children) await this.stop(child.id).catch(() => {});

    return { state: "stopped", confirmed: true };
  }

  async pauseAll(): Promise<{ results: Array<{ runId: string; state: string; confirmed: boolean; reason?: string }> }> {
    this.allPaused = true;
    const page = await this.runStore.list({ limit: 1000 });
    const topLevel = page.items.filter(
      (run) => !isTerminalState(run.state) && run.state !== "interrupted" && (run.kind === "requirement" || run.parentRunId === undefined),
    );
    const results: Array<{ runId: string; state: string; confirmed: boolean; reason?: string }> = [];
    for (const run of topLevel) results.push({ runId: run.id, ...(await this.pause(run.id)) });
    return { results };
  }

  async resumeAll(): Promise<{ results: Array<{ runId: string; state: string }> }> {
    this.allPaused = false;
    const page = await this.runStore.list({ limit: 1000 });
    const topLevel = page.items.filter(
      (run) => (run.state === "paused" || run.state === "paused_network") && (run.kind === "requirement" || run.parentRunId === undefined),
    );
    const results: Array<{ runId: string; state: string }> = [];
    for (const run of topLevel) results.push({ runId: run.id, ...(await this.resume(run.id)) });
    return { results };
  }

  async stopAll(): Promise<{ results: Array<{ runId: string; state: string; confirmed: boolean }> }> {
    const page = await this.runStore.list({ limit: 1000 });
    const topLevel = page.items.filter(
      (run) => !isTerminalState(run.state) && (run.kind === "requirement" || run.parentRunId === undefined),
    );
    const results: Array<{ runId: string; state: string; confirmed: boolean }> = [];
    for (const run of topLevel) results.push({ runId: run.id, ...(await this.stop(run.id)) });
    return { results };
  }

  async adoptInterruptedShells(): Promise<void> {
    const page = await this.runStore.list({ states: ["interrupted"], limit: 1000 });
    for (const run of page.items) {
      const owner = taskHost(run);
      const outcome = await this.shellRegistry.adoptOrphans({ runToken: run.shellToken, owner });
      if (!outcome.ok) {
        await this.runStore.update(run.id, { stateReason: `遗留 Shell 任务定位失败: ${outcome.reason}` }).catch(() => {});
      }
    }
  }

  async resumeInterrupted(
    runId: string,
  ): Promise<{ ok: boolean; state: string; confirmed: boolean; reason?: string; blockingTasks?: TaskRecord[] }> {
    const result = await this.runStore.get(runId);
    if (!result.ok) return { ok: false, state: "unknown", confirmed: false, reason: result.reason };
    const run = result.run;
    if (run.state !== "interrupted") {
      return { ok: false, state: run.state, confirmed: false, reason: `运行状态不是 interrupted: ${run.state}` };
    }

    const blocking = this.shellRegistry
      .list()
      .filter((task) => task.host.runId === runId && ACTIVE_OR_UNCERTAIN_TASK_STATUSES.has(task.status));
    if (blocking.length > 0) {
      return {
        ok: false,
        state: "interrupted",
        confirmed: false,
        reason: "仍有活动或不确定的 Shell 任务，需先处理后再续接",
        blockingTasks: blocking,
      };
    }

    let cwdReal: string;
    try {
      cwdReal = await bestEffortRealpath(resolvePath(run.cwd));
      await stat(cwdReal);
      const identity = await repositoryIdentity(cwdReal);
      if (identity.repoId !== this.repoId) throw new Error(`工作区不再属于本仓库: ${run.cwd}`);
    } catch (error) {
      return { ok: false, state: "interrupted", confirmed: false, reason: `工作区不可用: ${(error as Error).message}` };
    }

    const synthesized = synthesizeInterruptedResults({ dataRoot: this.dataRoot, repoId: this.repoId, runId });
    if (!synthesized.ok) {
      return { ok: false, state: "interrupted", confirmed: false, reason: `会话记录无法读取: ${synthesized.detail}` };
    }

    const roleName = run.kind === "requirement" ? "requirement-agent" : (run.role ?? "").replace(/^pi-company\./, "");
    const roleEntry = this.findRole(roleName);
    if (!roleEntry || !roleEntry.available) {
      return { ok: false, state: "interrupted", confirmed: false, reason: `角色不在目录内: ${roleName}` };
    }
    const taskId = run.kind === "role" && /^T-\d+$/.test(run.task) ? run.task : undefined;
    let modelRef: SelectedModel;
    try {
      modelRef = this.selectModel({ roleName, taskId });
    } catch (error) {
      return { ok: false, state: "interrupted", confirmed: false, reason: (error as Error).message };
    }

    const resumePrompt = [
      "已重新拉起会话续接之前中断的运行。",
      synthesized.appended.length > 0
        ? `以下工具调用因守护进程中断已被补入失败结果，请据此判断是否需要重做：${synthesized.appended.map((entry) => entry.toolCallId).join("、")}`
        : "",
      "请先只读核对当前工作区实际状态是否与预期一致，再继续推进，不要假设中断前的操作已生效。",
    ]
      .filter((part) => part.length > 0)
      .join("\n");

    if (run.kind === "requirement") {
      const built = await resumeRequirementAgentSession({
        dataRoot: this.dataRoot,
        repoId: this.repoId,
        requirement: run.requirement,
        cwd: cwdReal,
        role: roleEntry,
        roleCatalog: this.roleCatalog,
        runtime: this.runtime,
        modelRef,
        clock: this.clock,
        shellRegistry: this.shellRegistry,
        guards: this.buildGuards(cwdReal, run.writePaths),
        networkGate: this.networkGate,
        dispatch: this.buildRequirementDispatch(cwdReal, run.requirement),
        relay: this.buildRequirementRelay(run.requirement),
        runStore: this.runStore,
        workspaceRepoIds: this.workspaceRepoIds,
        runId,
      });
      if (!built.ok) return { ok: false, state: "interrupted", confirmed: false, reason: built.reason };
      await this.runStore.update(runId, { state: "running" });
      this.registerSession(runId, { kind: "requirement", handle: built.handle, requirement: run.requirement, writePaths: run.writePaths });
      built.handle.prompt(resumePrompt);
    } else {
      const outputContract = outputContractForRole(roleEntry);
      if (!outputContract.ok) return { ok: false, state: "interrupted", confirmed: false, reason: outputContract.reason };
      let handle: RoleSessionHandle;
      try {
        handle = await createRoleSession({
          dataRoot: this.dataRoot,
          repoId: this.repoId,
          runId,
          shellToken: run.shellToken,
          cwd: cwdReal,
          roleName,
          role: roleEntry,
          task: run.task,
          readPaths: run.readPaths,
          writePaths: run.writePaths,
          reportPath: run.reportPath,
          contract: outputContract.contract,
          runtime: this.runtime,
          modelRef,
          clock: this.clock,
          shellRegistry: this.shellRegistry,
          guards: this.buildGuards(cwdReal, run.writePaths),
          networkGate: this.networkGate,
          resume: true,
        });
      } catch (error) {
        return { ok: false, state: "interrupted", confirmed: false, reason: (error as Error).message };
      }
      await this.runStore.update(runId, { state: "running" });
      this.registerSession(runId, {
        kind: "role",
        handle,
        requirement: run.requirement,
        parentRunId: run.parentRunId,
        writePaths: run.writePaths,
      });
      handle.prompt(resumePrompt);
    }

    const updated = await this.runStore.get(runId);
    if (updated.ok) this.emit("runs.changed", { run: updated.run });
    return { ok: true, state: "running", confirmed: true };
  }

  async resumeNetworkPaused(providerId: string): Promise<void> {
    const page = await this.runStore.list({ states: ["paused_network"], limit: 1000 });
    for (const run of page.items) {
      if (run.model.provider !== providerId) continue;
      const entry = this.sessions.get(run.id);
      if (!entry) continue;
      await this.runStore.update(run.id, { state: "running" }).catch(() => {});
      this.idleReminded.delete(run.id);
      for (const child of await this.childrenOf(run)) this.idleReminded.delete(child.id);
      const updated = await this.runStore.get(run.id);
      if (updated.ok) this.emit("runs.changed", { run: updated.run });
      await this.relayQueue
        .notify({
          requirement: run.requirement,
          repoId: this.repoId,
          runId: run.id,
          kind: "auto_resumed",
          message: `运行 ${run.id} 网络恢复后已自动续接`,
        })
        .catch(() => {});
      entry.handle.prompt("网络已恢复：请先只读核对当前状态是否与预期一致，再继续推进，不要假设网络故障前的操作已生效。");
    }
  }

  private registerSession(runId: string, entry: SessionEntry): void {
    this.sessions.set(runId, entry);
    this.onSessionEvent(runId, entry);
  }

  private onSessionEvent(runId: string, entry: SessionEntry): void {
    const events = entry.handle.events as EventEmitter;
    events.on("tool_end", (event: { toolCallId?: string; toolName?: string; isError?: boolean }) => {
      this.emit("activity", {
        runId,
        kind: "tool_end",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        at: new Date().toISOString(),
      });
    });
    events.on("paused_network", () => {
      this.runStore
        .update(runId, { state: "paused_network" })
        .then((run) => this.emit("runs.changed", { run }))
        .catch(() => {});
    });
    // 角色回合以纯文字结束但尚未提交时会话保持 idle 等外部决定是否继续（role-session 自身的既定语义）；
    // 若此时没有仍在跑的后台 Shell 任务，说明它不是在"监控后台工作"而是单纯还没走到提交，续一句推它完成，
    // 有活动 Shell 任务时保持原样——不能打断用户显式停止前的观察窗口
    events.on("idle", () => {
      if (entry.kind !== "role") return;
      const hasActiveShellTask = this.shellRegistry
        .list()
        .some((task) => task.host.runId === runId && ACTIVE_OR_UNCERTAIN_TASK_STATUSES.has(task.status));
      if (hasActiveShellTask) return;
      if (this.idleReminded.has(runId)) {
        // finalize() 返回的是包着 resultPromise 的新 promise，即便 resultPromise 自身早有
        // 兜底 catch，这层新 promise 若不接一个 catch 仍会在判失败时形成未处理拒绝，把守护进程整个崩掉
        void (entry.handle as RoleSessionHandle).finalize().catch(() => {});
        return;
      }
      this.idleReminded.add(runId);
      entry.handle.prompt("请提交结构化结果：任务已完成请立即提交，尚未完成请继续推进后再提交。");
    });

    entry.handle.result().then(
      (value) => this.finalizeRun(runId, { ok: true, value }),
      (error) => this.finalizeRun(runId, { ok: false, error }),
    );
  }

  private async settleTerminal(
    runId: string,
    target: "completed" | "failed",
    patch: { result?: unknown; stateReason?: string },
  ): Promise<void> {
    try {
      await this.runStore.update(runId, { state: target, ...patch });
    } catch (error) {
      await this.runStore.update(runId, { stateReason: (error as Error).message }).catch(() => {});
    }
  }

  private async finalizeRun(runId: string, outcome: { ok: true; value: unknown } | { ok: false; error: unknown }): Promise<void> {
    this.idleReminded.delete(runId);
    const current = await this.runStore.get(runId);
    if (!current.ok) return;
    if (isTerminalState(current.run.state)) {
      this.sessions.delete(runId);
      return;
    }

    if (outcome.ok) {
      await this.settleTerminal(runId, "completed", { result: outcome.value });
    } else {
      const message = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
      await this.settleTerminal(runId, "failed", { stateReason: message });
      await writeErrorDetails(runDataDir(this.dataRoot, this.repoId, runId), {
        runId,
        model: current.run.model,
        error: outcome.error,
      }).catch(() => {});
    }

    this.sessions.delete(runId);
    const updated = await this.runStore.get(runId);
    if (updated.ok) {
      this.emit("runs.changed", { run: updated.run });
      if (isTerminalState(updated.run.state)) this.notifyParentOfChildTermination(updated.run);
    }
  }

  private notifyParentOfChildTermination(run: RunRecord): void {
    if (run.kind !== "role" || !run.parentRunId) return;
    const parent = this.sessions.get(run.parentRunId);
    if (!parent || parent.kind !== "requirement") return;
    const summary =
      run.state === "completed" ? "已完成" : run.state === "failed" ? `已失败：${run.stateReason ?? ""}` : "已停止";
    parent.handle.prompt(`任务 ${run.task}（角色 ${run.role ?? ""}，运行 ${run.id}）${summary}。请据此继续推进需求。`);
  }

  // 按登记表实际持有的宿主集合停止，而非本实例内存里追踪的会话：启动时接管的遗留任务
  // 从未经由本实例派工，不会出现在 this.sessions 中，但仍需要在退出时收到停止请求
  async close(): Promise<void> {
    const hosts = new Map<string, Host>();
    for (const task of this.shellRegistry.list()) {
      const key = `${task.host.kind}:${task.host.id}:${task.host.role ?? ""}:${task.host.runId ?? ""}`;
      if (!hosts.has(key)) hosts.set(key, task.host);
    }
    for (const host of hosts.values()) {
      await this.shellRegistry.stopHost(host).catch(() => {});
    }
  }

  async wait(runId: string, timeoutMs: number = DEFAULT_WAIT_TIMEOUT_MS): Promise<{ state: string }> {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const result = await this.runStore.get(runId);
      if (!result.ok) throw protocolError("not_found", `运行不存在: ${runId}`);
      if (isTerminalState(result.run.state)) return { state: result.run.state };
      const remaining = deadline - Date.now();
      if (remaining <= 0) return { state: result.run.state };
      await delay(Math.min(WAIT_POLL_INTERVAL_MS, remaining));
    }
  }
}

export function registerProtocolHandlers(input: {
  server: DaemonServer;
  manager: RunManager;
  relayQueue: RelayQueue;
  shellRegistry: ShellRegistry;
}): void {
  const { server, manager, relayQueue, shellRegistry } = input;

  const register = (
    method: string,
    handler: (params: Record<string, unknown>, client: ClientInfo) => Promise<Record<string, unknown>>,
  ): void => {
    server.registerHandler(method, async (params, client) => {
      await manager.awaitStarted();
      return handler(params, client);
    });
  };

  register("dispatch.requirement", async (params) =>
    manager.dispatchRequirement({ requirement: params.requirement as string, cwd: params.cwd as string }),
  );
  register("dispatch.review", async (params) =>
    manager.dispatchReview({
      requirement: params.requirement as string,
      cwd: params.cwd as string,
      baseline: params.baseline as string,
      snapshot: params.snapshot as { head: string; fingerprint: string },
    }),
  );
  register("runs.list", async (params) => {
    const result = await manager.list({
      kind: params.kind as RunKind | undefined,
      offset: params.offset as number | undefined,
      limit: (params.limit as number | undefined) ?? 100,
    });
    return { items: result.items, total: result.total, runningCount: result.runningCount };
  });
  register("runs.get", async (params) => {
    const result = await manager.status(params.runId as string);
    if (!result.ok) throw protocolError("not_found", `运行不存在: ${params.runId}`);
    return { run: result.run, errorDetails: result.errorDetails };
  });
  register("runs.pause", async (params) => manager.pause(params.runId as string));
  register("runs.resume", async (params) => manager.resume(params.runId as string));
  register("runs.stop", async (params) => manager.stop(params.runId as string));
  register("runs.resumeInterrupted", async (params) => manager.resumeInterrupted(params.runId as string));
  register("runs.pauseAll", async () => manager.pauseAll());
  register("runs.resumeAll", async () => manager.resumeAll());
  register("runs.stopAll", async () => manager.stopAll());

  register("relay.answer", async (params, client) => {
    const result = await relayQueue.answer(params.questionId as string, params.answer as string, client.windowId);
    return { accepted: result.ok, reason: result.ok ? undefined : result.reason };
  });
  register("relay.forward", async (params) => {
    const result = await relayQueue.forward({ requirement: params.requirement as string, message: params.message as string });
    return { delivered: result.delivered, reason: result.delivered ? undefined : result.reason };
  });
  register("relay.pending", async (_params, client) => relayQueue.pendingFor({ windowId: client.windowId, repoIds: client.repoIds }));

  register("shells.list", async () => ({ tasks: shellRegistry.list() }));
  register("shells.stop", async (params) => {
    const taskId = params.taskId as string;
    const task = shellRegistry.get(taskId);
    if (!task) return { status: "not_found", reason: `未知任务: ${taskId}` };
    if (task.pid !== params.expectedPid || String(task.startedAt) !== params.expectedStartedAt) {
      return { status: "mismatch", reason: "任务身份已变化" };
    }
    const result = await shellRegistry.stop(taskId);
    if (!result.ok) return { status: "error", reason: result.reason };
    return { status: result.task.status };
  });
  register("shells.markStopped", async (params) => {
    const taskId = params.taskId as string;
    const task = shellRegistry.get(taskId);
    if (!task) return { status: "not_found", reason: `未知任务: ${taskId}` };
    if (task.pid !== params.expectedPid || String(task.startedAt) !== params.expectedStartedAt) {
      return { status: "mismatch", reason: "任务身份已变化" };
    }
    const result = shellRegistry.markStoppedByUser(taskId, { decisionId: params.decisionId as string });
    if (!result.ok) return { status: "error", reason: result.reason };
    return { status: result.task.status };
  });

  register("subscribe.activity", async () => {
    const page = await manager.list({ limit: 1000 });
    return { subscriptionId: randomUUID(), snapshot: page.items };
  });
  register("subscribe.transcript", async () => ({ subscriptionId: randomUUID(), entries: [], ended: false }));
  register("unsubscribe", async () => ({}));

  server.onHello = async (client: ClientInfo) => {
    const pending = await relayQueue.pendingFor({ windowId: client.windowId, repoIds: client.repoIds });
    for (const question of pending.questions) {
      server.broadcast("relay.question", question as unknown as Record<string, unknown>, (info) => info.windowId === client.windowId);
    }
    for (const notice of pending.notices) {
      server.broadcast("relay.notice", notice as unknown as Record<string, unknown>, (info) => info.windowId === client.windowId);
    }
  };

  server.markHandlersReady();
}
