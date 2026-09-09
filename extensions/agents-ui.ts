import { basename } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { AgentsActivity } from "../runtime/agents-activity.ts";
import type { ActivityEvent, RunsChangedPayload, WorkspaceRepo } from "../runtime/agents-activity.ts";
import { mountAgentsPanel } from "../runtime/agents-panel.ts";
import type { AgentsPanelClient } from "../runtime/agents-panel.ts";
import { createClock } from "../runtime/clock.ts";
import type { Clock } from "../runtime/clock.ts";
import { BottomDock } from "../runtime/dock.ts";
import { windowReady as defaultWindowReady } from "./lifecycle.ts";
import type { WindowContextValue } from "./lifecycle.ts";

const REFRESH_INTERVAL_MS = 1_000;

export interface AgentsUiDeps {
  windowReady?: () => Promise<WindowContextValue>;
  createClock?: () => Clock;
  createAgentsActivity?: (options: { clock: Clock; workspaceRepos: WorkspaceRepo[] }) => AgentsActivity;
}

export default function agentsUiExtension(pi: ExtensionAPI, deps: AgentsUiDeps = {}): void {
  const resolveWindowReady = deps.windowReady ?? defaultWindowReady;
  const resolveClock = deps.createClock ?? (() => createClock());
  const resolveActivity = deps.createAgentsActivity ?? ((options) => new AgentsActivity(options));

  let teardown: (() => void) | undefined;
  let generation = 0;

  pi.on("session_start", async (_event, ctx: ExtensionContext) => {
    teardown?.();
    teardown = undefined;
    const myGeneration = ++generation;
    if (ctx.mode !== "tui" || !ctx.hasUI) return;

    resolveWindowReady()
      .then((window) => {
        // session_shutdown 或更晚一次 session_start 可能在 windowReady 兑现前就已发生，此时这次挂载已经过期
        if (myGeneration !== generation) return;

        const clock = resolveClock();
        const repoEntries = window.workspace.repos
          .map((repo) => ({ repoId: repo.repoId, name: basename(repo.path), client: window.clients.forRepo(repo.repoId) }))
          .filter((entry): entry is typeof entry & { client: NonNullable<(typeof entry)["client"]> } => entry.client !== undefined);

        const activity = resolveActivity({
          clock,
          workspaceRepos: repoEntries.map(({ repoId, name }) => ({ repoId, name })),
        });

        const unsubscribes: Array<() => void> = [];
        for (const { repoId, client } of repoEntries) {
          unsubscribes.push(
            client.subscribe("runs.changed", (data) =>
              activity.applyRunsChanged(repoId, data as unknown as RunsChangedPayload),
            ),
          );
          unsubscribes.push(client.subscribe("activity", (data) => activity.applyActivity(data as unknown as ActivityEvent)));
        }

        const panelClients = {
          forRepo: (repoId: string): AgentsPanelClient | undefined => {
            const client = window.clients.forRepo(repoId);
            return client ? { call: (method: string, params?: Record<string, unknown>) => client.call(method, params) } : undefined;
          },
        };

        const mountResult = mountAgentsPanel(
          { mode: ctx.mode, hasUI: ctx.hasUI, ui: ctx.ui },
          { activity, clock, clients: panelClients, onView: () => {} },
        );

        let dock: BottomDock | undefined;
        let refreshHandle: ReturnType<Clock["setIntervalExcludingSleep"]> | undefined;

        if (mountResult.mounted && mountResult.panel) {
          dock = new BottomDock({
            terminalInput: { onInput: (handler) => ctx.ui.onTerminalInput(handler) },
            panel: mountResult.panel,
            getEditorText: () => ctx.ui.getEditorText(),
            isCompletionOpen: () => mountResult.host?.isCompletionOpen() ?? false,
            isOverlayOpen: () => mountResult.host?.isOverlayOpen() ?? false,
          });
          dock.attach();

          refreshHandle = clock.setIntervalExcludingSleep(() => {
            for (const { repoId, client } of repoEntries) activity.applyConnectionState(repoId, client.state());
            mountResult.panel?.tick();
            mountResult.host?.requestRender();
          }, REFRESH_INTERVAL_MS);
        }

        teardown = () => {
          if (refreshHandle) clock.clearTimer(refreshHandle);
          for (const unsubscribe of unsubscribes) unsubscribe();
          dock?.release();
          mountResult.unmount?.();
          clock.stopGapWatcher();
        };
      })
      .catch((error: unknown) => {
        if (myGeneration !== generation) return;
        ctx.ui.notify((error as Error).message, "error");
      });
  });

  pi.on("session_shutdown", async () => {
    generation++;
    teardown?.();
    teardown = undefined;
  });
}
