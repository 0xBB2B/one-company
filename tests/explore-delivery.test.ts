import { afterEach, expect, test, vi } from "vitest";
import { registerExploreDelivery } from "../extensions/agent-manage.ts";
import { registerRequirementInput } from "../extensions/lifecycle.ts";
import { createFakePi } from "./helpers/fake-pi.ts";

afterEach(() => registerRequirementInput(undefined));

test("探索报告塞进主对话之前先撤销已记下的用户原话", async () => {
  const order: string[] = [];
  registerRequirementInput({ revoke: () => { order.push("revoke"); }, noteOpenedItem() {}, mentionNote: () => "" });
  let listener: ((data: Record<string, unknown>) => void) | undefined;
  const client = {
    subscribe: (_event: string, fn: (data: Record<string, unknown>) => void) => { listener = fn; return () => {}; },
    call: async () => ({ summary: "报告" }),
  };
  const fake = createFakePi();
  const pi = { ...fake.pi, sendMessage: vi.fn(() => { order.push("sendMessage"); }) };
  registerExploreDelivery(pi as never, async () => ({ clients: { forRepo: () => client } as never, repoIds: ["repo-a"] }));
  await fake.trigger("session_start", {}, { sessionManager: { getSessionId: () => "session-a" } });
  await vi.waitFor(() => expect(listener).toBeDefined());

  listener!({ runId: "run-1", parentSessionId: "session-a" });
  await vi.waitFor(() => expect(pi.sendMessage).toHaveBeenCalledTimes(1));

  expect(order).toEqual(["revoke", "sendMessage"]);
});
