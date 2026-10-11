import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { checkConventionsWrite } from "../runtime/project-conventions.ts";
import { windowContext as defaultWindowContext } from "./lifecycle.ts";
import type { WindowContextValue } from "./lifecycle.ts";

export default function conventionsGuardExtension(pi: ExtensionAPI, deps: { windowContext?: () => Pick<WindowContextValue, "workspace"> } = {}): void {
  const windowContext = deps.windowContext ?? defaultWindowContext;
  pi.on("tool_call", async (event, ctx) => {
    let roots: string[];
    try { roots = windowContext().workspace.repos.map((repo) => repo.path); } catch { return undefined; }
    return checkConventionsWrite(event, ctx.cwd, roots);
  });
}
