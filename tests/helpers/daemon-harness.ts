import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { lstatSync } from "node:fs";
import { lstat, mkdtemp, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import type { Socket } from "node:net";
import { isAbsolute, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { socketPathByteLimit } from "../../daemon/lifecycle.ts";
import { controlToken } from "../../runtime/daemon-auth.ts";
import {
  createGitExpectationText,
  currentGitBinding,
  decodeGitExpectation,
  gitExpectationRoots,
  verifyPeerGitBinding,
} from "../../runtime/git-daemon-binding.ts";
import { daemonSocketPath, repositoryIdentity } from "../../runtime/identity.ts";
import { createRequest, decodeFrames, PROTOCOL_VERSION } from "../../runtime/protocol.ts";
import { temporaryRoot } from "./temporary-root.ts";
import { createRepoFixture, repoFixtureRootReceipt } from "./repo-fixture.ts";
import type { RepoFixture } from "./repo-fixture.ts";
import { createTempHome, tempHomeRootReceipt } from "./temp-home.ts";
import type { TempHome } from "./temp-home.ts";
import { initializeTestHostGit } from "./test-git-binding.ts";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const daemonMainEntry = join(packageRoot, "daemon", "bootstrap.mjs");
const DEFAULT_CONNECT_TIMEOUT_MS = 2_000;
const DEFAULT_RPC_TIMEOUT_MS = 15_000;
const DEFAULT_START_TIMEOUT_MS = 10_000;
const CLOSE_TIMEOUT_MS = 2_000;
const OUTPUT_BYTE_LIMIT = 2 * 1024 * 1024;
const FRAME_BUFFER_BYTE_LIMIT = 1024 * 1024;
const SOCKET_SUFFIX_LENGTH = "/sock/".length + 16 + ".sock".length;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REPO_ID_PATTERN = /^[0-9a-f]{64}$/;

interface RootIdentity { readonly path: string; readonly dev: number; readonly ino: number }
interface FixedHome {
  readonly home: string;
  readonly agentDir: string;
  readonly dataRoot: string;
  readonly env: Readonly<Record<string, string>>;
}
interface FixtureRecord {
  readonly fixtureRef: DaemonFixture;
  readonly roots: readonly RootIdentity[];
  readonly homeRef: TempHome;
  readonly repoRef: RepoFixture;
  readonly repoWorktreesRef: string[];
  readonly home: FixedHome;
  readonly repoRoot: string;
  readonly repoDir: string;
  readonly dataRoot: string;
  readonly socketPath: string;
  readonly repoId: string;
  readonly abort: AbortController;
  readonly launchRoots: Set<string>;
  fenced: boolean;
  closed: boolean;
  pending: Set<Promise<unknown>>;
  children: Set<ChildRecord>;
  sockets: Set<SocketRecord>;
  cleanup?: Promise<void>;
}
interface ChildRecord {
  proc: ChildProcess;
  exited: Promise<DaemonExitResult>;
  closeObserved: Promise<void>;
  closed: boolean;
  spawnError?: Error;
  owner?: FixtureRecord;
  stop?: Promise<DaemonExitResult>;
}
interface SocketRecord {
  socket: Socket;
  socketPath: string;
  owner?: FixtureRecord;
  closing?: boolean;
  closed: boolean;
  closeObserved: Promise<void>;
  failure?: Error;
  raw?: RawClient;
  dataRoot?: string;
}

const fixtureRecords = new WeakMap<object, FixtureRecord>();
// 成功清理后保留路径墓碑，只用于拒绝借用旧根，不授予删除权。
const fixturesBySocket = new Map<string, FixtureRecord>();
const fixturesByResourceKey = new Map<string, FixtureRecord>();
const fixturesByKnownPath = new Map<string, FixtureRecord>();
const fixturesByHomeObject = new WeakMap<object, FixtureRecord>();
const childRecords = new WeakMap<ChildProcess, ChildRecord>();
const rawRecords = new WeakMap<object, SocketRecord>();
interface CreationRecord {
  abort: AbortController;
  signal: AbortSignal;
  roots: CreationRoot[];
  pending: Promise<DaemonFixture>;
}
const creations = new Set<CreationRecord>();

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("操作已取消"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(finish, ms);
    const onAbort = () => { clearTimeout(timer); reject(signal?.reason ?? new Error("操作已取消")); };
    function finish() { signal?.removeEventListener("abort", onAbort); resolve(); }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function deadlineError(label: string, timeoutMs: number): Error {
  return new Error(`${label}超时（${timeoutMs}ms）`);
}

function bounded<T>(promise: Promise<T>, timeoutMs: number, label: string, signal?: AbortSignal): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return Promise.reject(new Error(`${label}的 timeoutMs 必须是有限正数`));
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error(`${label}已取消`));
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (run: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      run();
    };
    const timer = setTimeout(() => finish(() => reject(deadlineError(label, timeoutMs))), timeoutMs);
    const onAbort = () => finish(() => reject(signal?.reason ?? new Error(`${label}已取消`)));
    signal?.addEventListener("abort", onAbort, { once: true });
    void promise.then((value) => finish(() => resolve(value)), (error) => finish(() => reject(error)));
  });
}

function ownerError(): Error {
  return new Error("daemon 夹具已进入清理，禁止新操作");
}

function assertOwnerActive(owner: FixtureRecord | undefined): void {
  if (owner?.fenced || owner?.closed || owner?.abort.signal.aborted) throw ownerError();
}

function track<T>(owner: FixtureRecord | undefined, run: (ownerSignal?: AbortSignal) => Promise<T>): Promise<T> {
  try { assertOwnerActive(owner); }
  catch (error) { return Promise.reject(error); }
  if (!owner) {
    try { return Promise.resolve(run()); }
    catch (error) { return Promise.reject(error); }
  }
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const pending = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; });
  owner.pending.add(pending);
  try { Promise.resolve(run(owner.abort.signal)).then((value) => {
    try { assertOwnerActive(owner); resolve(value); }
    catch (error) { reject(error); }
  }, reject); }
  catch (error) { reject(error); }
  void pending.then(() => owner.pending.delete(pending), () => owner.pending.delete(pending));
  return pending;
}

function linkedSignal(first?: AbortSignal, second?: AbortSignal): { signal?: AbortSignal; dispose(): void } {
  if (!first) return { signal: second, dispose() {} };
  if (!second || first === second) return { signal: first, dispose() {} };
  const controller = new AbortController();
  const forwardFirst = () => controller.abort(first.reason ?? new Error("操作已取消"));
  const forwardSecond = () => controller.abort(second.reason ?? new Error("操作已取消"));
  first.addEventListener("abort", forwardFirst, { once: true });
  second.addEventListener("abort", forwardSecond, { once: true });
  if (first.aborted) forwardFirst();
  else if (second.aborted) forwardSecond();
  return {
    signal: controller.signal,
    dispose() {
      first.removeEventListener("abort", forwardFirst);
      second.removeEventListener("abort", forwardSecond);
    },
  };
}

async function rootIdentity(path: string): Promise<RootIdentity> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`自产根不是普通目录，保全路径: ${path}`);
  return Object.freeze({ path, dev: info.dev, ino: info.ino });
}

async function assertRootIdentity(root: RootIdentity): Promise<void> {
  const info = await lstat(root.path);
  if (!info.isDirectory() || info.isSymbolicLink() || info.dev !== root.dev || info.ino !== root.ino) {
    throw new Error(`自产根身份已变化，保全路径: ${root.path}`);
  }
}

function assertOwnerRoots(owner: FixtureRecord | undefined): void {
  if (!owner) return;
  for (const root of owner.roots) {
    const info = lstatSync(root.path);
    if (!info.isDirectory() || info.isSymbolicLink() || info.dev !== root.dev || info.ino !== root.ino) {
      throw new Error(`自产根身份已变化，保全路径: ${root.path}`);
    }
  }
}

