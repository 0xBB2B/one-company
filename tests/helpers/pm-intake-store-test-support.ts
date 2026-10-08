import { vi } from "vitest";
import { LocalDatabase, uuidv7 } from "../../runtime/database.ts";
import { PM_INTAKE_NAMESPACES } from "../../runtime/pm-intake-store.ts";
import type { IntakeCurrentProof } from "../../runtime/pm-intake-store.ts";
import type { IntakeBinding, IntakeReviewRecord } from "../../runtime/pm-intake-contracts.ts";
import type { PmIntakeFixture } from "./pm-intake-fixture.ts";

export const hash = (value: string) => value.repeat(64);

export function requestInput(fixture: PmIntakeFixture, proof: IntakeCurrentProof, operationId = fixture.operationId(), patch: Record<string, unknown> = {}) {
  return { operationId, proof, submissionRef: "pm/submission/current", submissionHash: hash("a"),
    creator: { windowId: fixture.identity.windowId, sessionId: fixture.identity.sessionId, toolCallId: fixture.operationId() }, ...patch };
}

export function reviewRecord(fixture: PmIntakeFixture, binding: IntakeBinding, requestId: string, patch: Partial<IntakeReviewRecord> = {}): IntakeReviewRecord {
  return { format: "pm-intake-review/v1", reviewId: uuidv7(), requestId, binding,
    submissionRef: "pm/submission/current", submissionHash: hash("a"),
    reviewer: { windowId: fixture.identity.windowId, sessionId: fixture.identity.sessionId, toolCallId: fixture.operationId() },
    result: "passed", sourceRefs: [{ kind: "prod-unit", id: "goal.login" }], shortIssues: [], ...patch };
}

export function counts(fixture: PmIntakeFixture) {
  return fixture.db((db) => Object.fromEntries(Object.values(PM_INTAKE_NAMESPACES).map((namespace) => [namespace, db.list(namespace).length])));
}

export function finalWorkPause(run: () => unknown, milliseconds: number, observed: { reads: number; paused: boolean }, cloneTail = false): unknown {
  const read = LocalDatabase.prototype.read, list = LocalDatabase.prototype.list, copy = globalThis.structuredClone;
  const pause = () => {
    if (observed.reads >= 1 && !observed.paused) {
      observed.paused = true;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
    }
  };
  const readSpy = vi.spyOn(LocalDatabase.prototype, "read").mockImplementation(function (this: LocalDatabase, namespace, key) {
    const result = Reflect.apply(read, this, [namespace, key]);
    if (namespace === "pm_ownership") observed.reads++;
    return result;
  });
  const listSpy = vi.spyOn(LocalDatabase.prototype, "list").mockImplementation(function (this: LocalDatabase, namespace) {
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
