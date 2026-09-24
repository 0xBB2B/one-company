import { afterEach, expect, test, vi } from "vitest";
import { repositoryDatabase, uuidv7, withDatabase } from "../runtime/database.ts";
import { createPlanManageTool, TASKS } from "../runtime/plan-manage.ts";
import type { TaskSpec } from "../runtime/plan-manage.ts";
import { evaluatePmIntakeGate } from "../runtime/pm-intake-runtime.ts";
import { createPmIntakeFixture } from "./helpers/pm-intake-fixture.ts";
import { pmIntakeReviewKit } from "./helpers/pm-intake-review.ts";

vi.setConfig({ testTimeout: 60_000 });
const clean: Array<() => unknown> = [];
afterEach(async () => { for (const fn of clean.splice(0).reverse()) await fn(); });

const NA = { applicable: false as const, reason: "无性能影响" };
const BASE = "# 手机号正常登录 {#goal.login}\n输入正确验证码后成功。\n# 验证码失败 {#scenario.failure}\n错误验证码显示失败。\n";
function spec(key: string, goal: string): TaskSpec {
  return { key, role: "worker", goalUnitIds: [goal], constraintUnitIds: [], dependsOn: [], writePaths: ["src/"], blockedByQuestionIds: [],
    maxTurns: 30, objective: `实现 ${goal}`, passCriteria: [`${goal} 可观察通过`], scope: { in: [goal], out: ["微信登录"] }, performance: NA };
}
type Task = { taskId: string; key: string; version: number; status: string };
type View = { plan: { planVersion: number; confirmedVersion: number | null; prodRevision: number }; tasks: Task[] };

async function world() {
  const fixture = await createPmIntakeFixture();
  clean.push(() => fixture.cleanup());
  const kit = await pmIntakeReviewKit(fixture);
  await kit.pass();
  const record = fixture.state.read(fixture.requirementId).data;
  const pm = await createPlanManageTool({ repositoryRoot: fixture.repositoryRoot, dataRoot: fixture.dataRoot, authorize: () => true,
    grant: { role: "pm", callerId: uuidv7(), runId: fixture.lease.runId, requirementId: fixture.requirementId, repoId: fixture.repoId,
      workspaceId: record.workspace!.workspaceId, lease: fixture.lease } });
  clean.push(() => pm.dispose());
  const run = (params: Record<string, unknown>) => pm.execute(params) as Promise<View>;
  const first = await run({ action: "propose", tasks: [spec("login", "goal.login"), spec("failure", "scenario.failure")] });
  await run({ action: "confirm", planVersion: 1 });
  const byKey = (view: View, key: string) => view.tasks.find((task) => task.key === key)!;
  const revision = () => fixture.state.read(fixture.requirementId).data;
  const gate = () => evaluatePmIntakeGate({ dataRoot: fixture.dataRoot, repoId: fixture.repoId, lease: fixture.lease });
  const setStatus = (taskId: string, status: string) => withDatabase(repositoryDatabase(fixture.dataRoot, fixture.repoId), (db) => {
    const row = db.read<Record<string, unknown>>(TASKS, taskId)!; db.update(TASKS, taskId, row.version, { ...row.data, status });
  });
  const assess = (tasks: Array<[Task, string]>, global = "unaffected") => run({ action: "assess-update", revision: revision().revision, assessmentId: uuidv7(),
    tasks: tasks.map(([task, assessment]) => ({ taskId: task.taskId, version: task.version, assessment, rationale: `${task.key} ${assessment}` })),
    global: { assessment: global, rationale: "整体判断" } });
  return { fixture, run, first, byKey, revision, gate, setStatus, assess };
}

test("M7-AC3/AC4：新增独立功能时原任务经复核保留；复核前门槛阻塞，复核补齐后新任务独立登记", async () => {
  const w = await world();
  const login = w.byKey(w.first, "login"), failure = w.byKey(w.first, "failure");
  await w.fixture.approveRevision({ body: `${BASE}# 重发验证码 {#goal.resend}\n可重发。\n`, implementGoals: ["goal.login", "scenario.failure", "goal.resend"] });
  expect(w.revision().pendingRevision).toBe(w.revision().revision);
  expect(w.gate()).toMatchObject({ allowed: false });
  await expect(w.run({ action: "update", planVersion: 2, add: [spec("resend", "goal.resend")] })).rejects.toMatchObject({ code: "intake_gate" });
  await expect(w.assess([[login, "unaffected"]])).rejects.toMatchObject({ code: "assessment_incomplete" });
  const assessed = await w.assess([[login, "unaffected"], [failure, "unaffected"]]);
  expect(w.revision().pendingRevision).toBeNull();
  expect(w.byKey(assessed, "login")).toMatchObject({ version: 1, status: "pending" });
  expect(w.gate()).toEqual({ allowed: true });
  await expect(w.run({ action: "confirm", planVersion: assessed.plan.planVersion })).rejects.toMatchObject({ code: "coverage_incomplete", detail: ["goal.resend"] });
  const updated = await w.run({ action: "update", planVersion: assessed.plan.planVersion, add: [spec("resend", "goal.resend")] });
  expect(w.byKey(updated, "login").version).toBe(1);
  expect(updated.tasks.map((task) => task.key)).toEqual(["login", "failure", "resend"]);
  expect(await w.run({ action: "confirm", planVersion: updated.plan.planVersion })).toMatchObject({ plan: { confirmedVersion: updated.plan.planVersion } });
});

