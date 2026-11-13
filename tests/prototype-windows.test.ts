import { readFileSync } from "node:fs";
import { afterEach, expect, test, vi } from "vitest";
import prototypeExtension from "../src/modules/prototype/prototype-extension.ts";
import { chapterCountText, confirmWindowContent } from "../src/modules/prototype/prototype-windows.ts";
import type { PendingPrototype } from "../src/modules/prototype/prototype-windows.ts";
import { visibleWidth } from "@earendil-works/pi-tui";
import { askWindow } from "../src/core/host/question-window.ts";
import { createFakePi } from "./helpers/fake-pi.ts";

// 程序窗口排队是进程内唯一的一份，用例里没关掉的窗口会挡住后面用例的窗口
afterEach(() => { delete (globalThis as Record<symbol, unknown>)[Symbol.for("one-company.program-window-queue")]; });

const REPO = "a".repeat(64);
const SESSION = "session-main";
const REQ = "01900000-0000-7000-8000-000000000001";
const PATH = "/Users/bb/.pi/agent/one-company/repos/3c9e/prototypes/0192f3a4-7c1e-7b2a-9d4e-5f6a7b8c9d0e/settings-page.v2.html";
const PATH_V1 = "/Users/bb/.pi/agent/one-company/repos/3c9e/prototypes/0192f3a4-7c1e-7b2a-9d4e-5f6a7b8c9d0e/settings-page.v1.html";
const HASH_V2 = "4be1c09d7a2f" + "0".repeat(52);
const HASH_V1 = "a01f77c3e9b2" + "0".repeat(52);

type DesignState = PendingPrototype["design"];
const pendingV2 = { requirementTitle: "设置页支持深色模式", draftVersion: 2, name: "设置页", version: 2, path: PATH, bytes: 18_841, hash: HASH_V2,
  note: "新增外观一栏", previousOpinion: "开关放到标题右边", options: [] as string[], design: { state: "same" } as DesignState };
const pendingV1 = { requirementTitle: "设置页支持深色模式", draftVersion: 2, name: "设置页", version: 1, path: PATH_V1, bytes: 16_384, hash: HASH_V1,
  note: "新增外观一栏", previousOpinion: null, options: [] as string[], design: { state: "same" } as DesignState };
const THREE_OPTIONS = ["顶部分栏", "左侧导航", "卡片网格"];
const withOptions = (options: string[]) => ({ ...pendingV2, options });

type Handler = (data: unknown) => unknown;
type Views = Array<{ render(width: number): string[]; handleInput(data: string): void }>;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ANCHOR = expect.stringMatching(UUID_PATTERN);
const BASE_ANCHOR = "01900000-0000-7000-8000-0000000000a1";
const DISPATCH_ANCHOR = "01900000-0000-7000-8000-0000000000a2";
const LINE = [BASE_ANCHOR, DISPATCH_ANCHOR];
const anchorEntry = (anchor: string, requirementId = REQ) => ({ type: "custom", customType: "one-company.line-anchor", data: { repoId: REPO, requirementId, anchor } });
const ANCHOR_ENTRY = "one-company.line-anchor";

interface Options {
  hasUI?: boolean;
  windowReady?: () => Promise<unknown>;
  branch?: unknown[];
  openFile?: (path: string) => Promise<boolean>;
  responses?: Record<string, (params: Record<string, unknown>) => unknown>;
}

async function harness(options: Options = {}) {
  const fake = createFakePi();
  const appendEntry = vi.fn(), sendMessage = vi.fn();
  const pi = { ...fake.pi, appendEntry, sendMessage, getThinkingLevel: () => "high" };
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const listeners = new Map<string, Handler[]>();
  const responses = options.responses ?? {};
  const client = {
    connectionIdentity: () => ({ daemonInstanceId: "d", connectionId: "c", connectionSequence: 1 }),
    call: async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      const respond = responses[method];
      if (!respond) throw new Error(`未预期的 RPC ${method}`);
      return respond(params);
    },
    subscribe: (event: string, handler: Handler) => { listeners.set(event, [...(listeners.get(event) ?? []), handler]); return () => {}; },
    state: () => ({ status: "connected" as const }),
    close: () => {},
  };
  const window = { windowId: "w", sessionId: SESSION, workspace: { repos: [{ repoId: REPO, path: "/r", commonDir: "/r/.git" }], skipped: [] },
    clients: { forRepo: (id: string) => (id === REPO ? client : undefined), all: () => [client], skipped: () => [], closeAll: () => {} } };
  const order: string[] = [];
  const openFile = vi.fn(async (path: string) => { order.push("open"); return options.openFile ? options.openFile(path) : true; });
  prototypeExtension(pi as never, { windowReady: options.windowReady ?? (() => Promise.resolve(window) as never), openFile } as never);

  const views: Views = [];
  const custom = vi.fn((factory: (tui: unknown, theme: unknown, keys: unknown, done: (value: unknown) => void) => Views[number]) =>
    new Promise((resolve) => {
      order.push("window");
      views.push(factory({ requestRender: () => {}, terminal: { rows: 40, columns: 80 } }, { fg: (kind: string, text: string) => (kind === "muted" ? `{${text}}` : text), bold: (text: string) => text }, {}, resolve));
    }));
  let branch = options.branch ?? LINE.map((anchor) => anchorEntry(anchor));
  const ctx = { mode: "tui", hasUI: options.hasUI ?? true, model: { provider: "prov", id: "mod" }, sessionManager: { getSessionId: () => SESSION, getBranch: () => branch },
    ui: { custom, notify: vi.fn(), setWidget: () => {} } };
  await fake.trigger("session_start", { reason: "new" }, ctx);

  const emit = async (event: string, data: Record<string, unknown>) => {
    await vi.waitFor(() => expect(listeners.has(event)).toBe(true));
    for (const handler of listeners.get(event)!) void handler(data);
  };
  const tool = () => (fake.registeredTools() as unknown as Array<{ name: string; parameters: unknown;
    execute(id: string, params: unknown, signal: AbortSignal | undefined, onUpdate: undefined, ctx: unknown): Promise<{ content: Array<{ text: string }>; details: unknown }> }>)
    .find((candidate) => candidate.name === "one_company_prototype")!;
  const run = (request: Record<string, unknown>, signal?: AbortSignal) => tool().execute("t1", { request }, signal as never, undefined, ctx);
  const outcome = async (request: Record<string, unknown>): Promise<string> => {
    try { return (await run(request)).content.map((part) => part.text).join("\n"); }
    catch (error) { return error instanceof Error ? error.message : String(error); }
  };
  const called = (method: string) => calls.filter((call) => call.method === method).map((call) => call.params);
  const nextView = async (index = 0) => { await vi.waitFor(() => expect(views.length).toBeGreaterThan(index), { timeout: 5_000 }); return views[index]!; };
  const switchBranch = (next: unknown[]) => { branch = next; };
  return { fake, calls, called, appendEntry, sendMessage, openFile, custom, views, order, emit, run, outcome, tool, nextView, ctx, switchBranch };
}

const submitted = (name: string, version: number, dispatchAnchor = DISPATCH_ANCHOR) => ({ parentSessionId: SESSION, requirementId: REQ, name, version, dispatchAnchor });
const decideOk = (params: Record<string, unknown>) => ({ version: params.version, choice: params.choice });

const CONFIRM_FRAME = (open: boolean, version: 1 | 2, options: string[] = [], cursor = 0): string[] => [
  "─".repeat(80),
  " 确认原型",
  "",
  " 需求：设置页支持深色模式（草稿，第 2 版）",
  ` 原型：设置页（第 ${version} 版）`,
  " {文件：/Users/bb/.pi/agent/one-company/repos/3c9e/prototypes/}",
  ` {      0192f3a4-7c1e-7b2a-9d4e-5f6a7b8c9d0e/settings-page.v${version}.html}`,
  version === 2 ? " {大小 18.4 KB · 指纹 sha256:4be1c09d7a2f…}" : " {大小 16.0 KB · 指纹 sha256:a01f77c3e9b2…}",
  open ? " {已在默认浏览器打开这个文件。}" : " 浏览器没有打开，请手动打开上面的文件。",
  ...(version === 2 ? [" {上一版你的意见：「开关放到标题右边」}"] : []),
  " {设计师的说明（模型写的，仅供参考）：「新增外观一栏」}",
  "",
  ...[...(options.length > 0 ? options.map((name, index) => `方案 ${"ABCDEF"[index]}：${name}`) : ["通过（写进需求草稿）"]), "其他（自己输入）"]
    .map((label, index) => `${index === cursor ? " →" : "  "} ${label}`),
  "",
  cursor > (options.length || 1) - 1
    ? " {直接输入 · 回车确认 · Shift+Enter 换行 · ↑↓ 选择 · Esc 放弃这一版}"
    : " {↑↓ 选择 · 回车确认 · Esc 放弃这一版}",
  "─".repeat(80),
];

