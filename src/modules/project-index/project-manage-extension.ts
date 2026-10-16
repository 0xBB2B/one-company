import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { dataRoot } from "../../core/storage/identity.ts";
import { createProjectManageTool } from "./project-manage-tool.ts";
import type { OpenProjectIndexService, ProjectManageHostContext } from "./project-manage-tool.ts";
import { windowContext, windowReady } from "../../core/host/extension-lifecycle.ts";

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

/** 索引由守护进程持有：init/refresh/preview/status 都交给本仓库守护进程执行。 */
function daemonService(readWindow: typeof windowContext): OpenProjectIndexService {
  return async (input) => {
    const client = readWindow().clients.forRepo(input.repoId);
    if (!client) throw new Error("本仓库守护进程连接不可用");
    const call = async (action: string) => (await client.call("index.manage", { action })).result;
    return { preview: () => call("preview"), init: () => call("init"), refresh: () => call("refresh"), status: () => call("status") };
  };
}

export default function projectManageExtension(pi: ExtensionAPI, deps: ProjectManageExtensionDeps = {}): void {
  const awaitWindow = deps.windowReady ?? windowReady;
  const readWindow = deps.windowContext ?? windowContext;
  const runtime = createProjectManageTool({
    dataRoot: deps.dataRoot ?? dataRoot(process.env),
    resolveHost: async (ctx) => hostContext(await awaitWindow(), ctx),
    currentHost: (ctx) => hostContext(readWindow(), ctx),
    openService: deps.openService ?? daemonService(readWindow),
  });

  // 窗口就绪前 session 已关闭时，不能用迟到的窗口重新激活工具
  let generation = 0;
  pi.on("session_start", async (_event, ctx) => {
    const current = ++generation;
    const window = await awaitWindow();
    if (current === generation) runtime.startSession(hostContext(window, ctx));
  });
  pi.on("session_shutdown", () => { generation++; return runtime.shutdown(); });
  pi.registerTool(runtime.tool);
}
