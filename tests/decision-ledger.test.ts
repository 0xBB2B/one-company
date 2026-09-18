import { afterEach, describe, expect, test } from "vitest";
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { stat } from "node:fs/promises";
import { addWorktree, createRepoFixture, removeRepoFixture } from "./helpers/repo-fixture.ts";
import { createTempHome, removeTempHome } from "./helpers/temp-home.ts";
import { repositoryIdentity, repoDataDir } from "../runtime/identity.ts";
import { repositoryDatabase, withDatabase, UUID_V7_PATTERN } from "../runtime/database.ts";
import { decisionStream, appendDecision, buildRecord, inspectDecision, nextDecisionId, readDecisions, validateDecisionInput } from "../runtime/decisions.ts";

const REQUIREMENT = "2026-09-08.fixture";
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
async function setup() {
  const home = await createTempHome(); cleanup.push(() => removeTempHome(home));
  const repo = await createRepoFixture(); cleanup.push(() => removeRepoFixture(repo));
  const identity = await repositoryIdentity(repo.root);
  const ctx = { dataRoot: home.dataRoot, cwd: repo.root };
  const database = repositoryDatabase(ctx.dataRoot, identity.repoId);
  const snapshot = () => {
    const db = new DatabaseSync(database, { readOnly: true });
    try { return JSON.stringify({ records: db.prepare("SELECT * FROM records ORDER BY id").all(), events: db.prepare("SELECT * FROM events ORDER BY id").all() }); }
    finally { db.close(); }
  };
  return { home, repo, identity, ctx, database, snapshot };
}
type World = Awaited<ReturnType<typeof setup>>;
function aiInput(overrides: Record<string, unknown> = {}) {
  return { requirement: REQUIREMENT, actor: "ai", source: "synthetic-history", trigger: "选型", decision: "采用方案A", alternatives: ["方案B"], effects: ["architecture"], scope: "订单模块", basis: ["合成证据"], action: "记录", ...overrides };
}
function userInput(overrides: Record<string, unknown> = {}) {
  return { requirement: REQUIREMENT, actor: "user", source: "synthetic-history", trigger: "确认范围", decision: "缩小至MVP", alternatives: [], effects: ["scope"], impact: "剩余不做", ...overrides };
}
// 直接准备本测试临时库的无授权历史事件，不调用产品的历史正文入口。
function seedHistory(w: World, input = aiInput()) {
  const actor = input.actor as "user" | "ai";
  return withDatabase(w.database, (db) => db.transaction(() => {
    const stream = decisionStream(REQUIREMENT, actor);
    const records = db.events<{ id: string }>(stream);
    const id = `${actor === "ai" ? "AI" : "USER"}-${String(records.length + 1).padStart(3, "0")}`;
    return db.append(stream, { ...input, id, recordedAt: "2026-09-08T00:00:00.000Z" });
  }));
}

describe("旧决定校验与构建永久拒绝", () => {
  test.each([
    { label: "合法AI", input: aiInput() }, { label: "合法user", input: userInput() },
    ...["scope", "action", "decision", "effects", "trigger", "source", "alternatives"].map((field) => {
      const input = aiInput() as Record<string, unknown>; delete input[field]; return { label: `AI缺${field}`, input };
    }),
    ...[{ basis: [] }, { basis: null }, { scope: "" }, { impact: "不应出现" }].map((patch) => ({ label: `AI字段${JSON.stringify(patch)}`, input: aiInput(patch) })),
    ...[{ basis: ["不应出现"] }, { scope: "不应出现" }, { action: "不应出现" }, { impact: undefined }, { impact: "" }].map((patch) => ({ label: `user字段${JSON.stringify(patch)}`, input: userInput(patch) })),
  ])("校验和构建$label均拒绝，无正文返回或DB改动", async ({ input }) => {
    const w = await setup(); seedHistory(w); const before = w.snapshot();
    for (const call of [() => validateDecisionInput(input), () => buildRecord(input, { id: "AI-001", recordedAt: "2026-09-08T00:00:00.000Z" })]) {
      expect(call).toThrow("永久淘汰");
      try { call(); } catch (error) { expect(String(error)).not.toContain(input.decision); }
    }
    expect(w.snapshot()).toBe(before);
  });
});

