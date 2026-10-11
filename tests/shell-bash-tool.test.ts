import { afterEach, describe, expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import { Value } from "typebox/value";
import { createClock } from "../runtime/clock.ts";
import { ShellRegistry } from "../runtime/shell-registry.ts";
import type { Host } from "../runtime/shell-registry.ts";
import { createManagedBashOperations, createManagedBashTool, formatBackgroundReceipt, handleUserBash } from "../runtime/shell-bash.ts";

const LONG_TIMEOUT = 20_000;
const HOST_MAIN: Host = { kind: "main", id: "main" };
const cwd = process.cwd();

const trackedPgids: number[] = [];

afterEach(() => {
  for (const pgid of trackedPgids.splice(0)) {
    try {
      process.kill(-pgid, "SIGKILL");
    } catch {
      // 组已消失，无需处理
    }
  }
});

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

function makeRegistry(): ShellRegistry {
  return new ShellRegistry({ clock: createClock() });
}

async function expectRejects(promise: Promise<unknown>, matcher: RegExp): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect(matcher.test((error as Error).message)).toBe(true);
    return;
  }
  throw new Error("期望抛出但未抛出");
}

async function expectRejectsWithin(promise: Promise<unknown>, matcher: RegExp, timeoutMs: number): Promise<void> {
  const outcome = await Promise.race([
    promise.then(
      () => ({ kind: "resolved" as const }),
      (error: unknown) => ({ kind: "rejected" as const, error: error as Error }),
    ),
    sleepMs(timeoutMs).then(() => ({ kind: "timeout" as const })),
  ]);
  if (outcome.kind === "timeout") throw new Error(`未在 ${timeoutMs}ms 内 settle（疑似挂死）`);
  if (outcome.kind === "resolved") throw new Error("期望抛出但 resolve 了");
  expect(matcher.test(outcome.error.message)).toBe(true);
}

describe("createManagedBashOperations - 命令执行", () => {
  test("exec 将 command 原样交给 sh -c 执行：末尾注释不破坏真实输出与退出码", async () => {
    const registry = makeRegistry();
    const operations = createManagedBashOperations({ registry, host: HOST_MAIN, runToken: randomUUID() });

    const chunks: string[] = [];
    const result = await operations.exec("echo hi # 注释", cwd, {
      onData: (chunk: Buffer) => chunks.push(chunk.toString()),
    });

    expect(chunks.join("")).toContain("hi");
    expect(result.exitCode).toBe(0);
  }, LONG_TIMEOUT);

  test("onData 在进程运行期间即收到流式数据，而非等待进程结束才一次性给出", async () => {
    const registry = makeRegistry();
    const operations = createManagedBashOperations({ registry, host: HOST_MAIN, runToken: randomUUID() });

    const events: { text: string; elapsedMs: number }[] = [];
    const start = Date.now();
    await operations.exec("echo a; sleep 0.5; echo b", cwd, {
      onData: (chunk: Buffer) => events.push({ text: chunk.toString(), elapsedMs: Date.now() - start }),
    });

    const firstAEvent = events.find((event) => event.text.includes("a"));
    expect(firstAEvent).toBeDefined();
    expect(firstAEvent?.elapsedMs).toBeLessThan(300);
  }, LONG_TIMEOUT);
});

