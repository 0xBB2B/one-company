import { failDatabaseWrites } from "./helpers/database-fixture.ts";
import { uuidv7, readRecord, putRecord, withDatabase } from "../runtime/database.ts";
import { afterEach, describe, expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClock } from "../runtime/clock.ts";
import { WindowRegistry, currentBootId, processStartedAt, startHeartbeat } from "../runtime/windows.ts";

interface FakeTimeSource {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  advance(ms: number): void;
  jump(ms: number): void;
}

function createFakeTimeSource(): FakeTimeSource {
  let current = 0;
  let nextId = 1;
  const timers = new Map<number, { fireAt: number; fn: () => void }>();

  function setTimeoutFake(fn: () => void, ms: number): unknown {
    const id = nextId++;
    timers.set(id, { fireAt: current + ms, fn });
    return id;
  }

  function clearTimeoutFake(handle: unknown): void {
    timers.delete(handle as number);
  }

  function advance(ms: number): void {
    const target = current + ms;
    while (true) {
      let earliestId: number | undefined;
      let earliestFireAt = Infinity;
      for (const [id, entry] of timers) {
        if (entry.fireAt <= target && entry.fireAt < earliestFireAt) {
          earliestId = id;
          earliestFireAt = entry.fireAt;
        }
      }
      if (earliestId === undefined) break;
      const entry = timers.get(earliestId);
      timers.delete(earliestId);
      current = earliestFireAt;
      entry?.fn();
    }
    current = target;
  }

  function jump(ms: number): void {
    const target = current + ms;
    current = target;
    const due: Array<{ fireAt: number; fn: () => void }> = [];
    for (const [id, entry] of timers) {
      if (entry.fireAt <= target) {
        due.push(entry);
        timers.delete(id);
      }
    }
    for (const entry of due) entry.fn();
  }

  return { now: () => current, setTimeout: setTimeoutFake, clearTimeout: clearTimeoutFake, advance, jump };
}

const repoDirs: string[] = [];

afterEach(async () => {
  for (const dir of repoDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function makeRepoDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "window-registry-"));
  repoDirs.push(dir);
  return dir;
}

function windowInput(overrides: Record<string, unknown> = {}) {
  return {
    windowId: uuidv7(),
    pid: process.pid,
    sessionId: "session-demo",
    cwd: "/tmp/example-cwd",
    workspaceRoot: "/tmp/example-root",
    ...overrides,
  };
}

async function makeRegistry(): Promise<{
  registry: WindowRegistry;
  repoDir: string;
  timeSource: FakeTimeSource;
  clock: ReturnType<typeof createClock>;
}> {
  const repoDir = await makeRepoDir();
  const timeSource = createFakeTimeSource();
  const clock = createClock({ timeSource });
  const registry = new WindowRegistry({
    repoDir,
    clock,
    bootId: async () => "boot-fixed",
    processStartedAt: async (pid: number) => `start-${pid}`,
  });
  return { registry, repoDir, timeSource, clock };
}

interface MutableEvidenceState {
  boot: string;
  starts: Map<number, string | null>;
}

async function makeMutableRegistry(): Promise<{
  registry: WindowRegistry;
  repoDir: string;
  timeSource: FakeTimeSource;
  state: MutableEvidenceState;
}> {
  const repoDir = await makeRepoDir();
  const timeSource = createFakeTimeSource();
  const clock = createClock({ timeSource });
  const state: MutableEvidenceState = { boot: "boot-a", starts: new Map() };
  const registry = new WindowRegistry({
    repoDir,
    clock,
    bootId: async () => state.boot,
    processStartedAt: async (pid: number) => state.starts.get(pid) ?? null,
  });
  return { registry, repoDir, timeSource, state };
}

function flushIO(ms = 20): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function windowRef(repoDir: string, windowId: string) {
  return { database: join(repoDir, "data.db"), namespace: "windows", key: windowId };
}

function windowJson(repoDir: string, windowId: string): string {
  const record = readRecord(windowRef(repoDir, windowId));
  if (!record.exists) throw new Error("窗口记录不存在");
  return JSON.stringify(record.data);
}

