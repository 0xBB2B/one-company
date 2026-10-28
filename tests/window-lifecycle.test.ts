import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { EventEmitter } from "node:events";
import { setTimeout as realDelay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClock } from "../src/core/policy/clock.ts";
import type { Clock } from "../src/core/policy/clock.ts";
import { discoverWorkspace } from "../src/core/storage/identity.ts";
import type { Workspace } from "../src/core/storage/identity.ts";
import type { UpgradeNotice } from "../src/core/host/upgrade-notice.ts";
import { ShellRegistry } from "../src/core/host/shell-registry.ts";
import type { Host } from "../src/core/host/shell-registry.ts";
import { createFakePi } from "./helpers/fake-pi.ts";
import { createFakeWorkspaceClients } from "./helpers/fake-workspace-clients.ts";
import type { FakeWorkspaceClients, FakeWorkspaceClientsHandle } from "./helpers/fake-workspace-clients.ts";
import { createRepoFixture, removeRepoFixture } from "./helpers/repo-fixture.ts";
import type { RepoFixture } from "./helpers/repo-fixture.ts";
import lifecycleExtension, {
  installExitSignalHandlers,
  registerWindowShutdownHook,
  shutdownWindow,
  windowContext,
  windowReady,
} from "../src/core/host/extension-lifecycle.ts";

const LONG_TIMEOUT = 15_000;

interface FakeTimeSource {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  advance(ms: number): void;
  jump(ms: number): void;
  timerCount(): number;
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

  return {
    now: () => current,
    setTimeout: setTimeoutFake,
    clearTimeout: clearTimeoutFake,
    advance,
    jump,
    timerCount: () => timers.size,
  };
}

// 心跳与 Shell 停止确认共用同一把注入时钟；停止确认要等到该钟的虚拟时间跨过阈值才会收敛，
// 所以需要一边真实等待一边推进虚拟时间，而不是等真实墙钟
async function withClockPump<T>(timeSource: FakeTimeSource, fn: () => Promise<T>): Promise<T> {
  const handle = setInterval(() => timeSource.advance(500), 20);
  (handle as unknown as { unref?: () => void }).unref?.();
  try {
    return await fn();
  } finally {
    clearInterval(handle);
  }
}

const FAKE_PID = 424_242;

interface FakeProcess extends EventEmitter {
  pid: number;
  exitCalls: number[];
  exit(code?: number): void;
}

function createFakeProcess(): FakeProcess {
  const proc = new EventEmitter() as FakeProcess;
  proc.pid = FAKE_PID;
  proc.exitCalls = [];
  proc.exit = (code?: number) => {
    proc.exitCalls.push(code ?? 0);
  };
  return proc;
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs: number, intervalMs = 50): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleepMs(intervalMs);
  }
  if (!(await predicate())) throw new Error(`waitFor 超时（${timeoutMs}ms）`);
}

function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}

const plainTempDirs: string[] = [];
const repoFixtures: RepoFixture[] = [];
const spawnedPgids: number[] = [];

function trackPgid(pgid: number | undefined): void {
  if (typeof pgid === "number") spawnedPgids.push(pgid);
}

// 任何走真实默认路径的用例都可能落到 dataRoot() 解析出的真实 HOME 目录下；全文件统一钉在临时目录，
// 避免污染运行本测试的开发者机器上的真实 ~/.pi/agent/one-company
let previousGlobalAgentDir: string | undefined;
let globalAgentDir: string | undefined;

beforeAll(async () => {
  previousGlobalAgentDir = process.env.PI_CODING_AGENT_DIR;
  globalAgentDir = await mkdtemp(join(tmpdir(), "window-lifecycle-safety-agentdir-"));
  process.env.PI_CODING_AGENT_DIR = globalAgentDir;
});

