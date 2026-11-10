import { afterEach, expect, test, vi } from "vitest";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import requirementManageExtension from "../src/modules/interaction/requirement-manage-extension.ts";
import { HostAuthorizationManager } from "../src/modules/requirement/host-authorization.ts";
import { RequirementService } from "../src/modules/requirement/requirement-service.ts";
import type { RequirementServiceOptions } from "../src/modules/requirement/requirement-service.ts";
import { RequirementStateStore } from "../src/modules/requirement/requirement-state.ts";
import { repositoryDatabase, uuidv7, withDatabase } from "../src/core/storage/database.ts";
import { createLineAnchorIn } from "../src/modules/requirement/line-anchors.ts";
import { repositoryIdentity } from "../src/core/storage/identity.ts";
import { manifestConfirmInput } from "./helpers/approval-fixture.ts";
import { createFakePi } from "./helpers/fake-pi.ts";
import { addWorktree, createRepoFixture, GIT_ENV, removeRepoFixture } from "./helpers/repo-fixture.ts";
import { temporaryRoot } from "./helpers/temporary-root.ts";

vi.setConfig({ testTimeout: 60_000 });
const exec = promisify(execFile);
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const ANCHOR_ENTRY = "one-company.line-anchor";
const UNKNOWN_ANCHOR = "01900000-0000-7000-8000-000000000000";

async function world(shared?: World) {
  const root = shared?.root ?? await mkdtemp(join(temporaryRoot(), "line-switch-"));
  if (!shared) cleanups.push(() => rm(root, { recursive: true, force: true }));
  const repo = await createRepoFixture();
  cleanups.push(() => removeRepoFixture(repo));
  const identity = await repositoryIdentity(repo.root);
  const options: RequirementServiceOptions = { repositoryRoot: repo.root, dataRoot: join(root, "private"), repoId: identity.repoId, authorize: () => true, authorizeManifest: () => true };
  const open = (lines?: Record<string, readonly string[]>) => RequirementService.open({ ...options, ...(lines ? { lines } : {}) });
  const logPath = join(root, "logs", `${identity.repoId.slice(0, 8)}.log`);
  await mkdir(join(root, "logs"), { recursive: true });
  await writeFile(logPath, "log\n");
  return { root, repo, options, open, logPath };
}
interface World { root: string; repo: Awaited<ReturnType<typeof createRepoFixture>>; options: RequirementServiceOptions; open: (lines?: Record<string, readonly string[]>) => Promise<RequirementService>; logPath: string }

async function build(w: World, title: string, versions: number) {
  const created = await (await w.open()).create({ requestId: uuidv7(), operationId: uuidv7(), title, body: "正文 v2" });
  const receipts = [created];
  for (let i = 2; i < versions; i++) {
    const previous = receipts.at(-1)!;
    receipts.push(await (await w.open({ [created.requirementId]: receipts.map((r) => r.anchor) })).updateDraft({ requirementId: created.requirementId, operationId: uuidv7(), version: previous.version, title, body: `正文 v${previous.version + 1}` }));
  }
  return { requirementId: created.requirementId, created, anchors: receipts.map((r) => r.anchor) };
}

async function approve(w: World, created: { requirementId: string; operationId: string }) {
  const state = await RequirementStateStore.open({ ...w.options, authorize: () => true });
  const worktree = await addWorktree(w.repo);
  const baseCommit = (await exec("git", ["rev-parse", "HEAD"], { cwd: worktree.root, env: GIT_ENV })).stdout.trim();
  await state.bindWorkspace({ requirementId: created.requirementId, version: state.read(created.requirementId).version, path: worktree.root, prepareOperationId: uuidv7(), baseCommit });
  await (await w.open()).confirmUpdate(await manifestConfirmInput(w.options, { requirementId: created.requirementId, savedOperationId: created.operationId }));
  const approval = withDatabase(repositoryDatabase(w.options.dataRoot, w.options.repoId), (db) =>
    db.list<{ kind: string; requirementId: string; anchor: string }>("line_anchors").map((row) => row.data).find((record) => record.kind === "approval" && record.requirementId === created.requirementId)!);
  return { approvalAnchor: approval.anchor, version: (await (await w.open()).metadata(created.requirementId)).version };
}

