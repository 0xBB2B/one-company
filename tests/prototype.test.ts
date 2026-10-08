import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, stat, writeFile } from "node:fs/promises";
import { afterEach, expect, test, vi } from "vitest";
import type { Context } from "@earendil-works/pi-ai";
import { checkAgentToolCall } from "../daemon/agent-session.ts";
import { adjudicationSubject } from "../runtime/adjudication.ts";
import { activeCheckRoundIn } from "../runtime/check-round.ts";
import { uuidv7 } from "../runtime/database.ts";
import { decisionPacket } from "../runtime/decision-packet.ts";
import { TASKS } from "../runtime/plan-manage.ts";
import type { TaskRecord, TaskSpec } from "../runtime/plan-manage.ts";
import { PROTOTYPE_MAX_BYTES, prototypeItemId, prototypePath } from "../runtime/prototype.ts";
import { createResultSubmitTool } from "../runtime/result-submit.ts";
import type { ScriptedReply } from "./helpers/controlled-provider.ts";
import { createPmRunWorld, until } from "./helpers/run-manager-fixture.ts";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 60_000 });
const cleanups: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });
const NA = { applicable: false as const, reason: "无性能影响" };
function spec(key: string, patch: Partial<TaskSpec> = {}): TaskSpec {
  return { key, role: "worker", goalUnitIds: ["goal.login"], constraintUnitIds: [], dependsOn: [], writePaths: ["src/"], blockedByQuestionIds: [],
    maxTurns: 4, objective: `实现 ${key}`, passCriteria: ["可观察通过"], scope: { in: [key], out: ["微信登录"] }, performance: NA, ...patch };
}
const HTML = "<!doctype html><html><body><h1>状态面板</h1></body></html>";
const HTML2 = "<!doctype html><html><body><h1>状态面板</h1><p>速度放大</p></body></html>";
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

type Step = ScriptedReply | ((request: Context) => ScriptedReply);
const call = (name: string, input: Record<string, unknown>): ScriptedReply => ({ type: "toolcall", name: name === "read" ? name : `one_company_${name}`, input });
const proto = (html = HTML, note = "三项状态横排"): ScriptedReply => call("result_submit", { action: "prototype", html, note });
const verdict = (summary: string, verificationIds: Array<string | undefined> = [], checkRoundId: string | null = null): ScriptedReply =>
  call("result_submit", { action: "verdict", result: { checkRoundId, verificationIds, summary, findings: [] } });
const lastMessage = (request: Context | undefined) => JSON.stringify(request?.messages.at(-1) ?? "");
const field = (text: string, name: string) => new RegExp(`\\\\"${name}\\\\":\\\\"([0-9a-f-]{36})\\\\"`).exec(text)?.[1];

/** 同一个脚本化模型按系统提示里的任务 key 把请求分给各子代理的脚本；PM 的请求交给 pm 回调。 */
async function world(pm: (request: Context, w: Awaited<ReturnType<typeof createPmRunWorld>>) => ScriptedReply = () => ({ type: "text", text: "PM 收到" })) {
  const w = await createPmRunWorld(cleanups);
  const scripts = new Map<string, Step[]>();
  w.provider.queue.shift = () => {
    const request = w.provider.requests.at(-1)!;
    const key = /任务：([A-Za-z0-9._-]+)（/.exec(request.systemPrompt ?? "")?.[1];
    if (key === undefined) return pm(request, w);
    const step = scripts.get(key)?.shift();
    return typeof step === "function" ? step(request) : step;
  };
  const ref = { dataRoot: w.fixture.dataRoot, repoId: w.fixture.repoId }, requirementId = w.fixture.requirementId;
  const task = (key: string) => w.db((db) => db.list<TaskRecord>(TASKS).map((row) => row.data).find((entry) => entry.key === key)!);
  const dispatch = (key: string, mode: { prototype?: { maxTurns: number }; review?: { maxTurns: number } } = {}) =>
    w.manager.dispatchTask({ pmRunId: w.pm.runId, taskId: task(key).taskId, retry: null, ...mode });
  const prototype = async (key: string, ...steps: Step[]) => {
    const before = task(key).prototypes?.length ?? 0;
    scripts.set(key, steps);
    const run = await dispatch(key, { prototype: { maxTurns: 4 } });
    await until(() => task(key).prototypeRun?.outcome !== "running");
    return { run, submitted: (task(key).prototypes?.length ?? 0) > before };
  };
  const item = async (key: string) => (await w.manager.overviews())[0]?.pendingItems.find((entry) => entry.itemId === prototypeItemId(task(key).taskId));
  const decide = async (key: string, choice: "accept" | "rework", opinion: string | null = null) => {
    const current = (await item(key))!;
    return w.manager.decidePrototype({ requirementId, itemId: current.itemId, itemVersion: current.version, choice, opinion });
  };
  const pmHeard = (text: string) => until(() => w.provider.requests.some((request) => !/任务：[A-Za-z0-9._-]+（/.test(request.systemPrompt ?? "") && lastMessage(request).includes(text)));
  const requestOf = (marker: string) => w.provider.requests.findLast((request) => request.systemPrompt?.includes(marker))!;
  return { ...w, ref, requirementId, task, dispatch, prototype, item, decide, pmHeard, requestOf, script: (key: string, ...steps: Step[]) => scripts.set(key, steps) };
}

