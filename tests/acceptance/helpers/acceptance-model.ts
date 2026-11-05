import { homedir } from "node:os";
import { join } from "node:path";
import { SettingsManager } from "@earendil-works/pi-coding-agent";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type Thinking = (typeof THINKING_LEVELS)[number];

export interface AcceptanceModel {
  provider: string;
  modelId: string;
  thinking: Thinking;
  credentialsDir: string;
}

export function resolveAcceptanceModel(): AcceptanceModel {
  const credentialsDir = process.env.ONE_COMPANY_ACCEPTANCE_CREDENTIALS ?? join(homedir(), ".pi", "agent");
  const settingsFile = join(credentialsDir, "settings.json");
  // projectTrusted:false 让 SettingsManager 忽略项目级 .pi/settings.json，只读凭据目录的全局配置
  const settings = SettingsManager.create(credentialsDir, credentialsDir, { projectTrusted: false });
  const errors = settings.drainErrors();
  if (errors.length) throw new Error(`读取 ${settingsFile} 失败：${errors.map((e) => e.error.message).join("；")}`);

  const override = process.env.ONE_COMPANY_ACCEPTANCE_MODEL;
  let provider: string, modelId: string;
  if (override) {
    const slash = override.indexOf("/");
    if (slash <= 0 || slash === override.length - 1) throw new Error("ONE_COMPANY_ACCEPTANCE_MODEL 须写成 <provider>/<model>");
    provider = override.slice(0, slash);
    modelId = override.slice(slash + 1);
  } else {
    const defaultProvider = settings.getDefaultProvider(), defaultModel = settings.getDefaultModel();
    if (!defaultProvider || !defaultModel) {
      throw new Error(`${settingsFile} 里没有配置 defaultProvider 和 defaultModel；请在其中配上，或设环境变量 ONE_COMPANY_ACCEPTANCE_MODEL 为 <provider>/<model>`);
    }
    provider = defaultProvider;
    modelId = defaultModel;
  }

  const thinking = process.env.ONE_COMPANY_ACCEPTANCE_THINKING ?? settings.getDefaultThinkingLevel() ?? "medium";
  if (!(THINKING_LEVELS as readonly string[]).includes(thinking)) throw new Error(`不支持的思考等级：${thinking}`);
  return { provider, modelId, thinking: thinking as Thinking, credentialsDir };
}
