import { afterEach, expect, test } from "vitest";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { RunManager } from "../../daemon/run-manager.ts";
import { RelayQueue } from "../../daemon/relay-queue.ts";
import { createClock } from "../../runtime/clock.ts";
import { repositoryIdentity } from "../../runtime/identity.ts";
import { putRecord, repositoryDatabase, withDatabase } from "../../runtime/database.ts";
import { decisionStream } from "../../runtime/decisions.ts";
import { NetworkPauseGate } from "../../runtime/network-pause.ts";
import { RunStore } from "../../runtime/run-store.ts";
import { ShellRegistry } from "../../runtime/shell-registry.ts";
import { requirementStateRef } from "../../runtime/workflow-state.ts";
import { executeWorkflowAction } from "../../runtime/workflow-tool.ts";
import { registerControlledProvider, scriptReplies } from "../helpers/controlled-provider.ts";
import { createRepoFixture, removeRepoFixture } from "../helpers/repo-fixture.ts";
import { createTempHome, removeTempHome } from "../helpers/temp-home.ts";

const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

test("旧默认完整工作流永久拒绝：USER/shape/skipped不能派工、交付或自动结束，原数据保留", async () => {
  const repo = await createRepoFixture(); cleanup.push(() => removeRepoFixture(repo));
  const home = await createTempHome(); cleanup.push(() => removeTempHome(home));
  const requirement = "2026-09-10.complete-workflow";
  const reqDir = join(repo.root, ".pi-company/requirements", requirement);
  await mkdir(reqDir, { recursive: true });
  const bytes = "测试自建旧目标：不可加载为执行上下文";
  const path = join(reqDir, "requirements.md"); await writeFile(path, bytes);
  const { repoId } = await repositoryIdentity(repo.root);
  const ctx = { dataRoot: home.dataRoot, cwd: repo.root, requirement };
  const database = repositoryDatabase(home.dataRoot, repoId);
  putRecord(requirementStateRef(home.dataRoot, repoId, requirement), { requirement, stage: "confirmed", tasks: {},
    shape: { tasks: [{ id: "T-1", roles: ["worker"] }], decisionId: "USER-001", skipped: [{ gate: "whiteboxReview", decisionId: "USER-001" }] } });
  withDatabase(database, (db) => db.append(decisionStream(requirement, "user"), { id: "USER-001", actor: "user", effects: ["scope"] }));
  const clock = createClock(); cleanup.push(() => clock.stopGapWatcher());
  const store = new RunStore({ dataRoot: home.dataRoot, repoId, daemonStartedAt: "retired-workflow" });
  const shells = new ShellRegistry({ clock, database });
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, modelsStorePath: join(home.home, "models.json"), refreshOnCreate: false });
  const provider = registerControlledProvider(runtime, { providerId: "retired-workflow", modelId: "test" });
  scriptReplies(provider, [{ type: "toolcall", name: "bash", input: { command: "printf forbidden > README.md" } }]);
  const relay = new RelayQueue({ dataDir: join(home.dataRoot, "repos", repoId), deliver: async () => [], locateRequirementAgent: () => undefined });
  let selections = 0;
  const manager = new RunManager({ ...ctx, repoId, runStore: store, shellRegistry: shells, networkGate: new NetworkPauseGate(), relayQueue: relay,
    roleCatalog: [], runtime, selectModel: () => { selections++; return { provider: provider.providerId, id: "test" }; }, clock, workspaceRepoIds: [repoId], emit: () => {} });
  manager.markStarted(); cleanup.push(() => manager.close());
  const snapshot = () => withDatabase(database, (db) => JSON.stringify({ requirements: db.list("requirements"), runs: db.list("runs"), sessions: db.list("sessions"), decisions: db.events(decisionStream(requirement, "user")) }));
  const before = snapshot(), source = await readFile(join(repo.root, "README.md"), "utf8");
  expect("dispatchRequirement" in manager).toBe(false);
  for (const action of ["advance", "shape-confirm", "task-start", "task-finish"]) {
    expect(await executeWorkflowAction({ action, requirement, decisionId: "USER-001", version: 1, stage: "accepted", task: "T-1", result: { verdict: "PASS" } }, ctx)).toMatchObject({ ok: false });
  }
  await expect(manager.verifyDelivery("legacy-run", requirement)).rejects.toThrow("永久淘汰");
  await new Promise((resolve) => setTimeout(resolve, 1150));
  expect(provider.requests).toEqual([]); expect(selections).toBe(0);
  expect(snapshot()).toBe(before); expect(shells.list()).toEqual([]);
  expect(await readFile(path, "utf8")).toBe(bytes);
  expect(await readFile(join(repo.root, "README.md"), "utf8")).toBe(source);
}, 20000);
