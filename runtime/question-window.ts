import type { ExtensionContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { decodeKittyPrintable, matchesKey, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

export type LineTone = "normal" | "muted" | "added" | "removed";
export interface WindowLine { text: string; tone?: LineTone }
export interface WindowChoice { label: string; description?: string; recommended?: boolean; recommendedReason?: string; /** 不可选时写原因：整行变暗，光标跳过。 */ disabled?: string }
export interface WindowQuestion {
  header?: string;
  /** 问题上方的灰色一行，例如"提问 · 需求名（第 2 版）"。 */
  caption?: string;
  question: string;
  rootCheck?: string;
  lines?: WindowLine[];
  choices: WindowChoice[];
  multiSelect?: boolean;
  allowOther?: boolean;
  /** "其他"一行显示的名称，缺省为"其他（自己输入）"。 */
  otherLabel?: string;
  /** 按 Esc 取消时实际发生什么，写在提示行末尾的括号里。 */
  cancelNote?: string;
  /** 整个替换提示行里 Esc 那一段。 */
  escapeHint?: string;
}
export interface WindowAnswer { choices: string[]; other?: string }
export interface WindowTheme { fg(kind: string, text: string): string; bold(text: string): string }
/** 程序发起的窗口用警告色；模型发起的提问用标准颜色。 */
export type WindowTone = "warning" | "standard";

const OTHER = "其他（自己输入）";
const CLOSING = new Set([..."。，、；：？！）」』》,.;:!?)"]);
const WORD = /[\w.~-]/u;
const CARET = "\x1b[7m \x1b[27m";

/** 按显示宽度折行：放得下就放；行首不留句号逗号这类标点，英文单词与数字不从中间切开。 */
function wrapPlain(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const char of text) {
    if (visibleWidth(line + char) <= width) { line += char; continue; }
    const chars = [...line];
    let cut = chars.length;
    if (CLOSING.has(char)) cut = chars.length - 1;
    else if (WORD.test(char)) while (cut > 0 && WORD.test(chars[cut - 1]!)) cut--;
    if (cut <= 0 || cut >= chars.length) { lines.push(line); line = char === " " ? "" : char; continue; }
    lines.push(chars.slice(0, cut).join("").trimEnd());
    line = chars.slice(cut).join("") + char;
  }
  lines.push(line);
  return lines;
}
const TONE_COLOR: Record<LineTone, string | undefined> = { normal: undefined, muted: "muted", added: "toolDiffAdded", removed: "toolDiffRemoved" };

interface QuestionState { cursor: number; picked: Set<number>; other: string; answered: boolean }

/** 通用问答窗口：一到多个问题，单选或多选，可带"其他（自己输入）"；Esc 取消时答案为 undefined。 */
export class QuestionWindowView {
  private tab = 0;
  private reviewCursor = 0;
  private readonly states: QuestionState[];
  private readonly options: { questions: WindowQuestion[]; tone: WindowTone; theme: WindowTheme; onDone(answers: WindowAnswer[] | undefined): void };

  constructor(options: QuestionWindowView["options"]) {
    this.options = options;
    this.states = options.questions.map((question) => ({ cursor: Math.max(0, question.choices.findIndex((choice) => choice.recommended && !choice.disabled),
      question.choices.findIndex((choice) => !choice.disabled)),
      picked: new Set<number>(), other: "", answered: false }));
  }

  private get multi(): boolean { return this.options.questions.length > 1; }
  private get onReview(): boolean { return this.multi && this.tab === this.options.questions.length; }
  private choiceCount(index: number): number {
    const question = this.options.questions[index]!;
    return question.choices.length + (question.allowOther ? 1 : 0);
  }
  private isOther(index: number, cursor: number): boolean { return cursor === this.options.questions[index]!.choices.length; }
  private move(index: number, step: 1 | -1): void {
    const state = this.states[index]!, question = this.options.questions[index]!;
    for (let next = state.cursor + step; next >= 0 && next < this.choiceCount(index); next += step) {
      if (!question.choices[next]?.disabled) { state.cursor = next; return; }
    }
  }

  private answer(index: number): WindowAnswer {
    const question = this.options.questions[index]!, state = this.states[index]!;
    const choices = question.choices.filter((_, i) => state.picked.has(i)).map((choice) => choice.label);
    return state.other.trim() ? { choices, other: state.other.trim() } : { choices };
  }

  private complete(index: number): void {
    this.states[index]!.answered = true;
    if (!this.multi) { this.options.onDone([this.answer(0)]); return; }
    this.tab = index + 1;
  }

  handleInput(data: string): void {
    if (this.onReview) { this.handleReview(data); return; }
    const index = this.tab, state = this.states[index]!, question = this.options.questions[index]!;
    if (matchesKey(data, "escape")) { this.options.onDone(undefined); return; }
    if (this.multi && matchesKey(data, "right")) { this.tab = Math.min(this.tab + 1, this.options.questions.length); return; }
    if (this.multi && matchesKey(data, "left")) { this.tab = Math.max(this.tab - 1, 0); return; }
    if (matchesKey(data, "down")) { this.move(index, 1); return; }
    if (matchesKey(data, "up")) { this.move(index, -1); return; }
    if (this.isOther(index, state.cursor)) { this.handleOther(data, index); return; }
    if (question.multiSelect && matchesKey(data, "space")) {
      if (state.picked.has(state.cursor)) state.picked.delete(state.cursor);
      else state.picked.add(state.cursor);
      return;
    }
    if (!matchesKey(data, "enter") || question.choices[state.cursor]?.disabled) return;
    if (question.multiSelect) { if (state.picked.size > 0 || state.other.trim()) this.complete(index); return; }
    state.picked = new Set([state.cursor]); state.other = "";
    this.complete(index);
  }

  /** 光标在"其他"一行时，按键直接进输入栏；有字时回车才提交。 */
  private handleOther(data: string, index: number): void {
    const state = this.states[index]!, question = this.options.questions[index]!;
    if (matchesKey(data, "enter")) {
      if (!state.other.trim()) return;
      if (!question.multiSelect) state.picked.clear();
      this.complete(index);
      return;
    }
    if (matchesKey(data, "backspace")) { state.other = [...state.other].slice(0, -1).join(""); return; }
    const printable = decodeKittyPrintable(data) ?? data;
    if (!/[\u0000-\u001f\u007f]/u.test(printable)) state.other += printable;
  }

  private handleReview(data: string): void {
    if (matchesKey(data, "escape")) { this.options.onDone(undefined); return; }
    if (matchesKey(data, "left")) { this.tab = this.options.questions.length - 1; return; }
    if (matchesKey(data, "down")) { this.reviewCursor = 1; return; }
    if (matchesKey(data, "up")) { this.reviewCursor = 0; return; }
    if (!matchesKey(data, "enter")) return;
    if (this.reviewCursor === 1) { this.options.onDone(undefined); return; }
    if (this.states.every((state) => state.answered)) this.options.onDone(this.options.questions.map((_, i) => this.answer(i)));
  }

  render(width: number): string[] {
    const { theme, tone } = this.options;
    const warning = tone === "warning";
    const border = theme.fg(warning ? "warning" : "border", "─".repeat(width));
    const highlight = (text: string) => theme.fg(warning ? "warning" : "accent", text);
    const muted = (text: string) => theme.fg("muted", text);
    const wrap = (text: string, indent: number) => wrapTextWithAnsi(text, Math.max(8, width - indent)).map((line) => " ".repeat(indent) + line);
    const lines: string[] = [border];
    if (this.multi) lines.push(this.renderTabs(), "");

    if (this.onReview) {
      lines.push(` ${theme.bold("核对你的回答")}`, "");
      this.options.questions.forEach((question, i) => {
        const answer = this.answer(i);
        const text = [...answer.choices, ...(answer.other ? [answer.other] : [])].join("、");
        lines.push(...wrap(`${question.header ?? question.question}：${this.states[i]!.answered ? text : muted("未回答")}`, 1));
      });
      lines.push("", ...["提交", "取消"].map((label, i) => i === this.reviewCursor ? ` ${highlight(`→ ${label}`)}` : `   ${label}`),
        "", ` ${muted("↑↓ 选择 · 回车确认 · ←→ 回去修改 · Esc 取消")}`, border);
      return lines;
    }

    const index = this.tab, question = this.options.questions[index]!, state = this.states[index]!;
    if (!warning && question.caption) lines.push(...wrapPlain(question.caption, width - 1).map((piece) => ` ${muted(piece)}`), "");
    if (warning) lines.push(...wrap(theme.fg("warning", theme.bold(question.question)), 1), "");
    else lines.push(...wrapPlain(question.question, width - 1).map((piece) => ` ${theme.bold(piece)}`), "");
    if (!warning && question.rootCheck) {
      const label = "根源自检  ", indent = " ".repeat(visibleWidth(label));
      lines.push(...wrapPlain(question.rootCheck, width - 1 - indent.length).map((piece, i) => ` ${muted(`${i ? indent : label}${piece}`)}`), "");
    }
    for (const line of question.lines ?? []) {
      const color = TONE_COLOR[line.tone ?? "normal"];
      for (const piece of wrapTextWithAnsi(line.text, Math.max(8, width - 1))) lines.push(` ${color ? theme.fg(color, piece) : piece}`);
    }
    if (question.lines?.length) lines.push("");

    const labels = [...question.choices.map((choice) => choice.label + (warning && choice.recommended ? "（推荐）" : "")), ...(question.allowOther ? [question.otherLabel ?? OTHER] : [])];
    const labelWidth = Math.max(...labels.map((label) => visibleWidth(label)));
    labels.forEach((label, i) => {
      const selected = i === state.cursor;
      const box = question.multiSelect ? `[${state.picked.has(i) || (this.isOther(index, i) && state.other.trim()) ? "x" : " "}] ` : "";
      const description = question.choices[i]?.description, disabled = question.choices[i]?.disabled;
      if (disabled) {
        lines.push(`   ${muted(`${label}${" ".repeat(labelWidth - visibleWidth(label) + 3)}${disabled}`)}`);
        return;
      }
      if (warning) {
        const text = `${box}${label}`;
        const padded = description ? text + " ".repeat(labelWidth - visibleWidth(label) + 3) : text;
        lines.push((selected ? ` ${highlight(`→ ${text}`)}` : `   ${text}`) + (description ? padded.slice(text.length) + muted(description) : ""));
      } else {
        const choice = question.choices[i], number = `${box}${i + 1}. `, tag = choice?.recommended ? `  ${theme.fg("success", theme.bold("推荐"))}` : "";
        const pieces = wrapPlain(label, width - 3 - visibleWidth(number) - (tag ? 6 : 0));
        pieces.forEach((piece, n) => {
          const text = n ? `${" ".repeat(visibleWidth(number))}${piece}` : `${number}${piece}`;
          lines.push((selected ? ` ${highlight(`${n ? "  " : "→ "}${text}`)}` : `   ${text}`) + (n === pieces.length - 1 ? tag : ""));
        });
        if (description) lines.push(...wrapPlain(description, width - 6).map((piece) => `      ${muted(piece)}`));
        if (choice?.recommended && choice.recommendedReason) {
          lines.push(...wrapPlain(`推荐理由：${choice.recommendedReason}`, width - 6).map((piece) => `      ${theme.fg("success", piece)}`));
        }
      }
      if (this.isOther(index, i) && (selected || state.other)) lines.push(`      ${highlight("›")} ${state.other}${selected ? CARET : ""}`);
    });

    const enter = question.multiSelect && this.multi ? "回车下一题" : "回车确认";
    const hint = [
      ...(this.isOther(index, state.cursor) ? ["直接输入", enter, "↑↓ 选择"] : ["↑↓ 选择", ...(question.multiSelect ? ["空格勾选"] : []), enter]),
      ...(this.multi ? ["←→ 切换问题"] : []),
      question.escapeHint ?? `Esc 取消${question.cancelNote ? `（${question.cancelNote}）` : ""}`,
    ].join(" · ");
    lines.push("", ...wrapPlain(hint, width - 1).map((piece) => ` ${muted(piece)}`), border);
    return lines;
  }

  private renderTabs(): string {
    const { theme } = this.options;
    const tabs = [...this.options.questions.map((question, i) => ({ label: question.header ?? `问题 ${i + 1}`, answered: this.states[i]!.answered })),
      { label: "提交", answered: false }];
    return " " + tabs.map((tab, i) => i === this.tab ? theme.fg("accent", theme.bold(` ${tab.label} `))
      : tab.answered ? theme.fg("success", ` ✓ ${tab.label} `) : theme.fg("muted", ` ${tab.label} `)).join("  ");
  }

  invalidate(): void {}
}

export type WindowHost = Pick<ExtensionContext, "hasUI"> & { ui: Pick<ExtensionUIContext, "custom"> };
export interface ProgramWindow { title: string; lines: WindowLine[] }

async function showWindow(host: WindowHost, questions: WindowQuestion[], tone: WindowTone, signal?: AbortSignal): Promise<WindowAnswer[] | undefined> {
  if (!host.hasUI || signal?.aborted) return undefined;
  return host.ui.custom<WindowAnswer[] | undefined>((tui, theme, _keybindings, done) => {
    const finish = (answers: WindowAnswer[] | undefined) => { signal?.removeEventListener("abort", abort); done(answers); };
    const abort = () => finish(undefined);
    signal?.addEventListener("abort", abort, { once: true });
    const view = new QuestionWindowView({ questions, tone, theme: theme as unknown as WindowTheme, onDone: finish });
    return { render: (width: number) => view.render(width), invalidate: () => view.invalidate(),
      handleInput: (data: string) => { view.handleInput(data); tui.requestRender(); } };
  });
}

/** 主代理提问窗口：标准颜色，一次一个问题；Esc 或没有界面时为 undefined。 */
export async function askWindow(host: WindowHost, question: WindowQuestion, signal?: AbortSignal): Promise<WindowAnswer | undefined> {
  return (await showWindow(host, [question], "standard", signal))?.[0];
}

/** 程序确认窗口：只有用户选中"确认"才返回 true。 */
export async function confirmWindow(host: WindowHost, window: ProgramWindow, signal?: AbortSignal): Promise<boolean> {
  const answers = await showWindow(host, [{ question: window.title, lines: window.lines, choices: [{ label: "确认" }, { label: "取消" }] }], "warning", signal);
  return answers?.[0]?.choices[0] === "确认";
}

/** 程序选择窗口：返回用户选中的选项名，取消时为 undefined。 */
export async function chooseWindow(host: WindowHost, window: ProgramWindow & { choices: WindowChoice[]; cancelNote?: string }, signal?: AbortSignal): Promise<string | undefined> {
  const answers = await showWindow(host, [{ question: window.title, lines: window.lines, choices: window.choices, ...(window.cancelNote ? { cancelNote: window.cancelNote } : {}) }], "warning", signal);
  return answers?.[0]?.choices[0];
}

/** 带"其他"输入行的程序选择窗口：返回选中的选项或用户输入的文字，取消时为 undefined。 */
export async function chooseOrWriteWindow(host: WindowHost, window: ProgramWindow & { choices: WindowChoice[]; otherLabel: string; cancelNote?: string; escapeHint?: string }, signal?: AbortSignal): Promise<WindowAnswer | undefined> {
  const answers = await showWindow(host, [{ question: window.title, lines: window.lines, choices: window.choices, allowOther: true, otherLabel: window.otherLabel,
    ...(window.cancelNote ? { cancelNote: window.cancelNote } : {}), ...(window.escapeHint ? { escapeHint: window.escapeHint } : {}) }], "warning", signal);
  return answers?.[0];
}

export function mutedLines(texts: string[]): WindowLine[] {
  return texts.map((text) => ({ text, tone: "muted" }));
}
