import { afterEach, expect, test, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { appendFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { registerProtocolHandlers } from "../src/app/daemon/run-manager.ts";
import { RequirementService } from "../src/modules/requirement/requirement-service.ts";
import { lineViewIn } from "../src/modules/requirement/line-anchors.ts";
import { readDraftFiles } from "../src/modules/requirement/prd-storage.ts";
import { awaitingOnLine, draftPrototypes, lineDesignSpec, promoteOnApprovalIn, prototypeFilePath } from "../src/modules/requirement/requirement-prototypes.ts";
import { repositoryDatabase, uuidv7, withDatabase } from "../src/core/storage/database.ts";
import { createPmRunWorld, until } from "./helpers/run-manager-fixture.ts";
import { VALID_DESIGN } from "./helpers/design-sample.ts";

vi.setConfig({ testTimeout: 60_000 });
const cleanups: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });

const HTML = "<!doctype html><html><body><h1>导出弹窗草图</h1></body></html>";
const PAGES = [{ name: "页面", views: [{ name: "正常" }] }];
const MODEL = { provider: "team-model", id: "test" };
const NAME = "导出弹窗";
const BUTTON_36 = VALID_DESIGN.replace("- 按钮高度：32px", "- 按钮高度：36px");
const COLOR_TEAL = BUTTON_36.replace("- 主色：#0f766e", "- 主色：#0e7490");

type Handler = (params: Record<string, unknown>, client: unknown) => Promise<Record<string, unknown>>;

async function world(options: { rootDesign?: string | null; approved?: boolean } = {}) {
  const w = await createPmRunWorld(cleanups);
  const repoRoot = await realpath(w.fixture.repositoryRoot);
  const rootDesignPath = join(repoRoot, "DESIGN.md");
  if (options.rootDesign !== null) await writeFile(rootDesignPath, options.rootDesign ?? VALID_DESIGN);
  const requirementId = options.approved ? w.fixture.requirementId
    : (await w.fixture.service.create({ requestId: uuidv7(), operationId: uuidv7(), title: "导出弹窗", body: "# 导出\n导出弹窗支持选格式。\n" })).requirementId;
  const ref = { dataRoot: w.fixture.dataRoot, repoId: w.fixture.repoId };
  const handlers = new Map<string, Handler>();
  const server = { registerHandler: (method: string, handler: Handler) => handlers.set(method, handler), markHandlersReady: () => {},
    onHello: null as null | ((client: unknown) => unknown), onDisconnect: null as null | ((client: unknown) => unknown) };
  registerProtocolHandlers({ server: server as never, manager: w.manager, shellRegistry: {} as never });
  const client = { connectionId: "connection-a", sessionId: "session-a", windowId: "win" };
  await server.onHello!(client);
  const call = (method: string, params: Record<string, unknown>) => handlers.get(method)!(params, client);
  const baseAnchor = w.db((db) => db.list<{ kind: string; sequence: number; requirementId: string; anchor: string }>("line_anchors")
    .map((row) => row.data).filter((record) => record.requirementId === requirementId && record.kind === "save").sort((a, b) => a.sequence - b.sequence)[0]!.anchor);
  const events = (name: string) => w.emit.mock.calls.filter(([event]) => event === name).map(([, data]) => data as Record<string, unknown>);
  const submit = (design: string, html = HTML) => ({ type: "toolcall" as const, name: "one_company_result_submit",
    input: { action: "prototype", design, pages: PAGES, html, note: "导出格式选择" } });
  const slow = { type: "text" as const, text: "慢慢画", chunkDelayMs: 3_000 };

  const dispatch = async (line: string[], name = NAME) => {
    const anchor = uuidv7();
    const result = await call("prototypes.dispatch", { requirementId, name, brief: "画导出弹窗", maxTurns: 12, model: MODEL, thinking: "off", line, anchor }) as { runId: string; version: number };
    return { ...result, anchor, line: [...line, anchor] };
  };
  const designed = async (line: string[], design: string, name = NAME) => {
    const before = events("prototype.submitted").length;
    w.provider.queue.push(submit(design));
    const dispatched = await dispatch(line, name);
    await until(() => events("prototype.submitted").length === before + 1);
    return dispatched;
  };
  const decide = async (line: string[], choice: "accept" | "abandon" | "opinion", name = NAME) => {
    const pending = await call("prototypes.pending", { requirementId, name, line });
    const anchor = uuidv7();
    await call("prototypes.decide", { requirementId, name, line, anchor, version: pending.version, hash: pending.hash, choice, opinion: choice === "opinion" ? "再改" : null, option: null });
    return [...line, anchor];
  };
  const board = (line: string[]) => call("prototypes.board", { requirementId, line }) as Promise<{ entries: Array<{ name: string; inFlight: { status: string } | null; draft: { version: number } | null }> }>;
  const entryOn = async (line: string[], name = NAME) => (await board(line)).entries.find((entry) => entry.name === name);
  const filesAt = async (line: string[]) => {
    const commit = w.db((db) => lineViewIn(db, requirementId, line).tip!.fileCommit!);
    return readDraftFiles({ ...ref, requirementId, repositoryRoot: repoRoot, commit, authorize: () => true } as never);
  };
  const text = (bytes: Uint8Array | null) => bytes === null ? null : Buffer.from(bytes).toString("utf8");
  const promote = (line: string[], digest: string) => withDatabase(repositoryDatabase(ref.dataRoot, ref.repoId), (db) => db.transaction(() => promoteOnApprovalIn(db, { requirementId, digest, line } as never)));
  const requestsText = () => JSON.stringify(w.provider.requests);
  return { ...w, repoRoot, rootDesignPath, requirementId, ref, call, baseAnchor, events, submit, slow, dispatch, designed, decide, board, entryOn, filesAt, text, promote, requestsText };
}

