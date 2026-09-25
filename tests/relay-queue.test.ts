import { afterEach, describe, expect, test, vi } from "vitest";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RelayQueue } from "../daemon/relay-queue.ts";
import { withDatabase } from "../runtime/database.ts";
import { failDatabaseWrites } from "./helpers/database-fixture.ts";

const SECRET = "LEGACY_RELAY_BODY_旧问题与转述不得执行";
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function world() {
  const dir = await mkdtemp(join(tmpdir(), "relay-retired-")); dirs.push(dir); const database = join(dir, "data.db");
  const deliver = vi.fn(async (..._args: any[]): Promise<string[]> => []);
  const queue = new RelayQueue({ dataDir: dir, deliver });
  const records = (namespace: string) => withDatabase(database, (db) => db.list<any>(namespace));
  const snapshot = () => withDatabase(database, (db) => JSON.stringify({ notices: db.list("relay_notices"), events: db.events("relay") }));
  return { dir, database, deliver, queue, records, snapshot };
}
const input = { requirement: "2026-09-09.relay", repoId: "repo-a", runId: "run-a" };
const notice = (kind = "stopped") => ({ requirement: input.requirement, repoId: input.repoId, runId: input.runId, kind: kind as any, message: SECRET });

describe("只保留固定状态通知", () => {
  test("Q04 数据库路径不可用时通知写入如实失败", async () => {
    const w = await world(); await mkdir(w.database);
    await expect(w.queue.notify(notice())).rejects.toThrow(); expect(w.deliver).not.toHaveBeenCalled();
  });
  test.each(["completed", "auto_resumed", "contract_change"])("Q06 %s 不能冒发，数据库和订阅无副作用", async (kind) => {
    const w = await world(); const before = w.snapshot(); const listener = vi.fn(); w.queue.subscribe(listener);
    await expect(w.queue.notify(notice(kind))).rejects.toThrow("只支持"); expect(w.snapshot()).toBe(before); expect(w.deliver).not.toHaveBeenCalled(); expect(listener).not.toHaveBeenCalled();
  });
  test.each(["stopped", "blocked", "interrupted"])("Q07 %s 固定通知带身份、不带原文或完成保证，记录真实投递窗口", async (kind) => {
    const w = await world(); w.deliver.mockResolvedValue(["win-a"]); const { id } = await w.queue.notify(notice(kind));
    expect(w.deliver).toHaveBeenCalledOnce(); const [event, payload, options] = w.deliver.mock.calls[0]!;
    expect(event).toBe("relay.notice"); expect(options).toEqual({ repoId: input.repoId }); expect(payload).toMatchObject({ id, kind, requirement: input.requirement, runId: input.runId }); expect(payload).not.toHaveProperty("deliveredTo");
    expect(payload.message).toContain("不表示进程已停止或需求已完成"); expect(JSON.stringify(payload)).not.toContain(SECRET);
    expect(w.records("relay_notices")[0].data.deliveredTo).toEqual(["win-a"]); expect(w.snapshot()).not.toContain(SECRET);
  });
  test("Q08 离线或失败通知保留未投递事实，不重放；错误正文不泄漏", async () => {
    const w = await world(); w.deliver.mockRejectedValue(new Error(SECRET)); const events: any[] = []; w.queue.subscribe((e) => events.push(e));
    const { id } = await w.queue.notify(notice()); expect(w.records("relay_notices")[0].data).toMatchObject({ id, deliveredTo: [] });
    expect(events.some((e) => e.type === "deliver_failed" && e.event === "relay.notice")).toBe(true); expect(JSON.stringify(events)).not.toContain(SECRET);
    new RelayQueue({ dataDir: w.dir, deliver: w.deliver }); expect(w.deliver).toHaveBeenCalledOnce();
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
    const rebuilt = new RelayQueue({ dataDir: w.dir, deliver: w.deliver }); await rebuilt.markDelivered("c", id);
    expect(w.records("relay_notices")[0].data.deliveredTo.sort()).toEqual(["a", "b", "c"]);
  });
  test("Q12 并发回执写失败双方拒绝且版本/数据不变，恢复后只追加成功窗口", async () => {
    const w = await world(); const { id } = await w.queue.notify(notice()); const before = w.snapshot(); const restore = failDatabaseWrites(w.database, "records", "namespace", "relay_notices");
    try { const outcomes = await Promise.allSettled([w.queue.markDelivered("a", id), w.queue.markDelivered("b", id)]); expect(outcomes.every((r) => r.status === "rejected")).toBe(true); } finally { restore(); }
    expect(w.snapshot()).toBe(before); await w.queue.markDelivered("a", id); expect(w.records("relay_notices")[0].data.deliveredTo).toEqual(["a"]);
  });
  test("Q14 未知回执不建记录", async () => {
    const w = await world(); await w.queue.notify(notice()); const stable = w.snapshot();
    await w.queue.markDelivered("a", "unknown"); expect(w.snapshot()).toBe(stable);
  });
});
