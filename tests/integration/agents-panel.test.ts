import { temporaryRoot } from "../helpers/temporary-root.ts";
import { afterEach, describe, expect, test } from "vitest";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants, lstatSync, realpathSync, writeFileSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, rmdir, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Component } from "@earendil-works/pi-tui";
import agentsUiExtension from "../../extensions/agents-ui.ts";
import type { AgentsUiDeps } from "../../extensions/agents-ui.ts";
import { currentDock } from "../../extensions/lifecycle.ts";
import type { WindowContextValue } from "../../extensions/lifecycle.ts";
import { AgentsActivity } from "../../runtime/agents-activity.ts";
import type { AgentsPanel } from "../../runtime/agents-panel.ts";
import { createClock } from "../../runtime/clock.ts";
import { connectDaemon, DAEMON_CLIENT_LIFECYCLE_EVENTS } from "../../runtime/daemon-client.ts";
import type { DaemonClient } from "../../runtime/daemon-client.ts";
import { daemonSocketPath, repositoryIdentity } from "../../runtime/identity.ts";
import type { RepositoryIdentity } from "../../runtime/identity.ts";
import { RunStore } from "../../runtime/run-store.ts";
import type { RunState } from "../../runtime/run-store.ts";
import { createFakeTimeSource } from "../helpers/fake-clock.ts";
import type { FakeTimeSource } from "../helpers/fake-clock.ts";
import { killDaemon, resolveSdkDir, spawnDaemonProcess, waitForSocketReady } from "../helpers/daemon-harness.ts";
import type { DaemonExitResult, DaemonHandle } from "../helpers/daemon-harness.ts";
import { createFakePi } from "../helpers/fake-pi.ts";
import { modelProviderEnv, writeTestModelProviders } from "../helpers/daemon-model-fixture.ts";
import { createRepoFixture, removeRepoFixture } from "../helpers/repo-fixture.ts";
import type { RepoFixture } from "../helpers/repo-fixture.ts";
import { createTempHome, removeTempHome } from "../helpers/temp-home.ts";
import type { TempHome } from "../helpers/temp-home.ts";
import { pressKeys, renderComponent } from "../helpers/virtual-terminal.ts";

const KEY = {
  up: "\x1b[A",
  down: "\x1b[B",
  right: "\x1b[C",
  enter: "\r",
  escape: "\x1b",
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(check: () => boolean, timeoutMs = 15_000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error("等待条件超时");
    await delay(50);
  }
}

// 承载 pi-tui Component：编辑栏（顶部）→ 原状态栏（不可选中的汇总文本）→ Agents 面板（widget，最下方）。
// custom 调用次数仅用于证明已退场的旧正文查看入口没有被键盘重新打开。
class IntegrationShell implements Component {
  editorText = "";
  customInvocationCount = 0;
  readonly notifications: string[] = [];
  readonly statusSummaryText = "会话状态汇总：仅供展示，不可选中";
  private widgetFactory: ((tui: unknown, theme: unknown) => Component) | undefined;
  private widgetComponent: Component | undefined;
  private customComponent: Component | undefined;
  private dockKeyHandler: ((data: string) => { consume?: boolean; data?: string } | undefined) | undefined;
  private readonly fakeTui = {
    mode: "regular" as const,
    hasOverlay: () => false,
    getFocusedComponent: () => undefined,
    requestRender: () => {},
    terminal: { rows: 40, columns: 100 },
  };

  readonly ui = {
    setWidget: (_key: string, content: unknown, _options?: { placement?: string }): void => {
      if (typeof content !== "function") {
        this.widgetFactory = undefined;
        this.widgetComponent = undefined;
        return;
      }
      this.widgetFactory = content as (tui: unknown, theme: unknown) => Component;
      this.widgetComponent = this.widgetFactory(this.fakeTui, {});
    },
    onTerminalInput: (
      handler: (data: string) => { consume?: boolean; data?: string } | undefined,
    ): (() => void) => {
      this.dockKeyHandler = handler;
      return () => {
        if (this.dockKeyHandler === handler) this.dockKeyHandler = undefined;
      };
    },
    getEditorText: (): string => this.editorText,
    notify: (message: string, _level?: string): void => { this.notifications.push(message); },
    custom: <T,>(
      factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (result: T) => void) => Component,
      _options?: { overlay?: boolean },
    ): Promise<T> => {
      this.customInvocationCount += 1;
      return new Promise((resolve) => {
        const done = (result: T): void => {
          this.customComponent = undefined;
          resolve(result);
        };
        this.customComponent = factory(this.fakeTui, {}, {}, done);
      });
    },
  };

  panel(): AgentsPanel | undefined {
    return this.widgetComponent as AgentsPanel | undefined;
  }

  legacyBodyOpen(): boolean {
    return this.customComponent !== undefined;
  }

  setEditorText(text: string): void {
    this.editorText = text;
  }

  render(width: number): string[] {
    const lines: string[] = [];
    lines.push(this.customComponent ? this.customComponent.render(width)[0] ?? "" : `> ${this.editorText}`);
    lines.push(this.statusSummaryText);
    if (this.widgetComponent) lines.push(...this.widgetComponent.render(width));
    return lines;
  }

  handleInput(data: string): void {
    if (this.customComponent) {
      this.customComponent.handleInput?.(data);
      return;
    }
    const result = this.dockKeyHandler?.(data);
    if (result?.consume) return;
    this.applyEditorKey(data);
  }

  invalidate(): void {}

  private applyEditorKey(data: string): void {
    if (data === "\x7f" || data === "\b") {
      this.editorText = this.editorText.slice(0, -1);
      return;
    }
    if (/^[\x20-\x7e]$/.test(data)) this.editorText += data;
  }
}

interface SeedRun {
  key: string;
  requirement: string;
  state: "running" | "completed" | "stopped";
  task?: string;
}