function assertAuthenticationRecord(raw: RawClient, record: SocketRecord): void {
  assertOwnerActive(record.owner);
  if (rawRecords.get(raw) !== record || record.raw !== raw || record.closed || record.closing
    || record.socket.destroyed || record.failure) throw new Error("认证测试客户端记录已失效");
}

async function removeOwnedRoot(root: RootIdentity): Promise<void> {
  await assertRootIdentity(root);
  await rm(root.path, { recursive: true, force: true });
}

interface CreationRoot { readonly path: string; readonly identity?: RootIdentity }

async function cleanupCreation(roots: readonly CreationRoot[], primary: unknown): Promise<never> {
  const errors: unknown[] = [primary];
  const preserved: string[] = [];
  for (const root of [...roots].reverse()) {
    if (!root.identity) {
      preserved.push(root.path);
      console.error(JSON.stringify({ status: "daemon_fixture_preserved", reason: "分配后身份尚未确认", root: root.path }));
      continue;
    }
    try { await removeOwnedRoot(root.identity); }
    catch (error) { errors.push(error); preserved.push(root.path); }
  }
  if (errors.length === 1 && preserved.length === 0) throw primary;
  throw new AggregateError(errors, `daemon 夹具创建失败；保全精确根: ${preserved.join(", ") || "无"}`);
}

function assertCreationActive(creation: CreationRecord): void {
  if (creation.signal.aborted) throw creation.signal.reason ?? new Error("daemon 夹具创建已取消");
}

async function assertCreationRoots(roots: readonly CreationRoot[], creation: CreationRecord): Promise<void> {
  assertCreationActive(creation);
  for (const root of roots) {
    if (!root.identity) throw new Error(`分配身份尚未确认，保全路径: ${root.path}`);
    await assertRootIdentity(root.identity);
    assertCreationActive(creation);
  }
}

function resourceKey(home: string, agentDir: string, repoDir: string, dataRoot: string): string {
  return JSON.stringify([home, agentDir, repoDir, dataRoot].map((path) => resolve(path)));
}

function sameRecordEnv(actual: Readonly<Record<string, string>>, expected: Readonly<Record<string, string>>): boolean {
  const actualKeys = Object.keys(actual).sort();
  const expectedKeys = Object.keys(expected).sort();
  return actualKeys.length === expectedKeys.length
    && actualKeys.every((key, index) => key === expectedKeys[index] && actual[key] === expected[key]);
}

function ownerForInputs(home: FixedHome, repoDir: string, dataRoot: string, socketPath?: string, originalHome?: object): FixtureRecord | undefined {
  const candidates = new Set<FixtureRecord>();
  const add = (candidate: FixtureRecord | undefined) => { if (candidate) candidates.add(candidate); };
  if (originalHome) add(fixturesByHomeObject.get(originalHome));
  add(fixturesByResourceKey.get(resourceKey(home.home, home.agentDir, repoDir, dataRoot)));
  for (const path of [home.home, home.agentDir, home.dataRoot, repoDir, dataRoot]) add(fixturesByKnownPath.get(resolve(path)));
  if (socketPath !== undefined) add(fixturesBySocket.get(resolve(socketPath)));
  if (candidates.size > 1) throw new Error("daemon 夹具资源路径归属冲突");
  const owner = candidates.values().next().value as FixtureRecord | undefined;
  if (!owner) return undefined;
  if (resolve(home.home) !== resolve(owner.home.home) || resolve(home.agentDir) !== resolve(owner.home.agentDir)
    || resolve(home.dataRoot) !== resolve(owner.home.dataRoot) || resolve(repoDir) !== resolve(owner.repoDir)
    || resolve(dataRoot) !== resolve(owner.dataRoot) || !sameRecordEnv(home.env, owner.home.env)) {
    throw new Error("daemon 夹具调用参数与原始不可变记录不匹配");
  }
  assertOwnerActive(owner);
  return owner;
}

