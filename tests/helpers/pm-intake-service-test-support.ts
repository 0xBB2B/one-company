import { uuidv7 } from "../../runtime/database.ts";
import { PM_INTAKE_NAMESPACES } from "../../runtime/pm-intake-store.ts";
import type { PmIntakeFixture } from "./pm-intake-fixture.ts";

export function addQuestion(fixture: PmIntakeFixture, requestId = uuidv7()): string {
  const current = fixture.state.read(fixture.requirementId);
  fixture.db((db) => db.transaction(() => db.create("interaction_questions_v1", requestId, {
    format: "interaction-question/v1",
    requestId,
    repoId: fixture.repoId,
    basis: { requirementId: fixture.requirementId, version: current.version, epoch: current.data.epoch, prod: current.data.approved },
    candidate: null,
    proposal: { conclusion: "短信有效期是多少", scope: "验证码失败场景", references: [], supersedes: [] },
    actions: [],
    createdAt: current.data.updatedAt,
  }, requestId)));
  return requestId;
}

export function persisted(fixture: PmIntakeFixture): Record<string, unknown[]> {
  return fixture.db((db) => Object.fromEntries(Object.values(PM_INTAKE_NAMESPACES).map((namespace) =>
    [namespace, db.list(namespace).map((row) => row.data)])));
}
