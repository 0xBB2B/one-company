import { AsyncLocalStorage } from "node:async_hooks";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { lstat, mkdir, mkdtemp, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import type { Server, Socket } from "node:net";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";

type ClosableServer = Server | { close: () => Promise<void> | void };
interface ChildRecord {
  child: ChildProcess;
  closed: boolean;
  done: Promise<void>;
  spawnError?: Error;
  stopped?: Promise<void>;
}
interface SocketRecord { socket: Socket; closed: boolean; done: Promise<void> }
interface ServerRecord { close(): Promise<void>; closed: boolean }
interface Scope {
  closed: boolean;
  pending: Set<Promise<unknown>>;
  roots: Map<string, { dev: number; ino: number } | null>;
  children: Set<ChildRecord>;
  sockets: Set<SocketRecord>;
  servers: Set<ServerRecord>;
  cleanup?: Promise<void>;
  closingHooks: Set<() => Promise<void>>;
  retained: unknown[];
}
const context = new AsyncLocalStorage<Scope>();
const scopes = new Set<Scope>();
const childRecords = new WeakMap<ChildProcess, { scope: Scope; record: ChildRecord }>();
const CLOSE_MS = 1_000;
const OUTPUT_BYTES = 2 * 1024 * 1024;

function currentScope(): Scope {
  const scope = context.getStore();
  if (!scope) throw new Error("Git daemon夹具必须在独立测试scope中运行");
  return scope;
}
function assertOpen(scope: Scope): void {
  if (scope.closed) throw new Error("Git daemon夹具scope已关闭，禁止继续分配或执行");
}
function bounded<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([promise, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(label)), ms);
  })]).finally(() => clearTimeout(timer));
}
function operation<T>(scope: Scope, run: () => Promise<T>, cleanup = false): Promise<T> {
  if (!cleanup) assertOpen(scope);
  let resolve!: (value: T | PromiseLike<T>) => void, reject!: (error: unknown) => void;
  const pending = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  scope.pending.add(pending);
  void pending.then(() => scope.pending.delete(pending), () => scope.pending.delete(pending));
  try {
    Promise.resolve(run()).then((result) => {
      try { if (!cleanup) assertOpen(scope); resolve(result); }
      catch (error) { reject(error); }
    }, reject);
  } catch (error) { reject(error); }
  return pending;
}
function reportPreserved(scope: Scope, reason: string): void {
  console.error(JSON.stringify({ status: "git_daemon_fixture_preserved", reason, roots: [...scope.roots.keys()], pending: scope.pending.size }));
}
export async function withGitDaemonFixtures<T>(run: () => Promise<T>): Promise<T> {
  const scope: Scope = { closed: false, pending: new Set(), roots: new Map(), children: new Set(), sockets: new Set(), servers: new Set(), closingHooks: new Set(), retained: [] };
  scopes.add(scope);
  return context.run(scope, async () => {
    let failed = false, primary: unknown;
    try { return await run(); }
    catch (error) { failed = true; primary = error; throw error; }
    finally {
      try { await cleanupScope(scope); }
      catch (cleanupError) {
        if (failed) throw new AggregateError([primary, cleanupError], "测试执行及scope收尾均失败");
        throw cleanupError;
      }
    }
  });
}
export function ownedTempRoot(prefix: string): Promise<string> {
  const scope = currentScope();
  return operation(scope, async () => {
    const root = await mkdtemp(join(tmpdir(), prefix));
    scope.roots.set(root, null);
    if (scope.closed) reportPreserved(scope, "关闭期间分配完成，禁止后续写入和启动");
    const info = await lstat(root);
    scope.roots.set(root, { dev: info.dev, ino: info.ino });
    return root;
  });
}