const CLEANUP_FAULT_PROBE_ENV = "PI_COMPANY_AGENTS_PANEL_CLEANUP_FAULT_PROBE";
const CLEANUP_EVIDENCE_DIRECTORY_ENV = "M4_UI_INTEGRATION_REPAIR_EVIDENCE_DIRECTORY";
const PRESERVED_CLEANUP_PREFIX = "AGENTS_PANEL_CLEANUP_PRESERVED ";
const cleanupFaultProbe = process.env[CLEANUP_FAULT_PROBE_ENV] === "1";
const PROBE_OWNER_ENV = "PI_COMPANY_AGENTS_PANEL_PROBE_OWNER";
interface DirectoryIdentity { path: string; dev: number; ino: number }
interface ProbeOwner { root: DirectoryIdentity; verification: DirectoryIdentity; nonce: string }

async function directoryIdentity(path: string): Promise<DirectoryIdentity> {
  const entry = await lstat(path);
  if (!entry.isDirectory() || entry.isSymbolicLink() || (entry.mode & 0o077) !== 0 ||
    process.getuid && entry.uid !== process.getuid() || await realpath(path) !== path) throw new Error("夹具目录身份不可核对");
  return { path, dev: entry.dev, ino: entry.ino };
}
async function assertProbeOwner(owner: ProbeOwner): Promise<void> {
  if (!owner || !/^[0-9a-f-]{36}$/.test(owner.nonce) || !isAbsolute(owner.root?.path) ||
    !basename(owner.root.path).startsWith("pi-t-probe-") || owner.verification?.path !== join(owner.root.path, "verification")) throw new Error("本次探针目录绑定无效");
  for (const expected of [owner.root, owner.verification]) {
    const actual = await directoryIdentity(expected.path);
    if (actual.dev !== expected.dev || actual.ino !== expected.ino) throw new Error("本次探针目录已被替换");
  }
}
async function createProbeOwner(): Promise<ProbeOwner> {
  const root = await mkdtemp(join(await realpath("/tmp"), "pi-t-probe-"));
  const verification = join(root, "verification"); await mkdir(verification, { mode: 0o700 });
  const owner = { root: await directoryIdentity(root), verification: await directoryIdentity(verification), nonce: randomUUID() };
  await writeFile(join(root, "resource.json"), JSON.stringify({ nonce: owner.nonce, phase: "unknown" }), { flag: "wx", mode: 0o600 });
  return owner;
}
function writeProbeResource(world: WorldResources, phase: string): void {
  const owner = world.probeOwner; if (!owner) return;
  const actual = lstatSync(owner.root.path);
  if (!actual.isDirectory() || actual.isSymbolicLink() || actual.dev !== owner.root.dev || actual.ino !== owner.root.ino || realpathSync(owner.root.path) !== owner.root.path) throw new Error("探针记录目录已变化");
  const recordPath = join(owner.root.path, "resource.json"), record = lstatSync(recordPath);
  if (!record.isFile() || record.isSymbolicLink() || (record.mode & 0o077) !== 0) throw new Error("探针资源记录身份无效");
  writeFileSync(recordPath, JSON.stringify({ nonce: owner.nonce, root: owner.root.path, phase,
    daemonPid: world.daemonPid ?? null, daemonPgid: world.daemonPgid ?? null,
    daemonExited: world.daemonExited, groupGone: world.groupGone }), { mode: 0o600, flag: constants.O_WRONLY | constants.O_TRUNC | constants.O_NOFOLLOW });
}

type StopDaemon = (handle: DaemonHandle) => Promise<DaemonExitResult>;

interface WorldResources {
  home?: TempHome;
  repo?: RepoFixture;
  identity?: RepositoryIdentity;
  agentDir?: string;
  dataRoot?: string;
  handle?: DaemonHandle;
  daemonPid?: number;
  daemonPgid?: number;
  daemonSpawnAttempted: boolean;
  client?: DaemonClient;
  seededRunIds: Record<string, string>;
  prevAgentDirEnv: string | undefined;
  agentDirEnvOverridden: boolean;
  preserveRoots: boolean;
  probeOwner?: ProbeOwner;
  daemonExited: boolean | null;
  groupGone: boolean | null;
  clientConnectAttempted: boolean;
  clientTrusted: boolean;
  closingClient: boolean;
  clientUnsubscribes: Array<() => void>;
  stopDaemon: StopDaemon;
}

interface World extends WorldResources {
  home: TempHome;
  repo: RepoFixture;
  identity: RepositoryIdentity;
  agentDir: string;
  dataRoot: string;
  handle: DaemonHandle;
  daemonPid: number;
  daemonPgid: number;
  client: DaemonClient;
}

interface CleanupFailure {
  stage: string;
  error: unknown;
}

interface PreservedCleanupDiagnostic {
  nonce: string | null;
  daemonExited: boolean | null;
  groupGone: boolean | null;
  home: string;
  repo: string;
  dataRoot: string;
  temporaryContainer: string;
  daemonPid: number;
  daemonPgid: number;
  failures: Array<{ stage: string; message: string }>;
}

const activeWorlds: WorldResources[] = [];

