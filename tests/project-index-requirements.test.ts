import { afterEach, expect, test, vi } from "vitest";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { join } from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { ProjectIndexRequirements } from "../daemon/project-index-requirements.ts";
import type { ProjectIndexArchiveRiskHookEvent } from "../daemon/project-index-coordinator.ts";
import { uuidv7, repositoryDatabase, withDatabase } from "../runtime/database.ts";
import { repositoryIdentity } from "../runtime/identity.ts";
import { readGit } from "../runtime/git-read.ts";
import { RequirementService } from "../runtime/requirement-service.ts";
import { RequirementStateStore } from "../runtime/requirement-state.ts";
import { RequirementEventService } from "../runtime/requirement-events.ts";
import { addWorktree, createRepoFixture, GIT_ENV, removeRepoFixture } from "./helpers/repo-fixture.ts";


const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

test("宿主Node直接导入适配器，不依赖Vitest转译或TypeScript变换参数", async () => {
  const moduleUrl = new URL("../daemon/project-index-requirements.ts", import.meta.url).href;
  const script = `const module = await import(${JSON.stringify(moduleUrl)});
    const error = new module.ProjectIndexRequirementsError("adapter_closed");
    if (error.code !== "adapter_closed" || typeof module.ProjectIndexRequirements !== "function") process.exit(2);
    console.log("direct-import-ok");`;
  const result = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, NODE_OPTIONS: "" }, timeout: 10_000,
  });
  expect(result.stdout.trim()).toBe("direct-import-ok");
});

function workspaceId(repoId: string, root: string, branch: string): string {
  const hash = createHash("sha256");
  for (const part of [repoId, root, branch]) hash.update(String(Buffer.byteLength(part))).update(":").update(part).update("|");
  return hash.digest("hex");
}

async function world() {
  const root = await fsp.realpath(await fsp.mkdtemp("/tmp/m3-archive-fixture-"));
  await fsp.chmod(root, 0o700);
  cleanups.push(() => fsp.rm(root, { recursive: true, force: true }));
  const repo = await createRepoFixture();
  cleanups.push(() => removeRepoFixture(repo));
  repo.root = await fsp.realpath(repo.root);
  const identity = await repositoryIdentity(repo.root);
  const options = { repositoryRoot: repo.root, dataRoot: join(root, "private"), repoId: identity.repoId};
  const service = await RequirementService.open({ ...options, authorize: () => true });
  const state = await RequirementStateStore.open({ ...options, authorize: () => true });
  const adapter = new ProjectIndexRequirements(options);
  cleanups.push(() => adapter.close());
  const created = await service.create({ requestId: uuidv7(), operationId: uuidv7(), title: "归档适配", body: "ACTIVE-PRIVATE-BODY" });
  const worktree = await addWorktree(repo);
  worktree.root = await fsp.realpath(worktree.root);
  const baseCommit = (await readGit(worktree.root, ["rev-parse", "HEAD"])).stdout.trim();
  const bound = await state.bindWorkspace({ requirementId: created.requirementId, version: created.version,
    path: worktree.root, prepareOperationId: uuidv7(), baseCommit });
  const approved = await service.confirmUpdate({ requirementId: created.requirementId, operationId: uuidv7(),
    version: bound.version, title: "归档适配", body: "ACTIVE-PRIVATE-BODY", receiptId: uuidv7() });
  const lease = await state.acquirePm({ requirementId: created.requirementId, version: approved.version, runId: uuidv7(), expectedFence: 0 });
  const events = await RequirementEventService.open({ ...options, authorize: () => true });
  cleanups.push(async () => { events.dispose(); });
  const hookEvent = (target = repo.root, event: Partial<ProjectIndexArchiveRiskHookEvent["event"]> = {}): ProjectIndexArchiveRiskHookEvent => {
    const branch = target === repo.root ? "refs/heads/main" : `refs/heads/${worktree.branch}`;
    return { repositoryRoot: target, workspace: { repoId: identity.repoId, root: target, branch,
      workspaceId: workspaceId(identity.repoId, target, branch) },
    event: { eventSequence: 1, path: null, eventType: null, overflowed: false, ...event } };
  };
  const archive = async (id = created.requirementId, description = "归档", target = repo.root) => {
    const directory = join(target, "docs", "prod");
    await fsp.mkdir(directory, { recursive: true });
    const path = join(directory, `${id}.${description}.md`);
    await fsp.writeFile(path, "ARCHIVE-BODY-MUST-NEVER-BE-READ");
    return path;
  };
  return { root, repo, options, service, state, adapter, created, lease, events, worktree, hookEvent, archive };
}
type World = Awaited<ReturnType<typeof world>>;