type Line = Record<string, readonly string[]>;
type Owners = Record<string, World>;
const entriesOf = (w: World, line: Line, owners: Owners) => Object.entries(line).flatMap(([requirementId, anchors]) =>
  anchors.map((anchor) => ({ type: "custom", customType: ANCHOR_ENTRY, data: { repoId: (owners[requirementId] ?? w).options.repoId, requirementId, anchor } })));

async function session(w: World, initial: Line, owners: Owners = {}) {
  const worlds = [w, ...new Set(Object.values(owners))];
  const fake = createFakePi();
  const sendMessage = vi.fn();
  const authorization = new HostAuthorizationManager({ dataRoot: w.options.dataRoot });
  const client = { state: () => ({ status: "connected" as const }), subscribe: () => () => {}, call: async () => ({}) };
  const window = { windowId: "window-1", sessionId: "session-1", workspace: { repos: worlds.map((each) => ({ repoId: each.options.repoId, path: each.repo.root })) }, clients: { forRepo: () => client } };
  requirementManageExtension({ ...fake.pi, sendMessage } as never, { authorization, dataRoot: w.options.dataRoot, windowReady: async () => window as never, windowContext: () => window as never,
    daemonLogPath: (repoId: string) => worlds.find((each) => each.options.repoId === repoId)!.logPath } as never);
  let branch = entriesOf(w, initial, owners);
  const ctx = { mode: "print", hasUI: false, sessionManager: { getSessionId: () => "session-1", getBranch: () => branch } };
  const switchTo = (line: Line) => { branch = entriesOf(w, line, owners); };
  const trigger = async (event: string, payload: object = {}) => { await fake.trigger(event, payload, ctx); await new Promise((resolve) => setTimeout(resolve, 100)); };
  const texts = () => sendMessage.mock.calls.map(([message]) => (message as { content: string }).content);
  return { sendMessage, switchTo, trigger, texts };
}

async function mainScenario() {
  const w = await world();
  const exportReq = await build(w, "订单导出", 10);
  const points = await build(w, "会员积分", 1);
  const approved = await approve(w, points.created);
  const notify = await build(w, "消息通知", 6);
  const lineA: Line = { [exportReq.requirementId]: exportReq.anchors, [points.requirementId]: [points.anchors[0]!, approved.approvalAnchor], [notify.requirementId]: notify.anchors };
  const lineB: Line = { [exportReq.requirementId]: exportReq.anchors.slice(0, 4), [points.requirementId]: [points.anchors[0]!], [notify.requirementId]: [...notify.anchors.slice(0, 2), UNKNOWN_ANCHOR] };
  return { w, exportReq, points, notify, approved, lineA, lineB };
}

test("从线 A 换到线 B：session_tree 后 sendMessage 只调一次，类型、不触发回复、正文与示例格式一致", async () => {
  const s = await mainScenario();
  const run = await session(s.w, s.lineA);
  await run.trigger("session_start", { reason: "startup" });
  expect(run.sendMessage).not.toHaveBeenCalled();
  run.switchTo(s.lineB);
  await run.trigger("session_tree");
  expect(run.sendMessage).toHaveBeenCalledTimes(1);
  expect(run.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ customType: "one-company.requirement-restore", display: true }), { triggerTurn: false });
  const text = run.texts()[0]!;
  const blocks = text.split("\n\n");
  expect(blocks[0]).toBe("「订单导出」已恢复至版本 5");
  expect(blocks[1]).toBe(`「会员积分」已批准，以库里的版本 ${s.approved.version} 为准`);
  const failed = blocks[2]!.split("\n");
  expect(failed).toHaveLength(4);
  expect(failed[0]).toBe("「消息通知」没能恢复至对话里的那一版，仍是版本 6");
  expect(failed[1]).toMatch(/^- 原因：\S/);
  expect(failed[2]).toBe("- 下一步：主代理先读取库里的内容再操作；要用回对话里的那一版，让主代理照对话里的内容重新保存一次");
  expect(blocks).toHaveLength(3);
});

test("失败块的原因里没有错误码，运行日志路径指向真实存在的文件", async () => {
  const s = await mainScenario();
  const run = await session(s.w, s.lineA);
  await run.trigger("session_start", { reason: "startup" });
  run.switchTo(s.lineB);
  await run.trigger("session_tree");
  const lines = run.texts()[0]!.split("\n");
  const reason = lines.find((line) => line.startsWith("- 原因："))!;
  expect(reason).not.toMatch(/[a-z]+_[a-z_]+/);
  const logLine = lines.find((line) => line.startsWith("- 运行日志："))!;
  const path = logLine.slice("- 运行日志：".length);
  expect(path).toBe(s.w.logPath);
  expect(existsSync(path)).toBe(true);
});

