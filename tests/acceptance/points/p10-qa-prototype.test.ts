import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import type { Context } from "@earendil-works/pi-ai";
import { activeCheckRoundIn } from "../../../runtime/check-round.ts";
import { uuidv7 } from "../../../runtime/database.ts";
import { TASKS } from "../../../runtime/plan-manage.ts";
import type { TaskRecord, TaskSpec } from "../../../runtime/plan-manage.ts";
import { prototypeItemId, prototypePath } from "../../../runtime/prototype.ts";
import type { ScriptedReply } from "../../helpers/controlled-provider.ts";
import { createPmRunWorld, until } from "../../helpers/run-manager-fixture.ts";
import { acceptanceConfig } from "../helpers/installed-host.ts";
import { call, messageText, NA, pointEvidence, taskKey } from "../helpers/point-pm.ts";
import { createRealModel } from "../helpers/real-model.ts";

const config = acceptanceConfig();
const cleanups: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });

const BODY = "## 背景 {#background}\n用户未说明。\n## 需求 {#requirements}\n做一个手机号验证码登录页面。\n## 功能 {#features}\n页面行为如下。\n" +
  "### 手机号登录页面 {#goal.login}\n页面有手机号输入框、验证码输入框和登录按钮，按通过的原型呈现。\n### 验证码失败 {#scenario.failure}\n验证码错误时在按钮下方显示红色的失败提示。\n" +
  "## 实现 {#implementation}\n由 PM 规划。\n## 验收 {#acceptance}\n页面与通过的原型一致，验证码错误时显示失败提示。\n";
const PROTOTYPE = "<!doctype html><html><head><style>.login{width:320px}.error{color:#d93025}</style></head><body><form class=\"login\"><h1>手机号登录</h1>" +
  "<input name=\"phone\" placeholder=\"手机号\"><input name=\"code\" placeholder=\"验证码\"><button>登录</button><p class=\"error\">验证码错误</p></form></body></html>";
const PAGE = "/** 输出登录页面的 HTML；error 为 true 时在按钮下方显示失败提示。 */\nexport function loginPage(error: boolean): string {\n" +
  "  return `<form class=\"login\"><h1>手机号登录</h1><input name=\"phone\" placeholder=\"手机号\"><input name=\"code\" placeholder=\"验证码\"><button>登录</button>${error ? \"<p class=\\\"error\\\">验证码错误</p>\" : \"\"}</form>`;\n}\n" +
  "\nexport const LOGIN_CSS = \".login{width:320px}.error{color:#d93025}\";\n";
const spec = (key: string, patch: Partial<TaskSpec>): TaskSpec => ({ key, role: "worker", goalUnitIds: ["goal.login", "scenario.failure"], constraintUnitIds: [], dependsOn: [],
  writePaths: ["src/"], blockedByQuestionIds: [], maxTurns: 20, objective: "按通过的原型实现登录页面与失败提示", passCriteria: ["页面与通过的原型一致", "验证码错误时显示失败提示"],
  scope: { in: ["登录页面"], out: ["短信发送"] }, performance: NA, ...patch });
const verdict = (summary: string, verificationIds: Array<string | undefined> = []): ScriptedReply =>
  call("result_submit", { action: "verdict", result: { checkRoundId: null, verificationIds, summary, findings: [] } });
const field = (request: Context, name: string) => new RegExp(`${name}\\\\*":\\\\*"([0-9a-f-]{36})`).exec(messageText(request.messages.at(-1)))?.[1];