async function changeFixtureWorkspace(w: World, change: "removed" | "branch-changed") {
  const args = change === "removed"
    ? ["worktree", "remove", "--", w.worktree.root]
    : ["-C", w.worktree.root, "switch", "-c", "archive-terminal-fixture"];
  await promisify(execFile)("git", args, { cwd: w.repo.root, env: GIT_ENV, timeout: 10_000 });
  if (change === "removed") expect(fs.existsSync(w.worktree.root)).toBe(false);
}

function denyBodyReads(w: World) {
  const attempted: string[] = [];
  const forbidden = (value: unknown) => {
    const path = value instanceof URL ? value.pathname : String(value);
    if (path.includes("/docs/prod/") || path.includes("/requirements/") || path.includes("/sessions/")) {
      attempted.push(path);
      throw new Error("forbidden body read");
    }
  };
  const readFile = fsp.readFile;
  vi.spyOn(fsp, "readFile").mockImplementation(((...args: Parameters<typeof fsp.readFile>) => {
    forbidden(args[0]); return readFile(...args);
  }) as typeof fsp.readFile);
  const open = fsp.open;
  vi.spyOn(fsp, "open").mockImplementation(((...args: Parameters<typeof fsp.open>) => {
    forbidden(args[0]); return open(...args);
  }) as typeof fsp.open);
  const readFileSync = fs.readFileSync;
  vi.spyOn(fs, "readFileSync").mockImplementation(((...args: Parameters<typeof fs.readFileSync>) => {
    forbidden(args[0]); return readFileSync(...args);
  }) as typeof fs.readFileSync);
  const openSync = fs.openSync;
  vi.spyOn(fs, "openSync").mockImplementation(((...args: Parameters<typeof fs.openSync>) => {
    forbidden(args[0]); return openSync(...args);
  }) as typeof fs.openSync);
  const createReadStream = fs.createReadStream;
  vi.spyOn(fs, "createReadStream").mockImplementation(((...args: Parameters<typeof fs.createReadStream>) => {
    forbidden(args[0]); return createReadStream(...args);
  }) as typeof fs.createReadStream);
  syncBuiltinESMExports();
  // 状态准备使用生产prod存储；适配阶段即使本机正文和.git不可访问，也只凭SQLite元数据撤权。
  expect(w.options.dataRoot).not.toContain(w.repo.root);
  return attempted;
}

function assertBlocked(w: World, reason = "archive_found") {
  const record = w.state.read(w.created.requirementId);
  expect(record.data).toMatchObject({ lifecycle: "active", recovery: "needs_review", recoveryReason: reason, close: null });
  expect(w.state.pmOwner(w.created.requirementId)).toMatchObject({ lease: null, fence: w.lease.fence + 1 });
  return record;
}

test("新增归档先撤权清除旧正文交付，再允许常规同步/通知；删除不恢复", async () => {
  const w = await world();
  const prepared = await w.events.prepareCurrentBaseline({ lease: w.lease });
  const before = w.state.read(w.created.requirementId);
  const path = await w.archive();
  const attempted = denyBodyReads(w);
  const order: string[] = [];
  const unsubscribe = w.state.onAccessInvalidated(w.created.requirementId, () => { order.push("revoked"); });
  cleanups.push(async () => { unsubscribe(); });
  await w.adapter.beforeArchiveRisk(w.hookEvent(w.repo.root, { path: `docs/prod/${path.split("/").at(-1)}`, eventType: "rename" }));
  order.push("sync", "notify");
  expect(order).toEqual(["revoked", "sync", "notify"]);
  expect(assertBlocked(w).data.epoch).toBe(before.data.epoch + 1);
  await expect(w.state.checkPm(w.lease)).rejects.toThrow(/recovery_required/);
  const sink = vi.fn();
  expect(() => w.events.consumePreparedDelivery({ lease: w.lease, handle: prepared.handle,
    contextGeneration: w.lease.contextGeneration, version: prepared.version }, sink)).toThrow(/unknown_delivery_handle/);
  expect(sink).not.toHaveBeenCalled();
  const blocked = w.state.read(w.created.requirementId);
  await fsp.rm(path);
  await w.adapter.beforeArchiveRisk(w.hookEvent());
  expect(w.state.read(w.created.requirementId)).toEqual(blocked);
  expect(attempted).toEqual([]);
});