test("M8E-AC1：worker 提交的原型存进本机数据目录并记版本与指纹，不写业务仓库；超出 1 MB 被拒并写明原因；非 worker 不能提交", async () => {
  const w = await world();
  await w.plan.execute({ action: "propose", tasks: [spec("hud", { ui: true, writePaths: ["src/hud/"] }), spec("plain", { goalUnitIds: ["scenario.failure"], writePaths: ["lib/"] })] });
  await w.plan.execute({ action: "confirm", planVersion: 1 });
  await expect(w.plan.execute({ action: "update", planVersion: 1, add: [spec("qa", { role: "qa", writePaths: [], ui: true })] })).rejects.toMatchObject({ code: "dependency_invalid" });
  await expect(w.dispatch("plain", { prototype: { maxTurns: 4 } })).rejects.toMatchObject({ code: "not_ui_task" });

  const { run, submitted } = await w.prototype("hud", proto("x".repeat(PROTOTYPE_MAX_BYTES + 1)), proto());
  expect(submitted).toBe(true);
  const tooLarge = w.provider.requests.find((request) => lastMessage(request).includes("原型超出大小上限"));
  expect(lastMessage(tooLarge)).toContain(`原型 ${PROTOTYPE_MAX_BYTES + 1} 字节，上限 ${PROTOTYPE_MAX_BYTES} 字节`);

  const hud = w.task("hud"), path = prototypePath(w.ref, w.requirementId, "hud", 1);
  expect(hud.prototypes).toEqual([{ version: 1, hash: sha256(HTML), bytes: Buffer.byteLength(HTML), path, runId: run.runId, note: "三项状态横排", submittedAt: expect.any(Number), revision: 1 }]);
  expect(path.startsWith(w.fixture.dataRoot)).toBe(true);
  expect(await readFile(path, "utf8")).toBe(HTML);
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  const workspace = w.fixture.state.read(w.requirementId).data.workspace!.path;
  expect(execFileSync("git", ["-C", workspace, "status", "--porcelain"], { encoding: "utf8" })).toBe("");
  // 做原型不占任务的尝试次数，也不进入待审查
  expect(hud).toMatchObject({ status: "pending", attempts: [], prototypeRun: { runId: run.runId, outcome: "completed", maxTurns: 4 } });
  expect(await w.runStore.get(run.runId)).toMatchObject({ ok: true, run: { state: "completed", role: "one-company.worker" } });
  // 做原型的 worker 工具与普通 worker 相同
  expect(w.requestOf("本次只做界面原型").tools?.map((tool) => tool.name).sort()).toEqual(["find", "grep", "ls", "one_company_change_apply", "one_company_result_submit",
    "one_company_verification_run", "read"]);
  await w.pmHeard("任务 hud 的原型第 1 版已提交");

  const grant = (role: "worker" | "reviewer" | "qa") => ({ role, callerId: uuidv7(), runId: uuidv7(), parentRunId: w.pm.runId });
  const binding = { ...w.ref, requirementId: w.requirementId, taskId: hud.taskId };
  for (const role of ["reviewer", "qa"] as const) {
    expect(() => createResultSubmitTool({ grant: grant(role), prototypeBinding: binding, authorize: () => true }).execute({ action: "prototype", html: HTML, note: "越权" }))
      .toThrow(expect.objectContaining({ code: "action_not_allowed" }));
  }
  // 不是这次原型运行的 worker 交不进来；做原型的运行也不能改交实现结果
  await expect(createResultSubmitTool({ grant: grant("worker"), prototypeBinding: binding, authorize: () => true }).execute({ action: "prototype", html: HTML, note: "旧运行" }))
    .rejects.toMatchObject({ code: "prototype_unavailable" });
  expect(() => createResultSubmitTool({ grant: grant("worker"), authorize: () => true }).execute({ action: "prototype", html: HTML, note: "实现运行" }))
    .toThrow(expect.objectContaining({ code: "prototype_unavailable" }));
  expect(() => createResultSubmitTool({ grant: grant("worker"), prototypeBinding: binding, authorize: () => true })
    .execute({ action: "verdict", result: { checkRoundId: null, verificationIds: [], summary: "实现完了", findings: [] } })).toThrow(expect.objectContaining({ code: "verdict_unavailable" }));
  expect(w.task("hud").prototypes).toHaveLength(1);

  // worker 没交出原型时如实报给 PM，不产生版本
  const failed = await w.prototype("hud", { type: "text", text: "做不出来" });
  expect(failed.submitted).toBe(false);
  expect(w.task("hud").prototypeRun).toMatchObject({ runId: failed.run.runId, outcome: "incomplete" });
  await w.pmHeard("任务 hud 没有交出原型");

  // 做原型期间面板第二行按真实状态写明
  w.script("hud", { type: "text", text: "慢慢做", chunkDelayMs: 20_000 });
  const slow = await w.dispatch("hud", { prototype: { maxTurns: 4 } });
  await until(async () => (await w.manager.overviews())[0]?.doing === "派 worker 做原型 hud");
  // 被停止的原型运行按实际结局收口，不会把任务一直占住：之后还能再派
  await until(async () => (await w.manager.stop(slow.runId, { reason: "main_agent" })).confirmed);
  expect(w.task("hud").prototypeRun).toMatchObject({ runId: slow.runId, outcome: "stopped" });
  expect((await w.prototype("hud", proto(HTML2, "重做"))).submitted).toBe(true);
  expect(w.task("hud").prototypes!.map((entry) => entry.version)).toEqual([1, 2]);
});

