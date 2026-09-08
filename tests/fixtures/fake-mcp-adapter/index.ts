import { Type, type Static } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface FakeMcpServerConfig {
  command?: string;
  args?: string[];
  url?: string;
  socket?: string;
  disabled?: boolean;
  directTools?: boolean | string[];
  lifecycle?: "keep-alive" | "lazy" | "lazy-keep-alive" | "eager";
}

export interface FakeMcpConfig {
  mcpServers?: Record<string, FakeMcpServerConfig>;
  settings?: Record<string, unknown>;
}

export interface CreateMcpAdapterOptions {
  config?: FakeMcpConfig;
  configPath?: string;
}

export interface FakeMcpCall {
  server: string | undefined;
  tool: string | undefined;
  mode: "search" | "describe" | "call";
}

export const calls: FakeMcpCall[] = [];

export function resetCalls(): void {
  calls.length = 0;
}

const mcpToolParams = Type.Object({
  tool: Type.Optional(Type.String()),
  args: Type.Optional(Type.Unknown()),
  describe: Type.Optional(Type.String()),
  search: Type.Optional(Type.String()),
  server: Type.Optional(Type.String()),
});

export function createMcpAdapter(options: CreateMcpAdapterOptions = {}) {
  const servers = options.config?.mcpServers ?? {};
  if (options.config?.settings?.__fixtureAsyncReject === true) {
    return async (_pi: ExtensionAPI) => {
      throw new Error("fixture async reject");
    };
  }
  return (pi: ExtensionAPI) => {
    pi.registerTool({
      name: "mcp",
      label: "MCP",
      description: "假 MCP 网关工具",
      parameters: mcpToolParams,
      async execute(_toolCallId: string, params: Static<typeof mcpToolParams>) {
        const mode: FakeMcpCall["mode"] =
          params.search !== undefined ? "search" : params.describe !== undefined ? "describe" : "call";
        calls.push({ server: params.server, tool: params.tool, mode });
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ servers: Object.keys(servers) }) }],
          details: undefined,
        };
      },
    });
  };
}

export default createMcpAdapter();
