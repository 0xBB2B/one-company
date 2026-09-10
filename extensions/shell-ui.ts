import { mainWriteProtection } from "./write-protection.ts";
import { randomUUID } from "node:crypto";
import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createClock } from "../runtime/clock.ts";
import type { Clock } from "../runtime/clock.ts";
import { appendDecision } from "../runtime/decisions.ts";
import { dataRoot as resolveDataRoot } from "../runtime/identity.ts";
import { BASH_PARAMETERS, createManagedBashTool, handleUserBash } from "../runtime/shell-bash.ts";
import { openShellPage } from "../runtime/shell-page.ts";
import type {
  OpenShellPageCtx,
  ShellPageDecisionResult,
  ShellPageDecisionTask,
  ShellPageRepo,
  ShellPageTheme,
} from "../runtime/shell-page.ts";
import { ShellRegistry } from "../runtime/shell-registry.ts";
import type { Host } from "../runtime/shell-registry.ts";
import { startShellStatusRefresh } from "../runtime/shell-summary.ts";
import type { ShellSummaryRepo } from "../runtime/shell-summary.ts";
import { currentDock, windowReady as defaultWindowReady } from "./lifecycle.ts";
import type { WindowContextValue } from "./lifecycle.ts";

const STATUS_KEY = "shell-summary";
const REFRESH_INTERVAL_MS = 1_000;

export interface ShellUiDeps {
  windowReady?: () => Promise<WindowContextValue>;
  commandGuard?: (cwd: string) => Promise<import("../runtime/shell-bash.ts").BashCommandGuard>;
  createClock?: () => Clock;
  createShellRegistry?: (clock: Clock) => ShellRegistry;
}

interface CurrentSession {
  registry: ShellRegistry;
  host: Host;
  runToken: string;
  clock: Clock;
  repos: ShellPageRepo[];
  recordStopDecision: (task: ShellPageDecisionTask) => Promise<ShellPageDecisionResult>;
}

let current: CurrentSession | undefined;

async function recordStopDecision(cwd: string, task: ShellPageDecisionTask): Promise<ShellPageDecisionResult> {
  try {
    const receipt = await appendDecision(
      {
        actor: "user",
        requirement: task.requirement,
        source: "shell-page",
        trigger: `用户在 Shell 管理页对任务 ${task.taskId} 选择视为已停止`,
        decision: `将任务 ${task.taskId}（${task.command}）裁定为已停止`,
        effects: [`任务 ${task.taskId} 不再计入活动 Shell`],
        alternatives: [],
        impact: "清理无法自动确认，由用户人工裁定该任务已停止",
      },
      { dataRoot: resolveDataRoot(process.env), cwd },
    );
    return { ok: true, decisionId: receipt.decisionId };
  } catch (error) {
    return { ok: false, reason: (error as Error).message };
  }
}

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
    recordStopDecision: session.recordStopDecision,
    theme: buildTheme(ctx),
  });
}

// 仅用于取工具静态元数据（name/description/promptGuidelines）；execute 会被下方路由到最新会话，永不落到这里
function metadataBashOperations() {
  return { exec: async () => ({ exitCode: 1 }) };
}

export default function shellUiExtension(pi: ExtensionAPI, deps: ShellUiDeps = {}): void {
  const resolveCommandGuard = deps.commandGuard ?? (async (cwd) => (await mainWriteProtection(cwd)).commandGuard);
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
        guard: await resolveCommandGuard(execCtx?.cwd ?? process.cwd()),
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
      guard: await resolveCommandGuard((event as { cwd?: string }).cwd ?? process.cwd()),
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
        if (myGeneration !== generation) return;

        registry = window.shellRegistry ?? registry;
        const host: Host = { kind: "main", id: window.windowId };

        const repoEntries = window.workspace.repos
          .map((repo) => ({ repoId: repo.repoId, client: window.clients.forRepo(repo.repoId) }))
          .filter((entry): entry is typeof entry & { client: NonNullable<(typeof entry)["client"]> } => entry.client !== undefined);
        const callRepo = (client: NonNullable<ReturnType<typeof window.clients.forRepo>>) => ({
          call: (method: string, params?: Record<string, unknown>) => client.call(method, params),
        });
        const repos: ShellPageRepo[] = repoEntries.map(({ repoId, client }) => ({ repoId, client: callRepo(client) }));

        current = {
          registry,
          host,
          runToken,
          clock,
          repos,
          recordStopDecision: (task) => recordStopDecision(ctx.cwd, task),
        };

        let stopRefresh: (() => void) | undefined;
        if (ctx.mode === "tui" && ctx.hasUI) {
          const summaryRepos: ShellSummaryRepo[] = repos;
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
        if (myGeneration !== generation) return;
        ctx.ui.notify?.((error as Error).message, "error");
      });
  });

  pi.on("session_shutdown", async () => {
    generation++;
    teardown?.();
    teardown = undefined;
  });
}
