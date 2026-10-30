import { describe, expect, test, vi } from "vitest";
import { getSelectListTheme, initTheme } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import inputSuggestionExtension from "../src/modules/input-suggestion/input-suggestion-extension.ts";
import { SuggestionEditor } from "../src/modules/input-suggestion/suggestion-editor.ts";
import { createFakePi } from "./helpers/fake-pi.ts";

const SUGGESTION = "可以，按这个预览写 PRD";
const SHOWN = "按这个预览写 PRD";
const BACKSPACE = "\u007f";
const strip = (text: string) => text.replace(/\x1b\[[0-9;]*m/gu, "").replace(/\x1b_[^\x07]*\x07/gu, "");

const MODEL = { id: "m", name: "m", api: "openai-responses", provider: "p", baseUrl: "http://localhost", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 4096 };

function assistant(text: string, stopReason: string) {
  return { role: "assistant", content: [{ type: "text", text }], stopReason, api: "openai-responses", provider: "p", model: "m", usage: {}, timestamp: 0 };
}

function branch(lastStopReason = "stop") {
  const messages = [
    { role: "user", content: [{ type: "text", text: "写个 PRD" }] },
    assistant("先看预览", "stop"),
    { role: "user", content: [{ type: "text", text: "预览发你了" }] },
    assistant("预览已确认", lastStopReason),
  ];
  return messages.map((message, index) => ({ type: "message", id: `e${index}`, parentId: index === 0 ? null : `e${index - 1}`, timestamp: "2026-10-30T00:00:00Z", message }));
}

function deferred() {
  let resolve!: (value: unknown) => void;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve: () => resolve(assistant(SUGGESTION, "stop")) };
}

function setup(options: { mode?: string; hasUI?: boolean; lastStopReason?: string } = {}) {
  initTheme("dark");
  const fake = createFakePi();
  const sendMessage = vi.fn();
  const appendEntry = vi.fn();
  const pi = Object.assign(fake.pi, { sendMessage, appendEntry });
  inputSuggestionExtension(pi as never);
  const pending = deferred();
  const streamSimple = vi.fn(() => ({ result: () => pending.promise }));
  const setEditorComponent = vi.fn();
  const entries = branch(options.lastStopReason);
  const ctx = {
    mode: options.mode ?? "tui",
    hasUI: options.hasUI ?? true,
    ui: { setEditorComponent, theme: { fg: (_color: string, text: string) => text } },
    sessionManager: { getBranch: () => entries },
    model: MODEL,
    modelRegistry: { hasConfiguredAuth: () => true, streamSimple },
  };
  const start = () => fake.trigger("session_start", { type: "session_start", reason: "startup" }, ctx);
  const settle = (aborted = false) => fake.trigger("agent_settled", { type: "agent_settled", aborted }, ctx);
  const makeEditor = () => {
    const factory = setEditorComponent.mock.calls.at(-1)![0] as (...args: unknown[]) => SuggestionEditor;
    const tui = { terminal: { rows: 40, columns: 80 }, requestRender: vi.fn() };
    const theme = { borderColor: (s: string) => s, selectList: getSelectListTheme() };
    return factory(tui, theme, new KeybindingsManager(TUI_KEYBINDINGS));
  };
  const text = (editor: SuggestionEditor) => strip(editor.render(80).join("\n"));
  const flush = () => new Promise((r) => setTimeout(r, 0));
  const signalOfCall = (index = 0) => (streamSimple.mock.calls[index] as unknown as [unknown, unknown, { signal: AbortSignal }])[2].signal;
  return { fake, ctx, pending, streamSimple, setEditorComponent, sendMessage, appendEntry, start, settle, makeEditor, text, flush, signalOfCall };
}

async function startedWithEditor(options: Parameters<typeof setup>[0] = {}) {
  const s = setup(options);
  await s.start();
  return { ...s, editor: s.makeEditor() };
}

