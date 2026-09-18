import { uuidv7 } from "./database.ts";
import { projectBaselineForContext, UnsettledProjectMutationError } from "./project-baseline-hooks.ts";
import type { ProjectBaselineHooks } from "./project-baseline-hooks.ts";
import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import type { BashOperations, BashToolDetails, ToolDefinition, UserBashEvent as SdkUserBashEvent } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Static } from "typebox";
import type { Host, ShellRegistry, TaskRecord } from "./shell-registry.ts";
import { assertExecutionGuardCurrent } from "./execution-guard.ts";
import type { ExecutionGuard } from "./execution-guard.ts";

export const BASH_PARAMETERS = Type.Object(
  {
    command: Type.String({ minLength: 1, description: "要执行的命令" }),
    timeout: Type.Optional(Type.Number({ minimum: 1, maximum: 2147483, description: "秒，从进程启动计时" })),
    background: Type.Optional(Type.Boolean({ description: "true 时立即返回任务编号，不等待结束" })),
  },
  { additionalProperties: false },
);

type BashToolParams = Static<typeof BASH_PARAMETERS>;

interface ToolContent {
  type: "text";
  text: string;
}

interface ToolResult {
  content: ToolContent[];
  details: Record<string, unknown>;
}

function waitForOutcome(registry: ShellRegistry, taskId: string): Promise<TaskRecord> {
  const settled = (task: TaskRecord): boolean =>
    task.status === "exited" || task.status === "failed" || task.status === "stopped" || task.status === "timed_out" || task.status === "uncertain";
  return new Promise((resolve) => {
    const current = registry.get(taskId);
    if (current && settled(current)) {
      resolve(current);
      return;
    }
    const unsubscribe = registry.subscribe(taskId, (task) => {
      if (settled(task)) {
        unsubscribe();
        resolve(task);
      }
    });
  });
}

export interface BashCommandGuard {
  launch?(command: string, cwd: string): Promise<{ command: string; args: string[]; env?: NodeJS.ProcessEnv; inheritEnv?: boolean; executionGuard?: ExecutionGuard }>;
  before(): Promise<unknown>;
  after(token: unknown, outcome: unknown): Promise<string[]>;
}