test("M7-AC3：另一章节新增全局输入屏蔽时，原任务段落未改也被识别为受影响，不能判为无关", async () => {
  const w = await world();
  const login = w.byKey(w.first, "login"), failure = w.byKey(w.first, "failure");
  await w.fixture.approveRevision({ body: `${BASE}# 输入屏蔽 {#constraint.input-block}\n菜单打开时屏蔽输入。\n`,
    units: { "constraint.input-block": { globalConstraint: true } }, implementGoals: ["goal.login", "scenario.failure"] });
  await expect(w.assess([[login, "unaffected"], [failure, "affected"]])).rejects.toMatchObject({ code: "assessment_invalid" });
  const assessed = await w.assess([[login, "affected"], [failure, "affected"]]);
  expect(assessed.tasks.map((task) => task.status)).toEqual(["needs_update", "needs_update"]);
  await expect(w.run({ action: "confirm", planVersion: assessed.plan.planVersion })).rejects.toMatchObject({ code: "task_not_ready" });
  const refreshed = await w.run({ action: "update", planVersion: assessed.plan.planVersion,
    modify: assessed.tasks.map((task) => ({ taskId: task.taskId, version: task.version, spec: spec(task.key, task.key === "login" ? "goal.login" : "scenario.failure") })) });
  expect(refreshed.tasks.map((task) => [task.status, task.version])).toEqual([["pending", 2], ["pending", 2]]);
  expect(await w.run({ action: "confirm", planVersion: refreshed.plan.planVersion })).toMatchObject({ plan: { confirmedVersion: refreshed.plan.planVersion } });
});

test("M7-AC12：运行中、已完成、失败任务按 unaffected/affected/unknown 正确处理，unknown 阻止交付，迟到的旧复核被拒", async () => {
  const w = await world();
  const login = w.byKey(w.first, "login"), failure = w.byKey(w.first, "failure");
  w.setStatus(login.taskId, "completed"); w.setStatus(failure.taskId, "running");
  const oldRevision = w.revision().revision;
  await w.fixture.approveRevision({ body: `${BASE}# 重发验证码 {#goal.resend}\n可重发。\n`, implementGoals: ["goal.login", "scenario.failure", "goal.resend"] });
  await expect(w.run({ action: "assess-update", revision: oldRevision, assessmentId: uuidv7(),
    tasks: [login, failure].map((task) => ({ taskId: task.taskId, version: task.version, assessment: "unaffected", rationale: "旧" })),
    global: { assessment: "unaffected", rationale: "旧" } })).rejects.toMatchObject({ code: "assessment_invalid" });
  const unknown = await w.assess([[login, "unaffected"], [failure, "unknown"]]);
  expect(unknown.tasks.map((task) => task.status)).toEqual(["completed", "blocked"]);
  expect(w.revision().pendingRevision).toBe(w.revision().revision);
  expect(w.gate()).toMatchObject({ allowed: false, reasons: expect.arrayContaining(["pending_approved_update"]) });

  const v = await world();
  const vLogin = v.byKey(v.first, "login"), vFailure = v.byKey(v.first, "failure");
  v.setStatus(vLogin.taskId, "completed"); v.setStatus(vFailure.taskId, "failed");
  await v.fixture.approveRevision({ body: `${BASE}# 输入屏蔽 {#constraint.input-block}\n菜单打开时屏蔽输入。\n`,
    units: { "constraint.input-block": { globalConstraint: true } }, implementGoals: ["goal.login", "scenario.failure"] });
  const affected = await v.assess([[vLogin, "affected"], [vFailure, "affected"]]);
  expect(affected.tasks.map((task) => task.status)).toEqual(["needs_update", "needs_update"]);
  expect(v.revision().pendingRevision).toBeNull();
});

test("M7-AC2：连续加入快跑、跳跃、跳跃动画时各自成为独立任务，原任务不被改写", async () => {
  const w = await world();
  let body = BASE, goals = ["goal.login", "scenario.failure"], view = w.first;
  for (const [key, title] of [["goal.sprint", "快跑"], ["goal.jump", "跳跃"], ["goal.jump-anim", "跳跃动画"]]) {
    body += `# ${title} {#${key}}\n${title}的行为。\n`; goals = [...goals, key];
    await w.fixture.approveRevision({ body, implementGoals: goals });
    view = await w.assess(view.tasks.map((task) => [task, "unaffected"]));
    view = await w.run({ action: "update", planVersion: view.plan.planVersion, add: [spec(key, key)] });
    await w.run({ action: "confirm", planVersion: view.plan.planVersion });
  }
  expect(view.tasks.map((task) => [task.key, task.version])).toEqual([["login", 1], ["failure", 1], ["goal.sprint", 1], ["goal.jump", 1], ["goal.jump-anim", 1]]);
  expect(w.gate()).toEqual({ allowed: true });
});
