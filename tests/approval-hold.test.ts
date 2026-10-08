import { afterEach, expect, test, vi } from "vitest";
import { uuidv7 } from "../runtime/database.ts";
import { TASKS } from "../runtime/plan-manage.ts";
import type { TaskRecord, TaskSpec } from "../runtime/plan-manage.ts";
import { createPmRunWorld, until } from "./helpers/run-manager-fixture.ts";

vi.setConfig({ testTimeout: 90_000, hookTimeout: 60_000 });
const cleanups: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });
const NA = { applicable: false as const, reason: "无性能影响" };
const BASE = "# 手机号正常登录 {#goal.login}\n输入正确验证码后成功。\n# 验证码失败 {#scenario.failure}\n错误验证码显示失败。\n";
const spec = (key: string, goal: string, patch: Partial<TaskSpec> = {}): TaskSpec => ({ key, role: "worker", goalUnitIds: [goal], constraintUnitIds: [], dependsOn: [],
  writePaths: [`${key}/`], blockedByQuestionIds: [], maxTurns: 5, objective: `实现 ${key}`, passCriteria: ["可观察通过"], scope: { in: [key], out: [] }, performance: NA, ...patch });

/** 计划已确认、failure 任务的 worker 正在运行时，用户批准了只改登录段的新版本；PM 读完差异并按给定结论复核。 */
async function approvedWhileRunning(failure: "affected" | "unaffected", options: { pmPausedFirst?: boolean } = {}) {
  const w = await createPmRunWorld(cleanups);
  await w.plan.execute({ action: "propose", tasks: [spec("login", "goal.login"), spec("failure", "scenario.failure")] });
  await w.plan.execute({ action: "confirm", planVersion: 1 });
  const task = (key: string) => w.db((db) => db.list<TaskRecord>(TASKS).map((row) => row.data).find((entry) => entry.key === key)!);
  const state = async (id: string) => { const run = await w.runStore.get(id); return run.ok ? run.run.state : "missing"; };
  const planVersion = () => w.db((db) => db.read<{ planVersion: number }>("plans", w.fixture.requirementId)!.data.planVersion);
  w.provider.queue.push({ type: "text", text: "慢慢写失败场景", chunkDelayMs: 30_000 });
  const run = await w.manager.dispatchTask({ pmRunId: w.pm.runId, taskId: task("failure").taskId, retry: null });
  await until(async () => await state(run.runId) === "running" && w.provider.queue.length === 0);
  if (options.pmPausedFirst) {
    await w.manager.pause(w.pm.runId);
    await until(async () => await state(run.runId) === "paused" && await state(w.pm.runId) === "paused");
  }
  w.provider.queue.push({ type: "text", text: "PM 收到新版本差异" }, { type: "text", text: "PM 空闲" });
  await w.fixture.approveRevision({ body: BASE.replace("输入正确验证码后成功。", "输入正确验证码后成功并记住设备。") });
  if (options.pmPausedFirst) {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    await w.manager.resume(w.pm.runId);
  }
  await until(async () => await state(run.runId) === "paused");
  expect(await state(w.pm.runId)).not.toBe("paused");
  await expect(w.manager.resume(run.runId)).rejects.toMatchObject({ code: "plan_not_confirmed" });
  await until(() => w.owner().context.baseline?.revision === 2);
  await w.readDiffs(["revision 1 → 2"]);
  await w.plan.execute({ action: "assess-update", revision: 2, assessmentId: uuidv7(), tasks: [
    { taskId: task("login").taskId, version: task("login").version, assessment: "affected", rationale: "登录要记住设备" },
    { taskId: task("failure").taskId, version: task("failure").version, assessment: failure, rationale: "失败场景" }],
    global: { assessment: "unaffected", rationale: "无全局变化" } });
  const modify = [{ taskId: task("login").taskId, version: task("login").version, spec: spec("login", "goal.login", { objective: "登录并记住设备" }) },
    ...(failure === "affected" ? [{ taskId: task("failure").taskId, version: task("failure").version, spec: spec("failure", "scenario.failure", { objective: "失败场景改做" }) }] : [])];
  await w.plan.execute({ action: "update", planVersion: planVersion(), modify });
  expect(await state(run.runId)).toBe("paused");
  await w.plan.execute({ action: "confirm", planVersion: planVersion() });
  return { w, task, state, run };
}

