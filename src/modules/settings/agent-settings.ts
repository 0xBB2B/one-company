import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { MODEL_PATTERN, THINKING_LEVELS, type ThinkingLevel } from "../agents/roles.ts";

export const SETTINGS_ROLES = [
  { key: "pm", label: "PM", purpose: "活动需求的负责人，拆任务、派工、调度", effect: "下次启动 PM 时生效", failure: "启动 PM 会失败", model: null, thinking: null },
  { key: "interpreter", label: "解释器", purpose: "把用户原话解读成结构化决定", effect: "下次调用时生效", failure: "批准需求时解读会失败", model: null, thinking: null },
  { key: "draft-verifier", label: "草稿核验器", purpose: "核对需求草稿是不是用户原话要求的", effect: "下次调用时生效", failure: "起草或修改需求草稿时核验会失败", model: null, thinking: null },
] as const;

export type SettingsRoleKey = (typeof SETTINGS_ROLES)[number]["key"];
export interface RoleSetting { model: string | null; thinking: ThinkingLevel | null }
export type SettingsLayer = Partial<Record<SettingsRoleKey, RoleSetting>>;
export interface SettingsProblem { path: string; layer: "user" | "project"; role?: SettingsRoleKey; key?: string; display: string; value?: string }
export interface EffectiveSetting extends RoleSetting { source: "project" | "user" | "default" }

export function userSettingsPath(agentDir: string): string {
  return join(agentDir, "settings.json");
}

export function projectSettingsPath(repositoryRoot: string): string {
  return join(repositoryRoot, ".pi", "settings.json");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error)).split("\n")[0];

// 和 pi 读设置文件时一致：去掉开头的 BOM，空内容当作 {}
function parseContent(text: string): unknown {
  const content = text.replace(/^\uFEFF/, "");
  return content.trim() === "" ? {} : JSON.parse(content);
}

export function parseSettingsLayer(path: string, layer: "user" | "project"): { entries: SettingsLayer; gitDelivery?: boolean; problems: SettingsProblem[] } {
  const entries: SettingsLayer = {};
  const problems: SettingsProblem[] = [];
  if (!existsSync(path)) return { entries, problems };
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    return { entries, problems: [{ path, layer, display: `文件读不了（${errorText(error)}），这一层的设定都没有生效` }] };
  }
  let root: unknown;
  try {
    root = parseContent(text);
  } catch {
    return { entries, problems: [{ path, layer, display: "文件不是合法的 JSON，这一层的设定都没有生效" }] };
  }
  if (!isObject(root)) return { entries, problems: [{ path, layer, display: "文件内容要写成 JSON 对象，这一层的设定都没有生效" }] };
  const section = root["one-company"];
  if (section === undefined) return { entries, problems };
  if (!isObject(section)) {
    return { entries, problems: [{ path, layer, display: "one-company 要写成对象，这一层的设定都没有生效" }] };
  }
  const keys = [...SETTINGS_ROLES.map((r) => r.key), "git-delivery"];
  let gitDelivery: boolean | undefined;
  for (const [name, value] of Object.entries(section)) {
    if (name === "git-delivery") {
      if (typeof value === "boolean") gitDelivery = value;
      else problems.push({ path, layer, key: name, display: "git-delivery 只能写 true 或 false", value: JSON.stringify(value) });
      continue;
    }
    const role = SETTINGS_ROLES.find((r) => r.key === name);
    if (!role) {
      problems.push({ path, layer, key: name, display: `不认识的设定 ${name}，只能是 ${keys.join("、")}` });
      continue;
    }
    const problem = (display: string) => problems.push({ path, layer, role: role.key, display });
    if (!isObject(value) || !("model" in value) || !("thinking" in value)) {
      problem(`「${role.label}」的设定要写成对象，同时包含 model 和 thinking`);
      continue;
    }
    const { model, thinking } = value;
    if (model !== null && (typeof model !== "string" || !MODEL_PATTERN.test(model))) {
      problem(`「${role.label}」的模型写法不对：${typeof model === "string" ? model : JSON.stringify(model)}；要写成模型名、提供方/模型名，或 null（跟随主会话）`);
      continue;
    }
    if (thinking !== null && (typeof thinking !== "string" || !(THINKING_LEVELS as readonly string[]).includes(thinking))) {
      problem(`「${role.label}」的思考等级写错了：${typeof thinking === "string" ? thinking : JSON.stringify(thinking)}；只能是 ${THINKING_LEVELS.join("、")}，或 null（跟随主会话）`);
      continue;
    }
    entries[role.key] = { model, thinking: thinking as ThinkingLevel | null };
  }
  return { entries, gitDelivery, problems };
}

