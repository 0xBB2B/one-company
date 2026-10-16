import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { uuidv7 } from "../../src/core/storage/database.ts";
import { RequirementEventService } from "../../src/modules/requirement/requirement-events.ts";
import type { PreparedRequirementDelivery } from "../../src/modules/requirement/requirement-events.ts";
import { RequirementService } from "../../src/modules/requirement/requirement-service.ts";
import { RequirementStateStore } from "../../src/modules/requirement/requirement-state.ts";


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
let verifyCalls = 0;
let unsubscribe: (() => void) | undefined;
const originalVerify = RequirementService.prototype.verifyApproved;
// 透传真实核对，只计次数，不替换核对或权限结果。
RequirementService.prototype.verifyApproved = function (...args) { verifyCalls++; return originalVerify.apply(this, args); };

async function cursor() {
  const value = await state.approvedEventCursor({ lease });
  return { deliveredSequence: value.deliveredSequence, consumedSequence: value.consumedSequence,
    understoodRevision: value.understoodRevision, understoodCommit: value.understood?.commit ?? null };
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
    return { lease, cursor: await cursor(), notice: await events.poll({ lease }) };
  }
  if (command === "baseline") {
    const prepared = await events.prepareCurrentBaseline({ lease });
    events.consumePreparedDelivery({ lease, handle: prepared.handle, contextGeneration: lease.contextGeneration, version: prepared.version });
    await events.acknowledgeBaseline({ lease, deliveryId: prepared.deliveryId });
    return { revision: prepared.revision, commit: prepared.commit, prdHash: prepared.prdHash,
      throughSequence: prepared.throughSequence, cursor: await cursor() };
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
    return { event, cursor: await cursor(), next: await events.poll({ lease }) };
  }
  if (command === "old-lease") {
    await assert.rejects(events.poll({ lease: input }), /stale_pm_lease/);
    return { rejected: true };
  }
  if (command === "hold") {
    held = await events.prepareCurrentBaseline({ lease });
    const internals = events as unknown as { pending: Map<string, unknown> };
    assert.equal(internals.pending.has(held.handle), true);
    invalidationsAtHold = invalidations;
    return { handle: held.handle, preparedEpoch: held.epoch,
      pending: internals.pending.size, invalidationsBeforeBarrier: invalidationsAtHold,
      invalidations: invalidations - invalidationsAtHold, verifyCalls };
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
    assert.equal(invalidations - invalidationsAtHold, 0);
    let errorCode = "";
    assert.throws(() => {
      try { events.consumePreparedDelivery({ lease, handle: held!.handle, contextGeneration: lease.contextGeneration,
        version: held!.version }); }
      catch (error) { errorCode = (error as { code: string }).code; throw error; }
    }, /lifecycle_denied/);
    const verifiesBefore = verifyCalls;
    await assert.rejects(events.prepareCurrentBaseline({ lease }), /lifecycle_denied/);
    return { presentBefore, expired: false, invalidations: invalidations - invalidationsAtHold, errorCode, pendingAfter: pending.size,
      lifecycle: state.read(config.requirementId).data.lifecycle, storageChecksAfterClosing: verifyCalls - verifiesBefore };
  }
  if (command === "shutdown") {
    events?.dispose();
    unsubscribe?.();
    RequirementService.prototype.verifyApproved = originalVerify;
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
