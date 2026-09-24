import { afterEach, expect, test, vi } from "vitest";
import { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { repositoryDatabase, uuidv7, withDatabase } from "../runtime/database.ts";
import { HostAuthorizationManager } from "../runtime/host-authorization.ts";
import { MainRequirementInteraction } from "../runtime/main-requirement-interaction.ts";
import { TASKS } from "../runtime/plan-manage.ts";
import type { TaskRecord, TaskSpec } from "../runtime/plan-manage.ts";
import { createUserInteractTool } from "../runtime/user-interact-tool.ts";
import { checkInterpretation } from "../runtime/user-interaction-format.ts";
import type { InteractionContext } from "../runtime/user-interaction-format.ts";
import { RequirementCloseService } from "../runtime/workflow-close.ts";
import { createPmRunWorld, until } from "./helpers/run-manager-fixture.ts";

vi.setConfig({ testTimeout: 90_000 });
const cleanups: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });
const NA = { applicable: false as const, reason: "无性能影响" };
const spec = (key: string, goal: string, patch: Partial<TaskSpec> = {}): TaskSpec => ({ key, role: "worker", goalUnitIds: [goal], constraintUnitIds: [], dependsOn: [],
  writePaths: ["src/"], blockedByQuestionIds: [], maxTurns: 1, objective: `实现 ${key}`, passCriteria: ["可观察通过"], scope: { in: [key], out: [] }, performance: NA, ...patch });

/** PM 两次派出 login 均到限，任务进入待用户裁决；主窗口以宿主截获的原话经脚本化解释器登记决定。 */
async function world() {
  const w = await createPmRunWorld(cleanups);
  await w.plan.execute({ action: "propose", tasks: [spec("login", "goal.login"), spec("failure", "scenario.failure")] });
  await w.plan.execute({ action: "confirm", planVersion: 1 });
  const task = (key: string) => w.db((db) => db.list<TaskRecord>(TASKS).map((row) => row.data).find((entry) => entry.key === key)!);
  const taskRow = (key: string) => w.db((db) => db.read<TaskRecord>(TASKS, task(key).taskId)!);
  const login = task("login").taskId;
  w.provider.queue.push({ type: "toolcall", name: "read", input: { path: "README.md" } }, { type: "text", text: "PM 看到到限" });
  await w.manager.dispatchTask({ pmRunId: w.pm.runId, taskId: login, retry: null });
  await until(() => task("login").status === "awaiting_parent" && w.provider.queue.length === 0);
  w.provider.queue.push({ type: "toolcall", name: "read", input: { path: "README.md" } }, { type: "text", text: "PM 看到第二次到限" });
  await w.manager.dispatchTask({ pmRunId: w.pm.runId, taskId: login, retry: { reason: "估计不足", maxTurns: 1 } });
  await until(() => task("login").status === "awaiting_user" && w.provider.queue.length === 0);

  const sessionId = uuidv7(), windowId = uuidv7();
  const authorization = new HostAuthorizationManager({ dataRoot: w.fixture.dataRoot });
  authorization.startWindow({ kind: "main", windowId, sessionId, repoIds: [w.fixture.repoId] });
  authorization.bindRequirement(w.fixture.repoId, w.fixture.requirementId, sessionId);
  const registry = new ModelRegistry(w.runtime), model = w.runtime.getModels("team-model")[0]!;
  const ctx = { cwd: w.fixture.repositoryRoot, mode: "tui", hasUI: true, modelRegistry: registry, model,
    ui: { notify: () => {}, confirm: () => { throw new Error("UI.confirm forbidden"); } }, sessionManager: { getSessionId: () => sessionId } } as unknown as ExtensionContext;
  const interaction = new MainRequirementInteraction({ dataRoot: w.fixture.dataRoot, authorization,
    resolveHost: () => ({ windowId, sessionId, repositories: new Map([[w.fixture.repoId, { path: w.fixture.repositoryRoot }]]) }) });
  cleanups.push(() => { interaction.dispose(); authorization.shutdown(); });
  const tool = createUserInteractTool({ interaction });
  const itemId = `task:${login}`;
  const version = () => `task:${login}:${taskRow("login").version}`;
  const entry = (references: string[], patch: Record<string, unknown> = {}) => ({ kind: "adjudication", basis: "explicit", resolution: "direct", candidateId: null,
    requestId: null, actions: [], conclusion: "用户对任务 login 的裁决", scope: "任务 login", references, supersedes: [], ...patch });
  async function adjudicate(text: string, entries: unknown[] | null) {
    interaction.captureInput({ source: "interactive", text }, ctx);
    if (entries) w.provider.queue.push({ type: "text", text: JSON.stringify({ format: "interaction-interpretation/v1", referenceResolution: "none", entries }) });
    const toolCallId = uuidv7();
    const result = await tool.execute(toolCallId, { purpose: "adjudicate", action: "reply", repoId: w.fixture.repoId, requirementId: w.fixture.requirementId,
      operationId: uuidv7(), itemId } as never, undefined, undefined, ctx);
    interaction.assertDelivery(toolCallId, ctx);
    return result.details as Record<string, unknown>;
  }
  const decisions = () => w.db((db) => db.list("short_decisions")).length;
  return { ...w, task, login, itemId, version, entry, adjudicate, decisions, interaction, ctx };
}

