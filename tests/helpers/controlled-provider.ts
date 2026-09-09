import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { Api, AssistantMessage, Context, Model, Usage } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

export interface RegisterControlledProviderOptions {
  providerId: string;
  modelId: string;
  baseUrl?: string;
}

export type ScriptedReply =
  | { type: "text"; text: string; chunkDelayMs?: number }
  | { type: "thinking"; text: string }
  | { type: "toolcall"; name: string; input: Record<string, unknown> }
  | { type: "error"; message: string };

export interface ControlledProvider {
  providerId: string;
  modelId: string;
  baseUrl: string;
  queue: ScriptedReply[];
  requests: Context[];
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
  const handle: ControlledProvider = { providerId, modelId, baseUrl: baseUrl ?? "http://127.0.0.1:1", queue: [], requests: [] };

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
    streamSimple(model: Model<Api>, context: Context) {
      handle.requests.push(context);
      const reply = handle.queue.shift();
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

      queueMicrotask(() => {
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
      });

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
