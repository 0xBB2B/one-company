import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import type { ChildProcess } from "node:child_process";
import { appendFile, cp, mkdir, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { controlToken } from "../src/core/host/daemon-auth.ts";
import { PROTOCOL_VERSION } from "../src/core/host/protocol.ts";
import { uuidv7 } from "../src/core/storage/database.ts";
import { RunStore } from "../src/modules/agents/run-store.ts";
import {
  connectRawClient,
  connectTestClient,
  createDaemonFixture,
  removeDaemonFixture,
  startDaemonForTest,
} from "./helpers/daemon-harness.ts";
import type { DaemonFixture, DaemonHandle, RawClient, TestClient } from "./helpers/daemon-harness.ts";
import { temporaryRoot } from "./helpers/temporary-root.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const COPIED_ENTRIES = ["package.json", "src", "resources", "agents", "assets", "examples", "role-rules", "rules", "shared", "skills"];
const TOUCHED_SOURCE = "src/app/daemon/lifecycle.ts";

let productCopy = "";
let touchedOriginal = "";

const fixtures: DaemonFixture[] = [];
const procs: ChildProcess[] = [];
const closers: Array<() => void> = [];

beforeAll(async () => {
  productCopy = join(temporaryRoot(), "product");
  await mkdir(productCopy, { recursive: true });
  for (const entry of COPIED_ENTRIES) await cp(join(repoRoot, entry), join(productCopy, entry), { recursive: true, verbatimSymlinks: true });
  await symlink(join(repoRoot, "node_modules"), join(productCopy, "node_modules"));
  touchedOriginal = await readFile(join(productCopy, TOUCHED_SOURCE), "utf8");
}, 120_000);

afterAll(async () => {
  await rm(productCopy, { recursive: true, force: true });
});

afterEach(async () => {
  for (const close of closers.splice(0)) {
    try { close(); } catch { /* 连接可能已随守护进程退出而关闭 */ }
  }
  for (const proc of procs.splice(0)) {
    if (proc.exitCode === null && proc.signalCode === null) {
      proc.kill("SIGKILL");
      await new Promise<void>((resolve) => { proc.once("exit", () => resolve()); setTimeout(resolve, 3000); });
    }
  }
  for (const fixture of fixtures.splice(0)) await removeDaemonFixture(fixture);
  await writeFile(join(productCopy, TOUCHED_SOURCE), touchedOriginal);
  await rm(join(productCopy, "tests"), { recursive: true, force: true });
});

async function startDaemon(options: { fromCopy?: boolean } = {}): Promise<{ fixture: DaemonFixture; handle: DaemonHandle; token: string }> {
  const fixture = await createDaemonFixture();
  fixtures.push(fixture);
  const handle = await startDaemonForTest(fixture, {
    idleTimeoutMs: 60_000,
    ...(options.fromCopy ? { productRoot: productCopy } : {}),
  });
  procs.push(handle.proc);
  return { fixture, handle, token: controlToken(fixture.dataRoot) };
}

async function rawClient(fixture: DaemonFixture): Promise<RawClient> {
  const raw = await connectRawClient(fixture.socketPath, { dataRoot: fixture.dataRoot });
  closers.push(() => raw.close());
  return raw;
}

async function helloClient(fixture: DaemonFixture, windowId: string): Promise<TestClient> {
  const client = await connectTestClient(fixture.socketPath, { windowId, sessionId: `${windowId}-session` });
  closers.push(() => client.close());
  return client;
}

async function makeStale(): Promise<void> {
  await appendFile(join(productCopy, TOUCHED_SOURCE), "\n// 让代码指纹改变\n");
}

async function pauseRequirementRun(fixture: DaemonFixture, startedAt: string, requirement: string): Promise<void> {
  const store = new RunStore({ dataRoot: fixture.dataRoot, repoId: fixture.repoId, daemonStartedAt: startedAt });
  const run = await store.create({
    kind: "requirement",
    requirement,
    task: "升级检查占位任务",
    cwd: fixture.repoDir,
    writePaths: [],
    readPaths: [],
    model: { provider: "anthropic", id: "claude-test" },
    thinking: "high",
    mcp: [],
  });
  await store.update(run.id, { state: "running" });
  await store.update(run.id, { state: "paused" });
}

describe("upgrade.check", () => {
  test("握手前查询：代码没改时不过旧且三项都为空", async () => {
    const { fixture, token } = await startDaemon({ fromCopy: true });
    const raw = await rawClient(fixture);

    const result = await raw.call("upgrade.check", { authToken: token, windowId: "any-window" });

    expect(result).toEqual({ stale: false, protocolVersion: 7, requirements: [], otherWindows: 0, ownSessions: 0 });
  }, 60_000);

  test("握手后查询同样可用", async () => {
    const { fixture, token } = await startDaemon({ fromCopy: true });
    const client = await helloClient(fixture, "w-a");

    const result = await client.call("upgrade.check", { authToken: token, windowId: "w-a" });

    expect(result).toEqual({ stale: false, protocolVersion: 7, requirements: [], otherWindows: 0, ownSessions: 0 });
  }, 60_000);

  test("改了产品副本 src 下的文件后过旧", async () => {
    const { fixture, token } = await startDaemon({ fromCopy: true });
    await makeStale();
    const raw = await rawClient(fixture);

    const result = await raw.call("upgrade.check", { authToken: token, windowId: "any-window" });

    expect(result.stale).toBe(true);
  }, 60_000);

  test("改了产品副本 package.json 后过旧", async () => {
    const { fixture, token } = await startDaemon({ fromCopy: true });
    await appendFile(join(productCopy, "package.json"), "\n");
    const raw = await rawClient(fixture);

    const result = await raw.call("upgrade.check", { authToken: token, windowId: "any-window" });

    expect(result.stale).toBe(true);
  }, 60_000);

  test("只改产品副本 tests 下的文件不算过旧", async () => {
    const { fixture, token } = await startDaemon({ fromCopy: true });
    await mkdir(join(productCopy, "tests"), { recursive: true });
    await writeFile(join(productCopy, "tests", "unrelated.ts"), "export const x = 1;\n");
    const raw = await rawClient(fixture);

    const result = await raw.call("upgrade.check", { authToken: token, windowId: "any-window" });

    expect(result.stale).toBe(false);
  }, 60_000);

  test("authToken 错误时报 unauthorized", async () => {
    const { fixture } = await startDaemon();
    const raw = await rawClient(fixture);

    await expect(raw.call("upgrade.check", { authToken: "wrong-token", windowId: "w" })).rejects.toThrow(/unauthorized/);
  }, 60_000);

  test("缺少 authToken 时报 unauthorized", async () => {
    const { fixture } = await startDaemon();
    const raw = await rawClient(fixture);

    await expect(raw.call("upgrade.check", { windowId: "w" })).rejects.toThrow(/unauthorized/);
  }, 60_000);

  test("多带一个参数时报 bad_params", async () => {
    const { fixture, token } = await startDaemon();
    const raw = await rawClient(fixture);

    await expect(raw.call("upgrade.check", { authToken: token, windowId: "w", extra: 1 })).rejects.toThrow(/bad_params/);
  }, 60_000);

  test("另一个窗口握手后，未握手的调用方看到 otherWindows 为 1", async () => {
    const { fixture, token } = await startDaemon();
    await helloClient(fixture, "w-a");
    const raw = await rawClient(fixture);

    const result = await raw.call("upgrade.check", { authToken: token, windowId: "w-b" });

    expect(result.otherWindows).toBe(1);
  }, 60_000);

  test("调用方与已握手窗口同一 windowId 时 otherWindows 为 0", async () => {
    const { fixture, token } = await startDaemon();
    await helloClient(fixture, "w-a");
    const raw = await rawClient(fixture);

    const result = await raw.call("upgrade.check", { authToken: token, windowId: "w-a" });

    expect(result.otherWindows).toBe(0);
  }, 60_000);

  test("有处在 paused 的需求运行时 requirements 含一项", async () => {
    const { fixture, token } = await startDaemon();
    const client = await helloClient(fixture, "w-a");
    const requirement = uuidv7();
    await pauseRequirementRun(fixture, client.helloResult.startedAt as string, requirement);

    const result = await client.call("upgrade.check", { authToken: token, windowId: "w-a" });

    expect(result.requirements).toHaveLength(1);
    expect(typeof (result.requirements as string[])[0]).toBe("string");
    expect((result.requirements as string[])[0]).not.toBe("");
  }, 60_000);
  test("握手前调用后连接仍未握手，其他请求照样要求先 hello", async () => {
    const { fixture, token } = await startDaemon();
    const raw = await rawClient(fixture);
    await raw.call("upgrade.check", { authToken: token, windowId: "any-window" });

    await expect(raw.call("runs.get", { runId: "run-1" })).rejects.toThrow(/hello/);
  }, 60_000);
});

describe("upgrade.yield", () => {
  test("过旧且不忙时接受，守护进程退出并删除 socket", async () => {
    const { fixture, handle, token } = await startDaemon({ fromCopy: true });
    await makeStale();
    const raw = await rawClient(fixture);

    const result = await raw.call("upgrade.yield", { authToken: token, windowId: "any-window" });

    expect(result.accepted).toBe(true);
    await handle.exited;
    await expect(stat(fixture.socketPath)).rejects.toThrow();
  }, 60_000);

  test("不过旧时不接受，进程继续运行", async () => {
    const { fixture, handle, token } = await startDaemon({ fromCopy: true });
    const raw = await rawClient(fixture);

    const result = await raw.call("upgrade.yield", { authToken: token, windowId: "any-window" });

    expect(result.accepted).toBe(false);
    expect(result.stale).toBe(false);
    expect(handle.proc.exitCode).toBeNull();
    await expect(stat(fixture.socketPath)).resolves.toBeTruthy();
  }, 60_000);

  test("过旧但另有窗口握手连着时不接受，进程继续运行", async () => {
    const { fixture, handle, token } = await startDaemon({ fromCopy: true });
    await helloClient(fixture, "w-a");
    await makeStale();
    const raw = await rawClient(fixture);

    const result = await raw.call("upgrade.yield", { authToken: token, windowId: "w-b" });

    expect(result.accepted).toBe(false);
    expect(result.otherWindows).toBe(1);
    expect(handle.proc.exitCode).toBeNull();
  }, 60_000);

  test("过旧但有 paused 需求运行时不接受，进程继续运行", async () => {
    const { fixture, handle, token } = await startDaemon({ fromCopy: true });
    const client = await helloClient(fixture, "w-a");
    await pauseRequirementRun(fixture, client.helloResult.startedAt as string, uuidv7());
    await makeStale();

    const result = await client.call("upgrade.yield", { authToken: token, windowId: "w-a" });

    expect(result.accepted).toBe(false);
    expect(result.requirements).toHaveLength(1);
    expect(handle.proc.exitCode).toBeNull();
  }, 60_000);

  test("算代码指纹失败时报错，不返回编出来的状态，进程继续运行", async () => {
    const { fixture, handle, token } = await startDaemon({ fromCopy: true });
    const manifest = join(productCopy, "package.json");
    await rename(manifest, `${manifest}.bak`);
    try {
      const raw = await rawClient(fixture);
      await expect(raw.call("upgrade.yield", { authToken: token, windowId: "any-window" })).rejects.toThrow(/代码指纹/);
      expect(handle.proc.exitCode).toBeNull();
    } finally {
      await rename(`${manifest}.bak`, manifest);
    }
  }, 60_000);

  test("authToken 错误时报 unauthorized 且进程继续运行", async () => {
    const { fixture, handle } = await startDaemon({ fromCopy: true });
    await makeStale();
    const raw = await rawClient(fixture);

    await expect(raw.call("upgrade.yield", { authToken: "wrong-token", windowId: "w" })).rejects.toThrow(/unauthorized/);
    expect(handle.proc.exitCode).toBeNull();
  }, 60_000);
});

describe("协议版本", () => {
  test("PROTOCOL_VERSION 为 7", () => {
    expect(PROTOCOL_VERSION).toBe(7);
  });

  test("hello 结果的 protocolVersion 为 7", async () => {
    const { fixture } = await startDaemon();
    const client = await helloClient(fixture, "w-a");

    expect(client.helloResult.protocolVersion).toBe(7);
  }, 60_000);
});
