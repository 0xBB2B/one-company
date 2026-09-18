import { afterEach, expect, test } from "vitest";
import { join } from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { RelayQueue } from "../../daemon/relay-queue.ts";
import { RunManager } from "../../daemon/run-manager.ts";
import { createClock } from "../../runtime/clock.ts";
import { repositoryDatabase } from "../../runtime/database.ts";
import { createRoleSession } from "../../daemon/role-session.ts";
import { createRangeProtection } from "../../runtime/range-protection.ts";
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
import { loadRoleSettings, resolveRoleSettings, saveRoleSettings, settingsPaths } from "../../runtime/settings.ts";
import type { SettingsComponent } from "../../runtime/settings-ui.ts";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

test("真实设置页与SDK角色：项目配置按信任装载，缺失MCP不阻塞只读任务；设置不复活旧派工", async () => {
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
  for (const [index, provider] of providers.entries()) {
    const projectTrusted = index === 1;
    const paths = await settingsPaths({ agentDir: home.agentDir, repoRoot: repo.root, projectTrusted });
    const layers = await loadRoleSettings(paths, { roleNames: catalog.roles.map((role) => role.name) });
    const resolved = resolveRoleSettings("reviewer", layers, { mainModel: "missing-fallback/test", mainThinking: "off",
      models: providers.map((entry) => ({ id: `${entry.providerId}/test`, thinkingLevels: ["off"] })), availableMcp: [] });
    expect(resolved.model).toBe(`${provider.providerId}/test`);
    expect(resolved.mcp).toMatchObject({ enabled: [], unavailable: ["missing-browser"] });
    const roles = await loadRoleCatalog({ defaultDir: defaultRoleDir(), userDir: join(home.agentDir, "agents"), projectDir: join(repo.root, ".pi/agents"), projectTrusted, parseFrontmatter });
    const selected = roles.roles.find((entry) => entry.name === "reviewer")!;
    expect(selected.definition?.body.includes("项目角色已受信任标记")).toBe(projectTrusted);
    const run = await store.create({ kind: "role", standalone: true, role: "pi-company.reviewer", requirement, task: "设置夹具",
      cwd: repo.root, writePaths: [], readPaths: [repo.root], model: { provider: provider.providerId, id: "test" }, thinking: resolved.thinking, mcp: resolved.mcp.enabled });
    const protection = await createRangeProtection({ cwd: repo.root, dataRoot: home.dataRoot, holder: { kind: "role", runId: run.id, requirement }, writePaths: [], clock, shells });
    cleanup.push(() => protection.release());
    scriptReplies(provider, [{ type: "text", text: "只读设置检查完成" }]);
    const handle = await createRoleSession({ dataRoot: home.dataRoot, repoId, runId: run.id, shellToken: run.shellToken, cwd: repo.root,
      roleName: "reviewer", role: selected, task: run.task, readPaths: [repo.root], writePaths: [], runtime,
      modelRef: run.model, thinking: resolved.thinking, clock, shellRegistry: shells, guards: protection,
      networkGate: new NetworkPauseGate(), contract: { kind: "plain", completion: "complete-on-idle" } });
    cleanup.push(async () => { await handle.stop(); handle.dispose(); });
    handle.prompt("读取设置对应角色"); await handle.result();
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]!.systemPrompt?.includes("项目角色已受信任标记")).toBe(projectTrusted);
    await expect(manager.dispatchReview({ requirement, cwd: repo.root, baseline: "old", snapshot: { head: "old", fingerprint: "old" }, context: { projectTrusted } })).rejects.toThrow("永久淘汰");
    expect(provider.requests).toHaveLength(1);
  }
  expect((await loadRoleSettings(settings, { roleNames: catalog.roles.map((role) => role.name) })).global.roles.reviewer?.mcp).toEqual(["missing-browser"]);
}, 20000);
