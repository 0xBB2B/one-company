import { randomUUID } from "node:crypto";
import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createClock } from "../runtime/clock.ts";
import type { Clock } from "../runtime/clock.ts";
import { BASH_PARAMETERS, createManagedBashTool, handleUserBash } from "../runtime/shell-bash.ts";
import { openShellPage } from "../runtime/shell-page.ts";
import type {
  OpenShellPageCtx,
  ShellPageClient,
  ShellPageRepo,
  ShellPageTheme,
} from "../runtime/shell-page.ts";
import { ShellRegistry } from "../runtime/shell-registry.ts";
import { sanitizeText } from "../runtime/text-sanitize.ts";
import type { Host } from "../runtime/shell-registry.ts";
import { startShellStatusRefresh } from "../runtime/shell-summary.ts";
import type { ShellSummaryRepo } from "../runtime/shell-summary.ts";
import { currentDock, windowReady as defaultWindowReady } from "./lifecycle.ts";
import type { WindowContextValue } from "./lifecycle.ts";

const STATUS_KEY = "shell-summary";
const REFRESH_INTERVAL_MS = 1_000;

export interface ShellUiDeps {
  windowReady?: () => Promise<WindowContextValue>;
  createClock?: () => Clock;
  createShellRegistry?: (clock: Clock) => ShellRegistry;
}

interface CurrentSession {
  registry: ShellRegistry;
  host: Host;
  runToken: string;
  clock: Clock;
  repos: ShellPageRepo[];
}

let current: CurrentSession | undefined;

function buildTheme(ctx: OpenShellPageCtx): ShellPageTheme | undefined {
  const hostTheme = ctx.ui.theme;
  if (!hostTheme) return undefined;
  return { bg: (kind, text) => hostTheme.bg(kind, text) };
}

export async function openShellUiPage(ctx: OpenShellPageCtx): Promise<void> {
  if (!current) throw new Error("Shell 会话尚未就绪");
  const dock = currentDock();
  if (!dock) throw new Error("底部区块尚未就绪");
  const session = current;
  await openShellPage({
    ctx,
    registry: session.registry,
    repos: session.repos,
    clock: session.clock,
    dock,
    theme: buildTheme(ctx),
  });
}

// 仅用于取工具静态元数据（name/description/promptGuidelines）；execute 会被下方路由到最新会话，永不落到这里
function metadataBashOperations() {
  return { exec: async () => ({ exitCode: 1 }) };
}

export default function shellUiExtension(pi: ExtensionAPI, deps: ShellUiDeps = {}): void {
  const resolveWindowReady = deps.windowReady ?? defaultWindowReady;
  const resolveClock = deps.createClock ?? (() => createClock());
  const resolveShellRegistry = deps.createShellRegistry ?? ((clock) => new ShellRegistry({ clock }));

  const metadataBase = createBashToolDefinition(process.cwd(), {
    operations: metadataBashOperations(),
    exposeSessionEnvironment: false,
  });

  pi.registerTool({
    ...metadataBase,
    parameters: BASH_PARAMETERS,
    async execute(toolCallId, params, signal, onUpdate, execCtx) {
      if (!current) throw new Error("Shell 会话尚未就绪");
      const routed = createManagedBashTool({
        registry: current.registry,
        host: current.host,
        cwd: execCtx?.cwd ?? process.cwd(),
        runToken: current.runToken,
      });
      return routed.execute(toolCallId, params, signal, onUpdate, execCtx);
    },
  });

  pi.on("user_bash", async (event) => {
    // 会话尚未就绪或已关停时不能回落到宿主未托管的执行路径：不给 operations，让 SDK 直接采用这份 result
    if (!current) {
      return {
        result: { output: "Shell 会话尚未就绪，命令未执行", exitCode: 1, cancelled: false, truncated: false },
      };
    }
    return handleUserBash(event as { command: string; cwd: string; excludeFromContext: boolean }, {
      registry: current.registry,
      host: current.host,
      runToken: current.runToken,
    });
  });

  let teardown: (() => void) | undefined;
  let generation = 0;

  pi.on("session_start", async (_event, ctx: ExtensionContext) => {
    teardown?.();
    teardown = undefined;
    current = undefined;
    const myGeneration = ++generation;

    const clock = resolveClock();
    let registry = resolveShellRegistry(clock);
    const runToken = randomUUID();

    resolveWindowReady()
      .then((window) => {
        // session_shutdown 或更晚一次 session_start 可能在 windowReady 兑现前就已发生，此时这次会话已经过期
        if (myGeneration !== generation) { clock.stopGapWatcher(); return; }

        registry = window.shellRegistry ?? registry;
        const host: Host = { kind: "main", id: window.windowId };

        type WindowRepoClient = NonNullable<ReturnType<typeof window.clients.forRepo>>;
        const wrappedClients = new WeakMap<WindowRepoClient, ShellPageClient>();
        const resolveRepoClient = (repoId: string): ShellPageRepo["client"] => {
          const client = window.clients.forRepo(repoId);
          if (!client) return undefined;
          const cached = wrappedClients.get(client);
          if (cached) return cached;
          const wrapped = {
            call: (method: string, params?: Record<string, unknown>) => client.call(method, params),
            ...(client.connectionIdentity ? { connectionIdentity: () => client.connectionIdentity!() } : {}),
          };
          wrappedClients.set(client, wrapped);
          return wrapped;
        };
        const repos: ShellPageRepo[] = window.workspace.repos.map(({ repoId }) => ({
          repoId,
          resolveClient: () => resolveRepoClient(repoId),
        }));

        current = {
          registry,
          host,
          runToken,
          clock,
          repos,
        };

        let stopRefresh: (() => void) | undefined;
        if (ctx.mode === "tui" && ctx.hasUI) {
          const summaryRepos: ShellSummaryRepo[] = repos.map((repo) => ({
            repoId: repo.repoId,
            client: {
              call: (method, params) => {
                const client = repo.resolveClient ? repo.resolveClient() : repo.client;
                if (!client) throw new Error("连接不可用，Shell 状态未知");
                return client.call(method, params);
              },
            },
          }));
          stopRefresh = startShellStatusRefresh(
            {
              registry,
              repos: summaryRepos,
              clock,
              statusBar: { setStatus: (text) => ctx.ui.setStatus(STATUS_KEY, text) },
            },
            REFRESH_INTERVAL_MS,
          );
        }

        teardown = () => {
          stopRefresh?.();
          ctx.ui.setStatus(STATUS_KEY, undefined);
          clock.stopGapWatcher();
          void registry.closeOwner(host);
          if (current?.registry === registry) current = undefined;
        };
      })
      .catch((error: unknown) => {
        clock.stopGapWatcher();
        if (myGeneration !== generation) return;
        let message = "Shell 状态不可用";
        try {
          const value = typeof error === "string" ? error : error && typeof error === "object" ? Object.getOwnPropertyDescriptor(error, "message")?.value : undefined;
          if (typeof value === "string") message = sanitizeText(value, 200).replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
        } catch { /* 保留固定错误，不执行外部对象转换。 */ }
        ctx.ui.notify?.(message, "error");
      });
  });

  pi.on("session_shutdown", async () => {
    generation++;
    teardown?.();
    teardown = undefined;
  });
}
