import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { describe, test } from "vitest";
import {
  PM_SDK_QUIESCENCE_ADAPTER_STATUS,
  createPmSdkQuiescenceState,
} from "./helpers/pm-sdk-quiescence-state.mjs";

type Factory = typeof createPmSdkQuiescenceState;
type State = ReturnType<Factory>;
type Auth = State["credentials"];
type ExecutionFact = {
  kind: "natural" | "early-exit" | "forced";
  exitCode: number | null;
  signal: string | null;
};
type ExpectedStop = { id: string; expectFailureThenRecovery: boolean };
type ExpectedCase = { id: string; stops: ExpectedStop[] };
type Limits = {
  maxEvents: number;
  maxResources: number;
  maxErrors: number;
  maxStopAttempts: number;
  maxCases: number;
  maxStops: number;
  maxWriters: number;
  maxIdentifierLength: number;
};
type Options = {
  expectedCases?: ExpectedCase[];
  expectedWriters?: string[];
  limits?: Limits;
};

const limits: Limits = Object.freeze({
  maxEvents: 160,
  maxResources: 12,
  maxErrors: 20,
  maxStopAttempts: 20,
  maxCases: 8,
  maxStops: 12,
  maxWriters: 4,
  maxIdentifierLength: 64,
});

function configuration(options: Options = {}) {
  return {
    stopDomain: "execution-tree",
    expectedCases: options.expectedCases ?? [{ id: "normal", stops: [] }],
    expectedWriters: options.expectedWriters ?? ["execution"],
    limits: options.limits ?? { ...limits },
  };
}

function fresh(options: Options = {}): { state: State; auth: Auth } {
  const state = createPmSdkQuiescenceState(configuration(options));
  const auth = state.credentials;
  state.beginRun(auth);
  return { state, auth };
}

function passCurrentCase(state: State, auth: Auth, caseId = "normal"): void {
  state.beginCase(auth, caseId);
  state.recordCaseResult(auth, {
    caseId,
    outcome: "pass",
    error: { present: false },
  });
}

function closeExecution(
  state: State,
  auth: Auth,
  fact: ExecutionFact = { kind: "natural", exitCode: 0, signal: null },
): void {
  state.beginClosing(auth, { reason: "test-finished" });
  state.recordExecutionClose(auth, fact);
  state.observeExecutionGroup(auth, { groupState: "gone" });
}

function eof(state: State, auth: Auth, sequence: number, writerId = "execution"): void {
  state.recordWriterEof(auth, { writerId, sequence, completeFrame: true });
}

function completeNoResourceRun(
  state: State,
  auth: Auth,
  options: { passCase?: boolean; executionFact?: ExecutionFact } = {},
): void {
  if (options.passCase !== false) passCurrentCase(state, auth);
  closeExecution(state, auth, options.executionFact);
  eof(state, auth, 1);
}

function assertCode(code: string): (error: unknown) => boolean {
  return (error: unknown) => error instanceof Error && error.message === code;
}

function snapshot(state: State, auth: Auth): ReturnType<State["snapshot"]> {
  return state.snapshot(auth);
}

function finishStop(
  state: State,
  auth: Auth,
  attempt: object,
  outcome: "success" | "failure",
  error: { present: false } | { present: true; value: unknown },
  caseId = "normal",
  stopId = "host",
): void {
  state.completeStop(auth, { caseId, stopId, attempt, outcome, error });
}