test("线 A 派设计师、线 B 不含这次派发：设计师交稿后，交稿事件带 dispatchAnchor，线 B 的看板里没有这份在途原型", async () => {
  const w = await world();
  const a = await w.designed([w.baseAnchor], BUTTON_36);
  expect(w.events("prototype.submitted")[0]).toMatchObject({ parentSessionId: "session-a", requirementId: w.requirementId, name: NAME, version: 1, dispatchAnchor: a.anchor });
  expect((await w.entryOn(a.line))?.inFlight).toMatchObject({ status: "awaiting" });
  expect(await w.entryOn([w.baseAnchor])).toBeUndefined();
});

test("在途原型只挡住它自己那条线上的批准：线 A 批准被 in_flight 挡住，线 B 批准不被挡", async () => {
  const w = await world();
  const a = await w.designed([w.baseAnchor], BUTTON_36);
  const lineB = [w.baseAnchor];
  const digestA = (await draftPrototypes(w.ref, w.requirementId, a.line as never)).digest;
  expect(() => w.promote(a.line, digestA)).toThrow(expect.objectContaining({ code: "in_flight" }));
  const digestB = (await draftPrototypes(w.ref, w.requirementId, lineB as never)).digest;
  expect(w.promote(lineB, digestB).items).toEqual([]);
});

test("awaitingOnLine 列出线 A 上交了稿、等确认的原型，线 B 上为空", async () => {
  const w = await world();
  const a = await w.designed([w.baseAnchor], BUTTON_36);
  const onA = await awaitingOnLine(w.ref, w.requirementId, a.line as never);
  expect(onA.map((item: { name: string }) => item.name)).toEqual([NAME]);
  expect(await awaitingOnLine(w.ref, w.requirementId, [w.baseAnchor] as never)).toEqual([]);
});

