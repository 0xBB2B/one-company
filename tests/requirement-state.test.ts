import { afterEach, expect, test, vi } from "vitest";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { RequirementStateStore } from "../src/modules/requirement/requirement-state.ts";
import { RequirementService } from "../src/modules/requirement/requirement-service.ts";
import { manifestConfirmInput } from "./helpers/approval-fixture.ts";
import type { RequirementStoreOptions } from "../src/modules/requirement/requirement-state.ts";
import { repositoryDatabase, uuidv7, UUID_V7_PATTERN, withDatabase } from "../src/core/storage/database.ts";
import * as databaseModule from "../src/core/storage/database.ts";
import { repositoryIdentity } from "../src/core/storage/identity.ts";
import { addWorktree, createRepoFixture, GIT_ENV, removeRepoFixture } from "./helpers/repo-fixture.ts";
import { failDatabaseWrites } from "./helpers/database-fixture.ts";
import { temporaryRoot } from "./helpers/temporary-root.ts";
import { adviceOf } from "../src/core/exec/tool-failure.ts";


const exec = promisify(execFile);
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const reference = (text = "fixture") => ({ commit: "a".repeat(40), hash: createHash("sha256").update(text).digest("hex") });
const unicodeRefSuffixes = [["U+2028", "\u2028"], ["U+2029", "\u2029"], ["U+00A0", "\u00a0"]] as const;
async function world(authorize: RequirementStoreOptions["authorize"] = () => true) {
  const root = await mkdtemp(join(temporaryRoot(), "requirement-state-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const repo = await createRepoFixture(); cleanups.push(() => removeRepoFixture(repo));
  const identity = await repositoryIdentity(repo.root);
  let now = 1_000_000;
  const options: RequirementStoreOptions = { dataRoot: join(root, "private"), repoId: identity.repoId, repositoryRoot: repo.root, authorize,
    authorizeManifest: () => true, now: () => now };
  const store = await RequirementStateStore.open(options);
  const service = await RequirementService.open({ ...options, authorize: () => true });
  const draft = (body = "状态正文") => service.create({ requestId: uuidv7(), operationId: uuidv7(), title: "状态夹具", body });
  const update = (requirementId: string, body: string) =>
    service.updateDraft({ requirementId, operationId: uuidv7(), version: store.read(requirementId).version, title: "状态夹具", body });
  const approve = async (requirementId: string, savedOperationId: string) => {
    const confirm = await manifestConfirmInput(options, { requirementId, savedOperationId });
    return store.recordApprovedVersion({ requirementId, version: confirm.version, receiptId: confirm.receiptId,
      reference: store.read(requirementId).data.saved!, manifest: confirm.manifest });
  };
  const reserve = () => store.reserve({ requestId: uuidv7(), intentHash: "b".repeat(64) });
  const bind = async (requirementId: string) => {
    const worktree = await addWorktree(repo);
    const baseCommit = (await exec("git", ["rev-parse", "HEAD"], { cwd: worktree.root, env: GIT_ENV })).stdout.trim();
    const record = store.read(requirementId);
    return store.bindWorkspace({ requirementId, version: record.version, path: worktree.root, prepareOperationId: uuidv7(), baseCommit });
  };
  const activate = async () => {
    const created = await draft(); await bind(created.requirementId);
    return approve(created.requirementId, created.operationId);
  };
  return { root, repo, identity, options, store, reserve, bind, draft, update, approve, activate, setNow: (value: number) => { now = value; } };
}

test("未接入可信核验默认拒绝，不创建数据库；模型额外角色或正文参数拒绝", async () => {
  const w = await world();
  await expect(RequirementStateStore.open({ ...w.options, authorize: undefined })).rejects.toThrow(/authorization_required/);
  await expect(RequirementStateStore.open({ ...w.options, dataRoot: join(w.repo.root, "private") })).rejects.toThrow(/worktree分离/);
  expect(existsSync(repositoryDatabase(w.options.dataRoot, w.identity.repoId))).toBe(false);
  const input = { requestId: uuidv7(), intentHash: "b".repeat(64) };
  for (const extra of [{ role: "main" }, { actor: "user" }, { prdBody: "forbidden" }, { metadata: {} }]) {
    expect(() => w.store.reserve({ ...input, ...extra })).toThrow(/invalid_shape/);
  }
  expect(existsSync(repositoryDatabase(w.options.dataRoot, w.identity.repoId))).toBe(false);
});

test("异步核对期间调用方修改options不能偷换已经绑定的仓库身份", async () => {
  const w = await world(); const foreign = await createRepoFixture(); cleanups.push(() => removeRepoFixture(foreign));
  const other = await repositoryIdentity(foreign.root);
  const options = { ...w.options, repositoryRoot: foreign.root };
  const pending = RequirementStateStore.open(options);
  options.repoId = other.repoId;
  await expect(pending).rejects.toThrow(/foreign_repository/);
});

test("UUIDv7只分配一次，响应重试沿用身份，不同请求不混用", async () => {
  const w = await world(); const input = { requestId: uuidv7(), intentHash: "b".repeat(64) };
  const first = w.store.reserve(input), again = w.store.reserve(input);
  expect(first.id).toMatch(UUID_V7_PATTERN); expect(again).toEqual(first);
  expect(w.store.events(first.id)).toHaveLength(1);
  expect(() => w.store.reserve({ ...input, intentHash: "c".repeat(64) })).toThrow(/request_conflict/);
  expect(w.reserve().id).not.toBe(first.id);
  expect(() => w.store.read(first.id.slice(0, 8))).toThrow(/invalid_shape/);
  const reopened = await RequirementStateStore.open(w.options); expect(reopened.read(first.id)).toEqual(first);
});

test("新生成的需求编号撞上已有需求时换一个编号创建成功，已有需求不受影响", async () => {
  const w = await world(); const existing = w.reserve(); const requestId = uuidv7();
  const original = databaseModule.uuidv7;
  vi.spyOn(databaseModule, "uuidv7").mockImplementationOnce(() => existing.id).mockImplementation(original);
  const created = w.store.reserve({ requestId, intentHash: "b".repeat(64) });
  expect(created.id).not.toBe(existing.id);
  expect(created.id).toMatch(UUID_V7_PATTERN);
  expect(w.store.read(existing.id)).toEqual(existing);
  expect(w.store.reserve({ requestId, intentHash: "b".repeat(64) }).id).toBe(created.id);
});

test("预留或修改状态的事件写入失败时同库全部回滚，无半份状态", async () => {
  const w = await world(); const reserved = w.reserve();
  const path = repositoryDatabase(w.options.dataRoot, w.identity.repoId);
  const restore = failDatabaseWrites(path, "events", "stream", `requirement_events:${reserved.id}`);
  try {
    expect(() => w.store.recordSavedVersion({ requirementId: reserved.id, version: reserved.version, operationId: uuidv7(), reference: reference() })).toThrow();
  } finally { restore(); }
  expect(w.store.read(reserved.id)).toEqual(reserved); expect(w.store.events(reserved.id)).toHaveLength(1);
});

test("写入前及提交前核验权限，迟到撤权使状态和事件全部回滚", async () => {
  let checks = 0;
  const w = await world(({ action }) => action !== "saved-version" || ++checks < 3);
  const record = w.reserve();
  expect(() => w.store.recordSavedVersion({ requirementId: record.id, version: record.version, operationId: uuidv7(), reference: reference() })).toThrow(/authorization_required/);
  expect(w.store.read(record.id)).toEqual(record); expect(w.store.events(record.id)).toHaveLength(1);
});

test("主工作目录不能绑定，工作区和分支占用不可串给其他需求", async () => {
  const w = await world(); const a = w.reserve(), b = w.reserve();
  const baseCommit = (await exec("git", ["rev-parse", "HEAD"], { cwd: w.repo.root, env: GIT_ENV })).stdout.trim();
  await expect(w.store.bindWorkspace({ requirementId: a.id, version: a.version, path: w.repo.root, baseCommit, prepareOperationId: uuidv7() })).rejects.toThrow(/independent_worktree_required/);
  const bound = await w.bind(a.id);
  await expect(w.store.bindWorkspace({ requirementId: b.id, version: b.version, path: bound.data.workspace!.path, baseCommit, prepareOperationId: uuidv7() })).rejects.toThrow(/workspace_occupied/);
  const other = await w.bind(b.id);
  expect(other.data.workspace!.workspaceId).not.toBe(bound.data.workspace!.workspaceId);
  expect(other.data.workspace!.branch).not.toBe(bound.data.workspace!.branch);
});

test("M8A-AC7：没有现场也能批准生效，保存版本不等于批准；没有现场不能取得 PM 租约，绑定后可以；操作重试不重复事件", async () => {
  const w = await world(); const first = w.reserve();
  const save = { requirementId: first.id, version: first.version, operationId: uuidv7(), reference: reference() };
  const saved = w.store.recordSavedVersion(save);
  expect(saved.data.lifecycle).toBe("draft"); expect(saved.data.approved).toBeNull();
  expect(w.store.recordSavedVersion(save)).toEqual(saved);
  expect(w.store.recordSavedVersion({ ...save, version: saved.version, operationId: uuidv7() })).toEqual(saved);
  expect(w.store.events(first.id)).toHaveLength(2);
  expect(() => w.store.recordSavedVersion({ ...save, reference: reference("changed") })).toThrow(/operation_conflict/);
  const created = await w.draft(), requirementId = created.requirementId;
  const confirm = await manifestConfirmInput(w.options, { requirementId, savedOperationId: created.operationId });
  const approval = { requirementId, version: confirm.version, receiptId: confirm.receiptId, reference: w.store.read(requirementId).data.saved!, manifest: confirm.manifest };
  await expect(w.store.recordApprovedVersion({ ...approval, receiptId: uuidv7(), reference: reference("wrong") })).rejects.toThrow(/saved_version_mismatch/);
  const approved = await w.store.recordApprovedVersion(approval);
  expect(approved.data.lifecycle).toBe("active"); expect(approved.data.revision).toBe(1); expect(approved.data.workspace).toBeNull();
  expect((await w.store.recordApprovedVersion(approval)).version).toBe(approved.version);
  await expect(w.store.acquirePm({ requirementId, version: approved.version, runId: uuidv7(), expectedFence: 0 })).rejects.toThrow(/workspace_not_ready/);
  const bound = await w.bind(requirementId);
  expect(bound.data.lifecycle).toBe("active");
  await expect(w.store.acquirePm({ requirementId, version: bound.version, runId: uuidv7(), expectedFence: 0 })).resolves.toMatchObject({ requirementId });
});

test("PM租约没有到期时间，时钟前跳1小时后仍持有，核对通过且不能再派新PM", async () => {
  const w = await world(); const record = await w.activate();
  const lease = await w.store.acquirePm({ requirementId: record.id, version: record.version, runId: uuidv7(), expectedFence: 0 });
  await w.store.checkPm(lease);
  await expect(w.store.acquirePm({ requirementId: record.id, version: w.store.read(record.id).version, runId: uuidv7(), expectedFence: lease.fence })).rejects.toThrow(/pm_already_owned/);
  w.setNow(1_000_000 + 3_600_000);
  await w.store.checkPm(lease);
  await w.store.checkScheduling(lease);
  expect(w.store.pmOwner(record.id)!.lease).toMatchObject({ runId: lease.runId, fence: lease.fence });
  expect(w.store.pmOwner(record.id)!.lease).not.toHaveProperty("expiresAt");
  await expect(w.store.acquirePm({ requirementId: record.id, version: w.store.read(record.id).version, runId: uuidv7(), expectedFence: lease.fence })).rejects.toThrow(/pm_already_owned/);
});

test("PM交还租约后立即可以派新PM；新PM接手后旧PM拿旧fence做任何操作都被拒绝", async () => {
  const w = await world(); const record = await w.activate();
  const lease = await w.store.acquirePm({ requirementId: record.id, version: record.version, runId: uuidv7(), expectedFence: 0 });
  w.store.releasePm(lease);
  const next = await w.store.acquirePm({ requirementId: record.id, version: w.store.read(record.id).version, runId: uuidv7(), expectedFence: w.store.pmOwner(record.id)!.fence });
  expect(next.fence).toBeGreaterThan(lease.fence);
  await expect(w.store.checkPm(lease)).rejects.toThrow(/stale_pm_lease/);
  expect(() => w.store.releasePm(lease)).toThrow(/stale_pm_lease/);
  expect(w.store.pmOwner(record.id)!.lease!.runId).toBe(next.runId);
});

test("启动时作废上一个守护进程留下的全部租约，接手编号加1，旧租约被拒，重启后立即可派新PM", async () => {
  const w = await world(); const record = await w.activate();
  const lease = await w.store.acquirePm({ requirementId: record.id, version: record.version, runId: uuidv7(), expectedFence: 0 });
  const restarted = await RequirementStateStore.open(w.options);
  restarted.revokeAllPmLeases();
  expect(restarted.pmOwner(record.id)).toMatchObject({ fence: lease.fence + 1, lease: null });
  await expect(restarted.checkPm(lease)).rejects.toThrow(/stale_pm_lease/);
  const next = await restarted.acquirePm({ requirementId: record.id, version: restarted.read(record.id).version, runId: uuidv7(), expectedFence: lease.fence + 1 });
  expect(next.fence).toBe(lease.fence + 2);
});

test("启动作废旧租约时某个需求出错，不影响其他需求的租约被作废，也不抛错", async () => {
  const w = await world(); const bad = await w.activate(), good = await w.activate();
  const badLease = await w.store.acquirePm({ requirementId: bad.id, version: bad.version, runId: uuidv7(), expectedFence: 0 });
  const goodLease = await w.store.acquirePm({ requirementId: good.id, version: good.version, runId: uuidv7(), expectedFence: 0 });
  withDatabase(repositoryDatabase(w.options.dataRoot, w.options.repoId), (db) => {
    const use = db.read("requirement_approval_uses", bad.data.approvalReceiptId!)!; db.remove("requirement_approval_uses", bad.data.approvalReceiptId!, use.version);
  });
  const restarted = await RequirementStateStore.open(w.options);
  let failures: Array<{ requirementId: string; reason: string }> = [];
  expect(() => { failures = restarted.revokeAllPmLeases(); }).not.toThrow();
  expect(failures).toEqual([{ requirementId: bad.id, reason: expect.stringContaining("approval_record_missing") }]);
  expect(restarted.pmOwner(good.id)).toMatchObject({ fence: goodLease.fence + 1, lease: null });
  const rawBad = withDatabase(repositoryDatabase(w.options.dataRoot, w.options.repoId), (db) => db.read("pm_ownership", bad.id)!.data);
  expect(rawBad).toMatchObject({ fence: badLease.fence, lease: { runId: badLease.runId } });
});

test("同一个PM运行ID不能绑定两个需求，释放后也不跨需求复用", async () => {
  const w = await world(); const a = await w.activate(), b = await w.activate();
  const runId = uuidv7();
  const lease = await w.store.acquirePm({ requirementId: a.id, version: a.version, runId, expectedFence: 0 });
  const request = { requirementId: b.id, version: b.version, runId, expectedFence: 0 };
  await expect(w.store.acquirePm(request)).rejects.toThrow(/pm_run_already_bound/);
  w.store.releasePm(lease);
  await expect(w.store.acquirePm(request)).rejects.toThrow(/pm_run_already_bound/);
});

test("真实分支改变后旧绑定不能再用；同分支提交推进仍可核对", async () => {
  const w = await world(); const record = await w.activate();
  const lease = await w.store.acquirePm({ requirementId: record.id, version: record.version, runId: uuidv7(), expectedFence: 0 });
  const cwd = record.data.workspace!.path;
  await writeFile(join(cwd, "fixture.txt"), "changed");
  await exec("git", ["add", "fixture.txt"], { cwd, env: GIT_ENV }); await exec("git", ["commit", "-m", "fixture advance"], { cwd, env: GIT_ENV });
  await w.store.checkPm(lease);
  await exec("git", ["checkout", "-b", "external-switch"], { cwd, env: GIT_ENV });
  await expect(w.store.checkPm(lease)).rejects.toThrow(/workspace_binding_changed/);
});

test.each(unicodeRefSuffixes)("真实分支在旧绑定后追加%s时，旧PM检查必须拒绝", async (_label, suffix) => {
  const w = await world(); const created = await w.draft();
  const worktree = await addWorktree(w.repo); const originalBranch = "workspace-ref-fixture";
  await exec("git", ["branch", "-m", originalBranch], { cwd: worktree.root, env: GIT_ENV });
  const baseCommit = (await exec("git", ["rev-parse", "HEAD"], { cwd: worktree.root, env: GIT_ENV })).stdout.trim();
  await w.store.bindWorkspace({ requirementId: created.requirementId, version: w.store.read(created.requirementId).version, path: worktree.root, prepareOperationId: uuidv7(), baseCommit });
  const approved = await w.approve(created.requirementId, created.operationId);
  const lease = await w.store.acquirePm({ requirementId: created.requirementId, version: approved.version, runId: uuidv7(), expectedFence: 0 });
  await exec("git", ["checkout", "-b", `${originalBranch}${suffix}`], { cwd: worktree.root, env: GIT_ENV });
  await expect(w.store.checkPm(lease)).rejects.toThrow(/workspace_binding_changed/);
});

test.each(unicodeRefSuffixes)("初始绑定保留合法%s分支尾缀的完整ref", async (_label, suffix) => {
  const w = await world(); const reserved = w.reserve();
  const worktree = await addWorktree(w.repo); const branch = `workspace-ref-fixture${suffix}`;
  await exec("git", ["branch", "-m", branch], { cwd: worktree.root, env: GIT_ENV });
  const baseCommit = (await exec("git", ["rev-parse", "HEAD"], { cwd: worktree.root, env: GIT_ENV })).stdout.trim();
  const bound = await w.store.bindWorkspace({ requirementId: reserved.id, version: reserved.version, path: worktree.root, prepareOperationId: uuidv7(), baseCommit });
  expect(bound.data.workspace!.branch).toBe(`refs/heads/${branch}`);
});

test("同路径同分支被删除重建后，旧PM不能把新现场当成原绑定", async () => {
  const w = await world(); const record = await w.activate();
  const lease = await w.store.acquirePm({ requirementId: record.id, version: record.version, runId: uuidv7(), expectedFence: 0 });
  const binding = record.data.workspace!;
  const rootHandle = await open(binding.path, "r"), gitHandle = await open(binding.gitDir, "r");
  try {
    await exec("git", ["worktree", "remove", "--force", binding.path], { cwd: w.repo.root, env: GIT_ENV });
    await exec("git", ["worktree", "add", binding.path, binding.branch.replace("refs/heads/", "")], { cwd: w.repo.root, env: GIT_ENV });
    await expect(w.store.checkPm(lease)).rejects.toThrow(/workspace_binding_changed/);
  } finally { await rootHandle.close(); await gitHandle.close(); }
});

test("确认更新保留准确前后引用，不清除pending，也不改历史证据", async () => {
  const w = await world(); const record = await w.activate();
  const lease = await w.store.acquirePm({ requirementId: record.id, version: record.version, runId: uuidv7(), expectedFence: 0 });
  const path = repositoryDatabase(w.options.dataRoot, w.identity.repoId);
  withDatabase(path, (db) => db.create("verification_runs", "fixture", { prdHash: record.data.approved!.hash, result: "PASS" }));
  const saved = await w.update(record.id, "更新后的状态正文");
  const next = await w.approve(record.id, saved.operationId);
  expect(next.data.pendingRevision).toBe(2);
  await expect(w.store.checkScheduling(lease)).rejects.toThrow(/pending_update/);
  const event = w.store.events(record.id).at(-1)!;
  expect(event.data.from).toEqual(record.data.approved); expect(event.data.to).toEqual({ commit: saved.commit, hash: saved.prdHash.slice("sha256:".length) });
  expect(w.store.read(record.id).data.pendingRevision).toBe(2);
  expect(() => w.store.beginClose({ requirementId: record.id, version: next.version, intent: { operationId: uuidv7(), reason: "completed", receiptId: uuidv7() } })).toThrow(/completion_blocked/);
  expect(withDatabase(path, (db) => db.read("verification_runs", "fixture")!.data)).toEqual({ prdHash: record.data.approved!.hash, result: "PASS" });
});

for (const reason of ["completed", "cancelled", "rejected"] as const) {
  test(`${reason}关闭状态单向，closing即拒绝新保存/PM，重试不重开或重复事件`, async () => {
    let stopped = false;
    const w = await world(({ action }) => action !== "finish-close" || stopped);
    const record = await w.activate();
    const lease = await w.store.acquirePm({ requirementId: record.id, version: record.version, runId: uuidv7(), expectedFence: 0 });
    const intent = { operationId: uuidv7(), reason, receiptId: uuidv7() };
    const current = w.store.read(record.id);
    const closing = w.store.beginClose({ requirementId: record.id, version: current.version, intent });
    expect(closing.data.epoch).toBe(current.data.epoch + 1);
    expect(w.store.beginClose({ requirementId: record.id, version: current.version, intent })).toEqual(closing);
    expect(w.store.pmOwner(record.id)!.lease).toBeNull();
    await expect(w.store.checkPm(lease)).rejects.toThrow(/lifecycle_denied/);
    expect(() => w.store.recordSavedVersion({ requirementId: record.id, version: closing.version, operationId: uuidv7(), reference: reference() })).toThrow(/lifecycle_denied/);
    expect(() => w.store.finishClose({ requirementId: record.id, version: closing.version, operationId: intent.operationId })).toThrow(/authorization_required/);
    expect(w.store.read(record.id).data.lifecycle).toBe("closing");
    stopped = true;
    const closed = w.store.finishClose({ requirementId: record.id, version: closing.version, operationId: intent.operationId });
    expect(closed.data.lifecycle).toBe("closed"); expect(closed.data.close!.reason).toBe(reason);
    const count = w.store.events(record.id).length;
    expect(w.store.finishClose({ requirementId: record.id, version: closing.version, operationId: intent.operationId })).toEqual(closed);
    expect(w.store.events(record.id)).toHaveLength(count);
    await expect(w.store.recordApprovedVersion({ requirementId: record.id, version: closed.version, receiptId: uuidv7(), reference: record.data.approved!,
      manifest: record.data.approvalManifest!.reference })).rejects.toThrow(/lifecycle_denied/);
  });
}

test("关闭预检权限不足或版本过期不提升epoch，不撤掉原PM", async () => {
  let permitted = false;
  const w = await world(({ action }) => action !== "begin-close" || permitted);
  const record = await w.activate();
  const lease = await w.store.acquirePm({ requirementId: record.id, version: record.version, runId: uuidv7(), expectedFence: 0 });
  const current = w.store.read(record.id), intent = { operationId: uuidv7(), reason: "completed" as const, receiptId: uuidv7() };
  expect(() => w.store.beginClose({ requirementId: record.id, version: current.version, intent })).toThrow(/authorization_required/);
  permitted = true;
  expect(() => w.store.beginClose({ requirementId: record.id, version: 1, intent })).toThrow(/版本已变化/);
  expect(w.store.read(record.id)).toEqual(current); await w.store.checkPm(lease);
});

test("仅归档线索或未知历史只阻塞，不猜测completed或恢复执行", async () => {
  const w = await world(); const record = await w.activate();
  const lease = await w.store.acquirePm({ requirementId: record.id, version: record.version, runId: uuidv7(), expectedFence: 0 });
  const current = w.store.read(record.id);
  const blocked = w.store.blockForRecovery({ requirementId: record.id, version: current.version, reason: "archive_found" });
  expect(blocked.data.lifecycle).toBe("active"); expect(blocked.data.recovery).toBe("needs_review"); expect(blocked.data.recoveryReason).toBe("archive_found");
  expect(w.store.pmOwner(record.id)!.lease).toBeNull();
  await expect(w.store.checkPm(lease)).rejects.toThrow(/recovery_required/);
  expect(() => w.store.recordSavedVersion({ requirementId: record.id, version: blocked.version, operationId: uuidv7(), reference: reference() })).toThrow(/recovery_required/);
  const reopened = await RequirementStateStore.open(w.options);
  expect(reopened.read(record.id).data.recovery).toBe("needs_review");
});

test("旧日期需求不导入新状态，新UUID记录不受旧记录影响", async () => {
  const w = await world(); const record = w.reserve();
  const path = repositoryDatabase(w.options.dataRoot, w.identity.repoId);
  withDatabase(path, (db) => db.create("requirements", "2026-09-11.legacy", { requirement: "2026-09-11.legacy", stage: "draft", shape: null, tasks: {}, history: [], followUps: [] }));
  expect(() => w.store.read("2026-09-11.legacy")).toThrow(/invalid_shape/);
  expect(w.store.read(record.id)).toEqual(record);
  withDatabase(path, (db) => { const r = db.read("requirements", record.id)!; db.update("requirements", record.id, r.version, { ...r.data as object, transcript: "hidden body" }); });
  expect(() => w.store.read(record.id)).toThrow(/invalid_shape/);
});

test("批准回执不能重用于新范围，同内容新批准仍登记更新而非虚构diff", async () => {
  const w = await world(); const created = await w.draft(); await w.bind(created.requirementId);
  const record = await w.approve(created.requirementId, created.operationId);
  const next = await w.approve(record.id, created.operationId);
  expect(next.data.revision).toBe(2); expect(next.data.pendingRevision).toBe(2);
  expect(w.store.events(record.id).at(-1)!.data.from).toEqual(w.store.events(record.id).at(-1)!.data.to);
  await expect(w.store.recordApprovedVersion({ requirementId: record.id, version: next.version, reference: record.data.approved!, receiptId: record.data.approvalReceiptId!,
    manifest: record.data.approvalManifest!.reference })).rejects.toThrow(/approval_conflict/);
});

test("关闭事件落库失败时epoch与PM撤销也回滚，不能半关闭", async () => {
  const w = await world(); const record = await w.activate();
  const lease = await w.store.acquirePm({ requirementId: record.id, version: record.version, runId: uuidv7(), expectedFence: 0 });
  const current = w.store.read(record.id);
  const restore = failDatabaseWrites(repositoryDatabase(w.options.dataRoot, w.identity.repoId), "events", "stream", `requirement_events:${record.id}`);
  try { expect(() => w.store.beginClose({ requirementId: record.id, version: current.version, intent: { operationId: uuidv7(), reason: "cancelled", receiptId: uuidv7() } })).toThrow(); }
  finally { restore(); }
  expect(w.store.read(record.id)).toEqual(current); await w.store.checkPm(lease);
});

test("恢复阻塞不把已取消改成完成，原请求重试也不重新打开", async () => {
  const w = await world(); const request = { requestId: uuidv7(), intentHash: "b".repeat(64) }; const record = w.store.reserve(request);
  const intent = { operationId: uuidv7(), reason: "cancelled" as const, receiptId: uuidv7() };
  const closing = w.store.beginClose({ requirementId: record.id, version: record.version, intent });
  const closed = w.store.finishClose({ requirementId: record.id, version: closing.version, operationId: intent.operationId });
  const blocked = w.store.blockForRecovery({ requirementId: record.id, version: closed.version, reason: "archive_found" });
  expect(blocked.data.lifecycle).toBe("closed"); expect(blocked.data.close!.reason).toBe("cancelled");
  expect(w.store.reserve(request)).toEqual(blocked);
});

test("即使Git强制让两个worktree占用同分支，状态服务仍拒绝第二需求绑定", async () => {
  const w = await world(); const first = w.reserve(), second = w.reserve();
  const bound = await w.bind(first.id); const binding = bound.data.workspace!;
  const duplicate = join(w.root, "duplicate-worktree");
  await exec("git", ["worktree", "add", "--force", duplicate, binding.branch.replace("refs/heads/", "")], { cwd: w.repo.root, env: GIT_ENV });
  w.repo.worktrees.push(duplicate);
  await expect(w.store.bindWorkspace({ requirementId: second.id, version: second.version, path: duplicate, prepareOperationId: uuidv7(), baseCommit: binding.baseCommit })).rejects.toThrow(/workspace_occupied/);
});

test("短提交编号、外来字段和缺失批准记录不能产生合法状态", async () => {
  const w = await world(); const record = w.reserve();
  expect(() => w.store.recordSavedVersion({ requirementId: record.id, version: record.version, operationId: uuidv7(), reference: { ...reference(), commit: "abcdef0" } })).toThrow(/invalid_shape/);
  const active = await w.activate();
  const path = repositoryDatabase(w.options.dataRoot, w.identity.repoId);
  withDatabase(path, (db) => { const use = db.read("requirement_approval_uses", active.data.approvalReceiptId!)!; db.remove("requirement_approval_uses", active.data.approvalReceiptId!, use.version); });
  expect(() => w.store.read(active.id)).toThrow(/approval_record_missing/);
});

test("核验函数异步返回不算授权，模型不能自报主代理动作", async () => {
  const w = await world();
  await expect(RequirementStateStore.open({ ...w.options, authorize: (async () => true) as unknown as RequirementStoreOptions["authorize"] })).rejects.toThrow(/authorization_required/);
  const limited = await RequirementStateStore.open({ ...w.options, authorize: ({ action }) => ["open", "read", "events"].includes(action) });
  expect(() => limited.reserve({ requestId: uuidv7(), intentHash: "a".repeat(64) })).toThrow(/authorization_required/);
});

test("跨Node进程同时争抢PM只有一个成功，状态与事件只记录一次授予", async () => {
  const w = await world(); const record = await w.activate();
  const script = join(w.root, "claim.mjs");
  await writeFile(script, `import {RequirementStateStore} from ${JSON.stringify(new URL("../src/modules/requirement/requirement-state.ts", import.meta.url).href)};
import {uuidv7} from ${JSON.stringify(new URL("../src/core/storage/database.ts", import.meta.url).href)};
const store = await RequirementStateStore.open({...${JSON.stringify({ dataRoot: w.options.dataRoot, repoId: w.identity.repoId, repositoryRoot: w.repo.root })}, authorize:()=>true, now:()=>1000000});
console.log('READY');
process.stdin.once('data', async()=> { try { const lease=await store.acquirePm({requirementId:${JSON.stringify(record.id)},version:${record.version},runId:uuidv7(),expectedFence:0});console.log(JSON.stringify({granted:true,fence:lease.fence})); } catch (error) { console.log(JSON.stringify({granted:false,code:error.code ?? error.name})); } });
`);
  const children = Array.from({ length: 2 }, () => {
    const proc = spawn(process.execPath, [script], { stdio: ["pipe", "pipe", "pipe"] }); let output = "", errors = "";
    proc.stdout.on("data", (chunk) => { output += chunk.toString(); }); proc.stderr.on("data", (chunk) => { errors += chunk.toString(); });
    const closed = new Promise<number | null>((resolve, reject) => { proc.once("close", resolve); proc.once("error", reject); }); void closed.catch(() => {});
    return { proc, output: () => output, errors: () => errors, closed };
  });
  try {
    const deadline = Date.now() + 4000;
    while (!children.every((c) => c.output().includes("READY"))) { if (Date.now() > deadline) throw new Error(children.map((c) => c.errors()).join("\n") || "子进程未就绪"); await new Promise((r) => setTimeout(r, 5)); }
    children.forEach((c) => c.proc.stdin.end("go\n"));
    expect(await Promise.all(children.map((c) => c.closed))).toEqual([0, 0]);
    const outcomes = children.map((c) => JSON.parse(c.output().trim().split("\n").at(-1)!));
    expect(outcomes.filter((r) => r.granted)).toHaveLength(1);
    expect(["StaleVersionError", "pm_already_owned"]).toContain(outcomes.find((r) => !r.granted).code);
    expect(w.store.events(record.id).filter((e) => e.data.kind === "pm.acquired")).toHaveLength(1);
    expect(w.store.pmOwner(record.id)!.fence).toBe(1);
  } finally { children.forEach((c) => c.proc.kill("SIGKILL")); await Promise.allSettled(children.map((c) => c.closed)); }
}, 10_000);

test("已有在办关闭时，关闭冲突的原因里带在办关闭的原操作编号", async () => {
  const w = await world(); const record = w.store.reserve({ requestId: uuidv7(), intentHash: "c".repeat(64) });
  const intent = { operationId: uuidv7(), reason: "cancelled" as const, receiptId: uuidv7() };
  const closing = w.store.beginClose({ requirementId: record.id, version: record.version, intent });
  const begin = (() => { try { w.store.beginClose({ requirementId: record.id, version: record.version, intent: { ...intent, operationId: uuidv7() } }); } catch (error) { return error; } })();
  expect(begin).toMatchObject({ code: "close_intent_conflict" });
  expect(adviceOf(begin)!.why).toContain(intent.operationId);
  const finish = (() => { try { w.store.finishClose({ requirementId: record.id, version: closing.version, operationId: uuidv7() }); } catch (error) { return error; } })();
  expect(finish).toMatchObject({ code: "close_intent_conflict" });
  expect(adviceOf(finish)!.why).toContain(intent.operationId);
});
