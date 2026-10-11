import { afterEach, describe, expect, test } from "vitest";
import { spawn as spawnChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClock } from "../runtime/clock.ts";
import { ShellRegistry, probeProcessGroup } from "../runtime/shell-registry.ts";
import * as ShellRegistryModule from "../runtime/shell-registry.ts";
import type { Clock, TimeSource } from "../runtime/clock.ts";
import { createRecord, readRecord, putRecord } from "../runtime/database.ts";

interface Host {
  kind: "main" | "role";
  id: string;
  role?: string;
  runId?: string;
}

interface PsEntry {
  pid: number;
  pgid: number;
  ppid: number;
  startedAt: number;
  command: string;
  token: string | null;
}

const LONG_TIMEOUT = 15_000;

const spawnedPgids: number[] = [];
const rawPids: number[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  for (const pgid of spawnedPgids.splice(0)) {
    try {
      process.kill(-pgid, "SIGKILL");
    } catch {
      // 组已消失，无需处理
    }
  }
  for (const pid of rawPids.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // 进程已消失，无需处理
    }
  }
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "shell-registry-test-"));
  tempDirs.push(dir);
  return dir;
}

// macOS 的 ps 只对非系统二进制显示环境变量，且没有 setsid；用当前 Node 充当持续进程与脱离进程组的后代
const IDLE_SCRIPT = "setTimeout(() => {}, 30000)";
const ESCAPING_CHILD_SCRIPT = [
  "const { spawn } = require('node:child_process');",
  `spawn(process.execPath, ['-e', ${JSON.stringify("setTimeout(() => {}, 30000)")}], { detached: true, stdio: 'ignore' }).unref();`,
  "setTimeout(() => {}, 30000);",
].join(" ");

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, timeoutMs: number, intervalMs = 40): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleepMs(intervalMs);
  }
  if (!predicate()) throw new Error(`waitFor 超时（${timeoutMs}ms）`);
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

const HOST_MAIN: Host = { kind: "main", id: "main" };
function roleHost(id: string): Host {
  return { kind: "role", id, role: "impl-engineer", runId: randomUUID() };
}

function makeRegistry(
  overrides: {
    clock?: Clock;
    kill?: (pid: number, signal: NodeJS.Signals | 0) => void;
    ps?: () => Promise<PsEntry[]>;
    pidStartedAt?: (pid: number) => Promise<number | null>;
    database?: string;
  } = {},
) {
  const clock = overrides.clock ?? createClock();
  const probes: { kill?: typeof overrides.kill; ps?: typeof overrides.ps; pidStartedAt?: typeof overrides.pidStartedAt } = {};
  if (overrides.kill) probes.kill = overrides.kill;
  if (overrides.ps) probes.ps = overrides.ps;
  if (overrides.pidStartedAt) probes.pidStartedAt = overrides.pidStartedAt;
  const options: { clock: Clock; probes?: typeof probes; database?: string } = {
    clock,
    probes: Object.keys(probes).length > 0 ? probes : undefined,
  };
  if (overrides.database) options.database = overrides.database;
  return new ShellRegistry(options as ConstructorParameters<typeof ShellRegistry>[0]);
}



function trackPgid(pgid: number | undefined): void {
  if (typeof pgid === "number") spawnedPgids.push(pgid);
}

function createHybridTimeSource(): TimeSource & { jump(ms: number): void } {
  let offsetMs = 0;
  return {
    now: () => Date.now() + offsetMs,
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    unref: (handle) => (handle as ReturnType<typeof setTimeout>).unref?.(),
    jump(ms: number) {
      offsetMs += ms;
    },
  };
}

