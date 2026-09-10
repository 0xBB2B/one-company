import { controlToken } from "../../runtime/daemon-auth.ts";
import { temporaryRoot } from "./temporary-root.ts";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import type { Socket } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { socketPathByteLimit } from "../../daemon/lifecycle.ts";
import { createRequest, decodeFrames, PROTOCOL_VERSION } from "../../runtime/protocol.ts";
import { daemonSocketPath, repositoryIdentity } from "../../runtime/identity.ts";
import { createRepoFixture, removeRepoFixture } from "./repo-fixture.ts";
import type { RepoFixture } from "./repo-fixture.ts";
import { createTempHome, removeTempHome } from "./temp-home.ts";
import type { TempHome } from "./temp-home.ts";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const daemonMainEntry = join(packageRoot, "daemon", "main.ts");

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// bun 的 require.resolve 会解析到 bun 自身的全局安装缓存而非项目 node_modules，
// 与生产运行时（node 从 node_modules 加载）不一致，因此直接定位项目内路径
export function resolveSdkDir(): string {
  return join(packageRoot, "node_modules", "@earendil-works", "pi-coding-agent");
}

// 生产运行时是用户机器上的 node，而非 bun test 自身进程；spawn 必须复现这一点，否则测试验证的是 bun 的行为
export function resolveNodeExecutable(): string {
  const nodePath = Bun.which("node");
  if (!nodePath) throw new Error("未在 PATH 中找到 node 可执行文件，无法以生产运行时拉起守护进程");
  return nodePath;
}

const SOCKET_SUFFIX_LENGTH = "/sock/".length + 16 + ".sock".length;

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
}

export interface DaemonExitResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

export interface SpawnedDaemon {
  proc: ChildProcess;
  exited: Promise<DaemonExitResult>;
}

function buildDaemonEnv(options: SpawnDaemonOptions): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...options.home.env,
    PI_COMPANY_SDK_DIR: options.sdkDir ?? resolveSdkDir(),
    PI_COMPANY_REPO_DIR: options.repoDir,
    PI_COMPANY_DATA_ROOT: options.dataRoot,
    PI_CODING_AGENT_DIR: options.home.agentDir,
  };
  if (options.idleTimeoutMs !== undefined) env.PI_COMPANY_IDLE_TIMEOUT_MS = String(options.idleTimeoutMs);
  if (options.clockSkewFile !== undefined) env.PI_COMPANY_CLOCK_SKEW_FILE = options.clockSkewFile;
  if (options.extraEnv) Object.assign(env, options.extraEnv);
  return env;
}

