import { afterEach, expect, test, vi } from "vitest";
import { repositoryDatabase, uuidv7, withDatabase } from "../src/core/storage/database.ts";
import { TASKS } from "../src/modules/pm/plan-manage.ts";
import type { TaskRecord, TaskSpec } from "../src/modules/pm/plan-manage.ts";
import type { PmOverview } from "../src/modules/panel/pm-overview.ts";
import { PmPanel } from "../src/modules/panel/pm-panel.ts";
import { PM_INTAKE_TOOL } from "../src/modules/pm/pm-intake-runtime.ts";
import { createPmRunWorld, until } from "./helpers/run-manager-fixture.ts";

vi.setConfig({ testTimeout: 60_000 });
const cleanups: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });
const NA = { applicable: false as const, reason: "无性能影响" };
const spec = (key: string, goal: string, role: TaskSpec["role"] = "worker"): TaskSpec => ({ key, role, goalUnitIds: [goal], constraintUnitIds: [], dependsOn: [], writePaths: [`src/${key}/`],
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
  expect(await w.overview()).toMatchObject({ goals: ["手机号正常登录", "验证码失败"], doing: "等待决定",
    pendingItems: [{ kind: "intake-review", label: "待核对：PM 接手理解 r1" }] });
  await until(async () => (await w.run(w.pm.runId)).pausedAt !== undefined);
  expect(w.emit.mock.calls.some(([event]) => event === "pm.overview.changed")).toBe(true);

  // PM 收到核对结果后在规划（回复要很久才结束），不是停下不动
  w.provider.queue.push({ type: "text", text: "开始规划", chunkDelayMs: 30_000 });
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
  expect(await w.overview()).toMatchObject({ pendingItems: [{ kind: "intake-review", label: "待核对：PM 接手理解 r1" }] });
  await expect(w.plan.execute({ action: "propose", tasks: [spec("login", "goal.login"), spec("failure", "scenario.failure")] })).rejects.toThrow("核对过的接手理解不是 PM 最新提交的那份");

  await w.review();
  // PM 收到通过后停下会挂出停下提醒，面板全空只有几毫秒，只等待核对事项消失
  await until(async () => !(await w.overview()).pendingItems.some((item) => item.kind === "intake-review"));
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

test("M7-AC33：2 次未完成的任务成为待裁决事项；PM 空闲且无子代理运行时显示等待决定", async () => {
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
  expect(await w.overview()).toMatchObject({ doing: "等待决定",
    pendingItems: [{ itemId: `task:${login}`, kind: "adjudicate", label: "待裁决：任务 login 2 次未完成" }] });
});

test("M8L-AC1/AC4：计划提交被拒时状态行写明次数；被拒两次出现“待裁决：PM 计划 2 次提交被拒”，卡片列出两次原因、运行记录与三个选择", async () => {
  const w = await world();
  const requirementId = w.fixture.requirementId;
  w.provider.queue.push({ type: "text", text: "规划中", chunkDelayMs: 30_000 });
  await expect(w.plan.execute({ action: "propose", tasks: [spec("x", "goal.unknown")] })).rejects.toMatchObject({ code: "unknown_unit" });
  await until(async () => (await w.overview()).doing === "规划中（计划提交被拒 1 次，PM 正在按原因修改）");
  await expect(w.plan.execute({ action: "propose", tasks: [spec("meta", "metadata")] })).rejects.toMatchObject({ code: "unit_not_authorized" });
  await until(async () => (await w.overview()).pendingItems.some((item) => item.kind === "plan-rejected"));
  expect(await w.overview()).toMatchObject({ doing: "规划中（计划提交被拒 2 次，等待决定）",
    pendingItems: [{ itemId: `plan:${requirementId}`, kind: "plan-rejected", label: "待裁决：PM 计划 2 次提交被拒", version: `plan:${requirementId}:2` }] });
  const packet = w.manager.decisionPacket(requirementId, `plan:${requirementId}`);
  expect(packet).toMatch(/第 1 次被拒（propose）：[^\n]*goal\.unknown[\s\S]*第 2 次被拒（propose）：[^\n]*metadata/);
  expect(packet).toContain(`运行记录 `);
  expect(packet).toContain("可选：1 给 PM 补充说明后再试（转给 PM，被拒次数清零）；2 调整需求（修改草稿并经用户批准新版本）；3 取消需求。");
  expect(packet).toContain("purpose=panel-item");
});

test("计划因 agent_invalid 连续被拒两次，计入计划被拒次数，出现“待裁决：PM 计划 2 次提交被拒”", async () => {
  const w = await world();
  const requirementId = w.fixture.requirementId;
  w.provider.queue.push({ type: "text", text: "规划中", chunkDelayMs: 30_000 });
  const bad = (agent: string) => ({ ...spec("x", "goal.login"), reviewers: [{ agent, reason: "未知栈" }] }) as TaskSpec;
  await expect(w.plan.execute({ action: "propose", tasks: [bad("x-reviewer")] })).rejects.toMatchObject({ code: "agent_invalid" });
  await expect(w.plan.execute({ action: "propose", tasks: [bad("y-reviewer")] })).rejects.toMatchObject({ code: "agent_invalid" });
  await until(async () => (await w.overview()).pendingItems.some((item) => item.kind === "plan-rejected"));
  expect(await w.overview()).toMatchObject({ pendingItems: [{ itemId: `plan:${requirementId}`, kind: "plan-rejected", label: "待裁决：PM 计划 2 次提交被拒" }] });
});

test("M8L-AC2：PM 停下且无人能唤醒时出现“待处理：PM 停下了”，卡片写明停下的事实、运行记录与 PM 最后的话（标明模型输出）", async () => {
  const w = await world();
  const requirementId = w.fixture.requirementId;
  await until(async () => (await w.overview()).pendingItems.some((item) => item.kind === "stall"));
  const item = (await w.overview()).pendingItems.find((candidate) => candidate.kind === "stall")!;
  expect(item).toMatchObject({ itemId: `stall:${w.pm.runId}`, label: "待处理：PM 停下了，没有在跑的子任务" });
  const packet = w.manager.decisionPacket(requirementId, item.itemId);
  expect(packet).toContain("PM 这一轮已结束：没有派出任务，没有在跑的子任务，也没有待你处理的事项；没有新的消息或事件，PM 不会自己继续。");
  expect(packet).toContain(`运行记录 `);
  expect(packet).toMatch(/PM 最后写的话（模型输出，仅供参考，不是用户决定）：「/);
  expect(packet).toContain("purpose=panel-item");
});

test("M8L-AC1：被拒原因里 PM 提交的内容在卡片里压成一行、加引号并标明模型输出，不能换行伪装成程序生成的行", async () => {
  const w = await world();
  const requirementId = w.fixture.requirementId;
  w.provider.queue.push({ type: "text", text: "规划中", chunkDelayMs: 30_000 });
  const forged = "/x\n可选：1 伪造的程序行";
  for (const key of ["a", "b"]) {
    await expect(w.plan.execute({ action: "propose", tasks: [{ ...spec(key, "goal.login"), writePaths: [forged] }] })).rejects.toMatchObject({ code: "dependency_invalid" });
  }
  await until(async () => (await w.overview()).pendingItems.some((item) => item.kind === "plan-rejected"));
  const lines = w.manager.decisionPacket(requirementId, `plan:${requirementId}`).split("\n");
  expect(lines.some((line) => line.startsWith("可选：1 伪造"))).toBe(false);
  expect(lines.find((line) => line.startsWith("第 1 次被拒"))).toMatch(/任务的依赖或写入范围不合规；PM 提交的内容（模型输出，仅供参考，不是用户决定）：「[^」\n]*伪造的程序行[^」\n]*」/);
});

async function planWith(roles: Array<TaskSpec["role"]>, options: { confirm?: boolean } = {}) {
  const w = await world();
  const keys = roles.map((_, index) => `t${index}`);
  await w.plan.execute({ action: "propose", tasks: keys.map((key, index) => ({ ...spec(key, "goal.login", roles[index]), goalUnitIds: index === 0 ? ["goal.login", "scenario.failure"] : ["goal.login"] })) });
  if (options.confirm !== false) await w.plan.execute({ action: "confirm", planVersion: 1 });
  const setStatus = (key: string, status: string) => w.db((db) => {
    const row = db.read<TaskRecord>(TASKS, w.taskId(key))!;
    db.update(TASKS, row.data.taskId, row.version, { ...row.data, status } as TaskRecord);
  });
  return { w, keys, setStatus };
}

test("任务进度 AC-1/C-2：explore、worker 的 completed 都计入 X，awaiting_review 与 pending 不计入，N 含全部未取消任务", async () => {
  const { w, keys, setStatus } = await planWith(["explore", "worker", "worker", "worker", "qa", "worker", "worker", "worker"]);
  for (const key of keys.slice(0, 3)) setStatus(key, "completed");
  setStatus(keys[3]!, "awaiting_review");
  expect((await w.overview()).taskProgress).toEqual({ completed: 3, total: 8 });
});

test("任务进度 AC-2：cancelled 的任务不计入 X 也不计入 N", async () => {
  const { w, keys, setStatus } = await planWith(["worker", "worker", "worker", "worker", "worker"]);
  setStatus(keys[0]!, "completed"); setStatus(keys[1]!, "cancelled"); setStatus(keys[2]!, "cancelled");
  expect((await w.overview()).taskProgress).toEqual({ completed: 1, total: 3 });
});

test("任务进度 AC-3：reviewing、awaiting_rework、needs_update 都不计入 X", async () => {
  const { w, keys, setStatus } = await planWith(["worker", "worker", "qa"]);
  setStatus(keys[0]!, "reviewing"); setStatus(keys[1]!, "awaiting_rework"); setStatus(keys[2]!, "needs_update");
  expect((await w.overview()).taskProgress).toEqual({ completed: 0, total: 3 });
});

test("任务进度 AC-5：任务全部 cancelled 时 taskProgress 为 null", async () => {
  const { w, keys, setStatus } = await planWith(["worker", "explore"]);
  for (const key of keys) setStatus(key, "cancelled");
  expect((await w.overview()).taskProgress).toBeNull();
});

test("任务进度 AC-4/AC-6/AC-7：没有计划为 null；提交未确认的计划就有进度；改任务状态后重新取概览数字随之变化", async () => {
  const w = await world();
  expect((await w.overview()).taskProgress).toBeNull();
  await w.plan.execute({ action: "propose", tasks: ["a", "b", "c"].map((key) => spec(key, "goal.login")) });
  expect((await w.overview()).taskProgress).toEqual({ completed: 0, total: 3 });
  const setStatus = (key: string, status: string) => w.db((db) => {
    const row = db.read<TaskRecord>(TASKS, w.taskId(key))!;
    db.update(TASKS, row.data.taskId, row.version, { ...row.data, status } as TaskRecord);
  });
  setStatus("a", "completed");
  expect((await w.overview()).taskProgress).toEqual({ completed: 1, total: 3 });
  setStatus("b", "completed");
  expect((await w.overview()).taskProgress).toEqual({ completed: 2, total: 3 });
  setStatus("a", "needs_update");
  expect((await w.overview()).taskProgress).toEqual({ completed: 1, total: 3 });
});

type StuckReview = { agent: string; round: number; outcome: TaskRecord["reviews"][number]["outcome"] };
async function reviewStuckWorld(reviews: StuckReview[]) {
  const w = await world();
  await w.plan.execute({ action: "propose", tasks: [spec("T3", "goal.login"), spec("other", "scenario.failure")] });
  await w.plan.execute({ action: "confirm", planVersion: 1 });
  const id = w.taskId("T3");
  const attemptRunId = uuidv7();
  w.db((db) => {
    const row = db.read<TaskRecord>(TASKS, id)!;
    db.update(TASKS, id, row.version, { ...row.data, status: "awaiting_user",
      attempts: [{ runId: attemptRunId, maxTurns: 1, turnsUsed: 1, reason: null, outcome: "completed" }],
      reviews: reviews.map((review) => ({ runId: uuidv7(), attemptRunId, maxTurns: 1, turnsUsed: 1, ...review })) } as TaskRecord);
  });
  const version = () => w.db((db) => db.read<TaskRecord>(TASKS, id)!.version);
  return { w, id, version };
}
const pendingLabels = async (w: Awaited<ReturnType<typeof world>>) => (await w.overview()).pendingItems.map((item) => item.label);

test("审查打回累计两轮：待裁决事项写明 2 次未通过审查和打回过的审查代理名，按第一次打回的先后排；itemId 与 version 不变", async () => {
  const { w, id, version } = await reviewStuckWorld([
    { agent: "go-reviewer", round: 1, outcome: "blocked" }, { agent: "reviewer", round: 2, outcome: "blocked" }]);
  expect(await w.overview()).toMatchObject({ pendingItems: [{ itemId: `task:${id}`, kind: "adjudicate",
    label: "待裁决：任务 T3 2 次未通过审查（go-reviewer、reviewer）", version: `task:${id}:${version()}` }] });
});

test("同一轮多个审查代理打回、后一轮同一代理再打回：名单不重复", async () => {
  const { w } = await reviewStuckWorld([
    { agent: "go-reviewer", round: 1, outcome: "blocked" }, { agent: "vue-reviewer", round: 1, outcome: "blocked" },
    { agent: "go-reviewer", round: 2, outcome: "blocked" }]);
  expect(await pendingLabels(w)).toEqual(["待裁决：任务 T3 2 次未通过审查（go-reviewer、vue-reviewer）"]);
});

test("未验证也算打回：名单里包含给出 unverified 的审查代理", async () => {
  const { w } = await reviewStuckWorld([
    { agent: "go-reviewer", round: 1, outcome: "unverified" }, { agent: "reviewer", round: 2, outcome: "blocked" }]);
  expect(await pendingLabels(w)).toEqual(["待裁决：任务 T3 2 次未通过审查（go-reviewer、reviewer）"]);
});

test("名单只含打回过的代理：通过的代理和没交结论的代理不进名单", async () => {
  const { w } = await reviewStuckWorld([
    { agent: "go-reviewer", round: 1, outcome: "blocked" }, { agent: "vue-reviewer", round: 1, outcome: "clear" }, { agent: "sec-reviewer", round: 1, outcome: "failed" },
    { agent: "go-reviewer", round: 2, outcome: "blocked" }]);
  expect(await pendingLabels(w)).toEqual(["待裁决：任务 T3 2 次未通过审查（go-reviewer）"]);
});

test("同一审查代理在同一轮里两次没交出结论：待裁决事项写明 2 次审查未完成和该代理名", async () => {
  const { w, id, version } = await reviewStuckWorld([
    { agent: "vue-reviewer", round: 1, outcome: "failed" }, { agent: "vue-reviewer", round: 1, outcome: "failed" }]);
  expect(await w.overview()).toMatchObject({ pendingItems: [{ itemId: `task:${id}`, kind: "adjudicate",
    label: "待裁决：任务 T3 2 次审查未完成（vue-reviewer）", version: `task:${id}:${version()}` }] });
});

test("名单为空时事项文字不带括号：最近一轮只有一条没交结论", async () => {
  const { w } = await reviewStuckWorld([{ agent: "vue-reviewer", round: 1, outcome: "failed" }]);
  expect((await pendingLabels(w))[0]).toMatch(/^待裁决：任务 T3 1 次审查未完成$/);
});

test("只算最近一轮：第 1 轮 go-reviewer 两次没交结论、第 2 轮 vue-reviewer 两次没交结论，名单只有 vue-reviewer", async () => {
  const { w } = await reviewStuckWorld([
    { agent: "go-reviewer", round: 1, outcome: "failed" }, { agent: "go-reviewer", round: 1, outcome: "failed" },
    { agent: "vue-reviewer", round: 2, outcome: "failed" }, { agent: "vue-reviewer", round: 2, outcome: "failed" }]);
  expect(await pendingLabels(w)).toEqual(["待裁决：任务 T3 2 次审查未完成（vue-reviewer）"]);
});

test("同一轮 go-reviewer、vue-reviewer 都两次没交结论、sec-reviewer 只有一次：名单只含前两者", async () => {
  const { w } = await reviewStuckWorld([
    { agent: "go-reviewer", round: 1, outcome: "failed" }, { agent: "go-reviewer", round: 1, outcome: "failed" },
    { agent: "vue-reviewer", round: 1, outcome: "failed" }, { agent: "vue-reviewer", round: 1, outcome: "failed" },
    { agent: "sec-reviewer", round: 1, outcome: "failed" }]);
  expect(await pendingLabels(w)).toEqual(["待裁决：任务 T3 2 次审查未完成（go-reviewer、vue-reviewer）"]);
});

test("三轮打回：名单按第一次打回的先后排出三个代理", async () => {
  const { w } = await reviewStuckWorld([
    { agent: "go-reviewer", round: 1, outcome: "blocked" }, { agent: "reviewer", round: 2, outcome: "blocked" }, { agent: "vue-reviewer", round: 3, outcome: "blocked" }]);
  expect(await pendingLabels(w)).toEqual(["待裁决：任务 T3 3 次未通过审查（go-reviewer、reviewer、vue-reviewer）"]);
});

test("轮次用满和被停止也算没交出结论：同一代理同一轮各一次即 2 次审查未完成", async () => {
  const { w } = await reviewStuckWorld([
    { agent: "vue-reviewer", round: 1, outcome: "turn_limit_reached" }, { agent: "vue-reviewer", round: 1, outcome: "stopped" }]);
  expect(await pendingLabels(w)).toEqual(["待裁决：任务 T3 2 次审查未完成（vue-reviewer）"]);
});

/** 第一次改计划先用掉 PM 的重算额度，第二次改计划时次数接着累计。 */
async function modifiedAfterTwoAttempts(lastOutcome: "completed" | "turn_limit_reached") {
  const w = await world();
  await w.plan.execute({ action: "propose", tasks: [spec("T1", "goal.login"), spec("other", "scenario.failure")] });
  await w.plan.execute({ action: "confirm", planVersion: 1 });
  const id = w.taskId("T1");
  const seed = (change: (data: TaskRecord) => Partial<TaskRecord>) => w.db((db) => {
    const row = db.read<TaskRecord>(TASKS, id)!;
    db.update(TASKS, id, row.version, { ...row.data, ...change(row.data) } as TaskRecord);
  });
  const read = () => w.db((db) => db.read<TaskRecord>(TASKS, id)!);
  seed(() => ({ status: "awaiting_parent", attempts: [{ runId: uuidv7(), maxTurns: 1, turnsUsed: 1, reason: null, outcome: "turn_limit_reached" }] }));
  await w.plan.execute({ action: "update", planVersion: 1, modify: [{ taskId: id, version: read().data.version, spec: { ...spec("T1", "goal.login"), objective: "先用掉重算额度" } }] });
  seed((data) => ({ status: lastOutcome === "completed" ? "awaiting_review" : "awaiting_parent",
    attempts: [...data.attempts, { runId: uuidv7(), maxTurns: 1, turnsUsed: 1, reason: null, outcome: "turn_limit_reached" },
      { runId: uuidv7(), maxTurns: 1, turnsUsed: 1, reason: "估计不足", outcome: lastOutcome }] }));
  await w.plan.execute({ action: "update", planVersion: 2, modify: [{ taskId: id, version: read().data.version, spec: { ...spec("T1", "goal.login"), objective: "改过的目标" } }] });
  return { w, id };
}

test("改计划后要重做：第 2 次执行已完成、等审查时 PM 改了计划，待裁决事项写“改计划后要重做，执行机会已用完”，任务行同文", async () => {
  const { w, id } = await modifiedAfterTwoAttempts("completed");
  const overview = await w.overview();
  expect(overview.pendingItems).toMatchObject([{ itemId: `task:${id}`, kind: "adjudicate",
    label: "待裁决：任务 T1 改计划后要重做，执行机会已用完", taskKey: "T1", taskText: expect.stringContaining("改计划后要重做，执行机会已用完") }]);
  expect(overview.taskRows).toContainEqual(expect.objectContaining({ kind: "pending", taskKey: "T1", text: expect.stringContaining("改计划后要重做，执行机会已用完") }));
});

test("最后一次执行确实没完成时，即使 PM 改了计划，待裁决事项仍写“2 次未完成”", async () => {
  const { w } = await modifiedAfterTwoAttempts("turn_limit_reached");
  expect((await w.overview()).pendingItems).toMatchObject([{ kind: "adjudicate", label: "待裁决：任务 T1 2 次未完成", taskText: expect.stringContaining("2 次未完成") }]);
});

test("次数按实际值写数字：执行第 3 次又没完成，待裁决事项写“3 次未完成”", async () => {
  const w = await world();
  await w.plan.execute({ action: "propose", tasks: [spec("T1", "goal.login"), spec("other", "scenario.failure")] });
  await w.plan.execute({ action: "confirm", planVersion: 1 });
  const id = w.taskId("T1");
  w.db((db) => {
    const row = db.read<TaskRecord>(TASKS, id)!;
    db.update(TASKS, id, row.version, { ...row.data, status: "awaiting_user",
      attempts: [1, 2, 3].map(() => ({ runId: uuidv7(), maxTurns: 1, turnsUsed: 1, reason: null, outcome: "turn_limit_reached" as const })) } as TaskRecord);
  });
  expect((await pendingLabels(w))).toEqual(["待裁决：任务 T1 3 次未完成"]);
});

test("次数按实际值写数字：审查打回 3 轮，待裁决事项写“3 次未通过审查（go-reviewer）”", async () => {
  const { w } = await reviewStuckWorld([
    { agent: "go-reviewer", round: 1, outcome: "blocked" }, { agent: "go-reviewer", round: 2, outcome: "blocked" }, { agent: "go-reviewer", round: 3, outcome: "blocked" }]);
  expect(await pendingLabels(w)).toEqual(["待裁决：任务 T3 3 次未通过审查（go-reviewer）"]);
});

test("次数按实际值写数字：同一代理同一轮 3 次没交出结论，写“3 次审查未完成（vue-reviewer）”", async () => {
  const { w } = await reviewStuckWorld([
    { agent: "vue-reviewer", round: 1, outcome: "failed" }, { agent: "vue-reviewer", round: 1, outcome: "failed" }, { agent: "vue-reviewer", round: 1, outcome: "failed" }]);
  expect(await pendingLabels(w)).toEqual(["待裁决：任务 T3 3 次审查未完成（vue-reviewer）"]);
});

test("各代理没交出结论的次数不同时逐个写次数：写“审查未完成（go-reviewer 3 次、vue-reviewer 2 次）”", async () => {
  const { w } = await reviewStuckWorld([
    { agent: "go-reviewer", round: 1, outcome: "failed" }, { agent: "go-reviewer", round: 1, outcome: "failed" }, { agent: "go-reviewer", round: 1, outcome: "failed" },
    { agent: "vue-reviewer", round: 1, outcome: "failed" }, { agent: "vue-reviewer", round: 1, outcome: "failed" }]);
  expect(await pendingLabels(w)).toEqual(["待裁决：任务 T3 审查未完成（go-reviewer 3 次、vue-reviewer 2 次）"]);
});

type World = Awaited<ReturnType<typeof world>>;
type TaskReviewRow = TaskRecord["reviews"][number];

async function seedRun(w: World, input: { role: "worker" | "reviewer" | "qa" | "explore"; agent?: string; task?: string; turns?: number; maxTurns?: number; state?: "running" | "failed" | "stopped" | "completed" }): Promise<string> {
  const id = uuidv7();
  await w.runStore.create({ id, kind: "role", role: `one-company.${input.role}`, requirement: w.fixture.requirementId, parentRunId: w.pm.runId, task: input.task ?? "",
    cwd: w.fixture.repositoryRoot, writePaths: [], readPaths: [], model: { provider: "team-model", id: "test" }, thinking: "off", mcp: [],
    ...(input.maxTurns === undefined ? {} : { maxTurns: input.maxTurns }),
    ...(input.agent ? { agent: { name: input.agent, source: "default", path: `/agents/${input.agent}.md`, hash: "0".repeat(64), skills: [] } } : {}) } as Parameters<World["runStore"]["create"]>[0]);
  if (input.state === "completed") await w.runStore.update(id, { state: "running" });
  await w.runStore.update(id, { state: input.state ?? "running", turns: input.turns ?? 0 });
  return id;
}

async function rowsWorld(keys: string[] = ["T1", "T2", "T3", "T4"]) {
  const w = await world();
  await w.plan.execute({ action: "propose", tasks: keys.map((key, index) => ({ ...spec(key, "goal.login"), goalUnitIds: index === 0 ? ["goal.login", "scenario.failure"] : ["goal.login"] })) });
  await w.plan.execute({ action: "confirm", planVersion: 1 });
  const patch = (key: string, fields: Partial<TaskRecord>) => w.db((db) => {
    const row = db.read<TaskRecord>(TASKS, w.taskId(key))!;
    db.update(TASKS, row.data.taskId, row.version, { ...row.data, ...fields } as TaskRecord);
  });
  const attempt = (runId: string, outcome: TaskRecord["attempts"][number]["outcome"] = "running") =>
    ({ runId, maxTurns: 1, turnsUsed: 0, reason: null, outcome }) as TaskRecord["attempts"][number];
  const executing = async (key: string, run: Omit<Parameters<typeof seedRun>[1], "role" | "task"> = {}) => {
    const runId = await seedRun(w, { role: "worker", task: w.taskId(key), ...run });
    patch(key, { status: "running", attempts: [attempt(runId)] });
    return runId;
  };
  const review = (attemptRunId: string, row: Pick<TaskReviewRow, "agent" | "round" | "outcome"> & Partial<TaskReviewRow>): TaskReviewRow =>
    ({ runId: uuidv7(), attemptRunId, maxTurns: 1, turnsUsed: 0, ...row }) as TaskReviewRow;
  /** 审查中的任务：已完成的执行尝试 + 给定的审查记录，其中在跑的审查代理另有运行记录。 */
  const reviewing = async (key: string, rows: Array<Pick<TaskReviewRow, "agent" | "round" | "outcome"> & Partial<TaskReviewRow> & { turns?: number; maxTurns?: number }>) => {
    const attemptRunId = uuidv7();
    const reviews: TaskReviewRow[] = [];
    for (const { turns, maxTurns, ...row } of rows) {
      const ran = ["running", "failed", "turn_limit_reached", "stopped", "clear", "blocked", "unverified", "superseded"].includes(row.outcome);
      const endState = row.outcome === "running" ? "running" : ["clear", "blocked", "unverified"].includes(row.outcome) ? "completed" : row.outcome === "failed" || row.outcome === "turn_limit_reached" ? "failed" : "stopped";
      const runId = ran
        ? await seedRun(w, { role: "reviewer", agent: row.agent, task: w.taskId(key), turns, maxTurns, state: endState as "running" | "failed" | "stopped" | "completed" }) : uuidv7();
      reviews.push(review(attemptRunId, { ...row, runId, ...(ran ? { turnsUsed: turns ?? 0, maxTurns: maxTurns ?? 1 } : {}) }));
    }
    patch(key, { status: "reviewing", attempts: [attempt(attemptRunId, "completed")], reviews });
  };
  const reviewersOf = async (key: string) => {
    const row = (await w.overview()).taskRows!.find((candidate) => candidate.kind === "review" && candidate.taskKey === key);
    return row?.kind === "review" ? row : undefined;
  };
  return { w, patch, executing, reviewing, reviewersOf, attempt };
}

test("任务行：只有 T3 由 go-worker 第 1 次执行时只有一条 execute 行，轮数上限取运行记录上保存的值", async () => {
  const { w, executing } = await rowsWorld();
  await executing("T3", { agent: "go-worker", turns: 8, maxTurns: 20 });
  expect((await w.overview()).taskRows).toEqual([
    { kind: "execute", taskKey: "T3", agent: "go-worker", attempt: 1, turns: 8, maxTurns: 20, elapsedMs: expect.any(Number) }]);
});

test("任务行：任务已有一次未完成的尝试后再派出，execute 行的 attempt 为 2", async () => {
  const { w, patch, attempt } = await rowsWorld();
  const first = await seedRun(w, { role: "worker", agent: "go-worker", task: w.taskId("T1"), state: "failed", maxTurns: 5 });
  const second = await seedRun(w, { role: "worker", agent: "go-worker", task: w.taskId("T1"), turns: 2, maxTurns: 9 });
  patch("T1", { status: "running", attempts: [attempt(first, "incomplete"), attempt(second)] });
  expect((await w.overview()).taskRows).toMatchObject([{ kind: "execute", taskKey: "T1", attempt: 2, turns: 2, maxTurns: 9 }]);
});

test("任务行：T1、T2、T4 同时执行时有三条 execute 行，按计划里任务的先后排列而不是派出的先后", async () => {
  const { w, executing } = await rowsWorld();
  await executing("T4", { agent: "go-worker", maxTurns: 10 });
  await executing("T1", { agent: "vue-worker", maxTurns: 11 });
  await executing("T2", { agent: "go-worker", maxTurns: 12 });
  expect(((await w.overview()).taskRows ?? []).map((row) => [row.kind, "taskKey" in row ? row.taskKey : null])).toEqual([["execute", "T1"], ["execute", "T2"], ["execute", "T4"]]);
});

test("任务行：第 1 轮 reviewer、go-reviewer 在跑、vue-reviewer 已通过时是一条 review 行，审查代理依次为 running、running、clear", async () => {
  const { w, reviewing } = await rowsWorld();
  await reviewing("T1", [
    { agent: "reviewer", round: 1, outcome: "running", turns: 3, maxTurns: 15 },
    { agent: "go-reviewer", round: 1, outcome: "running", turns: 5, maxTurns: 16 },
    { agent: "vue-reviewer", round: 1, outcome: "clear", turns: 6, maxTurns: 14 }]);
  expect((await w.overview()).taskRows).toEqual([{ kind: "review", taskKey: "T1", round: 1, reviewers: [
    { agent: "reviewer", state: "running", turns: 3, maxTurns: 15, elapsedMs: expect.any(Number) },
    { agent: "go-reviewer", state: "running", turns: 5, maxTurns: 16, elapsedMs: expect.any(Number) },
    { agent: "vue-reviewer", state: "clear", turns: 6, maxTurns: 14, elapsedMs: expect.any(Number) }] }]);
});

test("任务行：本轮被打回（blocked 或 unverified）的审查代理状态为 blocked", async () => {
  const { w, reviewing, reviewersOf } = await rowsWorld();
  await reviewing("T1", [
    { agent: "reviewer", round: 1, outcome: "running", turns: 1, maxTurns: 15 },
    { agent: "go-reviewer", round: 1, outcome: "blocked" },
    { agent: "vue-reviewer", round: 1, outcome: "unverified" }]);
  expect((await reviewersOf("T1"))?.reviewers.map((reviewer) => [reviewer.agent, reviewer.state])).toEqual([
    ["reviewer", "running"], ["go-reviewer", "blocked"], ["vue-reviewer", "blocked"]]);
});

test("任务行：第 2 轮只派 reviewer、go-reviewer 时，上一轮已通过的 vue-reviewer 以 passed_earlier 排在末尾，被关闭跳过的 go-reviewer 为 skipped_disabled", async () => {
  const { w, reviewing, reviewersOf } = await rowsWorld();
  await reviewing("T1", [
    { agent: "reviewer", round: 1, outcome: "blocked" }, { agent: "vue-reviewer", round: 1, outcome: "clear" },
    { agent: "reviewer", round: 2, outcome: "running", turns: 1, maxTurns: 15 },
    { agent: "go-reviewer", round: 2, outcome: "skipped", skipReason: "disabled" }]);
  const row = await reviewersOf("T1");
  expect(row?.round).toBe(2);
  expect(row?.reviewers.map((reviewer) => [reviewer.agent, reviewer.state])).toEqual([
    ["reviewer", "running"], ["go-reviewer", "skipped_disabled"], ["vue-reviewer", "passed_earlier"]]);
});

test("任务行：已不存在而被跳过的审查代理状态为 skipped_missing", async () => {
  const { w, reviewing, reviewersOf } = await rowsWorld();
  await reviewing("T1", [
    { agent: "reviewer", round: 1, outcome: "running", turns: 1, maxTurns: 15 },
    { agent: "old-reviewer", round: 1, outcome: "skipped", skipReason: "missing" }]);
  expect((await reviewersOf("T1"))?.reviewers.map((reviewer) => [reviewer.agent, reviewer.state])).toEqual([["reviewer", "running"], ["old-reviewer", "skipped_missing"]]);
});

test("任务行：同轮 reviewer 还在跑、go-reviewer 已 failed 没交出结论且次数没满时，go-reviewer 状态为 awaiting_retry", async () => {
  const { w, reviewing, reviewersOf } = await rowsWorld();
  await reviewing("T1", [
    { agent: "reviewer", round: 1, outcome: "running", turns: 1, maxTurns: 15 },
    { agent: "go-reviewer", round: 1, outcome: "failed" }]);
  expect((await reviewersOf("T1"))?.reviewers.map((reviewer) => [reviewer.agent, reviewer.state])).toEqual([["reviewer", "running"], ["go-reviewer", "awaiting_retry"]]);
});

test("任务行与待处理事项：T1 2 次未通过审查等用户裁决、T2 执行中时，T1 是 pending 行（文字去掉“任务 T1 ”）排在 T2 的 execute 行之前，itemId 与 pendingItems 里那条相同；原有 label、itemId、version 不变并多出 taskKey、taskText", async () => {
  const { w, patch, executing, attempt } = await rowsWorld();
  const attemptRunId = uuidv7();
  patch("T1", { status: "awaiting_user", attempts: [attempt(attemptRunId, "completed")], reviews: [
    { runId: uuidv7(), attemptRunId, maxTurns: 1, turnsUsed: 1, agent: "go-reviewer", round: 1, outcome: "blocked" },
    { runId: uuidv7(), attemptRunId, maxTurns: 1, turnsUsed: 1, agent: "go-reviewer", round: 2, outcome: "blocked" }] });
  await executing("T2", { agent: "go-worker", turns: 2, maxTurns: 20 });
  const overview = await w.overview();
  const item = overview.pendingItems[0]!;
    expect(item).toMatchObject({ itemId: `task:${w.taskId("T1")}`, kind: "adjudicate", label: "待裁决：任务 T1 2 次未通过审查（go-reviewer）",
    taskKey: "T1", taskText: "待裁决：2 次未通过审查（go-reviewer）" });
  expect(overview.taskRows).toMatchObject([
    { kind: "pending", taskKey: "T1", itemId: item.itemId, text: "待裁决：2 次未通过审查（go-reviewer）" },
    { kind: "execute", taskKey: "T2", agent: "go-worker", attempt: 1 }]);
});

test("待处理事项：任务被终止后的 adjust-requirement 事项多出 taskKey 与去掉“任务 T1 ”的 taskText，label 不变", async () => {
  const { w, patch, executing } = await rowsWorld();
  const revision = w.fixture.state.read(w.fixture.requirementId).data.revision;
  patch("T1", { status: "failed", userDecision: { decisionId: uuidv7(), choice: "terminate", maxTurns: null, revision, taskVersion: 1, usedByRunId: null, notified: false } });
  await executing("T2", { agent: "go-worker", maxTurns: 20 });
  expect((await w.overview()).pendingItems).toMatchObject([{ kind: "adjust-requirement", label: "待决定：任务 T1 已终止，请调整需求或取消需求",
    taskKey: "T1", taskText: "待决定：已终止，请调整需求或取消需求" }]);
});

test("待处理事项：未决问题阻塞任务时 question 事项的 taskText 为“待回答：未决问题”，任务行是对应的 pending 行，label 不变", async () => {
  const { w, patch, executing } = await rowsWorld();
  const questionId = uuidv7();
  patch("T1", { blockedByQuestionIds: [questionId] });
  await executing("T2", { agent: "go-worker", maxTurns: 20 });
  const overview = await w.overview();
  expect(overview.pendingItems).toMatchObject([{ itemId: `question:${questionId}`, kind: "question", label: "待回答：任务 T1 的未决问题",
    taskKey: "T1", taskText: "待回答：未决问题" }]);
  expect(overview.taskRows).toMatchObject([{ kind: "pending", taskKey: "T1", itemId: `question:${questionId}`, text: "待回答：未决问题" }, { kind: "execute", taskKey: "T2" }]);
});

test("任务行：PM 派出的检索占一行，排在所有任务行之后，带轮数与轮数上限", async () => {
  const { w, executing } = await rowsWorld();
  await seedRun(w, { role: "explore", agent: "explore", task: "explore", turns: 2, maxTurns: 12 });
  await executing("T2", { agent: "go-worker", maxTurns: 20 });
  const rows = (await w.overview()).taskRows ?? [];
  expect(rows).toHaveLength(2);
  expect(rows[0]).toMatchObject({ kind: "execute", taskKey: "T2" });
  expect(rows[1]).toEqual({ kind: "explore", turns: 2, maxTurns: 12, elapsedMs: expect.any(Number) });
});

test("任务行：规划中没有子代理时 taskRows 为空数组，doing 照旧", async () => {
  const w = await world();
  await w.plan.execute({ action: "propose", tasks: [spec("login", "goal.login"), spec("failure", "scenario.failure")] });
  const overview = await w.overview();
  expect(overview.taskRows).toEqual([]);
  expect(overview.doing).toBe("规划中（计划 v1 · 2 个任务）");
});

test("暂停中的 doing 写运行记录里的定义名：go-worker、reviewer 在跑时为“暂停中：等待 go-worker、reviewer 结束”", async () => {
  const w = await world();
  await seedRun(w, { role: "reviewer", agent: "reviewer" });
  await new Promise((resolve) => setTimeout(resolve, 5));
  await seedRun(w, { role: "worker", agent: "go-worker" });
  await w.runStore.update(w.pm.runId, { state: "pausing" });
  expect((await w.overview()).doing).toMatch(/^暂停中：等待 (go-worker、reviewer|reviewer、go-worker) 结束$/);
});

test("暂停中的 doing：运行记录没有定义名时用职责名兜底", async () => {
  const w = await world();
  await seedRun(w, { role: "worker" });
  await w.runStore.update(w.pm.runId, { state: "pausing" });
  expect((await w.overview()).doing).toBe("暂停中：等待 worker 结束");
});

const changedCount = (w: World) => w.emit.mock.calls.filter(([event]) => event === "pm.overview.changed").length;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("概览广播：子代理在跑、只有用时在变时守护进程不发 pm.overview.changed；审查真的结束后照常发", async () => {
  const { w, reviewing, patch, reviewersOf } = await rowsWorld();
  await reviewing("T1", [{ agent: "reviewer", round: 1, outcome: "running", turns: 3, maxTurns: 15 }, { agent: "go-reviewer", round: 1, outcome: "running", turns: 2, maxTurns: 15 }]);
  await seedRun(w, { role: "explore", agent: "explore", task: "explore", turns: 1, maxTurns: 12 });
  expect(await reviewersOf("T1")).toBeDefined();
  await pause(1_500);
  const settled = changedCount(w);
  await pause(2_000);
  expect(changedCount(w)).toBe(settled);

  const reviewer = (await w.overview()).taskRows!.flatMap((row) => row.kind === "review" ? [row] : [])[0]!;
  expect(reviewer.reviewers.map((entry) => entry.state)).toEqual(["running", "running"]);
  const record = await w.runStore.list({ limit: 100 });
  const reviewerRun = record.items.find((run) => run.agent?.name === "reviewer")!;
  await w.runStore.update(reviewerRun.id, { state: "completed" });
  patch("T1", { reviews: (await w.db((db) => db.read<TaskRecord>(TASKS, w.taskId("T1"))!.data.reviews)).map((entry) => entry.agent === "reviewer" ? { ...entry, outcome: "clear" as const } : entry) });
  await until(() => changedCount(w) > settled);
});

test("doing 文字：任务行为空但有子代理在跑（任务尝试已作废、运行还在停止途中）时，“派 <X> 执行 <任务号>” 写运行记录的定义名", async () => {
  const { w, patch, attempt } = await rowsWorld();
  const runId = await seedRun(w, { role: "worker", agent: "go-worker", task: w.taskId("T1"), maxTurns: 5 });
  patch("T1", { status: "pending", attempts: [attempt(runId, "superseded")] });
  const overview = await w.overview();
  expect(overview.taskRows).toEqual([]);
  expect(overview.doing).toMatch(/^派 go-worker 执行 T1/);
});

test("doing 文字：任务行为空但有审查代理在跑时，“派 <X> 审查 <任务号>” 写定义名 go-reviewer", async () => {
  const { w, patch, attempt } = await rowsWorld();
  const attemptRunId = uuidv7();
  const runId = await seedRun(w, { role: "reviewer", agent: "go-reviewer", task: w.taskId("T1"), maxTurns: 5 });
  patch("T1", { status: "awaiting_rework", attempts: [attempt(attemptRunId, "completed")], reviews: [
    { runId, attemptRunId, maxTurns: 5, turnsUsed: 0, agent: "go-reviewer", round: 1, outcome: "superseded" }] });
  const overview = await w.overview();
  expect(overview.taskRows).toEqual([]);
  expect(overview.doing).toMatch(/^派 go-reviewer 审查 T1/);
});

test("doing 文字：运行记录没有定义名时“派 <X> 执行”用职责名 worker 兜底", async () => {
  const { w, patch, attempt } = await rowsWorld();
  const runId = await seedRun(w, { role: "worker", task: w.taskId("T1") });
  patch("T1", { status: "pending", attempts: [attempt(runId, "superseded")] });
  expect((await w.overview()).doing).toMatch(/^派 worker 执行 T1/);
});

async function elapsedWorld() {
  const { w, executing } = await rowsWorld();
  const t0 = Date.now();
  vi.useFakeTimers({ toFake: ["Date"], now: t0 }); cleanups.push(() => { vi.useRealTimers(); });
  const runId = await executing("T1", { agent: "go-worker", maxTurns: 10 });
  const elapsed = async () => ((await w.overview()).taskRows![0] as { elapsedMs: number }).elapsedMs;
  return { w, t0, runId, elapsed };
}

test("elapsedMs：运行中等于 now − startedAt − pausedMs", async () => {
  const { w, t0, runId, elapsed } = await elapsedWorld();
  await w.runStore.update(runId, { pausedMs: 1_000 });
  vi.setSystemTime(t0 + 7_000);
  expect(await elapsed()).toBe(6_000);
});

test("elapsedMs：暂停中保持在 pausedAt − startedAt − pausedMs，时间再走也不变", async () => {
  const { w, t0, runId, elapsed } = await elapsedWorld();
  await w.runStore.recordPause(runId, new Date(t0 + 2_000).toISOString());
  vi.setSystemTime(t0 + 6_000);
  expect(await elapsed()).toBe(2_000);
  vi.setSystemTime(t0 + 20_000);
  expect(await elapsed()).toBe(2_000);
});

test("elapsedMs：恢复后扣掉暂停时长", async () => {
  const { w, t0, runId, elapsed } = await elapsedWorld();
  await w.runStore.recordPause(runId, new Date(t0 + 2_000).toISOString());
  await w.runStore.recordResume(runId, new Date(t0 + 6_000).toISOString());
  vi.setSystemTime(t0 + 10_000);
  expect(await elapsed()).toBe(6_000);
});

test("任务行：旧运行记录没有 maxTurns 时 execute 行的 maxTurns 为 null", async () => {
  const { w, executing } = await rowsWorld();
  await executing("T1", { agent: "go-worker", turns: 2 });
  expect((await w.overview()).taskRows).toMatchObject([{ kind: "execute", taskKey: "T1", turns: 2, maxTurns: null }]);
});

test("review 行：任务被改成 needs_update 但审查还在跑时仍有 review 行；整轮结束任务转 awaiting_rework 后没有 review 行", async () => {
  const { w, reviewing, patch, reviewersOf, executing } = await rowsWorld();
  await reviewing("T1", [{ agent: "reviewer", round: 1, outcome: "running", turns: 1, maxTurns: 15 }]);
  patch("T1", { status: "needs_update" });
  expect(await reviewersOf("T1")).toMatchObject({ round: 1, reviewers: [{ agent: "reviewer", state: "running" }] });

  const reviewerRun = (await w.runStore.list({ limit: 100 })).items.find((run) => run.agent?.name === "reviewer")!;
  await w.runStore.update(reviewerRun.id, { state: "completed" });
  const reviews = w.db((db) => db.read<TaskRecord>(TASKS, w.taskId("T1"))!.data.reviews).map((entry) => ({ ...entry, outcome: "blocked" as const }));
  patch("T1", { status: "awaiting_rework", reviews });
  await executing("T2", { agent: "go-worker", maxTurns: 20 });
  expect((await w.overview()).taskRows).toMatchObject([{ kind: "execute", taskKey: "T2" }]);
  expect((await w.overview()).taskRows).toHaveLength(1);
});

test("待处理事项 version：与任务有关的三类事项 version 与加字段前完全一致", async () => {
  const stuck = await reviewStuckWorld([{ agent: "go-reviewer", round: 1, outcome: "blocked" }, { agent: "go-reviewer", round: 2, outcome: "blocked" }]);
  expect((await stuck.w.overview()).pendingItems).toEqual([{ itemId: `task:${stuck.id}`, kind: "adjudicate", label: "待裁决：任务 T3 2 次未通过审查（go-reviewer）",
    version: `task:${stuck.id}:${stuck.version()}`, taskKey: "T3", taskText: "待裁决：2 次未通过审查（go-reviewer）" }]);

  const { w, patch, executing } = await rowsWorld();
  const record = w.fixture.state.read(w.fixture.requirementId).data;
  const questionId = uuidv7();
  patch("T1", { status: "failed", userDecision: { decisionId: uuidv7(), choice: "terminate", maxTurns: null, revision: record.revision, taskVersion: 1, usedByRunId: null, notified: false } });
  patch("T2", { blockedByQuestionIds: [questionId] });
  await executing("T3", { agent: "go-worker", maxTurns: 20 });
  const items = (await w.overview()).pendingItems;
  expect(items.find((item) => item.kind === "adjust-requirement")).toMatchObject({ itemId: `halt:${w.taskId("T1")}`, version: `halt:${w.taskId("T1")}:${record.revision}` });
  expect(items.find((item) => item.kind === "question")).toMatchObject({ itemId: `question:${questionId}`,
    version: `question:${questionId}:${record.approvalManifest!.reference.manifestHash}` });
});

test("PM 暂停中或已暂停时 taskRows 为空数组（即使有执行中、审查中的子代理），doing 写定义名；恢复运行后任务行重新出现", async () => {
  const { w, executing, reviewing } = await rowsWorld();
  await executing("T1", { agent: "go-worker", turns: 2, maxTurns: 20 });
  await reviewing("T2", [{ agent: "reviewer", round: 1, outcome: "running", turns: 1, maxTurns: 15 }]);
  expect((await w.overview()).taskRows).toMatchObject([{ kind: "execute", taskKey: "T1" }, { kind: "review", taskKey: "T2" }]);

  await w.runStore.update(w.pm.runId, { state: "pausing" });
  const pausing = await w.overview();
  expect(pausing.taskRows).toEqual([]);
  expect(pausing.doing).toMatch(/^暂停中：等待 (go-worker、reviewer|reviewer、go-worker) 结束$/);

  await w.runStore.update(w.pm.runId, { state: "paused" });
  expect((await w.overview()).taskRows).toEqual([]);

  await w.runStore.update(w.pm.runId, { state: "running" });
  expect((await w.overview()).taskRows).toMatchObject([{ kind: "execute", taskKey: "T1" }, { kind: "review", taskKey: "T2" }]);
});

test("任务行：同一任务既有未决问题又有在跑的执行尝试时出两行，先 pending（待回答：未决问题）再 execute", async () => {
  const { w, patch, executing } = await rowsWorld();
  const questionId = uuidv7();
  patch("T1", { blockedByQuestionIds: [questionId] });
  await executing("T1", { agent: "go-worker", turns: 4, maxTurns: 20 });
  expect((await w.overview()).taskRows).toMatchObject([
    { kind: "pending", taskKey: "T1", itemId: `question:${questionId}`, text: "待回答：未决问题" },
    { kind: "execute", taskKey: "T1", agent: "go-worker", attempt: 1, turns: 4, maxTurns: 20 }]);
  expect((await w.overview()).taskRows).toHaveLength(2);
});

const reviewerStates = (row: { reviewers: Array<{ agent: string; state: string }> } | undefined) => row?.reviewers.map((entry) => [entry.agent, entry.state]);

test("审查代理行：本轮没交结论（轮次用满）且次数没满时为 awaiting_retry，reason 为 turn_limit_reached，带那次运行的轮数、上限和用时；任务 reviewing 时 review 行出现", async () => {
  const { w, reviewing, reviewersOf } = await rowsWorld();
  await reviewing("T1", [
    { agent: "reviewer", round: 1, outcome: "running", turns: 3, maxTurns: 15 },
    { agent: "go-reviewer", round: 1, outcome: "turn_limit_reached", turns: 12, maxTurns: 12 }]);
  expect((await reviewersOf("T1"))?.reviewers).toEqual([
    { agent: "reviewer", state: "running", turns: 3, maxTurns: 15, elapsedMs: expect.any(Number) },
    { agent: "go-reviewer", state: "awaiting_retry", reason: "turn_limit_reached", turns: 12, maxTurns: 12, elapsedMs: expect.any(Number) }]);
});

test("审查代理行：failed、stopped 没交结论时 reason 分别为 failed、stopped", async () => {
  const { w, reviewing, reviewersOf } = await rowsWorld();
  await reviewing("T1", [
    { agent: "reviewer", round: 1, outcome: "running", turns: 1, maxTurns: 15 },
    { agent: "go-reviewer", round: 1, outcome: "failed", turns: 2, maxTurns: 12 },
    { agent: "vue-reviewer", round: 1, outcome: "stopped", turns: 4, maxTurns: 12 }]);
  const reviewers = (await reviewersOf("T1"))?.reviewers;
  expect(reviewers?.[1]).toMatchObject({ agent: "go-reviewer", state: "awaiting_retry", reason: "failed", turns: 2, maxTurns: 12 });
  expect(reviewers?.[2]).toMatchObject({ agent: "vue-reviewer", state: "awaiting_retry", reason: "stopped", turns: 4, maxTurns: 12 });
});

test("审查代理行：同一轮第 2 次、第 3 次在跑时 attempt 为 2、3，第 1 次不带 attempt", async () => {
  const { w, reviewing, reviewersOf } = await rowsWorld();
  await reviewing("T1", [
    { agent: "reviewer", round: 1, outcome: "running", turns: 1, maxTurns: 15 },
    { agent: "go-reviewer", round: 1, outcome: "failed", turns: 2, maxTurns: 12 },
    { agent: "go-reviewer", round: 1, outcome: "running", turns: 1, maxTurns: 12 },
    { agent: "vue-reviewer", round: 1, outcome: "failed", turns: 2, maxTurns: 12 },
    { agent: "vue-reviewer", round: 1, outcome: "stopped", turns: 2, maxTurns: 12 },
    { agent: "vue-reviewer", round: 1, outcome: "running", turns: 1, maxTurns: 12 }]);
  const reviewers = (await reviewersOf("T1"))?.reviewers;
  expect(reviewers?.find((entry) => entry.agent === "reviewer")).toEqual({ agent: "reviewer", state: "running", turns: 1, maxTurns: 15, elapsedMs: expect.any(Number) });
  expect(reviewers?.find((entry) => entry.agent === "go-reviewer")).toMatchObject({ state: "running", attempt: 2, turns: 1, maxTurns: 12 });
  expect(reviewers?.find((entry) => entry.agent === "vue-reviewer")).toMatchObject({ state: "running", attempt: 3 });
});

test("审查代理行：本轮没交结论已满 2 次时为 exhausted，带最后那次运行的轮数和用时", async () => {
  const { w, reviewing, reviewersOf } = await rowsWorld();
  await reviewing("T1", [
    { agent: "reviewer", round: 1, outcome: "running", turns: 1, maxTurns: 15 },
    { agent: "go-reviewer", round: 1, outcome: "failed", turns: 2, maxTurns: 12 },
    { agent: "go-reviewer", round: 1, outcome: "turn_limit_reached", turns: 9, maxTurns: 12 }]);
  expect((await reviewersOf("T1"))?.reviewers.find((entry) => entry.agent === "go-reviewer")).toEqual(
    { agent: "go-reviewer", state: "exhausted", attempt: 2, reason: "turn_limit_reached", turns: 9, maxTurns: 12, elapsedMs: expect.any(Number) });
});

test("审查代理行：PM 临时加的代理（任务 reviewers 里 added: true）在跑时和其他代理一样出一行", async () => {
  const { w, reviewing, patch, reviewersOf } = await rowsWorld();
  await reviewing("T1", [
    { agent: "reviewer", round: 1, outcome: "running", turns: 1, maxTurns: 15 },
    { agent: "extra-reviewer", round: 1, outcome: "running", turns: 2, maxTurns: 8 }]);
  patch("T1", { reviewers: [{ agent: "extra-reviewer", reason: "临时加的", added: true }] } as Partial<TaskRecord>);
  expect(reviewerStates(await reviewersOf("T1"))).toEqual([["reviewer", "running"], ["extra-reviewer", "running"]]);
  expect((await reviewersOf("T1"))?.reviewers[1]).toMatchObject({ turns: 2, maxTurns: 8 });
});

test("审查代理行：本轮被作废（superseded）、其他代理还在跑时为 awaiting_retry，reason 为 superseded，带轮数、上限和用时", async () => {
  const { w, reviewing, reviewersOf } = await rowsWorld();
  await reviewing("T1", [
    { agent: "reviewer", round: 1, outcome: "running", turns: 1, maxTurns: 15 },
    { agent: "go-reviewer", round: 1, outcome: "superseded", turns: 5, maxTurns: 12 }]);
  expect((await reviewersOf("T1"))?.reviewers[1]).toEqual(
    { agent: "go-reviewer", state: "awaiting_retry", reason: "superseded", turns: 5, maxTurns: 12, elapsedMs: expect.any(Number) });
});

test("审查代理行：被打回的代理也带那次运行的轮数、上限和用时", async () => {
  const { w, reviewing, reviewersOf } = await rowsWorld();
  await reviewing("T1", [
    { agent: "reviewer", round: 1, outcome: "running", turns: 1, maxTurns: 15 },
    { agent: "go-reviewer", round: 1, outcome: "blocked", turns: 7, maxTurns: 12 }]);
  expect((await reviewersOf("T1"))?.reviewers[1]).toEqual({ agent: "go-reviewer", state: "blocked", turns: 7, maxTurns: 12, elapsedMs: expect.any(Number) });
});

test("elapsedMs：已结束的运行算到结束时刻，先暂停后被停止时暂停那段不计入，之后时间再走也不变", async () => {
  const { w, patch, executing, reviewersOf } = await rowsWorld();
  const t0 = Date.now();
  vi.useFakeTimers({ toFake: ["Date"], now: t0 }); cleanups.push(() => { vi.useRealTimers(); });
  await executing("T2", { agent: "go-worker", maxTurns: 20 });
  const attemptRunId = uuidv7();
  const stoppedRun = await seedRun(w, { role: "reviewer", agent: "go-reviewer", task: w.taskId("T1"), turns: 3, maxTurns: 12 });
  const runningRun = await seedRun(w, { role: "reviewer", agent: "reviewer", task: w.taskId("T1"), turns: 1, maxTurns: 15 });
  const row = (runId: string, agent: string, outcome: "running" | "stopped") => ({ runId, attemptRunId, maxTurns: 12, turnsUsed: 3, agent, round: 1, outcome }) as TaskRecord["reviews"][number];
  patch("T1", { status: "reviewing", attempts: [{ runId: attemptRunId, maxTurns: 1, turnsUsed: 0, reason: null, outcome: "completed" }],
    reviews: [row(runningRun, "reviewer", "running"), row(stoppedRun, "go-reviewer", "stopped")] });
  await w.runStore.recordPause(stoppedRun, new Date(t0 + 2_000).toISOString());
  vi.setSystemTime(t0 + 6_000);
  await w.runStore.update(stoppedRun, { state: "stopped" });
  vi.setSystemTime(t0 + 30_000);
  expect((await reviewersOf("T1"))?.reviewers[1]).toMatchObject({ agent: "go-reviewer", elapsedMs: 2_000 });
});

async function panelLinesOf(w: World): Promise<string[]> {
  const instance = new PmPanel({ now: () => Date.now(), openItem: () => undefined, togglePause: () => undefined });
  instance.update([{ repoId: "r", overview: await w.overview(), fetchedAt: Date.now() }]);
  return instance.render(200);
}

test.each([[2], [3]])("面板审查代理行：本轮没交出结论 %i 次用满时写“– go-reviewer N 次没交出结论，本轮结束后交你裁决”（N 为实际次数）", async (count) => {
  const { w, reviewing } = await rowsWorld();
  await reviewing("T1", [
    { agent: "reviewer", round: 1, outcome: "running", turns: 1, maxTurns: 15 },
    ...Array.from({ length: count }, () => ({ agent: "go-reviewer", round: 1, outcome: "failed" as const }))]);
  const lines = await panelLinesOf(w);
  expect(lines.some((line) => line.includes(`– go-reviewer ${count} 次没交出结论，本轮结束后交你裁决`))).toBe(true);
});

test("次数口径：本轮记录为 [被作废, 运行失败, 运行失败] 时，面板行写“2 次没交出结论”，被作废不计入", async () => {
  const { w, reviewing } = await rowsWorld();
  await reviewing("T1", [
    { agent: "reviewer", round: 1, outcome: "running", turns: 1, maxTurns: 15 },
    { agent: "go-reviewer", round: 1, outcome: "superseded" }, { agent: "go-reviewer", round: 1, outcome: "failed" }, { agent: "go-reviewer", round: 1, outcome: "failed" }]);
  const lines = await panelLinesOf(w);
  expect(lines.some((line) => line.includes("– go-reviewer 2 次没交出结论，本轮结束后交你裁决"))).toBe(true);
  expect(lines.some((line) => line.includes("3 次没交出结论"))).toBe(false);
});

test("次数口径：本轮记录为 [被作废, 运行失败, 运行失败] 时，待裁决事项写“2 次审查未完成（go-reviewer）”", async () => {
  const { w } = await reviewStuckWorld([
    { agent: "go-reviewer", round: 1, outcome: "superseded" }, { agent: "go-reviewer", round: 1, outcome: "failed" }, { agent: "go-reviewer", round: 1, outcome: "failed" }]);
  expect(await pendingLabels(w)).toEqual(["待裁决：任务 T3 2 次审查未完成（go-reviewer）"]);
});