test("只有「订单导出」变了时，正文只有一行", async () => {
  const w = await world();
  const exportReq = await build(w, "订单导出", 10);
  const run = await session(w, { [exportReq.requirementId]: exportReq.anchors });
  await run.trigger("session_start", { reason: "startup" });
  run.switchTo({ [exportReq.requirementId]: exportReq.anchors.slice(0, 4) });
  await run.trigger("session_tree");
  expect(run.texts()).toEqual(["「订单导出」已恢复至版本 5"]);
});

test("换到线尖不变的位置：不调 sendMessage", async () => {
  const w = await world();
  const exportReq = await build(w, "订单导出", 10);
  const run = await session(w, { [exportReq.requirementId]: exportReq.anchors });
  await run.trigger("session_start", { reason: "startup" });
  await run.trigger("session_tree");
  expect(run.sendMessage).not.toHaveBeenCalled();
});

test("两个需求都已恢复：按它们在这条线上最后保存的先后排，不按标题", async () => {
  const w = await world();
  const second = await build(w, "B需求", 6);
  const first = await build(w, "A需求", 6);
  const full: Line = { [first.requirementId]: first.anchors, [second.requirementId]: second.anchors };
  const run = await session(w, full);
  await run.trigger("session_start", { reason: "startup" });
  run.switchTo({ [first.requirementId]: first.anchors.slice(0, 3), [second.requirementId]: second.anchors.slice(0, 3) });
  await run.trigger("session_tree");
  expect(run.texts()).toEqual(["「B需求」已恢复至版本 4\n\n「A需求」已恢复至版本 4"]);
});

test("新线上没有某需求的锚点（它是后来的线上才建的）：消息里没有它", async () => {
  const w = await world();
  const exportReq = await build(w, "订单导出", 10);
  const later = await build(w, "后建需求", 3);
  const run = await session(w, { [exportReq.requirementId]: exportReq.anchors, [later.requirementId]: later.anchors });
  await run.trigger("session_start", { reason: "startup" });
  run.switchTo({ [exportReq.requirementId]: exportReq.anchors.slice(0, 4) });
  await run.trigger("session_tree");
  expect(run.texts()).toEqual(["「订单导出」已恢复至版本 5"]);
});

test.each(["fork", "resume"])("session_start 原因为 %s：换线后线尖变了，同样插消息", async (reason) => {
  const w = await world();
  const exportReq = await build(w, "订单导出", 10);
  const run = await session(w, { [exportReq.requirementId]: exportReq.anchors });
  await run.trigger("session_start", { reason: "startup" });
  run.switchTo({ [exportReq.requirementId]: exportReq.anchors.slice(0, 4) });
  await run.trigger("session_start", { reason });
  expect(run.texts()).toEqual(["「订单导出」已恢复至版本 5"]);
});

test("startup 打开停在版本 5 的旧对话、库里最近保存是版本 7：插已恢复至版本 5", async () => {
  const w = await world();
  const req = await build(w, "订单导出", 7);
  const run = await session(w, { [req.requirementId]: req.anchors.slice(0, 4) });
  await run.trigger("session_start", { reason: "startup" });
  expect(run.texts()).toEqual(["「订单导出」已恢复至版本 5"]);
  expect(run.sendMessage).toHaveBeenCalledWith(expect.anything(), { triggerTurn: false });
});

test("startup 打开停在版本 7 的旧对话、库里最近保存也是版本 7：不插", async () => {
  const w = await world();
  const req = await build(w, "订单导出", 7);
  const run = await session(w, { [req.requirementId]: req.anchors });
  await run.trigger("session_start", { reason: "startup" });
  expect(run.sendMessage).not.toHaveBeenCalled();
});

test("startup 打开的旧对话最后停在一条短决定上、那条决定接在最近一次保存后面：不插", async () => {
  const w = await world();
  const req = await build(w, "订单导出", 7);
  const decision = uuidv7();
  withDatabase(repositoryDatabase(w.options.dataRoot, w.options.repoId), (db) => db.transaction(() =>
    createLineAnchorIn(db, { repoId: w.options.repoId, requirementId: req.requirementId, anchor: decision, kind: "decision", line: req.anchors, now: Date.now() })));
  const run = await session(w, { [req.requirementId]: [...req.anchors, decision] });
  await run.trigger("session_start", { reason: "startup" });
  expect(run.sendMessage).not.toHaveBeenCalled();
});

