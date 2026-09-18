import { AsyncLocalStorage } from "node:async_hooks";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { currentHostGit, exportGitExpectation, parseGitExpectation } from "./git-runtime.mjs";
import type { GitExpectation } from "./git-runtime.mjs";

export interface GitProcessObserver {
  started(groupId: number): void;
  /** worker已独立重建并由父进程比对后的固定身份；仅供受信进程登记/测试，不是授权。 */
  ready?(groupId: number, identityKey: string, executablePath: string): void;
  running?(groupId: number, command: string): void;
  finished(groupId: number): void;
}
interface GitCommand {
  executable: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  input?: string | Buffer;
  timeout: number;
  maxBuffer: number;
  command: string;
  /** 可信调用方给出的本次业务排除根；worker只会追加，不能减少父绑定范围。 */
  excludedRoots?: readonly string[];
}
interface CapturedGitCommand extends Omit<GitCommand, "args" | "env" | "input" | "excludedRoots"> {
  args: string[];
  env: NodeJS.ProcessEnv;
  input?: Buffer;
  excludedRoots: string[];
}
interface GitResult { stdout: Buffer; stderr: Buffer; exitCode: number; timedOut: boolean; overflow: boolean; spawnCode?: string }
interface PendingRun {
  id: number;
  command: CapturedGitCommand;
  expectation: GitExpectation;
  resolve: (value: GitResult) => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class GitProcessError extends Error {
  readonly code: string;
  constructor(code: string) { super(`Git 子进程收尾未完成：${code}`); this.name = "GitProcessError"; this.code = code; }
}

function bindingFailure(): GitProcessError {
  return new GitProcessError("git_binding_invalid");
}

function assertSynchronousObserverResult(result: unknown): void {
  if ((typeof result !== "object" || result === null) && typeof result !== "function") return;
  try {
    const handled = Reflect.apply(Promise.prototype.then, result, [() => undefined, () => undefined]) as Promise<unknown>;
    void handled;
    throw new GitProcessError("observer_async_result");
  } catch (error) {
    if (error instanceof GitProcessError) throw error;
  }
  try {
    let current: object | null = result as object;
    while (current) {
      const descriptor = Object.getOwnPropertyDescriptor(current, "then");
      if (descriptor) {
        if (!("value" in descriptor) || typeof descriptor.value === "function") {
          throw new GitProcessError("observer_async_result");
        }
        return;
      }
      current = Object.getPrototypeOf(current) as object | null;
    }
  } catch (error) {
    if (error instanceof GitProcessError) throw error;
    throw new GitProcessError("observer_result_invalid");
  }
}

function callSynchronousObserver(callback: (() => unknown) | undefined): void {
  if (!callback) return;
  assertSynchronousObserverResult(callback());
}

function captureCommand(command: GitCommand): CapturedGitCommand {
  const args = [...command.args];
  if (args.some((arg) => typeof arg !== "string") || typeof command.executable !== "string"
    || typeof command.cwd !== "string" || typeof command.command !== "string"
    || !Number.isSafeInteger(command.timeout) || command.timeout <= 0
    || !Number.isSafeInteger(command.maxBuffer) || command.maxBuffer <= 0) {
    throw new GitProcessError("command_invalid");
  }
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(command.env)) {
    if (value !== undefined && typeof value !== "string") throw new GitProcessError("command_invalid");
    env[name] = value;
  }
  const additions = command.excludedRoots === undefined ? [] : [...command.excludedRoots];
  if (additions.some((root) => typeof root !== "string")) throw new GitProcessError("command_invalid");
  const excludedRoots = [...new Set([...additions, command.cwd])];
  const input = command.input === undefined ? undefined : Buffer.from(command.input);
  return {
    executable: command.executable,
    args,
    cwd: command.cwd,
    env,
    ...(input === undefined ? {} : { input }),
    timeout: command.timeout,
    maxBuffer: command.maxBuffer,
    command: command.command,
    excludedRoots,
  };
}

function expectationFor(command: CapturedGitCommand, fixedIdentityKey?: string): GitExpectation {
  let binding;
  let expectation: GitExpectation;
  try {
    binding = currentHostGit(command.excludedRoots);
    expectation = parseGitExpectation(exportGitExpectation(command.excludedRoots));
  } catch {
    throw bindingFailure();
  }
  if (binding.executablePath !== command.executable
    || (fixedIdentityKey !== undefined && expectation.identityKey !== fixedIdentityKey)) throw bindingFailure();
  return expectation;
}

export function gitProcessGroupAlive(groupId: number): boolean {
  try { process.kill(-groupId, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

function waitWithTimeout<T>(promise: Promise<T>, timeout: number, onTimeout: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => { onTimeout(); reject(new GitProcessError("worker_start_timeout")); }, timeout);
    promise.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
  });
}

class GitProcessSession {
  private worker?: ReturnType<typeof spawn>;
  private exited?: Promise<void>;
  private registered = false;
  private nextId = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private pending?: PendingRun;
  private ready?: Promise<void>;
  private identityKey?: string;
  private executablePath?: string;
  private gitAttempted = false;
  private readonly knownRoots = new Set<string>();
  constructor(privateObserver?: GitProcessObserver) { this.observer = privateObserver; }
  private readonly observer?: GitProcessObserver;

