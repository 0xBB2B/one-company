import { lstat, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { withDirLock, writeFileAtomic } from "./store.ts";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface RoleEntry {
  model?: string;
  thinking?: ThinkingLevel;
  mcp?: string[];
}

export interface SettingsPaths {
  global: string;
  project: string | null;
}

export interface LoadedLayer {
  path: string;
  raw: string | null;
  roles: Record<string, RoleEntry>;
}

export interface LoadRoleSettingsResult {
  global: LoadedLayer;
  project: LoadedLayer | null;
}

export interface RoleLayer {
  roles: Record<string, RoleEntry>;
}

export interface ResolveContext {
  mainModel: string;
  mainThinking: string;
  models: Array<{ id: string; thinkingLevels: string[] }>;
  availableMcp: string[];
}

export interface ResolvedMcp {
  enabled: string[];
  unavailable: string[];
  source: "global" | "project" | "none";
}

export interface ResolvedRoleSettings {
  model: string;
  thinking: string;
  mcp: ResolvedMcp;
}

const THINKING_ORDER = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const THINKING_LEVELS = new Set<string>(THINKING_ORDER);
const ROLE_KEY_PREFIX = "pi-company.";
const SETTINGS_FILE_MODE = 0o600;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isValidModelFormat(model: string): boolean {
  if (model === "inherit") return true;
  const separatorIndex = model.indexOf("/");
  if (separatorIndex <= 0) return false;
  return model.slice(separatorIndex + 1).length > 0;
}

function validateEntryShape(roleName: string, raw: unknown): RoleEntry {
  if (!isRecord(raw)) {
    throw new Error(`角色 ${roleName} 的配置必须是对象`);
  }
  const allowedKeys = new Set(["model", "thinking", "mcp"]);
  for (const key of Object.keys(raw)) {
    if (!allowedKeys.has(key)) {
      throw new Error(`角色 ${roleName} 的配置包含未知字段: ${key}`);
    }
  }
  const entry: RoleEntry = {};
  if ("model" in raw) {
    const model = raw.model;
    if (typeof model !== "string" || !isValidModelFormat(model)) {
      throw new Error(`角色 ${roleName} 的 model 格式非法: ${String(model)}`);
    }
    entry.model = model;
  }
  if ("thinking" in raw) {
    const thinking = raw.thinking;
    if (typeof thinking !== "string" || !THINKING_LEVELS.has(thinking)) {
      throw new Error(`角色 ${roleName} 的 thinking 不合法: ${String(thinking)}`);
    }
    entry.thinking = thinking as ThinkingLevel;
  }
  if ("mcp" in raw) {
    const mcp = raw.mcp;
    if (!Array.isArray(mcp) || !mcp.every((item) => typeof item === "string")) {
      throw new Error(`角色 ${roleName} 的 mcp 必须是字符串数组`);
    }
    entry.mcp = mcp as string[];
  }
  return entry;
}

export function settingsPaths(input: { agentDir: string; repoRoot: string; projectTrusted: boolean }): SettingsPaths {
  return {
    global: join(input.agentDir, "settings.json"),
    project: input.projectTrusted ? join(input.repoRoot, ".pi", "settings.json") : null,
  };
}

async function loadLayer(path: string, roleNames: Set<string>): Promise<LoadedLayer> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { path, raw: null, roles: {} };
    }
    throw error;
  }
  const parsed = JSON.parse(raw) as unknown;
  const piCompany = isRecord(parsed) ? parsed.piCompany : undefined;
  const rolesRaw = isRecord(piCompany) ? piCompany.roles : undefined;
  const roles: Record<string, RoleEntry> = {};
  if (isRecord(rolesRaw)) {
    for (const [key, value] of Object.entries(rolesRaw)) {
      if (!key.startsWith(ROLE_KEY_PREFIX)) continue;
      const roleName = key.slice(ROLE_KEY_PREFIX.length);
      if (!roleNames.has(roleName)) {
        throw new Error(`角色 ${roleName} 不在角色目录中`);
      }
      roles[roleName] = validateEntryShape(roleName, value);
    }
  }
  return { path, raw, roles };
}

export async function loadRoleSettings(
  paths: SettingsPaths,
  options: { roleNames: string[] },
): Promise<LoadRoleSettingsResult> {
  const roleNames = new Set(options.roleNames);
  const global = await loadLayer(paths.global, roleNames);
  const project = paths.project === null ? null : await loadLayer(paths.project, roleNames);
  return { global, project };
}

function pickExplicitModel(projectEntry: RoleEntry | undefined, globalEntry: RoleEntry | undefined): string | undefined {
  if (projectEntry?.model !== undefined) {
    return projectEntry.model === "inherit" ? undefined : projectEntry.model;
  }
  if (globalEntry?.model !== undefined) {
    return globalEntry.model === "inherit" ? undefined : globalEntry.model;
  }
  return undefined;
}

function pickExplicitThinking(projectEntry: RoleEntry | undefined, globalEntry: RoleEntry | undefined): ThinkingLevel | undefined {
  if (projectEntry?.thinking !== undefined) return projectEntry.thinking;
  if (globalEntry?.thinking !== undefined) return globalEntry.thinking;
  return undefined;
}