test.each(["completed", "cancelled", "rejected"] as const)("closing/closed保全%s原因，不因归档或删除改变终态", async (reason) => {
  const w = await world();
  const intent = { operationId: uuidv7(), reason, receiptId: uuidv7() };
  const closing = w.state.beginClose({ requirementId: w.created.requirementId, version: w.state.read(w.created.requirementId).version, intent });
  const path = await w.archive();
  const attempted = denyBodyReads(w);
  await w.adapter.beforeArchiveRisk(w.hookEvent());
  expect(w.state.read(w.created.requirementId)).toEqual(closing);
  const closed = w.state.finishClose({ requirementId: w.created.requirementId, version: closing.version, operationId: intent.operationId });
  await w.archive(w.created.requirementId, "另一描述");
  await w.adapter.beforeArchiveRisk(w.hookEvent(w.repo.root, { overflowed: true }));
  expect(w.state.read(w.created.requirementId)).toEqual(closed);
  await fsp.rm(path);
  await w.adapter.beforeArchiveRisk(w.hookEvent());
  expect(w.state.read(w.created.requirementId).data.close?.reason).toBe(reason);
  expect(attempted).toEqual([]);
});

test.each(([
  ["completed", "removed"], ["completed", "branch-changed"],
  ["cancelled", "removed"], ["cancelled", "branch-changed"],
  ["rejected", "removed"], ["rejected", "branch-changed"],
] as const).flatMap(([reason, change]) => (["closing", "closed"] as const).map((lifecycle) => ({ reason, change, lifecycle }))))(
  "终态归档不依赖旧工作区：$reason/$change/$lifecycle，保全原因及拒读", async ({ reason, change, lifecycle }) => {
  const w = await world();
  const prepared = await w.events.prepareCurrentBaseline({ lease: w.lease });
  const intent = { operationId: uuidv7(), reason, receiptId: uuidv7() };
  const closing = w.state.beginClose({ requirementId: w.created.requirementId,
    version: w.state.read(w.created.requirementId).version, intent });
  const terminal = lifecycle === "closed" ? w.state.finishClose({ requirementId: w.created.requirementId,
    version: closing.version, operationId: intent.operationId }) : closing;
  const path = await w.archive();
  await changeFixtureWorkspace(w, change);
  // 已退役现场即使出现不安全的docs别名，也不应成为当前主仓库索引的输入。
  if (change === "branch-changed") await fsp.symlink(w.root, join(w.worktree.root, "docs"));
  const attempted = denyBodyReads(w);
  const opendir = vi.spyOn(fsp, "opendir");
  syncBuiltinESMExports();
  const continuation = vi.fn();
  await expect(w.adapter.beforeArchiveRisk(w.hookEvent()).then(continuation)).resolves.toBeUndefined();
  expect(continuation).toHaveBeenCalledTimes(1);
  expect(w.state.read(w.created.requirementId)).toEqual(terminal);
  const closed = w.state.finishClose({ requirementId: w.created.requirementId,
    version: terminal.version, operationId: intent.operationId });
  await expect(w.adapter.beforeArchiveRisk(w.hookEvent())).resolves.toBeUndefined();
  expect(w.state.read(w.created.requirementId)).toEqual(closed);
  await fsp.rm(path);
  await expect(w.adapter.beforeArchiveRisk(w.hookEvent())).resolves.toBeUndefined();
  expect(w.state.read(w.created.requirementId)).toEqual(closed);
  expect(w.state.pmOwner(w.created.requirementId)).toMatchObject({ lease: null, fence: w.lease.fence + 1 });
  const sink = vi.fn();
  expect(() => w.events.consumePreparedDelivery({ lease: w.lease, handle: prepared.handle,
    contextGeneration: w.lease.contextGeneration, version: prepared.version }, sink)).toThrow(/unknown_delivery_handle/);
  expect(sink).not.toHaveBeenCalled();
  expect(opendir.mock.calls.map(([directory]) => String(directory)))
    .not.toContain(join(w.worktree.root, "docs", "prod"));
  expect(attempted).toEqual([]);
});

