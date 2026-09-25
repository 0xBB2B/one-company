import { afterEach, expect, test, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Context } from "@earendil-works/pi-ai";
import { activeCheckRoundIn, CHECK_ROUNDS } from "../runtime/check-round.ts";
import { uuidv7 } from "../runtime/database.ts";
import { TASKS } from "../runtime/plan-manage.ts";
import type { TaskRecord, TaskSpec } from "../runtime/plan-manage.ts";
import { VERDICTS } from "../runtime/verdicts.ts";
import type { Verdict } from "../runtime/verdicts.ts";
import type { DeliveryReceipt } from "../runtime/workflow-close.ts";
import type { ScriptedReply } from "./helpers/controlled-provider.ts";
import { createPmRunWorld, until } from "./helpers/run-manager-fixture.ts";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 60_000 });
const cleanups: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });
const NA = { applicable: false as const, reason: "无性能影响" };
const UNITS = ["goal.login", "scenario.failure"];
const spec = (key: string, role: TaskSpec["role"], patch: Partial<TaskSpec> = {}): TaskSpec => ({ key, role, goalUnitIds: UNITS, constraintUnitIds: [], dependsOn: [],
  writePaths: [], blockedByQuestionIds: [], maxTurns: 4, objective: `${key} 覆盖手机号登录与验证码失败`, passCriteria: ["正确验证码登录成功，错误验证码显示失败"],
  scope: { in: ["手机号登录"], out: ["微信登录"] }, performance: NA, ...patch });
const LOGIN = "export function login(code: string): string {\n  return code === \"1234\" ? \"成功\" : \"失败\";\n}\n";

type Step = ScriptedReply | ((request: Context) => ScriptedReply);
const call = (name: string, input: Record<string, unknown>): ScriptedReply => ({ type: "toolcall", name: `pi_company_${name}`, input });
const lastResult = (request: Context) => JSON.stringify(request.messages.at(-1) ?? "");
const field = (text: string, name: string) => new RegExp(`\\\\"${name}\\\\":\\\\"([0-9a-f-]{36})\\\\"`).exec(text)?.[1];

/**
 * 同一个脚本化模型服务 PM 与多个并行子代理：按系统提示里的任务 key 把请求分给各自的脚本，
 * 子代理脚本的一步可以读取上一步的真实工具结果（例如正式验证编号）再给出调用。
 */
function routeReplies(provider: { queue: ScriptedReply[]; requests: Context[] }, pm: (request: Context) => ScriptedReply) {
  const scripts = new Map<string, Step[]>();
  provider.queue.shift = () => {
    const request = provider.requests.at(-1)!;
    const key = /任务：([A-Za-z0-9._-]+)（/.exec(request.systemPrompt ?? "")?.[1];
    if (key === undefined) return pm(request);
    const step = scripts.get(key)?.shift();
    return typeof step === "function" ? step(request) : step;
  };
  return (key: string, ...steps: Step[]) => scripts.set(key, steps);
}

