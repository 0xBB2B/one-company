import { readFile, readdir } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type RoleSource = "default" | "user" | "project";
export const AGENT_ROLES = ["pm", "explore", "worker", "reviewer", "qa", "prototype"] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];
export const DEFINITION_ROLES = ["explore", "worker", "reviewer", "qa", "prototype"] as const;
const RETIRED_ROLES = ["pm", "interpreter", "draft-verifier"];
const RETIRED_REASON = "已不再使用定义文件，模型和思考等级改在「模型」里";
export const PM_DEFINITION = { name: "pm", description: "活动需求的唯一负责人，通过接手复核后负责 plan/task 拆分、依赖、覆盖映射与增量调度", role: "pm", body: "" } as const;
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export const MODEL_PATTERN = /^[^/\s]+(\/\S+)?$/;
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

/** 定义写错时的结构化原因：field 为出错字段，value 为文件里的写法，display 是给人看的完整原因。 */
export interface RoleDefinitionProblem { field?: string; value?: unknown; display: string }
export class RoleDefinitionError extends Error {
  readonly problem: RoleDefinitionProblem;
  constructor(message: string, problem: RoleDefinitionProblem) { super(message); this.name = "RoleDefinitionError"; this.problem = problem; }
}

export interface RoleCatalogEntry {
  name: string;
  source: RoleSource;
  path: string;
  available: boolean;
  reason?: string;
  problem?: RoleDefinitionProblem;
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
  kind: "unreadable" | "foreign" | "invalid" | "untrusted" | "retired";
  source: RoleSource;
  dir: string;
  reason: string;
  problem?: RoleDefinitionProblem;
}

export interface RoleCatalog {
  roles: RoleCatalogEntry[];
  problems: RoleCatalogProblem[];
}

const FIELDS = new Set(["name", "description", "role", "model", "thinking", "mcp", "skills"]);
export const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
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
    throw new RoleDefinitionError(`角色定义 ${field} 必须为不重复的非空字符串数组: ${path}`, { field, value, display: `${field} 要写成不重复的非空列表` });
  }
  return value as string[];
}

export async function readRoleDefinition(path: string, parseFrontmatter: FrontmatterParser): Promise<RoleDefinition> {
  const content = await readFile(path, "utf8");
  const { frontmatter, body } = parseFrontmatter(content);
  const unknown = Object.keys(frontmatter).filter((key) => !FIELDS.has(key));
  if (unknown.length > 0) throw new RoleDefinitionError(`角色定义含未知字段 ${unknown.join("、")}: ${path}`, { field: unknown[0], display: `不认识的字段：${unknown.join("、")}` });
  const { name, description, role, model, thinking, mcp, skills } = frontmatter;

  if (typeof name !== "string" || !NAME_PATTERN.test(name)) {
    throw new RoleDefinitionError(`角色定义 name 必须为小写字母、数字或连字符（最多 64 字符）: ${path}`, { field: "name", value: name, display: "name 只能用小写字母、数字和连字符，最多 64 个字符" });
  }
  if (typeof description !== "string" || description.length === 0) {
    throw new RoleDefinitionError(`角色定义缺少必需字段 description: ${path}`, { field: "description", display: "缺少 description" });
  }
  if ([...description].length > MAX_DESCRIPTION_CODEPOINTS) {
    throw new RoleDefinitionError(`角色定义 description 超过 ${MAX_DESCRIPTION_CODEPOINTS} 字符: ${path}`, { field: "description", display: `description 超过 ${MAX_DESCRIPTION_CODEPOINTS} 个字符` });
  }
  if (typeof role !== "string" || !(DEFINITION_ROLES as readonly string[]).includes(role)) {
    throw new RoleDefinitionError(`角色定义 role 须为 ${DEFINITION_ROLES.join("/")}: ${path}`, { field: "role", value: role, display: `role 只能是 ${DEFINITION_ROLES.join("、")}` });
  }
  if (model !== undefined && (typeof model !== "string" || !MODEL_PATTERN.test(model))) {
    throw new RoleDefinitionError(`角色定义 model 须为模型名或 provider/id: ${path}`, { field: "model", value: model, display: "model 要写成模型名或 provider/id，例如 gpt-6-luna 或 5x/gpt-6-luna" });
  }
  if (thinking !== undefined && (typeof thinking !== "string" || !(THINKING_LEVELS as readonly string[]).includes(thinking))) {
    throw new RoleDefinitionError(`角色定义 thinking 须为 ${THINKING_LEVELS.join("/")}: ${path}`, { field: "thinking", value: thinking, display: `thinking 只能是 ${THINKING_LEVELS.join("、")}` });
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
      problems.push({ kind: "unreadable", source, dir, reason: errorText(error) });
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
      const headerRole = parseFrontmatter(await readFile(path, "utf8")).frontmatter.role;
      if (headerRole === undefined) {
        problems.push({ kind: "foreign", source, dir: path, reason: "缺少 role，视为其他宿主定义，未导入" });
        continue;
      }
      if (typeof headerRole === "string" && RETIRED_ROLES.includes(headerRole)) {
        problems.push({ kind: "retired", source, dir: path, reason: RETIRED_REASON });
        continue;
      }
      const definition = await readRoleDefinition(path, parseFrontmatter);
      if (definition.name !== name) {
        throw new RoleDefinitionError(`角色定义 name（${definition.name}）与文件名（${name}）不一致: ${path}`, { field: "name", value: definition.name, display: `name 要和文件名 ${name} 一致` });
      }
      entries.push({ name, source, path, available: true, definition });
    } catch (error) {
      entries.push({ name, source, path, available: false, reason: errorText(error),
        problem: error instanceof RoleDefinitionError ? error.problem : { display: errorText(error) } });
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
        problems.push({ kind: "invalid", source: entry.source, dir: entry.path, reason: `${entry.reason}；未覆盖${lower.source}层的 ${entry.name}`, ...(entry.problem ? { problem: entry.problem } : {}) });
        continue;
      }
      merged.set(entry.name, lower ? { ...entry, overrides: [...(lower.overrides ?? []), lower.source] } : entry);
    }
  }
  if (!options.projectTrusted) {
    problems.push({ kind: "untrusted", source: "project", dir: options.projectDir, reason: "项目未受宿主信任，项目层角色定义未生效" });
  }

  return { roles: [...merged.values()], problems };
}
