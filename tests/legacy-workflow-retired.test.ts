import { afterEach, describe, expect, test, vi } from "vitest";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { RunManager, registerProtocolHandlers } from "../src/app/daemon/run-manager.ts";
import registerExtensions from "../src/app/extension/index.ts";
import { registerAgentManageTool } from "../src/modules/explore/agent-manage-extension.ts";
import { repositoryDatabase, putRecord, withDatabase, uuidv7 } from "../src/core/storage/database.ts";
import { createClock } from "../src/core/policy/clock.ts";
import { NetworkPauseGate } from "../src/core/host/network-pause.ts";
import { RunStore } from "../src/modules/agents/run-store.ts";
import { ShellRegistry } from "../src/core/host/shell-registry.ts";
import { createFakePi } from "./helpers/fake-pi.ts";
import { connectTestClient, createDaemonFixture, killDaemon, removeDaemonFixture, startDaemonForTest } from "./helpers/daemon-harness.ts";
import { modelProviderEnv, readProviderRequestsLog, writeTestModelProviders } from "./helpers/daemon-model-fixture.ts";

const SECRET = "OLD_TARGET_DO_NOT_LOAD_旧目标正文";
const REQUIREMENT = uuidv7();
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
  const runtime = new Proxy({}, { get() { throw new Error("不得读取模型运行时"); } });
  const manager = new RunManager({ ...ctx, repoId: fixture.repoId, runStore: runs, shellRegistry: shells,
    networkGate: new NetworkPauseGate(), clock, emit: vi.fn(), roleCatalog: [], workspaceRepoIds: [fixture.repoId], runtime: runtime as any });
  manager.markStarted();
  putRecord({ database, namespace: "requirements", key: REQUIREMENT }, { requirement: REQUIREMENT, stage: "executing", shape: { decisionId: "USER-001", acceptanceReport: SECRET },
    tasks: { "T-1": { progress: "doing", runId: null, description: SECRET } }, history: [{ stage: "confirmed", decisionId: "USER-001", reason: SECRET }], followUps: [SECRET] });
  withDatabase(database, (db) => {
    db.append(`decisions:${REQUIREMENT}:user`, { id: "USER-001", actor: "user", requirement: REQUIREMENT, source: "model", trigger: SECRET, decision: SECRET, recordedAt: new Date().toISOString() });
    const id = uuidv7();
    db.create("relay_questions", id, { id, status: "pending", question: SECRET, options: [{ label: "确认", description: SECRET }], recommended: "确认", requirement: REQUIREMENT, repoId: fixture.repoId, runId: uuidv7(), createdAt: new Date().toISOString(), sequence: 1 });
  });
  const snapshot = () => withDatabase(database, (db) => JSON.stringify({ requirements: db.list("requirements"), user: db.events(`decisions:${REQUIREMENT}:user`), relay: db.list("relay_questions"), runs: db.list("runs"), sessions: db.list("sessions") }));
  const parent = await runs.create({ kind: "requirement", requirement: REQUIREMENT, task: SECRET, cwd, writePaths: [], readPaths: [cwd],
    model: { provider: "retire-model", id: "test" }, thinking: "off", mcp: [] });
  await runs.update(parent.id, { state: "failed" });
  const createRun = async (state: "queued" | "paused" | "failed" = "queued") => {
    const run = await runs.create({ kind: "role", parentRunId: parent.id, role: "one-company.worker", requirement: REQUIREMENT, task: SECRET, cwd,
      writePaths: [cwd], readPaths: [cwd], model: { provider: "retire-model", id: "test" }, thinking: "off", mcp: [] });
    if (state !== "queued") {
      await runs.update(run.id, { state: "running" });
      if (state === "paused") await runs.update(run.id, { state: "pausing" });
      await runs.update(run.id, { state });
    }
    return run;
  };
  return { fixture, ctx, database, manager, runs, shells, snapshot, createRun };
}

