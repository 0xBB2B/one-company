import { readRecord } from "../runtime/database.ts";
import { sessionRecordRef } from "../runtime/session-records.ts";
import { readDecisions } from "../runtime/decisions.ts";
import { createRangeProtection } from "../runtime/range-protection.ts";
import { loadRoleSettings, resolveRoleSettings, settingsPaths } from "../runtime/settings.ts";
import { defaultRoleDir, loadRoleCatalog, projectRoleDir, userRoleDir } from "../runtime/roles.ts";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { detectMcpAdapter } from "../runtime/mcp.ts";
import type { McpConfig } from "../runtime/mcp.ts";
import type { DispatchSettingsContext } from "../runtime/run-store.ts";
import { acceptanceReportPath, bindRunResult, checkAcceptanceReport, verifyTaskDelivery } from "../runtime/delivery.ts";
import { collectGitSnapshot } from "../runtime/git-snapshot.ts";
import { currentVersion } from "../runtime/workflow-tool.ts";
import type { Phase, AcceptanceResult } from "../runtime/result.ts";
import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { dirname, resolve as resolvePath } from "node:path";
import type { EventEmitter } from "node:events";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Clock } from "../runtime/clock.ts";
import { repositoryIdentity } from "../runtime/identity.ts";
import type { ErrorDetailsSummary } from "../runtime/error-details.ts";
import { summarizeErrorDetails, writeErrorDetails } from "../runtime/error-details.ts";
import type { NetworkPauseGate } from "../runtime/network-pause.ts";
import { fingerprint as rangesFingerprint, verifyFingerprint as rangesVerifyFingerprint } from "../runtime/ranges.ts";
import type { RoleCatalogEntry } from "../runtime/roles.ts";
import { ACCEPTANCE_SCHEMA, REVIEW_SCHEMA, WORK_SCHEMA } from "../runtime/result.ts";
import type { CreateRunInput, ListRunOptions, ListRunResult, RunKind, RunRecord } from "../runtime/run-store.ts";
import { isTerminalState, RunStore } from "../runtime/run-store.ts";
import type { TranscriptEntry } from "../runtime/session-records.ts";
import type { Submissions } from "../runtime/error-details.ts";
import { readTranscript, synthesizeInterruptedResults } from "../runtime/session-records.ts";
import type { Host, ShellRegistry, TaskRecord, TaskStatus } from "../runtime/shell-registry.ts";
import { executeWorkflowAction } from "../runtime/workflow-tool.ts";
import type { RelayQueue } from "./relay-queue.ts";
import { bestEffortRealpath, createRoleSession, withinScope } from "./role-session.ts";
import type { RoleOutputContract, RoleSessionGuards, RoleSessionHandle } from "./role-session.ts";
import { awaitCrossRepoStage, createRequirementAgentSession, resumeRequirementAgentSession } from "./requirement-agent.ts";
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
  phase?: Phase;
}

type DispatchOutcome = { ok: true; runId: string } | { ok: false; reason: string };

