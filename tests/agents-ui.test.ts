import { describe, expect, onTestFinished, test } from "vitest";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { RunManager } from "../daemon/run-manager.ts";
import { RelayQueue } from "../daemon/relay-queue.ts";
import { ShellRegistry } from "../runtime/shell-registry.ts";
import { RunStore } from "../runtime/run-store.ts";
import { NetworkPauseGate } from "../runtime/network-pause.ts";
import { repositoryDatabase, uuidv7, withDatabase } from "../runtime/database.ts";
import { createDaemonFixture, removeDaemonFixture } from "./helpers/daemon-harness.ts";
import type { AgentsPanel } from "../runtime/agents-panel.ts";
import { createClock } from "../runtime/clock.ts";
import type { TimeSource } from "../runtime/clock.ts";
import { AgentsActivity } from "../runtime/agents-activity.ts";
import { createFakePi } from "./helpers/fake-pi.ts";
import agentsUiExtension from "../extensions/agents-ui.ts";
import type { AgentsUiDeps } from "../extensions/agents-ui.ts";

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

type RunLike = Record<string, unknown>;

const REPO_A = { repoId: "repo-a-id" };

function runFixture(overrides: RunLike = {}): RunLike {
  const startedAt = (overrides.startedAt as string) ?? new Date(0).toISOString();
  return {
    id: "run-default",
    shellToken: "shell-default",
    kind: "requirement",
    requirement: "2026-09-09.demo",
    task: "/workspace/private/task-record.txt",
    cwd: "/workspace/repo-a",
    writePaths: [],
    readPaths: [],
    model: { provider: "anthropic", id: "claude-test" },
    thinking: "high",
    mcp: [],
    state: "running",
    turns: 0,
    errorDetails: { status: "none" },
    daemonStartedAt: new Date(0).toISOString(),
    startedAt,
    updatedAt: startedAt,
    ...overrides,
  };
}

