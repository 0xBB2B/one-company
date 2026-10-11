import { expect, test, vi } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { PmOverview } from "../runtime/pm-overview.ts";
import { formatElapsed, formatTokens, PmPanel } from "../runtime/pm-panel.ts";
import type { PmPanelEntry } from "../runtime/pm-panel.ts";
import pmPanelExtension from "../extensions/pm-panel.ts";
import { createClock } from "../runtime/clock.ts";
import { createFakePi } from "./helpers/fake-pi.ts";
import { registerRequirementInput } from "../extensions/lifecycle.ts";

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
  const ctx = { mode: "tui", hasUI: true, ui: { setWidget: () => {}, onTerminalInput: (handler: (data: string) => unknown) => { input = handler; return () => {}; },
    getEditorText: () => "", notify: vi.fn() } };
  await fake.trigger("session_start", { reason: "new" }, ctx);
  await vi.waitFor(() => expect(calls).toContain("pm.overview"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  input!("\x1b[B"); input!("\x1b[B"); input!("\r");
  await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledWith({ customType: "one-company.decision-packet", content: "决策包正文", display: true }, { triggerTurn: true }), { timeout: 5_000 });
  expect(revoke).toHaveBeenCalledTimes(1);
  expect(noteOpenedItem).toHaveBeenCalledWith({ repoId: "r", requirementId: jump.requirementId, itemId: "task:t1" });
  registerRequirementInput(undefined);
  const before = calls.filter((method) => method === "pm.overview").length;
  listeners.get("pm.overview.changed")!();
  await vi.waitFor(() => expect(calls.filter((method) => method === "pm.overview").length).toBe(before + 1));
  await fake.trigger("session_shutdown", {}, ctx);
});


const PROTOTYPE_PATH = "/Users/bb/.pi/agent/one-company/repos/3c9e/prototypes/0192f3a4-7c1e-7b2a-9d4e-5f6a7b8c9d0e/hud-panel.v1.html";
const prototypeItem = { itemId: "prototype:t1", kind: "prototype" as const, label: "待你确认原型：任务 hud-panel（第 1 版）", version: "prototype:t1:1:9f2c41d07ab3" };
const waiting = overview({ goals: ["状态面板"], status: "waiting", doing: "等待你确认原型", pendingItems: [prototypeItem] });

/** 面板扩展加一个可操作的假窗口：记录守护进程调用，弹窗时把窗口组件交给用例按键。 */
async function prototypeWindow(openFile: (path: string) => Promise<boolean>) {
  const fake = createFakePi();
  const appendEntry = vi.fn(), sendMessage = vi.fn();
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const client = {
    connectionIdentity: () => ({ daemonInstanceId: "d", connectionId: "c", connectionSequence: 1 }),
    call: async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      if (method === "pm.overview") return { items: [waiting] };
      if (method === "pm.prototype") return { itemId: "prototype:t1", itemVersion: prototypeItem.version, taskKey: "hud-panel", version: 1, hash: "9f2c41d07ab3" + "0".repeat(52),
        bytes: 42_189, path: PROTOTYPE_PATH, note: "三项状态横排，快跑时速度数字变绿" };
      if (method === "pm.prototypeDecide") return { version: 1, choice: params.choice };
      throw new Error(`未预期的 RPC ${method}`);
    },
    subscribe: () => () => {}, state: () => ({ status: "connected" as const }), close: () => {},
  };
  const window = { windowId: "w", sessionId: "s", workspace: { repos: [{ repoId: "r", path: "/r", commonDir: "/r/.git" }], skipped: [] },
    clients: { forRepo: (id: string) => (id === "r" ? client : undefined), all: () => [client], skipped: () => [], closeAll: () => {} } };
  pmPanelExtension({ ...fake.pi, appendEntry, sendMessage } as never, { windowReady: () => Promise.resolve(window) as never, createClock: () => createClock(), openFile });
  let input: ((data: string) => unknown) | undefined;
  let view: { render(width: number): string[]; handleInput(data: string): void } | undefined;
  const notify = vi.fn();
  const ctx = { mode: "tui", hasUI: true, ui: { setWidget: () => {}, onTerminalInput: (handler: (data: string) => unknown) => { input = handler; return () => {}; }, getEditorText: () => "", notify,
    custom: (factory: (tui: unknown, theme: unknown, keys: unknown, done: (value: unknown) => void) => typeof view) =>
      new Promise((resolve) => { view = factory({ requestRender: () => {} }, { fg: (_kind: string, text: string) => text, bold: (text: string) => text }, {}, resolve); }) } };
  await fake.trigger("session_start", { reason: "new" }, ctx);
  await vi.waitFor(() => expect(calls.some((call) => call.method === "pm.overview")).toBe(true));
  await new Promise((resolve) => setTimeout(resolve, 0));
  input!("\x1b[B"); input!("\x1b[B"); input!("\r");
  await vi.waitFor(() => expect(view).toBeDefined(), { timeout: 5_000 });
  const decided = () => calls.filter((call) => call.method === "pm.prototypeDecide").map((call) => call.params);
  return { view: view!, calls, decided, appendEntry, sendMessage, notify, done: () => fake.trigger("session_shutdown", {}, ctx) };
}

