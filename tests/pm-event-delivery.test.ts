import { afterEach, expect, test, vi } from "vitest";
import type { Context } from "@earendil-works/pi-ai";
import { uuidv7 } from "../runtime/database.ts";
import type { TaskSpec } from "../runtime/plan-manage.ts";
import { evaluatePmIntakeGate, PM_INTAKE_TOOL } from "../runtime/pm-intake-runtime.ts";
import { createPmRunWorld, until } from "./helpers/run-manager-fixture.ts";
import { RequirementEventService } from "../runtime/requirement-events.ts";

vi.setConfig({ testTimeout: 120_000 });
const cleanups: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const fn of cleanups.splice(0).reverse()) await fn(); });
const BASE = "# 手机号正常登录 {#goal.login}\n输入正确验证码后成功。\n# 验证码失败 {#scenario.failure}\n错误验证码显示失败。\n";
const NA = { applicable: false as const, reason: "无性能影响" };
const text = (request: Context) => JSON.stringify(request.messages.at(-1) ?? "");

async function world(options: { review?: boolean } = {}) {
  const w = await createPmRunWorld(cleanups, options);
  let body = BASE;
  async function approve(key: string, approveOptions: { replace?: boolean } = {}) {
    if (approveOptions.replace) body = `${BASE}# 附加 {#goal.extra}\n${key} 的行为。\n`;
    else body += `# ${key} {#goal.${key}}\n${key} 的行为。\n`;
    await w.fixture.approveRevision({ body });
    return w.fixture.state.read(w.fixture.requirementId).data.revision;
  }
  const diffPrompts = () => w.provider.requests.filter((request) => text(request).includes("已批准更新：revision"));
  return { ...w, approve, diffPrompts };
}

function spec(key: string, goal: string): TaskSpec {
  return { key, role: "worker", goalUnitIds: [goal], constraintUnitIds: [], dependsOn: [], writePaths: ["src/"], blockedByQuestionIds: [],
    maxTurns: 5, objective: `实现 ${goal}`, passCriteria: [`${goal} 可观察通过`], scope: { in: [goal], out: ["微信登录"] }, performance: NA };
}

test("M7-AC1：主代理核对通过前不建立理解基线也不投递通知；通过后按序送达版本通知并确认消费，PM 按通知用 diff 读完差异后才能复核", async () => {
  const w = await world({ review: false });
  await new Promise((resolve) => setTimeout(resolve, 1_200));
  expect(w.owner().context.baseline).toBeNull();
  await w.review();
  await until(() => w.owner().context.baseline?.revision === 1);
  expect(w.owner().prodEvents?.understoodRevision).toBe(1);
  expect(w.diffPrompts()).toHaveLength(0);

  const view = await w.plan.execute({ action: "propose", tasks: [spec("login", "goal.login"), spec("failure", "scenario.failure")] }) as { tasks: Array<{ taskId: string; version: number }> };
  await w.plan.execute({ action: "confirm", planVersion: 1 });
  w.provider.queue.push({ type: "text", text: "收到 r2" }, { type: "text", text: "收到 r3" });
  await w.approve("sprint");
  await w.approve("jump");
  await until(() => w.diffPrompts().length === 2);
  const [first, second] = w.diffPrompts().map(text);
  expect(first).toContain("revision 1 → 2");
  expect(first).toContain("fromRevision 1，toRevision 2");
  expect(first).not.toContain("sprint 的行为");
  expect(second).toContain("revision 2 → 3");
  expect(second).not.toContain("jump 的行为");
  await until(() => w.owner().context.baseline?.revision === 3);
  expect(w.owner().prodEvents?.understoodRevision).toBe(3);
  expect(evaluatePmIntakeGate({ dataRoot: w.fixture.dataRoot, repoId: w.fixture.repoId, lease: w.lease }))
    .toMatchObject({ allowed: false, reasons: expect.arrayContaining(["impact_link_gap"]) });

  const assess = (revision: number) => w.plan.execute({ action: "assess-update", revision, assessmentId: uuidv7(),
    tasks: view.tasks.map((task) => ({ taskId: task.taskId, version: task.version, assessment: "unaffected", rationale: "未涉及登录" })),
    global: { assessment: "unaffected", rationale: "新增独立功能" } });
  const unread = await assess(3).catch((caught: unknown) => caught) as Error;
  expect(unread).toMatchObject({ code: "assessment_invalid" });
  expect(String(unread)).toContain("还没有完整读过到 revision 3 的差异");
  const [firstDiff, secondDiff] = await w.readDiffs([first!, second!]);
  expect(firstDiff).toContain("sprint 的行为");
  expect(secondDiff).toContain("jump 的行为");
  await expect(assess(2)).rejects.toMatchObject({ code: "assessment_invalid" });
  await assess(3);
  expect(evaluatePmIntakeGate({ dataRoot: w.fixture.dataRoot, repoId: w.fixture.repoId, lease: w.lease })).toEqual({ allowed: true });
  await new Promise((resolve) => setTimeout(resolve, 1_200));
  expect(w.diffPrompts()).toHaveLength(2);
});

