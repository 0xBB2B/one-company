import { readFile, readdir } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type RoleSource = "default" | "user" | "project";
export type RoleKind = "plan" | "work" | "review" | "acceptance" | "manage";

export interface RoleDefinition {
  name: string;
  description: string;
  kind: RoleKind;
  tools: string[];
  skills: boolean;
  contextFiles: boolean;
  promptMode: string;
  body: string;
}

export interface RoleCatalogEntry {
  name: string;
  source: RoleSource;
  path: string;
  available: boolean;
  reason?: string;
  definition?: RoleDefinition;
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

const ROLE_KINDS = new Set<RoleKind>(["plan", "work", "review", "acceptance", "manage"]);

function isRoleKind(value: unknown): value is RoleKind {
  return typeof value === "string" && ROLE_KINDS.has(value as RoleKind);
}

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

export async function readRoleDefinition(path: string, parseFrontmatter: FrontmatterParser): Promise<RoleDefinition> {
  const content = await readFile(path, "utf8");
  const { frontmatter, body } = parseFrontmatter(content);
  const { name, description, kind, tools, skills, context_files, prompt_mode } = frontmatter;

  if (typeof name !== "string" || name.length === 0) {
    throw new Error(`角色定义缺少必需字段 name: ${path}`);
  }
  if (typeof description !== "string" || description.length === 0) {
    throw new Error(`角色定义缺少必需字段 description: ${path}`);
  }
  if (typeof kind !== "string" || kind.length === 0) {
    throw new Error(`角色定义缺少必需字段 kind: ${path}`);
  }
  if (!isRoleKind(kind)) {
    throw new Error(`角色定义 kind 不合法（须为 ${[...ROLE_KINDS].join("/")}）: ${kind}`);
  }
  if (!Array.isArray(tools) || !tools.every((tool) => typeof tool === "string")) {
    throw new Error(`角色定义 tools 字段必须为字符串数组: ${path}`);
  }
  if (skills !== undefined && typeof skills !== "boolean") {
    throw new Error(`角色定义 skills 字段必须为布尔值: ${path}`);
  }
  if (context_files !== undefined && typeof context_files !== "boolean") {
    throw new Error(`角色定义 context_files 字段必须为布尔值: ${path}`);
  }

  return {
    name,
    description,
    kind,
    tools: tools as string[],
    skills: skills ?? false,
    contextFiles: context_files ?? false,
    promptMode: typeof prompt_mode === "string" ? prompt_mode : "append",
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
    for (const entry of entries) merged.set(entry.name, entry);
  }
  if (!options.projectTrusted) {
    problems.push({ source: "project", dir: options.projectDir, reason: "项目未受宿主信任，项目层角色定义未生效" });
  }

  return { roles: [...merged.values()], problems };
}

export function roleToolAllowlist(entry: RoleCatalogEntry): string[] {
  return entry.definition?.tools ?? [];
}
