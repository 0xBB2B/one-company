import { globalDatabase, uuidv7 } from "../runtime/database.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createClock } from "../runtime/clock.ts";
import type { Clock } from "../runtime/clock.ts";
import { WorkspaceClients, resolveSdkDir } from "../runtime/daemon-client.ts";
import type { BottomDock } from "../runtime/dock.ts";
import type { WorkspaceClientsHandle } from "../runtime/daemon-client.ts";
import { dataRoot, repoDataDir } from "../runtime/identity.ts";
import type { Workspace, WorkspaceRepo } from "../runtime/identity.ts";
import { ShellRegistry } from "../runtime/shell-registry.ts";
import type { Host, StopResult } from "../runtime/shell-registry.ts";
import { currentBootId, processStartedAt, startHeartbeat, WindowRegistry } from "../runtime/windows.ts";

const EXIT_SIGNALS: NodeJS.Signals[] = ["SIGTERM", "SIGHUP"];
const SHELL_STOP_BUDGET_MS = 3_000;
const BEFORE_SWITCH_STOP_BUDGET_MS = 15_000;

export interface LifecycleDeps {
  createClock?: () => Clock;
  createShellRegistry?: (clock: Clock) => ShellRegistry;
  createWindowRegistry?: (input: { repo: WorkspaceRepo; clock: Clock }) => Promise<WindowRegistry>;
  connectWorkspaceClients?: (input: {
    windowId: string;
    sessionId: string;
    cwd: string;
  }) => Promise<WorkspaceClientsHandle>;
  process?: NodeJS.Process;
}

export interface WindowContextValue {
  shellRegistry?: ShellRegistry;
  windowId: string;
  sessionId: string;
  workspace: Workspace;
  clients: WorkspaceClientsHandle;
  heartbeatError?: string;
}

interface RepoRegistration {
  repoId: string;
  registry: WindowRegistry;
  stopHeartbeat: () => void;
}

export interface UnregisterFailure {
  repoId: string;
  reason: string;
}

export interface ShutdownResult {
  unregisterFailures: UnregisterFailure[];
}

interface ActiveWindow {
  windowId: string;
  sessionId: string;
  workspace: Workspace;
  clients: WorkspaceClientsHandle;
  shellRegistry: ShellRegistry;
  registrations: RepoRegistration[];
  heartbeatError?: string;
}

interface ReadyController {
  promise: Promise<WindowContextValue>;
  settled: boolean;
  resolve: (value: WindowContextValue) => void;
  reject: (error: Error) => void;
}

function createReadyController(): ReadyController {
  let resolveFn!: (value: WindowContextValue) => void;
  let rejectFn!: (error: Error) => void;
  const promise = new Promise<WindowContextValue>((resolve, reject) => {
    resolveFn = resolve;
    rejectFn = reject;
  });
  // 没人等待窗口就绪时，一次启动失败不应该被当成未处理的拒绝告警
  promise.catch(() => {});
  const controller: ReadyController = {
    promise,
    settled: false,
    resolve: (value) => {
      controller.settled = true;
      resolveFn(value);
    },
    reject: (error) => {
      controller.settled = true;
      rejectFn(error);
    },
  };
  return controller;
}

let activeWindow: ActiveWindow | undefined;
let startupError: Error | undefined;
let readyController = createReadyController();
let capturedShutdown: (() => void) | undefined;
let sharedDock: BottomDock | undefined;

function ensureFreshReadyController(): void {
  if (readyController.settled) readyController = createReadyController();
}

function defaultCreateClock(): Clock {
  return createClock();
}

function defaultCreateShellRegistry(clock: Clock): ShellRegistry {
  return new ShellRegistry({ clock, database: globalDatabase(dataRoot(process.env)) });
}

async function defaultCreateWindowRegistry(input: { repo: WorkspaceRepo; clock: Clock }): Promise<WindowRegistry> {
  const repoDir = await repoDataDir(dataRoot(process.env), input.repo.repoId, input.repo.commonDir);
  return new WindowRegistry({ repoDir, clock: input.clock, bootId: currentBootId, processStartedAt });
}