describe("PM SDK quiescence pure state", () => {
  test("API仅给诊断候选，owner/epoch按原引用核验且无mint/reset/force入口", () => {
    assert.equal(PM_SDK_QUIESCENCE_ADAPTER_STATUS, "not-implemented");
    const { state, auth } = fresh();
    for (const forbidden of ["mintEpoch", "reset", "forceComplete", "markStopped", "markStoppedTrue"]) {
      assert.equal(Object.hasOwn(state, forbidden), false);
    }
    assert.equal(Object.isFrozen(state), true);
    assert.equal(Object.isFrozen(auth), true);
    const before = snapshot(state, auth);
    const fakeOwner = Object.freeze(Object.create(null)) as object;
    const fakeEpoch = Object.freeze(Object.create(null)) as object;
    assert.throws(() => state.beginCase({ owner: fakeOwner, epoch: auth.epoch }, "normal"), assertCode("unknown_owner"));
    assert.throws(() => state.beginCase({ owner: auth.owner, epoch: fakeEpoch }, "normal"), assertCode("wrong_epoch"));
    assert.deepEqual(snapshot(state, auth), before);
  });

  test("reserved、bound、close分别阻塞，未知记录键和伪handle不能改合法资源", () => {
    const { state, auth } = fresh();
    state.beginCase(auth, "normal");
    const resourceKey = Object.freeze({ record: true });
    let getterReads = 0;
    const handleKey = Object.create(null) as object;
    Object.defineProperty(handleKey, "pid", {
      get() {
        getterReads += 1;
        throw new Error("handle getter must not run");
      },
    });
    state.reserveResource(auth, {
      caseId: "normal",
      resourceKey,
      kind: "execution-child",
      writerId: "execution",
      sequence: 1,
    });
    assert.equal(snapshot(state, auth).resources[0]?.state, "reserved");
    assert.throws(
      () => state.bindResource(auth, {
        resourceKey: { record: true },
        handleKey,
        pid: 101,
        writerId: "execution",
        sequence: 2,
      }),
      assertCode("unknown_resource"),
    );
    state.bindResource(auth, {
      resourceKey,
      handleKey,
      pid: 101,
      writerId: "execution",
      sequence: 2,
    });
    assert.equal(getterReads, 0);
    const fakeHandle = Object.freeze({ fake: true });
    assert.throws(
      () => state.observeResourceClose(auth, {
        resourceKey,
        handleKey: fakeHandle,
        writerId: "execution",
        sequence: 3,
      }),
      assertCode("wrong_handle_key"),
    );
    assert.equal(snapshot(state, auth).resources[0]?.state, "bound");
    state.observeResourceClose(auth, {
      resourceKey,
      handleKey,
      writerId: "execution",
      sequence: 3,
    });
    assert.equal(getterReads, 0);
    state.recordCaseResult(auth, { caseId: "normal", outcome: "pass", error: { present: false } });
    closeExecution(state, auth);
    eof(state, auth, 4);
    assert.equal(snapshot(state, auth).result.physicalEndCandidate, true);
  });

  test("writer须连续且完整EOF；缺EOF、半帧和序号缺口永久阻塞", () => {
    const missing = fresh();
    passCurrentCase(missing.state, missing.auth);
    closeExecution(missing.state, missing.auth);
    assert.equal(snapshot(missing.state, missing.auth).result.physicalEndCandidate, false);

    const partial = fresh();
    passCurrentCase(partial.state, partial.auth);
    closeExecution(partial.state, partial.auth);
    assert.throws(
      () => partial.state.recordWriterEof(partial.auth, {
        writerId: "execution",
        sequence: 1,
        completeFrame: false,
      }),
      assertCode("writer_partial_frame_preserved"),
    );
    assert.equal(snapshot(partial.state, partial.auth).writers[0]?.damaged, true);
    assert.equal(snapshot(partial.state, partial.auth).result.physicalEndCandidate, false);

    const gap = fresh();
    passCurrentCase(gap.state, gap.auth);
    closeExecution(gap.state, gap.auth);
    assert.throws(
      () => gap.state.recordWriterEof(gap.auth, {
        writerId: "execution",
        sequence: 2,
        completeFrame: true,
      }),
      assertCode("writer_sequence_gap_preserved"),
    );
    assert.equal(snapshot(gap.state, gap.auth).writers[0]?.nextSequence, 1);
    assert.equal(snapshot(gap.state, gap.auth).result.physicalEndCandidate, false);
  });

  test("closing拒绝新业务和新创建，但接受已有reservation的迟到bound/close", () => {
    const { state, auth } = fresh();
    state.beginCase(auth, "normal");
    const key = Object.freeze({ late: true });
    const handle = Object.freeze({ handle: true });
    state.reserveResource(auth, {
      caseId: "normal",
      resourceKey: key,
      kind: "execution-child",
      writerId: "execution",
      sequence: 1,
    });
    state.recordCaseResult(auth, { caseId: "normal", outcome: "pass", error: { present: false } });
    state.beginClosing(auth, { reason: "late-facts" });
    assert.throws(() => state.beginCase(auth, "normal"), assertCode("new_business_rejected"));
    const late = fresh();
    passCurrentCase(late.state, late.auth);
    late.state.beginClosing(late.auth, { reason: "late-reserve" });
    assert.throws(
      () => late.state.reserveResource(late.auth, {
        caseId: "normal",
        resourceKey: Object.freeze({ tooLate: true }),
        kind: "execution-child",
        writerId: "execution",
        sequence: 1,
      }),
      assertCode("late_reservation_timing_unknown"),
    );
    closeExecution(late.state, late.auth);
    eof(late.state, late.auth, 1);
    assert.equal(snapshot(late.state, late.auth).result.reclaimCandidate, false);
    state.bindResource(auth, {
      resourceKey: key,
      handleKey: handle,
      pid: 102,
      writerId: "execution",
      sequence: 2,
    });
    state.observeResourceClose(auth, {
      resourceKey: key,
      handleKey: handle,
      writerId: "execution",
      sequence: 3,
    });
    state.recordExecutionClose(auth, { kind: "natural", exitCode: 0, signal: null });
    state.observeExecutionGroup(auth, { groupState: "gone" });
    eof(state, auth, 4);
    assert.equal(snapshot(state, auth).result.physicalEndCandidate, true);
  });

  test("成功stop重复申请幂等返回原attempt，pending和timeout也不重复启动", () => {
    const { state, auth } = fresh({
      expectedCases: [{ id: "normal", stops: [{ id: "host", expectFailureThenRecovery: false }] }],
    });
    state.beginCase(auth, "normal");
    const first = state.requestStop(auth, { caseId: "normal", stopId: "host" });
    assert.equal(first.status, "started");
    const pending = state.requestStop(auth, { caseId: "normal", stopId: "host" });
    assert.equal(pending.status, "pending");
    assert.equal(pending.attempt, first.attempt);
    finishStop(state, auth, first.attempt, "success", { present: false });
    const completed = state.requestStop(auth, { caseId: "normal", stopId: "host" });
    assert.equal(completed.status, "completed");
    assert.equal(completed.attempt, first.attempt);
    assert.equal(snapshot(state, auth).cases[0]?.stops[0]?.attempts.length, 1);
  });

  test("非预期stop失败即使后来成功也不洗成execution或overall PASS", () => {
    const { state, auth } = fresh({
      expectedCases: [{ id: "normal", stops: [{ id: "host", expectFailureThenRecovery: false }] }],
    });
    state.beginCase(auth, "normal");
    const original = new Error("unexpected shutdown failure");
    const failed = state.requestStop(auth, { caseId: "normal", stopId: "host" });
    finishStop(state, auth, failed.attempt, "failure", { present: true, value: original });
    const recovery = state.requestStop(auth, { caseId: "normal", stopId: "host" });
    assert.notEqual(recovery.attempt, failed.attempt);
    finishStop(state, auth, recovery.attempt, "success", { present: false });
    state.recordCaseResult(auth, { caseId: "normal", outcome: "pass", error: { present: false } });
    closeExecution(state, auth);
    eof(state, auth, 1);
    let result = snapshot(state, auth).result;
    assert.equal(result.stopPass, false);
    assert.equal(result.executionPassCandidate, false);
    assert.equal(result.physicalEndCandidate, true);
    const reclaim = state.requestReclaim(auth);
    state.completeReclaim(auth, { attempt: reclaim.attempt, outcome: "removed", error: { present: false } });
    result = snapshot(state, auth).result;
    assert.equal(result.overallPass, false);
    assert.equal(state.diagnosticErrors(auth)[0]?.value, original);
  });

  test("预声明shutdown failure/recovery严格匹配且保留原错误引用", () => {
    const { state, auth } = fresh({
      expectedCases: [{ id: "fault", stops: [{ id: "host", expectFailureThenRecovery: true }] }],
    });
    state.beginCase(auth, "fault");
    const original = new Error("expected shutdown failure");
    const failed = state.requestStop(auth, { caseId: "fault", stopId: "host" });
    finishStop(state, auth, failed.attempt, "failure", { present: true, value: original }, "fault");
    const recovery = state.requestStop(auth, { caseId: "fault", stopId: "host" });
    finishStop(state, auth, recovery.attempt, "success", { present: false }, "fault");
    const idempotent = state.requestStop(auth, { caseId: "fault", stopId: "host" });
    assert.equal(idempotent.status, "completed");
    assert.equal(idempotent.attempt, recovery.attempt);
    state.recordCaseResult(auth, { caseId: "fault", outcome: "pass", error: { present: false } });
    closeExecution(state, auth);
    eof(state, auth, 1);
    assert.equal(snapshot(state, auth).result.stopPass, true);
    assert.equal(snapshot(state, auth).result.executionPassCandidate, true);
    assert.equal(snapshot(state, auth).result.overallPass, false);
    const reclaim = state.requestReclaim(auth);
    state.completeReclaim(auth, { attempt: reclaim.attempt, outcome: "removed", error: { present: false } });
    assert.equal(snapshot(state, auth).result.overallPass, true);
    assert.equal(state.diagnosticErrors(auth)[0]?.value, original);
  });

  test("stop timeout保留pending及本轮失败事实，后来成功只恢复物理候选", () => {
    const { state, auth } = fresh({
      expectedCases: [{ id: "fault", stops: [{ id: "host", expectFailureThenRecovery: true }] }],
    });
    state.beginCase(auth, "fault");
    const attempt = state.requestStop(auth, { caseId: "fault", stopId: "host" });
    state.timeoutStop(auth, { caseId: "fault", stopId: "host", attempt: attempt.attempt });
    const same = state.requestStop(auth, { caseId: "fault", stopId: "host" });
    assert.equal(same.status, "pending");
    assert.equal(same.attempt, attempt.attempt);
    finishStop(state, auth, attempt.attempt, "success", { present: false }, "fault");
    state.recordCaseResult(auth, { caseId: "fault", outcome: "pass", error: { present: false } });
    closeExecution(state, auth);
    eof(state, auth, 1);
    const result = snapshot(state, auth).result;
    assert.equal(result.stopPass, false);
    assert.equal(result.physicalEndCandidate, true);
    assert.equal(result.reclaimCandidate, true);
    assert.equal(result.integrityPass, false);
    assert.equal(result.overallPass, false);
  });

  test("detached group gone后出现alive保留协议不确定，EOF和后续gone不能放行", () => {
    const { state, auth } = fresh();
    state.beginCase(auth, "normal");
    const key = Object.freeze({ detached: true });
    const handle = Object.freeze({ detachedHandle: true });
    state.reserveResource(auth, {
      caseId: "normal",
      resourceKey: key,
      kind: "detached-group",
      writerId: "execution",
      sequence: 1,
    });
    state.bindResource(auth, {
      resourceKey: key,
      handleKey: handle,
      pid: 201,
      writerId: "execution",
      sequence: 2,
    });
    state.observeResourceClose(auth, {
      resourceKey: key,
      handleKey: handle,
      writerId: "execution",
      sequence: 3,
    });
    state.observeResourceGroup(auth, {
      resourceKey: key,
      handleKey: handle,
      groupState: "gone",
    });
    assert.throws(
      () => state.observeResourceGroup(auth, {
        resourceKey: key,
        handleKey: handle,
        groupState: "alive",
      }),
      assertCode("group_state_regression_preserved"),
    );
    state.observeResourceGroup(auth, {
      resourceKey: key,
      handleKey: handle,
      groupState: "gone",
    });
    state.recordCaseResult(auth, { caseId: "normal", outcome: "pass", error: { present: false } });
    closeExecution(state, auth);
    eof(state, auth, 4);
    const current = snapshot(state, auth);
    assert.equal(current.resources[0]?.groupIdentityUncertain, true);
    assert.equal(current.writers[0]?.damaged, false);
    assert.equal(current.protocolDamaged, true);
    assert.equal(current.result.physicalEndCandidate, false);
    assert.equal(current.result.reclaimCandidate, false);
  });

  test("execution根gone后出现unknown永久阻塞，不因后来gone复用旧结论", () => {
    const { state, auth } = fresh();
    passCurrentCase(state, auth);
    state.beginClosing(auth, { reason: "execution-regression" });
    state.recordExecutionClose(auth, { kind: "natural", exitCode: 0, signal: null });
    state.observeExecutionGroup(auth, { groupState: "gone" });
    assert.throws(
      () => state.observeExecutionGroup(auth, { groupState: "unknown" }),
      assertCode("group_state_regression_preserved"),
    );
    state.observeExecutionGroup(auth, { groupState: "gone" });
    eof(state, auth, 1);
    const current = snapshot(state, auth);
    assert.equal(current.execution.groupIdentityUncertain, true);
    assert.equal(current.result.physicalEndCandidate, false);
  });

  test("alive到unknown保留未知事实，只有后续gone才恢复候选", () => {
    const { state, auth } = fresh();
    passCurrentCase(state, auth);
    state.beginClosing(auth, { reason: "unknown-observation" });
    state.recordExecutionClose(auth, { kind: "natural", exitCode: 0, signal: null });
    state.observeExecutionGroup(auth, { groupState: "alive" });
    state.observeExecutionGroup(auth, { groupState: "unknown" });
    eof(state, auth, 1);
    assert.equal(snapshot(state, auth).execution.groupState, "unknown");
    assert.equal(snapshot(state, auth).result.physicalEndCandidate, false);
    state.observeExecutionGroup(auth, { groupState: "gone" });
    assert.equal(snapshot(state, auth).result.physicalEndCandidate, true);
  });

  test("不同reservation复用同一handle或PID会保留占位并永久阻塞", () => {
    const { state, auth } = fresh();
    state.beginCase(auth, "normal");
    const firstKey = Object.freeze({ resource: 1 });
    const secondKey = Object.freeze({ resource: 2 });
    const thirdKey = Object.freeze({ resource: 3 });
    const handle = Object.freeze({ handle: 1 });
    const otherHandle = Object.freeze({ handle: 2 });
    state.reserveResource(auth, {
      caseId: "normal", resourceKey: firstKey, kind: "execution-child", writerId: "execution", sequence: 1,
    });
    state.bindResource(auth, {
      resourceKey: firstKey, handleKey: handle, pid: 301, writerId: "execution", sequence: 2,
    });
    state.observeResourceClose(auth, {
      resourceKey: firstKey, handleKey: handle, writerId: "execution", sequence: 3,
    });
    state.reserveResource(auth, {
      caseId: "normal", resourceKey: secondKey, kind: "execution-child", writerId: "execution", sequence: 4,
    });
    assert.throws(
      () => state.bindResource(auth, {
        resourceKey: secondKey, handleKey: handle, pid: 302, writerId: "execution", sequence: 5,
      }),
      assertCode("resource_binding_collision_preserved"),
    );
    state.reserveResource(auth, {
      caseId: "normal", resourceKey: thirdKey, kind: "execution-child", writerId: "execution", sequence: 5,
    });
    assert.throws(
      () => state.bindResource(auth, {
        resourceKey: thirdKey, handleKey: otherHandle, pid: 301, writerId: "execution", sequence: 6,
      }),
      assertCode("resource_binding_collision_preserved"),
    );
    state.recordCaseResult(auth, { caseId: "normal", outcome: "pass", error: { present: false } });
    closeExecution(state, auth);
    eof(state, auth, 6);
    const current = snapshot(state, auth);
    assert.equal(current.resources.length, 3);
    assert.equal(current.resources[0]?.state, "close-observed");
    assert.equal(current.resources[1]?.state, "protocol-uncertain");
    assert.equal(current.resources[2]?.state, "protocol-uncertain");
    assert.equal(current.result.physicalEndCandidate, false);
  });

  test("execution候选与overall分开：未reclaim时不PASS，成功removed后才PASS", () => {
    const { state, auth } = fresh();
    completeNoResourceRun(state, auth);
    let result = snapshot(state, auth).result;
    assert.equal(result.executionPassCandidate, true);
    assert.equal(result.physicalEndCandidate, true);
    assert.equal(result.reclaimCandidate, true);
    assert.equal(result.reclaimSucceeded, false);
    assert.equal(result.overallPass, false);
    const request = state.requestReclaim(auth);
    state.completeReclaim(auth, { attempt: request.attempt, outcome: "removed", error: { present: false } });
    result = snapshot(state, auth).result;
    assert.equal(result.reclaimSucceeded, true);
    assert.equal(result.overallPass, true);
  });

  test("reclaim失败后重试removed仍保留首错并拒绝overall PASS", () => {
    const { state, auth } = fresh();
    completeNoResourceRun(state, auth);
    const original = new Error("rm failed");
    const first = state.requestReclaim(auth);
    state.completeReclaim(auth, {
      attempt: first.attempt,
      outcome: "failed",
      error: { present: true, value: original },
    });
    let result = snapshot(state, auth).result;
    assert.equal(result.overallPass, false);
    assert.equal(result.reclaimCandidate, true);
    const retry = state.requestReclaim(auth);
    assert.notEqual(retry.attempt, first.attempt);
    state.completeReclaim(auth, { attempt: retry.attempt, outcome: "removed", error: { present: false } });
    result = snapshot(state, auth).result;
    assert.equal(result.reclaimSucceeded, true);
    assert.equal(result.integrityPass, false);
    assert.equal(result.overallPass, false);
    assert.equal(state.diagnosticErrors(auth).at(-1)?.value, original);
  });

  test("reclaim timeout保持同一pending；迟到removed不改写timeout为PASS", () => {
    const { state, auth } = fresh();
    completeNoResourceRun(state, auth);
    const first = state.requestReclaim(auth);
    state.timeoutReclaim(auth, { attempt: first.attempt });
    const pending = state.requestReclaim(auth);
    assert.equal(pending.status, "pending");
    assert.equal(pending.attempt, first.attempt);
    state.completeReclaim(auth, { attempt: first.attempt, outcome: "removed", error: { present: false } });
    const current = snapshot(state, auth);
    assert.equal(current.reclaim.currentTimeouts, 1);
    assert.equal(current.result.reclaimSucceeded, true);
    assert.equal(current.result.integrityPass, false);
    assert.equal(current.result.overallPass, false);
  });

  test("removed后只允许snapshot和diagnosticErrors只读，所有新操作永久拒绝", () => {
    const { state, auth } = fresh();
    completeNoResourceRun(state, auth);
    const request = state.requestReclaim(auth);
    state.completeReclaim(auth, { attempt: request.attempt, outcome: "removed", error: { present: false } });
    assert.equal(snapshot(state, auth).lifecycle, "removed");
    assert.deepEqual(state.diagnosticErrors(auth), []);
    for (const action of [
      () => state.requestReclaim(auth),
      () => state.beginRun(auth),
      () => state.beginClosing(auth, { reason: "same-path-reappeared" }),
      () => state.recordExecutionClose(auth, { kind: "natural", exitCode: 0, signal: null }),
    ]) {
      assert.throws(action, assertCode("owner_retired"));
    }
    assert.equal(snapshot(state, auth).result.overallPass, true);
  });

  test("业务失败仍可形成物理/回收候选，但提前exit0、缺case和强杀均不PASS", () => {
    const failed = fresh();
    failed.state.beginCase(failed.auth, "normal");
    failed.state.recordCaseResult(failed.auth, {
      caseId: "normal",
      outcome: "failure",
      error: { present: true, value: new Error("assertion failed") },
    });
    closeExecution(failed.state, failed.auth);
    eof(failed.state, failed.auth, 1);
    assert.equal(snapshot(failed.state, failed.auth).result.physicalEndCandidate, true);
    assert.equal(snapshot(failed.state, failed.auth).result.reclaimCandidate, true);
    assert.equal(snapshot(failed.state, failed.auth).result.executionPassCandidate, false);

    const early = fresh();
    closeExecution(early.state, early.auth, { kind: "early-exit", exitCode: 0, signal: null });
    eof(early.state, early.auth, 1);
    assert.equal(snapshot(early.state, early.auth).result.overallPass, false);

    const forced = fresh();
    passCurrentCase(forced.state, forced.auth);
    closeExecution(forced.state, forced.auth, { kind: "forced", exitCode: null, signal: "SIGKILL" });
    eof(forced.state, forced.auth, 1);
    assert.equal(snapshot(forced.state, forced.auth).result.executionPassCandidate, false);
  });

  test("执行组仍alive时即使fixture局部资源为空也不可候选", () => {
    const { state, auth } = fresh();
    passCurrentCase(state, auth);
    state.beginClosing(auth, { reason: "fixture-locals-empty" });
    state.recordExecutionClose(auth, { kind: "natural", exitCode: 0, signal: null });
    state.observeExecutionGroup(auth, { groupState: "alive" });
    eof(state, auth, 1);
    const current = snapshot(state, auth);
    assert.equal(current.resources.length, 0);
    assert.equal(current.result.physicalEndCandidate, false);
  });

  test("unknown原错误按存在位保存falsy值和对象原引用，snapshot不读getter", () => {
    for (const value of [undefined, null, false, 0, ""] as const) {
      const { state, auth } = fresh();
      state.beginCase(auth, "normal");
      state.recordCaseResult(auth, {
        caseId: "normal",
        outcome: "failure",
        error: { present: true, value },
      });
      assert.equal(Object.is(state.diagnosticErrors(auth)[0]?.value, value), true);
    }

    const { state, auth } = fresh();
    state.beginCase(auth, "normal");
    let reads = 0;
    const original = Object.create(null) as object;
    Object.defineProperty(original, "message", {
      get() {
        reads += 1;
        throw new Error("error getter must not run");
      },
    });
    state.recordCaseResult(auth, {
      caseId: "normal",
      outcome: "failure",
      error: { present: true, value: original },
    });
    snapshot(state, auth);
    assert.equal(reads, 0);
    assert.equal(state.diagnosticErrors(auth)[0]?.value, original);
  });

  test("proven-not-created来自既有reservation且不伪造handle/close", () => {
    const { state, auth } = fresh();
    state.beginCase(auth, "normal");
    const key = Object.freeze({ preSpawn: true });
    state.reserveResource(auth, {
      caseId: "normal",
      resourceKey: key,
      kind: "detached-group",
      writerId: "execution",
      sequence: 1,
    });
    state.proveResourceNotCreated(auth, { resourceKey: key, writerId: "execution", sequence: 2 });
    state.recordCaseResult(auth, { caseId: "normal", outcome: "pass", error: { present: false } });
    closeExecution(state, auth);
    eof(state, auth, 3);
    const resource = snapshot(state, auth).resources[0];
    assert.equal(resource?.state, "proven-not-created");
    assert.equal(resource?.hasOriginalHandleKey, false);
    assert.equal(resource?.closeObserved, false);
    assert.equal(snapshot(state, auth).result.physicalEndCandidate, true);
  });

  test("配置实际限制case、stop总数、writer与标识长度，不静默截断", () => {
    const tiny: Limits = {
      ...limits,
      maxCases: 1,
      maxStops: 1,
      maxWriters: 1,
      maxStopAttempts: 2,
      maxIdentifierLength: 4,
    };
    assert.throws(
      () => createPmSdkQuiescenceState(configuration({
        expectedCases: [{
          id: "case",
          stops: [
            { id: "one", expectFailureThenRecovery: false },
            { id: "two", expectFailureThenRecovery: false },
          ],
        }],
        limits: tiny,
      })),
      assertCode("expected_stops_exceed_capacity"),
    );
    assert.throws(
      () => createPmSdkQuiescenceState(configuration({
        expectedCases: [{ id: "long-id", stops: [] }],
        limits: tiny,
      })),
      assertCode("invalid_case_id"),
    );
    assert.throws(
      () => createPmSdkQuiescenceState(configuration({
        expectedWriters: ["one", "two"],
        expectedCases: [{ id: "case", stops: [] }],
        limits: tiny,
      })),
      assertCode("expected_writers_exceed_capacity"),
    );
    assert.throws(
      () => createPmSdkQuiescenceState(configuration({
        expectedCases: [{ id: "case", stops: [] }],
        expectedWriters: ["writer-long"],
        limits: tiny,
      })),
      assertCode("invalid_writer_id"),
    );
    const bounded = fresh({
      expectedCases: [{ id: "case", stops: [] }],
      expectedWriters: ["one"],
      limits: { ...tiny, maxEvents: 1 },
    });
    assert.throws(() => bounded.state.beginCase(bounded.auth, "case"), assertCode("event_capacity_exceeded_preserved"));
    assert.equal(snapshot(bounded.state, bounded.auth).overflow.events, true);
  });

  test("调用者自报stopped=true被契约拒绝且不完成pending attempt", () => {
    const { state, auth } = fresh({
      expectedCases: [{ id: "normal", stops: [{ id: "host", expectFailureThenRecovery: false }] }],
    });
    state.beginCase(auth, "normal");
    const request = state.requestStop(auth, { caseId: "normal", stopId: "host" });
    assert.throws(
      () => state.completeStop(auth, {
        caseId: "normal",
        stopId: "host",
        attempt: request.attempt,
        outcome: "success",
        error: { present: false },
        stopped: true,
      }),
      assertCode("invalid_stop_completion"),
    );
    assert.equal(snapshot(state, auth).cases[0]?.stops[0]?.attempts[0]?.status, "pending");
  });

  test("snapshot被冻结、不含owner或删除token，返回值不能改内部状态", () => {
    const { state, auth } = fresh();
    completeNoResourceRun(state, auth);
    const current = snapshot(state, auth);
    assert.equal(current.authority, "diagnostic-candidates-only");
    assert.equal(current.adapterStatus, "not-implemented");
    assert.equal(Object.isFrozen(current), true);
    assert.equal(Object.hasOwn(current, "deleteToken"), false);
    assert.equal(Object.hasOwn(current, "owner"), false);
    assert.equal(Reflect.set(current.result, "reclaimCandidate", false), false);
    assert.equal(snapshot(state, auth).result.reclaimCandidate, true);
  });
});