describe("旧工作流永久移除，旧记录不产生授权", () => {
  test("独立planner资源已移除", async () => {
    await expect(readFile(join(import.meta.dirname, "..", "agents/planner.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
  test("主会话只注册 agent_manage", () => {
    const tools: any[] = []; const pi = { registerTool: (tool: any) => tools.push(tool) } as any;
    registerAgentManageTool(pi, () => { throw new Error("不得定位旧连接"); });
    expect(tools.map((tool) => tool.name)).toEqual(["one_company_agent_manage"]);
  });
  test("主会话不覆盖宿主 write/edit（tool_call 只有搜索排除、需求观察与项目规范写入拦截三处）", () => {
    const fakePi = createFakePi();
    registerExtensions(fakePi.pi);
    const names = fakePi.registeredTools().map((tool) => tool.name);
    for (const host of ["write", "edit"]) expect(names).not.toContain(host);
    expect(fakePi.handlersFor("tool_call")).toHaveLength(3);
  });
  test("没有会话的暂停记录不能续接，状态只给元数据", async () => {
    const w = await world(); const paused = await w.createRun("paused"); const failed = await w.createRun("failed");
    const before = w.snapshot();
    await expect(w.manager.resume(paused.id)).rejects.toMatchObject({ code: "not_resumable" });
    expect(w.snapshot()).toBe(before);
    expect(JSON.stringify(await w.manager.status(failed.id))).not.toContain(SECRET);
  });
  test("真实Socket daemon重启有积压运行不发模型请求且不读旧会话", async () => {
    const w = await world();
    const queued = await w.createRun();
    // 只有测试新建的旧格式资料；真实项目历史资料不读取。
    await mkdir(join(w.ctx.cwd, ".pi-company", "requirements", REQUIREMENT), { recursive: true });
    await writeFile(join(w.ctx.cwd, ".pi-company", "requirements", REQUIREMENT, "spec.md"), SECRET, { mode: 0o600 });
    const providers = await writeTestModelProviders(w.fixture.dataRoot, [{ providerId: "retire-model", modelId: "test", replies: [{ type: "text", text: SECRET }] }]);
    const log = join(w.fixture.dataRoot, "requests.jsonl"); await writeFile(log, "", { mode: 0o600 });
    const handle = await startDaemonForTest(w.fixture, { extraEnv: modelProviderEnv(providers, log) }); cleanup.push(() => killDaemon(handle));
    const client = await connectTestClient(w.fixture.socketPath); cleanup.push(() => client.close());
    // hello早于启动收尾完成；状态RPC经过awaitStarted后再冻结拒绝测试基线。
    expect(await client.call("runs.get", { runId: queued.id })).toMatchObject({ run: { state: "interrupted" } });
    const before = w.snapshot();
    await expect(client.call("runs.resume", { runId: queued.id })).rejects.toThrow("没有可续接");
    expect(JSON.stringify(await client.call("runs.get", { runId: queued.id }))).not.toContain(SECRET);
    // 超过已删除队列调度器的一轮间隔；既有 queued 在启动时只登记中断，不续跑。
    await new Promise((resolve) => setTimeout(resolve, 1150));
    expect(await readProviderRequestsLog(log)).toEqual([]); expect(w.snapshot()).toBe(before);
    expect(await readFile(join(w.ctx.cwd, ".pi-company", "requirements", REQUIREMENT, "spec.md"), "utf8")).toBe(SECRET);
  }, 30_000);
  test("Shell 身份不符不停止；真正安全停止实际结束测试进程", async () => {
    const w = await world(); const handlers = new Map<string, any>();
    registerProtocolHandlers({ manager: w.manager, shellRegistry: w.shells, server: { registerHandler: (name: string, fn: any) => handlers.set(name, fn), markHandlersReady() {} } as any });
    const host = { kind: "main" as const, id: "shell-stop-test" };
    const spawned = await w.shells.spawn({ taskId: uuidv7(), host, command: process.execPath, args: ["-e", "setInterval(()=>{},1000)"], cwd: w.ctx.cwd, mode: "background", runToken: uuidv7() });
    expect(spawned.ok).toBe(true); if (!spawned.ok) throw new Error(spawned.reason);
    const task = spawned.task;
    const params = { taskId: task.taskId, expectedPid: task.pid, expectedStartedAt: String(task.startedAt) };
    expect((await handlers.get("shells.stop")({ ...params, expectedPid: task.pid + 1 }, {})).status).toBe("mismatch");
    expect(w.shells.get(task.taskId)?.status).not.toBe("stopped");
    const stopped = await handlers.get("shells.stop")(params, {});
    expect(["stopped", "exited"]).toContain(stopped.status);
    expect(() => process.kill(task.pid, 0)).toThrow();
  }, 15_000);
});
