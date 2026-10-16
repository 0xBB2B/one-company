import { expect, test, vi } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { PmOverview } from "../src/modules/panel/pm-overview.ts";
import { formatElapsed, formatTokens, PmPanel } from "../src/modules/panel/pm-panel.ts";
import type { ExplorePanelEntry, PmPanelEntry, PrototypePanelEntry } from "../src/modules/panel/pm-panel.ts";
import pmPanelExtension from "../src/modules/panel/pm-panel-extension.ts";
import { createClock } from "../src/core/policy/clock.ts";
import { createFakePi } from "./helpers/fake-pi.ts";
import { registerRequirementInput } from "../src/core/host/extension-lifecycle.ts";

function overview(patch: Partial<PmOverview>): PmOverview {
  return { requirementId: "01900000-0000-7000-8000-000000000001", pmRunId: "01900000-0000-7000-8000-00000000000a", goals: ["角色跳跃", "跳跃动画"],
    status: "running", doing: "派 worker 执行 login（第 2 次尝试）", turns: 5, toolUses: 5, tokens: 33_800, cacheRate: 0.62, elapsedMs: 12_300, pendingItems: [], ...patch };
}
const jump = overview({ pendingItems: [{ itemId: "task:t1", kind: "adjudicate", label: "待你裁决：任务 login 两次未完成", version: "task:t1:3" }] });
const run = overview({ requirementId: "01900000-0000-7000-8000-000000000002", pmRunId: "01900000-0000-7000-8000-00000000000b", goals: ["角色快跑"],
  doing: "规划中（计划 v2 · 3 个任务）", turns: 42, toolUses: 38, tokens: 91_000, cacheRate: 0.84, elapsedMs: 137_000 });

function panel(now = 1_000) {
  const openItem = vi.fn(), togglePause = vi.fn();
  const instance = new PmPanel({ now: () => now, openItem, togglePause });
  const entries: PmPanelEntry[] = [{ repoId: "r", overview: jump, fetchedAt: 1_000 }, { repoId: "r", overview: run, fetchedAt: 1_000 }];
  instance.update(entries);
  return { instance, openItem, togglePause };
}

test("M7-AC33：面板按树形显示运行中的 PM、在做什么与待处理事项，数字为汇总值", () => {
  const { instance } = panel();
  expect(instance.render(200)).toEqual([
    "● 2 个需求运行中",
    "├─ ⠋ 角色跳跃、跳跃动画 · ↻5 · 5 tool uses · 33.8k token (62%) · 12.3s",
    "│    └ 派 worker 执行 login（第 2 次尝试）",
    "│      └ ⚑ 待你裁决：任务 login 两次未完成",
    "└─ ⠋ 角色快跑 · ↻42 · 38 tool uses · 91.0k token (84%) · 2m17s",
    "     └ 规划中（计划 v2 · 3 个任务）",
  ]);
});

test("M7-AC33：等待决定或已暂停显示 ⏸ 且不累加本地计时，运行中按拉取后经过的时间累加；窄屏截断", () => {
  const openItem = vi.fn(), togglePause = vi.fn();
  const instance = new PmPanel({ now: () => 6_000, openItem, togglePause });
  instance.update([{ repoId: "r", overview: overview({ status: "waiting", doing: "等待你的决定" }), fetchedAt: 1_000 },
    { repoId: "r", overview: run, fetchedAt: 1_000 }]);
  const lines = instance.render(200);
  expect(lines[1]).toContain("⏸ 角色跳跃");
  expect(lines[1]).toContain("· 12.3s");
  expect(lines[3]).toContain("· 2m22s");
  expect(instance.render(20).every((line) => visibleWidth(line) <= 20)).toBe(true);
  expect(new PmPanel({ now: () => 0, openItem, togglePause }).render(80)).toEqual([]);
});

