import { afterEach, expect, test } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { RequirementService } from "../src/modules/requirement/requirement-service.ts";
import type { RequirementServiceOptions } from "../src/modules/requirement/requirement-service.ts";
import { RequirementStateStore } from "../src/modules/requirement/requirement-state.ts";
import { manifestConfirmInput } from "./helpers/approval-fixture.ts";
import { REQUIREMENT_OPERATION_NAMESPACE } from "../src/modules/requirement/requirement-coordination.ts";
import { repositoryDatabase, uuidv7, withDatabase } from "../src/core/storage/database.ts";
import { repositoryIdentity } from "../src/core/storage/identity.ts";
import { addWorktree, createRepoFixture, GIT_ENV, removeRepoFixture } from "./helpers/repo-fixture.ts";
import { temporaryRoot } from "./helpers/temporary-root.ts";

const exec = promisify(execFile);
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function world() {
  const root = await mkdtemp(join(temporaryRoot(), "line-draft-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const repo = await createRepoFixture();
  cleanups.push(() => removeRepoFixture(repo));
  const identity = await repositoryIdentity(repo.root);
  const options: RequirementServiceOptions = { repositoryRoot: repo.root, dataRoot: join(root, "private"), repoId: identity.repoId, authorize: () => true, authorizeManifest: () => true };
  const open = (lines?: Record<string, readonly string[]>) => RequirementService.open({ ...options, ...(lines ? { lines } : {}) });
  return { repo, options, open };
}

const save = (service: RequirementService, requirementId: string, version: number, body: string) =>
  service.updateDraft({ requirementId, operationId: uuidv7(), version, title: "需求标题", body });

async function buildLineA(w: Awaited<ReturnType<typeof world>>, steps = 9) {
  const created = await w.open().then((service) => service.create({ requestId: uuidv7(), operationId: uuidv7(), title: "需求标题", body: "正文 v2" }));
  const requirementId = created.requirementId;
  const receipts = [created];
  for (let i = 1; i < steps; i++) {
    const service = await w.open({ [requirementId]: receipts.map((r) => r.anchor) });
    const previous = receipts.at(-1)!;
    receipts.push(await save(service, requirementId, previous.version, `正文 v${previous.version + 1}`));
  }
  return { requirementId, receipts, anchors: receipts.map((r) => r.anchor) };
}

const UNKNOWN_ANCHOR = "01900000-0000-7000-8000-000000000000";

test("create 的回执带锚点，版本号为 2", async () => {
  const w = await world();
  const created = await (await w.open()).create({ requestId: uuidv7(), operationId: uuidv7(), title: "需求标题", body: "正文" });
  expect(created.version).toBe(2);
  expect(created.anchor).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/);
});

test("回退到较早的线后，read 与 metadata 得到那条线上最后一次保存的内容和版本号", async () => {
  const w = await world();
  const a = await buildLineA(w);
  expect(a.receipts.map((r) => r.version)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10]);
  const lineB = a.anchors.slice(0, 4);
  const service = await w.open({ [a.requirementId]: lineB });
  expect((await service.read({ requirementId: a.requirementId, source: "saved" })).body).toBe("正文 v5");
  expect((await service.metadata(a.requirementId)).version).toBe(5);
});

test("照线上最后看到的版本号保存成功，这条线变成 N+1，原来的线不变", async () => {
  const w = await world();
  const a = await buildLineA(w);
  const lineB = a.anchors.slice(0, 4);
  const serviceB = await w.open({ [a.requirementId]: lineB });
  const receipt = await save(serviceB, a.requirementId, 5, "线 B 的新内容");
  expect(receipt.version).toBe(6);

  const serviceA = await w.open({ [a.requirementId]: a.anchors });
  expect((await serviceA.read({ requirementId: a.requirementId, source: "saved" })).body).toBe("正文 v10");
  expect((await serviceA.metadata(a.requirementId)).version).toBe(10);

  const serviceB2 = await w.open({ [a.requirementId]: [...lineB, receipt.anchor] });
  expect((await serviceB2.read({ requirementId: a.requirementId, source: "saved" })).body).toBe("线 B 的新内容");
  expect((await serviceB2.metadata(a.requirementId)).version).toBe(6);
});

