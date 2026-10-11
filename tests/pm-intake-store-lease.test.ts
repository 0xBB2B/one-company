import { afterEach, expect, test, vi } from "vitest";
import { PmIntakeStore, PM_INTAKE_NAMESPACES } from "../runtime/pm-intake-store.ts";
import { createPmIntakeFixture } from "./helpers/pm-intake-fixture.ts";
import type { PmIntakeFixture } from "./helpers/pm-intake-fixture.ts";
import { counts, finalWorkPause, requestInput, reviewRecord } from "./helpers/pm-intake-store-test-support.ts";

vi.setConfig({ testTimeout: 20_000 });
const clean: PmIntakeFixture[] = [];
afterEach(async () => { for (const fixture of clean.splice(0).reverse()) await fixture.cleanup(); });
async function world(): Promise<PmIntakeFixture> { const fixture = await createPmIntakeFixture(); clean.push(fixture); return fixture; }

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