function pushRun(activity: AgentsActivity, repoId: string, run: RunLike, meta: { requirementTitle?: string } = {}): void {
  activity.applyRunsChanged(repoId, { run, ...meta } as never);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function flushMicrotasks(): Promise<void> {
  return delay(0);
}

// 只用来证明"处理器没有卡在 await windowReady()"——deferred 不会自己超时兑现，
// 若实现误 await 了就绪，trigger() 永远不会先于超时分支完成
async function resolvesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  const timedOut = Symbol("timed-out");
  const result = await Promise.race([promise, delay(ms).then(() => timedOut)]);
  return result !== timedOut;
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

function createPollableClient(initialStatus: "connected" | "unreachable" = "connected") {
  let status: "connected" | "unreachable" = initialStatus;
  return {
    call: async () => ({}),
    subscribe: () => () => {},
    state: () => ({ status }),
    close: () => {},
    setStatus: (next: "connected" | "unreachable") => {
      status = next;
    },
  };
}

interface FakeRepoClient {
  call: (method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>;
  subscribe: () => () => void;
  state: () => { status: "connected" | "unreachable"; reason?: string };
  close: () => void;
}

function createWindowContextValue(repoId: string, repoPath: string, client: FakeRepoClient) {
  return {
    windowId: "window-1",
    sessionId: "session-1",
    workspace: { repos: [{ repoId, path: repoPath, commonDir: `${repoPath}/.git` }], skipped: [] },
    clients: {
      forRepo: (id: string) => (id === repoId ? client : undefined),
      all: () => [client],
      skipped: () => [],
      closeAll: () => {},
    },
  };
}

function createFakeUi() {
  const widgetCalls: { key: string; content: unknown; options?: { placement?: string } }[] = [];
  const notifyCalls: { message: string; level?: string }[] = [];
  const customCalls: { options?: Record<string, unknown> }[] = [];
  let activeSubscriptions = 0;
  let requestRenderCalls = 0;
  let mountedComponent: unknown;
  const fakeTui = {
    requestRender: () => {
      requestRenderCalls++;
    },
  };
  return {
    ui: {
      setWidget: (key: string, content: unknown, options?: { placement?: string }) => {
        widgetCalls.push({ key, content, options });
        if (typeof content !== "function") {
          mountedComponent = undefined;
          return;
        }
        // 真实宿主拿到工厂后会立即渲染首帧；refreshLoop 若要复用同一个 tui.requestRender、以及测试要拿到面板实例调用
        // handleInput，都必须在这一刻已经能构造出组件
        try {
          mountedComponent = (content as (tui: unknown, theme: unknown) => unknown)(fakeTui, {});
        } catch {}
      },
      onTerminalInput: (_handler: (data: string) => unknown) => {
        activeSubscriptions++;
        return () => {
          activeSubscriptions--;
        };
      },
      notify: (message: string, level?: string) => notifyCalls.push({ message, level }),
      getEditorText: () => "",
      custom: async (_factory: unknown, options?: Record<string, unknown>) => {
        customCalls.push({ options });
        throw new Error("代理面板不得打开旧正文查看页");
      },
    },
    widgetCalls,
    notifyCalls,
    customCalls,
    activeSubscriptions: () => activeSubscriptions,
    requestRenderCalls: () => requestRenderCalls,
    mountedComponent: () => mountedComponent,
  };
}

function createFakeCtx(fakeUi: ReturnType<typeof createFakeUi>, overrides: { mode?: string; hasUI?: boolean } = {}) {
  return {
    mode: overrides.mode ?? "tui",
    hasUI: overrides.hasUI ?? true,
    cwd: "/workspace",
    sessionManager: { getSessionId: () => "session-1" },
    ui: fakeUi.ui,
    shutdown: () => {},
  };
}

describe("实际后端停止与覆盖联动", () => {
  test("旧 stopped 活进程不自动停止；实际 EPERM 回执未确认，用户重试真实停止后才确认", async () => {
    const fixture = await createDaemonFixture();
    onTestFinished(() => removeDaemonFixture(fixture));
    const database = repositoryDatabase(fixture.dataRoot, fixture.repoId);
    const clock = createClock();
    let denied = true;
    const shells = new ShellRegistry({ database, clock, probes: {
      ps: async () => [],
      kill: (pid, signal) => { if (denied) throw Object.assign(new Error("EPERM"), { code: "EPERM" }); process.kill(pid, signal); },
    } });
    const runs = new RunStore({ dataRoot: fixture.dataRoot, repoId: fixture.repoId, daemonStartedAt: new Date().toISOString() });
    const run = await runs.create({ kind: "role", standalone: true, role: "pi-company.worker", task: "T-1", requirement: "2026-09-08.ui-safety", cwd: fixture.repo.root, writePaths: [], readPaths: [], model: { provider: "test", id: "unused" }, thinking: "off", mcp: [] });
    const relay = new RelayQueue({ dataDir: join(fixture.dataRoot, "repos", fixture.repoId), deliver: async () => [], locateRequirementAgent: () => undefined });
    const manager = new RunManager({ dataRoot: fixture.dataRoot, repoId: fixture.repoId, runStore: runs, shellRegistry: shells, clock, relayQueue: relay,
      networkGate: new NetworkPauseGate(), roleCatalog: [], runtime: {} as never, selectModel: () => { throw new Error("不得调用模型"); }, workspaceRepoIds: [fixture.repoId], emit: () => {} });
    manager.markStarted();
    const fakePi = createFakePi();
    const fakeUi = createFakeUi();
    const ctx = createFakeCtx(fakeUi);
    const taskId = uuidv7();
    let pid: number | undefined;
    const calls: string[] = [];
    const receipts: Array<Awaited<ReturnType<RunManager["stop"]>>> = [];
    let pending: Promise<unknown> = Promise.resolve();
    const client = { ...createPollableClient(), call: async (method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> => {
      calls.push(method);
      if (method === "subscribe.activity") { const page = await manager.list({ limit: 100 }); return { snapshot: page.items, coverage: page.coverage }; }
      if (method === "runs.stop") { const request = manager.stop(params!.runId as string); pending = request; const result = await request; receipts.push(result); return result; }
      throw new Error("非安全入口");
    } };
    try {
      const spawned = await shells.spawn({ taskId, host: { kind: "role", id: run.id, runId: run.id, role: run.role }, command: process.execPath, args: ["-e", "setInterval(()=>{},1000)"], cwd: fixture.repo.root, mode: "background", runToken: run.shellToken });
      if (!spawned.ok) throw new Error(spawned.reason);
      pid = spawned.task.pid;
      withDatabase(database, (db) => {
        const current = db.read<any>("runs", run.id)!;
        db.update("runs", run.id, current.version, { ...current.data, state: "stopped" });
        for (let i = 0; i < 105; i++) { const id = uuidv7(); db.create("runs", id, { ...run, id, state: "stopped", startedAt: new Date(0).toISOString() }, id); }
      });
      agentsUiExtension(fakePi.pi, { windowReady: () => Promise.resolve(createWindowContextValue(fixture.repoId, fixture.repo.root, client)) as never,
        createClock: () => createClock({ timeSource: createFakeTimeSource() }) });
      await fakePi.trigger("session_start", { type: "session_start", reason: "new" }, ctx);
      await flushMicrotasks();
      const panel = fakeUi.mountedComponent() as AgentsPanel;
      panel.selectRun(run.id);
      expect(calls).toEqual(["subscribe.activity"]);
      expect(() => process.kill(pid!, 0)).not.toThrow();
      expect(panel.render(300).join("\n")).toContain("停止未核实106");
      expect(panel.render(300).join("\n")).toContain("截断");
      expect(panel.render(300).join("\n")).not.toContain("已停止");
      panel.handleInput("\r"); await pending; await flushMicrotasks();
      expect(receipts[0]?.confirmed).toBe(false);
      expect(panel.render(300).join("\n")).toContain("停止未确认");
      expect(() => process.kill(pid!, 0)).not.toThrow();
      denied = false;
      panel.handleInput("\r"); await pending; await flushMicrotasks();
      expect(receipts[1]?.confirmed).toBe(true);
      expect(() => process.kill(pid!, 0)).toThrow();
      expect(panel.render(300).join("\n")).toContain("本次停止已确认");
      expect(calls).toEqual(["subscribe.activity", "runs.stop", "runs.stop"]);
      expect(fakeUi.customCalls).toHaveLength(0);
    } finally {
      denied = false;
      await pending;
      await fakePi.trigger("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);
      if (pid !== undefined) { await shells.stop(taskId); expect(() => process.kill(pid!, 0)).toThrow(); }
      clock.stopGapWatcher();
    }
  }, 20_000);
});

describe("有界快照覆盖", () => {
  test("截断空页仍展示未展示、未知和未核实停止项，不可误报无运行", async () => {
    const fakePi = createFakePi();
    const calls: string[] = [];
    const client = { ...createPollableClient(), call: async (method: string) => {
      calls.push(method);
      return { snapshot: [], coverage: { total: 2001, validated: 2000, returned: 0, offset: 0, remaining: 2000, unknown: 1, unconfirmed: 2001, unconfirmedOutsidePage: 2001, nextOffset: 0, truncated: true, byteLimit: 16384 } };
    } };
    agentsUiExtension(fakePi.pi, {
      windowReady: () => Promise.resolve(createWindowContextValue(REPO_A.repoId, "/workspace/repo-a", client)) as never,
      createClock: () => createClock({ timeSource: createFakeTimeSource() }),
    });
    const fakeUi = createFakeUi();
    const ctx = createFakeCtx(fakeUi);
    await fakePi.trigger("session_start", { type: "session_start", reason: "new" }, ctx);
    await flushMicrotasks();
    const panel = fakeUi.mountedComponent() as { render(width: number): string[] };
    const output = panel.render(300).join("\n");
    expect(output).toContain("repo-a");
    expect(output).toContain("未展示2000");
    expect(output).toContain("未知1");
    expect(output).toContain("停止未核实2001");
    expect(output).not.toMatch(/没有运行|无运行|无活动/);
    expect(calls).toEqual(["subscribe.activity"]);
    await fakePi.trigger("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);
  });
});

describe("session_start 不阻塞等待窗口就绪，就绪后完成挂载", () => {
  test("lifecycle 尚未兑现时处理器已返回；兑现后 setWidget 被调用且 placement 为 belowEditor", async () => {
    const fakePi = createFakePi();
    const deferred = createDeferred<ReturnType<typeof createWindowContextValue>>();
    const deps: AgentsUiDeps = {
      windowReady: () => deferred.promise as never,
      createClock: () => createClock({ timeSource: createFakeTimeSource() }),
    };
    agentsUiExtension(fakePi.pi, deps);

    const fakeUi = createFakeUi();
    const ctx = createFakeCtx(fakeUi);

    const triggerPromise = fakePi.trigger("session_start", { type: "session_start", reason: "new" }, ctx);
    const returnedInTime = await resolvesWithin(triggerPromise, 50);
    expect(returnedInTime).toBe(true);
    expect(fakeUi.widgetCalls).toHaveLength(0);

    deferred.resolve(createWindowContextValue(REPO_A.repoId, "/workspace/repo-a", createPollableClient()));
    await flushMicrotasks();

    expect(fakeUi.widgetCalls).toHaveLength(1);
    expect(fakeUi.widgetCalls[0]?.options?.placement).toBe("belowEditor");
  });
});

describe("refreshLoop 轮询 client.state() 并写入连接状态", () => {
  test("客户端变为 unreachable 后，对应仓库条目在 rows() 中标记为不可达", async () => {
    const fakePi = createFakePi();
    const timeSource = createFakeTimeSource();
    const clock = createClock({ timeSource });
    let capturedActivity: AgentsActivity | undefined;
    const client = createPollableClient("connected");
    const windowContextValue = createWindowContextValue(REPO_A.repoId, "/workspace/repo-a", client);

    const deps: AgentsUiDeps = {
      windowReady: () => Promise.resolve(windowContextValue) as never,
      createClock: () => clock,
      createAgentsActivity: (options: never) => {
        capturedActivity = new AgentsActivity(options);
        return capturedActivity;
      },
    };
    agentsUiExtension(fakePi.pi, deps);

    const fakeUi = createFakeUi();
    const ctx = createFakeCtx(fakeUi);
    await fakePi.trigger("session_start", { type: "session_start", reason: "new" }, ctx);
    await flushMicrotasks();
    expect(capturedActivity).toBeDefined();

    pushRun(capturedActivity as AgentsActivity, REPO_A.repoId, runFixture({ id: "run-poll", state: "running" }), {
      requirementTitle: "轮询需求",
    });
    expect((capturedActivity as AgentsActivity).rows().find((row) => row.id === "run-poll")?.unreachable).toBe(false);

    client.setStatus("unreachable");
    timeSource.advance(1_000);

    expect((capturedActivity as AgentsActivity).rows().find((row) => row.id === "run-poll")?.unreachable).toBe(true);
  }, 1_000);

  test("每次刷新 tick 都经宿主 tui.requestRender() 重绘", async () => {
    const fakePi = createFakePi();
    const timeSource = createFakeTimeSource();
    const clock = createClock({ timeSource });
    const client = createPollableClient("connected");
    const windowContextValue = createWindowContextValue(REPO_A.repoId, "/workspace/repo-a", client);
    const deps: AgentsUiDeps = {
      windowReady: () => Promise.resolve(windowContextValue) as never,
      createClock: () => clock,
    };
    agentsUiExtension(fakePi.pi, deps);

    const fakeUi = createFakeUi();
    const ctx = createFakeCtx(fakeUi);
    await fakePi.trigger("session_start", { type: "session_start", reason: "new" }, ctx);
    await flushMicrotasks();

    const callsBeforeTick = fakeUi.requestRenderCalls();
    timeSource.advance(1_000);

    expect(fakeUi.requestRenderCalls()).toBeGreaterThan(callsBeforeTick);
  }, 1_000);

  test("刷新 tick 会调用 panel.tick()：Enter 后推进 30 秒在途到期 + 一次刷新 tick，未确认提示出现", async () => {
    const fakePi = createFakePi();
    const timeSource = createFakeTimeSource();
    const clock = createClock({ timeSource });
    let capturedActivity: AgentsActivity | undefined;
    const neverRespondingClient: FakeRepoClient = {
      call: () => new Promise(() => {}),
      subscribe: () => () => {},
      state: () => ({ status: "connected" }),
      close: () => {},
    };
    const windowContextValue = createWindowContextValue(REPO_A.repoId, "/workspace/repo-a", neverRespondingClient);
    const deps: AgentsUiDeps = {
      windowReady: () => Promise.resolve(windowContextValue) as never,
      createClock: () => clock,
      createAgentsActivity: (options: never) => {
        capturedActivity = new AgentsActivity(options);
        return capturedActivity;
      },
    };
    agentsUiExtension(fakePi.pi, deps);

    const fakeUi = createFakeUi();
    const ctx = createFakeCtx(fakeUi);
    await fakePi.trigger("session_start", { type: "session_start", reason: "new" }, ctx);
    await flushMicrotasks();
    expect(capturedActivity).toBeDefined();

    pushRun(capturedActivity as AgentsActivity, REPO_A.repoId, runFixture({ id: "run-tick", state: "running" }), {
      requirementTitle: "刷新需求",
    });

    const mountedPanel = fakeUi.mountedComponent() as { handleInput(data: string): unknown; render(width: number): string[] } | undefined;
    expect(mountedPanel).toBeDefined();
    mountedPanel?.render(80);
    mountedPanel?.handleInput("\r");

    timeSource.advance(30_000);
    timeSource.advance(1_000);

    expect((capturedActivity as AgentsActivity).notice()?.message).toContain("未确认");
  }, 1_000);
});

describe("扩展快照代次与 activity 仓库归属", () => {
  test("两个仓库同 runId 的活动由订阅闭包绑定 repoId，不串到另一个仓库", async () => {
    const fakePi = createFakePi();
    let capturedActivity: AgentsActivity | undefined;
    const handlers = new Map<string, Map<string, (data: unknown) => void>>();
    const makeClient = (repoId: string): FakeRepoClient => ({
      call: async () => ({ snapshot: [], coverage: { total: 0, returned: 0, remaining: 0, unknown: 0, unconfirmed: 0, truncated: false } }),
      subscribe: ((method: string, handler: (data: unknown) => void) => {
        const byMethod = handlers.get(repoId) ?? new Map<string, (data: unknown) => void>();
        byMethod.set(method, handler);
        handlers.set(repoId, byMethod);
        return () => byMethod.delete(method);
      }) as never,
      state: () => ({ status: "connected" }),
      close: () => {},
    });
    const clients = new Map([[REPO_A.repoId, makeClient(REPO_A.repoId)], ["repo-b-id", makeClient("repo-b-id")]]);
    const windowValue = {
      windowId: "window-1",
      sessionId: "session-1",
      workspace: { repos: [
        { repoId: REPO_A.repoId, path: "/workspace/repo-a", commonDir: "/workspace/repo-a/.git" },
        { repoId: "repo-b-id", path: "/workspace/repo-b", commonDir: "/workspace/repo-b/.git" },
      ], skipped: [] },
      clients: {
        forRepo: (repoId: string) => clients.get(repoId),
        all: () => [...clients.values()],
        skipped: () => [],
        closeAll: () => {},
      },
    };
    agentsUiExtension(fakePi.pi, {
      windowReady: () => Promise.resolve(windowValue) as never,
      createClock: () => createClock({ timeSource: createFakeTimeSource() }),
      createAgentsActivity: (options: never) => (capturedActivity = new AgentsActivity(options)),
    });
    const fakeUi = createFakeUi();
    const ctx = createFakeCtx(fakeUi);
    await fakePi.trigger("session_start", { type: "session_start", reason: "new" }, ctx);
    await flushMicrotasks();

    for (const repoId of [REPO_A.repoId, "repo-b-id"]) {
      handlers.get(repoId)?.get("runs.changed")?.({ run: runFixture({ id: "same", state: "running" }), requirementTitle: repoId });
    }
    handlers.get(REPO_A.repoId)?.get("activity")?.({ runId: "same", kind: "tool_start", toolName: "edit", toolCallId: "call-a", at: new Date(0).toISOString() });
    const rows = capturedActivity!.rows().filter((row) => row.id === "same");
    expect(rows.find((row) => row.repoId === REPO_A.repoId)?.activity).toBe("edit");
    expect(rows.find((row) => row.repoId === "repo-b-id")?.activity).toBe("");
    await fakePi.trigger("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);
  });

  test("事件与初始 snapshot 交错时旧响应不覆盖；断连重连会重新取快照后才恢复 fresh", async () => {
    const fakePi = createFakePi();
    const timeSource = createFakeTimeSource();
    const first = createDeferred<Record<string, unknown>>();
    const second = createDeferred<Record<string, unknown>>();
    const calls: string[] = [];
    let status: "connected" | "unreachable" = "connected";
    let runsChanged: ((data: unknown) => void) | undefined;
    let capturedActivity: AgentsActivity | undefined;
    const client: FakeRepoClient = {
      call: (method: string) => {
        calls.push(method);
        return (calls.length === 1 ? first.promise : second.promise);
      },
      subscribe: ((method: string, handler: (data: unknown) => void) => {
        if (method === "runs.changed") runsChanged = handler;
        return () => {};
      }) as never,
      state: () => ({ status }),
      close: () => {},
    };
    agentsUiExtension(fakePi.pi, {
      windowReady: () => Promise.resolve(createWindowContextValue(REPO_A.repoId, "/workspace/repo-a", client)) as never,
      createClock: () => createClock({ timeSource }),
      createAgentsActivity: (options: never) => (capturedActivity = new AgentsActivity(options)),
    });
    const fakeUi = createFakeUi();
    const ctx = createFakeCtx(fakeUi);
    await fakePi.trigger("session_start", { type: "session_start", reason: "new" }, ctx);
    await flushMicrotasks();

    runsChanged?.({ run: runFixture({ id: "event-wins", state: "running" }), requirementTitle: "实时事件" });
    first.resolve({ snapshot: [runFixture({ id: "stale-snapshot", state: "running" })], coverage: { total: 0, returned: 0, remaining: 0, unknown: 0, unconfirmed: 0, truncated: false } });
    await flushMicrotasks();
    expect(capturedActivity!.rows().map((row) => row.id)).toEqual(["event-wins"]);
    expect(capturedActivity!.coverageNotices().join("\n")).toContain("快照过期");

    status = "unreachable";
    timeSource.advance(1_000);
    expect(capturedActivity!.coverageNotices().join("\n")).toContain("不可达");
    status = "connected";
    timeSource.advance(1_000);
    expect(calls).toEqual(["subscribe.activity", "subscribe.activity"]);
    expect(capturedActivity!.coverageNotices().join("\n")).toContain("快照刷新中");
    second.resolve({ snapshot: [], coverage: { total: 0, returned: 0, remaining: 0, unknown: 0, unconfirmed: 0, truncated: false } });
    await flushMicrotasks();
    expect(capturedActivity!.rows()).toHaveLength(0);
    expect(capturedActivity!.coverageNotices().join("\n")).toContain("当前快照");
    await fakePi.trigger("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);
  });
});

test.each([100, 101, 200, 201])("真实快照入口%s项：最多检查200项，超限事实与Shell元数据保留", async (count) => {
  const fakePi = createFakePi(), timeSource = createFakeTimeSource();
  const snapshot = Array.from({ length: count }, (_, i) => ({ ...runFixture({ id: `budget-${i}` }), activeShellTasks: i === 0 ? 7 : 0, pendingShellCleanup: i === 0 ? 9 : 0 }));
  let capturedActivity: AgentsActivity | undefined, outsideReads = 0;
  const descriptor = Object.getOwnPropertyDescriptor;
  const client: FakeRepoClient = {
    call: async () => ({ snapshot, coverage: { total: count, returned: count, remaining: 0, unknown: 0, unconfirmed: count, truncated: false } }),
    subscribe: (() => () => {}) as never, state: () => ({ status: "connected" }), close: () => {},
  };
  agentsUiExtension(fakePi.pi, {
    windowReady: () => Promise.resolve(createWindowContextValue(REPO_A.repoId, "/workspace/repo-a", client)) as never,
    createClock: () => createClock({ timeSource }),
    createAgentsActivity: (options: never) => (capturedActivity = new AgentsActivity(options)),
  });
  const ctx = createFakeCtx(createFakeUi());
  try {
    Object.getOwnPropertyDescriptor = (object, property) => {
      if (count > 200 && object === snapshot[200]) outsideReads++;
      return descriptor(object, property);
    };
    await fakePi.trigger("session_start", { type: "session_start", reason: "new" }, ctx);
    await flushMicrotasks();
    expect(outsideReads).toBe(0);
    expect(capturedActivity!.rows()).toHaveLength(100);
    expect(capturedActivity!.rows()[0]).toMatchObject({ activeShellTasks: 7, pendingShellCleanup: 9 });
    if (count > 200) expect(capturedActivity!.coverageNotices().join("\n")).toContain("未展示待清理");
    if (count > 100) expect(capturedActivity!.coverageNotices().join("\n")).toContain("溢出");
  } finally {
    Object.getOwnPropertyDescriptor = descriptor;
    await fakePi.trigger("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);
  }
});

describe("第二次 session_start 先卸载前一次残留", () => {
  test("onTerminalInput 订阅数不因第二次 session_start 增长", async () => {
    const fakePi = createFakePi();
    const client = createPollableClient();
    const windowContextValue = createWindowContextValue(REPO_A.repoId, "/workspace/repo-a", client);
    const deps: AgentsUiDeps = {
      windowReady: () => Promise.resolve(windowContextValue) as never,
      createClock: () => createClock({ timeSource: createFakeTimeSource() }),
    };
    agentsUiExtension(fakePi.pi, deps);

    const fakeUi = createFakeUi();
    const ctx = createFakeCtx(fakeUi);

    await fakePi.trigger("session_start", { type: "session_start", reason: "new" }, ctx);
    await flushMicrotasks();
    expect(fakeUi.activeSubscriptions()).toBe(1);

    await fakePi.trigger("session_start", { type: "session_start", reason: "new" }, ctx);
    await flushMicrotasks();
    expect(fakeUi.activeSubscriptions()).toBe(1);
  }, 1_000);
});

describe("session_shutdown 卸载面板并取消订阅", () => {
  test("挂载后触发 session_shutdown，setWidget 收到 undefined 且订阅数归零", async () => {
    const fakePi = createFakePi();
    const client = createPollableClient();
    const windowContextValue = createWindowContextValue(REPO_A.repoId, "/workspace/repo-a", client);
    const deps: AgentsUiDeps = {
      windowReady: () => Promise.resolve(windowContextValue) as never,
      createClock: () => createClock({ timeSource: createFakeTimeSource() }),
    };
    agentsUiExtension(fakePi.pi, deps);

    const fakeUi = createFakeUi();
    const ctx = createFakeCtx(fakeUi);
    await fakePi.trigger("session_start", { type: "session_start", reason: "new" }, ctx);
    await flushMicrotasks();
    expect(fakeUi.widgetCalls).toHaveLength(1);
    expect(fakeUi.activeSubscriptions()).toBe(1);

    await fakePi.trigger("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);

    expect(fakeUi.widgetCalls.at(-1)?.content).toBeUndefined();
    expect(fakeUi.activeSubscriptions()).toBe(0);
  }, 1_000);

  test("session_shutdown 早于 windowReady 兑现时，兑现后不再挂载", async () => {
    const fakePi = createFakePi();
    const deferred = createDeferred<ReturnType<typeof createWindowContextValue>>();
    const deps: AgentsUiDeps = {
      windowReady: () => deferred.promise as never,
      createClock: () => createClock({ timeSource: createFakeTimeSource() }),
    };
    agentsUiExtension(fakePi.pi, deps);

    const fakeUi = createFakeUi();
    const ctx = createFakeCtx(fakeUi);
    await fakePi.trigger("session_start", { type: "session_start", reason: "new" }, ctx);
    await fakePi.trigger("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);

    deferred.resolve(createWindowContextValue(REPO_A.repoId, "/workspace/repo-a", createPollableClient()));
    await flushMicrotasks();

    expect(fakeUi.widgetCalls).toHaveLength(0);
  }, 1_000);

  test("session_shutdown 早于 windowReady 才拒绝时，不再调用 notify（generation 保护）", async () => {
    const fakePi = createFakePi();
    const deferred = createDeferred<never>();
    deferred.promise.catch(() => {});
    const deps: AgentsUiDeps = {
      windowReady: () => deferred.promise,
      createClock: () => createClock({ timeSource: createFakeTimeSource() }),
    };
    agentsUiExtension(fakePi.pi, deps);

    const fakeUi = createFakeUi();
    const ctx = createFakeCtx(fakeUi);
    await fakePi.trigger("session_start", { type: "session_start", reason: "new" }, ctx);
    await fakePi.trigger("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);

    deferred.reject(new Error("窗口就绪失败（测试注入）"));
    await flushMicrotasks();

    expect(fakeUi.notifyCalls).toHaveLength(0);
  }, 1_000);
});

describe("未知外部错误净化", () => {
  test("windowReady 拒绝未知对象时不执行对象转换，只通知固定兜底", async () => {
    const fakePi = createFakePi();
    agentsUiExtension(fakePi.pi, {
      windowReady: () => Promise.reject({ toString: () => { throw new Error("不得执行"); } }) as never,
      createClock: () => createClock({ timeSource: createFakeTimeSource() }),
    });
    const fakeUi = createFakeUi();
    const ctx = createFakeCtx(fakeUi);
    await fakePi.trigger("session_start", { type: "session_start", reason: "new" }, ctx);
    await flushMicrotasks();
    expect(fakeUi.notifyCalls).toEqual([{ message: "未知错误", level: "error" }]);
  });
});

describe("非 tui 模式不挂载", () => {
  test("mode 不为 tui 时，即便 windowReady 兑现也不调用 setWidget", async () => {
    const fakePi = createFakePi();
    const client = createPollableClient();
    const windowContextValue = createWindowContextValue(REPO_A.repoId, "/workspace/repo-a", client);
    const deps: AgentsUiDeps = {
      windowReady: () => Promise.resolve(windowContextValue) as never,
      createClock: () => createClock({ timeSource: createFakeTimeSource() }),
    };
    agentsUiExtension(fakePi.pi, deps);

    const fakeUi = createFakeUi();
    const ctx = createFakeCtx(fakeUi, { mode: "print", hasUI: false });
    await fakePi.trigger("session_start", { type: "session_start", reason: "new" }, ctx);
    await flushMicrotasks();

    expect(fakeUi.widgetCalls).toHaveLength(0);
  });
});

describe("终态运行不能打开旧转录", () => {
  test("旧查看位置的键盘操作不打开 custom、不订阅转录，旧正文不读取", async () => {
    const fakePi = createFakePi();
    let capturedActivity: AgentsActivity | undefined;
    const calls: string[] = [];
    const client = { ...createPollableClient(), call: async (method: string) => { calls.push(method); return {}; } };
    const windowContextValue = createWindowContextValue(REPO_A.repoId, "/workspace/repo-a", client);
    agentsUiExtension(fakePi.pi, {
      windowReady: () => Promise.resolve(windowContextValue) as never,
      createClock: () => createClock({ timeSource: createFakeTimeSource() }),
      createAgentsActivity: (options) => (capturedActivity = new AgentsActivity(options)),
    });
    const fakeUi = createFakeUi();
    const ctx = createFakeCtx(fakeUi);
    await fakePi.trigger("session_start", { type: "session_start", reason: "new" }, ctx);
    await flushMicrotasks();
    const run = runFixture({ id: randomUUID(), state: "completed" });
    let bodyReads = 0;
    for (const field of ["task", "taskDescription", "stateReason", "errorDetails", "transcript", "actor"]) {
      Object.defineProperty(run, field, { get: () => { bodyReads++; throw new Error("旧正文不可读取"); } });
    }
    pushRun(capturedActivity!, REPO_A.repoId, run);
    const panel = fakeUi.mountedComponent() as { handleInput(data: string): unknown; render(width: number): string[] };
    for (const key of ["\x1b[C", "\r", "\t", "\r", "\x1b[D", "\r"]) {
      panel.handleInput(key);
      if (key !== "\r") panel.render(100);
    }
    await flushMicrotasks();
    expect(calls).toEqual(["subscribe.activity", "runs.stop"]);
    expect(fakeUi.customCalls).toHaveLength(0);
    expect(fakeUi.notifyCalls).toHaveLength(0);
    expect(panel.render(100).join("\n")).toContain("非需求完成");
    expect(bodyReads).toBe(0);
    await fakePi.trigger("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);
  }, 1_000);
});

describe("退出及重载不恢复旧查看入口", () => {
  test("旧终态会话跨两次挂载仍无转录 RPC，卸载后订阅与定时器收尾", async () => {
    const fakePi = createFakePi();
    let capturedActivity: AgentsActivity | undefined;
    const client = createPollableClient();
    const windowContextValue = createWindowContextValue(REPO_A.repoId, "/workspace/repo-a", client);
    const deps: AgentsUiDeps = {
      windowReady: () => Promise.resolve(windowContextValue) as never,
      createClock: () => createClock({ timeSource: createFakeTimeSource() }),
      createAgentsActivity: (options: never) => {
        capturedActivity = new AgentsActivity(options);
        return capturedActivity;
      },
    };
    agentsUiExtension(fakePi.pi, deps);

    const fakeUi = createFakeUi();
    const ctx = createFakeCtx(fakeUi);
    await fakePi.trigger("session_start", { type: "session_start", reason: "new" }, ctx);
    await flushMicrotasks();
    expect(capturedActivity).toBeDefined();

    const viewRunId = randomUUID();
    const calls: string[] = [];
    client.call = async (method: string) => { calls.push(method); return {}; };
    for (let i = 0; i < 2; i++) {
      if (i > 0) {
        await fakePi.trigger("session_start", { type: "session_start", reason: "new" }, ctx);
        await flushMicrotasks();
      }
      pushRun(capturedActivity!, REPO_A.repoId, runFixture({ id: viewRunId, state: "stopped" }));
      const panel = fakeUi.mountedComponent() as { handleInput(data: string): unknown; render(width: number): string[] };
      panel.handleInput("\x1b[C");
      panel.render(100);
      panel.handleInput("\r");
      await flushMicrotasks();
      expect(fakeUi.customCalls).toHaveLength(0);
      await fakePi.trigger("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);
      expect(fakeUi.activeSubscriptions()).toBe(0);
      expect(fakeUi.mountedComponent()).toBeUndefined();
    }
    expect(calls).toEqual(["runs.stop", "subscribe.activity", "runs.stop"]);
  }, 2_000);
});
