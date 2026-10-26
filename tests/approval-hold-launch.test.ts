import { afterEach, expect, test, vi } from "vitest";
import { uuidv7 } from "../src/core/storage/database.ts";
import { TASKS } from "../src/modules/pm/plan-manage.ts";
import type { TaskRecord, TaskSpec } from "../src/modules/pm/plan-manage.ts";
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
const FAILURE_CHANGED = BASE.replace("错误验证码显示失败。", "错误验证码显示失败并提示重试。");
const spec = (key: string, goal: string, patch: Partial<TaskSpec> = {}): TaskSpec => ({ key, role: "worker", goalUnitIds: [goal], constraintUnitIds: [], dependsOn: [],
  writePaths: [`${key}/`], blockedByQuestionIds: [], maxTurns: 5, objective: `实现 ${key}`, passCriteria: ["可观察通过"], scope: { in: [key], out: [] }, performance: NA, ...patch });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 拦住指定角色的会话创建，直到调用返回的 release；期间派出已被接受、第一条提示还没发出。 */
function holdLaunch(role: string) {
  let release!: () => void;
  gate.entered = 0; gate.role = role;
  gate.waiting = new Promise<void>((resolve) => { release = resolve; });
  return () => { release(); gate.waiting = null; };
}

async function world(loginPatch: Partial<TaskSpec> = {}) {
  const w = await createPmRunWorld(cleanups);
  await w.plan.execute({ action: "propose", tasks: [spec("login", "goal.login", loginPatch), spec("failure", "scenario.failure")] });
  await w.plan.execute({ action: "confirm", planVersion: 1 });
  const task = (key: string) => w.db((db) => db.list<TaskRecord>(TASKS).map((row) => row.data).find((entry) => entry.key === key)!);
  const state = async (id: string) => { const run = await w.runStore.get(id); return run.ok ? run.run.state : "missing"; };
  const planVersion = () => w.db((db) => db.read<{ planVersion: number }>("plans", w.fixture.requirementId)!.data.planVersion);
  const startPrompts = (marker: string) => w.provider.requests.filter((request) => JSON.stringify(request.messages).includes(marker)).length;
  return { w, task, state, planVersion, startPrompts };
}
type World = Awaited<ReturnType<typeof world>>;

/** 拖住期间批准新版本，等 PM 读完差异（多等一个轮询）。 */
async function approveWhileHeld({ w }: World, body: string) {
  w.provider.queue.push({ type: "text", text: "PM 收到新版本差异" }, { type: "text", text: "PM 空闲" });
  await w.fixture.approveRevision({ body });
  await until(() => w.owner().context.baseline?.revision === 2);
  await w.readDiffs(["revision 1 → 2"]);
  await sleep(1_000);
}

async function replanFailure(x: World) {
  const { w, task, planVersion } = x;
  await w.plan.execute({ action: "assess-update", revision: 2, assessmentId: uuidv7(), tasks: [
    { taskId: task("login").taskId, version: task("login").version, assessment: "unaffected", rationale: "登录" },
    { taskId: task("failure").taskId, version: task("failure").version, assessment: "affected", rationale: "失败场景" }],
    global: { assessment: "unaffected", rationale: "无全局变化" } });
  await w.plan.execute({ action: "update", planVersion: planVersion(), modify: [{ taskId: task("failure").taskId, version: task("failure").version,
    spec: spec("failure", "scenario.failure", { objective: "失败场景加提示重试" }) }] });
  await w.plan.execute({ action: "confirm", planVersion: planVersion() });
}

test("E1：worker 准备期间批准新版本，释放后不发第一条提示，运行即停止（replanned）、尝试记为被取代，确认新计划后不带 retry 可重新派出", async () => {
  const x = await world();
  const { w, task, state, startPrompts } = x;
  const release = holdLaunch("worker");
  const dispatched = w.manager.dispatchTask({ pmRunId: w.pm.runId, taskId: task("failure").taskId, retry: null }).catch(() => undefined);
  await until(() => gate.entered === 1 && task("failure").attempts.length === 1);
  const runId = task("failure").attempts[0]!.runId;
  await approveWhileHeld(x, FAILURE_CHANGED);

  w.provider.queue.push({ type: "text", text: "慢慢写失败场景", chunkDelayMs: 30_000 });
  release();
  await dispatched;
  await sleep(1_500);
  expect(startPrompts("开始执行任务。")).toBe(0);
  await until(async () => await state(runId) === "stopped");
  await until(() => task("failure").attempts[0]!.outcome !== "running");
  expect(task("failure").attempts).toMatchObject([{ runId, outcome: "superseded" }]);
  expect(await w.runStore.get(runId)).toMatchObject({ ok: true, run: { stopCause: { reason: "replanned" } } });

  await replanFailure(x);
  expect(startPrompts("开始执行任务。")).toBe(0);

  w.provider.queue.length = 0;
  w.provider.queue.push({ type: "text", text: "重做失败场景", chunkDelayMs: 30_000 });
  await expect(w.manager.dispatchTask({ pmRunId: w.pm.runId, taskId: task("failure").taskId, retry: null })).resolves.toBeDefined();
});

