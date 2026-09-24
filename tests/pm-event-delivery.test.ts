import { afterEach, expect, test, vi } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Context } from "@earendil-works/pi-ai";
import { uuidv7 } from "../runtime/database.ts";
import type { TaskSpec } from "../runtime/plan-manage.ts";
import { evaluatePmIntakeGate, PM_INTAKE_TOOL } from "../runtime/pm-intake-runtime.ts";
import { createPmRunWorld, until } from "./helpers/run-manager-fixture.ts";

vi.setConfig({ testTimeout: 120_000 });
const cleanups: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });
const BASE = "# 手机号正常登录 {#goal.login}\n输入正确验证码后成功。\n# 验证码失败 {#scenario.failure}\n错误验证码显示失败。\n";
const NA = { applicable: false as const, reason: "无性能影响" };
const text = (request: Context) => JSON.stringify(request.messages.at(-1) ?? "");

async function world(options: { review?: boolean } = {}) {
  const w = await createPmRunWorld(cleanups, options);
  let body = BASE, goals = ["goal.login", "scenario.failure"];
  async function approve(key: string, approveOptions: { replace?: boolean } = {}) {
    if (approveOptions.replace) body = `${BASE}# 附加 {#goal.extra}\n${key} 的行为。\n`, goals = ["goal.login", "scenario.failure", "goal.extra"];
    else body += `# ${key} {#goal.${key}}\n${key} 的行为。\n`, goals = [...goals, `goal.${key}`];
    await w.fixture.approveRevision({ body, implementGoals: goals });
    return w.fixture.state.read(w.fixture.requirementId).data.revision;
  }
  const diffPrompts = () => w.provider.requests.filter((request) => text(request).includes("已批准更新：revision"));
  return { ...w, approve, diffPrompts };
}

function spec(key: string, goal: string): TaskSpec {
  return { key, role: "worker", goalUnitIds: [goal], constraintUnitIds: [], dependsOn: [], writePaths: ["src/"], blockedByQuestionIds: [],
    maxTurns: 5, objective: `实现 ${goal}`, passCriteria: [`${goal} 可观察通过`], scope: { in: [goal], out: ["微信登录"] }, performance: NA };
}

test("M7-AC1：主代理核对通过前不建立理解基线也不投递差异；通过后按序送达准确差异并确认消费，PM 据此复核", async () => {
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
  expect(first).toContain("sprint 的行为");
  expect(second).toContain("revision 2 → 3");
  expect(second).toContain("jump 的行为");
  await until(() => w.owner().context.baseline?.revision === 3);
  expect(w.owner().prodEvents?.understoodRevision).toBe(3);

  const assess = (revision: number) => w.plan.execute({ action: "assess-update", revision, assessmentId: uuidv7(),
    tasks: view.tasks.map((task) => ({ taskId: task.taskId, version: task.version, assessment: "unaffected", rationale: "未涉及登录" })),
    global: { assessment: "unaffected", rationale: "新增独立功能" } });
  await expect(assess(2)).rejects.toMatchObject({ code: "assessment_invalid" });
  await assess(3);
  expect(evaluatePmIntakeGate({ dataRoot: w.fixture.dataRoot, repoId: w.fixture.repoId, lease: w.lease })).toEqual({ allowed: true });
  await new Promise((resolve) => setTimeout(resolve, 1_200));
  expect(w.diffPrompts()).toHaveLength(2);
});

test("M7-AC1/AC5：PM 停止后不再向它投递；新 PM 须重新核对才建立自己的理解基线，之后差异只送达新会话，旧租约的复核被拒", async () => {
  const w = await world();
  expect(await w.manager.stop(w.pm.runId)).toMatchObject({ confirmed: true });
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

test("M7 性能：已批准更新持久化后 95% 在 2 秒内投递到可运行且无积压的 PM", async () => {
  const samples: number[] = [];
  // 单个需求的交互上下文有上限，分四个需求各批准五次
  for (let round = 0; round < 4; round++) {
    const w = await world();
    const view = await w.plan.execute({ action: "propose", tasks: [spec("login", "goal.login"), spec("failure", "scenario.failure")] }) as { tasks: Array<{ taskId: string; version: number }> };
    await w.plan.execute({ action: "confirm", planVersion: 1 });
    for (let i = 0; i < 5; i++) {
      w.provider.queue.push({ type: "text", text: `收到 ${i}` });
      const revision = await w.approve(`f${i}`, { replace: true });
      const start = performance.now();
      await until(() => w.diffPrompts().some((request) => text(request).includes(`→ ${revision}（`)), 1_000);
      samples.push(performance.now() - start);
      await until(() => w.owner().context.baseline?.revision === revision);
      await w.plan.execute({ action: "assess-update", revision, assessmentId: uuidv7(),
        tasks: view.tasks.map((task) => ({ taskId: task.taskId, version: task.version, assessment: "unaffected", rationale: "附加章节不涉及登录" })),
        global: { assessment: "unaffected", rationale: "附加章节" } });
    }
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1]!;
  await mkdir(join(process.cwd(), ".bb-spec", ".cache", "m7"), { recursive: true });
  await writeFile(join(process.cwd(), ".bb-spec", ".cache", "m7", "event-latency.json"), JSON.stringify({ samples, p95 }, null, 2));
  expect(samples).toHaveLength(20);
  expect(p95).toBeLessThanOrEqual(2_000);
});