test("设计师还在做（没交稿）时，awaitingOnLine 不列它", async () => {
  const w = await world();
  w.provider.queue.push(w.slow);
  const a = await w.dispatch([w.baseAnchor]);
  expect(await awaitingOnLine(w.ref, w.requirementId, a.line as never)).toEqual([]);
  await w.call("runs.stop", { runId: a.runId });
});

test("在途原型在用户切走后照样做完：派出后用线 B 查看板，设计师仍交稿，线 A 上变成等确认", async () => {
  const w = await world();
  w.provider.queue.push(w.submit(BUTTON_36), { type: "text", text: "已交稿" });
  const a = await w.dispatch([w.baseAnchor]);
  expect(await w.entryOn([w.baseAnchor])).toBeUndefined();
  await until(() => w.events("prototype.submitted").length === 1);
  expect((await w.entryOn(a.line))?.inFlight).toMatchObject({ status: "awaiting", });
});

test("设计师没交稿就结束：结束事件带 dispatchAnchor，线 A 上不再在途，线 B 仍没有这份原型", async () => {
  const w = await world();
  w.provider.queue.push({ type: "text", text: "我不画了" });
  const a = await w.dispatch([w.baseAnchor]);
  await until(() => w.events("prototype.finished").length === 1);
  expect(w.events("prototype.finished")[0]).toMatchObject({ requirementId: w.requirementId, name: NAME, version: 1, dispatchAnchor: a.anchor });
  expect((await w.entryOn(a.line))?.inFlight ?? null).toBeNull();
  expect(await w.entryOn([w.baseAnchor])).toBeUndefined();
});

test("同名原型在线 A 上还在做时，线 A 重派被拒；线 B 照常派出，版本按需求全局编号是 2", async () => {
  const w = await world();
  w.provider.queue.push(w.slow, w.slow);
  const a = await w.dispatch([w.baseAnchor]);
  await expect(w.dispatch(a.line)).rejects.toMatchObject({ message: expect.stringContaining("还在做") });
  const b = await w.dispatch([w.baseAnchor]);
  expect(a.version).toBe(1);
  expect(b.version).toBe(2);
  await w.call("runs.stop", { runId: a.runId });
  await w.call("runs.stop", { runId: b.runId });
});

test("线 A 上同名原型已交稿等确认，线 B 上同名派出得 2", async () => {
  const w = await world();
  const a = await w.designed([w.baseAnchor], BUTTON_36);
  w.provider.queue.push(w.slow);
  const b = await w.dispatch([w.baseAnchor]);
  expect(a.version).toBe(1);
  expect(b.version).toBe(2);
  await w.call("runs.stop", { runId: b.runId });
});

test("已批准的需求不按对话线走：线 A 派的在途原型，线 B 的看板里也看得到", async () => {
  const w = await world({ approved: true });
  const a = await w.designed([w.baseAnchor], BUTTON_36);
  expect((await w.entryOn(a.line))?.inFlight).toMatchObject({ status: "awaiting" });
  expect((await w.entryOn([w.baseAnchor]))?.inFlight).toMatchObject({ status: "awaiting" });
});

test("线 A 上通过后，主仓库根目录 DESIGN.md 字节不变；线 A 的文件状态里有原型 HTML、DESIGN.md、DESIGN.base.md", async () => {
  const w = await world();
  const a = await w.designed([w.baseAnchor], BUTTON_36);
  const lineAfter = await w.decide(a.line, "accept");
  expect(readFileSync(w.rootDesignPath, "utf8")).toBe(VALID_DESIGN);
  const files = await w.filesAt(lineAfter);
  expect(w.text(files.prototypes[`${NAME}.v1`]!)).toContain("导出弹窗草图");
  expect(w.text(files.design)).toBe(BUTTON_36);
  expect(w.text(files.designBase)).toBe(VALID_DESIGN);
});

