import { afterEach, describe, expect, test, vi } from "vitest";
import { repositoryDatabase, uuidv7, withDatabase } from "../src/core/storage/database.ts";
import { TASKS } from "../src/modules/pm/plan-manage.ts";
import type { TaskRecord, TaskSpec } from "../src/modules/pm/plan-manage.ts";
import { finishTaskAttempt, finishTaskReview } from "../src/modules/pm/task-dispatch.ts";
import { mainAdjudication } from "./helpers/main-adjudication.ts";
import { createPmRunWorld, until } from "./helpers/run-manager-fixture.ts";

const gate = vi.hoisted(() => ({ role: null as string | null, entered: 0, waiting: null as Promise<void> | null }));

vi.mock("../src/modules/agents/agent-session.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/modules/agents/agent-session.ts")>();
  return {
    ...actual,
    createAgentRoleSession: async (options: Parameters<typeof actual.createAgentRoleSession>[0]) => {
      if (gate.waiting && gate.role === options.definition.role) { gate.entered += 1; await gate.waiting; }
      return actual.createAgentRoleSession(options);
    },
  };
});

vi.setConfig({ testTimeout: 90_000, hookTimeout: 60_000 });
const cleanups: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => {
  gate.role = null; gate.waiting = null; gate.entered = 0;
  for (const fn of cleanups.splice(0).reverse()) await fn();
});
const NA = { applicable: false as const, reason: "无性能影响" };
const BASE = "# 手机号正常登录 {#goal.login}\n输入正确验证码后成功。\n# 验证码失败 {#scenario.failure}\n错误验证码显示失败。\n";
const spec = (key: string, goal: string, patch: Partial<TaskSpec> = {}): TaskSpec => ({ key, role: "worker", goalUnitIds: [goal], constraintUnitIds: [], dependsOn: [],
  writePaths: [`${key}/`], blockedByQuestionIds: [], maxTurns: 1, objective: `实现 ${key}`, passCriteria: ["可观察通过"], scope: { in: [key], out: [] }, performance: NA, ...patch });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Decision = NonNullable<TaskRecord["userDecision"]>;
const decisionOf = (patch: Partial<Decision>): Decision => ({ decisionId: uuidv7(), choice: "retry", maxTurns: 3, revision: 1, taskVersion: 1, usedByRunId: null, notified: true, ...patch });
const attemptOf = (runId: string, outcome: TaskRecord["attempts"][number]["outcome"]): TaskRecord["attempts"][number] => ({ runId, maxTurns: 1, turnsUsed: 0, reason: null, outcome });

async function world() {
  const w = await createPmRunWorld(cleanups);
  await w.plan.execute({ action: "propose", tasks: [spec("login", "goal.login"), spec("failure", "scenario.failure")] });
  await w.plan.execute({ action: "confirm", planVersion: 1 });
  const task = (key: string) => w.db((db) => db.list<TaskRecord>(TASKS).map((row) => row.data).find((entry) => entry.key === key)!);
  const seed = (key: string, patch: Partial<TaskRecord>) => w.db((db) => {
    const row = db.read<TaskRecord>(TASKS, task(key).taskId)!;
    db.update(TASKS, row.data.taskId, row.version, { ...row.data, ...patch });
  });
  const where = { dataRoot: w.fixture.dataRoot, repoId: w.fixture.repoId };
  return { w, task, seed, where };
}

/** 任务正在跑第三次尝试 runId，用户的决定登记在 decision 上。 */
async function runningAttempt(decision: Decision | undefined, runId: string, patch: Partial<TaskRecord> = {}) {
  const x = await world();
  x.seed("login", { status: "running", attempts: [attemptOf(uuidv7(), "turn_limit_reached"), attemptOf(uuidv7(), "turn_limit_reached"), attemptOf(runId, "running")],
    ...(decision ? { userDecision: decision } : {}), ...patch });
  return x;
}

/** 任务正在跑第一轮审查 runId，用户的「再给一次机会」覆盖通用 reviewer。 */
async function reviewingTask(decision: Decision, reviewRunId: string) {
  const x = await world();
  const attemptRunId = uuidv7();
  x.seed("login", { status: "reviewing", attempts: [attemptOf(attemptRunId, "completed")],
    reviews: [{ runId: reviewRunId, attemptRunId, agent: "reviewer", round: 1, maxTurns: 2, turnsUsed: 0, outcome: "running" }], userDecision: decision });
  return x;
}