const pendingFor = (name: string) => (name === "设置页" ? pendingV2 : { ...pendingV1, name, path: PATH_V1.replace("settings-page", name) });

test("收到交稿事件后先打开浏览器再弹确认窗口，窗口内容与选项顺序和预览一致", async () => {
  const h = await harness({ responses: { "prototypes.pending": () => pendingV2, "prototypes.decide": decideOk } });
  await h.emit("prototype.submitted", submitted("设置页", 2));
  const view = await h.nextView();
  expect(h.openFile).toHaveBeenCalledTimes(1);
  expect(h.openFile).toHaveBeenCalledWith(PATH);
  expect(h.order).toEqual(["open", "window"]);
  expect(h.called("prototypes.pending")).toEqual([{ requirementId: REQ, line: LINE, name: "设置页" }]);
  expect(view.render(80)).toEqual(CONFIRM_FRAME(true, 2));
});

test("浏览器没打开时窗口写明请手动打开，第一版不显示上一版意见", async () => {
  const h = await harness({ openFile: async () => false, responses: { "prototypes.pending": () => pendingV1, "prototypes.decide": decideOk } });
  await h.emit("prototype.submitted", submitted("设置页", 1));
  const view = await h.nextView();
  expect(view.render(80)).toEqual(CONFIRM_FRAME(false, 1));
});

test("选通过：decide 收到 accept 和指纹，记一条绿色程序记录，不触发主代理", async () => {
  const h = await harness({ responses: { "prototypes.pending": () => pendingV2, "prototypes.decide": decideOk } });
  await h.emit("prototype.submitted", submitted("设置页", 2));
  (await h.nextView()).handleInput("\r");
  await vi.waitFor(() => expect(h.called("prototypes.decide")).toEqual([{ requirementId: REQ, line: LINE, anchor: ANCHOR, name: "设置页", version: 2, hash: HASH_V2, choice: "accept", opinion: null, option: null }]));
  await vi.waitFor(() => expect(h.appendEntry).toHaveBeenCalledWith(expect.any(String), { text: "已登记：原型「设置页」第 2 版通过，已写进需求草稿。" }));
  expect(h.sendMessage).not.toHaveBeenCalled();
});

test("按 Esc 放弃：decide 收到 abandon，记一条程序记录，不触发主代理", async () => {
  const h = await harness({ responses: { "prototypes.pending": () => pendingV2, "prototypes.decide": decideOk } });
  await h.emit("prototype.submitted", submitted("设置页", 2));
  (await h.nextView()).handleInput("\x1b");
  await vi.waitFor(() => expect(h.called("prototypes.decide")).toEqual([{ requirementId: REQ, line: LINE, anchor: ANCHOR, name: "设置页", version: 2, hash: HASH_V2, choice: "abandon", opinion: null, option: null }]));
  await vi.waitFor(() => expect(h.appendEntry).toHaveBeenCalledWith(expect.any(String), { text: "已登记：放弃原型「设置页」第 2 版，它不再挡住批准。" }));
  expect(h.sendMessage).not.toHaveBeenCalled();
});

const stripCursor = (line: string) => line.replace(/\x1b_pi:(?:c|fc|\/fc)\x07/g, "");
const inputLine = (view: Views[number]) => view.render(80).map(stripCursor).find((line) => line.startsWith("      › "));
const OPINION_MESSAGE = (opinion: string) => ["用户对原型「设置页」第 2 版提了意见，这一版仍在等用户确认。", `文件：${PATH}`, "用户原话：", opinion,
  "先弄清用户想要什么：可能是提问、要改原型，也可能是要改需求正文；拿不准就先用 one_company_user_interact ask 问用户。是提问就回答；要改需求正文就用 updateDraft 改草稿；处理完都用 one_company_prototype confirm 重开这份原型的确认窗口。要改原型时，先把你理解的修改要点告诉用户，问要不要按这些重出一版；用户明确同意后，才用 one_company_prototype dispatch 重派设计师，把确认过的修改要点写进要画什么。设计师会拿到这一版文件和用户原话，重派后这一版作废。"].join("\n");
const CHOSEN_MESSAGE = ["用户通过了原型「设置页」第 2 版，选了方案 B：左侧导航，其余方案不做。",
  "这个选择已和这一版原型一起存下，批准需求后会交给 PM 和子代理。需求正文和它对不上时，按它改正文。"].join("\n");

test("在其他一行写字回车：decide 收到 opinion 和去首尾空白的原话，绿字写明仍在等确认，主代理收到带文件位置和原话的消息并接着回复", async () => {
  const h = await harness({ responses: { "prototypes.pending": () => pendingV2, "prototypes.decide": decideOk } });
  await h.emit("prototype.submitted", submitted("设置页", 2));
  const view = await h.nextView();
  view.handleInput("\x1b[B");
  view.handleInput("\x1b[B");
  expect(view.render(80)).toContain(" {直接输入 · 回车确认 · Shift+Enter 换行 · ↑↓ 选择 · Esc 放弃这一版}");
  for (const char of "  深色下按钮边框太亮 ") view.handleInput(char);
  expect(inputLine(view)).toContain("› ");
  expect(inputLine(view)).toContain("深色下按钮边框太亮");
  view.handleInput("\r");
  await vi.waitFor(() => expect(h.called("prototypes.decide")).toEqual([{ requirementId: REQ, line: LINE, anchor: ANCHOR, name: "设置页", version: 2, hash: HASH_V2, choice: "opinion", opinion: "深色下按钮边框太亮", option: null }]));
  await vi.waitFor(() => expect(h.appendEntry).toHaveBeenCalledWith(expect.any(String), { text: "已登记：你对原型「设置页」第 2 版的意见已原话交给主代理，这一版仍在等你确认。" }));
  expect(h.sendMessage).toHaveBeenCalledTimes(1);
  const [message, options] = h.sendMessage.mock.calls[0]!;
  expect(message.content).toBe(OPINION_MESSAGE("深色下按钮边框太亮"));
  expect(options).toEqual({ triggerTurn: true });
});

test("在其他一行用 Shift+Enter 换行输入：换行原样保留在 decide 参数和给主代理的消息里", async () => {
  const h = await harness({ responses: { "prototypes.pending": () => pendingV2, "prototypes.decide": decideOk } });
  await h.emit("prototype.submitted", submitted("设置页", 2));
  const view = await h.nextView();
  view.handleInput("\x1b[B");
  view.handleInput("\x1b[B");
  for (const char of "第一行") view.handleInput(char);
  view.handleInput("\x1b[13;2u");
  for (const char of "第二行") view.handleInput(char);
  view.handleInput("\r");
  await vi.waitFor(() => expect(h.called("prototypes.decide")).toHaveLength(1));
  expect(h.called("prototypes.decide")[0]).toMatchObject({ choice: "opinion", opinion: "第一行\n第二行", option: null });
  await vi.waitFor(() => expect(h.sendMessage).toHaveBeenCalledTimes(1));
  expect(h.sendMessage.mock.calls[0]![0].content).toBe(OPINION_MESSAGE("第一行\n第二行"));
});

test("在其他一行空着回车：不调用 decide，不触发主代理", async () => {
  const h = await harness({ responses: { "prototypes.pending": () => pendingV2, "prototypes.decide": decideOk } });
  await h.emit("prototype.submitted", submitted("设置页", 2));
  const view = await h.nextView();
  view.handleInput("\x1b[B");
  view.handleInput("\x1b[B");
  view.handleInput("\r");
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(h.called("prototypes.decide")).toEqual([]);
  expect(h.sendMessage).not.toHaveBeenCalled();
});

test("confirm 动作打开的窗口在其他一行写字回车：同样登记 opinion 并通知主代理", async () => {
  const h = await harness({ responses: { "prototypes.pending": () => pendingV2, "prototypes.decide": decideOk } });
  const done = h.run({ action: "confirm", repoId: REPO, requirementId: REQ, name: "设置页" });
  const view = await h.nextView();
  view.handleInput("\x1b[B");
  view.handleInput("\x1b[B");
  for (const char of "再亮一点") view.handleInput(char);
  view.handleInput("\r");
  await done;
  await vi.waitFor(() => expect(h.called("prototypes.decide")).toEqual([{ requirementId: REQ, line: LINE, anchor: ANCHOR, name: "设置页", version: 2, hash: HASH_V2, choice: "opinion", opinion: "再亮一点", option: null }]));
  await vi.waitFor(() => expect(h.sendMessage).toHaveBeenCalledTimes(1));
  expect(h.sendMessage.mock.calls[0]![0].content).toBe(OPINION_MESSAGE("再亮一点"));
  expect(h.sendMessage.mock.calls[0]![1]).toEqual({ triggerTurn: true });
});

