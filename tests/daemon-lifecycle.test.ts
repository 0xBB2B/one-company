import { temporaryRoot } from "./helpers/temporary-root.ts";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { ChildProcess } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { installSignalHandlers } from "../daemon/lifecycle.ts";
import { RunStore } from "../runtime/run-store.ts";
import { daemonSocketPath, repositoryIdentity } from "../runtime/identity.ts";
import { createRepoFixture, removeRepoFixture } from "./helpers/repo-fixture.ts";
import { putRecord, repositoryDatabase, uuidv7 } from "../runtime/database.ts";
import { deleteRecord } from "./helpers/database-fixture.ts";
import { PROTOCOL_VERSION } from "../runtime/protocol.ts";
import {
  connectRawClient,
  connectTestClient,
  createDaemonFixture,
  killDaemon,
  maxDataRootLength,
  removeDaemonFixture,
  spawnDaemonProcess,
  startDaemonForTest,
  waitForSocketReady,
} from "./helpers/daemon-harness.ts";
import type { DaemonFixture, DaemonHandle, TestClient } from "./helpers/daemon-harness.ts";
import { createTempHome, removeTempHome } from "./helpers/temp-home.ts";
import { MODEL_PROVIDER_MODULE_ENV_VAR } from "./helpers/daemon-model-fixture.ts";
import {
  ASSEMBLY_DELAY_MS_ENV_VAR,
  TRIGGER_UNCAUGHT_EXCEPTION_ENV_VAR,
  TRIGGER_UNHANDLED_REJECTION_ENV_VAR,
} from "./helpers/model-provider-module.ts";

const modelProviderModulePath = fileURLToPath(new URL("./helpers/model-provider-module.ts", import.meta.url));

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(predicate: () => Promise<boolean>, timeoutMs: number, intervalMs = 50): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await delay(intervalMs);
  }
  throw new Error(`等待条件满足超时（${timeoutMs}ms）`);
}

async function exactLengthDataRoot(targetLength: number): Promise<string> {
  const base = await mkdtemp(join(temporaryRoot(), "d"));
  extraTempDirs.push(base);
  const padLength = targetLength - base.length - 1;
  if (padLength < 0) throw new Error(`目标长度 ${targetLength} 短于基础临时目录长度 ${base.length}`);
  const dir = padLength > 0 ? join(base, "x".repeat(padLength)) : base;
  await mkdir(dir, { recursive: true });
  return dir;
}

function requirementInput(overrides: Record<string, unknown> = {}) {
  return {
    kind: "requirement",
    requirement: uuidv7(),
    task: "daemon lifecycle 测试占位任务",
    cwd: "/tmp/daemon-lifecycle-test-cwd",
    writePaths: [],
    readPaths: [],
    model: { provider: "anthropic", id: "claude-test" },
    thinking: "high",
    mcp: [],
    ...overrides,
  };
}

async function createRunningRecord(store: RunStore, overrides: Record<string, unknown> = {}) {
  const run = await store.create(requirementInput(overrides));
  await store.update(run.id, { state: "running" });
  return run;
}

const fixtures: DaemonFixture[] = [];
const homes: Awaited<ReturnType<typeof createTempHome>>[] = [];
const repos: Awaited<ReturnType<typeof createRepoFixture>>[] = [];
const procs: ChildProcess[] = [];
const clients: TestClient[] = [];
const extraTempDirs: string[] = [];

function trackHandle(handle: DaemonHandle): DaemonHandle {
  procs.push(handle.proc);
  return handle;
}