test.skipIf(!config || process.platform !== "darwin")("P10：界面任务的原型已被用户通过、实现已过审，QA 验收时读取那份通过的原型文件对照检查", async () => {
  const evidence = await pointEvidence(config!, "p10");
  const w = await createPmRunWorld(cleanups, { body: BODY });
  const real = await createRealModel(w.fixture.root, config!);
  cleanups.push(() => real.close(evidence));
  const tasks = () => w.db((db) => db.list<TaskRecord>(TASKS).map((row) => row.data));
  const task = (key: string) => tasks().find((entry) => entry.key === key)!;
  const round = () => w.db((db) => activeCheckRoundIn(db, w.fixture.repoId, w.fixture.requirementId)?.data.checkRoundId ?? null);

  // 原型、实现与审查由脚本完成；PM 按状态推进到派出 QA；QA 由真实模型完成
  type Step = ScriptedReply | ((request: Context) => ScriptedReply);
  const scripts = new Map<string, Step[]>([["page", [call("result_submit", { action: "prototype", html: PROTOTYPE, note: "表单居中，失败提示红色" })]]]);
  const sent = new Set<string>();
  let qaTurns = 0;
  w.provider.awaitReply = async (request) => {
    const key = taskKey(request);
    if (key === "acceptance") return qaTurns++ < 20 ? real.answer(request) : { type: "text", text: "结束" };
    if (key) { const step = scripts.get(key)?.shift(); return (typeof step === "function" ? step(request) : step) ?? { type: "text", text: "完成" }; }
    const page = task("page"), qa = task("acceptance");
    if (page?.status === "awaiting_review" && !sent.has("review")) { sent.add("review"); return call("agent_manage", { action: "dispatch", taskId: page.taskId, review: { maxTurns: 4 } }); }
    if (page?.status === "completed" && !round() && qa?.status === "pending" && !sent.has("advance")) { sent.add("advance"); return call("workflow_manage", { action: "advance" }); }
    if (round() && qa?.status === "pending" && !sent.has("qa")) { sent.add("qa"); return call("agent_manage", { action: "dispatch", taskId: qa.taskId }); }
    return { type: "text", text: "PM 已核对" };
  };

  await w.plan.execute({ action: "propose", tasks: [spec("page", { ui: true }),
    spec("acceptance", { role: "qa", writePaths: [], dependsOn: ["page"], objective: "黑盒验收登录页面与失败提示" })] });
  await w.plan.execute({ action: "confirm", planVersion: 1 });
  await w.manager.dispatchTask({ pmRunId: w.pm.runId, taskId: task("page").taskId, retry: null, prototype: { maxTurns: 4 } });
  await until(() => task("page").prototypeRun?.outcome !== "running" && (task("page").prototypes?.length ?? 0) > 0, 3_000);
  const item = (await w.manager.overviews())[0]!.pendingItems.find((entry) => entry.itemId === prototypeItemId(task("page").taskId))!;
  await w.manager.decidePrototype({ requirementId: w.fixture.requirementId, itemId: item.itemId, itemVersion: item.version, choice: "accept", opinion: null });
  const prototype = prototypePath({ dataRoot: w.fixture.dataRoot, repoId: w.fixture.repoId }, w.fixture.requirementId, "page", 1);

  scripts.set("page", [
    call("change_apply", { action: "apply", operationId: uuidv7(), files: [{ path: "src/login-page.ts", baseHash: "absent", content: PAGE }] }),
    verdict("按原型新增 src/login-page.ts"),
    call("verification_run", { action: "run", kind: "debug", command: "test -f src/login-page.ts", performance: NA }),
    (request) => verdict("实现与原型一致", [field(request, "verificationId")]),
  ]);
  await w.manager.dispatchTask({ pmRunId: w.pm.runId, taskId: task("page").taskId, retry: null });
  for (let waited = 0; waited < 900 && !["completed", "failed", "awaiting_parent", "awaiting_user"].includes(task("acceptance").status); waited++) {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }

  const calls = real.toolCalls();
  const reads = calls.filter((block) => block.name === "read" && String(block.arguments.path ?? "") === prototype);
  await writeFile(join(evidence, "judgement.json"), `${JSON.stringify({ prototype, qaTurns, qaStatus: task("acceptance").status,
    calls: calls.map((block) => ({ name: block.name, arguments: block.arguments })) }, null, 2)}\n`, { mode: 0o600 });
  expect(qaTurns, "真实模型没有被调用：QA 没有派出").toBeGreaterThan(0);
  expect(reads.length, JSON.stringify(calls.map((block) => [block.name, block.arguments.path ?? block.arguments.action]))).toBeGreaterThan(0);
}, 20 * 60_000);
