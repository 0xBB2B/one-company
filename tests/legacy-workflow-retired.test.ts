import { afterEach, describe, expect, test, vi } from "vitest";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { RunManager, registerProtocolHandlers } from "../daemon/run-manager.ts";
import { RelayQueue } from "../daemon/relay-queue.ts";
import { registerAgentManageTool } from "../extensions/agent-manage.ts";
import relayExtension, { registerRelayInbox } from "../extensions/relay.ts";
import { currentVersion, executeWorkflowAction, createWorkflowTool, retryOnStaleVersion } from "../runtime/workflow-tool.ts";
import { advanceStage, checkResume, failTask, finishTask, recordShape, rejectRequirement, requirementStateRef, retreatStage, rollbackTask, skippedGates, startTask, updateTaskFields } from "../runtime/workflow-state.ts";
import { repositoryDatabase, putRecord, withDatabase, uuidv7 } from "../runtime/database.ts";
import { decisionStream } from "../runtime/decisions.ts";
import { createClock } from "../runtime/clock.ts";
import { NetworkPauseGate } from "../runtime/network-pause.ts";
import { RunStore } from "../runtime/run-store.ts";
import { ShellRegistry } from "../runtime/shell-registry.ts";
import { connectTestClient, createDaemonFixture, killDaemon, removeDaemonFixture, startDaemonForTest } from "./helpers/daemon-harness.ts";
import { modelProviderEnv, readProviderRequestsLog, writeTestModelProviders } from "./helpers/daemon-model-fixture.ts";

const SECRET = "OLD_TARGET_DO_NOT_LOAD_旧目标正文";
const REQUIREMENT = "2026-09-08.retired";
const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

async function world() {
  const fixture = await createDaemonFixture(); cleanup.push(() => removeDaemonFixture(fixture));
  const cwd = fixture.repo.root;
  const ctx = { cwd, dataRoot: fixture.dataRoot, requirement: REQUIREMENT };
  const database = repositoryDatabase(ctx.dataRoot, fixture.repoId);
  const clock = createClock(); cleanup.push(() => clock.stopGapWatcher());
  const shells = new ShellRegistry({ clock, database });
  cleanup.push(async () => { for (const task of shells.list()) await shells.stop(task.taskId); });
  const runs = new RunStore({ dataRoot: ctx.dataRoot, repoId: fixture.repoId, daemonStartedAt: "retire-test" });
  const deliver = vi.fn(async () => []);
  const inject = vi.fn();
  const relay = new RelayQueue({ dataDir: join(ctx.dataRoot, "repos", fixture.repoId), deliver, locateRequirementAgent: () => ({ inject }) });
  const selectModel = vi.fn(() => { throw new Error("不得选择模型"); });
  const runtime = new Proxy({}, { get() { throw new Error("不得读取模型运行时"); } });
  const manager = new RunManager({ ...ctx, repoId: fixture.repoId, runStore: runs, shellRegistry: shells,
    networkGate: new NetworkPauseGate(), relayQueue: relay, clock, emit: vi.fn(), roleCatalog: [], workspaceRepoIds: [fixture.repoId], selectModel, runtime: runtime as any });
  manager.markStarted();
  const shape = { tasks: [{ id: "T-1", title: SECRET, roles: ["worker"], writePaths: ["."], dependsOn: [] }], gates: { plan: false, whiteboxReview: false, blackboxAcceptance: false }, skipped: ["plan", "whiteboxReview", "blackboxAcceptance"].map((gate) => ({ gate, decisionId: "USER-001" })), acceptanceReport: SECRET, decisionId: "USER-001" };
  putRecord(requirementStateRef(ctx.dataRoot, fixture.repoId, REQUIREMENT), { requirement: REQUIREMENT, stage: "executing", shape,
    tasks: { "T-1": { progress: "doing", runId: null, description: SECRET, note: SECRET, reason: SECRET, repairRound: 4 } },
    history: [{ stage: "confirmed", decisionId: "USER-001", reason: SECRET }], followUps: [SECRET] });
  withDatabase(database, (db) => {
    db.append(decisionStream(REQUIREMENT, "user"), { id: "USER-001", actor: "user", requirement: REQUIREMENT, source: "model", trigger: SECRET, decision: SECRET, effects: ["scope", "repair:review:4", "repair:acceptance:4"], recordedAt: new Date().toISOString() });
    const id = uuidv7();
    db.create("relay_questions", id, { id, status: "pending", question: SECRET, options: [{ label: "确认", description: SECRET }], recommended: "确认", requirement: REQUIREMENT, repoId: fixture.repoId, runId: uuidv7(), createdAt: new Date().toISOString(), sequence: 1 });
  });
  const snapshot = () => withDatabase(database, (db) => JSON.stringify({ requirements: db.list("requirements"), user: db.events(decisionStream(REQUIREMENT, "user")), ai: db.events(decisionStream(REQUIREMENT, "ai")), relay: db.list("relay_questions"), runs: db.list("runs"), sessions: db.list("sessions") }));
  const createRun = async (state: "queued" | "paused" | "paused_network" | "interrupted" | "failed" = "queued") => {
    const run = await runs.create({ kind: "role", standalone: true, role: "pi-company.worker", phase: "work", requirement: REQUIREMENT, task: SECRET, cwd,
      writePaths: [cwd], readPaths: [cwd], model: { provider: "retire-model", id: "test" }, thinking: "off", mcp: [], pendingDispatch: { instructions: SECRET } });
    if (state === "interrupted") await runs.markInterruptedOnStartup();
    else if (state !== "queued") {
      await runs.update(run.id, { state: "running" });
      if (state === "paused") await runs.update(run.id, { state: "pausing" });
      await runs.update(run.id, { state, stateReason: SECRET, ...(state === "failed" ? { result: { verdict: "FAIL", details: SECRET } } : {}) });
    }
    return run;
  };
  return { fixture, ctx, database, manager, runs, shells, relay, shape, snapshot, createRun, selectModel, deliver, inject };
}

