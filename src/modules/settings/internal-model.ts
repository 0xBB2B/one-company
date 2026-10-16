import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { Api, Model, ThinkingLevel } from "@earendil-works/pi-ai";
import { HostAuthorizationError } from "../requirement/host-authorization.ts";
import { readAgentSettings } from "./agent-settings.ts";
import { findDefinedModel } from "../agents/model-ref.ts";

const LABEL = { interpreter: "解释器", "draft-verifier": "草稿核验器" } as const;

/** 按设定里该角色的模型与思考等级决定这次调用；设定写 null 时跟主窗口，思考为 off 即不思考。 */
export async function resolveInternalModel(input: { role: keyof typeof LABEL; agentDir: string; repositoryRoot: string; projectTrusted: boolean;
  registry: Pick<ModelRegistry, "getAll" | "hasConfiguredAuth">; mainModel: Model<Api> | undefined; mainThinking: string }): Promise<{ model: Model<Api>; thinking: ThinkingLevel | undefined }> {
  const setting = (await readAgentSettings(input)).values[input.role];
  const level = setting.thinking ?? input.mainThinking;
  const thinking = level === "off" ? undefined : level as ThinkingLevel;
  if (!setting.model) {
    if (!input.mainModel) throw new HostAuthorizationError("internal_model_unavailable", `${LABEL[input.role]}跟随主窗口的模型，但主窗口没有选定模型`);
    return { model: input.mainModel, thinking };
  }
  const found = findDefinedModel(setting.model, input.registry.getAll(), input.mainModel?.provider);
  if (!found.ok) throw new HostAuthorizationError("internal_model_unavailable", `${LABEL[input.role]}配置的模型 ${setting.model} 不可用：${found.reason}`);
  const model = found.model;
  if (!input.registry.hasConfiguredAuth(model)) throw new HostAuthorizationError("internal_model_unavailable", `${LABEL[input.role]}配置的模型 ${setting.model} 没有可用的凭据`);
  return { model, thinking };
}
