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
import { COMPLETION_REPORTS } from "../runtime/workflow-close.ts";
import type { CompletionReport } from "../runtime/workflow-close.ts";
import { InteractionAction } from "../runtime/user-interaction-format.ts";
import { Value } from "typebox/value";
import type { ScriptedReply } from "./helpers/controlled-provider.ts";
import { mainAdjudication } from "./helpers/main-adjudication.ts";
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
 * 同一个脚本化模型服务 PM、多个并行子代理与主窗口的解释器：按系统提示里的任务 key 把请求分给各自的脚本，
 * 子代理脚本的一步可以读取上一步的真实工具结果（例如正式验证编号）再给出调用。
 */
function routeReplies(provider: { queue: ScriptedReply[]; requests: Context[] }, pm: (request: Context) => ScriptedReply) {
  const scripts = new Map<string, Step[]>();
  const interpreter: ScriptedReply[] = [];
  provider.queue.shift = () => {
    const request = provider.requests.at(-1)!;
    if ((request.systemPrompt ?? "").includes("需求解释器")) return interpreter.shift();
    const key = /任务：([A-Za-z0-9._-]+)（/.exec(request.systemPrompt ?? "")?.[1];
    if (key === undefined) return pm(request);
    const step = scripts.get(key)?.shift();
    return typeof step === "function" ? step(request) : step;
  };
  return { script: (key: string, ...steps: Step[]) => scripts.set(key, steps), interpret: (reply: string) => { interpreter.push({ type: "text", text: reply }); } };
}

