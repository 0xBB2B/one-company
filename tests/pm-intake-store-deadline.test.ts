import { afterEach, expect, test, vi } from "vitest";
import { PmIntakeService } from "../runtime/pm-intake-service.ts";
import { PmIntakeStore, PM_INTAKE_NAMESPACES } from "../runtime/pm-intake-store.ts";
import { createPmIntakeFixture } from "./helpers/pm-intake-fixture.ts";
import type { PmIntakeFixture } from "./helpers/pm-intake-fixture.ts";
import { counts, finalWorkPause, requestInput, reviewRecord } from "./helpers/pm-intake-store-test-support.ts";

vi.setConfig({ testTimeout: 20_000 });
const clean: PmIntakeFixture[] = [];
afterEach(async () => { for (const fixture of clean.splice(0).reverse()) await fixture.cleanup(); });
async function world(): Promise<PmIntakeFixture> { const fixture = await createPmIntakeFixture(); clean.push(fixture); return fixture; }

test.each(["request", "review", "clone-tail"] as const)("最后DB或clone跨Main单调deadline时%s零新增", async (mode) => {
  const fixture = await world();
  const existing = mode === "review"
    ? fixture.intakeStore.commitRequest(fixture.intakeStore.prepareRequest(requestInput(fixture, fixture.captureCurrent().proof)), () => {})
    : undefined;
  const store = new PmIntakeStore({ dataRoot: fixture.dataRoot, repoId: fixture.repoId, now: () => Date.now(),
    deadlineMonotonic: performance.now() + 500 });
  const captured = store.captureCurrent(fixture.basis, fixture.sourceDirectory);
  const prepared = mode === "review"
    ? store.prepareReview({ operationId: fixture.operationId(), proof: captured.proof,
      record: reviewRecord(fixture, captured.binding, existing!.record.requestId) })
    : store.prepareRequest(requestInput(fixture, captured.proof));
  const before = counts(fixture), observed = { reads: 0, paused: false };
  const run = () => mode === "review" ? store.commitReview(prepared as never, () => {})
    : store.commitRequest(prepared as never, () => {});
  expect(() => finalWorkPause(run, 650, observed, mode === "clone-tail")).toThrow(/main_deadline_elapsed/);
  expect(observed.paused).toBe(true);
  expect(counts(fixture)).toEqual(before);
});

test("Main deadline参数只接受有限非负值，外部store与deadline无绑定协议时明确拒绝", async () => {
  const fixture = await world();
  for (const deadlineMonotonic of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
    expect(() => new PmIntakeStore({ dataRoot: fixture.dataRoot, repoId: fixture.repoId, deadlineMonotonic })).toThrow(/invalid_deadline/);
  }
  expect(() => new PmIntakeService({ dataRoot: fixture.dataRoot, repoId: fixture.repoId, state: fixture.state,
    requirementService: fixture.service, authorization: fixture.host, store: fixture.intakeStore,
    deadlineMonotonic: performance.now() + 1_000 })).toThrow(/deadline_store_binding_unsupported/);
});