test("线 A 上通过后，线 B 的文件状态里没有这份原型，看板里也没有", async () => {
  const w = await world();
  const a = await w.designed([w.baseAnchor], BUTTON_36);
  await w.decide(a.line, "accept");
  const filesB = await w.filesAt([w.baseAnchor]);
  expect(filesB.prototypes).toEqual({});
  expect(filesB.design).toBeNull();
  expect(await w.entryOn([w.baseAnchor])).toBeUndefined();
});

test("主仓库根目录没有 DESIGN.md 时通过：根目录仍然没有，线 A 的文件状态里有设计师交的 DESIGN.md", async () => {
  const w = await world({ rootDesign: null });
  const a = await w.designed([w.baseAnchor], VALID_DESIGN);
  const lineAfter = await w.decide(a.line, "accept");
  expect(existsSync(w.rootDesignPath)).toBe(false);
  const files = await w.filesAt(lineAfter);
  expect(w.text(files.design)).toBe(VALID_DESIGN);
  expect(files.designBase).toBeNull();
});

test("设计师的 DESIGN.md 和开工时拿到的相同（没改）：通过后线 A 的文件状态里不新增 DESIGN.md", async () => {
  const w = await world();
  const a = await w.designed([w.baseAnchor], VALID_DESIGN);
  const files = await w.filesAt(await w.decide(a.line, "accept"));
  expect(files.design).toBeNull();
  expect(files.designBase).toBeNull();
  expect(Object.keys(files.prototypes)).toEqual([`${NAME}.v1`]);
});

const OTHER = "设置弹窗";

async function twoDesignsFromRoot() {
  const w = await world();
  const first = await w.designed([w.baseAnchor], BUTTON_36);
  const second = await w.designed(first.line, COLOR_TEAL, OTHER);
  return { w, first, second };
}

test("同一条线上先通过的原型改了 DESIGN.md，开工时拿旧版的后一份：窗口是 conflict，通过报 design_changed", async () => {
  const { w, first, second } = await twoDesignsFromRoot();
  const afterFirst = await w.decide(second.line, "accept", NAME);
  expect((await w.call("prototypes.pending", { requirementId: w.requirementId, name: OTHER, line: afterFirst })).design).toEqual({ state: "conflict" });
  const pending = await w.call("prototypes.pending", { requirementId: w.requirementId, name: OTHER, line: afterFirst });
  await expect(w.call("prototypes.decide", { requirementId: w.requirementId, name: OTHER, line: afterFirst, anchor: uuidv7(), version: pending.version, hash: pending.hash, choice: "accept", opinion: null, option: null }))
    .rejects.toMatchObject({ message: expect.stringContaining("DESIGN.md 在你确认时被改过，这一版没有通过") });
  expect(first.version).toBe(1);
});

const anchorRecordOf = (w: Awaited<ReturnType<typeof world>>, anchor: string) =>
  w.db((db) => db.list<{ anchor: string; parent: string | null }>("line_anchors").map((row) => row.data).find((record) => record.anchor === anchor)!);

test("线 X 通过、线 Y 放弃几乎同时发生：两个都成功，新锚点接在各自线尖后，两条线的看板互不影响", async () => {
  const w = await world();
  const x = await w.designed([w.baseAnchor], BUTTON_36);
  const y = await w.designed([w.baseAnchor], VALID_DESIGN, OTHER);
  const [afterX, afterY] = await Promise.all([w.decide(x.line, "accept"), w.decide(y.line, "abandon", OTHER)]);
  expect(anchorRecordOf(w, afterX.at(-1)!).parent).toBe(x.anchor);
  expect(anchorRecordOf(w, afterY.at(-1)!).parent).toBe(y.anchor);
  expect(await w.entryOn(afterY, NAME)).toBeUndefined();
  expect((await w.entryOn(afterY, OTHER))?.inFlight ?? null).toBeNull();
  expect(await w.entryOn(afterX, OTHER)).toBeUndefined();
  expect((await w.entryOn(afterX, NAME))?.draft).toMatchObject({ version: 1 });
});

