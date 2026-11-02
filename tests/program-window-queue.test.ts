import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { openSettingsPage } from "../src/modules/settings/settings-extension.ts";
import type { SettingsExtensionContext } from "../src/modules/settings/settings-extension.ts";
import { createClock } from "../src/core/policy/clock.ts";
import { askWindow, chooseOrWriteWindow, chooseWindow, confirmWindow, openProgramWindow } from "../src/core/host/question-window.ts";
import { openShellPage } from "../src/modules/shell/shell-page.ts";
import { ShellRegistry } from "../src/core/host/shell-registry.ts";

const theme = { fg: (_kind: string, text: string) => text, bg: (_kind: string, text: string) => text, bold: (text: string) => text };
const ENTER = "\r", ESC = "\x1b", DOWN = "\x1b[B", BACKSPACE = "\x7f";
const settle = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));
const cleanups: Array<() => unknown> = [];
afterEach(async () => { for (const fn of cleanups.splice(0)) await fn(); });

interface Opened { component: { render(width: number): string[]; handleInput(data: string): void }; done: (value: unknown) => void }

function recorder() {
  const opened: Opened[] = [];
  const custom = vi.fn((factory: (tui: unknown, theme: unknown, keys: unknown, done: (value: unknown) => void) => Opened["component"]) =>
    new Promise((resolve) => { opened.push({ component: factory({ requestRender: () => {}, terminal: { rows: 40, columns: 80 } }, theme, {}, resolve), done: resolve }); }));
  return { host: { hasUI: true, ui: { custom } }, custom, opened };
}

const plain = (tag: string) => {
  let done!: (value: unknown) => void;
  const factory = vi.fn((_tui: unknown, _theme: unknown, _keys: unknown, finish: (value: unknown) => void) => {
    done = finish;
    return { render: () => [tag], handleInput: () => {}, invalidate: () => {} };
  });
  return { factory, finish: (value: unknown) => done(value) };
};

test("两个窗口依次打开：第一个开着时第二个的 custom 不被调用，第一个关掉后才打开，两个结果都正确返回", async () => {
  const r = recorder();
  const a = plain("A"), b = plain("B");
  const first = openProgramWindow(r.host as never, a.factory as never);
  const second = openProgramWindow(r.host as never, b.factory as never);
  await settle();
  expect(r.custom).toHaveBeenCalledTimes(1);
  expect(b.factory).not.toHaveBeenCalled();
  a.finish("甲结果");
  expect(await first).toBe("甲结果");
  await vi.waitFor(() => expect(r.custom).toHaveBeenCalledTimes(2));
  b.finish("乙结果");
  expect(await second).toBe("乙结果");
});

test("排队中的窗口收到中止：从队列移除、返回 undefined、不再打开，后面的窗口照常打开", async () => {
  const r = recorder();
  const a = plain("A"), b = plain("B"), c = plain("C");
  const controller = new AbortController();
  const first = openProgramWindow(r.host as never, a.factory as never);
  const second = openProgramWindow(r.host as never, b.factory as never, controller.signal);
  const third = openProgramWindow(r.host as never, c.factory as never);
  await settle();
  controller.abort();
  expect(await second).toBeUndefined();
  a.finish("甲");
  expect(await first).toBe("甲");
  await vi.waitFor(() => expect(c.factory).toHaveBeenCalledTimes(1));
  expect(b.factory).not.toHaveBeenCalled();
  expect(r.custom).toHaveBeenCalledTimes(2);
  c.finish("丙");
  expect(await third).toBe("丙");
});

test("正开着的窗口收到中止：窗口关闭并返回 undefined，队列继续打开下一个", async () => {
  const r = recorder();
  const a = plain("A"), b = plain("B");
  const controller = new AbortController();
  const first = openProgramWindow(r.host as never, a.factory as never, controller.signal);
  const second = openProgramWindow(r.host as never, b.factory as never);
  await settle();
  expect(r.custom).toHaveBeenCalledTimes(1);
  controller.abort();
  expect(await first).toBeUndefined();
  await vi.waitFor(() => expect(r.custom).toHaveBeenCalledTimes(2));
  b.finish("乙");
  expect(await second).toBe("乙");
});

