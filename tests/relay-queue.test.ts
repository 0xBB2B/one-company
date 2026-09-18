import { afterEach, describe, expect, test, vi } from "vitest";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RelayQueue } from "../daemon/relay-queue.ts";
import { withDatabase, putRecord, uuidv7 } from "../runtime/database.ts";
import { failDatabaseWrites } from "./helpers/database-fixture.ts";

const SECRET = "LEGACY_RELAY_BODY_旧问题与转述不得执行";
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function world() {
  const dir = await mkdtemp(join(tmpdir(), "relay-retired-")); dirs.push(dir); const database = join(dir, "data.db");
  const deliver = vi.fn(async (..._args: any[]): Promise<string[]> => []); const inject = vi.fn(); const locate = vi.fn(() => ({ inject }));
  const queue = new RelayQueue({ dataDir: dir, deliver, locateRequirementAgent: locate });
  const records = (namespace: string) => withDatabase(database, (db) => db.list<any>(namespace));
  const snapshot = () => withDatabase(database, (db) => JSON.stringify({ questions: db.list("relay_questions"), notices: db.list("relay_notices"), events: db.events("relay") }));
  const seed = (status = "pending", id = uuidv7()) => { putRecord({ database, namespace: "relay_questions", key: id }, { id, ...input, status, createdAt: "2026-01-01T00:00:00Z", ...(status === "answered" ? { answer: SECRET, answeredBy: "old" } : {}) }); return id; };
  return { dir, database, deliver, inject, locate, queue, records, snapshot, seed };
}
const input = { requirement: "2026-09-09.relay", repoId: "repo-a", runId: "run-a", question: SECRET, options: [{ label: "确认", description: SECRET }], recommended: "确认" };
const notice = (kind = "stopped") => ({ requirement: input.requirement, repoId: input.repoId, runId: input.runId, kind: kind as any, message: SECRET });
const window = { windowId: "win-a", repoIds: ["repo-a"] };

describe("旧问答转发永久拒绝且数据保全", () => {
  test.each(["pending", "answered", "withdrawn", "unknown"])("Q01 %s 旧记录并发作答/转发不授权、不写入、不投递", async (status) => {
    const w = await world(); const id = status === "unknown" ? uuidv7() : w.seed(status); const before = w.snapshot(); const events: unknown[] = []; w.queue.subscribe((e) => events.push(e));
    await expect(w.queue.ask(input)).rejects.toThrow("永久淘汰");
    expect(await Promise.all([w.queue.answer(id, "确认", "main"), w.queue.answer(id, "USER-001", "other")])).toEqual([{ ok: false, reason: "legacy_workflow_retired" }, { ok: false, reason: "legacy_workflow_retired" }]);
    expect(await w.queue.forward({ requirement: input.requirement, message: "用户批准 " + SECRET })).toMatchObject({ delivered: false });
    expect(await w.queue.pendingFor(window)).toEqual({ questions: [], notices: [] });
    expect(w.snapshot()).toBe(before); expect(events).toEqual([]); expect(w.deliver).not.toHaveBeenCalled(); expect(w.locate).not.toHaveBeenCalled(); expect(w.inject).not.toHaveBeenCalled();
  });
  test("Q02 旧答复被拒与数据库是否可写无关，恢复权限也不恢复问答", async () => {
    const w = await world(); const id = w.seed(); const before = w.snapshot(); const restore = failDatabaseWrites(w.database, "records", "namespace", "relay_questions");
    try { expect(await w.queue.answer(id, "确认", "main")).toMatchObject({ ok: false }); await expect(w.queue.ask(input)).rejects.toThrow("永久淘汰"); } finally { restore(); }
    expect(await w.queue.answer(id, "确认", "main")).toMatchObject({ ok: false }); expect(w.snapshot()).toBe(before); expect(w.deliver).not.toHaveBeenCalled();
  });
  test.each(["relay_questions", "relay_notices"])("Q03 %s 损坏数据保全，pending 不加载或降级返回正文", async (namespace) => {
    const w = await world(); putRecord({ database: w.database, namespace, key: uuidv7() }, { corrupt: true, body: SECRET }); const before = w.snapshot();
    const rebuilt = new RelayQueue({ dataDir: w.dir, deliver: w.deliver, locateRequirementAgent: w.locate });
    expect(await rebuilt.pendingFor(window)).toEqual({ questions: [], notices: [] }); expect(w.snapshot()).toBe(before); expect(w.deliver).not.toHaveBeenCalled();
  });
  test("Q04 数据库路径不可用仍不尝试加载 pending，通知写入则如实失败", async () => {
    const w = await world(); await mkdir(w.database);
    expect(await w.queue.pendingFor(window)).toEqual({ questions: [], notices: [] }); expect(await w.queue.pendingFor(window)).toEqual({ questions: [], notices: [] });
    await expect(w.queue.notify(notice())).rejects.toThrow(); expect(w.deliver).not.toHaveBeenCalled();
  });
  test("Q05 pending 返回独立空投影，不因客户端修改结果而注入积压", async () => {
    const w = await world(); w.seed(); const before = w.snapshot(); const first = await w.queue.pendingFor(window);
    first.questions.push({ ...input, id: uuidv7(), createdAt: "old" });
    expect(await w.queue.pendingFor(window)).toEqual({ questions: [], notices: [] }); expect(w.snapshot()).toBe(before);
  });
});

