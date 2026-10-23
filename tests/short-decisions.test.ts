import { afterEach, expect, test, vi } from "vitest";
import { mkdtemp, rm, readdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { LocalDatabase, uuidv7, repositoryDatabase, withDatabase } from "../src/core/storage/database.ts";
import * as databaseModule from "../src/core/storage/database.ts";
import { repositoryIdentity } from "../src/core/storage/identity.ts";
import { RequirementStateStore } from "../src/modules/requirement/requirement-state.ts";
import { ShortDecisionStore } from "../src/modules/requirement/short-decisions.ts";
import type { ShortDecisionStoreOptions } from "../src/modules/requirement/short-decisions.ts";
import { parseDecisionBatch, decisionDigest } from "../src/modules/requirement/short-decision-format.ts";
import type { DecisionBatch, DecisionSubject } from "../src/modules/requirement/short-decision-format.ts";
import { createDatabaseSnapshot, withDatabaseMaintenance } from "../src/core/storage/database-maintenance.ts";
import { createRepoFixture, removeRepoFixture } from "./helpers/repo-fixture.ts";
import { temporaryRoot } from "./helpers/temporary-root.ts";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const fn of cleanup.splice(0).reverse()) await fn(); });
const item = () => ({ conclusion: "增加手机号登录，保留邮箱登录，本次不做微信登录", scope: "本轮只分析影响，不修改代码", references: ["G-1"], supersedes: [] as string[] });
function batch(): DecisionBatch { return { operationId: uuidv7(), requirementId: uuidv7(), version: 1, epoch: 1, prd: null, decisions: [item()] }; }

for (const field of ["conclusion", "scope"] as const) {
  test(`${field}按解码后码点计数，400允许、401拒绝且不截断`, () => {
    const input = batch(); input.decisions[0]![field] = "😀".repeat(400);
    expect(parseDecisionBatch(JSON.stringify(input)).decisions[0]![field]).toBe(input.decisions[0]![field]);
    input.decisions[0]![field] += "中";
    expect(() => parseDecisionBatch(JSON.stringify(input))).toThrow(/text_limit/);
    input.decisions[0]![field] = "\ud800";
    expect(() => parseDecisionBatch(JSON.stringify(input))).toThrow(/invalid_unicode/);
    input.decisions[0]![field] = " \n\t";
    expect(() => parseDecisionBatch(JSON.stringify(input))).toThrow(/text_limit/);
  });
}

test("引用个数不设上限，单个引用ASCII长度128允许、129拒绝", () => {
  const input = batch(); input.prd = { commit: "a".repeat(40), hash: "b".repeat(64) };
  input.decisions[0]!.references = Array.from({ length: 40 }, (_, i) => `S-${i}`);
  input.decisions[0]!.supersedes = [uuidv7()];
  expect(parseDecisionBatch(JSON.stringify(input))).toEqual(input);
  input.decisions[0]!.references = ["r".repeat(128)];
  expect(parseDecisionBatch(JSON.stringify(input))).toEqual(input);
  for (const value of ["r".repeat(129), "r\n", "中文", "../path", "{\"data\":1}", "a b"]) {
    input.decisions[0]!.references = [value];
    expect(() => parseDecisionBatch(JSON.stringify(input))).toThrow(/invalid_shape/);
  }
});

test("20条和65536字节独立限制，超限及空批次拒绝", () => {
  const input = batch(); input.decisions = Array.from({ length: 20 }, item);
  const source = JSON.stringify(input);
  expect(parseDecisionBatch(source).decisions).toHaveLength(20);
  expect(parseDecisionBatch(source + " ".repeat(65_536 - Buffer.byteLength(source)))).toEqual(input);
  expect(() => parseDecisionBatch(source + " ".repeat(65_537 - Buffer.byteLength(source)))).toThrow(/request_limit/);
  input.decisions.push(item()); expect(() => parseDecisionBatch(JSON.stringify(input))).toThrow(/invalid_shape/);
  input.decisions = []; expect(() => parseDecisionBatch(JSON.stringify(input))).toThrow(/invalid_shape/);
});

