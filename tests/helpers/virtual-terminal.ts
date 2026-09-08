import { TuiMainScreen, stripTerminalSequences, truncateToWidth } from "@earendil-works/pi-tui";
import type { Component, Terminal } from "@earendil-works/pi-tui";

class VirtualTerminal implements Terminal {
  columns: number;
  rows: number;
  buffer = "";
  private onInputHandler: ((data: string) => void) | undefined;

  constructor(columns: number, rows: number) {
    this.columns = columns;
    this.rows = rows;
  }

  start(onInput: (data: string) => void, _onResize: () => void): void {
    this.onInputHandler = onInput;
  }

  stop(): void {}

  async drainInput(): Promise<void> {}

  write(data: string): void {
    this.buffer += data;
  }

  get kittyProtocolActive(): boolean {
    return false;
  }

  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgress(): void {}

  dispatchInput(data: string): void {
    this.onInputHandler?.(data);
  }
}

const CONTROL_TOKEN = /\x1b\[[0-9;?]*[A-Za-z]|\r\n|\r|\n/g;
const CSI_TOKEN = /^\x1b\[([0-9;?]*)([A-Za-z])$/;

function parseScreenLines(raw: string): string[] {
  let lines: string[] = [""];
  let row = 0;
  let lastIndex = 0;
  for (const match of raw.matchAll(CONTROL_TOKEN)) {
    if (match.index > lastIndex) {
      lines[row] += raw.slice(lastIndex, match.index);
    }
    lastIndex = match.index + match[0].length;

    const token = match[0];
    if (token === "\r") continue;
    if (token === "\n" || token === "\r\n") {
      row += 1;
      while (lines.length <= row) lines.push("");
      continue;
    }

    const csi = CSI_TOKEN.exec(token);
    if (!csi) continue;
    const [, params, command] = csi;
    const count = params && /^\d+$/.test(params) ? Number(params) : 1;
    if (command === "A") {
      row = Math.max(0, row - count);
    } else if (command === "B") {
      row += count;
      while (lines.length <= row) lines.push("");
    } else if (command === "K") {
      lines[row] = "";
    } else if (command === "J" || command === "H") {
      lines = [""];
      row = 0;
    }
  }
  if (lastIndex < raw.length) {
    lines[row] += raw.slice(lastIndex);
  }
  return lines;
}

function screenLines(terminal: VirtualTerminal, height: number, width: number): string[] {
  const lines = parseScreenLines(terminal.buffer);
  const visible = lines.slice(Math.max(0, lines.length - height));
  return visible.map((line) => stripTerminalSequences(truncateToWidth(line, width, "", false)));
}

function mountComponent(component: Component, width: number, height: number): { tui: TuiMainScreen; terminal: VirtualTerminal } {
  const terminal = new VirtualTerminal(width, height);
  const tui = new TuiMainScreen(terminal);
  tui.addChild(component);
  tui.setFocus(component);
  tui.start();
  return { tui, terminal };
}

export async function renderComponent(component: Component, width: number, height: number): Promise<string[]> {
  const { tui, terminal } = mountComponent(component, width, height);
  tui.renderNow(true);
  const lines = screenLines(terminal, height, width);
  tui.stop();
  return lines;
}

export async function pressKeys(
  component: Component,
  keys: string[],
  width: number,
  height: number,
): Promise<string[][]> {
  if (keys.length === 0) return [];
  const { tui, terminal } = mountComponent(component, width, height);
  tui.renderNow(true);
  const results: string[][] = [];
  for (const key of keys) {
    terminal.dispatchInput(key);
    tui.renderNow(true);
    results.push(screenLines(terminal, height, width));
  }
  tui.stop();
  return results;
}