export function thinkingCandidatesFor(modelId: string, context: { models: Array<{ id: string; thinkingLevels: string[] }> }): string[] {
  const found = context.models.find((model) => model.id === modelId);
  return found ? found.thinkingLevels : [];
}

export function effectiveMcp(input: { global?: string[]; project?: string[]; available: string[] }): ResolvedMcp {
  let source: ResolvedMcp["source"] = "none";
  let chosen: string[] = [];
  if (input.project !== undefined) {
    source = "project";
    chosen = input.project;
  } else if (input.global !== undefined) {
    source = "global";
    chosen = input.global;
  }
  return {
    enabled: chosen.filter((id) => input.available.includes(id)),
    unavailable: chosen.filter((id) => !input.available.includes(id)),
    source,
  };
}

export function resolveRoleSettings(
  role: string,
  layers: { global: RoleLayer; project: RoleLayer | null },
  context: ResolveContext,
): ResolvedRoleSettings {
  const globalEntry = layers.global.roles[role];
  const projectEntry = layers.project?.roles[role];

  const explicitModel = pickExplicitModel(projectEntry, globalEntry);
  const model = explicitModel ?? context.mainModel;
  if (explicitModel !== undefined && !context.models.some((m) => m.id === explicitModel)) {
    throw new Error(`角色 ${role} 的 model 不在可用模型集合中: ${explicitModel}`);
  }

  const known = context.models.some((entry) => entry.id === model);
  const candidates = thinkingCandidatesFor(model, context);
  const explicitThinking = pickExplicitThinking(projectEntry, globalEntry);
  let thinking: string;
  if (explicitThinking !== undefined) {
    thinking = explicitThinking;
    if (known && !candidates.includes(thinking)) {
      throw new Error(`角色 ${role} 的 thinking（${thinking}）超出模型 ${model} 支持的能力范围`);
    }
  } else {
    thinking = context.mainThinking;
    if (known && !candidates.includes(thinking)) {
      const highest = [...THINKING_ORDER].reverse().find((level) => candidates.includes(level));
      thinking = highest ?? "off";
    }
  }

  const mcp = effectiveMcp({ global: globalEntry?.mcp, project: projectEntry?.mcp, available: context.availableMcp });

  return { model, thinking, mcp };
}

async function readCurrentGuarded(path: string): Promise<string | null> {
  let stat;
  try {
    stat = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (!stat.isFile()) {
    throw new Error(`设置文件路径不是普通文件: ${path}`);
  }
  return readFile(path, "utf8");
}

function assertBaseline(current: string | null, baseline: string | null): void {
  if (current !== baseline) {
    throw new Error("设置文件已被外部修改，请重新打开后再应用改动");
  }
}


function parseTopLevel(current: string | null): Record<string, unknown> {
  if (current === null) return {};
  const parsed = JSON.parse(current) as unknown;
  if (!isRecord(parsed)) {
    throw new Error("设置文件顶层内容格式非法，必须是 JSON 对象");
  }
  return parsed;
}

function extractRoles(parsed: Record<string, unknown>): { piCompany: Record<string, unknown>; roles: Record<string, unknown> } {
  const piCompany = isRecord(parsed.piCompany) ? parsed.piCompany : {};
  const roles = isRecord(piCompany.roles) ? piCompany.roles : {};
  return { piCompany, roles };
}

async function mutateSettingsFile(
  path: string,
  baseline: string | null,
  mutate: (roles: Record<string, unknown>) => Record<string, unknown>,
): Promise<string> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  return withDirLock(dir, async () => {
    const current = await readCurrentGuarded(path);
    assertBaseline(current, baseline);
    const parsed = parseTopLevel(current);
    const { piCompany, roles } = extractRoles(parsed);
    const next = { ...parsed, piCompany: { ...piCompany, roles: mutate(roles) } };
    const raw = JSON.stringify(next, null, 2);
    await writeFileAtomic(path, raw);
    return raw;
  });
}

export async function saveRoleSettings(
  path: string,
  options: { role: string; patch: RoleEntry; baseline: string | null },
): Promise<string> {
  return mutateSettingsFile(path, options.baseline, (roles) => {
    const key = `${ROLE_KEY_PREFIX}${options.role}`;
    const existing = isRecord(roles[key]) ? roles[key] : {};
    const patchDefined = Object.fromEntries(Object.entries(options.patch).filter(([, value]) => value !== undefined));
    const merged = validateEntryShape(options.role, { ...existing, ...patchDefined });
    return { ...roles, [key]: merged };
  });
}

export async function clearRoleField(
  path: string,
  options: { role: string; field: keyof RoleEntry; baseline: string | null },
): Promise<string> {
  return mutateSettingsFile(path, options.baseline, (roles) => {
    const key = `${ROLE_KEY_PREFIX}${options.role}`;
    const existing = isRecord(roles[key]) ? { ...roles[key] } : {};
    delete existing[options.field];
    const nextRoles = { ...roles };
    if (Object.keys(existing).length === 0) {
      delete nextRoles[key];
    } else {
      nextRoles[key] = existing;
    }
    return nextRoles;
  });
}
