import { afterEach, expect, test } from "vitest";
import { join } from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { RelayQueue } from "../../daemon/relay-queue.ts";
import { RunManager } from "../../daemon/run-manager.ts";
import { createClock } from "../../runtime/clock.ts";
import { repositoryDatabase } from "../../runtime/database.ts";
import { collectGitSnapshot } from "../../runtime/git-snapshot.ts";
import { repositoryIdentity } from "../../runtime/identity.ts";
import { NetworkPauseGate } from "../../runtime/network-pause.ts";
import { defaultRoleDir, loadRoleCatalog } from "../../runtime/roles.ts";
import { RunStore } from "../../runtime/run-store.ts";
import { ShellRegistry } from "../../runtime/shell-registry.ts";
import { registerControlledProvider, scriptReplies } from "../helpers/controlled-provider.ts";
import { createRepoFixture, removeRepoFixture } from "../helpers/repo-fixture.ts";
import { createTempHome, removeTempHome } from "../helpers/temp-home.ts";

import { mkdir, writeFile } from "node:fs/promises";
import { openSettingsPage } from "../../extensions/settings.ts";
import { loadRoleSettings, saveRoleSettings, settingsPaths } from "../../runtime/settings.ts";
import type { SettingsComponent } from "../../runtime/settings-ui.ts";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

test("真实设置页配置作用于 SDK 派工，项目角色按信任装载，缺失 MCP 不阻塞无依赖任务", async () => {
  const repo = await createRepoFixture(); cleanup.push(() => removeRepoFixture(repo));
  const home = await createTempHome(); cleanup.push(() => removeTempHome(home));
  const { repoId } = await repositoryIdentity(repo.root);
  const requirement = "2026-09-10.settings-dispatch";
  const clock = createClock(); cleanup.push(async () => clock.stopGapWatcher());
  const store = new RunStore({ dataRoot: home.dataRoot, repoId, daemonStartedAt: "返修集成" });
  const shells = new ShellRegistry({ clock, database: repositoryDatabase(home.dataRoot, repoId) });
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, modelsStorePath: join(home.home, "models.json"), refreshOnCreate: false });
  const providers = ["settings-global", "settings-project"].map((providerId) => registerControlledProvider(runtime, { providerId, modelId: "test" }));
  const catalog = await loadRoleCatalog({ defaultDir: defaultRoleDir(), userDir: join(home.agentDir, "agents"), projectDir: join(repo.root, ".pi/agents"), projectTrusted: false, parseFrontmatter });
  const relay = new RelayQueue({ dataDir: join(home.dataRoot, "repos", repoId), deliver: async () => [], locateRequirementAgent: () => undefined });
  const manager = new RunManager({ dataRoot: home.dataRoot, repoId, runStore: store, shellRegistry: shells, networkGate: new NetworkPauseGate(), relayQueue: relay, roleCatalog: catalog.roles, runtime, selectModel: () => ({ provider: "missing-fallback", id: "test" }), clock, workspaceRepoIds: [repoId], emit: () => {} });
  manager.markStarted(); cleanup.push(() => manager.close());

  const projectRole = join(repo.root, ".pi", "agents", "reviewer.md");
  await mkdir(join(repo.root, ".pi", "agents"), { recursive: true });
  await writeFile(projectRole, "---\nname: reviewer\ndescription: 项目审查角色\nkind: review\ntools: [read, structured_output]\nskills: false\ncontext_files: false\nprompt_mode: append\n---\n项目角色已受信任标记\n");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = home.agentDir;
  try {
    let component: SettingsComponent;
    let redraws = 0;
    await openSettingsPage({ hasUI: true, cwd: repo.root, isProjectTrusted: () => true,
      modelRegistry: { getAvailable: () => runtime.getModels() }, model: { provider: providers[0]!.providerId, id: "test" }, thinkingLevel: "off",
      ui: { notify: () => {}, setEditorComponent: (factory: any) => { if (factory) component = factory({ terminal: { rows: 40 }, requestRender: () => { redraws += 1; } }); } },
    });
    for (let i = 0; i < 5 && !component!.render(200).join("\n").includes("[reviewer]"); i++) component!.handleInput("\x1b[C");
    expect(component!.render(200).join("\n")).toContain("[reviewer]");
    const paths = await settingsPaths({ agentDir: home.agentDir, repoRoot: repo.root, projectTrusted: true });
    for (const [index, provider] of providers.entries()) {
      const previousRedraws = redraws;
      if (index === 1) component!.handleInput("\t");
      component!.handleInput("\r");
      for (const ch of provider.providerId) component!.handleInput(ch);
      component!.handleInput("\r");
      let saved;
      for (let i = 0; i < 200; i++) {
        saved = await loadRoleSettings(paths, { roleNames: catalog.roles.map((role) => role.name) });
        if ((index === 0 ? saved.global : saved.project)?.roles.reviewer?.model === `${provider.providerId}/test` && redraws > previousRedraws) break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect((index === 0 ? saved!.global : saved!.project)?.roles.reviewer?.model).toBe(`${provider.providerId}/test`);
    }
    component!.handleInput("\x1b");
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }
  const settings = await settingsPaths({ agentDir: home.agentDir, repoRoot: repo.root, projectTrusted: false });
  const saved = await loadRoleSettings(settings, { roleNames: catalog.roles.map((role) => role.name) });
  await saveRoleSettings(settings.global, { role: "reviewer", patch: { mcp: ["missing-browser"] }, baseline: saved.global.raw });
  const snapshot = await collectGitSnapshot({ repoRoot: repo.root });
  for (const [index, provider] of providers.entries()) {
    scriptReplies(provider, [{ type: "text", text: "等待补充", chunkDelayMs: 200 }]);
    const next = await manager.dispatchReview({ requirement, cwd: repo.root, baseline: snapshot.head, snapshot, context: { projectTrusted: index === 1, model: { provider: "missing-fallback", id: "test" }, thinking: "off" } });
    for (let i = 0; i < 200 && provider.requests.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]!.systemPrompt?.includes("项目角色已受信任标记")).toBe(index === 1);
    const stored = await store.get(next.runId);
    expect(stored.ok && stored.run.model.provider).toBe(provider.providerId);
    expect(stored.ok && stored.run.mcp).toEqual([]);
    await manager.stop(next.runId);
  }
  expect((await loadRoleSettings(settings, { roleNames: catalog.roles.map((role) => role.name) })).global.roles.reviewer?.mcp).toEqual(["missing-browser"]);
}, 20000);