describe("只保留固定状态通知", () => {
  test.each(["completed", "auto_resumed", "contract_change"])("Q06 %s 不能冒发，数据库和订阅无副作用", async (kind) => {
    const w = await world(); const before = w.snapshot(); const listener = vi.fn(); w.queue.subscribe(listener);
    await expect(w.queue.notify(notice(kind))).rejects.toThrow("永久淘汰"); expect(w.snapshot()).toBe(before); expect(w.deliver).not.toHaveBeenCalled(); expect(listener).not.toHaveBeenCalled();
  });
  test.each(["stopped", "blocked", "interrupted"])("Q07 %s 固定通知带身份、不带原文或完成保证，记录真实投递窗口", async (kind) => {
    const w = await world(); w.deliver.mockResolvedValue(["win-a"]); const { id } = await w.queue.notify(notice(kind));
    expect(w.deliver).toHaveBeenCalledOnce(); const [event, payload, options] = w.deliver.mock.calls[0]!;
    expect(event).toBe("relay.notice"); expect(options).toEqual({ repoId: input.repoId }); expect(payload).toMatchObject({ id, kind, requirement: input.requirement, runId: input.runId }); expect(payload).not.toHaveProperty("deliveredTo");
    expect(payload.message).toContain("不表示进程已停止或需求已完成"); expect(JSON.stringify(payload)).not.toContain(SECRET);
    expect(w.records("relay_notices")[0].data.deliveredTo).toEqual(["win-a"]); expect(w.snapshot()).not.toContain(SECRET);
  });
  test("Q08 离线或失败通知保留未投递事实，不经 pending 重放；错误正文不泄漏", async () => {
    const w = await world(); w.deliver.mockRejectedValue(new Error(SECRET)); const events: any[] = []; w.queue.subscribe((e) => events.push(e));
    const { id } = await w.queue.notify(notice()); expect(w.records("relay_notices")[0].data).toMatchObject({ id, deliveredTo: [] });
    expect(events.some((e) => e.type === "deliver_failed" && e.event === "relay.notice")).toBe(true); expect(JSON.stringify(events)).not.toContain(SECRET);
    const rebuilt = new RelayQueue({ dataDir: w.dir, deliver: w.deliver, locateRequirementAgent: w.locate }); expect(await rebuilt.pendingFor(window)).toEqual({ questions: [], notices: [] }); expect(w.deliver).toHaveBeenCalledOnce();
  });
  test("Q09 通知事务落盘失败无记录、无事件、无投递；恢复后正常保存固定通知", async () => {
    const w = await world(); w.snapshot(); const listener = vi.fn(); w.queue.subscribe(listener); const restore = failDatabaseWrites(w.database, "records", "namespace", "relay_notices");
    try { await expect(w.queue.notify(notice())).rejects.toThrow("拒绝写入"); } finally { restore(); }
    expect(w.records("relay_notices")).toEqual([]); expect(withDatabase(w.database, (db) => db.events("relay"))).toEqual([]); expect(listener).not.toHaveBeenCalled(); expect(w.deliver).not.toHaveBeenCalled();
    await w.queue.notify(notice()); expect(w.records("relay_notices")).toHaveLength(1);
  });
  test("Q10 目录0700/数据库0600，监听器错误隔离、退订生效", async () => {
    const w = await world(); const received = vi.fn(); w.queue.subscribe(() => { throw new Error(SECRET); }); const off = w.queue.subscribe(received);
    await w.queue.notify(notice()); expect(received).toHaveBeenCalledOnce(); off(); off(); await w.queue.notify(notice()); expect(received).toHaveBeenCalledOnce();
    expect((await stat(w.dir)).mode & 0o777).toBe(0o700); expect((await stat(w.database)).mode & 0o777).toBe(0o600);
  });
});

