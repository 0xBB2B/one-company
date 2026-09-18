import { afterEach, describe, expect, test } from "vitest";
import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { runInNewContext } from "node:vm";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createManagedBashOperations } from "../runtime/shell-bash.ts";
import type { BashCommandGuard } from "../runtime/shell-bash.ts";
import type { ExecutionGuard } from "../runtime/execution-guard.ts";
import type { TaskRecord } from "../runtime/shell-registry.ts";
import { cleanupGitDaemonFixtures, runJsonChild, withGitDaemonFixtures } from "./helpers/git-daemon-fixture.ts";
import { withGitExecutionFixture } from "./helpers/git-execution-fixture.ts";

const HOST = { kind: "main" as const, id: "git-boundary-test" };
afterEach(() => cleanupGitDaemonFixtures());

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function commandGuard(executionGuard: ExecutionGuard, input: {
  beforeLaunch?: () => void | Promise<void>;
  after?: () => string[] | Promise<string[]>;
} = {}): BashCommandGuard {
  return {
    before: async () => undefined,
    after: async () => input.after?.() ?? [],
    async launch(command) {
      await input.beforeLaunch?.();
      return { command: "sh", args: ["-c", command], executionGuard };
    },
  };
}

function taskCopy(task: TaskRecord): TaskRecord {
  return { ...task, host: { ...task.host }, descendants: [...task.descendants] };
}

