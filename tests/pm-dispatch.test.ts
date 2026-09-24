import { afterEach, expect, test, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import type { Context } from "@earendil-works/pi-ai";
import { ModelRuntime, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { RelayQueue } from "../daemon/relay-queue.ts";
import { RunManager } from "../daemon/run-manager.ts";
import { createPmTools } from "../daemon/pm-tools.ts";
import { createClock } from "../runtime/clock.ts";
import { repositoryDatabase, uuidv7, withDatabase } from "../runtime/database.ts";
import { repositoryIdentity } from "../runtime/identity.ts";
import { NetworkPauseGate } from "../runtime/network-pause.ts";
import { RequirementService, requirementIntentHash } from "../runtime/requirement-service.ts";
import { RequirementStateStore } from "../runtime/requirement-state.ts";
import { defaultRoleDir, loadRoleCatalog } from "../runtime/roles.ts";
import { RunStore } from "../runtime/run-store.ts";
import { ShellRegistry } from "../runtime/shell-registry.ts";
import { WorkspaceManageService } from "../runtime/workspace-manage.ts";
import { registerControlledProvider, scriptReplies } from "./helpers/controlled-provider.ts";
import { createRepoFixture, removeRepoFixture } from "./helpers/repo-fixture.ts";
import { temporaryRoot } from "./helpers/temporary-root.ts";
import { createPmIntakeFixture } from "./helpers/pm-intake-fixture.ts";

const cleanups: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const BODY = "# 目标 {#goals}\n保留移动。\n";

async function until(check: () => boolean | Promise<boolean>): Promise<void> {
  for (let i = 0; i < 400; i++) { if (await check()) return; await new Promise((resolve) => setTimeout(resolve, 25)); }
  throw new Error("等待超时");
}

async function manager(base: { repositoryRoot: string; dataRoot: string; repoId: string }, root: string) {
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, modelsStorePath: join(root, "models.json"), refreshOnCreate: false });
  const provider = registerControlledProvider(runtime, { providerId: "pm-model", modelId: "test" });
  const clock = createClock(); cleanups.push(() => clock.stopGapWatcher());
  const runStore = new RunStore({ dataRoot: base.dataRoot, repoId: base.repoId, daemonStartedAt: new Date().toISOString() });
  const catalog = await loadRoleCatalog({ defaultDir: defaultRoleDir(), userDir: join(root, "none-u"), projectDir: join(root, "none-p"), parseFrontmatter, projectTrusted: false });
  const relay = new RelayQueue({ dataDir: join(base.dataRoot, "repos", base.repoId), deliver: async () => [], locateRequirementAgent: () => undefined });
  const runs = new RunManager({ ...base, runStore, shellRegistry: new ShellRegistry({ clock, database: repositoryDatabase(base.dataRoot, base.repoId) }),
    networkGate: new NetworkPauseGate(), relayQueue: relay, roleCatalog: catalog.roles, runtime, selectModel: () => { throw new Error("不应按旧规则选模型"); },
    clock, workspaceRepoIds: [base.repoId], emit: vi.fn() });
  runs.markStarted();
  cleanups.push(async () => { for (const run of (await runStore.list({ limit: 100 })).items) await runs.stop(run.id).catch(() => {}); });
  return { provider, runStore, runs };
}

