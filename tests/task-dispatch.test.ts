import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type { Context } from "@earendil-works/pi-ai";
import { repositoryDatabase, uuidv7, withDatabase } from "../runtime/database.ts";
import { createPlanManageTool, stalledStage, TASKS } from "../runtime/plan-manage.ts";
import { VERDICTS } from "../runtime/verdicts.ts";
import type { Verdict } from "../runtime/verdicts.ts";
import type { TaskRecord } from "../runtime/plan-manage.ts";
import { PM_INTAKE_TOOL } from "../runtime/pm-intake-runtime.ts";
import type { TaskSpec } from "../runtime/plan-manage.ts";
import type { ScriptedReply } from "./helpers/controlled-provider.ts";
import { runGit } from "./helpers/git-run.ts";
import { createPmRunWorld, until } from "./helpers/run-manager-fixture.ts";

vi.setConfig({ testTimeout: 60_000 });
const cleanups: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });
const NA = { applicable: false as const, reason: "无性能影响" };
function spec(key: string, patch: Partial<TaskSpec> = {}): TaskSpec {
  return { key, role: "worker", goalUnitIds: ["goal.login"], constraintUnitIds: [], dependsOn: [], writePaths: ["src/"], blockedByQuestionIds: [],
    maxTurns: 2, objective: `实现 ${key}`, passCriteria: ["可观察通过"], scope: { in: [key], out: ["微信登录"] }, performance: NA, ...patch };
}

async function world() {
  const w = await createPmRunWorld(cleanups);
  const task = (key: string) => withDatabase(repositoryDatabase(w.fixture.dataRoot, w.fixture.repoId), (db) =>
    db.list<{ key: string; taskId: string; status: string; attempts: Array<{ runId: string; outcome: string; turnsUsed: number; maxTurns: number; reason: string | null; rework?: true }>;
      reviews: Array<{ runId: string; attemptRunId: string; outcome: string }> }>(TASKS)
      .map((row) => row.data).find((entry) => entry.key === key)!);
  const dispatch = (key: string, retry: { reason: string; maxTurns: number } | null = null) => w.manager.dispatchTask({ pmRunId: w.pm.runId, taskId: task(key).taskId, retry });
  const review = (key: string, maxTurns = 2) => w.manager.dispatchTask({ pmRunId: w.pm.runId, taskId: task(key).taskId, retry: null, review: { maxTurns } });
  const rework = (key: string, reason = "按审查意见返修", maxTurns = 2) => w.manager.dispatchTask({ pmRunId: w.pm.runId, taskId: task(key).taskId, retry: null, rework: { reason, maxTurns } });
  return { ...w, task, dispatch, review, rework };
}
const read = (n: number): ScriptedReply => ({ type: "toolcall", name: "read", input: { path: `README.md#${n}` } });
const lastPrompt = (request: Context | undefined) => JSON.stringify(request?.messages.at(-1) ?? "");

test("没有开启的检查轮时派 QA 当场拒绝，并提示先开检查轮", async () => {
  const w = await world();
  await w.plan.execute({ action: "propose", tasks: [spec("login"), spec("failure", { goalUnitIds: ["scenario.failure"] }),
    spec("qa", { role: "qa", writePaths: [], objective: "黑盒验收登录" })] });
  await w.plan.execute({ action: "confirm", planVersion: 1 });
  await expect(w.dispatch("qa")).rejects.toMatchObject({ code: "round_not_open" });
  expect(w.task("qa").attempts).toEqual([]);
});

test("worker 没提交结果就结束本轮时，本次尝试记为 incomplete 并上报 PM，由 PM 决定重试", async () => {
  const w = await world();
  await w.plan.execute({ action: "propose", tasks: [spec("login", { maxTurns: 5 }), spec("failure", { goalUnitIds: ["scenario.failure"] })] });
  await w.plan.execute({ action: "confirm", planVersion: 1 });
  const before = w.provider.requests.length;
  w.provider.queue.push(read(1), { type: "text", text: "做完了" }, { type: "text", text: "PM 收到" });
  const first = await w.dispatch("login");
  await until(() => w.task("login").status === "awaiting_parent");
  await until(() => w.provider.requests.length === before + 3);
  expect(w.task("login").attempts).toEqual([{ runId: first.runId, maxTurns: 5, turnsUsed: 2, reason: null, outcome: "incomplete" }]);
  const notice = lastPrompt(w.provider.requests.at(-1));
  expect(notice).toContain("原因：模型停止回复，但没有提交结果。");
  expect(notice).toContain("建议：请核对已有成果与原因后决定");
  expect(notice).toMatch(new RegExp(`运行日志：.*sessions/${first.runId}/session\\.jsonl（证据不够判断时，读这份会话记录查看子代理的思考与工具调用）`));
  expect(await w.runStore.get(first.runId)).toMatchObject({ ok: true, run: { state: "failed", stateReason: "模型停止回复，但没有提交结果" } });
});

