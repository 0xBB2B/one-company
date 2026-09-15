import { basename } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { AgentsActivity, MAX_MIRRORED_RUNS_PER_REPO } from "../runtime/agents-activity.ts";
import type { ActivityEvent, RunsChangedPayload, WorkspaceRepo } from "../runtime/agents-activity.ts";
import { mountAgentsPanel } from "../runtime/agents-panel.ts";
import type { AgentsPanelClient } from "../runtime/agents-panel.ts";
import { createClock } from "../runtime/clock.ts";
import { sanitizeText } from "../runtime/text-sanitize.ts";
import { DAEMON_CLIENT_LIFECYCLE_EVENTS } from "../runtime/daemon-client.ts";
import type { Clock } from "../runtime/clock.ts";
import { BottomDock } from "../runtime/dock.ts";
import { registerDock, windowReady as defaultWindowReady } from "./lifecycle.ts";
import type { WindowContextValue } from "./lifecycle.ts";

const REFRESH_INTERVAL_MS = 1_000;

function externalErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : "未知错误";
  return sanitizeText(raw, 200).replace(/\s+/g, " ").trim() || "未知错误";
}

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
          .map((repo) => ({ repoId: repo.repoId, client: window.clients.forRepo(repo.repoId) }))
          .filter((entry): entry is typeof entry & { client: NonNullable<(typeof entry)["client"]> } => entry.client !== undefined);

        const activity = resolveActivity({
          clock,
          workspaceRepos: window.workspace.repos.map(({ repoId, path }) => ({ repoId, name: basename(path) })),
        });

        const mirrorConnections = new Map<string, { client: (typeof repoEntries)[number]["client"]; identity: string | undefined }>();
        const requestSnapshot = (repoId: string, client: (typeof repoEntries)[number]["client"]): void => {
          const sequence = activity.beginSnapshot(repoId), identity = JSON.stringify(client.connectionIdentity?.());
          if (sequence === undefined) return;
          void client.call("subscribe.activity", {}).then((result) => {
            if (myGeneration !== generation) return;
            if (window.clients.forRepo(repoId) !== client || client.state().status !== "connected" || JSON.stringify(client.connectionIdentity?.()) !== identity || !Array.isArray(result.snapshot)) {
              activity.failSnapshot(repoId, sequence); return;
            }
            const rawSnapshot = result.snapshot;
            const applied = activity.applySnapshot(
              repoId,
              sequence,
              rawSnapshot.slice(0, MAX_MIRRORED_RUNS_PER_REPO * 2).map((run) => ({ run,
                pendingShellCleanup: run && typeof run === "object" ? Object.getOwnPropertyDescriptor(run, "pendingShellCleanup")?.value : undefined,
                activeShellTasks: run && typeof run === "object" ? Object.getOwnPropertyDescriptor(run, "activeShellTasks")?.value : undefined,
              })) as RunsChangedPayload[],
              result.coverage,
              rawSnapshot.length,
            );
            if (applied) mirrorConnections.set(repoId, { client, identity });
          }).catch((error: unknown) => {
            if (myGeneration !== generation) return;
            activity.failSnapshot(repoId, sequence);
            ctx.ui.notify(`代理快照读取失败：${externalErrorMessage(error)}`, "error");
          });
        };

        const unsubscribes: Array<() => void> = [];
        for (const { repoId, client } of repoEntries) {
          activity.applyConnectionState(repoId, client.state());
          // 初次订阅的实时事件来自这条连接；重连则等待新快照建立镜像绑定。
          mirrorConnections.set(repoId, { client, identity: JSON.stringify(client.connectionIdentity?.()) });
          unsubscribes.push(
            client.subscribe("runs.changed", (data) =>
              activity.applyRunsChanged(repoId, data as unknown as RunsChangedPayload),
            ),
          );
          unsubscribes.push(client.subscribe("activity", (data) => activity.applyActivity(repoId, data as unknown as ActivityEvent)));
          unsubscribes.push(client.subscribe(DAEMON_CLIENT_LIFECYCLE_EVENTS.disconnected, () => {
            mirrorConnections.delete(repoId); activity.applyConnectionState(repoId, { status: "unreachable" });
          }));
          unsubscribes.push(client.subscribe(DAEMON_CLIENT_LIFECYCLE_EVENTS.connected, () => {
            activity.applyConnectionState(repoId, client.state()); requestSnapshot(repoId, client);
          }));
          requestSnapshot(repoId, client);
        }

        const panelClients = {
          forRepo: (repoId: string): AgentsPanelClient | undefined => {
            const client = window.clients.forRepo(repoId), mirrored = mirrorConnections.get(repoId);
            return client && mirrored?.client === client && JSON.stringify(client.connectionIdentity?.()) === mirrored.identity ? client : undefined;
          },
        };

        let dock: BottomDock | undefined;

        const mountResult = mountAgentsPanel(
          { mode: ctx.mode, hasUI: ctx.hasUI, ui: ctx.ui },
          {
            activity,
            clock,
            clients: panelClients,
          },
        );

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
          registerDock(dock);

          refreshHandle = clock.setIntervalExcludingSleep(() => {
            for (const { repoId, client } of repoEntries) {
              if (activity.applyConnectionState(repoId, client.state())) requestSnapshot(repoId, client);
            }
            mountResult.panel?.tick();
            mountResult.host?.requestRender();
          }, REFRESH_INTERVAL_MS);
        }

        teardown = () => {
          if (refreshHandle) clock.clearTimer(refreshHandle);
          for (const unsubscribe of unsubscribes) unsubscribe();
          dock?.release();
          registerDock(undefined);
          mountResult.unmount?.();
          clock.stopGapWatcher();
        };
      })
      .catch((error: unknown) => {
        if (myGeneration !== generation) return;
        ctx.ui.notify(externalErrorMessage(error), "error");
      });
  });

  pi.on("session_shutdown", async () => {
    generation++;
    teardown?.();
    teardown = undefined;
  });
}
