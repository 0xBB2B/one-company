import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { repositoryDatabase, uuidv7, withDatabase } from "../src/core/storage/database.ts";
import type { RequirementRecord } from "../src/modules/requirement/requirement-contracts.ts";
import { pickedOptionText } from "../src/modules/requirement/requirement-prototypes.ts";
import {
  PrototypeBoardError, beginDesign, checkPrototypeName, clearStaleDesigns, decidePrototype, draftPrototypes, endDesign, inFlightBlock,
  inFlightSummary, pendingConfirmation, prototypeFilePath, promoteOnApprovalIn, readPrototypeBoard, removeFromDraft, submitDesign,
} from "../src/modules/requirement/requirement-prototypes.ts";

const HASH = "a".repeat(64);
const HTML = "<!doctype html><html><body><h1>状态面板</h1></body></html>";
const HTML2 = "<!doctype html><html><body><h1>状态面板</h1><p>速度放大</p></body></html>";
const MIB = 1_048_576;

let dataRoot: string;
let ref: { dataRoot: string; repoId: string };
let requirementId: string;

type CloseReason = "completed" | "cancelled" | "rejected";
function closedState(lifecycle: "closing" | "closed", reason: CloseReason): Partial<RequirementRecord> {
  return { lifecycle, close: { operationId: uuidv7(), reason, receiptId: uuidv7() } };
}

const CLOSED_STATES: Array<[Partial<RequirementRecord>, string]> = [
  [closedState("closed", "completed"), "需求已完成"],
  [closedState("closing", "completed"), "需求正在完成"],
  [closedState("closed", "cancelled"), "需求已取消"],
  [closedState("closing", "cancelled"), "需求正在取消"],
  [closedState("closed", "rejected"), "需求已驳回"],
  [closedState("closing", "rejected"), "需求正在驳回"],
];

function putRequirement(id: string, patch: Partial<RequirementRecord> = {}): void {
  const data: RequirementRecord = {
    format: "requirement-lifecycle/v1", requirementId: id, repoId: ref.repoId, requestId: uuidv7(), intentHash: HASH,
    lifecycle: "draft", revision: 0, epoch: 1, saved: null, approved: null, approvalReceiptId: null, workspace: null,
    pendingRevision: null, close: null, recovery: "ready", recoveryReason: null, createdAt: 1, updatedAt: 1, ...patch,
  };
  withDatabase(repositoryDatabase(ref.dataRoot, ref.repoId), (db) => db.create("requirements", id, data));
}

beforeEach(() => {
  dataRoot = mkdtempSync(join("/tmp", "pi-t-"));
  ref = { dataRoot, repoId: HASH };
  mkdirSync(dataRoot, { recursive: true });
  requirementId = uuidv7();
  putRequirement(requirementId);
});
afterEach(() => { rmSync(dataRoot, { recursive: true, force: true }); });

function promote(ref: { dataRoot: string; repoId: string }, input: { requirementId: string; digest: string }) {
  return withDatabase(repositoryDatabase(ref.dataRoot, ref.repoId), (db) => db.transaction(() => promoteOnApprovalIn(db, input)));
}

async function failure(run: () => unknown): Promise<PrototypeBoardError> {
  try { await run(); } catch (error) {
    expect(error).toBeInstanceOf(PrototypeBoardError);
    return error as PrototypeBoardError;
  }
  throw new Error("预期抛错，但调用成功了");
}

const begin = (name: string, runId = uuidv7(), id = requirementId) => beginDesign(ref, { requirementId: id, name, runId, agent: "designer" });
async function designed(name: string, html = HTML, note = "三项状态横排", options?: string[]) {
  const runId = uuidv7();
  const started = await begin(name, runId);
  await submitDesign(ref, { requirementId, name, runId, html, note, ...(options ? { options } : {}) });
  return { runId, version: started.version };
}
async function accepted(name: string, html = HTML) {
  const { version } = await designed(name, html);
  const pending = await pendingConfirmation(ref, { requirementId, name });
  await decidePrototype(ref, { requirementId, name, version, hash: pending.hash, choice: "accept", option: null, opinion: null });
  return pending;
}
const board = () => readPrototypeBoard(ref, requirementId);
const entryOf = async (name: string) => (await board()).entries.find((entry) => entry.name === name);

test("名称为空时派出被拒并写明名称不能为空", async () => {
  const error = await failure(() => begin(""));
  expect(error.advice.why).toContain("空");
});

test("名称为 .. 时派出被拒并写明含路径穿越片段", async () => {
  expect((await failure(() => begin(".."))).advice.why).toMatch(/路径|穿越/);
});

test("名称为 . 时派出被拒", async () => {
  await failure(() => begin("."));
});

test("名称含斜杠时派出被拒并写明含路径分隔符", async () => {
  expect((await failure(() => begin("a/b"))).advice.why).toMatch(/路径|分隔符/);
});

test("名称含其他文件名禁用字符或控制字符时派出被拒", async () => {
  for (const name of ["a<b", "a>b", "a:b", "a\"b", "a\\b", "a|b", "a?b", "a*b", "a\u0000b", "a\nb"]) await failure(() => begin(name));
});

test("名称超过 40 字时派出被拒并写明长度上限", async () => {
  const error = await failure(() => begin("长".repeat(41)));
  expect(error.advice.why).toContain("40");
});

test("名称恰好 40 字时可以派出", async () => {
  expect((await begin("长".repeat(40))).version).toBe(1);
});

test("checkPrototypeName 对合法名称不抛错、对非法名称抛错", () => {
  expect(() => checkPrototypeName("登录页-主流程")).not.toThrow();
  expect(() => checkPrototypeName("")).toThrow(PrototypeBoardError);
});

test("首次派出得到版本 1 且没有上一版", async () => {
  expect(await begin("登录页")).toEqual({ version: 1, previous: null });
});

test("版本文件路径由名称和版本推出且位于数据目录内", () => {
  const first = prototypeFilePath(ref, { requirementId, name: "登录页", version: 1 });
  const second = prototypeFilePath(ref, { requirementId, name: "登录页", version: 2 });
  expect(first).not.toBe(second);
  expect(first.startsWith(dataRoot)).toBe(true);
  expect(first).toContain("登录页");
});

