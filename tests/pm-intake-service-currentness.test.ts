import { afterEach, expect, test, vi } from "vitest";
import { uuidv7 } from "../runtime/database.ts";
import { approvalManifestDigest, checkApprovalManifest } from "../runtime/approval-manifest.ts";
import { partitionProdDocument } from "../runtime/prod-view.ts";
import { decisionDigest } from "../runtime/short-decision-format.ts";
import { PM_INTAKE_NAMESPACES } from "../runtime/pm-intake-store.ts";
import { createPmIntakeFixture } from "./helpers/pm-intake-fixture.ts";
import type { PmIntakeFixture } from "./helpers/pm-intake-fixture.ts";
import { persisted } from "./helpers/pm-intake-service-test-support.ts";

vi.setConfig({ testTimeout: 20_000 });
const clean: PmIntakeFixture[] = [];
afterEach(async () => { for (const fixture of clean.splice(0).reverse()) await fixture.cleanup(); });
async function world(): Promise<PmIntakeFixture> {
  const fixture = await createPmIntakeFixture();
  clean.push(fixture);
  return fixture;
}

test("真实连续决定保留A、修改B后，接手覆盖retained实际决定；漏引用或实际行变化拒绝", async () => {
  const fixture = await createPmIntakeFixture({ retained: true }); clean.push(fixture);
  const retained = fixture.manifest.retainedSources?.find((source) => source.unitId === "goal.login");
  expect(retained).toBeDefined();
  expect(fixture.manifest.units.find((unit) => unit.id === "goal.login")!.decisionIds).toContain(retained!.decision.id);
  const view = await fixture.intake.openRequest(fixture.call, fixture.operationId());
  expect(view.sourceDirectory.decisionIds).toContain(retained!.decision.id);
  expect(fixture.manifest.actions[0]!.goalIds).toEqual(["scenario.failure"]);
  expect(() => fixture.intake.assertResultCurrent(fixture.call, view)).not.toThrow();
  const approved = await fixture.service.read({ requirementId: fixture.requirementId, source: "approved" });
  const invalid = structuredClone(fixture.manifest);
  invalid.units.find((unit) => unit.id === "goal.login")!.decisionIds = [...invalid.units.find((unit) => unit.id === "scenario.failure")!.decisionIds];
  invalid.manifestHash = approvalManifestDigest(invalid);
  expect(() => checkApprovalManifest(invalid, { requirementId: fixture.requirementId, candidate: fixture.manifest.candidate,
    partition: partitionProdDocument(fixture.requirementId, approved.title, approved.body) })).toThrow();
  fixture.db((db) => { const row = db.read("short_decisions", retained!.decision.id)!;
    db.update("short_decisions", retained!.decision.id, row.version, row.data); });
  expect(() => fixture.intake.assertResultCurrent(fixture.call, view)).toThrow();
});

test("原对象交付同步核验；克隆、跨service、换call及旧head不得重新授权", async () => {
  const fixture = await world();
  const view = await fixture.intake.openRequest(fixture.call, fixture.operationId());
  expect(Object.isFrozen(view)).toBe(true); expect(Object.isFrozen(view.understanding.binding)).toBe(true);
  expect(() => fixture.intake.assertResultCurrent(fixture.call, view)).not.toThrow();
  expect(() => fixture.intake.assertResultCurrent(fixture.call, structuredClone(view))).toThrow(/unproven_result/);
  expect(() => fixture.makeIntake().assertResultCurrent(fixture.call, view)).toThrow(/unproven_result/);
  expect(() => fixture.intake.assertResultCurrent(fixture.newCall(), view)).toThrow(/unproven_result/);
  expect(() => fixture.intake.assertResultCurrent(fixture.call, view)).not.toThrow();
  const next = await fixture.intake.openRequest(fixture.call, fixture.operationId());
  expect(() => fixture.intake.assertResultCurrent(fixture.call, view)).toThrow();
  await expect(fixture.intake.readRequest(fixture.call, view.requestId)).rejects.toThrow(/request_not_current/);
  expect(() => fixture.intake.assertResultCurrent(fixture.call, next)).not.toThrow();
});

