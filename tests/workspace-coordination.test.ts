import { afterEach, expect, test } from "vitest";
import { join } from "node:path";
import { awaitCrossRepoStage, evaluateCrossRepoStage, registerAskTool } from "../daemon/requirement-agent.ts";
import { RelayQueue } from "../daemon/relay-queue.ts";
import { RunStore } from "../runtime/run-store.ts";
import { repositoryIdentity } from "../runtime/identity.ts";
import { appendDecision, decisionStream } from "../runtime/decisions.ts";
import { createRecord, repositoryDatabase, uuidv7, withDatabase } from "../runtime/database.ts";
import { requirementStateRef } from "../runtime/workflow-state.ts";
import { createRepoFixture, removeRepoFixture } from "./helpers/repo-fixture.ts";
import { createTempHome, removeTempHome } from "./helpers/temp-home.ts";

const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

async function world() {
  const repo = await createRepoFixture(); cleanup.push(() => removeRepoFixture(repo));
  const other = await createRepoFixture(); cleanup.push(() => removeRepoFixture(other));
  const home = await createTempHome(); cleanup.push(() => removeTempHome(home));
  const repoId = (await repositoryIdentity(repo.root)).repoId;
  const otherId = (await repositoryIdentity(other.root)).repoId;
  const requirement = "2026-09-10.coordination";
  const database = repositoryDatabase(home.dataRoot, repoId);
  const store = new RunStore({ dataRoot: home.dataRoot, repoId, daemonStartedAt: "boundary-test" });
  const run = await store.create({ kind: "requirement", requirement, task: "历史协调数据", cwd: repo.root,
    writePaths: [], readPaths: [], model: { provider: "test", id: "test" }, thinking: "off", mcp: [] });
  const questionId = uuidv7();
  withDatabase(database, (db) => {
    db.create("relay_questions", questionId, { id: questionId, status: "pending", requirement, repoId, runId: run.id,
      question: "旧提问", options: [], recommended: "继续返修", createdAt: new Date().toISOString(), sequence: 1 });
    db.append(decisionStream(requirement, "user"), { id: "USER-001", actor: "user", requirement, effects: ["repair:review:4"] });
  });
  let delivered = 0, injected = 0;
  const queue = new RelayQueue({ dataDir: join(home.dataRoot, "repos", repoId), deliver: async () => { delivered++; return []; },
    locateRequirementAgent: () => ({ inject: () => { injected++; } }) });
  const snapshot = () => withDatabase(database, (db) => JSON.stringify({ runs: db.list("runs"), sessions: db.list("sessions"), questions: db.list("relay_questions"), decisions: db.events(decisionStream(requirement, "user")) }));
  return { repo, home, repoId, otherId, requirement, queue, questionId, snapshot, counts: () => ({ delivered, injected }) };
}

test("跨仓旧accepted记录不解锁执行，缺失损坏及工作区外状态同样拒绝", async () => {
  const w = await world();
  const waitFor = { repo: w.otherId, requirement: w.requirement, stage: "accepted" };
  for (const data of [null, [], {}, { stage: 2 }, { stage: "rejected" }, { stage: "executing" }, { stage: "accepted" }]) {
    expect(evaluateCrossRepoStage(waitFor, true, data)).toMatchObject({ ok: false, reason: expect.stringContaining("永久淘汰") });
  }
  const ref = requirementStateRef(w.home.dataRoot, w.otherId, w.requirement);
  await createRecord(ref, { stage: "accepted" });
  const original = withDatabase(ref.database, (db) => JSON.stringify(db.list(ref.namespace)));
  for (const repos of [[w.repoId, w.otherId], [w.repoId]]) expect(await awaitCrossRepoStage(repos, w.home.dataRoot, waitFor)).toMatchObject({ ok: false });
  expect(withDatabase(ref.database, (db) => JSON.stringify(db.list(ref.namespace)))).toBe(original);
});

test("旧契约提问工具不注册，队列拒绝真实提问且不投递或创建会话", async () => {
  const w = await world(); const before = w.snapshot(); const tools: unknown[] = [];
  registerAskTool({ registerTool: (tool: unknown) => tools.push(tool) } as never, {} as never, { count: 0 });
  expect(tools).toEqual([]);
  await expect(w.queue.ask({ question: "是否调整错误码？", kind: "contract_change", requirement: w.requirement, repoId: w.repoId,
    runId: uuidv7(), options: [], recommended: "" })).rejects.toThrow("永久淘汰");
  expect(w.snapshot()).toBe(before); expect(w.counts()).toEqual({ delivered: 0, injected: 0 });
});

test.each(["继续返修", "停止", "不要继续", "好", "继续返修但先停止"])("旧返修答复不产生新授权或激活旧USER记录：%s", async (answer) => {
  const w = await world(); const before = w.snapshot();
  expect(await w.queue.answer(w.questionId, answer, "window-a")).toMatchObject({ ok: false });
  expect(await w.queue.forward({ requirement: w.requirement, message: answer })).toMatchObject({ delivered: false });
  expect(await w.queue.pendingFor({ windowId: "window-a", repoIds: [w.repoId] })).toEqual({ questions: [], notices: [] });
  expect(w.snapshot()).toBe(before); expect(w.counts()).toEqual({ delivered: 0, injected: 0 });
});

test("旧返修写决定入口拒绝，撤回幂等保留问题数据且不写授权", async () => {
  const w = await world(); const before = w.snapshot();
  await expect(appendDecision({ requirement: w.requirement, actor: "user", source: "中继", trigger: "继续返修", decision: "继续返修",
    alternatives: [], effects: ["repair:review:4"], impact: "一轮" }, { cwd: w.repo.root, dataRoot: w.home.dataRoot })).rejects.toThrow("永久淘汰");
  expect(w.snapshot()).toBe(before);
  const database = repositoryDatabase(w.home.dataRoot, w.repoId);
  const decisions = withDatabase(database, (db) => JSON.stringify(db.events(decisionStream(w.requirement, "user"))));
  await w.queue.withdraw(w.questionId);
  expect(withDatabase(database, (db) => db.read("relay_questions", w.questionId)?.data)).toMatchObject({ id: w.questionId, status: "withdrawn", question: "旧提问" });
  const withdrawn = w.snapshot(); await w.queue.withdraw(w.questionId); expect(w.snapshot()).toBe(withdrawn);
  expect(withDatabase(database, (db) => JSON.stringify(db.events(decisionStream(w.requirement, "user"))))).toBe(decisions);
  expect(w.counts()).toEqual({ delivered: 0, injected: 0 });
});

test("返修轮次或契约字段不能使旧提问注册入口复活", async () => {
  const w = await world(); const before = w.snapshot();
  for (const fields of [{ repairGate: "review" }, { repairRound: 4 }, { contractChange: { field: "code" } }]) {
    const tools: unknown[] = [];
    registerAskTool({ registerTool: (tool: unknown) => tools.push(tool) } as never, fields as never, { count: 0 });
    expect(tools).toEqual([]);
  }
  expect(w.snapshot()).toBe(before); expect(w.counts()).toEqual({ delivered: 0, injected: 0 });
});