async function defaultConnectWorkspaceClients(input: {
  windowId: string;
  sessionId: string;
  cwd: string;
}): Promise<WorkspaceClientsHandle> {
  return WorkspaceClients.create({
    workspaceRoot: input.cwd,
    dataRoot: dataRoot(process.env),
    sdkDir: resolveSdkDir(),
    hello: {
      windowId: input.windowId,
      pid: process.pid,
      sessionId: input.sessionId,
      cwd: input.cwd,
      workspaceRoot: input.cwd,
    },
  });
}

function raceOrTimeout<T>(promise: Promise<T>, ms: number): Promise<T | "timeout"> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve("timeout"), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function stopFailureReason(result: StopResult): string | undefined {
  if (!result.ok) return result.reason;
  return result.task.status === "uncertain" ? (result.task.reason ?? "停止未确认") : undefined;
}

interface StartWindowInput {
  cwd: string;
  sessionId: string;
  processPid: number;
  notify: (message: string, level?: "info" | "warning" | "error") => void;
  resolveClock: () => Clock;
  resolveShellRegistry: (clock: Clock) => ShellRegistry;
  createWindowRegistry: (input: { repo: WorkspaceRepo; clock: Clock }) => Promise<WindowRegistry>;
  connectWorkspaceClients: (input: {
    windowId: string;
    sessionId: string;
    cwd: string;
  }) => Promise<WorkspaceClientsHandle>;
}

async function startWindow(input: StartWindowInput): Promise<void> {
  ensureFreshReadyController();
  const windowId = uuidv7();
  let clients: WorkspaceClientsHandle | undefined;
  const registrations: RepoRegistration[] = [];
  try {
    clients = await input.connectWorkspaceClients({ windowId, sessionId: input.sessionId, cwd: input.cwd });
    const workspace = clients.workspace();
    if (workspace.repos.length === 0) {
      throw new Error(`工作区（${input.cwd}）内未发现任何 Git 仓库，窗口无法登记`);
    }

    const clock = input.resolveClock();
    const shellRegistry = input.resolveShellRegistry(clock);
    for (const repo of workspace.repos) {
      const registry = await input.createWindowRegistry({ repo, clock });
      await registry.register({
        windowId,
        pid: input.processPid,
        sessionId: input.sessionId,
        cwd: input.cwd,
        workspaceRoot: input.cwd,
      });
      const stopHeartbeat = startHeartbeat(registry, windowId, (error) => {
        if (activeWindow) activeWindow.heartbeatError = (error as Error).message;
      });
      registrations.push({ repoId: repo.repoId, registry, stopHeartbeat });
    }

    startupError = undefined;
    activeWindow = { windowId, sessionId: input.sessionId, workspace, clients, shellRegistry, registrations };
    readyController.resolve(windowContext());
  } catch (error) {
    for (const reg of registrations) {
      reg.stopHeartbeat();
      await reg.registry.unregister(windowId).catch(() => {});
    }
    clients?.closeAll();
    const err = error instanceof Error ? error : new Error(String(error));
    startupError = err;
    input.notify(err.message, "error");
    readyController.reject(err);
  }
}

interface NotifyCtx {
  ui: { notify(message: string, level?: "info" | "warning" | "error"): void };
}

async function guardBeforeSwitch(ctx: NotifyCtx): Promise<{ cancel: boolean }> {
  if (!activeWindow) {
    ctx.ui.notify("窗口未启动，无法确认本窗口 Shell 已停止", "error");
    return { cancel: true };
  }
  const window = activeWindow;
  const host: Host = { kind: "main", id: window.windowId };
  let outcome: Array<{ taskId: string; result: StopResult }> | "timeout";
  try {
    outcome = await raceOrTimeout(window.shellRegistry.stopHost(host), BEFORE_SWITCH_STOP_BUDGET_MS);
  } catch (error) {
    ctx.ui.notify((error as Error).message, "error");
    return { cancel: true };
  }
  if (outcome === "timeout") {
    ctx.ui.notify(`确认本窗口 Shell 已停止超时（${BEFORE_SWITCH_STOP_BUDGET_MS / 1000} 秒）`, "error");
    return { cancel: true };
  }
  const reasons = outcome.map(({ result }) => stopFailureReason(result)).filter((reason): reason is string => reason !== undefined);
  if (reasons.length > 0) {
    ctx.ui.notify(reasons.join("; "), "error");
    return { cancel: true };
  }
  return { cancel: false };
}