test("同binding提交内容往返仍撤销旧provider handle，取消后拒绝原结果而保留历史", async () => {
  const fixture = await world();
  const controller = new AbortController();
  const view = await fixture.intake.openRequest(fixture.call, fixture.operationId(), controller.signal);
  const query = { binding: view.binding, sourceDirectoryHash: view.sourceDirectoryHash, maxBytes: 49_152, signal: controller.signal };
  fixture.submissionProvider.mutate = (understanding) => { understanding.goals[0]!.text += "变更"; };
  expect((await fixture.submissionProvider.loadCurrent(query))!.submissionHash).not.toBe(view.submissionHash);
  fixture.submissionProvider.mutate = undefined;
  expect((await fixture.submissionProvider.loadCurrent(query))!.submissionHash).toBe(view.submissionHash);
  expect(() => fixture.intake.assertResultCurrent(fixture.call, view)).toThrow(/submission_changed/);
  const fresh = await fixture.intake.readRequest(fixture.call, view.requestId, controller.signal);
  expect(() => fixture.intake.assertResultCurrent(fixture.call, fresh)).not.toThrow();
  controller.abort();
  expect(() => fixture.intake.assertResultCurrent(fixture.call, fresh)).toThrow(/operation_cancelled/);
  expect((persisted(fixture)[PM_INTAKE_NAMESPACES.requests] ?? []).length).toBe(1);
});

test("幂等指针错配不能组合另一个请求hash与当前理解", async () => {
  const fixture = await world(), operationId = fixture.operationId();
  const first = await fixture.intake.openRequest(fixture.call, operationId);
  fixture.submissionProvider.mutate = (understanding) => { understanding.goals[0]!.text += "另一份理解"; };
  const second = await fixture.intake.openRequest(fixture.call, fixture.operationId());
  expect(first.submissionHash).not.toBe(second.submissionHash);
  fixture.db((db) => { const row = db.read<Record<string, unknown>>(PM_INTAKE_NAMESPACES.operations, operationId)!;
    db.update(PM_INTAKE_NAMESPACES.operations, operationId, row.version, { ...row.data, resultId: second.requestId }); });
  fixture.submissionProvider.mutate = undefined;
  const before = persisted(fixture);
  await expect(fixture.intake.openRequest(fixture.call, operationId)).rejects.toThrow(/operation_conflict/);
  expect(persisted(fixture)).toEqual(before);
});

test("另一需求的隔离intake元数据变化不使当前原对象失效", async () => {
  const fixture = await world(), view = await fixture.intake.openRequest(fixture.call, fixture.operationId());
  const otherRequirement = uuidv7(), requestId = uuidv7(), operationId = uuidv7();
  const binding = { ...view.binding, requirementId: otherRequirement };
  const sourceDirectoryHash = decisionDigest({ format: "pm-intake-source-directory/v1", binding, sourceDirectory: view.sourceDirectory });
  const record = { format: "pm-intake-request/v1", requestId, binding, sourceDirectoryHash, submissionRef: "pm/other",
    submissionHash: "f".repeat(64), creator: { windowId: "other", sessionId: "other", toolCallId: "other" }, createdAt: view.createdAt };
  fixture.db((db) => db.transaction(() => {
    db.create(PM_INTAKE_NAMESPACES.directories, sourceDirectoryHash, { format: "pm-intake-directory/v1", binding, sourceDirectory: view.sourceDirectory, sourceDirectoryHash, createdAt: view.createdAt });
    db.create(PM_INTAKE_NAMESPACES.requests, requestId, record, requestId);
    db.create(PM_INTAKE_NAMESPACES.operations, operationId, { format: "pm-intake-operation/v1", operationId, operation: "request", resultId: requestId,
      intentHash: decisionDigest({ operation: "request", binding, submissionRef: record.submissionRef, submissionHash: record.submissionHash, sourceDirectoryHash }), createdAt: view.createdAt }, operationId);
    db.create(PM_INTAKE_NAMESPACES.heads, otherRequirement, { format: "pm-intake-head/v1", requirementId: otherRequirement, binding, requestId, reviewId: null, updatedAt: view.createdAt });
  }));
  expect(() => fixture.intake.assertResultCurrent(fixture.call, view)).not.toThrow();
  fixture.db((db) => { const row = db.read<Record<string, unknown>>(PM_INTAKE_NAMESPACES.heads, otherRequirement)!;
    db.update(PM_INTAKE_NAMESPACES.heads, otherRequirement, row.version, { ...row.data, updatedAt: view.createdAt + 1 }); });
  expect(() => fixture.intake.assertResultCurrent(fixture.call, view)).not.toThrow();
});

