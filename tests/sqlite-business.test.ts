import { afterEach, expect, test } from "vitest";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { createRepoFixture, removeRepoFixture } from "./helpers/repo-fixture.ts";
import { createTempHome, removeTempHome } from "./helpers/temp-home.ts";
import { repositoryIdentity } from "../runtime/identity.ts";
import { repositoryDatabase, withDatabase, UUID_V7_PATTERN, uuidv7 } from "../runtime/database.ts";
import { RunStore } from "../runtime/run-store.ts";
import { createSessionManagerForRun, openSessionManagerForRun, readTranscript } from "../runtime/session-records.ts";
import { RelayQueue } from "../daemon/relay-queue.ts";
import { createClock } from "../runtime/clock.ts";
import { WindowRegistry } from "../runtime/windows.ts";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
async function fixture() {
  const repo = await createRepoFixture(); cleanup.push(() => removeRepoFixture(repo));
  const home = await createTempHome(); cleanup.push(() => removeTempHome(home));
  const { repoId } = await repositoryIdentity(repo.root);
  const repoDir = join(home.dataRoot, "repos", repoId);
  const clock = createClock(); cleanup.push(async () => clock.stopGapWatcher());
  const store = new RunStore({ dataRoot: home.dataRoot, repoId, daemonStartedAt: "sqlite-test" });
  const requirement = "2026-09-10.sqlite-business";
  const input = { kind: "requirement" as const, requirement, task: "需求代理", cwd: repo.root, writePaths: [], readPaths: [repo.root], model: { provider: "test", id: "test" }, thinking: "off", mcp: [] };
  return { repo, home, repoId, repoDir, clock, store, requirement, input };
}

test("通用运行存储保证单个活动记录", async () => {
  const w = await fixture();
  const started = await Promise.all([w.store.createOrReuseRequirement(w.input), w.store.createOrReuseRequirement(w.input)]);
  expect(started[0]!.run.id).toBe(started[1]!.run.id);
  expect(started[0]!.run.id).toMatch(UUID_V7_PATTERN);
  expect(started.map((result) => result.reused).sort()).toEqual([false, true]);
  expect((await readdir(w.repoDir)).every((name) => name.startsWith("data.db"))).toBe(true);
});

test("SDK 会话从私有会话文件恢复，不生成诊断文件", async () => {
  const w = await fixture();
  const run = await w.store.create(w.input);
  const ref = { dataRoot: w.home.dataRoot, repoId: w.repoId, runId: run.id };
  const session = createSessionManagerForRun({ ...ref, cwd: w.repo.root });
  session.appendMessage({ role: "user", content: [{ type: "text", text: "可恢复的对话" }], timestamp: Date.now() });
  expect(session.getSessionFile()).toBeUndefined();
  const restored = openSessionManagerForRun(ref);
  expect(restored.ok).toBe(true);
  if (!restored.ok) throw new Error(restored.detail);
  expect(restored.manager.getEntries()).toEqual(session.getEntries());
  const transcript = readTranscript(ref);
  expect(transcript.ok && transcript.entries[0]?.summary).toBe("可恢复的对话");
  expect((await readdir(w.repoDir)).filter((name) => !name.startsWith("data.db"))).toEqual(["sessions"]);
});

test("多个运行存储实例交错登记回合与用量不丢失活动", async () => {
  const w = await fixture();
  const run = await w.store.create(w.input);
  const other = new RunStore({ dataRoot: w.home.dataRoot, repoId: w.repoId, daemonStartedAt: "other" });
  await Promise.all(Array.from({ length: 20 }, (_, index) => {
    const store = index % 2 ? w.store : other;
    return Promise.all([store.recordTurn(run.id), store.recordUsage(run.id, { toolUses: 1 })]);
  }));
  const found = await w.store.get(run.id);
  if (!found.ok) throw new Error(found.reason);
  expect(found.run.turns).toBe(20);
  expect(found.run.usage?.toolUses).toBe(20);
});

test("两实例固定状态通知回执可并发合并", async () => {
  const w = await fixture();
  const options = { dataDir: w.repoDir, deliver: async () => [] };
  const a = new RelayQueue(options); const b = new RelayQueue(options);
  const run = await w.store.create(w.input);
  const database = repositoryDatabase(w.home.dataRoot, w.repoId);
  await expect(a.notify({ requirement: w.requirement, repoId: w.repoId, runId: run.id, kind: "completed" as never, message: "完成" })).rejects.toThrow("只支持");
  expect(withDatabase(database, (db) => db.list("relay_notices"))).toEqual([]);
  const notice = await a.notify({ requirement: w.requirement, repoId: w.repoId, runId: run.id, kind: "blocked", message: "不得回显的旧正文" });
  await Promise.all([a.markDelivered("窗口甲", notice.id), b.markDelivered("窗口乙", notice.id)]);
  const record = withDatabase(repositoryDatabase(w.home.dataRoot, w.repoId), (db) => db.read<{ deliveredTo: string[] }>("relay_notices", notice.id));
  expect(record?.data.deliveredTo.sort()).toEqual(["窗口乙", "窗口甲"].sort());
});

test("注销后的迟到心跳不能复活窗口", async () => {
  const w = await fixture();
  const windows = new WindowRegistry({ repoDir: w.repoDir, clock: w.clock, bootId: async () => "boot", processStartedAt: async () => "start" });
  const windowId = uuidv7();
  await windows.register({ windowId, pid: process.pid, sessionId: "sdk-session", cwd: w.repo.root, workspaceRoot: w.repo.root });
  await windows.unregister(windowId); await windows.heartbeat(windowId);
  expect(await windows.isAlive(windowId)).toBe(false);
});
