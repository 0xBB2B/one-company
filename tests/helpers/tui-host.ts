import { Container, Editor, Spacer, Text, TuiMainScreen, stripTerminalSequences, truncateToWidth } from "@earendil-works/pi-tui";
import type { Component, EditorTheme, Terminal, TUI } from "@earendil-works/pi-tui";

// pi 只在 ProcessTerminal 上运行；集成测试需要一个把所有输出留在内存、按键由测试注入的终端
class HeadlessTerminal implements Terminal {
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

export interface TuiHostTheme {
  fg(kind: string, text: string): string;
  bg(kind: string, text: string): string;
}

interface EditorLike extends Component {
  getText(): string;
  setText(text: string): void;
  getExpandedText?(): string;
}

type WidgetFactory = (tui: TUI, theme: TuiHostTheme) => Component & { dispose?(): void };
type EditorFactory = (tui: TUI, theme: EditorTheme, keybindings: unknown) => EditorLike;
type CustomFactory<T> = (
  tui: TUI,
  theme: TuiHostTheme,
  keybindings: unknown,
  done: (result: T) => void,
) => (Component & { dispose?(): void }) | Promise<Component & { dispose?(): void }>;

export interface TuiHostNotice {
  message: string;
  level?: string;
}

export interface TuiHostUi {
  notify(message: string, level?: string): void;
  onTerminalInput(handler: (data: string) => { consume?: boolean; data?: string } | undefined): () => void;
  setStatus(key: string, text: string | undefined): void;
  setWidget(key: string, content: unknown, options?: { placement?: string }): void;
  custom<T>(factory: CustomFactory<T>, options?: { overlay?: boolean }): Promise<T>;
  setEditorComponent(factory: unknown): void;
  setEditorText(text: string): void;
  getEditorText(): string;
  readonly theme: TuiHostTheme;
}

export interface TuiHostOptions {
  columns?: number;
  rows?: number;
  cwd: string;
  theme?: TuiHostTheme;
}

export interface TuiHost {
  tui: TuiMainScreen;
  ui: TuiHostUi;
  notices: TuiHostNotice[];
  press(data: string): void;
  screen(): string[];
  stop(): void;
}

const FOOTER_PWD_PREFIX = "cwd ";
const FOOTER_STATS_LINE = "controlled-model · 0% ctx";

// 与 pi 内建 footer 一致：两行固定内容，之后仅当有扩展状态时追加一行按键名排序、空格拼接的状态文本
class HostFooter implements Component {
  private readonly cwd: string;
  private readonly statuses = new Map<string, string>();

  constructor(cwd: string) {
    this.cwd = cwd;
  }

  setStatus(key: string, text: string | undefined): void {
    if (text === undefined) this.statuses.delete(key);
    else this.statuses.set(key, text);
  }

  render(width: number): string[] {
    const lines = [truncateToWidth(`${FOOTER_PWD_PREFIX}${this.cwd}`, width, "..."), FOOTER_STATS_LINE];
    if (this.statuses.size > 0) {
      const statusLine = Array.from(this.statuses.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([, text]) => text)
        .join(" ");
      lines.push(truncateToWidth(statusLine, width, "..."));
    }
    return lines;
  }

