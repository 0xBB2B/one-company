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
const jump = overview({ pendingItems: [{ itemId: "task:t1", kind: "adjudicate", label: "待裁决：任务 login 两次未完成", version: "task:t1:3" }] });
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
    "│      └ ⚑ 待裁决：任务 login 两次未完成",
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
  const openItem = vi.fn(), togglePause = vi.fn();
  let clock = now;
  const instance = new PmPanel({ now: () => clock, openItem, togglePause });
  const entry: PmPanelEntry = { repoId: "r", overview: overview(patch), fetchedAt: 1_000 };
  instance.update([entry]);
  const calls: Array<[string, string]> = [];
  instance.setTheme(ansi
    ? { fg: (kind, text) => { calls.push([kind, text]); return `\x1b[31m${text}\x1b[39m`; }, bg: (_kind, text) => `\x1b[44m${text}\x1b[49m` }
    : { fg: (kind, text) => { calls.push([kind, text]); return text; } });
  return { instance, openItem, calls, entry, setNow: (value: number) => { clock = value; } };
}
const body = (line: string) => line.replace(/^[ │├└]+/, "");
const exec = (taskKey: string, extra: Partial<Extract<Task, { kind: "execute" }>> = {}): Task =>
  ({ kind: "execute", taskKey, agent: "go-worker", attempt: 1, turns: 8, maxTurns: 20, elapsedMs: 182_000, ...extra });
const review = (taskKey: string, reviewers: Reviewer[]): Task => ({ kind: "review", taskKey, round: 1, reviewers });
const t1Item = { itemId: "task:t1", kind: "adjudicate" as const, label: "待裁决：任务 T1 两次未完成", version: "task:t1:3", taskKey: "T1", taskText: "两次未完成" };
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

