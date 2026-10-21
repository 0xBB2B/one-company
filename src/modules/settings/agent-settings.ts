import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { detectDeliveryMode } from "../../core/exec/git-host.ts";
import type { DeliveryMode, GitProvider } from "../../core/exec/git-host.ts";
import { MODEL_PATTERN, THINKING_LEVELS, isGenericDefinition, type ThinkingLevel } from "../agents/roles.ts";

export const SETTINGS_ROLES = [
  { key: "pm", label: "PM", purpose: "活动需求的负责人，拆任务、派工、调度", effect: "下次启动 PM 时生效", failure: "启动 PM 会失败", model: null, thinking: null },
  { key: "interpreter", label: "解释器", purpose: "把用户原话解读成结构化决定", effect: "下次调用时生效", failure: "批准需求时解读会失败", model: null, thinking: null },
  { key: "draft-verifier", label: "草稿核验器", purpose: "核对需求草稿是不是用户原话要求的", effect: "下次调用时生效", failure: "起草或修改需求草稿时核验会失败", model: null, thinking: null },
] as const;

export const MERGE_METHODS = [
  { key: "squash", label: "压缩合并" },
  { key: "merge", label: "普通合并" },
  { key: "rebase", label: "rebase 合并" },
] as const;

export type MergeMethod = (typeof MERGE_METHODS)[number]["key"];
export type SettingsRoleKey = (typeof SETTINGS_ROLES)[number]["key"];
export interface RoleSetting { model: string | null; thinking: ThinkingLevel | null }
export type SettingsLayer = Partial<Record<SettingsRoleKey, RoleSetting>>;
export interface SettingsProblem { path: string; layer: "user" | "project"; role?: SettingsRoleKey; key?: string; display: string; value?: string }
export interface DisabledAgents { user: string[]; project: string[] }
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

const isMergeMethods = (value: unknown): value is MergeMethod[] =>
  Array.isArray(value) && value.length >= 1 && value.length <= MERGE_METHODS.length && new Set(value).size === value.length
  && value.every((item) => MERGE_METHODS.some((method) => method.key === item));