  invalidate(): void {}
}

function passthroughTheme(): TuiHostTheme {
  return { fg: (_kind, text) => text, bg: (_kind, text) => text };
}

function editorTheme(): EditorTheme {
  const identity = (text: string) => text;
  return {
    borderColor: identity,
    selectList: { selectedPrefix: identity, selectedText: identity, description: identity, scrollInfo: identity, noMatch: identity },
  };
}

// 按 pi 0.85.1 交互模式的 ExtensionUIContext 语义复刻宿主：组件树顺序、
// 扩展终端输入监听先于焦点组件、belowEditor 部件与 footer 的相对位置、custom/setEditorComponent 对输入栏的替换与恢复
export function createTuiHost(options: TuiHostOptions): TuiHost {
  const columns = options.columns ?? 120;
  const rows = options.rows ?? 40;
  const theme = options.theme ?? passthroughTheme();
  const terminal = new HeadlessTerminal(columns, rows);
  const tui = new TuiMainScreen(terminal);

  const chatContainer = new Container();
  const statusContainer = new Container();
  const widgetsAbove = new Container();
  const editorContainer = new Container();
  const widgetsBelow = new Container();
  const footerContainer = new Container();
  const footer = new HostFooter(options.cwd);
  footerContainer.addChild(footer);

  const widgetsAboveMap = new Map<string, Component & { dispose?(): void }>();
  const widgetsBelowMap = new Map<string, Component & { dispose?(): void }>();

  const defaultEditor = new Editor(tui, editorTheme());
  let editor: EditorLike = defaultEditor;
  editorContainer.addChild(editor);

  for (const child of [chatContainer, statusContainer, widgetsAbove, editorContainer, widgetsBelow, footerContainer]) {
    tui.addChild(child);
  }

  function renderWidgetContainer(
    container: Container,
    widgets: Map<string, Component>,
    spacerWhenEmpty: boolean,
    leadingSpacer: boolean,
  ): void {
    container.clear();
    if (widgets.size === 0) {
      if (spacerWhenEmpty) container.addChild(new Spacer(1));
      return;
    }
    if (leadingSpacer) container.addChild(new Spacer(1));
    for (const component of widgets.values()) container.addChild(component);
  }

  function renderWidgets(): void {
    renderWidgetContainer(widgetsAbove, widgetsAboveMap, true, true);
    renderWidgetContainer(widgetsBelow, widgetsBelowMap, false, false);
    tui.requestRender();
  }

  const notices: TuiHostNotice[] = [];

  const ui: TuiHostUi = {
    notify: (message, level) => {
      notices.push({ message, level });
    },
    onTerminalInput: (handler) => tui.addInputListener(handler),
    setStatus: (key, text) => footer.setStatus(key, text),
    setWidget: (key, content, widgetOptions) => {
      const placement = widgetOptions?.placement ?? "aboveEditor";
      for (const map of [widgetsAboveMap, widgetsBelowMap]) {
        map.get(key)?.dispose?.();
        map.delete(key);
      }
      if (content === undefined) {
        renderWidgets();
        return;
      }
      let component: Component & { dispose?(): void };
      if (Array.isArray(content)) {
        const container = new Container();
        for (const line of content as string[]) container.addChild(new Text(line, 1, 0));
        component = container;
      } else {
        component = (content as WidgetFactory)(tui, theme);
      }
      (placement === "belowEditor" ? widgetsBelowMap : widgetsAboveMap).set(key, component);
      renderWidgets();
    },
    custom: <T>(factory: CustomFactory<T>, customOptions?: { overlay?: boolean }): Promise<T> => {
      if (customOptions?.overlay) throw new Error("宿主复刻不覆盖浮层模式");
      const savedText = editor.getText();
      const restoreEditor = () => {
        editorContainer.clear();
        editorContainer.addChild(editor);
        editor.setText(savedText);
        tui.setFocus(editor);
        tui.requestRender();
      };
      return new Promise<T>((resolve, reject) => {
        let component: (Component & { dispose?(): void }) | undefined;
        let closed = false;
        const close = (result: T) => {
          if (closed) return;
          closed = true;
          restoreEditor();
          resolve(result);
          component?.dispose?.();
        };
        Promise.resolve(factory(tui, theme, {}, close))
          .then((created) => {
            if (closed) return;
            component = created;
            editorContainer.clear();
            editorContainer.addChild(component);
            tui.setFocus(component);
            tui.requestRender();
          })
          .catch((error: unknown) => {
            if (closed) return;
            restoreEditor();
            reject(error);
          });
      });
    },
    setEditorComponent: (factory) => {
      const currentText = editor.getText();
      editorContainer.clear();
      if (factory) {
        const created = (factory as EditorFactory)(tui, editorTheme(), {});
        created.setText(currentText);
        editor = created;
      } else {
        editor = defaultEditor;
        editor.setText(currentText);
      }
      editorContainer.addChild(editor);
      tui.setFocus(editor);
      tui.requestRender();
    },
    setEditorText: (text) => editor.setText(text),
    getEditorText: () => editor.getExpandedText?.() ?? editor.getText(),
    get theme() {
      return theme;
    },
  };

  tui.start();
  renderWidgets();
  tui.setFocus(editor);

  return {
    tui,
    ui,
    notices,
    press: (data) => terminal.dispatchInput(data),
    screen: () => tui.render(columns).map((line) => stripTerminalSequences(line)),
    stop: () => tui.stop(),
  };
}
