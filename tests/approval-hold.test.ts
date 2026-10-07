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
async function approvedWhileRunning(failure: "affected" | "unaffected") {
  const w = await createPmRunWorld(cleanups);
  await w.plan.execute({ action: "propose", tasks: [spec("login", "goal.login"), spec("failure", "scenario.failure")] });
  await w.plan.execute({ action: "confirm", planVersion: 1 });
  const task = (key: string) => w.db((db) => db.list<TaskRecord>(TASKS).map((row) => row.data).find((entry) => entry.key === key)!);
  const state = async (id: string) => { const run = await w.runStore.get(id); return run.ok ? run.run.state : "missing"; };
  const planVersion = () => w.db((db) => db.read<{ planVersion: number }>("plans", w.fixture.requirementId)!.data.planVersion);
  w.provider.queue.push({ type: "text", text: "慢慢写失败场景", chunkDelayMs: 30_000 });
  const run = await w.manager.dispatchTask({ pmRunId: w.pm.runId, taskId: task("failure").taskId, retry: null });
  await until(async () => await state(run.runId) === "running" && w.provider.queue.length === 0);
  w.provider.queue.push({ type: "text", text: "PM 收到新版本差异" }, { type: "text", text: "PM 空闲" });
  await w.fixture.approveRevision({ body: BASE.replace("输入正确验证码后成功。", "输入正确验证码后成功并记住设备。"), implementGoals: ["goal.login", "scenario.failure"] });
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
