import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { HostAuthorizationManager } from "../runtime/host-authorization.ts";
import { dataRoot } from "../runtime/identity.ts";
import { createRequirementManageTool } from "../runtime/requirement-manage-tool.ts";
import type { OpenRequirementService, RequirementManageHostContext } from "../runtime/requirement-manage-tool.ts";
import { windowContext, windowReady } from "./lifecycle.ts";

export interface RequirementManageExtensionDeps {
  readonly authorization?: HostAuthorizationManager;
  readonly dataRoot?: string;
  readonly gitExecutable?: string;
  readonly openService?: OpenRequirementService;
  readonly windowReady?: typeof windowReady;
  readonly windowContext?: typeof windowContext;
}

export default function requirementManageExtension(pi: ExtensionAPI, deps: RequirementManageExtensionDeps = {}): void {
  const root = deps.dataRoot ?? dataRoot(process.env);
  const authorization = deps.authorization ?? new HostAuthorizationManager({ dataRoot: root });
  const awaitWindow = deps.windowReady ?? windowReady;
  const currentWindow = deps.windowContext ?? windowContext;

  pi.on("session_start", async (_event, ctx) => {
    const window = await awaitWindow();
    const sessionId = ctx.sessionManager.getSessionId();
    if (window.sessionId !== sessionId) throw new Error("lifecycle 窗口与当前 session 不一致");
    authorization.startWindow({
      kind: "main",
      windowId: window.windowId,
      sessionId,
      repoIds: window.workspace.repos.map((repo) => repo.repoId),
    });
  });

  pi.on("input", (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const window = currentWindow();
    if (window.sessionId !== sessionId) throw new Error("lifecycle 窗口与当前 session 不一致");
    authorization.captureInput(event.source, sessionId);
    return { action: "continue" };
  });

  pi.on("session_shutdown", () => {
    authorization.shutdown();
  });

  const resolveHost = async (ctx: ExtensionContext): Promise<RequirementManageHostContext> => {
    const window = await awaitWindow();
    const sessionId = ctx.sessionManager.getSessionId();
    if (window.sessionId !== sessionId) throw new Error("lifecycle 窗口与当前 session 不一致");
    return {
      windowId: window.windowId,
      sessionId: window.sessionId,
      repositories: new Map(window.workspace.repos.map((repo) => [repo.repoId, { path: repo.path }])),
    };
  };

  pi.registerTool(createRequirementManageTool({
    dataRoot: root,
    gitExecutable: deps.gitExecutable ?? "/usr/bin/git",
    authorization,
    resolveHost,
    ...(deps.openService ? { openService: deps.openService } : {}),
  }));
}
