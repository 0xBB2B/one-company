import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { uuidv7 } from "../../runtime/database.ts";
import { RequirementEventService } from "../../runtime/requirement-events.ts";
import type { ApprovedBaselineResult, ApprovedContentResult, PreparedRequirementDelivery } from "../../runtime/requirement-events.ts";
import { RequirementService } from "../../runtime/requirement-service.ts";
import { RequirementStateStore } from "../../runtime/requirement-state.ts";


export interface EventProcessConfig {
  repositoryRoot: string;
  dataRoot: string;
  repoId: string;
  requirementId: string;
  now: number;
  effectsPath: string;
}

type Lease = Awaited<ReturnType<RequirementStateStore["acquirePm"]>>;
let state: RequirementStateStore;
let events: RequirementEventService;
let config: EventProcessConfig;
let lease: Lease;
let held: PreparedRequirementDelivery | undefined;
let invalidations = 0;
let invalidationsAtHold = 0;
let readCalls = 0;
let unsubscribe: (() => void) | undefined;
const originalRead = RequirementService.prototype.read;
// 透传真实读取，只计次数，不替换正文或权限结果。
RequirementService.prototype.read = function (...args) { readCalls++; return originalRead.apply(this, args); };

function consume(prepared: PreparedRequirementDelivery): ApprovedContentResult {
  let content: ApprovedContentResult | undefined;
  events.consumePreparedDelivery({ lease, handle: prepared.handle, contextGeneration: lease.contextGeneration,
    version: prepared.version }, (value) => { content = value; });
  assert.ok(content);
  return content;
}

async function run(command: string, input: any): Promise<unknown> {
  if (command === "open") {
    config = input;
    const options = { ...config, now: () => config.now, authorize: () => true };
    state = await RequirementStateStore.open(options);
    events = await RequirementEventService.open(options);
    unsubscribe = state.onAccessInvalidated(config.requirementId, () => { invalidations++; });
    return { pid: process.pid, executable: process.execPath, version: process.version };
  }
  if (command === "acquire") {
    const current = state.read(config.requirementId);
    lease = await state.acquirePm({ requirementId: config.requirementId, version: current.version,
      runId: uuidv7(), expectedFence: state.pmOwner(config.requirementId)?.fence ?? 0 });
    return { lease, cursor: await events.status({ lease }), notice: await events.poll({ lease }) };
  }
  if (command === "baseline") {
    const prepared = await events.prepareCurrentBaseline({ lease });
    const content = consume(prepared) as ApprovedBaselineResult;
    assert.equal(content.body, input.expectedBody);
    await events.acknowledgeBaseline({ lease, deliveryId: content.deliveryId });
    return { revision: content.revision, commit: content.commit, prodHash: content.prodHash,
      throughSequence: content.throughSequence, bodyMatched: true, cursor: await events.status({ lease }) };
  }
  if (command === "event") {
    const event = await events.poll({ lease });
    assert.equal(event.status, "event");
    if (event.status !== "event") throw new Error("event expected");
    const repeated = await events.poll({ lease });
    assert.equal(repeated.status, "event");
    assert.equal((repeated as typeof event).eventId, event.eventId);
    assert.equal((repeated as typeof event).redelivery, true);
    // 向 PM 发版本通知是这一步的副作用；账本只存事件ID，正文与patch不落盘。
    appendFileSync(config.effectsPath, `${event.eventId}\n`, { mode: 0o600 });
    const ack = { lease, eventId: event.eventId, sequence: event.sequence,
      toRevision: event.toRevision, toCommit: event.toCommit, toHash: event.toHash };
    await events.acknowledgeEvent(ack);
    await events.acknowledgeEvent(ack);
    return { event, cursor: await events.status({ lease }), next: await events.poll({ lease }) };
  }
  if (command === "old-lease") {
    await assert.rejects(events.poll({ lease: input }), /stale_pm_lease/);
    return { rejected: true };
  }
  if (command === "hold") {
    held = await events.prepareCurrentBaseline({ lease });
    const internals = events as unknown as { pending: Map<string, unknown>; cleanupTimer: ReturnType<typeof setTimeout> | null };
    assert.equal(internals.pending.has(held.handle), true);
    assert.ok(internals.cleanupTimer);
    // 仅暂停缓存定时回收，保留真实handle、失效订阅、授权、epoch与最终DB核验。
    // 因此跨进程closing不能被“定时器早已删掉handle”掩盖。
    clearTimeout(internals.cleanupTimer);
    internals.cleanupTimer = null;
    invalidationsAtHold = invalidations;
    return { handle: held.handle, preparedEpoch: held.epoch, expiresAt: held.expiresAt,
      pending: internals.pending.size, cleanupTimerPaused: true, invalidationsBeforeBarrier: invalidationsAtHold,
      invalidations: invalidations - invalidationsAtHold, readCalls };
  }
  if (command === "close") {
    const current = state.read(config.requirementId);
    const closing = state.beginClose({ requirementId: config.requirementId, version: current.version,
      intent: { operationId: uuidv7(), reason: "cancelled", receiptId: uuidv7() } });
    return { lifecycle: closing.data.lifecycle, epoch: closing.data.epoch, pid: process.pid };
  }
  if (command === "consume-held") {
    assert.ok(held);
    const pending = (events as unknown as { pending: Map<string, unknown> }).pending;
    const presentBefore = pending.has(held.handle);
    assert.equal(presentBefore, true);
    assert.ok(config.now < held.expiresAt);
    assert.equal(invalidations - invalidationsAtHold, 0);
    let sinkCalls = 0;
    let errorCode = "";
    assert.throws(() => {
      try { events.consumePreparedDelivery({ lease, handle: held!.handle, contextGeneration: lease.contextGeneration,
        version: held!.version }, () => { sinkCalls++; }); }
      catch (error) { errorCode = (error as { code: string }).code; throw error; }
    }, /lifecycle_denied/);
    assert.equal(sinkCalls, 0);
    const readsBefore = readCalls;
    await assert.rejects(events.prepareCurrentBaseline({ lease }), /lifecycle_denied/);
    assert.equal(readCalls, readsBefore);
    return { presentBefore, expired: false, invalidations: invalidations - invalidationsAtHold, sinkCalls, errorCode, pendingAfter: pending.size,
      lifecycle: state.read(config.requirementId).data.lifecycle, bodyReadsAfterClosing: readCalls - readsBefore };
  }
  if (command === "shutdown") {
    events?.dispose();
    unsubscribe?.();
    RequirementService.prototype.read = originalRead;
    return { disposed: true, pending: (events as unknown as { pending: Map<string, unknown> }).pending.size };
  }
  throw new Error("unknown child command");
}

let chain = Promise.resolve();
process.on("message", (message: { id: number; command: string; input: unknown }) => {
  chain = chain.then(async () => {
    try {
      const result = await run(message.command, message.input);
      process.send?.({ id: message.id, ok: true, result }, () => {
        if (message.command === "shutdown") process.disconnect();
      });
    } catch (error) {
      process.send?.({ id: message.id, ok: false, error: { name: (error as Error).name,
        code: (error as { code?: string }).code, message: "child assertion or operation failed; content omitted" } });
    }
  });
});
process.once("disconnect", () => { events?.dispose(); unsubscribe?.(); });
