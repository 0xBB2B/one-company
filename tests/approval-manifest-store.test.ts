import { afterEach, expect, test } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { repositoryDatabase, StaleVersionError, uuidv7, withDatabase } from "../src/core/storage/database.ts";
import type { LocalDatabase } from "../src/core/storage/database.ts";
import { repositoryIdentity } from "../src/core/storage/identity.ts";
import { RequirementService } from "../src/modules/requirement/requirement-service.ts";
import type { RequirementRecord } from "../src/modules/requirement/requirement-contracts.ts";
import type { RequirementDocSection } from "../src/modules/requirement/requirement-doc.ts";
import { continuityInputProofIn } from "../src/modules/requirement/interaction-continuity.ts";
import { addWorktree, createRepoFixture, GIT_ENV, removeRepoFixture } from "./helpers/repo-fixture.ts";
import { RequirementStateStore } from "../src/modules/requirement/requirement-state.ts";
import { RequirementEventService } from "../src/modules/requirement/requirement-events.ts";
import { implementAuthorized } from "../src/modules/pm/pm-intake-runtime.ts";
import { manifestConfirmInput } from "./helpers/approval-fixture.ts";
import { adviceOf } from "../src/core/exec/tool-failure.ts";
import { temporaryRoot } from "./helpers/temporary-root.ts";
import { approveWithManifest } from "./helpers/approval-fixture.ts";
import { implementScope } from "../src/modules/pm/plan-manage.ts";
import { partitionPrdDocument } from "../src/modules/requirement/prd-view.ts";
import { approvalManifestDigest, approvalManifestReference, checkApprovalManifest, implementGoalUnitIds, manifestAuthorizesImplement, supplementImplementAction } from "../src/modules/requirement/approval-manifest.ts";
import { ApprovalManifestStore, APPROVAL_MANIFEST_NAMESPACE, registeredApprovalManifestIn, summarizeApprovalManifest } from "../src/modules/requirement/approval-manifest-store.ts";

function fixture() {
  const requirementId = uuidv7(), partition = partitionPrdDocument(requirementId, "范围", "# A {#A}\n目标\n# B {#B}\n未决\n");
  const candidate = { candidateId: uuidv7(), operationId: uuidv7(), intentHash: "a".repeat(64), from: null,
    to: { commit: "b".repeat(40), hash: partition.prdHash } };
  const payload = { format: "approval-manifest/v1" as const, requirementId, candidate, totalBytes: partition.totalBytes,
    units: partition.units.map((u) => ({ ...u, disposition: u.id === "B" ? "pending-description" as const : "confirmed" as const,
      globalConstraint: u.id === "B", appliesTo: u.id === "B" ? ["A"] : [], dependsOn: [], decisionIds: [uuidv7()] })),
    actions: [], questions: [] };
  const expected = { requirementId, candidate, partition };
  const manifest = checkApprovalManifest({ ...payload, manifestHash: approvalManifestDigest(payload) }, expected);
  return { manifest, expected, ref: approvalManifestReference(manifest) };
}

test("有界摘要完整列出pending和受依赖阻塞IDs，不包含正文或全文清单", () => {
  const f = fixture();
  expect(summarizeApprovalManifest(f.manifest)).toEqual({ reference: f.ref, confirmed: ["metadata", "A"],
    pending: ["B"], excluded: [], blocked: ["A"] });
  expect(Buffer.byteLength(JSON.stringify(summarizeApprovalManifest(f.manifest)))).toBeLessThan(2_048);
});

test("构造存储器或持有manifest JSON不产生授权，缺授权时loader和DB都不触及", async () => {
  const f = fixture(); let loaded = false;
  const store = new ApprovalManifestStore({ dataRoot: "/must-not-be-touched", repoId: "c".repeat(64),
    loadExpected: async () => { loaded = true; return f.expected; } });
  await expect(store.register(f.manifest)).rejects.toMatchObject({ code: "manifest_authorization_required" });
  expect(() => store.read(f.ref)).toThrow(/manifest_authorization_required/);
  expect(loaded).toBe(false);
});

test("异步授权不能绕过同步门槛，迟到拒绝被消费且不打开DB", async () => {
  const f = fixture();
  const store = new ApprovalManifestStore({ dataRoot: "/must-not-be-touched", repoId: "c".repeat(64), loadExpected: async () => f.expected,
    authorize: (() => Promise.reject(new Error("fixture denial"))) as any });
  await expect(store.register(f.manifest)).rejects.toMatchObject({ code: "manifest_authorization_required" });
  await new Promise((resolve) => setImmediate(resolve));
});

