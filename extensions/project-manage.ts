import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { dataRoot } from "../runtime/identity.ts";
import { createProjectManageTool } from "../runtime/project-manage-tool.ts";
import type {
  OpenProjectIndexService,
  ProjectManageHostContext,
} from "../runtime/project-manage-tool.ts";
import { registerWindowShutdownHook, windowContext, windowReady } from "./lifecycle.ts";
import { ProjectSyncClientSession } from "../runtime/project-sync-client.ts";
import type { ProjectSyncBaselineCapture, ProjectSyncBinding, ProjectSyncController } from "../runtime/project-sync-client.ts";

const controllers = new Map<string, ProjectSyncController>();
interface HostBinding {
  current(): boolean;
  captureUnmanaged(signal?: AbortSignal): Promise<ProjectSyncBaselineCapture>;
}
const hostBindings = new Map<string, HostBinding>();
const controllerListeners = new Set<(controller: ProjectSyncController) => void>();
const bindingKey = (binding: ProjectSyncBinding): string => JSON.stringify([binding.windowId, binding.sessionId, binding.repoId]);

/** 仅供同宿主受控门槛使用；不注册为模型工具。 */
export function activeProjectSyncController(binding: ProjectSyncBinding): ProjectSyncController | undefined {
  return controllers.get(bindingKey(binding));
}

export async function captureProjectFreshBaseline(binding: ProjectSyncBinding, signal?: AbortSignal): Promise<ProjectSyncBaselineCapture> {
  signal?.throwIfAborted();
  const current = hostBindings.get(bindingKey(binding));
  if (!current?.current()) throw new Error("项目索引宿主绑定已失效");
  const controller = activeProjectSyncController(binding);
  if (controller) return controller.captureFreshBaseline(signal);
  const captured = await current.captureUnmanaged(signal);
  signal?.throwIfAborted();
  if (hostBindings.get(bindingKey(binding)) !== current || !current.current() || activeProjectSyncController(binding)) {
    throw new Error("项目索引宿主绑定或管理状态已变化");
  }
  return captured;
}

export function subscribeProjectSyncControllers(listener: (controller: ProjectSyncController) => void): () => void {
  if (controllerListeners.size >= 64) throw new Error("项目索引宿主订阅已满");
  controllerListeners.add(listener);
  return () => { controllerListeners.delete(listener); };
}

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
  let sync: ProjectSyncClientSession | undefined;
  const ownedControllers = new Set<ProjectSyncController>();
  const ownedBindings = new Map<string, HostBinding>();
  let unsubscribeShutdown: (() => void) | undefined;
  let shutdownTask: Promise<void> | undefined;
  const runtime = createProjectManageTool({
    dataRoot: deps.dataRoot ?? dataRoot(process.env),
    resolveHost: async (ctx) => hostContext(await awaitWindow(), ctx),
    currentHost: (ctx) => hostContext(readWindow(), ctx),
    openService: deps.openService ?? ((input) => {
      if (!sync) throw new Error("项目持续索引宿主尚未启动");
      return sync.openService(input);
    }),
  });

  const shutdown = (): Promise<void> => {
    if (shutdownTask) return shutdownTask;
    lifecycleGeneration += 1;
    unsubscribeShutdown?.();
    unsubscribeShutdown = undefined;
    const current = sync;
    sync = undefined;
    for (const controller of ownedControllers) {
      const key = bindingKey(controller.binding);
      if (controllers.get(key) === controller) controllers.delete(key);
    }
    ownedControllers.clear();
    for (const [key, current] of ownedBindings) if (hostBindings.get(key) === current) hostBindings.delete(key);
    ownedBindings.clear();
    const pending = [runtime.shutdown(), current?.shutdown()];
    shutdownTask = Promise.allSettled(pending).then((results) => {
      if (results.some((result) => result.status === "rejected")) throw new Error("项目持续索引撤权或收尾未完成");
    });
    return shutdownTask;
  };

  pi.on("session_start", async (_event, ctx) => {
    const generation = ++lifecycleGeneration;
    const window = await awaitWindow();
    const host = hostContext(window, ctx);
    if (generation !== lifecycleGeneration) return;
    runtime.startSession(host);
    shutdownTask = undefined;
    const isCurrentHost = (): boolean => {
      try {
        if (generation !== lifecycleGeneration || ctx.sessionManager.getSessionId() !== host.sessionId) return false;
        const current = readWindow();
        return current.windowId === host.windowId && current.sessionId === host.sessionId && current.clients === window.clients;
      } catch { return false; }
    };
    if (!deps.openService) sync = new ProjectSyncClientSession({
      dataRoot: deps.dataRoot ?? dataRoot(process.env), host, cwd: ctx.cwd, clients: window.clients,
      isCurrentHost,
      onController: (controller) => {
        const previous = controllers.get(bindingKey(controller.binding));
        if (previous) ownedControllers.delete(previous);
        ownedControllers.add(controller);
        controllers.set(bindingKey(controller.binding), controller);
        for (const listener of controllerListeners) { try { listener(controller); } catch { /* 消费者错误不扩权或中止其他订阅。 */ } }
      },
    });
    if (sync) for (const [repoId] of host.repositories) {
      const key = bindingKey({ ...host, repoId });
      const session = sync;
      const binding: HostBinding = { current: isCurrentHost, captureUnmanaged: (signal) => session.captureUnmanaged(repoId, signal) };
      ownedBindings.set(key, binding);
      hostBindings.set(key, binding);
    }
    unsubscribeShutdown = registerWindowShutdownHook(window, shutdown);
  });

  pi.on("session_shutdown", () => shutdown());

  pi.registerTool(runtime.tool);
}