test("M8E-AC2/AC3：原型待确认时面板出现事项；没有已通过原型不能派实现；通过后可以派；返工意见原话交回 PM；新版本使旧的通过失效；PM 与其他代理不能替用户通过", async () => {
  const w = await world();
  await w.plan.execute({ action: "propose", tasks: [spec("hud", { ui: true, writePaths: ["src/hud/"] }), spec("plain", { goalUnitIds: ["scenario.failure"], writePaths: ["lib/"] })] });
  await w.plan.execute({ action: "confirm", planVersion: 1 });

  await expect(w.dispatch("hud")).rejects.toMatchObject({ code: "prototype_required", detail: ["hud 还没有原型"] });
  expect(w.task("hud").attempts).toEqual([]);
  // 非界面任务照常派出
  w.script("plain", verdict("完成 plain"));
  await w.dispatch("plain");
  await until(() => w.task("plain").status === "awaiting_review");

  await w.prototype("hud", proto());
  await until(async () => (await w.manager.overviews())[0]?.status === "waiting");
  const [overview] = await w.manager.overviews();
  const first = (await w.item("hud"))!;
  expect(first).toEqual({ itemId: `prototype:${w.task("hud").taskId}`, kind: "prototype", label: "待你确认原型：任务 hud（第 1 版）",
    version: `prototype:${w.task("hud").taskId}:1:${sha256(HTML)}` });
  expect(overview!.doing).toBe("等待你确认原型");
  await expect(w.dispatch("hud")).rejects.toMatchObject({ code: "prototype_required", detail: ["hud 的原型第 1 版还在等用户确认"] });

  // 原型只在程序确认窗口里确认：不生成决策包，主代理的裁决登记入口也不认这个事项，PM 的计划工具写不进原型记录
  expect(() => decisionPacket(w.ref, w.requirementId, first.itemId)).toThrow("item_not_pending");
  expect(() => adjudicationSubject(w.ref, w.requirementId, first.itemId)).toThrow("item_not_pending");
  const forged = { ...spec("hud", { ui: true, writePaths: ["src/hud/"] }), prototypes: [{ ...w.task("hud").prototypes![0], decision: { choice: "accept", opinion: null, decidedAt: 1, notified: true } }] };
  await expect(w.plan.execute({ action: "update", planVersion: 1, modify: [{ taskId: w.task("hud").taskId, version: 1, spec: forged }] })).rejects.toThrow();
  expect(w.task("hud").prototypes![0]!.decision).toBeUndefined();

  // 确认窗口要显示的内容来自程序记录；文件被改动后拒绝
  const info = await w.manager.prototypeConfirmation(w.requirementId, first.itemId);
  expect(info).toEqual({ itemId: first.itemId, itemVersion: first.version, taskKey: "hud", version: 1, hash: sha256(HTML), bytes: Buffer.byteLength(HTML),
    path: prototypePath(w.ref, w.requirementId, "hud", 1), note: "三项状态横排" });
  await writeFile(info.path, HTML + "<script>alert(1)</script>");
  await expect(w.manager.prototypeConfirmation(w.requirementId, first.itemId)).rejects.toMatchObject({ code: "file_changed" });
  await writeFile(info.path, HTML);

  // 返工：须有意见，意见原话交回 PM，事项消失，实现仍不能派
  await expect(w.decide("hud", "rework", "  ")).rejects.toMatchObject({ code: "opinion_required" });
  expect(await w.decide("hud", "rework", "速度数字放大一号")).toEqual({ version: 1, choice: "rework" });
  await w.pmHeard("用户要求任务 hud 的原型第 1 版返工。用户意见：「速度数字放大一号」");
  expect(await w.item("hud")).toBeUndefined();
  await expect(w.dispatch("hud")).rejects.toMatchObject({ code: "prototype_required", detail: ["hud 的原型第 1 版被用户要求返工"] });
  await expect(w.manager.decidePrototype({ requirementId: w.requirementId, itemId: first.itemId, itemVersion: first.version, choice: "accept", opinion: null }))
    .rejects.toMatchObject({ code: "item_not_pending" });

  // 新版本重新走确认；做原型的 worker 拿到上一版路径与用户意见
  await w.prototype("hud", proto(HTML2, "速度放大"));
  const reworkPrompt = w.requestOf("本次只做界面原型").systemPrompt!;
  expect(reworkPrompt).toContain(`上一版原型：第 1 版 ${info.path}`);
  expect(reworkPrompt).toContain("用户看过上一版后要求返工，原话：「速度数字放大一号」");
  const second = (await w.item("hud"))!;
  expect(second.label).toBe("待你确认原型：任务 hud（第 2 版）");
  // 拿旧版本的事项去登记不算数
  await expect(w.manager.decidePrototype({ requirementId: w.requirementId, itemId: first.itemId, itemVersion: first.version, choice: "accept", opinion: null }))
    .rejects.toMatchObject({ code: "item_changed" });
  expect(await w.decide("hud", "accept")).toEqual({ version: 2, choice: "accept" });
  await w.pmHeard("用户通过了任务 hud 的原型第 2 版");
  expect(await w.item("hud")).toBeUndefined();

  // 通过后又出了第 3 版：第 2 版的通过不再算数，要重新确认
  await w.prototype("hud", proto(HTML, "第三版"));
  await expect(w.dispatch("hud")).rejects.toMatchObject({ code: "prototype_required", detail: ["hud 的原型第 3 版还在等用户确认"] });
  await expect(w.manager.decidePrototype({ requirementId: w.requirementId, itemId: second.itemId, itemVersion: second.version, choice: "accept", opinion: null }))
    .rejects.toMatchObject({ code: "item_changed" });
  await w.decide("hud", "accept");

  w.script("hud", verdict("完成 hud"));
  await w.dispatch("hud");
  await until(() => w.task("hud").status === "awaiting_review");
  expect(w.requestOf("任务：hud（").systemPrompt).toContain(`本任务是界面任务，用户已通过的原型（用 read 读取，实现的界面须与它一致）：\n- hud：第 3 版 ${prototypePath(w.ref, w.requirementId, "hud", 3)}（指纹 sha256:${sha256(HTML)}）`);
});