afterEach(async () => {
  for (const client of clients.splice(0)) {
    try {
      client.close();
    } catch {
      // 连接可能已因守护进程退出而关闭
    }
  }
  for (const proc of procs.splice(0)) {
    if (proc.exitCode === null && proc.signalCode === null) {
      proc.kill("SIGKILL");
      await Promise.race([new Promise<void>((resolve) => proc.once("exit", () => resolve())), delay(3000)]);
    }
  }
  for (const home of homes.splice(0)) await removeTempHome(home);
  for (const repo of repos.splice(0)) await removeRepoFixture(repo);
  for (const fixture of fixtures.splice(0)) {
    await removeDaemonFixture(fixture);
  }
  for (const dir of extraTempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("单实例收敛", () => {
  test("并发两次拉起同一仓库后只有一个实例存活，多次 hello 返回同一 daemonPid", async () => {
    const fixture = await createDaemonFixture();
    fixtures.push(fixture);

    const spawned = [
      spawnDaemonProcess({ home: fixture.home, repoDir: fixture.repoDir, dataRoot: fixture.dataRoot }),
      spawnDaemonProcess({ home: fixture.home, repoDir: fixture.repoDir, dataRoot: fixture.dataRoot }),
    ];
    for (const s of spawned) procs.push(s.proc);

    await waitForSocketReady(fixture.socketPath, 15_000);

    const outcomes = await Promise.all(
      spawned.map((s) =>
        Promise.race([
          s.exited.then((result) => ({ alive: false, code: result.code })),
          delay(1_000).then(() => ({ alive: true, code: null as number | null })),
        ]),
      ),
    );
    expect(outcomes.filter((o) => o.alive).length).toBe(1);
    for (const o of outcomes.filter((o) => !o.alive)) expect(o.code).toBe(0);

    const clientA = await connectTestClient(fixture.socketPath);
    const clientB = await connectTestClient(fixture.socketPath);
    clients.push(clientA, clientB);
    expect(typeof clientA.helloResult.daemonPid).toBe("number");
    expect(clientA.helloResult.daemonPid).toBe(clientB.helloResult.daemonPid);
  }, 20_000);

  test("并发三次拉起同一仓库后只有一个实例存活", async () => {
    const fixture = await createDaemonFixture();
    fixtures.push(fixture);

    const spawned = [1, 2, 3].map(() =>
      spawnDaemonProcess({ home: fixture.home, repoDir: fixture.repoDir, dataRoot: fixture.dataRoot }),
    );
    for (const s of spawned) procs.push(s.proc);

    await waitForSocketReady(fixture.socketPath, 15_000);

    const outcomes = await Promise.all(
      spawned.map((s) =>
        Promise.race([
          s.exited.then((result) => ({ alive: false, code: result.code })),
          delay(1_000).then(() => ({ alive: true, code: null as number | null })),
        ]),
      ),
    );
    expect(outcomes.filter((o) => o.alive).length).toBe(1);
    for (const o of outcomes.filter((o) => !o.alive)) expect(o.code).toBe(0);
  }, 20_000);

  test("夺得监听权后清理 sock 目录里陈旧的临时监听文件", async () => {
    const fixture = await createDaemonFixture();
    fixtures.push(fixture);
    const sockDir = join(fixture.dataRoot, "sock");
    await mkdir(sockDir, { recursive: true, mode: 0o700 });
    const stale = join(sockDir, "deadbeefdeadbeef.tmp");
    await writeFile(stale, "");
    const old = new Date(Date.now() - 60 * 60 * 1000);
    await utimes(stale, old, old);

    trackHandle(await startDaemonForTest(fixture));
    const client = await connectTestClient(fixture.socketPath);
    clients.push(client);
    // ping 绕过 handlersReady 闸门，与 acquireListener 内的陈旧文件清理无 happens-before；
    // pm.overview 经 register() 的 awaitStarted() 排队，只有清理与处理器登记都完成后才会返回
    await client.call("pm.overview", {});

    await expect(stat(stale)).rejects.toThrow();
  }, 20_000);

  test("预置无监听者的残留 socket 文件后启动正常", async () => {
    const fixture = await createDaemonFixture();
    fixtures.push(fixture);
    await mkdir(join(fixture.dataRoot, "sock"), { recursive: true });
    await writeFile(fixture.socketPath, "");

    trackHandle(await startDaemonForTest(fixture));
    const client = await connectTestClient(fixture.socketPath);
    clients.push(client);
    expect(typeof client.helloResult.daemonPid).toBe("number");
  }, 15_000);

  test("已有实例运行时再次拉起：新实例退出码 0 且原实例连接不受影响", async () => {
    const fixture = await createDaemonFixture();
    fixtures.push(fixture);
    trackHandle(await startDaemonForTest(fixture));
    const client = await connectTestClient(fixture.socketPath);
    clients.push(client);

    const second = spawnDaemonProcess({ home: fixture.home, repoDir: fixture.repoDir, dataRoot: fixture.dataRoot });
    procs.push(second.proc);
    const result = await second.exited;
    expect(result.code).toBe(0);

    const pong = await client.call("ping");
    expect(typeof pong.now).toBe("number");
  }, 15_000);

  test("残留 socket 且并发三次拉起后在一个自检周期内收敛为单实例，不留临时监听文件", async () => {
    const fixture = await createDaemonFixture();
    fixtures.push(fixture);
    await mkdir(join(fixture.dataRoot, "sock"), { recursive: true });
    await writeFile(fixture.socketPath, "");

    const spawned = [1, 2, 3].map(() =>
      spawnDaemonProcess({ home: fixture.home, repoDir: fixture.repoDir, dataRoot: fixture.dataRoot }),
    );
    for (const s of spawned) procs.push(s.proc);

    async function aliveCount(): Promise<number> {
      const flags = await Promise.all(
        spawned.map((s) => Promise.race([s.exited.then(() => false), delay(50).then(() => true)])),
      );
      return flags.filter(Boolean).length;
    }

    async function tempFiles(): Promise<string[]> {
      const entries = await readdir(join(fixture.dataRoot, "sock"));
      return entries.filter((name) => name.endsWith(".tmp"));
    }

    // bootstrap 加载不等于已监听；先取得真实连接及合法 hello，再观察原 5 秒自检周期。
    await waitForSocketReady(fixture.socketPath, 10_000);
    const readyClient = await connectTestClient(fixture.socketPath);
    clients.push(readyClient);
    expect(typeof readyClient.helloResult.daemonPid).toBe("number");

    await delay(5_000);
    expect(await aliveCount()).toBe(1);
    const afterCheck = await connectTestClient(fixture.socketPath);
    clients.push(afterCheck);
    const survivor = spawned.find((s) => s.proc.pid === afterCheck.helloResult.daemonPid);
    expect(survivor).toBeDefined();
    expect(await tempFiles()).toEqual([]);
  }, 20_000);
});

describe("socket 被替换", () => {
  test("另一个监听者替换正在运行实例的 socket 文件后，原实例在一个自检周期内退出、不删除新文件、只标记自身运行为 interrupted", async () => {
    const fixture = await createDaemonFixture();
    fixtures.push(fixture);
    const handle = trackHandle(await startDaemonForTest(fixture, { extraEnv: { [MODEL_PROVIDER_MODULE_ENV_VAR]: modelProviderModulePath, [ASSEMBLY_DELAY_MS_ENV_VAR]: "300" } }));
    const client = await connectTestClient(fixture.socketPath);
    const daemonStartedAt = String(client.helloResult.startedAt);
    // hello可以早于启动恢复完成；先经过awaitStarted门槛，再建立本测试的运行现场。
    await client.call("pm.overview", {});
    client.close();

    const ownStore = new RunStore({ dataRoot: fixture.dataRoot, repoId: fixture.repoId, daemonStartedAt });
    const ownRun = await createRunningRecord(ownStore);
    const otherStore = new RunStore({
      dataRoot: fixture.dataRoot,
      repoId: fixture.repoId,
      daemonStartedAt: "other-instance",
    });
    const otherRun = await createRunningRecord(otherStore);

    const replacement = createServer();
    await rm(fixture.socketPath, { force: true });
    await new Promise<void>((resolve, reject) => {
      replacement.once("error", reject);
      replacement.listen(fixture.socketPath, () => resolve());
    });
    const before = await stat(fixture.socketPath);

    await handle.exited;
    expect(handle.proc.exitCode === null && handle.proc.signalCode === null).toBe(false);

    const after = await stat(fixture.socketPath);
    expect(after.ino).toBe(before.ino);

    const readStore = new RunStore({ dataRoot: fixture.dataRoot, repoId: fixture.repoId, daemonStartedAt: "irrelevant" });
    const ownResult = await readStore.get(ownRun.id);
    expect(ownResult.ok).toBe(true);
    if (ownResult.ok) expect(ownResult.run.state).toBe("interrupted");
    const otherResult = await readStore.get(otherRun.id);
    expect(otherResult.ok).toBe(true);
    if (otherResult.ok) expect(otherResult.run.state).toBe("running");

    replacement.close();
  }, 20_000);
});

describe("SIGTERM 退出", () => {
  test("SIGTERM 退出时把自身非终态运行标记为 interrupted，不改动其他实例的运行", async () => {
    const fixture = await createDaemonFixture();
    fixtures.push(fixture);
    const handle = trackHandle(await startDaemonForTest(fixture));
    const client = await connectTestClient(fixture.socketPath);
    const daemonStartedAt = String(client.helloResult.startedAt);
    // hello 早于 handlersReady 闸门应答，与装配完成（runManager 等 SIGTERM 收尾所依赖的状态）无 happens-before；
    // pm.overview 经 register() 的 awaitStarted() 排队，返回即说明装配已完整完成，再发 SIGTERM 才有意义
    await client.call("pm.overview", {});
    client.close();

    const ownStore = new RunStore({ dataRoot: fixture.dataRoot, repoId: fixture.repoId, daemonStartedAt });
    const ownRun = await createRunningRecord(ownStore);
    const otherStore = new RunStore({
      dataRoot: fixture.dataRoot,
      repoId: fixture.repoId,
      daemonStartedAt: "other-instance",
    });
    const otherRun = await createRunningRecord(otherStore);

    handle.proc.kill("SIGTERM");
    const result = await handle.exited;
    expect(result.code).toBe(0);
    await expect(stat(fixture.socketPath)).rejects.toThrow();

    const readStore = new RunStore({ dataRoot: fixture.dataRoot, repoId: fixture.repoId, daemonStartedAt: "irrelevant" });
    const ownResult = await readStore.get(ownRun.id);
    expect(ownResult.ok).toBe(true);
    if (ownResult.ok) expect(ownResult.run.state).toBe("interrupted");
    const otherResult = await readStore.get(otherRun.id);
    expect(otherResult.ok).toBe(true);
    if (otherResult.ok) expect(otherResult.run.state).toBe("running");
  }, 15_000);
});

describe("空闲退出", () => {
  test("客户端断开连接后超过空闲时限退出并删除 socket", async () => {
    const fixture = await createDaemonFixture();
    fixtures.push(fixture);
    const handle = trackHandle(await startDaemonForTest(fixture, { idleTimeoutMs: 1_000 }));
    const client = await connectTestClient(fixture.socketPath);
    client.close();

    const result = await handle.exited;
    expect(result.code).toBe(0);
    await expect(stat(fixture.socketPath)).rejects.toThrow();
  }, 15_000);

  test("注入睡眠跳变不计入空闲时长，未到实际空闲时限时不退出", async () => {
    const fixture = await createDaemonFixture();
    fixtures.push(fixture);
    const skewFile = join(fixture.home.home, "clock-skew.json");
    await writeFile(skewFile, "0");
    const idleTimeoutMs = 3_000;
    const handle = trackHandle(await startDaemonForTest(fixture, { idleTimeoutMs, clockSkewFile: skewFile }));

    await delay(500);
    await writeFile(skewFile, String(5 * 60 * 1000));
    await delay(500);
    expect(handle.proc.exitCode).toBeNull();
    expect(handle.proc.signalCode).toBeNull();

    const result = await handle.exited;
    expect(result.code).toBe(0);
  }, 15_000);

  test.each(["queued", "paused"])(
    "存在 %s 状态的需求代理运行时不因空闲退出",
    async (targetState) => {
      const fixture = await createDaemonFixture();
      fixtures.push(fixture);
      const idleTimeoutMs = 800;
      const handle = trackHandle(await startDaemonForTest(fixture, { idleTimeoutMs }));
      const client = await connectTestClient(fixture.socketPath);
      const daemonStartedAt = String(client.helloResult.startedAt);

      const store = new RunStore({ dataRoot: fixture.dataRoot, repoId: fixture.repoId, daemonStartedAt });
      const run = await store.create(requirementInput());
      if (targetState !== "queued") await store.update(run.id, { state: "running" });
      if (targetState === "paused") {
        await store.update(run.id, { state: "pausing" });
        await store.update(run.id, { state: "paused" });
      }
      client.close();

      const stillAlive = await Promise.race([
        handle.exited.then(() => false),
        delay(idleTimeoutMs * 3).then(() => true),
      ]);
      expect(stillAlive).toBe(true);
    },
    15_000,
  );
});

describe("崩溃恢复", () => {
  test("崩溃重启后无法确认已停止的运行标记为 interrupted", async () => {
    const fixture = await createDaemonFixture();
    fixtures.push(fixture);
    const firstHandle = trackHandle(await startDaemonForTest(fixture));
    const client = await connectTestClient(fixture.socketPath);
    const daemonStartedAt = String(client.helloResult.startedAt);
    client.close();

    const store = new RunStore({ dataRoot: fixture.dataRoot, repoId: fixture.repoId, daemonStartedAt });
    const run = await createRunningRecord(store);

    await killDaemon(firstHandle);

    trackHandle(await startDaemonForTest(fixture));

    const readStore = new RunStore({ dataRoot: fixture.dataRoot, repoId: fixture.repoId, daemonStartedAt: "irrelevant" });
    await waitUntil(async () => {
      const result = await readStore.get(run.id);
      return result.ok && result.run.state === "interrupted";
    }, 5_000);
  }, 20_000);

  test("无活动运行且已就绪时 shutdown 被接受，守护进程退出并删除 socket", async () => {
    const fixture = await createDaemonFixture();
    fixtures.push(fixture);
    const handle = trackHandle(await startDaemonForTest(fixture, { idleTimeoutMs: 60_000 }));
    const client = await connectTestClient(fixture.socketPath);
    clients.push(client);

    const result = await client.call("shutdown");
    expect(result.accepted).toBe(true);

    const exit = await handle.exited;
    expect(exit.code).toBe(0);
    await expect(stat(fixture.socketPath)).rejects.toThrow();
  }, 20_000);

  test("存在活动运行时 shutdown 被拒绝并说明原因", async () => {
    const fixture = await createDaemonFixture();
    fixtures.push(fixture);
    const handle = trackHandle(await startDaemonForTest(fixture, { idleTimeoutMs: 60_000 }));
    const client = await connectTestClient(fixture.socketPath);
    clients.push(client);
    const ownStore = new RunStore({
      dataRoot: fixture.dataRoot,
      repoId: fixture.repoId,
      daemonStartedAt: client.helloResult.startedAt as string,
    });
    await createRunningRecord(ownStore, { requirement: uuidv7() });

    const result = await client.call("shutdown");
    expect(result.accepted).toBe(false);
    expect(typeof result.reason).toBe("string");
    expect(handle.proc.exitCode).toBeNull();
  }, 20_000);

  test("启动恢复尚未完成且仍有活动记录时拒绝 shutdown", async () => {
    const fixture = await createDaemonFixture();
    fixtures.push(fixture);
    const staleStore = new RunStore({
      dataRoot: fixture.dataRoot,
      repoId: fixture.repoId,
      daemonStartedAt: "stale-previous-instance",
    });
    await Promise.all(
      Array.from({ length: 3 }, (_, i) =>
        createRunningRecord(staleStore, { requirement: uuidv7() }),
      ),
    );

    trackHandle(await startDaemonForTest(fixture, { extraEnv: {
      [MODEL_PROVIDER_MODULE_ENV_VAR]: modelProviderModulePath,
      [ASSEMBLY_DELAY_MS_ENV_VAR]: "1500",
    } }));
    const client = await connectTestClient(fixture.socketPath);
    clients.push(client);

    const shutdownResult = await client
      .call("shutdown")
      .catch((error: Error) => ({ accepted: false, error: error.message }));
    expect(shutdownResult.accepted).toBe(false);

    const pong = await client.call("ping");
    expect(typeof pong.now).toBe("number");
  }, 30_000);
});

describe("RunStore 读失败不影响存活", () => {
  test("数据库运行记录损坏时守护进程仍存活并可 ping", async () => {
    const fixture = await createDaemonFixture();
    fixtures.push(fixture);
    const handle = trackHandle(await startDaemonForTest(fixture, { idleTimeoutMs: 500 }));
    putRecord({ database: repositoryDatabase(fixture.dataRoot, fixture.repoId), namespace: "runs", key: "corrupt-run" }, {});

    await delay(3_000);
    expect(handle.proc.exitCode).toBeNull();
    expect(handle.proc.signalCode).toBeNull();

    const client = await connectTestClient(fixture.socketPath);
    clients.push(client);
    const pong = await client.call("ping");
    expect(typeof pong.now).toBe("number");
  }, 20_000);

  test("启动前运行记录已损坏：仍能启动、ping，修复记录后才可 shutdown", async () => {
    const fixture = await createDaemonFixture();
    fixtures.push(fixture);
    const corrupt = { database: repositoryDatabase(fixture.dataRoot, fixture.repoId), namespace: "runs", key: "corrupt-run" };
    putRecord(corrupt, {});

    const { proc, exited } = spawnDaemonProcess({
      home: fixture.home,
      repoDir: fixture.repoDir,
      dataRoot: fixture.dataRoot,
      captureOutput: true,
    });
    procs.push(proc);
    await waitForSocketReady(fixture.socketPath, 10_000);

    const client = await connectTestClient(fixture.socketPath);
    clients.push(client);
    const pong = await client.call("ping");
    expect(typeof pong.now).toBe("number");
    // socket 可连早于启动收尾；pm.overview 经 awaitStarted() 排队，返回即说明已过"正在启动"阶段
    await client.call("pm.overview", {}).catch(() => undefined);

    const rejected = await client.call("shutdown");
    expect(rejected.accepted).toBe(false);
    expect(String(rejected.reason ?? "")).toMatch(/读取|读失败|unreadable|EACCES|permission/i);
    expect(proc.exitCode).toBeNull();
    expect(proc.signalCode).toBeNull();

    deleteRecord(corrupt);
    const accepted = await client.call("shutdown");
    expect(accepted.accepted).toBe(true);
    const result = await exited;
    expect(result.code).toBe(0);
  }, 20_000);
});

describe("进程级未处理拒绝兜底", () => {
  test("一次孤立的未处理 Promise 拒绝不会让守护进程退出，仍可 ping", async () => {
    const fixture = await createDaemonFixture();
    fixtures.push(fixture);
    const handle = trackHandle(
      await startDaemonForTest(fixture, {
        extraEnv: {
          [MODEL_PROVIDER_MODULE_ENV_VAR]: modelProviderModulePath,
          [TRIGGER_UNHANDLED_REJECTION_ENV_VAR]: "1",
        },
      }),
    );

    await delay(1_000);
    expect(handle.proc.exitCode).toBeNull();
    expect(handle.proc.signalCode).toBeNull();

    const client = await connectTestClient(fixture.socketPath);
    clients.push(client);
    const pong = await client.call("ping");
    expect(typeof pong.now).toBe("number");
  }, 20_000);
});

describe("分发层就绪信号：socket 就绪早于业务方法登记完成", () => {
  test("装配窗口内 socket 就绪后立即 hello + pm.overview：排队等到登记完成后正常返回，而非 unknown_method", async () => {
    const fixture = await createDaemonFixture();
    fixtures.push(fixture);
    const handle = trackHandle(
      await startDaemonForTest(fixture, {
        extraEnv: {
          [MODEL_PROVIDER_MODULE_ENV_VAR]: modelProviderModulePath,
          [ASSEMBLY_DELAY_MS_ENV_VAR]: "1500",
        },
      }),
    );
    expect(handle.proc.exitCode).toBeNull();

    const client = await connectTestClient(fixture.socketPath);
    clients.push(client);
    const result = await client.call("pm.overview", {});
    expect(Array.isArray(result.items)).toBe(true);
  }, 20_000);

  test("装配长时间卡死（超过启动上界）时 pm.overview 在上界后收到明确的启动中错误而非无限等待", async () => {
    const fixture = await createDaemonFixture();
    fixtures.push(fixture);
    const handle = trackHandle(
      await startDaemonForTest(fixture, {
        extraEnv: {
          [MODEL_PROVIDER_MODULE_ENV_VAR]: modelProviderModulePath,
          [ASSEMBLY_DELAY_MS_ENV_VAR]: "15000",
        },
      }),
    );
    expect(handle.proc.exitCode).toBeNull();

    const client = await connectTestClient(fixture.socketPath);
    clients.push(client);

    const start = Date.now();
    let rejected: Error | undefined;
    try {
      await client.call("pm.overview", {});
    } catch (error) {
      rejected = error as Error;
    }
    const elapsedMs = Date.now() - start;

    expect(rejected).toBeDefined();
    // 断言重点是"有一个明确的启动中上界"，不是具体几秒；14s 留出余量，只要求早于完整 15s 装配延迟结束
    expect(elapsedMs).toBeLessThan(14_000);
    expect(rejected?.message).toMatch(/daemon_starting|启动中|starting/i);
  }, 20_000);

});

describe("uncaughtException 看门狗", () => {
  test("装配期内一次真正未捕获的异常：守护进程在看门狗时限内以非零码退出，socket 文件被清理", async () => {
    const fixture = await createDaemonFixture();
    fixtures.push(fixture);
    const { proc, exited } = spawnDaemonProcess({
      home: fixture.home,
      repoDir: fixture.repoDir,
      dataRoot: fixture.dataRoot,
      captureOutput: true,
      extraEnv: {
        [MODEL_PROVIDER_MODULE_ENV_VAR]: modelProviderModulePath,
        [TRIGGER_UNCAUGHT_EXCEPTION_ENV_VAR]: "1",
      },
    });
    procs.push(proc);

    const start = Date.now();
    const result = await exited;
    const elapsedMs = Date.now() - start;

    expect(result.code).not.toBe(0);
    expect(elapsedMs).toBeLessThan(20_000);
    await delay(200);
    const exists = await stat(fixture.socketPath).then(
      () => true,
      () => false,
    );
    expect(exists).toBe(false);
  }, 30_000);

  test("未捕获异常后收尾卡住：15 秒内不强退，超过 15 秒才 exit(1) 并先尽力清理 socket", async () => {
    const handlers = new Map<string, (error: Error) => void>();
    vi.spyOn(process, "on").mockImplementation(((event: string, handler: (error: Error) => void) => { handlers.set(event, handler); return process; }) as never);
    vi.spyOn(process.stderr, "write").mockImplementation((() => true) as never);
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const forceCleanup = vi.fn(async () => {});
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      installSignalHandlers(() => {}, { onFatalException: () => new Promise<void>(() => {}), forceCleanup });
      handlers.get("uncaughtException")!(new Error("装配期异常"));
      await vi.advanceTimersByTimeAsync(14_900);
      expect(exit).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(200);
      expect(forceCleanup).toHaveBeenCalledTimes(1);
      expect(exit).toHaveBeenCalledWith(1);
    } finally {
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });
});

describe("SDK 加载失败", () => {
  test("SDK 目录缺失时子进程以非零退出码退出并在 stderr 给出原因", async () => {
    const fixture = await createDaemonFixture();
    fixtures.push(fixture);
    const { proc, exited } = spawnDaemonProcess({
      home: fixture.home,
      repoDir: fixture.repoDir,
      dataRoot: fixture.dataRoot,
      sdkDir: join(fixture.dataRoot, "no-such-sdk-dir"),
      captureOutput: true,
    });
    procs.push(proc);
    const result = await exited;
    expect(result.code).not.toBe(0);
    expect(result.stderr.trim().length).toBeGreaterThan(0);
  }, 10_000);

  test("SDK package 版本低于 0.85.0 时子进程以非零退出码退出并在 stderr 给出原因", async () => {
    const fixture = await createDaemonFixture();
    fixtures.push(fixture);
    const fakeSdkDir = join(fixture.dataRoot, "fake-sdk");
    await mkdir(fakeSdkDir, { recursive: true });
    await writeFile(
      join(fakeSdkDir, "package.json"),
      JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "0.84.0" }),
    );
    const { proc, exited } = spawnDaemonProcess({
      home: fixture.home,
      repoDir: fixture.repoDir,
      dataRoot: fixture.dataRoot,
      sdkDir: fakeSdkDir,
      captureOutput: true,
    });
    procs.push(proc);
    const result = await exited;
    expect(result.code).not.toBe(0);
    expect(result.stderr.trim().length).toBeGreaterThan(0);
  }, 10_000);

  test("SDK package 版本为 0.85.0-beta.1 时视为低于下限，子进程以非零退出码退出", async () => {
    const fixture = await createDaemonFixture();
    fixtures.push(fixture);
    const fakeSdkDir = join(fixture.dataRoot, "fake-sdk-prerelease");
    await mkdir(fakeSdkDir, { recursive: true });
    await writeFile(
      join(fakeSdkDir, "package.json"),
      JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "0.85.0-beta.1" }),
    );
    const { proc, exited } = spawnDaemonProcess({
      home: fixture.home,
      repoDir: fixture.repoDir,
      dataRoot: fixture.dataRoot,
      sdkDir: fakeSdkDir,
      captureOutput: true,
    });
    procs.push(proc);
    const result = await exited;
    expect(result.code).not.toBe(0);
    expect(result.stderr.trim().length).toBeGreaterThan(0);
  }, 10_000);
});

