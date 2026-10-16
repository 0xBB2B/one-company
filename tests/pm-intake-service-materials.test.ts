import { afterEach, expect, test, vi } from "vitest";
import { PM_INTAKE_NAMESPACES } from "../src/modules/pm/pm-intake-store.ts";
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

test("可信来源目录：允许非scenario前缀", async () => {
  const fixture = await world();
  fixture.sourceProvider.scenarioIds = ["goal.login"];
  fixture.submissionProvider.mutate = (value) => {
    value.goals = value.goals.filter((item) => !item.sourceRefs.some((ref) => ref.kind === "prd-scenario" && ref.id === "scenario.failure"));
    value.scenarioCoverage = value.scenarioCoverage.filter((item) => item.scenarioId === "goal.login");
  };
  await expect(fixture.intake.openRequest(fixture.call, fixture.operationId())).resolves.toMatchObject({
    sourceDirectory: { requiredScenarioIds: ["goal.login"] }, understandingStatus: "accepted",
  });
});

test("可信来源目录：拒绝正文外场景", async () => {
  const unknown = await world();
  unknown.sourceProvider.scenarioIds = ["not.in.prd"];
  await expect(unknown.intake.openRequest(unknown.call, unknown.operationId())).rejects.toMatchObject({ code: "source_directory_mismatch" });
});

test("可信来源目录：拒绝重复场景", async () => {
  const duplicate = await world();
  duplicate.sourceProvider.scenarioIds = ["goal.login", "goal.login"];
  await expect(duplicate.intake.openRequest(duplicate.call, duplicate.operationId())).rejects.toMatchObject({ code: "source_directory_unavailable" });
});

test("可信来源目录：拒绝遗漏当前问题", async () => {
  const omitted = await world();
  addQuestion(omitted);
  await expect(omitted.intake.openRequest(omitted.call, omitted.operationId())).rejects.toMatchObject({ code: "source_directory_mismatch" });
});

test("可信来源可声明当前全部问题，理解引用按实际问题目录核对", async () => {
  const fixture = await world();
  const questionId = addQuestion(fixture);
  fixture.sourceProvider.questionIds = [questionId];
  fixture.submissionProvider.mutate = (value) => value.unresolved.push({ text: "短信有效期未决", impact: "影响失败等待窗口",
    sourceRefs: [{ kind: "question", id: questionId }] });
  const request = await fixture.intake.openRequest(fixture.call, fixture.operationId());
  expect(request.sourceDirectory.questionIds).toEqual([questionId]);
  expect(request.understanding.unresolved).toEqual(expect.arrayContaining([expect.objectContaining({ sourceRefs: [{ kind: "question", id: questionId }] })]));
});

test("完整返回预算按实际UTF-8序列化计算，超限不截断也不登记", async () => {
  const fixture = await world();
  fixture.submissionProvider.mutate = (value) => { value.goals[0]!.text = "😀".repeat(400); };
  const accepted = await fixture.intake.openRequest(fixture.call, fixture.operationId());
  expect(Buffer.byteLength(JSON.stringify(accepted), "utf8")).toBeLessThanOrEqual(49_152);

  const tooLarge = await world();
  tooLarge.submissionProvider.mutate = (value) => {
    const item = value.goals[0]!;
    value.goals = Array.from({ length: 32 }, (_, index) => ({ ...structuredClone(item), text: `${index}${"\\".repeat(399)}` }));
    value.nonGoals = Array.from({ length: 32 }, () => ({ ...structuredClone(item), text: "\\".repeat(400) }));
    value.constraints = Array.from({ length: 32 }, () => ({ ...structuredClone(item), text: "\\".repeat(400) }));
    value.allowedActions = Array.from({ length: 32 }, () => ({ ...structuredClone(item), text: "\\".repeat(400) }));
  };
  await expect(tooLarge.intake.openRequest(tooLarge.call, tooLarge.operationId())).rejects.toThrow(/resource_limit|response_budget_exceeded/);
  expect(persisted(tooLarge)[PM_INTAKE_NAMESPACES.requests]).toHaveLength(0);
});
