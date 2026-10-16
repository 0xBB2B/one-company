import { afterEach, expect, test, vi } from "vitest";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { repositoryDatabase, uuidv7, withDatabase } from "../src/core/storage/database.ts";
import { RequirementEventService, RequirementEventServiceError } from "../src/modules/requirement/requirement-events.ts";
import type { ApprovedChangeDelivery, PreparedRequirementDelivery, RequirementEventAuthorizationRequest,
  RequirementEventServiceOptions } from "../src/modules/requirement/requirement-events.ts";
import { RequirementService } from "../src/modules/requirement/requirement-service.ts";
import { manifestConfirmInput } from "./helpers/approval-fixture.ts";
import { RequirementOperations } from "../src/modules/requirement/requirement-operations.ts";
import { RequirementStateStore } from "../src/modules/requirement/requirement-state.ts";
import { repositoryIdentity } from "../src/core/storage/identity.ts";
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
  const service = await RequirementService.open({ ...options, authorize: () => true, authorizeManifest: () => true });
  const state = await RequirementStateStore.open({ ...options, authorize: () => true });
  const events = await RequirementEventService.open({ ...options, authorize });
  cleanups.push(async () => { events.dispose(); });
  const created = await service.create({ requestId: uuidv7(), operationId: uuidv7(), title: "可靠事件", body: "批准基线" });
  const worktree = await addWorktree(repo);
  const baseCommit = (await exec(GIT, ["rev-parse", "HEAD"], { cwd: worktree.root, env: GIT_ENV })).stdout.trim();
  await state.bindWorkspace({ requirementId: created.requirementId, version: created.version,
    path: worktree.root, prepareOperationId: uuidv7(), baseCommit });
  const approved = await service.confirmUpdate(await manifestConfirmInput(options, { requirementId: created.requirementId, savedOperationId: created.operationId }));
  const lease = await state.acquirePm({ requirementId: created.requirementId, version: approved.version, runId: uuidv7(), expectedFence: 0 });
  return { root, repo, identity, options, service, state, events, created, approved, lease, worktree };
}

async function save(w: Awaited<ReturnType<typeof world>>, body: string) {
  return w.service.updateDraft({ requirementId: w.created.requirementId, operationId: uuidv7(),
    version: w.state.read(w.created.requirementId).version, title: "可靠事件", body });
}

async function confirmInput(w: Awaited<ReturnType<typeof world>>, body: string) {
  const saved = await save(w, body);
  return manifestConfirmInput(w.options, { requirementId: w.created.requirementId, savedOperationId: saved.operationId });
}

async function approve(w: Awaited<ReturnType<typeof world>>, body: string, draft?: string) {
  if (draft !== undefined) await save(w, draft);
  return w.service.confirmUpdate(await confirmInput(w, body));
}

function consumePrepared(
  events: RequirementEventService,
  lease: Awaited<ReturnType<RequirementStateStore["acquirePm"]>>,
  prepared: PreparedRequirementDelivery,
): void {
  events.consumePreparedDelivery({ lease, handle: prepared.handle, contextGeneration: lease.contextGeneration,
    version: prepared.version });
}

function cursor(w: Awaited<ReturnType<typeof world>>, lease = w.lease) {
  return w.state.approvedEventCursor({ lease });
}

async function understandBaseline(w: Awaited<ReturnType<typeof world>>) {
  const notice = await w.events.poll({ lease: w.lease });
  expect(notice).toMatchObject({ status: "baseline_required", reason: "baseline_missing", revision: 1,
    commit: w.approved.commit, prodHash: w.approved.prodHash });
  const prepared = await w.events.prepareCurrentBaseline({ lease: w.lease });
  expect(JSON.stringify(prepared)).not.toContain("批准基线");
  expect(prepared).toMatchObject({ revision: 1, commit: w.approved.commit, prodHash: w.approved.prodHash });
  consumePrepared(w.events, w.lease, prepared);
  await w.events.acknowledgeBaseline({ lease: w.lease, deliveryId: prepared.deliveryId });
  return prepared;
}