test("M8E-AC3：交过原型的任务修改后仍是界面任务，没做过原型的可以去掉标记；用户批准新需求版本前取消被拒，批准后可以取消，事项消失", async () => {
  const w = await world();
  await w.plan.execute({ action: "propose", tasks: [spec("hud", { ui: true, writePaths: ["src/hud/"] }), spec("other", { ui: true, goalUnitIds: ["scenario.failure"], writePaths: ["lib/"] })] });
  await w.plan.execute({ action: "confirm", planVersion: 1 });
  await w.prototype("hud", proto());
  await w.decide("hud", "rework", "换个布局");
  await w.pmHeard("用户意见：「换个布局」");

  // PM 修改任务时不写界面标记：交过原型的 hud 标记保留，没做过原型的 other 标记去掉
  await w.plan.execute({ action: "update", planVersion: 1, modify: [
    { taskId: w.task("hud").taskId, version: 1, spec: spec("hud", { writePaths: ["src/hud/"], objective: "实现 hud（改过说明）" }) },
    { taskId: w.task("other").taskId, version: 1, spec: spec("other", { goalUnitIds: ["scenario.failure"], writePaths: ["lib/"] }) }] });
  await w.plan.execute({ action: "confirm", planVersion: 2 });
  expect(w.task("hud")).toMatchObject({ version: 2, ui: true, prototypes: [expect.objectContaining({ version: 1, decision: expect.objectContaining({ choice: "rework" }) })] });
  expect(w.task("other").ui).toBeUndefined();
  await expect(w.dispatch("hud")).rejects.toMatchObject({ code: "prototype_required", detail: ["hud 的原型第 1 版被用户要求返工"] });
  w.script("other", verdict("完成 other"));
  await w.dispatch("other");
  await until(() => w.task("other").status === "awaiting_review");

  // PM 不能自行取消交过原型的任务；用户批准了新的需求版本后才能取消，待确认事项随之消失
  await w.prototype("hud", proto(HTML2, "新布局"));
  const pending = (await w.item("hud"))!;
  const cancel = () => w.plan.execute({ action: "update", planVersion: w.db((db) => db.read<{ planVersion: number }>("plans", w.requirementId)!.data.planVersion),
    cancel: [{ taskId: w.task("hud").taskId, version: w.task("hud").version }] });
  await expect(cancel()).rejects.toMatchObject({ code: "task_not_ready", detail: ["hud 已交过原型，须等用户批准新的需求版本后才能取消"] });
  expect(w.task("hud").status).toBe("pending");
  await w.fixture.approveRevision({ body: "# 手机号正常登录 {#goal.login}\n输入正确验证码后成功，不要状态面板。\n# 验证码失败 {#scenario.failure}\n错误验证码显示失败。\n" });
  await until(() => w.owner().context.baseline?.revision === 2);
  await w.readDiffs(["revision 1 → 2"]);
  await w.plan.execute({ action: "assess-update", revision: 2, assessmentId: uuidv7(), tasks: ["hud", "other"].map((key) => ({ taskId: w.task(key).taskId, version: w.task(key).version,
    assessment: key === "hud" ? "affected" as const : "unaffected" as const, rationale: "用户不要状态面板" })), global: { assessment: "unaffected", rationale: "只去掉面板" } });
  await cancel();
  expect(w.task("hud").status).toBe("cancelled");
  expect(await w.item("hud")).toBeUndefined();
  await expect(w.manager.decidePrototype({ requirementId: w.requirementId, itemId: pending.itemId, itemVersion: pending.version, choice: "accept", opinion: null }))
    .rejects.toMatchObject({ code: "item_not_pending" });
});

