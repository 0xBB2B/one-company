import { afterEach, expect, test, vi } from "vitest";
import type { ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import { UUID_V7_PATTERN, uuidv7 } from "../src/core/storage/database.ts";
import { checkPmIntakeToolInput, PM_INTAKE_PARAMETERS } from "../src/modules/interaction/main-intake-interaction.ts";
import type { IntakeRequestView } from "../src/modules/pm/pm-intake-service.ts";
import { PM_INTAKE_NAMESPACES } from "../src/modules/pm/pm-intake-store.ts";
import { createPmIntakeFixture } from "./helpers/pm-intake-fixture.ts";
import type { PmIntakeFixture } from "./helpers/pm-intake-fixture.ts";
import { ask, bridgeFor, contentView, ctxFor, executeObserved, forward, observe, reply, resultEvent } from "./helpers/main-intake-test-support.ts";

vi.setConfig({ testTimeout: 30_000 });
const cleanup: PmIntakeFixture[] = [];
afterEach(async () => { for (const fixture of cleanup.splice(0).reverse()) await fixture.cleanup(); });

function operationIdOf(response: Awaited<ReturnType<typeof executeObserved>>["response"]): unknown {
  const view = contentView(response) as unknown as { operationId?: unknown; record?: { operationId?: unknown } };
  return (response.details as { operationId?: unknown }).operationId ?? view.operationId ?? view.record?.operationId;
}

async function world() {
  const fixture = await createPmIntakeFixture();
  cleanup.push(fixture);
  return fixture;
}

test("严格PM参数只允许ask/forward/reply各自白名单", async () => {
  const fixture = await world();
  const valid = [ask(fixture), forward(fixture, uuidv7()), reply(fixture, uuidv7()),
    reply(fixture, uuidv7(), "pm_correction_required")];
  valid.forEach((input) => expect(Value.Check(PM_INTAKE_PARAMETERS, input)).toBe(true));
  for (const key of ["actor", "role", "reviewer", "trusted", "receipt", "understanding", "binding",
    "sourceDirectory", "submissionHash", "savedOperationId", "version"] as const) {
    expect(Value.Check(PM_INTAKE_PARAMETERS, { ...ask(fixture), [key]: "forged" })).toBe(false);
  }
  expect(Value.Check(PM_INTAKE_PARAMETERS, { ...ask(fixture), requestId: uuidv7() })).toBe(false);
  expect(Value.Check(PM_INTAKE_PARAMETERS, { ...forward(fixture, uuidv7()), operationId: uuidv7() })).toBe(false);
  expect(Value.Check(PM_INTAKE_PARAMETERS, { ...ask(fixture), operationId: uuidv7() })).toBe(false);
  expect(Value.Check(PM_INTAKE_PARAMETERS, { ...reply(fixture, uuidv7()), operationId: uuidv7() })).toBe(false);
  expect(Value.Check(PM_INTAKE_PARAMETERS, { ...reply(fixture, uuidv7()), shortIssues: ["😀".repeat(400)] })).toBe(true);
  expect(Value.Check(PM_INTAKE_PARAMETERS, { ...reply(fixture, uuidv7()), shortIssues: ["😀".repeat(401)] })).toBe(false);
  expect(() => checkPmIntakeToolInput({ ...reply(fixture, uuidv7()), shortIssues: ["x".repeat(401)] })).toThrow(/invalid_shape/);
  expect(() => checkPmIntakeToolInput({ ...reply(fixture, uuidv7()), shortIssues: ["😀".repeat(401)] })).toThrow(/invalid_shape/);
  expect(() => checkPmIntakeToolInput({ ...reply(fixture, uuidv7()), shortIssues: ["😀".repeat(400)] })).not.toThrow();
  for (const action of ["toString", "constructor", "__proto__", ...Object.getOwnPropertyNames(Object.prototype)]) {
    expect(() => checkPmIntakeToolInput({ ...ask(fixture), action })).toThrow(/invalid_shape/);
  }
  for (const bad of [null, [], Object.create({ action: "ask" }), { ...ask(fixture), action: "unknown" }]) {
    expect(() => checkPmIntakeToolInput(bad)).toThrow(/invalid_shape/);
  }
});

const ASK_FORWARD_CONTENT_KEYS = ["requestId", "understanding", "understandingStatus", "uncoveredScenarioIds", "decisions"];
const HIDDEN_FROM_CONTENT = ["binding", "submissionRef", "submissionHash", "sourceDirectory", "sourceDirectoryHash",
  "createdAt", "operationId", "userAuthorizationCreated"];

test("原始SDK上下文完成ask、forward、reply：ask、forward的content只含5个字段，完整结果整份在details", async () => {
  const fixture = await world(), { bridge, ctx, signal } = bridgeFor(fixture);
  const askInput = ask(fixture), opened = await executeObserved(bridge, ctx, signal, askInput, "call-ask");
  const openedContent = contentView(opened.response) as unknown as Record<string, unknown>;
  const openedFull = opened.response.details as unknown as IntakeRequestView & { decisions: Array<{ id: string; status: string; unitIds: string[]; conclusion: string }>; operationId: string };
  expect(Object.keys(openedContent).every((key) => ASK_FORWARD_CONTENT_KEYS.includes(key))).toBe(true);
  expect(Object.keys(openedContent)).toEqual(expect.arrayContaining(["requestId", "understanding", "understandingStatus", "uncoveredScenarioIds"]));
  for (const key of HIDDEN_FROM_CONTENT) expect(openedContent).not.toHaveProperty(key);
  expect(openedFull.decisions.length).toBeGreaterThan(0);
  expect(openedContent.decisions).toEqual(openedFull.decisions);
  expect(opened.response.details).not.toHaveProperty("format");
  expect(openedFull).toMatchObject({ requestId: openedContent.requestId, understandingStatus: "accepted", userAuthorizationCreated: false });
  expect(openedFull.binding.repoId).toBe(fixture.repoId);
  expect(openedFull.submissionHash).toMatch(/^[0-9a-f]{64}$/);
  expect(openedFull.sourceDirectoryHash).toMatch(/^[0-9a-f]{64}$/);
  expect(openedFull.operationId).toMatch(UUID_V7_PATTERN);
  expect(openedFull.understanding).toEqual(openedContent.understanding);
  expect(openedFull).not.toHaveProperty("executionEnabled");
  expect(openedFull).not.toHaveProperty("scheduling");
  expect(opened.response.content[0]!.text).toContain("实现手机号登录");
  const notes = openedFull.decisions;
  expect(notes.map((note) => note.id)).toEqual(openedFull.sourceDirectory.decisionIds);
  expect(notes.length > 0 && notes.every((note) => note.status === "confirmed" && note.unitIds.length > 0 && note.conclusion.length > 0)).toBe(true);
  bridge.assertDelivery(resultEvent(opened.id, askInput, opened.response), ctx);
  expect(bridge.ownsDelivery(opened.id)).toBe(true);

  const requestId = openedFull.requestId;
  const forwardInput = forward(fixture, requestId), read = await executeObserved(bridge, ctx, signal, forwardInput, "call-forward");
  const readContent = contentView(read.response) as unknown as Record<string, unknown>;
  const readFull = read.response.details as unknown as IntakeRequestView & { decisions: unknown[] };
  expect(readContent.requestId).toBe(requestId);
  expect(Object.keys(readContent).every((key) => ASK_FORWARD_CONTENT_KEYS.includes(key))).toBe(true);
  for (const key of HIDDEN_FROM_CONTENT) expect(readContent).not.toHaveProperty(key);
  expect(readFull.decisions.length).toBeGreaterThan(0);
  expect(readContent.decisions).toEqual(readFull.decisions);
  expect(readFull).toMatchObject({ requestId, userAuthorizationCreated: false });
  expect(readFull.binding.repoId).toBe(fixture.repoId);
  expect(readFull.submissionHash).toBe(openedFull.submissionHash);
  expect(readFull).not.toHaveProperty("operationId");
  expect(read.response.details).not.toHaveProperty("format");
  bridge.assertDelivery(resultEvent(read.id, forwardInput, read.response), ctx);

  const replyInput = reply(fixture, requestId), reviewed = await executeObserved(bridge, ctx, signal, replyInput, "call-reply");
  expect(contentView(reviewed.response)).toMatchObject({ record: { requestId, result: "passed" },
    userAuthorizationCreated: false });
  expect(reviewed.response.details).toEqual(JSON.parse(reviewed.response.content[0]!.text));
  expect(reviewed.response.details).not.toHaveProperty("format");
  expect(operationIdOf(reviewed.response)).toMatch(UUID_V7_PATTERN);
  bridge.assertDelivery(resultEvent(reviewed.id, replyInput, reviewed.response), ctx);
  expect(fixture.db((db) => db.list(PM_INTAKE_NAMESPACES.requests))).toHaveLength(1);
  expect(fixture.db((db) => db.list(PM_INTAKE_NAMESPACES.reviews))).toHaveLength(1);
  expect(fixture.db((db) => db.list("receipts"))).toHaveLength(0);
  expect(fixture.db((db) => db.list("short_decisions"))).not.toHaveLength(0);
  bridge.dispose();
  bridge.dispose();
});

test("没有tool_call、另一manager、参数后改和另一bridge都不能直接execute", async () => {
  const fixture = await world(), first = bridgeFor(fixture), input = ask(fixture);
  await expect(first.bridge.execute("direct", input, first.ctx, first.signal)).rejects.toMatchObject({ code: "unobserved_tool_call" });

  observe(first.bridge, first.ctx, "mutated", input);
  await expect(first.bridge.execute("mutated", { ...input, requirementId: uuidv7() }, first.ctx, first.signal))
    .rejects.toMatchObject({ code: "unobserved_tool_call" });

  const nextInput = ask(fixture);
  observe(first.bridge, first.ctx, "manager", nextInput);
  const anotherCtx = ctxFor(fixture, first.signal, { getSessionId: () => fixture.identity.sessionId });
  await expect(first.bridge.execute("manager", nextInput, anotherCtx, first.signal)).rejects.toMatchObject({ code: "stale_context" });

  const second = bridgeFor(fixture);
  const cross = ask(fixture);
  observe(first.bridge, first.ctx, "cross", cross);
  await expect(second.bridge.execute("cross", cross, second.ctx, second.signal)).rejects.toMatchObject({ code: "unobserved_tool_call" });
  second.bridge.dispose(); first.bridge.dispose();
});

test("tool_call后置改成原型action仍invalid_shape且不调用业务provider", async () => {
  const fixture = await world(), current = bridgeFor(fixture), valid = ask(fixture);
  let serviceCalls = 0;
  fixture.sourceProvider.loadHook = () => { serviceCalls++; };
  observe(current.bridge, current.ctx, "mutated-action", valid);
  await expect(current.bridge.execute("mutated-action", { ...valid, action: "toString" }, current.ctx, current.signal))
    .rejects.toMatchObject({ code: "invalid_shape" });
  expect(serviceCalls).toBe(0);
  current.bridge.completeToolExecution({ toolName: "one_company_user_interact", toolCallId: "mutated-action" });
  current.bridge.dispose();
});

test("伪Main字段和PM自填passed都拒绝", async () => {
  const fixture = await world(), current = bridgeFor(fixture), valid = ask(fixture);
  for (const patch of [{ role: "main" }, { actor: "user" }, { trusted: true }, { receipt: uuidv7() },
    { reviewer: { windowId: fixture.identity.windowId } }]) {
    expect(() => current.bridge.observeToolCall({ toolName: "one_company_user_interact", toolCallId: uuidv7(),
      input: { request: { ...valid, ...patch } } } as unknown as ToolCallEvent, current.ctx)).toThrow(/invalid_shape/);
  }
  current.bridge.dispose();
});