  private rememberExpectation(expectation: GitExpectation, command: CapturedGitCommand): void {
    for (const root of [...expectation.excludedRootInputs, ...expectation.excludedRoots, ...command.excludedRoots]) {
      this.knownRoots.add(root);
    }
  }

  private assertFinalBinding(): void {
    if (!this.gitAttempted) return;
    let binding;
    let expectation: GitExpectation;
    try {
      binding = currentHostGit([...this.knownRoots]);
      expectation = parseGitExpectation(exportGitExpectation([...this.knownRoots]));
    } catch {
      throw bindingFailure();
    }
    if (!this.identityKey || !this.executablePath || binding.executablePath !== this.executablePath
      || expectation.identityKey !== this.identityKey || expectation.executablePath !== this.executablePath) {
      throw bindingFailure();
    }
  }

  private rejectPending(error: unknown): void {
    const pending = this.pending;
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending = undefined;
    pending.reject(error);
  }

  private send(message: object): Promise<void> {
    const worker = this.worker;
    if (!worker?.connected || !worker.send) return Promise.reject(new GitProcessError("worker_disconnected"));
    return new Promise((resolve, reject) => worker.send!(message, (error) => error ? reject(error) : resolve()));
  }

  private async start(command: CapturedGitCommand): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = this.startOnce(command);
    void this.ready.catch(() => undefined);
    return this.ready;
  }

  private async startOnce(command: CapturedGitCommand): Promise<void> {
    if (process.platform === "win32") throw new GitProcessError("process_group_unavailable");
    const initial = expectationFor(command);
    const worker = spawn(process.execPath, [fileURLToPath(new URL("./git-process-runner.mjs", import.meta.url))], {
      cwd: command.cwd,
      env: command.env,
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      detached: true,
      windowsHide: true,
    });
    this.worker = worker;
    this.exited = new Promise((resolve) => worker.once("close", () => resolve()));

    let bootstrapResolve!: () => void, bootstrapReject!: (error: unknown) => void;
    const bootstrap = new Promise<void>((resolve, reject) => { bootstrapResolve = resolve; bootstrapReject = reject; });
    let initResolve!: (message: { identityKey: string; executablePath: string }) => void, initReject!: (error: unknown) => void;
    const initialized = new Promise<{ identityKey: string; executablePath: string }>((resolve, reject) => {
      initResolve = resolve;
      initReject = reject;
    });
    void bootstrap.catch(() => undefined);
    void initialized.catch(() => undefined);

    worker.once("error", (error) => { bootstrapReject(error); initReject(error); this.rejectPending(error); });
    worker.once("close", () => {
      const error = new GitProcessError("worker_exited");
      bootstrapReject(error);
      initReject(error);
      this.rejectPending(error);
    });
    worker.on("message", (raw: unknown) => {
      if (!raw || typeof raw !== "object") { this.rejectPending(new GitProcessError("worker_protocol_invalid")); this.stop(); return; }
      const message = raw as Record<string, unknown>;
      if (message.type === "bootstrap-ready") { bootstrapResolve(); return; }
      if (message.type === "ready") {
        if (typeof message.identityKey !== "string" || typeof message.executablePath !== "string") {
          initReject(new GitProcessError("worker_protocol_invalid")); this.stop(); return;
        }
        initResolve({ identityKey: message.identityKey, executablePath: message.executablePath });
        return;
      }
      if (message.type === "init-failed") { initReject(bindingFailure()); this.stop(); return; }
      const pending = this.pending;
      if (!pending || message.id !== pending.id) return;
      if (message.type === "started") {
        try {
          if (message.identityKey !== pending.expectation.identityKey) throw bindingFailure();
          expectationFor(pending.command, pending.expectation.identityKey);
          callSynchronousObserver(this.observer?.running
            ? () => this.observer!.running!(worker.pid!, pending.command.command)
            : undefined);
          expectationFor(pending.command, pending.expectation.identityKey);
          void this.send({ type: "input", id: pending.id,
            input: pending.command.input === undefined ? undefined : pending.command.input.toString("base64"),
            identityKey: pending.expectation.identityKey }).catch((error) => { this.rejectPending(error); this.stop(); });
        } catch (error) { this.rejectPending(error); this.stop(); }
        return;
      }
      if (message.type === "binding-failed") { this.rejectPending(bindingFailure()); this.stop(); return; }
      if (message.type === "result") {
        try {
          if (message.identityKey !== pending.expectation.identityKey) throw bindingFailure();
          expectationFor(pending.command, pending.expectation.identityKey);
          if (typeof message.stdout !== "string" || typeof message.stderr !== "string"
            || !Number.isSafeInteger(message.code) || typeof message.timedOut !== "boolean"
            || typeof message.overflow !== "boolean"
            || (message.spawnCode !== undefined && typeof message.spawnCode !== "string")) {
            throw new GitProcessError("worker_protocol_invalid");
          }
          const result: GitResult = {
            stdout: Buffer.from(message.stdout, "base64"),
            stderr: Buffer.from(message.stderr, "base64"),
            exitCode: message.code as number,
            timedOut: message.timedOut,
            overflow: message.overflow,
            ...(message.spawnCode === undefined ? {} : { spawnCode: message.spawnCode }),
          };
          clearTimeout(pending.timer);
          this.pending = undefined;
          pending.resolve(result);
        } catch (error) { this.rejectPending(error); this.stop(); }
      }
    });

    if (!worker.pid) { this.stop(); throw new GitProcessError("worker_not_started"); }
    try {
      callSynchronousObserver(this.observer ? () => this.observer!.started(worker.pid!) : undefined);
      this.registered = this.observer !== undefined;
    } catch (error) {
      this.stop();
      throw error;
    }

    await waitWithTimeout(bootstrap, 10_000, () => this.stop());
    const beforeInit = expectationFor(command, initial.identityKey);
    this.rememberExpectation(beforeInit, command);
    this.identityKey = beforeInit.identityKey;
    this.executablePath = beforeInit.executablePath;
    this.gitAttempted = true;
    await this.send({ type: "git-init", expected: beforeInit, cwd: command.cwd,
      excludedRoots: command.excludedRoots, identityKey: beforeInit.identityKey });
    const ready = await waitWithTimeout(initialized, 10_000, () => this.stop());
    expectationFor(command, beforeInit.identityKey);
    if (ready.identityKey !== beforeInit.identityKey || ready.executablePath !== command.executable) {
      this.stop();
      throw bindingFailure();
    }
    callSynchronousObserver(this.observer?.ready
      ? () => this.observer!.ready!(worker.pid!, beforeInit.identityKey, ready.executablePath)
      : undefined);
    expectationFor(command, beforeInit.identityKey);
  }

  private stop(): void {
    const worker = this.worker;
    if (!worker?.pid || worker.exitCode !== null || worker.signalCode !== null) return;
    try { process.kill(-worker.pid, "SIGKILL"); } catch { /* 真实退出由 close 及进程组检查确认。 */ }
  }

  run(rawCommand: GitCommand): Promise<GitResult> {
    let command: CapturedGitCommand;
    try { command = captureCommand(rawCommand); }
    catch (error) { return Promise.reject(error); }
    const pending = this.queue.then(async () => {
      await this.start(command);
      const identityKey = this.identityKey;
      if (!identityKey) throw bindingFailure();
      const expectation = expectationFor(command, identityKey);
      this.rememberExpectation(expectation, command);
      return new Promise<GitResult>((resolve, reject) => {
        const id = ++this.nextId;
        const timer = setTimeout(() => {
          if (this.pending?.id === id) this.pending = undefined;
          this.stop();
          reject(new GitProcessError("command_timeout"));
        }, command.timeout + 1_000);
        this.pending = { id, command, expectation, resolve, reject, timer };
        void this.send({ type: "run", id, executable: command.executable, args: command.args,
          cwd: command.cwd, env: command.env, timeout: command.timeout, maxBuffer: command.maxBuffer,
          expected: expectation, identityKey: expectation.identityKey, excludedRoots: command.excludedRoots })
          .catch((error) => { this.rejectPending(error); this.stop(); });
      });
    });
    this.queue = pending.catch(() => undefined);
    return pending;
  }

  async close(): Promise<void> {
    const worker = this.worker;
    if (!worker?.pid || !this.exited) return;
    if (worker.connected) await this.send({ type: "shutdown" }).catch(() => undefined);
    const timer = setTimeout(() => this.stop(), 2_000);
    try { await this.exited; } finally { clearTimeout(timer); }
    const deadline = performance.now() + 2_000;
    while (gitProcessGroupAlive(worker.pid) && performance.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    if (gitProcessGroupAlive(worker.pid)) throw new GitProcessError("group_still_active");
    let hookError: unknown;
    let bindingError: unknown;
    try {
      callSynchronousObserver(this.registered && this.observer ? () => this.observer!.finished(worker.pid!) : undefined);
    } catch (error) { hookError = error; }
    try { this.assertFinalBinding(); }
    catch (error) { bindingError = error; }
    if (hookError !== undefined && bindingError !== undefined) {
      const combined = new AggregateError([hookError, bindingError], "Git finished hook 与最终绑定核验均失败") as AggregateError & { code: string };
      combined.code = bindingError instanceof GitProcessError ? bindingError.code : "git_binding_invalid";
      throw combined;
    }
    if (hookError !== undefined) throw hookError;
    if (bindingError !== undefined) throw bindingError;
  }
}

const sessions = new AsyncLocalStorage<GitProcessSession>();
export async function withGitProcessSession<T>(observer: GitProcessObserver | undefined, operation: () => Promise<T>): Promise<T> {
  const session = new GitProcessSession(observer);
  try { return await sessions.run(session, operation); }
  finally { await session.close(); }
}
export function runManagedGit(command: GitCommand): Promise<GitResult> {
  const session = sessions.getStore();
  if (!session) throw new GitProcessError("session_missing");
  return session.run(command);
}
