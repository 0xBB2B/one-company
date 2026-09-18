import { expect, test } from "vitest";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { promisify } from "node:util";
import { runInNewContext } from "node:vm";
import { createManagedBashOperations } from "../runtime/shell-bash.ts";
import { assertExecutionGuardCurrent, guardedOutputLimit } from "../runtime/execution-guard.ts";

const host = { kind: "main" as const, id: "vm" };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((yes) => { resolve = yes; }); return { promise, resolve }; }
async function world() {
  const source = stripTypeScriptTypes(await readFile(new URL("../runtime/shell-registry.ts", import.meta.url), "utf8"))
    .replace(/^import .*;\n/gmu, "").replace(/^export /gmu, "");
  const child = Object.assign(new EventEmitter(), { pid: 11001, stdout: Object.assign(new EventEmitter(), { destroy() {} }),
    stderr: Object.assign(new EventEmitter(), { destroy() {} }), unref() {} });
  const records = new Map<string, any>();
  const signals: Array<[number, string | number]> = [];
  let alive = true, escaped = false;
  let ps: () => Promise<any[]> = async () => [];
  let started: (pid: number) => Promise<number | null> = async () => 1;
  const db = { list: () => [...records.values()].map((data) => ({ data })), create: (_t: string, key: string, data: any) => records.set(key, data),
    read: (_t: string, key: string) => records.has(key) ? { version: 1 } : null,
    remove: (_t: string, key: string) => records.delete(key), transaction: (run: () => unknown) => run() };
  const Registry = runInNewContext(`${source}\nShellRegistry`, {
    Buffer, process: { cwd: () => "/controlled", platform: "darwin" }, setTimeout, clearTimeout,
    setInterval: () => ({ unref() {} }), clearInterval() {},
    execFile() { throw new Error("unexpected subprocess"); }, readFile() { throw new Error("unexpected file read"); }, promisify,
    withDatabase: (_path: string, run: (db: any) => unknown) => run(db), assertExecutionGuardCurrent, guardedOutputLimit,
    spawn: () => { queueMicrotask(() => child.emit("spawn")); return child; },
  });
  const clock = { startGapWatcher() {}, stopGapWatcher() {}, now: () => 0, elapsedExcludingSleep: () => 0, deadline: () => false,
    clearTimer() {}, setTimeoutExcludingSleep: () => ({}) };
  const registry = new Registry({ clock, database: "vm-only", probes: {
    pidStartedAt: (pid: number) => started(pid), ps: () => ps(),
    kill(pid: number, signal: string | number) {
      signals.push([pid, signal]);
      if (signal === 0 && !((alive && Math.abs(pid) === child.pid) || (escaped && pid === 12000))) throw Object.assign(new Error("gone"), { code: "ESRCH" });
    },
  } });
  const output: string[] = [];
  const spawnTask = () => registry.spawn({ taskId: "id", host, command: "controlled", mode: "wait", runToken: "run",
    executionGuard: { assertCurrent() {} }, onOutput: (chunk: Buffer) => output.push(chunk.toString()) });
  const close = () => { alive = false; child.emit("exit", 11); child.emit("close"); };
  return { registry, child, records, signals, output, spawnTask, close,
    escaped(value: boolean) { escaped = value; }, ps(run: () => Promise<any[]>) { ps = run; }, started(run: (pid: number) => Promise<number | null>) { started = run; } };
}

test("消费在close等待中被作废后，零块和迟到块都不能重新交付", async () => {
  for (const late of [false, true]) {
    const w = await world();
    const { task } = await w.spawnTask();
    const delivery = w.registry.deliverGuardedOutput(task).then(() => false, () => true);
    await Promise.resolve();
    w.registry.discardGuardedOutput(task);
    if (late) w.child.stdout.emit("data", Buffer.from("LATE_AFTER_DISCARD"));
    w.close();
    await w.registry.inspect("id");
    expect(await delivery).toBe(true);
    expect(w.output).toEqual([]);
    await expect(w.registry.deliverGuardedOutput(task)).rejects.toThrow();
  }
});