describe("Q1 authenticated facts and ended execution domain", () => {
  function detachedAfterEof(groupState: "alive" | "gone" = "gone") {
    const { state, auth } = fresh();
    state.beginCase(auth, "normal");
    const resourceKey = {}, handleKey = {};
    state.reserveResource(auth, { caseId: "normal", resourceKey, kind: "detached-group", writerId: "execution", sequence: 1 });
    state.bindResource(auth, { resourceKey, handleKey, pid: 201, writerId: "execution", sequence: 2 });
    state.observeResourceClose(auth, { resourceKey, handleKey, writerId: "execution", sequence: 3 });
    state.observeResourceGroup(auth, { resourceKey, handleKey, groupState });
    state.recordCaseResult(auth, { caseId: "normal", outcome: "pass", error: { present: false } });
    closeExecution(state, auth);
    eof(state, auth, 4);
    return { state, auth, resourceKey, handleKey };
  }

  test.each(["alive", "unknown"] as const)("父探测在子EOF后发现%s仍撤销全部候选", (groupState) => {
    const { state, auth, resourceKey, handleKey } = detachedAfterEof();
    assert.equal(snapshot(state, auth).result.reclaimCandidate, true);
    assert.throws(() => state.observeResourceGroup(auth, { resourceKey, handleKey, groupState }), assertCode("group_state_regression_preserved"));
    state.observeResourceGroup(auth, { resourceKey, handleKey, groupState: "gone" });
    assert.equal(snapshot(state, auth).result.physicalEndCandidate, false);
    assert.equal(snapshot(state, auth).result.overallPass, false);
    assert.throws(() => state.requestReclaim(auth));
  });

  test("子EOF不禁止父层随后核实原detached组消失", () => {
    const { state, auth, resourceKey, handleKey } = detachedAfterEof("alive");
    assert.equal(snapshot(state, auth).result.reclaimCandidate, false);
    state.observeResourceGroup(auth, { resourceKey, handleKey, groupState: "gone" });
    assert.equal(snapshot(state, auth).writers[0]?.nextSequence, 5);
    assert.equal(snapshot(state, auth).result.reclaimCandidate, true);
    const reclaim = state.requestReclaim(auth);
    state.completeReclaim(auth, { attempt: reclaim.attempt, outcome: "removed", error: { present: false } });
    assert.equal(snapshot(state, auth).result.overallPass, true);
  });

  test.each(["unknown-writer", "partial-after-eof"] as const)("认证流异常%s不能只抛错而保留旧候选", (mode) => {
    const { state, auth } = fresh();
    completeNoResourceRun(state, auth);
    assert.throws(() => state.recordWriterEof(auth, {
      writerId: mode === "unknown-writer" ? "foreign" : "execution",
      sequence: mode === "unknown-writer" ? 1 : 2,
      completeFrame: mode === "unknown-writer",
    }));
    assert.equal(snapshot(state, auth).protocolDamaged, true);
    assert.equal(snapshot(state, auth).result.reclaimCandidate, false);
    assert.throws(() => state.requestReclaim(auth));
  });

  test("同一reservation重绑另一句柄后不得复用序号洗白", () => {
    const { state, auth } = fresh();
    state.beginCase(auth, "normal");
    const resourceKey = {}, handleKey = {};
    state.reserveResource(auth, { caseId: "normal", resourceKey, kind: "detached-group", writerId: "execution", sequence: 1 });
    state.bindResource(auth, { resourceKey, handleKey, pid: 202, writerId: "execution", sequence: 2 });
    assert.throws(() => state.bindResource(auth, { resourceKey, handleKey: {}, pid: 203, writerId: "execution", sequence: 3 }), assertCode("resource_rebinding_preserved"));
    state.observeResourceClose(auth, { resourceKey, handleKey, writerId: "execution", sequence: 3 });
    state.observeResourceGroup(auth, { resourceKey, handleKey, groupState: "gone" });
    state.recordCaseResult(auth, { caseId: "normal", outcome: "pass", error: { present: false } });
    closeExecution(state, auth);
    eof(state, auth, 4);
    assert.equal(snapshot(state, auth).result.physicalEndCandidate, false);
  });

  test("not-created不能接受任何group存在观察或事后绑定", () => {
    for (const groupState of ["alive", "unknown", "gone"] as const) for (const handleKey of [null, {}]) {
      const { state, auth } = fresh();
      state.beginCase(auth, "normal");
      const resourceKey = {};
      state.reserveResource(auth, { caseId: "normal", resourceKey, kind: "detached-group", writerId: "execution", sequence: 1 });
      state.proveResourceNotCreated(auth, { resourceKey, writerId: "execution", sequence: 2 });
      state.recordCaseResult(auth, { caseId: "normal", outcome: "pass", error: { present: false } });
      closeExecution(state, auth);
      eof(state, auth, 3);
      assert.equal(snapshot(state, auth).result.reclaimCandidate, true);
      assert.throws(() => state.observeResourceGroup(auth, { resourceKey, handleKey, groupState }), assertCode("not_created_group_contradiction"));
      assert.equal(snapshot(state, auth).result.physicalEndCandidate, false);
      assert.throws(() => state.requestReclaim(auth));
    }
    const { state, auth } = fresh();
    state.beginCase(auth, "normal");
    const resourceKey = {};
    state.reserveResource(auth, { caseId: "normal", resourceKey, kind: "detached-group", writerId: "execution", sequence: 1 });
    state.proveResourceNotCreated(auth, { resourceKey, writerId: "execution", sequence: 2 });
    assert.throws(() => state.bindResource(auth, { resourceKey, handleKey: {}, pid: 204, writerId: "execution", sequence: 3 }), assertCode("resource_rebinding_preserved"));
    state.recordCaseResult(auth, { caseId: "normal", outcome: "pass", error: { present: false } });
    closeExecution(state, auth);
    eof(state, auth, 3);
    assert.equal(snapshot(state, auth).result.reclaimCandidate, false);
  });

  test("完整执行域结束仅把pending stop派生为结果未知，不伪造settled或PASS", () => {
    assert.throws(() => createPmSdkQuiescenceState({ ...configuration(), stopDomain: "outer-owner" }), assertCode("unsupported_stop_domain"));
    const { state, auth } = fresh({ expectedCases: [{ id: "normal", stops: [{ id: "host", expectFailureThenRecovery: false }] }] });
    state.beginCase(auth, "normal");
    const attempt = state.requestStop(auth, { caseId: "normal", stopId: "host" });
    state.timeoutStop(auth, { caseId: "normal", stopId: "host", attempt: attempt.attempt });
    const resourceKey = {}, handleKey = {};
    state.reserveResource(auth, { caseId: "normal", resourceKey, kind: "detached-group", writerId: "execution", sequence: 1 });
    state.bindResource(auth, { resourceKey, handleKey, pid: 205, writerId: "execution", sequence: 2 });
    state.observeResourceClose(auth, { resourceKey, handleKey, writerId: "execution", sequence: 3 });
    state.recordCaseResult(auth, { caseId: "normal", outcome: "pass", error: { present: false } });
    closeExecution(state, auth, { kind: "forced", exitCode: null, signal: "SIGKILL" });
    assert.equal(snapshot(state, auth).result.physicalEndCandidate, false);
    eof(state, auth, 4);
    assert.equal(snapshot(state, auth).result.physicalEndCandidate, false);
    assert.equal(snapshot(state, auth).cases[0]?.stops[0]?.attempts[0]?.status, "pending");
    state.observeResourceGroup(auth, { resourceKey, handleKey, groupState: "gone" });
    const observed = snapshot(state, auth);
    assert.equal(observed.stopDomain, "execution-tree");
    assert.equal(observed.result.physicalEndCandidate, true);
    assert.equal(observed.result.stopPass, false);
    assert.equal(observed.cases[0]?.stops[0]?.attempts[0]?.status, "terminated-with-process");
    assert.equal(observed.cases[0]?.stops[0]?.attempts[0]?.settlementStatus, "pending");
    assert.equal(observed.cases[0]?.stops[0]?.attempts[0]?.outcome, "unknown-outcome");
    assert.throws(() => finishStop(state, auth, attempt.attempt, "success", { present: false }), assertCode("stop_execution_domain_ended"));
    const reclaim = state.requestReclaim(auth);
    state.completeReclaim(auth, { attempt: reclaim.attempt, outcome: "removed", error: { present: false } });
    assert.equal(snapshot(state, auth).result.overallPass, false);
  });

  test("已结束执行域或回收开始后禁止新stop及失败stop恢复", () => {
    for (const priorFailure of [false, true]) {
      const { state, auth } = fresh({ expectedCases: [{ id: "normal", stops: [{ id: "host", expectFailureThenRecovery: false }] }] });
      state.beginCase(auth, "normal");
      if (priorFailure) {
        const stop = state.requestStop(auth, { caseId: "normal", stopId: "host" });
        finishStop(state, auth, stop.attempt, "failure", { present: true, value: undefined });
      }
      state.recordCaseResult(auth, { caseId: "normal", outcome: "pass", error: { present: false } });
      closeExecution(state, auth);
      eof(state, auth, 1);
      assert.throws(() => state.requestStop(auth, { caseId: "normal", stopId: "host" }), assertCode("new_stop_after_domain_end"));
      const reclaim = state.requestReclaim(auth);
      assert.equal(state.requestReclaim(auth).attempt, reclaim.attempt);
      assert.throws(() => state.requestStop(auth, { caseId: "normal", stopId: "host" }), assertCode("new_stop_after_domain_end"));
      state.completeReclaim(auth, { attempt: reclaim.attempt, outcome: "failed", error: { present: true, value: null } });
      assert.throws(() => state.requestStop(auth, { caseId: "normal", stopId: "host" }), assertCode("new_stop_after_domain_end"));
      const retry = state.requestReclaim(auth);
      state.completeReclaim(auth, { attempt: retry.attempt, outcome: "removed", error: { present: false } });
      assert.equal(snapshot(state, auth).result.overallPass, false);
      assert.throws(() => state.requestStop(auth, { caseId: "normal", stopId: "host" }), assertCode("owner_retired"));
    }
  });
});

