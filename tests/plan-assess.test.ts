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
  await kit.consume();
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
  const assess = async (tasks: Array<[Task, string]>, global = "unaffected") => { await kit.consume(); return run({ action: "assess-update", revision: revision().revision, assessmentId: uuidv7(),
    tasks: tasks.map(([task, assessment]) => ({ taskId: task.taskId, version: task.version, assessment, rationale: `${task.key} ${assessment}` })),
    global: { assessment: global, rationale: "整体判断" } }); };
  return { fixture, kit, run, first, byKey, revision, gate, setStatus, assess };
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

test("M7-AC32：新版本收回某目标的实施授权后，该目标的任务不能判为无关，也不能再派出；PM 改不动时可升级给用户裁决", async () => {
  const { escalateTask } = await import("../runtime/task-dispatch.ts");
  const w = await world();
  const login = w.byKey(w.first, "login"), failure = w.byKey(w.first, "failure");
  await w.fixture.approveRevision({ body: BASE, implementGoals: ["scenario.failure"] });
  await expect(w.assess([[login, "unaffected"], [failure, "unaffected"]])).rejects.toMatchObject({ code: "assessment_invalid" });
  const assessed = await w.assess([[login, "affected"], [failure, "unaffected"]]);
  expect(w.byKey(assessed, "login").status).toBe("needs_update");
  await expect(w.run({ action: "update", planVersion: assessed.plan.planVersion,
    modify: [{ taskId: login.taskId, version: login.version, spec: spec("login", "goal.login") }] })).rejects.toMatchObject({ code: "unit_not_authorized" });
  const ref = { dataRoot: w.fixture.dataRoot, repoId: w.fixture.repoId, lease: w.fixture.lease, note: "登录目标被收回实施授权，计划改不动" };
  expect(() => escalateTask({ ...ref, taskId: failure.taskId })).toThrow("failure:pending 不在等待 PM 处置，目标也没有被新版本收回实施授权");
  expect(escalateTask({ ...ref, taskId: login.taskId }).status).toBe("awaiting_user");
});

test("M7-AC12：运行中任务被判为受影响后，子代理结局只记入尝试，不覆盖待更新状态，也不能按旧版本重派", async () => {
  const { beginTaskAttempt, finishTaskAttempt } = await import("../runtime/task-dispatch.ts");
  const w = await world();
  const login = w.byKey(w.first, "login"), failure = w.byKey(w.first, "failure");
  const ref = { dataRoot: w.fixture.dataRoot, repoId: w.fixture.repoId };
  const runId = uuidv7();
  beginTaskAttempt({ ...ref, lease: w.fixture.lease, taskId: login.taskId, runId, retry: null });
  await w.fixture.approveRevision({ body: BASE.replace("输入正确验证码后成功。", "输入正确验证码后成功并记住设备。"), implementGoals: ["goal.login", "scenario.failure"] });
  const assessed = await w.assess([[{ ...login, version: 1 }, "affected"], [failure, "unaffected"]]);
  expect(w.byKey(assessed, "login").status).toBe("needs_update");
  const finished = finishTaskAttempt({ ...ref, taskId: login.taskId, runId, turnsUsed: 2, outcome: "turn_limit_reached" });
  expect(finished).toMatchObject({ status: "needs_update", attempts: [{ runId, outcome: "turn_limit_reached", turnsUsed: 2 }] });
  expect(() => beginTaskAttempt({ ...ref, lease: w.fixture.lease, taskId: login.taskId, runId: uuidv7(), retry: { reason: "重试", maxTurns: 3 } }))
    .toThrow("task_not_ready");
});