test("公开后代展示被微任务清空不能改变本次局部扫描证明", async () => {
  const w = await world();
  const { task } = await w.spawnTask();
  w.escaped(true);
  w.ps(() => {
    let turn = Promise.resolve();
    for (let i = 0; i < 4; i++) turn = turn.then(() => {});
    void turn.then(() => { task.descendants = []; task.descendantsScanned = true; });
    return Promise.resolve([{ pid: 12000, pgid: 12000, ppid: 11001, startedAt: 1, command: "escaped", token: "run:id" }]);
  });
  w.close();
  await w.registry.inspect("id");
  expect(w.registry.isTaskExecutionEnded(task)).toBe(false);
  expect(w.signals.some(([pid, signal]) => pid === 12000 && signal === 0)).toBe(true);
  const delivery = w.registry.deliverGuardedOutput(task).then(() => false, () => true);
  await Promise.resolve();
  w.registry.discardGuardedOutput(task);
  w.escaped(false);
  await w.registry.inspect("id");
  expect(await delivery).toBe(true);
  expect(w.output).toEqual([]);
});

test("adoption等待期间新spawn占据ID，排队停止只结算原对象", async () => {
  const w = await world();
  const adoption = deferred<number>();
  let entered = false;
  w.records.set("id", { taskId: "id", pid: 99001, pgid: 99001, startedAt: 1, command: "old", cwd: "/controlled", host, token: "run:id" });
  w.started(async (pid) => { if (pid === 99001) { entered = true; return adoption.promise; } return 1; });
  const adopting = w.registry.adoptOrphans({ runToken: "run", owner: host });
  expect(entered).toBe(true);
  w.records.delete("id"); // 模拟另一个已授权清理者移除旧持久记录，不改registry私有Map。
  const { task } = await w.spawnTask();
  const scan = deferred<any[]>(); let scanning = false;
  w.ps(async () => { if (!scanning) { scanning = true; return scan.promise; } return []; });
  w.close();
  const stopping = w.registry.stopTask(task);
  adoption.resolve(1);
  await Promise.resolve();
  expect(w.registry.get("id")).toBe(task);
  scan.resolve([]);
  const [stopped] = await Promise.all([stopping, adopting]);
  expect(stopped.ok).toBe(true);
  expect(stopped.task).toBe(task);
  expect(w.signals.some(([pid, signal]) => Math.abs(pid) === 99001 && signal !== 0)).toBe(false);
});

test("可信后续观察按私有结束证明撤销许可，不受公开展示状态影响", async () => {
  for (const status of ["unchanged", "running", "starting", "stopping"]) {
    const w = await world();
    const { task } = await w.spawnTask();
    w.child.stdout.emit("data", Buffer.from("old result"));
    w.close();
    await w.registry.inspect("id");
    expect(w.registry.isTaskExecutionEnded(task)).toBe(true);
    if (status !== "unchanged") { task.status = status; task.activity = "active"; }
    w.escaped(true);
    w.ps(async () => [{ pid: 12000, pgid: 12000, ppid: 11001, startedAt: 1, command: "escaped", token: "run:id" }]);
    await w.registry.adoptOrphans({ runToken: "run", owner: host });
    expect(w.registry.isTaskExecutionEnded(task), status).toBe(false);
    expect(task.status, status).toBe("uncertain");
    await expect(w.registry.deliverGuardedOutput(task)).rejects.toThrow();
    await expect(w.registry.deliverGuardedOutput(task)).rejects.toThrow();
    expect(w.output, status).toEqual([]);
  }
});

test("after、mutation和launch的undefined拒绝与正常undefined返回严格区分", async () => {
  for (const guarded of [false, true]) for (const stage of ["after", "mutation", "launch"] as const) {
    let delivered = false, available = true;
    const task = { taskId: "id", status: "exited", activity: "ended", exitCode: 11 };
    const registry = {
      spawn: async () => ({ ok: true, task }), get: () => task,
      isTaskExecutionEnded: () => true, exitCodeFor: () => 11,
      discardGuardedOutput() { available = false; },
      async deliverGuardedOutput() { if (!available) throw new Error("discarded"); delivered = true; },
    };
    const operations = createManagedBashOperations({ registry: registry as any, host, runToken: "run",
      guard: { before: async () => undefined, after: async () => { if (stage === "after") throw undefined; return []; },
        launch: async () => { if (stage === "launch") return Promise.reject(); return { command: "unused", args: [],
          ...(guarded ? { executionGuard: { assertCurrent() {} } } : {}) }; } },
      ...(stage === "mutation" ? { mutation: async (run: () => Promise<any>) => { await run(); return Promise.reject(); } } : {}),
    });
    const result = await operations.exec("unused", "/controlled", { onData() {} }).then(() => ({ failed: false }), (error) => ({ failed: true, error }));
    expect(result).toEqual({ failed: true, error: undefined });
    expect(delivered).toBe(false);
  }
});