async function within<T>(promise: Promise<T>, label: string, timeoutMs = 5_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label}在 ${timeoutMs}ms 内未完成`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function processGroupExists(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw new Error(`无法核验守护进程组 ${pgid}：${String(error)}`);
  }
}

async function waitForProcessGroupGone(pgid: number, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      if (!processGroupExists(pgid)) return;
      lastError = undefined;
    } catch (error) { lastError = error; }
    // EPERM等未知结果仍在原预算内等待；只有实际ESRCH才能确认结束。
    await delay(25);
  }
  throw new Error(`守护进程组 ${pgid} 在 ${timeoutMs}ms 内未确认消失${lastError ? `：${String(lastError)}` : ""}`);
}

function cleanupDiagnostic(world: WorldResources, failures: CleanupFailure[]): PreservedCleanupDiagnostic | undefined {
  if (!world.home || !world.repo || !world.dataRoot || world.daemonPid === undefined || world.daemonPgid === undefined) return undefined;
  return {
    nonce: world.probeOwner?.nonce ?? null, daemonExited: world.daemonExited, groupGone: world.groupGone,
    home: world.home.home,
    repo: world.repo.root,
    dataRoot: world.dataRoot,
    temporaryContainer: dirname(world.dataRoot),
    daemonPid: world.daemonPid,
    daemonPgid: world.daemonPgid,
    failures: failures.map(({ stage, error }) => ({ stage, message: error instanceof Error ? error.message : String(error) })),
  };
}

async function cleanupWorld(world: WorldResources): Promise<void> {
  const failures: CleanupFailure[] = [];
  const fail = (stage: string, error: unknown, preserveRoots = false): void => {
    failures.push({ stage, error });
    if (preserveRoots) world.preserveRoots = true;
  };
  const attempt = async (stage: string, operation: () => unknown | Promise<unknown>): Promise<void> => {
    try { await operation(); } catch (error) { fail(stage, error); }
  };

  if (world.clientConnectAttempted && !world.clientTrusted) fail("client.identity", new Error("无法排除客户端首连失败或隐式重启"), true);
  world.closingClient = true;
  try { world.client?.close(); } catch (error) { fail("client.close", error, true); }
  for (const unsubscribe of world.clientUnsubscribes.splice(0)) {
    try { unsubscribe(); } catch (error) { fail("client.unsubscribe", error, true); }
  }
  if (world.agentDirEnvOverridden) {
    if (world.prevAgentDirEnv === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = world.prevAgentDirEnv;
    world.agentDirEnvOverridden = false;
  }

  if (world.daemonSpawnAttempted) {
    const handle = world.handle;
    if (!handle) {
      fail("daemon.identity", new Error("守护进程启动已尝试但没有可核验 handle，不向未知进程发送信号"), true);
    } else if (
      world.daemonPid === undefined
      || world.daemonPgid === undefined
      || world.daemonPid <= 1
      || world.daemonPgid !== world.daemonPid
      || handle.proc.pid !== world.daemonPid
    ) {
      fail("daemon.identity", new Error("守护进程 PID/PGID/handle 身份不一致，不向未知或复用 PID 发送信号"), true);
    } else {
      if (handle.proc.exitCode === null && handle.proc.signalCode === null) {
        try {
          await world.stopDaemon(handle);
        } catch (error) {
          fail("daemon.stop", error, true);
        }
      }
      try {
        await within(handle.exited, "等待本次守护进程 child.exited"); world.daemonExited = true;
      } catch (error) {
        world.daemonExited = null; fail("daemon.exited", error, true);
      }
      try {
        await waitForProcessGroupGone(world.daemonPgid); world.groupGone = true;
      } catch (error) {
        world.groupGone = null; fail("daemon.pgid", error, true);
      }
    }
  }

  try { writeProbeResource(world, "cleanup"); } catch (error) { fail("probe.record", error, true); }
  if (world.preserveRoots) {
    const diagnostic = cleanupDiagnostic(world, failures);
    console.error(`${PRESERVED_CLEANUP_PREFIX}${JSON.stringify(diagnostic ?? {
      home: world.home?.home,
      repo: world.repo?.root,
      dataRoot: world.dataRoot,
      daemonPid: world.daemonPid,
      daemonPgid: world.daemonPgid,
      failures: failures.map(({ stage, error }) => ({ stage, message: String(error) })),
    })}`);
  } else {
    if (world.repo) await attempt("repo.remove", () => removeRepoFixture(world.repo!));
    if (world.home) await attempt("home.remove", () => removeTempHome(world.home!));
    if (world.dataRoot) await attempt("dataRoot.remove", () => rm(world.dataRoot!, { recursive: true, force: true }));
  }

  if (failures.length > 0) {
    const stages = failures.map((failure) => failure.stage).join(", ");
    throw new AggregateError(failures.map((failure) => failure.error), `Agents 面板集成夹具清理失败（${stages}）`);
  }
}

afterEach(async () => {
  const failures: unknown[] = [];
  for (const world of activeWorlds.splice(0).reverse()) {
    try { await cleanupWorld(world); } catch (error) { failures.push(error); }
  }
  if (failures.length > 0) throw new AggregateError(failures, "Agents 面板集成测试清理失败");
});

async function seedRun(store: RunStore, repo: RepoFixture, input: SeedRun): Promise<string> {
  const run = await store.create({
    kind: "role",
    standalone: true,
    role: "pi-company.worker",
    requirement: input.requirement,
    task: input.task ?? "仅保留旧运行元数据，不授予执行或正文访问权限",
    cwd: repo.root,
    writePaths: [],
    readPaths: [],
    model: { provider: "metadata-only", id: "metadata-only" },
    thinking: "off",
    mcp: [],
  });
  if (input.state === "running" || input.state === "completed") {
    await store.update(run.id, { state: "running" });
  }
  if (input.state === "completed") await store.update(run.id, { state: "completed" });
  if (input.state === "stopped") await store.update(run.id, { state: "stopped" });
  return run.id;
}

function assertCompleteWorld(world: WorldResources): asserts world is World {
  if (
    !world.home
    || !world.repo
    || !world.identity
    || !world.agentDir
    || !world.dataRoot
    || !world.handle
    || world.daemonPid === undefined
    || world.daemonPgid === undefined
    || !world.client
  ) throw new Error("Agents 面板集成夹具初始化不完整");
}

function untrackWorld(world: WorldResources): void {
  const index = activeWorlds.indexOf(world);
  if (index >= 0) activeWorlds.splice(index, 1);
}

async function startWorld(seedInputs: SeedRun[]): Promise<World> {
  const world: WorldResources = {
    daemonSpawnAttempted: false,
    seededRunIds: {},
    prevAgentDirEnv: process.env.PI_CODING_AGENT_DIR,
    agentDirEnvOverridden: false,
    preserveRoots: false,
    daemonExited: null, groupGone: null, clientConnectAttempted: false, clientTrusted: false,
    closingClient: false, clientUnsubscribes: [],
    stopDaemon: cleanupFaultProbe
      ? async () => { throw new Error("injected daemon stop failure"); }
      : killDaemon,
  };
  activeWorlds.push(world);

  try {
    if (cleanupFaultProbe) {
      world.probeOwner = JSON.parse(process.env[PROBE_OWNER_ENV] ?? "null") as ProbeOwner;
      await assertProbeOwner(world.probeOwner);
    }
    const priorTmpdir = process.env.TMPDIR;
    try {
      if (world.probeOwner) process.env.TMPDIR = world.probeOwner.verification.path;
      world.home = await createTempHome();
      world.agentDir = world.home.agentDir;
      world.repo = await createRepoFixture();
    } finally {
      if (priorTmpdir === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = priorTmpdir;
    }
    world.identity = await repositoryIdentity(world.repo.root);
    world.dataRoot = await mkdtemp(join(world.probeOwner?.root.path ?? temporaryRoot(), "d"));
    await rmdir(world.home.dataRoot);
    await symlink(world.dataRoot, world.home.dataRoot);

    // 必须先写真实临时 SQLite，再启动 daemon；启动恢复只把旧非终态标为 interrupted，绝不续跑。
    const store = new RunStore({ dataRoot: world.dataRoot, repoId: world.identity.repoId, daemonStartedAt: "pre-daemon-metadata-only" });
    for (const seed of seedInputs) world.seededRunIds[seed.key] = await seedRun(store, world.repo, seed);

    const socketPath = daemonSocketPath(world.dataRoot, world.identity.repoId);
    // 空 provider 目录使测试环境保持离线；本文件不会触发任何模型运行。
    const providersPath = await writeTestModelProviders(world.dataRoot, []);
    if (Buffer.byteLength(socketPath) > 104) throw new Error("自有socket路径超过macOS预算");
    writeProbeResource(world, "spawn-attempted");
    world.daemonSpawnAttempted = true;
    const spawned = spawnDaemonProcess({
      home: world.home,
      repoDir: world.identity.commonDir,
      dataRoot: world.dataRoot,
      extraEnv: modelProviderEnv(providersPath),
      idleTimeoutMs: cleanupFaultProbe ? 250 : undefined,
    });
    world.handle = { ...spawned, socketPath };
    const daemonPid = spawned.proc.pid;
    if (daemonPid === undefined || !Number.isSafeInteger(daemonPid) || daemonPid <= 1) {
      throw new Error("守护进程已启动但没有可核验 PID/PGID handle");
    }
    world.daemonPid = daemonPid;
    world.daemonPgid = daemonPid;
    writeProbeResource(world, "spawned");
    await Promise.race([
      waitForSocketReady(socketPath),
      world.handle.exited.then((exit) => {
        throw new Error(`守护进程在 socket 就绪前退出（code=${exit.code} signal=${exit.signal}）：${exit.stderr || "无 stderr"}`);
      }),
    ]);

    process.env.PI_CODING_AGENT_DIR = world.agentDir;
    world.agentDirEnvOverridden = true;
    world.clientConnectAttempted = true;
    world.client = await connectDaemon({
      repoDir: world.repo.root,
      dataRoot: world.dataRoot,
      sdkDir: resolveSdkDir(),
      hello: {
        windowId: "test-window",
        pid: process.pid,
        sessionId: "test-session",
        cwd: world.repo.root,
        workspaceRoot: world.repo.root,
      },
    });
    const hello = await world.client.call("hello", {}), connection = world.client.connectionIdentity?.();
    if (hello.daemonPid !== world.daemonPid || hello.connectionSequence !== 1 || !connection || connection.connectionSequence !== 1) throw new Error("客户端未绑定本次daemon首连接");
    const stamp = JSON.stringify(connection);
    world.clientTrusted = true;
    world.clientUnsubscribes.push(world.client.subscribe(DAEMON_CLIENT_LIFECYCLE_EVENTS.disconnected, () => {
      if (!world.closingClient) { world.clientTrusted = false; world.preserveRoots = true; }
    }));
    world.clientUnsubscribes.push(world.client.subscribe(DAEMON_CLIENT_LIFECYCLE_EVENTS.connected, () => {
      if (JSON.stringify(world.client?.connectionIdentity?.()) !== stamp) { world.clientTrusted = false; world.preserveRoots = true; }
    }));
    assertCompleteWorld(world);
    return world;
  } catch (setupError) {
    let cleanupError: unknown;
    try { await cleanupWorld(world); } catch (error) { cleanupError = error; }
    untrackWorld(world);
    if (cleanupError !== undefined) {
      throw new AggregateError([setupError, cleanupError], "Agents 面板集成夹具初始化及清理均失败");
    }
    throw setupError;
  }
}

interface Mounted {
  harness: IntegrationShell;
  fakeClock: FakeTimeSource;
  getActivity: () => AgentsActivity | undefined;
  fakePi: ReturnType<typeof createFakePi>;
  ctx: { mode: string; hasUI: boolean; cwd: string; ui: IntegrationShell["ui"] };
}

async function mountShell(world: World): Promise<Mounted> {
  const harness = new IntegrationShell();
  const fakeClock = createFakeTimeSource();
  let capturedActivity: AgentsActivity | undefined;
  const fakePi = createFakePi();

  const windowContextValue: WindowContextValue = {
    windowId: "test-window",
    sessionId: "test-session",
    workspace: {
      repos: [{ repoId: world.identity.repoId, path: world.repo.root, commonDir: world.identity.commonDir }],
      skipped: [],
    },
    clients: {
      forRepo: (id: string) => (id === world.identity.repoId ? world.client : undefined),
      all: () => [world.client],
      skipped: () => [],
      workspace: () => ({
        repos: [{ repoId: world.identity.repoId, path: world.repo.root, commonDir: world.identity.commonDir }],
        skipped: [],
      }),
      closeAll: () => {},
    },
  };

  const deps: AgentsUiDeps = {
    windowReady: () => Promise.resolve(windowContextValue),
    createClock: () => createClock({ timeSource: fakeClock }),
    createAgentsActivity: (options) => {
      capturedActivity = new AgentsActivity(options);
      return capturedActivity;
    },
  };
  agentsUiExtension(fakePi.pi, deps);

  const ctx = { mode: "tui", hasUI: true, cwd: world.repo.root, ui: harness.ui };
  await fakePi.trigger("session_start", { type: "session_start", reason: "new" }, ctx);
  await waitFor(() => harness.panel() !== undefined, 5_000);

  return { harness, fakeClock, getActivity: () => capturedActivity, fakePi, ctx };
}

async function unmountShell(mounted: Mounted): Promise<void> {
  await mounted.fakePi.trigger("session_shutdown", { type: "session_shutdown", reason: "quit" }, mounted.ctx);
}

function renderShell(harness: IntegrationShell): Promise<string[]> {
  return renderComponent(harness, 100, 40);
}

function pressShellKeys(harness: IntegrationShell, keys: string[]): Promise<string[][]> {
  return pressKeys(harness, keys, 100, 40);
}

function rowState(mounted: Mounted, runId: string): RunState | undefined {
  return mounted.getActivity()?.rows().find((row) => row.id === runId)?.status;
}

async function waitForRow(mounted: Mounted, runId: string, state?: RunState): Promise<void> {
  await waitFor(() => {
    const row = mounted.getActivity()?.rows().find((candidate) => candidate.id === runId);
    return row !== undefined && (state === undefined || row.status === state);
  }, 5_000);
}

const runningSeed = (key: string, requirement: string): SeedRun => ({ key, requirement, state: "running" });

async function assertOwnedPreservedFixture(value: unknown, expected: ProbeOwner): Promise<DirectoryIdentity[]> {
  await assertProbeOwner(expected);
  const diagnostic = value as PreservedCleanupDiagnostic | null;
  if (!diagnostic || typeof diagnostic !== "object" || diagnostic.nonce !== expected.nonce ||
    diagnostic.temporaryContainer !== expected.root.path || diagnostic.daemonExited !== true || diagnostic.groupGone !== true ||
    !Number.isSafeInteger(diagnostic.daemonPid) || diagnostic.daemonPid <= 1 || diagnostic.daemonPgid !== diagnostic.daemonPid ||
    !Array.isArray(diagnostic.failures)) throw new Error("本次夹具/退出证明不完整");
  for (const path of [diagnostic.home, diagnostic.repo, diagnostic.dataRoot]) {
    if (typeof path !== "string" || !isAbsolute(path)) throw new Error("夹具路径无效");
  }
  if (dirname(diagnostic.home) !== expected.verification.path || !basename(diagnostic.home).startsWith("pi-company-home-") ||
    dirname(diagnostic.repo) !== expected.verification.path || !basename(diagnostic.repo).startsWith("pi-company-repo-") ||
    dirname(diagnostic.dataRoot) !== expected.root.path || !basename(diagnostic.dataRoot).startsWith("d")) throw new Error("夹具不属于本次父目录");
  const identities = await Promise.all([diagnostic.home, diagnostic.repo, diagnostic.dataRoot].map(directoryIdentity));
  if (await realpath(join(diagnostic.home, ".pi", "agent", "pi-company")) !== diagnostic.dataRoot) throw new Error("夹具数据链接不匹配");
  const resourcePath = join(expected.root.path, "resource.json"), resourceFile = await lstat(resourcePath);
  if (!resourceFile.isFile() || resourceFile.isSymbolicLink() || (resourceFile.mode & 0o077) !== 0) throw new Error("探针资源记录不是私有普通文件");
  const resource = JSON.parse(await readFile(resourcePath, "utf8"));
  if (resource.nonce !== expected.nonce || resource.root !== expected.root.path || resource.phase !== "cleanup" ||
    resource.daemonPid !== diagnostic.daemonPid || resource.daemonPgid !== diagnostic.daemonPgid ||
    resource.daemonExited !== true || resource.groupGone !== true) throw new Error("本次daemon资源记录未确认结束");
  return identities;
}

async function directoryExists(path: string): Promise<boolean> {
  try { return (await stat(path)).isDirectory(); } catch { return false; }
}

async function runOwnedProbe(owner: ProbeOwner, args: string[], timeoutMs = 30_000, waitForReady = false): Promise<DaemonExitResult> {
  await assertProbeOwner(owner);
  const proc = spawn(process.execPath, args, {
    cwd: fileURLToPath(new URL("../../", import.meta.url)), detached: true,
    env: { ...process.env, [CLEANUP_FAULT_PROBE_ENV]: "1", [PROBE_OWNER_ENV]: JSON.stringify(owner), NO_COLOR: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "", stderr = "", ready!: () => void;
  const readyPromise = new Promise<void>((resolve) => { ready = resolve; });
  const append = (prior: string, chunk: Buffer) => (prior + chunk.toString("utf8")).slice(-256 * 1024);
  proc.stdout?.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); if (stdout.includes("PROBE_READY")) ready(); });
  proc.stderr?.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });
  const exited = new Promise<DaemonExitResult>((resolve, reject) => {
    proc.once("error", reject);
    proc.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  void exited.catch(() => undefined);
  let result: DaemonExitResult | undefined, failed = false, closed = false, groupGone = false;
  const failures: unknown[] = [];
  try {
    if (waitForReady) await within(Promise.race([readyPromise, exited.then(() => { throw new Error("probe exited before ready"); })]), "等待探针就绪");
    result = await within(exited, "等待清理故障注入测试进程退出", timeoutMs); closed = true;
  } catch (error) { failed = true; failures.push(error); }
  finally {
    const pid = proc.pid;
    try {
      if (!Number.isSafeInteger(pid) || pid! <= 1) throw new Error("故障探针没有可信child PID");
      if (!closed) {
        if (proc.exitCode === null && proc.signalCode === null) {
          try { process.kill(-pid!, "SIGTERM"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
        }
        try { result = await within(exited, "等待探针TERM后close", 500); closed = true; }
        catch {
          if (proc.exitCode === null && proc.signalCode === null) {
            try { process.kill(-pid!, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
          }
          result = await within(exited, "等待探针KILL后close"); closed = true;
        }
      }
      // 只对本次活着的child组发信号；组长已退而组仍存在时保全，不猜测成员身份。
      await waitForProcessGroupGone(pid!); groupGone = true;
    } catch (error) { failed = true; failures.push(error); }
    try {
      await assertProbeOwner(owner);
      await writeFile(join(owner.root.path, "parent-result.json"), JSON.stringify({ nonce: owner.nonce, pid, failed, closed, groupGone,
        daemon: failed ? "unknown_preserved" : "requires_resource_record", code: result?.code, signal: result?.signal,
        stdout, stderr, errors: failures.map(String) }), { mode: 0o600, flag: "wx" });
    } catch (error) { failed = true; failures.push(error); }
  }
  if (failed || !result) throw new AggregateError(failures, `故障探针失败；保全本次目录 ${owner.root.path}`);
  return { ...result, stdout, stderr };
}

async function verifyCleanupFailureProtection(): Promise<void> {
  const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
  const vitestEntry = join(packageRoot, "node_modules", "vitest", "vitest.mjs");
  const owner = await createProbeOwner();
  const result = await runOwnedProbe(owner, [vitestEntry, "run", "tests/integration/agents-panel.test.ts", "--reporter=verbose"]);
  const output = `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`;

  const evidenceDirectory = process.env[CLEANUP_EVIDENCE_DIRECTORY_ENV];
  if (evidenceDirectory) {
    const mode = await stat(evidenceDirectory);
    if (!mode.isDirectory() || (mode.mode & 0o077) !== 0) throw new Error("清理故障证据目录必须是私有目录");
    await writeFile(join(evidenceDirectory, "cleanup-failure.log"), output, { mode: 0o600 });
  }

  expect(result.code, output).not.toBe(0);
  expect(result.signal, output).toBeNull();
  const markerLine = output.split(/\r?\n/).find((line) => line.includes(PRESERVED_CLEANUP_PREFIX));
  expect(markerLine, output).toBeDefined();
  const markerIndex = markerLine!.indexOf(PRESERVED_CLEANUP_PREFIX);
  const diagnostic = JSON.parse(markerLine!.slice(markerIndex + PRESERVED_CLEANUP_PREFIX.length)) as PreservedCleanupDiagnostic;
  const identities = await assertOwnedPreservedFixture(diagnostic, owner);
  expect(diagnostic.failures).toEqual([{ stage: "daemon.stop", message: "injected daemon stop failure" }]);
  expect(await directoryExists(diagnostic.home), output).toBe(true);
  expect(await directoryExists(diagnostic.repo), output).toBe(true);
  expect(await directoryExists(diagnostic.dataRoot), output).toBe(true);

  // 故障 daemon 依靠关闭 client 后的短空闲时限自行退出；这里只探测原 PGID，不向日志中的 PID 发信号。
  await waitForProcessGroupGone(diagnostic.daemonPgid, 10_000);
  expect(await assertOwnedPreservedFixture(diagnostic, owner)).toEqual(identities);
  await rm(diagnostic.repo, { recursive: true, force: true });
  await rm(diagnostic.home, { recursive: true, force: true });
  await rm(diagnostic.dataRoot, { recursive: true, force: true });
  await rmdir(dirname(diagnostic.home));
  await unlink(join(owner.root.path, "resource.json"));
  await unlink(join(owner.root.path, "parent-result.json"));
  await rmdir(diagnostic.temporaryContainer);
  expect(await directoryExists(diagnostic.repo)).toBe(false);
  expect(await directoryExists(diagnostic.home)).toBe(false);
  expect(await directoryExists(diagnostic.dataRoot)).toBe(false);
}

if (cleanupFaultProbe) {
  test("清理停止失败探针保留全部夹具根并让测试进程失败", async () => {
    const world = await startWorld([]);
    expect(world.handle.proc.pid).toBe(world.daemonPid);
    expect(await world.client.call("ping", {})).toHaveProperty("now");
  }, 30_000);
} else {
test("PGID探测未知不等于结束：原预算内仅实际ESRCH放行，持续EPERM仍拒绝", async () => {
  const originalKill = process.kill;
  const pgid = 999_999_991;
  let attempts = 0, remainsUnknown = false;
  process.kill = ((pid: number, signal?: string | number) => {
    if (pid !== -pgid || signal !== 0) return originalKill.call(process, pid, signal);
    attempts++;
    if (remainsUnknown || attempts < 3) throw Object.assign(new Error("probe EPERM"), { code: "EPERM" });
    throw Object.assign(new Error("probe ESRCH"), { code: "ESRCH" });
  }) as typeof process.kill;
  try {
    await expect(waitForProcessGroupGone(pgid, 250)).resolves.toBeUndefined();
    expect(attempts).toBe(3);
    remainsUnknown = true; attempts = 0;
    await expect(waitForProcessGroupGone(pgid, 75)).rejects.toThrow(/未确认消失.*EPERM/);
    expect(attempts).toBeGreaterThan(1);
  } finally { process.kill = originalKill; }
});

test.each([false, true])("故障探针超时收尾真实child并保全记录（忽略TERM=%s）", async (ignoreTerm) => {
  const owner = await createProbeOwner();
  const script = `${ignoreTerm ? 'process.on("SIGTERM", () => {});' : ''} console.log("PROBE_READY"); setInterval(() => {}, 1000);`;
  await expect(runOwnedProbe(owner, ["-e", script], 50, true)).rejects.toThrow(/保全本次目录/);
  const result = JSON.parse(await readFile(join(owner.root.path, "parent-result.json"), "utf8"));
  expect(result).toMatchObject({ nonce: owner.nonce, failed: true, closed: true, groupGone: true, daemon: "unknown_preserved", signal: ignoreTerm ? "SIGKILL" : "SIGTERM" });
  expect(result.stdout).toContain("PROBE_READY");
  expect(processGroupExists(result.pid)).toBe(false);
  expect(await directoryExists(owner.root.path)).toBe(true);
  const evidence = process.env[CLEANUP_EVIDENCE_DIRECTORY_ENV];
  if (evidence) await writeFile(join(evidence, `probe-timeout-${ignoreTerm ? "kill" : "term"}.json`), JSON.stringify(result), { mode: 0o600 });
  // 此控制进程只有固定setInterval，没有daemon；核对结束后仅删除父已创建的文件及空目录。
  await assertProbeOwner(owner);
  await unlink(join(owner.root.path, "parent-result.json")); await unlink(join(owner.root.path, "resource.json"));
  await rmdir(owner.verification.path); await rmdir(owner.root.path);
}, 15_000);

test("同前缀异根、错nonce及目录别名不能成为本次清理许可", async () => {
  const first = await createProbeOwner(), second = await createProbeOwner();
  try {
    const shaped = { nonce: second.nonce, temporaryContainer: second.root.path, daemonPid: process.pid, daemonPgid: process.pid,
      daemonExited: true, groupGone: true, failures: [], home: join(second.verification.path, "pi-company-home-old"),
      repo: join(second.verification.path, "pi-company-repo-old"), dataRoot: join(second.root.path, "data") };
    await expect(assertOwnedPreservedFixture(shaped, first)).rejects.toThrow();
    await expect(assertOwnedPreservedFixture({ ...shaped, nonce: first.nonce }, first)).rejects.toThrow();
    const alias = join(first.root.path, "alias"); await symlink(first.verification.path, alias);
    try { await expect(directoryIdentity(alias)).rejects.toThrow(); } finally { await unlink(alias); }
    await expect(assertProbeOwner({ ...first, root: { ...first.root, ino: first.root.ino + 1 } })).rejects.toThrow();
  } finally {
    for (const owner of [first, second]) { await assertProbeOwner(owner); await unlink(join(owner.root.path, "resource.json")); await rmdir(owner.verification.path); await rmdir(owner.root.path); }
  }
});

test("client.close抛错保全全部根，仍恢复环境并收尾已知daemon", async () => {
  const world = await startWorld([]), close = world.client.close.bind(world.client);
  world.closingClient = true; close(); // 控制故障不遗留可重连的真实客户端。
  world.client.close = () => { throw new Error("injected client close failure"); };
  try {
    await expect(cleanupWorld(world)).rejects.toThrow(/client.close/);
    expect(world.preserveRoots).toBe(true);
    expect(world.daemonExited).toBe(true); expect(world.groupGone).toBe(true);
    expect(process.env.PI_CODING_AGENT_DIR).toBe(world.prevAgentDirEnv);
    for (const path of [world.repo.root, world.home.home, world.dataRoot]) expect(await directoryExists(path)).toBe(true);
  } finally {
    world.client.close = close; close();
    if (world.daemonExited === true && world.groupGone === true) {
      world.preserveRoots = false; await cleanupWorld(world); untrackWorld(world);
    }
  }
}, 30_000);

describe("集成：Agents 面板顺序与导航", () => {
  test("空输入按 ↓ 直接进入代理面板，面板内 Esc 回到输入栏", async () => {
    const world = await startWorld([runningSeed("run", "2026-09-10.nav-metadata")]);
    const mounted = await mountShell(world);
    const runId = world.seededRunIds.run!;
    try {
      await waitForRow(mounted, runId, "interrupted");
      const before = await renderShell(mounted.harness);
      expect(before.some((line) => line.startsWith("> "))).toBe(true);

      const afterDown = await pressShellKeys(mounted.harness, [KEY.down]);
      expect(currentDock()?.focus()).toBe("panel");
      expect(afterDown[0]?.some((line) => line.includes("停止"))).toBe(true);

      const afterEscape = await pressShellKeys(mounted.harness, [KEY.escape]);
      expect(currentDock()?.focus()).toBe("editor");
      expect(afterEscape[0]?.some((line) => line.startsWith("> "))).toBe(true);
    } finally {
      await unmountShell(mounted);
    }
  }, 30_000);
});

describe("集成：状态栏与汇总文本", () => {
  test("原状态栏与汇总文本在面板导航期间始终可见，且不出现在可选中的行里", async () => {
    const world = await startWorld([runningSeed("run", "2026-09-10.status-metadata")]);
    const mounted = await mountShell(world);
    const runId = world.seededRunIds.run!;
    try {
      await waitForRow(mounted, runId, "interrupted");
      const before = await renderShell(mounted.harness);
      expect(before).toContain(mounted.harness.statusSummaryText);

      const traces = await pressShellKeys(mounted.harness, [KEY.down, KEY.down, KEY.up, KEY.down]);
      for (const snapshot of traces) {
        expect(snapshot).toContain(mounted.harness.statusSummaryText);
        expect(snapshot.indexOf(mounted.harness.statusSummaryText)).toBe(1);
      }
      expect(mounted.harness.panel()?.selectedRunKey()).toEqual({ repoId: world.identity.repoId, runId });
    } finally {
      await unmountShell(mounted);
    }
  }, 30_000);
});

describe("集成：面板不抢按键", () => {
  test("输入栏非空或设置页占用时，↓ 不进入面板", async () => {
    const world = await startWorld([runningSeed("run", "2026-09-10.no-steal-metadata")]);
    const mounted = await mountShell(world);
    const runId = world.seededRunIds.run!;
    try {
      await waitForRow(mounted, runId, "interrupted");
      mounted.harness.setEditorText("draft");
      await pressShellKeys(mounted.harness, [KEY.down]);
      expect(currentDock()?.focus()).toBe("editor");
      expect((await renderShell(mounted.harness)).some((line) => line.startsWith("> draft"))).toBe(true);

      mounted.harness.setEditorText("");
      currentDock()?.markPageOpen();
      try {
        await pressShellKeys(mounted.harness, [KEY.down]);
        expect(currentDock()?.focus()).toBe("editor");
      } finally {
        currentDock()?.markPageClosed();
      }
    } finally {
      await unmountShell(mounted);
    }
  }, 30_000);
});

describe("集成：旧正文查看与恢复入口退场", () => {
  test("面板没有查看/继续入口，旧按键序列只能执行安全停止，正文订阅与恢复 RPC 固定拒绝", async () => {
    const world = await startWorld([runningSeed("run", "2026-09-10.retired-body-entry")]);
    const mounted = await mountShell(world);
    const runId = world.seededRunIds.run!;
    try {
      await waitForRow(mounted, runId, "interrupted");
      const initial = (await renderShell(mounted.harness)).join("\n");
      expect(initial).toContain("登记中断");
      expect(initial).not.toMatch(/查看|继续|续接/);

      await pressShellKeys(mounted.harness, [KEY.down]);
      await pressShellKeys(mounted.harness, [KEY.right, KEY.right, KEY.enter]);
      await waitForRow(mounted, runId, "stopped");
      expect(mounted.harness.customInvocationCount).toBe(0);
      expect(mounted.harness.legacyBodyOpen()).toBe(false);
      expect(mounted.harness.panel()?.selectedRunKey()).toEqual({ repoId: world.identity.repoId, runId });
      expect((await renderShell(mounted.harness)).join("\n")).not.toMatch(/查看|继续|续接/);

      await expect(world.client.call("subscribe.transcript", { runId, fromSeq: 0 })).rejects.toMatchObject({ code: "legacy_workflow_retired" });
      await expect(world.client.call("runs.resume", { runId })).rejects.toMatchObject({ code: "not_resumable" });
    } finally {
      await unmountShell(mounted);
    }
  }, 30_000);
});

describe("集成：真实运行元数据事件", () => {
  test("runs.stop 的真实 socket 事件把已登记中断实时更新为停止，不注入旧正文", async () => {
    const world = await startWorld([runningSeed("run", "2026-09-10.live-metadata-change")]);
    const mounted = await mountShell(world);
    const runId = world.seededRunIds.run!;
    const events: Array<Record<string, unknown>> = [];
    const unsubscribe = world.client.subscribe("runs.changed", (data) => events.push(data));
    try {
      await waitForRow(mounted, runId, "interrupted");
      expect(rowState(mounted, runId)).toBe("interrupted");

      expect(await world.client.call("runs.stop", { runId })).toMatchObject({ state: "stopped", confirmed: true });
      await waitForRow(mounted, runId, "stopped");
      await waitFor(() => events.some((event) => (event.run as { id?: string; state?: string } | undefined)?.id === runId
        && (event.run as { state?: string }).state === "stopped"), 5_000);

      const rendered = (await renderShell(mounted.harness)).join("\n");
      expect(rendered).toContain("登记停止");
      expect(mounted.harness.customInvocationCount).toBe(0);
    } finally {
      unsubscribe();
      await unmountShell(mounted);
    }
  }, 30_000);
});

describe("集成：结束条目 20 秒保留", () => {
  test("登记终态不会自动隐藏；可见面板显式安全停止确认后第 19 秒仍在，跨 20 秒移出", async () => {
    const world = await startWorld([{ key: "run", requirement: "2026-09-10.retention-metadata", state: "completed" }]);
    const mounted = await mountShell(world);
    const runId = world.seededRunIds.run!;
    try {
      await waitForRow(mounted, runId, "completed");
      const initiallyRendered = (await renderShell(mounted.harness)).join("\n");
      expect(initiallyRendered).toContain("登记完成（非需求完成）");
      expect(initiallyRendered).toContain("停止未核实");

      mounted.fakeClock.advance(21_000);
      expect((await renderShell(mounted.harness)).join("\n")).toContain("登记完成（非需求完成）");

      await pressShellKeys(mounted.harness, [KEY.down]);
      expect(currentDock()?.focus()).toBe("panel");
      await pressShellKeys(mounted.harness, [KEY.enter]);
      await waitFor(() => mounted.getActivity()?.rows().find((row) => row.id === runId)?.stopConfirmed === true, 10_000);
      expect(await world.client.call("runs.get", { runId })).toMatchObject({ run: { state: "completed" } });

      mounted.fakeClock.advance(19_000);
      expect(rowState(mounted, runId)).toBe("completed");
      expect((await renderShell(mounted.harness)).join("\n")).toContain("登记完成（非需求完成）");

      mounted.fakeClock.advance(2_000);
      expect(rowState(mounted, runId)).toBeUndefined();
      expect((await renderShell(mounted.harness)).join("\n")).not.toContain("登记完成（非需求完成）");
    } finally {
      await unmountShell(mounted);
    }
  }, 30_000);
});

test("晚打开面板通过真实订阅快照显示预登记旧 run metadata，不恢复派工或正文", async () => {
  const privateBody = "OLD-BODY-MUST-NOT-ENTER-PANEL-18471";
  const world = await startWorld([{ key: "run", requirement: "2026-09-10.initial-metadata-snapshot", state: "completed", task: privateBody }]);
  const runId = world.seededRunIds.run!;
  const subscribed = await world.client.call("subscribe.activity", {});
  expect((subscribed.snapshot as Array<{ id: string; state: string }>)).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: runId, state: "completed" }),
  ]));
  expect(JSON.stringify(subscribed)).not.toContain(privateBody);

  const mounted = await mountShell(world);
  try {
    await waitForRow(mounted, runId, "completed");
    const rendered = (await renderShell(mounted.harness)).join("\n");
    expect(rendered).toContain("登记完成（非需求完成）");
    expect(rendered).not.toContain(privateBody);
    expect(mounted.harness.customInvocationCount).toBe(0);
  } finally {
    await unmountShell(mounted);
  }
  await verifyCleanupFailureProtection();
}, 60_000);
}
