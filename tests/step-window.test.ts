import { describe, expect, test, vi } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createClock } from "../src/core/policy/clock.ts";
import type { TimeSource } from "../src/core/policy/clock.ts";
import { StepWindow, openStepWindow } from "../src/modules/panel/step-window.ts";
import { formatElapsed } from "../src/modules/panel/pm-panel.ts";

type Status = "running" | "done" | "error";
interface Step { id: string; parentId?: string; text: string; status: Status }
type State = "queued" | "running" | "pausing" | "paused" | "completed" | "failed" | "stopped" | "interrupted";
interface View { state: State; reason?: string; turns: number; maxTurns: number | null; elapsedMs: number; steps: Step[] }

const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const UP = "\x1b[A";
const DOWN = "\x1b[B";
const ESC = "\x1b";

function view(partial: Partial<View> = {}): View {
  return { state: "running", turns: 9, maxTurns: 40, elapsedMs: 185000, steps: [], ...partial };
}

function steps(n: number, status: Status = "done"): Step[] {
  return Array.from({ length: n }, (_, i) => ({ id: `s${i + 1}`, text: `步骤 ${i + 1}`, status }));
}

function make(opts: { now?: () => number; onClose?: () => void } = {}) {
  return new StepWindow({ title: "T2 执行 · worker（第 1 次尝试）", now: opts.now ?? (() => 0), onClose: opts.onClose ?? (() => {}) });
}

function statusLine(w: StepWindow): string {
  return w.render(80)[2]!;
}

function stepArea(w: StepWindow): string[] {
  const lines = w.render(80);
  const dividers = lines.map((l, i) => (l.startsWith("├") ? i : -1)).filter((i) => i >= 0);
  return lines.slice(dividers[0]! + 1, dividers[1]!);
}

describe("步骤窗口：状态行", () => {
  test("running 13 步：转圈 运行中 · 共 13 步 · ↻9/40 · 3m5s", () => {
    expect(formatElapsed(185000)).toBe("3m5s");
    const w = make();
    w.apply(view({ steps: steps(13) }));
    expect(statusLine(w)).toBe(`│ ${SPIN[0]} 运行中 · 共 13 步 · ↻9/40 · 3m5s`);
  });

  test("maxTurns 为 null 时只写 ↻9", () => {
    const w = make();
    w.apply(view({ maxTurns: null, steps: steps(2) }));
    expect(statusLine(w)).toBe(`│ ${SPIN[0]} 运行中 · 共 2 步 · ↻9 · 3m5s`);
  });

  test.each([
    ["queued", `${SPIN[0]} 运行中`],
    ["running", `${SPIN[0]} 运行中`],
    ["pausing", "⏸ 已暂停"],
    ["paused", "⏸ 已暂停"],
    ["completed", "✓ 已完成"],
    ["stopped", "✗ 已停止"],
    ["interrupted", "✗ 已中断"],
  ] as const)("状态 %s 的图标和文字", (state, expected) => {
    const w = make();
    w.apply(view({ state, steps: steps(1) }));
    expect(statusLine(w)).toBe(`│ ${expected} · 共 1 步 · ↻9/40 · 3m5s`);
  });

  test("failed 带原因", () => {
    const w = make();
    w.apply(view({ state: "failed", reason: "超过轮数上限", steps: steps(1) }));
    expect(statusLine(w)).toBe("│ ✗ 失败：超过轮数上限 · 共 1 步 · ↻9/40 · 3m5s");
  });

  test.each(["pausing", "paused", "completed", "failed", "stopped", "interrupted"] as const)("非运行中状态 %s：now 前进耗时不变", (state) => {
    let now = 1000;
    const w = make({ now: () => now });
    w.apply(view({ state, reason: "x" }));
    const before = statusLine(w);
    now += 60000;
    expect(statusLine(w)).toBe(before);
  });

  test.each(["queued", "running"] as const)("%s 时 now 前进 2000 毫秒耗时增加 2 秒", (state) => {
    let now = 1000;
    const w = make({ now: () => now });
    w.apply(view({ state, elapsedMs: 4200, steps: steps(1) }));
    expect(statusLine(w)).toContain("· 4.2s");
    now += 2000;
    expect(statusLine(w)).toContain("· 6.2s");
  });

  test("标题原样显示在首行内容", () => {
    const w = make();
    w.apply(view());
    expect(w.render(80)[1]).toBe("│ T2 执行 · worker（第 1 次尝试）");
  });

  test("转圈图标每 tick 换一帧", () => {
    const w = make();
    w.apply(view({ steps: steps(1) }));
    w.tick();
    expect(statusLine(w)).toContain(`${SPIN[1]} 运行中`);
    w.tick();
    expect(statusLine(w)).toContain(`${SPIN[2]} 运行中`);
  });
});

