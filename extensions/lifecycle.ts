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
  /** 可信前置撤权/收尾失败或未在信号预算内结束的数量。 */
  shutdownHookFailures?: number;
}

export type WindowShutdownHook = () => void | Promise<void>;
interface BoundShutdownHook {
  readonly windowId: string;
  readonly sessionId: string;
  readonly callback: WindowShutdownHook;
}
const windowShutdownHooks = new WeakMap<WorkspaceClientsHandle, Set<BoundShutdownHook>>();

/** 仅可信扩展登记：回调同步部分必须先撤销能力，返回值只等待其自有操作收尾。 */
export function registerWindowShutdownHook(
  window: Pick<WindowContextValue, "windowId" | "sessionId" | "clients">,
  callback: WindowShutdownHook,
): () => void {
  let hooks = windowShutdownHooks.get(window.clients);
  if (!hooks) { hooks = new Set(); windowShutdownHooks.set(window.clients, hooks); }
  if (hooks.size >= 32) throw new Error("窗口关闭订阅已满");
  const entry = Object.freeze({ windowId: window.windowId, sessionId: window.sessionId, callback });
  hooks.add(entry);
  return () => {
    hooks.delete(entry);
    if (hooks.size === 0 && windowShutdownHooks.get(window.clients) === hooks) windowShutdownHooks.delete(window.clients);
  };
}

function beginWindowShutdown(window: ActiveWindow): { count: number; settled: Promise<PromiseSettledResult<void>[]> } {
  const hooks = windowShutdownHooks.get(window.clients);
  const pending: Promise<void>[] = [];
  for (const hook of [...(hooks ?? [])]) {
    if (hook.windowId !== window.windowId || hook.sessionId !== window.sessionId) continue;
    hooks!.delete(hook);
    try { pending.push(Promise.resolve(hook.callback())); }
    catch (error) { pending.push(Promise.reject(error)); }
  }
  if (hooks?.size === 0) windowShutdownHooks.delete(window.clients);
  return { count: pending.length, settled: Promise.allSettled(pending) };
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
let shutdownOperation: Promise<ShutdownResult> | undefined;
let limitShutdownWait: ((ms: number) => void) | undefined;
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
    hello: { windowId: input.windowId, sessionId: input.sessionId },
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
  if (shutdownOperation) await shutdownOperation;
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

export function shutdownWindow(budgetMs?: number): Promise<ShutdownResult> {
  if (shutdownOperation) {
    if (budgetMs !== undefined) limitShutdownWait?.(budgetMs);
    return shutdownOperation;
  }
  const window = activeWindow;
  if (!window) return Promise.resolve({ unregisterFailures: [] });
  activeWindow = undefined;
  let complete!: (result: ShutdownResult) => void;
  let failed!: (error: unknown) => void;
  const pending = new Promise<ShutdownResult>((resolve, reject) => { complete = resolve; failed = reject; });
  shutdownOperation = pending;
  let deadline = Infinity;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let expire!: () => void;
  const budgetEnded = new Promise<void>((resolve) => { expire = resolve; });
  limitShutdownWait = (ms) => {
    const next = Date.now() + Math.max(0, ms);
    if (next >= deadline) return;
    deadline = next;
    if (timer) clearTimeout(timer);
    timer = setTimeout(expire, Math.max(0, deadline - Date.now()));
  };
  if (budgetMs !== undefined) limitShutdownWait(budgetMs);
  // 同步调用所有失效回调，之后才开始等待 Shell；此处保持原 daemon 通道可用。
  const hooks = beginWindowShutdown(window);
  const finish = async (): Promise<ShutdownResult> => {
    const unregisterFailures: UnregisterFailure[] = [];
    let hookResults: PromiseSettledResult<void>[] | undefined;
    let shutdownHookFailures = 0;
    const hooksSettled = hooks.settled.then((results) => { hookResults = results; });
    try {
      const host: Host = { kind: "main", id: window.windowId };
      const stopSettled = window.shellRegistry.stopHost(host).catch(() => undefined);
      const allSettled = Promise.all([stopSettled, hooksSettled]);
      await Promise.race([allSettled, budgetEnded]);
      shutdownHookFailures = hookResults?.filter((result) => result.status === "rejected").length ?? (hooks.count > 0 ? 1 : 0);
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
    return { unregisterFailures, ...(shutdownHookFailures ? { shutdownHookFailures } : {}) };
  };
  void finish().then(complete, failed);
  const clear = () => {
    if (timer) clearTimeout(timer);
    if (shutdownOperation === pending) { shutdownOperation = undefined; limitShutdownWait = undefined; }
  };
  void pending.then(clear, clear);
  return pending;
}

const installedSignalHandlers = new WeakSet<NodeJS.Process>();

export function installExitSignalHandlers(proc: NodeJS.Process): void {
  if (installedSignalHandlers.has(proc)) return;
  installedSignalHandlers.add(proc);
  for (const signal of EXIT_SIGNALS) {
    proc.on(signal, () => {
      // 先取快照再清空，使同轮多个退出信号只通知一次宿主关闭。
      const shutdownCallback = capturedShutdown;
      capturedShutdown = undefined;
      const finish = () => {
        try {
          shutdownCallback?.();
        } catch {
          // 通知宿主关闭失败不应影响信号处理器已完成的窗口清理
        }
      };
      void shutdownWindow(SHELL_STOP_BUDGET_MS).then(finish, finish);
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

/** 需求交互扩展登记给面板与规则扩展用的入口；各扩展是独立模块实例，只能经这里互通。 */
export interface RequirementInputBridge {
  revoke(): void;
  noteOpenedItem(item: { repoId: string; requirementId: string; itemId: string }): void;
  mentionNote(): string;
}
let requirementInput: RequirementInputBridge | undefined;
export function registerRequirementInput(bridge: RequirementInputBridge | undefined): void { requirementInput = bridge; }
export function revokeCapturedInput(): void { requirementInput?.revoke(); }
export function noteOpenedPanelItem(item: { repoId: string; requirementId: string; itemId: string }): void { requirementInput?.noteOpenedItem(item); }
export function currentMentionNote(): string { return requirementInput?.mentionNote() ?? ""; }

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
    if (activeWindow?.sessionId === ctx.sessionManager.getSessionId()) capturedShutdown = ctx.shutdown;
    installExitSignalHandlers(proc);
  });

  pi.on("session_before_switch", async (_event, ctx) => guardBeforeSwitch(ctx));
  pi.on("session_before_fork", async (_event, ctx) => guardBeforeSwitch(ctx));

  pi.on("session_shutdown", async (_event, ctx) => {
    const result = await shutdownWindow();
    if (result.shutdownHookFailures) ctx.ui.notify("窗口前置撤权或自有操作收尾未全部完成", "error");
    for (const failure of result.unregisterFailures) {
      ctx.ui.notify(`仓库 ${failure.repoId} 注销失败：${failure.reason}`, "error");
    }
  });
}