test("M8O-AC1：实施中批准新版本后子代理暂停、PM 照常复核，计划确认前不能恢复；所属任务没变的子代理在计划确认后恢复", async () => {
  const { w, task, run } = await approvedWhileRunning("unaffected");
  await until(async () => { const record = await w.runStore.get(run.runId); return record.ok && record.run.pausedAt === undefined && (record.run.pausedMs ?? 0) > 0; });
  const record = await w.runStore.get(run.runId);
  expect(record.ok && record.run.stopCause?.reason).not.toBe("replanned");
  expect(task("failure").attempts.map((attempt) => attempt.outcome)).not.toContain("superseded");
});

test("M8O-AC1：实施中批准新版本后，所属任务被判为受影响并修改的子代理在计划确认后停止，这次尝试记为被取代、不计入重试", async () => {
  const { w, task, state, run } = await approvedWhileRunning("affected");
  await until(async () => await state(run.runId) === "stopped");
  await until(() => task("failure").attempts[0]!.outcome !== "running");
  expect(task("failure").status).toBe("pending");
  expect(task("failure").attempts).toMatchObject([{ runId: run.runId, outcome: "superseded" }]);
  expect(await w.runStore.get(run.runId)).toMatchObject({ ok: true, run: { stopCause: { reason: "replanned" } } });
});

/** 任务 1（login）已完成、任务 2（failure）的 worker 正在运行时，用户批准了新版本。 */
async function midway(body: string) {
  const w = await createPmRunWorld(cleanups);
  await w.plan.execute({ action: "propose", tasks: [spec("login", "goal.login"), spec("failure", "scenario.failure")] });
  await w.plan.execute({ action: "confirm", planVersion: 1 });
  const task = (key: string) => w.db((db) => db.list<TaskRecord>(TASKS).map((row) => row.data).find((entry) => entry.key === key)!);
  const state = async (id: string) => { const run = await w.runStore.get(id); return run.ok ? run.run.state : "missing"; };
  const planVersion = () => w.db((db) => db.read<{ planVersion: number }>("plans", w.fixture.requirementId)!.data.planVersion);
  w.db((db) => {
    const row = db.read<TaskRecord>(TASKS, task("login").taskId)!;
    db.update(TASKS, row.data.taskId, row.version, { ...row.data, status: "completed", attempts: [{ runId: uuidv7(), maxTurns: 5, turnsUsed: 3, reason: null, outcome: "completed" }] });
  });
  w.provider.queue.push({ type: "text", text: "慢慢写失败场景", chunkDelayMs: 30_000 });
  const run = await w.manager.dispatchTask({ pmRunId: w.pm.runId, taskId: task("failure").taskId, retry: null });
  await until(async () => await state(run.runId) === "running" && w.provider.queue.length === 0);
  w.provider.queue.push({ type: "text", text: "PM 收到新版本差异" }, { type: "text", text: "PM 空闲" });
  await w.fixture.approveRevision({ body });
  await until(async () => await state(run.runId) === "paused");
  await until(() => w.owner().context.baseline?.revision === 2);
  await w.readDiffs(["revision 1 → 2"]);
  const assess = (login: "affected" | "unaffected", failure: "affected" | "unaffected") => w.plan.execute({ action: "assess-update", revision: 2, assessmentId: uuidv7(), tasks: [
    { taskId: task("login").taskId, version: task("login").version, assessment: login, rationale: "登录" },
    { taskId: task("failure").taskId, version: task("failure").version, assessment: failure, rationale: "失败场景" }],
    global: { assessment: "unaffected", rationale: "无全局变化" } });
  const rulings = async () => (await w.manager.overviews())[0]!.pendingItems.filter((item) => item.label.startsWith("待你裁决"));
  return { w, task, state, run, planVersion, assess, rulings };
}