export function createManagedBashOperations(input: {
  registry: ShellRegistry;
  host: Host;
  runToken: string;
  guard?: BashCommandGuard;
  /** 可信执行闭包，不进入模型 schema 或持久任务记录。 */
  mutation?: <T>(operation: () => Promise<T>) => Promise<T>;
}): BashOperations {
  const { registry, host, runToken, guard } = input;
  return {
    async exec(command, cwd, { onData, signal, timeout, env }) {
      if (signal?.aborted) throw new Error("aborted");

      let outcome: unknown;
      let launch: Awaited<ReturnType<NonNullable<BashCommandGuard["launch"]>>> | undefined;
      let completed: { exitCode: number | null; task: TaskRecord } | undefined;
      let spawnedTask: TaskRecord | undefined;
      let userAborted = false;
      let stopping: Promise<Awaited<ReturnType<ShellRegistry["stopTask"]>>> | undefined;
      const shouldStopSpawnedTask = (): boolean => {
        if (!spawnedTask) return false;
        try { return !registry.isTaskExecutionEnded(spawnedTask); }
        catch { return false; }
      };
      const onAbort = (): void => {
        userAborted = true;
        if (!spawnedTask) return;
        registry.discardGuardedOutput(spawnedTask);
        if (shouldStopSpawnedTask()) {
          stopping ??= registry.stopTask(spawnedTask);
          void stopping.catch(() => undefined);
        }
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      try {
        const guardToken = await guard?.before();
        if (signal?.aborted) throw new Error("aborted");
        let executionFailed = false;
        let executionError: unknown;
        try {
          launch = await guard?.launch?.(command, cwd);
          const executionGuard = launch?.executionGuard;
          if (executionGuard) assertExecutionGuardCurrent(executionGuard.assertCurrent);
          if (signal?.aborted) throw new Error("aborted");
          const capturedLaunch = launch;
          const execute = async (): Promise<{ exitCode: number | null; task: TaskRecord }> => {
            const taskId = uuidv7();
            try {
              if (signal?.aborted) throw new Error("aborted");
              if (executionGuard) assertExecutionGuardCurrent(executionGuard.assertCurrent);
              const spawnResult = await registry.spawn({
                taskId,
                host,
                command: capturedLaunch?.command ?? "sh",
                args: capturedLaunch?.args ?? ["-c", command],
                cwd,
                mode: "wait",
                timeoutSeconds: timeout,
                runToken,
                env: capturedLaunch?.inheritEnv === false ? capturedLaunch.env : { ...env, ...capturedLaunch?.env },
                inheritEnv: capturedLaunch?.inheritEnv,
                onOutput: (chunk) => onData(chunk),
                executionGuard,
              });
              if (!spawnResult.ok) {
                outcome = { status: "spawn_failed", reason: spawnResult.reason };
                throw new Error(spawnResult.reason);
              }

              spawnedTask = spawnResult.task;
              if (executionGuard) assertExecutionGuardCurrent(executionGuard.assertCurrent);
              if (signal?.aborted) onAbort();
              if (stopping) {
                const stopped = await stopping;
                if (!stopped.ok || stopped.task !== spawnedTask || stopped.task.activity !== "ended") {
                  throw new UnsettledProjectMutationError(stopped.ok ? "Shell 停止尚未确认" : stopped.reason);
                }
              }
              if (signal?.aborted) throw new Error("aborted");
              const task = await waitForOutcome(registry, taskId);
              if (task !== spawnedTask) throw new UnsettledProjectMutationError("Shell 结果对象已被替代");
              outcome = task;
              if (executionGuard) assertExecutionGuardCurrent(executionGuard.assertCurrent);
              if (signal?.aborted) throw new Error("aborted");
              switch (task.status) {
                case "exited": return { exitCode: registry.exitCodeFor(task), task };
                case "failed": throw new Error(task.reason ?? "Command failed");
                case "stopped": throw new Error(userAborted ? "aborted" : "Command stopped");
                case "timed_out": throw new Error(`Command timed out after ${timeout} seconds`);
                default: throw new UnsettledProjectMutationError(`无法确认命令是否已结束：${task.reason ?? ""}`);
              }
            } catch (error) {
              if (spawnedTask) registry.discardGuardedOutput(spawnedTask);
              const taskToStop = spawnedTask;
              if (taskToStop && shouldStopSpawnedTask() && !stopping) {
                stopping = registry.stopTask(taskToStop);
                void stopping.catch(() => undefined);
              }
              if (stopping) {
                try { await stopping; }
                catch { /* 原始执行错误优先，停止失败已被持有并处理。 */ }
              }
              throw error;
            }
          };
          completed = await (input.mutation ? input.mutation(execute) : execute());
          if (executionGuard) {
            assertExecutionGuardCurrent(executionGuard.assertCurrent);
            if (signal?.aborted) throw new Error("aborted");
          }
        } catch (error) {
          executionFailed = true;
          executionError = error;
        }

        let afterFailed = false;
        let afterError: unknown;
        try { await guard?.after(guardToken, outcome); }
        catch (error) { afterFailed = true; afterError = error; }

        const executionGuard = launch?.executionGuard;
        try {
          if (executionGuard) {
            assertExecutionGuardCurrent(executionGuard.assertCurrent);
            if (signal?.aborted) throw new Error("aborted");
          }
        } catch (error) {
          if (spawnedTask) registry.discardGuardedOutput(spawnedTask);
          throw error;
        }
        if (afterFailed) {
          if (spawnedTask) registry.discardGuardedOutput(spawnedTask);
          throw afterError;
        }
        if (executionFailed) {
          if (spawnedTask) registry.discardGuardedOutput(spawnedTask);
          throw executionError;
        }
        if (!completed) throw new Error("Shell 命令没有形成结果");
        if (executionGuard) {
          if (signal?.aborted) {
            registry.discardGuardedOutput(completed.task);
            throw new Error("aborted");
          }
          await registry.deliverGuardedOutput(completed.task);
          if (signal?.aborted) {
            registry.discardGuardedOutput(completed.task);
            throw new Error("aborted");
          }
          assertExecutionGuardCurrent(executionGuard.assertCurrent);
        }
        return { exitCode: executionGuard ? registry.exitCodeFor(completed.task) : completed.exitCode };
      } catch (error) {
        if (spawnedTask) registry.discardGuardedOutput(spawnedTask);
        throw error;
      } finally {
        signal?.removeEventListener("abort", onAbort);
      }
    },
  };
}

async function runBackground(
  registry: ShellRegistry,
  host: Host,
  cwd: string,
  runToken: string,
  params: BashToolParams,
  guard?: BashCommandGuard,
  signal?: AbortSignal,
  mutation?: <T>(operation: () => Promise<T>) => Promise<T>,
): Promise<ToolResult> {
  if (signal?.aborted) throw new Error("aborted");
  const taskId = uuidv7();
  const guardToken = await guard?.before();
  let guardFinished = false;
  let launch: Awaited<ReturnType<NonNullable<BashCommandGuard["launch"]>>> | undefined;
  const finishGuard = async (outcome: unknown) => {
    if (guardFinished) return;
    guardFinished = true;
    await guard?.after(guardToken, outcome);
    if (launch?.executionGuard) assertExecutionGuardCurrent(launch.executionGuard.assertCurrent);
  };
  try { launch = await guard?.launch?.(params.command, cwd); }
  catch (error) { await finishGuard({ status: "launch_failed" }); throw error; }
  if (signal?.aborted) {
    await finishGuard({ status: "aborted" });
    throw new Error("aborted");
  }
  let receipt!: (result: ToolResult) => void;
  let rejectReceipt!: (error: unknown) => void;
  const ready = new Promise<ToolResult>((resolve, reject) => { receipt = resolve; rejectReceipt = reject; });
  const execute = async () => {
    if (signal?.aborted) throw new Error("aborted");
    const spawnResult = await registry.spawn({
      taskId,
      host,
      command: launch?.command ?? "sh",
      args: launch?.args ?? ["-c", params.command],
      env: launch?.env,
      inheritEnv: launch?.inheritEnv,
      cwd,
      mode: "background",
      timeoutSeconds: params.timeout,
      runToken,
      executionGuard: launch?.executionGuard,
    });
    if (!spawnResult.ok) {
      await finishGuard({ status: "spawn_failed", reason: spawnResult.reason });
      throw new Error(spawnResult.reason);
    }

    if (signal?.aborted) {
      const stopped = await registry.stop(taskId);
      if (!stopped.ok || stopped.task.activity !== "ended") {
        try { await finishGuard(stopped); }
        finally { throw new UnsettledProjectMutationError("后台 Shell 停止尚未确认"); }
      }
      await finishGuard(stopped);
      throw new Error("aborted");
    }

    const task = spawnResult.task;
    receipt({
      content: [{ type: "text", text: formatBackgroundReceipt(task) }],
      details: { taskId: task.taskId, host: task.host, status: task.status, startedAt: task.startedAt },
    });
    const outcome = await waitForOutcome(registry, taskId);
    if (outcome.status === "uncertain") {
      try { await finishGuard(outcome); }
      finally { throw new UnsettledProjectMutationError("后台 Shell 真实结束尚不可核对"); }
    }
    await finishGuard(outcome);
  };
  // 回执与真实写入寿命分开：新请求不能中止用户已授权的后台任务，也不能提前签发 seal。
  void (mutation ? mutation(execute) : execute()).catch(async (error) => {
    try { await finishGuard({ status: "execution_failed" }); }
    finally { rejectReceipt(error); }
  }).catch(rejectReceipt);
  return ready;
}

export function formatBackgroundReceipt(task: { taskId: string; host: Host; status: string; startedAt: number | null }): string {
  return `Background shell task ${task.taskId} (${task.host.kind}:${task.host.id}) is ${task.status}.`;
}

function appendGuardViolations(result: ToolResult, violations: string[]): ToolResult {
  if (violations.length === 0) return result;
  const [first, ...rest] = result.content;
  const text = `${first?.text ?? ""}\n\n${violations.join("\n")}`;
  return { ...result, content: [{ type: "text", text }, ...rest] };
}

export function createManagedBashTool(
  input: { registry: ShellRegistry; host: Host; cwd: string; runToken: string; guard?: BashCommandGuard; baseline?: ProjectBaselineHooks },
): ToolDefinition<typeof BASH_PARAMETERS, BashToolDetails | undefined> {
  const { registry, host, cwd, runToken, guard } = input;
  // 仅用于取 name/description 等静态元数据，不用于实际执行——真正执行走每次调用各自的 operations
  const base = createBashToolDefinition(cwd, {
    operations: createManagedBashOperations({ registry, host, runToken }),
    exposeSessionEnvironment: false,
  });

  return {
    ...base,
    parameters: BASH_PARAMETERS,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const baseline = input.baseline ?? projectBaselineForContext(ctx);
      const callCwd = ctx?.cwd || cwd;
      const mutation = baseline ? <T>(operation: () => Promise<T>) => baseline.runShell(toolCallId, callCwd, operation) : undefined;
      if (params.background) return runBackground(registry, host, callCwd, runToken, params, guard, signal, mutation);

      // 违规结果绑定到本次调用自己的闭包变量：多次 execute 并发交错时互不覆盖
      let violations: string[] = [];
      const callOperations = createManagedBashOperations({
        registry,
        host,
        runToken,
        mutation,
        guard: guard && {
          launch: guard.launch,
          before: () => guard.before(),
          after: async (token, outcome) => {
            violations = await guard.after(token, outcome);
            return violations;
          },
        },
      });
      // SDK 在 aborted/超时等场景会把 operations.exec 抛出的错误重新包一层新 Error（原始错误就此丢失），
      // 这里先在到达 SDK 之前截下原始错误，好在最终抛出时把它原样接到 cause 上
      let rawError: unknown;
      const tappedOperations: BashOperations = {
        async exec(command, cwd2, options) {
          try {
            return await callOperations.exec(command, cwd2, options);
          } catch (error) {
            rawError = error;
            throw error;
          }
        },
      };
      const callBase = createBashToolDefinition(cwd, { operations: tappedOperations, exposeSessionEnvironment: false });
      try {
        const result = (await callBase.execute(toolCallId, params, signal, onUpdate, ctx)) as ToolResult;
        return appendGuardViolations(result, violations);
      } catch (error) {
        if (violations.length === 0) throw error;
        const message = error instanceof Error ? error.message : String(error);
        const cause = rawError instanceof Error ? rawError : error;
        throw new Error(`${message}\n\n${violations.join("\n")}`, { cause });
      }
    },
  };
}

export interface UserBashHandled {
  operations: BashOperations;
}

export async function handleUserBash(
  _event: Pick<SdkUserBashEvent, "command" | "cwd" | "excludeFromContext">,
  input: { registry: ShellRegistry; host: Host; runToken: string; guard?: BashCommandGuard },
): Promise<UserBashHandled> {
  return { operations: createManagedBashOperations({ registry: input.registry, host: input.host, runToken: input.runToken, guard: input.guard }) };
}