describe("WindowRegistry.register", () => {
  test("登记写入 data.db 的 windows 记录且返回窗口标识", async () => {
    const { registry, repoDir } = await makeRegistry();
    const windowId = await registry.register(
      windowInput({ sessionId: "sess-1", cwd: "/repo/a", workspaceRoot: "/repo" }),
    );

    expect(typeof windowId).toBe("string");
    expect(windowId.length).toBeGreaterThan(0);

    const raw = windowJson(repoDir, windowId);
    const record = JSON.parse(raw);
    expect(record.windowId).toBe(windowId);
    expect(record.sessionId).toBe("sess-1");
    expect(record.cwd).toBe("/repo/a");
    expect(record.workspaceRoot).toBe("/repo");
    expect(typeof record.pid).toBe("number");
    expect(typeof record.processStartedAt).toBe("string");
    expect(typeof record.bootId).toBe("string");
    expect(typeof record.startedAt).toBe("string");
    expect(typeof record.heartbeatAt).toBe("string");
    expect(typeof record.heartbeatSeq).toBe("number");
  });

  test("进程启动时刻读取失败（processStartedAt 返回 null）时拒绝登记且不写入记录", async () => {
    const repoDir = await makeRepoDir();
    const timeSource = createFakeTimeSource();
    const clock = createClock({ timeSource });
    const registry = new WindowRegistry({
      repoDir,
      clock,
      bootId: async () => "boot-fixed",
      processStartedAt: async () => null,
    });

    let caught: unknown;
    try {
      await registry.register(windowInput());
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);

    expect(await registry.list()).toEqual([]);
  });

  test("windowId 由调用方传入，返回值与记录中的 windowId 均等于传入值", async () => {
    const { registry, repoDir } = await makeRegistry();
    const windowId = uuidv7();
    const returned = await registry.register(windowInput({ windowId }));

    expect(returned).toBe(windowId);
    const raw = windowJson(repoDir, windowId);
    const record = JSON.parse(raw);
    expect(record.windowId).toBe(windowId);
  });

  test("缺少 windowId 时拒绝登记且不写入记录", async () => {
    const { registry } = await makeRegistry();
    const input = windowInput() as Record<string, unknown>;
    delete input.windowId;

    let caught: unknown;
    try {
      await registry.register(input as unknown as Parameters<typeof registry.register>[0]);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);

    expect(await registry.list()).toEqual([]);
  });

  test("windowId 非合法 UUID 时拒绝登记且不写入记录", async () => {
    const { registry } = await makeRegistry();

    let caught: unknown;
    try {
      await registry.register(windowInput({ windowId: "not-a-uuid" }));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);

    expect(await registry.list()).toEqual([]);
  });
});

describe("WindowRegistry.list — liveness 判定", () => {
  test("两个窗口登记后 list 返回两条且均为 alive；停止心跳的窗口 20 秒后为 lost，持续心跳的窗口仍为 alive", async () => {
    const { registry, timeSource } = await makeRegistry();
    const a = await registry.register(windowInput({ sessionId: "a" }));
    const b = await registry.register(windowInput({ sessionId: "b" }));

    const initial = await registry.list();
    expect(initial.length).toBe(2);
    expect(initial.every((r) => r.liveness === "alive")).toBe(true);

    for (let i = 0; i < 4; i++) {
      timeSource.advance(5_000);
      await registry.heartbeat(b);
    }

    const after = await registry.list();
    const recordA = after.find((r) => r.windowId === a);
    const recordB = after.find((r) => r.windowId === b);
    expect(recordA?.liveness).toBe("lost");
    expect(recordB?.liveness).toBe("alive");
  });

  test("睡眠间隔期间无心跳不判 lost，唤醒后首个心跳恢复 alive", async () => {
    const { registry, timeSource, clock } = await makeRegistry();
    clock.startGapWatcher();
    const windowId = await registry.register(windowInput());

    timeSource.jump(600_000);

    const duringWake = await registry.list();
    const duringRecord = duringWake.find((r) => r.windowId === windowId);
    expect(duringRecord?.liveness).toBe("alive");

    await registry.heartbeat(windowId);
    const afterHeartbeat = await registry.list();
    const afterRecord = afterHeartbeat.find((r) => r.windowId === windowId);
    expect(afterRecord?.liveness).toBe("alive");
  });

  test("睡眠唤醒后持续无心跳，超过 3 个周期后判定为 lost", async () => {
    const { registry, timeSource, clock } = await makeRegistry();
    clock.startGapWatcher();
    const windowId = await registry.register(windowInput());

    timeSource.jump(600_000);
    timeSource.advance(20_000);

    const list = await registry.list();
    expect(list.find((r) => r.windowId === windowId)?.liveness).toBe("lost");
  });

  test("两个睡眠间隔累计扣除后仍为 alive", async () => {
    const { registry, timeSource, clock } = await makeRegistry();
    clock.startGapWatcher();
    const windowId = await registry.register(windowInput());

    timeSource.jump(600_000);
    timeSource.advance(3_000);
    timeSource.jump(400_000);
    timeSource.advance(3_000);

    const list = await registry.list();
    expect(list.find((r) => r.windowId === windowId)?.liveness).toBe("alive");
  });
});