describe("环境变量校验", () => {
  test("ONE_COMPANY_IDLE_TIMEOUT_MS 非有限正数时子进程以非零退出码退出并在 stderr 给出原因", async () => {
    const fixture = await createDaemonFixture();
    fixtures.push(fixture);
    const { proc, exited } = spawnDaemonProcess({
      home: fixture.home,
      repoDir: fixture.repoDir,
      dataRoot: fixture.dataRoot,
      extraEnv: { ONE_COMPANY_IDLE_TIMEOUT_MS: "10m" },
      captureOutput: true,
    });
    procs.push(proc);
    const result = await exited;
    expect(result.code).not.toBe(0);
    expect(result.stderr.trim().length).toBeGreaterThan(0);
  }, 10_000);
});

describe("长数据根路径", () => {
  test("数据根路径恰为平台字节上限时仍能创建 socket 并监听", async () => {
    const home = await createTempHome();
    homes.push(home);
    const repo = await createRepoFixture();
    repos.push(repo);
    const identity = await repositoryIdentity(repo.root);
    const longDataRoot = await exactLengthDataRoot(maxDataRootLength());
    const socketPath = daemonSocketPath(longDataRoot, identity.repoId);

    trackHandle(
      await startDaemonForTest({ home, repoDir: identity.commonDir, dataRoot: longDataRoot, socketPath }),
    );
    const client = await connectTestClient(socketPath, {}, { dataRoot: longDataRoot });
    clients.push(client);
    expect(typeof client.helloResult.daemonPid).toBe("number");
  }, 15_000);

  test("数据根路径超过平台字节上限时守护进程非零退出并在 stderr 说明路径超限", async () => {
    const home = await createTempHome();
    homes.push(home);
    const repo = await createRepoFixture();
    repos.push(repo);
    const identity = await repositoryIdentity(repo.root);
    const longDataRoot = await exactLengthDataRoot(90);
    const { proc, exited } = spawnDaemonProcess({
      home,
      repoDir: identity.commonDir,
      dataRoot: longDataRoot,
      captureOutput: true,
    });
    procs.push(proc);
    const result = await exited;
    expect(result.code).not.toBe(0);
    expect(result.stderr.trim().length).toBeGreaterThan(0);
    expect(result.stderr).not.toContain("EINVAL");
  }, 10_000);
});