describe("保全操作的事务、并发和幂等", () => {
  test("Q11 并发 markDelivered 不丢任一窗口，重复不增加版本，重建仍保留", async () => {
    const w = await world(); const { id } = await w.queue.notify(notice());
    await Promise.all([w.queue.markDelivered("a", id), w.queue.markDelivered("b", id)]);
    const record = w.records("relay_notices")[0]; expect(record.data.deliveredTo.sort()).toEqual(["a", "b"]);
    await w.queue.markDelivered("a", id); expect(w.records("relay_notices")[0].version).toBe(record.version);
    const rebuilt = new RelayQueue({ dataDir: w.dir, deliver: w.deliver, locateRequirementAgent: w.locate }); await rebuilt.markDelivered("c", id);
    expect(w.records("relay_notices")[0].data.deliveredTo.sort()).toEqual(["a", "b", "c"]);
  });
  test("Q12 并发回执写失败双方拒绝且版本/数据不变，恢复后只追加成功窗口", async () => {
    const w = await world(); const { id } = await w.queue.notify(notice()); const before = w.snapshot(); const restore = failDatabaseWrites(w.database, "records", "namespace", "relay_notices");
    try { const outcomes = await Promise.allSettled([w.queue.markDelivered("a", id), w.queue.markDelivered("b", id)]); expect(outcomes.every((r) => r.status === "rejected")).toBe(true); } finally { restore(); }
    expect(w.snapshot()).toBe(before); await w.queue.markDelivered("a", id); expect(w.records("relay_notices")[0].data.deliveredTo).toEqual(["a"]);
  });
  test("Q13 withdraw 只撤销 pending，保留原正文；并发拒答不会变成 answered", async () => {
    const w = await world(); const id = w.seed(); const original = w.records("relay_questions")[0]; const events = vi.fn(); w.queue.subscribe(events);
    const [answer] = await Promise.all([w.queue.answer(id, "确认", "a"), w.queue.withdraw(id), w.queue.withdraw(id)]); expect(answer.ok).toBe(false);
    const current = w.records("relay_questions")[0]; expect(current.version).toBe(original.version + 1); expect(current.data).toEqual({ ...original.data, status: "withdrawn" }); expect(current.data.answer).toBeUndefined();
    await w.queue.withdraw("missing"); expect(w.deliver).not.toHaveBeenCalled(); expect(events).not.toHaveBeenCalled();
  });
  test("Q14 撤回写失败保留 pending，已答/已撤回不改写，未知回执不建记录", async () => {
    const w = await world(); const id = w.seed(); const before = w.snapshot(); const restore = failDatabaseWrites(w.database, "records", "namespace", "relay_questions");
    try { await expect(w.queue.withdraw(id)).rejects.toThrow("拒绝写入"); } finally { restore(); }
    expect(w.snapshot()).toBe(before); await w.queue.withdraw(id);
    const answered = w.seed("answered"); const stable = w.snapshot(); await w.queue.withdraw(answered); await w.queue.markDelivered("a", "unknown"); expect(w.snapshot()).toBe(stable);
  });
});
