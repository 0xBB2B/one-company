import { afterEach, expect, test, vi } from "vitest";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { repositoryDatabase, uuidv7, withDatabase } from "../runtime/database.ts";
import { RequirementEventService, RequirementEventServiceError } from "../runtime/requirement-events.ts";
import type { ApprovedBaselineResult, ApprovedChangeDelivery, ApprovedContentResult, ApprovedDiffResult,
  PreparedRequirementDelivery, RequirementEventAuthorizationRequest, RequirementEventServiceOptions } from "../runtime/requirement-events.ts";
import { RequirementService } from "../runtime/requirement-service.ts";
import { RequirementOperations } from "../runtime/requirement-operations.ts";
import { RequirementStateStore } from "../runtime/requirement-state.ts";
import { repositoryIdentity } from "../runtime/identity.ts";
import { addWorktree, createRepoFixture, GIT_ENV, removeRepoFixture } from "./helpers/repo-fixture.ts";
import { failDatabaseWrites } from "./helpers/database-fixture.ts";
import { temporaryRoot } from "./helpers/temporary-root.ts";


const exec = promisify(execFile);
const GIT = "git";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function world(authorize: RequirementEventServiceOptions["authorize"] = () => true, now?: () => number) {
  const root = await mkdtemp(join(temporaryRoot(), "requirement-events-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const repo = await createRepoFixture();
  cleanups.push(() => removeRepoFixture(repo));
  const identity = await repositoryIdentity(repo.root);
  const options = { repositoryRoot: repo.root, dataRoot: join(root, "private"), repoId: identity.repoId,
    ...(now ? { now } : {}) };
  const service = await RequirementService.open({ ...options, authorize: () => true });
  const state = await RequirementStateStore.open({ ...options, authorize: () => true });
  const events = await RequirementEventService.open({ ...options, authorize });
  cleanups.push(async () => { events.dispose(); });
  const created = await service.create({ requestId: uuidv7(), operationId: uuidv7(), title: "可靠事件", body: "批准基线" });
  const worktree = await addWorktree(repo);
  const baseCommit = (await exec(GIT, ["rev-parse", "HEAD"], { cwd: worktree.root, env: GIT_ENV })).stdout.trim();
  const bound = await state.bindWorkspace({ requirementId: created.requirementId, version: created.version,
    path: worktree.root, prepareOperationId: uuidv7(), baseCommit });
  const approved = await service.confirmUpdate({ requirementId: created.requirementId, operationId: uuidv7(), version: bound.version,
    title: "可靠事件", body: "批准基线", receiptId: uuidv7() });
  const lease = await state.acquirePm({ requirementId: created.requirementId, version: approved.version, runId: uuidv7(), expectedFence: 0 });
  return { root, repo, identity, options, service, state, events, created, approved, lease, worktree };
}

async function approve(w: Awaited<ReturnType<typeof world>>, body: string, draft?: string) {
  let current = w.state.read(w.created.requirementId);
  if (draft !== undefined) {
    await w.service.updateDraft({ requirementId: w.created.requirementId, operationId: uuidv7(), version: current.version,
      title: "可靠事件", body: draft });
    current = w.state.read(w.created.requirementId);
  }
  return w.service.confirmUpdate({ requirementId: w.created.requirementId, operationId: uuidv7(), version: current.version,
    title: "可靠事件", body, receiptId: uuidv7() });
}

function consumePrepared(
  events: RequirementEventService,
  lease: Awaited<ReturnType<RequirementStateStore["acquirePm"]>>,
  prepared: PreparedRequirementDelivery,
): ApprovedContentResult {
  let content: ApprovedContentResult | undefined;
  events.consumePreparedDelivery({ lease, handle: prepared.handle, contextGeneration: lease.contextGeneration,
    version: prepared.version }, (delivery) => { content = delivery; });
  expect(content).toBeDefined();
  return content!;
}

async function understandBaseline(w: Awaited<ReturnType<typeof world>>) {
  const notice = await w.events.poll({ lease: w.lease });
  expect(notice).toMatchObject({ status: "baseline_required", reason: "baseline_missing", revision: 1,
    commit: w.approved.commit, prodHash: w.approved.prodHash });
  const prepared = await w.events.prepareCurrentBaseline({ lease: w.lease });
  expect(JSON.stringify(prepared)).not.toContain("批准基线");
  const baseline = consumePrepared(w.events, w.lease, prepared) as ApprovedBaselineResult;
  expect(baseline).toMatchObject({ revision: 1, body: "批准基线", commit: w.approved.commit, prodHash: w.approved.prodHash });
  await w.events.acknowledgeBaseline({ lease: w.lease, deliveryId: baseline.deliveryId });
  return baseline;
}

function asEvent(value: Awaited<ReturnType<RequirementEventService["poll"]>>): ApprovedChangeDelivery {
  expect(value.status).toBe("event");
  return value as ApprovedChangeDelivery;
}

function approvalEvents(database: string, requirementId: string) {
  return withDatabase(database, (db) => db.events(`requirement_events:${requirementId}`)
    .filter((event) => (event.data as { kind?: string }).kind === "prod.approved"));
}

test("批准事件只存白名单元数据，完整基线投递与确认分离且响应重试幂等", async () => {
  const authorizations: RequirementEventAuthorizationRequest[] = [];
  const w = await world((request) => { authorizations.push(structuredClone(request)); return true; });
  const database = repositoryDatabase(w.options.dataRoot, w.options.repoId);
  expect(w.state.pmOwner(w.created.requirementId)!.prodEvents).toBeUndefined();

  const first = await w.events.prepareCurrentBaseline({ lease: w.lease });
  const repeated = await w.events.prepareCurrentBaseline({ lease: w.lease });
  expect(repeated.deliveryId).toBe(first.deliveryId);
  expect(repeated.handle).not.toBe(first.handle);
  expect(JSON.stringify([first, repeated])).not.toContain("批准基线");
  const content = consumePrepared(w.events, w.lease, first) as ApprovedBaselineResult;
  expect(content.body).toBe("批准基线");
  w.events.cancelPreparedDelivery({ lease: w.lease, handle: repeated.handle,
    contextGeneration: w.lease.contextGeneration, version: repeated.version });
  expect(() => w.events.consumePreparedDelivery({ lease: w.lease, handle: repeated.handle,
    contextGeneration: w.lease.contextGeneration, version: repeated.version }, () => undefined))
    .toThrow(/unknown_delivery_handle/);
  let status = await w.events.status({ lease: w.lease });
  expect(status).toMatchObject({ deliveredSequence: first.throughSequence, consumedSequence: 0, understoodRevision: null });
  await w.events.acknowledgeBaseline({ lease: w.lease, deliveryId: first.deliveryId });
  await w.events.acknowledgeBaseline({ lease: w.lease, deliveryId: first.deliveryId });
  status = await w.events.status({ lease: w.lease });
  expect(status).toMatchObject({ deliveredSequence: first.throughSequence, consumedSequence: first.throughSequence, understoodRevision: 1,
    understoodCommit: w.approved.commit, understoodHash: w.approved.prodHash });
  await expect(w.events.prepareCurrentBaseline({ lease: w.lease })).rejects.toThrow(/baseline_not_required/);

  const raw = withDatabase(database, (db) => JSON.stringify({
    queue: db.events(`requirement_events:${w.created.requirementId}`),
    owner: db.read("pm_ownership", w.created.requirementId),
  }));
  expect(raw).not.toContain("批准基线");
  expect(raw).not.toMatch(/"(?:body|prodBody|patch|diff|bytes|rawContent)"/);
  expect(JSON.stringify(authorizations)).not.toContain("批准基线");
});

test("批准状态与持久事件同事务，事件写失败不留下半份批准", async () => {
  const w = await world();
  const current = w.state.read(w.created.requirementId);
  const input = { requirementId: w.created.requirementId, operationId: uuidv7(), version: current.version,
    title: "可靠事件", body: "队列恢复后的批准", receiptId: uuidv7() };
  const database = repositoryDatabase(w.options.dataRoot, w.options.repoId);
  const restore = failDatabaseWrites(database, "events", "stream", `requirement_events:${w.created.requirementId}`);
  try { await expect(w.service.confirmUpdate(input)).rejects.toBeTruthy(); }
  finally { restore(); }
  const failed = w.state.read(w.created.requirementId);
  expect(failed.data.revision).toBe(1);
  expect(failed.data.approved!.commit).toBe(w.approved.commit);
  expect(approvalEvents(database, w.created.requirementId)).toHaveLength(1);
  const recovered = await w.service.confirmUpdate(input);
  expect(recovered.revision).toBe(2);
  expect(approvalEvents(database, w.created.requirementId)).toHaveLength(2);
});

test("批准落库后响应丢失，原操作重试不重复持久事件", async () => {
  const w = await world();
  const current = w.state.read(w.created.requirementId);
  const input = { requirementId: w.created.requirementId, operationId: uuidv7(), version: current.version,
    title: "可靠事件", body: "响应丢失后的批准", receiptId: uuidv7() };
  const original = RequirementOperations.prototype.finalize;
  vi.spyOn(RequirementOperations.prototype, "finalize").mockImplementationOnce(() => {
    throw new Error("lost approval response");
  }).mockImplementation(original);
  await expect(w.service.confirmUpdate(input)).rejects.toThrow(/lost approval response/);
  const recovered = await w.service.confirmUpdate(input);
  expect(recovered.revision).toBe(2);
  const queue = approvalEvents(repositoryDatabase(w.options.dataRoot, w.options.repoId), w.created.requirementId);
  expect(queue).toHaveLength(2);
  expect(queue.filter((event) => (event.data as { revision?: number }).revision === 2)).toHaveLength(1);
});

test("跨过草稿的连续批准事件按准确提交对diff，投递不等于消费也不解除pending", async () => {
  const w = await world();
  const baseline = await understandBaseline(w);
  const second = await approve(w, "批准版本二", "不得进入事件的草稿");
  const delivery = asEvent(await w.events.poll({ lease: w.lease }));
  expect(delivery.sequence).toBeGreaterThan(baseline.throughSequence);
  expect(delivery).toMatchObject({ redelivery: false, fromRevision: 1, toRevision: 2,
    fromCommit: w.approved.commit, toCommit: second.commit, fromHash: w.approved.prodHash, toHash: second.prodHash,
    changedSections: null, impact: "unknown", impactReason: "section_structure_unavailable" });
  const redelivery = asEvent(await w.events.poll({ lease: w.lease }));
  expect(redelivery.eventId).toBe(delivery.eventId);
  expect(redelivery.redelivery).toBe(true);

  const statusBefore = await w.events.status({ lease: w.lease });
  expect(statusBefore).toMatchObject({ deliveredSequence: delivery.sequence, consumedSequence: baseline.throughSequence, understoodRevision: 1 });
  const prepared = await w.events.prepareDiff({ lease: w.lease, eventId: delivery.eventId, sequence: delivery.sequence });
  expect(JSON.stringify(prepared)).not.toContain("批准版本二");
  const difference = consumePrepared(w.events, w.lease, prepared) as ApprovedDiffResult;
  expect(difference).toMatchObject({ fromCommit: w.approved.commit, toCommit: second.commit,
    fromHash: w.approved.prodHash, toHash: second.prodHash });
  expect(difference.diff).toContain("-批准基线");
  expect(difference.diff).toContain("+批准版本二");
  expect(difference.diff).not.toContain("不得进入事件的草稿");

  await w.events.acknowledgeEvent({ lease: w.lease, eventId: delivery.eventId, sequence: delivery.sequence,
    toRevision: delivery.toRevision, toCommit: delivery.toCommit, toHash: delivery.toHash });
  await w.events.acknowledgeEvent({ lease: w.lease, eventId: delivery.eventId, sequence: delivery.sequence,
    toRevision: delivery.toRevision, toCommit: delivery.toCommit, toHash: delivery.toHash });
  expect((await w.events.status({ lease: w.lease })).understoodRevision).toBe(2);
  expect(w.state.read(w.created.requirementId).data.pendingRevision).toBe(2);
  await expect(w.state.checkScheduling(w.lease)).rejects.toThrow(/pending_update/);
});

test("乱序确认拒绝，响应丢失可重投；PM接管保留消费基线而不重放副作用", async () => {
  const w = await world();
  await understandBaseline(w);
  await approve(w, "批准版本二");
  await approve(w, "批准版本三");
  const database = repositoryDatabase(w.options.dataRoot, w.options.repoId);
  const queued = approvalEvents(database, w.created.requirementId);
  const secondQueued = queued.find((event) => (event.data as { revision?: number }).revision === 2)!;
  const thirdQueued = queued.find((event) => (event.data as { revision?: number }).revision === 3)!;
  const second = asEvent(await w.events.poll({ lease: w.lease }));
  expect(second.eventId).toBe(secondQueued.id);
  const thirdData = thirdQueued.data as { revision: number; to: { commit: string; hash: string } };
  await expect(w.events.acknowledgeEvent({ lease: w.lease, eventId: thirdQueued.id, sequence: thirdQueued.sequence,
    toRevision: thirdData.revision, toCommit: thirdData.to.commit, toHash: `sha256:${thirdData.to.hash}` }))
    .rejects.toThrow(/event_gap/);
  expect(asEvent(await w.events.poll({ lease: w.lease })).eventId).toBe(second.eventId);
  await w.events.acknowledgeEvent({ lease: w.lease, eventId: second.eventId, sequence: second.sequence,
    toRevision: second.toRevision, toCommit: second.toCommit, toHash: second.toHash });

  w.state.releasePm(w.lease);
  const nextLease = await w.state.acquirePm({ requirementId: w.created.requirementId,
    version: w.state.read(w.created.requirementId).version, runId: uuidv7(), expectedFence: w.lease.fence + 1 });
  const reopened = await RequirementEventService.open({ ...w.options, authorize: () => true });
  cleanups.push(async () => { reopened.dispose(); });
  expect(await reopened.poll({ lease: nextLease })).toMatchObject({ status: "baseline_required", reason: "context_missing",
    revision: 3 });
  const refreshed = await reopened.prepareCurrentBaseline({ lease: nextLease });
  const refreshedBody = consumePrepared(reopened, nextLease, refreshed) as ApprovedBaselineResult;
  expect(refreshedBody).toMatchObject({ revision: 3, body: "批准版本三" });
  await reopened.acknowledgeBaseline({ lease: nextLease, deliveryId: refreshed.deliveryId });
  expect((await reopened.status({ lease: nextLease })).understoodRevision).toBe(2);
  const third = asEvent(await reopened.poll({ lease: nextLease }));
  expect(third).toMatchObject({ eventId: thirdQueued.id, sequence: thirdQueued.sequence, fromRevision: 2, toRevision: 3, redelivery: false });
  await expect(reopened.poll({ lease: w.lease })).rejects.toThrow(/stale_pm_lease/);
});

test("事件缺口不越过，active范围只用当前批准正文补完整基线", async () => {
  const w = await world();
  await understandBaseline(w);
  await approve(w, "批准版本二");
  const third = await approve(w, "批准版本三");
  const path = repositoryDatabase(w.options.dataRoot, w.options.repoId);
  const queued = approvalEvents(path, w.created.requirementId);
  const missing = queued.find((event) => (event.data as { revision?: number }).revision === 2)!;
  const latest = queued.find((event) => (event.data as { revision?: number }).revision === 3)!;
  const sqlite = new DatabaseSync(path);
  try { sqlite.prepare("DELETE FROM events WHERE stream=? AND sequence=?").run(`requirement_events:${w.created.requirementId}`, missing.sequence); }
  finally { sqlite.close(); }

  const gap = await w.events.poll({ lease: w.lease });
  expect(gap).toMatchObject({ status: "baseline_required", reason: "event_gap", revision: 3,
    commit: third.commit, prodHash: third.prodHash });
  const prepared = await w.events.prepareCurrentBaseline({ lease: w.lease });
  const baseline = consumePrepared(w.events, w.lease, prepared) as ApprovedBaselineResult;
  expect(baseline).toMatchObject({ body: "批准版本三", revision: 3, commit: third.commit, prodHash: third.prodHash,
    throughSequence: latest.sequence });
  await w.events.acknowledgeBaseline({ lease: w.lease, deliveryId: baseline.deliveryId });
  expect(await w.events.poll({ lease: w.lease })).toMatchObject({ status: "caught_up", consumedSequence: latest.sequence,
    understoodRevision: 3, understoodCommit: third.commit });
});

test("cursor超过剩余批准尾部时进入受控恢复，保留cursor、pending和禁止执行状态", async () => {
  const w = await world();
  await understandBaseline(w);
  await approve(w, "批准版本二");
  const delivery = asEvent(await w.events.poll({ lease: w.lease }));
  const prepared = await w.events.prepareDiff({ lease: w.lease, eventId: delivery.eventId, sequence: delivery.sequence });
  consumePrepared(w.events, w.lease, prepared);
  await w.events.acknowledgeEvent({ lease: w.lease, eventId: delivery.eventId, sequence: delivery.sequence,
    toRevision: delivery.toRevision, toCommit: delivery.toCommit, toHash: delivery.toHash });
  const before = await w.events.status({ lease: w.lease });
  const path = repositoryDatabase(w.options.dataRoot, w.options.repoId);
  const sqlite = new DatabaseSync(path);
  try { sqlite.prepare("DELETE FROM events WHERE stream=? AND sequence=?").run(`requirement_events:${w.created.requirementId}`, delivery.sequence); }
  finally { sqlite.close(); }

  expect(await w.events.poll({ lease: w.lease })).toMatchObject({ status: "recovery_required", reason: "history_unknown",
    consumedSequence: before.consumedSequence });
  const record = w.state.read(w.created.requirementId);
  expect(record.data).toMatchObject({ lifecycle: "active", recovery: "needs_review", recoveryReason: "history_unknown",
    pendingRevision: 2 });
  expect(w.state.pmOwner(w.created.requirementId)!.prodEvents).toMatchObject({
    consumedSequence: before.consumedSequence, understoodRevision: 2,
  });
  expect(w.state.pmOwner(w.created.requirementId)!.lease).toBeNull();
  await expect(w.state.checkPm(w.lease)).rejects.toThrow(/recovery_required/);
});

test("全部批准事件丢失时不补造基线或假报caught_up，保持history_unknown禁执行", async () => {
  const w = await world();
  const path = repositoryDatabase(w.options.dataRoot, w.options.repoId);
  const approvedEvents = approvalEvents(path, w.created.requirementId);
  const sqlite = new DatabaseSync(path);
  try {
    for (const event of approvedEvents) {
      sqlite.prepare("DELETE FROM events WHERE stream=? AND sequence=?")
        .run(`requirement_events:${w.created.requirementId}`, event.sequence);
    }
  } finally { sqlite.close(); }

  expect(await w.events.poll({ lease: w.lease })).toMatchObject({ status: "recovery_required", reason: "history_unknown",
    consumedSequence: 0 });
  expect(w.state.read(w.created.requirementId).data).toMatchObject({ recovery: "needs_review", recoveryReason: "history_unknown" });
  await expect(w.events.prepareCurrentBaseline({ lease: w.lease })).rejects.toThrow(/recovery_required|lifecycle_denied/);
});

test("异步正文准备完成后closing，最终同步consume拒绝且不调用sink", async () => {
  const w = await world();
  const prepared = await w.events.prepareCurrentBaseline({ lease: w.lease });
  expect(JSON.stringify(prepared)).not.toContain("批准基线");
  const current = w.state.read(w.created.requirementId);
  w.state.beginClose({ requirementId: w.created.requirementId, version: current.version,
    intent: { operationId: uuidv7(), reason: "cancelled", receiptId: uuidv7() } });
  const sink = vi.fn();
  expect(() => w.events.consumePreparedDelivery({ lease: w.lease, handle: prepared.handle,
    contextGeneration: w.lease.contextGeneration, version: prepared.version }, sink)).toThrow(/unknown_delivery_handle/);
  expect((w.events as unknown as { pending: Map<string, unknown> }).pending.size).toBe(0);
  expect(w.state.read(w.created.requirementId).data.lifecycle).toBe("closing");
  expect(sink).not.toHaveBeenCalled();
  expect(() => w.events.consumePreparedDelivery({ lease: w.lease, handle: prepared.handle,
    contextGeneration: w.lease.contextGeneration, version: prepared.version }, sink)).toThrow(/unknown_delivery_handle/);
});

test("diff异步准备完成后closing，最终同步consume不交付旧epoch差异正文", async () => {
  const w = await world();
  await understandBaseline(w);
  await approve(w, "批准版本二");
  const delivery = asEvent(await w.events.poll({ lease: w.lease }));
  const prepared = await w.events.prepareDiff({ lease: w.lease, eventId: delivery.eventId, sequence: delivery.sequence });
  expect(JSON.stringify(prepared)).not.toContain("批准版本二");
  const current = w.state.read(w.created.requirementId);
  w.state.beginClose({ requirementId: w.created.requirementId, version: current.version,
    intent: { operationId: uuidv7(), reason: "cancelled", receiptId: uuidv7() } });
  const sink = vi.fn();
  expect(() => w.events.consumePreparedDelivery({ lease: w.lease, handle: prepared.handle,
    contextGeneration: w.lease.contextGeneration, version: prepared.version }, sink)).toThrow(/unknown_delivery_handle/);
  expect((w.events as unknown as { pending: Map<string, unknown> }).pending.size).toBe(0);
  expect(w.state.read(w.created.requirementId).data.lifecycle).toBe("closing");
  expect(sink).not.toHaveBeenCalled();
});

test("过期或消费边界撤权的句柄被丢弃，不向sink提供正文", async () => {
  let now = Date.now();
  const expiring = await world(() => true, () => now);
  const expired = await expiring.events.prepareCurrentBaseline({ lease: expiring.lease });
  now = expired.expiresAt;
  const expiredSink = vi.fn();
  expect(() => expiring.events.consumePreparedDelivery({ lease: expiring.lease, handle: expired.handle,
    contextGeneration: expiring.lease.contextGeneration, version: expired.version }, expiredSink))
    .toThrow(/unknown_delivery_handle|expired_delivery_handle/);
  expect(expiredSink).not.toHaveBeenCalled();

  let authorized = true;
  const revoked = await world(() => authorized);
  const prepared = await revoked.events.prepareCurrentBaseline({ lease: revoked.lease });
  authorized = false;
  const revokedSink = vi.fn();
  expect(() => revoked.events.consumePreparedDelivery({ lease: revoked.lease, handle: prepared.handle,
    contextGeneration: revoked.lease.contextGeneration, version: prepared.version }, revokedSink))
    .toThrow(/authorization_required/);
  expect(revokedSink).not.toHaveBeenCalled();
});

test("合法同步consume先于closing只交付一次，异步sink不能冒充同步成功", async () => {
  const w = await world();
  const prepared = await w.events.prepareCurrentBaseline({ lease: w.lease });
  const received: ApprovedContentResult[] = [];
  w.events.consumePreparedDelivery({ lease: w.lease, handle: prepared.handle,
    contextGeneration: w.lease.contextGeneration, version: prepared.version }, (content) => { received.push(content); });
  expect((received[0] as ApprovedBaselineResult).body).toBe("批准基线");
  expect(() => w.events.consumePreparedDelivery({ lease: w.lease, handle: prepared.handle,
    contextGeneration: w.lease.contextGeneration, version: prepared.version }, () => undefined)).toThrow(/unknown_delivery_handle/);
  const current = w.state.read(w.created.requirementId);
  w.state.beginClose({ requirementId: w.created.requirementId, version: current.version,
    intent: { operationId: uuidv7(), reason: "cancelled", receiptId: uuidv7() } });
  expect(received).toHaveLength(1);

  const asyncWorld = await world();
  const asyncPrepared = await asyncWorld.events.prepareCurrentBaseline({ lease: asyncWorld.lease });
  let asyncSinkCalled = false;
  const asyncSink = async () => { asyncSinkCalled = true; };
  expect(() => asyncWorld.events.consumePreparedDelivery({ lease: asyncWorld.lease, handle: asyncPrepared.handle,
    contextGeneration: asyncWorld.lease.contextGeneration, version: asyncPrepared.version }, asyncSink)).toThrow(/synchronous_sink_required/);
  expect(asyncSinkCalled).toBe(false);
});

test("正文句柄拒绝错误context、lease、version、撤权和跨需求使用", async () => {
  const w = await world();
  const wrongContext = await w.events.prepareCurrentBaseline({ lease: w.lease });
  const changedContextLease = { ...w.lease, contextGeneration: w.lease.contextGeneration + 1 };
  expect(() => w.events.consumePreparedDelivery({ lease: changedContextLease, handle: wrongContext.handle,
    contextGeneration: changedContextLease.contextGeneration, version: wrongContext.version }, () => undefined))
    .toThrow(/delivery_binding_changed/);

  const wrongLease = await w.events.prepareCurrentBaseline({ lease: w.lease });
  const changedRunLease = { ...w.lease, runId: uuidv7() };
  expect(() => w.events.consumePreparedDelivery({ lease: changedRunLease, handle: wrongLease.handle,
    contextGeneration: changedRunLease.contextGeneration, version: wrongLease.version }, () => undefined))
    .toThrow(/delivery_binding_changed/);

  const wrongVersion = await w.events.prepareCurrentBaseline({ lease: w.lease });
  expect(() => w.events.consumePreparedDelivery({ lease: w.lease, handle: wrongVersion.handle,
    contextGeneration: w.lease.contextGeneration, version: wrongVersion.version + 1 }, () => undefined))
    .toThrow(/delivery_binding_changed/);

  const revoked = await w.events.prepareCurrentBaseline({ lease: w.lease });
  const nextContextLease = await w.events.rotateContext({ lease: w.lease });
  expect(() => w.events.consumePreparedDelivery({ lease: w.lease, handle: revoked.handle,
    contextGeneration: w.lease.contextGeneration, version: revoked.version }, () => undefined))
    .toThrow(/unknown_delivery_handle/);
  expect(await w.events.poll({ lease: nextContextLease })).toMatchObject({ status: "baseline_required", reason: "baseline_missing" });

  const cross = await world();
  const crossPrepared = await w.events.prepareCurrentBaseline({ lease: nextContextLease });
  expect(() => w.events.consumePreparedDelivery({ lease: cross.lease, handle: crossPrepared.handle,
    contextGeneration: cross.lease.contextGeneration, version: crossPrepared.version }, () => undefined))
    .toThrow(/delivery_binding_changed/);
});

test("同run上下文换代需补基线，可信恢复只接受当前run/context/version/commit/hash", async () => {
  const w = await world();
  const baseline = await understandBaseline(w);
  const before = await w.events.status({ lease: w.lease });
  const nextLease = await w.events.rotateContext({ lease: w.lease });
  expect(nextLease.runId).toBe(w.lease.runId);
  expect(nextLease.contextGeneration).toBe(w.lease.contextGeneration + 1);
  await expect(w.events.poll({ lease: w.lease })).rejects.toThrow(/stale_pm_lease/);
  expect(await w.events.poll({ lease: nextLease })).toMatchObject({ status: "baseline_required", reason: "context_missing" });
  await expect(w.events.restoreCurrentContext({ lease: nextLease, contextGeneration: nextLease.contextGeneration,
    version: w.state.read(w.created.requirementId).version, epoch: nextLease.epoch, revision: baseline.revision,
    commit: "a".repeat(40), prodHash: baseline.prodHash })).rejects.toThrow(/baseline_changed/);
  const current = w.state.read(w.created.requirementId);
  await w.events.restoreCurrentContext({ lease: nextLease, contextGeneration: nextLease.contextGeneration,
    version: current.version, epoch: nextLease.epoch, revision: baseline.revision,
    commit: baseline.commit, prodHash: baseline.prodHash });
  expect(await w.events.poll({ lease: nextLease })).toMatchObject({ status: "caught_up",
    consumedSequence: before.consumedSequence, understoodRevision: before.understoodRevision });
  expect(w.state.read(w.created.requirementId).data.pendingRevision).toBeNull();
});

test("归档路径元数据优先撤销旧active，删除不恢复；多路径冲突且终态原因保留", async () => {
  const w = await world();
  const archiveDirectory = join(w.repo.root, "docs", "prod");
  await mkdir(archiveDirectory, { recursive: true });
  const path = join(archiveDirectory, `${w.created.requirementId}.完成归档.md`);
  await writeFile(path, "ARCHIVE-BODY-MUST-NOT-BE-READ");
  const before = w.state.read(w.created.requirementId);
  const blocked = await w.events.reconcileArchiveRisk({ requirementId: w.created.requirementId, paths: [path] });
  expect(blocked).toMatchObject({ lifecycle: "active", recovery: "needs_review", recoveryReason: "archive_found",
    result: "blocked", epoch: before.data.epoch + 1 });
  await expect(w.state.checkPm(w.lease)).rejects.toThrow(/recovery_required/);
  await rm(path);
  const afterDelete = await w.events.reconcileArchiveRisk({ requirementId: w.created.requirementId, paths: [] });
  expect(afterDelete).toMatchObject({ recovery: "needs_review", recoveryReason: "archive_found", result: "unchanged" });
  const escalated = await w.events.reconcileArchiveRisk({ requirementId: w.created.requirementId,
    paths: [join(archiveDirectory, `${w.created.requirementId}.一.md`), join(archiveDirectory, `${w.created.requirementId}.二.md`)] });
  expect(escalated).toMatchObject({ recovery: "needs_review", recoveryReason: "identity_conflict", result: "blocked" });

  const conflict = await world();
  const conflictDirectory = join(conflict.repo.root, "docs", "prod");
  const paths = [join(conflictDirectory, `${conflict.created.requirementId}.一.md`),
    join(conflictDirectory, `${conflict.created.requirementId}.二.md`)];
  const conflicted = await conflict.events.reconcileArchiveRisk({ requirementId: conflict.created.requirementId, paths });
  expect(conflicted).toMatchObject({ lifecycle: "active", recovery: "needs_review", recoveryReason: "identity_conflict", result: "blocked" });

  const terminal = await world();
  const current = terminal.state.read(terminal.created.requirementId);
  const intent = { operationId: uuidv7(), reason: "rejected" as const, receiptId: uuidv7() };
  const closing = terminal.state.beginClose({ requirementId: terminal.created.requirementId, version: current.version, intent });
  const closed = terminal.state.finishClose({ requirementId: terminal.created.requirementId, version: closing.version, operationId: intent.operationId });
  const retainedPath = join(terminal.repo.root, "docs", "prod", `${terminal.created.requirementId}.风险线索.md`);
  const retained = await terminal.events.reconcileArchiveRisk({ requirementId: terminal.created.requirementId, paths: [retainedPath] });
  expect(retained).toMatchObject({ lifecycle: "closed", closeReason: "rejected", recovery: "ready",
    epoch: closed.data.epoch, result: "terminal_retained" });
});

test("事件接口拒绝伪字段、非允许归档路径和缺少可信消费者授权", async () => {
  const w = await world();
  await expect(w.events.poll({ lease: w.lease, body: "forbidden" } as never)).rejects.toThrow(/invalid_shape/);
  await expect(w.events.prepareCurrentBaseline({ lease: w.lease, commit: "a".repeat(40) } as never)).rejects.toThrow(/invalid_shape/);
  await expect(w.events.reconcileArchiveRisk({ requirementId: w.created.requirementId,
    paths: [join(w.root, `${w.created.requirementId}.越界.md`)] })).rejects.toMatchObject({ code: "archive_path_not_allowed" });
  await expect(RequirementEventService.open({ ...w.options, authorize: undefined })).rejects.toMatchObject({ code: "authorization_required" });
  await expect(RequirementEventService.open({ ...w.options, authorize: (async () => true) as never }))
    .rejects.toMatchObject({ code: "authorization_required" });
});

test.each([
  ["active", "takeover"], ["released", "takeover"], ["active", "close"], ["released", "close"],
])("接手回归：M1 %s owner支持安全%s且保留fence/sequence", async (kind, action) => {
  let now = Date.now();
  const w = await world(() => true, () => now);
  if (kind === "released") w.state.releasePm(w.lease);
  const database = repositoryDatabase(w.options.dataRoot, w.options.repoId);
  const before = w.state.pmOwner(w.created.requirementId)!;
  const { contextGeneration: _contextGeneration, ...oldLease } = w.lease;
  const legacy = { requirementId: before.requirementId, fence: before.fence,
    seenSequence: before.seenSequence, lease: kind === "active" ? oldLease : null };
  withDatabase(database, (db) => {
    const owner = db.read("pm_ownership", w.created.requirementId)!;
    db.update("pm_ownership", w.created.requirementId, owner.version, legacy);
  });
  now += 60_000;
  expect(w.state.pmOwner(w.created.requirementId)).toMatchObject({ fence: legacy.fence, seenSequence: legacy.seenSequence, lease: null });
  if (action === "takeover") {
    const next = await w.state.acquirePm({ requirementId: w.created.requirementId,
      version: w.state.read(w.created.requirementId).version, runId: uuidv7(), expectedFence: legacy.fence });
    expect(next.fence).toBe(legacy.fence + 1);
    expect((await w.events.poll({ lease: next })).status).toBe("baseline_required");
    expect(w.state.pmOwner(w.created.requirementId)!.seenSequence).toBe(legacy.seenSequence);
  } else {
    const closing = w.state.beginClose({ requirementId: w.created.requirementId,
      version: w.state.read(w.created.requirementId).version,
      intent: { operationId: uuidv7(), reason: "cancelled", receiptId: uuidv7() } });
    expect(closing.data.lifecycle).toBe("closing");
    expect(w.state.pmOwner(w.created.requirementId)).toMatchObject({ fence: legacy.fence + 1, seenSequence: legacy.seenSequence, lease: null });
  }
  await expect(w.state.checkPm(oldLease as never)).rejects.toThrow(/invalid_shape/);
});

test.each([
  ["consume", 1], ["consume", 2], ["prepare-baseline", 1], ["prepare-baseline", 2],
] as const)("接手回归：%s授权第%s次重入closing不越过最终DB检查", async (action, occurrence) => {
  let armed = false;
  let calls = 0;
  let close: (() => void) | undefined;
  const w = await world((request) => {
    if (armed && request.action === action) {
      calls++;
      if (calls === occurrence) close!();
    }
    return true;
  });
  const prepared = await w.events.prepareCurrentBaseline({ lease: w.lease });
  close = () => { w.state.beginClose({ requirementId: w.created.requirementId,
    version: w.state.read(w.created.requirementId).version,
    intent: { operationId: uuidv7(), reason: "cancelled", receiptId: uuidv7() } }); };
  armed = true;
  let sinkCalled = false;
  let failure: unknown;
  try {
    w.events.consumePreparedDelivery({ lease: w.lease, handle: prepared.handle,
      contextGeneration: w.lease.contextGeneration, version: prepared.version }, () => { sinkCalled = true; });
  } catch (error) { failure = error; }
  const closing = w.state.read(w.created.requirementId).data.lifecycle === "closing";
  expect(closing && sinkCalled).toBe(false);
  expect(calls).toBe(1);
  if (occurrence === 1) { expect(closing).toBe(true); expect(failure).toBeDefined(); }
  else { expect(sinkCalled).toBe(true); expect(failure).toBeUndefined(); }
});

test("接手回归：closing提交立即清除同进程待正文", async () => {
  const w = await world();
  await w.events.prepareCurrentBaseline({ lease: w.lease });
  const pending = (w.events as unknown as { pending: Map<string, unknown> }).pending;
  expect(pending.size).toBe(1);
  w.state.beginClose({ requirementId: w.created.requirementId, version: w.state.read(w.created.requirementId).version,
    intent: { operationId: uuidv7(), reason: "cancelled", receiptId: uuidv7() } });
  expect(pending.size).toBe(0);
});

test("接手回归：空闲过期主动释放待正文", async () => {
  let now = Date.now();
  const expiring = await world(() => true, () => now);
  await expiring.events.prepareCurrentBaseline({ lease: expiring.lease });
  const pending = (expiring.events as unknown as { pending: Map<string, unknown> }).pending;
  now = expiring.lease.expiresAt;
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  expect(pending.size).toBe(0);
});

test("接手回归：dispose释放缓存并禁止复用", async () => {
  const disposable = await world();
  await disposable.events.prepareCurrentBaseline({ lease: disposable.lease });
  disposable.events.dispose();
  expect((disposable.events as unknown as { pending: Map<string, unknown> }).pending.size).toBe(0);
  await expect(disposable.events.prepareCurrentBaseline({ lease: disposable.lease })).rejects.toThrow(/disposed/);
});

test("最终检查回归：history_unknown提交后立即清同需求其他正文且通知在事务外", async () => {
  const w = await world();
  const first = await w.events.prepareCurrentBaseline({ lease: w.lease });
  await w.events.prepareCurrentBaseline({ lease: w.lease });
  const pending = (w.events as unknown as { pending: Map<string, unknown> }).pending;
  expect(pending.size).toBe(2);
  const path = repositoryDatabase(w.options.dataRoot, w.options.repoId);
  const sqlite = new DatabaseSync(path);
  try { sqlite.prepare("DELETE FROM events WHERE stream=?").run(`requirement_events:${w.created.requirementId}`); }
  finally { sqlite.close(); }
  let outsideTransaction = false;
  const unsubscribe = w.state.onAccessInvalidated(w.created.requirementId, () => {
    const probe = new DatabaseSync(path);
    try { probe.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE; ROLLBACK"); outsideTransaction = true; }
    finally { probe.close(); }
  });
  try {
    const sink = vi.fn();
    expect(() => w.events.consumePreparedDelivery({ lease: w.lease, handle: first.handle,
      contextGeneration: w.lease.contextGeneration, version: first.version }, sink)).toThrow(/recovery_required/);
    expect(sink).not.toHaveBeenCalled();
    expect(pending.size).toBe(0);
    expect(outsideTransaction).toBe(true);
    expect(w.state.read(w.created.requirementId).data).toMatchObject({ recovery: "needs_review", recoveryReason: "history_unknown" });
  } finally { unsubscribe(); }
});

test("最终检查回归：宿主clock只在最终SQL事务外调用", async () => {
  let armed = false;
  let path = "";
  const locks: boolean[] = [];
  const w = await world(() => true, () => {
    if (armed) {
      const probe = new DatabaseSync(path);
      try {
        probe.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE; ROLLBACK");
        locks.push(true);
      } catch { locks.push(false); }
      finally { probe.close(); }
    }
    return Date.now();
  });
  path = repositoryDatabase(w.options.dataRoot, w.options.repoId);
  const prepared = await w.events.prepareCurrentBaseline({ lease: w.lease });
  armed = true;
  const sink = vi.fn();
  w.events.consumePreparedDelivery({ lease: w.lease, handle: prepared.handle,
    contextGeneration: w.lease.contextGeneration, version: prepared.version }, sink);
  armed = false;
  expect(sink).toHaveBeenCalledOnce();
  expect(locks.length).toBeGreaterThanOrEqual(3);
  expect(locks.every(Boolean)).toBe(true);
});

test("M9：事件服务用到的每个拒绝码都配了原因与建议，不会显示成未归类的拒绝", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("../runtime/requirement-events.ts", import.meta.url), "utf8");
  const codes = new Set([...source.matchAll(/RequirementEventServiceError\("([a-z_]+)"/gu)].map((match) => match[1]!));
  expect(codes.size).toBeGreaterThan(15);
  for (const code of codes) expect(new RequirementEventServiceError(code).advice.why, code).not.toMatch(/^未归类/u);
});