test("任务行 AC-2/AC-3：审查代理各状态的文字与颜色：打回 ✗、没交出结论 dim、跳过 warning、上一轮已通过整行 dim、通过的 ✓ 为 success", () => {
  const { instance, calls } = taskPanel({ taskRows: [review("T1", [
    { agent: "a-reviewer", state: "blocked", turns: 6, maxTurns: 10, elapsedMs: 9_000 },
    { agent: "b-reviewer", state: "ended", turns: 7, maxTurns: 10, elapsedMs: 9_000 },
    { agent: "go-reviewer", state: "skipped_disabled" },
    { agent: "c-reviewer", state: "skipped_missing" },
    { agent: "vue-reviewer", state: "passed_earlier" },
    { agent: "d-reviewer", state: "clear", turns: 4, maxTurns: 10, elapsedMs: 30_000 },
  ])] });
  const lines = instance.render(200).slice(3).map(body);
  expect(lines[0]).toMatch(/^✗ a-reviewer 打回 · ↻6\/10/);
  expect(lines[1]).toMatch(/^– b-reviewer 没交出结论 · ↻7\/10/);
  expect(lines[2]).toBe("– go-reviewer 已关闭，本轮未审");
  expect(lines[3]).toBe("– c-reviewer 已不存在，本轮未审");
  expect(lines[4]).toBe("✓ vue-reviewer 上一轮已通过");
  expect(lines[5]).toMatch(/^✓ d-reviewer 通过 · ↻4\/10/);
  const has = (kind: string, part: string) => calls.some(([k, text]) => k === kind && text.includes(part));
  expect(has("dim", "b-reviewer 没交出结论")).toBe(true);
  expect(has("warning", "go-reviewer 已关闭，本轮未审")).toBe(true);
  expect(has("warning", "c-reviewer 已不存在，本轮未审")).toBe(true);
  expect(has("dim", "✓ vue-reviewer 上一轮已通过")).toBe(true);
  expect(calls.some(([k, text]) => k === "success" && text.includes("vue-reviewer"))).toBe(false);
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

test("任务行 AC-4：任务级待处理事项画成 ⚑ 行，选中后 Enter 打开决策包；任务进度行不可选中", () => {
  const { instance, openItem, entry } = taskPanel({
    taskRows: [{ kind: "pending", taskKey: "T1", itemId: "task:t1", text: "两次未完成" }, exec("T2")],
    pendingItems: [t1Item],
  });
  instance.focus();
  const lines = instance.render(200);
  expect(lines[2]).toBe("     ├ ⚑ T1 两次未完成");
  expect(lines[3]).toMatch(/^ {5}└ ⠋ T2 执行/);
  instance.handleInput("\x1b[B");
  instance.handleInput("\r");
  expect(openItem).toHaveBeenCalledTimes(1);
  expect(openItem).toHaveBeenLastCalledWith(expect.objectContaining({ overview: entry.overview }), t1Item);
  instance.handleInput("\x1b[B");
  instance.handleInput("\r");
  expect(openItem).toHaveBeenCalledTimes(2);
  expect(openItem).toHaveBeenLastCalledWith(expect.anything(), t1Item);
});

test("任务行 AC-4：需求级事项以 ⚑ 事项文字排在任务行之后，↑↓ 顺序与画出顺序一致（需求行 → 任务级 ⚑ → 需求级 ⚑）", () => {
  const { instance, openItem, entry } = taskPanel({
    taskRows: [{ kind: "pending", taskKey: "T1", itemId: "task:t1", text: "两次未完成" }, exec("T2")],
    pendingItems: [reqItem, t1Item],
  });
  instance.focus();
  const lines = instance.render(200);
  expect(lines.slice(2, 5)).toEqual([
    "     ├ ⚑ T1 两次未完成",
    expect.stringMatching(/^ {5}├ ⠋ T2 执行/),
    "     └ ⚑ 待核对：PM 接手理解 r2",
  ]);
  instance.handleInput("\x1b[B");
  instance.handleInput("\r");
  expect(openItem).toHaveBeenLastCalledWith(expect.objectContaining({ overview: entry.overview }), t1Item);
  instance.handleInput("\x1b[B");
  instance.handleInput("\r");
  expect(openItem).toHaveBeenLastCalledWith(expect.objectContaining({ overview: entry.overview }), reqItem);
  instance.handleInput("\x1b[B");
  instance.handleInput("\r");
  expect(openItem).toHaveBeenLastCalledWith(expect.anything(), reqItem);
  expect(openItem).toHaveBeenCalledTimes(3);
});

test("任务行 AC-4/AC-6：任务行有审查代理时 ↑↓ 只在需求行与 ⚑ 行之间移动，p 暂停所在 PM", () => {
  const { instance, openItem } = taskPanel({
    taskRows: [review("T1", [{ agent: "reviewer", state: "running", turns: 1, maxTurns: 10, elapsedMs: 1_000 }]), exec("T2")],
    pendingItems: [reqItem],
  });
  instance.focus();
  expect(instance.render(200)[2]).toMatch(/T1 第 1 轮审查/);
  instance.handleInput("\x1b[B");
  instance.handleInput("\r");
  expect(openItem).toHaveBeenLastCalledWith(expect.anything(), reqItem);
  instance.handleInput("\x1b[B");
  instance.handleInput("\r");
  expect(openItem).toHaveBeenCalledTimes(2);
  instance.handleInput("\x1b[A");
  instance.handleInput("\x1b[A");
  instance.handleInput("\r");
  expect(openItem).toHaveBeenCalledTimes(2);
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
      { kind: "pending", taskKey: "T1", itemId: "task:t1", text: "两次未完成" },
      review("T2", [
        { agent: "run-reviewer", state: "running", turns: 2, maxTurns: 10, elapsedMs: 5_000 },
        { agent: "blk-reviewer", state: "blocked", turns: 2, maxTurns: 10, elapsedMs: 5_000 },
        { agent: "end-reviewer", state: "ended", turns: 2, maxTurns: 10, elapsedMs: 5_000 },
        { agent: "clr-reviewer", state: "clear", turns: 2, maxTurns: 10, elapsedMs: 5_000 },
        { agent: "go-reviewer", state: "skipped_disabled" },
        { agent: "vue-reviewer", state: "passed_earlier" },
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

test("任务行 AC-2：在跑和打回的审查代理行不着灰；没交出结论、上一轮已通过整行 dim；通过的 ✓ 为 success、后面文字为 muted", () => {
  const { instance, calls } = taskPanel({ taskRows: [review("T1", [
    { agent: "run-reviewer", state: "running", turns: 2, maxTurns: 10, elapsedMs: 5_000 },
    { agent: "blk-reviewer", state: "blocked", turns: 6, maxTurns: 10, elapsedMs: 9_000 },
    { agent: "end-reviewer", state: "ended", turns: 7, maxTurns: 10, elapsedMs: 9_000 },
    { agent: "vue-reviewer", state: "passed_earlier" },
    { agent: "clr-reviewer", state: "clear", turns: 4, maxTurns: 10, elapsedMs: 30_000 },
    { agent: "go-reviewer", state: "skipped_disabled" },
  ])] });
  instance.render(200);
  const grey = calls.filter(([kind]) => kind === "dim" || kind === "muted");
  expect(grey.some(([, text]) => text.includes("run-reviewer"))).toBe(false);
  expect(grey.some(([, text]) => text.includes("blk-reviewer"))).toBe(false);
  const has = (kind: string, part: string) => calls.some(([k, text]) => k === kind && text.includes(part));
  expect(has("dim", "end-reviewer 没交出结论")).toBe(true);
  expect(has("dim", "✓ vue-reviewer 上一轮已通过")).toBe(true);
  expect(has("success", "✓")).toBe(true);
  expect(has("muted", "clr-reviewer 通过")).toBe(true);
  expect(has("dim", "clr-reviewer")).toBe(false);
  expect(has("warning", "go-reviewer 已关闭，本轮未审")).toBe(true);
});

test("任务行：任务行、审查代理行、任务级与需求级 ⚑ 行（未选中）的连线前缀都用 dim", () => {
  const { instance, calls } = taskPanel({
    taskRows: [
      { kind: "pending", taskKey: "T1", itemId: "task:t1", text: "两次未完成" },
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
    taskRows: [{ kind: "pending", taskKey: "T1", itemId: "task:t1", text: "两次未完成" }, exec("T2")], pendingItems: [t1Item] }) };
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