test("同名原型设计中再次派出被拒并写明还在做", async () => {
  await begin("登录页");
  const error = await failure(() => begin("登录页"));
  expect(error.advice.why).toContain("还在做");
});

test("同名原型已交稿等确认时再次派出被拒并写明还在等用户确认", async () => {
  await designed("登录页");
  const error = await failure(() => begin("登录页"));
  expect(error.advice.why).toContain("还在等用户确认");
});

test("不同名称的原型可以同时在途", async () => {
  await begin("登录页");
  await begin("设置页");
  expect((await inFlightSummary(ref, requirementId)).map((entry) => entry.name).sort()).toEqual(["登录页", "设置页"]);
});

test("需求不存在时派出被拒，原因写明先建需求", async () => {
  const error = await failure(() => begin("登录页", uuidv7(), uuidv7()));
  expect(error.advice.why).toContain("需求不存在");
  expect(error.advice.next).toContain("先建需求");
});

test("需求已关闭或正在关闭时派出被拒，原因写明需求当前的状态", async () => {
  for (const [patch, state] of CLOSED_STATES) {
    const id = uuidv7();
    putRequirement(id, patch);
    expect((await failure(() => begin("登录页", uuidv7(), id))).advice.why).toContain(state);
  }
});

test("需求处于待恢复状态时派出被拒，原因写明正在等用户恢复核对", async () => {
  const stuck = uuidv7();
  putRequirement(stuck, { recovery: "needs_review", recoveryReason: "history_unknown" });
  expect((await failure(() => begin("登录页", uuidv7(), stuck))).advice.why).toContain("需求正在等用户恢复核对");
});

test("需求进行中时可以派出", async () => {
  const running = uuidv7();
  putRequirement(running, { lifecycle: "active" });
  expect((await begin("登录页", uuidv7(), running)).version).toBe(1);
});

test("交稿超过 1 MiB 被拒且看板仍是设计中", async () => {
  const runId = uuidv7();
  await begin("登录页", runId);
  const html = `<!doctype html>${"x".repeat(MIB)}`;
  await failure(() => submitDesign(ref, { requirementId, name: "登录页", runId, html, note: "n" }));
  expect(await inFlightSummary(ref, requirementId)).toEqual([{ name: "登录页", version: 1, status: "designing" }]);
});

test("交稿恰好 1 MiB 时被接收", async () => {
  const runId = uuidv7();
  await begin("登录页", runId);
  const head = "<!doctype html>";
  const html = head + "x".repeat(MIB - Buffer.byteLength(head));
  await submitDesign(ref, { requirementId, name: "登录页", runId, html, note: "n" });
  expect((await inFlightSummary(ref, requirementId))[0]?.status).toBe("awaiting");
});

test("交稿不是 HTML 时被拒且看板仍是设计中", async () => {
  const runId = uuidv7();
  await begin("登录页", runId);
  await failure(() => submitDesign(ref, { requirementId, name: "登录页", runId, html: "这只是一段纯文本", note: "n" }));
  expect((await inFlightSummary(ref, requirementId))[0]?.status).toBe("designing");
});

test("交稿以 html 标签开头或前面有空白和大写时算 HTML", async () => {
  for (const [index, html] of ["<html><body>x</body></html>", "  \n\t<!DOCTYPE HTML><html></html>", "<HTML>x</HTML>"].entries()) {
    const name = `页${index}`, runId = uuidv7();
    await begin(name, runId);
    await submitDesign(ref, { requirementId, name, runId, html, note: "n" });
    expect((await inFlightSummary(ref, requirementId)).find((entry) => entry.name === name)?.status).toBe("awaiting");
  }
});

test("交稿的 runId 不是当前设计运行时被拒", async () => {
  await begin("登录页");
  await failure(() => submitDesign(ref, { requirementId, name: "登录页", runId: uuidv7(), html: HTML, note: "n" }));
  expect((await inFlightSummary(ref, requirementId))[0]?.status).toBe("designing");
});

test("没有在途设计时交稿被拒", async () => {
  await failure(() => submitDesign(ref, { requirementId, name: "登录页", runId: uuidv7(), html: HTML, note: "n" }));
});

test("交稿后看板为等确认，文件写在推出的路径里", async () => {
  await designed("登录页");
  expect(await inFlightSummary(ref, requirementId)).toEqual([{ name: "登录页", version: 1, status: "awaiting" }]);
  expect(readFileSync(prototypeFilePath(ref, { requirementId, name: "登录页", version: 1 }), "utf8")).toBe(HTML);
});

test("待确认信息带版本、指纹、大小、路径和交稿说明", async () => {
  await designed("登录页", HTML, "三项状态横排");
  const pending = await pendingConfirmation(ref, { requirementId, name: "登录页" });
  expect(pending).toMatchObject({
    name: "登录页", version: 1, bytes: Buffer.byteLength(HTML), note: "三项状态横排", previousOpinion: null,
    path: prototypeFilePath(ref, { requirementId, name: "登录页", version: 1 }),
  });
  expect(pending.hash).toMatch(/^[0-9a-f]{64}$/);
});

test("文件在交稿后被改一个字节，查待确认信息报文件被改过", async () => {
  await designed("登录页");
  const path = prototypeFilePath(ref, { requirementId, name: "登录页", version: 1 });
  writeFileSync(path, HTML.replace("状态", "状况"));
  const error = await failure(() => pendingConfirmation(ref, { requirementId, name: "登录页" }));
  expect(error.advice.why).toContain("文件在交稿后被改过");
});

test("文件在交稿后被改一个字节，登记决定报文件被改过且草稿不变", async () => {
  await designed("登录页");
  const hash = (await pendingConfirmation(ref, { requirementId, name: "登录页" })).hash;
  writeFileSync(prototypeFilePath(ref, { requirementId, name: "登录页", version: 1 }), `${HTML} `);
  const error = await failure(() => decidePrototype(ref, { requirementId, name: "登录页", version: 1, hash, choice: "accept", option: null, opinion: null }));
  expect(error.advice.why).toContain("文件在交稿后被改过");
  expect((await entryOf("登录页"))?.draft ?? null).toBeNull();
});

