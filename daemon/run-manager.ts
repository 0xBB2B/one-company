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
import type { RoleSessionHandle } from "./role-session.ts";
import type { RequirementAgentHandle } from "./requirement-agent.ts";
import type { RelayQueue } from "./relay-queue.ts";
import type { ClientInfo, DaemonServer } from "./server.ts";
import type { DaemonProjectBaselineProvider } from "./project-baseline-provider.ts";

export interface SelectedModel { provider: string; id: string }
export type ModelSelector = (input: { roleName: string; taskId?: string }) => SelectedModel;
export type EmitFn = (event: string, data: Record<string, unknown>, filter?: (windowId: string) => boolean) => void;
export interface RunManagerOptions {
  projectBaselineProvider?: (run: RunRecord) => Promise<DaemonProjectBaselineProvider>;
  dataRoot: string; repoId: string; runStore: RunStore; shellRegistry: ShellRegistry;
  networkGate: NetworkPauseGate; relayQueue: RelayQueue; roleCatalog: RoleCatalogEntry[];
  runtime: ModelRuntime; selectModel: ModelSelector; clock: Clock; workspaceRepoIds: string[]; emit: EmitFn;
}
export interface WaitForSpec { repo: string; requirement: string; stage: string }
interface SessionEntry { kind: RunKind; handle: RoleSessionHandle | RequirementAgentHandle }
export type RunMetadata = Pick<RunRecord, "id" | "kind" | "requirement" | "parentRunId" | "state" | "startedAt" | "updatedAt" | "endedAt" | "turns"> & { stateReason?: string };
function runMetadata(run: RunRecord): RunMetadata {
  const timestamp = (value: unknown) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
  if (!run || !UUID_V7_PATTERN.test(run.id) || !["requirement", "role"].includes(run.kind)
    || !["queued", "running", "pausing", "paused", "paused_network", "waiting_answer", "completed", "failed", "stopped", "interrupted"].includes(run.state)
    || !timestamp(run.startedAt) || !timestamp(run.updatedAt) || run.endedAt !== undefined && !timestamp(run.endedAt)
    || !Number.isSafeInteger(run.turns) || run.turns < 0 || run.parentRunId !== undefined && (!UUID_V7_PATTERN.test(run.parentRunId) || run.parentRunId === run.id || run.kind !== "role")) throw protocolError("legacy_metadata_unavailable", "运行元数据不可读，未知记录已保全待核对");
  if (!UUID_V7_PATTERN.test(run.requirement)) assertLegacyRequirementId(run.requirement);
  return { id: run.id, kind: run.kind, requirement: run.requirement, parentRunId: run.parentRunId,
    state: run.state, startedAt: run.startedAt, updatedAt: run.updatedAt, endedAt: run.endedAt, turns: run.turns,
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
  private readonly sessions = new Map<string, SessionEntry>();
  private started = false;
  private resolveStarted!: () => void;
  private readonly startedPromise: Promise<void>;

  constructor(options: RunManagerOptions) {
    this.startedPromise = new Promise((resolve) => { this.resolveStarted = resolve; });
    this.repoId = options.repoId;
    this.database = repositoryDatabase(options.dataRoot, options.repoId);
    this.runStore = options.runStore;
    this.shellRegistry = options.shellRegistry;
    this.relayQueue = options.relayQueue;
    this.emit = options.emit;
  }
  markStarted(): void { if (!this.started) { this.started = true; this.resolveStarted(); } }
  async awaitStarted(): Promise<void> { if (!this.started) await this.startedPromise; }
  async dispatchRequirement(_input: { requirement: string; cwd: string; context?: DispatchSettingsContext }): Promise<{ runId: string }> { throw retiredError(); }
  async dispatchReview(_params: { requirement: string; cwd: string; baseline: string; context?: DispatchSettingsContext; snapshot: { head: string; fingerprint: string } }): Promise<{ runId: string }> { throw retiredError(); }
  locateRequirementAgent(_requirement: string): { inject(message: string): void } | undefined { return undefined; }
  async canRunInParallel(_input: { cwd: string; requirement: string; task: string; writePaths: string[] }): Promise<{ ok: true } | { ok: false; reason: string }> { return { ok: false, reason: LEGACY_WORKFLOW_RETIRED }; }
  async verifyDelivery(_runId: string, _requirement: string, _signal?: AbortSignal): Promise<void> { throw retiredError(); }
  async resume(_runId: string): Promise<{ state: string }> { throw retiredError(); }
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
    if (confirmed) await this.runStore.update(runId, { state: "paused" });
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
        if (error instanceof Error && ["legacy_workflow_retired", "trusted_stop_required", "stop_unconfirmed", "legacy_metadata_unavailable", "not_found", "invalid_params"].includes((error as { code?: string }).code ?? "")) throw error;
        throw protocolError("legacy_metadata_unavailable", "旧运行状态不可读或操作尚未确认，未知记录已保全待核对");
      }
    });
  };
  // RPC 层与执行器分别拒绝；过期客户端不能靠旧方法名进入执行器。
  for (const method of ["dispatch.requirement", "dispatch.review", "runs.resume", "runs.resumeAll", "runs.resumeInterrupted", "relay.answer", "relay.forward", "subscribe.transcript"]) {
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
