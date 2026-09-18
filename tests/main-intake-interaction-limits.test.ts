import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type { ExtensionContext, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { uuidv7 } from "../runtime/database.ts";
import { HostAuthorizationManager } from "../runtime/host-authorization.ts";
import { checkPmUnderstanding } from "../runtime/pm-intake-contracts.ts";
import type { PmUnderstanding } from "../runtime/pm-intake-contracts.ts";
import { createPmIntakeToolResponse, MainIntakeInteraction } from "../runtime/main-intake-interaction.ts";
import type { PmIntakeToolInput } from "../runtime/main-intake-interaction.ts";
import type { IntakeRequestView } from "../runtime/pm-intake-service.ts";
import { PM_INTAKE_NAMESPACES, PmIntakeStoreError } from "../runtime/pm-intake-store.ts";
import { PmIntakeService, PmIntakeServiceError } from "../runtime/pm-intake-service.ts";
import { RequirementService } from "../runtime/requirement-service.ts";
import { RequirementStateStore } from "../runtime/requirement-state.ts";
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

function snapshotIntakeRows(fixture: PmIntakeFixture) {
  return fixture.db((db) => Object.values(PM_INTAKE_NAMESPACES).sort().map((namespace) => ({
    namespace,
    rows: db.list(namespace).map((row) => structuredClone(row)).sort((left, right) => left.key.localeCompare(right.key)),
  })));
}

function intakeRowCounts(snapshot: ReturnType<typeof snapshotIntakeRows>) {
  return Object.fromEntries(snapshot.map(({ namespace, rows }) => [namespace, rows.length]));
}

function deadlineErrorMetadata(error: unknown, phase: string) {
  const field = (key: string, limit: number) => {
    if (error === null || typeof error !== "object" && typeof error !== "function") return { status: "not-object" };
    try {
      const value: unknown = Reflect.get(error, key);
      if (value === undefined) return { status: "absent" };
      if (typeof value !== "string") return { status: "not-string" };
      return { status: "present", value: value.slice(0, limit), truncated: value.length > limit };
    } catch { return { status: "unreadable" }; }
  };
  return { phase, name: field("name", 80), code: field("code", 128), message: field("message", 400) };
}

async function writeDeadlineEvidence(mode: "request" | "review", evidence: unknown): Promise<void> {
  const directory = process.env.PM_INTAKE_DEADLINE_EVIDENCE_DIR;
  if (directory) await writeFile(join(directory, `deadline-${mode}.json`), `${JSON.stringify(evidence, null, 2)}\n`,
    { encoding: "utf8", flag: "wx", mode: 0o600 });
}

test("短TTL、真实终态回收和32条活调用上限分离，迟到结果仍走intake拒绝", async () => {
  const repoId = "a".repeat(64), requirementId = uuidv7(), windowId = uuidv7(), sessionId = uuidv7();
  const authorization = new HostAuthorizationManager({ dataRoot: "/tmp/pm-intake-memory-only" });
  authorization.startWindow({ kind: "main", windowId, sessionId, repoIds: [repoId] });
  authorization.bindRequirement(repoId, requirementId, sessionId);
  const controller = new AbortController(), manager = { getSessionId: () => sessionId };
  const ctx = { sessionManager: manager, cwd: "/tmp", mode: "rpc", signal: controller.signal } as unknown as ExtensionContext;
  const create = (ttl?: number) => {
    const bridge = new MainIntakeInteraction({ dataRoot: "/tmp/pm-intake-memory-only",
      authorization, callTtlMs: ttl, resolveHost: () => ({ windowId, sessionId,
        repositories: new Map([[repoId, { path: "/tmp" }]]) }) });
    bridge.startSession(ctx);
    return bridge;
  };
  const input = (): PmIntakeToolInput => ({ purpose: "pm-intake", action: "ask", repoId, requirementId, operationId: uuidv7() });
  try {
    const short = create(2), expired = input();
    observe(short, ctx, "ttl", expired);
    await new Promise((resolve) => setTimeout(resolve, 12));
    expect(short.ownsDelivery("ttl")).toBe(true);
    await expect(short.execute("ttl", expired, ctx, controller.signal)).rejects.toMatchObject({ code: "unobserved_tool_call" });
    expect(() => short.assertDelivery({ toolCallId: "ttl", input: expired, content: [], details: {}, isError: true } as unknown as ToolResultEvent, ctx))
      .toThrow(/delivery_unavailable/);
    short.dispose();

    const limited = create(), inputs = Array.from({ length: 32 }, input);
    inputs.forEach((value, index) => observe(limited, ctx, `limit-${index}`, value));
    expect(() => observe(limited, ctx, "limit-32", input())).toThrow(/tool_call_limit/);
    inputs.forEach((_value, index) => limited.completeToolExecution({ toolName: "pi_company_user_interact", toolCallId: `limit-${index}` }));
    expect(() => observe(limited, ctx, "recovered", input())).not.toThrow();
    expect(limited.ownsDelivery("limit-0")).toBe(true);
    expect(() => limited.assertDelivery({ toolCallId: "limit-0", input: inputs[0]!, content: [], details: {}, isError: true } as unknown as ToolResultEvent, ctx))
      .toThrow(/delivery_unavailable/);
    limited.dispose();
  } finally { authorization.shutdown(); }
});

test.each([true, false])("逐调用TTL取消内存服务等待，只有实际结束才释放执行容量（合作=%s）", async (cooperative) => {
  const repoId = "a".repeat(64), requirementId = uuidv7(), windowId = uuidv7(), sessionId = uuidv7();
  const host = new HostAuthorizationManager({ dataRoot: "/tmp/pm-intake-memory-only" });
  host.startWindow({ kind: "main", windowId, sessionId, repoIds: [repoId] }); host.bindRequirement(repoId, requirementId, sessionId);
  const controller = new AbortController(), ctx = { sessionManager: { getSessionId: () => sessionId }, cwd: "/tmp", mode: "rpc", signal: controller.signal } as unknown as ExtensionContext;
  const state = vi.spyOn(RequirementStateStore, "open").mockResolvedValue({} as never);
  const service = vi.spyOn(RequirementService, "open").mockResolvedValue({} as never);
  const releases: Array<() => void> = [], signals: AbortSignal[] = [];
  const open = vi.spyOn(PmIntakeService.prototype, "openRequest").mockImplementation(async (_call, _id, signal) => {
    signals.push(signal!);
    await new Promise<void>((resolve, reject) => {
      releases.push(resolve);
      if (cooperative) signal!.addEventListener("abort", () => reject(new Error("cooperative_abort")), { once: true });
    });
    return {} as IntakeRequestView;
  });
  const check = vi.spyOn(PmIntakeService.prototype, "assertResultCurrent").mockImplementation(() => {});
  const bridge = new MainIntakeInteraction({ dataRoot: "/tmp/pm-intake-memory-only", authorization: host,
    callTtlMs: 100, resolveHost: () => ({ windowId, sessionId, repositories: new Map([[repoId, { path: "/tmp" }]]) }),
    providers: { sourceDirectoryProvider: {} as never, submissionProvider: {} as never } });
  const tasks: Array<Promise<unknown>> = [];
  try {
    bridge.startSession(ctx);
    for (let i = 0; i < (cooperative ? 1 : 32); i++) {
      const input: PmIntakeToolInput = { purpose: "pm-intake", action: "ask", repoId, requirementId, operationId: uuidv7() };
      observe(bridge, ctx, `waiting-${i}`, input);
      tasks.push(bridge.execute(`waiting-${i}`, input, ctx, controller.signal).then(() => "unexpected_success", () => "rejected"));
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(signals).toHaveLength(cooperative ? 1 : 32); expect(signals.every((signal) => signal.aborted)).toBe(true);
    const fresh: PmIntakeToolInput = { purpose: "pm-intake", action: "ask", repoId, requirementId, operationId: uuidv7() };
    if (!cooperative) expect(() => observe(bridge, ctx, "still-blocked", fresh)).toThrow(/tool_call_limit/);
    releases.forEach((release) => release());
    expect((await Promise.all(tasks)).every((result) => result === "rejected")).toBe(true);
    expect(() => observe(bridge, ctx, "actually-recovered", fresh)).not.toThrow();
  } finally {
    bridge.dispose(); releases.forEach((release) => release()); await Promise.allSettled(tasks);
    check.mockRestore(); open.mockRestore(); service.mockRestore(); state.mockRestore(); host.shutdown();
  }
});

test.each(["request", "review"] as const)("真实读取链路（TTL=5000ms）：原provider第三同步hook跨Main deadline时%s零新增", async (mode) => {
  type Outcome = { status: "resolved" } | { status: "rejected"; error: unknown };
  const ttlMs = 5_000, waitMs = 6_500, caseStarted = performance.now();
  const errors: unknown[] = [];
  const errorRecords: ReturnType<typeof deadlineErrorMetadata>[] = [];
  const restorers: Array<{ label: string; run: () => void }> = [];
  const cleanupState: Record<string, string> = {};
  const stages: Array<{ phase: string; elapsedMs: number; wallMs: number }> = [];
  const evidence: Record<string, unknown> = {
    mode, name: `真实读取链路（TTL=5000ms）：原provider第三同步hook跨Main deadline时${mode}零新增`,
    ttlMs, waitMs, stages, errors: errorRecords, cleanup: cleanupState,
  };
  let phase = "fixture";
  const stage = (value: string) => {
    phase = value;
    stages.push({ phase, elapsedMs: performance.now() - caseStarted, wallMs: Date.now() });
  };
  const recordError = (error: unknown, at: string) => {
    errors.push(error);
    errorRecords.push(deadlineErrorMetadata(error, at));
  };
  const check = (label: string, run: () => void) => {
    try { run(); } catch (error) { recordError(error, `assert:${label}`); }
  };

  try {
    stage("fixture");
    const fixture = await world();
    stage("fixture-ready");
    evidence.leaseExpiresAt = fixture.lease.expiresAt;
    let requestId: string | undefined;
    if (mode === "review") {
      stage("seed");
      const initial = bridgeFor(fixture), initialInput = ask(fixture);
      try {
        const opened = await executeObserved(initial.bridge, initial.ctx, initial.signal, initialInput, "deadline-seed");
        requestId = (contentView(opened.response) as IntakeRequestView).requestId;
        initial.bridge.assertDelivery(resultEvent(opened.id, initialInput, opened.response), initial.ctx);
      } finally {
        try { initial.bridge.dispose(); cleanupState.seedBridge = "returned"; }
        catch (error) { cleanupState.seedBridge = "failed"; recordError(error, "cleanup:seed-bridge"); }
      }
      if (cleanupState.seedBridge !== "returned") throw new Error("deadline_seed_cleanup_failed");
      stage("seed-ready");
    }

    // 使用真实批准读取和现时授权；provider spy仅观察原实现的返回。
    const current = bridgeFor(fixture, ttlMs);
    restorers.push({ label: "bridge", run: () => current.bridge.dispose() });
    const input = mode === "request" ? ask(fixture) : reply(fixture, requestId!);
    const waitCell = new Int32Array(new SharedArrayBuffer(4));
    const originalContext = current.ctx, originalSignal = current.signal, originalContextSignal = current.ctx.signal;
    const hostGenerationBefore = fixture.host.generation;
    const originalHook = fixture.submissionProvider.assertHook;
    if (originalHook !== undefined || fixture.sourceProvider.assertHook !== undefined ||
      vi.isMockFunction(RequirementService.prototype.read) || vi.isMockFunction(RequirementService.open) ||
      vi.isMockFunction(RequirementStateStore.open) || vi.isMockFunction(fixture.sourceProvider.assertCurrent) ||
      vi.isMockFunction(fixture.submissionProvider.assertCurrent)) throw new Error("real_deadline_preflight_failed");
    const beforeRows = snapshotIntakeRows(fixture), beforeCounts = intakeRowCounts(beforeRows);
    evidence.rows = { beforeCounts, afterCounts: null, fullRowsUnchanged: null };
    const sourceSpy = vi.spyOn(fixture.sourceProvider, "assertCurrent");
    restorers.push({ label: "source-spy", run: () => sourceSpy.mockRestore() });
    const submissionSpy = vi.spyOn(fixture.submissionProvider, "assertCurrent");
    restorers.push({ label: "submission-spy", run: () => submissionSpy.mockRestore() });
    restorers.push({ label: "submission-hook", run: () => { fixture.submissionProvider.assertHook = originalHook; } });
    let assertions = 0, waits = 0;
    let waitStart: number | undefined, waitEnd: number | undefined, waitResult: string | undefined;
    let leaseRemainingBeforeWait: number | undefined, leaseRemainingAfterWait: number | undefined;
    fixture.submissionProvider.assertHook = () => {
      assertions++;
      if (assertions === 3) {
        waits++;
        leaseRemainingBeforeWait = fixture.lease.expiresAt - Date.now();
        waitStart = performance.now();
        waitResult = Atomics.wait(waitCell, 0, 0, waitMs);
        waitEnd = performance.now();
        leaseRemainingAfterWait = fixture.lease.expiresAt - Date.now();
      }
    };

    stage("observe");
    const observedBefore = performance.now();
    observe(current.bridge, current.ctx, `deadline-${mode}`, input);
    const observedAfter = performance.now();
    phase = "execute";
    const outcome: Outcome = await current.bridge.execute(`deadline-${mode}`, input, current.ctx, current.signal).then(
      () => ({ status: "resolved" as const }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    );
    stage("execute-settled");
    const rejectedError = outcome.status === "rejected" ? outcome.error : undefined;
    const acceptedError = rejectedError instanceof PmIntakeServiceError && rejectedError.code === "untrusted_main_call" ||
      (rejectedError instanceof PmIntakeServiceError || rejectedError instanceof PmIntakeStoreError) && rejectedError.code === "main_deadline_elapsed";
    if (outcome.status === "rejected" && !acceptedError) recordError(outcome.error, "execute");
    evidence.outcome = { status: outcome.status, acceptedError,
      error: outcome.status === "rejected" ? deadlineErrorMetadata(rejectedError, "execute") : null };
    const sourceResults = sourceSpy.mock.results.map((result) => result.type);
    const submissionResults = submissionSpy.mock.results.map((result) => result.type);
    evidence.providers = { sourceResults, submissionResults, assertions, waits, waitResult };
    evidence.timing = { observedBefore, observedAfter, waitStart, waitEnd,
      leaseRemainingBeforeWait, leaseRemainingAfterWait };
    evidence.runtime = { hostGenerationBefore, hostGenerationAfter: fixture.host.generation,
      contextUnchanged: current.ctx === originalContext,
      signalUnchanged: current.signal === originalSignal && current.ctx.signal === originalContextSignal,
      externalSignalAborted: current.signal.aborted, controllerSignalAborted: current.controller.signal.aborted };

    let afterRows: ReturnType<typeof snapshotIntakeRows> | undefined;
    try { afterRows = snapshotIntakeRows(fixture); }
    catch (error) { recordError(error, "snapshot-after-execute"); }
    const afterCounts = afterRows ? intakeRowCounts(afterRows) : null;
    const rowsUnchanged = afterRows !== undefined && JSON.stringify(afterRows) === JSON.stringify(beforeRows);
    evidence.rows = { beforeCounts, afterCounts, fullRowsUnchanged: rowsUnchanged };
    check("exact-deadline-error", () => { expect(outcome.status).toBe("rejected"); expect(acceptedError).toBe(true); });
    check("original-provider-returns", () => {
      expect(sourceResults).toEqual(["return", "return", "return", "return"]);
      expect(submissionResults).toEqual(["return", "return", "return"]);
      expect(assertions).toBe(3); expect(waits).toBe(1); expect(waitResult).toBe("timed-out");
    });
    check("native-deadline-and-lease", () => {
      expect(typeof waitStart).toBe("number"); expect(typeof waitEnd).toBe("number");
      expect(waitStart!).toBeLessThan(observedBefore + ttlMs);
      expect(waitEnd!).toBeGreaterThanOrEqual(observedAfter + ttlMs);
      expect(leaseRemainingBeforeWait!).toBeGreaterThan(0);
      expect(leaseRemainingAfterWait!).toBeGreaterThan(0);
    });
    check("unchanged-host-and-signal", () => {
      expect(fixture.host.generation).toBe(hostGenerationBefore);
      expect(current.ctx).toBe(originalContext); expect(current.signal).toBe(originalSignal);
      expect(current.ctx.signal).toBe(originalContextSignal); expect(current.signal.aborted).toBe(false);
      expect(current.controller.signal).toBe(originalSignal); expect(current.controller.signal.aborted).toBe(false);
    });
    check("all-intake-rows-unchanged", () => {
      expect(rowsUnchanged).toBe(true);
      expect(afterCounts?.[PM_INTAKE_NAMESPACES.requests]).toBe(beforeCounts[PM_INTAKE_NAMESPACES.requests]);
      expect(afterCounts?.[PM_INTAKE_NAMESPACES.reviews]).toBe(beforeCounts[PM_INTAKE_NAMESPACES.reviews]);
      expect(beforeCounts[PM_INTAKE_NAMESPACES.requests]).toBe(mode === "review" ? 1 : 0);
      expect(beforeCounts[PM_INTAKE_NAMESPACES.reviews]).toBe(0);
    });
  } catch (error) { recordError(error, phase); }
  finally {
    for (const restorer of restorers.reverse()) {
      try { restorer.run(); cleanupState[restorer.label] = "returned"; }
      catch (error) { cleanupState[restorer.label] = "failed"; recordError(error, `cleanup:${restorer.label}`); }
    }
  }
  evidence.elapsedMs = performance.now() - caseStarted;
  evidence.failureCount = errors.length;
  try { await writeDeadlineEvidence(mode, evidence); }
  catch (error) { recordError(error, "write-evidence"); }
  if (errors.length) throw new AggregateError(errors, `real_deadline_${mode}_failed`);
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
  await expect(bridge.execute("budget", input, ctx, signal)).rejects.toThrow(/resource_limit/);
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
    understandingStatus: "accepted", uncoveredScenarioIds: [], createdAt: Date.now(), executionEnabled: false,
    scheduling: "not_implemented", userAuthorizationCreated: false };
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