describe("Q1 stream invariants and durable terminal facts", () => {
  test.each(["reserve", "bind", "not-created", "close", "eof"] as const)("子流入口%s不以资源状态遮蔽EOF或坏序号", (method) => {
    for (const fault of ["after-eof", "invalid-sequence", "unknown-writer"] as const) {
      const { state, auth } = fresh();
      state.beginCase(auth, "normal");
      const key = {}, handle = {};
      let sequence = 1;
      if (method === "not-created") {
        state.reserveResource(auth, { caseId: "normal", resourceKey: key, kind: "detached-group", writerId: "execution", sequence: sequence++ });
        state.proveResourceNotCreated(auth, { resourceKey: key, writerId: "execution", sequence: sequence++ });
      } else if (method === "bind" || method === "close") {
        state.reserveResource(auth, { caseId: "normal", resourceKey: key, kind: "detached-group", writerId: "execution", sequence: sequence++ });
        state.bindResource(auth, { resourceKey: key, handleKey: handle, pid: 301, writerId: "execution", sequence: sequence++ });
        state.observeResourceClose(auth, { resourceKey: key, handleKey: handle, writerId: "execution", sequence: sequence++ });
        state.observeResourceGroup(auth, { resourceKey: key, handleKey: handle, groupState: "gone" });
      }
      state.recordCaseResult(auth, { caseId: "normal", outcome: "pass", error: { present: false } });
      closeExecution(state, auth);
      if (fault === "after-eof") eof(state, auth, sequence++);
      const stream = { writerId: fault === "unknown-writer" ? "foreign" : "execution", sequence: fault === "invalid-sequence" ? NaN : sequence };
      assert.throws(() => {
        if (method === "reserve") state.reserveResource(auth, { caseId: "normal", resourceKey: {}, kind: "execution-child", ...stream });
        else if (method === "bind") state.bindResource(auth, { resourceKey: key, handleKey: handle, pid: 301, ...stream });
        else if (method === "not-created") state.proveResourceNotCreated(auth, { resourceKey: key, ...stream });
        else if (method === "close") state.observeResourceClose(auth, { resourceKey: key, handleKey: handle, ...stream });
        else state.recordWriterEof(auth, { ...stream, completeFrame: false });
      });
      if (!snapshot(state, auth).writers[0]?.eof) eof(state, auth, sequence);
      assert.equal(snapshot(state, auth).protocolDamaged, true);
      assert.equal(snapshot(state, auth).result.reclaimCandidate, false);
      assert.equal(snapshot(state, auth).result.overallPass, false);
      assert.throws(() => state.requestReclaim(auth));
    }
  });

  test("伪handle不取得原资源身份，不能污染另一个合法状态", () => {
    const { state, auth } = fresh();
    state.beginCase(auth, "normal");
    const key = {}, handle = {};
    state.reserveResource(auth, { caseId: "normal", resourceKey: key, kind: "detached-group", writerId: "execution", sequence: 1 });
    state.bindResource(auth, { resourceKey: key, handleKey: handle, pid: 302, writerId: "execution", sequence: 2 });
    const before = snapshot(state, auth);
    assert.throws(() => state.observeResourceClose(auth, { resourceKey: key, handleKey: {}, writerId: "foreign", sequence: NaN }), assertCode("wrong_handle_key"));
    assert.deepEqual(snapshot(state, auth), before);
  });

  test.each(["pending", "failed", "not-requested"] as const)("终止域锁存后候选撤销不能复活%s stop", (prior) => {
    for (const fault of ["unknown-writer", "partial-eof", "group-regression"] as const) {
      const { state, auth } = fresh({ expectedCases: [{ id: "normal", stops: [{ id: "host", expectFailureThenRecovery: false }] }] });
      state.beginCase(auth, "normal");
      let stop: ReturnType<State["requestStop"]> | undefined;
      if (prior !== "not-requested") {
        stop = state.requestStop(auth, { caseId: "normal", stopId: "host" });
        if (prior === "failed") finishStop(state, auth, stop.attempt, "failure", { present: true, value: 0 });
      }
      state.recordCaseResult(auth, { caseId: "normal", outcome: "pass", error: { present: false } });
      closeExecution(state, auth);
      eof(state, auth, 1);
      assert.equal(snapshot(state, auth).executionDomainEnded, true);
      assert.throws(() => {
        if (fault === "group-regression") state.observeExecutionGroup(auth, { groupState: "unknown" });
        else state.recordWriterEof(auth, { writerId: fault === "unknown-writer" ? "foreign" : "execution", sequence: 2, completeFrame: false });
      });
      const revoked = snapshot(state, auth);
      assert.equal(revoked.executionDomainEnded, true);
      assert.equal(revoked.result.physicalEndCandidate, false);
      assert.throws(() => state.requestStop(auth, { caseId: "normal", stopId: "host" }), assertCode("new_stop_after_domain_end"));
      if (prior === "pending") {
        assert.throws(() => finishStop(state, auth, stop!.attempt, "success", { present: false }), assertCode("stop_execution_domain_ended"));
        const attempt = snapshot(state, auth).cases[0]?.stops[0]?.attempts[0];
        assert.equal(attempt?.status, "terminated-with-process");
        assert.equal(attempt?.settlementStatus, "pending");
        assert.equal(attempt?.outcome, "unknown-outcome");
      }
      assert.equal(snapshot(state, auth).result.stopPass, false);
      assert.equal(snapshot(state, auth).result.overallPass, false);
    }
  });

  test("closing但流尚未封口时真实stop完成仍可记录", () => {
    const { state, auth } = fresh({ expectedCases: [{ id: "normal", stops: [{ id: "host", expectFailureThenRecovery: false }] }] });
    state.beginCase(auth, "normal");
    const stop = state.requestStop(auth, { caseId: "normal", stopId: "host" });
    state.recordCaseResult(auth, { caseId: "normal", outcome: "pass", error: { present: false } });
    closeExecution(state, auth);
    assert.equal(snapshot(state, auth).executionDomainEnded, false);
    finishStop(state, auth, stop.attempt, "success", { present: false });
    eof(state, auth, 1);
    const reclaim = state.requestReclaim(auth);
    state.completeReclaim(auth, { attempt: reclaim.attempt, outcome: "removed", error: { present: false } });
    assert.equal(snapshot(state, auth).result.overallPass, true);
  });

  test.each([false, true])("已开始回收在事件额度耗尽后保留removed（中间坏观察=%s）", (extraObservation) => {
    const { state, auth } = fresh({ limits: { ...limits, maxEvents: 8 } });
    completeNoResourceRun(state, auth);
    assert.equal(snapshot(state, auth).eventCount, 7);
    const reclaim = state.requestReclaim(auth);
    if (extraObservation) assert.throws(() => state.observeExecutionGroup(auth, { groupState: "alive" }), assertCode("event_capacity_exceeded_preserved"));
    assert.throws(() => state.completeReclaim(auth, { attempt: reclaim.attempt, outcome: "removed", error: { present: false } }), assertCode("event_capacity_exceeded_preserved"));
    const result = snapshot(state, auth);
    assert.equal(result.lifecycle, "removed");
    assert.equal(result.reclaim.currentStatus, "completed");
    assert.equal(result.reclaim.currentOutcome, "removed");
    assert.equal(result.overflow.events, true);
    assert.equal(result.executionDomainEnded, true);
    assert.equal(result.result.overallPass, false);
    assert.throws(() => state.requestReclaim(auth), assertCode("owner_retired"));
  });

  test("普通错误额度耗尽不吞掉已发出回收的原失败引用", () => {
    const { state, auth } = fresh({ expectedCases: [{ id: "one", stops: [] }, { id: "two", stops: [] }], limits: { ...limits, maxErrors: 1 } });
    const firstError = {}, terminalError = {};
    state.beginCase(auth, "one");
    state.recordCaseResult(auth, { caseId: "one", outcome: "failure", error: { present: true, value: firstError } });
    state.beginCase(auth, "two");
    closeExecution(state, auth);
    eof(state, auth, 1);
    const reclaim = state.requestReclaim(auth);
    assert.throws(() => state.recordCaseResult(auth, { caseId: "two", outcome: "failure", error: { present: true, value: undefined } }), assertCode("error_capacity_exceeded_preserved"));
    state.completeReclaim(auth, { attempt: reclaim.attempt, outcome: "failed", error: { present: true, value: terminalError } });
    const result = snapshot(state, auth);
    assert.equal(result.reclaim.currentStatus, "completed");
    assert.equal(result.reclaim.currentOutcome, "failed");
    assert.equal(result.ordinaryErrorCount, 1);
    assert.equal(result.reclaimTerminalErrorCount, 1);
    assert.equal(result.result.overallPass, false);
    assert.equal(state.diagnosticErrors(auth)[0]?.value, firstError);
    assert.equal(state.diagnosticErrors(auth)[1]?.value, terminalError);
    assert.throws(() => state.requestReclaim(auth), assertCode("state_preserved_after_overflow"));
  });

  test("终态槽保留真实回收失败，即使追加日志也失败", () => {
    const { state, auth } = fresh({ limits: { ...limits, maxEvents: 8 } });
    completeNoResourceRun(state, auth);
    const reclaim = state.requestReclaim(auth), failure = { original: true };
    assert.throws(() => state.completeReclaim(auth, { attempt: reclaim.attempt, outcome: "failed", error: { present: true, value: failure } }), assertCode("event_capacity_exceeded_preserved"));
    assert.equal(snapshot(state, auth).reclaim.currentOutcome, "failed");
    assert.equal(state.diagnosticErrors(auth)[0]?.value, failure);
    assert.equal(snapshot(state, auth).result.overallPass, false);
  });
});

