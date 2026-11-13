import { expect } from "vitest";

export const markTheme = { fg: (kind: string, text: string) => `<${kind}>${text}</>`, bold: (text: string) => `<b>${text}</b>`, bg: (_kind: string, text: string) => text };
export const plainTheme = { fg: (_kind: string, text: string) => text, bold: (text: string) => text, bg: (_kind: string, text: string) => text };

export type CardTool = {
  renderCall?(args: never, theme: never, context: never): { render(width: number): string[] };
  renderResult?(result: never, options: { expanded: boolean; isPartial: boolean }, theme: never, context: never): { render(width: number): string[] };
};
export type CardResult = { content: Array<{ type: "text"; text: string }>; details?: unknown };
export type DrawOptions = { expanded?: boolean; isError?: boolean; isPartial?: boolean; theme?: typeof markTheme; width?: number };

export const seen: Array<{ lines: string[]; collapsed: boolean }> = [];

export function render(tool: CardTool, args: unknown, result?: CardResult, options: DrawOptions = {}): string[] {
  const { expanded = false, isError = false, isPartial = false, theme = markTheme, width = 80 } = options;
  const context = { args, state: {} as Record<string, unknown>, isError, expanded, isPartial, invalidate: () => {} } as never;
  const lines = (): string[] => [
    ...tool.renderCall!(args as never, theme as never, context).render(width),
    ...(result ? tool.renderResult!(result as never, { expanded, isPartial }, theme as never, context).render(width) : []),
  ].map((line) => line.trimEnd());
  lines();
  return lines();
}

export function draw(tool: CardTool, args: unknown, result?: CardResult, options: DrawOptions = {}): string[] {
  const before = structuredClone({ args, result });
  const out = render(tool, args, result, options);
  if (result) {
    render(tool, args, result, { ...options, expanded: true });
    render(tool, args, result, { ...options, expanded: false });
  }
  expect({ args, result }).toEqual(before);
  seen.push({ lines: out, collapsed: !options.expanded });
  return out;
}

export const ok = (details: unknown): CardResult => ({ content: [{ type: "text", text: "给模型的内容" }], details });