test("没有界面时不排队也不打开，返回 undefined", async () => {
  const r = recorder();
  const a = plain("A");
  expect(await openProgramWindow({ ...r.host, hasUI: false } as never, a.factory as never)).toBeUndefined();
  expect(r.custom).not.toHaveBeenCalled();
});

test("选择窗口之间排队：前一个按 Esc 关掉后，后一个才弹出，结果各自返回", async () => {
  const r = recorder();
  const first = chooseWindow(r.host as never, { title: "窗口一", lines: [], choices: [{ label: "甲" }, { label: "乙" }] });
  const second = chooseWindow(r.host as never, { title: "窗口二", lines: [], choices: [{ label: "丙" }, { label: "丁" }] });
  await settle();
  expect(r.custom).toHaveBeenCalledTimes(1);
  r.opened[0]!.component.handleInput(ESC);
  expect(await first).toBeUndefined();
  await vi.waitFor(() => expect(r.opened).toHaveLength(2));
  expect(r.opened[1]!.component.render(60).join("\n")).toContain("窗口二");
  r.opened[1]!.component.handleInput(DOWN);
  r.opened[1]!.component.handleInput(ENTER);
  expect(await second).toBe("丁");
});

test("同一个窗口开着时，状态页的窗口也排队，等前一个关掉才打开", async () => {
  const r = recorder();
  const asking = chooseWindow(r.host as never, { title: "先开的窗口", lines: [], choices: [{ label: "甲" }] });
  const registry = new ShellRegistry({ clock: createClock() });
  const page = openShellPage({ ctx: r.host as never, registry, repos: [], clock: createClock() });
  await settle();
  expect(r.custom).toHaveBeenCalledTimes(1);
  r.opened[0]!.component.handleInput(ENTER);
  expect(await asking).toBe("甲");
  await vi.waitFor(() => expect(r.custom).toHaveBeenCalledTimes(2));
  r.opened[1]!.component.handleInput(ESC);
  await page;
});

