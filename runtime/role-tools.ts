import { toolActionsForRole } from "./core-permissions.ts";
import type { CoreRole, CoreTool } from "./core-permissions.ts";
import { EXPLORE_HOST_TOOLS } from "./explore-capabilities.ts";
import type { AgentRole } from "./roles.ts";

export const CORE_TOOL_PREFIX = "pi_company_";

const READ_TOOLS = ["read", "grep", "find", "ls"] as const;

export const ROLE_HOST_TOOLS: Readonly<Record<AgentRole, readonly string[]>> = Object.freeze({
  pm: READ_TOOLS,
  explore: EXPLORE_HOST_TOOLS.local,
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
