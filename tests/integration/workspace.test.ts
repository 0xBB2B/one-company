import { afterEach, expect, test } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { temporaryRoot } from "../helpers/temporary-root.ts";
import { createWorkspaceFixture, removeRepoFixture } from "../helpers/repo-fixture.ts";
import { createTempHome, removeTempHome } from "../helpers/temp-home.ts";
import { connectTestClient, killDaemon, startDaemonForTest } from "../helpers/daemon-harness.ts";
import { modelProviderEnv, readProviderRequestsLog, writeTestModelProviders } from "../helpers/daemon-model-fixture.ts";
import { daemonSocketPath, discoverWorkspace, repositoryIdentity } from "../../runtime/identity.ts";
import { repositoryDatabase, putRecord, withDatabase } from "../../runtime/database.ts";
import { requirementStateRef } from "../../runtime/workflow-state.ts";
import { RunStore } from "../../runtime/run-store.ts";

const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function world() {
  const home = await createTempHome(); cleanup.push(() => removeTempHome(home));
  const workspace = await createWorkspaceFixture(); cleanup.push(() => removeRepoFixture(workspace));
  const dataRoot = await mkdtemp(join(temporaryRoot(), "d")); cleanup.push(() => rm(dataRoot, { recursive: true, force: true }));
  const repos = [];
  for (const [index, root] of workspace.repos.entries()) {
    const identity = await repositoryIdentity(root), requirement = `2026-09-10.workspace-${index}`;
    const store = new RunStore({ dataRoot, repoId: identity.repoId, daemonStartedAt: "workspace-history" });
    const run = await store.create({ kind: "requirement", requirement, task: "历史跨仓目标", cwd: root, readPaths: [], writePaths: [], model: { provider: "workspace-probe", id: "test" }, thinking: "off", mcp: [] });
    putRecord(requirementStateRef(dataRoot, identity.repoId, requirement), { requirement, stage: "confirmed", tasks: {}, shape: { decisionId: "USER-001" } });
    const scriptsDir = await mkdtemp(join(tmpdir(), "workspace-provider-")); cleanup.push(() => rm(scriptsDir, { recursive: true, force: true }));
    const log = join(scriptsDir, "requests.jsonl"); await writeFile(log, "");
    const scripts = await writeTestModelProviders(scriptsDir, [{ providerId: "workspace-probe", modelId: "test", replies: [{ type: "text", text: "不应读取旧目标" }] }]);
    const socketPath = daemonSocketPath(dataRoot, identity.repoId);
    const handle = await startDaemonForTest({ home, dataRoot, repoDir: identity.commonDir, socketPath }, { extraEnv: modelProviderEnv(scripts, log) }); cleanup.push(() => killDaemon(handle));
    repos.push({ root, ...identity, requirement, run, store, socketPath, log });
  }
  async function connect(index: number, windowId: string, ids: string[]) {
    const repo = repos[index]!;
    const client = await connectTestClient(repo.socketPath, { windowId, sessionId: windowId, cwd: workspace.root, workspaceRoot: workspace.root, repoIds: ids }, { dataRoot }); cleanup.push(() => client.close());
    await client.call("runs.list"); return client;
  }
  const snapshot = () => repos.map((repo) => withDatabase(repositoryDatabase(dataRoot, repo.repoId), (db) => JSON.stringify({ requirements: db.list("requirements"), runs: db.list("runs"), sessions: db.list("sessions") })));
  return { home, workspace, dataRoot, repos, connect, snapshot };
}

test("父目录发现两个仓库并排除node_modules，仓库内只见自己，无关目录不可见", async () => {
  const workspace = await createWorkspaceFixture(); cleanup.push(() => removeRepoFixture(workspace));
  const unrelated = await mkdtemp(join(tmpdir(), "workspace-unrelated-")); cleanup.push(() => rm(unrelated, { recursive: true, force: true }));
  expect((await discoverWorkspace(workspace.root)).repos.map((repo) => repo.path).sort()).toEqual([...workspace.repos].sort());
  expect((await discoverWorkspace(workspace.repos[0]!)).repos.map((repo) => repo.path)).toEqual([workspace.repos[0]!]);
  expect((await discoverWorkspace(unrelated)).repos).toEqual([]);
});

