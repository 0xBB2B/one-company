import { afterEach, describe, expect, test } from "vitest";
import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { appendDecision } from "../../runtime/decisions.ts";
import { executeWorkflowAction } from "../../runtime/workflow-tool.ts";
import type { ScriptedReply } from "../helpers/controlled-provider.ts";
import {
  connectTestClient,
  createDaemonFixture,
  killDaemon,
  removeDaemonFixture,
  resolveNodeExecutable,
  resolveSdkDir,
  startDaemonForTest,
} from "../helpers/daemon-harness.ts";
import type { DaemonFixture, DaemonHandle, TestClient } from "../helpers/daemon-harness.ts";
import { modelProviderEnv, writeTestModelProviders } from "../helpers/daemon-model-fixture.ts";
import type { TestProviderScript } from "../helpers/daemon-model-fixture.ts";

const windowRunnerEntry = fileURLToPath(new URL("../helpers/window-runner.ts", import.meta.url));

const LONG_TIMEOUT = 40_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs: number, intervalMs = 100): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(intervalMs);
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

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ---- 世界与角色调度：真实守护进程子进程 + 受控 provider，驱动出真实的角色宿主后台 Shell ----

interface World {
  fixture: DaemonFixture;
  handle: DaemonHandle;
  client: TestClient;
}

const activeWorlds: World[] = [];
const windowProcs: ChildProcess[] = [];
const windowStateDirs: string[] = [];
const trackedPgids: number[] = [];
const extraTempDirs: string[] = [];

afterEach(async () => {
  for (const proc of windowProcs.splice(0)) {
    if (proc.exitCode === null && proc.signalCode === null) {
      proc.kill("SIGKILL");
      await Promise.race([new Promise<void>((resolve) => proc.once("exit", () => resolve())), delay(2_000)]);
    }
  }
  for (const dir of windowStateDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
  for (const pgid of trackedPgids.splice(0)) {
    try {
      process.kill(-pgid, "SIGKILL");
    } catch {
      // 组已消失，无需处理
    }
  }
  for (const world of activeWorlds.splice(0)) {
    world.client.close();
    await killDaemon(world.handle).catch(() => undefined);
    await removeDaemonFixture(world.fixture).catch(() => undefined);
  }
  for (const dir of extraTempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

function toolReply(name: string, input: Record<string, unknown>): ScriptedReply {
  return { type: "toolcall", name, input };
}

function textReply(text: string): ScriptedReply {
  return { type: "text", text };
}

function shapeTask(id: string, role: string, writePaths: string[]): Record<string, unknown> {
  return { id, title: `任务 ${id}`, roles: [role], dependsOn: [], writePaths };
}

function proposeShapeReply(tasks: Array<Record<string, unknown>>): ScriptedReply {
  return toolReply("pi_company_propose_shape", {
    tasks,
    gates: { whiteboxReview: false, blackboxAcceptance: false },
    rationale: "host-exit 测试固定形状",
  });
}

function dispatchRoleReply(role: string, task: string, writePaths: string[]): ScriptedReply {
  return toolReply("pi_company_agent", { action: "run", role, task, writePaths, readPaths: [] });
}

const REQUIREMENT_PROVIDER = { providerId: "controlled-requirement-agent", modelId: "controlled-model", roleName: "requirement-agent" };

async function startWorld(scripts: TestProviderScript[]): Promise<World> {
  const fixture = await createDaemonFixture();
  const providersPath = await writeTestModelProviders(fixture.dataRoot, scripts);
  const handle = await startDaemonForTest(fixture, { extraEnv: modelProviderEnv(providersPath) });
  const client = await connectTestClient(fixture.socketPath, {
    cwd: fixture.repo.root,
    workspaceRoot: fixture.repo.root,
    repoIds: [fixture.repoId],
  });
  const world: World = { fixture, handle, client };
  activeWorlds.push(world);
  return world;
}

async function confirmRequirement(dataRoot: string, cwd: string, requirement: string): Promise<void> {
  await executeWorkflowAction({ action: "init", requirement }, { dataRoot, cwd });
  const decision = await appendDecision(
    {
      requirement,
      actor: "user",
      source: "test",
      trigger: "确认需求",
      decision: "确认进入执行",
      alternatives: [],
      effects: ["scope"],
      impact: "host-exit 测试固定路径",
    },
    { dataRoot, cwd },
  );
  const result = await executeWorkflowAction(
    { action: "advance", requirement, stage: "confirmed", version: 1, decisionId: decision.decisionId },
    { dataRoot, cwd },
  );
  if (result.details.isError) throw new Error(`测试固件未能确认需求: ${result.text}`);
}

function autoConfirmShape(client: TestClient): () => void {
  return client.onEvent("relay.question", (data) => {
    void client.call("relay.answer", { questionId: data.id as string, answer: "确认", windowId: "test-window" });
  });
}

interface RunView {
  id: string;
  kind: string;
  state: string;
  task: string;
  role?: string;
  parentRunId?: string;
}

async function listRuns(client: TestClient): Promise<RunView[]> {
  const result = await client.call("runs.list", { limit: 200 });
  return result.items as RunView[];
}

async function waitForRun(client: TestClient, predicate: (run: RunView) => boolean, timeoutMs = 15_000): Promise<RunView> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const found = (await listRuns(client)).find(predicate);
    if (found) return found;
    await delay(150);
  }
  throw new Error("等待目标运行超时");
}

interface ShellTaskView {
  taskId: string;
  host: { kind: string; id: string; role?: string; runId?: string };
  pid: number;
  pgid: number;
  status: string;
  descendants: number[];
}

async function listShells(client: TestClient): Promise<ShellTaskView[]> {
  const result = await client.call("shells.list", {});
  return result.tasks as ShellTaskView[];
}

async function waitForShell(client: TestClient, predicate: (task: ShellTaskView) => boolean, timeoutMs = 15_000): Promise<ShellTaskView> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const found = (await listShells(client)).find(predicate);
    if (found) return found;
    await delay(150);
  }
  throw new Error("等待目标 Shell 任务超时");
}