describe("WindowRegistry.isAlive", () => {
  test("心跳新鲜时返回 true", async () => {
    const { registry } = await makeRegistry();
    const windowId = await registry.register(windowInput());
    expect(await registry.isAlive(windowId)).toBe(true);
  });

  test("超过 3 个心跳周期无更新时返回 false", async () => {
    const { registry, timeSource } = await makeRegistry();
    const windowId = await registry.register(windowInput());
    timeSource.advance(20_000);
    expect(await registry.isAlive(windowId)).toBe(false);
  });
});

describe("startHeartbeat", () => {
  test("每 5 秒自动心跳更新 heartbeatSeq，调用停止函数后不再更新", async () => {
    const { registry, timeSource } = await makeRegistry();
    const windowId = await registry.register(windowInput());
    const before = (await registry.list()).find((r) => r.windowId === windowId);

    const stop = startHeartbeat(registry, windowId);

    timeSource.advance(5_000);
    await flushIO();
    const afterOne = (await registry.list()).find((r) => r.windowId === windowId);
    expect(afterOne?.heartbeatSeq).toBeGreaterThan((before?.heartbeatSeq as number) ?? 0);

    timeSource.advance(5_000);
    await flushIO();
    const afterTwo = (await registry.list()).find((r) => r.windowId === windowId);
    expect(afterTwo?.heartbeatSeq).toBeGreaterThan((afterOne?.heartbeatSeq as number) ?? 0);

    stop();
    const seqAtStop = afterTwo?.heartbeatSeq;
    timeSource.advance(10_000);
    await flushIO();
    const afterStop = (await registry.list()).find((r) => r.windowId === windowId);
    expect(afterStop?.heartbeatSeq).toBe(seqAtStop);
  });
});

describe("WindowRegistry.unregister", () => {
  test("注销后记录从 list 中移除", async () => {
    const { registry } = await makeRegistry();
    const windowId = await registry.register(windowInput());
    await registry.unregister(windowId);

    const list = await registry.list();
    expect(list.find((r) => r.windowId === windowId)).toBeUndefined();
  });

  test("对同一窗口标识调用两次注销均不抛错（幂等）", async () => {
    const { registry } = await makeRegistry();
    const windowId = await registry.register(windowInput());
    await registry.unregister(windowId);
    await registry.unregister(windowId);

    const list = await registry.list();
    expect(list.find((r) => r.windowId === windowId)).toBeUndefined();
  });
});