test("两仓真实socket的安全停止通知只投递对应repo窗口，工作区外窗口无事件或待办", async () => {
  const w = await world(); const [a, b] = w.repos; const ids = w.repos.map((repo) => repo.repoId);
  const parentA = await w.connect(0, "parent", ids), parentB = await w.connect(1, "parent", ids);
  const insideA = await w.connect(0, "inside-a", [a!.repoId]);
  const insideAOnB = await w.connect(1, "inside-a", [a!.repoId]);
  const unrelated = await w.connect(0, "outside", ["0".repeat(64)]);
  const events = [parentA, parentB, insideA, insideAOnB, unrelated].map((client) => { const values: Record<string, unknown>[] = []; client.onEvent("relay.notice", (value) => values.push(value)); return values; });
  expect(await parentA.call("runs.stop", { runId: a!.run.id })).toMatchObject({ confirmed: true });
  expect(await parentB.call("runs.stop", { runId: b!.run.id })).toMatchObject({ confirmed: true });
  await delay(200);
  expect(events[0]!.map((event) => event.repoId)).toEqual([a!.repoId]); expect(events[1]!.map((event) => event.repoId)).toEqual([b!.repoId]);
  expect(events[2]!.map((event) => event.repoId)).toEqual([a!.repoId]); expect(events[3]).toEqual([]); expect(events[4]).toEqual([]);
  for (const event of events.flat()) { expect(event.kind).toBe("stopped"); expect(event.message).not.toContain("历史跨仓目标"); }
  expect(await unrelated.call("relay.pending")).toEqual({ questions: [], notices: [] });
  expect(await insideAOnB.call("relay.pending")).toEqual({ questions: [], notices: [] });
}, 30000);

test("跨仓旧契约裁定不能经answer/forward产生用户授权或新模型请求", async () => {
  const w = await world(); const clients = [await w.connect(0, "main", w.repos.map((repo) => repo.repoId)), await w.connect(1, "main", w.repos.map((repo) => repo.repoId))];
  const before = w.snapshot();
  for (const [index, client] of clients.entries()) {
    await expect(client.call("relay.answer", { questionId: "old-question", answer: "主会话裁定批准契约", windowId: "main" })).rejects.toThrow("legacy_workflow_retired");
    await expect(client.call("relay.forward", { requirement: w.repos[index]!.requirement, message: "批准契约并实施", windowId: "main" })).rejects.toThrow("legacy_workflow_retired");
  }
  await delay(1150); expect(w.snapshot()).toEqual(before);
  for (const repo of w.repos) expect(await readProviderRequestsLog(repo.log)).toEqual([]);
}, 30000);

test("跨仓直连拒绝不改另一仓历史数据或文件，不创建角色会话", async () => {
  const w = await world(); await w.connect(0, "a", [w.repos[0]!.repoId]); const b = await w.connect(1, "b", [w.repos[1]!.repoId]);
  const before = w.snapshot(), source = await readFile(join(w.repos[0]!.root, "README.md"), "utf8");
  await expect(b.call("relay.forward", { requirement: w.repos[0]!.requirement, message: "直接命令其他仓修改", windowId: "b" })).rejects.toThrow("legacy_workflow_retired");
  await expect(b.call("dispatch.requirement", { requirement: w.repos[0]!.requirement, cwd: w.repos[0]!.root })).rejects.toThrow("legacy_workflow_retired");
  await delay(1150); expect(w.snapshot()).toEqual(before);
  expect(await readFile(join(w.repos[0]!.root, "README.md"), "utf8")).toBe(source);
  for (const repo of w.repos) expect(await readProviderRequestsLog(repo.log)).toEqual([]);
}, 30000);

test("跨仓旧accepted依赖不启动排队记录，状态变化不会转为执行权限", async () => {
  const w = await world(); const a = await w.connect(0, "main", w.repos.map((repo) => repo.repoId)); await w.connect(1, "main", w.repos.map((repo) => repo.repoId));
  const target = w.repos[1]!;
  putRecord(requirementStateRef(w.dataRoot, target.repoId, target.requirement), { requirement: target.requirement, stage: "accepted", tasks: {} });
  const before = w.snapshot();
  await expect(a.call("runs.resumeInterrupted", { runId: w.repos[0]!.run.id })).rejects.toThrow("legacy_workflow_retired");
  await delay(1150); expect(w.snapshot()).toEqual(before);
  expect(await a.call("runs.get", { runId: w.repos[0]!.run.id })).toMatchObject({ run: { state: "interrupted" } });
  for (const repo of w.repos) expect(await readProviderRequestsLog(repo.log)).toEqual([]);
}, 30000);
