import { afterEach, expect, test, vi } from "vitest";
import { PM_INTAKE_NAMESPACES } from "../runtime/pm-intake-store.ts";
import type { RequirementService } from "../runtime/requirement-service.ts";
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

test("取消检查只读取原生AbortSignal，不执行伪信号的getter", async () => {
  const fixture = await world(); let reads = 0;
  const forged = { get aborted() { reads++; addQuestion(fixture); return false; } } as AbortSignal;
  await expect(fixture.intake.openRequest(fixture.call, fixture.operationId(), forged)).rejects.toMatchObject({ code: "invalid_signal" });
  expect(reads).toBe(0);
  expect(fixture.db((db) => db.list("interaction_questions_v1"))).toHaveLength(0);
});

test("每个异步边界后都检查取消，即使provider忽略signal仍不得登记", async () => {
  const sourceRace = await world();
  const sourceAbort = new AbortController();
  sourceRace.sourceProvider.loadHook = () => sourceAbort.abort();
  await expect(sourceRace.intake.openRequest(sourceRace.call, sourceRace.operationId(), sourceAbort.signal))
    .rejects.toMatchObject({ code: "operation_cancelled" });

  const submissionRace = await world();
  const submissionAbort = new AbortController();
  submissionRace.submissionProvider.loadHook = () => submissionAbort.abort();
  await expect(submissionRace.intake.openRequest(submissionRace.call, submissionRace.operationId(), submissionAbort.signal))
    .rejects.toMatchObject({ code: "operation_cancelled" });

  const readRace = await world();
  const readAbort = new AbortController();
  const service = { read: async (...args: Parameters<RequirementService["read"]>) => {
    const result = await readRace.service.read(...args); readAbort.abort(); return result;
  } } as unknown as RequirementService;
  await expect(readRace.makeIntake({ requirementService: service }).openRequest(readRace.call, readRace.operationId(), readAbort.signal))
    .rejects.toMatchObject({ code: "operation_cancelled" });

  for (const fixture of [sourceRace, submissionRace, readRace]) {
    expect(persisted(fixture)[PM_INTAKE_NAMESPACES.requests]).toHaveLength(0);
  }
});

test("Host撤权后即使重建相同window/session/需求绑定也不能取得原调用身份", async () => {
  const fixture = await world();
  fixture.sourceProvider.loadHook = () => {
    fixture.host.revoke();
    fixture.host.startWindow({ kind: "main", windowId: fixture.identity.windowId, sessionId: fixture.identity.sessionId, repoIds: [fixture.repoId] });
    fixture.host.bindRequirement(fixture.repoId, fixture.requirementId, fixture.identity.sessionId);
  };
  await expect(fixture.intake.openRequest(fixture.call, fixture.operationId())).rejects.toMatchObject({ code: "main_call_changed" });
  expect(persisted(fixture)[PM_INTAKE_NAMESPACES.requests]).toHaveLength(0);
});

test("提交后到最终交付前取消会保留已登记事实，但拒绝返回", async () => {
  const fixture = await world();
  const controller = new AbortController();
  fixture.sourceProvider.assertHook = () => {
    if (persisted(fixture)[PM_INTAKE_NAMESPACES.requests].length === 1) controller.abort();
  };
  await expect(fixture.intake.openRequest(fixture.call, fixture.operationId(), controller.signal))
    .rejects.toMatchObject({ code: "operation_cancelled" });
  expect(persisted(fixture)[PM_INTAKE_NAMESPACES.requests]).toHaveLength(1);
  expect(persisted(fixture)[PM_INTAKE_NAMESPACES.reviews]).toHaveLength(0);
});
