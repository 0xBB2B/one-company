import { afterEach, expect, test, vi } from "vitest";
import { PM_INTAKE_NAMESPACES } from "../runtime/pm-intake-store.ts";
import type { PmSourceDirectoryProvider, PmSubmissionProvider } from "../runtime/pm-intake-service.ts";
import { createPmIntakeFixture } from "./helpers/pm-intake-fixture.ts";
import type { PmIntakeFixture } from "./helpers/pm-intake-fixture.ts";
import { persisted } from "./helpers/pm-intake-service-test-support.ts";

vi.setConfig({ testTimeout: 20_000 });
const clean: PmIntakeFixture[] = [];
afterEach(async () => { for (const fixture of clean.splice(0).reverse()) await fixture.cleanup(); });
async function world(): Promise<PmIntakeFixture> {
  const fixture = await createPmIntakeFixture();
  clean.push(fixture);
  return fixture;
}

test.each([123, true, ["reference"], null, "reference\n"])("公开service拒绝坏类型引用/调用ID而不登记：%j", async (bad) => {
  const fixture = await world();
  const provider: PmSubmissionProvider = {
    loadCurrent: async (query) => {
      const material = await fixture.submissionProvider.loadCurrent(query);
      return material && { ...material, submissionRef: bad } as never;
    },
    assertCurrent: (handle, query) => fixture.submissionProvider.assertCurrent(handle, query),
  };
  const intake = fixture.makeIntake({ submissionProvider: provider });
  const before = persisted(fixture);
  await expect(intake.openRequest(fixture.call, fixture.operationId())).rejects.toThrow();
  expect(persisted(fixture)).toEqual(before);
  const wrongCall = fixture.newCall({ toolCallId: bad } as never);
  await expect(fixture.intake.openRequest(wrongCall, fixture.operationId())).rejects.toThrow();
  expect(persisted(fixture)).toEqual(before);
});

test("OpenAI Responses 类提供方的工具调用编号带竖线（call_x|fc_y），主代理调用与 PM 提交仍可登记与核对", async () => {
  const fixture = await world(), pipe = (id: string) => `call_${id}|fc_06f0ef2dbf4c99ab016ab79d6ffbe487d0be4e78c4bbf775dc`;
  const provider: PmSubmissionProvider = {
    loadCurrent: async (query) => {
      const material = await fixture.submissionProvider.loadCurrent(query);
      return material && { ...material, submissionRef: pipe("pm") };
    },
    assertCurrent: (handle, query) => fixture.submissionProvider.assertCurrent(handle, query),
  };
  const intake = fixture.makeIntake({ submissionProvider: provider });
  const request = await intake.openRequest(fixture.newCall({ toolCallId: pipe("main1") }), fixture.operationId());
  expect(await intake.readRequest(fixture.newCall({ toolCallId: pipe("main2") }), request.requestId)).toEqual(request);
  const review = await intake.recordReview(fixture.newCall({ toolCallId: pipe("main3") }), request.requestId, fixture.operationId(), { result: "passed", shortIssues: [] });
  expect(review).toMatchObject({ record: { result: "passed" } });
});

test.each(["submissionRef", "creator"] as const)("已存request的%s类型损坏，fresh读取及幂等均拒绝", async (field) => {
  const fixture = await world(), operationId = fixture.operationId();
  const view = await fixture.intake.openRequest(fixture.call, operationId);
  fixture.db((db) => {
    const row = db.read<Record<string, unknown>>(PM_INTAKE_NAMESPACES.requests, view.requestId)!;
    db.update(PM_INTAKE_NAMESPACES.requests, view.requestId, row.version, { ...row.data,
      ...(field === "submissionRef" ? { submissionRef: 123 } : { creator: { ...(row.data.creator as object), toolCallId: true } }) });
  });
  const before = persisted(fixture);
  await expect(fixture.intake.readRequest(fixture.call, view.requestId)).rejects.toThrow();
  await expect(fixture.intake.openRequest(fixture.call, operationId)).rejects.toThrow();
  expect(persisted(fixture)).toEqual(before);
});

test("真实批准prod、独立worktree、PM lease和可信provider可登记请求、读取及passed复核", async () => {
  const fixture = await world();
  const beforeRequirement = fixture.state.read(fixture.requirementId);
  const beforeOwner = fixture.db((db) => db.read("pm_ownership", fixture.requirementId));
  const request = await fixture.intake.openRequest(fixture.call, fixture.operationId());
  expect(request).toMatchObject({ understandingStatus: "accepted", uncoveredScenarioIds: [], userAuthorizationCreated: false });
  expect(request).not.toHaveProperty("executionEnabled");
  expect(request).not.toHaveProperty("scheduling");
  expect(request.binding).toMatchObject(fixture.basis);
  expect(request.sourceDirectory).toEqual(fixture.sourceDirectory);
  expect(await fixture.intake.readRequest(fixture.newCall(), request.requestId)).toEqual(request);

  const review = await fixture.intake.recordReview(fixture.newCall(), request.requestId, fixture.operationId(), { result: "passed", shortIssues: [] });
  expect(review).toMatchObject({ record: { requestId: request.requestId, result: "passed" }, userAuthorizationCreated: false });
  expect(review).not.toHaveProperty("executionEnabled");
  expect(review).not.toHaveProperty("scheduling");
  expect(fixture.state.read(fixture.requirementId)).toEqual(beforeRequirement);
  expect(fixture.db((db) => db.read("pm_ownership", fixture.requirementId))).toEqual(beforeOwner);
  const all = persisted(fixture);
  expect(all[PM_INTAKE_NAMESPACES.requests]).toHaveLength(1);
  expect(all[PM_INTAKE_NAMESPACES.reviews]).toHaveLength(1);
  const serialized = JSON.stringify(all);
  expect(serialized).not.toMatch(/输入正确验证码|错误验证码显示失败|understanding|prodBody|transcript|userAuthorizationCreated/);
  expect(fixture.db((db) => db.list("receipts").length)).toBe(0);
});

test("来源handle和Main call不能由同形JSON重建", async () => {
  const fixture = await world();
  const source: PmSourceDirectoryProvider = {
    async loadCurrent(query) {
      const material = await fixture.sourceProvider.loadCurrent(query);
      return material && { ...material, handle: structuredClone(material.handle) };
    },
    assertCurrent: (handle, query) => fixture.sourceProvider.assertCurrent(handle, query),
  };
  await expect(fixture.makeIntake({ sourceDirectoryProvider: source }).openRequest(fixture.call, fixture.operationId())).rejects.toThrow(/source_changed/);
  await expect(fixture.intake.openRequest(structuredClone(fixture.call), fixture.operationId())).rejects.toMatchObject({ code: "untrusted_main_call" });
});