test("新开空对话：线上没有锚点，什么都不插", async () => {
  const w = await world();
  await build(w, "订单导出", 7);
  const run = await session(w, {});
  await run.trigger("session_start", { reason: "startup" });
  expect(run.sendMessage).not.toHaveBeenCalled();
});

test("session_start 原因为 reload：不处理，即使线尖和之前不同", async () => {
  const w = await world();
  const req = await build(w, "订单导出", 10);
  const run = await session(w, { [req.requirementId]: req.anchors });
  await run.trigger("session_start", { reason: "startup" });
  run.switchTo({ [req.requirementId]: req.anchors.slice(0, 4) });
  await run.trigger("session_start", { reason: "reload" });
  expect(run.sendMessage).not.toHaveBeenCalled();
});

const approvedText = (title: string, version: number) => `「${title}」已批准，以库里的版本 ${version} 为准`;

test("需求在别的对话里保存后马上批准，startup 打开停在那次保存的旧对话：写已批准块", async () => {
  const w = await world();
  const points = await build(w, "会员积分", 1);
  const approved = await approve(w, points.created);
  const run = await session(w, { [points.requirementId]: [points.anchors[0]!] });
  await run.trigger("session_start", { reason: "startup" });
  expect(run.texts()).toEqual([approvedText("会员积分", approved.version)]);
});

test("session_tree 换线前后线尖相同、都停在批准之前：照样写已批准块", async () => {
  const w = await world();
  const points = await build(w, "会员积分", 1);
  const approved = await approve(w, points.created);
  const line: Line = { [points.requirementId]: [points.anchors[0]!] };
  const run = await session(w, line);
  await run.trigger("session_start", { reason: "reload" });
  await run.trigger("session_before_tree");
  await run.trigger("session_tree");
  expect(run.texts()).toEqual([approvedText("会员积分", approved.version)]);
});

async function closeRequirement(w: World, requirementId: string, finish: boolean) {
  const state = await RequirementStateStore.open({ ...w.options, authorize: () => true });
  const closing = state.beginClose({ requirementId, version: state.read(requirementId).version, intent: { operationId: uuidv7(), reason: "cancelled", receiptId: uuidv7() } });
  if (finish) state.finishClose({ requirementId, version: closing.version, operationId: closing.data.close!.operationId });
}

test.each([false, true])("需求已进入关闭流程（finish=%s）且线停在批准之前：写已批准块，同线的草稿需求照常报已恢复", async (finish) => {
  const w = await world();
  const exportReq = await build(w, "订单导出", 10);
  const points = await build(w, "会员积分", 1);
  await approve(w, points.created);
  await closeRequirement(w, points.requirementId, finish);
  const version = (await (await w.open()).metadata(points.requirementId)).version;
  const run = await session(w, { [exportReq.requirementId]: exportReq.anchors.slice(0, 4), [points.requirementId]: [points.anchors[0]!] });
  await run.trigger("session_start", { reason: "startup" });
  expect(run.texts()).toEqual([`「订单导出」已恢复至版本 5\n\n${approvedText("会员积分", version)}`]);
});

test("一个需求的记录读取时出错：别的需求照常写进消息，出错的需求写失败块，原因是白话、没有错误码，带日志路径", async () => {
  const w = await world();
  const exportReq = await build(w, "订单导出", 10);
  const broken = await build(w, "消息通知", 6);
  const original = RequirementService.prototype.metadata;
  const spy = vi.spyOn(RequirementService.prototype, "metadata").mockImplementation(function (this: RequirementService, requirementId: string) {
    if (requirementId === broken.requirementId) throw new Error("读取失败 read_failed");
    return original.call(this, requirementId);
  });
  try {
    const run = await session(w, { [exportReq.requirementId]: exportReq.anchors.slice(0, 4), [broken.requirementId]: broken.anchors });
    await run.trigger("session_start", { reason: "startup" });
    const blocks = run.texts()[0]!.split("\n\n");
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toBe("「订单导出」已恢复至版本 5");
    const lines = blocks[1]!.split("\n");
    expect(lines[0]).toMatch(/没能恢复/);
    const reason = lines.find((line) => line.startsWith("- 原因："))!;
    expect(reason).toMatch(/^- 原因：\S/);
    expect(reason).not.toMatch(/[a-z]+_[a-z_]+/);
    expect(lines).toContain(`- 运行日志：${w.logPath}`);
  } finally { spy.mockRestore(); }
});

