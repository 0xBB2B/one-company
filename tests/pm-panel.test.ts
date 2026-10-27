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
    status: "running", doing: "派 worker 执行 login（第 2 次尝试）", turns: 5, toolUses: 5, tokens: 33_800, cacheRate: 0.62, elapsedMs: 12_300, taskProgress: null, pendingItems: [], taskRows: [], ...patch };
}
const jump = overview({ pendingItems: [{ itemId: "task:t1", kind: "adjudicate", label: "待裁决：任务 login 2 次未完成", version: "task:t1:3" }] });
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
    "│      └ ⚑ 待裁决：任务 login 2 次未完成",
    "└─ ⠋ 角色快跑 · ↻42 · 38 tool uses · 91.0k token (84%) · 2m17s",
    "     └ 规划中（计划 v2 · 3 个任务）",
  ]);
});

test("M7-AC33：等待决定或已暂停显示 ⏸ 且不累加本地计时，运行中按拉取后经过的时间累加；窄屏截断", () => {
  const openItem = vi.fn(), togglePause = vi.fn();
  const instance = new PmPanel({ now: () => 6_000, openItem, togglePause });
  instance.update([{ repoId: "r", overview: overview({ status: "waiting", doing: "等待决定" }), fetchedAt: 1_000 },
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

test("主窗口派出的检索：没有 PM 时面板只列检索，按拉取后经过的时间累加；检索行可选中", () => {
  const instance = new PmPanel({ now: () => 2_000, openItem: vi.fn(), togglePause: vi.fn() });
  instance.updateExplores([webExplore]);
  expect(instance.render(200)).toEqual(["● 1 个检索运行中", "└─ ⠋ 联网 · 企业微信自建应用 是否需要公网回调地址 · ↻2/15 · 13.3s"]);
  expect(instance.hasRows()).toBe(true);
  instance.updateExplores([]);
  expect(instance.render(200)).toEqual([]);
});

test("主窗口派出的检索：和 PM 同时在跑时列在 PM 下面，按派出先后排；↑↓ 先走完 PM 与事项行，再走检索行，按键提示在最后", () => {
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
  for (let i = 0; i < 3; i++) instance.handleInput("\x1b[A");
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
  expect(instance.hasRows()).toBe(true);
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

test("面板进度 AC-1：有任务时第一行在目标后、轮数前显示“任务 X/N”", () => {
  const instance = new PmPanel({ now: () => 1_000, openItem: vi.fn(), togglePause: vi.fn() });
  instance.update([{ repoId: "r", overview: overview({ goals: ["角色跳跃"], taskProgress: { completed: 3, total: 8 } }), fetchedAt: 1_000 }]);
  expect(instance.render(120)[1]).toBe("└─ ⠋ 角色跳跃 · 任务 3/8 · ↻5 · 5 tool uses · 33.8k token (62%) · 12.3s");
});

test("面板进度 AC-5：没有任务进度时第一行不含“任务”", () => {
  const instance = new PmPanel({ now: () => 1_000, openItem: vi.fn(), togglePause: vi.fn() });
  instance.update([{ repoId: "r", overview: overview({ taskProgress: null }), fetchedAt: 1_000 }]);
  expect(instance.render(120)[1]).not.toContain("任务");
});

test("面板进度 AC-6：running、pausing、paused、waiting 状态都显示任务进度", () => {
  for (const status of ["running", "pausing", "paused", "waiting"] as const) {
    const instance = new PmPanel({ now: () => 1_000, openItem: vi.fn(), togglePause: vi.fn() });
    instance.update([{ repoId: "r", overview: overview({ status, taskProgress: { completed: 2, total: 4 } }), fetchedAt: 1_000 }]);
    expect(instance.render(120)[1], status).toContain(" · 任务 2/4 · ↻");
  }
});

test("面板进度：窄屏下带任务进度的行照旧按宽度截断", () => {
  const instance = new PmPanel({ now: () => 1_000, openItem: vi.fn(), togglePause: vi.fn() });
  instance.update([{ repoId: "r", overview: overview({ taskProgress: { completed: 3, total: 8 } }), fetchedAt: 1_000 }]);
  for (const line of instance.render(20)) expect(visibleWidth(line)).toBeLessThanOrEqual(20);
});

type Task = PmOverview["taskRows"][number];
type Reviewer = Extract<Task, { kind: "review" }>["reviewers"][number];

function taskPanel(patch: Partial<PmOverview>, now = 1_000, ansi = false) {
  const openItem = vi.fn(), togglePause = vi.fn(), openSteps = vi.fn();
  let clock = now;
  const instance = new PmPanel({ now: () => clock, openItem, togglePause, openSteps });
  const entry: PmPanelEntry = { repoId: "r", overview: overview(patch), fetchedAt: 1_000 };
  instance.update([entry]);
  const calls: Array<[string, string]> = [];
  instance.setTheme(ansi
    ? { fg: (kind, text) => { calls.push([kind, text]); return `\x1b[31m${text}\x1b[39m`; }, bg: (_kind, text) => `\x1b[44m${text}\x1b[49m` }
    : { fg: (kind, text) => { calls.push([kind, text]); return text; } });
  return { instance, openItem, togglePause, openSteps, calls, entry, setNow: (value: number) => { clock = value; } };
}
const body = (line: string) => line.replace(/^[ │├└]+/, "");
const exec = (taskKey: string, extra: Partial<Extract<Task, { kind: "execute" }>> = {}): Task =>
  ({ kind: "execute", taskKey, agent: "go-worker", attempt: 1, runId: `run-${taskKey}`, turns: 8, maxTurns: 20, elapsedMs: 182_000, ...extra });
const review = (taskKey: string, reviewers: Reviewer[]): Task => ({ kind: "review", taskKey, round: 1, reviewers });
const t1Item = { itemId: "task:t1", kind: "adjudicate" as const, label: "待裁决：任务 T1 2 次未完成", version: "task:t1:3", taskKey: "T1", taskText: "2 次未完成" };
const reqItem = { itemId: "pm:intake", kind: "intake-review" as const, label: "待核对：PM 接手理解 r2", version: "pm:intake:1" };

test("任务行 AC-1：只有一个执行任务时，需求行下一行是执行行，没有 doing 行和其他汇总行", () => {
  const { instance } = taskPanel({ taskRows: [exec("T3")] });
  const lines = instance.render(200);
  expect(lines).toHaveLength(3);
  expect(lines[2]).toBe("     └ ⠋ T3 执行 · go-worker（第 1 次尝试）· ↻8/20 · 3m2s");
  expect(lines.some((line) => line.includes("派 worker 执行 login"))).toBe(false);
});

test("任务行 AC-1/AC-2：审查任务带审查代理子行，用 │ ├ └ 连线并缩进一层，后面的任务用 └ 收尾", () => {
  const { instance } = taskPanel({ taskRows: [
    review("T1", [
      { agent: "reviewer", state: "running", turns: 2, maxTurns: 10, elapsedMs: 5_000 },
      { agent: "go-reviewer", state: "running", turns: 3, maxTurns: 10, elapsedMs: 7_000 },
      { agent: "vue-reviewer", state: "clear", turns: 4, maxTurns: 10, elapsedMs: 30_000 },
    ]),
    exec("T2"),
  ] });
  const lines = instance.render(200);
  expect(lines.slice(2, 7)).toEqual([
    expect.stringMatching(/^ {5}├ T1 第 1 轮审查$/),
    "     │ ├ ⠋ reviewer · ↻2/10 · 5.0s",
    "     │ ├ ⠋ go-reviewer · ↻3/10 · 7.0s",
    expect.stringMatching(/^ {5}│ └ ✓ vue-reviewer 通过 · ↻4\/10/),
    "     └ ⠋ T2 执行 · go-worker（第 1 次尝试）· ↻8/20 · 3m2s",
  ]);
});

test("任务行 AC-2/AC-3：审查代理各状态的文字与颜色：打回 ✗、没交出结论 dim、跳过 warning、通过的 ✓ 为 success", () => {
  const { instance, calls } = taskPanel({ taskRows: [review("T1", [
    { agent: "a-reviewer", state: "blocked", turns: 6, maxTurns: 10, elapsedMs: 9_000 },
    { agent: "b-reviewer", state: "awaiting_retry", reason: "turn_limit_reached", turns: 7, maxTurns: 10, elapsedMs: 9_000 },
    { agent: "go-reviewer", state: "skipped_disabled" },
    { agent: "c-reviewer", state: "skipped_missing" },
    { agent: "d-reviewer", state: "clear", turns: 4, maxTurns: 10, elapsedMs: 30_000 },
  ])] });
  const lines = instance.render(200).slice(3).map(body);
  expect(lines[0]).toMatch(/^✗ a-reviewer 打回 · ↻6\/10/);
  expect(lines[1]).toMatch(/^– b-reviewer 没交出结论（轮数用满），等 PM 重派 · ↻7\/10/);
  expect(lines[2]).toBe("– go-reviewer 已关闭，本轮未审");
  expect(lines[3]).toBe("– c-reviewer 已不存在，本轮未审");
  expect(lines[4]).toMatch(/^✓ d-reviewer 通过 · ↻4\/10/);
  const has = (kind: string, part: string) => calls.some(([k, text]) => k === kind && text.includes(part));
  expect(has("dim", "b-reviewer 没交出结论（轮数用满），等 PM 重派")).toBe(true);
  expect(has("warning", "go-reviewer 已关闭，本轮未审")).toBe(true);
  expect(has("warning", "c-reviewer 已不存在，本轮未审")).toBe(true);
  expect(lines.some((line) => line.includes("上一轮已通过"))).toBe(false);
  expect(has("success", "✓")).toBe(true);
  expect(has("muted", "d-reviewer 通过")).toBe(true);
  expect(calls.some(([k, text]) => k === "success" && text.includes("通过"))).toBe(false);
});

test("任务行 AC-1：上限未知时只写 ↻已用；在跑行的用时随当前时间推进增加，已用时间格式沿用面板格式", () => {
  const { instance, setNow } = taskPanel({ taskRows: [exec("T3", { maxTurns: null, elapsedMs: 182_000 })] });
  expect(instance.render(200)[2]).toBe("     └ ⠋ T3 执行 · go-worker（第 1 次尝试）· ↻8 · 3m2s");
  setNow(11_000);
  expect(instance.render(200)[2]).toBe("     └ ⠋ T3 执行 · go-worker（第 1 次尝试）· ↻8 · 3m12s");
});

test("任务行 AC-2：审查代理在跑行上限未知时写 ↻已用，用时随当前时间推进", () => {
  const { instance, setNow } = taskPanel({ taskRows: [review("T1", [{ agent: "reviewer", state: "running", turns: 3, maxTurns: null, elapsedMs: 5_000 }])] });
  expect(instance.render(200)[3]).toBe("       └ ⠋ reviewer · ↻3 · 5.0s");
  setNow(4_000);
  expect(instance.render(200)[3]).toBe("       └ ⠋ reviewer · ↻3 · 8.0s");
});

test("任务行 AC-5：检索行写在任务行之后", () => {
  const { instance } = taskPanel({ taskRows: [exec("T3"), { kind: "explore", turns: 3, maxTurns: 12, elapsedMs: 5_000 }] });
  const lines = instance.render(200);
  expect(lines[2]).toMatch(/^ {5}├ ⠋ T3 执行/);
  expect(lines[3]).toBe("     └ ⠋ explore 检索 · ↻3/12 · 5.0s");
});

test("任务行 AC-4：任务级待处理事项画成 ⚑ 行，选中后 Enter 打开决策包；执行行可选中，Enter 打开步骤窗口", () => {
  const { instance, openItem, openSteps, entry } = taskPanel({
    taskRows: [{ kind: "pending", taskKey: "T1", itemId: "task:t1", text: "2 次未完成" }, exec("T2")],
    pendingItems: [t1Item],
  });
  instance.focus();
  const lines = instance.render(200);
  expect(lines[2]).toBe("     ├ ⚑ T1 2 次未完成");
  expect(lines[3]).toMatch(/^ {5}└ ⠋ T2 执行/);
  instance.handleInput("\x1b[B");
  instance.handleInput("\r");
  expect(openItem).toHaveBeenCalledTimes(1);
  expect(openItem).toHaveBeenLastCalledWith(expect.objectContaining({ overview: entry.overview }), t1Item);
  instance.handleInput("\x1b[B");
  instance.handleInput("\r");
  expect(openItem).toHaveBeenCalledTimes(1);
  expect(openSteps).toHaveBeenCalledWith({ repoId: "r", runId: "run-T2", title: "T2 执行 · go-worker（第 1 次尝试）" });
});

test("任务行 AC-4：需求级事项以 ⚑ 事项文字排在任务行之后，↑↓ 顺序与画出顺序一致（需求行 → 任务级 ⚑ → 执行行 → 需求级 ⚑）", () => {
  const { instance, openItem, openSteps, entry } = taskPanel({
    taskRows: [{ kind: "pending", taskKey: "T1", itemId: "task:t1", text: "2 次未完成" }, exec("T2")],
    pendingItems: [reqItem, t1Item],
  });
  instance.focus();
  const lines = instance.render(200);
  expect(lines.slice(2, 5)).toEqual([
    "     ├ ⚑ T1 2 次未完成",
    expect.stringMatching(/^ {5}├ ⠋ T2 执行/),
    "     └ ⚑ 待核对：PM 接手理解 r2",
  ]);
  instance.handleInput("\x1b[B");
  instance.handleInput("\r");
  expect(openItem).toHaveBeenLastCalledWith(expect.objectContaining({ overview: entry.overview }), t1Item);
  instance.handleInput("\x1b[B");
  instance.handleInput("\r");
  expect(openSteps).toHaveBeenCalledTimes(1);
  instance.handleInput("\x1b[B");
  instance.handleInput("\r");
  expect(openItem).toHaveBeenLastCalledWith(expect.objectContaining({ overview: entry.overview }), reqItem);
  instance.handleInput("\x1b[B");
  instance.handleInput("\r");
  expect(openItem).toHaveBeenLastCalledWith(expect.anything(), reqItem);
  expect(openItem).toHaveBeenCalledTimes(3);
});

test("任务行 AC-4/AC-6：任务行有审查代理时 ↑↓ 依次停在运行中的审查代理、执行行、⚑ 行，审查标题行跳过；p 暂停所在 PM", () => {
  const { instance, openItem, openSteps, togglePause, entry } = taskPanel({
    taskRows: [review("T1", [{ agent: "reviewer", state: "running", runId: "run-rv", turns: 1, maxTurns: 10, elapsedMs: 1_000 }]), exec("T2")],
    pendingItems: [reqItem],
  });
  instance.focus();
  expect(instance.render(200)[2]).toMatch(/T1 第 1 轮审查/);
  instance.handleInput("\x1b[B");
  instance.handleInput("\r");
  expect(openSteps).toHaveBeenLastCalledWith({ repoId: "r", runId: "run-rv", title: "T1 第 1 轮审查 · reviewer" });
  instance.handleInput("p");
  expect(togglePause).toHaveBeenLastCalledWith(expect.objectContaining({ overview: entry.overview }));
  instance.handleInput("\x1b[B");
  instance.handleInput("\r");
  expect(openSteps).toHaveBeenLastCalledWith({ repoId: "r", runId: "run-T2", title: "T2 执行 · go-worker（第 1 次尝试）" });
  instance.handleInput("\x1b[B");
  instance.handleInput("\r");
  expect(openItem).toHaveBeenLastCalledWith(expect.anything(), reqItem);
  instance.handleInput("\x1b[B");
  instance.handleInput("\r");
  expect(openItem).toHaveBeenCalledTimes(2);
  expect(openSteps).toHaveBeenCalledTimes(2);
});

test("任务行 AC-5：taskRows 为空时照旧显示 doing 行和全部待处理事项", () => {
  const { instance } = taskPanel({ doing: "等待核对接手理解", pendingItems: [reqItem], taskRows: [] });
  const lines = instance.render(200);
  expect(lines.slice(2)).toEqual(["     └ 等待核对接手理解", "       └ ⚑ 待核对：PM 接手理解 r2"]);
});

test("任务行 AC-7：窄屏下任务行、审查代理行、检索行、⚑ 行都按宽度截断且不换行", () => {
  const long = "一段很长很长的待处理事项文字用来撑满窄屏";
  const { instance } = taskPanel({
    taskRows: [
      exec("T3", { agent: "a-very-long-worker-definition-name" }),
      review("T1", [{ agent: "a-very-long-reviewer-name", state: "running", turns: 2, maxTurns: 10, elapsedMs: 5_000 }, { agent: "go-reviewer", state: "skipped_disabled" }]),
      { kind: "pending", taskKey: "T2", itemId: "task:t2", text: long },
      { kind: "explore", turns: 3, maxTurns: 12, elapsedMs: 5_000 },
    ],
    pendingItems: [{ ...reqItem, label: long }, { ...t1Item, itemId: "task:t2", taskKey: "T2", taskText: long }],
  });
  instance.focus();
  const wide = instance.render(300), narrow = instance.render(40);
  expect(narrow).toHaveLength(wide.length);
  expect(narrow.length).toBeGreaterThan(6);
  for (const line of narrow) expect(visibleWidth(line)).toBeLessThanOrEqual(40);
});

test("任务行 AC-7：带 ANSI 着色时，宽度 1 到 12 列逐个渲染，每行 visibleWidth 都不超过宽度", () => {
  const { instance } = taskPanel({
    taskRows: [
      { kind: "pending", taskKey: "T1", itemId: "task:t1", text: "2 次未完成" },
      review("T2", [
        { agent: "run-reviewer", state: "running", turns: 2, maxTurns: 10, elapsedMs: 5_000 },
        { agent: "blk-reviewer", state: "blocked", turns: 2, maxTurns: 10, elapsedMs: 5_000 },
        { agent: "end-reviewer", state: "awaiting_retry", reason: "failed", turns: 2, maxTurns: 10, elapsedMs: 5_000 },
        { agent: "clr-reviewer", state: "clear", turns: 2, maxTurns: 10, elapsedMs: 5_000 },
        { agent: "retry-reviewer", state: "running", attempt: 2, turns: 2, maxTurns: 10, elapsedMs: 5_000 },
        { agent: "exh-reviewer", state: "exhausted", attempt: 2, turns: 2, maxTurns: 10, elapsedMs: 5_000 },
        { agent: "sup-reviewer", state: "awaiting_retry", reason: "superseded", turns: 2, maxTurns: 10, elapsedMs: 5_000 },
        { agent: "go-reviewer", state: "skipped_disabled" },
        { agent: "vue-reviewer", state: "clear", turns: 2, maxTurns: 10, elapsedMs: 5_000 },
      ]),
      exec("T3"),
    ],
    pendingItems: [t1Item, reqItem],
  }, 1_000, true);
  instance.focus();
  for (const selectDown of [0, 1, 2]) {
    for (let i = 0; i < selectDown; i++) instance.handleInput("\x1b[B");
    for (let width = 1; width <= 12; width++) {
      for (const line of instance.render(width)) expect(visibleWidth(line), `宽度 ${width}：${JSON.stringify(line)}`).toBeLessThanOrEqual(width);
    }
  }
});

test("任务行 AC-2：在跑和打回的审查代理行不着灰；没交出结论整行 dim；通过的 ✓ 为 success、后面文字为 muted", () => {
  const { instance, calls } = taskPanel({ taskRows: [review("T1", [
    { agent: "run-reviewer", state: "running", turns: 2, maxTurns: 10, elapsedMs: 5_000 },
    { agent: "blk-reviewer", state: "blocked", turns: 6, maxTurns: 10, elapsedMs: 9_000 },
    { agent: "end-reviewer", state: "awaiting_retry", reason: "failed", turns: 7, maxTurns: 10, elapsedMs: 9_000 },
    { agent: "clr-reviewer", state: "clear", turns: 4, maxTurns: 10, elapsedMs: 30_000 },
    { agent: "go-reviewer", state: "skipped_disabled" },
  ])] });
  instance.render(200);
  const grey = calls.filter(([kind]) => kind === "dim" || kind === "muted");
  expect(grey.some(([, text]) => text.includes("run-reviewer"))).toBe(false);
  expect(grey.some(([, text]) => text.includes("blk-reviewer"))).toBe(false);
  const has = (kind: string, part: string) => calls.some(([k, text]) => k === kind && text.includes(part));
  expect(has("dim", "end-reviewer 没交出结论（运行失败），等 PM 重派")).toBe(true);
  expect(has("success", "✓")).toBe(true);
  expect(has("muted", "clr-reviewer 通过")).toBe(true);
  expect(has("dim", "clr-reviewer")).toBe(false);
  expect(has("warning", "go-reviewer 已关闭，本轮未审")).toBe(true);
});

test("任务行：任务行、审查代理行、任务级与需求级 ⚑ 行（未选中）的连线前缀都用 dim", () => {
  const { instance, calls } = taskPanel({
    taskRows: [
      { kind: "pending", taskKey: "T1", itemId: "task:t1", text: "2 次未完成" },
      review("T2", [{ agent: "a-reviewer", state: "running", turns: 1, maxTurns: 10, elapsedMs: 1_000 }, { agent: "b-reviewer", state: "clear", turns: 1, maxTurns: 10, elapsedMs: 1_000 }]),
      exec("T3"),
    ],
    pendingItems: [t1Item, reqItem],
  });
  const lines = instance.render(200);
  const rowCount = lines.length - 2;
  const connectors = calls.filter(([kind, text]) => kind === "dim" && /^[ │├└]+$/.test(text) && /[│├└]/.test(text)).map(([, text]) => text);
  expect(connectors.length).toBeGreaterThanOrEqual(rowCount);
  expect(connectors.filter((text) => text.includes("│") && /[├└]/.test(text)).length).toBeGreaterThanOrEqual(2);
});

test("任务行 AC-2：在跑的审查代理行缺少 turns 或用时时不出现 undefined，对应那段不写", () => {
  const reviewerLine = (reviewer: Reviewer) => {
    const { instance } = taskPanel({ taskRows: [review("T1", [reviewer])] });
    const lines = instance.render(200);
    expect(lines.some((line) => line.includes("undefined"))).toBe(false);
    return body(lines[3]!);
  };
  expect(reviewerLine({ agent: "reviewer", state: "running" })).toBe("⠋ reviewer");
  expect(reviewerLine({ agent: "reviewer", state: "running", turns: 2, maxTurns: 10 })).toBe("⠋ reviewer · ↻2/10");
  const onlyElapsed = reviewerLine({ agent: "reviewer", state: "running", elapsedMs: 5_000 });
  expect(onlyElapsed).toContain("5.0s");
  expect(onlyElapsed).not.toContain("↻");
});

test("任务行 AC-4：有任务行时需求行图标是转圈而不是 ⏸，p 暂停或恢复所在 PM（选中需求行或 ⚑ 行都行）", () => {
  const openItem = vi.fn(), togglePause = vi.fn();
  const instance = new PmPanel({ now: () => 1_000, openItem, togglePause });
  const entry: PmPanelEntry = { repoId: "r", fetchedAt: 1_000, overview: overview({
    taskRows: [{ kind: "pending", taskKey: "T1", itemId: "task:t1", text: "2 次未完成" }, exec("T2")], pendingItems: [t1Item] }) };
  instance.update([entry]);
  instance.focus();
  const lines = instance.render(200);
  expect(lines[1]).toContain("⠋ ");
  expect(lines[1]).not.toContain("⏸");
  instance.handleInput("p");
  expect(togglePause).toHaveBeenLastCalledWith(expect.objectContaining({ overview: entry.overview }));
  instance.handleInput("\x1b[B");
  instance.handleInput("p");
  expect(togglePause).toHaveBeenCalledTimes(2);
});

test("任务行 AC-9：等 PM 重派的审查代理行按原因写「轮数用满 / 运行失败 / 被停止」，整行 dim", () => {
  const { instance, calls } = taskPanel({ taskRows: [review("T1", [
    { agent: "a-reviewer", state: "awaiting_retry", reason: "turn_limit_reached", turns: 10, maxTurns: 10, elapsedMs: 9_000 },
    { agent: "b-reviewer", state: "awaiting_retry", reason: "failed", turns: 3, maxTurns: 10, elapsedMs: 62_000 },
    { agent: "c-reviewer", state: "awaiting_retry", reason: "stopped", turns: 4, maxTurns: 10, elapsedMs: 5_000 },
  ])] });
  const lines = instance.render(200).slice(3).map(body);
  expect(lines).toEqual([
    "– a-reviewer 没交出结论（轮数用满），等 PM 重派 · ↻10/10 · 9.0s",
    "– b-reviewer 没交出结论（运行失败），等 PM 重派 · ↻3/10 · 1m2s",
    "– c-reviewer 没交出结论（被停止），等 PM 重派 · ↻4/10 · 5.0s",
  ]);
  for (const line of lines) expect(calls.some(([kind, text]) => kind === "dim" && text.includes(line))).toBe(true);
});

test("任务行 AC-9：第 2 次起重派的在跑审查代理行写「（第 N 次）」且正文不着色；没有 attempt 时不写次数", () => {
  const { instance, calls } = taskPanel({ taskRows: [review("T1", [
    { agent: "a-reviewer", state: "running", attempt: 2, turns: 2, maxTurns: 10, elapsedMs: 5_000 },
    { agent: "b-reviewer", state: "running", turns: 3, maxTurns: 10, elapsedMs: 7_000 },
  ])] });
  const lines = instance.render(200).slice(3).map(body);
  expect(lines).toEqual(["⠋ a-reviewer（第 2 次）· ↻2/10 · 5.0s", "⠋ b-reviewer · ↻3/10 · 7.0s"]);
  const grey = calls.filter(([kind]) => kind === "dim" || kind === "muted" || kind === "warning");
  expect(grey.some(([, text]) => text.includes("a-reviewer") || text.includes("b-reviewer"))).toBe(false);
});

test.each([2, 3])("任务行 AC-9：用满的审查代理行按 attempt=%i 写次数和「本轮结束后交你裁决」，整行 warning", (attempt) => {
  const { instance, calls } = taskPanel({ taskRows: [review("T1", [
    { agent: "a-reviewer", state: "exhausted", attempt, turns: 10, maxTurns: 10, elapsedMs: 9_000 },
  ])] });
  const line = body(instance.render(200)[3]!);
  expect(line).toBe(`– a-reviewer ${attempt} 次没交出结论，本轮结束后交你裁决 · ↻10/10 · 9.0s`);
  expect(calls.some(([kind, text]) => kind === "warning" && text.includes(line))).toBe(true);
});

test("任务行 AC-9：新审查代理行的连线前缀用 dim，宽度 1 到 12 列不超宽", () => {
  const { instance, calls } = taskPanel({ taskRows: [review("T1", [
    { agent: "a-reviewer", state: "awaiting_retry", reason: "stopped", turns: 4, maxTurns: 10, elapsedMs: 5_000 },
    { agent: "b-reviewer", state: "running", attempt: 2, turns: 2, maxTurns: 10, elapsedMs: 5_000 },
    { agent: "c-reviewer", state: "exhausted", attempt: 2, turns: 10, maxTurns: 10, elapsedMs: 9_000 },
    { agent: "d-reviewer", state: "awaiting_retry", reason: "superseded", turns: 3, maxTurns: 10, elapsedMs: 5_000 },
  ])] }, 1_000, true);
  instance.render(200);
  const connectors = calls.filter(([kind, text]) => kind === "dim" && /^[ │├└]+$/.test(text) && /[├└]/.test(text));
  expect(connectors.length).toBeGreaterThanOrEqual(4);
  for (let width = 1; width <= 12; width++) {
    for (const line of instance.render(width)) expect(visibleWidth(line), `宽度 ${width}：${JSON.stringify(line)}`).toBeLessThanOrEqual(width);
  }
});

test("任务行 AC-9：被作废的审查代理行写「被作废，等 PM 重派」，不写「没交出结论」，整行 dim", () => {
  const { instance, calls } = taskPanel({ taskRows: [review("T1", [
    { agent: "a-reviewer", state: "awaiting_retry", reason: "superseded", turns: 3, maxTurns: 10, elapsedMs: 65_000 },
  ])] });
  const line = body(instance.render(200)[3]!);
  expect(line).toBe("– a-reviewer 被作废，等 PM 重派 · ↻3/10 · 1m5s");
  expect(line).not.toContain("没交出结论");
  expect(calls.some(([kind, text]) => kind === "dim" && text.includes(line))).toBe(true);
});

test("任务行 AC-2：通过、打回的审查代理行带轮数和用时时照写", () => {
  const { instance } = taskPanel({ taskRows: [review("T1", [
    { agent: "a-reviewer", state: "clear", turns: 6, maxTurns: 12, elapsedMs: 100_000 },
    { agent: "b-reviewer", state: "blocked", turns: 5, maxTurns: 12, elapsedMs: 80_000 },
  ])] });
  expect(instance.render(200).slice(3).map(body)).toEqual([
    "✓ a-reviewer 通过 · ↻6/12 · 1m40s",
    "✗ b-reviewer 打回 · ↻5/12 · 1m20s",
  ]);
});

const DOWN = "\x1b[B", UP = "\x1b[A";
const stepExec: Task = { kind: "execute", taskKey: "T2", agent: "worker", attempt: 1, runId: "run-t2", turns: 3, maxTurns: 10, elapsedMs: 5_000 };
const stepReview: Task = { kind: "review", taskKey: "T1", round: 1, reviewers: [
  { agent: "reviewer", state: "running", runId: "run-rv", turns: 2, maxTurns: 10, elapsedMs: 5_000 },
  { agent: "go-reviewer", state: "clear" },
  { agent: "vue-reviewer", state: "blocked" },
] };
const stepExplore: Task = { kind: "explore", runId: "run-ex", turns: 1, maxTurns: 5, elapsedMs: 1_000 };
const stepPrototype: PrototypePanelEntry = { repoId: "r", fetchedAt: 1_000,
  prototype: { runId: "run-proto", requirementId: "01900000-0000-7000-8000-000000000001", name: "导出设置页", version: 1, agent: "prototype", turns: 3, maxTurns: 30, elapsedMs: 41_000 } };
const stepMain: ExplorePanelEntry = { repoId: "r", fetchedAt: 1_000,
  explore: { runId: "run-main", source: "local", question: "现在的导出入口在哪", turns: 2, maxTurns: 15, elapsedMs: 12_300 } };
const stepOverview = (patch: Partial<PmOverview> = {}) => overview({ goals: ["导出"], taskRows: [stepExec, stepReview, stepExplore], ...patch });

function stepPanel(options: { taskRows?: Task[]; pendingItems?: PmOverview["pendingItems"]; prototypes?: boolean; main?: boolean; entries?: boolean } = {}) {
  const openItem = vi.fn(), togglePause = vi.fn(), openSteps = vi.fn();
  const instance = new PmPanel({ now: () => 1_000, openItem, togglePause, openSteps } as never);
  const entry: PmPanelEntry = { repoId: "r", overview: stepOverview({ ...(options.taskRows ? { taskRows: options.taskRows } : {}), ...(options.pendingItems ? { pendingItems: options.pendingItems } : {}) }), fetchedAt: 1_000 };
  if (options.entries !== false) instance.update([entry]);
  if (options.prototypes !== false) instance.updatePrototypes([stepPrototype]);
  if (options.main !== false) instance.updateExplores([stepMain]);
  instance.setTheme({ bg: (_kind, text) => `⟦${text}⟧` });
  instance.focus();
  return { instance, openItem, togglePause, openSteps, entry };
}
const marked = (instance: PmPanel): string[] => instance.render(200).filter((line) => line.includes("⟦")).map((line) => line.replace(/[⟦⟧]/g, ""));
const press = (instance: PmPanel, key: string, times = 1) => { for (let i = 0; i < times; i++) instance.handleInput(key); };

test("子代理行：↓ 依次停在需求、T2 执行、在跑的审查代理、PM 检索、原型设计、主窗口检索，到底不动，↑ 回到需求行；通过和打回的审查代理行与审查标题行跳过", () => {
  const { instance } = stepPanel();
  const expected = [/导出 · ↻5/, /T2 执行 · worker（第 1 次尝试）/, /⠋ reviewer · ↻2\/10/, /explore 检索/, /导出设置页（第 1 版）· prototype/, /本地 · 现在的导出入口在哪/];
  expected.forEach((pattern, index) => {
    if (index > 0) press(instance, DOWN);
    const lines = marked(instance);
    expect(lines, `第 ${index} 行`).toHaveLength(1);
    expect(lines[0]).toMatch(pattern);
  });
  press(instance, DOWN, 3);
  expect(marked(instance)).toHaveLength(1);
  expect(marked(instance)[0]).toMatch(/本地 · 现在的导出入口在哪/);
  for (let index = expected.length - 2; index >= 0; index--) {
    press(instance, UP);
    expect(marked(instance)).toHaveLength(1);
    expect(marked(instance)[0]).toMatch(expected[index]!);
  }
  press(instance, UP, 3);
  expect(marked(instance)[0]).toMatch(/导出 · ↻5/);
});

test("子代理行：任务级 ⚑ 事项行排在该任务的执行行之前，需求级 ⚑ 事项行排在 PM 检索行之后", () => {
  const taskItem = { itemId: "task:t2", kind: "adjudicate" as const, label: "待裁决：任务 T2 2 次未完成", version: "task:t2:3", taskKey: "T2", taskText: "2 次未完成" };
  const { instance } = stepPanel({
    taskRows: [{ kind: "pending", taskKey: "T2", itemId: "task:t2", text: "2 次未完成" }, stepExec, stepExplore],
    pendingItems: [taskItem, reqItem],
    prototypes: false, main: false,
  });
  const seen: string[] = [];
  for (let i = 0; i < 5; i++) { seen.push(marked(instance)[0]!); press(instance, DOWN); }
  expect(seen[0]).toMatch(/导出 · ↻5/);
  expect(seen[1]).toContain("⚑ T2 2 次未完成");
  expect(seen[2]).toContain("T2 执行 · worker");
  expect(seen[3]).toContain("explore 检索");
  expect(seen[4]).toContain("⚑ 待核对：PM 接手理解 r2");
});

test("子代理行：没有任务行时需求行后面仍是 ⚑ 事项行，再后是原型设计行、主窗口检索行", () => {
  const { instance } = stepPanel({ taskRows: [], pendingItems: [reqItem] });
  const seen: string[] = [];
  for (let i = 0; i < 4; i++) { seen.push(marked(instance)[0]!); press(instance, DOWN); }
  expect(seen[1]).toContain("⚑ 待核对：PM 接手理解 r2");
  expect(seen[2]).toContain("导出设置页（第 1 版）");
  expect(seen[3]).toContain("本地 · 现在的导出入口在哪");
});

test("子代理行：光标在 T2 执行行时只有这一行带选中背景；主题没有 bg 时只把这一行行首换成 ›", () => {
  const { instance } = stepPanel();
  press(instance, DOWN);
  const lines = instance.render(200);
  expect(lines.filter((line) => line.includes("⟦"))).toEqual(["⟦     ├ ⠋ T2 执行 · worker（第 1 次尝试）· ↻3/10 · 5.0s⟧"]);

  const plain = stepPanel();
  plain.instance.setTheme({});
  press(plain.instance, DOWN);
  const rendered = plain.instance.render(200);
  expect(rendered.filter((line) => line.startsWith("›"))).toEqual(["›    ├ ⠋ T2 执行 · worker（第 1 次尝试）· ↻3/10 · 5.0s"]);
});

test("子代理行：子代理行按回车用 { repoId, runId, title } 调用 openSteps；需求行回车不调用任何回调", () => {
  const { instance, openSteps, openItem, togglePause } = stepPanel();
  press(instance, "\r");
  expect(openSteps).not.toHaveBeenCalled();
  expect(openItem).not.toHaveBeenCalled();
  expect(togglePause).not.toHaveBeenCalled();
  const expected = [
    { runId: "run-t2", title: "T2 执行 · worker（第 1 次尝试）" },
    { runId: "run-rv", title: "T1 第 1 轮审查 · reviewer" },
    { runId: "run-ex", title: "explore 检索" },
    { runId: "run-proto", title: "导出设置页（第 1 版）· prototype" },
    { runId: "run-main", title: "本地 · 现在的导出入口在哪" },
  ];
  for (const target of expected) {
    press(instance, DOWN);
    expect(instance.handleInput("\r")).toBe(true);
    expect(openSteps).toHaveBeenLastCalledWith({ repoId: "r", ...target });
  }
  expect(openSteps).toHaveBeenCalledTimes(5);
  expect(openItem).not.toHaveBeenCalled();
});

test("子代理行：联网检索写「联网」，问题里的连续空白合成一个空格", () => {
  const { instance, openSteps } = stepPanel({ taskRows: [], prototypes: false, main: false });
  instance.updateExplores([{ repoId: "r", fetchedAt: 1_000, explore: { ...stepMain.explore, source: "web", question: "企业微信\n\n  自建应用" } }]);
  press(instance, DOWN);
  press(instance, "\r");
  expect(openSteps).toHaveBeenCalledWith({ repoId: "r", runId: "run-main", title: "联网 · 企业微信 自建应用" });
});

test("子代理行：⚑ 事项行回车照旧调用 openItem，不调用 openSteps", () => {
  const taskItem = { itemId: "task:t2", kind: "adjudicate" as const, label: "待裁决：任务 T2 2 次未完成", version: "task:t2:3", taskKey: "T2", taskText: "2 次未完成" };
  const { instance, openItem, openSteps } = stepPanel({ taskRows: [{ kind: "pending", taskKey: "T2", itemId: "task:t2", text: "2 次未完成" }, stepExec], pendingItems: [taskItem] });
  press(instance, DOWN);
  press(instance, "\r");
  expect(openItem).toHaveBeenCalledWith(expect.objectContaining({ repoId: "r" }), taskItem);
  expect(openSteps).not.toHaveBeenCalled();
});

test("子代理行：需求下面的子代理行按 p 调用 togglePause（参数是所属 entry）", () => {
  const { instance, togglePause, entry } = stepPanel();
  press(instance, DOWN);
  expect(marked(instance)[0]).toContain("T2 执行");
  expect(instance.handleInput("p")).toBe(true);
  expect(togglePause).toHaveBeenLastCalledWith(entry);
  press(instance, DOWN);
  expect(marked(instance)[0]).toContain("⠋ reviewer");
  press(instance, "p");
  expect(togglePause).toHaveBeenLastCalledWith(entry);
  press(instance, DOWN);
  press(instance, "P");
  expect(togglePause).toHaveBeenLastCalledWith(entry);
  expect(togglePause).toHaveBeenCalledTimes(3);
});

test("子代理行：原型设计行、主窗口检索行按 p 不调用任何回调，但按键被吃掉", () => {
  const { instance, togglePause, openItem, openSteps } = stepPanel();
  press(instance, DOWN, 4);
  expect(marked(instance)[0]).toContain("导出设置页");
  expect(instance.handleInput("p")).toBe(true);
  press(instance, DOWN);
  expect(marked(instance)[0]).toContain("本地 · 现在的导出入口在哪");
  expect(instance.handleInput("p")).toBe(true);
  expect(togglePause).not.toHaveBeenCalled();
  expect(openItem).not.toHaveBeenCalled();
  expect(openSteps).not.toHaveBeenCalled();
});

test("子代理行：只有原型设计行或只有主窗口检索行时 hasRows 为真，什么都没有时为假", () => {
  const options = { now: () => 1_000, openItem: vi.fn(), togglePause: vi.fn(), openSteps: vi.fn() };
  const onlyMain = new PmPanel(options);
  expect(onlyMain.hasRows()).toBe(false);
  onlyMain.updateExplores([stepMain]);
  expect(onlyMain.hasRows()).toBe(true);
  onlyMain.updateExplores([]);
  expect(onlyMain.hasRows()).toBe(false);
  const onlyPrototype = new PmPanel(options);
  onlyPrototype.updatePrototypes([stepPrototype]);
  expect(onlyPrototype.hasRows()).toBe(true);
});

test("子代理行：用含同一运行编号的数据刷新，光标不动，即使它前面多出了行", () => {
  const { instance, entry } = stepPanel();
  press(instance, DOWN);
  const taskItem = { itemId: "task:t2", kind: "adjudicate" as const, label: "待裁决：任务 T2 2 次未完成", version: "task:t2:3", taskKey: "T2", taskText: "2 次未完成" };
  instance.update([{ ...entry, fetchedAt: 1_000, overview: stepOverview({ pendingItems: [taskItem], taskRows: [{ kind: "pending", taskKey: "T2", itemId: "task:t2", text: "2 次未完成" }, { ...stepExec, turns: 4 } as Task, stepReview, stepExplore] }) }]);
  expect(marked(instance)).toHaveLength(1);
  expect(marked(instance)[0]).toContain("T2 执行 · worker（第 1 次尝试）· ↻4/10");
});

test("子代理行：选中的 T2 执行行不在新数据里时，光标落到相邻行，不越界、仍在可选行上", () => {
  const { instance, entry, openSteps } = stepPanel();
  press(instance, DOWN);
  instance.update([{ ...entry, overview: stepOverview({ taskRows: [stepReview, stepExplore] }) }]);
  const lines = marked(instance);
  expect(lines).toHaveLength(1);
  expect(lines[0]).toMatch(/导出 · ↻5|⠋ reviewer/);
  press(instance, DOWN, 20);
  expect(marked(instance)[0]).toContain("本地 · 现在的导出入口在哪");
  press(instance, "\r");
  expect(openSteps).toHaveBeenCalledWith(expect.objectContaining({ runId: "run-main" }));
});

test("子代理行：选中的原型设计行、主窗口检索行刷新后同样按运行编号保持，消失后落到相邻行", () => {
  const { instance } = stepPanel();
  press(instance, DOWN, 5);
  instance.updateExplores([{ ...stepMain, fetchedAt: 1_000, explore: { ...stepMain.explore, turns: 9 } }]);
  expect(marked(instance)[0]).toContain("本地 · 现在的导出入口在哪");
  instance.updateExplores([]);
  expect(marked(instance)).toHaveLength(1);
  expect(marked(instance)[0]).toContain("导出设置页");
  instance.updatePrototypes([{ ...stepPrototype, fetchedAt: 1_000, prototype: { ...stepPrototype.prototype, turns: 9 } }]);
  expect(marked(instance)[0]).toContain("导出设置页");
  instance.updatePrototypes([]);
  expect(marked(instance)).toHaveLength(1);
  expect(marked(instance)[0]).toMatch(/explore 检索|⠋ reviewer/);
});

const FULL_LINES = [
  "● 1 个需求运行中",
  "└─ ⠋ 导出 · ↻5 · 5 tool uses · 33.8k token (62%) · 12.3s",
  "     ├ ⠋ T2 执行 · worker（第 1 次尝试）· ↻3/10 · 5.0s",
  "     ├ T1 第 1 轮审查",
  "     │ ├ ⠋ reviewer · ↻2/10 · 5.0s",
  "     │ ├ ✓ go-reviewer 通过",
  "     │ └ ✗ vue-reviewer 打回",
  "     └ ⠋ explore 检索 · ↻1/5 · 1.0s",
  "● 1 个原型设计运行中",
  "└─ ⠋ 导出设置页（第 1 版）· prototype · ↻3/30 · 41.0s",
  "● 1 个检索运行中",
  "└─ ⠋ 本地 · 现在的导出入口在哪 · ↻2/15 · 12.3s",
];

test("子代理行：含子代理行的同一份数据，未获得焦点时每行文字不变", () => {
  const { instance } = stepPanel();
  instance.blur();
  instance.setTheme({});
  expect(instance.render(200)).toEqual(FULL_LINES);
});

test("子代理行：获得焦点后光标在任一行，去掉高亮的每行文字都不变，底部提示不变", () => {
  const { instance } = stepPanel();
  for (let i = 0; i < 6; i++) {
    expect(instance.render(200).map((line) => line.replace(/[⟦⟧]/g, ""))).toEqual([...FULL_LINES, "↑↓ 选择 · Enter 查看 · p 暂停/恢复 · Esc 返回输入框"]);
    press(instance, DOWN);
  }
});

function extensionFixture(overviewItems: PmOverview[]) {
  const fake = createFakePi();
  const calls: Array<[string, Record<string, unknown>]> = [];
  let present = true;
  const client = {
    connectionIdentity: () => ({ daemonInstanceId: "d", connectionId: "c", connectionSequence: 1 }),
    call: async (method: string, params: Record<string, unknown>) => {
      calls.push([method, params]);
      if (method === "pm.overview") return { items: overviewItems };
      if (method === "explore.list" || method === "prototypes.list") return { items: [] };
      if (method === "runs.steps") return { state: "completed", turns: 1, maxTurns: 5, elapsedMs: 1_000, steps: [] };
      throw new Error(`未预期的 RPC ${method}`);
    },
    subscribe: () => () => {},
    state: () => ({ status: "connected" as const }),
    close: () => {},
  };
  const window = { windowId: "w", sessionId: "s", workspace: { repos: [{ repoId: "r", path: "/r", commonDir: "/r/.git" }], skipped: [] },
    clients: { forRepo: (id: string) => (present && id === "r" ? client : undefined), all: () => [client], skipped: () => [], closeAll: () => {} } };
  pmPanelExtension(fake.pi as never, { windowReady: () => Promise.resolve(window) as never, createClock: () => createClock() });
  let input: ((data: string) => unknown) | undefined;
  let widget: { render(width: number): string[] } | undefined;
  let component: { handleInput(data: string): void } | undefined;
  const custom = vi.fn((factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (result: unknown) => void) => unknown) =>
    new Promise((resolve) => { component = factory({ requestRender: () => {} }, {}, {}, resolve) as typeof component; }));
  const notify = vi.fn();
  const ctx = { mode: "tui", hasUI: true, ui: { setWidget: (_key: string, factory?: (tui: unknown, theme: unknown) => typeof widget) => { if (factory) widget = factory({}, {}); },
    onTerminalInput: (handler: (data: string) => unknown) => { input = handler; return () => {}; }, getEditorText: () => "", notify, custom } };
  return { fake, ctx, calls, custom, notify, key: (data: string) => input!(data), widget: () => widget!, closeWindow: () => component?.handleInput("\x1b"), dropClient: () => { present = false; } };
}

test("子代理行：扩展层在子代理行按回车，用该仓库的客户端打开步骤窗口并请求 runs.steps", async () => {
  const f = extensionFixture([stepOverview({ taskRows: [stepExec] })]);
  await f.fake.trigger("session_start", { reason: "new" }, f.ctx);
  await vi.waitFor(() => expect(f.widget().render(200).join("\n")).toContain("T2 执行"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  f.key(DOWN); f.key(DOWN); f.key("\r");
  await vi.waitFor(() => expect(f.custom).toHaveBeenCalledTimes(1));
  await vi.waitFor(() => expect(f.calls).toContainEqual(["runs.steps", { runId: "run-t2" }]));
  expect(f.notify).not.toHaveBeenCalled();
  f.closeWindow();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const lines = f.widget().render(200);
  expect(lines.find((line) => line.includes("T2 执行"))!.startsWith("›")).toBe(true);
  expect(lines.at(-1)).toBe("↑↓ 选择 · Enter 查看 · p 暂停/恢复 · Esc 返回输入框");
  await f.fake.trigger("session_shutdown", {}, f.ctx);
});

test("子代理行：找不到该仓库的守护进程连接时提示错误，不打开窗口", async () => {
  const f = extensionFixture([stepOverview({ taskRows: [stepExec] })]);
  await f.fake.trigger("session_start", { reason: "new" }, f.ctx);
  await vi.waitFor(() => expect(f.widget().render(200).join("\n")).toContain("T2 执行"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  f.key(DOWN); f.key(DOWN);
  f.dropClient();
  f.key("\r");
  expect(f.notify).toHaveBeenCalledWith("找不到该仓库的守护进程连接", "error");
  expect(f.custom).not.toHaveBeenCalled();
  await f.fake.trigger("session_shutdown", {}, f.ctx);
});
