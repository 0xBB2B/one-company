import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { findDefinedModel } from "./model-ref.ts";
import type { AgentRole, RoleCatalogEntry, RoleDefinition, RoleSource } from "./roles.ts";

export interface AgentFingerprint {
  name: string;
  source: RoleSource;
  path: string;
  hash: string;
  skills: Array<{ name: string; path: string; hash: string }>;
}

export interface ResolvedAgent {
  definition: RoleDefinition;
  model: { provider: string; id: string };
  thinking: string;
  fingerprint: AgentFingerprint;
  /** 选中任务按需加载的 skill 正文，附在任务上下文之后。 */
  skillsContext: string;
}

export class AgentResolveError extends Error {
  readonly code: "agent_unavailable" | "model_unavailable" | "thinking_unsupported" | "skill_unavailable";
  constructor(code: AgentResolveError["code"], message: string) { super(message); this.name = "AgentResolveError"; this.code = code; }
}

export interface ModelLike { provider: string; id: string; reasoning?: boolean; thinkingLevelMap?: Record<string, unknown> }

export function thinkingSupported(model: ModelLike, thinking: string): boolean {
  return thinking === "off" || (!!model.reasoning && model.thinkingLevelMap?.[thinking] !== null);
}

const sha256 = (content: string | Buffer) => createHash("sha256").update(content).digest("hex");

export async function definitionHash(path: string): Promise<string> {
  return sha256(await readFile(path));
}

/** 设定里的模型与思考等级为 null 时用 fallback；模型必须真实存在、配了凭据，思考等级必须受该模型支持，否则报错而不换模型。 */
export async function resolveModelChoice(input: {
  model: string | null; thinking: string | null;
  models(provider?: string): readonly ModelLike[];
  hasAuth(provider: string): Promise<boolean>;
  fallback: { model: { provider: string; id: string }; thinking: string };
}): Promise<{ model: { provider: string; id: string }; thinking: string }> {
  let found: ModelLike | undefined;
  if (input.model) {
    const defined = findDefinedModel(input.model, input.models(), input.fallback.model.provider);
    if (!defined.ok) throw new AgentResolveError("model_unavailable", `模型不可用：${defined.reason}`);
    found = defined.model;
  } else {
    found = input.models(input.fallback.model.provider).find((candidate) => candidate.id === input.fallback.model.id);
    if (!found) throw new AgentResolveError("model_unavailable", `模型不可用：${input.fallback.model.provider}/${input.fallback.model.id}`);
  }
  const model = { provider: found.provider, id: found.id };
  if (!await input.hasAuth(model.provider)) throw new AgentResolveError("model_unavailable", `模型不可用：${model.provider}/${model.id} 没有可用的凭据`);
  const thinking = input.thinking ?? input.fallback.thinking;
  if (!thinkingSupported(found, thinking)) {
    throw new AgentResolveError("thinking_unsupported", `模型 ${model.provider}/${model.id} 不支持思考等级 ${thinking}${input.thinking === undefined || input.thinking === null ? "（没有单独设定，跟随了派出方的思考等级）" : ""}`);
  }
  return { model, thinking };
}

/**
 * 按名称取角色定义并核验：定义可用且职责一致、指定模型真实存在且配了凭据、思考等级受该模型支持、声明的 skills 都能找到；
 * 任一不满足即报错，不静默换定义、换模型或跳过 skill。
 */
export async function resolveAgent(input: {
  catalog: readonly RoleCatalogEntry[]; name: string; role: AgentRole;
  /** 不给 provider 时返回本机全部模型。 */
  models(provider?: string): readonly ModelLike[];
  hasAuth(provider: string): Promise<boolean>;
  fallback: { model: { provider: string; id: string }; thinking: string };
  skillDirs: readonly string[];
}): Promise<ResolvedAgent> {
  const entry = input.catalog.find((candidate) => candidate.name === input.name);
  if (!entry) throw new AgentResolveError("agent_unavailable", `未找到角色定义 ${input.name}`);
  if (!entry.available || !entry.definition) throw new AgentResolveError("agent_unavailable", `${input.name} 定义不可用：${entry.reason ?? "未知原因"}`);
  const definition = entry.definition;
  if (definition.role !== input.role) throw new AgentResolveError("agent_unavailable", `${input.name} 的职责是 ${definition.role}，不能承担 ${input.role} 任务`);
  const { model, thinking } = await resolveModelChoice({ model: definition.model ?? null, thinking: definition.thinking ?? null,
    models: input.models, hasAuth: input.hasAuth, fallback: input.fallback });
  const skills: AgentFingerprint["skills"] = [], bodies: string[] = [];
  for (const skill of definition.skills ?? []) {
    let loaded: { path: string; body: string } | undefined;
    for (const dir of input.skillDirs) {
      const path = join(dir, skill, "SKILL.md");
      const body = await readFile(path, "utf8").catch(() => undefined);
      if (body !== undefined) { loaded = { path, body }; break; }
    }
    if (!loaded) throw new AgentResolveError("skill_unavailable", `找不到 skill ${skill}（${input.name} 声明）`);
    skills.push({ name: skill, path: loaded.path, hash: sha256(loaded.body) });
    bodies.push(`## skill：${skill}\n${loaded.body.trim()}`);
  }
  return { definition, model, thinking, skillsContext: bodies.join("\n\n"),
    fingerprint: { name: entry.name, source: entry.source, path: entry.path, hash: await definitionHash(entry.path), skills } };
}
