import { describe, expect, test, vi } from "vitest";
import { CustomEditor, getSelectListTheme, initTheme } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, KeybindingsManager, renderFakeCursor, TUI_KEYBINDINGS, visibleWidth } from "@earendil-works/pi-tui";
import { SuggestionEditor } from "../src/modules/input-suggestion/suggestion-editor.ts";

const RIGHT = "\u001b[C", BACKSPACE = "\u007f", HOME = "\u0001";
const SUGGESTION = "可以，按这个预览写 PRD";
const dim = (text: string) => `\x1b[2m${text}\x1b[22m`;
const strip = (text: string) => text.replace(/\x1b\[[0-9;]*m/gu, "").replace(/\x1b_[^\x07]*\x07/gu, "");

function create() {
  initTheme("dark");
  const tui = { terminal: { rows: 40, columns: 80 }, requestRender: vi.fn() } as never;
  const theme = { borderColor: (s: string) => s, selectList: getSelectListTheme() };
  const keybindings = new KeybindingsManager(TUI_KEYBINDINGS) as never;
  const editor = new SuggestionEditor(tui, theme, keybindings, dim);
  const plain = new CustomEditor(tui, theme, keybindings);
  const onSubmit = vi.fn();
  editor.onSubmit = onSubmit;
  return { editor, plain, onSubmit, requestRender: (tui as { requestRender: ReturnType<typeof vi.fn> }).requestRender };
}

describe("输入建议编辑器", () => {
  test("没设建议时画面和普通输入栏完全相同", () => {
    const { editor, plain } = create();
    expect(editor.render(80)).toEqual(plain.render(80));
  });

  test("有建议且输入栏为空：第一个字反色，后面的字用 dim 上色，并请求重画", () => {
    const { editor, requestRender } = create();
    editor.setSuggestion(SUGGESTION);
    expect(requestRender).toHaveBeenCalled();
    const lines = editor.render(80);
    expect(lines.some((line) => line.includes(`${renderFakeCursor("可")}${dim("以，按这个预览写 PRD")}`))).toBe(true);
  });

  test("输入一个字后提示消失、文字不变，删空后提示重新出现", () => {
    const { editor } = create();
    editor.setSuggestion(SUGGESTION);
    editor.handleInput("不");
    expect(editor.getText()).toBe("不");
    expect(strip(editor.render(80).join("\n"))).not.toContain("按这个预览写 PRD");
    editor.handleInput(BACKSPACE);
    expect(editor.getText()).toBe("");
    expect(strip(editor.render(80).join("\n"))).toContain("按这个预览写 PRD");
  });

  test("setSuggestion 每次调用都请求一次重画", () => {
    const { editor, requestRender } = create();
    editor.setSuggestion(SUGGESTION);
    editor.setSuggestion(undefined);
    expect(requestRender).toHaveBeenCalledTimes(2);
  });

  test("输入栏为空有建议时按右方向键：文字变成完整建议、不发送、光标在末尾", () => {
    const { editor, onSubmit } = create();
    editor.setSuggestion(SUGGESTION);
    editor.handleInput(RIGHT);
    expect(editor.getText()).toBe(SUGGESTION);
    expect(onSubmit).not.toHaveBeenCalled();
    editor.handleInput("！");
    expect(editor.getText()).toBe(`${SUGGESTION}！`);
  });

  test("右方向键填入后全部删空，提示重新出现", () => {
    const { editor } = create();
    editor.setSuggestion(SUGGESTION);
    editor.handleInput(RIGHT);
    for (let i = 0; i < SUGGESTION.length; i += 1) editor.handleInput(BACKSPACE);
    expect(editor.getText()).toBe("");
    expect(strip(editor.render(80).join("\n"))).toContain("按这个预览写 PRD");
  });

  test("输入栏为空没有建议时按右方向键，文字仍为空", () => {
    const { editor } = create();
    editor.handleInput(RIGHT);
    expect(editor.getText()).toBe("");
  });

  test("输入栏有字时按右方向键只移动光标", () => {
    const { editor } = create();
    editor.setSuggestion(SUGGESTION);
    editor.setText("ab");
    editor.handleInput(HOME);
    editor.handleInput(RIGHT);
    expect(editor.getText()).toBe("ab");
    editor.handleInput("X");
    expect(editor.getText()).toBe("aXb");
  });

  test("建议太长时显示被截断并以省略号结尾，每行不超过宽度，右方向键填入完整建议", () => {
    const { editor } = create();
    const long = "测".repeat(60);
    editor.setSuggestion(long);
    const lines = editor.render(20);
    for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(20);
    const hint = lines.map(strip).find((line) => line.includes("测"));
    expect(hint?.trimEnd().endsWith("…")).toBe(true);
    expect(lines.some((line) => line.includes(renderFakeCursor("测")))).toBe(true);
    editor.handleInput(RIGHT);
    expect(editor.getText()).toBe(long);
  });

  test("显示提示时 Enter、上下方向键的行为和普通输入栏一样", () => {
    const { editor, plain, onSubmit } = create();
    const plainSubmit = vi.fn();
    plain.onSubmit = plainSubmit;
    editor.setSuggestion(SUGGESTION);
    for (const key of ["\r", "\u001b[A", "\u001b[B"]) {
      editor.handleInput(key);
      plain.handleInput(key);
    }
    expect(onSubmit.mock.calls).toEqual(plainSubmit.mock.calls);
    expect(editor.getText()).toBe(plain.getText());
  });

  test("获得焦点时终端光标标记紧挨在第一个字前", () => {
    const { editor } = create();
    editor.focused = true;
    editor.setSuggestion(SUGGESTION);
    const line = editor.render(80).find((l) => l.includes(CURSOR_MARKER));
    expect(line).toBeDefined();
    expect(line!.slice(0, line!.indexOf(CURSOR_MARKER)).trim()).toBe("");
    expect(line).toContain(`${CURSOR_MARKER}${renderFakeCursor("可")}`);
  });

  test("清掉建议后空输入栏不含旧建议，画面与普通输入栏相同", () => {
    const { editor, plain } = create();
    editor.setSuggestion(SUGGESTION);
    editor.setSuggestion(undefined);
    const lines = editor.render(80);
    expect(strip(lines.join("\n"))).not.toContain("按这个预览写 PRD");
    expect(lines).toEqual(plain.render(80));
  });
});
