import { afterEach, expect, test, vi } from "vitest";
import type { ExtensionContext, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { uuidv7 } from "../src/core/storage/database.ts";
import { HostAuthorizationManager } from "../src/modules/requirement/host-authorization.ts";
import { checkPmUnderstanding } from "../src/modules/pm/pm-intake-contracts.ts";
import type { PmUnderstanding } from "../src/modules/pm/pm-intake-contracts.ts";
import { createPmIntakeToolResponse, MainIntakeInteraction } from "../src/modules/interaction/main-intake-interaction.ts";
import type { PmIntakeToolInput } from "../src/modules/interaction/main-intake-interaction.ts";
import type { IntakeRequestView } from "../src/modules/pm/pm-intake-service.ts";
import { PM_INTAKE_NAMESPACES } from "../src/modules/pm/pm-intake-store.ts";
import { PmIntakeService } from "../src/modules/pm/pm-intake-service.ts";
import { RequirementService } from "../src/modules/requirement/requirement-service.ts";
import { RequirementStateStore } from "../src/modules/requirement/requirement-state.ts";
import { createPmIntakeFixture } from "./helpers/pm-intake-fixture.ts";
import type { PmIntakeFixture } from "./helpers/pm-intake-fixture.ts";
import { ask, bridgeFor, contentView, executeObserved, observe, reply, resultEvent } from "./helpers/main-intake-test-support.ts";

vi.setConfig({ testTimeout: 30_000 });
const cleanup: PmIntakeFixture[] = [];
afterEach(async () => { for (const fixture of cleanup.splice(0).reverse()) await fixture.cleanup(); });

async function world() {
  const fixture = await createPmIntakeFixture();
  cleanup.push(fixture);
  return fixture;
}

test("真实终态回收和32条活调用上限，迟到结果仍走intake拒绝", async () => {
  const repoId = "a".repeat(64), requirementId = uuidv7(), windowId = uuidv7(), sessionId = uuidv7();
  const authorization = new HostAuthorizationManager({ dataRoot: "/tmp/pm-intake-memory-only" });
  authorization.startWindow({ kind: "main", windowId, sessionId, repoIds: [repoId] });
  const controller = new AbortController(), manager = { getSessionId: () => sessionId };
  const ctx = { sessionManager: manager, cwd: "/tmp", mode: "rpc", signal: controller.signal } as unknown as ExtensionContext;
  const create = () => {
    const bridge = new MainIntakeInteraction({ dataRoot: "/tmp/pm-intake-memory-only",
      authorization, resolveHost: () => ({ windowId, sessionId,
        repositories: new Map([[repoId, { path: "/tmp" }]]) }) });
    bridge.startSession(ctx);
    return bridge;
  };
  const input = (): PmIntakeToolInput => ({ purpose: "pm-intake", action: "ask", repoId, requirementId, operationId: uuidv7() });
  try {
    const limited = create(), inputs = Array.from({ length: 32 }, input);
    inputs.forEach((value, index) => observe(limited, ctx, `limit-${index}`, value));
    expect(() => observe(limited, ctx, "limit-32", input())).toThrow(/tool_call_limit/);
    inputs.forEach((_value, index) => limited.completeToolExecution({ toolName: "one_company_user_interact", toolCallId: `limit-${index}` }));
    expect(() => observe(limited, ctx, "recovered", input())).not.toThrow();
    expect(limited.ownsDelivery("limit-0")).toBe(true);
    expect(() => limited.assertDelivery({ toolCallId: "limit-0", input: { request: inputs[0]! }, content: [], details: {}, isError: true } as unknown as ToolResultEvent, ctx))
      .toThrow(/delivery_unavailable/);
    limited.dispose();
  } finally { authorization.shutdown(); }
});

const TWO_HOURS = 7_200_000;
/** 同时拨快假计时器与 performance.now，模拟 intake 经过很长时间。 */
async function passTwoHours(offset: { value: number }) {
  offset.value += TWO_HOURS; await vi.advanceTimersByTimeAsync(TWO_HOURS);
}

test("执行中的调用不被时间取消：服务等待两小时后信号未中止，仍占着执行容量直到实际结束", async () => {
  const repoId = "a".repeat(64), requirementId = uuidv7(), windowId = uuidv7(), sessionId = uuidv7();
  const host = new HostAuthorizationManager({ dataRoot: "/tmp/pm-intake-memory-only" });
  host.startWindow({ kind: "main", windowId, sessionId, repoIds: [repoId] });
  const controller = new AbortController(), ctx = { sessionManager: { getSessionId: () => sessionId }, cwd: "/tmp", mode: "rpc", signal: controller.signal } as unknown as ExtensionContext;
  const state = vi.spyOn(RequirementStateStore, "open").mockResolvedValue({} as never);
  const service = vi.spyOn(RequirementService, "open").mockResolvedValue({} as never);
  const releases: Array<() => void> = [], signals: AbortSignal[] = [];
  const open = vi.spyOn(PmIntakeService.prototype, "openRequest").mockImplementation(async (_call, _id, signal) => {
    signals.push(signal!);
    await new Promise<void>((resolve) => { releases.push(resolve); });
    return {} as IntakeRequestView;
  });
  const realNow = performance.now.bind(performance), offset = { value: 0 };
  const clock = vi.spyOn(performance, "now").mockImplementation(() => realNow() + offset.value);
  const bridge = new MainIntakeInteraction({ dataRoot: "/tmp/pm-intake-memory-only", authorization: host,
    resolveHost: () => ({ windowId, sessionId, repositories: new Map([[repoId, { path: "/tmp" }]]) }),
    providers: { sourceDirectoryProvider: {} as never, submissionProvider: {} as never } });
  const tasks: Array<Promise<unknown>> = [];
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  try {
    bridge.startSession(ctx);
    for (let i = 0; i < 32; i++) {
      const input: PmIntakeToolInput = { purpose: "pm-intake", action: "ask", repoId, requirementId, operationId: uuidv7() };
      observe(bridge, ctx, `waiting-${i}`, input);
      tasks.push(bridge.execute(`waiting-${i}`, input, ctx, controller.signal).then(() => "settled", () => "settled"));
    }
    while (signals.length < 32) await new Promise((resolve) => setImmediate(resolve));
    await passTwoHours(offset);
    expect(signals.every((signal) => !signal.aborted)).toBe(true);
    const fresh: PmIntakeToolInput = { purpose: "pm-intake", action: "ask", repoId, requirementId, operationId: uuidv7() };
    expect(() => observe(bridge, ctx, "still-blocked", fresh)).toThrow(/tool_call_limit/);
  } finally {
    vi.useRealTimers(); clock.mockRestore();
    bridge.dispose(); releases.forEach((release) => release()); await Promise.allSettled(tasks);
    open.mockRestore(); service.mockRestore(); state.mockRestore(); host.shutdown();
  }
});

test.each(["request", "review"] as const)("PM 接手复核没有时间期限：观察后两小时才执行、再过两小时才送达核对，%s都通过", async (mode) => {
  const fixture = await world();
  let requestId: string | undefined;
  if (mode === "review") {
    const initial = bridgeFor(fixture), initialInput = ask(fixture);
    try {
      const opened = await executeObserved(initial.bridge, initial.ctx, initial.signal, initialInput, "seed");
      requestId = (contentView(opened.response) as IntakeRequestView).requestId;
      initial.bridge.assertDelivery(resultEvent(opened.id, initialInput, opened.response), initial.ctx);
    } finally { initial.bridge.dispose(); }
  }
  const realNow = performance.now.bind(performance), offset = { value: 0 };
  const clock = vi.spyOn(performance, "now").mockImplementation(() => realNow() + offset.value);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  const current = bridgeFor(fixture);
  try {
    const input = mode === "request" ? ask(fixture) : reply(fixture, requestId!);
    observe(current.bridge, current.ctx, "long", input);
    await passTwoHours(offset);
    vi.useRealTimers();
    const response = await current.bridge.execute("long", input, current.ctx, current.signal);
    offset.value += TWO_HOURS;
    expect(() => current.bridge.assertDelivery(resultEvent("long", input, response), current.ctx)).not.toThrow();
    expect(() => observe(current.bridge, current.ctx, "long", input)).toThrow(/duplicate_tool_call/);
  } finally { vi.useRealTimers(); clock.mockRestore(); current.bridge.dispose(); }
});

test("32KiB understanding预算先独立拒绝，不冒充51,200字节transport验证", async () => {
  const fixture = await world(), { bridge, ctx, signal } = bridgeFor(fixture), input = ask(fixture);
  fixture.submissionProvider.mutate = (value) => {
    const item = value.goals[0]!;
    value.goals = Array.from({ length: 32 }, (_, index) => ({ ...structuredClone(item), text: `${index}${"\\".repeat(399)}` }));
    value.nonGoals = Array.from({ length: 32 }, () => ({ ...structuredClone(item), text: "\\".repeat(400) }));
    value.constraints = Array.from({ length: 32 }, () => ({ ...structuredClone(item), text: "\\".repeat(400) }));
    value.allowedActions = Array.from({ length: 32 }, () => ({ ...structuredClone(item), text: "\\".repeat(400) }));
  };
  observe(bridge, ctx, "budget", input);
  await expect(bridge.execute("budget", input, ctx, signal)).rejects.toMatchObject({ code: "resource_limit" });
  expect(fixture.db((db) => db.list(PM_INTAKE_NAMESPACES.requests))).toHaveLength(0);
  bridge.dispose();
});

test("合法view含Unicode与转义时transport精确接受51,200字节并拒绝51,201字节", () => {
  const binding = { repoId: "a".repeat(64), requirementId: uuidv7(), approvedProdCommit: "b".repeat(40),
    approvedRevision: 1, approvedProdHash: "c".repeat(64), approvalManifestHash: "d".repeat(64),
    approvalScopeVersion: `intake-approval-scope/v1:${"e".repeat(64)}`,
    actionScopeVersion: `intake-action-scope/v1:${"f".repeat(64)}`, workspaceId: "1".repeat(64),
    workspaceRef: "refs/heads/pm-intake", epoch: 1, pmRunId: uuidv7(), pmFence: 1, contextGeneration: 1 };
  const sourceDirectory = { prodUnitIds: ["goal.login", "scenario.failure"], prodScenarioIds: ["scenario.failure"],
    decisionIds: [], questionIds: [], requiredScenarioIds: ["scenario.failure"] };
  const understanding: PmUnderstanding = { format: "pm-understanding/v1", binding, goals: [
    { text: "实现手机号登录", sourceRefs: [{ kind: "prod-unit", id: "goal.login" }] }], nonGoals: [], constraints: [],
    allowedActions: [], unresolved: [], scenarioCoverage: [{ scenarioId: "scenario.failure", status: "covered",
      summary: "失败时显示错误", sourceRefs: [{ kind: "prod-scenario", id: "scenario.failure" }] }] };
  const view: IntakeRequestView = { requestId: uuidv7(), binding, submissionRef: "pm/submission/current",
    submissionHash: "2".repeat(64), sourceDirectoryHash: "3".repeat(64), sourceDirectory, understanding,
    understandingStatus: "accepted", uncoveredScenarioIds: [], createdAt: Date.now(), userAuthorizationCreated: false };
  const template = structuredClone(view.understanding.goals[0]!);
  const slots = 31 * 4;
  const candidate = (slashes: number, ascii: number): PmUnderstanding => {
    const texts = Array.from({ length: slots }, () => "中");
    for (let index = 0; index < slashes; index++) texts[index % slots] += "\\";
    for (let index = 0; index < ascii; index++) texts[index % slots] += "a";
    const group = (offset: number) => Array.from({ length: 31 }, (_, index) => ({ ...structuredClone(template), text: texts[offset + index]! }));
    return { ...structuredClone(view.understanding), goals: group(0), nonGoals: group(31),
      constraints: group(62), allowedActions: group(93) };
  };
  const baseUnderstanding = candidate(0, 0), baseView = { ...view, understanding: baseUnderstanding };
  const baseSize = Buffer.byteLength(JSON.stringify({ content: [{ type: "text", text: JSON.stringify(baseView) }],
    details: { format: "pm-intake-transport/v1", action: "ask" } }), "utf8");
  const remaining = 51_200 - baseSize;
  expect(remaining).toBeGreaterThan(0);
  const exact = candidate(Math.floor(remaining / 4), remaining % 4);
  expect(() => checkPmUnderstanding(exact, view.sourceDirectory)).not.toThrow();
  const acceptedView = { ...view, understanding: exact };
  expect(Buffer.byteLength(createPmIntakeToolResponse("ask", acceptedView).responseBytes, "utf8")).toBe(51_200);
  const over = structuredClone(acceptedView);
  over.understanding.goals[0]!.text += "a";
  expect(() => checkPmUnderstanding(over.understanding, over.sourceDirectory)).not.toThrow();
  expect(() => createPmIntakeToolResponse("ask", over)).toThrow(/response_budget_exceeded/);
});