test("两条线上同一需求标题不同：从线 A 换到线 B，消息里用线 B 上的标题", async () => {
  const w = await world();
  const created = await (await w.open()).create({ requestId: uuidv7(), operationId: uuidv7(), title: "旧标题", body: "正文" });
  const renamed = await (await w.open({ [created.requirementId]: [created.anchor] })).updateDraft({ requirementId: created.requirementId, operationId: uuidv7(), version: created.version, title: "新标题", body: "正文二" });
  const run = await session(w, { [created.requirementId]: [created.anchor, renamed.anchor] });
  await run.trigger("session_start", { reason: "startup" });
  run.switchTo({ [created.requirementId]: [created.anchor] });
  await run.trigger("session_tree");
  expect(run.texts()).toEqual([`「旧标题」已恢复至版本 ${created.version}`]);
});

test("那一版的正文在需求文件仓库里读不出：写失败块", async () => {
  const w = await world();
  const req = await build(w, "订单导出", 10);
  const lineB = req.anchors.slice(0, 4);
  const record = withDatabase(repositoryDatabase(w.options.dataRoot, w.options.repoId), (db) =>
    db.list<{ anchor: string; fileCommit?: string }>("line_anchors").map((row) => row.data).find((data) => data.anchor === lineB.at(-1)))!;
  const storage = join(w.options.dataRoot, "repos", w.options.repoId, "requirements", req.requirementId);
  const blob = (await exec("git", ["rev-parse", `${record.fileCommit}:prd.md`], { cwd: storage, env: GIT_ENV })).stdout.trim();
  await rm(join(storage, ".git", "objects", blob.slice(0, 2), blob.slice(2)));
  const run = await session(w, { [req.requirementId]: lineB });
  await run.trigger("session_start", { reason: "startup" });
  const lines = run.texts()[0]!.split("\n");
  expect(lines[0]).toMatch(/^「订单导出」没能恢复至版本 5，仍是版本 \d+$/);
  expect(lines[1]).toMatch(/^- 原因：\S/);
  expect(lines).toContain(`- 运行日志：${w.logPath}`);
});

test("两个仓库各有一个恢复失败的需求：每个失败块写自己仓库的运行日志路径，路径指向真实存在的文件", async () => {
  const first = await world();
  const second = await world(first);
  const a = await build(first, "甲仓需求", 3);
  const b = await build(second, "乙仓需求", 3);
  expect(second.logPath).not.toBe(first.logPath);
  const owners: Owners = { [b.requirementId]: second };
  const run = await session(first, { [a.requirementId]: [a.anchors[0]!, UNKNOWN_ANCHOR], [b.requirementId]: [b.anchors[0]!, UNKNOWN_ANCHOR] }, owners);
  await run.trigger("session_start", { reason: "startup" });
  const blocks = run.texts()[0]!.split("\n\n");
  expect(blocks).toHaveLength(2);
  const logOf = (title: string) => blocks.find((block) => block.includes(`「${title}」`))!.split("\n").find((line) => line.startsWith("- 运行日志："))!.slice("- 运行日志：".length);
  expect(logOf("甲仓需求")).toBe(first.logPath);
  expect(logOf("乙仓需求")).toBe(second.logPath);
  expect(existsSync(logOf("甲仓需求"))).toBe(true);
  expect(existsSync(logOf("乙仓需求"))).toBe(true);
});

test("窗口没起来（取当前窗口时抛错）时换线：不抛错也不插消息", async () => {
  const w = await world();
  const req = await build(w, "订单导出", 10);
  const fake = createFakePi();
  const sendMessage = vi.fn();
  requirementManageExtension({ ...fake.pi, sendMessage } as never, { authorization: new HostAuthorizationManager({ dataRoot: w.options.dataRoot }), dataRoot: w.options.dataRoot,
    windowReady: async () => { throw new Error("窗口未启动"); }, windowContext: () => { throw new Error("窗口未启动"); } } as never);
  const ctx = { mode: "print", hasUI: false, sessionManager: { getSessionId: () => "session-1", getBranch: () => entriesOf(w, { [req.requirementId]: req.anchors.slice(0, 4) }, {}) } };
  await expect(fake.trigger("session_tree", {}, ctx)).resolves.toBeDefined();
  expect(sendMessage).not.toHaveBeenCalled();
});
