import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { readPlanIn } from "../../../runtime/plan-manage.ts";
import { createPmRunWorld } from "../../helpers/run-manager-fixture.ts";
import { acceptanceConfig } from "../helpers/installed-host.ts";
import { messageText, NA, pointEvidence, realPm } from "../helpers/point-pm.ts";
import { createRealModel } from "../helpers/real-model.ts";

const config = acceptanceConfig();
const cleanups: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });

const FEATURES = "## 背景 {#background}\n用户未说明。\n## 需求 {#requirements}\n增加手机号验证码登录。\n" +
  "## 功能 {#features}\n登录行为如下。\n### 手机号正常登录 {#goal.login}\n输入正确验证码后成功。\n### 验证码失败 {#scenario.failure}\n错误验证码显示失败。\n";
const HINT = "### 剩余次数提示 {#goal.hint}\n验证码错误时，提示还剩几次尝试机会，每个手机号最多尝试 5 次。\n";
const TAIL = "## 实现 {#implementation}\n由 PM 规划。\n## 验收 {#acceptance}\n正确验证码登录成功，错误验证码显示失败。\n";

test.skipIf(!config || process.platform !== "darwin")("P12：计划已确认、实施中用户批准了追加剩余次数提示的新版本，PM 读差异后把计划更新并确认到新版本，新目标有任务覆盖", async () => {
  const evidence = await pointEvidence(config!, "p12");
  const w = await createPmRunWorld(cleanups, { body: FEATURES + TAIL });
  const real = await createRealModel(w.fixture.root, config!);
  cleanups.push(() => real.close(evidence));
  const current = () => w.db((db) => readPlanIn(db, w.fixture.requirementId));
  let revision = 0;
  const pm = realPm(w.provider, real, { evidence, maxTurns: 15, stopWhen: () => (current()?.plan.confirmedRevision ?? 0) >= revision,
    startWhen: (request) => /已批准更新：revision/.test(messageText(request.messages.at(-1))) });

  await w.plan.execute({ action: "propose", tasks: [{ key: "login", role: "worker", goalUnitIds: ["goal.login", "scenario.failure"], constraintUnitIds: [], dependsOn: [],
    writePaths: ["src/"], blockedByQuestionIds: [], maxTurns: 6, objective: "实现手机号验证码登录：正确验证码成功，错误验证码失败",
    passCriteria: ["正确验证码登录成功，错误验证码显示失败"], scope: { in: ["手机号登录"], out: ["微信登录"] }, performance: NA }] });
  await w.plan.execute({ action: "confirm", planVersion: 1 });
  await w.fixture.approveRevision({ body: FEATURES + HINT + TAIL });
  revision = w.fixture.state.read(w.fixture.requirementId).data.revision;
  await pm.settled();

  const plan = current()!;
  const covering = plan.tasks.filter((task) => task.status !== "cancelled" && [...task.goalUnitIds, ...task.constraintUnitIds].includes("goal.hint"));
  await writeFile(join(evidence, "judgement.json"), `${JSON.stringify({ revision, realTurns: pm.turns(), confirmedRevision: plan.plan.confirmedRevision,
    tasks: plan.tasks.map((task) => ({ key: task.key, status: task.status, goalUnitIds: task.goalUnitIds })),
    calls: real.toolCalls().map((block) => ({ name: block.name, arguments: block.arguments })) }, null, 2)}\n`, { mode: 0o600 });
  expect(revision).toBeGreaterThan(1);
  expect(pm.turns(), "真实模型没有被调用：PM 没收到新版本通知").toBeGreaterThan(0);
  expect(plan.plan.confirmedRevision, JSON.stringify(plan.plan)).toBe(revision);
  expect(covering.length, JSON.stringify(plan.tasks.map((task) => [task.key, task.goalUnitIds]))).toBeGreaterThan(0);
}, 15 * 60_000);
