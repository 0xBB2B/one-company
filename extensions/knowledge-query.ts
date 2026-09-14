import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createKnowledgeQueryTool } from "../runtime/knowledge-query-tool.ts";
import { activeProjectSyncController } from "./project-manage.ts";
import { windowContext } from "./lifecycle.ts";

export default function knowledgeQueryExtension(pi: ExtensionAPI, deps: { windowContext?: typeof windowContext } = {}): void {
  const currentWindow = deps.windowContext ?? windowContext;
  const runtime = createKnowledgeQueryTool({
    controller(ctx, repoId) {
      try {
        const window = currentWindow(), sessionId = ctx.sessionManager.getSessionId();
        if (window.sessionId !== sessionId || !window.workspace.repos.some((repo) => repo.repoId === repoId)) return undefined;
        const controller = activeProjectSyncController({ windowId: window.windowId, sessionId, repoId });
        if (controller?.workspace.root !== window.workspace.repos.find((repo) => repo.repoId === repoId)?.path) return undefined;
        return controller;
      } catch { return undefined; }
    },
  });
  pi.registerTool(runtime.tool);
  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName !== runtime.tool.name) return;
    try {
      const assertLive = await runtime.checkResult(event.toolCallId, event.content, ctx);
      assertLive();
    }
    catch {
      return { isError: true, content: [{ type: "text", text: JSON.stringify({ status: "unavailable", reason: "查询结果未通过当前授权及项目基线复核", facts: [] }) }], details: {} };
    }
  });
  pi.on("session_shutdown", () => runtime.shutdown());
}
