import { randomUUID } from "node:crypto";
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

export function createManagedBashOperations(input: { registry: ShellRegistry; host: Host; runToken: string }): BashOperations {
  const { registry, host, runToken } = input;
  return {
    async exec(command, cwd, { onData, signal, timeout, env }) {
      if (signal?.aborted) throw new Error("aborted");

      const taskId = randomUUID();
      let userAborted = false;
      const onAbort = (): void => {
        userAborted = true;
        void registry.stop(taskId);
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      try {
        const spawnResult = await registry.spawn({
          taskId,
          host,
          command: "sh",
          args: ["-c", command],
          cwd,
          mode: "wait",
          timeoutSeconds: timeout,
          runToken,
          env,
          onOutput: (chunk) => onData(chunk),
        });
        if (!spawnResult.ok) throw new Error(spawnResult.reason);

        const task = await waitForOutcome(registry, taskId);
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
): Promise<ToolResult> {
  const taskId = randomUUID();
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
  const operations = createManagedBashOperations({ registry, host, runToken });
  const base = createBashToolDefinition(cwd, { operations, exposeSessionEnvironment: false });

  return {
    ...base,
    parameters: BASH_PARAMETERS,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      if (params.background) return runBackground(registry, host, ctx?.cwd || cwd, runToken, params);
      return base.execute(toolCallId, params, signal, onUpdate, ctx);
    },
  };
}

export interface UserBashHandled {
  operations: BashOperations;
}

export async function handleUserBash(
  event: Pick<SdkUserBashEvent, "command" | "cwd" | "excludeFromContext">,
  input: { registry: ShellRegistry; host: Host; runToken: string },
): Promise<UserBashHandled> {
  return { operations: createManagedBashOperations({ registry: input.registry, host: input.host, runToken: input.runToken }) };
}
