import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { join } from "node:path";
import { promisify } from "node:util";
import { runInThisContext } from "node:vm";
import { createClock } from "../../runtime/clock.ts";
import { withDatabase } from "../../runtime/database.ts";
import { assertExecutionGuardCurrent, guardedOutputLimit } from "../../runtime/execution-guard.ts";
import type { ShellRegistry, ShellRegistryOptions } from "../../runtime/shell-registry.ts";
import { captureFixtureScope, createOwnedSpawner, ownedTempRoot, withGitDaemonFixtures } from "./git-daemon-fixture.ts";

export interface GitExecutionFixture {
  root: string;
  registry: ShellRegistry;
  waitFor(predicate: () => boolean, timeoutMs?: number): Promise<void>;
}

/** 执行当前registry函数体，仅把spawn依赖换为永久绑定本scope的真实进程工厂。 */
async function registryConstructor(spawn: ReturnType<typeof createOwnedSpawner>): Promise<new (options: ShellRegistryOptions) => ShellRegistry> {
  const path = new URL("../../runtime/shell-registry.ts", import.meta.url);
  const text = await readFile(path, "utf8");
  const source = stripTypeScriptTypes(text).replace(/^import .*;\n/gmu, "").replace(/^export /gmu, "");
  const factory = runInThisContext(`(function(dependencies) { "use strict";
    const { execFile, spawn, readFile, promisify, withDatabase, assertExecutionGuardCurrent, guardedOutputLimit } = dependencies;
    ${source}
    return ShellRegistry;
  })`, { filename: path.pathname });
  return factory({ execFile, spawn, readFile, promisify, withDatabase, assertExecutionGuardCurrent, guardedOutputLimit });
}

export async function withGitExecutionFixture<T>(
  run: (fixture: GitExecutionFixture) => Promise<T>,
  options: { probes?: ShellRegistryOptions["probes"]; databaseName?: string } = {},
): Promise<T> {
  return withGitDaemonFixtures(async () => {
    const scope = captureFixtureScope();
    const root = await ownedTempRoot("git-execution-fixture-");
    const Registry = await scope.run(() => registryConstructor(createOwnedSpawner()));
    scope.assertOpen();
    const clock = createClock();
    const registry = new Registry({ clock, probes: options.probes,
      database: options.databaseName ? join(root, options.databaseName) : undefined });
    const pending = new Set<Promise<unknown>>();
    const raw = registry as unknown as Record<string, (...args: unknown[]) => unknown>;
    const nativeStop = registry.stopTask.bind(registry);
    const nativeStopMonitor = raw.stopMonitor!.bind(registry);
    const nativeClearTimeout = raw.clearTimeoutTimer!.bind(registry);
    const closedError = () => new Error("Git执行fixture已关闭");

    const track = (name: string, cleanupAllowed: boolean) => {
      const original = raw[name];
      if (typeof original !== "function") throw new Error(`registry缺少受跟踪方法: ${name}`);
      raw[name] = (...args: unknown[]) => {
        if (scope.isClosed() && !cleanupAllowed) throw closedError();
        const execute = async () => original.apply(registry, args);
        const operation = scope.isClosed() ? scope.cleanupOperation(execute) : scope.run(execute);
        pending.add(operation);
        void operation.then(() => pending.delete(operation), () => pending.delete(operation));
        return operation;
      };
    };
    for (const name of ["spawn", "adoptOrphans", "writeTaskRecord"]) track(name, false);
    for (const name of ["inspect", "stop", "stopTask", "stopWithFinalStatus", "deleteTaskRecord"]) track(name, true);
    for (const name of ["startMonitor", "scheduleTimeout"]) {
      const original = raw[name]!;
      raw[name] = (...args: unknown[]) => { if (!scope.isClosed()) return original.apply(registry, args); };
    }

    scope.onClosing(async () => {
      // 先停止新tick，已开始的inspect/登记/停止仍在scope.pending内结算。
      for (const task of registry.list()) { nativeStopMonitor(task.taskId); nativeClearTimeout(task.taskId); }
      const results = await Promise.allSettled(registry.list().map((task) => nativeStop(task)));
      const errors = results.flatMap((result) => {
        if (result.status === "rejected") return [result.reason];
        if (!result.value.ok) return [new Error(result.value.reason)];
        try {
          return registry.isTaskExecutionEnded(result.value.task) ? [] : [new Error(`任务收尾未确认: ${result.value.task.taskId}`)];
        } catch (error) { return [error]; }
      });
      for (const error of errors) scope.preserve(error);
      await Promise.allSettled([...pending]);
      if (!errors.length && !pending.size && registry.list().every((task) => registry.isTaskExecutionEnded(task))) clock.stopGapWatcher();
      else scope.preserve(new Error("registry在途操作或结束状态未确认，保留观察与目录"));
      if (errors.length) throw new AggregateError(errors, "Git执行fixture停止未确认");
    });

    return run({ root, registry, waitFor(predicate, timeoutMs = 5_000) {
      return scope.run(async () => {
        const deadline = performance.now() + timeoutMs;
        while (true) {
          scope.assertOpen();
          if (predicate()) return;
          if (performance.now() >= deadline) throw new Error(`等待条件超时: ${timeoutMs}ms`);
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      });
    } });
  });
}