describe("Q1 unified authenticated stream boundary", () => {
  const methods = ["reserveResource", "bindResource", "proveResourceNotCreated", "observeResourceClose", "recordWriterEof"] as const;
  type Method = typeof methods[number];
  type Data = Record<PropertyKey, unknown>;
  function world(method: Method, factory: Factory = createPmSdkQuiescenceState, maxEvents = limits.maxEvents) {
    const state = factory(configuration({ expectedWriters: ["execution", "other"], limits: { ...limits, maxEvents } }));
    const auth = state.credentials, key = {}, handle = {};
    state.beginRun(auth);
    state.beginCase(auth, "normal");
    let sequence = 1;
    if (method !== "reserveResource" && method !== "recordWriterEof") {
      state.reserveResource(auth, { caseId: "normal", resourceKey: key, kind: "execution-child", writerId: "execution", sequence: sequence++ });
      if (method === "observeResourceClose") state.bindResource(auth, { resourceKey: key, handleKey: handle, pid: 401, writerId: "execution", sequence: sequence++ });
    }
    const stream = { writerId: "execution", sequence };
    const fact: Data = method === "reserveResource" ? { ...stream, caseId: "normal", resourceKey: key, kind: "execution-child" }
      : method === "bindResource" ? { ...stream, resourceKey: key, handleKey: handle, pid: 401 }
      : method === "proveResourceNotCreated" ? { ...stream, resourceKey: key }
      : method === "observeResourceClose" ? { ...stream, resourceKey: key, handleKey: handle }
      : { ...stream, completeFrame: true };
    return { state, auth, key, handle, fact };
  }
  type World = ReturnType<typeof world>;
  function finish(w: World) {
    const { state, auth, key, handle } = w;
    const next = () => snapshot(state, auth).writers[0]!.nextSequence;
    const resource = snapshot(state, auth).resources[0];
    if (resource?.state === "reserved") state.proveResourceNotCreated(auth, { resourceKey: key, writerId: "execution", sequence: next() });
    if (resource?.state === "bound") state.observeResourceClose(auth, { resourceKey: key, handleKey: handle, writerId: "execution", sequence: next() });
    if (snapshot(state, auth).cases[0]?.result === "missing") state.recordCaseResult(auth, { caseId: "normal", outcome: "pass", error: { present: false } });
    if (!snapshot(state, auth).execution.closeObserved) closeExecution(state, auth);
    for (const writer of snapshot(state, auth).writers) if (!writer.eof) eof(state, auth, writer.nextSequence, writer.writerId);
  }
  function blocked(w: World) {
    const s = snapshot(w.state, w.auth);
    assert.equal(s.protocolDamaged, true);
    assert.equal(s.result.physicalEndCandidate, false);
    assert.equal(s.result.reclaimCandidate, false);
    assert.equal(s.result.integrityPass, false);
    assert.equal(s.result.overallPass, false);
  }
  function getter(data: Data, key: PropertyKey, read: () => void) {
    Object.defineProperty(data, key, { configurable: true, enumerable: true, get() { read(); throw new Error("getter executed"); } });
  }
  function payload(method: Method, data: Data, mode: string, read: () => void) {
    const field = method === "reserveResource" ? "kind" : method === "bindResource" ? "pid" : method === "recordWriterEof" ? "completeFrame" : "sequence";
    if (mode === "value") {
      if (method === "observeResourceClose" || method === "proveResourceNotCreated") data.unexpected = 0;
      else data[field] = 0;
    } else if (mode === "missing") delete data[field];
    else if (mode === "accessor") getter(data, field, read);
    else if (mode === "extra") data.extra = true;
    else if (mode === "symbol") data[Symbol("extra")] = true;
    else if (mode === "hidden") Object.defineProperty(data, "hidden", { value: true });
  }

  test.each(methods)("%s：流错误与载荷错误组合必须统一保全", (method) => {
    for (const flow of ["normal", "after-eof", "unknown", "invalid", "gap", "wrong-writer"])
      for (const malformed of ["valid", "value", "missing", "accessor", "extra", "symbol", "hidden"]) {
        if (flow === "normal" && malformed === "valid") continue;
        if (flow === "wrong-writer" && (method === "reserveResource" || method === "recordWriterEof")) continue;
        const w = world(method);
        if (flow === "after-eof") {
          if (method === "bindResource") w.state.bindResource(w.auth, w.fact);
          finish(w);
          assert.equal(snapshot(w.state, w.auth).result.reclaimCandidate, true);
          w.fact.sequence = snapshot(w.state, w.auth).writers[0]!.nextSequence;
        }
        if (flow === "unknown") w.fact.writerId = "unregistered";
        if (flow === "wrong-writer") { w.fact.writerId = "other"; w.fact.sequence = 1; }
        if (flow === "invalid") w.fact.sequence = NaN;
        if (flow === "gap") w.fact.sequence = Number(w.fact.sequence) + 1;
        let reads = 0;
        payload(method, w.fact, malformed, () => reads++);
        assert.throws(() => w.state[method](w.auth, w.fact), `${method}/${flow}/${malformed}`);
        assert.equal(reads, 0);
        blocked(w);
        finish(w);
        blocked(w);
        assert.throws(() => w.state.requestReclaim(w.auth));
      }
  });

  test("五入口缺失或访问器流字段也属于已认证拒收", () => {
    for (const method of methods) for (const field of ["writerId", "sequence"]) for (const kind of ["missing", "accessor", "invalid"]) {
      const w = world(method);
      let reads = 0;
      if (kind === "missing") delete w.fact[field];
      if (kind === "accessor") getter(w.fact, field, () => reads++);
      if (kind === "invalid") w.fact[field] = undefined;
      assert.throws(() => w.state[method](w.auth, w.fact));
      blocked(w);
      assert.equal(reads, 0);
    }
  });

  test("五入口正常控制只消费一次序号，并可正常完成回收", () => {
    for (const method of methods) {
      const w = world(method), sequence = Number(w.fact.sequence);
      w.state[method](w.auth, w.fact);
      assert.equal(snapshot(w.state, w.auth).writers[0]?.nextSequence, sequence + 1);
      finish(w);
      const attempt = w.state.requestReclaim(w.auth);
      w.state.completeReclaim(w.auth, { attempt: attempt.attempt, outcome: "removed", error: { present: false } });
      assert.equal(snapshot(w.state, w.auth).result.overallPass, true);
    }
  });

  test("身份失败与坏流/载荷组合不污染两个owner，不执行getter", () => {
    for (const method of methods) {
      const identityModes = ["owner-wrong", "epoch-wrong", "owner-missing", "epoch-missing", "owner-inherited", "epoch-inherited", "owner-getter", "epoch-getter"];
      if (method !== "reserveResource" && method !== "recordWriterEof") identityModes.push("key-foreign", "key-missing", "key-inherited", "key-getter");
      if (method === "observeResourceClose") identityModes.push("handle-wrong", "handle-missing", "handle-inherited", "handle-getter");
      for (const mode of identityModes) {
        const w = world(method), other = world(method);
        const a: Data = { ...w.auth, extra: true };
        let data: Data = { ...w.fact, writerId: "foreign", sequence: NaN, extra: true }, reads = 0;
        const [target, fault] = mode.split("-");
        const object = target === "owner" || target === "epoch" ? a : data;
        const field = target === "key" ? "resourceKey" : target === "handle" ? "handleKey" : target!;
        const original = object[field];
        if (fault === "wrong") object[field] = {};
        if (fault === "foreign") object[field] = other.key;
        if (fault === "missing") delete object[field];
        if (fault === "inherited") { delete object[field]; Object.setPrototypeOf(object, { [field]: original }); }
        if (fault === "getter") getter(object, field, () => reads++);
        const before = snapshot(w.state, w.auth), otherBefore = snapshot(other.state, other.auth);
        assert.throws(() => w.state[method](a, data));
        assert.equal(reads, 0);
        assert.deepEqual(snapshot(w.state, w.auth), before);
        assert.deepEqual(snapshot(other.state, other.auth), otherBefore);
      }
    }
  });

  test("准确身份的auth/fact外壳及额外字段不能绕过保护", () => {
    for (const method of methods) for (const target of ["auth", "fact"])
      for (const shape of ["array", "function", "null-prototype", "extra", "symbol", "hidden"]) {
        const w = world(method);
        const original = target === "auth" ? w.auth : w.fact;
        const carrier = shape === "array" ? [] : shape === "function" ? function carrier() {} : shape === "null-prototype" ? Object.create(null) as object : {};
        const value: Data = Object.assign(carrier, original);
        if (shape === "extra") value.extra = true;
        if (shape === "symbol") value[Symbol("extra")] = true;
        if (shape === "hidden") Object.defineProperty(value, "hidden", { value: true });
        const a = target === "auth" ? value : w.auth, data = target === "fact" ? value : w.fact;
        if (shape === "null-prototype") {
          w.state[method](a, data);
          assert.equal(snapshot(w.state, w.auth).protocolDamaged, false);
        } else {
          assert.throws(() => w.state[method](a, data));
          blocked(w);
        }
      }
    for (const method of methods) for (const value of [null, undefined, 0, "bad"]) {
      const w = world(method), before = snapshot(w.state, w.auth);
      assert.throws(() => w.state[method](w.auth, value));
      if (method === "reserveResource" || method === "recordWriterEof") blocked(w);
      else assert.deepEqual(snapshot(w.state, w.auth), before);
    }
  });

  test("拟绑定handle、未绑定close及原引用类型遵守不同身份边界", () => {
    const bind = world("bindResource");
    bind.state.bindResource(bind.auth, bind.fact);
    assert.throws(() => bind.state.bindResource(bind.auth, { ...bind.fact, handleKey: {}, sequence: 3 }));
    blocked(bind);
    for (const phase of ["reserved", "not-created"]) for (const missing of [true, false]) {
      const w = world("bindResource");
      if (phase === "not-created") w.state.proveResourceNotCreated(w.auth, { resourceKey: w.key, writerId: "execution", sequence: 2 });
      let reads = 0;
      const data: Data = { resourceKey: w.key, writerId: "execution", sequence: phase === "reserved" ? 2 : 3 };
      if (!missing) getter(data, "handleKey", () => reads++);
      assert.throws(() => w.state.observeResourceClose(w.auth, data));
      blocked(w);
      assert.equal(reads, 0);
      assert.equal(snapshot(w.state, w.auth).resources[0]?.hasOriginalHandleKey, false);
    }
    for (const key of [[], function key() {}]) for (const handle of [[], function handle() {}]) {
      const { state, auth } = fresh();
      state.beginCase(auth, "normal");
      state.reserveResource(auth, { caseId: "normal", resourceKey: key, kind: "execution-child", writerId: "execution", sequence: 1 });
      state.bindResource(auth, { resourceKey: key, handleKey: handle, pid: 402, writerId: "execution", sequence: 2 });
      state.observeResourceClose(auth, { resourceKey: key, handleKey: handle, writerId: "execution", sequence: 3 });
      state.recordCaseResult(auth, { caseId: "normal", outcome: "pass", error: { present: false } });
      closeExecution(state, auth); eof(state, auth, 4);
      assert.equal(snapshot(state, auth).result.reclaimCandidate, true);
    }
  });

  test("EOF后、序号错误和半帧的首错不被满额诊断替换", () => {
    for (const [sequence, completeFrame, expected] of [
      [NaN, true, "invalid_writer_sequence_preserved"],
      [2, true, "writer_sequence_gap_preserved"],
      [1, false, "writer_partial_frame_preserved"],
    ] as const) {
      const w = world("recordWriterEof", createPmSdkQuiescenceState, 2);
      assert.throws(() => w.state.recordWriterEof(w.auth, { ...w.fact, sequence, completeFrame }), assertCode(expected));
      blocked(w);
      assert.equal(snapshot(w.state, w.auth).overflow.events, true);
      assert.equal(snapshot(w.state, w.auth).writers[0]?.nextSequence, 1);
    }
    const w = world("recordWriterEof", createPmSdkQuiescenceState, 8);
    finish(w);
    assert.equal(snapshot(w.state, w.auth).result.reclaimCandidate, true);
    assert.throws(() => w.state.recordWriterEof(w.auth, { ...w.fact, sequence: 2, completeFrame: 0 }), assertCode("writer_after_eof_preserved"));
    blocked(w);
    assert.equal(snapshot(w.state, w.auth).executionDomainEnded, true);
    assert.equal(snapshot(w.state, w.auth).overflow.events, true);
  });

  function firstErrorInvariant(factory: Factory, first: unknown) {
    const w = world("recordWriterEof", factory, 2);
    let rejected = false, observed: unknown;
    try { w.state.recordWriterEof(w.auth, { ...w.fact, completeFrame: 0 }); } catch (error) { rejected = true; observed = error; }
    assert.equal(rejected, true);
    assert.equal(observed, first);
    blocked(w);
    assert.equal(snapshot(w.state, w.auth).overflow.events, true);
    assert.equal(snapshot(w.state, w.auth).eventCount, 2);
  }
  test("首个拒收异常按原引用保留，诊断日志耗尽不覆盖它", async () => {
    const source = await readFile(new URL("./helpers/pm-sdk-quiescence-state.mjs", import.meta.url), "utf8");
    const anchor = 'if (typeof completeFrame !== "boolean") fail("invalid_writer_eof");';
    assert.equal(source.split(anchor).length, 2);
    let reads = 0;
    const first = Object.create(null) as object;
    Object.defineProperty(first, "message", { get() { reads++; throw new Error("read first error"); } });
    const instrumented = source.replace(anchor, 'if (typeof completeFrame !== "boolean") throw globalThis.__firstReject;');
    for (const value of [first, undefined, null, false, 0, "", NaN]) {
      firstErrorInvariant(instantiateSource(instrumented, { __firstReject: value }), value);
    }
    assert.equal(reads, 0);
    // The deliberately broken diagnostic path must fail the identity assertion, not module loading.
    const logAnchor = 'try { appendEvent("child-stream-rejected", { operation: code }); } catch { /* overflow remains recorded */ }';
    assert.equal(instrumented.split(logAnchor).length, 2);
    const mutant = instantiateSource(instrumented.replace(logAnchor, 'appendEvent("child-stream-rejected", { operation: code });'), { __firstReject: first });
    assert.throws(() => firstErrorInvariant(mutant, first), { code: "ERR_ASSERTION" });
    const markerAnchor = '      protocolDamaged = true;\n      if (writer) writer.damaged = true;\n      // A bounded diagnostic failure cannot replace the first rejection.\n      ' + logAnchor;
    assert.equal(instrumented.split(markerAnchor).length, 2);
    const lateMarker = instantiateSource(instrumented.replace(markerAnchor,
      '      try { appendEvent("child-stream-rejected", { operation: code }); protocolDamaged = true; if (writer) writer.damaged = true; } catch {}'), { __firstReject: first });
    assert.throws(() => firstErrorInvariant(lateMarker, first), { code: "ERR_ASSERTION" });
  });

  test("统一边界变异必须由逻辑断言捕获，不以加载失败冒充", async () => {
    const source = await readFile(new URL("./helpers/pm-sdk-quiescence-state.mjs", import.meta.url), "utf8");
    function rejected(factory: Factory, method: Method, target: "payload" | "auth" | "descriptor" = "payload") {
      const w = world(method, factory);
      let auth: unknown = w.auth;
      if (target === "auth") auth = { ...w.auth, extra: true };
      else if (target === "descriptor") delete w.fact.sequence;
      else w.fact.extra = true;
      assert.throws(() => w.state[method](auth, w.fact));
      blocked(w);
    }
    function badPayload(factory: Factory, method: "bindResource" | "recordWriterEof") {
      const w = world(method, factory);
      w.fact[method === "bindResource" ? "pid" : "completeFrame"] = 0;
      assert.throws(() => w.state[method](w.auth, w.fact));
      blocked(w);
    }
    function badCarrier(factory: Factory) {
      const w = world("recordWriterEof", factory), carrier = Object.assign(function fact() {}, w.fact);
      assert.throws(() => w.state.recordWriterEof(w.auth, carrier));
      blocked(w);
    }
    function isolation(factory: Factory) {
      const w = world("observeResourceClose", factory), before = snapshot(w.state, w.auth);
      assert.throws(() => w.state.observeResourceClose(w.auth, { ...w.fact, handleKey: {}, sequence: NaN }));
      assert.deepEqual(snapshot(w.state, w.auth), before);
    }
    const tests: Array<{ from: string; to: string; check: (factory: Factory) => void }> = methods.map(method => ({
      from: `function ${method}(auth, fact) {\n    return receiveChildFact`,
      to: `function ${method}(auth, fact) {\n    assertExactKeys(fact, [], "unguarded_reject");\n    return receiveChildFact`,
      check: factory => rejected(factory, method),
    }));
    tests.push({
      from: '    /** @type {WriterState | undefined} */\n    let writer;\n    try {',
      to: '    assertExactKeys(auth, ["owner", "epoch"], "invalid_owner_auth");\n    /** @type {WriterState | undefined} */\n    let writer;\n    try {',
      check: factory => rejected(factory, "bindResource", "auth"),
    }, {
      from: '    /** @type {WriterState | undefined} */\n    let writer;\n    try {',
      to: '    identityData(fact, "sequence", code);\n    /** @type {WriterState | undefined} */\n    let writer;\n    try {',
      check: factory => rejected(factory, "recordWriterEof", "descriptor"),
    }, {
      from: 'if (source === "close" && resource !== null && resource.handleKey !== null &&',
      to: 'if (false && resource !== null && resource.handleKey !== null &&',
      check: isolation,
    }, {
      from: 'function bindResource(auth, fact) {\n    return receiveChildFact',
      to: 'function bindResource(auth, fact) {\n    positiveInteger(identityData(fact, "pid", "invalid_resource_pid"), "invalid_resource_pid");\n    return receiveChildFact',
      check: factory => badPayload(factory, "bindResource"),
    }, {
      from: 'function recordWriterEof(auth, fact) {\n    return receiveChildFact',
      to: 'function recordWriterEof(auth, fact) {\n    if (typeof identityData(fact, "completeFrame", "invalid_writer_eof") !== "boolean") fail("invalid_writer_eof");\n    return receiveChildFact',
      check: factory => badPayload(factory, "recordWriterEof"),
    }, {
      from: '    /** @type {WriterState | undefined} */\n    let writer;\n    try {',
      to: '    if (source === "resource" && resource && identityData(fact, "handleKey", code) !== resource.handleKey) fail("wrong_handle_key");\n    /** @type {WriterState | undefined} */\n    let writer;\n    try {',
      check: factory => rejected(factory, "bindResource"),
    }, {
      from: '    /** @type {WriterState | undefined} */\n    let writer;\n    try {',
      to: '    assertRecord(fact, code);\n    /** @type {WriterState | undefined} */\n    let writer;\n    try {',
      check: badCarrier,
    });
    for (const item of tests) {
      item.check(createPmSdkQuiescenceState);
      const mutant = loadMutant(source, item.from, item.to);
      assert.throws(() => item.check(mutant), { code: "ERR_ASSERTION" }, `mutation survived: ${item.from}`);
    }
  });
});