const ACTIVE_OR_UNCERTAIN_TASK_STATUSES = new Set<TaskStatus>(["starting", "running", "stopping", "uncertain"]);
const WAIT_POLL_INTERVAL_MS = 100;
const DEFAULT_WAIT_TIMEOUT_MS = 300_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface WaitForSpec {
  repo: string;
  requirement: string;
  stage: string;
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
  private readonly liveTranscripts = new Map<string, { base: number; entries: TranscriptEntry[] }>();
  private readonly transcriptSubscriptions = new Map<string, { runId: string; windowId: string; connected: () => boolean }>();
  // 角色 idle 续跑提醒的上界：每个角色运行最多提醒一次，避免和用户显式停止前的观察窗口无限拉锯
  private readonly idleReminded = new Set<string>();
  private readonly waiting = new Map<string, { parentRunId?: string; start(): Promise<DispatchOutcome> }>();
  private waitingTimer?: ReturnType<Clock["setIntervalExcludingSleep"]>;
  private checkingWaiting = false;
  private closed = false;
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

  private async executionSettings(cwd: string, roleName: string, context?: DispatchSettingsContext, taskId?: string) {
    const agentDir = dirname(this.dataRoot);
    const catalog = context ? (await loadRoleCatalog({ defaultDir: defaultRoleDir(), userDir: userRoleDir(agentDir), projectDir: projectRoleDir(cwd), parseFrontmatter, projectTrusted: context.projectTrusted })).roles : this.roleCatalog;
    const layers = await loadRoleSettings(await settingsPaths({ agentDir, repoRoot: cwd, projectTrusted: context?.projectTrusted ?? false }), { roleNames: catalog.map((role) => role.name) });
    const fallback = context?.model ?? this.selectModel({ roleName, taskId });
    let mcp: import("./role-session.ts").RoleSessionMcpOptions | undefined;
    if (context?.mcp) {
      const detected = detectMcpAdapter({ sourcePaths: [dirname(context.mcp.adapterEntry)], argv: ["--mcp-config", context.mcp.configPath], agentDir });
      if (!detected.installed || detected.entryPath !== context.mcp.adapterEntry) throw new Error("MCP 入口不属于已识别适配器");
      const config = JSON.parse(await readFile(detected.configPath, "utf8")) as McpConfig;
      mcp = { servers: Object.entries(config.mcpServers ?? {}).filter(([, entry]) => !entry.disabled).map(([name]) => name), entryPath: detected.entryPath, packageDir: detected.packageDir, config };
    }
    const resolved = resolveRoleSettings(roleName, layers, {
      mainModel: `${fallback.provider}/${fallback.id}`, mainThinking: context?.thinking ?? "high",
      models: this.runtime.getModels().map((model) => ({ id: `${model.provider}/${model.id}`, thinkingLevels: model.reasoning ? ["off", "minimal", "low", "medium", "high", "xhigh", "max"].filter((level) => model.thinkingLevelMap?.[level as keyof typeof model.thinkingLevelMap] !== null) : ["off"] })),
      availableMcp: mcp?.servers ?? [],
    });
    const slash = resolved.model.indexOf("/");
    return { catalog, modelRef: { provider: resolved.model.slice(0, slash), id: resolved.model.slice(slash + 1) }, thinking: resolved.thinking, mcp: mcp && { ...mcp, servers: resolved.mcp.enabled } };
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
    const page = await this.runStore.list({ kind: "role", requirement: run.requirement, limit: Number.MAX_SAFE_INTEGER });
    return page.items.filter((candidate) => candidate.parentRunId === run.id);
  }

  private buildGuards(cwd: string, writePaths: string[], runId?: string, requirement?: string): RoleSessionGuards {
    let protection: Promise<Awaited<ReturnType<typeof createRangeProtection>>> | undefined;
    const get = () => protection ??= (async () => {
      const id = runId ?? (requirement ? this.findRequirementSession(requirement)?.[0] : undefined);
      if (!id) throw new Error("范围保护缺少运行身份");
      const run = await this.runStore.get(id);
      if (!run.ok) throw new Error("范围持有者不可读");
      return createRangeProtection({ cwd, dataRoot: this.dataRoot, holder: { kind: run.run.kind, runId: id, requirement: run.run.requirement }, writePaths, clock: this.clock, shells: this.shellRegistry });
    })();
    return {
      checkWrite: async (path) => (await get()).checkWrite(path),
      fingerprint: (paths) => rangesFingerprint(cwd, paths),
      verifyFingerprint: (fp) => rangesVerifyFingerprint(cwd, fp),
      commandGuard: { launch: async (command, commandCwd) => (await get()).commandGuard.launch!(command, commandCwd), before: async () => (await get()).commandGuard.before(), after: async (token, outcome) => (await get()).commandGuard.after(token, outcome) },
      release: async () => { if (protection) await (await protection).release(); },
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

  async dispatchRequirement(input: { requirement: string; cwd: string; context?: DispatchSettingsContext }): Promise<{ runId: string }> {
    if (this.allPaused) throw protocolError("daemon_busy", "本仓库已全部暂停，暂不接受新派工");
    const realCwd = await this.assertOwnsCwd(input.cwd);

    const stateResult = await executeWorkflowAction(
      { action: "query", requirement: input.requirement },
      { dataRoot: this.dataRoot, cwd: realCwd },
    );
    if (stateResult.details.isError) throw new Error(stateResult.text);
    const stage = (stateResult.details.data as { stage: string }).stage;
    if (stage === "draft") throw protocolError("not_confirmed", `需求尚未确认: ${input.requirement}`);

    const execution = await this.executionSettings(realCwd, "requirement-agent", input.context);
    const roleEntry = execution.catalog.find((role) => role.name === "requirement-agent");
    if (!roleEntry) throw new Error("角色目录缺少 requirement-agent");
    const { modelRef } = execution;

    const result = await createRequirementAgentSession({
      dataRoot: this.dataRoot,
      repoId: this.repoId,
      requirement: input.requirement,
      cwd: realCwd,
      role: roleEntry,
      roleCatalog: execution.catalog,
      dispatchContext: input.context, thinking: execution.thinking, mcp: execution.mcp,
      runtime: this.runtime,
      modelRef,
      clock: this.clock,
      shellRegistry: this.shellRegistry,
      guards: this.buildGuards(realCwd, [realCwd], undefined, input.requirement),
      networkGate: this.networkGate,
      dispatch: this.buildRequirementDispatch(realCwd, input.requirement),
      relay: this.buildRequirementRelay(input.requirement),
      runStore: this.runStore,
      workspaceRepoIds: input.context?.workspaceRepoIds ?? this.workspaceRepoIds,
      verifyDelivery: (runId, signal) => this.verifyDelivery(runId, input.requirement, signal),
    });

    if (!result.ok) throw new Error(result.reason);
    if (result.reused) throw protocolError("already_active", "该需求已有活动的需求代理运行", { runId: result.runId });

    this.registerSession(result.runId, {
      kind: "requirement",
      handle: result.handle,
      requirement: input.requirement,
      writePaths: [realCwd],
    });
    const created = await this.runStore.get(result.runId);
    if (created.ok) this.emit("runs.changed", { run: created.run });
    result.handle.prompt("请先完成并记录规划前检，核对已有任务产物，缺少可执行任务时派出 planner；随后提议工作流形状并等待确认，按已确认形状推进实施、审查和验收，需要用户决策时用提问工具。");
    return { runId: result.runId };
  }

  async dispatchReview(params: {
    requirement: string;
    cwd: string;
    baseline: string;
    context?: DispatchSettingsContext;
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
        context: params.context,
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
            waitFor: input.waitFor,
          },
        );
      },
      status: async (runId) => {
        const result = await this.runStore.get(runId);
        if (result.ok && (result.run.requirement !== requirement || result.run.kind !== "role")) return { ok: false, reason: "运行不属于本需求的子角色" };
        return result.ok ? { ok: true, state: result.run.state } : { ok: false, reason: result.reason };
      },
      wait: async (runId) => {
        try {
          const owned = await this.runStore.get(runId);
          if (!owned.ok || owned.run.requirement !== requirement || owned.run.kind !== "role") throw new Error("运行不属于本需求的子角色");
          const result = await this.wait(runId, DEFAULT_WAIT_TIMEOUT_MS);
          return { ok: true, state: result.state };
        } catch (error) {
          return { ok: false, reason: (error as Error).message };
        }
      },
      list: async () => {
        const page = await this.runStore.list({ kind: "role", requirement, limit: Number.MAX_SAFE_INTEGER });
        return page.items.map((run) => ({ runId: run.id, role: run.role ?? "", task: run.task, state: run.state }));
      },
      cancel: async (runId) => {
        try {
          const owned = await this.runStore.get(runId);
          if (!owned.ok || owned.run.requirement !== requirement || owned.run.kind !== "role") throw new Error("运行不属于本需求的子角色");
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
          kind: input.kind,
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
      context?: DispatchSettingsContext;
      waitFor?: WaitForSpec;
    },
  ): Promise<DispatchOutcome> {
    if (this.allPaused) return { ok: false, reason: "本仓库已全部暂停，暂不接受新派工" };

    if (caller.kind === "requirement") {
      const entry = this.sessions.get(caller.runId);
      if (!entry || entry.kind !== "requirement") return { ok: false, reason: "调用方不是有效的需求代理运行" };
    } else if (params.role !== "reviewer") {
      return { ok: false, reason: "窗口连接只能派出提交前白盒审查者" };
    }

    const parent = caller.kind === "requirement" ? await this.runStore.get(caller.runId) : undefined;
    const context = parent?.ok ? parent.run.dispatchContext : params.context;
    const execution = await this.executionSettings(params.cwd, params.role, context, /^T-\d+$/.test(params.task) ? params.task : undefined);
    const roleEntry = execution.catalog.find((role) => role.name === params.role);
    if (!roleEntry || !roleEntry.available) return { ok: false, reason: `角色不在目录内: ${params.role}` };

    let reportPath: string | undefined;
    if (roleEntry.definition?.kind === "acceptance") {
      reportPath = params.reportPath ?? acceptanceReportPath(params.cwd, params.requirement);
      if (!(await withinScope(params.cwd, reportPath, [params.cwd]))) {
        return { ok: false, reason: `报告路径越出需求 cwd: ${params.reportPath}` };
      }
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
        context, execution, waitFor: params.waitFor,
        task: params.task,
        instructions: params.instructions,
        writePaths: roleEntry.definition?.kind === "review" ? [] : reportPath ? [reportPath] : params.writePaths,
        readPaths: params.readPaths,
        reportPath,
      });
    });
  }

  private async assertRepairAllowed(cwd: string, requirement: string, phase: string): Promise<void> {
    if (phase === "plan") return;
    const runs = (await this.runStore.list({ requirement, kind: "role", limit: Number.MAX_SAFE_INTEGER })).items;
    for (const gate of ["review", "acceptance"] as const) {
      const attempts = runs.filter((run) => run.phase === gate && ["completed", "failed"].includes(run.state)).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
      const last = attempts.at(-1);
      if (!last || (last.result as { verdict?: string } | undefined)?.verdict === "PASS") continue;
      const decisions = await readDecisions({ cwd, dataRoot: this.dataRoot, requirement, actor: "ai" }) as Array<{ recordedAt: string; effects?: string[] }>;
      if (!decisions.some((decision) => decision.recordedAt >= (last.endedAt ?? last.startedAt) && decision.effects?.includes(`repair:${gate}`))) throw new Error(`${gate} 未通过，须先记录该门禁的 AI 归因和修复路径，effects 包含 repair:${gate}`);
      if (attempts.length >= 4) {
        const user = await readDecisions({ cwd, dataRoot: this.dataRoot, requirement, actor: "user" }) as Array<{ recordedAt: string; effects?: string[] }>;
        if (!user.some((decision) => decision.recordedAt >= (last.endedAt ?? last.startedAt) && decision.effects?.includes(`repair:${gate}:${attempts.length}`))) throw new Error(`${gate} 第 ${attempts.length - 1} 轮返修仍未通过，技术阻塞；仅用户明确授权第 ${attempts.length} 轮后可继续`);
      }
    }
    if (phase === "acceptance") {
      const lastAcceptance = runs.filter((run) => run.phase === "acceptance").sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
      if (lastAcceptance && (lastAcceptance.result as { verdict?: string } | undefined)?.verdict !== "PASS") {
        const review = runs.some((run) => run.phase === "review" && run.state === "completed" && run.startedAt > lastAcceptance.startedAt && (run.result as { verdict?: string } | undefined)?.verdict === "PASS");
        if (!review) throw new Error("验收返修后须先通过白盒重审");
      }
    }
  }

  private async startRoleRun(input: {
    parentRunId?: string;
    standalone: boolean;
    requirement: string;
    cwd: string;
    role: string;
    roleEntry: RoleCatalogEntry;
    context?: DispatchSettingsContext;
    execution: Awaited<ReturnType<RunManager["executionSettings"]>>;
    task: string;
    instructions?: string;
    writePaths: string[];
    readPaths: string[];
    reportPath?: string;
    waitFor?: WaitForSpec;
  }, queuedRun?: RunRecord): Promise<DispatchOutcome> {
    let modelRef: SelectedModel;
    try {
      modelRef = input.execution.modelRef;
    } catch (error) {
      return { ok: false, reason: (error as Error).message };
    }

    await this.assertRepairAllowed(input.cwd, input.requirement, input.roleEntry.definition!.kind);
    const outputContract = outputContractForRole(input.roleEntry);
    if (!outputContract.ok) return { ok: false, reason: outputContract.reason };

    const sourceVersion = await currentVersion({ cwd: input.cwd, requirement: input.requirement });
    const reviewSnapshot = input.roleEntry.definition?.kind === "review" ? await collectGitSnapshot({ repoRoot: input.cwd }) : undefined;
    const createInput: CreateRunInput = {
      pendingDispatch: { instructions: input.instructions, waitFor: input.waitFor },
      sourceVersion, reviewSnapshot, dispatchContext: input.context, phase: input.roleEntry.definition!.kind as Phase,
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
      thinking: input.execution.thinking,
      mcp: input.execution.mcp?.servers ?? [],
    };
    const run = queuedRun ?? await this.runStore.create(createInput);
    let waitingReason: string | undefined;
    if (input.parentRunId) {
      const parent = await this.runStore.get(input.parentRunId);
      if (!parent.ok || isTerminalState(parent.run.state)) {
        await this.runStore.update(run.id, { state: "stopped", stateReason: "父运行已结束或不可读" });
        return { ok: false, reason: "父运行已结束或不可读" };
      }
      if (parent.run.state !== "running" && parent.run.state !== "waiting_answer") waitingReason = "等待父运行恢复";
    }
    if (input.waitFor) {
      const checked = await awaitCrossRepoStage(input.context?.workspaceRepoIds ?? this.workspaceRepoIds, this.dataRoot, input.waitFor);
      if (!checked.ok) waitingReason = checked.reason;
    }
    if (waitingReason) {
      await this.runStore.update(run.id, { stateReason: waitingReason });
      this.waiting.set(run.id, { parentRunId: input.parentRunId, start: () => this.startRoleRun(input, run) });
      this.waitingTimer ??= this.clock.setIntervalExcludingSleep(() => { void this.scheduleWaitingTasks(); }, 1000);
      this.emit("runs.changed", { run: (await this.runStore.get(run.id) as { ok: true; run: RunRecord }).run });
      return { ok: true, runId: run.id };
    }
    const latest = await this.runStore.get(run.id);
    if (this.closed || !latest.ok || latest.run.state !== "queued") return { ok: false, reason: "排队运行已停止或不再可启动" };
    await this.runStore.update(run.id, { state: "running", stateReason: "", sourceVersion, reviewSnapshot });

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
        thinking: input.execution.thinking, mcp: input.execution.mcp,
        clock: this.clock,
        shellRegistry: this.shellRegistry,
        guards: this.buildGuards(input.cwd, input.writePaths, run.id),
        networkGate: this.networkGate,
      });
    } catch (error) {
      await this.runStore.update(run.id, { state: "failed", stateReason: (error as Error).message }).catch(() => {});
      return { ok: false, reason: (error as Error).message };
    }

    const afterCreate = await this.runStore.get(run.id);
    if (this.closed || !afterCreate.ok || afterCreate.run.state !== "running") {
      await handle.stop();
      handle.dispose();
      return { ok: false, reason: "会话创建期间运行已停止" };
    }

    this.registerSession(run.id, {
      kind: "role",
      handle,
      requirement: input.requirement,
      parentRunId: input.parentRunId,
      writePaths: input.writePaths,
      phase: outputContract.contract.kind === "structured" ? outputContract.contract.expectedPhase : "plan",
    });
    this.emit("runs.changed", { run: (await this.runStore.get(run.id) as { ok: true; run: RunRecord }).run });
    const snapshotInstruction = reviewSnapshot ? `\n审查快照 reviewedHead=${reviewSnapshot.head}，contentFingerprint=${reviewSnapshot.fingerprint}，提交时原样回填。` : "";
    handle.prompt((input.instructions ?? `请完成任务 ${input.task}`) + snapshotInstruction);
    return { ok: true, runId: run.id };
  }

  private async scheduleWaitingTasks(): Promise<void> {
    if (this.checkingWaiting || this.allPaused || this.closed) return;
    this.checkingWaiting = true;
    try {
      for (const [runId, entry] of [...this.waiting]) {
        await this.withDispatchLock(async () => {
          if (this.closed || this.allPaused || !this.waiting.has(runId)) return;
          const found = await this.runStore.get(runId);
          if (!found.ok || found.run.state !== "queued") { this.waiting.delete(runId); return; }
          if (entry.parentRunId) {
            const parent = await this.runStore.get(entry.parentRunId);
            if (!parent.ok || isTerminalState(parent.run.state)) { await this.stop(runId); return; }
            if (parent.run.state !== "running" && parent.run.state !== "waiting_answer") return;
          }
          try {
            const conflict = await this.canRunInParallel(found.run);
            if (!conflict.ok) { await this.runStore.update(runId, { stateReason: conflict.reason }); return; }
            this.waiting.delete(runId);
            const outcome = await entry.start();
            if (!outcome.ok) await this.runStore.update(runId, { state: "failed", stateReason: outcome.reason });
          } catch (error) {
            if (this.waiting.has(runId)) return;
            await this.runStore.update(runId, { state: "failed", stateReason: (error as Error).message });
          }
        }).catch(() => {});
      }
    } finally {
      this.checkingWaiting = false;
      if (this.waiting.size === 0 && this.waitingTimer) { this.clock.clearTimer(this.waitingTimer); this.waitingTimer = undefined; }
    }
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
    if (!state.details.isError && "data" in state.details) {
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
      if (entry.handle.state() === "running") candidateRunIds.add(runId);
    }

    const inputResolved = resolveWritePaths(input.cwd, input.writePaths);
    for (const runId of candidateRunIds) {
      const result = await this.runStore.get(runId);
      if (!result.ok) return { ok: false, reason: `无法核实范围持有者: ${runId}` };
      if (result.run.kind === "requirement" && result.run.requirement === input.requirement) continue;
      const candidateResolved = resolveWritePaths(result.run.cwd, result.run.writePaths);
      if (pathsOverlap(candidateResolved, inputResolved)) {
        return { ok: false, reason: `写入范围与在跑任务重叠: ${result.run.task}（运行 ${runId}）` };
      }
    }
    return { ok: true };
  }

  async verifyDelivery(runId: string, requirement: string, signal?: AbortSignal): Promise<void> {
    const found = await this.runStore.get(runId);
    if (!found.ok || found.run.requirement !== requirement || found.run.kind !== "role") throw new Error("交付运行不属于本需求");
    const { createManagedBashOperations } = await import("../runtime/shell-bash.ts");
    const parent = found.run.parentRunId ? await this.runStore.get(found.run.parentRunId) : undefined;
    if (!parent?.ok || parent.run.kind !== "requirement" || parent.run.requirement !== requirement || isTerminalState(parent.run.state)) throw new Error("交付核验需要本需求的活动需求代理");
    const operations = createManagedBashOperations({ registry: this.shellRegistry, host: taskHost(parent.run), runToken: parent.run.shellToken, guard: this.buildGuards(found.run.cwd, [], parent.run.id).commandGuard });
    const result = await verifyTaskDelivery({ run: found.run, execute: async (command) => {
      const outcome = await operations.exec(command, found.run.cwd, { onData: () => {}, signal, timeout: 300 });
      if (outcome.exitCode !== 0) throw new Error(`独立复跑失败，退出码 ${outcome.exitCode}`);
    } });
    await this.runStore.update(runId, { result });
  }

  async status(runId: string): Promise<{ ok: true; run: RunRecord; errorDetails?: ErrorDetailsSummary } | { ok: false; reason: string }> {
    const result = await this.runStore.get(runId);
    if (!result.ok) return { ok: false, reason: result.reason };
    let errorDetails: ErrorDetailsSummary | undefined;
    if (result.run.errorDetails.status !== "none") {
      errorDetails = await summarizeErrorDetails({ dataRoot: this.dataRoot, repoId: this.repoId, runId });
    }
    return { ok: true, run: result.run, errorDetails };
  }

  async subscribeTranscript(runId: string, fromSeq: number, windowId: string, connected: () => boolean) {
    const found = await this.runStore.get(runId);
    if (!found.ok) throw protocolError("not_found", "运行不存在或不可读");
    const subscriptionId = randomUUID();
    const saved = readTranscript({ dataRoot: this.dataRoot, repoId: this.repoId, runId });
    if (!saved.ok && isTerminalState(found.run.state)) throw new Error(saved.detail);
    const entries = new Map((saved.ok ? saved.entries : []).map((entry) => [entry.seq, entry]));
    for (const entry of this.liveTranscripts.get(runId)?.entries ?? []) entries.set(entry.seq, entry);
    this.transcriptSubscriptions.set(subscriptionId, { runId, windowId, connected });
    return { subscriptionId, entries: [...entries.values()].filter((entry) => entry.seq > fromSeq), ended: isTerminalState(found.run.state) };
  }

  unsubscribeTranscript(subscriptionId: string, windowId: string): void {
    if (this.transcriptSubscriptions.get(subscriptionId)?.windowId === windowId) this.transcriptSubscriptions.delete(subscriptionId);
  }

  private publishTranscript(runId: string, payload: Record<string, unknown>): void {
    const windows = new Set<string>();
    for (const [id, subscription] of this.transcriptSubscriptions) {
      if (!subscription.connected()) this.transcriptSubscriptions.delete(id);
      else if (subscription.runId === runId) windows.add(subscription.windowId);
    }
    if (windows.size > 0) this.emit("transcript", { runId, ...payload }, (windowId) => windows.has(windowId));
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
      (candidate) => !isTerminalState(candidate.state) && candidate.state !== "interrupted" && candidate.state !== "queued",
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
    const entry = this.sessions.get(runId);
    if (!entry) throw protocolError("bad_params", "会话已不在内存中，请从持久化记录续接");
    await entry.handle.resume();
    await this.runStore.update(runId, { state: "running" });
    this.idleReminded.delete(runId);
    const updated = await this.runStore.get(runId);
    if (updated.ok) this.emit("runs.changed", { run: updated.run });

    const children = (await this.childrenOf(run)).filter(
      (candidate) => candidate.state === "paused" || candidate.state === "paused_network",
    );
    for (const child of children) await this.resume(child.id).catch(() => {});
    return { state: "running" };
  }

  async stop(runId: string): Promise<{ state: string; confirmed: boolean }> {
    this.waiting.delete(runId);
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
    const page = await this.runStore.list({ limit: Number.MAX_SAFE_INTEGER });
    const topLevel = page.items.filter(
      (run) => !isTerminalState(run.state) && run.state !== "interrupted" && (run.kind === "requirement" || run.parentRunId === undefined),
    );
    const results: Array<{ runId: string; state: string; confirmed: boolean; reason?: string }> = [];
    for (const run of topLevel) results.push({ runId: run.id, ...(await this.pause(run.id)) });
    return { results };
  }

  async resumeAll(): Promise<{ results: Array<{ runId: string; state: string }> }> {
    this.allPaused = false;
    const page = await this.runStore.list({ limit: Number.MAX_SAFE_INTEGER });
    const topLevel = page.items.filter(
      (run) => (run.state === "paused" || run.state === "paused_network") && (run.kind === "requirement" || run.parentRunId === undefined),
    );
    const results: Array<{ runId: string; state: string }> = [];
    for (const run of topLevel) results.push({ runId: run.id, ...(await this.resume(run.id)) });
    return { results };
  }

  async stopAll(): Promise<{ results: Array<{ runId: string; state: string; confirmed: boolean }> }> {
    const page = await this.runStore.list({ limit: Number.MAX_SAFE_INTEGER });
    const topLevel = page.items.filter(
      (run) => !isTerminalState(run.state) && (run.kind === "requirement" || run.parentRunId === undefined),
    );
    const results: Array<{ runId: string; state: string; confirmed: boolean }> = [];
    for (const run of topLevel) results.push({ runId: run.id, ...(await this.stop(run.id)) });
    return { results };
  }

  async adoptInterruptedShells(): Promise<void> {
    const page = await this.runStore.list({ states: ["interrupted"], limit: Number.MAX_SAFE_INTEGER });
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
    return this.withDispatchLock(() => this.resumeInterruptedLocked(runId));
  }

  private async resumeInterruptedLocked(
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

    if (run.pendingDispatch && !readRecord(sessionRecordRef({ dataRoot: this.dataRoot, repoId: this.repoId, runId })).exists) {
        const role = (run.role ?? "").replace(/^pi-company\./, "");
        const roleEntry = this.findRole(role);
        if (!roleEntry?.available) return { ok: false, state: "interrupted", confirmed: false, reason: `角色不可用: ${role}` };
        try {
          const execution = await this.executionSettings(cwdReal, role, run.dispatchContext, run.task);
          const queued = await this.runStore.update(runId, { state: "queued" });
          const outcome = await this.startRoleRun({ ...run, ...run.pendingDispatch, cwd: cwdReal, role, roleEntry, execution, context: run.dispatchContext, standalone: !run.parentRunId }, queued);
          const latest = await this.runStore.get(runId);
          return { ok: outcome.ok, state: latest.ok ? latest.run.state : "interrupted", confirmed: outcome.ok, ...(!outcome.ok ? { reason: outcome.reason } : {}) };
        } catch (error) {
          await this.runStore.update(runId, { state: "failed", stateReason: (error as Error).message });
          return { ok: false, state: "failed", confirmed: false, reason: (error as Error).message };
        }
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
        guards: this.buildGuards(cwdReal, run.writePaths, runId),
        networkGate: this.networkGate,
        dispatch: this.buildRequirementDispatch(cwdReal, run.requirement),
        relay: this.buildRequirementRelay(run.requirement),
        runStore: this.runStore,
        workspaceRepoIds: run.dispatchContext?.workspaceRepoIds ?? this.workspaceRepoIds,
        verifyDelivery: (childId, signal) => this.verifyDelivery(childId, run.requirement, signal),
        dispatchContext: run.dispatchContext, thinking: run.thinking,
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
          guards: this.buildGuards(cwdReal, run.writePaths, runId),
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
    const page = await this.runStore.list({ states: ["paused_network"], limit: Number.MAX_SAFE_INTEGER });
    for (const run of page.items) {
      if (run.model.provider !== providerId) continue;
      const entry = this.sessions.get(run.id);
      if (!entry) continue;
      await this.resume(run.id);
      await this.relayQueue
        .notify({
          requirement: run.requirement,
          repoId: this.repoId,
          runId: run.id,
          kind: "auto_resumed",
          message: `运行 ${run.id} 网络恢复后已自动续接`,
        })
        .catch(() => {});
    }
  }

  private registerSession(runId: string, entry: SessionEntry): void {
    this.sessions.set(runId, entry);
    this.onSessionEvent(runId, entry);
  }

  private onSessionEvent(runId: string, entry: SessionEntry): void {
    const events = entry.handle.events as EventEmitter;
    events.on("pause_confirmed", () => {
      void (async () => {
        let pendingId: string | undefined = runId;
        while (pendingId) {
          const found = await this.runStore.get(pendingId);
          if (!found.ok || found.run.state !== "pausing") break;
          const outcome = await this.pause(pendingId);
          if (!outcome.confirmed) break;
          pendingId = found.run.parentRunId;
        }
      })().catch(() => {});
    });
    const tools = new Map<string, { toolName: string; input: Record<string, unknown> }>();
    events.on("tool_start", (event: { toolCallId: string; toolName: string; input: Record<string, unknown> }) => {
      tools.set(event.toolCallId, event);
      this.emit("activity", { runId, kind: "tool_start", toolCallId: event.toolCallId, toolName: event.toolName, at: new Date().toISOString() });
      if (event.toolName === "bash" && typeof event.input?.command === "string") void this.runStore.recordCommand(runId, event.input.command).catch(() => {});
    });
    events.on("turn", () => {
      void this.runStore.recordTurn(runId).then((run) => this.emit("runs.changed", { run })).catch(() => {});
      this.emit("activity", { runId, kind: "turn", at: new Date().toISOString() });
    });
    events.on("transcript_message", (event: { type: string; message: { role: string; content: string | Array<{ type: string; text?: string; thinking?: string; name?: string; arguments?: unknown }> } }) => {
      const saved = readTranscript({ dataRoot: this.dataRoot, repoId: this.repoId, runId });
      if (event.type === "message_start") this.liveTranscripts.set(runId, { base: saved.ok ? saved.entries.at(-1)?.seq ?? 0 : 0, entries: [] });
      const live = this.liveTranscripts.get(runId);
      if (live && event.message.role === "assistant" && Array.isArray(event.message.content)) {
        live.entries = event.message.content.map((block, index) => ({ seq: live.base + index + 1, kind: block.type === "thinking" ? "thinking" as const : block.type === "toolCall" ? "toolcall" as const : "text" as const, summary: block.thinking ?? block.text ?? `${block.name ?? ""} ${JSON.stringify(block.arguments ?? {})}` }));
        for (const record of live.entries) this.publishTranscript(runId, { ...record });
      }
      if (event.type === "message_end" && saved.ok) {
        for (const record of saved.entries) this.publishTranscript(runId, { ...record });
        this.liveTranscripts.delete(runId);
      }
    });
    events.on("tool_end", (event: { toolCallId?: string; toolName?: string; isError?: boolean }) => {
      this.emit("activity", {
        runId,
        kind: "tool_end",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        filePath: !event.isError && ["write", "edit"].includes(event.toolName ?? "") ? tools.get(event.toolCallId ?? "")?.input?.path : undefined,
        at: new Date().toISOString(),
      });
      tools.delete(event.toolCallId ?? "");
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
    ).catch(async (error) => {
      await this.runStore.update(runId, { stateReason: `运行结算失败: ${(error as Error).message}` }).catch(() => {});
    });
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

    if (outcome.ok && current.run.kind === "role") {
      try {
        const phase = this.sessions.get(runId)?.phase ?? this.findRole(current.run.role!.replace(/^pi-company\./, ""))?.definition?.kind;
        if (!["work", "review", "acceptance", "plan"].includes(phase ?? "")) throw new Error("无法确认角色结果阶段");
        const result = await bindRunResult(current.run, phase as Phase, outcome.value);
        if (phase === "review" || phase === "acceptance") {
          const binding = result.binding;
          if (!current.run.sourceVersion || binding.codeHead !== current.run.sourceVersion.codeHead || binding.definitionFingerprint !== current.run.sourceVersion.definitionFingerprint) throw new Error("审查验收期间工作内容发生变化");
        }
        if (phase === "review") {
          const value = outcome.value as { reviewedHead: string; contentFingerprint: string };
          if (!current.run.reviewSnapshot || value.reviewedHead !== current.run.reviewSnapshot.head || value.contentFingerprint !== current.run.reviewSnapshot.fingerprint) throw new Error("审查裁决与系统派工快照不一致");
        }
        if (phase === "acceptance") {
          if (!current.run.reportPath) throw new Error("验收缺少指定报告位置");
          Object.assign(result, { reportDigest: await checkAcceptanceReport(outcome.value as AcceptanceResult, current.run.reportPath, current.run.commands ?? []) });
        }
        outcome = { ok: true, value: result };
      } catch (error) { outcome = { ok: false, error }; }
    }
    if (outcome.ok) {
      await this.settleTerminal(runId, "completed", { result: outcome.value });
    } else {
      const message = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
      await this.settleTerminal(runId, "failed", { stateReason: message });
      const detail = await writeErrorDetails({ dataRoot: this.dataRoot, repoId: this.repoId, runId }, {
        runId,
        model: current.run.model,
        error: outcome.error,
        submissions: (outcome.error as { submissions?: Submissions } | null)?.submissions,
      });
      await this.runStore.update(runId, { errorDetails: detail.saved ? { status: "saved", recordId: detail.recordId } : { status: "unavailable" } });
    }

    this.sessions.delete(runId);
    const updated = await this.runStore.get(runId);
    if (updated.ok) {
      this.emit("runs.changed", { run: updated.run });
      if (isTerminalState(updated.run.state)) {
        this.notifyParentOfChildTermination(updated.run);
        this.publishTranscript(runId, { ended: true });
        if (updated.run.kind === "requirement") await this.relayQueue.notify({ requirement: updated.run.requirement, repoId: this.repoId, runId, kind: updated.run.state === "completed" ? "completed" : "blocked", message: `需求 ${updated.run.requirement} ${updated.run.state === "completed" ? "已完成" : "执行失败"}` });
      }
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
    this.closed = true;
    if (this.waitingTimer) { this.clock.clearTimer(this.waitingTimer); this.waitingTimer = undefined; }
    for (const runId of [...this.waiting.keys()]) await this.stop(runId);
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

  register("dispatch.requirement", async (params, client) =>
    manager.dispatchRequirement({ requirement: params.requirement as string, cwd: params.cwd as string, context: { projectTrusted: false, ...(params.context as DispatchSettingsContext | undefined), workspaceRepoIds: client.repoIds, mcp: params.mcp as DispatchSettingsContext["mcp"] } }),
  );
  register("dispatch.review", async (params, client) =>
    manager.dispatchReview({
      requirement: params.requirement as string,
      cwd: params.cwd as string,
      baseline: params.baseline as string,
      context: { projectTrusted: false, ...(params.context as DispatchSettingsContext | undefined), workspaceRepoIds: client.repoIds, mcp: params.mcp as DispatchSettingsContext["mcp"] },
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
    const page = await manager.list({ limit: Number.MAX_SAFE_INTEGER });
    return { subscriptionId: randomUUID(), snapshot: page.items };
  });
  register("subscribe.transcript", async (params, client) => manager.subscribeTranscript(params.runId as string, (params.fromSeq as number | undefined) ?? 0, client.windowId, () => server.clients().some((entry) => entry.windowId === client.windowId && entry.sessionId === client.sessionId)));
  register("unsubscribe", async (params, client) => {
    manager.unsubscribeTranscript(params.subscriptionId as string, client.windowId);
    return {};
  });

  server.onHello = async (client: ClientInfo) => {
    const pending = await relayQueue.pendingFor({ windowId: client.windowId, repoIds: client.repoIds });
    const backlog = [
      ...pending.questions.map((payload) => ({ event: "relay.question" as const, payload })),
      ...pending.notices.map((payload) => ({ event: "relay.notice" as const, payload })),
    ].sort((a, b) => a.payload.createdAt.localeCompare(b.payload.createdAt));
    for (const item of backlog) {
      server.broadcast(item.event, item.payload as unknown as Record<string, unknown>, (info) => info.windowId === client.windowId);
      if (item.event === "relay.notice") await relayQueue.markDelivered(client.windowId, item.payload.id);
    }
  };

  server.markHandlersReady();
}
