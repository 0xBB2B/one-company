import { afterEach, expect, test, vi } from "vitest";
import { LocalDatabase, uuidv7 } from "../runtime/database.ts";
import { PmIntakeStore, PM_INTAKE_NAMESPACES } from "../runtime/pm-intake-store.ts";
import type { IntakeCurrentProof } from "../runtime/pm-intake-store.ts";
import type { IntakeBinding, IntakeReviewRecord } from "../runtime/pm-intake-contracts.ts";
import { createPmIntakeFixture } from "./helpers/pm-intake-fixture.ts";
import type { PmIntakeFixture } from "./helpers/pm-intake-fixture.ts";

vi.setConfig({ testTimeout: 20_000 });
const clean: PmIntakeFixture[] = [];
afterEach(async () => { for (const fixture of clean.splice(0).reverse()) await fixture.cleanup(); });
async function world(): Promise<PmIntakeFixture> { const fixture = await createPmIntakeFixture(); clean.push(fixture); return fixture; }
const hash = (value: string) => value.repeat(64);

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

function requestInput(fixture: PmIntakeFixture, proof: IntakeCurrentProof, operationId = fixture.operationId(), patch: Record<string, unknown> = {}) {
  return { operationId, proof, submissionRef: "pm/submission/current", submissionHash: hash("a"),
    creator: { windowId: fixture.identity.windowId, sessionId: fixture.identity.sessionId, toolCallId: fixture.operationId() }, ...patch };
}

function reviewRecord(fixture: PmIntakeFixture, binding: IntakeBinding, requestId: string, patch: Partial<IntakeReviewRecord> = {}): IntakeReviewRecord {
  return { format: "pm-intake-review/v1", reviewId: uuidv7(), requestId, binding,
    submissionRef: "pm/submission/current", submissionHash: hash("a"),
    reviewer: { windowId: fixture.identity.windowId, sessionId: fixture.identity.sessionId, toolCallId: fixture.operationId() },
    result: "passed", sourceRefs: [{ kind: "prod-unit", id: "goal.login" }], shortIssues: [], ...patch };
}

function counts(fixture: PmIntakeFixture) {
  return fixture.db((db) => Object.fromEntries(Object.values(PM_INTAKE_NAMESPACES).map((namespace) => [namespace, db.list(namespace).length])));
}

function finalWorkPause(run: () => unknown, milliseconds: number, observed: { reads: number; paused: boolean }, cloneTail = false): unknown {
  const read = LocalDatabase.prototype.read, list = LocalDatabase.prototype.list, copy = globalThis.structuredClone;
  const pause = () => {
    if (observed.reads >= 2 && !observed.paused) {
      observed.paused = true;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
    }
  };
  const readSpy = vi.spyOn(LocalDatabase.prototype, "read").mockImplementation(function (namespace, key) {
    const result = Reflect.apply(read, this, [namespace, key]);
    if (namespace === "pm_ownership") observed.reads++;
    return result;
  });
  const listSpy = vi.spyOn(LocalDatabase.prototype, "list").mockImplementation(function (namespace) {
    const result = Reflect.apply(list, this, [namespace]);
    if (!cloneTail && namespace === "interaction_questions_v1") pause();
    return result;
  });
  const cloneSpy = vi.spyOn(globalThis, "structuredClone").mockImplementation((value, options) => {
    const result = Reflect.apply(copy, globalThis, [value, options]);
    if (cloneTail && value && typeof value === "object" && "selector" in value && "rows" in value) pause();
    return result;
  });
  try { return run(); } finally { cloneSpy.mockRestore(); listSpy.mockRestore(); readSpy.mockRestore(); }
}

for (const mode of ["request", "review", "request-retry", "review-retry", "read", "proof", "view", "clone-tail"] as const) {
  test(`最后DB或复制工作跨租约期限时${mode}拒绝，新写回滚、幂等零写`, async () => {
    const fixture = await world(), captured = fixture.captureCurrent();
    const store = fixture.intakeStore;
    const requestPrepared = store.prepareRequest(requestInput(fixture, captured.proof));
    let run: () => unknown;
    if (mode === "request" || mode === "clone-tail") run = () => store.commitRequest(requestPrepared, () => {});
    else if (mode === "view") {
      const view = await fixture.intake.openRequest(fixture.call, fixture.operationId());
      run = () => fixture.intake.assertResultCurrent(fixture.call, view);
    } else {
      const request = store.commitRequest(requestPrepared, () => {});
      if (mode === "request-retry") run = () => store.commitRequest(requestPrepared, () => {});
      else if (mode === "read") run = () => store.readRequest(request.record.requestId, captured.proof);
      else if (mode === "proof") run = () => store.assertReturnCurrent(request.currentProof, () => {});
      else {
        const prepared = store.prepareReview({ operationId: fixture.operationId(), proof: captured.proof,
          record: reviewRecord(fixture, captured.binding, request.record.requestId) });
        if (mode === "review-retry") store.commitReview(prepared, () => {});
        run = () => store.commitReview(prepared, () => {});
      }
    }
    const before = fixture.db((db) => Object.fromEntries(Object.values(PM_INTAKE_NAMESPACES).map((ns) => [ns, db.list(ns)])));
    fixture.setNow(fixture.lease.expiresAt - 150);
    const observed = { reads: 0, paused: false };
    expect(() => finalWorkPause(run, 230, observed, mode === "clone-tail")).toThrow(/stale_pm_lease/);
    expect(observed.paused).toBe(true);
    expect(fixture.db((db) => Object.fromEntries(Object.values(PM_INTAKE_NAMESPACES).map((ns) => [ns, db.list(ns)])))).toEqual(before);
  });
}