test("M7-AC35：用户原话选择再给一次机会时登记用户决定，任务回到可派出，事项从概览消失，PM 收到固定告知，按用户上限派出且不能带 retry", async () => {
  const w = await world();
  expect((await w.manager.overviews())[0]!.pendingItems.map((item) => item.itemId)).toEqual([w.itemId]);
  const result = await w.adjudicate("再给它一次机会，这次给 3 轮", [w.entry([`item:${w.itemId}`, `version:${w.version()}`, "choice:retry", "max-turns:3"])]);
  w.provider.queue.push({ type: "text", text: "PM 收到用户决定" });
  expect(result).toMatchObject({ status: "recorded", choice: "retry", maxTurns: 3, taskStatus: "pending" });
  expect(w.task("login").userDecision).toMatchObject({ choice: "retry", maxTurns: 3, usedByRunId: null });
  await until(async () => (await w.manager.overviews())[0]!.pendingItems.length === 0);
  await until(() => w.provider.requests.some((request) => JSON.stringify(request.messages.at(-1) ?? "").includes("再给一次机会，轮数上限 3")));

  await expect(w.manager.dispatchTask({ pmRunId: w.pm.runId, taskId: w.login, retry: { reason: "PM 想多给", maxTurns: 9 } })).rejects.toMatchObject({ code: "retry_not_needed" });
  w.provider.queue.push({ type: "text", text: "第三次" }, { type: "text", text: "PM 收到" });
  const third = await w.manager.dispatchTask({ pmRunId: w.pm.runId, taskId: w.login, retry: null });
  expect(third.maxTurns).toBe(3);
  expect(w.task("login").userDecision?.usedByRunId).toBe(third.runId);
});

test("M7-AC35：解释器引用了错误版本、用户没说清或没有当前原话时都不登记，任务仍待裁决", async () => {
  const w = await world();
  const before = w.decisions();
  await expect(w.adjudicate("再给一次，3 轮", [w.entry([`item:${w.itemId}`, `version:${w.itemId}:999`, "choice:retry", "max-turns:3"])])).rejects.toThrow();
  await expect(w.adjudicate("再给一次机会", [w.entry([`item:${w.itemId}`, `version:${w.version()}`, "choice:retry"])])).rejects.toThrow();
  const unclear = await w.adjudicate("嗯我再想想", [{ ...w.entry([]), kind: "unresolved", basis: "uncertain", references: [] }]);
  expect(unclear).toMatchObject({ status: "unclear" });
  w.interaction.revoke();
  const toolCallId = uuidv7();
  await expect(createUserInteractTool({ interaction: w.interaction }).execute(toolCallId, { purpose: "adjudicate", action: "reply", repoId: w.fixture.repoId,
    requirementId: w.fixture.requirementId, operationId: uuidv7(), itemId: w.itemId } as never, undefined, undefined, w.ctx)).rejects.toThrow();
  expect(w.decisions()).toBe(before);
  expect(w.task("login").status).toBe("awaiting_user");
});