describe("开工前作废：用户的「再给一次机会」退回", () => {
  test("再给一次机会被派出后，准备期间批准新版本使运行作废：usedByRunId 回到 null，带 retry 重派被拒 retry_not_needed，不带 retry 重派按用户上限 3 轮、原因「用户决定」，并再写成新运行的 runId", async () => {
    const w = await createPmRunWorld(cleanups);
    await w.plan.execute({ action: "propose", tasks: [spec("login", "goal.login"), spec("failure", "scenario.failure")] });
    await w.plan.execute({ action: "confirm", planVersion: 1 });
    const task = (key: string) => w.db((db) => db.list<TaskRecord>(TASKS).map((row) => row.data).find((entry) => entry.key === key)!);
    const login = task("login").taskId, itemId = `task:${login}`;
    for (const retry of [null, { reason: "估计不足", maxTurns: 1 }]) {
      w.provider.queue.push({ type: "toolcall", name: "read", input: { path: "README.md" } }, { type: "text", text: "PM 看到到限" });
      await w.manager.dispatchTask({ pmRunId: w.pm.runId, taskId: login, retry });
      await until(() => task("login").status === (retry ? "awaiting_user" : "awaiting_parent") && w.provider.queue.length === 0);
    }
    const version = () => `task:${login}:${w.db((db) => db.read<TaskRecord>(TASKS, login)!.version)}`;
    const main = mainAdjudication(w, cleanups);
    const result = await main.adjudicate("再给它一次机会，这次给 3 轮", [main.entry([`item:${itemId}`, `version:${version()}`, "choice:retry", "max-turns:3"],
      { conclusion: "用户对任务 login 的裁决", scope: "任务 login" })], itemId, version());
    w.provider.queue.push({ type: "text", text: "PM 收到用户决定" });
    expect(result).toMatchObject({ status: "recorded", choice: "retry", maxTurns: 3, taskStatus: "pending" });
    await until(() => w.provider.queue.length === 0);

    let release!: () => void;
    gate.entered = 0; gate.role = "worker";
    gate.waiting = new Promise<void>((resolve) => { release = resolve; });
    const dispatched = w.manager.dispatchTask({ pmRunId: w.pm.runId, taskId: login, retry: null }).catch(() => undefined);
    await until(() => gate.entered === 1 && task("login").attempts.length === 3);
    const heldRunId = task("login").attempts[2]!.runId;
    expect(task("login").userDecision?.usedByRunId).toBe(heldRunId);

    w.provider.queue.push({ type: "text", text: "PM 收到新版本差异" }, { type: "text", text: "PM 空闲" });
    await w.fixture.approveRevision({ body: `${BASE}# 重发验证码 {#goal.resend}\n可重发。\n` });
    await until(() => w.owner().context.baseline?.revision === 2);
    await w.readDiffs(["revision 1 → 2"]);
    await sleep(1_000);
    w.provider.queue.push({ type: "text", text: "慢慢写登录", chunkDelayMs: 30_000 });
    release();
    await dispatched;
    await until(() => task("login").attempts[2]!.outcome !== "running");
    expect(task("login").attempts[2]).toMatchObject({ runId: heldRunId, outcome: "superseded" });
    expect(task("login").userDecision).toMatchObject({ choice: "retry", maxTurns: 3, usedByRunId: null });

    await w.plan.execute({ action: "assess-update", revision: 2, assessmentId: uuidv7(), tasks: [
      { taskId: login, version: task("login").version, assessment: "unaffected", rationale: "登录" },
      { taskId: task("failure").taskId, version: task("failure").version, assessment: "unaffected", rationale: "失败场景" }],
      global: { assessment: "unaffected", rationale: "无全局变化" } });
    const planVersion = () => w.db((db) => db.read<{ planVersion: number }>("plans", w.fixture.requirementId)!.data.planVersion);
    await w.plan.execute({ action: "update", planVersion: planVersion(), add: [spec("resend", "goal.resend")] });
    await w.plan.execute({ action: "confirm", planVersion: planVersion() });

    await expect(w.manager.dispatchTask({ pmRunId: w.pm.runId, taskId: login, retry: { reason: "PM 想多给", maxTurns: 9 } })).rejects.toMatchObject({ code: "retry_not_needed" });
    w.provider.queue.length = 0;
    w.provider.queue.push({ type: "text", text: "重做登录", chunkDelayMs: 30_000 });
    const again = await w.manager.dispatchTask({ pmRunId: w.pm.runId, taskId: login, retry: null });
    expect(again.maxTurns).toBe(3);
    expect(task("login").attempts.at(-1)).toMatchObject({ runId: again.runId, maxTurns: 3, reason: "用户决定", outcome: "running" });
    expect(task("login").userDecision?.usedByRunId).toBe(again.runId);
  });
});

