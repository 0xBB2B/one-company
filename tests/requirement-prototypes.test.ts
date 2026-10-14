import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { repositoryDatabase, uuidv7, withDatabase } from "../runtime/database.ts";
import type { RequirementRecord } from "../runtime/requirement-contracts.ts";
import {
  PrototypeBoardError, beginDesign, checkPrototypeName, clearStaleDesigns, decidePrototype, draftPrototypes, endDesign,
  inFlightSummary, pendingConfirmation, prototypeFilePath, promoteOnApproval, readPrototypeBoard, removeFromDraft, submitDesign,
} from "../runtime/requirement-prototypes.ts";

const HASH = "a".repeat(64);
const HTML = "<!doctype html><html><body><h1>状态面板</h1></body></html>";
const HTML2 = "<!doctype html><html><body><h1>状态面板</h1><p>速度放大</p></body></html>";
const MIB = 1_048_576;

let dataRoot: string;
let ref: { dataRoot: string; repoId: string };
let requirementId: string;

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

async function failure(run: () => unknown): Promise<PrototypeBoardError> {
  try { await run(); } catch (error) {
    expect(error).toBeInstanceOf(PrototypeBoardError);
    return error as PrototypeBoardError;
  }
  throw new Error("预期抛错，但调用成功了");
}