export async function shutdownWindow(budgetMs?: number): Promise<ShutdownResult> {
  const window = activeWindow;
  if (!window) return { unregisterFailures: [] };
  activeWindow = undefined;
  const unregisterFailures: UnregisterFailure[] = [];
  try {
    const host: Host = { kind: "main", id: window.windowId };
    const stopSettled = window.shellRegistry.stopHost(host).catch(() => undefined);
    await (budgetMs === undefined ? stopSettled : raceOrTimeout(stopSettled, budgetMs));
    for (const reg of window.registrations) {
      try {
        await reg.registry.unregister(window.windowId);
      } catch (error) {
        unregisterFailures.push({ repoId: reg.repoId, reason: (error as Error).message });
      }
    }
  } finally {
    for (const reg of window.registrations) reg.stopHeartbeat();
    startupError = undefined;
    readyController = createReadyController();
    capturedShutdown = undefined;
    window.clients.closeAll();
  }
  return { unregisterFailures };
}

const installedSignalHandlers = new WeakSet<NodeJS.Process>();

export function installExitSignalHandlers(proc: NodeJS.Process): void {
  if (installedSignalHandlers.has(proc)) return;
  installedSignalHandlers.add(proc);
  for (const signal of EXIT_SIGNALS) {
    proc.on(signal, () => {
      // shutdownWindow 会在自己的清理里清空 capturedShutdown，这里先取快照，
      // 否则触发本次信号的回调在 shutdownWindow 完成后已经读不到它
      const shutdownCallback = capturedShutdown;
      void shutdownWindow(SHELL_STOP_BUDGET_MS).finally(() => {
        try {
          shutdownCallback?.();
        } catch {
          // 通知宿主关闭失败不应影响信号处理器已完成的窗口清理
        }
      });
    });
  }
}

export function windowContext(): WindowContextValue {
  if (!activeWindow) throw startupError ?? new Error("窗口未启动");
  const { windowId, sessionId, workspace, clients, heartbeatError, shellRegistry } = activeWindow;
  return { windowId, sessionId, workspace, clients, heartbeatError, shellRegistry };
}

export function windowReady(): Promise<WindowContextValue> {
  return readyController.promise;
}

export function registerDock(dock: BottomDock | undefined): void {
  sharedDock = dock;
}

export function currentDock(): BottomDock | undefined {
  return sharedDock;
}

export default function lifecycleExtension(pi: ExtensionAPI, deps: LifecycleDeps = {}): void {
  const proc = deps.process ?? process;
  const createClockDep = deps.createClock ?? defaultCreateClock;
  const createShellRegistryDep = deps.createShellRegistry ?? defaultCreateShellRegistry;
  const createWindowRegistryDep = deps.createWindowRegistry ?? defaultCreateWindowRegistry;
  const connectWorkspaceClients = deps.connectWorkspaceClients ?? defaultConnectWorkspaceClients;

  let cachedClock: Clock | undefined;
  let cachedShellRegistry: ShellRegistry | undefined;

  function resolveClock(): Clock {
    if (!cachedClock) cachedClock = createClockDep();
    return cachedClock;
  }

  function resolveShellRegistry(clock: Clock): ShellRegistry {
    if (!cachedShellRegistry) cachedShellRegistry = createShellRegistryDep(clock);
    return cachedShellRegistry;
  }

  pi.on("session_start", async (_event, ctx) => {
    capturedShutdown = ctx.shutdown;
    await startWindow({
      cwd: ctx.cwd,
      sessionId: ctx.sessionManager.getSessionId(),
      processPid: proc.pid,
      notify: ctx.ui.notify,
      resolveClock,
      resolveShellRegistry,
      createWindowRegistry: createWindowRegistryDep,
      connectWorkspaceClients,
    });
    installExitSignalHandlers(proc);
  });

  pi.on("session_before_switch", async (_event, ctx) => guardBeforeSwitch(ctx));
  pi.on("session_before_fork", async (_event, ctx) => guardBeforeSwitch(ctx));

  pi.on("session_shutdown", async (_event, ctx) => {
    const result = await shutdownWindow();
    for (const failure of result.unregisterFailures) {
      ctx.ui.notify(`仓库 ${failure.repoId} 注销失败：${failure.reason}`, "error");
    }
  });
}