test("在线上照别的线的版本号保存报 stale_version", async () => {
  const w = await world();
  const a = await buildLineA(w);
  const serviceB = await w.open({ [a.requirementId]: a.anchors.slice(0, 4) });
  await expect(save(serviceB, a.requirementId, 10, "不该成功")).rejects.toMatchObject({ code: "stale_version" });
});

test("线上没有这个需求的锚点时读到最近一次保存的那份，在这条线上保存后原线不变", async () => {
  const w = await world();
  const a = await buildLineA(w, 4);
  const empty = await w.open({});
  expect((await empty.read({ requirementId: a.requirementId, source: "saved" })).body).toBe("正文 v5");
  expect((await empty.metadata(a.requirementId)).version).toBe(5);

  const receipt = await save(empty, a.requirementId, 5, "空线上的新内容");
  expect(receipt.version).toBe(6);

  const original = await w.open({ [a.requirementId]: a.anchors });
  expect((await original.read({ requirementId: a.requirementId, source: "saved" })).body).toBe("正文 v5");
  expect((await original.metadata(a.requirementId)).version).toBe(5);
});

test("两个窗口停在同一步先后保存，两次都成功、版本号相同，各自读到自己保存的内容", async () => {
  const w = await world();
  const a = await buildLineA(w);
  const lineB = a.anchors.slice(0, 4);
  const first = await save(await w.open({ [a.requirementId]: lineB }), a.requirementId, 5, "窗口一的内容");
  const second = await save(await w.open({ [a.requirementId]: lineB }), a.requirementId, 5, "窗口二的内容");
  expect(first.version).toBe(6);
  expect(second.version).toBe(6);
  expect(second.anchor).not.toBe(first.anchor);

  const readOf = async (anchor: string) =>
    (await (await w.open({ [a.requirementId]: [...lineB, anchor] })).read({ requirementId: a.requirementId, source: "saved" })).body;
  expect(await readOf(first.anchor)).toBe("窗口一的内容");
  expect(await readOf(second.anchor)).toBe("窗口二的内容");
});

test("线上最后一个锚点在库里找不到时，读取不报错，用最近一次保存的那份", async () => {
  const w = await world();
  const a = await buildLineA(w);
  const service = await w.open({ [a.requirementId]: [...a.anchors.slice(0, 4), UNKNOWN_ANCHOR] });
  const result = await service.read({ requirementId: a.requirementId, source: "saved" });
  expect(result.body).toBe("正文 v10");
  expect((await service.metadata(a.requirementId)).version).toBe(10);
});

test("已批准的需求，不传线和传任意线时 read source=approved 结果相同", async () => {
  const w = await world();
  const service = await w.open();
  const created = await service.create({ requestId: uuidv7(), operationId: uuidv7(), title: "需求标题", body: "批准正文" });
  const state = await RequirementStateStore.open({ ...w.options, authorize: () => true });
  const worktree = await addWorktree(w.repo);
  const baseCommit = (await exec("git", ["rev-parse", "HEAD"], { cwd: worktree.root, env: GIT_ENV })).stdout.trim();
  await state.bindWorkspace({ requirementId: created.requirementId, version: state.read(created.requirementId).version, path: worktree.root, prepareOperationId: uuidv7(), baseCommit });
  await service.confirmUpdate(await manifestConfirmInput(w.options, { requirementId: created.requirementId, savedOperationId: created.operationId }));

  const plain = await service.read({ requirementId: created.requirementId, source: "approved" });
  const withLine = await (await w.open({ [created.requirementId]: [UNKNOWN_ANCHOR, created.anchor] })).read({ requirementId: created.requirementId, source: "approved" });
  expect(withLine).toEqual(plain);
  expect(plain.body).toBe("批准正文");
});

