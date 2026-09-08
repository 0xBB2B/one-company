import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { dataRoot } from "../runtime/identity.ts";
import { createWorkflowTool } from "../runtime/workflow-tool.ts";

export default function workflowExtension(pi: ExtensionAPI): void {
  pi.registerTool(createWorkflowTool({ dataRoot: dataRoot(process.env), cwd: process.cwd() }));
}
