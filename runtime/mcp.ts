import { readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, sep } from "node:path";

export interface DetectMcpAdapterInput {
  sourcePaths: string[];
  argv: string[];
  agentDir: string;
}

export type DetectMcpAdapterResult =
  | { installed: false }
  | { installed: true; packageDir: string; entryPath: string; configPath: string };

export interface McpServerEntry {
  command?: string;
  args?: string[];
  url?: string;
  socket?: string;
  disabled?: boolean;
  lifecycle?: string;
  directTools?: boolean | string[];
  readOnlyTools?: string[];
}

export interface McpConfig {
  mcpServers?: Record<string, McpServerEntry>;
  settings?: Record<string, unknown>;
}

export interface McpServerInfo {
  name: string;
  disabled: boolean;
  transport: "stdio" | "http" | "socket";
}

export type ListMcpServersResult = { ok: true; servers: McpServerInfo[] } | { ok: false; reason: string };

export interface FilterMcpConfigResult {
  config: McpConfig;
  missing: string[];
}

export interface McpCallRequest {
  mode: "search" | "describe" | "call";
  server?: string;
  tool?: string;
  args?: unknown;
}

export interface CheckMcpCallInput {
  allowedServers: string[];
  readOnlyTools?: string[];
  request: McpCallRequest;
}

export type CheckMcpCallResult = { allowed: true } | { allowed: false; reason: string };

export interface McpStatusInput {
  loaded: string[];
  missing: string[];
  failure?: string;
}

export interface LoadMcpForRoleInput {
  pi: unknown;
  entryPath: string;
  config: McpConfig;
  selected?: string[];
  packageDir: string;
  importer?: (path: string) => Promise<unknown>;
}

export interface LoadMcpForRoleResult {
  loaded: string[];
  missing: string[];
  failure?: string;
}

function isWithin(path: string, base: string): boolean {
  if (path === base) return true;
  const prefix = base.endsWith(sep) ? base : base + sep;
  return path.startsWith(prefix);
}

function isStrictAncestor(dir: string, of: string): boolean {
  if (dir === of) return false;
  return isWithin(of, dir);
}

interface FoundPackage {
  dir: string;
  pkg: Record<string, unknown>;
}

function findPackageDir(startPath: string, homeDir: string): FoundPackage | undefined {
  let dir = startPath;
  while (true) {
    if (isStrictAncestor(dir, homeDir)) return undefined;
    try {
      const raw = readFileSync(join(dir, "package.json"), "utf8");
      const pkg = JSON.parse(raw) as Record<string, unknown>;
      if (pkg.name === "pi-mcp-adapter") return { dir, pkg };
    } catch {
      // 目录不存在或非包目录，继续向上查找
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function parseConfigArg(argv: string[]): string | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--mcp-config") {
      const value = argv[index + 1];
      if (value !== undefined && value !== "" && !value.startsWith("--")) return value;
      return undefined;
    }
    if (arg?.startsWith("--mcp-config=")) {
      const value = arg.slice("--mcp-config=".length);
      return value !== "" ? value : undefined;
    }
  }
  return undefined;
}

export function detectMcpAdapter(input: DetectMcpAdapterInput): DetectMcpAdapterResult {
  const homeDir = dirname(input.agentDir);
  let found: FoundPackage | undefined;
  for (const sourcePath of input.sourcePaths) {
    found = findPackageDir(sourcePath, homeDir);
    if (found) break;
  }
  if (!found) return { installed: false };

  const main = typeof found.pkg.main === "string" ? found.pkg.main : "index.ts";
  const entryPath = join(found.dir, main);
  if (!isWithin(entryPath, found.dir)) return { installed: false };

  const configPath = parseConfigArg(input.argv) ?? join(input.agentDir, "mcp.json");
  return { installed: true, packageDir: found.dir, entryPath, configPath };
}