export function parseSettingsLayer(path: string, layer: "user" | "project"): { entries: SettingsLayer; gitDelivery?: DeliveryMode; mergeMethods?: MergeMethod[]; disabledAgents?: string[]; problems: SettingsProblem[] } {
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
  const keys = [...SETTINGS_ROLES.map((r) => r.key), "git-delivery", "merge-methods", "disabled-agents"];
  let gitDelivery: DeliveryMode | undefined;
  let mergeMethods: MergeMethod[] | undefined;
  let disabledAgents: string[] | undefined;
  for (const [name, value] of Object.entries(section)) {
    if (name === "git-delivery") {
      if (value === "remote" || value === "local") gitDelivery = value;
      else problems.push({ path, layer, key: name, display: "git-delivery 只能写 remote 或 local", value: JSON.stringify(value) });
      continue;
    }
    if (name === "merge-methods") {
      if (isMergeMethods(value)) mergeMethods = value;
      else problems.push({ path, layer, key: name, display: "merge-methods 只能是 squash、merge、rebase 里的一到三个，不能重复", value: JSON.stringify(value) });
      continue;
    }
    if (name === "disabled-agents") {
      if (Array.isArray(value) && value.every((item) => typeof item === "string")) disabledAgents = value;
      else problems.push({ path, layer, key: name, display: "disabled-agents 只能写定义名列表", value: JSON.stringify(value) });
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
  return { entries, gitDelivery, mergeMethods, disabledAgents, problems };
}

type Settings = Awaited<ReturnType<typeof readAgentSettings>>;

function readLayers(input: { agentDir: string; repositoryRoot: string; projectTrusted: boolean }) {
  const user = parseSettingsLayer(userSettingsPath(input.agentDir), "user");
  const project = input.projectTrusted
    ? parseSettingsLayer(projectSettingsPath(input.repositoryRoot), "project")
    : { entries: {} as SettingsLayer, gitDelivery: undefined as DeliveryMode | undefined, mergeMethods: undefined as MergeMethod[] | undefined, disabledAgents: [] as string[], problems: [] as SettingsProblem[] };
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
  return { user, project, values };
}

export function readRoleSettings(input: { agentDir: string; repositoryRoot: string; projectTrusted: boolean }): Record<SettingsRoleKey, EffectiveSetting> {
  return readLayers(input).values;
}

export async function readAgentSettings(input: { agentDir: string; repositoryRoot: string; projectTrusted: boolean }): Promise<{
  values: Record<SettingsRoleKey, EffectiveSetting>;
  layers: { user: SettingsLayer; project: SettingsLayer };
  gitDelivery: { mode: DeliveryMode; source: "project" | "user" | "default"; detected?: { host: string | null; provider: GitProvider | null } };
  mergeMethods: { methods: readonly MergeMethod[]; source: "project" | "user" | "default" };
  disabledAgents: DisabledAgents;
  problems: SettingsProblem[];
}> {
  const { user, project, values } = readLayers(input);
  let gitDelivery: Settings["gitDelivery"];
  if (project.gitDelivery !== undefined) gitDelivery = { mode: project.gitDelivery, source: "project" };
  else if (user.gitDelivery !== undefined) gitDelivery = { mode: user.gitDelivery, source: "user" };
  else {
    const { mode, host, provider } = await detectDeliveryMode(input.repositoryRoot);
    gitDelivery = { mode, source: "default", detected: { host, provider } };
  }
  const mergeMethods: Settings["mergeMethods"] = project.mergeMethods
    ? { methods: project.mergeMethods, source: "project" }
    : user.mergeMethods
      ? { methods: user.mergeMethods, source: "user" }
      : { methods: MERGE_METHODS.map((method) => method.key), source: "default" };
  return {
    values,
    gitDelivery,
    mergeMethods,
    disabledAgents: { user: user.disabledAgents ?? [], project: project.disabledAgents ?? [] },
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

function saveOneCompanyKey(path: string, key: string, value: unknown): void {
  rewriteSettings(path, (root) => {
    const section = isObject(root["one-company"]) ? root["one-company"] : {};
    return { ...root, "one-company": { ...section, [key]: value } };
  });
}

function clearOneCompanyKey(path: string, key: string): void {
  rewriteSettings(path, (root) => {
    if (!isObject(root["one-company"]) || !(key in root["one-company"])) return undefined;
    const { [key]: _removed, ...rest } = root["one-company"];
    const { "one-company": _section, ...others } = root;
    return Object.keys(rest).length > 0 ? { ...others, "one-company": rest } : others;
  });
}

export async function saveGitDeliverySetting(input: { path: string; mode: DeliveryMode }): Promise<void> {
  saveOneCompanyKey(input.path, "git-delivery", input.mode);
}

export async function clearGitDeliverySetting(input: { path: string }): Promise<void> {
  clearOneCompanyKey(input.path, "git-delivery");
}

export async function saveMergeMethodsSetting(input: { path: string; methods: readonly MergeMethod[] }): Promise<void> {
  saveOneCompanyKey(input.path, "merge-methods", MERGE_METHODS.map((method) => method.key).filter((key) => input.methods.includes(key)));
}

export async function clearMergeMethodsSetting(input: { path: string }): Promise<void> {
  clearOneCompanyKey(input.path, "merge-methods");
}

export function readDisabledAgents(input: { agentDir: string; repositoryRoot: string; projectTrusted: boolean }): DisabledAgents {
  const { user, project } = readLayers(input);
  return { user: user.disabledAgents ?? [], project: project.disabledAgents ?? [] };
}

export function disabledAgentNames(disabled: DisabledAgents): Set<string> {
  return new Set([...disabled.user, ...disabled.project].filter((name) => !isGenericDefinition(name)));
}

export function agentSwitchOf(name: string, disabled: DisabledAgents): { generic: boolean; enabled: boolean; from: "user" | "project" | null } {
  if (isGenericDefinition(name)) return { generic: true, enabled: true, from: null };
  const from = disabled.user.includes(name) ? "user" : disabled.project.includes(name) ? "project" : null;
  return { generic: false, enabled: from === null, from };
}

export function disabledAgentProblems(disabled: DisabledAgents, paths: { user: string; project: string }, catalog: { roles: readonly { name: string }[] }): SettingsProblem[] {
  const problems: SettingsProblem[] = [];
  for (const layer of ["user", "project"] as const) {
    for (const name of disabled[layer]) {
      const display = isGenericDefinition(name)
        ? `${name} 是通用定义，不能关闭`
        : catalog.roles.some((role) => role.name === name) ? undefined : `没有叫 ${name} 的角色定义`;
      if (display) problems.push({ path: paths[layer], layer, key: "disabled-agents", display, value: name });
    }
  }
  return problems;
}

export async function saveDisabledAgentsSetting(path: string, names: readonly string[]): Promise<void> {
  if (names.length === 0) clearOneCompanyKey(path, "disabled-agents");
  else saveOneCompanyKey(path, "disabled-agents", [...names]);
}