for (const field of ["actor", "status", "recordedAt", "prdBody", "patch", "transcript", "attachment", "rawContent", "metadata", "gitObject"]) {
  test(`模型不能通过${field}字段自填主体、状态或扩展载荷`, () => {
    const input = batch();
    expect(() => parseDecisionBatch(JSON.stringify({ ...input, [field]: "payload" }))).toThrow(/invalid_shape/);
    expect(() => parseDecisionBatch(JSON.stringify({ ...input, decisions: [{ ...item(), [field]: "payload" }] }))).toThrow(/invalid_shape/);
  });
}

test("重复键、转义同键、非JSON对象、重复引用和身份换行均拒绝", () => {
  const input = batch(), source = JSON.stringify(input);
  expect(() => parseDecisionBatch(source.replace('"scope":', '"scope":"x","sc\\u006fpe":'))).toThrow(/duplicate_key/);
  expect(() => parseDecisionBatch(input as unknown as string)).toThrow(/request_limit/);
  input.decisions[0]!.references = ["G-1", "G-1"];
  expect(() => parseDecisionBatch(JSON.stringify(input))).toThrow(/invalid_shape/);
  input.decisions[0]!.references = []; input.operationId += "\n";
  expect(() => parseDecisionBatch(JSON.stringify(input))).toThrow(/invalid_shape/);
});

test("格式排版不改变摘要指纹，内容和范围变化会改变", () => {
  const input = batch();
  expect(decisionDigest(parseDecisionBatch(JSON.stringify(input)))).toBe(decisionDigest(parseDecisionBatch(JSON.stringify(input, null, 2))));
  expect(decisionDigest(input)).not.toBe(decisionDigest({ ...input, decisions: [{ ...item(), scope: "允许实施" }] }));
});

// 授权与主体核验均为明确的合成测试素材；不证明真实用户交互或自然语言归纳正确。
async function world(overrides: Partial<ShortDecisionStoreOptions> = {}) {
  const root = await mkdtemp(join(temporaryRoot(), "short-decisions-")); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const repo = await createRepoFixture(); cleanup.push(() => removeRepoFixture(repo));
  const identity = await repositoryIdentity(repo.root);
  const subject: DecisionSubject = { actor: "user", status: "confirmed", basisReceiptId: uuidv7() };
  const options: ShortDecisionStoreOptions = { dataRoot: join(root, "private"), repoId: identity.repoId, repositoryRoot: repo.root,
    authorize: () => true, now: () => 1_000_000,
    admit: ({ requestHash, batch }) => ({ requestHash, subjects: batch.decisions.map(() => ({ ...subject })) }), ...overrides };
  const state = await RequirementStateStore.open(options);
  const record = state.reserve({ requestId: uuidv7(), intentHash: "c".repeat(64) });
  const store = await ShortDecisionStore.open(options);
  const input: DecisionBatch = { ...batch(), requirementId: record.id, version: record.version, epoch: record.data.epoch };
  const path = repositoryDatabase(options.dataRoot, identity.repoId);
  const records = () => withDatabase(path, (db) => db.list("short_decisions"));
  const events = () => withDatabase(path, (db) => db.events(`short_decision_events:${record.id}`));
  return { root, repo, options, subject, state, store, input, path, records, events };
}

test("缺少真实核验适配器拒绝写入；已有read权限不能取得记录权限", async () => {
  const w = await world({ admit: undefined });
  expect(() => w.store.append(JSON.stringify(w.input))).toThrow(/trusted_admission_required/);
  expect(w.records()).toEqual([]); expect(w.events()).toEqual([]);
  const limited = await ShortDecisionStore.open({ ...w.options, authorize: ({ action }) => ["open", "read"].includes(action) });
  expect(() => limited.append(JSON.stringify(w.input))).toThrow(/authorization_required/);
  expect(() => limited.read(w.input.requirementId, uuidv7())).toThrow(/authorization_required/);
});

