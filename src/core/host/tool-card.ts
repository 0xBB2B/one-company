import { basename } from "node:path";
import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { unwrapRequest } from "../exec/tool-request.ts";
import { windowContext } from "./extension-lifecycle.ts";

export type CardTheme = { fg(kind: string, text: string): string; bold(text: string): string };
export type CardRow = Readonly<Record<string, any>>;

// 省略号放在样式重置码之后，行尾才是真正的“…”
const fit = (line: string, width: number): string => (visibleWidth(line) <= width ? line : `${truncateToWidth(line, width - 1, "")}…`);

export class CardText implements Component {
  private lines: string[];
  private readonly expanded: string;
  constructor(lines: string[], expanded = "") {
    this.lines = lines;
    this.expanded = expanded;
  }
  setLines(lines: string[]): void { this.lines = lines; }
  invalidate(): void {}
  render(width: number): string[] {
    const open = this.expanded === "" ? [] : this.expanded.split("\n").flatMap((line) => (line === "" ? [""] : wrapTextWithAnsi(line, width)));
    return [...this.lines.map((line) => fit(line.replace(/\s*[\r\n]+\s*/gu, " "), width)), ...open];
  }
}

export function cardHeader(theme: CardTheme, action: string, object?: string): string {
  return object ? `${theme.bold(action)}  ${theme.fg("muted", object)}` : theme.bold(action);
}

export function summaryLine(theme: CardTheme, first: string, ...rest: Array<string | undefined>): string {
  return first + rest.filter((item): item is string => !!item).map((item) => `  ${theme.fg("muted", `· ${item}`)}`).join("");
}

function pretty(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

export function expandedText(theme: CardTheme, args: unknown, result: unknown): string {
  return ["", theme.fg("muted", "调用参数"), pretty(unwrapRequest(args) ?? args), "", theme.fg("muted", "完整结果"), pretty(result)].join("\n");
}

export function failureReason(text: string): string {
  return text.match(/原因：([\s\S]*?)(?:\n建议：|$)/u)?.[1] ?? text.split("\n")[0]!;
}

export function failureLine(theme: CardTheme, text: string): string {
  return theme.fg("error", `失败：${failureReason(text).replace(/\s*\n\s*/gu, " ")}`);
}

export function shortId(id: string): string {
  return id.slice(0, 8);
}

const requirementTitles = new Map<string, string>();

export function noteRequirementTitle(requirementId: unknown, title: unknown): void {
  if (typeof requirementId === "string" && typeof title === "string" && title !== "") requirementTitles.set(requirementId, title);
}

export function requirementLabel(requirementId: unknown): string {
  const id = String(requirementId);
  return requirementTitles.get(id) ?? `需求 ${shortId(id)}`;
}

const exploreQuestions = new Map<string, string>();

export function noteExploreQuestion(runId: unknown, question: unknown): void {
  if (typeof runId === "string" && typeof question === "string" && question !== "") exploreQuestions.set(runId, question);
}

export function exploreLabel(runId: string): string {
  return exploreQuestions.get(runId) ?? `编号 ${shortId(runId)}`;
}

export function repoLabel(repoId: string): string {
  try {
    const repo = windowContext().workspace.repos.find((item) => item.repoId === repoId);
    if (repo) return basename(repo.path);
  } catch {
    // 窗口没启动时查不到仓库目录
  }
  return `仓库 ${shortId(repoId)}`;
}

export interface CardSpec {
  title: string;
  object(request: CardRow, details: CardRow | undefined): string | undefined;
  summary(details: CardRow, theme: CardTheme, request: CardRow): string[];
  note?(request: CardRow, details: CardRow): void;
}
export interface CardTable { actionOf(args: unknown): string | undefined; cards: Readonly<Record<string, CardSpec>> }

type CardContext = { args: unknown; state: { cardHeader?: CardText }; isError: boolean };
type CardResult = { content: Array<{ type: string; text?: string }>; details?: unknown };

export function toolCard(table: CardTable) {
  const specOf = (args: unknown): CardSpec => {
    const key = table.actionOf(args);
    if (key === undefined || !Object.hasOwn(table.cards, key)) throw new Error("not_card");
    return table.cards[key]!;
  };
  const requestOf = (args: unknown): CardRow => (unwrapRequest(args) ?? args ?? {}) as CardRow;
  return {
    renderCall(args: unknown, theme: CardTheme, context: CardContext): CardText {
      const spec = specOf(args);
      context.state.cardHeader = new CardText([cardHeader(theme, spec.title, spec.object(requestOf(args), undefined))]);
      return context.state.cardHeader;
    },
    renderResult(result: CardResult, options: { expanded: boolean; isPartial: boolean }, theme: CardTheme, context: CardContext): CardText {
      if (options.isPartial) return new CardText([]);
      const spec = specOf(context.args);
      const text = result.content.map((block) => block.text ?? "").join("");
      if (context.isError) return new CardText([failureLine(theme, text)], options.expanded ? expandedText(theme, context.args, text) : "");
      const request = requestOf(context.args);
      const details = result.details as CardRow;
      spec.note?.(request, details);
      context.state.cardHeader?.setLines([cardHeader(theme, spec.title, spec.object(request, details))]);
      return new CardText(spec.summary(details, theme, request), options.expanded ? expandedText(theme, context.args, details) : "");
    },
  };
}