test("没有等确认的原型时登记决定被拒", async () => {
  await begin("登录页");
  await failure(() => decidePrototype(ref, { requirementId, name: "登录页", version: 1, hash: HASH, choice: "accept", option: null, opinion: null }));
});

test("通过后草稿里是这一版并清掉在途", async () => {
  const pending = await accepted("登录页");
  expect((await entryOf("登录页"))?.draft).toMatchObject({ version: 1, hash: pending.hash });
  expect(await inFlightSummary(ref, requirementId)).toEqual([]);
});

test("通过新版本后草稿里同名旧版本被替换", async () => {
  await accepted("登录页");
  const second = await accepted("登录页", HTML2);
  expect((await entryOf("登录页"))?.draft).toMatchObject({ version: 2, hash: second.hash });
});

async function awaitingHash(name = "登录页") {
  const { version } = await designed(name);
  return { version, hash: (await pendingConfirmation(ref, { requirementId, name })).hash };
}
const draftPicked = async (name = "登录页") => (await draftPrototypes(ref, requirementId)).items.find((item) => item.name === name)?.picked;
const OPTIONS = ["顶部分栏", "左侧导航"];
const decide = (version: number, hash: string, option: string | null) =>
  decidePrototype(ref, { requirementId, name: "登录页", version, hash, choice: "accept", option, opinion: null });

test("带方案清单交稿后，待确认信息的 options 是这份清单", async () => {
  await designed("登录页", HTML, "n", OPTIONS);
  expect((await pendingConfirmation(ref, { requirementId, name: "登录页" })).options).toEqual(OPTIONS);
});

test("不附清单或附空数组交稿，待确认信息的 options 是空数组", async () => {
  await designed("登录页");
  expect((await pendingConfirmation(ref, { requirementId, name: "登录页" })).options).toEqual([]);
  await designed("设置页", HTML, "n", []);
  expect((await pendingConfirmation(ref, { requirementId, name: "设置页" })).options).toEqual([]);
});

test("方案名首尾空白被去掉后存下", async () => {
  await designed("登录页", HTML, "n", [" 顶部分栏 ", "左侧导航"]);
  expect((await pendingConfirmation(ref, { requirementId, name: "登录页" })).options).toEqual(OPTIONS);
});

test("方案名里的零宽字符、双向控制符和终端控制序列被去掉后存下", async () => {
  await designed("登录页", HTML, "n", ["顶部\u200b分栏", "左侧\u202e导航", "\x1b[31m第三种"]);
  expect((await pendingConfirmation(ref, { requirementId, name: "登录页" })).options).toEqual(["顶部分栏", "左侧导航", "第三种"]);
});

test("方案名中间的换行和连续空白合并成一个空格后存下", async () => {
  await designed("登录页", HTML, "n", ["顶部\n分栏", "左侧  导航"]);
  expect((await pendingConfirmation(ref, { requirementId, name: "登录页" })).options).toEqual(["顶部 分栏", "左侧 导航"]);
});

const BAD_OPTIONS: Array<[string, string[], string]> = [
  ["只有 1 个方案", ["顶部分栏"], "方案清单只有 1 个方案，至少 2 个；只画了一种方案时不附清单"],
  ["超过 6 个方案", ["一", "二", "三", "四", "五", "六", "七"], "方案清单有 7 个方案，最多 6 个"],
  ["有方案名是空白", ["顶部分栏", "  "], "第 2 个方案名是空的"],
  ["有方案名超过 20 字", ["顶部分栏", "长".repeat(21)], "第 2 个方案名超过 20 字"],
  ["有两个方案重名", ["顶部分栏", " 顶部分栏 "], "第 1 个和第 2 个方案重名"],
];

test.each(BAD_OPTIONS)("方案清单%s时交稿被退回并写明原因，这一版仍是设计中", async (_label, options, why) => {
  const runId = uuidv7();
  await begin("登录页", runId);
  const error = await failure(() => submitDesign(ref, { requirementId, name: "登录页", runId, html: HTML, note: "n", options }));
  expect(error.advice.why).toBe(why);
  expect(error.advice.next).toBe("改好方案清单后重交");
  expect(await inFlightSummary(ref, requirementId)).toEqual([{ name: "登录页", version: 1, status: "designing" }]);
});

test("方案名恰好 20 字和清单恰好 6 个都可以交稿", async () => {
  await designed("登录页", HTML, "n", ["长".repeat(20), "二", "三", "四", "五", "六"]);
  expect((await pendingConfirmation(ref, { requirementId, name: "登录页" })).options).toHaveLength(6);
});

test("方案名按码点数字数，20 个增补平面字符可以交稿", async () => {
  await designed("登录页", HTML, "n", ["\u{20000}".repeat(20), "二"]);
  expect((await pendingConfirmation(ref, { requirementId, name: "登录页" })).options[0]).toBe("\u{20000}".repeat(20));
});

test("多个问题同时存在时按先少于 2 个、再多于 6 个、再空名、超长、重名的顺序报第一个", async () => {
  const runId = uuidv7();
  await begin("登录页", runId);
  const error = await failure(() => submitDesign(ref, { requirementId, name: "登录页", runId, html: HTML, note: "n", options: ["长".repeat(21), "长".repeat(21), " "] }));
  expect(error.advice.why).toBe("第 3 个方案名是空的");
});

test("带清单选 B 通过，草稿里这一版的选定方案是 B 和它的名称", async () => {
  const { version, hash } = await (async () => { const d = await designed("登录页", HTML, "n", OPTIONS); return { version: d.version, hash: (await pendingConfirmation(ref, { requirementId, name: "登录页" })).hash }; })();
  await decide(version, hash, "B");
  expect(await draftPicked()).toEqual({ letter: "B", name: "左侧导航" });
  expect((await entryOf("登录页"))?.draft).toMatchObject({ version, picked: { letter: "B", name: "左侧导航" } });
});

