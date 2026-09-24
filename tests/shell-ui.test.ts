import { describe, expect, test, vi } from "vitest";
import * as decisions from "../runtime/decisions.ts";
import { randomUUID } from "node:crypto";
import { createClock } from "../runtime/clock.ts";
import type { Clock, TimeSource } from "../runtime/clock.ts";
import { ShellRegistry } from "../runtime/shell-registry.ts";
import { createFakePi } from "./helpers/fake-pi.ts";
import installShellUi, { openShellUiPage } from "../extensions/shell-ui.ts";
import type { ShellUiDeps } from "../extensions/shell-ui.ts";
import pmPanelExtension from "../extensions/pm-panel.ts";
import type { PmPanelUiDeps } from "../extensions/pm-panel.ts";
import { currentDock } from "../extensions/lifecycle.ts";

function shellUiExtension(pi: Parameters<typeof installShellUi>[0], deps: ShellUiDeps = {}) {
  installShellUi(pi, { commandGuard: async () => ({ before: async () => undefined, after: async () => [] }), ...deps });
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function flushMicrotasks(): Promise<void> {
  return delay(0);
}

async function waitFor(check: () => boolean, timeoutMs = 3_000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error("等待条件超时");
    await delay(20);
  }
}

// 只用来证明处理器没有卡在 await windowReady()——deferred 不会自己超时兑现，
// 若实现误 await 了就绪，trigger() 永远不会先于超时分支完成
async function resolvesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  const timedOut = Symbol("timed-out");
  const result = await Promise.race([promise, delay(ms).then(() => timedOut)]);
  return result !== timedOut;
}

function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

