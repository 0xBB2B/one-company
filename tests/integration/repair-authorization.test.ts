import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { registerAskTool } from "../../daemon/requirement-agent.ts";
import { RelayQueue } from "../../daemon/relay-queue.ts";
import { RunManager } from "../../daemon/run-manager.ts";
import { createClock } from "../../runtime/clock.ts";
import { repositoryDatabase } from "../../runtime/database.ts";
import { appendDecision } from "../../runtime/decisions.ts";
import { collectGitSnapshot } from "../../runtime/git-snapshot.ts";
import { repositoryIdentity } from "../../runtime/identity.ts";
import { NetworkPauseGate } from "../../runtime/network-pause.ts";
import { defaultRoleDir, loadRoleCatalog } from "../../runtime/roles.ts";
import { RunStore } from "../../runtime/run-store.ts";
import { ShellRegistry } from "../../runtime/shell-registry.ts";
import { registerControlledProvider, scriptReplies } from "../helpers/controlled-provider.ts";
import { createRepoFixture, removeRepoFixture } from "../helpers/repo-fixture.ts";
import { createTempHome, removeTempHome } from "../helpers/temp-home.ts";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

test.each(["review", "acceptance"] as const)("真实派工：%s 阶段检查三轮后阻塞，拒答不授权，明确授权仅限本项检查本轮", async (gate) => {
  const repo = await createRepoFixture(); cleanup.push(() => removeRepoFixture(repo));
  const home = await createTempHome(); cleanup.push(() => removeTempHome(home));
  const { repoId } = await repositoryIdentity(repo.root);
  const requirement = "2026-09-10.repair-authorization";
  const ctx = { dataRoot: home.dataRoot, cwd: repo.root, requirement };
  const clock = createClock(); cleanup.push(async () => clock.stopGapWatcher());
  const store = new RunStore({ dataRoot: home.dataRoot, repoId, daemonStartedAt: "返修集成" });
  const shells = new ShellRegistry({ clock, database: repositoryDatabase(home.dataRoot, repoId) });
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, modelsStorePath: join(home.home, "models.json"), refreshOnCreate: false });
  const provider = registerControlledProvider(runtime, { providerId: "repair-reviewer", modelId: "test" });
  const catalog = await loadRoleCatalog({ defaultDir: defaultRoleDir(), userDir: join(home.agentDir, "agents"), projectDir: join(repo.root, ".pi/agents"), projectTrusted: false, parseFrontmatter });
  const relay = new RelayQueue({ dataDir: join(home.dataRoot, "repos", repoId), deliver: async () => [], locateRequirementAgent: () => undefined });
  const manager = new RunManager({ dataRoot: home.dataRoot, repoId, runStore: store, shellRegistry: shells, networkGate: new NetworkPauseGate(), relayQueue: relay, roleCatalog: catalog.roles, runtime, selectModel: () => ({ provider: provider.providerId, id: "test" }), clock, workspaceRepoIds: [repoId], emit: () => {} });
  manager.markStarted(); cleanup.push(() => manager.close());
  const base = { requirement, cwd: repo.root, writePaths: [], readPaths: [repo.root], model: { provider: provider.providerId, id: "test" }, thinking: "off", mcp: [] };
  const failedAttempt = async (task: string) => {
    const run = await store.create({ ...base, kind: "role", phase: gate, role: `pi-company.${gate === "review" ? "reviewer" : "acceptance"}`, standalone: true, task });
    await store.update(run.id, { state: "running" });
    await store.update(run.id, { state: "completed", result: { phase: gate, verdict: "FAIL" } });
  };
  for (let i = 0; i < 4; i++) await failedAttempt(`T-${i + 1}`);
  const snapshot = await collectGitSnapshot({ repoRoot: repo.root });
  const dispatch = () => manager.dispatchReview({ requirement, cwd: repo.root, baseline: snapshot.head, snapshot });
  await expect(dispatch()).rejects.toThrow("AI 归因");
  const attribute = () => appendDecision({ requirement, actor: "ai", source: "需求代理", trigger: "阶段检查失败", decision: "补全输入边界验证", scope: requirement, basis: ["失败用例"], action: "先补测试再修实现", effects: [`repair:${gate}`], alternatives: [] }, ctx);
  await attribute();
  await expect(dispatch()).rejects.toThrow("技术阻塞");
  const user = (effect: string) => appendDecision({ requirement, actor: "user", source: "中继", trigger: "继续返修", decision: "继续返修", effects: [effect], alternatives: [], impact: "新增一轮" }, ctx);
  await user(`repair:${gate === "review" ? "acceptance" : "review"}:4`);
  await user(`repair:${gate}:3`);
  await expect(dispatch()).rejects.toThrow("技术阻塞");

  const parent = await store.create({ ...base, kind: "requirement", task: "返修授权" });
  await store.update(parent.id, { state: "running" });
  let tool: any;
  registerAskTool({ registerTool: (value: unknown) => { tool = value; } } as never, {
    ...ctx, repoId, runId: parent.id, runStore: store, workspaceRepoIds: [repoId],
    relay: { ask: async (input: any) => {
      const question = await relay.ask({ ...input, runId: parent.id });
      const outcome = await question.answer;
      if (!outcome.answered) throw new Error("已撤回");
      return outcome.answer;
    } },
  } as never, { count: 0 });
  async function answer(value: string) {
    const task = tool.execute("repair", { question: "继续处理该技术阻塞？", repairGate: gate, repairRound: 4 }, new AbortController().signal);
    let pending = await relay.pendingFor({ windowId: "test", repoIds: [repoId] });
    for (let i = 0; pending.questions.length === 0 && i < 200; i++) { await Bun.sleep(5); pending = await relay.pendingFor({ windowId: "test", repoIds: [repoId] }); }
    expect(pending.questions).toHaveLength(1);
    expect((await relay.answer(pending.questions[0]!.id, value, "test")).ok).toBe(true);
    await task;
  }
  await answer("停止");
  await expect(dispatch()).rejects.toThrow("技术阻塞");
  expect((await store.list({ requirement, kind: "role", limit: 100 })).items).toHaveLength(4);
  await answer("继续返修");
  scriptReplies(provider, [{ type: "text", text: "等待审查资料" }]);
  const next = await dispatch();
  expect((await store.get(next.runId)).ok).toBe(true);
  await manager.stop(next.runId);
  await failedAttempt("改名重派");
  await attribute();
  await expect(dispatch()).rejects.toThrow("第 4 轮返修");
  expect((await store.list({ requirement, kind: "role", limit: 100 })).items).toHaveLength(6);
}, 20000);