test("M7-AC30：任务仍有运行中的尝试时不能再次派出，旧版本的运行结局不能把新版本标为完成", async () => {
  const { beginTaskAttempt, finishTaskAttempt } = await import("../runtime/task-dispatch.ts");
  const w = await world();
  const login = w.byKey(w.first, "login");
  const ref = { dataRoot: w.fixture.dataRoot, repoId: w.fixture.repoId };
  const oldRun = uuidv7();
  beginTaskAttempt({ ...ref, lease: w.fixture.lease, taskId: login.taskId, runId: oldRun, retry: null });
  const updated = await w.run({ action: "update", planVersion: 1, modify: [{ taskId: login.taskId, version: 1, spec: { ...spec("login", "goal.login"), maxTurns: 40 } }] });
  await w.run({ action: "confirm", planVersion: updated.plan.planVersion });
  expect(() => beginTaskAttempt({ ...ref, lease: w.fixture.lease, taskId: login.taskId, runId: uuidv7(), retry: { reason: "改写后重试", maxTurns: 40 } }))
    .toThrow("task_not_ready");
  const finished = finishTaskAttempt({ ...ref, taskId: login.taskId, runId: oldRun, turnsUsed: 5, outcome: "completed" });
  expect(finished).toMatchObject({ version: 2, status: "pending" });
  expect(() => beginTaskAttempt({ ...ref, lease: w.fixture.lease, taskId: login.taskId, runId: uuidv7(), retry: { reason: "改写后重试", maxTurns: 40 } })).not.toThrow();
});

test("M9：QA 只验实施授权覆盖的验收小节，未验证项指向授权外的章节时拒收并说明原因；授权内章节与非章节引用照常收下", async () => {
  const { CheckRoundService } = await import("../runtime/check-round.ts");
  const { createVerificationRunTool } = await import("../runtime/verification-run.ts");
  const { createResultSubmitTool } = await import("../runtime/result-submit.ts");
  const w = await world();
  await w.fixture.approveRevision({ body: BASE, implementGoals: ["goal.login"] });
  await w.assess([[w.byKey(w.first, "login"), "unaffected"], [w.byKey(w.first, "failure"), "affected"]]);
  for (const task of w.first.tasks) w.setStatus(task.taskId, "completed");
  const { fixture } = w, record = w.revision();
  const rounds = await CheckRoundService.open({ repositoryRoot: fixture.repositoryRoot, dataRoot: fixture.dataRoot, repoId: fixture.repoId, authorize: () => true });
  clean.push(() => rounds.dispose());
  const round = await rounds.openRound({ lease: fixture.lease });
  const qaRunId = uuidv7();
  const qa = await createVerificationRunTool({ repositoryRoot: fixture.repositoryRoot, dataRoot: fixture.dataRoot, authorize: () => true,
    grant: { role: "qa", callerId: uuidv7(), runId: qaRunId, requirementId: fixture.requirementId, repoId: fixture.repoId,
      workspaceId: record.workspace!.workspaceId, branch: record.workspace!.branch, epoch: record.epoch } });
  clean.push(() => qa.dispose());
  const formal = await qa.execute({ action: "run", kind: "formal", command: "true", performance: NA }) as { verificationId: string };
  const submit = (targetRef: string) => createResultSubmitTool({ grant: { role: "qa", callerId: uuidv7(), runId: qaRunId, parentRunId: fixture.lease.runId }, authorize: () => true,
    verdictBinding: { dataRoot: fixture.dataRoot, requirementId: fixture.requirementId, repoId: fixture.repoId, workspaceId: record.workspace!.workspaceId, epoch: record.epoch } })
    .execute({ action: "verdict", result: { checkRoundId: round.checkRoundId, verificationIds: [formal.verificationId], summary: "验收",
      findings: [{ kind: "unverified", targetRef, evidenceRef: null, trigger: "没有对应测试", impact: "无法确认" }] } }) as { conclusion: string };
  expect(() => submit("scenario.failure（待定场景）")).toThrow("scenario.failure 不在实施授权内（待定场景或交付流程要求），本轮不验");
  expect(submit("goal.login").conclusion).toBe("unverified");
  expect(submit("整体交互").conclusion).toBe("unverified");
});
