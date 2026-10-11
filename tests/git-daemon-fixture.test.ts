import { expect, test } from "vitest";
import { AsyncLocalStorage } from "node:async_hooks";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { isAbsolute, join, relative } from "node:path";
import { runInNewContext } from "node:vm";

async function harness(mode: string) {
  const text = await readFile(new URL("./helpers/git-daemon-fixture.ts", import.meta.url), "utf8");
  const source = stripTypeScriptTypes(text).replace(/^import .*;\n/gmu, "").replace(/^export /gmu, "");
  const child = Object.assign(new EventEmitter(), { pid: 777, exitCode: null as number | null,
    signalCode: null as string | null, stdout: new EventEmitter(), stderr: new EventEmitter() });
  const removed: string[] = [], signals: (string | number)[] = [];
  let allocated = false, spawned = 0, writes = 0, clock = 0;
  let allocation!: (path: string) => void;
  const slowAllocation = new Promise<string>((resolve) => { allocation = resolve; });
  const api = runInNewContext(`${source}\n({ withGitDaemonFixtures, ownedTempRoot, runOwnedProcess, registerOwnedServer,
    registerOwnedSocket, cleanupGitDaemonFixtures })`, {
    AsyncLocalStorage, Buffer, join, relative, isAbsolute,
    console: { error() {} },
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, Math.max(1, Math.ceil(ms / 20))), clearTimeout,
    performance: { now: () => clock += 250 }, tmpdir: () => "/controlled",
    mkdtemp: async () => { allocated = true; return mode === "allocation" ? slowAllocation : "/controlled/root"; },
    mkdir: async () => { writes += 1; },
    lstat: async () => ({ dev: 1, ino: 2, isDirectory: () => true }),
    rm: async (path: string) => { removed.push(path); },
    spawn: () => { spawned += 1; return child; }, createConnection: () => { throw new Error("not used"); },
    process: { execPath: "controlled", env: {}, kill(_pid: number, signal: string | number) {
      signals.push(signal);
      if (signal === 0) {
        if (mode === "pgid") throw Object.assign(new Error("unknown"), { code: "EPERM" });
        throw Object.assign(new Error("gone"), { code: "ESRCH" });
      }
      if (mode === "overflow") queueMicrotask(() => { child.signalCode = "SIGTERM"; child.emit("close", null, "SIGTERM"); });
    } },
  });
  const wait = async (predicate: () => boolean) => {
    for (let i = 0; i < 100 && !predicate(); i++) await new Promise((resolve) => setTimeout(resolve, 1));
    expect(predicate()).toBe(true);
  };
  return { api, child, removed, signals, wait, allocation,
    allocated: () => allocated, spawned: () => spawned, writes: () => writes };
}

test("关闭scope期间完成分配不会继续mkdir/spawn，迟到调用仍被旧scope拒绝", async () => {
  const h = await harness("allocation");
  const work = h.api.withGitDaemonFixtures(() => h.api.runOwnedProcess("controlled", [], "/controlled"));
  const rejected = work.catch((error: Error) => error);
  await h.wait(h.allocated);
  const cleanup = h.api.cleanupGitDaemonFixtures();
  h.allocation("/controlled/root");
  await cleanup;
  expect((await rejected).message).toContain("scope已关闭");
  expect(h.spawned()).toBe(0);
  expect(h.writes()).toBe(0);
  expect(h.removed).toEqual(["/controlled/root"]);
});

test("exit标志不替代close；PGID未知保全根且不向历史编号发停止信号", async () => {
  for (const mode of ["exit", "pgid"]) {
    const h = await harness(mode);
    const work = h.api.withGitDaemonFixtures(() => h.api.runOwnedProcess("controlled", [], "/controlled"));
    const rejected = work.catch((error: Error) => error);
    await h.wait(() => h.spawned() === 1);
    h.child.exitCode = 0;
    const cleanup = h.api.cleanupGitDaemonFixtures().catch((error: Error) => error);
    await new Promise((resolve) => setTimeout(resolve, 3));
    expect(h.removed).toEqual([]);
    expect(h.signals.filter((signal) => signal !== 0)).toEqual([]);
    h.child.emit("close", 0, null);
    const result = await cleanup;
    await rejected;
    expect(h.removed).toEqual(mode === "exit" ? ["/controlled/root"] : []);
    if (mode === "pgid") expect(result).toBeDefined();
    expect(h.signals.filter((signal) => signal !== 0)).toEqual([]);
  }
});

test("server失败或socket仅destroyed未close不能删除其scope目录", async () => {
  for (const mode of ["server", "server-event", "socket"]) {
    const h = await harness(mode);
    const result = await h.api.withGitDaemonFixtures(async () => {
      await h.api.ownedTempRoot("root-");
      if (mode === "server") h.api.registerOwnedServer({ close: async () => { throw new Error("controlled close failure"); } });
      else if (mode === "server-event") h.api.registerOwnedServer(Object.assign(new EventEmitter(), {
        address: () => null, listening: false, close(callback: () => void) { callback(); },
      }));
      else h.api.registerOwnedSocket(Object.assign(new EventEmitter(), { destroyed: true, destroy() { return this; } }));
    }).catch((error: Error) => error);
    expect(result).toBeDefined();
    expect(h.removed).toEqual([]);
  }
});

test("清理超时后才完成的listen只进入自有关闭，不重新进入业务或删除保全根", async () => {
  const h = await harness("late-listen");
  let release!: () => void, started = false, closes = 0, continued = false;
  const ready = new Promise<void>((resolve) => { release = resolve; });
  const work = h.api.withGitDaemonFixtures(async () => {
    await h.api.ownedTempRoot("root-");
    const server = h.api.registerOwnedServer({
      async listen() { started = true; await ready; },
      async close() { closes += 1; },
    });
    await server.listen();
    continued = true;
  }).catch((error: Error) => error);
  await h.wait(() => started);
  const cleanup = await h.api.cleanupGitDaemonFixtures().catch((error: Error) => error);
  expect(cleanup).toBeDefined();
  expect(closes).toBe(1);
  expect(h.removed).toEqual([]);
  release();
  await work;
  expect(closes).toBe(2);
  expect(continued).toBe(false);
  expect(h.removed).toEqual([]);
});

test("stdout/stderr按合并字节超限中止，不把部分输出当成功", async () => {
  const h = await harness("overflow");
  const work = h.api.withGitDaemonFixtures(() => h.api.runOwnedProcess("controlled", [], "/controlled"));
  const rejected = work.catch((error: Error) => error);
  await h.wait(() => h.spawned() === 1);
  h.child.stdout.emit("data", Buffer.from("中".repeat(400_000)));
  h.child.stderr.emit("data", Buffer.from("文".repeat(400_000)));
  const error = await rejected;
  expect(error.message).toContain("输出超限");
  expect(error.message.length).toBeLessThan(100);
  expect(h.signals).toContain("SIGTERM");
  expect(h.removed).toEqual(["/controlled/root"]);
});
