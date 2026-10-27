import { readFileSync } from "node:fs";
import { afterEach, expect, test, vi } from "vitest";
import prototypeExtension from "../src/modules/prototype/prototype-extension.ts";
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

const pendingV2 = { requirementTitle: "设置页支持深色模式", draftVersion: 2, name: "设置页", version: 2, path: PATH, bytes: 18_841, hash: HASH_V2,
  note: "新增外观一栏", previousOpinion: "开关放到标题右边" };
const pendingV1 = { requirementTitle: "设置页支持深色模式", draftVersion: 2, name: "设置页", version: 1, path: PATH_V1, bytes: 16_384, hash: HASH_V1,
  note: "新增外观一栏", previousOpinion: null };

type Handler = (data: unknown) => unknown;
type Views = Array<{ render(width: number): string[]; handleInput(data: string): void }>;

interface Options {
  hasUI?: boolean;
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
  prototypeExtension(pi as never, { windowReady: () => Promise.resolve(window) as never, openFile } as never);

  const views: Views = [];
  const custom = vi.fn((factory: (tui: unknown, theme: unknown, keys: unknown, done: (value: unknown) => void) => Views[number]) =>
    new Promise((resolve) => {
      order.push("window");
      views.push(factory({ requestRender: () => {}, terminal: { rows: 40, columns: 80 } }, { fg: (kind: string, text: string) => (kind === "muted" ? `{${text}}` : text), bold: (text: string) => text }, {}, resolve));
    }));
  const ctx = { mode: "tui", hasUI: options.hasUI ?? true, model: { provider: "prov", id: "mod" }, sessionManager: { getSessionId: () => SESSION },
    ui: { custom, notify: vi.fn(), setWidget: () => {} } };
  await fake.trigger("session_start", { reason: "new" }, ctx);

  const emit = async (event: string, data: Record<string, unknown>) => {
    await vi.waitFor(() => expect(listeners.has(event)).toBe(true));
    for (const handler of listeners.get(event)!) void handler(data);
  };
  const tool = () => (fake.registeredTools() as unknown as Array<{ name: string; parameters: unknown;
    execute(id: string, params: unknown, signal: AbortSignal | undefined, onUpdate: undefined, ctx: unknown): Promise<{ content: Array<{ text: string }> }> }>)
    .find((candidate) => candidate.name === "one_company_prototype")!;
  const run = (request: Record<string, unknown>, signal?: AbortSignal) => tool().execute("t1", { request }, signal as never, undefined, ctx);
  const outcome = async (request: Record<string, unknown>): Promise<string> => {
    try { return (await run(request)).content.map((part) => part.text).join("\n"); }
    catch (error) { return error instanceof Error ? error.message : String(error); }
  };
  const called = (method: string) => calls.filter((call) => call.method === method).map((call) => call.params);
  const nextView = async (index = 0) => { await vi.waitFor(() => expect(views.length).toBeGreaterThan(index), { timeout: 5_000 }); return views[index]!; };
  return { fake, calls, called, appendEntry, sendMessage, openFile, custom, views, order, emit, run, outcome, tool, nextView, ctx };
}

const submitted = (name: string, version: number) => ({ parentSessionId: SESSION, requirementId: REQ, name, version });
const decideOk = (params: Record<string, unknown>) => ({ version: params.version, choice: params.choice });

const CONFIRM_FRAME = (open: boolean, version: 1 | 2): string[] => [
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
  " → 通过（写进需求草稿）",
  "   通过并补充说明（自己输入）",
  "   其他（自己输入）",
  "",
  " {↑↓ 选择 · 回车确认 · Esc 放弃这一版}",
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
  expect(h.called("prototypes.pending")).toEqual([{ requirementId: REQ, name: "设置页" }]);
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
  await vi.waitFor(() => expect(h.called("prototypes.decide")).toEqual([{ requirementId: REQ, name: "设置页", version: 2, hash: HASH_V2, choice: "accept", opinion: null, note: null }]));
  await vi.waitFor(() => expect(h.appendEntry).toHaveBeenCalledWith(expect.any(String), { text: "已登记：原型「设置页」第 2 版通过，已写进需求草稿。" }));
  expect(h.sendMessage).not.toHaveBeenCalled();
});

test("按 Esc 放弃：decide 收到 abandon，记一条程序记录，不触发主代理", async () => {
  const h = await harness({ responses: { "prototypes.pending": () => pendingV2, "prototypes.decide": decideOk } });
  await h.emit("prototype.submitted", submitted("设置页", 2));
  (await h.nextView()).handleInput("\x1b");
  await vi.waitFor(() => expect(h.called("prototypes.decide")).toEqual([{ requirementId: REQ, name: "设置页", version: 2, hash: HASH_V2, choice: "abandon", opinion: null, note: null }]));
  await vi.waitFor(() => expect(h.appendEntry).toHaveBeenCalledWith(expect.any(String), { text: "已登记：放弃原型「设置页」第 2 版，它不再挡住批准。" }));
  expect(h.sendMessage).not.toHaveBeenCalled();
});