const begin = (name: string, runId = uuidv7(), id = requirementId) => beginDesign(ref, { requirementId: id, name, runId, agent: "designer" });
async function designed(name: string, html = HTML, note = "三项状态横排") {
  const runId = uuidv7();
  const started = await begin(name, runId);
  await submitDesign(ref, { requirementId, name, runId, html, note });
  return { runId, version: started.version };
}
async function accepted(name: string, html = HTML) {
  const { version } = await designed(name, html);
  const pending = await pendingConfirmation(ref, { requirementId, name });
  await decidePrototype(ref, { requirementId, name, version, hash: pending.hash, choice: "accept", opinion: null });
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

test("同名原型已交稿等确认时再次派出被拒并写明还在等确认", async () => {
  await designed("登录页");
  const error = await failure(() => begin("登录页"));
  expect(error.advice.why).toContain("还在等确认");
});

test("不同名称的原型可以同时在途", async () => {
  await begin("登录页");
  await begin("设置页");
  expect((await inFlightSummary(ref, requirementId)).map((entry) => entry.name).sort()).toEqual(["登录页", "设置页"]);
});

test("需求不存在时派出被拒", async () => {
  await failure(() => begin("登录页", uuidv7(), uuidv7()));
});

test("需求已完成时派出被拒", async () => {
  const closed = uuidv7();
  putRequirement(closed, { lifecycle: "closed" });
  await failure(() => begin("登录页", uuidv7(), closed));
});

test("需求处于待恢复状态时派出被拒", async () => {
  const stuck = uuidv7();
  putRequirement(stuck, { recovery: "needs_review", recoveryReason: "history_unknown" });
  await failure(() => begin("登录页", uuidv7(), stuck));
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
  const error = await failure(() => decidePrototype(ref, { requirementId, name: "登录页", version: 1, hash, choice: "accept", opinion: null }));
  expect(error.advice.why).toContain("文件在交稿后被改过");
  expect((await entryOf("登录页"))?.draft ?? null).toBeNull();
});

test("没有等确认的原型时登记决定被拒", async () => {
  await begin("登录页");
  await failure(() => decidePrototype(ref, { requirementId, name: "登录页", version: 1, hash: HASH, choice: "accept", opinion: null }));
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

test("返工没有意见时被拒", async () => {
  const { version } = await designed("登录页");
  const hash = (await pendingConfirmation(ref, { requirementId, name: "登录页" })).hash;
  await failure(() => decidePrototype(ref, { requirementId, name: "登录页", version, hash, choice: "rework", opinion: null }));
  await failure(() => decidePrototype(ref, { requirementId, name: "登录页", version, hash, choice: "rework", opinion: "   " }));
  expect((await inFlightSummary(ref, requirementId))[0]?.status).toBe("awaiting");
});

test("返工意见超过 4000 字时被拒", async () => {
  const { version } = await designed("登录页");
  const hash = (await pendingConfirmation(ref, { requirementId, name: "登录页" })).hash;
  await failure(() => decidePrototype(ref, { requirementId, name: "登录页", version, hash, choice: "rework", opinion: "改".repeat(4001) }));
});

test("返工有意见时记下原话，下次派出交回上一版位置和这句话", async () => {
  const { version } = await designed("登录页");
  const hash = (await pendingConfirmation(ref, { requirementId, name: "登录页" })).hash;
  const opinion = "按钮再大一点，颜色换成蓝色";
  await decidePrototype(ref, { requirementId, name: "登录页", version, hash, choice: "rework", opinion });
  expect((await entryOf("登录页"))?.lastRework).toMatchObject({ version: 1, opinion });
  expect(await inFlightSummary(ref, requirementId)).toEqual([]);
  const next = await begin("登录页");
  expect(next.version).toBe(2);
  expect(next.previous).toEqual({ path: prototypeFilePath(ref, { requirementId, name: "登录页", version: 1 }), opinion });
});

test("返工不改变草稿里的旧版本", async () => {
  await accepted("登录页");
  const { version } = await designed("登录页", HTML2);
  const hash = (await pendingConfirmation(ref, { requirementId, name: "登录页" })).hash;
  await decidePrototype(ref, { requirementId, name: "登录页", version, hash, choice: "rework", opinion: "再改" });
  expect((await entryOf("登录页"))?.draft?.version).toBe(1);
});

test("通过后返工意见被清掉", async () => {
  const { version } = await designed("登录页");
  let hash = (await pendingConfirmation(ref, { requirementId, name: "登录页" })).hash;
  await decidePrototype(ref, { requirementId, name: "登录页", version, hash, choice: "rework", opinion: "再改" });
  await designed("登录页", HTML2);
  hash = (await pendingConfirmation(ref, { requirementId, name: "登录页" })).hash;
  await decidePrototype(ref, { requirementId, name: "登录页", version: 2, hash, choice: "accept", opinion: null });
  expect((await entryOf("登录页"))?.lastRework ?? null).toBeNull();
  expect((await begin("登录页")).previous?.opinion ?? null).toBeNull();
});

test("放弃后草稿里同名旧版本不变并清掉返工意见", async () => {
  const first = await accepted("登录页");
  const { version } = await designed("登录页", HTML2);
  const hash = (await pendingConfirmation(ref, { requirementId, name: "登录页" })).hash;
  await decidePrototype(ref, { requirementId, name: "登录页", version, hash, choice: "abandon", opinion: null });
  expect((await entryOf("登录页"))?.draft).toMatchObject({ version: 1, hash: first.hash });
  expect(await inFlightSummary(ref, requirementId)).toEqual([]);
  expect((await entryOf("登录页"))?.lastRework ?? null).toBeNull();
});

test("放弃后版本号仍然只增不减", async () => {
  const { version } = await designed("登录页");
  const hash = (await pendingConfirmation(ref, { requirementId, name: "登录页" })).hash;
  await decidePrototype(ref, { requirementId, name: "登录页", version, hash, choice: "abandon", opinion: null });
  expect((await begin("登录页")).version).toBe(2);
});

test("移除只对草稿里有的原型", async () => {
  await failure(() => removeFromDraft(ref, { requirementId, name: "登录页" }));
});

test("移除后草稿里不再有这个原型", async () => {
  await accepted("登录页");
  await removeFromDraft(ref, { requirementId, name: "登录页" });
  expect((await draftPrototypes(ref, requirementId)).items.filter((item) => item.label !== "removed")).toEqual([]);
});

test("通过后移除再派得到版本 2，版本 1 的文件仍在且内容不变", async () => {
  await accepted("登录页");
  await removeFromDraft(ref, { requirementId, name: "登录页" });
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
  await promoteOnApproval(ref, { requirementId, digest: first.digest });
  await accepted("登录页", HTML2);
  const second = await draftPrototypes(ref, requirementId);
  const labels = Object.fromEntries(second.items.map((item) => [item.name, item.label]));
  expect(labels).toEqual({ 登录页: "new", 设置页: "kept" });
  expect(second.items.find((item) => item.name === "登录页")?.version).toBe(2);
});

test("草稿集合：已移除的批准版本带 removed 标签且不参与指纹", async () => {
  await accepted("登录页");
  const only = await draftPrototypes(ref, requirementId);
  await promoteOnApproval(ref, { requirementId, digest: only.digest });
  await accepted("设置页");
  const both = await draftPrototypes(ref, requirementId);
  await removeFromDraft(ref, { requirementId, name: "登录页" });
  const after = await draftPrototypes(ref, requirementId);
  expect(after.items.find((item) => item.name === "登录页")?.label).toBe("removed");
  expect(after.items.find((item) => item.name === "设置页")?.label).toBe("new");
  expect(after.digest).not.toBe(both.digest);
});

test("草稿集合相同则指纹相同，不同则指纹不同", async () => {
  await accepted("登录页");
  const one = await draftPrototypes(ref, requirementId);
  expect((await draftPrototypes(ref, requirementId)).digest).toBe(one.digest);
  await promoteOnApproval(ref, { requirementId, digest: one.digest });
  expect((await draftPrototypes(ref, requirementId)).digest).toBe(one.digest);
  await accepted("登录页", HTML2);
  expect((await draftPrototypes(ref, requirementId)).digest).not.toBe(one.digest);
});

test("还有原型在途时批准提升被拒且草稿不变", async () => {
  await accepted("登录页");
  const { digest } = await draftPrototypes(ref, requirementId);
  await begin("设置页");
  await failure(() => promoteOnApproval(ref, { requirementId, digest }));
  expect((await entryOf("登录页"))?.draft).not.toBeNull();
  expect((await entryOf("登录页"))?.approved ?? null).toBeNull();
});

test("有原型等确认时批准提升也被拒", async () => {
  await accepted("登录页");
  const { digest } = await draftPrototypes(ref, requirementId);
  await designed("设置页");
  await failure(() => promoteOnApproval(ref, { requirementId, digest }));
});

test("指纹与当前草稿不一致时批准提升被拒", async () => {
  await accepted("登录页");
  await failure(() => promoteOnApproval(ref, { requirementId, digest: "0".repeat(64) }));
  expect((await entryOf("登录页"))?.approved ?? null).toBeNull();
});

test("批准提升后批准集合更新、草稿清空", async () => {
  const pending = await accepted("登录页");
  const { digest } = await draftPrototypes(ref, requirementId);
  await promoteOnApproval(ref, { requirementId, digest });
  const entry = await entryOf("登录页");
  expect(entry?.approved).toMatchObject({ version: 1, hash: pending.hash });
  expect(entry?.draft).toBeNull();
  expect(entry?.removed).toBe(false);
});

test("批准提升会带走移除：被移除的原型不再在批准集合里", async () => {
  await accepted("登录页");
  await promoteOnApproval(ref, { requirementId, digest: (await draftPrototypes(ref, requirementId)).digest });
  await accepted("设置页");
  await removeFromDraft(ref, { requirementId, name: "登录页" });
  await promoteOnApproval(ref, { requirementId, digest: (await draftPrototypes(ref, requirementId)).digest });
  const removed = await entryOf("登录页"), kept = await entryOf("设置页");
  expect(removed).toMatchObject({ approved: null, draft: null, removed: false, lastVersion: 1 });
  expect(kept?.approved?.version).toBe(1);
  expect(kept?.draft).toBeNull();
});

test("v1 通过后 v2 返工，再移除，下次派出时返工意见已清掉", async () => {
  await accepted("登录页");
  const { version } = await designed("登录页", HTML2);
  const hash = (await pendingConfirmation(ref, { requirementId, name: "登录页" })).hash;
  await decidePrototype(ref, { requirementId, name: "登录页", version, hash, choice: "rework", opinion: "改大" });
  await removeFromDraft(ref, { requirementId, name: "登录页" });
  expect((await entryOf("登录页"))?.lastRework ?? null).toBeNull();
  expect((await begin("登录页")).previous?.opinion ?? null).toBeNull();
});

test("没有返工时再派，上一版位置指向草稿里通过的那一版，意见为空", async () => {
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
  const error = await failure(() => decidePrototype(ref, { requirementId, name: "登录页", version: 1, hash, choice: "accept", opinion: null }));
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
    await decidePrototype(ref, { requirementId: other, name, version, hash, choice: "accept", opinion: null });
  }
  expect((await draftPrototypes(ref, other)).digest).toBe((await draftPrototypes(ref, requirementId)).digest);
});

test("返工后再派并交稿，待确认信息带上返工原话", async () => {
  const { version } = await designed("登录页");
  const hash = (await pendingConfirmation(ref, { requirementId, name: "登录页" })).hash;
  await decidePrototype(ref, { requirementId, name: "登录页", version, hash, choice: "rework", opinion: "按钮再大一点" });
  await designed("登录页", HTML2);
  expect((await pendingConfirmation(ref, { requirementId, name: "登录页" })).previousOpinion).toBe("按钮再大一点");
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