interface RoleBackgroundShell {
  world: World;
  requirementRunId: string;
  roleRunId: string;
  taskId: string;
  pgid: number;
  descendants: number[];
}

// 派出一个真实需求 -> 确认形状 -> worker 角色在守护进程内起一个带后代的后台 Shell；
// 这个 Shell 挂在守护进程自身的 ShellRegistry 下，代表"守护进程持有的角色 Shell"，
// 用来验证窗口退出路径不会波及它、而守护进程自己退出时才会停它
async function setupRoleBackgroundShell(requirement: string, bashInput: Record<string, unknown>): Promise<RoleBackgroundShell> {
  const scripts: TestProviderScript[] = [
    {
      ...REQUIREMENT_PROVIDER,
      replies: [proposeShapeReply([shapeTask("T-1", "worker", ["area-a"])]), dispatchRoleReply("worker", "T-1", ["area-a"]), textReply("已派工")],
    },
    {
      providerId: "controlled-worker-T-1",
      modelId: "controlled-model",
      roleName: "worker",
      taskId: "T-1",
      replies: [toolReply("bash", bashInput), textReply("后台任务已启动，等待后续指示")],
    },
  ];
  const world = await startWorld(scripts);
  const unsubscribe = autoConfirmShape(world.client);
  await confirmRequirement(world.fixture.dataRoot, world.fixture.repo.root, requirement);
  const requirementRunId = (
    await world.client.call("dispatch.requirement", { requirement, cwd: world.fixture.repo.root })
  ).runId as string;
  const roleRun = await waitForRun(world.client, (run) => run.kind === "role" && run.task === "T-1");
  unsubscribe();

  const shell = await waitForShell(world.client, (t) => t.host.runId === roleRun.id);
  trackedPgids.push(shell.pgid);
  return {
    world,
    requirementRunId,
    roleRunId: roleRun.id,
    taskId: shell.taskId,
    pgid: shell.pgid,
    descendants: shell.descendants,
  };
}

// ---- 窗口子进程：真实拉起，走生产 lifecycle 扩展的真实 shutdownWindow / installExitSignalHandlers ----

interface WindowState {
  phase: string;
  windowId?: string;
  taskId?: string;
  pid?: number;
  pgid?: number;
  reason?: string;
  connected?: boolean;
}

interface WindowHandle {
  proc: ChildProcess;
  stateFile: string;
}

