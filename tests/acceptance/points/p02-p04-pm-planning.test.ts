import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { TASKS } from "../../../src/modules/pm/plan-manage.ts";
import type { TaskRecord } from "../../../src/modules/pm/plan-manage.ts";
import { defaultRoleDir } from "../../../src/modules/agents/roles.ts";
import { createPmRunWorld } from "../../helpers/run-manager-fixture.ts";
import { temporaryRoot } from "../../helpers/temporary-root.ts";
import { acceptanceConfig } from "../helpers/installed-host.ts";
import { messageText, pointEvidence, realPm } from "../helpers/point-pm.ts";
import { createRealModel } from "../helpers/real-model.ts";

const config = acceptanceConfig();
const cleanups: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });

const LOGIN = "## 背景 {#background}\n用户未说明。\n## 需求 {#requirements}\n增加手机号验证码登录的后端逻辑。\n## 功能 {#features}\n登录行为如下。\n" +
  "### 手机号正常登录 {#goal.login}\n用 TypeScript 写登录函数：输入手机号和验证码，验证码正确时登录成功。\n### 验证码失败 {#scenario.failure}\n验证码错误时返回失败。\n" +
  "## 实现 {#implementation}\n由 PM 规划。\n## 验收 {#acceptance}\n用 node 单元测试验证正确验证码登录成功、错误验证码失败。\n";
const LOGIN_PAGE = "## 背景 {#background}\n用户未说明。\n## 需求 {#requirements}\n做一个手机号验证码登录页面。\n## 功能 {#features}\n页面行为如下。\n" +
  "### 手机号登录页面 {#goal.login}\n用 TypeScript 写一个函数输出登录表单的 HTML 字符串（手机号输入框、验证码输入框、登录按钮），并导出页面的 CSS。界面怎么设计按项目的界面约定来。\n" +
  "### 验证码失败 {#scenario.failure}\n验证码错误时页面显示失败提示。\n## 实现 {#implementation}\n由 PM 规划。\n## 验收 {#acceptance}\n用 node 单元测试验证页面输出与失败提示。\n";
const AUTH_WORKER = { name: "auth-worker", description: "登录认证专业 worker：负责手机号、验证码登录等认证逻辑的实现与单元测试" };
const UI_WORKER = { name: "ui-worker", description: "界面专业 worker：负责页面、面板等界面的设计与实现，按项目界面约定写 HTML 与 CSS" };
const STACK_WORKERS = ["go", "node", "python", "java", "vue", "react"].map((stack) => `${stack}-worker`);

/** 用户层装上专业 worker，主代理核对通过 PM 的接手理解后由真实模型规划，到计划里出现任务为止。 */
async function plan(name: string, body: string, specialists: Array<{ name: string; description: string }>, disabled: string[] = []) {
  const evidence = await pointEvidence(config!, name);
  const userDir = await mkdtemp(join(temporaryRoot(), "agents-"));
  cleanups.push(() => rm(userDir, { recursive: true, force: true }));
  const worker = await readFile(join(defaultRoleDir(), "worker.md"), "utf8");
  for (const specialist of specialists) {
    await writeFile(join(userDir, `${specialist.name}.md`), worker.replace("name: worker\n", `name: ${specialist.name}\n`).replace(/description: .*\n/u, `description: ${specialist.description}\n`));
  }
  const w = await createPmRunWorld(cleanups, { body, review: false, userDir, loadDisabledAgents: () => new Set(disabled) });
  const real = await createRealModel(w.fixture.root, config!);
  cleanups.push(() => real.close(evidence));
  const tasks = () => w.db((db) => db.list<TaskRecord>(TASKS).map((row) => row.data));
  const pm = realPm(w.provider, real, { evidence, maxTurns: 12, endOnStop: false, stopWhen: () => tasks().length > 0,
    startWhen: (request) => /主代理已核对通过你的接手理解/.test(messageText(request.messages.at(-1))) });
  await w.review(undefined, false);
  await pm.settled();
  const planned = tasks().map((task) => ({ key: task.key, role: task.role, agent: task.agent ?? null, agentReason: task.agentReason ?? null }));
  await writeFile(join(evidence, "judgement.json"), `${JSON.stringify({ realTurns: pm.turns(), planned, calls: real.toolCalls().map((block) => ({ name: block.name, arguments: block.arguments })) }, null, 2)}\n`, { mode: 0o600 });
  return { planned, workers: planned.filter((task) => task.role === "worker"), turns: pm.turns() };
}

test.skipIf(!config || process.platform !== "darwin")("P2：装了对口的登录认证专业 worker，PM 规划登录逻辑时实现任务选用它并写明理由", async () => {
  const { planned, workers } = await plan("p2", LOGIN, [AUTH_WORKER]);
  expect(workers.length, JSON.stringify(planned)).toBeGreaterThan(0);
  expect(workers.every((task) => task.agent === "auth-worker" && Boolean(task.agentReason)), JSON.stringify(planned)).toBe(true);
}, 15 * 60_000);

test.skipIf(!config || process.platform !== "darwin")("P3：只装了不对口的界面专业 worker，PM 规划登录逻辑时实现任务仍用默认 worker", async () => {
  const { planned, workers } = await plan("p3", LOGIN, [UI_WORKER], STACK_WORKERS);
  expect(workers.length, JSON.stringify(planned)).toBeGreaterThan(0);
  expect(workers.every((task) => task.agent === null || task.agent === "worker"), JSON.stringify(planned)).toBe(true);
}, 15 * 60_000);

test.skipIf(!config || process.platform !== "darwin")("P4：登录页面需求，PM 让页面任务选用界面专业 worker 并写明理由", async () => {
  const { planned } = await plan("p4", LOGIN_PAGE, [UI_WORKER]);
  expect(planned.some((task) => task.role === "worker" && task.agent === "ui-worker" && Boolean(task.agentReason)), JSON.stringify(planned)).toBe(true);
}, 15 * 60_000);