test.each([false, true])("默认真实时钟包含最后DB工作耗时；充足租约=%s", async (sufficient) => {
  const fixture = await world();
  const expiresAt = Date.now() + (sufficient ? 3000 : 400);
  fixture.db((db) => { const row = db.read<{ lease: Record<string, unknown> }>("pm_ownership", fixture.requirementId)!;
    db.update("pm_ownership", fixture.requirementId, row.version, { ...row.data, lease: { ...row.data.lease, expiresAt } }); });
  const store = new PmIntakeStore({ dataRoot: fixture.dataRoot, repoId: fixture.repoId });
  const captured = store.captureCurrent(fixture.basis, fixture.sourceDirectory);
  const prepared = store.prepareRequest(requestInput(fixture, captured.proof));
  const observed = { reads: 0, paused: false };
  const run = () => finalWorkPause(() => store.commitRequest(prepared, () => {}), sufficient ? 230 : 650, observed);
  if (sufficient) { expect(run).not.toThrow(); expect(counts(fixture)[PM_INTAKE_NAMESPACES.requests]).toBe(1); }
  else { expect(run).toThrow(/stale_pm_lease/); expect(Date.now()).toBeGreaterThanOrEqual(expiresAt); expect(counts(fixture)[PM_INTAKE_NAMESPACES.requests]).toBe(0); }
  expect(observed.paused).toBe(true);
});

test.each([123, true, ["reference"], null, "reference\n"])("request字符串元数据不接受隐式转换：%j", async (bad) => {
  const fixture = await world(), captured = fixture.captureCurrent();
  const valid = requestInput(fixture, captured.proof);
  expect(() => fixture.intakeStore.prepareRequest({ ...valid, submissionRef: bad } as never)).toThrow();
  for (const key of ["windowId", "sessionId", "toolCallId"] as const) {
    expect(() => fixture.intakeStore.prepareRequest({ ...valid, creator: { ...valid.creator, [key]: bad } } as never)).toThrow();
  }
  expect(counts(fixture)[PM_INTAKE_NAMESPACES.requests]).toBe(0);
  expect(counts(fixture)[PM_INTAKE_NAMESPACES.operations]).toBe(0);
});

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

test("capture逐字段绑定真实批准、工作区、epoch和PM身份，任一基线字段变化都拒绝", async () => {
  const fixture = await world();
  const captured = fixture.captureCurrent();
  expect(captured.binding).toMatchObject(fixture.basis);
  expect(captured.binding.approvalScopeVersion).toMatch(/^intake-approval-scope\/v1:[0-9a-f]{64}$/);
  expect(captured.binding.actionScopeVersion).toMatch(/^intake-action-scope\/v1:[0-9a-f]{64}$/);
  const mutations: Array<[keyof typeof fixture.basis, unknown]> = [
    ["repoId", hash("9")], ["requirementId", uuidv7()], ["approvedProdCommit", "9".repeat(40)],
    ["approvedRevision", fixture.basis.approvedRevision + 1], ["approvedProdHash", hash("9")],
    ["approvalManifestHash", hash("9")], ["workspaceId", hash("9")], ["workspaceRef", "refs/heads/other"],
    ["epoch", fixture.basis.epoch + 1], ["pmRunId", uuidv7()], ["pmFence", fixture.basis.pmFence + 1],
    ["contextGeneration", fixture.basis.contextGeneration + 1],
  ];
  for (const [field, value] of mutations) {
    const basis = structuredClone(fixture.basis) as Record<string, unknown>; basis[field] = value;
    expect(() => fixture.intakeStore.captureCurrent(basis, fixture.sourceDirectory), field).toThrow();
  }
});

