import { afterEach, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { repositoryDatabase, uuidv7, withDatabase } from "../src/core/storage/database.ts";
import type { LocalDatabase } from "../src/core/storage/database.ts";
import { repositoryIdentity } from "../src/core/storage/identity.ts";
import { RequirementService } from "../src/modules/requirement/requirement-service.ts";
import type { RequirementRecord } from "../src/modules/requirement/requirement-contracts.ts";
import type { RequirementDocSection } from "../src/modules/requirement/requirement-doc.ts";
import { continuityInputProofIn } from "../src/modules/requirement/interaction-continuity.ts";
import { createRepoFixture, removeRepoFixture } from "./helpers/repo-fixture.ts";
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
async function approvedWithoutImplement(kind: Kind = "plain") {
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
  return { options, requirementId: created.requirementId, db, requirement, row, oldRef, base, receiptId, admission, proof, storeWith, saveDecision, supplement, registered, reader };
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
