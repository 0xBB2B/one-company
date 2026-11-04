import type { ExtensionContext, ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import type { EditorTheme, KeybindingsManager, TUI, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import { Editor, matchesKey, sliceByColumn, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

export type LineTone = "normal" | "muted" | "added" | "removed" | "warning";
export interface WindowSpan { text: string; tone?: LineTone; bold?: boolean }
export interface WindowLine {
  text: string;
  tone?: LineTone;
  /** 有 spans 时按段着色，忽略 text。 */
  spans?: WindowSpan[];
  /** 折行时续行在行首 1 个空格之后再补的空格数。 */
  indent?: number;
}
export interface WindowChoice { label: string; description?: string; recommended?: boolean; recommendedReason?: string; /** 不可选时写原因：整行变暗，光标跳过。 */ disabled?: string }
export interface WindowQuestion {
  header?: string;
  /** 问题上方的灰色一行，例如"提问 · 需求名（第 2 版）"。 */
  caption?: string;
  question: string;
  /** 问题下面紧跟的一行普通颜色文字。 */
  subtitle?: string;
  /** 选项上方固定显示的加粗问题，不随内容滚动。 */
  prompt?: string;
  rootCheck?: string;
  lines?: WindowLine[];
  choices: WindowChoice[];
  multiSelect?: boolean;
  allowOther?: boolean;
  /** "其他"一行显示的名称，缺省为"其他（自己输入）"。 */
  otherLabel?: string;
  /** "其他"输入的最长字数；超出时回车不起作用，并在输入行下提示超出多少字。 */
  otherMaxLength?: number;
  /** "其他"行名称下面的灰色说明。 */
  otherDescription?: string;
  /** 按 Esc 取消时实际发生什么，写在提示行末尾的括号里。 */
  cancelNote?: string;
  /** 整个替换提示行里 Esc 那一段。 */
  escapeHint?: string;
  /** 按 Esc 时窗口按"选了这个名称"作答。 */
  escapeChoice?: string;
  /** 提示行里 Esc 那一段单独占第二行。 */
  escapeOnOwnLine?: boolean;
}
export interface WindowAnswer { choices: string[]; other?: string }
export interface WindowTheme { fg(kind: string, text: string): string; bold(text: string): string }
/** 程序发起的窗口用警告色；模型发起的提问用标准颜色。 */
export type WindowTone = "warning" | "standard";

const OTHER = "其他（自己输入）";
const CLOSING = new Set([..."。，、；：？！）」』》,.;:!?)"]);
const WORD = /[\w.~-]/u;
const INPUT_INDENT = 8;
const EDITOR_THEME = { borderColor: (text: string) => text, selectList: {} } as unknown as EditorTheme;

const CURSOR_MARK = "\x1b_pi:fc\x07";
const PLAIN_BORDER = /^─+$/u;
const FAKE_CURSOR = /^\x1b_pi:fc\x07(.*?)\x1b_pi:\/fc\x07/su;
const UP_KEY = "\x1b[A";
// 足够宽，pi 编辑器不会自动折行，只按用户的换行分行
const EDITOR_WIDTH = 10000;

// pi 不告诉窗口实际可用高度，下面还有状态面板和底栏，窗口太高时全屏布局会按比例切掉尾部
const HEIGHT_RATIO = 0.6;
const MIN_HEIGHT = 11;
const SCROLL_STEP = 3;
const SCROLL_HINT = "Shift+↑↓ 滚动内容";

interface BarRow { editorLine: number; start: number; dots: number }
interface Bar { index: number; cursor: number; start: number; end: number; collapsed: boolean; textWidth: number; rows: Array<BarRow | undefined> }

/** 一行放不下时截一段：带光标的行从上次的起点开始，光标出了可见范围才移动起点；被截掉的一侧放灰色省略号。 */
function fitLine(raw: string, width: number, muted: (text: string) => string, previousStart: number): { text: string; start: number; dots: number } {
  const total = visibleWidth(raw);
  if (total <= width) return { text: raw, start: 0, dots: 0 };
  const mark = raw.indexOf(CURSOR_MARK);
  if (mark < 0) return { text: sliceByColumn(raw, 0, width - 1, true) + muted("…"), start: 0, dots: 0 };
  const cursorStart = visibleWidth(raw.slice(0, mark));
  const cursorEnd = cursorStart + (visibleWidth(FAKE_CURSOR.exec(raw.slice(mark))?.[1] ?? "") || 1);
  const tail = total - (width - 1);
  let start = Math.min(previousStart, tail);
  if (cursorStart < start) start = cursorStart;
  const dots = start > 0 ? 1 : 0;
  if (total - start > width - dots && cursorEnd >= start + width - dots - 1) {
    start = cursorEnd + 1 - (width - 2);
    if (start >= tail) start = tail;
  }
  start = visibleWidth(sliceByColumn(raw, 0, start));
  if (start <= 0) return { text: sliceByColumn(raw, 0, width - 1, true) + muted("…"), start: 0, dots: 0 };
  if (total - start <= width - 1) return { text: muted("…") + sliceByColumn(raw, start, width), start, dots: 1 };
  return { text: muted("…") + sliceByColumn(raw, start, width - 2, true) + muted("…"), start, dots: 1 };
}

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
function wrapSegments(text: string, width: number): string[] {
  const [first = "", ...rest] = text.split(" · ");
  const lines = wrapPlain(first, width);
  let line = lines.pop()!;
  for (const segment of rest) {
    if (visibleWidth(`${line} · ${segment}`) <= width) { line += ` · ${segment}`; continue; }
    lines.push(line);
    const pieces = wrapPlain(`· ${segment}`, width);
    line = pieces.pop()!;
    lines.push(...pieces);
  }
  lines.push(line);
  return lines;
}
const TONE_COLOR: Record<LineTone, string | undefined> = { normal: undefined, muted: "muted", added: "toolDiffAdded", removed: "toolDiffRemoved", warning: "warning" };

interface PendingBar { bar: Bar; group: number }
interface OptionEntry { group: number; offset: number }
interface QuestionState { cursor: number; picked: Set<number>; editors: Map<number, Editor>; answered: boolean }

/** 通用问答窗口：一到多个问题，单选或多选，可带"其他（自己输入）"；Esc 取消时答案为 undefined，问题带 escapeChoice 时按它作答。 */
export class QuestionWindowView {
  private tab = 0;
  private reviewCursor = 0;
  private readonly states: QuestionState[];
  private readonly options: { questions: WindowQuestion[]; tone: WindowTone; theme: WindowTheme; tui: Pick<TUI, "requestRender" | "terminal">; onDone(answers: WindowAnswer[] | undefined): void };
  private bars: Bar[] = [];
  private readonly scrolls = new Map<Editor, { line: number; start: number }>();
  private scroll = 0;
  private maxScroll = 0;
  private scrollStep = SCROLL_STEP;
  private scrollTab = 0;

  constructor(options: QuestionWindowView["options"]) {
    this.options = options;
    this.states = options.questions.map((question) => ({ cursor: Math.max(0, question.choices.findIndex((choice) => choice.recommended && !choice.disabled),
      question.choices.findIndex((choice) => !choice.disabled)),
      picked: new Set<number>(), editors: new Map<number, Editor>(), answered: false }));
    this.states.forEach((state, index) => {
      for (let cursor = 0; cursor < this.choiceCount(index); cursor++) {
        if (this.isOther(index, cursor)) state.editors.set(cursor, new Editor(options.tui as TUI, EDITOR_THEME, { paddingX: 0 }));
      }
    });
  }

  private get multi(): boolean { return this.options.questions.length > 1; }
  private get onReview(): boolean { return this.multi && this.tab === this.options.questions.length; }
  private choiceCount(index: number): number {
    const question = this.options.questions[index]!;
    return question.choices.length + (question.allowOther ? 1 : 0);
  }
  private isOther(index: number, cursor: number): boolean { return cursor === this.options.questions[index]!.choices.length; }
  private editorAt(index: number, cursor: number): Editor | undefined { return this.states[index]!.editors.get(cursor); }
  private textAt(index: number, cursor: number): string { return this.editorAt(index, cursor)?.getExpandedText().trim() ?? ""; }
  private otherText(index: number): string { return this.textAt(index, this.options.questions[index]!.choices.length); }
  // 上下边框是纯横线说明那一侧没有被滚动藏起来的行
  private cursorEdge(editor: Editor): { first: boolean; last: boolean } {
    const lines = editor.render(EDITOR_WIDTH);
    const at = lines.findIndex((line, i) => i > 0 && i < lines.length - 1 && line.includes(CURSOR_MARK));
    return { first: at === 1 && PLAIN_BORDER.test(lines[0]!), last: at === lines.length - 2 && PLAIN_BORDER.test(lines[lines.length - 1]!) };
  }
  private move(index: number, step: 1 | -1): void {
    const state = this.states[index]!, question = this.options.questions[index]!;
    for (let next = state.cursor + step; next >= 0 && next < this.choiceCount(index); next += step) {
      if (!question.choices[next]?.disabled) { state.cursor = next; return; }
    }
  }

  private answer(index: number): WindowAnswer {
    const question = this.options.questions[index]!, state = this.states[index]!;
    const choices = question.choices.filter((_, i) => state.picked.has(i)).map((choice) => choice.label);
    const other = this.otherText(index);
    return other ? { choices, other } : { choices };
  }

  private complete(index: number): void {
    this.states[index]!.answered = true;
    if (!this.multi) { this.options.onDone([this.answer(0)]); return; }
    this.tab = index + 1;
  }

  private scrollBy(direction: 1 | -1): boolean {
    if (this.maxScroll === 0) return false;
    this.scroll = Math.min(this.maxScroll, Math.max(0, this.scroll + direction * this.scrollStep));
    return true;
  }

  handleInput(data: string): void {
    if (matchesKey(data, "shift+down") && this.scrollBy(1)) return;
    if (matchesKey(data, "shift+up") && this.scrollBy(-1)) return;
    if (this.onReview) { this.handleReview(data); return; }
    const index = this.tab, state = this.states[index]!, question = this.options.questions[index]!;
    if (matchesKey(data, "escape")) { this.options.onDone(question.escapeChoice !== undefined ? [{ choices: [question.escapeChoice] }] : undefined); return; }
    const editor = this.editorAt(index, state.cursor);
    if (editor) { this.handleInputRow(data, index, editor); return; }
    if (this.multi && matchesKey(data, "right")) { this.tab = Math.min(this.tab + 1, this.options.questions.length); return; }
    if (this.multi && matchesKey(data, "left")) { this.tab = Math.max(this.tab - 1, 0); return; }
    if (matchesKey(data, "down")) { this.move(index, 1); return; }
    if (matchesKey(data, "up")) { this.move(index, -1); return; }
    if (question.multiSelect && matchesKey(data, "space")) {
      if (state.picked.has(state.cursor)) state.picked.delete(state.cursor);
      else state.picked.add(state.cursor);
      return;
    }
    if (!matchesKey(data, "enter") || question.choices[state.cursor]?.disabled) return;
    if (question.multiSelect) { if (state.picked.size > 0 || this.otherText(index)) this.complete(index); return; }
    state.picked = new Set([state.cursor]);
    this.editorAt(index, question.choices.length)?.setText("");
    this.complete(index);
  }

  /** 光标在"其他"行时，按键直接进该行的编辑器；有字时回车才提交。 */
  private handleInputRow(data: string, index: number, editor: Editor): void {
    const state = this.states[index]!, question = this.options.questions[index]!;
    // Ctrl+J（"\n"）在 matchesKey 里也算 enter，但在输入栏里是换行
    if (matchesKey(data, "enter") && data !== "\n") {
      const text = this.textAt(index, state.cursor);
      if (!text || (question.otherMaxLength !== undefined && text.length > question.otherMaxLength)) return;
      if (!question.multiSelect) state.picked.clear();
      this.complete(index);
      return;
    }
    if (matchesKey(data, "up") && this.cursorEdge(editor).first) { this.move(index, -1); return; }
    if (matchesKey(data, "down") && this.cursorEdge(editor).last) { this.move(index, 1); return; }
    editor.handleInput(data);
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type === "wheel") return this.scrollBy((event.wheelDelta ?? 0) > 0 ? 1 : -1) ? { handled: true } : undefined;
    if (event.type !== "click" || event.button !== "left") return undefined;
    const bar = this.bars.find((item) => event.y >= item.start && event.y < item.end);
    if (!bar || this.onReview) return undefined;
    const row = bar.rows[event.y - bar.start];
    if (!row) return undefined;
    this.states[bar.index]!.cursor = bar.cursor;
    const editor = this.editorAt(bar.index, bar.cursor)!;
    if (bar.collapsed) {
      for (let n = editor.getCursor().line; n > 0; n--) editor.handleInput(UP_KEY);
      editor.render(EDITOR_WIDTH);
    }
    const column = event.x - INPUT_INDENT - row.dots;
    const x = bar.collapsed && column >= bar.textWidth ? EDITOR_WIDTH : row.start + Math.max(0, column);
    const result = editor.handleMouse({ ...event, x, y: row.editorLine, width: EDITOR_WIDTH });
    return { ...result, handled: true };
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
    if (this.tab !== this.scrollTab) { this.scrollTab = this.tab; this.scroll = 0; }
    const { theme, tone } = this.options;
    const warning = tone === "warning";
    const border = theme.fg(warning ? "warning" : "border", "─".repeat(width));
    const highlight = (text: string) => theme.fg(warning ? "warning" : "accent", text);
    const muted = (text: string) => theme.fg("muted", text);
    const wrap = (text: string, indent: number) => wrapTextWithAnsi(text, Math.max(8, width - indent)).map((line) => " ".repeat(indent) + line);
    const head: string[] = [border];
    const content: string[] = [];
    const groups: string[][] = [];
    const pending: PendingBar[] = [];
    if (this.multi) head.push(this.renderTabs(), "");

    if (this.onReview) {
      content.push(` ${theme.bold("核对你的回答")}`, "");
      this.options.questions.forEach((question, i) => {
        const answer = this.answer(i);
        const text = [...answer.choices, ...(answer.other ? [answer.other] : [])].join("、");
        content.push(...wrap(`${question.header ?? question.question}：${this.states[i]!.answered ? text : muted("未回答")}`, 1));
      });
      groups.push(...["提交", "取消"].map((label, i) => [i === this.reviewCursor ? ` ${highlight(`→ ${label}`)}` : `   ${label}`]));
      const bottomFor = (scrollable: boolean) => {
        const hint = ["↑↓ 选择", "回车确认", ...(scrollable ? [SCROLL_HINT] : []), "←→ 回去修改", "Esc 取消"].join(" · ");
        return ["", ...wrapPlain(hint, width - 1).map((piece) => ` ${muted(piece)}`), border];
      };
      return this.compose(head, content, [], groups, pending, this.reviewCursor, bottomFor, muted);
    }

    const index = this.tab, question = this.options.questions[index]!, state = this.states[index]!;
    if (question.caption) content.push(...wrapPlain(question.caption, width - 1).map((piece) => ` ${muted(piece)}`), "");
    if (warning) content.push(...wrap(theme.fg("warning", theme.bold(question.question)), 1), "");
    else content.push(...wrapPlain(question.question, width - 1).map((piece) => ` ${theme.bold(piece)}`), ...(question.subtitle ? wrapPlain(question.subtitle, width - 1).map((piece) => ` ${piece}`) : []), "");
    if (!warning && question.rootCheck) {
      const label = "根源自检  ", indent = " ".repeat(visibleWidth(label));
      content.push(...wrapPlain(question.rootCheck, width - 1 - indent.length).map((piece, i) => ` ${muted(`${i ? indent : label}${piece}`)}`), "");
    }
    for (const line of question.lines ?? []) {
      const indent = line.indent ?? 0;
      const paint = (text: string, tone?: LineTone, bold?: boolean) => {
        const color = TONE_COLOR[tone ?? "normal"];
        return bold ? theme.bold(color ? theme.fg(color, text) : text) : color ? theme.fg(color, text) : text;
      };
      if (line.spans) {
        const joined = line.spans.map((span) => paint(span.text, span.tone, span.bold)).join("");
        wrapTextWithAnsi(joined, Math.max(8, width - 1 - indent)).forEach((piece, n) => content.push(` ${" ".repeat(n ? indent : 0)}${piece}`));
        continue;
      }
      wrapTextWithAnsi(line.text, Math.max(8, width - 1 - indent)).forEach((piece, n) => content.push(` ${" ".repeat(n ? indent : 0)}${paint(piece, line.tone)}`));
    }
    if (question.lines?.length) content.push("");
    content.pop();

    const labels = [...question.choices.map((choice) => choice.label + (warning && choice.recommended ? "（推荐）" : "")), ...(question.allowOther ? [question.otherLabel ?? OTHER] : [])];
    const labelWidth = Math.max(...labels.map((label) => visibleWidth(label)));
    labels.forEach((label, i) => {
      const group: string[] = [];
      groups.push(group);
      const selected = i === state.cursor;
      const box = question.multiSelect ? `[${state.picked.has(i) || (this.isOther(index, i) && this.otherText(index)) ? "x" : " "}] ` : "";
      const description = question.choices[i]?.description ?? (this.isOther(index, i) ? question.otherDescription : undefined), disabled = question.choices[i]?.disabled;
      if (disabled) {
        const lead = `${label}${" ".repeat(labelWidth - visibleWidth(label) + 3)}`;
        wrapPlain(disabled, Math.max(8, width - 3 - visibleWidth(lead))).forEach((piece, n) => group.push(`   ${muted(`${n ? " ".repeat(visibleWidth(lead)) : lead}${piece}`)}`));
        return;
      }
      if (warning) {
        const text = `${box}${label}`;
        const padded = description ? text + " ".repeat(labelWidth - visibleWidth(label) + 3) : text;
        const pieces = description ? wrapSegments(description, Math.max(8, width - 3 - visibleWidth(padded))) : [];
        group.push((selected ? ` ${highlight(`→ ${text}`)}` : `   ${text}`) + (description ? padded.slice(text.length) + muted(pieces[0]!) : ""));
        for (const piece of pieces.slice(1)) group.push(" ".repeat(3 + visibleWidth(padded)) + muted(piece));
      } else {
        const choice = question.choices[i], number = `${box}${i + 1}. `, tag = choice?.recommended ? `  ${theme.fg("success", theme.bold("推荐"))}` : "";
        const pieces = wrapPlain(label, width - 3 - visibleWidth(number) - (tag ? 6 : 0));
        pieces.forEach((piece, n) => {
          const text = n ? `${" ".repeat(visibleWidth(number))}${piece}` : `${number}${piece}`;
          group.push((selected ? ` ${highlight(`${n ? "  " : "→ "}${text}`)}` : `   ${text}`) + (n === pieces.length - 1 ? tag : ""));
        });
        if (description) group.push(...wrapPlain(description, width - 6).map((piece) => `      ${muted(piece)}`));
        if (choice?.recommended && choice.recommendedReason) {
          group.push(...wrapPlain(`推荐理由：${choice.recommendedReason}`, width - 6).map((piece) => `      ${theme.fg("success", piece)}`));
        }
      }
      const editor = this.editorAt(index, i);
      if (!editor) return;
      editor.focused = selected;
      if (selected || editor.getText()) {
        const bar = this.renderInput(editor, index, i, selected, width - INPUT_INDENT, group.length, highlight, muted);
        group.push(...bar.lines);
        pending.push({ bar: bar.bar, group: i });
      }
      const excess = question.otherMaxLength !== undefined ? this.textAt(index, i).length - question.otherMaxLength : 0;
      if (excess > 0) group.push(`      ${muted(`超出 ${excess} 字，最多 ${question.otherMaxLength} 字`)}`);
    });

    const fixed = question.prompt ? ["", ...wrapPlain(question.prompt, width - 1).map((piece) => ` ${theme.bold(piece)}`)] : [];
    const enter = question.multiSelect && this.multi ? "回车下一题" : "回车确认";
    const escapeText = question.escapeHint ?? `Esc 取消${question.cancelNote ? `（${question.cancelNote}）` : ""}`;
    const bottomFor = (scrollable: boolean) => {
      const hint = [
        ...(this.isOther(index, state.cursor) ? ["直接输入", enter, "Shift+Enter 换行", "↑↓ 选择"] : ["↑↓ 选择", ...(question.multiSelect ? ["空格勾选"] : []), enter]),
        ...(scrollable ? [SCROLL_HINT] : []),
        ...(this.multi ? ["←→ 切换问题"] : []),
        ...(question.escapeOnOwnLine ? [] : [escapeText]),
      ].join(" · ");
      const escape = question.escapeOnOwnLine ? wrapPlain(escapeText, width - 1).map((piece) => ` ${muted(piece)}`) : [];
      return ["", ...wrapPlain(hint, width - 1).map((piece) => ` ${muted(piece)}`), ...escape, border];
    };
    return this.compose(head, content, fixed, groups, pending, state.cursor, bottomFor, muted);
  }

  private compose(head: string[], content: string[], fixed: string[], groups: string[][], pending: PendingBar[], cursor: number,
    bottomFor: (scrollable: boolean) => string[], muted: (text: string) => string): string[] {
    const rows = this.options.tui.terminal?.rows;
    const cap = rows === undefined ? undefined : Math.max(MIN_HEIGHT, Math.floor(rows * HEIGHT_RATIO));
    const optionLines = groups.reduce((sum, group) => sum + group.length, 0);
    let bottom = bottomFor(false), contentOut = content, optionOut = groups.flat();
    let entries: OptionEntry[] = [];
    let offset = 0;
    groups.forEach((group, i) => { entries.push({ group: i, offset }); offset += group.length; });
    this.maxScroll = 0;
    if (cap !== undefined && head.length + content.length + fixed.length + 1 + optionLines + bottom.length > cap) {
      bottom = bottomFor(true);
      const avail = cap - head.length - fixed.length - 1 - bottom.length;
      const minContent = Math.min(content.length, 3);
      if (optionLines > avail - minContent) ({ lines: optionOut, entries } = this.optionWindow(groups, cursor, Math.max(3, avail - minContent), muted));
      const room = Math.max(1, avail - optionOut.length);
      if (content.length <= room) bottom = bottomFor(false);
      else {
        const hints = room < 3 ? 0 : 1;
        this.maxScroll = content.length - room + hints;
        this.scrollStep = Math.min(SCROLL_STEP, room - 2 * hints);
        this.scroll = Math.min(this.scroll, this.maxScroll);
        contentOut = this.contentWindow(content, room, hints, muted);
      }
    }
    this.scroll = Math.min(this.scroll, this.maxScroll);
    // 选项窗口至少 3 行、内容至少 1 行，加上固定问题后矮终端会超过上限
    if (fixed.length && cap !== undefined && head.length + contentOut.length + fixed.length + 1 + optionOut.length + bottom.length > cap) {
      fixed = fixed.slice(1);
      bottom = bottom.slice(1);
    }
    const base = head.length + contentOut.length + fixed.length + 1;
    this.bars = pending.flatMap(({ bar, group }) => {
      const entry = entries.find((item) => item.group === group);
      if (!entry) return [];
      return [{ ...bar, start: base + entry.offset + bar.start, end: base + entry.offset + bar.end }];
    });
    return [...head, ...contentOut, ...fixed, "", ...optionOut, ...bottom];
  }

  private contentWindow(content: string[], room: number, hints: number, muted: (text: string) => string): string[] {
    const { scroll } = this, total = content.length;
    if (!hints) return content.slice(scroll, scroll + room);
    const up = scroll > 0 ? [` ${muted(`↑ 上面还有 ${scroll} 行`)}`] : [], body = room - up.length;
    if (scroll + body >= total) return [...up, ...content.slice(scroll)];
    const shown = content.slice(scroll, scroll + body - 1);
    return [...up, ...shown, ` ${muted(`↓ 下面还有 ${total - scroll - shown.length} 行`)}`];
  }

  /** 光标所在选项整组显示，不然看不全理由或正在编辑的行。 */
  private optionWindow(groups: string[][], cursor: number, height: number, muted: (text: string) => string): { lines: string[]; entries: OptionEntry[] } {
    const fit = (from: number) => {
      const up = from > 0 ? 1 : 0;
      const rest = groups.slice(from).reduce((sum, group) => sum + group.length, 0);
      const body = height - up - (rest > height - up ? 1 : 0);
      let used = 0, count = 0;
      while (from + count < groups.length && used + groups[from + count]!.length <= body) used += groups[from + count++]!.length;
      return count;
    };
    let from = 0;
    while (from < cursor && cursor >= from + fit(from)) from++;
    const count = Math.max(1, fit(from)), hidden = groups.length - from - count;
    const lines = from > 0 ? [` ${muted(`↑ 上面还有 ${from} 项`)}`] : [];
    const entries: OptionEntry[] = [];
    for (let g = from; g < from + count; g++) {
      entries.push({ group: g, offset: lines.length });
      lines.push(...groups[g]!);
    }
    if (hidden > 0) lines.push(` ${muted(`↓ 下面还有 ${hidden} 项`)}`);
    return { lines, entries };
  }

  private renderInput(editor: Editor, index: number, cursor: number, expanded: boolean, width: number, start: number,
    highlight: (text: string) => string, muted: (text: string) => string): { lines: string[]; bar: Bar } {
    const prefix = `      ${expanded ? highlight("›") : "›"} `;
    const make = (lines: string[], rows: Array<BarRow | undefined>, textWidth = 0) =>
      ({ lines, bar: { index, cursor, start, end: start + lines.length, collapsed: !expanded, textWidth, rows } });
    if (!expanded) {
      const first = editor.getLines()[0] ?? "";
      const total = editor.getExpandedText().split("\n").length;
      const suffix = total > 1 ? muted(`…（共 ${total} 行）`) : "";
      const room = width - (total > 1 ? visibleWidth(`…（共 ${total} 行）`) : 0);
      const fits = visibleWidth(first) <= room;
      const body = fits ? first : sliceByColumn(first, 0, room - (total > 1 ? 0 : 1), true);
      const text = body + (total > 1 ? suffix : fits ? "" : muted("…"));
      return make([prefix + text], [{ editorLine: 1, start: 0, dots: 0 }], visibleWidth(body));
    }
    const rendered = editor.render(EDITOR_WIDTH);
    const hidden = (border: string, arrow: string) => Number(new RegExp(`${arrow} (\\d+) more`, "u").exec(border)?.[1] ?? 0);
    const above = hidden(rendered[0]!, "↑"), below = hidden(rendered[rendered.length - 1]!, "↓");
    const lines: string[] = [], rows: Array<BarRow | undefined> = [];
    const saved = this.scrolls.get(editor), cursorLine = editor.getCursor().line;
    if (above) { lines.push(`      ${highlight("›")} ${muted(`↑ 上面还有 ${above} 行`)}`); rows.push(undefined); }
    rendered.slice(1, -1).forEach((line, n) => {
      const raw = line.trimEnd();
      const fit = fitLine(raw, width, muted, saved?.line === cursorLine ? saved.start : 0);
      if (raw.includes(CURSOR_MARK)) this.scrolls.set(editor, { line: cursorLine, start: fit.start });
      lines.push((n || above ? " ".repeat(INPUT_INDENT) : prefix) + fit.text);
      rows.push({ editorLine: n + 1, start: fit.start, dots: fit.dots });
    });
    if (below) { lines.push(`${" ".repeat(INPUT_INDENT)}${muted(`↓ 下面还有 ${below} 行`)}`); rows.push(undefined); }
    return make(lines, rows);
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

export type WindowHost = Pick<ExtensionContext, "hasUI"> & { ui: Pick<ExtensionUIContext, "custom"> } & {
  isIdle?: ExtensionContext["isIdle"];
};
export interface ProgramWindow { title: string; lines: WindowLine[] }

export interface ProgramWindowHost {
  hasUI?: boolean;
  ui?: { custom?: unknown };
  isIdle?: () => boolean;
}
type WindowFactory<T> = (tui: TUI, theme: Theme, keybindings: KeybindingsManager, done: (value: T | undefined) => void) => unknown;
type CustomOptions = Parameters<ExtensionUIContext["custom"]>[1];
const QUEUE = Symbol.for("one-company.program-window-queue");

/** 所有程序窗口共用一个先进先出队列，同一时间只显示一个；队列挂在 globalThis 上，模块被加载多份时也只有一份。 */
export async function openProgramWindow<T>(host: ProgramWindowHost, factory: WindowFactory<T>, signal?: AbortSignal, options?: CustomOptions, waitingText?: string): Promise<T | undefined> {
  const custom = host.ui?.custom as ((factory: WindowFactory<T>, options?: CustomOptions) => Promise<T | undefined>) | undefined;
  if (host.hasUI === false || typeof custom !== "function" || signal?.aborted) return undefined;
  const queue = ((globalThis as Record<symbol, unknown>)[QUEUE] ??= { tail: Promise.resolve() }) as { tail: Promise<void> };
  const previous = queue.tail;
  let release!: () => void;
  queue.tail = new Promise<void>((resolve) => { release = resolve; });
  try {
    const aborted = await new Promise<boolean>((resolve) => {
      const onAbort = () => resolve(true);
      signal?.addEventListener("abort", onAbort, { once: true });
      void previous.then(() => { signal?.removeEventListener("abort", onAbort); resolve(false); });
    });
    if (aborted || signal?.aborted) return undefined;
    const blocked = waitingText !== undefined && host.isIdle?.() === false ? { kind: "question" as const, message: waitingText } : undefined;
    return await custom.call(host.ui, (tui, theme, keybindings, done) => {
      const finish = (value: T | undefined) => { signal?.removeEventListener("abort", abort); done(value); };
      const abort = () => finish(undefined);
      signal?.addEventListener("abort", abort, { once: true });
      return factory(tui, theme, keybindings, finish);
    }, blocked ? { ...options, blocked } : options);
  } finally {
    void previous.then(release);
  }
}

async function showWindow(host: WindowHost, questions: WindowQuestion[], tone: WindowTone, signal?: AbortSignal): Promise<WindowAnswer[] | undefined> {
  return openProgramWindow<WindowAnswer[]>(host, (tui, theme, _keybindings, done) => {
    const view = new QuestionWindowView({ questions, tone, tui, theme: theme as unknown as WindowTheme, onDone: done });
    return { render: (width: number) => view.render(width), invalidate: () => view.invalidate(),
      handleInput: (data: string) => { view.handleInput(data); tui.requestRender(); },
      handleMouse: (event: TuiMouseEvent) => { const result = view.handleMouse(event); tui.requestRender(); return result; } };
  }, signal, undefined, questions[0]!.question);
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
export async function chooseWindow(host: WindowHost, window: ProgramWindow & { choices: WindowChoice[]; cancelNote?: string; caption?: string; escapeHint?: string }, signal?: AbortSignal): Promise<string | undefined> {
  const answers = await showWindow(host, [{ question: window.title, lines: window.lines, choices: window.choices, ...(window.cancelNote ? { cancelNote: window.cancelNote } : {}),
    ...(window.caption ? { caption: window.caption } : {}), ...(window.escapeHint ? { escapeHint: window.escapeHint } : {}) }], "warning", signal);
  return answers?.[0]?.choices[0];
}

/** 带"其他"输入行的程序选择窗口：返回选中的选项或用户输入的文字；Esc 时为 escapeChoice 的答案（没有则为 undefined），中断时为 undefined。 */
export async function chooseOrWriteWindow(host: WindowHost, window: ProgramWindow & { choices: WindowChoice[]; otherLabel?: string; otherMaxLength?: number; cancelNote?: string; escapeHint?: string; escapeChoice?: string }, signal?: AbortSignal): Promise<WindowAnswer | undefined> {
  const answers = await showWindow(host, [{ question: window.title, lines: window.lines, choices: window.choices, allowOther: true, ...(window.otherLabel ? { otherLabel: window.otherLabel } : {}),
    ...(window.otherMaxLength !== undefined ? { otherMaxLength: window.otherMaxLength } : {}),
    ...(window.cancelNote ? { cancelNote: window.cancelNote } : {}), ...(window.escapeHint ? { escapeHint: window.escapeHint } : {}),
    ...(window.escapeChoice !== undefined ? { escapeChoice: window.escapeChoice } : {}) }], "warning", signal);
  return answers?.[0];
}

export function mutedLines(texts: string[]): WindowLine[] {
  return texts.map((text) => ({ text, tone: "muted" }));
}