test.each(["removed", "branch-changed"] as const)("active的缺失或变化绑定仍拒绝hook与正文续接：%s", async (change) => {
  const w = await world();
  await w.archive();
  const before = w.state.read(w.created.requirementId);
  await changeFixtureWorkspace(w, change);
  const attempted = denyBodyReads(w);
  const continuation = vi.fn();
  await expect(w.adapter.beforeArchiveRisk(w.hookEvent()).then(continuation)).rejects.toMatchObject({
    code: change === "removed" ? "invalid_binding" : "workspace_binding_changed",
  });
  expect(continuation).not.toHaveBeenCalled();
  expect(w.state.read(w.created.requirementId)).toEqual(before);
  await expect(w.events.prepareCurrentBaseline({ lease: w.lease })).rejects.toBeDefined();
  expect(attempted).toEqual([]);
});

test("未知UUID不创建需求/授权；短前缀、标题或非UUIDv7文件不能匹配已知需求", async () => {
  const w = await world();
  const unknown = uuidv7();
  await w.archive(unknown);
  await w.archive(w.created.requirementId.slice(0, 8));
  await w.archive(w.created.requirementId.toUpperCase());
  await w.archive(w.created.requirementId.replace(/-7/, "-4"));
  const before = w.state.read(w.created.requirementId);
  const database = repositoryDatabase(w.options.dataRoot, w.options.repoId);
  const initial = withDatabase(database, (db) => db.events(`requirement_events:${w.created.requirementId}`));
  const calls = vi.spyOn(RequirementEventService.prototype, "reconcileArchiveRisk");
  const attempted = denyBodyReads(w);
  await w.adapter.beforeArchiveRisk(w.hookEvent());
  expect(calls).not.toHaveBeenCalled();
  expect(() => w.state.read(unknown)).toThrow(/unknown_requirement/);
  expect(w.state.read(w.created.requirementId)).toEqual(before);
  expect(withDatabase(database, (db) => db.events(`requirement_events:${w.created.requirementId}`))).toEqual(initial);
  expect(attempted).toEqual([]);
});

test("全量对账在初始化、溢出、重连/周期hook发现新增归档，不依赖新增路径事件", async () => {
  const w = await world();
  await w.adapter.beforeArchiveRisk(w.hookEvent());
  await w.archive(w.created.requirementId, "离线新增", w.worktree.root);
  const attempted = denyBodyReads(w);
  await w.adapter.beforeArchiveRisk(w.hookEvent(w.worktree.root, { path: null, overflowed: true, eventSequence: 4 }));
  assertBlocked(w);
  const before = w.state.read(w.created.requirementId);
  await w.adapter.close();
  const next = new ProjectIndexRequirements(w.options);
  cleanups.push(() => next.close());
  await next.beforeArchiveRisk(w.hookEvent(w.worktree.root));
  expect(w.state.read(w.created.requirementId)).toEqual(before);
  expect(attempted).toEqual([]);
});

test("同UUID不同描述及repo/绑定worktree的多路径按identity_conflict阻塞，九路径不绕过服务预算", async () => {
  const w = await world();
  const first = await w.archive(w.created.requirementId, "主目录");
  for (let i = 0; i < 8; i++) await w.archive(w.created.requirementId, `工作区${i}`, w.worktree.root);
  const attempted = denyBodyReads(w);
  const calls = vi.spyOn(RequirementEventService.prototype, "reconcileArchiveRisk");
  await w.adapter.beforeArchiveRisk(w.hookEvent());
  assertBlocked(w, "identity_conflict");
  expect(calls).toHaveBeenCalledTimes(1);
  expect(calls.mock.calls[0]![0].paths).toHaveLength(2);
  expect(new Set(calls.mock.calls[0]![0].paths).size).toBe(2);
  expect(calls.mock.calls[0]![0].paths.every((path) => path === first || path.startsWith(join(w.worktree.root, "docs", "prod")))).toBe(true);
  expect(attempted).toEqual([]);
});

