import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, matchesKey, renderFakeCursor, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

type EditorArgs = ConstructorParameters<typeof CustomEditor>;

export class SuggestionEditor extends CustomEditor {
  private suggestion: string | undefined;

  constructor(tui: EditorArgs[0], theme: EditorArgs[1], keybindings: EditorArgs[2], private readonly dim: (text: string) => string) {
    super(tui, theme, keybindings);
  }

  setSuggestion(suggestion: string | undefined): void {
    this.suggestion = suggestion;
    this.tui.requestRender();
  }

  render(width: number): string[] {
    const lines = super.render(width);
    if (!this.suggestion || this.getText() !== "") return lines;
    const padding = Math.min(this.getPaddingX(), Math.max(0, Math.floor((width - 1) / 2)));
    const contentWidth = Math.max(1, width - padding * 2);
    const first = graphemes.segment(this.suggestion)[Symbol.iterator]().next().value?.segment ?? "";
    const rest = truncateToWidth(this.suggestion.slice(first.length), Math.max(0, contentWidth - visibleWidth(first)), "…");
    const body = `${this.focused ? CURSOR_MARKER : ""}${renderFakeCursor(first)}${this.dim(rest)}`;
    const fill = " ".repeat(Math.max(0, contentWidth - visibleWidth(first) - visibleWidth(rest)));
    lines[1] = `${" ".repeat(padding)}${body}${fill}${" ".repeat(padding)}`;
    return lines;
  }

  handleInput(data: string): void {
    if (this.suggestion && this.getText() === "" && matchesKey(data, "right")) {
      this.setText(this.suggestion);
      return;
    }
    super.handleInput(data);
  }
}