test("引用严格拒绝尾随hash、跨schema和正文载荷，不把未知字段送往授权回调", async () => {
  const f = fixture(); let authorized = false;
  const store = new ApprovalManifestStore({ dataRoot: "/must-not-be-touched", repoId: "c".repeat(64), loadExpected: async () => f.expected,
    authorize: () => { authorized = true; return false; } });
  await expect(store.register({ ...f.manifest, manifestHash: f.manifest.manifestHash + "\n" })).rejects.toThrow();
  expect(() => store.read({ ...f.ref, body: "payload" } as any)).toThrow();
  expect(authorized).toBe(false);
});

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const goalSections: RequirementDocSection[] = [{ id: "A", title: "手机号", goal: true }];

type Kind = "plain" | "implemented" | "prior-source";
const exec = promisify(execFile);
async function approvedWithoutImplement(kind: Kind = "plain", withPm = false) {
  const root = await mkdtemp(join(temporaryRoot(), "supplement-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const repo = await createRepoFixture(); cleanups.push(() => removeRepoFixture(repo));
  const identity = await repositoryIdentity(repo.root);
  const options = { repositoryRoot: repo.root, dataRoot: join(root, "data"), repoId: identity.repoId };
  const service = await RequirementService.open({ ...options, authorize: () => true });
  const title = "补授权", body = "# A {#A}\n手机号登录\n";
  const created = await service.create({ requestId: uuidv7(), operationId: uuidv7(), title, body });
  const db = <T>(run: (db: LocalDatabase) => T) => withDatabase(repositoryDatabase(options.dataRoot, options.repoId), run);
  const requirement = () => db((d) => d.read<RequirementRecord>("requirements", created.requirementId))!;
  const partition = partitionPrdDocument(created.requirementId, title, body);
  const proof = () => db((d) => continuityInputProofIn(d, created.requirementId));
  function decisionRecord(context: { version: number; epoch: number; prd: unknown; receiptId: string }, patch: Record<string, unknown>, rowId?: string): string {
    const decisionId = uuidv7(), saved = requirement().data.saved!;
    db((d) => d.create("short_decisions", decisionId, { format: "short-decision/v1", decisionId, operationId: uuidv7(), requirementId: created.requirementId,
      repoId: options.repoId, requirementVersion: context.version, epoch: context.epoch, prd: context.prd, conclusion: "授权实施", scope: "整份需求",
      references: [saved.commit, saved.hash], supersedes: [], actor: "user", status: "confirmed",
      basisReceiptId: context.receiptId, supersededBy: null, recordedAt: 1, ...patch }, rowId ?? decisionId));
    return decisionId;
  }
  if (kind === "prior-source") {
    const draft = requirement(), approvalReceipt = uuidv7(), operationId = uuidv7();
    const { candidate } = await service.loadConfirmationContext({ requirementId: created.requirementId, savedOperationId: created.operationId, operationId });
    const draftContext = { version: draft.version, epoch: draft.data.epoch, prd: candidate.from, receiptId: approvalReceipt };
    const candidateRefs = [candidate.candidateId, candidate.intentHash, candidate.to.commit, candidate.to.hash];
    const metadataDecision = decisionRecord(draftContext, { references: candidateRefs, conclusion: "需求身份元数据" });
    const priorDecision = decisionRecord({ ...draftContext, receiptId: uuidv7() }, { conclusion: "保留邮箱", scope: "共享条件" });
    const copyDecision = decisionRecord(draftContext, { references: [...candidateRefs, priorDecision].sort(), conclusion: "保留邮箱", scope: "共享条件" });
    const payload = { format: "approval-manifest/v1" as const, requirementId: created.requirementId, candidate, totalBytes: partition.totalBytes,
      units: partition.units.map((u) => ({ ...u, disposition: "confirmed" as const, globalConstraint: false, appliesTo: [], dependsOn: [],
        decisionIds: u.id === "metadata" ? [metadataDecision] : [copyDecision, priorDecision] })), actions: [], questions: [] };
    const manifest = checkApprovalManifest({ ...payload, manifestHash: approvalManifestDigest(payload) },
      { requirementId: created.requirementId, candidate, partition });
    const registrar = new ApprovalManifestStore({ ...options, loadExpected: async () => ({ requirementId: created.requirementId, candidate, partition }),
      authorize: () => true, admit: () => ({ receiptId: approvalReceipt, version: draft.version, epoch: draft.data.epoch, inputProof: proof() }) });
    const reference = await registrar.register(manifest);
    const approver = await RequirementService.open({ ...options, authorize: () => true, authorizeManifest: () => true });
    await approver.confirmUpdate({ requirementId: created.requirementId, operationId, version: draft.version, title, body, receiptId: approvalReceipt, manifest: reference });
  } else await approveWithManifest(options, { requirementId: created.requirementId, savedOperationId: created.operationId, implement: kind === "implemented" });
  let lease: Awaited<ReturnType<RequirementStateStore["acquirePm"]>> | undefined;
  if (withPm) {
    const state = await RequirementStateStore.open({ ...options, authorize: () => true, authorizeManifest: () => true });
    const worktree = await addWorktree(repo);
    const baseCommit = (await exec("git", ["rev-parse", "HEAD"], { cwd: worktree.root, env: GIT_ENV })).stdout.trim();
    await state.bindWorkspace({ requirementId: created.requirementId, version: requirement().version, path: worktree.root, prepareOperationId: uuidv7(), baseCommit });
    lease = await state.acquirePm({ requirementId: created.requirementId, version: requirement().version, runId: uuidv7(), expectedFence: 0 });
  }
  const row = requirement(), oldRef = row.data.approvalManifest!.reference;
  const expected = { requirementId: created.requirementId, candidate: oldRef.candidate, partition };
  const reader = new ApprovalManifestStore({ ...options, loadExpected: async () => expected, authorize: () => true });
  const base = reader.read(oldRef);
  const receiptId = uuidv7();
  const admission = { receiptId, version: row.version, epoch: row.data.epoch };
  const storeWith = (inputProof: () => string = proof, version = admission.version) => new ApprovalManifestStore({ ...options, loadExpected: async () => expected, authorize: () => true,
    admit: () => ({ ...admission, version, inputProof: inputProof() }) });
  function saveDecision(patch: Record<string, unknown> = {}, rowId?: string): string {
    return decisionRecord({ version: row.version, epoch: row.data.epoch, prd: row.data.approved, receiptId }, patch, rowId);
  }
  const supplement = (decisionId: string) => supplementImplementAction({ manifest: base, goalIds: implementGoalUnitIds(base, goalSections), decisionId });
  const registered = (ref: { manifestHash: string }) => db((d) => d.read(APPROVAL_MANIFEST_NAMESPACE, ref.manifestHash));
  return { options, title, lease, requirementId: created.requirementId, db, requirement, row, oldRef, base, receiptId, admission, proof, storeWith, saveDecision, supplement, registered, reader };
}

test("补授权清单登记后，按补授权凭据核对通过，按其他凭据拒绝，旧清单照旧可读", async () => {
  const w = await approvedWithoutImplement();
  const decisionId = w.saveDecision(), next = w.supplement(decisionId);
  const ref = await w.storeWith().registerImplementSupplement({ base: w.oldRef, manifest: next, decisionId });
  expect(ref).toEqual(approvalManifestReference(next));
  expect(w.registered(ref)).not.toBeNull();
  const record = w.requirement();
  expect(w.db((d) => registeredApprovalManifestIn(d, w.options.repoId, ref, record, w.receiptId))).toEqual(next);
  expect(() => w.db((d) => registeredApprovalManifestIn(d, w.options.repoId, ref, record, uuidv7()))).toThrow();
  expect(w.reader.read(w.oldRef)).toEqual(w.base);
});

for (const patch of [
  { name: "basisReceiptId不是本次凭据", change: () => ({ basisReceiptId: uuidv7() }) },
  { name: "requirementVersion是旧版本", change: (w: Awaited<ReturnType<typeof approvedWithoutImplement>>) => ({ requirementVersion: w.admission.version - 1 }) },
  { name: "epoch不是本次凭据的", change: (w: Awaited<ReturnType<typeof approvedWithoutImplement>>) => ({ epoch: w.admission.epoch + 1 }) },
  { name: "prd不是已批准版本", change: () => ({ prd: { commit: "c".repeat(40), hash: "d".repeat(64) } }) },
  { name: "actor为ai", change: () => ({ actor: "ai" }) },
  { name: "状态不是confirmed", change: () => ({ status: "pending" }) },
  { name: "references缺候选commit和hash", change: () => ({ references: [] }) },
  { name: "带supersedes", change: () => ({ supersedes: [uuidv7()] }) },
]) {
  test(`补授权决定${patch.name}时拒绝登记`, async () => {
    const w = await approvedWithoutImplement();
    const decisionId = w.saveDecision(patch.change(w as never)), next = w.supplement(decisionId);
    await expect(w.storeWith().registerImplementSupplement({ base: w.oldRef, manifest: next, decisionId })).rejects.toThrow();
    expect(w.registered(next)).toBeNull();
  });
}

test("登记前原话指纹变了拒绝登记", async () => {
  const w = await approvedWithoutImplement();
  const decisionId = w.saveDecision(), next = w.supplement(decisionId);
  await expect(w.storeWith(() => "f".repeat(64)).registerImplementSupplement({ base: w.oldRef, manifest: next, decisionId })).rejects.toThrow();
  expect(w.registered(next)).toBeNull();
});

test("结构被篡改的补授权清单（多塞push动作）拒绝登记", async () => {
  const w = await approvedWithoutImplement();
  const decisionId = w.saveDecision(), next = structuredClone(w.supplement(decisionId));
  next.actions.push({ action: "push", goalIds: ["A"], constraintIds: [], unknown: false, decisionIds: [decisionId] });
  next.manifestHash = approvalManifestDigest(next);
  await expect(w.storeWith().registerImplementSupplement({ base: w.oldRef, manifest: next, decisionId })).rejects.toThrow();
  expect(w.registered(next)).toBeNull();
});

test("补授权决定的行id与decisionId不一致时拒绝登记", async () => {
  const w = await approvedWithoutImplement();
  const decisionId = w.saveDecision({}, uuidv7()), next = w.supplement(decisionId);
  await expect(w.storeWith().registerImplementSupplement({ base: w.oldRef, manifest: next, decisionId })).rejects.toThrow();
  expect(w.registered(next)).toBeNull();
});

type World = Awaited<ReturnType<typeof approvedWithoutImplement>>;
async function registeredSupplement(w: World) {
  const decisionId = w.saveDecision(), next = w.supplement(decisionId);
  const ref = await w.storeWith().registerImplementSupplement({ base: w.oldRef, manifest: next, decisionId });
  return { decisionId, next, ref };
}

test("实施目标段落带从更早记录复制的约束：旧清单能登记，补授权列它为实施目标后也能登记", async () => {
  const w = await approvedWithoutImplement("prior-source");
  expect(manifestAuthorizesImplement(w.base)).toBe(false);
  const decisionId = w.saveDecision(), next = w.supplement(decisionId);
  const ref = await w.storeWith().registerImplementSupplement({ base: w.oldRef, manifest: next, decisionId });
  expect(w.registered(ref)).not.toBeNull();
  expect([...implementScope(next, goalSections)]).toEqual(["A"]);
});

test("用旧清单原来的批准凭据核对补授权行时拒绝", async () => {
  const w = await approvedWithoutImplement();
  const { ref } = await registeredSupplement(w);
  const oldReceiptId = w.row.data.approvalReceiptId!;
  expect(oldReceiptId).not.toBe(w.receiptId);
  expect(() => w.db((d) => registeredApprovalManifestIn(d, w.options.repoId, ref, w.requirement(), oldReceiptId))).toThrow();
});

for (const mode of ["with-receipt", "without-receipt"] as const) for (const tamper of ["superseded", "content"] as const) {
  test(`登记后补授权决定被改成${tamper}，${mode === "with-receipt" ? "带凭据" : "不带凭据"}读补授权行被拒`, async () => {
    const w = await approvedWithoutImplement();
    const { decisionId, next, ref } = await registeredSupplement(w);
    if (mode === "without-receipt") w.db((d) => { const r = d.read<RequirementRecord>("requirements", w.requirementId)!;
      d.update("requirements", w.requirementId, r.version, { ...r.data, approvalManifest: summarizeApprovalManifest(next) }); });
    const read = () => w.db((d) => registeredApprovalManifestIn(d, w.options.repoId, ref, w.requirement(), mode === "with-receipt" ? w.receiptId : undefined));
    expect(read()).toEqual(next);
    w.db((d) => { const r = d.read<Record<string, unknown>>("short_decisions", decisionId)!;
      d.update("short_decisions", decisionId, r.version, { ...r.data, ...(tamper === "superseded" ? { status: "superseded", supersededBy: uuidv7() } : { conclusion: "被改过的内容" }) }); });
    expect(read).toThrow();
  });
}

test("需求 saved 不等于 approved 时拒绝登记补授权", async () => {
  const w = await approvedWithoutImplement();
  w.db((d) => { const r = d.read<RequirementRecord>("requirements", w.requirementId)!;
    d.update("requirements", w.requirementId, r.version, { ...r.data, saved: { commit: "c".repeat(40), hash: "d".repeat(64) } }); });
  const version = w.requirement().version, decisionId = w.saveDecision({ requirementVersion: version }), next = w.supplement(decisionId);
  await expect(w.storeWith(undefined, version).registerImplementSupplement({ base: w.oldRef, manifest: next, decisionId })).rejects.toThrow();
  expect(w.registered(next)).toBeNull();
});

test("传入的 base 不是需求当前清单时拒绝登记补授权", async () => {
  const w = await approvedWithoutImplement();
  const decisionId = w.saveDecision(), next = w.supplement(decisionId);
  await expect(w.storeWith().registerImplementSupplement({ base: { ...w.oldRef, manifestHash: "e".repeat(64) }, manifest: next, decisionId })).rejects.toThrow();
  expect(w.registered(next)).toBeNull();
});

test("旧清单已有实施时拒绝登记补授权", async () => {
  const w = await approvedWithoutImplement("implemented");
  expect(manifestAuthorizesImplement(w.base)).toBe(true);
  const decisionId = w.saveDecision(), next = structuredClone(w.base);
  next.actions.push({ action: "implement", goalIds: ["A"], constraintIds: [], unknown: false, decisionIds: [decisionId] });
  next.manifestHash = approvalManifestDigest(next);
  await expect(w.storeWith().registerImplementSupplement({ base: w.oldRef, manifest: next, decisionId })).rejects.toThrow();
  expect(w.registered(next)).toBeNull();
});

test("同一份内容重复登记返回同一引用；同 hash 内容不同时报冲突", async () => {
  const w = await approvedWithoutImplement();
  const { decisionId, next, ref } = await registeredSupplement(w);
  expect(await w.storeWith().registerImplementSupplement({ base: w.oldRef, manifest: next, decisionId })).toEqual(ref);
  w.db((d) => { const r = d.read<{ decisionRecords: Array<Record<string, unknown>> }>(APPROVAL_MANIFEST_NAMESPACE, ref.manifestHash)!;
    d.update(APPROVAL_MANIFEST_NAMESPACE, ref.manifestHash, r.version, { ...r.data, decisionRecords: r.data.decisionRecords.map((x, i) => i ? x : { ...x, hash: "0".repeat(64) }) }); });
  await expect(w.storeWith().registerImplementSupplement({ base: w.oldRef, manifest: next, decisionId })).rejects.toMatchObject({ code: "manifest_conflict" });
});

type Authorize = (request: unknown) => boolean;
async function supplemented(w: World, authorizeManifest: Authorize = () => true) {
  const { next, ref } = await registeredSupplement(w);
  const store = await RequirementStateStore.open({ ...w.options, authorize: () => true, authorizeManifest });
  const input = { requirementId: w.requirementId, version: w.row.version, receiptId: w.receiptId, manifest: ref };
  return { next, ref, store, input };
}
const pmOwnership = (w: World) => w.db((d) => d.read("pm_ownership", w.requirementId)?.data);
const eventKinds = (w: World, store: RequirementStateStore) => store.events(w.requirementId).map((event) => event.data.kind);

test("补授权成功：版本加1，批准相关字段和PM租约不变，摘要只换reference，多一条implement.authorized事件", async () => {
  const w = await approvedWithoutImplement("plain", true);
  const { next, ref, store, input } = await supplemented(w);
  const before = w.requirement(), ownershipBefore = pmOwnership(w), kindsBefore = eventKinds(w, store);
  expect(implementAuthorized(w.options, before)).toBe(false);
  const after = await store.recordImplementAuthorization(input);
  const row = w.requirement();
  expect(after.version).toBe(before.version + 1);
  expect(row.version).toBe(before.version + 1);
  for (const key of ["epoch", "revision", "pendingRevision", "approved", "approvalReceiptId", "lifecycle", "recovery"] as const) expect(row.data[key]).toEqual(before.data[key]);
  expect(row.data.approvalManifest).toEqual({ ...before.data.approvalManifest, reference: ref });
  expect(row.data.approvalManifest).toEqual(summarizeApprovalManifest(next));
  expect(eventKinds(w, store)).toEqual([...kindsBefore, "implement.authorized"]);
  expect(pmOwnership(w)).toEqual(ownershipBefore);
  expect(w.db((d) => registeredApprovalManifestIn(d, w.options.repoId, ref, row))).toEqual(next);
  expect(implementAuthorized(w.options, row)).toBe(true);
});

test("补授权成功后PM读下一个已批准事件返回已追上，不会收到新版本", async () => {
  const w = await approvedWithoutImplement("plain", true);
  const events = await RequirementEventService.open({ ...w.options, authorize: () => true });
  cleanups.push(async () => { events.dispose(); });
  const prepared = await events.prepareCurrentBaseline({ lease: w.lease! });
  events.consumePreparedDelivery({ lease: w.lease!, handle: prepared.handle, contextGeneration: w.lease!.contextGeneration, version: prepared.version });
  await events.acknowledgeBaseline({ lease: w.lease!, deliveryId: prepared.deliveryId });
  expect(await events.poll({ lease: w.lease! })).toMatchObject({ status: "caught_up" });
  const { store, input } = await supplemented(w);
  await store.recordImplementAuthorization(input);
  expect(await events.poll({ lease: w.lease! })).toMatchObject({ status: "caught_up" });
});

test("补授权写入前最后调用一次清单核对回调；回调返回false时拒绝且需求记录不变", async () => {
  const w = await approvedWithoutImplement();
  const calls: unknown[] = [];
  const { store, input } = await supplemented(w, (request) => { calls.push(request); return false; });
  const before = w.requirement(), kinds = eventKinds(w, store);
  await expect(store.recordImplementAuthorization(input)).rejects.toThrow(/manifest_authorization_required/);
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({ requirementId: w.requirementId, version: input.version, receiptId: input.receiptId, manifest: input.manifest });
  expect(w.requirement()).toEqual(before);
  expect(eventKinds(w, store)).toEqual(kinds);
});

test("补授权用旧版本号和另一个凭据重放被拒，错误是版本过期，不多写事件", async () => {
  const w = await approvedWithoutImplement();
  const { store, input } = await supplemented(w);
  await expect(store.recordImplementAuthorization({ ...input, version: input.version - 1 })).rejects.toBeInstanceOf(StaleVersionError);
  expect(w.requirement().version).toBe(input.version);
  await store.recordImplementAuthorization(input);
  const done = w.requirement(), count = eventKinds(w, store).length;
  await expect(store.recordImplementAuthorization({ ...input, receiptId: uuidv7() })).rejects.toBeInstanceOf(StaleVersionError);
  expect(w.requirement()).toEqual(done);
  expect(eventKinds(w, store)).toHaveLength(count);
});

test("补授权成功后用完全相同的输入原样重试：直接返回当前记录，不报错、不多写事件", async () => {
  const w = await approvedWithoutImplement();
  const { store, input, ref } = await supplemented(w);
  const first = await store.recordImplementAuthorization(input);
  const count = eventKinds(w, store).length;
  const again = await store.recordImplementAuthorization(input);
  expect(again.version).toBe(first.version);
  expect(again.data.approvalManifest!.reference).toEqual(ref);
  expect(w.requirement()).toEqual(first);
  expect(eventKinds(w, store)).toHaveLength(count);
});

test("服务补授权成功后用完全相同的输入原样重试：返回同一回执，不报错、不多写事件", async () => {
  const w = await approvedWithoutImplement();
  const { service, input, ref } = await serviceFor(w);
  const first = await service.authorizeImplement(input);
  const store = await RequirementStateStore.open({ ...w.options, authorize: () => true });
  const count = store.events(w.requirementId).length;
  const again = await service.authorizeImplement(input);
  expect(again).toEqual(first);
  expect(again.approvalScope).toMatchObject({ summary: { reference: ref } });
  expect(store.events(w.requirementId)).toHaveLength(count);
});

test("补授权用旧批准凭据或未登记的凭据被拒，错误码manifest_stale", async () => {
  const w = await approvedWithoutImplement();
  const { store, input } = await supplemented(w);
  const before = w.requirement();
  for (const receiptId of [before.data.approvalReceiptId!, uuidv7()]) {
    await expect(store.recordImplementAuthorization({ ...input, receiptId })).rejects.toThrow(/manifest_stale/);
  }
  expect(w.requirement()).toEqual(before);
});

test("补授权清单的旧清单指纹不是需求当前清单时被拒，错误码manifest_supplement_mismatch", async () => {
  const w = await approvedWithoutImplement();
  const { store, input, ref } = await supplemented(w);
  w.db((d) => { const r = d.read<{ supplement: { baseManifestHash: string } }>(APPROVAL_MANIFEST_NAMESPACE, ref.manifestHash)!;
    d.update(APPROVAL_MANIFEST_NAMESPACE, ref.manifestHash, r.version, { ...r.data, supplement: { ...r.data.supplement, baseManifestHash: "e".repeat(64) } }); });
  const before = w.requirement(), kinds = eventKinds(w, store);
  await expect(store.recordImplementAuthorization(input)).rejects.toThrow(/manifest_supplement_mismatch/);
  expect(w.requirement()).toEqual(before);
  expect(eventKinds(w, store)).toEqual(kinds);
});

test("需求恢复状态为needs_review时补授权被拒，需求记录与事件不变", async () => {
  const w = await approvedWithoutImplement();
  const { store, input } = await supplemented(w);
  const blocked = store.blockForRecovery({ requirementId: w.requirementId, version: input.version, reason: "archive_found" });
  expect(blocked.data.recovery).toBe("needs_review");
  const before = w.requirement(), kinds = eventKinds(w, store);
  await expect(store.recordImplementAuthorization({ ...input, version: blocked.version })).rejects.toThrow(/recovery_required/);
  expect(w.requirement()).toEqual(before);
  expect(eventKinds(w, store)).toEqual(kinds);
});

for (const stage of ["draft", "closing", "closed"] as const) {
  test(`补授权时需求处于${stage}状态被拒，错误码lifecycle_denied`, async () => {
    const w = await approvedWithoutImplement();
    const { store, input } = await supplemented(w);
    let requirementId = w.requirementId, version = input.version;
    if (stage === "draft") {
      const service = await RequirementService.open({ ...w.options, authorize: () => true });
      const draft = await service.create({ requestId: uuidv7(), operationId: uuidv7(), title: "草稿", body: "# A {#A}\n草稿\n" });
      requirementId = draft.requirementId; version = draft.version;
    } else {
      const intent = { operationId: uuidv7(), reason: "cancelled" as const, receiptId: uuidv7() };
      const closing = store.beginClose({ requirementId, version, intent });
      version = stage === "closed" ? store.finishClose({ requirementId, version: closing.version, operationId: intent.operationId }).version : closing.version;
    }
    const read = () => w.db((d) => d.read<RequirementRecord>("requirements", requirementId)!);
    const before = read(), kinds = store.events(requirementId);
    await expect(store.recordImplementAuthorization({ ...input, requirementId, version })).rejects.toThrow(/lifecycle_denied/);
    expect(read()).toEqual(before);
    expect(store.events(requirementId)).toEqual(kinds);
  });
}

test("补授权时草稿有未批准的修改被拒，错误码draft_unapproved_changes", async () => {
  const w = await approvedWithoutImplement();
  const { store, input } = await supplemented(w);
  w.db((d) => { const r = d.read<RequirementRecord>("requirements", w.requirementId)!;
    d.update("requirements", w.requirementId, r.version, { ...r.data, saved: { commit: "c".repeat(40), hash: "d".repeat(64) } }); });
  const before = w.requirement();
  await expect(store.recordImplementAuthorization({ ...input, version: before.version })).rejects.toThrow(/draft_unapproved_changes/);
  expect(w.requirement()).toEqual(before);
});

test("补授权时当前清单已有实施被拒，错误码implement_already_authorized", async () => {
  const w = await approvedWithoutImplement("implemented");
  const store = await RequirementStateStore.open({ ...w.options, authorize: () => true, authorizeManifest: () => true });
  const before = w.requirement();
  await expect(store.recordImplementAuthorization({ requirementId: w.requirementId, version: before.version,
    receiptId: before.data.approvalReceiptId!, manifest: w.oldRef })).rejects.toThrow(/implement_already_authorized/);
  expect(w.requirement()).toEqual(before);
});

async function serviceFor(w: World, authorize: (request: { action: string }) => boolean = () => true) {
  const service = await RequirementService.open({ ...w.options, authorize: authorize as never, authorizeManifest: () => true });
  const { ref } = await registeredSupplement(w);
  return { service, ref, input: { requirementId: w.requirementId, version: w.row.version, receiptId: w.receiptId, manifest: ref } };
}

test("服务补授权成功：回执含需求编号、新版本、epoch、revision和带实施的批准范围，授权回调动作名为authorizeImplement", async () => {
  const w = await approvedWithoutImplement();
  const actions: string[] = [];
  const { service, input, ref } = await serviceFor(w, (request) => { actions.push(request.action); return true; });
  actions.length = 0;
  const before = w.requirement();
  const receipt = await service.authorizeImplement(input);
  expect(receipt).toMatchObject({ requirementId: w.requirementId, version: before.version + 1, epoch: before.data.epoch, revision: before.data.revision });
  expect(receipt.approvalScope).toMatchObject({ status: "available", summary: { reference: ref } });
  expect(actions).toContain("authorizeImplement");
  expect(implementAuthorized(w.options, w.requirement())).toBe(true);
});

test("服务授权回调返回false时拒绝补授权，错误码authorization_required，需求记录不变", async () => {
  const w = await approvedWithoutImplement();
  const { service, input } = await serviceFor(w, (request) => request.action !== "authorizeImplement");
  const before = w.requirement();
  await expect(service.authorizeImplement(input)).rejects.toMatchObject({ code: "authorization_required" });
  expect(w.requirement()).toEqual(before);
});

test("服务补授权时草稿有未批准的修改被拒，原因含草稿有未批准的修改", async () => {
  const w = await approvedWithoutImplement();
  const { service, input } = await serviceFor(w);
  w.db((d) => { const r = d.read<RequirementRecord>("requirements", w.requirementId)!;
    d.update("requirements", w.requirementId, r.version, { ...r.data, saved: { commit: "c".repeat(40), hash: "d".repeat(64) } }); });
  const before = w.requirement();
  const error = await service.authorizeImplement({ ...input, version: before.version }).catch((caught) => caught);
  expect(error).toMatchObject({ code: "draft_unapproved_changes" });
  expect(adviceOf(error)!.why).toContain("草稿有未批准的修改");
  expect(w.requirement()).toEqual(before);
});

test("服务补授权时需求已关闭被拒，错误码lifecycle_denied", async () => {
  const w = await approvedWithoutImplement();
  const { service, input } = await serviceFor(w);
  const store = await RequirementStateStore.open({ ...w.options, authorize: () => true, authorizeManifest: () => true });
  const intent = { operationId: uuidv7(), reason: "cancelled" as const, receiptId: uuidv7() };
  const closing = store.beginClose({ requirementId: w.requirementId, version: input.version, intent });
  const closed = store.finishClose({ requirementId: w.requirementId, version: closing.version, operationId: intent.operationId });
  const before = w.requirement(), events = store.events(w.requirementId);
  const error = await service.authorizeImplement({ ...input, version: closed.version }).catch((caught) => caught);
  expect(error).toMatchObject({ code: "lifecycle_denied" });
  expect(w.requirement()).toEqual(before);
  expect(store.events(w.requirementId)).toEqual(events);
});

test("服务补授权时当前清单已有实施被拒，错误码implement_already_authorized", async () => {
  const w = await approvedWithoutImplement("implemented");
  const service = await RequirementService.open({ ...w.options, authorize: () => true, authorizeManifest: () => true });
  const before = w.requirement();
  const error = await service.authorizeImplement({ requirementId: w.requirementId, version: before.version,
    receiptId: before.data.approvalReceiptId!, manifest: w.oldRef }).catch((caught) => caught);
  expect(error).toMatchObject({ code: "implement_already_authorized" });
});

test("补授权之后用户只批准新版本：新清单没有实施，implementAuthorized返回false", async () => {
  const w = await approvedWithoutImplement();
  const { service, input } = await serviceFor(w);
  await service.authorizeImplement(input);
  expect(implementAuthorized(w.options, w.requirement())).toBe(true);
  const saved = await service.updateDraft({ requirementId: w.requirementId, operationId: uuidv7(), version: w.requirement().version, title: w.title, body: "# A {#A}\n手机号登录，加验证码\n" });
  const confirm = await manifestConfirmInput(w.options, { requirementId: w.requirementId, savedOperationId: saved.operationId, implement: false });
  await service.confirmUpdate(confirm);
  const row = w.requirement();
  expect(row.data.approvalManifest!.reference).toEqual(confirm.manifest);
  expect(implementAuthorized(w.options, row)).toBe(false);
});
