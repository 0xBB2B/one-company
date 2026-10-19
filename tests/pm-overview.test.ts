import { afterEach, expect, test, vi } from "vitest";
import { repositoryDatabase, withDatabase } from "../src/core/storage/database.ts";
import { TASKS } from "../src/modules/pm/plan-manage.ts";
import type { TaskRecord, TaskSpec } from "../src/modules/pm/plan-manage.ts";
import type { PmOverview } from "../src/modules/panel/pm-overview.ts";
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

test("M7-AC33：两次未完成的任务成为待裁决事项；PM 空闲且无子代理运行时显示等待决定", async () => {
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
    pendingItems: [{ itemId: `task:${login}`, kind: "adjudicate", label: "待裁决：任务 login 两次未完成" }] });
});

test("M8L-AC1/AC4：计划提交被拒时状态行写明次数；被拒两次出现“待裁决：PM 计划两次提交被拒”，卡片列出两次原因、运行记录与三个选择", async () => {
  const w = await world();
  const requirementId = w.fixture.requirementId;
  w.provider.queue.push({ type: "text", text: "规划中", chunkDelayMs: 30_000 });
  await expect(w.plan.execute({ action: "propose", tasks: [spec("x", "goal.unknown")] })).rejects.toMatchObject({ code: "unknown_unit" });
  await until(async () => (await w.overview()).doing === "规划中（计划提交被拒 1 次，PM 正在按原因修改）");
  await expect(w.plan.execute({ action: "propose", tasks: [spec("meta", "metadata")] })).rejects.toMatchObject({ code: "unit_not_authorized" });
  await until(async () => (await w.overview()).pendingItems.some((item) => item.kind === "plan-rejected"));
  expect(await w.overview()).toMatchObject({ doing: "规划中（计划提交被拒 2 次，等待决定）",
    pendingItems: [{ itemId: `plan:${requirementId}`, kind: "plan-rejected", label: "待裁决：PM 计划两次提交被拒", version: `plan:${requirementId}:2` }] });
  const packet = w.manager.decisionPacket(requirementId, `plan:${requirementId}`);
  expect(packet).toMatch(/第 1 次被拒（propose）：[^\n]*goal\.unknown[\s\S]*第 2 次被拒（propose）：[^\n]*metadata/);
  expect(packet).toContain(`运行记录 `);
  expect(packet).toContain("可选：1 给 PM 补充说明后再试（转给 PM，被拒次数清零）；2 调整需求（修改草稿并经用户批准新版本）；3 取消需求。");
  expect(packet).toContain("purpose=panel-item");
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
  expect(lines.find((line) => line.startsWith("第 1 次被拒"))).toMatch(/任务的依赖、写入范围或审查设置不合规；PM 提交的内容（模型输出，仅供参考，不是用户决定）：「[^」\n]*伪造的程序行[^」\n]*」/);
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