test("M7-AC35：终止任务后任务取消，其目标仍在实施授权内时交付核对阻塞完成关闭", async () => {
  const w = await world();
  const result = await w.adjudicate("这个任务别做了，终止", [w.entry([`item:${w.itemId}`, `version:${w.version()}`, "choice:terminate"])]);
  w.provider.queue.push({ type: "text", text: "PM 收到用户决定" });
  expect(result).toMatchObject({ status: "recorded", choice: "terminate", taskStatus: "cancelled" });
  const close = await RequirementCloseService.open({ repositoryRoot: w.fixture.repositoryRoot, dataRoot: w.fixture.dataRoot, repoId: w.fixture.repoId, authorize: () => true });
  cleanups.push(() => close.dispose());
  expect((await close.deliveryCheck(w.fixture.requirementId)).blockers).toContain("terminated_goal_in_scope");
  const planVersion = w.db((db) => db.read<{ planVersion: number }>("plans", w.fixture.requirementId)!.data.planVersion);
  await expect(w.plan.execute({ action: "update", planVersion, add: [spec("login-again", "goal.login")] })).rejects.toMatchObject({ code: "task_not_ready" });
  await expect(w.plan.execute({ action: "update", planVersion, modify: [{ taskId: w.login, version: w.task("login").version, spec: spec("login", "goal.login") }] }))
    .rejects.toMatchObject({ code: "task_not_ready" });
});

test("M7-AC35：调整目标或范围后须等新的批准版本才能按新范围修改任务，修改后可再派出一次", async () => {
  const w = await world();
  const result = await w.adjudicate("先改需求范围，短信用测试桩", [w.entry([`item:${w.itemId}`, `version:${w.version()}`, "choice:adjust"])]);
  expect(result).toMatchObject({ status: "recorded", choice: "adjust", taskStatus: "needs_update" });
  w.provider.queue.push({ type: "text", text: "PM 收到调整决定" }, { type: "text", text: "PM 收到新版本差异" });
  await until(() => w.provider.queue.length === 1);
  const planVersion = () => w.db((db) => db.read<{ planVersion: number }>("plans", w.fixture.requirementId)!.data.planVersion);
  const modify = () => w.plan.execute({ action: "update", planVersion: planVersion(), modify: [{ taskId: w.login, version: w.task("login").version,
    spec: spec("login", "goal.stub", { objective: "用测试桩实现登录" }) }] });
  await expect(modify()).rejects.toMatchObject({ code: "task_not_ready" });

  await w.fixture.approveRevision({ body: "# 手机号正常登录 {#goal.login}\n输入正确验证码后成功。\n# 验证码失败 {#scenario.failure}\n错误验证码显示失败。\n# 测试桩登录 {#goal.stub}\n短信用测试桩。\n",
    implementGoals: ["goal.stub", "scenario.failure"] });
  await until(() => w.owner().context.baseline?.revision === 2);
  await w.plan.execute({ action: "assess-update", revision: 2, assessmentId: uuidv7(), tasks: [
    { taskId: w.login, version: w.task("login").version, assessment: "affected", rationale: "登录目标改为测试桩" },
    { taskId: w.task("failure").taskId, version: w.task("failure").version, assessment: "unaffected", rationale: "失败场景不变" }],
    global: { assessment: "unaffected", rationale: "无全局变化" } });
  await expect(w.plan.execute({ action: "update", planVersion: planVersion(), add: [spec("login-again", "goal.login")] })).rejects.toMatchObject({ code: "task_not_ready" });
  await modify();
  await w.plan.execute({ action: "confirm", planVersion: planVersion() });
  w.provider.queue.push({ type: "text", text: "按新范围做" }, { type: "text", text: "PM 收到" });
  const next = await w.manager.dispatchTask({ pmRunId: w.pm.runId, taskId: w.login, retry: null });
  expect(next.maxTurns).toBe(1);
  expect(w.task("login")).toMatchObject({ goalUnitIds: ["goal.stub"], userDecision: { choice: "adjust", usedByRunId: next.runId } });
});