test("主体只取核验结果，结论保存不激活需求、不改变批准基线", async () => {
  const w = await world(); const before = w.state.read(w.input.requirementId);
  const result = w.store.append(JSON.stringify(w.input));
  const saved = w.store.read(w.input.requirementId, result.decisionIds[0]!);
  expect(saved).toMatchObject({ actor: "user", status: "confirmed", conclusion: item().conclusion, scope: item().scope, recordedAt: 1_000_000 });
  expect(w.state.read(w.input.requirementId)).toEqual(before);
  expect(JSON.stringify(w.events())).not.toContain(item().conclusion);
  expect(w.events()).toHaveLength(1);
  expect(await readdir(dirname(w.path))).not.toContain("decisions");
});

test("待确认AI建议保持pending，没有批准凭据也不获得执行权", async () => {
  const w = await world(); Object.assign(w.subject, { actor: "ai", status: "pending", basisReceiptId: null });
  const result = w.store.append(JSON.stringify(w.input));
  expect(w.store.read(w.input.requirementId, result.decisionIds[0]!)).toMatchObject({ actor: "ai", status: "pending", basisReceiptId: null });
  expect(w.state.read(w.input.requirementId).data.approved).toBeNull();
});

test("重复操作幂等；同操作换内容或换核验主体拒绝", async () => {
  const w = await world(); const source = JSON.stringify(w.input), first = w.store.append(source);
  expect(w.store.append(JSON.stringify(w.input, null, 2))).toEqual(first);
  expect(w.records()).toHaveLength(1); expect(w.events()).toHaveLength(1);
  w.input.decisions[0]!.scope = "实施";
  expect(() => w.store.append(JSON.stringify(w.input))).toThrow(/operation_conflict/);
  Object.assign(w.subject, { actor: "ai" });
  expect(() => w.store.append(source)).toThrow(/operation_conflict/);
});

test("伪造、过期摘要、异步核验和缺少批准来源均拒绝", async () => {
  const w = await world();
  const candidates = [() => true, () => Promise.reject(new Error("late rejection")),
    () => ({ requestHash: "0".repeat(64), subjects: [w.subject] }),
    ({ requestHash }: { requestHash: string }) => ({ requestHash, subjects: [{ ...w.subject, basisReceiptId: null }] })];
  for (const admit of candidates) {
    const store = await ShortDecisionStore.open({ ...w.options, admit: admit as ShortDecisionStoreOptions["admit"] });
    expect(() => store.append(JSON.stringify(w.input))).toThrow(/trusted_admission_required|admission_mismatch/);
  }
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(w.records()).toEqual([]);
});

test("事务末尾撤销权限或核验发生变化时，记录、事件、操作消费全部回滚", async () => {
  const w = await world();
  for (const changed of ["access", "admission"]) {
    let count = 0;
    const store = await ShortDecisionStore.open({ ...w.options,
      authorize: ({ action }) => action !== "record-decisions" || changed !== "access" || ++count < 3,
      admit: (request) => changed === "admission" && ++count === 3 ? null : w.options.admit!(request) });
    expect(() => store.append(JSON.stringify(w.input))).toThrow(/authorization_required|trusted_admission_required/);
    expect(w.records()).toEqual([]); expect(w.events()).toEqual([]);
    expect(withDatabase(w.path, (db) => db.list("short_decision_operations"))).toEqual([]);
  }
});

test("版本、epoch、PRD引用及未知需求都默认拒绝", async () => {
  const w = await world();
  for (const patch of [{ version: 9 }, { epoch: 9 }, { requirementId: uuidv7() }, { prd: { commit: "a".repeat(40), hash: "b".repeat(64) } }]) {
    expect(() => w.store.append(JSON.stringify({ ...w.input, ...patch }))).toThrow();
  }
  expect(w.records()).toEqual([]);
});

test("修订保留旧结论并标记取代关系；重复批次不再次改写", async () => {
  const w = await world(); const first = w.store.append(JSON.stringify(w.input));
  const input = { ...w.input, operationId: uuidv7(), decisions: [{ ...item(), conclusion: "本轮允许实施手机号登录", supersedes: first.decisionIds }] };
  const next = w.store.append(JSON.stringify(input));
  expect(w.store.read(input.requirementId, first.decisionIds[0]!)).toMatchObject({ conclusion: item().conclusion, status: "superseded", supersededBy: next.decisionIds[0] });
  expect(w.store.append(JSON.stringify(input))).toEqual(next);
  expect(w.events()).toHaveLength(2);
});