function groupGone(pid: number): boolean {
  try { process.kill(-pid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
}

async function confirmGroupGone(record: ChildRecord): Promise<void> {
  await bounded(record.closeObserved, CLOSE_TIMEOUT_MS, "等待自产子进程 close");
  const pid = record.proc.pid;
  if (!pid) {
    if (record.spawnError) return;
    throw new Error("自产子进程没有可核对 PID");
  }
  const end = performance.now() + CLOSE_TIMEOUT_MS;
  while (!groupGone(pid)) {
    if (performance.now() >= end) throw new Error(`自产进程组未确认消失: ${pid}`);
    await delay(10);
  }
}

async function stopChild(record: ChildRecord): Promise<DaemonExitResult> {
  if (record.stop) return record.stop;
  record.stop = (async () => {
    const { proc } = record;
    if (!record.closed && proc.pid && proc.exitCode === null && proc.signalCode === null) {
      try { process.kill(-proc.pid, "SIGKILL"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    }
    const result = await bounded(record.exited, CLOSE_TIMEOUT_MS, "等待自产子进程退出");
    await confirmGroupGone(record);
    record.owner?.children.delete(record);
    return result;
  })();
  const pending = record.stop;
  void pending.catch(() => { if (record.stop === pending) record.stop = undefined; });
  return pending;
}

class HarnessCleanupError extends AggregateError {
  readonly preservedSockets: readonly { socket: Socket; close: Promise<void> }[];
  constructor(errors: unknown[], message: string, records: readonly SocketRecord[]) {
    super(errors, message);
    this.preservedSockets = Object.freeze(records.map((record) => Object.freeze({ socket: record.socket, close: record.closeObserved })));
  }
}

async function closeSocket(record: SocketRecord): Promise<void> {
  record.closing = true;
  if (!record.closed) record.socket.destroy();
  await bounded(record.closeObserved, CLOSE_TIMEOUT_MS, "等待自产 socket close");
  if (!record.closed) throw new Error(`自产 socket 未观察到 close: ${record.socketPath}`);
  record.owner?.sockets.delete(record);
}

// 使用本项目声明的 SDK 入口，pnpm 负责解析其实际安装位置。
export function resolveSdkDir(): string {
  return join(packageRoot, "node_modules", "@earendil-works", "pi-coding-agent");
}

// 子进程与当前测试使用同一个 Node 可执行文件。
export function resolveNodeExecutable(): string {
  return process.execPath;
}

export function maxDataRootLength(platform: NodeJS.Platform = process.platform): number {
  return socketPathByteLimit(platform) - SOCKET_SUFFIX_LENGTH;
}

export interface DaemonEnvOverrides {
  sdkDir?: string;
  idleTimeoutMs?: number;
  clockSkewFile?: string;
  extraEnv?: Record<string, string>;
}

export interface SpawnDaemonOptions extends DaemonEnvOverrides {
  home: TempHome;
  repoDir: string;
  dataRoot: string;
  captureOutput?: boolean;
  outputByteLimit?: number;
  /** 只供本测试夹具专测拦截 spawn；实参仍固定为当前 Node、daemon 入口、绝对 cwd。 */
  spawnImpl?: typeof spawn;
}

export interface DaemonExitResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  outputTruncated: boolean;
  outputFailure?: string;
}

export interface SpawnedDaemon {
  proc: ChildProcess;
  exited: Promise<DaemonExitResult>;
}

const PROTECTED_ENV = new Set([
  "HOME", "PI_CODING_AGENT_DIR", "PI_COMPANY_REPO_DIR", "PI_COMPANY_DATA_ROOT",
  "PI_COMPANY_SDK_DIR", "PI_COMPANY_EXPECTED_GIT", "PI_COMPANY_CLOCK_SKEW_FILE",
]);
const ALLOWED_EXTRA_ENV = new Set([
  "NODE_OPTIONS", "PI_COMPANY_MODEL_PROVIDER_MODULE", "PI_COMPANY_CONNECTIVITY_PROBE_MODULE",
  "PI_COMPANY_NETWORK_PROBE_INTERVAL_MS", "M3_ASSEMBLY_PROBE", "M3_ASSEMBLY_REPOSITORY", "M3_SLEEP_GATE", "PI_COMPANY_IDLE_TIMEOUT_MS",
]);

function validateExtraEnv(extra: Readonly<Record<string, string>>): void {
  for (const [key, value] of Object.entries(extra)) {
    if (typeof value !== "string") throw new Error(`daemon 夹具环境变量必须是字符串: ${key}`);
    if (PROTECTED_ENV.has(key)) throw new Error(`daemon 夹具保护环境变量禁止覆盖: ${key}`);
    if (!ALLOWED_EXTRA_ENV.has(key) && !key.startsWith("PI_COMPANY_TEST_")) {
      throw new Error(`daemon 夹具未允许的测试环境变量: ${key}`);
    }
  }
}

interface CapturedSpawnOptions {
  readonly home: TempHome;
  readonly fixedHome: FixedHome;
  readonly repoDir: string;
  readonly dataRoot: string;
  readonly sdkDir: string;
  readonly idleTimeoutMs?: number;
  readonly clockSkewFile?: string;
  readonly extraEnv: Readonly<Record<string, string>>;
  readonly captureOutput: boolean;
  readonly outputByteLimit: number;
  readonly spawnImpl: typeof spawn;
}

function captureStringRecord(value: Record<string, string> | undefined, label: string): Readonly<Record<string, string>> {
  const copy: Record<string, string> = {};
  for (const [key, item] of Object.entries(value ?? {})) {
    if (typeof item !== "string") throw new Error(`${label} 必须只含字符串值: ${key}`);
    copy[key] = item;
  }
  return Object.freeze(copy);
}

function captureSpawnOptions(options: SpawnDaemonOptions): CapturedSpawnOptions {
  const home = options.home;
  const fixedHome = Object.freeze({
    home: home.home,
    agentDir: home.agentDir,
    dataRoot: home.dataRoot,
    env: captureStringRecord(home.env, "home.env"),
  });
  const repoDir = options.repoDir;
  const dataRoot = options.dataRoot;
  const sdkDir = options.sdkDir ?? resolveSdkDir();
  const idleTimeoutMs = options.idleTimeoutMs;
  const clockSkewFile = options.clockSkewFile;
  const extraEnv = captureStringRecord(options.extraEnv, "extraEnv");
  const captureOutput = options.captureOutput ?? false;
  const outputByteLimit = options.outputByteLimit ?? OUTPUT_BYTE_LIMIT;
  const spawnImpl = options.spawnImpl ?? spawn;
  for (const [name, value] of [["home", fixedHome.home], ["agentDir", fixedHome.agentDir], ["repoDir", repoDir], ["dataRoot", dataRoot], ["sdkDir", sdkDir]] as const) {
    if (typeof value !== "string" || !isAbsolute(value)) throw new Error(`${name} 必须是绝对路径: ${String(value)}`);
  }
  if (idleTimeoutMs !== undefined && (!Number.isFinite(idleTimeoutMs) || idleTimeoutMs <= 0)) throw new Error("idleTimeoutMs 必须是有限正数");
  if (clockSkewFile !== undefined && (typeof clockSkewFile !== "string" || !isAbsolute(clockSkewFile))) throw new Error("clockSkewFile 必须是绝对路径");
  if (typeof spawnImpl !== "function") throw new Error("spawnImpl 必须是函数");
  if (!Number.isSafeInteger(outputByteLimit) || outputByteLimit <= 0 || outputByteLimit > OUTPUT_BYTE_LIMIT) {
    throw new Error(`outputByteLimit 必须是 1 到 ${OUTPUT_BYTE_LIMIT} 的安全整数`);
  }
  validateExtraEnv(extraEnv);
  return Object.freeze({ home, fixedHome, repoDir, dataRoot, sdkDir, idleTimeoutMs, clockSkewFile, extraEnv, captureOutput, outputByteLimit, spawnImpl });
}

function buildDaemonEnv(captured: CapturedSpawnOptions, gitExpectation: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...captured.fixedHome.env, ...captured.extraEnv };
  if (captured.idleTimeoutMs !== undefined) env.PI_COMPANY_IDLE_TIMEOUT_MS = String(captured.idleTimeoutMs);
  if (captured.clockSkewFile !== undefined) env.PI_COMPANY_CLOCK_SKEW_FILE = captured.clockSkewFile;
  Object.assign(env, {
    HOME: captured.fixedHome.home,
    PI_CODING_AGENT_DIR: captured.fixedHome.agentDir,
    PI_COMPANY_REPO_DIR: captured.repoDir,
    PI_COMPANY_DATA_ROOT: captured.dataRoot,
    PI_COMPANY_SDK_DIR: captured.sdkDir,
    PI_COMPANY_EXPECTED_GIT: gitExpectation,
  });
  return env;
}

function truncateUtf8(text: string, maximum: number): string {
  let used = 0;
  let result = "";
  for (const character of text) {
    const size = Buffer.byteLength(character, "utf8");
    if (used + size > maximum) break;
    result += character;
    used += size;
  }
  return result;
}

export function spawnDaemonProcess(options: SpawnDaemonOptions): SpawnedDaemon {
  const captured = captureSpawnOptions(options);
  const owner = ownerForInputs(captured.fixedHome, captured.repoDir, captured.dataRoot, undefined, captured.home);
  assertOwnerRoots(owner);
  const roots = [captured.repoDir, captured.dataRoot, captured.sdkDir];
  initializeTestHostGit(roots);
  let gitExpectation = createGitExpectationText(roots);
  let env = buildDaemonEnv(captured, gitExpectation);
  gitExpectation = createGitExpectationText(roots);
  env = buildDaemonEnv(captured, gitExpectation);
  assertOwnerActive(owner);
  assertOwnerRoots(owner);
  currentGitBinding(roots);
  const proc = captured.spawnImpl(resolveNodeExecutable(), [daemonMainEntry], {
    cwd: packageRoot,
    stdio: captured.captureOutput ? ["ignore", "pipe", "pipe"] : "ignore",
    detached: true,
    env,
  });
  for (const root of roots) owner?.launchRoots.add(root);

  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let outputBytes = 0;
  let outputTruncated = false;
  let outputFailure: string | undefined;
  let record!: ChildRecord;
  const collect = (target: Buffer[]) => (chunk: Buffer | string) => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const remaining = Math.max(0, captured.outputByteLimit - outputBytes);
    if (remaining > 0) target.push(Buffer.from(bytes.subarray(0, remaining)));
    outputBytes = Math.min(captured.outputByteLimit + 1, outputBytes + bytes.length);
    if (outputBytes > captured.outputByteLimit && !outputTruncated) {
      outputTruncated = true;
      outputFailure = `守护进程输出超过上限 ${captured.outputByteLimit} 字节`;
      if (record) void stopChild(record).catch(() => undefined);
    }
  };
  if (captured.captureOutput) {
    proc.stdout?.on("data", collect(stdout));
    proc.stderr?.on("data", collect(stderr));
  }

  let closeResolve!: () => void;
  const closeObserved = new Promise<void>((resolve) => { closeResolve = resolve; });
  const exited = new Promise<DaemonExitResult>((resolve) => {
    proc.once("close", (code, signal) => {
      record.closed = true;
      closeResolve();
      const decodedOut = Buffer.concat(stdout).toString("utf8"), decodedErr = Buffer.concat(stderr).toString("utf8");
      const stdoutText = truncateUtf8(decodedOut, captured.outputByteLimit);
      const stdoutSize = Buffer.byteLength(stdoutText, "utf8");
      const stderrText = truncateUtf8(decodedErr, captured.outputByteLimit - stdoutSize);
      if (stdoutText !== decodedOut || stderrText !== decodedErr) {
        outputTruncated = true;
        outputFailure ??= `守护进程解码输出超过上限 ${captured.outputByteLimit} 字节`;
      }
      resolve({ code, signal, stdout: stdoutText, stderr: stderrText, outputTruncated, outputFailure });
    });
  });
  record = { proc, exited, closeObserved, closed: false, owner };
  proc.once("error", (error) => { record.spawnError = error; });
  childRecords.set(proc, record);
  owner?.children.add(record);
  proc.unref();
  return { proc, exited };
}

export interface WaitForSocketOptions { timeoutMs?: number; signal?: AbortSignal; retryMs?: number }

async function connectSocket(socketPath: string, options: WaitForSocketOptions = {}): Promise<SocketRecord> {
  const owner = fixturesBySocket.get(resolve(socketPath));
  return track(owner, async (ownerSignal) => {
    const linked = linkedSignal(ownerSignal, options.signal);
    try {
      if (Buffer.byteLength(socketPath, "utf8") > socketPathByteLimit()) throw new Error(`socket 路径超限: ${socketPath}`);
      const socket = createConnection(socketPath);
      let closeResolve!: () => void;
      const record: SocketRecord = {
        socket,
        socketPath,
        owner,
        closed: false,
        closeObserved: new Promise<void>((resolve) => { closeResolve = resolve; }),
      };
      owner?.sockets.add(record);
      socket.once("close", () => { record.closed = true; closeResolve(); });
      socket.on("error", (error) => { record.failure ??= error; });
      let onConnect!: () => void;
      let onError!: (error: Error) => void;
      let onClose!: () => void;
      const connected = new Promise<void>((resolve, reject) => {
        onConnect = resolve;
        onError = reject;
        onClose = () => reject(record.failure ?? new Error("daemon socket 在连接完成前关闭"));
        socket.once("connect", onConnect);
        socket.once("error", onError);
        socket.once("close", onClose);
      });
      try {
        await bounded(connected, options.timeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS, "连接 daemon socket", linked.signal);
        assertOwnerActive(owner);
        if (record.closed || socket.destroyed) throw new Error("daemon socket 在交付前已关闭");
        return record;
      } catch (error) {
        socket.destroy();
        try { await bounded(record.closeObserved, CLOSE_TIMEOUT_MS, "失败 socket 收尾"); }
        catch (closeError) { throw new HarnessCleanupError([error, closeError], `连接失败且 socket 未确认关闭: ${socketPath}`, [record]); }
        owner?.sockets.delete(record);
        throw error;
      } finally {
        socket.off("connect", onConnect);
        socket.off("error", onError);
        socket.off("close", onClose);
      }
    } finally {
      linked.dispose();
    }
  });
}

export async function waitForSocketReady(socketPath: string, timeoutOrOptions: number | WaitForSocketOptions = DEFAULT_START_TIMEOUT_MS): Promise<void> {
  const options = typeof timeoutOrOptions === "number" ? { timeoutMs: timeoutOrOptions } : timeoutOrOptions;
  const timeoutMs = options.timeoutMs ?? DEFAULT_START_TIMEOUT_MS;
  const started = performance.now();
  let lastError: Error | undefined;
  while (performance.now() - started < timeoutMs) {
    if (options.signal?.aborted) throw options.signal.reason ?? new Error("等待 socket 已取消");
    const remaining = Math.max(1, timeoutMs - (performance.now() - started));
    try {
      const record = await connectSocket(socketPath, { timeoutMs: Math.min(DEFAULT_CONNECT_TIMEOUT_MS, remaining), signal: options.signal });
      try { await closeSocket(record); }
      catch (error) { throw new HarnessCleanupError([error], "socket 探测收尾未确认", [record]); }
      if (options.signal?.aborted) throw options.signal.reason ?? new Error("等待 socket 已取消");
      assertOwnerActive(record.owner);
      return;
    } catch (error) {
      if (error instanceof HarnessCleanupError) throw error;
      lastError = error as Error;
      await delay(Math.min(options.retryMs ?? 50, Math.max(1, remaining)), options.signal);
    }
  }
  throw new Error(`等待守护进程 socket 可连接超时（${timeoutMs}ms，路径 ${socketPath}）：${lastError?.message ?? "未知原因"}`);
}

export interface DaemonFixture {
  home: TempHome;
  repo: RepoFixture;
  repoDir: string;
  dataRoot: string;
  repoId: string;
  socketPath: string;
}

export interface CreateDaemonFixtureOptions {
  /** 仅用于本夹具专测创建阶段的自产资源收尾。 */
  faultAfter?: "home" | "repo" | "dataRoot";
  signal?: AbortSignal;
}

export async function createDaemonFixture(options: CreateDaemonFixtureOptions = {}): Promise<DaemonFixture> {
  const captured = { faultAfter: options.faultAfter, signal: options.signal };
  if (captured.signal?.aborted) return Promise.reject(captured.signal.reason ?? new Error("daemon 夹具创建已取消"));
  initializeTestHostGit([]);
  const abort = new AbortController();
  const linked = linkedSignal(abort.signal, captured.signal);
  let resolve!: (fixture: DaemonFixture) => void, reject!: (error: unknown) => void;
  const pending = new Promise<DaemonFixture>((yes, no) => { resolve = yes; reject = no; });
  const creation: CreationRecord = { abort, signal: linked.signal!, roots: [], pending };
  creations.add(creation);
  void buildDaemonFixture(creation, captured).then(async (fixture) => {
    if (creation.signal.aborted) {
      try { await removeDaemonFixture(fixture); reject(creation.signal.reason); }
      catch (error) { reject(error); }
    } else resolve(fixture);
  }, reject);
  void pending.then(() => { creations.delete(creation); linked.dispose(); }, () => { creations.delete(creation); linked.dispose(); });
  return pending;
}

async function buildDaemonFixture(creation: CreationRecord, options: CreateDaemonFixtureOptions): Promise<DaemonFixture> {
  const roots = creation.roots;
  let home: TempHome | undefined;
  let repo: RepoFixture | undefined;
  try {
    assertCreationActive(creation);
    home = await createTempHome();
    const homeReceipt = tempHomeRootReceipt(home);
    if (!homeReceipt || homeReceipt.path !== home.home) throw new Error(`临时 HOME 缺少原始分配收据；保全路径 ${home.home}`);
    roots.push({ path: homeReceipt.path, identity: Object.freeze({ ...homeReceipt }) });
    if (options.faultAfter === "home") throw new Error("daemon 夹具专测：HOME 初始化后失败");
    await assertCreationRoots(roots, creation);
    repo = await createRepoFixture();
    const repoReceipt = repoFixtureRootReceipt(repo);
    if (!repoReceipt || repoReceipt.path !== repo.root) throw new Error(`Repo夹具缺少原始分配收据；保全路径 ${repo.root}`);
    roots.push({ path: repoReceipt.path, identity: Object.freeze({ ...repoReceipt }) });
    if (options.faultAfter === "repo") throw new Error("daemon 夹具专测：repo 初始化后失败");
    await assertCreationRoots(roots, creation);
    const identity = await repositoryIdentity(repo.root);
    await assertCreationRoots(roots, creation);
    const dataRoot = await mkdtemp(join(temporaryRoot(), "d"));
    const dataAllocation: { path: string; identity?: RootIdentity } = { path: dataRoot };
    roots.push(dataAllocation);
    dataAllocation.identity = await rootIdentity(dataRoot);
    if (options.faultAfter === "dataRoot") throw new Error("daemon 夹具专测：dataRoot 初始化后失败");
    const socketPath = daemonSocketPath(dataRoot, identity.repoId);
    const fixture: DaemonFixture = { home, repo, repoDir: identity.commonDir, dataRoot, repoId: identity.repoId, socketPath };
    const fixedHome = Object.freeze({
      home: home.home,
      agentDir: home.agentDir,
      dataRoot: home.dataRoot,
      env: captureStringRecord(home.env, "home.env"),
    });
    const ownedRoots = roots.map((root) => root.identity).filter((root): root is RootIdentity => root !== undefined);
    const record: FixtureRecord = {
      fixtureRef: fixture,
      roots: Object.freeze(ownedRoots),
      homeRef: home,
      repoRef: repo,
      repoWorktreesRef: repo.worktrees,
      home: fixedHome,
      repoRoot: repo.root,
      repoDir: identity.commonDir,
      dataRoot,
      socketPath,
      repoId: identity.repoId,
      abort: new AbortController(),
      launchRoots: new Set([identity.commonDir, dataRoot]),
      fenced: false,
      closed: false,
      pending: new Set(),
      children: new Set(),
      sockets: new Set(),
    };
    assertCreationActive(creation);
    assertOwnerRoots(record);
    const key = resourceKey(fixedHome.home, fixedHome.agentDir, record.repoDir, record.dataRoot);
    const knownPaths = [fixedHome.home, fixedHome.agentDir, fixedHome.dataRoot, record.repoDir, record.dataRoot];
    if (fixturesBySocket.has(resolve(socketPath)) || fixturesByResourceKey.has(key)
      || knownPaths.some((path) => fixturesByKnownPath.has(resolve(path)))) {
      throw new Error("daemon 夹具自产路径与已有记录冲突");
    }
    fixtureRecords.set(fixture, record);
    fixturesByHomeObject.set(home, record);
    fixturesBySocket.set(resolve(socketPath), record);
    fixturesByResourceKey.set(key, record);
    for (const path of knownPaths) fixturesByKnownPath.set(resolve(path), record);
    return fixture;
  } catch (error) {
    return cleanupCreation(roots, error);
  }
}

function assertFixtureObject(record: FixtureRecord, fixture: DaemonFixture): void {
  if (fixture.home !== record.homeRef || fixture.repo !== record.repoRef
    || fixture.repoDir !== record.repoDir || fixture.dataRoot !== record.dataRoot
    || fixture.socketPath !== record.socketPath || fixture.repoId !== record.repoId
    || fixture.home.home !== record.home.home || fixture.home.agentDir !== record.home.agentDir
    || fixture.home.dataRoot !== record.home.dataRoot || !sameRecordEnv(fixture.home.env, record.home.env)
    || fixture.repo.root !== record.repoRoot || fixture.repo.worktrees !== record.repoWorktreesRef) {
    throw new Error("daemon 夹具调用对象已被修改；拒绝按可变字段清理");
  }
}

export async function removeDaemonFixture(fixture: DaemonFixture): Promise<void> {
  const record = fixtureRecords.get(fixture);
  if (!record) throw new Error("拒绝清理未由本 daemon 夹具创建的结构化参数");
  if (record.cleanup) return record.cleanup;
  let begin!: () => void;
  const ready = new Promise<void>((resolve) => { begin = resolve; });
  const appearanceErrors: unknown[] = [];
  const cleanup = (async () => {
    await ready;
    const errors: unknown[] = [...appearanceErrors];
    const attempt = async (run: () => Promise<void>) => { try { await run(); } catch (error) { errors.push(error); } };
    await Promise.all([...record.sockets].map((socket) => attempt(() => closeSocket(socket))));
    await Promise.all([...record.children].map((child) => attempt(async () => { await stopChild(child); })));
    await attempt(async () => {
      await bounded(Promise.allSettled([...record.pending]).then(() => undefined), 2 * CLOSE_TIMEOUT_MS, "等待 daemon 夹具在途操作");
    });
    if (record.pending.size || record.sockets.size || record.children.size) errors.push(new Error("daemon 夹具仍有未完成自有资源"));
    if (record.repoWorktreesRef.length > 0) {
      errors.push(new Error(`后续 worktree 归属无法由 daemon 夹具创建记录证明，保全根: ${record.repoRoot}`));
    }
    if (errors.length === 0) {
      for (const root of record.roots) await attempt(() => assertRootIdentity(root));
    }
    if (errors.length === 0) {
      for (const root of [...record.roots].reverse()) await attempt(() => removeOwnedRoot(root));
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, `daemon 夹具收尾失败；保全精确根: ${record.roots.map((root) => root.path).join(", ")}`);
    }
    record.closed = true;
  })();
  record.cleanup = cleanup;
  record.fenced = true;
  try {
    record.abort.abort(ownerError());
    assertFixtureObject(record, fixture);
  } catch (error) { appearanceErrors.push(error); }
  finally { begin(); }
  try { await cleanup; }
  catch (error) {
    if (record.cleanup === cleanup) record.cleanup = undefined;
    throw error;
  }
}