test("worker 会话出错时，PM 收到的通知带真实错误原因与运行日志位置", async () => {
  const w = await world();
  await w.plan.execute({ action: "propose", tasks: [spec("login", { maxTurns: 5 }), spec("failure", { goalUnitIds: ["scenario.failure"] })] });
  await w.plan.execute({ action: "confirm", planVersion: 1 });
  const before = w.provider.requests.length;
  w.provider.queue.push({ type: "error", message: "401 invalid api key" }, { type: "text", text: "PM 收到" });
  const first = await w.dispatch("login");
  await until(() => w.task("login").status === "awaiting_parent");
  await until(() => w.provider.requests.length === before + 2);
  const notice = lastPrompt(w.provider.requests.at(-1));
  expect(notice).toContain("原因：会话出错：401 invalid api key。");
  expect(notice).toContain(`sessions/${first.runId}/session.jsonl`);
  expect(await w.runStore.get(first.runId)).toMatchObject({ ok: true, run: { state: "failed", stateReason: "会话出错：401 invalid api key" } });
  expect(await w.manager.status(first.runId)).toMatchObject({ ok: true, run: { stateReason: "会话出错：401 invalid api key", log: expect.stringContaining(first.runId) } });
});

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
  expect(await w.runStore.get(first.runId)).toMatchObject({ ok: true, run: { state: "failed", parentRunId: w.pm.runId, role: "one-company.worker" } });

  await expect(w.dispatch("login")).rejects.toMatchObject({ code: "retry_required" });
  w.provider.queue.push(read(4), read(5), read(6), { type: "text", text: "PM 收到第二次到限" });
  const second = await w.dispatch("login", { reason: "轮次估计不足", maxTurns: 3 });
  await until(() => w.task("login").status === "awaiting_user");
  expect(w.task("login").attempts[1]).toMatchObject({ runId: second.runId, maxTurns: 3, turnsUsed: 3, reason: "轮次估计不足", outcome: "turn_limit_reached" });
  await expect(w.dispatch("login", { reason: "再试一次", maxTurns: 5 })).rejects.toMatchObject({ code: "task_not_ready" });
  await expect(w.plan.execute({ action: "update", planVersion: 1, add: [spec("login-again")] })).rejects.toMatchObject({ code: "goal_held" });
  await expect(w.dispatch("failure", { reason: "无需重试", maxTurns: 2 })).rejects.toMatchObject({ code: "retry_not_needed" });
});

test("M7-AC26/AC31：worker 在额度内提交工作报告即进入待审查；依赖未完成、计划未冻结时拒绝派工", async () => {
  const w = await world();
  await w.plan.execute({ action: "propose", tasks: [spec("login"), spec("failure", { goalUnitIds: ["scenario.failure"], dependsOn: ["login"] })] });
  await expect(w.dispatch("login")).rejects.toMatchObject({ code: "plan_not_confirmed" });
  await w.plan.execute({ action: "confirm", planVersion: 1 });
  await expect(w.dispatch("failure")).rejects.toMatchObject({ code: "dependency_pending" });
  expect((await w.runStore.list({ limit: 100 })).items.filter((run) => run.task === w.task("failure").taskId)).toEqual([]);
  const login = w.task("login");
  w.provider.queue.push({ type: "toolcall", name: "one_company_result_submit", input: { action: "verdict", result: { checkRoundId: null, verificationIds: [],
    summary: `完成 ${login.key}`, findings: [] } } }, { type: "text", text: "PM 收到完成结果" });
  const run = await w.dispatch("login");
  await until(() => w.task("login").status === "awaiting_review");
  expect(await w.runStore.get(run.runId)).toMatchObject({ ok: true, run: { state: "completed" } });
  const workerRequest = w.provider.requests.find((request) => request.systemPrompt?.includes("任务：login"))!;
  expect(workerRequest.tools?.map((tool) => tool.name).sort()).toEqual(["find", "grep", "ls", "one_company_change_apply", "one_company_result_submit",
    "one_company_verification_run", "read"]);
  expect(workerRequest.systemPrompt).toContain("对话轮次上限：2");
});

