import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { toolActionsForRole } from "./core-permissions.ts";
import type { CoreRole, CoreTool } from "./core-permissions.ts";
import type { AgentRole } from "./roles.ts";
import { toolFailure, toolStep } from "./tool-failure.ts";

export const CORE_TOOL_PREFIX = "pi_company_";

const READ_TOOLS = ["read", "grep", "find", "ls"] as const;

export const ROLE_HOST_TOOLS: Readonly<Record<AgentRole, readonly string[]>> = Object.freeze({
  pm: READ_TOOLS,
  explore: READ_TOOLS,
  worker: READ_TOOLS,
  reviewer: READ_TOOLS,
  qa: [],
});

export function coreToolName(tool: CoreTool): string {
  return `${CORE_TOOL_PREFIX}${tool}`;
}

export function coreToolsForRole(role: CoreRole): CoreTool[] {
  return Object.keys(toolActionsForRole(role)) as CoreTool[];
}

export interface CoreToolRuntime {
  execute(input: unknown): unknown;
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
    async execute(_toolCallId, params) {
      let result: unknown;
      try { result = await runtime.execute(params); }
      catch (error) { throw toolFailure(toolStep(coreToolName(tool), params), error); }
      return { content: [{ type: "text", text: JSON.stringify(result ?? null) }], details: {} };
    },
  } as ToolDefinition;
}
