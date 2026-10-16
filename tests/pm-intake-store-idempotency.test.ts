import { afterEach, expect, test, vi } from "vitest";
import { PmIntakeStore, PM_INTAKE_NAMESPACES } from "../src/modules/pm/pm-intake-store.ts";
import { createPmIntakeFixture } from "./helpers/pm-intake-fixture.ts";
import type { PmIntakeFixture } from "./helpers/pm-intake-fixture.ts";
import { counts, hash, requestInput, reviewRecord } from "./helpers/pm-intake-store-test-support.ts";

vi.setConfig({ testTimeout: 20_000 });
const clean: PmIntakeFixture[] = [];
afterEach(async () => { for (const fixture of clean.splice(0).reverse()) await fixture.cleanup(); });
async function world(): Promise<PmIntakeFixture> { const fixture = await createPmIntakeFixture(); clean.push(fixture); return fixture; }

test.each(["request", "review"] as const)("两个%s prepared的等价幂等只允许单次准确写集，结果签发新proof且零重写", async (mode) => {
  const fixture = await world(), captured = fixture.captureCurrent(), operationId = fixture.operationId();
  let first: ReturnType<PmIntakeStore["commitRequest"]> | ReturnType<PmIntakeStore["commitReview"]>;
  const snapshot = () => fixture.db((db) => Object.fromEntries(Object.values(PM_INTAKE_NAMESPACES).map((ns) => [ns, db.list(ns)])));
  if (mode === "request") {
    const a = fixture.intakeStore.prepareRequest(requestInput(fixture, captured.proof, operationId));
    const b = fixture.intakeStore.prepareRequest(requestInput(fixture, captured.proof, operationId));
    first = fixture.intakeStore.commitRequest(a, () => {});
    const before = snapshot();
    const replay = fixture.intakeStore.commitRequest(b, () => {});
    expect(replay.record).toEqual(first.record); expect(snapshot()).toEqual(before);
    expect(replay.currentProof).not.toBe(first.currentProof);
    expect(fixture.intakeStore.commitRequest(a, () => {}).record).toEqual(first.record); expect(snapshot()).toEqual(before);
  } else {
    const request = fixture.intakeStore.commitRequest(fixture.intakeStore.prepareRequest(requestInput(fixture, captured.proof)), () => {});
    const a = fixture.intakeStore.prepareReview({ operationId, proof: captured.proof, record: reviewRecord(fixture, captured.binding, request.record.requestId) });
    const b = fixture.intakeStore.prepareReview({ operationId, proof: captured.proof, record: reviewRecord(fixture, captured.binding, request.record.requestId) });
    first = fixture.intakeStore.commitReview(a, () => {});
    const before = snapshot();
    expect(fixture.intakeStore.commitReview(b, () => {}).record).toEqual(first.record); expect(snapshot()).toEqual(before);
    expect(fixture.intakeStore.commitReview(a, () => {}).record).toEqual(first.record); expect(snapshot()).toEqual(before);
    expect(() => fixture.intakeStore.assertReturnCurrent(request.currentProof, () => {})).toThrow();
    const fresh = fixture.intakeStore.readRequest(request.record.requestId, captured.proof);
    expect(() => fixture.intakeStore.assertReturnCurrent(fresh.currentProof, () => {})).not.toThrow();
  }
  expect(first.currentProof).not.toBe(captured.proof);
  expect(() => fixture.intakeStore.assertReturnCurrent(first.currentProof, () => {})).not.toThrow();
});

test("旧prepared不能跨过额外review或新head，fresh读取当前已review请求仍可用", async () => {
  const fixture = await world(), captured = fixture.captureCurrent();
  const prepared = fixture.intakeStore.prepareRequest(requestInput(fixture, captured.proof));
  const first = fixture.intakeStore.commitRequest(prepared, () => {});
  fixture.intakeStore.commitReview(fixture.intakeStore.prepareReview({ operationId: fixture.operationId(), proof: captured.proof,
    record: reviewRecord(fixture, captured.binding, first.record.requestId) }), () => {});
  expect(() => fixture.intakeStore.commitRequest(prepared, () => {})).toThrow();
  expect(fixture.intakeStore.readRequest(first.record.requestId, captured.proof).record).toEqual(first.record);
  fixture.intakeStore.commitRequest(fixture.intakeStore.prepareRequest(requestInput(fixture, captured.proof)), () => {});
  expect(() => fixture.intakeStore.readRequest(first.record.requestId, captured.proof)).toThrow(/request_not_current/);
  expect(() => fixture.intakeStore.commitRequest(prepared, () => {})).toThrow();
});


test("request幂等只比较业务意图，不把新toolCallId当冲突；相同键异意图拒绝", async () => {
  const fixture = await world(), captured = fixture.captureCurrent(), operationId = fixture.operationId();
  const firstPrepared = fixture.intakeStore.prepareRequest(requestInput(fixture, captured.proof, operationId));
  const retryPrepared = fixture.intakeStore.prepareRequest(requestInput(fixture, captured.proof, operationId));
  const first = fixture.intakeStore.commitRequest(firstPrepared, () => {});
  const retry = fixture.intakeStore.commitRequest(retryPrepared, () => {});
  expect(retry).toMatchObject({ idempotent: true, record: { requestId: first.record.requestId, creator: first.record.creator } });
  const conflict = fixture.intakeStore.prepareRequest(requestInput(fixture, captured.proof, operationId, { submissionHash: hash("b") }));
  expect(() => fixture.intakeStore.commitRequest(conflict, () => {})).toThrow(/operation_conflict/);
  expect(counts(fixture)[PM_INTAKE_NAMESPACES.requests]).toBe(1);
});

test("review幂等不含随机reviewId/reviewer，终态单写且异意图冲突", async () => {
  const fixture = await world(), captured = fixture.captureCurrent();
  const request = fixture.intakeStore.commitRequest(fixture.intakeStore.prepareRequest(requestInput(fixture, captured.proof)), () => {});
  const operationId = fixture.operationId();
  const firstRecord = reviewRecord(fixture, captured.binding, request.record.requestId);
  const retryRecord = reviewRecord(fixture, captured.binding, request.record.requestId);
  const first = fixture.intakeStore.commitReview(fixture.intakeStore.prepareReview({ operationId, proof: captured.proof, record: firstRecord }), () => {});
  const retry = fixture.intakeStore.commitReview(fixture.intakeStore.prepareReview({ operationId, proof: captured.proof, record: retryRecord }), () => {});
  expect(retry).toMatchObject({ idempotent: true, record: { reviewId: first.record.reviewId, reviewer: first.record.reviewer } });
  const conflictRecord = reviewRecord(fixture, captured.binding, request.record.requestId,
    { result: "pm_correction_required", shortIssues: ["理解错误"] });
  expect(() => fixture.intakeStore.commitReview(fixture.intakeStore.prepareReview({ operationId, proof: captured.proof, record: conflictRecord }), () => {}))
    .toThrow(/operation_conflict/);
  const secondOperation = fixture.intakeStore.prepareReview({ operationId: fixture.operationId(), proof: captured.proof,
    record: reviewRecord(fixture, captured.binding, request.record.requestId) });
  expect(() => fixture.intakeStore.commitReview(secondOperation, () => {})).toThrow(/request_not_current/);
  expect(counts(fixture)[PM_INTAKE_NAMESPACES.reviews]).toBe(1);
});

