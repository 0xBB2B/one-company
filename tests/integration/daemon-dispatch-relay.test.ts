import { afterEach, expect, test } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authenticateTestClient, connectRawClient, connectTestClient, createDaemonFixture, killDaemon, removeDaemonFixture, resolveNodeExecutable, resolveSdkDir, startDaemonForTest } from "../helpers/daemon-harness.ts";
import { modelProviderEnv, readProviderRequestsLog, writeTestModelProviders } from "../helpers/daemon-model-fixture.ts";
import { connectDaemon } from "../../runtime/daemon-client.ts";
import { repositoryDatabase, putRecord, uuidv7, withDatabase } from "../../runtime/database.ts";
import { requirementStateRef } from "../../runtime/workflow-state.ts";
import { decisionStream } from "../../runtime/decisions.ts";
import { RunStore } from "../../runtime/run-store.ts";

const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function world(stage = "confirmed") {
  const fixture = await createDaemonFixture(); cleanup.push(() => removeDaemonFixture(fixture));
  const database = repositoryDatabase(fixture.dataRoot, fixture.repoId), requirement = "2026-09-10.relay-history";
  putRecord(requirementStateRef(fixture.dataRoot, fixture.repoId, requirement), { requirement, stage, tasks: {}, shape: { decisionId: "USER-001", skipped: ["review", "acceptance"] } });
  const store = new RunStore({ dataRoot: fixture.dataRoot, repoId: fixture.repoId, daemonStartedAt: "historical-record" });
  const run = await store.create({ kind: "requirement", requirement, task: "旧目标敏感标记", cwd: fixture.repo.root, writePaths: [], readPaths: [], model: { provider: "retired-relay", id: "test" }, thinking: "off", mcp: [] });
  const questionId = uuidv7();
  withDatabase(database, (db) => {
    db.append(decisionStream(requirement, "user"), { id: "USER-001", actor: "user", effects: ["scope"] });
    db.create("relay_questions", questionId, { id: questionId, status: "pending", requirement, repoId: fixture.repoId, runId: run.id, question: "旧问题不能进入模型", options: [], recommended: "确认", sequence: 1 });
  });
  const log = join(fixture.dataRoot, "requests.jsonl"); await writeFile(log, "");
  const scripts = await writeTestModelProviders(fixture.dataRoot, [{ providerId: "retired-relay", modelId: "test", replies: [{ type: "toolcall", name: "bash", input: { command: "printf forbidden > README.md" } }] }]);
  const handle = await startDaemonForTest(fixture, { extraEnv: modelProviderEnv(scripts, log) }); cleanup.push(() => killDaemon(handle));
  async function window(windowId: string, outside?: string) {
    const client = await connectTestClient(fixture.socketPath, { windowId, cwd: outside ?? fixture.repo.root, workspaceRoot: outside ?? fixture.repo.root, repoIds: outside ? [] : [fixture.repoId] }, { dataRoot: fixture.dataRoot }); cleanup.push(() => client.close());
    await client.call("runs.list"); return client;
  }
  const client = await window("window-a");
  const snapshot = () => withDatabase(database, (db) => JSON.stringify({ requirements: db.list("requirements"), runs: db.list("runs"), sessions: db.list("sessions"), questions: db.list("relay_questions"), decisions: db.events(decisionStream(requirement, "user")) }));
  return { fixture, database, requirement, run, questionId, log, handle, client, window, snapshot };
}

test("两个真实SDK客户端并发按需拉起同仓库时只启动一个daemon", async () => {
  const fixture = await createDaemonFixture(); cleanup.push(() => removeDaemonFixture(fixture));
  const input = { repoDir: fixture.repo.root, dataRoot: fixture.dataRoot, sdkDir: resolveSdkDir(), execPath: resolveNodeExecutable(), env: { ...fixture.home.env, PI_CODING_AGENT_DIR: fixture.home.agentDir } };
  const pair = await Promise.all(["a", "b"].map((id) => connectDaemon({ ...input, hello: { windowId: id, sessionId: id, pid: process.pid, cwd: fixture.repo.root, workspaceRoot: fixture.repo.root } })));
  const probe = await connectTestClient(fixture.socketPath, { cwd: fixture.repo.root, workspaceRoot: fixture.repo.root, repoIds: [fixture.repoId] }, { dataRoot: fixture.dataRoot });
  const pid = probe.helloResult.daemonPid as number;
  cleanup.push(async () => {
    probe.close(); for (const client of pair) client.close();
    process.kill(pid, "SIGTERM");
    for (let i = 0; i < 150; i++) { try { process.kill(pid, 0); } catch { return; } await delay(50); }
    throw new Error(`本测试daemon ${pid} 未退出`);
  });
  const second = await connectTestClient(fixture.socketPath, { cwd: fixture.repo.root, workspaceRoot: fixture.repo.root, repoIds: [fixture.repoId] }, { dataRoot: fixture.dataRoot }); cleanup.push(() => second.close());
  expect(second.helloResult.daemonPid).toBe(pid);
  for (const client of pair) { expect(client.state().status).toBe("connected"); expect((await client.call("runs.list")).items).toEqual([]); }
}, 25000);