export async function cleanupDaemonHarnessFixtures(): Promise<void> {
  const activeCreations = [...creations];
  for (const creation of activeCreations) creation.abort.abort(new Error("daemon 夹具外层清理取消创建"));
  const results = await Promise.allSettled([
    ...activeCreations.map(async (creation) => {
      try { await bounded(creation.pending, 2 * CLOSE_TIMEOUT_MS, "等待真实创建操作结束"); }
      catch (error) {
        if (error !== creation.signal.reason) {
          console.error(JSON.stringify({ status: "daemon_creation_preserved", roots: creation.roots.map((root) => root.path) }));
          throw error;
        }
      }
    }),
    ...[...new Set(fixturesBySocket.values())].map((record) => record.closed ? Promise.resolve() : removeDaemonFixture(record.fixtureRef)),
  ]);
  const errors = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
  if (errors.length) throw new AggregateError(errors, "daemon 夹具全局收尾未确认，保全相关根");
}

export interface StartDaemonOptions extends DaemonEnvOverrides {
  waitTimeoutMs?: number;
  rpcTimeoutMs?: number;
  captureOutput?: boolean;
  outputByteLimit?: number;
  spawnImpl?: typeof spawn;
}

export interface DaemonHandle {
  proc: ChildProcess;
  exited: Promise<DaemonExitResult>;
  socketPath: string;
}