describe("createManagedBashOperations - 中止与超时", () => {
  test("signal 已 aborted 时不启动任务，注册表无新记录", async () => {
    const registry = makeRegistry();
    const operations = createManagedBashOperations({ registry, host: HOST_MAIN, runToken: randomUUID() });
    const controller = new AbortController();
    controller.abort();

    try {
      await operations.exec("echo should-not-run", cwd, { signal: controller.signal });
    } catch {
      // 已中止，允许抛出
    }

    expect(registry.list(HOST_MAIN).length).toBe(0);
  }, LONG_TIMEOUT);

  test("执行中途 abort：任务转为 stopped 且 exec 抛出提及 abort 的错误", async () => {
    const registry = makeRegistry();
    const operations = createManagedBashOperations({ registry, host: HOST_MAIN, runToken: randomUUID() });
    const controller = new AbortController();

    const execPromise = operations.exec("sleep 5", cwd, { signal: controller.signal });
    await waitFor(() => registry.list(HOST_MAIN).length > 0, 3_000);
    const task = registry.list(HOST_MAIN)[0]!;
    trackedPgids.push(task.pgid);
    controller.abort();

    await expectRejects(execPromise, /abort/i);
    await waitFor(() => registry.get(task.taskId)?.status === "stopped", 5_000);
  }, LONG_TIMEOUT);

  test("timeout 秒数到期：任务转为 timed_out 且 exec 抛出提及 timed out 的错误", async () => {
    const registry = makeRegistry();
    const operations = createManagedBashOperations({ registry, host: HOST_MAIN, runToken: randomUUID() });

    const execPromise = operations.exec("sleep 30", cwd, { timeout: 1 });
    await waitFor(() => registry.list(HOST_MAIN).length > 0, 3_000);
    const task = registry.list(HOST_MAIN)[0]!;
    trackedPgids.push(task.pgid);

    await expectRejects(execPromise, /timed out/i);
    expect(registry.get(task.taskId)?.status).toBe("timed_out");
  }, LONG_TIMEOUT);

  test("外部 registry.stop() 结算正在等待的 exec：3 秒内抛出且消息含 stopped 或 aborted，不挂死", async () => {
    const registry = makeRegistry();
    const operations = createManagedBashOperations({ registry, host: HOST_MAIN, runToken: randomUUID() });

    const execPromise = operations.exec("sleep 30", cwd, {});
    await waitFor(() => registry.list(HOST_MAIN).length > 0, 3_000);
    const task = registry.list(HOST_MAIN)[0]!;
    trackedPgids.push(task.pgid);

    await sleepMs(200);
    await registry.stop(task.taskId);

    await expectRejectsWithin(execPromise, /Command stopped/, 3_000);
  }, LONG_TIMEOUT);

  test("外部 registry.stopHost() 结算正在等待的 exec：3 秒内抛出且消息含 stopped 或 aborted，不挂死", async () => {
    const registry = makeRegistry();
    const operations = createManagedBashOperations({ registry, host: HOST_MAIN, runToken: randomUUID() });

    const execPromise = operations.exec("sleep 30", cwd, {});
    await waitFor(() => registry.list(HOST_MAIN).length > 0, 3_000);
    const task = registry.list(HOST_MAIN)[0]!;
    trackedPgids.push(task.pgid);

    await sleepMs(200);
    await registry.stopHost(HOST_MAIN);

    await expectRejectsWithin(execPromise, /Command stopped/, 3_000);
  }, LONG_TIMEOUT);
});

describe("createManagedBashOperations - 身份不确定", () => {
  test("进程身份核对不一致（pid 复用）：exec 抛出提及无法确认的错误且 5 秒内返回", async () => {
    let callCount = 0;
    const registry = new ShellRegistry({
      clock: createClock(),
      probes: {
        pidStartedAt: async () => {
          callCount++;
          return callCount === 1 ? 1_000 : 2_000;
        },
      },
    });
    const operations = createManagedBashOperations({ registry, host: HOST_MAIN, runToken: randomUUID() });

    const execPromise = operations.exec("sleep 5", cwd, {});
    await waitFor(() => registry.list(HOST_MAIN).length > 0, 3_000);
    const task = registry.list(HOST_MAIN)[0]!;
    trackedPgids.push(task.pgid);

    await expectRejectsWithin(execPromise, /无法确认/, 5_000);
  }, LONG_TIMEOUT);
});

describe("受管理 bash 工具 - 参数 schema", () => {
  test("合法参数（含 timeout 边界值 1 与 2147483）通过校验", () => {
    const registry = makeRegistry();
    const tool = createManagedBashTool({ registry, host: HOST_MAIN, cwd, runToken: randomUUID() });

    expect(Value.Check(tool.parameters, { command: "echo hi" })).toBe(true);
    expect(Value.Check(tool.parameters, { command: "echo hi", timeout: 1 })).toBe(true);
    expect(Value.Check(tool.parameters, { command: "echo hi", timeout: 2_147_483 })).toBe(true);
    expect(Value.Check(tool.parameters, { command: "echo hi", background: true })).toBe(true);
  });

  test("额外字段、空 command、越界 timeout（0 与 2147484）均被拒绝", () => {
    const registry = makeRegistry();
    const tool = createManagedBashTool({ registry, host: HOST_MAIN, cwd, runToken: randomUUID() });

    expect(Value.Check(tool.parameters, { command: "echo hi", extra: "not-allowed" })).toBe(false);
    expect(Value.Check(tool.parameters, { command: "" })).toBe(false);
    expect(Value.Check(tool.parameters, { command: "echo hi", timeout: 0 })).toBe(false);
    expect(Value.Check(tool.parameters, { command: "echo hi", timeout: 2_147_484 })).toBe(false);
  });
});

