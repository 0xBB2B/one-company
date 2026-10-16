import { describe, expect, test } from "vitest";
import { BottomDock } from "../src/core/host/dock.ts";

const KEY = {
  down: "\x1b[B",
  downKittyRelease: "\x1b[1;1:3B",
  escape: "\x1b",
  escapeKitty: "\x1b[27u",
  escapeKittyRelease: "\x1b[27;1:3u",
  ctrlC: "\x03",
  enter: "\r",
};

type TerminalHandler = (data: string) => { consume?: boolean; data?: string } | undefined;

function createFakeTerminalInputSource() {
  let handler: TerminalHandler | undefined;
  return {
    source: {
      onInput: (h: TerminalHandler) => {
        handler = h;
        return () => {
          if (handler === h) handler = undefined;
        };
      },
    },
    dispatch: (data: string) => handler?.(data),
    hasSubscriber: () => handler !== undefined,
  };
}

// 面板只对自己识别的键（如 ↓/Enter）报告已处理，Ctrl+C 等未知键必须让 dock 据此不消费——不能不论按键一律消费
function createFakePanel(hasRowsInitially: boolean) {
  let rows = hasRowsInitially;
  const handled: string[] = [];
  return {
    panel: {
      hasRows: () => rows,
      handleInput: (data: string): boolean => {
        handled.push(data);
        return data !== KEY.ctrlC;
      },
    },
    handled,
    setHasRows: (value: boolean) => {
      rows = value;
    },
  };
}

function buildDock(
  overrides: {
    editorText?: string;
    completionOpen?: boolean;
    overlayOpen?: boolean;
    hasRows?: boolean;
    noPanel?: boolean;
  } = {},
) {
  const fakePanel = createFakePanel(overrides.hasRows ?? true);
  let editorText = overrides.editorText ?? "";
  let completionOpen = overrides.completionOpen ?? false;
  let overlayOpen = overrides.overlayOpen ?? false;
  const dock = new BottomDock({
    panel: overrides.noPanel ? undefined : fakePanel.panel,
    getEditorText: () => editorText,
    isCompletionOpen: () => completionOpen,
    isOverlayOpen: () => overlayOpen,
  });
  return {
    dock,
    fakePanel,
    setEditorText: (text: string) => {
      editorText = text;
    },
    setCompletionOpen: (value: boolean) => {
      completionOpen = value;
    },
    setOverlayOpen: (value: boolean) => {
      overlayOpen = value;
    },
  };
}

describe("空输入且无遮挡时，↓ 直接进入面板", () => {
  test("↓ 被消费、焦点切到面板，但不执行面板任何操作", () => {
    const { dock, fakePanel } = buildDock();

    const result = dock.handleKey(KEY.down);

    expect(result?.consume).toBe(true);
    expect(dock.focus()).toBe("panel");
    expect(fakePanel.handled).toEqual([]);
  });
});

describe("五种情况下 ↓ 不被消费，焦点保持在输入栏", () => {
  test("输入栏非空时不消费", () => {
    const { dock } = buildDock({ editorText: "abc" });
    expect(dock.handleKey(KEY.down)).toBeUndefined();
    expect(dock.focus()).toBe("editor");
  });

  test("补全菜单打开时不消费", () => {
    const { dock } = buildDock({ completionOpen: true });
    expect(dock.handleKey(KEY.down)).toBeUndefined();
    expect(dock.focus()).toBe("editor");
  });

  test("覆盖层打开时不消费", () => {
    const { dock } = buildDock({ overlayOpen: true });
    expect(dock.handleKey(KEY.down)).toBeUndefined();
    expect(dock.focus()).toBe("editor");
  });

  test("markPageOpen 页面占用时不消费", () => {
    const { dock } = buildDock();
    dock.markPageOpen();
    expect(dock.handleKey(KEY.down)).toBeUndefined();
    expect(dock.focus()).toBe("editor");
  });

  test("面板不存在时不消费", () => {
    const { dock } = buildDock({ noPanel: true });
    expect(dock.handleKey(KEY.down)).toBeUndefined();
    expect(dock.focus()).toBe("editor");
  });

  test("面板存在但无条目时不消费", () => {
    const { dock } = buildDock({ hasRows: false });
    expect(dock.handleKey(KEY.down)).toBeUndefined();
    expect(dock.focus()).toBe("editor");
  });
});