test("带清单通过但 option 为 null 被拒，草稿不变且仍在等确认", async () => {
  const d = await designed("登录页", HTML, "n", OPTIONS);
  const hash = (await pendingConfirmation(ref, { requirementId, name: "登录页" })).hash;
  expect((await failure(() => decide(d.version, hash, null))).advice.why).toContain("通过时必须选其中一个");
  expect((await entryOf("登录页"))?.draft ?? null).toBeNull();
  expect((await inFlightSummary(ref, requirementId))[0]?.status).toBe("awaiting");
});

test("带清单通过但字母不在清单里被拒，草稿不变", async () => {
  const d = await designed("登录页", HTML, "n", OPTIONS);
  const hash = (await pendingConfirmation(ref, { requirementId, name: "登录页" })).hash;
  expect((await failure(() => decide(d.version, hash, "C"))).advice.why).toContain("通过时必须选其中一个");
  expect((await entryOf("登录页"))?.draft ?? null).toBeNull();
});

test("没有清单却带字母通过被拒，草稿不变", async () => {
  const { version, hash } = await awaitingHash();
  expect((await failure(() => decide(version, hash, "A"))).advice.why).toBe("这份原型没有方案清单，不能选方案");
  expect((await entryOf("登录页"))?.draft ?? null).toBeNull();
});

test("没有清单通过时选定方案是 null", async () => {
  await accepted("登录页");
  expect(await draftPicked()).toBeNull();
});

test("同名新版本以无字母通过替换旧版本后，草稿里的选定方案是 null", async () => {
  const first = await designed("登录页", HTML, "n", OPTIONS);
  const firstHash = (await pendingConfirmation(ref, { requirementId, name: "登录页" })).hash;
  await decide(first.version, firstHash, "B");
  expect(await draftPicked()).toEqual({ letter: "B", name: "左侧导航" });
  await accepted("登录页", HTML2);
  expect((await entryOf("登录页"))?.draft).toMatchObject({ version: 2 });
  expect(await draftPicked()).toBeNull();
});

test("放弃后草稿里同名已通过版本和它的选定方案不变", async () => {
  const first = await designed("登录页", HTML, "n", OPTIONS);
  const firstHash = (await pendingConfirmation(ref, { requirementId, name: "登录页" })).hash;
  await decide(first.version, firstHash, "B");
  const second = await designed("登录页", HTML2);
  const hash = (await pendingConfirmation(ref, { requirementId, name: "登录页" })).hash;
  await decidePrototype(ref, { requirementId, name: "登录页", version: second.version, hash, choice: "abandon", option: null, opinion: null });
  expect((await entryOf("登录页"))?.draft).toMatchObject({ version: 1, hash: firstHash, picked: { letter: "B", name: "左侧导航" } });
  expect(await inFlightSummary(ref, requirementId)).toEqual([]);
});

test("pickedOptionText 写成字母加方案名并注明其余方案不做", () => {
  expect(pickedOptionText({ letter: "B", name: "左侧导航" })).toBe("B「左侧导航」，其余方案不做");
});

test("有一份在途原型时批准被拦下，处理办法写明通过或在确认窗口按 Esc 放弃", () => {
  const error = inFlightBlock([{ name: "登录页", version: 1, status: "awaiting" }]);
  expect(error?.advice.next).toBe("先把它处理完（通过，或在确认窗口按 Esc 放弃），再说批准");
});

test("有两份在途原型时批准被拦下，处理办法写明这 2 份", () => {
  const error = inFlightBlock([{ name: "登录页", version: 1, status: "awaiting" }, { name: "设置页", version: 2, status: "designing" }]);
  expect(error?.advice.next).toBe("先把这 2 份处理完（通过，或在确认窗口按 Esc 放弃），再说批准");
});

const opine = async (opinion: string | null, name = "登录页") => {
  const { version, hash } = await pendingConfirmation(ref, { requirementId, name });
  return decidePrototype(ref, { requirementId, name, version, hash, choice: "opinion", option: null, opinion });
};

test("提意见没有内容或只有空白时被拒，看板不变", async () => {
  await designed("登录页");
  const before = await board();
  await failure(() => opine(null));
  await failure(() => opine("   "));
  expect(await board()).toEqual(before);
});

test("提意见超过 4000 字时被拒，看板不变", async () => {
  await designed("登录页");
  const before = await board();
  await failure(() => opine("改".repeat(4001)));
  expect(await board()).toEqual(before);
});

test("提意见记下去掉首尾空白的原话，这一版仍在等确认且不进草稿", async () => {
  await designed("登录页");
  await opine("  B 方案窄屏怎么排？ ");
  const entry = await entryOf("登录页");
  expect(entry?.lastOpinion).toEqual({ version: 1, opinion: "B 方案窄屏怎么排？" });
  expect(entry?.inFlight).toMatchObject({ version: 1, status: "awaiting" });
  expect(entry?.draft ?? null).toBeNull();
  expect(await inFlightSummary(ref, requirementId)).toEqual([{ name: "登录页", version: 1, status: "awaiting" }]);
});

test("同一版再提一次意见以最后一次为准", async () => {
  await designed("登录页");
  await opine("  B 方案窄屏怎么排？ ");
  await opine("改成横向滚动");
  expect((await entryOf("登录页"))?.lastOpinion).toEqual({ version: 1, opinion: "改成横向滚动" });
});

test("提过意见后重派，旧版作废、版本加一，交回上一版位置和意见原话", async () => {
  await designed("登录页");
  await opine("改成横向滚动");
  const next = await begin("登录页");
  expect(next).toEqual({ version: 2, previous: { path: prototypeFilePath(ref, { requirementId, name: "登录页", version: 1 }), opinion: "改成横向滚动" } });
  const entry = await entryOf("登录页");
  expect(entry?.inFlight).toMatchObject({ version: 2, status: "designing" });
  expect(entry?.draft ?? null).toBeNull();
  expect(entry?.lastEnded).toEqual({ version: 1, reason: "用户提了意见后重派，这一版作废" });
  expect(existsSync(prototypeFilePath(ref, { requirementId, name: "登录页", version: 1 }))).toBe(true);
});