export async function startDaemonForTest(
  fixture: Pick<DaemonFixture, "home" | "repoDir" | "dataRoot" | "socketPath">,
  options: StartDaemonOptions = {},
): Promise<DaemonHandle> {
  const originalHome = fixture.home;
  const fixedHome: TempHome = {
    home: originalHome.home,
    agentDir: originalHome.agentDir,
    dataRoot: originalHome.dataRoot,
    env: { ...originalHome.env },
  };
  const repoDir = fixture.repoDir;
  const dataRoot = fixture.dataRoot;
  const socketPath = fixture.socketPath;
  const fixedOptions = Object.freeze({
    waitTimeoutMs: options.waitTimeoutMs ?? DEFAULT_START_TIMEOUT_MS,
    rpcTimeoutMs: options.rpcTimeoutMs ?? DEFAULT_RPC_TIMEOUT_MS,
    sdkDir: options.sdkDir,
    idleTimeoutMs: options.idleTimeoutMs,
    clockSkewFile: options.clockSkewFile,
    extraEnv: options.extraEnv === undefined ? undefined : { ...options.extraEnv },
    captureOutput: options.captureOutput ?? true,
    outputByteLimit: options.outputByteLimit,
    spawnImpl: options.spawnImpl,
  });
  if (!Number.isFinite(fixedOptions.waitTimeoutMs) || fixedOptions.waitTimeoutMs <= 0) throw new Error("waitTimeoutMs 必须是有限正数");
  if (!Number.isFinite(fixedOptions.rpcTimeoutMs) || fixedOptions.rpcTimeoutMs <= 0) throw new Error("rpcTimeoutMs 必须是有限正数");
  const directOwner = fixtureRecords.get(fixture as object);
  const owner = ownerForInputs(fixedHome, repoDir, dataRoot, socketPath, originalHome);
  if (directOwner && directOwner !== owner) throw new Error("daemon 夹具启动对象与原始记录冲突");
  return track(owner, async (ownerSignal) => {
    const cancel = new AbortController();
    const linked = linkedSignal(ownerSignal, cancel.signal);
    const deadline = performance.now() + fixedOptions.waitTimeoutMs;
    const remaining = () => Math.max(1, deadline - performance.now());
    const identityPromise = track(owner, async () => repositoryIdentity(repoDir));
    let identity: Awaited<ReturnType<typeof repositoryIdentity>>;
    try {
      identity = await bounded(identityPromise, remaining(), "识别 daemon 测试仓库", linked.signal);
    } catch (error) {
      // 身份操作独立留在owner.pending；期限失败不意味着底层调用已经结束。
      const pendingOperation = identityPromise.then(() => undefined, () => undefined);
      linked.dispose();
      throw Object.assign(new Error(error instanceof Error ? error.message : "识别 daemon 测试仓库失败", { cause: error }), {
        pendingOperation, preservedPaths: [fixedHome.home, repoDir, dataRoot],
      });
    }
    try {
      assertOwnerActive(owner);
      if (owner && identity.repoId !== owner.repoId) throw new Error("启动仓库身份与夹具原始 repoId 不匹配");
    } catch (error) {
      linked.dispose();
      throw error;
    }
    let spawned: SpawnedDaemon;
    try {
      spawned = spawnDaemonProcess({
        home: fixedHome,
        repoDir,
        dataRoot,
        sdkDir: fixedOptions.sdkDir,
        idleTimeoutMs: fixedOptions.idleTimeoutMs,
        clockSkewFile: fixedOptions.clockSkewFile,
        extraEnv: fixedOptions.extraEnv,
        captureOutput: fixedOptions.captureOutput,
        outputByteLimit: fixedOptions.outputByteLimit,
        spawnImpl: fixedOptions.spawnImpl,
      });
    } catch (error) {
      linked.dispose();
      throw error;
    }
    const { proc, exited } = spawned;
    const record = childRecords.get(proc)!;
    const readinessClients = new Set<RawClient>();
    const ready = (async () => {
      let lastError: unknown;
      while (performance.now() < deadline) {
        if (linked.signal?.aborted) throw linked.signal.reason ?? new Error("启动尝试已取消");
        try {
          const raw = await connectRawClient(socketPath, { timeoutMs: Math.min(DEFAULT_CONNECT_TIMEOUT_MS, remaining()), signal: linked.signal, dataRoot });
          readinessClients.add(raw);
          try {
            await authenticateTestClient(raw, {
              windowId: "daemon-readiness-test-peer",
              sessionId: "daemon-readiness-test-peer",
              pid: process.pid,
              cwd: repoDir,
              workspaceRoot: repoDir,
              repoIds: [identity.repoId],
            }, {
              dataRoot,
              expectedDaemonPid: proc.pid,
              expectedRepoId: identity.repoId,
              timeoutMs: Math.min(fixedOptions.rpcTimeoutMs, remaining()),
              signal: linked.signal,
            });
            raw.close();
            await raw.waitClosed(Math.min(CLOSE_TIMEOUT_MS, remaining()));
            readinessClients.delete(raw);
            assertOwnerActive(owner);
            if (record.closed || proc.exitCode !== null || proc.signalCode !== null) throw new Error("daemon 在成功交付前已经退出");
            return;
          } catch (error) {
            lastError = error;
            raw.close();
            try { await raw.waitClosed(Math.min(CLOSE_TIMEOUT_MS, remaining())); readinessClients.delete(raw); }
            catch (closeError) { throw new HarnessCleanupError([error, closeError], "readiness 客户端未确认关闭", [rawRecords.get(raw)!]); }
          }
        } catch (error) {
          if (error instanceof HarnessCleanupError) throw error;
          lastError = error;
        }
        await delay(Math.min(50, remaining()), linked.signal);
      }
      throw new Error(`守护进程认证就绪超时（${fixedOptions.waitTimeoutMs}ms）：${(lastError as Error | undefined)?.message ?? "未知原因"}`);
    })();
    const earlyExit = exited.then((result) => {
      const detail = result.outputFailure ?? (result.stderr || "无 stderr");
      throw new Error(`守护进程在认证就绪前退出（code=${result.code} signal=${result.signal}）：${detail}`);
    });
    try {
      await Promise.race([ready, earlyExit]);
      currentGitBinding([repoDir, dataRoot, fixedOptions.sdkDir ?? resolveSdkDir(), ...(owner?.launchRoots ?? [])]);
      if (linked.signal?.aborted) throw linked.signal.reason ?? new Error("启动已取消");
      assertOwnerActive(owner);
      assertOwnerRoots(owner);
      if (record.closed || proc.exitCode !== null || proc.signalCode !== null || !proc.pid) throw new Error("daemon 在句柄交付前状态失效");
      return { proc, exited, socketPath };
    } catch (error) {
      const cancelReason = new Error("启动尝试已结束");
      cancel.abort(cancelReason);
      const errors: unknown[] = [error];
      try { await ready; } catch (readyError) {
        if (readyError !== error && readyError !== cancelReason && readyError !== linked.signal?.reason) errors.push(readyError);
      }
      for (const raw of readinessClients) {
        raw.close();
        try { await raw.waitClosed(CLOSE_TIMEOUT_MS); readinessClients.delete(raw); }
        catch (closeError) { errors.push(new HarnessCleanupError([closeError], "readiness socket 保全", [rawRecords.get(raw)!])); }
      }
      let childUnconfirmed = false;
      try { await stopChild(record); } catch (stopError) { childUnconfirmed = true; errors.push(stopError); }
      if (errors.length === 1) throw error;
      const primary = error instanceof Error ? error.message : String(error);
      const aggregate = new AggregateError(errors, `${primary}；daemon 启动收尾不完整；自产 PID: ${proc.pid ?? "未知"}`) as AggregateError & { preservedHandle?: DaemonHandle };
      if (childUnconfirmed || !record.closed || record.owner === undefined) aggregate.preservedHandle = { proc, exited, socketPath };
      throw aggregate;
    } finally {
      linked.dispose();
    }
  });
}

