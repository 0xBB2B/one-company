import { describe, expect, test } from "bun:test";
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
    task: "/workspace/.bb-spec/docs/plan/2026-09-09.demo/tasks/01-demo-task.md",
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
    },
    widgetCalls,
    notifyCalls,
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

    const mountedPanel = fakeUi.mountedComponent() as { handleInput(data: string): unknown } | undefined;
    expect(mountedPanel).toBeDefined();
    mountedPanel?.handleInput("\r");

    timeSource.advance(30_000);
    timeSource.advance(1_000);

    expect((capturedActivity as AgentsActivity).notice()?.message).toContain("未确认");
  }, 1_000);
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
