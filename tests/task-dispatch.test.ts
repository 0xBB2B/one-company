import { afterEach, expect, test, vi } from "vitest";
import type { Context } from "@earendil-works/pi-ai";
import { repositoryDatabase, withDatabase } from "../runtime/database.ts";
import { TASKS } from "../runtime/plan-manage.ts";
import type { TaskSpec } from "../runtime/plan-manage.ts";
import type { ScriptedReply } from "./helpers/controlled-provider.ts";
import { createPmRunWorld, until } from "./helpers/run-manager-fixture.ts";

vi.setConfig({ testTimeout: 60_000 });
const cleanups: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });
const NA = { applicable: false as const, reason: "无性能影响" };
function spec(key: string, patch: Partial<TaskSpec> = {}): TaskSpec {
  return { key, role: "worker", goalUnitIds: ["goal.login"], constraintUnitIds: [], dependsOn: [], writePaths: ["src/"], blockedByQuestionIds: [],
    maxTurns: 2, objective: `实现 ${key}`, passCriteria: ["可观察通过"], scope: { in: [key], out: ["微信登录"] }, performance: NA, ...patch };
}

async function world() {
  const w = await createPmRunWorld(cleanups);
  const task = (key: string) => withDatabase(repositoryDatabase(w.fixture.dataRoot, w.fixture.repoId), (db) =>
    db.list<{ key: string; taskId: string; status: string; attempts: Array<{ outcome: string; turnsUsed: number; maxTurns: number; reason: string | null }> }>(TASKS)
      .map((row) => row.data).find((entry) => entry.key === key)!);
  const dispatch = (key: string, retry: { reason: string; maxTurns: number } | null = null) => w.manager.dispatchTask({ pmRunId: w.pm.runId, taskId: task(key).taskId, retry });
  return { ...w, task, dispatch };
}
const read = (n: number): ScriptedReply => ({ type: "toolcall", name: "read", input: { path: `README.md#${n}` } });
const lastPrompt = (request: Context | undefined) => JSON.stringify(request?.messages.at(-1) ?? "");

test("M7-AC27/28/29/30：到限自动上报 PM；重试须带原因且只有一次，再未完成即等待用户裁决", async () => {
  const w = await world();
  await w.plan.execute({ action: "propose", tasks: [spec("login"), spec("failure", { goalUnitIds: ["scenario.failure"] })] });
  await w.plan.execute({ action: "confirm", planVersion: 1 });

  const before = w.provider.requests.length;
  w.provider.queue.push(read(1), read(2), { type: "text", text: "PM 收到到限报告" });
  const first = await w.dispatch("login");
  expect(first.maxTurns).toBe(2);
  await until(() => w.task("login").status === "awaiting_parent");
  await until(() => w.provider.requests.length === before + 3);
  expect(w.task("login").attempts).toEqual([{ runId: first.runId, maxTurns: 2, turnsUsed: 2, reason: null, outcome: "turn_limit_reached" }]);
  expect(lastPrompt(w.provider.requests.at(-1))).toContain("turn_limit_reached");
  expect(await w.runStore.get(first.runId)).toMatchObject({ ok: true, run: { state: "failed", parentRunId: w.pm.runId, role: "pi-company.worker" } });

  await expect(w.dispatch("login")).rejects.toMatchObject({ code: "retry_required" });
  w.provider.queue.push(read(4), read(5), read(6), { type: "text", text: "PM 收到第二次到限" });
  const second = await w.dispatch("login", { reason: "轮次估计不足", maxTurns: 3 });
  await until(() => w.task("login").status === "awaiting_user");
  expect(w.task("login").attempts[1]).toMatchObject({ runId: second.runId, maxTurns: 3, turnsUsed: 3, reason: "轮次估计不足", outcome: "turn_limit_reached" });
  await expect(w.dispatch("login", { reason: "再试一次", maxTurns: 5 })).rejects.toMatchObject({ code: "task_not_ready" });
  await expect(w.plan.execute({ action: "update", planVersion: 1, add: [spec("login-again")] })).rejects.toMatchObject({ code: "task_not_ready" });
  await expect(w.dispatch("failure", { reason: "无需重试", maxTurns: 2 })).rejects.toMatchObject({ code: "retry_not_needed" });
});

test("M7-AC26/AC31：worker 在额度内提交工作报告即完成；依赖未完成、计划未冻结时拒绝派工", async () => {
  const w = await world();
  await w.plan.execute({ action: "propose", tasks: [spec("login"), spec("failure", { goalUnitIds: ["scenario.failure"], dependsOn: ["login"] })] });
  await expect(w.dispatch("login")).rejects.toMatchObject({ code: "plan_not_confirmed" });
  await w.plan.execute({ action: "confirm", planVersion: 1 });
  await expect(w.dispatch("failure")).rejects.toMatchObject({ code: "dependency_pending" });
  const login = w.task("login");
  w.provider.queue.push({ type: "toolcall", name: "pi_company_result_submit", input: { action: "verdict", result: { checkRoundId: null, verificationIds: [],
    summary: `完成 ${login.key}`, findings: [] } } }, { type: "text", text: "PM 收到完成结果" });
  const run = await w.dispatch("login");
  await until(() => w.task("login").status === "completed");
  expect(await w.runStore.get(run.runId)).toMatchObject({ ok: true, run: { state: "completed" } });
  const workerRequest = w.provider.requests.find((request) => request.systemPrompt?.includes("任务：login"))!;
  expect(workerRequest.tools?.map((tool) => tool.name).sort()).toEqual(["find", "grep", "ls", "pi_company_change_apply", "pi_company_result_submit",
    "pi_company_verification_run", "read"]);
  expect(workerRequest.systemPrompt).toContain("对话轮次上限：2");
});
