import { afterEach, expect, test, vi } from "vitest";
import { uuidv7 } from "../src/core/storage/database.ts";
import { PmIntakeStore, PM_INTAKE_NAMESPACES } from "../src/modules/pm/pm-intake-store.ts";
import { createPmIntakeFixture } from "./helpers/pm-intake-fixture.ts";
import type { PmIntakeFixture } from "./helpers/pm-intake-fixture.ts";
import { counts, requestInput, reviewRecord } from "./helpers/pm-intake-store-test-support.ts";

vi.setConfig({ testTimeout: 20_000 });
const clean: PmIntakeFixture[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const fixture of clean.splice(0).reverse()) await fixture.cleanup(); });
async function world(): Promise<PmIntakeFixture> { const fixture = await createPmIntakeFixture(); clean.push(fixture); return fixture; }

function addQuestion(fixture: PmIntakeFixture, requestId = uuidv7()): string {
  const current = fixture.state.read(fixture.requirementId);
  fixture.db((db) => db.transaction(() => db.create("interaction_questions_v1", requestId, {
    format: "interaction-question/v1", requestId, repoId: fixture.repoId,
    basis: { requirementId: fixture.requirementId, version: current.version, epoch: current.data.epoch, prod: current.data.approved },
    candidate: null, proposal: { conclusion: "新增问题", scope: "当前需求", references: [], supersedes: [] },
    actions: [], createdAt: current.data.updatedAt,
  }, requestId)));
  return requestId;
}

test("最终回调后的完整inputProof捕获新增问题与决定取代，requirement version不变也回滚", async () => {
  for (const mutation of ["question", "decision"] as const) {
    const fixture = await world(), captured = fixture.captureCurrent(), version = fixture.state.read(fixture.requirementId).version;
    const prepared = fixture.intakeStore.prepareRequest(requestInput(fixture, captured.proof));
    expect(() => fixture.intakeStore.commitRequest(prepared, () => {
      if (mutation === "question") addQuestion(fixture);
      else fixture.db((db) => db.transaction(() => {
        const id = fixture.manifest.actions[0]!.decisionIds[0]!, row = db.read<Record<string, unknown>>("short_decisions", id)!;
        db.update("short_decisions", id, row.version, { ...row.data, status: "superseded", supersededBy: uuidv7() });
      }));
    })).toThrow();
    expect(fixture.state.read(fixture.requirementId).version).toBe(version);
    expect(counts(fixture)[PM_INTAKE_NAMESPACES.requests]).toBe(0);
  }
});

test("时钟前跳 1 小时后，PM 接手请求的判定与登记照常成功", async () => {
  const fixture = await world(), captured = fixture.captureCurrent();
  const prepared = fixture.intakeStore.prepareRequest(requestInput(fixture, captured.proof));
  fixture.advanceNow(3_600_000);
  expect(() => fixture.intakeStore.commitRequest(prepared, () => {})).not.toThrow();
  expect(counts(fixture)[PM_INTAKE_NAMESPACES.requests]).toBe(1);
});

test.each(["request", "review"] as const)("%s写事务前撤销Host时零新增，不以事后拒绝掩盖落库", async (mode) => {
  const fixture = await world();
  const request = mode === "review" ? await fixture.intake.openRequest(fixture.call, fixture.operationId()) : undefined;
  const before = counts(fixture);
  let revoked = false;
  const commitRequest = PmIntakeStore.prototype.commitRequest, commitReview = PmIntakeStore.prototype.commitReview;
  vi.spyOn(PmIntakeStore.prototype, "commitRequest").mockImplementation(function (this: PmIntakeStore, ...args) {
    if (mode === "request") { revoked = true; fixture.host.revoke(); }
    return commitRequest.apply(this, args);
  });
  vi.spyOn(PmIntakeStore.prototype, "commitReview").mockImplementation(function (this: PmIntakeStore, ...args) {
    if (mode === "review") { revoked = true; fixture.host.revoke(); }
    return commitReview.apply(this, args);
  });
  const intake = fixture.makeIntake();
  await expect(mode === "request" ? intake.openRequest(fixture.call, fixture.operationId())
    : intake.recordReview(fixture.call, request!.requestId, fixture.operationId(), { result: "passed", shortIssues: [] })).rejects.toThrow();
  expect(revoked).toBe(true);
  expect(counts(fixture)).toEqual(before);
});


test("review最终回调异常完整回滚；已提交事实不会被后续交付拒绝伪称回滚", async () => {
  const fixture = await world(), captured = fixture.captureCurrent();
  const request = fixture.intakeStore.commitRequest(fixture.intakeStore.prepareRequest(requestInput(fixture, captured.proof)), () => {});
  const review = fixture.intakeStore.prepareReview({ operationId: fixture.operationId(), proof: captured.proof,
    record: reviewRecord(fixture, captured.binding, request.record.requestId) });
  expect(() => fixture.intakeStore.commitReview(review, () => { throw new Error("revoked"); })).toThrow("revoked");
  expect(counts(fixture)).toMatchObject({ [PM_INTAKE_NAMESPACES.requests]: 1, [PM_INTAKE_NAMESPACES.reviews]: 0 });
  fixture.intakeStore.commitReview(review, () => {});
  fixture.host.revoke();
  expect(counts(fixture)).toMatchObject({ [PM_INTAKE_NAMESPACES.requests]: 1, [PM_INTAKE_NAMESPACES.reviews]: 1 });
});
