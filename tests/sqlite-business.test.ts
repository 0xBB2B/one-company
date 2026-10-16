import { afterEach, expect, test } from "vitest";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { createRepoFixture, removeRepoFixture } from "./helpers/repo-fixture.ts";
import { createTempHome, removeTempHome } from "./helpers/temp-home.ts";
import { repositoryIdentity } from "../src/core/storage/identity.ts";
import { UUID_V7_PATTERN, uuidv7 } from "../src/core/storage/database.ts";
import { RunStore } from "../src/modules/agents/run-store.ts";
import { createSessionManagerForRun, readSessionEntries } from "../src/modules/agents/session-records.ts";
import { createClock } from "../src/core/policy/clock.ts";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
async function fixture() {
  const repo = await createRepoFixture(); cleanup.push(() => removeRepoFixture(repo));
  const home = await createTempHome(); cleanup.push(() => removeTempHome(home));
  const { repoId } = await repositoryIdentity(repo.root);
  const repoDir = join(home.dataRoot, "repos", repoId);
  const clock = createClock(); cleanup.push(async () => clock.stopGapWatcher());
  const store = new RunStore({ dataRoot: home.dataRoot, repoId, daemonStartedAt: "sqlite-test" });
  const requirement = uuidv7();
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

test("SDK 会话条目写入私有会话文件并可原样读回，不生成诊断文件", async () => {
  const w = await fixture();
  const run = await w.store.create(w.input);
  const ref = { dataRoot: w.home.dataRoot, repoId: w.repoId, runId: run.id };
  const session = createSessionManagerForRun({ ...ref, cwd: w.repo.root });
  session.appendMessage({ role: "user", content: [{ type: "text", text: "可恢复的对话" }], timestamp: Date.now() });
  expect(session.getSessionFile()).toBeUndefined();
  const restored = readSessionEntries(ref);
  if (!restored.ok) throw new Error(restored.detail);
  expect(restored.entries.slice(1)).toEqual(session.getEntries());
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

