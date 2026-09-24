import { afterEach, expect, test, vi } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import type { Context } from "@earendil-works/pi-ai";
import { ModelRuntime, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { RelayQueue } from "../daemon/relay-queue.ts";
import { RunManager } from "../daemon/run-manager.ts";
import { createClock } from "../runtime/clock.ts";
import { repositoryDatabase, uuidv7, withDatabase } from "../runtime/database.ts";
import { NetworkPauseGate } from "../runtime/network-pause.ts";
import { createPlanManageTool } from "../runtime/plan-manage.ts";
import type { TaskSpec } from "../runtime/plan-manage.ts";
import { createPmIntakeProviders, evaluatePmIntakeGate, PM_INTAKE_TOOL } from "../runtime/pm-intake-runtime.ts";
import { defaultRoleDir, loadRoleCatalog } from "../runtime/roles.ts";
import { RunStore } from "../runtime/run-store.ts";
import { ShellRegistry } from "../runtime/shell-registry.ts";
import { registerControlledProvider } from "./helpers/controlled-provider.ts";
import { createPmIntakeFixture } from "./helpers/pm-intake-fixture.ts";

vi.setConfig({ testTimeout: 120_000 });
const cleanups: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });
const BASE = "# 手机号正常登录 {#goal.login}\n输入正确验证码后成功。\n# 验证码失败 {#scenario.failure}\n错误验证码显示失败。\n";
const NA = { applicable: false as const, reason: "无性能影响" };
async function until(check: () => boolean | Promise<boolean>, limit = 600): Promise<void> {
  for (let i = 0; i < limit; i++) { if (await check()) return; await new Promise((resolve) => setTimeout(resolve, 10)); }
  throw new Error("等待超时");
}
const text = (request: Context) => JSON.stringify(request.messages.at(-1) ?? "");

async function world(options: { review?: boolean } = {}) {
  const fixture = await createPmIntakeFixture(); cleanups.push(() => fixture.cleanup());
  const record = fixture.state.read(fixture.requirementId).data;
  const db = <T>(run: Parameters<typeof withDatabase<T>>[1]) => withDatabase(repositoryDatabase(fixture.dataRoot, fixture.repoId), run);
  db((d) => {
    const row = d.read<{ lease: { expiresAt: number } }>("pm_ownership", fixture.requirementId)!;
    d.update("pm_ownership", fixture.requirementId, row.version, { ...row.data, lease: { ...row.data.lease, expiresAt: Date.now() - 1 } });
    d.create("managed_workspaces", fixture.requirementId, { format: "managed-workspace/v1", requirementId: fixture.requirementId, operationId: uuidv7(),
      baseCommit: record.workspace!.baseCommit, branch: record.workspace!.branch, path: record.workspace!.path, status: "ready", recycleOperationId: null });
  });
  const captured = fixture.captureCurrent();
  const material = await fixture.submissionProvider.loadCurrent({ binding: captured.binding, sourceDirectoryHash: captured.sourceDirectoryHash,
    maxBytes: 49_152, signal: new AbortController().signal });
  const { format: _format, binding: _binding, ...understanding } = material!.understanding;
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, modelsStorePath: join(fixture.root, "models.json"), refreshOnCreate: false });
  const provider = registerControlledProvider(runtime, { providerId: "team-model", modelId: "test" });
  const clock = createClock(); cleanups.push(() => clock.stopGapWatcher());
  const runStore = new RunStore({ dataRoot: fixture.dataRoot, repoId: fixture.repoId, daemonStartedAt: new Date().toISOString() });
  const catalog = await loadRoleCatalog({ defaultDir: defaultRoleDir(), userDir: join(fixture.root, "none-u"), projectDir: join(fixture.root, "none-p"), parseFrontmatter, projectTrusted: false });
  const manager = new RunManager({ repositoryRoot: fixture.repositoryRoot, dataRoot: fixture.dataRoot, repoId: fixture.repoId, runStore,
    shellRegistry: new ShellRegistry({ clock, database: repositoryDatabase(fixture.dataRoot, fixture.repoId) }), networkGate: new NetworkPauseGate(),
    relayQueue: new RelayQueue({ dataDir: join(fixture.dataRoot, "repos", fixture.repoId), deliver: async () => [], locateRequirementAgent: () => undefined }),
    roleCatalog: catalog.roles, runtime, selectModel: () => { throw new Error("不应按旧规则选模型"); }, clock, workspaceRepoIds: [fixture.repoId], emit: vi.fn() });
  manager.markStarted();
  cleanups.push(async () => { for (const run of (await runStore.list({ limit: 100 })).items) await manager.stop(run.id).catch(() => {}); });

  provider.queue.push({ type: "toolcall", name: PM_INTAKE_TOOL, input: { action: "ask", purpose: "pm-intake", understanding } }, { type: "text", text: "等待核对" });
  const pm = await manager.dispatchPm({ requirementId: fixture.requirementId, model: { provider: "team-model", id: "test" }, thinking: "off" });
  await until(() => provider.requests.length === 2);
  const lease = fixture.state.pmOwner(fixture.requirementId)!.lease!;
  const owner = () => db((d) => d.read<{ context: { baseline: { revision: number } | null }; prodEvents?: { consumedSequence: number; understoodRevision: number | null } }>(
    "pm_ownership", fixture.requirementId)!.data);
  async function review() {
    const intake = fixture.makeIntake(createPmIntakeProviders(fixture.dataRoot));
    const view = await intake.openRequest(fixture.call, fixture.operationId());
    await intake.recordReview(fixture.call, view.requestId, fixture.operationId(), { result: "passed", shortIssues: [] });
  }
  if (options.review !== false) {
    await review();
    await until(() => owner().context.baseline?.revision === 1);
  }
  const plan = await createPlanManageTool({ repositoryRoot: fixture.repositoryRoot, dataRoot: fixture.dataRoot, authorize: () => true,
    grant: { role: "pm", callerId: uuidv7(), runId: lease.runId, requirementId: fixture.requirementId, repoId: fixture.repoId, workspaceId: lease.workspaceId, lease } });
  cleanups.push(() => plan.dispose());
  let body = BASE, goals = ["goal.login", "scenario.failure"];
  async function approve(key: string, options: { replace?: boolean } = {}) {
    if (options.replace) body = `${BASE}# 附加 {#goal.extra}\n${key} 的行为。\n`, goals = ["goal.login", "scenario.failure", "goal.extra"];
    else body += `# ${key} {#goal.${key}}\n${key} 的行为。\n`, goals = [...goals, `goal.${key}`];
    await fixture.approveRevision({ body, implementGoals: goals });
    return fixture.state.read(fixture.requirementId).data.revision;
  }
  const diffPrompts = () => provider.requests.filter((request) => text(request).includes("已批准更新：revision"));
  return { fixture, understanding, provider, manager, pm, lease, owner, review, plan, approve, diffPrompts };
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