test.skipIf(process.platform !== "darwin")("M7-AC19/M7B：零自定义下默认六职责团队完成接手、规划、实现、独立审查、QA，PM 提交完成报告，用户返工后再验收通过，主代理以完成关闭；全程不用 explore 规划", async () => {
  const w = await createPmRunWorld(cleanups, { review: false });
  const requirementId = w.fixture.requirementId;
  const tasks = () => w.db((db) => db.list<TaskRecord>(TASKS).map((row) => row.data));
  const task = (key: string) => tasks().find((entry) => entry.key === key);
  const rounds = () => w.db((db) => db.list<{ requirementId: string; checkRoundId: string; status: string }>(CHECK_ROUNDS).map((row) => row.data)
    .filter((round) => round.requirementId === requirementId));
  const openRound = () => w.db((db) => activeCheckRoundIn(db, w.fixture.repoId, requirementId)?.data.checkRoundId ?? null);
  const reports = () => w.db((db) => db.list<CompletionReport>(COMPLETION_REPORTS).map((row) => row.data)).sort((a, b) => a.createdAt - b.createdAt);

  const pmActions: string[] = [];
  const once = (action: string, reply: ScriptedReply) => { pmActions.push(action); return reply; };
  let earlyAdvance = "", rereport = "";
  const { script, interpret } = routeReplies(w.provider, (request) => {
    if (pmActions.at(-1) === "early-advance" && !earlyAdvance) earlyAdvance = lastResult(request);
    if (pmActions.at(-1) === "rereport" && !rereport) rereport = lastResult(request);
    if (task("impl")?.status === "awaiting_review" && !pmActions.includes("early-advance")) return once("early-advance", call("workflow_manage", { action: "advance" }));
    for (const key of ["impl", "fix"]) {
      if (task(key)?.status === "awaiting_review" && !pmActions.includes(`review:${key}`)) {
        return once(`review:${key}`, call("agent_manage", { action: "dispatch", taskId: task(key)!.taskId, review: { maxTurns: 4 } }));
      }
    }
    if (lastResult(request).includes("要求返工") && !pmActions.includes("rereport")) return once("rereport", call("workflow_manage", { action: "report", note: "未改动，再次提交" }));
    const qa = task("recheck") ? "recheck" : "acceptance";
    const workersDone = tasks().filter((entry) => entry.role === "worker").every((entry) => entry.status === "completed");
    const round = openRound();
    if (workersDone && !round && task(qa)?.status === "pending" && !pmActions.includes(`advance:${qa}`)) return once(`advance:${qa}`, call("workflow_manage", { action: "advance" }));
    if (round && task(qa)?.status === "pending" && !pmActions.includes(qa)) return once(qa, call("agent_manage", { action: "dispatch", taskId: task(qa)!.taskId }));
    if (round && task(qa)?.status === "completed" && !pmActions.includes(`finish:${qa}`)) return once(`finish:${qa}`, call("workflow_manage", { action: "finish", checkRoundId: round }));
    if (pmActions.at(-1) === `finish:${qa}`) return once(`report:${qa}`, call("workflow_manage", { action: "report", note: `交付手机号验证码登录（${qa}）` }));
    return { type: "text", text: "PM 已核对" };
  });

  await w.review();
  await until(() => w.owner().context.baseline?.revision === 1);

  await w.plan.execute({ action: "propose", tasks: [
    spec("impl", "worker", { writePaths: ["src/"], objective: "实现手机号验证码登录：正确验证码成功，错误验证码失败" }),
    spec("acceptance", "qa", { dependsOn: ["impl"], objective: "黑盒验收正常登录与验证码失败场景" }),
  ] });
  await w.plan.execute({ action: "confirm", planVersion: 1 });
  await expect(w.manager.dispatchTask({ pmRunId: w.pm.runId, taskId: task("acceptance")!.taskId, retry: null })).rejects.toMatchObject({ code: "dependency_pending" });

  const suggestion = { kind: "suggestion", targetRef: "prod:goal.login", evidenceRef: null, trigger: "输入验证码", impact: "可补充更多用例" };
  // 同一脚本先后服务 worker 与审查它的 reviewer：两者的任务说明都以该任务 key 标识
  const workThenReview = (path: string, content: string): Step[] => [
    call("change_apply", { action: "apply", operationId: uuidv7(), files: [{ path, baseHash: "absent", content }] }),
    call("result_submit", { action: "verdict", result: { checkRoundId: null, verificationIds: [], summary: `新增 ${path}`, findings: [] } }),
    call("verification_run", { action: "run", kind: "debug", command: `test -f ${path}`, performance: NA }),
    (request) => call("result_submit", { action: "verdict", result: { checkRoundId: null, verificationIds: [field(lastResult(request), "verificationId")],
      summary: "实现符合已批准目标", findings: [suggestion] } })];
  const formalThenVerdict = (command: string, summary: string): Step[] => [
    call("verification_run", { action: "run", kind: "formal", command, performance: NA }),
    (request) => {
      const result = lastResult(request);
      return call("result_submit", { action: "verdict", result: { checkRoundId: field(result, "checkRoundId"), verificationIds: [field(result, "verificationId")], summary,
        findings: [suggestion] } });
    },
  ];
  script("impl", ...workThenReview("src/login.ts", LOGIN));
  script("acceptance", ...formalThenVerdict("grep -q 失败 src/login.ts", "正常登录与验证码失败场景均可观察"));

  const worker = await w.manager.dispatchTask({ pmRunId: w.pm.runId, taskId: task("impl")!.taskId, retry: null });
  await until(() => task("impl")!.status === "completed");
  expect(earlyAdvance).toContain("tasks_not_reviewed");
  await expect(readFile(join(w.fixture.state.read(requirementId).data.workspace!.path, "src", "login.ts"), "utf8")).resolves.toBe(LOGIN);

  // PM 提交完成报告后不关闭需求，报告作为待验收事项出现在面板，决策包由程序事实与标明参考的 PM 说明组成
  await until(() => reports().length === 1, 3_000);
  expect(w.fixture.state.read(requirementId).data.lifecycle).toBe("active");
  await until(async () => (await w.manager.overviews())[0]?.doing === "等待你验收完成报告", 3_000);
  const [overview] = await w.manager.overviews();
  const item = overview!.pendingItems.find((entry) => entry.kind === "acceptance")!;
  expect(item).toMatchObject({ itemId: `report:${reports()[0]!.reportId}`, label: "待你验收：PM 完成报告" });
  const packet = w.manager.decisionPacket(requirementId, item.itemId);
  for (const line of ["以下事实由程序从持久记录生成", "worker 任务 impl：completed · 任务级审查 clear", "QA 结论：clear", "非阻塞建议 2 条", "需求分支本地提交 0 个",
    "PM 的说明（模型输出，仅供参考，不是用户决定）：「交付手机号验证码登录（acceptance）」", `purpose=adjudicate itemId=${item.itemId} itemVersion=${item.version}`]) expect(packet).toContain(line);

  // 没有用户通过决定时主窗口不能以完成关闭
  const close = (receiptId: string) => w.manager.workflowManage(requirementId, { action: "close", reason: "completed", receiptId, operationId: uuidv7() });
  expect(await close(uuidv7())).toMatchObject({ status: "rejected", missing: ["close_authorization_invalid"] });

  // 用户返工：报告作废，意见交回 PM；没有新证据时 PM 重新提交被拒
  const main = mainAdjudication(w, cleanups, interpret);
  const rework = await main.adjudicate("错误验证码时还要提示剩余次数，返工", [main.entry([`item:${item.itemId}`, `version:${item.version}`, "choice:rework"],
    { conclusion: "错误验证码时提示剩余尝试次数" })], item.itemId, item.version);
  expect(rework).toMatchObject({ status: "recorded", choice: "rework" });
  expect(reports()[0]).toMatchObject({ status: "rework", decisionId: rework.decisionId });
  await until(() => rereport !== "", 3_000);
  expect(w.provider.requests.some((request) => lastResult(request).includes("错误验证码时提示剩余尝试次数"))).toBe(true);
  expect(rereport).toContain("rework_not_addressed");
  expect(await close(String(rework.decisionId))).toMatchObject({ status: "rejected", missing: ["close_authorization_invalid"] });

  // PM 追加返修与复验任务，返修经任务级审查、新的检查轮后重新提交报告
  await w.plan.execute({ action: "update", planVersion: 1, add: [
    spec("fix", "worker", { writePaths: ["lib/"], objective: "错误验证码时提示剩余尝试次数" }),
    spec("recheck", "qa", { dependsOn: ["fix"], objective: "黑盒复验剩余次数提示" }),
  ] });
  await w.plan.execute({ action: "confirm", planVersion: 2 });
  script("fix", ...workThenReview("lib/hint.ts", "export const hint = \"剩余 2 次\";\n"));
  script("recheck", ...formalThenVerdict("grep -q 剩余 lib/hint.ts", "剩余次数提示可观察"));
  await w.manager.dispatchTask({ pmRunId: w.pm.runId, taskId: task("fix")!.taskId, retry: null });
  await until(() => reports().length === 2, 3_000);
  const second = reports()[1]!;
  await until(async () => (await w.manager.overviews())[0]?.pendingItems.some((entry) => entry.itemId === `report:${second.reportId}`) ?? false, 3_000);
  const version = (await w.manager.overviews())[0]!.pendingItems.find((entry) => entry.itemId === `report:${second.reportId}`)!.version;

  // 用户验收通过后主窗口以该决定完成关闭，PM 停止、完成归档
  const accepted = await main.adjudicate("可以了，验收通过", [main.entry([`item:report:${second.reportId}`, `version:${version}`, "choice:accept"])], `report:${second.reportId}`, version);
  expect(accepted).toMatchObject({ status: "recorded", choice: "accept" });
  const closed = await close(String(accepted.decisionId));
  expect(closed).toMatchObject({ status: "closed", reason: "completed", archive: { status: "archived" } });
  expect(w.fixture.state.read(requirementId).data).toMatchObject({ lifecycle: "closed", close: { reason: "completed" } });
  expect(await w.manager.workflowManage(requirementId, { action: "delivery-check" })).toMatchObject({ deliverable: false, blockers: expect.arrayContaining(["requirement_not_active"]) });

  expect(pmActions).toEqual(["early-advance", "review:impl", "advance:acceptance", "acceptance", "finish:acceptance", "report:acceptance", "rereport",
    "review:fix", "advance:recheck", "recheck", "finish:recheck", "report:recheck"]);
  const runs = (await w.runStore.list({ requirement: requirementId, limit: 100 })).items;
  const all = await Promise.all(runs.map(async (run) => { const got = await w.runStore.get(run.id); if (!got.ok) throw new Error(got.reason); return got.run; }));
  expect(all.every((run) => run.agent?.source === "default")).toBe(true);
  expect(all.filter((run) => run.state === "failed")).toEqual([]);
  expect(all.every((run) => run.state === "completed" || run.state === "stopped")).toBe(true);
  expect(all.find((run) => run.kind === "requirement")?.state).toBe("stopped");
  expect(all.map((run) => run.role ?? run.kind).sort()).toEqual(["pi-company.qa", "pi-company.qa", "pi-company.reviewer", "pi-company.reviewer",
    "pi-company.worker", "pi-company.worker", "requirement"]);
  const implRun = all.find((run) => run.role === "pi-company.worker" && run.task === task("impl")!.taskId)!;
  expect(implRun.id).toBe(worker.runId);
  expect(all.filter((run) => run.kind !== "requirement").every((run) => run.parentRunId === w.pm.runId)).toBe(true);
  const verdicts = w.db((db) => db.list<Verdict>(VERDICTS).map((row) => row.data));
  expect(verdicts.map((verdict) => [verdict.role, verdict.conclusion]).sort()).toEqual([
    ["qa", "clear"], ["qa", "clear"], ["reviewer", "clear"], ["reviewer", "clear"], ["worker", "clear"], ["worker", "clear"]]);
  expect(tasks().map((entry) => [entry.key, entry.role, entry.status]).sort()).toEqual([
    ["acceptance", "qa", "completed"], ["fix", "worker", "completed"], ["impl", "worker", "completed"], ["recheck", "qa", "completed"]]);
  expect(verdicts.find((verdict) => verdict.role === "reviewer" && verdict.review?.taskId === task("impl")!.taskId))
    .toMatchObject({ checkRoundId: null, review: { attemptRunId: implRun.id } });
  expect(all.some((run) => run.role === "pi-company.explore")).toBe(false);
  const systemPrompts = w.provider.requests.map((request) => request.systemPrompt ?? "");
  for (const persona of ["你是一个活动需求的唯一 PM", "你是实现代理", "你是独立审查代理", "你是黑盒验收代理"]) expect(systemPrompts.some((prompt) => prompt.includes(persona))).toBe(true);
  expect(systemPrompts.some((prompt) => prompt.includes("你是只读检索代理"))).toBe(false);
});

test("M7B-AC3/AC6：批准清单不能含关闭动作；没有用户验收通过的决定时主代理以 completed 关闭被拒，需求保持 active", async () => {
  expect(Value.Check(InteractionAction, "close")).toBe(false);
  const w = await createPmRunWorld(cleanups, { review: false });
  const requirementId = w.fixture.requirementId;
  const result = await w.manager.workflowManage(requirementId, { action: "close", reason: "completed", receiptId: uuidv7(), operationId: uuidv7() });
  expect(result).toMatchObject({ status: "rejected", missing: expect.arrayContaining(["close_authorization_invalid"]) });
  expect(w.fixture.state.read(requirementId).data.lifecycle).toBe("active");
});