test("提意见后重派并交稿，新一版的待确认信息带上上一版的意见", async () => {
  await designed("登录页");
  await opine("改成横向滚动");
  await designed("登录页", HTML2);
  expect((await pendingConfirmation(ref, { requirementId, name: "登录页" })).previousOpinion).toBe("改成横向滚动");
});

test("对第 1 版提的意见不能拿来顶替重派后新交稿的第 2 版：再派被拒，看板不变", async () => {
  await designed("登录页");
  await opine("改成横向滚动");
  await designed("登录页", HTML2);
  const before = await entryOf("登录页");
  const error = await failure(() => begin("登录页"));
  expect(error.advice.why).toBe("原型「登录页」第 2 版还在等用户确认，用户没有对它提意见，不能重派");
  expect(await entryOf("登录页")).toEqual(before);
});

test("意见恰好 4000 字可以登记", async () => {
  await designed("登录页");
  await opine("意".repeat(4000));
  expect((await entryOf("登录页"))?.lastOpinion).toMatchObject({ version: 1, opinion: "意".repeat(4000) });
});

test("提意见后不重派，直接再开待确认信息，上一版意见不是这一版自己的意见", async () => {
  await designed("登录页");
  await opine("改成横向滚动");
  expect((await pendingConfirmation(ref, { requirementId, name: "登录页" })).previousOpinion ?? null).toBeNull();
});

test("同名原型等确认且用户没提过意见时重派被拒，写明原因和下一步，看板不变", async () => {
  await designed("登录页");
  const before = await board();
  const error = await failure(() => begin("登录页"));
  expect(error.advice.why).toBe("原型「登录页」第 1 版还在等用户确认，用户没有对它提意见，不能重派");
  expect(error.advice.next).toBe("先请用户在确认窗口里处理");
  expect(await board()).toEqual(before);
});

test("提意见后通过，意见被清掉", async () => {
  await designed("登录页");
  await opine("再改");
  const hash = (await pendingConfirmation(ref, { requirementId, name: "登录页" })).hash;
  await decidePrototype(ref, { requirementId, name: "登录页", version: 1, hash, choice: "accept", option: null, opinion: null });
  expect((await entryOf("登录页"))?.lastOpinion ?? null).toBeNull();
});

test("提意见后放弃，意见被清掉", async () => {
  await designed("登录页");
  await opine("再改");
  const hash = (await pendingConfirmation(ref, { requirementId, name: "登录页" })).hash;
  await decidePrototype(ref, { requirementId, name: "登录页", version: 1, hash, choice: "abandon", option: null, opinion: null });
  expect((await entryOf("登录页"))?.lastOpinion ?? null).toBeNull();
  expect((await begin("登录页")).previous?.opinion ?? null).toBeNull();
});

test("放弃后草稿里同名旧版本不变并清掉意见", async () => {
  const first = await accepted("登录页");
  const { version } = await designed("登录页", HTML2);
  const hash = (await pendingConfirmation(ref, { requirementId, name: "登录页" })).hash;
  await decidePrototype(ref, { requirementId, name: "登录页", version, hash, choice: "abandon", option: null, opinion: null });
  expect((await entryOf("登录页"))?.draft).toMatchObject({ version: 1, hash: first.hash });
  expect(await inFlightSummary(ref, requirementId)).toEqual([]);
  expect((await entryOf("登录页"))?.lastOpinion ?? null).toBeNull();
});

test("放弃后版本号仍然只增不减", async () => {
  const { version } = await designed("登录页");
  const hash = (await pendingConfirmation(ref, { requirementId, name: "登录页" })).hash;
  await decidePrototype(ref, { requirementId, name: "登录页", version, hash, choice: "abandon", option: null, opinion: null });
  expect((await begin("登录页")).version).toBe(2);
});

test("移除只对草稿里有的原型", async () => {
  await failure(() => removeFromDraft(ref, { requirementId, name: "登录页", version: 1 }));
});

test("移除后草稿里不再有这个原型", async () => {
  await accepted("登录页");
  await removeFromDraft(ref, { requirementId, name: "登录页", version: 1 });
  expect((await draftPrototypes(ref, requirementId)).items.filter((item) => item.label !== "removed")).toEqual([]);
});

test("通过后移除再派得到版本 2，版本 1 的文件仍在且内容不变", async () => {
  await accepted("登录页");
  await removeFromDraft(ref, { requirementId, name: "登录页", version: 1 });
  const next = await begin("登录页");
  expect(next.version).toBe(2);
  const first = prototypeFilePath(ref, { requirementId, name: "登录页", version: 1 });
  expect(existsSync(first)).toBe(true);
  expect(readFileSync(first, "utf8")).toBe(HTML);
});

test("设计没交稿就结束时清掉在途并记下结束原因", async () => {
  const runId = uuidv7();
  await begin("登录页", runId);
  await endDesign(ref, { runId, reason: "设计师轮数用完仍没交稿" });
  expect(await inFlightSummary(ref, requirementId)).toEqual([]);
  expect((await entryOf("登录页"))?.lastEnded).toMatchObject({ version: 1, reason: expect.stringContaining("轮数用完") });
  expect((await begin("登录页")).version).toBe(2);
});

test("结束的运行不是在途运行时不动看板", async () => {
  await begin("登录页");
  await endDesign(ref, { runId: uuidv7(), reason: "无关运行" });
  expect((await inFlightSummary(ref, requirementId))[0]?.status).toBe("designing");
});

test("清理残留只清设计中的，不动等确认的", async () => {
  await begin("设置页");
  await designed("登录页");
  await clearStaleDesigns(ref);
  expect(await inFlightSummary(ref, requirementId)).toEqual([{ name: "登录页", version: 1, status: "awaiting" }]);
});

