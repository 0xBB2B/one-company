import { afterEach, expect, test, vi } from "vitest";
import { uuidv7 } from "../runtime/database.ts";
import { PmIntakeStore, PM_INTAKE_NAMESPACES } from "../runtime/pm-intake-store.ts";
import { PmIntakeService } from "../runtime/pm-intake-service.ts";
import type { PmSourceDirectoryProvider, PmSubmissionProvider } from "../runtime/pm-intake-service.ts";
import { createPmIntakeFixture } from "./helpers/pm-intake-fixture.ts";
import type { PmIntakeFixture } from "./helpers/pm-intake-fixture.ts";
import { addQuestion, persisted } from "./helpers/pm-intake-service-test-support.ts";

vi.setConfig({ testTimeout: 20_000 });
const clean: PmIntakeFixture[] = [];
afterEach(async () => { for (const fixture of clean.splice(0).reverse()) await fixture.cleanup(); });
async function world(): Promise<PmIntakeFixture> {
  const fixture = await createPmIntakeFixture();
  clean.push(fixture);
  return fixture;
}

test.each(["open", "read", "review"] as const)("%s最后DB核验之后不再调用可变Main resolver", async (mode) => {
  const fixture = await world();
  const request = mode === "open" ? undefined : await fixture.intake.openRequest(fixture.call, fixture.operationId());
  let checks = 0, finalChecked = false, lateResolverCalls = 0;
  class ObservedStore extends PmIntakeStore {
    override assertReturnCurrent(...args: Parameters<PmIntakeStore["assertReturnCurrent"]>) {
      super.assertReturnCurrent(...args);
      if (++checks === 2) finalChecked = true;
    }
  }
  const store = new ObservedStore({ dataRoot: fixture.dataRoot, repoId: fixture.repoId });
  const intake = new PmIntakeService({ dataRoot: fixture.dataRoot, repoId: fixture.repoId, state: fixture.state,
    requirementService: fixture.service, authorization: fixture.host, store,
    sourceDirectoryProvider: fixture.sourceProvider, submissionProvider: fixture.submissionProvider,
    mainCallResolver: { resolve(call) {
      if (finalChecked) { lateResolverCalls++; addQuestion(fixture); }
      return call === fixture.call ? fixture.identity : null;
    } } });
  if (mode === "open") await intake.openRequest(fixture.call, fixture.operationId());
  else if (mode === "read") await intake.readRequest(fixture.call, request!.requestId);
  else await intake.recordReview(fixture.call, request!.requestId, fixture.operationId(), { result: "passed", shortIssues: [] });
  expect(finalChecked).toBe(true); expect(lateResolverCalls).toBe(0);
  expect(fixture.db((db) => db.list("interaction_questions_v1"))).toHaveLength(0);
});

test("逐个provider最终断言必须同步，外层void不能吞掉Promise", async () => {
  const sourceFixture = await world();
  const asyncSource: PmSourceDirectoryProvider = {
    loadCurrent: (query) => sourceFixture.sourceProvider.loadCurrent(query),
    assertCurrent: (() => Promise.resolve()) as unknown as PmSourceDirectoryProvider["assertCurrent"],
  };
  await expect(sourceFixture.makeIntake({ sourceDirectoryProvider: asyncSource }).openRequest(sourceFixture.call, sourceFixture.operationId()))
    .rejects.toMatchObject({ code: "async_source_directory_assertion" });

  const submissionFixture = await world();
  const asyncSubmission: PmSubmissionProvider = {
    loadCurrent: (query) => submissionFixture.submissionProvider.loadCurrent(query),
    assertCurrent: (() => Promise.resolve()) as unknown as PmSubmissionProvider["assertCurrent"],
  };
  await expect(submissionFixture.makeIntake({ submissionProvider: asyncSubmission }).openRequest(submissionFixture.call, submissionFixture.operationId()))
    .rejects.toMatchObject({ code: "async_submission_assertion" });
});

test("最终回调增加问题或取代决定时，即使requirement version不变也拒绝且不留请求", async () => {
  for (const mutation of ["question", "decision"] as const) {
    const fixture = await world();
    const requirementVersion = fixture.state.read(fixture.requirementId).version;
    let changed = false;
    fixture.sourceProvider.assertHook = () => {
      if (changed) return;
      changed = true;
      if (mutation === "question") addQuestion(fixture);
      else fixture.db((db) => db.transaction(() => {
        const id = fixture.manifest.actions[0]!.decisionIds[0]!, row = db.read<Record<string, unknown>>("short_decisions", id)!;
        db.update("short_decisions", id, row.version, { ...row.data, status: "superseded", supersededBy: uuidv7() });
      }));
    };
    await expect(fixture.intake.openRequest(fixture.call, fixture.operationId())).rejects.toThrow();
    expect(fixture.state.read(fixture.requirementId).version).toBe(requirementVersion);
    expect(persisted(fixture)[PM_INTAKE_NAMESPACES.requests]).toHaveLength(0);
  }
});