const stripCursor = (line: string) => line.replace(/\x1b_pi:(?:c|fc|\/fc)\x07/g, "");
const inputLine = (view: Views[number]) => view.render(80).map(stripCursor).find((line) => line.startsWith("      › "));
const OPINION_MESSAGE = (opinion: string) => ["用户对原型「设置页」第 2 版提了意见，这一版仍在等用户确认。", `文件：${PATH}`, "用户原话：", opinion,
  "如果是提问，先回答，再用 one_company_prototype confirm 重开这份原型的确认窗口；如果要修改，用 one_company_prototype dispatch 重派设计师，设计师会拿到这一版文件和这段原话，重派后这一版作废。"].join("\n");

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
  await vi.waitFor(() => expect(h.called("prototypes.decide")).toEqual([{ requirementId: REQ, name: "设置页", version: 2, hash: HASH_V2, choice: "opinion", opinion: "深色下按钮边框太亮", note: null }]));
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
  expect(h.called("prototypes.decide")[0]).toMatchObject({ choice: "opinion", opinion: "第一行\n第二行", note: null });
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
  await vi.waitFor(() => expect(h.called("prototypes.decide")).toEqual([{ requirementId: REQ, name: "设置页", version: 2, hash: HASH_V2, choice: "opinion", opinion: "再亮一点", note: null }]));
  await vi.waitFor(() => expect(h.sendMessage).toHaveBeenCalledTimes(1));
  expect(h.sendMessage.mock.calls[0]![0].content).toBe(OPINION_MESSAGE("再亮一点"));
  expect(h.sendMessage.mock.calls[0]![1]).toEqual({ triggerTurn: true });
});

test("通过并补充说明：说明为空不能确认；输入后 decide 收到 accept 和 note，绿字带原话，主代理收到不触发回复的静默消息", async () => {
  const h = await harness({ responses: { "prototypes.pending": () => pendingV2, "prototypes.decide": decideOk } });
  await h.emit("prototype.submitted", submitted("设置页", 2));
  const view = await h.nextView();
  view.handleInput("\x1b[B");
  expect(view.render(80)).toContain(" {直接输入 · 回车确认 · Shift+Enter 换行 · ↑↓ 选择 · Esc 放弃这一版}");
  view.handleInput("\r");
  expect(h.called("prototypes.decide")).toEqual([]);
  for (const char of "用 B 方案") view.handleInput(char);
  view.handleInput("\r");
  await vi.waitFor(() => expect(h.called("prototypes.decide")).toEqual([{ requirementId: REQ, name: "设置页", version: 2, hash: HASH_V2, choice: "accept", opinion: null, note: "用 B 方案" }]));
  await vi.waitFor(() => expect(h.appendEntry).toHaveBeenCalledWith(expect.any(String), { text: "已登记：原型「设置页」第 2 版通过，已写进需求草稿。你的说明：「用 B 方案」" }));
  expect(h.sendMessage).toHaveBeenCalledTimes(1);
  const [message, options] = h.sendMessage.mock.calls[0]!;
  expect(message).toEqual({ customType: "one-company.prototype-note", display: false,
    content: "用户通过了原型「设置页」第 2 版，并补充说明：用 B 方案\n这句说明已和这一版原型一起存下，批准需求后会原话交给 PM 和子代理。需求正文和这句说明对不上时，按它改正文。" });
  expect(options).toEqual({ deliverAs: "nextTurn" });
});

test("补充说明超过 4000 字时窗口不能确认、不调用 decide；删到 4000 字后可以提交", async () => {
  const h = await harness({ responses: { "prototypes.pending": () => pendingV2, "prototypes.decide": decideOk } });
  await h.emit("prototype.submitted", submitted("设置页", 2));
  const view = await h.nextView();
  view.handleInput("\x1b[B");
  view.handleInput("字".repeat(4001));
  view.handleInput("\r");
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(h.called("prototypes.decide")).toEqual([]);
  view.handleInput("\x7f");
  view.handleInput("\r");
  await vi.waitFor(() => expect(h.called("prototypes.decide")).toHaveLength(1));
  expect(h.called("prototypes.decide")[0]!.note).toBe("字".repeat(4000));
});