test("等确认期间这条线上又保存了草稿：通过后新锚点接在这次保存之后，这条线读到的正文仍是刚保存的那版", async () => {
  const w = await world();
  const a = await w.designed([w.baseAnchor], BUTTON_36);
  const open = (line: string[]) => RequirementService.open({ repositoryRoot: w.repoRoot, dataRoot: w.ref.dataRoot, repoId: w.ref.repoId,
    authorize: () => true, authorizeManifest: () => true, lines: { [w.requirementId]: line } });
  const onA = await open(a.line);
  const saved = await onA.updateDraft({ requirementId: w.requirementId, operationId: uuidv7(), version: (await onA.metadata(w.requirementId)).version, title: "导出弹窗", body: "# 导出\n保存后的正文\n" });
  const after = await w.decide([...a.line, saved.anchor], "accept");
  expect(anchorRecordOf(w, after.at(-1)!).parent).toBe(saved.anchor);
  const read = await (await open(after)).read({ requirementId: w.requirementId, source: "saved" });
  expect(read.body).toContain("保存后的正文");
});

test("设计师交的 DESIGN.md 和这条线上现有的一字不差、只是和开工时拿到的不同：不算冲突，能通过", async () => {
  const w = await world();
  const first = await w.designed([w.baseAnchor], BUTTON_36);
  const second = await w.designed(first.line, BUTTON_36, OTHER);
  const afterFirst = await w.decide(second.line, "accept", NAME);
  const pending = await w.call("prototypes.pending", { requirementId: w.requirementId, name: OTHER, line: afterFirst });
  expect((pending.design as { state: string }).state).not.toBe("conflict");
  const afterSecond = await w.decide(afterFirst, "accept", OTHER);
  const files = await w.filesAt(afterSecond);
  expect(w.text(files.design)).toBe(BUTTON_36);
  expect(Object.keys(files.prototypes).sort()).toEqual([`${NAME}.v1`, `${OTHER}.v1`].sort());
});

test("线 L1 通过了 v1 并重派 v2 还在做；线 L2 上 v1 的文件被改、打开确认时 v1 作废：L1 上 v2 仍在设计中，交稿后进入等确认，L1 看板读取不报错", async () => {
  const w = await world();
  const l2 = await w.designed([w.baseAnchor], BUTTON_36);
  const l1 = await w.decide(l2.line, "accept");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let replies = 0;
  w.provider.awaitReply = async () => { await gate; return replies++ === 0 ? w.submit(BUTTON_36) : undefined; };
  const submittedBefore = w.events("prototype.submitted").length;
  const v2 = await w.dispatch(l1);
  await appendFile(prototypeFilePath(w.ref, { requirementId: w.requirementId, name: NAME, version: 1 }), "<!-- 交稿后被改 -->");
  await expect(w.call("prototypes.pending", { requirementId: w.requirementId, name: NAME, line: l2.line })).rejects.toMatchObject({ code: "file_changed" });
  expect((await w.entryOn(v2.line))?.inFlight).toMatchObject({ version: 2, status: "designing" });
  release();
  await until(() => w.events("prototype.submitted").length === submittedBefore + 1);
  expect((await w.entryOn(v2.line))?.inFlight).toMatchObject({ version: 2, status: "awaiting" });
});

test("在另一条没通过前一份的线上，后一份不冲突，能通过", async () => {
  const { w, second } = await twoDesignsFromRoot();
  const pending = await w.call("prototypes.pending", { requirementId: w.requirementId, name: OTHER, line: second.line });
  expect(pending.design).toMatchObject({ state: "changed" });
  const lineAfter = await w.decide(second.line, "accept", OTHER);
  expect(w.text((await w.filesAt(lineAfter)).design)).toBe(COLOR_TEAL);
});

