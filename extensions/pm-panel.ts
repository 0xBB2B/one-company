import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createClock } from "../runtime/clock.ts";
import type { Clock } from "../runtime/clock.ts";
import { DAEMON_CLIENT_LIFECYCLE_EVENTS } from "../runtime/daemon-client.ts";
import { BottomDock } from "../runtime/dock.ts";
import type { PmOverview } from "../runtime/pm-overview.ts";
import { mountPmPanel } from "../runtime/pm-panel.ts";
import type { PmPanelEntry } from "../runtime/pm-panel.ts";
import { sanitizeText } from "../runtime/text-sanitize.ts";
import { registerDock, revokeCapturedInput, windowReady as defaultWindowReady } from "./lifecycle.ts";
import type { WindowContextValue } from "./lifecycle.ts";

const TICK_MS = 200;
const RESYNC_MS = 5_000;

function message(error: unknown): string {
  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : "未知错误";
  return sanitizeText(raw, 200).replace(/\s+/g, " ").trim() || "未知错误";
}

export interface PmPanelUiDeps {
  windowReady?: () => Promise<WindowContextValue>;
  createClock?: () => Clock;
}

/** 主窗口 PM 面板：向各仓库守护进程拉取 PM 概览，概览变化信号到达时重拉；事项按回车插入决策包并由主代理接着回复。 */
export default function pmPanelExtension(pi: ExtensionAPI, deps: PmPanelUiDeps = {}): void {
  const resolveWindowReady = deps.windowReady ?? defaultWindowReady;
  const resolveClock = deps.createClock ?? (() => createClock());
  let teardown: (() => void) | undefined;
  let generation = 0;

  pi.on("session_start", async (_event, ctx: ExtensionContext) => {
    teardown?.(); teardown = undefined;
    const myGeneration = ++generation;
    if (ctx.mode !== "tui" || !ctx.hasUI) return;
    resolveWindowReady().then((window) => {
      if (myGeneration !== generation) return;
      const clock = resolveClock();
      const byRepo = new Map<string, PmPanelEntry[]>();
      const client = (repoId: string) => window.clients.forRepo(repoId);
      const mounted = mountPmPanel({ mode: ctx.mode, hasUI: ctx.hasUI, ui: ctx.ui }, {
        now: () => Date.now(),
        openItem: (entry, item) => {
          const target = client(entry.repoId);
          if (!target) { ctx.ui.notify("找不到该仓库的守护进程连接", "error"); return; }
          void target.call("pm.packet", { requirementId: entry.overview.requirementId, itemId: item.itemId }).then((result) => {
            if (myGeneration !== generation || typeof result.text !== "string") return;
            // 只有用户看完卡片后亲手输入的原话才作为决定依据
            revokeCapturedInput();
            pi.sendMessage({ customType: "one-company.decision-packet", content: result.text, display: true }, { triggerTurn: true });
          }).catch((error: unknown) => ctx.ui.notify(`该事项无法打开：${message(error)}`, "warning"));
        },
        togglePause: (entry) => {
          const target = client(entry.repoId);
          if (!target) { ctx.ui.notify("找不到该仓库的守护进程连接", "error"); return; }
          const method = entry.overview.status === "paused" ? "runs.resume" : "runs.pause";
          void target.call(method, { runId: entry.overview.pmRunId }).then(() => refresh(entry.repoId))
            .catch((error: unknown) => ctx.ui.notify(`${method === "runs.resume" ? "恢复" : "暂停"}未完成：${message(error)}`, "warning"));
        },
      });
      if (!mounted) return;
      const { panel, host } = mounted;
      const render = () => { panel.update([...byRepo.values()].flat()); host.requestRender(); };
      async function refresh(repoId: string): Promise<void> {
        const target = client(repoId);
        if (!target || target.state().status !== "connected") { byRepo.delete(repoId); render(); return; }
        try {
          const result = await target.call("pm.overview", {});
          if (myGeneration !== generation) return;
          const items = Array.isArray(result.items) ? result.items as PmOverview[] : [];
          byRepo.set(repoId, items.map((overview) => ({ repoId, overview, fetchedAt: Date.now() })));
        } catch { byRepo.delete(repoId); }
        render();
      }
      const unsubscribes: Array<() => void> = [];
      for (const repo of window.workspace.repos) {
        const target = client(repo.repoId);
        if (!target) continue;
        unsubscribes.push(target.subscribe("pm.overview.changed", () => { void refresh(repo.repoId); }));
        unsubscribes.push(target.subscribe(DAEMON_CLIENT_LIFECYCLE_EVENTS.connected, () => { void refresh(repo.repoId); }));
        unsubscribes.push(target.subscribe(DAEMON_CLIENT_LIFECYCLE_EVENTS.disconnected, () => { byRepo.delete(repo.repoId); render(); }));
        void refresh(repo.repoId);
      }
      const dock = new BottomDock({
        terminalInput: { onInput: (handler) => ctx.ui.onTerminalInput(handler) },
        panel,
        getEditorText: () => ctx.ui.getEditorText(),
        isCompletionOpen: () => host.isCompletionOpen(),
        isOverlayOpen: () => host.isOverlayOpen(),
        onFocusChange: (focus) => { if (focus === "panel") panel.focus(); else panel.blur(); host.requestRender(); },
      });
      dock.attach();
      registerDock(dock);
      const ticker = clock.setIntervalExcludingSleep(() => { panel.tick(); host.requestRender(); }, TICK_MS);
      const resync = clock.setIntervalExcludingSleep(() => { for (const repo of window.workspace.repos) void refresh(repo.repoId); }, RESYNC_MS);
      teardown = () => {
        clock.clearTimer(ticker); clock.clearTimer(resync);
        for (const unsubscribe of unsubscribes) unsubscribe();
        dock.release(); registerDock(undefined);
        mounted.unmount();
        clock.stopGapWatcher();
      };
    }).catch((error: unknown) => {
      if (myGeneration !== generation) return;
      ctx.ui.notify(message(error), "error");
    });
  });

  pi.on("session_shutdown", async () => { generation++; teardown?.(); teardown = undefined; });
}
