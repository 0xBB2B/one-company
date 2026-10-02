import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { Api, Model, ThinkingLevel } from "@earendil-works/pi-ai";
import { HostAuthorizationError } from "./host-authorization.ts";
import { findDefinedModel } from "./model-ref.ts";
import { defaultRoleDir, loadRoleCatalog, projectRoleDir, userRoleDir } from "./roles.ts";
import type { InternalRole } from "./roles.ts";

const LABEL: Record<InternalRole, string> = { interpreter: "解释器", "draft-verifier": "草稿核验器" };

/** 按项目 > 用户 > 包内的内部定义决定这次调用用哪个模型与思考等级；定义没写模型时沿用主会话模型，思考为 off 或没写即不思考。 */
export async function resolveInternalModel(input: { role: InternalRole; agentDir: string; repositoryRoot: string; projectTrusted: boolean;
  registry: Pick<ModelRegistry, "getAll" | "hasConfiguredAuth">; mainModel: Model<Api> | undefined }): Promise<{ model: Model<Api>; thinking: ThinkingLevel | undefined }> {
  const catalog = await loadRoleCatalog({ defaultDir: defaultRoleDir(), userDir: userRoleDir(input.agentDir), projectDir: projectRoleDir(input.repositoryRoot),
    parseFrontmatter, projectTrusted: input.projectTrusted });
  const definition = catalog.roles.find((entry) => entry.name === input.role && entry.available)?.definition;
  const thinking = definition?.thinking === undefined || definition.thinking === "off" ? undefined : definition.thinking;
  if (!definition?.model) {
    if (!input.mainModel) throw new HostAuthorizationError("model_unavailable");
    return { model: input.mainModel, thinking };
  }
  const found = findDefinedModel(definition.model, input.registry.getAll(), input.mainModel?.provider);
  if (!found.ok) throw new HostAuthorizationError("internal_model_unavailable", `${LABEL[input.role]}配置的模型 ${definition.model} 不可用：${found.reason}`);
  const model = found.model;
  if (!input.registry.hasConfiguredAuth(model)) throw new HostAuthorizationError("internal_model_unavailable", `${LABEL[input.role]}配置的模型 ${definition.model} 没有可用的凭据`);
  return { model, thinking };
}