describe("步骤窗口：布局与步骤行", () => {
  test("80 列骨架：横线铺满宽度，内容行以 │ 开头", () => {
    const w = make();
    w.apply(view({ state: "completed", steps: steps(1) }));
    const lines = w.render(80);
    expect(lines[0]).toBe(`╭${"─".repeat(79)}`);
    expect(lines.filter((l) => l.startsWith("├"))).toEqual([`├${"─".repeat(79)}`, `├${"─".repeat(79)}`]);
    expect(lines.at(-1)).toBe(`╰${"─".repeat(79)}`);
    expect(stepArea(w)).toEqual(["│ ✓ 步骤 1"]);
  });

  test("done / error / running 三步在 running、paused、stopped 下的图标", () => {
    const three: Step[] = [
      { id: "a", text: "读计划", status: "done" },
      { id: "b", text: "跑命令", status: "error" },
      { id: "c", text: "写入文件", status: "running" },
    ];
    const expected: Record<string, string> = { running: SPIN[0]!, paused: "⏸", stopped: "✗" };
    for (const state of ["running", "paused", "stopped"] as const) {
      const w = make();
      w.apply(view({ state, steps: three }));
      expect(stepArea(w).slice(0, 3)).toEqual(["│ ✓ 读计划", "│ ✗ 跑命令", `│ ${expected[state]} 写入文件`]);
    }
  });

  test("running 且没有 running 步骤时末尾多一行思考中", () => {
    const w = make();
    w.apply(view({ steps: steps(2) }));
    expect(stepArea(w)).toEqual(["│ ✓ 步骤 1", "│ ✓ 步骤 2", `│ ${SPIN[0]} 思考中`]);
  });

  test("有 running 步骤时没有思考中", () => {
    const w = make();
    w.apply(view({ steps: [{ id: "a", text: "写入", status: "running" }] }));
    expect(stepArea(w).join("\n")).not.toContain("思考中");
  });

  test("0 步 running：步骤区只有思考中，状态行共 0 步", () => {
    const w = make();
    w.apply(view({ steps: [] }));
    expect(stepArea(w)).toEqual([`│ ${SPIN[0]} 思考中`]);
    expect(statusLine(w)).toContain("共 0 步");
  });

  test("paused 时没有思考中", () => {
    const w = make();
    w.apply(view({ state: "paused", steps: steps(1) }));
    expect(stepArea(w).join("\n")).not.toContain("思考中");
  });

  test("codemode 子步骤缩进两格紧跟父步骤，后面的普通步骤不缩进", () => {
    const w = make();
    w.apply(view({
      state: "completed",
      steps: [
        { id: "p", text: "代码模式", status: "done" },
        { id: "c1", parentId: "p", text: "读文件", status: "done" },
        { id: "c2", parentId: "p", text: "写文件", status: "error" },
        { id: "n", text: "收尾", status: "done" },
      ],
    }));
    expect(stepArea(w)).toEqual(["│ ✓ 代码模式", "│   ✓ 读文件", "│   ✗ 写文件", "│ ✓ 收尾"]);
    expect(statusLine(w)).toContain("共 4 步");
  });

  test("80 列下每行可见宽度不超过 80，200 字符步骤以 … 结尾", () => {
    const w = make();
    w.apply(view({ state: "completed", steps: [{ id: "a", text: "长".repeat(200), status: "done" }] }));
    const lines = w.render(80);
    for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(80);
    const long = stepArea(w)[0]!;
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("步骤窗口：滚动", () => {
  function displayed(w: StepWindow): number[] {
    return stepArea(w)
      .map((l) => /^│ ✓ 步骤 (\d+)$/.exec(l)?.[1])
      .filter((v): v is string => v !== undefined)
      .map(Number);
  }

  test("步骤区行数 = 终端行数 − 8：28 行终端 20 行；打开时显示在最底下", () => {
    const w = make();
    w.resize(80, 28);
    w.apply(view({ state: "completed", steps: steps(60) }));
    const area = stepArea(w);
    expect(area).toHaveLength(20);
    expect(area.at(-1)).toBe("│ ✓ 步骤 60");
    expect(area[0]).toMatch(/^│ ↑ 上面还有 \d+ 步$/);
  });

  test("终端行数很小时步骤区至少 3 行", () => {
    const w = make();
    w.resize(80, 10);
    w.apply(view({ state: "completed", steps: steps(20) }));
    expect(stepArea(w)).toHaveLength(3);
  });

  test("↑ 10 次后两端提示，N + M + 中间步数 = 60", () => {
    const w = make();
    w.resize(80, 28);
    w.apply(view({ state: "completed", steps: steps(60) }));
    for (let i = 0; i < 10; i++) w.handleInput(UP);
    const area = stepArea(w);
    const up = /^│ ↑ 上面还有 (\d+) 步$/.exec(area[0]!);
    const down = /^│ ↓ 下面还有 (\d+) 步$/.exec(area.at(-1)!);
    expect(up).not.toBeNull();
    expect(down).not.toBeNull();
    const mid = displayed(w).length;
    expect(Number(up![1]) + Number(down![1]) + mid).toBe(60);
    expect(Number(down![1])).toBeGreaterThan(0);
  });

  test("↓ 每次滚一行", () => {
    const w = make();
    w.resize(80, 28);
    w.apply(view({ state: "completed", steps: steps(60) }));
    for (let i = 0; i < 10; i++) w.handleInput(UP);
    const before = displayed(w);
    w.handleInput(DOWN);
    expect(displayed(w)[0]).toBe(before[0]! + 1);
  });

  test("往上翻后 apply 新步骤：中间步骤不跳，下面还有加 1；翻回最底下后恢复自动跟随", () => {
    const w = make();
    w.resize(80, 28);
    w.apply(view({ state: "completed", steps: steps(60) }));
    for (let i = 0; i < 10; i++) w.handleInput(UP);
    const midBefore = displayed(w);
    const m0 = Number(/(\d+)/.exec(stepArea(w).at(-1)!)![1]);
    w.apply(view({ state: "completed", steps: steps(61) }));
    expect(displayed(w)).toEqual(midBefore);
    expect(Number(/(\d+)/.exec(stepArea(w).at(-1)!)![1])).toBe(m0 + 1);

    for (let i = 0; i < 40; i++) w.handleInput(DOWN);
    w.apply(view({ state: "completed", steps: steps(62) }));
    expect(stepArea(w).at(-1)).toBe("│ ✓ 步骤 62");
  });

  test("在最底下时 apply 新步骤自动滚到最新", () => {
    const w = make();
    w.resize(80, 28);
    w.apply(view({ state: "completed", steps: steps(60) }));
    w.apply(view({ state: "completed", steps: steps(61) }));
    expect(stepArea(w).at(-1)).toBe("│ ✓ 步骤 61");
  });
});

describe("步骤窗口：读取中、失败与底部提示", () => {
  test("没 apply 过：状态行读取中…，步骤区空，底部 Esc 关闭", () => {
    const w = make();
    const lines = w.render(80);
    expect(lines[2]).toBe("│ 读取中…");
    expect(stepArea(w)).toEqual([]);
    expect(lines.at(-2)).toBe("│ Esc 关闭");
    expect(w.finished()).toBe(false);
  });

  test("fail 后状态行、说明行、底部提示，finished 为 true", () => {
    const w = make();
    w.fail("连不上守护进程");
    const lines = w.render(80);
    expect(lines[2]).toBe("│ ✗ 读不到步骤：连不上守护进程");
    expect(stepArea(w)).toEqual(["│ 守护进程重启后，之前的步骤就没有了。"]);
    expect(lines.at(-2)).toBe("│ Esc 关闭");
    expect(w.finished()).toBe(true);
  });

  test.each([
    ["completed", true], ["failed", true], ["stopped", true], ["interrupted", true],
    ["queued", false], ["running", false], ["pausing", false], ["paused", false],
  ] as const)("状态 %s 的 finished 为 %s", (state, expected) => {
    const w = make();
    w.apply(view({ state }));
    expect(w.finished()).toBe(expected);
  });

  test("有数据时底部是 ↑↓ 滚动 · Esc 关闭", () => {
    const w = make();
    w.apply(view({ steps: steps(1) }));
    expect(w.render(80).at(-2)).toBe("│ ↑↓ 滚动 · Esc 关闭");
  });

  test("Esc 调用 onClose", () => {
    const onClose = vi.fn();
    const w = make({ onClose });
    w.apply(view());
    w.handleInput(ESC);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

interface FakeTimeSource extends TimeSource {
  advance(ms: number): void;
}

function createFakeTimeSource(): FakeTimeSource {
  let current = 0;
  let nextId = 1;
  const timers = new Map<number, { fireAt: number; fn: () => void }>();
  return {
    now: () => current,
    setTimeout: (fn: () => void, ms: number): unknown => {
      const id = nextId++;
      timers.set(id, { fireAt: current + ms, fn });
      return id;
    },
    clearTimeout: (handle: unknown): void => { timers.delete(handle as number); },
    advance(ms: number): void {
      const target = current + ms;
      while (true) {
        let earliestId: number | undefined;
        let earliestFireAt = Infinity;
        for (const [id, entry] of timers) {
          if (entry.fireAt <= target && entry.fireAt < earliestFireAt) {
            earliestId = id;
            earliestFireAt = entry.fireAt;
          }
        }
        if (earliestId === undefined) break;
        const entry = timers.get(earliestId);
        timers.delete(earliestId);
        current = earliestFireAt;
        entry?.fn();
      }
      current = target;
    },
  };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("openStepWindow：取数、定时器与关闭", () => {
  function fakeCtx() {
    let component: { render(w: number): string[]; handleInput(d: string): void } | undefined;
    let options: Record<string, unknown> | undefined;
    return {
      ctx: {
        ui: {
          custom: (
            factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (result: unknown) => void) => unknown,
            opts?: Record<string, unknown>,
          ) => {
            options = opts;
            return new Promise((resolve) => {
              component = factory({ requestRender: () => {} }, {}, {}, (r) => resolve(r)) as typeof component;
            });
          },
        },
      },
      component: () => component,
      options: () => options,
    };
  }

  function setup(call: (method: string, params: Record<string, unknown>) => Promise<Record<string, unknown>>) {
    const timeSource = createFakeTimeSource();
    const clock = createClock({ timeSource });
    const fc = fakeCtx();
    const dock = { markPageOpen: vi.fn(), markPageClosed: vi.fn() };
    const client = { call: vi.fn(call) };
    const promise = openStepWindow({ ctx: fc.ctx, dock, clock, client, runId: "run-1", title: "标题" });
    return { timeSource, clock, fc, dock, client, promise };
  }

  const runningView = () => view({ steps: steps(1) }) as unknown as Record<string, unknown>;

  test("打开后标记 markPageOpen、非浮层挂载、立即取一次数（参数 runId）", async () => {
    const t = setup(async () => runningView());
    await flush();
    expect(t.fc.options()?.overlay).toBeFalsy();
    expect(t.dock.markPageOpen).toHaveBeenCalledTimes(1);
    expect(t.client.call).toHaveBeenCalledTimes(1);
    expect(t.client.call).toHaveBeenCalledWith("runs.steps", { runId: "run-1" });
    expect(t.fc.component()!.render(80).join("\n")).toContain("共 1 步");
    t.fc.component()!.handleInput(ESC);
    await t.promise;
    t.clock.stopGapWatcher();
  });

  test("推进 500 毫秒再取一次数", async () => {
    const t = setup(async () => runningView());
    await flush();
    t.timeSource.advance(500);
    await flush();
    expect(t.client.call).toHaveBeenCalledTimes(2);
    t.fc.component()!.handleInput(ESC);
    await t.promise;
    t.clock.stopGapWatcher();
  });

  test("上一次取数没回来时跳过", async () => {
    const t = setup(() => new Promise(() => {}));
    await flush();
    t.timeSource.advance(1500);
    await flush();
    expect(t.client.call).toHaveBeenCalledTimes(1);
    t.fc.component()!.handleInput(ESC);
    await t.promise;
    t.clock.stopGapWatcher();
  });

  test("每 200 毫秒动画一帧", async () => {
    const t = setup(async () => runningView());
    await flush();
    t.timeSource.advance(200);
    expect(t.fc.component()!.render(80)[2]).toContain(`${SPIN[1]} 运行中`);
    t.fc.component()!.handleInput(ESC);
    await t.promise;
    t.clock.stopGapWatcher();
  });

  test("返回 completed 后停止取数，窗口保留最后的内容", async () => {
    const t = setup(async () => view({ state: "completed", steps: steps(3) }) as unknown as Record<string, unknown>);
    await flush();
    t.timeSource.advance(5000);
    await flush();
    expect(t.client.call).toHaveBeenCalledTimes(1);
    expect(t.fc.component()!.render(80).join("\n")).toContain("✓ 已完成");
    t.fc.component()!.handleInput(ESC);
    await t.promise;
    t.clock.stopGapWatcher();
  });

  test("取数抛错后停止取数，窗口显示读不到步骤", async () => {
    const t = setup(async () => { throw new Error("连不上守护进程"); });
    await flush();
    t.timeSource.advance(5000);
    await flush();
    expect(t.client.call).toHaveBeenCalledTimes(1);
    expect(t.fc.component()!.render(80).join("\n")).toContain("✗ 读不到步骤：连不上守护进程");
    t.fc.component()!.handleInput(ESC);
    await t.promise;
    t.clock.stopGapWatcher();
  });

  test("按 Esc 后 Promise resolve、markPageOpen/markPageClosed 各一次、之后不再取数", async () => {
    const t = setup(async () => runningView());
    await flush();
    t.fc.component()!.handleInput(ESC);
    await t.promise;
    const callsAtClose = t.client.call.mock.calls.length;
    t.timeSource.advance(5000);
    await flush();
    expect(t.client.call).toHaveBeenCalledTimes(callsAtClose);
    expect(t.dock.markPageOpen).toHaveBeenCalledTimes(1);
    expect(t.dock.markPageClosed).toHaveBeenCalledTimes(1);
    t.clock.stopGapWatcher();
  });
});

describe("步骤窗口：出错后的底部提示、思考中不计入剩余步数、颜色与预览一致", () => {
  const tag = { fg: (kind: string, text: string) => `<${kind}>${text}</${kind}>` };

  test("先读到数据、之后取数失败：底部是 Esc 关闭，↑↓ 不再滚动", () => {
    const w = make();
    w.apply(view({ steps: steps(3) }));
    w.fail("连不上守护进程");
    expect(w.render(80).at(-2)).toBe("│ Esc 关闭");
    expect(w.handleInput(UP)).toBe(false);
  });

  test("往上翻时\"下面还有\"只数真实步骤，不把思考中算进去", () => {
    const w = make();
    w.resize(80, 14);
    w.apply(view({ steps: steps(30) }));
    for (let i = 0; i < 3; i++) w.handleInput(UP);
    const area = stepArea(w);
    const top = Number(/↑ 上面还有 (\d+) 步/.exec(area[0]!)?.[1] ?? 0);
    const bottom = Number(/↓ 下面还有 (\d+) 步/.exec(area.at(-1)!)?.[1] ?? 0);
    const shown = area.filter((line) => /步骤 \d+/.test(line)).length;
    expect(top + shown + bottom).toBe(30);
  });

  test("颜色：边框用 border，读取中灰色，只给转圈上色，思考中和出错说明用 muted", () => {
    const w = new StepWindow({ title: "标题", now: () => 0, onClose: () => {}, theme: tag });
    expect(w.render(200)[2]).toContain("<dim>读取中…</dim>");
    w.apply(view({ steps: steps(1) }));
    const lines = w.render(200);
    expect(lines[0]!.startsWith("<border>╭")).toBe(true);
    expect(lines[1]!.startsWith("<border>│</border> ")).toBe(true);
    expect(lines[2]).toContain(`<accent>${SPIN[0]}</accent> 运行中 · 共 1 步`);
    expect(lines.join("\n")).toContain("<muted>思考中</muted>");
    w.fail("连不上守护进程");
    expect(w.render(200).join("\n")).toContain("<muted>守护进程重启后，之前的步骤就没有了。</muted>");
  });
});

describe("openStepWindow：结束后停掉定时器", () => {
  test("返回 completed 后不再要求重画", async () => {
    const timeSource = createFakeTimeSource();
    const clock = createClock({ timeSource });
    const requestRender = vi.fn();
    let component: { handleInput(d: string): void } | undefined;
    const ctx = { ui: { custom: (factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (r: unknown) => void) => unknown) =>
      new Promise((resolve) => { component = factory({ requestRender }, {}, {}, resolve) as typeof component; }) } };
    const promise = openStepWindow({ ctx, dock: { markPageOpen: () => {}, markPageClosed: () => {} }, clock,
      client: { call: async () => view({ state: "completed", steps: steps(2) }) as unknown as Record<string, unknown> }, runId: "run-1", title: "标题" });
    await flush();
    const after = requestRender.mock.calls.length;
    timeSource.advance(5000);
    await flush();
    expect(requestRender).toHaveBeenCalledTimes(after);
    component!.handleInput(ESC);
    await promise;
    clock.stopGapWatcher();
  });
});

describe("步骤窗口：来自模型的文字去掉双向文字控制符和零宽字符", () => {
  const BIDI = "‮", ZW = "​";
  const open = () => new StepWindow({ title: `导出${BIDI}页${ZW}（第 1 版）· prototype`, now: () => 0, onClose: () => {} });

  test("标题、失败原因、步骤文字都去掉这些字符", () => {
    const w = open();
    w.apply(view({ state: "failed", reason: `模型${BIDI}请求${ZW}失败`, steps: [{ id: "a", text: `读 src/${BIDI}a${ZW}.ts`, status: "done" }] }));
    const text = w.render(200).join("\n");
    expect(text).toContain("导出页（第 1 版）· prototype");
    expect(text).toContain("✗ 失败：模型请求失败");
    expect(text).toContain("✓ 读 src/a.ts");
    expect(text).not.toMatch(/[‮​]/);
  });

  test("读不到步骤的原因也去掉这些字符", () => {
    const w = open();
    w.fail(`连不上${BIDI}守护进程${ZW}`);
    const text = w.render(200).join("\n");
    expect(text).toContain("✗ 读不到步骤：连不上守护进程");
    expect(text).not.toMatch(/[‮​]/);
  });
});
