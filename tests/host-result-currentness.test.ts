import { afterEach, expect, test } from "vitest";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { temporaryRoot } from "./helpers/temporary-root.ts";
import { registerControlledProvider, scriptReplies } from "./helpers/controlled-provider.ts";
import { repositoryIdentity } from "../runtime/identity.ts";
import { uuidv7, repositoryDatabase, withDatabase } from "../runtime/database.ts";
import { HostAuthorizationManager } from "../runtime/host-authorization.ts";
import { MainRequirementInteraction } from "../runtime/main-requirement-interaction.ts";
import { createRequirementManageTool } from "../runtime/requirement-manage-tool.ts";
import { RequirementService } from "../runtime/requirement-service.ts";
import { RequirementStateStore } from "../runtime/requirement-state.ts";
import { UserInteractionCore } from "../runtime/user-interaction.ts";

const exec = promisify(execFile), clean: Array<() => Promise<void>> = [];
afterEach(async () => { for (const c of clean.splice(0).reverse()) await c(); });
async function world(active: boolean) {
  const root = await mkdtemp(join(temporaryRoot(), "hrc-")), repo = join(root, "repo"), dataRoot = join(root, "data");
  await mkdir(repo); await mkdir(dataRoot);
  const git = async (cwd: string, args: string[]) => (await exec("git", args, { cwd })).stdout.trim();
  await git(repo, ["init", "--initial-branch=main"]); await writeFile(join(repo, "README.md"), "fixture"); await git(repo, ["add", "README.md"]);
  await git(repo, ["-c", "user.name=test", "-c", "user.email=test@localhost", "commit", "-m", "init"]);
  const { repoId } = await repositoryIdentity(repo), sessionId = uuidv7(), windowId = uuidv7();
  const authorization = new HostAuthorizationManager({ dataRoot }); authorization.startWindow({ kind: "main", windowId, sessionId, repoIds: [repoId] });
  const runtime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, refreshOnCreate: false });
  const provider = registerControlledProvider(runtime, { providerId: uuidv7(), modelId: "fixture" });
  const ctx = { cwd: repo, modelRegistry: new ModelRegistry(runtime), model: runtime.getModels(provider.providerId)[0], sessionManager: { getSessionId: () => sessionId } } as unknown as ExtensionContext;
  let onResolve: (() => void) | undefined, onNow: (() => void) | undefined, now = Date.now();
  const interaction = new MainRequirementInteraction({ dataRoot, authorization,
    now: () => { const value = now; onNow?.(); return value; }, resolveHost: () => {
    onResolve?.();
    return { windowId, sessionId, repositories: new Map([[repoId, { path: repo }]]) };
  } });
  clean.push(async () => { interaction.dispose(); authorization.shutdown(); await rm(root, { recursive: true, force: true }); });
  const tool = createRequirementManageTool({ interaction });
  const call = (params: Record<string, unknown>, id = uuidv7()) => tool.execute(id, { repoId, ...params } as never, undefined, undefined, ctx);
  interaction.captureInput({ source: "interactive", text: "整理并分析A目标" }, ctx); scriptReplies(provider, [{ type: "text", text: '{"allow":true}' }]);
  const created = (await call({ action: "create", operationId: uuidv7(), requestId: uuidv7(), title: "A需求", body: "# A {#A}\n实施A。\n" })).details!;
  const requirementId = String(created.requirementId), state = await RequirementStateStore.open({ dataRoot, repositoryRoot: repo, repoId, authorize: () => true });
  if (active) {
    const path = join(root, "worktree"); await git(repo, ["worktree", "add", "-b", "req", path, "HEAD"]);
    await state.bindWorkspace({ requirementId, version: Number(created.version), path, baseCommit: await git(repo, ["rev-parse", "HEAD"]), prepareOperationId: uuidv7() });
  }
  interaction.captureInput({ source: "interactive", text: "分析A目标，不授权其他动作" }, ctx);
  const service = await RequirementService.open({ dataRoot, repositoryRoot: repo, repoId, authorize: () => true });
  const params = { action: "confirmUpdate", requirementId, savedOperationId: String(created.operationId), operationId: uuidv7(), version: state.read(requirementId).version };
  const loaded = await service.loadConfirmationContext({ requirementId, savedOperationId: params.savedOperationId, operationId: params.operationId }), c = loaded.candidate.candidateId;
  const entry = (kind: string, text: string) => ({ kind, conclusion: text, scope: "A范围", basis: "explicit", resolution: "direct", candidateId: c, requestId: null, actions: kind === "action" ? ["analyze"] : [], references: [], supersedes: [] });
  scriptReplies(provider, [{ type: "text", text: JSON.stringify({ format: "interaction-interpretation/v1", referenceResolution: "none", entries: [entry("constraint", "文档身份"), entry("target", "实施A"), entry("action", "只分析A")], documentReview: { faithful: true,
    units: loaded.partition.units.map((u, i) => ({ id: u.id, disposition: "confirmed", globalConstraint: false, appliesTo: [], dependsOn: [], conclusionIndexes: [i] })),
    actions: [{ action: "analyze", goalIds: ["A"], constraintIds: [], conclusionIndexes: [2], unknown: false }], questions: [] } }) }]);
  const id = uuidv7(), response = await call(params, id), targetId = (response.details!.decisionIds as string[])[1]!;
  const supersede = async () => {
    const before = state.read(requirementId);
    const second = await UserInteractionCore.open({ dataRoot, repositoryRoot: repo, repoId, authorize: () => true, authorizeAction: () => true,
      loadContext: async () => ({ basis: { requirementId, version: before.version, epoch: before.data.epoch, prod: before.data.lifecycle === "active" ? before.data.approved : before.data.saved }, currentGoal: "", candidates: [], questions: [], priorDecisions: [second.readDecision(requirementId, targetId)] }),
      interpreter: { identity: () => ({ provider: "fixture", id: "second", configurationHash: "a".repeat(64) }), interpret: async () => JSON.stringify({ format: "interaction-interpretation/v1", referenceResolution: "explicit", entries: [{ ...entry("target", "修订A目标"), candidateId: null, supersedes: [targetId] }] }) } });
    clean.push(async () => second.shutdown()); second.startSession({ sessionId: "second", windowId: "second" });
    const result = await second.interpret(second.captureInput({ source: "interactive", text: "修订A目标" }, "second"), requirementId); second.save(result.capability);
    expect(state.read(requirementId)).toEqual(before);
    expect(second.readDecision(requirementId, targetId).status).toBe("superseded");
  };
  return { call, ctx, interaction, params, id, response, supersede, dataRoot, repoId, requirementId, authorization,
    onResolve(callback: () => void) { onResolve = callback; }, onNow(callback: () => void) { onNow = callback; },
    advance(ms: number) { now += ms; } };
}
test("无ready登记结果：真实第二Core取代后，原对象、tool_result交付和缓存都拒绝", async () => {
  const w = await world(false);
  expect(w.response.details).toMatchObject({ prodActivated: false, scopeStatus: "registered", blockedBy: "workspace_not_ready" });
  expect(() => w.interaction.assertResultCurrent(structuredClone(w.response.details!), w.ctx)).toThrow(/unproven_result/);
  await w.supersede();
  expect(() => w.interaction.assertResultCurrent(w.response.details!, w.ctx)).toThrow();
  await expect(w.call(w.params)).rejects.toThrow();
  expect(() => w.interaction.assertDelivery(w.id, w.ctx)).toThrow();
});
for (const action of ["read", "diff", "metadata"] as const) test(`active ${action}原结果：同version取代后拒绝范围与正文`, async () => {
  const w = await world(true), id = uuidv7();
  const result = await w.call({ action, requirementId: w.requirementId, ...(action === "diff" ? { fromRevision: 1, toRevision: 1 } : {}) }, id);
  w.interaction.assertResultCurrent(result.details!, w.ctx);
  await w.supersede();
  expect(() => w.interaction.assertResultCurrent(result.details!, w.ctx)).toThrow();
  expect(() => w.interaction.assertDelivery(id, w.ctx)).toThrow();
});
test.each([false, true])("最后宿主回调撤权拒绝原交付及缓存（active=%s）", async (active) => {
  const w = await world(active); let calls = 0;
  w.onResolve(() => { if (++calls === 2) w.authorization.revoke(); });
  expect(() => w.interaction.assertDelivery(w.id, w.ctx)).toThrow();
  expect(calls).toBe(2);
  expect(() => w.interaction.assertResultCurrent(w.response.details!, w.ctx)).toThrow();
  await expect(w.call(w.params)).rejects.toThrow();
});