test("内容和当前线上那一版相同的保存不产生新锚点，版本号不变", async () => {
  const w = await world();
  const a = await buildLineA(w, 2);
  const requirementId = a.requirementId;
  const v3 = a.receipts[1]!;
  expect(v3.version).toBe(3);
  const lineAnchors = () => withDatabase(repositoryDatabase(w.options.dataRoot, w.options.repoId), (db) =>
    db.list<{ requirementId: string }>("line_anchors").filter((row) => row.data.requirementId === requirementId)).length;
  const before = lineAnchors();

  const service = await w.open({ [requirementId]: a.anchors });
  const again = await save(service, requirementId, 3, "正文 v3");
  expect(again.version).toBe(3);
  expect(again.anchor).toBe(v3.anchor);
  expect(lineAnchors()).toBe(before);
});

const anchorRecord = (w: Awaited<ReturnType<typeof world>>, anchor: string) =>
  withDatabase(repositoryDatabase(w.options.dataRoot, w.options.repoId), (db) =>
    db.list<{ anchor: string; fileCommit: string | null }>("line_anchors").map((row) => row.data).find((record) => record.anchor === anchor));

async function approve(w: Awaited<ReturnType<typeof world>>, service: RequirementService, created: { requirementId: string; operationId: string }) {
  const state = await RequirementStateStore.open({ ...w.options, authorize: () => true });
  const worktree = await addWorktree(w.repo);
  const baseCommit = (await exec("git", ["rev-parse", "HEAD"], { cwd: worktree.root, env: GIT_ENV })).stdout.trim();
  await state.bindWorkspace({ requirementId: created.requirementId, version: state.read(created.requirementId).version, path: worktree.root, prepareOperationId: uuidv7(), baseCommit });
  await service.confirmUpdate(await manifestConfirmInput(w.options, { requirementId: created.requirementId, savedOperationId: created.operationId }));
}

test("线上最后一个锚点在库里找不到时，read 与 metadata 的结果带恢复失败原因", async () => {
  const w = await world();
  const a = await buildLineA(w);
  const service = await w.open({ [a.requirementId]: [...a.anchors.slice(0, 4), UNKNOWN_ANCHOR] });
  const read = await service.read({ requirementId: a.requirementId, source: "saved" });
  expect(read.body).toBe("正文 v10");
  expect(read.version).toBe(10);
  expect(typeof (read as { restoreFailure?: unknown }).restoreFailure).toBe("string");
  expect(typeof (await service.metadata(a.requirementId) as { restoreFailure?: unknown }).restoreFailure).toBe("string");
});

test("锚点存在但它那次保存的正文在需求文件仓库里读不出时，read 不报错，用最近一次保存的那份并带恢复失败原因", async () => {
  const w = await world();
  const a = await buildLineA(w);
  const lineB = a.anchors.slice(0, 4);
  const commit = anchorRecord(w, lineB.at(-1)!)!.fileCommit!;
  const storage = join(w.options.dataRoot, "repos", w.options.repoId, "requirements", a.requirementId);
  const blob = (await exec("git", ["rev-parse", `${commit}:prd.md`], { cwd: storage, env: GIT_ENV })).stdout.trim();
  await rm(join(storage, ".git", "objects", blob.slice(0, 2), blob.slice(2)));

  const service = await w.open({ [a.requirementId]: lineB });
  const read = await service.read({ requirementId: a.requirementId, source: "saved" });
  expect(read.body).toBe("正文 v10");
  expect(read.version).toBe(10);
  expect(typeof (read as { restoreFailure?: unknown }).restoreFailure).toBe("string");
});

test("锚点和提交都正常时，结果里没有恢复失败字段", async () => {
  const w = await world();
  const a = await buildLineA(w);
  const service = await w.open({ [a.requirementId]: a.anchors.slice(0, 4) });
  expect(await service.read({ requirementId: a.requirementId, source: "saved" })).not.toHaveProperty("restoreFailure");
  expect(await service.metadata(a.requirementId)).not.toHaveProperty("restoreFailure");
});