test("同一个窗口开着时，/one:setting 页面也排队，等前一个关掉才打开", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-t-"));
  const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  cleanups.push(async () => {
    if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(join(root, "repo"), { recursive: true });
  await mkdir(join(root, "agent"), { recursive: true });
  await writeFile(join(root, "agent", "trust.json"), JSON.stringify({ [await realpath(join(root, "repo"))]: true }));
  const r = recorder();
  const asking = chooseWindow(r.host as never, { title: "先开的窗口", lines: [], choices: [{ label: "甲" }] });
  const ctx = { hasUI: true, mode: "tui", cwd: join(root, "repo"), ui: { ...r.host.ui, notify() {} },
    modelRegistry: { getAll: () => [], hasConfiguredAuth: () => false }, model: undefined } as unknown as SettingsExtensionContext;
  const page = openSettingsPage(ctx, { mainThinking: () => "high" });
  await settle(150);
  expect(r.custom).toHaveBeenCalledTimes(1);
  r.opened[0]!.component.handleInput(ENTER);
  expect(await asking).toBe("甲");
  await vi.waitFor(() => expect(r.custom).toHaveBeenCalledTimes(2));
  r.opened[1]!.component.handleInput(ESC);
  await page;
});

test("带输入行的窗口设了最长字数：超长时回车不能确认、输入保留，删到上限后可以提交", async () => {
  const r = recorder();
  const answer = chooseOrWriteWindow(r.host as never, { title: "写意见", lines: [], choices: [{ label: "通过" }], otherLabel: "返工", otherMaxLength: 5 });
  await vi.waitFor(() => expect(r.opened).toHaveLength(1));
  const view = r.opened[0]!.component;
  view.handleInput(DOWN);
  view.handleInput("一二三四五六");
  view.handleInput(ENTER);
  await settle();
  expect(r.opened[0]!.component.render(60).some((line) => line.includes("› 一二三四五六"))).toBe(true);
  view.handleInput(BACKSPACE);
  view.handleInput(ENTER);
  expect(await answer).toEqual({ choices: [], other: "一二三四五" });
});

function blockedRecorder(options: { idle?: () => boolean; withIdle?: boolean } = {}) {
  const opened: Opened[] = [];
  const custom = vi.fn((factory: (tui: unknown, theme: unknown, keys: unknown, done: (value: unknown) => void) => Opened["component"], _options?: unknown) =>
    new Promise((resolve) => { opened.push({ component: factory({ requestRender: () => {}, terminal: { rows: 40, columns: 80 } }, theme, {}, resolve), done: resolve }); }));
  const host: Record<string, unknown> = { hasUI: true, ui: { custom } };
  cleanups.push(async () => { for (let round = 0; round < 3; round++) { for (const window of opened) window.done(undefined); await settle(10); } });
  if (options.withIdle !== false) host.isIdle = options.idle ?? (() => false);
  return { host, custom, opened, optionsOf: (index: number) => custom.mock.calls[index]![1] as Record<string, unknown> | undefined };
}

const oneChoice = [{ label: "甲" }];
const question = (text: string) => ({ question: text, choices: oneChoice });

test("主代理运行中打开提问窗口：custom 的 options 带 blocked，message 是问题文字", async () => {
  const r = blockedRecorder();
  const answer = askWindow(r.host as never, question("要不要继续？"));
  await vi.waitFor(() => expect(r.opened).toHaveLength(1));
  expect(r.optionsOf(0)).toMatchObject({ blocked: { kind: "question", message: "要不要继续？" } });
  r.opened[0]!.component.handleInput(ENTER);
  await answer;
});

test("主代理运行中打开确认窗口：options 带 blocked，message 是窗口标题", async () => {
  const r = blockedRecorder();
  const answer = confirmWindow(r.host as never, { title: "确认执行吗", lines: [{ text: "正文不上报" }] });
  await vi.waitFor(() => expect(r.opened).toHaveLength(1));
  expect(r.optionsOf(0)).toMatchObject({ blocked: { kind: "question", message: "确认执行吗" } });
  r.opened[0]!.component.handleInput(ESC);
  await answer;
});

test("主代理运行中打开选择窗口：options 带 blocked，message 是窗口标题", async () => {
  const r = blockedRecorder();
  const answer = chooseWindow(r.host as never, { title: "选一个", lines: [], choices: oneChoice });
  await vi.waitFor(() => expect(r.opened).toHaveLength(1));
  expect(r.optionsOf(0)).toMatchObject({ blocked: { kind: "question", message: "选一个" } });
  r.opened[0]!.component.handleInput(ESC);
  await answer;
});

test("主代理运行中打开选择或输入窗口：options 带 blocked，message 是窗口标题", async () => {
  const r = blockedRecorder();
  const answer = chooseOrWriteWindow(r.host as never, { title: "选或写", lines: [], choices: oneChoice, otherLabel: "其他" });
  await vi.waitFor(() => expect(r.opened).toHaveLength(1));
  expect(r.optionsOf(0)).toMatchObject({ blocked: { kind: "question", message: "选或写" } });
  r.opened[0]!.component.handleInput(ESC);
  await answer;
});

test("显示时主代理没在运行：四种窗口的 options 都不带 blocked", async () => {
  const r = blockedRecorder({ idle: () => true });
  const windows = [
    askWindow(r.host as never, question("问题")),
    confirmWindow(r.host as never, { title: "确认", lines: [] }),
    chooseWindow(r.host as never, { title: "选择", lines: [], choices: oneChoice }),
    chooseOrWriteWindow(r.host as never, { title: "选或写", lines: [], choices: oneChoice, otherLabel: "其他" }),
  ];
  for (let index = 0; index < windows.length; index++) {
    await vi.waitFor(() => expect(r.opened).toHaveLength(index + 1));
    expect(r.optionsOf(index)?.blocked).toBeUndefined();
    r.opened[index]!.component.handleInput(ESC);
    await windows[index];
  }
});

test("窗口宿主没有 isIdle：options 不带 blocked", async () => {
  const r = blockedRecorder({ withIdle: false });
  const answer = askWindow(r.host as never, question("问题"));
  await vi.waitFor(() => expect(r.opened).toHaveLength(1));
  expect(r.optionsOf(0)?.blocked).toBeUndefined();
  r.opened[0]!.component.handleInput(ENTER);
  await answer;
});

test("两个窗口排队：第二个的 custom 等第一个关闭后才调用，带自己的文字", async () => {
  const r = blockedRecorder();
  const first = askWindow(r.host as never, question("问题一"));
  const second = askWindow(r.host as never, question("问题二"));
  await vi.waitFor(() => expect(r.opened).toHaveLength(1));
  await settle();
  expect(r.custom).toHaveBeenCalledTimes(1);
  expect(r.optionsOf(0)).toMatchObject({ blocked: { message: "问题一" } });
  r.opened[0]!.component.handleInput(ENTER);
  await first;
  await vi.waitFor(() => expect(r.custom).toHaveBeenCalledTimes(2));
  expect(r.optionsOf(1)).toMatchObject({ blocked: { kind: "question", message: "问题二" } });
  r.opened[1]!.component.handleInput(ENTER);
  await second;
});

test("两个窗口排队：是否带 blocked 按各自显示那一刻的 isIdle 判断", async () => {
  let idle = false;
  const r = blockedRecorder({ idle: () => idle });
  const first = askWindow(r.host as never, question("问题一"));
  const second = askWindow(r.host as never, question("问题二"));
  await vi.waitFor(() => expect(r.opened).toHaveLength(1));
  expect(r.optionsOf(0)).toMatchObject({ blocked: { message: "问题一" } });
  idle = true;
  r.opened[0]!.component.handleInput(ENTER);
  await first;
  await vi.waitFor(() => expect(r.custom).toHaveBeenCalledTimes(2));
  expect(r.optionsOf(1)?.blocked).toBeUndefined();
  r.opened[1]!.component.handleInput(ENTER);
  await second;
});

test("直接调用 openProgramWindow：即使 isIdle 返回 false，options 也不带 blocked", async () => {
  const r = blockedRecorder();
  const a = plain("A");
  const opening = openProgramWindow(r.host as never, a.factory as never);
  await vi.waitFor(() => expect(r.custom).toHaveBeenCalledTimes(1));
  expect(r.optionsOf(0)?.blocked).toBeUndefined();
  a.finish("结果");
  expect(await opening).toBe("结果");
});

test("openProgramWindow 的 overlay options 原样传给 custom，且不带 blocked", async () => {
  const r = blockedRecorder();
  const a = plain("A");
  const opening = openProgramWindow(r.host as never, a.factory as never, undefined, { overlay: true });
  await vi.waitFor(() => expect(r.custom).toHaveBeenCalledTimes(1));
  expect(r.optionsOf(0)).toEqual({ overlay: true });
  a.finish("结果");
  await opening;
});

test("custom 完全不理 options（pi 低于 1.5.0）：窗口照常打开、回答、关闭，结果不变", async () => {
  const r = recorder();
  (r.host as Record<string, unknown>).isIdle = () => false;
  const answer = askWindow(r.host as never, question("问题"));
  await vi.waitFor(() => expect(r.opened).toHaveLength(1));
  r.opened[0]!.component.handleInput(ENTER);
  expect(await answer).toEqual({ choices: ["甲"] });
});

test("程序不直接向终端写状态：四种窗口在主代理运行中回答、Esc、信号中断关闭都不抛错", async () => {
  const r = blockedRecorder();
  const controller = new AbortController();
  const answered = askWindow(r.host as never, question("问题"));
  await vi.waitFor(() => expect(r.opened).toHaveLength(1));
  r.opened[0]!.component.handleInput(ENTER);
  expect(await answered).toEqual({ choices: ["甲"] });

  const confirmed = confirmWindow(r.host as never, { title: "确认", lines: [] });
  await vi.waitFor(() => expect(r.opened).toHaveLength(2));
  r.opened[1]!.component.handleInput(ESC);
  expect(await confirmed).toBe(false);

  const chosen = chooseWindow(r.host as never, { title: "选择", lines: [], choices: oneChoice }, controller.signal);
  await vi.waitFor(() => expect(r.opened).toHaveLength(3));
  controller.abort();
  expect(await chosen).toBeUndefined();

  const written = chooseOrWriteWindow(r.host as never, { title: "选或写", lines: [], choices: oneChoice, otherLabel: "其他" });
  await vi.waitFor(() => expect(r.opened).toHaveLength(4));
  r.opened[3]!.component.handleInput(ESC);
  expect(await written).toBeUndefined();
});