test("AI不能取代用户决定，pending不能取代confirmed，不接受旧格式USER编号", async () => {
  const w = await world(); const first = w.store.append(JSON.stringify(w.input));
  const input = { ...w.input, operationId: uuidv7(), decisions: [{ ...item(), supersedes: first.decisionIds }] };
  w.subject.actor = "ai"; expect(() => w.store.append(JSON.stringify(input))).toThrow(/supersede_denied/);
  w.subject.actor = "user"; w.subject.status = "pending";
  expect(() => w.store.append(JSON.stringify(input))).toThrow(/supersede_denied/);
  input.decisions[0]!.supersedes = ["USER-001"];
  expect(() => w.store.append(JSON.stringify(input))).toThrow(/invalid_shape/);
  expect(w.records()).toHaveLength(1);
});

test("批次后条失败连同前条及旧记录修订一起回滚", async () => {
  const w = await world(); const first = w.store.append(JSON.stringify(w.input));
  const input = { ...w.input, operationId: uuidv7(), decisions: [{ ...item(), supersedes: first.decisionIds }, { ...item(), supersedes: [uuidv7()] }] };
  expect(() => w.store.append(JSON.stringify(input))).toThrow(/unknown_decision/);
  expect(w.store.read(input.requirementId, first.decisionIds[0]!)).toMatchObject({ status: "confirmed", supersededBy: null });
  expect(w.records()).toHaveLength(1); expect(w.events()).toHaveLength(1);
});

for (const state of ["closing", "closed", "needs_review"]) {
  test(`${state}状态下不读取结论、不重放旧操作`, async () => {
    const w = await world(); const first = w.store.append(JSON.stringify(w.input));
    const current = w.state.read(w.input.requirementId);
    if (state === "needs_review") w.state.blockForRecovery({ requirementId: current.id, version: current.version, reason: "history_unknown" });
    else {
      const closing = w.state.beginClose({ requirementId: current.id, version: current.version, intent: { operationId: uuidv7(), reason: "cancelled", receiptId: uuidv7() } });
      if (state === "closed") w.state.finishClose({ requirementId: current.id, version: closing.version, operationId: closing.data.close!.operationId });
    }
    const spy = vi.spyOn(LocalDatabase.prototype, "read");
    expect(() => w.store.read(current.id, first.decisionIds[0]!)).toThrow(/lifecycle_denied/);
    expect(() => w.store.append(JSON.stringify(w.input))).toThrow(/lifecycle_denied/);
    expect(spy.mock.calls.some(([namespace]) => namespace === "short_decisions")).toBe(false);
  });
}

test("跨需求修订、记录身份串改和隐藏字段拒绝", async () => {
  const w = await world(); const first = w.store.append(JSON.stringify(w.input));
  const other = w.state.reserve({ requestId: uuidv7(), intentHash: "d".repeat(64) });
  expect(() => w.store.append(JSON.stringify({ ...w.input, operationId: uuidv7(), requirementId: other.id, decisions: [{ ...item(), supersedes: first.decisionIds }] }))).toThrow(/decision_identity_conflict/);
  const decisionId = first.decisionIds[0]!;
  withDatabase(w.path, (db) => {
    const stored = db.read<Record<string, unknown>>("short_decisions", decisionId)!;
    db.update("short_decisions", decisionId, stored.version, { ...stored.data, transcript: "hidden" });
  });
  expect(() => w.store.read(w.input.requirementId, decisionId)).toThrow(/invalid_record/);
});

test("UUID碰撞不重新分配身份或提交部分批次", async () => {
  const w = await world(); const collision = uuidv7();
  const spy = vi.spyOn(databaseModule, "uuidv7").mockReturnValue(collision);
  expect(() => w.store.append(JSON.stringify({ ...w.input, decisions: [item(), item()] }))).toThrow();
  spy.mockRestore();
  expect(w.records()).toEqual([]); expect(w.events()).toEqual([]);
});

