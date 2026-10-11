import { readFileSync } from "node:fs";
import { createCodemodeExtension, createMcpExtension, createToolSearchExtension } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionFactory, McpServerConfig } from "@earendil-works/pi-coding-agent";

export interface McpLoadResult {
  loaded: string[];
  missing: string[];
  failures: string[];
}

/** 角色会话用的 pi 自带 MCP、codemode 与工具搜索；服务只来自定义点名后注册的那些。 */
export function mcpExtensionFactories(): ExtensionFactory[] {
  return [
    createCodemodeExtension({ models: false }),
    createToolSearchExtension(),
    // 守护进程没有界面：不读 mcp.json 全量配置，也不弹浏览器做 OAuth 登录
    createMcpExtension({ loadConfig: () => ({ servers: [], errors: [] }), openUrl: () => {} }),
  ];
}

export function registerMcpServers(pi: Pick<ExtensionAPI, "registerMcpServer">, configPath: string, selected: string[]): McpLoadResult {
  const result: McpLoadResult = { loaded: [], missing: [], failures: [] };
  if (selected.length === 0) return result;
  let servers: Record<string, unknown>;
  try {
    servers = (JSON.parse(readFileSync(configPath, "utf8")) as { mcpServers?: Record<string, unknown> }).mcpServers ?? {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...result, missing: [...selected] };
    return { ...result, failures: [`读取 ${configPath} 失败：${(error as Error).message}`] };
  }
  for (const name of selected) {
    const entry = servers[name];
    if (typeof entry !== "object" || entry === null || (entry as { enabled?: unknown }).enabled === false) {
      result.missing.push(name);
      continue;
    }
    try {
      pi.registerMcpServer(name, entry as McpServerConfig);
      result.loaded.push(name);
    } catch (error) {
      result.failures.push(`${name}：${(error as Error).message}`);
    }
  }
  return result;
}

export function describeMcpStatus(input: McpLoadResult): string {
  const parts: string[] = [];
  if (input.loaded.length > 0) parts.push(`已装载 ${input.loaded.join("、")}`);
  if (input.missing.length > 0) parts.push(`缺失 ${input.missing.join("、")}`);
  if (input.failures.length > 0) parts.push(`装载失败 ${input.failures.join("；")}`);
  if (parts.length === 0) return "未装载任何 MCP 服务";
  const status = parts.join("；");
  return input.loaded.length > 0 ? `${status}。工具名形如 mcp__<服务名>__<工具名>，按系统提示里 MCP 服务一节的说明调用` : status;
}
