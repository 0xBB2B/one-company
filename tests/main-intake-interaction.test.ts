import { afterEach, expect, test, vi } from "vitest";
import type { ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import { uuidv7 } from "../runtime/database.ts";
import { checkPmIntakeToolInput, PM_INTAKE_PARAMETERS } from "../runtime/main-intake-interaction.ts";
import type { IntakeRequestView } from "../runtime/pm-intake-service.ts";
import { PM_INTAKE_NAMESPACES } from "../runtime/pm-intake-store.ts";
import { createPmIntakeFixture } from "./helpers/pm-intake-fixture.ts";
import type { PmIntakeFixture } from "./helpers/pm-intake-fixture.ts";
import { ask, bridgeFor, contentView, ctxFor, executeObserved, forward, observe, reply, resultEvent } from "./helpers/main-intake-test-support.ts";

vi.setConfig({ testTimeout: 30_000 });
const cleanup: PmIntakeFixture[] = [];
afterEach(async () => { for (const fixture of cleanup.splice(0).reverse()) await fixture.cleanup(); });

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

test("原始SDK上下文完成ask、forward、reply，完整理解只在模型可见content且不产生用户授权", async () => {
  const fixture = await world(), { bridge, ctx, signal } = bridgeFor(fixture);
  const askInput = ask(fixture), opened = await executeObserved(bridge, ctx, signal, askInput, "call-ask");
  const openedView = contentView(opened.response) as IntakeRequestView;
  expect(openedView).toMatchObject({ understandingStatus: "accepted", executionEnabled: false,
    scheduling: "not_implemented", userAuthorizationCreated: false });
  expect(opened.response.details).toEqual({ format: "pm-intake-transport/v1", action: "ask" });
  expect(opened.response.content[0]!.text).toContain("实现手机号登录");
  const notes = (openedView as IntakeRequestView & { decisions: Array<{ id: string; status: string; unitIds: string[]; conclusion: string }> }).decisions;
  expect(notes.map((note) => note.id)).toEqual(openedView.sourceDirectory.decisionIds);
  expect(notes.length > 0 && notes.every((note) => note.status === "confirmed" && note.unitIds.length > 0 && note.conclusion.length > 0)).toBe(true);
  expect(JSON.stringify(opened.response.details)).not.toContain("实现手机号登录");
  bridge.assertDelivery(resultEvent(opened.id, askInput, opened.response), ctx);
  expect(bridge.ownsDelivery(opened.id)).toBe(true);

  const requestId = openedView.requestId;
  const forwardInput = forward(fixture, requestId), read = await executeObserved(bridge, ctx, signal, forwardInput, "call-forward");
  expect((contentView(read.response) as IntakeRequestView).requestId).toBe(requestId);
  bridge.assertDelivery(resultEvent(read.id, forwardInput, read.response), ctx);

  const replyInput = reply(fixture, requestId), reviewed = await executeObserved(bridge, ctx, signal, replyInput, "call-reply");
  expect(contentView(reviewed.response)).toMatchObject({ record: { requestId, result: "passed" },
    userAuthorizationCreated: false, executionEnabled: false });
  expect(reviewed.response.details).toEqual({ format: "pm-intake-transport/v1", action: "reply" });
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
  await expect(first.bridge.execute("mutated", { ...input, operationId: uuidv7() }, first.ctx, first.signal))
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
  current.bridge.completeToolExecution({ toolName: "pi_company_user_interact", toolCallId: "mutated-action" });
  current.bridge.dispose();
});

test("需求未选、伪Main字段、PM自填passed和缺省provider都拒绝", async () => {
  const fixture = await world(), current = bridgeFor(fixture), valid = ask(fixture);
  for (const patch of [{ role: "main" }, { actor: "user" }, { trusted: true }, { receipt: uuidv7() },
    { reviewer: { windowId: fixture.identity.windowId } }]) {
    expect(() => current.bridge.observeToolCall({ toolName: "pi_company_user_interact", toolCallId: uuidv7(),
      input: { request: { ...valid, ...patch } } } as unknown as ToolCallEvent, current.ctx)).toThrow(/invalid_shape/);
  }
  current.bridge.dispose();

  const unbound = bridgeFor(fixture);
  fixture.host.bindRequirement(fixture.repoId, uuidv7(), fixture.identity.sessionId);
  expect(() => observe(unbound.bridge, unbound.ctx, "unbound", valid)).toThrow();
  unbound.bridge.dispose();

  fixture.host.startWindow({ kind: "main", windowId: fixture.identity.windowId,
    sessionId: fixture.identity.sessionId, repoIds: [fixture.repoId] });
  fixture.host.bindRequirement(fixture.repoId, fixture.requirementId, fixture.identity.sessionId);
  const noProvider = bridgeFor(fixture, undefined, false), missing = ask(fixture);
  observe(noProvider.bridge, noProvider.ctx, "missing-provider", missing);
  await expect(noProvider.bridge.execute("missing-provider", missing, noProvider.ctx, noProvider.signal))
    .rejects.toMatchObject({ code: "source_directory_provider_unavailable" });
  noProvider.bridge.dispose();
});

