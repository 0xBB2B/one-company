import { afterEach, describe, expect, test } from "vitest";
import { uuidv7, repositoryDatabase, readRecord, putRecord, UUID_V7_PATTERN } from "../src/core/storage/database.ts";
import { recordJson, mutateRecord, testRepoId } from "./helpers/database-fixture.ts";
import type { RecordRef } from "../src/core/storage/database.ts";
import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { createTempHome, removeTempHome } from "./helpers/temp-home.ts";
import { RunStore, assertTransition, isTerminalState } from "../src/modules/agents/run-store.ts";
import type { RunState } from "../src/modules/agents/run-store.ts";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const tempHomes: Array<Awaited<ReturnType<typeof createTempHome>>> = [];

afterEach(async () => {
  for (const home of tempHomes.splice(0)) {
    await removeTempHome(home);
  }
});

function isValidUtcTimestamp(value: unknown): boolean {
  return typeof value === "string" && new Date(value).toISOString() === value;
}

async function makeStore(overrides: { daemonStartedAt?: string } = {}): Promise<{
  store: RunStore;
  dataRoot: string;
  repoId: string;
  daemonStartedAt: string;
}> {
  const home = await createTempHome();
  tempHomes.push(home);
  const repoId = testRepoId();
  const daemonStartedAt = overrides.daemonStartedAt ?? new Date().toISOString();
  const store = new RunStore({ dataRoot: home.dataRoot, repoId, daemonStartedAt });
  return { store, dataRoot: home.dataRoot, repoId, daemonStartedAt };
}

function requirementInput(overrides: Record<string, unknown> = {}) {
  return {
    kind: "requirement",
    requirement: uuidv7(),
    task: "示例任务",
    cwd: "/tmp/example-cwd",
    writePaths: [],
    readPaths: [],
    model: { provider: "anthropic", id: "claude-test" },
    thinking: "high",
    mcp: [],
    ...overrides,
  };
}

function roleInput(parentRunId: string, overrides: Record<string, unknown> = {}) {
  return requirementInput({
    kind: "role",
    role: "one-company.worker",
    parentRunId,
    ...overrides,
  });
}

async function statePath(dataRoot: string, repoId: string, runId: string): Promise<RecordRef> {
  return { database: repositoryDatabase(dataRoot, repoId), namespace: "runs", key: runId };
}
const overwriteStateFile = mutateRecord;

describe("RunStore.create", () => {
  test("kind requirement 创建成功返回合法运行身份与初始字段", async () => {
    const { store, daemonStartedAt } = await makeStore();
    const run = await store.create(requirementInput());

    expect(UUID_V7_PATTERN.test(run.id)).toBe(true);
    expect(run.kind).toBe("requirement");
    expect(UUID_V7_PATTERN.test(run.requirement)).toBe(true);
    expect(run.state).toBe("queued");
    expect(run.turns).toBe(0);
    expect(run.daemonStartedAt).toBe(daemonStartedAt);
    expect(isValidUtcTimestamp(run.startedAt)).toBe(true);
    expect(isValidUtcTimestamp(run.updatedAt)).toBe(true);
  });

  test("kind role 创建成功携带 role 与 parentRunId", async () => {
    const { store } = await makeStore();
    const parent = await store.create(requirementInput());
    const child = await store.create(roleInput(parent.id));

    expect(child.kind).toBe("role");
    expect(child.role).toBe("one-company.worker");
    expect(child.parentRunId).toBe(parent.id);
  });

  test("运行记录所在仓库目录权限 0700、data.db 文件权限 0600", async () => {
    const { store, dataRoot, repoId } = await makeStore();
    const run = await store.create(requirementInput());
    const dir = join(dataRoot, "repos", repoId);
    const path = await statePath(dataRoot, repoId, run.id);

    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect((await stat(path.database)).mode & 0o777).toBe(0o600);
  });

  test("50 个并发创建各自生成互不相同的运行身份且文件权限正确", async () => {
    const { store, dataRoot, repoId } = await makeStore();
    const runs = await Promise.all(Array.from({ length: 50 }, () => store.create(requirementInput())));

    expect(new Set(runs.map((run) => run.id)).size).toBe(50);
    for (const run of runs) {
      expect(UUID_V7_PATTERN.test(run.id)).toBe(true);
      const dir = join(dataRoot, "repos", repoId);
      const path = await statePath(dataRoot, repoId, run.id);
      expect((await stat(dir)).mode & 0o777).toBe(0o700);
      expect((await stat(path.database)).mode & 0o777).toBe(0o600);
    }
  });

  test("缺少 requirement 时抛错", async () => {
    const { store } = await makeStore();
    const input = requirementInput();
    delete (input as Record<string, unknown>).requirement;
    await expect(store.create(input)).rejects.toThrow();
  });

  test("kind 为 role 但缺 parentRunId 时抛错", async () => {
    const { store } = await makeStore();
    const input = requirementInput({ kind: "role", role: "one-company.worker" });
    await expect(store.create(input)).rejects.toThrow();
  });

  test("role 不以 one-company. 开头时抛错", async () => {
    const { store } = await makeStore();
    const parent = await store.create(requirementInput());
    const input = requirementInput({ kind: "role", role: "worker", parentRunId: parent.id });
    await expect(store.create(input)).rejects.toThrow();
  });

  test("role 为 one-company.reviewer 但缺 parentRunId 时抛错（不按角色名特判）", async () => {
    const { store } = await makeStore();
    const input = requirementInput({ kind: "role", role: "one-company.reviewer" });
    await expect(store.create(input)).rejects.toThrow();
  });

});