export function spawnDaemonProcess(options: SpawnDaemonOptions): SpawnedDaemon {
  const env = buildDaemonEnv(options);
  const captureOutput = options.captureOutput ?? false;
  const proc = spawn(resolveNodeExecutable(), [daemonMainEntry], {
    stdio: captureOutput ? ["ignore", "pipe", "pipe"] : "ignore",
    detached: true,
    env,
  });

  let stdout = "";
  let stderr = "";
  if (captureOutput) {
    proc.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
  }

  const exited = new Promise<DaemonExitResult>((resolve) => {
    proc.once("exit", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  proc.unref();

  return { proc, exited };
}

export async function waitForSocketReady(socketPath: string, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  let lastError: Error | undefined;
  while (Date.now() - start < timeoutMs) {
    try {
      await new Promise<void>((resolve, reject) => {
        const socket = createConnection(socketPath);
        socket.once("connect", () => {
          socket.end();
          resolve();
        });
        socket.once("error", reject);
      });
      return;
    } catch (error) {
      lastError = error as Error;
      await delay(50);
    }
  }
  throw new Error(
    `等待守护进程 socket 就绪超时（${timeoutMs}ms，路径 ${socketPath}）：${lastError?.message ?? "未知原因"}`,
  );
}

export interface DaemonFixture {
  home: TempHome;
  repo: RepoFixture;
  repoDir: string;
  dataRoot: string;
  repoId: string;
  socketPath: string;
}

export async function createDaemonFixture(): Promise<DaemonFixture> {
  const home = await createTempHome();
  const repo = await createRepoFixture();
  const identity = await repositoryIdentity(repo.root);
    const dataRoot = await mkdtemp(join(temporaryRoot(), "d"));
  return {
    home,
    repo,
    repoDir: identity.commonDir,
    dataRoot,
    repoId: identity.repoId,
    socketPath: daemonSocketPath(dataRoot, identity.repoId),
  };
}

export async function removeDaemonFixture(fixture: DaemonFixture): Promise<void> {
  await removeRepoFixture(fixture.repo);
  await removeTempHome(fixture.home);
  await rm(fixture.dataRoot, { recursive: true, force: true });
}

export interface StartDaemonOptions extends DaemonEnvOverrides {
  waitTimeoutMs?: number;
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
  const { proc, exited } = spawnDaemonProcess({
    home: fixture.home,
    repoDir: fixture.repoDir,
    dataRoot: fixture.dataRoot,
    sdkDir: options.sdkDir,
    idleTimeoutMs: options.idleTimeoutMs,
    clockSkewFile: options.clockSkewFile,
    extraEnv: options.extraEnv,
  });

  const earlyExit = exited.then((result) => {
    throw new Error(
      `守护进程在 socket 就绪前退出（code=${result.code} signal=${result.signal}）：${result.stderr || "无 stderr"}`,
    );
  });
  await Promise.race([waitForSocketReady(fixture.socketPath, options.waitTimeoutMs ?? 10_000), earlyExit]);

  return { proc, exited, socketPath: fixture.socketPath };
}

export function killDaemon(handle: Pick<DaemonHandle, "proc" | "exited">): Promise<DaemonExitResult> {
  handle.proc.kill("SIGKILL");
  return handle.exited;
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

export interface RawClient {
  call(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
  onEvent(event: string, handler: (data: Record<string, unknown>) => void): () => void;
  waitClosed(timeoutMs?: number): Promise<void>;
  close(): void;
  socket: Socket;
}

export interface TestClient extends RawClient {
  helloResult: Record<string, unknown>;
}

function createFrameClient(socket: Socket, dataRoot: string): RawClient {
  let buffer = "";
  const pending = new Map<
    string,
    { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }
  >();
  const eventHandlers = new Map<string, Set<(data: Record<string, unknown>) => void>>();

  socket.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    const { frames, rest } = decodeFrames(buffer);
    buffer = rest;
    for (const frame of frames) {
      if (frame.t === "res") {
        const waiter = pending.get(frame.id);
        if (!waiter) continue;
        pending.delete(frame.id);
        if (frame.ok) waiter.resolve(frame.result);
        else waiter.reject(new Error(`${frame.error.code}: ${frame.error.message}`));
      } else if (frame.t === "evt") {
        for (const handler of eventHandlers.get(frame.event) ?? []) handler(frame.data);
      }
    }
  });

  function call(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const request = createRequest(method, method === "hello" ? { authToken: controlToken(dataRoot), ...params } : params);
    return new Promise((resolve, reject) => {
      pending.set(request.id, { resolve, reject });
      socket.write(`${JSON.stringify(request)}\n`);
    });
  }

  function waitClosed(timeoutMs = 5_000): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`等待连接关闭超时（${timeoutMs}ms）`)), timeoutMs);
      socket.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  return {
    call,
    onEvent(event, handler) {
      let handlers = eventHandlers.get(event);
      if (!handlers) {
        handlers = new Set();
        eventHandlers.set(event, handlers);
      }
      handlers.add(handler);
      return () => handlers?.delete(handler);
    },
    waitClosed,
    close() {
      socket.end();
    },
    socket,
  };
}

export async function connectRawClient(socketPath: string): Promise<RawClient> {
  const socket = createConnection(socketPath);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", () => resolve());
    socket.once("error", reject);
  });
  return createFrameClient(socket, dirname(dirname(socketPath)));
}

export async function connectTestClient(socketPath: string, hello: HelloOverrides = {}): Promise<TestClient> {
  const raw = await connectRawClient(socketPath);
  const helloResult = await raw.call("hello", {
    windowId: hello.windowId ?? "test-window",
    pid: hello.pid ?? process.pid,
    sessionId: hello.sessionId ?? "test-session",
    cwd: hello.cwd ?? process.cwd(),
    workspaceRoot: hello.workspaceRoot ?? process.cwd(),
    repoIds: hello.repoIds ?? [],
    protocolVersion: hello.protocolVersion ?? PROTOCOL_VERSION,
  });
  return { helloResult, ...raw };
}
