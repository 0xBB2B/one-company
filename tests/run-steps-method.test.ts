import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { registerProtocolHandlers } from "../src/app/daemon/run-manager.ts";
import { stepText } from "../src/modules/agents/run-steps.ts";
import type { RunStepsView } from "../src/modules/agents/run-steps.ts";
import { repositoryDatabase, withDatabase } from "../src/core/storage/database.ts";
import { TASKS } from "../src/modules/pm/plan-manage.ts";
import type { TaskSpec } from "../src/modules/pm/plan-manage.ts";
import type { ScriptedReply } from "./helpers/controlled-provider.ts";
import { createPmRunWorld, until } from "./helpers/run-manager-fixture.ts";

vi.setConfig({ testTimeout: 60_000 });
const cleanups: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });
const NA = { applicable: false as const, reason: "无性能影响" };
const spec = (key: string, patch: Partial<TaskSpec> = {}): TaskSpec => ({ key, role: "worker", goalUnitIds: ["goal.login"], constraintUnitIds: [], dependsOn: [], writePaths: ["src/"],
  blockedByQuestionIds: [], maxTurns: 5, objective: `实现 ${key}`, passCriteria: ["可观察通过"], scope: { in: [key], out: ["微信登录"] }, performance: NA, ...patch });
const read = (n: number): ScriptedReply => ({ type: "toolcall", name: "read", input: { path: `README.md#${n}` } });
const SUBMIT: ScriptedReply = { type: "toolcall", name: "one_company_result_submit", input: { action: "verdict", result: { checkRoundId: null, verificationIds: [], summary: "完成", findings: [] } } };
const NOT_FOUND = "守护进程里没有这个子代理的步骤";

async function world() {
  const w = await createPmRunWorld(cleanups);
  await w.plan.execute({ action: "propose", tasks: [spec("login"), spec("failure", { goalUnitIds: ["scenario.failure"] })] });
  await w.plan.execute({ action: "confirm", planVersion: 1 });
  const taskId = (key: string) => withDatabase(repositoryDatabase(w.fixture.dataRoot, w.fixture.repoId), (db) =>
    db.list<{ key: string; taskId: string }>(TASKS).map((row) => row.data).find((entry) => entry.key === key)!.taskId);
  const dispatch = (key: string) => w.manager.dispatchTask({ pmRunId: w.pm.runId, taskId: taskId(key), retry: null });
  const handlers = new Map<string, (params: Record<string, unknown>, client: unknown) => Promise<unknown>>();
  registerProtocolHandlers({ server: { registerHandler: (method: string, handler: never) => handlers.set(method, handler), markHandlersReady: () => {} } as never,
    manager: w.manager, shellRegistry: {} as never });
  const steps = (runId: string, connectionId = "connection-a") => handlers.get("runs.steps")!({ runId }, { connectionId, sessionId: "session-a" }) as Promise<RunStepsView>;
  const runOf = async (runId: string) => { const result = await w.runStore.get(runId); if (!result.ok) throw new Error(result.reason); return result.run; };
  return { ...w, dispatch, steps, runOf };
}

test("worker 调了两次工具后 runs.steps 返回 running、两步文字与运行记录的 turns、maxTurns 一致", async () => {
  const w = await world();
  w.provider.queue.push(read(1), read(2), { type: "text", text: "继续", chunkDelayMs: 20_000 });
  const run = await w.dispatch("login");
  await until(async () => (await w.steps(run.runId)).steps.length === 2);
  const view = await w.steps(run.runId);
  expect(view).toMatchObject({ state: "running", maxTurns: 5, steps: [{ text: stepText("read", { path: "README.md#1" }) }, { text: stepText("read", { path: "README.md#2" }) }] });
  await until(async () => (await w.runOf(run.runId)).turns === (await w.steps(run.runId)).turns);
  expect((await w.steps(run.runId)).turns).toBeGreaterThanOrEqual(2);
  expect((await w.runOf(run.runId)).maxTurns).toBe(5);
  expect(view.elapsedMs).toEqual(expect.any(Number));
});

test("worker 完成后 runs.steps 返回 completed，隔一段时间再查 elapsedMs 不变", async () => {
  const w = await world();
  w.provider.queue.push(read(1), SUBMIT, { type: "text", text: "PM 收到" });
  const run = await w.dispatch("login");
  await until(async () => (await w.steps(run.runId)).state === "completed");
  const first = await w.steps(run.runId);
  expect(first.steps.length).toBeGreaterThanOrEqual(2);
  await new Promise((resolve) => setTimeout(resolve, 300));
  const second = await w.steps(run.runId);
  expect(second.elapsedMs).toBe(first.elapsedMs);
  expect(second.turns).toBe(first.turns);
});

test("worker 没提交结果就结束：runs.steps 返回 failed，reason 等于运行记录的 stateReason", async () => {
  const w = await world();
  w.provider.queue.push(read(1), { type: "text", text: "做完了" }, { type: "text", text: "PM 收到" });
  const run = await w.dispatch("login");
  await until(async () => (await w.steps(run.runId)).state === "failed");
  const view = await w.steps(run.runId);
  const stored = await w.runOf(run.runId);
  expect(stored.stateReason).toBe("模型停止回复，但没有提交结果");
  expect(view.reason).toBe(stored.stateReason);
});