test("请求原子落库、相同目录不同创建时间可复用，且不写理解正文或执行状态", async () => {
  const fixture = await world(), beforeRequirement = fixture.state.read(fixture.requirementId);
  const beforeOwner = fixture.db((db) => db.read("pm_ownership", fixture.requirementId));
  const first = fixture.captureCurrent();
  const stored1 = fixture.intakeStore.commitRequest(fixture.intakeStore.prepareRequest(requestInput(fixture, first.proof)), () => {});
  fixture.advanceNow(10);
  const second = fixture.captureCurrent();
  const stored2 = fixture.intakeStore.commitRequest(fixture.intakeStore.prepareRequest(requestInput(fixture, second.proof)), () => {});
  expect(stored2.record.requestId).not.toBe(stored1.record.requestId);
  expect(counts(fixture)).toMatchObject({ [PM_INTAKE_NAMESPACES.requests]: 2, [PM_INTAKE_NAMESPACES.directories]: 1,
    [PM_INTAKE_NAMESPACES.operations]: 2, [PM_INTAKE_NAMESPACES.heads]: 1 });
  const persisted = fixture.db((db) => Object.values(PM_INTAKE_NAMESPACES).flatMap((namespace) => db.list(namespace).map((row) => row.data)));
  expect(JSON.stringify(persisted)).not.toMatch(/understanding|输入正确验证码|错误验证码显示失败|prodBody|diff|transcript/);
  expect(fixture.state.read(fixture.requirementId)).toEqual(beforeRequirement);
  expect(fixture.db((db) => db.read("pm_ownership", fixture.requirementId))).toEqual(beforeOwner);
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

test("租约在最终回调或注入时钟自身采样期间到期时拒绝，不留下部分记录", async () => {
  const callbackFixture = await world(), captured = callbackFixture.captureCurrent();
  const prepared = callbackFixture.intakeStore.prepareRequest(requestInput(callbackFixture, captured.proof));
  callbackFixture.setNow(callbackFixture.lease.expiresAt - 1);
  expect(() => callbackFixture.intakeStore.commitRequest(prepared, () => callbackFixture.advanceNow(2))).toThrow(/stale_pm_lease/);
  expect(counts(callbackFixture)[PM_INTAKE_NAMESPACES.requests]).toBe(0);

  const clockFixture = await world();
  let clock = clockFixture.lease.expiresAt - 10, tick = false;
  const store = new PmIntakeStore({ dataRoot: clockFixture.dataRoot, repoId: clockFixture.repoId,
    now: () => { const value = clock; if (tick) clock += 20; return value; } });
  const current = store.captureCurrent(clockFixture.basis, clockFixture.sourceDirectory);
  const clockPrepared = store.prepareRequest(requestInput(clockFixture, current.proof));
  tick = true;
  expect(() => store.commitRequest(clockPrepared, () => {})).toThrow(/stale_pm_lease/);
  expect(counts(clockFixture)[PM_INTAKE_NAMESPACES.requests]).toBe(0);
});

test("第二次now阻塞且返回旧值时，实际耗时仍计入租约预算并拒绝写入", async () => {
  const fixture = await world();
  let armed = false, calls = 0;
  const base = fixture.lease.expiresAt - 150;
  const store = new PmIntakeStore({ dataRoot: fixture.dataRoot, repoId: fixture.repoId,
    now: () => { if (armed && ++calls === 2) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 230); return base; } });
  const captured = store.captureCurrent(fixture.basis, fixture.sourceDirectory);
  const prepared = store.prepareRequest(requestInput(fixture, captured.proof));
  armed = true;
  expect(() => store.commitRequest(prepared, () => {})).toThrow(/stale_pm_lease/);
  expect(calls).toBe(2);
  expect(counts(fixture)[PM_INTAKE_NAMESPACES.requests]).toBe(0);
  expect(counts(fixture)[PM_INTAKE_NAMESPACES.operations]).toBe(0);
});

test.each(["request", "review"] as const)("%s写事务前now撤销Host时零新增，不以事后拒绝掩盖落库", async (mode) => {
  const fixture = await world();
  const request = mode === "review" ? await fixture.intake.openRequest(fixture.call, fixture.operationId()) : undefined;
  const before = counts(fixture);
  let armed = false, revoked = false;
  const base = Date.now();
  class ObservedStore extends PmIntakeStore {
    override commitRequest(...args: Parameters<PmIntakeStore["commitRequest"]>) {
      if (mode === "request") armed = true;
      return super.commitRequest(...args);
    }
    override commitReview(...args: Parameters<PmIntakeStore["commitReview"]>) {
      if (mode === "review") armed = true;
      return super.commitReview(...args);
    }
  }
  const store = new ObservedStore({ dataRoot: fixture.dataRoot, repoId: fixture.repoId,
    now: () => { if (armed && !revoked) { revoked = true; fixture.host.revoke(); } return base; } });
  const intake = fixture.makeIntake({ store });
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