test("confirm 动作的窗口按 Esc 同样登记放弃，工具结果写明放弃", async () => {
  const h = await harness({ responses: { "prototypes.pending": () => pendingV2, "prototypes.decide": decideOk } });
  const done = h.run({ action: "confirm", repoId: REPO, requirementId: REQ, name: "设置页" });
  (await h.nextView()).handleInput("\x1b");
  const result = await done;
  expect(h.called("prototypes.decide")).toEqual([{ requirementId: REQ, line: LINE, anchor: ANCHOR, name: "设置页", version: 2, hash: HASH_V2, choice: "abandon", opinion: null, option: null }]);
  expect(result.content.map((part) => part.text).join("\n")).toContain("放弃");
  expect(h.sendMessage).not.toHaveBeenCalled();
});

test("没有界面时不弹窗也不调用 decide", async () => {
  const h = await harness({ hasUI: false, responses: { "prototypes.pending": () => pendingV2, "prototypes.decide": decideOk } });
  await h.emit("prototype.submitted", submitted("设置页", 2));
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(h.custom).not.toHaveBeenCalled();
  expect(h.called("prototypes.decide")).toEqual([]);
  expect(h.appendEntry).not.toHaveBeenCalled();
});

test("别的会话派出的设计师交稿，派发锚点不在本会话当前对话线上，本会话不弹窗", async () => {
  const offLine = "01900000-0000-7000-8000-0000000000c2";
  const h = await harness({ responses: { "prototypes.pending": () => pendingV2, "prototypes.decide": decideOk } });
  await h.emit("prototype.submitted", { ...submitted("设置页", 2, offLine), parentSessionId: "other-session" });
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(h.custom).not.toHaveBeenCalled();
  expect(h.openFile).not.toHaveBeenCalled();
});

test("从别的会话派出的那条对话线 fork 出来的会话：对话线里有派发锚点，交稿后照常弹窗", async () => {
  const h = await harness({ responses: { "prototypes.pending": () => pendingV2, "prototypes.decide": decideOk } });
  await h.emit("prototype.submitted", { ...submitted("设置页", 2), parentSessionId: "other-session" });
  expect((await h.nextView()).render(80)).toEqual(CONFIRM_FRAME(true, 2));
});

test("两份原型几乎同时交稿：第一个窗口关掉之后才弹第二个", async () => {
  const h = await harness({ responses: { "prototypes.pending": (params) => pendingFor(params.name as string), "prototypes.decide": decideOk } });
  await h.emit("prototype.submitted", submitted("设置页", 2));
  await h.emit("prototype.submitted", submitted("引导页", 1));
  const first = await h.nextView();
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(h.views).toHaveLength(1);
  expect(first.render(80)).toContain(" 原型：设置页（第 2 版）");
  first.handleInput("\x1b");
  const second = await h.nextView(1);
  expect(second.render(80)).toContain(" 原型：引导页（第 1 版）");
  expect(h.openFile).toHaveBeenCalledTimes(2);
});

test("设计师没交稿就结束：主代理收到带原因的消息并接着回复", async () => {
  const h = await harness();
  await h.emit("prototype.finished", { parentSessionId: SESSION, requirementId: REQ, name: "设置页", version: 2, reason: "对话轮次用满，设计师没有提交原型" });
  await vi.waitFor(() => expect(h.sendMessage).toHaveBeenCalledTimes(1));
  const [message, options] = h.sendMessage.mock.calls[0]!;
  expect(message.content).toContain("对话轮次用满，设计师没有提交原型");
  expect(options).toEqual({ triggerTurn: true });
});

test("别的会话的设计师结束，本会话不收到消息", async () => {
  const h = await harness();
  await h.emit("prototype.finished", { parentSessionId: "other-session", requirementId: REQ, name: "设置页", version: 2, reason: "对话轮次用满" });
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(h.sendMessage).not.toHaveBeenCalled();
});

test("confirm 动作在有待确认版本时重开浏览器和同样的确认窗口，选择由用户在窗口里做", async () => {
  const h = await harness({ responses: { "prototypes.pending": () => pendingV2, "prototypes.decide": decideOk } });
  const done = h.run({ action: "confirm", repoId: REPO, requirementId: REQ, name: "设置页" });
  const view = await h.nextView();
  expect(h.openFile).toHaveBeenCalledWith(PATH);
  expect(view.render(80)).toEqual(CONFIRM_FRAME(true, 2));
  view.handleInput("\r");
  await done;
  await vi.waitFor(() => expect(h.called("prototypes.decide")).toHaveLength(1));
});

test("confirm 动作没有待确认版本时返回原因和当前状态，不弹窗不开浏览器", async () => {
  const h = await harness({ responses: { "prototypes.pending": () => { throw new Error("原型「设置页」没有待你确认的版本，当前第 2 版已通过"); } } });
  const text = await h.outcome({ action: "confirm", repoId: REPO, requirementId: REQ, name: "设置页" });
  expect(text).toContain("没有待你确认的版本");
  expect(text).toContain("第 2 版已通过");
  expect(h.custom).not.toHaveBeenCalled();
  expect(h.openFile).not.toHaveBeenCalled();
  expect(h.called("prototypes.decide")).toEqual([]);
});

const removal = { requirementTitle: "设置页支持深色模式", draftVersion: 3, name: "旧外观弹窗", version: 1, approvedRevision: 2 };

const REMOVE_FRAME = (origin: string): string[] => [
  "─".repeat(80),
  " 移除原型",
  "",
  " 需求：设置页支持深色模式（草稿，第 3 版）",
  ` 原型：旧外观弹窗（第 1 版，${origin}）`,
  " {移除后，批准第 3 版时它不再交给 PM 和子代理；文件留在本机，不删除。}",
  "",
  " → 移除",
  "   保留",
  "",
  " {↑↓ 选择 · 回车确认 · Esc 取消（保留）}",
  "─".repeat(80),
];

test("remove 动作弹出移除窗口；选移除后调用 remove 并记一条程序记录", async () => {
  const h = await harness({ responses: { "prototypes.removal": () => removal, "prototypes.remove": () => ({}) } });
  const done = h.run({ action: "remove", repoId: REPO, requirementId: REQ, name: "旧外观弹窗" });
  const view = await h.nextView();
  expect(h.called("prototypes.removal")).toEqual([{ requirementId: REQ, line: LINE, name: "旧外观弹窗" }]);
  expect(view.render(80)).toEqual(REMOVE_FRAME("第 2 版需求里批准过"));
  view.handleInput("\r");
  await done;
  expect(h.called("prototypes.remove")).toEqual([{ requirementId: REQ, line: LINE, anchor: ANCHOR, name: "旧外观弹窗", version: 1 }]);
  expect(h.appendEntry).toHaveBeenCalledWith(expect.any(String), { text: "已登记：原型「旧外观弹窗」从草稿移除，批准第 3 版后生效。" });
});

test("本次草稿新通过的原型，移除窗口写明本次草稿新通过", async () => {
  const h = await harness({ responses: { "prototypes.removal": () => ({ ...removal, approvedRevision: null }), "prototypes.remove": () => ({}) } });
  const done = h.run({ action: "remove", repoId: REPO, requirementId: REQ, name: "旧外观弹窗" });
  const view = await h.nextView();
  expect(view.render(80)).toEqual(REMOVE_FRAME("本次草稿新通过"));
  view.handleInput("\x1b");
  await done;
});

test("移除窗口选保留或按 Esc 都不调用 remove，也不记录", async () => {
  const keep = await harness({ responses: { "prototypes.removal": () => removal, "prototypes.remove": () => ({}) } });
  const keepDone = keep.run({ action: "remove", repoId: REPO, requirementId: REQ, name: "旧外观弹窗" });
  const keepView = await keep.nextView();
  keepView.handleInput("\x1b[B");
  keepView.handleInput("\r");
  await keepDone;
  expect(keep.called("prototypes.remove")).toEqual([]);
  expect(keep.appendEntry).not.toHaveBeenCalled();

  const esc = await harness({ responses: { "prototypes.removal": () => removal, "prototypes.remove": () => ({}) } });
  const escDone = esc.run({ action: "remove", repoId: REPO, requirementId: REQ, name: "旧外观弹窗" });
  (await esc.nextView()).handleInput("\x1b");
  await escDone;
  expect(esc.called("prototypes.remove")).toEqual([]);
  expect(esc.appendEntry).not.toHaveBeenCalled();
});

test("remove 动作遇到草稿里没有的名字，直接返回原因，不弹窗不调用 remove", async () => {
  const h = await harness({ responses: { "prototypes.removal": () => { throw new Error("草稿里没有名为「不存在」的原型"); } } });
  const text = await h.outcome({ action: "remove", repoId: REPO, requirementId: REQ, name: "不存在" });
  expect(text).toContain("草稿里没有名为「不存在」的原型");
  expect(h.custom).not.toHaveBeenCalled();
  expect(h.called("prototypes.remove")).toEqual([]);
});

