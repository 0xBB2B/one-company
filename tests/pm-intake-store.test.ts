import { afterEach, expect, test, vi } from "vitest";
import { uuidv7 } from "../runtime/database.ts";
import { PM_INTAKE_NAMESPACES } from "../runtime/pm-intake-store.ts";
import { createPmIntakeFixture } from "./helpers/pm-intake-fixture.ts";
import type { PmIntakeFixture } from "./helpers/pm-intake-fixture.ts";
import { counts, hash, requestInput } from "./helpers/pm-intake-store-test-support.ts";

vi.setConfig({ testTimeout: 20_000 });
const clean: PmIntakeFixture[] = [];
afterEach(async () => { for (const fixture of clean.splice(0).reverse()) await fixture.cleanup(); });
async function world(): Promise<PmIntakeFixture> { const fixture = await createPmIntakeFixture(); clean.push(fixture); return fixture; }

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