export function killDaemon(handle: Pick<DaemonHandle, "proc" | "exited">): Promise<DaemonExitResult> {
  const record = childRecords.get(handle.proc);
  if (!record || record.exited !== handle.exited) return Promise.reject(new Error("拒绝停止未知或 proc/exited 不匹配的 daemon 句柄"));
  return stopChild(record);
}

export interface HelloOverrides {
  windowId?: string;
  pid?: number;
  sessionId?: string;
  cwd?: string;
  workspaceRoot?: string;
  repoIds?: string[];
  protocolVersion?: number;
}

export interface RawCallOptions { timeoutMs?: number; signal?: AbortSignal }
export interface RawConnectOptions extends WaitForSocketOptions { dataRoot?: string }
export interface AuthenticateTestClientOptions extends RawCallOptions {
  dataRoot?: string;
  authToken?: string;
  expectedDaemonPid?: number;
  expectedRepoId?: string;
}

export interface RawClient {
  call(method: string, params?: Record<string, unknown>, options?: RawCallOptions): Promise<Record<string, unknown>>;
  onEvent(event: string, handler: (data: Record<string, unknown>) => void): () => void;
  waitClosed(timeoutMs?: number): Promise<void>;
  close(): void;
  socket: Socket;
}

export interface TestClient extends RawClient {
  helloResult: Record<string, unknown>;
}