test("confirm 动作的窗口按 Esc 同样登记放弃，工具结果写明放弃", async () => {
  const h = await harness({ responses: { "prototypes.pending": () => pendingV2, "prototypes.decide": decideOk } });
  const done = h.run({ action: "confirm", repoId: REPO, requirementId: REQ, name: "设置页" });
  (await h.nextView()).handleInput("\x1b");
  const result = await done;
  expect(h.called("prototypes.decide")).toEqual([{ requirementId: REQ, name: "设置页", version: 2, hash: HASH_V2, choice: "abandon", opinion: null, note: null }]);
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

test("别的会话派出的设计师交稿，本会话不弹窗", async () => {
  const h = await harness({ responses: { "prototypes.pending": () => pendingV2, "prototypes.decide": decideOk } });
  await h.emit("prototype.submitted", { ...submitted("设置页", 2), parentSessionId: "other-session" });
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(h.custom).not.toHaveBeenCalled();
  expect(h.openFile).not.toHaveBeenCalled();
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
  expect(h.called("prototypes.removal")).toEqual([{ requirementId: REQ, name: "旧外观弹窗" }]);
  expect(view.render(80)).toEqual(REMOVE_FRAME("第 2 版需求里批准过"));
  view.handleInput("\r");
  await done;
  expect(h.called("prototypes.remove")).toEqual([{ requirementId: REQ, name: "旧外观弹窗", version: 1 }]);
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

test("designers 动作调用 prototypes.designers 并原样返回", async () => {
  const designers = { items: [{ name: "prototype", description: "默认原型设计师" }, { name: "brand-designer", description: "按品牌规范出原型" }] };
  const h = await harness({ responses: { "prototypes.designers": () => designers } });
  const text = await h.outcome({ action: "designers", repoId: REPO });
  expect(JSON.parse(text)).toEqual(designers);
  expect(h.called("prototypes.designers")).toEqual([{}]);
});

test("dispatch 动作带上主窗口当前模型和思考等级调用 prototypes.dispatch", async () => {
  const h = await harness({ responses: { "prototypes.dispatch": () => ({ runId: "run-1", version: 1 }) } });
  const text = await h.outcome({ action: "dispatch", repoId: REPO, requirementId: REQ, name: "设置页", brief: "出设置页深色模式的界面原型", maxTurns: 30, agent: "brand-designer" });
  expect(text).toContain("run-1");
  expect(h.called("prototypes.dispatch")).toEqual([{ requirementId: REQ, name: "设置页", brief: "出设置页深色模式的界面原型", maxTurns: 30, agent: "brand-designer",
    model: { provider: "prov", id: "mod" }, thinking: "high" }]);
});

test("dispatch 动作没点名设计师时不带 agent", async () => {
  const h = await harness({ responses: { "prototypes.dispatch": () => ({ runId: "run-2", version: 1 }) } });
  await h.outcome({ action: "dispatch", repoId: REPO, requirementId: REQ, name: "设置页", brief: "出原型", maxTurns: 20 });
  const [params] = h.called("prototypes.dispatch");
  expect(params).toEqual({ requirementId: REQ, name: "设置页", brief: "出原型", maxTurns: 20, model: { provider: "prov", id: "mod" }, thinking: "high" });
});

test("status 动作调用 prototypes.board 并原样返回", async () => {
  const board = { inFlight: [{ name: "设置页", version: 2 }], draft: [], approved: [] };
  const h = await harness({ responses: { "prototypes.board": () => board } });
  const text = await h.outcome({ action: "status", repoId: REPO, requirementId: REQ });
  expect(JSON.parse(text)).toEqual(board);
  expect(h.called("prototypes.board")).toEqual([{ requirementId: REQ }]);
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
  for (const forbidden of ["decide", "accept", "opinion", "abandon", "note"]) expect(schema).not.toContain(forbidden);
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

test("通过并补充说明但文件在交稿后被改过：不记带说明的绿字，主代理只收到作废通知，没有补充说明的消息", async () => {
  const h = await harness({ responses: { "prototypes.pending": () => pendingV2, "prototypes.decide": () => { throw fileChanged(); } } });
  await h.emit("prototype.submitted", submitted("设置页", 2));
  const view = await h.nextView();
  view.handleInput("\x1b[B");
  for (const char of "用 B 方案") view.handleInput(char);
  view.handleInput("\r");
  await vi.waitFor(() => expect(h.sendMessage).toHaveBeenCalledTimes(1));
  expect(h.appendEntry).not.toHaveBeenCalled();
  const [message, options] = h.sendMessage.mock.calls[0]!;
  expect(message.content).toContain("作废");
  expect(message.content).not.toContain("补充说明");
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
  expect(view.render(80).some((line) => line.includes("› 字"))).toBe(true);
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