test("E2：worker 准备期间用户终止了需求中的另一个任务，释放后不发第一条提示，运行停止、尝试记为被取代", async () => {
  const { w, task, state, startPrompts } = await world({ maxTurns: 1 });
  const login = task("login").taskId;
  for (const retry of [null, { reason: "估计不足", maxTurns: 1 }]) {
    w.provider.queue.push({ type: "toolcall", name: "read", input: { path: "README.md" } }, { type: "text", text: "PM 看到到限" });
    await w.manager.dispatchTask({ pmRunId: w.pm.runId, taskId: login, retry });
    await until(() => task("login").status === (retry ? "awaiting_user" : "awaiting_parent") && w.provider.queue.length === 0);
  }
  const itemId = `task:${login}`;
  const version = () => `task:${login}:${w.db((db) => db.read<TaskRecord>(TASKS, login)!.version)}`;
  const main = mainAdjudication(w, cleanups);

  const release = holdLaunch("worker");
  const dispatched = w.manager.dispatchTask({ pmRunId: w.pm.runId, taskId: task("failure").taskId, retry: null }).catch(() => undefined);
  await until(() => gate.entered === 1 && task("failure").attempts.length === 1);
  const runId = task("failure").attempts[0]!.runId;

  const result = await main.adjudicate("这个任务别做了，终止", [main.entry([`item:${itemId}`, `version:${version()}`, "choice:terminate"],
    { conclusion: "用户对任务 login 的裁决", scope: "任务 login" })], itemId, version());
  w.provider.queue.push({ type: "text", text: "PM 收到用户决定" });
  expect(result).toMatchObject({ status: "recorded", choice: "terminate", taskStatus: "cancelled" });
  await until(async () => await state(w.pm.runId) === "paused", 3_000);

  const before = startPrompts("开始执行任务。");
  w.provider.queue.length = 0;
  w.provider.queue.push({ type: "text", text: "慢慢写失败场景", chunkDelayMs: 30_000 });
  release();
  await dispatched;
  await sleep(1_500);
  expect(startPrompts("开始执行任务。")).toBe(before);
  await until(async () => await state(runId) === "stopped");
  await until(() => task("failure").attempts[0]!.outcome !== "running");
  expect(task("failure").attempts).toMatchObject([{ runId, outcome: "superseded" }]);
});

test("E3：worker 准备期间既没批准新版本也没终止任务，释放后收到第一条提示、运行状态为 running", async () => {
  const { w, task, state, startPrompts } = await world();
  w.provider.queue.push({ type: "text", text: "慢慢写失败场景", chunkDelayMs: 30_000 });
  const release = holdLaunch("worker");
  const dispatched = w.manager.dispatchTask({ pmRunId: w.pm.runId, taskId: task("failure").taskId, retry: null });
  await until(() => gate.entered === 1 && task("failure").attempts.length === 1);
  await sleep(1_500);
  release();
  const { runId } = await dispatched as { runId: string };
  await until(() => startPrompts("开始执行任务。") === 1);
  expect(await state(runId)).toBe("running");
  expect(task("failure").attempts[0]!.outcome).toBe("running");
});

test("E4：任务级审查准备期间批准新版本，释放后审查不发第一条提示，运行停止，审查记录为被取代", async () => {
  const x = await world();
  const { w, task, state, startPrompts } = x;
  const verdict = { type: "toolcall" as const, name: "one_company_result_submit",
    input: { action: "verdict", result: { checkRoundId: null, verificationIds: [], summary: "完成 failure", findings: [] } } };
  w.provider.queue.push(verdict, { type: "text", text: "PM 收到" });
  await w.manager.dispatchTask({ pmRunId: w.pm.runId, taskId: task("failure").taskId, retry: null });
  await until(() => task("failure").status === "awaiting_review" && w.provider.queue.length === 0);

  const release = holdLaunch("reviewer");
  const dispatched = w.manager.dispatchTask({ pmRunId: w.pm.runId, taskId: task("failure").taskId, retry: null, review: { maxTurns: 2 } }).catch(() => undefined);
  await until(() => gate.entered === 1 && task("failure").reviews.length === 1);
  const reviewRunId = task("failure").reviews[0]!.runId;
  await approveWhileHeld(x, FAILURE_CHANGED);

  w.provider.queue.push({ type: "text", text: "审查中", chunkDelayMs: 30_000 });
  release();
  await dispatched;
  await sleep(1_500);
  expect(startPrompts("开始审查。")).toBe(0);

  await replanFailure(x);
  await until(async () => await state(reviewRunId) === "stopped");
  await until(() => task("failure").reviews.find((review) => review.runId === reviewRunId)!.outcome !== "running");
  expect(task("failure").reviews.find((review) => review.runId === reviewRunId)).toMatchObject({ outcome: "superseded" });
  expect(await w.runStore.get(reviewRunId)).toMatchObject({ ok: true, run: { stopCause: { reason: "replanned" } } });
});