describe("受管理 bash 工具 - 非后台执行委托底层", () => {
  test("成功命令返回内容含真实输出", async () => {
    const registry = makeRegistry();
    const tool = createManagedBashTool({ registry, host: HOST_MAIN, cwd, runToken: randomUUID() });

    const result = await tool.execute(
      randomUUID(),
      { command: "echo tool-output-ok" },
      new AbortController().signal,
      () => {},
      { cwd },
    );
    expect(result.content[0]?.text).toContain("tool-output-ok");
  }, LONG_TIMEOUT);

  test("失败命令：非 background 时返回 isError 且内容含 exited with code 3", async () => {
    const registry = makeRegistry();
    const tool = createManagedBashTool({ registry, host: HOST_MAIN, cwd, runToken: randomUUID() });

    const result = await tool.execute(randomUUID(), { command: "sleep 0.2; exit 3" }, new AbortController().signal, () => {}, { cwd });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/exited with code 3/);
  }, LONG_TIMEOUT);

  test("abort：非 background 执行中止后抛出", async () => {
    const registry = makeRegistry();
    const tool = createManagedBashTool({ registry, host: HOST_MAIN, cwd, runToken: randomUUID() });
    const controller = new AbortController();

    const execPromise = tool.execute(randomUUID(), { command: "sleep 5" }, controller.signal, () => {}, { cwd });
    await waitFor(() => registry.list(HOST_MAIN).length > 0, 3_000);
    const task = registry.list(HOST_MAIN)[0]!;
    trackedPgids.push(task.pgid);
    controller.abort();

    await expectRejects(execPromise, /abort/i);
  }, LONG_TIMEOUT);

  test("onUpdate 在执行期间至少收到一次带部分输出的流式更新", async () => {
    const registry = makeRegistry();
    const tool = createManagedBashTool({ registry, host: HOST_MAIN, cwd, runToken: randomUUID() });

    const updates: unknown[] = [];
    await tool.execute(
      randomUUID(),
      { command: "echo a; sleep 0.5; echo b" },
      new AbortController().signal,
      (update: unknown) => updates.push(update),
      { cwd },
    );

    expect(updates.length).toBeGreaterThan(0);
    expect(updates.some((update) => JSON.stringify(update).includes("a"))).toBe(true);
  }, LONG_TIMEOUT);
});

describe("受管理 bash 工具 - 后台模式", () => {
  test("background:true 时命令未结束即返回任务编号与状态，注册表中任务为 running", async () => {
    const registry = makeRegistry();
    const tool = createManagedBashTool({ registry, host: HOST_MAIN, cwd, runToken: randomUUID() });

    const start = Date.now();
    const result = await tool.execute(
      randomUUID(),
      { command: "sleep 5", background: true },
      new AbortController().signal,
      () => {},
      { cwd },
    );
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(300);

    const details = result.details as { taskId?: string; host?: { kind?: string; id?: string }; startedAt?: unknown };
    const taskId = details.taskId;
    expect(typeof taskId).toBe("string");
    const task = registry.get(taskId as string);
    expect(task?.status).toBe("running");
    if (task) trackedPgids.push(task.pgid);

    expect(result.content[0]?.text).toContain(taskId as string);
    expect(details.host).toEqual({ kind: HOST_MAIN.kind, id: HOST_MAIN.id });
    expect(result.content[0]?.text).toContain(`${HOST_MAIN.kind}:${HOST_MAIN.id}`);
    expect(typeof details.startedAt === "number" || details.startedAt === null).toBe(true);

    if (taskId) await registry.stop(taskId);
  }, LONG_TIMEOUT);

  test("formatBackgroundReceipt 按固定格式生成回执文本，含 host 的 kind:id", () => {
    const task = { taskId: randomUUID(), host: HOST_MAIN, status: "running", startedAt: Date.now() };
    const text = formatBackgroundReceipt(task);
    expect(text.startsWith("Background shell task")).toBe(true);
    expect(text.includes(task.taskId)).toBe(true);
    expect(text).toContain(`${task.host.kind}:${task.host.id}`);
    expect(text.endsWith(`is ${task.status}.`)).toBe(true);
  });

  test("登记失败（spawn 桩返回 ok:false）：execute 抛出且消息含 reason，未启动进程", async () => {
    const registry = makeRegistry();
    const failureReason = "模拟注册失败";
    registry.spawn = async () => ({ ok: false, reason: failureReason });
    const tool = createManagedBashTool({ registry, host: HOST_MAIN, cwd, runToken: randomUUID() });

    let thrown: Error | undefined;
    try {
      await tool.execute(
        randomUUID(),
        { command: "echo should-not-run", background: true },
        new AbortController().signal,
        () => {},
        { cwd },
      );
    } catch (error) {
      thrown = error as Error;
    }

    expect(thrown).toBeDefined();
    expect(thrown?.message).toContain(failureReason);
    expect(registry.list(HOST_MAIN).length).toBe(0);
  }, LONG_TIMEOUT);
});