describe("RunStore.get", () => {
  test("能读回刚创建的记录", async () => {
    const { store } = await makeStore();
    const created = await store.create(requirementInput());
    const result = await store.get(created.id);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.run.id).toBe(created.id);
  });

  test("不存在的运行身份返回 not_found", async () => {
    const { store } = await makeStore();
    const result = await store.get(randomUUID());
    expect(result).toMatchObject({ ok: false, reason: "not_found" });
  });

  test("运行记录损坏为非 JSON 时返回 unreadable 而不抛出", async () => {
    const { store, dataRoot, repoId } = await makeStore();
    const created = await store.create(requirementInput());
    const path = await statePath(dataRoot, repoId, created.id);
    putRecord(path, "损坏的运行记录");

    const result = await store.get(created.id);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("unreadable");
  });
});

describe("RunStore.list", () => {
  test("按 startedAt 倒序排列", async () => {
    const { store } = await makeStore();
    const first = await store.create(requirementInput());
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await store.create(requirementInput());
    await new Promise((resolve) => setTimeout(resolve, 5));
    const third = await store.create(requirementInput());

    const { items } = await store.list({ limit: 100 });
    expect(items.map((item) => item.id)).toEqual([third.id, second.id, first.id]);
  });

  test("按 kind 过滤", async () => {
    const { store } = await makeStore();
    const parent = await store.create(requirementInput());
    const child = await store.create(roleInput(parent.id));

    const { items } = await store.list({ kind: "role", limit: 100 });
    expect(items.map((item) => item.id)).toEqual([child.id]);
  });

  test("按 requirement 过滤", async () => {
    const { store } = await makeStore();
    const a = await store.create(requirementInput());
    await store.create(requirementInput());

    const { items } = await store.list({ requirement: a.requirement, limit: 100 });
    expect(items.map((item) => item.id)).toEqual([a.id]);
  });

  test("按 states 过滤", async () => {
    const { store } = await makeStore();
    const queued = await store.create(requirementInput());
    const running = await store.create(requirementInput());
    await store.update(running.id, { state: "running" });

    const { items } = await store.list({ states: ["running"], limit: 100 });
    expect(items.map((item) => item.id)).toEqual([running.id]);
    expect(items.map((item) => item.id)).not.toContain(queued.id);
  });

  test("offset 与 limit 分页", async () => {
    const { store } = await makeStore();
    for (let i = 0; i < 5; i += 1) {
      await store.create(requirementInput());
      await new Promise((resolve) => setTimeout(resolve, 2));
    }

    const page1 = await store.list({ offset: 0, limit: 2 });
    const page2 = await store.list({ offset: 2, limit: 2 });
    expect(page1.items.length).toBe(2);
    expect(page2.items.length).toBe(2);
    expect(page1.total).toBe(5);
    expect(page2.total).toBe(5);
    expect(page1.items.map((item) => item.id)).not.toEqual(page2.items.map((item) => item.id));
  });

  test("runningCount 统计 running/pausing，结果不含 uncertainCount 字段", async () => {
    const { store } = await makeStore();
    const running = await store.create(requirementInput());
    await store.update(running.id, { state: "running" });

    const pausing = await store.create(requirementInput());
    await store.update(pausing.id, { state: "running" });
    await store.update(pausing.id, { state: "pausing" });

    const queued = await store.create(requirementInput());

    const result = await store.list({ limit: 100 });
    expect(result.runningCount).toBe(2);
    expect(result.total).toBe(3);
    expect("uncertainCount" in result).toBe(false);
    void queued;
  });
});

