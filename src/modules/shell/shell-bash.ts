import { uuidv7 } from "../../core/storage/database.ts";
import type { FailureAdvice } from "../../core/exec/tool-failure.ts";
import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import type { BashOperations, BashToolDetails, ToolDefinition, UserBashEvent as SdkUserBashEvent } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Static } from "typebox";
import type { Host, ShellRegistry, TaskRecord } from "../../core/host/shell-registry.ts";

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

export class UnsettledShellError extends Error {
  get advice(): FailureAdvice { return { why: this.message, next: "不要重复执行同一命令；请用户用 /one:ps 查看它是否还在运行，确认结束后再继续" }; }
}

export function createManagedBashOperations(input: {
  registry: ShellRegistry;
  host: Host;
  runToken: string;
}): BashOperations {
  const { registry, host, runToken } = input;
  return {
    async exec(command, cwd, { onData, signal, timeout, env }) {
      if (signal?.aborted) throw new Error("aborted");

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
        if (shouldStopSpawnedTask()) {
          stopping ??= registry.stopTask(spawnedTask);
          void stopping.catch(() => undefined);
        }
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      try {
        const taskId = uuidv7();
        try {
          if (signal?.aborted) throw new Error("aborted");
          const spawnResult = await registry.spawn({
            taskId,
            host,
            command: "sh",
            args: ["-c", command],
            cwd,
            mode: "wait",
            timeoutSeconds: timeout,
            runToken,
            env: { ...env },
            onOutput: (chunk) => onData(chunk),
          });
          if (!spawnResult.ok) throw new Error(spawnResult.reason);

          spawnedTask = spawnResult.task;
          if (signal?.aborted) onAbort();
          if (stopping) {
            const stopped = await stopping;
            if (!stopped.ok || stopped.task !== spawnedTask || stopped.task.activity !== "ended") {
              throw new UnsettledShellError(stopped.ok ? "Shell 停止尚未确认" : stopped.reason);
            }
          }
          if (signal?.aborted) throw new Error("aborted");
          const task = await waitForOutcome(registry, taskId);
          if (task !== spawnedTask) throw new UnsettledShellError("Shell 结果对象已被替代");
          if (signal?.aborted) throw new Error("aborted");
          switch (task.status) {
            case "exited": return { exitCode: registry.exitCodeFor(task) };
            case "failed": throw new Error(task.reason ?? "Command failed");
            case "stopped": throw new Error(userAborted ? "aborted" : "Command stopped");
            case "timed_out": throw new Error(`Command timed out after ${timeout} seconds`);
            default: throw new UnsettledShellError(`无法确认命令是否已结束：${task.reason ?? ""}`);
          }
        } catch (error) {
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
  signal?: AbortSignal,
): Promise<ToolResult> {
  if (signal?.aborted) throw new Error("aborted");
  const taskId = uuidv7();
  const spawnResult = await registry.spawn({
    taskId,
    host,
    command: "sh",
    args: ["-c", params.command],
    cwd,
    mode: "background",
    timeoutSeconds: params.timeout,
    runToken,
  });
  if (!spawnResult.ok) throw new Error(spawnResult.reason);

  if (signal?.aborted) {
    const stopped = await registry.stop(taskId);
    if (!stopped.ok || stopped.task.activity !== "ended") throw new UnsettledShellError("后台 Shell 停止尚未确认");
    throw new Error("aborted");
  }

  const task = spawnResult.task;
  return {
    content: [{ type: "text", text: formatBackgroundReceipt(task) }],
    details: { taskId: task.taskId, host: task.host, status: task.status, startedAt: task.startedAt },
  };
}

export function formatBackgroundReceipt(task: { taskId: string; host: Host; status: string; startedAt: number | null }): string {
  return `Background shell task ${task.taskId} (${task.host.kind}:${task.host.id}) is ${task.status}.`;
}

export function createManagedBashTool(
  input: { registry: ShellRegistry; host: Host; cwd: string; runToken: string },
): ToolDefinition<typeof BASH_PARAMETERS, BashToolDetails | undefined> {
  const { registry, host, cwd, runToken } = input;
  const base = createBashToolDefinition(cwd, {
    operations: createManagedBashOperations({ registry, host, runToken }),
    exposeSessionEnvironment: false,
  });

  return {
    ...base,
    parameters: BASH_PARAMETERS,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      if (params.background) return runBackground(registry, host, ctx?.cwd || cwd, runToken, params, signal);
      return base.execute(toolCallId, params, signal, onUpdate, ctx);
    },
  };
}

export interface UserBashHandled {
  operations: BashOperations;
}

export async function handleUserBash(
  _event: Pick<SdkUserBashEvent, "command" | "cwd" | "excludeFromContext">,
  input: { registry: ShellRegistry; host: Host; runToken: string },
): Promise<UserBashHandled> {
  return { operations: createManagedBashOperations({ registry: input.registry, host: input.host, runToken: input.runToken }) };
}
