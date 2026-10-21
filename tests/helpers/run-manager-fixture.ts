import { vi } from "vitest";
import { join } from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { RunManager } from "../../src/app/daemon/run-manager.ts";
import type { RunManagerOptions } from "../../src/app/daemon/run-manager.ts";
import { ProjectIndexHost } from "../../src/app/daemon/project-index-host.ts";
import { createClock } from "../../src/core/policy/clock.ts";
import { repositoryDatabase, uuidv7, withDatabase } from "../../src/core/storage/database.ts";
import { NetworkPauseGate } from "../../src/core/host/network-pause.ts";
import { readNoticedDiffs } from "./pm-diff-read.ts";
import { createPlanManageTool } from "../../src/modules/pm/plan-manage.ts";
import { createPmIntakeProviders, PM_INTAKE_TOOL } from "../../src/modules/pm/pm-intake-runtime.ts";
import type { IntakeReviewDecision } from "../../src/modules/pm/pm-intake-service.ts";
import { readAgentSettings } from "../../src/modules/settings/agent-settings.ts";
import { defaultRoleDir, loadRoleCatalog } from "../../src/modules/agents/roles.ts";
import { RunStore } from "../../src/modules/agents/run-store.ts";
import { ShellRegistry } from "../../src/core/host/shell-registry.ts";
import { registerControlledProvider } from "./controlled-provider.ts";
import { createPmIntakeFixture } from "./pm-intake-fixture.ts";

export async function until(check: () => boolean | Promise<boolean>, limit = 600): Promise<void> {
  for (let i = 0; i < limit; i++) { if (await check()) return; await new Promise((resolve) => setTimeout(resolve, 10)); }
  throw new Error("等待超时");
}

/**
 * 真实 RunManager 派出的 PM：夹具原有租约已交还、工作区登记为 ready，PM 以脚本化模型提交接手理解。
 * review 为 false 时不做主代理核对，由用例自行调用 review()。
 */