describe("WindowRegistry.holderGone", () => {
  test("记录已注销 → gone:true evidence:unregistered", async () => {
    const { registry } = await makeRegistry();
    const windowId = await registry.register(windowInput());
    await registry.unregister(windowId);

    const result = await registry.holderGone(windowId);
    expect(result).toEqual({ gone: true, evidence: "unregistered" });
  });

  test("心跳过期且 processStartedAt 返回 null（pid 不存在）→ gone:true evidence:pid-missing，list 中同记录 liveness 为 gone", async () => {
    const { registry, timeSource, state } = await makeMutableRegistry();
    const pid = 4242;
    state.starts.set(pid, "2024-01-01T00:00:00.000Z");
    const windowId = await registry.register(windowInput({ pid }));

    timeSource.advance(20_000);
    state.starts.set(pid, null);

    const result = await registry.holderGone(windowId);
    expect(result).toEqual({ gone: true, evidence: "pid-missing" });

    const list = await registry.list();
    expect(list.find((r) => r.windowId === windowId)?.liveness).toBe("gone");
  });

  test("心跳过期且 pid 存在但启动时刻与记录不一致 → gone:true evidence:pid-reused", async () => {
    const { registry, timeSource, state } = await makeMutableRegistry();
    const pid = 4343;
    state.starts.set(pid, "2024-01-01T00:00:00.000Z");
    const windowId = await registry.register(windowInput({ pid }));

    timeSource.advance(20_000);
    state.starts.set(pid, "2025-06-01T00:00:00.000Z");

    const result = await registry.holderGone(windowId);
    expect(result).toEqual({ gone: true, evidence: "pid-reused" });
  });

  test("心跳过期且开机标识变化 → gone:true evidence:boot-changed", async () => {
    const { registry, timeSource, state } = await makeMutableRegistry();
    const pid = 4444;
    state.starts.set(pid, "2024-01-01T00:00:00.000Z");
    const windowId = await registry.register(windowInput({ pid }));

    timeSource.advance(20_000);
    state.boot = "boot-b";

    const result = await registry.holderGone(windowId);
    expect(result).toEqual({ gone: true, evidence: "boot-changed" });
  });

  test("心跳过期但开机标识相同且进程存在（启动时刻一致）→ gone:false 并附 reason", async () => {
    const { registry, timeSource, state } = await makeMutableRegistry();
    const pid = 4545;
    state.starts.set(pid, "2024-01-01T00:00:00.000Z");
    const windowId = await registry.register(windowInput({ pid }));

    timeSource.advance(20_000);

    const result = await registry.holderGone(windowId);
    expect(result.gone).toBe(false);
    expect(typeof (result as { reason?: unknown }).reason).toBe("string");
  });

  test("processStartedAt 探测本身失败（抛错）时返回 gone:false 并附原因，不得判 pid-missing", async () => {
    const repoDir = await makeRepoDir();
    const timeSource = createFakeTimeSource();
    const clock = createClock({ timeSource });
    let shouldThrow = false;
    const registry = new WindowRegistry({
      repoDir,
      clock,
      bootId: async () => "boot-fixed",
      processStartedAt: async (pid: number) => {
        if (shouldThrow) throw new Error("探测失败");
        return `start-${pid}`;
      },
    });
    const windowId = await registry.register(windowInput({ pid: 5151 }));

    timeSource.advance(20_000);
    shouldThrow = true;

    let caught: unknown;
    let result: Awaited<ReturnType<typeof registry.holderGone>> | undefined;
    try {
      result = await registry.holderGone(windowId);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeUndefined();
    expect(result?.gone).toBe(false);
    expect(typeof (result as { reason?: unknown } | undefined)?.reason).toBe("string");
  });
});

describe("并发与记录完整性", () => {
  test("依次调用心跳时 heartbeatSeq 严格递增", async () => {
    const { registry, timeSource } = await makeRegistry();
    const windowId = await registry.register(windowInput());
    const seqs: number[] = [];
    for (let i = 0; i < 5; i++) {
      timeSource.advance(5_000);
      await registry.heartbeat(windowId);
      const record = (await registry.list()).find((r) => r.windowId === windowId);
      seqs.push(record?.heartbeatSeq as number);
    }
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBeGreaterThan(seqs[i - 1] as number);
    }
  });

  test("同一窗口 20 次并发心跳与另一窗口心跳并发执行后两条记录均可读", async () => {
    const { registry, repoDir } = await makeRegistry();
    const windowId = await registry.register(windowInput({ sessionId: "concurrent" }));
    const otherId = await registry.register(windowInput({ sessionId: "other" }));

    await Promise.all([
      ...Array.from({ length: 20 }, () => registry.heartbeat(windowId)),
      registry.heartbeat(otherId),
    ]);

    const raw = windowJson(repoDir, windowId);
    const record = JSON.parse(raw);
    expect(record.windowId).toBe(windowId);
    expect(typeof record.heartbeatSeq).toBe("number");

    const otherRaw = windowJson(repoDir, otherId);
    const otherRecord = JSON.parse(otherRaw);
    expect(otherRecord.windowId).toBe(otherId);
  });

  test("heartbeat 遇到记录已被替换为其他窗口记录时拒绝写入且不覆盖", async () => {
    const { registry, repoDir } = await makeRegistry();
    const windowId = await registry.register(windowInput());
    const ref = windowRef(repoDir, windowId);
    const original = JSON.parse(windowJson(repoDir, windowId));
    const replaced = { ...original, windowId: "other-window-id", heartbeatSeq: 999 };
    putRecord(ref, replaced);

    try {
      await registry.heartbeat(windowId);
    } catch {
      // 拒绝可能以抛错或返回值表示，此处只关心记录是否被覆盖
    }

    const after = JSON.parse(windowJson(repoDir, windowId));
    expect(after.windowId).toBe("other-window-id");
    expect(after.heartbeatSeq).toBe(999);
  });

  test("并发 20 次心跳后 heartbeatSeq 恰好增加 20（无丢更新）", async () => {
    const { registry, repoDir } = await makeRegistry();
    const windowId = await registry.register(windowInput());
    const before = JSON.parse(windowJson(repoDir, windowId));

    await Promise.all(Array.from({ length: 20 }, () => registry.heartbeat(windowId)));

    const after = JSON.parse(windowJson(repoDir, windowId));
    expect(after.heartbeatSeq).toBe(before.heartbeatSeq + 20);
  });

  test("unregister 与飞行中的 heartbeat 并发时窗口不会被复活", async () => {
    const { registry } = await makeRegistry();
    let resurrected = 0;
    for (let i = 0; i < 15; i++) {
      const windowId = await registry.register(windowInput({ sessionId: `race-${i}` }));
      await Promise.all([registry.heartbeat(windowId), registry.unregister(windowId)]);
      const list = await registry.list();
      if (list.some((r) => r.windowId === windowId)) resurrected++;
    }
    expect(resurrected).toBe(0);
  });
});

