import { expect } from "vitest";
import type { ExtensionContext, ToolCallEvent, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { uuidv7 } from "../../runtime/database.ts";
import { MainIntakeInteraction } from "../../runtime/main-intake-interaction.ts";
import type { PmIntakeToolInput } from "../../runtime/main-intake-interaction.ts";
import type { IntakeRequestView } from "../../runtime/pm-intake-service.ts";
import type { PmIntakeFixture } from "./pm-intake-fixture.ts";

export function ctxFor(fixture: PmIntakeFixture, signal: AbortSignal, manager: object = {
  getSessionId: () => fixture.identity.sessionId,
}): ExtensionContext {
  const path = fixture.state.read(fixture.requirementId).data.workspace!.path;
  return {
    sessionManager: manager,
    cwd: path,
    mode: "rpc",
    signal,
  } as unknown as ExtensionContext;
}

export function bridgeFor(fixture: PmIntakeFixture, ttl?: number) {
  const controller = new AbortController(), signal = controller.signal;
  const manager = { getSessionId: () => fixture.identity.sessionId };
  const ctx = ctxFor(fixture, signal, manager);
  const path = fixture.state.read(fixture.requirementId).data.workspace!.path, hostState = { healthy: true };
  const bridge = new MainIntakeInteraction({ dataRoot: fixture.dataRoot,
    authorization: fixture.host, callTtlMs: ttl,
    resolveHost: () => {
      if (!hostState.healthy) throw new Error("host_unavailable");
      return { windowId: fixture.identity.windowId, sessionId: fixture.identity.sessionId,
        repositories: new Map([[fixture.repoId, { path }]]) };
    },
    providers: { sourceDirectoryProvider: fixture.sourceProvider, submissionProvider: fixture.submissionProvider } });
  bridge.startSession(ctx);
  return { bridge, ctx, signal, controller, manager, hostState };
}

export function ask(fixture: PmIntakeFixture): PmIntakeToolInput {
  return { purpose: "pm-intake", action: "ask", repoId: fixture.repoId,
    requirementId: fixture.requirementId, operationId: uuidv7() };
}
export function forward(fixture: PmIntakeFixture, requestId: string): PmIntakeToolInput {
  return { purpose: "pm-intake", action: "forward", repoId: fixture.repoId,
    requirementId: fixture.requirementId, requestId };
}
export function reply(fixture: PmIntakeFixture, requestId: string, result: "passed" | "pm_correction_required" = "passed"): PmIntakeToolInput {
  return { purpose: "pm-intake", action: "reply", repoId: fixture.repoId,
    requirementId: fixture.requirementId, requestId, operationId: uuidv7(), result,
    shortIssues: result === "passed" ? [] : ["目标A理解有偏差"] };
}
export function observe(bridge: MainIntakeInteraction, ctx: ExtensionContext, id: string, input: PmIntakeToolInput) {
  bridge.observeToolCall({ toolName: "one_company_user_interact", toolCallId: id,
    input: { request: input } } as ToolCallEvent, ctx);
}
export function resultEvent(id: string, input: PmIntakeToolInput, response: Awaited<ReturnType<MainIntakeInteraction["execute"]>>): ToolResultEvent {
  return { type: "tool_result", toolName: "one_company_user_interact", toolCallId: id,
    input: { request: input }, content: response.content, details: response.details,
    isError: false } as ToolResultEvent;
}

export function contentView(response: Awaited<ReturnType<MainIntakeInteraction["execute"]>>): IntakeRequestView | { record: { requestId: string; result: string } } {
  expect(response.content).toHaveLength(1);
  expect(response.content[0]?.type).toBe("text");
  return JSON.parse(response.content[0]!.text) as IntakeRequestView | { record: { requestId: string; result: string } };
}

export async function executeObserved(bridge: MainIntakeInteraction, ctx: ExtensionContext, signal: AbortSignal,
  input: PmIntakeToolInput, id = uuidv7()) {
  observe(bridge, ctx, id, input);
  const response = await bridge.execute(id, input, ctx, signal);
  return { id, response };
}
