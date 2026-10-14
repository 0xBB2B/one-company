import { spawn } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createClock } from "../runtime/clock.ts";
import type { Clock } from "../runtime/clock.ts";
import { DAEMON_CLIENT_LIFECYCLE_EVENTS } from "../runtime/daemon-client.ts";
import { BottomDock } from "../runtime/dock.ts";
import type { PmOverview } from "../runtime/pm-overview.ts";
import { mountPmPanel } from "../runtime/pm-panel.ts";
import type { ExplorePanelEntry, PmPanelEntry } from "../runtime/pm-panel.ts";
import type { MainExploreOverview } from "../runtime/explore-dispatch.ts";
import { sanitizeText } from "../runtime/text-sanitize.ts";
import { noteOpenedPanelItem, registerDock, revokeCapturedInput, windowReady as defaultWindowReady } from "./lifecycle.ts";
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
  /** 用默认浏览器打开文件；返回是否打开成功。 */
  openFile?: (path: string) => Promise<boolean>;
}

function openWithSystem(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn("open", [path], { stdio: "ignore" });
    child.once("error", () => resolve(false));
    child.once("exit", (code) => resolve(code === 0));
  });
}

/** 长路径在目录分隔处断开，续行缩进对齐，避免在 80 列窗口里被从中间硬折。 */
function pathLines(path: string): string[] {
  const lines: string[] = [];
  let line = "文件：";
  for (const segment of path.split(/(?<=\/)/)) {
    if (line.trim() && line !== "文件：" && line.length + segment.length > 72) { lines.push(line); line = "      "; }
    line += segment;
  }
  return [...lines, line];
}

function formatBytes(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : bytes < 1_048_576 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1_048_576).toFixed(1)} MB`;
}

/** 主窗口状态面板：向各仓库守护进程拉取 PM 概览与本窗口派出的检索，变化信号到达时重拉；事项按回车插入决策包并由主代理接着回复。 */
export default function pmPanelExtension(pi: ExtensionAPI, deps: PmPanelUiDeps = {}): void {
  const resolveWindowReady = deps.windowReady ?? defaultWindowReady;
  const resolveClock = deps.createClock ?? (() => createClock());
  const openFile = deps.openFile ?? openWithSystem;
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
      const exploresByRepo = new Map<string, ExplorePanelEntry[]>();
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
            noteOpenedPanelItem({ repoId: entry.repoId, requirementId: entry.overview.requirementId, itemId: item.itemId });
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
      const render = () => { panel.update([...byRepo.values()].flat()); panel.updateExplores([...exploresByRepo.values()].flat()); host.requestRender(); };
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
      async function refreshExplores(repoId: string): Promise<void> {
        const target = client(repoId);
        if (!target || target.state().status !== "connected") { exploresByRepo.delete(repoId); render(); return; }
        try {
          const result = await target.call("explore.list", {});
          if (myGeneration !== generation) return;
          const items = Array.isArray(result.items) ? result.items as MainExploreOverview[] : [];
          exploresByRepo.set(repoId, items.map((explore) => ({ repoId, explore, fetchedAt: Date.now() })));
        } catch { exploresByRepo.delete(repoId); }
        render();
      }
      const refreshAll = (repoId: string) => { void refresh(repoId); void refreshExplores(repoId); };
      const unsubscribes: Array<() => void> = [];
      for (const repo of window.workspace.repos) {
        const target = client(repo.repoId);
        if (!target) continue;
        unsubscribes.push(target.subscribe("pm.overview.changed", () => { void refresh(repo.repoId); }));
        unsubscribes.push(target.subscribe("explore.changed", () => { void refreshExplores(repo.repoId); }));
        unsubscribes.push(target.subscribe(DAEMON_CLIENT_LIFECYCLE_EVENTS.connected, () => refreshAll(repo.repoId)));
        unsubscribes.push(target.subscribe(DAEMON_CLIENT_LIFECYCLE_EVENTS.disconnected, () => { byRepo.delete(repo.repoId); exploresByRepo.delete(repo.repoId); render(); }));
        refreshAll(repo.repoId);
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
      const resync = clock.setIntervalExcludingSleep(() => { for (const repo of window.workspace.repos) refreshAll(repo.repoId); }, RESYNC_MS);
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