test("designers 动作调用 prototypes.designers，content 的每项只有 name、description，details 是守护进程原样返回", async () => {
  const designers = { items: [{ name: "prototype", description: "默认原型设计师", source: "builtin" }, { name: "brand-designer", description: "按品牌规范出原型", source: "/p/brand.md" }] };
  const h = await harness({ responses: { "prototypes.designers": () => designers } });
  const result = await h.run({ action: "designers", repoId: REPO });
  expect(JSON.parse(result.content[0]!.text)).toEqual({ items: [{ name: "prototype", description: "默认原型设计师" }, { name: "brand-designer", description: "按品牌规范出原型" }] });
  expect(result.details).toEqual(designers);
  expect(h.called("prototypes.designers")).toEqual([{}]);
});

test("dispatch 动作带上主窗口当前模型和思考等级调用 prototypes.dispatch", async () => {
  const h = await harness({ responses: { "prototypes.dispatch": () => ({ runId: "run-1", version: 1 }) } });
  const text = await h.outcome({ action: "dispatch", repoId: REPO, requirementId: REQ, name: "设置页", brief: "出设置页深色模式的界面原型", maxTurns: 30, agent: "brand-designer" });
  expect(text).toContain("run-1");
  expect(h.called("prototypes.dispatch")).toEqual([{ requirementId: REQ, line: LINE, anchor: ANCHOR, name: "设置页", brief: "出设置页深色模式的界面原型", maxTurns: 30, agent: "brand-designer",
    model: { provider: "prov", id: "mod" }, thinking: "high" }]);
});

test("dispatch 动作的 content 与守护进程返回的 JSON 逐字相同", async () => {
  const dispatched = { runId: "run-3", version: 1 };
  const h = await harness({ responses: { "prototypes.dispatch": () => dispatched } });
  const result = await h.run({ action: "dispatch", repoId: REPO, requirementId: REQ, name: "设置页", brief: "出原型", maxTurns: 20 });
  expect(result.content[0]!.text).toBe(JSON.stringify(dispatched));
});

test("dispatch 动作没点名设计师时不带 agent", async () => {
  const h = await harness({ responses: { "prototypes.dispatch": () => ({ runId: "run-2", version: 1 }) } });
  await h.outcome({ action: "dispatch", repoId: REPO, requirementId: REQ, name: "设置页", brief: "出原型", maxTurns: 20 });
  const [params] = h.called("prototypes.dispatch");
  expect(params).toEqual({ requirementId: REQ, line: LINE, anchor: ANCHOR, name: "设置页", brief: "出原型", maxTurns: 20, model: { provider: "prov", id: "mod" }, thinking: "high" });
});

const SHA = "f".repeat(64);
const RUN_ID = "01900000-0000-7000-8000-0000000000aa";
const file = (version: number, note: string, options: string[], picked: { letter: string; name: string } | null) => ({ version, hash: SHA, bytes: 1234, note, options, picked });
const board = () => ({
  requirementId: REQ, updatedAt: 1_750_000_000_000,
  entries: [
    { name: "设置页", lastVersion: 3,
      draft: file(1, "草稿说明", ["顶部分栏", "左侧导航"], { letter: "B", name: "左侧导航" }),
      approved: file(2, "通过说明", ["卡片网格"], null),
      removed: false,
      inFlight: { version: 3, runId: RUN_ID, agent: "prototype", status: "awaiting", file: file(3, "在途说明", ["甲", "乙"], null), designBase: SHA, designs: [{ letter: "A", hash: SHA, bytes: 99 }] },
      lastOpinion: { version: 2, opinion: "导航再窄一点" },
      lastEnded: { version: 2, reason: "设计师没交稿就结束" } },
    { name: "旧弹窗", lastVersion: 1, draft: null, approved: null, removed: true,
      inFlight: { version: 1, runId: RUN_ID, agent: "prototype", status: "designing", file: null, designBase: null, designs: null },
      lastOpinion: null, lastEnded: null },
  ],
});
const FORBIDDEN_KEYS = ["requirementId", "updatedAt", "hash", "bytes", "runId", "agent", "file"];
const keysDeep = (value: unknown): string[] => (value && typeof value === "object"
  ? Object.entries(value).flatMap(([key, inner]) => [key, ...keysDeep(inner)]) : []);

test("status 动作调用 prototypes.board，content 只有 entries 里的保留字段，details 是守护进程原样返回", async () => {
  const full = board();
  const h = await harness({ responses: { "prototypes.board": () => full } });
  const result = await h.run({ action: "status", repoId: REPO, requirementId: REQ });
  const content = JSON.parse(result.content[0]!.text) as { entries: Array<Record<string, unknown>> };
  expect(Object.keys(content)).toEqual(["entries"]);
  for (const key of FORBIDDEN_KEYS) expect(keysDeep(content), key).not.toContain(key);
  expect(content.entries[0]).toMatchObject({
    name: "设置页", lastVersion: 3, removed: false,
    draft: { version: 1, note: "草稿说明", options: ["顶部分栏", "左侧导航"], picked: { letter: "B", name: "左侧导航" } },
    approved: { version: 2, note: "通过说明", options: ["卡片网格"], picked: null },
    inFlight: { version: 3, status: "awaiting", note: "在途说明", options: ["甲", "乙"], picked: null },
    lastOpinion: { version: 2, opinion: "导航再窄一点" },
  });
  expect((content.entries[0]!.lastEnded as { reason: string }).reason).toBe("设计师没交稿就结束");
  expect(content.entries[0]!.inFlight).toEqual({ version: 3, status: "awaiting", note: "在途说明", options: ["甲", "乙"], picked: null });
  expect(result.details).toEqual(full);
  expect(h.called("prototypes.board")).toEqual([{ requirementId: REQ, line: LINE }]);
});

test("status 动作里在途版本还没有文件时，inFlight 只有 version、status，不写 note、options、picked", async () => {
  const h = await harness({ responses: { "prototypes.board": () => board() } });
  const result = await h.run({ action: "status", repoId: REPO, requirementId: REQ });
  const content = JSON.parse(result.content[0]!.text) as { entries: Array<Record<string, unknown>> };
  expect(content.entries[1]).toMatchObject({ name: "旧弹窗", lastVersion: 1, removed: true });
  expect(content.entries[1]!.inFlight).toEqual({ version: 1, status: "designing" });
});

test("repoId 不在当前工作区时返回原因，不调用守护进程", async () => {
  const h = await harness({ responses: { "prototypes.board": () => ({}) } });
  const text = await h.outcome({ action: "status", repoId: "b".repeat(64), requirementId: REQ });
  expect(text.length).toBeGreaterThan(0);
  expect(h.called("prototypes.board")).toEqual([]);
});

test("主代理的原型工具没有直接登记通过、意见、放弃的入口，伪造的动作被拒绝且不调用 decide", async () => {
  const h = await harness({ responses: { "prototypes.decide": decideOk, "prototypes.pending": () => pendingV2 } });
  const schema = JSON.stringify(h.tool().parameters);
  for (const action of ["designers", "dispatch", "status", "confirm", "remove"]) expect(schema).toContain(`"${action}"`);
  for (const forbidden of ["decide", "accept", "opinion", "abandon", "note", "option", "picked"]) expect(schema).not.toContain(forbidden);
  const text = await h.outcome({ action: "decide", repoId: REPO, requirementId: REQ, name: "设置页", version: 2, choice: "accept" });
  expect(text.length).toBeGreaterThan(0);
  expect(h.called("prototypes.decide")).toEqual([]);
  expect(h.fake.registeredTools().map((registered) => registered.name)).toEqual(["one_company_prototype"]);
});

test("主代理提示词写明原型设计的流程要点", () => {
  const rules = readFileSync(new URL("../rules/01-main-session.md", import.meta.url), "utf8");
  const text = rules.split("\n").filter((line) => line.includes("原型")).join("\n");
  expect(text).toContain("one_company_prototype");
  expect(text).toMatch(/界面/);
  expect(text).toMatch(/澄清/);
  expect(text).toMatch(/草稿/);
  expect(text).toContain("点名");
  expect(text).toMatch(/按描述挑|描述/);
  expect(text).toMatch(/不换/);
  expect(text).toContain("confirm");
  expect(text).toContain("remove");
  expect(text).toMatch(/照实转告/);
});

const fileChanged = () => Object.assign(new Error("file_changed：文件在交稿后被改过，与登记的指纹不一致"),
  { code: "file_changed", data: { advice: { why: "文件在交稿后被改过，与登记的指纹不一致", next: "这一版已作废，请让主代理重新派原型设计师" } } });

test("主代理提问窗口开着时收到交稿：确认窗口不打开也不登记决定，提问答完后才弹出", async () => {
  const h = await harness({ responses: { "prototypes.pending": () => pendingV2, "prototypes.decide": decideOk } });
  const asking = askWindow(h.ctx as never, { question: "要不要深色模式", choices: [{ label: "要" }, { label: "不要" }] });
  const askView = await h.nextView();
  await h.emit("prototype.submitted", submitted("设置页", 2));
  await new Promise((resolve) => setTimeout(resolve, 80));
  expect(h.views).toHaveLength(1);
  expect(h.called("prototypes.decide")).toEqual([]);
  askView.handleInput("\r");
  expect(await asking).toEqual({ choices: ["要"] });
  const confirm = await h.nextView(1);
  expect(confirm.render(80)).toContain(" 确认原型");
});