export function registerOwnedSocket(socket: Socket): Socket {
  const scope = currentScope();
  assertOpen(scope);
  const record = { socket, closed: false } as SocketRecord;
  record.done = new Promise((resolve) => socket.once("close", () => { record.closed = true; resolve(); }));
  socket.on("error", () => { /* 调用方处理错误，夹具仍等待close。 */ });
  scope.sockets.add(record);
  return socket;
}
export function createOwnedSocket(path: string): Socket {
  assertOpen(currentScope());
  return registerOwnedSocket(createConnection(path));
}
export function registerOwnedServer<T extends ClosableServer>(server: T): T {
  const scope = currentScope();
  assertOpen(scope);
  const nativeClose = server.close.bind(server);
  const netServer = "address" in server;
  let closeEvent: Promise<void> | undefined;
  const record: ServerRecord = { closed: false, async close() {
    if (record.closed) return;
    if (netServer) {
      await bounded(new Promise<void>((resolve, reject) => {
        (nativeClose as (callback: (error?: Error) => void) => void)((error) => error ? reject(error) : resolve());
      }), CLOSE_MS, "server关闭回调超时");
      await bounded(closeEvent!, CLOSE_MS, "server未观察到close");
    } else {
      await bounded(Promise.resolve((nativeClose as () => Promise<void> | void)()), CLOSE_MS, "server关闭超时");
    }
    record.closed = true;
  } };
  if (netServer) closeEvent = new Promise((resolve) => (server as Server).once("close", () => resolve()));
  const target = server as unknown as { listen?: (...args: unknown[]) => unknown };
  const listen = target.listen?.bind(server);
  if (listen) {
    let started = false;
    target.listen = (...args) => {
      assertOpen(scope);
      if (started) throw new Error("测试server只允许一次listen");
      started = true;
      if (netServer) {
        const ready = operation(scope, () => new Promise<void>((resolve, reject) => {
          const actual = server as Server;
          const cleanup = () => { actual.removeListener("listening", onReady); actual.removeListener("error", onError); };
          const onReady = () => {
            cleanup();
            if (scope.closed) {
              record.closed = false;
              closeEvent = new Promise((done) => actual.once("close", () => done()));
              void record.close().then(resolve, (error) => { reportPreserved(scope, "迟到listener关闭失败"); reject(error); });
            } else resolve();
          };
          const onError = (error: Error) => { cleanup(); reject(error); };
          actual.once("listening", onReady); actual.once("error", onError);
          try { listen(...args); } catch (error) { cleanup(); reject(error); }
        }));
        void ready.catch(() => undefined);
        return server;
      }
      return operation(scope, async () => {
        const result = await listen(...args);
        if (scope.closed) {
          record.closed = false;
          try { await record.close(); }
          catch (error) { reportPreserved(scope, "迟到listener关闭失败"); throw error; }
        }
        return result;
      });
    };
  }
  scope.servers.add(record);
  return server;
}

