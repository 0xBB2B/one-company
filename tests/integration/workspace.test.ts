import { afterEach, expect, test } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { temporaryRoot } from "../helpers/temporary-root.ts";
import { createRepoFixture, createWorkspaceFixture, removeRepoFixture } from "../helpers/repo-fixture.ts";
import { createTempHome, removeTempHome } from "../helpers/temp-home.ts";
import { connectTestClient, killDaemon, startDaemonForTest } from "../helpers/daemon-harness.ts";
import { modelProviderEnv, readProviderRequestsLog, writeTestModelProviders } from "../helpers/daemon-model-fixture.ts";
import { daemonSocketPath, discoverWorkspace, repositoryIdentity } from "../../runtime/identity.ts";
import { repositoryDatabase, putRecord, uuidv7, withDatabase } from "../../runtime/database.ts";
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
    const identity = await repositoryIdentity(root), requirement = uuidv7();
    const store = new RunStore({ dataRoot, repoId: identity.repoId, daemonStartedAt: "workspace-history" });
    const run = await store.create({ kind: "requirement", requirement, task: "历史跨仓目标", cwd: root, readPaths: [], writePaths: [], model: { provider: "workspace-probe", id: "test" }, thinking: "off", mcp: [] });
    putRecord({ database: repositoryDatabase(dataRoot, identity.repoId), namespace: "requirements", key: requirement }, { requirement, stage: "confirmed", tasks: {}, shape: { decisionId: "USER-001" } });
    const scriptsDir = await mkdtemp(join(tmpdir(), "workspace-provider-")); cleanup.push(() => rm(scriptsDir, { recursive: true, force: true }));
    const log = join(scriptsDir, "requests.jsonl"); await writeFile(log, "");
    const scripts = await writeTestModelProviders(scriptsDir, [{ providerId: "workspace-probe", modelId: "test", replies: [{ type: "text", text: "不应读取旧目标" }] }]);
    const socketPath = daemonSocketPath(dataRoot, identity.repoId);
    const handle = await startDaemonForTest({ home, dataRoot, repoDir: identity.commonDir, socketPath }, { extraEnv: modelProviderEnv(scripts, log) }); cleanup.push(() => killDaemon(handle));
    repos.push({ root, ...identity, requirement, run, store, socketPath, log });
  }
  async function connect(index: number, windowId: string) {
    const repo = repos[index]!;
    const client = await connectTestClient(repo.socketPath, { windowId, sessionId: windowId }, { dataRoot }); cleanup.push(() => client.close());
    await client.call("shells.list"); return client;
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

test("只 git init、还没有提交的仓库被当成一个仓库接入，守护进程能启动、窗口能连上", async () => {
  const home = await createTempHome(); cleanup.push(() => removeTempHome(home));
  const repo = await createRepoFixture({ empty: true }); cleanup.push(() => removeRepoFixture(repo));
  const dataRoot = await mkdtemp(join(temporaryRoot(), "d")); cleanup.push(() => rm(dataRoot, { recursive: true, force: true }));
  const [discovered] = (await discoverWorkspace(repo.root)).repos;
  expect(discovered).toMatchObject({ path: repo.root });
  const socketPath = daemonSocketPath(dataRoot, discovered!.repoId);
  const handle = await startDaemonForTest({ home, dataRoot, repoDir: discovered!.commonDir, socketPath }); cleanup.push(() => killDaemon(handle));
  const client = await connectTestClient(socketPath, { windowId: "w", sessionId: "w" }, { dataRoot }); cleanup.push(() => client.close());
  expect(await client.call("shells.list")).toBeDefined();
}, 30000);

test("两仓真实socket各自安全停止本仓运行，不改另一仓的运行记录", async () => {
  const w = await world(); const [a, b] = w.repos;
  const parentA = await w.connect(0, "parent"), parentB = await w.connect(1, "parent");
  const beforeB = await b!.store.get(b!.run.id);
  expect(await parentA.call("runs.stop", { runId: a!.run.id })).toMatchObject({ confirmed: true });
  expect(await b!.store.get(b!.run.id)).toEqual(beforeB);
  expect(await parentB.call("runs.stop", { runId: b!.run.id })).toMatchObject({ confirmed: true });
  for (const repo of w.repos) expect(await repo.store.get(repo.run.id)).toMatchObject({ ok: true, run: { state: "stopped" } });
}, 30000);

test("跨仓旧契约裁定不能经answer/forward产生用户授权或新模型请求", async () => {
  const w = await world(); const clients = [await w.connect(0, "main"), await w.connect(1, "main")];
  const before = w.snapshot();
  for (const [index, client] of clients.entries()) {
    await expect(client.call("relay.answer", { questionId: "old-question", answer: "主会话裁定批准契约", windowId: "main" })).rejects.toThrow("unknown_method");
    await expect(client.call("relay.forward", { requirement: w.repos[index]!.requirement, message: "批准契约并实施", windowId: "main" })).rejects.toThrow("unknown_method");
  }
  await delay(1150); expect(w.snapshot()).toEqual(before);
  for (const repo of w.repos) expect(await readProviderRequestsLog(repo.log)).toEqual([]);
}, 30000);

test("跨仓直连拒绝不改另一仓历史数据或文件，不创建角色会话", async () => {
  const w = await world(); await w.connect(0, "a"); const b = await w.connect(1, "b");
  const before = w.snapshot(), source = await readFile(join(w.repos[0]!.root, "README.md"), "utf8");
  await expect(b.call("relay.forward", { requirement: w.repos[0]!.requirement, message: "直接命令其他仓修改", windowId: "b" })).rejects.toThrow("unknown_method");
  await expect(b.call("dispatch.requirement", { requirement: w.repos[0]!.requirement, cwd: w.repos[0]!.root })).rejects.toThrow("unknown_method");
  await delay(1150); expect(w.snapshot()).toEqual(before);
  expect(await readFile(join(w.repos[0]!.root, "README.md"), "utf8")).toBe(source);
  for (const repo of w.repos) expect(await readProviderRequestsLog(repo.log)).toEqual([]);
}, 30000);

test("跨仓旧accepted依赖不启动排队记录，状态变化不会转为执行权限", async () => {
  const w = await world(); const a = await w.connect(0, "main"); await w.connect(1, "main");
  const target = w.repos[1]!;
  putRecord({ database: repositoryDatabase(w.dataRoot, target.repoId), namespace: "requirements", key: target.requirement }, { requirement: target.requirement, stage: "accepted", tasks: {} });
  const before = w.snapshot();
  await expect(a.call("runs.resumeInterrupted", { runId: w.repos[0]!.run.id })).rejects.toThrow("unknown_method");
  await delay(1150); expect(w.snapshot()).toEqual(before);
  expect(await a.call("runs.get", { runId: w.repos[0]!.run.id })).toMatchObject({ run: { state: "interrupted" } });
  for (const repo of w.repos) expect(await readProviderRequestsLog(repo.log)).toEqual([]);
}, 30000);