test("PM 租约续期只改到期时间与记录版本，不使已打开的接手核对失效，核对结论照常登记", async () => {
  const fixture = await world(), view = await fixture.intake.openRequest(fixture.call, fixture.operationId());
  const before = fixture.state.pmOwner(fixture.requirementId)!.lease!.expiresAt;
  fixture.advanceNow(10_000);
  await fixture.state.renewPm(fixture.lease);
  expect(fixture.state.pmOwner(fixture.requirementId)!.lease!.expiresAt).toBeGreaterThan(before);
  expect(() => fixture.intake.assertResultCurrent(fixture.call, view)).not.toThrow();
  await expect(fixture.intake.recordReview(fixture.call, view.requestId, fixture.operationId(), { result: "passed", shortIssues: [] })).resolves.toBeDefined();
});

test.each(["revoke", "close", "release"] as const)("%s后拒绝原对象交付，已登记历史不删除", async (mode) => {
  const fixture = await world(), view = await fixture.intake.openRequest(fixture.call, fixture.operationId());
  const before = persisted(fixture);
  if (mode === "revoke") fixture.host.revoke();
  else if (mode === "release") fixture.state.releasePm(fixture.lease);
  else await fixture.state.beginClose({ requirementId: fixture.requirementId, version: fixture.state.read(fixture.requirementId).version,
    intent: { operationId: uuidv7(), reason: "cancelled", receiptId: uuidv7() } });
  expect(() => fixture.intake.assertResultCurrent(fixture.call, view)).toThrow();
  expect(persisted(fixture)).toEqual(before);
});

test("最后provider回调改变request实际行，read proof拒绝交付旧字段", async () => {
  const fixture = await world();
  const request = await fixture.intake.openRequest(fixture.call, fixture.operationId());
  let assertions = 0;
  fixture.sourceProvider.assertHook = () => {
    if (++assertions !== 4) return;
    fixture.db((db) => { const row = db.read<Record<string, unknown>>(PM_INTAKE_NAMESPACES.requests, request.requestId)!;
      db.update(PM_INTAKE_NAMESPACES.requests, request.requestId, row.version, { ...row.data, submissionRef: "pm/changed" }); });
  };
  await expect(fixture.intake.readRequest(fixture.call, request.requestId)).rejects.toThrow();
  expect(assertions).toBe(4);
});

test("同operationId同业务意图可由新toolCallId幂等重试，异意图冲突", async () => {
  const fixture = await world();
  const operationId = fixture.operationId();
  const first = await fixture.intake.openRequest(fixture.call, operationId);
  const second = await fixture.intake.openRequest(fixture.newCall(), operationId);
  expect(second.requestId).toBe(first.requestId);
  fixture.submissionProvider.mutate = (value) => { value.goals[0]!.text = "不同业务理解"; };
  await expect(fixture.intake.openRequest(fixture.newCall(), operationId)).rejects.toMatchObject({ code: "operation_conflict" });
});

test("review幂等意图不含随机reviewId/toolCallId，异结果仍冲突且终态不可覆盖", async () => {
  const fixture = await world();
  const request = await fixture.intake.openRequest(fixture.call, fixture.operationId());
  const operationId = fixture.operationId();
  const first = await fixture.intake.recordReview(fixture.newCall(), request.requestId, operationId, { result: "passed", shortIssues: [] });
  const retry = await fixture.intake.recordReview(fixture.newCall(), request.requestId, operationId, { result: "passed", shortIssues: [] });
  expect(retry.record.reviewId).toBe(first.record.reviewId);
  expect(retry.record.reviewer).toEqual(first.record.reviewer);
  await expect(fixture.intake.recordReview(fixture.newCall(), request.requestId, operationId,
    { result: "pm_correction_required", shortIssues: ["理解错误"] })).rejects.toMatchObject({ code: "operation_conflict" });
  await expect(fixture.intake.recordReview(fixture.newCall(), request.requestId, fixture.operationId(),
    { result: "passed", shortIssues: [] })).rejects.toMatchObject({ code: "request_not_current" });
  expect(persisted(fixture)[PM_INTAKE_NAMESPACES.reviews]).toHaveLength(1);
});
