import { uuidv7 } from "./database.ts";
import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import type { BashOperations, BashToolDetails, ToolDefinition, UserBashEvent as SdkUserBashEvent } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Static } from "typebox";
import type { Host, ShellRegistry, TaskRecord } from "./shell-registry.ts";

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
    task.status === "exited" || task.status === "stopped" || task.status === "timed_out" || task.status === "uncertain";
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
  launch?(command: string, cwd: string): Promise<{ command: string; args: string[]; env?: NodeJS.ProcessEnv; inheritEnv?: boolean }>;
  before(): Promise<unknown>;
  after(token: unknown, outcome: unknown): Promise<string[]>;
}

export function createManagedBashOperations(input: {
  registry: ShellRegistry;
  host: Host;
  runToken: string;
  guard?: BashCommandGuard;
}): BashOperations {
  const { registry, host, runToken, guard } = input;
  return {
    async exec(command, cwd, { onData, signal, timeout, env }) {
      if (signal?.aborted) throw new Error("aborted");

      // guard.before 必须先于注册中止监听器执行：guard 拒绝时命令不能留下监听器或占用 taskId
      const guardToken = await guard?.before();
      const launch = await guard?.launch?.(command, cwd);

      const taskId = uuidv7();
      let userAborted = false;
      let spawned = false;
      let stopping: Promise<unknown> | undefined;
      const onAbort = (): void => {
        userAborted = true;
        if (spawned) stopping ??= registry.stop(taskId);
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      let outcome: unknown;
      try {
        if (signal?.aborted) throw new Error("aborted");
        const spawnResult = await registry.spawn({
          taskId,
          host,
          command: launch?.command ?? "sh",
          args: launch?.args ?? ["-c", command],
          cwd,
          mode: "wait",
          timeoutSeconds: timeout,
          runToken,
          env: launch?.inheritEnv === false ? launch.env : { ...env, ...launch?.env },
          inheritEnv: launch?.inheritEnv,
          onOutput: (chunk) => onData(chunk),
        });
        if (!spawnResult.ok) {
          outcome = { status: "spawn_failed", reason: spawnResult.reason };
          throw new Error(spawnResult.reason);
        }

        spawned = true;
        if (signal?.aborted) { onAbort(); await stopping; }
        const task = await waitForOutcome(registry, taskId);
        outcome = task;
        switch (task.status) {
          case "exited":
            return { exitCode: task.exitCode };
          case "stopped":
            throw new Error(userAborted ? "aborted" : "Command stopped");
          case "timed_out":
            throw new Error(`Command timed out after ${timeout} seconds`);
          default:
            throw new Error(`无法确认命令是否已结束：${task.reason ?? ""}`);
        }
      } finally {
        signal?.removeEventListener("abort", onAbort);
        await guard?.after(guardToken, outcome);
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
): Promise<ToolResult> {
  if (signal?.aborted) throw new Error("aborted");
  const taskId = uuidv7();
  const guardToken = await guard?.before();
  const launch = await guard?.launch?.(params.command, cwd);
  if (signal?.aborted) {
    await guard?.after(guardToken, { status: "aborted" });
    throw new Error("aborted");
  }
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
  });
  if (!spawnResult.ok) {
    await guard?.after(guardToken, { status: "spawn_failed", reason: spawnResult.reason });
    throw new Error(spawnResult.reason);
  }

  if (signal?.aborted) {
    const stopped = await registry.stop(taskId);
    await guard?.after(guardToken, stopped);
    throw new Error("aborted");
  }

  // 后台任务此时尚未结束：违规核对要等任务真正到达终态才有意义，不能在这里同步调用；
  // 回执已经返回给调用方，guard.after 出错时无人能再接住，只能吞掉避免 unhandledRejection
  if (guard) void waitForOutcome(registry, taskId).then((task) => guard.after(guardToken, task)).catch(() => {});

  const task = spawnResult.task;
  return {
    content: [{ type: "text", text: formatBackgroundReceipt(task) }],
    details: { taskId: task.taskId, host: task.host, status: task.status, startedAt: task.startedAt },
  };
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
  input: { registry: ShellRegistry; host: Host; cwd: string; runToken: string; guard?: BashCommandGuard },
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
      if (params.background) return runBackground(registry, host, ctx?.cwd || cwd, runToken, params, guard, signal);

      // 违规结果绑定到本次调用自己的闭包变量：多次 execute 并发交错时互不覆盖
      let violations: string[] = [];
      const callOperations = createManagedBashOperations({
        registry,
        host,
        runToken,
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
  event: Pick<SdkUserBashEvent, "command" | "cwd" | "excludeFromContext">,
  input: { registry: ShellRegistry; host: Host; runToken: string; guard?: BashCommandGuard },
): Promise<UserBashHandled> {
  return { operations: createManagedBashOperations({ registry: input.registry, host: input.host, runToken: input.runToken, guard: input.guard }) };
}