const ACTIONS = ["init", "update", "advance", "retreat", "task-start", "task-finish", "task-fail", "rollback", "reject", "shape-confirm", "resume-check"];
describe("M4 旧工作流授权和实际执行拒绝矩阵", () => {
  test.each(ACTIONS)("公开 workflow %s 在任何数据库/旧授权读取之前拒绝", async (action) => {
    const ctx = { cwd: "/missing", dataRoot: "/missing" };
    const params = { action, requirement: REQUIREMENT, actor: "user", role: "main", decisionId: "USER-001", runId: uuidv7(), version: 1 };
    expect(await executeWorkflowAction(params, ctx)).toMatchObject({ ok: false, details: { code: "legacy_workflow_retired" } });
    const beforeTaskFinish = vi.fn(); const onStateChange = vi.fn();
    await expect(createWorkflowTool({ ...ctx, beforeTaskFinish, onStateChange }).execute("x", params, undefined, undefined, ctx)).rejects.toThrow("永久淘汰");
    expect(beforeTaskFinish).not.toHaveBeenCalled(); expect(onStateChange).not.toHaveBeenCalled();
  });
  test("预存confirmed/shape/skipped/USER记录不能推进、返修、完成或恢复，原数据不变", async () => {
    const w = await world(); const before = w.snapshot();
    const input = { expectedVersion: 1, targetStage: "accepted", decisionId: "USER-001", runId: uuidv7(), taskId: "T-1", reason: "用户说批准", shape: w.shape, currentVersion: { codeHead: "old", definitionFingerprint: "old" } };
    for (const operation of [advanceStage, retreatStage, recordShape, startTask, finishTask, rollbackTask, rejectRequirement, updateTaskFields]) {
      expect(await (operation as any)(input, w.ctx)).toMatchObject({ ok: false, reason: expect.stringContaining("永久淘汰") });
    }
    expect(await checkResume(w.ctx, input.currentVersion)).toMatchObject({ ok: false });
    expect(skippedGates(w.shape)).toEqual([]);
    const build = vi.fn(); expect(await retryOnStaleVersion(w.ctx, REQUIREMENT, build)).toMatchObject({ ok: false }); expect(build).not.toHaveBeenCalled();
    await expect(currentVersion(w.ctx)).rejects.toThrow("永久淘汰");
    expect(w.snapshot()).toBe(before);
  });
  test("workflow查询仅元数据，不返回shape、正文、历史、说明或按fields索取正文", async () => {
    const w = await world(); const before = w.snapshot();
    const query = await executeWorkflowAction({ action: "query", requirement: REQUIREMENT }, w.ctx);
    expect(query.ok).toBe(true); expect(query.details.data).toEqual({ requirement: REQUIREMENT, stage: "executing", tasks: { "T-1": { progress: "doing", runId: null } } });
    expect(JSON.stringify(query)).not.toContain(SECRET);
    for (const field of ["shape", "history", "followUps", "description"]) expect(await executeWorkflowAction({ action: "query", requirement: REQUIREMENT, fields: [field] }, w.ctx)).toMatchObject({ ok: false });
    expect(w.snapshot()).toBe(before);
  });
  test("旧PM工厂、恢复工厂与独立planner资源已移除", async () => {
    const root = join(import.meta.dirname, "..");
    for (const path of ["daemon/requirement-agent.ts", "daemon/role-session.ts", "agents/planner.md", "agents/requirement-agent.md", "agents/acceptance.md"]) {
      await expect(readFile(join(root, path), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    }
  });
  test("主会话只注册 agent_manage，旧批量列表、批量停止与恢复入口不存在", async () => {
    const tools: any[] = []; const pi = { registerTool: (tool: any) => tools.push(tool) } as any;
    registerAgentManageTool(pi, () => { throw new Error("不得定位旧连接"); });
    expect(tools.map((tool) => tool.name)).toEqual(["pi_company_agent_manage"]);
    for (const action of ["list", "pauseAll", "stopAll", "resumeAll", "resumeInterrupted"]) {
      expect((await tools[0].execute("x", { action, repoId: "a".repeat(64) })).details.isError).toBe(true);
    }
  });
  test("daemon执行器移除子派工/排队/超限返修，并拒绝单个批量中断网络恢复", async () => {
    const w = await world();
    const paused = await w.createRun("paused"); const network = await w.createRun("paused_network");
    const queued = await w.createRun(); const failed = await w.createRun("failed");
    for (const phase of ["review", "acceptance"]) {
      for (let round = 0; round < 5; round++) {
        const attempt = await w.createRun("failed");
        withDatabase(w.database, (db) => {
          const stored = db.read<any>("runs", attempt.id)!;
          db.update("runs", attempt.id, stored.version, { ...stored.data, phase, result: { phase, verdict: "FAIL", summary: SECRET } });
        });
      }
    }
    const before = w.snapshot();
    for (const method of ["dispatchRoleInternal", "startRoleRun", "scheduleWaitingTasks", "assertRepairAllowed", "resumeInterruptedLocked", "buildRequirementRelay", "buildRequirementDispatch"]) expect((w.manager as any)[method]).toBeUndefined();
    expect("dispatchRequirement" in w.manager).toBe(false);
    await expect(w.manager.dispatchReview({ requirement: REQUIREMENT, cwd: w.ctx.cwd, baseline: "old", snapshot: { head: "old", fingerprint: "old" } })).rejects.toThrow("永久淘汰");
    await expect(w.manager.resume(paused.id)).rejects.toMatchObject({ code: "not_resumable" });
    await expect(w.manager.resume(network.id)).rejects.toMatchObject({ code: "not_resumable" });
    await expect(w.manager.resumeAll()).rejects.toThrow("永久淘汰");
    for (const run of [queued, failed, paused]) expect(await w.manager.resumeInterrupted(run.id)).toMatchObject({ ok: false, confirmed: false });
    await w.manager.resumeNetworkPaused("retire-model");
    expect(await w.manager.canRunInParallel({ ...w.ctx, task: "T-1", writePaths: [] })).toMatchObject({ ok: false });
    await expect(w.manager.verifyDelivery(failed.id, REQUIREMENT)).rejects.toThrow("永久淘汰");
    expect(w.manager.locateRequirementAgent(REQUIREMENT)).toBeUndefined();
    expect(w.selectModel).not.toHaveBeenCalled(); expect(w.snapshot()).toBe(before);
    for (const output of [await w.manager.status(failed.id), await w.manager.list()]) expect(JSON.stringify(output)).not.toContain(SECRET);
    await expect(w.manager.subscribeTranscript(failed.id, 0, "window", () => true)).rejects.toThrow("永久淘汰");
  });
  test("仅有真实失败运行可登记失败，不改写原运行结果或授予重试", async () => {
    const w = await world(); const run = await w.createRun();
    const ref = requirementStateRef(w.ctx.dataRoot, w.fixture.repoId, REQUIREMENT);
    withDatabase(w.database, (db) => {
      const record = db.read<any>(ref.namespace, ref.key)!;
      db.update(ref.namespace, ref.key, record.version, { ...record.data, tasks: { "T-1": { ...record.data.tasks["T-1"], runId: run.id } } });
      const stored = db.read<any>("runs", run.id)!;
      db.update("runs", run.id, stored.version, { ...stored.data, task: "T-1" });
    });
    const input = { expectedVersion: 2, taskId: "T-1", runId: run.id, reason: "实际执行失败" };
    expect(await failTask(input, w.ctx)).toMatchObject({ ok: false });
    await w.runs.update(run.id, { state: "failed", stateReason: SECRET, result: { verdict: "FAIL", details: SECRET } });
    const failure = await w.runs.get(run.id);
    expect(await failTask({ ...input, runId: uuidv7() }, w.ctx)).toMatchObject({ ok: false });
    expect(await failTask(input, w.ctx)).toMatchObject({ ok: true, version: 3 });
    expect(await w.runs.get(run.id)).toEqual(failure);
    expect(await startTask({ expectedVersion: 3, taskId: "T-1", runId: run.id }, w.ctx)).toMatchObject({ ok: false });
  });
  test("旧relay原语及积压读取不写答复、不拼旧目标、不注入任何模型", async () => {
    const w = await world(); const before = w.snapshot();
    await expect(w.relay.ask({ question: SECRET, requirement: REQUIREMENT, repoId: w.fixture.repoId, runId: uuidv7(), options: [], recommended: "确认" })).rejects.toThrow("永久淘汰");
    expect(await w.relay.answer(uuidv7(), "确认", "main")).toMatchObject({ ok: false });
    expect(await w.relay.forward({ requirement: REQUIREMENT, message: SECRET })).toMatchObject({ delivered: false });
    expect(await w.relay.pendingFor({ windowId: "main", repoIds: [w.fixture.repoId] })).toEqual({ questions: [], notices: [] });
    const pi = new Proxy({}, { get() { throw new Error("不得注册或注入旧正文"); } });
    relayExtension(pi as any); (await registerRelayInbox(pi as any, pi as any, "main"))();
    expect(w.inject).not.toHaveBeenCalled(); expect(w.deliver).not.toHaveBeenCalled(); expect(w.snapshot()).toBe(before);
  });
  test("真实Socket daemon拒绝旧RPC，重启有积压运行不发模型请求且不读旧会话", async () => {
    const w = await world();
    const queued = await w.createRun();
    // 只有测试新建的旧格式资料；真实项目历史资料不读取。
    await mkdir(join(w.ctx.cwd, ".pi-company", "requirements", REQUIREMENT), { recursive: true });
    await writeFile(join(w.ctx.cwd, ".pi-company", "requirements", REQUIREMENT, "spec.md"), SECRET, { mode: 0o600 });
    const providers = await writeTestModelProviders(w.fixture.dataRoot, [{ providerId: "retire-model", modelId: "test", role: "requirement-agent", replies: [{ type: "text", text: SECRET }] }] as any);
    const log = join(w.fixture.dataRoot, "requests.jsonl"); await writeFile(log, "", { mode: 0o600 });
    const handle = await startDaemonForTest(w.fixture, { extraEnv: modelProviderEnv(providers, log) }); cleanup.push(() => killDaemon(handle));
    const client = await connectTestClient(w.fixture.socketPath, { cwd: w.ctx.cwd, workspaceRoot: w.ctx.cwd, repoIds: [w.fixture.repoId] }); cleanup.push(() => client.close());
    // hello早于启动收尾完成；状态RPC经过awaitStarted后再冻结拒绝测试基线。
    expect(await client.call("runs.get", { runId: queued.id })).toMatchObject({ run: { state: "interrupted" } });
    const before = w.snapshot();
    for (const [method, params] of [
      ["dispatch.requirement", { requirement: REQUIREMENT, cwd: w.ctx.cwd }],
      ["dispatch.review", { requirement: REQUIREMENT, cwd: w.ctx.cwd, baseline: "HEAD", snapshot: { head: "old", fingerprint: "old" } }],
      ["runs.resumeAll", {}], ["runs.resumeInterrupted", { runId: queued.id }],
      ["relay.answer", { questionId: uuidv7(), answer: "确认", windowId: "main" }],
      ["relay.forward", { requirement: REQUIREMENT, message: SECRET, windowId: "main" }],
      ["subscribe.transcript", { runId: queued.id, fromSeq: 0 }],
    ] as Array<[string, Record<string, unknown>]>) await expect(client.call(method, params)).rejects.toThrow("legacy_workflow_retired");
    await expect(client.call("runs.resume", { runId: queued.id })).rejects.toThrow("没有可续接");
    await expect(client.call("shells.markStopped", { taskId: "unknown", expectedPid: 99999, expectedStartedAt: "0", decisionId: "USER-001" })).rejects.toThrow("trusted_stop_required");
    expect(await client.call("relay.pending")).toEqual({ questions: [], notices: [] });
    for (const response of [await client.call("runs.list", { limit: 100 }), await client.call("runs.get", { runId: queued.id }), await client.call("subscribe.activity")]) expect(JSON.stringify(response)).not.toContain(SECRET);
    // 超过已删除队列调度器的一轮间隔；既有 queued 在启动时只登记中断，不续跑。
    await new Promise((resolve) => setTimeout(resolve, 1150));
    expect(await readProviderRequestsLog(log)).toEqual([]); expect(w.snapshot()).toBe(before);
    expect(await readFile(join(w.ctx.cwd, ".pi-company", "requirements", REQUIREMENT, "spec.md"), "utf8")).toBe(SECRET);
  }, 30_000);
  test("Shell USER裁定不调用markStopped；真正安全停止实际结束测试进程", async () => {
    const w = await world(); const handlers = new Map<string, any>();
    registerProtocolHandlers({ manager: w.manager, relayQueue: w.relay, shellRegistry: w.shells, server: { registerHandler: (name: string, fn: any) => handlers.set(name, fn), markHandlersReady() {} } as any });
    const mark = vi.spyOn(w.shells, "markStoppedByUser");
    const host = { kind: "main" as const, id: "legacy-retire-test" };
    const spawned = await w.shells.spawn({ taskId: uuidv7(), host, command: process.execPath, args: ["-e", "setInterval(()=>{},1000)"], cwd: w.ctx.cwd, mode: "background", runToken: uuidv7() });
    expect(spawned.ok).toBe(true); if (!spawned.ok) throw new Error(spawned.reason);
    const task = spawned.task;
    const params = { taskId: task.taskId, expectedPid: task.pid, expectedStartedAt: String(task.startedAt), decisionId: "USER-001" };
    await expect(handlers.get("shells.markStopped")(params, {})).rejects.toThrow("可信");
    expect(mark).not.toHaveBeenCalled(); expect(w.shells.get(task.taskId)?.status).not.toBe("stopped");
    expect((await handlers.get("shells.stop")({ ...params, expectedPid: task.pid + 1 }, {})).status).toBe("mismatch");
    const stopped = await handlers.get("shells.stop")(params, {});
    expect(["stopped", "exited"]).toContain(stopped.status);
    expect(() => process.kill(task.pid, 0)).toThrow();
    mark.mockRestore();
  }, 15_000);
});
