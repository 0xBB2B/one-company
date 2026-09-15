import { afterEach, expect, test, vi } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { RequirementService } from "../runtime/requirement-service.ts";
import { RequirementStateStore } from "../runtime/requirement-state.ts";
import { ApprovalManifestStore, APPROVAL_MANIFEST_NAMESPACE } from "../runtime/approval-manifest-store.ts";
import { approvalManifestReference, approvedManifestScope } from "../runtime/approval-manifest.ts";
import { UserInteractionCore } from "../runtime/user-interaction.ts";
import type { InteractionCapability, InteractionContext } from "../runtime/user-interaction.ts";
import { decisionDigest } from "../runtime/short-decision-format.ts";
import { repositoryDatabase, uuidv7, withDatabase } from "../runtime/database.ts";
import type { LocalDatabase } from "../runtime/database.ts";
import { repositoryIdentity } from "../runtime/identity.ts";
import { prodRequirementPath } from "../runtime/prod-storage.ts";
import { createRequirementReadTool } from "../runtime/requirement-read-tool.ts";
import { addWorktree, createRepoFixture, GIT_ENV, removeRepoFixture } from "./helpers/repo-fixture.ts";
import { failDatabaseWrites } from "./helpers/database-fixture.ts";
import { temporaryRoot } from "./helpers/temporary-root.ts";

