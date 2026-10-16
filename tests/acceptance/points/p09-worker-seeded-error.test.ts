import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";
import { TASKS } from "../../../src/modules/pm/plan-manage.ts";
import type { TaskRecord } from "../../../src/modules/pm/plan-manage.ts";
import { createPmRunWorld } from "../../helpers/run-manager-fixture.ts";
import { acceptanceConfig } from "../helpers/installed-host.ts";
import { NA, pointEvidence, taskKey } from "../helpers/point-pm.ts";
import { createRealModel } from "../helpers/real-model.ts";

const exec = promisify(execFile);
const config = acceptanceConfig();
const cleanups: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });

const BODY = "## 背景 {#background}\n用户未说明。\n## 需求 {#requirements}\n手机号验证码登录。\n## 功能 {#features}\n登录行为如下。\n" +
  "### 手机号正常登录 {#goal.login}\n验证码正确、并且发出后不超过 5 分钟时，登录成功。\n### 验证码失败 {#scenario.failure}\n验证码错误时登录失败；验证码发出超过 5 分钟也算失败。\n" +
  "## 实现 {#implementation}\n由 PM 规划。\n## 验收 {#acceptance}\n5 分钟内正确验证码登录成功；错误验证码或超过 5 分钟失败。\n";
/** 预埋错误：有效期在另一个文件里写成 10 分钟，且有一条测试断言 8 分钟仍可登录；需求要求 5 分钟。 */
const SEEDED: Record<string, string> = {
  "package.json": `${JSON.stringify({ name: "login-sample", private: true, type: "module", scripts: { test: "node --test" } }, null, 2)}\n`,
  "src/config.ts": "/** 验证码有效期，单位分钟。 */\nexport const CODE_TTL_MINUTES = 10;\n",
  "src/login.ts": [
    "import { CODE_TTL_MINUTES } from \"./config.ts\";",
    "",
    "/** code 为用户输入的验证码，expected 为发出的验证码，ageMinutes 为验证码发出后经过的分钟数。 */",
    "export interface LoginInput { code: string; expected: string; ageMinutes: number }",
    "",
    "/** 验证码一致且未过期时登录成功。 */",
    "export function login(input: LoginInput): \"成功\" | \"失败\" {",
    "  if (input.code !== input.expected) return \"失败\";",
    "  return input.ageMinutes <= CODE_TTL_MINUTES ? \"成功\" : \"失败\";",
    "}",
    "",
  ].join("\n"),
  "src/login.test.ts": [
    "import { test } from \"node:test\";",
    "import assert from \"node:assert/strict\";",
    "import { login } from \"./login.ts\";",
    "",
    "test(\"正确验证码登录成功\", () => assert.equal(login({ code: \"1234\", expected: \"1234\", ageMinutes: 1 }), \"成功\"));",
    "test(\"错误验证码登录失败\", () => assert.equal(login({ code: \"0000\", expected: \"1234\", ageMinutes: 1 }), \"失败\"));",
    "test(\"发出 8 分钟的验证码仍可登录\", () => assert.equal(login({ code: \"1234\", expected: \"1234\", ageMinutes: 8 }), \"成功\"));",
    "",
  ].join("\n"),
};
const PROBE = "import { login } from './src/login.ts';" +
  "console.log(JSON.stringify([4, 5, 6, 8].map((ageMinutes) => login({ code: '1234', expected: '1234', ageMinutes })).concat(login({ code: '0000', expected: '1234', ageMinutes: 1 }))));";

test.skipIf(!config || process.platform !== "darwin")("P9：已有代码把验证码有效期写成 10 分钟且有测试断言错误行为，worker 按需求改对代码与测试：5 分钟内成功、超过即失败，npm test 通过", async () => {
  const evidence = await pointEvidence(config!, "p9");
  const w = await createPmRunWorld(cleanups, { body: BODY });
  const real = await createRealModel(w.fixture.root, config!);
  cleanups.push(() => real.close(evidence));
  const workspace = w.fixture.state.read(w.fixture.requirementId).data.workspace!.path;
  for (const [path, content] of Object.entries(SEEDED)) {
    await mkdir(join(workspace, path, ".."), { recursive: true });
    await writeFile(join(workspace, path), content);
  }
  await exec("git", ["add", "-A"], { cwd: workspace });
  await exec("git", ["-c", "user.name=sample", "-c", "user.email=sample@localhost", "commit", "-qm", "登录初版"], { cwd: workspace });

  let turns = 0;
  w.provider.awaitReply = async (request) => taskKey(request) && turns++ < 25 ? real.answer(request) : { type: "text", text: "收到" };
  await w.plan.execute({ action: "propose", tasks: [{ key: "login", role: "worker", goalUnitIds: ["goal.login", "scenario.failure"], constraintUnitIds: [], dependsOn: [],
    writePaths: ["src/"], blockedByQuestionIds: [], maxTurns: 20, objective: "按已批准需求实现手机号验证码登录：5 分钟内正确验证码成功，错误验证码或超过 5 分钟失败",
    passCriteria: ["5 分钟内正确验证码登录成功", "错误验证码或发出超过 5 分钟登录失败", "npm test 全部通过"], scope: { in: ["验证码登录"], out: ["短信发送"] }, performance: NA }] });
  await w.plan.execute({ action: "confirm", planVersion: 1 });
  const task = () => w.db((db) => db.list<TaskRecord>(TASKS).map((row) => row.data)).find((entry) => entry.key === "login")!;
  const run = await w.manager.dispatchTask({ pmRunId: w.pm.runId, taskId: task().taskId, retry: null });
  for (let waited = 0; waited < 900; waited++) {
    const got = await w.runStore.get(run.runId);
    if (got.ok && got.run.state !== "running" && got.run.state !== "queued") break;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }

  const behavior = await exec(process.execPath, ["--input-type=module", "-e", PROBE], { cwd: workspace }).then((result) => JSON.parse(result.stdout) as string[], (error: Error) => [error.message]);
  const npmTest = await exec("npm", ["test"], { cwd: workspace }).then(() => 0, (error: { code?: number }) => error.code ?? 1);
  await writeFile(join(evidence, "judgement.json"), `${JSON.stringify({ realTurns: turns, taskStatus: task().status, behavior, npmTest,
    calls: real.toolCalls().map((block) => ({ name: block.name, arguments: block.arguments })) }, null, 2)}\n`, { mode: 0o600 });
  expect(turns, "真实模型没有被调用：worker 没有派出").toBeGreaterThan(0);
  expect(behavior, "依次为发出 4、5、6、8 分钟的正确验证码，以及错误验证码").toEqual(["成功", "成功", "失败", "失败", "失败"]);
  expect(npmTest).toBe(0);
}, 20 * 60_000);
