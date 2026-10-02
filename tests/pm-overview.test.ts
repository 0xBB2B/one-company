import { afterEach, expect, test, vi } from "vitest";
import { repositoryDatabase, withDatabase } from "../runtime/database.ts";
import { TASKS } from "../runtime/plan-manage.ts";
import type { TaskSpec } from "../runtime/plan-manage.ts";
import type { PmOverview } from "../runtime/pm-overview.ts";
import { PM_INTAKE_TOOL } from "../runtime/pm-intake-runtime.ts";
import { createPmRunWorld, until } from "./helpers/run-manager-fixture.ts";

vi.setConfig({ testTimeout: 60_000 });
const cleanups: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });
const NA = { applicable: false as const, reason: "无性能影响" };
const spec = (key: string, goal: string): TaskSpec => ({ key, role: "worker", goalUnitIds: [goal], constraintUnitIds: [], dependsOn: [], writePaths: ["src/"],
  blockedByQuestionIds: [], maxTurns: 1, objective: `实现 ${key}`, passCriteria: ["可观察通过"], scope: { in: [key], out: [] }, performance: NA });

async function world(options: { review?: boolean } = {}) {
  const w = await createPmRunWorld(cleanups, options);
  const overview = async (): Promise<PmOverview> => (await w.manager.overviews())[0]!;
  const run = async (id: string) => { const result = await w.runStore.get(id); if (!result.ok) throw new Error(result.reason); return result.run; };
  const taskId = (key: string) => withDatabase(repositoryDatabase(w.fixture.dataRoot, w.fixture.repoId), (db) =>
    db.list<{ key: string; taskId: string }>(TASKS).map((row) => row.data).find((task) => task.key === key)!.taskId);
  return { ...w, overview, run, taskId };
}

test("M7-AC33/AC34：接手理解待核对时显示待办并暂停计时，核对后事项消失、计时恢复，状态行按真实规划状态生成并广播变更信号", async () => {
  const w = await world({ review: false });
  await until(async () => (await w.overview()).status === "waiting");
  expect(await w.overview()).toMatchObject({ goals: ["手机号正常登录", "验证码失败"], doing: "等待你的决定",
    pendingItems: [{ kind: "intake-review", label: "待你核对：PM 接手理解 r1" }] });
  await until(async () => (await w.run(w.pm.runId)).pausedAt !== undefined);
  expect(w.emit.mock.calls.some(([event]) => event === "pm.overview.changed")).toBe(true);

  await w.review();
  await until(async () => (await w.overview()).status === "running");
  expect(await w.overview()).toMatchObject({ doing: "规划中", pendingItems: [] });
  await until(async () => (await w.run(w.pm.runId)).pausedAt === undefined);
  expect((await w.run(w.pm.runId)).pausedMs).toBeGreaterThan(0);

  await w.plan.execute({ action: "propose", tasks: [spec("login", "goal.login"), spec("failure", "scenario.failure")] });
  expect((await w.overview()).doing).toBe("规划中（计划 v1 · 2 个任务）");
});

test("核对通过后 PM 又交了一份接手理解：面板重新出现待核对事项，核对最新那份通过后事项消失、可以提计划", async () => {
  const w = await world({ review: false });
  await until(async () => (await w.overview()).status === "waiting");
  // PM 收到通过通知后又交了一份，派工门槛只认最新那份
  w.provider.queue.push({ type: "toolcall", name: PM_INTAKE_TOOL, input: { action: "ask", purpose: "pm-intake", understanding: w.understanding } }, { type: "text", text: "又交了一份" });
  await w.review();
  await until(async () => (await w.overview()).pendingItems.length === 1);
  expect(await w.overview()).toMatchObject({ pendingItems: [{ kind: "intake-review", label: "待你核对：PM 接手理解 r1" }] });
  await expect(w.plan.execute({ action: "propose", tasks: [spec("login", "goal.login"), spec("failure", "scenario.failure")] })).rejects.toThrow("核对过的接手理解不是 PM 最新提交的那份");

  await w.review();
  await until(async () => (await w.overview()).pendingItems.length === 0);
  await w.plan.execute({ action: "propose", tasks: [spec("login", "goal.login"), spec("failure", "scenario.failure")] });
  expect((await w.overview()).doing).toBe("规划中（计划 v1 · 2 个任务）");
});

test("M7-AC33：子代理运行时状态行写明派工与尝试次数；用量按 PM 与子代理累计，缓存命中率按输入侧计算", async () => {
  const w = await world();
  await w.plan.execute({ action: "propose", tasks: [spec("login", "goal.login"), spec("failure", "scenario.failure")] });
  await w.plan.execute({ action: "confirm", planVersion: 1 });
  w.provider.queue.push({ type: "text", text: "写代码", chunkDelayMs: 3_000, usage: { input: 100, output: 20, cacheRead: 300, cacheWrite: 100 } });
  const worker = await w.manager.dispatchTask({ pmRunId: w.pm.runId, taskId: w.taskId("login"), retry: null });
  await until(async () => (await w.overview()).doing === "派 worker 执行 login（第 1 次尝试）");
  w.provider.queue.push({ type: "text", text: "收到", usage: { input: 50, output: 10, cacheRead: 0, cacheWrite: 0 } });
  await until(async () => (await w.run(worker.runId)).usage?.input === 100);
  const overview = await w.overview();
  expect(overview.tokens).toBe(100 + 20 + 300 + 100 + ((await w.run(w.pm.runId)).usage?.input ?? 0) + ((await w.run(w.pm.runId)).usage?.output ?? 0));
  expect(overview.toolUses).toBe(1);
  expect(overview.turns).toBeGreaterThanOrEqual(3);
  expect(overview.cacheRate).toBeCloseTo(300 / (100 + 300 + 100 + ((await w.run(w.pm.runId)).usage?.input ?? 0)), 5);
});

test("M7-AC33：两次未完成的任务成为待裁决事项；PM 空闲且无子代理运行时显示等待你的决定", async () => {
  const w = await world();
  await w.plan.execute({ action: "propose", tasks: [spec("login", "goal.login"), spec("failure", "scenario.failure")] });
  await w.plan.execute({ action: "confirm", planVersion: 1 });
  const login = w.taskId("login");
  w.provider.queue.push({ type: "toolcall", name: "read", input: { path: "README.md" } }, { type: "text", text: "PM 看到到限" });
  await w.manager.dispatchTask({ pmRunId: w.pm.runId, taskId: login, retry: null });
  await until(async () => (await w.run(w.pm.runId)).turns >= 3);
  w.provider.queue.push({ type: "toolcall", name: "read", input: { path: "README.md" } }, { type: "text", text: "PM 看到第二次到限" });
  await w.manager.dispatchTask({ pmRunId: w.pm.runId, taskId: login, retry: { reason: "估计不足", maxTurns: 1 } });
  await until(async () => (await w.overview()).status === "waiting");
  expect(await w.overview()).toMatchObject({ doing: "等待你的决定",
    pendingItems: [{ itemId: `task:${login}`, kind: "adjudicate", label: "待你裁决：任务 login 两次未完成" }] });
});