test("M7-AC33：↑↓ 在 PM 行与事项行间移动，事项行按 Enter 打开决策包，p 暂停或恢复所在 PM；聚焦时显示按键提示", () => {
  const { instance, openItem, togglePause } = panel();
  instance.focus();
  expect(instance.render(200).at(-1)).toBe("↑↓ 选择 · Enter 查看 · p 暂停/恢复 · Esc 返回输入框");
  expect(instance.handleInput("\r")).toBe(true);
  expect(openItem).not.toHaveBeenCalled();
  instance.handleInput("\x1b[B");
  instance.handleInput("\r");
  expect(openItem).toHaveBeenCalledWith(expect.objectContaining({ overview: jump }), jump.pendingItems[0]);
  instance.handleInput("p");
  expect(togglePause).toHaveBeenCalledWith(expect.objectContaining({ overview: jump }));
  instance.handleInput("\x1b[B");
  instance.handleInput("p");
  expect(togglePause).toHaveBeenLastCalledWith(expect.objectContaining({ overview: run }));
});

test("M7-AC34：另一窗口处理掉事项后，更新投影时该行消失，选中项落到相邻行", () => {
  const { instance, openItem } = panel();
  instance.focus();
  instance.handleInput("\x1b[B");
  instance.update([{ repoId: "r", overview: { ...jump, pendingItems: [] }, fetchedAt: 1_000 }, { repoId: "r", overview: run, fetchedAt: 1_000 }]);
  expect(instance.render(200).some((line) => line.includes("⚑"))).toBe(false);
  instance.handleInput("\r");
  expect(openItem).not.toHaveBeenCalled();
});

const webExplore: ExplorePanelEntry = { repoId: "r", fetchedAt: 1_000,
  explore: { runId: "01900000-0000-7000-8000-0000000000e1", source: "web", question: "企业微信自建应用\n是否需要公网回调地址", turns: 2, maxTurns: 15, elapsedMs: 12_300 } };
const localExplore: ExplorePanelEntry = { repoId: "r", fetchedAt: 1_000,
  explore: { runId: "01900000-0000-7000-8000-0000000000e2", source: "local", question: "守护进程断网后怎么恢复", turns: 5, maxTurns: 20, elapsedMs: 64_000 } };

test("主窗口派出的检索：没有 PM 时面板只列检索，按拉取后经过的时间累加；检索行不可进入", () => {
  const instance = new PmPanel({ now: () => 2_000, openItem: vi.fn(), togglePause: vi.fn() });
  instance.updateExplores([webExplore]);
  expect(instance.render(200)).toEqual(["● 1 个检索运行中", "└─ ⠋ 联网 · 企业微信自建应用 是否需要公网回调地址 · ↻2/15 · 13.3s"]);
  expect(instance.hasRows()).toBe(false);
  instance.updateExplores([]);
  expect(instance.render(200)).toEqual([]);
});

test("主窗口派出的检索：和 PM 同时在跑时列在 PM 下面，按派出先后排；↑↓ 只在 PM 与事项行间移动，按键提示在最后", () => {
  const { instance, openItem } = panel();
  instance.updateExplores([localExplore, webExplore]);
  instance.focus();
  const lines = instance.render(200);
  expect(lines.slice(6)).toEqual([
    "● 2 个检索运行中",
    "├─ ⠋ 联网 · 企业微信自建应用 是否需要公网回调地址 · ↻2/15 · 12.3s",
    "└─ ⠋ 本地 · 守护进程断网后怎么恢复 · ↻5/20 · 1m4s",
    "↑↓ 选择 · Enter 查看 · p 暂停/恢复 · Esc 返回输入框",
  ]);
  for (let i = 0; i < 5; i++) instance.handleInput("\x1b[B");
  instance.handleInput("\x1b[A");
  instance.handleInput("\r");
  expect(openItem).toHaveBeenCalledWith(expect.objectContaining({ overview: jump }), jump.pendingItems[0]);
  expect(instance.render(20).every((line) => visibleWidth(line) <= 20)).toBe(true);
});

test("数字格式", () => {
  expect([formatTokens(999), formatTokens(33_800), formatTokens(2_500_000)]).toEqual(["999", "33.8k", "2.5M"]);
  expect([formatElapsed(12_300), formatElapsed(137_000), formatElapsed(3_723_000)]).toEqual(["12.3s", "2m17s", "1h2m3s"]);
});

