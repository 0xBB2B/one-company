import { isKeyRelease, matchesKey } from "@earendil-works/pi-tui";

export type CaptureMode = "regular" | "fullscreen";

export type DockFocus = "editor" | "panel";

export interface TerminalInputResult {
  consume?: boolean;
  data?: string;
}

export interface TerminalInputSource {
  onInput(handler: (data: string) => TerminalInputResult | undefined): () => void;
}

export interface DockPanel {
  hasRows(): boolean;
  handleInput(data: string): boolean;
}

export interface BottomDockOptions {
  terminalInput?: TerminalInputSource;
  panel?: DockPanel;
  getEditorText(): string;
  isCompletionOpen(): boolean;
  isOverlayOpen(): boolean;
  onFocusChange?(focus: DockFocus): void;
}

export function canCapture(mode: CaptureMode): boolean {
  return mode === "fullscreen";
}

export class BottomDock {
  private readonly options: BottomDockOptions;
  private focusState: DockFocus;
  private pageOpen: boolean;
  private pageOriginFocus: DockFocus;
  private unsubscribe: (() => void) | undefined;

  constructor(options: BottomDockOptions) {
    this.options = options;
    this.focusState = "editor";
    this.pageOpen = false;
    this.pageOriginFocus = "editor";
  }

  focus(): DockFocus {
    return this.focusState;
  }

  attach(): void {
    if (this.unsubscribe || !this.options.terminalInput) return;
    this.unsubscribe = this.options.terminalInput.onInput((data) => this.handleKey(data));
  }

  release(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.setFocus("editor");
  }

  markPageOpen(): void {
    if (this.pageOpen) return;
    this.pageOpen = true;
    this.pageOriginFocus = this.focusState;
  }

  markPageClosed(): void {
    if (!this.pageOpen) return;
    this.pageOpen = false;
    this.setFocus(this.pageOriginFocus);
  }

  handleKey(data: string): TerminalInputResult | undefined {
    if (isKeyRelease(data)) return undefined;
    if (this.options.isOverlayOpen() || this.pageOpen) return undefined;

    if (matchesKey(data, "escape")) {
      if (this.focusState !== "panel") return undefined;
      this.setFocus("editor");
      return { consume: true };
    }

    if (this.focusState === "panel") {
      const panel = this.options.panel;
      if (!panel || !panel.hasRows()) {
        this.setFocus("editor");
        return undefined;
      }
      return panel.handleInput(data) ? { consume: true } : undefined;
    }

    if (matchesKey(data, "down")) {
      const panel = this.options.panel;
      const canEnter = this.options.getEditorText() === "" && !this.options.isCompletionOpen() && !!panel?.hasRows();
      if (!canEnter) return undefined;
      this.setFocus("panel");
      return { consume: true };
    }

    return undefined;
  }

  private setFocus(focus: DockFocus): void {
    if (this.focusState === focus) return;
    this.focusState = focus;
    this.options.onFocusChange?.(focus);
  }
}