describe("输入建议扩展", () => {
  test("交互模式下 session_start 换上输入栏，工厂造出 SuggestionEditor", async () => {
    const { editor, setEditorComponent } = await startedWithEditor();
    expect(setEditorComponent).toHaveBeenCalledTimes(1);
    expect(editor).toBeInstanceOf(SuggestionEditor);
  });

  test.each(["print", "rpc", "json"])("%s 模式不替换输入栏，agent_settled 也不生成", async (mode) => {
    const s = setup({ mode, hasUI: false });
    await s.start();
    await s.settle();
    await s.flush();
    expect(s.setEditorComponent).not.toHaveBeenCalled();
    expect(s.streamSimple).not.toHaveBeenCalled();
  });

  test("正常 agent_settled 调用一次模型，返回后空输入栏显示建议", async () => {
    const s = await startedWithEditor();
    const settling = s.settle();
    await vi.waitFor(() => expect(s.streamSimple).toHaveBeenCalledTimes(1));
    s.pending.resolve();
    await settling;
    await vi.waitFor(() => expect(s.text(s.editor)).toContain(SHOWN));
    expect(s.streamSimple).toHaveBeenCalledTimes(1);
  });

  test("agent_settled 处理器不等模型返回就结束", async () => {
    const s = await startedWithEditor();
    const done = vi.fn();
    void s.settle().then(done);
    await vi.waitFor(() => expect(done).toHaveBeenCalled());
    expect(s.streamSimple).toHaveBeenCalledTimes(1);
  });

  test("agent_settled 的 aborted 为真时不调用模型", async () => {
    const s = await startedWithEditor();
    await s.settle(true);
    await s.flush();
    expect(s.streamSimple).not.toHaveBeenCalled();
  });

  test.each(["error", "aborted", "length"])("最后一条 assistant 消息 stopReason 为 %s 时不调用模型", async (lastStopReason) => {
    const s = await startedWithEditor({ lastStopReason });
    await s.settle();
    await s.flush();
    expect(s.streamSimple).not.toHaveBeenCalled();
  });

  test("上一次还没返回又来一次 agent_settled 时，旧调用被中止", async () => {
    const s = await startedWithEditor();
    await s.settle();
    await s.settle();
    await vi.waitFor(() => expect(s.streamSimple).toHaveBeenCalledTimes(2));
    expect(s.signalOfCall(0).aborted).toBe(true);
    expect(s.signalOfCall(1).aborted).toBe(false);
  });

  test("返回前触发 input：调用的 signal 被中止，之后返回的结果丢掉", async () => {
    const s = await startedWithEditor();
    const settling = s.settle();
    await vi.waitFor(() => expect(s.streamSimple).toHaveBeenCalledTimes(1));
    await s.fake.trigger("input", { type: "input", text: "好", source: "interactive" }, s.ctx);
    expect(s.signalOfCall().aborted).toBe(true);
    s.pending.resolve();
    await settling;
    await s.flush();
    expect(s.text(s.editor)).not.toContain(SHOWN);
  });

  test("返回前触发 agent_start：调用的 signal 被中止，之后返回的结果丢掉", async () => {
    const s = await startedWithEditor();
    const settling = s.settle();
    await vi.waitFor(() => expect(s.streamSimple).toHaveBeenCalledTimes(1));
    await s.fake.trigger("agent_start", { type: "agent_start" }, s.ctx);
    expect(s.signalOfCall().aborted).toBe(true);
    s.pending.resolve();
    await settling;
    await s.flush();
    expect(s.text(s.editor)).not.toContain(SHOWN);
  });

  test.each([
    ["input", { type: "input", text: "好", source: "interactive" }],
    ["agent_start", { type: "agent_start" }],
  ])("建议显示中触发 %s 后输入栏不再显示建议", async (event, payload) => {
    const s = await startedWithEditor();
    const settling = s.settle();
    await vi.waitFor(() => expect(s.streamSimple).toHaveBeenCalledTimes(1));
    s.pending.resolve();
    await settling;
    await vi.waitFor(() => expect(s.text(s.editor)).toContain(SHOWN));
    await s.fake.trigger(event, payload, s.ctx);
    expect(s.text(s.editor)).not.toContain(SHOWN);
  });

  test("返回前用户已在输入栏打字：文字保留、不显示建议，删空后显示", async () => {
    const s = await startedWithEditor();
    const settling = s.settle();
    await vi.waitFor(() => expect(s.streamSimple).toHaveBeenCalledTimes(1));
    for (const char of "等一下") s.editor.handleInput(char);
    s.pending.resolve();
    await settling;
    await s.flush();
    expect(s.editor.getText()).toBe("等一下");
    expect(s.text(s.editor)).not.toContain(SHOWN);
    for (let i = 0; i < 3; i += 1) s.editor.handleInput(BACKSPACE);
    expect(s.editor.getText()).toBe("");
    expect(s.text(s.editor)).toContain(SHOWN);
  });

  test("返回前再次 session_start：旧调用的 signal 被中止，旧结果不显示在新输入栏", async () => {
    const s = await startedWithEditor();
    const settling = s.settle();
    await vi.waitFor(() => expect(s.streamSimple).toHaveBeenCalledTimes(1));
    await s.start();
    expect(s.signalOfCall().aborted).toBe(true);
    const newEditor = s.makeEditor();
    s.pending.resolve();
    await settling;
    await s.flush();
    expect(s.text(newEditor)).not.toContain(SHOWN);
  });

  test("返回前 session_shutdown：旧调用的 signal 被中止", async () => {
    const s = await startedWithEditor();
    const settling = s.settle();
    await vi.waitFor(() => expect(s.streamSimple).toHaveBeenCalledTimes(1));
    await s.fake.trigger("session_shutdown", { type: "session_shutdown", reason: "quit" }, s.ctx);
    expect(s.signalOfCall().aborted).toBe(true);
    s.pending.resolve();
    await settling;
    await s.flush();
    expect(s.text(s.editor)).not.toContain(SHOWN);
  });

  test("整个过程不调用 sendMessage、appendEntry，input 处理器返回 continue", async () => {
    const s = await startedWithEditor();
    const settling = s.settle();
    await vi.waitFor(() => expect(s.streamSimple).toHaveBeenCalledTimes(1));
    s.pending.resolve();
    await settling;
    await vi.waitFor(() => expect(s.text(s.editor)).toContain(SHOWN));
    const results = await s.fake.trigger("input", { type: "input", text: "好", source: "interactive" }, s.ctx);
    await s.fake.trigger("agent_start", { type: "agent_start" }, s.ctx);
    expect(results).toEqual([{ action: "continue" }]);
    expect(s.sendMessage).not.toHaveBeenCalled();
    expect(s.appendEntry).not.toHaveBeenCalled();
  });
});
