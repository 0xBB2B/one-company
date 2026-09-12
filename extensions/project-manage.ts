import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { dataRoot } from "../runtime/identity.ts";
import { createProjectManageTool } from "../runtime/project-manage-tool.ts";
import type {
  OpenProjectIndexService,
  ProjectManageHostContext,
} from "../runtime/project-manage-tool.ts";
import { windowContext, windowReady } from "./lifecycle.ts";

export interface ProjectManageExtensionDeps {
  readonly dataRoot?: string;
  readonly openService?: OpenProjectIndexService;
  readonly windowReady?: typeof windowReady;
  readonly windowContext?: typeof windowContext;
}

function hostContext(
  window: Awaited<ReturnType<typeof windowReady>>,
  ctx: ExtensionContext,
): ProjectManageHostContext {
  const sessionId = ctx.sessionManager.getSessionId();
  if (window.sessionId !== sessionId) throw new Error("lifecycle 窗口与当前 session 不一致");
  return {
    windowId: window.windowId,
    sessionId,
    repositories: new Map(window.workspace.repos.map((repo) => [repo.repoId, { path: repo.path }])),
  };
}

export default function projectManageExtension(pi: ExtensionAPI, deps: ProjectManageExtensionDeps = {}): void {
  const awaitWindow = deps.windowReady ?? windowReady;
  const readWindow = deps.windowContext ?? windowContext;
  let lifecycleGeneration = 0;
  const runtime = createProjectManageTool({
    dataRoot: deps.dataRoot ?? dataRoot(process.env),
    resolveHost: async (ctx) => hostContext(await awaitWindow(), ctx),
    currentHost: (ctx) => hostContext(readWindow(), ctx),
    ...(deps.openService ? { openService: deps.openService } : {}),
  });

  pi.on("session_start", async (_event, ctx) => {
    const generation = ++lifecycleGeneration;
    const host = hostContext(await awaitWindow(), ctx);
    if (generation !== lifecycleGeneration) return;
    runtime.startSession(host);
  });

  pi.on("session_shutdown", async () => {
    lifecycleGeneration += 1;
    await runtime.shutdown();
  });

  pi.registerTool(runtime.tool);
}