describe("协议接线", () => {
  test("未 hello 的连接调用 shutdown 返回协议错误且不执行", async () => {
    const fixture = await createDaemonFixture();
    fixtures.push(fixture);
    const handle = trackHandle(await startDaemonForTest(fixture));
    const raw = await connectRawClient(fixture.socketPath);
    await expect(raw.call("shutdown")).rejects.toThrow();
    raw.close();

    await delay(300);
    expect(handle.proc.exitCode).toBeNull();
    expect(handle.proc.signalCode).toBeNull();
  }, 15_000);

  test("未 hello 的连接允许 ping", async () => {
    const fixture = await createDaemonFixture();
    fixtures.push(fixture);
    trackHandle(await startDaemonForTest(fixture));
    const raw = await connectRawClient(fixture.socketPath);
    const pong = await raw.call("ping");
    expect(typeof pong.now).toBe("number");
    raw.close();
  }, 15_000);

  test("未知方法返回 unknown_method 错误", async () => {
    const fixture = await createDaemonFixture();
    fixtures.push(fixture);
    trackHandle(await startDaemonForTest(fixture));
    const client = await connectTestClient(fixture.socketPath);
    clients.push(client);
    await expect(client.call("no.such.method")).rejects.toThrow(/unknown_method/);
  }, 15_000);

  test("已知方法的参数不合形状时返回 bad_params 错误", async () => {
    const fixture = await createDaemonFixture();
    fixtures.push(fixture);
    trackHandle(await startDaemonForTest(fixture));
    const client = await connectTestClient(fixture.socketPath);
    clients.push(client);
    await expect(client.call("ping", { unexpected: true })).rejects.toThrow(/bad_params/);
  }, 15_000);

  test("hello 协议版本不一致时返回 protocol_version 错误且连接被关闭", async () => {
    const fixture = await createDaemonFixture();
    fixtures.push(fixture);
    trackHandle(await startDaemonForTest(fixture));
    const raw = await connectRawClient(fixture.socketPath);
    await expect(
      raw.call("hello", {
        windowId: "test-window",
        sessionId: "test-session",
        protocolVersion: PROTOCOL_VERSION + 1,
      }),
    ).rejects.toThrow(/protocol_version/);
    await raw.waitClosed(5_000);
  }, 15_000);
});

describe("退出信号收尾时限", () => {
  for (const signal of ["SIGTERM", "SIGHUP", "SIGINT"] as const) {
    test(`收到 ${signal} 后收尾卡住：15 秒内不强退，超过 15 秒才 exit(1)`, async () => {
      const handlers = new Map<string, () => void>();
      vi.spyOn(process, "on").mockImplementation(((event: string, handler: () => void) => { handlers.set(event, handler); return process; }) as never);
      const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        installSignalHandlers(() => new Promise<void>(() => {}));
        handlers.get(signal)!();
        await vi.advanceTimersByTimeAsync(14_900);
        expect(exit).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(200);
        expect(exit).toHaveBeenCalledWith(1);
      } finally {
        vi.useRealTimers();
        vi.restoreAllMocks();
      }
    });
  }
});
