import { afterEach, describe, expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import { createClock } from "../src/core/policy/clock.ts";
import type { TimeSource } from "../src/core/policy/clock.ts";
import { ShellRegistry } from "../src/core/host/shell-registry.ts";
import type { Host } from "../src/core/host/shell-registry.ts";
import {
  formatShellSummary,
  publishShellStatus,
  startShellStatusRefresh,
  summarizeShells,
} from "../src/modules/shell/shell-summary.ts";
import type { ShellSummaryRepo, ShellStatusBar } from "../src/modules/shell/shell-summary.ts";

const MAIN_HOST: Host = { kind: "main", id: "main" };

const spawnedPgids: number[] = [];

afterEach(() => {
  for (const pgid of spawnedPgids.splice(0)) {
    try {
      process.kill(-pgid, "SIGKILL");
    } catch {
      // 组已消失，无需处理
    }
  }
});

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitFor(predicate: () => boolean, timeoutMs: number, intervalMs = 40): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleepMs(intervalMs);
  }
  if (!predicate()) throw new Error(`waitFor 超时（${timeoutMs}ms）`);
}

async function spawnBackgroundWithDescendants(registry: ShellRegistry): Promise<string> {
  const taskId = randomUUID();
  const result = await registry.spawn({
    taskId,
    host: MAIN_HOST,
    command: "sh",
    args: ["-c", "sleep 30 & sleep 30 & wait"],
    mode: "background",
    runToken: randomUUID(),
  });
  if (!result.ok) throw new Error(`测试环境启动失败：${result.reason}`);
  spawnedPgids.push(result.task.pgid);
  await sleepMs(150);
  return taskId;
}

function roleHost(role: string, runId = randomUUID()): Host {
  return { kind: "role", id: `req-${role}`, role, runId };
}

