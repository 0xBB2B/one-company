import { expect, test } from "vitest";
import { uuidv7 } from "../src/core/storage/database.ts";
import { partitionPrdDocument } from "../src/modules/requirement/prd-view.ts";
import { approvalManifestDigest, approvalManifestReference, checkApprovalManifest } from "../src/modules/requirement/approval-manifest.ts";
import { ApprovalManifestStore, summarizeApprovalManifest } from "../src/modules/requirement/approval-manifest-store.ts";

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
