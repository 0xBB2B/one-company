import { afterEach, expect, test, vi } from "vitest";
import { join } from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import type { Context } from "@earendil-works/pi-ai";
import { ModelRuntime, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { RelayQueue } from "../daemon/relay-queue.ts";
import { RunManager } from "../daemon/run-manager.ts";
import { createClock } from "../runtime/clock.ts";
import { repositoryDatabase, uuidv7, withDatabase } from "../runtime/database.ts";
import { NetworkPauseGate } from "../runtime/network-pause.ts";
import { createPlanManageTool, TASKS } from "../runtime/plan-manage.ts";
import type { TaskSpec } from "../runtime/plan-manage.ts";
import { createPmIntakeProviders, PM_INTAKE_TOOL } from "../runtime/pm-intake-runtime.ts";
import { defaultRoleDir, loadRoleCatalog } from "../runtime/roles.ts";
import { RunStore } from "../runtime/run-store.ts";
import { ShellRegistry } from "../runtime/shell-registry.ts";
import { registerControlledProvider } from "./helpers/controlled-provider.ts";
import type { ScriptedReply } from "./helpers/controlled-provider.ts";
import { createPmIntakeFixture } from "./helpers/pm-intake-fixture.ts";

vi.setConfig({ testTimeout: 60_000 });
const cleanups: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });
const NA = { applicable: false as const, reason: "无性能影响" };
async function until(check: () => boolean | Promise<boolean>): Promise<void> {
  for (let i = 0; i < 600; i++) { if (await check()) return; await new Promise((resolve) => setTimeout(resolve, 25)); }
  throw new Error("等待超时");
}
function spec(key: string, patch: Partial<TaskSpec> = {}): TaskSpec {
  return { key, role: "worker", goalUnitIds: ["goal.login"], constraintUnitIds: [], dependsOn: [], writePaths: ["src/"], blockedByQuestionIds: [],
    maxTurns: 2, objective: `实现 ${key}`, passCriteria: ["可观察通过"], scope: { in: [key], out: ["微信登录"] }, performance: NA, ...patch };
}