function instantiateSource(source: string, globals: Record<string, unknown> = {}): Factory {
  const executable = source
    .replace("export const PM_SDK_QUIESCENCE_ADAPTER_STATUS", "const PM_SDK_QUIESCENCE_ADAPTER_STATUS")
    .replace("export function createPmSdkQuiescenceState", "function createPmSdkQuiescenceState")
    .concat("\nglobalThis.__factory = createPmSdkQuiescenceState;\n");
  const context: Record<string, unknown> & { __factory?: unknown } = { ...globals };
  runInNewContext(executable, context, { filename: "pm-sdk-quiescence-state.mutant.mjs" });
  if (typeof context.__factory !== "function") throw new Error("mutant_factory_missing");
  return context.__factory as Factory;
}

function loadMutant(source: string, from: string, to: string): Factory {
  const first = source.indexOf(from);
  assert.notEqual(first, -1, `mutation anchor missing: ${from}`);
  assert.equal(source.indexOf(from, first + from.length), -1, `mutation anchor not unique: ${from}`);
  return instantiateSource(source.slice(0, first) + to + source.slice(first + from.length));
}

function invariantReservedBlocks(factory: Factory): void {
  const state = factory(configuration());
  const auth = state.credentials;
  state.beginRun(auth);
  state.beginCase(auth, "normal");
  state.reserveResource(auth, {
    caseId: "normal",
    resourceKey: Object.freeze({}),
    kind: "execution-child",
    writerId: "execution",
    sequence: 1,
  });
  state.recordCaseResult(auth, { caseId: "normal", outcome: "pass", error: { present: false } });
  closeExecution(state, auth);
  eof(state, auth, 2);
  assert.equal(snapshot(state, auth).result.physicalEndCandidate, false);
}