function createFrameClient(record: SocketRecord): RawClient {
  const { socket, owner } = record;
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  let terminal: Error | undefined;
  let closing = false;
  interface PendingCall {
    settle(result: { value: Record<string, unknown> } | { error: Error }): void;
  }
  const pending = new Map<string, PendingCall>();
  const eventHandlers = new Map<string, Set<(data: Record<string, unknown>) => void>>();
  const clientAvailable = () => !terminal && !closing && !record.closed && !socket.destroyed
    && !owner?.fenced && !owner?.closed && !owner?.abort.signal.aborted;

  const rejectPending = (error: Error) => {
    for (const waiter of [...pending.values()]) waiter.settle({ error });
  };
  const fail = (error: Error) => {
    terminal ??= error;
    record.failure ??= error;
    rejectPending(terminal);
    if (!record.closed) socket.destroy();
  };
  socket.on("data", (chunk: Buffer) => {
    if (!clientAvailable()) return;
    if (Buffer.byteLength(buffer, "utf8") + chunk.length > FRAME_BUFFER_BYTE_LIMIT) {
      fail(new Error(`daemon 响应缓冲超过 ${FRAME_BUFFER_BYTE_LIMIT} 字节`));
      return;
    }
    buffer += decoder.write(chunk);
    const decoded = decodeFrames(buffer);
    buffer = decoded.rest;
    if (decoded.errors.length > 0) {
      fail(new Error(`daemon 响应解码失败: ${decoded.errors[0]!.reason}`));
      return;
    }
    for (const frame of decoded.frames) {
      if (!clientAvailable()) return;
      if (frame.t === "res") {
        const waiter = pending.get(frame.id);
        if (!waiter) continue;
        if (frame.ok) waiter.settle({ value: frame.result });
        else waiter.settle({ error: new Error(`${frame.error.code}: ${frame.error.message}`) });
      } else if (frame.t === "evt") {
        for (const handler of eventHandlers.get(frame.event) ?? []) {
          if (!clientAvailable()) return;
          try { handler(frame.data); }
          catch (error) { queueMicrotask(() => { throw error; }); }
        }
      }
    }
  });
  socket.on("error", (error) => fail(error));
  socket.once("close", () => {
    const trailing = decoder.end();
    if (trailing) buffer += trailing;
    const reason = terminal ?? new Error(buffer.length > 0 ? "daemon 连接关闭时仍有半帧" : "daemon 连接已关闭");
    terminal ??= reason;
    rejectPending(reason);
  });

  const raw: RawClient = {
    call(method, params = {}, options = {}) {
      return track(owner, (ownerSignal) => {
        if (terminal || record.closed || closing || socket.destroyed) return Promise.reject(terminal ?? new Error("daemon 连接不可用"));
        const timeoutMs = options.timeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;
        if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return Promise.reject(new Error("RPC timeoutMs 必须是有限正数"));
        const callerSignal = options.signal;
        const linked = linkedSignal(ownerSignal, callerSignal);
        if (linked.signal?.aborted) {
          linked.dispose();
          return Promise.reject(linked.signal.reason ?? new Error(`daemon RPC ${method} 已取消`));
        }
        const assertCallAvailable = () => {
          assertOwnerActive(owner);
          if (!clientAvailable()) throw terminal ?? new Error("daemon 连接不可用");
          if (callerSignal?.aborted) throw callerSignal.reason ?? new Error(`daemon RPC ${method} 已取消`);
          if (linked.signal?.aborted) throw linked.signal.reason ?? new Error(`daemon RPC ${method} 已取消`);
        };
        let fixedParams: Record<string, unknown>;
        try {
          fixedParams = { ...params };
          assertCallAvailable();
          if (method === "hello" && !Object.prototype.hasOwnProperty.call(params, "authToken")) {
            const dataRoot = record.owner?.dataRoot ?? record.dataRoot;
            if (dataRoot !== undefined) {
              assertOwnerRoots(owner);
              assertCallAvailable();
              fixedParams.authToken = controlToken(dataRoot);
            }
          }
        } catch (error) {
          linked.dispose();
          return Promise.reject(error);
        }
        const request = createRequest(method, fixedParams);
        let encoded: string;
        try { encoded = `${JSON.stringify(request)}\n`; assertCallAvailable(); }
        catch (error) { linked.dispose(); return Promise.reject(error); }
        return new Promise<Record<string, unknown>>((resolve, reject) => {
          let settled = false;
          let timer: ReturnType<typeof setTimeout> | undefined;
          const onAbort = () => settle({ error: linked.signal?.reason ?? new Error(`daemon RPC ${method} 已取消`) });
          const settle = (result: { value: Record<string, unknown> } | { error: Error }) => {
            if (settled) return;
            settled = true;
            pending.delete(request.id);
            if (timer !== undefined) clearTimeout(timer);
            linked.signal?.removeEventListener("abort", onAbort);
            linked.dispose();
            if ("error" in result) reject(result.error); else resolve(result.value);
          };
          const waiter: PendingCall = { settle };
          pending.set(request.id, waiter);
          linked.signal?.addEventListener("abort", onAbort, { once: true });
          if (linked.signal?.aborted) {
            settle({ error: linked.signal.reason ?? new Error(`daemon RPC ${method} 已取消`) });
            return;
          }
          timer = setTimeout(() => settle({ error: deadlineError(`daemon RPC ${method}`, timeoutMs) }), timeoutMs);
          try {
            assertCallAvailable();
            socket.write(encoded, (error) => { if (error) settle({ error }); });
          } catch (error) {
            settle({ error: error as Error });
          }
        }).then((value) => {
          assertOwnerActive(owner);
          if (callerSignal?.aborted) throw callerSignal.reason ?? new Error(`daemon RPC ${method} 已取消`);
          if (closing) throw new Error("daemon 客户端已关闭");
          return value;
        });
      });
    },
    onEvent(event, handler) {
      if (owner?.fenced || closing || record.closed || terminal) throw new Error("daemon 客户端已失效，禁止订阅事件");
      let handlers = eventHandlers.get(event);
      if (!handlers) { handlers = new Set(); eventHandlers.set(event, handlers); }
      handlers.add(handler);
      return () => handlers?.delete(handler);
    },
    waitClosed(timeoutMs = 5_000) {
      if (record.closed) return Promise.resolve();
      return bounded(record.closeObserved, timeoutMs, "等待连接关闭");
    },
    close() {
      if (closing || record.closed) return;
      closing = true;
      record.closing = true;
      rejectPending(new Error("daemon 客户端已关闭"));
      eventHandlers.clear();
      socket.end();
      socket.destroy();
    },
    socket,
  };
  record.raw = raw;
  rawRecords.set(raw, record);
  return raw;
}