test("裁决引用前缀只能出现在裁决条目里，裁决条目必须对应宿主给出的事项", () => {
  const context = { basis: { requirementId: uuidv7(), version: 1, epoch: 1, prod: null }, currentGoal: "", candidates: [], questions: [], priorDecisions: [] } as InteractionContext;
  const taskId = uuidv7(), subject = { itemId: `task:${taskId}`, version: `task:${taskId}:3`, summary: "尝试记录" };
  const interpretation = (entry: Record<string, unknown>) => JSON.stringify({ format: "interaction-interpretation/v1", referenceResolution: "none", entries: [entry] });
  const base = { kind: "adjudication", basis: "explicit", resolution: "direct", candidateId: null, requestId: null, actions: [], conclusion: "裁决", scope: "任务", supersedes: [] };
  const refs = [`item:${subject.itemId}`, `version:${subject.version}`, "choice:terminate"];
  expect(() => checkInterpretation(interpretation({ ...base, references: refs }), context)).toThrow(/adjudication_invalid/);
  expect(() => checkInterpretation(interpretation({ ...base, references: refs }), { ...context, adjudication: subject })).not.toThrow();
  expect(() => checkInterpretation(interpretation({ ...base, kind: "target", references: refs }), { ...context, adjudication: subject })).toThrow(/adjudication_reference_reserved/);
  expect(() => checkInterpretation(interpretation({ ...base, references: [...refs, "max-turns:3"] }), { ...context, adjudication: subject })).toThrow(/adjudication_invalid/);
  expect(() => checkInterpretation(interpretation({ ...base, basis: "proposed", references: refs }), { ...context, adjudication: subject })).toThrow(/adjudication_invalid/);
});

test("M7-AC35：用户给了再一次机会后 PM 修改任务，用户的机会随之失效，不能用在改过的任务上", async () => {
  const w = await world();
  await w.adjudicate("再给一次，3 轮", [w.entry([`item:${w.itemId}`, `version:${w.version()}`, "choice:retry", "max-turns:3"])]);
  w.provider.queue.push({ type: "text", text: "PM 收到用户决定" });
  await until(() => w.task("login").userDecision?.notified === true);
  const planVersion = w.db((db) => db.read<{ planVersion: number }>("plans", w.fixture.requirementId)!.data.planVersion);
  await w.plan.execute({ action: "update", planVersion, modify: [{ taskId: w.login, version: w.task("login").version,
    spec: spec("login", "goal.login", { writePaths: ["src/", "config/"] }) }] });
  await w.plan.execute({ action: "confirm", planVersion: planVersion + 1 });
  await expect(w.manager.dispatchTask({ pmRunId: w.pm.runId, taskId: w.login, retry: null })).rejects.toMatchObject({ code: "retry_exhausted" });
});

test("M7-AC35：解释结果除裁决外还夹带其他条目时整体不登记", async () => {
  const w = await world();
  const before = w.decisions();
  const result = await w.adjudicate("再给一次 3 轮，另外登录也要支持微信", [w.entry([`item:${w.itemId}`, `version:${w.version()}`, "choice:retry", "max-turns:3"]),
    { ...w.entry([]), kind: "target", conclusion: "支持微信登录", references: [] }]);
  expect(result).toMatchObject({ status: "unclear" });
  expect(w.decisions()).toBe(before);
  expect(w.task("login").status).toBe("awaiting_user");
});