function invariantTimeoutRetainsFailure(factory: Factory): void {
  const state = factory(configuration());
  const auth = state.credentials;
  state.beginRun(auth);
  completeNoResourceRun(state, auth);
  const first = state.requestReclaim(auth);
  state.timeoutReclaim(auth, { attempt: first.attempt });
  const second = state.requestReclaim(auth);
  assert.equal(second.status, "pending");
  assert.equal(second.attempt, first.attempt);
}

function invariantExitZeroNeedsCases(factory: Factory): void {
  const state = factory(configuration());
  const auth = state.credentials;
  state.beginRun(auth);
  closeExecution(state, auth, { kind: "natural", exitCode: 0, signal: null });
  eof(state, auth, 1);
  assert.equal(snapshot(state, auth).result.executionPassCandidate, false);
}

function invariantDetachedGroupBlocks(factory: Factory): void {
  const state = factory(configuration());
  const auth = state.credentials;
  state.beginRun(auth);
  state.beginCase(auth, "normal");
  const key = Object.freeze({});
  const handle = Object.freeze({});
  state.reserveResource(auth, {
    caseId: "normal", resourceKey: key, kind: "detached-group", writerId: "execution", sequence: 1,
  });
  state.bindResource(auth, {
    resourceKey: key, handleKey: handle, pid: 1, writerId: "execution", sequence: 2,
  });
  state.observeResourceClose(auth, {
    resourceKey: key, handleKey: handle, writerId: "execution", sequence: 3,
  });
  state.observeResourceGroup(auth, {
    resourceKey: key, handleKey: handle, groupState: "alive",
  });
  state.recordCaseResult(auth, { caseId: "normal", outcome: "pass", error: { present: false } });
  closeExecution(state, auth);
  eof(state, auth, 4);
  assert.equal(snapshot(state, auth).result.physicalEndCandidate, false);
}

