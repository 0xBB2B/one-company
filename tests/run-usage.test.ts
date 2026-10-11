import { afterEach, expect, test, vi } from "vitest";
import { repositoryDatabase, withDatabase } from "../runtime/database.ts";
import { TASKS } from "../runtime/plan-manage.ts";
import type { TaskSpec } from "../runtime/plan-manage.ts";
import { createPmRunWorld, until } from "./helpers/run-manager-fixture.ts";

vi.setConfig({ testTimeout: 60_000 });
const cleanups: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });
const NA = { applicable: false as const, reason: "无性能影响" };
const spec = (key: string, goal: string): TaskSpec => ({ key, role: "worker", goalUnitIds: [goal], constraintUnitIds: [], dependsOn: [], writePaths: ["src/"],
  blockedByQuestionIds: [], maxTurns: 5, objective: `实现 ${key}`, passCriteria: ["可观察通过"], scope: { in: [key], out: [] }, performance: NA });

async function world() {
  const w = await createPmRunWorld(cleanups);
  await w.plan.execute({ action: "propose", tasks: [spec("login", "goal.login"), spec("failure", "scenario.failure")] });
  await w.plan.execute({ action: "confirm", planVersion: 1 });
  const taskId = (key: string) => withDatabase(repositoryDatabase(w.fixture.dataRoot, w.fixture.repoId), (db) =>
    db.list<{ key: string; taskId: string }>(TASKS).map((row) => row.data).find((task) => task.key === key)!.taskId);
  const run = async (id: string) => { const result = await w.runStore.get(id); if (!result.ok) throw new Error(result.reason); return result.run; };
  return { ...w, taskId, run };
}

test("M7-AC33：每次模型回复的输入、输出、缓存读写与每次工具结束都累加进各自运行记录，并随运行变更广播", async () => {
  const w = await world();
  expect((await w.run(w.pm.runId)).usage).toMatchObject({ input: 0, output: 0, toolUses: 1 });
  w.provider.queue.push(
    { type: "toolcall", name: "read", input: { path: "README.md" }, usage: { input: 100, output: 20, cacheRead: 300, cacheWrite: 50 } },
    { type: "toolcall", name: "one_company_result_submit", input: { action: "verdict", result: { checkRoundId: null, verificationIds: [], summary: "完成", findings: [] } },
      usage: { input: 10, output: 5, cacheRead: 400, cacheWrite: 0 } },
    { type: "text", text: "PM 收到", usage: { input: 7, output: 3, cacheRead: 0, cacheWrite: 0 } },
  );
  const worker = await w.manager.dispatchTask({ pmRunId: w.pm.runId, taskId: w.taskId("login"), retry: null });
  await until(async () => (await w.run(worker.runId)).state === "completed" && (await w.run(w.pm.runId)).usage?.input === 7);
  expect((await w.run(worker.runId)).usage).toEqual({ input: 110, output: 25, cacheRead: 700, cacheWrite: 50, toolUses: 2 });
  expect((await w.run(w.pm.runId)).usage).toEqual({ input: 7, output: 3, cacheRead: 0, cacheWrite: 0, toolUses: 1 });
});

test("M7-AC33：暂停 PM 连带暂停子代理并记下起点，恢复连带恢复并累加暂停时长", async () => {
  const w = await world();
  w.provider.queue.push({ type: "text", text: "慢慢写", chunkDelayMs: 5_000 });
  const worker = await w.manager.dispatchTask({ pmRunId: w.pm.runId, taskId: w.taskId("login"), retry: null });
  await until(async () => (await w.run(worker.runId)).state === "running");
  expect(await w.manager.pause(w.pm.runId)).toMatchObject({ state: "paused", confirmed: true });
  for (const id of [w.pm.runId, worker.runId]) expect(await w.run(id)).toMatchObject({ state: "paused", pausedAt: expect.any(String) });
  await new Promise((resolve) => setTimeout(resolve, 60));
  w.provider.queue.push({ type: "text", text: "继续" }, { type: "text", text: "继续" });
  expect(await w.manager.resume(w.pm.runId)).toEqual({ state: "running" });
  for (const id of [w.pm.runId, worker.runId]) {
    const run = await w.run(id);
    expect(run.state).not.toBe("paused");
    expect(run.pausedAt).toBeUndefined();
    expect(run.pausedMs).toBeGreaterThanOrEqual(50);
  }
});
