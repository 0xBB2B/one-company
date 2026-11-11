import { afterEach, expect, test, vi } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { RequirementService } from "../src/modules/requirement/requirement-service.ts";
import type { RequirementServiceOptions } from "../src/modules/requirement/requirement-service.ts";
import { RequirementOperations } from "../src/modules/requirement/requirement-operations.ts";
import { RequirementStateStore } from "../src/modules/requirement/requirement-state.ts";
import { claimRequirementWriteIn, REQUIREMENT_OPERATION_NAMESPACE } from "../src/modules/requirement/requirement-coordination.ts";
import { repositoryDatabase, uuidv7, withDatabase } from "../src/core/storage/database.ts";
import { repositoryIdentity } from "../src/core/storage/identity.ts";
import { addWorktree, createRepoFixture, GIT_ENV, removeRepoFixture } from "./helpers/repo-fixture.ts";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { temporaryRoot } from "./helpers/temporary-root.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function world() {
  const root = await mkdtemp(join(temporaryRoot(), "line-abandoned-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const repo = await createRepoFixture();
  cleanups.push(() => removeRepoFixture(repo));
  const identity = await repositoryIdentity(repo.root);
  const options: RequirementServiceOptions = { repositoryRoot: repo.root, dataRoot: join(root, "private"), repoId: identity.repoId, authorize: () => true, authorizeManifest: () => true };
  const open = (lines?: Record<string, readonly string[]>) => RequirementService.open({ ...options, ...(lines ? { lines } : {}) });
  const database = () => repositoryDatabase(options.dataRoot, options.repoId);
  return { repo, options, open, database };
}
type World = Awaited<ReturnType<typeof world>>;

const input = (requirementId: string, version: number, body: string, operationId = uuidv7()) =>
  ({ requirementId, operationId, version, title: "需求标题", body });

// 线 A 版本 2..5，线 B 从版本 3 分出（线 A 的前两个锚点）
async function buildLineA(w: World) {
  const created = await w.open().then((service) => service.create({ requestId: uuidv7(), operationId: uuidv7(), title: "需求标题", body: "正文 v2" }));
  const requirementId = created.requirementId;
  const receipts = [created];
  for (let i = 1; i < 4; i++) {
    const service = await w.open({ [requirementId]: receipts.map((r) => r.anchor) });
    const previous = receipts.at(-1)!;
    receipts.push(await service.updateDraft(input(requirementId, previous.version, `正文 v${previous.version + 1}`)));
  }
  const anchors = receipts.map((r) => r.anchor);
  return { requirementId, anchors, lineB: anchors.slice(0, 2) };
}

// 保存已把 Git 结果记下，但在登记版本号时出错
async function leaveGitRecordedSave(w: World, a: Pick<Awaited<ReturnType<typeof buildLineA>>, "requirementId" | "anchors">, body = "停在半路的正文", version = 5) {
  const unfinished = input(a.requirementId, version, body);
  const original = RequirementStateStore.prototype.recordSavedVersion;
  vi.spyOn(RequirementStateStore.prototype, "recordSavedVersion").mockImplementationOnce(() => {
    throw new Error("injected saved-version failure");
  }).mockImplementation(original);
  await expect((await w.open({ [a.requirementId]: a.anchors })).updateDraft(unfinished)).rejects.toThrow(/saved-version failure/);
  return unfinished;
}

// 保存开始了，但 Git 结果没来得及记下
async function leaveUnrecordedSave(w: World, a: Awaited<ReturnType<typeof buildLineA>>, body = "没记下 Git 结果的正文") {
  const unfinished = input(a.requirementId, 5, body);
  const original = RequirementOperations.prototype.recordGitResult;
  vi.spyOn(RequirementOperations.prototype, "recordGitResult").mockImplementationOnce(() => {
    throw new Error("injected git-result failure");
  }).mockImplementation(original);
  await expect((await w.open({ [a.requirementId]: a.anchors })).updateDraft(unfinished)).rejects.toThrow(/git-result failure/);
  return unfinished;
}

const operationOf = (w: World, operationId: string) =>
  withDatabase(w.database(), (db) => db.read<{ finalVersion: number | null }>(REQUIREMENT_OPERATION_NAMESPACE, operationId));
const operationAnchorOf = (w: World, operationId: string) =>
  withDatabase(w.database(), (db) => db.read<{ anchor: string }>("line_operation_anchors", operationId));
const anchorRecordOf = (w: World, anchor: string) =>
  withDatabase(w.database(), (db) => db.list<{ anchor: string }>("line_anchors").find((row) => row.data.anchor === anchor));

test("Git 结果已记下、占用已释放的半路保存：线 B 保存成功，版本号为线 B 线尖加 1", async () => {
  const w = await world();
  const a = await buildLineA(w);
  await leaveGitRecordedSave(w, a);
  const receipt = await (await w.open({ [a.requirementId]: a.lineB })).updateDraft(input(a.requirementId, 3, "线 B 的正文"));
  expect(receipt.version).toBe(4);
});

test("Git 结果已记下、占用已释放的半路保存：被补记成正常保存，有锚点，用它的锚点能读到它的正文", async () => {
  const w = await world();
  const a = await buildLineA(w);
  const unfinished = await leaveGitRecordedSave(w, a);
  await (await w.open({ [a.requirementId]: a.lineB })).updateDraft(input(a.requirementId, 3, "线 B 的正文"));

  expect(operationOf(w, unfinished.operationId)!.data.finalVersion).not.toBeNull();
  const anchor = operationAnchorOf(w, unfinished.operationId)!.data.anchor;
  expect(anchorRecordOf(w, anchor)).toBeDefined();
  const read = await (await w.open({ [a.requirementId]: [anchor] })).read({ requirementId: a.requirementId, source: "saved" });
  expect(read.body).toBe("停在半路的正文");
});

test("Git 结果已记下、占用进程已不存在的半路保存：线 B 保存成功并把它补记", async () => {
  const w = await world();
  const a = await buildLineA(w);
  const unfinished = await leaveGitRecordedSave(w, a);
  const child = spawn("true");
  await new Promise((resolve) => child.once("exit", resolve));
  withDatabase(w.database(), (db) => db.transaction(() => {
    claimRequirementWriteIn(db, { repoId: w.options.repoId, requirementId: a.requirementId, operationId: unfinished.operationId, ownerToken: uuidv7(), pid: child.pid!, acquiredAt: 1 }, { allowDeadOriginalOperationRecovery: false });
  }));

  const receipt = await (await w.open({ [a.requirementId]: a.lineB })).updateDraft(input(a.requirementId, 3, "线 B 的正文"));
  expect(receipt.version).toBe(4);
  expect(operationOf(w, unfinished.operationId)!.data.finalVersion).not.toBeNull();
});

test("Git 结果没记下但已提交进 Git、没人在做的半路保存：线 B 保存成功，那次保存被补记成正常保存，线 A 不变", async () => {
  const w = await world();
  const a = await buildLineA(w);
  const unfinished = await leaveUnrecordedSave(w, a);
  const receipt = await (await w.open({ [a.requirementId]: a.lineB })).updateDraft(input(a.requirementId, 3, "线 B 的正文"));
  expect(receipt.version).toBe(4);

  expect(operationOf(w, unfinished.operationId)!.data.finalVersion).not.toBeNull();
  const recoveredAnchor = operationAnchorOf(w, unfinished.operationId)!.data.anchor;
  expect(anchorRecordOf(w, recoveredAnchor)).toBeDefined();
  const recoveredRead = await (await w.open({ [a.requirementId]: [recoveredAnchor] })).read({ requirementId: a.requirementId, source: "saved" });
  expect(recoveredRead.body).toBe("没记下 Git 结果的正文");
  const lineA = await w.open({ [a.requirementId]: a.anchors });
  const read = await lineA.read({ requirementId: a.requirementId, source: "saved" });
  expect(read.body).toBe("正文 v5");
  expect(read.version).toBe(5);
});

test("半路保存的写占用还在、占用进程还活着：线 B 保存报 requirement_write_busy", async () => {
  const w = await world();
  const a = await buildLineA(w);
  const unfinished = await leaveGitRecordedSave(w, a);
  const child = spawn("sleep", ["600"], { stdio: "ignore" });
  cleanups.push(async () => { child.kill(); });
  withDatabase(w.database(), (db) => db.transaction(() => {
    claimRequirementWriteIn(db, { repoId: w.options.repoId, requirementId: a.requirementId, operationId: unfinished.operationId, ownerToken: uuidv7(), pid: child.pid!, acquiredAt: 1 }, { allowDeadOriginalOperationRecovery: false });
  }));

  await expect((await w.open({ [a.requirementId]: a.lineB })).updateDraft(input(a.requirementId, 3, "线 B 的正文"))).rejects.toMatchObject({ code: "requirement_write_busy" });
});

test("半路保存就在当前线上：用原 operationId 配不同内容报 requirement_write_pending，用原内容能续完", async () => {
  const w = await world();
  const a = await buildLineA(w);
  const unfinished = await leaveGitRecordedSave(w, a);
  const service = await w.open({ [a.requirementId]: a.anchors });
  await expect(service.updateDraft({ ...unfinished, body: "别的正文" })).rejects.toMatchObject({ code: "requirement_write_pending" });

  const resumed = await service.updateDraft(unfinished);
  expect(resumed.status).toBe("saved");
  expect(resumed.version).toBe(6);
  expect(operationOf(w, unfinished.operationId)!.data.finalVersion).toBe(6);
});

test("线 B 的调用只带线 B 自己的内容和版本号，保存后线 B 读到的是线 B 的正文", async () => {
  const w = await world();
  const a = await buildLineA(w);
  await leaveUnrecordedSave(w, a);
  const receipt = await (await w.open({ [a.requirementId]: a.lineB })).updateDraft(input(a.requirementId, 3, "线 B 的正文"));
  const read = await (await w.open({ [a.requirementId]: [...a.lineB, receipt.anchor] })).read({ requirementId: a.requirementId, source: "saved" });
  expect(read.body).toBe("线 B 的正文");
  expect(read.version).toBe(4);
});

test("空线上保存同样能绕过别的线上的半路保存：版本号为空线读到的版本加 1", async () => {
  const w = await world();
  const a = await buildLineA(w);
  await leaveUnrecordedSave(w, a);
  const empty = await w.open({});
  const version = (await empty.metadata(a.requirementId)).version;
  const receipt = await empty.updateDraft(input(a.requirementId, version, "空线的正文"));
  expect(receipt.version).toBe(version + 1);
});

test("半路保存的结果已写进需求记录、之后需求记录又被改过：别处保存触发处理后，那次保存的锚点在库里，放进线上读不带恢复失败原因", async () => {
  const w = await world();
  const a = await buildLineA(w);
  const unfinished = input(a.requirementId, 5, "停在半路的正文");
  const original = RequirementOperations.prototype.recordSavedVersion;
  vi.spyOn(RequirementOperations.prototype, "recordSavedVersion").mockImplementationOnce(() => {
    throw new Error("injected operation saved-version failure");
  }).mockImplementation(original);
  await expect((await w.open({ [a.requirementId]: a.anchors })).updateDraft(unfinished)).rejects.toThrow(/saved-version failure/);

  const state = await RequirementStateStore.open({ ...w.options, authorize: () => true });
  const worktree = await addWorktree(w.repo);
  const baseCommit = (await promisify(execFile)("git", ["rev-parse", "HEAD"], { cwd: worktree.root, env: GIT_ENV })).stdout.trim();
  await state.bindWorkspace({ requirementId: a.requirementId, version: state.read(a.requirementId).version, path: worktree.root, prepareOperationId: uuidv7(), baseCommit });

  const receipt = await (await w.open({ [a.requirementId]: a.lineB })).updateDraft(input(a.requirementId, 3, "线 B 的正文"));
  expect(receipt.version).toBe(4);

  const anchor = operationAnchorOf(w, unfinished.operationId)?.data.anchor;
  expect(anchor).toBeDefined();
  expect(anchorRecordOf(w, anchor!)).toBeDefined();
  const read = await (await w.open({ [a.requirementId]: [anchor!] })).read({ requirementId: a.requirementId, source: "saved" });
  expect(read).not.toHaveProperty("restoreFailure");
});

test("空线保存时别处停在半路、Git 结果已记下的保存被补记：新保存仍接在开始时的版本 3 后面，版本号 4，父提交是版本 3 的提交", async () => {
  const w = await world();
  const created = await w.open().then((service) => service.create({ requestId: uuidv7(), operationId: uuidv7(), title: "需求标题", body: "正文 v2" }));
  const requirementId = created.requirementId;
  const v3 = await (await w.open({ [requirementId]: [created.anchor] })).updateDraft(input(requirementId, 2, "正文 v3"));
  expect(v3.version).toBe(3);
  const unfinished = await leaveGitRecordedSave(w, { requirementId, anchors: [created.anchor, v3.anchor] }, "停在半路的正文", 3);

  const empty = await w.open({});
  expect((await empty.metadata(requirementId)).version).toBe(3);
  const receipt = await empty.updateDraft(input(requirementId, 3, "空线的正文"));
  expect(receipt.version).toBe(4);

  const recovered = operationAnchorOf(w, unfinished.operationId)!.data.anchor;
  const parentOf = (anchor: string) => withDatabase(w.database(), (db) => db.list<{ anchor: string; parent: string | null; fileCommit: string }>("line_anchors")).map((row) => row.data).find((row) => row.anchor === anchor)!;
  expect(parentOf(receipt.anchor).parent).toBe(v3.anchor);
  expect(parentOf(receipt.anchor).parent).not.toBe(recovered);
  const storage = join(w.options.dataRoot, "repos", w.options.repoId, "requirements", requirementId);
  const gitParent = (await promisify(execFile)("git", ["rev-parse", `${parentOf(receipt.anchor).fileCommit}^`], { cwd: storage, env: GIT_ENV })).stdout.trim();
  expect(gitParent).toBe(parentOf(v3.anchor).fileCommit);
});

const gitIn = (w: World, requirementId: string, ...args: string[]) =>
  promisify(execFile)("git", args, { cwd: join(w.options.dataRoot, "repos", w.options.repoId, "requirements", requirementId), env: GIT_ENV }).then((result) => result.stdout.trim());

// 保存已把 HEAD 推进到新提交，但还没建线引用、也没登记 Git 结果
async function leaveHeadAdvancedSave(w: World, a: Awaited<ReturnType<typeof buildLineA>>, body = "推进了 HEAD 的正文") {
  const unfinished = await leaveUnrecordedSave(w, a, body);
  const anchor = operationAnchorOf(w, unfinished.operationId)!.data.anchor;
  await gitIn(w, a.requirementId, "update-ref", "-d", `refs/lines/${anchor}`);
  return unfinished;
}

// 保存已把正文写进 prd.md，但还没提交
async function leaveFileWrittenSave(w: World, a: Awaited<ReturnType<typeof buildLineA>>, body = "写了文件没提交的正文") {
  const unfinished = await leaveUnrecordedSave(w, a, body);
  const anchor = operationAnchorOf(w, unfinished.operationId)!.data.anchor;
  const parent = await gitIn(w, a.requirementId, "rev-parse", "HEAD^");
  await gitIn(w, a.requirementId, "update-ref", "-d", `refs/lines/${anchor}`);
  await gitIn(w, a.requirementId, "update-ref", "HEAD", parent);
  await gitIn(w, a.requirementId, "read-tree", "HEAD");
  return unfinished;
}

test("已推进 HEAD、没建线引用也没登记 Git 结果的半路保存：线 B 保存成功，版本号为线 B 线尖加 1", async () => {
  const w = await world();
  const a = await buildLineA(w);
  await leaveHeadAdvancedSave(w, a);
  const receipt = await (await w.open({ [a.requirementId]: a.lineB })).updateDraft(input(a.requirementId, 3, "线 B 的正文"));
  expect(receipt.version).toBe(4);
});

test("已推进 HEAD、没建线引用也没登记 Git 结果的半路保存：被补记成正常保存，保存锚点排在线 B 这次保存之前，用它的锚点能读到它的正文", async () => {
  const w = await world();
  const a = await buildLineA(w);
  const unfinished = await leaveHeadAdvancedSave(w, a);
  const receipt = await (await w.open({ [a.requirementId]: a.lineB })).updateDraft(input(a.requirementId, 3, "线 B 的正文"));

  expect(operationOf(w, unfinished.operationId)!.data.finalVersion).not.toBeNull();
  const anchor = operationAnchorOf(w, unfinished.operationId)!.data.anchor;
  const recovered = withDatabase(w.database(), (db) => db.list<{ anchor: string; sequence: number }>("line_anchors").map((row) => row.data));
  const recoveredRecord = recovered.find((record) => record.anchor === anchor);
  expect(recoveredRecord).toBeDefined();
  expect(recoveredRecord!.sequence).toBeLessThan(recovered.find((record) => record.anchor === receipt.anchor)!.sequence);
  const read = await (await w.open({ [a.requirementId]: [anchor] })).read({ requirementId: a.requirementId, source: "saved" });
  expect(read.body).toBe("推进了 HEAD 的正文");
});

test("已推进 HEAD、没建线引用也没登记 Git 结果的半路保存被线 B 补记后：线 B 续存、空线保存、线 A 带补记锚点保存都成功", async () => {
  const w = await world();
  const a = await buildLineA(w);
  const unfinished = await leaveHeadAdvancedSave(w, a);
  const first = await (await w.open({ [a.requirementId]: a.lineB })).updateDraft(input(a.requirementId, 3, "线 B 的正文"));

  const second = await (await w.open({ [a.requirementId]: [...a.lineB, first.anchor] })).updateDraft(input(a.requirementId, 4, "线 B 的正文二"));
  expect(second.version).toBe(5);
  const empty = await w.open({});
  const emptyVersion = (await empty.metadata(a.requirementId)).version;
  expect((await empty.updateDraft(input(a.requirementId, emptyVersion, "空线的正文"))).version).toBe(emptyVersion + 1);
  const recovered = operationAnchorOf(w, unfinished.operationId)!.data.anchor;
  const lineA = await w.open({ [a.requirementId]: [...a.anchors, recovered] });
  const lineAVersion = (await lineA.metadata(a.requirementId)).version;
  expect((await lineA.updateDraft(input(a.requirementId, lineAVersion, "线 A 的后续正文"))).version).toBe(lineAVersion + 1);
});

test("写完正文文件、还没提交的半路保存：线 B 用不同正文保存成功，版本号为线 B 线尖加 1", async () => {
  const w = await world();
  const a = await buildLineA(w);
  const unfinished = await leaveFileWrittenSave(w, a);
  const receipt = await (await w.open({ [a.requirementId]: a.lineB })).updateDraft(input(a.requirementId, 3, "线 B 的正文"));
  expect(receipt.version).toBe(4);
  const read = await (await w.open({ [a.requirementId]: [...a.lineB, receipt.anchor] })).read({ requirementId: a.requirementId, source: "saved" });
  expect(read.body).toBe("线 B 的正文");
  expect(operationOf(w, unfinished.operationId)).toBeNull();
  expect(operationAnchorOf(w, unfinished.operationId)).toBeNull();
  const storage = join(w.options.dataRoot, "repos", w.options.repoId, "requirements", a.requirementId);
  const working = await readFile(join(storage, "prd.md"), "utf8");
  expect(working).toBe(await gitIn(w, a.requirementId, "show", "HEAD:prd.md").then((text) => text));
  expect(working).not.toContain("写了文件没提交的正文");
});

const saveOnLineB = (w: World, a: Pick<Awaited<ReturnType<typeof buildLineA>>, "requirementId" | "lineB">, body = "线 B 的正文") =>
  w.open({ [a.requirementId]: a.lineB }).then((service) => service.updateDraft(input(a.requirementId, 3, body)));

function expectRecoveredAsNormalSave(w: World, a: { requirementId: string }, unfinished: { operationId: string }) {
  expect(operationOf(w, unfinished.operationId)!.data.finalVersion).not.toBeNull();
  const anchor = operationAnchorOf(w, unfinished.operationId)!.data.anchor;
  expect(anchorRecordOf(w, anchor)).toBeDefined();
  return anchor;
}

test("已提交进 Git 的半路保存之后需求记录被别的写入改了版本号：线 B 保存成功，那次保存被补记，用它的锚点能读到它的正文", async () => {
  const w = await world();
  const a = await buildLineA(w);
  const unfinished = await leaveUnrecordedSave(w, a);
  const state = await RequirementStateStore.open({ ...w.options, authorize: () => true });
  const worktree = await addWorktree(w.repo);
  const baseCommit = (await promisify(execFile)("git", ["rev-parse", "HEAD"], { cwd: worktree.root, env: GIT_ENV })).stdout.trim();
  await state.bindWorkspace({ requirementId: a.requirementId, version: state.read(a.requirementId).version, path: worktree.root, prepareOperationId: uuidv7(), baseCommit });

  const receipt = await saveOnLineB(w, a);
  expect(receipt.version).toBe(4);
  const anchor = expectRecoveredAsNormalSave(w, a, unfinished);
  const read = await (await w.open({ [a.requirementId]: [anchor] })).read({ requirementId: a.requirementId, source: "saved" });
  expect(read.body).toBe("没记下 Git 结果的正文");
});

test("半路保存停在 HEAD 已推进、暂存区还是旧正文：当前线的线尖不是最近一次保存，线 B 保存成功，那次保存被补记", async () => {
  const w = await world();
  const a = await buildLineA(w);
  const unfinished = await leaveHeadAdvancedSave(w, a);
  await gitIn(w, a.requirementId, "read-tree", "HEAD^");

  const receipt = await saveOnLineB(w, a);
  expect(receipt.version).toBe(4);
  expectRecoveredAsNormalSave(w, a, unfinished);
});

const BUSY_OR_OK = (outcome: PromiseSettledResult<unknown>) =>
  outcome.status === "fulfilled" || (outcome.reason as { code?: string }).code === "requirement_write_busy";

test("处理半路保存的同时线 A 窗口把它原样续完：两边要么成功要么被告知 requirement_write_busy，之后空线保存正常", async () => {
  const w = await world();
  const a = await buildLineA(w);
  const unfinished = await leaveUnrecordedSave(w, a);
  const original = RequirementOperations.prototype.settleAbandonedGit;
  let resumed: Promise<unknown> = Promise.resolve();
  vi.spyOn(RequirementOperations.prototype, "settleAbandonedGit").mockImplementationOnce(function (this: RequirementOperations, ...args: Parameters<typeof original>) {
    resumed = (async () => (await w.open({ [a.requirementId]: a.anchors })).updateDraft(unfinished))();
    resumed.catch(() => undefined);
    return original.apply(this, args);
  }).mockImplementation(original);

  const outcomes = await Promise.allSettled([saveOnLineB(w, a), resumed.then(() => undefined)]);
  const resumeOutcome = (await Promise.allSettled([resumed]))[0]!;
  expect(BUSY_OR_OK(outcomes[0]!)).toBe(true);
  expect(BUSY_OR_OK(resumeOutcome)).toBe(true);

  const empty = await w.open({});
  const version = (await empty.metadata(a.requirementId)).version;
  expect((await empty.updateDraft(input(a.requirementId, version, "空线的正文"))).version).toBe(version + 1);
});

test("两个窗口同时处理同一个半路保存：至少一个保存成功，另一个成功或被告知 requirement_write_busy，那次保存被补记，之后空线保存正常", async () => {
  const w = await world();
  const a = await buildLineA(w);
  const unfinished = await leaveUnrecordedSave(w, a);

  const outcomes = await Promise.allSettled([saveOnLineB(w, a, "窗口一的正文"), saveOnLineB(w, a, "窗口二的正文")]);
  expect(outcomes.some((outcome) => outcome.status === "fulfilled")).toBe(true);
  expect(outcomes.every(BUSY_OR_OK)).toBe(true);
  expectRecoveredAsNormalSave(w, a, unfinished);

  const empty = await w.open({});
  const version = (await empty.metadata(a.requirementId)).version;
  expect((await empty.updateDraft(input(a.requirementId, version, "空线的正文"))).version).toBe(version + 1);
});

test("B 窗口读出半路保存候选之后、拿写占用之前，窗口 C 处理掉它（没提交，记录被删，工作副本已恢复）：B 的保存成功或被告知稍后再试，不报 operation_corrupt", async () => {
  const w = await world();
  const a = await buildLineA(w);
  const unfinished = await leaveFileWrittenSave(w, a);
  const storage = join(w.options.dataRoot, "repos", w.options.repoId, "requirements", a.requirementId);
  const original = RequirementOperations.prototype.settleAbandonedGit;
  vi.spyOn(RequirementOperations.prototype, "settleAbandonedGit").mockImplementationOnce(function (this: RequirementOperations, requirementId, currentOperationId, configOf) {
    return original.call(this, requirementId, currentOperationId, (operation) => {
      withDatabase(w.database(), (db) => db.transaction(() => {
        const record = db.read(REQUIREMENT_OPERATION_NAMESPACE, unfinished.operationId);
        if (record) db.remove(REQUIREMENT_OPERATION_NAMESPACE, unfinished.operationId, record.version);
        const anchor = db.read("line_operation_anchors", unfinished.operationId);
        if (anchor) db.remove("line_operation_anchors", unfinished.operationId, anchor.version);
      }));
      writeFileSync(join(storage, "prd.md"), execFileSync("git", ["show", "HEAD:prd.md"], { cwd: storage, env: GIT_ENV }));
      return configOf(operation);
    });
  }).mockImplementation(original);

  const outcome = await saveOnLineB(w, a).then(() => "saved", (error: { code?: string }) => error.code);
  expect(["saved", "requirement_write_busy"]).toContain(outcome);
});

test("首次创建记下 Git 结果后中断、需求仓库目录被整体换成一份副本：原样续完当场被拒，不先报成功", async () => {
  const w = await world();
  const create = { requestId: uuidv7(), operationId: uuidv7(), title: "需求标题", body: "创建正文" };
  const original = RequirementStateStore.prototype.recordSavedVersion;
  vi.spyOn(RequirementStateStore.prototype, "recordSavedVersion").mockImplementationOnce(() => {
    throw new Error("injected saved-version failure");
  }).mockImplementation(original);
  await expect((await w.open()).create(create)).rejects.toThrow(/saved-version failure/);

  const requirementId = withDatabase(w.database(), (db) => db.read<{ requirementId: string }>(REQUIREMENT_OPERATION_NAMESPACE, create.operationId)!.data.requirementId);
  const storage = join(w.options.dataRoot, "repos", w.options.repoId, "requirements", requirementId);
  execFileSync("cp", ["-a", storage, `${storage}.copy`]);
  execFileSync("mv", [storage, `${storage}.old`]);
  execFileSync("mv", [`${storage}.copy`, storage]);

  await expect((await w.open()).create(create)).rejects.toThrow();
});