function fakeRepo(repoId: string, respond: (method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>, name = repoId): ShellSummaryRepo & { callCount: number } {
  const repo = {
    repoId,
    name,
    callCount: 0,
    client: {
      call: async (method: string, params?: Record<string, unknown>) => {
        repo.callCount += 1;
        return respond(method, params);
      },
    },
  };
  return repo;
}

function resolvedRepo(repoId: string, tasks: Record<string, unknown>[], name = repoId): ShellSummaryRepo & { callCount: number } {
  return fakeRepo(repoId, async () => ({ tasks }), name);
}

function rejectingRepo(repoId: string, message: string, name = repoId): ShellSummaryRepo & { callCount: number } {
  return fakeRepo(repoId, async () => {
    throw new Error(message);
  }, name);
}

function fakeStatusBar(): ShellStatusBar & { calls: (string | undefined)[] } {
  const calls: (string | undefined)[] = [];
  return {
    calls,
    setStatus(text: string | undefined) {
      calls.push(text);
    },
  };
}

function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason?: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface FakeTimeSource extends TimeSource {
  advance(ms: number): void;
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

  return { now: () => current, setTimeout: setTimeoutFake, clearTimeout: clearTimeoutFake, advance };
}

describe("summarizeShells / formatShellSummary：待确认不计入总数与角色数", () => {
  test("本窗口主 agent + 两守护进程各一个 worker（一个待确认）→ shell：2 · 主 agent：1 · worker：1，待确认另列为 1", async () => {
    const registry = new ShellRegistry({ clock: createClock() });
    await spawnBackgroundWithDescendants(registry);

    const repoA = resolvedRepo("repo-a", [
      { taskId: randomUUID(), host: roleHost("worker"), activity: "active", inWorkspace: true },
    ]);
    const repoB = resolvedRepo("repo-b", [
      { taskId: randomUUID(), host: roleHost("worker"), activity: "uncertain", inWorkspace: true },
    ]);

    const summary = await summarizeShells({ registry, repos: [repoA, repoB] });

    expect(summary.total).toBe(2);
    expect(summary.uncertain).toBe(1);
    const byLabel = Object.fromEntries(summary.groups.map((g) => [g.label, g.count]));
    expect(byLabel["主 agent"]).toBe(1);
    expect(byLabel["worker"]).toBe(1);

    const text = formatShellSummary(summary);
    expect(text).toContain("shell：2 · 主 agent：1 · worker：1");
    expect(text).toContain("待确认：1");
    expect(text).not.toContain("不确定");
  });

  test("仅本窗口一个待确认任务：不计入总数与角色分组，只体现在待确认计数里", async () => {
    let baselineTaken = false;
    const registry = new ShellRegistry({
      clock: createClock(),
      probes: {
        pidStartedAt: async () => {
          if (!baselineTaken) {
            baselineTaken = true;
            return 1_000_000;
          }
          return 1_000_000 + 999_999;
        },
      },
    });
    const taskId = randomUUID();
    const started = await registry.spawn({
      taskId,
      host: MAIN_HOST,
      command: "sh",
      args: ["-c", "sleep 30"],
      mode: "background",
      runToken: randomUUID(),
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    spawnedPgids.push(started.task.pgid);
    await waitFor(() => registry.get(taskId)?.status === "uncertain", 5_000);

    const summary = await summarizeShells({ registry, repos: [] });
    expect(summary.total).toBe(0);
    expect(summary.uncertain).toBe(1);
    expect(summary.groups).toEqual([]);

    const text = formatShellSummary(summary);
    expect(text).not.toContain("主 agent");
    expect(text).toContain("待确认：1");
    expect(text).not.toContain("不确定");
  }, 10_000);
});

describe("summarizeShells / formatShellSummary：边界与错误场景", () => {
  test("无任何活动且无错误时总数为零，格式化结果被清空为 undefined", async () => {
    const registry = new ShellRegistry({ clock: createClock() });
    const summary = await summarizeShells({ registry, repos: [] });
    expect(summary.total).toBe(0);
    expect(summary.errors).toEqual([]);
    expect(formatShellSummary(summary)).toBeUndefined();
  });

  test("仓库读取失败：显示具体错误（含项目目录名归属）而非把总数呈现为零", async () => {
    const registry = new ShellRegistry({ clock: createClock() });
    const repo = rejectingRepo("repo-broken", "守护进程连接超时（测试注入）");

    const summary = await summarizeShells({ registry, repos: [repo] });
    expect(summary.total).toBe(0);
    expect(summary.errors.length).toBe(1);
    expect(summary.errors[0]).toContain("守护进程连接超时（测试注入）");
    expect(summary.errors[0]).toContain("repo-broken");

    const text = formatShellSummary(summary);
    expect(text).toBeDefined();
    expect(text).toContain("守护进程连接超时（测试注入）");
    expect(text).not.toContain("shell：0");
  });
});

describe("summarizeShells：多仓库场景下错误带仓库归属", () => {
  test("仓库读取失败：错误行以项目目录名开头，不含 64 位仓库编号", async () => {
    const registry = new ShellRegistry({ clock: createClock() });
    const repoId = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";
    const repo = rejectingRepo(repoId, "守护进程连接超时（测试注入）", "企微BOT");

    const summary = await summarizeShells({ registry, repos: [repo] });
    expect(summary.errors.length).toBe(1);
    expect(summary.errors[0].startsWith("企微BOT：")).toBe(true);
    expect(summary.errors[0]).toContain("守护进程连接超时（测试注入）");
    expect(summary.errors[0]).not.toContain(repoId);
    expect(formatShellSummary(summary)).not.toContain(repoId);
  });

  test("两个仓库，其一读取失败：错误文本可按 name 区分是哪个仓库失败，另一仓库计数正常汇总", async () => {
    const registry = new ShellRegistry({ clock: createClock() });
    const okRepo = resolvedRepo("id-healthy", [
      { taskId: randomUUID(), host: roleHost("worker"), activity: "active", inWorkspace: true },
    ], "repo-healthy");
    const brokenRepo = rejectingRepo("id-unreachable", "连接被拒绝（测试注入）", "repo-unreachable");

    const summary = await summarizeShells({ registry, repos: [okRepo, brokenRepo] });
    expect(summary.total).toBe(1);
    expect(summary.errors.length).toBe(1);
    expect(summary.errors[0]).toContain("repo-unreachable");
    expect(summary.errors[0]).not.toContain("repo-healthy");
  });
});

describe("formatShellSummary：净化控制字符与换行，单行输出并按码点截断", () => {
  test("错误消息含 ESC 序列与 CRLF 时，格式化文本不含原始控制字符但保留可读内容", async () => {
    const registry = new ShellRegistry({ clock: createClock() });
    const repo = rejectingRepo("repo-dirty", "连接失败\x1b[31m红色\x1b[0m\r\n第二行");

    const summary = await summarizeShells({ registry, repos: [repo] });
    const text = formatShellSummary(summary) ?? "";
    expect(text).not.toContain("\x1b");
    expect(text).not.toContain("\r");
    expect(text).not.toContain("\n");
    expect(text).toContain("连接失败");
    expect(text).toContain("第二行");
  });

  test("角色名含控制字符时分组标签不原样带入状态栏文本", async () => {
    const registry = new ShellRegistry({ clock: createClock() });
    const repo = resolvedRepo("repo-role", [
      { taskId: randomUUID(), host: roleHost("wor\x1bker"), activity: "active", inWorkspace: true },
    ]);

    const summary = await summarizeShells({ registry, repos: [repo] });
    const text = formatShellSummary(summary) ?? "";
    expect(text).not.toContain("\x1b");
  });

  test("超长错误消息被按码点截断到与中继同源的上限（8000），而非按显示宽度截断，且结果仍是单行", async () => {
    const registry = new ShellRegistry({ clock: createClock() });
    const longError = "错".repeat(10_000);
    const repo = rejectingRepo("repo-long", longError);

    const summary = await summarizeShells({ registry, repos: [repo] });
    const text = formatShellSummary(summary) ?? "";
    expect(text).not.toContain("\n");
    expect(Array.from(text).length).toBeLessThanOrEqual(8_000);
    expect(Array.from(text).length).toBeLessThan(Array.from(longError).length);
  });
});

describe("publishShellStatus", () => {
  test("有活动时状态栏收到格式化后的文本；无活动无错误时状态栏收到清空调用", async () => {
    const registryWithActivity = new ShellRegistry({ clock: createClock() });
    await spawnBackgroundWithDescendants(registryWithActivity);
    const statusBarActive = fakeStatusBar();

    await publishShellStatus({ registry: registryWithActivity, repos: [], clock: createClock(), statusBar: statusBarActive });
    expect(statusBarActive.calls.length).toBe(1);
    expect(statusBarActive.calls[0]).toContain("主 agent：1");

    const emptyRegistry = new ShellRegistry({ clock: createClock() });
    const statusBarEmpty = fakeStatusBar();
    await publishShellStatus({ registry: emptyRegistry, repos: [], clock: createClock(), statusBar: statusBarEmpty });
    expect(statusBarEmpty.calls).toEqual([undefined]);
  });

  test("只调用 statusBar.setStatus，从不调用其他宿主 UI 能力（如 setWidget/custom/onTerminalInput）", async () => {
    const registry = new ShellRegistry({ clock: createClock() });
    await spawnBackgroundWithDescendants(registry);
    const calls: string[] = [];
    const recordingUi = {
      setStatus: (text: string | undefined) => calls.push(`setStatus:${text ?? ""}`),
      setWidget: () => calls.push("setWidget"),
      custom: () => calls.push("custom"),
      onTerminalInput: () => calls.push("onTerminalInput"),
    };

    await publishShellStatus({ registry, repos: [], clock: createClock(), statusBar: recordingUi });

    expect(calls.length).toBe(1);
    expect(calls[0]?.startsWith("setStatus:")).toBe(true);
  });
});

describe("startShellStatusRefresh：周期刷新去重与总数稳定", () => {
  test("按固定周期重复调用，且总数在每次刷新之间保持一致；停止后不再收到调用", async () => {
    const registry = new ShellRegistry({ clock: createClock() });
    await spawnBackgroundWithDescendants(registry);

    const timeSource = createFakeTimeSource();
    const clock = createClock({ timeSource });
    const statusBar = fakeStatusBar();

    const stop = startShellStatusRefresh({ registry, repos: [], clock, statusBar }, 1_000);

    timeSource.advance(1_000);
    await flushMicrotasks();
    timeSource.advance(1_000);
    await flushMicrotasks();
    timeSource.advance(1_000);
    await flushMicrotasks();

    expect(statusBar.calls.length).toBeGreaterThanOrEqual(3);
    for (const text of statusBar.calls) expect(text).toContain("主 agent：1");

    stop();
    const callsBeforeMoreTime = statusBar.calls.length;
    timeSource.advance(5_000);
    await flushMicrotasks();
    expect(statusBar.calls.length).toBe(callsBeforeMoreTime);

    clock.stopGapWatcher();
  });

  test("上一轮 summarizeShells 未完成时跳过本轮，不堆积并发调用；完成后恢复正常节奏", async () => {
    const registry = new ShellRegistry({ clock: createClock() });
    const timeSource = createFakeTimeSource();
    const clock = createClock({ timeSource });
    const statusBar = fakeStatusBar();
    const deferred = createDeferred<Record<string, unknown>>();
    let callCount = 0;
    const hangingRepo: ShellSummaryRepo = {
      repoId: "repo-hanging",
      client: { call: async () => { callCount += 1; return deferred.promise; } },
    };

    const stop = startShellStatusRefresh({ registry, repos: [hangingRepo], clock, statusBar }, 1_000);

    timeSource.advance(1_000);
    await flushMicrotasks();
    timeSource.advance(1_000);
    await flushMicrotasks();
    timeSource.advance(1_000);
    await flushMicrotasks();

    expect(callCount).toBe(1);

    deferred.resolve({ tasks: [] });
    await flushMicrotasks();
    timeSource.advance(1_000);
    await flushMicrotasks();

    expect(callCount).toBe(2);

    stop();
    clock.stopGapWatcher();
  });
});