test.each(["docs", "prod", "file", "hardlink", "subdirectory", "nested-repository", "unreadable"])("目录/文件不确定(%s)拒绝hook，不跟随链接或读正文", async (kind) => {
  const w = await world();
  const path = await w.archive();
  const target = join(w.root, "outside");
  await fsp.mkdir(target);
  if (kind === "docs") {
    await fsp.rm(join(w.repo.root, "docs"), { recursive: true });
    await fsp.symlink(target, join(w.repo.root, "docs"));
  } else if (kind === "prod") {
    await fsp.rm(join(w.repo.root, "docs", "prod"), { recursive: true });
    await fsp.symlink(target, join(w.repo.root, "docs", "prod"));
  } else if (kind === "file") {
    await fsp.rm(path);
    await fsp.symlink(join(w.options.dataRoot, "repos", w.options.repoId, "requirements", w.created.requirementId, "prod.md"), path);
  } else if (kind === "hardlink") {
    await fsp.link(path, join(target, "alias.md"));
  } else if (kind === "subdirectory") await fsp.mkdir(join(w.repo.root, "docs", "prod", "nested"));
  else if (kind === "nested-repository") await fsp.mkdir(join(w.repo.root, "docs", ".git"));
  else {
    await fsp.chmod(join(w.repo.root, "docs", "prod"), 0);
    cleanups.push(() => fsp.chmod(join(w.repo.root, "docs", "prod"), 0o700));
  }
  const attempted = denyBodyReads(w);
  const continuation = vi.fn();
  await expect(w.adapter.beforeArchiveRisk(w.hookEvent()).then(continuation)).rejects.toMatchObject({ code: "unsafe_archive_directory" });
  expect(continuation).not.toHaveBeenCalled();
  expect(attempted).toEqual([]);
});

test.each([{ maxEntries: 1 }, { maxMetadataBytes: 1 }])("元数据预算不足%j明确失败，不部分放行或读正文", async (limits) => {
  const w = await world();
  await w.archive();
  await w.archive(uuidv7());
  const adapter = new ProjectIndexRequirements({ ...w.options, ...limits });
  cleanups.push(() => adapter.close());
  const attempted = denyBodyReads(w);
  await expect(adapter.beforeArchiveRisk(w.hookEvent())).rejects.toMatchObject({ code: "metadata_limit" });
  expect(attempted).toEqual([]);
});

test("hook生命周期失败向上传播阻止后续通知；重试重新枚举，close后拒绝", async () => {
  const w = await world();
  await w.archive();
  const reconcile = RequirementEventService.prototype.reconcileArchiveRisk;
  vi.spyOn(RequirementEventService.prototype, "reconcileArchiveRisk").mockRejectedValueOnce(new Error("injected state failure"))
    .mockImplementation(reconcile);
  const continuation = vi.fn();
  await expect(w.adapter.beforeArchiveRisk(w.hookEvent()).then(continuation)).rejects.toThrow(/injected state failure/);
  expect(continuation).not.toHaveBeenCalled();
  await w.adapter.beforeArchiveRisk(w.hookEvent());
  assertBlocked(w);
  await w.adapter.close();
  await expect(w.adapter.beforeArchiveRisk(w.hookEvent())).rejects.toMatchObject({ code: "adapter_closed" });
});

test("伪repo/workspace/root/branch拒绝，不向生命周期服务扩权", async () => {
  const w = await world();
  await w.archive();
  const calls = vi.spyOn(RequirementEventService.prototype, "reconcileArchiveRisk");
  for (const change of [{ repoId: "a".repeat(64) }, { workspaceId: "a".repeat(64) },
    { branch: "refs/heads/forged" }, { root: join(w.repo.root, "docs") }]) {
    const event = w.hookEvent();
    await expect(w.adapter.beforeArchiveRisk({ ...event, workspace: { ...event.workspace, ...change } })).rejects.toMatchObject({ code: "invalid_binding" });
  }
  expect(calls).not.toHaveBeenCalled();
  expect(w.state.read(w.created.requirementId).data.recovery).toBe("ready");
});