test("M8O-AC4：任务 1 已完成、任务 2 进行中时追加需求且二者不受影响：保留二者，新计划从后续任务接着做，任务 2 的子代理恢复，不需要用户裁决", async () => {
  const { w, task, run, planVersion, assess, rulings } = await midway(`${BASE}# 重发验证码 {#goal.resend}\n可重发。\n`);
  await assess("unaffected", "unaffected");
  await w.plan.execute({ action: "update", planVersion: planVersion(), add: [spec("resend", "goal.resend")] });
  w.provider.queue.push({ type: "text", text: "接着写失败场景", chunkDelayMs: 30_000 });
  await w.plan.execute({ action: "confirm", planVersion: planVersion() });
  await until(async () => { const record = await w.runStore.get(run.runId); return record.ok && record.run.pausedAt === undefined && (record.run.pausedMs ?? 0) > 0; });
  expect(task("login").status).toBe("completed");
  w.provider.queue.push({ type: "text", text: "做重发", chunkDelayMs: 30_000 });
  await expect(w.manager.dispatchTask({ pmRunId: w.pm.runId, taskId: task("resend").taskId, retry: null })).resolves.toBeDefined();
  expect(await rulings()).toEqual([]);
});

test("M8O-AC4：任务 1 已完成、任务 2 进行中时追加需求且二者受影响：加修正任务改 1、改写 2，确认后任务 2 的旧尝试停止并记为被取代，接着派出，不需要用户裁决", async () => {
  const { w, task, state, run, planVersion, assess, rulings } = await midway(BASE.replace("输入正确验证码后成功。", "输入正确验证码后成功并记住设备。")
    .replace("错误验证码显示失败。", "错误验证码显示失败并提示重试。"));
  await assess("affected", "affected");
  await w.plan.execute({ action: "update", planVersion: planVersion(), cancel: [{ taskId: task("login").taskId, version: task("login").version }],
    add: [spec("login-fix", "goal.login", { objective: "已完成的登录补上记住设备" })],
    modify: [{ taskId: task("failure").taskId, version: task("failure").version, spec: spec("failure", "scenario.failure", { objective: "失败场景加提示重试" }) }] });
  await w.plan.execute({ action: "confirm", planVersion: planVersion() });
  await until(async () => await state(run.runId) === "stopped");
  await until(() => task("failure").attempts[0]!.outcome !== "running");
  expect(task("failure").attempts.map((attempt) => attempt.outcome)).toEqual(["superseded"]);
  w.provider.queue.push({ type: "text", text: "补记住设备", chunkDelayMs: 30_000 });
  await expect(w.manager.dispatchTask({ pmRunId: w.pm.runId, taskId: task("login-fix").taskId, retry: null })).resolves.toBeDefined();
  w.provider.queue.push({ type: "text", text: "重做失败场景", chunkDelayMs: 30_000 });
  await expect(w.manager.dispatchTask({ pmRunId: w.pm.runId, taskId: task("failure").taskId, retry: null })).resolves.toBeDefined();
  expect(await rulings()).toEqual([]);
});

test("M8O-AC1：用户先暂停了 PM（子代理连带暂停）再批准新版本，恢复 PM 后子代理仍停着，计划确认后所属任务被改写的子代理停止并记为被取代", async () => {
  const { w, task, state, run } = await approvedWhileRunning("affected", { pmPausedFirst: true });
  await until(async () => await state(run.runId) === "stopped");
  await until(() => task("failure").attempts[0]!.outcome !== "running");
  expect(task("failure").attempts.map((attempt) => attempt.outcome)).toEqual(["superseded"]);
  expect(await w.runStore.get(run.runId)).toMatchObject({ ok: true, run: { stopCause: { reason: "replanned" } } });
});