test("调用方不能通过修改options或核验请求偷换保存内容", async () => {
  const w = await world();
  w.options.dataRoot = w.repo.root; w.options.admit = undefined;
  expect(w.store.append(JSON.stringify(w.input)).decisionIds).toHaveLength(1);
  const store = await ShortDecisionStore.open({ ...w.options, dataRoot: join(w.root, "private"), admit: (request) => {
    (request.batch.decisions[0]!).scope = "偷偷扩大范围";
    return { requestHash: request.requestHash, subjects: [w.subject] };
  } });
  expect(() => store.append(JSON.stringify({ ...w.input, operationId: uuidv7() }))).toThrow();
  expect(w.records()).toHaveLength(1);
});

test("读取结束前权限撤销不返回结论", async () => {
  const w = await world(); const first = w.store.append(JSON.stringify(w.input)); let reads = 0;
  const store = await ShortDecisionStore.open({ ...w.options, authorize: ({ action }) => action !== "read-decisions" || ++reads === 1 });
  expect(() => store.read(w.input.requirementId, first.decisionIds[0]!)).toThrow(/authorization_required/);
});

test("两个真实Node进程竞争相同操作只保存一份决定和事件", async () => {
  const w = await world(), path = join(w.root, "append.mjs");
  await writeFile(path, `import { ShortDecisionStore } from ${JSON.stringify(new URL("../src/modules/requirement/short-decisions.ts", import.meta.url).href)};
const store = await ShortDecisionStore.open({ ...${JSON.stringify({ dataRoot: w.options.dataRoot, repoId: w.options.repoId, repositoryRoot: w.repo.root })},
  authorize: () => true, admit: ({ requestHash, batch }) => ({ requestHash, subjects: batch.decisions.map(() => (${JSON.stringify(w.subject)})) }) });
console.log('READY');
process.stdin.once('data', () => { try { console.log(JSON.stringify(store.append(${JSON.stringify(JSON.stringify(w.input))}))); }
catch (error) { console.error(error); process.exitCode=1; } process.stdin.destroy(); });
`);
  const children = Array.from({ length: 2 }, () => {
    const proc = spawn(process.execPath, [path], { stdio: ["pipe", "pipe", "pipe"] });
    let output = "", errors = "";
    proc.stdout.on("data", (chunk) => { output += chunk; }); proc.stderr.on("data", (chunk) => { errors += chunk; });
    const closed = new Promise<number | null>((resolve, reject) => { proc.once("error", reject); proc.once("close", resolve); });
    void closed.catch(() => {});
    return { proc, closed, output: () => output, errors: () => errors };
  });
  try {
    const deadline = Date.now() + 3000;
    while (!children.every((child) => child.output().includes("READY"))) {
      if (Date.now() > deadline) throw new Error("测试子进程未就绪");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    children.forEach((child) => child.proc.stdin.end("go"));
    expect(await Promise.all(children.map((child) => child.closed)), children.map((child) => child.errors()).join("\n")).toEqual([0, 0]);
    const results = children.map((child) => JSON.parse(child.output().trim().split("\n").at(-1)!));
    expect(results[0]).toEqual(results[1]); expect(w.records()).toHaveLength(1); expect(w.events()).toHaveLength(1);
  } finally {
    children.forEach((child) => child.proc.kill("SIGKILL"));
    await Promise.allSettled(children.map((child) => child.closed));
  }
});

test("短结论随一致性备份保存，副本仍不能直接接管执行", async () => {
  const w = await world(); const first = w.store.append(JSON.stringify(w.input));
  const receipt = await withDatabaseMaintenance({ directory: dirname(w.path), worktreeRoots: [w.repo.root] }, (permit) => createDatabaseSnapshot(permit, "data"));
  expect(receipt.executable).toBe(false);
  expect(() => new LocalDatabase(receipt.snapshotPath)).toThrow(/snapshot_only/);
  const raw = new DatabaseSync(receipt.snapshotPath, { readOnly: true });
  try {
    const result = raw.prepare("SELECT data FROM records WHERE namespace='short_decisions' AND record_key=?").get(first.decisionIds[0]!);
    expect(JSON.parse(String(result?.data))).toMatchObject({ conclusion: item().conclusion, scope: item().scope });
  } finally { raw.close(); }
});