afterAll(async () => {
  if (previousGlobalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousGlobalAgentDir;
  if (globalAgentDir) await rm(globalAgentDir, { recursive: true, force: true });
});

afterEach(async () => {
  await shutdownWindow(3_000).catch(() => {});
  for (const pgid of spawnedPgids.splice(0)) {
    try {
      process.kill(-pgid, "SIGKILL");
    } catch {
      // 组已消失，无需处理
    }
  }
  for (const dir of plainTempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
  for (const repo of repoFixtures.splice(0)) {
    await removeRepoFixture(repo);
  }
});

function wrapStopHostThrows(registry: ShellRegistry): ShellRegistry {
  return new Proxy(registry, {
    get(target, prop, receiver) {
      if (prop === "stopHost") {
        return async () => {
          throw new Error("stopHost 异常（测试注入）");
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as ShellRegistry;
}

interface FakeCtx {
  cwd: string;
  sessionManager: { getSessionId(): string };
  ui: { notify(message: string, level?: string): void };
  shutdown(): void;
}

function makeFakeCtx(
  cwd: string,
  sessionId: string,
): { ctx: FakeCtx; notifications: Array<{ message: string; level?: string }>; shutdownCalls: number[] } {
  const notifications: Array<{ message: string; level?: string }> = [];
  const shutdownCalls: number[] = [];
  return {
    ctx: {
      cwd,
      sessionManager: { getSessionId: () => sessionId },
      ui: { notify: (message: string, level?: string) => notifications.push({ message, level }) },
      shutdown: () => shutdownCalls.push(Date.now()),
    },
    notifications,
    shutdownCalls,
  };
}

interface BuildHarnessOptions {
  cwd: string;
  sessionId?: string;
  kill?: (pid: number, signal: NodeJS.Signals | 0) => void;
  connectImpl?: (input: { windowId: string; sessionId: string; cwd: string; onUpgradeNotice?: (notice: UpgradeNotice) => void }) => Promise<FakeWorkspaceClientsHandle>;
  wrapShellRegistry?: (registry: ShellRegistry) => ShellRegistry;
  // 走真实时钟而非可推进的假时钟：用于验证"需要真实等待才能收敛"的场景，
  // 不能用 withClockPump 加速，否则测不出预算是否被错误地套用到了不该套用的路径上
  useRealClock?: boolean;
}

interface Harness {
  fakePi: ReturnType<typeof createFakePi>;
  sessionId: string;
  ctx: FakeCtx;
  notifications: Array<{ message: string; level?: string }>;
  shutdownCalls: number[];
  clockCalls: () => number;
  clocksCreated: () => Clock[];
  timeSource: FakeTimeSource;
  shellRegistryCalls: () => number;
  shellRegistry: () => ShellRegistry | undefined;
  shellRegistryClockSeen: () => Clock | undefined;
  workspaceClients: FakeWorkspaceClients;
  connectCalls: Array<{ windowId: string; sessionId: string; cwd: string }>;
  fakeProcess: FakeProcess;
}

async function buildHarness(options: BuildHarnessOptions): Promise<Harness> {
  const sessionId = options.sessionId ?? randomUUID();
  const timeSource = createFakeTimeSource();
  let clockCalls = 0;
  const clocksCreated: Clock[] = [];
  const createClockDep = (): Clock => {
    clockCalls++;
    const clock = options.useRealClock ? createClock() : createClock({ timeSource });
    clocksCreated.push(clock);
    return clock;
  };

  let shellRegistryCalls = 0;
  let shellRegistryInstance: ShellRegistry | undefined;
  let shellRegistryClockSeen: Clock | undefined;
  const createShellRegistryDep = (clock: Clock): ShellRegistry => {
    shellRegistryCalls++;
    shellRegistryClockSeen = clock;
    let registry = new ShellRegistry({ clock, probes: options.kill ? { kill: options.kill } : undefined });
    if (options.wrapShellRegistry) registry = options.wrapShellRegistry(registry);
    shellRegistryInstance = registry;
    return registry;
  };

  const workspace: Workspace = await discoverWorkspace(options.cwd);
  const workspaceClients = createFakeWorkspaceClients(workspace);
  const connectCalls: Array<{ windowId: string; sessionId: string; cwd: string }> = [];
  const connectImpl = options.connectImpl ?? (async () => workspaceClients.handle);
  const fakeProcess = createFakeProcess();
  const { ctx, notifications, shutdownCalls } = makeFakeCtx(options.cwd, sessionId);

  const fakePi = createFakePi();
  lifecycleExtension(fakePi.pi, {
    createClock: createClockDep,
    createShellRegistry: createShellRegistryDep,
    connectWorkspaceClients: async (input: { windowId: string; sessionId: string; cwd: string; onUpgradeNotice?: (notice: UpgradeNotice) => void }) => {
      connectCalls.push(input);
      return connectImpl(input);
    },
    process: fakeProcess as unknown as NodeJS.Process,
  });

  return {
    fakePi,
    sessionId,
    ctx,
    notifications,
    shutdownCalls,
    clockCalls: () => clockCalls,
    clocksCreated: () => clocksCreated,
    timeSource,
    shellRegistryCalls: () => shellRegistryCalls,
    shellRegistry: () => shellRegistryInstance,
    shellRegistryClockSeen: () => shellRegistryClockSeen,
    workspaceClients,
    connectCalls,
    fakeProcess,
  };
}

async function triggerSessionStart(harness: Harness): Promise<void> {
  await harness.fakePi.trigger("session_start", { type: "session_start", reason: "new" }, harness.ctx);
}

describe("扩展工厂调用本身", () => {
  test("不调用创建时钟/Shell 注册表的工厂，不启动任何定时器", () => {
    const timeSource = createFakeTimeSource();
    let clockCalls = 0;
    let shellRegistryCalls = 0;
    const fakePi = createFakePi();

    lifecycleExtension(fakePi.pi, {
      createClock: () => {
        clockCalls++;
        return createClock({ timeSource });
      },
      createShellRegistry: (clock: Clock) => {
        shellRegistryCalls++;
        return new ShellRegistry({ clock });
      },
      connectWorkspaceClients: async () => {
        throw new Error("不应被调用");
      },
      process: createFakeProcess() as unknown as NodeJS.Process,
    });

    expect(clockCalls).toBe(0);
    expect(shellRegistryCalls).toBe(0);
    expect(timeSource.timerCount()).toBe(0);
    expect(() => windowContext()).toThrow();
  });
});

describe("生产默认路径", () => {
  test("仅注入 connectWorkspaceClients，其余走真实默认实现：窗口就绪 → shutdown → 窗口关闭、连接关闭", async () => {
    const repo = await createRepoFixture();
    repoFixtures.push(repo);
    const agentDir = await mkdtemp(join(tmpdir(), "window-lifecycle-agentdir-"));
    plainTempDirs.push(agentDir);
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;

    try {
      const workspace = await discoverWorkspace(repo.root);
      const workspaceClients = createFakeWorkspaceClients(workspace);
      const connectCalls: unknown[] = [];
      const fakePi = createFakePi();
      const sessionId = randomUUID();
      const { ctx } = makeFakeCtx(repo.root, sessionId);

      lifecycleExtension(fakePi.pi, {
        connectWorkspaceClients: async (input: unknown) => {
          connectCalls.push(input);
          return workspaceClients.handle;
        },
      });

      await fakePi.trigger("session_start", { type: "session_start", reason: "new" }, ctx);
      expect(connectCalls.length).toBe(1);

      expect(windowContext().shellRegistry).toBeInstanceOf(ShellRegistry);

      await shutdownWindow();

      expect(() => windowContext()).toThrow();
      expect(workspaceClients.closeAllCallCount()).toBe(1);
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  }, LONG_TIMEOUT);
});

describe("session_before_switch 停止本窗口 Shell 后放行", () => {
  test("本窗口后台 Shell 及后代确实停止后返回放行，daemon 连接与运行状态不受影响", async () => {
    const repo = await createRepoFixture();
    repoFixtures.push(repo);
    // 真实进程退出/ps探测使用真实时间，不用加速时钟提前耗尽停止预算。
    const harness = await buildHarness({ cwd: repo.root, useRealClock: true });
    await triggerSessionStart(harness);

    const shellRegistry = harness.shellRegistry();
    expect(shellRegistry).toBeDefined();
    if (!shellRegistry) return;
    const windowId = windowContext().windowId;

    const taskId = randomUUID();
    const spawned = await shellRegistry.spawn({
      taskId,
      host: { kind: "main", id: windowId },
      command: "sh",
      args: ["-c", "sleep 30 & sleep 30 & wait"],
      mode: "background",
      runToken: randomUUID(),
    });
    expect(spawned.ok).toBe(true);
    if (!spawned.ok) return;
    trackPgid(spawned.task.pgid);
    await sleepMs(200);

    const [result] = (await harness.fakePi.trigger("session_before_switch", { type: "session_before_switch", reason: "new" }, harness.ctx)) as [{ cancel: boolean; reason?: string } | undefined];

    expect(result?.cancel).toBe(false);
    expect(groupAlive(spawned.task.pgid)).toBe(false);
    expect(harness.workspaceClients.closeAllCallCount()).toBe(0);
    expect(harness.workspaceClients.callLog.some((c) => c.method.startsWith("runs."))).toBe(false);
  }, LONG_TIMEOUT);
});

describe("beforeSwitch / beforeFork 统一 fail-closed 门槛", () => {
  test("存在无法确认停止的 Shell 时，session_before_switch 与 session_before_fork 均取消并通知原因", async () => {
    const repo = await createRepoFixture();
    repoFixtures.push(repo);
    const harness = await buildHarness({ cwd: repo.root, kill: () => {} });
    await triggerSessionStart(harness);

    const shellRegistry = harness.shellRegistry();
    expect(shellRegistry).toBeDefined();
    if (!shellRegistry) return;
    const windowId = windowContext().windowId;
    const host: Host = { kind: "main", id: windowId };

    const taskId = randomUUID();
    const spawned = await shellRegistry.spawn({
      taskId,
      host,
      command: "sh",
      args: ["-c", "sleep 30"],
      mode: "background",
      runToken: randomUUID(),
    });
    expect(spawned.ok).toBe(true);
    if (!spawned.ok) return;
    trackPgid(spawned.task.pgid);

    const [switchResult] = (await withClockPump(harness.timeSource, () =>
      harness.fakePi.trigger("session_before_switch", { type: "session_before_switch", reason: "new" }, harness.ctx),
    )) as [{ cancel: boolean; reason?: string } | undefined];
    expect(switchResult?.cancel).toBe(true);
    expect(harness.notifications.some((n) => n.level === "error")).toBe(true);

    const [forkResult] = (await withClockPump(harness.timeSource, () =>
      harness.fakePi.trigger(
        "session_before_fork",
        { type: "session_before_fork", entryId: "entry-1", position: "at" },
        harness.ctx,
      ),
    )) as [{ cancel: boolean; reason?: string } | undefined];
    expect(forkResult?.cancel).toBe(true);

    expect(shellRegistry.get(taskId)?.status).toBe("uncertain");
  }, LONG_TIMEOUT);

  test("等本窗口 Shell 停止超过 20 秒才放弃：19.9 秒时还在等，20 秒后取消并提示 20 秒", async () => {
    const repo = await createRepoFixture();
    repoFixtures.push(repo);
    const harness = await buildHarness({ cwd: repo.root, kill: () => {} });
    await triggerSessionStart(harness);
    const shellRegistry = harness.shellRegistry();
    if (!shellRegistry) throw new Error("shellRegistry 未创建");
    const spawned = await shellRegistry.spawn({
      taskId: randomUUID(),
      host: { kind: "main", id: windowContext().windowId },
      command: "sh",
      args: ["-c", "sleep 30"],
      mode: "background",
      runToken: randomUUID(),
    });
    expect(spawned.ok).toBe(true);
    if (!spawned.ok) return;
    trackPgid(spawned.task.pgid);

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      let result: unknown;
      const switching = harness.fakePi.trigger("session_before_switch", { type: "session_before_switch", reason: "new" }, harness.ctx)
        .then((value) => { result = value; });
      await realDelay(200);
      vi.advanceTimersByTime(19_900);
      await realDelay(100);
      expect(result).toBeUndefined();
      vi.advanceTimersByTime(200);
      await switching;
      expect((result as [{ cancel: boolean }])[0].cancel).toBe(true);
      expect(harness.notifications.map((n) => n.message)).toContain("确认本窗口 Shell 已停止超时（20 秒）");
    } finally { vi.useRealTimers(); }
  }, LONG_TIMEOUT);

  test("窗口未启动时触发 session_before_switch：取消并通知，不报泛化错误", async () => {
    const fakePi = createFakePi();
    lifecycleExtension(fakePi.pi, { process: createFakeProcess() as unknown as NodeJS.Process });
    const notifications: Array<{ message: string; level?: string }> = [];
    const ctx = { ui: { notify: (message: string, level?: string) => notifications.push({ message, level }) } };

    const [result] = (await fakePi.trigger(
      "session_before_switch",
      { type: "session_before_switch", reason: "new" },
      ctx,
    )) as [{ cancel: boolean; reason?: string } | undefined];

    expect(result?.cancel).toBe(true);
    expect(notifications.length).toBe(1);
  });

  test("stopHost 抛错时取消并通知原因", async () => {
    const repo = await createRepoFixture();
    repoFixtures.push(repo);
    const harness = await buildHarness({ cwd: repo.root, wrapShellRegistry: wrapStopHostThrows });
    await triggerSessionStart(harness);

    const [result] = (await harness.fakePi.trigger(
      "session_before_switch",
      { type: "session_before_switch", reason: "new" },
      harness.ctx,
    )) as [{ cancel: boolean; reason?: string } | undefined];

    expect(result?.cancel).toBe(true);
    expect(harness.notifications.some((n) => n.level === "error")).toBe(true);
  });
});

describe("连接失败", () => {
  test("connectWorkspaceClients 拒绝时 windowContext 抛出含该原因的错误，且仅通知一次", async () => {
    const repo = await createRepoFixture();
    repoFixtures.push(repo);
    const reason = "守护进程连接被测试拒绝";
    const harness = await buildHarness({
      cwd: repo.root,
      connectImpl: async () => {
        throw new Error(reason);
      },
    });

    await triggerSessionStart(harness);

    expect(harness.notifications.length).toBe(1);
    expect(harness.notifications[0]?.message).toContain(reason);

    let caught: unknown;
    try {
      windowContext();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain(reason);
  });
});

describe("session_shutdown 不受 15 秒退出等待限制", () => {
  test("Shell 停止需要超过 15 秒才能由注册表判定，session_shutdown 仍等到判定完成", async () => {
    const repo = await createRepoFixture();
    repoFixtures.push(repo);
    const harness = await buildHarness({ cwd: repo.root, kill: () => {}, useRealClock: true });
    await triggerSessionStart(harness);

    const shellRegistry = harness.shellRegistry();
    expect(shellRegistry).toBeDefined();
    if (!shellRegistry) return;
    const windowId = windowContext().windowId;

    const taskId = randomUUID();
    const spawned = await shellRegistry.spawn({
      taskId,
      host: { kind: "main", id: windowId },
      command: "sh",
      args: ["-c", "sleep 30"],
      mode: "background",
      runToken: randomUUID(),
    });
    expect(spawned.ok).toBe(true);
    if (!spawned.ok) return;
    trackPgid(spawned.task.pgid);

    const start = Date.now();
    await harness.fakePi.trigger("session_shutdown", { type: "session_shutdown", reason: "quit" }, harness.ctx);
    const elapsed = Date.now() - start;

    expect(elapsed).toBeGreaterThan(15_000);
    const finalStatus = shellRegistry.get(taskId)?.status;
    expect(finalStatus).not.toBe("stopping");
    expect(["stopped", "uncertain"]).toContain(finalStatus);
  }, 30_000);
});

describe("installExitSignalHandlers 只覆盖 SIGTERM/SIGHUP，SIGINT 永不挂载", () => {
  test("已有宿主 SIGHUP 监听时仍安装自身清理处理器，SIGINT 不新增", () => {
    const proc = new EventEmitter();
    const hostSighupHandler = () => {};
    proc.on("SIGHUP", hostSighupHandler);

    installExitSignalHandlers(proc as unknown as NodeJS.Process);

    expect(proc.listenerCount("SIGTERM")).toBe(1);
    expect(proc.listeners("SIGHUP")).toHaveLength(2);
    expect(proc.listeners("SIGHUP")[0]).toBe(hostSighupHandler);
    expect(proc.listenerCount("SIGINT")).toBe(0);
  });

  test("SIGINT 即使未被宿主监听也不新增监听器", () => {
    const proc = new EventEmitter();
    installExitSignalHandlers(proc as unknown as NodeJS.Process);
    expect(proc.listenerCount("SIGINT")).toBe(0);
    expect(proc.listenerCount("SIGTERM")).toBe(1);
  });
});

describe("退出信号触发窗口清理", () => {
  test("SIGTERM 发出后 shutdownWindow 被调用：本窗口 Shell 停止、捕获的 ctx.shutdown 被调用一次且不调用 proc.exit", async () => {
    const repo = await createRepoFixture();
    repoFixtures.push(repo);
    const harness = await buildHarness({ cwd: repo.root });
    await triggerSessionStart(harness);

    const shellRegistry = harness.shellRegistry();
    expect(shellRegistry).toBeDefined();
    if (!shellRegistry) return;
    const windowId = windowContext().windowId;

    const taskId = randomUUID();
    const spawned = await shellRegistry.spawn({
      taskId,
      host: { kind: "main", id: windowId },
      command: "sh",
      args: ["-c", "sleep 30"],
      mode: "background",
      runToken: randomUUID(),
    });
    expect(spawned.ok).toBe(true);
    if (!spawned.ok) return;
    trackPgid(spawned.task.pgid);
    await sleepMs(200);

    harness.fakeProcess.emit("SIGTERM");

    await withClockPump(harness.timeSource, () => waitFor(() => harness.shutdownCalls.length > 0, 5_000));

    expect(groupAlive(spawned.task.pgid)).toBe(false);
    expect(harness.shutdownCalls.length).toBe(1);
    expect(harness.fakeProcess.exitCalls.length).toBe(0);
    expect(() => windowContext()).toThrow();
  }, LONG_TIMEOUT);

  test("永不确认的 Shell 不阻塞退出：最多等 15 秒后照样完成清理并退出", async () => {
    const repo = await createRepoFixture();
    repoFixtures.push(repo);
    const harness = await buildHarness({ cwd: repo.root, kill: () => {} });
    await triggerSessionStart(harness);

    const shellRegistry = harness.shellRegistry();
    expect(shellRegistry).toBeDefined();
    if (!shellRegistry) return;
    const windowId = windowContext().windowId;

    const taskId = randomUUID();
    const spawned = await shellRegistry.spawn({
      taskId,
      host: { kind: "main", id: windowId },
      command: "sh",
      args: ["-c", "sleep 30"],
      mode: "background",
      runToken: randomUUID(),
    });
    expect(spawned.ok).toBe(true);
    if (!spawned.ok) return;
    trackPgid(spawned.task.pgid);

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      harness.fakeProcess.emit("SIGHUP");
      await realDelay(200);
      vi.advanceTimersByTime(14_700);
      await realDelay(100);
      expect(harness.shutdownCalls.length).toBe(0);
      vi.advanceTimersByTime(300);
      await realDelay(100);
      expect(harness.shutdownCalls.length).toBe(1);
    } finally { vi.useRealTimers(); }
    expect(() => windowContext()).toThrow();
  }, LONG_TIMEOUT);
});

describe("role 宿主 Shell 不受影响", () => {
  test("窗口 shutdown 后，role 宿主的 Shell 仍存活", async () => {
    const repo = await createRepoFixture();
    repoFixtures.push(repo);
    const harness = await buildHarness({ cwd: repo.root });
    await triggerSessionStart(harness);

    const shellRegistry = harness.shellRegistry();
    expect(shellRegistry).toBeDefined();
    if (!shellRegistry) return;
    const roleTaskId = randomUUID();
    const roleHost: Host = { kind: "role", id: "other-window", role: "impl-engineer", runId: randomUUID() };
    const roleSpawn = await shellRegistry.spawn({
      taskId: roleTaskId,
      host: roleHost,
      command: "sh",
      args: ["-c", "sleep 30"],
      mode: "background",
      runToken: randomUUID(),
    });
    expect(roleSpawn.ok).toBe(true);
    if (!roleSpawn.ok) return;
    trackPgid(roleSpawn.task.pgid);
    await sleepMs(200);

    await shutdownWindow();

    expect(groupAlive(roleSpawn.task.pgid)).toBe(true);
    await withClockPump(harness.timeSource, () => shellRegistry.stop(roleTaskId));
  }, LONG_TIMEOUT);
});

describe("session_shutdown 幂等清理", () => {
  test("两次触发只 closeAll 一次", async () => {
    const repo = await createRepoFixture();
    repoFixtures.push(repo);
    const harness = await buildHarness({ cwd: repo.root });
    await triggerSessionStart(harness);

    await harness.fakePi.trigger("session_shutdown", { type: "session_shutdown", reason: "quit" }, harness.ctx);
    await harness.fakePi.trigger("session_shutdown", { type: "session_shutdown", reason: "quit" }, harness.ctx);

    expect(harness.workspaceClients.closeAllCallCount()).toBe(1);
  });
});

describe("非仓库目录", () => {
  test("cwd 及子目录都没有仓库时警告一次，窗口照常启动且不接入仓库", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "window-lifecycle-nonrepo-"));
    plainTempDirs.push(cwd);
    const harness = await buildHarness({ cwd });

    await triggerSessionStart(harness);

    expect(harness.notifications).toEqual([{
      level: "warning",
      message: `当前目录（${cwd}）和它的子目录里都没有 Git 仓库，需求和后台代理功能用不了。`
        + "要用这两项功能，请把当前目录建成 Git 仓库（git init），或者把项目放在子目录里、每个子目录各自建成 Git 仓库，然后重新启动 pi。"
        + "其他功能可以照常使用。",
    }]);
    expect((await windowReady()).workspace.repos).toEqual([]);
    expect(windowContext().shellRegistry).toBeDefined();
  });
});

describe("windowId 一致性", () => {
  test("hello 的 windowId 与 windowContext() 相同", async () => {
    const repo = await createRepoFixture();
    repoFixtures.push(repo);
    const harness = await buildHarness({ cwd: repo.root });
    await triggerSessionStart(harness);

    const helloWindowId = harness.connectCalls[0]?.windowId;
    expect(typeof helloWindowId).toBe("string");

    const ctxWindowId = windowContext().windowId;
    expect(ctxWindowId).toBe(helloWindowId);
  });
});

describe("共享时钟", () => {
  test("createClock 只被调用一次，createShellRegistry 收到的是同一个时钟", async () => {
    const repo = await createRepoFixture();
    repoFixtures.push(repo);
    const harness = await buildHarness({ cwd: repo.root });
    await triggerSessionStart(harness);

    expect(harness.clockCalls()).toBe(1);

    expect(harness.shellRegistryClockSeen()).toBe(harness.clocksCreated()[0]);
  });
});

describe("可信前置关闭回调", () => {
  test("同步撤销先于Shell等待，重复shutdown等待同一收尾且退订无残留", async () => {
    const repo = await createRepoFixture(); repoFixtures.push(repo);
    let releaseShell!: () => void;
    const shell = new Promise<void>((resolve) => { releaseShell = resolve; });
    let releaseHook!: () => void;
    const hook = new Promise<void>((resolve) => { releaseHook = resolve; });
    const order: string[] = [];
    const harness = await buildHarness({ cwd: repo.root, wrapShellRegistry: (registry) => new Proxy(registry, {
      get(target, prop, receiver) {
        if (prop === "stopHost") return async () => { order.push("shell"); await shell; return []; };
        return Reflect.get(target, prop, receiver);
      },
    }) });
    await triggerSessionStart(harness);
    const window = windowContext();
    let cancelledCalls = 0;
    for (let i = 0; i < 40; i++) registerWindowShutdownHook(window, () => { cancelledCalls++; })();
    const unsubscribe = registerWindowShutdownHook(window, () => { order.push("invalidate"); return hook; });
    const foreign = registerWindowShutdownHook({ ...window, sessionId: "foreign" }, () => { order.push("foreign"); });
    const closing = shutdownWindow();
    const duplicate = shutdownWindow();
    expect(duplicate).toBe(closing);
    try {
      expect(order).toEqual(["invalidate", "shell"]);
      expect(harness.workspaceClients.closeAllCallCount()).toBe(0);
      let settled = false; void closing.then(() => { settled = true; });
      releaseShell(); await sleepMs(20);
      expect(settled).toBe(false);
      expect(harness.workspaceClients.closeAllCallCount()).toBe(0);
    } finally { releaseShell(); releaseHook(); unsubscribe(); foreign(); await closing; }
    expect(cancelledCalls).toBe(0);
    expect(harness.workspaceClients.closeAllCallCount()).toBe(1);
    await shutdownWindow(); expect(order).toEqual(["invalidate", "shell"]);
  });

  test("退出信号同步触发失效，重复信号只通知一次宿主关闭", async () => {
    const repo = await createRepoFixture(); repoFixtures.push(repo);
    let releaseShell!: () => void;
    const shell = new Promise<void>((resolve) => { releaseShell = resolve; });
    const harness = await buildHarness({ cwd: repo.root, wrapShellRegistry: (registry) => new Proxy(registry, {
      get(target, prop, receiver) {
        if (prop === "stopHost") return async () => { await shell; return []; };
        return Reflect.get(target, prop, receiver);
      },
    }) });
    await triggerSessionStart(harness);
    let invalidations = 0;
    const unsubscribe = registerWindowShutdownHook(windowContext(), () => { invalidations++; });
    try {
      harness.fakeProcess.emit("SIGTERM"); harness.fakeProcess.emit("SIGHUP");
      expect(invalidations).toBe(1);
      expect(harness.workspaceClients.closeAllCallCount()).toBe(0);
      releaseShell();
      await waitFor(() => harness.shutdownCalls.length === 1, 2_000);
      expect(harness.workspaceClients.closeAllCallCount()).toBe(1);
      expect(harness.fakeProcess.exitCalls).toEqual([]);
    } finally { releaseShell(); unsubscribe(); await shutdownWindow(); }
  });

  test("已在等待普通关闭时退出预算仍可收紧，不因复用shutdownPromise无限等待", async () => {
    const repo = await createRepoFixture(); repoFixtures.push(repo);
    let release!: () => void;
    const stopped = new Promise<void>((resolve) => { release = resolve; });
    const harness = await buildHarness({ cwd: repo.root, wrapShellRegistry: (registry) => new Proxy(registry, {
      get(target, prop, receiver) {
        if (prop === "stopHost") return async () => { await stopped; return []; };
        return Reflect.get(target, prop, receiver);
      },
    }) });
    await triggerSessionStart(harness);
    const pending = shutdownWindow();
    let finished = false;
    const bounded = shutdownWindow(20).then(() => { finished = true; });
    try {
      await sleepMs(100);
      expect(finished).toBe(true);
      expect(harness.workspaceClients.closeAllCallCount()).toBe(1);
    } finally { release(); await Promise.all([pending, bounded]); }
  });

  test("一个前置回调失败不跳过其它撤权和原有资源清理，并返回固定失败元数据", async () => {
    const repo = await createRepoFixture(); repoFixtures.push(repo);
    const harness = await buildHarness({ cwd: repo.root });
    await triggerSessionStart(harness);
    const window = windowContext();
    registerWindowShutdownHook(window, () => { throw new Error("HOOK_BODY_SENTINEL"); });
    let invalidated = false;
    registerWindowShutdownHook(window, () => { invalidated = true; });
    const result = await shutdownWindow();
    expect(invalidated).toBe(true);
    expect(result.shutdownHookFailures).toBe(1);
    expect(JSON.stringify(result)).not.toContain("SENTINEL");
    expect(harness.workspaceClients.closeAllCallCount()).toBe(1);
  });
});

describe("windowReady 不依赖扩展加载顺序", () => {
  test("session_start 前调用得到 pending promise，触发后兑现且与 windowContext() 一致", async () => {
    const repo = await createRepoFixture();
    repoFixtures.push(repo);
    const harness = await buildHarness({ cwd: repo.root });

    const readyPromise = windowReady();
    let settled = false;
    void readyPromise.then(() => {
      settled = true;
    });
    await sleepMs(20);
    expect(settled).toBe(false);

    await triggerSessionStart(harness);
    const ready = await readyPromise;
    const ctx = windowContext();

    expect(ready).toEqual(ctx);
    expect(ready.clients).toBe(ctx.clients);
  });

  test("连接失败时 windowReady 拒绝，原因含连接错误信息", async () => {
    const repo = await createRepoFixture();
    repoFixtures.push(repo);
    const reason = "守护进程连接被测试拒绝（windowReady）";
    const harness = await buildHarness({
      cwd: repo.root,
      connectImpl: async () => {
        throw new Error(reason);
      },
    });

    const readyPromise = windowReady();
    await triggerSessionStart(harness);

    await expect(readyPromise).rejects.toThrow(reason);
  });

  test("shutdown 后再次 session_start 得到新的兑现值（windowId 不同）", async () => {
    const repo = await createRepoFixture();
    repoFixtures.push(repo);
    const harnessOne = await buildHarness({ cwd: repo.root });
    await triggerSessionStart(harnessOne);
    const first = await windowReady();

    await shutdownWindow();

    const harnessTwo = await buildHarness({ cwd: repo.root });
    const readyPromiseTwo = windowReady();
    await triggerSessionStart(harnessTwo);
    const second = await readyPromiseTwo;

    expect(second.windowId).not.toBe(first.windowId);
  });
});

describe("守护进程换新提示显示到窗口", () => {
  let repo: RepoFixture;
  beforeAll(async () => {
    repo = await createRepoFixture();
  });
  afterAll(async () => {
    await removeRepoFixture(repo);
  });
  afterEach(async () => {
    await shutdownWindow();
  });

  function notice(kind: UpgradeNotice["kind"], extra: Partial<UpgradeNotice> = {}): UpgradeNotice {
    return { kind, repoName: "企微BOT", requirements: [], otherWindows: 0, ownSessions: 0, ...extra };
  }

  async function startWithNotices(initial: UpgradeNotice[]) {
    let saved: ((n: UpgradeNotice) => void) | undefined;
    const harness = await buildHarness({
      cwd: repo.root,
      connectImpl: async (input) => {
        saved = input.onUpgradeNotice;
        for (const n of initial) input.onUpgradeNotice?.(n);
        return createFakeWorkspaceClients(await discoverWorkspace(repo.root)).handle;
      },
    });
    await triggerSessionStart(harness);
    return { harness, emit: (n: UpgradeNotice) => saved?.(n) };
  }

  test("打开窗口时发生的 replaced 在启动时以 info 显示", async () => {
    const { harness } = await startWithNotices([notice("replaced")]);
    expect(harness.notifications).toContainEqual({
      message: "企微BOT 的后台进程跑的是旧代码，已停掉并换成当前安装的版本。",
      level: "info",
    });
  });

  test("waiting_blocked 以 warning 显示并带等待项", async () => {
    const { harness } = await startWithNotices([notice("waiting_blocked", { requirements: ["订单导出"], otherWindows: 1 })]);
    expect(harness.notifications).toContainEqual({
      message: "企微BOT 的后台进程是旧版本，和这个窗口不兼容，需求和代理功能暂时用不了，普通对话不受影响。正在等：需求「订单导出」运行结束，另外 1 个窗口关闭。空下来后 30 秒内会自动换成新版本。",
      level: "warning",
    });
  });

  test("window_stale 以 error 显示", async () => {
    const { harness } = await startWithNotices([notice("window_stale")]);
    expect(harness.notifications).toContainEqual({
      message: "这个窗口是旧版本，和企微BOT 已更新的后台进程不兼容，需求和代理功能用不了。请关掉这个窗口，运行 pi -c 重新打开，接着原来的对话。",
      level: "error",
    });
  });

  test("启动完成后发生的 replaced_after_wait 在发生时以 info 显示", async () => {
    const { harness, emit } = await startWithNotices([]);
    expect(harness.notifications).toEqual([]);
    emit(notice("replaced_after_wait"));
    expect(harness.notifications).toContainEqual({
      message: "企微BOT 的后台进程已换成新版本，需求和代理功能可以用了。",
      level: "info",
    });
  });

  test("session_shutdown 之后旧客户端回调的提示不再显示", async () => {
    const { harness, emit } = await startWithNotices([]);
    emit(notice("replaced_after_wait"));
    expect(harness.notifications.length).toBe(1);
    await harness.fakePi.trigger("session_shutdown", { type: "session_shutdown", reason: "quit" }, harness.ctx);
    const before = harness.notifications.length;
    emit(notice("replaced"));
    expect(harness.notifications.length).toBe(before);
  });
});
