import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import type { Context } from "@earendil-works/pi-ai";
import { uuidv7 } from "../../../runtime/database.ts";
import { TASKS } from "../../../runtime/plan-manage.ts";
import type { TaskRecord } from "../../../runtime/plan-manage.ts";
import type { ScriptedReply } from "../../helpers/controlled-provider.ts";
import { createPmRunWorld } from "../../helpers/run-manager-fixture.ts";
import { acceptanceConfig } from "../helpers/installed-host.ts";
import { createRealModel } from "../helpers/real-model.ts";

const config = acceptanceConfig();
const cleanups: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });

const NA = { applicable: false as const, reason: "无性能影响" };
const BODY = "## 背景 {#background}\n用户未说明。\n## 需求 {#requirements}\n增加手机号验证码登录。\n" +
  "## 功能 {#features}\n登录行为如下。\n### 手机号正常登录 {#goal.login}\n输入正确验证码后成功。\n### 验证码失败 {#scenario.failure}\n错误验证码显示失败。\n" +
  "## 实现 {#implementation}\n由 PM 规划。\n## 验收 {#acceptance}\n正确验证码登录成功，错误验证码显示失败。\n";
const LOGIN = "export function login(code: string): string {\n  return code === \"1234\" ? \"成功\" : \"失败\";\n}\n";
const MAX_REAL_TURNS = 6;
const call = (name: string, input: Record<string, unknown>): ScriptedReply => ({ type: "toolcall", name: `one_company_${name}`, input });
const taskKey = (request: Context) => /任务：([A-Za-z0-9._-]+)（/.exec(request.systemPrompt ?? "")?.[1];
const text = (value: unknown) => JSON.stringify(value ?? "");

test.skipIf(!config || process.platform !== "darwin")("P5：PM 收到 worker 结束通知后用 verification_run status 查看引用的验证记录，不读子代理会话记录", async () => {
  const cfg = config!;
  const evidence = join(cfg.output, `p5-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  await mkdir(evidence, { recursive: true, mode: 0o700 });
  const w = await createPmRunWorld(cleanups, { body: BODY });
  const real = await createRealModel(w.fixture.root, cfg);
  cleanups.push(() => real.close(evidence));

  const worker: ScriptedReply[] = [
    call("change_apply", { action: "apply", operationId: uuidv7(), files: [{ path: "src/login.ts", baseHash: "absent", content: LOGIN }] }),
    call("verification_run", { action: "run", kind: "debug", command: "test -f src/login.ts", performance: NA }),
  ];
  let verificationId: string | undefined, realTurns = 0, finished = false;
  w.provider.awaitReply = async (request) => {
    if (taskKey(request)) {
      if (worker.length) return worker.shift();
      if (!verificationId) {
        verificationId = /verificationId\\*":\\*"([0-9a-f-]{36})/.exec(text(request.messages.at(-1)))?.[1];
        return call("result_submit", { action: "verdict", result: { checkRoundId: null, verificationIds: [verificationId], summary: "新增 src/login.ts，test -f 通过", findings: [] } });
      }
      return { type: "text", text: "完成" };
    }
    const notified = request.messages.some((message) => message.role === "user" && /子代理运行 \S+ 已结束/.test(text(message.content)));
    if (!notified || finished || realTurns >= MAX_REAL_TURNS) { if (notified) finished = true; return { type: "text", text: "收到" }; }
    if (realTurns === 0) await writeFile(join(evidence, "decision-request.json"), `${JSON.stringify(request, null, 2)}\n`, { mode: 0o600 });
    realTurns += 1;
    const reply = await real.answer(request);
    if (reply.type === "message" && reply.message.stopReason !== "toolUse") finished = true;
    return reply;
  };

  await w.plan.execute({ action: "propose", tasks: [{ key: "impl", role: "worker", goalUnitIds: ["goal.login", "scenario.failure"], constraintUnitIds: [], dependsOn: [],
    writePaths: ["src/"], blockedByQuestionIds: [], maxTurns: 4, objective: "实现手机号验证码登录：正确验证码成功，错误验证码失败",
    passCriteria: ["正确验证码登录成功，错误验证码显示失败"], scope: { in: ["手机号登录"], out: ["微信登录"] }, performance: NA }] });
  await w.plan.execute({ action: "confirm", planVersion: 1 });
  const taskId = w.db((db) => db.list<TaskRecord>(TASKS).map((row) => row.data)).find((task) => task.key === "impl")!.taskId;
  await w.manager.dispatchTask({ pmRunId: w.pm.runId, taskId, retry: null });
  for (let waited = 0; !finished && waited < 600; waited++) await new Promise((resolve) => setTimeout(resolve, 1_000));

  const calls = real.toolCalls();
  const results = w.provider.requests.flatMap((request) => request.messages).flatMap((message) => message.role === "toolResult" ? [message] : []);
  const statuses = calls.filter((block) => block.name === "one_company_verification_run" && block.arguments.action === "status" && block.arguments.verificationId === verificationId);
  const logReads = calls.filter((block) => block.name === "read" && String(block.arguments.path ?? "").endsWith("session.jsonl"));
  await writeFile(join(evidence, "judgement.json"), `${JSON.stringify({ verificationId, realTurns, calls: calls.map((block) => ({ name: block.name, arguments: block.arguments })) }, null, 2)}\n`, { mode: 0o600 });
  expect(verificationId).toBeDefined();
  expect(realTurns, "真实模型没有被调用：PM 没收到 worker 的结束通知").toBeGreaterThan(0);
  expect(logReads, JSON.stringify(calls)).toEqual([]);
  expect(statuses.length, JSON.stringify(calls)).toBeGreaterThan(0);
  expect(results.some((result) => result.toolCallId === statuses[0]!.id && !result.isError), "status 查询返回了错误").toBe(true);
}, 15 * 60_000);
