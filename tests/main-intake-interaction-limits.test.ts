import { afterEach, expect, test, vi } from "vitest";
import type { ExtensionContext, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { uuidv7 } from "../src/core/storage/database.ts";
import { HostAuthorizationManager } from "../src/modules/requirement/host-authorization.ts";
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
  const input = (): PmIntakeToolInput => ({ purpose: "pm-intake", action: "ask", repoId, requirementId });
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
      const input: PmIntakeToolInput = { purpose: "pm-intake", action: "ask", repoId, requirementId };
      observe(bridge, ctx, `waiting-${i}`, input);
      tasks.push(bridge.execute(`waiting-${i}`, input, ctx, controller.signal).then(() => "settled", () => "settled"));
    }
    while (signals.length < 32) await new Promise((resolve) => setImmediate(resolve));
    await passTwoHours(offset);
    expect(signals.every((signal) => !signal.aborted)).toBe(true);
    const fresh: PmIntakeToolInput = { purpose: "pm-intake", action: "ask", repoId, requirementId };
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

test("32KiB understanding预算超出时服务层报resource_limit，不写入请求", async () => {
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

function sampleAskView(): IntakeRequestView {
  const binding = { repoId: "a".repeat(64), requirementId: uuidv7(), approvedPrdCommit: "b".repeat(40),
    approvedRevision: 1, approvedPrdHash: "c".repeat(64), approvalManifestHash: "d".repeat(64),
    approvalScopeVersion: `intake-approval-scope/v1:${"e".repeat(64)}`,
    actionScopeVersion: `intake-action-scope/v1:${"f".repeat(64)}`, workspaceId: "1".repeat(64),
    workspaceRef: "refs/heads/pm-intake", epoch: 1, pmRunId: uuidv7(), pmFence: 1, contextGeneration: 1 };
  const sourceDirectory = { prdUnitIds: ["goal.login", "scenario.failure"], prdScenarioIds: ["scenario.failure"],
    decisionIds: [], questionIds: [], requiredScenarioIds: ["scenario.failure"] };
  const understanding: PmUnderstanding = { format: "pm-understanding/v1", binding, goals: [
    { text: "实现手机号登录", sourceRefs: [{ kind: "prd-unit", id: "goal.login" }] }], nonGoals: [], constraints: [],
    allowedActions: [], unresolved: [], scenarioCoverage: [{ scenarioId: "scenario.failure", status: "covered",
      summary: "失败时显示错误", sourceRefs: [{ kind: "prd-scenario", id: "scenario.failure" }] }] };
  return { requestId: uuidv7(), binding, submissionRef: "pm/submission/current",
    submissionHash: "2".repeat(64), sourceDirectoryHash: "3".repeat(64), sourceDirectory, understanding,
    understandingStatus: "accepted", uncoveredScenarioIds: [], createdAt: Date.now(), userAuthorizationCreated: false };
}

function askContentBytes(view: IntakeRequestView): number {
  const { requestId, understanding, understandingStatus, uncoveredScenarioIds } = view;
  return Buffer.byteLength(JSON.stringify({ requestId, understanding, understandingStatus, uncoveredScenarioIds }), "utf8");
}

test("上限只算content：ask的content恰好49,152字节成功，多1字节报response_budget_exceeded，details不计入", () => {
  const view = sampleAskView();
  view.understanding.goals[0]!.text += "a".repeat(49_152 - askContentBytes(view));
  expect(askContentBytes(view)).toBe(49_152);
  const accepted = createPmIntakeToolResponse("ask", view).response;
  expect(Buffer.byteLength(accepted.content[0].text, "utf8")).toBe(49_152);
  expect(Buffer.byteLength(JSON.stringify(accepted.details), "utf8")).toBeGreaterThan(49_152);
  view.understanding.goals[0]!.text += "a";
  expect(() => createPmIntakeToolResponse("ask", view)).toThrow(/response_budget_exceeded/);
});

test("content加details合计超过50KiB但content未超上限时照常成功", () => {
  const view = sampleAskView();
  view.understanding.goals[0]!.text += "a".repeat(30_000);
  const { response } = createPmIntakeToolResponse("ask", view);
  const total = Buffer.byteLength(JSON.stringify({ content: response.content, details: response.details }), "utf8");
  expect(total).toBeGreaterThan(50 * 1024);
});

test("约30KB的接手理解经ask成功送达，details带完整理解", async () => {
  const fixture = await world(), { bridge, ctx, signal } = bridgeFor(fixture), input = ask(fixture);
  fixture.submissionProvider.mutate = (value) => {
    const item = value.goals[0]!;
    value.goals = Array.from({ length: 24 }, (_, index) => ({ ...structuredClone(item), text: `${index}${"中".repeat(380)}` }));
  };
  const executed = await executeObserved(bridge, ctx, signal, input, "thirty-kb");
  const size = Buffer.byteLength(executed.response.content[0]!.text, "utf8");
  expect(size).toBeGreaterThan(29_000);
  expect(size).toBeLessThan(49_152);
  const content = contentView(executed.response) as unknown as { understanding: { goals: unknown[] } };
  expect(content.understanding.goals).toHaveLength(24);
  expect(executed.response.details).toMatchObject({ binding: { repoId: fixture.repoId }, userAuthorizationCreated: false });
  expect(() => bridge.assertDelivery(resultEvent(executed.id, input, executed.response), ctx)).not.toThrow();
  bridge.dispose();
});
