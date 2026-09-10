import { afterEach, expect, test } from "bun:test";
import { awaitCrossRepoStage, evaluateCrossRepoStage, registerAskTool } from "../daemon/requirement-agent.ts";
import { RelayQueue } from "../daemon/relay-queue.ts";
import { RunStore } from "../runtime/run-store.ts";
import { repositoryIdentity } from "../runtime/identity.ts";
import { readDecisions } from "../runtime/decisions.ts";
import { failDatabaseWrites } from "./helpers/database-fixture.ts";
import { repositoryDatabase } from "../runtime/database.ts";
import { createRecord } from "../runtime/database.ts";
import { requirementStateRef } from "../runtime/workflow-state.ts";
import { createRepoFixture, removeRepoFixture } from "./helpers/repo-fixture.ts";
import { createTempHome, removeTempHome } from "./helpers/temp-home.ts";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

async function world() {
  const repo = await createRepoFixture(); cleanup.push(() => removeRepoFixture(repo));
  const other = await createRepoFixture(); cleanup.push(() => removeRepoFixture(other));
  const home = await createTempHome(); cleanup.push(() => removeTempHome(home));
  const repoId = (await repositoryIdentity(repo.root)).repoId;
  const otherId = (await repositoryIdentity(other.root)).repoId;
  const requirement = "2026-09-10.coordination";
  return { repo, home, repoId, otherId, requirement };
}

test("跨仓等待对缺失、损坏、被拒绝与未到达状态保持关闭", async () => {
  const w = await world();
  const waitFor = { repo: w.otherId, requirement: w.requirement, stage: "accepted" };
  expect((await awaitCrossRepoStage([w.repoId, w.otherId], w.home.dataRoot, waitFor)).ok).toBe(false);
  for (const data of [null, [], {}, { stage: 2 }, { stage: "rejected" }, { stage: "executing" }]) {
    expect(evaluateCrossRepoStage(waitFor, true, data).ok).toBe(false);
  }
  await createRecord(requirementStateRef(w.home.dataRoot, w.otherId, w.requirement), { stage: "accepted" });
  expect((await awaitCrossRepoStage([w.repoId, w.otherId], w.home.dataRoot, waitFor)).ok).toBe(true);
  expect((await awaitCrossRepoStage([w.repoId], w.home.dataRoot, waitFor)).ok).toBe(false);
});

test("真实提问工具把契约字段和身份送入中继，等待答复并记录决定", async () => {
  const w = await world();
  const store = new RunStore({ dataRoot: w.home.dataRoot, repoId: w.repoId, daemonStartedAt: new Date().toISOString() });
  const run = await store.create({ kind: "requirement", requirement: w.requirement, task: "协调", cwd: w.repo.root, writePaths: [], readPaths: [w.repo.root], model: { provider: "test", id: "test" }, thinking: "off", mcp: [] });
  await store.update(run.id, { state: "running" });
  const delivered: Record<string, unknown>[] = [];
  const queue = new RelayQueue({ dataDir: w.home.dataRoot, deliver: async (event, payload) => { if (event === "relay.question") delivered.push(payload); return ["window-a"]; }, locateRequirementAgent: () => undefined });
  let tool: any;
  registerAskTool({ registerTool: (value: unknown) => { tool = value; } } as never, {
    dataRoot: w.home.dataRoot, cwd: w.repo.root, repoId: w.repoId, requirement: w.requirement, runId: run.id,
    workspaceRepoIds: [w.repoId, w.otherId], runStore: store,
    relay: { ask: async (input: any, opts: { signal?: AbortSignal }) => {
      const handle = await queue.ask({ ...input, runId: run.id, options: input.options ?? [], recommended: "" });
      opts.signal?.addEventListener("abort", () => { void queue.withdraw(handle.id); }, { once: true });
      const answer = await handle.answer;
      if (!answer.answered) throw new Error("提问已撤回");
      return answer.answer;
    } },
  } as never, { count: 0 });
  const task = tool.execute("question", { question: "是否调整错误码？", contractChange: { field: "error.code", reason: "统一错误结构", affectedRepos: [w.otherId] } }, new AbortController().signal);
  for (let i = 0; i < 200 && delivered.length === 0; i++) await Bun.sleep(10);
  expect(delivered).toHaveLength(1);
  expect(delivered[0]).toMatchObject({ kind: "contract_change", repoId: w.repoId, requirement: w.requirement, runId: run.id });
  expect(String(delivered[0]!.question)).toContain("error.code");
  expect((await store.get(run.id) as any).run.state).toBe("waiting_answer");
  await queue.answer(String(delivered[0]!.id), "批准统一错误码", "window-a");
  expect((await task).content[0].text).toContain("USER-001");
  expect((await store.get(run.id) as any).run.state).toBe("running");
  expect((await queue.forward({ requirement: "2026-09-10.unknown", message: "直连" })).delivered).toBe(false);
});