test.skipIf(process.platform !== "darwin")("M8E-AC4：reviewer 与 QA 的输入带已通过原型的路径、版本和指纹；QA 多一个只能读这些原型文件的 read", async () => {
  const sent = new Set<string>();
  const once = (action: string, reply: ScriptedReply) => { sent.add(action); return reply; };
  const w = await world((_request, base) => {
    const tasks = base.db((db) => db.list<TaskRecord>(TASKS).map((row) => row.data));
    const impl = tasks.find((entry) => entry.key === "impl"), qa = tasks.find((entry) => entry.key === "acceptance");
    const round = base.db((db) => activeCheckRoundIn(db, base.fixture.repoId, base.fixture.requirementId)?.data.checkRoundId ?? null);
    if (impl?.status === "awaiting_review" && !sent.has("review")) return once("review", call("agent_manage", { action: "dispatch", taskId: impl.taskId, review: { maxTurns: 4 } }));
    if (impl?.status === "completed" && !round && qa?.status === "pending" && !sent.has("advance")) return once("advance", call("workflow_manage", { action: "advance" }));
    if (round && qa?.status === "pending" && !sent.has("qa")) return once("qa", call("agent_manage", { action: "dispatch", taskId: qa.taskId }));
    return { type: "text", text: "PM 已核对" };
  });
  await w.plan.execute({ action: "propose", tasks: [spec("impl", { ui: true, goalUnitIds: ["goal.login", "scenario.failure"] }),
    spec("acceptance", { role: "qa", writePaths: [], dependsOn: ["impl"], goalUnitIds: ["goal.login", "scenario.failure"] })] });
  await w.plan.execute({ action: "confirm", planVersion: 1 });
  await w.prototype("impl", proto());
  await w.decide("impl", "accept");
  const path = prototypePath(w.ref, w.requirementId, "impl", 1), line = `impl：第 1 版 ${path}（指纹 sha256:${sha256(HTML)}）`;

  w.script("impl",
    call("change_apply", { action: "apply", operationId: uuidv7(), files: [{ path: "src/hud.ts", baseHash: "absent", content: "export const hud = \"状态面板\";\n" }] }),
    verdict("新增 src/hud.ts"),
    call("verification_run", { action: "run", kind: "debug", command: "test -f src/hud.ts", performance: NA }),
    (request) => verdict("界面与原型一致", [field(lastMessage(request), "verificationId")]));
  w.script("acceptance",
    call("read", { path }),
    call("read", { path: "src/hud.ts" }),
    call("verification_run", { action: "run", kind: "formal", command: "grep -q 状态面板 src/hud.ts", performance: NA }),
    (request) => verdict("界面与原型一致", [field(lastMessage(request), "verificationId")], field(lastMessage(request), "checkRoundId") ?? null));
  await w.dispatch("impl");
  await until(() => w.task("acceptance").status === "completed", 3_000);

  expect(w.requestOf("审查任务：impl（").systemPrompt).toContain(`本任务是界面任务，用户已通过的原型（用 read 读取，对照它核对改动后的界面）：${line}`);
  const qaRequests = w.provider.requests.filter((request) => request.systemPrompt?.includes("任务：acceptance（"));
  expect(qaRequests[0]!.systemPrompt).toContain(`界面任务用户已通过的原型（用 read 读取，对照它检查实际界面效果）：\n- ${line}`);
  expect(qaRequests[0]!.tools?.map((tool) => tool.name).sort()).toEqual(["one_company_requirement_manage", "one_company_result_submit", "one_company_verification_run", "read"]);
  expect(lastMessage(qaRequests[1])).toContain("状态面板</h1>");
  expect(lastMessage(qaRequests[2])).toContain("读取路径超出范围");
});