test("草稿集合：新确认的标 new，没动过的沿用批准版本标 kept", async () => {
  await accepted("登录页");
  await accepted("设置页");
  const first = await draftPrototypes(ref, requirementId);
  expect(first.items.map((item) => [item.name, item.label]).sort()).toEqual([["登录页", "new"], ["设置页", "new"]]);
  promote(ref, { requirementId, digest: first.digest });
  await accepted("登录页", HTML2);
  const second = await draftPrototypes(ref, requirementId);
  const labels = Object.fromEntries(second.items.map((item) => [item.name, item.label]));
  expect(labels).toEqual({ 登录页: "new", 设置页: "kept" });
  expect(second.items.find((item) => item.name === "登录页")?.version).toBe(2);
});

test("草稿集合：已移除的批准版本带 removed 标签且不参与指纹", async () => {
  await accepted("登录页");
  const only = await draftPrototypes(ref, requirementId);
  promote(ref, { requirementId, digest: only.digest });
  await accepted("设置页");
  const both = await draftPrototypes(ref, requirementId);
  await removeFromDraft(ref, { requirementId, name: "登录页", version: 1 });
  const after = await draftPrototypes(ref, requirementId);
  expect(after.items.find((item) => item.name === "登录页")?.label).toBe("removed");
  expect(after.items.find((item) => item.name === "设置页")?.label).toBe("new");
  expect(after.digest).not.toBe(both.digest);
});

test("草稿集合相同则指纹相同，不同则指纹不同", async () => {
  await accepted("登录页");
  const one = await draftPrototypes(ref, requirementId);
  expect((await draftPrototypes(ref, requirementId)).digest).toBe(one.digest);
  promote(ref, { requirementId, digest: one.digest });
  expect((await draftPrototypes(ref, requirementId)).digest).toBe(one.digest);
  await accepted("登录页", HTML2);
  expect((await draftPrototypes(ref, requirementId)).digest).not.toBe(one.digest);
});

test("还有原型在途时批准提升被拒且草稿不变", async () => {
  await accepted("登录页");
  const { digest } = await draftPrototypes(ref, requirementId);
  await begin("设置页");
  await failure(() => promote(ref, { requirementId, digest }));
  expect((await entryOf("登录页"))?.draft).not.toBeNull();
  expect((await entryOf("登录页"))?.approved ?? null).toBeNull();
});

test("有原型等确认时批准提升也被拒", async () => {
  await accepted("登录页");
  const { digest } = await draftPrototypes(ref, requirementId);
  await designed("设置页");
  await failure(() => promote(ref, { requirementId, digest }));
});

test("指纹与当前草稿不一致时批准提升被拒", async () => {
  await accepted("登录页");
  await failure(() => promote(ref, { requirementId, digest: "0".repeat(64) }));
  expect((await entryOf("登录页"))?.approved ?? null).toBeNull();
});

test("批准提升后批准集合更新、草稿清空", async () => {
  const pending = await accepted("登录页");
  const { digest } = await draftPrototypes(ref, requirementId);
  promote(ref, { requirementId, digest });
  const entry = await entryOf("登录页");
  expect(entry?.approved).toMatchObject({ version: 1, hash: pending.hash });
  expect(entry?.draft).toBeNull();
  expect(entry?.removed).toBe(false);
});

test("批准提升会带走移除：被移除的原型不再在批准集合里", async () => {
  await accepted("登录页");
  promote(ref, { requirementId, digest: (await draftPrototypes(ref, requirementId)).digest });
  await accepted("设置页");
  await removeFromDraft(ref, { requirementId, name: "登录页", version: 1 });
  promote(ref, { requirementId, digest: (await draftPrototypes(ref, requirementId)).digest });
  const removed = await entryOf("登录页"), kept = await entryOf("设置页");
  expect(removed).toMatchObject({ approved: null, draft: null, removed: false, lastVersion: 1 });
  expect(kept?.approved?.version).toBe(1);
  expect(kept?.draft).toBeNull();
});

test("v1 通过后 v2 提意见，再把 v1 从草稿移除，v2 的意见还在，照样能重派并带上原话", async () => {
  await accepted("登录页");
  await designed("登录页", HTML2);
  await opine("改大");
  await removeFromDraft(ref, { requirementId, name: "登录页", version: 1 });
  expect((await entryOf("登录页"))?.lastOpinion).toMatchObject({ version: 2, opinion: "改大" });
  expect((await begin("登录页")).previous?.opinion).toBe("改大");
});

test("没有意见时再派，上一版位置指向草稿里通过的那一版，意见为空", async () => {
  await accepted("登录页");
  expect((await begin("登录页")).previous).toEqual({ path: prototypeFilePath(ref, { requirementId, name: "登录页", version: 1 }), opinion: null });
});

test("读文件出错但文件还在时不作废这一版，恢复后可照常确认", async () => {
  const { version } = await designed("登录页");
  const path = prototypeFilePath(ref, { requirementId, name: "登录页", version });
  chmodSync(path, 0o000);
  try {
    await expect(pendingConfirmation(ref, { requirementId, name: "登录页" })).rejects.toThrow();
  } finally { chmodSync(path, 0o600); }
  expect((await entryOf("登录页"))?.inFlight?.status).toBe("awaiting");
  expect((await pendingConfirmation(ref, { requirementId, name: "登录页" })).version).toBe(version);
});

test("交稿后文件被改，查待确认信息时这一版作废并写明原因，可再派得到下一版本", async () => {
  await designed("登录页");
  writeFileSync(prototypeFilePath(ref, { requirementId, name: "登录页", version: 1 }), `${HTML} `);
  const error = await failure(() => pendingConfirmation(ref, { requirementId, name: "登录页" }));
  expect(error.advice.why).toContain("文件在交稿后被改过");
  expect(error.advice.next).not.toContain("PM");
  expect(error.advice.next).toContain("重新派");
  const entry = await entryOf("登录页");
  expect(entry?.inFlight).toBeNull();
  expect(entry?.lastEnded?.reason).toContain("文件在交稿后被改过");
  expect(await inFlightSummary(ref, requirementId)).toEqual([]);
  expect((await begin("登录页")).version).toBe(2);
});