test("同一条线上两份基于同一份 DESIGN.md 的原型同时通过：两个都成功，各自分叉线上只有自己那份的 DESIGN.md 和草稿，根目录字节不变", async () => {
  const { w, second } = await twoDesignsFromRoot();
  const [fork1, fork2] = await Promise.all([NAME, OTHER].map((name) => w.decide(second.line, "accept", name)));
  expect(anchorRecordOf(w, fork1.at(-1)!).parent).toBe(second.anchor);
  expect(anchorRecordOf(w, fork2.at(-1)!).parent).toBe(second.anchor);
  expect(w.text((await w.filesAt(fork1)).design)).toBe(BUTTON_36);
  expect(w.text((await w.filesAt(fork2)).design)).toBe(COLOR_TEAL);
  expect((await w.entryOn(fork1, NAME))?.draft ?? null).not.toBeNull();
  expect((await w.entryOn(fork1, OTHER))?.draft ?? null).toBeNull();
  expect((await w.entryOn(fork2, OTHER))?.draft ?? null).not.toBeNull();
  expect((await w.entryOn(fork2, NAME))?.draft ?? null).toBeNull();
  expect(readFileSync(w.rootDesignPath, "utf8")).toBe(VALID_DESIGN);
});

test("通过后线 A 的草稿里有这份原型，批准用的 digest 按线 A 的看板算：线 B 的 digest 对不上线 A", async () => {
  const w = await world();
  const a = await w.designed([w.baseAnchor], BUTTON_36);
  const lineAfter = await w.decide(a.line, "accept");
  const onA = await draftPrototypes(w.ref, w.requirementId, lineAfter as never);
  expect(onA.items.map((item) => [item.name, item.label])).toEqual([[NAME, "new"]]);
  const onB = await draftPrototypes(w.ref, w.requirementId, [w.baseAnchor] as never);
  expect(onB.items).toEqual([]);
  expect(() => w.promote(lineAfter, onB.digest)).toThrow(expect.objectContaining({ code: "digest_changed" }));
  expect(w.promote(lineAfter, onA.digest).items.map((item) => item.name)).toEqual([NAME]);
});

test("线 A 上放弃或提意见：根目录 DESIGN.md 不变，线 A 的文件状态里没有这份原型", async () => {
  const w = await world();
  const a = await w.designed([w.baseAnchor], BUTTON_36);
  const lineAfter = await w.decide(a.line, "abandon");
  expect(readFileSync(w.rootDesignPath, "utf8")).toBe(VALID_DESIGN);
  expect((await w.filesAt(lineAfter)).prototypes).toEqual({});
});

test("线 B 上没有等确认的这份原型：pending 和 decide 被拒，原因写明没有等确认的版本", async () => {
  const w = await world();
  await w.designed([w.baseAnchor], BUTTON_36);
  await expect(w.call("prototypes.pending", { requirementId: w.requirementId, name: NAME, line: [w.baseAnchor] })).rejects.toMatchObject({ message: expect.stringContaining("没有待你确认的版本") });
  await expect(w.call("prototypes.decide", { requirementId: w.requirementId, name: NAME, line: [w.baseAnchor], anchor: uuidv7(), version: 1, hash: "a".repeat(64), choice: "accept", opinion: null, option: null }))
    .rejects.toMatchObject({ message: expect.stringContaining("没有等用户确认") });
});

test("线 A 上后派的设计师照这条线上已通过的 DESIGN.md 画，线 B 上派的照主仓库根目录的", async () => {
  const w = await world();
  const first = await w.designed([w.baseAnchor], BUTTON_36);
  const lineAfter = await w.decide(first.line, "accept");
  w.provider.queue.push(w.slow, w.slow);
  const startA = w.provider.requests.length;
  const onA = await w.dispatch(lineAfter, "设置弹窗");
  await until(() => w.provider.requests.length > startA);
  expect(JSON.stringify(w.provider.requests.slice(startA))).toContain("- 按钮高度：36px");
  expect(JSON.stringify(w.provider.requests.slice(startA))).not.toContain("- 按钮高度：32px");
  const requestsBefore = w.provider.requests.length;
  const onB = await w.dispatch([w.baseAnchor], "帮助弹窗");
  await until(() => w.provider.requests.length > requestsBefore);
  expect(JSON.stringify(w.provider.requests.slice(requestsBefore))).toContain("- 按钮高度：32px");
  expect(JSON.stringify(w.provider.requests.slice(requestsBefore))).not.toContain("- 按钮高度：36px");
  await w.call("runs.stop", { runId: onA.runId });
  await w.call("runs.stop", { runId: onB.runId });
});

