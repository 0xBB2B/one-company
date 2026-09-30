import { createAssistantMessageEventStream, getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai";
import type { Api, AssistantMessage, Context, Model, TranscriptContext, Usage } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

export interface RegisterControlledProviderOptions {
  providerId: string;
  modelId: string;
  baseUrl?: string;
}

export type ScriptedReply = (
  | { type: "text"; text: string; chunkDelayMs?: number }
  | { type: "thinking"; text: string }
  | { type: "toolcall"; name: string; input: Record<string, unknown> }
  | { type: "error"; message: string }
) & { usage?: Partial<Pick<Usage, "input" | "output" | "cacheRead" | "cacheWrite">> };

export interface ControlledProvider {
  providerId: string;
  modelId: string;
  baseUrl: string;
  queue: ScriptedReply[];
  requests: Context[];
  /** 每次调用传入的思考等级，没传时为 undefined。 */
  reasoning: Array<string | undefined>;
  /** 队列为空时改为等待这里给出的回复；不设时空队列立即报错。 */
  awaitReply?: () => Promise<ScriptedReply | undefined>;
}

function zeroUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

export function registerControlledProvider(
  runtime: ModelRuntime,
  options: RegisterControlledProviderOptions,
): ControlledProvider {
  const { providerId, modelId, baseUrl } = options;
  if (runtime.getModels(providerId).length > 0) {
    throw new Error(`controlled provider 已在该 runtime 注册: ${providerId}`);
  }
  const handle: ControlledProvider = { providerId, modelId, baseUrl: baseUrl ?? "http://127.0.0.1:1", queue: [], requests: [], reasoning: [] };

  runtime.registerProvider(providerId, {
    apiKey: "controlled-key",
    baseUrl: baseUrl ?? "http://127.0.0.1:1",
    api: "anthropic-messages" as Api,
    models: [
      {
        id: modelId,
        name: modelId,
        reasoning: false,
        input: ["text"],
        contextWindow: 100000,
        maxTokens: 4096,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
    streamSimple(model: Model<Api>, context: TranscriptContext, options) {
      // 提供方收到的是系统消息内嵌的规范化请求；还原成断言所用的提示词、工具与对话三部分
      handle.reasoning.push(options?.reasoning);
      handle.requests.push({
        systemPrompt: getCurrentSystemPrompt(context.messages),
        tools: getCurrentTools(context.messages),
        messages: context.messages.filter((message) => message.role !== "system"),
      });
      const queued = handle.queue.shift();
      const stream = createAssistantMessageEventStream();
      const base: AssistantMessage = {
        role: "assistant",
        content: [],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: zeroUsage(),
        stopReason: "pending",
        timestamp: Date.now(),
      };

      queueMicrotask(() => { void (async () => {
        await options?.onPayload?.({ fixture: "controlled-provider" }, model);
        const reply = queued ?? await handle.awaitReply?.();
        base.usage = { ...zeroUsage(), ...reply?.usage };
        if (!reply) {
          stream.push({
            type: "error",
            reason: "error",
            error: { ...base, stopReason: "error", errorMessage: "未排队 scripted reply" },
          });
          return;
        }

        stream.push({ type: "start", partial: base });

        switch (reply.type) {
          case "text": {
            if (reply.chunkDelayMs !== undefined) {
              stream.push({ type: "text_start", contentIndex: 0, partial: base });
              setTimeout(() => {
                const message: AssistantMessage = {
                  ...base,
                  content: [{ type: "text", text: reply.text }],
                  stopReason: "stop",
                };
                stream.push({ type: "text_delta", contentIndex: 0, delta: reply.text, partial: message });
                stream.push({ type: "text_end", contentIndex: 0, content: reply.text, partial: message });
                stream.push({ type: "done", reason: "stop", message });
              }, reply.chunkDelayMs);
              break;
            }
            const message: AssistantMessage = {
              ...base,
              content: [{ type: "text", text: reply.text }],
              stopReason: "stop",
            };
            stream.push({ type: "done", reason: "stop", message });
            break;
          }
          case "thinking": {
            const message: AssistantMessage = {
              ...base,
              content: [{ type: "thinking", thinking: reply.text }],
              stopReason: "stop",
            };
            stream.push({ type: "done", reason: "stop", message });
            break;
          }
          case "toolcall": {
            const message: AssistantMessage = {
              ...base,
              content: [{ type: "toolCall", id: `call-${handle.requests.length}`, name: reply.name, arguments: reply.input }],
              stopReason: "toolUse",
            };
            stream.push({ type: "done", reason: "toolUse", message });
            break;
          }
          case "error": {
            const message: AssistantMessage = { ...base, stopReason: "error", errorMessage: reply.message };
            stream.push({ type: "error", reason: "error", error: message });
            break;
          }
        }
      })().catch((error) => stream.push({ type: "error", reason: "error", error: { ...base, stopReason: "error", errorMessage: String(error) } })); });

      return stream;
    },
  });

  return handle;
}

export function scriptReplies(provider: ControlledProvider, replies: ScriptedReply[]): void {
  provider.queue.push(...replies);
}

export function setReplies(provider: ControlledProvider, replies: ScriptedReply[]): void {
  provider.queue.splice(0, provider.queue.length, ...replies);
}

export function requestLog(provider: ControlledProvider): readonly Context[] {
  return provider.requests;
}