const exec = promisify(execFile), GIT = "/usr/bin/git";
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture(ready = true, shared = false) {
  const root = await mkdtemp(join(temporaryRoot(), "manifest-persist-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const repo = await createRepoFixture(); cleanups.push(() => removeRepoFixture(repo));
  const identity = await repositoryIdentity(repo.root);
  const options = { repositoryRoot: repo.root, dataRoot: join(root, "data"), repoId: identity.repoId, gitExecutable: GIT };
  // 夹具宿主持有专用service/state句柄。此处仅fixture资源访问许可；真正批准另外核验Core对象能力。
  const access = { live: true };
  const clock = { now: Date.now() };
  const service = await RequirementService.open({ ...options, authorize: (r) => access.live && r.repoId === identity.repoId });
  const state = await RequirementStateStore.open({ ...options, authorize: (r) => access.live && r.repoId === identity.repoId });
  const input = { requestId: uuidv7(), operationId: uuidv7(), title: "渐进登录", body: "# 手机号 {#A}\r\n实施手机号登录。😀\r\n# 微信 {#B}\r\n微信细节未决，不实施。\r\n" };
  if (shared) input.body += "# 共享条件 {#C}\n保留邮箱。\n";
  const saved = await service.create(input);
  let workspace;
  if (ready) {
    const worktree = await addWorktree(repo);
    const baseCommit = (await exec(GIT, ["rev-parse", "HEAD"], { cwd: worktree.root, env: GIT_ENV })).stdout.trim();
    workspace = await state.bindWorkspace({ requirementId: saved.requirementId, version: state.read(saved.requirementId).version,
      path: worktree.root, prepareOperationId: uuidv7(), baseCommit });
  }
  const operationId = uuidv7();
  const load = () => service.loadConfirmationContext({ requirementId: saved.requirementId, savedOperationId: saved.operationId, operationId });
  let context = await load();
  const core = await UserInteractionCore.open({ ...options, now: () => clock.now,
    authorize: (r) => access.live && r.repoId === identity.repoId,
    authorizeAction: (r) => access.live && r.repoId === identity.repoId && r.basis.requirementId === saved.requirementId &&
      decisionDigest(r.candidate) === decisionDigest(context.candidate) && ["authorize-document", "implement"].includes(r.action),
    loadContext: async () => {
      context = await load();
      const c: InteractionContext = { basis: context.basis, currentGoal: "", candidates: [{ ...context.candidate,
        diff: context.difference.text || "（无字节差异）" }], questions: [], priorDecisions: [],
        document: { candidate: context.candidate, title: context.title, body: context.body, partition: context.partition } };
      return c;
    },
    interpreter: {
      identity: () => ({ provider: "fixture", id: "explicit-document-review", configurationHash: "a".repeat(64) }),
      interpret: async ({ context }) => {
        const common = { basis: "explicit", resolution: "direct", candidateId: context.document!.candidate.candidateId,
          requestId: null, actions: [], references: [], supersedes: [], scope: "仅手机号A；微信B未决" };
        return JSON.stringify({ format: "interaction-interpretation/v1", referenceResolution: "none", entries: [
          { ...common, kind: "target", conclusion: "确认手机号登录目标" },
          { ...common, kind: "unresolved", basis: "uncertain", resolution: "defer", conclusion: "微信细节待定" },
          { ...common, kind: "action", actions: ["implement"], conclusion: "允许实施手机号登录" },
          ...(shared ? [{ ...common, kind: "constraint", conclusion: "保留邮箱", scope: "A共享条件" }] : []),
        ], documentReview: { faithful: true, units: context.document!.partition.units.map((u) => ({ id: u.id,
          disposition: u.id === "B" ? "pending-description" : "confirmed", globalConstraint: u.id === "C", appliesTo: u.id === "C" ? ["A"] : [], dependsOn: [],
          conclusionIndexes: [u.id === "B" ? 1 : u.id === "C" ? 3 : 0] })),
          actions: [{ action: "implement", goalIds: ["A"], constraintIds: shared ? ["C"] : [], conclusionIndexes: [2], unknown: false }], questions: [] } });
      },
    },
  });
  cleanups.push(() => core.shutdown());
  core.startSession({ sessionId: "fixture-session", windowId: "fixture-window" });
  const ticket = core.captureInput({ source: "interactive", text: "确认并实施手机号A，微信B保留未决说明，不要实施。" }, "fixture-session");
  const interpreted = await core.interpret(ticket, saved.requirementId);
  core.save(interpreted.capability);
  const binding = () => ({ basis: context.basis, candidate: context.candidate });
  const document = () => core.authorizeDocument(interpreted.capability, binding());
  const authorized = document()!; expect(authorized).not.toBeNull();
  const storeOptions = { ...options,
    loadExpected: async () => { const current = await load(); return { requirementId: current.requirementId, candidate: current.candidate, partition: current.partition }; },
    authorize: (r: { repoId: string }) => access.live && r.repoId === identity.repoId,
    admit: (r: { reference: unknown }) => {
      const current = document();
      return current && decisionDigest(current.authorization.manifest) === decisionDigest(r.reference)
        ? { receiptId: current.authorization.receiptId, version: current.authorization.basis.version, epoch: current.authorization.basis.epoch, inputProof: current.authorization.inputProof } : null;
    },
  };
  const store = new ApprovalManifestStore(storeOptions);
  const approver = await RequirementService.open({ ...options, authorize: (r) => access.live && r.repoId === identity.repoId,
    authorizeManifest: (r) => {
      const current = document();
      return Boolean(current && r.requirementId === saved.requirementId && r.version === context.version &&
        r.receiptId === current.authorization.receiptId && decisionDigest(r.manifest) === decisionDigest(current.authorization.manifest));
    } });
  const confirm = () => ({ requirementId: saved.requirementId, operationId, version: context.version, title: context.title, body: context.body,
    receiptId: authorized.authorization.receiptId, manifest: approvalManifestReference(authorized.manifest) });
  const dbPath = repositoryDatabase(options.dataRoot, options.repoId);
  const db = <T>(fn: (db: LocalDatabase) => T) => withDatabase(dbPath, fn);
  return { options, input, saved, state, workspace, core, interpreted, document, context, service, approver, store, storeOptions, confirm, load, db, dbPath, access, clock, binding };
}

for (const change of ["superseded", "modified", "missing"] as const) test(`真实原约束→单题短答→register/ready confirm/read；原来源${change}使范围失效`, async () => {
  const f = await fixture(true, true);
  const oldId = f.core.save(f.interpreted.capability).decisionIds[3]!;
  const old = f.core.readDecision(f.saved.requirementId, oldId);
  // 新候选ID与原来源不同，真实保存字节、需求version/epoch与prod基线相同。
  const operationId = uuidv7();
  const load = () => f.service.loadConfirmationContext({ requirementId: f.saved.requirementId, savedOperationId: f.saved.operationId, operationId });
  const current = await load();
  expect(current.candidate.candidateId).not.toBe(f.context.candidate.candidateId);
  const context: InteractionContext = { basis: current.basis, currentGoal: "", candidates: [{ ...current.candidate, diff: current.difference.text }],
    priorDecisions: [old], questions: [], document: { candidate: current.candidate, title: current.title, body: current.body, partition: current.partition } };
  let requestId: string;
  const second = await UserInteractionCore.open({ ...f.options, authorize: () => true, authorizeAction: () => true, loadContext: async () => context,
    interpreter: { identity: () => ({ provider: "fixture", id: "independent-constraint", configurationHash: "b".repeat(64) }),
      interpret: async () => {
        const common = { basis: "explicit", resolution: "direct", candidateId: current.candidate.candidateId, requestId: null,
          actions: [], references: [], supersedes: [], scope: "A共享条件" };
        return JSON.stringify({ format: "interaction-interpretation/v1", referenceResolution: "single-question", entries: [
          { ...common, kind: "target", requestId, resolution: "accept", conclusion: "确认手机号A" },
          { ...common, kind: "unresolved", basis: "uncertain", resolution: "defer", conclusion: "微信B未决" },
          { ...common, kind: "action", requestId, resolution: "accept", actions: ["implement"], conclusion: "实施A" },
          { ...common, kind: "constraint", conclusion: "文档身份元数据" },
          { ...common, kind: "constraint", conclusion: old.conclusion, scope: old.scope, references: [oldId] },
        ], documentReview: { faithful: true, units: current.partition.units.map((u) => ({ id: u.id,
          disposition: u.id === "B" ? "pending-description" : "confirmed", globalConstraint: u.id === "C", appliesTo: u.id === "C" ? ["A"] : [], dependsOn: [],
          conclusionIndexes: [u.id === "metadata" ? 3 : u.id === "A" ? 0 : u.id === "B" ? 1 : 4] })),
          actions: [{ action: "implement", goalIds: ["A"], constraintIds: ["C"], conclusionIndexes: [2], unknown: false }],
          questions: [{ requestId, answeredIds: ["A"], pendingIds: [], conclusionIndexes: [0, 2] }] } });
      } } });
  cleanups.push(() => second.shutdown()); second.startSession({ sessionId: "second", windowId: "second" });
  const question = second.ask(JSON.stringify({ basis: current.basis, candidate: current.candidate, unitIds: ["A"], actions: ["implement"],
    proposal: { conclusion: "是否实施A", scope: "仅A", references: [], supersedes: [] } }));
  requestId = question.requestId; context.questions.push(question);
  const interpreted = await second.interpret(second.captureInput({ source: "interactive", text: "可以" }, "second"), f.saved.requirementId);
  const saved = second.save(interpreted.capability);
  const binding = { basis: current.basis, candidate: current.candidate };
  const document = () => second.authorizeDocument(interpreted.capability, binding);
  const authorized = document()!; expect(authorized).not.toBeNull();
  expect(authorized.manifest.units.find((u) => u.id === "C")!.decisionIds).toEqual([saved.decisionIds[4], oldId]);
  expect(authorized.authorization.receiptId).not.toBe(old.basisReceiptId);
  expect(second.authorizeScope(interpreted.capability, binding, { action: "implement", goalIds: ["A"], constraintIds: ["C"] })).not.toBeNull();
  expect(second.authorizeScope(interpreted.capability, binding, { action: "implement", goalIds: ["C"], constraintIds: [] })).toBeNull();
  const store = new ApprovalManifestStore({ ...f.options, authorize: () => true,
    loadExpected: async () => { const c = await load(); return { requirementId: c.requirementId, candidate: c.candidate, partition: c.partition }; },
    admit: (r) => { const d = document(); return d && decisionDigest(d.authorization.manifest) === decisionDigest(r.reference)
      ? { receiptId: d.authorization.receiptId, version: d.authorization.basis.version, epoch: d.authorization.basis.epoch, inputProof: d.authorization.inputProof } : null; } });
  const ref = await store.register(authorized.manifest);
  const snapshots = f.db((db) => db.read<any>(APPROVAL_MANIFEST_NAMESPACE, ref.manifestHash)!.data.decisionRecords);
  expect(snapshots.map((d: { id: string }) => d.id)).toContain(oldId);
  expect(snapshots.map((d: { id: string }) => d.id)).toContain(saved.decisionIds[4]);
  const approver = await RequirementService.open({ ...f.options, authorize: () => true, authorizeManifest: (r) => {
    const d = document(); return Boolean(d && r.version === current.version && r.requirementId === current.requirementId &&
      r.receiptId === d.authorization.receiptId && decisionDigest(r.manifest) === decisionDigest(d.authorization.manifest)); } });
  const confirm = { requirementId: current.requirementId, operationId, version: current.version, title: current.title, body: current.body,
    receiptId: authorized.authorization.receiptId, manifest: ref };
  const approved = await approver.confirmUpdate(confirm);
  expect(await approver.confirmUpdate(confirm)).toEqual(approved);
  expect(store.read(ref)).toEqual(authorized.manifest);
  expect((await f.service.read({ requirementId: current.requirementId, source: "approved" })).approvalScope).toMatchObject({
    status: "available", summary: { confirmed: ["metadata", "A", "C"], pending: ["B"] } });
  f.db((db) => {
    const row = db.read<any>("short_decisions", oldId)!;
    if (change === "missing") db.remove("short_decisions", oldId, row.version);
    else db.update("short_decisions", oldId, row.version, { ...row.data, ...(change === "superseded"
      ? { status: "superseded", supersededBy: uuidv7() } : { conclusion: "外部篡改原约束" }) });
  });
  expect(() => store.read(ref)).toThrow(/manifest_decision/);
  await expect(f.service.read({ requirementId: current.requirementId, source: "approved" })).rejects.toThrow(/manifest_decision/);
});

test("真实saved候选→Core部分批准→元数据清单→prod批准/read/事件，B无动作许可且Git原字节不变", async () => {
  const f = await fixture();
  expect(f.context.difference.kind).toBe("full_candidate"); expect(f.context.difference.from).toBeNull();
  expect(f.context.approved).toBeNull(); expect(f.context.body).toBe(f.input.body);
  const path = join(prodRequirementPath({ ...f.options, requirementId: f.saved.requirementId }), "prod.md");
  const bytes = await readFile(path);
  const manifest = f.document()!.manifest;
  expect(f.core.authorizeScope(f.interpreted.capability, f.binding(), { action: "implement", goalIds: ["A"], constraintIds: [] })).not.toBeNull();
  expect(f.core.authorizeScope(f.interpreted.capability, f.binding(), { action: "implement", goalIds: ["B"], constraintIds: [] })).toBeNull();
  expect(f.core.authorizeDocument(JSON.parse(JSON.stringify(f.interpreted.capability)) as InteractionCapability, f.binding())).toBeNull();
  const ref = await f.store.register(manifest);
  expect(await f.store.register(manifest)).toEqual(ref);
  expect(f.state.read(f.saved.requirementId).data.lifecycle).toBe("draft");
  expect(() => f.store.read(ref)).toThrow(/manifest_not_approved/);
  const confirmed = await f.approver.confirmUpdate(f.confirm());
  expect(confirmed.commit).toBe(f.saved.commit); expect(confirmed.lifecycle).toBe("active");
  expect(f.store.read(ref)).toEqual(manifest);
  expect(approvedManifestScope(f.store.read(ref), { action: "implement", goalIds: ["B"], constraintIds: [] })).toBeNull();
  expect((await f.service.read({ requirementId: f.saved.requirementId, source: "approved" })).approvalScope).toMatchObject({
    status: "available", summary: { reference: ref, confirmed: ["metadata", "A"], pending: ["B"], excluded: [], blocked: [] } });
  expect((await f.service.metadata(f.saved.requirementId)).approvalScope).toEqual(confirmed.approvalScope);
  expect((await f.service.diff({ requirementId: f.saved.requirementId, fromRevision: 1 })).approvalScope).toEqual(confirmed.approvalScope);
  const approvedEvents = f.state.events(f.saved.requirementId).filter((e) => e.data.kind === "prod.approved");
  expect(approvedEvents).toHaveLength(1); expect(approvedEvents[0]!.data.from).toBeNull();
  expect(approvedEvents[0]!.data.approvalManifest?.reference).toEqual(ref);
  expect(await f.approver.confirmUpdate(f.confirm())).toEqual(confirmed);
  expect(f.state.events(f.saved.requirementId).filter((e) => e.data.kind === "prod.approved")).toHaveLength(1);
  expect(await readFile(path)).toEqual(bytes);
  const metadata = f.db((db) => db.list(APPROVAL_MANIFEST_NAMESPACE));
  expect(metadata).toHaveLength(1); expect(JSON.stringify(metadata)).not.toContain(f.input.body);
  expect(JSON.stringify(metadata)).not.toMatch(/conclusion|微信|手机号/);
  const lease = await f.state.acquirePm({ requirementId: f.saved.requirementId, version: confirmed.version, runId: uuidv7(), expectedFence: 0 });
  const tool = await createRequirementReadTool({ ...f.options, binding: { role: "qa", callerId: uuidv7(), runId: uuidv7(),
    requirementId: f.saved.requirementId, repoId: f.options.repoId, workspaceId: lease.workspaceId, branch: f.workspace!.data.workspace!.branch, lease },
    authorize: (r) => f.access.live && r.binding.lease.runId === lease.runId });
  cleanups.push(() => tool.dispose());
  const page = await tool.execute({ action: "read", maxBytes: 4 });
  expect(page).toMatchObject({ source: { approvalScope: { summary: { pending: ["B"], reference: ref } } } });
  expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(49_152);
});

test("未ready可记录明确范围但不激活；服务和状态双重门槛保留", async () => {
  const f = await fixture(false); await f.store.register(f.document()!.manifest);
  await expect(f.approver.confirmUpdate(f.confirm())).rejects.toMatchObject({ code: "workspace_not_ready" });
  await expect(f.state.recordApprovedVersion({ requirementId: f.saved.requirementId, version: f.context.version,
    receiptId: f.confirm().receiptId, reference: f.context.saved, manifest: f.confirm().manifest })).rejects.toMatchObject({ code: "workspace_not_ready" });
  expect(f.state.read(f.saved.requirementId).data.lifecycle).toBe("draft");
  expect(f.state.events(f.saved.requirementId).filter((e) => e.data.kind === "prod.approved")).toEqual([]);
});

test("新批准接缝拒绝缺manifest、假ref、不同正文、跨需求与漏hash", async () => {
  const f = await fixture(); const input = f.confirm();
  const { manifest: _manifest, ...missing } = input;
  await expect(f.approver.confirmUpdate(missing)).rejects.toMatchObject({ code: "manifest_required" });
  await expect(f.approver.confirmUpdate({ ...input, body: "只含A，偷换B" })).rejects.toMatchObject({ code: "manifest_candidate_mismatch" });
  await expect(f.approver.confirmUpdate({ ...input, manifest: { ...input.manifest, requirementId: uuidv7() } })).rejects.toMatchObject({ code: "manifest_candidate_mismatch" });
  const malformed = structuredClone(input) as any; delete malformed.manifest.manifestHash;
  await expect(f.approver.confirmUpdate(malformed)).rejects.toMatchObject({ code: "invalid_shape" });
  await expect(f.approver.confirmUpdate({ ...input, manifest: { ...input.manifest, manifestHash: "f".repeat(64) } })).rejects.toMatchObject({ code: "manifest_authorization_required" });
  expect(f.state.read(f.saved.requirementId).data.approved).toBeNull();
});

test("清单未接可信admission默认拒绝；注册后撤权仍不能批准", async () => {
  const f = await fixture(), manifest = f.document()!.manifest;
  await expect(new ApprovalManifestStore({ ...f.storeOptions, admit: undefined }).register(manifest)).rejects.toMatchObject({ code: "manifest_admission_required" });
  await expect(new ApprovalManifestStore({ ...f.storeOptions, authorize: undefined }).register(manifest)).rejects.toMatchObject({ code: "manifest_authorization_required" });
  const ref = await f.store.register(manifest);
  await expect(f.state.recordApprovedVersion({ requirementId: f.saved.requirementId, version: f.context.version,
    receiptId: f.confirm().receiptId, reference: f.context.saved, manifest: ref })).rejects.toMatchObject({ code: "manifest_authorization_required" });
  f.core.revoke();
  await expect(f.approver.confirmUpdate(f.confirm())).rejects.toMatchObject({ code: "manifest_authorization_required" });
  expect(() => f.store.read(ref)).toThrow(/manifest_not_approved/);
});

test("批准DB故障完整回滚范围/状态/outbox，重试复用同保存commit", async () => {
  const f = await fixture(), ref = await f.store.register(f.document()!.manifest);
  const release = failDatabaseWrites(f.dbPath, "events", "stream", `requirement_events:${f.saved.requirementId}`);
  await expect(f.approver.confirmUpdate(f.confirm())).rejects.toThrow();
  expect(f.state.read(f.saved.requirementId).data.approved).toBeNull();
  expect(f.state.read(f.saved.requirementId).data.approvalManifest).toBeUndefined();
  expect(f.state.events(f.saved.requirementId).filter((e) => e.data.kind === "prod.approved")).toEqual([]);
  expect(f.db((db) => db.read(APPROVAL_MANIFEST_NAMESPACE, ref.manifestHash))).not.toBeNull();
  release();
  const retried = await f.approver.confirmUpdate(f.confirm());
  expect(retried.commit).toBe(f.saved.commit);
  expect(f.state.events(f.saved.requirementId).filter((e) => e.data.kind === "prod.approved")).toHaveLength(1);
});

test("被取代/篡改的真实短决定不能登记或维持批准范围", async () => {
  const f = await fixture(), manifest = f.document()!.manifest;
  const ref = await f.store.register(manifest); await f.approver.confirmUpdate(f.confirm());
  const decisionId = manifest.units.find((u) => u.id === "B")!.decisionIds[0]!;
  f.db((db) => { const row = db.read<any>("short_decisions", decisionId)!;
    db.update("short_decisions", decisionId, row.version, { ...row.data, status: "superseded", supersededBy: uuidv7() }); });
  expect(() => f.store.read(ref)).toThrow(/manifest_decision_mismatch/);
  await expect(f.service.read({ requirementId: f.saved.requirementId, source: "approved" })).rejects.toThrow(/manifest_decision_mismatch/);
  await expect(f.service.diff({ requirementId: f.saved.requirementId, fromRevision: 1 })).rejects.toThrow(/manifest_decision_mismatch/);
});

test("真实saved loader拒绝历史操作/任意ref，当前版本变化使旧Core与清单失效", async () => {
  const f = await fixture(), manifest = f.document()!.manifest;
  await f.store.register(manifest);
  await expect(f.service.loadConfirmationContext({ requirementId: f.saved.requirementId, savedOperationId: uuidv7(),
    operationId: uuidv7() })).rejects.toMatchObject({ code: "saved_operation_mismatch" });
  await expect(f.service.loadConfirmationContext({ requirementId: f.saved.requirementId, savedOperationId: f.saved.operationId,
    operationId: uuidv7(), path: "prod.md" } as any)).rejects.toMatchObject({ code: "invalid_shape" });
  await f.service.updateDraft({ requirementId: f.saved.requirementId, operationId: uuidv7(), version: f.context.version,
    title: f.input.title, body: f.input.body + "补充候选\n" });
  expect(f.document()).toBeNull();
  await expect(f.store.register(manifest)).rejects.toMatchObject({ code: "manifest_admission_required" });
  await expect(f.load()).rejects.toMatchObject({ code: "saved_operation_mismatch" });
  await expect(f.approver.confirmUpdate(f.confirm())).rejects.toMatchObject({ code: "manifest_candidate_mismatch" });
});

test("manifest注册过程中reentry拒绝，漏字节/错hash/跨需求清单不入库", async () => {
  const f = await fixture(), manifest = f.document()!.manifest;
  const { approvalManifestDigest } = await import("../runtime/approval-manifest.ts");
  for (const value of [
    { ...manifest, totalBytes: manifest.totalBytes + 1 },
    { ...manifest, units: manifest.units.slice(0, -1) },
    { ...manifest, manifestHash: "f".repeat(64) },
    { ...manifest, requirementId: uuidv7() },
  ]) await expect(f.store.register(value)).rejects.toThrow();
  expect(f.db((db) => db.list(APPROVAL_MANIFEST_NAMESPACE))).toHaveLength(0);
  let nested: Promise<unknown> | undefined;
  const store = new ApprovalManifestStore({ ...f.storeOptions, loadExpected: async () => {
    nested = store.register(manifest); await expect(nested).rejects.toMatchObject({ code: "manifest_reentry" });
    return f.storeOptions.loadExpected();
  } });
  const ref = await store.register(manifest); expect(ref.manifestHash).toBe(approvalManifestDigest(manifest));
  await f.approver.confirmUpdate(f.confirm());
  f.db((db) => { const row = db.read<any>(APPROVAL_MANIFEST_NAMESPACE, ref.manifestHash)!;
    db.update(APPROVAL_MANIFEST_NAMESPACE, ref.manifestHash, row.version, { ...row.data,
      manifest: { ...row.data.manifest, manifestHash: "f".repeat(64) } }); });
  expect(() => store.read(ref)).toThrow(/manifest_hash_mismatch/);
});

test("状态普通授权回调中的撤权必须先于最后Core核验，不能在许可之后重入批准", async () => {
  const f = await fixture(), ref = await f.store.register(f.document()!.manifest);
  let approvals = 0;
  const state = await RequirementStateStore.open({ ...f.options, authorize: (r) => {
    if (r.action === "approved-version" && ++approvals === 2) f.core.revoke();
    return r.repoId === f.options.repoId;
  }, authorizeManifest: () => f.document() !== null });
  await expect(state.recordApprovedVersion({ requirementId: f.saved.requirementId, version: f.context.version,
    receiptId: f.confirm().receiptId, reference: f.context.saved, manifest: ref })).rejects.toMatchObject({ code: "manifest_authorization_required" });
  expect(f.state.read(f.saved.requirementId).data.approved).toBeNull();
  expect(f.state.events(f.saved.requirementId).filter((e) => e.data.kind === "prod.approved")).toHaveLength(0);
});

test("输入能力TTL过期后已存manifest不能变成批准", async () => {
  const f = await fixture(); await f.store.register(f.document()!.manifest);
  f.clock.now += 900_001;
  expect(f.document()).toBeNull();
  await expect(f.approver.confirmUpdate(f.confirm())).rejects.toMatchObject({ code: "manifest_authorization_required" });
  expect(f.state.read(f.saved.requirementId).data.approved).toBeNull();
});

test("活动候选diff使用准确已批准到saved提交，不用最近两个Git提交", async () => {
  const f = await fixture(); await f.store.register(f.document()!.manifest);
  const approved = await f.approver.confirmUpdate(f.confirm());
  const first = await f.service.updateDraft({ requirementId: approved.requirementId, operationId: uuidv7(), version: approved.version,
    title: f.input.title, body: f.input.body + "草稿一\n" });
  const second = await f.service.updateDraft({ requirementId: approved.requirementId, operationId: uuidv7(), version: first.version,
    title: f.input.title, body: f.input.body + "草稿二\n" });
  const context = await f.service.loadConfirmationContext({ requirementId: approved.requirementId, savedOperationId: second.operationId, operationId: uuidv7() });
  expect(context.difference).toMatchObject({ kind: "diff", from: { commit: approved.commit }, to: { commit: second.commit } });
  expect(context.difference.text).toContain("+草稿二"); expect(context.difference.text).not.toContain("-草稿一");
  expect(context.approved?.commit).toBe(approved.commit);
  expect((await f.service.read({ requirementId: approved.requirementId, source: "saved" })).approvalScope).toEqual({ status: "unavailable" });
});

test("纯重复confirm不换manifest，响应丢失后同操作仍只有一条批准事件", async () => {
  const f = await fixture(); await f.store.register(f.document()!.manifest);
  const confirmed = await f.approver.confirmUpdate(f.confirm());
  const changed = f.confirm(); changed.manifest.manifestHash = "f".repeat(64);
  await expect(f.approver.confirmUpdate(changed)).rejects.toThrow();
  expect(await f.approver.confirmUpdate(f.confirm())).toEqual(confirmed);
  expect(f.state.events(f.saved.requirementId).filter((e) => e.data.kind === "prod.approved")).toHaveLength(1);
});

test("closed/epoch撤权不回读范围或saved候选，保留本机原字节", async () => {
  const f = await fixture(), ref = await f.store.register(f.document()!.manifest);
  await f.approver.confirmUpdate(f.confirm());
  const path = join(prodRequirementPath({ ...f.options, requirementId: f.saved.requirementId }), "prod.md"), bytes = await readFile(path);
  const current = f.state.read(f.saved.requirementId);
  const closing = f.state.beginClose({ requirementId: current.id, version: current.version,
    intent: { operationId: uuidv7(), receiptId: uuidv7(), reason: "cancelled" } });
  f.state.finishClose({ requirementId: current.id, version: closing.version, operationId: closing.data.close!.operationId });
  expect(() => f.store.read(ref)).toThrow(/lifecycle_denied/);
  await expect(f.load()).rejects.toMatchObject({ code: "lifecycle_denied" });
  expect((await f.service.metadata(current.id)).approvalScope).toBeUndefined();
  expect(await readFile(path)).toEqual(bytes);
});