test("交稿后文件被改，登记决定时这一版作废并写明原因，可再派得到下一版本", async () => {
  await designed("登录页");
  const hash = (await pendingConfirmation(ref, { requirementId, name: "登录页" })).hash;
  writeFileSync(prototypeFilePath(ref, { requirementId, name: "登录页", version: 1 }), `${HTML} `);
  const error = await failure(() => decidePrototype(ref, { requirementId, name: "登录页", version: 1, hash, choice: "accept", option: null, opinion: null }));
  expect(error.advice.why).toContain("文件在交稿后被改过");
  expect(error.advice.next).not.toContain("PM");
  expect(error.advice.next).toContain("重新派");
  const entry = await entryOf("登录页");
  expect(entry?.inFlight).toBeNull();
  expect(entry?.lastEnded?.reason).toContain("文件在交稿后被改过");
  expect(await inFlightSummary(ref, requirementId)).toEqual([]);
  expect((await begin("登录页")).version).toBe(2);
});

test("同一运行并发交两次稿恰好一次成功，磁盘文件就是成功那次的内容", async () => {
  const runId = uuidv7();
  await begin("登录页", runId);
  const htmls = [HTML, HTML2];
  const results = await Promise.allSettled(htmls.map((html) => submitDesign(ref, { requirementId, name: "登录页", runId, html, note: "n" })));
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  const winner = htmls[results.findIndex((result) => result.status === "fulfilled")];
  const pending = await pendingConfirmation(ref, { requirementId, name: "登录页" });
  expect(readFileSync(pending.path, "utf8")).toBe(winner);
});

test("名称只差大小写时派出被拒，完全相同的名称照常算同名", async () => {
  await accepted("Settings");
  const error = await failure(() => begin("settings"));
  expect(`${error.advice.why}${error.advice.next}`).toMatch(/只差大小写|已有名称/);
  expect((await begin("Settings")).version).toBe(2);
});

test("名称只差 Unicode 规范化形式时派出被拒", async () => {
  await accepted("\u00e9");
  const error = await failure(() => begin("e\u0301"));
  expect(`${error.advice.why}${error.advice.next}`).toMatch(/只差大小写|已有名称/);
  expect((await begin("\u00e9")).version).toBe(2);
});

test("名称含孤立代理码点时被拒", async () => {
  expect(() => checkPrototypeName("x\uD800")).toThrow(PrototypeBoardError);
  await failure(() => begin("x\uD800"));
});

test("需求正在完成中时派出被拒", async () => {
  const closing = uuidv7();
  putRequirement(closing, { lifecycle: "closing" });
  await failure(() => begin("登录页", uuidv7(), closing));
});

test("两份原型以不同先后通过，集合相同则指纹相同", async () => {
  const other = uuidv7();
  putRequirement(other);
  await accepted("登录页");
  await accepted("设置页");
  for (const name of ["设置页", "登录页"]) {
    const runId = uuidv7();
    const { version } = await begin(name, runId, other);
    await submitDesign(ref, { requirementId: other, name, runId, html: HTML, note: "三项状态横排" });
    const { hash } = await pendingConfirmation(ref, { requirementId: other, name });
    await decidePrototype(ref, { requirementId: other, name, version, hash, choice: "accept", option: null, opinion: null });
  }
  expect((await draftPrototypes(ref, other)).digest).toBe((await draftPrototypes(ref, requirementId)).digest);
});

test("看板已有 50 份原型时再派新名称被拒，已有名称仍可再派", async () => {
  const firstRun = uuidv7();
  await begin("p0", firstRun);
  for (let index = 1; index < 50; index += 1) await begin(`p${index}`);
  await failure(() => begin("p50"));
  await endDesign(ref, { runId: firstRun, reason: "结束" });
  expect((await begin("p0")).version).toBe(2);
});

test("交稿说明超过 2000 字被拒且看板仍是设计中", async () => {
  const runId = uuidv7();
  await begin("登录页", runId);
  await failure(() => submitDesign(ref, { requirementId, name: "登录页", runId, html: HTML, note: "说".repeat(2001) }));
  expect((await inFlightSummary(ref, requirementId))[0]?.status).toBe("designing");
});

test("清理残留写进结束记录的原因里含重启", async () => {
  await begin("登录页");
  await clearStaleDesigns(ref);
  expect((await entryOf("登录页"))?.lastEnded?.reason).toContain("重启");
});

function patchRequirement(id: string, patch: Partial<RequirementRecord>): void {
  withDatabase(repositoryDatabase(ref.dataRoot, ref.repoId), (db) => {
    const row = db.read("requirements", id)!;
    db.update("requirements", id, row.version, { ...(row.data as RequirementRecord), ...patch });
  });
}

const UNEDITABLE: Array<[Partial<RequirementRecord>, string]> = [
  ...CLOSED_STATES,
  [{ recovery: "needs_review", recoveryReason: "history_unknown" }, "需求正在等用户恢复核对"],
];

test("需求已关闭、正在关闭或待恢复时设计师交稿被拒，原因写明需求状态，看板仍是设计中", async () => {
  for (const [patch, state] of UNEDITABLE) {
    const id = uuidv7(), runId = uuidv7();
    putRequirement(id);
    await begin("登录页", runId, id);
    patchRequirement(id, patch);
    const error = await failure(() => submitDesign(ref, { requirementId: id, name: "登录页", runId, html: HTML, note: "n" }));
    expect(error.advice.why).toContain(state);
    expect(await inFlightSummary(ref, id)).toEqual([{ name: "登录页", version: 1, status: "designing" }]);
  }
});

test("需求已关闭、正在关闭或待恢复时打开确认窗口被拒，原因写明需求状态，看板仍是等确认", async () => {
  for (const [patch, state] of UNEDITABLE) {
    const id = uuidv7(), runId = uuidv7();
    putRequirement(id);
    await begin("登录页", runId, id);
    await submitDesign(ref, { requirementId: id, name: "登录页", runId, html: HTML, note: "n" });
    patchRequirement(id, patch);
    const error = await failure(() => pendingConfirmation(ref, { requirementId: id, name: "登录页" }));
    expect(error.advice.why).toContain(state);
    expect(await inFlightSummary(ref, id)).toEqual([{ name: "登录页", version: 1, status: "awaiting" }]);
  }
});