test("主代理登记接手核对结论后，定时投递把结论告知 PM，每条结论只告知一次：未通过时转述问题，通过后告知可以正式规划", async () => {
  const w = await world({ review: false });
  const notices = () => w.provider.requests.map(text).filter((t) => t.includes("主代理核对你的接手理解未通过") || t.includes("主代理已核对通过你的接手理解"));
  await w.review({ result: "clarification_required", shortIssues: ["验收是否包含左向输入"] });
  await until(() => notices().length === 1);
  expect(notices()[0]).toContain("未通过（clarification_required）：验收是否包含左向输入");
  await w.review();
  await until(() => notices().length === 2);
  expect(notices()[1]).toContain("可以正式提出计划");
  await new Promise((resolve) => setTimeout(resolve, 1_200));
  expect(notices()).toHaveLength(2);
});

test("M7-AC1/AC5：PM 停止后不再向它投递；新 PM 须重新核对才建立自己的理解基线，之后差异只送达新会话，旧租约的复核被拒", async () => {
  const w = await world();
  expect(await w.manager.stop(w.pm.runId, { reason: "main_agent" })).toMatchObject({ confirmed: true });
  w.provider.queue.push({ type: "toolcall", name: PM_INTAKE_TOOL, input: { action: "ask", purpose: "pm-intake", understanding: w.understanding } }, { type: "text", text: "等待核对" });
  const before = w.provider.requests.length;
  const next = await w.manager.dispatchPm({ requirementId: w.fixture.requirementId, model: { provider: "team-model", id: "test" }, thinking: "off" });
  expect(next.fence).toBeGreaterThan(w.lease.fence);
  await until(() => w.provider.requests.length === before + 2);
  await new Promise((resolve) => setTimeout(resolve, 1_200));
  expect(w.owner().context.baseline).toBeNull();
  await w.review();
  await until(() => w.owner().context.baseline?.revision === 1);
  expect(w.owner().context.baseline).toMatchObject({ runId: next.runId, fence: next.fence });

  w.provider.queue.push({ type: "text", text: "新 PM 收到 r2" });
  const revision = await w.approve("sprint");
  await until(() => w.diffPrompts().length === 1);
  expect(w.diffPrompts()[0]!.systemPrompt).toContain(next.runId);
  await until(() => w.owner().context.baseline?.revision === revision);
  await expect(w.plan.execute({ action: "assess-update", revision, assessmentId: uuidv7(), tasks: [], global: { assessment: "unaffected", rationale: "旧" } }))
    .rejects.toBeTruthy();
  await new Promise((resolve) => setTimeout(resolve, 1_200));
  expect(w.diffPrompts()).toHaveLength(1);
});

const deliverySamples: number[] = [];

// 单个需求的交互上下文有上限，分四个需求各批准五次
test.each([1, 2, 3, 4])("M7 性能采样：第 %i 个需求批准五次并记录投递耗时", async () => {
  const w = await world();
  const view = await w.plan.execute({ action: "propose", tasks: [spec("login", "goal.login"), spec("failure", "scenario.failure")] }) as { tasks: Array<{ taskId: string; version: number }> };
  await w.plan.execute({ action: "confirm", planVersion: 1 });
  for (let i = 0; i < 5; i++) {
    w.provider.queue.push({ type: "text", text: `收到 ${i}` });
    const revision = await w.approve(`f${i}`, { replace: true });
    const start = performance.now();
    await until(() => w.diffPrompts().some((request) => text(request).includes(`→ ${revision}。`)), 1_000);
    deliverySamples.push(performance.now() - start);
    await until(() => w.owner().context.baseline?.revision === revision);
    await w.readDiffs([`revision ${revision - 1} → ${revision}`]);
    await w.plan.execute({ action: "assess-update", revision, assessmentId: uuidv7(),
      tasks: view.tasks.map((task) => ({ taskId: task.taskId, version: task.version, assessment: "unaffected", rationale: "附加章节不涉及登录" })),
      global: { assessment: "unaffected", rationale: "附加章节" } });
  }
});

test("M7 性能：已批准更新持久化后 95% 在 2 秒内投递到可运行且无积压的 PM", () => {
  expect(deliverySamples, "前 4 条采样测试没有全部跑完（例如用 -t 只跑了汇总这一条），汇总需要和它们一起跑").toHaveLength(20);
  const sorted = [...deliverySamples].sort((a, b) => a - b);
  const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1]!;
  expect(p95).toBeLessThanOrEqual(2_000);
});