export async function readAgentSettings(input: { agentDir: string; repositoryRoot: string; projectTrusted: boolean }): Promise<{
  values: Record<SettingsRoleKey, EffectiveSetting>;
  layers: { user: SettingsLayer; project: SettingsLayer };
  gitDelivery: { enabled: boolean; source: "project" | "user" | "default" };
  problems: SettingsProblem[];
}> {
  const user = parseSettingsLayer(userSettingsPath(input.agentDir), "user");
  const project = input.projectTrusted
    ? parseSettingsLayer(projectSettingsPath(input.repositoryRoot), "project")
    : { entries: {} as SettingsLayer, gitDelivery: undefined as boolean | undefined, problems: [] as SettingsProblem[] };
  const values = {} as Record<SettingsRoleKey, EffectiveSetting>;
  for (const role of SETTINGS_ROLES) {
    const fromProject = project.entries[role.key];
    const fromUser = user.entries[role.key];
    values[role.key] = fromProject
      ? { ...fromProject, source: "project" }
      : fromUser
        ? { ...fromUser, source: "user" }
        : { model: role.model, thinking: role.thinking, source: "default" };
  }
  const gitDelivery = project.gitDelivery !== undefined
    ? { enabled: project.gitDelivery, source: "project" as const }
    : user.gitDelivery !== undefined
      ? { enabled: user.gitDelivery, source: "user" as const }
      : { enabled: false, source: "default" as const };
  return {
    values,
    gitDelivery,
    layers: { user: user.entries, project: project.entries },
    problems: [...user.problems, ...project.problems],
  };
}

function rewriteSettings(path: string, change: (root: Record<string, unknown>) => Record<string, unknown> | undefined): void {
  let root: Record<string, unknown> = {};
  if (existsSync(path)) {
    let text: string;
    try { text = readFileSync(path, "utf8"); } catch (error) { throw new Error(`设置文件读不了（${errorText(error)}），没有改动：${path}`); }
    let parsed: unknown;
    try { parsed = parseContent(text); } catch { throw new Error(`设置文件不是合法的 JSON，没有改动：${path}`); }
    if (!isObject(parsed)) throw new Error(`设置文件顶层不是对象，没有改动：${path}`);
    root = parsed;
  }
  const next = change(root);
  if (next === undefined) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, "utf8");
}

export async function saveAgentSetting(input: { path: string; role: SettingsRoleKey; model: string | null; thinking: ThinkingLevel | null }): Promise<void> {
  rewriteSettings(input.path, (root) => {
    const section = isObject(root["one-company"]) ? root["one-company"] : {};
    return { ...root, "one-company": { ...section, [input.role]: { model: input.model, thinking: input.thinking } } };
  });
}

export async function clearAgentSetting(input: { path: string; role: SettingsRoleKey }): Promise<void> {
  rewriteSettings(input.path, (root) => {
    if (!isObject(root["one-company"]) || !(input.role in root["one-company"])) return undefined;
    const { [input.role]: _removed, ...rest } = root["one-company"];
    const { "one-company": _section, ...others } = root;
    return Object.keys(rest).length > 0 ? { ...others, "one-company": rest } : others;
  });
}

export async function saveGitDeliverySetting(input: { path: string; enabled: boolean }): Promise<void> {
  rewriteSettings(input.path, (root) => {
    const section = isObject(root["one-company"]) ? root["one-company"] : {};
    return { ...root, "one-company": { ...section, "git-delivery": input.enabled } };
  });
}

export async function clearGitDeliverySetting(input: { path: string }): Promise<void> {
  rewriteSettings(input.path, (root) => {
    if (!isObject(root["one-company"]) || !("git-delivery" in root["one-company"])) return undefined;
    const { "git-delivery": _removed, ...rest } = root["one-company"];
    const { "one-company": _section, ...others } = root;
    return Object.keys(rest).length > 0 ? { ...others, "one-company": rest } : others;
  });
}
