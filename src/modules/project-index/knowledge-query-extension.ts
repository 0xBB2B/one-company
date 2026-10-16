import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createKnowledgeQueryTool } from "./knowledge-query-tool.ts";
import { windowContext } from "../../core/host/extension-lifecycle.ts";

export default function knowledgeQueryExtension(pi: ExtensionAPI, deps: { windowContext?: typeof windowContext } = {}): void {
  const currentWindow = deps.windowContext ?? windowContext;
  pi.registerTool(createKnowledgeQueryTool({
    client(repoId) {
      try { return currentWindow().clients.forRepo(repoId); } catch { return undefined; }
    },
  }).tool);
}