test("已批准的需求保存相同正文，回执里的锚点是库里真实存在的锚点", async () => {
  const w = await world();
  const service = await w.open();
  const created = await service.create({ requestId: uuidv7(), operationId: uuidv7(), title: "需求标题", body: "批准正文" });
  await approve(w, service, created);

  const version = (await service.metadata(created.requirementId)).version;
  const receipt = await save(service, created.requirementId, version, "批准正文");
  expect(anchorRecord(w, receipt.anchor)).toBeDefined();

  const reader = await w.open({ [created.requirementId]: [receipt.anchor] });
  expect(await reader.read({ requirementId: created.requirementId, source: "saved" })).not.toHaveProperty("restoreFailure");
});

test("已批准的需求在不同的线上，metadata 和批准后修订草稿的 read 结果相同", async () => {
  const w = await world();
  const service = await w.open();
  const created = await service.create({ requestId: uuidv7(), operationId: uuidv7(), title: "需求标题", body: "批准正文" });
  await approve(w, service, created);
  const version = (await service.metadata(created.requirementId)).version;
  const revised = await save(service, created.requirementId, version, "批准后又改了一版");

  const lines = [[], [UNKNOWN_ANCHOR], [created.anchor], [revised.anchor]];
  const results = [];
  for (const line of lines) {
    const reader = await w.open({ [created.requirementId]: line });
    results.push({ metadata: await reader.metadata(created.requirementId), saved: await reader.read({ requirementId: created.requirementId, source: "saved" }) });
  }
  for (const result of results.slice(1)) expect(result).toEqual(results[0]);
  expect(results[0]!.saved.body).toBe("批准后又改了一版");
});

test("线 B 从线 A 的版本 3 分叉后保存，不含锚点的新线读到线 B 那次保存的内容和版本号", async () => {
  const w = await world();
  const a = await buildLineA(w, 4);
  expect(a.receipts.map((r) => r.version)).toEqual([2, 3, 4, 5]);
  const serviceB = await w.open({ [a.requirementId]: a.anchors.slice(0, 2) });
  const receipt = await save(serviceB, a.requirementId, 3, "线 B 的内容");
  expect(receipt.version).toBe(4);

  const fresh = await w.open({ [a.requirementId]: [] });
  const read = await fresh.read({ requirementId: a.requirementId, source: "saved" });
  expect(read.body).toBe("线 B 的内容");
  expect(read.version).toBe(4);
  expect((await fresh.metadata(a.requirementId)).version).toBe(4);
});

test("线尖正文读得出但和记的指纹对不上时，read 报错，不退回最近一次保存", async () => {
  const w = await world();
  const a = await buildLineA(w);
  const lineB = a.anchors.slice(0, 4);
  const commit = anchorRecord(w, lineB.at(-1)!)!.fileCommit!;
  withDatabase(repositoryDatabase(w.options.dataRoot, w.options.repoId), (db) => {
    const row = db.list<{ requirementId: string; git: { commit: string; hash: string } | null }>(REQUIREMENT_OPERATION_NAMESPACE)
      .find((stored) => stored.data.requirementId === a.requirementId && stored.data.git?.commit === commit)!;
    db.update(REQUIREMENT_OPERATION_NAMESPACE, row.key, row.version, { ...row.data, git: { commit, hash: "0".repeat(64) } });
  });

  const service = await w.open({ [a.requirementId]: lineB });
  await expect(service.read({ requirementId: a.requirementId, source: "saved" })).rejects.toThrow();
});

test("线尖就是最近一次保存、正文在需求文件仓库里读不出时，read 报错，不退回", async () => {
  const w = await world();
  const a = await buildLineA(w);
  const commit = anchorRecord(w, a.anchors.at(-1)!)!.fileCommit!;
  const storage = join(w.options.dataRoot, "repos", w.options.repoId, "requirements", a.requirementId);
  const blob = (await exec("git", ["rev-parse", `${commit}:prd.md`], { cwd: storage, env: GIT_ENV })).stdout.trim();
  await rm(join(storage, ".git", "objects", blob.slice(0, 2), blob.slice(2)));

  const service = await w.open({ [a.requirementId]: a.anchors });
  await expect(service.read({ requirementId: a.requirementId, source: "saved" })).rejects.toThrow();
});
