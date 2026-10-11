import { afterEach, expect, test, vi } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { RequirementService } from "../runtime/requirement-service.ts";
import { RequirementStateStore } from "../runtime/requirement-state.ts";
import { ApprovalManifestStore } from "../runtime/approval-manifest-store.ts";
import { UserInteractionCore } from "../runtime/user-interaction.ts";
import { decisionDigest } from "../runtime/short-decision-format.ts";
import { repositoryDatabase, uuidv7, withDatabase } from "../runtime/database.ts";
import { repositoryIdentity } from "../runtime/identity.ts";
import { createRequirementReadTool } from "../runtime/requirement-read-tool.ts";
import { addWorktree, createRepoFixture, GIT_ENV, removeRepoFixture } from "./helpers/repo-fixture.ts";
import { temporaryRoot } from "./helpers/temporary-root.ts";


const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture() {
  const root = await mkdtemp(join(temporaryRoot(), "scope-return-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const repo = await createRepoFixture(); cleanups.push(() => removeRepoFixture(repo));
  const identity = await repositoryIdentity(repo.root);
  const options = { repositoryRoot: repo.root, dataRoot: join(root, "data"), repoId: identity.repoId};
  const service = await RequirementService.open({ ...options, authorize: () => true });
  const state = await RequirementStateStore.open({ ...options, authorize: () => true });
  const saved = await service.create({ requestId: uuidv7(), operationId: uuidv7(), title: "范围返回", body: "# A {#A}\n只分析A。\n" });
  const worktree = await addWorktree(repo);
  const baseCommit = (await promisify(execFile)("git", ["rev-parse", "HEAD"], { cwd: worktree.root, env: GIT_ENV })).stdout.trim();
  const workspace = await state.bindWorkspace({ requirementId: saved.requirementId, version: saved.version, path: worktree.root,
    prepareOperationId: uuidv7(), baseCommit });
  const operationId = uuidv7();
  const load = () => service.loadConfirmationContext({ requirementId: saved.requirementId, savedOperationId: saved.operationId, operationId });
  const context = await load();
  const first = await UserInteractionCore.open({ ...options, authorize: () => true, authorizeAction: () => true,
    loadContext: async () => ({ basis: context.basis, currentGoal: "", candidates: [{ ...context.candidate, diff: context.difference.text }],
      questions: [], priorDecisions: [], document: { candidate: context.candidate, title: context.title, body: context.body, partition: context.partition } }),
    interpreter: { identity: () => ({ provider: "fixture", id: "scope-return", configurationHash: "a".repeat(64) }),
      interpret: async () => JSON.stringify({ format: "interaction-interpretation/v1", referenceResolution: "none", entries: [{
        basis: "explicit", resolution: "direct", kind: "target", candidateId: context.candidate.candidateId, requestId: null,
        actions: [], references: [], supersedes: [], conclusion: "确认A", scope: "仅A" }],
      documentReview: { faithful: true, units: context.partition.units.map((u) => ({ id: u.id, disposition: "confirmed",
        globalConstraint: false, appliesTo: [], dependsOn: [], conclusionIndexes: [0] })), actions: [], questions: [] } }) } });
  cleanups.push(() => first.shutdown()); first.startSession({ sessionId: "first", windowId: "first" });
  const interpreted = await first.interpret(first.captureInput({ source: "interactive", text: "确认A目标" }, "first"), saved.requirementId);
  const decisions = first.save(interpreted.capability);
  const document = () => first.authorizeDocument(interpreted.capability, { basis: context.basis, candidate: context.candidate });
  const authorized = document()!; expect(authorized).not.toBeNull();
  const store = new ApprovalManifestStore({ ...options, authorize: () => true,
    loadExpected: async () => ({ requirementId: context.requirementId, candidate: context.candidate, partition: context.partition }),
    admit: (r) => { const d = document(); return d && decisionDigest(d.authorization.manifest) === decisionDigest(r.reference)
      ? { receiptId: d.authorization.receiptId, version: d.authorization.basis.version, epoch: d.authorization.basis.epoch, inputProof: d.authorization.inputProof } : null; } });
  const reference = await store.register(authorized.manifest);
  const approver = await RequirementService.open({ ...options, authorize: () => true, authorizeManifest: (r) => {
    const d = document(); return Boolean(d && r.receiptId === d.authorization.receiptId && r.version === d.authorization.basis.version &&
      decisionDigest(r.manifest) === decisionDigest(d.authorization.manifest)); } });
  const confirmed = await approver.confirmUpdate({ requirementId: saved.requirementId, operationId, version: context.version,
    title: context.title, body: context.body, receiptId: authorized.authorization.receiptId, manifest: reference });
  const lease = await state.acquirePm({ requirementId: saved.requirementId, version: confirmed.version, runId: uuidv7(), expectedFence: 0 });
  const baseline = state.read(saved.requirementId);
  // 第二个真实Core在当前active/PM基线上预先解释；save发生在被测返回窗口，不直接改SQL状态。
  const second = await UserInteractionCore.open({ ...options, authorize: () => true, authorizeAction: () => true,
    loadContext: async () => ({ basis: { requirementId: saved.requirementId, version: baseline.version, epoch: baseline.data.epoch, prod: baseline.data.approved },
      currentGoal: "", candidates: [], questions: [], priorDecisions: [first.readDecision(saved.requirementId, decisions.decisionIds[0]!)] }),
    interpreter: { identity: () => ({ provider: "fixture", id: "real-revision", configurationHash: "b".repeat(64) }),
      interpret: async () => JSON.stringify({ format: "interaction-interpretation/v1", referenceResolution: "explicit", entries: [{
        basis: "explicit", resolution: "direct", kind: "target", candidateId: null, requestId: null, actions: [], references: [],
        supersedes: [decisions.decisionIds[0]], conclusion: "修订A目标", scope: "仅A" }] }) } });
  cleanups.push(() => second.shutdown()); second.startSession({ sessionId: "second", windowId: "second" });
  const revision = await second.interpret(second.captureInput({ source: "interactive", text: "修订原A目标" }, "second"), saved.requirementId);
  let changed = false;
  const supersede = () => { expect(changed).toBe(false); second.save(revision.capability); changed = true; };
  const verifyRevision = () => {
    expect(changed).toBe(true); expect(state.read(saved.requirementId)).toEqual(baseline);
    expect(withDatabase(repositoryDatabase(options.dataRoot, options.repoId), (db) => db.read<any>("short_decisions", decisions.decisionIds[0]!)!.data.status)).toBe("superseded");
    expect(() => store.read(reference)).toThrow(/manifest_decision/);
  };
  const tool = async (authorize: () => boolean = () => true) => {
    const t = await createRequirementReadTool({ ...options, binding: { role: "qa", callerId: uuidv7(), runId: uuidv7(), requirementId: saved.requirementId,
      repoId: options.repoId, workspaceId: lease.workspaceId, branch: workspace.data.workspace!.branch, lease }, authorize });
    cleanups.push(() => t.dispose()); return t;
  };
  return { tool, supersede, verifyRevision, state, baseline };
}

for (const action of ["read", "diff"] as const) for (const boundary of ["service", "page", "workspace", "last-host"] as const) {
  test(`${action}在${boundary}窗口被第二Core合法取代后不返回旧confirmed范围`, async () => {
    const f = await fixture(); let pageBuilt = false, hostAfterPage = 0, injected = false;
    const inject = () => { if (!injected) { injected = true; f.supersede(); } };
    const tool = await f.tool(() => { if (pageBuilt && ++hostAfterPage === 3 && boundary === "last-host") inject(); return true; });
    const stringify = JSON.stringify;
    vi.spyOn(JSON, "stringify").mockImplementation(((value: any, ...args: any[]) => {
      if (value?.coverage && value?.source?.approvalScope?.status === "available") {
        pageBuilt = true; if (boundary === "page") inject();
      }
      return (stringify as any)(value, ...args);
    }) as typeof JSON.stringify);
    if (boundary === "service") {
      const original = RequirementService.prototype[action];
      vi.spyOn(RequirementService.prototype, action).mockImplementation(async function(this: RequirementService, input: any) {
        const value = await (original as any).call(this, input); inject(); return value;
      });
    }
    if (boundary === "workspace") {
      const check = RequirementStateStore.prototype.checkPm;
      vi.spyOn(RequirementStateStore.prototype, "checkPm").mockImplementation(async function(this: RequirementStateStore, lease) {
        const value = await check.call(this, lease); if (pageBuilt) inject(); return value;
      });
    }
    await expect(tool.execute({ action, maxBytes: 4, ...(action === "diff" ? { fromRevision: 1 } : {}) })).rejects.toMatchObject({ code: expect.stringMatching(/^manifest_decision/) });
    expect(injected).toBe(true); f.verifyRevision();
    if (boundary === "last-host") expect(hostAfterPage).toBe(3);
  });
}

test("同步外层guard只认原返回对象，宿主末尾修订后旧JSON与原对象都不能继续返回", async () => {
  const f = await fixture(); const tool = await f.tool(); const page = await tool.execute({ action: "read", maxBytes: 4 });
  expect(() => tool.assertCurrent(page)).not.toThrow();
  expect((() => { try { tool.assertCurrent(JSON.parse(JSON.stringify(page))); } catch (error) { return error; } })()).toMatchObject({ code: "read_failed" });
  f.supersede(); expect((() => { try { tool.assertCurrent(page); } catch (error) { return error; } })()).toMatchObject({ code: "manifest_decision_mismatch" }); f.verifyRevision();
});