test("confirm 动作的窗口被中止后工具返回，不调用 decide", async () => {
  const h = await harness({ responses: { "prototypes.pending": () => pendingV2, "prototypes.decide": decideOk } });
  const controller = new AbortController();
  const done = h.run({ action: "confirm", repoId: REPO, requirementId: REQ, name: "设置页" }, controller.signal);
  await h.nextView();
  controller.abort();
  await done;
  expect(h.called("prototypes.decide")).toEqual([]);
  expect(h.appendEntry).not.toHaveBeenCalled();
}, 5_000);

test("remove 动作的窗口被中止后工具返回，不调用 remove", async () => {
  const h = await harness({ responses: { "prototypes.removal": () => removal, "prototypes.remove": () => ({}) } });
  const controller = new AbortController();
  const done = h.run({ action: "remove", repoId: REPO, requirementId: REQ, name: "旧外观弹窗" }, controller.signal);
  await h.nextView();
  controller.abort();
  await done;
  expect(h.called("prototypes.remove")).toEqual([]);
  expect(h.appendEntry).not.toHaveBeenCalled();
}, 5_000);

test("设计师没交稿结束时，给主代理的消息含原因、重派的建议和运行日志位置", async () => {
  const h = await harness();
  await h.emit("prototype.finished", { parentSessionId: SESSION, requirementId: REQ, name: "设置页", version: 2, runId: "run-xyz-123", log: "/tmp/pi-t-x/sessions/run-xyz-123.jsonl", reason: "轮数用满（30 轮），没有交稿" });
  await vi.waitFor(() => expect(h.sendMessage).toHaveBeenCalledTimes(1));
  const [message, options] = h.sendMessage.mock.calls[0]!;
  expect(message.content).toContain("轮数用满（30 轮），没有交稿");
  expect(message.content).toContain("重派");
  expect(message.content).toContain("运行日志：/tmp/pi-t-x/sessions/run-xyz-123.jsonl");
  expect(options).toEqual({ triggerTurn: true });
});

test("用户选通过但文件在交稿后被改过：提示用户这一版已作废（不带错误码、不说窗口没能打开），并通知主代理可以重派", async () => {
  const h = await harness({ responses: { "prototypes.pending": () => pendingV2, "prototypes.decide": () => { throw fileChanged(); } } });
  await h.emit("prototype.submitted", submitted("设置页", 2));
  (await h.nextView()).handleInput("\r");
  const notify = h.ctx.ui.notify as ReturnType<typeof vi.fn>;
  await vi.waitFor(() => expect(notify).toHaveBeenCalled());
  const shown = notify.mock.calls.map((call) => String(call[0])).join("\n");
  expect(shown).toContain("文件在交稿后被改过");
  expect(shown).toContain("已作废");
  expect(shown).not.toContain("file_changed");
  expect(shown).not.toContain("没能打开");
  expect(h.appendEntry).not.toHaveBeenCalled();
  await vi.waitFor(() => expect(h.sendMessage).toHaveBeenCalledTimes(1));
  const [message, options] = h.sendMessage.mock.calls[0]!;
  expect(message.content).toContain("作废");
  expect(message.content).toContain("重派");
  expect(options).toEqual({ triggerTurn: true });
});

test("选方案但文件在交稿后被改过：不记绿字，主代理只收到作废通知，没有选方案的消息", async () => {
  const h = await harness({ responses: { "prototypes.pending": () => withOptions(THREE_OPTIONS), "prototypes.decide": () => { throw fileChanged(); } } });
  await h.emit("prototype.submitted", submitted("设置页", 2));
  const view = await h.nextView();
  view.handleInput("\x1b[B");
  view.handleInput("\r");
  await vi.waitFor(() => expect(h.sendMessage).toHaveBeenCalledTimes(1));
  expect(h.appendEntry).not.toHaveBeenCalled();
  const [message, options] = h.sendMessage.mock.calls[0]!;
  expect(message.content).toContain("作废");
  expect(message.content).not.toContain("选了方案");
  expect(options).toEqual({ triggerTurn: true });
});

test("取待确认内容失败时，提示写没能打开确认窗口", async () => {
  const h = await harness({ responses: { "prototypes.pending": () => { throw new Error("连接已断开"); } } });
  await h.emit("prototype.submitted", submitted("设置页", 2));
  const notify = h.ctx.ui.notify as ReturnType<typeof vi.fn>;
  await vi.waitFor(() => expect(notify).toHaveBeenCalled());
  expect(String(notify.mock.calls[0]![0])).toContain("没能打开");
  expect(h.custom).not.toHaveBeenCalled();
});

test("其他一行的意见超过 4000 字时窗口不能确认、不调用 decide，意见留在窗口里；删到 4000 字后可以提交", async () => {
  const h = await harness({ responses: { "prototypes.pending": () => pendingV2, "prototypes.decide": decideOk } });
  await h.emit("prototype.submitted", submitted("设置页", 2));
  const view = await h.nextView();
  view.handleInput("\x1b[B");
  view.handleInput("\x1b[B");
  view.handleInput("字".repeat(4001));
  view.handleInput("\r");
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(h.called("prototypes.decide")).toEqual([]);
  const shown = view.render(80);
  expect(shown.some((line) => line.includes("›") && line.includes("字"))).toBe(true);
  expect(shown.some((line) => line.includes("超出 1 字，最多 4000 字"))).toBe(true);
  view.handleInput("\x7f");
  view.handleInput("\r");
  await vi.waitFor(() => expect(h.called("prototypes.decide")).toHaveLength(1));
  expect(h.called("prototypes.decide")[0]!.opinion).toBe("字".repeat(4000));
});

test("没有界面时 remove 返回的文字写明用户没看到窗口，不写用户选择保留", async () => {
  const h = await harness({ hasUI: false, responses: { "prototypes.removal": () => removal, "prototypes.remove": () => ({}) } });
  const text = await h.outcome({ action: "remove", repoId: REPO, requirementId: REQ, name: "旧外观弹窗" });
  expect(text).toContain("当前没有界面，用户没看到窗口");
  expect(text).not.toContain("用户选择保留");
  expect(h.called("prototypes.remove")).toEqual([]);
});

const plain = (view: Views[number]) => view.render(80).map(stripCursor);

test("有方案清单时选项依次是方案加字母和名称、其他，光标在方案 A，没有通过并补充说明", async () => {
  const h = await harness({ responses: { "prototypes.pending": () => withOptions(THREE_OPTIONS), "prototypes.decide": decideOk } });
  await h.emit("prototype.submitted", submitted("设置页", 2));
  const view = await h.nextView();
  expect(view.render(80)).toEqual(CONFIRM_FRAME(true, 2, THREE_OPTIONS));
  expect(plain(view).join("\n")).not.toContain("通过并补充说明");
});

test("没有方案清单时选项依次是通过和其他，没有通过并补充说明", async () => {
  const h = await harness({ responses: { "prototypes.pending": () => pendingV2, "prototypes.decide": decideOk } });
  await h.emit("prototype.submitted", submitted("设置页", 2));
  const view = await h.nextView();
  const text = view.render(80).join("\n");
  expect(text).toContain(" → 通过（写进需求草稿）");
  expect(text).toContain("   其他（自己输入）");
  expect(text).not.toContain("通过并补充说明");
  expect(text).not.toContain("方案 A");
});

test("有方案清单时光标在方案行和其他行的底部提示不同", async () => {
  const h = await harness({ responses: { "prototypes.pending": () => withOptions(THREE_OPTIONS), "prototypes.decide": decideOk } });
  await h.emit("prototype.submitted", submitted("设置页", 2));
  const view = await h.nextView();
  expect(view.render(80)).toContain(" {↑↓ 选择 · 回车确认 · Esc 放弃这一版}");
  for (let i = 0; i < 3; i++) view.handleInput("\x1b[B");
  const lines = view.render(80);
  expect(lines).toContain(" → 其他（自己输入）");
  expect(lines).toContain(" {直接输入 · 回车确认 · Shift+Enter 换行 · ↑↓ 选择 · Esc 放弃这一版}");
});

test("6 个方案、名称各 20 个汉字时，80 列下每行可见宽度不超过 80，每个方案只占一行", async () => {
  const names = ["甲", "乙", "丙", "丁", "戊", "己"].map((c) => c.repeat(20));
  const h = await harness({ responses: { "prototypes.pending": () => withOptions(names), "prototypes.decide": decideOk } });
  await h.emit("prototype.submitted", submitted("设置页", 2));
  const lines = plain(await h.nextView());
  for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(80);
  names.forEach((name, index) => {
    const own = lines.filter((line) => line.includes(name));
    expect(own).toHaveLength(1);
    expect(own[0]).toContain(`方案 ${"ABCDEF"[index]}：${name}`);
  });
});