async function spawnWindowHost(world: World, options: { viaPty?: boolean } = {}): Promise<WindowHandle> {
  const stateDir = await mkdtemp(join(tmpdir(), "host-exit-window-"));
  windowStateDirs.push(stateDir);
  const stateFile = join(stateDir, "state.json");
  const configFile = join(stateDir, "config.json");
  await writeFile(
    configFile,
    JSON.stringify({
      cwd: world.fixture.repo.root,
      dataRoot: world.fixture.dataRoot,
      sdkDir: resolveSdkDir(),
      stateFile,
      shellCommand: `: HOSTEXITTEST_WINDOW_${randomUUID()}; sleep 60 & sleep 60 & wait`,
    }),
  );

  const proc = options.viaPty
    ? spawn("python3", ["-c", PTY_HOST, resolveNodeExecutable(), windowRunnerEntry, configFile], { stdio: ["pipe", "pipe", "pipe"] })
    : spawn(resolveNodeExecutable(), [windowRunnerEntry, configFile], { stdio: ["pipe", "pipe", "pipe"] });
  windowProcs.push(proc);
  return { proc, stateFile };
}

async function waitForWindowState(stateFile: string, predicate: (state: WindowState) => boolean, timeoutMs: number): Promise<WindowState> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const state = JSON.parse(await readFile(stateFile, "utf8")) as WindowState;
      if (predicate(state)) return state;
    } catch {
      // 状态文件尚未写入或写入未完成，继续轮询
    }
    await delay(100);
  }
  throw new Error(`等待窗口状态超时（${timeoutMs}ms）：${stateFile}`);
}

function waitChildExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    const timer = setTimeout(() => reject(new Error(`等待窗口进程退出超时（${timeoutMs}ms）`)), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

const PTY_HOST = `import os, pty, sys
pid, master = pty.fork()
if pid == 0:
    os.execv(sys.argv[1], sys.argv[1:])
try:
    while True:
        data = os.read(master, 65536)
        if not data:
            break
except OSError:
    pass
finally:
    os.close(master)
    os.waitpid(pid, 0)
`;

// ============================================================
// 用例矩阵
// ============================================================

describe("窗口 /quit 或等价退出路径", () => {
  test(
    "窗口触发 session_shutdown（/quit 等价路径）：窗口 Shell 及后代停止，守护进程角色 Shell 继续运行",
    async () => {
      const requirement = "2026-09-10.host-exit-quit";
      const { world, pgid: daemonShellPgid, descendants: daemonDescendants } = await setupRoleBackgroundShell(requirement, {
        command: `: HOSTEXITTEST_DAEMON_${randomUUID()}; sleep 60 & sleep 60 & wait`,
        background: true,
      });
      for (const pid of daemonDescendants) expect(pidAlive(pid)).toBe(true);

      const window = await spawnWindowHost(world);
      const ready = await waitForWindowState(window.stateFile, (s) => s.phase === "ready" || s.phase === "failed", 15_000);
      expect(ready.phase).toBe("ready");
      if (ready.phase !== "ready" || ready.pgid === undefined) return;
      trackedPgids.push(ready.pgid);
      expect(groupAlive(ready.pgid)).toBe(true);
      // 窗口经真实 socket 向同一守护进程握手成功，证明本用例的窗口/守护进程是两个真实互联的进程，
      // 而不是两个互不相干、只是恰好都在跑的进程
      expect(ready.connected).toBe(true);

      window.proc.stdin?.write("QUIT\n");
      await waitChildExit(window.proc, 10_000);

      expect(groupAlive(ready.pgid)).toBe(false);
      expect(groupAlive(daemonShellPgid)).toBe(true);
      for (const pid of daemonDescendants) expect(pidAlive(pid)).toBe(true);
      const daemonAfter = await listShells(world.client);
      expect(daemonAfter.find((t) => t.pgid === daemonShellPgid)?.status).toBe("running");
    },
    LONG_TIMEOUT,
  );
});

describe("可处理信号", () => {
  test.each(["SIGTERM", "SIGHUP"] as const)(
    "向窗口发送 %s：效果与 /quit 等价——窗口 Shell 及后代停止，守护进程角色 Shell 继续运行",
    async (signal) => {
      const requirement = `2026-09-10.host-exit-signal-${signal.toLowerCase()}`;
      const { world, pgid: daemonShellPgid } = await setupRoleBackgroundShell(requirement, {
        command: `: HOSTEXITTEST_DAEMON_${randomUUID()}; sleep 60 & sleep 60 & wait`,
        background: true,
      });

      const window = await spawnWindowHost(world);
      const ready = await waitForWindowState(window.stateFile, (s) => s.phase === "ready" || s.phase === "failed", 15_000);
      expect(ready.phase).toBe("ready");
      if (ready.phase !== "ready" || ready.pgid === undefined) return;
      trackedPgids.push(ready.pgid);

      window.proc.kill(signal);
      await waitChildExit(window.proc, 10_000);

      expect(groupAlive(ready.pgid)).toBe(false);
      expect(groupAlive(daemonShellPgid)).toBe(true);
    },
    LONG_TIMEOUT,
  );
});

describe("真实关闭终端窗口", () => {
  test(
    "关闭真实 PTY 主端触发内核挂断，窗口 Shell 及后代停止，守护进程角色 Shell 不受影响",
    async () => {
      const requirement = "2026-09-10.host-exit-real-close";
      const { world, pgid: daemonShellPgid } = await setupRoleBackgroundShell(requirement, {
        command: `: HOSTEXITTEST_DAEMON_${randomUUID()}; sleep 60 & sleep 60 & wait`,
        background: true,
      });

      const window = await spawnWindowHost(world, { viaPty: true });
      const ready = await waitForWindowState(window.stateFile, (s) => s.phase === "ready" || s.phase === "failed", 15_000);
      expect(ready.phase).toBe("ready");
      if (ready.phase !== "ready" || ready.pgid === undefined) return;
      trackedPgids.push(ready.pgid);

      window.proc.kill("SIGKILL");

      await waitFor(() => !groupAlive(ready.pgid as number), 10_000);
      expect(groupAlive(daemonShellPgid)).toBe(true);
    },
    LONG_TIMEOUT,
  );
});

describe("守护进程正常退出", () => {
  test(
    "角色后台 Shell 仍在运行时 SIGTERM 守护进程：内部 Shell 全部停止后进程才退出",
    async () => {
      const requirement = "2026-09-10.host-exit-daemon-shutdown";
      const { world, pgid: daemonShellPgid, descendants } = await setupRoleBackgroundShell(requirement, {
        command: `: HOSTEXITTEST_DAEMON_${randomUUID()}; sleep 60 & sleep 60 & wait`,
        background: true,
      });
      expect(groupAlive(daemonShellPgid)).toBe(true);
      for (const pid of descendants) expect(pidAlive(pid)).toBe(true);

      world.client.close();
      world.handle.proc.kill("SIGTERM");
      const exit = await world.handle.exited;

      expect(exit.code).toBe(0);
      // 到这里守护进程进程本体已经退出；生产 shutdown() 先 await runManager.close()
      // 停完全部 Shell 再调用 process.exit，若顺序有误 pgid 在此处应仍存活
      expect(groupAlive(daemonShellPgid)).toBe(false);
      for (const pid of descendants) expect(pidAlive(pid)).toBe(false);
    },
    LONG_TIMEOUT,
  );
});

describe("后台超时", () => {
  test(
    "background:true, timeout:1 产生后代：满 1 秒才开始停止流程，报告的超时结果已确认后代清理完成",
    async () => {
      const requirement = "2026-09-10.host-exit-background-timeout";
      const { world, pgid, descendants } = await setupRoleBackgroundShell(requirement, {
        command: `: HOSTEXITTEST_TIMEOUT_${randomUUID()}; sleep 30 & sleep 30 & wait`,
        background: true,
        timeout: 1,
      });
      for (const pid of descendants) expect(pidAlive(pid)).toBe(true);

      await delay(400);
      const early = (await listShells(world.client)).find((t) => t.pgid === pgid);
      expect(early?.status).not.toBe("timed_out");
      expect(groupAlive(pgid)).toBe(true);

      const start = Date.now();
      const timedOut = await waitForShell(world.client, (t) => t.pgid === pgid && t.status === "timed_out", 8_000);
      const elapsedMs = Date.now() - start;

      // 已过 400ms 观察窗口，这里只需确认收敛没有早于 1 秒预算触发
      expect(elapsedMs).toBeGreaterThan(300);
      // shells.list 只有在停止确认（含后代扫描）完成后才会把状态置为 timed_out，
      // 观察到该状态即意味着后代已清理完成，不是"先报告后清理"
      expect(groupAlive(pgid)).toBe(false);
      for (const pid of timedOut.descendants) expect(pidAlive(pid)).toBe(false);
    },
    LONG_TIMEOUT,
  );
});