export function listMcpServers(configPath: string): ListMcpServersResult {
  let raw: string;
  try {
    raw = readFileSync(configPath, "utf8");
  } catch (error) {
    return { ok: false, reason: `无法读取配置文件: ${(error as Error).message}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { ok: false, reason: `配置文件不是合法 JSON: ${(error as Error).message}` };
  }

  const mcpServers = (parsed as { mcpServers?: unknown }).mcpServers;
  if (mcpServers === null || typeof mcpServers !== "object" || Array.isArray(mcpServers)) {
    return { ok: false, reason: "配置文件缺少 mcpServers 对象" };
  }

  const entries = Object.entries(mcpServers as Record<string, unknown>);
  for (const [name, server] of entries) {
    if (server === null || typeof server !== "object" || Array.isArray(server)) {
      return { ok: false, reason: `服务 ${name} 的配置不是对象` };
    }
  }

  const servers: McpServerInfo[] = entries.map(([name, server]) => {
    const entry = server as McpServerEntry;
    return {
      name,
      disabled: entry.disabled === true,
      transport: entry.socket !== undefined ? "socket" : entry.url !== undefined ? "http" : "stdio",
    };
  });
  return { ok: true, servers };
}

export function filterMcpConfig(fullConfig: McpConfig, selected: string[]): FilterMcpConfigResult {
  const servers = fullConfig.mcpServers ?? {};
  const mcpServers: Record<string, McpServerEntry> = {};
  const missing: string[] = [];

  for (const name of selected) {
    const server = servers[name];
    if (!server || server.disabled === true) {
      missing.push(name);
      continue;
    }
    mcpServers[name] = { ...structuredClone(server), lifecycle: "lazy", directTools: false };
  }

  const settings = { ...structuredClone(fullConfig.settings ?? {}), debug: false, autoAuth: false };
  return { config: { mcpServers, settings }, missing };
}

function inferServerFromTool(tool: string, knownServers: string[]): string | undefined {
  const matched = knownServers
    .filter((server) => tool.startsWith(`${server}__`) || tool.startsWith(`${server}_`))
    .sort((a, b) => b.length - a.length)[0];
  if (matched) return matched;
  const doubleIndex = tool.indexOf("__");
  if (doubleIndex > 0) return tool.slice(0, doubleIndex);
  const singleIndex = tool.indexOf("_");
  if (singleIndex > 0) return tool.slice(0, singleIndex);
  return undefined;
}

export function checkMcpCall(input: CheckMcpCallInput): CheckMcpCallResult {
  const inferredServer = input.request.tool ? inferServerFromTool(input.request.tool, input.allowedServers) : undefined;
  if (input.request.tool && inferredServer === undefined) {
    return { allowed: false, reason: `无法从工具名 ${input.request.tool} 推断所属服务` };
  }
  if (input.request.server && inferredServer && input.request.server !== inferredServer) {
    return {
      allowed: false,
      reason: `请求 server(${input.request.server}) 与 tool 前缀推断出的服务(${inferredServer}) 不一致`,
    };
  }

  const server = input.request.server ?? inferredServer;
  if (!server || !input.allowedServers.includes(server)) {
    return { allowed: false, reason: `服务 ${server ?? "未知"} 不在角色可用集合内` };
  }

  if (input.request.mode === "call" && (!input.request.tool || !input.readOnlyTools?.includes(input.request.tool))) {
    return { allowed: false, reason: "子代理只能调用可信配置明确声明的只读 MCP 工具" };
  }

  return { allowed: true };
}

export async function loadMcpForRole(input: LoadMcpForRoleInput): Promise<LoadMcpForRoleResult> {
  let config: McpConfig;
  let missing: string[];
  try {
    ({ config, missing } = input.selected
      ? filterMcpConfig(input.config, input.selected)
      : { config: input.config, missing: [] as string[] });
  } catch (error) {
    return { loaded: [], missing: [], failure: `配置无法处理: ${(error as Error).message}` };
  }

  if (!input.packageDir) {
    return { loaded: [], missing, failure: "缺少 packageDir，无法校验入口归属" };
  }
  const pseudoEntry = input.entryPath.startsWith("custom://") && input.importer !== undefined;
  if (!pseudoEntry && !isAbsolute(input.entryPath)) {
    return { loaded: [], missing, failure: "entryPath 必须是绝对路径" };
  }
  if (!pseudoEntry) {
    let realEntry: string;
    let realPackageDir: string;
    try {
      realEntry = realpathSync(input.entryPath);
      realPackageDir = realpathSync(input.packageDir);
    } catch (error) {
      return { loaded: [], missing, failure: `无法解析入口路径: ${(error as Error).message}` };
    }
    if (!isWithin(realEntry, realPackageDir)) {
      return { loaded: [], missing, failure: "entryPath 越出 packageDir" };
    }
  }

  const importer = input.importer ?? ((path: string) => import(path));

  let mod: unknown;
  try {
    mod = await importer(input.entryPath);
  } catch (error) {
    return { loaded: [], missing, failure: (error as Error).message };
  }

  if (mod === null || typeof mod !== "object") {
    return { loaded: [], missing, failure: "适配器入口未导出有效模块" };
  }

  const createMcpAdapter = (mod as { createMcpAdapter?: unknown }).createMcpAdapter;
  if (typeof createMcpAdapter !== "function") {
    return { loaded: [], missing, failure: "适配器入口缺少 createMcpAdapter 导出" };
  }

  try {
    const factory = (createMcpAdapter as (options: { config: McpConfig }) => (pi: unknown) => void | Promise<void>)({
      config,
    });
    await factory(input.pi);
  } catch (error) {
    return { loaded: [], missing, failure: (error as Error).message };
  }

  return { loaded: Object.keys(config.mcpServers ?? {}), missing };
}

export function describeMcpStatus(input: McpStatusInput): string {
  const parts: string[] = [];
  if (input.loaded.length > 0) parts.push(`已装载 ${input.loaded.join("、")}`);
  if (input.missing.length > 0) parts.push(`缺失 ${input.missing.join("、")}`);
  if (input.failure) parts.push(`原因 ${input.failure}`);
  return parts.length > 0 ? parts.join("；") : "未装载任何 MCP 服务";
}