async function world() {
  const fixture = await createPmIntakeFixture(); cleanups.push(() => fixture.cleanup());
  const record = fixture.state.read(fixture.requirementId).data;
  withDatabase(repositoryDatabase(fixture.dataRoot, fixture.repoId), (db) => {
    const row = db.read<{ lease: { expiresAt: number } }>("pm_ownership", fixture.requirementId)!;
    db.update("pm_ownership", fixture.requirementId, row.version, { ...row.data, lease: { ...row.data.lease, expiresAt: Date.now() - 1 } });
    db.create("managed_workspaces", fixture.requirementId, { format: "managed-workspace/v1", requirementId: fixture.requirementId, operationId: uuidv7(),
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
  const intake = fixture.makeIntake(createPmIntakeProviders(fixture.dataRoot));
  const view = await intake.openRequest(fixture.call, fixture.operationId());
  await intake.recordReview(fixture.call, view.requestId, fixture.operationId(), { result: "passed", shortIssues: [] });
  const lease = fixture.state.pmOwner(fixture.requirementId)!.lease!;
  const plan = await createPlanManageTool({ repositoryRoot: fixture.repositoryRoot, dataRoot: fixture.dataRoot, authorize: () => true,
    grant: { role: "pm", callerId: uuidv7(), runId: lease.runId, requirementId: fixture.requirementId, repoId: fixture.repoId, workspaceId: lease.workspaceId, lease } });
  cleanups.push(() => plan.dispose());
  const task = (key: string) => withDatabase(repositoryDatabase(fixture.dataRoot, fixture.repoId), (db) =>
    db.list<{ key: string; taskId: string; status: string; attempts: Array<{ outcome: string; turnsUsed: number; maxTurns: number; reason: string | null }> }>(TASKS)
      .map((row) => row.data).find((entry) => entry.key === key)!);
  const dispatch = (key: string, retry: { reason: string; maxTurns: number } | null = null) => manager.dispatchTask({ pmRunId: pm.runId, taskId: task(key).taskId, retry });
  return { fixture, provider, runStore, manager, pm, plan, task, dispatch };
}
const read = (n: number): ScriptedReply => ({ type: "toolcall", name: "read", input: { path: `README.md#${n}` } });
const lastPrompt = (request: Context | undefined) => JSON.stringify(request?.messages.at(-1) ?? "");

test("M7-AC27/28/29/30：到限自动上报 PM；重试须带原因且只有一次，再未完成即等待用户裁决", async () => {
  const w = await world();
  await w.plan.execute({ action: "propose", tasks: [spec("login"), spec("failure", { goalUnitIds: ["scenario.failure"] })] });
  await w.plan.execute({ action: "confirm", planVersion: 1 });

  const before = w.provider.requests.length;
  w.provider.queue.push(read(1), read(2), { type: "text", text: "PM 收到到限报告" });
  const first = await w.dispatch("login");
  expect(first.maxTurns).toBe(2);
  await until(() => w.task("login").status === "awaiting_parent");
  await until(() => w.provider.requests.length === before + 3);
  expect(w.task("login").attempts).toEqual([{ runId: first.runId, maxTurns: 2, turnsUsed: 2, reason: null, outcome: "turn_limit_reached" }]);
  expect(lastPrompt(w.provider.requests.at(-1))).toContain("turn_limit_reached");
  expect(await w.runStore.get(first.runId)).toMatchObject({ ok: true, run: { state: "failed", parentRunId: w.pm.runId, role: "pi-company.worker" } });

  await expect(w.dispatch("login")).rejects.toMatchObject({ code: "retry_required" });
  w.provider.queue.push(read(4), read(5), read(6), { type: "text", text: "PM 收到第二次到限" });
  const second = await w.dispatch("login", { reason: "轮次估计不足", maxTurns: 3 });
  await until(() => w.task("login").status === "awaiting_user");
  expect(w.task("login").attempts[1]).toMatchObject({ runId: second.runId, maxTurns: 3, turnsUsed: 3, reason: "轮次估计不足", outcome: "turn_limit_reached" });
  await expect(w.dispatch("login", { reason: "再试一次", maxTurns: 5 })).rejects.toMatchObject({ code: "task_not_ready" });
  await expect(w.plan.execute({ action: "update", planVersion: 1, add: [spec("login-again")] })).rejects.toMatchObject({ code: "task_not_ready" });
  await expect(w.dispatch("failure", { reason: "无需重试", maxTurns: 2 })).rejects.toMatchObject({ code: "retry_not_needed" });
});

test("M7-AC26/AC31：worker 在额度内提交工作报告即完成；依赖未完成、计划未冻结时拒绝派工", async () => {
  const w = await world();
  await w.plan.execute({ action: "propose", tasks: [spec("login"), spec("failure", { goalUnitIds: ["scenario.failure"], dependsOn: ["login"] })] });
  await expect(w.dispatch("login")).rejects.toMatchObject({ code: "plan_not_confirmed" });
  await w.plan.execute({ action: "confirm", planVersion: 1 });
  await expect(w.dispatch("failure")).rejects.toMatchObject({ code: "dependency_pending" });
  const login = w.task("login");
  w.provider.queue.push({ type: "toolcall", name: "pi_company_result_submit", input: { action: "verdict", result: { checkRoundId: null, verificationIds: [],
    summary: `完成 ${login.key}`, findings: [] } } }, { type: "text", text: "PM 收到完成结果" });
  const run = await w.dispatch("login");
  await until(() => w.task("login").status === "completed");
  expect(await w.runStore.get(run.runId)).toMatchObject({ ok: true, run: { state: "completed" } });
  const workerRequest = w.provider.requests.find((request) => request.systemPrompt?.includes("任务：login"))!;
  expect(workerRequest.tools?.map((tool) => tool.name).sort()).toEqual(["find", "grep", "ls", "pi_company_change_apply", "pi_company_result_submit",
    "pi_company_verification_run", "read"]);
  expect(workerRequest.systemPrompt).toContain("对话轮次上限：2");
});