interface FakeRepoClient {
  call: (method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>;
  subscribe: () => () => void;
  state: () => { status: "connected" | "unreachable" };
  close: () => void;
  connectionIdentity?: () => { daemonInstanceId: string; connectionId: string; connectionSequence: number } | null;
}

function createPollableClient(): FakeRepoClient {
  const connectionId = randomUUID();
  return {
    connectionIdentity: () => ({ daemonInstanceId: "fixture", connectionId, connectionSequence: 1 }),
    call: async () => ({ tasks: [] }),
    subscribe: () => () => {},
    state: () => ({ status: "connected" }),
    close: () => {},
  };
}

function createWindowContextValue(windowId: string, repoId: string, client: FakeRepoClient) {
  return {
    windowId,
    sessionId: `session-${windowId}`,
    workspace: { repos: [{ repoId, path: `/workspace/${repoId}`, commonDir: `/workspace/${repoId}/.git` }], skipped: [] },
    clients: {
      forRepo: (id: string) => (id === repoId ? client : undefined),
      all: () => [client],
      skipped: () => [],
      closeAll: () => {},
    },
  };
}

function createFakeUi() {
  const statusCalls: { key: string; text: string | undefined }[] = [];
  const notifyCalls: { message: string; level?: string }[] = [];
  return {
    ui: {
      setStatus: (key: string, text: string | undefined) => statusCalls.push({ key, text }),
      notify: (message: string, level?: string) => notifyCalls.push({ message, level }),
      getEditorText: () => "",
      custom: () => Promise.reject(new Error("本测试未使用 custom")),
    },
    statusCalls,
    notifyCalls,
  };
}

function createFakeCtx(fakeUi: ReturnType<typeof createFakeUi>, overrides: { mode?: string; hasUI?: boolean; cwd?: string } = {}) {
  return {
    mode: overrides.mode ?? "tui",
    hasUI: overrides.hasUI ?? true,
    cwd: overrides.cwd ?? process.cwd(),
    ui: fakeUi.ui,
  };
}

function spyClock(inner: Clock): Clock & { stopGapWatcherCalls: () => number } {
  let stopCalls = 0;
  return {
    ...inner,
    stopGapWatcher: () => {
      stopCalls += 1;
      inner.stopGapWatcher();
    },
    stopGapWatcherCalls: () => stopCalls,
  };
}

function spyRegistry(registry: ShellRegistry): ShellRegistry & { closeOwnerCalls: () => number } {
  const original = registry.closeOwner.bind(registry);
  let calls = 0;
  registry.closeOwner = (host) => {
    calls += 1;
    return original(host);
  };
  return Object.assign(registry, { closeOwnerCalls: () => calls });
}

test("windowReady异常通知净化控制字符，失败启动释放自身clock", async () => {
  const fakePi = createFakePi(), ui = createFakeUi(), clock = spyClock(createClock({ timeSource: createFakeTimeSource() }));
  shellUiExtension(fakePi.pi, { windowReady: async () => { throw new Error("连接\x1b[2J\n错误"); }, createClock: () => clock });
  const ctx = createFakeCtx(ui);
  await fakePi.trigger("session_start", { reason: "new" }, ctx); await flushMicrotasks();
  expect(ui.notifyCalls).toHaveLength(1);
  expect(ui.notifyCalls[0]!.message).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
  expect(clock.stopGapWatcherCalls()).toBeGreaterThan(0);
  await fakePi.trigger("session_shutdown", { reason: "quit" }, ctx);
});

describe("shellUiExtension：注册与生命周期解耦——工厂返回时已完成注册，session_start 不重复注册", () => {
  test("factory 返回后 registerTool('bash') 与 on('user_bash') 各恰好一次；两次 session_start 后计数不变", async () => {
    const fakePi = createFakePi();
    const deps: ShellUiDeps = {
      windowReady: () => new Promise(() => {}),
      createClock: () => createClock({ timeSource: createFakeTimeSource() }),
      createShellRegistry: (clock) => new ShellRegistry({ clock }),
    };

    shellUiExtension(fakePi.pi, deps);

    expect(fakePi.registeredTools().map((t) => t.name)).toEqual(["bash"]);
    expect(fakePi.handlerCount("user_bash")).toBe(1);

    const fakeUi = createFakeUi();
    const ctx = createFakeCtx(fakeUi);
    await fakePi.trigger("session_start", { type: "session_start", reason: "new" }, ctx);
    await fakePi.trigger("session_start", { type: "session_start", reason: "new" }, ctx);

    expect(fakePi.registeredTools().length).toBe(1);
    expect(fakePi.handlerCount("user_bash")).toBe(1);
  });
});

describe("shellUiExtension：无交互 UI 时 bash 能力仍可用", () => {
  test("ctx.hasUI=false 的会话下，user_bash 仍能登记并真实执行命令", async () => {
    const fakePi = createFakePi();
    const client = createPollableClient();
    const windowContextValue = createWindowContextValue("window-headless", "repo-headless", client);
    const deps: ShellUiDeps = {
      windowReady: () => Promise.resolve(windowContextValue) as never,
      createClock: () => createClock({ timeSource: createFakeTimeSource() }),
      createShellRegistry: (clock) => new ShellRegistry({ clock }),
    };
    shellUiExtension(fakePi.pi, deps);

    const fakeUi = createFakeUi();
    const ctx = createFakeCtx(fakeUi, { hasUI: false, mode: "print" });
    await fakePi.trigger("session_start", { type: "session_start", reason: "new" }, ctx);
    await flushMicrotasks();

    const results = await fakePi.trigger(
      "user_bash",
      { command: "echo headless-bash-marker", cwd: process.cwd(), excludeFromContext: false },
      ctx,
    );
    const handled = results[0] as { operations?: { exec: (cmd: string, cwd: string, opts: Record<string, unknown>) => Promise<{ exitCode: number }> } };
    expect(handled?.operations).toBeDefined();

    const chunks: string[] = [];
    const execResult = await handled.operations!.exec("echo headless-bash-marker", process.cwd(), {
      onData: (chunk: Buffer) => chunks.push(chunk.toString()),
    });
    expect(execResult.exitCode).toBe(0);
    expect(chunks.join("")).toContain("headless-bash-marker");

    // current 是模块级单例，测试结束前显式关闭本次会话，避免污染同文件内后续用例
    await fakePi.trigger("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);
  }, 10_000);
});

describe("shellUiExtension：session_start 内不 await windowReady", () => {
  test("windowReady 永不兑现时，session_start 处理器仍在有限时间内返回", async () => {
    const fakePi = createFakePi();
    const deferred = createDeferred<ReturnType<typeof createWindowContextValue>>();
    const deps: ShellUiDeps = {
      windowReady: () => deferred.promise as never,
      createClock: () => createClock({ timeSource: createFakeTimeSource() }),
      createShellRegistry: (clock) => new ShellRegistry({ clock }),
    };
    shellUiExtension(fakePi.pi, deps);

    const fakeUi = createFakeUi();
    const ctx = createFakeCtx(fakeUi);
    const triggerPromise = fakePi.trigger("session_start", { type: "session_start", reason: "new" }, ctx);

    expect(await resolvesWithin(triggerPromise, 50)).toBe(true);
  });
});

describe("shellUiExtension：session_shutdown 清理", () => {
  test("清空状态栏、停止刷新定时器、clock.stopGapWatcher 被调、当前会话注册表 closeOwner 被调", async () => {
    const fakePi = createFakePi();
    const client = createPollableClient();
    const windowContextValue = createWindowContextValue("window-a", "repo-a", client);
    const timeSource = createFakeTimeSource();
    let capturedRegistry: (ShellRegistry & { closeOwnerCalls: () => number }) | undefined;
    let capturedClock: (Clock & { stopGapWatcherCalls: () => number }) | undefined;
    const deps: ShellUiDeps = {
      windowReady: () => Promise.resolve(windowContextValue) as never,
      createClock: () => {
        capturedClock = spyClock(createClock({ timeSource }));
        return capturedClock;
      },
      createShellRegistry: (clock) => {
        capturedRegistry = spyRegistry(new ShellRegistry({ clock }));
        return capturedRegistry;
      },
    };
    shellUiExtension(fakePi.pi, deps);

    const fakeUi = createFakeUi();
    const ctx = createFakeCtx(fakeUi);
    await fakePi.trigger("session_start", { type: "session_start", reason: "new" }, ctx);
    await flushMicrotasks();

    timeSource.advance(1_000);
    await flushMicrotasks();
    expect(fakeUi.statusCalls.length).toBeGreaterThan(0);

    await fakePi.trigger("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);

    expect(fakeUi.statusCalls.at(-1)?.text).toBeUndefined();

    const callsBeforeMoreTime = fakeUi.statusCalls.length;
    timeSource.advance(5_000);
    await flushMicrotasks();
    expect(fakeUi.statusCalls.length).toBe(callsBeforeMoreTime);

    expect(capturedClock?.stopGapWatcherCalls()).toBeGreaterThan(0);
    expect(capturedRegistry?.closeOwnerCalls()).toBeGreaterThan(0);
  }, 10_000);
});

describe("shellUiExtension：两次 session_start 后注册表随会话切换", () => {
  test("user_bash 登记进新会话的注册表，旧 registry 不再收到新任务", async () => {
    const fakePi = createFakePi();
    const registries: ShellRegistry[] = [];
    const deps: ShellUiDeps = {
      windowReady: () => Promise.resolve(createWindowContextValue(`window-${registries.length}`, `repo-${registries.length}`, createPollableClient())) as never,
      createClock: () => createClock({ timeSource: createFakeTimeSource() }),
      createShellRegistry: (clock) => {
        const registry = new ShellRegistry({ clock });
        registries.push(registry);
        return registry;
      },
    };
    shellUiExtension(fakePi.pi, deps);

    const fakeUi = createFakeUi();
    const ctx = createFakeCtx(fakeUi);
    await fakePi.trigger("session_start", { type: "session_start", reason: "new" }, ctx);
    await flushMicrotasks();
    await fakePi.trigger("session_start", { type: "session_start", reason: "new" }, ctx);
    await flushMicrotasks();

    expect(registries.length).toBe(2);
    const [oldRegistry, newRegistry] = registries;

    const results = await fakePi.trigger(
      "user_bash",
      { command: "echo swap-marker", cwd: process.cwd(), excludeFromContext: false },
      ctx,
    );
    const handled = results[0] as { operations?: { exec: (cmd: string, cwd: string, opts: Record<string, unknown>) => Promise<{ exitCode: number }> } };
    const execPromise = handled.operations!.exec("echo swap-marker", process.cwd(), { onData: () => {} });
    await waitFor(() => (newRegistry?.list().length ?? 0) > 0, 3_000);

    expect(newRegistry?.list().length ?? 0).toBeGreaterThan(0);
    expect(oldRegistry?.list().length ?? 0).toBe(0);

    await execPromise;
    // current 是模块级单例，测试结束前显式关闭本次会话，避免污染同文件内后续用例
    await fakePi.trigger("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);
  }, 10_000);
});

describe("shellUiExtension：user_bash 未就绪时优雅降级", () => {
  test("窗口尚未就绪时触发 user_bash：不抛错，返回符合 SDK UserBashEventResult 的 result（未执行命令），且注册表未登记任何任务", async () => {
    const fakePi = createFakePi();
    let capturedRegistry: ShellRegistry | undefined;
    const deps: ShellUiDeps = {
      windowReady: () => new Promise(() => {}),
      createClock: () => createClock({ timeSource: createFakeTimeSource() }),
      createShellRegistry: (clock) => {
        capturedRegistry = new ShellRegistry({ clock });
        return capturedRegistry;
      },
    };
    shellUiExtension(fakePi.pi, deps);

    const fakeUi = createFakeUi();
    const ctx = createFakeCtx(fakeUi);

    let thrown: Error | undefined;
    let results: unknown[] | undefined;
    try {
      results = await fakePi.trigger(
        "user_bash",
        { command: "echo should-not-run", cwd: process.cwd(), excludeFromContext: false },
        ctx,
      );
    } catch (error) {
      thrown = error as Error;
    }

    expect(thrown).toBeUndefined();
    const handled = results?.[0] as { operations?: unknown; result?: { exitCode?: number; output?: string } } | undefined;
    expect(handled?.operations).toBeUndefined();
    expect(handled?.result?.exitCode).toBe(1);
    expect(typeof handled?.result?.output).toBe("string");
    expect((handled?.result?.output ?? "").length).toBeGreaterThan(0);
    expect(capturedRegistry?.list() ?? []).toEqual([]);
  });

  test("session_shutdown 后触发 user_bash：同样不抛错，返回符合 SDK UserBashEventResult 的 result，且注册表未登记任何任务", async () => {
    const fakePi = createFakePi();
    const client = createPollableClient();
    const windowContextValue = createWindowContextValue("window-shutdown", "repo-shutdown", client);
    let capturedRegistry: ShellRegistry | undefined;
    const deps: ShellUiDeps = {
      windowReady: () => Promise.resolve(windowContextValue) as never,
      createClock: () => createClock({ timeSource: createFakeTimeSource() }),
      createShellRegistry: (clock) => {
        capturedRegistry = new ShellRegistry({ clock });
        return capturedRegistry;
      },
    };
    shellUiExtension(fakePi.pi, deps);

    const fakeUi = createFakeUi();
    const ctx = createFakeCtx(fakeUi);
    await fakePi.trigger("session_start", { type: "session_start", reason: "new" }, ctx);
    await flushMicrotasks();
    await fakePi.trigger("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);

    let thrown: Error | undefined;
    let results: unknown[] | undefined;
    try {
      results = await fakePi.trigger(
        "user_bash",
        { command: "echo should-not-run", cwd: process.cwd(), excludeFromContext: false },
        ctx,
      );
    } catch (error) {
      thrown = error as Error;
    }

    expect(thrown).toBeUndefined();
    const handled = results?.[0] as { operations?: unknown; result?: { exitCode?: number; output?: string } } | undefined;
    expect(handled?.operations).toBeUndefined();
    expect(handled?.result?.exitCode).toBe(1);
    expect(typeof handled?.result?.output).toBe("string");
    expect((handled?.result?.output ?? "").length).toBeGreaterThan(0);
    expect(capturedRegistry?.list() ?? []).toEqual([]);
  });
});

describe("sharedDock 生命周期：PM 面板 teardown 后 lifecycle.currentDock() 应为 undefined", () => {
  test("session_shutdown 后 currentDock() 为 undefined；此时 openShellUiPage 报未就绪而非拿到已释放的旧 dock", async () => {
    const fakePi = createFakePi();
    const client = createPollableClient();
    const windowContextValue = createWindowContextValue("window-dock", "repo-dock", client);
    const timeSource = createFakeTimeSource();

    const panelDeps: PmPanelUiDeps = {
      windowReady: () => Promise.resolve(windowContextValue) as never,
      createClock: () => createClock({ timeSource }),
    };
    pmPanelExtension(fakePi.pi, panelDeps);

    const shellDeps: ShellUiDeps = {
      windowReady: () => Promise.resolve(windowContextValue) as never,
      createClock: () => createClock({ timeSource: createFakeTimeSource() }),
      createShellRegistry: (clock) => new ShellRegistry({ clock }),
    };
    shellUiExtension(fakePi.pi, shellDeps);

    const ui = {
      setWidget: (_key: string, _content: unknown, _options?: Record<string, unknown>) => {},
      onTerminalInput: (_handler: (data: string) => unknown) => () => {},
      notify: () => {},
      getEditorText: () => "",
      setStatus: () => {},
      custom: () => Promise.reject(new Error("本测试未使用 custom")),
    };
    const ctx = {
      mode: "tui",
      hasUI: true,
      cwd: process.cwd(),
      sessionManager: { getSessionId: () => "session-dock" },
      ui,
      shutdown: () => {},
    };

    await fakePi.trigger("session_start", { type: "session_start", reason: "new" }, ctx);
    await flushMicrotasks();
    expect(currentDock()).toBeDefined();

    await fakePi.trigger("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);
    await flushMicrotasks();

    expect(currentDock()).toBeUndefined();

    let thrown: Error | undefined;
    try {
      await openShellUiPage({ ui: { custom: () => Promise.reject(new Error("不应被调用")) } });
    } catch (error) {
      thrown = error as Error;
    }
    expect(thrown).toBeDefined();
  }, 10_000);
});

test("openShellUiPage 不提供人工 USER 裁定，不确定任务仅请求实际停止", async () => {
  const fakePi = createFakePi();
  const append = vi.spyOn(decisions, "appendDecision");
  const calls: { method: string; params?: Record<string, unknown> }[] = [];
  const task = { taskId: "ui-uncertain", host: { kind: "requirement", id: "req-ui" }, command: "", cwd: "", pid: 10, startedAt: new Date(0).toISOString(), status: "uncertain", activity: "uncertain", inWorkspace: true };
  const stopped = createDeferred<Record<string, unknown>>();
  const client = {
    ...createPollableClient(),
    call: async (method: string, params?: Record<string, unknown>) => {
      calls.push({ method, params });
      if (method === "shells.list") return { tasks: [task] };
      if (method === "shells.stop") return stopped.promise;
      if (method === "pm.overview") return { items: [] };
      throw new Error(`非白名单 RPC：${method}`);
    },
  };
  const window = createWindowContextValue("window-no-user", "repo-no-user", client);
  const deps = { windowReady: () => Promise.resolve(window) as never, createClock: () => createClock({ timeSource: createFakeTimeSource() }) };
  pmPanelExtension(fakePi.pi, deps);
  shellUiExtension(fakePi.pi, deps);
  const ctx = {
    mode: "tui", hasUI: true, cwd: process.cwd(),
    ui: { ...createFakeUi().ui, setWidget: () => {}, onTerminalInput: () => () => {} },
  };
  let page: import("../runtime/shell-page.ts").ShellPage | undefined;
  let opened: Promise<void> | undefined;
  try {
    await fakePi.trigger("session_start", { reason: "new" }, ctx);
    await flushMicrotasks();
    opened = openShellUiPage({ ui: { custom: (factory) => new Promise((resolve) => {
      page = factory({ requestRender: () => {} }, {}, {}, resolve);
    }) } });
    await waitFor(() => page !== undefined);
    await page!.refresh();
    page!.handleInput("K");
    expect(page!.render(100).join("\n")).toContain("停止尚未确认");
    expect(page!.render(100).join("\n")).not.toContain("视为已停止");
    page!.handleInput("\x1b[C");
    page!.handleInput("\r");
    expect(page!.render(100).join("\n")).toContain("停止中");
    expect(page!.render(100).join("\n")).not.toContain("已停止");
    expect(calls.filter((call) => call.method === "shells.stop")).toEqual([
      { method: "shells.stop", params: { taskId: task.taskId, expectedPid: task.pid, expectedStartedAt: task.startedAt } },
    ]);
    stopped.resolve({ task });
    await flushMicrotasks();
    expect(page!.render(100).join("\n")).toContain("不确定");
    expect(page!.render(100).join("\n")).not.toContain("已停止");
    expect(append).not.toHaveBeenCalled();
    expect(calls.some((call) => call.method === "shells.markStopped")).toBe(false);
    expect(JSON.stringify(calls)).not.toContain("USER");
  } finally {
    stopped.resolve({ task });
    page?.handleInput("\x1b");
    page?.handleInput("\x1b");
    await opened;
    await fakePi.trigger("session_shutdown", { reason: "quit" }, ctx);
    append.mockRestore();
  }
});

describe("openShellUiPage：保留缺连接仓库并可在连接恢复后查询", () => {
  test("workspace 中部分 repo 缺 client 时显示未知而非无活动，恢复后查询全部范围", async () => {
    const fakePi = createFakePi();
    const callsA: string[] = [];
    const callsB: string[] = [];
    const clientA: FakeRepoClient = {
      ...createPollableClient(),
      call: async (method) => { callsA.push(method); return method === "shells.list" ? { tasks: [] } : {}; },
    };
    let clientB: FakeRepoClient | undefined;
    const window = {
      windowId: "window-coverage",
      sessionId: "session-coverage",
      workspace: {
        repos: [
          { repoId: "repo-connected", path: "/workspace/repo-connected", commonDir: "/workspace/repo-connected/.git" },
          { repoId: "repo-recovering", path: "/workspace/repo-recovering", commonDir: "/workspace/repo-recovering/.git" },
        ],
        skipped: [],
      },
      clients: {
        forRepo: (repoId: string) => repoId === "repo-connected" ? clientA : repoId === "repo-recovering" ? clientB : undefined,
        all: () => [clientA, ...(clientB ? [clientB] : [])],
        skipped: () => [],
        closeAll: () => {},
      },
    };
    const deps = { windowReady: () => Promise.resolve(window) as never, createClock: () => createClock({ timeSource: createFakeTimeSource() }) };
    pmPanelExtension(fakePi.pi, deps);
    shellUiExtension(fakePi.pi, deps);
    const ctx = {
      mode: "tui", hasUI: true, cwd: process.cwd(), sessionManager: { getSessionId: () => window.sessionId },
      ui: { ...createFakeUi().ui, setWidget: () => {}, onTerminalInput: () => () => {} },
    };
    let page: import("../runtime/shell-page.ts").ShellPage | undefined;
    let opened: Promise<void> | undefined;
    try {
      await fakePi.trigger("session_start", { reason: "new" }, ctx);
      await flushMicrotasks();
      opened = openShellUiPage({ ui: { custom: (factory) => new Promise((resolve) => {
        page = factory({ requestRender: () => {}, terminal: { columns: 14, rows: 1 } }, {}, {}, resolve);
      }) } });
      await waitFor(() => page !== undefined);
      await page!.refresh();
      expect(callsB).toEqual([]);
      expect(page!.render(14)[0]).toContain("未知");
      expect(page!.render(80).join("\n")).not.toContain("无活动 Shell");

      clientB = {
        ...createPollableClient(),
        call: async (method) => { callsB.push(method); return method === "shells.list" ? { tasks: [] } : {}; },
      };
      await page!.refresh();
      expect(callsB).toEqual(["shells.list"]);
      expect(page!.render(80).join("\n")).toContain("无活动 Shell");
    } finally {
      page?.handleInput("\x1b");
      await opened;
      await fakePi.trigger("session_shutdown", { reason: "quit" }, ctx);
    }
  });
});

describe("openShellUiPage：透传宿主 ctx.ui.theme 到页面主题", () => {
  test("选中行与确认页默认取消项都带宿主主题 selectedBg 标记", async () => {
    const fakePi = createFakePi();
    const client = createPollableClient();
    const windowContextValue = createWindowContextValue("window-theme", "repo-theme", client);

    // openShellUiPage 依赖 lifecycle 的共享 dock：本测试自行经 agents-ui 挂载注册，不依赖其他用例的残留状态
    const panelDeps: PmPanelUiDeps = {
      windowReady: () => Promise.resolve(windowContextValue) as never,
      createClock: () => createClock({ timeSource: createFakeTimeSource() }),
    };
    pmPanelExtension(fakePi.pi, panelDeps);

    const deps: ShellUiDeps = {
      windowReady: () => Promise.resolve(windowContextValue) as never,
      createClock: () => createClock({ timeSource: createFakeTimeSource() }),
      createShellRegistry: (clock) => new ShellRegistry({ clock }),
    };
    shellUiExtension(fakePi.pi, deps);

    const ui = {
      setWidget: (_key: string, _content: unknown, _options?: Record<string, unknown>) => {},
      onTerminalInput: (_handler: (data: string) => unknown) => () => {},
      notify: () => {},
      getEditorText: () => "",
      setStatus: () => {},
      custom: () => Promise.reject(new Error("本测试未使用宿主 custom")),
    };
    const ctx = {
      mode: "tui",
      hasUI: true,
      cwd: process.cwd(),
      sessionManager: { getSessionId: () => "session-theme" },
      ui,
      shutdown: () => {},
    };
    await fakePi.trigger("session_start", { type: "session_start", reason: "new" }, ctx);
    await flushMicrotasks();

    const results = await fakePi.trigger(
      "user_bash",
      { command: "echo theme-marker", cwd: process.cwd(), excludeFromContext: false },
      ctx,
    );
    const handled = results[0] as {
      operations: { exec: (cmd: string, cwd: string, opts: Record<string, unknown>) => Promise<{ exitCode: number }> };
    };
    await handled.operations.exec("sleep 0.05 # theme-marker", process.cwd(), { onData: () => {} });

    let component: { render(width: number): string[]; handleInput(data: string): boolean } | undefined;
    const themeMarker = (kind: string, text: string) => `<${kind}>${text}</${kind}>`;
    const pageCtx = {
      ui: {
        custom: (
          factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (result: unknown) => void) => unknown,
        ) =>
          new Promise((resolve) => {
            component = factory({ requestRender: () => {} }, {}, {}, (result: unknown) => resolve(result)) as typeof component;
          }),
        theme: { fg: themeMarker, bg: themeMarker },
      },
    };

    const openPromise = openShellUiPage(pageCtx);
    await waitFor(() => component !== undefined);
    await waitFor(() => (component?.render(80).join("\n") ?? "").includes("theme-marker"));

    const listText = component!.render(80).join("\n");
    expect(listText).toContain("<selectedBg>");

    component!.handleInput("K");
    const confirmText = component!.render(80).join("\n");
    expect(confirmText).toContain("<selectedBg>取消</selectedBg>");

    component!.handleInput("\x1b");
    expect(component!.render(80).join("\n")).not.toContain("<selectedBg>取消</selectedBg>");
    component!.handleInput("\x1b");
    await openPromise;

    await fakePi.trigger("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);
  }, 10_000);
});