function asEvent(value: Awaited<ReturnType<RequirementEventService["poll"]>>): ApprovedChangeDelivery {
  expect(value.status).toBe("event");
  return value as ApprovedChangeDelivery;
}

function approvalEvents(database: string, requirementId: string) {
  return withDatabase(database, (db) => db.events(`requirement_events:${requirementId}`)
    .filter((event) => (event.data as { kind?: string }).kind === "prod.approved"));
}

test("批准事件只存白名单元数据，基线登记与确认分离且响应重试幂等", async () => {
  const authorizations: RequirementEventAuthorizationRequest[] = [];
  const w = await world((request) => { authorizations.push(structuredClone(request)); return true; });
  const database = repositoryDatabase(w.options.dataRoot, w.options.repoId);
  expect(w.state.pmOwner(w.created.requirementId)!.prodEvents).toBeUndefined();

  const first = await w.events.prepareCurrentBaseline({ lease: w.lease });
  const repeated = await w.events.prepareCurrentBaseline({ lease: w.lease });
  expect(repeated.deliveryId).toBe(first.deliveryId);
  expect(repeated.handle).not.toBe(first.handle);
  expect(JSON.stringify([first, repeated])).not.toContain("批准基线");
  consumePrepared(w.events, w.lease, first);
  expect(() => w.events.consumePreparedDelivery({ lease: w.lease, handle: first.handle,
    contextGeneration: w.lease.contextGeneration, version: first.version })).toThrow(/unknown_delivery_handle/);
  expect(await cursor(w)).toMatchObject({ deliveredSequence: first.throughSequence, consumedSequence: 0, understoodRevision: null });
  await w.events.acknowledgeBaseline({ lease: w.lease, deliveryId: first.deliveryId });
  await w.events.acknowledgeBaseline({ lease: w.lease, deliveryId: first.deliveryId });
  expect(await cursor(w)).toMatchObject({ deliveredSequence: first.throughSequence, consumedSequence: first.throughSequence, understoodRevision: 1,
    understood: { commit: w.approved.commit, hash: w.approved.prodHash.slice("sha256:".length) } });
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
  const input = await confirmInput(w, "队列恢复后的批准");
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
  const input = await confirmInput(w, "响应丢失后的批准");
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

test("跨过草稿的连续批准事件带准确提交对，投递不等于消费也不解除pending", async () => {
  const w = await world();
  const baseline = await understandBaseline(w);
  const second = await approve(w, "批准版本二", "不得进入事件的草稿");
  const delivery = asEvent(await w.events.poll({ lease: w.lease }));
  expect(delivery.sequence).toBeGreaterThan(baseline.throughSequence);
  expect(delivery).toMatchObject({ redelivery: false, fromRevision: 1, toRevision: 2,
    fromCommit: w.approved.commit, toCommit: second.commit, fromHash: w.approved.prodHash, toHash: second.prodHash });
  const redelivery = asEvent(await w.events.poll({ lease: w.lease }));
  expect(redelivery.eventId).toBe(delivery.eventId);
  expect(redelivery.redelivery).toBe(true);

  expect(await cursor(w)).toMatchObject({ deliveredSequence: delivery.sequence, consumedSequence: baseline.throughSequence, understoodRevision: 1 });
  await w.events.acknowledgeEvent({ lease: w.lease, eventId: delivery.eventId, sequence: delivery.sequence,
    toRevision: delivery.toRevision, toCommit: delivery.toCommit, toHash: delivery.toHash });
  await w.events.acknowledgeEvent({ lease: w.lease, eventId: delivery.eventId, sequence: delivery.sequence,
    toRevision: delivery.toRevision, toCommit: delivery.toCommit, toHash: delivery.toHash });
  expect((await cursor(w)).understoodRevision).toBe(2);
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
  expect(refreshed).toMatchObject({ revision: 3 });
  consumePrepared(reopened, nextLease, refreshed);
  await reopened.acknowledgeBaseline({ lease: nextLease, deliveryId: refreshed.deliveryId });
  expect((await cursor(w, nextLease)).understoodRevision).toBe(2);
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
  expect(prepared).toMatchObject({ revision: 3, commit: third.commit, prodHash: third.prodHash, throughSequence: latest.sequence });
  consumePrepared(w.events, w.lease, prepared);
  await w.events.acknowledgeBaseline({ lease: w.lease, deliveryId: prepared.deliveryId });
  expect(await w.events.poll({ lease: w.lease })).toMatchObject({ status: "caught_up", consumedSequence: latest.sequence,
    understoodRevision: 3, understoodCommit: third.commit });
});

test("cursor超过剩余批准尾部时进入受控恢复，保留cursor、pending和禁止执行状态", async () => {
  const w = await world();
  await understandBaseline(w);
  await approve(w, "批准版本二");
  const delivery = asEvent(await w.events.poll({ lease: w.lease }));
  await w.events.acknowledgeEvent({ lease: w.lease, eventId: delivery.eventId, sequence: delivery.sequence,
    toRevision: delivery.toRevision, toCommit: delivery.toCommit, toHash: delivery.toHash });
  const before = await cursor(w);
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

test("基线准备完成后closing，最终同步consume拒绝", async () => {
  const w = await world();
  const prepared = await w.events.prepareCurrentBaseline({ lease: w.lease });
  expect(JSON.stringify(prepared)).not.toContain("批准基线");
  const current = w.state.read(w.created.requirementId);
  w.state.beginClose({ requirementId: w.created.requirementId, version: current.version,
    intent: { operationId: uuidv7(), reason: "cancelled", receiptId: uuidv7() } });
  expect(() => w.events.consumePreparedDelivery({ lease: w.lease, handle: prepared.handle,
    contextGeneration: w.lease.contextGeneration, version: prepared.version })).toThrow(/unknown_delivery_handle/);
  expect((w.events as unknown as { pending: Map<string, unknown> }).pending.size).toBe(0);
  expect(w.state.read(w.created.requirementId).data.lifecycle).toBe("closing");
});

test("时钟前跳 1 小时后，PM 轮询、已准备的投递句柄消费与确认照常成功", async () => {
  let now = Date.now();
  const w = await world(() => true, () => now);
  const prepared = await w.events.prepareCurrentBaseline({ lease: w.lease });
  now += 3_600_000;
  expect(() => w.events.consumePreparedDelivery({ lease: w.lease, handle: prepared.handle,
    contextGeneration: w.lease.contextGeneration, version: prepared.version })).not.toThrow();
  await w.events.acknowledgeBaseline({ lease: w.lease, deliveryId: prepared.deliveryId });
  expect(await w.events.poll({ lease: w.lease })).toMatchObject({ status: "caught_up" });
});

test("消费边界撤权的句柄被丢弃", async () => {
  let authorized = true;
  const revoked = await world(() => authorized);
  const prepared = await revoked.events.prepareCurrentBaseline({ lease: revoked.lease });
  authorized = false;
  expect(() => revoked.events.consumePreparedDelivery({ lease: revoked.lease, handle: prepared.handle,
    contextGeneration: revoked.lease.contextGeneration, version: prepared.version }))
    .toThrow(/authorization_required/);
});

test("合法同步consume先于closing只消费一次", async () => {
  const w = await world();
  const prepared = await w.events.prepareCurrentBaseline({ lease: w.lease });
  consumePrepared(w.events, w.lease, prepared);
  expect(() => w.events.consumePreparedDelivery({ lease: w.lease, handle: prepared.handle,
    contextGeneration: w.lease.contextGeneration, version: prepared.version })).toThrow(/unknown_delivery_handle/);
});

test("基线句柄拒绝错误context、lease、version和跨需求使用", async () => {
  const w = await world();
  const wrongContext = await w.events.prepareCurrentBaseline({ lease: w.lease });
  const changedContextLease = { ...w.lease, contextGeneration: w.lease.contextGeneration + 1 };
  expect(() => w.events.consumePreparedDelivery({ lease: changedContextLease, handle: wrongContext.handle,
    contextGeneration: changedContextLease.contextGeneration, version: wrongContext.version }))
    .toThrow(/delivery_binding_changed/);

  const wrongLease = await w.events.prepareCurrentBaseline({ lease: w.lease });
  const changedRunLease = { ...w.lease, runId: uuidv7() };
  expect(() => w.events.consumePreparedDelivery({ lease: changedRunLease, handle: wrongLease.handle,
    contextGeneration: changedRunLease.contextGeneration, version: wrongLease.version }))
    .toThrow(/delivery_binding_changed/);

  const wrongVersion = await w.events.prepareCurrentBaseline({ lease: w.lease });
  expect(() => w.events.consumePreparedDelivery({ lease: w.lease, handle: wrongVersion.handle,
    contextGeneration: w.lease.contextGeneration, version: wrongVersion.version + 1 }))
    .toThrow(/delivery_binding_changed/);

  const cross = await world();
  const crossPrepared = await w.events.prepareCurrentBaseline({ lease: w.lease });
  expect(() => w.events.consumePreparedDelivery({ lease: cross.lease, handle: crossPrepared.handle,
    contextGeneration: cross.lease.contextGeneration, version: crossPrepared.version }))
    .toThrow(/delivery_binding_changed/);
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
  let failure: unknown;
  try {
    w.events.consumePreparedDelivery({ lease: w.lease, handle: prepared.handle,
      contextGeneration: w.lease.contextGeneration, version: prepared.version });
  } catch (error) { failure = error; }
  const closing = w.state.read(w.created.requirementId).data.lifecycle === "closing";
  expect(closing && failure === undefined).toBe(false);
  expect(calls).toBe(1);
  if (occurrence === 1) { expect(closing).toBe(true); expect(failure).toBeDefined(); }
  else expect(failure).toBeUndefined();
});

test("接手回归：closing提交立即清除同进程待消费句柄", async () => {
  const w = await world();
  await w.events.prepareCurrentBaseline({ lease: w.lease });
  const pending = (w.events as unknown as { pending: Map<string, unknown> }).pending;
  expect(pending.size).toBe(1);
  w.state.beginClose({ requirementId: w.created.requirementId, version: w.state.read(w.created.requirementId).version,
    intent: { operationId: uuidv7(), reason: "cancelled", receiptId: uuidv7() } });
  expect(pending.size).toBe(0);
});

test("接手回归：dispose释放缓存并禁止复用", async () => {
  const disposable = await world();
  await disposable.events.prepareCurrentBaseline({ lease: disposable.lease });
  disposable.events.dispose();
  expect((disposable.events as unknown as { pending: Map<string, unknown> }).pending.size).toBe(0);
  await expect(disposable.events.prepareCurrentBaseline({ lease: disposable.lease })).rejects.toThrow(/disposed/);
});

test("最终检查回归：history_unknown提交后立即清同需求其他待消费句柄且通知在事务外", async () => {
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
    expect(() => w.events.consumePreparedDelivery({ lease: w.lease, handle: first.handle,
      contextGeneration: w.lease.contextGeneration, version: first.version })).toThrow(/recovery_required/);
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
  w.events.consumePreparedDelivery({ lease: w.lease, handle: prepared.handle,
    contextGeneration: w.lease.contextGeneration, version: prepared.version });
  armed = false;
  expect(locks.length).toBeGreaterThanOrEqual(1);
  expect(locks.every(Boolean)).toBe(true);
});

test("M9：事件服务用到的每个拒绝码都配了原因与建议，不会显示成未归类的拒绝", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("../src/modules/requirement/requirement-events.ts", import.meta.url), "utf8");
  const codes = new Set([...source.matchAll(/RequirementEventServiceError\("([a-z_]+)"/gu)].map((match) => match[1]!));
  expect(codes.size).toBeGreaterThan(11);
  for (const code of codes) expect(new RequirementEventServiceError(code).advice.why, code).not.toMatch(/^未归类/u);
});