test("需求已关闭、正在关闭或待恢复时登记通过、提意见、放弃都被拒，原因写明需求状态，看板不变", async () => {
  for (const [patch, state] of UNEDITABLE) {
    for (const choice of ["accept", "opinion", "abandon"] as const) {
      const id = uuidv7(), runId = uuidv7();
      putRequirement(id);
      await begin("登录页", runId, id);
      await submitDesign(ref, { requirementId: id, name: "登录页", runId, html: HTML, note: "n" });
      const { hash } = await pendingConfirmation(ref, { requirementId: id, name: "登录页" });
      patchRequirement(id, patch);
      const before = await readPrototypeBoard(ref, id);
      const error = await failure(() => decidePrototype(ref, { requirementId: id, name: "登录页", version: 1, hash, choice, option: null, opinion: choice === "opinion" ? "再改" : null }));
      expect(error.advice.why).toContain(state);
      expect(await readPrototypeBoard(ref, id)).toEqual(before);
    }
  }
});

test("需求已关闭、正在关闭或待恢复时移除被拒，原因写明需求状态，草稿不变", async () => {
  for (const [patch, state] of UNEDITABLE) {
    const id = uuidv7(), runId = uuidv7();
    putRequirement(id);
    await begin("登录页", runId, id);
    await submitDesign(ref, { requirementId: id, name: "登录页", runId, html: HTML, note: "n" });
    const { hash } = await pendingConfirmation(ref, { requirementId: id, name: "登录页" });
    await decidePrototype(ref, { requirementId: id, name: "登录页", version: 1, hash, choice: "accept", option: null, opinion: null });
    patchRequirement(id, patch);
    const before = await readPrototypeBoard(ref, id);
    const error = await failure(() => removeFromDraft(ref, { requirementId: id, name: "登录页", version: 1 }));
    expect(error.advice.why).toContain(state);
    expect(await readPrototypeBoard(ref, id)).toEqual(before);
  }
});

test("需求已取消且文件已被改过时登记决定先因需求状态被拒，这一版不作废，仍是等确认", async () => {
  const id = uuidv7(), runId = uuidv7();
  putRequirement(id);
  await begin("登录页", runId, id);
  await submitDesign(ref, { requirementId: id, name: "登录页", runId, html: HTML, note: "n" });
  const { hash } = await pendingConfirmation(ref, { requirementId: id, name: "登录页" });
  writeFileSync(prototypeFilePath(ref, { requirementId: id, name: "登录页", version: 1 }), `${HTML} `);
  patchRequirement(id, closedState("closed", "cancelled"));
  const error = await failure(() => decidePrototype(ref, { requirementId: id, name: "登录页", version: 1, hash, choice: "accept", option: null, opinion: null }));
  expect(error.advice.why).toContain("需求已取消");
  expect(error.advice.why).not.toContain("被改过");
  expect(await inFlightSummary(ref, id)).toEqual([{ name: "登录页", version: 1, status: "awaiting" }]);
});

test("移除时请求带的版本和草稿里的版本不一致被拒，提示重新打开窗口，草稿不变", async () => {
  await accepted("登录页");
  await accepted("登录页", HTML2);
  const before = await readPrototypeBoard(ref, requirementId);
  const error = await failure(() => removeFromDraft(ref, { requirementId, name: "登录页", version: 1 }));
  expect(`${error.advice.why}${error.advice.next}`).toContain("重新打开");
  expect(await readPrototypeBoard(ref, requirementId)).toEqual(before);
  expect((await entryOf("登录页"))?.draft?.version).toBe(2);
});

test("移除时这份原型已不在草稿里被拒，提示重新打开窗口，草稿不变", async () => {
  await accepted("登录页");
  await removeFromDraft(ref, { requirementId, name: "登录页", version: 1 });
  const before = await readPrototypeBoard(ref, requirementId);
  const error = await failure(() => removeFromDraft(ref, { requirementId, name: "登录页", version: 1 }));
  expect(`${error.advice.why}${error.advice.next}`).toContain("重新打开");
  expect(await readPrototypeBoard(ref, requirementId)).toEqual(before);
});

test("移除时版本一致照常移除", async () => {
  await accepted("登录页");
  await accepted("登录页", HTML2);
  await removeFromDraft(ref, { requirementId, name: "登录页", version: 2 });
  expect((await draftPrototypes(ref, requirementId)).items.filter((item) => item.label !== "removed")).toEqual([]);
});

test("批准提升时有原型设计中，原因逐个写出名称和设计师还在做，不说原型变了", async () => {
  await accepted("登录页");
  const { digest } = await draftPrototypes(ref, requirementId);
  await begin("设置页");
  const error = await failure(() => promote(ref, { requirementId, digest }));
  expect(error.advice.why).toContain("设置页");
  expect(error.advice.why).toContain("设计师还在做");
  expect(`${error.advice.why}${error.advice.next}`).not.toContain("在批准过程中变了");
  expect(error.advice.next).toMatch(/通过|放弃/);
});

test("批准提升时有原型等确认，原因逐个写出名称和第几版还在等你确认", async () => {
  await accepted("登录页");
  const { digest } = await draftPrototypes(ref, requirementId);
  await designed("设置页");
  const error = await failure(() => promote(ref, { requirementId, digest }));
  expect(error.advice.why).toContain("设置页");
  expect(error.advice.why).toContain("第 1 版还在等你确认");
  expect(`${error.advice.why}${error.advice.next}`).not.toContain("在批准过程中变了");
});

test("看板已有 50 份原型时再派新名称被拒，建议只写复用已有名称，不提移除", async () => {
  for (let index = 0; index < 50; index += 1) await begin(`p${index}`);
  const error = await failure(() => begin("p50"));
  const text = `${error.advice.why}${error.advice.next}`;
  expect(text).toContain("已有名称");
  expect(text).not.toContain("移除");
});
