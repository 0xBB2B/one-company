import { describe, expect, test, vi } from "vitest";
import { BottomDock } from "../src/core/host/dock.ts";
import { mountPmPanel, PmPanel } from "../src/modules/panel/pm-panel.ts";

const KEY = {
  down: "\x1b[B",
  downKittyRelease: "\x1b[1;1:3B",
  up: "\x1b[A",
  upKitty: "\x1b[1;1:1A",
  upKittyRelease: "\x1b[1;1:3A",
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
  let atFirst = true;
  const handled: string[] = [];
  return {
    panel: {
      hasRows: () => rows,
      atFirstRow: () => atFirst,
      handleInput: (data: string): boolean => {
        handled.push(data);
        return data !== KEY.ctrlC;
      },
    },
    handled,
    setHasRows: (value: boolean) => {
      rows = value;
    },
    setAtFirstRow: (value: boolean) => {
      atFirst = value;
    },
  };
}

function buildDock(
  overrides: {
    editorText?: string;
    completionOpen?: boolean;
    editorFocused?: boolean;
    hasRows?: boolean;
    noPanel?: boolean;
  } = {},
) {
  const fakePanel = createFakePanel(overrides.hasRows ?? true);
  let editorText = overrides.editorText ?? "";
  let completionOpen = overrides.completionOpen ?? false;
  let editorFocused = overrides.editorFocused ?? true;
  const dock = new BottomDock({
    panel: overrides.noPanel ? undefined : fakePanel.panel,
    getEditorText: () => editorText,
    isCompletionOpen: () => completionOpen,
    isEditorFocused: () => editorFocused,
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
    setEditorFocused: (value: boolean) => {
      editorFocused = value;
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

  test("输入框没有焦点（别的窗口开着）时不消费", () => {
    const { dock } = buildDock({ editorFocused: false });
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

describe("面板有可选行时 Esc 被消费且焦点、光标不变", () => {
  test("传统与 Kitty 编码的 Esc 连按三次：每次都消费，焦点留在面板，面板收不到 Esc", () => {
    for (const esc of [KEY.escape, KEY.escapeKitty]) {
      const { dock, fakePanel } = buildDock();
      dock.handleKey(KEY.down);
      expect(dock.focus()).toBe("panel");

      for (let i = 0; i < 3; i++) {
        expect(dock.handleKey(esc)?.consume).toBe(true);
        expect(dock.focus()).toBe("panel");
      }
      expect(fakePanel.handled).toEqual([]);
    }
  });
});

describe("面板光标在第一行时按 ↑ 回到输入栏", () => {
  test("传统与 Kitty 编码的 ↑：消费，焦点回输入栏，面板收不到 ↑", () => {
    for (const up of [KEY.up, KEY.upKitty]) {
      const { dock, fakePanel } = buildDock();
      dock.handleKey(KEY.down);
      expect(dock.focus()).toBe("panel");

      expect(dock.handleKey(up)?.consume).toBe(true);
      expect(dock.focus()).toBe("editor");
      expect(fakePanel.handled).toEqual([]);
    }
  });

  test("↑ 的按键抬起事件不触发，焦点留在面板", () => {
    const { dock } = buildDock();
    dock.handleKey(KEY.down);

    expect(dock.handleKey(KEY.upKittyRelease)).toBeUndefined();
    expect(dock.focus()).toBe("panel");
  });

  test("光标不在第一行时 ↑ 交给面板上移，焦点留在面板", () => {
    const { dock, fakePanel } = buildDock();
    dock.handleKey(KEY.down);
    fakePanel.setAtFirstRow(false);

    expect(dock.handleKey(KEY.up)?.consume).toBe(true);
    expect(fakePanel.handled).toEqual([KEY.up]);
    expect(dock.focus()).toBe("panel");
  });

  test("用 ↑ 回到输入栏后，输入框为空时 ↓ 能再次进入面板", () => {
    const { dock } = buildDock();
    dock.handleKey(KEY.down);
    dock.handleKey(KEY.up);
    expect(dock.focus()).toBe("editor");

    expect(dock.handleKey(KEY.down)?.consume).toBe(true);
    expect(dock.focus()).toBe("panel");
  });
});

describe("焦点在输入栏时 Esc 不被消费", () => {
  test("Esc 交给 pi，面板收不到", () => {
    for (const esc of [KEY.escape, KEY.escapeKitty]) {
      const { dock, fakePanel } = buildDock();
      expect(dock.handleKey(esc)).toBeUndefined();
      expect(fakePanel.handled).toEqual([]);
      expect(dock.focus()).toBe("editor");
    }
  });
});

describe("面板没有可选行时焦点返回输入栏", () => {
  test("Esc 回输入栏并被消费", () => {
    const { dock, fakePanel } = buildDock();
    dock.handleKey(KEY.down);
    fakePanel.setHasRows(false);

    expect(dock.handleKey(KEY.escape)?.consume).toBe(true);
    expect(dock.focus()).toBe("editor");
  });

  test("其他键（Ctrl+C）回输入栏且不消费、交给输入栏", () => {
    const { dock, fakePanel } = buildDock();
    dock.handleKey(KEY.down);
    fakePanel.setHasRows(false);

    expect(dock.handleKey(KEY.ctrlC)).toBeUndefined();
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

describe("别的窗口拿走焦点后，面板对所有按键放行，窗口关闭后焦点恢复", () => {
  test("面板聚焦期间窗口打开，按键全部放行且面板焦点不变，窗口关闭后继续由面板处理", () => {
    const { dock, fakePanel, setEditorFocused } = buildDock();
    dock.handleKey(KEY.down);
    expect(dock.focus()).toBe("panel");

    setEditorFocused(false);
    for (const key of [KEY.down, KEY.up, KEY.enter, "p", KEY.escape, KEY.escapeKitty]) {
      expect(dock.handleKey(key)).toBeUndefined();
    }
    expect(dock.focus()).toBe("panel");
    expect(fakePanel.handled).toEqual([]);

    setEditorFocused(true);
    expect(dock.handleKey(KEY.enter)?.consume).toBe(true);
    expect(fakePanel.handled).toEqual([KEY.enter]);
  });
});

describe("窗口关闭后焦点仍在面板时 Esc 被消费", () => {
  test("窗口开着时 ↑、Esc 放行且焦点不变；窗口关闭后 Esc 被消费、焦点仍在面板", () => {
    const { dock, setEditorFocused } = buildDock();
    dock.handleKey(KEY.down);
    setEditorFocused(false);

    expect(dock.handleKey(KEY.up)).toBeUndefined();
    expect(dock.handleKey(KEY.escape)).toBeUndefined();
    expect(dock.focus()).toBe("panel");

    setEditorFocused(true);
    expect(dock.handleKey(KEY.escape)?.consume).toBe(true);
    expect(dock.focus()).toBe("panel");
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
      isEditorFocused: () => true,
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

describe("真实状态面板：↑ 逐行上移，第一行再按 ↑ 回输入栏", () => {
  function threeRowDock() {
    const panel = new PmPanel({ now: () => 1_000, openItem: () => {}, togglePause: () => {}, openSteps: () => {} } as never);
    const mk = (id: string, goal: string, pendingItems: unknown[]) => ({ repoId: "r", fetchedAt: 1_000, overview: {
      requirementId: id, pmRunId: id, goals: [goal], status: "running", doing: "执行中", turns: 1, toolUses: 1, tokens: 1, cacheRate: null,
      elapsedMs: 0, taskProgress: null, pendingItems, taskRows: [] } as never });
    panel.update([
      mk("01900000-0000-7000-8000-000000000001", "导出", [{ itemId: "task:t1", kind: "adjudicate", label: "待裁决", version: "v1", taskKey: "t1" }]),
      mk("01900000-0000-7000-8000-000000000002", "快跑", []),
    ]);
    const dock = new BottomDock({ panel, getEditorText: () => "", isCompletionOpen: () => false, isEditorFocused: () => true });
    return { dock, panel };
  }

  test("光标在第 3 行：↑ 两次光标到第 1 行、焦点一直在面板，第 3 次 ↑ 回输入栏", () => {
    const { dock, panel } = threeRowDock();
    dock.handleKey(KEY.down);
    panel.focus();
    dock.handleKey(KEY.down);
    dock.handleKey(KEY.down);

    expect(dock.handleKey(KEY.up)?.consume).toBe(true);
    expect(dock.focus()).toBe("panel");
    expect(panel.atFirstRow()).toBe(false);
    expect(dock.handleKey(KEY.up)?.consume).toBe(true);
    expect(dock.focus()).toBe("panel");
    expect(panel.atFirstRow()).toBe(true);

    expect(dock.handleKey(KEY.up)?.consume).toBe(true);
    expect(dock.focus()).toBe("editor");
  });

  test("回到输入栏后输入框为空再按 ↓，焦点再次进入面板", () => {
    const { dock } = threeRowDock();
    dock.handleKey(KEY.down);
    dock.handleKey(KEY.up);
    expect(dock.focus()).toBe("editor");

    dock.handleKey(KEY.down);
    expect(dock.focus()).toBe("panel");
  });
});

describe("真实状态面板：只有检索行时也能进入", () => {
  const mainExplore = { repoId: "r", fetchedAt: 0, explore: { runId: "run-main", source: "local" as const, question: "现在的导出入口在哪", turns: 1, maxTurns: 5, elapsedMs: 0 } };

  function realDock(withExplore: boolean) {
    const panel = new PmPanel({ now: () => 0, openItem: () => {}, togglePause: () => {}, openSteps: () => {} } as never);
    if (withExplore) panel.updateExplores([mainExplore]);
    return new BottomDock({ panel, getEditorText: () => "", isCompletionOpen: () => false, isEditorFocused: () => true });
  }

  test("只有一个主窗口检索时，输入框为空按 ↓ 进入面板", () => {
    const dock = realDock(true);
    expect(dock.handleKey(KEY.down)?.consume).toBe(true);
    expect(dock.focus()).toBe("panel");
  });

  test("什么都没有时，按 ↓ 不进入面板", () => {
    const dock = realDock(false);
    expect(dock.handleKey(KEY.down)).toBeUndefined();
    expect(dock.focus()).toBe("editor");
  });
});

describe("真实状态面板：别的窗口开着时不抢按键", () => {
  const runStats = { turns: 1, maxTurns: 5, elapsedMs: 0 };
  const overview = {
    requirementId: "01900000-0000-7000-8000-000000000001", pmRunId: "01900000-0000-7000-8000-00000000000a", goals: ["导出"],
    status: "running", doing: "执行中", turns: 1, toolUses: 1, tokens: 1, cacheRate: null, elapsedMs: 0, taskProgress: null,
    pendingItems: [{ itemId: "task:t1", kind: "adjudicate", label: "待裁决", version: "v1", taskKey: "t1" }],
    taskRows: [
      { kind: "pending", itemId: "task:t1", taskKey: "t1", text: "待裁决" },
      { kind: "execute", runId: "run-w1", taskKey: "t2", agent: "worker", attempt: 1, ...runStats },
    ],
  };

  function setup() {
    const openItem = vi.fn(), openSteps = vi.fn(), togglePause = vi.fn();
    const panel = new PmPanel({ now: () => 0, openItem, openSteps, togglePause });
    panel.update([{ repoId: "r", overview: overview as never, fetchedAt: 0 }]);
    let editorFocused = true;
    const dock = new BottomDock({ panel, getEditorText: () => "", isCompletionOpen: () => false, isEditorFocused: () => editorFocused });
    return { dock, openItem, openSteps, togglePause, setEditorFocused: (value: boolean) => { editorFocused = value; } };
  }

  test("提问窗口开着、输入框为空：↓ ↓ Enter p Esc 全部放行，面板不获得焦点也不触发动作", () => {
    const t = setup();
    t.setEditorFocused(false);

    for (const key of [KEY.down, KEY.down, KEY.enter, "p", KEY.escape]) {
      expect(t.dock.handleKey(key)).toBeUndefined();
    }

    expect(t.dock.focus()).toBe("editor");
    expect(t.openItem).not.toHaveBeenCalled();
    expect(t.openSteps).not.toHaveBeenCalled();
    expect(t.togglePause).not.toHaveBeenCalled();
  });

  test("面板光标在子代理行时窗口打开：按键放行、动作不触发；窗口关闭后 Enter 打开的仍是原来那一行", () => {
    const t = setup();
    t.dock.handleKey(KEY.down);
    t.dock.handleKey(KEY.down);
    t.dock.handleKey(KEY.down);
    expect(t.dock.focus()).toBe("panel");

    t.setEditorFocused(false);
    for (const key of [KEY.down, KEY.up, KEY.up, KEY.enter, "p", KEY.escape]) {
      expect(t.dock.handleKey(key)).toBeUndefined();
    }
    expect(t.dock.focus()).toBe("panel");
    expect(t.openItem).not.toHaveBeenCalled();
    expect(t.openSteps).not.toHaveBeenCalled();
    expect(t.togglePause).not.toHaveBeenCalled();

    t.setEditorFocused(true);
    expect(t.dock.handleKey(KEY.enter)?.consume).toBe(true);
    expect(t.openSteps).toHaveBeenCalledWith(expect.objectContaining({ runId: "run-w1" }));
    expect(t.openItem).not.toHaveBeenCalled();
  });

  test("窗口关闭、输入框重新拿到焦点后，输入框为空按 ↓ 照旧进入面板", () => {
    const t = setup();
    t.setEditorFocused(false);
    expect(t.dock.handleKey(KEY.down)).toBeUndefined();

    t.setEditorFocused(true);
    expect(t.dock.handleKey(KEY.down)?.consume).toBe(true);
    expect(t.dock.focus()).toBe("panel");
  });
});

describe("mountPmPanel 的 host.isEditorFocused", () => {
  function mount(focused: unknown) {
    let factory: ((tui: unknown, theme: unknown) => unknown) | undefined;
    const mounted = mountPmPanel(
      { mode: "tui", hasUI: true, ui: { setWidget: ((_key: string, f: never) => { factory = f; }) as never } },
      { now: () => 0, openItem: () => {}, togglePause: () => {}, openSteps: () => {} },
    )!;
    factory!({ getFocusedComponent: () => focused, requestRender: () => {} }, {});
    return mounted.host;
  }

  test("焦点组件带 isShowingAutocomplete 方法（输入框）时为 true，补全菜单是否打开不影响", () => {
    expect(mount({ isShowingAutocomplete: () => false }).isEditorFocused()).toBe(true);
    expect(mount({ isShowingAutocomplete: () => true }).isEditorFocused()).toBe(true);
  });

  test("焦点组件是普通对象时为 false", () => {
    expect(mount({ render: () => [] }).isEditorFocused()).toBe(false);
  });

  test("没有焦点组件时为 false", () => {
    expect(mount(null).isEditorFocused()).toBe(false);
  });
});
