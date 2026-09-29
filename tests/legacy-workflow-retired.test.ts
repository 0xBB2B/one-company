import { afterEach, describe, expect, test, vi } from "vitest";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { RunManager, registerProtocolHandlers } from "../daemon/run-manager.ts";
import { RelayQueue } from "../daemon/relay-queue.ts";
import registerExtensions from "../extensions/index.ts";
import { registerAgentManageTool } from "../extensions/agent-manage.ts";
import { repositoryDatabase, putRecord, withDatabase, uuidv7 } from "../runtime/database.ts";
import { createClock } from "../runtime/clock.ts";
import { NetworkPauseGate } from "../runtime/network-pause.ts";
import { RunStore } from "../runtime/run-store.ts";
import { ShellRegistry } from "../runtime/shell-registry.ts";
import { createFakePi } from "./helpers/fake-pi.ts";
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
  const relay = new RelayQueue({ dataDir: join(ctx.dataRoot, "repos", fixture.repoId), deliver });
  const selectModel = vi.fn(() => { throw new Error("不得选择模型"); });
  const runtime = new Proxy({}, { get() { throw new Error("不得读取模型运行时"); } });
  const manager = new RunManager({ ...ctx, repoId: fixture.repoId, runStore: runs, shellRegistry: shells,
    networkGate: new NetworkPauseGate(), relayQueue: relay, clock, emit: vi.fn(), roleCatalog: [], workspaceRepoIds: [fixture.repoId], selectModel, runtime: runtime as any });
  manager.markStarted();
  putRecord({ database, namespace: "requirements", key: REQUIREMENT }, { requirement: REQUIREMENT, stage: "executing", shape: { decisionId: "USER-001", acceptanceReport: SECRET },
    tasks: { "T-1": { progress: "doing", runId: null, description: SECRET } }, history: [{ stage: "confirmed", decisionId: "USER-001", reason: SECRET }], followUps: [SECRET] });
  withDatabase(database, (db) => {
    db.append(`decisions:${REQUIREMENT}:user`, { id: "USER-001", actor: "user", requirement: REQUIREMENT, source: "model", trigger: SECRET, decision: SECRET, recordedAt: new Date().toISOString() });
    const id = uuidv7();
    db.create("relay_questions", id, { id, status: "pending", question: SECRET, options: [{ label: "确认", description: SECRET }], recommended: "确认", requirement: REQUIREMENT, repoId: fixture.repoId, runId: uuidv7(), createdAt: new Date().toISOString(), sequence: 1 });
  });
  const snapshot = () => withDatabase(database, (db) => JSON.stringify({ requirements: db.list("requirements"), user: db.events(`decisions:${REQUIREMENT}:user`), relay: db.list("relay_questions"), runs: db.list("runs"), sessions: db.list("sessions") }));
  const createRun = async (state: "queued" | "paused" | "paused_network" | "failed" = "queued") => {
    const run = await runs.create({ kind: "role", standalone: true, role: "pi-company.worker", requirement: REQUIREMENT, task: SECRET, cwd,
      writePaths: [cwd], readPaths: [cwd], model: { provider: "retire-model", id: "test" }, thinking: "off", mcp: [] });
    if (state !== "queued") {
      await runs.update(run.id, { state: "running" });
      if (state === "paused") await runs.update(run.id, { state: "pausing" });
      await runs.update(run.id, { state, stateReason: SECRET });
    }
    return run;
  };
  return { fixture, ctx, database, manager, runs, shells, relay, snapshot, createRun, selectModel, deliver };
}

describe("旧工作流永久移除，旧记录不产生授权", () => {
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
      await expect(tools[0].execute("x", { action, repoId: "a".repeat(64) })).rejects.toThrow(`pi_company_agent_manage 的 ${action} 动作失败。\n原因：参数不符合该动作的格式`);
    }
  });
  test("主会话只有核心工具：没有旧工作流、旧决定和主窗口提交工具，也不覆盖宿主 write/edit（tool_call 只有搜索排除与需求观察两处）", () => {
    const fakePi = createFakePi();
    registerExtensions(fakePi.pi);
    const names = fakePi.registeredTools().map((tool) => tool.name);
    for (const retired of ["pi_company_workflow", "pi_company_git_commit", "decision_record", "write", "edit"]) expect(names).not.toContain(retired);
    expect(fakePi.handlersFor("tool_call")).toHaveLength(2);
  });
  test("RunManager 不再提供旧派工、恢复、转录与并行判定入口", async () => {
    const w = await world(); const paused = await w.createRun("paused"); const failed = await w.createRun("failed");
    const before = w.snapshot();
    for (const method of ["dispatchReview", "canRunInParallel", "verifyDelivery", "resumeAll", "resumeInterrupted", "subscribeTranscript", "unsubscribeTranscript", "locateRequirementAgent"]) expect((w.manager as any)[method]).toBeUndefined();
    await expect(w.manager.resume(paused.id)).rejects.toMatchObject({ code: "not_resumable" });
    expect(w.selectModel).not.toHaveBeenCalled(); expect(w.snapshot()).toBe(before);
    for (const output of [await w.manager.status(failed.id), await w.manager.list()]) expect(JSON.stringify(output)).not.toContain(SECRET);
  });
  test("真实Socket daemon对旧RPC返回unknown_method，重启有积压运行不发模型请求且不读旧会话", async () => {
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
    ] as Array<[string, Record<string, unknown>]>) await expect(client.call(method, params)).rejects.toThrow("unknown_method");
    await expect(client.call("runs.resume", { runId: queued.id })).rejects.toThrow("没有可续接");
    await expect(client.call("shells.markStopped", { taskId: "unknown", expectedPid: 99999, expectedStartedAt: "0", decisionId: "USER-001" })).rejects.toThrow("trusted_stop_required");
    await expect(client.call("relay.pending")).rejects.toThrow("unknown_method");
    for (const response of [await client.call("runs.list", { limit: 100 }), await client.call("runs.get", { runId: queued.id })]) expect(JSON.stringify(response)).not.toContain(SECRET);
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