test("M8E-AC4：QA 的 read 只放行已通过的原型文件", async () => {
  const state = { cwd: "/tmp/workspace", readRoots: ["/tmp/data/prototypes/hud.v1.html"], paused: () => false, submitted: () => false };
  const read = (path: string) => checkAgentToolCall({ type: "tool_call", toolCallId: "t", toolName: "read", input: { path } } as never, state);
  expect(await read("/tmp/data/prototypes/hud.v1.html")).toBeUndefined();
  for (const path of ["/tmp/data/prototypes/hud.v2.html", "/tmp/data/data.db", "src/hud.ts", "/tmp/data/prototypes/hud.v1.html/../../data.db"]) {
    expect(await read(path)).toMatchObject({ block: true, reason: expect.stringContaining("读取路径超出范围") });
  }
});

test("M8E-AC4：worker、reviewer、QA、PM 的角色说明与主窗口规范写明原型要求", async () => {
  const doc = (path: string) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
  const worker = await doc("agents/worker.md");
  for (const phrase of ["单个 HTML 文件，样式和脚本都写在文件里，不依赖构建", "正常、空数据、加载中、出错", "深色背景、等宽字体、固定 80 列", "action=prototype", "实现出来的界面须与它一致"]) expect(worker).toContain(phrase);
  const reviewer = await doc("agents/reviewer.md");
  for (const phrase of ["对照核对改动后的界面", "改了界面但没有用户通过的原型"]) expect(reviewer).toContain(phrase);
  expect(await doc("agents/qa.md")).toContain("与原型文件逐项对照");
  // M8I-AC1：没有浏览器时按输出与原型文件对照，浏览器实际渲染不列为未验证项，worker 不自己启动浏览器
  for (const role of ["qa", "reviewer", "worker"]) expect(await doc(`agents/${role}.md`)).toContain("浏览器里的实际渲染不列为未验证项");
  expect(await doc("agents/worker.md")).toContain("不自己去启动浏览器");
  const pm = await doc("agents/pm.md");
  for (const phrase of ["在计划里把 ui 写成 true", "带 prototype（轮次上限）派 worker 做原型", "不要代为确认"]) expect(pm).toContain(phrase);
  expect(await doc("rules/01-main-session.md")).toContain("你不能替用户登记，提醒用户去面板里选中这一事项按回车确认");
});