test("M9：PM 暂停期间批准的新版本，恢复后照样送达准确差异并确认消费，PM 可据此复核", async () => {
  const w = await world();
  await w.plan.execute({ action: "propose", tasks: [spec("login", "goal.login"), spec("failure", "scenario.failure")] });
  await w.plan.execute({ action: "confirm", planVersion: 1 });
  await until(async () => (await w.manager.pause(w.pm.runId)).confirmed);
  const revision = await w.approve("animation");
  await new Promise((resolve) => setTimeout(resolve, 1_200));
  w.provider.queue.push({ type: "text", text: "收到恢复与差异" });
  await w.manager.resume(w.pm.runId);
  await until(() => w.diffPrompts().length === 1, 1_000);
  expect(text(w.diffPrompts()[0]!)).toContain(`revision 1 → ${revision}`);
  await until(() => w.owner().prodEvents?.understoodRevision === revision, 1_000);
}, 120_000);

test("M9：PM 带着运行中的 worker 被暂停，期间批准新版本，恢复后照样送达准确差异", async () => {
  const w = await world();
  const view = await w.plan.execute({ action: "propose", tasks: [spec("login", "goal.login"), spec("failure", "scenario.failure")] }) as { tasks: Array<{ taskId: string; key: string }> };
  await w.plan.execute({ action: "confirm", planVersion: 1 });
  w.provider.queue.push({ type: "text", text: "慢慢做", chunkDelayMs: 3_000 });
  const worker = await w.manager.dispatchTask({ pmRunId: w.pm.runId, taskId: view.tasks.find((task) => task.key === "login")!.taskId, retry: null });
  await until(async () => { const run = await w.runStore.get(worker.runId); return run.ok && run.run.state === "running"; }, 1_000);
  await until(async () => (await w.manager.pause(w.pm.runId)).confirmed, 1_000);
  const revision = await w.approve("animation");
  await new Promise((resolve) => setTimeout(resolve, 1_200));
  w.provider.queue.push({ type: "text", text: "收到恢复与差异" }, { type: "text", text: "继续" }, { type: "text", text: "继续" });
  await w.manager.resume(w.pm.runId);
  await until(() => w.diffPrompts().length === 1, 1_000);
  expect(text(w.diffPrompts()[0]!)).toContain(`revision 1 → ${revision}`);
}, 120_000);

test("M9：批准差异投递出错时，PM 收到哪一步失败、原因与建议，运行记录里也能查到；同一原因只报一次，恢复后照常送达并清掉原因", async () => {
  const w = await world();
  await w.plan.execute({ action: "propose", tasks: [spec("login", "goal.login"), spec("failure", "scenario.failure")] });
  await w.plan.execute({ action: "confirm", planVersion: 1 });
  const failing = vi.spyOn(RequirementEventService.prototype, "poll").mockRejectedValue(new Error("git diff 退出码 128"));
  w.provider.queue.push({ type: "text", text: "收到投递失败" }, { type: "text", text: "收到差异" });
  await w.approve("animation");
  const failures = () => w.provider.requests.map(text).filter((t) => t.includes("投递已批准的需求更新失败"));
  await until(() => failures().length === 1, 1_000);
  expect(failures()[0]).toContain("git diff 退出码 128");
  expect(failures()[0]).toContain("建议");
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  expect(failures()).toHaveLength(1);
  const reason = async () => { const run = await w.runStore.get(w.pm.runId); return run.ok ? run.run.stateReason ?? "" : ""; };
  expect(await reason()).toContain("git diff 退出码 128");
  failing.mockRestore();
  await until(() => w.diffPrompts().length === 1, 1_000);
  await until(async () => (await reason()) === "", 1_000);
}, 120_000);

test("墙上时钟前跳 1 小时（模拟合盖睡眠）后批准的新版本，照样送达通知，PM 用派出时绑定的工具照样能读差异并复核", async () => {
  const w = await world();
  await w.plan.execute({ action: "propose", tasks: [spec("login", "goal.login"), spec("failure", "scenario.failure")] });
  await w.plan.execute({ action: "confirm", planVersion: 1 });
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + 3_600_000);
  w.provider.queue.push({ type: "text", text: "收到差异" }, { type: "text", text: "继续" });
  const revision = await w.approve("animation");
  await until(() => w.diffPrompts().length === 1, 1_000);
  expect(text(w.diffPrompts()[0]!)).toContain(`revision 1 → ${revision}`);
  const reason = await w.runStore.get(w.pm.runId);
  expect(reason.ok && reason.run.stateReason).toBeFalsy();
  expect((await w.readDiffs([text(w.diffPrompts()[0]!)]))[0]).toContain("animation 的行为");
  expect(w.owner().context).toMatchObject({ diffRevision: revision });
}, 120_000);
