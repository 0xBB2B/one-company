import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AssistantMessage, Context, ToolCall } from "@earendil-works/pi-ai";
import { isRetryableAssistantError } from "@earendil-works/pi-ai/compat";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ScriptedReply } from "../../helpers/controlled-provider.ts";
import { copyCredentials } from "./installed-host.ts";
import type { AcceptanceConfig } from "./installed-host.ts";

export interface RealModel {
  /** 把受控提供方收到的请求原样交给真实模型，返回可以排进受控提供方的回复。 */
  answer(request: Context): Promise<ScriptedReply>;
  readonly replies: readonly AssistantMessage[];
  toolCalls(): ToolCall[];
  /** 把真实模型的回复与用量写进证据目录，并删掉复制出来的凭据。 */
  close(evidence: string): Promise<void>;
}

/** 单点测试在判断点之后由真实模型回答：凭据复制进场景的临时目录，用完即删，不动 ~/.pi/agent。 */
export async function createRealModel(root: string, config: AcceptanceConfig): Promise<RealModel> {
  const agentDir = join(root, "real-agent");
  await copyCredentials(config.credentialsDir, agentDir);
  const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json") });
  const model = runtime.getModel(config.provider, config.modelId);
  if (!model) throw new Error(`模型配置里找不到 ${config.provider}/${config.modelId}`);
  const replies: AssistantMessage[] = [], retries: string[] = [];
  return {
    replies,
    // 和宿主一样遇到过载、限流这类可重试错误时自动重试：默认 3 次，间隔从 2 秒起翻倍
    async answer(request) {
      let message = await runtime.completeSimple(model, request, { reasoning: config.thinking === "off" ? undefined : config.thinking });
      for (let retry = 0; retry < 3 && message.stopReason === "error" && isRetryableAssistantError(message); retry++) {
        retries.push(message.errorMessage ?? "");
        await new Promise((resolve) => setTimeout(resolve, 2_000 * 2 ** retry));
        message = await runtime.completeSimple(model, request, { reasoning: config.thinking === "off" ? undefined : config.thinking });
      }
      replies.push(message);
      return { type: "message", message };
    },
    toolCalls: () => replies.flatMap((message) => message.content.filter((block): block is ToolCall => block.type === "toolCall")),
    async close(evidence) {
      await rm(join(agentDir, "auth.json"), { force: true });
      await rm(join(agentDir, "models.json"), { force: true });
      const usage = replies.reduce((sum, message) => ({ input: sum.input + message.usage.input, output: sum.output + message.usage.output,
        cacheRead: sum.cacheRead + message.usage.cacheRead, cacheWrite: sum.cacheWrite + message.usage.cacheWrite }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
      await writeFile(join(evidence, "real-model.json"), `${JSON.stringify({ model: `${config.provider}/${config.modelId}`, thinking: config.thinking, usage, retries, replies }, null, 2)}\n`, { mode: 0o600 });
    },
  };
}