test("选方案 B 回车：decide 收到 accept 和 B，绿字写明选了方案，主代理收到不显示、下一轮送达、不触发回复的消息", async () => {
  const h = await harness({ responses: { "prototypes.pending": () => withOptions(THREE_OPTIONS), "prototypes.decide": decideOk } });
  await h.emit("prototype.submitted", submitted("设置页", 2));
  const view = await h.nextView();
  view.handleInput("\x1b[B");
  view.handleInput("\r");
  await vi.waitFor(() => expect(h.called("prototypes.decide")).toEqual([{ requirementId: REQ, line: LINE, anchor: ANCHOR, name: "设置页", version: 2, hash: HASH_V2, choice: "accept", opinion: null, option: "B" }]));
  await vi.waitFor(() => expect(h.appendEntry).toHaveBeenCalledWith(expect.any(String), { text: "已登记：原型「设置页」第 2 版通过，已写进需求草稿。你选了方案 B：左侧导航。" }));
  expect(h.sendMessage).toHaveBeenCalledTimes(1);
  const [message, options] = h.sendMessage.mock.calls[0]!;
  expect(message).toMatchObject({ display: false, content: CHOSEN_MESSAGE });
  expect(options).toEqual({ deliverAs: "nextTurn" });
});

test("有方案清单时直接回车选方案 A", async () => {
  const h = await harness({ responses: { "prototypes.pending": () => withOptions(THREE_OPTIONS), "prototypes.decide": decideOk } });
  await h.emit("prototype.submitted", submitted("设置页", 2));
  (await h.nextView()).handleInput("\r");
  await vi.waitFor(() => expect(h.called("prototypes.decide")).toHaveLength(1));
  expect(h.called("prototypes.decide")[0]).toMatchObject({ choice: "accept", option: "A", opinion: null });
  await vi.waitFor(() => expect(h.appendEntry).toHaveBeenCalledWith(expect.any(String), { text: "已登记：原型「设置页」第 2 版通过，已写进需求草稿。你选了方案 A：顶部分栏。" }));
});

test("没有方案清单时选通过：option 为 null，绿字没有你选了方案，不发消息", async () => {
  const h = await harness({ responses: { "prototypes.pending": () => pendingV2, "prototypes.decide": decideOk } });
  await h.emit("prototype.submitted", submitted("设置页", 2));
  (await h.nextView()).handleInput("\r");
  await vi.waitFor(() => expect(h.called("prototypes.decide")).toEqual([{ requirementId: REQ, line: LINE, anchor: ANCHOR, name: "设置页", version: 2, hash: HASH_V2, choice: "accept", opinion: null, option: null }]));
  await vi.waitFor(() => expect(h.appendEntry).toHaveBeenCalledWith(expect.any(String), { text: "已登记：原型「设置页」第 2 版通过，已写进需求草稿。" }));
  expect(h.appendEntry.mock.calls.map((call) => JSON.stringify(call[1])).join("")).not.toContain("你选了方案");
  expect(h.sendMessage).not.toHaveBeenCalled();
});

test("有方案清单时在其他一行写意见：option 为 null，消息逐行一致，触发主代理回复", async () => {
  const h = await harness({ responses: { "prototypes.pending": () => withOptions(THREE_OPTIONS), "prototypes.decide": decideOk } });
  await h.emit("prototype.submitted", submitted("设置页", 2));
  const view = await h.nextView();
  for (let i = 0; i < 3; i++) view.handleInput("\x1b[B");
  for (const char of "  侧栏窄一点 ") view.handleInput(char);
  view.handleInput("\r");
  await vi.waitFor(() => expect(h.called("prototypes.decide")).toEqual([{ requirementId: REQ, line: LINE, anchor: ANCHOR, name: "设置页", version: 2, hash: HASH_V2, choice: "opinion", opinion: "侧栏窄一点", option: null }]));
  await vi.waitFor(() => expect(h.sendMessage).toHaveBeenCalledTimes(1));
  const [message, options] = h.sendMessage.mock.calls[0]!;
  expect(message.content).toBe(OPINION_MESSAGE("侧栏窄一点"));
  expect(options).toEqual({ triggerTurn: true });
});

test("有方案清单时按 Esc：decide 收到 abandon 和 option null", async () => {
  const h = await harness({ responses: { "prototypes.pending": () => withOptions(THREE_OPTIONS), "prototypes.decide": decideOk } });
  await h.emit("prototype.submitted", submitted("设置页", 2));
  (await h.nextView()).handleInput("\x1b");
  await vi.waitFor(() => expect(h.called("prototypes.decide")).toEqual([{ requirementId: REQ, line: LINE, anchor: ANCHOR, name: "设置页", version: 2, hash: HASH_V2, choice: "abandon", opinion: null, option: null }]));
  expect(h.sendMessage).not.toHaveBeenCalled();
});

test("confirm 重开的窗口和自动弹出的窗口选项一样，选方案 B 同样登记", async () => {
  const h = await harness({ responses: { "prototypes.pending": () => withOptions(THREE_OPTIONS), "prototypes.decide": decideOk } });
  const done = h.run({ action: "confirm", repoId: REPO, requirementId: REQ, name: "设置页" });
  const view = await h.nextView();
  expect(view.render(80)).toEqual(CONFIRM_FRAME(true, 2, THREE_OPTIONS));
  view.handleInput("\x1b[B");
  view.handleInput("\r");
  await done;
  await vi.waitFor(() => expect(h.called("prototypes.decide")).toEqual([{ requirementId: REQ, line: LINE, anchor: ANCHOR, name: "设置页", version: 2, hash: HASH_V2, choice: "accept", opinion: null, option: "B" }]));
  await vi.waitFor(() => expect(h.sendMessage).toHaveBeenCalledTimes(1));
  expect(h.sendMessage.mock.calls[0]![0].content).toBe(CHOSEN_MESSAGE);
});

test("原型设计师职责规矩要求画了多个方案时交稿附方案清单", () => {
  const rules = readFileSync(new URL("../role-rules/prototype.md", import.meta.url), "utf8");
  expect(rules).toContain("- 一份原型里画了多个方案时，交稿必须附方案清单（options），最少 2 个、最多 6 个，每个名称最多 20 字。页面按 data-option 的字母显示对应方案，字母和清单顺序一致。只画了一种方案时不附清单。");
});

const NOTE_LINE = "设计师的说明（模型写的，仅供参考）：「新增外观一栏」";
const withDesign = (design: DesignState, options: string[] = []): PendingPrototype => ({ ...pendingV2, options, design });
const designLines = (pending: PendingPrototype) => {
  const lines = confirmWindowContent(pending, true).lines;
  return lines.slice(lines.findIndex((line) => line.text === NOTE_LINE) + 1);
};
const DESIGN_DISABLED = "设计师交稿后 DESIGN.md 被改过，这一版不能通过";

test("chapterCountText 超过 10 也写成中文数字", () => {
  expect([11, 12, 20, 21, 35].map(chapterCountText)).toEqual(["十一", "十二", "二十", "二十一", "三十五"]);
});

