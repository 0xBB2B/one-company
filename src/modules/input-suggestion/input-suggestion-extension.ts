import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SuggestionEditor } from "./suggestion-editor.ts";
import { recentRounds, requestSuggestion } from "./suggestion-model.ts";

export default function inputSuggestionExtension(pi: ExtensionAPI): void {
  let editor: SuggestionEditor | undefined;
  let controller: AbortController | undefined;
  let generation = 0;

  const invalidate = () => {
    generation += 1;
    controller?.abort();
    controller = undefined;
  };

  pi.on("session_start", async (_event, ctx: ExtensionContext) => {
    invalidate();
    editor = undefined;
    if (ctx.mode !== "tui" || !ctx.hasUI) return;
    ctx.ui.setEditorComponent((tui, theme, keybindings) => {
      editor = new SuggestionEditor(tui, theme, keybindings, (text) => ctx.ui.theme.fg("dim", text));
      return editor;
    });
  });

  pi.on("agent_settled", async (event, ctx: ExtensionContext) => {
    const target = editor;
    if (!target || event.aborted) return;
    const branch = ctx.sessionManager.getBranch();
    const lastAssistant = branch.findLast((entry) => entry.type === "message" && entry.message.role === "assistant");
    if (lastAssistant?.type === "message" && lastAssistant.message.role === "assistant" && lastAssistant.message.stopReason !== "stop") return;
    invalidate();
    const mine = generation;
    const current = (controller = new AbortController());
    // 不等模型返回：pi 要等所有 agent_settled 处理器结束才算主代理空闲、才处理排队的消息
    void requestSuggestion({ registry: ctx.modelRegistry, model: ctx.model, rounds: recentRounds(branch), signal: current.signal })
      .then((suggestion) => { if (mine === generation) target.setSuggestion(suggestion); });
  });

  pi.on("input", async () => {
    invalidate();
    editor?.setSuggestion(undefined);
    return { action: "continue" };
  });

  pi.on("agent_start", async () => {
    invalidate();
    editor?.setSuggestion(undefined);
  });

  pi.on("session_shutdown", async () => {
    invalidate();
  });
}
