import { afterEach, expect, test, vi } from "vitest";
import { uuidv7 } from "../runtime/database.ts";
import { PM_INTAKE_NAMESPACES } from "../runtime/pm-intake-store.ts";
import { createPmIntakeFixture } from "./helpers/pm-intake-fixture.ts";
import type { PmIntakeFixture } from "./helpers/pm-intake-fixture.ts";
import { counts, requestInput, reviewRecord } from "./helpers/pm-intake-store-test-support.ts";

vi.setConfig({ testTimeout: 20_000 });
const clean: PmIntakeFixture[] = [];
afterEach(async () => { for (const fixture of clean.splice(0).reverse()) await fixture.cleanup(); });
async function world(): Promise<PmIntakeFixture> { const fixture = await createPmIntakeFixture(); clean.push(fixture); return fixture; }

test.each(["requests", "heads", "operations", "reviews", "directories"] as const)("原结果proof绑定%s实际行，字节恢复但版本已变也拒绝", async (kind) => {
  const fixture = await world(), captured = fixture.captureCurrent();
  const request = fixture.intakeStore.commitRequest(fixture.intakeStore.prepareRequest(requestInput(fixture, captured.proof)), () => {});
  const operationId = fixture.operationId();
  const review = fixture.intakeStore.commitReview(fixture.intakeStore.prepareReview({ operationId, proof: captured.proof,
    record: reviewRecord(fixture, captured.binding, request.record.requestId) }), () => {});
  const ns = PM_INTAKE_NAMESPACES[kind];
  const key = kind === "requests" ? request.record.requestId : kind === "heads" ? fixture.requirementId : kind === "operations" ? operationId
    : kind === "reviews" ? review.record.reviewId : request.record.sourceDirectoryHash;
  const before = fixture.db((db) => db.read<Record<string, unknown>>(ns, key))!;
  const changed = { ...before.data, ...(kind === "requests" ? { submissionRef: "pm/changed" } : kind === "heads" ? { updatedAt: Number(before.data.updatedAt) + 1 }
    : kind === "operations" ? { resultId: uuidv7() } : kind === "reviews" ? { shortIssues: ["changed"] } : { createdAt: Number(before.data.createdAt) + 1 }) };
  fixture.db((db) => db.update(ns, key, before.version, changed));
  expect(() => fixture.intakeStore.assertReturnCurrent(review.currentProof, () => {})).toThrow();
  fixture.db((db) => db.update(ns, key, db.read(ns, key)!.version, before.data));
  expect(() => fixture.intakeStore.assertReturnCurrent(review.currentProof, () => {})).toThrow();
});

test.each(["head", "directory", "operation"] as const)("准备后%s行变化，review写事务拒绝且零新增", async (target) => {
  const fixture = await world(), captured = fixture.captureCurrent(), requestOperation = fixture.operationId();
  const request = fixture.intakeStore.commitRequest(fixture.intakeStore.prepareRequest(requestInput(fixture, captured.proof, requestOperation)), () => {});
  const prepared = fixture.intakeStore.prepareReview({ operationId: fixture.operationId(), proof: request.currentProof,
    record: reviewRecord(fixture, captured.binding, request.record.requestId) });
  const before = counts(fixture);
  expect(() => fixture.intakeStore.commitReview(prepared, () => {
    const ns = target === "head" ? PM_INTAKE_NAMESPACES.heads : target === "directory" ? PM_INTAKE_NAMESPACES.directories : PM_INTAKE_NAMESPACES.operations;
    const key = target === "head" ? fixture.requirementId : target === "directory" ? request.record.sourceDirectoryHash : requestOperation;
    fixture.db((db) => { const row = db.read<Record<string, unknown>>(ns, key)!;
      db.update(ns, key, row.version, target === "head" ? { ...row.data, updatedAt: Number(row.data.updatedAt) + 1 }
        : target === "directory" ? { ...row.data, unexpectedBody: "test-only-forbidden-field" } : { ...row.data, operationId: uuidv7() }); });
  })).toThrow();
  expect(counts(fixture)).toEqual(before);
});


test("私有proof/prepared的JSON副本不能认证，Promise和thenable回调均拒绝且无残留", async () => {
  const fixture = await world(), captured = fixture.captureCurrent();
  expect(() => fixture.intakeStore.assertReturnCurrent(structuredClone(captured.proof), () => {})).toThrow(/untrusted_proof/);
  const prepared = fixture.intakeStore.prepareRequest(requestInput(fixture, captured.proof));
  expect(() => fixture.intakeStore.commitRequest(structuredClone(prepared), () => {})).toThrow(/untrusted_prepared/);
  expect(() => fixture.intakeStore.commitRequest(prepared, (() => Promise.resolve()) as unknown as () => void)).toThrow(/async_callback/);
  const second = fixture.intakeStore.prepareRequest(requestInput(fixture, captured.proof));
  expect(() => fixture.intakeStore.commitRequest(second, (() => ({ then() {} })) as unknown as () => void)).toThrow(/async_callback/);
  await Promise.resolve();
  expect(counts(fixture)[PM_INTAKE_NAMESPACES.requests]).toBe(0);
});