export function isolatedGitEnvironment(home: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "", HOME: home, TMPDIR: tmpdir(), LANG: "C", LC_ALL: "C", JITI_FS_CACHE: "0",
    GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "git-daemon-fixture", GIT_AUTHOR_EMAIL: "git-daemon-fixture@example.invalid",
    GIT_COMMITTER_NAME: "git-daemon-fixture", GIT_COMMITTER_EMAIL: "git-daemon-fixture@example.invalid",
  };
  for (const [name, value] of Object.entries(extra)) {
    if (!["PATH", "HOME", "TMPDIR", "PI_CODING_AGENT_DIR"].includes(name) && !name.startsWith("ONE_COMPANY_")) {
      throw new Error(`夹具未允许的环境覆盖: ${name}`);
    }
    env[name] = value;
  }
  return env;
}
function groupGone(pid: number): boolean {
  try { process.kill(-pid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
}
function registerChild(scope: Scope, child: ChildProcess): ChildRecord {
  assertOpen(scope);
  const existing = childRecords.get(child);
  if (existing) {
    if (existing.scope !== scope) throw new Error("ChildProcess 已属于其他测试scope");
    return existing.record;
  }
  const record = { child, closed: false } as ChildRecord;
  record.done = new Promise((resolve) => child.once("close", () => { record.closed = true; resolve(); }));
  child.once("error", (error) => { record.spawnError = error; });
  scope.children.add(record);
  childRecords.set(child, { scope, record });
  return record;
}
export function createOwnedSpawner(): typeof spawn {
  const scope = currentScope();
  assertOpen(scope);
  const nativeSpawn = spawn;
  return ((...args: Parameters<typeof spawn>) => {
    assertOpen(scope);
    const options = args[2] ?? args[1];
    if (!options || typeof options !== "object" || Array.isArray(options) || !("detached" in options) || options.detached !== true) {
      throw new Error("自有进程必须使用独立进程组");
    }
    const child = nativeSpawn(...args);
    registerChild(scope, child);
    return child;
  }) as typeof spawn;
}

/** 绑定创建时的scope，旧异步链不能借用后来测试的scope。 */
export function captureFixtureScope() {
  const scope = currentScope();
  assertOpen(scope);
  return Object.freeze({
    assertOpen: () => assertOpen(scope),
    isClosed: () => scope.closed,
    run: <T>(run: () => Promise<T>) => operation(scope, run),
    cleanupOperation: <T>(run: () => Promise<T>) => operation(scope, run, true),
    onClosing(run: () => Promise<void>) { assertOpen(scope); scope.closingHooks.add(run); },
    preserve(error: unknown) { scope.retained.push(error); reportPreserved(scope, "外部资源尚未确认收尾"); },
  });
}
async function confirmChild(record: ChildRecord): Promise<void> {
  await bounded(record.done, CLOSE_MS, "子进程未观察到真实close");
  const pid = record.child.pid;
  if (!pid) {
    if (record.spawnError) return;
    throw new Error("子进程缺少可核对PID");
  }
  const deadline = performance.now() + CLOSE_MS;
  while (!groupGone(pid)) {
    if (performance.now() >= deadline) throw new Error(`自有进程组未确认消失: ${pid}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
function stopChild(record: ChildRecord): Promise<void> {
  if (record.stopped) return record.stopped;
  record.stopped = (async () => {
    const child = record.child;
    const signal = (value: NodeJS.Signals) => {
      // 非零信号只发给本次spawn且宿主尚未观察退出的活句柄；旧编号只作只读检查。
      if (!child.pid || record.closed || child.exitCode !== null || child.signalCode !== null) return;
      try { process.kill(-child.pid, value); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    };
    signal("SIGTERM");
    try { await bounded(record.done, 100, "TERM等待结束"); }
    catch { signal("SIGKILL"); }
    await confirmChild(record);
  })();
  return record.stopped;
}

export function runOwnedProcess(
  executable: string, args: readonly string[], cwd: string,
  options: { env?: NodeJS.ProcessEnv; timeoutMs?: number; home?: string } = {},
): Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }> {
  const scope = currentScope();
  return operation(scope, async () => {
    const home = options.home ?? await ownedTempRoot("git-daemon-process-home-");
    assertOpen(scope);
    if (![...scope.roots.keys()].some((root) => {
      const suffix = relative(root, home);
      return suffix === "" || (!isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith("../"));
    })) throw new Error("测试HOME不属于本scope");
    await mkdir(home, { recursive: true, mode: 0o700 });
    assertOpen(scope);
    const env = isolatedGitEnvironment(home, options.env);
    assertOpen(scope);
    const child = spawn(executable, [...args], { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const record = registerChild(scope, child);
    let failure: Error | undefined, total = 0;
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    const fail = (error: Error) => { failure ??= error; void stopChild(record).catch(() => undefined); };
    child.once("error", (error) => { record.spawnError = error; fail(error); });
    const collect = (target: Buffer[]) => (chunk: Buffer) => {
      if (failure) return;
      const left = OUTPUT_BYTES - total;
      const kept = chunk.subarray(0, Math.max(0, left));
      if (kept.length) target.push(Buffer.from(kept));
      total += chunk.length;
      if (total > OUTPUT_BYTES) fail(new Error(`自有子进程输出超限: ${OUTPUT_BYTES}字节`));
    };
    child.stdout!.on("data", collect(stdout)); child.stderr!.on("data", collect(stderr));
    const timeout = options.timeoutMs ?? 4_000;
    const timer = setTimeout(() => fail(new Error(`自有子进程超时: ${timeout}ms`)), timeout);
    try {
      await bounded(record.done, timeout + 2 * CLOSE_MS, "子进程close等待超时，保全scope");
      await (record.stopped ?? confirmChild(record));
      scope.children.delete(record);
      if (failure) throw failure;
      assertOpen(scope);
      return { code: child.exitCode, signal: child.signalCode, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") };
    } finally { clearTimeout(timer); }
  });
}
export async function runJsonChild(
  cwd: string, source: string, args: readonly string[] = [],
  options: { env?: NodeJS.ProcessEnv; timeoutMs?: number; home?: string } = {},
): Promise<Record<string, unknown>> {
  const result = await runOwnedProcess(process.execPath, ["--import", "jiti/register", "--input-type=module", "-e", source, ...args], cwd, options);
  assertOpen(currentScope());
  if (result.code !== 0) throw new Error(`自有子进程失败 code=${result.code} signal=${result.signal}: ${result.stderr}`);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

function cleanupScope(scope: Scope): Promise<void> {
  if (scope.cleanup) return scope.cleanup;
  scope.closed = true;
  scope.cleanup = (async () => {
    const errors: unknown[] = [];
    const attempt = async (run: () => Promise<void>) => { try { await run(); } catch (error) { errors.push(error); } };
    const closing = [...scope.closingHooks].map((run) => attempt(async () => {
      await bounded(Promise.resolve().then(run), 2 * CLOSE_MS, "外部资源关闭超时");
    }));
    await Promise.all([...closing, ...[...scope.children].map((record) => attempt(async () => { await stopChild(record); scope.children.delete(record); }))]);
    await Promise.all([...scope.sockets].map((record) => attempt(async () => {
      if (!record.closed) record.socket.destroy();
      await bounded(record.done, CLOSE_MS, "socket未观察到真实close");
      scope.sockets.delete(record);
    })));
    await attempt(async () => { await bounded(Promise.allSettled([...scope.pending]), 2 * CLOSE_MS, "夹具在途操作未完成"); });
    await Promise.all([...scope.servers].map((record) => attempt(async () => { await record.close(); scope.servers.delete(record); })));
    errors.push(...scope.retained);
    if (scope.pending.size || scope.children.size || scope.sockets.size || scope.servers.size) errors.push(new Error("仍有未完成的自有资源"));
    if (!errors.length) {
      for (const [root, identity] of [...scope.roots].reverse()) {
        await attempt(async () => {
          const current = await lstat(root);
          if (!identity || !current.isDirectory() || current.dev !== identity.dev || current.ino !== identity.ino) throw new Error(`根归属已变化: ${root}`);
          await rm(root, { recursive: true, force: true });
          scope.roots.delete(root);
        });
      }
    }
    if (errors.length) {
      reportPreserved(scope, "资源收尾未确认");
      throw new AggregateError(errors, `Git daemon夹具收尾失败；保全路径: ${[...scope.roots.keys()].join(", ") || "待在途分配回报"}`);
    }
  })().finally(() => scopes.delete(scope));
  return scope.cleanup;
}
export async function cleanupGitDaemonFixtures(): Promise<void> {
  const results = await Promise.allSettled([...scopes].map(cleanupScope));
  const errors = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
  if (errors.length) throw new AggregateError(errors, "Git daemon夹具scope收尾失败");
}