test("M7-AC33/AC35：主窗口面板拉取概览，↓ 进入面板、选中事项按 Enter 取决策包并插入对话、由主代理接着回复；变化信号到达时重新拉取", async () => {
  const fake = createFakePi();
  const sendMessage = vi.fn();
  const pi = { ...fake.pi, sendMessage } as never;
  const listeners = new Map<string, () => void>();
  const calls: string[] = [];
  const client = {
    connectionIdentity: () => ({ daemonInstanceId: "d", connectionId: "c", connectionSequence: 1 }),
    call: async (method: string) => {
      calls.push(method);
      if (method === "pm.overview") return { items: [jump] };
      if (method === "explore.list") return { items: [webExplore.explore] };
      if (method === "pm.packet") return { text: "决策包正文" };
      throw new Error(`未预期的 RPC ${method}`);
    },
    subscribe: (event: string, handler: () => void) => { listeners.set(event, handler); return () => listeners.delete(event); },
    state: () => ({ status: "connected" as const }),
    close: () => {},
  };
  const window = { windowId: "w", sessionId: "s", workspace: { repos: [{ repoId: "r", path: "/r", commonDir: "/r/.git" }], skipped: [] },
    clients: { forRepo: (id: string) => (id === "r" ? client : undefined), all: () => [client], skipped: () => [], closeAll: () => {} } };
  pmPanelExtension(pi, { windowReady: () => Promise.resolve(window) as never, createClock: () => createClock() });
  const revoke = vi.fn(() => { expect(sendMessage).not.toHaveBeenCalled(); });
  const noteOpenedItem = vi.fn(() => { expect(revoke).toHaveBeenCalledTimes(1); expect(sendMessage).not.toHaveBeenCalled(); });
  registerRequirementInput({ revoke, noteOpenedItem, mentionNote: () => "" });
  let input: ((data: string) => unknown) | undefined;
  let widget: { render(width: number): string[] } | undefined;
  const ctx = { mode: "tui", hasUI: true, ui: { setWidget: (_key: string, factory?: (tui: unknown, theme: unknown) => typeof widget) => { if (factory) widget = factory({}, {}); },
    onTerminalInput: (handler: (data: string) => unknown) => { input = handler; return () => {}; }, getEditorText: () => "", notify: vi.fn() } };
  await fake.trigger("session_start", { reason: "new" }, ctx);
  await vi.waitFor(() => expect(calls).toContain("pm.overview"));
  await vi.waitFor(() => expect(widget!.render(200)).toContain("● 1 个检索运行中"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  input!("\x1b[B"); input!("\x1b[B"); input!("\r");
  await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledWith({ customType: "one-company.decision-packet", content: "决策包正文", display: true }, { triggerTurn: true }), { timeout: 5_000 });
  expect(revoke).toHaveBeenCalledTimes(1);
  expect(noteOpenedItem).toHaveBeenCalledWith({ repoId: "r", requirementId: jump.requirementId, itemId: "task:t1" });
  registerRequirementInput(undefined);
  const before = calls.filter((method) => method === "pm.overview").length;
  listeners.get("pm.overview.changed")!();
  await vi.waitFor(() => expect(calls.filter((method) => method === "pm.overview").length).toBe(before + 1));
  const exploreBefore = calls.filter((method) => method === "explore.list").length, overviewNow = calls.filter((method) => method === "pm.overview").length;
  listeners.get("explore.changed")!();
  await vi.waitFor(() => expect(calls.filter((method) => method === "explore.list").length).toBe(exploreBefore + 1));
  expect(calls.filter((method) => method === "pm.overview").length).toBe(overviewNow);
  await fake.trigger("session_shutdown", {}, ctx);
});

const designing: PrototypePanelEntry = { repoId: "r", fetchedAt: 1_000,
  prototype: { runId: "01900000-0000-7000-8000-0000000000f1", requirementId: "01900000-0000-7000-8000-000000000001", name: "设置页", version: 3, agent: "prototype", turns: 3, maxTurns: 30, elapsedMs: 41_000 } };
const designingCli: PrototypePanelEntry = { repoId: "r", fetchedAt: 1_000,
  prototype: { runId: "01900000-0000-7000-8000-0000000000f2", requirementId: "01900000-0000-7000-8000-000000000001", name: "命令行输出", version: 1, agent: "brand-designer", turns: 9, maxTurns: 30, elapsedMs: 130_000 } };

test("主窗口派出的原型设计师：单独运行时只列设计一组，按拉取后经过的时间累加；清空后不再显示", () => {
  const instance = new PmPanel({ now: () => 2_000, openItem: vi.fn(), togglePause: vi.fn() });
  instance.updatePrototypes([designing]);
  expect(instance.render(200)).toEqual(["● 1 个原型设计运行中", "└─ ⠋ 设置页（第 3 版）· prototype · ↻3/30 · 42.0s"]);
  expect(instance.hasRows()).toBe(false);
  instance.updatePrototypes([]);
  expect(instance.render(200)).toEqual([]);
});

test("面板同时有需求、原型设计、检索时按这个顺序显示，设计行带分支符号，按键提示在最后", () => {
  const { instance } = panel();
  instance.updateExplores([localExplore]);
  instance.updatePrototypes([designing, designingCli]);
  instance.focus();
  const lines = instance.render(200);
  expect(lines.slice(6)).toEqual([
    "● 2 个原型设计运行中",
    "├─ ⠋ 设置页（第 3 版）· prototype · ↻3/30 · 41.0s",
    "└─ ⠋ 命令行输出（第 1 版）· brand-designer · ↻9/30 · 2m10s",
    "● 1 个检索运行中",
    "└─ ⠋ 本地 · 守护进程断网后怎么恢复 · ↻5/20 · 1m4s",
    "↑↓ 选择 · Enter 查看 · p 暂停/恢复 · Esc 返回输入框",
  ]);
  expect(lines[0]).toBe("● 2 个需求运行中");
  expect(instance.render(20).every((line) => visibleWidth(line) <= 20)).toBe(true);
});

test("原型设计变化信号到达时，主窗口面板重新拉取原型设计运行并显示", async () => {
  const fake = createFakePi();
  const listeners = new Map<string, () => void>();
  const calls: string[] = [];
  const client = {
    connectionIdentity: () => ({ daemonInstanceId: "d", connectionId: "c", connectionSequence: 1 }),
    call: async (method: string) => {
      calls.push(method);
      if (method === "pm.overview" || method === "explore.list") return { items: [] };
      if (method === "prototypes.list") return { items: [designing.prototype] };
      throw new Error(`未预期的 RPC ${method}`);
    },
    subscribe: (event: string, handler: () => void) => { listeners.set(event, handler); return () => listeners.delete(event); },
    state: () => ({ status: "connected" as const }),
    close: () => {},
  };
  const window = { windowId: "w", sessionId: "s", workspace: { repos: [{ repoId: "r", path: "/r", commonDir: "/r/.git" }], skipped: [] },
    clients: { forRepo: (id: string) => (id === "r" ? client : undefined), all: () => [client], skipped: () => [], closeAll: () => {} } };
  pmPanelExtension(fake.pi as never, { windowReady: () => Promise.resolve(window) as never, createClock: () => createClock() });
  let widget: { render(width: number): string[] } | undefined;
  const ctx = { mode: "tui", hasUI: true, ui: { setWidget: (_key: string, factory?: (tui: unknown, theme: unknown) => typeof widget) => { if (factory) widget = factory({}, {}); },
    onTerminalInput: () => () => {}, getEditorText: () => "", notify: vi.fn() } };
  await fake.trigger("session_start", { reason: "new" }, ctx);
  await vi.waitFor(() => expect(widget!.render(200)).toContain("● 1 个原型设计运行中"));
  const before = calls.filter((method) => method === "prototypes.list").length;
  listeners.get("prototype.changed")!();
  await vi.waitFor(() => expect(calls.filter((method) => method === "prototypes.list").length).toBe(before + 1));
  await fake.trigger("session_shutdown", {}, ctx);
});