describe("Esc（含 Kitty 协议编码）与条目清空后焦点返回输入栏", () => {
  test("面板聚焦时按传统 Esc 编码返回输入栏", () => {
    const { dock } = buildDock();
    dock.handleKey(KEY.down);
    expect(dock.focus()).toBe("panel");

    const result = dock.handleKey(KEY.escape);
    expect(result?.consume).toBe(true);
    expect(dock.focus()).toBe("editor");
  });

  test("面板聚焦时按 Kitty 协议编码的 Esc 同样返回输入栏", () => {
    const { dock } = buildDock();
    dock.handleKey(KEY.down);
    expect(dock.focus()).toBe("panel");

    const result = dock.handleKey(KEY.escapeKitty);
    expect(result?.consume).toBe(true);
    expect(dock.focus()).toBe("editor");
  });

  test("面板条目全部消失后自动回输入栏", () => {
    const { dock, fakePanel } = buildDock();
    dock.handleKey(KEY.down);
    expect(dock.focus()).toBe("panel");

    fakePanel.setHasRows(false);
    dock.handleKey(KEY.enter);

    expect(dock.focus()).toBe("editor");
  });
});

describe("焦点在面板时按键转交面板，仅当面板报告已处理才消费", () => {
  test("面板识别的键（如 Enter）转交后消费，焦点保持在面板", () => {
    const { dock, fakePanel } = buildDock();
    dock.handleKey(KEY.down);

    const result = dock.handleKey(KEY.enter);

    expect(result?.consume).toBe(true);
    expect(fakePanel.handled).toEqual([KEY.enter]);
    expect(dock.focus()).toBe("panel");
  });

  test("面板未处理的键（Ctrl+C）转交后不被消费", () => {
    const { dock, fakePanel } = buildDock();
    dock.handleKey(KEY.down);

    const result = dock.handleKey(KEY.ctrlC);

    expect(result).toBeUndefined();
    expect(fakePanel.handled).toEqual([KEY.ctrlC]);
  });

  test("输入栏聚焦时按键不转交面板，也不被消费", () => {
    const { dock, fakePanel } = buildDock();

    const result = dock.handleKey(KEY.enter);

    expect(result).toBeUndefined();
    expect(fakePanel.handled).toEqual([]);
    expect(dock.focus()).toBe("editor");
  });
});

describe("markPageOpen/markPageClosed：页面关闭后焦点恢复为打开前的位置", () => {
  test("面板聚焦期间开关页面，关闭后焦点恢复为面板", () => {
    const { dock } = buildDock();
    dock.handleKey(KEY.down);
    expect(dock.focus()).toBe("panel");

    dock.markPageOpen();
    expect(dock.handleKey(KEY.down)).toBeUndefined();
    expect(dock.focus()).toBe("panel");

    dock.markPageClosed();
    expect(dock.focus()).toBe("panel");
  });

  test("输入栏聚焦期间开关页面，关闭后焦点恢复为输入栏", () => {
    const { dock } = buildDock();
    expect(dock.focus()).toBe("editor");

    dock.markPageOpen();
    dock.markPageClosed();

    expect(dock.focus()).toBe("editor");
  });
});

describe("attach/release：注册与卸载原始终端输入监听", () => {
  test("attach 后终端输入驱动 dock，release 后不再拦截且焦点归还输入栏", () => {
    const terminal = createFakeTerminalInputSource();
    const fakePanel = createFakePanel(true);
    const dock = new BottomDock({
      terminalInput: terminal.source,
      panel: fakePanel.panel,
      getEditorText: () => "",
      isCompletionOpen: () => false,
      isOverlayOpen: () => false,
    });

    dock.attach();
    expect(terminal.hasSubscriber()).toBe(true);
    expect(terminal.dispatch(KEY.down)?.consume).toBe(true);
    expect(dock.focus()).toBe("panel");

    dock.release();
    expect(terminal.hasSubscriber()).toBe(false);
    expect(dock.focus()).toBe("editor");
    expect(terminal.dispatch(KEY.escapeKitty)).toBeUndefined();
  });
});

describe("Kitty 协议释放事件一律不消费", () => {
  test("↓ 的释放事件不进入面板，也不消费", () => {
    const { dock } = buildDock();
    const result = dock.handleKey(KEY.downKittyRelease);
    expect(result).toBeUndefined();
    expect(dock.focus()).toBe("editor");
  });

  test("Esc 的释放事件不归还焦点，也不消费", () => {
    const { dock } = buildDock();
    dock.handleKey(KEY.down);
    expect(dock.focus()).toBe("panel");

    const result = dock.handleKey(KEY.escapeKittyRelease);
    expect(result).toBeUndefined();
    expect(dock.focus()).toBe("panel");
  });
});
