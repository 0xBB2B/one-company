import { afterEach, expect, test } from "vitest";
import { join } from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { registerAskTool } from "../../daemon/requirement-agent.ts";
import { RelayQueue } from "../../daemon/relay-queue.ts";
import { RunManager } from "../../daemon/run-manager.ts";
import { createClock } from "../../runtime/clock.ts";
import { repositoryDatabase, withDatabase } from "../../runtime/database.ts";
import { appendDecision, decisionStream } from "../../runtime/decisions.ts";
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

test.each(["review", "acceptance"] as const)("旧%s失败轮次及USER返修记录不再授权派工，历史结果保全", async (gate) => {
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
  const database = repositoryDatabase(home.dataRoot, repoId);
  withDatabase(database, (db) => {
    for (const effect of [`repair:${gate}:3`, `repair:${gate}:4`, `repair:${gate === "review" ? "acceptance" : "review"}:4`]) {
      db.append(decisionStream(requirement, "user"), { id: `USER-${effect}`, actor: "user", requirement, effects: [effect] });
    }
  });
  const records = () => withDatabase(database, (db) => JSON.stringify({ runs: db.list("runs"), sessions: db.list("sessions"), decisions: db.events(decisionStream(requirement, "user")) }));
  const before = records();
  let registered = 0;
  registerAskTool({ registerTool: () => { registered++; } } as never, {} as never, { count: 0 });
  expect(registered).toBe(0);
  scriptReplies(provider, [{ type: "text", text: "不应启动" }]);
  for (const answer of ["停止", "继续返修"]) {
    await expect(appendDecision({ requirement, actor: "user", source: "中继", trigger: "继续返修", decision: answer, effects: [`repair:${gate}:4`], alternatives: [], impact: "一轮" }, ctx)).rejects.toThrow("永久淘汰");
    await expect(dispatch()).rejects.toThrow("永久淘汰");
  }
  await new Promise((resolve) => setTimeout(resolve, 1150));
  expect(provider.requests).toEqual([]);
  expect(records()).toBe(before);
  expect((await store.list({ requirement, kind: "role", limit: 100 })).items).toHaveLength(4);
}, 20000);