describe("命令登记", () => {
  test("正常启动登记任务并记录宿主与命令信息", async () => {
    const registry = makeRegistry();
    const taskId = randomUUID();
    const runToken = randomUUID();
    const result = await registry.spawn({
      taskId,
      host: HOST_MAIN,
      command: "sh",
      args: ["-c", "sleep 5"],
      mode: "background",
      runToken,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    trackPgid(result.task.pgid);
    expect(result.task.taskId).toBe(taskId);
    expect(result.task.host).toEqual(HOST_MAIN);
    expect(typeof result.task.pid).toBe("number");
    expect(typeof result.task.pgid).toBe("number");
    expect(["starting", "running"]).toContain(result.task.status);

    const stopped = await registry.stop(taskId);
    expect(stopped.ok).toBe(true);
  }, LONG_TIMEOUT);

  test("重复登记同一 taskId 返回具体失败且不改动原有记录", async () => {
    const registry = makeRegistry();
    const taskId = randomUUID();
    const runToken = randomUUID();
    const first = await registry.spawn({
      taskId,
      host: HOST_MAIN,
      command: "sh",
      args: ["-c", "sleep 5"],
      mode: "background",
      runToken,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    trackPgid(first.task.pgid);

    const second = await registry.spawn({
      taskId,
      host: roleHost("req-x"),
      command: "sh",
      args: ["-c", "sleep 5"],
      mode: "background",
      runToken,
    });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.reason.length).toBeGreaterThan(0);

    const stillFirst = registry.get(taskId);
    expect(stillFirst?.host).toEqual(HOST_MAIN);

    await registry.stop(taskId);
  }, LONG_TIMEOUT);

  test("不可执行命令启动失败：无记录且带具体原因", async () => {
    const registry = makeRegistry();
    const taskId = randomUUID();
    const result = await registry.spawn({
      taskId,
      host: HOST_MAIN,
      command: join(tmpdir(), `shell-registry-nonexistent-${randomUUID()}`),
      args: [],
      mode: "background",
      runToken: randomUUID(),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason.length).toBeGreaterThan(0);
    expect(registry.get(taskId)).toBeUndefined();
    expect(registry.list().find((task) => task.taskId === taskId)).toBeUndefined();
  }, LONG_TIMEOUT);
});

describe("按宿主过滤任务列表", () => {
  test("list(owner) 只返回该宿主的任务", async () => {
    const registry = makeRegistry();
    const hostA = roleHost("req-list-a");
    const hostB = roleHost("req-list-b");
    const taskIdA = randomUUID();
    const taskIdB = randomUUID();
    const a = await registry.spawn({ taskId: taskIdA, host: hostA, command: "sh", args: ["-c", "sleep 5"], mode: "background", runToken: randomUUID() });
    const b = await registry.spawn({ taskId: taskIdB, host: hostB, command: "sh", args: ["-c", "sleep 5"], mode: "background", runToken: randomUUID() });
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    trackPgid(a.task.pgid);
    trackPgid(b.task.pgid);

    const onlyA = registry.list(hostA);
    expect(onlyA.map((task) => task.taskId)).toEqual([taskIdA]);

    await registry.stop(taskIdA);
    await registry.stop(taskIdB);
  }, LONG_TIMEOUT);
});

describe("detached 启动与 token 注入", () => {
  test("子进程环境含 ONE_COMPANY_SHELL_TOKEN=<runToken>:<taskId>", async () => {
    const registry = makeRegistry();
    const taskId = randomUUID();
    const runToken = randomUUID();
    const dir = await makeTempDir();
    const outFile = join(dir, "token.txt");
    const result = await registry.spawn({
      taskId,
      host: HOST_MAIN,
      command: "sh",
      args: ["-c", `printenv ONE_COMPANY_SHELL_TOKEN > "${outFile}"`],
      mode: "background",
      runToken,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    trackPgid(result.task.pgid);

    await waitFor(() => registry.get(taskId)?.status !== "running" && registry.get(taskId)?.status !== "starting", 5_000);
    const content = (await readFile(outFile, "utf8")).trim();
    expect(content).toBe(`${runToken}:${taskId}`);
  }, LONG_TIMEOUT);
});

describe("存活探测", () => {
  test("父进程先退出后任务仍 active，直到后代退出后才变为已结束", async () => {
    const registry = makeRegistry();
    const taskId = randomUUID();
    const result = await registry.spawn({
      taskId,
      host: HOST_MAIN,
      command: "sh",
      args: ["-c", "sleep 1 &"],
      mode: "background",
      runToken: randomUUID(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    trackPgid(result.task.pgid);

    await sleepMs(200);
    expect(registry.get(taskId)?.activity).toBe("active");

    await waitFor(() => registry.get(taskId)?.activity === "ended", 3_000);
    expect(registry.get(taskId)?.status).toBe("exited");
  }, LONG_TIMEOUT);

  test("短命命令正常退出：exitCode 为 0 且 status 为 exited", async () => {
    const registry = makeRegistry();
    const taskId = randomUUID();
    const result = await registry.spawn({
      taskId,
      host: HOST_MAIN,
      command: "sh",
      args: ["-c", "true"],
      mode: "background",
      runToken: randomUUID(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    trackPgid(result.task.pgid);

    await waitFor(() => registry.get(taskId)?.status === "exited", 3_000);
    expect(registry.get(taskId)?.exitCode).toBe(0);
  }, LONG_TIMEOUT);

  test("被动巡检发现根进程启动时刻不一致（pgid 被复用）时任务变为 uncertain", async () => {
    let baselineTaken = false;
    const registry = makeRegistry({
      pidStartedAt: async () => {
        if (!baselineTaken) {
          baselineTaken = true;
          return 1_000_000;
        }
        return 1_000_000 + 999_999;
      },
    });
    const taskId = randomUUID();
    const started = await registry.spawn({
      taskId,
      host: HOST_MAIN,
      command: "sh",
      args: ["-c", "sleep 30"],
      mode: "background",
      runToken: randomUUID(),
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    trackPgid(started.task.pgid);
    expect(started.task.identityVerified).toBe(true);

    await waitFor(() => registry.get(taskId)?.status === "uncertain", 5_000);
    expect(registry.get(taskId)?.reason?.length ?? 0).toBeGreaterThan(0);
  }, LONG_TIMEOUT);

  test("启动时刻探针抛错时任务照常登记且 identityVerified 为 false，不漏管进程", async () => {
    const registry = makeRegistry({
      pidStartedAt: async () => {
        throw new Error("探针故障");
      },
    });
    const taskId = randomUUID();
    const started = await registry.spawn({
      taskId,
      host: HOST_MAIN,
      command: "sh",
      args: ["-c", "sleep 30"],
      mode: "background",
      runToken: randomUUID(),
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    trackPgid(started.task.pgid);
    expect(started.task.startedAt).toBeNull();
    expect(started.task.identityVerified).toBe(false);
    expect(registry.get(taskId)?.pid).toBe(started.task.pid);

    const stopped = await registry.stop(taskId);
    expect(stopped.ok).toBe(true);
    if (stopped.ok) expect(stopped.task.status).toBe("stopped");
  }, LONG_TIMEOUT);

  test("启动时刻基线取不到时 identityVerified 为 false，停止仍以信号探测为准并确认 stopped", async () => {
    const registry = makeRegistry({ pidStartedAt: async () => null });
    const taskId = randomUUID();
    const started = await registry.spawn({
      taskId,
      host: HOST_MAIN,
      command: "sh",
      args: ["-c", "sleep 30"],
      mode: "background",
      runToken: randomUUID(),
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    trackPgid(started.task.pgid);
    expect(started.task.startedAt).toBeNull();
    expect(started.task.identityVerified).toBe(false);

    const stopped = await registry.stop(taskId);
    expect(stopped.ok).toBe(true);
    if (!stopped.ok) return;
    expect(stopped.task.status).toBe("stopped");
    expect(stopped.task.identityVerified).toBe(false);
  }, LONG_TIMEOUT);

  test("有基线但停止时启动时刻查询失败：identityVerified 回写 false，仍发信号并确认 stopped", async () => {
    let calls = 0;
    const registry = makeRegistry({
      pidStartedAt: async () => {
        calls++;
        if (calls === 1) return 1_000_000;
        throw new Error("ps 暂不可用");
      },
    });
    const taskId = randomUUID();
    const started = await registry.spawn({
      taskId,
      host: HOST_MAIN,
      command: "sh",
      args: ["-c", "sleep 30"],
      mode: "background",
      runToken: randomUUID(),
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    trackPgid(started.task.pgid);
    expect(started.task.identityVerified).toBe(true);

    const stopped = await registry.stop(taskId);
    expect(stopped.ok).toBe(true);
    if (!stopped.ok) return;
    expect(stopped.task.status).toBe("stopped");
    expect(stopped.task.identityVerified).toBe(false);
  }, LONG_TIMEOUT);

  test("存活探测中 kill 桩抛错（非 ESRCH/EPERM 的普通异常）时任务变为 uncertain 并带原因", async () => {
    let throwOnProbe = false;
    const registry = makeRegistry({
      kill: (pid, signal) => {
        if (throwOnProbe) throw new Error("探测失败");
        process.kill(pid, signal);
      },
    });
    const taskId = randomUUID();
    const result = await registry.spawn({
      taskId,
      host: HOST_MAIN,
      command: "sh",
      args: ["-c", "sleep 30"],
      mode: "background",
      runToken: randomUUID(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    trackPgid(result.task.pgid);

    throwOnProbe = true;
    await waitFor(() => registry.get(taskId)?.status === "uncertain", 5_000);
    const task = registry.get(taskId);
    expect(task?.reason?.length ?? 0).toBeGreaterThan(0);

    throwOnProbe = false;
    await registry.stop(taskId);
  }, LONG_TIMEOUT);
});

describe("巡检并发控制", () => {
  test("同一时刻最多一次 ps 巡检在飞", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    let callCount = 0;
    const registry = makeRegistry({
      ps: async (): Promise<PsEntry[]> => {
        callCount++;
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await sleepMs(400);
        inFlight--;
        return [];
      },
    });
    const taskId = randomUUID();
    const started = await registry.spawn({
      taskId,
      host: HOST_MAIN,
      command: "sh",
      args: ["-c", "sleep 30"],
      mode: "background",
      runToken: randomUUID(),
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    trackPgid(started.task.pgid);

    for (let i = 0; i < 8; i++) {
      registry.get(taskId);
      await sleepMs(300);
    }
    await registry.stop(taskId);

    expect(maxInFlight).toBeLessThanOrEqual(1);
    expect(callCount).toBeGreaterThanOrEqual(2);
  }, LONG_TIMEOUT);
});

describe("ps 巡检超时降级", () => {
  test("ps 桩挂起不结算：stop 在 6 秒内以 stopped 或 uncertain 收敛且 descendantsScanned=false，随后其他任务的 stop 不被阻塞（2 秒内返回）", async () => {
    const registry = makeRegistry({
      ps: () => new Promise<PsEntry[]>(() => {}),
    });
    const taskId = randomUUID();
    const started = await registry.spawn({
      taskId,
      host: HOST_MAIN,
      command: "sh",
      args: ["-c", "sleep 30"],
      mode: "background",
      runToken: randomUUID(),
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    trackPgid(started.task.pgid);

    const startedAt = Date.now();
    const stopped = await registry.stop(taskId);
    const elapsed = Date.now() - startedAt;
    expect(elapsed).toBeLessThan(6_000);
    expect(stopped.ok).toBe(true);
    if (!stopped.ok) return;
    expect(["stopped", "uncertain"]).toContain(stopped.task.status);
    expect(stopped.task.descendantsScanned).toBe(false);

    const taskId2 = randomUUID();
    const started2 = await registry.spawn({
      taskId: taskId2,
      host: HOST_MAIN,
      command: "sh",
      args: ["-c", "sleep 30"],
      mode: "background",
      runToken: randomUUID(),
    });
    expect(started2.ok).toBe(true);
    if (!started2.ok) return;
    trackPgid(started2.task.pgid);

    const startedAt2 = Date.now();
    const stopped2 = await registry.stop(taskId2);
    const elapsed2 = Date.now() - startedAt2;
    expect(elapsed2).toBeLessThan(2_000);
    expect(stopped2.ok).toBe(true);
  }, LONG_TIMEOUT);
});

describe("停止流程", () => {
  test("停止含两代后代的命令：进程组内后代经信号探测确认消失后才报 stopped", async () => {
    const registry = makeRegistry();
    const taskId = randomUUID();
    const result = await registry.spawn({
      taskId,
      host: HOST_MAIN,
      command: "sh",
      args: ["-c", "sleep 30 & sleep 30 & wait"],
      mode: "background",
      runToken: randomUUID(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const pgid = result.task.pgid;
    trackPgid(pgid);
    await sleepMs(200);

    const stopped = await registry.stop(taskId);
    expect(stopped.ok).toBe(true);
    if (!stopped.ok) return;
    expect(stopped.task.status).toBe("stopped");
    expect(groupAlive(pgid)).toBe(false);
  }, LONG_TIMEOUT);

  test("脱离进程组的逃逸后代被 ps 发现并随停止一起消失", async () => {
    const registry = makeRegistry();
    const taskId = randomUUID();
    const result = await registry.spawn({
      taskId,
      host: HOST_MAIN,
      command: process.execPath,
      args: ["-e", ESCAPING_CHILD_SCRIPT],
      mode: "background",
      runToken: randomUUID(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    trackPgid(result.task.pgid);
    await sleepMs(300);

    const stopped = await registry.stop(taskId);
    expect(stopped.ok).toBe(true);
    if (!stopped.ok) return;
    expect(stopped.task.status).toBe("stopped");
    expect(stopped.task.descendants.length).toBeGreaterThan(0);
    for (const pid of stopped.task.descendants) {
      expect(pidAlive(pid)).toBe(false);
    }
  }, LONG_TIMEOUT);

  test("ps 桩 token=null 但 command 含令牌串的进程不得被并入 descendants（令牌必须来自环境段）", async () => {
    let rows: PsEntry[] = [];
    const registry = makeRegistry({ ps: async (): Promise<PsEntry[]> => rows });
    const taskId = randomUUID();
    const runToken = randomUUID();
    const started = await registry.spawn({
      taskId,
      host: HOST_MAIN,
      command: "sh",
      args: ["-c", "sleep 30"],
      mode: "background",
      runToken,
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    trackPgid(started.task.pgid);
    const fakePid = 999_999;
    rows = [
      {
        pid: fakePid,
        pgid: fakePid,
        ppid: started.task.pid,
        startedAt: Date.now(),
        command: `sh -c echo ONE_COMPANY_SHELL_TOKEN=${runToken}:${taskId}`,
        token: null,
      },
    ];

    const stopped = await registry.stop(taskId);
    expect(stopped.ok).toBe(true);
    if (!stopped.ok) return;
    expect(stopped.task.descendants).not.toContain(fakePid);
  }, LONG_TIMEOUT);

  test("ps 行有效性：pid/pgid ≤ 1 的行被丢弃，kill 桩不会收到 -1/0/1", async () => {
    const seenKillArgs: number[] = [];
    let rows: PsEntry[] = [];
    const registry = makeRegistry({
      kill: (pid, signal) => {
        seenKillArgs.push(pid);
        process.kill(pid, signal);
      },
      ps: async (): Promise<PsEntry[]> => rows,
    });
    const taskId = randomUUID();
    const runToken = randomUUID();
    const started = await registry.spawn({
      taskId,
      host: HOST_MAIN,
      command: "sh",
      args: ["-c", "sleep 30"],
      mode: "background",
      runToken,
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    trackPgid(started.task.pgid);
    rows = [{ pid: 1, pgid: 1, ppid: 0, startedAt: Date.now(), command: "launchd", token: `${runToken}:${taskId}` }];

    const stopped = await registry.stop(taskId);
    expect(stopped.ok).toBe(true);
    if (!stopped.ok) return;
    expect(stopped.task.descendants).not.toContain(1);
    expect(seenKillArgs).not.toContain(-1);
    expect(seenKillArgs).not.toContain(0);
    expect(seenKillArgs).not.toContain(1);
  }, LONG_TIMEOUT);

  test("ps 不可用时主进程组可结束，但后代未核对保持 uncertain", async () => {
    const registry = makeRegistry({
      ps: async () => {
        throw new Error("ps 不可用");
      },
    });
    const taskId = randomUUID();
    const result = await registry.spawn({
      taskId,
      host: HOST_MAIN,
      command: "sh",
      args: ["-c", "sleep 30"],
      mode: "background",
      runToken: randomUUID(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    trackPgid(result.task.pgid);

    const stopped = await registry.stop(taskId);
    expect(stopped.ok).toBe(true);
    if (!stopped.ok) return;
    expect(stopped.task.status).toBe("uncertain");
    expect(stopped.task.activity).toBe("uncertain");
    expect(stopped.task.descendantsScanned).toBe(false);
    expect(stopped.task.reason).toContain("后代扫描未完成");
    expect(probeProcessGroup(stopped.task.pgid)).toEqual({ ok: true, state: "gone" });
  }, LONG_TIMEOUT);

  test("启动时刻及ps查询失败时不伪造基线或停止确认", async () => {
    let psCallCount = 0;
    const registry = makeRegistry({
      pidStartedAt: async () => null,
      ps: async (): Promise<PsEntry[]> => {
        psCallCount++;
        throw new Error("ps 暂不可用");
      },
    });
    const taskId = randomUUID();
    const result = await registry.spawn({
      taskId,
      host: HOST_MAIN,
      command: "sh",
      args: ["-c", "sleep 30"],
      mode: "background",
      runToken: randomUUID(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    trackPgid(result.task.pgid);

    const stopped = await registry.stop(taskId);
    expect(stopped.ok).toBe(true);
    if (!stopped.ok) return;
    expect(stopped.task.status).toBe("uncertain");
    expect(stopped.task.identityVerified).toBe(false);
    expect(stopped.task.startedAt).toBeNull();
    expect(stopped.task.reason).toContain("后代扫描未完成");
    expect(probeProcessGroup(stopped.task.pgid)).toEqual({ ok: true, state: "gone" });
    expect(psCallCount).toBeGreaterThan(0);
  }, LONG_TIMEOUT);

  test("已结束任务再次停止重新探测且不重复发送终止信号", async () => {
    let killCalls = 0;
    const registry = makeRegistry({
      kill: (pid, signal) => {
        if (signal !== 0) killCalls++;
        process.kill(pid, signal);
      },
    });
    const taskId = randomUUID();
    const result = await registry.spawn({
      taskId,
      host: HOST_MAIN,
      command: "sh",
      args: ["-c", "true"],
      mode: "background",
      runToken: randomUUID(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    trackPgid(result.task.pgid);

    await waitFor(() => registry.get(taskId)?.status === "exited", 3_000);

    const callsBefore = killCalls;
    const stopped = await registry.stop(taskId);
    expect(stopped.ok).toBe(true);
    if (!stopped.ok) return;
    expect(stopped.task.status).toBe("exited");
    expect(killCalls).toBe(callsBefore);
  }, LONG_TIMEOUT);

  test("身份变化（伪造 startedAt 不一致）时停止返回 uncertain 且不发送信号", async () => {
    let killCalls = 0;
    let baselineTaken = false;
    const registry = makeRegistry({
      kill: () => {
        killCalls++;
      },
      pidStartedAt: async () => {
        if (!baselineTaken) {
          baselineTaken = true;
          return 1_000_000;
        }
        return 1_000_000 + 999_999;
      },
    });
    const taskId = randomUUID();
    const started = await registry.spawn({
      taskId,
      host: HOST_MAIN,
      command: "sh",
      args: ["-c", "sleep 30"],
      mode: "background",
      runToken: randomUUID(),
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    trackPgid(started.task.pgid);

    const stopped = await registry.stop(taskId);
    expect(stopped.ok).toBe(true);
    if (!stopped.ok) return;
    expect(stopped.task.status).toBe("uncertain");
    expect(stopped.task.identityVerified).toBe(true);
    expect(killCalls).toBe(0);
    expect(stopped.task.reason?.length ?? 0).toBeGreaterThan(0);
  }, LONG_TIMEOUT);

  test("停止只作用于该任务及其后代，不影响宿主或其他任务", async () => {
    const registry = makeRegistry();
    const taskIdA = randomUUID();
    const taskIdB = randomUUID();
    const resultA = await registry.spawn({
      taskId: taskIdA,
      host: HOST_MAIN,
      command: "sh",
      args: ["-c", "sleep 30"],
      mode: "background",
      runToken: randomUUID(),
    });
    const resultB = await registry.spawn({
      taskId: taskIdB,
      host: HOST_MAIN,
      command: "sh",
      args: ["-c", "sleep 30"],
      mode: "background",
      runToken: randomUUID(),
    });
    expect(resultA.ok).toBe(true);
    expect(resultB.ok).toBe(true);
    if (!resultA.ok || !resultB.ok) return;
    trackPgid(resultA.task.pgid);
    trackPgid(resultB.task.pgid);
    await sleepMs(200);

    const stopped = await registry.stop(taskIdA);
    expect(stopped.ok).toBe(true);
    expect(groupAlive(resultA.task.pgid)).toBe(false);
    expect(groupAlive(resultB.task.pgid)).toBe(true);

    await registry.stop(taskIdB);
  }, LONG_TIMEOUT);

  test("停止过程中注入 30 秒时钟跳变不导致 uncertain（停止上限计时扣除睡眠）", async () => {
    const jumpableTimeSource = createHybridTimeSource();
    const clock = createClock({ timeSource: jumpableTimeSource });
    const registry = makeRegistry({ clock });
    const taskId = randomUUID();
    const started = await registry.spawn({
      taskId,
      host: HOST_MAIN,
      command: "sh",
      args: ["-c", "sleep 30"],
      mode: "background",
      runToken: randomUUID(),
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const pgid = started.task.pgid;
    trackPgid(pgid);

    const stopPromise = registry.stop(taskId);
    await sleepMs(100);
    jumpableTimeSource.jump(30_000);
    const stopped = await stopPromise;
    expect(stopped.ok).toBe(true);
    if (!stopped.ok) return;
    expect(stopped.task.status).toBe("stopped");
    expect(groupAlive(pgid)).toBe(false);
  }, LONG_TIMEOUT);
});

describe("停止上限未确认", () => {
  test("信号发出但探测持续未确认，约 5 秒后判定为 uncertain（status 与 activity 均为）", async () => {
    const registry = makeRegistry({
      kill: () => {},
    });
    const taskId = randomUUID();
    const started = await registry.spawn({
      taskId,
      host: HOST_MAIN,
      command: "sh",
      args: ["-c", "sleep 30"],
      mode: "background",
      runToken: randomUUID(),
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    trackPgid(started.task.pgid);

    const stopped = await registry.stop(taskId);
    expect(stopped.ok).toBe(true);
    if (!stopped.ok) return;
    expect(stopped.task.status).toBe("uncertain");
    expect(stopped.task.activity).toBe("uncertain");
  }, LONG_TIMEOUT);
});

describe("EPERM 探测结果", () => {
  test("kill 桩抛 EPERM 时停止判定为 uncertain 而非 stopped", async () => {
    const registry = makeRegistry({
      kill: (pid, signal) => {
        if (signal === 0) {
          const err = new Error("没有权限") as NodeJS.ErrnoException;
          err.code = "EPERM";
          throw err;
        }
        process.kill(pid, signal);
      },
    });
    const taskId = randomUUID();
    const started = await registry.spawn({
      taskId,
      host: HOST_MAIN,
      command: "sh",
      args: ["-c", "sleep 30"],
      mode: "background",
      runToken: randomUUID(),
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    trackPgid(started.task.pgid);

    const stopped = await registry.stop(taskId);
    expect(stopped.ok).toBe(true);
    if (!stopped.ok) return;
    expect(stopped.task.status).toBe("uncertain");
    expect(stopped.task.activity).toBe("uncertain");
  }, LONG_TIMEOUT);
});

describe("逃逸后代探测 EPERM", () => {
  test("逃逸后代 pid 的 0 号信号探测抛 EPERM 时，任务判定为 uncertain 而非 stopped", async () => {
    const escapee = spawnChildProcess(process.execPath, ["-e", IDLE_SCRIPT], { stdio: "ignore" });
    const escapeePid = escapee.pid;
    expect(typeof escapeePid).toBe("number");
    if (typeof escapeePid !== "number") return;
    rawPids.push(escapeePid);

    const taskId = randomUUID();
    const runToken = randomUUID();
    const registry = makeRegistry({
      kill: (pid, signal) => {
        if (pid === escapeePid && signal === 0) {
          const err = new Error("没有权限") as NodeJS.ErrnoException;
          err.code = "EPERM";
          throw err;
        }
        process.kill(pid, signal);
      },
      ps: async (): Promise<PsEntry[]> => [
        {
          pid: escapeePid,
          pgid: escapeePid,
          ppid: process.pid,
          startedAt: Date.now(),
          command: `${process.execPath} -e ...`,
          token: `${runToken}:${taskId}`,
        },
      ],
    });
    const started = await registry.spawn({
      taskId,
      host: HOST_MAIN,
      command: "sh",
      args: ["-c", "sleep 30"],
      mode: "background",
      runToken,
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    trackPgid(started.task.pgid);

    const stopped = await registry.stop(taskId);
    expect(stopped.ok).toBe(true);
    if (!stopped.ok) return;
    expect(stopped.task.status).toBe("uncertain");
    expect(stopped.task.reason?.length ?? 0).toBeGreaterThan(0);
  }, LONG_TIMEOUT);
});

describe("按宿主批量停止", () => {
  test("stopHost 只停止该宿主任务，未确认的标 uncertain，其他宿主任务不受影响", async () => {
    const hostA = roleHost("req-stophost-a");
    const hostB = roleHost("req-stophost-b");
    let epermTargetPid = -1;
    const registry = makeRegistry({
      kill: (pid, signal) => {
        if (signal === 0 && pid === epermTargetPid) {
          const err = new Error("没有权限") as NodeJS.ErrnoException;
          err.code = "EPERM";
          throw err;
        }
        process.kill(pid, signal);
      },
    });
    const taskIdA1 = randomUUID();
    const taskIdA2 = randomUUID();
    const taskIdB = randomUUID();
    const a1 = await registry.spawn({ taskId: taskIdA1, host: hostA, command: "sh", args: ["-c", "sleep 30"], mode: "background", runToken: randomUUID() });
    const a2 = await registry.spawn({ taskId: taskIdA2, host: hostA, command: "sh", args: ["-c", "sleep 30"], mode: "background", runToken: randomUUID() });
    const b1 = await registry.spawn({ taskId: taskIdB, host: hostB, command: "sh", args: ["-c", "sleep 30"], mode: "background", runToken: randomUUID() });
    expect(a1.ok).toBe(true);
    expect(a2.ok).toBe(true);
    expect(b1.ok).toBe(true);
    if (!a1.ok || !a2.ok || !b1.ok) return;
    trackPgid(a1.task.pgid);
    trackPgid(a2.task.pgid);
    trackPgid(b1.task.pgid);
    epermTargetPid = a1.task.pid;

    await registry.stopHost(hostA);

    expect(registry.get(taskIdA1)?.status).toBe("uncertain");
    expect(registry.get(taskIdA2)?.status).toBe("stopped");
    expect(registry.get(taskIdB)?.status).not.toBe("stopped");
    expect(groupAlive(b1.task.pgid)).toBe(true);

    await registry.stop(taskIdB);
  }, LONG_TIMEOUT);
});

describe("状态订阅", () => {
  test("subscribe 推送顺序：停止过程中先出现 stopping 再出现 stopped", async () => {
    const registry = makeRegistry();
    const taskId = randomUUID();
    const started = await registry.spawn({
      taskId,
      host: HOST_MAIN,
      command: "sh",
      args: ["-c", "sleep 30"],
      mode: "background",
      runToken: randomUUID(),
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    trackPgid(started.task.pgid);

    const seen: string[] = [];
    const unsubscribe = registry.subscribe(taskId, (task) => {
      seen.push(task.status);
    });

    await registry.stop(taskId);
    unsubscribe();

    const stoppingIndex = seen.indexOf("stopping");
    const stoppedIndex = seen.lastIndexOf("stopped");
    expect(stoppingIndex).toBeGreaterThanOrEqual(0);
    expect(stoppedIndex).toBeGreaterThan(stoppingIndex);
  }, LONG_TIMEOUT);
});

describe("订阅方异常隔离", () => {
  test("subscribe 的监听器抛错不影响 stop 正常收敛为 stopped，kill 桩仍收到过 SIGTERM", async () => {
    let sawSigterm = false;
    const registry = makeRegistry({
      kill: (pid, signal) => {
        if (signal === "SIGTERM") sawSigterm = true;
        process.kill(pid, signal);
      },
    });
    const taskId = randomUUID();
    const started = await registry.spawn({
      taskId,
      host: HOST_MAIN,
      command: "sh",
      args: ["-c", "sleep 30"],
      mode: "background",
      runToken: randomUUID(),
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    trackPgid(started.task.pgid);

    registry.subscribe(taskId, () => {
      throw new Error("订阅方故障");
    });

    const stopped = await registry.stop(taskId);
    expect(stopped.ok).toBe(true);
    if (!stopped.ok) return;
    expect(stopped.task.status).toBe("stopped");
    expect(sawSigterm).toBe(true);
  }, LONG_TIMEOUT);

  test("stopHost 下某任务的订阅方抛错不中断同宿主其他任务的停止", async () => {
    const registry = makeRegistry();
    const host = roleHost("req-subscriber-fault");
    const taskIdA = randomUUID();
    const taskIdB = randomUUID();
    const a = await registry.spawn({ taskId: taskIdA, host, command: "sh", args: ["-c", "sleep 30"], mode: "background", runToken: randomUUID() });
    const b = await registry.spawn({ taskId: taskIdB, host, command: "sh", args: ["-c", "sleep 30"], mode: "background", runToken: randomUUID() });
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    trackPgid(a.task.pgid);
    trackPgid(b.task.pgid);

    registry.subscribe(taskIdA, () => {
      throw new Error("订阅方故障");
    });

    await registry.stopHost(host);

    expect(registry.get(taskIdA)?.status).toBe("stopped");
    expect(registry.get(taskIdB)?.status).toBe("stopped");
  }, LONG_TIMEOUT);
});

describe("超时", () => {
  test("timeoutSeconds=1 时注入 30 秒时钟跳变不提前触发，真实约 1 秒后触发并确认清理为 timed_out", async () => {
    const jumpableTimeSource = createHybridTimeSource();
    const clock = createClock({ timeSource: jumpableTimeSource });
    const registry = makeRegistry({ clock });
    const taskId = randomUUID();
    const result = await registry.spawn({
      taskId,
      host: HOST_MAIN,
      command: "sh",
      args: ["-c", "sleep 30"],
      mode: "background",
      timeoutSeconds: 1,
      runToken: randomUUID(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const pgid = result.task.pgid;
    trackPgid(pgid);

    await sleepMs(200);
    jumpableTimeSource.jump(30_000);
    await sleepMs(300);
    expect(registry.get(taskId)?.status).not.toBe("timed_out");

    await waitFor(() => registry.get(taskId)?.status === "timed_out", 5_000);
    expect(groupAlive(pgid)).toBe(false);
  }, LONG_TIMEOUT);
});

describe("超时定时器清理", () => {
  test("任务进入终态后清除内部超时定时器", async () => {
    let clearCount = 0;
    const timeSource: TimeSource = {
      now: () => Date.now(),
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (handle) => {
        clearCount++;
        clearTimeout(handle as ReturnType<typeof setTimeout>);
      },
      unref: (handle) => (handle as ReturnType<typeof setTimeout>).unref?.(),
    };
    const clock = createClock({ timeSource });
    const registry = makeRegistry({ clock });
    const taskId = randomUUID();
    const started = await registry.spawn({
      taskId,
      host: HOST_MAIN,
      command: "sh",
      args: ["-c", "sleep 30"],
      mode: "background",
      timeoutSeconds: 3_600,
      runToken: randomUUID(),
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    trackPgid(started.task.pgid);

    const before = clearCount;
    const stopped = await registry.stop(taskId);
    expect(stopped.ok).toBe(true);
    expect(clearCount).toBeGreaterThan(before);
  }, LONG_TIMEOUT);

  test("因探测出错进入 uncertain 时同样清除内部超时定时器", async () => {
    let clearCount = 0;
    const timeSource: TimeSource = {
      now: () => Date.now(),
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (handle) => {
        clearCount++;
        clearTimeout(handle as ReturnType<typeof setTimeout>);
      },
      unref: (handle) => (handle as ReturnType<typeof setTimeout>).unref?.(),
    };
    const clock = createClock({ timeSource });
    const registry = makeRegistry({
      clock,
      kill: (pid, signal) => {
        if (signal === 0) throw new Error("探测失败");
        process.kill(pid, signal);
      },
    });
    const taskId = randomUUID();
    const started = await registry.spawn({
      taskId,
      host: HOST_MAIN,
      command: "sh",
      args: ["-c", "sleep 30"],
      mode: "background",
      timeoutSeconds: 3_600,
      runToken: randomUUID(),
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    trackPgid(started.task.pgid);

    const before = clearCount;
    const stopped = await registry.stop(taskId);
    expect(stopped.ok).toBe(true);
    if (!stopped.ok) return;
    expect(stopped.task.status).toBe("uncertain");
    expect(clearCount).toBeGreaterThan(before);
  }, LONG_TIMEOUT);
});

describe("wait 模式", () => {
  test("mode 为 wait 的命令退出后状态为 exited", async () => {
    const registry = makeRegistry();
    const taskId = randomUUID();
    const result = await registry.spawn({
      taskId,
      host: HOST_MAIN,
      command: "sh",
      args: ["-c", "true"],
      mode: "wait",
      runToken: randomUUID(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    trackPgid(result.task.pgid);
    await waitFor(() => registry.get(taskId)?.status === "exited", 5_000);
  }, LONG_TIMEOUT);
});

describe("守护进程重启后接管", () => {
  test("同一 runToken 下两个 taskId 各启动持续进程，新建注册表接管：恰还原两条、宿主为给定 owner、可停止并确认清理", async () => {
    const runToken = randomUUID();
    const taskIdA = randomUUID();
    const taskIdB = randomUUID();
    const registryA = makeRegistry();
    const resultA = await registryA.spawn({
      taskId: taskIdA,
      host: HOST_MAIN,
      command: process.execPath,
      args: ["-e", IDLE_SCRIPT],
      mode: "background",
      runToken,
    });
    const resultB = await registryA.spawn({
      taskId: taskIdB,
      host: HOST_MAIN,
      command: process.execPath,
      args: ["-e", IDLE_SCRIPT],
      mode: "background",
      runToken,
    });
    expect(resultA.ok).toBe(true);
    expect(resultB.ok).toBe(true);
    if (!resultA.ok || !resultB.ok) return;
    trackPgid(resultA.task.pgid);
    trackPgid(resultB.task.pgid);
    await sleepMs(300);

    const owner = roleHost("req-owner");
    const registryB = makeRegistry();
    const adopted = await registryB.adoptOrphans({ runToken, owner });
    expect(adopted.ok).toBe(true);
    if (!adopted.ok) return;
    expect(adopted.tasks.length).toBe(2);
    for (const task of adopted.tasks) {
      expect(task.host).toEqual(owner);
      expect(task.status).toBe("running");
      expect(task.command.length).toBeGreaterThan(0);
    }

    for (const task of adopted.tasks) {
      const stopped = await registryB.stop(task.taskId);
      expect(stopped.ok).toBe(true);
      if (stopped.ok) expect(stopped.task.status).toBe("stopped");
      expect(groupAlive(task.pgid)).toBe(false);
    }
  }, LONG_TIMEOUT);

  test("adoptOrphans 收编前后进程组仍存活，不自动清理", async () => {
    const runToken = randomUUID();
    const taskId = randomUUID();
    const registryA = makeRegistry();
    const started = await registryA.spawn({
      taskId,
      host: HOST_MAIN,
      command: process.execPath,
      args: ["-e", IDLE_SCRIPT],
      mode: "background",
      runToken,
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    trackPgid(started.task.pgid);
    await sleepMs(200);

    const owner = roleHost("req-owner-alive");
    const registryB = makeRegistry();
    const adopted = await registryB.adoptOrphans({ runToken, owner });
    expect(adopted.ok).toBe(true);
    if (!adopted.ok) return;
    expect(adopted.tasks.length).toBe(1);
    expect(groupAlive(started.task.pgid)).toBe(true);

    await registryB.stop(adopted.tasks[0]!.taskId);
  }, LONG_TIMEOUT);

  test("对已退出令牌接管返回空清单", async () => {
    const runToken = randomUUID();
    const registry = makeRegistry();
    const adopted = await registry.adoptOrphans({ runToken, owner: HOST_MAIN });
    expect(adopted.ok).toBe(true);
    if (!adopted.ok) return;
    expect(adopted.tasks).toEqual([]);
  }, LONG_TIMEOUT);

  test("ps 桩抛错时接管返回具体原因而非空清单", async () => {
    const registry = makeRegistry({
      ps: async () => {
        throw new Error("ps 命令不可用");
      },
    });
    const adopted = await registry.adoptOrphans({ runToken: randomUUID(), owner: HOST_MAIN });
    expect(adopted.ok).toBe(false);
    if (adopted.ok) return;
    expect(adopted.reason.length).toBeGreaterThan(0);
  }, LONG_TIMEOUT);

  test("adoptOrphans 丢弃 pid/pgid ≤ 1 的 ps 行", async () => {
    const runToken = randomUUID();
    const taskId = randomUUID();
    const registry = makeRegistry({
      ps: async (): Promise<PsEntry[]> => [
        { pid: 1, pgid: 1, ppid: 0, startedAt: Date.now(), command: "launchd", token: `${runToken}:${taskId}` },
      ],
    });
    const adopted = await registry.adoptOrphans({ runToken, owner: HOST_MAIN });
    expect(adopted.ok).toBe(true);
    if (!adopted.ok) return;
    expect(adopted.tasks).toEqual([]);
  }, LONG_TIMEOUT);

  test("adoptOrphans 不收编 token=null 但 command 含令牌串的进程", async () => {
    const runToken = randomUUID();
    const taskId = randomUUID();
    const registry = makeRegistry({
      ps: async (): Promise<PsEntry[]> => [
        {
          pid: 4_242,
          pgid: 4_242,
          ppid: 1,
          startedAt: Date.now(),
          command: `sh -c echo ONE_COMPANY_SHELL_TOKEN=${runToken}:${taskId}`,
          token: null,
        },
      ],
    });
    const adopted = await registry.adoptOrphans({ runToken, owner: HOST_MAIN });
    expect(adopted.ok).toBe(true);
    if (!adopted.ok) return;
    expect(adopted.tasks).toEqual([]);
  }, LONG_TIMEOUT);
});

describe("持久化任务记录接管（macOS 系统签名二进制场景）", () => {
  test("spawn 后 data.db 里出现该任务的持久记录，终态后记录被删除", async () => {
    const base = await makeTempDir();
    const database = join(base, "data.db");
    const host = roleHost("record-owner");
    const runToken = randomUUID();
    const taskId = randomUUID();
    const registry = makeRegistry({ database });

    const result = await registry.spawn({
      taskId,
      host,
      command: "sh",
      args: ["-c", "true"],
      mode: "wait",
      runToken,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    trackPgid(result.task.pgid);

    const recordPath = { database, namespace: "shells", key: taskId };
    const beforeExit = await readRecord(recordPath);
    expect(beforeExit.exists).toBe(true);
    if (beforeExit.exists) {
      const data = beforeExit.data as Record<string, unknown>;
      expect(data.taskId).toBe(taskId);
      expect(data.pid).toBe(result.task.pid);
      expect(data.pgid).toBe(result.task.pgid);
      expect(typeof data.startedAt).toBe("number");
      expect(typeof data.token).toBe("string");
      expect(data.host).toEqual(host);
      expect(typeof data.command).toBe("string");
    }

    await waitFor(() => registry.get(taskId)?.status === "exited", LONG_TIMEOUT);
    await sleepMs(150);
    const afterExit = await readRecord(recordPath);
    expect(afterExit.exists).toBe(false);
  }, LONG_TIMEOUT);

  test("新建注册表实例凭持久记录接管系统签名二进制启动的任务，即使环境扫描找不到令牌", async () => {
    const base = await makeTempDir();
    const database = join(base, "data.db");
    const owner = roleHost("restart-owner");
    const runToken = randomUUID();
    const taskId = randomUUID();
    const registryA = makeRegistry({ database });

    const started = await registryA.spawn({
      taskId,
      host: owner,
      command: "sh",
      args: ["-c", "sleep 30"],
      mode: "background",
      runToken,
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    trackPgid(started.task.pgid);
    await sleepMs(300);

    const registryB = makeRegistry({ database, ps: async () => [] });
    const adopted = await registryB.adoptOrphans({ runToken, owner });
    expect(adopted.ok).toBe(true);
    if (!adopted.ok) return;
    const task = adopted.tasks.find((entry) => entry.taskId === taskId);
    expect(task).toBeDefined();
    expect(task?.host).toEqual(owner);
    expect(task?.status).toBe("running");
    expect(task?.pid).toBe(started.task.pid);
    expect(task?.startedAt).toBe(started.task.startedAt);

    if (task) {
      const stopped = await registryB.stop(task.taskId);
      expect(stopped.ok).toBe(true);
      if (stopped.ok) expect(stopped.task.status).toBe("stopped");
    }
  }, LONG_TIMEOUT);

  test("持久记录指向的进程已退出时不接管，同一次接管中仍存活的记录正常接管", async () => {
    const base = await makeTempDir();
    const database = join(base, "data.db");
    const host = roleHost("gone-owner");
    const runToken = randomUUID();
    const goneTaskId = randomUUID();
    const aliveTaskId = randomUUID();
    const registryA = makeRegistry({ database });

    const started = await registryA.spawn({
      taskId: aliveTaskId,
      host,
      command: "sh",
      args: ["-c", "sleep 30"],
      mode: "background",
      runToken,
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    trackPgid(started.task.pgid);
    await sleepMs(200);

    await createRecord({ database, namespace: "shells", key: goneTaskId }, {
      taskId: goneTaskId,
      pid: 999_999,
      pgid: 999_999,
      startedAt: Date.now() - 60_000,
      token: `${runToken}:${goneTaskId}`,
      host,
      command: "sh -c sleep 30",
      cwd: process.cwd(),
    });

    const registryB = makeRegistry({ database, ps: async () => [] });
    const adopted = await registryB.adoptOrphans({ runToken, owner: host });
    expect(adopted.ok).toBe(true);
    if (!adopted.ok) return;
    expect(adopted.tasks.some((entry) => entry.taskId === goneTaskId)).toBe(false);
    const aliveAdopted = adopted.tasks.find((entry) => entry.taskId === aliveTaskId);
    expect(aliveAdopted).toBeDefined();
    expect(aliveAdopted?.status).toBe("running");
  }, LONG_TIMEOUT);

  test("持久记录 startedAt 与真实进程不符（伪造）时不接管，存活进程不受影响", async () => {
    const base = await makeTempDir();
    const database = join(base, "data.db");
    const host = roleHost("mismatch-owner");
    const runToken = randomUUID();
    const taskId = randomUUID();
    const registryA = makeRegistry({ database });

    const started = await registryA.spawn({
      taskId,
      host,
      command: "sh",
      args: ["-c", "sleep 30"],
      mode: "background",
      runToken,
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    trackPgid(started.task.pgid);
    await sleepMs(200);

    const recordPath = { database, namespace: "shells", key: taskId };
    const current = await readRecord(recordPath);
    expect(current.exists).toBe(true);
    if (!current.exists) return;
    const forged = { ...(current.data as Record<string, unknown>), startedAt: started.task.startedAt! - 999_000 };
    putRecord(recordPath, forged);

    const registryB = makeRegistry({ database, ps: async () => [] });
    const adopted = await registryB.adoptOrphans({ runToken, owner: host });
    expect(adopted.ok).toBe(true);
    if (!adopted.ok) return;
    expect(adopted.tasks.some((entry) => entry.taskId === taskId)).toBe(false);
    expect(groupAlive(started.task.pgid)).toBe(true);
  }, LONG_TIMEOUT);

  test("data.db 里该任务的持久记录内容损坏时接管返回具体原因而不静默丢弃", async () => {
    const base = await makeTempDir();
    const database = join(base, "data.db");
    const host = roleHost("corrupt-owner");
    const runToken = randomUUID();
    const taskId = randomUUID();

    createRecord({ database, namespace: "shells", key: taskId }, { invalid: true });

    const registry = makeRegistry({ database, ps: async () => [] });
    const adopted = await registry.adoptOrphans({ runToken, owner: host });
    expect(adopted.ok).toBe(false);
    if (adopted.ok) return;
    expect(adopted.reason.length).toBeGreaterThan(0);
  }, LONG_TIMEOUT);
});

describe("ps 采样文本解析 parsePsTable", () => {
  test("有非空数据行但 0 条可解析（中文 locale 的 STARTED 列）时抛错", () => {
    const parsePsTable = (ShellRegistryModule as Record<string, unknown>).parsePsTable as
      | ((text: string) => PsEntry[])
      | undefined;
    expect(typeof parsePsTable).toBe("function");
    if (typeof parsePsTable !== "function") return;
    const text = [
      "  PID  PGID  PPID STARTED                      COMMAND",
      "12345 12345     1 六  8月/29 04:20:13 2026     sh -c sleep 3",
    ].join("\n");
    expect(() => parsePsTable(text)).toThrow();
  }, LONG_TIMEOUT);

  test("英文 C locale 表解析出 pid/pgid/ppid/startedAt(number)/command 正确", () => {
    const parsePsTable = (ShellRegistryModule as Record<string, unknown>).parsePsTable as
      | ((text: string) => PsEntry[])
      | undefined;
    expect(typeof parsePsTable).toBe("function");
    if (typeof parsePsTable !== "function") return;
    const text = [
      "  PID  PGID  PPID STARTED                      COMMAND",
      "74892 74890 74890 Wed Sep  9 03:02:03 2026     sh -c sleep 3",
    ].join("\n");
    const rows = parsePsTable(text);
    expect(rows.length).toBe(1);
    const row = rows[0]!;
    expect(row.pid).toBe(74_892);
    expect(row.pgid).toBe(74_890);
    expect(row.ppid).toBe(74_890);
    expect(typeof row.startedAt).toBe("number");
    expect(row.command).toContain("sh -c sleep 3");
  }, LONG_TIMEOUT);
});

describe("进程组探测 probeProcessGroup", () => {
  test("非法 pgid（≤1）返回错误结果而不抛异常", () => {
    const probeProcessGroup = (ShellRegistryModule as Record<string, unknown>).probeProcessGroup as
      | ((pgid: number) => { ok: boolean; reason?: string })
      | undefined;
    expect(typeof probeProcessGroup).toBe("function");
    if (typeof probeProcessGroup !== "function") return;
    let resultForOne: { ok: boolean; reason?: string } | undefined;
    let resultForZero: { ok: boolean; reason?: string } | undefined;
    expect(() => {
      resultForOne = probeProcessGroup(1);
    }).not.toThrow();
    expect(() => {
      resultForZero = probeProcessGroup(0);
    }).not.toThrow();
    expect(resultForOne?.ok).toBe(false);
    expect(resultForZero?.ok).toBe(false);
  }, LONG_TIMEOUT);
});

describe("等待模式管道输出", () => {
  test("wait 模式下 spawn 通过 onOutput 分块转发 stdout/stderr，且 env 覆盖生效同时保留注入 token", async () => {
    const registry = makeRegistry();
    const runToken = randomUUID();

    const taskId = randomUUID();
    const chunks: { stream: "stdout" | "stderr"; text: string }[] = [];
    const result = await registry.spawn({
      taskId,
      host: HOST_MAIN,
      command: "sh",
      args: ["-c", "echo out; echo err 1>&2"],
      mode: "wait",
      runToken,
      onOutput: (chunk: Buffer, stream: "stdout" | "stderr") => {
        chunks.push({ stream, text: chunk.toString() });
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    trackPgid(result.task.pgid);

    await waitFor(() => registry.get(taskId)?.status === "exited", LONG_TIMEOUT);
    expect(registry.get(taskId)?.exitCode).toBe(0);

    const stdoutText = chunks.filter((c) => c.stream === "stdout").map((c) => c.text).join("");
    const stderrText = chunks.filter((c) => c.stream === "stderr").map((c) => c.text).join("");
    expect(stdoutText).toContain("out");
    expect(stderrText).toContain("err");

    const envTaskId = randomUUID();
    const envChunks: string[] = [];
    const envResult = await registry.spawn({
      taskId: envTaskId,
      host: HOST_MAIN,
      command: "sh",
      args: ["-c", "echo $FOO; echo $ONE_COMPANY_SHELL_TOKEN"],
      mode: "wait",
      runToken,
      env: { FOO: "bar" },
      onOutput: (chunk: Buffer, stream: "stdout" | "stderr") => {
        if (stream === "stdout") envChunks.push(chunk.toString());
      },
    });
    expect(envResult.ok).toBe(true);
    if (!envResult.ok) return;
    trackPgid(envResult.task.pgid);

    await waitFor(() => registry.get(envTaskId)?.status === "exited", LONG_TIMEOUT);
    const envLines = envChunks
      .join("")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    expect(envLines[0]).toBe("bar");
    expect(envLines[1]?.length).toBeGreaterThan(0);
  }, LONG_TIMEOUT);
});

describe("wait 模式管道背压（真实 Node 子进程）", () => {
  test("无 onOutput 时管道仍必须被消费：≥1MB 输出的 wait 任务在真实 Node 下 5 秒内 exited", async () => {
    const nodePath = process.execPath;
    expect(typeof nodePath).toBe("string");

    const clockPath = fileURLToPath(new URL("../runtime/clock.ts", import.meta.url));
    const registryPath = fileURLToPath(new URL("../runtime/shell-registry.ts", import.meta.url));
    const shellCommand = 'head -c 1048576 /dev/zero | tr "\\0" a';

    const scriptSource = [
      `import { createClock } from ${JSON.stringify(clockPath)};`,
      `import { ShellRegistry } from ${JSON.stringify(registryPath)};`,
      "",
      "const registry = new ShellRegistry({ clock: createClock() });",
      "const result = await registry.spawn({",
      "  taskId: crypto.randomUUID(),",
      '  host: { kind: "main", id: "main" },',
      '  command: "sh",',
      `  args: ["-c", ${JSON.stringify(shellCommand)}],`,
      '  mode: "wait",',
      "  runToken: crypto.randomUUID(),",
      "});",
      "if (!result.ok) {",
      '  console.log("STUCK");',
      "  process.exit(1);",
      "}",
      "const taskId = result.task.taskId;",
      "const deadline = Date.now() + 5000;",
      "while (Date.now() < deadline) {",
      '  if (registry.get(taskId)?.status === "exited") {',
      '    console.log("OK");',
      "    process.exit(0);",
      "  }",
      "  await new Promise((resolve) => setTimeout(resolve, 50));",
      "}",
      'console.log("STUCK");',
      "process.exit(1);",
    ].join("\n");

    const scriptDir = await mkdtemp(join(tmpdir(), "shell-registry-pipe-backpressure-"));
    try {
      const scriptPath = join(scriptDir, "probe.mts");
      await writeFile(scriptPath, scriptSource, "utf8");

      const { code, stdout } = await new Promise<{ code: number | null; stdout: string }>((resolve, reject) => {
        const child = spawnChildProcess(nodePath, [scriptPath], { stdio: ["ignore", "pipe", "inherit"] });
        let out = "";
        child.stdout?.on("data", (chunk: Buffer) => {
          out += chunk.toString();
        });
        child.on("error", reject);
        child.on("exit", (exitCode) => resolve({ code: exitCode, stdout: out }));
      });

      expect(stdout).toContain("OK");
      expect(code).toBe(0);
    } finally {
      await rm(scriptDir, { recursive: true, force: true });
    }
  }, LONG_TIMEOUT);
});