describe("开工前作废：用户终止了另一个任务", () => {
  test("再给一次机会被派出后，准备期间用户终止了 failure：login 这次运行作废，决定退回（仍是 retry、3 轮），确认计划后不带 retry 重派按 3 轮、原因「用户决定」", async () => {
    const { w, task, seed } = await world();
    const login = task("login").taskId, failure = task("failure").taskId;
    for (const retry of [null, { reason: "估计不足", maxTurns: 1 }]) {
      w.provider.queue.push({ type: "toolcall", name: "read", input: { path: "README.md" } }, { type: "text", text: "PM 看到到限" });
      await w.manager.dispatchTask({ pmRunId: w.pm.runId, taskId: login, retry });
      await until(() => task("login").status === (retry ? "awaiting_user" : "awaiting_parent") && w.provider.queue.length === 0);
    }
    seed("failure", { status: "awaiting_user", holdNote: "PM 上报，需要你决定" });
    const rowVersion = (id: string) => w.db((db) => db.read<TaskRecord>(TASKS, id)!.version);
    const main = mainAdjudication(w, cleanups);
    const decide = (id: string, text: string, choices: string[]) => {
      const itemId = `task:${id}`, version = `task:${id}:${rowVersion(id)}`;
      return main.adjudicate(text, [main.entry([`item:${itemId}`, `version:${version}`, ...choices], { conclusion: "用户对任务的裁决", scope: "任务" })], itemId, version);
    };
    expect(await decide(login, "再给它一次机会，这次给 3 轮", ["choice:retry", "max-turns:3"])).toMatchObject({ status: "recorded", choice: "retry" });
    w.provider.queue.push({ type: "text", text: "PM 收到用户决定" });
    await until(() => w.provider.queue.length === 0);

    let release!: () => void;
    gate.entered = 0; gate.role = "worker";
    gate.waiting = new Promise<void>((resolve) => { release = resolve; });
    const dispatched = w.manager.dispatchTask({ pmRunId: w.pm.runId, taskId: login, retry: null }).catch(() => undefined);
    await until(() => gate.entered === 1 && task("login").attempts.length === 3);
    const runId = task("login").attempts[2]!.runId;
    expect(task("login").userDecision?.usedByRunId).toBe(runId);

    expect(await decide(failure, "这个任务别做了，终止", ["choice:terminate"])).toMatchObject({ status: "recorded", choice: "terminate", taskStatus: "cancelled" });
    w.provider.queue.push({ type: "text", text: "慢慢写登录", chunkDelayMs: 30_000 });
    release();
    await dispatched;
    await until(() => task("login").attempts[2]!.outcome !== "running");
    expect(task("login").attempts[2]).toMatchObject({ runId, outcome: "superseded" });
    expect(task("login").userDecision).toMatchObject({ choice: "retry", maxTurns: 3, usedByRunId: null });

    const planVersion = () => w.db((db) => db.read<{ planVersion: number }>("plans", w.fixture.requirementId)!.data.planVersion);
    w.provider.queue.push({ type: "text", text: "PM 收到新版本差异" }, { type: "text", text: "PM 空闲" });
    await w.fixture.approveRevision({ body: `${BASE}# 重发验证码 {#goal.resend}\n可重发。\n` });
    await until(() => w.owner().context.baseline?.revision === 2);
    await w.readDiffs(["revision 1 → 2"]);
    await w.plan.execute({ action: "assess-update", revision: 2, assessmentId: uuidv7(), tasks: [
      { taskId: login, version: task("login").version, assessment: "unaffected", rationale: "登录" }],
      global: { assessment: "unaffected", rationale: "无全局变化" } });
    await w.plan.execute({ action: "update", planVersion: planVersion(), add: [spec("failure-again", "scenario.failure"), spec("resend", "goal.resend")] });
    await w.plan.execute({ action: "confirm", planVersion: planVersion() });
    w.provider.queue.length = 0;
    w.provider.queue.push({ type: "text", text: "重做登录", chunkDelayMs: 30_000 });
    const again = await w.manager.dispatchTask({ pmRunId: w.pm.runId, taskId: login, retry: null });
    expect(again.maxTurns).toBe(3);
    expect(task("login").attempts.at(-1)).toMatchObject({ runId: again.runId, maxTurns: 3, reason: "用户决定" });
    expect(task("login").userDecision?.usedByRunId).toBe(again.runId);
  });
});

describe("调整决定被派出后运行作废", () => {
  test("调整决定已被运行占用、任务版本比决定新，运行作废：usedByRunId 回到 null，之后不带 retry 再派出并再次占用", async () => {
    const runId = uuidv7();
    const { w, task, where } = await runningAttempt(decisionOf({ choice: "adjust", maxTurns: null, taskVersion: 1, usedByRunId: runId }), runId, { version: 2 });
    w.db((db) => {
      const plan = db.read<{ confirmedTasks: Array<{ taskId: string; version: number }> }>("plans", w.fixture.requirementId)!;
      db.update("plans", w.fixture.requirementId, plan.version, { ...plan.data,
        confirmedTasks: plan.data.confirmedTasks.map((entry) => entry.taskId === task("login").taskId ? { ...entry, version: 2 } : entry) });
    });
    finishTaskAttempt({ ...where, taskId: task("login").taskId, runId, turnsUsed: 0, outcome: "superseded" });
    expect(task("login")).toMatchObject({ status: "pending", userDecision: { choice: "adjust", usedByRunId: null } });

    w.provider.queue.push({ type: "text", text: "按调整做", chunkDelayMs: 30_000 });
    const again = await w.manager.dispatchTask({ pmRunId: w.pm.runId, taskId: task("login").taskId, retry: null });
    expect(task("login").userDecision?.usedByRunId).toBe(again.runId);
  });
});

