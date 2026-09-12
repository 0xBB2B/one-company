import { AsyncLocalStorage } from "node:async_hooks";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export interface GitProcessObserver {
  started(groupId: number): void;
  running?(groupId: number, command: string): void;
  finished(groupId: number): void;
}
interface GitCommand {
  executable: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv;
  input?: string | Buffer; timeout: number; maxBuffer: number; command: string;
}
interface GitResult { stdout: Buffer; stderr: Buffer; exitCode: number; timedOut: boolean; overflow: boolean; spawnCode?: string }
export class GitProcessError extends Error {
  readonly code: string;
  constructor(code: string) { super(`Git 子进程收尾未完成：${code}`); this.name = "GitProcessError"; this.code = code; }
}
export function gitProcessGroupAlive(groupId: number): boolean {
  try { process.kill(-groupId, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}
class GitProcessSession {
  private worker?: ReturnType<typeof spawn>;
  private exited?: Promise<void>;
  private registered = false;
  private nextId = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private pending?: { id: number; command: GitCommand; resolve: (value: GitResult) => void; reject: (error: unknown) => void; timer: ReturnType<typeof setTimeout> };
  private ready?: Promise<void>;
  constructor(privateObserver?: GitProcessObserver) { this.observer = privateObserver; }
  private readonly observer?: GitProcessObserver;

  private async start(command: GitCommand): Promise<void> {
    if (this.ready) return this.ready;
    if (process.platform === "win32") throw new GitProcessError("process_group_unavailable");
    const worker = spawn(process.execPath, [fileURLToPath(new URL("./git-process-runner.mjs", import.meta.url))], {
      cwd: command.cwd, env: command.env, stdio: ["ignore", "ignore", "ignore", "ipc"], detached: true, windowsHide: true,
    });
    this.worker = worker;
    this.exited = new Promise((resolve) => worker.once("close", () => resolve()));
    this.ready = new Promise<void>((resolve, reject) => {
      worker.once("error", reject);
      worker.once("close", () => {
        reject(new GitProcessError("worker_exited"));
        if (this.pending) { clearTimeout(this.pending.timer); this.pending.reject(new GitProcessError("worker_exited")); this.pending = undefined; }
      });
      worker.on("message", (raw: unknown) => {
        const message = raw as { type?: string; id?: number; code?: number; stdout?: string; stderr?: string; timedOut?: boolean; overflow?: boolean; spawnCode?: string };
        if (message.type === "ready") { resolve(); return; }
        const pending = this.pending;
        if (!pending || pending.id !== message.id) return;
        if (message.type === "started") {
          try {
            this.observer?.running?.(worker.pid!, pending.command.command);
            worker.send!({ type: "input", id: pending.id, input: pending.command.input === undefined ? undefined : Buffer.from(pending.command.input).toString("base64") });
          } catch (error) { pending.reject(error); this.stop(); }
        } else if (message.type === "result") {
          clearTimeout(pending.timer);
          this.pending = undefined;
          pending.resolve({ stdout: Buffer.from(message.stdout ?? "", "base64"), stderr: Buffer.from(message.stderr ?? "", "base64"), exitCode: message.code ?? -1, timedOut: message.timedOut === true, overflow: message.overflow === true, spawnCode: message.spawnCode });
        }
      });
    });
    void this.ready.catch(() => undefined);
    if (!worker.pid) throw new GitProcessError("worker_not_started");
    this.registered = true;
    // 必须先持久登记进程组，再给辅助进程任何执行 Git 的消息。
    this.observer?.started(worker.pid);
    const timer = setTimeout(() => this.stop(), 10_000);
    try { await this.ready; } finally { clearTimeout(timer); }
  }
  private stop(): void {
    const worker = this.worker;
    if (!worker?.pid || worker.exitCode !== null || worker.signalCode !== null) return;
    try { process.kill(-worker.pid, "SIGKILL"); } catch { /* 实际退出由 close 及进程组检查确认。 */ }
  }
  run(command: GitCommand): Promise<GitResult> {
    const pending = this.queue.then(async () => {
      await this.start(command);
      const worker = this.worker!;
      return new Promise<GitResult>((resolve, reject) => {
        const id = ++this.nextId;
        const timer = setTimeout(() => { this.stop(); reject(new GitProcessError("command_timeout")); }, command.timeout + 1_000);
        this.pending = { id, command, resolve, reject, timer };
        worker.send!({ type: "run", id, executable: command.executable, args: command.args, cwd: command.cwd, env: command.env, timeout: command.timeout, maxBuffer: command.maxBuffer }, (error) => {
          if (error) { clearTimeout(timer); reject(error); this.stop(); }
        });
      });
    });
    this.queue = pending.catch(() => undefined);
    return pending;
  }
  async close(): Promise<void> {
    const worker = this.worker;
    if (!worker?.pid || !this.exited) return;
    if (worker.connected) worker.send!({ type: "shutdown" }, () => undefined);
    const timer = setTimeout(() => this.stop(), 2_000);
    try { await this.exited; } finally { clearTimeout(timer); }
    const deadline = performance.now() + 2_000;
    while (gitProcessGroupAlive(worker.pid) && performance.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    if (gitProcessGroupAlive(worker.pid)) throw new GitProcessError("group_still_active");
    if (this.registered) this.observer?.finished(worker.pid);
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
