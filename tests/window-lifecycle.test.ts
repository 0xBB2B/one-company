import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClock } from "../runtime/clock.ts";
import type { Clock } from "../runtime/clock.ts";
import { currentBootId, processStartedAt, WindowRegistry } from "../runtime/windows.ts";
import { dataRoot, discoverWorkspace, repoDataDir, repositoryIdentity } from "../runtime/identity.ts";
import type { Workspace, WorkspaceRepo } from "../runtime/identity.ts";
import { ShellRegistry } from "../runtime/shell-registry.ts";
import type { Host } from "../runtime/shell-registry.ts";
import { createFakePi } from "./helpers/fake-pi.ts";
import { createFakeWorkspaceClients } from "./helpers/fake-workspace-clients.ts";
import type { FakeWorkspaceClients, FakeWorkspaceClientsHandle } from "./helpers/fake-workspace-clients.ts";
import { createRepoFixture, createWorkspaceFixture, removeRepoFixture } from "./helpers/repo-fixture.ts";
import type { RepoFixture, WorkspaceFixture } from "./helpers/repo-fixture.ts";
import lifecycleExtension, {
  installExitSignalHandlers,
  shutdownWindow,
  windowContext,
  windowReady,
} from "../extensions/lifecycle.ts";

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

const windowRepoDirs: string[] = [];
const plainTempDirs: string[] = [];
const repoFixtures: Array<RepoFixture | WorkspaceFixture> = [];
const spawnedPgids: number[] = [];

function trackPgid(pgid: number | undefined): void {
  if (typeof pgid === "number") spawnedPgids.push(pgid);
}

// 任何走真实默认路径的用例都可能落到 dataRoot() 解析出的真实 HOME 目录下；全文件统一钉在临时目录，
// 避免污染运行本测试的开发者机器上的真实 ~/.pi/agent/pi-company
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
  for (const dir of windowRepoDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
  for (const dir of plainTempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
  for (const repo of repoFixtures.splice(0)) {
    await removeRepoFixture(repo);
  }
});

function createWindowRegistryFactory(wrap?: (registry: WindowRegistry, index: number) => WindowRegistry) {
  const registries: WindowRegistry[] = [];
  const registryByRepoId = new Map<string, WindowRegistry>();
  const calls: Array<{ repoId: string }> = [];
  const clocksSeen: Clock[] = [];
  return {
    createWindowRegistry: async (input: { repo: WorkspaceRepo; clock: Clock }): Promise<WindowRegistry> => {
      const index = calls.length;
      calls.push({ repoId: input.repo.repoId });
      clocksSeen.push(input.clock);
      const repoDir = await mkdtemp(join(tmpdir(), "window-lifecycle-repo-"));
      windowRepoDirs.push(repoDir);
      let registry: WindowRegistry = new WindowRegistry({
        repoDir,
        clock: input.clock,
        bootId: async () => "boot-fixed",
        processStartedAt: async (pid: number) => `start-${pid}`,
      });
      if (wrap) registry = wrap(registry, index);
      registries.push(registry);
      registryByRepoId.set(input.repo.repoId, registry);
      return registry;
    },
    registryFor: (repoId: string) => registryByRepoId.get(repoId),
    all: (): WindowRegistry[] => registries.slice(),
    calls,
    clocksSeen,
  };
}