test("M7-AC4/AC13：只有依赖未决问题的任务被阻塞；批准新版本而未复核时任何派工都被门槛拒绝", async () => {
  const w = await world();
  const question = "01900000-0000-7000-8000-0000000000aa";
  await w.plan.execute({ action: "propose", tasks: [spec("login", { blockedByQuestionIds: [question] }), spec("failure", { goalUnitIds: ["scenario.failure"] })] });
  await w.plan.execute({ action: "confirm", planVersion: 1 });
  await expect(w.dispatch("login")).rejects.toMatchObject({ code: "question_pending" });
  w.provider.queue.push({ type: "text", text: "做失败场景", chunkDelayMs: 20_000 });
  await w.dispatch("failure");
  w.provider.queue.push({ type: "text", text: "PM 收到差异" });
  await w.fixture.approveRevision({ body: "# 手机号正常登录 {#goal.login}\n输入正确验证码后成功。\n# 验证码失败 {#scenario.failure}\n错误验证码显示失败，并提示重试。\n" });
  await w.manager.stop((await w.runStore.list({ limit: 10 })).items.find((run) => run.task === w.task("failure").taskId)!.id, { reason: "main_agent" });
  await expect(w.dispatch("failure", { reason: "中途停止", maxTurns: 2 })).rejects.toMatchObject({ code: "pending_update" });
});

test("M7-AC6：PM 停止后新派出的 PM 从数据库读回同一份计划与任务说明", async () => {
  const w = await world();
  await w.plan.execute({ action: "propose", tasks: [spec("login"), spec("failure", { goalUnitIds: ["scenario.failure"] })] });
  await w.plan.execute({ action: "confirm", planVersion: 1 });
  const before = await w.plan.execute({ action: "read" });
  await w.manager.stop(w.pm.runId, { reason: "main_agent" });
  w.provider.queue.push({ type: "toolcall", name: PM_INTAKE_TOOL, input: { action: "ask", purpose: "pm-intake", understanding: w.understanding } }, { type: "text", text: "等待核对" });
  const next = await w.manager.dispatchPm({ requirementId: w.fixture.requirementId, model: { provider: "team-model", id: "test" }, thinking: "off" });
  const lease = w.fixture.state.pmOwner(w.fixture.requirementId)!.lease!;
  expect(lease.runId).toBe(next.runId);
  const reader = await createPlanManageTool({ repositoryRoot: w.fixture.repositoryRoot, dataRoot: w.fixture.dataRoot, authorize: () => true,
    grant: { role: "pm", callerId: uuidv7(), runId: lease.runId, requirementId: w.fixture.requirementId, repoId: w.fixture.repoId, workspaceId: lease.workspaceId, lease } });
  cleanups.push(() => reader.dispose());
  expect(await reader.execute({ action: "read" })).toEqual(before);
});

const submit = (summary: string, findings: Array<{ kind: "blocking" | "suggestion" | "unverified" }> = []): ScriptedReply => ({ type: "toolcall", name: "one_company_result_submit",
  input: { action: "verdict", result: { checkRoundId: null, verificationIds: [], summary,
    findings: findings.map((finding) => ({ ...finding, targetRef: "prod:goal.login", evidenceRef: null, trigger: "输入错误验证码", impact: "没有失败提示" })) } } });
const pmAck: ScriptedReply = { type: "text", text: "PM 收到" };