export async function createPmRunWorld(cleanups: Array<() => unknown | Promise<unknown>>, options: { review?: boolean; web?: RunManagerOptions["web"]; index?: boolean; body?: string; userDir?: string; reloadCatalog?: boolean;
  loadAgentSettings?: RunManagerOptions["loadAgentSettings"]; thinking?: string; loadDisabledAgents?: () => Set<string> } = {}) {
  const fixture = await createPmIntakeFixture(options.body === undefined ? {} : { body: options.body }); cleanups.push(() => fixture.cleanup());
  const record = fixture.state.read(fixture.requirementId).data;
  const db = <T>(run: Parameters<typeof withDatabase<T>>[1]) => withDatabase(repositoryDatabase(fixture.dataRoot, fixture.repoId), run);
  db((d) => {
    d.create("managed_workspaces", fixture.requirementId, { format: "managed-workspace/v1", requirementId: fixture.requirementId, title: "角色跳跃", operationId: uuidv7(),
      baseCommit: record.workspace!.baseCommit, branch: record.workspace!.branch, path: record.workspace!.path, status: "ready", recycleOperationId: null });
  });
  const captured = fixture.captureCurrent();
  const material = await fixture.submissionProvider.loadCurrent({ binding: captured.binding, sourceDirectoryHash: captured.sourceDirectoryHash,
    maxBytes: 49_152, signal: new AbortController().signal });
  const { format: _format, binding: _binding, ...understanding } = material!.understanding;
  fixture.state.releasePm(fixture.lease);
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, modelsStorePath: join(fixture.root, "models.json"), refreshOnCreate: false });
  const provider = registerControlledProvider(runtime, { providerId: "team-model", modelId: "test" });
  const clock = createClock(); cleanups.push(() => clock.stopGapWatcher());
  const runStore = new RunStore({ dataRoot: fixture.dataRoot, repoId: fixture.repoId, daemonStartedAt: new Date().toISOString() });
  const loadCatalog = () => loadRoleCatalog({ defaultDir: defaultRoleDir(), userDir: options.userDir ?? join(fixture.root, "none-u"), projectDir: join(fixture.root, "none-p"), parseFrontmatter, projectTrusted: false });
  const catalog = await loadCatalog();
  const emit = vi.fn();
  const index = options.index ? new ProjectIndexHost({ repoId: fixture.repoId, dataRoot: fixture.dataRoot, repositoryRoot: fixture.repositoryRoot }) : undefined;
  if (index) { cleanups.push(() => index.close()); await index.init(); }
  const manager = new RunManager({ repositoryRoot: fixture.repositoryRoot, dataRoot: fixture.dataRoot, repoId: fixture.repoId, runStore,
    shellRegistry: new ShellRegistry({ clock, database: repositoryDatabase(fixture.dataRoot, fixture.repoId) }), networkGate: new NetworkPauseGate(),
    loadAgentSettings: options.loadAgentSettings ?? (() => readAgentSettings({ agentDir: join(fixture.root, "none-a"), repositoryRoot: join(fixture.root, "none-r"), projectTrusted: false })),
    roleCatalog: catalog.roles, ...(options.reloadCatalog ? { loadRoleCatalog: async () => (await loadCatalog()).roles } : {}),
    runtime, clock, workspaceRepoIds: [fixture.repoId], emit, web: options.web, index,
    loadDisabledAgents: options.loadDisabledAgents ?? (() => new Set<string>()) });
  manager.markStarted();
  cleanups.push(async () => { for (const run of (await runStore.list({ limit: 100 })).items) await manager.stop(run.id, { reason: "main_agent" }).catch(() => {}); });

  provider.queue.push({ type: "toolcall", name: PM_INTAKE_TOOL, input: { action: "ask", purpose: "pm-intake", understanding } }, { type: "text", text: "等待核对" });
  const pm = await manager.dispatchPm({ requirementId: fixture.requirementId, model: { provider: "team-model", id: "test" }, thinking: options.thinking ?? "off" });
  await until(() => provider.requests.length === 2);
  const lease = fixture.state.pmOwner(fixture.requirementId)!.lease!;
  const owner = () => db((d) => d.read<{ context: { baseline: { revision: number } | null }; prdEvents?: { consumedSequence: number; understoodRevision: number | null } }>(
    "pm_ownership", fixture.requirementId)!.data);
  /** scripted 为 false 时不替 PM 排回复，PM 对核对结论的反应交给 provider.awaitReply。 */
  async function review(decision: IntakeReviewDecision = { result: "passed", shortIssues: [] }, scripted = true) {
    const intake = fixture.makeIntake(createPmIntakeProviders(fixture.dataRoot));
    const view = await intake.openRequest(fixture.call, fixture.operationId());
    const notices = () => provider.requests.filter((request) => /主代理(?:已核对通过|核对)你的接手理解/.test(JSON.stringify(request.messages.at(-1) ?? ""))).length;
    const before = notices();
    if (scripted) provider.queue.push({ type: "text", text: "收到核对结论" });
    await intake.recordReview(fixture.call, view.requestId, fixture.operationId(), decision);
    await until(() => notices() > before);
  }
  if (options.review !== false) {
    await review();
    await until(() => owner().context.baseline?.revision === 1);
  }
  const plan = await createPlanManageTool({ repositoryRoot: fixture.repositoryRoot, dataRoot: fixture.dataRoot, authorize: () => true,
    grant: { role: "pm", callerId: uuidv7(), runId: lease.runId, requirementId: fixture.requirementId, repoId: fixture.repoId, workspaceId: lease.workspaceId, lease } });
  cleanups.push(() => plan.dispose());
  /** 像 PM 那样按更新通知用 diff 读完差异；和生产一样用派出 PM 时绑定的租约。 */
  const readDiffs = (notices: string[]) => readNoticedDiffs({ repositoryRoot: fixture.repositoryRoot, dataRoot: fixture.dataRoot, repoId: fixture.repoId, lease }, notices);
  return { fixture, understanding, runtime, provider, runStore, manager, emit, pm, lease, owner, review, plan, db, readDiffs };
}