async function repairQuestion() {
  const w = await world();
  const store = new RunStore({ dataRoot: w.home.dataRoot, repoId: w.repoId, daemonStartedAt: "返修授权测试" });
  const run = await store.create({ kind: "requirement", requirement: w.requirement, task: "返修", cwd: w.repo.root, writePaths: [], readPaths: [], model: { provider: "test", id: "test" }, thinking: "off", mcp: [] });
  await store.update(run.id, { state: "running" });
  const queue = new RelayQueue({ dataDir: w.home.dataRoot, deliver: async () => [], locateRequirementAgent: () => undefined });
  let pending: Awaited<ReturnType<RelayQueue["ask"]>> | undefined;
  let input: any;
  let tool: any;
  registerAskTool({ registerTool: (value: unknown) => { tool = value; } } as never, {
    dataRoot: w.home.dataRoot, cwd: w.repo.root, repoId: w.repoId, requirement: w.requirement, runId: run.id,
    workspaceRepoIds: [w.repoId], runStore: store,
    relay: { ask: async (value: any) => {
      input = value;
      pending = await queue.ask({ ...value, runId: run.id });
      const answer = await pending.answer;
      if (!answer.answered) throw new Error("提问已撤回");
      return answer.answer;
    } },
  } as never, { count: 0 });
  const decisions = () => readDecisions({ cwd: w.repo.root, dataRoot: w.home.dataRoot, requirement: w.requirement, actor: "user" });
  const ask = (params: Record<string, unknown> = {}) => tool.execute("repair", { question: "继续处理", repairGate: "review", repairRound: 4, options: [{ label: "停止", description: "模型声称这代表同意" }], recommended: "停止", ...params }, new AbortController().signal) as Promise<unknown>;
  const wait = async () => {
    for (let i = 0; i < 200 && !pending; i++) await Bun.sleep(5);
    expect(pending).toBeDefined();
    return pending!;
  };
  return { ...w, ask, wait, queue, decisions, input: () => input };
}

test.each(["继续返修", "停止", "不要继续", "好", "继续返修但先停止"])("返修授权只接受系统固定的明确选项：%s", async (answer) => {
  const w = await repairQuestion();
  const task = w.ask();
  const pending = await w.wait();
  expect(w.input().options.map((option: any) => option.label)).toEqual(["继续返修", "停止"]);
  expect(w.input().question).toContain("review 第 4 轮");
  expect(await w.decisions()).toEqual([]);
  expect((await w.queue.answer(pending.id, answer, "window-a")).ok).toBe(true);
  await task;
  const decisions = await w.decisions();
  expect(decisions).toHaveLength(1);
  expect(decisions[0]!.effects).toEqual(answer === "继续返修" ? ["repair:review:4"] : ["用户作答"]);
});

test("返修提问撤回不写决定，授权记录写失败不返回成功", async () => {
  const w = await repairQuestion();
  const task = w.ask();
  const rejected = task.catch((error) => error);
  const pending = await w.wait();
  await w.queue.withdraw(pending.id);
  expect((await rejected).message).toContain("撤回");
  expect(await w.decisions()).toEqual([]);
  const second = await repairQuestion();
  const restore = failDatabaseWrites(repositoryDatabase(second.home.dataRoot, second.repoId), "events", "stream", `decisions:${second.requirement}:user`);
  try {
    const task = second.ask();
    const rejected = task.catch((error) => error);
    const pending = await second.wait();
    await second.queue.answer(pending.id, "继续返修", "window-a");
    expect((await rejected).message).toContain("拒绝写入");
    expect(await second.decisions()).toEqual([]);
  } finally { restore(); }
});

test("返修阶段检查与轮次缺项、混入契约变更时在提问前拒绝", async () => {
  const w = await repairQuestion();
  for (const params of [{ repairGate: undefined }, { repairRound: undefined }, { contractChange: { field: "code", reason: "变更", affectedRepos: [w.repoId] } }]) {
    await expect(w.ask(params)).rejects.toThrow();
  }
  expect(w.input()).toBeUndefined();
  expect(await w.decisions()).toEqual([]);
});