test("事件服务授权仅允许open/精确repo、UUID及归档路径，正文Git缺失也能撤权", async () => {
  const w = await world();
  const path = await w.archive();
  const original = RequirementEventService.open;
  let checked = false;
  vi.spyOn(RequirementEventService, "open").mockImplementation(async (options) => {
    const authorize = options.authorize!;
    const valid = { action: "archive-risk" as const, repoId: w.options.repoId, requirementId: w.created.requirementId, archivePaths: [path] };
    expect(authorize(valid)).toBe(true);
    expect(authorize({ action: "open", repoId: w.options.repoId })).toBe(true);
    expect(authorize({ ...valid, repoId: "a".repeat(64) })).toBe(false);
    expect(authorize({ ...valid, requirementId: uuidv7() })).toBe(false);
    expect(authorize({ ...valid, archivePaths: [join(w.root, "wrong.md")] })).toBe(false);
    expect(authorize({ ...valid, action: "prepare-baseline" })).toBe(false);
    expect(authorize({ ...valid, action: "prepare-diff" })).toBe(false);
    expect(authorize({ ...valid, action: "consume" })).toBe(false);
    checked = true;
    return original(options);
  });
  const requirementRoot = join(w.options.dataRoot, "repos", w.options.repoId, "requirements", w.created.requirementId);
  await fsp.rename(requirementRoot, `${requirementRoot}.unavailable`);
  const attempted = denyBodyReads(w);
  await w.adapter.beforeArchiveRisk(w.hookEvent());
  assertBlocked(w);
  expect(checked).toBe(true);
  expect(attempted).toEqual([]);
});

test("无本机data.db的接入不因外来归档创建空需求库或授权", async () => {
  const w = await world();
  await w.archive(uuidv7());
  const dataRoot = join(w.root, "empty-private");
  const adapter = new ProjectIndexRequirements({ ...w.options, dataRoot });
  cleanups.push(() => adapter.close());
  const calls = vi.spyOn(RequirementEventService.prototype, "reconcileArchiveRisk");
  await adapter.beforeArchiveRisk(w.hookEvent());
  expect(calls).not.toHaveBeenCalled();
  expect(fs.existsSync(dataRoot)).toBe(false);
});

test("其他已登记worktree中的同UUID不匹配本需求绑定，不扩大撤权路径", async () => {
  const w = await world();
  const other = await addWorktree(w.repo);
  other.root = await fsp.realpath(other.root);
  await w.archive(w.created.requirementId, "非绑定工作区", other.root);
  const branch = `refs/heads/${other.branch}`;
  const event: ProjectIndexArchiveRiskHookEvent = { repositoryRoot: other.root,
    workspace: { root: other.root, branch, repoId: w.options.repoId, workspaceId: workspaceId(w.options.repoId, other.root, branch) },
    event: { path: null, eventSequence: 1, eventType: null, overflowed: false } };
  const before = w.state.read(w.created.requirementId);
  const calls = vi.spyOn(RequirementEventService.prototype, "reconcileArchiveRisk");
  await w.adapter.beforeArchiveRisk(event);
  expect(calls).not.toHaveBeenCalled();
  expect(w.state.read(w.created.requirementId)).toEqual(before);
});

test("close立即取消在途授权、等待hook真实结束，不继续生命周期调用", async () => {
  const w = await world();
  await w.archive();
  const original = fsp.opendir;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let entered!: () => void;
  const opened = new Promise<void>((resolve) => { entered = resolve; });
  vi.spyOn(fsp, "opendir").mockImplementationOnce(async (...args) => {
    entered();
    await gate;
    return original(...args);
  });
  syncBuiltinESMExports();
  cleanups.push(async () => { release(); });
  const calls = vi.spyOn(RequirementEventService.prototype, "reconcileArchiveRisk");
  const result = w.adapter.beforeArchiveRisk(w.hookEvent()).then(() => null, (error: unknown) => error);
  await opened;
  let closed = false;
  const closing = w.adapter.close().then(() => { closed = true; });
  await Promise.resolve();
  expect(closed).toBe(false);
  release();
  expect(await result).toMatchObject({ code: "adapter_closed" });
  await closing;
  expect(closed).toBe(true);
  expect(calls).not.toHaveBeenCalled();
});