test("chapterCountText 把 1 到 10 写成中文数字，2 写成两", () => {
  expect([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(chapterCountText)).toEqual(["一", "两", "三", "四", "五", "六", "七", "八", "九", "十"]);
});

test("design 是 created 时，在设计师的说明之后加一行普通颜色的新建提示", () => {
  expect(designLines(withDesign({ state: "created" }))).toEqual([{ text: "批准需求后随需求分支新建 DESIGN.md，之后这个需求的原型、实现和审查都照它做。" }]);
});

test("design 是 changed 且一份时，写改了哪几章，章名用顿号连接并带章数", () => {
  expect(designLines(withDesign({ state: "changed", changes: [{ letter: null, chapters: ["颜色", "组件"] }] })))
    .toEqual([{ text: "批准需求后随需求分支更新 DESIGN.md：改了颜色、组件两章。" }]);
});

test("design 是 changed 且只改一章或只加了图表章、只改开头时，章数写一", () => {
  expect(designLines(withDesign({ state: "changed", changes: [{ letter: null, chapters: ["图表"] }] }))[0]!.text).toBe("批准需求后随需求分支更新 DESIGN.md：改了图表一章。");
  expect(designLines(withDesign({ state: "changed", changes: [{ letter: null, chapters: ["开头的说明"] }] }))[0]!.text).toBe("批准需求后随需求分支更新 DESIGN.md：改了开头的说明一章。");
});

test("design 是 changed 且每方案一份时，先一行总说明，下一行缩进两格逐个方案写改了几章或不变", () => {
  const lines = designLines(withDesign({ state: "changed", changes: [
    { letter: "A", chapters: ["颜色", "组件"] }, { letter: "B", chapters: ["颜色"] }, { letter: "C", chapters: [] },
  ] }, THREE_OPTIONS));
  expect(lines).toEqual([
    { text: "批准需求后随需求分支更新 DESIGN.md：" },
    { text: "  方案 A 改了颜色、组件两章；方案 B 改了颜色一章；方案 C 不变。" },
  ]);
});

test("design 是 same 时不加行，行数和 design 之外的内容与加之前相同", () => {
  expect(designLines(withDesign({ state: "same" }))).toEqual([]);
});

test("design 是 conflict 时加一行被改过的提示，通过选项带 disabled 原因", () => {
  const content = confirmWindowContent(withDesign({ state: "conflict" }), true);
  expect(designLines(withDesign({ state: "conflict" }))).toEqual([{ text: "设计师交稿后 DESIGN.md 被改过，这一版不能通过。想继续，请在「其他（自己输入）」里写意见，主代理会按最新的 DESIGN.md 重派一版，新的一版还要再确认一次。" }]);
  expect(content.choices).toEqual([{ label: "通过（写进需求草稿）", disabled: DESIGN_DISABLED }]);
  expect(content.escapeChoice).toBe("放弃这一版");
});

test("design 是 conflict 且有方案清单时，每个方案选项都带 disabled 原因", () => {
  const content = confirmWindowContent(withDesign({ state: "conflict" }, THREE_OPTIONS), true);
  expect(content.choices).toEqual(THREE_OPTIONS.map((name, index) => ({ label: `方案 ${"ABC"[index]}：${name}`, disabled: DESIGN_DISABLED })));
});

test("design 不是 conflict 时选项不带 disabled", () => {
  for (const state of ["created", "same"] as const) {
    expect(confirmWindowContent(withDesign({ state }, THREE_OPTIONS), true).choices.some((choice) => "disabled" in choice)).toBe(false);
  }
});

test("窗口里 design 的提示行不是灰色，紧跟在设计师的说明那行之后", async () => {
  const h = await harness({ responses: { "prototypes.pending": () => withDesign({ state: "created" }), "prototypes.decide": decideOk } });
  await h.emit("prototype.submitted", submitted("设置页", 2));
  const lines = (await h.nextView()).render(80);
  const noteAt = lines.findIndex((line) => line.includes("设计师的说明"));
  expect(lines[noteAt + 1]).toBe(" 批准需求后随需求分支新建 DESIGN.md，之后这个需求的原型、实现和审查都照它做。");
});

test("design 是 same 时窗口和改动前逐行一致", async () => {
  const h = await harness({ responses: { "prototypes.pending": () => pendingV2, "prototypes.decide": decideOk } });
  await h.emit("prototype.submitted", submitted("设置页", 2));
  expect((await h.nextView()).render(80)).toEqual(CONFIRM_FRAME(true, 2));
});

test("design 是 conflict 时窗口里通过选项不能选：回车不调用 decide，光标落在其他", async () => {
  const h = await harness({ responses: { "prototypes.pending": () => withDesign({ state: "conflict" }), "prototypes.decide": decideOk } });
  await h.emit("prototype.submitted", submitted("设置页", 2));
  const view = await h.nextView();
  const text = view.render(80).join("\n");
  expect(text).toContain(DESIGN_DISABLED);
  view.handleInput("\r");
  expect(h.called("prototypes.decide")).toEqual([]);
});

test("design 是 conflict 时窗口打开光标就在其他：直接输入意见回车，按意见登记", async () => {
  const h = await harness({ responses: { "prototypes.pending": () => withDesign({ state: "conflict" }), "prototypes.decide": decideOk } });
  await h.emit("prototype.submitted", submitted("设置页", 2));
  const view = await h.nextView();
  view.handleInput("按最新规范重画");
  view.handleInput("\r");
  await vi.waitFor(() => expect(h.called("prototypes.decide")).toHaveLength(1));
  expect(h.called("prototypes.decide")[0]).toMatchObject({ choice: "opinion", opinion: "按最新规范重画" });
});

const designChanged = () => Object.assign(new Error("design_changed：DESIGN.md 在你确认时被改过，这一版没有通过"),
  { code: "design_changed", data: { advice: { why: "DESIGN.md 在你确认时被改过，这一版没有通过", next: "在窗口里选「其他（自己输入）」写意见，主代理会按最新的 DESIGN.md 重派一版，新的一版还要再确认一次" } } });

test("通过时守护进程返回 design_changed：提示用户这一版没有通过，并发对话消息让主代理知道", async () => {
  const h = await harness({ responses: { "prototypes.pending": () => pendingV2, "prototypes.decide": () => { throw designChanged(); } } });
  await h.emit("prototype.submitted", submitted("设置页", 2));
  (await h.nextView()).handleInput("\r");
  const notify = h.ctx.ui.notify as ReturnType<typeof vi.fn>;
  await vi.waitFor(() => expect(notify).toHaveBeenCalled());
  expect(notify).toHaveBeenCalledWith("DESIGN.md 在你确认时被改过，这一版没有通过", "warning");
  await vi.waitFor(() => expect(h.sendMessage).toHaveBeenCalledTimes(1));
  const [message, options] = h.sendMessage.mock.calls[0]!;
  expect(message.customType).toBe("one-company.prototype-design-changed");
  expect(message.content).toBe("原型「设置页」第 2 版没有通过：DESIGN.md 在你确认时被改过。在窗口里选「其他（自己输入）」写意见，主代理会按最新的 DESIGN.md 重派一版，新的一版还要再确认一次；可以用 one_company_prototype confirm 重开确认窗口。");
  expect(options).toEqual({ triggerTurn: true });
  expect(h.appendEntry).not.toHaveBeenCalled();
});

test("选方案时守护进程返回 design_changed：同样提示并发对话消息，不记绿字", async () => {
  const h = await harness({ responses: { "prototypes.pending": () => withDesign({ state: "changed", changes: [{ letter: "A", chapters: ["颜色"] }, { letter: "B", chapters: [] }, { letter: "C", chapters: [] }] }, THREE_OPTIONS), "prototypes.decide": () => { throw designChanged(); } } });
  await h.emit("prototype.submitted", submitted("设置页", 2));
  (await h.nextView()).handleInput("\r");
  await vi.waitFor(() => expect(h.sendMessage).toHaveBeenCalledTimes(1));
  expect(h.sendMessage.mock.calls[0]![0].customType).toBe("one-company.prototype-design-changed");
  expect(h.appendEntry).not.toHaveBeenCalled();
});

const anchorCalls = (h: Awaited<ReturnType<typeof harness>>) => h.appendEntry.mock.calls.filter(([type]) => type === ANCHOR_ENTRY).map(([, data]) => data);

test("dispatch 成功后把请求里的 anchor 记进对话线", async () => {
  const h = await harness({ responses: { "prototypes.dispatch": () => ({ runId: "run-1", version: 1 }) } });
  await h.outcome({ action: "dispatch", repoId: REPO, requirementId: REQ, name: "设置页", brief: "出原型", maxTurns: 20 });
  const [params] = h.called("prototypes.dispatch");
  expect(anchorCalls(h)).toEqual([{ repoId: REPO, requirementId: REQ, anchor: params!.anchor }]);
});

test("选通过后把 decide 请求里的 anchor 记进对话线", async () => {
  const h = await harness({ responses: { "prototypes.pending": () => pendingV2, "prototypes.decide": decideOk } });
  await h.emit("prototype.submitted", submitted("设置页", 2));
  (await h.nextView()).handleInput("\r");
  await vi.waitFor(() => expect(h.called("prototypes.decide")).toHaveLength(1));
  await vi.waitFor(() => expect(anchorCalls(h)).toEqual([{ repoId: REPO, requirementId: REQ, anchor: h.called("prototypes.decide")[0]!.anchor }]));
});

test("写意见和放弃也各把 decide 请求里的 anchor 记进对话线", async () => {
  const opinion = await harness({ responses: { "prototypes.pending": () => pendingV2, "prototypes.decide": decideOk } });
  await opinion.emit("prototype.submitted", submitted("设置页", 2));
  const view = await opinion.nextView();
  view.handleInput("\x1b[B");
  view.handleInput("\x1b[B");
  for (const char of "再亮一点") view.handleInput(char);
  view.handleInput("\r");
  await vi.waitFor(() => expect(anchorCalls(opinion)).toEqual([{ repoId: REPO, requirementId: REQ, anchor: opinion.called("prototypes.decide")[0]!.anchor }]));

  const abandon = await harness({ responses: { "prototypes.pending": () => pendingV2, "prototypes.decide": decideOk } });
  await abandon.emit("prototype.submitted", submitted("设置页", 2));
  (await abandon.nextView()).handleInput("\x1b");
  await vi.waitFor(() => expect(anchorCalls(abandon)).toEqual([{ repoId: REPO, requirementId: REQ, anchor: abandon.called("prototypes.decide")[0]!.anchor }]));
});

test("选移除后把 remove 请求里的 anchor 记进对话线", async () => {
  const h = await harness({ responses: { "prototypes.removal": () => removal, "prototypes.remove": () => ({}) } });
  const done = h.run({ action: "remove", repoId: REPO, requirementId: REQ, name: "旧外观弹窗" });
  (await h.nextView()).handleInput("\r");
  await done;
  expect(anchorCalls(h)).toEqual([{ repoId: REPO, requirementId: REQ, anchor: h.called("prototypes.remove")[0]!.anchor }]);
});

test("请求里的 line 只含这个需求的锚点，别的需求的锚点不混进去", async () => {
  const other = "01900000-0000-7000-8000-000000000002";
  const branch = [anchorEntry(BASE_ANCHOR), anchorEntry("01900000-0000-7000-8000-0000000000b1", other), anchorEntry(DISPATCH_ANCHOR)];
  const h = await harness({ branch, responses: { "prototypes.board": () => ({}) } });
  await h.outcome({ action: "status", repoId: REPO, requirementId: REQ });
  expect(h.called("prototypes.board")).toEqual([{ requirementId: REQ, line: LINE }]);
});

test("对话线上还没有这个需求的锚点时，请求里的 line 是空数组", async () => {
  const h = await harness({ branch: [], responses: { "prototypes.board": () => ({}) } });
  await h.outcome({ action: "status", repoId: REPO, requirementId: REQ });
  expect(h.called("prototypes.board")).toEqual([{ requirementId: REQ, line: [] }]);
});

test("交稿事件的 dispatchAnchor 不在当前对话线上：不查待确认、不开浏览器、不弹窗", async () => {
  const offLine = "01900000-0000-7000-8000-0000000000c1";
  const h = await harness({ responses: { "prototypes.pending": () => pendingV2, "prototypes.decide": decideOk } });
  await h.emit("prototype.submitted", submitted("设置页", 2, offLine));
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(h.called("prototypes.pending")).toEqual([]);
  expect(h.openFile).not.toHaveBeenCalled();
  expect(h.custom).not.toHaveBeenCalled();
});

const SAVE_ANCHOR = "01900000-0000-7000-8000-0000000000a3";
const withSavedWhileOpen = (h: () => Awaited<ReturnType<typeof harness>>, response: () => unknown) => () => {
  h().switchBranch([...LINE, SAVE_ANCHOR].map((anchor) => anchorEntry(anchor)));
  return response();
};

test("确认窗口开着时主代理又保存了草稿：用户点通过，decide 的 line 含这次保存的锚点", async () => {
  let h!: Awaited<ReturnType<typeof harness>>;
  h = await harness({ responses: { "prototypes.pending": withSavedWhileOpen(() => h, () => pendingV2), "prototypes.decide": decideOk } });
  await h.emit("prototype.submitted", submitted("设置页", 2));
  (await h.nextView()).handleInput("\r");
  await vi.waitFor(() => expect(h.called("prototypes.decide")).toHaveLength(1));
  expect(h.called("prototypes.decide")[0]!.line).toEqual([...LINE, SAVE_ANCHOR]);
});

test("确认窗口开着时主代理又保存了草稿：用户点移除，remove 的 line 含这次保存的锚点", async () => {
  let h!: Awaited<ReturnType<typeof harness>>;
  h = await harness({ responses: { "prototypes.removal": withSavedWhileOpen(() => h, () => removal), "prototypes.remove": () => ({}) } });
  const done = h.run({ action: "remove", repoId: REPO, requirementId: REQ, name: "旧外观弹窗" });
  (await h.nextView()).handleInput("\r");
  await done;
  expect(h.called("prototypes.remove")[0]!.line).toEqual([...LINE, SAVE_ANCHOR]);
});

const OTHER_ANCHOR = "01900000-0000-7000-8000-0000000000b1";
const OTHER_LINE = [BASE_ANCHOR, OTHER_ANCHOR];
const boardWith = (status: "awaiting" | "designing" | null) => () => ({ entries: [{ name: "设置页", inFlight: status ? { status, version: 2 } : null, draft: null }] });
const switchEvents: Array<[string, Record<string, unknown>]> = [["session_tree", {}], ["session_start", { reason: "startup" }], ["session_start", { reason: "resume" }], ["session_start", { reason: "fork" }]];

test.each(switchEvents)("换线（%s %j）后，新线上有交了稿等确认的原型：按新线查看板，先打开浏览器再弹确认原型窗口", async (event, payload) => {
  const h = await harness({ responses: { "prototypes.board": boardWith("awaiting"), "prototypes.pending": () => pendingV2, "prototypes.decide": decideOk } });
  h.switchBranch(OTHER_LINE.map((anchor) => anchorEntry(anchor)));
  await h.fake.trigger(event, payload, h.ctx);
  const view = await h.nextView();
  expect(h.called("prototypes.board")).toContainEqual({ requirementId: REQ, line: OTHER_LINE });
  expect(h.called("prototypes.pending")).toEqual([{ requirementId: REQ, line: OTHER_LINE, name: "设置页" }]);
  expect(h.order).toEqual(["open", "window"]);
  expect(view.render(80)).toEqual(CONFIRM_FRAME(true, 2));
});

test("换线后新线上没有等确认的原型：不弹窗", async () => {
  const h = await harness({ responses: { "prototypes.board": boardWith(null), "prototypes.pending": () => pendingV2 } });
  h.switchBranch(OTHER_LINE.map((anchor) => anchorEntry(anchor)));
  await h.fake.trigger("session_tree", {}, h.ctx);
  await vi.waitFor(() => expect(h.called("prototypes.board").length).toBeGreaterThan(0));
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(h.custom).not.toHaveBeenCalled();
  expect(h.called("prototypes.pending")).toEqual([]);
});

test("换线后新线上的原型设计师还在做（没交稿）：不弹窗", async () => {
  const h = await harness({ responses: { "prototypes.board": boardWith("designing"), "prototypes.pending": () => pendingV2 } });
  h.switchBranch(OTHER_LINE.map((anchor) => anchorEntry(anchor)));
  await h.fake.trigger("session_tree", {}, h.ctx);
  await vi.waitFor(() => expect(h.called("prototypes.board").length).toBeGreaterThan(0));
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(h.custom).not.toHaveBeenCalled();
});

test("session_start 原因为 reload：不查看板，不弹窗", async () => {
  const h = await harness({ responses: { "prototypes.board": boardWith("awaiting"), "prototypes.pending": () => pendingV2 } });
  h.switchBranch(OTHER_LINE.map((anchor) => anchorEntry(anchor)));
  await h.fake.trigger("session_start", { reason: "reload" }, h.ctx);
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(h.called("prototypes.board")).toEqual([]);
  expect(h.custom).not.toHaveBeenCalled();
});

test("换线后线上没有任何需求锚点：不查看板，不弹窗", async () => {
  const h = await harness({ responses: { "prototypes.board": boardWith("awaiting"), "prototypes.pending": () => pendingV2 } });
  h.switchBranch([]);
  await h.fake.trigger("session_tree", {}, h.ctx);
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(h.called("prototypes.board")).toEqual([]);
  expect(h.custom).not.toHaveBeenCalled();
});

test("没有界面时换线：不查看板、不弹窗、不报错", async () => {
  const h = await harness({ hasUI: false, responses: { "prototypes.board": boardWith("awaiting"), "prototypes.pending": () => pendingV2 } });
  h.switchBranch(OTHER_LINE.map((anchor) => anchorEntry(anchor)));
  await expect(h.fake.trigger("session_tree", {}, h.ctx)).resolves.toBeDefined();
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(h.called("prototypes.board")).toEqual([]);
  expect(h.custom).not.toHaveBeenCalled();
  expect((h.ctx.ui.notify as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
});

test("同一条线上有两份等确认的原型：换线后依次弹出两次，第一个关掉后才弹第二个", async () => {
  const board = () => ({ entries: [{ name: "设置页", inFlight: { status: "awaiting", version: 2 }, draft: null }, { name: "引导页", inFlight: { status: "awaiting", version: 1 }, draft: null }] });
  const h = await harness({ responses: { "prototypes.board": board, "prototypes.pending": (params) => pendingFor(params.name as string), "prototypes.decide": decideOk } });
  h.switchBranch(OTHER_LINE.map((anchor) => anchorEntry(anchor)));
  await h.fake.trigger("session_tree", {}, h.ctx);
  const first = await h.nextView();
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(h.views).toHaveLength(1);
  expect(first.render(80)).toContain(" 原型：设置页（第 2 版）");
  first.handleInput("\x1b");
  const second = await h.nextView(1);
  expect(second.render(80)).toContain(" 原型：引导页（第 1 版）");
  expect(h.custom).toHaveBeenCalledTimes(2);
});

test.each(switchEvents)("窗口启动失败时换线（%s %j）：不弹警告也不弹窗", async (event, payload) => {
  const h = await harness({ windowReady: () => Promise.reject(new Error("窗口未启动")), responses: { "prototypes.board": boardWith("awaiting"), "prototypes.pending": () => pendingV2 } });
  h.switchBranch(OTHER_LINE.map((anchor) => anchorEntry(anchor)));
  await h.fake.trigger(event, payload, h.ctx);
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(h.ctx.ui.notify).not.toHaveBeenCalled();
  expect(h.custom).not.toHaveBeenCalled();
});