function wrapUnregisterThrows(registry: WindowRegistry): WindowRegistry {
  return new Proxy(registry, {
    get(target, prop, receiver) {
      if (prop === "unregister") {
        return async () => {
          throw new Error("注销失败（测试注入）");
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as WindowRegistry;
}

function wrapHeartbeatThrows(registry: WindowRegistry, reason: string): WindowRegistry {
  return new Proxy(registry, {
    get(target, prop, receiver) {
      if (prop === "heartbeat") {
        return async () => {
          throw new Error(reason);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as WindowRegistry;
}

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
  connectImpl?: (input: { windowId: string; sessionId: string; cwd: string }) => Promise<FakeWorkspaceClientsHandle>;
  wrapWindowRegistry?: (registry: WindowRegistry, index: number) => WindowRegistry;
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
  timeSource: FakeTimeSource;
  shellRegistryCalls: () => number;
  shellRegistry: () => ShellRegistry | undefined;
  shellRegistryClockSeen: () => Clock | undefined;
  windowRegistryFactory: ReturnType<typeof createWindowRegistryFactory>;
  workspaceClients: FakeWorkspaceClients;
  connectCalls: Array<{ windowId: string; sessionId: string; cwd: string }>;
  fakeProcess: FakeProcess;
}

async function buildHarness(options: BuildHarnessOptions): Promise<Harness> {
  const sessionId = options.sessionId ?? randomUUID();
  const timeSource = createFakeTimeSource();
  let clockCalls = 0;
  const createClockDep = (): Clock => {
    clockCalls++;
    return options.useRealClock ? createClock() : createClock({ timeSource });
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

  const windowRegistryFactory = createWindowRegistryFactory(options.wrapWindowRegistry);
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
    createWindowRegistry: windowRegistryFactory.createWindowRegistry,
    connectWorkspaceClients: async (input: { windowId: string; sessionId: string; cwd: string }) => {
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
    timeSource,
    shellRegistryCalls: () => shellRegistryCalls,
    shellRegistry: () => shellRegistryInstance,
    shellRegistryClockSeen: () => shellRegistryClockSeen,
    windowRegistryFactory,
    workspaceClients,
    connectCalls,
    fakeProcess,
  };
}

async function triggerSessionStart(harness: Harness): Promise<void> {
  await harness.fakePi.trigger("session_start", { type: "session_start", reason: "new" }, harness.ctx);
}

describe("扩展工厂调用本身", () => {
  test("不调用创建时钟/Shell 注册表/窗口注册表的工厂，不启动任何定时器", () => {
    const timeSource = createFakeTimeSource();
    let clockCalls = 0;
    let shellRegistryCalls = 0;
    let windowRegistryCalls = 0;
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
      createWindowRegistry: async () => {
        windowRegistryCalls++;
        throw new Error("不应被调用");
      },
      connectWorkspaceClients: async () => {
        throw new Error("不应被调用");
      },
      process: createFakeProcess() as unknown as NodeJS.Process,
    });

    expect(clockCalls).toBe(0);
    expect(shellRegistryCalls).toBe(0);
    expect(windowRegistryCalls).toBe(0);
    expect(timeSource.timerCount()).toBe(0);
    expect(() => windowContext()).toThrow();
  });
});

describe("生产默认路径", () => {
  test("仅注入 connectWorkspaceClients，其余走真实默认实现：登记存在 → shutdown → 记录删除", async () => {
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

      const identity = await repositoryIdentity(repo.root);
      const repoDir = await repoDataDir(dataRoot({ PI_CODING_AGENT_DIR: agentDir }), identity.repoId, identity.commonDir);
      const inspectionRegistry = new WindowRegistry({
        repoDir,
        clock: createClock(),
        bootId: currentBootId,
        processStartedAt,
      });

      expect((await inspectionRegistry.list()).length).toBe(1);

      await shutdownWindow();

      expect((await inspectionRegistry.list()).length).toBe(0);
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
    const harness = await buildHarness({ cwd: repo.root });
    await triggerSessionStart(harness);

    const registry = harness.windowRegistryFactory.all()[0];
    const shellRegistry = harness.shellRegistry();
    expect(registry).toBeDefined();
    expect(shellRegistry).toBeDefined();
    if (!registry || !shellRegistry) return;
    const windowId = (await registry.list())[0]?.windowId as string;

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

    const [result] = (await withClockPump(harness.timeSource, () =>
      harness.fakePi.trigger("session_before_switch", { type: "session_before_switch", reason: "new" }, harness.ctx),
    )) as [{ cancel: boolean; reason?: string } | undefined];

    expect(result?.cancel).toBe(false);
    expect(groupAlive(spawned.task.pgid)).toBe(false);
    expect(harness.workspaceClients.closeAllCallCount()).toBe(0);
    expect(harness.workspaceClients.callLog.some((c) => c.method.startsWith("runs."))).toBe(false);
  }, LONG_TIMEOUT);
});

describe("睡眠扣除", () => {
  test("注入长睡眠间隔后窗口记录 liveness 仍为 alive", async () => {
    const repo = await createRepoFixture();
    repoFixtures.push(repo);
    const harness = await buildHarness({ cwd: repo.root });
    await triggerSessionStart(harness);

    const registry = harness.windowRegistryFactory.all()[0];
    expect(registry).toBeDefined();
    if (!registry) return;
    const windowId = (await registry.list())[0]?.windowId as string;

    harness.timeSource.jump(600_000);

    const list = await registry.list();
    expect(list.find((r) => r.windowId === windowId)?.liveness).toBe("alive");
  });
});

describe("心跳持续递增", () => {
  test("heartbeatSeq 随时钟推进持续递增", async () => {
    const repo = await createRepoFixture();
    repoFixtures.push(repo);
    const harness = await buildHarness({ cwd: repo.root });
    await triggerSessionStart(harness);

    const registry = harness.windowRegistryFactory.all()[0];
    expect(registry).toBeDefined();
    if (!registry) return;
    const windowId = (await registry.list())[0]?.windowId as string;
    const before = (await registry.list()).find((r) => r.windowId === windowId);

    harness.timeSource.advance(5_000);
    await sleepMs(20);
    const afterOne = (await registry.list()).find((r) => r.windowId === windowId);
    expect(afterOne?.heartbeatSeq).toBeGreaterThan((before?.heartbeatSeq as number) ?? 0);

    harness.timeSource.advance(5_000);
    await sleepMs(20);
    const afterTwo = (await registry.list()).find((r) => r.windowId === windowId);
    expect(afterTwo?.heartbeatSeq).toBeGreaterThan((afterOne?.heartbeatSeq as number) ?? 0);
  });
});

describe("beforeSwitch / beforeFork 统一 fail-closed 门槛", () => {
  test("存在无法确认停止的 Shell 时，session_before_switch 与 session_before_fork 均取消并通知原因", async () => {
    const repo = await createRepoFixture();
    repoFixtures.push(repo);
    const harness = await buildHarness({ cwd: repo.root, kill: () => {} });
    await triggerSessionStart(harness);

    const registry = harness.windowRegistryFactory.all()[0];
    expect(registry).toBeDefined();
    const shellRegistry = harness.shellRegistry();
    expect(shellRegistry).toBeDefined();
    if (!registry || !shellRegistry) return;
    const windowId = (await registry.list())[0]?.windowId as string;
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

describe("连接失败不留任何记录", () => {
  test("connectWorkspaceClients 拒绝时不登记任何仓库窗口记录，windowContext 抛出含该原因的错误，且仅通知一次", async () => {
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

    expect(harness.windowRegistryFactory.calls.length).toBe(0);
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

describe("注销抛错仍关闭连接", () => {
  test("shutdown 时 unregister 抛错，closeAll 仍在 finally 中被调用一次", async () => {
    const repo = await createRepoFixture();
    repoFixtures.push(repo);
    const harness = await buildHarness({ cwd: repo.root, wrapWindowRegistry: wrapUnregisterThrows });
    await triggerSessionStart(harness);

    await shutdownWindow().catch(() => {});

    expect(harness.workspaceClients.closeAllCallCount()).toBe(1);
  });
});

describe("多仓库注销单仓失败不中断其它仓库", () => {
  test("第一个仓库 unregister 抛错，第二个仓库记录仍被删除，closeAll 仍调用一次", async () => {
    const workspace = await createWorkspaceFixture();
    repoFixtures.push(workspace);
    const harness = await buildHarness({
      cwd: workspace.root,
      wrapWindowRegistry: (registry, index) => (index === 0 ? wrapUnregisterThrows(registry) : registry),
    });
    await triggerSessionStart(harness);

    const registries = harness.windowRegistryFactory.all();
    expect(registries.length).toBe(2);

    await shutdownWindow().catch(() => {});

    expect(await registries[1]!.list()).toEqual([]);
    expect(harness.workspaceClients.closeAllCallCount()).toBe(1);
  });
});

describe("session_shutdown 不受 3 秒预算限制", () => {
  test("Shell 停止需要超过 3 秒才能由注册表判定，session_shutdown 仍等到判定完成", async () => {
    const repo = await createRepoFixture();
    repoFixtures.push(repo);
    const harness = await buildHarness({ cwd: repo.root, kill: () => {}, useRealClock: true });
    await triggerSessionStart(harness);

    const registry = harness.windowRegistryFactory.all()[0];
    const shellRegistry = harness.shellRegistry();
    expect(registry).toBeDefined();
    expect(shellRegistry).toBeDefined();
    if (!registry || !shellRegistry) return;
    const windowId = (await registry.list())[0]?.windowId as string;

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

    expect(elapsed).toBeGreaterThan(3_000);
    const finalStatus = shellRegistry.get(taskId)?.status;
    expect(finalStatus).not.toBe("stopping");
    expect(["stopped", "uncertain"]).toContain(finalStatus);
  }, 15_000);
});

describe("注销失败汇总", () => {
  test("首仓 unregister 抛错：session_shutdown 处理器的 ctx.ui.notify 收到一次含 repoId 与原因的通知", async () => {
    const workspace = await createWorkspaceFixture();
    repoFixtures.push(workspace);
    const reason = "注销失败（测试注入）";
    const harness = await buildHarness({
      cwd: workspace.root,
      wrapWindowRegistry: (registry, index) => (index === 0 ? wrapUnregisterThrows(registry) : registry),
    });
    await triggerSessionStart(harness);

    const failingRepoId = harness.windowRegistryFactory.calls[0]?.repoId as string;
    expect(typeof failingRepoId).toBe("string");

    await harness.fakePi.trigger("session_shutdown", { type: "session_shutdown", reason: "quit" }, harness.ctx);

    expect(harness.notifications.length).toBe(1);
    const message = harness.notifications[0]?.message ?? "";
    expect(message).toContain(reason);
    expect(message).toContain(failingRepoId);
  });

  test("shutdownWindow() 直接调用时返回值 unregisterFailures 含 repoId 与原因", async () => {
    const workspace = await createWorkspaceFixture();
    repoFixtures.push(workspace);
    const reason = "注销失败（测试注入）";
    const harness = await buildHarness({
      cwd: workspace.root,
      wrapWindowRegistry: (registry, index) => (index === 0 ? wrapUnregisterThrows(registry) : registry),
    });
    await triggerSessionStart(harness);

    const failingRepoId = harness.windowRegistryFactory.calls[0]?.repoId as string;

    const result = await shutdownWindow();

    expect(result.unregisterFailures.length).toBe(1);
    expect(result.unregisterFailures[0]?.repoId).toBe(failingRepoId);
    expect(result.unregisterFailures[0]?.reason).toContain(reason);
  });

  test("信号路径遇到同样的注销失败不触发 notify", async () => {
    const workspace = await createWorkspaceFixture();
    repoFixtures.push(workspace);
    const harness = await buildHarness({
      cwd: workspace.root,
      wrapWindowRegistry: (registry, index) => (index === 0 ? wrapUnregisterThrows(registry) : registry),
    });
    await triggerSessionStart(harness);

    harness.fakeProcess.emit("SIGTERM");

    await waitFor(() => harness.shutdownCalls.length > 0, 5_000);

    expect(harness.notifications.length).toBe(0);
  });
});

describe("心跳失败可见", () => {
  test("注册表心跳抛错时 windowContext().heartbeatError 含具体原因", async () => {
    const repo = await createRepoFixture();
    repoFixtures.push(repo);
    const reason = "心跳写入失败（测试注入）";
    const harness = await buildHarness({
      cwd: repo.root,
      wrapWindowRegistry: (registry) => wrapHeartbeatThrows(registry, reason),
    });
    await triggerSessionStart(harness);

    harness.timeSource.advance(5_000);
    await sleepMs(20);

    expect(windowContext().heartbeatError).toContain(reason);
  });
});

describe("关闭后心跳定时器释放", () => {
  test("shutdown 后推进时钟，心跳回调不再被调用（而非仅记录列表为空）", async () => {
    const repo = await createRepoFixture();
    repoFixtures.push(repo);
    let heartbeatCalls = 0;
    const harness = await buildHarness({
      cwd: repo.root,
      wrapWindowRegistry: (registry) =>
        new Proxy(registry, {
          get(target, prop, receiver) {
            if (prop === "heartbeat") {
              return async (id: string) => {
                heartbeatCalls++;
                return target.heartbeat(id);
              };
            }
            return Reflect.get(target, prop, receiver);
          },
        }) as WindowRegistry,
    });
    await triggerSessionStart(harness);

    harness.timeSource.advance(5_000);
    await sleepMs(20);
    const callsBeforeShutdown = heartbeatCalls;
    expect(callsBeforeShutdown).toBeGreaterThan(0);

    await shutdownWindow();

    harness.timeSource.advance(20_000);
    await sleepMs(20);
    expect(heartbeatCalls).toBe(callsBeforeShutdown);
  });
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
  test("SIGTERM 发出后 shutdownWindow 被调用：窗口记录删除、本窗口 Shell 停止、捕获的 ctx.shutdown 被调用一次且不调用 proc.exit", async () => {
    const repo = await createRepoFixture();
    repoFixtures.push(repo);
    const harness = await buildHarness({ cwd: repo.root });
    await triggerSessionStart(harness);

    const registry = harness.windowRegistryFactory.all()[0];
    const shellRegistry = harness.shellRegistry();
    expect(registry).toBeDefined();
    expect(shellRegistry).toBeDefined();
    if (!registry || !shellRegistry) return;
    const windowId = (await registry.list())[0]?.windowId as string;

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

    await withClockPump(harness.timeSource, () =>
      waitFor(async () => {
        const lists = await Promise.all(harness.windowRegistryFactory.all().map((r) => r.list()));
        return lists.every((l) => l.length === 0);
      }, 5_000),
    );

    expect(groupAlive(spawned.task.pgid)).toBe(false);
    expect(harness.shutdownCalls.length).toBe(1);
    expect(harness.fakeProcess.exitCalls.length).toBe(0);
    expect(() => windowContext()).toThrow();
  }, LONG_TIMEOUT);

  test("永不确认的 Shell 不阻塞退出：约 3 秒内完成清理并放弃等待确认", async () => {
    const repo = await createRepoFixture();
    repoFixtures.push(repo);
    const harness = await buildHarness({ cwd: repo.root, kill: () => {} });
    await triggerSessionStart(harness);

    const registry = harness.windowRegistryFactory.all()[0];
    const shellRegistry = harness.shellRegistry();
    expect(registry).toBeDefined();
    expect(shellRegistry).toBeDefined();
    if (!registry || !shellRegistry) return;
    const windowId = (await registry.list())[0]?.windowId as string;

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

    // 本用例刻意不推进共享时钟：验证的是退出信号路径自身约 3 秒的放弃等待上限，
    // 与共享时钟驱动的 ShellRegistry 内部确认超时是两回事，混着推进会掩盖这条独立的墙钟上限
    const start = Date.now();
    harness.fakeProcess.emit("SIGHUP");

    await waitFor(async () => {
      const lists = await Promise.all(harness.windowRegistryFactory.all().map((r) => r.list()));
      return lists.every((l) => l.length === 0);
    }, 3_300);

    expect(Date.now() - start).toBeLessThan(3_300);
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

describe("多仓库工作区", () => {
  test("每个仓库的窗口目录都有记录（windowId 相同），shutdown 后全部删除", async () => {
    const workspace = await createWorkspaceFixture();
    repoFixtures.push(workspace);
    const harness = await buildHarness({ cwd: workspace.root });
    await triggerSessionStart(harness);

    const registries = harness.windowRegistryFactory.all();
    expect(registries.length).toBe(2);
    const windowIds = new Set<string>();
    for (const registry of registries) {
      const list = await registry.list();
      expect(list.length).toBe(1);
      windowIds.add(list[0]!.windowId);
    }
    expect(windowIds.size).toBe(1);

    await harness.fakePi.trigger("session_shutdown", { type: "session_shutdown", reason: "quit" }, harness.ctx);

    for (const registry of registries) {
      expect(await registry.list()).toEqual([]);
    }
  });
});

describe("非仓库目录", () => {
  test("cwd 不在任何仓库时不抛出，通知一次，windowContext 抛出含'工作区'字样的原因", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "window-lifecycle-nonrepo-"));
    plainTempDirs.push(cwd);
    const harness = await buildHarness({ cwd });

    await triggerSessionStart(harness);

    // 发现工作区现在只发生在 connectWorkspaceClients 内部（经由 WorkspaceClients.create），
    // 所以 connect 仍会被尝试一次；只是拿到的 workspace().repos 为空，随后判定为启动失败
    expect(harness.connectCalls.length).toBe(1);
    expect(harness.windowRegistryFactory.calls.length).toBe(0);
    expect(harness.notifications.length).toBe(1);

    let caught: unknown;
    try {
      windowContext();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("工作区");
  });
});

describe("窗口记录携带进程 pid", () => {
  test("登记记录的 pid 与假 process 的 pid 一致", async () => {
    const repo = await createRepoFixture();
    repoFixtures.push(repo);
    const harness = await buildHarness({ cwd: repo.root });
    await triggerSessionStart(harness);

    const registry = harness.windowRegistryFactory.all()[0];
    expect(registry).toBeDefined();
    if (!registry) return;
    const [record] = await registry.list();
    expect(record?.pid).toBe(harness.fakeProcess.pid);
  });
});

describe("windowId 一致性", () => {
  test("hello 的 windowId、windowContext() 与仓库登记记录三者相同", async () => {
    const repo = await createRepoFixture();
    repoFixtures.push(repo);
    const harness = await buildHarness({ cwd: repo.root });
    await triggerSessionStart(harness);

    const helloWindowId = harness.connectCalls[0]?.windowId;
    expect(typeof helloWindowId).toBe("string");

    const ctxWindowId = windowContext().windowId;
    expect(ctxWindowId).toBe(helloWindowId);

    const registry = harness.windowRegistryFactory.all()[0];
    expect(registry).toBeDefined();
    if (!registry) return;
    const recordWindowId = (await registry.list())[0]?.windowId;
    expect(recordWindowId).toBe(helloWindowId);
  });
});

describe("共享时钟", () => {
  test("createClock 只被调用一次，且 createShellRegistry 收到的时钟与心跳所用时钟是同一实例", async () => {
    const repo = await createRepoFixture();
    repoFixtures.push(repo);
    const harness = await buildHarness({ cwd: repo.root });
    await triggerSessionStart(harness);

    expect(harness.clockCalls()).toBe(1);

    const windowRegistryClock = harness.windowRegistryFactory.clocksSeen[0];
    const shellRegistryClock = harness.shellRegistryClockSeen();
    expect(windowRegistryClock).toBeDefined();
    expect(shellRegistryClock).toBeDefined();
    expect(shellRegistryClock).toBe(windowRegistryClock);
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
