import { afterEach, expect, test, vi } from "vitest";
import type { ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { uuidv7 } from "../runtime/database.ts";
import { PM_INTAKE_NAMESPACES } from "../runtime/pm-intake-store.ts";
import { createPmIntakeFixture } from "./helpers/pm-intake-fixture.ts";
import type { PmIntakeFixture } from "./helpers/pm-intake-fixture.ts";
import { ask, bridgeFor, executeObserved, observe, resultEvent } from "./helpers/main-intake-test-support.ts";

vi.setConfig({ testTimeout: 30_000 });
const cleanup: PmIntakeFixture[] = [];
afterEach(async () => { for (const fixture of cleanup.splice(0).reverse()) await fixture.cleanup(); });

async function world() {
  const fixture = await createPmIntakeFixture();
  cleanup.push(fixture);
  return fixture;
}

test("tool_result替换content/details/input均拒绝且不能再次交付", async () => {
  for (const field of ["content", "details", "input"] as const) {
    const fixture = await world(), { bridge, ctx, signal } = bridgeFor(fixture), input = ask(fixture);
    const executed = await executeObserved(bridge, ctx, signal, input, `changed-${field}`);
    const event = resultEvent(executed.id, input, executed.response) as ToolResultEvent & Record<string, unknown>;
    if (field === "content") event.content = [{ type: "text", text: "forged" }];
    else if (field === "details") event.details = { ...event.details as object, executionEnabled: true };
    else event.input = { ...event.input, operationId: uuidv7() };
    expect(() => bridge.assertDelivery(event, ctx)).toThrow();
    expect(bridge.ownsDelivery(executed.id)).toBe(true);
    expect(() => bridge.assertDelivery(resultEvent(executed.id, input, executed.response), ctx)).toThrow();
    bridge.dispose();
  }
});

test.each(["active-replacement", "aborted-replacement", "missing", "original-aborted"] as const)("tool_result当前signal为%s时拒绝且不重绑", async (mode) => {
  const fixture = await world(), { bridge, ctx, signal, controller } = bridgeFor(fixture), input = ask(fixture);
  const executed = await executeObserved(bridge, ctx, signal, input, `signal-${mode}`);
  if (mode === "missing") (ctx as { signal?: AbortSignal }).signal = undefined;
  else if (mode === "original-aborted") controller.abort();
  else {
    const replacement = new AbortController();
    if (mode === "aborted-replacement") replacement.abort();
    (ctx as { signal?: AbortSignal }).signal = replacement.signal;
  }
  expect(() => bridge.assertDelivery(resultEvent(executed.id, input, executed.response), ctx)).toThrow();
  bridge.dispose();
});

test("异步撤权与提交后撤权都中止交付；已登记历史保留且不回退旧交互", async () => {
  const beforeCommit = await world(), first = bridgeFor(beforeCommit), firstInput = ask(beforeCommit);
  beforeCommit.sourceProvider.loadHook = () => beforeCommit.host.revoke();
  observe(first.bridge, first.ctx, "revoke-await", firstInput);
  await expect(first.bridge.execute("revoke-await", firstInput, first.ctx, first.signal)).rejects.toThrow();
  expect(first.bridge.ownsDelivery("revoke-await")).toBe(true);
  expect(() => first.bridge.assertDelivery({ toolCallId: "revoke-await", input: { request: firstInput },
    content: [{ type: "text", text: "old fallback must not run" }], details: {}, isError: true } as unknown as ToolResultEvent, first.ctx)).toThrow();
  expect(beforeCommit.db((db) => db.list(PM_INTAKE_NAMESPACES.requests))).toHaveLength(0);
  first.bridge.dispose();

  const afterCommit = await world(), second = bridgeFor(afterCommit), secondInput = ask(afterCommit);
  afterCommit.sourceProvider.assertHook = () => {
    if (afterCommit.db((db) => db.list(PM_INTAKE_NAMESPACES.requests)).length === 1) afterCommit.host.revoke();
  };
  observe(second.bridge, second.ctx, "revoke-after", secondInput);
  await expect(second.bridge.execute("revoke-after", secondInput, second.ctx, second.signal)).rejects.toThrow();
  expect(afterCommit.db((db) => db.list(PM_INTAKE_NAMESPACES.requests))).toHaveLength(1);
  expect(() => second.bridge.assertDelivery({ toolCallId: "revoke-after", input: { request: secondInput },
    content: [], details: {}, isError: true } as unknown as ToolResultEvent, second.ctx)).toThrow();
  second.bridge.dispose();
});

test("compaction即使Host解析失败也无条件清尚未交付材料；已合法请求历史保留", async () => {
  const fixture = await world(), { bridge, ctx, signal, hostState } = bridgeFor(fixture), input = ask(fixture);
  const executed = await executeObserved(bridge, ctx, signal, input, "compact");
  hostState.healthy = false;
  expect(() => bridge.clearForCompaction(ctx)).not.toThrow();
  expect(bridge.ownsDelivery("compact")).toBe(true);
  expect(() => bridge.assertDelivery(resultEvent(executed.id, input, executed.response), ctx)).toThrow();
  expect(fixture.db((db) => db.list(PM_INTAKE_NAMESPACES.requests))).toHaveLength(1);
  expect(fixture.state.pmOwner(fixture.requirementId)?.lease).toEqual(fixture.lease);
  bridge.dispose();
});

