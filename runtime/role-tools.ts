import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import type { CoreTool } from "./core-permissions.ts";
import type { AgentRole } from "./roles.ts";
import { toolFailure, toolStep } from "./tool-failure.ts";

export const CORE_TOOL_PREFIX = "one_company_";

const READ_TOOLS = ["read", "grep", "find", "ls"] as const;

export const ROLE_HOST_TOOLS: Readonly<Record<AgentRole, readonly string[]>> = Object.freeze({
  pm: READ_TOOLS,
  explore: READ_TOOLS,
  worker: READ_TOOLS,
  reviewer: READ_TOOLS,
  qa: [],
  prototype: READ_TOOLS,
});

/** QA 验收界面任务时多给的宿主工具：只有 read，且读取范围限定为用户已通过的原型文件。 */
export const QA_PROTOTYPE_HOST_TOOLS: readonly string[] = Object.freeze(["read"]);

export function coreToolName(tool: CoreTool): string {
  return `${CORE_TOOL_PREFIX}${tool}`;
}

export interface CoreToolRuntime {
  execute(input: unknown, signal?: AbortSignal): unknown;
  dispose(): void;
}

/** 把核心工具工厂的执行体包装成宿主工具；参数 schema 即工厂导出的固定白名单。 */
export function toPiTool(tool: CoreTool, description: string, parameters: TSchema, runtime: CoreToolRuntime): ToolDefinition {
  return {
    name: coreToolName(tool),
    label: tool,
    description,
    parameters,
    executionMode: "sequential",
    async execute(_toolCallId, params, signal) {
      let result: unknown;
      try { result = await runtime.execute(params, signal); }
      catch (error) { throw toolFailure(toolStep(coreToolName(tool), params), error); }
      return { content: [{ type: "text", text: JSON.stringify(result ?? null) }], details: {} };
    },
  } as ToolDefinition;
}