describe("appendDecision永久拒绝", () => {
  test.each(["ai", "user"])("首次%s写入拒绝且不创建DB或仓库登记", async (actor) => {
    const w = await setup(); await expect(appendDecision(actor === "ai" ? aiInput() : userInput(), w.ctx)).rejects.toThrow("永久淘汰");
    expect(existsSync(w.database)).toBe(false); await expect(readDecisions({ ...w.ctx, requirement: REQUIREMENT, actor: actor as "ai" | "user" })).rejects.toThrow("永久淘汰");
    expect(existsSync(w.database)).toBe(false);
  });
  test.each(["action", "decision", "effects", "trigger", "source", "alternatives"])("缺%s的旧写入同样拒绝，不产生台账", async (field) => {
    const w = await setup(); const input = aiInput() as Record<string, unknown>; delete input[field];
    await expect(appendDecision(input, w.ctx)).rejects.toThrow("永久淘汰"); expect(existsSync(w.database)).toBe(false);
  });
  test.each([
    { label: "空effects", patch: { effects: [] } }, { label: "user混入basis", patch: { basis: ["user伪造字段"], actor: "user" } },
    { label: "非法需求名", patch: { requirement: "order-export" } }, { label: "prodBody", patch: { prodBody: "body" } },
    { label: "patch", patch: { patch: "patch" } }, { label: "attachment", patch: { attachment: "file" } },
    { label: "超长决定", patch: { decision: "长".repeat(100_000) } },
  ])("非法/无限载荷不写入：$label", async ({ patch }) => {
    const w = await setup(); seedHistory(w); const before = w.snapshot();
    await expect(appendDecision(aiInput(patch), w.ctx)).rejects.toThrow("永久淘汰"); expect(w.snapshot()).toBe(before);
  });
  test.each([["AI-009"], ["AI-002"], ["AI-001", "AI-001"], ["AI-001"], ["USER-001"]].map((ids) => ({ ids })))("旧supersedes=$ids不能追加或改变任一主体的记录", async ({ ids }) => {
    const w = await setup(); seedHistory(w); seedHistory(w, userInput()); const before = w.snapshot();
    for (const input of [aiInput({ supersedes: ids }), userInput({ supersedes: ids })]) await expect(appendDecision(input, w.ctx)).rejects.toThrow("永久淘汰");
    expect(w.snapshot()).toBe(before);
  });
  test("20个并发旧写入全部拒绝且无DB副作用", async () => {
    const w = await setup(); seedHistory(w); const before = w.snapshot();
    const results = await Promise.allSettled(Array.from({ length: 20 }, () => appendDecision(aiInput(), w.ctx)));
    expect(results.every((result) => result.status === "rejected" && String(result.reason).includes("永久淘汰"))).toBe(true); expect(w.snapshot()).toBe(before);
  });
  test("两个真实Node进程各5次旧写入全部拒绝，不产生任何记录", async () => {
    const w = await setup(); const script = `import { appendDecision } from ${JSON.stringify(new URL("../runtime/decisions.ts", import.meta.url).href)};
let denied=0; for(let i=0;i<5;i++){try{await appendDecision(${JSON.stringify(aiInput())},${JSON.stringify(w.ctx)});}catch(e){if(!String(e).includes('永久淘汰')) throw e; denied++;}} if(denied!==5)process.exitCode=1; console.log(denied);`;
    const outputs = await Promise.all(Array.from({ length: 2 }, () => promisify(execFile)(process.execPath, ["--input-type=module", "-e", script], { timeout: 20_000 })));
    expect(outputs.map((output) => output.stdout.trim())).toEqual(["5", "5"]); expect(existsSync(w.database)).toBe(false);
  });
  test("损坏历史流不会被拒绝写入清空或修复", async () => {
    const w = await setup(); seedHistory(w); withDatabase(w.database, (db) => db.append(decisionStream(REQUIREMENT, "ai"), { broken: true })); const before = w.snapshot();
    await expect(appendDecision(aiInput(), w.ctx)).rejects.toThrow("永久淘汰"); expect(w.snapshot()).toBe(before);
    await expect(readDecisions({ ...w.ctx, requirement: REQUIREMENT, actor: "ai" })).rejects.toThrow(); expect(w.snapshot()).toBe(before);
  });
  test("非Git目录同样永久拒绝，不触碰数据根", async () => {
    const w = await setup(); await expect(appendDecision(aiInput(), { ...w.ctx, cwd: w.home.home })).rejects.toThrow("永久淘汰"); expect(existsSync(w.database)).toBe(false);
  });
});

