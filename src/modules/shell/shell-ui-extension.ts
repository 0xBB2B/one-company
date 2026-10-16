import { randomUUID } from "node:crypto";
import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createClock } from "../../core/policy/clock.ts";
import type { Clock } from "../../core/policy/clock.ts";
import { BASH_PARAMETERS, createManagedBashTool, handleUserBash } from "./shell-bash.ts";
import { openShellPage } from "./shell-page.ts";
import type {
  OpenShellPageCtx,
  ShellPageClient,
  ShellPageRepo,
  ShellPageTheme,
} from "./shell-page.ts";
import type { ShellRegistry } from "../../core/host/shell-registry.ts";
import { sanitizeText } from "../../core/policy/text-sanitize.ts";
import { AdvisedError, adviceOf, toolFailure } from "../../core/exec/tool-failure.ts";
import type { Host } from "../../core/host/shell-registry.ts";
import { startShellStatusRefresh } from "./shell-summary.ts";
import type { ShellSummaryRepo } from "./shell-summary.ts";
import { currentDock, windowReady as defaultWindowReady } from "../../core/host/extension-lifecycle.ts";
import type { WindowContextValue } from "../../core/host/extension-lifecycle.ts";

const STATUS_KEY = "shell-summary";
const REFRESH_INTERVAL_MS = 1_000;

export interface ShellUiDeps {
  windowReady?: () => Promise<WindowContextValue>;
  createClock?: () => Clock;
}

interface CurrentSession {
  registry: ShellRegistry;
  host: Host;
  runToken: string;
  clock: Clock;
  repos: ShellPageRepo[];
}

let current: CurrentSession | undefined;
let startupFailure: string | undefined;

function buildTheme(ctx: OpenShellPageCtx): ShellPageTheme | undefined {
  const hostTheme = ctx.ui.theme;
  if (!hostTheme) return undefined;
  return {
    fg: (kind, text) => hostTheme.fg(kind, text),
    bg: (kind, text) => hostTheme.bg(kind, text),
    ...(hostTheme.bold ? { bold: (text: string) => hostTheme.bold!(text) } : {}),
  };
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

  const metadataBase = createBashToolDefinition(process.cwd(), {
    operations: metadataBashOperations(),
    exposeSessionEnvironment: false,
  });

  pi.registerTool({
    ...metadataBase,
    parameters: BASH_PARAMETERS,
    async execute(toolCallId, params, signal, onUpdate, execCtx) {
      if (!current) throw toolFailure("bash", new AdvisedError("shell_not_ready", startupFailure
        ? { why: `Shell 会话启动失败：${startupFailure}`, next: "命令不会执行；请用户重开窗口，仍失败就检查守护进程" }
        : { why: "Shell 会话还在启动中", next: "稍等几秒再执行命令" }));
      const routed = createManagedBashTool({
        registry: current.registry,
        host: current.host,
        cwd: execCtx?.cwd ?? process.cwd(),
        runToken: current.runToken,
      });
      // 命令本身的失败原样交出；只有宿主写了原因的错误（如停止尚未确认）换成三段说明
      try { return await routed.execute(toolCallId, params, signal, onUpdate, execCtx); }
      catch (error) { throw adviceOf(error) ? toolFailure("bash", error) : error; }
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
    startupFailure = undefined;

    const clock = resolveClock();
    const runToken = randomUUID();

    resolveWindowReady()
      .then((window) => {
        // session_shutdown 或更晚一次 session_start 可能在 windowReady 兑现前就已发生，此时这次会话已经过期
        if (myGeneration !== generation) { clock.stopGapWatcher(); return; }

        const registry = window.shellRegistry;
        const host: Host = { kind: "main", id: window.windowId };

        type WindowRepoClient = NonNullable<ReturnType<typeof window.clients.forRepo>>;
        const wrappedClients = new WeakMap<WindowRepoClient, ShellPageClient>();
        const resolveRepoClient = (repoId: string): ShellPageClient | undefined => {
          const client = window.clients.forRepo(repoId);
          if (!client) return undefined;
          const cached = wrappedClients.get(client);
          if (cached) return cached;
          const wrapped = {
            call: (method: string, params?: Record<string, unknown>) => client.call(method, params),
            connectionIdentity: () => client.connectionIdentity(),
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
                const client = repo.resolveClient();
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
        startupFailure = message;
        ctx.ui.notify?.(message, "error");
      });
  });

  pi.on("session_shutdown", async () => {
    generation++;
    teardown?.();
    teardown = undefined;
  });
}