/** 没有批准清单的需求：用于核验派出前置条件。 */
async function plainWorld(options: { prepare?: boolean; activate?: boolean } = {}) {
  const root = await mkdtemp(join(temporaryRoot(), "pm-dispatch-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const repo = await createRepoFixture(); cleanups.push(() => removeRepoFixture(repo));
  const { repoId } = await repositoryIdentity(repo.root);
  const base = { repositoryRoot: repo.root, dataRoot: join(root, "agent", "pi-company"), repoId };
  const grants = new Map<string, { action: string; intent: string; receiptId?: string }>();
  const service = await RequirementService.open({ ...base, authorize: (request) => {
    if (request.repoId !== repoId) return false;
    if (request.action === "metadata") return true;
    const grant = request.operationId ? grants.get(request.operationId) : undefined;
    return !!grant && grant.action === request.action && grant.intent === request.intentHash && grant.receiptId === request.receiptId;
  } });
  const state = await RequirementStateStore.open({ ...base, authorize: (request) => request.repoId === repoId && ["open", "read"].includes(request.action) });
  const create = { requestId: uuidv7(), operationId: uuidv7(), title: "角色跳跃", body: BODY };
  grants.set(create.operationId, { action: "create", intent: requirementIntentHash({ title: create.title, body: BODY }) });
  const { requirementId } = await service.create(create);
  if (options.prepare !== false) {
    const workspace = await WorkspaceManageService.open({ ...base, confirm: async () => true });
    const ready = await workspace.prepare({ requirementId, operationId: uuidv7() });
    cleanups.push(() => rm(join(ready.path, "..", ".."), { recursive: true, force: true }));
    if (options.activate !== false) {
      const confirm = { requirementId, operationId: uuidv7(), version: state.read(requirementId).version, title: "角色跳跃", body: BODY, receiptId: uuidv7() };
      grants.set(confirm.operationId, { action: "confirmUpdate", intent: requirementIntentHash({ title: confirm.title, body: BODY }), receiptId: confirm.receiptId });
      await service.confirmUpdate(confirm);
    }
  }
  const { runs } = await manager(base, root);
  return { dispatch: () => runs.dispatchPm({ requirementId, model: { provider: "pm-model", id: "test" }, thinking: "off" }) };
}

/** 带实施授权批准清单的需求：夹具原有的 PM 租约置为过期，工作区登记为 ready。 */
async function world() {
  const fixture = await createPmIntakeFixture(); cleanups.push(() => fixture.cleanup());
  const record = fixture.state.read(fixture.requirementId).data;
  withDatabase(repositoryDatabase(fixture.dataRoot, fixture.repoId), (db) => {
    const row = db.read<{ lease: { expiresAt: number } }>("pm_ownership", fixture.requirementId)!;
    db.update("pm_ownership", fixture.requirementId, row.version, { ...row.data, lease: { ...row.data.lease, expiresAt: Date.now() - 1 } });
    db.create("managed_workspaces", fixture.requirementId, { format: "managed-workspace/v1", requirementId: fixture.requirementId, operationId: uuidv7(),
      baseCommit: record.workspace!.baseCommit, branch: record.workspace!.branch, path: record.workspace!.path, status: "ready", recycleOperationId: null });
  });
  const base = { repositoryRoot: fixture.repositoryRoot, dataRoot: fixture.dataRoot, repoId: fixture.repoId };
  const { provider, runStore, runs } = await manager(base, fixture.root);
  const dispatch = () => runs.dispatchPm({ requirementId: fixture.requirementId, model: { provider: "pm-model", id: "test" }, thinking: "off" });
  return { ...base, state: fixture.state, requirementId: fixture.requirementId, provider, runStore, manager: runs, dispatch };
}

function toolNames(request: Context | undefined): string[] {
  return (request?.tools ?? []).map((tool) => tool.name).sort();
}

test("M7-AC13：PM 只在工作区 ready、需求 active 且有实施授权时派出，受限接手上下文不含 prod 正文", async () => {
  await expect((await plainWorld({ prepare: false })).dispatch()).rejects.toMatchObject({ code: "requirement_not_active" });
  await expect((await plainWorld({ activate: false })).dispatch()).rejects.toMatchObject({ code: "requirement_not_active" });
  await expect((await plainWorld()).dispatch()).rejects.toMatchObject({ code: "implement_not_authorized" });
  const w = await world();
  scriptReplies(w.provider, [{ type: "text", text: "等待" }]);
  const { runId, fence } = await w.dispatch();
  expect(fence).toBe(2);
  await until(() => w.provider.requests.length === 1);
  const request = w.provider.requests[0]!;
  expect(request.systemPrompt).toContain(w.requirementId);
  expect(request.systemPrompt).toContain("受限接手");
  expect(JSON.stringify(request)).not.toContain("输入正确验证码后成功");
  expect(toolNames(request)).toEqual(["find", "grep", "ls", "pi_company_agent_manage", "pi_company_plan_manage", "pi_company_requirement_manage", "pi_company_spec_change", "pi_company_user_interact",
    "pi_company_verification_run", "pi_company_workflow_manage", "read"]);
  expect(await w.runStore.get(runId)).toMatchObject({ ok: true, run: { kind: "requirement", state: "running", requirement: w.requirementId } });
}, 30000);

test("M7-AC5：同一需求只有一个有效 PM；停止后再派出取得更高 fence，旧运行的工具失效", async () => {
  const w = await world();
  scriptReplies(w.provider, [{ type: "text", text: "一" }, { type: "text", text: "二" }]);
  const first = await w.dispatch();
  await expect(w.dispatch()).rejects.toThrow();
  const firstLease = (await RequirementStateStore.open({ repositoryRoot: w.repositoryRoot, dataRoot: w.dataRoot, repoId: w.repoId,
    authorize: () => true })).pmOwner(w.requirementId)!.lease!;
  const record = w.state.read(w.requirementId).data;
  const stale = await createPmTools({ repositoryRoot: w.repositoryRoot, dataRoot: w.dataRoot, repoId: w.repoId, lease: firstLease, workspace: record.workspace!,
    epoch: record.epoch, alive: () => true, stopAgents: async () => {} });
  cleanups.push(() => stale.dispose());
  expect(await w.manager.stop(first.runId)).toMatchObject({ confirmed: true });
  expect(await w.runStore.get(first.runId)).toMatchObject({ ok: true, run: { state: "stopped" } });
  const second = await w.dispatch();
  expect(second.fence).toBeGreaterThan(first.fence);
  const read = stale.tools.find((tool) => tool.name === "pi_company_requirement_manage")!;
  await expect(read.execute("late", { action: "metadata" }, undefined, undefined, undefined as never)).rejects.toThrow();
}, 30000);

test("M7-AC9：按需求停止结束全部运行，关闭协议依赖的运行终态真实登记", async () => {
  const w = await world();
  scriptReplies(w.provider, [{ type: "text", text: "一" }]);
  const { runId } = await w.dispatch();
  await w.manager.stopRequirement(w.requirementId);
  expect(await w.runStore.get(runId)).toMatchObject({ ok: true, run: { state: "stopped" } });
  const owner = (await RequirementStateStore.open({ repositoryRoot: w.repositoryRoot, dataRoot: w.dataRoot, repoId: w.repoId, authorize: () => true })).pmOwner(w.requirementId);
  expect(owner?.lease ?? null).toBeNull();
}, 30000);

test("M7-AC5：旧 PM 租约过期后再派出即接管，旧会话立即停止且其工具失效", async () => {
  const w = await world();
  scriptReplies(w.provider, [{ type: "text", text: "一" }, { type: "text", text: "二" }]);
  const first = await w.dispatch();
  withDatabase(repositoryDatabase(w.dataRoot, w.repoId), (db) => {
    const row = db.read<{ lease: { expiresAt: number } }>("pm_ownership", w.requirementId)!;
    db.update("pm_ownership", w.requirementId, row.version, { ...row.data, lease: { ...row.data.lease, expiresAt: Date.now() - 1 } });
  });
  const second = await w.dispatch();
  expect(second.fence).toBeGreaterThan(first.fence);
  expect(await w.runStore.get(first.runId)).toMatchObject({ ok: true, run: { state: "stopped" } });
  expect(await w.runStore.get(second.runId)).toMatchObject({ ok: true, run: { state: "running" } });
}, 30000);