describe("RunStore.update", () => {
  test("合法转换更新 state 与 updatedAt", async () => {
    const { store } = await makeStore();
    const created = await store.create(requirementInput());
    await new Promise((resolve) => setTimeout(resolve, 5));
    const updated = await store.update(created.id, { state: "running" });

    expect(updated.state).toBe("running");
    expect(updated.updatedAt).not.toBe(created.updatedAt);
  });

  test("进入终态时若未提供 endedAt 则自动写入当前时间", async () => {
    const { store } = await makeStore();
    const created = await store.create(requirementInput());
    await store.update(created.id, { state: "running" });
    const completed = await store.update(created.id, { state: "completed" });

    expect(isValidUtcTimestamp(completed.endedAt)).toBe(true);
  });

  test("已有 endedAt 的记录再次更新时 endedAt 不再改变", async () => {
    const { store } = await makeStore();
    const created = await store.create(requirementInput());
    await store.update(created.id, { state: "running" });
    const completed = await store.update(created.id, { state: "completed" });
    const firstEndedAt = completed.endedAt;

    const secondUpdate = await store.update(created.id, {
      stateReason: "补记说明",
      endedAt: "2000-01-01T00:00:00.000Z",
    });

    expect(secondUpdate.endedAt).toBe(firstEndedAt);
    expect(secondUpdate.stateReason).toBe("补记说明");
  });

  test("用户停止后补写说明不改变 stopped 状态与 endedAt", async () => {
    const { store } = await makeStore();
    const created = await store.create(requirementInput());
    await store.update(created.id, { state: "running" });
    const stopped = await store.update(created.id, { state: "stopped", stateReason: "用户停止" });

    const after = await store.update(created.id, { stateReason: "后代进程清理未确认" });

    expect(after.state).toBe("stopped");
    expect(after.endedAt).toBe(stopped.endedAt);
    expect(after.stateReason).toBe("后代进程清理未确认");
    expect(isTerminalState(after.state)).toBe(true);
  });

  test.each([
    ["completed", "running"],
    ["stopped", "paused"],
    ["queued", "paused"],
  ])("非法转换 %s→%s 抛出含'不允许'的错误且文件不变", async (from, to) => {
    const { store } = await makeStore();
    const created = await store.create(requirementInput());

    if (from === "stopped") {
      await store.update(created.id, { state: "stopped" });
    } else if (from === "completed") {
      await store.update(created.id, { state: "running" });
      await store.update(created.id, { state: "completed" });
    }

    const before = await store.get(created.id);
    let caught: unknown;
    try {
      await store.update(created.id, { state: to as never });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("不允许");

    const after = await store.get(created.id);
    expect(after).toEqual(before);
  });

  test("20 个并发 update 混合写入不同字段全部生效且互不清空", async () => {
    const { store } = await makeStore();
    const created = await store.create(requirementInput());

    const reasons = Array.from({ length: 10 }, (_, i) => `原因-${i}`);
    const pauses = Array.from({ length: 5 }, (_, i) => i + 1);

    await Promise.all([
      ...reasons.map((reason) => store.update(created.id, { stateReason: reason })),
      ...Array.from({ length: 5 }, () => store.update(created.id, { pausedAt: "2026-01-01T00:00:00.000Z" })),
      ...pauses.map((pausedMs) => store.update(created.id, { pausedMs })),
    ]);

    const after = await store.get(created.id);
    expect(after.ok).toBe(true);
    if (after.ok) {
      expect(after.run.pausedAt).toBe("2026-01-01T00:00:00.000Z");
      expect(pauses).toContain(after.run.pausedMs);
      expect(reasons).toContain(after.run.stateReason);
      expect(after.run.turns).toBe(created.turns);
    }
  });
});

describe("RunStore.markOwnRunsInterrupted", () => {
  test("只把本实例的非终态运行标记为中断，其他实例与终态记录不动", async () => {
    const { dataRoot, repoId, daemonStartedAt } = await makeStore();
    const own = new RunStore({ dataRoot, repoId, daemonStartedAt });
    const other = new RunStore({ dataRoot, repoId, daemonStartedAt: "other-instance" });
    const ownRunning = await own.create(requirementInput());
    await own.update(ownRunning.id, { state: "running" });
    const ownDone = await own.create(requirementInput());
    await own.update(ownDone.id, { state: "running" });
    await own.update(ownDone.id, { state: "completed" });
    const otherRunning = await other.create(requirementInput());
    await other.update(otherRunning.id, { state: "running" });

    const result = await own.markOwnRunsInterrupted();

    expect(result.interrupted).toEqual([ownRunning.id]);
    expect(result.failed).toEqual([]);
    const after = await Promise.all([ownRunning.id, ownDone.id, otherRunning.id].map((id) => own.get(id)));
    expect(after.map((r) => (r.ok ? r.run.state : r.reason))).toEqual(["interrupted", "completed", "running"]);
    const again = await own.markOwnRunsInterrupted();
    expect(again.interrupted).toEqual([]);
  });
});

describe("RunStore.markInterruptedOnStartup", () => {
  test("守护进程重启后把旧实例的非终态运行标记为 interrupted，终态与新实例的记录不变", async () => {
    const { dataRoot, repoId, daemonStartedAt: firstDaemonStartedAt } = await makeStore();
    const firstStore = new RunStore({ dataRoot, repoId, daemonStartedAt: firstDaemonStartedAt });

    const running = await firstStore.create(requirementInput());
    await firstStore.update(running.id, { state: "running" });
    const paused = await firstStore.create(requirementInput());
    await firstStore.update(paused.id, { state: "running" });
    await firstStore.update(paused.id, { state: "pausing" });
    await firstStore.update(paused.id, { state: "paused" });

    const completedRun = await firstStore.create(requirementInput());
    await firstStore.update(completedRun.id, { state: "running" });
    await firstStore.update(completedRun.id, { state: "completed" });

    const secondDaemonStartedAt = new Date(Date.now() + 1000).toISOString();
    const secondStore = new RunStore({ dataRoot, repoId, daemonStartedAt: secondDaemonStartedAt });
    const ownRunning = await secondStore.create(requirementInput());
    await secondStore.update(ownRunning.id, { state: "running" });

    const result = await secondStore.markInterruptedOnStartup();

    expect(new Set(result.interrupted)).toEqual(new Set([running.id, paused.id]));

    for (const id of [running.id, paused.id]) {
      const got = await secondStore.get(id);
      expect(got.ok).toBe(true);
      if (got.ok) {
        expect(got.run.state).toBe("interrupted");
        expect(got.run.stateReason).toContain("守护进程");
      }
    }

    const completedAfter = await secondStore.get(completedRun.id);
    expect(completedAfter.ok).toBe(true);
    if (completedAfter.ok) expect(completedAfter.run.state).toBe("completed");

    const ownAfter = await secondStore.get(ownRunning.id);
    expect(ownAfter.ok).toBe(true);
    if (ownAfter.ok) expect(ownAfter.run.state).toBe("running");
  });
});

describe("isTerminalState", () => {
  test("completed / failed / stopped 是终态", () => {
    expect(isTerminalState("completed")).toBe(true);
    expect(isTerminalState("failed")).toBe(true);
    expect(isTerminalState("stopped")).toBe(true);
  });

  test("queued / running / interrupted 不是终态", () => {
    expect(isTerminalState("queued")).toBe(false);
    expect(isTerminalState("running")).toBe(false);
    expect(isTerminalState("interrupted")).toBe(false);
  });
});

describe("assertTransition", () => {
  test.each([
    ["queued", "running"],
    ["running", "pausing"],
    ["pausing", "paused"],
    ["running", "paused"],
    ["paused", "running"],
    ["running", "completed"],
    ["interrupted", "running"],
  ])("合法转换 %s→%s 不抛出", (from, to) => {
    expect(() => assertTransition(from as never, to as never)).not.toThrow();
  });

  test.each([
    ["completed", "running"],
    ["stopped", "paused"],
    ["queued", "paused"],
    ["completed", "failed"],
    ["interrupted", "interrupted"],
    ["pausing", "running"],
    ["paused", "pausing"],
    ["failed", "running"],
    ["stopped", "running"],
  ])("非法转换 %s→%s 抛出含'不允许'的错误", (from, to) => {
    expect(() => assertTransition(from as never, to as never)).toThrow("不允许");
  });

  test.each([
    ["queued", "stopped"],
    ["running", "stopped"],
    ["pausing", "stopped"],
    ["paused", "stopped"],
    ["interrupted", "stopped"],
    ["queued", "failed"],
    ["pausing", "failed"],
    ["interrupted", "failed"],
  ])("任何非终态 %s→%s 均允许", (from, to) => {
    expect(() => assertTransition(from as never, to as never)).not.toThrow();
  });

  test("stopped 之后任何转换均被拒绝", () => {
    expect(() => assertTransition("stopped", "running")).toThrow("不允许");
    expect(() => assertTransition("stopped", "stopped")).toThrow("不允许");
  });

  test("以字符串 uncertain 构造来源或目标调用均抛出'不允许的状态转换'", () => {
    const uncertain: string = "uncertain";
    expect(() => assertTransition(uncertain as RunState, "running")).toThrow("不允许的状态转换");
    expect(() => assertTransition("running", uncertain as RunState)).toThrow("不允许的状态转换");
  });
});

describe("assertTransition：paused/pausing 可直接结算", () => {
  test.each([
    ["paused", "completed"],
    ["pausing", "completed"],
  ])("%s→%s 不抛出（无需先经 running 中转）", (from, to) => {
    expect(() => assertTransition(from as never, to as never)).not.toThrow();
  });
});

describe("RunStore.markInterruptedOnStartup 幂等", () => {
  test("已标记的记录不会被后续新守护进程实例重复标记，daemonStartedAt 更新为标记时的实例值", async () => {
    const { dataRoot, repoId, daemonStartedAt: firstDaemonStartedAt } = await makeStore();
    const firstStore = new RunStore({ dataRoot, repoId, daemonStartedAt: firstDaemonStartedAt });
    const running = await firstStore.create(requirementInput());
    await firstStore.update(running.id, { state: "running" });

    const secondDaemonStartedAt = new Date(Date.now() + 1000).toISOString();
    const secondStore = new RunStore({ dataRoot, repoId, daemonStartedAt: secondDaemonStartedAt });
    const firstMark = await secondStore.markInterruptedOnStartup();
    expect(firstMark.interrupted).toEqual([running.id]);

    const afterFirstMark = await secondStore.get(running.id);
    expect(afterFirstMark.ok).toBe(true);
    if (!afterFirstMark.ok) return;
    expect(afterFirstMark.run.state).toBe("interrupted");
    expect(afterFirstMark.run.daemonStartedAt).toBe(secondDaemonStartedAt);
    expect(afterFirstMark.run.endedAt).toBeUndefined();

    const thirdDaemonStartedAt = new Date(Date.now() + 2000).toISOString();
    const thirdStore = new RunStore({ dataRoot, repoId, daemonStartedAt: thirdDaemonStartedAt });
    const secondMark = await thirdStore.markInterruptedOnStartup();
    expect(secondMark.interrupted).toEqual([]);

    const afterSecondMark = await thirdStore.get(running.id);
    expect(afterSecondMark.ok).toBe(true);
    if (!afterSecondMark.ok) return;
    expect(afterSecondMark.run.updatedAt).toBe(afterFirstMark.run.updatedAt);
    expect(afterSecondMark.run.stateReason).toBe(afterFirstMark.run.stateReason);
  });
});

describe("RunStore.markInterruptedOnStartup 部分失败", () => {
  test("单条记录损坏不阻断整轮标记，返回 failed 明细", async () => {
    const { store, dataRoot, repoId } = await makeStore();
    const running1 = await store.create(requirementInput());
    await store.update(running1.id, { state: "running" });
    const running2 = await store.create(requirementInput());
    await store.update(running2.id, { state: "running" });

    const corruptedPath = await statePath(dataRoot, repoId, running2.id);
    putRecord(corruptedPath, "损坏的运行记录");

    const newDaemonStartedAt = new Date(Date.now() + 1000).toISOString();
    const newStore = new RunStore({ dataRoot, repoId, daemonStartedAt: newDaemonStartedAt });

    let result: { interrupted: string[]; failed?: Array<{ id: string; reason: string }> } | undefined;
    let caught: unknown;
    try {
      result = await newStore.markInterruptedOnStartup();
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeUndefined();
    expect(result?.interrupted).toEqual([running1.id]);
    expect(result?.failed).toBeDefined();
    expect(result?.failed?.length).toBe(1);
    expect(result?.failed?.[0]?.id).toBe(running2.id);
    expect(result?.failed?.[0]?.reason.length).toBeGreaterThan(0);
  });
});

describe("RunStore.markInterruptedOnStartup 拒绝不完整记录", () => {
  test("缺失 daemonStartedAt 的记录报告损坏，不补造启动归属", async () => {
    const { store, dataRoot, repoId } = await makeStore();
    const created = await store.create(requirementInput());
    await store.update(created.id, { state: "running" });
    const path = await statePath(dataRoot, repoId, created.id);
    await overwriteStateFile(path, (data) => {
      delete data.daemonStartedAt;
    });

    const newStore = new RunStore({ dataRoot, repoId, daemonStartedAt: new Date(Date.now() + 1000).toISOString() });
    const result = await newStore.markInterruptedOnStartup();

    expect(result.interrupted).toEqual([]);
    expect(result.failed).toEqual([{ id: created.id, reason: "unreadable" }]);
    expect(await newStore.get(created.id)).toEqual({ ok: false, reason: "unreadable" });
  });
});

describe("RunStore.update 错误场景", () => {
  test("合法 UUID 但目录不存在时抛出含'运行不存在'的错误且不含绝对路径", async () => {
    const { store, dataRoot } = await makeStore();
    const missingId = uuidv7();

    let caught: unknown;
    try {
      await store.update(missingId, { state: "running" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).toContain("运行不存在");
    expect(message).not.toContain(dataRoot);
  });

  test("非 UUID 的 id 抛出含 UUIDv7 的错误", async () => {
    const { store } = await makeStore();

    let caught: unknown;
    try {
      await store.update("not-a-uuid", { state: "running" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("UUIDv7");
  });

  test("直接 update 到 interrupted 时抛出含'不允许'的错误", async () => {
    const { store } = await makeStore();
    const created = await store.create(requirementInput());
    await store.update(created.id, { state: "running" });

    let caught: unknown;
    try {
      await store.update(created.id, { state: "interrupted" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("不允许");
  });

  test("patch 中的 id/daemonStartedAt/startedAt/kind/requirement/未知键不生效", async () => {
    const { store } = await makeStore();
    const created = await store.create(requirementInput());

    await store.update(created.id, {
      id: "spoofed-id",
      daemonStartedAt: "spoofed-daemon",
      startedAt: "spoofed-started-at",
      kind: "role",
      requirement: "spoofed-requirement",
      bogus: "spoofed-bogus",
    } as never);

    const after = await store.get(created.id);
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(after.run.id).toBe(created.id);
    expect(after.run.daemonStartedAt).toBe(created.daemonStartedAt);
    expect(after.run.startedAt).toBe(created.startedAt);
    expect(after.run.kind).toBe(created.kind);
    expect(after.run.requirement).toBe(created.requirement);
    expect((after.run as Record<string, unknown>).bogus).toBeUndefined();
  });

  test("state 转 failed 时 stateReason 落盘且写入 endedAt", async () => {
    const { store, dataRoot, repoId } = await makeStore();
    const created = await store.create(requirementInput());
    await store.update(created.id, { state: "running" });

    const failed = await store.update(created.id, {
      state: "failed",
      stateReason: "模型异常退出",
    });

    expect(failed.state).toBe("failed");
    expect(failed.stateReason).toBe("模型异常退出");
    expect(isValidUtcTimestamp(failed.endedAt)).toBe(true);
  });

  test("进入 stopped 写入 endedAt", async () => {
    const { store } = await makeStore();
    const created = await store.create(requirementInput());
    await store.update(created.id, { state: "running" });
    const stopped = await store.update(created.id, { state: "stopped" });

    expect(stopped.state).toBe("stopped");
    expect(isValidUtcTimestamp(stopped.endedAt)).toBe(true);
  });
});

describe("RunStore.get 非 UUID 场景", () => {
  test("非 UUID 的 id 返回 not_found 而非 unreadable", async () => {
    const { store } = await makeStore();
    const result = await store.get("not-a-uuid");
    expect(result).toEqual({ ok: false, reason: "not_found" });
  });
});

describe("RunStore.list 排序与容错", () => {
  test("相同 startedAt 的记录按 id 升序稳定排序", async () => {
    const { store, dataRoot, repoId } = await makeStore();
    const a = await store.create(requirementInput());
    const b = await store.create(requirementInput());
    const c = await store.create(requirementInput());
    const tiedStartedAt = "2026-01-01T00:00:00.000Z";
    for (const run of [a, b, c]) {
      const path = await statePath(dataRoot, repoId, run.id);
      await overwriteStateFile(path, (data) => {
        data.startedAt = tiedStartedAt;
      });
    }
    const expectedOrder = [a.id, b.id, c.id].sort();

    for (let i = 0; i < 10; i += 1) {
      const { items } = await store.list({ limit: 100 });
      expect(items.map((item) => item.id)).toEqual(expectedOrder);
    }
  });

  test("损坏的运行记录阻止列表返回成功，修好后列出全部运行", async () => {
    const { store, dataRoot, repoId } = await makeStore();
    const valid = await store.create(requirementInput());
    const corrupted = await store.create(requirementInput());
    const corruptedPath = await statePath(dataRoot, repoId, corrupted.id);
    putRecord(corruptedPath, "损坏的运行记录");

    await expect(store.list({ limit: 100 })).rejects.toThrow(corrupted.id);
    putRecord(corruptedPath, corrupted);
    const { items, total } = await store.list({ limit: 100 });
    expect(items.map((item) => item.id).sort()).toEqual([valid.id, corrupted.id].sort());
    expect(total).toBe(2);
  });
});

describe("RunStore.create 落盘内容", () => {
  test("data.db 里的运行记录包含 create 输入的全部字段", async () => {
    const { store, dataRoot, repoId } = await makeStore();
    const parent = await store.create(requirementInput());
    const input = roleInput(parent.id, {
      writePaths: ["/tmp/a"],
      readPaths: ["/tmp/b"],
      mcp: ["server-a"],
    });
    const created = await store.create(input);
    const raw = recordJson(await statePath(dataRoot, repoId, created.id));
    const parsed = JSON.parse(raw) as { version: number; data: Record<string, unknown> };

    expect(parsed.data.mcp).toEqual(input.mcp);
    expect(parsed.data.thinking).toBe(input.thinking);
    expect(parsed.data.writePaths).toEqual(input.writePaths);
    expect(parsed.data.readPaths).toEqual(input.readPaths);
    expect(parsed.data.parentRunId).toBe(input.parentRunId);
    expect(parsed.data.model).toEqual(input.model);
    expect(parsed.data.task).toBe(input.task);
    expect(parsed.data.cwd).toBe(input.cwd);
  });
});

describe("RunStore.create shellToken", () => {
  test("生成 UUIDv4 的 shellToken 并落盘，get 读回一致", async () => {
    const { store, dataRoot, repoId } = await makeStore();
    const created = await store.create(requirementInput());

    expect(UUID_V4.test((created).shellToken)).toBe(true);

    const raw = recordJson(await statePath(dataRoot, repoId, created.id));
    const parsed = JSON.parse(raw) as { data: Record<string, unknown> };
    expect(parsed.data.shellToken).toBe((created).shellToken);

    const got = await store.get(created.id);
    expect(got.ok).toBe(true);
    if (got.ok) {
      expect((got.run).shellToken).toBe(
        (created).shellToken,
      );
    }
  });

  test("shellToken 与运行 id 不同", async () => {
    const { store } = await makeStore();
    const created = await store.create(requirementInput());
    const shellToken = (created).shellToken;
    expect(UUID_V4.test(shellToken)).toBe(true);
    expect(shellToken).not.toBe(created.id);
  });

  test("50 个并发创建的 shellToken 互不相同且各自与本运行 id 不同", async () => {
    const { store } = await makeStore();
    const runs = await Promise.all(Array.from({ length: 50 }, () => store.create(requirementInput())));
    const shellTokens = runs.map((run) => (run).shellToken);

    expect(new Set(shellTokens).size).toBe(50);
    for (let i = 0; i < runs.length; i += 1) {
      expect(UUID_V4.test(shellTokens[i]!)).toBe(true);
      expect(shellTokens[i]).not.toBe(runs[i]!.id);
    }
  });
});

describe("RunStore.update 拒绝改写 shellToken", () => {
  test("patch 携带 shellToken 时抛出含'不允许'或'不可改写'的错误，且文件内容不变", async () => {
    const { store, dataRoot, repoId } = await makeStore();
    const created = await store.create(requirementInput());
    const path = await statePath(dataRoot, repoId, created.id);
    const before = recordJson(path);

    let caught: unknown;
    try {
      await store.update(created.id, { shellToken: randomUUID() } as never);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message.includes("不允许") || message.includes("不可改写")).toBe(true);

    const after = recordJson(path);
    expect(after).toBe(before);
  });

  test("其他合法字段的 update 不改变 shellToken", async () => {
    const { store } = await makeStore();
    const created = await store.create(requirementInput());
    const originalShellToken = (created).shellToken;
    expect(UUID_V4.test(originalShellToken)).toBe(true);
    const updated = await store.update(created.id, { state: "running" });

    expect((updated).shellToken).toBe(originalShellToken);
  });
});

describe("RunStore.markInterruptedOnStartup 后 shellToken 不变", () => {
  test("守护进程重启标记 interrupted 后 shellToken 保持不变", async () => {
    const { dataRoot, repoId, daemonStartedAt: firstDaemonStartedAt } = await makeStore();
    const firstStore = new RunStore({ dataRoot, repoId, daemonStartedAt: firstDaemonStartedAt });
    const running = await firstStore.create(requirementInput());
    await firstStore.update(running.id, { state: "running" });
    const originalShellToken = (running).shellToken;
    expect(UUID_V4.test(originalShellToken)).toBe(true);

    const secondDaemonStartedAt = new Date(Date.now() + 1000).toISOString();
    const secondStore = new RunStore({ dataRoot, repoId, daemonStartedAt: secondDaemonStartedAt });
    await secondStore.markInterruptedOnStartup();

    const after = await secondStore.get(running.id);
    expect(after.ok).toBe(true);
    if (after.ok) {
      expect(after.run.state).toBe("interrupted");
      expect((after.run).shellToken).toBe(originalShellToken);
    }
  });
});

describe("启动标记的临界区与现场保留", () => {
  test("已有 stateReason 的记录标记中断后原因保留", async () => {
    const home = await createTempHome();
    tempHomes.push(home);
    const first = new RunStore({ dataRoot: home.dataRoot, repoId: testRepoId("r"), daemonStartedAt: "2026-09-09T00:00:00.000Z" });
    const run = await first.create({ kind: "requirement", requirement: uuidv7(), task: "t", cwd: "/tmp", writePaths: [], readPaths: [], model: { provider: "p", id: "m" }, thinking: "high", mcp: [] });
    await first.update(run.id, { state: "running" });
    await first.update(run.id, { state: "paused", stateReason: "连接中断" });
    const second = new RunStore({ dataRoot: home.dataRoot, repoId: testRepoId("r"), daemonStartedAt: "2026-09-09T01:00:00.000Z" });
    await second.markInterruptedOnStartup();
    const read = await second.get(run.id);
    expect(read.ok && read.run.state).toBe("interrupted");
    expect(read.ok && read.run.stateReason).toBe("连接中断");
  });

  test("守卫读取后记录变为终态则不再被标记", async () => {
    const home = await createTempHome();
    tempHomes.push(home);
    const first = new RunStore({ dataRoot: home.dataRoot, repoId: testRepoId("r"), daemonStartedAt: "2026-09-09T00:00:00.000Z" });
    const run = await first.create({ kind: "requirement", requirement: uuidv7(), task: "t", cwd: "/tmp", writePaths: [], readPaths: [], model: { provider: "p", id: "m" }, thinking: "high", mcp: [] });
    await first.update(run.id, { state: "running" });
    const second = new RunStore({ dataRoot: home.dataRoot, repoId: testRepoId("r"), daemonStartedAt: "2026-09-09T01:00:00.000Z" });
    const originalGet = second.get.bind(second);
    (second as unknown as { get: typeof originalGet }).get = async (id: string) => {
      const result = await originalGet(id);
      await first.update(run.id, { state: "completed" });
      return result;
    };
    const marked = await second.markInterruptedOnStartup();
    expect(marked.interrupted).toEqual([]);
    const read = await originalGet(run.id);
    expect(read.ok && read.run.state).toBe("completed");
  });
});


describe("运行记录内容损坏", () => {
  test.each(["state", "model", "writePaths", "id"])("损坏 %s 不冒充合法记录且不允许列表判定安全", async (field) => {
    const { store, dataRoot, repoId } = await makeStore();
    const run = await store.create(requirementInput());
    await overwriteStateFile(await statePath(dataRoot, repoId, run.id), (data) => { data[field] = null; });
    expect(await store.get(run.id)).toEqual({ ok: false, reason: "unreadable" });
    await expect(store.list({ limit: 100 })).rejects.toThrow(run.id);
    await expect(store.update(run.id, { state: "running" })).rejects.toThrow();
  });
});