export async function connectRawClient(socketPath: string, options: RawConnectOptions = {}): Promise<RawClient> {
  const fixedOptions: RawConnectOptions = {
    timeoutMs: options.timeoutMs,
    signal: options.signal,
    retryMs: options.retryMs,
    dataRoot: options.dataRoot,
  };
  const record = await connectSocket(socketPath, fixedOptions);
  try {
    assertOwnerActive(record.owner);
    if (fixedOptions.signal?.aborted) throw fixedOptions.signal.reason ?? new Error("连接已取消");
    if (record.closed || record.socket.destroyed) throw new Error("连接交付前已关闭");
    if (fixedOptions.dataRoot !== undefined) {
      const expectedPath = dirname(dirname(resolve(socketPath)));
      if (resolve(fixedOptions.dataRoot) !== expectedPath) throw new Error(`显式 dataRoot 与 socket endpoint 不匹配: ${fixedOptions.dataRoot}`);
      record.dataRoot = fixedOptions.dataRoot;
    }
    return createFrameClient(record);
  } catch (error) {
    try { await closeSocket(record); }
    catch (closeError) { throw new HarnessCleanupError([error, closeError], "RawClient创建失败且socket未关闭", [record]); }
    throw error;
  }
}

function explicitDataRoot(record: SocketRecord, options: AuthenticateTestClientOptions): string {
  if (options.dataRoot !== undefined) {
    if (dirname(dirname(resolve(record.socketPath))) !== resolve(options.dataRoot)) {
      throw new Error(`显式 dataRoot 与 socket endpoint 不匹配: ${options.dataRoot}`);
    }
    return options.dataRoot;
  }
  const fixture = record.owner;
  if (fixture) return fixture.dataRoot;
  const stored = (record as SocketRecord & { dataRoot?: string }).dataRoot;
  if (stored !== undefined) return stored;
  throw new Error("认证测试客户端必须显式提供已隔离 dataRoot；禁止从未知 socket 路径推导可写目录");
}

export async function authenticateTestClient(
  raw: RawClient,
  hello: HelloOverrides = {},
  options: AuthenticateTestClientOptions = {},
): Promise<Record<string, unknown>> {
  const record = rawRecords.get(raw);
  if (!record || record.raw !== raw) throw new Error("认证辅助函数只接受本夹具创建的 RawClient");
  const owner = record.owner;
  return track(owner, async (ownerSignal) => {
    assertOwnerActive(owner);
    assertAuthenticationRecord(raw, record);
    assertOwnerRoots(owner);
    const cwd = hello.cwd ?? process.cwd();
    const workspaceRoot = hello.workspaceRoot ?? process.cwd();
    const windowId = hello.windowId ?? "test-window";
    const pid = hello.pid ?? process.pid;
    const sessionId = hello.sessionId ?? "test-session";
    const repoIds = Object.freeze([...(hello.repoIds ?? [])]);
    const protocolVersion = hello.protocolVersion ?? PROTOCOL_VERSION;
    const optionSignal = options.signal;
    if (optionSignal?.aborted) throw optionSignal.reason ?? new Error("认证已取消");
    const optionDataRoot = options.dataRoot;
    const dataRoot = explicitDataRoot(record, { dataRoot: optionDataRoot });
    const expectedDaemonPid = options.expectedDaemonPid;
    const expectedRepoId = options.expectedRepoId;
    const knownRepoId = owner?.repoId;
    const timeoutMs = options.timeoutMs;
    const explicitToken = Object.prototype.hasOwnProperty.call(options, "authToken");
    const explicitAuthToken = options.authToken;
    if (expectedRepoId !== undefined && knownRepoId !== undefined && expectedRepoId !== knownRepoId) {
      throw new Error("显式 expectedRepoId 与夹具原始 repoId 冲突");
    }
    if (optionSignal?.aborted) throw optionSignal.reason ?? new Error("认证已取消");
    assertAuthenticationRecord(raw, record);
    assertOwnerRoots(owner);
    const authToken = explicitToken ? explicitAuthToken : controlToken(dataRoot);
    const requiredRepoId = expectedRepoId ?? knownRepoId;
    const requestedRoots = [...new Set([cwd, workspaceRoot, dataRoot, ...(owner?.launchRoots ?? [])])];
    // 凭据准备完成后重新导出，实际发送文本中的两类根全集就是回复必须保留的集合。
    const gitExpectation = createGitExpectationText(requestedRoots);
    const sentRoots = Object.freeze(gitExpectationRoots(decodeGitExpectation(gitExpectation)));
    const linked = linkedSignal(ownerSignal, optionSignal);
    try {
      if (linked.signal?.aborted) throw linked.signal.reason ?? new Error("认证已取消");
      assertOwnerActive(owner);
      currentGitBinding(sentRoots);
      const result = await raw.call("hello", {
        authToken,
        windowId,
        pid,
        sessionId,
        cwd,
        workspaceRoot,
        repoIds,
        protocolVersion,
        gitExpectation,
      }, { timeoutMs, signal: linked.signal });
      if (result.protocolVersion !== PROTOCOL_VERSION) throw new Error("hello 响应协议版本不匹配");
      if (!Number.isSafeInteger(result.daemonPid) || (result.daemonPid as number) <= 0) throw new Error("hello 响应缺少有效 daemonPid");
      if (expectedDaemonPid !== undefined && result.daemonPid !== expectedDaemonPid) throw new Error("hello 响应 daemonPid 不是本次自产进程");
      if (typeof result.repoId !== "string" || !REPO_ID_PATTERN.test(result.repoId)) throw new Error("hello 响应 repoId 无效");
      if (requiredRepoId !== undefined && result.repoId !== requiredRepoId) throw new Error("hello 响应 repoId 不匹配");
      if (typeof result.daemonInstanceId !== "string" || !UUID_PATTERN.test(result.daemonInstanceId)) throw new Error("hello 响应 daemonInstanceId 无效");
      if (typeof result.connectionId !== "string" || !UUID_PATTERN.test(result.connectionId)) throw new Error("hello 响应 connectionId 无效");
      verifyPeerGitBinding(result.gitExpectation, sentRoots, sentRoots);
      currentGitBinding(sentRoots);
      assertOwnerActive(owner);
      if (linked.signal?.aborted) throw linked.signal.reason ?? new Error("认证已取消");
      assertAuthenticationRecord(raw, record);
      assertOwnerRoots(owner);
      return result;
    } finally {
      linked.dispose();
    }
  });
}

export async function connectTestClient(
  socketPath: string,
  hello: HelloOverrides = {},
  options: AuthenticateTestClientOptions = {},
): Promise<TestClient> {
  const fixedHello: HelloOverrides = {
    windowId: hello.windowId,
    pid: hello.pid,
    sessionId: hello.sessionId,
    cwd: hello.cwd,
    workspaceRoot: hello.workspaceRoot,
    repoIds: hello.repoIds === undefined ? undefined : [...hello.repoIds],
    protocolVersion: hello.protocolVersion,
  };
  const fixedOptions: AuthenticateTestClientOptions = {
    timeoutMs: options.timeoutMs,
    signal: options.signal,
    dataRoot: options.dataRoot,
    expectedDaemonPid: options.expectedDaemonPid,
    expectedRepoId: options.expectedRepoId,
  };
  if (Object.prototype.hasOwnProperty.call(options, "authToken")) fixedOptions.authToken = options.authToken;
  const raw = await connectRawClient(socketPath, { timeoutMs: fixedOptions.timeoutMs, signal: fixedOptions.signal, dataRoot: fixedOptions.dataRoot });
  try {
    const helloResult = await authenticateTestClient(raw, fixedHello, fixedOptions);
    const record = rawRecords.get(raw)!;
    assertAuthenticationRecord(raw, record);
    if (fixedOptions.signal?.aborted) throw fixedOptions.signal.reason ?? new Error("连接已取消");
    Object.defineProperty(raw, "helloResult", { value: helloResult, enumerable: true, configurable: false });
    return raw as TestClient;
  } catch (error) {
    raw.close();
    try { await raw.waitClosed(); }
    catch (closeError) { throw new HarnessCleanupError([error, closeError], "便利客户端失败且socket未关闭", [rawRecords.get(raw)!]); }
    throw error;
  }
}