test.skipIf(process.platform !== "darwin")("M7-AC19：零自定义下默认六职责团队完成接手、规划、实现、独立审查、QA 与完成关闭，全程不用 explore 规划", async () => {
  const w = await createPmRunWorld(cleanups, { review: false, authorizeClose: true });
  const requirementId = w.fixture.requirementId;
  const tasks = () => w.db((db) => db.list<TaskRecord>(TASKS).map((row) => row.data));
  const task = (key: string) => tasks().find((entry) => entry.key === key)!;
  const rounds = () => w.db((db) => db.list<{ requirementId: string; checkRoundId: string; status: string }>(CHECK_ROUNDS).map((row) => row.data)
    .filter((round) => round.requirementId === requirementId));
  const openRound = () => w.db((db) => activeCheckRoundIn(db, w.fixture.repoId, requirementId)?.data.checkRoundId ?? null);

  const pmActions: string[] = [];
  const once = (action: string, reply: ScriptedReply) => { pmActions.push(action); return reply; };
  const script = routeReplies(w.provider, () => {
    if (task("impl")?.status === "completed" && rounds().length === 0 && !pmActions.includes("advance")) return once("advance", call("workflow_manage", { action: "advance" }));
    const round = openRound();
    for (const key of ["review", "acceptance"]) {
      if (round && task(key).status === "pending" && !pmActions.includes(key)) return once(key, call("agent_manage", { action: "dispatch", taskId: task(key).taskId }));
    }
    if (round && task("review").status === "completed" && task("acceptance").status === "completed" && !pmActions.includes("finish")) {
      return once("finish", call("workflow_manage", { action: "finish", checkRoundId: round }));
    }
    return { type: "text", text: "PM 已核对" };
  });

  await w.review();
  await until(() => w.owner().context.baseline?.revision === 1);

  await w.plan.execute({ action: "propose", tasks: [
    spec("impl", "worker", { writePaths: ["src/"], objective: "实现手机号验证码登录：正确验证码成功，错误验证码失败" }),
    spec("review", "reviewer", { dependsOn: ["impl"], objective: "独立审查登录实现是否满足已批准目标" }),
    spec("acceptance", "qa", { dependsOn: ["impl"], objective: "黑盒验收正常登录与验证码失败场景" }),
  ] });
  await w.plan.execute({ action: "confirm", planVersion: 1 });
  await expect(w.manager.dispatchTask({ pmRunId: w.pm.runId, taskId: task("review").taskId, retry: null })).rejects.toMatchObject({ code: "dependency_pending" });

  script("impl",
    call("change_apply", { action: "apply", operationId: uuidv7(), files: [{ path: "src/login.ts", baseHash: "absent", content: LOGIN }] }),
    call("result_submit", { action: "verdict", result: { checkRoundId: null, verificationIds: [], summary: "新增 src/login.ts 实现验证码登录", findings: [] } }));
  const formalThenVerdict = (command: string, summary: string): Step[] => [
    call("verification_run", { action: "run", kind: "formal", command, performance: NA }),
    (request) => {
      const result = lastResult(request);
      return call("result_submit", { action: "verdict", result: { checkRoundId: field(result, "checkRoundId"), verificationIds: [field(result, "verificationId")], summary,
        findings: [{ kind: "suggestion", targetRef: "prod:goal.login", evidenceRef: null, trigger: "输入验证码", impact: "可补充更多用例" }] } });
    },
  ];
  script("review", ...formalThenVerdict("test -f src/login.ts", "实现符合已批准目标"));
  script("acceptance", ...formalThenVerdict("grep -q 失败 src/login.ts", "正常登录与验证码失败场景均可观察"));

  const worker = await w.manager.dispatchTask({ pmRunId: w.pm.runId, taskId: task("impl").taskId, retry: null });
  await until(() => task("impl").status === "completed");
  await expect(readFile(join(w.fixture.state.read(requirementId).data.workspace!.path, "src", "login.ts"), "utf8")).resolves.toBe(LOGIN);

  await until(() => pmActions.includes("finish") && rounds()[0]?.status === "released", 3_000);
  const receipt = await w.manager.workflowManage(requirementId, { action: "delivery-check" }) as DeliveryReceipt;
  expect(receipt).toMatchObject({ deliverable: true, blockers: [], suggestions: 2 });
  const closed = await w.manager.workflowManage(requirementId, { action: "close", reason: "completed", receiptId: receipt.receiptId, operationId: uuidv7() });
  expect(closed).toMatchObject({ status: "closed", reason: "completed", archive: { status: "archived" } });
  expect(w.fixture.state.read(requirementId).data).toMatchObject({ lifecycle: "closed", close: { reason: "completed" } });

  expect(pmActions).toEqual(["advance", "review", "acceptance", "finish"]);
  const runs = (await w.runStore.list({ requirement: requirementId, limit: 100 })).items;
  const all = await Promise.all(runs.map(async (run) => { const got = await w.runStore.get(run.id); if (!got.ok) throw new Error(got.reason); return got.run; }));
  expect(all.every((run) => run.agent?.source === "default")).toBe(true);
  const rejected = all.filter((run) => run.state === "failed");
  expect(rejected.map((run) => [run.task, run.stateReason])).toEqual([[task("review").taskId, "dependency_pending"]]);
  const full = all.filter((run) => run.state !== "failed");
  const byTask = (key: string) => full.find((run) => run.task === task(key).taskId)!;
  expect(full.map((run) => [run.role ?? run.kind, run.agent?.name, run.agent?.source]).sort()).toEqual([
    ["pi-company.qa", "qa", "default"], ["pi-company.reviewer", "reviewer", "default"], ["pi-company.worker", "worker", "default"], ["requirement", "pm", "default"]]);
  expect(full.every((run) => run.state === "completed" || run.state === "stopped")).toBe(true);
  const [implRun, reviewRun, qaRun] = [byTask("impl"), byTask("review"), byTask("acceptance")];
  expect(implRun.id).toBe(worker.runId);
  expect(new Set([w.pm.runId, implRun.id, reviewRun.id, qaRun.id]).size).toBe(4);
  expect([implRun, reviewRun, qaRun].map((run) => run.parentRunId)).toEqual([w.pm.runId, w.pm.runId, w.pm.runId]);
  const verdicts = w.db((db) => db.list<Verdict>(VERDICTS).map((row) => row.data));
  expect(verdicts.map((verdict) => [verdict.role, verdict.runId, verdict.conclusion]).sort()).toEqual([
    ["qa", qaRun.id, "clear"], ["reviewer", reviewRun.id, "clear"], ["worker", implRun.id, "clear"]].sort());
  expect(tasks().map((entry) => [entry.key, entry.role, entry.status]).sort()).toEqual([
    ["acceptance", "qa", "completed"], ["impl", "worker", "completed"], ["review", "reviewer", "completed"]]);
  expect(full.some((run) => run.role === "pi-company.explore")).toBe(false);
  const systemPrompts = w.provider.requests.map((request) => request.systemPrompt ?? "");
  for (const persona of ["你是一个活动需求的唯一 PM", "你是实现代理", "你是独立审查代理", "你是黑盒验收代理"]) expect(systemPrompts.some((prompt) => prompt.includes(persona))).toBe(true);
  expect(systemPrompts.some((prompt) => prompt.includes("你是只读检索代理"))).toBe(false);
});

test("批准时没有授权关闭，以 completed 关闭被拒绝（close_authorization_invalid），需求保持 active", async () => {
  const w = await createPmRunWorld(cleanups, { review: false });
  const requirementId = w.fixture.requirementId;
  const result = await w.manager.workflowManage(requirementId, { action: "close", reason: "completed", receiptId: uuidv7(), operationId: uuidv7() });
  expect(result).toMatchObject({ status: "rejected", missing: expect.arrayContaining(["close_authorization_invalid"]) });
  expect(w.fixture.state.read(requirementId).data.lifecycle).toBe("active");
});