test("M7A-AC1/AC2/AC3/AC6：所在目录重叠的任务不能同时执行；审查 A 时 C 照常写入；A 审查通过前依赖它的任务不能派出；有任务未审查时不能交付", async () => {
  const w = await world();
  await w.plan.execute({ action: "propose", tasks: [spec("a", { writePaths: ["src/a/"] }), spec("b", { writePaths: ["src/a/x.ts"], goalUnitIds: ["scenario.failure"] }),
    spec("c", { writePaths: ["lib/"], goalUnitIds: ["scenario.failure"] }), spec("d", { writePaths: ["web/"], dependsOn: ["a"] })] });
  await w.plan.execute({ action: "confirm", planVersion: 1 });
  w.provider.queue.push(submit("完成 a"), pmAck);
  const a = await w.dispatch("a");
  await until(() => w.task("a").status === "awaiting_review");
  await expect(w.dispatch("b")).rejects.toMatchObject({ code: "write_scope_busy" });
  await expect(w.dispatch("d")).rejects.toMatchObject({ code: "dependency_pending" });

  w.provider.queue.push({ type: "text", text: "慢慢写 c", chunkDelayMs: 20_000 });
  const c = await w.dispatch("c");
  await until(async () => { const current = await w.runStore.get(c.runId); return current.ok && current.run.state === "running"; });
  const redGreen = [uuidv7(), uuidv7()];
  withDatabase(repositoryDatabase(w.fixture.dataRoot, w.fixture.repoId), (db) => {
    const row = db.list<Verdict>(VERDICTS).find((item) => item.data.runId === a.runId)!;
    db.update(VERDICTS, row.id, row.version, { ...row.data, verificationIds: redGreen });
  });
  w.provider.queue.push(submit("a 符合目标", [{ kind: "suggestion" }]), pmAck);
  const reviewer = await w.review("a");
  await until(() => w.task("a").status === "completed");
  expect(w.task("a").reviews).toEqual([expect.objectContaining({ runId: reviewer.runId, attemptRunId: a.runId, outcome: "clear" })]);
  expect(await w.runStore.get(c.runId)).toMatchObject({ ok: true, run: { state: "running" } });
  expect(await w.runStore.get(reviewer.runId)).toMatchObject({ ok: true, run: { role: "one-company.reviewer", writePaths: [], task: w.task("a").taskId } });
  const reviewerRequest = w.provider.requests.find((request) => request.systemPrompt?.includes("审查任务：a（"))!;
  expect(reviewerRequest.tools?.map((tool) => tool.name)).not.toContain("one_company_change_apply");
  expect(reviewerRequest.systemPrompt).toContain(`- 第 1 次尝试 ${a.runId}（本次被审）：提交说明：完成 a；引用的验证记录：${redGreen.join("、")}`);
  expect(reviewerRequest.systemPrompt).toMatch(/查看本次改动：用 verification_run kind=debug 运行 git --no-optional-locks diff [0-9a-f]{40} -- src\/a\//);

  w.provider.queue.push(submit("完成 d"), pmAck);
  await w.dispatch("d");
  await until(() => w.task("d").status === "awaiting_review");
  await w.manager.stop(c.runId, { reason: "main_agent" });
  expect(await w.manager.workflowManage(w.fixture.requirementId, { action: "delivery-check" }))
    .toMatchObject({ deliverable: false, blockers: expect.arrayContaining(["有任务还没经过审查"]) });
});

test("M8D2-AC2：worker 与 reviewer 的上下文含各自启动那一刻项目 AGENTS.md 的磁盘内容，文件改动后新派出的子代理读到新内容", async () => {
  const w = await world();
  const file = join(w.fixture.repositoryRoot, "AGENTS.md");
  await writeFile(file, "# 项目规范\n- 不使用泛型。\n");
  await w.plan.execute({ action: "propose", tasks: [spec("a", { writePaths: ["src/a/"] }), spec("b", { writePaths: ["lib/"], goalUnitIds: ["scenario.failure"] })] });
  await w.plan.execute({ action: "confirm", planVersion: 1 });
  w.provider.queue.push(submit("完成 a"), pmAck);
  await w.dispatch("a");
  await until(() => w.task("a").status === "awaiting_review");
  await writeFile(file, "# 项目规范\n- 不使用泛型。\n- 文件名用小写。\n");
  w.provider.queue.push(submit("a 符合目标"), pmAck);
  await w.review("a");
  await until(() => w.task("a").status === "completed");
  const prompt = (marker: string) => w.provider.requests.find((request) => request.systemPrompt?.includes(marker))!.systemPrompt!;
  expect(prompt("任务：a（")).toContain("项目规范（来源：仓库根目录 AGENTS.md；本任务的改动必须遵守）：\n# 项目规范\n- 不使用泛型。");
  expect(prompt("任务：a（")).not.toContain("文件名用小写");
  expect(prompt("审查任务：a（")).toContain("- 不使用泛型。\n- 文件名用小写。");
});

test("M7A-AC4：审查打回时 reviewer 任务仍算完成；返修须带原因且不占执行重试；再次打回进入待用户裁决，拆分或改名不能重置", async () => {
  const w = await world();
  await w.plan.execute({ action: "propose", tasks: [spec("login"), spec("failure", { goalUnitIds: ["scenario.failure"], writePaths: ["lib/"] })] });
  await w.plan.execute({ action: "confirm", planVersion: 1 });
  w.provider.queue.push(submit("完成 login"), pmAck);
  const first = await w.dispatch("login");
  await until(() => w.task("login").status === "awaiting_review");
  await expect(w.dispatch("login")).rejects.toMatchObject({ code: "task_not_ready" });

  w.provider.queue.push(submit("缺失败提示", [{ kind: "blocking" }]), pmAck);
  const rejected = await w.review("login");
  await until(() => w.task("login").status === "awaiting_rework");
  expect(await w.runStore.get(rejected.runId)).toMatchObject({ ok: true, run: { state: "completed" } });
  expect(w.task("login").reviews[0]).toMatchObject({ attemptRunId: first.runId, outcome: "blocked" });
  await expect(w.dispatch("login")).rejects.toMatchObject({ code: "rework_required" });
  await expect(w.dispatch("login", { reason: "重试", maxTurns: 2 })).rejects.toMatchObject({ code: "retry_not_needed" });
  await expect(w.review("login")).rejects.toMatchObject({ code: "task_not_ready" });

  w.provider.queue.push(submit("补上失败提示"), pmAck);
  const fix = await w.rework("login", "补失败提示", 3);
  await until(() => w.task("login").status === "awaiting_review");
  expect(w.task("login").attempts[1]).toMatchObject({ runId: fix.runId, maxTurns: 3, reason: "补失败提示", rework: true, outcome: "completed" });
  const fixRequest = w.provider.requests.find((request) => request.systemPrompt?.includes("审查打回后的返修"))!;
  expect(fixRequest.systemPrompt).toContain("输入错误验证码");

  w.provider.queue.push(submit("仍缺失败提示", [{ kind: "unverified" }]), pmAck);
  const second = await w.review("login");
  await until(() => w.task("login").status === "awaiting_user");
  // M8A-AC10：返修后的审查按每次尝试列出提交说明与引用，能看到第一次尝试的记录
  const secondRequest = w.provider.requests.find((request) => request.systemPrompt?.includes(`worker 尝试 ${fix.runId}`))!;
  expect(secondRequest.systemPrompt).toContain(`- 第 1 次尝试 ${first.runId}：提交说明：完成 login；引用的验证记录：无\n- 第 2 次尝试（返修） ${fix.runId}（本次被审）：提交说明：补上失败提示；引用的验证记录：无`);
  expect(secondRequest.systemPrompt).toContain("先红后绿可以出现在任意一次尝试里；返修改动了可测行为时，这次返修须有新的红");
  expect(w.task("login").reviews[1]).toMatchObject({ runId: second.runId, attemptRunId: fix.runId, outcome: "unverified" });
  await expect(w.rework("login")).rejects.toMatchObject({ code: "task_not_ready" });
  await expect(w.plan.execute({ action: "update", planVersion: 1, add: [spec("login-fix")] })).rejects.toMatchObject({ code: "goal_held" });
});

test("M7A-AC4：审查未交出结论按被审尝试计数；用户再给一次机会后经打回、返修，新尝试的审查仍可派出", async () => {
  const w = await world();
  await w.plan.execute({ action: "propose", tasks: [spec("login"), spec("failure", { goalUnitIds: ["scenario.failure"], writePaths: ["lib/"] })] });
  await w.plan.execute({ action: "confirm", planVersion: 1 });
  w.provider.queue.push(submit("完成 login"), pmAck);
  const first = await w.dispatch("login");
  await until(() => w.task("login").status === "awaiting_review");
  for (const expected of ["awaiting_review", "awaiting_user"]) {
    w.provider.queue.push(read(1), pmAck);
    await w.review("login", 1);
    await until(() => w.task("login").status === expected);
  }
  expect(w.task("login").reviews.map((review) => [review.attemptRunId, review.outcome])).toEqual([[first.runId, "turn_limit_reached"], [first.runId, "turn_limit_reached"]]);
  const stuck = withDatabase(repositoryDatabase(w.fixture.dataRoot, w.fixture.repoId), (db) => db.read<TaskRecord>(TASKS, w.task("login").taskId)!);
  expect(stalledStage(stuck.data)).toBe("review");
  await expect(w.review("login")).rejects.toMatchObject({ code: "task_not_ready" });

  // 模拟可信登记的用户决定"再给一次机会"：回到再审
  withDatabase(repositoryDatabase(w.fixture.dataRoot, w.fixture.repoId), (db) => db.update(TASKS, stuck.data.taskId, stuck.version, { ...stuck.data, status: "awaiting_review",
    userDecision: { decisionId: uuidv7(), choice: "retry", maxTurns: 2, revision: 1, taskVersion: stuck.data.version, usedByRunId: null, notified: true } }));
  w.provider.queue.push(submit("缺失败提示", [{ kind: "blocking" }]), pmAck);
  const granted = await w.review("login", 5);
  expect(granted.maxTurns).toBe(2);
  await until(() => w.task("login").status === "awaiting_rework");
  w.provider.queue.push(submit("补上失败提示"), pmAck);
  const fix = await w.rework("login");
  await until(() => w.task("login").status === "awaiting_review");
  w.provider.queue.push(submit("符合目标"), pmAck);
  await w.review("login");
  await until(() => w.task("login").status === "completed");
  expect(w.task("login").reviews.at(-1)).toMatchObject({ attemptRunId: fix.runId, outcome: "clear" });
});

test("worker 交结果时工作区有任务写入范围外的改动（新建 go.mod、改了 README.md）即拒收并写明怎么恢复，不记裁决；恢复后重交才进入待审查", async () => {
  const w = await world();
  await w.plan.execute({ action: "propose", tasks: [spec("login"), spec("failure", { goalUnitIds: ["scenario.failure"], writePaths: ["lib/"] })] });
  await w.plan.execute({ action: "confirm", planVersion: 1 });
  const root = w.fixture.state.read(w.fixture.requirementId).data.workspace!.path;
  const readme = await readFile(join(root, "README.md"), "utf8");
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "login.ts"), "export const login = 1;\n");
  await writeFile(join(root, "go.mod"), "module demo\n\nrequire github.com/pkg/errors v0.9.1\n");
  await writeFile(join(root, "README.md"), "被 worker 改了\n");
  const submit: ScriptedReply = { type: "toolcall", name: "one_company_result_submit", input: { action: "verdict", result: { checkRoundId: null, verificationIds: [],
    summary: "完成 login", findings: [] } } };
  let rejection = "";
  w.provider.queue.push(submit);
  w.provider.awaitReply = async () => {
    if (rejection) return { type: "text", text: "PM 收到完成结果" };
    rejection = lastPrompt(w.provider.requests.at(-1));
    await rm(join(root, "go.mod"));
    await writeFile(join(root, "README.md"), readme);
    return submit;
  };
  await w.dispatch("login");
  await until(() => w.task("login").status === "awaiting_review");
  expect(rejection).toContain("go.mod");
  expect(rejection).toContain("README.md");
  expect(rejection).not.toContain("src/login.ts");
  expect(rejection).toContain("git show HEAD:");
  expect(withDatabase(repositoryDatabase(w.fixture.dataRoot, w.fixture.repoId), (db) => db.list<Verdict>(VERDICTS).map((row) => row.data)
    .filter((verdict) => verdict.role === "worker"))).toHaveLength(1);
});

test("同一需求里其他未取消任务写入范围内的改动和被 Git 忽略的文件，不算本任务范围外的改动", async () => {
  const w = await world();
  await w.plan.execute({ action: "propose", tasks: [spec("login"), spec("other", { goalUnitIds: ["scenario.failure"], writePaths: ["lib/"] })] });
  await w.plan.execute({ action: "confirm", planVersion: 1 });
  const root = w.fixture.state.read(w.fixture.requirementId).data.workspace!.path;
  const exclude = (await runGit(["rev-parse", "--path-format=absolute", "--git-path", "info/exclude"], root)).trim();
  await mkdir(dirname(exclude), { recursive: true });
  await writeFile(exclude, "dist/\n");
  for (const path of ["lib/other.ts", "dist/bundle.js"]) {
    await mkdir(join(root, dirname(path)), { recursive: true });
    await writeFile(join(root, path), "export {};\n");
  }
  w.provider.queue.push({ type: "toolcall", name: "one_company_result_submit", input: { action: "verdict", result: { checkRoundId: null, verificationIds: [],
    summary: "完成 login", findings: [] } } }, { type: "text", text: "PM 收到完成结果" });
  await w.dispatch("login");
  await until(() => w.task("login").status === "awaiting_review");
});