function invariantSelfReportedStoppedRejected(factory: Factory): void {
  const state = factory(configuration({
    expectedCases: [{ id: "normal", stops: [{ id: "host", expectFailureThenRecovery: false }] }],
  }));
  const auth = state.credentials;
  state.beginRun(auth);
  state.beginCase(auth, "normal");
  const request = state.requestStop(auth, { caseId: "normal", stopId: "host" });
  assert.throws(() => state.completeStop(auth, {
    caseId: "normal",
    stopId: "host",
    attempt: request.attempt,
    outcome: "success",
    error: { present: false },
    stopped: true,
  }));
}

function invariantLateResourceAccepted(factory: Factory): void {
  const state = factory(configuration());
  const auth = state.credentials;
  state.beginRun(auth);
  state.beginCase(auth, "normal");
  const key = Object.freeze({});
  const handle = Object.freeze({});
  state.reserveResource(auth, {
    caseId: "normal", resourceKey: key, kind: "execution-child", writerId: "execution", sequence: 1,
  });
  state.recordCaseResult(auth, { caseId: "normal", outcome: "pass", error: { present: false } });
  state.beginClosing(auth, { reason: "late-facts" });
  assert.doesNotThrow(() => {
    state.bindResource(auth, {
      resourceKey: key, handleKey: handle, pid: 4, writerId: "execution", sequence: 2,
    });
    state.observeResourceClose(auth, {
      resourceKey: key, handleKey: handle, writerId: "execution", sequence: 3,
    });
    state.recordExecutionClose(auth, { kind: "natural", exitCode: 0, signal: null });
    state.observeExecutionGroup(auth, { groupState: "gone" });
    eof(state, auth, 4);
  });
  assert.equal(snapshot(state, auth).result.physicalEndCandidate, true);
}

function invariantFalsyErrorRetained(factory: Factory): void {
  const state = factory(configuration());
  const auth = state.credentials;
  state.beginRun(auth);
  state.beginCase(auth, "normal");
  state.recordCaseResult(auth, {
    caseId: "normal", outcome: "failure", error: { present: true, value: 0 },
  });
  assert.equal(Object.is(state.diagnosticErrors(auth)[0]?.value, 0), true);
}

describe("PM SDK quiescence mutation counterexamples", () => {
  test("7种计划内错误实现都被原不变量断言拒绝", async () => {
    const source = await readFile(new URL("./helpers/pm-sdk-quiescence-state.mjs", import.meta.url), "utf8");
    const mutations: Array<{
      name: string;
      from: string;
      to: string;
      invariant: (factory: Factory) => void;
    }> = [
      {
        name: "去掉创建占位阻塞",
        from: 'if (resource.state === "reserved") {\n        const blocker = `resource-unbound:${resource.ordinal}`;',
        to: 'if (false) {\n        const blocker = `resource-unbound:${resource.ordinal}`;',
        invariant: invariantReservedBlocks,
      },
      {
        name: "timeout删除pending",
        from: 'attempt.timeouts += 1;\n    appendEvent("reclaim-timeout", { attempt: attempt.ordinal });',
        to: 'attempt.timeouts += 1;\n    attempt.status = "completed";\n    appendEvent("reclaim-timeout", { attempt: attempt.ordinal });',
        invariant: invariantTimeoutRetainsFailure,
      },
      {
        name: "exit0直接形成execution PASS",
        from: "const executionPassCandidate = casePass && stopPass && normalExecutionEnd;",
        to: "const executionPassCandidate = normalExecutionEnd;",
        invariant: invariantExitZeroNeedsCases,
      },
      {
        name: "忽略detached组",
        from: 'resource.groupState !== "gone"\n      ) {',
        to: 'false\n      ) {',
        invariant: invariantDetachedGroupBlocks,
      },
      {
        name: "接受child自报stopped=true",
        from: 'assertExactKeys(fact, ["caseId", "stopId", "attempt", "outcome", "error"], "invalid_stop_completion");',
        to: 'assertRecord(fact, "invalid_stop_completion");',
        invariant: invariantSelfReportedStoppedRejected,
      },
      {
        name: "丢弃closing后的迟到资源",
        from: "function bindResource(auth, fact) {\n    return receiveChildFact",
        to: 'function bindResource(auth, fact) {\n    if (lifecycle === "closing") return;\n    return receiveChildFact',
        invariant: invariantLateResourceAccepted,
      },
      {
        name: "用truthiness丢失原错误",
        from: "if (!errorRecord.present) return null;",
        to: "if (!errorRecord.value) return null;",
        invariant: invariantFalsyErrorRetained,
      },
    ];

    for (const mutation of mutations) {
      mutation.invariant(createPmSdkQuiescenceState);
      const mutant = loadMutant(source, mutation.from, mutation.to);
      assert.throws(
        () => mutation.invariant(mutant),
        { code: "ERR_ASSERTION" },
        `mutation survived: ${mutation.name}`,
      );
    }
  });
});