test("M8E-AC2：在原型事项上按回车，浏览器打开原型并弹出与预览一致的确认窗口；选通过由程序直接登记，不插入决策包也不触发主代理", async () => {
  const openFile = vi.fn(async () => true);
  const w = await prototypeWindow(openFile);
  expect(openFile).toHaveBeenCalledWith(PROTOTYPE_PATH);
  expect(w.view.render(80)).toEqual([
    "─".repeat(80),
    " 确认原型",
    "",
    " 需求：状态面板",
    " 任务：hud-panel（原型第 1 版）",
    " 文件：/Users/bb/.pi/agent/one-company/repos/3c9e/prototypes/",
    "       0192f3a4-7c1e-7b2a-9d4e-5f6a7b8c9d0e/hud-panel.v1.html",
    " 大小 41.2 KB · 指纹 sha256:9f2c41d07ab3…",
    " 已在默认浏览器打开这个文件。",
    " worker 的说明（模型写的，仅供参考）：「三项状态横排，快跑时速度数字变绿」",
    "",
    " → 通过（按这一版开始实现）",
    "   返工（自己输入要改什么）",
    "",
    " ↑↓ 选择 · 回车确认 · Esc 暂不决定",
    "─".repeat(80),
  ]);
  w.view.handleInput("\r");
  await vi.waitFor(() => expect(w.decided()).toEqual([{ requirementId: waiting.requirementId, itemId: "prototype:t1", itemVersion: prototypeItem.version, choice: "accept", opinion: null }]));
  await vi.waitFor(() => expect(w.appendEntry).toHaveBeenCalledWith("one-company.prototype-decision", { text: "已登记：hud-panel 的原型第 1 版通过。" }));
  expect(w.sendMessage).not.toHaveBeenCalled();
  expect(w.calls.some((call) => call.method === "pm.packet")).toBe(false);
  await w.done();
});

test("M8E-AC2：光标移到返工直接输入意见，回车后按原话登记返工；空意见不提交；Esc 不登记；浏览器没打开时窗口写明", async () => {
  const w = await prototypeWindow(async () => false);
  expect(w.view.render(80)).toContain(" 浏览器没有打开，请手动打开上面的文件。");
  w.view.handleInput("\x1b[B");
  w.view.handleInput("\r");
  expect(w.decided()).toEqual([]);
  for (const char of "速度数字放大一号") w.view.handleInput(char);
  const lines = w.view.render(80);
  expect(lines).toContain(" → 返工（自己输入要改什么）");
  expect(lines.some((line) => line.includes("› 速度数字放大一号"))).toBe(true);
  expect(lines.at(-2)).toBe(" 直接输入 · 回车确认 · ↑↓ 选择 · Esc 暂不决定");
  w.view.handleInput("\r");
  await vi.waitFor(() => expect(w.decided()).toEqual([{ requirementId: waiting.requirementId, itemId: "prototype:t1", itemVersion: prototypeItem.version, choice: "rework", opinion: "速度数字放大一号" }]));
  await vi.waitFor(() => expect(w.appendEntry).toHaveBeenCalledWith("one-company.prototype-decision", { text: "已登记：hud-panel 的原型第 1 版返工，你的意见已原话交给 PM。" }));
  await w.done();

  const esc = await prototypeWindow(async () => true);
  esc.view.handleInput("\x1b");
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(esc.decided()).toEqual([]);
  expect(esc.appendEntry).not.toHaveBeenCalled();
  await esc.done();
});