test.each([false, true])("最后宿主回调跨越deadline时原交付立即拒绝（active=%s）", async (active) => {
  const w = await world(active); let calls = 0;
  w.onResolve(() => { if (++calls === 2) w.advance(900_001); });
  expect(() => w.interaction.assertDelivery(w.id, w.ctx)).toThrow();
  expect(calls).toBe(2);
  expect(() => w.interaction.assertResultCurrent(w.response.details!, w.ctx)).toThrow();
});

for (const boundary of ["original", "delivery"] as const) test.each([false, true])(
  `最后now回调同步耗时跨deadline时${boundary}首次即拒绝（active=%s）`, async (active) => {
    const w = await world(active);
    w.interaction.assertResultCurrent(w.response.details!, w.ctx);
    if (boundary === "delivery") {
      let resolves = 0;
      w.onResolve(() => { if (++resolves === 2) w.advance(899_980); });
    } else w.advance(899_980);
    let calls = 0;
    const lastCall = boundary === "delivery" ? 2 : 1;
    w.onNow(() => {
      if (++calls !== lastCall) return;
      w.advance(60);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60);
    });
    expect(() => boundary === "delivery" ? w.interaction.assertDelivery(w.id, w.ctx)
      : w.interaction.assertResultCurrent(w.response.details!, w.ctx)).toThrow(/stale_result/);
    expect(calls).toBe(lastCall);
  });

test.each([false, true])("显式撤权使持有的原结果对象失效（active=%s）", async (active) => {
  const w = await world(active);
  w.authorization.revoke();
  expect(() => w.interaction.assertResultCurrent(w.response.details!, w.ctx)).toThrow();
});

test.each(["read", "diff", "metadata"] as const)("active %s最后宿主回调撤权仍拒绝", async (action) => {
  const w = await world(true), id = uuidv7();
  const output = await w.call({ action, requirementId: w.requirementId, ...(action === "diff" ? { fromRevision: 1, toRevision: 1 } : {}) }, id);
  let calls = 0;
  w.onResolve(() => { if (++calls === 2) w.authorization.revoke(); });
  expect(() => w.interaction.assertDelivery(id, w.ctx)).toThrow();
  expect(calls).toBe(2);
  expect(() => w.interaction.assertResultCurrent(output.details!, w.ctx)).toThrow();
});

test("manifest同内容改行版本不能继续交付缓存范围", async () => {
  const w = await world(false);
  withDatabase(repositoryDatabase(w.dataRoot, w.repoId), (db) => {
    const row = db.list("approval_manifests_v1")[0]!; db.update("approval_manifests_v1", row.key, row.version, row.data);
  });
  expect(() => w.interaction.assertDelivery(w.id, w.ctx)).toThrow(/result_records_changed/);
  await expect(w.call(w.params)).rejects.toThrow();
});