describe("历史读取、主体与仓库隔离", () => {
  test("缺库读取和inspect永久拒绝且不创建DB", async () => {
    const w = await setup();
    await expect(readDecisions({ ...w.ctx, requirement: REQUIREMENT, actor: "ai" })).rejects.toThrow("永久淘汰");
    await expect(inspectDecision({ ...w.ctx, requirement: REQUIREMENT, id: "AI-001" })).rejects.toThrow("永久淘汰");
    expect(existsSync(w.database)).toBe(false);
  });
  test("旧读取永久拒绝，临时库追加顺序与原行保持不变", async () => {
    const w = await setup(); seedHistory(w, aiInput({ decision: "第一次" })); seedHistory(w, aiInput({ decision: "第二次" })); const before = w.snapshot();
    await expect(readDecisions({ ...w.ctx, requirement: REQUIREMENT, actor: "ai" })).rejects.toThrow("永久淘汰");
    const records = withDatabase(w.database, (db) => db.events<{ id: string }>(decisionStream(REQUIREMENT, "ai")));
    expect(records.map((r) => r.data.id)).toEqual(["AI-001", "AI-002"]); expect(w.snapshot()).toBe(before);
  });
  test("user读取永久拒绝，临时库两主体历史独立保全", async () => {
    const w = await setup(); seedHistory(w); seedHistory(w, userInput()); const before = w.snapshot();
    await expect(readDecisions({ ...w.ctx, requirement: REQUIREMENT, actor: "user" })).rejects.toThrow("永久淘汰");
    expect(withDatabase(w.database, (db) => db.events(decisionStream(REQUIREMENT, "user")))).toMatchObject([{ data: { id: "USER-001", actor: "user" } }]);
    expect(withDatabase(w.database, (db) => db.events(decisionStream(REQUIREMENT, "ai")))).toMatchObject([{ data: { id: "AI-001", actor: "ai" } }]); expect(w.snapshot()).toBe(before);
  });
  test.each(["AI-001", "USER-001", "AI-099"])("inspectDecision对%s永久拒绝，不返回正文且原行逐字不变", async (id) => {
    const w = await setup(); seedHistory(w); seedHistory(w, userInput()); const before = w.snapshot();
    await expect(inspectDecision({ ...w.ctx, requirement: REQUIREMENT, id })).rejects.toThrow("永久淘汰");
    expect(w.snapshot()).toBe(before);
  });
  test.each([
    { requirement: "2026-09-08.other" }, { actor: "user" }, { recordedAt: "bad-time" }, { id: "AI-001" }, { id: "wrong" },
  ])("历史身份/时间/重复编号损坏拒绝，不修复原数据：%j", async (patch) => {
    const w = await setup(); seedHistory(w);
    withDatabase(w.database, (db) => db.append(decisionStream(REQUIREMENT, "ai"), { ...aiInput(), id: "AI-002", recordedAt: "2026-09-08T00:00:00.000Z", ...patch }));
    const before = w.snapshot(); await expect(readDecisions({ ...w.ctx, requirement: REQUIREMENT, actor: "ai" })).rejects.toThrow(); expect(w.snapshot()).toBe(before);
  });
  test("同仓库两个worktree同一临时库，旧读取和追加均拒绝", async () => {
    const w = await setup(); seedHistory(w); const worktree = await addWorktree(w.repo); const before = w.snapshot();
    expect((await repositoryIdentity(worktree.root)).repoId).toBe(w.identity.repoId);
    for (const cwd of [w.repo.root, worktree.root]) await expect(readDecisions({ ...w.ctx, cwd, requirement: REQUIREMENT, actor: "ai" })).rejects.toThrow("永久淘汰");
    expect(repositoryDatabase(w.ctx.dataRoot, (await repositoryIdentity(worktree.root)).repoId)).toBe(w.database);
    await expect(appendDecision(aiInput(), { ...w.ctx, cwd: worktree.root })).rejects.toThrow("永久淘汰"); expect(w.snapshot()).toBe(before);
  });
  test("不同仓库同名需求的临时事件库隔离且旧读取均拒绝", async () => {
    const w = await setup(); seedHistory(w); const other = await createRepoFixture(); cleanup.push(() => removeRepoFixture(other));
    const identity = await repositoryIdentity(other.root); expect(identity.repoId).not.toBe(w.identity.repoId);
    const otherDb = repositoryDatabase(w.ctx.dataRoot, identity.repoId); const before = w.snapshot();
    await expect(readDecisions({ ...w.ctx, cwd: other.root, requirement: REQUIREMENT, actor: "ai" })).rejects.toThrow("永久淘汰");
    expect(existsSync(otherDb)).toBe(false);
    const foreign = withDatabase(otherDb, (db) => db.append(decisionStream(REQUIREMENT, "ai"), { id: "AI-001", decision: "另一临时仓库" }));
    expect(withDatabase(otherDb, (db) => db.events(decisionStream(REQUIREMENT, "ai")))).toEqual([foreign]);
    expect(w.snapshot()).toBe(before);
  });
  test("通用repoDataDir登记commonDir并确保0700/0600，不经决定入口", async () => {
    const w = await setup(); const path = await repoDataDir(w.ctx.dataRoot, w.identity.repoId, w.identity.commonDir);
    expect((await stat(path)).mode & 0o777).toBe(0o700); expect((await stat(w.database)).mode & 0o777).toBe(0o600);
    expect(withDatabase(w.database, (db) => db.read<{ commonDir: string }>("repository", w.identity.repoId)!.data.commonDir)).toBe(w.identity.commonDir);
  });
  test("通用事件原语20次追加编号唯一，历史行不变且无授权副作用", async () => {
    const w = await setup(); const first = seedHistory(w); const stream = "test-generic-events";
    const events = await Promise.all(Array.from({ length: 20 }, (_, index) => Promise.resolve().then(() => withDatabase(w.database, (db) => db.append(stream, { index })))));
    expect(new Set(events.map((event) => event.id)).size).toBe(20); expect(events.every((event) => UUID_V7_PATTERN.test(event.id))).toBe(true);
    expect(withDatabase(w.database, (db) => db.events(stream).map((event) => event.sequence))).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(withDatabase(w.database, (db) => db.events(decisionStream(REQUIREMENT, "ai")))).toEqual([first]);
    expect(withDatabase(w.database, (db) => db.list("requirements"))).toEqual([]);
  });
  test("两个Node进程通用事件流各追加5条无丢失，编号唯一且不写批准", async () => {
    const w = await setup(); seedHistory(w); const script = `import {withDatabase} from ${JSON.stringify(new URL("../runtime/database.ts", import.meta.url).href)};
for(let i=0;i<5;i++)withDatabase(${JSON.stringify(w.database)},db=>db.append('test-multiprocess-events',{index:i}));`;
    await Promise.all(Array.from({ length: 2 }, () => promisify(execFile)(process.execPath, ["--input-type=module", "-e", script], { timeout: 20_000 })));
    const events = withDatabase(w.database, (db) => db.events("test-multiprocess-events"));
    expect(events).toHaveLength(10); expect(new Set(events.map((event) => event.id)).size).toBe(10); expect(events.map((event) => event.sequence)).toEqual(Array.from({ length: 10 }, (_, i) => i + 1));
    expect(withDatabase(w.database, (db) => db.list("requirements"))).toEqual([]);
  });
});

describe("旧编号与字段排序构建永久拒绝", () => {
  test.each([[], ["AI-001", "AI-002"], ["AI-001", "AI-005"], ["AI-001", "USER-001", "USER-002"]].map((ids) => ({ ids })))("nextDecisionId不分配旧编号：$ids", async ({ ids }) => {
    const w = await setup(); seedHistory(w); const before = w.snapshot();
    for (const actor of ["ai", "user"] as const) expect(() => nextDecisionId(ids, actor)).toThrow("永久淘汰");
    expect(w.snapshot()).toBe(before);
  });
  test.each([aiInput(), userInput(), aiInput({ supersedes: ["AI-001"] })])("buildRecord不返回旧决定对象：%j", async (input) => {
    const w = await setup(); seedHistory(w); const before = w.snapshot();
    expect(() => buildRecord(input, { id: "AI-002", recordedAt: "2026-09-08T00:00:00.000Z" })).toThrow("永久淘汰");
    expect(w.snapshot()).toBe(before);
  });
});