test("lineDesignSpec：线上文件状态里有 DESIGN.md 就给它，没有就给主仓库根目录的，两处都没有给 null", async () => {
  const w = await world();
  const first = await w.designed([w.baseAnchor], BUTTON_36);
  const lineAfter = await w.decide(first.line, "accept");
  expect(await lineDesignSpec(w.ref, { requirementId: w.requirementId, line: lineAfter, repositoryRoot: w.repoRoot } as never)).toBe(BUTTON_36);
  expect(await lineDesignSpec(w.ref, { requirementId: w.requirementId, line: [w.baseAnchor], repositoryRoot: w.repoRoot } as never)).toBe(VALID_DESIGN);
  await rm(w.rootDesignPath);
  expect(await lineDesignSpec(w.ref, { requirementId: w.requirementId, line: [w.baseAnchor], repositoryRoot: w.repoRoot } as never)).toBeNull();
});

test("后一份基于前一份通过后的线上 DESIGN.md 开工，能通过：DESIGN.md 换成新的，DESIGN.base.md 仍是第一次开工时根目录的内容", async () => {
  const w = await world();
  const first = await w.designed([w.baseAnchor], BUTTON_36);
  const afterFirst = await w.decide(first.line, "accept");
  const second = await w.designed(afterFirst, COLOR_TEAL, "设置弹窗");
  const afterSecond = await w.decide(second.line, "accept", "设置弹窗");
  const files = await w.filesAt(afterSecond);
  expect(w.text(files.design)).toBe(COLOR_TEAL);
  expect(w.text(files.designBase)).toBe(VALID_DESIGN);
  expect(Object.keys(files.prototypes).sort()).toEqual([`${NAME}.v1`, "设置弹窗.v1"].sort());
  expect(readFileSync(w.rootDesignPath, "utf8")).toBe(VALID_DESIGN);
});

test("移除原型：这条线的文件状态里没有它的 HTML，移除之前的线和别的线不受影响", async () => {
  const w = await world();
  const first = await w.designed([w.baseAnchor], BUTTON_36);
  const afterAccept = await w.decide(first.line, "accept");
  const removeAnchor = uuidv7();
  await w.call("prototypes.remove", { requirementId: w.requirementId, name: NAME, version: 1, line: afterAccept, anchor: removeAnchor });
  const afterRemove = [...afterAccept, removeAnchor];
  expect((await w.filesAt(afterRemove)).prototypes).toEqual({});
  expect(Object.keys((await w.filesAt(afterAccept)).prototypes)).toEqual([`${NAME}.v1`]);
  expect((await w.filesAt([w.baseAnchor])).prototypes).toEqual({});
});

test("移除原型的线上没有这份原型（线 B）：被拒，原因写明不在草稿里，线 A 的原型仍在", async () => {
  const w = await world();
  const first = await w.designed([w.baseAnchor], BUTTON_36);
  const afterAccept = await w.decide(first.line, "accept");
  await expect(w.call("prototypes.remove", { requirementId: w.requirementId, name: NAME, version: 1, line: [w.baseAnchor], anchor: uuidv7() }))
    .rejects.toMatchObject({ message: expect.stringContaining("不在当前草稿集合里") });
  expect(Object.keys((await w.filesAt(afterAccept)).prototypes)).toEqual([`${NAME}.v1`]);
});