test("worker 用满轮数：runs.steps 返回 failed，reason 等于运行记录的 stateReason，turns 等于上限", async () => {
  const w = await world();
  w.provider.queue.push(read(1), read(2), read(3), read(4), read(5), { type: "text", text: "PM 收到到限报告" });
  const run = await w.dispatch("login");
  await until(async () => (await w.steps(run.runId)).state === "failed");
  const view = await w.steps(run.runId);
  expect(view.reason).toBe((await w.runOf(run.runId)).stateReason);
  expect(view).toMatchObject({ turns: 5, maxTurns: 5 });
});

test("worker 暂停后 runs.steps 返回 pausing 或 paused", async () => {
  const w = await world();
  w.provider.queue.push({ type: "text", text: "慢慢做", chunkDelayMs: 20_000 });
  const run = await w.dispatch("login");
  await w.manager.pause(run.runId);
  await until(async () => ["pausing", "paused"].includes((await w.steps(run.runId)).state));
  expect(["pausing", "paused"]).toContain((await w.steps(run.runId)).state);
});

async function exploreWorld() {
  const w = await world();
  const readme = join(await realpath(w.fixture.repositoryRoot), "README.md");
  const hash = createHash("sha256").update(await readFile(readme)).digest("hex");
  const submit: ScriptedReply = { type: "toolcall", name: "one_company_result_submit", input: { action: "research", result: { conclusions: ["仓库说明"], sources: [{ kind: "local_file",
    indexBaseline: "not_applicable", path: readme, fileHash: hash, startLine: 1, endLine: 1 }], searchedScope: { kind: "local_file", paths: [readme] }, notFound: [], failures: [],
    truncation: { truncated: false, reasons: [] }, unknown: [] } } };
  const parent = { role: "main" as const, sessionId: "session-a", connectionId: "connection-a", model: { provider: "team-model", id: "test" }, thinking: "off" };
  w.manager.connectionOpened("connection-a");
  const finished = (runId: string) => w.emit.mock.calls.some(([event, data]) => event === "explore.finished" && (data as { runId: string }).runId === runId);
  const dispatch = (maxTurns: number) => w.manager.dispatchExplore({ parent, request: { question: "仓库说明写了什么", clues: [], source: { kind: "local_file" } }, maxTurns });
  return { ...w, submit, dispatch, finished, readme };
}

test("主窗口检索：派出它的连接查到 running 与已有步骤，别的连接查得到 not_found", async () => {
  const w = await exploreWorld();
  w.provider.queue.push(read(1), { type: "text", text: "慢慢查", chunkDelayMs: 20_000 });
  const run = await w.dispatch(5);
  await until(async () => (await w.steps(run.runId)).steps.length === 1);
  expect(await w.steps(run.runId)).toMatchObject({ state: "running", maxTurns: 5, steps: [{ text: stepText("read", { path: "README.md#1" }) }] });
  await expect(w.steps(run.runId, "connection-b")).rejects.toMatchObject({ code: "not_found", message: NOT_FOUND });
});

test("主窗口检索用满轮数：返回 failed，reason 为“用完轮次上限仍没有提交结果”，maxTurns 为派出时的上限", async () => {
  const w = await exploreWorld();
  w.provider.queue.push(read(1));
  const run = await w.dispatch(1);
  await until(() => w.finished(run.runId));
  expect(await w.steps(run.runId)).toMatchObject({ state: "failed", reason: "用完轮次上限仍没有提交结果", maxTurns: 1, turns: 1 });
});

test("主窗口检索完成后 elapsedMs 不再增加；结果被取走后派出它的连接再查仍返回 completed 和全部步骤", async () => {
  const w = await exploreWorld();
  w.provider.queue.push(read(1), w.submit);
  const run = await w.dispatch(5);
  await until(() => w.finished(run.runId));
  const before = await w.steps(run.runId);
  expect(before.state).toBe("completed");
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect((await w.steps(run.runId)).elapsedMs).toBe(before.elapsedMs);
  w.manager.takeMainExploreReport(run.runId, "connection-a");
  const after = await w.steps(run.runId);
  expect(after).toMatchObject({ state: "completed", steps: before.steps });
  expect(after.steps.length).toBe(2);
  await expect(w.steps(run.runId, "connection-b")).rejects.toMatchObject({ code: "not_found" });
});

test("不存在的运行编号与 PM 自己的运行编号：返回 not_found，message 为“守护进程里没有这个子代理的步骤”", async () => {
  const w = await world();
  await expect(w.steps("01900000-0000-7000-8000-0000000000ff")).rejects.toMatchObject({ code: "not_found", message: NOT_FOUND });
  await expect(w.steps(w.pm.runId)).rejects.toMatchObject({ code: "not_found", message: NOT_FOUND });
});