describe("Git执行保护的启动、私有证明与逐块交付", () => {
  test("launch await后保护失效时零启动、零任务", () => withGitExecutionFixture(async ({ root, registry }) => {
    const marker = join(root, "started");
    let current = true;
    const shell = createManagedBashOperations({
      registry, host: HOST, runToken: randomUUID(),
      guard: commandGuard({ assertCurrent() { if (!current) throw new Error("git changed"); } }, {
        beforeLaunch: async () => { await Promise.resolve(); current = false; },
      }),
    });

    await expect(shell.exec(`printf started > ${JSON.stringify(marker)}`, root, { onData: () => {} })).rejects.toThrow(/git changed/);
    await expect(access(marker)).rejects.toThrow();
    expect(registry.list()).toEqual([]);
  }));

  test("同taskId在首个登记await期间只允许一个真实child", () => withGitExecutionFixture(async ({ root, registry }) => {
    const gate = deferred<void>();
    let baselineCalls = 0;
    const controlled = registry as typeof registry;
    Object.defineProperty(controlled, "pidStartedAt", {
      value: async () => { baselineCalls++; await gate.promise; return Date.now(); },
    });
    const marker = join(root, "starts");
    const taskId = randomUUID();
    const first = registry.spawn({
      taskId, host: HOST, command: "sh", args: ["-c", `printf A >> ${JSON.stringify(marker)}`],
      mode: "wait", runToken: randomUUID(), executionGuard: { assertCurrent() {} },
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    const second = await registry.spawn({
      taskId, host: HOST, command: "sh", args: ["-c", `printf B >> ${JSON.stringify(marker)}`],
      mode: "wait", runToken: randomUUID(), executionGuard: { assertCurrent() {} },
    });
    expect(second.ok).toBe(false);
    expect(baselineCalls).toBe(1);
    gate.resolve();
    const started = await first;
    expect(started.ok).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await readFile(marker, "utf8")).toBe("A");
  }));

  test("公开订阅者改写终态字段不能提前生成私有结束许可或伪造退出码", () => withGitExecutionFixture(async ({ registry }) => {
    const output: string[] = [];
    const taskId = randomUUID();
    registry.subscribe(taskId, (task) => {
      task.status = "exited";
      task.activity = "ended";
      task.descendantsScanned = true;
      task.exitCode = 0;
      task.pid = 999_999;
      task.pgid = 999_999;
    });
    const started = await registry.spawn({
      taskId, host: HOST, command: "sh", args: ["-c", "printf held; sleep 0.25; exit 17"], mode: "wait",
      runToken: randomUUID(), executionGuard: { assertCurrent() {} }, onOutput: (chunk) => output.push(chunk.toString()),
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const delivery = registry.deliverGuardedOutput(started.task);
    const early = await Promise.race([delivery.then(() => "delivered"), new Promise<string>((resolve) => setTimeout(() => resolve("waiting"), 50))]);
    expect(early).toBe("waiting");
    expect(output).toEqual([]);
    await delivery;
    expect(output.join("")).toBe("held");
    expect(registry.exitCodeFor(started.task)).toBe(17);
  }));

  test("首块回调失效后不交付后续stdout/stderr，且不可重入或重放", () => withGitExecutionFixture(async ({ registry, waitFor }) => {
    let current = true;
    const output: string[] = [];
    const taskId = randomUUID();
    const started = await registry.spawn({
      taskId, host: HOST, command: "sh", args: ["-c", "printf first; printf second >&2"], mode: "wait",
      runToken: randomUUID(), executionGuard: { assertCurrent() { if (!current) throw new Error("revoked in callback"); } },
      onOutput: (chunk) => { output.push(chunk.toString()); current = false; },
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    await waitFor(() => started.task.activity === "ended");
    await expect(registry.deliverGuardedOutput(started.task)).rejects.toThrow(/revoked|失效/);
    expect(output).toHaveLength(1);
    await expect(registry.deliverGuardedOutput(started.task)).rejects.toThrow(/消费|失效/);
  }));

  test("原任务副本、另一registry及重复消费均无私有票据", () => withGitExecutionFixture(async ({ registry, waitFor }) => {
    const output: string[] = [];
    const started = await registry.spawn({
      taskId: randomUUID(), host: HOST, command: "sh", args: ["-c", "printf once"], mode: "wait",
      runToken: randomUUID(), executionGuard: { assertCurrent() {} }, onOutput: (chunk) => output.push(chunk.toString()),
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    await waitFor(() => started.task.activity === "ended");
    await expect(registry.deliverGuardedOutput(taskCopy(started.task))).rejects.toThrow(/私有结果证明/);
    await registry.deliverGuardedOutput(started.task);
    expect(output.join("")).toBe("once");
    await expect(registry.deliverGuardedOutput(started.task)).rejects.toThrow(/消费|失效/);
  }));
});

describe("失败作废、外层取消与真实退出码", () => {
  test("mutation抛错后旧私有buffer不可再次消费", () => withGitExecutionFixture(async ({ registry }) => {
    let original: TaskRecord | undefined;
    const output: string[] = [];
    const shell = createManagedBashOperations({
      registry, host: HOST, runToken: randomUUID(), guard: commandGuard({ assertCurrent() {} }),
      mutation: async (operation) => {
        const value = await operation();
        original = value.task;
        throw new Error("PRIVATE_MUTATION_ERROR");
      },
    });
    await expect(shell.exec("printf private-buffer", process.cwd(), { onData: (chunk) => output.push(chunk.toString()) }))
      .rejects.toThrow("PRIVATE_MUTATION_ERROR");
    expect(output).toEqual([]);
    expect(original).toBeDefined();
    await expect(registry.deliverGuardedOutput(original!)).rejects.toThrow(/消费|失效/);
  }));

  test("after同时抛私有错误并使保护失效时只返回固定失效，buffer永久作废", () => withGitExecutionFixture(async ({ registry }) => {
    let current = true;
    const output: string[] = [];
    let original: TaskRecord | undefined;
    const executionGuard: ExecutionGuard = { assertCurrent() { if (!current) throw new Error("FIXED_GIT_INVALID"); } };
    const shell = createManagedBashOperations({
      registry, host: HOST, runToken: randomUUID(),
      mutation: async (operation) => { const value = await operation(); original = value.task; return value; },
      guard: commandGuard(executionGuard, { after: () => { current = false; throw new Error("PRIVATE_AFTER_ERROR"); } }),
    });
    await expect(shell.exec("printf private-after", process.cwd(), { onData: (chunk) => output.push(chunk.toString()) }))
      .rejects.toThrow("FIXED_GIT_INVALID");
    expect(output).toEqual([]);
    await expect(registry.deliverGuardedOutput(original!)).rejects.toThrow(/消费|失效/);
  }));

  test.each(["mutation", "after"] as const)("命令结束后等待%s期间abort：保留真实exitCode且拒绝未交付结果", (phase) => withGitExecutionFixture(async ({ registry, waitFor }) => {
    const gate = deferred<void>();
    const controller = new AbortController();
    const output: string[] = [];
    const guard = commandGuard({ assertCurrent() {} }, { after: phase === "after" ? () => gate.promise.then(() => []) : undefined });
    const shell = createManagedBashOperations({
      registry, host: HOST, runToken: randomUUID(), guard,
      mutation: phase === "mutation" ? async (operation) => { const value = await operation(); await gate.promise; return value; } : undefined,
    });
    const running = shell.exec("printf withheld; exit 11", process.cwd(), { signal: controller.signal, onData: (chunk) => output.push(chunk.toString()) });
    await waitFor(() => registry.list()[0]?.activity === "ended");
    controller.abort();
    gate.resolve();
    await expect(running).rejects.toThrow(/aborted/);
    expect(output).toEqual([]);
    expect(registry.list()[0]?.exitCode).toBe(11);
    expect(registry.list()[0]?.status).toBe("exited");
  }));

  test("early close在登记前发生仍保留真实退出码9", async () => {
    const gate = deferred<void>();
    const observedStartedAt = Date.now();
    await withGitExecutionFixture(async ({ registry, waitFor }) => {
      const spawning = registry.spawn({
        taskId: randomUUID(), host: HOST, command: "sh", args: ["-c", "exit 9"], mode: "wait",
        runToken: randomUUID(), executionGuard: { assertCurrent() {} },
      });
      await new Promise((resolve) => setTimeout(resolve, 80));
      gate.resolve();
      const early = await spawning;
      expect(early.ok).toBe(true);
      if (!early.ok) return;
      await waitFor(() => early.task.activity === "ended");
      expect(registry.exitCodeFor(early.task)).toBe(9);
    }, { probes: { pidStartedAt: async () => { await gate.promise; return observedStartedAt; } } });
  });

  test("early exit后登记失败仍保留真实退出码29", async () => {
    const gate = deferred<void>();
    const observedStartedAt = Date.now();
    await withGitExecutionFixture(async ({ registry }) => {
      const spawning = registry.spawn({
        taskId: randomUUID(), host: HOST, command: "sh", args: ["-c", "exit 29"], mode: "wait",
        runToken: randomUUID(), executionGuard: { assertCurrent() {} },
      });
      await new Promise((resolve) => setTimeout(resolve, 80));
      gate.resolve();
      const result = await spawning;
      expect(result.ok).toBe(false);
      const task = registry.list()[0]!;
      expect(registry.exitCodeFor(task)).toBe(29);
      expect(task.activity).toBe("ended");
    }, { probes: { pidStartedAt: async () => { await gate.promise; return observedStartedAt; } }, databaseName: "." });
  });

  test("尚未观察exit时保持未知，不填默认成功码", () => withGitExecutionFixture(async ({ registry, root }) => {
    const unknown = await registry.spawn({
      taskId: randomUUID(), host: HOST, command: "sh", args: ["-c", "sleep 0.2"], mode: "wait",
      runToken: randomUUID(), executionGuard: { assertCurrent() {} },
    });
    expect(unknown.ok).toBe(true);
    if (unknown.ok && unknown.task.activity !== "ended") expect(registry.exitCodeFor(unknown.task)).toBeNull();
    await writeFile(join(root, "exit-codes.checked"), "ok");
  }));
});

describe("Promise识别、停止证明与真实资源夹具", () => {
  test("同Realm和跨Realm原生Promise的resolve/reject/迟到reject均固定拒绝且无未处理拒绝", () => withGitExecutionFixture(async ({ registry }) => {
    const crossResolve = runInNewContext("Promise.resolve()") as Promise<void>;
    const crossReject = runInNewContext("Promise.reject(new Error('cross reject'))") as Promise<void>;
    const crossLate = runInNewContext("new Promise((_, reject) => setTimeout(() => reject(new Error('cross late')), 20))", { setTimeout }) as Promise<void>;
    const fulfilledValue: Record<string, unknown> = {};
    const fulfilled = Promise.resolve(fulfilledValue);
    let thenGetterCalls = 0;
    Object.defineProperty(fulfilledValue, "then", { get() { thenGetterCalls++; return () => undefined; } });
    const promises = [Promise.resolve(), Promise.reject(new Error("same reject")), crossResolve, crossReject, crossLate, fulfilled];
    let unhandled = 0;
    const listener = () => { unhandled++; };
    process.on("unhandledRejection", listener);
    try {
      for (const promise of promises) {
        const result = registry.spawn({
          taskId: randomUUID(), host: HOST, command: "sh", args: ["-c", "true"], mode: "wait", runToken: randomUUID(),
          executionGuard: { assertCurrent: (() => promise) as unknown as () => void },
        });
        await expect(result).rejects.toThrow(/Promise/);
      }
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(unhandled).toBe(0);
      expect(thenGetterCalls).toBe(0);
    } finally {
      process.removeListener("unhandledRejection", listener);
    }
  }));

  test("自定义thenable只检查描述符，不执行then或getter", () => withGitExecutionFixture(async ({ registry }) => {
    let getterCalls = 0;
    const thenable = Object.defineProperty({}, "then", { get() { getterCalls++; return () => undefined; } });
    await expect(registry.spawn({
      taskId: randomUUID(), host: HOST, command: "sh", args: ["-c", "true"], mode: "wait", runToken: randomUUID(),
      executionGuard: { assertCurrent: (() => thenable) as unknown as () => void },
    })).rejects.toThrow(/thenable/);
    expect(getterCalls).toBe(0);
  }));

  test("先取消再可能超限时不flush且stopped优先", () => withGitExecutionFixture(async ({ registry, waitFor }) => {
    const controller = new AbortController();
    const output: string[] = [];
    const shell = createManagedBashOperations({ registry, host: HOST, runToken: randomUUID(), guard: commandGuard({ maxOutputBytes: 4, assertCurrent() {} }) });
    const running = shell.exec("sleep 0.2; printf overflow; sleep 30", process.cwd(), { signal: controller.signal, onData: (chunk) => output.push(chunk.toString()) });
    await waitFor(() => registry.list().length === 1);
    controller.abort();
    await expect(running).rejects.toThrow(/abort/);
    expect(output).toEqual([]);
    expect(registry.list()[0]?.status).toBe("stopped");
    expect(registry.list()[0]?.activity).toBe("ended");
  }));

  test("输出超限与timeout都不flush并形成各自真实终态", async () => {
    await withGitExecutionFixture(async ({ registry }) => {
      const output: string[] = [];
      const shell = createManagedBashOperations({ registry, host: HOST, runToken: randomUUID(), guard: commandGuard({ maxOutputBytes: 4, assertCurrent() {} }) });
      await expect(shell.exec("printf overflow", process.cwd(), { onData: (chunk) => output.push(chunk.toString()) })).rejects.toThrow(/输出超过允许上限/);
      expect(output).toEqual([]);
      expect(registry.list()[0]?.status).toBe("failed");
      expect(registry.list()[0]?.exitCode).toBe(0);
    });
    await withGitExecutionFixture(async ({ registry }) => {
      const output: string[] = [];
      const shell = createManagedBashOperations({ registry, host: HOST, runToken: randomUUID(), guard: commandGuard({ assertCurrent() {} }) });
      await expect(shell.exec("printf held; sleep 30", process.cwd(), { timeout: 1, onData: (chunk) => output.push(chunk.toString()) })).rejects.toThrow(/timed out/i);
      expect(output).toEqual([]);
      expect(registry.list()[0]?.status).toBe("timed_out");
      expect(registry.list()[0]?.activity).toBe("ended");
    });
  }, 10_000);

  test("无close时即使组与后代已消失也只到uncertain并保留登记（隔离子进程内假child）", () => withGitDaemonFixtures(async () => {
    const registryUrl = pathToFileURL(fileURLToPath(new URL("../runtime/shell-registry.ts", import.meta.url))).href;
    const clockUrl = pathToFileURL(fileURLToPath(new URL("../runtime/clock.ts", import.meta.url))).href;
    const source = `
      import { EventEmitter } from "node:events";
      import { PassThrough } from "node:stream";
      import { createRequire, syncBuiltinESMExports } from "node:module";
      const require = createRequire(import.meta.url);
      const cp = require("node:child_process");
      const original = cp.spawn;
      cp.spawn = () => {
        const child = new EventEmitter();
        child.pid = 424242;
        child.exitCode = 23;
        child.signalCode = null;
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.unref = () => child;
        queueMicrotask(() => { child.emit("spawn"); child.emit("exit", 23, null); });
        return child;
      };
      syncBuiltinESMExports();
      const [registryModule, clockModule] = await Promise.all([import(${JSON.stringify(registryUrl)}), import(${JSON.stringify(clockUrl)})]);
      const ShellRegistry = registryModule.ShellRegistry ?? registryModule.default?.ShellRegistry;
      const createClock = clockModule.createClock ?? clockModule.default?.createClock;
      const clock = createClock();
      const gone = () => { const error = new Error("gone"); error.code = "ESRCH"; throw error; };
      const registry = new ShellRegistry({ clock, probes: { kill: (_pid, signal) => { if (signal === 0) gone(); }, ps: async () => [], pidStartedAt: async () => 1 } });
      const started = await registry.spawn({ taskId: "no-close", host: { kind: "main", id: "vm" }, command: "fake", mode: "wait", runToken: "run", executionGuard: { assertCurrent() {} } });
      if (!started.ok) throw new Error(started.reason);
      const stopped = await registry.stop("no-close");
      clock.stopGapWatcher();
      cp.spawn = original;
      syncBuiltinESMExports();
      console.log(JSON.stringify({ status: stopped.ok ? stopped.task.status : "error", activity: stopped.ok ? stopped.task.activity : "error", exitCode: started.task.exitCode, retained: registry.get("no-close") === started.task }));
    `;
    const result = await runJsonChild(process.cwd(), source, [], { timeoutMs: 8_000 });
    expect(result).toEqual({ status: "uncertain", activity: "uncertain", exitCode: 23, retained: true });
  }), 12_000);

  test("普通无guard Shell仍在运行中流式输出", () => withGitExecutionFixture(async ({ registry }) => {
    const output: Array<{ text: string; at: number }> = [];
    const startedAt = Date.now();
    const shell = createManagedBashOperations({ registry, host: HOST, runToken: randomUUID() });
    await shell.exec("printf ordinary; sleep 0.25", process.cwd(), {
      onData: (chunk) => output.push({ text: chunk.toString(), at: Date.now() - startedAt }),
    });
    expect(output.map((item) => item.text).join("")).toBe("ordinary");
    expect(output[0]!.at).toBeLessThan(200);
  }));
});
