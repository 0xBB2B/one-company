import { uuidv7 } from "../../src/core/storage/database.ts";
import { PM_INTAKE_NAMESPACES } from "../../src/modules/pm/pm-intake-store.ts";
import type { IntakeCurrentProof } from "../../src/modules/pm/pm-intake-store.ts";
import type { IntakeBinding, IntakeReviewRecord } from "../../src/modules/pm/pm-intake-contracts.ts";
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
