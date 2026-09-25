import { vi } from "vitest";
import { join } from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { RelayQueue } from "../../daemon/relay-queue.ts";
import { RunManager } from "../../daemon/run-manager.ts";
import type { RunManagerOptions } from "../../daemon/run-manager.ts";
import { ProjectIndexHost } from "../../daemon/project-index-host.ts";
import { createClock } from "../../runtime/clock.ts";
import { repositoryDatabase, uuidv7, withDatabase } from "../../runtime/database.ts";
import { NetworkPauseGate } from "../../runtime/network-pause.ts";
import { createPlanManageTool } from "../../runtime/plan-manage.ts";
import { createPmIntakeProviders, PM_INTAKE_TOOL } from "../../runtime/pm-intake-runtime.ts";
import { defaultRoleDir, loadRoleCatalog } from "../../runtime/roles.ts";
import { RunStore } from "../../runtime/run-store.ts";
import { ShellRegistry } from "../../runtime/shell-registry.ts";
import { registerControlledProvider } from "./controlled-provider.ts";
import { createPmIntakeFixture } from "./pm-intake-fixture.ts";

export async function until(check: () => boolean | Promise<boolean>, limit = 600): Promise<void> {
  for (let i = 0; i < limit; i++) { if (await check()) return; await new Promise((resolve) => setTimeout(resolve, 10)); }
  throw new Error("等待超时");
}

/**
 * 真实 RunManager 派出的 PM：夹具原有租约置为过期、工作区登记为 ready，PM 以脚本化模型提交接手理解。
 * review 为 false 时不做主代理核对，由用例自行调用 review()。
 */
export async function createPmRunWorld(cleanups: Array<() => unknown | Promise<unknown>>, options: { review?: boolean; web?: RunManagerOptions["web"]; index?: boolean; agentDir?: string; authorizeClose?: boolean } = {}) {
  const fixture = await createPmIntakeFixture({ authorizeClose: options.authorizeClose }); cleanups.push(() => fixture.cleanup());
  const record = fixture.state.read(fixture.requirementId).data;
  const db = <T>(run: Parameters<typeof withDatabase<T>>[1]) => withDatabase(repositoryDatabase(fixture.dataRoot, fixture.repoId), run);
  db((d) => {
    const row = d.read<{ lease: { expiresAt: number } }>("pm_ownership", fixture.requirementId)!;
    d.update("pm_ownership", fixture.requirementId, row.version, { ...row.data, lease: { ...row.data.lease, expiresAt: Date.now() - 1 } });
    d.create("managed_workspaces", fixture.requirementId, { format: "managed-workspace/v1", requirementId: fixture.requirementId, operationId: uuidv7(),
      baseCommit: record.workspace!.baseCommit, branch: record.workspace!.branch, path: record.workspace!.path, status: "ready", recycleOperationId: null });
  });
  const captured = fixture.captureCurrent();
  const material = await fixture.submissionProvider.loadCurrent({ binding: captured.binding, sourceDirectoryHash: captured.sourceDirectoryHash,
    maxBytes: 49_152, signal: new AbortController().signal });
  const { format: _format, binding: _binding, ...understanding } = material!.understanding;
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, modelsStorePath: join(fixture.root, "models.json"), refreshOnCreate: false });
  const provider = registerControlledProvider(runtime, { providerId: "team-model", modelId: "test" });
  const clock = createClock(); cleanups.push(() => clock.stopGapWatcher());
  const runStore = new RunStore({ dataRoot: fixture.dataRoot, repoId: fixture.repoId, daemonStartedAt: new Date().toISOString() });
  const catalog = await loadRoleCatalog({ defaultDir: defaultRoleDir(), userDir: join(fixture.root, "none-u"), projectDir: join(fixture.root, "none-p"), parseFrontmatter, projectTrusted: false });
  const emit = vi.fn();
  const index = options.index ? new ProjectIndexHost({ repoId: fixture.repoId, dataRoot: fixture.dataRoot, repositoryRoot: fixture.repositoryRoot }) : undefined;
  if (index) { cleanups.push(() => index.close()); await index.init(); }
  const manager = new RunManager({ repositoryRoot: fixture.repositoryRoot, dataRoot: fixture.dataRoot, repoId: fixture.repoId, runStore,
    shellRegistry: new ShellRegistry({ clock, database: repositoryDatabase(fixture.dataRoot, fixture.repoId) }), networkGate: new NetworkPauseGate(),
    relayQueue: new RelayQueue({ dataDir: join(fixture.dataRoot, "repos", fixture.repoId), deliver: async () => [] }),
    roleCatalog: catalog.roles, runtime, selectModel: () => { throw new Error("不应按旧规则选模型"); }, clock, workspaceRepoIds: [fixture.repoId], emit, web: options.web, index, agentDir: options.agentDir });
  manager.markStarted();
  cleanups.push(async () => { for (const run of (await runStore.list({ limit: 100 })).items) await manager.stop(run.id).catch(() => {}); });

  provider.queue.push({ type: "toolcall", name: PM_INTAKE_TOOL, input: { action: "ask", purpose: "pm-intake", understanding } }, { type: "text", text: "等待核对" });
  const pm = await manager.dispatchPm({ requirementId: fixture.requirementId, model: { provider: "team-model", id: "test" }, thinking: "off" });
  await until(() => provider.requests.length === 2);
  const lease = fixture.state.pmOwner(fixture.requirementId)!.lease!;
  const owner = () => db((d) => d.read<{ context: { baseline: { revision: number } | null }; prodEvents?: { consumedSequence: number; understoodRevision: number | null } }>(
    "pm_ownership", fixture.requirementId)!.data);
  async function review() {
    const intake = fixture.makeIntake(createPmIntakeProviders(fixture.dataRoot));
    const view = await intake.openRequest(fixture.call, fixture.operationId());
    await intake.recordReview(fixture.call, view.requestId, fixture.operationId(), { result: "passed", shortIssues: [] });
  }
  if (options.review !== false) {
    await review();
    await until(() => owner().context.baseline?.revision === 1);
  }
  const plan = await createPlanManageTool({ repositoryRoot: fixture.repositoryRoot, dataRoot: fixture.dataRoot, authorize: () => true,
    grant: { role: "pm", callerId: uuidv7(), runId: lease.runId, requirementId: fixture.requirementId, repoId: fixture.repoId, workspaceId: lease.workspaceId, lease } });
  cleanups.push(() => plan.dispose());
  return { fixture, understanding, runtime, provider, runStore, manager, emit, pm, lease, owner, review, plan, db };
}