for (const stage of ["draft", "confirmed", "executing"]) test(`旧${stage}需求及重复派工永久拒绝，不新增run/session/模型请求`, async () => {
  const w = await world(stage); const before = w.snapshot();
  for (let i = 0; i < 2; i++) await expect(w.client.call("dispatch.requirement", { requirement: w.requirement, cwd: w.fixture.repo.root })).rejects.toThrow("legacy_workflow_retired");
  await delay(1150); expect(w.snapshot()).toBe(before); expect(await readProviderRequestsLog(w.log)).toEqual([]);
  expect((await w.client.call("runs.list")).items).toEqual([expect.objectContaining({ id: w.run.id, state: "interrupted" })]);
}, 20000);

test("旧形状问题确认不产生角色派工，USER及skipped记录保持原样", async () => {
  const w = await world(); const before = w.snapshot();
  await expect(w.client.call("relay.answer", { questionId: w.questionId, answer: "确认", windowId: "window-a" })).rejects.toThrow("legacy_workflow_retired");
  await expect(w.client.call("dispatch.review", { requirement: w.requirement, cwd: w.fixture.repo.root, baseline: "old", snapshot: { head: "old", fingerprint: "old" } })).rejects.toThrow("legacy_workflow_retired");
  await delay(1150); expect(w.snapshot()).toBe(before); expect(await readProviderRequestsLog(w.log)).toEqual([]);
}, 20000);

test("两窗口及工作区外窗口均收不到旧问题；首答与迟到答复都不能取得授权", async () => {
  const w = await world();
  const outside = await mkdtemp(join(tmpdir(), "relay-outside-")); cleanup.push(() => rm(outside, { recursive: true, force: true }));
  const clients = [w.client, await w.window("window-b"), await w.window("outside", outside)];
  const events: unknown[] = []; for (const client of clients) { client.onEvent("relay.question", (event) => events.push(event)); client.onEvent("relay.withdraw", (event) => events.push(event)); }
  const before = w.snapshot();
  for (const client of clients) {
    await expect(client.call("relay.answer", { questionId: w.questionId, answer: "确认", windowId: "forged-main" })).rejects.toThrow("legacy_workflow_retired");
    expect(await client.call("relay.pending")).toEqual({ questions: [], notices: [] });
  }
  await delay(1150); expect(events).toEqual([]); expect(w.snapshot()).toBe(before); expect(await readProviderRequestsLog(w.log)).toEqual([]);
}, 20000);

test("重新连接不重放旧离线提问或旧完成通知，保全积压数据且不重启PM", async () => {
  const w = await world(); const noticeId = uuidv7();
  withDatabase(w.database, (db) => db.create("relay_notices", noticeId, { id: noticeId, requirement: w.requirement, repoId: w.fixture.repoId, runId: w.run.id, kind: "completed", message: "旧完成正文", deliveredTo: [], sequence: 2 }));
  const before = w.snapshot(); const noticeBefore = withDatabase(w.database, (db) => JSON.stringify(db.list("relay_notices")));
  const raw = await connectRawClient(w.fixture.socketPath); cleanup.push(() => raw.close());
  const events: unknown[] = []; raw.onEvent("relay.question", (event) => events.push(event)); raw.onEvent("relay.notice", (event) => events.push(event));
  await authenticateTestClient(raw, { windowId: "late", sessionId: "late", pid: process.pid, cwd: w.fixture.repo.root, workspaceRoot: w.fixture.repo.root, repoIds: [w.fixture.repoId] }, { dataRoot: w.fixture.dataRoot, expectedRepoId: w.fixture.repoId });
  await raw.call("runs.list"); await delay(1150);
  expect(events).toEqual([]); expect(w.snapshot()).toBe(before);
  expect(withDatabase(w.database, (db) => JSON.stringify(db.list("relay_notices")))).toBe(noticeBefore);
  expect(await readProviderRequestsLog(w.log)).toEqual([]);
}, 20000);

test.each(["本需求旧目标", "未知其他需求"])("旧直连转述不能注入模型或产生子派工：%s", async (target) => {
  const w = await world(); const before = w.snapshot();
  await expect(w.client.call("relay.forward", { requirement: target === "本需求旧目标" ? w.requirement : target, message: "转述用户要求立即实施", windowId: "window-a" })).rejects.toThrow("legacy_workflow_retired");
  await delay(1150); expect(w.snapshot()).toBe(before); expect(await readProviderRequestsLog(w.log)).toEqual([]);
}, 20000);
