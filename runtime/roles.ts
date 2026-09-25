import { readFile, readdir } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type RoleSource = "default" | "user" | "project";
export const AGENT_ROLES = ["pm", "explore", "worker", "reviewer", "qa"] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export interface RoleDefinition {
  name: string;
  description: string;
  role: AgentRole;
  model?: string;
  thinking?: ThinkingLevel;
  mcp?: string[];
  skills?: string[];
  body: string;
}

export interface RoleCatalogEntry {
  name: string;
  source: RoleSource;
  path: string;
  available: boolean;
  reason?: string;
  definition?: RoleDefinition;
  /** 被本定义同名覆盖的下层来源。 */
  overrides?: RoleSource[];
}

export type FrontmatterParser = (content: string) => { frontmatter: Record<string, unknown>; body: string };

export interface LoadRoleCatalogOptions {
  defaultDir: string;
  userDir: string;
  projectDir: string;
  parseFrontmatter: FrontmatterParser;
  projectTrusted: boolean;
}

export interface RoleCatalogProblem {
  source: RoleSource;
  dir: string;
  reason: string;
}

export interface RoleCatalog {
  roles: RoleCatalogEntry[];
  problems: RoleCatalogProblem[];
}

const FIELDS = new Set(["name", "description", "role", "model", "thinking", "mcp", "skills"]);
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_DESCRIPTION_CODEPOINTS = 1024;

// 解析器的错误消息会附带出错处的源文本，只保留首行以免把文件内容带进不可用原因
function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split("\n")[0] ?? message;
}

export function defaultRoleDir(): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  return join(dirname(moduleDir), "agents");
}

export function userRoleDir(agentDir: string): string {
  return join(agentDir, "agents");
}

export function projectRoleDir(repoRoot: string): string {
  return join(repoRoot, ".pi", "agents");
}

function stringList(value: unknown, field: string, path: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item.length > 0) || new Set(value).size !== value.length) {
    throw new Error(`角色定义 ${field} 必须为不重复的非空字符串数组: ${path}`);
  }
  return value as string[];
}

export async function readRoleDefinition(path: string, parseFrontmatter: FrontmatterParser): Promise<RoleDefinition> {
  const content = await readFile(path, "utf8");
  const { frontmatter, body } = parseFrontmatter(content);
  const unknown = Object.keys(frontmatter).filter((key) => !FIELDS.has(key));
  if (unknown.length > 0) throw new Error(`角色定义含未知字段 ${unknown.join("、")}: ${path}`);
  const { name, description, role, model, thinking, mcp, skills } = frontmatter;

  if (typeof name !== "string" || !NAME_PATTERN.test(name)) {
    throw new Error(`角色定义 name 必须为小写字母、数字或连字符（最多 64 字符）: ${path}`);
  }
  if (typeof description !== "string" || description.length === 0) {
    throw new Error(`角色定义缺少必需字段 description: ${path}`);
  }
  if ([...description].length > MAX_DESCRIPTION_CODEPOINTS) {
    throw new Error(`角色定义 description 超过 ${MAX_DESCRIPTION_CODEPOINTS} 字符: ${path}`);
  }
  if (typeof role !== "string" || !(AGENT_ROLES as readonly string[]).includes(role)) {
    throw new Error(`角色定义 role 须为 ${AGENT_ROLES.join("/")}: ${path}`);
  }
  if (role === "pm" && name !== "pm") throw new Error(`pm 职责只能由名为 pm 的定义承担: ${path}`);
  if (model !== undefined && (typeof model !== "string" || !/^[^/\s]+\/\S+$/.test(model))) {
    throw new Error(`角色定义 model 须为 provider/id: ${path}`);
  }
  if (thinking !== undefined && (typeof thinking !== "string" || !(THINKING_LEVELS as readonly string[]).includes(thinking))) {
    throw new Error(`角色定义 thinking 须为 ${THINKING_LEVELS.join("/")}: ${path}`);
  }

  return {
    name,
    description,
    role: role as AgentRole,
    ...(model !== undefined ? { model: model as string } : {}),
    ...(thinking !== undefined ? { thinking: thinking as ThinkingLevel } : {}),
    ...(mcp !== undefined ? { mcp: stringList(mcp, "mcp", path) } : {}),
    ...(skills !== undefined ? { skills: stringList(skills, "skills", path) } : {}),
    body,
  };
}

async function loadLayerEntries(
  dir: string,
  source: RoleSource,
  parseFrontmatter: FrontmatterParser,
  problems: RoleCatalogProblem[],
): Promise<RoleCatalogEntry[]> {
  let dirents;
  try {
    dirents = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      problems.push({ source, dir, reason: errorText(error) });
    }
    return [];
  }

  const entries: RoleCatalogEntry[] = [];
  for (const dirent of dirents) {
    if (!(dirent.isFile() || dirent.isSymbolicLink())) continue;
    const extension = extname(dirent.name);
    if (extension.toLowerCase() !== ".md") continue;
    const name = basename(dirent.name, extension);
    const path = join(dir, dirent.name);
    try {
      // 缺 role 的是其他宿主的 agent 定义：不导入、不推断职责，也不影响默认团队
      if (parseFrontmatter(await readFile(path, "utf8")).frontmatter.role === undefined) {
        problems.push({ source, dir: path, reason: "缺少 role，视为其他宿主定义，未导入" });
        continue;
      }
      const definition = await readRoleDefinition(path, parseFrontmatter);
      if (definition.name !== name) {
        throw new Error(`角色定义 name（${definition.name}）与文件名（${name}）不一致: ${path}`);
      }
      entries.push({ name, source, path, available: true, definition });
    } catch (error) {
      entries.push({ name, source, path, available: false, reason: errorText(error) });
    }
  }
  return entries;
}

export async function loadRoleCatalog(options: LoadRoleCatalogOptions): Promise<RoleCatalog> {
  const layers: Array<{ dir: string; source: RoleSource }> = [
    { dir: options.defaultDir, source: "default" },
    { dir: options.userDir, source: "user" },
  ];
  if (options.projectTrusted) layers.push({ dir: options.projectDir, source: "project" });

  const merged = new Map<string, RoleCatalogEntry>();
  const problems: RoleCatalogProblem[] = [];
  for (const layer of layers) {
    const entries = await loadLayerEntries(layer.dir, layer.source, options.parseFrontmatter, problems);
    for (const entry of entries) {
      const lower = merged.get(entry.name);
      // 无效定义不隐式顶掉下层有效定义；明确报错并保留下层
      if (!entry.available && lower?.available) {
        problems.push({ source: entry.source, dir: entry.path, reason: `${entry.reason}；未覆盖${lower.source}层的 ${entry.name}` });
        continue;
      }
      merged.set(entry.name, lower ? { ...entry, overrides: [...(lower.overrides ?? []), lower.source] } : entry);
    }
  }
  if (!options.projectTrusted) {
    problems.push({ source: "project", dir: options.projectDir, reason: "项目未受宿主信任，项目层角色定义未生效" });
  }

  return { roles: [...merged.values()], problems };
}