const TRAVERSAL_WINDOW_ID = "../../x/sentinel";

describe("windowId 路径穿越防护", () => {
  test("heartbeat 遇到含路径穿越的 windowId 时拒绝", async () => {
    const { registry } = await makeRegistry();
    await registry.register(windowInput());
    await expect(registry.heartbeat(TRAVERSAL_WINDOW_ID)).rejects.toThrow(/不合法的窗口标识/);
  });

  test("unregister 遇到含路径穿越的 windowId 时拒绝", async () => {
    const { registry } = await makeRegistry();
    await expect(registry.unregister(TRAVERSAL_WINDOW_ID)).rejects.toThrow(/不合法的窗口标识/);
  });

  test("holderGone 遇到含路径穿越的 windowId 时拒绝", async () => {
    const { registry } = await makeRegistry();

    let caught: unknown;
    try {
      await registry.holderGone(TRAVERSAL_WINDOW_ID);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
  });
});

describe("list 对其他命名空间记录的容忍", () => {
  test("其他命名空间的记录不影响 list", async () => {
    const { registry, repoDir } = await makeRegistry();
    const windowId = await registry.register(windowInput());
    withDatabase(join(repoDir, "data.db"), (db) => db.create("other_namespace", "note", {}));

    const list = await registry.list();
    expect(list.map((r) => r.windowId)).toEqual([windowId]);
  });
});

describe("WindowRegistry.unregister 在从未登记过时", () => {
  test("从未登记过的仓库上注销合法标识不抛错", async () => {
    const { registry } = await makeRegistry();
    await registry.unregister(uuidv7());
    expect(await registry.list()).toEqual([]);
  });
});

describe("holderGone 与 register 在开机标识探测失败时", () => {
  test("bootId 探测抛错时 holderGone 返回 gone:false 并附原因", async () => {
    const repoDir = await makeRepoDir();
    const timeSource = createFakeTimeSource();
    let bootFails = false;
    const registry = new WindowRegistry({
      repoDir,
      clock: createClock({ timeSource }),
      bootId: async () => {
        if (bootFails) throw new Error("sysctl 不可用");
        return "boot-a";
      },
      processStartedAt: async () => "start-1",
    });
    const windowId = await registry.register(windowInput());
    timeSource.advance(20_000);
    bootFails = true;

    const result = await registry.holderGone(windowId);
    expect(result.gone).toBe(false);
    if (!result.gone) expect(result.reason.length).toBeGreaterThan(0);
  });

  test("bootId 探测抛错时 register 拒绝且不写记录", async () => {
    const repoDir = await makeRepoDir();
    const registry = new WindowRegistry({
      repoDir,
      clock: createClock({ timeSource: createFakeTimeSource() }),
      bootId: async () => {
        throw new Error("sysctl 不可用");
      },
      processStartedAt: async () => "start-1",
    });
    await expect(registry.register(windowInput())).rejects.toThrow();
    expect(await registry.list()).toEqual([]);
  });
});

describe("startHeartbeat 失败处理", () => {
  test("单次心跳失败后定时器继续运行，下一拍自愈并把错误交给回调", async () => {
    const { registry, repoDir, timeSource } = await makeRegistry();
    const windowId = await registry.register(windowInput());
    const errors: unknown[] = [];
    const stop = startHeartbeat(registry, windowId, (error) => errors.push(error));

    const restore = failDatabaseWrites(join(repoDir, "data.db"), "records", "namespace", "windows");
    try {
      timeSource.advance(5_000);
      await flushIO(50);
    } finally {
      restore();
    }
    expect(errors.length).toBe(1);

    timeSource.advance(5_000);
    await flushIO(50);
    stop();
    const record = (await registry.list()).find((r) => r.windowId === windowId);
    expect(record?.heartbeatSeq).toBe(1);
  });

  test("定时心跳写入失败时不产生未处理的 Promise 拒绝，停止函数仍正常工作", async () => {
    const { registry, repoDir, timeSource } = await makeRegistry();
    const windowId = await registry.register(windowInput());

    let unhandledCount = 0;
    const onUnhandledRejection = () => {
      unhandledCount++;
    };
    process.on("unhandledRejection", onUnhandledRejection);

    const restore = failDatabaseWrites(join(repoDir, "data.db"), "records", "namespace", "windows");
    try {
      const stop = startHeartbeat(registry, windowId);
      timeSource.advance(5_000);
      await flushIO(50);
      stop();
      timeSource.advance(5_000);
      await flushIO(50);
    } finally {
      restore();
      process.off("unhandledRejection", onUnhandledRejection);
    }

    expect(unhandledCount).toBe(0);
  });
});

describe("currentBootId", () => {
  test("返回非空字符串且两次调用结果相同", async () => {
    const first = await currentBootId();
    const second = await currentBootId();
    expect(typeof first).toBe("string");
    expect(first.length).toBeGreaterThan(0);
    expect(second).toBe(first);
  });

  test("在不同时区（UTC 与 Asia/Tokyo）下返回结果相同", async () => {
    const originalTZ = process.env.TZ;
    try {
      process.env.TZ = "UTC";
      const underUtc = await currentBootId();
      process.env.TZ = "Asia/Tokyo";
      const underTokyo = await currentBootId();
      expect(underTokyo).toBe(underUtc);
    } finally {
      if (originalTZ === undefined) delete process.env.TZ;
      else process.env.TZ = originalTZ;
    }
  });
});

describe("processStartedAt", () => {
  test("当前进程 pid 返回非空字符串", async () => {
    const started = await processStartedAt(process.pid);
    expect(started).not.toBeNull();
    expect(typeof started).toBe("string");
  });

  test("不存在的 pid 返回 null", async () => {
    const started = await processStartedAt(2147483647);
    expect(started).toBeNull();
  });

  test("ps 无法执行时抛错而不是返回 null", async () => {
    const originalPath = process.env.PATH;
    process.env.PATH = "/nonexistent";
    try {
      await expect(processStartedAt(process.pid)).rejects.toThrow();
    } finally {
      process.env.PATH = originalPath;
    }
  });
});