describe("审查运行占用的用户决定被作废", () => {
  test("审查占用了「再给一次机会」后被作废：usedByRunId 回到 null，下次派审查时写成新审查运行的 runId", async () => {
    const reviewRunId = uuidv7();
    const { w, task, where } = await reviewingTask(decisionOf({ taskVersion: 1, round: 1, agents: ["reviewer"], usedByRunId: reviewRunId }), reviewRunId);
    finishTaskReview({ ...where, taskId: task("login").taskId, runId: reviewRunId, turnsUsed: 0, outcome: "superseded" });
    expect(task("login")).toMatchObject({ status: "awaiting_review", userDecision: { usedByRunId: null } });

    w.provider.queue.push({ type: "toolcall", name: "one_company_result_submit",
      input: { action: "verdict", result: { checkRoundId: null, verificationIds: [], summary: "完成 login", findings: [] } } }, { type: "text", text: "PM 收到" });
    await w.manager.dispatchTask({ pmRunId: w.pm.runId, taskId: task("login").taskId, retry: null, review: { maxTurns: 2 } });
    const newReview = task("login").reviews.at(-1)!;
    expect(newReview.runId).not.toBe(reviewRunId);
    expect(task("login").userDecision?.usedByRunId).toBe(newReview.runId);
  });
});

describe("作废的运行不是占用决定的那次：决定不变", () => {
  test.each([["别的运行的 runId", uuidv7()], ["null", null]])("尝试作废，usedByRunId 是%s：userDecision 不变", async (_name, used) => {
    const runId = uuidv7();
    const decision = decisionOf({ usedByRunId: used });
    const { task, where } = await runningAttempt(decision, runId);
    finishTaskAttempt({ ...where, taskId: task("login").taskId, runId, turnsUsed: 0, outcome: "superseded" });
    expect(task("login").userDecision).toEqual(decision);
  });

  test.each([["别的运行的 runId", uuidv7()], ["null", null]])("审查作废，usedByRunId 是%s：userDecision 不变", async (_name, used) => {
    const reviewRunId = uuidv7();
    const decision = decisionOf({ round: 1, agents: ["reviewer"], usedByRunId: used });
    const { task, where } = await reviewingTask(decision, reviewRunId);
    finishTaskReview({ ...where, taskId: task("login").taskId, runId: reviewRunId, turnsUsed: 0, outcome: "superseded" });
    expect(task("login").userDecision).toEqual(decision);
  });
});

describe("非作废结局：占用不退回", () => {
  test.each(["completed", "failed", "turn_limit_reached", "stopped"] as const)("尝试结局 %s：usedByRunId 仍是那次运行", async (outcome) => {
    const runId = uuidv7();
    const { task, where } = await runningAttempt(decisionOf({ usedByRunId: runId }), runId);
    finishTaskAttempt({ ...where, taskId: task("login").taskId, runId, turnsUsed: 1, outcome });
    expect(task("login").userDecision?.usedByRunId).toBe(runId);
  });

  test.each(["failed", "turn_limit_reached", "stopped"] as const)("审查结局 %s：usedByRunId 仍是那次运行", async (outcome) => {
    const reviewRunId = uuidv7();
    const { task, where } = await reviewingTask(decisionOf({ round: 1, agents: ["reviewer"], usedByRunId: reviewRunId }), reviewRunId);
    finishTaskReview({ ...where, taskId: task("login").taskId, runId: reviewRunId, turnsUsed: 1, outcome });
    expect(task("login").userDecision?.usedByRunId).toBe(reviewRunId);
  });
});

describe("版本不符不退回", () => {
  test("决定登记时任务是版本 1，派出后 PM 把任务改到版本 2，这次运行作废：usedByRunId 保持原 runId", async () => {
    const runId = uuidv7();
    const { task, where } = await runningAttempt(decisionOf({ taskVersion: 1, usedByRunId: runId }), runId, { version: 2 });
    finishTaskAttempt({ ...where, taskId: task("login").taskId, runId, turnsUsed: 0, outcome: "superseded" });
    expect(task("login").userDecision?.usedByRunId).toBe(runId);
  });
});