describe("受管理 bash 工具 - runToken 注入", () => {
  test("后台任务使用注入的 runToken：新注册表可通过 adoptOrphans 认领", async () => {
    const runToken = randomUUID();
    const registryA = makeRegistry();
    const tool = createManagedBashTool({ registry: registryA, host: HOST_MAIN, cwd, runToken });

    const idle = `${JSON.stringify(process.execPath)} -e 'setTimeout(() => {}, 30000)'`;
    const first = await tool.execute(randomUUID(), { command: idle, background: true }, new AbortController().signal, () => {}, { cwd });
    const second = await tool.execute(randomUUID(), { command: idle, background: true }, new AbortController().signal, () => {}, { cwd });
    for (const receipt of [first, second]) {
      const taskId = (receipt.details as { taskId?: string }).taskId;
      const task = taskId ? registryA.get(taskId) : undefined;
      if (task) trackedPgids.push(task.pgid);
    }
    await sleepMs(300);

    const owner: Host = { kind: "role", id: "adopt-owner" };
    const registryB = makeRegistry();
    const adopted = await registryB.adoptOrphans({ runToken, owner });

    expect(adopted.ok).toBe(true);
    if (!adopted.ok) return;
    expect(adopted.tasks.length).toBe(2);
    for (const task of adopted.tasks) trackedPgids.push(task.pgid);
  }, LONG_TIMEOUT);
});

describe("受管理 bash 工具 - 权限与环境边界", () => {
  test("执行命令不改变 process.cwd() 与 process.env", async () => {
    const registry = makeRegistry();
    const tool = createManagedBashTool({ registry, host: HOST_MAIN, cwd, runToken: randomUUID() });
    const cwdBefore = process.cwd();
    delete process.env.PI_SHELL_BASH_TEST_LEAK;

    await tool.execute(
      randomUUID(),
      { command: "cd /tmp; export PI_SHELL_BASH_TEST_LEAK=leaked" },
      new AbortController().signal,
      () => {},
      { cwd },
    );

    expect(process.cwd()).toBe(cwdBefore);
    expect(process.env.PI_SHELL_BASH_TEST_LEAK).toBeUndefined();
  }, LONG_TIMEOUT);
});

describe("handleUserBash - 手动入口委托 SDK operations", () => {
  test("返回 { operations }，用 operations.exec 执行 `!` 命令得到真实输出", async () => {
    const registry = makeRegistry();

    const result = await handleUserBash(
      { command: "echo hi", cwd, excludeFromContext: false },
      { registry, host: HOST_MAIN, runToken: randomUUID() },
    );

    expect(typeof result.operations?.exec).toBe("function");

    const chunks: string[] = [];
    const execResult = await result.operations.exec("echo hi-from-bang", cwd, {
      onData: (chunk: Buffer) => chunks.push(chunk.toString()),
    });

    expect(chunks.join("")).toContain("hi-from-bang");
    expect(execResult.exitCode).toBe(0);
  }, LONG_TIMEOUT);
});

test.each([false, true])("启动边界取消不会留下 Shell：background=%s", async (background) => {
  const registry = makeRegistry();
  const abort = new AbortController();
  const original = registry.spawn.bind(registry);
  registry.spawn = async (input) => {
    abort.abort();
    const result = await original(input);
    if (result.ok) trackedPgids.push(result.task.pgid);
    return result;
  };
  const tool = createManagedBashTool({ registry, host: HOST_MAIN, cwd, runToken: randomUUID() });
  await expectRejectsWithin(tool.execute("cancel-start", { command: "sleep 60", background }, abort.signal), /aborted/, 3000);
  expect(registry.list()).toHaveLength(1);
  expect(registry.list()[0]!.activity).toBe("ended");
  expect(() => process.kill(registry.list()[0]!.pid, 0)).toThrow();
}, 5000);
